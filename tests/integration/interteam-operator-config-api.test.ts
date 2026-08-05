// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
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

describe('inter-team operator configuration API', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let teamA: { id: string; name: string };
  let teamB: { id: string; name: string };
  let stoppedAgentId: string;

  beforeAll(async () => {
    db = await createInMemoryDb();
    teamA = { id: await db.teams.getOrCreateTeamId('config-a'), name: 'config-a' };
    teamB = { id: await db.teams.getOrCreateTeamId('config-b'), name: 'config-b' };
    stoppedAgentId = `agent-${randomUUID()}`;
    await db.agents.create({
      id: stoppedAgentId,
      team_id: teamA.id,
      name: 'stopped-lead',
      type: 'claude',
      model: 'model',
      port: 0,
      status: 'stopped',
      created_at: 1,
      runtime: 'codex',
    });
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interteam-config-api-'));
    manager = new AgentManagerDb(workDir, db as any);
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    await manager.start(port);
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
    await db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  async function request(
    method: string,
    route: string,
    input: { team?: string; admin?: boolean; agentId?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (input.team) headers['X-Id-Team'] = input.team;
    if (input.admin) headers['X-Id-Admin'] = '1';
    if (input.agentId) headers['X-Id-Agent'] = input.agentId;
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    return { status: response.status, body: await response.json() };
  }

  it('requires direct-loopback admin and an explicit existing team context', async () => {
    await expect(request('GET', '/inter-team/config', { team: teamA.name }))
      .resolves.toMatchObject({ status: 403, body: { error: 'operator_context_required' } });
    await expect(request('GET', '/inter-team/config', { admin: true }))
      .resolves.toMatchObject({ status: 400, body: { error: 'explicit_team_context_required' } });
    await expect(request('GET', '/inter-team/config', { admin: true, team: 'config-typo' }))
      .resolves.toMatchObject({ status: 404, body: { error: 'team_not_found' } });
    expect(await db.teams.getTeamByName('config-typo')).toBeNull();
  });

  it('cannot take contact ownership from the body or a cross-team contact ID', async () => {
    const mismatch = await request('POST', '/inter-team/config/contacts', {
      admin: true,
      team: teamA.name,
      body: {
        localTeamId: teamB.id,
        aliasDisplay: 'Partner',
        remoteNodeId: 'node-a',
        remoteTeamId: 'remote-a',
      },
    });
    expect(mismatch).toMatchObject({ status: 409, body: { error: 'source_context_mismatch' } });

    const createdA = await request('POST', '/inter-team/config/contacts', {
      admin: true,
      team: teamA.name,
      agentId: stoppedAgentId,
      body: { aliasDisplay: 'Partner', remoteNodeId: 'node-a', remoteTeamId: 'remote-a' },
    });
    expect(createdA.status).toBe(201);
    const createdB = await request('POST', '/inter-team/config/contacts', {
      admin: true,
      team: teamB.name,
      body: { aliasDisplay: 'Partner', remoteNodeId: 'node-b', remoteTeamId: 'remote-b' },
    });
    expect(createdB.status).toBe(201);
    expect(createdA.body.contact.aliasNormalized).toBe(createdB.body.contact.aliasNormalized);

    const crossOwner = await request('PATCH', `/inter-team/config/contacts/${createdA.body.contact.id}`, {
      admin: true,
      team: teamB.name,
      body: { aliasDisplay: 'Wrong owner' },
    });
    expect(crossOwner).toMatchObject({ status: 403, body: { error: 'source_unauthorized' } });
  });

  it('allows stopped lead assignment and open policy and audits the asserted actor', async () => {
    const lead = await request('PUT', '/inter-team/config/lead', {
      admin: true,
      team: teamA.name,
      agentId: stoppedAgentId,
      body: { agentId: stoppedAgentId },
    });
    expect(lead).toMatchObject({
      status: 200,
      body: { lead: { status: 'stopped', available: false, degradedReason: 'recipient_unavailable' } },
    });
    const policy = await request('PUT', '/inter-team/config/policy', {
      admin: true,
      team: teamA.name,
      agentId: stoppedAgentId,
      body: { policy: 'open' },
    });
    expect(policy).toMatchObject({ status: 200, body: { settings: { inboundPolicy: 'open' } } });
    const events = await db.events.query({ teamId: teamA.id, topics: ['interteam:operator_config'] });
    expect(events.at(-1)).toMatchObject({ actor_agent_id: stoppedAgentId });
  });

  it('returns and audits explicit removal facts for full normalized-org replacement', async () => {
    await request('PUT', '/inter-team/config/org', {
      admin: true,
      team: teamA.name,
      body: {
        org: {
          groups: { Root: { groups: { Retired: { members: ['stopped-lead'] } } } },
          tags: { OldTag: ['stopped-lead'] },
        },
      },
    });
    const replacement = await request('PUT', '/inter-team/config/org', {
      admin: true,
      team: teamA.name,
      body: { org: { groups: { Root: {} } }, reason: 'remove retired branch' },
    });
    expect(replacement).toMatchObject({
      status: 200,
      body: {
        removal: {
          removedGroups: ['Root/Retired'],
          removedMembershipAssignments: 1,
          removedTagAssignments: 1,
        },
        audit: { action: 'normalized_org_replaced' },
      },
    });
    expect(JSON.stringify(replacement.body)).not.toMatch(/token|secret|capability/i);
  });
});
