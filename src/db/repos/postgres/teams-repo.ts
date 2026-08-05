// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { TeamsRepository } from '../../db-service.js';
import type { TeamRow } from '../../types.js';
import type { DbAdapter } from '../../db-adapter.js';

export class PgTeamsRepo implements TeamsRepository {
  constructor(private readonly db: DbAdapter) {}

  async getOrCreateTeamId(teamName: string): Promise<string> {
    const name = teamName || 'default';
    const r = await this.db.query<{ id: string }>(
      'INSERT INTO teams (id, name) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
      [randomUUID(), name],
    );
    return r.rows[0].id;
  }

  async getTeam(teamId: string): Promise<TeamRow | null> {
    const r = await this.db.query<TeamRow>(
      'SELECT id, name, config, port_start, port_end, created_at, inbound_policy, lead_agent_id FROM teams WHERE id = $1',
      [teamId],
    );
    return r.rows[0] || null;
  }

  async getTeamByName(name: string): Promise<TeamRow | null> {
    const r = await this.db.query<TeamRow>(
      'SELECT id, name, config, port_start, port_end, created_at, inbound_policy, lead_agent_id FROM teams WHERE name = $1',
      [name],
    );
    return r.rows[0] || null;
  }

  async updateConfig(teamId: string, patch: Record<string, unknown>): Promise<void> {
    const current = await this.getConfig(teamId);
    const next = { ...current, ...patch };
    await this.db.query('UPDATE teams SET config = $1 WHERE id = $2', [
      JSON.stringify(next),
      teamId,
    ]);
  }

  async getConfig(teamId: string): Promise<Record<string, unknown>> {
    const r = await this.db.query<{ config: Record<string, unknown> | null }>(
      'SELECT config FROM teams WHERE id = $1',
      [teamId],
    );
    // PG returns config as a JS object directly (jsonb column)
    return (r.rows[0]?.config as Record<string, unknown>) || {};
  }

  async listTeams(): Promise<TeamRow[]> {
    const r = await this.db.query<TeamRow>(
      'SELECT id, name, config, port_start, port_end, created_at, inbound_policy, lead_agent_id FROM teams ORDER BY created_at DESC',
    );
    return r.rows;
  }

  async listTeamsWithConfig(): Promise<TeamRow[]> {
    const r = await this.db.query<TeamRow>(
      'SELECT id, name, config, port_start, port_end, created_at, inbound_policy, lead_agent_id FROM teams ORDER BY created_at DESC',
    );
    return r.rows;
  }

  async deleteTeam(teamId: string): Promise<void> {
    await this.db.query('DELETE FROM teams WHERE id = $1', [teamId]);
  }
}
