# Inter-Team Communication Implementation Log

Scope: design commits 1–3 only. Work stops at the commit-3 gate. The live database at
`~/.id-agents/id-agents.db` is out of scope and must never be opened by this work.

## Commit 1 — Protocol contract

Built:

- Pure protocol types for the three destination variants, five message states, fixed
  pre-accept result codes, participant bindings, collection results, and roster projection.
- Human address parser for `team:<alias>` and `team:<alias>/<agent-name>`; immutable agent
  IDs are structured-only.
- Major/minor compatibility, recognized-envelope replay identity, the 30-day automatic
  resubmission horizon, strict participant/order checks, and an evidence-gated state machine.
- Pure contract helpers for self-node admission refusal, permissive `open`, policy-independent
  roster reads, exact name/ID resolution, and bounded roster responses.

Gate proof:

- `npx -y -p node@22 -c './node_modules/.bin/vitest run tests/unit/inter-team-protocol-contract.test.ts'`
  — 1 file, 20 tests passed.
- `npx -y -p node@22 -c 'npm run build:core'` — passed.
- `git diff --check` — passed.
- Contract-test scan for HTTP, worker URL, and endpoint URL literals — zero matches.
- The suite imports only the pure protocol module; no manager process is started.
- Seniordev independently reviewed the current diff and returned `APPROVE` after we agreed
  compacted failures retain their stable code, self-node refusal is not a repurposed
  pre-accept error, and `open` admits all destination variants without a flag.

Could not do: none.

Plan defects found: none in commit 1.

## Commit 2 — Normalized org schema and authority

Built:

- Additive normalized organization schema for SQLite and PostgreSQL: team org state,
  recursive groups, group leads/members, organization tags, and tag assignments.
- Database constraints/triggers for cross-team references, normalized sibling uniqueness,
  deterministic sibling/member/tag positions, cycle rejection, restricted parent deletion,
  subtree-safe deletion, and hard-delete cleanup.
- Shared normalization and a transactional normalized org store with full replacement,
  nested reads, explicit no-org/blocked classifications, reorder, ordinary delete,
  explicit subtree delete, exact tag search, bounds, and corrupt-state refusal.
- Group leads are implicit recursive members and are never duplicated in membership rows,
  even when a legacy YAML source repeats its lead in `members`.
- Parser validation for unresolved/ambiguous references, unexpanded templates, normalized
  sibling/tag collisions, depth/count bounds, duplicates, and tags-only orgs.
- New deploy/import writes normalized rows after immutable agent IDs exist, never writes
  deprecated `teams.config.org`, and renders the chart from a fresh normalized read.
  Normalized state wins a conflicting deprecated JSON copy. The existing legacy fallback
  remains only for teams with no org-state row, pending commit 3.
- Transaction support that pins PostgreSQL work to one pool connection and provides the
  same atomic write boundary in SQLite.

Gate proof:

- Node 22 SQLite/unit/integration gate: 4 files, 51 tests passed. This covers shared
  normalization, nested parity fixture, chart and agent context, exact tags vs catalog
  expertise, soft/hard delete behavior, reorder, restricted delete, explicit subtree
  delete, corruption refusal, normalized authority over legacy JSON, nested deploy/import,
  tags-only deploy, and the real spawn-context path.
- Disposable PostgreSQL 16 gate: 16 tests passed (8 per dialect in the same parity suite).
  It executes the full PostgreSQL migration twice and runs the same DB constraint and
  normalized-store behavior against real PostgreSQL and SQLite.
- `npx -y -p node@22 -c 'npm run build:core'` — passed.
- `git diff --check` — passed.
- All databases used were in-memory SQLite or a temporary PostgreSQL cluster created under
  `/tmp` and removed after the run. No live fleet data was opened or moved.
- Seniordev independently inspected the diff and returned `APPROVE` after we fixed the
  tags-only path so it cannot be falsely classified as `intentionally_no_org`.

Could not do: none.

Plan defects found: the repository had no executing PostgreSQL parity harness. The gate
could not honestly pass by inspection alone, so commit 2 adds and executes a disposable
real-PostgreSQL test path rather than weakening the gate.

## Commit 3 — Audited nine-team backfill

