// SPDX-License-Identifier: MIT
/**
 * Item 3: the index tells the truth about how fresh a status is.
 *
 * A local conversation is read from the database that owns it, so its status is
 * current. A remote one is only as fresh as the last collection, and until this
 * commit it did not appear in the index at all, because the index reads
 * destination rows and a remote destination has none here.
 *
 * The gate: remote conversations appear and are labelled observed with their
 * timestamp; a local one is never labelled stale; the index dials no peer; and
 * refresh performs exactly one collection for exactly one conversation.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DbAdapter } from '../../src/db/db-adapter.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { InterTeamAcceptanceService } from '../../src/inter-team/acceptance-service.js';
import { InterTeamOriginClient } from '../../src/inter-team/origin-client.js';
import { InterTeamProcessor } from '../../src/inter-team/processor.js';
import { InterteamFoundationStore } from '../../src/inter-team/foundation-store.js';
import { PeerRouteStore } from '../../src/inter-team/peer-routes.js';
import { createFederationApp } from '../../src/inter-team/federation-app.js';
import { HttpFederationTransport } from '../../src/inter-team/federation-client.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function q<T = unknown>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function node(name: string, dialled: string[] = []) {
  const db = new SqliteAdapter(':memory:');
  await migrateSqlite(db);
  closers.push(() => db.close());
  const nodeId = (await q<{ node_id: string }>(db, `SELECT node_id FROM manager_identity`))[0]!.node_id;
  const teamId = randomUUID();
  const agentId = `agent-${randomUUID()}`;
  await q(db, `INSERT INTO teams (id, name, inbound_policy) VALUES (?, ?, 'open')`, [teamId, `${name}-${randomUUID()}`]);
  await q(
    db,
    `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
     VALUES (?, ?, ?, 'claude', 'model', 0, 'running', ?, '{}', 'codex')`,
    [agentId, teamId, `${name}-worker`, Date.now()],
  );
  await q(db, `UPDATE teams SET lead_agent_id = ? WHERE id = ?`, [agentId, teamId]);
  const acceptance = new InterTeamAcceptanceService(db);
  const app = createFederationApp(db, acceptance);
  const server: Server = await new Promise((resolve) => {
    const created = createServer(app);
    created.listen(0, '127.0.0.1', () => resolve(created));
  });
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The transport captures its fetch when it is constructed, so a spy swapped
  // in later would never be seen. Injecting it is the only honest way to count.
  const origin = new InterTeamOriginClient(db, acceptance, {
    transport: new HttpFederationTransport(db, {
      timeoutMs: 5000,
      fetchImpl: ((url: any, init?: any) => { dialled.push(String(url)); return fetch(url, init); }) as typeof fetch,
    }),
  });
  return { db, nodeId, teamId, agentId, url, origin, acceptance, dialled };
}

describe('observed versus current status', () => {
  it('shows a remote conversation, labelled observed, and a local one as current', async () => {
    const a = await node('alpha');
    const b = await node('beta');
    await new PeerRouteStore(a.db).upsert({ nodeId: b.nodeId, baseUrl: b.url, localNodeId: a.nodeId });
    await new InterteamFoundationStore(a.db).createContact({
      localTeamId: a.teamId, aliasDisplay: 'beta', remoteNodeId: b.nodeId, remoteTeamId: b.teamId,
    });
    // A local conversation on the same node, so the index holds both kinds.
    await new InterteamFoundationStore(a.db).createContact({
      localTeamId: a.teamId, aliasDisplay: 'self', remoteNodeId: a.nodeId, remoteTeamId: a.teamId,
    });
    const context = { localTeamId: a.teamId, principal: 'agent-header' as const, agentId: null };

    const local = await a.origin.send({
      context, alias: 'self', destination: { kind: 'agent_id', agentId: a.agentId }, body: 'local',
    });
    const remote = await a.origin.send({
      context, alias: 'beta', destination: { kind: 'agent_id', agentId: b.agentId }, body: 'remote',
    });
    expect(local.ok && remote.ok).toBe(true);
    if (!local.ok || !remote.ok) return;

    const listed = await a.origin.listConversations({ context });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const localRow = listed.value.conversations.find((c) => c.conversationId === local.conversationId);
    const remoteRow = listed.value.conversations.find((c) => c.conversationId === remote.conversationId);

    // Before this commit the remote row was simply absent from the index.
    expect(remoteRow).toBeDefined();
    expect(remoteRow).toMatchObject({ origin: 'remote', destination: { nodeId: b.nodeId, alias: 'beta' } });
    expect(localRow).toMatchObject({ origin: 'local', observedAt: null });
  });

  it('never dials a peer while listing, however stale a remote row is', async () => {
    const a = await node('alpha');
    const b = await node('beta');
    await new PeerRouteStore(a.db).upsert({ nodeId: b.nodeId, baseUrl: b.url, localNodeId: a.nodeId });
    await new InterteamFoundationStore(a.db).createContact({
      localTeamId: a.teamId, aliasDisplay: 'beta', remoteNodeId: b.nodeId, remoteTeamId: b.teamId,
    });
    const context = { localTeamId: a.teamId, principal: 'agent-header' as const, agentId: null };
    await a.origin.send({
      context, alias: 'beta', destination: { kind: 'agent_id', agentId: b.agentId }, body: 'remote',
    });

    const before = a.dialled.length;
    const listed = await a.origin.listConversations({ context });
    expect(listed.ok).toBe(true);
    // One unreachable peer must not be able to stall the whole list.
    expect(a.dialled.length).toBe(before);
  });

  it('refresh collects exactly one conversation and records when it was observed', async () => {
    const a = await node('alpha');
    const b = await node('beta');
    await new PeerRouteStore(a.db).upsert({ nodeId: b.nodeId, baseUrl: b.url, localNodeId: a.nodeId });
    await new InterteamFoundationStore(a.db).createContact({
      localTeamId: a.teamId, aliasDisplay: 'beta', remoteNodeId: b.nodeId, remoteTeamId: b.teamId,
    });
    const context = { localTeamId: a.teamId, principal: 'agent-header' as const, agentId: null };

    const first = await a.origin.send({
      context, alias: 'beta', destination: { kind: 'agent_id', agentId: b.agentId }, body: 'one',
    });
    const second = await a.origin.send({
      context, alias: 'beta', destination: { kind: 'agent_id', agentId: b.agentId }, body: 'two',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    await new InterTeamProcessor(b.db, { dispatchFn: async () => {} }).scan();

    const before = a.dialled.length;
    const refreshed = await a.origin.refreshConversation({ context, conversationId: first.conversationId });
    const dialled = a.dialled.slice(before);

    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.state).toBe('processing');
    expect(refreshed.observedAt).toBeGreaterThan(0);
    // Exactly one collection, for exactly the conversation asked for.
    expect(dialled).toHaveLength(1);
    expect(dialled[0]).toContain(encodeURIComponent(first.conversationId));
    expect(dialled[0]).not.toContain(encodeURIComponent(second.conversationId));

    // The observed timestamp now shows in the index.
    const listed = await a.origin.listConversations({ context });
    const row = listed.ok && listed.value.conversations.find((c) => c.conversationId === first.conversationId);
    expect(row && row.origin).toBe('remote');
    expect(row && typeof row.observedAt).toBe('number');
  });

  it('refuses to refresh a conversation another local team owns', async () => {
    const a = await node('alpha');
    const b = await node('beta');
    await new PeerRouteStore(a.db).upsert({ nodeId: b.nodeId, baseUrl: b.url, localNodeId: a.nodeId });
    await new InterteamFoundationStore(a.db).createContact({
      localTeamId: a.teamId, aliasDisplay: 'beta', remoteNodeId: b.nodeId, remoteTeamId: b.teamId,
    });
    const context = { localTeamId: a.teamId, principal: 'agent-header' as const, agentId: null };
    const sent = await a.origin.send({
      context, alias: 'beta', destination: { kind: 'agent_id', agentId: b.agentId }, body: 'mine',
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    const otherTeam = randomUUID();
    await q(a.db, `INSERT INTO teams (id, name) VALUES (?, ?)`, [otherTeam, `other-${randomUUID()}`]);
    const refused = await a.origin.refreshConversation({
      context: { localTeamId: otherTeam, principal: 'agent-header', agentId: null },
      conversationId: sent.conversationId,
    });
    expect(refused).toEqual({ ok: false, code: 'conversation_not_found' });
  });
});
