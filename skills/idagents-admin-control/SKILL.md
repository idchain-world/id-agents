---
name: idagents-admin-control
description: Programmatically manage an ID Agents team — add/remove agents, export/import team configs, rebuild and restart the manager, dispatch work to agents and poll replies. Use whenever you edit a team YAML, hit "Manager did not start in time", need to /export, /import, /diff, /deploy, or /agents rebuild a team, or want to talk to or ask an agent.
source_kind: local-authored
source: id-agents (this repo)
license: MIT
modified_locally: false
---

# ID Agents Admin Control Skill

## Overview

This skill enables Claude Code to act as an **admin agent** for the ID Agents manager. It provides:

1. **Temporary listener** — Receives replies from the manager (like a regular agent)
2. **Chat with manager** — Send messages via daemon `/talk` into the manager inbox
3. **Remote commands** — Execute CLI commands via `POST /remote` on the manager daemon (`:4100`)

## When you want to ...

| Goal | Command | Notes |
|---|---|---|
| Add a new agent | `id-agents spawn <name> [model]`, or `POST /agents/spawn` | The database is the source of truth — editing YAML does NOT add an agent. `/agents rebuild` will not pick it up either. There is no `/agents spawn`. |
| Change a model | `/model <agent> <model>` | Surgical commands only. `/sync` is REMOVED: a config file may no longer overwrite the database. |
| Remove an agent | `/delete <agent>` | Hard-deletes the row and stops the process. |
| Restart agents (no config change) | `/agents rebuild` | restarts existing agents from DB |
| Start clean from YAML | `/deploy <team>` | nuke and recreate |
| Wipe working dirs too | `/agents reset` | destructive — confirms before running |
| Manager not responding on `:4100`, or CLI says "Manager did not start in time" | see "Restarting the manager" below | self-kill + auto-spawn-race are known modes |

Every `/remote` call should carry `X-Id-Team: <team>` (or set `ID_TEAM` env var). Without it, the manager uses its current default team, which is rarely what scripted callers want.

## Architecture

```
Claude Code (Admin)                  Manager Daemon (:4100)       Human at CLI (optional)
      │                                      │                            │
      │  1. POST /remote ───────────────────▶│                            │
      │     {command:"/ask ecs ..."}          │                            │
      │◀──── 202 {ok,result:{queryId}} ──────│                            │
      │                                      │                            │
      │  2. GET /query/:id?wait=30 ─────────▶│                            │
      │◀──── 200 {status:delivered,result} ──│                            │
      │                                      │                            │
      │  3. POST /talk (optional, human) ───▶│                            │
      │                                      │◀──── reads/replies in CLI ─│
      │◀──── POST /news (reply endpoint) ────│                            │
```

**One manager surface.** `/remote`, `/talk`, `/query/:id`, and `/news` all live on the manager daemon (`:4100`). The interactive CLI is a client of that daemon; it does not expose a manager HTTP surface of its own.

## Restarting the manager

The manager daemon is down whenever any of these happen:

- `curl http://127.0.0.1:4100/agents` refuses the connection.
- `id-agents` (the interactive CLI) prints `Manager did not start in time`. The CLI tries to auto-spawn the daemon, waits for `:4100`, and exits on failure; start it yourself and rerun the CLI.
- A previous `/agent rebuild` killed it. The port-kill logic occasionally catches the manager's own PID.

```bash
# Force-kill any stale CLI / daemon processes first
ps -ef | grep -E "interactive-agent|start-agent-manager" | grep -v grep | awk '{print $2}' | xargs -r kill -9
sleep 2
# Start daemon standalone (no CLI required for dispatch/polling)
cd /Users/nxt3d/projects/id2/id-agents && nohup node dist/start-agent-manager.js > /tmp/id-agents-daemon.log 2>&1 &
```

The standalone daemon reads the same SQLite state, rehydrates the team, and does not need the interactive CLI. Verify:

```bash
until curl -sS --max-time 2 http://127.0.0.1:4100/agents >/dev/null 2>&1; do sleep 2; done; echo "UP"
curl -sS http://127.0.0.1:4100/agents | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['agents']),'agents')"
```

The full launcher (`npm run id-agents`) starts the daemon and opens the interactive CLI prompt — use it when a human is going to type at the prompt. For scripted or Claude-session work you only need the daemon.

## Ports

| Port | What lives there | Use for |
|------|------------------|---------|
| `4050` | Admin reply listener (optional) | **Callback target.** `start-listener.js` or `admin-session.js` can bind here to receive `/news` replies from the manager. |
| `4100` | Manager daemon | **Dispatch and polling.** `POST /remote`, `POST /talk`, `GET /query/:id` (supports `?wait=<sec>` long-poll), `GET /agents`, `POST /talk-to`, public-team admin. |

### IPv6 vs IPv4 gotcha (macOS especially)

On macOS, `localhost` frequently resolves to `::1` (IPv6) first. Our servers bind to `0.0.0.0` / `127.0.0.1` (IPv4), so a `curl localhost:4100` can **silently hit a different process** if some other dev tool (Vite, Next.js, etc.) happens to be listening on `[::1]:4100` in IPv6. Symptom: the JSON you get back has nothing to do with id-agents.

Always use `127.0.0.1` (not `localhost`) in every curl example, or pass `-4` to force IPv4. The snippets below follow this rule.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MANAGER_URL` | `http://127.0.0.1:4100` | Manager daemon base URL. All dispatch (`/remote`) and polling (`/query/:id`) go here. |
| `ID_TEAM` | *(unset)* | Optional team header (`X-Id-Team`) for daemon requests. Default team is used if unset. |
| `ADMIN_LISTENER_PORT` | `4050` | Local listener port when using the reply-listener scripts. |

## Usage

### Start Admin Session

```bash
node skills/idagents-admin-control/admin-session.js
```

Or use individual scripts:

### 1. Start Listener

```bash
node skills/idagents-admin-control/start-listener.js [port]
# Default port: 4050
```

### 2. Talk to the Manager (daemon-owned inbox)

`POST :4100/talk` writes to the manager inbox, which is persisted in the shared DB. The message lands regardless of whether a human is at the REPL. Any reader — the CLI REPL, this skill, a future dashboard — sees the same inbox via `GET :4100/news`. If a human is at the REPL, they can respond; replies come back to your listener at `ADMIN_LISTENER_PORT`.

```bash
./skills/idagents-admin-control/talk-to-manager.sh "What agents are running?" http://127.0.0.1:4050
```

### 3. Execute Remote Command

```bash
./skills/idagents-admin-control/remote-command.sh "/agents"
./skills/idagents-admin-control/remote-command.sh "/deploy idchain"
./skills/idagents-admin-control/remote-command.sh "/ask coder-b Build a REST API"
```

## Waiting for results — pick the right endpoint

After dispatching `/ask <agent>` (or any `/remote` command that returns a `query_id`), you need to wait for the agent's reply. **Do not loop on `/news <agent>` with `grep`.** The daemon has dedicated endpoints that block efficiently on the server and return clean JSON. All snippets below are plain `curl` + `bash` + `jq` so they run identically whether your admin session is Claude Code, Codex, or Cursor (swap `jq` for `python3 -c 'import json,sys; …'` if your shell lacks it).

### One specific query — `GET /query/:id?wait=N` (long-poll)

When you sent a single `/ask <agent>` and want the reply:

```bash
QID=$(./skills/idagents-admin-control/remote-command.sh \
  "/ask coder Implement the X feature" | jq -r '.result.queryId')

# Block up to 30s on the server until terminal state
curl -s -H "X-Id-Team: $ID_TEAM" \
  "$MANAGER_URL/query/$QID?wait=30" | jq
```

