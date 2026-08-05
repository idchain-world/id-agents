# Inter-team communication — design

**Status:** design for implementation, V1. No feature code yet.
**Decision history:** the reasoning transcript, review rounds, and the alternatives that were considered and **rejected** live in [`inter-team-communication-history.md`](./inter-team-communication-history.md) — unified team/group recursion, application-level node certificates, and the mandatory-group-lead invariant among them. This document is the design. Read the archive only if you are about to reopen a settled call.

---

## What this system is

Teams of agents run under a **manager** daemon. Today all teams under one manager share one machine. This design lets a team send a request to a team that lives under a **different manager on a different machine**, and collect its result.

The shape in four sentences:

- A **team is atomic to one node.** It is never split across machines, and its manager is the single authority for everything inside it.
- **Managers talk to managers.** Worker (agent) processes never open a federation port; all cross-node traffic goes manager-to-manager.
- **There is no global directory.** A team that wants to reach another team stores a local **contact** — a private alias pinning the remote team's identity. Nobody publishes a fleet-wide roster of who exists.
- **Delivery is durable and idempotent.** A message is a committed database row with a stable ID, not a fire-and-forget call, so a lost network response can be retried without double-delivery.

V1 connects the owner's own machines. **Everything that can reach the listener is trusted**, so the address it binds is the trust boundary — bind a Tailscale address, a LAN address, whatever only your own machines can reach.

## What this system is not

- **A public federation.** Only your machines, on a network you trust.
- **A way to host other people's teams.** Multi-tenancy needs guarantees V1 does not make.
- **A fleet-wide directory.** There is no global roster; you register the teams you want to reach.
- **Isolation between agents on one machine.** They share a trust domain by design.
- **A way to split a team across machines.** A team lives on exactly one node.
- **A search engine.** You read one registered team's roster at a time and filter it yourself; nothing queries across teams.

---

## Identity

### Node identity

Each manager has one durable logical `nodeId`: a random UUID generated once at first startup and stored in `manager_identity`. It is derived from no network attribute and never changes during the life of that logical node. It travels in the federation request and the receiver takes it at face value: this is a trusted fleet, and only hosts that can reach the configured federation listener arrive at all. It is not a secret or an authorization token; knowing a `nodeId` grants nothing.

### Contacts

A **contact** is sender-side state owned by one local team. It maps a local alias to an opaque remote-node and remote-team pin. Alias uniqueness is scoped to the owning local team, so the same alias can mean different things for two local teams, and two teams cannot collide. Identity is the pin, never the display name or endpoint:

- Renaming or re-addressing the remote team does not affect the contact.
- Deleting and recreating the remote team under the same name leaves the contact **broken** (`target_identity_missing`); it is never silently retargeted to the replacement.

Creating a contact is a **local intent** — "this team wants to send there." It is not evidence the receiver consented; the receiver's own inbound policy decides admission.

---

## Trusted-fleet operating model

### Within a node: one host trust domain

A manager and its workers run as the same user and already share the database, so V1 treats them as one trust domain.

Local caller context (`X-Id-Agent`, manager-owned launch context) is used to route and audit correctly — not to authenticate. It prevents ordinary mistakes, such as a request body naming a different source team than the caller's, but it does not resist a malicious local process.

### What this design does not check

V1 trusts anything that can reach the listener. Three things follow. They are choices, not gaps:

1. **A node speaks for its own teams.** The receiver cannot independently confirm which local team sent a message, or that a node is the node it claims to be.
2. **Local processes can rewrite routes and identity.** Anything running as the manager's user can redirect or rename a node.
3. **Reaching the listener is enough.** There is no separate approval step. Whatever can connect can federate.

All three are fine while only trusted machines can reach the bound address. That is the assumption the whole design rests on. Moving between trusted networks — a tailnet to a trusted LAN — is only a change of bind address.

---

## Policy

### `open` and `closed` are operational controls, not a security boundary

Policy controls interruption, not access. It does not protect a team from a hostile peer — nothing at this layer can (see *Trusted-fleet operating model*).

- **`closed`** rejects new conversations. It is for a team under test or one that must not be interrupted. Its roster stays readable.
- **`open`** admits new conversations from trusted nodes.

An `open` team accepts team and direct-agent address forms: a team address routes to its assigned team lead, and an exact agent name or immutable agent ID routes to that agent. There is no separate gate for direct addressing.

### Rosters

Any node that can reach the listener can read a team's descriptor and roster. Inbound policy applies to messages, not to reads.

A roster is discovery data. Sending resolves the name again at that moment and pins the receiver's immutable agent ID (see *Direct-agent addressing*).

The descriptor:

```
protocolVersion              // major.minor; same major interoperates, other major -> protocol_unsupported
nodeId                       // the responding node's identity; what a contact pins
teamId                       // this team's immutable ID; the other half of a contact pin
teamDisplayName              // human-readable; renaming it breaks nothing
inboundPolicy                // open | closed — whether new conversations are accepted
agents[]:
  agentId                    // immutable; the unambiguous way to address this agent
  addressName                // the name used to address this agent directly
  displayName                // human-readable; never used for routing
  runtime                    // harness: codex, claude-code-cli, cursor-cli, ...
  model                      // the model within that harness
  effort NULL                // reasoning level, when the harness has one
  organizationTags[]         // org-assigned labels; readers filter on these themselves
  groups[]                   // group names within the team; context only
  catalog                    // the agent's REST-AP catalog, as stored
```

It exposes **no** ports, URLs, paths, tasks, group hierarchy, or lead hint. Specific rules the projection must honor:

- **What runs an agent is three fields, not one:** `runtime` (the harness), `model` (within that harness), and `effort` (the reasoning level, where the harness has one — Codex does, the Claude CLI does not). Publishing all three lets a reader judge cost and capability precisely instead of inferring it from `catalog.costTier`.
- **No wallet address is published.** An OWS wallet has one address *per chain* (`eip155:1`, `eip155:8453`, `solana`, …), but the manager only stores the Ethereum-mainnet one, parsed out of the `ows` create output. Publishing that single value would freeze "a wallet is one EVM address" into the wire contract. Deferred until the full per-chain address set is stored locally — see *Deferred work*.

