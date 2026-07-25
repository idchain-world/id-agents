---
name: inter-agent
description: Communicate with other agents in your team — send messages, delegate tasks, list agents, check news. Use when asked to contact another agent or coordinate work.
allowed-tools: Bash
---

# Inter-Agent Communication

You are part of a multi-agent team. Communicate with other agents via `curl` from the Bash tool. Do **NOT** use SendMessage, Agent, or any built-in Claude Code messaging tools — those are a different system and will not reach your team agents.

## The three patterns — copy these exactly

There are three ways to reach another agent. Copy the example for your case verbatim and change only `to` and `message`.

### 1. `/talk-to` — sync delegation (you need the reply)

```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/talk-to \
  -H "Content-Type: application/json" \
  -d '{"to":"agent-name","message":"what is your name?"}'
```

Blocks until the recipient replies. The reply is in the response body.

### 2. `/news-to` without `trigger` — passive notification (LLM is NOT woken)

```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/news-to \
  -H "Content-Type: application/json" \
  -d '{"to":"agent-name","message":"I am ready for work"}'
```

Returns 202 immediately. The message lands in the recipient's news feed but their LLM is **not** woken. They see it the next time they poll `/news` or are otherwise active. Use for status pings, "I claimed this task", "heads up — restarting in 5".

### 3. `/news-to` with `"trigger":true` — async delegation (LLM IS woken)

```bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/news-to \
  -H "Content-Type: application/json" \
  -d '{"to":"agent-name","message":"I have a message, please pass it to the manager","trigger":true}'
```

Returns 202 immediately. The recipient's LLM **is** woken and processes the message as a new task. You do not get a reply on this HTTP call — the recipient can `/news-to` you back later with results. Use for telephone chains, long-running pipelines, and any handoff where holding a sync HTTP connection open would be wrong.

> ⚠️ **Critical: `trigger` is a literal boolean — copy the example above exactly.**
>
> When you want the recipient's LLM to actually process the message, the JSON body **MUST** include `"trigger":true` as a literal boolean (not a string, not omitted). Omitting the `trigger` field is a silent delivery failure: the message is stored in the recipient's news feed but the recipient **never processes it**. No error is returned — the call looks successful but the work never happens.
>
> If your intent is async delegation (pattern 3), the string `"trigger":true` **must** appear inside the JSON body. Copy the pattern-3 example above verbatim; do not reconstruct it from memory.

## When in doubt, use `/talk-to`

When you are not sure whether to use `/news-to` with `trigger:true` or `/talk-to`, **use `/talk-to`**. It blocks until the recipient replies, which is simpler to reason about for most cases — you get the answer back in-line and can continue your work. Only use `/news-to` with `trigger:true` when you specifically want async delegation: you don't need the reply in-line, but you do want the recipient to actually process the work.

Decision shortcut:
- Need the answer now to continue → `/talk-to` (pattern 1).
- Just telling somebody something → `/news-to` without `trigger` (pattern 2).
- Handing off work that may take minutes/hours and will be returned later → `/news-to` with `trigger:true` (pattern 3).

## Mandatory rule: when asked to "ask another agent"

If the user or manager says "ask coder …", "can you ask x …", or requests you to contact another agent:

1. You MUST use `/talk-to` (pattern 1) via curl and WAIT for their reply.
2. Include the reply in your response so the person who asked gets the answer.
3. Do NOT use SendMessage, Agent, or other built-in tools — use curl.

## Do not use `/message`

The old `/message` endpoint on the manager is **deprecated** — it responds with an `X-Deprecated` header and will be removed. Use `/talk-to` or `/news-to` on your local wrapper instead.

## How replies work (automatic)

**When someone sends you a message, your reply is sent automatically.** You do NOT need to run any curl command to reply.

1. Another agent sends you a message via `/talk-to` (which reaches you as `/talk`).
2. You process the message and generate your response.
3. Your response is automatically sent back to the sender.

