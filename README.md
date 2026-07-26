```
  ██╗██████╗       █████╗  ██████╗ ███████╗███╗   ██╗████████╗███████╗
  ██║██╔══██╗     ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔════╝
  ██║██║  ██║     ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ███████╗
  ██║██║  ██║     ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ╚════██║
  ██║██████╔╝     ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ███████║
  ╚═╝╚═════╝      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝
```

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Version 0.1.109-beta**

Run a team of AI coding agents from a single chat. Each agent is a real process with full tool access — **Claude Code CLI**, **OpenAI Codex**, **Cursor CLI**, or a mix. No UI needed. Connect from any terminal, Telegram, or SSH session.

## Key Features

- **Multiple runtimes** - Claude Code CLI, OpenAI Codex, and Cursor CLI — mix and match in the same team
- **Public-agent support** - register any REST-AP service that publishes `/.well-known/restap.json` with `service_type: "public-agent"` into the `public` team via `/public add <domain>`. The id-agents manager handles manager-join registration, optional OWS wallet provisioning with SSH-delivered wallet identity files, heartbeat probes, and DMZ metadata. **[Juno](https://github.com/idchain-world/juno)** is the reference public-agent implementation we ship — capability-limited by design, safe to point at the internet — but any service that speaks the same protocol works
- **Task system** - Create, assign, claim, and track tasks across agents (`/task` commands + `/tasks` REST API)
- **Check-ins** - Auto-attached supervision watches on delegated tasks. Wakes the dispatcher on a configurable interval if the delegate may be stalled; auto-closes when the linked task hits `done`
- **Scheduling** - Heartbeat intervals and calendar events for automated recurring work
- **Org chart** - Define team structure with groups and tags so agents know their peers and leads
- **Skills & plugins** - Standard Claude Code skills and plugins, declared in config and deployed to each agent
- **Agent wallets** - Opt-in multi-chain wallets via [OWS](https://github.com/open-wallet-standard/core) (`wallet: true` in config, or `/agent <name> wallet provision` on demand)
- **Remote API** - Programmatic management via `/remote` endpoint and `/tasks` REST API
- **TUI Dashboard** - Live terminal dashboard for the running team — agents list, news feed, message detail (`npm run tui:dev`)

## Architecture

```
┌─────────────────────────────┐       ┌─────────────────────────────┐
│                             │       │                             │
│      Interactive CLI        │       │    Remote API (/remote)     │
│ (src/interactive-agent-cli) │       │   External tools, scripts,  │
│                             │       │   other Claude Code agents  │
└──────────────┬──────────────┘       └──────────────┬──────────────┘
               │                                     │
               └──────────────┬──────────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │                   │
                    │      Manager      │
                    │       :4100       │
                    │  agent-manager-db │
                    │                   │
                    └─────────┬─────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│               │   │               │   │               │
│   Agent A     │   │   Agent B     │   │   Agent C     │
│    :4101      │   │    :4102      │   │    :4103      │
│  Claude Code  │   │     Codex     │   │  Cursor CLI   │
│               │   │               │   │               │
└───────────────┘   └───────────────┘   └───────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
             ┌────────────┐     ┌────────────┐
             │            │     │            │
             │  Database  │     │ Workspace  │
             │  (SQLite)  │     │   Files    │
             │            │     │            │
             └────────────┘     └────────────┘
```

**Components:**
- **Manager** (`src/agent-manager-db.ts`) - DB-backed API, agent registry, orchestration logic, `/remote` endpoint for programmatic access
- **Worker** (`src/agent-rest-server.ts`) - REST-AP server running each local agent process
- **Local Agent Server** (`src/local-agent-server.ts`) - Spawns and manages local agent processes

## Quick Start

### Prerequisites

- **Node.js** 20+
- **Claude Code CLI** — install from [claude.ai/code](https://claude.ai/code) and run `claude login`
- **Claude Pro or Max plan** (agents use your Claude Code subscription — no API key needed)
- **OpenAI Codex CLI** (optional) — install from [github.com/openai/codex](https://github.com/openai/codex) and run `codex login`
- **Cursor CLI** (optional) — install from [cursor.com](https://cursor.com) with `curl https://cursor.com/install -fsS | bash` and run `cursor-agent login` (or set `CURSOR_API_KEY`)
- **[OWS CLI](https://github.com/open-wallet-standard/core)** (optional, for agent wallets)

> **Important:** You must be logged into Claude Code CLI before starting ID Agents. Run `claude login` in your terminal and complete the authentication. If you use Claude Code in VS Code, you still need to log in via the terminal — open VS Code's integrated terminal and run `claude login` there.

> **⚠️ Permissions:** ID Agents runs each agent as a background process. By default, `claude-code-cli` agents spawn with `--dangerously-skip-permissions`, `codex` agents spawn with `--dangerously-bypass-approvals-and-sandbox`, and `cursor-cli` agents spawn with `-f` (force-allow commands), because background processes have no shell to approve tool prompts. You can opt out per agent (or under `defaults`) with `dangerouslySkipPermissions: false`, but the agents will then hang silently on the first tool-use prompt. If you are not comfortable giving background agents this level of autonomy, ID Agents is not the right tool for you. See [QUICKSTART.md](./QUICKSTART.md#-permissions-notice--read-before-deploying) for the full notice.

### Recommended: Let Claude set it up

The fastest way to start is to let a Claude Code session do it. Claude finds the repo, pulls the latest changes if it already exists (or clones it if it does not), installs the `idagents-admin-control` skill, rebuilds, starts the manager, deploys the default team, then offers to act as your team manager.

Paste this into any Claude Code session:

> Find https://github.com/idchain-world/id-agents.git then read and follow the QUICKSTART.md file in the repo.

<details>
<summary>Prefer to refresh the skill yourself first?</summary>

```bash
if [ -d id-agents/.git ]; then
  cd id-agents && git pull --ff-only
else
  git clone https://github.com/idchain-world/id-agents.git
  cd id-agents
fi
mkdir -p <your-claude-code-project>/.claude/skills/idagents-admin-control
rsync -a --delete skills/idagents-admin-control/ <your-claude-code-project>/.claude/skills/idagents-admin-control/
```

Then paste the prompt above into Claude Code.

</details>

See [QUICKSTART.md](./QUICKSTART.md) for the full step-by-step.

### Manual install

Prefer to run the steps yourself? Skip the skill and use the interactive CLI directly.

#### 1) Setup

```bash
# First, make sure Claude Code CLI is installed and logged in
claude login

# Then clone and set up ID Agents
git clone https://github.com/idchain-world/id-agents.git
cd id-agents
npm install
```

That's it — no database setup needed. ID Agents uses SQLite by default (stored at `~/.id-agents/id-agents.db`). For PostgreSQL, set `DATABASE_URL` in a `.env` file.

#### 2) Run the interactive CLI

```bash
npm run id-agents
```

Custom port (default: 4100):

```bash
MANAGER_PORT=5000 npm run id-agents
```

#### 3) Deploy and talk to agents

`configs/default.yaml` is the source of truth — whatever is in the file is what gets deployed. Before deploying, edit it to match the runtimes on this host:

```bash
./scripts/detect-runtimes.sh   # first line: one of mixed | as-is | all-codex | abort (see QUICKSTART); Cursor readiness may print as an extra comment line
```

The default team always has 2 agents (`coder` + `researcher`). `detect-runtimes.sh` prints the exact edits for your host — see [QUICKSTART Step 4](./QUICKSTART.md) for the full snippets.

Then deploy and talk to the team:

```
/deploy default
/ask coder Write a hello world function
```

See [QUICKSTART Step 4](./QUICKSTART.md) for the full detection commands.

`/deploy` is create-only: it refuses a team that already holds agents. To change a running team, use the surgical commands — `/model <agent> <model>` to change a model, `/delete <agent>` to remove one — and `/diff <team> <config>` to inspect drift without changing anything. [`/sync` is REMOVED](docs/guides/sync-command.md); the database is the source of truth and a config file may no longer overwrite it. Use `/export <team> [path]` to write a config back out from the database.

### Connecting a Manager

ID Agents runs the servers and agent processes. You connect to it through a "manager" — any AI coding agent that can reach the `/remote` API. This can be Claude Code CLI, OpenAI Codex, Cursor CLI, OpenClaw, or any other agent that can make HTTP requests.

```bash
# The manager is whatever you're chatting in — it controls the team via /remote
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/status"}'
```

Connect from anywhere — terminal, mobile (via Telegram), SSH, or any tool that can POST to `/remote`.

### TUI Dashboard

Launch the live terminal dashboard to watch the running team without polling by hand:

```bash
npm run tui:dev          # source mode (tsx)
npm run tui              # build + run from dist/
```

The TUI talks to the manager at `MANAGER_URL` (default `http://localhost:4100`) and has multiple pages: the agents table, the per-agent news feed, news-item detail, tasks/calendar/heartbeats, plus read-only library browsers for `configs/agents/` and `configs/skills/` (`l` and `s`). Navigate with the arrow keys. `Tab` cycles teams, `q` quits.

```
↑↓ nav · → news · Tab team · l library/agents · s library/skills · q quit
```

iTerm2 is the recommended terminal — it renders the alt-screen content flicker-free. See [docs/guides/tui.md](./docs/guides/tui.md) for the full keybindings reference and terminal compatibility notes.

## REST-AP Protocol

[REST-AP (REST Agent Protocol)](https://github.com/nxt3d/rest-ap) defines how agents communicate ([local docs](./docs/protocol/rest-ap.md)):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/.well-known/restap.json` | GET | Discovery catalog |
| `/talk` | POST | Send message (triggers LLM processing, async) |
| `/schedule` | POST | Enqueue manager-owned internal scheduled work (optional) |
| `/news` | GET | Poll for updates (free, no LLM cost) |
| `/news` | POST | Receive replies without processing |

**Agent-internal endpoint:**
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/talk-to` | POST | Synchronous agent-to-agent communication (blocks until reply) |

**Manager-specific endpoints:**
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/agents` | GET | List all agents |
| `/message` | POST | Fire-and-forget agent-to-agent messaging (no reply) |
| `/remote` | POST | Execute CLI commands programmatically (no auth required) |

## Scheduling

ID Agents has one manager-owned scheduling system with two schedule kinds:
- `heartbeat` schedules for recurring work every N seconds
- `calendar` schedules for one-off or recurring wall-clock events

The manager is the only component that decides when a run is due. Agents do not run independent schedulers. Every due run is logged in the database before dispatch, which makes scheduling restart-safe and prevents double-fires.

### Authoring model

For single-agent recurring work, keep scheduling close to the agent with `heartbeat`. The agent reads its own `HEARTBEAT.md` checklist when woken up:

```yaml
agents:
  - name: monitor
    heartbeat: 300  # seconds — agent reads HEARTBEAT.md
```

Place the checklist at `.claude/agents/{name}/HEARTBEAT.md` in the agent's working directory. It is copied to the root at spawn time. If nothing needs attention, the agent responds with `HEARTBEAT_OK` and the response is silently suppressed from the news feed.

For wall-clock events, use top-level `calendar`:

```yaml
calendar:
  - title: "Morning X engagement"
    time: "09:00"
    timezone: "America/New_York"
    days: [mon, tue, wed, thu, fri]
    agents: [x]
    message: "Review timeline and draft replies"
    delivery: internal
```

### Delivery modes

Schedules support two delivery modes:
- `talk` - manager posts the scheduled payload to the agent's `/talk` endpoint
- `internal` - manager posts the scheduled payload to the agent's `/schedule` endpoint so the agent can treat it as internal self-directed work

Defaults:
- `heartbeat` defaults to `internal`
- `calendar` defaults to `talk`

The `from` field in the delivery payload comes from the schedule's `sender` field. Defaults:
- Heartbeats default to `from: "heartbeat"`
- Calendar events default to `from: "schedule"`
- You can override with `--sender` when adding a schedule via the CLI

The payload sent to agents is structured like:

```json
{
  "from": "heartbeat",
  "mode": "internal",
  "schedule": {
    "id": "sch_123",
    "kind": "interval",
    "title": "monitor heartbeat",
    "scheduledKey": "interval:sch_123@1711612800"
  },
  "message": "Check system health and report status"
}
```

See [Scheduling Plan](./docs/SCHEDULING_PLAN.md) for the full design.

## CLI Commands

```
/agent <name> rebuild       # Rebuild a single agent
/agents                     # List all agents
/agents rebuild --confirm   # Rebuild all eligible local Claude agents
/ask <agent> <message>      # Talk to agent (continues session)
/hey <agent> <message>      # Alias for /ask
/ask * <message>            # Broadcast to all agents
/clear [agent]              # Clear session (start fresh)
/delete <agent>             # Delete agent
/delete *                   # Delete all agents in current team
/delete --team <name>       # Delete all agents in specified team
/deploy <config>            # Create a NEW team from config (refuses an existing one)
/export <team> [path]       # Write a config out from the database
/import <file> [--team]     # Create a new team from a config file
/diff <team> <config>       # Report drift between database and config (read-only)
/sync <config>              # REMOVED — see /diff, /export, /import
/output <agent>             # List files in agent's output directory
/artifact <agent> <path>    # Read a file from agent's output directory
/help                       # Show help
/news [-l] <agent>          # Check recent messages (-l for full content)
/status                     # Check agent status
/heartbeat                   # List heartbeats
/heartbeat add <agent> <seconds> <message>  # Add heartbeat
/heartbeat pause|resume|remove <id>         # Manage heartbeat
/calendar                    # List calendar events
/calendar add <agent> <time> <days|date> <message>  # Add calendar event
/calendar pause|resume|remove <id>          # Manage calendar event
/task create "<title>" [--name <slug>] [--owner <agent>]  # Create task
/task list [--status todo|doing|done]                    # List tasks
/task assign <name> <agent>  # Assign task
/task done <name>            # Complete task
/task remove <name>          # Delete task
/update <agent> [--wallet|--name]  # Update agent properties
/wallet <agent> [chain]     # Show agent wallet addresses
/quit                       # Exit
```

## Remote API

The Manager exposes a `/remote` endpoint (no authentication required — localhost only) that lets any external tool — including another Claude Code session — interact with your agent team programmatically. This is how you manage agents from outside the interactive CLI. Team commands (`/deploy`, `/export`, `/import`, `/diff`) also work via `/remote`.

**From a terminal or script:**

```bash
curl -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/agents"}'
```

**From another Claude Code session:** If you're working in Claude Code on a different project, you can dispatch tasks to your agent team by calling the `/remote` endpoint via Bash. For example, ask your contracts agent to review code:

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/ask contracts Review the latest changes to IDRegistry.sol"}'
```

Then check for the reply:

```bash
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command":"/news contracts"}'
```

This means any Claude Code instance on the same machine can coordinate with your agent team — dispatching work, checking results, and managing the fleet without switching to the interactive CLI.

**Available Commands:**
- `/agent <name> rebuild` - Rebuild a single agent
- `/agents` - List all agents
- `/agents rebuild --confirm` - Rebuild all eligible local Claude agents
- `/ask <name> <message>` - Send message to agent
- `/clear [agent]` - Clear session
- `/delete <name>` - Delete agent
- `/delete *` - Delete all agents in current team
- `/delete --team <name>` - Delete all agents in specified team
- `/deploy <config>` - Create a NEW team from a YAML config (refuses a team that already holds agents)
- `/export <team> [path]` - Write a config out from the database
- `/import <file> [--team]` - Create a new team from a config file
- `/diff <team> <config>` - Report drift between the database and a config (read-only)
- `/sync <config>` - [REMOVED](docs/guides/sync-command.md) — use `/diff`, `/export`, `/import`
- `/news [-l] <name>` - Check recent messages
- `/output <name>` - List files in agent's output directory
- `/artifact <name> <path>` - Read a file from agent's output directory
- `/status` - Show status
- `/heartbeat` - List heartbeats
- `/heartbeat add <agent> <seconds> <message>` - Add heartbeat
- `/heartbeat pause|resume|remove <id>` - Manage heartbeat
- `/calendar` - List calendar events
- `/calendar add <agent> <time> <days|date> <message>` - Add calendar event
- `/calendar pause|resume|remove <id>` - Manage calendar event
- `/task create "<title>"` - Create task
- `/task list` - List tasks
- `/task assign <name> <agent>` - Assign task
- `/task done <name>` - Complete task
- `/task remove <name>` - Delete task

## Task API

The Manager exposes dedicated `/tasks` REST endpoints for agent task coordination. Agents should use these instead of `/remote` for task operations — it's simpler, safer, and doesn't expose arbitrary CLI access.

| Route | Method | Description |
|-------|--------|-------------|
| `/tasks` | POST | Create a task (`{ title, name?, description?, team?, from? }`) |
| `/tasks` | GET | List tasks (query params: `status`, `owner`, `team`) |
| `/tasks/:name` | GET | Get a single task by name |
| `/tasks/:name/claim` | POST | Claim a task (`{ agent_id }`) |
| `/tasks/:name/done` | POST | Mark task complete (`{ agent_id }`) |
| `/tasks/:name` | DELETE | Remove a task |

**Create and claim a task:**

```bash
# Create
curl -s -X POST http://localhost:4100/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Fix the overflow bug", "name": "fix-overflow"}'

# Claim
curl -s -X POST http://localhost:4100/tasks/fix-overflow/claim \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "my-agent"}'

# Mark done
curl -s -X POST http://localhost:4100/tasks/fix-overflow/done \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "my-agent"}'

# List open tasks
curl -s "http://localhost:4100/tasks?status=todo"
```

Task statuses: `todo` (unclaimed), `doing` (in progress), `done` (completed). The `agent_id` field accepts agent names or aliases, resolved against the current team.

## Check-ins

A **check-in** is a supervision watch the dispatcher attaches to a delegated task. While the delegate is working, the manager fires the check-in on a configurable interval, wakes the dispatcher, and lets it observe whether the work is actually progressing. When the linked task hits a terminal status (`done`), the check-in auto-closes silently — no overhead in the happy path.

The cleanest way to attach one is through the manager's `/talk-to` endpoint with a `task` field. The manager creates the task and the watching check-in atomically:

```bash
curl -s -X POST http://localhost:4100/talk-to \
  -H "Content-Type: application/json" \
  -d '{
    "to": "coder",
    "from": "me",
    "message": "Implement the X feature and reply when done.",
    "task":  { "title": "Implement X", "name": "implement-x" },
    "checkin": "10m",
    "checkin_iters": 4
  }'
```

The dispatcher (`from`) gets pinged every 10 minutes with the linked task's status, last activity, and an actions map. Defaults: 10-minute interval, `close_when: {task_status: ['done']}`. Pass `"no_checkin": true` to skip attachment.

| Route | Method | Description |
|-------|--------|-------------|
| `/checkins` | POST | Create a check-in (`{ owner, linked_task?, interval?, priority?, max_iterations?, ttl?, close_when? }`) |
| `/checkins` | GET | List check-ins (query params: `owner`, `linked_task`, `status`, `due_before`) |
| `/checkins/:id/snooze` | POST | Push the next fire out (`{ duration }`) |
| `/checkins/:id/close` | POST | Close manually (`{ reason? }`) |

When a check-in fires it lands in the dispatcher's news feed as a `checkin_due` item (the dispatcher's LLM is woken). The recommended response, before doing anything expensive, is the **probe ladder** documented in `skills/inter-agent/SKILL.md`:

1. Re-read the linked task — has `updated_at` advanced?
2. Walk the delegate's working directory for recently modified files (`find -mmin`, `git diff`).
3. Read the delegate's own `/news` for recent activity types.
4. Health-probe the delegate's `/.well-known/restap.json`.
5. Last resort — `/talk-to` the delegate for a one-line status.

Most fires resolve at step 1 or 2. Cheap probes first, expensive ones only when nothing else gave signal.

**Pick the interval thoughtfully.** The first fire should land *after* the work plausibly should have been done. A 5-minute task wants a 6-minute check-in, not 60 seconds. Aggressive intervals generate noise the dispatcher learns to ignore; conservative intervals make every fire actionable.

## Skills & Plugins

Skills and plugins extend agent capabilities. Both are declared in the YAML config and automatically deployed to each agent's working directory at deploy time.

### Skills

Skills use the standard [Claude Code skill format](https://docs.anthropic.com/en/docs/claude-code/skills) — a `SKILL.md` file with YAML frontmatter inside a named directory. Drop any skill into `skills/` and reference it by name in your config.

**Built-in skills:**

| Skill | Description |
|-------|-------------|
| `identity` | Agent name and team |
| `inter-agent` | Messaging, delegation, news feed for multi-agent coordination |
| `catalog` | REST-AP self-description visible to other agents |
| `wallet` | OWS multi-chain wallet addresses (skipped if no wallet) |
| `xmtp` | Encrypted messaging via ENS names using the [XMTP](https://xmtp.org/) protocol |
| `idagents-admin-control` | Remote CLI management — chat with manager, execute commands (external skill) |

**Adding a skill:**

1. Create a directory in `skills/` with a `SKILL.md` file:

```
skills/my-skill/
  SKILL.md
```

2. Add YAML frontmatter to `SKILL.md`:

```markdown
---
name: my-skill
description: What this skill does. Claude uses this to decide when to invoke it.
---

# My Skill

Instructions for the agent...
```

3. Reference it in your config:

```yaml
defaults:
  skills: [identity, inter-agent, catalog, wallet, my-skill]
```

All configs should include `skills: [identity, inter-agent, catalog]` at minimum. Skills from defaults and per-agent lists are merged (deduped). You can also download skills from Anthropic or the community and drop them in.

Skills are deployed at deploy time via `deploySkillsToAgent`. The target directory is runtime-aware: `.claude/skills/` for Claude agents, `.agents/skills/` for Codex agents.

### Plugins

Plugins are [Claude Code plugins](https://docs.anthropic.com/en/docs/claude-code/plugins) (MCP servers, tool providers). They can also bundle skills in their own `skills/` subdirectory.

```yaml
defaults:
  plugins:
    - name: frontend-design
      path: ../plugins/claude-code/frontend-design
```

See [Skills README](./skills/README.md) for the full skill directory listing.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | No | PostgreSQL connection string (SQLite used by default if not set) |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (not needed with Claude Pro or Max — run `claude login` instead) |
| `CLAUDE_MODEL` | No | Default model (e.g., `claude-opus-4-6`) |
| `PUBLIC_BASE_URL` | No | Public URL base for agents (e.g., `https://idbot.live`) |

**Per-agent environment (set automatically by the manager):**

| Variable | Description |
|----------|-------------|
| `ID_AGENT_PORT` | The agent's own REST-AP port (e.g., `4101`) |
| `ID_AGENT_NAME` | Agent name |
| `ID_AGENT_ALIAS` | Agent alias (same as name) |
| `ID_TEAM` | Team name |
| `MANAGER_URL` | Manager base URL (e.g., `http://localhost:4100`) |

### YAML Configuration

Deploy multiple agents from a config file:

```yaml
version: "1"
team: my-team

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-opus-4-6
  skills:
    - identity
    - inter-agent
    - catalog
    - wallet

agents:
  - name: coder
    description: "Writes and reviews code"
    workingDirectory: /path/to/project
    heartbeat: 300  # seconds — agent reads HEARTBEAT.md
  - name: researcher
    description: "Research and analysis"
    workingDirectory: /path/to/research
    skills: [custom-research-skill]    # Added to defaults

calendar:
  - title: "Daily standup prep"
    time: "09:00"
    timezone: "America/New_York"
    days: [mon, tue, wed, thu, fri]
    agents: [coder, researcher]
    message: "Prepare daily updates and blockers"
    delivery: talk
```

See [Configuration Reference](./docs/reference/configuration.md) for full options.

### Agent Instructions: Two Sources

Every agent's `CLAUDE.md` is composed from exactly two sources:

1. **Protocol defaults** (`src/protocol-defaults.ts`) — framework-managed rules injected into every agent automatically: scheduling awareness, task-discipline lifecycle, output convention. Users never edit these in YAML.
2. **Agent role file** (`{workingDirectory}/.claude/agents/{name}.md`) — role-specific personality and context, editable by the user, versionable in git. If the file does not exist, the agent runs with protocol defaults only.

The YAML config provides **infrastructure only**: name, workingDirectory, model, runtime, heartbeat, skills. No `claudeMd` field.

Two file patterns are supported (checked in this order), and paths are **runtime-aware**:

| Runtime | Template Directory | Personality File | Skills Directory |
|---------|-------------------|-----------------|-----------------|
| `claude-code-cli` | `.claude/agents/` | `.claude/CLAUDE.md` | `.claude/skills/` |
| `claude-agent-sdk` | `.claude/agents/` | `.claude/CLAUDE.md` | `.claude/skills/` |
| `codex` | `.agents/` | `AGENTS.md` (project root) | `.agents/skills/` |
| `cursor-cli` | `.cursor/agents/` | `AGENTS.md` (project root) | `.cursor/skills/` |

```
# Claude agent layout
myproject/
  .claude/
    agents/
      coder/
        CLAUDE.md           # directory pattern (priority)
      security-audit.md     # single-file pattern (fallback)

# Codex agent layout
myproject/
  .agents/
    cto/
      AGENTS.md             # directory pattern (priority)
    researcher.md           # single-file pattern (fallback)

# Cursor agent layout
myproject/
  .cursor/
    agents/
      coder/
        AGENTS.md           # directory pattern (priority)
      researcher.md         # single-file pattern (fallback)
```

The directory pattern takes priority over the single-file pattern. Use the directory pattern when the agent needs additional supporting files alongside its role definition.

A role file uses optional YAML frontmatter for metadata:

```markdown
---
description: Security audit specialist
---

You are a security auditor. Focus on OWASP Top 10 vulnerabilities.
Always check for injection, XSS, and authentication issues.
```

- **Body** becomes the agent's role content, appended after protocol defaults in `CLAUDE.md`.
- **`description`** from frontmatter is used as the agent's description if the config doesn't set one.

Use the `agent` field in config to deploy a library-owned agent entry before skills run. `agent:` and `skills:` are peers on each agent entry:

```yaml
agents:
  - name: auditor
    agent: security-audit          # one entry from configs/agents/
    skills: [using-foundry]        # zero or more entries from configs/skills/
    workingDirectory: /path/to/project
```

`configs/agents/<name>/` supports two native shapes:

- **Claude-native** — directory with `CLAUDE.md` (plus optional `skills/`, `agents/`, `commands/`, `rules/`, `settings.json`, `hooks/`, `files/`)
- **AGENTS.md-native** — sibling pair `<name>.md` + `<name>/`, where the `.md` file is the persona and the directory holds extras

Standalone skills live at `configs/skills/<name>/SKILL.md`. Library root is `<cwd>/configs` by default; override with `ID_LIBRARY_ROOT` to point at any clone of [public-agents](https://github.com/idchain-world/public-agents).

Deploy is **additive-only and receipt-driven**: Step A copies the agent entry, Step B overlays `skills:` on top, and any file whose on-disk SHA does not match what we last wrote is treated as user-owned and skipped. A workspace receipt at `.id-agents/receipt.json` is the ownership ledger for the `id-agents sync` WORKSPACE CLI — a separate command from the removed `/sync` slash command, and one that still exists. Re-running `id-agents sync` against an unchanged team YAML and unchanged library is intended to be a true no-op: unchanged agents stay in the `unchanged` bucket and do not rebuild just because `skills:` was re-evaluated. See the [sync-command guide](docs/guides/sync-command.md) for the full 4-case ownership rule, per-harness mapping, and memory-file fallback.

The TUI ships a read-only library browser for `configs/agents/` and `configs/skills/` (`npm run tui:dev`).

## Agent Library and Demos

The repo ships an agent library and a set of example team configs. Each library entry is a self-contained agent persona plus optional skills, deployable into any workspace via `agent: <name>` in a team YAML.

```
configs/
  agents/                    # 9 library entries (peer `agent:` target)
    copywriter/
    devops/
    editor/
    foundry-dev/             # MIT, operator-authored
    frontend/
    frontend-react/
    fullstack-nextjs/
    security/                # CC-BY-SA-4.0 (Trail of Bits skills bundled)
    solidity-security/
  skills/                    # standalone skill entries (peer `skills:` target)
    <name>/SKILL.md
  teams/                     # team templates (peer of agents/, skills/)
    starter-pair/            # minimal 2-agent starter
    solidity-pair/           # builder + adversarial auditor, uses peer agent: + skills:
  demos/                     # 8 example team YAMLs
    editorial-team.yaml
    editorial-team-v2.yaml
    foundry-codex-demo.yaml
    foundry-cursor-demo.yaml
    foundry-demo.yaml
    solidity-dev-team.yaml
    solidity-security-demo.yaml
    solidity-security-team.yaml
```

### Team templates (`configs/teams/`)

Each entry is a directory with a `team.yaml` and a `README.md`. Templates are installed into the library root via the manager:

```
POST /library/install
{ "from": "team:starter-pair", "to": "team:<your-team>" }
```

The endpoint rewrites the top-level `team:` field using the `yaml` package's Document AST — never regex string-splicing, so nested `team:` keys inside maps, tags, or strings survive untouched. The written file at `<libraryRoot>/<your-team>.yaml` is prefixed with a provenance header so you can tell at a glance which template produced it:

```yaml
# Installed from configs/teams/starter-pair/team.yaml on 2026-05-11
version: "1"
team: <your-team>
…
```

Re-installing requires `force:true`, and the source template under `configs/teams/<name>/` is never overwritten.

See [`NOTICE`](./NOTICE) for upstream attributions and per-skill license posture (most skills are MIT, the `security/` bundle is CC-BY-SA-4.0, a couple of Anthropic-authored skills are source-available). Each bundled skill keeps its upstream `LICENSE` next to its `SKILL.md` so the original notice travels with any redistribution.

### Standalone CLI

In addition to the `/deploy` command inside the interactive CLI, the library deploy pipeline is exposed as a one-shot CLI for non-interactive use. Note that `id-agents sync` below is this WORKSPACE CLI — a different command from the removed `/sync` slash command, and not removed:

```bash
id-agents sync <config> [--workspace <path>]      # deploy agent + skills into a workspace
id-agents unsync <config> [--workspace <path>]    # remove managed files using the receipt
```

`id-agents sync` is additive and receipt-driven: any file the user owns or has edited is left untouched. `id-agents unsync` reverses only the files we wrote. See the [sync-command guide](./docs/guides/sync-command.md) for the 4-case ownership rule, the per-runtime mapping, and the memory-file fallback.

### TUI library browsers

Press `l` for the agents library and `s` for the skills library from any TUI top-level view. Both are read-only list/detail views fed by the manager's `/library/agents` and `/library/skills` endpoints; `/library/teams` is the matching read endpoint for team templates. List and detail responses surface a **README-first `description`** — the inventory prefers the first body paragraph of the entry's `README.md` (or, for skills, the SKILL.md frontmatter `description:`) over a sparse config-derived summary. Set `ID_LIBRARY_ROOT` on the manager to point them at any clone of [public-agents](https://github.com/idchain-world/public-agents).

## Agent Wallets (OWS)

If [OWS](https://github.com/open-wallet-standard/core) (Open Wallet Standard) is installed, agents can opt in to a multi-chain wallet. Wallets are encrypted in the OWS vault at `~/.ows/`.

**How wallets are provisioned:**
1. Opt in per agent (or under `defaults`) with `wallet: true` in the YAML config — the manager creates an OWS wallet for the agent at create time (deploy, import or spawn)
2. Or provision on demand for a running agent: `/agent <name> wallet provision`
3. A `wallet` skill is deployed so the agent knows its own addresses

For remote public agents (`/public add`), a wallet opted in at manager-join is provisioned on the manager host, and a wallet identity file (name, `ows_address`, service endpoint) is delivered to the agent's VPS over SSH so the agent can advertise its address.

**Asking an agent for its address:**
```
/ask contracts What is your Bitcoin address?
→ bc1q3aat33mm4jd602y8q7g3w972g0a8zle72srkkz
```

**OWS policies** can restrict which chains and contracts a wallet can interact with. Create a policy and attach it to an API key for scoped access:

```bash
ows policy create --file my-policy.json
ows key create --name "id-agents" --wallet my-wallet --policy my-policy
# Set the API key for policy enforcement:
# OWS_PASSPHRASE=ows_key_...
```

## Org Chart

Teams can define an organizational structure in their YAML config under the `org:` key. This gives agents awareness of who they work with, who leads what, and how the team is organized.

**Two primitives:**

- **Groups** — recursive hierarchy with optional `lead`, `members`, `description`, and nested `groups`
- **Tags** — flat labels that cut across groups (e.g., `reviewers: [alice, bob]`)

**What happens at deploy:**

1. The org chart is rendered into `ORG_CHART.md` and written to the shared team folder
2. Each agent's `identity` skill is populated with their role context — which group they belong to, their peers, their lead, and any tags they carry

**Example config:**

```yaml
org:
  groups:
    engineering:
      lead: alice
      description: "Core product development"
      members: [bob, carol]
      groups:
        infra:
          lead: carol
          members: [dave]
    security:
      lead: eve
      members: [frank]

  tags:
    reviewers: [alice, eve]
    oncall: [carol, frank]
```

**Generated `ORG_CHART.md`:**

```markdown
# Team Org Chart

## engineering
Core product development
- **Lead:** alice
- **Members:** bob, carol

### infra
- **Lead:** carol
- **Members:** dave

## security
- **Lead:** eve
- **Members:** frank

## Tags
- **reviewers:** alice, eve
- **oncall:** carol, frank
```

When `alice` is deployed, her identity skill knows she leads `engineering`, is tagged as a `reviewer`, and can see the full org chart for context on who to delegate to or consult.

## XMTP Encrypted Messaging

Agents can send and receive end-to-end encrypted messages via the [XMTP](https://xmtp.org/) protocol. This enables cross-team and cross-system communication with any wallet address or ENS name.

**How it works:**
- Each agent gets its own XMTP identity derived from its OWS wallet
- Messages are encrypted end-to-end using the MLS protocol
- Send to any ENS name (`agent-15.xid.eth`, `vitalik.eth`) or wallet address
- Inbound messages are routed through the agent's LLM and replies are sent back automatically

**Sending a message (from an agent):**
```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/xmtp/send \
  -H "Content-Type: application/json" \
  -d '{"to": "agent-15.xid.eth", "message": "Hello from across the network"}'
```

**Security model:**
- **Closed by default** — agents only accept messages from explicitly allowed senders
- **3-tier allowlist** — trusted senders (auto-accepted), unknown senders (approval required), blocked senders (silently dropped)
- **OWS signing** — private keys never leave the OWS vault; all XMTP signing is delegated to `ows sign message`
- **Prompt boundary** — inbound XMTP messages are clearly marked as external untrusted input before reaching the LLM

**Data storage:** XMTP data is stored at `~/.xmtp/{address}/` (outside project repos):
- `{env}.db3` — encrypted MLS database (message history, conversation keys)
- `db.key` — auto-generated DB encryption key (mode 0600)
- `allowlist.yaml` — persisted sender allowlist

**Configuration:** Add the `xmtp` skill to your agent config. XMTP starts automatically when an OWS wallet is available:
```yaml
defaults:
  skills: [identity, inter-agent, catalog, xmtp]
```

Set `openMode: true` in the agent config to accept messages from any sender (not recommended for production).

## Inter-Agent Communication

Agents communicate using two methods — both via `curl` from the Bash tool (not SendMessage or built-in Claude Code tools):

**`/talk-to` (primary, synchronous):** Send a message to another agent and block until reply. Called on the agent's own port:

```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to": "agent-name", "message": "your question?", "timeout": 120000}'
```

**`/message` (fire-and-forget):** One-way notification via the manager. No reply expected:

```bash
curl -s -X POST $MANAGER_URL/message \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: $ID_TEAM" \
  -d '{"to": "agent-name", "message": "FYI: deployment is done"}'
```

### Loop Prevention

Triggered messages (from schedules and heartbeats) include a `noAutoReply` flag that prevents the agent from automatically replying back to the sender. The response is stored in the agent's own news feed instead, preventing infinite ping-pong loops between agents. If the agent responds with exactly `HEARTBEAT_OK`, the response is silently suppressed from the news feed and only logged at debug level.

## Ports and Networking

| Component | Port | Description |
|-----------|------|-------------|
| Interactive CLI | none | Pure client terminal UI; does not bind a local HTTP port |
| Manager | 4100 | Main API, `/remote` endpoint, agent registry |
| Agents | 4101+ | Dynamic per-team range (25 ports per team) |

## Documentation

- [docs/README.md](./docs/README.md) - Documentation index
- [docs/protocol/rest-ap.md](./docs/protocol/rest-ap.md) - REST-AP protocol specification
- [docs/guides/interactive-agent.md](./docs/guides/interactive-agent.md) - Interactive CLI guide
- [docs/reference/configuration.md](./docs/reference/configuration.md) - Configuration reference
- [docs/reference/database.md](./docs/reference/database.md) - Database schema
- [docs/guides/tasks.md](./docs/guides/tasks.md) - Task tracking with `/task`
- [docs/guides/news-feed.md](./docs/guides/news-feed.md) - News feed and message channels
- [docs/guides/agent-outputs.md](./docs/guides/agent-outputs.md) - Agent output convention and `/artifact`
- [docs/guides/heartbeats.md](./docs/guides/heartbeats.md) - Agent-driven heartbeat system

## Development

```bash
npm run build           # Compile TypeScript
npm run dev             # Development mode
npm run id-agents       # Interactive CLI
npm test                # Run tests
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