- **The catalog is published whole**, as the manager holds it (`agents.metadata.catalog`) — role, description, expertise, cost tier, status. Advertising capability is what a catalog is for, so there is no field-by-field projection of it and no wire change when a catalog key is added. It is bounded by the descriptor's size limit like any other payload.
- **The catalog is agent-asserted, not organization-authoritative.** Agents may `PATCH` their own catalog, so it is presentation data. Delivery never routes on any part of it.
- **Duplicate `addressName` within a team is possible**, and the roster shows it: two entries carry the same name. Sending to that name returns `recipient_ambiguous`; sending to an `agentId` always resolves to exactly one agent, so a duplicated name is an inconvenience rather than a dead end.
- **`agentId` is the durable handle.** It never changes, so a pinned reference survives a rename; a deleted and recreated agent gets a new ID, so the reference breaks loudly instead of silently reaching a different agent. Names are for humans, IDs are for precision.
- **The roster says nothing about whether an agent can take work now.** Whether a recipient can accept is decided at send time and returned as `recipient_unavailable`.
- **`groups[]` is context, not function.** It lists the leaf group names an agent belongs to, so a reader can see what a team is working on and who works together. Nothing routes on it, no group is addressable, and no parent/child structure is published.

---

## The V1 contract

### Addressing and where names resolve

Names resolve at the receiver, never at the sender. The agent-facing syntax:

```
team:<local-contact-alias>
team:<local-contact-alias>/<remote-agent-name>
```

The wire form does not depend on parsing that display string; it uses a `team`, `agent_name`, or `agent_id` destination variant. Identity addressing uses the structured `agent_id` form exposed by roster-capable clients rather than inventing another display-string syntax. **The sender resolves only its own contact alias.** It never resolves the remote agent, fetches a roster to send, or stores a remote-agent row. The **receiver** is the sole authority for resolving an agent name or validating an agent ID against the destination team.

### Same-node destinations take the same path

A contact may pin the local `nodeId` — two teams under one manager. That resolves to a local team and goes through the same acceptance path as any other message; only the transport step is an in-process call instead of a network one. One code path means the two-teams-on-one-manager test exercises the real one.

A manager never handshakes with itself: it does not open a federation connection to its own node, and it rejects an inbound federation handshake claiming the local `nodeId`. Same-manager in-process delivery is not a federation handshake. It carries trusted local context into the shared post-transport acceptance service and is allowed to use the local node identity.

### Direct-agent addressing

Address by `agentId` and it resolves directly. Address by name and the receiver resolves it once at conversation start — exact current names within that team, no alias or fallback — then pins that agent's immutable ID for the rest of the conversation.

A conversation opened by name records that name for audit and pins the resolved ID for behavior. Renaming the agent affects new name resolution only; accepted messages and continuations keep using the pinned ID. Deletion fails with `recipient_deleted`, and delete-recreate never retargets the conversation.

### Durable acceptance and deduplication

Network responses get lost, so a resubmission must not run the work twice. The origin manager durably allocates `conversationId` and `messageId` (agents do not choose them) and reuses the identical envelope on retry. Message identity is scoped to the node that minted it. An identical resubmission returns the existing status with `deduplicated: true` instead of running the work again. Reusing the ID with a different recognized envelope returns `idempotency_conflict`. The accepted envelope's durable comparison identity survives body compaction and message deletion; fields ignored under minor-version compatibility do not participate.

`202 Accepted` is returned **only after the destination transaction commits.** It does not mean the handler saw it or the model started.

The origin node/team identifies who submitted every V1 request. Deduplication remains scoped to the minting node because message IDs are not globally unique, not because a destination submits replies.

This is **not** exactly-once. Safe *resubmission* after a lost response is the guarantee; automatic retry, cancellation, handler redelivery, and exactly-once execution are deferred. Resubmission is also **time-bounded**: an origin must not automatically resubmit an envelope whose first submission is older than the fixed **resubmission horizon** (30 days). This is a contract term the origin obeys — it is what lets the receiver eventually delete a terminal row without a late retry re-executing (see *Bounded intake is not bounded storage*).

### Message status

A message has one of five states, tracked by the destination. "Delivered" is deliberately not among them — it hides the difference between committed, seen by a handler, and finished.

| State | Meaning |
|---|---|
| `accepted` | Manager durably committed the message; no handler query confirmed yet. |
| `processing` | A durable local handler query/job mapping exists; work enqueued or claimed. |
| `completed` | A terminal result was durably recorded, including an explicit empty result when there is no payload. |
| `failed` | A terminal failure was durably recorded with a stable code and last confirmed state. |
| `unknown` | The outcome cannot be proven after a failure boundary. **Not** proof work failed. |

Normal path `accepted -> processing -> completed`. `accepted`/`processing` may go to `failed` or `unknown`. **Confirmed state never moves backward.** `unknown` advances to `completed`/`failed` only when durable evidence appears; otherwise it stays `unknown` for operator reconciliation.

### Ordered submitted requests

A conversation has one ordered stream of requests, all minted and submitted by its pinned origin. Each request identifies its position and predecessor. The receiver deduplicates first, rejects gaps, reused positions, and forks with `conversation_order_conflict`, and processes at most one request in the conversation at a time. A result does not advance the stream and is not a submitted message. The destination never owns an opposite-direction sequence, so a destination that submits nothing cannot leave an ordering head missing. Genuinely concurrent branches use separate conversation IDs; V1 does not merge them.

### Capacity is bounded before acceptance

New submissions are bounded from the first delivery slice: max body size, per-team backlog, per-origin rate, **per-direct-recipient-agent backlog**, and processor concurrency, all configurable with safe defaults. Deduplication is checked **before** capacity, so an accepted retry always returns its existing state. Capacity rejection happens **before** durable acceptance (`receiver_busy` / `message_too_large`); an accepted row is never dropped. Descriptor/roster reads and origin-team conversation-index reads have count and max encoded-response bounds. An oversized selected result is rejected (`read_response_too_large`), never silently truncated into an apparently complete list.

### Retention

Intake is bounded; storage is not. Terminal rows would accumulate forever — `news_items` (25k rows / 32 MB) and `queries` (8k / 12 MB) already show the shape, with nothing pruning them. Retention belongs in the schema from the start: it dictates timestamps and tombstones, and naive deletion breaks idempotency — delete a terminal row and a late retry of that ID is no longer recognised, so the work runs again.

Three tiers, driven by the time each message reaches a terminal state:

1. **Compact** at 30 days — drop the request body and completed-result payload, while keeping message identity, participant binding, envelope comparison identity, ordering facts, terminal status, failure code, and retention times. Deduplication and status collection keep working; collection reports that a completed payload was removed by retention.
2. **Delete** at 365 days — remove the message record while retaining an indefinite status-only receipt. The receipt preserves enough identity, conversation association, participant binding, comparison identity, and terminal status to deduplicate retries, detect changed-envelope conflicts, authorize collection, and report that payload and failure detail were removed by retention. A late retry never re-executes.
3. **Resubmission horizon** — an origin never auto-resubmits an envelope older than 30 days. The deletion window exceeds that tenfold, so receipts only matter for a misbehaving or clock-skewed peer.

