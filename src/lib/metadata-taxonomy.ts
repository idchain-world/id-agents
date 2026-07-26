// SPDX-License-Identifier: MIT
/**
 * Metadata and column taxonomy — SPEC §3 and §3.2.
 *
 * The database is the source of truth; config files are import/export
 * artifacts (D3). Deciding what may be written back out is therefore a
 * classification problem, and this module is the single place that answers it.
 *
 * Two rules govern everything here:
 *
 *   1. ALLOW-LIST, NEVER DENY-LIST. An unlisted name classifies `unknown` and
 *      callers must not export it. A key added to the system later is not
 *      exported by accident — someone has to classify it here on purpose.
 *      Silent omission is a data-loss bug, so callers are expected to report
 *      every `unknown` they skip (§3.1 rule 1), not swallow it.
 *
 *   2. PLAIN DATA, NOT CONDITIONALS. Both taxonomies are inspectable tables.
 *      The exporter (commit 2) reads them; it does not re-derive them.
 *
 * `AgentMetadata` is `[key: string]: any` (`src/core/types.ts:64`), so this
 * list cannot be derived from the type and is maintained deliberately.
 *
 * NOTE: this module classifies. It does not decide export coverage on its own
 * — agent state also lives in table columns (§3.2, below) and on the
 * filesystem (§3.3, avatars). All three lists must be checked.
 */

/** Classification for a key inside the `agents.metadata` JSON blob (§3). */
export type MetadataClass =
  | 'config'      // came from the config file; export it
  | 'runtime'     // process/session state; never export
  | 'derived'     // recomputable from other state; never export, rebuild on import
  | 'identifier'  // names a thing but grants nothing; export (D9, D10)
  | 'unknown';    // not classified — do not export, report it

/**
 * Classification for an `agents` table column (§3.2).
 *
 * `never` is the reason this type is separate from MetadataClass: three
 * columns are credential-or-sensitive and are excluded permanently, not as a
 * matter of current policy. `per-key` marks the one column whose contents are
 * delegated to the metadata taxonomy above.
 */
export type ColumnClass = MetadataClass | 'never' | 'per-key';

/**
 * §3. Every key observed in the live database, plus the config-derived keys
 * with zero live rows. Row counts in comments are from the 46-agent snapshot
 * re-derived on 2026-07-26 and are documentation, not behaviour.
 */