**DO NOT** run curl against `/news` or `/news-to` to reply — your text output IS the reply.

## List available agents

```bash
curl -s $MANAGER_URL/agents -H "X-Id-Team: $ID_TEAM" | jq
```

The `name` field is the agent's full identifier (ENS domain after registration, or local name). Use this name as the `to` value when sending messages. The `url` field is the peer's REST-AP base URL — used by the catalog-aware selection flow below.

Both `/talk-to` and `/news-to` are exposed on your own local agent wrapper (`http://localhost:$ID_AGENT_PORT`). The wrapper looks up the target in the manager catalog and delivers the message.

## Choosing the right agent to delegate to

`/agents` only tells you **who exists**. It does not tell you who is the right peer for a given piece of work. Before `/talk-to` or `/news-to`, always run the catalog-aware selection flow.

### Step 1 — Enumerate peers

List candidates from the manager:

```bash
curl -s $MANAGER_URL/agents -H "X-Id-Team: $ID_TEAM" | jq '.agents[] | {name, alias, status, url}'
```

### Step 2 — BEFORE delegating, fetch each candidate's catalog

For every candidate from Step 1, GET `/catalog` and read `role`, `expertise`, `status`, `costTier`, and `notSuitableFor`. Do **not** rely on names or aliases alone:

```bash
# Single peer
curl -s http://localhost:<peer-port>/catalog | jq
```

```bash
# Manager-discovery substitution: resolve every peer's /catalog in one pass
for url in $(curl -s $MANAGER_URL/agents -H "X-Id-Team: $ID_TEAM" | jq -r '.agents[].url'); do
  echo "== $url =="
  curl -s "$url/catalog" | jq '{role, expertise, status, costTier, notSuitableFor}'
done
```

### Step 3 — Filter

Drop any candidate where:

- `status !== "available"` (e.g., `busy`, `offline`, `error`) — they cannot take new work.
- `notSuitableFor` lists a work pattern matching what you intend to delegate (e.g., your task is "production deploys" and the catalog says `"notSuitableFor": ["production deploys"]`).

### Step 4 — Rank and pick

Apply these rules in order:

1. **Prefer a specialist over a generalist** — a candidate whose `role`/`expertise` directly matches the task beats a generalist whose catalog only loosely overlaps.
2. **Prefer the lower `costTier`** when complexity allows — for well-scoped, low-risk work pick `low` over `medium` over `high` to conserve cost.
3. **Never assign to a `costTier: "low"` agent**:
   - multi-file schema changes,
   - security or key-handling work (wallets, signing, secret rotation, auth code),
   - routing-logic changes (manager dispatch, inter-agent skills, message broker code).
   These must go to `medium` or `high` even if a `low` agent is "available" — promote the work, do not downgrade it.

Only after a candidate survives Steps 3 and 4 do you send the actual `/talk-to` or `/news-to`.

> **Catalog-check before delegating** — list `/agents`, then GET each candidate's `/catalog` and apply the four-step flow above. Never pick a peer by name alone.

## Check your news feed

Your news feed contains incoming messages, conversation history, and task results. Poll with the `since_id` cursor for incremental updates:

```bash
# First poll — pick up everything new and save the returned next_since_id
curl -s "http://localhost:$ID_AGENT_PORT/news?since_id=0&limit=100" | jq

# Subsequent polls — pass the last id you saw
curl -s "http://localhost:$ID_AGENT_PORT/news?since_id=$LAST_ID&limit=100" | jq
```

The response includes `items[]` (ascending by id) and `next_since_id` when there is more to fetch. Each item carries an `id`, `type`, `timestamp`, `message`, and optional `data` / `query_id` / `kind` (`talk` or `notify`) / `reply_expected`.

The older `?since=<ms-timestamp>` cursor still works for one release but is deprecated — the response will include an `X-Deprecated` header. Prefer `since_id`.

Check your news feed before starting new tasks to maintain context.

## Task management

The manager has a dedicated `/tasks` API for coordinating work.

