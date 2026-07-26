---
name: idagents-team-builder
description: Build an id-agents team correctly from scratch. Covers YAML structure, per-agent workspaces, role files, library agent templates, skill bundling, and the gotchas (silent default drops, symlinks vs copies, cpSync collisions). Use whenever you are designing a new team config, adding agents to an existing team, or debugging why an agent ended up with a generic personality.
---

# ID Agents Team Builder

How to build an id-agents team that actually works. Distilled from real-world team builds that hit every avoidable footgun.

## When to use

- Designing a new team config under `configs/<team>.yaml`.
- Adding agents to an existing team and wondering "where does the role come from".
- An agent deployed but has no unique personality (just framework boilerplate).
- An agent is supposed to have specialist skills but only has the defaults.
- A deploy fails with `EEXIST` from `cpSync`.
- Multiple agents are stepping on each other's `CLAUDE.md`.

## The seven rules

These come from rebuilding the same team three times to get it right.

### 1. `workingDirectory` MUST be per-agent. Defaults are silently dropped.

`defaults.workingDirectory` in the YAML is not merged into each agent. The config parser only merges `runtime`, `model`, `plugins`, `skills`, `allowedTools`, and `resources` from defaults (see `mergeDefaults` in `src/config-parser.ts`). If you put `workingDirectory` in `defaults`, every agent falls back to `<workspace>/agents/<agent-id>/` and the parser cannot find their role files.

Always set `workingDirectory` explicitly per agent:

```yaml
agents:
  - name: cso
    workingDirectory: /Users/me/projects/security/agents/cso
    description: "..."
  - name: security-stack-a
    workingDirectory: /Users/me/projects/security/agents/security-stack-a
    description: "..."
```

### 2. Role files are read from `<workingDirectory>/.claude/agents/<name>.md` at deploy time.

The parser calls `loadSubAgentTemplate(workingDirectory, name, runtime)`. Two patterns are accepted, directory wins over single-file:

- **Directory pattern**: `<wd>/.claude/agents/<name>/CLAUDE.md` (priority)
- **Single-file pattern**: `<wd>/.claude/agents/<name>.md`

Whichever the parser finds, its body (everything after the frontmatter) becomes `roleBody`. The framework appends roleBody to its boilerplate (scheduling, task discipline, output convention) and writes the combined personality to `<wd>/.claude/CLAUDE.md` at spawn time.

If `workingDirectory` is unset (see rule 1) the parser returns early and no role is loaded. The agent gets framework boilerplate only and acts identical to every other underspecified agent in the team.

### 3. Each agent owns its workspace. No shared `workingDirectory`.

The framework writes per-agent personality to `<wd>/.claude/CLAUDE.md`. If two agents share a `workingDirectory`, they overwrite each other's CLAUDE.md as they spawn. Last writer wins. Every other agent ends up with the wrong personality.

Give each agent its own directory. The portfolio pattern: a parent umbrella project with per-agent subdirs.

```
my-security/
├── .claude/agents/       # canonical role files (optional, for Claude-Code-subagent mode)
│   ├── cso.md
│   ├── cso/CLAUDE.md
│   └── ...
└── agents/               # per-agent workspaces for the daemon team
    ├── cso/
    │   └── .claude/agents/cso.md
    ├── security-stack-a/
    │   └── .claude/agents/security-stack-a.md
    └── ...
```

### 4. No symlinks in the per-agent workspace. Copy real files.

The deploy uses `cpSync(srcDir, destDir, {recursive, force})` to overlay agent dir contents. If your role file or context dir is a relative symlink, cpSync creates a symlink at the destination pointing to the resolved target. If that destination already exists as a real directory, the deploy fails with `EEXIST: file already exists, symlink 'target' -> 'destination'`.

Always copy. Never symlink.

```bash
# WRONG
ln -s ../../../../.claude/agents/cso.md agents/cso/.claude/agents/cso.md

# RIGHT
cp .claude/agents/cso.md agents/cso/.claude/agents/cso.md
```

Acceptable duplication: if you also keep canonical role files at `idx-security/.claude/agents/`, you have two copies. They drift if you edit one without the other. Live with it, or regenerate with a script when role files change.

### 5. Library agent templates compose with custom roles.

`agent: <template-name>` in an agent's YAML pulls a library template (from `configs/agents/<template>/`) into the agent's workspace. The deploy calls `copyLibraryAgentOverlay`:

- Template's `CLAUDE.md` goes to `<wd>/.claude/rules/agent-<template>.md` (sidecar, NOT overwriting your custom role).
- Template's bundled `skills/` get merged into `<wd>/.claude/skills/`.

So you keep your custom role at `<wd>/.claude/agents/<name>.md`, and the library template provides extra skills + reference rules on the side.

