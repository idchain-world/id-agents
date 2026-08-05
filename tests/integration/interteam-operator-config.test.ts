// SPDX-License-Identifier: MIT
/**
 * Commit 6 — trusted local source context and operator configuration.
 *
 * Gate under test (design "Commit 6"): ordinary flows preserve source-team
 * context; the same alias is safe in two teams; no local token/capability
 * exists to leak or be mistaken for tenant isolation. Operator writes reuse
 * the existing direct-loopback admin assertion plus an explicit team
 * selection; request bodies may agree with the derived team but never
 * replace it; every mutation appends its audit event in the same
 * transaction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { LOCAL_TRUST_BOUNDARY_NOTICE } from '../../src/inter-team/local-context.js';

async function createDb() {
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
    async close() { await adapter.close(); },
  };
}

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

let port: number;
let baseUrl: string;
let workDir: string;
let manager: AgentManagerDb;
let db: Awaited<ReturnType<typeof createDb>>;
let alphaId: string;
let betaId: string;

function adminHeaders(team?: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Admin': '1',
    ...(team ? { 'X-Id-Team': team } : {}),
    ...extra,
  };
}

async function auditRows(teamId: string): Promise<Array<{ actor_agent_id: string | null; data: string }>> {
  const result = await db.adapter.query<{ actor_agent_id: string | null; data: string }>(
    `SELECT actor_agent_id, data FROM event_log
     WHERE team_id = ? AND topic = 'interteam:operator_config' ORDER BY seq`,
    [teamId],
  );
  return result.rows;
}

function createAgent(teamId: string, id: string, name: string, status: string) {
  return db.agents.create({
    team_id: teamId,
    id,
    name,
    type: 'virtual',
    model: 'external',
    port: 0,
    endpoint: 'http://127.0.0.1:19998',
    working_directory: null,
    status,
    created_at: Date.now(),
    metadata: {},
    runtime: 'claude-code',
  });
}

beforeAll(async () => {
  port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interteam-config-'));
  baseUrl = `http://127.0.0.1:${port}`;

  db = await createDb();
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(port);

  // 'default' must exist so the no-header case tests the explicit-context
  // rule rather than falling through to team resolution.
  await db.teams.getOrCreateTeamId('default');
  alphaId = await db.teams.getOrCreateTeamId('alpha');
  betaId = await db.teams.getOrCreateTeamId('beta');
  await createAgent(alphaId, 'agent_alpha_lead', 'lead-a', 'stopped');
  await createAgent(alphaId, 'agent_alpha_worker', 'worker-a', 'running');
  await createAgent(betaId, 'agent_beta_worker', 'worker-b', 'running');
}, 30000);

afterAll(async () => {
  if (manager) {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 1000);
    });
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('operator context', () => {
  it('rejects a non-admin caller with operator_context_required', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config`, {
      headers: { 'X-Id-Team': 'alpha' },
    });
    expect(resp.status).toBe(403);
    expect(((await resp.json()) as any).error).toBe('operator_context_required');
  });

  it('requires explicit team context even for an admin', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config`, {
      headers: adminHeaders(),
    });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as any).error).toBe('explicit_team_context_required');
  });

  it('never creates a team as a side effect of a typo', async () => {
    const before = (await db.teams.listTeams()).length;
    const resp = await fetch(`${baseUrl}/inter-team/config`, {
      headers: adminHeaders('no-such-team'),
    });
    expect(resp.status).toBe(404);
    expect(((await resp.json()) as any).error).toBe('team_not_found');
    expect((await db.teams.listTeams()).length).toBe(before);
  });

  it('rejects an actor header that resolves in a different team', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config`, {
      headers: adminHeaders('alpha', { 'X-Id-Agent': 'agent_beta_worker' }),
    });
    expect(resp.status).toBe(403);
    expect(((await resp.json()) as any).error).toBe('agent_team_mismatch');
  });

  it('reads team-scoped state with no token or capability in the response', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config`, {
      headers: adminHeaders('alpha'),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.settings.teamId).toBe(alphaId);
    expect(body.settings.inboundPolicy).toBe('closed');
    expect(body.lead.degradedReason).toBe('unassigned');
    expect(body.contacts).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/token|secret|credential|api[_-]?key/i);
  });

  it('documents the single-host trust boundary, including same-UID forgery', () => {
    expect(LOCAL_TRUST_BOUNDARY_NOTICE).toMatch(/same-UID worker can forge another team/);
    expect(LOCAL_TRUST_BOUNDARY_NOTICE).toMatch(/reverse proxy changes the admin boundary/);
  });
});

describe('contacts', () => {
  let alphaContactId: string;
  let betaContactId: string;

  it('rejects a body that asserts a different team than the derived context', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config/contacts`, {
      method: 'POST',
      headers: adminHeaders('alpha'),
      body: JSON.stringify({
        team: betaId,
        aliasDisplay: 'Partners',
        remoteNodeId: 'node-1',
        remoteTeamId: 'team-1',
      }),
    });
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as any).error).toBe('source_context_mismatch');
    const list = await fetch(`${baseUrl}/inter-team/config/contacts`, { headers: adminHeaders('alpha') });
    expect(((await list.json()) as any).contacts).toEqual([]);
  });

  it('creates a contact and appends its audit event', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config/contacts`, {
      method: 'POST',
      headers: adminHeaders('alpha'),
      body: JSON.stringify({ aliasDisplay: 'Partners', remoteNodeId: 'node-1', remoteTeamId: 'team-1' }),
    });
    expect(resp.status).toBe(201);
    const body = await resp.json() as any;
    alphaContactId = body.contact.id;
    expect(body.contact.aliasNormalized).toBe('partners');
    expect(body.audit.action).toBe('contact_created');
    const rows = await auditRows(alphaId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.data).action).toBe('contact_created');
  });

  it('refuses a same-team alias collision on the normalized form', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config/contacts`, {
      method: 'POST',
      headers: adminHeaders('alpha'),
      body: JSON.stringify({ aliasDisplay: '  PARTNERS ', remoteNodeId: 'node-2', remoteTeamId: 'team-2' }),
    });
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as any).error).toBe('contact_alias_conflict');
  });

  it('allows the same alias in a second team', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config/contacts`, {
      method: 'POST',
      headers: adminHeaders('beta'),
      body: JSON.stringify({ aliasDisplay: 'Partners', remoteNodeId: 'node-9', remoteTeamId: 'team-9' }),
    });
    expect(resp.status).toBe(201);
    betaContactId = ((await resp.json()) as any).contact.id;
    expect(betaContactId).not.toBe(alphaContactId);
  });

  it('fails a cross-owner contact ID as source_unauthorized, not contact_not_found', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config/contacts/${betaContactId}`, {
      method: 'PATCH',
      headers: adminHeaders('alpha'),
      body: JSON.stringify({ aliasDisplay: 'Stolen' }),
    });
    expect(resp.status).toBe(403);
    expect(((await resp.json()) as any).error).toBe('source_unauthorized');
  });

  it('refuses any change to the immutable remote pin', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config/contacts/${alphaContactId}`, {
      method: 'PATCH',
      headers: adminHeaders('alpha'),
      body: JSON.stringify({ aliasDisplay: 'Partners', remoteNodeId: 'evil-node' }),
    });
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as any).error).toBe('contact_pin_immutable');
  });

  it('renames both alias forms and audits the rename with the acting agent', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config/contacts/${alphaContactId}`, {
      method: 'PATCH',
      headers: adminHeaders('alpha', { 'X-Id-Agent': 'agent_alpha_worker' }),
      body: JSON.stringify({ aliasDisplay: 'Field  Partners' }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.contact.aliasDisplay).toBe('Field  Partners');
    expect(body.contact.aliasNormalized).toBe('field partners');
    expect(body.contact.remoteNodeId).toBe('node-1');
    const rows = await auditRows(alphaId);
    const rename = rows.find((row) => JSON.parse(row.data).action === 'contact_renamed');
    expect(rename?.actor_agent_id).toBe('agent_alpha_worker');
  });

  it('deletes only through the owning team and audits the removal', async () => {
    const wrongTeam = await fetch(`${baseUrl}/inter-team/config/contacts/${alphaContactId}`, {
      method: 'DELETE',
      headers: adminHeaders('beta'),
    });
    expect(wrongTeam.status).toBe(403);
    expect(((await wrongTeam.json()) as any).error).toBe('source_unauthorized');

    const resp = await fetch(`${baseUrl}/inter-team/config/contacts/${alphaContactId}`, {
      method: 'DELETE',
      headers: adminHeaders('alpha'),
    });
    expect(resp.status).toBe(200);
    const rows = await auditRows(alphaId);
    const deletion = rows.find((row) => JSON.parse(row.data).action === 'contact_deleted');
    expect(JSON.parse(deletion!.data).remoteNodeId).toBe('node-1');
  });
});

describe('team settings', () => {
  it('assigns a stopped lead and reports degraded availability', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config/lead`, {
      method: 'PUT',
      headers: adminHeaders('alpha'),
      body: JSON.stringify({ agentId: 'agent_alpha_lead' }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.settings.leadAgentId).toBe('agent_alpha_lead');
    expect(body.lead.available).toBe(false);
    expect(body.lead.degradedReason).toBe('recipient_unavailable');
  });

  it('opens inbound policy without any availability precondition', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config/policy`, {
      method: 'PUT',
      headers: adminHeaders('alpha'),
      body: JSON.stringify({ policy: 'open' }),
    });
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as any).settings.inboundPolicy).toBe('open');
  });

  it('rejects a cross-team lead assignment', async () => {
    const resp = await fetch(`${baseUrl}/inter-team/config/lead`, {
      method: 'PUT',
      headers: adminHeaders('alpha'),
      body: JSON.stringify({ agentId: 'agent_beta_worker' }),
    });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as any).error).toBe('team_lead_invalid');
  });
});

describe('normalized org replacement', () => {
  it('replaces the org atomically and enumerates removals on the next replacement', async () => {
    const first = await fetch(`${baseUrl}/inter-team/config/org`, {
      method: 'PUT',
      headers: adminHeaders('alpha'),
      body: JSON.stringify({
        org: {
          groups: { eng: { lead: 'lead-a', members: ['worker-a'] } },
          tags: { research: ['worker-a'] },
        },
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as any;
    expect(firstBody.state.status).toBe('normalized');
    expect(firstBody.removal.removedGroups).toEqual([]);

    const second = await fetch(`${baseUrl}/inter-team/config/org`, {
      method: 'PUT',
      headers: adminHeaders('alpha'),
      body: JSON.stringify({ org: { groups: {}, tags: {} }, reason: 'clear for test' }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as any;
    expect(secondBody.removal.removedGroups).toEqual(['eng']);
    expect(secondBody.removal.removedMembershipAssignments).toBe(1);
    expect(secondBody.removal.removedTagAssignments).toBe(1);
    const rows = await auditRows(alphaId);
    const replacements = rows.filter((row) => JSON.parse(row.data).action === 'normalized_org_replaced');
    expect(replacements).toHaveLength(2);
    expect(JSON.parse(replacements[1]!.data).removedGroups).toEqual(['eng']);
  });

  it('rolls back the replacement and its audit together on an unresolved reference', async () => {
    const before = await auditRows(alphaId);
    const orgBefore = await fetch(`${baseUrl}/inter-team/config/org`, { headers: adminHeaders('alpha') });
    const orgBeforeBody = await orgBefore.json() as any;

    const resp = await fetch(`${baseUrl}/inter-team/config/org`, {
      method: 'PUT',
      headers: adminHeaders('alpha'),
      body: JSON.stringify({ org: { groups: { ops: { members: ['ghost'] } } } }),
    });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as any).error).toBe('org_reference_unresolved');

    const after = await auditRows(alphaId);
    expect(after).toHaveLength(before.length);
    const orgAfter = await fetch(`${baseUrl}/inter-team/config/org`, { headers: adminHeaders('alpha') });
    expect(await orgAfter.json()).toEqual(orgBeforeBody);
  });
});
