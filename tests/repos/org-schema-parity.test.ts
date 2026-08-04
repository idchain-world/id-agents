// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { DbAdapter } from '../../src/db/db-adapter.js';
import { PgAdapter } from '../../src/db/pg-adapter.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { migrateOrgSchemaPostgres } from '../../src/db/migrations/org-schema.js';
import { migratePostgres } from '../../src/db/migrations/postgres.js';
import { NormalizedOrgStore } from '../../src/org/normalized-org.js';

const postgresUrl = process.env.TEST_ORG_POSTGRES_URL;
const dialects: Array<'sqlite' | 'postgres'> = postgresUrl ? ['sqlite', 'postgres'] : ['sqlite'];

function sql(db: DbAdapter, text: string): string {
  if (db.dialect === 'sqlite') return text;
  let index = 0;
  return text.replace(/\?/g, () => `$${++index}`);
}

async function q(db: DbAdapter, text: string, params: unknown[] = []): Promise<void> {
  await db.query(sql(db, text), params);
}

async function freshAdapter(dialect: 'sqlite' | 'postgres'): Promise<DbAdapter> {
  if (dialect === 'sqlite') {
    const adapter = new SqliteAdapter(':memory:');
    await migrateSqlite(adapter);
    return adapter;
  }
  if (!postgresUrl || !postgresUrl.includes('org_test')) {
    throw new Error('TEST_ORG_POSTGRES_URL must name a disposable database containing org_test');
  }
  const adapter = new PgAdapter(new Pool({ connectionString: postgresUrl }));
  await adapter.query(`DROP SCHEMA public CASCADE`);
  await adapter.query(`CREATE SCHEMA public`);
  await adapter.query(`
    CREATE TABLE teams (
      id uuid PRIMARY KEY,
      name text UNIQUE NOT NULL,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      port_start integer NOT NULL DEFAULT 4101,
      port_end integer NOT NULL DEFAULT 4125,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await adapter.query(`
    CREATE TABLE agents (
      id text PRIMARY KEY,
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name text NOT NULL,
      type text NOT NULL,
      model text NOT NULL,
      port integer NOT NULL DEFAULT 0,
      status text NOT NULL,
      created_at bigint NOT NULL,
      metadata jsonb,
      deleted_at bigint,
      runtime text NOT NULL DEFAULT 'codex'
    )
  `);
  await migrateOrgSchemaPostgres(adapter);
  return adapter;
}

describe.each(dialects)('normalized org schema parity (%s)', (dialect) => {
  let db: DbAdapter;
  let teamA: string;
  let teamB: string;
  let agentA: string;
  let agentB: string;
  let agentC: string;

  beforeEach(async () => {
    db = await freshAdapter(dialect);
    teamA = randomUUID();
    teamB = randomUUID();
    agentA = `agent-a-${randomUUID()}`;
    agentB = `agent-b-${randomUUID()}`;
    agentC = `agent-c-${randomUUID()}`;
    await q(db, `INSERT INTO teams (id, name) VALUES (?, ?)`, [teamA, `team-a-${randomUUID()}`]);
    await q(db, `INSERT INTO teams (id, name) VALUES (?, ?)`, [teamB, `team-b-${randomUUID()}`]);
    await q(db,
      `INSERT INTO agents (id, team_id, name, type, model, status, created_at, metadata)
       VALUES (?, ?, 'alice', 'claude', 'model', 'running', 1, ?)`,
      [agentA, teamA, dialect === 'sqlite' ? '{}' : {}],
    );
    await q(db,
      `INSERT INTO agents (id, team_id, name, type, model, status, created_at, metadata)
       VALUES (?, ?, 'bob', 'claude', 'model', 'running', 2, ?)`,
      [agentB, teamB, dialect === 'sqlite' ? '{}' : {}],
    );
    await q(db,
      `INSERT INTO agents (id, team_id, name, type, model, status, created_at, metadata)
       VALUES (?, ?, 'carol', 'claude', 'model', 'running', 3, ?)`,
      [agentC, teamA, dialect === 'sqlite' ? '{}' : {}],
    );
  });

  afterEach(async () => {
    await db.close();
  });

  it('is installed idempotently by the full database migration', async () => {
    if (dialect === 'postgres') {
      await db.query(`DROP SCHEMA public CASCADE`);
      await db.query(`CREATE SCHEMA public`);
      await migratePostgres(db);
      await migratePostgres(db);
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name LIKE 'org_%'
         ORDER BY table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        'org_agent_tags',
        'org_group_leads',
        'org_group_members',
        'org_groups',
        'org_tags',
      ]);
    } else {
      await migrateSqlite(db as SqliteAdapter);
      const tables = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'org_%' ORDER BY name`,
      );
      expect(tables.rows.map((row) => row.name)).toEqual([
        'org_agent_tags',
        'org_group_leads',
        'org_group_members',
        'org_groups',
        'org_tags',
      ]);
    }
  });

  it('rejects cross-team parents, leads, members, and tag assignments', async () => {
    const rootA = randomUUID();
    const rootB = randomUUID();
    await q(db,
      `INSERT INTO org_groups (id, team_id, parent_group_id, name, name_normalized, position)
       VALUES (?, ?, NULL, 'Root A', 'root a', 0)`,
      [rootA, teamA],
    );
    await expect(q(db,
      `INSERT INTO org_groups (id, team_id, parent_group_id, name, name_normalized, position)
       VALUES (?, ?, ?, 'Bad child', 'bad child', 0)`,
      [rootB, teamB, rootA],
    )).rejects.toThrow();
    await expect(q(db,
      `INSERT INTO org_group_leads (team_id, group_id, agent_id) VALUES (?, ?, ?)`,
      [teamA, rootA, agentB],
    )).rejects.toThrow();
    await expect(q(db,
      `INSERT INTO org_group_members (team_id, group_id, agent_id, position) VALUES (?, ?, ?, 0)`,
      [teamA, rootA, agentB],
    )).rejects.toThrow();
    const tag = randomUUID();
    await q(db,
      `INSERT INTO org_tags (id, team_id, name, name_normalized, position)
       VALUES (?, ?, 'Security', 'security', 0)`,
      [tag, teamA],
    );
    await expect(q(db,
      `INSERT INTO org_agent_tags (team_id, tag_id, agent_id, position) VALUES (?, ?, ?, 0)`,
      [teamA, tag, agentB],
    )).rejects.toThrow();
  });

  it('enforces normalized sibling-name and sibling-position uniqueness', async () => {
    const root = randomUUID();
    await q(db,
      `INSERT INTO org_groups (id, team_id, parent_group_id, name, name_normalized, position)
       VALUES (?, ?, NULL, 'Engineering', 'engineering', 0)`,
      [root, teamA],
    );
    await expect(q(db,
      `INSERT INTO org_groups (id, team_id, parent_group_id, name, name_normalized, position)
       VALUES (?, ?, NULL, 'ENGINEERING', 'engineering', 1)`,
      [randomUUID(), teamA],
    )).rejects.toThrow();
    const child = randomUUID();
    await q(db,
      `INSERT INTO org_groups (id, team_id, parent_group_id, name, name_normalized, position)
       VALUES (?, ?, ?, 'Platform', 'platform', 0)`,
      [child, teamA, root],
    );
    await expect(q(db,
      `INSERT INTO org_groups (id, team_id, parent_group_id, name, name_normalized, position)
       VALUES (?, ?, ?, 'PLATFORM', 'platform', 1)`,
      [randomUUID(), teamA, root],
    )).rejects.toThrow();
    await expect(q(db,
      `INSERT INTO org_groups (id, team_id, parent_group_id, name, name_normalized, position)
       VALUES (?, ?, ?, 'Data', 'data', 0)`,
      [randomUUID(), teamA, root],
    )).rejects.toThrow();
  });

  it('rejects cycles at write time', async () => {
    const root = randomUUID();
    const child = randomUUID();
    await q(db,
      `INSERT INTO org_groups (id, team_id, parent_group_id, name, name_normalized, position)
       VALUES (?, ?, NULL, 'Root', 'root', 0)`,
      [root, teamA],
    );
    await q(db,
      `INSERT INTO org_groups (id, team_id, parent_group_id, name, name_normalized, position)
       VALUES (?, ?, ?, 'Child', 'child', 0)`,
      [child, teamA, root],
    );
    await expect(q(db, `UPDATE org_groups SET parent_group_id = ? WHERE id = ?`, [child, root]))
      .rejects.toThrow(/org_group_cycle|constraint/i);
  });

  it('restricts ordinary parent deletion and allows leaf deletion', async () => {
    const root = randomUUID();
    const child = randomUUID();
    await q(db,
      `INSERT INTO org_groups (id, team_id, parent_group_id, name, name_normalized, position)
       VALUES (?, ?, NULL, 'Root', 'root', 0)`,
      [root, teamA],
    );
    await q(db,
      `INSERT INTO org_groups (id, team_id, parent_group_id, name, name_normalized, position)
       VALUES (?, ?, ?, 'Child', 'child', 0)`,
      [child, teamA, root],
    );
    await expect(q(db, `DELETE FROM org_groups WHERE id = ?`, [root])).rejects.toThrow();
    await expect(q(db, `DELETE FROM org_groups WHERE id = ?`, [child])).resolves.toBeUndefined();
  });

  it('cascades hard-deleted agents out of leads, membership, and tags', async () => {
    const group = randomUUID();
    const tag = randomUUID();
    await q(db,
      `INSERT INTO org_groups (id, team_id, parent_group_id, name, name_normalized, position)
       VALUES (?, ?, NULL, 'Root', 'root', 0)`,
      [group, teamA],
    );
    await q(db, `INSERT INTO org_group_leads (team_id, group_id, agent_id) VALUES (?, ?, ?)`, [teamA, group, agentA]);
    await q(db, `INSERT INTO org_group_members (team_id, group_id, agent_id, position) VALUES (?, ?, ?, 0)`, [teamA, group, agentA]);
    await q(db, `INSERT INTO org_group_members (team_id, group_id, agent_id, position) VALUES (?, ?, ?, 1)`, [teamA, group, agentC]);
    await q(db,
      `INSERT INTO org_tags (id, team_id, name, name_normalized, position)
       VALUES (?, ?, 'Security', 'security', 0)`,
      [tag, teamA],
    );
    await q(db, `INSERT INTO org_agent_tags (team_id, tag_id, agent_id, position) VALUES (?, ?, ?, 0)`, [teamA, tag, agentA]);
    await q(db, `INSERT INTO org_agent_tags (team_id, tag_id, agent_id, position) VALUES (?, ?, ?, 1)`, [teamA, tag, agentC]);
    await q(db, `DELETE FROM agents WHERE id = ?`, [agentA]);
    const leads = await db.query<{ count: number | string }>(`SELECT COUNT(*) AS count FROM org_group_leads`);
    expect(Number(leads.rows[0].count)).toBe(0);
    for (const table of ['org_group_members', 'org_agent_tags']) {
      const remaining = await db.query<{ agent_id: string; position: number }>(
        `SELECT agent_id, position FROM ${table}`,
      );
      expect(remaining.rows).toEqual([{ agent_id: agentC, position: 0 }]);
    }
  });

  it('round-trips normalized nested state and hides soft-deleted references', async () => {
    const store = new NormalizedOrgStore(db);
    await store.replaceFromConfig(teamA, {
      groups: {
        Engineering: {
          description: 'Build',
          lead: 'alice',
          members: ['carol'],
          groups: { Platform: { members: ['alice'] } },
        },
      },
      tags: { Security: ['alice', 'carol'] },
    }, { decidedBy: 'parity', decidedAt: 10, sourceHash: 'fixture' });
    expect(await store.readOrg(teamA)).toEqual({
      groups: {
        Engineering: {
          description: 'Build',
          lead: 'alice',
          members: ['carol'],
          groups: { Platform: { members: ['alice'] } },
        },
      },
      tags: { Security: ['alice', 'carol'] },
    });
    const storedKeys = await db.query<{ name_normalized: string }>(
      sql(db, `SELECT name_normalized FROM org_groups WHERE team_id = ? ORDER BY name_normalized`),
      [teamA],
    );
    expect(storedKeys.rows.map((row) => row.name_normalized)).toEqual(['engineering', 'platform']);
    await q(db, `UPDATE agents SET deleted_at = 100 WHERE id = ?`, [agentA]);
    expect(await store.readOrg(teamA)).toEqual({
      groups: {
        Engineering: {
          description: 'Build',
          members: ['carol'],
          groups: { Platform: {} },
        },
      },
      tags: { Security: ['carol'] },
    });
    expect(await store.findActiveAgentsByTag(teamA, 'SECURITY')).toEqual(['carol']);
  });

  it('keeps reorder and explicit subtree deletion deterministic and gap-free', async () => {
    const store = new NormalizedOrgStore(db);
    await store.replaceFromConfig(teamA, {
      groups: { First: {}, Second: {}, Third: {} },
    }, { decidedBy: 'parity' });
    const rows = await db.query<{ id: string; name: string }>(
      sql(db, `SELECT id, name FROM org_groups WHERE team_id = ?`),
      [teamA],
    );
    const ids = new Map(rows.rows.map((row) => [row.name, row.id]));
    await store.moveGroup(ids.get('Third')!, null, 0);
    await store.moveGroup(ids.get('First')!, ids.get('Third')!, 0);
    expect(await store.readOrg(teamA)).toEqual({
      groups: { Third: { groups: { First: {} } }, Second: {} },
    });
    await expect(store.deleteGroup(ids.get('Third')!)).rejects.toThrow();
    await store.deleteSubtree(ids.get('Third')!);
    expect(await store.readOrg(teamA)).toEqual({ groups: { Second: {} } });
    const positions = await db.query<{ position: number }>(
      sql(db, `SELECT position FROM org_groups WHERE team_id = ? ORDER BY position`),
      [teamA],
    );
    expect(positions.rows.map((row) => Number(row.position))).toEqual([0]);
  });
});
