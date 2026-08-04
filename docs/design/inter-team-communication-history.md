# Inter-team communication — decision history (archive)

> **This is not the design document.** The design lives in
> [`inter-team-communication.md`](./inter-team-communication.md) and is canonical;
> where the two differ, the design wins.
>
> This archive is kept for one purpose: it records the alternatives that were
> considered and **rejected**, and why — unified team/group recursion,
> application-level node certificates and grant/token lifecycles, the mandatory
> non-null group-lead invariant, a default-off direct-addressing flag, and
> withholding open-team rosters. Read it before reopening a settled call, not to
> learn how the system works.

**Status:** all decisions reconciled; superseded as the working document by the
design doc; no feature implementation yet

**History:** this file superseded the 2026-07-28 Path L plan and the pointer in
`output/multinode-interteam-architecture-revised-plan.md`

**Amendment date:** 2026-07-31

**Tasks:** `audit-multinode-interteam-amendments`,
`review-interteam-plan-crossmodel`, `reconcile-interteam-prem-rulings`,
`reconcile-org-model-amendment`, `review-org-model-amendment`,
`revise-federation-plan-owner-decisions`,
`review-consolidated-owner-decisions`

**Independent reviews:** `output/review-interteam-comm-plan.md`,
`output/review-interteam-followup.md`,
`output/review-interteam-org-model.md`,
`output/review-consolidated-owner-decisions.md`

**Owner-decision reconciliation:**
`output/interteam-prem-rulings-reconciliation.md`

## Executive judgment

The seven accepted corrections remain correct:

1. A contact pins `(remoteNodeId, remoteTeamId)`, never address plus display
   name.
2. Contacts and send authority are scoped to the sending local team.
3. There is no `unlisted` or `invite_only` policy in V1. V1 has only `open`
   and `closed`.
4. Creating a sender-side contact is a local intent gate, not evidence of
   receiver consent.
5. Conversation IDs, message IDs, destination-side durable acceptance, and
   submission deduplication are V1 requirements.
6. Reply routing is a transport-authenticated protocol route, never a fetched
   sender-supplied URL.
7. `202 Accepted` means the destination manager committed the message.
   Handler work is a later `processing` state.

Prem's direct-agent amendment is also compatible with the manager-gateway
architecture. A destination may be either the remote team inbox or a named
agent in that team. The destination manager remains authoritative for local
resolution and no worker port is exposed. An `open` team does publish its
roster; `closed` publishes nothing.

Direct-agent addressing is not free, however. It adds:

- a second destination variant to the wire and persistence schemas;
- policy-ordering, privacy, availability, rename, deletion, and ambiguity
  behavior;
- a distinction between a stable pinned team identity and a late-bound agent
  **name**;
- a deliberately permissive consequence: an `open` team permits a trusted
  contacting team to start a conversation with any exact,
  locally addressable active agent, not just its inbox handler.

Those costs are manageable and do not justify rejecting the amendment. They do
require explicit contract and tests in commits 7–10.

The independent review correctly found that the prior draft left two
security-relevant direct-addressing choices open while calling commit 1 a
contract freeze. Prem has now decided both:

- each new direct conversation resolves the name exactly once and pins the
  immutable receiver-local agent ID at conversation creation;
- deleting and recreating a name may route a later **new** conversation to the
  replacement, but an existing conversation keeps the old pinned ID and fails
  loudly if that recipient was deleted;
- `open` is permissive. There is no triage gate and no
  `direct_agent_addressing`/`direct_addressing` flag. Team addresses route to
  the configured inbox handler; exact agent addresses route directly to that
  agent.

This is an intentional first-class path, not an oversight. Convention may
prefer team/handler addressing, but the system does not enforce that
convention. Tightening `open` later by adding a triage gate would be a breaking
policy change for contacts that rely on direct reachability and therefore
requires an explicit versioned migration, not a silent default change.

Prem's consolidated trust ruling is the governing V1 boundary:

- this is a private, trusted fleet;
- between nodes, Tailscale device admission and WireGuard peer identity are
  the authentication layer;
- within a node, the manager and all local workers are one host trust domain;
- a node that can reach the federation listener is trusted to state which of
  its locally hosted teams sent a message;
- V1 mints no application certificates, tokens, worker capabilities,
  per-team credentials, or receiver grants anywhere.

This is a deployment dependency, not a convenient assumption. A non-Tailscale
deployment is unsupported until the protocol gains real peer authentication.
The federation listener binds only the manager's tailnet interface, never
`0.0.0.0` and never a LAN interface, and must not be dual-bound. Tailnet ACLs
must restrict `tag:idagents` to `tag:idagents:<manager-port>`. The receiver
derives `nodeId` from the authenticated tailnet source identity through local
configuration (optionally verified with `tailscale whois`); it never trusts a
request-body `nodeId`.

The configured transport binding may be the authenticated tailnet source
address, whose anti-spoofing property comes from WireGuard, or a more durable
device identity resolved through `tailscale whois`/the Tailscale LocalAPI. If
the configured mode requires that lookup and it is unavailable, errors, or
times out, the request fails closed; it never silently downgrades to raw IP.

The accepted risk is explicit: compromise of one admitted node lets every
team on that node impersonate every other team on that node. That is acceptable
for the owner's machines and must be revisited before third-party teams are
hosted.

A compromised local same-UID process can also rewrite the peer map and admit a
foreign tailnet node. Decision 6 places that process inside the accepted host
boundary, so this is an accepted fleet-compromise path rather than a property
V1 claims to prevent. Peer-map changes remain explicit and audited for
diagnostics, not as a hostile-process security control.

`open` and `closed` are operational interruption/privacy controls, not an
adversarial security boundary. `closed` remains useful for a team under test
or one that must not be interrupted, and it withholds roster reads so the only
privacy control does not leak organization structure. It does not isolate a
team from a malicious admitted node or hostile same-UID local process.

The minimal `teams.inbox_handler_agent_id` field is sufficient to unblock V1
team-addressed messaging. It stores an immutable agent ID. At team creation,
the creation flow copies the resolved org lead's agent ID into the handler as
a one-time default. The two facts then diverge independently: later org
changes never silently reroute inbound messages, and later handler changes
never rewrite the org. If creation input has no unique resolvable lead, the
operator must select a handler explicitly before the team can become `open`;
the system must not guess from `metadata.catalog.role` or a conventional name
such as `cto`.

It is not, by itself, sufficient to delete `workspace/teams/<team>`. Folder
deletion has more prerequisites: legacy org backfill, DB-backed org rendering,
export and archive relocation, removal of worker shared-file routes and
environment variables, client/API replacements, and prompt/documentation
migration. The corrected order therefore treats local messaging and shared
folder removal as separate tracks after their common database foundation.

Prem's third amendment makes the complete organization model part of that
database foundation:

- teams are flat and remain the atom of node placement, federation identity,
  addressing, and inbound policy;
- groups recurse only inside one team;
- group leads and memberships reference immutable local agent IDs;
- organization-assigned tags are normalized separately from
  agent-asserted `metadata.catalog.expertise`;
- groups add no federation route or cross-node hierarchy read;
- open-team rosters and single-team tag filters are readable across nodes
  under the same inbound policy as messages.

This is better than unifying teams and groups. A recursive team would turn
organization edits into potential placement, addressing, policy, and
federation changes. The separate recursive group model preserves the useful
renderer behavior while keeping every hierarchy lookup node-local. The
rejection of `parent_team_id` is permanent and must be pinned in schema,
repository, API, protocol, and migration tests so a later implementation does
not reintroduce cross-node hierarchy accidentally.

The proposed table sketch needs five corrections before it is executable:

1. `org_groups` must retain the current renderer's nullable `description` and
   deterministic sibling order; `group_members` also needs deterministic
   member order if DB rendering is expected to preserve authored output.
2. Same-team constraints apply not only to parent groups but also to group
   leads and members.
3. Sibling group names need explicit normalized uniqueness, including a
   separate root-group unique index because SQL `NULL` semantics do not protect
   `(team_id, NULL, name)`.
4. Cycle prevention must be transactional and database-enforced in SQLite and
   Postgres, with defensive cycle/depth checks in readers and renderers.
5. `teams.node_id` should not be added to the local `teams` row. One manager
   already has one durable `manager_identity.node_id`; duplicating it on every
   team permits inconsistent ownership. Remote node/team pins belong in
   `team_contacts`.

There was also a real data-model conflict before the org migration: the stated
invariant said every group has a lead, but the
current YAML type and renderer make `lead` optional, and the live sources
contain three leadless groups (`idchain/marketing`,
`security/stack-agents`, and `security/specialists`). The recommended strict
model in the first third-amendment draft was `lead_agent_id NOT NULL`.
Independent review reversed that recommendation: these are valid rendered
groups (two are pools, one is a single-member group), and inventing leads would
make the org data less truthful. The accepted reconciled model is therefore
nullable `lead_agent_id`, with “no lead” explicit in APIs/renders and a
backfill warning. No missing lead is invented. This accepted seniordev
objection was not reversed by the consolidated rulings and is now settled.

The earlier manager-minted per-process worker capability is removed from V1.
It defended a hostile local-process boundary that decision 6 explicitly
declines to draw. Local worker headers and manager-owned launch context are
trusted inside the single-host domain; they remain structured for correctness
and audit, not authentication. Product/security review must never describe V1
as providing hostile same-UID tenant isolation.

## Repository facts that change the plan

### Org leadership and the inbox handler are separate facts

The `teams` table currently has:

```text
id, name, config, port_start, port_end, created_at
```

The YAML model is recursive and can contain zero or several group leads:

```text
org.groups.<group>.lead
org.groups.<group>.members
org.groups.<group>.groups
org.tags
```

`metadata.catalog.role = "lead/orchestrator"` is an unenforced presentation
field. It is neither unique nor team-authoritative. A team inbox handler is an
operational routing choice, not a live alias for “the lead.” Creation may use
a unique resolvable org lead as the handler's initial value, but that is a
one-time copy, not an ongoing derivation.

### Org persistence is partially implemented, but the normalized backfill is
fleet-wide

Current code is newer than the live row that was inspected:

- Deploy/import writes parsed org data to `teams.config.org` and still writes
  `workspace/teams/<team>/ORG_CHART.md`.
- `loadTeamOrg()` prefers `teams.config.org`, then falls back to the file named
  by `teams.config.last_config_path`.
- Tests cover new-row persistence and the legacy file fallback.

The installed fleet audit found that **all 9 of 9 teams** lack
`teams.config.org`; seven have only `{"last_config_path": ...}` and two have
empty config objects. The
backfill must therefore assume zero populated live rows, not treat this as an
edge case limited to a few legacy teams. A fresh read-only audit for this
amendment found:

- four teams have source `org` blocks (`dappa`, `idchain`, `security`,
  `tradeagent`);
- three teams have readable source files but no `org` block (`default`,
  `default2`, `lab`);
- two rows have neither `config.org` nor a `last_config_path` (`all`,
  `public`);
- the four source orgs contain seven groups, none nested yet, of which three
  are leadless;
- the sources contain eight tags and twenty tag-to-agent assignments;
- every currently named lead, member, and tagged agent resolves in its source
  team;
- the agents table has zero metadata tags and 42
  `metadata.catalog.expertise` arrays, confirming that expertise cannot be
  used as an org-tag backfill source.

Two source hazards also affect the backfill contract:

- `default` and `dappa` point into application-support directories rather than
  the repository; the current files exist, but a desktop rebuild/profile reset
  can orphan them, so dry-run, snapshot, and the per-team no-org override are
  operational requirements;
- the security library source is a `{{LOOP_OVER:stacks}}` template while the
  live `last_config_path` is the expanded file. Backfill/import must reject
  unexpanded `{{...}}` placeholders with `unexpanded_template`, not misreport
  them as unknown agent names.

The advertised warning's suggested repair is not real:

- `/export` reads legacy org but does not write it back to `teams.config`;
- `/deploy` is create-only and refuses a team that already contains agents.

There is currently no supported way to backfill an occupied team. A dedicated,
audited backfill is a hard prerequisite for removing either the YAML source or
the shared folder when that source lives there. The third amendment supersedes
the old plan's proposal to stop at opaque `teams.config.org`: the authoritative
result is normalized groups, leads, memberships, and tags.

Schema installation and live data movement are separate reviewable commits:

- a normal transactional SQLite/Postgres schema migration creates the empty
  normalized tables and invariants without performing external file I/O;
- an explicit, audited, idempotent application backfill reads each
  legacy `teams.config.org` first when present, otherwise
  `last_config_path`, validates and resolves the entire tree, rejects
  unexpanded templates, transposes `org.tags`, and commits one team atomically;
- a per-team journal records source hash, counts, result, operator, and time so
  a rerun cannot silently overwrite later DB edits;
- every team ends as normalized, explicitly `intentionally_no_org`, or blocked
  with a named remediation. The five teams without source org data must not be
  fabricated into groups.

The schema commit changes new deploy/import to write normalized rows and makes
the normalized reader authoritative. A tightly bounded transitional fallback
is permitted only for legacy teams with no `team_org_state`; it never prefers
the deprecated JSON. The backfill commit removes that fallback, clears or
freezes `teams.config.org`, and makes an unmigrated row fail visibly with
`org_migration_required` rather than reviving two authorities.

Backfill requires a dry-run report and DB snapshot before mutation. Each team
is atomic and tagged with a backfill batch ID. Undo either restores that
snapshot or removes a batch only when row versions prove there have been no
subsequent org edits; otherwise it refuses. The migration preserves group
descriptions and authored order, detects YAML alias/object cycles before
recursive traversal, and validates the whole team before writing any row. If
strict non-null group leads remain the owner decision, `idchain` and
`security` stay blocked until the three missing leads are assigned.

`ORG_CHART.md` is the only complete rendered chart, but not the only org
materialization. Deploy/spawn also writes derived per-agent org context into
the identity skill. That context contains a hard-coded instruction to read the
full chart from the shared team folder. It can also become stale after an agent
rename or org change. Both the full rendering and the derived prompts must be
migrated to the normalized reader.

### The shared team directory has more owners than the old plan listed

Current code:

- creates the root in the manager constructor;
- recreates a team directory in request middleware, team lookup, team create,
  deploy, spawn, local-agent startup, and well-known-team seeding;
- passes it to workers as `ID_SHARED_DIR`;
- exposes it from worker `/files/teams` and legacy `/files/shared`;
- includes it in worker file listings;
- writes `ORG_CHART.md` there;
- writes automatic team exports there;
- uses it as the fallback target for manual export;
- writes destructive news archives there before deleting the archived DB rows;
- advertises the path in skills, runtime output, CLI copy, and deployment docs.

The TUI also reads configs, agent output, and heartbeat files directly from the
host filesystem. Those are not all in the team folder, but they are the same
local-filesystem assumption that prevents a remote console from behaving
correctly.

The active team delete path deletes the DB row but does not delete or quarantine
the team directory. Deleting a team and later recreating the same name can
therefore expose stale org charts, archives, exports, or user files to the new
team. This is already a local data-isolation defect, independent of federation.

### Existing agent-name resolution is unsafe for federation

The agents table has no database uniqueness constraint on `(team_id, name)`.
Several repository helpers resolve an ambiguous name by selecting the newest
row. Federation must not reuse that behavior. An inbound direct-agent resolver
must be team-scoped, exact, and fail closed:

- zero matches: `recipient_not_found`;
- more than one match: `recipient_ambiguous`;
- one non-addressable or stopped match: `recipient_unavailable`.

It must never choose “most recent.”

### Existing local caller identity is sufficient inside the accepted host boundary

The manager currently treats `X-Id-Agent` plus team-scoped lookup as a local
caller assertion. That is not cryptographic proof, but decision 6 explicitly
treats the manager and all local workers as one host trust domain. V1 therefore
does not add a manager-minted worker capability or a separate operator token.

The local contract remains structured to prevent ordinary routing mistakes:

- manager-owned launch/runtime context supplies the expected agent and team;
- manager-internal calls pass typed caller context directly;
- request bodies never override a source team already supplied by that
  context;
- loopback operator routes require the existing operator context and audit
  mutations, but do not pretend that `X-Id-Admin` resists a hostile same-UID
  process;
- contact ownership and team joins are validated as data-integrity rules, not
  as tenant-security claims.

A malicious same-UID local worker may forge another local team's headers or
mutate manager-owned storage. That is accepted scope, not a V1 defect. If
third-party or hostile local tenants are introduced, remove direct worker DB
access, add OS/container isolation, and add authenticated local principals
before relying on these fields as an authorization boundary.

### Evidence map

The audit above is grounded in these current code surfaces:

| Finding | Current evidence |
|---|---|
| Team schema has no lead/handler/policy | `src/db/migrations/sqlite.ts:198-205`, `src/db/migrations/postgres.ts:42-50` |
| Recursive YAML org model | `src/config-parser.ts:171-190` |
| Group description/order and implicit lead membership are renderer behavior | `src/org-chart.ts:20-30`, `:35-91`, `:101-127`, `:197-209` |
| Tags are stored inverse in YAML and transposed for agent context | `src/org-chart.ts:161-189`, `:249-260` |
| DB-first org reader with YAML fallback | `src/agent-manager-db.ts:1005-1044` |
| Deploy persists org and still writes `ORG_CHART.md` | `src/agent-manager-db.ts:6114-6140` |
| Export does not backfill legacy org | `src/agent-manager-db.ts:5475-5520`; the legacy behavior is pinned in `tests/integration/export-org-block.test.ts:154-181` |
| Agent identity context references the shared folder | `src/agent-manager-db.ts:3104-3106`, `src/agent-manager-db.ts:6273-6276` |
| Manager and request paths recreate team directories | `src/agent-manager-db.ts:458-464`, `:758-766`, `:1658-1676`, `:2858-2875`, `:6048-6062`, `:7748-7762` |
| Workers receive/serve the shared directory | `src/agent-manager-db.ts:598-616`, `src/start-agent-manager.ts:103-110`, `src/claude-agent-server.ts:330-489` |
| Auto-export and manual fallback use the team directory | `src/lib/auto-export.ts:17-31`, `src/lib/export-team-config.ts:415-430` |
| News archive uses the team directory | `src/agent-manager-db.ts:2453-2492` |
| Profile mutation reaches back into YAML | `src/agent-manager-db.ts:3548-3578`, `src/lib/profile-config-write.ts` |
| TUI reads local config/output/heartbeat files | `src/tui/App.tsx:1018-1115`, `src/tui/components/HeartbeatDetail.tsx:118-151` |
| Exact agent names are not unique and ambiguous helpers choose newest | `src/db/repos/sqlite/agents-repo.ts:42-61`, `src/db/repos/postgres/agents-repo.ts:22-41` |
| New local principal would otherwise rely on asserted headers | `src/agent-manager-db.ts:1625-1700` |
| Workers currently receive identity through environment and open the shared DB | `src/agent-manager-db.ts:590-616`, `src/agent-manager-db.ts:8170-8310`, `src/start-agent-manager.ts:95-137` |
| Team delete removes the row but not its directory | `src/agent-manager-db.ts:4848-4888` |

## V1 contract

### Identity and contacts

Each manager has one durable logical `nodeId` in local federation
configuration. For inbound traffic, that ID is derived by mapping the
authenticated Tailscale source identity to the configured peer; a request-body
or envelope claim never establishes it. The configuration rejects duplicate
tailnet identities or duplicate `nodeId` mappings.

A sender-side contact (formerly TeamLink) is scoped by:

```text
(local_team_id, alias_normalized) UNIQUE
```

It pins:

```text
(remote_node_id, remote_team_id)
```

Its node pin resolves through the locally configured tailnet peer map; there is
no application credential or arbitrary sender-supplied locator. Neither a
display name nor an endpoint is identity. Target team deletion and same-name
recreation leave the contact broken with `target_identity_missing`; they never
retarget it.

Contact creation says only: “this local team intends to send to that pinned
destination.” It is a local intent/ergonomics gate, not receiver-verifiable
consent. For V1 `open`, the receiving team admits cold starts from any admitted
node that can reach it. The receiver trusts the origin-team label because it
trusts the source node; V1 has no origin-bound grant, per-team credential, or
invite handshake.

### Address forms

The agent-facing namespace remains explicit:

```text
team:<local-contact-alias>
team:<local-contact-alias>/<remote-agent-name>
```

The structured API and wire format do not depend on parsing that display
syntax:

```json
{ "kind": "team" }
```

or:

```json
{ "kind": "agent_name", "name": "cto" }
```

The sender resolves only the contact alias for delivery. It may separately ask
an `open` destination for its live roster, but it does not store remote agents
as local identity rows and roster data never overrides receiver-local name
resolution at conversation creation.

For a **new** direct-agent conversation, the receiver resolves the exact
current local `agents.name` inside the already-resolved destination team. It
does not use catalog role, metadata alias, ENS fallback, global lookup, or a
most-recent rule. At conversation creation, the receiver pins the immutable
local agent ID. Continuations never re-resolve the name. New direct
conversations are admitted whenever the team is `open`; there is no separate
direct-addressing gate.