`wait` is clamped to `[0, 30]` seconds. Terminal status values: `delivered`, `failed`, `cancelled`, `expired`. The response includes `result.result` (the agent's reply text) when delivered. For queries that may exceed 30s, **chain the call** — each iteration is one TCP connection the server holds open until an event fires:

```bash
while :; do
  resp=$(curl -s -H "X-Id-Team: $ID_TEAM" "$MANAGER_URL/query/$QID?wait=30")
  status=$(echo "$resp" | jq -r '.status')
  case "$status" in
    delivered|failed|cancelled|expired) echo "$resp" | jq; break ;;
  esac
done
```

### Many things at once — `GET /events?since=<seq>` (event-stream cursor)

When you are orchestrating multiple workers, multiple phases, or a long rollout, polling each `query_id` separately is wasteful. The events stream returns every team-scoped state change since a cursor, in one call:

```bash
LAST_SEQ=0
while :; do
  resp=$(curl -s -H "X-Id-Team: $ID_TEAM" \
    "$MANAGER_URL/events?since=$LAST_SEQ&limit=100")
  echo "$resp" | jq '.events[] | {seq, topic, subject, data}'
  LAST_SEQ=$(echo "$resp" | jq -r '.events | last | .seq // empty')
  [ -z "$LAST_SEQ" ] && sleep 30  # nothing new — back off
done
```

Useful topics to filter with `?topics=`:

- `query:received`, `query:delivered`, `query:failed` — agent dispatch lifecycle
- `task:created`, `task:claimed`, `task:done`, `task:removed` — task lifecycle
- `checkin:due` — supervision pings firing on linked tasks
- `agent:online`, `agent:offline` — fleet health

Each event has `seq` (cursor), `team`, `topic`, `actor`, `subject`, and a `data` object whose shape is topic-specific. Save the highest `seq` you handled and pass it as `since` on the next call.

### Decision shortcut

| Use case | Endpoint |
|---|---|
| Wait for ONE specific `query_id` you dispatched | `GET /query/:id?wait=30` |
| Watch state changes across multiple workers/tasks | `GET /events?since=<seq>` |
| Read a specific agent's news feed (debugging) | `/news <agent>` via `/remote` (not for waiting on your own query) |

### Anti-patterns to avoid

- **Don't grep JSON** for state. Key ordering inside JSON objects is implementation-defined; regexes like `outbound.reply.*in_reply_to` will silently miss matches when the serializer reorders fields. Always parse with `jq` or `python3 -c "import json,sys; …"`.
- **Don't burst-poll `/news <agent>` to wait for a reply to your own `/ask`.** `/news` is the agent's inbox stream, not a wait primitive. Use `GET /query/:id?wait=` — purpose-built and simpler.
- **Don't sleep-then-poll** when a wait endpoint exists. Tight burst loops against `localhost` can saturate the macOS ephemeral port range (~16k); the daemon looks down even when it's healthy. `?wait=` and `since=<seq>` solve this with one long-lived connection per check.

## Available Remote Commands

| Command | Description |
|---------|-------------|
| `/agents` | List all agents |
| `/agents rebuild` | Restart existing agents from DB. Does NOT add agents — use `id-agents spawn <name>` or `POST /agents/spawn` (see "Adding an agent to a team"). |
| `/agents probe` | Dispatch-path health probe across every running agent in the team. See "Probe — verify agents respond on `/talk`" below. |
| `/status` | Show team health |
| `/deploy <config> [params]` | Deploy agents from config (e.g. `/deploy idchain`) |
| `/delete <name>` | Delete agent |
| `/ask <agent> <msg>` | Send message to agent (continues session) |
| `/ask * <msg>` | Broadcast to all agents |
| `/hey <agent> <msg>` | Alias for `/ask` |
| `/clear [agent]` | Clear agent session |
| `/agent <name> start\|stop\|rebuild` | Agent lifecycle |
| `/agent <name> probe` | Probe a single named agent's `/talk` dispatch path. See "Probe — verify agents respond on `/talk`" below. |
| `/model <agent> <model>` | Change agent's model |
| `/news [-l] <agent>` | Get agent's news feed (-l for full content) |
| `/team` | Show current team |
| `/teams` | List all teams |
| `/team <name>` | Switch to or create team |
| `/team delete <name>` | Delete a team |
| `/tasks` | List tasks |
| `/task add <title>` | Create task |
| `/task <id> assign\|start\|complete` | Update task |
| `/heartbeat <agent> enable\|disable` | Control heartbeats |
| `/public list` | List registered public-agents |
| `/public add <domain> [--ssh-target=...] [--internal-port=N]` | Register a public-agent |
| `/public remove <name\|domain>` | Deregister a public-agent |
| `/help` | Show help |

### Probe — verify agents respond on `/talk`

`/agents probe` and `/agent <name> probe` both POST a minimal `reply with OK` message to each target agent's local `/talk` endpoint, capture the returned `query_id`, then wait for that query to reach `completed` or `failed` on `/query/:id`. They traverse the same dispatch hop real `/ask` and `/talk-to` traffic uses, so a green probe is direct evidence the agent's HTTP listener is up and the harness can actually complete a dispatch; a red probe pinpoints whether the failure is transport-level (timeout / connection refused) or the deeper spawn-succeeds-but-LLM-fails class (`401: Invalid authentication credentials`, empty result, etc.).

**When to run it.** After every `/deploy`, `/import` or `id-agents spawn` — especially when the manager was started inside another Claude Code session, where the spawn races are easier to hit. Also when an `/ask <agent>` hangs and you want to disambiguate "agent is busy" from "agent's process is wedged" before paging anyone.

**Not wired into any command.** This is operator-driven: reconciliation and health verification are separate jobs, and `/diff` deliberately only reports drift.

**Pass / fail meaning.** A probe passes only when the `/talk` request succeeds and the resulting query reaches `completed` within 10s. A probe fails when `/talk` returns a non-2xx status, when the query reaches `failed` (for example `401: Invalid authentication credentials`), or when the whole end-to-end check times out or hits a network error.

**Fan-out.** Probes run in parallel with concurrency 8 and a 10s per-agent timeout, so probing a 20-agent team finishes in well under a minute regardless of whether a few agents are wedged.

**`/agents probe` skips non-running agents.** `/agent <name> probe` does not skip — if you named the agent explicitly, an offline status surfaces as a `failed` entry rather than being silently dropped.

**Response shape (both commands):**

```json
{
  "ok": true,
  "result": {
    "team": "idchain",
    "probed": 3,
    "passed": 2,
    "failed": 1,
    "results": [
      { "name": "cto", "status": "ok", "duration_ms": 41 },
      { "name": "agents", "status": "ok", "duration_ms": 38 },
      { "name": "jrdev", "status": "failed", "error": "401: Invalid authentication credentials", "duration_ms": 134 }
    ]
  }
}
```

`probed` / `passed` / `failed` are exact counts; `results[]` is one entry per probed agent in dispatch order. Each `failed` entry carries a non-empty `error` string suitable for printing directly to the operator.

```bash
# Probe every running agent in the current team
./skills/idagents-admin-control/remote-command.sh "/agents probe"

# Probe a single named agent
./skills/idagents-admin-control/remote-command.sh "/agent jrdev probe"
```

## Heartbeats (new model — agent reads `HEARTBEAT.md`)

The manager has a built-in scheduler. Putting `heartbeat: <seconds>` on an agent in its team YAML enables the **new** heartbeat model: every `<seconds>` the manager sends the agent a fixed, generic wake message:

> `Heartbeat. Re-read your HEARTBEAT.md from disk before acting (do not rely on session memory) and follow its current algorithm. Reply with the line your HEARTBEAT.md tells you to send.`

The wake message contains **no work instructions**. The agent must read `HEARTBEAT.md` from the **root of its working directory** on every beat and follow what it says. Without a `HEARTBEAT.md` file, a heartbeat fires but is effectively a no-op (or errors on `/heartbeat <agent> enable`). The persona / `description:` field is NOT the wake script — `HEARTBEAT.md` is.

`HEARTBEAT.md` is the algorithm and the source of truth — change behaviour by editing the file, not by redeploying the team. The agent re-reads it from disk every beat.

### Shared working directories are a footgun

`HEARTBEAT.md` is resolved as `<workingDirectory>/HEARTBEAT.md`. If two agents share a working directory (common: a `cto` and a `dev` both rooted at the same repo), they will read the **same** `HEARTBEAT.md` and both try to act on it. Isolate scheduled agents in their own working directory — usually a sibling directory containing only `HEARTBEAT.md` — and have the algorithm operate on the real target repo via absolute paths plus `git -C` / `cd`.

### `/heartbeat <agent>` — inspect schedule state

`POST /remote` with `/heartbeat <agent>` returns the live schedule:

```json
{
  "agent": {
    "name": "systems",
    "intervalSeconds": 1800,
    "scheduleActive": true,
    "runsSent": 3,
    "maxRuns": null,
    "expiresAt": null,
    "status": "running"
  }
}
```

`intervalSeconds` is from the YAML `heartbeat:` value. `runsSent` is the count of beats fired since this schedule started. `maxRuns` is the cap on beats before the schedule auto-pauses; `null` means **no cap** — the schedule keeps beating until you `/heartbeat <agent> disable` or the agent goes away. `scheduleActive` is `true` while the schedule is running and flips `false` when paused or when a non-null `maxRuns` has been hit.

**New-model heartbeats are uncapped by default** — schedules are persisted with `max_runs: null`. If you want a soft safety net, set `maxBeats: N` in a legacy `HEARTBEAT.yaml` (which persists `max_runs: N` at creation), or wire a cap into your custom schedule.

`/heartbeat <agent> enable|disable` toggles the schedule. `enable` errors with `Agent "<name>" has no HEARTBEAT.yaml or HEARTBEAT.md in working directory` if the file is missing — fix that first.

### Recipe — set up a heartbeat-driven loop

1. Pick (or create) a dedicated working directory for the agent. If the agent will operate on another repo, it can do so via absolute paths from this dir.
2. Write `HEARTBEAT.md` at that directory's root. The file IS the algorithm; describe exactly what to read, what to do, how much to do per beat (one item, a batch of N, until a wall-clock budget, etc.), and what one-line reply to send. Tell the agent to re-read `HEARTBEAT.md` from disk every beat (mirroring the manager's wake message).
3. Add the agent to the team YAML with `workingDirectory:` pointing at that dir and `heartbeat: <seconds>`.
4. `id-agents spawn <name> [model]` (or `POST /agents/spawn`) for a live team, or `/deploy <team>` for a NEW one (deploy is create-only).
5. Verify with `/heartbeat <agent>`: `intervalSeconds` set, `scheduleActive: true`. The first beat fires inside the interval.

