# ID Agents Documentation

**Version 0.1.72-beta**

Documentation for the ID Agents multi-agent orchestration platform.

## Architecture

- [Architecture Overview](./reference/architecture.md) - How the manager, agents, and CLI work together. Start here.
- [Scheduling Plan](./SCHEDULING_PLAN.md) - Unified interval/calendar scheduling, delivery modes, and `/schedule` endpoint design
- [Modular Runtime Plan](./MODULAR_RUNTIME_PLAN.md) - Runtime registry, validation, and mixed-team launch design for Claude, Codex, and Cursor runtimes

## Guides

- [Interactive Agent Guide](./guides/interactive-agent.md) - Run the interactive CLI
- [Sync Command Guide](./guides/sync-command.md) - `/sync` is REMOVED; what replaced it (`/diff`, `/agents spawn|remove`, `/export`, `/import`)
- [Admin Control Guide](./guides/idagents-admin-control.md) - Programmatic team management via `/remote`, talk-to-manager, and agent reply polling
- [Task Tracking Guide](./guides/tasks.md) - Task lifecycle, handoff pattern, and stale task verification
- [News Feed Guide](./guides/news-feed.md) - Loop-safe message channel and multi-reply catch-all
- [Agent Outputs Guide](./guides/agent-outputs.md) - Output convention, `/output`, and `/artifact`
- [Heartbeats Guide](./guides/heartbeats.md) - Agent-driven heartbeat system via HEARTBEAT.md
- [TUI Dashboard Guide](./guides/tui.md) - Live terminal dashboard for the running team

## Protocols

- [REST-AP Protocol](./protocol/rest-ap.md) - REST Agent Protocol specification for agent communication

## Reference

- [Architecture](./reference/architecture.md) - System architecture, message flow, database schema, key files
- [Configuration](./reference/configuration.md) - YAML configuration file reference
- [Database Schema](./reference/database.md) - PostgreSQL database tables and schema
- [Harnesses](./reference/harnesses.md) - LLM runtime backends (Claude Agent SDK, Claude Code CLI, Codex, Cursor)
- [ID Indexer API](./reference/id-indexer-api.md) - Historical: indexer API for the removed onchain registry integration

## Deployment

- [Hetzner Cloud Deployment](./deployment/hetzner.md) - Single VM deployment guide
- [Hetzner VPS Setup](./deployment/hetzner-setup.md) - Detailed VPS setup guide

## ERC Drafts

- [Agent Identifiers](./erc-draft-agent-identifiers.md) - EIP draft for onchain agent identifiers

## Skills

Skills are deployed at deploy time to the runtime-appropriate directory: `.claude/skills/` for Claude agents, `.agents/skills/` for Codex agents, `.cursor/skills/` for Cursor (`cursor-cli`) agents. All configs should include `skills: [identity, inter-agent, catalog]` at minimum.

- [Skills Overview](../skills/README.md) - Available skills and usage guide
- [Identity](../skills/identity/SKILL.md) - Agent name and team
- [Inter-Agent](../skills/inter-agent/SKILL.md) - Agent-to-agent messaging via `/talk-to`
- [Catalog](../skills/catalog/SKILL.md) - REST-AP self-description
- [Task Discipline](../skills/task-discipline/SKILL.md) - Required task lifecycle for non-trivial work
- [Wallet](../skills/wallet/SKILL.md) - OWS wallet operations
- [XMTP](../skills/xmtp/SKILL.md) - Encrypted agent messaging
- [Admin Control](../skills/idagents-admin-control/SKILL.md) - Remote CLI management

## Plugins

- [Plugins Overview](../plugins/README.md) - Plugin system and configuration