const METADATA_TAXONOMY: Readonly<Record<string, MetadataClass>> = Object.freeze({
  // --- config-derived: written from the config file, exported ---
  name: 'config',                        // 45
  description: 'config',                 // 44
  runtime: 'config',                     // 44
  skills: 'config',                      // 44
  plugins: 'config',                     // 44 — export DECLARED paths, not the
                                         //      resolved localPlugins (§3.1 rule 3)
  catalog: 'config',                     // 42
  dangerouslySkipPermissions: 'config',  // 41
  agent: 'config',                       // 18
  heartbeat: 'config',                   // 16 — boolean only; the interval lives
                                         //      in the schedules table (§3.1 rule 4)
  bio: 'config',                         // 4
  handles: 'config',                     // 3
  wallet: 'config',                      // 2 — the opt-in boolean, not a wallet
  effort: 'config',                      // 1
  allowed_tools: 'config',               // 0
  openMode: 'config',                    // 0
  isAutomator: 'config',                 // 0

  // --- runtime: process/session state, never exported ---
  pid: 'runtime',                        // 44
  ows_wallet: 'runtime',                 // 1 — D7: wallets are never exported
  ows_address: 'runtime',                // 1 — D7

  // --- derived: recomputed on import, never exported ---
  service_type: 'derived',               // 45 — constant 'REST-AP'
  endpoint: 'derived',                   // 45 — http://localhost:<port>
  local: 'derived',                      // 44 — set post-spawn

  // --- identifier: names something, grants nothing ---
  agent_account: 'identifier',           // 1 — an Ethereum address (D10)

  // --- config-derived: the DMZ posture stamped at manager-join ---
  // Written by the public-agent-remote branch of POST /agents/register
  // (agent-manager-db.ts:3135-3143). Zero live rows carry them — the one live
  // remote agent predates that code — which is why §3, derived from a database
  // snapshot, could not list them. Found by reading the writer instead.
  //
  // CTO DECISION 2026-07-26: all six are `config`. They have a deterministic
  // writer, they are caller-supplied configuration, and they must survive
  // export.
  //
  // `mesh_member` is why this mattered. It gates inter-agent delivery at
  // agent-manager-db.ts:1288 as `metadata?.mesh_member !== false`, so ABSENT
  // MEANS MESH-MEMBER. Left unclassified, export would drop it and a DMZ agent
  // would come back from a round-trip mesh-reachable, with a 403 gate silently
  // removed — a fail-open privilege grant.
  //
  // Classifying them does NOT close that fail-open, and must not be mistaken
  // for a fix. Legacy rows never carried the key, so absent-means-member stays
  // live for every pre-existing DMZ row even with a perfect export. The
  // gate-side fix (`=== true`, or an explicit default injected at import) is
  // tracked separately and is deliberately not part of this module.
  mesh_member: 'config',                 // 0
  mesh_reachable: 'config',              // 0
  public_endpoint: 'config',             // 0
  dmz: 'config',                         // 0
  allowed_inbound: 'config',             // 0
  allowed_outbound: 'config',            // 0

  // DELIBERATELY ABSENT, classify as `unknown`:
  //   alias  (0 rows — but the highest-consequence omission here)
  //     Written by the `/identity --name` rename path
  //     (agent-manager-db.ts:6908) as `alias = alias || <previous name>`, so it
  //     preserves an agent's ORIGINAL name across a rename.
  //     Blast radius: 43 reads across 12 files. Counted BY FORM 2026-07-26 —
  //     supersedes "21 across 6-7", "55 across 10" and "35 across 9". Every
  //     one of those came from a bare `\.alias` regex over `*.ts`, which is
  //     wrong in both directions at once: it sweeps in `parsed.alias` (the
  //     output of parseAgentRef — a lookup INPUT, not this key) while missing
  //     the SQL-form reads, which have no dot, and the .tsx TUI reads.
  //       28 reads of the stored key, across 6 files:
  //         JS form `(metadata as any)?.alias` / `meta.alias` — 15 across 4:
  //           agent-manager-db.ts 11 (:569, :893, :2621, :4073, :4267, :4370,
  //           :4419, :4560, :4806, :5701, :7952), sync.ts 2 (:206, :234),
  //           checkins/checkin-service.ts 1 (:373),
  //           scheduling/scheduler-service.ts 1 (:100).
  //         SQL form, invisible to any `.alias` regex — 13 across 2:
  //           db/repos/postgres/agents-repo.ts 7 `metadata->>'alias'` (:26,
  //           :61, :73, :81, :105, :141, :150) and
  //           db/repos/sqlite/agents-repo.ts 6
  //           `json_extract(metadata,'$.alias')` (:45, :87, :102, :131, :166,
  //           :183). Both repos are DIRECT readers; their JS-form `.alias`
  //           hits are 100% `parsed.alias` homonyms.
  //       15 reads of the flattened `.alias` field that agent-manager-db.ts:893
  //         serializes into every API agent object, across 6 files:
  //         interactive-agent-cli.ts 6, claude-agent-server.ts 3,
  //         start-agent-manager.ts 2, tui/components/AgentDetail.tsx 2 (:49,
  //         :88), tui/components/AgentRow.tsx 1 (:76), and
  //         core/agent-identifier.ts 1 (:157 `m.alias` on AgentMatch only —
  //         :75/:89 are `id.alias` on AgentIdentifier, which is
  //         normalizeAlias(name), a homonym) — so an export bug here reaches
  //         the CLI and the TUI too.
  //     Other homonyms excluded: normalizeAlias / resolveModelAlias /
  //     agentAlias / walletAlias / isValidAlias.
  //     §3 could not have seen it: no live row has been renamed, which is also
  //     why token_id and domain are 0 (§3.2). It is not config-derived either,
  //     so re-deriving §3 from config-parser.ts would not surface it.
  //     Dropping it on export is NOT cosmetic: a renamed agent round-trips
  //     under its new name, all 43 readers switch display names at once, and
  //     sync.ts — which builds runningByAlias at :206 and falls back to it at
  //     :216 — stops matching the config entry and can treat the agent as new.
  //     Classifying it needs an export-rule decision, not just a class: if
  //     `alias` is the name the config should carry, then the exported agent
  //     name is `alias`, not the `name` column. That is a §3.1 call. PENDING.
  //
  //   role  (1 row, on `cto` in team `default`)
  //     §3.1 rule 2. It has no dedicated writer: it arrives through
  //     POST /agents/register, which spreads caller-supplied `metadata`
  //     verbatim (agent-manager-db.ts:3248). `role` is a field of
  //     AgentCatalog and belongs at metadata.catalog.role, so the
  //     top-level copy is a stray.
  //
  //   talkTimeout  (0 rows)
  //     A declared config-file field (config-parser.ts:97, merged from
  //     `defaults` at :1286) read back as `metadata.talkTimeout` to set
  //     ID_TALK_TIMEOUT (agent-manager-db.ts:588). No deploy path writes it
  //     into metadata today, so the config→metadata leg is missing
  //     independently of export; classify it when that is fixed.
  //
  //   wallet_address  (0 rows)
  //     Written by PATCH /agents/:id/metadata with a `wallet` body
  //     (agent-manager-db.ts:3497). Corrected 2026-07-26: earlier notes said
  //     "PUT /agents/:id", which is not a route that exists — verified by
  //     reading the enclosing handler. Ambiguous on purpose: D7 says wallets are
  //     never exported (cf. ows_wallet/ows_address, `runtime`), D10 says a bare
  //     address only names a thing (cf. agent_account, `identifier`). Note
  //     `metadata.wallet` above is the opt-in BOOLEAN, a different key.
});

