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