### Anti-patterns

- **Putting the algorithm only in `description:`** — the wake message will not include it. Use `HEARTBEAT.md` for the algorithm and reserve `description:` for the agent's identity / persona.
- **Letting two agents share a working directory when one of them has a heartbeat** — both will read and act on the same `HEARTBEAT.md`.
- **Treating the heartbeat as a liveness ping** — it isn't, it's a periodic prompt that triggers real work via the file.
- **Misreading `maxRuns`** — `null` is the default for new-model heartbeats and means **no cap**, not "use a default of 20." If you actually want a cap, set `maxBeats` in a legacy `HEARTBEAT.yaml`, or set `max_runs` on a custom schedule. The cap only fires when the persisted value is non-null.

## Public-Team Admin (direct daemon endpoints)

`/remote` is the primary dispatch surface, but public-team registration can also be driven through dedicated daemon endpoints when you want to skip command-string parsing.

Public-agent identity is manager-join only: `POST /agents/register` puts the agent on the manager's roster, and an optional OWS wallet (`wallet: true` in the body, or `/agent <name> wallet provision` later) delivers the agent's wallet address to its VPS.

All public-team requests require two headers:

```
X-Id-Team: public
X-Id-Admin: 1
```

Same authorization rules as `/remote`: **ask before acting** on any write (register/delete).