**Create a task** (when you discover work that needs doing):
```bash
curl -s -X POST $MANAGER_URL/tasks \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: $ID_TEAM" \
  -d '{"title": "Fix the overflow bug", "name": "fix-overflow", "from": "'$ID_AGENT_ALIAS'"}'
```

**Claim an unassigned task** (take responsibility for it):
```bash
curl -s -X POST $MANAGER_URL/tasks/fix-overflow/claim \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: $ID_TEAM" \
  -d '{"agent_id": "'$ID_AGENT_ALIAS'"}'
```

**Mark your task done** (when you finish):
```bash
curl -s -X POST $MANAGER_URL/tasks/fix-overflow/done \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: $ID_TEAM" \
  -d '{"agent_id": "'$ID_AGENT_ALIAS'"}'
```

**List tasks** (see what needs doing):
```bash
curl -s "$MANAGER_URL/tasks?status=todo" -H "X-Id-Team: $ID_TEAM" | jq
```

**Get a single task:**
```bash
curl -s "$MANAGER_URL/tasks/fix-overflow" -H "X-Id-Team: $ID_TEAM" | jq
```

Tasks have three statuses: `todo` (unclaimed), `doing` (someone is working on it), `done` (completed). When you find work during a review or heartbeat, create a task so it gets tracked.

## Dispatch brief template

When you delegate work that should become a manager task — i.e. an
async delegation via `/news-to` with `"trigger":true`, or a `/talk-to`
with `task: {title, name}` auto-attach — **always include both of the
following in the brief** so the implementer can claim and close the
lifecycle without having to construct URLs from memory:

1. `task: <name>` — the exact kebab-case task name the manager will
   create. Same name you pass in the `task: {title, name}` body field
   of `/talk-to` auto-attach (or post manually via `POST /tasks`).
2. **Explicit claim and done URLs**, pasted verbatim:

   ```
   claim URL: http://127.0.0.1:4100/tasks/<name>/claim
   done URL:  http://127.0.0.1:4100/tasks/<name>/done
   ```

Why both: the task name alone is greppable but does not unambiguously
tell the implementer which manager origin to address. The explicit
URLs survive paste into a different agent / different shell context
and remove any guesswork about route shape.

A complete dispatch brief looks like:

> Manager-approved slice 2 of foo. Task: implement-foo.
>
> Required explicit task URLs:
> - claim URL: http://127.0.0.1:4100/tasks/implement-foo/claim
> - done URL: http://127.0.0.1:4100/tasks/implement-foo/done
>
> Scope: …

Implementers MUST use the assigned task name **verbatim** — see the
`task-discipline` skill, section "Assigned work vs self-initiated
work". A parallel task under a different name leaves the dispatcher's
checkin firing against a phantom row.

> **Future hardening (deferred):** manager-side duplicate-task
> rejection — refusing `POST /tasks` when a dispatch has already
> created a task for the same logical unit of work — would catch the
> parallel-task mistake automatically. Not in scope for this slice;
> the dispatch-brief convention above is the manual guardrail.

## Checkins (work supervision)

> ⚠️ **MANDATORY: Every delegated task MUST have a checkin with a reasonable interval.** If you create a task via `/talk-to`, you MUST include BOTH `task: {title, name}` AND a tuned `checkin` interval. Skipping checkins is how work silently stalls. Skipping interval tuning is how you drown in false alarms and stop trusting your supervision system.

### What it is

A **checkin** is a dispatcher-owned watch that pings the dispatcher's inbox at intervals while a delegated task is in progress, and **auto-closes** when the linked task hits a terminal state (e.g. `done`). The dispatcher is whoever delegated the work; the checkin lives in their inbox, not the delegate's. If the delegate finishes fast, the checkin closes silently. If the delegate stalls, the dispatcher gets pinged.

### When to use it

**Use a checkin for EVERY delegation that creates a manager task** — i.e. every `/talk-to` request that includes `task: {title, name}`. This is not optional.

