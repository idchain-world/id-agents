# Admin Control Guide

The `idagents-admin-control` skill lets any **Claude Code** session programmatically manage an ID Agents team (the same `/remote` flows work from **OpenAI Codex** or **Cursor CLI** if you adapt skill paths to `.agents/skills/` or `.cursor/skills/`). It provides scripts for sending CLI commands via HTTP, chatting with the manager, and polling for multi-agent replies — all without opening the interactive CLI.

## When to Use

Use idagents-admin-control when you want a Claude Code, Codex, or Cursor coding agent (or any script) to:
- Deploy or delete agents remotely
- Dispatch tasks to agents and collect replies
- Chat with the manager (human-in-the-loop approval flow)
- Run management loops that send recurring work to agents

The manager daemon (`npm run id-agents` or `node dist/start-agent-manager.js`) must be running for any of this to work.

## The `/remote` Endpoint

The manager exposes `POST /remote` on the manager daemon (port 4100 by default). No authentication required — it binds to localhost only.

Send any CLI command as an HTTP request:

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command": "/agents"}'
```

Response:

```json
{
  "ok": true,
  "result": "..."
}
```

### Available Remote Commands

| Command | Description |
|---------|-------------|
| `/agents` | List all agents |
| `/agents rebuild` | Rebuild all agents |
| `/status` | Show team health |
| `/deploy <config>` | Deploy agents from YAML config (clean/first-time) |
| `/diff <team> <config>` | Report drift, read-only. `/sync` is [REMOVED](./sync-command.md) |
| `/deploy local-agent <name>` | Deploy a single local agent |
| `/delete <name>` | Delete agent |
| `/ask <agent> <msg>` | Send message to agent (continues session) |
| `/ask * <msg>` | Broadcast to all agents |
| `/hey <agent> <msg>` | Alias for `/ask` |
| `/clear [agent]` | Clear agent session |
| `/agent <name> start\|stop\|rebuild` | Agent lifecycle |
| `/model <agent> <model>` | Change agent model |
| `/news [-l] <agent>` | Get agent news feed (`-l` for full content) |
| `/team` | Show current team |
| `/teams` | List all teams |
| `/team <name>` | Switch to or create team |
| `/team delete <name>` | Delete a team |
| `/tasks` | List tasks |
| `/task add <title>` | Create task |
| `/task <id> assign\|start\|complete` | Update task |
| `/heartbeat` | List heartbeats |
| `/heartbeat add <agent> <seconds> <message>` | Add heartbeat |
| `/heartbeat pause\|resume\|remove <id>` | Manage heartbeat |
| `/help` | Show help |

## Scripts

The skill includes shell scripts and Node.js helpers in `skills/idagents-admin-control/`:

| Script | Purpose |
|--------|---------|
| `remote-command.sh` | Execute a single CLI command via `/remote` |
| `talk-to-manager.sh` | Send a message to the manager's `/talk` endpoint with a reply endpoint |
| `start-listener.js` | Start a temporary HTTP server to receive async replies |
| `admin-session.js` | All-in-one session: talk, remote commands, or listen mode |
| `management-loop.sh` | Continuously send tasks to an agent on an interval and poll for completion |

### remote-command.sh

Execute a CLI command and print the result:

```bash
./skills/idagents-admin-control/remote-command.sh "/agents"
./skills/idagents-admin-control/remote-command.sh "/deploy idchain"
./skills/idagents-admin-control/remote-command.sh "/ask coder Build a REST API"
```

### talk-to-manager.sh

Send a message to the manager (human in the CLI) and specify where to receive the reply:

```bash
./skills/idagents-admin-control/talk-to-manager.sh "Can I spawn 3 agents?" http://localhost:4050
```

This POSTs to the manager's `/talk` endpoint. The reply arrives at the specified endpoint when the human responds in the CLI.

### start-listener.js

Start a temporary HTTP server that receives replies on `POST /news`:

```bash
node skills/idagents-admin-control/start-listener.js 4050
```

The listener prints received messages to stdout and stores them in memory. It shuts down on `SIGINT`, timeout (10 minutes default), or when it receives a message with `type: "admin.done"`.

### admin-session.js

All-in-one script with three modes:

```bash
# Talk to manager and wait for reply
node skills/idagents-admin-control/admin-session.js talk "Can I spawn a new agent?"

# Execute a remote command
node skills/idagents-admin-control/admin-session.js remote "/agents"