### Direct endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/agents` | List agents in the current team. |
| `POST` | `/agents/register` | Upsert a public-agent. Body: `{name, runtime:"public-agent-remote", customer_domain, public_endpoint_url, ssh_target?, internal_endpoint_url?, wallet?}`. `wallet: true` provisions an OWS wallet at join. |
| `DELETE` | `/agents/:id` | Deregister by id (resolve name→id first via `/agents`). |

### Reserved names

Certain agent names collide with CLI commands or daemon-owned identities and are rejected by the register endpoint (`{"error":"invalid_name", ...}`). Known reserved: `help`, `agents`, `status`, `team`, `deploy`, `ask`, `hey`, `delete`, `public`, `manager`. If you need one of these as a logical identifier, suffix it (`help-idagents`, `status-probe`, etc).

## Agent Library & Team Configuration

The v3 agent-config system separates **persona templates** (the library) from **team membership** (team YAMLs). A team YAML with a library reference creates those agents on `/deploy` of a NEW team, or on `/import`. To add one to a LIVE team, use `POST /agents/spawn` with `{"name": "<name>", "agent": "<library-entry>"}` — the HTTP route accepts the library overlay, the `id-agents spawn` CLI does not.

### Listing library entries

The library lives at the path the manager exposes as `libraryRoot` (typically `id2/public-agents/configs/agents/` or `id2/id-agents/configs/agents/`). Each subdirectory is one persona template.