This means the name is resolved late for each new conversation, while the
resulting conversation is ID-pinned. Rename and delete/recreate behavior must
be visible:

- after a rename, a new cold send to the old name fails and the new name works;
- an already accepted conversation continues by immutable agent ID and never
  retargets;
- if a deleted name is later reused, a new cold conversation resolves to the
  replacement, while the old conversation fails `recipient_deleted`.

That last behavior is the explicit V1 contract, not an unresolved question.
“Specific agent” means exact receiver-local name resolution at the start of a
new conversation plus immutable-ID continuity after acceptance. It does not
mean stable identity across later new conversations. A future stronger mode
may reserve deleted names; V1 neither implements nor implies that guarantee.

### Roster reads use the same inbound policy as messages

This section explicitly **overrides seniordev's previously accepted objection**
that `open` should not implicitly expose named agents. Prem's rationale is
coherent: open-team result codes already permit name enumeration, so hiding the
roster bought no meaningful privacy while removing useful discovery.

Every descriptor, roster, and tag-filter read follows the same pipeline as a
new message:

```text
derive nodeId from tailnet source -> resolve destination team -> apply policy -> answer
```

An `open` team publishes its descriptor and roster. A `closed` team publishes
nothing and returns `target_closed` before loading any roster rows. The policy
is operational, not an adversarial boundary, but applying it in the same place
prevents `closed` from accidentally leaking organization structure.

The V1 descriptor contains team-level data plus a live roster snapshot:

```text
protocolVersion
nodeId                     // consistency field; transport-derived identity is authoritative
teamId
teamDisplayName
inboundPolicy
supportedAddressModes       // team, agent_name
message/descriptor limits
snapshotAt
agents[]:
  addressName
  nameResolution             // unique | ambiguous
  displayName
  catalogRole                // agent-asserted presentation; non-authoritative
  availability
  organizationTags[]
```

It does not expose immutable local agent IDs, models, ports, URLs, wallets,
paths, tasks, group hierarchy, or a lead hint. The snapshot is discovery data,
not identity authority: delivery still resolves an exact `addressName` inside
the destination team and pins the receiver-local immutable ID.

`catalogRole` is agent-asserted presentation metadata, not organization
authority or a routing selector. Delivery never consults it. `availability` is
a point-in-time observation at `snapshotAt`, not a promise or cache-validity
window; acceptance revalidates current availability.

The projection includes every non-deleted agent row in the team; stopped or
otherwise unavailable agents remain visible with their observed availability.
When multiple live rows have the same name under the direct resolver's
exact-name equivalence rule, every matching roster entry is marked
`nameResolution: ambiguous`. Clients must not offer that name as a working
direct selector, and a send still returns
`recipient_ambiguous`; the roster never chooses or deduplicates a winner.

Any local agent may initiate this read through a contact owned by its local
team. V1 adds no per-agent or per-role roster credential inside the accepted
host trust domain.

V1 has no generic untyped “public catalog” escape hatch. Additional fields need
an explicit content contract, size bound, and tests.

### Single-team cross-node tag query is in V1; federation-wide fan-out is not

Once an open roster publishes organization tags, a tag filter adds no new
disclosure or trust boundary. V1 therefore supports “which agents in this
pinned destination team are tagged `sales`?” as a single-team manager read.
It uses the same resolve-team/apply-policy pipeline, the normalized indexed
tag lookup, the exact same shared roster projection function, and the same
response bounds.

V1 does **not** add node-wide, multi-contact, or federation-wide server fan-out.
Those operations introduce target selection, deadlines, duplicate merging,
and partial-result semantics unrelated to roster privacy. A client may issue
independent single-team reads and show each target's success or failure; a
standard aggregated protocol waits for a later design.

### Destination policy and resolution order

For a genuinely new inbound submission, the receiving manager must:

1. derive the peer `nodeId` from Tailscale transport identity, or accept a
   same-manager caller inside the host trust domain;
2. accept the asserted origin-team label as a trusted-node claim;
3. resolve the destination **team ID** locally;
4. classify the submission as a cold start or an authorized continuation;
5. apply that team's inbound policy;
6. apply node/origin-team backlog and rate limits;
7. only then resolve the destination variant:
   - team address: resolve `inbox_handler_agent_id`;
   - direct address: resolve the exact agent name inside that team;
8. validate that the chosen agent belongs to the team, is not deleted, is
   processing-capable, and is presently available;
9. commit the message and return `202`.

The team is the unit of policy in both modes. A closed team therefore returns
`target_closed` before looking up an agent name. Tests must prove that the
agent resolver is not called on that path. An open team does resolve exact
agent names: that permissive reachability is the decided policy.

There are two necessary exceptions to the apparent order:

- An authenticated retry with an already accepted
  `(submitter_node_id, message_id)` is looked up before current policy and
  availability are re-evaluated. If its canonical request hash matches, the
  receiver returns the existing state. Closing a team, stopping a handler, or
  renaming an agent after acceptance cannot turn the same accepted message
  into a rejection.
- A continuation first resolves the durable destination-side conversation
  authorization. It does not become a new cold start merely because the team
  later closes.

Neither exception allows an arbitrary target: both rely on durable rows created
by an earlier authorized acceptance.

### Policy meaning

V1 has:

```text
closed
open
```

`closed` rejects new conversations. It may allow a continuation only when an
active destination-side conversation row authorizes that origin and route.
That exception applies to message continuations only. Descriptor, roster, and
tag-filter reads always return `target_closed` with no payload, even when the
caller has an active conversation.

`open` admits cold starts from trusted nodes both to the team inbox and directly to
an exact named agent. For a team address, the database-configured inbox handler
receives the work. For a direct address, the exact agent receives it without a
triage gate. This permissive default is intentional; adding a gate later is a
breaking policy change.

There is no `unlisted`, and V1 does not implement `invite_only`.

### Durable acceptance, deduplication, and status

The sending manager creates and durably records `conversationId` and
`messageId`; agents do not choose them. The same envelope is reused when a
transport response is lost.

V1 conversations are ordered independently in each direction. The submitting
manager for that direction serializes submission and records a monotonically increasing
`direction_sequence` plus the preceding message ID. A destination
transaction handles accepted-message dedup first, then accepts only the next
sequence for that conversation direction. It processes at most one message per
conversation direction at a time. Concurrent branches use separate
conversation IDs; V1 does not claim arbitrary concurrent-turn merge semantics.

The destination manager enforces:

```text
UNIQUE(submitter_node_id, message_id)
```

For a message row, `submitter_node_id` and `submitter_team_id` identify the
manager/team that submitted that specific direction. They are not the
conversation initiator fields: on a reply they differ from
`interteam_conversations.origin_node_id` and `origin_team_id`. It stores a
canonical request hash. A duplicate with the same hash returns the existing
message and `deduplicated: true`. A duplicate ID with different submitter,
destination, recipient, conversation, or body returns `idempotency_conflict`.

`202 Accepted` is returned only after the destination transaction commits. It
means neither “the handler saw it” nor “the model started.”

Destination message states are:

| State | Meaning |
|---|---|
| `accepted` | Destination manager durably committed the message. No handler query is yet confirmed. |
| `processing` | A durable local handler query/job mapping exists and processing has been enqueued or claimed. |
| `completed` | A terminal result/reply was durably recorded. |
| `failed` | A known terminal failure was durably recorded with a stable code and last confirmed state. |
| `unknown` | The destination cannot prove the handler outcome after a failure boundary. This is not proof that work failed. |

The normal transition is:

```text
accepted -> processing -> completed
```

`accepted` or `processing` may become `failed` or `unknown`. Confirmed state
never moves backward. `unknown` is not proof of a terminal outcome: if later
durable evidence establishes the handler result, it may move to `completed` or
`failed`, but never back to `accepted` or `processing`. Otherwise it remains
`unknown` for operator reconciliation. “Delivered” is not used as a synonym
for either acceptance or processing.

V1 submission deduplication is not an exactly-once claim. Safe resubmission of
the same manager-to-manager envelope after a lost response is required.
Automatic retry policy, cancellation, handler redelivery, and exactly-once
handler execution remain deferred.

Deduplication is checked before capacity limits so an accepted retry always
returns its existing state. New submissions are bounded from the first local
delivery slice: maximum body size, per-team accepted/processing backlog,
per-origin rate, per-direct-recipient-agent backlog, and processor concurrency
are configurable and have safe defaults. The per-recipient bound prevents one
contact from saturating a critical directly addressed agent while remaining
under team-wide limits. Capacity rejection happens before durable acceptance
with a stable `receiver_busy` or `message_too_large` result; accepted rows are
never dropped to enforce a quota.

Descriptor/roster/tag reads have a per-source-node request-rate bound, maximum
agent count, maximum tag count/length, and maximum encoded response size. A
result that cannot fit is rejected with a stable bounded-read error rather than
silently truncated into an apparently complete roster.

### Reverse replies

The origin manager creates an opaque reverse route bound to:

```text
(conversation_id, origin_node_id, origin_team_id,
 local_owner_kind, local_owner_id, expected_peer_node_id)
```

The wire carries only the opaque route reference and conversation identity. A
reply is another transport-authenticated protocol message. The origin manager
verifies that the tailnet-mapped peer and conversation match the stored route, then
delivers locally.

No envelope contains `replyUrl`, callback URL, worker port, filesystem path, or
arbitrary manager URL. For remote operation, either the origin polls the
transport-mapped destination manager or the destination uses the locally
configured tailnet peer entry for `origin_node_id`; it never fetches a locator supplied
inside the message.

Reverse routes and conversation history never cascade-delete with a local
owner agent or team. Normal team deletion is blocked while active routes or
non-terminal conversations remain. An explicit force-delete transaction
revokes the routes with a durable reason, marks affected local work with a
stable terminal/orphaned outcome as appropriate, then deletes the team.
Subsequent replies fail `origin_route_revoked`; they are never retargeted to a
same-name replacement team or agent.

## Handler and direct-recipient lifecycle

`teams.inbox_handler_agent_id` is a nullable foreign key-like operational
reference. Service validation and database invariants must enforce same-team
membership and reject a deleted or non-processing-capable agent.

At team creation, copy the unique resolvable org lead's immutable agent ID
into `inbox_handler_agent_id` as the default. Persist the two values
independently. A later reorg, lead rename/replacement, or `config.org` backfill
must not mutate the handler; changing the handler requires an explicit routing
operation and must not mutate org leadership. If the creation-time org has no
lead or more than one candidate, do not guess: leave the handler null and keep
the team `closed` until the operator chooses one.

