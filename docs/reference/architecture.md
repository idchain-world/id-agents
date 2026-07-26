# Architecture

## Overview

ID Agents has three layers:

```
Interactive CLI → Manager → Agent Processes
```

### 1. Manager (`src/agent-manager-db.ts`)

The central process running on port 4100 (configurable via `--port` or `MANAGER_PORT`).

**Responsibilities:**
- Stores agent state in the database (SQLite or PostgreSQL)
- Handles the `/remote` API for programmatic access — no auth required (supports `/deploy`, `/export`, `/import`, `/diff`, `/agents`, `/ask`, etc.)
- Serves read-only library inventory via `/library/agents` and `/library/skills`
- Routes fire-and-forget messages between agents via `/message`
- Spawns and stops agent processes
- Provisions opt-in OWS wallets for agents (deploy/spawn, manager-join, or on demand)
- Runs health checks every 30 seconds (marks agents online/offline)
- Serves the `/agents` list with health status
- Owns the scheduling system (heartbeat + calendar)

**Key endpoints:**
- `GET /health` — Manager health check
- `GET /agents` — List all agents with health status
- `GET /library/agents` — List library agent entries from `configs/agents/`
- `GET /library/skills` — List standalone skill entries from `configs/skills/`
- `POST /remote` — Execute CLI commands programmatically (no auth)
- `POST /message` — Fire-and-forget agent-to-agent messaging (no reply)

### 2. Agent Processes (`src/local-agent-server.ts` + `src/agent-rest-server.ts`)

Each agent runs as a separate Node.js process with its own Express server on a dynamically assigned port (4101+, sequential).

**Responsibilities:**
- Hosts REST-AP endpoints (`/talk`, `/talk-to`, `/news`, `/health`)
- When a message arrives on `/talk`, spawns an LLM session to process it
- Stores replies in an in-memory news feed (backed by database)
- Serves `/.well-known/restap.json` for discovery

**REST-AP endpoints per agent:**
- `POST /talk` — Send a message (triggers LLM processing)
- `POST /talk-to` — Synchronous agent-to-agent communication (blocks until reply, localhost only)
- `POST /schedule` — Receive manager-owned scheduled work (internal, with `noAutoReply`)
- `GET /news` — Poll for replies (free, no LLM cost)
- `GET /health` — Agent health check
- `GET /.well-known/restap.json` — Service discovery catalog
- `PATCH /catalog` — Update agent catalog metadata
- `PATCH /identity` — Update agent's identity (called by manager)

### 3. Interactive CLI (`src/interactive-agent-cli.ts`)

The user-facing terminal interface.

**Responsibilities:**
- Connects to the manager on startup (auto-starts it if not running)
- Provides commands: `/ask`, `/deploy`, `/export`, `/import`, `/diff`, `/agents`, `/status`, etc.
- Polls agent news feeds for replies
- Manages agent lifecycle (deploy, sync, rebuild, delete)
- `/deploy` for NEW teams only (create-only, refuses an existing team); `/model <agent> <model>`, `/delete <agent>` and `id-agents spawn <name>` to change a running team; [`/sync` is REMOVED](../guides/sync-command.md)
- Supports `--dry-run` on `/deploy` for preflight without creating agents; `/diff <team> <config>` reports drift against a live team and is always read-only

## Message Flow

```
User types: /ask coder hello

1. CLI resolves "coder" → finds agent on port 4101
2. CLI → POST http://localhost:4101/talk {"message": "hello"}
3. Agent queues the request and returns 202 with query_id
4. Agent spawns an LLM session through the configured runtime harness (`claude-agent-sdk`, `claude-code-cli`, `claude-code-local`, `codex`, or `cursor-cli`)
5. LLM processes the message, generates a reply
6. Reply stored in agent's news feed
7. Agent auto-sends reply to the CLI's /news endpoint
8. Reply displayed to user
```

## Database Schema

| Table | Purpose |
|-------|---------|
| `teams` | Team isolation (default: default) |
| `agents` | Agent state — name, port, status, legacy identity columns (domain/token_id), metadata |
| `news_items` | Async message feed per agent (with timestamps for polling) |
| `queries` | Query tracking for reply routing between agents |
| `wallets` | Deprecated — keys now stored in per-agent .env files |

## Key Source Files

