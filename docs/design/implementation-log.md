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

## Commit 3 follow-up — all-terminal no-org override gate

Prem explicitly approved `intentionally_no_org` for `all`, `public`, `default`,
`default2`, and `lab`. The first two retain evidence that no source path existed; the
other three retain their source paths and hashes and had readable sources with no org
content. No override conflicted with a resolvable organization.

Gate proof (copy only):

- A fresh 75 MB copy of the prepared snapshot was used. Its pre-apply SHA-256 was
  `d90fbb490389e287cbeca387cc80907e81d02ca2e4bcbeb09fb984ff63d77925`.
  No command opened, migrated, or wrote `~/.id-agents/id-agents.db`; this was not a live
  migration, and commits 4–6 were not started.
- Override dry-run and apply both classified all nine teams: 4 `normalized`, 5
  `intentionally_no_org`, 0 `blocked`, with 7 groups and 20 tag assignments. Apply run
  `a0421baa-309f-4a2d-bb22-bb36cccf82b9` wrote exactly 9 audit rows and 9 state rows,
  whose classifications agreed team-for-team.
- With zero blocked teams and one audit row per team, apply passed the post-audit gate and
  executed the deprecated `teams.config.org` cleanup path. The post-cleanup count was zero;
  the prepared snapshot also had zero legacy keys, so there was no legacy org value to
  erase and the cleanup was intentionally a no-op for all nine rows.
- Fresh normalized-store read-back reproduced every applied semantic hash. The four hashes
  for `dappa`, `idchain`, `security`, and `tradeagent` exactly matched the earlier commit-3
  apply audit, including their recursive membership results.
- Applied-copy SQLite integrity was `ok`. The audited after hash was
  `357136a2e117ee9a2bdac0ee3b5ba14d08c06e2c360867d7b0be807651a1518a`.
  Restore then returned the target to the same exact pre-apply hash as the rollback copy,
  `d90fbb490389e287cbeca387cc80907e81d02ca2e4bcbeb09fb984ff63d77925`,
  with SQLite integrity still `ok` and no commit-3 tables present in the restored copy.

## Commit 3 live migration — authorized apply

Prem authorized the live migration and the five named `intentionally_no_org`
decisions. The live-path guard remains default-deny; the new
`--allow-live-database` flag is an exact opt-in and emits a prominent warning. Because the
live database uses WAL and had roughly 5 MB of committed WAL pages, live dry-run and
rollback snapshots use SQLite's online backup API rather than copying only the main file.
Live restore additionally requires `--confirm-live-processes-stopped`: swapping the main
inode or removing WAL sidecars while any holder remains open would fork the running fleet.

Pre-apply gates:

- Operator backup
  `/Users/nxt3d/.id-agents/backups/id-agents-20260804-194029.db` had SHA-256
  `2bff48a7430fcd2949f4194d600f6b2d2e778ba0ae967f8980fdb9a2c20c3d55`,
  integrity `ok`, and exact live-at-cutoff teams, agents, news, query, and task counts/maxima,
  proving that it included committed WAL state.
- `lsof` identified seven holders of this database: Electron PID 26709 and Node PIDs 974,
  26847, 36907, 36920, 59503, and 60631. All seven REST-AP endpoints returned HTTP 200
  before apply. They remained running because the live delta is additive and old builds do
  not read the new tables.
- Online-backup dry-run `ff9eb1d0-589c-4fd9-8fb4-231719226717` matched the prepared
  snapshot team-for-team: 9 teams, 4 `normalized`, 5 `intentionally_no_org`, 0 `blocked`,
  7 groups, and 20 tag assignments. The four source and semantic hashes were unchanged.
- Immediately before apply, teams remained 9, agents remained 51, and zero teams carried
  deprecated `config.org`.

Apply and verification:

- The CLI first created and integrity-checked its own online rollback snapshot at
  `/Users/nxt3d/.id-agents/backups/id-agents-pre-org-live-20260804-195328.db`; SHA-256
  `57f87964e73031f02eb598957b5b3c59316520958d50be0850fb6b0d2fe2a2a4`.
- Apply run `07afa1b5-ee74-402b-b602-1d11985ff383`, decided by `Prem`, produced 4
  `normalized`, 5 `intentionally_no_org`, 0 `blocked`, 7 groups, 20 tag assignments, 9
  state rows, and 9 run-specific audit rows. Its online post-apply snapshot hash was
  `b3001788966ffb674544c1b64986de3cdf33fcffea9b3740875188650d7a9479`.
- Live SQLite integrity was `ok`; teams remained 9, agents remained 51, and deprecated
  `config.org` remained absent. Fresh normalized-store reads reproduced semantic hashes
  `d31929a9…29fa` (dappa), `b9c57163…cb3b` (idchain), `8ff55b1c…e4cf7`
  (security), and `d73576ec…147a` (tradeagent), exactly matching both snapshot runs.
- The same seven PIDs still held the database after apply; all seven REST-AP endpoints
  returned HTTP 200, desktop manager health returned `ok`, and the idchain roster count
  remained 19 agents / 18 running.

Seniordev independently challenged the WAL snapshot, live-holder count, rollback, and
decision-provenance assumptions. After the online-backup/restore hardening and verification
of Prem's explicit five-team ruling, seniordev returned `APPROVE APPLY` and agreed the final
post-apply gate passed.

## Commit 4 — intrinsic node identity, team policy/lead, and contacts

Built:

- A singleton `manager_identity` row generated with one random UUID on first migration and
  preserved on every rerun, restart, and restore-in-place. No network attribute, peer row,
  token, credential, or per-team identity participates.
- Explicit `teams.inbound_policy` (`closed` by default) and nullable `lead_agent_id`.
  Store and database checks accept an explicitly selected stopped agent but reject a
  deleted or cross-team agent. Hard or soft deletion clears the pointer. This deliberately
  strengthens the design's unusable-lead case: null and dangling-deleted both produce the
  same routing error, but a restored soft-deleted agent does not silently regain leadership;
  an operator must assign it again.
- Team-owned contacts with one display/normalized alias pair and opaque remote node/team
  pins. Alias normalization reuses `normalizeOrgKey`; rename rewrites both forms atomically,
  reruns per-team uniqueness, and cannot mutate the remote pins. The remote pins are `text`
  in both dialects and have no foreign keys or UUID-format requirement.
- A dialect-neutral foundation store for later operator APIs. No contact, lead, grant, or
  peer configuration is fabricated by migration, and nothing derives the team lead from
  the normalized org tree.

Gate proof:

- Focused SQLite repository/migration gate: 3 files, 31 tests passed; TypeScript build and
  `git diff --check` passed.
- Disposable PostgreSQL 16 parity gate: 11 tests passed across SQLite and PostgreSQL,
  including deliberately non-UUID opaque contact pins.
- Full migration on a disposable copy of the pre-org live backup: SQLite integrity `ok`,
  9 teams, 9 `closed`, 9 null leads, exactly 1 valid node UUID stable across a second full
  migration, and 0 contacts.
- Restore-in-place test copied and reopened a file-backed SQLite database, reran migration,
  and retained the exact original node UUID.
- Full Node 22 repository suite: 116 files passed, 5 skipped; 1,263 tests passed, 60 skipped.
- Seniordev independently reviewed the candidate, found and verified fixes for PostgreSQL
  opaque-pin parity, duplicate display state, and swallowed SQLite ALTER failures, then
  returned `APPROVE` with no remaining defects.

Could not do: no live application of commit 4 was authorized or attempted. The migration
was exercised only in memory, in disposable PostgreSQL, and on a disposable SQLite copy.