```bash
MGR="${MANAGER_URL:-http://127.0.0.1:4100}"
curl -sS "$MGR/library/agents" | jq '.entries[].name'
# → "copywriter", "devops", "editor", "foundry-dev", "frontend",
#    "frontend-react", "fullstack-nextjs", "security", "solidity-security"
```

The response also includes `libraryRoot`, each entry's `shape` (`claude-native` or `agents-md-native`), and `source_path`. Filesystem fallback when the daemon is down:

```bash
ls "$(jq -r '.libraryRoot' <<<"$(curl -sS $MGR/library/agents)")/agents"
```

### Adding an agent to a team

1. **Edit the team YAML** under `id-agents/configs/<team>.yaml`. Add an entry under `agents:`.

   **Default case — inherit `runtime` and `model` from the team `defaults:` block.** Most agents look like this:

   ```yaml
   agents:
     - name: copy
       description: "Marketing copy for landing pages"
       workingDirectory: /Users/nxt3d/projects/id-agents-app
       agent: copywriter        # library entry name (optional)
   ```

   **Override case — only when this agent genuinely needs a different runtime or model than the rest of the team.** Don't invent model strings; copy `runtime` and `model` from another agent already in the team, or from `defaults:`. Source of truth is `configs/<team>.yaml` and `GET /agents`, not this doc.

   ```yaml
   - name: jrdev
     description: "Cheaper general-purpose helper"
     runtime: cursor-cli
     model: composer-2
     workingDirectory: /Users/nxt3d/projects/id2/id-agents
   ```

   The `agent:` field pulls the persona (CLAUDE.md / AGENTS.md + bundled skills) from `configs/agents/<name>/` at create time (deploy, import or spawn). Omit `agent:` for a bare persona where you write the prompt inline via `description:` only. `skills:` on an agent entry is additive on top of the library entry's skills.

2. **Refresh working-directory artifacts.** This rebuilds them (CLAUDE.md sidecar for Claude, marker-fenced AGENTS.md append for Codex/Cursor) for every agent whose template-derived hash changed:

   ```bash
   MGR="${MANAGER_URL:-http://127.0.0.1:4100}"
   curl -sS -X POST "$MGR/remote" \
     -H "Content-Type: application/json" \
     ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"} \
     -d '{"command":"/diff <team> <config>"}' | jq '.result.queryId'
   # then poll `/query/$QID?wait=30` per the standard pattern below
   ```

