// SPDX-License-Identifier: MIT
/**
 * Metadata / column taxonomy tests — SPEC §3 and §3.2.
 *
 * Every key and column the spec classifies is asserted here explicitly, as a
 * literal table rather than a loop over the module's own data. Testing the
 * classifier against its own table would pass no matter what the table said;
 * these expectations are transcribed from the spec by hand so that editing the
 * module cannot quietly edit the test's idea of what is correct.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyAgentColumn,
  classifyMetadataKey,
  listClassifiedColumns,
  listClassifiedMetadataKeys,
  NEVER_EXPORT_COLUMNS,
  type ColumnClass,
  type MetadataClass,
} from '../../src/lib/metadata-taxonomy.js';

// ---------------------------------------------------------------------------
// §3 — metadata keys. Transcribed from the spec table.
// ---------------------------------------------------------------------------

const SPEC_METADATA: ReadonlyArray<[string, MetadataClass]> = [
  ['name', 'config'],
  ['description', 'config'],
  ['runtime', 'config'],
  ['skills', 'config'],
  ['plugins', 'config'],
  ['catalog', 'config'],
  ['dangerouslySkipPermissions', 'config'],
  ['agent', 'config'],
  ['heartbeat', 'config'],
  ['bio', 'config'],
  ['handles', 'config'],
  ['wallet', 'config'],
  ['effort', 'config'],
  ['allowed_tools', 'config'],
  ['openMode', 'config'],
  ['isAutomator', 'config'],
  ['ows_wallet', 'runtime'],
  ['ows_address', 'runtime'],
  ['pid', 'runtime'],
  ['service_type', 'derived'],
  ['endpoint', 'derived'],
  ['local', 'derived'],
  ['agent_account', 'identifier'],
];

// ---------------------------------------------------------------------------
// §3.2 — all 25 agents columns. Transcribed from the spec table.
// ---------------------------------------------------------------------------

const SPEC_COLUMNS: ReadonlyArray<[string, ColumnClass]> = [
  ['name', 'config'],
  ['type', 'config'],
  ['model', 'config'],
  ['runtime', 'config'],
  ['working_directory', 'config'],
  ['customer_domain', 'config'],
  ['public_endpoint_url', 'config'],
  ['token_id', 'identifier'],
  ['domain', 'identifier'],
  ['api_key', 'never'],
  ['ssh_target', 'never'],
  ['internal_endpoint_url', 'never'],
  ['id', 'runtime'],
  ['port', 'runtime'],
  ['status', 'runtime'],
  ['created_at', 'runtime'],
  ['deleted_at', 'runtime'],
  ['registry', 'runtime'],
  ['last_seen', 'runtime'],
  ['last_probed_at', 'runtime'],
  ['last_error', 'runtime'],
  ['consecutive_failures', 'runtime'],
  ['team_id', 'derived'],
  ['endpoint', 'derived'],
  ['metadata', 'per-key'],
];

describe('classifyMetadataKey — §3', () => {
  it.each(SPEC_METADATA)('classifies "%s" as %s', (key, expected) => {
    expect(classifyMetadataKey(key)).toBe(expected);
  });

  it('classifies every key in §3 and no others', () => {
    expect(listClassifiedMetadataKeys().sort()).toEqual(SPEC_METADATA.map(([k]) => k).sort());
  });

  it('returns unknown for an unlisted key (allow-list, not deny-list)', () => {
    expect(classifyMetadataKey('totally_made_up_key')).toBe('unknown');
    expect(classifyMetadataKey('')).toBe('unknown');
  });

  // Object.freeze does not detach Object.prototype, so a naive `key in table`
  // lookup would report 'constructor' and 'toString' as classified.
  it('returns unknown for inherited Object.prototype names', () => {
    expect(classifyMetadataKey('constructor')).toBe('unknown');
    expect(classifyMetadataKey('toString')).toBe('unknown');
    expect(classifyMetadataKey('__proto__')).toBe('unknown');
  });

  it('classifies role as unknown — it has no dedicated writer (§3.1 rule 2)', () => {
    // Live on `cto` in team `default`. It arrives via POST /agents/register
    // spreading caller-supplied metadata verbatim (agent-manager-db.ts:3248);
    // `role` is an AgentCatalog field and belongs at metadata.catalog.role.
    expect(classifyMetadataKey('role')).toBe('unknown');
  });

  /**
   * These six are written by the public-agent-remote branch of
   * POST /agents/register (agent-manager-db.ts:3135-3143) but carried by zero
   * live rows, so §3 — derived from a database snapshot — never saw them.
   *
   * This test pins the CURRENT behaviour, which is that they are unclassified.
   * It is a tripwire, not an endorsement: classifying any of them makes this
   * test fail, which is the point. The decision is owed before export ships.
   *
   * `mesh_member` is the urgent one. It gates inter-agent delivery at
   * agent-manager-db.ts:1288 as `metadata?.mesh_member !== false`, so ABSENT
   * means mesh-member. Dropping it from an export fails OPEN: a DMZ agent
   * exported and re-imported comes back mesh-reachable.
   */
  const AWAITING_CLASSIFICATION = [
    'mesh_member',
    'mesh_reachable',
    'public_endpoint',
    'dmz',
    'allowed_inbound',
    'allowed_outbound',
  ];

  it.each(AWAITING_CLASSIFICATION)(
    'pins "%s" as unknown — written by code, absent from §3, decision pending',
    (key) => {
      expect(classifyMetadataKey(key)).toBe('unknown');
    },
  );

  /**
   * Three more keys with dedicated writers that the 46-agent snapshot missed
   * because each has zero live rows. Same tripwire contract as above: pinned
   * unknown, and classifying any of them is meant to fail this test.
   */
  it('pins "alias" as unknown — the stashed display name (agent-manager-db.ts:6908)', () => {
    // The rename path moves the OLD name here, and 21 sites across six files
    // resolve display name as `metadata.alias || agent.name`. Dropping it on
    // export makes a renamed agent silently display its new row name instead —
    // see the fuller note in the module, which also covers sync.ts:206.
    expect(classifyMetadataKey('alias')).toBe('unknown');
  });

  it('pins "talkTimeout" as unknown — a config field with no writer into metadata', () => {
    // Declared at config-parser.ts:97 and read back at agent-manager-db.ts:588
    // as ID_TALK_TIMEOUT, but no deploy path ever puts it in metadata. The
    // config→metadata leg is broken independently of export.
    expect(classifyMetadataKey('talkTimeout')).toBe('unknown');
  });

  it('pins "wallet_address" as unknown — D7 runtime or D10 identifier, undecided', () => {
    // Written by PUT /agents/:id (agent-manager-db.ts:3497). Distinct from the
    // `wallet` opt-in boolean, which IS classified config.
    expect(classifyMetadataKey('wallet_address')).toBe('unknown');
    expect(classifyMetadataKey('wallet')).toBe('config');
  });
});

