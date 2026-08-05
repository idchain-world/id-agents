// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { DbAdapter } from '../../src/db/db-adapter.js';
import { PgAdapter } from '../../src/db/pg-adapter.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import {
  migrateInterteamFoundationPostgres,
  migrateInterteamFoundationSqlite,
} from '../../src/db/migrations/interteam-foundation.js';
import { InterteamFoundationStore } from '../../src/inter-team/foundation-store.js';
import { normalizeOrgKey } from '../../src/org/normalization.js';

const postgresUrl = process.env.TEST_ORG_POSTGRES_URL;
const dialects: Array<'sqlite' | 'postgres'> = postgresUrl ? ['sqlite', 'postgres'] : ['sqlite'];
const temporaryRoots: string[] = [];

function sql(db: DbAdapter, text: string): string {
  if (db.dialect === 'sqlite') return text;
  let index = 0;
  return text.replace(/\?/g, () => `$${++index}`);
}

async function q<T = unknown>(db: DbAdapter, text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql(db, text), params)).rows;
}

async function legacyAdapter(dialect: 'sqlite' | 'postgres'): Promise<DbAdapter> {
  if (dialect === 'sqlite') {
    const db = new SqliteAdapter(':memory:');
    db.exec(`
      CREATE TABLE teams (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        port_start INTEGER NOT NULL DEFAULT 4101,
        port_end INTEGER NOT NULL DEFAULT 4125,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        deleted_at INTEGER
      );
    `);
    return db;
  }
  if (!postgresUrl || !postgresUrl.includes('org_test')) {
    throw new Error('TEST_ORG_POSTGRES_URL must name a disposable database containing org_test');
  }
  const db = new PgAdapter(new Pool({ connectionString: postgresUrl }));
  await db.query(`DROP SCHEMA public CASCADE`);
  await db.query(`CREATE SCHEMA public`);
  await db.query(`
    CREATE TABLE teams (
      id uuid PRIMARY KEY,
      name text UNIQUE NOT NULL,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      port_start integer NOT NULL DEFAULT 4101,
      port_end integer NOT NULL DEFAULT 4125,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE TABLE agents (
      id text PRIMARY KEY,
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name text NOT NULL,
      status text NOT NULL,
      deleted_at bigint
    )
  `);
  return db;
}

async function migrate(db: DbAdapter): Promise<void> {
  if (db.dialect === 'sqlite') {
    await migrateInterteamFoundationSqlite(db as SqliteAdapter);
  } else {
    await migrateInterteamFoundationPostgres(db);
  }
}

