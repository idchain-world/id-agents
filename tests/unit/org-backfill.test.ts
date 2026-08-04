// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { backfillOrganizations, sha256 } from '../../src/org/backfill.js';
import {
  applyOrgBackfill,
  assertSafeDatabasePath,
  dryRunOrgBackfill,
  fileSha256,
  parseNoOrgOverrides,
  restoreOrgBackfillSnapshot,
} from '../../src/org/backfill-cli.js';

const roots: string[] = [];

interface FleetFixture {
  db: SqliteAdapter;
  sources: Map<string, string>;
}

function source(org: string): string {
  return `version: "1"\nteam: fixture\n${org}\n`;
}

async function addAgents(db: SqliteAdapter, teamId: string): Promise<void> {
  for (let index = 1; index <= 14; index++) {
    await db.query(
      `INSERT INTO agents
         (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
       VALUES (?, ?, ?, 'claude', 'model', 0, 'running', ?, '{}', 'codex')`,
      [`${teamId}-a${index}`, teamId, `a${index}`, index],
    );
  }
}

async function createFleet(databasePath = ':memory:'): Promise<FleetFixture> {
  const db = new SqliteAdapter(databasePath);
  await migrateSqlite(db);
  const sources = new Map<string, string>([
    ['/source/one.yaml', source(`org:\n  groups:\n    one:\n      description: First\n      lead: a1\n      members: [a1, a2]\n  tags:\n    t1: [a1, a2, a3, a4]`)],
    ['/source/two.yaml', source(`org:\n  groups:\n    two:\n      description: Second\n      lead: a1\n      members: [a1, a2]\n      groups:\n        child:\n          description: Child\n          members: [a3]\n  tags:\n    t2: [a1, a2, a3, a4, a5, a6, a7]\n    t3: [a8, a9, a10, a11, a12, a13, a14]`)],
    ['/source/three.yaml', source(`org:\n  groups:\n    three:\n      lead: a1\n      members: [a1]\n      groups:\n        left:\n          members: [a2]\n        right:\n          members: [a3]`)],
    ['/source/four.yaml', source(`org:\n  groups:\n    four:\n      lead: a1\n      members: [a1, a2]\n  tags:\n    t4: [a1, a2]`)],
    ['/source/no-org.yaml', source('agents: []')],
    ['/source/template.yaml', source(`org:\n  groups:\n    templated:\n      members: ["${'${MISSING_AGENT}'}"]`)],
    ['/source/unresolved.yaml', source(`org:\n  groups:\n    unresolved:\n      members: [not-an-agent]`)],
  ]);
  const specs: Array<[string, string | null]> = [
    ['source-one', '/source/one.yaml'],
    ['source-two', '/source/two.yaml'],
    ['source-three', '/source/three.yaml'],
    ['source-four', '/source/four.yaml'],
    ['missing-path', null],
    ['missing-source', '/source/missing.yaml'],
    ['no-org', '/source/no-org.yaml'],
    ['template', '/source/template.yaml'],
    ['unresolved', '/source/unresolved.yaml'],
  ];
  for (const [name, sourcePath] of specs) {
    const teamId = randomUUID();
    // Force source-path recovery for this fleet; the deprecated copy is tested
    // separately because its presence is itself a valid legacy source.
    const storedConfig = JSON.stringify(sourcePath ? { last_config_path: sourcePath } : {});
    await db.query(`INSERT INTO teams (id, name, config) VALUES (?, ?, ?)`, [teamId, name, storedConfig]);
    await addAgents(db, teamId);
  }
  return { db, sources };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('audited organization backfill', () => {
  it('dry-runs all nine teams without writing and reports only team-local failures', async () => {
    const fixture = await createFleet();
    const report = await backfillOrganizations(fixture.db, {
      dryRun: true,
      decidedBy: 'test',
      readSource: (sourcePath) => {
        const value = fixture.sources.get(sourcePath);
        if (!value) throw new Error('ENOENT fixture source');
        return value;
      },
    });

    expect(report.totals).toEqual({
      teams: 9,
      normalized: 4,
      intentionallyNoOrg: 0,
      blocked: 5,
      groups: 7,
      tagAssignments: 20,
    });
    expect(report.teams.find((team) => team.teamName === 'source-two')?.recursiveMembers).toEqual({
      two: ['a2', 'a1', 'a3'],
      'two/child': ['a3'],
    });
    expect(report.teams.find((team) => team.teamName === 'template')?.reason)
      .toBe('source_contains_unexpanded_template');
    expect(report.teams.find((team) => team.teamName === 'unresolved')?.reason)
      .toContain('org_reference_unresolved');
    expect(report.teams.find((team) => team.teamName === 'missing-source')?.reason)
      .toContain('source_unreadable');
    expect((await fixture.db.query(`SELECT * FROM team_org_state`)).rowCount).toBe(0);
    expect((await fixture.db.query(`SELECT * FROM org_migration_audit`)).rowCount).toBe(0);
    await fixture.db.close();
  });

  it('applies four exact orgs, blocks five teams, and records one audit row per team', async () => {
    const fixture = await createFleet();
    const report = await backfillOrganizations(fixture.db, {
      dryRun: false,
      decidedBy: 'test',
      now: 123,
      runId: randomUUID(),
      readSource: (sourcePath) => {
        const value = fixture.sources.get(sourcePath);
        if (!value) throw new Error('ENOENT fixture source');
        return value;
      },
    });
    expect(report.totals.normalized).toBe(4);
    expect(report.totals.blocked).toBe(5);
    expect(Number((await fixture.db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM team_org_state`,
    )).rows[0]?.count)).toBe(9);
    expect(Number((await fixture.db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM org_migration_audit WHERE run_id = ?`,
      [report.runId],
    )).rows[0]?.count)).toBe(9);
    expect(Number((await fixture.db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM org_groups`,
    )).rows[0]?.count)).toBe(7);
    expect(Number((await fixture.db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM org_agent_tags`,
    )).rows[0]?.count)).toBe(20);
    await fixture.db.close();
  });

  it('accepts an explicit audited no-org override but never invents one', async () => {
    const fixture = await createFleet();
    const report = await backfillOrganizations(fixture.db, {
      dryRun: false,
      decidedBy: 'operator',
      readSource: (sourcePath) => {
        const value = fixture.sources.get(sourcePath);
        if (!value) throw new Error('ENOENT fixture source');
        return value;
      },
      noOrgOverrides: { 'missing-path': { reason: 'operator verified no historical org' } },
    });
    expect(report.totals.intentionallyNoOrg).toBe(1);
    expect(report.totals.blocked).toBe(4);
    expect(report.teams.find((team) => team.teamName === 'missing-path')).toMatchObject({
      status: 'intentionally_no_org',
      reason: 'operator verified no historical org',
    });
    await fixture.db.close();
  });

  it('refuses a no-org override that conflicts with resolvable org content', async () => {
    const fixture = await createFleet();
    const options = {
      decidedBy: 'operator',
      readSource: (sourcePath: string): string => {
        const value = fixture.sources.get(sourcePath);
        if (!value) throw new Error('ENOENT fixture source');
        return value;
      },
      noOrgOverrides: { 'source-two': { reason: 'stale operator entry' } },
    };
    const dry = await backfillOrganizations(fixture.db, { ...options, dryRun: true });
    expect(dry.teams.find((team) => team.teamName === 'source-two')).toMatchObject({
      status: 'blocked',
      reason: 'override_conflicts_with_resolvable_org: stale operator entry',
      sourcePath: '/source/two.yaml',
      groupCount: 2,
      tagAssignmentCount: 14,
    });
    await expect(backfillOrganizations(fixture.db, { ...options, dryRun: false }))
      .rejects.toThrow('override_conflicts_with_resolvable_org');
    expect((await fixture.db.query(`SELECT * FROM team_org_state`)).rowCount).toBe(0);
    await fixture.db.close();
  });

  it('requires operator acknowledgment when an already-audited source drifts', async () => {
    const fixture = await createFleet();
    const readSource = (sourcePath: string): string => {
      const value = fixture.sources.get(sourcePath);
      if (!value) throw new Error('ENOENT fixture source');
      return value;
    };
    await backfillOrganizations(fixture.db, { dryRun: false, decidedBy: 'test', readSource });
    fixture.sources.set('/source/one.yaml', fixture.sources.get('/source/one.yaml')!.replace('First', 'Changed'));
    const dry = await backfillOrganizations(fixture.db, { dryRun: true, decidedBy: 'test', readSource });
    expect(dry.teams.find((team) => team.teamName === 'source-one')?.reason)
      .toContain('source_drift_requires_acknowledgment');
    await expect(backfillOrganizations(fixture.db, {
      dryRun: false,
      decidedBy: 'test',
      readSource,
    })).rejects.toThrow('source_drift_requires_acknowledgment');
    const acknowledged = await backfillOrganizations(fixture.db, {
      dryRun: true,
      decidedBy: 'test',
      readSource,
      acknowledgeSourceDrift: true,
    });
    expect(acknowledged.teams.find((team) => team.teamName === 'source-one')?.status).toBe('normalized');
    await fixture.db.close();
  });

  it('copies before mutation, leaves dry-run input unchanged, and restores only without drift', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'org-backfill-test-'));
    roots.push(root);
    const databasePath = path.join(root, 'fleet.db');
    const sourcePath = path.join(root, 'fleet.yaml');
    fs.writeFileSync(sourcePath, source(`org:\n  groups:\n    only:\n      lead: a1\n      members: [a1, a2]`));
    const db = new SqliteAdapter(databasePath);
    await migrateSqlite(db);
    const teamId = randomUUID();
    await db.query(`INSERT INTO teams (id, name, config) VALUES (?, 'fleet', ?)`, [
      teamId,
      JSON.stringify({ last_config_path: sourcePath, org: { groups: { stale: {} } } }),
    ]);
    await addAgents(db, teamId);
    await db.close();

    const originalHash = fileSha256(databasePath);
    const dry = await dryRunOrgBackfill({ databasePath, decidedBy: 'test' });
    expect(dry.totals.normalized).toBe(1);
    expect(fileSha256(databasePath)).toBe(originalHash);

    const rollbackPath = path.join(root, 'rollback.db');
    const auditOutputPath = path.join(root, 'audit.json');
    const applied = await applyOrgBackfill({
      databasePath,
      rollbackPath,
      auditOutputPath,
      decidedBy: 'test',
    });
    expect(applied.beforeSha256).toBe(originalHash);
    expect(fs.existsSync(rollbackPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(auditOutputPath, 'utf8')).teams).toHaveLength(1);
    await restoreOrgBackfillSnapshot({
      databasePath,
      rollbackPath,
      expectedCurrentSha256: applied.afterSha256,
    });
    expect(fileSha256(databasePath)).toBe(originalHash);

    const appliedAgain = await applyOrgBackfill({
      databasePath,
      rollbackPath: path.join(root, 'rollback-2.db'),
      auditOutputPath: path.join(root, 'audit-2.json'),
      decidedBy: 'test',
    });
    fs.appendFileSync(databasePath, 'drift');
    await expect(restoreOrgBackfillSnapshot({
      databasePath,
      rollbackPath: path.join(root, 'rollback-2.db'),
      expectedCurrentSha256: appliedAgain.afterSha256,
    })).rejects.toThrow('target database drifted');
  });

  it('refuses the live database path before opening it', () => {
    const live = path.join(os.homedir(), '.id-agents', 'id-agents.db');
    if (fs.existsSync(live)) expect(() => assertSafeDatabasePath(live)).toThrow('refusing to open');
  });

  it('requires an exact explicit opt-in for the live database and warns loudly', () => {
    const live = path.join(os.homedir(), '.id-agents', 'id-agents.db');
    if (!fs.existsSync(live)) return;
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(assertSafeDatabasePath(live, true)).toBe(fs.realpathSync(live));
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(writes.join('')).toContain('WARNING');
    expect(writes.join('')).toContain('LIVE ~/.id-agents/id-agents.db');
  });

  it('requires a separate stopped-process confirmation before live restore', async () => {
    const live = path.join(os.homedir(), '.id-agents', 'id-agents.db');
    if (!fs.existsSync(live)) return;
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await expect(restoreOrgBackfillSnapshot({
        databasePath: live,
        rollbackPath: '/does/not/matter-before-the-confirmation.db',
        expectedCurrentSha256: 'not-used',
        allowLiveDatabase: true,
      })).rejects.toThrow('--confirm-live-processes-stopped');
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it('parses only explicit audited no-org overrides', () => {
    expect(parseNoOrgOverrides([])).toBeUndefined();
    expect(() => parseNoOrgOverrides(['--intentionally-no-org', 'all']))
      .toThrow('--no-org-reason');
    expect(parseNoOrgOverrides([
      '--intentionally-no-org', 'all',
      '--intentionally-no-org', 'public',
      '--no-org-reason', 'Prem approved no historical organization',
    ])).toEqual({
      all: { reason: 'Prem approved no historical organization' },
      public: { reason: 'Prem approved no historical organization' },
    });
  });
});

describe('backfill hash helper', () => {
  it('uses stable SHA-256 bytes', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
