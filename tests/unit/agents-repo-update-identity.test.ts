// SPDX-License-Identifier: MIT
/**
 * updateIdentity() backend-parity tests.
 *
 * updateIdentity is a PARTIAL update: an omitted field must leave its column
 * alone. Every caller depends on that — /update passes only {name}, /meta set
 * endpoint passes only {endpoint, metadata}, and /meta setid deliberately
 * passes `token_id: tokenIdArg || undefined` to skip the column.
 *
 * The Postgres repo used to write all five columns unconditionally with
 * `?? null`, so a rename nulled token_id/domain/endpoint/metadata and a
 * /meta set endpoint nulled the agent's NAME. sqlite built a partial UPDATE
 * and was correct. The two backends silently disagreed.
 *
 * These tests assert the column SET each backend emits for the same input, so
 * a regression in either one is a failure rather than a divergence nobody
 * notices until production data is gone.
 */

import { describe, expect, it } from 'vitest';

import { PgAgentsRepo } from '../../src/db/repos/postgres/agents-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';

/** Records every query the repo issues, and returns an empty result set. */
function recordingAdapter() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const adapter = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  return { adapter, calls };
}

/** The columns a given UPDATE statement actually assigns. */
function assignedColumns(sql: string): string[] {
  const set = sql.slice(sql.indexOf('SET ') + 4, sql.indexOf(' WHERE'));
  return set
    .split(',')
    .map(part => part.trim().split(/\s*=/)[0].trim())
    .sort();
}

type Fields = Parameters<PgAgentsRepo['updateIdentity']>[1];

async function pgUpdate(fields: Fields) {
  const { adapter, calls } = recordingAdapter();
  await new PgAgentsRepo(adapter as any).updateIdentity('agent-1', fields);
  return calls;
}

async function sqliteUpdate(fields: Fields) {
  const { adapter, calls } = recordingAdapter();
  await new SqliteAgentsRepo(adapter as any).updateIdentity('agent-1', fields);
  return calls;
}

// The real call sites, transcribed from agent-manager-db.ts.
const CALL_SITES: Array<{ site: string; fields: Fields; touches: string[] }> = [
  {
    site: '/update --name and PATCH /agents/:id/metadata rename (:3508, :6912)',
    fields: { name: 'renamed' },
    touches: ['name'],
  },
  {
    site: '/meta set <agent> endpoint <url> (:6715)',
    fields: { endpoint: 'http://host:1234', metadata: { alias: 'keep-me' } },
    touches: ['endpoint', 'metadata'],
  },
  {
    site: '/meta setid <agent> <domain> (no tokenId) (:6736)',
    fields: { domain: 'agent.eth', token_id: undefined },
    touches: ['domain'],
  },
  {
    site: '/meta setid <agent> <domain> <tokenId> (:6736)',
    fields: { domain: 'agent.eth', token_id: '42' },
    touches: ['domain', 'token_id'],
  },
];

describe('updateIdentity is a partial update on both backends', () => {
  for (const { site, fields, touches } of CALL_SITES) {
    it(`${site} touches only ${touches.join(' + ')}`, async () => {
      const pg = await pgUpdate(fields);
      const sqlite = await sqliteUpdate(fields);

      expect(pg).toHaveLength(1);
      expect(sqlite).toHaveLength(1);
      expect(assignedColumns(pg[0].sql)).toEqual([...touches].sort());
      expect(assignedColumns(sqlite[0].sql)).toEqual([...touches].sort());
    });
  }

  it('never nulls the name column when name was not supplied', async () => {
    // The most destructive form of the old bug: /meta set endpoint wiped the
    // agent's name, which is the routing key for every by-name lookup.
    const [call] = await pgUpdate({ endpoint: 'http://host:1234' });
    expect(call.sql).not.toContain('name');
    expect(call.params).not.toContain(null);
  });

  it('writes an explicitly-supplied field even when it is empty string', async () => {
    // `undefined` means "skip"; '' is a real value and must still be written.
    const [call] = await pgUpdate({ domain: '' });
    expect(assignedColumns(call.sql)).toEqual(['domain']);
    expect(call.params[0]).toBe('');
  });

  it('issues no query at all when every field is omitted', async () => {
    expect(await pgUpdate({})).toHaveLength(0);
    expect(await sqliteUpdate({})).toHaveLength(0);
  });
});

describe('Postgres placeholder numbering stays aligned with params', () => {
  it('numbers $n in assignment order and puts the id last', async () => {
    const [call] = await pgUpdate({
      name: 'n',
      token_id: 't',
      domain: 'd',
      endpoint: 'e',
      metadata: { k: 'v' },
    });

    expect(call.sql).toBe(
      'UPDATE agents SET name = $1, token_id = $2, domain = $3, endpoint = $4, ' +
        'metadata = $5 WHERE id = $6',
    );
    expect(call.params).toEqual(['n', 't', 'd', 'e', { k: 'v' }, 'agent-1']);
  });

  it('renumbers correctly when leading fields are skipped', async () => {
    // Regression guard for the obvious bad fix: hardcoding $2..$6 by column
    // position leaves gaps once a field is omitted.
    const [call] = await pgUpdate({ endpoint: 'e', metadata: { k: 'v' } });

    expect(call.sql).toBe('UPDATE agents SET endpoint = $1, metadata = $2 WHERE id = $3');
    expect(call.params).toEqual(['e', { k: 'v' }, 'agent-1']);
  });

  it('binds every placeholder the SQL references', async () => {
    for (const { fields } of CALL_SITES) {
      const [call] = await pgUpdate(fields);
      const highest = Math.max(
        ...[...call.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])),
      );
      expect(highest).toBe(call.params.length);
    }
  });
});
