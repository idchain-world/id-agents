# System Items — id-agents

> Audit inventory of the id-agents codebase. One line per item, numbered sequentially, grouped by category.

Generated: 2026-03-24
Updated: 2026-04-28 — thorough audit: §G fixed misplaced wakeup plan ref, §I added new configs + demos, §J added scheduling/security/protocol/erc-draft docs, §K added identity/wallet/catalog skill entries, §L added id-loader.service + agent demo YAMLs, §M rewritten to reflect extraction to standalone Juno repo, added §O bin/ and §P tools/
Updated: 2026-04-28 — deep audit pass: §A reconciled 1:1 with `find src -name '*.ts' -o -name '*.tsx'` (122 files = 122 entries, no stale refs, no missing additions). All src/ files added in the last 14 days are present. Tightened descriptions for items 5 (checkin-autoclose), 6 (checkin-service), 11 (cli/agent-readiness), 119 (event-producer), 120 (retention) to match current code (topics list, 280-byte preview cap, 5-min sweep cadence, env-override names, atomic bulk-close semantics, owner-inbox news_item write, 8s/250ms/750ms readiness probe budget)
Updated: 2026-04-28 — deep audit take 4: §A re-verified 1:1 (still 122/122). Spot-verified magic numbers in code: `DEFAULT_TICK_INTERVAL_MS=30_000` (checkin-service), `DEFAULT_RETENTION_DAYS=7` / `DEFAULT_RETENTION_COUNT=100_000` / `DEFAULT_RETENTION_INTERVAL_MS=5*60*1000` (retention), `PREVIEW_MAX=280` (event-producer), `timeoutMs=8000` / `intervalMs=250` / `perRequestTimeoutMs=750` (agent-readiness). §C cross-checked against current `agent-manager-db.ts` route registrations. §H added missing `frontend` bundle. §N integration test count 37 → 39 (added `talk-to-reply-qid.test.ts`; `query-failed-event`, `checkin-priority-wake`, `checkin-service-boot` already listed). §O corrected `bin/id-agents` (symlink/npm-bin → `dist/interactive-agent-cli.js`, not `src/id-agents-cli.ts`); added `id-agents-dashboard` per `package.json` bin map. §P clarified `tools/test-manager/index.js` is a standalone in-memory REST-AP test manager (no DB) plus its README.
Updated: 2026-04-28 — exhaustive 14-day audit: walked **290 commits** since 2026-04-14, **615 unique paths touched** (532 still extant, 83 deleted — 62 of those `public-agent/` from Juno extraction). §A still 1:1 (122/122). §J item 5 dropped deleted `docs/guides/admin-control.md`. §J item 7 added missing `docs/reference/database.md` and `docs/reference/id-indexer-api.md`. §K item 3 expanded to enumerate `admin-session.js` + `start-listener.js` helpers under `idagents-admin-control`. §N restructured: section now covers all of `tests/` (integration 39 + unit 24 + repos 6 + helpers + pty-flicker.py) with new items 12 (unit suites) and 13 (repo/schema suites). See "Progress Log" appendix at end of file.
Updated: 2026-04-29 — jrdev rolling 14-day reconcile (commits since 2026-04-15: **269**; **608** unique paths): **v0.1.80-beta** check-in/production hardening landed (`dd5bb23`). §A tightened for `agent-manager-db`, checkin helpers/service, worker `claude-agent-server`, `db-service`/`queries-repo` (**`markFailed`** + **`query:failed`**), **`start-agent-manager`** graceful shutdown hook; §J bumped `CHANGELOG.md` headline to **0.1.80-beta**, split **`Logs.md`** into its own numbered entry (tracked ops runbook, not ephemera); §K noted operator skill refresh for check-in ladders + task-discipline cross-links; appendix Progress Log updated (remove `Logs.md` from “intentionally not added”; note `.gitignore` adds for `.cursor/`, root `/bin/`, demo `.mp4`).
Updated: 2026-05-01 — systemreview heartbeat (follow-up 3): walked single new commit `fc8f18e` *fix(tui): keep TeamsPanel visible on All and public selections* (v0.1.92-beta). §A items **96** (`AgentRow.tsx`) and **109** (`StatusStrip.tsx`) extended to describe `wrap="truncate-end"` clipping on narrow terminals; §J 17 headline → **v0.1.92-beta**. No new files.
Updated: 2026-05-01 — systemreview heartbeat (follow-up 2): walked single new commit `71276b8` *feat(tui): pin public team chip after All* (v0.1.91-beta). §A item 92 (`App.tsx`) extended to mention the team-order sort (`public` after `All`); §J item 17 headline advanced from v0.1.90-beta → **v0.1.91-beta**. No new files.
Updated: 2026-05-01 — systemreview heartbeat (follow-up): walked single new commit `ddfc86d` *feat(tui): window TeamsPanel when team list overflows* (v0.1.90-beta). §A item 113 (`TeamsPanel.tsx`) extended to describe the 5-chip sliding window and `←N` / `N→` overflow indicators. No new files. See Progress Log entry at bottom.
Updated: 2026-05-01 — systemreview heartbeat audit (commits since 2026-04-29: **12**, releases v0.1.84-beta → v0.1.90-beta): TUI help-modal landing (commits `d87271c` `2ee9668` `4625dcd` `401723e`) + TUI MODEL column with abbreviation table (`47d0326` `03079bc` `7a17ecd`) + per-agent heartbeat sections in `HEARTBEAT.md` (`bc55d3b`). §A grew 122 → 124: added `src/tui/components/HelpModal.tsx` (item 102) and `src/tui/util/models.ts` (item 119), with downstream items renumbered. §A item 92 (`App.tsx`) now mentions help-modal popup + key intercept; §A item 96 (`AgentRow.tsx`) now mentions MODEL column (width 10, `abbrevModel`); §A item 99 (`Footer.tsx`) now described as one-liner with `?` help hint. §J added item 20 `HEARTBEAT.md` (root agent-driven heartbeat checklist with per-agent sections). See Progress Log entry at bottom.

---

## A. Source Files