describe('classifyAgentColumn — §3.2', () => {
  it.each(SPEC_COLUMNS)('classifies "%s" as %s', (column, expected) => {
    expect(classifyAgentColumn(column)).toBe(expected);
  });

  it('classifies all 25 columns and no others', () => {
    expect(SPEC_COLUMNS).toHaveLength(25);
    expect(listClassifiedColumns().sort()).toEqual(SPEC_COLUMNS.map(([c]) => c).sort());
  });

  it('returns unknown for a column added to the table later', () => {
    // A new schema column defaults to not-exported until classified on purpose.
    expect(classifyAgentColumn('some_column_added_in_2027')).toBe('unknown');
  });

  it('returns unknown for inherited Object.prototype names', () => {
    expect(classifyAgentColumn('constructor')).toBe('unknown');
    expect(classifyAgentColumn('hasOwnProperty')).toBe('unknown');
  });
});

describe('credential and sensitive columns are excluded permanently', () => {
  it('classifies exactly api_key, ssh_target and internal_endpoint_url as never', () => {
    expect([...NEVER_EXPORT_COLUMNS].sort()).toEqual(
      ['api_key', 'internal_endpoint_url', 'ssh_target'],
    );
    const never = SPEC_COLUMNS.filter(([, k]) => k === 'never').map(([c]) => c);
    expect(never.sort()).toEqual(['api_key', 'internal_endpoint_url', 'ssh_target']);
  });

  it.each(NEVER_EXPORT_COLUMNS)('"%s" is never, and is not merely unknown', (column) => {
    // The distinction matters: `unknown` says "nobody classified this yet",
    // `never` says "this was considered and excluded permanently".
    expect(classifyAgentColumn(column)).toBe('never');
    expect(classifyAgentColumn(column)).not.toBe('unknown');
  });

  it('keeps the two declarations in agreement at module load', () => {
    // The module cross-checks COLUMN_TAXONOMY against NEVER_EXPORT_COLUMNS in
    // both directions and throws on import if they disagree, so reclassifying
    // one of these cannot be a one-line edit. Reaching this line at all means
    // the invariant held.
    for (const column of NEVER_EXPORT_COLUMNS) {
      expect(classifyAgentColumn(column)).toBe('never');
    }
    const declaredNever = listClassifiedColumns().filter((c) => classifyAgentColumn(c) === 'never');
    expect(declaredNever.sort()).toEqual([...NEVER_EXPORT_COLUMNS].sort());
  });

  it('does not classify the sensitive columns as metadata keys', () => {
    // None of the three is in AgentMetadata — a metadata-only taxonomy would
    // have caught none of them (§3.2). They must not appear in §3 either.
    for (const column of NEVER_EXPORT_COLUMNS) {
      expect(classifyMetadataKey(column)).toBe('unknown');
    }
  });
});
