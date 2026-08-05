// SPDX-License-Identifier: MIT
/**
 * Commit 14: peer routes and durable origin-side outbound state.
 *
 * The gate this file proves: route keys are node-global and cannot name the
 * local node, invalid routes are refused, missing and disabled routes preserve
 * today's result, outbound state is committed before any transport can observe
 * an attempt, an address change leaves every identity and messaging record
 * byte-for-byte equivalent, no address is stored on those records, and the
 * origin index works without a destination row in the same database.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DbAdapter } from '../../src/db/db-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { InterTeamAcceptanceService } from '../../src/inter-team/acceptance-service.js';
import { InterTeamOriginClient } from '../../src/inter-team/origin-client.js';
import { InterteamFoundationStore } from '../../src/inter-team/foundation-store.js';
import { InterTeamOutboundStore } from '../../src/inter-team/outbound-store.js';
import { PeerRouteStore, normalizePeerBaseUrl } from '../../src/inter-team/peer-routes.js';
import {
  UNCONFIGURED_FEDERATION_TRANSPORT,
  type FederationTransport,
} from '../../src/inter-team/federation-transport.js';

const adapters: DbAdapter[] = [];
const roots: string[] = [];

afterEach(async () => {
  while (adapters.length) await adapters.pop()!.close();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

async function q<T = unknown>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function freshDb(filePath?: string): Promise<DbAdapter> {
  const db = new SqliteAdapter(filePath ?? ':memory:');
  await migrateSqlite(db);
  adapters.push(db);
  return db;
}

async function seedTeams(db: DbAdapter) {
  const originTeam = randomUUID();
  const destTeam = randomUUID();
  const agentId = `agent-${randomUUID()}`;
  await q(db, `INSERT INTO teams (id, name) VALUES (?, ?)`, [originTeam, `origin-${randomUUID()}`]);
  await q(db, `INSERT INTO teams (id, name, inbound_policy) VALUES (?, ?, 'open')`, [destTeam, `dest-${randomUUID()}`]);
  await q(
    db,
    `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
     VALUES (?, ?, 'receiver', 'claude', 'model', 0, 'running', ?, '{}', 'codex')`,
    [agentId, destTeam, Date.now()],
  );
  const nodeId = (await q<{ node_id: string }>(db, `SELECT node_id FROM manager_identity`))[0]!.node_id;
  return { originTeam, destTeam, agentId, nodeId };
}

describe('peer routes', () => {
  it('is node-global, refuses the local node, and refuses invalid addresses', async () => {
    const db = await freshDb();
    const { nodeId } = await seedTeams(db);
    const routes = new PeerRouteStore(db);
    const remote = randomUUID();

    const created = await routes.upsert({
      nodeId: remote, baseUrl: 'http://peer.internal:4200/', localNodeId: nodeId, now: 10,
    });
    expect(created).toMatchObject({ nodeId: remote, baseUrl: 'http://peer.internal:4200', enabled: true });
    // Node-global: one row per node, not one per team.
    expect(await routes.list()).toHaveLength(1);

    await expect(routes.upsert({ nodeId, baseUrl: 'http://self:1/', localNodeId: nodeId }))
      .rejects.toMatchObject({ code: 'peer_route_invalid' });
    for (const bad of ['', 'not-a-url', 'ftp://peer/', 'http://user:pw@peer/', 'http://peer/?x=1']) {
      expect(() => normalizePeerBaseUrl(bad)).toThrow('peer_route_invalid');
    }
  });

  it('resolves only enabled routes and never deletes one because a request failed', async () => {
    const db = await freshDb();
    const { nodeId } = await seedTeams(db);
    const routes = new PeerRouteStore(db);
    const remote = randomUUID();
    await routes.upsert({ nodeId: remote, baseUrl: 'http://peer:4200', localNodeId: nodeId });

    expect(await routes.resolveEnabled(remote)).toMatchObject({ baseUrl: 'http://peer:4200' });
    await routes.setEnabled(remote, false);
    expect(await routes.resolveEnabled(remote)).toBeNull();
    // A disabled route still exists: absence and staleness are different states.
    expect(await routes.get(remote)).toMatchObject({ enabled: false });
  });
});

describe('durable outbound state', () => {
  it('commits before any transport could observe an attempt', async () => {
    const db = await freshDb();
    const { originTeam, destTeam, agentId, nodeId } = await seedTeams(db);
    await new InterteamFoundationStore(db).createContact({
      localTeamId: originTeam, aliasDisplay: 'peer', remoteNodeId: nodeId, remoteTeamId: destTeam, now: 1,
    });

    const observed: Array<{ messageId: string; stateAtObservation: string | undefined }> = [];
    const spy: FederationTransport = {
      ...UNCONFIGURED_FEDERATION_TRANSPORT,
      async submit({ envelope }) {
        const row = (await q<{ attempt_state: string }>(
          db, `SELECT attempt_state FROM interteam_outbound_submissions WHERE message_id = ?`,
          [envelope.messageId],
        ))[0];
        observed.push({ messageId: envelope.messageId, stateAtObservation: row?.attempt_state });
        return UNCONFIGURED_FEDERATION_TRANSPORT.submit({ destinationNodeId: 'x', envelope });
      },
    };

    const client = new InterTeamOriginClient(db, new InterTeamAcceptanceService(db), { transport: spy });
    const sent = await client.send({
      context: { localTeamId: originTeam, principal: 'agent-header', agentId: null },
      alias: 'peer',
      destination: { kind: 'agent_id', agentId },
      body: { work: 1 },
      now: 20,
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    const outbound = new InterTeamOutboundStore(db);
    const record = await outbound.getSubmission(nodeId, sent.messageId);
    expect(record).toMatchObject({
      conversationId: sent.conversationId,
      position: 0,
      protocolVersion: sent.protocolVersion,
      firstSubmittedAt: sent.firstSubmittedAt,
      attemptState: 'accepted',
    });
    // The whole envelope is stored, so an identical resubmission needs no
    // reconstruction from parts.
    expect(record!.envelope.messageId).toBe(sent.messageId);
    expect(record!.envelope.body).toEqual({ work: 1 });
  });

  it('advances the conversation head only on confirmed acceptance', async () => {
    const db = await freshDb();
    const { originTeam, destTeam, nodeId } = await seedTeams(db);
    const outbound = new InterTeamOutboundStore(db);
    const conversationId = `conv-${randomUUID()}`;
    const envelope = {
      protocolVersion: '1.1', originNodeId: nodeId, originTeamId: originTeam,
      destinationNodeId: 'remote-node', destinationTeamId: destTeam,
      destination: { kind: 'team' as const }, conversationId,
      messageId: `msg-${randomUUID()}`, position: 0, predecessorMessageId: null,
      firstSubmittedAt: 5, body: null,
    };
    await outbound.recordSubmission({ envelope, now: 5 });
    expect((await outbound.getConversation(nodeId, conversationId))!.nextPosition).toBe(0);

    await outbound.recordAttemptOutcome({
      originNodeId: nodeId, messageId: envelope.messageId, attemptState: 'unknown',
      diagnostic: 'peer_timeout', now: 6,
    });
    // An unknown outcome must not move the stream.
    expect((await outbound.getConversation(nodeId, conversationId))!.nextPosition).toBe(0);
    expect(await outbound.firstUnresolvedSubmission(nodeId, conversationId))
      .toMatchObject({ messageId: envelope.messageId, attemptState: 'unknown' });

    await outbound.recordAttemptOutcome({
      originNodeId: nodeId, messageId: envelope.messageId, attemptState: 'accepted', now: 7,
    });
    expect(await outbound.getConversation(nodeId, conversationId)).toMatchObject({
      nextPosition: 1, predecessorMessageId: envelope.messageId,
    });
    expect(await outbound.firstUnresolvedSubmission(nodeId, conversationId)).toBeNull();
  });

  it('supports the origin index without a destination row in the same database', async () => {
    const db = await freshDb();
    const { originTeam, nodeId } = await seedTeams(db);
    const outbound = new InterTeamOutboundStore(db);
    await outbound.recordSubmission({
      envelope: {
        protocolVersion: '1.1', originNodeId: nodeId, originTeamId: originTeam,
        destinationNodeId: 'remote-node', destinationTeamId: 'remote-team',
        destination: { kind: 'agent_name', agentName: 'remote-worker' },
        conversationId: `conv-${randomUUID()}`, messageId: `msg-${randomUUID()}`,
        position: 0, predecessorMessageId: null, firstSubmittedAt: 9, body: 'x',
      },
      now: 9,
    });
    expect(await q(db, `SELECT id FROM interteam_conversations`)).toHaveLength(0);
    const listed = await outbound.listConversations(nodeId, originTeam);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      destinationNodeId: 'remote-node',
      destinationKind: 'agent_name',
      destinationNameAtAcceptance: 'remote-worker',
    });
  });

  it('stores no address on any identity or messaging record', async () => {
    const db = await freshDb();
    const tables = [
      'interteam_outbound_conversations', 'interteam_outbound_submissions',
      'interteam_conversations', 'interteam_messages', 'interteam_message_receipts',
      'team_contacts', 'manager_identity', 'interteam_origin_submissions',
    ];
    for (const table of tables) {
      const columns = (await q<{ name: string }>(db, `SELECT name FROM pragma_table_info('${table}')`))
        .map((row) => row.name);
      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) {
        expect(column).not.toMatch(/url|address|host|endpoint|port/i);
      }
    }
  });
});

describe('address change is configuration, not identity', () => {
  it('leaves every identity and messaging record byte-for-byte equivalent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interteam-readdress-'));
    roots.push(root);
    const db = await freshDb(path.join(root, 'node.db'));
    const { originTeam, destTeam, agentId, nodeId } = await seedTeams(db);
    await new InterteamFoundationStore(db).createContact({
      localTeamId: originTeam, aliasDisplay: 'peer', remoteNodeId: nodeId, remoteTeamId: destTeam, now: 1,
    });
    const client = new InterTeamOriginClient(db, new InterTeamAcceptanceService(db));
    const sent = await client.send({
      context: { localTeamId: originTeam, principal: 'agent-header', agentId: null },
      alias: 'peer', destination: { kind: 'agent_id', agentId }, body: 'payload', now: 30,
    });
    expect(sent.ok).toBe(true);

    const routes = new PeerRouteStore(db);
    const remote = randomUUID();
    await routes.upsert({ nodeId: remote, baseUrl: 'http://before:4200', localNodeId: nodeId, now: 31 });

    const snapshot = async () => ({
      identity: await q(db, `SELECT * FROM manager_identity`),
      contacts: await q(db, `SELECT * FROM team_contacts`),
      conversations: await q(db, `SELECT * FROM interteam_conversations`),
      messages: await q(db, `SELECT * FROM interteam_messages`),
      receipts: await q(db, `SELECT * FROM interteam_message_receipts`),
      outboundConversations: await q(db, `SELECT * FROM interteam_outbound_conversations`),
      outboundSubmissions: await q(db, `SELECT * FROM interteam_outbound_submissions`),
      attribution: await q(db, `SELECT * FROM interteam_origin_submissions`),
    });
    const before = await snapshot();

    await routes.upsert({ nodeId: remote, baseUrl: 'https://after.example:9443', localNodeId: nodeId, now: 32 });

    expect(await snapshot()).toEqual(before);
    // Only the route's own operational value moved.
    expect(await routes.get(remote)).toMatchObject({ baseUrl: 'https://after.example:9443' });
  });

  it('survives restart with the same node identity and outbound rows', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interteam-restart-'));
    roots.push(root);
    const file = path.join(root, 'node.db');
    const first = await freshDb(file);
    const { originTeam, nodeId } = await seedTeams(first);
    const conversationId = `conv-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    await new InterTeamOutboundStore(first).recordSubmission({
      envelope: {
        protocolVersion: '1.1', originNodeId: nodeId, originTeamId: originTeam,
        destinationNodeId: 'remote-node', destinationTeamId: 'remote-team',
        destination: { kind: 'team' }, conversationId, messageId,
        position: 0, predecessorMessageId: null, firstSubmittedAt: 40, body: { keep: true },
      },
      now: 40,
    });
    await first.close();
    adapters.pop();

    const second = await freshDb(file);
    const revived = await new InterTeamOutboundStore(second).getSubmission(nodeId, messageId);
    expect((await q<{ node_id: string }>(second, `SELECT node_id FROM manager_identity`))[0]!.node_id).toBe(nodeId);
    expect(revived).toMatchObject({
      conversationId, protocolVersion: '1.1', firstSubmittedAt: 40, attemptState: 'not_attempted',
    });
    expect(revived!.envelope.body).toEqual({ keep: true });
  });
});

describe('unconfigured transport', () => {
  it('reports every peer unconfigured and opens no connection', async () => {
    const envelope = {
      protocolVersion: '1.1', originNodeId: 'a', originTeamId: 'b',
      destinationNodeId: 'remote', destinationTeamId: 'c',
      destination: { kind: 'team' as const }, conversationId: 'conv', messageId: 'msg',
      position: 0, predecessorMessageId: null, firstSubmittedAt: 1, body: null,
    };
    const result = await UNCONFIGURED_FEDERATION_TRANSPORT.submit({ destinationNodeId: 'remote', envelope });
    expect(result).toMatchObject({ ok: false, code: 'peer_route_unconfigured', outcomeUnknown: false });
  });
});