/**
 * §3.2. All 25 `agents` columns. Export builds its column list from this
 * allow-list — never `SELECT *`, never "all columns except".
 */
const COLUMN_TAXONOMY: Readonly<Record<string, ColumnClass>> = Object.freeze({
  // --- config-derived ---
  name: 'config',                   // 46
  type: 'config',                   // 46
  model: 'config',                  // 46
  runtime: 'config',                // 46
  working_directory: 'config',      // 45 — expressible as `workingDirectory`
  customer_domain: 'config',        // 1  — remote-endpoint runtime
  public_endpoint_url: 'config',    // 1  — remote-endpoint runtime

  // --- identifier: ENS handles. 0 live rows, so only fixtures can test these ---
  token_id: 'identifier',           // 0 — D9
  domain: 'identifier',             // 0 — D9

  // --- NEVER: credential or sensitive. Not policy — permanent. ---
  api_key: 'never',                 // 0 — grants access
  ssh_target: 'never',              // 0 — redacted for non-admin callers
  internal_endpoint_url: 'never',   // 1 — redacted for non-admin; LIVE on one agent

  // --- runtime ---
  id: 'runtime',                    // 46 — a new id is minted on import
  port: 'runtime',                  // 46 — reallocated
  status: 'runtime',                // 46
  created_at: 'runtime',            // 46
  deleted_at: 'runtime',            // 0
  registry: 'runtime',              // 0
  last_seen: 'runtime',             // 1
  last_probed_at: 'runtime',        // 1
  last_error: 'runtime',            // 1
  consecutive_failures: 'runtime',  // 46 — NOT NULL DEFAULT 0

  // --- derived ---
  team_id: 'derived',               // 46 — from the target team
  endpoint: 'derived',              // 45 — from the port

  // --- delegated ---
  metadata: 'per-key',              // 46 — classify each key with
                                    //      classifyMetadataKey instead
});

/**
 * The three columns that must never leave the database, as an independent
 * source of truth.
 *
 * This is not a duplicate of the table above — it is a cross-check. The
 * invariant below runs at module load, so changing `api_key` to 'config' in
 * COLUMN_TAXONOMY does not quietly become exportable: importing this module
 * throws. Reclassifying one of these has to be a two-file, on-purpose edit.
 */
export const NEVER_EXPORT_COLUMNS: readonly string[] = Object.freeze([
  'api_key',
  'ssh_target',
  'internal_endpoint_url',
]);

// Load-time invariant: the two declarations above must agree, in both
// directions. A column may be `never` if and only if it is in the list.
for (const column of NEVER_EXPORT_COLUMNS) {
  if (COLUMN_TAXONOMY[column] !== 'never') {
    throw new Error(
      `metadata-taxonomy: "${column}" is in NEVER_EXPORT_COLUMNS but classified ` +
      `"${COLUMN_TAXONOMY[column] ?? 'unlisted'}" in COLUMN_TAXONOMY. ` +
      `These columns are credential-or-sensitive and are excluded permanently (§3.2).`,
    );
  }
}
for (const [column, klass] of Object.entries(COLUMN_TAXONOMY)) {
  if (klass === 'never' && !NEVER_EXPORT_COLUMNS.includes(column)) {
    throw new Error(
      `metadata-taxonomy: "${column}" is classified "never" but is missing from ` +
      `NEVER_EXPORT_COLUMNS. Add it there too, on purpose.`,
    );
  }
}

/**
 * Classify a key from the `agents.metadata` JSON blob (§3).
 *
 * Returns `unknown` for anything unlisted. Callers must not export an
 * `unknown` key, and must report it rather than dropping it silently.
 */
export function classifyMetadataKey(key: string): MetadataClass {
  return Object.prototype.hasOwnProperty.call(METADATA_TAXONOMY, key)
    ? METADATA_TAXONOMY[key]
    : 'unknown';
}

/**
 * Classify an `agents` table column (§3.2).
 *
 * Returns `unknown` for anything unlisted, so a column added to the schema
 * later is not exported until it is classified here.
 */
export function classifyAgentColumn(column: string): ColumnClass {
  return Object.prototype.hasOwnProperty.call(COLUMN_TAXONOMY, column)
    ? COLUMN_TAXONOMY[column]
    : 'unknown';
}

/** Every metadata key this module classifies. Inspection helper for commit 2. */
export function listClassifiedMetadataKeys(): string[] {
  return Object.keys(METADATA_TAXONOMY);
}

/** Every column this module classifies. Inspection helper for commit 2. */
export function listClassifiedColumns(): string[] {
  return Object.keys(COLUMN_TAXONOMY);
}
