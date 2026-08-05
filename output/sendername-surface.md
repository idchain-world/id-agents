# Recipient-visible sender-name claim

Task: `surface-sendername-recipient`

## Outcome

The receiver now surfaces a non-null wire `senderName` claim in the exact prompt sent
to the recipient agent:

```text
[inter-team message; sender claims to be "dev1"; unverified]
<message body>
```

The same rendered prompt is stored in `queries.prompt` for receiver-local audit. An
absent or null claim produces the original body with no attribution line and no
`unknown`, `external`, or other placeholder. No sender team name is rendered because
the receiver has no trustworthy remote team-name value.

## Security and behavioral boundaries

- The claim is stripped of control, format, bidi, and newline code points.
- Input is bounded to 80 Unicode code points and rendered output to 160 characters.
- Framing punctuation is escaped, so attacker text cannot close or create a prompt
  frame line.
- Runtime delivery keeps the authoritative-looking `from` value fixed at
  `inter-team`; the remote claim never becomes runtime identity.
- Rendering is confined to the processor's display/audit prompt. Routing, admission,
  ordering, replay, deduplication, capacity, collection, and comparison identity are
  unchanged. The existing contract test proving changed `senderName` values are an
  identical replay remains unchanged and passing.

## Coverage

- Named sender claim reaches the production runtime's agent-visible `/talk` prompt.
- An omitted 1.0-era claim renders no attribution in either dispatch or audit prompt.
- Hostile newlines, controls, bidi override, fake framing, and excess length are
  neutralized.
- Existing handler selection and fixed `from: inter-team` assertions still pass.
- Abandoned-job redispatch uses the same render seam.

## Verification

- Full inter-team suite: 13 files, 130 tests passed under Node 22.
- TypeScript: `tsc --noEmit` passed under Node 22.
- `git diff --check` passed.
- Seniordev paired review: SHIP; independent result reported as 172 relevant tests
  plus TypeScript verification.
- Only in-memory and temporary test databases were used. The live
  `~/.id-agents/id-agents.db` was not opened, migrated, or written.

Prem's pre-existing working-tree changes in
`docs/design/inter-team-communication.md`, `src/agent-manager-db.ts`, and
`src/dashboard-core/api/types.ts` were preserved; only the sender-claim hunks in the
first two files belong to this implementation, and the unrelated hunks remain
uncommitted.
