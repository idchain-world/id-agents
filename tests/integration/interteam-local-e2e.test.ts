// SPDX-License-Identifier: MIT
/**
 * Commit 10 — two teams on one manager exchange messages end to end.
 *
 * Gate: no V1 caller dials a worker URL (every network request in this file
 * targets the manager base URL, asserted with a fetch spy), and after a
 * manager restart collection reconstructs status and every retained result or
 * failure from durable state alone — no worker memory involved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { InterteamMessageStore } from '../../src/inter-team/message-store.js';
import { InterTeamCli } from '../../src/cli/interteam-commands.js';

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

function createDb(filePath: string) {
  const adapter = new SqliteAdapter(filePath);
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

let workDir: string;
let dbPath: string;
let db: ReturnType<typeof createDb>;
let manager: AgentManagerDb;
let port: number;
let baseUrl: string;
let originTeamId: string;
let destTeamId: string;
let leadId: string;
let workerId: string;
let originAgentId: string;
let originPeerAgentId: string;
const requestedUrls: string[] = [];
const dispatchedWork: string[] = [];

// Process-wide recorder: EVERY fetch in this process during the suite is
// observed — including any the manager makes internally — so the no-worker-
// dial gate cannot be satisfied by only instrumenting the test's own calls.
const realFetch = globalThis.fetch;
function spyFetch(url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  requestedUrls.push(String(url));
  return realFetch(url, init);
}
globalThis.fetch = spyFetch as typeof fetch;

function adminHeaders(team: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Admin': '1', 'X-Id-Team': team };
}

async function addAgent(teamId: string, name: string, status = 'running'): Promise<string> {
  const id = `agent-${randomUUID()}`;
  await db.adapter.query(
    `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
     VALUES (?, ?, ?, 'claude', 'model', 0, ?, ?, '{}', 'codex')`,
    [id, teamId, name, status, Date.now()],
  );
  return id;
}

async function completeLinkedQuery(messageId: string, result: unknown): Promise<void> {
  const link = (await db.adapter.query<{ local_team_id: string; local_query_id: string }>(
    `SELECT p.local_team_id, p.local_query_id
     FROM interteam_processing p JOIN interteam_messages m ON m.id = p.message_pk
     WHERE m.message_id = ?`,
    [messageId],
  )).rows[0]!;
  await db.adapter.query(
    `UPDATE queries SET status = 'completed', completed = ?, result = ? WHERE team_id = ? AND query_id = ?`,
    [Date.now(), JSON.stringify(result), link.local_team_id, link.local_query_id],
  );
}

async function scanTick(): Promise<void> {
  const resp = await spyFetch(`${baseUrl}/inter-team/scan`, {
    method: 'POST',
    headers: adminHeaders('origin-team'),
  });
  expect(resp.status).toBe(200);
}

async function startManager(): Promise<void> {
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  db = createDb(dbPath);
  await migrateSqlite(db.adapter as any);
  manager = new AgentManagerDb(workDir, db as any, {
    interteamBounds: { maxNonTerminalPerTeam: 6 },
    // Fixture agents have no runtime listening, so real /talk delivery is
    // stubbed here. The production wiring is covered by its own test; what
    // this file proves is the protocol path around it.
    interteamDispatchFn: async (input) => { dispatchedWork.push(input.handlerAgentId); },
  });
  await manager.start(port);
}

async function stopManager(): Promise<void> {
  await new Promise<void>((resolve) => {
    (manager as any).interteamTimer && clearInterval((manager as any).interteamTimer);
    (manager as any).httpServer?.close(() => resolve());
    setTimeout(resolve, 1000);
  });
  await db.close();
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interteam-e2e-'));
  dbPath = path.join(workDir, 'e2e.db');
  await startManager();

  originTeamId = await db.teams.getOrCreateTeamId('origin-team');
  destTeamId = await db.teams.getOrCreateTeamId('dest-team');
  originAgentId = await addAgent(originTeamId, 'origin-caller');
  originPeerAgentId = await addAgent(originTeamId, 'origin-peer');
  leadId = await addAgent(destTeamId, 'dest-lead');
  workerId = await addAgent(destTeamId, 'dest-worker');

  // Operator configuration through the commit-6 surface: open the destination,
  // assign its lead, and give the origin team a contact pinned to the local
  // node and the destination team's immutable ID.
  const nodeId = (await db.adapter.query<{ node_id: string }>(
    `SELECT node_id FROM manager_identity`,
  )).rows[0]!.node_id;
  let resp = await spyFetch(`${baseUrl}/inter-team/config/policy`, {
    method: 'PUT', headers: adminHeaders('dest-team'), body: JSON.stringify({ policy: 'open' }),
  });
  expect(resp.status).toBe(200);
  resp = await spyFetch(`${baseUrl}/inter-team/config/lead`, {
    method: 'PUT', headers: adminHeaders('dest-team'), body: JSON.stringify({ agentId: leadId }),
  });
  expect(resp.status).toBe(200);
  resp = await spyFetch(`${baseUrl}/inter-team/config/contacts`, {
    method: 'POST',
    headers: adminHeaders('origin-team'),
    body: JSON.stringify({ aliasDisplay: 'partners', remoteNodeId: nodeId, remoteTeamId: destTeamId }),
  });
  expect(resp.status).toBe(201);
  // A broken pin: alias resolves, but its remote team no longer exists.
  resp = await spyFetch(`${baseUrl}/inter-team/config/contacts`, {
    method: 'POST',
    headers: adminHeaders('origin-team'),
    body: JSON.stringify({ aliasDisplay: 'ghosts', remoteNodeId: nodeId, remoteTeamId: randomUUID() }),
  });
  expect(resp.status).toBe(201);
}, 30000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await stopManager();
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('two teams on one manager', () => {
  let cli: InterTeamCli;
  let teamConversation: string;
  let teamMessage: string;

  it('sends to all three destination variants and pins direct recipients', async () => {
    cli = new InterTeamCli({
      managerUrl: baseUrl,
      team: 'origin-team',
      agentId: originAgentId,
      fetchImpl: spyFetch as typeof fetch,
    });

    const teamSend = await cli.send({ address: 'team:partners', body: { ask: 'team-work' } });
    expect(teamSend.state).toBe('accepted');
    teamConversation = teamSend.conversationId;
    teamMessage = teamSend.messageId;

    const byName = await cli.send({ address: 'team:partners/dest-worker', body: { ask: 'named' } });
    expect(byName.state).toBe('accepted');
    const byId = await cli.send({ address: 'team:partners', agentId: workerId, body: { ask: 'by-id' } });
    expect(byId.state).toBe('accepted');

    const pins = (await db.adapter.query<{ recipient_kind: string; resolved_agent_id: string | null }>(
      `SELECT recipient_kind, resolved_agent_id FROM interteam_messages`,
    )).rows;
    expect(pins.find((p) => p.recipient_kind === 'team')!.resolved_agent_id).toBeNull();
    expect(pins.filter((p) => p.recipient_kind !== 'team').every((p) => p.resolved_agent_id === workerId)).toBe(true);
  });

  it('lists only the caller team conversations and exposes no bulk payloads', async () => {
    const listed = await cli.listConversations();
    const conversations = listed.conversations as Array<Record<string, any>>;
    expect(conversations).toHaveLength(3);
    expect(conversations.map((row) => row.conversationId)).toContain(teamConversation);
    expect(conversations.find((row) => row.conversationId === teamConversation)?.latestMessage.sender)
      .toEqual({ agentId: originAgentId, nameAtSend: 'origin-caller' });
    expect(conversations.every((row) => row.destination.alias === 'partners')).toBe(true);
    expect(conversations.filter((row) => row.destination.kind !== 'team')
      .every((row) => row.destination.pinnedAgentId === workerId)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('team-work');
    expect(JSON.stringify(listed)).not.toContain('named');

    const outstanding = await cli.listConversations('outstanding');
    expect((outstanding.conversations as unknown[]).length).toBe(3);
    const terminal = await cli.listConversations('terminal');
    expect(terminal.conversations).toEqual([]);

    const nonOwner = new InterTeamCli({
      managerUrl: baseUrl,
      team: 'dest-team',
      agentId: workerId,
      fetchImpl: spyFetch as typeof fetch,
    });
    await expect(nonOwner.listConversations())
      .resolves.toEqual({ conversations: [] });

    const invalid = await spyFetch(`${baseUrl}/inter-team/conversations?state=completed`, {
      headers: { ...adminHeaders('origin-team'), 'X-Id-Agent': originAgentId },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'invalid_conversation_state_filter' });
  });

  it('collects accepted, processing, completed in order, non-consuming across repeated reads', async () => {
    // The post-send scan dispatched the team message to the lead already;
    // its linked job is pending, so the state is processing.
    await scanTick();
    // Attribution is not collection authority: another agent in the same
    // origin team can collect the first agent's message.
    const peer = new InterTeamCli({
      managerUrl: baseUrl,
      team: 'origin-team',
      agentId: originPeerAgentId,
      fetchImpl: spyFetch as typeof fetch,
    });
    let collected = await peer.collect(teamConversation, teamMessage);
    expect(collected.state).toBe('processing');
    expect(collected).not.toHaveProperty('sender');

    await completeLinkedQuery(teamMessage, { report: 'done' });
    await scanTick();
    for (let read = 0; read < 3; read++) {
      collected = await peer.collect(teamConversation, teamMessage);
      expect(collected).toMatchObject({
        state: 'completed',
        retention: 'retained',
        result: { report: 'done' },
        resultPresent: true,
      });
    }
  });

  it('lists null sender attribution for an admin-principal send', async () => {
    const admin = new InterTeamCli({
      managerUrl: baseUrl,
      team: 'origin-team',
      fetchImpl: spyFetch as typeof fetch,
    });
    const sent = await admin.send({ address: 'team:partners/dest-worker', body: { ask: 'admin-send' } });
    const listed = await admin.listConversations();
    expect(listed.conversations.find((row) => row.conversationId === sent.conversationId)
      ?.latestMessage.sender).toBeNull();
    expect(await admin.collect(sent.conversationId, sent.messageId)).not.toHaveProperty('sender');
    await new InterteamMessageStore(db.adapter).recordFailed({
      submitterNodeId: (await db.adapter.query<{ node_id: string }>(
        `SELECT node_id FROM manager_identity`,
      )).rows[0]!.node_id,
      messageId: sent.messageId,
      failureCode: 'test_cleanup',
    });
  });

  it('rejects a non-participant read identically to an unknown conversation', async () => {
    const intruder = new InterTeamCli({
      managerUrl: baseUrl,
      team: 'dest-team',
      agentId: workerId,
      fetchImpl: spyFetch as typeof fetch,
    });
    await expect(intruder.collect(teamConversation, teamMessage)).rejects.toThrow('conversation_not_found');
    await expect(cli.collect(`conv-${randomUUID()}`, teamMessage)).rejects.toThrow('conversation_not_found');
  });

  it('continues the ordered request stream and dedups a lost-response resubmission', async () => {
    const next = await cli.continueConversation(teamConversation, { ask: 'follow-up' });
    expect(next.state).toBe('accepted');

    // The lost-response path: a send whose 202 never arrived. The origin
    // rebuilds the SAME envelope — same IDs, same timestamp, same body —
    // and resubmits. That must deduplicate, never accept a second time.
    const original = await spyFetch(`${baseUrl}/inter-team/send`, {
      method: 'POST',
      headers: { ...adminHeaders('origin-team'), 'X-Id-Agent': originAgentId },
      body: JSON.stringify({ address: 'team:partners/dest-worker', body: { ask: 'lost-response' } }),
    });
    expect(original.status).toBe(202);
    const first = await original.json() as {
      conversationId: string; messageId: string; firstSubmittedAt: number; deduplicated: boolean;
    };
    expect(first.deduplicated).toBe(false);

    const resubmit = await spyFetch(`${baseUrl}/inter-team/resubmit`, {
      method: 'POST',
      headers: { ...adminHeaders('origin-team'), 'X-Id-Agent': originAgentId },
      body: JSON.stringify({
        address: 'team:partners/dest-worker',
        body: { ask: 'lost-response' },
        conversationId: first.conversationId,
        messageId: first.messageId,
        firstSubmittedAt: first.firstSubmittedAt,
      }),
    });
    expect(resubmit.status).toBe(202);
    const replay = await resubmit.json() as { messageId: string; deduplicated: boolean };
    expect(replay.deduplicated).toBe(true);
    expect(replay.messageId).toBe(first.messageId);

    const rows = (await db.adapter.query<{ message_id: string }>(
      `SELECT message_id FROM interteam_messages WHERE message_id = ?`,
      [first.messageId],
    )).rows;
    expect(rows).toHaveLength(1);

    // A changed body under the same IDs is a conflict, not a new acceptance.
    const changed = await spyFetch(`${baseUrl}/inter-team/resubmit`, {
      method: 'POST',
      headers: { ...adminHeaders('origin-team'), 'X-Id-Agent': originAgentId },
      body: JSON.stringify({
        address: 'team:partners/dest-worker',
        body: { ask: 'tampered' },
        conversationId: first.conversationId,
        messageId: first.messageId,
        firstSubmittedAt: first.firstSubmittedAt,
      }),
    });
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as any).error).toBe('idempotency_conflict');

    // Past the 30-day horizon the origin refuses locally.
    const stale = await spyFetch(`${baseUrl}/inter-team/resubmit`, {
      method: 'POST',
      headers: { ...adminHeaders('origin-team'), 'X-Id-Agent': originAgentId },
      body: JSON.stringify({
        address: 'team:partners/dest-worker',
        body: { ask: 'lost-response' },
        conversationId: first.conversationId,
        messageId: first.messageId,
        firstSubmittedAt: first.firstSubmittedAt - 31 * 24 * 60 * 60 * 1000,
      }),
    });
    expect(stale.status).toBe(400);
    expect(((await stale.json()) as any).error).toBe('resubmission_horizon_exceeded');
  });

  it('keeps team work waiting through lead deletion and lets a new lead pick it up', async () => {
    // First message dispatches to the current lead; the follow-up queues
    // behind it in the serial stream, so it is still `accepted` when the
    // lead is deleted — exactly the work the next lead must pick up.
    const head = await cli.send({ address: 'team:partners', body: { ask: 'head' } });
    const pending = await cli.continueConversation(head.conversationId, { ask: 'for-next-lead' });
    await db.adapter.query(`UPDATE agents SET deleted_at = ? WHERE id = ?`, [Date.now(), leadId]);
    await completeLinkedQuery(head.messageId, 'head-done');
    await scanTick();
    let state = await cli.collect(pending.conversationId, pending.messageId);
    expect(state.state).toBe('accepted');

    const newLead = await addAgent(destTeamId, 'succession-lead');
    const assign = await spyFetch(`${baseUrl}/inter-team/config/lead`, {
      method: 'PUT', headers: adminHeaders('dest-team'), body: JSON.stringify({ agentId: newLead }),
    });
    expect(assign.status).toBe(200);
    await scanTick();
    state = await cli.collect(pending.conversationId, pending.messageId);
    expect(state.state).toBe('processing');
    await completeLinkedQuery(pending.messageId, null);
    await scanTick();
    state = await cli.collect(pending.conversationId, pending.messageId);
    expect(state).toMatchObject({ state: 'completed', result: null, resultPresent: true });
  });

  it('fails a broken pin without leaking and bounds capacity without dropping accepted work', async () => {
    await expect(cli.send({ address: 'team:ghosts', body: {} })).rejects.toThrow('target_identity_missing');

    const acceptedBefore = (await db.adapter.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM interteam_messages WHERE status IN ('accepted','processing','unknown')`,
    )).rows[0]!;
    let busySeen = false;
    for (let i = 0; i < 8; i++) {
      try {
        await cli.send({ address: 'team:partners/dest-worker', body: { flood: i } });
      } catch (error) {
        expect((error as Error).message).toBe('receiver_busy');
        busySeen = true;
        break;
      }
    }
    expect(busySeen).toBe(true);
    const nonTerminal = (await db.adapter.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM interteam_messages WHERE status IN ('accepted','processing','unknown')`,
    )).rows[0]!;
    expect(Number(nonTerminal.n)).toBeGreaterThanOrEqual(Number(acceptedBefore.n));
  });

  it('serves descriptor and roster for open and closed teams alike, catalog labeled non-authoritative', async () => {
    const openRoster = await cli.roster('partners');
    expect(openRoster.inboundPolicy).toBe('open');
    const agents = openRoster.agents as Array<Record<string, unknown>>;
    expect(agents.every((agent) => agent.catalogAuthority === 'agent_asserted')).toBe(true);
    expect(agents.some((agent) => 'port' in agent || 'endpoint' in agent || 'url' in agent)).toBe(false);

    const close = await spyFetch(`${baseUrl}/inter-team/config/policy`, {
      method: 'PUT', headers: adminHeaders('dest-team'), body: JSON.stringify({ policy: 'closed' }),
    });
    expect(close.status).toBe(200);
    const closedRoster = await cli.roster('partners');
    expect(closedRoster.inboundPolicy).toBe('closed');
    expect((closedRoster.agents as unknown[]).length).toBeGreaterThan(0);

    await expect(cli.send({ address: 'team:partners', body: { ask: 'refused' } }))
      .rejects.toThrow('target_closed');
    const reopen = await spyFetch(`${baseUrl}/inter-team/config/policy`, {
      method: 'PUT', headers: adminHeaders('dest-team'), body: JSON.stringify({ policy: 'open' }),
    });
    expect(reopen.status).toBe(200);
  });

  it('reconstructs every state from durable rows after a manager restart', async () => {
    const before = await cli.collect(teamConversation, teamMessage);
    await stopManager();
    await startManager();

    const revived = new InterTeamCli({
      managerUrl: baseUrl,
      team: 'origin-team',
      agentId: originAgentId,
      fetchImpl: spyFetch as typeof fetch,
    });
    const after = await revived.collect(teamConversation, teamMessage);
    expect(after).toEqual(before);
    cli = revived;
  });

  it('force-deletes an owner with work outstanding while history survives', async () => {
    const doomedTeam = await db.teams.getOrCreateTeamId('doomed-team');
    const doomedLead = await addAgent(doomedTeam, 'doomed-lead');
    await spyFetch(`${baseUrl}/inter-team/config/policy`, {
      method: 'PUT', headers: adminHeaders('doomed-team'), body: JSON.stringify({ policy: 'open' }),
    });
    await spyFetch(`${baseUrl}/inter-team/config/lead`, {
      method: 'PUT', headers: adminHeaders('doomed-team'), body: JSON.stringify({ agentId: doomedLead }),
    });
    const nodeId = (await db.adapter.query<{ node_id: string }>(
      `SELECT node_id FROM manager_identity`,
    )).rows[0]!.node_id;
    await spyFetch(`${baseUrl}/inter-team/config/contacts`, {
      method: 'POST',
      headers: adminHeaders('origin-team'),
      body: JSON.stringify({ aliasDisplay: 'doomed', remoteNodeId: nodeId, remoteTeamId: doomedTeam }),
    });

    const outstanding = await cli.send({ address: 'team:doomed', body: { ask: 'never-answered' } });

    // A normal delete is blocked while work is outstanding (the commit-5
    // trigger); the operator route resolves the work failed and deletes.
    await expect(db.adapter.query(`DELETE FROM teams WHERE id = ?`, [doomedTeam]))
      .rejects.toThrow(/interteam_team_has_active_work/);
    const force = await spyFetch(`${baseUrl}/inter-team/config/team?force=true`, {
      method: 'DELETE',
      headers: adminHeaders('doomed-team'),
    });
    expect(force.status).toBe(200);
    expect(await force.json()).toMatchObject({
      deleted: true,
      failureCode: 'owner_force_deleted',
      outstandingResolvedFailed: 1,
    });

    const row = (await db.adapter.query<{ status: string; failure_code: string }>(
      `SELECT status, failure_code FROM interteam_messages WHERE message_id = ?`,
      [outstanding.messageId],
    )).rows[0]!;
    expect(row).toMatchObject({ status: 'failed', failure_code: 'owner_force_deleted' });
    // Collection against the deleted owner fails and is never retargeted.
    await expect(cli.collect(outstanding.conversationId, outstanding.messageId))
      .rejects.toThrow('conversation_not_found');
  });

  it('collects a failed message with its stable failure code', async () => {
    // Drain the capacity-test backlog so the per-team bound admits new work.
    const store = new InterteamMessageStore(db.adapter);
    const backlog = (await db.adapter.query<{ submitter_node_id: string; message_id: string; status: string }>(
      `SELECT submitter_node_id, message_id, status FROM interteam_messages
       WHERE status IN ('accepted', 'processing', 'unknown')`,
    )).rows;
    for (const row of backlog) {
      if (row.status === 'processing') await completeLinkedQuery(row.message_id, 'drained');
    }
    await scanTick();
    for (const row of backlog) {
      const current = (await db.adapter.query<{ status: string }>(
        `SELECT status FROM interteam_messages WHERE message_id = ?`, [row.message_id],
      )).rows[0]!;
      if (current.status === 'accepted') {
        await store.recordFailed({
          submitterNodeId: row.submitter_node_id,
          messageId: row.message_id,
          failureCode: 'handler_failed',
        });
      }
    }

    const doomedAgent = await addAgent(destTeamId, 'short-lived');
    const send = await cli.send({ address: 'team:partners/short-lived', body: { ask: 'doomed' } });
    await db.adapter.query(`UPDATE agents SET deleted_at = ? WHERE id = ?`, [Date.now(), doomedAgent]);
    await scanTick();
    const collected = await cli.collect(send.conversationId, send.messageId);
    expect(collected).toMatchObject({
      state: 'failed',
      retention: 'retained',
      failureCode: 'recipient_deleted',
      failureDetailPresent: true,
    });
  });

  it('gate: no caller dialed anything but the manager base URL', () => {
    expect(requestedUrls.length).toBeGreaterThan(20);
    expect(requestedUrls.every((url) => /^http:\/\/127\.0\.0\.1:\d+\/(inter-team|health)/.test(url))).toBe(true);
  });
});
