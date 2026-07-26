# Interactive Agent (Your Human-in-the-Loop Console)

The interactive CLI (`npm run id-agents`) is now a pure client of the manager daemon. You participate through the daemon-owned manager inbox and agent control surfaces; the CLI does not run its own local REST-AP server.

## Quick start

### 1) Configure + run the interactive CLI

```bash
npm install
cp env.example .env
# edit .env: set DATABASE_URL (required for PostgreSQL)
# For Claude runtimes: set `ANTHROPIC_API_KEY` or run `claude login`
# For Codex runtimes: run `codex login` or set `OPENAI_API_KEY`
# For Cursor runtimes: install from https://cursor.com with `curl https://cursor.com/install -fsS | bash`, then `cursor-agent login` or set `CURSOR_API_KEY`

npm run id-agents
```

By default, this starts your interactive console with:
- **Manager port**: `4100`
- **Agent ports**: `4101+` (dynamically assigned)

You can override the manager port:

```bash
npm run id-agents -- --port 5000
MANAGER_PORT=5000 npm run id-agents
```

### 2) Deploy agents

Inside the CLI:
- `/deploy <config>` — Deploy agents from a YAML config (clean/first-time)
- `/diff <team> <config>` — report drift, read-only. `/sync` is [REMOVED](./sync-command.md); change live teams with `/model <agent> <model>`, `/delete <agent>`, and `id-agents spawn <name>` to add one
- `/deploy local-agent <name>` — Deploy a single local agent

### 3) Verify agents are running

Inside the CLI:
- `/agents` — List all agents with status and ports
- `/status` — Check agent health

You should see only the team’s actual agents. The control-plane `manager` is contacted through the reserved manager channel, not listed as a peer agent.

## CLI Commands

| Command | Description |
|---------|-------------|
| `/agent <name> rebuild` | Rebuild a single agent |
| `/agents` | List all agents |
| `/agents rebuild` | Rebuild all agents |
| `/ask <agent> <msg>` | Talk to agent (continues session) |
| `/hey <agent> <msg>` | Alias for /ask |
| `/ask * <msg>` | Broadcast to all agents |
| `/clear [agent]` | Clear session (start fresh) |
| `/delete <agent>` | Delete agent |
| `/deploy <config>` | Deploy agents from config (clean/first-time) |
| `/diff <team> <config>` | Report drift between the database and a config (read-only). `/sync` is [REMOVED](./sync-command.md) |
| `/help` | Show help |
| `/news [-l] <agent>` | Check recent messages (-l for full content) |
| `/status` | Check agent status |
| `/team` | Show current team |
| `/teams` | List all teams |
| `/team <name>` | Switch to or create team |
| `/team delete <name>` | Delete a team |
| `/quit` | Exit |

## Responding to other agents

When another agent asks you something, you'll see it as a pending query in the CLI. Respond directly in the terminal when prompted.

## How it works (high-level)

- The CLI connects to the manager daemon on `:4100`.
- Pending manager work is read via daemon APIs and answered through the daemon-owned manager inbox.

## Multi-team support

Switch between teams to manage different groups of agents:

```
/team my-project    # Switch to (or create) a team
/teams              # List all teams
/team delete old    # Delete a team
```

Each team gets its own set of agents, port allocations, and workspace directory.

## Public Agents

To register and chat with remote public-agents hosted on a VPS, see the [Public Team Bootstrap guide](./public-team-bootstrap.md).

## Troubleshooting

- **Agents can't reach you**: agents run as local processes and communicate via `localhost`.
- **Wrong port**: restart with `npm run id-agents -- --port <port>`.
