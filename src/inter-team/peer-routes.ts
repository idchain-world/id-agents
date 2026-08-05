// SPDX-License-Identifier: MIT

import type { DbAdapter, QueryResult } from '../db/db-adapter.js';

/**
 * Commit 14: peer routes.
 *
 * A route answers only "where is this node right now". Identity lives in the
 * contact pin, so changing an address rewrites nothing durable. Routes are
 * written only through the loopback operator surface: no federation request or
 * response may create, update, disable, or suggest one.
 */

export interface PeerRoute {
  nodeId: string;
  baseUrl: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface PeerRouteRow {
  node_id: string;
  base_url: string;
  enabled: number | boolean;
  created_at: number | string;
  updated_at: number | string;
}

export class PeerRouteError extends Error {
  constructor(readonly code: 'peer_route_invalid' | 'peer_route_not_found') {
    super(code);
    this.name = 'PeerRouteError';
  }
}

function parameterize(db: DbAdapter, sql: string): string {
  if (db.dialect === 'sqlite') return sql;
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function query<T>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return db.query<T>(parameterize(db, sql), params);
}

function route(row: PeerRouteRow): PeerRoute {
  return {
    nodeId: row.node_id,
    baseUrl: row.base_url,
    enabled: row.enabled === true || row.enabled === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * A base address is operational configuration, so it is validated when written
 * and never guessed or corrected later. Credentials in the URL are refused
 * because V1 has no application authentication and a userinfo component would
 * imply one.
 */
export function normalizePeerBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new PeerRouteError('peer_route_invalid');
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new PeerRouteError('peer_route_invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PeerRouteError('peer_route_invalid');
  }
  if (parsed.username || parsed.password) throw new PeerRouteError('peer_route_invalid');
  if (parsed.search || parsed.hash) throw new PeerRouteError('peer_route_invalid');
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export class PeerRouteStore {
  constructor(private readonly db: DbAdapter) {}

  async list(): Promise<PeerRoute[]> {
    const result = await query<PeerRouteRow>(
      this.db,
      `SELECT * FROM interteam_peer_routes ORDER BY node_id`,
    );
    return result.rows.map(route);
  }

  async get(nodeId: string): Promise<PeerRoute | null> {
    const result = await query<PeerRouteRow>(
      this.db,
      `SELECT * FROM interteam_peer_routes WHERE node_id = ?`,
      [nodeId],
    );
    return result.rows[0] ? route(result.rows[0]) : null;
  }

  /** Resolution used by every outbound attempt: enabled routes only. */
  async resolveEnabled(nodeId: string): Promise<PeerRoute | null> {
    const found = await this.get(nodeId);
    return found?.enabled ? found : null;
  }

  async upsert(input: {
    nodeId: string;
    baseUrl: string;
    enabled?: boolean;
    localNodeId: string;
    now?: number;
  }): Promise<PeerRoute> {
    if (typeof input.nodeId !== 'string' || input.nodeId.trim() === '') {
      throw new PeerRouteError('peer_route_invalid');
    }
    // Same-manager delivery never federates with itself, so a route naming the
    // local node is refused rather than merely ignored at resolution time.
    if (input.nodeId === input.localNodeId) throw new PeerRouteError('peer_route_invalid');
    const baseUrl = normalizePeerBaseUrl(input.baseUrl);
    const now = input.now ?? Date.now();
    const enabled = input.enabled ?? true;
    const existing = await this.get(input.nodeId);
    if (existing) {
      await query(
        this.db,
        `UPDATE interteam_peer_routes SET base_url = ?, enabled = ?, updated_at = ? WHERE node_id = ?`,
        [baseUrl, this.boolean(enabled), now, input.nodeId],
      );
    } else {
      await query(
        this.db,
        `INSERT INTO interteam_peer_routes (node_id, base_url, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [input.nodeId, baseUrl, this.boolean(enabled), now, now],
      );
    }
    return (await this.get(input.nodeId))!;
  }

  async setEnabled(nodeId: string, enabled: boolean, now = Date.now()): Promise<PeerRoute> {
    const result = await query(
      this.db,
      `UPDATE interteam_peer_routes SET enabled = ?, updated_at = ? WHERE node_id = ?`,
      [this.boolean(enabled), now, nodeId],
    );
    if (result.rowCount !== 1) throw new PeerRouteError('peer_route_not_found');
    return (await this.get(nodeId))!;
  }

  async remove(nodeId: string): Promise<boolean> {
    const result = await query(this.db, `DELETE FROM interteam_peer_routes WHERE node_id = ?`, [nodeId]);
    return result.rowCount === 1;
  }

  private boolean(value: boolean): boolean | number {
    return this.db.dialect === 'sqlite' ? (value ? 1 : 0) : value;
  }
}