**A message's clock starts when that message reaches a terminal state, whether or not its conversation is still open.** Retention is message-level. Waiting for a conversation to close would mean waiting forever, because V1 has no operation that closes one: cancellation and expiry are deferred, and a thread simply stops being used. The conversation record survives compaction and deletion of its messages, holding only identity, participants, and the ordering and deduplication facts that later arrivals are checked against.

Never touched: non-terminal rows, and `unknown` rows, which are the evidence recovery depends on — only an explicit operator resolution starts their clock.

**Deleting rows does not shrink a SQLite file.** The database runs `auto_vacuum=NONE` today, so the migration switches it to `INCREMENTAL` (needs one full `VACUUM`, which locks and rewrites — run once, operator informed), and each sweep then ends with a bounded `incremental_vacuum(N)`. An operator command exists for a one-time deep reclaim of existing bloat. Postgres needs none of this.

One manager-owned sweep runs the policy — daily, shortly after startup, and on demand — in capped batches, so it never holds a long lock. If it never runs, duplicate retries still deduplicate, non-terminal and `unknown` rows remain untouched, and no accepted message re-executes; only storage growth changes.

The engine is table-agnostic, not messaging-specific — the measured bloat is in `news_items` and `queries`, not in tables that do not exist yet. V1 wires it to the new messaging tables, whose retention is coupled to dedup; `news_items`, `queries`, and `event_log` follow in commit 17 so their own semantics get their own review.

Windows are configurable per table, and safe unconfigured: compact 30 days, delete 365, terminal outcomes stay answerable, non-terminal and `unknown` never touched. Disabling retention for a table is explicit and logged.

### Results are pulled, not pushed

V1 conversations are request and result. The origin submits every request, the destination works, and **the origin collects the result by asking for it** with the conversation and message ID it already holds. The destination never initiates a connection back and never submits a reply message. Before a message becomes `completed`, the destination durably records exactly one result associated with it. That result may be explicitly empty.

Collection is an idempotent, non-consuming read. It is authorized only for the conversation's pinned origin node/team and pinned destination team. The caller supplies the conversation and message IDs; transport or trusted same-manager context supplies its participant identity. An unknown conversation/message and a request from outside the pinned participants both return `conversation_not_found`, so the caller learns nothing about a conversation it is not party to. This does not repurpose `source_unauthorized`, which remains a local contact-owner mismatch.

Because pull-only collection is unusable after a caller loses every conversation ID, `GET /inter-team/conversations` is an origin-team index. Trusted local context selects the origin team; there is no caller-supplied owner. A team sees only conversations whose pinned origin node/team is itself, and another team sees its own list (or an empty list), never a different error or evidence that the first team's rows exist. Each entry contains the conversation ID, immutable destination node/team, destination variant, pinned direct-agent ID and accepted name when applicable, a best-effort **current** origin-owned contact alias, the latest message's current/confirmed state and retention tier, and timestamps. It contains no request body, result, or failure detail. The alias is decoration only and may be null after contact deletion; it never replaces the immutable destination pin.

The index defaults to all conversations and optionally accepts `state=outstanding|terminal`, defined over the latest message: outstanding is `accepted|processing|unknown`; terminal is `completed|failed`, including receipt-backed terminal state. Each selected set independently receives the same count and encoded-size caps. Exceeding either cap fails the whole read with `read_response_too_large`; there is no pagination or silent partial response. This keeps outstanding-work recovery available even when a long-lived team's unfiltered history exceeds the cap.

Every successful collection returns the current one of the five message states and the last confirmed state. `accepted`, `processing`, and `unknown` carry no result; `unknown` remains explicit rather than being inferred as failure. A retained `completed` message returns its durable result, including an explicit empty result. A retained `failed` message returns its stable failure code. After compaction, collection returns the terminal status and unambiguously reports that the payload was removed by retention. After deletion, it returns the status-only receipt and unambiguously reports that payload and failure detail were removed by retention.

This is why nothing needs a return address. A `replyUrl` in the envelope would duplicate routing state that can disagree with local peer configuration, and would make the receiver fetch whatever a peer names, which is the classic SSRF vector. **No envelope ever contains** a reply URL, callback, worker port, filesystem path, or arbitrary manager URL. Outbound routing uses only local peer-route configuration keyed by intrinsic `nodeId`, never a locator from protocol data.

It also means **peer routes only need to exist in one direction.** A node can accept messages from a node it cannot reach, because it is never required to reach back. The origin already has the route it used to send, and reuses it to collect.

Completion does not create a local agent callback, query reply, or news item. Conversations belong to an origin **team**, not to a sending agent; that agent may have stopped, and choosing it would make an equally authorized teammate miss the signal. Copying result payloads into news would also create a second retention domain and source of truth. V1 therefore keeps list-plus-collect polling as the single delivery contract. A future status-only team-inbox nudge may be added if measured polling cost justifies it, but it is not part of V1.

Conversation history **never cascade-deletes** with a local owner. Normal team deletion is blocked while non-terminal conversations remain; an explicit force-delete marks affected work terminal or orphaned, then deletes. A later collection attempt against a deleted owner fails and is never retargeted to a same-name replacement.

A destination that wants to speak first, rather than answer, needs a push path and bidirectional routes. That is deferred; see *Deferred work*.

### Resolution order (receiver, new inbound submission)

Order matters: resolving a recipient before applying policy makes a `closed` team do work it will refuse, and re-evaluating policy on an accepted retry could retroactively reject a committed message.

For a genuinely new submission, in this order:

1. for a federation connection, reject a request whose `nodeId` equals our own; same-manager in-process delivery instead derives the local node/team from trusted local context;
2. take a federation request's `nodeId` and asserted origin-team label at face value;
3. resolve the destination **team ID** locally;
4. classify cold start vs authorized continuation;
5. apply the team's inbound policy;
6. apply node/origin backlog and rate limits;
7. resolve the variant: assigned team lead for `team`, exact current name for `agent_name`, or exact immutable ID in that team for `agent_id`;
8. validate the chosen agent (in-team, not deleted, processing-capable, available);
9. commit and return `202`.

The team is the unit of policy in every mode, so a **closed team returns `target_closed` before any agent lookup** (tests must prove the resolver is not called). A caller that cannot reach the configured bind address never reaches the listener at all, so it cannot probe the deduplication namespace. The exceptions rely on durable state from a prior policy-approved acceptance, never an arbitrary target:

- An **accepted-duplicate retry** is matched before re-evaluating mutable policy; the existing state is returned for the identical envelope and `idempotency_conflict` is returned for a changed one. Closing a team or stopping a handler after acceptance cannot turn a committed message into a rejection.
- A **continuation** loads the durable conversation binding first. It is accepted only when the transport-supplied or trusted local origin node/team and destination team exactly match the pinned participants. Its participant role and request stream are derived from that binding; a caller cannot replace any participant or recipient binding. It does not re-resolve a mutable contact, policy, or direct-recipient name. An unknown conversation and a participant mismatch both return `conversation_not_found` and create no accepted or deduplication state. Policy applies to new conversations only; reads are never affected by it.

