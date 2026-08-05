// SPDX-License-Identifier: MIT

import type { DbAdapter, QueryResult } from '../db/db-adapter.js';
import type { Destination } from './protocol.js';

/**
 * Commit 7 — strict receiver-local destination resolution.
 *
 * The receiver resolves a destination team only by immutable ID (the contact
 * pin's remote half), and an agent only inside that team: exact current name
 * or exact immutable ID. Nothing here falls back to most-recent, cross-team,
 * or fuzzy matches, and the resolver never consults the team lead for a
 * direct-agent destination.
 */

export interface ResolvableAgentRow {
  id: string;
  team_id: string;
  name: string;
  status: string;
  deleted_at: number | string | null;
  runtime: string;
  metadata: string | Record<string, unknown> | null;
}

/**
 * The one shared processing-capable/availability predicate. Acceptance-time
 * routing checks ("can this send route right now") and processing-time
 * dispatch use the same definition so the two layers cannot disagree.
 *
 * Processing-capable means the manager's own delivery path can hand this
 * agent work: a `public-agent-remote` runtime lives in the DMZ where
 * manager-proxied traffic is forbidden, and a non-mesh member is refused by
 * the same gate `/talk-to` enforces. Excluding them here keeps acceptance
 * from promising work that dispatch would always refuse.
 */
export function isInterTeamAvailable(
  agent: Pick<ResolvableAgentRow, 'status' | 'deleted_at' | 'runtime' | 'metadata'> | null | undefined,
): boolean {
  if (!agent || agent.deleted_at !== null || agent.status !== 'running') return false;
  if (agent.runtime === 'public-agent-remote') return false;
  const metadata = typeof agent.metadata === 'string'
    ? safeParse(agent.metadata)
    : agent.metadata ?? {};
  return (metadata as Record<string, unknown>)?.mesh_member !== false;
}

function safeParse(value: string): Record<string, unknown> {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

export type DestinationTeamResolution =
  | { ok: true; teamId: string }
  | { ok: false; code: 'target_identity_missing' };

export type NewSendRecipientResolution =
  | { ok: true; kind: 'team' }
  | { ok: true; kind: 'agent'; agentId: string }
  | {
      ok: false;
      code:
        | 'team_lead_unavailable'
        | 'recipient_not_found'
        | 'recipient_ambiguous'
        | 'recipient_unavailable';
    };

function parameterize(db: DbAdapter, sql: string): string {
  if (db.dialect === 'sqlite') return sql;
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function query<T>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return db.query<T>(parameterize(db, sql), params);
}

export class DestinationResolver {
  constructor(private readonly db: DbAdapter) {}

  /** The contact pin's remote team half resolves by immutable ID only. */
  async resolveDestinationTeam(destinationTeamId: string): Promise<DestinationTeamResolution> {
    const result = await query<{ id: string }>(
      this.db,
      `SELECT id FROM teams WHERE id = ?`,
      [destinationTeamId],
    );
    return result.rows[0]
      ? { ok: true, teamId: result.rows[0].id }
      : { ok: false, code: 'target_identity_missing' };
  }

  async getAgent(agentId: string): Promise<ResolvableAgentRow | null> {
    const result = await query<ResolvableAgentRow>(
      this.db,
      `SELECT id, team_id, name, status, deleted_at, runtime, metadata FROM agents WHERE id = ?`,
      [agentId],
    );
    return result.rows[0] ?? null;
  }

  async getTeamLeadAgentId(teamId: string): Promise<string | null> {
    const result = await query<{ lead_agent_id: string | null }>(
      this.db,
      `SELECT lead_agent_id FROM teams WHERE id = ?`,
      [teamId],
    );
    return result.rows[0]?.lead_agent_id ?? null;
  }

  /**
   * Resolve a NEW send's recipient inside an already-resolved destination
   * team. A team destination checks only that it can route right now — the
   * message stays bound to the team and re-resolves at processing time. An
   * agent destination returns the immutable agent ID that acceptance pins.
   */
  async resolveNewSendRecipient(
    destinationTeamId: string,
    destination: Destination,
  ): Promise<NewSendRecipientResolution> {
    if (destination.kind === 'team') {
      const leadAgentId = await this.getTeamLeadAgentId(destinationTeamId);
      if (!leadAgentId) return { ok: false, code: 'team_lead_unavailable' };
      const lead = await this.getAgent(leadAgentId);
      if (!lead || lead.team_id !== destinationTeamId || !isInterTeamAvailable(lead)) {
        return { ok: false, code: 'team_lead_unavailable' };
      }
      return { ok: true, kind: 'team' };
    }

    if (destination.kind === 'agent_id') {
      const agent = await this.getAgent(destination.agentId);
      if (!agent || agent.deleted_at !== null || agent.team_id !== destinationTeamId) {
        return { ok: false, code: 'recipient_not_found' };
      }
      return isInterTeamAvailable(agent)
        ? { ok: true, kind: 'agent', agentId: agent.id }
        : { ok: false, code: 'recipient_unavailable' };
    }

    const matches = await query<ResolvableAgentRow>(
      this.db,
      `SELECT id, team_id, name, status, deleted_at, runtime, metadata FROM agents
       WHERE team_id = ? AND name = ? AND deleted_at IS NULL
       ORDER BY id`,
      [destinationTeamId, destination.agentName],
    );
    if (matches.rows.length === 0) return { ok: false, code: 'recipient_not_found' };
    if (matches.rows.length > 1) return { ok: false, code: 'recipient_ambiguous' };
    const agent = matches.rows[0]!;
    return isInterTeamAvailable(agent)
      ? { ok: true, kind: 'agent', agentId: agent.id }
      : { ok: false, code: 'recipient_unavailable' };
  }
}