Plan defects found: none. The archived pre-amendment plan inferred an inbox handler from a
unique org lead; the current design explicitly forbids that inference, so commit 4 leaves
every existing and newly created team lead null until an operator assigns it.

## Commit 5 — durable conversations, messages, and retention

Built:

- A gapless, origin-submitted conversation stream keyed by opaque origin node and
  conversation IDs. Participants, destination variant, accepted direct-agent resolution,
  next position, and predecessor head are pinned durably; there is deliberately no close
  state and no reverse-route table because V1 results are pull-only.
- Durable messages with submitter/message idempotency, immutable comparison identity,
  accepted/processing/completed/failed/unknown state, last confirmed state, explicit result
  presence, terminal clocks, and retained/compacted tiers. Database triggers require every
  insert to begin accepted and require a durable processing mapping before processing.
- A one-to-one message/query processing map and permanent status-only receipts. Mapping IDs
  have no agent or query foreign keys, so history survives handler deletion. Terminal
  compaction removes both message payload copies and the linked query row at 30 days;
  message deletion at 365 days preserves the receipt. Accepted, processing, and unknown
  work is never reaped.
- Transactional acceptance, replay/conflict checks before mutable validation, participant
  binding, ordering, durable origin ID allocation, state transitions, tier-aware collection,
  capped retention sweeps, and an actual `pragma_auto_vacuum = 2` gate before bounded
  incremental vacuum. The full locking VACUUM remains an explicitly named operator action.
- Normal team deletion is blocked while either participant owns active work. Force deletion
  resolves it atomically to failed with the dedicated `owner_force_deleted` code while
  preserving audit/dedup history; collection after a local participant team is gone returns
  conversation-not-found and never retargets.

Gate proof:

- Focused SQLite gate: 11 tests passed; TypeScript core/TUI build and `git diff --check`
  passed.
- Disposable PostgreSQL 16 parity: 21 tests passed across SQLite and PostgreSQL, including
  database-level transition constraints, retention, deletion, and opaque participant IDs.
- Full migration was run twice on a disposable copy of the pre-org live rollback backup:
  teams remained 9, agents remained 51, the singleton identity remained 1, and contacts,
  conversations, messages, and receipts remained empty. No commit-4 or commit-5 schema was
  applied to the live database.
- Repository regression gate passed 1,273 tests across 116 files with 60 skipped. One
  pre-existing order-sensitive rebuild test failed both in the full run and in isolation:
  it inserts two agents in the same second, lists them by `created_at DESC` without a tie
  breaker, and assigns a one-shot mock failure to whichever tied row SQLite returns first.
  Commit 5 does not modify that test, the agent repository, or rebuild behavior.
- Seniordev reviewed the complete schema/store/tests, independently reran the focused suite,
  and returned `APPROVE`. The review's suggested structural hardening was included: a
  compacted tier is accepted only for completed or failed rows in both dialects.

Could not do: commit 5 was not applied to the live database; authorization covered only the
commit-3 org migration. The unrelated tied-timestamp rebuild test was documented rather
than changed outside this commit's scope.

Plan defects found and resolved with seniordev: linked query payload must be deleted at the
30-day compaction boundary, force-delete needs a distinct stable outcome, and incremental
vacuum must inspect SQLite's actual pragma rather than trusting configuration. All three are
implemented and covered by parity tests.

## Commit 6 — trusted local source context and operator configuration

