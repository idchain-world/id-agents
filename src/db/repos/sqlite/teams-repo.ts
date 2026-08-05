// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { DbAdapter } from '../../db-adapter.js';
import type { TeamsRepository } from '../../db-service.js';
import type { TeamRow } from '../../types.js';
import { parseJsonObject, stringifyJson } from '../../db-json.js';

export class SqliteTeamsRepo implements TeamsRepository {
  constructor(private db: DbAdapter) {}

  async getOrCreateTeamId(teamName: string): Promise<string> {
    const name = teamName || 'default';
    const id = randomUUID();
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO teams (id, name) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET name = excluded.name
       RETURNING id`,
      [id, name],
    );
    return rows[0].id;
  }

  async getTeam(teamId: string): Promise<TeamRow | null> {
    const { rows } = await this.db.query<TeamRow>(
      `SELECT id, name, config, port_start, port_end, created_at, inbound_policy, lead_agent_id FROM teams WHERE id = ?`,
      [teamId],
    );
    if (!rows[0]) return null;
    return { ...rows[0], config: parseJsonObject(rows[0].config) };
  }

  async getTeamByName(name: string): Promise<TeamRow | null> {
    const { rows } = await this.db.query<TeamRow>(
      `SELECT id, name, config, port_start, port_end, created_at, inbound_policy, lead_agent_id FROM teams WHERE name = ?`,
      [name],
    );
    if (!rows[0]) return null;
    return { ...rows[0], config: parseJsonObject(rows[0].config) };
  }

  async getConfig(teamId: string): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query<{ config: unknown }>(
      `SELECT config FROM teams WHERE id = ?`,
      [teamId],
    );
    return parseJsonObject(rows[0]?.config);
  }

  async updateConfig(teamId: string, patch: Record<string, unknown>): Promise<void> {
    const current = await this.getConfig(teamId);
    const next = { ...current, ...patch };
    await this.db.query(`UPDATE teams SET config = ? WHERE id = ?`, [
      JSON.stringify(next),
      teamId,
    ]);
  }

  async listTeams(): Promise<TeamRow[]> {
    const { rows } = await this.db.query<TeamRow>(
      `SELECT id, name, config, port_start, port_end, created_at, inbound_policy, lead_agent_id FROM teams ORDER BY created_at DESC`,
    );
    return rows.map(r => ({ ...r, config: parseJsonObject(r.config) }));
  }

  async listTeamsWithConfig(): Promise<TeamRow[]> {
    const { rows } = await this.db.query<TeamRow>(
      `SELECT id, name, config, port_start, port_end, created_at, inbound_policy, lead_agent_id FROM teams ORDER BY created_at DESC`,
    );
    return rows.map(r => ({ ...r, config: parseJsonObject(r.config) }));
  }

  async deleteTeam(teamId: string): Promise<void> {
    await this.db.query(`DELETE FROM teams WHERE id = ?`, [teamId]);
  }
}