“Unique” is evaluated across the full recursive org tree by **distinct
resolved agent ID**, not by group count or traversal order. The same agent
leading two groups counts once. Every declared lead must resolve exactly
inside the team; zero leads, any unresolved/ambiguous lead, or more than one
distinct resolved lead ID means there is no safe default. Because deploy
creates the team/config row before agent rows, this copy runs as an
end-of-deploy finalization step after all configured agents exist, before
deploy reports success or the team may become `open`.

Selecting a handler may be allowed while it is stopped, but changing a team to
`open` requires a valid, currently available handler in the same transaction.
If that handler later stops, the team remains visibly open but degraded.
Therefore `open => available handler` is a transition-time guard, not a
maintained database invariant. Every read/API that reports `open` must also
report handler health; downstream code must not infer availability from policy
alone. If the handler is deleted, “degraded” applies only to team-addressed
routing: direct-agent cold starts remain permitted while team-addressed starts
return `handler_unavailable`.

| Event | Team-addressed new send | Already accepted team-addressed message | Direct-agent new send | Already accepted direct-agent message |
|---|---|---|---|---|
| Handler/recipient running | Accept | Advance to `processing` when local query is durable | Accept | Advance normally |
| Handler/recipient stopped | `handler_unavailable` | Stay `accepted`; resume after the configured handler is available | `recipient_unavailable` | Stay `accepted`; resume if the same agent ID returns |
| Handler/recipient renamed | No effect; handler ID is stable | No effect | Old name: `recipient_not_found`; new name may accept | No effect; conversation is ID-bound |
| Inbox handler deleted | Clear `inbox_handler_agent_id`; `handler_unavailable` | Stay `accepted`; a replacement handler may process it because the team, not the old handler, was addressed | N/A | N/A |
| Direct recipient deleted | N/A | N/A | `recipient_not_found` | Terminal `failed` with `recipient_deleted` |
| Inbox handler replaced | New team sends use replacement | Pending team messages may use replacement | N/A | N/A |
| Destination team deleted | `target_identity_missing` | Mark accepted/processing messages `failed: target_deleted` before completing deletion, or block deletion until drained | Same | Same |

The current hard-delete agent path means `ON DELETE SET NULL` or an equivalent
transactional service is needed for `teams.inbox_handler_agent_id`. Historical
message rows must not cascade away with agent or team deletion. Durable
acceptance is incompatible with `ON DELETE CASCADE` for conversation history.

## V1 persistence model

Exact column naming can follow repository conventions, but the following
information is not optional.

### Node identity

```text
manager_identity(
  singleton_key,
  node_id UNIQUE,
  created_at,
  updated_at
)
```

The local federation config binds that `node_id` to the manager's current
Tailscale device identity at startup. Peer configuration maps each allowed authenticated
tailnet identity to one `nodeId` and tailnet address. Copying a database does
not copy transport identity; a copied manager must receive its own explicit
mapping before federation starts. No application key or credential is minted,
rotated, or revoked.

### Team settings

Prefer explicit columns, not more keys in the shallow-merged `teams.config`
JSON:

```text
teams.inbound_policy              NOT NULL DEFAULT 'closed'
teams.inbox_handler_agent_id      NULL
```

The handler is an immutable agent ID. SQLite and Postgres need repository
contract parity and migration tests. A trigger or equivalent invariant covers
hard deletion; every service mutation also validates same-team membership.

There is deliberately no `teams.parent_team_id` and no per-row
`teams.node_id`. Team ownership is the tuple
`(manager_identity.node_id, teams.id)`; remote ownership is represented only
by opaque pins in contacts.

### Normalized organization

The DB model preserves the recursive YAML semantics without making groups
federated:

```text
org_groups(
  id,
  team_id,
  parent_group_id NULL,
  name,
  name_normalized,
  description NULL,
  sibling_position,
  lead_agent_id NULL,               -- accepted: leadless groups are valid
  created_at,
  updated_at,
  UNIQUE(id, team_id)
)

group_members(
  group_id,
  team_id,
  agent_id,
  member_position,
  PRIMARY KEY(group_id, agent_id)
)

agent_tags(
  agent_id,
  tag_normalized,
  tag_display,
  created_at,
  PRIMARY KEY(agent_id, tag_normalized)
)

INDEX agent_tags_by_tag(tag_normalized, agent_id)

team_org_state(
  team_id PRIMARY KEY,
  state,                              -- configured | intentionally_none
  source_hash NULL,
  decided_by,
  decided_at,
  reason NULL
)
```

The apparently redundant `team_id` in `group_members` exists so both
`(group_id, team_id) -> org_groups(id, team_id)` and
`(agent_id, team_id) -> agents(id, team_id)` can be database-enforced.
`org_groups` uses the same composite-FK pattern for its parent and lead.
The migration must add the supporting unique `(id, team_id)` keys on
`agents` and `org_groups`. SQLite and Postgres need equivalent constraints,
not merely service checks.

`team_org_state` distinguishes a deliberately empty org from a team that has
not been migrated. A blocked attempt remains an audit/backfill result rather
than authoritative org state; it cannot satisfy the folder-removal gate.

Sibling group names are unique by normalized name within one parent. Because
`NULL` values do not behave like a normal key in unique constraints, root
groups need a partial unique index on `(team_id, name_normalized)` where
`parent_group_id IS NULL`; non-root groups need a partial unique index on
`(team_id, parent_group_id, name_normalized)` where it is not null.

The same root/non-root pattern makes `sibling_position` unique within its
parent, while `(group_id, member_position)` is unique for direct members.
Positions are non-negative, dense `0..n-1`, and are renumbered atomically on
insert, delete, move, or reorder. Readers order by position and use immutable
ID only as a corruption-safe tie-breaker. Backfill preserves YAML insertion
order.

`name_normalized` and `tag_normalized` are produced only by one shared
application function:

```text
normalizeOrgKey(value) =
  reject controls / enforce length
  then value.normalize("NFKC").trim().toLowerCase()
```

The database constrains the stored normalized value; it does not independently
call SQLite/Postgres case-folding functions. Parser, migration, repository,
and service tests use the same Unicode/case/whitespace vectors.

A lead is implicitly included when recursively collecting a group's people,
matching `org-chart.ts`; it need not also have a `group_members` row. If the
source explicitly lists the lead as a member, backfill may retain that fact,
but all rendered and query results deduplicate by agent ID. Agents may belong
to multiple groups. No primary-group restriction is implied.

Parent changes run in a transaction and are database-rejected if they create a
cycle. Commit 2 begins with a SQLite/Postgres feasibility test for recursive
CTE triggers; if either database cannot enforce that portably, use a
closure/materialized-path invariant rather than weakening this to a
service-only check. Readers still carry a visited set and enforce a documented
maximum depth and total-node bound; database corruption or a future missed
write path must fail closed instead of overflowing the renderer. “Arbitrarily
nested” means the model is recursive, not that an unauthenticated input may
consume unbounded stack or response size.

Group deletion is `RESTRICT` when children exist. A separate explicit
recursive-delete operation previews and audits a subtree removal; deletion
never silently reparents or cascades children. Team deletion may cascade its
node-local org rows.

Agent soft deletion is an application transaction, because foreign keys do not
fire on `deleted_at`: it is blocked while the agent is a group lead until the
operator explicitly replaces or clears that lead, and it removes direct
membership/tag assignments. Hard deletion uses the same preflight; lead
references restrict, while membership/tag rows may cascade. Every org/tag
reader also filters `agents.deleted_at IS NULL` and surfaces legacy dangling
lead state rather than returning ghosts. Restoring a soft-deleted agent does
not silently restore old org assignments.

Tags are keyed globally by immutable agent ID because an agent already belongs
to exactly one team. A team filter is a join through `agents.team_id`; adding
`team_id` to `agent_tags` would duplicate scope without changing semantics.
Tags are normalized for exact indexed search while retaining display spelling.
The manager's org-admin API is the only write surface and authorizes by joining
the target agent to its team. Agent-owned `/catalog` writes cannot reach this
table. This separation enforces organizational authority at the service/API
boundary; it does not pretend to provide hostile same-UID isolation while
workers can still open manager-owned storage directly. Any UI/search that
shows both sources labels them “organization tag” and “agent-asserted
expertise”; visual ambiguity would undo the authority separation.

### Sender contacts

```text
team_contacts(
  id,
  local_team_id,
  alias_normalized,
  alias_display,
  remote_node_id,
  remote_team_id,
  display_name NULL,
  created_at,
  updated_at,
  UNIQUE(local_team_id, alias_normalized)
)
```

`local_team_id` is the owner and may cascade on local team deletion.
`remote_node_id` and `remote_team_id` are opaque pins and are not foreign keys.
Transport lookup for `remote_node_id` comes only from the local tailnet peer
configuration, never from the contact or a remote response.

### Conversations and reverse routes

```text
interteam_conversations(
  conversation_id,
  origin_node_id,
  origin_team_id,
  destination_node_id,
  destination_team_id,
  destination_kind,                  -- team | agent_name
  destination_agent_id NULL,         -- receiver-local, direct mode only
  destination_name_at_acceptance NULL,
  recipient_binding_ref NULL,        -- opaque origin-visible direct binding
  state,
  created_at,
  updated_at,
  closed_at NULL
)

interteam_reverse_routes(
  route_id,
  conversation_id,
  local_team_id,
  local_owner_kind,                  -- agent | manager
  local_owner_id,
  expected_peer_node_id,
  expires_at NULL,
  revoked_at NULL,
  revocation_reason NULL
)
```

The receiver does not return `destination_agent_id` over the wire. For direct
mode it returns an opaque, unguessable `recipient_binding_ref` at acceptance.
The origin stores it with the conversation. On continuation, the receiver
compares the bound agent's current name to `destination_name_at_acceptance`
and returns a `recipient_name_drift` notice when they differ. A later new
conversation to a reused name receives a different binding reference, so the
origin can surface identity drift without learning a local immutable agent ID.

### Messages and processing mapping

```text
interteam_messages(
  message_id,
  conversation_id,
  submitter_node_id,                 -- sender of this message direction
  submitter_team_id,
  destination_node_id,
  destination_team_id,
  direction,
  direction_sequence,
  predecessor_message_id NULL,
  recipient_kind,
  recipient_name NULL,
  resolved_agent_id NULL,
  canonical_request_hash,
  body,
  status,
  failure_code NULL,
  last_confirmed_status,
  accepted_at,
  processing_at NULL,
  completed_at NULL,
  updated_at,
  UNIQUE(submitter_node_id, message_id),
  UNIQUE(submitter_node_id, conversation_id, direction, direction_sequence)
)

interteam_processing(
  message_id UNIQUE,
  local_query_id UNIQUE,
  handler_agent_id,
  attempt_no,
  created_at,
  updated_at
)
```