3. **Verify** the new agent is in the team and picked up the persona:

   ```bash
   curl -sS "$MGR/agents" ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"} \
     | jq '.agents[] | select(.name=="copy") | {name,runtime,workingDirectory,agent}'
   ```

   And eyeball the whole team in one pass — useful after every `/deploy`, `/import`, `id-agents spawn` or `/agents rebuild`:

   ```bash
   curl -sS "$MGR/agents" ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"} \
     | python3 -c "import json,sys; d=json.load(sys.stdin); [print(f'{a[\"name\"]:18s} :{a[\"port\"]:<5} {a[\"status\"]:10s} {a[\"runtime\"]:18s} {a[\"model\"]}') for a in d['agents']]"
   ```

   The agent's working directory should now contain the synced persona file. For Claude runtimes, look for `<wd>/.claude/rules/<agent-name>.md`; for Codex/Cursor, look for the marker-fenced block in `<wd>/AGENTS.md`.

### Removing or changing the library reference

`/sync` is REMOVED (D2), so editing the `agent:` field no longer re-overlays a live agent's artifacts: a config file may not overwrite the database. Remove and re-spawn the agent, or edit its working directory directly. The receipt-driven SHA ownership rule still applies to the separate `id-agents sync <config>` WORKSPACE CLI, which is a different command and is not removed.

### Anti-patterns

**Do not edit `configs/agents/<name>/CLAUDE.md` to customize one team's agent.** That file is the shared library entry — changes there propagate to every team using it. Override per-team via the YAML's `description:` and `skills:` fields, or fork the library entry under a new name.

**Editing a team YAML no longer changes a live team.** The database is the source of truth (D3) and `/sync` is REMOVED, so the manager never rehydrates a running team from disk. Change live agents with `id-agents spawn <name>` (or `POST /agents/spawn`), `/delete <agent>` and `/model <agent> <model>`; use `/diff <team> <config>` to see how a config and the live team differ, and `/export` to write the database back out to YAML.

## Polling for Agent Replies

After dispatching work via `POST /remote`, poll `GET /query/<id>?wait=<seconds>` for the reply. Long-poll (`?wait=30`) is supported and strongly preferred — the daemon holds the connection open and returns as soon as the status transitions, or at the timeout, whichever comes first.

A query moves through one of these statuses:

| Status | Meaning |
|--------|---------|
| `pending` | Accepted, not yet picked up by the agent |
| `processing` | Agent is working on it |
| `delivered` | Agent replied — `result` contains the message |
| `failed` | Agent errored — `error` contains the message |
| `expired` | Stuck in pending/processing past the sweeper cutoff (15 min) |

Only `delivered`, `failed`, and `expired` are terminal.

### Response shape from `POST /remote`

The daemon returns:

```json
{
  "ok": true,
  "result": {
    "queryId": "query_1776400000000_ab1cd",
    "status": "pending",
    "agent": "coder-b"
  }
}
```

Extract `queryId` directly from `.result.queryId` — no regex parsing required.

### Single Agent

**Dispatch + long-poll.** One-shot, no sleep loop needed for short tasks.

```bash
MGR="${MANAGER_URL:-http://127.0.0.1:4100}"
QID=$(curl -s -X POST "$MGR/remote" \
  ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"} \
  -H "Content-Type: application/json" \
  -d '{"command":"/ask <agent> <task>"}' \
  | jq -r '.result.queryId')
echo "queryId=$QID"

# Long-poll 30s; returns immediately on terminal status.
curl -s "$MGR/query/$QID?wait=30" ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"}
```

**Background long-polling loop** (for tasks that may exceed a single wait window). Run with `run_in_background: true` (Claude Code Bash tool) so the conversation continues.

