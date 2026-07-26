# Configuration Reference

ID Agents supports YAML-based configuration files for defining agent deployments and team settings.

## Configuration File Format

```yaml
version: "1.0"
team: my-team

parameters:
  - name: environment
    default: development

defaults:
  runtime: claude-code
  model: claude-haiku-4-5-20251001
  skills:
    - identity
    - inter-agent
    - catalog

calendar:
  - title: Daily standup prep
    time: "09:00"
    timezone: America/New_York
    days: [mon, tue, wed, thu, fri]
    agents: [coder, researcher]
    message: Prepare daily updates and blockers
    delivery: talk

agents:
  - name: coder
    model: claude-sonnet-4-20250514
    heartbeat: 300  # seconds — agent reads HEARTBEAT.md checklist
  - name: researcher
    systemPrompt: "You are a research specialist."
```

## Top-Level Fields

### version

**Required:** Yes
**Type:** String

Configuration file format version. Currently `"1.0"`.

```yaml
version: "1.0"
```

### team

**Required:** No
**Type:** String
**Default:** `default`

Team/namespace name for the deployment. Agents will be created in this team.

```yaml
team: my-project
```

### parameters

**Required:** No
**Type:** Array of Parameter objects

Define parameters that can be substituted throughout the config using `${name}` syntax.

```yaml
parameters:
  - name: environment
    default: development
  - name: model_tier
    default: haiku
```

Usage:
```yaml
agents:
  - name: worker-${environment}
    model: claude-${model_tier}-4-5-20251001
```

#### Parameter Object

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Parameter name |
| `default` | No | Default value if not provided |
| `description` | No | Human-readable description of the parameter |

### defaults

**Required:** No
**Type:** Defaults object

Default settings applied to all agents unless overridden.

```yaml
defaults:
  runtime: claude-code-cli
  model: claude-haiku-4-5-20251001
  skills:
    - identity
    - inter-agent
    - catalog
```

All configs should include `skills: [identity, inter-agent, catalog]` at minimum.

#### Defaults Object

| Field | Type | Description |
|-------|------|-------------|
| `runtime` | String | Default agent runtime (`claude-agent-sdk`, `claude-code-cli`, `claude-code-local`, `codex`, `cursor-cli`) |
| `model` | String | Default LLM model |
| `skills` | Array | Skills deployed to each agent (minimum: `[identity, inter-agent, catalog]`) |
| `plugins` | Array | Optional plugins for agent runtimes that support them |
| `allowedTools` | Array | Default tool restrictions for all agents |
| `heartbeat` | Number or Object | Default heartbeat interval in seconds (or legacy `{interval, message}` object) |
| `wallet` | Boolean | Default OWS wallet opt-in for all agents |

### calendar

**Required:** No
**Type:** Array of Calendar objects

Top-level wall-clock schedules. Use this for one-off dated events or recurring local-time events that target one or more agents.

```yaml
calendar:
  - title: Daily standup prep
    time: "09:00"
    timezone: America/New_York
    days: [mon, tue, wed, thu, fri]
    agents: [coder, researcher]
    message: Prepare daily updates and blockers
    delivery: talk
```

#### Calendar Object

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Human-readable schedule title |
| `time` | Yes | Local wall-clock time in `HH:MM` or `HH:MM:SS` |
| `timezone` | No | IANA timezone; defaults to the host timezone |
| `date` | Conditionally | One-off local date in `YYYY-MM-DD` |
| `days` | Conditionally | Recurring weekdays such as `[mon, wed, fri]` |
| `agents` | Yes | Target agent names/refs |
| `message` | No | Message delivered to the target agents |
| `description` | No | Human-readable description |
| `catchUpPolicy` | No | `skip` or `fire_once` |
| `delivery` | No | `talk` or `internal` |

Exactly one of `date` or `days` must be provided.

### agents

**Required:** Yes
**Type:** Array of Agent objects

List of agents to deploy.

```yaml
agents:
  - name: coder
    model: claude-sonnet-4-20250514
  - name: researcher
    runtime: codex
```

---

## Agent Configuration

