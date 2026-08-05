// SPDX-License-Identifier: MIT
/**
 * Commit 15: the federation contract across two managers.
 *
 * Two nodes with distinct databases, node IDs, team IDs, and work roots talk
 * over a real federation HTTP surface bound to an ephemeral loopback port. No
 * configured federation bind exists yet; that is commit 16.
 *
 * The gate proven here: a send, continuation, processing result, repeated
 * collection, and roster read all cross the boundary; a lost `202` followed by
 * an identical resubmission creates one destination message and reports
 * deduplicated; a lost continuation is recovered before the next position is
 * allocated; unauthorized and unknown collection are identical; policy-closed
 * roster reads still work; a route aimed at the wrong manager returns
 * `peer_node_mismatch` and changes no pin; and the destination opens zero
 * outbound connections.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { DbAdapter } from '../../src/db/db-adapter.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { InterTeamAcceptanceService } from '../../src/inter-team/acceptance-service.js';
import { InterTeamOriginClient } from '../../src/inter-team/origin-client.js';
import { InterTeamProcessor } from '../../src/inter-team/processor.js';
import { InterteamFoundationStore } from '../../src/inter-team/foundation-store.js';
import { InterTeamOutboundStore } from '../../src/inter-team/outbound-store.js';
import { PeerRouteStore } from '../../src/inter-team/peer-routes.js';
import { createFederationApp } from '../../src/inter-team/federation-app.js';
import { HttpFederationTransport } from '../../src/inter-team/federation-client.js';

interface Node {
  db: DbAdapter;
  nodeId: string;
  acceptance: InterTeamAcceptanceService;
  origin: InterTeamOriginClient;
  processor: InterTeamProcessor;
  server: Server;
  baseUrl: string;
  teamId: string;
  agentId: string;
  workRoot: string;
}

let root: string;
let alpha: Node;
let beta: Node;
/** Every outbound connection this process makes, so the pull-only rule is observable. */
const outboundCalls: string[] = [];
const realFetch = globalThis.fetch;
let failNextSubmit: 'drop-response' | null = null;

