// SPDX-License-Identifier: MIT
/**
 * POST /agents/spawn working-directory guard — SPEC §6.1.
 *
 * Closes the HIGH working-directory injection: the body field was used
 * unvalidated, so a caller chose where the agent's workspace lived.
 *
 * Fixtures only; the live DB on :4100 is never touched and no real agent
 * process is spawned.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as net from 'net';

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

const TEAM = 'spawn-guard-team';

describe('POST /agents/spawn — workingDirectory containment (§6.1)', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let outside: string;
  let spawnCount = 0;

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    // realpath so macOS /var -> /private/var does not confuse containment.
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-guard-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-outside-')));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    spawnCount = 0;
    (manager as any).spawnLocalAgentProcess = async () => { spawnCount++; return { success: true, pid: 1234, logFile: '/tmp/x.log' }; };
    (manager as any).deploySkillsToAgent = () => undefined;
    (manager as any).copyPluginsToAgent = () => [];
    (manager as any).ensureRuntimeReady = () => undefined;
    await manager.start(port);
    await db.teams.getOrCreateTeamId(TEAM);
  });

  afterEach(async () => {
    await manager.shutdown().catch(() => {});
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 300);
    });
    await db.close();
    for (const d of [workDir, outside]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  async function spawn(name: string, workingDirectory?: string) {
    const body: Record<string, unknown> = { name, type: 'claude', model: 'claude-haiku-4-5-20251001' };
    if (workingDirectory !== undefined) body.workingDirectory = workingDirectory;
    const resp = await fetch(`${baseUrl}/agents/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM, 'X-Id-Admin': '1' },
      body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.json().catch(() => ({})) as any };
  }

  it('rejects ../ traversal with 400 invalid_working_directory', async () => {
    const { status, body } = await spawn('trav', path.join(workDir, '..', '..', 'etc'));
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_working_directory');
  });

  it('rejects an absolute path outside every permitted root', async () => {
    const { status, body } = await spawn('abs', outside);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_working_directory');
  });

  it('rejects a symlink inside the root that escapes it', async () => {
    // The HIGH finding's sharpest form: lexically inside, resolves outside.
    const link = path.join(workDir, 'looks-inside');
    fs.symlinkSync(outside, link);
    expect(link.startsWith(workDir)).toBe(true); // a prefix check would allow it

    const { status, body } = await spawn('symlink', path.join(link, 'agent'));
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_working_directory');
  });

  it('never spawns a process or creates a row for a rejected path', async () => {
    await spawn('rejected', outside);
    expect(spawnCount).toBe(0);
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const rows = await db.agents.listAll(teamId);
    expect(rows.map((r) => r.name)).not.toContain('rejected');
  });

  it('accepts a permitted path inside baseWorkDir', async () => {
    const permitted = path.join(workDir, 'projects', 'alpha');
    const { status } = await spawn('allowed', permitted);
    expect(status).toBeLessThan(400);

    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const row = (await db.agents.listAll(teamId)).find((r) => r.name === 'allowed');
    expect(row).toBeTruthy();
    expect(row!.working_directory).toBe(permitted);
  });

  it('still defaults to <baseWorkDir>/agents/<id> when omitted', async () => {
    const { status } = await spawn('defaulted');
    expect(status).toBeLessThan(400);

    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const row = (await db.agents.listAll(teamId)).find((r) => r.name === 'defaulted');
    expect(row).toBeTruthy();
    expect(row!.working_directory).toBe(`${workDir}/agents/${row!.id}`);
  });

  it('honours an operator opt-in root without weakening the default', async () => {
    const prev = process.env.ID_ALLOWED_WORKDIR_ROOTS;
    process.env.ID_ALLOWED_WORKDIR_ROOTS = outside;
    try {
      const { status } = await spawn('optedin', path.join(outside, 'repo'));
      expect(status).toBeLessThan(400);
    } finally {
      if (prev === undefined) delete process.env.ID_ALLOWED_WORKDIR_ROOTS;
      else process.env.ID_ALLOWED_WORKDIR_ROOTS = prev;
    }
  });
});
