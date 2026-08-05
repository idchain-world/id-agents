// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { DbAdapter, QueryResult } from '../db/db-adapter.js';
import { normalizeOrgKey } from '../org/normalization.js';
import type { InboundPolicy } from './protocol.js';

export interface TeamInterteamSettings {
  teamId: string;
  inboundPolicy: InboundPolicy;
  leadAgentId: string | null;
}

export interface TeamContact {
  id: string;
  localTeamId: string;
  aliasNormalized: string;
  aliasDisplay: string;
  remoteNodeId: string;
  remoteTeamId: string;
  createdAt: number;
  updatedAt: number;
}

interface ContactRow {
  id: string;
  local_team_id: string;
  alias_normalized: string;
  alias_display: string;
  remote_node_id: string;
  remote_team_id: string;
  created_at: number | string;
  updated_at: number | string;
}

function parameterize(db: DbAdapter, sql: string): string {
  if (db.dialect === 'sqlite') return sql;
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function query<T>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return db.query<T>(parameterize(db, sql), params);
}

function contact(row: ContactRow): TeamContact {
  return {
    id: row.id,
    localTeamId: row.local_team_id,
    aliasNormalized: row.alias_normalized,
    aliasDisplay: row.alias_display,
    remoteNodeId: row.remote_node_id,
    remoteTeamId: row.remote_team_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Dialect-neutral commit-4 persistence contract. Operator HTTP APIs land in commit 6. */
export class InterteamFoundationStore {
  constructor(private readonly db: DbAdapter) {}

  async getNodeId(): Promise<string> {
    const result = await query<{ node_id: string }>(
      this.db,
      `SELECT node_id FROM manager_identity WHERE singleton_key = 1`,
    );
    if (!result.rows[0]?.node_id) throw new Error('manager_identity_missing');
    return result.rows[0].node_id;
  }

  async getTeamSettings(teamId: string): Promise<TeamInterteamSettings | null> {
    const result = await query<{
      id: string;
      inbound_policy: InboundPolicy;
      lead_agent_id: string | null;
    }>(this.db, `SELECT id, inbound_policy, lead_agent_id FROM teams WHERE id = ?`, [teamId]);
    const row = result.rows[0];
    return row ? { teamId: row.id, inboundPolicy: row.inbound_policy, leadAgentId: row.lead_agent_id } : null;
  }

  async setInboundPolicy(teamId: string, policy: InboundPolicy): Promise<void> {
    if (policy !== 'open' && policy !== 'closed') throw new Error('inbound_policy_invalid');
    const result = await query(this.db, `UPDATE teams SET inbound_policy = ? WHERE id = ?`, [policy, teamId]);
    if (result.rowCount !== 1) throw new Error('team_not_found');
  }

  async setTeamLead(teamId: string, agentId: string | null): Promise<void> {
    if (agentId !== null) {
      const candidate = await query<{ id: string }>(
        this.db,
        `SELECT id FROM agents WHERE id = ? AND team_id = ? AND deleted_at IS NULL`,
        [agentId, teamId],
      );
      if (!candidate.rows[0]) throw new Error('team_lead_invalid');
    }
    const result = await query(this.db, `UPDATE teams SET lead_agent_id = ? WHERE id = ?`, [agentId, teamId]);
    if (result.rowCount !== 1) throw new Error('team_not_found');
  }

  async createContact(input: {
    localTeamId: string;
    aliasDisplay: string;
    remoteNodeId: string;
    remoteTeamId: string;
    now?: number;
  }): Promise<TeamContact> {
    const id = randomUUID();
    const now = input.now ?? Date.now();
    const aliasNormalized = normalizeOrgKey(input.aliasDisplay);
    if (!aliasNormalized) throw new Error('contact_alias_invalid');
    await query(
      this.db,
      `INSERT INTO team_contacts
         (id, local_team_id, alias_normalized, alias_display, remote_node_id,
          remote_team_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.localTeamId,
        aliasNormalized,
        input.aliasDisplay,
        input.remoteNodeId,
        input.remoteTeamId,
        now,
        now,
      ],
    );
    return (await this.getContactById(id))!;
  }

  async getContactById(id: string): Promise<TeamContact | null> {
    const result = await query<ContactRow>(this.db, `SELECT * FROM team_contacts WHERE id = ?`, [id]);
    return result.rows[0] ? contact(result.rows[0]) : null;
  }

  async getContactByAlias(localTeamId: string, alias: string): Promise<TeamContact | null> {
    const result = await query<ContactRow>(
      this.db,
      `SELECT * FROM team_contacts WHERE local_team_id = ? AND alias_normalized = ?`,
      [localTeamId, normalizeOrgKey(alias)],
    );
    return result.rows[0] ? contact(result.rows[0]) : null;
  }

  async listContacts(localTeamId: string): Promise<TeamContact[]> {
    const result = await query<ContactRow>(
      this.db,
      `SELECT * FROM team_contacts WHERE local_team_id = ? ORDER BY alias_normalized, id`,
      [localTeamId],
    );
    return result.rows.map(contact);
  }

  /** Rename both alias forms atomically; the immutable remote pin is never updated. */
  async renameContact(input: {
    id: string;
    localTeamId: string;
    aliasDisplay: string;
    now?: number;
  }): Promise<TeamContact> {
    const aliasNormalized = normalizeOrgKey(input.aliasDisplay);
    if (!aliasNormalized) throw new Error('contact_alias_invalid');
    const result = await query(
      this.db,
      `UPDATE team_contacts
       SET alias_display = ?, alias_normalized = ?, updated_at = ?
       WHERE id = ? AND local_team_id = ?`,
      [
        input.aliasDisplay,
        aliasNormalized,
        input.now ?? Date.now(),
        input.id,
        input.localTeamId,
      ],
    );
    if (result.rowCount !== 1) throw new Error('contact_not_found');
    return (await this.getContactById(input.id))!;
  }

  async deleteContact(id: string, localTeamId: string): Promise<boolean> {
    const result = await query(
      this.db,
      `DELETE FROM team_contacts WHERE id = ? AND local_team_id = ?`,
      [id, localTeamId],
    );
    return result.rowCount === 1;
  }
}
