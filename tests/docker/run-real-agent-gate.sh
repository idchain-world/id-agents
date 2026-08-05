#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# The real end-to-end cross-node test. Two containers, each running the
# production manager entry `dist/start-agent-manager.js` with its own durable
# database and its own real claude-code-cli agent. A team on node A asks a
# question, node B's agent actually answers it through the production dispatch
# path, and A collects that answer.
#
# The transport gate in run-container-gate.sh stubs the processor and completes
# jobs through a control endpoint. Nothing here does: no stub dispatch function
# exists in this image, and the answer is asserted to be the agent's own output.
#
# The Claude token is read from the host at run time and passed only to
# `docker run`. It is never echoed, logged, or written into an image layer.

set -uo pipefail

NET=idagents-real-net
IMAGE=idagents-real:latest
A=idagents-real-alpha
B=idagents-real-beta
FED_PORT=4400
MGMT_PORT=4100
QUESTION='A team on another ID Agents node is asking you a question. What is the capital of France? Reply with exactly one word.'
PASS=0
FAIL=0
ANSWER=''

cleanup() {
  docker rm -f "$A" "$B" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm idagents-real-alpha-data idagents-real-beta-data >/dev/null 2>&1 || true
}
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n     %s\n' "$1" "${2:-}"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }
contains(){ case "$2" in *"$3"*) ok "$1";; *) bad "$1" "[$2] does not contain [$3]";; esac; }

logs_contain() { docker logs "$1" 2>&1 | cat > /tmp/real-logs.txt; grep -c -- "$2" /tmp/real-logs.txt | head -1; }
wait_for() { # container, needle, seconds
  for _ in $(seq 1 "$3"); do
    [ "$(logs_contain "$1" "$2")" != "0" ] && return 0
    sleep 1
  done
  return 1
}

# Drive a container's own loopback management API, as an operator would. The
# request body travels as an environment variable rather than interpolated into
# the inline script, so quotes and punctuation in a real question survive.
mgmt_team() { # container, team, method, path, [json body], [agent id]
  docker exec -e GATE_BODY="${5:-}" -e GATE_AGENT="${6:-}" "$1" node -e "
    const raw = process.env.GATE_BODY;
    const body = raw ? JSON.parse(raw) : null;
    fetch('http://127.0.0.1:${MGMT_PORT}$4', {
      method: '$3',
      // An agent principal and an admin principal are different callers. The
      // manager resolves admin first, so sending both would make an agent's
      // request look like an operator's and drop its sender attribution.
      headers: Object.assign({ 'X-Id-Team': '$2' },
        process.env.GATE_AGENT
          ? { 'X-Id-Agent': process.env.GATE_AGENT }
          : { 'X-Id-Admin': '1' },
        body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(r => r.text()).then(t => process.stdout.write(t))
      .catch(e => process.stdout.write(JSON.stringify({ error: String(e.message) })));
  " 2>/dev/null
}

jqf() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=$1;process.stdout.write(v===undefined||v===null?'':String(v));}catch(e){process.stdout.write('PARSE_ERROR:'+s.slice(0,200));}})"; }

TOKEN=$(grep -oE 'sk-ant-oat[0-9]+-[A-Za-z0-9_-]+' "$HOME/.claude-container-token" 2>/dev/null | head -1)
if [ -z "$TOKEN" ]; then echo "no Claude token available on this host"; exit 1; fi

echo "== building the real-manager image =="
docker build -q -f tests/docker/Dockerfile.real -t "$IMAGE" . >/dev/null || { echo "image build failed"; exit 1; }

# The image must contain the production manager and no stub harness.
if docker run --rm --entrypoint sh "$IMAGE" -c 'test -f /app/dist/start-agent-manager.js && ! test -f /app/node-entry.mjs' >/dev/null 2>&1; then
  ok "the image runs the production manager entry and contains no stub harness"
else
  bad "image contains the production manager entry only" "start-agent-manager.js missing or node-entry.mjs present"