The durable message is the protocol record. Existing `queries` may remain the
local handler mechanism, but a durable one-to-one mapping is required before
the message can be called `processing`.

## Pre-accept result contract

These are request outcomes for a new submission or policy-gated read, not
accepted message states:

| Code | Meaning |
|---|---|
| `invalid_address` | Contact alias or direct-name address syntax is invalid |
| `contact_not_found` | Derived source team has no matching local contact |
| `source_unauthorized` | Local trusted caller context conflicts with the selected contact owner |
| `target_identity_missing` | Pinned `(nodeId, teamId)` no longer resolves |
| `target_closed` | Destination team rejects a new conversation |
| `handler_unavailable` | Team address has no valid available inbox handler |
| `recipient_not_found` | Open/authorized team has no exact current direct-agent name |
| `recipient_ambiguous` | More than one current row matches; receiver refuses to choose |
| `recipient_unavailable` | Direct recipient exists but cannot currently accept processing |
| `conversation_order_conflict` | New message is not the next allowed sequence/predecessor for that conversation direction |
| `receiver_busy` | Trusted new submission exceeds a receiver backlog/rate bound |
| `message_too_large` | Message exceeds the receiver's advertised hard size bound |
| `read_rate_limited` | Descriptor/roster/tag read exceeds its per-source-node request bound |
| `read_response_too_large` | Complete read result exceeds the advertised count/encoded-size bound; never silently truncated |
| `idempotency_conflict` | Reused message ID has different canonical content |
| `protocol_unsupported` | No compatible protocol version |

Policy runs before direct-agent resolution, so a closed team never returns
recipient existence information. An open team may return exact-recipient
errors because direct addressing is an intentionally permitted path.
Accepted-message dedup runs before mutable policy, ordering, or capacity
checks. New codes require a contract change; existing codes are not
repurposed.

## Corrected phase and commit order

The old plan coupled messaging, org migration, and folder deletion too tightly,
while deferring durability too late. The reconciled sequence has sixteen
reviewable commits. Commits 1–10 deliver the normalized-org foundation and
durable same-manager V1 contract. Commits 11–13 remove the shared-folder
dependency. Commits 14–16 add remote
transport without changing the message contract.

The direct-name pinning, permissive `open`, readable-roster, Tailscale-only
transport trust, and single-host boundary are settled owner decisions rather
than open placeholders.

### Phase A — Freeze the executable contract

#### Commit 1 — Protocol types, parser, state machine, and contract tests

- Add no network path and no behavior flag.
- Define versioned destination, envelope, response, error, and descriptor
  types.
- Freeze `team:<alias>` and `team:<alias>/<agent-name>` display parsing.
- Freeze exact-name resolution at new-conversation creation and immutable
  agent-ID pinning thereafter.
- Freeze permissive `open`: team targets use the handler; agent targets route
  directly, with no triage gate or direct-addressing flag.
- Freeze ordered per-direction conversation turns and predecessor conflicts.
- Freeze `submitter_node_id`/`submitter_team_id` as the sender of each message
  direction; they differ from conversation-origin fields on replies.
- Freeze `accepted -> processing -> completed|failed|unknown` plus evidence-led
  `unknown -> completed|failed`.
- Freeze `open` descriptor/roster reads and single-team tag filters, including
  the same resolve-team/apply-policy ordering as messages; freeze `closed` as
  publishing nothing.
- Freeze groups out of the federation protocol: no parent team, hierarchy
  route, or cross-node group read.
- Freeze Tailscale transport identity as the only V1 node-authentication
  source and record that `nodeId` is never self-declared.
- Record the accepted host trust domain and the absence of any V1 local
  caller credential.
- Add pure tests for parsing, canonical request hashing, ordering, legal
  transitions, stable errors, policy-gated roster/tag reads, and descriptor
  field bounds. Contract fixtures cover ambiguous roster names,
  non-authoritative `catalogRole`, snapshot availability, closed-read
  suppression, and bounded-read errors.

**Gate:** contract tests run without a manager process and contain no endpoint
or worker URL.

### Phase B — Durable local foundation

#### Commit 2 — Normalized recursive org schema, constraints, and DB authority

- Add `org_groups`, `group_members`, `agent_tags`, and `team_org_state` in a
  dedicated SQLite and Postgres migration.
- Permanently omit `teams.parent_team_id` and redundant `teams.node_id`.
- Preserve description, sibling/member order, recursive parentage, lead IDs,
  memberships, and tags.
- Add composite same-team foreign keys for parent, lead, and member references;
  partial sibling-name unique indexes; membership/tag uniqueness; indexed
  normalized tag lookup; position constraints; soft-delete service semantics;
  and transactional cycle prevention.
- Freeze `normalizeOrgKey`, subtree deletion, position renumbering, and
  soft/hard agent-deletion contracts in repository tests.
- Prove a portable DB-enforced cycle invariant in both engines before settling
  on recursive triggers versus closure/materialized path.
- Add defensive visited/depth/node bounds to the DB reader and renderer.
- Make normalized org rows authoritative for new deploy/import and DB-based
  org mutation. YAML remains import/export, not live authority.
- Make `loadTeamOrg()` read normalized state first and never prefer
  `teams.config.org`; allow only a bounded legacy fallback while
  `team_org_state` is absent.
- Render the full org chart and per-agent org context from the normalized
  reader and prove parity, including a newly added nested-group fixture.
- Keep `agent_tags` separate from `metadata.catalog.expertise`; prove agent
  `/catalog` mutation cannot write org tags and label both sources distinctly.

**Gate:** SQLite/Postgres parity, normalization, ordering, soft-delete,
subtree-delete, and cycle tests pass; new deploy/import renders a nested org
from normalized rows; the deprecated JSON never wins authority; no live fleet
data has moved.

#### Commit 3 — Audited nine-team normalized org backfill

- Add the explicit dry-run-first backfill with mandatory DB snapshot, batch ID,
  per-team transaction/journal, source hash, counts, operator, and timestamp.
- Read legacy `teams.config.org` when present, otherwise
  `last_config_path`; reject unexpanded `{{...}}` templates distinctly.
- Transpose `org.tags: {tag: [agent names]}` into agent-keyed rows.
- Treat 0/9 populated rows as the live baseline. Classify all nine teams as
  normalized, explicitly `intentionally_no_org`, or blocked; do not fabricate
  data for the five current rows without source org.
- Resolve every lead, member, and tag target exactly inside the same team and
  abort that team's transaction on unknown or ambiguous names.
- Record the two fragile app-support source paths in dry-run output.
- Preserve nullable leads with an explicit warning; never invent the three
  missing lead assignments.
- Remove the legacy runtime fallback after terminal classification and clear
  or freeze `teams.config.org`; an unmigrated row fails
  `org_migration_required`.
- Add a batch undo that refuses after later org edits; otherwise document
  snapshot restore as the recovery path.
- Prove backfill never mutates `inbox_handler_agent_id`.

**Gate:** all nine live teams have an audited terminal classification; the four
source orgs preserve seven groups, descriptions/order, twenty tag assignments,
and all recursive member results; any unresolved reference, template, or
missing-source decision blocks only its team and is never silently dropped.

#### Commit 4 — Tailnet-mapped node identity, team policy/handler, and contacts schema

- Add durable logical `node_id` plus its local configured Tailscale identity
  binding; add peer config validation for one-to-one tailnet-identity/`nodeId`
  mappings.
- Add `teams.inbound_policy` closed by default.
- Add `teams.inbox_handler_agent_id`.
- Add `team_contacts` with local-team alias uniqueness and opaque remote pins.
- Add SQLite and Postgres repository methods and parity tests.
- At end of deploy, after configured agents and normalized org rows exist,
  collect every group lead from the DB tree, deduplicate by immutable agent ID,
  and copy the sole distinct ID into the handler once.
- Require explicit selection when there are zero leads, any
  unresolved/ambiguous lead, or multiple distinct lead IDs.
- Prove later org changes/backfill do not rewrite the handler and explicit
  handler changes do not rewrite org leadership.
- Audit existing duplicate/invalid handler candidates; do not infer a handler
  from catalog role or conventional name.
- Refuse startup when the local tailnet identity does not match its configured
  node mapping; database cloning alone never establishes a federation identity.

There are deliberately no node certificates/tokens, receiver-issued grants,
per-team credentials, or `invite_only` rows. This is the rescope of the former
“node authentication and optional team grants” commit; identity proof is a
transport/config concern and the application schema is substantially smaller.

**Gate:** an existing multi-team database migrates closed with null handlers,
keeps a stable configured node ID across restart, refuses duplicate peer
mappings, and has no automatically created contacts or grants.

#### Commit 5 — Durable conversations, messages, reverse routes, and submission dedup

- Add the conversation, message, reverse-route, and processing-mapping tables.
- Preserve history across agent deletion and define team-deletion handling.
- Add unique `(submitter_node_id, message_id)` and canonical-hash conflict
  logic.
- Add per-direction sequence/predecessor fields and transactional head checks.
- Add origin-side durable allocation of conversation/message IDs.
- Preserve and revoke reverse routes explicitly rather than cascading them.
- Add repository-level transaction and restart tests.

**Gate:** a committed acceptance survives manager restart; replay returns the
same row; changed content under the same ID conflicts.

#### Commit 6 — Trusted local source context and operator configuration

- Reuse manager-owned launch/runtime context and typed internal caller context;
  keep `X-Id-Agent`/team headers as trusted local assertions inside the
  accepted host domain.
- Derive `local_team_id` from that context when available and never allow a
  request-body team field to override it.
- Require an explicit team context for operator actions and audit mutations;
  do not introduce a separate operator credential in V1.
- Add operator APIs for contact CRUD, handler selection, inbound policy, and
  normalized org/group/member/tag inspection and mutation.
- Permit selecting a stopped same-team processing-capable handler, but require
  availability when switching a team to `open`.
- Add atomic clear-on-agent-delete behavior and degraded-state reporting.
- Add tests proving caller/team mismatches fail as correctness violations and
  that request bodies cannot accidentally select another contact owner.
- Document and test the accepted single-host trust boundary, including that a
  malicious same-UID worker can forge another team's assertion and that V1
  deliberately does not defend against it.

**Gate:** ordinary manager/worker flows preserve source-team context, the same
alias can safely exist in two local teams, and no local authentication token or
capability exists to be leaked or mistaken for hostile-tenant isolation.

### Phase C — Same-manager V1 delivery