async function q<T = unknown>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function startNode(name: string, options: { policy: 'open' | 'closed' }): Promise<Node> {
  const workRoot = path.join(root, name);
  fs.mkdirSync(workRoot, { recursive: true });
  const db = new SqliteAdapter(path.join(workRoot, `${name}.db`));
  await migrateSqlite(db);
  const nodeId = (await q<{ node_id: string }>(db, `SELECT node_id FROM manager_identity`))[0]!.node_id;

  const teamId = randomUUID();
  const agentId = `agent-${randomUUID()}`;
  await q(db, `INSERT INTO teams (id, name, inbound_policy) VALUES (?, ?, ?)`,
    [teamId, `${name}-team-${randomUUID()}`, options.policy]);
  await q(
    db,
    `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
     VALUES (?, ?, ?, 'claude', 'model', 0, 'running', ?, '{}', 'codex')`,
    [agentId, teamId, `${name}-worker`, Date.now()],
  );
  await q(db, `UPDATE teams SET lead_agent_id = ? WHERE id = ?`, [agentId, teamId]);

  const acceptance = new InterTeamAcceptanceService(db);
  const processor = new InterTeamProcessor(db, { dispatchFn: async () => {} });
  const transport = new HttpFederationTransport(db, { timeoutMs: 4000 });
  const origin = new InterTeamOriginClient(db, acceptance, { transport });
  const app = createFederationApp(db, acceptance);
  const server = await new Promise<Server>((resolve) => {
    const created = createServer(app);
    created.listen(0, '127.0.0.1', () => resolve(created));
  });
  const port = (server.address() as { port: number }).port;
  return {
    db, nodeId, acceptance, origin, processor, server,
    baseUrl: `http://127.0.0.1:${port}`, teamId, agentId, workRoot,
  };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'interteam-federation-'));
  globalThis.fetch = ((url: any, init?: any) => {
    outboundCalls.push(String(url));
    if (failNextSubmit === 'drop-response' && String(url).includes('/federation/messages')) {
      // The peer commits and the response never arrives.
      return realFetch(url, init).then(() => {
        throw Object.assign(new Error('connection reset'), { name: 'FetchError' });
      });
    }
    return realFetch(url, init);
  }) as typeof fetch;

  alpha = await startNode('alpha', { policy: 'closed' });
  beta = await startNode('beta', { policy: 'open' });

  // Distinct identities are the precondition for everything below.
  expect(alpha.nodeId).not.toBe(beta.nodeId);
  expect(alpha.teamId).not.toBe(beta.teamId);

  // Only alpha has a route, pinned to beta's node ID.
  await new PeerRouteStore(alpha.db).upsert({
    nodeId: beta.nodeId, baseUrl: beta.baseUrl, localNodeId: alpha.nodeId,
  });
  await new InterteamFoundationStore(alpha.db).createContact({
    localTeamId: alpha.teamId, aliasDisplay: 'zeta-alias', remoteNodeId: beta.nodeId, remoteTeamId: beta.teamId,
  });
}, 30000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const node of [alpha, beta]) {
    if (!node) continue;
    await new Promise<void>((resolve) => node.server.close(() => resolve()));
    await node.db.close();
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

const context = () => ({ localTeamId: alpha.teamId, principal: 'agent-header' as const, agentId: null });

describe('two managers over the federation contract', () => {
  let conversationId: string;
  let firstMessageId: string;

  it('crosses the boundary for a first send and creates the destination row', async () => {
    const sent = await alpha.origin.send({
      context: context(), alias: 'zeta-alias',
      destination: { kind: 'agent_id', agentId: beta.agentId }, body: { ask: 'remote-work' },
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    conversationId = sent.conversationId;
    firstMessageId = sent.messageId;
    expect(sent.outcome.kind).toBe('accepted');

    // The destination now owns the message; the origin owns only its record.
    expect(await q(beta.db, `SELECT id FROM interteam_messages WHERE message_id = ?`, [firstMessageId]))
      .toHaveLength(1);
    expect(await q(alpha.db, `SELECT id FROM interteam_messages`)).toHaveLength(0);
    const outbound = await new InterTeamOutboundStore(alpha.db).getSubmission(alpha.nodeId, firstMessageId);
    expect(outbound).toMatchObject({ attemptState: 'accepted', position: 0 });
  });

  it('collects the processing result repeatedly and non-consumingly', async () => {
    await beta.processor.scan();
    const collected = await alpha.origin.collect({
      context: context(), conversationId, messageId: firstMessageId,
    });
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(collected.value.state).toBe('processing');

    const link = (await q<{ local_team_id: string; local_query_id: string }>(
      beta.db,
      `SELECT p.local_team_id, p.local_query_id FROM interteam_processing p
       JOIN interteam_messages m ON m.id = p.message_pk WHERE m.message_id = ?`,
      [firstMessageId],
    ))[0]!;
    await q(beta.db, `UPDATE queries SET status = 'completed', completed = ?, result = ? WHERE team_id = ? AND query_id = ?`,
      [Date.now(), JSON.stringify({ answer: 'remote' }), link.local_team_id, link.local_query_id]);
    await beta.processor.scan();

    for (let read = 0; read < 3; read++) {
      const again = await alpha.origin.collect({
        context: context(), conversationId, messageId: firstMessageId,
      });
      expect(again.ok && again.value).toMatchObject({
        state: 'completed', result: { answer: 'remote' }, resultPresent: true,
      });
    }
  });

  it('recovers a lost 202 with an identical resubmission and creates one message', async () => {
    failNextSubmit = 'drop-response';
    const lost = await alpha.origin.send({
      context: context(), alias: 'zeta-alias',
      destination: { kind: 'agent_id', agentId: beta.agentId }, body: { ask: 'lost' },
    });
    failNextSubmit = null;
    expect(lost.ok).toBe(false);
    if (lost.ok) return;
    expect(lost.code).toBe('peer_unreachable');

    // The origin kept the exact envelope and marked the outcome unknown.
    const outboundStore = new InterTeamOutboundStore(alpha.db);
    const pending = (await q<{ message_id: string }>(
      alpha.db,
      `SELECT message_id FROM interteam_outbound_submissions WHERE attempt_state = 'unknown'`,
    ))[0]!;
    const record = await outboundStore.getSubmission(alpha.nodeId, pending.message_id);
    expect(record!.attemptState).toBe('unknown');
    // The peer did commit, so exactly one destination row already exists.
    expect(await q(beta.db, `SELECT id FROM interteam_messages WHERE message_id = ?`, [pending.message_id]))
      .toHaveLength(1);

    const replay = await alpha.origin.resubmit({
      context: context(), envelope: record!.envelope,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.outcome.kind).toBe('deduplicated');
    expect(await q(beta.db, `SELECT id FROM interteam_messages WHERE message_id = ?`, [pending.message_id]))
      .toHaveLength(1);
  });

  it('refuses to advance the stream while an earlier submission is unresolved', async () => {
    const stalled = await alpha.origin.send({
      context: context(), alias: 'zeta-alias', destination: { kind: 'team' }, body: { ask: 'head' },
    });
    expect(stalled.ok).toBe(true);
    if (!stalled.ok) return;

    // Force the head into an unknown outcome, as a lost response would.
    await new InterTeamOutboundStore(alpha.db).recordAttemptOutcome({
      originNodeId: alpha.nodeId, messageId: stalled.messageId, attemptState: 'unknown',
      diagnostic: 'simulated lost response',
    });
    const blocked = await alpha.origin.continueConversation({
      context: context(), conversationId: stalled.conversationId, body: { ask: 'next' },
    });
    expect(blocked).toEqual({ ok: false, code: 'outbound_submission_unresolved' });

    await new InterTeamOutboundStore(alpha.db).recordAttemptOutcome({
      originNodeId: alpha.nodeId, messageId: stalled.messageId, attemptState: 'accepted',
    });
    const resumed = await alpha.origin.continueConversation({
      context: context(), conversationId: stalled.conversationId, body: { ask: 'next' },
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const rows = await q<{ position: number }>(
      beta.db, `SELECT position FROM interteam_messages WHERE message_id = ?`, [resumed.messageId],
    );
    expect(rows[0]!.position).toBe(1);
  });

  it('returns the identical result for unauthorized and unknown collection', async () => {
    const otherTeam = randomUUID();
    await q(alpha.db, `INSERT INTO teams (id, name) VALUES (?, ?)`, [otherTeam, `other-${randomUUID()}`]);
    const nonParticipant = await alpha.origin.collect({
      context: { localTeamId: otherTeam, principal: 'agent-header', agentId: null },
      conversationId, messageId: firstMessageId,
    });
    const unknown = await alpha.origin.collect({
      context: context(), conversationId: `conv-${randomUUID()}`, messageId: firstMessageId,
    });
    expect(nonParticipant).toEqual({ ok: false, code: 'conversation_not_found' });
    expect(unknown).toEqual({ ok: false, code: 'conversation_not_found' });
  });

  it('reads a roster across the boundary and keeps reading a closed team', async () => {
    const open = await alpha.origin.describeContact({ context: context(), alias: 'zeta-alias' });
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    expect(open.descriptor).toMatchObject({
      nodeId: beta.nodeId, teamId: beta.teamId, inboundPolicy: 'open', alias: 'zeta-alias',
    });
    expect(open.descriptor.agents.map((agent) => agent.addressName)).toContain('beta-worker');
    // The origin's alias is decoration and never crossed the wire.
    expect(JSON.stringify(open.descriptor.agents)).not.toContain('zeta-alias');

    await q(beta.db, `UPDATE teams SET inbound_policy = 'closed' WHERE id = ?`, [beta.teamId]);
    const closed = await alpha.origin.describeContact({ context: context(), alias: 'zeta-alias' });
    expect(closed.ok && closed.descriptor.inboundPolicy).toBe('closed');
    expect(closed.ok && closed.descriptor.agents.length).toBeGreaterThan(0);

    const refused = await alpha.origin.send({
      context: context(), alias: 'zeta-alias', destination: { kind: 'team' }, body: { ask: 'refused' },
    });
    expect(refused).toEqual({ ok: false, code: 'target_closed' });
    await q(beta.db, `UPDATE teams SET inbound_policy = 'open' WHERE id = ?`, [beta.teamId]);
  });

  it('refuses a route aimed at the wrong manager and changes no pin', async () => {
    const routes = new PeerRouteStore(alpha.db);
    const pinBefore = await q(alpha.db, `SELECT * FROM team_contacts`);
    // Aim beta's route at alpha's own federation surface: a different node.
    await routes.upsert({ nodeId: beta.nodeId, baseUrl: alpha.baseUrl, localNodeId: alpha.nodeId });

    const mismatched = await alpha.origin.send({
      context: context(), alias: 'zeta-alias',
      destination: { kind: 'agent_id', agentId: beta.agentId }, body: { ask: 'substituted' },
    });
    expect(mismatched).toEqual({ ok: false, code: 'peer_node_mismatch' });
    expect(await q(alpha.db, `SELECT * FROM team_contacts`)).toEqual(pinBefore);
    // The route is not auto-healed by the diagnostic.
    expect(await routes.get(beta.nodeId)).toMatchObject({ baseUrl: alpha.baseUrl });

    await routes.upsert({ nodeId: beta.nodeId, baseUrl: beta.baseUrl, localNodeId: alpha.nodeId });
  });

  it('returns peer_route_unconfigured when the route is disabled, without a network call', async () => {
    const routes = new PeerRouteStore(alpha.db);
    await routes.setEnabled(beta.nodeId, false);
    const before = outboundCalls.length;
    const blocked = await alpha.origin.send({
      context: context(), alias: 'zeta-alias', destination: { kind: 'team' }, body: { ask: 'no-route' },
    });
    expect(blocked).toEqual({ ok: false, code: 'peer_route_unconfigured' });
    expect(outboundCalls.length).toBe(before);
    await routes.setEnabled(beta.nodeId, true);
  });

  it('gate: the destination opened zero outbound connections', () => {
    // Every call in this process went from alpha to beta's federation surface.
    expect(outboundCalls.length).toBeGreaterThan(5);
    expect(outboundCalls.every((url) => url.startsWith(beta.baseUrl) || url.startsWith(alpha.baseUrl))).toBe(true);
    expect(outboundCalls.some((url) => url.startsWith(beta.baseUrl))).toBe(true);
  });
});