Each agent can have the following fields:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | - | Agent name (must be unique within team) |
| `description` | No | - | Human-readable description of the agent |
| `model` | No | From defaults | LLM model to use |
| `runtime` | No | From defaults | Agent runtime/harness |
| `systemPrompt` | No | - | Custom system prompt |
| `skills` | No | From defaults | Standalone skill library entries. Peer to `agent:`; merged with defaults and overlaid after the agent entry |
| `plugins` | No | From defaults | Optional plugins for runtimes that support them |
| `allowedTools` | No | From defaults | Restrict agent to specific tools |
| `env` | No | `{}` | Environment variables for the agent process |
| `wallet` | No | From defaults | Opt in to OWS wallet provisioning at deploy/spawn |
| `workingDirectory` | No | - | Working directory for the agent process |
| `agent` | No | - | Library agent entry name. Resolves to `configs/agents/<name>/` (Claude-native) or the `configs/agents/<name>.md` + `configs/agents/<name>/` sibling pair (AGENTS.md-native), and deploys to the runtime-aware overlay target before `skills` are applied |
| `heartbeat` | No | - | Heartbeat interval in seconds, or legacy `{interval, message}` object |
| `openMode` | No | `false` | Accept XMTP messages from any sender (not recommended for production) |

### Agent Example

```yaml
agents:
  - name: lead-developer
    model: claude-sonnet-4-20250514
    runtime: claude-code-cli
    systemPrompt: |
      You are a senior software developer.
      Focus on code quality and best practices.
    skills: [identity, inter-agent, catalog, wallet]
    heartbeat: 300
    wallet: true
```

### Agent Library Example

`agent:` and `skills:` are peer fields on the agent entry. `agent:` selects one library agent entry. `skills:` selects zero or more standalone skill entries that overlay on top after the agent entry deploys.

```yaml
defaults:
  skills: [identity, inter-agent, catalog]

agents:
  - name: auditor
    runtime: codex
    workingDirectory: /path/to/project
    agent: solidity-security
    skills: [using-foundry, task-discipline]
```

### heartbeat

Agent-level recurring scheduling shorthand. This compiles into an internal `interval` schedule targeting that one agent.

**New model (recommended):** Set `heartbeat` to a plain number (seconds). The scheduler sends a generic wake-up message and the agent reads its own `HEARTBEAT.md` checklist from the working directory root. If nothing needs attention, the agent responds with `HEARTBEAT_OK` and the response is silently suppressed from the news feed.

```yaml
agents:
  - name: coder
    heartbeat: 86400  # daily, in seconds
```

Create a `HEARTBEAT.md` in the agent's template directory (`.claude/agents/{name}/HEARTBEAT.md`). It is copied to the working directory root at spawn time.

**Legacy model:** An object with `interval` and `message` still works. The scheduler sends the configured message directly.

```yaml
agents:
  - name: coder
    heartbeat:
      interval: 300
      message: Review open PRs and summarize risks
      delivery: internal
```

#### Heartbeat Object (legacy)

| Field | Required | Description |
|-------|----------|-------------|
| `interval` | Yes | Recurrence interval in seconds |
| `message` | Yes | Message delivered on each run |
| `maxBeats` | No | Maximum successful runs before the schedule stops |
| `expiresAfter` | No | Number of seconds after activation before the schedule expires |
| `delivery` | No | `talk` or `internal` |

Defaults:
- `heartbeat.delivery` defaults to `internal`
- `calendar.delivery` defaults to `talk`

---

## Agent Library Entry

`agent` and `skills` are peers on each agent entry. `agent:` selects one library entry by name; `skills:` selects zero or more standalone skills.

```yaml
agents:
  - name: auditor
    workingDirectory: /path/to/project
    agent: security-audit
    skills: [using-foundry]
```

### Library root

The library root is resolved in this order:

1. `ID_LIBRARY_ROOT` env var when set and present on disk
2. `<cwd>/configs` when present
3. otherwise no library configured (entries resolve to empty)

