# solidity-pair

A two-agent smart-contract team: a Foundry/Solidity builder backed by the `foundry-dev` library entry, paired with an adversarial reviewer backed by the `solidity-security` library entry. Same workspace, coordinate via `/ask`.

## Shape

- `team.yaml` ships a top-level `team: solidity-pair` field. The `/library/install` endpoint rewrites this via YAML AST and prepends a `# Installed from configs/teams/solidity-pair/team.yaml on YYYY-MM-DD` provenance header to the written file.
- Each agent declares **peer** `agent:` and `skills:` fields — these are NOT nested. `agent:` picks one entry under `configs/agents/<name>/` and the skill pack bundled with it (foundry-dev ships Foundry/Solidity skills inline). `skills:` is a separate list of zero or more entries under `configs/skills/<name>/` that overlay on top.
- Library entries used: `configs/agents/foundry-dev/`, `configs/agents/solidity-security/`.

## Install

From the manager:

```
POST /library/install
{ "from": "team:solidity-pair", "to": "team:<your-team>" }
```

The destination is written to `<libraryRoot>/<your-team>.yaml`. Re-installing requires `force:true`; the source template under `configs/teams/solidity-pair/` is never overwritten.

## After install

Set both agents' `workingDirectory:` to your contracts checkout, then deploy with `id-agents sync <config>` (the WORKSPACE CLI — not the removed `/sync` slash command). It is additive and receipt-driven; the workspace receipt at `.id-agents/receipt.json` is the ownership ledger. `id-agents unsync <config>` reverses only the files it wrote.

## TUI

Press `l` for the agents library and `s` for the skills library from any TUI top-level view to inspect the entries this template references.
