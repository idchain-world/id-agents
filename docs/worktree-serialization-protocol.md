# db-source-of-truth worktree

This is the `db-source-of-truth` build worktree. It is NOT the live fleet.
`/Users/nxt3d/projects/id2/id-agents` is — never edit it from here.

## SERIALIZATION — read this before your first edit

Several wakes of the same agent can be live at once. A `/talk-to` reply is
re-delivered as news, and each delivery can spawn a fresh `--resume` of the
same session, so "another agent is editing my files" is usually *you*. This
has already produced a red suite, a half-finished two-place edit, and a
transient `api_key: 'never' → 'config'` sitting in the tree.

Message delivery cannot fix this, because a message only reaches the wake that
receives it. This file can, because every wake reads it at startup.

### 1. Take the lock before ANY edit

```
LOCK=/tmp/dbtruth-worker.lock
```

- If the file exists and holds a PID that `kill -0 <pid>` says is alive, and
  that PID is not you: **exit silently.** No edits, no commits, no reply.
- If the PID is dead, the lock is stale: replace it with yours.
- Write your own long-lived `claude` PID, not the PID of the shell running the
  check — shells exit between tool calls, so a shell PID makes your lock look
  stale within seconds. Walk up the process tree to the `claude` process.
- Remove the lock when your turn ends.

### 2. Sole-liveness is the real precondition, not a dirty tree

An earlier version of this rule said to exit only if the tree was dirty AND a
sibling was live. That is too late: the collision *begins* while the tree is
still clean and two wakes each decide to proceed. Check liveness, not just
`git status`.

If a check-in or heartbeat wakes you while the lock is held by a live PID,
exit silently. Do not re-do work that is already done, and do not re-answer a
redelivered message.

### 3. Never commit work you did not write — preserve it instead

If you find uncommitted changes you did not make:

- **Do not** stash, revert, discard, or silently fold them into your commit.
  `git add <path>` stages the WHOLE file, so committing "your" change to a
  shared file quietly ships someone else's unreviewed work under your message.
- **Do** preserve them in their own clearly labelled commit that says whose
  they are and that they are unreviewed. Precedent: `992e76d` and `b7a408a`.
  This matters because the mutation-testing workflow restores files from git,
  so uncommitted work in this tree gets destroyed by the next mutation run —
  preserving it is reversible, losing it is not.
- Split before you commit: reset the shared files, re-apply only your own
  change deterministically, verify the test count matches your pre-collision
  measurement, then commit. A matching count is what proves the split is clean.

### 4. Working rules for this build

- Baseline first: run the suite and state the number BEFORE mutating anything.
  A test written against an already-red suite looks identical to one that
  caught your mutation.
- Stage by explicit path. Never `git add -A`.
- Commit locally. No push, no merge to main, no version bump.
- Never run `/export` (or anything else) against the live database on :4100,
  and never restart that manager. Fixtures only.
- The alias read-site count is FROZEN at 29 direct + 15 flattened across 12
  files (`0ece601`). Do not re-count it; six different figures have already
  been quoted and the churn cost more than the precision was worth.