fi

echo "== two nodes, each with its own durable database =="
cleanup
docker network create --driver bridge "$NET" >/dev/null
docker volume create idagents-real-alpha-data >/dev/null
docker volume create idagents-real-beta-data >/dev/null

# The default database path is used deliberately so the manager and the agents
# it spawns share one database, exactly as they do in production. Inside the
# container that path is a fresh named volume, never the host's live fleet.
docker run -d --name "$A" --network "$NET" --network-alias alpha \
  -v idagents-real-alpha-data:/home/node/.id-agents \
  -e CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" \
  -e AGENT_MANAGER_PORT=$MGMT_PORT "$IMAGE" >/dev/null

docker run -d --name "$B" --network "$NET" --network-alias beta \
  -v idagents-real-beta-data:/home/node/.id-agents \
  -e CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" \
  -e AGENT_MANAGER_PORT=$MGMT_PORT \
  -e ID_FEDERATION_BIND_ADDRESS=0.0.0.0 -e ID_FEDERATION_BIND_PORT=$FED_PORT \
  -e ID_FEDERATION_ALLOW_WILDCARD_BIND=1 "$IMAGE" >/dev/null

wait_for "$A" 'Manager agent ready' 90 || { echo "alpha never became ready"; docker logs "$A" 2>&1 | tail -20; exit 1; }
wait_for "$B" 'Manager agent ready' 90 || { echo "beta never became ready"; docker logs "$B" 2>&1 | tail -20; exit 1; }
ok "both containers run the production manager to readiness"

