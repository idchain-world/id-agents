// SPDX-License-Identifier: MIT
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { heartbeatToSchedule, heartbeatScheduleId } from '../../src/scheduling/schedule-config.js';

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
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

async function withManager(
  run: (ctx: {
    baseUrl: string;
    db: Awaited<ReturnType<typeof createInMemoryDb>>;
  }) => Promise<void>,
): Promise<void> {
  const db = await createInMemoryDb();
  const managerPort = await findFreePort();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-command-'));
  const manager = new AgentManagerDb(workDir, db as any);
  await manager.start(managerPort);

  try {
    await run({ baseUrl: `http://127.0.0.1:${managerPort}`, db });
  } finally {
    await manager.shutdown();
    await db.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function postRemote(baseUrl: string, team: string, command: string): Promise<any> {
  const res = await fetch(`${baseUrl}/remote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Id-Team': team,
      'X-Id-Admin': '1',
    },
    body: JSON.stringify({ command }),
  });
  expect(res.ok).toBe(true);
  return await res.json();
}

describe('/remote heartbeat commands', () => {
  afterAll(() => {
    // Explicit no-op so this suite mirrors other manager integration files.
  });

  it('sets metadata.heartbeat false and PAUSES the schedule when disabling an agent heartbeat', async () => {
    await withManager(async ({ baseUrl, db }) => {
      const teamName = `heartbeat-disable-${Date.now()}`;
      const teamId = await db.teams.getOrCreateTeamId(teamName);
      const agentId = `agent-${randomUUID()}`;
      const now = Math.floor(Date.now() / 1000);

      await db.agents.create({
        team_id: teamId,
        id: agentId,
        name: 'worker',
        type: 'claude',
        model: 'sonnet',
        status: 'running',
        created_at: now,
        port: 0,
        runtime: 'claude-agent-sdk',
        metadata: { heartbeat: true, retained: 'value' },
      });
      const { definition, agentIds } = heartbeatToSchedule(agentId, 'worker', 86400, now);
      await db.schedules.upsertDefinition(definition);
      await db.schedules.replaceTargets(definition.id, agentIds);

      expect((await db.agents.getById(agentId))?.metadata?.heartbeat).toBe(true);
      expect(await db.schedules.listSchedulesForAgent(agentId)).toHaveLength(1);

      const body = await postRemote(baseUrl, teamName, '/heartbeat disable worker');

      expect(body).toEqual({
        ok: true,
        result: { message: 'Heartbeat disabled for worker' },
      });
      expect((await db.agents.getById(agentId))?.metadata).toMatchObject({
        heartbeat: false,
        retained: 'value',
      });
      // `listSchedulesForAgent` filters to ACTIVE rows, so length 0 here is
      // satisfied by a pause just as much as by a delete — it cannot tell the
      // two apart. The row itself is what matters, so assert on it directly.
      expect(await db.schedules.listSchedulesForAgent(agentId)).toHaveLength(0);

      const paused = await db.schedules.getDefinition(heartbeatScheduleId(agentId));
      expect(paused).not.toBeNull();
      expect(paused?.active).toBe(false);
      // Prem's report: the row must STAY in the Heartbeats view with a gray dot.
      // That view is fed by `listAllDefinitions`, which includes inactive rows.
      const listed = await db.schedules.listAllDefinitions();
      expect(listed.map((d) => d.id)).toContain(heartbeatScheduleId(agentId));
      // The user's configured cadence survives the disable.
      expect(paused?.interval_seconds).toBe(86400);
    });
  });

  it('resumes the SAME schedule on enable after disable, preserving the interval', async () => {
    await withManager(async ({ baseUrl, db }) => {
      const teamName = `heartbeat-resume-${Date.now()}`;
      const teamId = await db.teams.getOrCreateTeamId(teamName);
      const agentId = `agent-${randomUUID()}`;
      const now = Math.floor(Date.now() / 1000);

      await db.agents.create({
        team_id: teamId,
        id: agentId,
        name: 'worker',
        type: 'claude',
        model: 'sonnet',
        status: 'running',
        created_at: now,
        port: 0,
        runtime: 'claude-agent-sdk',
        metadata: { heartbeat: true },
        // Deliberately no working_directory and no HEARTBEAT.md: a resume must
        // not depend on the file, which is the failure this fix removes.
      });
      // A user-configured cadence that a re-seed from file would destroy.
      const { definition, agentIds } = heartbeatToSchedule(agentId, 'worker', 3600, now);
      await db.schedules.upsertDefinition(definition);
      await db.schedules.replaceTargets(definition.id, agentIds);

      await postRemote(baseUrl, teamName, '/heartbeat disable worker');
      await postRemote(baseUrl, teamName, '/heartbeat enable worker');

      const resumed = await db.schedules.getDefinition(heartbeatScheduleId(agentId));
      expect(resumed?.active).toBe(true);
      expect(resumed?.interval_seconds).toBe(3600); // not re-derived from a file
      expect((await db.agents.getById(agentId))?.metadata?.heartbeat).toBe(true);
      // Exactly one heartbeat schedule — resumed, not re-created alongside.
      const hbDefs = (await db.schedules.listAllDefinitions()).filter((d) => d.kind === 'heartbeat');
      expect(hbDefs).toHaveLength(1);
    });
  });

  it('says a heartbeat is DISABLED, not missing, when firing at a paused schedule', async () => {
    await withManager(async ({ baseUrl, db }) => {
      const teamName = `heartbeat-fire-msg-${Date.now()}`;
      const teamId = await db.teams.getOrCreateTeamId(teamName);
      const agentId = `agent-${randomUUID()}`;
      const now = Math.floor(Date.now() / 1000);

      await db.agents.create({
        team_id: teamId,
        id: agentId,
        name: 'worker',
        type: 'claude',
        model: 'sonnet',
        status: 'running',
        created_at: now,
        // A port is required only to clear the earlier "no endpoint" guard; the
        // schedule check returns before anything is dispatched to it.
        port: 59999,
        runtime: 'claude-agent-sdk',
        metadata: { heartbeat: true },
      });
      const { definition, agentIds } = heartbeatToSchedule(agentId, 'worker', 3600, now);
      await db.schedules.upsertDefinition(definition);
      await db.schedules.replaceTargets(definition.id, agentIds);

      await postRemote(baseUrl, teamName, '/heartbeat disable worker');
      const body = await postRemote(baseUrl, teamName, '/heartbeat fire worker');

      // Still refused without --force; only the wording changed. Saying "has no
      // heartbeat schedule" would now be false — the row exists, it is paused.
      expect(body.ok).toBe(false);
      expect(body.error).toContain('disabled heartbeat schedule');
      expect(body.error).not.toContain('has no heartbeat schedule');
    });
  });

  it('still seeds a schedule on enable when the agent has none yet', async () => {
    await withManager(async ({ baseUrl, db }) => {
      const teamName = `heartbeat-seed-${Date.now()}`;
      const teamId = await db.teams.getOrCreateTeamId(teamName);
      const agentId = `agent-${randomUUID()}`;
      const now = Math.floor(Date.now() / 1000);
      const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-seed-'));
      fs.writeFileSync(path.join(workdir, 'HEARTBEAT.md'), '# beat\n');

      await db.agents.create({
        team_id: teamId,
        id: agentId,
        name: 'worker',
        type: 'claude',
        model: 'sonnet',
        status: 'running',
        created_at: now,
        port: 0,
        runtime: 'claude-agent-sdk',
        working_directory: workdir,
        metadata: {},
      });
      expect(await db.schedules.getDefinition(heartbeatScheduleId(agentId))).toBeNull();

      const body = await postRemote(baseUrl, teamName, '/heartbeat enable worker');
      expect(body.ok).toBe(true);

      const seeded = await db.schedules.getDefinition(heartbeatScheduleId(agentId));
      expect(seeded).not.toBeNull();
      expect(seeded?.active).toBe(true);
      expect((await db.agents.getById(agentId))?.metadata?.heartbeat).toBe(true);
    });
  });
});