Available templates today (under `configs/agents/`): `security`, `solidity-security`, `pashov-solidity-security`, `foundry-dev`, `frontend`, `frontend-react`, `fullstack-nextjs`, `devops`, `editor`, `copywriter`. Inspect each template's `skills/` to see what it adds.

### 6. Skills come from three sources and merge in the agent's `.claude/skills/`.

- **Bundled framework skills** (`<id-agents>/skills/`): `identity`, `inter-agent`, `catalog`, `task-discipline`, `wallet`, `xmtp`, etc. Listed in `defaults.skills` or per-agent `skills:`. Deploy copies them via `deploySkillsToAgent`.
- **Library template skills** (`configs/agents/<template>/skills/`): bundled with the template. Pulled in by `agent: <template-name>`.
- **Per-agent custom skills**: drop a directory at `<wd>/.claude/skills/<skill-name>/` with a `SKILL.md`. The agent owns it.

The per-agent skill copy is **a full copy at deploy time**. Each agent owns its skills and can modify them independently. Edits do not affect other agents and do not get clobbered on `/agents rebuild` (rebuild restarts existing agents from DB; it does not re-overlay).

`/deploy <team>` re-overlays skills, but it is CREATE-ONLY — it refuses an existing team, so it can no longer clobber a live one. `/sync` is REMOVED. Per-agent skill edits survive `/agents rebuild`. If an agent has customizations worth keeping, fold them back into a library template.

### 7. Structure: defaults + org + agents.

```yaml
version: "1"
team: <team-name>

# Inherited by every agent EXCEPT workingDirectory (rule 1).
defaults:
  local: true
  runtime: claude-code-cli
  model: claude-opus-4-7
  dangerouslySkipPermissions: true
  skills:
    - identity
    - inter-agent
    - catalog
    - task-discipline

# Optional org chart — drives ORG_CHART.md and inter-agent routing hints.
org:
  groups:
    leadership:
      lead: <lead-name>
      description: "..."
      members: [<lead-name>]
    workers:
      description: "..."
      members: [worker-a, worker-b, ...]
  tags:
    some-tag: [agent-name, ...]

# Each agent: required name + workingDirectory. Plus optional fields.
agents:
  - name: lead
    workingDirectory: /absolute/path/to/agents/lead
    agent: <library-template>          # optional, brings extra skills + rules sidecar
    description: "What this agent does in one sentence."
    model: claude-opus-4-7              # overrides defaults.model
    runtime: codex                      # overrides defaults.runtime
    heartbeat: 86400                    # optional, seconds between scheduled wake-ups
    catalog:                            # advertised to peers via /catalog
      role: lead/orchestrator
      description: "..."
      expertise: [...]
      costTier: high | medium | low
      notSuitableFor: [...]
      status: available
```

## Architecture patterns

Two patterns earn their keep. Both work; pick by team size and breadth.

### Lead + workers (small teams)

A single lead orchestrates 2-N workers, breaks tasks down, reviews output. Workers implement.

```
lead         ← claude-opus-4-7, orchestrator
├── dev      ← claude-sonnet-4-6, implementer
└── scout    ← claude-sonnet-4-6, research
```

Three agents. Lead's catalog: `role: lead/orchestrator, notSuitableFor: ["direct code edits"]`.

### CSO + stack agents + concern specialists (portfolio teams)

For security or QA across multiple product stacks. Lead does triage and prioritization, stack agents do continuous coverage per product, specialists are deep-dive helpers pulled in on demand.

```
cso                                ← coordinator only
├── security-stack-a               ← covers product A's repos
├── security-stack-b               ← covers product B's repos
├── ...
├── concern-specialist-1           ← deep-dive on axis 1 (e.g. web, gateway)
├── concern-specialist-2           ← deep-dive on axis 2
└── ...
```

12 agents. CSO's catalog: `role: lead/orchestrator, notSuitableFor: ["direct code edits", "single-axis deep-dive (delegate to specialist)"]`. Specialists' catalog: `role: specialist, notSuitableFor: ["broad cross-stack review"]`.

Single chain of command: when a stack agent owns a finding, the CSO routes specialists through them rather than going direct. Otherwise specialists answer to multiple masters and findings get duplicated.

## Step-by-step new team build

```bash
# 1. Pick a parent dir for the team.
PARENT=/Users/me/projects/my-security

# 2. Create per-agent workspaces with role files.
for name in lead worker-a worker-b; do
  mkdir -p "$PARENT/agents/$name/.claude/agents"
  # Write role .md with frontmatter + body. See "Role file template" below.
  cat > "$PARENT/agents/$name/.claude/agents/$name.md" <<EOF
---
name: $name
description: "..."
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(read-only commands like ls, cat, find, git log, git diff)
  - Task
  - SendMessage
---

# $name

(role body — what this agent does, what it reads, what it writes)
EOF
done

# 3. Write configs/<team>.yaml. See "Structure: defaults + org + agents" above.

# 4. Deploy.
curl -s -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"executor":"operator","command":"/deploy <team>"}' | jq

# 5. Verify.
curl -s http://localhost:4100/agents -H "X-Id-Team: <team>" | \
  jq '.agents[] | {name, status, workingDirectory}'

# 6. Inspect that role bodies actually got injected.
head -40 "$PARENT/agents/lead/.claude/CLAUDE.md"
# Should show framework boilerplate followed by your role body.
```