Direct-agent addressing materially changes every commit in this phase.

#### Commit 7 — Destination union and strict receiver-local resolution

- Resolve the contact pin first.
- Resolve the destination team by immutable ID.
- Implement the `team` and `agent_name` variants.
- Add an exact team-scoped direct-name resolver that rejects ambiguity and
  never uses the current most-recent fallback.
- Define processing-capable agent kinds and availability in one shared
  predicate.
- Bind an accepted direct conversation to immutable local agent ID.
- Return/store an opaque recipient binding reference and surface name drift
  without exposing the local agent ID.

**Direct-address tests:** valid active agent, unknown name, ambiguous name,
stopped agent, wrong team, rename before and after acceptance, delete, and
delete/recreate same name.

#### Commit 8 — Destination acceptance service and policy-before-recipient ordering

- Implement one acceptance service used by local and future HTTP transports.
- Derive the source node from transport (or the same-host context), trust that
  node's asserted origin team, resolve the destination team, then apply policy
  and capacity/order constraints before resolving the handler or direct agent.
- Short-circuit exact accepted duplicates before re-evaluating mutable policy
  ordering, capacity, or availability.
- Distinguish cold starts from durable continuations.
- Commit before returning `202`.
- Return stable pre-accept errors without allocating a destination accepted
  row.
- Enforce body-size, per-origin rate, per-team backlog, and local processor
  bounds from this first delivery slice, plus a per-direct-recipient-agent
  backlog bound.

**Direct-address tests:** a closed team returns `target_closed` for both known
and unknown names, with resolver spies proving no agent lookup occurred. An
open team resolves both known and unknown names and does not consult the inbox
handler for a direct target.

#### Commit 9 — Asynchronous processor and handler lifecycle

- Process accepted rows after the acceptance transaction.
- Team messages choose the current configured handler when processing; direct
  messages use the agent ID bound at acceptance.
- Create/persist the handler query mapping before reporting `processing`.
- Leave accepted work accepted while a required agent is stopped.
- Let a replacement inbox handler take pending team-addressed work.
- Fail accepted direct-agent work with `recipient_deleted` when its bound agent
  is deleted.
- Recover accepted/processing rows on manager restart without claiming
  exactly-once execution.
- Serialize processing by conversation direction and reconcile
  `unknown -> completed|failed` only when durable evidence appears.

**Direct-address tests:** stopped-after-accept remains accepted, restart of the
same agent ID proceeds, rename does not break continuation, and deletion differs
from inbox-handler replacement.

#### Commit 10 — Replies, status APIs, roster/tag reads, CLI/TUI flow, and local E2E

- Add opaque transport-bound reverse routes and reply messages.
- Add message/conversation status inspection and exact product copy.
- Add policy-gated descriptors with live rosters and no immutable local IDs,
  group hierarchy, or lead hint.
- Add the single-destination-team tag-filter read; reuse the normalized index
  and the exact roster projection function. Do not add node-wide or
  multi-contact fan-out.
- Mark duplicate names ambiguous, mark `catalogRole` non-authoritative, stamp
  point-in-time availability, and enforce per-node rate/count/encoded-size
  bounds without silent partial results.
- Teach clients to prefer `team:<alias>` while permitting the direct form.
- Explain that team/handler addressing is the preferred convention while
  direct-agent addressing remains a permitted first-class path.
- Display named recipients as resolve-on-conversation-creation selectors with
  an immutable ID pin thereafter.
- Display recipient binding/name-drift notices, and explain that `open`
  publishes the roster while `closed` publishes nothing.
- Demonstrate two teams on one manager, both address modes, reply routing,
  restart recovery, lost-response dedup, handler replacement, and broken team
  identity pins.
- Demonstrate ordered turns, capacity rejection without dropping accepted
  rows, force-delete route revocation, closed-team recipient privacy, open-team
  roster/tag reads, and a closed read that loads no roster rows.

**Gate:** no V1 caller dials a worker URL, and an accepted response can be
explained after restart from database state alone.

### Phase D — Remove the shared-team-folder dependency

This phase is not required to prove same-manager messaging, but its order is
strict. Commit 13 cannot land before the commit-3 normalized-org/backfill gate
or commits 11–12.

#### Commit 11 — Relocate exports, archives, and config write-back

- Move automatic exports out of `workspace/teams/<team>`.
- Change manual export fallback to an operator/config export root.
- Remove runtime profile correctness dependence on mutating
  `last_config_path`; DB remains authoritative and export is explicit.
- Replace news “archive to team folder, then delete DB rows” with a configured
  archive store or DB retention policy that cannot lose data on write failure.
- Preserve import/diff as explicit operator file operations.
- Fix the false “re-export or re-deploy” legacy-org remediation and remove the
  instruction that says the full chart lives in a shared folder.

**Gate:** export, auto-export, profile edit, and news retention neither read nor
create the team directory.

#### Commit 12 — Replace shared files and client filesystem shortcuts

- Remove `ID_SHARED_DIR` from worker launch.
- Remove worker `/files/teams`, `/files/shared`, and shared-directory listing.
- Add bounded manager resources for org, config inventory, heartbeat
  definition, agent artifacts, and avatars; never add arbitrary path fetch.
- Move TUI/CLI config, output, and heartbeat views to those APIs.
- Update skills, runtime copy, and deployment docs.
- Remove or update the currently unwired `/shared/files` client helpers.

**Gate:** a client on another machine can perform the supported reads without
host filesystem access, and worker file APIs expose only the agent's declared
artifact/work root.

#### Commit 13 — Stop creating and depending on team directories

- Remove manager-constructor, middleware, lookup, create, deploy, spawn,
  seeding, local-agent, and worker directory creation.
- Remove the obsolete core team-directory helpers.
- Add a read-only audit for residual files and a separate explicit
  backup/quarantine cleanup command.
- Do not recursively delete existing operator data in an automatic schema
  migration.
- Test delete/recreate of a same-name team cannot inherit stale files.

**Gate:** a repository search and integration test prove normal manager,
worker, deploy, send, export, archive, and TUI flows do not create
`workspace/teams/<team>`.

### Phase E — Remote managers

#### Commit 14 — Two-manager loopback transport

- Run two managers with distinct databases, node IDs, work roots, and ports.
- Add a test-only loopback transport adapter; it is not a supported deployment
  and cannot enable a non-loopback listener.
- Route only manager-to-manager; workers remain loopback-only.
- Reuse the commit-8 acceptance service and commit-5 dedup transaction.
- Support origin polling for replies/status through the transport-identity
  abstraction, even though the test listener is loopback-only.
- Exercise message, descriptor/roster, and single-team tag-filter operations
  through the same destination-policy service.

**Gate:** a lost `202` followed by resubmission returns one destination message
and causes no second submission acceptance.

#### Commit 15 — Tailscale transport identity and perimeter enforcement

- Add the production federation listener bound to exactly the configured
  tailnet interface and manager port. Reject `0.0.0.0`, LAN addresses,
  wildcard binds, and any attempt to dual-bind the federation listener.
- On startup, verify the local Tailscale identity against the configured local
  `nodeId`; on each request, map the authenticated tailnet source identity to
  a configured peer `nodeId`. An explicitly configured tailnet-address binding
  is valid; a durable-device binding may use authenticated Tailscale connection
  metadata, `tailscale whois`, or the Tailscale LocalAPI. When that durable
  lookup is configured, an unavailable/error/timeout result rejects the request
  and never falls back to source IP. Request/envelope fields never establish
  identity.
- Require and document the tailnet ACL:
  `tag:idagents -> tag:idagents:<manager-port>`.
- Trust the mapped node's asserted origin-team label without receiver-issued
  grants, per-team credentials, or an invite handshake.
- Resolve outbound peers only through the configured node-to-tailnet-address
  map. Accept no reply URL, redirect, DNS-discovered locator, or endpoint update
  from protocol data.
- Ensure reverse replies use only the mapped transport route or polling.
- Add protocol/version, body/roster size, timeout, queue, and concurrency
  bounds.
- Make unsupported deployment explicit: federation startup outside Tailscale
  fails until a future real peer-authentication mode exists.

**Gate:** the listener is reachable only on the tailnet interface; an
unconfigured tailnet identity and a self-declared `nodeId` fail; an admitted,
mapped node succeeds without any application credential; ACL and bind checks
fail closed; worker ports remain unreachable off-node.

#### Commit 16 — Multi-computer product hardening

- Add operator flows for tailnet peer mapping, contact creation, binding/ACL
  verification, policy, handler, roster/tag reads, and status diagnostics.
- Display local alias separately from verified remote team display name.
- Display direct recipients as name selectors, not pinned identities.
- Run the two-manager fault matrix across two computers.

**Gate:** all Stage E tests pass under peer outage, tailnet identity mismatch,
ACL/bind misconfiguration, mixed adjacent protocol versions, destination
restart, open roster/tag reads, and closed read suppression.

## Required acceptance matrix

### Identity and contacts

- Configured node ID survives restart and restore-in-place.
- The authenticated tailnet source maps to `nodeId`; body/envelope claims do
  not.
- Duplicate node/tailnet mappings and a cloned database without a matching
  local transport mapping fail startup.
- Contact pins survive display rename and endpoint movement.
- Target team delete/recreate with the same name remains broken.
- Contact alias uniqueness is per sending local team.
- The mapped node's origin-team assertion is trusted; compromise of that node
  can impersonate its other local teams and is an accepted risk.

### Policy and direct addressing

- Both address modes resolve the destination team and apply policy first.
- Closed known and closed unknown direct names are indistinguishable.
- Closed descriptor/roster/tag reads publish nothing even when the source has
  an active message conversation; continuation is message-only.
- Open team-addressed send requires a valid handler.
- Open direct-agent send uses the exact local name and does not require or
  consult the inbox handler.
- No `direct_addressing` flag or triage gate exists.
- Open recipient result codes are intentionally name-enumerable and `open`
  publishes the live roster.
- Unknown, ambiguous, stopped, renamed, deleted, and recreated names follow the
  frozen codes and lifecycle above.
- A new direct conversation resolves the name once; every continuation uses
  the pinned immutable agent ID and fails loudly rather than retargeting after
  delete/recreate.
- Opaque binding references and name-drift notices expose rename/name-reuse
  without revealing receiver-local agent IDs.
- Closed descriptor, roster, and tag reads all return `target_closed` before
  loading agent/org rows.
- The open descriptor roster exposes no immutable local IDs, group hierarchy,
  or lead hint.
- Duplicate exact `addressName` entries are all marked ambiguous and remain
  unaddressable; `catalogRole` is labeled non-authoritative and resolver-spy
  tests prove delivery never consults it.