Do NOT attach a checkin to:
- one-off chats / synchronous Q&A (`/talk-to` without a `task` field)
- fire-and-forget pings (`/news-to`)

> A direct `POST /checkins` whose `linked_task` is already in `done` (or any terminal status) will be rejected with `409 linked_task_terminal`. If you missed the window, just read the task result instead of opening a check-in on it.

### How to attach a checkin (auto-attach)

Auto-attach is the default: include a `task: {title, name}` field in the body of `POST $MANAGER_URL/talk-to` and the manager creates the task **and** an active checkin watching it. The checkin is owned by the caller (`from`), interval defaults to **600s / 10m**, `close_when` defaults to `{task_status: ['done']}`.

```bash
curl -s -X POST "$MANAGER_URL/talk-to" \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: $ID_TEAM" \
  -d '{
    "to": "coder",
    "from": "'$ID_AGENT_ALIAS'",
    "message": "Please implement the X feature and report back when done.",
    "task": { "title": "Implement X feature", "name": "implement-x" },
    "checkin": "10m"
  }'
```

> **Important:** the `task: {…}` auto-attach lives on the **manager's** `/talk-to`, not on the local wrapper at `http://localhost:$ID_AGENT_PORT/talk-to`. The local wrapper only forwards `to` / `message` / `from` to the target's `/talk` endpoint and will silently strip the `task` field. To get auto-attach, hit `$MANAGER_URL/talk-to` directly (as shown above).

### Picking the right interval (BEFORE tuning)

Before you tune, understand why intervals matter: **the interval is your estimate of when things should be done**. If you set it too short, every ping is noise and you'll start ignoring them. If you set it too long, a stalled delegate stays invisible for hours.

**The interval should be slightly longer than the expected task duration**, not aggressively short. The first fire is meant to land *after* the work should plausibly be done, so its arrival is a real signal that something is off rather than routine noise.

**Rules of thumb:**
- Task you expect to take 5 min → set `checkin: "6m"` (or `7m`). First fire = "should be done by now, why isn't it?"
- Task you expect to take 30 min → set `checkin: "35m"`, `checkin_iters: 3`. Each fire is a meaningful checkpoint, not a buzz.
- Task with unknown duration (audit, exploration, research) → set the interval to your patience threshold, not your hope. If you'd want to know after 10 min, that's the interval.

**⚠️ Critical:** Aggressive intervals (every 90s on a 5-min task) create noise. Dispatchers learn to ignore noisy checkins, and then you lose visibility entirely when a real stall happens. Conservative intervals (slightly longer than expected) make every fire actionable.

### How to tune the checkin

Add any of these flags to the same request body. The CLI flag forms map onto body fields:

| Flag                    | Body field                    | Effect                                                                  |
|-------------------------|-------------------------------|-------------------------------------------------------------------------|
| `--no-checkin`          | `"no_checkin": true`          | Create the task but no checkin row.                                     |
| `--checkin <duration>`  | `"checkin": "30m"` or `1800`  | Override the 600s default. Accepts `s`/`m`/`h`/`d` suffixes or seconds. |
| `--checkin-iters <N>`   | `"checkin_iters": 6`          | Cap how many times the checkin fires before auto-expiring.              |

```bash
# Example: every 30m, max 6 fires
curl -s -X POST "$MANAGER_URL/talk-to" \
  -H "Content-Type: application/json" \
  -H "X-Id-Team: $ID_TEAM" \
  -d '{
    "to": "coder",
    "from": "'$ID_AGENT_ALIAS'",
    "message": "Long migration — wake me every 30m.",
    "task": { "title": "Run migration", "name": "run-migration" },
    "checkin": "30m",
    "checkin_iters": 6
  }'
```

### How to inspect checkins