Operators typically clone the [public-agents](https://github.com/idchain-world/public-agents) repo and point `ID_LIBRARY_ROOT` at its `configs/` directory.

### Native source shapes

`configs/agents/<name>/` accepts two first-class shapes. Discovery deduplicates by name; an accidental mixed-shape collision is a validation error.

**Claude-native** — folder containing `CLAUDE.md` plus optional `skills/`, `agents/`, `commands/`, `rules/`, `settings.json`, `hooks/`, `files/`. Discovered iff `<name>/CLAUDE.md` exists.

**AGENTS.md-native** — sibling pair `<name>.md` + `<name>/`, where `<name>.md` is the persona file and the directory holds extras (primarily `skills/`). Discovered iff both exist.

Standalone skills are always `configs/skills/<name>/SKILL.md`.

### Deploy semantics

At sync time, deploy is two-stage and **additive-only**:

1. **Step A** — copy the agent library entry into the workspace, mapping each source file through the runtime translation table (see [/sync guide](../guides/sync-command.md))
2. **Step B** — overlay each `skills:` entry on top, with last-writer-wins for same-named skills also bundled by the agent

A receipt at `<workspace>/.id-agents/receipt.json` tracks ownership per managed file. **No file the user owns is ever modified or deleted** — files whose on-disk SHA does not match the receipt are skipped with a warning. See the [/sync guide](../guides/sync-command.md) for the full 4-case ownership rule, per-runtime mapping, memory-file fallback, and `unsync` undeploy behavior.

## Skills Configuration

Skills are instruction packages deployed at deploy time via `deploySkillsToAgent`. The target directory is runtime-aware: `.claude/skills/` for Claude agents, `.agents/skills/` for Codex agents, `.cursor/skills/` for Cursor (`cursor-cli`) agents. Each skill is a directory containing a `SKILL.md` file with YAML frontmatter.

When both `defaults.skills` and agent-level `skills:` are present, the lists are merged and deduped. Agent-level `skills:` does not nest under `agent:` and does not replace the selected library entry.

All configs should include `skills: [identity, inter-agent, catalog]` at minimum. The built-in skills are: `identity`, `inter-agent`, `catalog`, `task-discipline`, `wallet`, `xmtp`, `idagents-admin-control`.

```yaml
defaults:
  skills: [identity, inter-agent, catalog, wallet, xmtp]

agents:
  - name: my-agent
    skills: [custom-skill]  # merged with defaults
```

Skills from defaults and per-agent lists are merged (deduped).

### XMTP Skill

The `xmtp` skill enables agents to send encrypted messages via the XMTP protocol. When included, agents can use `curl` to call `/xmtp/send` and `/xmtp/status` on their own port.

XMTP requires an OWS wallet (set via `OWS_WALLET` env var, auto-assigned at deploy). Data is stored at `~/.xmtp/{address}/` outside the project repo.

```yaml
defaults:
  skills: [identity, inter-agent, catalog, xmtp]

agents:
  - name: alice
    openMode: false  # default: reject messages from unknown senders
```

---

## Plugin Configuration

Plugins extend agent capabilities with additional tools and instructions.

### Plugin Object

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Plugin identifier |
| `path` | Yes | Path to plugin directory |

```yaml
plugins:
  - name: frontend-design
    path: plugins/claude-code/frontend-design
```

Plugins are copied to the agent's working directory at spawn time. Each agent owns its copy and can modify it.

---

## Process Configuration

Settings for agent processes.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `env` | Object | `{}` | Environment variables for the agent process |

```yaml
env:
  MY_VAR: "value"
  DEBUG: "true"
```

---

## Runtime Options

ID Agents supports multiple LLM runtimes (harnesses):

| Runtime | Description | Features |
|---------|-------------|----------|
| `claude-agent-sdk` | Claude Agent SDK | API-key runtime with session support |
| `claude-code-cli` | Claude Code CLI | CLI-auth runtime with session support |
| `claude-code-local` | Claude Code CLI local alias | Internal/local alias of `claude-code-cli` |
| `codex` | Codex CLI | OpenAI's coding agent |
| `cursor-cli` | Cursor Agent CLI | Non-interactive `cursor-agent` harness; install and auth per [Harnesses](./harnesses.md#cursor-cli-harness) (`curl https://cursor.com/install -fsS` then pipe to `bash`, `cursor-agent login`, or `CURSOR_API_KEY`) |

```yaml
defaults:
  runtime: claude-code-cli

agents:
  - name: agent-a
    runtime: claude-code-cli
  - name: agent-b
    runtime: codex
  - name: agent-c
    runtime: cursor-cli
    model: composer-2
```

Use `/deploy <config> --dry-run` or `/sync <config> --dry-run` to validate runtime/model/auth compatibility before any agents are created. To update a running team without losing sessions, use [`/sync`](../guides/sync-command.md) instead of `/deploy`.

---

## Model Options

Common model identifiers:

| Model | Description |
|-------|-------------|
| `claude-haiku-4-5-20251001` | Fast, efficient for simple tasks |
| `claude-sonnet-4-20250514` | Balanced capability and speed |
| `claude-opus-4-5-20251101` | Most capable, complex tasks |

```yaml
agents:
  - name: quick-worker
    model: claude-haiku-4-5-20251001
  - name: senior-dev
    model: claude-sonnet-4-20250514
```

---

## Parameter Substitution

Use `${name}` syntax to reference parameters defined in the config:

```yaml
parameters:
  - name: env
    default: dev
  - name: tier
    default: haiku

team: project-${env}

agents:
  - name: worker-${env}
    model: claude-${tier}-4-5-20251001
```

Parameters can be overridden at deploy time via CLI or API.

### Environment Variables

Use `${env:VAR_NAME}` syntax to reference environment variables:

```yaml
agents:
  - name: my-agent
    env:
      MY_SECRET: ${env:MY_SECRET_VALUE}
```

This keeps sensitive values out of config files. Set the variable in your `.env` file or shell environment:

```bash
export MY_SECRET_VALUE=some-secret
```

---

## Complete Example

```yaml
version: "1.0"
team: production-team

parameters:
  - name: model_tier
    default: sonnet

defaults:
  runtime: claude-code
  model: claude-haiku-4-5-20251001
  skills:
    - identity
    - inter-agent
    - catalog

calendar:
  - title: Daily standup prep
    time: "09:00"
    timezone: America/New_York
    days: [mon, tue, wed, thu, fri]
    agents: [lead, dev-frontend, dev-backend]
    message: Prepare daily updates and blockers
    delivery: talk

agents:
  # Lead developer
  - name: lead
    model: claude-${model_tier}-4-20250514
    systemPrompt: |
      You are the lead developer.
      Coordinate work and review code from other agents.
    heartbeat: 300

  # Standard developer
  - name: dev-frontend
    systemPrompt: "You specialize in React and TypeScript."

  # Standard developer
  - name: dev-backend
    systemPrompt: "You specialize in Node.js and databases."

  # Researcher with different runtime
  - name: researcher
    runtime: codex
    model: gpt-5.4
```

---

## Environment Variables

Configuration can also be provided via environment variables:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (not needed with Claude Max plan) |
| `CLAUDE_MODEL` | Default model override |
| `OPENAI_API_KEY` | Optional API key for Codex when not using `codex login` |
| `CURSOR_API_KEY` | Optional API key for Cursor when not using `cursor-agent login` |
| `DATABASE_URL` | PostgreSQL connection string |
| `ORCHESTRATOR_TYPE` | Agent runtime type |
| `PUBLIC_BASE_URL` | Public URL base for agents (e.g., `https://idbot.live`) |

**XMTP messaging:**

| Variable | Description |
|----------|-------------|
| `OWS_WALLET` | OWS wallet name for XMTP signing (per-agent, set automatically at deploy) |
| `XMTP_ENV` | XMTP network: `local`, `dev`, or `production` (default: `production`) |
| `WEB3_BIO_API_KEY` | API key for web3.bio ENS resolution (optional, used as fallback) |

XMTP starts automatically on agents that have an `OWS_WALLET` set. The DB encryption key is auto-generated per agent at `~/.xmtp/{address}/db.key`.

Environment variables take precedence over config file values for most settings.

**Per-agent environment (set automatically by the manager):**

| Variable | Description |
|----------|-------------|
| `ID_AGENT_PORT` | Agent's own REST-AP port (e.g., `4101`) |
| `ID_AGENT_NAME` | Agent name |
| `ID_AGENT_ALIAS` | Agent alias (same as name) |
| `ID_TEAM` | Team name |
| `MANAGER_URL` | Manager base URL (e.g., `http://localhost:4100`) |

---

## Config File Locations

ID Agents looks for configuration files in:

1. Path specified via CLI: `/deploy path/to/config.yaml`, `/import path/to/config.yaml`, or `/diff <team> path/to/config.yaml`
2. Team config: `configs/<team-name>.yaml`
3. Default config: `configs/default.yaml`

---

## Validation

Configuration files are validated on load. Common errors:

- Missing required `version` field
- Invalid `runtime` value
- Missing `name` in agents array
- Invalid `calendar.time`, `calendar.days`, or `calendar.delivery`
- Missing required `heartbeat.interval` or `heartbeat.message` (legacy object format)
- Invalid resource limit format
- Undefined parameter reference

### Name Validation

Team and agent names are validated at creation time. Names are rejected if they:

- Match reserved command verbs (`delete`, `deploy`, `sync`, etc.)
- Contain shell wildcards (`*`, `?`, `[`, `]`)
- Start with `-` or `--`
- Contain whitespace or control characters
- Are empty or exceed 64 characters

Existing teams and agents are grandfathered — validation is creation-time only.

### Team Deletion Safety

Deleting a team requires it to be empty first. Three explicit actions are required to fully wipe a team:

1. `/delete --team <name>` — delete all agents in the team
2. `/team delete <name>` — delete the team record