- Availability is timestamped snapshot state and is revalidated on delivery.
- Single-team tag queries return the same bounded roster projection; no
  federation-wide fan-out endpoint exists.
- Read-rate/count/tag/encoded-size limits reject with stable errors and never
  return an unlabeled partial roster.

### Durability and failure

- Destination restart after acceptance preserves the message.
- Handler stop after acceptance leaves `accepted`, not `processing`.
- `processing` appears only after durable local query mapping.
- Lost `202` plus identical resubmission deduplicates.
- Same ID plus changed content conflicts.
- Handler completion plus lost response is queryable by message/conversation
  ID.
- Per-direction turns reject stale predecessor/sequence conflicts and process
  serially.
- Capacity rejection never removes or downgrades an accepted row.
- Per-recipient backlog rejects targeted saturation independently of team and
  origin bounds.
- `unknown` advances only when durable completion/failure evidence appears.
- Agent/team deletion does not cascade-delete accepted history.
- Origin outage does not delete destination acceptance.
- Unknown outcome is reported as unknown, never inferred as failure.

### Reverse routing and trust boundary

- No request or stored message has a `replyUrl`.
- Forged route IDs, wrong transport-mapped peers, and wrong conversation IDs
  fail.
- No protocol field can add or update a locator; outbound routing uses only the
  configured tailnet peer map.
- Worker ports are not used by federation.
- The federation listener binds only the tailnet interface, never wildcard,
  LAN, or dual binding, and the documented ACL restricts
  `tag:idagents -> tag:idagents:<manager-port>`.
- An admitted and locally mapped tailnet node is the V1 authentication result;
  no application certificate, token, worker capability, team grant, or invite
  exists.
- A configured durable Tailscale identity lookup that is unavailable, errors,
  or times out fails closed and never falls back to source-IP identity.
- Local headers are trusted only within the explicitly accepted single-host
  domain; hostile same-UID isolation is not claimed.
- A non-Tailscale deployment refuses federation startup.

### Org and folder removal

- No table, API, or protocol has `parent_team_id`; groups cannot cross teams.
- SQLite and Postgres reject cross-team parents, leads, and members, duplicate
  sibling names, and write-time cycles.
- Shared normalization vectors produce identical stored keys in parser,
  migration, service, SQLite, and Postgres paths.
- Position constraints and transactional renumbering produce deterministic
  sibling/member order.
- Group deletion restricts on children; explicit subtree deletion never
  silently reparents.
- Agent soft delete cannot leave visible lead/member/tag ghosts, and tag search
  filters `deleted_at`.
- Readers/renderers fail safely on corruption and enforce depth/node bounds.
- Org backfill classifies all 9 currently unpopulated teams, preserves the four
  source orgs' groups/descriptions/order/tags, and blocks malformed or
  unresolved input without partial rows.
- New deploy/import and the fleet-wide backfill use the same normalized org
  writer and DB reader.
- Nullable leads are accepted explicitly; no missing lead is guessed.
- YAML tag inversion is transposed into indexed agent tag rows; catalog
  expertise neither seeds nor mutates them.
- Backfill rejects unexpanded templates, snapshots before mutation, and has a
  tested/refusing rollback contract.
- Backfill and later reorgs leave `inbox_handler_agent_id` unchanged.
- Drift requires operator acknowledgment; genuinely absent/unrecoverable org
  requires an audited per-team no-org override.
- Org render and per-agent context work with the team folder absent.
- No descriptor or remote route exposes group hierarchy; open roster and
  single-team tag reads are the only V1 org-discovery surfaces.
- Export, auto-export, news retention, profile mutation, TUI, and worker startup
  do not recreate the folder.
- Team delete/recreate cannot inherit prior files.

## Direct answers

### 1. Does direct-agent addressing change commits 7–10 and need its own tests?

Yes. It changes all four:

- commit 7 adds the destination union, exact local resolver, and immutable
  agent-ID pin at conversation creation;
- commit 8 proves team policy precedes agent resolution and dedup precedes
  mutable revalidation for an already accepted retry; it also proves the
  closed path does not leak recipient existence while `open` permits exact
  direct resolution;
- commit 9 differentiates team-handler replacement from a bound direct
  recipient's stop/delete lifecycle;
- commit 10 adds direct syntax, product copy, replies, descriptors, and E2E.

The tests are not optional variants of team-address tests. They pin distinct
identity, privacy, and lifecycle behavior.

### 2. What happens when the inbox handler is stopped, deleted, or renamed?

- **Stopped:** keep the configured handler ID. New team-addressed sends return
  `handler_unavailable`. A message already durably accepted stays `accepted`
  and may process when the handler becomes available.
- **Deleted:** clear `teams.inbox_handler_agent_id` and leave the team visibly
  open with degraded **team-addressed** routing. New team sends return
  `handler_unavailable`, but direct-agent cold starts remain permitted.
  Already accepted team-addressed messages remain accepted and may be handled
  by a replacement because their destination was the team.
- **Renamed:** nothing changes for team-addressed routing because the immutable
  ID is unchanged.

For a direct-agent message, deletion is different: an accepted direct
conversation is bound to that agent ID and becomes `failed:
recipient_deleted`; it must not silently move to another agent.

### 3. Is `teams.inbox_handler_agent_id` sufficient for V1?

For inter-team messaging, yes, together with `inbound_policy`, tailnet-mapped
node identity, trusted local caller context, contacts, and the durable message tables. No
other `org:` data is needed to route a team or direct-agent message after the
creation-time handler default has been copied.

For deleting the shared folder, no. Under the third amendment the complete org
must be normalized into ID-backed groups, leads, memberships, and separate org
tags before folder deletion. Although current code stores opaque
`teams.config.org` for new deploy/import, the installed baseline is 0/9
populated teams; commits 2–3 therefore introduce the normalized model and
prove fleet-wide classification rather than using JSON as an intermediate
authority.

### 4. Are there other latent dependencies?

Yes:

- legacy org has no working in-place backfill despite the current warning;
- per-agent identity skills embed derived org context and a shared-folder
  instruction;
- auto-export and manual-export fallback write to the team folder;
- news archive writes there before deleting DB rows;
- manager middleware and multiple startup/create paths recreate it;
- workers receive and publicly serve it on loopback file routes;
- CLI/TUI/docs advertise or directly read local paths;
- team deletion leaves stale directories for same-name replacements;
- direct agent names are not unique in the DB and current helpers silently pick
  the newest;
- workers currently receive identity via environment and open the manager
  database; decision 6 accepts that host trust domain, so V1 must not claim
  hostile same-UID tenant isolation;
- conversation history would be lost if new foreign keys copy current cascade
  patterns;
- roster and tag reads need the same destination-policy pipeline as messages;
- production federation must refuse non-Tailscale, wildcard, LAN, and
  dual-bound listeners.

### 5. What still looks wrong?

Prem's rulings remove ambiguity from all three pre-commit-1 decisions:

1. **Resolve once, then pin.** A new direct conversation resolves the exact
   current name and pins the immutable agent ID. Delete/recreate may route a
   later new conversation to the replacement, but the existing conversation
   keeps the old ID and fails loudly.
2. **`open` is permissive.** A trusted contacting team may address
   any exact eligible agent directly. There is no triage gate and no
   direct-addressing flag. Tightening this later is a breaking policy change.
3. **An inbox handler is not the org lead.** Copy a unique resolvable lead ID
   into the handler once at team creation, then persist and mutate the two
   concepts independently. A reorg never silently reroutes inbound messages.

No owner-level trust choice remains. V1 delegates node authentication to
Tailscale and accepts the manager plus its local workers as one host trust
domain. A future third-party-hosting mode must reopen both boundaries together.

## Third-amendment direct answers

### 1. Flat teams plus recursive groups versus unified recursion

No objection; this is the stronger boundary. Teams and groups differ in
identity, placement, routing, policy, and failure semantics. Making a group a
child team would either federate organization edits or introduce a special
“team that is not really a team” mode throughout contacts, descriptors,
policy, deletion, and node moves. Recursive node-local groups preserve the
needed hierarchy without creating any of those surfaces. `parent_team_id` is
rejected, not deferred.

### 2. Schema and tag scope

`agent_tags(agent_id, tag)` is the right ownership direction and is already
implicitly team-scoped because each agent belongs to one team. Keep the
indexed global shape so an authorized local operator can answer an all-team
query with one join. Do not duplicate `team_id` there merely for search.

The proposed schema is incomplete without group description/order,
same-team lead/member constraints, sibling-name uniqueness, deletion
semantics, and database-enforced cycle prevention. A normalized/display pair
for tags avoids case-variant duplicates while retaining authored spelling.
The stated non-null lead invariant conflicted with three live groups; nullable
leads are now the accepted model.

### 3. Cross-node tag queries

In V1 when scoped to one pinned destination team. The owner has made an open
roster readable, so filtering that same bounded projection through the
normalized tag index adds no new disclosure. It runs only after destination
team resolution and the same inbound-policy check as a message or roster read.

Node-wide, multi-contact, and federation-wide fan-out remain deferred for a
different reason: they are the first aggregated cross-node read and need
deadlines, per-target outcomes, duplicate rules, and partial-result semantics.
V1 keeps the server operation single-team and atomic.

### 4. Impact on the former fifteen commits

- **Commit 1 changes:** freeze flat teams, policy-gated open roster reads, and
  single-team tag filters while excluding cross-node group hierarchy.
- **New commit 2 is the normalized schema/authority patch.**
- **New commit 3 is the separately reviewable live nine-team backfill.** This
  separation keeps external file reads and rollback risk out of DDL/model
  review and directly satisfies the requirement that backfill be its own
  commit.
- **Old commits 2–8 shift to 4–10:** handler defaulting now reads normalized
  group leads; trusted operator context owns group/member/tag writes; local E2E
  proves only the bounded roster/tag projection crosses the wire.
- **Old commit 9 disappears as a JSON-authority step:** its rendering and
  schema/rendering duties move to commit 2 and its backfill duties to commit 3.
- **Old commits 10–15 shift to 11–16.**
- **Commits 11–13 tighten:** folder removal consumes only normalized org
  reads; no YAML/JSON fallback may recreate an authority split.
- **Commits 14–16 are substantially rescaled:** loopback is test-only;
  production transport is Tailscale-only with interface/ACL/identity mapping;
  all bespoke peer credentials, team grants, arbitrary locator updates, and
  clone-key ceremonies disappear. Remote open-roster and single-team tag reads
  share the message policy path.

The honest total is sixteen. Preserving the number fifteen is not worth
combining a reversible schema/reader change with the first live fleet data
movement.