## Role file template

```markdown
---
name: <agent-name>
description: One-sentence description for the catalog and the help view.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(read-only commands like ls, cat, find, git log, git diff)
  - Task
  - TaskCreate
  - TaskUpdate
  - TaskGet
  - TaskList
  - SendMessage
  - WebFetch
  - WebSearch
---

# <Role Title>

Brief paragraph: what this agent owns, who it reports to, who reports to it.

## Role

1. **<Verb>** — first responsibility.
2. **<Verb>** — second responsibility.
3. **<Verb>** — third.
4. **<Verb>** — fourth.

## Scope

| In-Scope | Path / Topic |
|----------|--------------|
| <name>   | /absolute/path/to/repo |

## Key Risks / Concerns To Watch

- Item 1.
- Item 2.

## Workflow

1. Read MEMORY.md for prior state.
2. Check `git log --since` for recent changes in scope.
3. Do the work. Pull specialists when needed via `/talk-to` or Task.
4. Write findings to `reports/<scope>/`.
5. Update MEMORY.md.

## Rules

- Read-only across in-scope repos.
- May update reports/, SYSTEMS.md, and files in your own `.claude/` workspace.
- Escalate CRITICAL / HIGH findings.
```

## Common failure modes (diagnose by symptom)

| Symptom | Cause | Fix |
|---------|-------|-----|
| `deployed: 0 failed: N` with `EEXIST` symlink errors | Role file is a symlink, cpSync collision | Replace symlinks with real file copies |
| All agents have identical personality | `workingDirectory` in defaults (silently dropped) | Set `workingDirectory` per agent |
| Agent has no specialist skills | Missing `agent: <template>` or wrong skill name | Add the template OR list the bundled skill in `skills:` |
| Agent's `.claude/CLAUDE.md` only has framework boilerplate | Parser couldn't find role file at `<wd>/.claude/agents/<name>.md` | Verify path, check rule 2 |
| `Manager did not start in time` after deploy | Manager crashed or port collision | See `idagents-admin-control` skill's "Restarting the manager" section |
| `[REST-AP] Could not fetch catalog from http://localhost:0` | Manager-inbox row probed as if it were a worker | Harmless; silenced in 0.1.93-beta. Real agents have non-zero ports. |
| Agent role says "read .claude/agents/<name>/CLAUDE.md" but file isn't there | Role brief references the directory-pattern context file but you used single-file pattern | Either move detail into the .md body (single-file) or switch to directory pattern |

## Quick reference: deploy verbs

| Command | Effect | When to use |
|---------|--------|-------------|
| `/deploy <team>` | Nuke and recreate from YAML | First time, or after major restructuring |
| `/diff <team> <config>` | Report drift between the database and a config. READ-ONLY — changes nothing | Any time you want to see divergence |
| `/agents spawn`, `/agents remove`, `/model` | Change a live team | The database is the source of truth |
| `/export <team> [path]` / `/import <file> [--team <name>]` | Write a config from the database / create a NEW team from one | Backup, clone, migrate |
| `/agents <team> rebuild` | Restart existing agents from DB. Does NOT re-overlay | Cycling agents without losing their per-agent skill customizations |
| `/agents <team> stop` | Stop agents (keep DB rows) | Pausing work |
| `/agents <team> start` | Start stopped agents | Resuming |
| `/delete --team <team>` | Delete every agent in the team. Team row drops when last agent leaves | Teardown before a clean redeploy |

## Anti-patterns

- **`defaults.workingDirectory`** — silently ignored. Don't use it. See rule 1.
- **Symlinks in agent workspaces** — break `cpSync`. See rule 4.
- **Shared `workingDirectory` across agents** — CLAUDE.md collision. See rule 3.
- **Agent name collides with reserved word** (`manager`, etc.) — rejected at parse time.
- **Per-agent `output/` overwriting another agent's `output/`** — only a risk if you violated rule 3.
- **Custom role at `<wd>/.claude/CLAUDE.md`** — gets overwritten by the framework at spawn. Put roles at `<wd>/.claude/agents/<name>.md` and let the framework merge.

## See also

- `idagents-admin-control` — programmatic team management (export/import, rebuild, dispatch, restart).
- `id-agents/configs/agents/` — library agent templates and their bundled skills.
- `id-agents/src/config-parser.ts` — source of truth for what the parser actually does (`mergeDefaults`, `loadSubAgentTemplate`, `copyLibraryAgentOverlay`).