# Start listener only
node skills/idagents-admin-control/admin-session.js listen
```

The `talk` mode automatically starts a temporary listener, sends the message, waits for the reply, then shuts down.

### management-loop.sh

Continuously dispatch a task to an agent, poll for completion, wait, repeat:

```bash
./skills/idagents-admin-control/management-loop.sh coder "Review open PRs" 60
```

Arguments: `<agent-name> <task> [interval_seconds]` (default interval: 60s).

## Talk-to-Manager Pattern

This is a two-step human-in-the-loop approval flow:

1. **Start a temporary listener** to receive the reply:

```bash
node skills/idagents-admin-control/start-listener.js 4050
```

2. **Send a message** to the manager with your reply endpoint:

```bash
./skills/idagents-admin-control/talk-to-manager.sh "I want to refactor the auth module. OK?" http://localhost:4050
```

3. The human sees the message in the interactive CLI and replies.

4. The reply arrives at `http://localhost:4050/news` and is printed to stdout.

5. Based on the reply, proceed with remote commands:

```bash
./skills/idagents-admin-control/remote-command.sh "/ask coder Refactor the auth module"
```

## Polling for Agent Replies

After dispatching work via `/ask`, you need to poll the agent's news feed to get the reply.

### Single Agent

```bash
# Record timestamp before dispatching
BEFORE=$(date +%s)000

# Dispatch task
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command": "/ask coder Build the login page"}'

# Poll every 10s for up to 2 minutes
for i in $(seq 1 12); do
  reply=$(curl -s -X POST http://localhost:4100/remote \
    -H "Content-Type: application/json" \
    -d '{"command": "/news coder"}' | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('result',{}).get('items',[])
for item in reversed(items):
    if item.get('type')=='outbound.reply' and item.get('timestamp',0) > $BEFORE:
        print(item['data']['message'][:2000])
        break
" 2>/dev/null)
  if [ -n "$reply" ]; then echo "REPLY: $reply"; break; fi
  sleep 10
done
```

### Multiple Agents (Threshold-Based)

Dispatch to several agents and wait for a threshold (e.g., 2 of 3) to reply:

```bash
BEFORE=$(date +%s)000

# Dispatch to all agents
for agent in designer frontend backend; do
  curl -s -X POST http://localhost:4100/remote \
    -H "Content-Type: application/json" \
    -d "{\"command\":\"/ask ${agent} Review the spec and give feedback\"}"
done

# Wait for 2 of 3, check every 10s, max 3 minutes
for i in $(seq 1 18); do
  results=""
  for agent in designer frontend backend; do
    reply=$(curl -s -X POST http://localhost:4100/remote \
      -H "Content-Type: application/json" \
      -d "{\"command\":\"/news ${agent}\"}" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    items = data.get('result',{}).get('items',[])
    for item in reversed(items):
        if item.get('type')=='outbound.reply' and item.get('timestamp',0) > $BEFORE:
            print(item['data']['message'][:200].replace(chr(10), ' '))
            break
except: pass
" 2>/dev/null)
    if [ -n "$reply" ]; then results="${results}${agent}: ${reply}\n"; fi
  done
  count=$(echo -e "$results" | grep -c ":" 2>/dev/null || echo 0)
  if [ "$count" -ge 2 ]; then echo -e "$results"; break; fi
  sleep 10
done
```

**Tips:**
- Record the timestamp **before** dispatching so you can filter out stale replies
- Use a threshold rather than waiting for all agents (some may be slow or stuck)
- If an agent keeps returning stale replies, use `/clear <agent>` to reset its session

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGER_URL` | `http://127.0.0.1:4100` | Manager daemon endpoint (dispatch + polling) |
| `ADMIN_LISTENER_PORT` | `4050` | Port for the temporary reply listener |
| `ADMIN_LISTENER_TIMEOUT` | `600000` | Listener auto-shutdown timeout in ms (10 min) |
| `ADMIN_REPLY_TIMEOUT` | `300000` | Timeout waiting for a single reply in ms (5 min) |

## Example: Full Admin Workflow

```bash
# 1. Check what's running
./skills/idagents-admin-control/remote-command.sh "/agents"

# 2. Deploy a team
./skills/idagents-admin-control/remote-command.sh "/deploy idchain"

# 3. Ask the manager for approval (human-in-the-loop)
node skills/idagents-admin-control/admin-session.js talk "Team deployed. Should I start the sprint?"

# 4. Dispatch tasks to agents
./skills/idagents-admin-control/remote-command.sh "/ask contracts Write tests for IDRegistry"
./skills/idagents-admin-control/remote-command.sh "/ask web Build the dashboard page"

# 5. Check progress
./skills/idagents-admin-control/remote-command.sh "/news contracts"
./skills/idagents-admin-control/remote-command.sh "/news web"
```
