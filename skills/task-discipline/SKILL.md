---
name: task-discipline
description: Required lifecycle for non-trivial work. Create a task, claim it, do the work, mark done. Include the task name in your reply.
---

> **Note:** For idchain agents, these rules are also injected via `defaults.claudeMd` in
> `configs/idchain.yaml`, so the lifecycle is always in context without invoking this skill.
> This file is kept as reference documentation and for non-idchain agents that load the skill explicitly.

# Task Discipline

You treat every non-trivial request as a first-class task in the manager's /tasks system.
The task lifecycle is mandatory for any multi-step work or work that produces an artifact.

## When a task is required

- Implementing a feature, writing a report, running an analysis, verifying a change
- Anything taking more than one round of work
- Anything that produces an artifact in ./output/

## When a task is NOT required

- Single-line answers, greetings, simple look-ups
- Work that is already part of an existing task you claimed

## Assigned work vs self-initiated work

There are **two** ways a task lifecycle starts. Treat them differently — the
single most common discipline failure is creating a duplicate task when one
has already been dispatched to you.

### Assigned work (someone delegated to you)

If you received a dispatch brief that names a task — i.e. the message
contains `task: <name>` plus explicit claim/done URLs (see the
`inter-agent` skill, section "Dispatch brief template") — the manager
**already created the task**. Do **not** create a new task.

Use the brief's URLs verbatim:

1. `POST <claim URL>` with `{"agent_id": "<your-name>"}` — flips to `doing`.
2. Do the work.
3. `POST <done URL>` with `{"agent_id": "<your-name>"}` — flips to `done`.
4. Reply citing the assigned task name.

If you create a parallel task under a slightly different name, the
dispatcher's checkin keeps firing against the original (now-phantom)
row, the dispatcher cannot tell the work landed, and acceptance does
not roll up. Use the assigned name **verbatim**.

### Self-initiated work (you discovered it)

If you found work that needs doing during a heartbeat, review, or
ordinary flow — and nobody dispatched a brief — follow the full
lifecycle below: create → claim → do → done.

## The lifecycle

Send `-H "X-Id-Team: $ID_TEAM"` on every call (`$MANAGER_URL` and `$ID_TEAM` are in
your environment). Without it the manager guesses your team from your name, which
fails when the same name exists in several teams. `<name>` may also be the task's
uuid or `#shortId`.

1. Create: `POST $MANAGER_URL/tasks` with `{title, name, from: <your-name> }`
2. Claim: `POST $MANAGER_URL/tasks/<name>/claim` with `{agent_id: <your-name> }` (status flips to `doing`)
3. Do the work. Write artifacts to `./output/` in your working directory.
4. Complete: `POST $MANAGER_URL/tasks/<name>/done` with `{agent_id: <your-name> }` (status flips to `done`)
5. Reply to the requester: include the task name, e.g. `Done. Task: implement-x. Output: ./output/report.md`

## If work fails

Mark the task done with a failure note in the reply. Do not leave it in `doing`.
Other agents reading the task stream need to see the terminal state, even if it is failure.

## Naming

Use kebab-case for task names: `implement-feature-x`, `audit-contracts-sept`, `review-pr-42`.
Avoid reserved command verbs (delete, deploy, sync, etc.) which will be rejected by the validator.

## Why this matters

A verifier agent walking the task stream can see every unit of work, every artifact, every completion or failure, but only if every agent uses the system. Your discipline is what makes the team auditable.

## Orphan cleanup notes

If you're running a cleanup pass and need to close a checkin or task
that should not block acceptance because a different agent's task
already covers the same work, write the close note in this **exact**
format:

```
closed-by-cleanup: see <implementer-task-name> (uuid <short>)
```

Where `<short>` is the implementer's `shortId` (e.g. `#7b03a518`). The
format is greppable from the task stream so the next pass can
reconstruct which row absorbed the closed work without having to walk
event logs.

## Future hardening (deferred — not in this slice)

Manager-side duplicate-task rejection — refusing `POST /tasks` when a
dispatch has already created a task for the same logical unit of work
— is a known followup. Until that lands, dispatchers and implementers
prevent duplicates manually by:

- Dispatchers including `task: <name>` and explicit claim/done URLs
  in every brief (see `inter-agent` skill, "Dispatch brief template").
- Implementers using the assigned task name **verbatim** (see
  "Assigned work vs self-initiated work" above).

## See also

The `inter-agent` skill describes **checkins**, a complementary primitive for supervising delegated tasks. When you delegate work to another agent via `/talk-to` with a `task: {title, name}` field, the manager creates the task and an active checkin watching it; the checkin auto-closes when the task hits a terminal state. If you load `task-discipline` without `inter-agent`, you have your own task lifecycle but no built-in supervision for work you delegate. See `skills/inter-agent/SKILL.md`, section "Checkins (work supervision)".
