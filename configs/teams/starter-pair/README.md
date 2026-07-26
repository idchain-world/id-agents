# starter-pair

A minimal two-agent team template — a lead that plans and reviews, and a dev that implements. Use this as the cleanest starting point for a new team; clone it, rename, and edit. No library-agent references and no skill overlays beyond the defaults.

## Shape

- `team.yaml` ships a top-level `team: starter-pair` field. The `/library/install` endpoint rewrites this via YAML AST to your chosen destination name and prepends a `# Installed from configs/teams/starter-pair/team.yaml on YYYY-MM-DD` provenance header. Nested `team:` keys inside maps, tags, or strings are preserved untouched.
- The default skill set (`identity`, `inter-agent`, `catalog`) is declared once under `defaults:` and inherited by both agents.
- `agent:` and `skills:` are peers on each agent entry. This template uses neither, but see `solidity-pair` for a worked example.

## Install

From the manager:

```
POST /library/install
{ "from": "team:starter-pair", "to": "team:<your-team>" }
```

The destination is written to `<libraryRoot>/<your-team>.yaml`. Re-installing requires `force:true`; the source template under `configs/teams/starter-pair/` is never overwritten.

## After install

Deploy with `id-agents sync <config>` (the WORKSPACE CLI — not the removed `/sync` slash command). It is additive and receipt-driven — files the user owns or has edited are left untouched. `id-agents unsync <config>` reverses only the files it wrote, using the workspace receipt at `.id-agents/receipt.json`.