Completed by seniordev from cto's uncommitted partial work after review. The inherited
code was kept: it already implemented the pairing agreements (a distinct
`source_context_mismatch` for body/context disagreement, `source_unauthorized` reserved
for the cross-owner contact-ID clash per the frozen definition, removal enumeration on
org replacement, and audit appended inside each mutation's transaction). No approach was
replaced.

Shape: `src/inter-team/local-context.ts` holds the typed trusted-context seam commits 7/8
will consume — `deriveLocalTeamId` lets a body agree with the derived team but never
replace it, and `resolveOwnedContact` scopes alias lookup to the derived team while a
globally resolved contact ID owned elsewhere fails `source_unauthorized`.
`src/inter-team/operator-config.ts` implements contact CRUD, inbound policy, team lead,
and whole-org replacement; every write and its `event_log` audit row
(`interteam:operator_config`) share one transaction, with
`replaceFromConfigInTransaction` added to the normalized org store for that purpose.
Routes live under `/inter-team/config` and reuse the existing loopback + `X-Id-Admin`
assertion with a mandatory explicit team; no token or capability is minted. For these
routes the team middleware refuses to auto-create a team: a typo returns
`team_not_found` rather than fabricating an owner. `X-Id-Agent` is an optional audit
actor that must resolve in the explicit team; otherwise `agent_team_mismatch`. A stopped
agent may be assigned lead and policy may open regardless of availability; the response
carries degraded metadata only. The single-host boundary — a malicious same-UID worker
can forge another team's assertion, and the loopback admin judgment changes behind a
reverse proxy — is stated in `LOCAL_TRUST_BOUNDARY_NOTICE` and asserted by test.

Executed gates: 19/19 new integration tests (`tests/integration/interteam-operator-config.test.ts`)
covering context refusal, explicit-team requirement, no side-effect team creation,
body-override rejection, cross-owner `source_unauthorized`, same alias in two teams,
normalized alias collision, pin immutability, audited rename/delete with actor, stopped
lead + open policy, cross-team lead refusal, removal enumeration, and org+audit rollback
atomicity. Regressions: 112/112 across event-log, checkins, admin-mesh, repos, and
org-backfill suites; full unit suite 769/769; build green. Granular group/subtree
endpoints remain deferred until they can meet the explicit preview-and-audit rule; the
whole-PUT enumerates destructive diffs in response and audit instead. Not applied to the
live database; commit 7 not started.

Recovery coordination note: the manager rerouted commit 6 to seniordev while cto's long
turn was swept, so both agents independently produced overlapping test surfaces in the
shared worktree. Seniordev kept cto's implementation unchanged, committed the broader HTTP
suite, and left cto's additional tests for a reviewed follow-up. Those supplementary tests
add a positive-control audit failure that proves the contact mutation rolls back, plus real
PostgreSQL 16 parity. The combined commit-4/5/6/org gate passed 90 tests across both
dialects; the supplementary SQLite service/API gate passed 9 tests.

## Commit 7 — destination union, strict receiver-local resolution

Phase C begun by seniordev as lead (manager dispatch, Prem authorized), pairing with cto
asynchronously per instruction; review requests sent per commit, not blocking on replies.

`src/inter-team/destination-resolver.ts` resolves a destination team only by the contact
pin's immutable team ID (`target_identity_missing` otherwise) and recipients only inside
that team: exact current name (0 matches `recipient_not_found`, >1 `recipient_ambiguous`
— never most-recent), exact immutable ID with out-of-team and soft-deleted rows both
`recipient_not_found`, stopped agents `recipient_unavailable`. A team destination checks
only that it can route right now through the assigned lead (unassigned, deleted, or
stopped lead all `team_lead_unavailable`) and pins nothing — the message binds to the
team and re-resolves at processing time; agent destinations return the immutable ID that
acceptance pins. `isInterTeamAvailable` is the one shared processing-capable/availability
predicate, exported for commits 8/9 so routing and dispatch cannot disagree.

Tests: 11 in `tests/repos/interteam-destination-resolver.test.ts` covering the full
design list — valid, unknown, ambiguous, stopped, wrong-team, name-and-ID equivalence,
rename before/after with stable ID addressing, soft-delete for both variants,
delete-recreate resolving only the new ID, lead routing, and the shared predicate.
Typecheck and suite green. No schema change; live database untouched.

## Commit 8 — acceptance service, policy-before-recipient

`src/inter-team/acceptance-service.ts` is the one post-transport acceptance service for
same-manager and future federation transports. Order enforced and tested: federation
self-node claim rejected first (`self_node_claim`, same-manager context allowed and
derives the local node); envelope origin must agree with transport context
(`source_context_mismatch`) and a mis-addressed destination node fails
`target_identity_missing`; protocol major; stateless body bound; destination team by
immutable ID; continuation participants validated against the pinned binding before
deduplication or any other conversation access; accepted-duplicate short-circuit before
mutable policy/capacity re-evaluation (a closed-after-accept team and a zeroed bound
still return the committed state for an identical retry, `idempotency_conflict` for a
changed one); policy before recipient for new conversations — resolver AND lead-lookup
spies prove `target_closed` happens with zero agent lookups for known and unknown names
alike; capacity bounds (body size, per-origin, per-team, per-direct-recipient, total)
return `receiver_busy` pre-accept without dropping accepted work; then the commit-5
store transaction re-runs dedup/order atomically and commits before 202. Continuations
never re-resolve contact/policy/name — a caller-supplied different target fails
`conversation_not_found` and the binding stays pinned (proven post-rename with policy
flipped closed). The per-direct-recipient bound for an `agent_name` destination runs
immediately after resolution (still pre-accept) because the pinned ID cannot exist at
step 6; recorded here as the one deviation from strict step ordering, forced by the
data dependency.

Tests: 11 in `tests/repos/interteam-acceptance-service.test.ts`. All repos suites
109/109, typecheck green. No schema change; live database untouched.

## Commit 9 — async processor and recipient lifecycle

`src/inter-team/processor.ts` processes accepted messages strictly after their
acceptance transaction. One `scan()` pass reconciles in-flight work from durable
evidence, then starts eligible accepted messages; startup recovery, the post-accept
kick, and the timer tick are the same code path, with no exactly-once claim. The
durable local job is a `queries` row with the deterministic ID
`interteam_<messagePk>` (`ON CONFLICT DO NOTHING`, so a same-ID restart re-links
instead of forking) plus the commit-5 `interteam_processing` row; both exist before
the message reports `processing`, and the commit-5 trigger backstops that order.
Team messages resolve to the lead configured at processing time — a newly assigned
lead picks up pending team work; direct messages use the agent ID pinned at
acceptance and are never re-resolved. A stopped target leaves work `accepted`. A
deleted pinned recipient fails `recipient_deleted` in both the accepted and
processing phases — the only agent-level terminal event — while team work with a
deleted lead just waits. Handler failure records the stable code `handler_failed`.
Each conversation's stream runs serially in position order: a message starts only
when every earlier position is terminal and nothing in the conversation is in
flight. `unknown` is entered only when the durable job evidence is lost and left
only when durable evidence reappears; while evidence is absent the processor
refuses to guess. Dispatch is a pluggable hook whose default hands the durable
query row to the existing queries machinery — nothing here dials a worker URL.

Tests: 9 in `tests/repos/interteam-processor.test.ts` — the design's four named
cases (stopped-after-accept stays accepted; same-ID restart proceeds; rename does
not break continuation; deletion differs from team-lead reassignment) plus serial
ordering, durable-result-before-completed, unknown enter/leave on evidence, stable
handler failure, and mid-flight deletion. Typecheck green. No schema change; live
database untouched.

## Commit 10 — result collection, status, roster reads, CLI, local E2E

`src/inter-team/origin-client.ts` is the origin side: contact resolution through the
commit-6 trusted-context seam (alias team-scoped, cross-owner contact ID
`source_unauthorized`), durable origin-ID allocation, envelope construction, submission
through the one commit-8 acceptance service, ordered continuation from the stored
binding, and origin-only non-consuming collection — a conversation owned by another
local team is indistinguishable from a missing one. A pin to a foreign node fails
`peer_route_unconfigured` (local, non-frozen: V1 has no peer routes; commit 14 adds the
loopback transport). Descriptor/roster reads resolve a contact, are unaffected by
inbound policy, bound by count/bytes with whole-read failure (never a silent partial),
per-node rate limited, publish leaf group names as context only (no tree, no IDs, no
lead hint), and label each whole stored catalog `agent_asserted`. `readRoster` exposes
no port, endpoint, or URL fields.

Manager routes: `POST /inter-team/send`, `POST/GET
/inter-team/conversations/:id/messages[/:messageId]`, `GET /inter-team/descriptor/:alias`,
and an admin-only `POST /inter-team/scan` tick. Caller context is the commit-6 rule:
agent principal or explicit-team admin; bodies may agree with the derived team, never
replace it. Acceptance commits before the 202; the processor runs post-response, on a
30s unref'd timer, and once at startup — recovery is the same scan. `src/cli/
interteam-commands.ts` is the thin client carrying the exact product copy
(`INTERTEAM_ADDRESS_HINT`: prefer `team:<alias>`; name and ID are the permitted direct
paths). Full TUI panels are deferred; recorded as scope, not silently dropped.

E2E (`tests/integration/interteam-local-e2e.test.ts`, 11 tests, real HTTP on a
file-backed DB): all three destination variants with direct pins verified;
accepted/processing/completed/failed collection including repeated non-consuming
reads; non-participant reads identical to unknown-conversation reads; ordered
continuation; lost-response resubmission returning one row; team-lead deletion holding
serial-stream work `accepted` until a newly assigned lead picks it up; broken pin
`target_identity_missing`; capacity `receiver_busy` without dropping accepted work;
descriptor/roster against open AND closed teams; force-delete of an owner with work
outstanding (`owner_force_deleted`, later collection `conversation_not_found`); and the
gate — a full manager stop/start with collection reconstructing identical results from
durable rows, plus a fetch spy proving every network request in the file targets only
the manager base URL: no caller dialed a worker. `unknown`-state collection is covered
at the store/processor layer (commits 5/9 suites). Full regression: 924 tests across
repos/unit/middleware-adjacent suites plus the E2E, build green. No schema change; the
live database is untouched and Phase C has not been applied to it. Commit 11 not
started.

## Commit 8 fix-forward — atomic capacity admission (cto review findings)

cto's commit-8 review (task review-interteam-acceptance-commit-8) found two defects,
both confirmed and fixed forward:

1. Capacity admission ran outside the acceptance transaction: concurrent submissions
   could both pass a bound that admits one (and SQLite's non-reentrant adapter
   transaction threw under interleaved accepts). Fixed: `acceptRequest` gains an
   `admission` hook evaluated inside the store transaction after every
   dedup/participant/order check and immediately before the durable insert; the
   acceptance service serializes accepts through an in-process queue, and the
   Postgres path additionally takes `pg_advisory_xact_lock` for cross-process
   admission. New concurrency test: 6 simultaneous submissions against a bound of 2
   yield exactly 2 accepted, 4 receiver_busy, 2 rows, no thrown errors.

2. The `agent_id` per-recipient bound was counted before receiver-local team
   membership validation, leaking busy-state for a wrong-team ID at its limit
   (reproduced by cto). Fixed: per-direct-recipient bounds now use only a validated
   pinned ID — post-resolution for new sends, the stored binding for continuations —
   so a wrong-team ID returns recipient_not_found regardless of backlog. The earlier
   "agent_name ordering deviation" note is superseded: both direct variants now bound
   after resolution, inside the transaction. New leak-regression test covers
   wrong-team-at-limit vs correctly-addressed-at-limit.

Both mis-addressed-code rulings confirmed by cto and kept: destinationNodeId mismatch
= target_identity_missing; envelope/transport disagreement = transport-layer
source_context_mismatch, not added to the frozen set. Suites: commit-8 13/13, all
inter-team repos + E2E 131/131, typecheck green.
