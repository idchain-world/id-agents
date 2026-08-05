#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Commit 16 container gate. Two ID Agents nodes, each with its own durable
# database, on one private Docker network. No compose: a bridge network and two
# `docker run` invocations, which is all the gate needs.
#
# Every assertion below is one the design's commit-16 gate names. Nothing is
# weakened to make it pass; a failure exits non-zero and names the assertion.

set -uo pipefail

NET=idagents-gate-net
IMAGE=idagents-gate:latest
A=idagents-gate-alpha
B=idagents-gate-beta
FED_PORT=4400
MGMT_PORT=4100
PASS=0
FAIL=0

cleanup() {
  docker rm -f "$A" "$B" idagents-gate-wildcard idagents-gate-nolistener idagents-gate-impostor >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm idagents-gate-alpha-data idagents-gate-beta-data >/dev/null 2>&1 || true
}
trap cleanup EXIT

# `docker logs | grep -q` trips pipefail through SIGPIPE, so logs are captured
# first and matched in the shell.
logs_contain() { docker logs "$1" 2>&1 | cat > /tmp/gate-logs.txt; grep -c -- "$2" /tmp/gate-logs.txt | head -1; }
wait_ready() {
  for _ in $(seq 1 40); do
    [ "$(logs_contain "$1" 'ready node=')" != "0" ] && return 0
    sleep 1
  done
  return 1
}

ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n     %s\n' "$1" "${2:-}"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }

# Run a request against a container's own loopback management surface.
mgmt() { # container, method, path, [json]
  local c=$1 method=$2 path=$3 body=${4:-}
  docker exec "$c" node -e "
    const body = ${body:-null};
    fetch('http://127.0.0.1:${MGMT_PORT}${path}', {
      method: '${method}',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(r => r.text()).then(t => process.stdout.write(t))
      .catch(e => { process.stdout.write(JSON.stringify({ error: String(e.message) })); });
  " 2>/dev/null
}

jqf() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=$1;process.stdout.write(v===undefined?'undefined':String(v));}catch(e){process.stdout.write('PARSE_ERROR:'+s.slice(0,200));}})"; }

echo "== building image (linux/arm64 bindings installed inside the image) =="
docker build -q -f tests/docker/Dockerfile -t "$IMAGE" . >/dev/null || { echo "image build failed"; exit 1; }

echo "== private network and two nodes, each with its own durable database =="
cleanup
docker network create --driver bridge "$NET" >/dev/null
docker volume create idagents-gate-alpha-data >/dev/null
docker volume create idagents-gate-beta-data >/dev/null

# Node A: origin. Its federation listener stays disabled; it needs no inbound.
docker run -d --name "$A" --network "$NET" --network-alias alpha \
  -v idagents-gate-alpha-data:/data \
  -e ID_NODE_NAME=alpha -e ID_DB_PATH=/data/alpha.db -e ID_MGMT_PORT=$MGMT_PORT \
  "$IMAGE" >/dev/null

# Node B: destination. It explicitly exposes its federation listener. The
# wildcard is acknowledged because a container's interface address is not
# knowable in advance, which is exactly the case the override exists for.
docker run -d --name "$B" --network "$NET" --network-alias beta \
  -v idagents-gate-beta-data:/data \
  -e ID_NODE_NAME=beta -e ID_DB_PATH=/data/beta.db -e ID_MGMT_PORT=$MGMT_PORT \
  -e ID_FEDERATION_BIND_ADDRESS=0.0.0.0 -e ID_FEDERATION_BIND_PORT=$FED_PORT \
  -e ID_FEDERATION_ALLOW_WILDCARD_BIND=1 \
  "$IMAGE" >/dev/null

wait_ready "$A"; wait_ready "$B"

A_NODE=$(mgmt "$A" GET /whoami | jqf 'j.nodeId')
B_NODE=$(mgmt "$B" GET /whoami | jqf 'j.nodeId')
B_TEAM=$(mgmt "$B" GET /whoami | jqf 'j.teamId')
B_AGENT=$(mgmt "$B" GET /whoami | jqf 'j.agentId')
if [ -n "$A_NODE" ] && [ -n "$B_NODE" ] && [ "$A_NODE" != "$B_NODE" ]; then
  ok "two containers on one private network, distinct durable databases and node IDs"
