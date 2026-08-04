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