A_NODE=$(docker exec "$A" node -e "
  const {SqliteAdapter}=require('/app/dist/db/sqlite-adapter.js');
  const db=new SqliteAdapter(process.env.HOME+'/.id-agents/id-agents.db');
  db.query('SELECT node_id FROM manager_identity').then(r=>process.stdout.write(r.rows[0].node_id));" 2>/dev/null)
B_NODE=$(docker exec "$B" node -e "
  const {SqliteAdapter}=require('/app/dist/db/sqlite-adapter.js');
  const db=new SqliteAdapter(process.env.HOME+'/.id-agents/id-agents.db');
  db.query('SELECT node_id FROM manager_identity').then(r=>process.stdout.write(r.rows[0].node_id));" 2>/dev/null)
if [ -n "$A_NODE" ] && [ -n "$B_NODE" ] && [ "$A_NODE" != "$B_NODE" ]; then
  ok "the two nodes have distinct intrinsic node identities"
else
  bad "distinct node identities" "A=[$A_NODE] B=[$B_NODE]"; exit 1
fi

echo "== a real claude-code-cli agent on each node =="
SPAWN_B=$(mgmt_team "$B" beta-team POST /agents/spawn '{"name":"answerer","runtime":"claude-code-cli","local":true}')
B_AGENT=$(printf '%s' "$SPAWN_B" | jqf 'j.id')
check "node B spawned a claude-code-cli agent" "$(printf '%s' "$SPAWN_B" | jqf 'j.runtime')" "claude-code-cli"

SPAWN_A=$(mgmt_team "$A" alpha-team POST /agents/spawn '{"name":"asker","runtime":"claude-code-cli","local":true}')
A_AGENT=$(printf '%s' "$SPAWN_A" | jqf 'j.id')
check "node A spawned a claude-code-cli agent" "$(printf '%s' "$SPAWN_A" | jqf 'j.runtime')" "claude-code-cli"

# `POST /agents/spawn` registers a local agent; the production launcher that
# actually starts its process is the `/agents rebuild` remote command, the same
# path an operator uses. Nothing bespoke starts the agent here.
mgmt_team "$B" beta-team POST /remote '{"command":"/agents rebuild --confirm"}' >/dev/null
mgmt_team "$A" alpha-team POST /remote '{"command":"/agents rebuild --confirm"}' >/dev/null

READY=no
for _ in $(seq 1 90); do
  H=$(docker exec "$B" node -e "
    fetch('http://127.0.0.1:4101/health',{signal:AbortSignal.timeout(3000)})
      .then(r=>process.stdout.write('UP')).catch(()=>process.stdout.write('DOWN'));" 2>/dev/null)
  [ "$H" = "UP" ] && { READY=yes; break; }
  sleep 2
done
check "node B's agent is a live process serving its own REST-AP" "$READY" "yes"
PROCS=$(docker exec "$B" sh -c "ps ax | grep -c '[l]ocal-agent-server'" 2>/dev/null)
if [ "${PROCS:-0}" -ge 1 ]; then
  ok "node B runs the production local-agent-server process for its agent"
else
  bad "agent runs as its own process" "found $PROCS local-agent-server processes"
fi

echo "== operator configuration on the receiving side =="
mgmt_team "$B" beta-team PUT /inter-team/config/policy '{"policy":"open"}' >/dev/null
LEAD_BODY=$(node -e 'process.stdout.write(JSON.stringify({agentId:process.argv[1]}))' "$B_AGENT")
LEAD=$(mgmt_team "$B" beta-team PUT /inter-team/config/lead "$LEAD_BODY")
check "node B assigned its real agent as team lead" "$(printf '%s' "$LEAD" | jqf 'j.settings.leadAgentId')" "$B_AGENT"
check "node B's inbound policy is open" "$(mgmt_team "$B" beta-team GET /inter-team/config | jqf 'j.settings.inboundPolicy')" "open"

B_TEAM=$(mgmt_team "$B" beta-team GET /inter-team/config | jqf 'j.settings.teamId')
echo "== node A points at node B =="
ROUTE_BODY=$(node -e 'process.stdout.write(JSON.stringify({baseUrl:process.argv[1]}))' "http://beta:$FED_PORT")
ROUTE=$(mgmt_team "$A" alpha-team PUT "/inter-team/config/peer-routes/$B_NODE" "$ROUTE_BODY")
check "node A holds one peer route pinned to node B" "$(printf '%s' "$ROUTE" | jqf 'j.route.nodeId')" "$B_NODE"
CONTACT_BODY=$(node -e 'process.stdout.write(JSON.stringify({aliasDisplay:"beta",remoteNodeId:process.argv[1],remoteTeamId:process.argv[2]}))' "$B_NODE" "$B_TEAM")
CONTACT=$(mgmt_team "$A" alpha-team POST /inter-team/config/contacts "$CONTACT_BODY")
check "node A's team owns a contact pinned to B's team" "$(printf '%s' "$CONTACT" | jqf 'j.contact.remoteTeamId')" "$B_TEAM"

echo "== the real question crosses the node boundary =="
SEND_BODY=$(node -e 'process.stdout.write(JSON.stringify({address:"team:beta",body:process.argv[1]}))' "$QUESTION")
SEND=$(mgmt_team "$A" alpha-team POST /inter-team/send "$SEND_BODY" "$A_AGENT")
printf 'SEND_RESPONSE: %s\n' "$(printf '%s' "$SEND" | head -c 300)"
CONV=$(printf '%s' "$SEND" | jqf 'j.conversationId')
MSG=$(printf '%s' "$SEND" | jqf 'j.messageId')
check "node A accepted the send for delivery" "$(printf '%s' "$SEND" | jqf 'j.state')" "accepted"
[ -n "$CONV" ] && ok "the conversation was allocated on node A" || bad "conversation allocated" "$SEND"

echo "== node B's agent answers, and node A collects it =="
STATE=""
for _ in $(seq 1 120); do
  COLLECTED=$(mgmt_team "$A" alpha-team GET "/inter-team/conversations/$CONV/messages/$MSG")
  STATE=$(printf '%s' "$COLLECTED" | jqf 'j.state')
  [ "$STATE" = "completed" ] && break
  [ "$STATE" = "failed" ] && break
  sleep 3
done
if [ "$STATE" != "completed" ]; then
  echo "--- diagnosis: node B job state ---"
  docker exec "$B" node -e "
    const {SqliteAdapter}=require('/app/dist/db/sqlite-adapter.js');
    const db=new SqliteAdapter(process.env.HOME+'/.id-agents/id-agents.db');
    (async () => {
      const q = await db.query('SELECT query_id,status,error,substr(result,1,200) AS r FROM queries ORDER BY created DESC LIMIT 3');
      const m = await db.query('SELECT message_id,status,failure_code FROM interteam_messages');
      process.stdout.write(JSON.stringify({queries:q.rows, messages:m.rows}, null, 1));
    })();" 2>/dev/null | head -30
  docker exec "$B" sh -c 'tail -12 /tmp/answerer.log' 2>/dev/null | head -14
fi
check "node A collected a completed result from node B" "$STATE" "completed"
ANSWER=$(printf '%s' "$COLLECTED" | jqf 'typeof j.result === "string" ? j.result : JSON.stringify(j.result)')
printf 'ANSWER_FROM_REMOTE_AGENT: %s\n' "$ANSWER"
contains "the remote agent answered the question correctly" "$ANSWER" "Paris"

# Repeated collection is non-consuming, over the real path.
AGAIN=$(mgmt_team "$A" alpha-team GET "/inter-team/conversations/$CONV/messages/$MSG" | jqf 'j.state')
check "repeated collection is non-consuming" "$AGAIN" "completed"

echo "== the answer came from the agent, not from a test endpoint =="
# The durable job on B must be owned by the spawned agent and hold its output.
JOB=$(docker exec "$B" node -e "
  const {SqliteAdapter}=require('/app/dist/db/sqlite-adapter.js');
  const db=new SqliteAdapter(process.env.HOME+'/.id-agents/id-agents.db');
  (async () => {
    const link = await db.query(\"SELECT p.local_query_id, p.handler_agent_id FROM interteam_processing p JOIN interteam_messages m ON m.id = p.message_pk WHERE m.message_id = ?\", ['$MSG']);
    if (!link.rows[0]) return process.stdout.write(JSON.stringify({error:'no_link'}));
    const q = await db.query('SELECT agent_id, status, prompt, result FROM queries WHERE query_id = ?', [link.rows[0].local_query_id]);
    process.stdout.write(JSON.stringify({ handler: link.rows[0].handler_agent_id, row: q.rows[0] || null }));
  })();" 2>/dev/null)
check "the durable job was handled by the spawned agent" "$(printf '%s' "$JOB" | jqf 'j.handler')" "$B_AGENT"
check "the job row is owned by that agent" "$(printf '%s' "$JOB" | jqf 'j.row && j.row.agent_id')" "$B_AGENT"
check "the job completed in B's database" "$(printf '%s' "$JOB" | jqf 'j.row && j.row.status')" "completed"
PROMPT=$(printf '%s' "$JOB" | jqf 'j.row && j.row.prompt')
contains "the agent's prompt carried the production unverified-sender frame" "$PROMPT" "unverified]"
contains "the frame names the sending agent on node A" "$PROMPT" "asker"
contains "the agent's prompt carried the question A actually sent" "$PROMPT" "capital of France"

# The stub dispatch used by the transport gate cannot be present here.
if [ "$(docker run --rm --entrypoint sh "$IMAGE" -c "grep -rl 'dispatchFn' /app/dist/agent-manager-db.js 2>/dev/null | head -1")" != "" ]; then
  ok "the manager image wires the production dispatch function"
else
  bad "production dispatch wiring present" "no dispatchFn reference in the shipped manager"
fi

printf '\n== real agent gate: %d passed, %d failed ==\n' "$PASS" "$FAIL"
printf 'QUESTION: %s\n' "$QUESTION"
printf 'ANSWER: %s\n' "$ANSWER"
[ "$FAIL" -eq 0 ]