| File | Purpose |
|------|---------|
| `src/agent-manager-db.ts` | Manager — routes, DB, spawning, wallet provisioning, health checks |
| `src/agent-rest-server.ts` | Preferred runtime-neutral entry point for the per-agent REST server |
| `src/agent-rest-server.ts` | Runtime-neutral per-agent REST server export used by manager and local workers |
| `src/claude-agent-server.ts` | Compatibility export layer for older imports of the agent REST server |
| `src/local-agent-server.ts` | Agent process bootstrap and CLI arg parsing |
| `src/interactive-agent-cli.ts` | User-facing CLI |
| `src/config-parser.ts` | YAML config parsing, parameter substitution, runtime-aware template loading |
| `src/runtime/registry.ts` | Runtime registry: defaults, labels, auth/preflight, session policy, `getRuntimePaths()` |
| `src/protocol-defaults.ts` | Framework protocol defaults prepended to every agent's personality file |
| `src/core/agent-identifier.ts` | ENS name parsing and display |
| `src/db.ts` | PostgreSQL schema, migrations, connection pool |
| `src/inter-agent-skill.ts` | Inter-agent communication skill injection |
| `src/xmtp/xmtp-messaging.ts` | XMTP encrypted messaging — allowlist, ENS resolution, approval callbacks |
| `src/xmtp/ows-signer.ts` | OWS-backed XMTP signer — key never leaves vault |
| `src/harness/claude-code-cli.ts` | Claude Code CLI harness for spawning LLM sessions |
| `src/harness/codex.ts` | Codex CLI harness for spawning Codex sessions |
| `src/harness/cursor-cli.ts` | Cursor Agent CLI harness for spawning Cursor sessions |

## Agent Instructions: Two Sources

Every agent's personality file is composed from exactly two sources:

1. **Protocol defaults** (`src/protocol-defaults.ts`) — framework-managed rules injected into every agent automatically: scheduling awareness, task-discipline lifecycle, output convention.
2. **Agent role file** — role-specific personality editable by the user. Located in the runtime-appropriate template directory.

The YAML config provides infrastructure only: name, workingDirectory, model, runtime, heartbeat, skills. No `claudeMd` field.

### Runtime-Aware Paths

All template and skill operations use `getRuntimePaths(runtime)` from `src/runtime/registry.ts`:

| Runtime | Template Directory | Personality File | Skills Directory |
|---------|-------------------|-----------------|-----------------|
| `claude-code-cli` | `.claude/agents/` | `.claude/CLAUDE.md` | `.claude/skills/` |
| `claude-agent-sdk` | `.claude/agents/` | `.claude/CLAUDE.md` | `.claude/skills/` |
| `codex` | `.agents/` | `AGENTS.md` (project root) | `.agents/skills/` |
| `cursor-cli` | `.cursor/agents/` | `AGENTS.md` (project root) | `.cursor/skills/` |

### Spawn Order

All four spawn paths (deploy, sync-changed, sync-added, remote-deploy) follow the same order:

1. Deploy team-level skills to the runtime-aware skills directory
2. Overlay agent directory template (if it exists) to the runtime-aware config directory
3. Write personality file with protocol defaults + role body to the runtime-aware path

This ensures agent-specific files overlay team skills, and the personality file is always written last.

## Agent Wallets (OWS)

Agents can opt in to a multi-chain OWS wallet:

1. `wallet: true` in the YAML config (per agent or under `defaults`) provisions a wallet at deploy/spawn; for remote public agents the same flag on manager-join provisions on the manager host
2. `/agent <name> wallet provision` provisions on demand for a running agent
3. Wallet identifiers land in the agent's metadata (`ows_wallet`, `ows_address`); remote public agents additionally get a wallet identity file delivered over SSH

Legacy note: agents registered under the removed ID Chain integration may still carry `domain`/`token_id` values and ENS-style names; resolvers continue to accept them.

## Health Monitoring

The manager pings each agent's `/health` endpoint every 30 seconds:
- **online** — agent responded within 3 seconds
- **offline** — agent did not respond
- **unknown** — not yet checked

Health status is visible in `/agents` response and `/status` CLI command.

## Inter-Agent Communication

**`/talk-to` (primary, synchronous):** Agents call `/talk-to` on their own port (`localhost:$ID_AGENT_PORT/talk-to`) to send a message and block until a reply arrives. This is the primary inter-agent endpoint. Agents must use `curl` via the Bash tool — not SendMessage or built-in Claude Code tools.

**`/message` (fire-and-forget):** One-way notification routed through the manager. No reply is returned. Use for FYI messages only.

### Loop Prevention