---

## What happens when an agent goes away

Agents can be stopped, renamed, deleted, or replaced, and accepted messages must outlive all of it. For each case this section says whether a new send is accepted, and what happens to messages already accepted.

### The team lead

Each team may have one assigned lead that receives messages addressed to the team. A team address routes to that lead. A direct agent address never consults it.

It is the lead of the whole team, distinct from the group leads in the org chart, and nothing derives one from the other. The field starts null and an operator assigns it through the remote API once the agents exist. Reassigning it is the same call.

A team with no usable lead, whether unassigned or pointing at a deleted agent, returns `team_lead_unavailable` for team-addressed sends. Direct-agent addressing keeps working. Policy does not guard this: a team may be `open` without a lead, and the error surfaces when a message actually arrives. An operator can misconfigure a team and fix it; nothing here guesses on their behalf.

### Binding and durability

Two rules decide what happens to a message when its target changes.

**Where a message is bound.** A team-addressed message is bound to the team, and resolves to whoever the team lead is at the moment it is processed. A direct-agent message is pinned to one agent ID when it is accepted, and is never re-resolved.

**What acceptance promises.** An accepted message waits for its target. It fails only when that target can never come back.

Everything else follows from those two:

- A stopped lead or recipient is a temporary condition, so accepted work stays `accepted` and resumes when the agent returns.
- Renames change nothing, because both bindings are by ID. A name matters only while resolving a new send: the old name returns `recipient_not_found` and the new one resolves normally.
- Deleting or reassigning the team lead does not lose team-addressed work. It was bound to the team, so the next lead picks it up.
- A new send asks only whether it can route right now. No available lead returns `team_lead_unavailable`, a stopped named agent returns `recipient_unavailable`, an unresolvable name returns `recipient_not_found`, and a deleted destination team returns `target_identity_missing`.

An accepted message dies in exactly two cases, both of them a target that cannot return:

- **The pinned direct recipient is deleted.** No other agent can take its place, so the message ends `failed: recipient_deleted`. This is the only agent-level event that is terminal.
- **The destination team is deleted.** Accepted and processing messages are marked `failed: target_deleted` before the team row goes, or deletion blocks until the queue drains.

---

## Persistence model

What must be recorded, not how to lay it out. Table and column shapes are the implementer's; the information, and the constraints on it, are not. SQLite and Postgres must enforce the same rules in the database rather than in services, with tests proving parity.

### Node and team settings

**Node identity.** One durable identifier per manager, generated once at first startup as a random UUID, never derived from any network attribute, surviving restart and restore-in-place. There is exactly one.

**Per team.** An inbound policy defaulting to closed, and a team lead that is null until an operator assigns one.

Three things are deliberately absent:

- **No parent team.** Teams never nest.
- **No per-team copy of the node identity.** One manager has one identity; a per-team copy would be a second source of truth that can drift. Local ownership is the pair (node identity, team).
- **No per-peer state.** Nothing is stored about a remote node beyond the pins held in contacts and the local route configuration used to reach it. A node identity arriving on the federation connection is used directly.

### Organization

Today the org chart lives in a YAML file and a rendered `ORG_CHART.md` on local disk, and that filesystem dependency is one of the things blocking a remote console. It becomes a normalized, node-local model: groups recurse within one team only, adding no federation route and no cross-node hierarchy read. The roster publishes each agent's leaf group names as context; the tree itself never leaves the node.

Record:

- **Groups**, each belonging to one team and optionally sitting inside a parent group, with a display name, a normalized form for lookup, an optional description, a deterministic position among siblings, and an optional lead.
- **Membership**: which agents are in which group, in a deterministic order.
- **Tags** on an agent, stored so exact search works while display spelling is preserved.
- **Org state per team**, distinguishing a configured org from a deliberate decision to have none, with who decided, when, why, and a hash of the source it came from.

Product decisions that are not derivable from the data:

- **Leads may be absent.** Leadless groups are valid state (pools, single-member groups). "No lead" is explicit in every API and render, and backfill never invents one.
- **A lead is implicitly a member** when collecting people, without a membership record. Results dedupe by agent, agents may belong to multiple groups, and there is no primary-group restriction.
- **Deleting a group with children is refused.** Removing a subtree is a separate explicit operation that previews and audits, and never silently reparents. Deleting a team may take its org with it.
- **A blocked migration is an audit result, not a decision.** "Deliberately no org" and "not yet migrated" must be distinguishable, and only the former can satisfy the folder-removal gate.

### Organization tags vs agent-asserted expertise

Two different things describe capability: tags assigned by the organization, and `metadata.catalog.expertise`, which an agent asserts about itself via `/catalog`. Conflating them would let an agent grant itself an organizational label.

They need separate write surfaces. The org-admin API is the only writer for tags, authorizing by joining the target agent to its team; an agent's own `/catalog` write can never reach them. Anything displaying both labels them "organization tag" and "agent-asserted expertise". This is an API authority boundary, not isolation between local processes, which V1 does not provide.

### Contacts, conversations, messages

**Contact.** A local alias, in display and normalized form, and the pinned identity of one remote team as (node, team). Unique per local team, so two local teams may use the same alias for different destinations. The pin is opaque and has no referential relationship to remote state. How to reach that node comes only from separate local peer-route configuration, never from the contact or from anything a peer sends, so changing an endpoint or transport never rewrites a pin.

**Conversation.** The pinned origin node/team and destination node/team. Whether it was addressed to the team, to a named agent, or to an immutable agent ID. For a named agent, both the name used and the immutable agent identity resolved at acceptance, with behavior pinned to the ID for the life of the thread. The next allowed request position and predecessor, plus the participant and deduplication facts needed after individual messages are deleted. V1 has no conversation-close state or operation.

The conversation index derives a latest-message projection from retained/compacted messages or status-only receipts. It does not invent a conversation-level state: its optional state filter is explicitly a filter over that latest message.

**Message.** One request in a conversation, submitted by the pinned origin node/team. Its position and predecessor in the conversation's single request stream. Who it was addressed to and, once resolved, its durable team or agent binding. The request body and the comparison identity for the recognized envelope. Its status, last status actually confirmed, stable failure code when failed, and durable result when completed, including an explicit empty result. The times needed to reconstruct processing and apply message-level retention.

Four constraints carry guarantees rather than convenience:

- **A message identifier is unique per minting node.** An identical resubmission returns the existing state, and a changed recognized envelope under the same ID conflicts, including after compaction or deletion.
- **A position is used once per conversation.** Gaps, reused positions, and predecessor forks are rejected, and accepted requests process serially.
- **A message may not be reported as processing until a durable link to the local job exists.** Each message maps to at most one local job and each local job to at most one message. That local job then follows the message's retention rather than its own.
- **A terminal outcome stays answerable after the body and the record are gone**, so a late retry of a purged message is recognized as already finished rather than run again.

Compaction drops the request and result payloads while the identity, participant binding, comparison identity, ordering, terminal status, and failure code survive. Deletion leaves the status-only behavior defined in *Retention*.

---

## Pre-accept result contract

These are outcomes of a *request* — a new submission or a read — not states of an accepted message.

A fixed, additive code set; new behavior needs a new code, existing codes are never repurposed:

| Code | Meaning |
|---|---|
| `invalid_address` | Contact alias or direct-name syntax invalid |
| `invalid_conversation_state_filter` | Conversation index `state` is not `outstanding` or `terminal` |
| `contact_not_found` | Derived source team has no matching local contact |
| `source_unauthorized` | Local trusted caller context conflicts with the selected contact owner |
| `target_identity_missing` | Pinned `(nodeId, teamId)` no longer resolves |
| `target_closed` | Destination team rejects a new conversation |
| `team_lead_unavailable` | Team address has no available team lead |
| `recipient_not_found` | Open team has no exact current direct-agent name |
| `recipient_ambiguous` | More than one current row matches; receiver refuses to choose |
| `recipient_unavailable` | Direct recipient exists but cannot currently accept processing |
| `conversation_not_found` | Conversation/message is unknown or the caller is outside its pinned participants |
| `conversation_order_conflict` | Not the next allowed position/predecessor in the conversation's request stream |
| `idempotency_conflict` | Message ID already identifies a different recognized envelope |
| `receiver_busy` | Trusted new submission exceeds a receiver backlog/rate bound |
| `message_too_large` | Message exceeds the hard size bound |
| `read_rate_limited` | Descriptor/roster read exceeds its per-source-node request bound |
| `read_response_too_large` | Read result exceeds count/encoded-size bound; never silently truncated |
| `org_data_corrupt` | Stored org data violates a required invariant; no partial render is returned |
| `protocol_unsupported` | No compatible protocol version |

Policy runs before direct-agent resolution, so a `closed` team never returns recipient-existence information; an `open` team may, because direct addressing is a permitted path. Accepted-message dedup runs before mutable policy/ordering/capacity.

**When `source_unauthorized` fires, and why it is not redundant with `contact_not_found`.** The source team comes from trusted local context and a request body can never override it, so a caller cannot simply *declare* a different source. But the caller still selects *which contact* to send through, and two selection paths can cross a team boundary:

- **Selection by contact ID.** Alias lookup is scoped to the caller's team, so a bad alias is `contact_not_found`. A contact **ID** resolves globally, so a caller can name a real contact owned by a different local team. That must fail as `source_unauthorized` — not `contact_not_found`, which would falsely claim the contact does not exist and would send an operator debugging in the wrong direction.
- **Operator team context.** An operator may legitimately act for several teams and supplies an explicit team context. If that context names team A while the selected contact is owned by team B, the request is refused rather than silently reinterpreted as team B.

Inside the single-host trust domain this is a **correctness and auditability** control, not a defense against a malicious local process (which is out of scope — see *Limits of the trusted-fleet model*). It keeps an operator or a buggy caller from sending "as" the wrong team by accident.

---

## Phases and commits

Messaging, the org migration, and removing the shared folder are three independently riskable changes, so they ship in that order rather than together.

Seventeen reviewable commits in a strict order. Commits 1–10 deliver the normalized-org foundation and the durable **same-manager** V1 contract; 11–13 remove the shared-folder dependency; 14–16 add remote transport **without changing the message contract**; commit 17 is the general retention/reclamation engine (it has no ordering dependency and could run earlier — it is placed last only because it touches existing high-traffic tables and wants the most settled surrounding code). Durability lands early (commit 5), not late.

### Phase A — Freeze the contract

**Commit 1 — Protocol types, parser, state machine, contract tests.** No network path, no behavior flag. Freeze: address parsing and the `team`, `agent_name`, and `agent_id` destination variants; protocol version as `major.minor`, where a receiver accepts any minor within its own major and ignores fields it does not recognize, and any other major returns `protocol_unsupported`; resolve-once/immutable-ID pinning; permissive `open` (team vs direct, no gate/flag); one origin-submitted ordered request stream; a durable result before `completed`; non-consuming five-state collection; strict continuation and collection participant binding; identical replay vs `idempotency_conflict`; `accepted -> processing -> completed|failed|unknown` with evidence-led `unknown` exit; roster reads unaffected by inbound policy; group names published as roster context but never addressable and never as a tree; intrinsic random `nodeId` carried as a non-secret wire value, taken at face value on the configured federation listener, and never derived from a network attribute; **no envelope `authScheme` field**; the 30-day **resubmission horizon** an origin must obey; the accepted host trust domain and absence of any local caller credential. Pure tests include a federation request claiming our own `nodeId` being rejected while same-manager delivery succeeds, ambiguous roster names, the whole-catalog field being non-authoritative, reads succeeding under either policy, bounded-read errors, and a resubmission past the horizon being rejected.
*Gate:* contract tests run with no manager process and contain no endpoint or worker URL.

### Phase B — Durable local foundation

**Commit 2 — Normalized org schema, constraints, DB authority.** Persist the org model and enforce every invariant above in both databases: references never cross teams, sibling names are unique within their parent, cycles are rejected, order is deterministic, deletion semantics are preserved, and tags remain distinct from expertise. Freeze normalization, subtree deletion, reorder, and soft/hard delete behavior in tests. Normalized state is authoritative for new deploy/import and always wins over deprecated org JSON. Render the full chart and per-agent context from normalized state with a nested-group parity fixture.
*Gate:* parity/normalization/ordering/soft-delete/subtree/cycle tests pass; new deploy renders nested org from normalized rows; deprecated JSON never wins; no live fleet data moved.

**Commit 3 — Audited nine-team backfill.** The live baseline is **0/9 populated**. Every team ends in one of three terminal classifications: normalized, `intentionally_no_org`, or blocked. Never fabricate org for the five teams with no source; a team whose references do not resolve is blocked rather than partially written. Once every team is terminally classified, remove the legacy runtime fallback and retire the deprecated org JSON, after which unmigrated state fails `org_migration_required`. Audit trail, dry-run, snapshot and rollback mechanics are the implementer's, bounded by the gate below.
*Gate:* all nine teams have an audited terminal classification; the four source orgs preserve seven groups, descriptions/order, twenty tag assignments, and recursive member results; any unresolved reference/template/missing-source blocks **only its team** and is never silently dropped.