Built:

- A deterministic dry-run/apply backfill using the normalized commit-2 validator and
  writer, with source hashes, semantic read-back, recursive-member results, per-team
  terminal decisions, and one database audit row per team and run.
- Explicit blocking for missing/unreadable sources, missing org content, unexpanded
  templates, invalid YAML, unresolved references, and unacknowledged source drift. A
  no-org override is accepted only for absent or unrecoverable org content; it cannot
  erase a resolvable organization and always retains discovered source evidence.
- A CLI that refuses the live database by resolved path, dry-runs on a private copy,
  creates an exclusive integrity-checked rollback copy before apply, and refuses restore
  if the migrated target has drifted. Apply requires absolute rollback and audit paths.
- Runtime removal of the legacy JSON/file fallback. Normalized state is authoritative,
  `intentionally_no_org` is empty by decision, and blocked or unclassified state reports
  `org_migration_required`. Deprecated `teams.config.org` is removed only after every
  team has both a terminal state and an audit row for the run.
- SQLite and PostgreSQL audit-schema parity and updated spawn/export fixtures that
  exercise normalized authority rather than the removed fallback.

Audited snapshot classifications:

| Team | Classification | Groups | Explicit memberships | Tag assignments | Reason |
| --- | --- | ---: | ---: | ---: | --- |
| all | blocked | 0 | 0 | 0 | `missing_source_path` |
| dappa | normalized | 1 | 5 | 4 | source hash `f6ae23d0…7884b` |
| default | blocked | 0 | 0 | 0 | `source_has_no_org` |
| default2 | blocked | 0 | 0 | 0 | `source_has_no_org` |
| idchain | normalized | 2 | 17 | 14 | source hash `1e68acb2…53cd7` |
| lab | blocked | 0 | 0 | 0 | `source_has_no_org` |
| public | blocked | 0 | 0 | 0 | `missing_source_path` |
| security | normalized | 3 | 11 | 0 | source hash `e051a011…8f36` |
| tradeagent | normalized | 1 | 2 | 2 | source hash `2e98abca…b9fc` |

The explicit-membership totals intentionally exclude each repeated lead. Leads remain
implicit recursive members, so no source person was lost. The audit preserved group
descriptions and source order and recorded these recursive results: dappa `technical`
(6 people); idchain `technical` (17) and `marketing` (1); security `leadership` (1),
`stack-agents` (4), and `specialists` (7); tradeagent `technical` (3).

Gate proof:

- The prepared 75 MB snapshot was copied twice before use. No command opened or mutated
  `~/.id-agents/id-agents.db`, and the prepared snapshot itself was never migrated.
- Final dry-run copy: 9 teams, 4 normalized, 5 blocked, 7 groups, 20 tag assignments;
  input SHA-256 remained `d90fbb49…d77925`.
- Final apply copy: SQLite integrity `ok`, 9 state rows, 9 audit rows, 7 group rows, and
  20 tag-assignment rows. Each normalized write passed semantic read-back for group
  descriptions/order, tags/order, and recursive members.
- Refusing rollback was covered by a drift test. Successful restore changed the applied
  copy from `087525e1…8789` back to the exact pre-apply hash `d90fbb49…d77925`, with
  integrity `ok`.
- Node 22 focused gate: 6 files, 56 tests passed. The synthetic nine-team suite includes
  team-local template/unresolved/missing-source failures, no partial rows, override
  conflicts, source-drift acknowledgment, dry-run immutability, live-path refusal, and
  rollback refusal/restoration.
- Full Node 22 repository suite: 115 files passed, 5 skipped; 1,253 tests passed,
  60 skipped.
- Disposable PostgreSQL 16 parity: 16 tests passed; `npm run build:core` and
  `git diff --check` passed.
- Seniordev independently inspected the implementation and gate evidence and returned
  `APPROVE` after the override-conflict and per-run audit-count checks were added. We
  explicitly agreed that source-drift acknowledgment can never authorize org erasure.

Could not do: no `intentionally_no_org` override was applied to the five historical teams;
none was supplied by the operator, so the three readable no-org sources and two missing
source paths remain correctly blocked for inspection.

Plan defects found: none in commit 3.