Triggered messages (from schedules, heartbeats) include a `noAutoReply` flag. When set, the agent's response is stored in its own news feed rather than auto-replying to the sender. This prevents infinite loops.

## XMTP Messaging Subsystem

Each agent can optionally run an XMTP client for end-to-end encrypted messaging with external agents and users.

### Components

| File | Purpose |
|------|---------|
| `src/xmtp/xmtp-messaging.ts` | Core messaging class — inbound/outbound handling, sender allowlist, ENS resolution, approval callbacks |
| `src/xmtp/ows-signer.ts` | OWS-backed XMTP signer — delegates all signing to `ows sign message`, private key never leaves vault |
| `src/agent-rest-server.ts` | Per-agent XMTP lifecycle entry point, `/xmtp/send` and `/xmtp/status` endpoints |
| `skills/xmtp/SKILL.md` | Agent skill for sending XMTP messages via curl |

### Architecture

```
┌─────────────────────────────────────────┐
│             Agent Process               │
│                                         │
│  ┌──────────────┐   ┌───────────────┐   │
│  │  Express API  │   │ XmtpMessaging │   │
│  │              │   │               │   │
│  │ /xmtp/send ──┼──▶│ sendMessage() │   │
│  │ /xmtp/status │   │               │   │
│  │              │   │ handleInbound()│──▶│──▶ startQuery() ──▶ LLM
│  └──────────────┘   │               │   │
│                     │  OWS Signer   │   │
│                     │  Allowlist    │   │
│                     └───────┬───────┘   │
│                             │           │
└─────────────────────────────┼───────────┘
                              │
                    ┌─────────▼─────────┐
                    │   XMTP Network    │
                    │  (MLS encrypted)  │
                    └───────────────────┘
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/xmtp/send` | POST | Send encrypted message to ENS name or wallet address |
| `/xmtp/status` | GET | Check if XMTP is enabled, get agent's wallet address |

### Startup

XMTP starts automatically during agent boot when an OWS wallet is available (`OWS_WALLET` env var). The startup sequence:

1. Dynamic `import()` of `xmtp-messaging.ts` (avoids loading native bindings when XMTP not configured)
2. Create `XmtpMessaging` instance with OWS wallet signer
3. Set up data directory at `~/.xmtp/{address}/`
4. Load persisted allowlist from `allowlist.yaml`
5. Load or auto-generate DB encryption key (`db.key`)
6. Set message handler that routes inbound messages through `startQuery()` with `noAutoReply: true`
7. Start XMTP agent and begin listening

### Data Storage

XMTP data is stored at `~/.xmtp/{address}/` (outside project repos):

| File | Purpose |
|------|---------|
| `{env}.db3` | Encrypted MLS database (message history, conversation keys, identity) |
| `db.key` | Auto-generated DB encryption key (mode 0600), persists across restarts |
| `allowlist.yaml` | Sender allowlist with addresses and optional ENS names |

### Security Model

**Sender allowlist (3-tier):**
- **Trusted** — on the allowlist, auto-accepted, bypasses approval callback
- **Unknown** — not on the allowlist; goes through approval callback (or dropped if closed mode)
- **Blocked** — not on allowlist when in closed mode; silently dropped before content reaches agent LLM

**Closed by default:** agents reject messages from unknown senders unless `openMode: true` is set in config.

**Inbound message isolation:** XMTP messages are formatted with a clear boundary marker before reaching the LLM, and `noAutoReply: true` prevents reply loops.

### ENS Resolution

Outbound messages resolve ENS names in two steps:
1. `id-cli info` for `.xid.eth` names (CCIP-Read gateway)
2. `web3.bio` fallback for all other ENS names

## Per-Agent Environment

The manager sets these environment variables for every spawned agent:

| Variable | Description |
|----------|-------------|
| `ID_AGENT_PORT` | Agent's own REST-AP port |
| `ID_AGENT_NAME` | Agent name |
| `ID_AGENT_ALIAS` | Agent alias (same as name) |
| `ID_TEAM` | Team name |
| `MANAGER_URL` | Manager base URL |

Each agent can also have its own `.env.<name>.<address>` file in the repo root containing a `PRIVATE_KEY` for the agent's own use. The manager loads this file when spawning the agent and merges it into the process environment.

## Port Map

| Component | Port | Description |
|-----------|------|-------------|
| Interactive CLI | none | Pure client terminal UI; no local HTTP listener |
| Manager | 4100 | Main API, `/remote` endpoint, agent registry |
| Agents | 4101+ | Dynamic per-team range (25 ports per team) |