### 5. Additional concerns

- Multiple group leads mean there is no general “team lead.” The handler
  default remains safe only when the full tree resolves to one distinct lead
  agent ID; otherwise selection is explicit.
- A schema migration must not read operator YAML files. DDL/DB authority and
  the audited application backfill are separate commits and mechanisms.
- Recursive does not mean unbounded input. Cycle, depth, width, and response
  limits are required even after write-time cycle enforcement.
- Tag separation from catalog expertise is correct on authority grounds, but
  it is an API/service guarantee under the current same-host trust model. A
  worker that can directly mutate manager storage is not a hostile tenant;
  stronger authority isolation requires removing that access.
- If agent team reassignment is ever introduced, org memberships, leads, and
  tags must be transactionally rejected or reviewed. They must not silently
  follow an agent into a different team.

The separation between `org_groups.lead_agent_id` and
`teams.inbox_handler_agent_id` fully satisfies the earlier routing concern:
the former is organization state, the latter is operational routing state.
Creation may copy the sole distinct lead ID once; every later change is
explicit and one-way independence is tested.

## Consolidated owner-decision impact

### Commit changes

- **Commit 1:** adds readable open-team rosters, single-team tag filters,
  closed-read suppression, Tailscale-derived `nodeId`, and the accepted host
  trust boundary to the frozen contract. It removes no-roster and local-worker
  credential requirements.
- **Commit 3:** nullable leads are final rather than an owner gate.
- **Commit 4:** shrinks from application node authentication/optional grants to
  logical node/team/contact schema plus one-to-one tailnet identity mapping.
  It adds no credential/grant tables or clone-key rotation.
- **Commit 5:** keeps opaque reverse-route persistence, but the expected peer
  is validated against transport-derived node identity rather than an
  application credential.
- **Commit 6:** drops manager-minted worker and operator capabilities. It now
  provides trusted local caller context, data-integrity checks, operator APIs,
  and honest boundary documentation.
- **Commit 8:** trusts the transport-mapped node's origin-team assertion and
  retains destination-policy/capacity ordering; receiver-side team grants are
  gone.
- **Commit 10:** replaces minimal/no-roster descriptors with policy-gated open
  rosters and the atomic single-team tag-filter read.
- **Commit 14:** remains a test-only two-manager adapter; loopback federation is
  not a supported production mode.
- **Commit 15:** is rewritten around the Tailscale-only listener, exact
  interface binding, ACL enforcement, transport identity mapping, configured
  tailnet routes, and unsupported non-Tailscale startup. Certificate/token,
  invite/grant, arbitrary locator, credential lifecycle, and clone-key work
  disappear.
- **Commit 16:** tests and productizes tailnet peer mapping, bind/ACL
  diagnostics, roster/tag reads, and failure behavior; credential
  rotation/revocation UX is removed.

Commits 2, 7, 9, and 11–13 keep their substantive scope. Commit 2's nullable
lead column is no longer conditional.

### Work that drops out of V1 entirely

- application-level node certificates, tokens, challenges, key lifecycle, and
  application clone-key collision detection;
- receiver-issued origin/recipient grants, per-team credentials, and any
  consent-verification `invite_only` handshake;
- manager-minted per-process worker capability and separate operator
  capability/session;
- arbitrary peer locators, protocol-driven endpoint updates, redirect/DNS
  locator handling, and the corresponding general-purpose SSRF surface;
- hostile same-UID tenant isolation;
- non-Tailscale federation support;
- server-side node-wide, multi-contact, or federation-wide tag/roster fan-out.

### CTO dissent

No owner decision is a mistake within the explicitly private, owner-operated
fleet boundary. The decisive constraint is that the deployment must preserve
that boundary: Tailscale device admission alone does not authenticate a
process, so binding only the tailnet interface, enforcing the tag/port ACL,
mapping the configured authenticated tailnet identity rather than an ordinary
network address or body field, and refusing non-Tailscale startup are release gates, not optional
hardening. If third-party teams arrive, decisions 3, 4, and 6 must be reopened
together; adding only a per-message token would not repair the host boundary.

## Independent review reconciliation

The manager-visible hand-off to `seniordev` (claude-fable-5) returned **NO —
approve with conditions**. The full independent opinion is preserved in
`output/review-interteam-comm-plan.md`.

We agree on all of the architectural keystones: node-atomic teams, local
identity-pinning contacts instead of a fleet directory, manager-only
federation, team policy before receiver-local resolution, broken-link
tolerance, durable IDs/acceptance/dedup in V1, an inbox handler distinct from
org leadership, org backfill before folder removal, opaque reverse routes, and
non-cascading history.

We disagreed on one product-scope remedy. `seniordev` preferred deferring
direct-agent addressing to V2 because it is the weakest and most expensive V1
variant. Prem has decided to keep it in V1 and to make `open` permissive:
direct addressing is ungated. The technical identity objection is still
addressed by resolving once at conversation creation and pinning the immutable
agent ID.

The earlier recommendation to add a default-off direct-addressing control is
superseded by Prem's explicit policy decision.

Two additional owner decisions explicitly reverse objections seniordev had
won:

1. **Decision 2, roster readability, overrides the accepted no-roster
   objection.** `open` now publishes the bounded roster and organization tags;
   `closed` publishes nothing. The exact-name result contract was already
   enumerable, so suppressing the roster had cost utility without preserving a
   coherent privacy property.
2. **Decision 6, the single-host trust boundary, overrides the accepted local
   worker-capability blocker.** The manager-minted per-process capability and
   separate operator capability are removed, because the owner explicitly
   declines hostile same-UID tenant isolation in V1.

Decision 3 also removes the bespoke remote-auth design: Tailscale is the V1
authentication dependency. Decision 4 removes origin/team grants and trusts a
mapped node's team assertion. Decision 5 reclassifies `open`/`closed` as
operational control rather than a security boundary.

Five of the earlier non-blocking review gaps remain incorporated: explicit
degraded team-addressed handler semantics, an evidence-led exit from `unknown`,
same-manager flow control, ordered conversation directions, and reverse-route
behavior on team deletion. The former peer-visible clone-key collision scheme
is superseded by tailnet identity mapping: a copied database has no transport
identity until local configuration binds it, and duplicate mappings are
rejected.

The focused follow-up after Prem's rulings returned **SHIP before commit 1**.
Its one blocking freeze issue is fixed by distinguishing per-message
`submitter_node_id` from the conversation initiator on reply rows. Its concrete
decision consequences are also incorporated: opaque recipient binding/name
drift notices, explicit open-team roster publication, per-recipient capacity,
full-tree distinct-ID lead selection at end of deploy, and the three-state
audited 0/9 backfill gate.

The third-amendment review returned **SHIP the org model, with one reversal
and four specifications required before schema implementation**. Its full
opinion is `output/review-interteam-org-model.md`.

We agree without reservation on flat node-atomic teams, recursive same-team
groups, permanent rejection of `parent_team_id`, omission of redundant
`teams.node_id`, global agent-keyed/indexed org tags, and authority separation
from catalog expertise. Cross-node group hierarchy remains absent; the owner
has reversed the no-roster premise, so a single-team tag-filter read is now in
V1. We also agree that the
original sketch needed description/order, same-team lead/member constraints,
sibling uniqueness, cycle defense, and explicit deletion behavior.

There were two real disagreements:

1. The CTO draft recommended strict non-null leads to honor the literal
   amendment. Seniordev argued that the optional type, renderer, and three
   semantically leadless live groups prove this is existing valid product
   state, not corrupt data. That argument wins technically: the final
   recommendation is nullable leads with explicit rendering and warnings.
   The consolidated instruction says all outstanding decisions are resolved
   and does not reverse this accepted objection, so nullable leads are final.
2. The CTO draft kept fifteen commits by combining schema and live backfill.
   Seniordev argued that model/constraint review and reversible fleet data
   movement have different risk and rollback surfaces. That argument also
   wins: the sequence is now sixteen commits, with schema/authority in commit
   2 and live backfill in commit 3.

The four required specifications are now in the plan: soft-delete handling,
one shared normalization function, restrict/explicit subtree deletion, and
dense deterministic position semantics. The additional findings are also
incorporated: retire the deprecated JSON authority, reject unexpanded
templates, report fragile app-support sources, require snapshot/undo behavior,
filter deleted agents from tag reads, label tags versus expertise, and remove
the undefined public-catalog descriptor escape hatch.

The remaining cycle-enforcement implementation detail is deliberately a
commit-2 feasibility gate: both databases must enforce the invariant, but the
plan does not prematurely require recursive triggers if a closure/materialized
path is the portable solution. Reader-side defenses remain mandatory either
way.

The consolidated-decision review returned **SHIP — commit 1 may freeze**. Its
full opinion is `output/review-consolidated-owner-decisions.md`. Seniordev
explicitly withdrew the two overridden objections: publishing an already
enumerable open roster is more coherent than claiming privacy that did not
exist, and a local capability without removing worker DB access would be
security theater under the accepted host boundary. It also agreed that the V1
tag operation should be a single-team filter over the shared roster projection
while distributed fan-out remains deferred.

All five required freeze edits are incorporated: closed continuations apply to
messages only; duplicate roster names are marked ambiguous; `catalogRole` is
non-authoritative and never used for routing; Tailscale identity lookup fails
closed without an IP fallback; and local peer-map rewrite is recorded as an
accepted fleet-compromise path. Its non-blocking recommendations are also
adopted: per-node read/response bounds, timestamped availability semantics, and
one shared roster/tag projection.

## Deferred work

The following are deliberately not hidden inside V1:

- any future third-party-hosting consent/auth model, including `invite_only`,
  receiver-issued grants, application peer credentials, and authenticated
  hostile local principals;
- stable named-recipient bindings or deleted-name tombstones;
- any future triage gate for `open` (breaking policy change; requires explicit
  versioning/migration);
- node-wide, multi-contact, or federation-wide roster/tag fan-out and its
  partial-result contract;
- automatic handler retry and backoff;
- cancellation and expiry policy;
- exactly-once handler execution;
- roster replication or durable remote-agent identity rows;
- remote task, schedule, wallet, lifecycle, or arbitrary artifact mutation;
- shared Postgres, consensus, or gossip;
- non-Tailscale federation until a real peer-authentication mode exists;
- hostile same-UID worker isolation, to be revisited before third-party teams.

The next implementation slice, after revised design sign-off, is commits 1–3
only. Stop after the schema/backfill review before commits 4–6 add routing,
durable-message, and trusted-local-context foundations. No message is delivered
before commit 6 receives its own schema/context/operator review.
