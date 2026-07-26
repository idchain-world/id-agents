# /sync — REMOVED

`/sync` no longer exists. The database is the source of truth and config files
are import/export artifacts (D3), so a config file may no longer reconcile
itself into — or delete out of — a live team.

Running `/sync` returns a message naming its replacements rather than an
unknown-command error. The command is still listed in help and still
tab-completes, deliberately: the person typing it is exactly the person who
needs to be told what replaced it.

## What replaced each capability

| You used `/sync` to…                        | Use now |
|---------------------------------------------|---------|
| See what a config would change               | `/diff <team> <config>` — read-only, changes nothing |
| Add an agent to a live team                  | `/agents spawn <name> …` |
| Remove an agent from a live team             | `/agents remove <name>` |
| Change a model                               | `/model <agent> <model>` |
| Get a config file back out of a live team    | `/export <team> [path]` |
| Stand up a team from a config file           | `/import <file> [--team <name>]` (new team) or `/deploy <config>` (new team only) |
| Re-apply a YAML "floor" over runtime drift   | Nothing. This was the YAML-as-floor merge, deleted by D2 — runtime state is authoritative and is not overwritten. |

## Why it was removed

`/sync` treated the YAML as authoritative and the database as something to be
corrected. That is backwards once the database holds state no config can
express — wallets, ENS identity, DMZ posture, runtime catalog edits. Every
reconciliation was an opportunity to silently discard state that only existed
in the database.

`/deploy` is now create-only: it refuses a team that already has agents (409,
`team_exists`) rather than merging into it. Changing a live team is done with
surgical commands, and drift is *inspected* with `/diff` rather than
*resolved* by overwriting one side.

## NOT removed: `id-agents sync` (the workspace CLI)

```bash
id-agents sync <config> [--workspace <path>]
id-agents unsync <config> [--workspace <path>]
```

This is a **different command that happens to share a name**. It is the
receipt-driven workspace deploy: it writes template files into a workspace,
records what it wrote in `.id-agents/receipt.json`, and `unsync` reverses only
those files. It is additive, never modifies a file the user owns, and uses the
4-case SHA ownership rule to avoid clobbering local edits.

It has nothing to do with team reconciliation and is unaffected by this
removal. Do not delete it on a name match.

## See also

- `/diff` — SPEC §8. `src/sync.ts` survives and is re-exported through it, so
  the per-agent diff logic that `/sync` used still runs; only the mutation is
  gone.
- `/export`, `/import` — SPEC §5, §7.
- `/deploy` refusal contract — SPEC §4.
