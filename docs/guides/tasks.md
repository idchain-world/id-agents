# Task Tracking with `/task`

The `/task` system provides a shared todo/doing/done board that agents and operators can use to coordinate work. Tasks are assignable, queryable by status, and visible across the team.

## Core Workflow

1. **Discover work** — create a task with a title and optional description
2. **Claim work** — assign the task to an agent
3. **Complete work** — mark the task done when finished

```bash
# Operator creates a task
/task create "Audit auth middleware" --team lesen

# Assign to an agent
/task assign audit-auth-middleware security-reviewer

# Agent marks it done when finished
/task done audit-auth-middleware
```

## Task Lifecycle

| Status | Meaning |
|--------|---------|
| `todo` | Created but not claimed |
| `doing` | Claimed by an agent, work in progress |
| `done` | Completed |

## Querying Tasks

```bash
# List all tasks
/task list

# Filter by status
/task list --status todo
/task list --status doing

# Filter by owner
/task list --owner coder

# Filter by team
/task list --team lesen
```

## The Handoff Pattern

One agent creates tasks with specs; another claims and completes them.

```
analyst    → /task create "Implement retry logic for API client"
              (includes spec in description)

coder      → /task list --status todo
              finds the task, reads the spec
           → /task assign implement-retry-logic coder
              claims it
           → (does the work)
           → /task done implement-retry-logic
```

A verifier agent can walk stale tasks periodically to catch work that stalled in `doing` or was never claimed.

## Making It Required

The `task-discipline` skill enforces the task lifecycle as mandatory for any multi-step work. When an agent has this skill, it will automatically create, claim, and complete tasks for non-trivial requests.

**Add to all agents via config defaults:**

```yaml
defaults:
  skills:
    - identity
    - inter-agent
    - catalog
    - wallet
    - task-discipline
```

**Opt an individual agent out** by overriding its skills list without `task-discipline`:

```yaml
agents:
  - name: simple-bot
    skills: [identity, inter-agent, catalog]
```

See `skills/task-discipline/SKILL.md` for the exact contract agents follow: when tasks are required, the create/claim/done lifecycle, naming conventions, and failure handling.

## Stale Task Verifier

A simple script that lists stale `todo` tasks and long-running `doing` tasks. Useful as a scheduled check.

```bash
#!/bin/bash
# verify-tasks.sh — find stale work items
MANAGER="http://localhost:4100"
API_KEY="${ID_REMOTE_API_KEY}"
NOW=$(date +%s)
STALE_HOURS=24
STALE_THRESHOLD=$((NOW - STALE_HOURS * 3600))

# Fetch all tasks
TASKS=$(curl -s "$MANAGER/remote" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"command": "/task list"}' | jq -r '.result // empty')

if [ -z "$TASKS" ]; then
  echo "No tasks found."
  exit 0
fi

echo "=== Stale TODOs (unclaimed > ${STALE_HOURS}h) ==="
echo "$TASKS" | jq -r \
  --argjson threshold "$STALE_THRESHOLD" \
  '.[] | select(.status == "todo" and (.created_at / 1000) < $threshold) |
   "  \(.title) — created \(.created_at | . / 1000 | strftime("%Y-%m-%d %H:%M"))"'

echo ""
echo "=== Long-running DOING (in progress > ${STALE_HOURS}h) ==="
echo "$TASKS" | jq -r \
  --argjson threshold "$STALE_THRESHOLD" \
  '.[] | select(.status == "doing" and (.updated_at / 1000) < $threshold) |
   "  \(.title) — owned by \(.owner // "unassigned") — last update \(.updated_at | . / 1000 | strftime("%Y-%m-%d %H:%M"))"'
```

## Why Tasks Beat Folder-Based Tracking

- **Queryable**: filter by status, owner, team — no directory walking
- **Atomic transitions**: `todo` -> `doing` -> `done` with timestamps
- **Cross-agent visibility**: any agent can see all tasks without filesystem access
- **Auditable**: task history is in the database, not scattered across files
- **Schedulable**: pair with calendar events to auto-create recurring tasks

## Related

- [Agent Outputs](./agent-outputs.md) — standardized output directory for artifacts
- [News Feed](./news-feed.md) — message channel for fire-and-forget notifications
- [Sync Command](./sync-command.md) — `/sync` is REMOVED; what replaced it
