// SPDX-License-Identifier: MIT
/**
 * Commit 16: the configured federation listener and topology portability.
 *
 * What this file proves without containers: the listener is disabled by
 * default so nothing is exposed, an incomplete or unacknowledged-wildcard bind
 * refuses at startup, a non-wildcard bind starts normally, the federation
 * surface exposes only federation operations and trusts no local admin header,
 * and the same databases keep every identity and messaging record while
 * in-flight work continues after moving to a different bind address and route.
 *
 * What it cannot prove here, recorded rather than approximated: the two
 * containers on a private Docker network, because the daemon is not running,
 * and the tailnet leg of the move, because that needs a second host.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
import {
  describeFederationBind,
  resolveFederationListenerConfig,
} from '../../src/inter-team/federation-config.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function q<T = unknown>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

describe('federation listener configuration', () => {
  it('is disabled by default so no socket is opened', () => {
    expect(resolveFederationListenerConfig({})).toEqual({ enabled: false });
    expect(describeFederationBind({ enabled: false })).toContain('disabled');
  });

  it('refuses an incomplete bind rather than completing it with a default', () => {
    expect(() => resolveFederationListenerConfig({ ID_FEDERATION_BIND_ADDRESS: '127.0.0.1' }))
      .toThrow('peer_route_invalid');
    expect(() => resolveFederationListenerConfig({ ID_FEDERATION_BIND_PORT: '4300' }))
      .toThrow('peer_route_invalid');
    expect(() => resolveFederationListenerConfig({
      ID_FEDERATION_BIND_ADDRESS: '127.0.0.1', ID_FEDERATION_BIND_PORT: 'not-a-port',
    })).toThrow('peer_route_invalid');
    expect(() => resolveFederationListenerConfig({
      ID_FEDERATION_BIND_ADDRESS: '127.0.0.1', ID_FEDERATION_BIND_PORT: '70000',
    })).toThrow('peer_route_invalid');
  });

  it('refuses the wildcard without the separate explicit override, and accepts it with', () => {
    for (const wildcard of ['0.0.0.0', '::']) {
      expect(() => resolveFederationListenerConfig({
        ID_FEDERATION_BIND_ADDRESS: wildcard, ID_FEDERATION_BIND_PORT: '4300',
      })).toThrow('peer_route_invalid');
      const acknowledged = resolveFederationListenerConfig({
        ID_FEDERATION_BIND_ADDRESS: wildcard,
        ID_FEDERATION_BIND_PORT: '4300',
        ID_FEDERATION_ALLOW_WILDCARD_BIND: '1',
      });
      expect(acknowledged).toMatchObject({ enabled: true, address: wildcard, wildcardAcknowledged: true });
      // The reported bind names the exposure so it is inspectable.
      expect(describeFederationBind(acknowledged)).toContain('WILDCARD');
    }
  });

  it('starts normally on a non-wildcard bind and reports the exact address', () => {
    const config = resolveFederationListenerConfig({
      ID_FEDERATION_BIND_ADDRESS: '127.0.0.1', ID_FEDERATION_BIND_PORT: '4321',
    });
    expect(config).toEqual({
      enabled: true, address: '127.0.0.1', port: 4321, wildcardAcknowledged: false,
    });
    expect(describeFederationBind(config)).toBe('federation listener bound to 127.0.0.1:4321');
    expect(describeFederationBind(config)).not.toContain('WILDCARD');
  });
});

describe('federation surface exposure', () => {
  it('exposes only federation operations and trusts no local admin header', async () => {
    const db = new SqliteAdapter(':memory:');
    await migrateSqlite(db);
    cleanups.push(() => db.close());
    const app = createFederationApp(db, new InterTeamAcceptanceService(db));
    const server = await new Promise<Server>((resolve) => {
      const created = createServer(app);
      created.listen(0, '127.0.0.1', () => resolve(created));
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    // Management operations simply do not exist on this surface.
    for (const managementPath of [
      '/health', '/agents', '/tasks', '/inter-team/config', '/inter-team/config/peer-routes',
      '/inter-team/send', '/inter-team/conversations', '/files/list',
    ]) {
      const response = await fetch(`${base}${managementPath}`, {
        headers: { 'X-Id-Admin': '1', 'X-Id-Team': 'default' },
      });
      expect(response.status).toBe(404);
    }

    // A local admin header is not authority here: without the federation
    // origin headers the request is a source-context mismatch.
    const spoofed = await fetch(`${base}/federation/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Admin': '1', 'X-Id-Team': 'default' },
      body: JSON.stringify({ envelope: {} }),
    });
    expect(spoofed.status).toBe(403);
    const body = await spoofed.json() as Record<string, unknown>;
    expect(body.error).toBe('source_context_mismatch');
    // Even a refusal identifies the responding node.
    expect(typeof body.nodeId).toBe('string');
    expect(typeof body.protocolVersion).toBe('string');
  });
});

describe('topology portability', () => {
  it('survives an address change with identical identity and messaging records', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interteam-portability-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    // Two nodes, distinct durable databases, started at one pair of addresses.
    const build = async (name: string) => {
      const db = new SqliteAdapter(path.join(root, `${name}.db`));
      await migrateSqlite(db);
      const nodeId = (await q<{ node_id: string }>(db, `SELECT node_id FROM manager_identity`))[0]!.node_id;
      const teamId = randomUUID();
      const agentId = `agent-${randomUUID()}`;
      await q(db, `INSERT INTO teams (id, name, inbound_policy) VALUES (?, ?, 'open')`,
        [teamId, `${name}-${randomUUID()}`]);
      await q(
        db,
        `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
         VALUES (?, ?, ?, 'claude', 'model', 0, 'running', ?, '{}', 'codex')`,
        [agentId, teamId, `${name}-worker`, Date.now()],
      );
      await q(db, `UPDATE teams SET lead_agent_id = ? WHERE id = ?`, [agentId, teamId]);
      return { db, nodeId, teamId, agentId };
    };
    const a = await build('alpha');
    const b = await build('beta');
    cleanups.push(() => a.db.close());
    cleanups.push(() => b.db.close());

    const listen = async (db: DbAdapter) => {
      const app = createFederationApp(db, new InterTeamAcceptanceService(db));
      const server = await new Promise<Server>((resolve) => {
        const created = createServer(app);
        created.listen(0, '127.0.0.1', () => resolve(created));
      });
      return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
    };

    let receiver = await listen(b.db);
    const routes = new PeerRouteStore(a.db);
    await routes.upsert({ nodeId: b.nodeId, baseUrl: receiver.url, localNodeId: a.nodeId });
    await new InterteamFoundationStore(a.db).createContact({
      localTeamId: a.teamId, aliasDisplay: 'peer', remoteNodeId: b.nodeId, remoteTeamId: b.teamId,
    });

    const originOf = () => new InterTeamOriginClient(
      a.db, new InterTeamAcceptanceService(a.db), { transport: new HttpFederationTransport(a.db) },
    );
    const context = { localTeamId: a.teamId, principal: 'agent-header' as const, agentId: null };

    // One completed message and one still in flight.
    const done = await originOf().send({
      context, alias: 'peer', destination: { kind: 'agent_id', agentId: b.agentId }, body: 'finish-me',
    });
    const inFlight = await originOf().send({
      context, alias: 'peer', destination: { kind: 'team' }, body: 'still-going',
    });
    expect(done.ok && inFlight.ok).toBe(true);
    if (!done.ok || !inFlight.ok) return;

    const processor = new InterTeamProcessor(b.db, { dispatchFn: async () => {} });
    await processor.scan();
    const link = (await q<{ local_team_id: string; local_query_id: string }>(
      b.db,
      `SELECT p.local_team_id, p.local_query_id FROM interteam_processing p
       JOIN interteam_messages m ON m.id = p.message_pk WHERE m.message_id = ?`,
      [done.messageId],
    ))[0]!;
    await q(b.db, `UPDATE queries SET status = 'completed', completed = ?, result = ? WHERE team_id = ? AND query_id = ?`,
      [Date.now(), JSON.stringify({ finished: true }), link.local_team_id, link.local_query_id]);
    await processor.scan();

    const snapshot = async () => ({
      identityA: await q(a.db, `SELECT * FROM manager_identity`),
      identityB: await q(b.db, `SELECT * FROM manager_identity`),
      contacts: await q(a.db, `SELECT * FROM team_contacts`),
      outboundConversations: await q(a.db, `SELECT * FROM interteam_outbound_conversations`),
      outboundSubmissions: await q(a.db, `SELECT * FROM interteam_outbound_submissions`),
      conversations: await q(b.db, `SELECT * FROM interteam_conversations`),
      messages: await q(b.db, `SELECT * FROM interteam_messages`),
      receipts: await q(b.db, `SELECT * FROM interteam_message_receipts`),
    });
    const before = await snapshot();

    // The move: same databases, same build, only the bind address and the
    // route value change. No registration, identity rotation, or data rewrite.
    await new Promise<void>((resolve) => receiver.server.close(() => resolve()));
    receiver = await listen(b.db);
    cleanups.push(() => new Promise<void>((resolve) => receiver.server.close(() => resolve())));
    await routes.upsert({ nodeId: b.nodeId, baseUrl: receiver.url, localNodeId: a.nodeId });

    expect(await snapshot()).toEqual(before);

    // In-flight work continues under the same conversation and message IDs.
    const collected = await originOf().collect({
      context, conversationId: done.conversationId, messageId: done.messageId,
    });
    expect(collected.ok && collected.value).toMatchObject({
      state: 'completed', result: { finished: true },
    });
    const continued = await originOf().continueConversation({
      context, conversationId: inFlight.conversationId, body: 'after-the-move',
    });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    expect(continued.conversationId).toBe(inFlight.conversationId);
    const outbound = await new InterTeamOutboundStore(a.db)
      .getSubmission(a.nodeId, continued.messageId);
    expect(outbound).toMatchObject({ position: 1, attemptState: 'accepted' });

    // A fresh database at the same address is a different node, and old
    // contacts are never silently retargeted to it.
    const fresh = new SqliteAdapter(path.join(root, 'fresh.db'));
    await migrateSqlite(fresh);
    cleanups.push(() => fresh.close());
    const freshNodeId = (await q<{ node_id: string }>(fresh, `SELECT node_id FROM manager_identity`))[0]!.node_id;
    expect(freshNodeId).not.toBe(b.nodeId);

    const freshListener = await listen(fresh);
    cleanups.push(() => new Promise<void>((resolve) => freshListener.server.close(() => resolve())));
    await routes.upsert({ nodeId: b.nodeId, baseUrl: freshListener.url, localNodeId: a.nodeId });
    const misaimed = await originOf().send({
      context, alias: 'peer', destination: { kind: 'team' }, body: 'to-the-impostor',
    });
    expect(misaimed).toEqual({ ok: false, code: 'peer_node_mismatch' });
  }, 30000);
});
