// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServer } from 'net';
import { InteractiveAgentServer } from '../../src/interactive-agent-server.js';
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

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

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

describe('InteractiveAgentServer human-agent routes', () => {
  let port: number;
  let baseUrl: string;
  let server: InteractiveAgentServer;

  beforeAll(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = new InteractiveAgentServer('operator', port);
    await server.start();
  });

  afterAll(async () => {
    await server.close();
  });

  it('accepts talk, schedule, and news traffic without manager-daemon redirects', async () => {
    const talkRes = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello human', from: 'tester' }),
    });
    expect(talkRes.status).toBe(202);
    const talkBody = await talkRes.json() as { query_id: string; status: string };
    expect(talkBody.query_id).toMatch(/^query_/);
    expect(talkBody.status).toBe('pending');

    const pendingAfterTalk = await server.getPendingQueries();
    expect(pendingAfterTalk.map((q) => q.query_id)).toContain(talkBody.query_id);

    const scheduleRes = await fetch(`${baseUrl}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'wake up',
        mode: 'internal',
        schedule: {
          id: 'sched-1',
          kind: 'heartbeat',
          title: 'Wake up',
          scheduledKey: 'heartbeat:sched-1',
        },
      }),
    });
    expect(scheduleRes.status).toBe(202);

    const incomingNewsRes = await fetch(`${baseUrl}/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'peer', message: 'side-channel update' }),
    });
    expect(incomingNewsRes.status).toBe(201);

    await server.respond(talkBody.query_id, 'acknowledged');

    const newsRes = await fetch(`${baseUrl}/news?since=0&limit=20`);
    expect(newsRes.ok).toBe(true);
    const newsBody = await newsRes.json() as { items: Array<{ type: string; data?: any; message?: string }> };
    const types = newsBody.items.map((item) => item.type);
    expect(types).toContain('query.received');
    expect(types).toContain('schedule.received');
    expect(types).toContain('message');
    expect(types).toContain('query.completed');
    const completion = newsBody.items.find((item) => item.type === 'query.completed');
    expect(completion?.data?.query_id).toBe(talkBody.query_id);
  });
});

describe('manager registration cleanup', () => {
  let port: number;
  let baseUrl: string;
  let workDir: string;
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;

  beforeAll(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-collapse-cleanup-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
  }, 30000);

  afterAll(async () => {
    if (manager) {
      await new Promise<void>((resolve) => {
        (manager as any).httpServer?.close(() => resolve());
        setTimeout(resolve, 500);
      });
    }
    await db?.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('stores a self-reported runtime and model and preserves the configured pair on re-registration', async () => {
    const id = 'local_registration_test';
    const register = (runtime: string, model: string) => fetch(baseUrl + '/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: 'registration-test', endpoint: baseUrl, type: 'claude', runtime, model }),
    });
    expect((await register('antigravity-cli', 'hydrogen')).status).toBe(201);
    expect(await db.agents.getById(id)).toMatchObject({ runtime: 'antigravity-cli', model: 'hydrogen' });
    expect((await register('codex', 'astra')).status).toBe(201);
    expect(await db.agents.getById(id)).toMatchObject({ runtime: 'antigravity-cli', model: 'hydrogen' });
  });

  it('rejects interactive self-registration under the reserved manager name', async () => {
    const res = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Id-Team': 'default',
        'X-Id-Admin': '1',
      },
      body: JSON.stringify({
        name: 'manager',
        type: 'interactive',
        endpoint: 'http://127.0.0.1:4999',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('reserved command word');
  });

  it('keeps manager out of roster read surfaces after inbox traffic', async () => {
    const talkRes = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Id-Team': 'default',
        'X-Id-Admin': '1',
      },
      body: JSON.stringify({ message: 'hello manager', from: 'tester' }),
    });
    expect(talkRes.status).toBe(202);

    const agentsRes = await fetch(`${baseUrl}/agents`, {
      headers: {
        'X-Id-Team': 'default',
        'X-Id-Admin': '1',
      },
    });
    expect(agentsRes.ok).toBe(true);
    const agentsBody = await agentsRes.json() as { agents: Array<{ name: string }> };
    expect(agentsBody.agents.some((a) => a.name === 'manager')).toBe(false);

    const byNameRes = await fetch(`${baseUrl}/agents/by-name/manager`, {
      headers: {
        'X-Id-Team': 'default',
        'X-Id-Admin': '1',
      },
    });
    expect(byNameRes.status).toBe(404);

    const resolveRes = await fetch(`${baseUrl}/agents/resolve/manager`, {
      headers: {
        'X-Id-Team': 'default',
        'X-Id-Admin': '1',
      },
    });
    expect(resolveRes.status).toBe(404);
  });

  it('/teams, /agents/status, manager inbox + respond work without manager-* shadow agent rows', async () => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Id-Team': 'default',
      'X-Id-Admin': '1',
    };

    const talkRes = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'shadow migration smoke', from: 'tester' }),
    });
    expect(talkRes.status).toBe(202);
    const { query_id: queryId } = await talkRes.json() as { query_id: string };

    const teamsRes = await fetch(`${baseUrl}/teams`, { headers: { 'X-Id-Admin': '1' } });
    expect(teamsRes.ok).toBe(true);
    const teamsBody = await teamsRes.json() as { teams: Array<{ name: string }> };
    expect(teamsBody.teams.some((t) => t.name === 'default')).toBe(true);

    const agentStatusRes = await fetch(`${baseUrl}/agents/status`, { headers });
    expect(agentStatusRes.ok).toBe(true);

    const pendingRes = await fetch(`${baseUrl}/manager/inbox/pending`, { headers });
    expect(pendingRes.ok).toBe(true);
    const pendingBody = await pendingRes.json() as {
      inbox_id: string;
      pending: Array<{ query_id: string }>;
    };
    expect(pendingBody.inbox_id).toBe('manager-default');
    expect(pendingBody.pending.some((p) => p.query_id === queryId)).toBe(true);

    const respondRes = await fetch(`${baseUrl}/manager/inbox/respond`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query_id: queryId, message: 'ack', session_id: 'sess_shadow_smoke' }),
    });
    expect(respondRes.ok).toBe(true);

    const shadowCount = await db.adapter.query<{ c: number }>(
      `SELECT COUNT(*) as c FROM agents WHERE id GLOB 'manager-*'`,
    );
    expect(Number(shadowCount.rows[0]?.c)).toBe(0);

    const mgrByName = await db.adapter.query<{ c: number }>(
      `SELECT COUNT(*) as c FROM agents WHERE name = 'manager' AND deleted_at IS NULL`,
    );
    expect(Number(mgrByName.rows[0]?.c)).toBe(0);
  });
});
