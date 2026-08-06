// SPDX-License-Identifier: MIT
/**
 * Item 2: the peer route probe.
 *
 * The gate: a live peer reports reachable; a route aimed at a different node
 * that really answers reports the mismatch with both node IDs and changes
 * nothing; a stopped peer reports unreachable and leaves the route enabled; the
 * probe never creates, updates, or heals a route; and listing routes performs
 * no network call at all.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DbAdapter } from '../../src/db/db-adapter.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { InterTeamAcceptanceService } from '../../src/inter-team/acceptance-service.js';
import { createFederationApp } from '../../src/inter-team/federation-app.js';
import { PeerRouteStore } from '../../src/inter-team/peer-routes.js';
import { PeerRouteProbe } from '../../src/inter-team/peer-route-probe.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function q<T = unknown>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

/** A real node with a real federation surface, so the probe exercises the wire. */
async function node(): Promise<{ db: DbAdapter; nodeId: string; teamId: string; url: string; stop: () => Promise<void> }> {
  const db = new SqliteAdapter(':memory:');
  await migrateSqlite(db);
  closers.push(() => db.close());
  const nodeId = (await q<{ node_id: string }>(db, `SELECT node_id FROM manager_identity`))[0]!.node_id;
  const teamId = randomUUID();
  await q(db, `INSERT INTO teams (id, name, inbound_policy) VALUES (?, ?, 'open')`, [teamId, `t-${randomUUID()}`]);

  const app = createFederationApp(db, new InterTeamAcceptanceService(db));
  const server: Server = await new Promise((resolve) => {
    const created = createServer(app);
    created.listen(0, '127.0.0.1', () => resolve(created));
  });
  const stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
  closers.push(stop);
  return { db, nodeId, teamId, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, stop };
}

describe('peer route probe', () => {
  it('reports reachable for a live peer at the pinned node', async () => {
    const origin = await node();
    const peer = await node();
    await new PeerRouteStore(origin.db).upsert({
      nodeId: peer.nodeId, baseUrl: peer.url, localNodeId: origin.nodeId,
    });

    const result = await new PeerRouteProbe(origin.db).probe({
      nodeId: peer.nodeId, localNodeId: origin.nodeId, localTeamId: origin.teamId,
    });
    expect(result).toMatchObject({
      nodeId: peer.nodeId, outcome: 'reachable', baseUrl: peer.url, enabled: true, diagnostic: null,
    });
    expect(result.probedAt).toBeGreaterThan(0);
  });

  it('reports the mismatch with both node IDs when another node answers', async () => {
    const origin = await node();
    const peer = await node();
    const impostor = await node();
    const routes = new PeerRouteStore(origin.db);
    // A route for the peer, aimed at a node that really answers with its own
    // identity. That is a stale or substituted address, not an outage.
    await routes.upsert({ nodeId: peer.nodeId, baseUrl: impostor.url, localNodeId: origin.nodeId });
    const before = await q(origin.db, `SELECT * FROM interteam_peer_routes`);

    const result = await new PeerRouteProbe(origin.db).probe({
      nodeId: peer.nodeId, localNodeId: origin.nodeId, localTeamId: origin.teamId,
    });
    expect(result.outcome).toBe('node_mismatch');
    expect(result.expectedNodeId).toBe(peer.nodeId);
    expect(result.actualNodeId).toBe(impostor.nodeId);
    expect(result.diagnostic).toContain(impostor.url);

    // A diagnostic that repaired what it measured could not be trusted.
    expect(await q(origin.db, `SELECT * FROM interteam_peer_routes`)).toEqual(before);
  });

  it('reports unreachable for a stopped peer and leaves the route enabled', async () => {
    const origin = await node();
    const peer = await node();
    await new PeerRouteStore(origin.db).upsert({
      nodeId: peer.nodeId, baseUrl: peer.url, localNodeId: origin.nodeId,
    });
    await peer.stop();

    const result = await new PeerRouteProbe(origin.db).probe({
      nodeId: peer.nodeId, localNodeId: origin.nodeId, localTeamId: origin.teamId,
    });
    expect(result.outcome).toBe('unreachable');
    expect(result.diagnostic).toBeTruthy();
    // A stale address is not a missing route, and one failure never deletes it.
    expect(await new PeerRouteStore(origin.db).get(peer.nodeId)).toMatchObject({ enabled: true });
  });

  it('distinguishes a disabled route and a missing one from an outage', async () => {
    const origin = await node();
    const peer = await node();
    const routes = new PeerRouteStore(origin.db);
    const probe = new PeerRouteProbe(origin.db);

    const missing = await probe.probe({
      nodeId: peer.nodeId, localNodeId: origin.nodeId, localTeamId: origin.teamId,
    });
    expect(missing).toMatchObject({ outcome: 'no_route', baseUrl: null, enabled: null });

    await routes.upsert({ nodeId: peer.nodeId, baseUrl: peer.url, localNodeId: origin.nodeId });
    await routes.setEnabled(peer.nodeId, false);
    const disabled = await probe.probe({
      nodeId: peer.nodeId, localNodeId: origin.nodeId, localTeamId: origin.teamId,
    });
    expect(disabled).toMatchObject({ outcome: 'no_route', enabled: false, baseUrl: peer.url });
    expect(disabled.diagnostic).toContain('disabled');
  });

  it('never dials when routes are listed, only when a route is probed', async () => {
    const origin = await node();
    const peer = await node();
    await new PeerRouteStore(origin.db).upsert({
      nodeId: peer.nodeId, baseUrl: peer.url, localNodeId: origin.nodeId,
    });

    const dialled: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: any, init?: any) => {
      dialled.push(String(url));
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      await new PeerRouteStore(origin.db).list();
      expect(dialled).toEqual([]);

      await new PeerRouteProbe(origin.db).probe({
        nodeId: peer.nodeId, localNodeId: origin.nodeId, localTeamId: origin.teamId,
      });
      expect(dialled).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