describe.each(dialects)('interteam foundation parity (%s)', (dialect) => {
  let db: DbAdapter;
  let store: InterteamFoundationStore;
  let teamA: string;
  let teamB: string;
  let runningA: string;
  let stoppedA: string;
  let runningB: string;
  let deletedA: string;

  beforeEach(async () => {
    db = await legacyAdapter(dialect);
    teamA = randomUUID();
    teamB = randomUUID();
    runningA = `running-a-${randomUUID()}`;
    stoppedA = `stopped-a-${randomUUID()}`;
    runningB = `running-b-${randomUUID()}`;
    deletedA = `deleted-a-${randomUUID()}`;
    await q(db, `INSERT INTO teams (id, name) VALUES (?, ?)`, [teamA, `team-a-${randomUUID()}`]);
    await q(db, `INSERT INTO teams (id, name) VALUES (?, ?)`, [teamB, `team-b-${randomUUID()}`]);
    await q(db, `INSERT INTO agents (id, team_id, name, status, deleted_at) VALUES (?, ?, 'running-a', 'running', NULL)`, [runningA, teamA]);
    await q(db, `INSERT INTO agents (id, team_id, name, status, deleted_at) VALUES (?, ?, 'stopped-a', 'stopped', NULL)`, [stoppedA, teamA]);
    await q(db, `INSERT INTO agents (id, team_id, name, status, deleted_at) VALUES (?, ?, 'running-b', 'running', NULL)`, [runningB, teamB]);
    await q(db, `INSERT INTO agents (id, team_id, name, status, deleted_at) VALUES (?, ?, 'deleted-a', 'stopped', 1)`, [deletedA, teamA]);
    await migrate(db);
    store = new InterteamFoundationStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('migrates existing teams closed and leadless, creates one stable node, and fabricates nothing', async () => {
    const firstNodeId = await store.getNodeId();
    expect(firstNodeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await store.getTeamSettings(teamA)).toEqual({
      teamId: teamA,
      inboundPolicy: 'closed',
      leadAgentId: null,
    });
    expect(await store.getTeamSettings(teamB)).toEqual({
      teamId: teamB,
      inboundPolicy: 'closed',
      leadAgentId: null,
    });
    expect(await q<{ count: number | string }>(db, `SELECT COUNT(*) AS count FROM manager_identity`))
      .toMatchObject([{ count: expect.anything() }]);
    expect(Number((await q<{ count: number | string }>(db, `SELECT COUNT(*) AS count FROM manager_identity`))[0].count)).toBe(1);
    expect(Number((await q<{ count: number | string }>(db, `SELECT COUNT(*) AS count FROM team_contacts`))[0].count)).toBe(0);
    await migrate(db);
    expect(await store.getNodeId()).toBe(firstNodeId);
  });

  it('allows an explicit stopped lead, rejects cross-team/deleted leads, and clears on deletion', async () => {
    await store.setTeamLead(teamA, stoppedA);
    expect((await store.getTeamSettings(teamA))?.leadAgentId).toBe(stoppedA);
    await expect(store.setTeamLead(teamA, runningB)).rejects.toThrow('team_lead_invalid');
    await expect(store.setTeamLead(teamA, deletedA)).rejects.toThrow('team_lead_invalid');
    await expect(q(db, `UPDATE teams SET lead_agent_id = ? WHERE id = ?`, [runningB, teamA]))
      .rejects.toThrow(/team_lead_invalid|constraint/i);

    await q(db, `UPDATE agents SET deleted_at = 2 WHERE id = ?`, [stoppedA]);
    expect((await store.getTeamSettings(teamA))?.leadAgentId).toBeNull();
    await store.setTeamLead(teamA, runningA);
    await q(db, `DELETE FROM agents WHERE id = ?`, [runningA]);
    expect((await store.getTeamSettings(teamA))?.leadAgentId).toBeNull();
  });

  it('keeps contact aliases team-scoped, normalized consistently, and remote pins opaque', async () => {
    const remoteNode = 'opaque-node:not-a-uuid';
    const remoteTeam = 'opaque-team:not-a-uuid';
    const first = await store.createContact({
      localTeamId: teamA,
      aliasDisplay: '  ＯＰＳ   Team  ',
      remoteNodeId: remoteNode,
      remoteTeamId: remoteTeam,
      now: 10,
    });
    expect(first.aliasNormalized).toBe(normalizeOrgKey('  ＯＰＳ   Team  '));
    expect(first.aliasNormalized).toBe('ops team');
    await expect(store.createContact({
      localTeamId: teamA,
      aliasDisplay: 'ops team',
      remoteNodeId: randomUUID(),
      remoteTeamId: randomUUID(),
    })).rejects.toThrow();
    await expect(store.createContact({
      localTeamId: teamB,
      aliasDisplay: 'ops team',
      remoteNodeId: remoteNode,
      remoteTeamId: remoteTeam,
    })).resolves.toMatchObject({ aliasNormalized: 'ops team' });
    expect((await store.getContactByAlias(teamA, 'OPS TEAM'))?.id).toBe(first.id);
  });

  it('renames both alias forms atomically, refuses normalized conflicts, and never rewrites pins', async () => {
    const originalNode = randomUUID();
    const originalTeam = randomUUID();
    const first = await store.createContact({
      localTeamId: teamA,
      aliasDisplay: 'alpha',
      remoteNodeId: originalNode,
      remoteTeamId: originalTeam,
      now: 1,
    });
    await store.createContact({
      localTeamId: teamA,
      aliasDisplay: 'beta',
      remoteNodeId: randomUUID(),
      remoteTeamId: randomUUID(),
      now: 1,
    });
    await expect(store.renameContact({
      id: first.id,
      localTeamId: teamA,
      aliasDisplay: 'ＢＥＴＡ',
      now: 2,
    })).rejects.toThrow();
    expect(await store.getContactByAlias(teamA, 'alpha')).toMatchObject({ id: first.id });

    const renamed = await store.renameContact({
      id: first.id,
      localTeamId: teamA,
      aliasDisplay: 'ＧＡＭＭＡ',
      now: 3,
    });
    expect(renamed).toMatchObject({
      aliasDisplay: 'ＧＡＭＭＡ',
      aliasNormalized: 'gamma',
      remoteNodeId: originalNode,
      remoteTeamId: originalTeam,
    });
    expect(await store.getContactByAlias(teamA, 'alpha')).toBeNull();
    expect((await store.getContactByAlias(teamA, 'gamma'))?.id).toBe(first.id);
  });

  it('cascades contacts only with their local owner team', async () => {
    await store.createContact({
      localTeamId: teamA,
      aliasDisplay: 'remote',
      remoteNodeId: randomUUID(),
      remoteTeamId: teamB,
    });
    await q(db, `DELETE FROM teams WHERE id = ?`, [teamB]);
    expect(await store.listContacts(teamA)).toHaveLength(1);
    await q(db, `DELETE FROM teams WHERE id = ?`, [teamA]);
    expect(Number((await q<{ count: number | string }>(db, `SELECT COUNT(*) AS count FROM team_contacts`))[0].count)).toBe(0);
  });
});

describe('manager identity restore-in-place', () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves the one node UUID when the database is restored and reopened', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interteam-node-identity-'));
    temporaryRoots.push(root);
    const originalPath = path.join(root, 'original.db');
    const restoredPath = path.join(root, 'restored.db');
    const original = new SqliteAdapter(originalPath);
    original.exec(`
      CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        deleted_at INTEGER
      );
    `);
    await migrateInterteamFoundationSqlite(original);
    const nodeId = await new InterteamFoundationStore(original).getNodeId();
    await original.close();
    fs.copyFileSync(originalPath, restoredPath);

    const restored = new SqliteAdapter(restoredPath);
    await migrateInterteamFoundationSqlite(restored);
    expect(await new InterteamFoundationStore(restored).getNodeId()).toBe(nodeId);
    await restored.close();
  });
});