```bash
MGR="${MANAGER_URL:-http://127.0.0.1:4100}"
# Up to 15 min total — each call holds the socket for up to 30s.
# NB1: `qstatus` not `status` — zsh makes `$status` read-only (mirrors $?).
# NB2: pipe with `printf '%s' "$body"`, never `echo "$body"`. zsh and BSD echo
#      interpret backslash escapes, so `\n` inside JSON string values gets
#      converted to literal newlines and jq rejects the body as invalid JSON.
for i in $(seq 1 30); do
  body=$(curl -s "$MGR/query/$QID?wait=30" ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"})
  qstatus=$(printf '%s' "$body" | jq -r '.status // empty')
  case "$qstatus" in
    delivered)
      printf '%s' "$body" | jq -r '.result.result // .result.message // .result'
      break ;;
    failed|expired)
      echo "TERMINAL=$qstatus"
      printf '%s' "$body" | jq -r '.error // .'
      break ;;
  esac
done
```

### Multiple Agents (threshold-based)

**Dispatch.** Fan out and collect queryIds.

```bash
MGR="${MANAGER_URL:-http://127.0.0.1:4100}"
declare -A QIDS
for agent in agent-a agent-b agent-c; do
  qid=$(curl -s -X POST "$MGR/remote" \
    ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"} \
    -H "Content-Type: application/json" \
    -d "{\"command\":\"/ask ${agent} <task>\"}" \
    | jq -r '.result.queryId')
  QIDS[$agent]=$qid
done
```

**Poll with long-poll + threshold.** Wait for 2 of 3 before returning.

```bash
MGR="${MANAGER_URL:-http://127.0.0.1:4100}"
for i in $(seq 1 30); do
  done_count=0
  results=""
  for agent in "${!QIDS[@]}"; do
    body=$(curl -s "$MGR/query/${QIDS[$agent]}?wait=30" ${ID_TEAM:+-H "X-Id-Team: $ID_TEAM"})
    qstatus=$(printf '%s' "$body" | jq -r '.status // empty')
    if [ "$qstatus" = "delivered" ] || [ "$qstatus" = "failed" ] || [ "$qstatus" = "expired" ]; then
      done_count=$((done_count+1))
      msg=$(printf '%s' "$body" | jq -r '(.result.result // .result.message // .error // "")' | head -c 200 | tr '\n' ' ')
      results="${results}${agent} [${qstatus}]: ${msg}\n"
    fi
  done
  [ "$done_count" -ge 2 ] && { echo -e "$results"; break; }
done
```

**Tips:** Use the returned queryId — do not scrape the news feed for replies. Use a threshold rather than waiting for every agent. If an agent is stuck, the sweeper will flip its query to `expired` after 15 minutes.

### Anti-patterns

**Do not target a manager HTTP surface on the interactive CLI.** The manager lives on `:4100` only. Use `:4100/remote` for dispatch and `:4100/talk` for the human inbox.

**Do not combine dispatch and poll into one synchronous foreground block.** It blocks the conversation until the agent replies or the loop times out, makes a tool-rejection ambiguous, and hides the queryId behind a wall of "no reply yet" lines. Dispatch in the foreground, poll in the background.

**Do not poll the news feed to find replies.** `/news` is the agent's inbox stream; reply discovery belongs to `GET /query/<id>`. The news feed does not give you a clear "not yet" vs "expired" vs "failed" distinction.

## Best Practices

1. **Always ask before acting** — Use `/talk` to get approval from the human before destructive commands
2. **Keep sessions short** — Start listener, do work, stop listener
3. **Prefer long-poll** — `?wait=30` beats a 10s sleep loop for latency and load
4. **Check results** — Verify command execution succeeded

## Important Notes

- The listener is only needed when you expect a reply to your `/talk` message.
- Dispatch + poll work without the interactive CLI running at all. The daemon on `:4100` is sufficient.
- Unlike persistent agents, the listener stops when the Claude Code session ends.