else
  bad "two containers with distinct node IDs" "A=[$A_NODE] B=[$B_NODE]"
  echo "--- alpha log ---"; docker logs "$A" 2>&1 | tail -20
  echo "--- beta log ---";  docker logs "$B" 2>&1 | tail -20
  exit 1
fi

echo "== management is loopback-only from outside the container =="
FROM_PEER=$(docker exec "$A" node -e "
  fetch('http://beta:${MGMT_PORT}/health', { signal: AbortSignal.timeout(4000) })
    .then(r => process.stdout.write('REACHED_' + r.status))
    .catch(() => process.stdout.write('REFUSED'));
" 2>/dev/null)
check "peer container cannot reach the management API" "$FROM_PEER" "REFUSED"

FED_FROM_PEER=$(docker exec "$A" node -e "
  fetch('http://beta:${FED_PORT}/federation/teams/none/descriptor', { signal: AbortSignal.timeout(4000) })
    .then(r => process.stdout.write('REACHED'))
    .catch(() => process.stdout.write('REFUSED'));
" 2>/dev/null)
check "peer container can reach the federation listener B exposed" "$FED_FROM_PEER" "REACHED"

A_FED=$(docker exec "$B" node -e "
  fetch('http://alpha:${FED_PORT}/federation/teams/none/descriptor', { signal: AbortSignal.timeout(4000) })
    .then(() => process.stdout.write('REACHED'))
    .catch(() => process.stdout.write('REFUSED'));
" 2>/dev/null)
check "A opened no federation listener, so nothing is exposed there" "$A_FED" "REFUSED"

echo "== only A has a route, pinned to B's nodeId =="
ROUTE=$(mgmt "$A" PUT /route "{nodeId:'$B_NODE',baseUrl:'http://beta:$FED_PORT'}" | jqf 'j.route.nodeId')
check "A holds a route pinned to B's node ID" "$ROUTE" "$B_NODE"
mgmt "$A" PUT /contact "{alias:'beta-peer',remoteNodeId:'$B_NODE',remoteTeamId:'$B_TEAM'}" >/dev/null

echo "== a team on A sends to a team on B =="
SEND=$(mgmt "$A" POST /send "{alias:'beta-peer',agentId:'$B_AGENT',body:{ask:'container-work'}}")
CONV=$(printf '%s' "$SEND" | jqf 'j.conversationId')
MSG=$(printf '%s' "$SEND" | jqf 'j.messageId')
check "send crossed the container boundary" "$(printf '%s' "$SEND" | jqf 'j.ok')" "true"

mgmt "$B" POST /scan '{}' >/dev/null
COUNT=$(mgmt "$B" GET "/count-messages?messageId=$MSG" | jqf 'j.count')
check "B holds exactly one message for that ID" "$COUNT" "1"

mgmt "$B" POST /complete "{messageId:'$MSG',result:{answer:'from-container-b'}}" >/dev/null

echo "== A repeatedly collects B's durable result, non-consuming =="
R1=$(mgmt "$A" GET "/collect?conversationId=$CONV&messageId=$MSG" | jqf 'j.value.result.answer')
R2=$(mgmt "$A" GET "/collect?conversationId=$CONV&messageId=$MSG" | jqf 'j.value.result.answer')
R3=$(mgmt "$A" GET "/collect?conversationId=$CONV&messageId=$MSG" | jqf 'j.value.state')
check "first collection returns B's durable result" "$R1" "from-container-b"
check "repeated collection returns the same result, non-consuming" "$R2" "from-container-b"
check "repeated collection still reports completed" "$R3" "completed"

echo "== lost acceptance response, then identical resubmission =="
LOST=$(mgmt "$A" POST /send "{alias:'beta-peer',agentId:'$B_AGENT',body:{ask:'lost-response'},dropResponse:true}")
check "a dropped acceptance response is not reported as success" "$(printf '%s' "$LOST" | jqf 'j.ok')" "false"
REPLAY=$(mgmt "$A" POST /resubmit-unknown '{}')
LOST_MSG=$(printf '%s' "$REPLAY" | jqf 'j.messageId')
check "identical resubmission is deduplicated" "$(printf '%s' "$REPLAY" | jqf 'j.result.outcome.kind')" "deduplicated"
LOST_COUNT=$(mgmt "$B" GET "/count-messages?messageId=$LOST_MSG" | jqf 'j.count')
check "B still holds exactly one message after the resubmission" "$LOST_COUNT" "1"

echo "== destination restart =="
docker restart "$B" >/dev/null
wait_ready "$B"
B_NODE_AFTER=$(mgmt "$B" GET /whoami | jqf 'j.nodeId')
check "B keeps its node identity across a restart" "$B_NODE_AFTER" "$B_NODE"
AFTER=$(mgmt "$A" GET "/collect?conversationId=$CONV&messageId=$MSG" | jqf 'j.value.result.answer')
check "the result survives a destination restart and is still collectable" "$AFTER" "from-container-b"

echo "== a route aimed at the wrong node fails closed =="
# A third node that really answers, with its own identity. Aiming B's route at
# it is the substituted-peer case: reachable, responsive, wrong node.
docker run -d --name idagents-gate-impostor --network "$NET" --network-alias impostor \
  -e ID_NODE_NAME=impostor -e ID_DB_PATH=/tmp/i.db -e ID_MGMT_PORT=$MGMT_PORT \
  -e ID_FEDERATION_BIND_ADDRESS=0.0.0.0 -e ID_FEDERATION_BIND_PORT=$FED_PORT \
  -e ID_FEDERATION_ALLOW_WILDCARD_BIND=1 "$IMAGE" >/dev/null
wait_ready idagents-gate-impostor
IMPOSTOR_NODE=$(mgmt idagents-gate-impostor GET /whoami | jqf 'j.nodeId')
[ "$IMPOSTOR_NODE" != "$B_NODE" ] && ok "the substituted node has its own distinct identity" \
  || bad "substituted node identity" "impostor=[$IMPOSTOR_NODE] beta=[$B_NODE]"
mgmt "$A" PUT /route "{nodeId:'$B_NODE',baseUrl:'http://impostor:$FED_PORT'}" >/dev/null
MISMATCH=$(mgmt "$A" POST /send "{alias:'beta-peer',body:{ask:'substituted'}}" | jqf 'j.code')
check "a route aimed at the wrong node returns peer_node_mismatch" "$MISMATCH" "peer_node_mismatch"
mgmt "$A" PUT /route "{nodeId:'$B_NODE',baseUrl:'http://beta:$FED_PORT'}" >/dev/null

echo "== B's outbound-network spy =="
B_OUT=$(mgmt "$B" GET /outbound-attempts | jqf 'j.count')
check "B opened zero outbound connections" "$B_OUT" "0"

echo "== startup refusals =="
docker run --rm --name idagents-gate-wildcard --network "$NET" \
  -e ID_NODE_NAME=wildcard -e ID_DB_PATH=/tmp/w.db \
  -e ID_FEDERATION_BIND_ADDRESS=0.0.0.0 -e ID_FEDERATION_BIND_PORT=4400 \
  "$IMAGE" >/tmp/gate-wildcard.log 2>&1
if [ "$(grep -c 'peer_route_invalid' /tmp/gate-wildcard.log | head -1)" != "0" ]; then
  ok "wildcard bind refuses at startup without the explicit override"
else
  bad "wildcard bind refuses at startup without the override" "$(tail -3 /tmp/gate-wildcard.log)"
fi

docker run -d --name idagents-gate-nolistener --network "$NET" --network-alias nolistener \
  -e ID_NODE_NAME=nolistener -e ID_DB_PATH=/tmp/n.db "$IMAGE" >/dev/null
wait_ready idagents-gate-nolistener
NO_LISTENER=$(docker exec "$A" node -e "
  fetch('http://nolistener:${FED_PORT}/federation/teams/x/descriptor', { signal: AbortSignal.timeout(4000) })
    .then(() => process.stdout.write('REACHED')).catch(() => process.stdout.write('REFUSED'));
" 2>/dev/null)
check "listener absence exposes nothing" "$NO_LISTENER" "REFUSED"
if [ "$(logs_contain idagents-gate-nolistener 'federation listener disabled')" != "0" ]; then
  ok "a node with no federation bind reports the listener disabled"
else
  bad "disabled listener is reported" "$(docker logs idagents-gate-nolistener 2>&1 | tail -3)"
fi

printf '\n== container gate: %d passed, %d failed ==\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
