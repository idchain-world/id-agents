// SPDX-License-Identifier: MIT
/**
 * Automatic export wiring — SPEC §5.4 (commit 3).
 *
 * The scheduler itself is covered in tests/unit/auto-export.test.ts. These
 * prove the HOOKS: that real mutations queue a write, that the write lands at
 * the autoexport path and not the operator's file, and that a failing export
 * cannot fail the mutation that triggered it.
 *
 * Fixtures only — in-memory SQLite, live DB on :4100 never touched, manager
 * never restarted. Debounce is driven down via ID_AUTOEXPORT_DEBOUNCE_MS so
 * these run in milliseconds rather than 5s each.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as net from 'net';
import yaml from 'js-yaml';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import { autoExportPath } from '../../src/lib/auto-export.js';

const DEBOUNCE_MS = 25;

async function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    events: new SqliteEventsRepo(adapter),
    subscriptions: new SqliteSubscriptionsRepo(adapter),
    checkins: new SqliteCheckinsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

const TEAM = 'auto-export-team';
const settle = (ms = DEBOUNCE_MS * 4) => new Promise((r) => setTimeout(r, ms));

describe('§5.4 automatic export on mutation', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;
  let prevDebounce: string | undefined;

  beforeEach(async () => {
    prevDebounce = process.env.ID_AUTOEXPORT_DEBOUNCE_MS;
    process.env.ID_AUTOEXPORT_DEBOUNCE_MS = String(DEBOUNCE_MS);

    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-export-'));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);

    teamId = await db.teams.getOrCreateTeamId(TEAM);
    await db.agents.create({
      team_id: teamId, id: 'local_alpha', name: 'alpha', type: 'claude',
      model: 'claude-haiku-4-5-20251001', status: 'running', created_at: Date.now(),
      runtime: 'claude-code-cli', metadata: { description: 'seed agent' },
    } as any);
  });

  afterEach(async () => {
    await manager.shutdown().catch(() => {});
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 400);
    });
    await db.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevDebounce === undefined) delete process.env.ID_AUTOEXPORT_DEBOUNCE_MS;
    else process.env.ID_AUTOEXPORT_DEBOUNCE_MS = prevDebounce;
  });

  const expectedPath = () => autoExportPath(workDir, TEAM);

  async function post(route: string, body: unknown) {
    return fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM, 'X-Id-Admin': '1' },
      body: JSON.stringify(body),
    });
  }

  it('fires on a model change', async () => {
    expect(fs.existsSync(expectedPath())).toBe(false);
    const resp = await post('/agents/local_alpha/model', { model: 'claude-opus-5' });
    expect(resp.ok).toBe(true);

    await settle();
    expect(fs.existsSync(expectedPath())).toBe(true);
    const doc = yaml.load(fs.readFileSync(expectedPath(), 'utf-8')) as any;
    expect(doc.team).toBe(TEAM);
    expect(doc.agents.map((a: any) => a.name)).toContain('alpha');
  });

  it('fires on a metadata write', async () => {
    const resp = await post('/agents/by-name/alpha/metadata', { metadata: { bio: 'hello' } });
    expect(resp.ok).toBe(true);
    await settle();
    const doc = yaml.load(fs.readFileSync(expectedPath(), 'utf-8')) as any;
    expect(doc.agents[0].bio).toBe('hello');
  });

  it('fires on agent delete', async () => {
    const resp = await fetch(`${baseUrl}/agents/by-name/alpha`, {
      method: 'DELETE',
      headers: { 'X-Id-Team': TEAM, 'X-Id-Admin': '1' },
    });
    expect(resp.ok).toBe(true);
    await settle();
    const doc = yaml.load(fs.readFileSync(expectedPath(), 'utf-8')) as any;
    expect(doc.agents ?? []).toEqual([]);
  });

  it('writes to the autoexport path and never to last_config_path', async () => {
    const operatorFile = path.join(workDir, 'operator-owned.yaml');
    await db.teams.updateConfig(teamId, { last_config_path: operatorFile });

    await post('/agents/local_alpha/model', { model: 'claude-opus-5' });
    await settle();

    expect(fs.existsSync(expectedPath())).toBe(true);
    // The operator's own config is untouched — an automatic write must never
    // overwrite the file a human chose.
    expect(fs.existsSync(operatorFile)).toBe(false);
    // last_config_path is not rewritten either.
    const config = await db.teams.getConfig(teamId);
    expect(config.last_config_path).toBe(operatorFile);
  });

  it('coalesces several rapid mutations into one write', async () => {
    for (const model of ['a', 'b', 'c', 'd']) {
      await post('/agents/local_alpha/model', { model });
    }
    await settle();
    expect(fs.existsSync(expectedPath())).toBe(true);
    // One surviving write, carrying the LAST mutation's value.
    const doc = yaml.load(fs.readFileSync(expectedPath(), 'utf-8')) as any;
    const entry = doc.agents.find((a: any) => a.name === 'alpha') ?? doc.defaults;
    expect(entry.model ?? doc.defaults?.model).toBe('d');
  });

  it('a failing export does NOT fail the triggering mutation, and is logged', async () => {
    // Make the export throw by putting a FILE where the team directory must go,
    // so mkdirSync inside the module fails.
    const teamsDir = path.join(workDir, 'teams');
    fs.mkdirSync(teamsDir, { recursive: true });
    fs.writeFileSync(path.join(teamsDir, TEAM), 'not a directory');

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const resp = await post('/agents/local_alpha/model', { model: 'claude-opus-5' });
      // The mutation itself succeeded — that is the contract.
      expect(resp.ok).toBe(true);
      expect((await resp.json() as any).model).toBe('claude-opus-5');

      await settle();
      expect(warnings.join('\n')).toContain('[AutoExport]');
      expect(warnings.join('\n')).toContain(TEAM);
    } finally {
      console.warn = originalWarn;
    }

    // And the mutation really landed in the database.
    const row = await db.agents.getById('local_alpha');
    expect((row as any)?.model).toBe('claude-opus-5');
  });

  it('fires on schedule add and on schedule remove (§5.4 trigger list)', async () => {
    // §5.4 lists schedule add/remove as triggers; commit 3 hooked six mutation
    // sites but no schedule site, so these two paths wrote nothing.
    const add = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM, 'X-Id-Admin': '1' },
      body: JSON.stringify({ command: '/schedule add heartbeat alpha 900 ping' }),
    });
    const addBody = await add.json() as any;
    expect(addBody.ok).toBe(true);

    await settle();
    expect(fs.existsSync(expectedPath())).toBe(true);

    // Remove the file, then remove the schedule: the delete path must write again.
    fs.unlinkSync(expectedPath());
    const schedules = await db.schedules.listSchedulesForAgent('local_alpha');
    const scheduleId = schedules[0]?.id;
    expect(scheduleId).toBeTruthy();

    const remove = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM, 'X-Id-Admin': '1' },
      body: JSON.stringify({ command: `/schedule remove ${scheduleId}` }),
    });
    expect((await remove.json() as any).ok).toBe(true);

    await settle();
    expect(fs.existsSync(expectedPath())).toBe(true);
  });

  it('shutdown cancels a pending export so no timer outlives the manager', async () => {
    await post('/agents/local_alpha/model', { model: 'claude-opus-5' });
    await manager.shutdown();
    await settle();
    // The debounced write was dropped rather than firing into a closing DB.
    expect(fs.existsSync(expectedPath())).toBe(false);
  });
});