```bash
# Default: returns checkins in ALL statuses (active, snoozed, closed, expired)
curl -s "$MANAGER_URL/checkins" -H "X-Id-Team: $ID_TEAM" | jq

# Narrow by status (CSV) — there is no `?include_closed=true`; the default already includes them
curl -s "$MANAGER_URL/checkins?status=active,snoozed" -H "X-Id-Team: $ID_TEAM" | jq

# Narrow by owner or by linked task
curl -s "$MANAGER_URL/checkins?owner=$ID_AGENT_ALIAS" -H "X-Id-Team: $ID_TEAM" | jq
curl -s "$MANAGER_URL/checkins?linked_task=implement-x" -H "X-Id-Team: $ID_TEAM" | jq

# Find checkins about to fire
curl -s "$MANAGER_URL/checkins?due_before=$(date +%s)000" -H "X-Id-Team: $ID_TEAM" | jq
```

> `GET /checkins/:id` is **not** implemented in the current daemon. To inspect a single checkin, list and filter by `linked_task` (or by `owner`) and pick out the row whose `id` matches.

### How to act on a checkin

- **Snooze** (push the next fire out by a duration). Body field is `duration`, not `duration_seconds`. Accepts `"30m"` style strings or a number of seconds.

  ```bash
  curl -s -X POST "$MANAGER_URL/checkins/<id>/snooze" \
    -H "Content-Type: application/json" \
    -H "X-Id-Team: $ID_TEAM" \
    -d '{"duration":"30m"}'
  ```

