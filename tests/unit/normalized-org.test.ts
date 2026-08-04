// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgConfig } from '../../src/config-parser.js';
import { validateConfig } from '../../src/config-parser.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { generateAgentOrgContext, generateOrgChart } from '../../src/org-chart.js';
import { normalizeOrgKey } from '../../src/org/normalization.js';
import { NormalizedOrgStore, OrgValidationError } from '../../src/org/normalized-org.js';

const nestedOrg: OrgConfig = {
  groups: {
    Engineering: {
      description: 'Build the platform',
      lead: 'alice',
      members: ['bob'],
      groups: {
        Platform: {
          description: 'Runtime and storage',
          members: ['carol'],
        },
      },
    },
    Research: {
      description: 'Explore new systems',
      members: ['alice'],
    },
  },
  tags: {
    Security: ['alice', 'bob'],
    Data: ['carol'],
  },
};

describe('normalized organization store', () => {
  let db: SqliteAdapter;
  let store: NormalizedOrgStore;
  let teamId: string;
  const agentIds = new Map<string, string>();

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await migrateSqlite(db);
    store = new NormalizedOrgStore(db);
    teamId = randomUUID();
    await db.query(`INSERT INTO teams (id, name, config) VALUES (?, 'normalized-team', ?)`, [
      teamId,
      JSON.stringify({ org: { groups: { Deprecated: { members: ['alice'] } } } }),
    ]);
    for (const [index, name] of ['alice', 'bob', 'carol'].entries()) {
      const id = `agent-${name}`;
      agentIds.set(name, id);
      await db.query(
        `INSERT INTO agents
           (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
         VALUES (?, ?, ?, 'claude', 'model', 0, 'running', ?, ?, 'codex')`,
        [id, teamId, name, index + 1, JSON.stringify({ catalog: { expertise: name === 'alice' ? ['Data'] : [] } })],
      );
    }
  });

  afterEach(async () => {
    await db.close();
  });

  it('round-trips nested groups, descriptions, order, leads, members, and tags', async () => {
    await store.replaceFromConfig(teamId, nestedOrg, {
      decidedBy: 'test',
      decidedAt: 123,
      reason: 'fixture',
      sourceHash: 'sha256:fixture',
    });
    expect(await store.getState(teamId)).toEqual({
      teamId,
      status: 'normalized',
      decidedBy: 'test',
      decidedAt: 123,
      reason: 'fixture',
      sourceHash: 'sha256:fixture',
    });
    expect(await store.readOrg(teamId)).toEqual(nestedOrg);
  });

  it('treats a repeated lead as implicit and stores no duplicate membership row', async () => {
    await store.replaceFromConfig(teamId, {
      groups: {
        Engineering: { lead: 'alice', members: ['alice', 'bob'] },
      },
    }, { decidedBy: 'test' });
    expect(await store.readOrg(teamId)).toEqual({
      groups: { Engineering: { lead: 'alice', members: ['bob'] } },
    });
    const rows = await db.query<{ name: string }>(
      `SELECT a.name FROM org_group_members m JOIN agents a ON a.id = m.agent_id`,
    );
    expect(rows.rows.map((row) => row.name)).toEqual(['bob']);
  });

  it('renders chart and per-agent context from the normalized read, never deprecated JSON', async () => {
    await store.replaceFromConfig(teamId, nestedOrg, { decidedBy: 'test' });
    const normalized = await store.readOrg(teamId);
    expect(normalized).not.toBeNull();
    expect(Object.keys(normalized!.groups)).toEqual(['Engineering', 'Research']);
    expect(Object.keys(normalized!.groups)).not.toContain('Deprecated');

    const agents = [
      { name: 'alice', description: 'Lead' },
      { name: 'bob', description: 'Builder' },
      { name: 'carol', description: 'Operator' },
    ];
    const chart = generateOrgChart('normalized-team', normalized!, agents);
    expect(chart).toContain('Engineering — Build the platform');
    expect(chart).toContain('Platform — Runtime and storage');
    expect(chart.indexOf('Engineering —')).toBeLessThan(chart.indexOf('Research —'));
    const context = generateAgentOrgContext('alice', normalized!);
    expect(context).toContain('lead');
    expect(context).toContain('Engineering');
    expect(context).toContain('Research');
    expect(context).toContain('Your tags: Security.');
  });

  it('keeps organization tags separate from agent-asserted expertise', async () => {
    await store.replaceFromConfig(teamId, nestedOrg, { decidedBy: 'test' });
    expect(await store.findActiveAgentsByTag(teamId, 'security')).toEqual(['alice', 'bob']);
    expect(await store.findActiveAgentsByTag(teamId, 'DATA')).toEqual(['carol']);
  });

  it('hides soft-deleted agents and cascades hard deletes without ghosts', async () => {
    await store.replaceFromConfig(teamId, nestedOrg, { decidedBy: 'test' });
    await db.query(`UPDATE agents SET deleted_at = 100 WHERE id = ?`, [agentIds.get('alice')]);
    const afterSoftDelete = await store.readOrg(teamId);
    expect(afterSoftDelete!.groups.Engineering.lead).toBeUndefined();
    expect(afterSoftDelete!.groups.Research.members).toBeUndefined();
    expect(afterSoftDelete!.tags!.Security).toEqual(['bob']);
    expect(await store.findActiveAgentsByTag(teamId, 'security')).toEqual(['bob']);

    await db.query(`DELETE FROM agents WHERE id = ?`, [agentIds.get('bob')]);
    const afterHardDelete = await store.readOrg(teamId);
    expect(afterHardDelete!.groups.Engineering.members).toBeUndefined();
    expect(afterHardDelete!.tags!.Security).toEqual([]);
  });

  it('moves, reorders, restricts ordinary deletion, and explicitly deletes subtrees', async () => {
    await store.replaceFromConfig(teamId, {
      groups: { First: {}, Second: {}, Third: {} },
    }, { decidedBy: 'test' });
    const rows = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM org_groups WHERE team_id = ?`,
      [teamId],
    );
    const ids = new Map(rows.rows.map((row) => [row.name, row.id]));
    await store.moveGroup(ids.get('Third')!, null, 0);
    expect(Object.keys((await store.readOrg(teamId))!.groups)).toEqual(['Third', 'First', 'Second']);

    await store.moveGroup(ids.get('First')!, ids.get('Third')!, 0);
    await expect(store.deleteGroup(ids.get('Third')!)).rejects.toThrow();
    const removed = await store.deleteSubtree(ids.get('Third')!);
    expect(new Set(removed)).toEqual(new Set([ids.get('Third'), ids.get('First')]));
    expect(Object.keys((await store.readOrg(teamId))!.groups)).toEqual(['Second']);
  });

  it('blocks unresolved, ambiguous, templated, and normalized-duplicate input before writing', async () => {
    await expect(store.replaceFromConfig(teamId, {
      groups: { Bad: { members: ['missing'] } },
    }, { decidedBy: 'test' })).rejects.toMatchObject({ code: 'org_reference_unresolved' });
    await expect(store.replaceFromConfig(teamId, {
      groups: { '${group}': {} },
    }, { decidedBy: 'test' })).rejects.toMatchObject({ code: 'org_template_unexpanded' });
    await expect(store.replaceFromConfig(teamId, {
      groups: { Engineering: {}, ' engineering ': {} },
    }, { decidedBy: 'test' })).rejects.toBeInstanceOf(OrgValidationError);
    expect(await db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM org_groups`))
      .toMatchObject({ rows: [{ count: 0 }] });

    await db.query(
      `INSERT INTO agents
         (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
       VALUES ('agent-alice-duplicate', ?, 'alice', 'claude', 'model', 0, 'running', 10, '{}', 'codex')`,
      [teamId],
    );
    await expect(store.replaceFromConfig(teamId, {
      groups: { Bad: { lead: 'alice' } },
    }, { decidedBy: 'test' })).rejects.toMatchObject({ code: 'org_reference_ambiguous' });
  });

  it('refuses corrupt normalized state rather than returning a partial render', async () => {
    await store.replaceFromConfig(teamId, nestedOrg, { decidedBy: 'test' });
    await db.query(`UPDATE org_groups SET name_normalized = 'wrong' WHERE name = 'Platform'`);
    await expect(store.readOrg(teamId)).rejects.toMatchObject({ code: 'org_data_corrupt' });
  });
});

describe('shared org normalization and parser validation', () => {
  it('normalizes shared vectors deterministically', () => {
    expect([
      ' Engineering ',
      'ENGINEERING',
      'Ｅｎｇｉｎｅｅｒｉｎｇ',
      'engineering',
    ].map(normalizeOrgKey)).toEqual([
      'engineering',
      'engineering',
      'engineering',
      'engineering',
    ]);
    expect(normalizeOrgKey('Data   Science')).toBe('data science');
  });

  it('rejects unresolved org references and normalized sibling duplicates in config parsing', () => {
    const result = validateConfig({
      version: '1',
      agents: [{ name: 'alice' }],
      org: {
        groups: {
          Engineering: { lead: 'missing' },
          ' engineering ': {},
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.message.includes('does not resolve'))).toBe(true);
    expect(result.errors.some((error) => error.message.includes('duplicate normalized sibling'))).toBe(true);
  });
});