**Commit 4 — Intrinsic node identity, team policy, team lead, contacts.** Persist one random node UUID generated at first startup, a closed-default inbound policy and initially unassigned lead for each team, and team-owned contact aliases pinned to immutable remote identity. Preserve the node ID across restart and restore-in-place. A lead is set only by explicit remote-API assignment, resolves to an agent in that team, and is never derived from the org tree. Store no per-peer state and derive no local identity from a network attribute. Add no node certificates or tokens, receiver grants, per-team credentials, or invite policy.
*Gate:* an existing multi-team DB migrates closed with a null team lead, generates exactly one node ID and keeps it stable across restart/restore, and no contacts or grants are fabricated by migration.

**Commit 5 — Durable conversations, messages, dedup, results, and message retention.** Persist the information and enforce the constraints above; preserve conversation identity, participant binding, ordering, deduplication, and collectable status across agent and message deletion; define team-deletion handling; allocate origin IDs durably; require identical replay to return the same state and changed recognized envelopes to conflict even after compaction or deletion; require one ordered request stream with gaps and forks rejected; require an explicit durable result before `completed`; never cascade conversation history with a local owner. Retention is message-level and co-designed with dedup: compact each terminal message at its window, delete it at its later window while preserving the status-only guarantees above, and never reap non-terminal or `unknown` messages. Transaction/restart tests prove replay, conflict, collection, compaction, and deletion behavior.
*Gate:* a committed acceptance survives restart; replay returns the same state; changed content under the same ID returns `idempotency_conflict` before and after compaction/deletion; retained, compacted, and deleted messages collect according to the frozen contract and never re-execute; a completed message compacts and deletes while its conversation remains usable for a later ordered request.

**Commit 6 — Trusted local source context and operator configuration.** Reuse manager-owned launch/typed-internal context; `X-Id-Agent`/team headers trusted **within the host domain**; derive `local_team_id` from context and never let a request body override it; explicit team context for operator actions with audit; **no** separate operator credential. Operator APIs for contact CRUD, team lead assignment, inbound policy, and normalized org/group/member/tag inspection and mutation. A stopped agent may be assigned as team lead; availability is not a precondition for assignment or for `open`. Tests that caller/team mismatches fail as correctness violations and bodies cannot select another contact owner. Document and test the single-host boundary explicitly, including that a malicious same-UID worker can forge another team's assertion and V1 does not defend against it.
*Gate:* ordinary flows preserve source-team context; the same alias is safe in two teams; no local token/capability exists to leak or be mistaken for tenant isolation.

### Phase C — Same-manager delivery

Direct-agent addressing materially changes all four commits here.

**Commit 7 — Destination union, strict receiver-local resolution.** Resolve the contact pin, then the team by immutable ID; implement `team`, `agent_name`, and `agent_id`; exact team-scoped name resolution that rejects ambiguity and never uses most-recent; exact ID validation that rejects an agent outside the destination team; one shared processing-capable/availability predicate; pin the immutable agent ID at acceptance.
*Tests:* valid/unknown/ambiguous/stopped/wrong-team/name-and-ID/rename-before-and-after/delete/delete-recreate.

**Commit 8 — Acceptance service, policy-before-recipient.** One post-transport acceptance service for same-manager and future federation transports; reject a federation request claiming our node ID while allowing same-manager trusted local context; trust a federation origin-team assertion; resolve the destination team; apply policy, capacity, and ordering before recipient lookup where applicable; validate continuation participants before deduplication or other conversation access; short-circuit identical accepted duplicates before mutable re-evaluation and reject changed-envelope reuse; derive continuation role and binding rather than trusting a caller-supplied target; commit before `202`; stable pre-accept errors allocate no accepted or deduplication state; enforce body-size/per-origin/per-team/per-direct-recipient/processor bounds.
*Tests:* a closed team returns `target_closed` for a new conversation to known and unknown names alike, with a resolver spy proving no agent lookup; an open team resolves all three variants and does not consult the team lead for a direct target; a third node/team with a known conversation ID gets `conversation_not_found`, the same result as an unknown ID, and creates no state; changed contact, policy, name, or caller-supplied target cannot alter a continuation binding.

**Commit 9 — Async processor and recipient lifecycle.** Process accepted messages post-transaction; team messages use the team lead configured at processing time, direct messages use the pinned agent ID; establish the durable local-job link before reporting `processing`; leave accepted work accepted while an agent is stopped; let a newly assigned team lead take pending team work; fail bound direct work `recipient_deleted` on deletion; recover accepted/processing on restart without exactly-once claims; process the conversation request stream serially; record an explicit durable result before `completed`; reconcile `unknown` only on durable evidence.
*Tests:* stopped-after-accept stays accepted; same-ID restart proceeds; rename does not break continuation; deletion differs from team-lead reassignment.

**Commit 10 — Result collection, status, roster reads, CLI/TUI, local E2E.** Origin-only, non-consuming collection by conversation and message ID for all five states; the same `conversation_not_found` result for unknown and non-participant reads; an origin-team conversation index with receipt-aware latest-message state, `outstanding|terminal` filtering, and whole-read count/encoded-size failure; retained result/failure detail and post-retention status-only behavior; status inspection and exact product copy; descriptors with live rosters (leaf group names, but no IDs, no tree, no lead hint); publish each agent's stored catalog whole and label it non-authoritative; return `recipient_ambiguous` for a duplicated name, with ID addressing as the escape hatch; per-node bounds without silent partials; teach clients to prefer `team:<alias>` while exposing permitted name and ID direct paths. E2E: two teams on one manager, all destination variants, team-isolated conversation listing with no bodies, collection in every state and after repeated reads, restart recovery, lost-response dedup, team-lead reassignment, broken pins, ordered requests, capacity rejection without dropping accepted messages, force-delete of an owner with work outstanding, and roster reads succeeding against both an open and a closed team.
*Gate:* no V1 caller dials a worker URL; after restart, collection reconstructs the status and every retained result or failure from durable state without worker memory.

### Phase D — Remove the shared-team-folder dependency

Order is strict: commit 13 cannot land before the commit-3 gate or commits 11–12.

**Commit 11 — Relocate exports, archives, config write-back.** Move auto-exports out of `workspace/teams/<team>`; manual-export fallback to an operator/config root; remove runtime profile dependence on mutating a remembered config path (DB authoritative, export explicit); replace "archive to folder then delete rows" with a store/retention policy that cannot lose data on write failure; keep import/diff as explicit operator ops; fix the false "re-export or re-deploy" remediation and the shared-folder chart instruction.
*Gate:* export, auto-export, profile edit, news retention neither read nor create the team directory.