- **Close manually** (e.g. you've taken over and want to stop pings):

  ```bash
  curl -s -X POST "$MANAGER_URL/checkins/<id>/close" \
    -H "Content-Type: application/json" \
    -H "X-Id-Team: $ID_TEAM" \
    -d '{"reason":"manual_intervention"}'
  ```

- **Auto-close** happens for you whenever the linked task transitions to a terminal status (default `done`). You do not need to close the checkin yourself in the happy path.

- `DELETE /checkins/:id` exists but requires the **admin** principal (loopback + `X-Id-Admin: 1`). Agents should use `POST /checkins/:id/close` instead.

### What you see when a checkin fires

When a checkin fires, a **news item** lands in your inbox. Read it the same way you read every other inbound message:

```bash
# First poll — returns items in ascending id order, plus next_since_id when more remain
curl -s "http://localhost:$ID_AGENT_PORT/news?since_id=0&limit=100" | jq

# Subsequent polls — pass the last id you saw
curl -s "http://localhost:$ID_AGENT_PORT/news?since_id=$LAST_ID&limit=100" | jq
```

> The live API prefers `?since_id=<id>` over the older `?since=<ms-timestamp>` cursor. Both still work; `?since_id` is the recommended form.

The fired-checkin news item carries:
- linked task (name, status, owner)
- last activity timestamp / idle time
- iteration count vs `maxIterations`
- action affordances — typically: **nudge** the delegate, **snooze** the checkin, **close** the checkin, or **inspect** the linked task

When a fire wakes you, follow the probe ladder in the next section before deciding to nudge, snooze, or close. Pinging the delegate via `/talk-to` is the LAST resort: it costs the delegate's tokens and blocks both sides while the delegate composes a status reply.

### How to react to a fire — the probe ladder

When a `checkin_due` lands in your inbox, walk this ladder from cheapest to most expensive. Stop at the first signal that tells you what's happening. Most fires resolve at step 1 or 2 — you rarely need to escalate to `/talk-to`.

**1. Re-read the linked task — has it advanced since last fire?**

```bash
curl -s "$MANAGER_URL/tasks/$LINKED_TASK_NAME" -H "X-Id-Team: $ID_TEAM" | jq '{status, updated_at, owner: .ownerName}'
```

If `updated_at` is recent (within the last fire interval), the task is moving. Decision: do nothing, the next fire will tell you more.

**2. Look at the workdir — were files actually edited?**

```bash
# Find files modified in the last N minutes inside the delegate's working directory
find <delegate-workdir> -type f -mmin -<interval-min> -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -20

# Or check git activity if it's a code repo
( cd <delegate-workdir> && git status --short && git diff --stat )
```

If files are changing, the delegate is working. Decision: do nothing.

**3. Read the delegate's own news feed — what was its last activity?**

```bash
curl -s "http://localhost:<delegate-port>/news?since_id=0&limit=10" | jq '.items | reverse | .[:5] | .[] | {type, timestamp, message: (.message // "")[0:80]}'
```

`query.tool_use`, `query.progress`, `outbound.reply` types within the last interval = alive and active. Long silence (no entries) = something may be wrong; advance to step 4.

**4. Health-probe the delegate's REST-AP endpoint.**

```bash
curl -sf -m 5 "http://localhost:<delegate-port>/.well-known/restap.json" >/dev/null && echo alive || echo unresponsive
```

Unresponsive = the agent process itself is down or its server is hung. Decision: close the checkin with `reason="delegate_unresponsive"` and either restart the delegate (admin action) or escalate to the user. Do not bother sending `/talk-to`; it will hang too.

**5. Last resort — `/talk-to` the delegate to ask for a status line.**

Only after steps 1-4 give ambiguous signals (delegate is responsive, task hasn't moved, news shows nothing recent). The status query itself costs the delegate one LLM turn:

```bash
curl -s -X POST "$MANAGER_URL/talk-to" \
  -H "Content-Type: application/json" -H "X-Id-Team: $ID_TEAM" \
  -d '{"to":"<delegate>","from":"'$ID_AGENT_ALIAS'","message":"Status check on '$LINKED_TASK_NAME'. Reply with one sentence: what step are you on, and is anything blocked?","timeout":60000}'
```

Use a short timeout (60s). If the delegate is genuinely stuck inside its current LLM turn, the `/talk-to` will time out and you'll know.

### Decision after the probe

| Probe result | Action |
|---|---|
| Task `updated_at` recent OR files changing | Do nothing — let the next fire confirm continued progress. |
| Task idle but delegate news shows recent activity | Snooze the checkin one interval (`POST /checkins/:id/snooze {"duration":"<interval>"}`). The delegate is alive but on something else. |
| Task idle AND delegate news silent BUT delegate responsive | `/talk-to` for a status line (step 5). |
| Delegate unresponsive (step 4) | Close the checkin (`POST /checkins/:id/close {"reason":"delegate_unresponsive"}`). Escalate to user; this is operator-level. |
| Task transitioned to a terminal status while you were probing | The checkin will auto-close on its own. Do nothing. |

The big idea: **a checkin's job is to wake you. The probe ladder's job is to tell you, cheaply, whether the wake was a false alarm or a real one.** Most wakes are false alarms (work is progressing fine, the interval was just too aggressive); a few are real (delegate stuck, dead, or genuinely needs help). The ladder distinguishes them without spending the delegate's tokens.

### Lifecycle

```
created (status=active)
   │
   ├─► (optional) snooze ──► status=snoozed ──► next_fire_at is moved out
   │
   ├─► linked task hits a terminal status (e.g. `done`)  ──► auto-close (status=closed)
   │
   └─► fires `max_iterations` times without resolution    ──► auto-expire (status=expired)
```

A checkin in `closed` or `expired` state never fires again. Snoozing a closed/expired checkin returns 409 `checkin_terminal`.

### Why this exists

Checkins solve the **claimed-and-idled** failure mode: a delegate accepts a task, then stops making progress for hours without saying so. Without supervision, the dispatcher only finds out when they happen to look — if ever. That work sits invisibly blocked, burning time and team velocity.

With checkins and reasonable intervals:
- The dispatcher gets pinged on a meaningful cadence (not noisy, not silent)
- They can decide cheaply whether to nudge, snooze, or close (the probe ladder avoids wasting the delegate's tokens)
- Successful tasks auto-close their own checkin silently in the happy path
- Stalled work surfaces immediately instead of rotting

Dispatchers who skip checkins, or use aggressive intervals and then ignore the pings, lose supervision entirely. That's why interval-tuning is as important as deciding to use a checkin at all.