1. `src/agent-manager-db.ts` — Manager daemon: WebSocket, team-scoped REST (agents, talk, message, news, query status, tasks, checkins, events, v3 library inventory, scheduler, remote control); optional wallet provisioning per team config; killAgentProcess guard for rebuild/spawn vs manager PID; wakeup `event_log` retention sweep wiring; boots and stops per-team **`CheckinService`** with daemon lifecycle; checkin auto-attach on `/talk-to` and task-terminal auto-close hooks; `/news` honors `skip_persist` + `in_reply_to` for wake/reply correlation without duplicate inbox writes; caller error replies routed through **`QueriesRepository.markFailed`** with **`query:failed`** wakeup events; rejects `POST /checkins` against already-terminal linked tasks (`409 linked_task_terminal`) [SEC: pass — local-daemon trust model is by design (see HEARTBEAT.md scope guardrail); unauthenticated `X-Id-Agent` and caller-supplied `from`/`in_reply_to` are accepted on the manager daemon. Different rule applies to public-agent-remote workers, which this file does not own.]
2. `src/agent-rest-server.ts` — Re-exports `AgentRestServer` and news types from `claude-agent-server` (runtime-neutral) [SEC: pass — pure re-export shim with no logic, no I/O, and no trust boundary; security posture is fully delegated to `claude-agent-server.ts`.]
3. `src/agent-restap-cli.ts` — Re-exports `claude-restap-cli` (runtime-neutral REST-AP CLI entry) [SEC: pass — single side-effect import shim, no logic/I/O/trust boundary; security posture is fully delegated to `claude-restap-cli.ts`.]
4. `src/checkins/checkin-api-helpers.ts` — Shared HTTP helpers for manager `/checkins` routes (parse duration, payload validation, response shapes); normalizes `owner` / `ownerId` across create/list/snooze/close handlers; rejects creates that would attach to terminal tasks (`409 linked_task_terminal`) [SEC: pass — pure validators (anchored duration regex, allowlisted priority/status, 1024-char note clamp) and a row→envelope shaper; `generateCheckinId` uses `Math.random` but the id is a db key under the local-daemon trust model, not a security token.]
5. `src/checkins/checkin-autoclose.ts` — Auto-close hook: when a task hits a terminal status, atomically bulk-closes every active/snoozed checkin linked to that task (`closed_reason='linked_task_terminal'`, clears `next_fire_at`/`snooze_until`) and emits one `checkin:closed` event per pre-close snapshot row. Currently bound by direct call from the task-done route [SEC: pass — typed orchestration over team-scoped repo calls; bulk close is atomic at the repo, no injection/path/shell surfaces, and trust of caller-supplied `teamId`/`taskId` is the accepted local-daemon model.]
6. `src/checkins/checkin-service.ts` — Per-team checkin due-service on a 30s tick: hard-expire TTL rows first (`checkin:expired`), re-activate snoozed rows when `snooze_until <= now`, fire due rows (write `news_item` to owner inbox + emit `checkin:due` + advance `next_fire_at`), and call optional `dispatchWake` hook so the manager wakes the owner on **every** due fire (**`priority`** is payload metadata for downstream pacing, not a suppress gate that skips wakes) [SEC: pass — server-driven tick over team-scoped repo calls; `fetchTaskById` uses parameterized queries (dialect-aware placeholders), all DB writes carry `team_id` from the row, dispatchWake errors are swallowed by design, and `checkin_id` interpolated into action paths is server-generated (`chk_<unix>_<rand>`).]
7. `src/claude-agent-cli.ts` — Claude agent CLI entrypoint [SEC: pass — local interactive readline CLI run by the user; no network listener, no untrusted input source. Granting Bash/Write/Edit to the SDK is the documented purpose of the tool, not a privilege escalation vector.]
8. `src/claude-agent-server.ts` — Per-agent REST-AP Express app (`/talk`, `/news`, `/query`, files, schedule, optional XMTP); reply/agent broadcasts hoist `in_reply_to` and seed downstream `query_id` so `/talk-to` waiter routing and `/news?query_id=` lookups align with originating queries
9. `src/claude-agent.ts` — Claude agent wrapper and entrypoint [STATUS: PASS] Curated env whitelist, bypassPermissions intentional, no shell execution
10. `src/claude-restap-cli.ts` — Worker REST-AP CLI entrypoint
11. `src/cli/agent-readiness.ts` — `waitForAgentReady`: polls a worker's `/.well-known/restap.json` with a deadline (default 8s timeout, 250ms interval, 750ms per-request) so an `/ask` immediately after `/sync` or `/deploy` does not race the listening port [STATUS: PASS w/ residual] The function itself is clean: bounded outer deadline, per-request `AbortSignal.timeout`, no credentials sent, no response body read, errors swallowed by design, and the pre-sleep deadline check prevents overshoot. Residual is at the caller, not here — `probeNewAgentsReady` (`interactive-agent-cli.ts:4426`) derives the probe URL from `row.url || row.endpoint`, and `endpoint` is the unvalidated `POST /agents/register` field, so this is one more fetch site fanning off that known SSRF. Low severity in this path: blind GET, boolean-only outcome surfaced as a readiness warning, 8s bound. The other two call sites (4615, 4667) pass a literal `http://localhost:${port}` and are unaffected
12. `src/cli/public-commands.ts` — Public-team agent CLI subcommands
13. `src/cli/workspace-sync.ts` — Workspace and deploy sync utilities for the CLI
14. `src/config-parser.ts` — YAML config parsing, parameter substitution, plugin resolution; team-level wallet opt-in / scope fields consumed by deploy + manager
15. `src/core/agent-identifier.ts` — Agent display ID, alias normalization, identity resolution
16. `src/core/agent-service.ts` — Shared agent CRUD operations (DB access)
17. `src/core/config-utils.ts` — `findProjectRoot`, dotenv read helpers
18. `src/core/file-service.ts` — File operations for agent workspace and shared directories
19. `src/core/index.ts` — Core re-exports
20. `src/core/messaging-service.ts` — Message delivery, news items, query management
21. `src/core/safe-compare.ts` — Timing-safe string compare for API keys
22. `src/core/team-service.ts` — Team CRUD and port range allocation [SEC: pass — dead code, same pattern as `file-service.ts`: only `core/index.ts` re-exports it, and the sole consumer of `core/index.js` (`interactive-agent-cli.ts`) imports just `findProjectRoot`/`readDotEnvFile`, not any team-service function. `deleteTeam`'s unsanitized `teamName` → `rmSync(teamDir, {recursive:true,force:true})` would be a path-traversal-to-recursive-delete if ever wired up, so flag before reachability changes.]
23. `src/core/types.ts` — Shared TypeScript types
24. `src/db.ts` — Backward-compatible re-exports to `db/` (`createDb`, `migrateDb`, `getOrCreateTeamId` legacy helper) [STATUS: PASS] Thin facade over modular DB layer; same migration safety as before
25. `src/db/db-adapter.ts` — Abstract DB adapter and connection surface
26. `src/db/db-json.ts` — JSON serialization utilities for round-tripping row blobs
27. `src/db/db-service.ts` — Repository interfaces and composite `Db` type: teams, agents, queries, news, schedules, tasks, events, subscriptions, checkins [STATUS: PASS] Dialect-agnostic app-facing API; implementations in `db/repos/`; `QueriesRepository` adds **`markFailed`** for pending queries that terminate in an error **`reply`** (paired with wakeup `query:failed` emits)
28. `src/db/index.ts` — `createDb` / `migrateDb` / factory wiring (Postgres or SQLite, env-driven)
29. `src/db/migrations/postgres.ts` — PostgreSQL DDL, indexes, and additive migrations
30. `src/db/migrations/sqlite.ts` — SQLite schema migrations
31. `src/db/pg-adapter.ts` — PostgreSQL `DbAdapter` implementation
32. `src/db/sqlite-adapter.ts` — SQLite `DbAdapter` implementation
33. `src/db/types.ts` — Row and entity types shared by repos and service interfaces
34. `src/db/repos/postgres/agents-repo.ts` — PostgreSQL `AgentsRepository` implementation
35. `src/db/repos/postgres/checkins-repo.ts` — PostgreSQL checkins table access
36. `src/db/repos/postgres/events-repo.ts` — PostgreSQL `event_log` / events repository
37. `src/db/repos/postgres/news-repo.ts` — PostgreSQL news feed repository
38. `src/db/repos/postgres/queries-repo.ts` — PostgreSQL query/work item repository (includes `markFailed` flipping `queries.status` → `failed` with error payload while row is still `pending`)
39. `src/db/repos/postgres/schedules-repo.ts` — PostgreSQL schedule definition/run tables
40. `src/db/repos/postgres/subscriptions-repo.ts` — PostgreSQL event subscription delivery rows
41. `src/db/repos/postgres/tasks-repo.ts` — PostgreSQL manager tasks (`/tasks` lifecycle)
42. `src/db/repos/postgres/teams-repo.ts` — PostgreSQL team repository
43. `src/db/repos/sqlite/agents-repo.ts` — SQLite `AgentsRepository` implementation
44. `src/db/repos/sqlite/checkins-repo.ts` — SQLite checkins repository
45. `src/db/repos/sqlite/events-repo.ts` — SQLite events / `event_log` repository
46. `src/db/repos/sqlite/news-repo.ts` — SQLite news repository
47. `src/db/repos/sqlite/queries-repo.ts` — SQLite query repository (includes `markFailed` mirroring Postgres semantics)
48. `src/db/repos/sqlite/schedules-repo.ts` — SQLite schedule tables
49. `src/db/repos/sqlite/subscriptions-repo.ts` — SQLite subscriptions
50. `src/db/repos/sqlite/tasks-repo.ts` — SQLite tasks
51. `src/db/repos/sqlite/teams-repo.ts` — SQLite team repository
52. `src/examples/inter-agent-demo.ts` — Inter-agent communication demo
53. `src/examples/multi-agent-demo.ts` — Multi-agent orchestration demo
54. `src/harness/claude-agent-sdk.ts` — Claude Agent SDK runtime (uses `ANTHROPIC_API_KEY`)
55. `src/harness/claude-code-cli.ts` — Claude Code CLI ("Max" plan) harness
56. `src/harness/codex.ts` — OpenAI Codex CLI harness (spawns `codex exec`) [STATUS: PASS] spawn with array args, prompt via stdin, curated env merge
57. `src/harness/cursor-cli.ts` — Cursor `cursor-agent` headless harness (`-p --output-format stream-json`, resume support)
58. `src/harness/index.ts` — Harness factory and re-exports [STATUS: PASS] Factory maps runtime id → harness, exhaustive switch, no hidden dynamic imports for core paths
59. `src/harness/types.ts` — `HarnessType` (includes `cursor-cli`, `public-agent-remote`, …), `HarnessMessage`, `HarnessOptions`
60. `src/human-agent-cli.ts` — Human-in-the-loop agent CLI
61. `src/id-agents-cli.ts` — Main `npm run id-agents` CLI
62. `src/index.ts` — Package index and re-exports
63. `src/inter-agent-skill.ts` — Agent-facing skill documentation generator
64. `src/inter-agent-tools.ts` — Tool definitions for inter-agent comms
65. `src/interactive-agent-cli.ts` — Full-screen interactive CLI: `/ask`, manager bridge, deploy, `/sync`, wallet provisioning commands, manager inbox resolution + readiness waits (`agent-readiness`), public agents, TUI launch, tasks (`HELP_ITEMS` + extended handlers)
66. `src/interactive-agent-server.ts` — REST-AP HTTP server used only by `src/human-agent-cli.ts` (human-as-agent mode, e.g. `alice` on `:4000`). The interactive manager CLI no longer uses it; the daemon on `:4100` owns the manager identity and inbox.
67. `src/lib/agent-library.ts` — v3 library discovery under `configs/agents` / `configs/skills` (listing only, no deploy)
68. `src/lib/env-hygiene.ts` — Sanitize or validate env for subprocess harnesses
69. `src/lib/fatal-handlers.ts` — Process-level fatal error hooks for long-running services
70. `src/lib/library-inventory.ts` — Library content helpers used by manager `/library/*` routes
71. `src/lib/remote-heartbeat.ts` — Optional heartbeat/telemetry toward manager for remote or long-lived clients
72. `src/lib/ssh-deliver.ts` — SSH-based deploy/delivery for public agents
73. `src/loader-service.ts` — Loader/watcher for auto-starting the manager
74. `src/local-agent-server.ts` — Local per-agent process spawner and lifecycle [STATUS: PASS] Solid lifecycle; `process.env` mutation non-reentrant but one process per agent
75. `src/name-validation.ts` — Team/agent name validation, reserved word list, length and charset rules
76. `src/org-chart.ts` — YAML org chart from config `org` [STATUS: PASS] Pure, no I/O/DB
77. `src/protocol-defaults.ts` — Injected `CLAUDE.md` / framework protocol block (scheduling, task discipline, output convention)
78. `src/runtime/registry.ts` — Runtime profiles and `resolveRuntime`: includes **`public-agent-remote`** for `public-agent/` HTTP worker endpoints alongside local harness IDs (Cursor, Codex, Claude SDK, …)
79. `src/runtime/types.ts` — `RuntimeId`, `RuntimeProfile`, and validation result types
80. `src/scheduling/schedule-config.ts` — Schedule config parsing/merge from team YAML
81. `src/scheduling/schedule-dispatcher.ts` — Resolves which agents receive a schedule tick and builds payloads
82. `src/scheduling/schedule-evaluator.ts` — Interval and calendar schedule evaluation
83. `src/scheduling/schedule-types.ts` — Schedule/dispatch DTOs shared by scheduler
84. `src/scheduling/scheduler-service.ts` — Manager 30s scheduler service (tied to `Db` and agent resolution)
85. `src/start-agent-manager.ts` — One-shot start script for the manager; traps SIGINT/SIGTERM → `await manager.shutdown()` before exit so **`CheckinService`** ticks and other manager subsystems stop cleanly
86. `src/start-agent-rest-server.ts` — One-shot start for `AgentRestServer` (runtime from `ID_HARNESS` / `HARNESS`, port from `CLAUDE_AGENT_PORT`)
87. `src/start-claude-server.ts` — Legacy name: starts worker (delegates to runtime-agnostic path)
88. `src/sync.ts` — v3 `sync` plan: diff spec vs live agents (deterministic skills/plugin ordering for stable “changed” detection), categories new/changed/removed, deploy reconciliation fields
89. `src/test-claude-agent.ts` — Claude agent smoke test [STATUS: PASS] Clean smoke, minor `as any` in places, not a prod entry
90. `src/tui/App.tsx` — Ink TUI root: navigable views — agents, agent detail, news (+detail), tasks (+detail), calendar, heartbeats (+detail), library agents/skills (+detail); polls manager + library endpoints; renders `HelpModal` popup when `?` is pressed and intercepts all keys (including arrows / Esc) to close it before they fall through to the underlying view; **sorts teams so the `public` chip pins immediately after the `All` chip** (regardless of manager response order — applied at App level so `teamCounts`, `teamOptions`, and `TeamsPanel` share the same order, and Tab/Shift+Tab cycling matches the visual order — added v0.1.91-beta, commit `71276b8`); global hotkeys per `Footer` (`l`/`s` library slice, no pause hotkey since v0.1.71-beta)
91. `src/tui/api/manager.ts` — TUI `fetch` helpers against manager (agents, news, tasks, events, health)
92. `src/tui/api/types.ts` — DTOs for TUI API responses
93. `src/tui/components/AgentDetail.tsx` — TUI: single agent detail pane
94. `src/tui/components/AgentRow.tsx` — TUI: one row in the agents list; renders the `MODEL` column (width 10) by piping `agent.model` through `abbrevModel` from `src/tui/util/models.ts` so unknown models render raw and visibly overflow (signal to extend the abbreviation table). All row-level `Text` (header + local-branch + remote-branch with `public-agent-remote` DOMAIN/DMZ columns) sets `wrap="truncate-end"` so on narrow terminals the rightmost columns clip rather than wrapping to a second line and scrolling the top menu off-screen (v0.1.92-beta, commit `fc8f18e`)
95. `src/tui/components/AgentsTable.tsx` — TUI: main agents table
96. `src/tui/components/CalendarView.tsx` — TUI: schedule/calendar slice
97. `src/tui/components/Footer.tsx` — TUI: per-view footer is now a single one-liner (`↑↓ nav · ← back · ? help · q quit`) since v0.1.84-beta — the verbose per-view hint strings were collapsed into the `HelpModal` popup so the dashboard chrome fits narrow terminals
98. `src/tui/components/HeartbeatDetail.tsx` — TUI: heartbeat event detail
99. `src/tui/components/HeartbeatsView.tsx` — TUI: heartbeats list
100. `src/tui/components/HelpModal.tsx` — TUI help popup: three side-by-side columns (Views / Navigate / Global) listing every keybinding with a short description; rendered by `App.tsx` and dismissed with `?`, Esc, or any arrow key (added v0.1.84-beta as a replacement for the long footer hint strings)
101. `src/tui/components/LibraryAgentDetail.tsx` — TUI: v3 library agent card
102. `src/tui/components/LibraryAgentsTable.tsx` — TUI: library agents list (NAME + SHAPE columns; trimmed layout vs older wider tables)
103. `src/tui/components/LibrarySkillDetail.tsx` — TUI: skill detail
104. `src/tui/components/LibrarySkillsTable.tsx` — TUI: skills table
105. `src/tui/components/NewsDetail.tsx` — TUI: one news item body
106. `src/tui/components/NewsView.tsx` — TUI: news feed
107. `src/tui/components/StatusStrip.tsx` — TUI: connection / team status strip; outer `Text` uses `wrap="truncate-end"` so the strip clips rather than wraps on narrow terminals — paired with `AgentRow` truncation in v0.1.92-beta to keep the top menu pinned
108. `src/tui/components/TaskDetail.tsx` — TUI: task detail
109. `src/tui/components/TaskRow.tsx` — TUI: one task row
110. `src/tui/components/TasksTable.tsx` — TUI: tasks table
111. `src/tui/components/TeamsPanel.tsx` — TUI: team list / switch; renders an `All` chip + per-team chips. When `teams.length > 5`, the panel shows a **sliding 5-chip window** centered on the selected team with `←N` / `N→` indicators for hidden teams on either side (Tab cycling already wraps; the window now follows selection — added in v0.1.90-beta, commit `ddfc86d`)
112. `src/tui/hooks/usePolling.ts` — TUI: polling interval hook
113. `src/tui/index.tsx` — TUI `main` — Ink `render` + iTerm2 flash fix for `log-update`
114. `src/tui/util/colors.ts` — TUI: ANSI color helpers
115. `src/tui/util/format.ts` — TUI: text trunc/format
116. `src/tui/util/memory.ts` — TUI: heap / RSS display for status
117. `src/tui/util/models.ts` — TUI model-name abbreviation: hand-edited `MODEL_ABBREVIATIONS` table (`claude-opus-4-6` → `opus-4-6`, `claude-sonnet-4-6` → `sonn-4-6`, `claude-haiku-4-5-20251001` → `haiku-4-5`, `composer-2` → `comp-2`, gpt entries pass-through, …) plus `abbrevModel(model)` lookup. Unknown models return the raw string and visibly overflow the 10-char `MODEL` column — that overflow is the prompt to add a new entry (heuristic fallback removed in v0.1.89-beta per `7a17ecd`)
118. `src/tui/util/schedule.ts` — TUI: next-run and schedule string helpers
119. `src/wakeup-service/event-producer.ts` — Topic emitters for `event_log`: tasks (`task:claimed`, `task:completed`), queries (`query:delivered`, `query:failed`, `query:expired`), checkins (`checkin:created`, `closed`, `snoozed`, `due`, `expired`). Includes a 280-byte message preview cap; producers do not swallow errors so an event-log failure surfaces alongside the lifecycle write
120. `src/wakeup-service/retention.ts` — `event_log` per-team age/count retention sweep (default 7d / 100k rows, env overrides via `EVENT_LOG_RETENTION_DAYS` / `EVENT_LOG_RETENTION_COUNT`); 5-minute default cadence, wired at boot in `agent-manager-db.ts` (`startEventLogRetentionSweep`) [SEC: pass — every delete is team-scoped and fully parameterized in both repo dialects; env overrides fail open (oversized values keep data, never widen the delete); `pruneByCount` clamps negatives and early-returns on `excess <= 0`; start/stop lifecycle complete with reentrancy guard and caught tick errors. Residual: `pruneByAge` is a single unbatched `DELETE`, so a large post-outage backlog runs in one statement.]
121. `src/xmtp/ows-signer.ts` — OWS-backed XMTP signer: delegates signing to OWS CLI
122. `src/xmtp/xmtp-messaging.ts` — `XmtpMessaging` (EventEmitter), allowlist, inbound `startQuery`, ENS resolution

---

## B. CLI Commands (`interactive-agent-cli.ts` — `HELP_ITEMS` and other handlers)

> Primary user-facing help is the alphabetized `HELP_ITEMS` array. Additional `/commands` (registry, manager, TUI, etc.) are implemented in the same file. Numbering is local to this section.

1. `/agent <name> rebuild` — Rebuild a single agent
2. `/agent <name> wallet provision` — Provision an OWS wallet for one agent
3. `/agents` — List all agents
4. `/agents rebuild` — Rebuild all agents
5. `/ask [/hey] <agent> <msg>` — Talk to an agent (session continues) [STATUS: PASS] Event-driven session routing, manager proxy for remote
6. `/ask * <msg>` — Broadcast
7. `/clear [agent]` — Clear tool/session state
8. `/delete <agent>` / `/delete *` / `/delete --team <name>` — Remove agents
9. `/deploy <config> [params]` — Create agents from YAML
10. `/help` (or `/h`) — Show help
11. `/output <agent>` — List `output/` files
12. `/artifact <agent> <path>` — Read artifact under `output/`
13. `/news [-l] <agent>` — Poll or list news
14. `/public` and `/public *` subcommands — Public team agents (list, add via manager-join, remove, chat; optional OWS wallet provisioning at join) [STATUS: REVIEW] See code paths for network/remote surfaces
15. `/heartbeat` / heartbeats & `/calendar` — List/add/manage scheduled pings and calendar prompts
16. `/task create|list|assign|done|remove` — Manager task lifecycle
17. `/sync <config> [params]` — REMOVED (SPEC §9.1/§9.2, D2). Retained only as a stub that answers with its replacements (`lib/sync-removed.ts`, matched at `interactive-agent-cli.ts:2342` both bare and with args). The database is the source of truth; a config may no longer overwrite it. Replacements: `/diff` for drift, `/export`/`/import` for config round-trip, `/model` and `/delete` for live change. Distinct from the `id-agents sync <config>` WORKSPACE CLI (`src/cli/workspace-sync.ts`) and `/sync-wallets`, both of which still exist
18. `/status` — Manager/agent health summary
19. `/update <agent> [--wallet] [--name]` — Update metadata
20. `/wallet <agent> [chain]` — Show wallet
21. `/team` / `/team <name>` / `/teams` / `/team delete` — Team switch and list
22. `/quit` (also `/q`, `/exit`) — Exit
23. `/project` / `/projects` / `/team` / `/teams` — Team/project context (overlaps with 21; see code)
24. `/manager` and `/manager status|reload|health` — Manager connection control
25. `/logs [N]` — Manager activity log
26. `/hey <agent> <msg>` — Like `/ask` with explicit session threading
27. `/cancel <agent>` — Cancel in-flight query on a worker

---

## C. Express Routes — Manager (agent-manager-db.ts)

1. `GET /health` — [STATUS: PASS] Read-only, team context where applicable
2. `GET /library/agents` / `GET /library/agents/:name` / `GET /library/skills` / `GET /library/skills/:name` — v3 library file-backed inventory
3. `GET /agents` — List agents [STATUS: PASS] `agentToResponse` omits `api_key`
4. `GET /agents/status` — Summary [STATUS: PASS] `Promise.allSettled`, bounded timeouts, team header
5. `GET /agents/resolve/:ref` — Name / token / ERC-7930 resolution
6. `GET /agents/by-name/:name` — [STATUS: PASS] Two-stage name resolution, parameterized SQL, team-scoped
7. `GET /agents/:id` — [STATUS: REVIEW] Cross-team read via unscoped get-by-id
8. `GET /agents/:name/news` — [STATUS: REVIEW] Proxy: confirm query string encoding to downstream URL
9. `POST /agents/spawn` — [STATUS: REVIEW] Port allocation, validation (see current handler)
10. `POST /agents/register` — [STATUS: PASS] ID regex, type whitelist, parameterized upsert
11. `POST /agents/:id/metadata` (JSON merge) / `POST /agents/by-name/:name/metadata` — [STATUS: REVIEW] Key whitelist vs arbitrary merge; team scoping differs between routes; compare code
12. `POST /agents/:id/model` — Update model
13. `POST /agents/:id/probe` — Liveness/health probe toward worker URL
14. `DELETE /agents/:id` / `DELETE /agents/by-name/:name` — [STATUS: REVIEW / PASS] `DELETE :id` cross-team via db path; by-name has safer team scope and workspace cleanup
15. `GET /logs` — Activity log
16. `POST /talk` — [STATUS: PASS] Async-202, team-scoped, scheduler-aware
17. `POST /schedule` — Internal `mode: "internal"` wake-ups (self-directed work) — [STATUS: see handler; validate schedule payload]
18. `POST /message` — A2A [STATUS: PASS] Timeouts, team-scoped
19. `POST /talk-to` — [STATUS: PASS] Thin wrapper, bounded timeout
20. `POST /news-to` — Fire targeted news to an agent inbox (A2A helper)
21. `POST /news` / `GET /news` — [STATUS: PASS] Parameterized, bounded forward timeouts where applicable
22. `POST /news/archive` — [STATUS: REVIEW] `days` and transactional consistency — confirm current handler
23. `GET /query/:id` — [STATUS: see handler] Polled by CLI/remote; team-scoped resolution in `queries` table
24. `GET /teams` / `POST /teams` / `PATCH /teams/:name` / `DELETE /teams/:name` — [STATUS: mix] `POST` team name path validation, `DELETE` default-team guard — see `agent-manager-db` around team routes
25. `GET /projects` / `POST /projects` — Aliases for `teams` routes
26. `POST /remote` — [STATUS: PASS] Localhost-oriented operator pipe (auth model is deployment-specific)
27. `GET /:tokenId` — [STATUS: REVIEW] Agent lookup by **numeric** `token_id` only (`/^\d+$/`); non-numeric single-segment paths call `next()` so literals (`/events`, `/tasks`, …) resolve to routes registered below — SSRF/proxy risks remain for `/(\d+)/(.+)` wildcard proxy (see handler)
28. `POST /agents/:name/cancel` — [STATUS: PASS] Team-scoped cancel
29. `PATCH /agents/:id/metadata` — (wallet / rename) [STATUS: REVIEW] Cross-team on id route; see handler for accepted fields
30. `POST /tasks` / `GET /tasks` / `GET /tasks/:ref` / `POST /tasks/:ref/claim` / `POST /tasks/:ref/done` / `DELETE /tasks/:ref` — Manager-owned task stream (receipt-style lifecycle)
31. `GET /events` — Team-scoped catch-up read over `event_log` (same auth/team resolution as `/remote` via `teamContextMiddleware` → `getTeam`). **Query:** `since` — exclusive seq cursor (non-negative integer, default `0`); `limit` — page size (positive integer, default `100`, max `1000`); `topics` — optional comma-separated filter; alias tokens (`query:terminal`, `task:status`, `agent:lifecycle`) expand via `TOPIC_ALIASES` to concrete topic names server-side. **JSON body:** `events[]` (seq, team, topic, occurred_at, actor, subject, data), `next_seq`, `replay_truncated`, `earliest_available_seq` — see `output/wakeup-service-design.md`
32. `POST /checkins` — Create checkin (optional `owner`, `linked_task`, intervals, `close_when`, … per `output/checkin-primitive-design.md`)
33. `GET /checkins` — List/filter checkins for team
34. `DELETE /checkins/:id` — Remove checkin row
35. `POST /checkins/:id/close` — Close with reason
36. `POST /checkins/:id/snooze` — Snooze until timestamp / duration — [STATUS: REVIEW] Same team gating as `/events`; handlers in `checkin-api-helpers.ts`
37. `ALL /^\/(\d+)\/(.+)$/` — Regex route: proxy `/<numeric-token>/<subpath>` to the matching agent’s HTTP endpoint (virtual/interactive vs local port); see inline `fetch` proxy — [STATUS: REVIEW] Upstream URL derived from agent row

---

## D. Express Routes — Worker Agent (claude-agent-server.ts)

1. `GET /health` — Trivial liveness; no sensitive data; auth bypass where appropriate [STATUS: PASS]
2. `GET /.well-known/restap.json` / `GET /catalog` / `PATCH /catalog` — REST-AP and catalog: discovery + mutable catalog [STATUS: PASS] (catalog is public-by-design; name/tokenId may be overridden on GET)
3. `POST /talk` / `POST /clear` / `POST /cancel` — LLM, session reset, cancel: `POST /talk` [STATUS: PASS] async 202, query queue, schedule integration; `POST /cancel` checks harness
4. `GET /news` / `POST /news` — Poll and post news [STATUS: PASS] As in prior pass
5. `GET /query/:id` — [STATUS: PASS] Agent-scoped, parameterized
6. `POST /talk-to` — A2A via manager [STATUS: PASS] Localhost / agent URL from manager, bounded max timeout
7. `PATCH /identity` — Update agent identity [STATUS: PASS] Type and body-size checks; 10KB body cap
8. `GET /files/list` — JSON file listing [STATUS: REVIEW] Merges `/tmp` and working directory; exposes all readable files under `/tmp` as in earlier audit
9. `GET /files` — Browser navigation over file roots [STATUS: REVIEW] Listing branch is a verbatim copy of D.8's walker (same `/tmp` + workdir recursive enumeration, same findings). Walker uses symlink-following `fs.statSync().isDirectory()` instead of `dirent.isDirectory()` and keeps no visited set, so a symlink cycle under `/tmp` recurses unbounded (verified: re-enumerates the same file at every cycle level) and a symlink to an out-of-root dir gets enumerated, then served by the `express.static('/tmp')` mount below. Local-only: server binds `127.0.0.1` (line ~2025)
10. `POST /files/upload` — Upload to agent workspace (size limit) [STATUS: PASS] `path.basename` traversal protection; UTF-8; auth per local model
11. `USE /files` — `express.static` (includes `/tmp` mount) [STATUS: REVIEW] Serves all of `/tmp` readably when mounted first
12. `USE /files/teams` — Team shared `express.static` [STATUS: PASS] Index disabled; manager path
13. `USE /files/shared` — Back-compat alias to team shared [STATUS: PASS]
14. `POST /schedule` — Receive scheduled work on the worker: validates message + `schedule` object, `noAutoReply` to block loops, `mode: "internal"` for wake-ups
15. `POST /xmtp/send` / `GET /xmtp/status` — XMTP bridge [STATUS: PASS] 503 when disabled; see `skills/xmtp` and `xmtp-messaging.ts` for allowlist and ENS

---

## E. Express Routes — Interactive Server (interactive-agent-server.ts)

1. `GET /.well-known/restap.json` — Catalog
2. `POST /remote` — Remote `id-agents` commands for the CLI [STATUS: REVIEW] `apiKeyValidator` exists in module but is not always wired in the handler; confirm current behavior before relying on it
3. `POST /talk` / `GET /news` / `POST /news` — CLI agent loop: talk + poll + ingest; `POST /news` [STATUS: PASS] Thorough noAutoReply/loop noise filtering; confirm pending-question path if you modify it
4. `POST /schedule` — Queues internal schedule as pending work for the CLI user agent [STATUS: PASS w/ residuals] Better validated than its worker twin (D.14): requires `message`, requires `schedule` to be a non-null object, and rejects any `mode` other than `"internal"`. No origin/auth check, but the server binds `127.0.0.1` (line 462) and the JSON body is capped at 10mb (line 55), so reach is local-only. Residuals, all pre-existing: (a) `this.pendingQueries.set()` at line 244 — the Map is never `.delete()`d anywhere in the file (only set/get/values), so every `/talk` and `/schedule` entry is permanent; `newsItems` by contrast IS swept. (b) `message` is truthiness-checked only — no `typeof`/length guard, so a non-string lands in `prompt`. (c) `schedule` passes any object (no `id`/`kind`/`title` shape check) and `linkedTasks` elements are unvalidated; both are stored verbatim into news `data`, which the agent later reads as context

---

## F. Database Tables (db/migrations/ — postgres.ts / sqlite.ts)

1. `teams` — [STATUS: PASS] (see prior audit: names, default team protection, etc.)
2. `agents` — [STATUS: REVIEW] (plaintext api_key; soft-delete semantics; runtime column)
3. `wallets` — Deprecated private-key storage; prefer OWS
4. `news_items` — [STATUS: FIXED] Transfer bug removed; feed for agents and human
5. `queries` — [STATUS: PASS] Query/work unit with session id
6. `schedule_definitions` / `schedule_targets` / `schedule_runs` — Manager scheduler persistence
7. `tasks` / `task_event_links` — Task lifecycle, optional event linkage
8. `event_log` — Wakeup and audit stream (per-team retention via `wakeup-service/retention.ts`)
9. `subscriptions` / `webhook_delivery_attempts` — Outbound event subscription delivery
10. `checkins` — Repeating attention prompts with snooze, TTL, link to tasks and news

---

## G. XMTP Messaging Subsystem

### Integration (claude-agent-server.ts)

1. XMTP client — Lazy `import()` when OWS or XMTP env present; per-agent DB under `.xmtp/`; inbound `noAutoReply`; replies via normal query result path

### Skill

2. `skills/xmtp/SKILL.md` — `curl` examples for `/xmtp/send` and `/xmtp/status`, ENS and security notes

### Scripts

3. `scripts/check-ens-resolution.mjs` — xid.eth CCIP-Read / viem smoke test; `MAINNET_RPC_URL`

### Security Model

4. Sender allowlist tiers (trusted / open when empty / blocked when non-empty)
5. OWS — Signing never in-process key material when using OWS signer
6. MLS / identity verification for inbound [STATUS: REVIEW] The documented human-in-the-loop approval layer is dead code. `approvalCallback` (`xmtp/xmtp-messaging.ts:71`, "This is where human-in-the-loop approval happens") is never assigned anywhere in `src/` — `startXmtp` (`claude-agent-server.ts:2063`) calls only `setMessageHandler`. Both guarded branches are therefore no-ops: inbound approval for non-trusted senders (line 441) and outbound reply approval (line 459). Under `openMode` with an empty allowlist `isSenderAllowed` returns true for any address (line 156) while `isSenderTrusted` returns false — exactly the case the approval gate was meant to backstop. Remaining inbound controls are the self-address echo check (line 414), the allowlist, and the prompt-level warning at `claude-agent-server.ts:2094`. Compounds with the caller-writable `openMode` metadata merge
7. `xmtp_` query prefix and `noAutoReply` isolation for loop prevention [STATUS: REVIEW] Holds for the internal news/talk path only, not XMTP peer-to-peer. `startQuery(..., 'xmtp:<addr>', {noAutoReply:true})` (`claude-agent-server.ts:2124`) suppresses `sendReplyToSender`, but the XMTP reply travels a different path: the inbound handler's return value (line 2110) is sent unconditionally by `handleInbound` via `ctx.conversation.sendText(reply)` (`xmtp-messaging.ts:472`). `noAutoReply` never touches it. The only echo guard is sender==self (line 414), so two mutually-allowlisted (or both open-mode) agents ping-pong indefinitely — one LLM turn per hop, no depth counter, turn cap, or rate limit. Cost/DoS amplifier, not data exposure. Any fix belongs in `handleInbound` as a per-`conversationId` turn counter. Cosmetic: the `response.saved` news entry logs "not sent - triggered message" (line 1884), which is wrong for XMTP — the reply *is* sent

---

## H. Bundled v3 library (`configs/agents/`, `configs/skills/`)

1. `configs/agents/*` — Ship-ready agent bundles (`copywriter`, `devops`, `editor`, `foundry-dev`, `frontend`, `frontend-react`, `fullstack-nextjs`, `security`, `solidity-security`): each has `CLAUDE.md`, optional `README.md`, nested `skills/<name>/SKILL.md` plus references/scripts — enumerated by `src/lib/agent-library.ts` and `/library/agents*`
2. `configs/skills/*` — Standalone skill packages referenced by YAML `skills:` lists — enumerated by `/library/skills*`
3. Import footprint — Recent history adds hundreds of third-party–style assets under agent bundles (React rulesets, CodeQL refs, etc.); treated as content, not runtime TypeScript

---

## I. Root team YAML & samples (`configs/`)

1. `configs/default.yaml` — Default team recipe (agents + optional wallet blocks); sole tracked default after Apr-17 collapse of legacy presets
2. `configs/demo.yaml` — Compact demo team (`/deploy demo`) at repo root `configs/`; resolves the copywriter library entry
3. `configs/idchain.yaml` — idchain deployment preset for agents sync/library injection defaults; carries per-agent `heartbeat:` interval seconds (e.g. `heartbeat: 1800` on `systemreview` for the 30-min reconcile cadence introduced in v0.1.90-beta)
4. `configs/apps.yaml`, `configs/personal.yaml` — Local customization configs (gitignored; the `.example` starters were retired)
5. `configs/coder-demo.yaml`, `configs/composer.yaml`, `configs/cto.yaml`, `configs/cursor-smoke.yaml`, `configs/review.yaml` — Personal/dev-only team presets (composer, CTO seat, cursor smoke harness, review crew, coder demo)
6. `configs/demos/foundry-demo.yaml`, `configs/demos/foundry-codex-demo.yaml`, `configs/demos/foundry-cursor-demo.yaml`, `configs/demos/solidity-dev-team.yaml` — Archived demo team configs (editorial/solidity-security demos consolidated into root `demo.yaml` Apr-25)

---

## J. Documentation (`docs/` + repo root)

1. `docs/guides/sync-command.md` — `/sync` is REMOVED; the doc is now the migration record (what it did, what replaced it) plus the "NOT REMOVED" note distinguishing the `id-agents sync` workspace CLI
2. `docs/guides/tui.md` — Terminal dashboard usage
3. `docs/guides/tasks.md` — Manager task lifecycle for operators
4. `docs/guides/interactive-agent.md`, `docs/guides/news-feed.md`, `docs/guides/heartbeats.md`, `docs/guides/agent-outputs.md` — CLI/TUI feature guides
5. `docs/guides/idagents-admin-control.md` — Admin-control skill operator flows (the older `docs/guides/admin-control.md` was deleted Apr-23)
6. `docs/guides/public-team-bootstrap.md`, `docs/public-team-design.md`, `docs/public-team-review-2026-04-18.md` — Public-team architecture and review notes
7. `docs/reference/architecture.md`, `docs/reference/configuration.md`, `docs/reference/harnesses.md`, `docs/reference/database.md`, `docs/reference/id-indexer-api.md` — Reference material aligned with `SYSTEM_ITEMS` (DB schema reference; ID Networks Indexer API for Agent Registry / Smart Credentials)
8. `docs/deployment/hetzner.md`, `docs/deployment/hetzner-setup.md` — Hosting recipes
9. `docs/MODULAR_RUNTIME_PLAN.md`, `docs/research/*` — Planning / research notes
10. `docs/WAKEUP_SERVICE_PLAN.md` — Wakeup-service rollout plan (companion to v1 design); covers event_log / subscriptions / retention staged delivery
11. `docs/SCHEDULING_PLAN.md` — Scheduling subsystem plan (manager-owned scheduler + worker `/schedule` semantics)
12. `docs/SECURITY_AUDIT_NEW_FEATURES.md` — Rolling audit notes for newly landed features (checkin primitive, wakeup service, library/v3, public-team)
13. `docs/erc-draft-agent-identifiers.md` — Historical research draft for agent identifier resolution (companion to the removed ERC-7930/onchain registry integration; not a supported runtime capability)
14. `docs/protocol/*` — Protocol-level specs (REST-AP, message envelope details) referenced from harnesses and skills
15. `CONTRIBUTING.md` — Contributor workflow; references sync/library docs touched in recent releases
16. `README.md`, `QUICKSTART.md` — Repo entrypoints; version/changelog pointers track npm package (`package.json`); `QUICKSTART.md` Step 0 prompts before pulling an existing checkout (no silent `git pull --ff-only` since v0.1.86-beta)
17. `CHANGELOG.md` — Beta release notes (current headline **v0.1.92-beta** — `wrap="truncate-end"` on TUI agent rows + StatusStrip so narrow terminals clip the rightmost columns instead of wrapping the top menu off-screen; recent: **v0.1.91-beta** pin `public` team chip after `All`, **v0.1.90-beta** TeamsPanel sliding window for >5 teams, **v0.1.89-beta** table-only model abbreviation, **v0.1.88-beta** MODEL column abbreviation table + heuristic, **v0.1.87-beta** TUI MODEL column, **v0.1.86-beta** quickstart prompt-before-pull, **v0.1.84-beta** TUI help modal popup, **v0.1.80-beta** check-in/production hardening)
18. `REVIEW_LOG.md`, `SECURITY.md`, `NOTICE`, `LICENSE` — Repo-root governance and license notices (`REVIEW_LOG.md` / `SECURITY.md` remain gitignored via `.gitignore`)
19. `Logs.md` — Tracked operator runbook for filesystem agent/manager logs (`/tmp/*.log`), SQLite forensics (`event_log`, `tasks`, `queries`, `checkins`, …), and practical tail/query recipes (expanded v0.1.80-beta)
20. `HEARTBEAT.md` — Repo-root agent-driven heartbeat checklist with **per-agent sections**: heartbeats are routed by the agent's `identity` skill name (e.g. `systemreview` reconciles SYSTEM_ITEMS.md on a 30-min cadence; everything else falls through to the **Default** section that picks one item to audit, checks the working tree, runs tests). Restructured in v0.1.90-beta (commit `bc55d3b`) so multiple agents sharing a workdir can have distinct heartbeat behavior — replaces the older root `HEARTBEAT.yaml` retired in the Apr-26 cleanup

---

## K. Repo-root agent skills (`skills/`)

1. `skills/README.md` — Index: deployed skills (`identity`, `inter-agent`, `catalog`, `wallet`, `xmtp`) vs external (`idagents-admin-control`)
2. `skills/inter-agent/SKILL.md` — Inter-agent messaging + operator ladder for supervising delegated tasks/check-ins (recent refresh for auto-attach, terminal rules, wakeup priorities, and **`task-discipline`** cross-links in v0.1.80-beta docs pass)
3. `skills/idagents-admin-control/SKILL.md` + helpers (`admin-session.js` entrypoint, `start-listener.js` reply listener, `management-loop.sh`, `talk-to-manager.sh`, `remote-command.sh`) — Operator bridge for `/remote` workflows; v0.1.80-beta pass expanded environment tables (`MANAGER_URL`, dispatch/polling ergonomics, check-in operator guidance aligned with wakeup + news fan-out semantics)
4. `skills/task-discipline/SKILL.md` — Mirror of manager task lifecycle expectations for agents (also embedded in `protocol-defaults.ts` for always-on enforcement since v0.1.48-beta); now carries an explicit pointer back to **`inter-agent`** check-in supervision (v0.1.80-beta docs sync)
5. `skills/xmtp/SKILL.md` — XMTP operational guidance for agents (`curl` worker endpoints); complements §G
6. `skills/identity/SKILL.md` — Always-loaded agent identity (name, team) skill — referenced by `inter-agent` resolution, TUI display, and the per-agent `HEARTBEAT.md` routing introduced in v0.1.90-beta
7. `skills/wallet/SKILL.md` — OWS wallet operations (addresses, signing, balances, agent access) — paired with optional `wallet:` block in team YAML
8. `skills/catalog/SKILL.md` — REST-AP catalog updater so agents publish role/expertise/status to manager + peers

---

## L. Root scripts (`scripts/`)

1. `scripts/check-ens-resolution.mjs` — ENS xid.eth CCIP-Read smoke test (viem); pair with XMTP section G
2. `scripts/verify-tui-public.ts` — Verify TUI ↔ manager `/public` surfaces for regression runs
3. `scripts/detect-runtimes.sh` — Discover installed harness CLIs on PATH for diagnostics
4. `scripts/test-longpoll.sh` — Long-poll integration harness helper
5. `scripts/fix-xmtp-bindings.sh` — Repair XMTP native bindings when installs drift
6. `scripts/deploy-manager.sh`, `scripts/setup-hetzner.sh` — Deployment helpers for operators
7. `scripts/id-loader.service` — systemd unit for the loader/watcher (`Restart=always`, port 3100); referenced by Hetzner deployment guide
8. `scripts/dev-poetry.yaml`, `scripts/poet-series.yaml`, `scripts/poetry-research.yaml`, `scripts/example.yaml` — Sample team configs co-located with scripts (manual deploy/test recipes, not part of the canonical `configs/` set)

---

## M. Public-agent runtime (extracted to standalone Juno repo)

The public-facing agent runtime that previously lived under `public-agent/` was **extracted to a standalone repo (Juno)** in commit `58cc1f8` on 2026-04-19. There is no longer a `public-agent/` subtree in this repo — the build artifacts, REST routes, OpenRouter adapter, MCP shim, knowledge-base tooling, and Dockerfiles are all maintained in the Juno repo.

What remains in this repo:

1. `runtime: public-agent-remote` — Runtime profile in `src/runtime/registry.ts` that points the manager + CLI at remote Juno endpoints (deploy, register, heartbeat-probe, SSH delivery)
2. `src/lib/ssh-deliver.ts`, `src/lib/remote-heartbeat.ts` — Operator-side delivery + ad-hoc probing for remote Juno instances
3. `src/cli/public-commands.ts` + `/public` subcommands in interactive CLI — Operator UX for managing remote Juno agents (list, add via manager-join, remove, chat; optional OWS wallet provisioning at join)
4. `docs/public-team-design.md`, `docs/public-team-review-2026-04-18.md`, `docs/guides/public-team-bootstrap.md` — Architecture, review notes, and bootstrap runbook (stable references to the now-external runtime)

---

## N. Tests (`tests/`)

Layout: `tests/integration/` (39 files), `tests/unit/` (24 files), `tests/repos/` (6 files), `tests/helpers/` (shared `manager-client.ts` etc.), plus `tests/pty-flicker.py` standalone TUI smoke. The list below samples integration suites from recent churn — representative, not exhaustive.

1. `tests/integration/wakeup-service-events-read.test.ts`, `tests/integration/team-isolation.test.ts` — `GET /events` catch-up and subscription wiring
2. `tests/integration/checkins-api.test.ts`, `checkin-due-service.test.ts`, `checkin-e2e.test.ts`, `checkin-task-autoclose.test.ts`, `checkin-talkto-autoattach.test.ts`, `checkin-service-boot.test.ts`, `checkin-priority-wake.test.ts` — Checkin primitive + boot/priority edges
3. `tests/integration/query-failed-event.test.ts` — `query:failed` / wakeup producer alignment with manager lifecycle
4. `tests/integration/event-log-retention.test.ts` — Retention sweep semantics against live repos
5. `tests/integration/sync-command.test.ts` — `/sync` deterministic diff + CLI wiring
6. `tests/integration/wallet-opt-in*.test.ts`, `tests/integration/manager-inbox-resolution.test.ts`, `tests/integration/agents-changed.test.ts` — Wallet opt-in + inbox/readiness flows
7. `tests/integration/library-routes.test.ts` — Manager `/library/agents` & `/library/skills` HTTP contracts
8. `tests/integration/workspace-sync.test.ts` — Workspace / deploy sync paths (`cli/workspace-sync`)
9. `tests/integration/codex-spawn-personality-refresh.test.ts` — Codex harness spawn + metadata refresh
10. `tests/integration/news-reply-triggers-receiver.test.ts` — News fan-out / receiver triggers
11. **Further integration suites** — Auth/config/redaction (`api-key-auth`, `require-auth-config`, `secret-hygiene`, `response-redaction`, `ssh-target-log-redaction`); remote/mesh (`remote-runtime`, `remote-heartbeat`, `remote-commands`, `mesh-membership`, `external-client`, `admin-mesh-bypass-remote-blocked`); public (`cli-public-register`, `public-wallet-provisioning`); agents (`agent-lifecycle`, `agent-capabilities`, `agent-relay`, …); heartbeat (`heartbeat-separation`); A2A + wakeup edges (`talk-to-reply-qid`, `query-failed-event`, `checkin-priority-wake`, `checkin-service-boot`). The integration directory currently holds **48** files — treat this list as sampling, not exhaustive.
12. **Unit tests (`tests/unit/`, 35 files)** — Pure-function and small-surface checks: `agent-manager-process-guard`, `agent-manager-wallet`, `agent-readiness`, `artifact-traversal`, `bulk-delete`, `cursor-cli-parser`, `env-hygiene`, `event-log-retention`, `fatal-handlers`, `heartbeat`, `name-validation`, `news-trigger-default`, `protocol-defaults`, `runtime-paths`, `runtime-registry`, `sub-agent-template`, `sync-diff`, `team-config-parser`, `team-delete-safety`, `wallet-opt-in`
13. **Repo / schema tests (`tests/repos/`, 6 files)** — Direct repo + migration coverage: `migration.test.ts`, `checkins-schema.test.ts`, `find-interactive-determinism.test.ts`, `wakeup-service-schema.test.ts`, `wakeup-service-producers.test.ts`, `wakeup-service-checkin-events.test.ts`

---

## O. Binaries (`bin/`)

1. `bin/id-agents` — Symlink-style npm bin entry resolving to `dist/interactive-agent-cli.js` (per `package.json` `bin.id-agents`); the local `bin/id-agents` symlink target is the globally-installed copy under `lib/node_modules/id-agents/dist/interactive-agent-cli.js`
2. `id-agents-dashboard` — Second `package.json` bin entry → `dist/tui/index.js` (Ink TUI from `src/tui/index.tsx`); not present as a tracked file under `bin/`, only published via npm bin map

---

## P. Tools (`tools/`)

1. `tools/test-manager/index.js` — Standalone in-memory REST-AP manager (no DB) for testing agent communication outside the full CLI infra: external agent registration by URL, `/talk-to`, `/talk`, `/news`, discovery, ping; runs as `node tools/test-manager/index.js [--port=N]` (default 5000)
2. `tools/test-manager/README.md` — Operator/dev usage doc for the test manager (paired with `scripts/test-longpoll.sh` for long-poll smoke runs)

---

## Progress Log — 2026-04-28 exhaustive 14-day audit (`systemitems-exhaustive-audit`)

**Scope:** every commit from 2026-04-14 through 2026-04-28 inclusive (covers v0.1.43-beta → v0.1.79-beta and the public-agent → Juno extraction).

**Numbers:**
- **Commits walked:** 290 (one-line summary captured to `/tmp/sysaudit.log`, 1916 lines incl. file-status rows).
- **Unique paths touched:** 615 — 532 still present in the tree, 83 deleted.
- **Top buckets touched (extant):** `configs/` 337 (mostly v3 library bundle import), `src/` 83, `tests/` 66, `docs/` 21, `skills/` 10, `scripts/` 3, plus repo-root governance files.
- **Top buckets deleted:** `public-agent/` 62 (extracted to standalone Juno repo, commit `58cc1f8`), legacy `configs/` 16 (`apps.yaml.example`, `personal.yaml.example`, `claude-code.yaml`, `codex*.yaml`, `default-mixed.yaml`, `demo-codex.yaml`, `example-team.yaml`, `xmtp-test.yaml`, `claudeMd-{manager,pm}.md`, `demos/{editorial,solidity-security}*`), `src/tui/components/{Header,NewsPanel,TasksStatusStrip}.tsx` (refactored into newer `App.tsx` + per-view components), `docs/guides/admin-control.md` (replaced by `idagents-admin-control.md`), root `HEARTBEAT.yaml` (retired in favor of agent-driven `HEARTBEAT.md`).
- **Gaps closed in this pass:** 4 — (1) deleted `docs/guides/admin-control.md` reference removed from §J, (2) `docs/reference/database.md` + `docs/reference/id-indexer-api.md` added to §J, (3) `admin-session.js` + `start-listener.js` enumerated under §K idagents-admin-control entry, (4) §N expanded from integration-only to full `tests/` tree (added items 12 unit, 13 repos).
- **Descriptions tightened/clarified in this pass:** 0 net new beyond take-4 (already done in prior pass: items 5, 6, 11, 119, 120 in §A; bin/tools entries in §O/§P; `frontend` bundle in §H).
- **Verifications performed (no edit needed — already accurate):** §A 1:1 reconcile against `find src` (122/122); §C route table cross-checked against 60 route registrations in `agent-manager-db.ts`; magic numbers re-confirmed by reading source (checkin-service, retention, event-producer, agent-readiness); skill listings against `find skills`; doc listings against `find docs`; configs/agents bundles (`copywriter`, `devops`, `editor`, `foundry-dev`, `frontend`, `frontend-react`, `fullstack-nextjs`, `security`, `solidity-security` — 9 bundles); §M Juno extraction confirmed by 62 deleted `public-agent/` paths in this window.
- **Per-commit-cluster reasoning notes (semantic groupings, not 1:1 commit list):**
  1. **Wakeup-service v1 (commits `9413f05` → `80ac4c7`, ~6 commits):** event_log + subscriptions schema/repos, task/query lifecycle producers, GET /events catch-up, event_log retention sweep. All landing src files already in §A items 119, 120 + §F item 8 + §C items 34. Doc `docs/WAKEUP_SERVICE_PLAN.md` → §J item 10.
  2. **Checkin primitive (commits `8be7924` → `7f6ddef`, ~9 commits):** checkins table + repo, lifecycle event producers, REST API (create/list/close/snooze), due-service tick loop, /talk-to auto-attach, task-terminal auto-close, end-to-end test, inter-agent SKILL doc. Landing src files in §A items 4, 5, 6 + §C items 35-39 + §F item 10. Tests in §N items 2.
  3. **v3 agent-config library (commits `0d86099` → `a21cd0f`, ~15 commits):** library enumerators, config-parser direct library resolve, runtime-aware sync remap, codex/cursor sync mapping, undeploy + CLI exit-code, slice-7 library inventory endpoints, slice-8 TUI library browser views. Landing src files in §A items 14, 68, 71, 90 + §C items 2 + §H items 1, 2 + TUI components §A 102-105.
  4. **Public-agent → Juno extraction (commit `58cc1f8` and runup `08661e5` → `8829ad6`, ~30 commits):** entire `public-agent/` subtree moved to standalone repo. What remains is captured in §M; new doc `public-team-design.md` and `public-team-review-2026-04-18.md` already in §J item 6 / §M item 4.
  5. **Wallet opt-in (commits `2587e85` + `1fde264d`-related, ~3 commits):** team YAML wallet block + on-demand provisioning. Touches `src/config-parser.ts` (§A 14) + `src/agent-manager-db.ts` (§A 1) + interactive-agent-cli (§A 66). Tests in §N item 6.
  6. **Manager hardening (commits `9297d92` `72a4ac1` `6cd8369` `8947c4f`, ~5 commits):** killAgentProcess self-PID guard / narrow-rebuild guard, manager-inbox resolution + CLI re-register on team switch, DELETE /teams SQLite crash fix, deterministic skills diff in /sync. Captured in §A item 1 description + §C item 26 + §A item 11 (agent-readiness probe).
  7. **TUI dashboard build-out (commits `a9025f6` → `5db1434`, ~30 commits):** Ink/React shell, agents/news/tasks/calendar/heartbeats/library views, status strip, footer, flicker fixes. Landing src files in §A items 92-118.
  8. **Cursor CLI runtime (commits `1c3dd10` `7a6a737e` `a8eed57f`, ~5 commits):** new harness alongside Codex/Claude SDK. §A item 58 + §A item 60 + §A item 80 (runtime registry).
  9. **Inter-agent / news (commits `93f03a5` `8436a2b` `1abedb9` and surrounding):** /news-to endpoint, GET /query/:id polling, two-verb skill rewrite, daemon-only dispatch, news kind/reply_expected metadata, since_id cursor. Landing src files in §A items 1, 8, 20, 64, 65 + §C items 21, 24.
  10. **Task lifecycle (commits `8a105f4` `3d30d64` `9624b23`):** GET /query/:id, manager task subset, short UUID handle, task-discipline skill + always-on protocol injection. §A items 33 (route §C) + §K item 5 + §A item 79.
- **Files with no SYSTEM_ITEMS entry — judged as ephemera and intentionally NOT added:** `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (patterns listed here when they affect collaborators: Cursor workdirs, stray `/bin/`, demo `.mp4` now ignored per `.gitignore` v0.1.80-beta bump), `tests/helpers/manager-client.ts` (test-only helper), `tests/pty-flicker.py` (one-off PTY check), `src/tui/tsconfig.json` (build config), `configs/personal.yaml` / `configs/apps.yaml` (already noted as gitignored in §I item 4).

---

## Progress Log — 2026-04-29 `jrdev-systemitems-recent`

**Rolling 14-day window (measured at task time):** `git log --since="2026-04-15"` → **269** commits; **608** deduped paths vs prior exhaustive pass (different cut dates explain 269 vs ~290 headline in the Apr-28 block above).

**Incremental cluster after Apr-28 inventory:** `dd5bb23` *release: cut 0.1.80-beta check-in patch* touches `README.md`, `.gitignore`, `package.json`, `CHANGELOG.md`, adds tracked `Logs.md`, refreshes **`skills/inter-agent`**, **`skills/idagents-admin-control`**, **`skills/task-discipline`**, materially extends **`src/agent-manager-db.ts`**, **`checkin-*`**, **`claude-agent-server.ts`**, **`db-service.ts`**, **`queries-repo` (Pg/SQLite)**, **`start-agent-manager.ts`**, and adds **`tests/integration/`** `{`checkin-priority-wake,checkin-service-boot,query-failed-event,talk-to-reply-qid`}` (integration directory stays at **39** files — sampling expanded in §N item 11).

**Corrections applied:** **`Logs.md`** removed from ephemeral appendix list and promoted to §J item **19**; §J changelog pointer advanced to headline **v0.1.80-beta**; §A tightened for the manager/worker/repo/shutdown deltas above.

---

## Progress Log — 2026-05-01 `heartbeat-systemitems-2026-05-01` (systemreview)

**Window walked:** `git log --since="24 hours ago"` from heartbeat fire-time on 2026-05-01 → **12 commits**, all 2026-04-30 or 2026-05-01, covering v0.1.84-beta through v0.1.90-beta. Last logged audit was the 2026-04-29 `jrdev-systemitems-recent` block above; no overlap.

**Material changes (file → action):**

- `src/tui/components/HelpModal.tsx` *(new file, commit `d87271c` v0.1.84-beta)* → **added** as §A item **102**. Three-column popup (Views / Navigate / Global) with short keybind descriptions, dismissed by `?`, Esc, or arrow keys. Subsequent commits `2ee9668` (compact to 3 columns), `4625dcd` (full-height wrapper + footer pin), `401723e` (arrow-key dismiss) refine the same file — folded into the single description.
- `src/tui/util/models.ts` *(new file, commit `03079bc` v0.1.88-beta)* → **added** as §A item **119**. Hand-edited `MODEL_ABBREVIATIONS` table + `abbrevModel` lookup. Commit `7a17ecd` v0.1.89-beta dropped the heuristic-fallback path so unknown models now visibly overflow — captured in the description.
- `src/tui/components/AgentRow.tsx` *(existing, commits `47d0326` `03079bc` `7a17ecd`)* → §A item **96** description rewritten to mention the MODEL column (width 10) and `abbrevModel` import.
- `src/tui/components/Footer.tsx` *(existing, commit `d87271c`)* → §A item **99** description rewritten as the v0.1.84-beta one-liner (`↑↓ nav · ← back · ? help · q quit`); the prior verbose per-view hint strings now live in `HelpModal`.
- `src/tui/App.tsx` *(existing, commits `d87271c` `4625dcd` `401723e`)* → §A item **92** description extended to mention the `HelpModal` popup, key intercept (arrows/Esc close before falling through), and the full-height + footer-pin fix.
- `HEARTBEAT.md` *(existing, commit `bc55d3b` v0.1.90-beta — restructured)* → **added** as §J item **20**. Per-agent sections: `systemreview` reconciles SYSTEM_ITEMS.md every 30 min; everything else falls through to the `Default` section. Replaces the older root `HEARTBEAT.yaml` already noted as retired in the Apr-28 progress log.
- `configs/idchain.yaml` *(existing, commit `bc55d3b`)* → §I item **3** description extended to mention `heartbeat: 1800` per-agent interval seconds (the source of this heartbeat trigger).
- `skills/identity/SKILL.md` *(no source change in window — referenced as the routing key for HEARTBEAT.md)* → §K item **7** description extended to mention the per-agent heartbeat routing.
- `CHANGELOG.md` *(existing, recurring touches — multiple commits)* → §J item **17** headline advanced from v0.1.80-beta to **v0.1.90-beta** with intermediate releases summarized.
- `QUICKSTART.md` *(existing, commits `7bf8c7e` `8c4a21e` v0.1.86-beta)* → §J item **16** description extended to note the prompt-before-pull behavior in Step 0.

**Renumbering performed:** §A grew from 122 → **124** entries. After inserting `HelpModal.tsx` at item 102, items 100→101 stayed, items 102–118 shifted by +1; after inserting `models.ts` at item 119, items 119–122 (the wakeup/xmtp tail) shifted by +1 again, landing at 121–124. All cross-references inside `Updated:` lines / earlier Progress Log entries / `[STATUS:...]` annotations were left untouched — they still point at the original numbering of their own audit window, which is the correct historical reference.

**Files in window judged as ephemera (no SYSTEM_ITEMS entry needed):** `package.json` (version-bump churn — semver tracker, not a runtime item), `package-lock.json` (build artifact), `README.md` (already §J 16), `CHANGELOG.md` (already §J 17), `QUICKSTART.md` (already §J 16). The build commit `be6e04d` *include tui in root build* is a one-line `package.json` script tweak and does not introduce a new tracked surface.

**Verifications performed:** `find src -name '*.ts' -o -name '*.tsx' | wc -l` confirms 124 files matching §A's new count. `ls src/tui/util/` confirms `colors.ts format.ts memory.ts models.ts schedule.ts` (5 files, alphabetic). `ls src/tui/components/` confirms `HelpModal.tsx` sits between `HeartbeatsView.tsx` and `LibraryAgentDetail.tsx` alphabetically. `MODEL_ABBREVIATIONS` table read-verified to include the `claude-haiku-4-5-20251001` entry from `7a17ecd`. `HEARTBEAT.md` read-verified for the per-agent section structure (`## systemreview` + `## Default`).

**Reply token:** 12 commits walked, 2 entries added (§A 102, §A 119), 6 entries materially updated (§A 92, 96, 99; §I 3; §J 16, 17, 20; §K 7). Progress Log entry: this block.

---

## Progress Log — 2026-05-01 `heartbeat-systemitems-2026-05-01-b` (systemreview, follow-up)

**Window walked:** `git log --since="24 hours ago"` since the prior heartbeat block above. Cutoff was top-of-tree at `7a17ecd`; one new commit since then.

**Single commit:** `ddfc86d` *feat(tui): window TeamsPanel when team list overflows* — bumps to **v0.1.90-beta**. Touches `src/tui/components/TeamsPanel.tsx` (§A item 113), `CHANGELOG.md`, `README.md`, `package.json`. Adds a sliding 5-chip window when `teams.length > 5`, with `←N` / `N→` chips for hidden teams on either side; `All` chip pins to the start; Tab cycling unchanged.

**Edits:** §A item **113** description extended to describe the windowing + overflow indicators (was a one-liner). No new files, no renumbering. §J item 17 (CHANGELOG headline `v0.1.90-beta`) already accurate from prior block — no edit needed.

**Reply token:** 1 commit walked, 0 entries added, 1 entry updated (§A 113). Progress Log entry: this block.

---

## Progress Log — 2026-05-01 `heartbeat-systemitems-2026-05-01-c` (systemreview, follow-up 2)

**Window walked:** since prior heartbeat block (cutoff `ddfc86d`). One new commit.

**Single commit:** `71276b8` *feat(tui): pin public team chip after All* — bumps to **v0.1.91-beta**. Touches `src/tui/App.tsx` (§A item 92), `CHANGELOG.md`, `README.md`, `package.json`. Sorts the teams array so `public` always renders immediately after the `All` chip regardless of manager response order; the sort happens at App level so `teamCounts`, `teamOptions`, and `TeamsPanel` all see the same order — Tab/Shift+Tab cycling matches the visual order.

**Edits:** §A item **92** (`App.tsx`) description extended to describe the public-chip pin behavior. §J item **17** CHANGELOG headline advanced v0.1.90-beta → v0.1.91-beta. No new files, no renumbering.

**Reply token:** 1 commit walked, 0 entries added, 2 entries updated (§A 92, §J 17). Progress Log entry: this block.

---

## Progress Log — 2026-05-01 `heartbeat-systemitems-2026-05-01-d` (systemreview, follow-up 3)

**Window walked:** since prior heartbeat block (cutoff `71276b8`). One new commit.

**Single commit:** `fc8f18e` *fix(tui): keep TeamsPanel visible on All and public selections* — bumps to **v0.1.92-beta**. Touches `src/tui/components/AgentRow.tsx` (§A 96), `src/tui/components/StatusStrip.tsx` (§A 109), `CHANGELOG.md`, `README.md`, `package.json`. Adds `wrap="truncate-end"` to `AgentRow` (local + remote `public-agent-remote` branch with the extra DOMAIN/DMZ columns), `AgentRowHeader`, and the outer `StatusStrip` `Text` so on terminals narrower than the full row width, the rightmost columns clip rather than wrapping to a second line — which previously scrolled the top menu off screen.

**Edits:** §A item **96** (`AgentRow.tsx`) description extended to describe the truncate-end clipping. §A item **109** (`StatusStrip.tsx`) one-liner extended likewise. §J item **17** CHANGELOG headline advanced v0.1.91-beta → v0.1.92-beta. No new files, no renumbering.

**Reply token:** 1 commit walked, 0 entries added, 3 entries updated (§A 96, §A 109, §J 17). Progress Log entry: this block.