**Commit 12 — Replace shared files and client filesystem shortcuts.** Remove `ID_SHARED_DIR` from worker launch and worker `/files/teams`, `/files/shared`, and shared listing; add bounded manager resources for org, config inventory, heartbeat definition, agent artifacts, avatars (never arbitrary path fetch); move TUI/CLI views to those APIs; update skills/runtime copy/docs; remove/update the unwired `/shared/files` helpers.
*Gate:* an off-machine client performs supported reads without host filesystem access; worker file APIs expose only the agent's declared artifact/work root.

**Commit 13 — Stop creating and depending on team directories.** Remove all directory creation (constructor, middleware, lookup, create, deploy, spawn, seeding, local-agent, worker) and obsolete helpers; add a read-only residual-file audit and a separate explicit backup/quarantine cleanup; do not recursively delete operator data in an automatic migration; test that delete/recreate of a same-name team cannot inherit stale files.
*Gate:* repository search and integration tests prove normal manager/worker/deploy/send/export/archive/TUI flows never create `workspace/teams/<team>`. (This also closes the existing local-isolation defect where a deleted team's directory outlives its DB row and can leak into a same-name replacement.)

### Phase E — Remote managers

**Commit 14 — Two-manager loopback transport (test only).** Two managers, distinct DBs/node IDs/work roots/ports; a **test-only** loopback adapter that cannot enable a non-loopback listener; manager-to-manager only, workers loopback-only; exercise commit-8 acceptance, commit-5 dedup, origin polling, message/descriptor/roster operations, and origin-side result collection through the same production boundaries.
*Gate:* a federation request claiming the receiver's `nodeId` is rejected before durable acceptance; a lost `202` + resubmission returns one destination message and no second acceptance; with only the origin-to-destination route configured, submission, processing, completion, status, and repeated collection succeed while a destination outbound-network spy observes zero connection attempts.

**Commit 15 — Federation listener binding.** Read the federation bind address from configuration and listen on it; the code contains no network-specific logic or vocabulary. Refuse to start when the bind address is the wildcard (`0.0.0.0` or `::`) unless a separate explicit override flag is set — the wildcard is the one dangerous value because it silently exposes the port to every network the machine is attached to, so it must require intent (a startup warning is not sufficient). Identity is never derived from the connection. Reject a federation request whose `nodeId` equals our own before dedup or policy. Trust the connecting node's origin-team without grants/credentials/invite. Resolve outbound peers only via separate local route configuration keyed by intrinsic `nodeId` (no reply URL/redirect/DNS locator/endpoint update from protocol data); results collected by the origin over its own outbound route; protocol/size/timeout/queue/concurrency bounds. The deployment guide documents binding a Tailscale or LAN address, and the Tailscale `tag:idagents -> tag:idagents:<manager-port>` ACL, as operator choices — not design constraints.
*Gate:* the listener binds the configured address; startup refuses the wildcard without the override and succeeds with it; a non-wildcard bind starts normally; a federation request claiming our own `nodeId` creates no accepted/dedup state; a connecting node succeeds with no application credential and no stored per-peer state; worker ports remain unreachable off-node.

**Commit 16 — Multi-computer operations and diagnostics.** Operator flows for peer-route configuration, contact creation, ACL/bind verification, policy, team lead, roster reads, and status; display local alias separately from remote team display name; display direct recipients as name or immutable-ID selectors; run the two-manager fault matrix across two computers.
*Gate:* all Phase E tests pass under peer outage, bind misconfiguration, mixed adjacent protocol versions, destination restart, and roster reads against both policies.

---

## Acceptance matrix

### Identity and contacts
- A random intrinsic node ID is generated once and survives restart, restore-in-place, endpoint movement, and device rotation.
- The wire `nodeId` is a non-secret value taken at face value on the configured federation listener; no per-peer state is stored.
- A federation request whose `nodeId` equals our own is rejected before deduplication or policy, while same-manager in-process delivery with the local node identity succeeds.
- Contact pins survive display rename and endpoint movement.
- Target team delete/recreate with the same name remains broken.
- Contact alias uniqueness is per sending local team.
- The sending node's origin-team assertion is trusted; compromise of that node can impersonate its other local teams (accepted risk).

### Policy and direct addressing
- Team, agent-name, and agent-ID variants resolve the destination team and apply policy first.
- Closed sends to known and unknown direct names both return `target_closed`, and a resolver spy records no agent lookup in either case.
- Team-addressed send with no assigned or available team lead returns `team_lead_unavailable`.
- Open direct-agent send uses the exact local name or immutable ID and never consults the team lead.
- No `direct_addressing` flag or triage gate exists.
- Recipient result codes are intentionally name-enumerable, and any team publishes its live roster.
- Unknown/ambiguous/stopped/renamed/deleted/recreated names and wrong-team IDs follow the frozen codes and lifecycle.
- A new direct conversation resolves the name once; every continuation uses the pinned ID and fails loudly rather than retargeting after delete/recreate.
- A rename does not interrupt a conversation using its pinned agent ID; deletion fails rather than reaching a different agent.
- Descriptor and roster reads succeed regardless of the team's inbound policy; only new conversations are refused by `closed`.
- The roster carries each agent's `agentId` and stored catalog whole, and exposes no hierarchy or lead hint.

### Durability and failure
- Destination restart after acceptance preserves the message.
- Recipient stop after acceptance leaves `accepted`, not `processing`.
- `processing` appears only after a durable local query mapping.
- Lost `202` + identical resubmission deduplicates; same ID + changed content conflicts.
- Same ID + changed content still returns `idempotency_conflict` after body compaction and message deletion.
- Collection by the pinned origin returns each of the five states, is non-consuming across repeated reads, and returns explicit empty results without treating them as missing.
- Collection by any other node/team and collection of unknown IDs both return `conversation_not_found` without revealing which case occurred.
- Conversation listing returns only the trusted caller team's origin-owned rows; a non-owner gets its own list or empty, never evidence that another team's rows exist.
- Conversation listing exposes destination pins, latest-message state/timestamps, and receipt-backed terminal state, but no request body, result, or failure detail; count and encoded-size overflow fail the whole selected read.
- `state=outstanding` selects latest `accepted|processing|unknown`; `state=terminal` selects latest `completed|failed`; no filter lists all, subject to the same hard bounds.
- Recipient completion + lost response is collectable by message/conversation ID, including after destination restart without worker memory.
- One origin-submitted request stream rejects gaps, reused positions, and predecessor forks and processes serially; the destination never advances a second stream.
- A continuation from any node/team other than the pinned origin, or with a changed destination/recipient, is rejected before acceptance and creates no deduplication state.
- Capacity rejection never removes or downgrades an accepted row; per-recipient backlog rejects targeted saturation independently.
- `unknown` advances only on durable completion/failure evidence.
- Agent/team deletion does not cascade-delete accepted history.
- Origin outage does not delete destination acceptance; unknown outcome is reported as unknown, never inferred as failure.

### Storage bounds and retention
- A retry of a payload-compacted message still deduplicates and returns terminal status; collection identifies the result payload as removed by retention.
- A retry of a deleted message returns its status-only receipt and is never re-executed; collection identifies result and failure detail as removed by retention.
- A resubmission past the 30-day horizon is rejected by the origin.
- Non-terminal and `unknown` rows are never reaped; `unknown` older than the compaction window is surfaced for reconciliation, not deleted.
- A completed message in a still-usable conversation reaches compaction and deletion, after which the origin can submit the next valid ordered request without any close operation.
- A referenced `queries` row follows its message's retention, not its own.
- With sweeps disabled, duplicate retries still deduplicate, non-terminal and `unknown` rows remain present, and no accepted message re-executes; storage alone grows.
- SQLite reclaims space after sweep + incremental vacuum; Postgres reclaims via autovacuum; a full VACUUM is operator-invoked and informed.

### Protocol compatibility

- A peer one minor apart within the same major interoperates for send, completion and collection; unrecognized fields are ignored rather than rejected.
- A peer on a different major returns `protocol_unsupported` and no message is accepted.

### Reverse routing and trusted-fleet deployment
- No request or stored message has a `replyUrl`.
- No protocol field can add or update a locator; outbound routing uses only separate local peer-route configuration keyed by intrinsic node ID.
- With only the origin-to-destination route configured and no destination route, submission, processing, completion, status, and repeated collection succeed; a destination outbound-network spy observes zero connection attempts.
- Worker ports are not used by federation.
- The federation listener binds a configured address and refuses to start on the wildcard (`0.0.0.0` or `::`) unless an explicit override flag is set.
- Reaching the configured listener is the entire V1 peer result; no certificate, token, worker capability, team grant, invite, or stored per-peer state exists.
- The envelope has no sender-declared authentication scheme; a future connection authenticator owns scheme selection.
- Local headers are trusted only within the accepted single-host domain; hostile same-UID isolation is not claimed.

### Organization and folder removal
- No persisted, API, or protocol relationship makes one team the parent of another; groups cannot cross teams.
- Both databases reject cross-team parents/leads/members, duplicate sibling names at root and under a parent, and write-time cycles.
- Shared normalization vectors produce identical stored keys in parser, migration, service, SQLite, and Postgres.
- Insert, move, and delete operations leave sibling and membership order deterministic and gap-free in both databases.
- Group deletion restricts on children; explicit subtree deletion never silently reparents.
- Agent soft delete leaves no visible lead, member, or tag ghosts; exact tag search excludes deleted agents.
- Corrupt org state returns `org_data_corrupt`, returns no partial render, and enforces depth and node bounds.
- Backfill classifies all nine currently unpopulated teams, preserves the four source orgs' groups/descriptions/order/tags, and blocks malformed/unresolved input without partial rows.
- New deploy/import and the fleet backfill use the same normalized writer and reader.
- Nullable leads are accepted explicitly; no missing lead is guessed.
- YAML tag inversion preserves exact organization-tag search behavior; catalog expertise neither seeds nor mutates organization tags.
- Backfill rejects unexpanded templates, snapshots before mutation, and has a tested/refusing rollback contract.
- Drift requires operator acknowledgment; genuinely absent/unrecoverable org requires an audited per-team no-org override.
- Org render and per-agent context work with the team folder absent.
- No descriptor or remote route exposes hierarchy; the roster is the only V1 org-discovery surface.
- Export, auto-export, news retention, profile mutation, TUI, and worker startup do not recreate the folder.
- Team delete/recreate cannot inherit prior files.

---

## Deferred work

Deliberately out of V1, so nobody assumes them:

- **Detecting a duplicated manager.** Copying `~/.id-agents/id-agents.db` — a backup restore, a VM clone, a machine move — produces two managers sharing one `nodeId`. Both federate; conversations and deduplication keys pinned to that ID become ambiguous; nothing reports it. Detecting this requires remembering which source presented which ID, and that memory was deliberately rejected: it is a table, a lookup on every request, and a rotation-recovery flow, all bought to catch an accident in a trusted fleet, and the remembered values are tied to whatever the current transport supplies — so changing transport would strand them. The one free case is still caught: a request claiming our own `nodeId` is rejected. **Operators should generate a fresh `nodeId` when cloning a machine**, and treat "restore the database onto a second live host" as unsupported.
- Any third-party-hosting consent/auth model — automatic enrollment must be disabled and peer authorization/consent, origin-team trust, credential issuance/revocation, and hostile local-principal isolation must be designed together.
- **Destination-initiated messages and pushed replies.** V1 is request and result, collected by the origin, so peer routes need to exist in only one direction. A destination that speaks first needs an outbound path back to the origin, which means bidirectional route configuration and a way to address the origin without a locator on the wire.
- Stable named-recipient bindings or deleted-name tombstones (V1 pins per conversation only).
- **Publishing agent wallet addresses.** An OWS wallet has an address per chain (`eip155:1`, `eip155:8453`, `solana`, …), reachable today only by shelling out to `ows` per chain. The database keeps just the Ethereum-mainnet address, captured by a regex over the create output — and empty when that match fails. Storing the full per-chain set locally comes first; only then is there something honest to publish, as a map rather than a single field.
- Any future triage gate for `open` (a breaking policy change requiring versioning/migration).
- Any remote tag operation. Tags travel in the roster and readers filter locally; a server-side filter, and any multi-team or fleet-wide fan-out with its partial-result contract, are deferred.
- Automatic handler retry/backoff; cancellation/expiry policy; exactly-once handler execution.
- Roster replication or durable remote-agent identity rows.
- Remote task/schedule/wallet/lifecycle or arbitrary artifact mutation.
- Shared Postgres, consensus, or gossip.
- An application-level authenticator (credentials, key lifecycle, per-peer binding) for exposing federation beyond a trusted network. Adding one does not reopen identity, pins, deduplication, the envelope, or host trust.
- Hostile same-UID worker isolation — to be revisited with peer consent, origin-team trust, and credential lifecycle before third-party teams.

**Implementation entry point:** commits 1–3 only. Stop after the commit-3 schema/backfill gate before commits 4–6 add node identity, durable message storage, and trusted local context. Commit 6 takes its own schema/context/operator review before any delivery work begins — the first commit that actually accepts a message is commit 8, and the first that processes one is commit 9.
