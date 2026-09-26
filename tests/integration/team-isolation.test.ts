// SPDX-License-Identifier: MIT
/**
 * Team Isolation Integration Tests — Phase 1
 *
 * Proves that team boundaries are enforced in the manager:
 *   - idchain cannot see public agents (list, get by id, get by name)
 *   - idchain cannot claim or mark done tasks belonging to public
 *   - same task name can coexist in two teams
 *   - admin principal can operate across teams with explicit ?team=
 *   - non-admin cannot create tasks in another team
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
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
import type { AgentRow, TaskRow } from '../../src/db/types.js';

// --- DB factory helper (in-memory) ---
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
    // POST /tasks/:ref/done auto-closes linked checkins; the route needs the repo.
    checkins: new SqliteCheckinsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

// --- Port helper ---
async function findFreePort(): Promise<number> {
  const { createServer } = await import('net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

// --- Test helpers ---
function makeHeaders(team: string, extra?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    ...extra,
  };
}

function adminHeaders(team: string): Record<string, string> {
  return makeHeaders(team, { 'X-Id-Admin': '1' });
}

// --- Test state ---
let port: number;
let manager: AgentManagerDb;
let baseUrl: string;
let workDir: string;

// IDs set during beforeAll
let idchainTeamId: string;
let publicTeamId: string;
let idchainAgentId: string;
let publicAgentId: string;
let idchainAgentName: string;
let publicAgentName: string;

beforeAll(async () => {
  port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-isolation-test-'));
  baseUrl = `http://127.0.0.1:${port}`;

  const db = await createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);

  // Start manager — this seeds default/idchain/public teams
  await manager.start(port);

  // Resolve team IDs
  idchainTeamId = await db.teams.getOrCreateTeamId('idchain');
  publicTeamId = await db.teams.getOrCreateTeamId('public');

  // Register one agent in each team
  idchainAgentName = `idchain-agent-${Date.now()}`;
  publicAgentName = `public-agent-${Date.now()}`;

  idchainAgentId = `agent-${randomUUID()}`;
  publicAgentId = `agent-${randomUUID()}`;

  const now = Math.floor(Date.now() / 1000);

  await db.agents.create({
    team_id: idchainTeamId,
    id: idchainAgentId,
    name: idchainAgentName,
    type: 'claude',
    model: 'sonnet',
    status: 'running',
    created_at: now,
    port: 4101,
    runtime: 'claude-agent-sdk',
  });

  await db.agents.create({
    team_id: publicTeamId,
    id: publicAgentId,
    name: publicAgentName,
    type: 'claude',
    model: 'sonnet',
    status: 'running',
    created_at: now,
    port: 4102,
    runtime: 'claude-agent-sdk',
  });
}, 30000);

afterAll(async () => {
  if (manager) {
    // Stop the manager's HTTP server
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 1000);
    });
  }
  // Clean up temp workdir
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// =====================================================================
// Agent list isolation
// =====================================================================

describe('GET /agents — team-scoped list', () => {
  it('idchain sees only idchain agents', async () => {
    const res = await fetch(`${baseUrl}/agents`, { headers: makeHeaders('idchain') });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    const ids = body.agents.map((a: any) => a.id);
    expect(ids).toContain(idchainAgentId);
    expect(ids).not.toContain(publicAgentId);
  });

  it('public sees only public agents', async () => {
    const res = await fetch(`${baseUrl}/agents`, { headers: makeHeaders('public') });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    const ids = body.agents.map((a: any) => a.id);
    expect(ids).toContain(publicAgentId);
    expect(ids).not.toContain(idchainAgentId);
  });
});

// =====================================================================
// GET /agents/:id isolation
// =====================================================================

describe('GET /agents/:id — team-enforced lookup', () => {
  it('idchain principal gets 404 for public agent id', async () => {
    const res = await fetch(`${baseUrl}/agents/${publicAgentId}`, {
      headers: makeHeaders('idchain'),
    });
    expect(res.status).toBe(404);
  });

  it('idchain principal can get idchain agent by id', async () => {
    const res = await fetch(`${baseUrl}/agents/${idchainAgentId}`, {
      headers: makeHeaders('idchain'),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.id).toEqual(idchainAgentId);
  });
});

// =====================================================================
// GET /agents/by-name/:name isolation
// =====================================================================

describe('GET /agents/by-name/:name — team-enforced', () => {
  it('idchain cannot find public agent by name', async () => {
    const res = await fetch(`${baseUrl}/agents/by-name/${publicAgentName}`, {
      headers: makeHeaders('idchain'),
    });
    expect(res.status).toBe(404);
  });

  it('idchain can find idchain agent by name', async () => {
    const res = await fetch(`${baseUrl}/agents/by-name/${idchainAgentName}`, {
      headers: makeHeaders('idchain'),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.id ?? body.agent?.id).toBeTruthy();
  });
});

// =====================================================================
// Reserved-identity rename bypass guard
// =====================================================================

describe('Agent rename — reserved-name guard', () => {
  it('PATCH /agents/:id/metadata rejects rename to reserved "manager"', async () => {
    const res = await fetch(`${baseUrl}/agents/${idchainAgentId}/metadata`, {
      method: 'PATCH',
      headers: makeHeaders('idchain'),
      body: JSON.stringify({ name: 'manager' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/manager/);
    expect(body.error).toMatch(/reserved command/);
  });

  it('/remote /update --name rejects rename to reserved "manager"', async () => {
    const res = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: makeHeaders('idchain'),
      body: JSON.stringify({ command: `/update ${idchainAgentName} --name manager` }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/manager/);
    expect(body.error).toMatch(/reserved command/);
  });

  it('PATCH /agents/:id/metadata persists a valid rename', async () => {
    const newValidName = `idchain-renamed-${Date.now()}`;
    const res = await fetch(`${baseUrl}/agents/${idchainAgentId}/metadata`, {
      method: 'PATCH',
      headers: makeHeaders('idchain'),
      body: JSON.stringify({ name: newValidName }),
    });
    expect(res.ok).toBe(true);

    const lookup = await fetch(`${baseUrl}/agents/by-name/${newValidName}`, {
      headers: makeHeaders('idchain'),
    });
    expect(lookup.ok).toBe(true);
    const lookupBody = await lookup.json() as any;
    expect(lookupBody.id ?? lookupBody.agent?.id).toEqual(idchainAgentId);

    // Restore original name so downstream tests using idchainAgentName still resolve
    const restore = await fetch(`${baseUrl}/agents/${idchainAgentId}/metadata`, {
      method: 'PATCH',
      headers: makeHeaders('idchain'),
      body: JSON.stringify({ name: idchainAgentName }),
    });
    expect(restore.ok).toBe(true);
  });

  it('/remote /update --name persists a valid rename', async () => {
    const newValidName = `public-renamed-${Date.now()}`;
    const res = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: makeHeaders('public'),
      body: JSON.stringify({ command: `/update ${publicAgentName} --name ${newValidName}` }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);

    const lookup = await fetch(`${baseUrl}/agents/by-name/${newValidName}`, {
      headers: makeHeaders('public'),
    });
    expect(lookup.ok).toBe(true);

    const restore = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: makeHeaders('public'),
      body: JSON.stringify({ command: `/update ${newValidName} --name ${publicAgentName}` }),
    });
    expect(restore.ok).toBe(true);
  });

  it('PATCH /agents/:id/metadata wallet-only update is unaffected', async () => {
    const wallet = '0x000000000000000000000000000000000000dEaD';
    const res = await fetch(`${baseUrl}/agents/${idchainAgentId}/metadata`, {
      method: 'PATCH',
      headers: makeHeaders('idchain'),
      body: JSON.stringify({ wallet }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
  });
});

// =====================================================================
// POST /tasks — cross-team creation guard
// =====================================================================

describe('POST /tasks — cross-team creation guard', () => {
  it('non-admin cannot create a task in another team', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: makeHeaders('idchain'),
      body: JSON.stringify({ title: 'cross-team-task', team: 'public' }),
    });
    expect(res.status).toBe(403);
  });

  it('admin principal CAN create a task in another team explicitly', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('idchain'),
      body: JSON.stringify({ title: 'admin-cross-team-task', name: `admin-cross-task-${Date.now()}`, team: 'public' }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
  });
});

// =====================================================================
// Task same-name coexistence in different teams
// =====================================================================

describe('Tasks — (team_id, name) scoped resolution', () => {
  const sharedTaskName = `shared-task-${Date.now()}`;

  it('same task name can coexist in idchain and public teams', async () => {
    // Create in idchain (admin to ensure team exists)
    const r1 = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('idchain'),
      body: JSON.stringify({ title: 'Shared Task', name: sharedTaskName }),
    });
    expect(r1.ok).toBe(true);

    // Create same name in public
    const r2 = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({ title: 'Shared Task', name: sharedTaskName }),
    });
    expect(r2.ok).toBe(true);
  });

  it('GET /tasks/:name returns idchain task when called as idchain', async () => {
    const res = await fetch(`${baseUrl}/tasks/${sharedTaskName}`, {
      headers: makeHeaders('idchain'),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    // team name in response should be idchain
    expect(body.task.teamName).toEqual('idchain');
  });

  it('GET /tasks/:name returns public task when called as public', async () => {
    const res = await fetch(`${baseUrl}/tasks/${sharedTaskName}`, {
      headers: makeHeaders('public'),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.task.teamName).toEqual('public');
  });
});

// =====================================================================
// Task claim cross-team guard
// =====================================================================

describe('POST /tasks/:name/claim — cross-team guard', () => {
  const publicOnlyTask = `public-only-task-${Date.now()}`;

  it('setup: create a task in public team', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({ title: 'Public Only Task', name: publicOnlyTask }),
    });
    expect(res.ok).toBe(true);
  });

  it('idchain principal cannot claim a public team task', async () => {
    const res = await fetch(`${baseUrl}/tasks/${publicOnlyTask}/claim`, {
      method: 'POST',
      headers: makeHeaders('idchain'),
      body: JSON.stringify({ agent_id: idchainAgentId }),
    });
    // Should be 404 (task not found in idchain team)
    expect(res.status).toBe(404);
  });

  it('explicit team header still bounds a cross-team claim attempt', async () => {
    // Even if the caller names a public-team agent, the explicit
    // idchain header pins the lookup — no cross-team escalation.
    const res = await fetch(`${baseUrl}/tasks/${publicOnlyTask}/claim`, {
      method: 'POST',
      headers: makeHeaders('idchain'),
      body: JSON.stringify({ agent_id: publicAgentName }),
    });
    expect(res.status).toBe(404);
  });

  it('caller without team header claims a task in its own team', async () => {
    // Mirrors the deployed-agent case: agent in a non-default team issues
    // `POST $MANAGER_URL/tasks/<name>/claim { agent_id }` without a team
    // header. The manager should resolve the caller globally and use its
    // team for the task lookup.
    const ownTeamTask = `public-own-team-${Date.now()}`;
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({ title: 'Own Team Task', name: ownTeamTask }),
    });
    expect(createRes.ok).toBe(true);

    const res = await fetch(`${baseUrl}/tasks/${ownTeamTask}/claim`, {
      method: 'POST',
      // No X-Id-Team header
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: publicAgentName }),
    });
    expect(res.ok, `claim failed: ${await res.clone().text()}`).toBe(true);
    const body = await res.json() as any;
    expect(body.task.status).toBe('doing');
  });
});

// =====================================================================
// GET /tasks — defaults to current team
// =====================================================================

describe('GET /tasks — defaults to current team', () => {
  it('GET /tasks without team param returns only current team tasks', async () => {
    const uniqueTaskName = `idchain-unique-${Date.now()}`;
    // Create a unique task in idchain
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('idchain'),
      body: JSON.stringify({ title: 'Idchain Unique Task', name: uniqueTaskName }),
    });
    const createBody = await createRes.json().catch(() => ({}));
    expect(createRes.ok, `POST /tasks failed: ${JSON.stringify(createBody)}`).toBe(true);

    // List idchain tasks — should see idchain task
    // Use admin headers here since non-admin needs the team to already exist
    const idchainRes = await fetch(`${baseUrl}/tasks`, {
      headers: adminHeaders('idchain'),
    });
    const idchainBody = await idchainRes.json().catch(() => ({})) as any;
    expect(idchainRes.ok, `GET /tasks failed: ${JSON.stringify(idchainBody)}`).toBe(true);
    const idchainNames = idchainBody.tasks.map((t: any) => t.name);
    expect(idchainNames).toContain(uniqueTaskName);

    // List public tasks — should NOT see idchain task
    const publicRes = await fetch(`${baseUrl}/tasks`, {
      headers: makeHeaders('public'),
    });
    expect(publicRes.ok).toBe(true);
    const publicBody = await publicRes.json() as any;
    const publicNames = publicBody.tasks.map((t: any) => t.name);
    expect(publicNames).not.toContain(uniqueTaskName);
  });
});

// =====================================================================
// Admin can operate across teams
// =====================================================================

describe('Admin principal — cross-team access', () => {
  it('admin can GET agents in public team with X-Id-Team: public', async () => {
    const res = await fetch(`${baseUrl}/agents`, {
      headers: adminHeaders('public'),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    const ids = body.agents.map((a: any) => a.id);
    expect(ids).toContain(publicAgentId);
  });
});

// =====================================================================
// Non-existent team handling (non-admin)
// =====================================================================

describe('Non-existent team — non-admin gets 404', () => {
  it('non-admin request to nonexistent team returns 404 team_not_found', async () => {
    const res = await fetch(`${baseUrl}/agents`, {
      headers: makeHeaders('nonexistent-team-xyz'),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toEqual('team_not_found');
  });

  it('admin request to nonexistent team creates it and returns agents', async () => {
    const newTeam = `new-team-${Date.now()}`;
    const res = await fetch(`${baseUrl}/agents`, {
      headers: adminHeaders(newTeam),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.agents).toEqual([]);
  });
});

// =====================================================================
// Task lifecycle by name and uuid when the caller's alias spans teams
// =====================================================================
//
// Regression for the newtrade incident (2026-09-26): `seniordev` exists in
// three teams, so a header-less `POST /tasks { from }` could not recover the
// caller's team and silently filed the task in `default`; devlead's
// `/tasks/<name>/claim` and `/tasks/<uuid>/claim` then 404'd in newtrade.

describe('task lifecycle — shared alias across teams, name and uuid refs', () => {
  const sharedName = `shared-agent-${Date.now()}`;
  const noTeamHeaders = { 'Content-Type': 'application/json' };
  let publicTaskName: string;
  let publicTaskUuid: string;

  beforeAll(async () => {
    // Same alias registered in both teams — the ambiguous case.
    const db = (manager as any).db;
    const now = Math.floor(Date.now() / 1000);
    for (const teamId of [idchainTeamId, publicTeamId]) {
      await db.agents.create({
        team_id: teamId,
        id: `agent-${randomUUID()}`,
        name: sharedName,
        type: 'claude',
        model: 'sonnet',
        status: 'running',
        created_at: now,
        port: 4103,
        runtime: 'claude-agent-sdk',
      });
    }
  });

  it('POST /tasks with an ambiguous `from` and no team header is refused, not filed in default', async () => {
    const name = `ambiguous-create-${Date.now()}`;
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: noTeamHeaders,
      body: JSON.stringify({ title: 'Ambiguous', name, from: sharedName }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('X-Id-Team');
    expect(body.error).toContain('idchain');
    expect(body.error).toContain('public');

    const listed = await fetch(`${baseUrl}/tasks`, { headers: adminHeaders('default') });
    const names = ((await listed.json()) as any).tasks.map((t: any) => t.name);
    expect(names).not.toContain(name);
  });

  it('POST /tasks with the team header creates the task in that team', async () => {
    publicTaskName = `shared-public-${Date.now()}`;
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: makeHeaders('public'),
      body: JSON.stringify({ title: 'Shared alias task', name: publicTaskName, from: sharedName }),
    });
    expect(res.ok, await res.clone().text()).toBe(true);
    const body = await res.json() as any;
    expect(body.task.teamName).toBe('public');
    expect(body.task.uuid).toMatch(/^[0-9a-f-]{36}$/);
    publicTaskUuid = body.task.uuid;
  });

  it('GET /tasks/<uuid> resolves a full uuid within the team', async () => {
    const res = await fetch(`${baseUrl}/tasks/${publicTaskUuid}`, { headers: makeHeaders('public') });
    expect(res.ok, await res.clone().text()).toBe(true);
    expect(((await res.json()) as any).task.name).toBe(publicTaskName);

    const other = await fetch(`${baseUrl}/tasks/${publicTaskUuid}`, { headers: makeHeaders('idchain') });
    expect(other.status).toBe(404);
  });

  it('claim by name without a team header: the ambiguous alias is settled by the task\'s team', async () => {
    const res = await fetch(`${baseUrl}/tasks/${publicTaskName}/claim`, {
      method: 'POST',
      headers: noTeamHeaders,
      body: JSON.stringify({ agent_id: sharedName }),
    });
    expect(res.ok, await res.clone().text()).toBe(true);
    const body = await res.json() as any;
    expect(body.task.status).toBe('doing');
    expect(body.task.teamName).toBe('public');
    expect(body.task.ownerName).toBe(sharedName);
  });

  it('done by full uuid without a team header', async () => {
    const res = await fetch(`${baseUrl}/tasks/${publicTaskUuid}/done`, {
      method: 'POST',
      headers: noTeamHeaders,
      body: JSON.stringify({ agent_id: sharedName }),
    });
    expect(res.ok, await res.clone().text()).toBe(true);
    expect(((await res.json()) as any).task.status).toBe('done');
  });

  it('claim by uuid with the team header', async () => {
    const create = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: makeHeaders('idchain'),
      body: JSON.stringify({ title: 'Uuid claim', from: sharedName }),
    });
    expect(create.ok, await create.clone().text()).toBe(true);
    const { task } = (await create.json()) as any;

    const res = await fetch(`${baseUrl}/tasks/${task.uuid}/claim`, {
      method: 'POST',
      headers: makeHeaders('idchain'),
      body: JSON.stringify({ agent_id: sharedName }),
    });
    expect(res.ok, await res.clone().text()).toBe(true);
    const body = await res.json() as any;
    expect(body.task.status).toBe('doing');
    expect(body.task.teamName).toBe('idchain');
  });

  it('ambiguous alias with a task in neither team gets a pointer to X-Id-Team, not a default-team miss', async () => {
    const res = await fetch(`${baseUrl}/tasks/no-such-task-${Date.now()}/claim`, {
      method: 'POST',
      headers: noTeamHeaders,
      body: JSON.stringify({ agent_id: sharedName }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toContain('X-Id-Team');
  });
});
