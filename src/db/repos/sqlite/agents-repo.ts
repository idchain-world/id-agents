// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { AgentsRepository } from '../../db-service.js';
import type { AgentRow } from '../../types.js';
import { parseJsonObject, stringifyJson } from '../../db-json.js';
import { parseAgentRef } from '../../../core/agent-identifier.js';

export class SqliteAgentsRepo implements AgentsRepository {
  constructor(private db: DbAdapter) {}

  // ---------------------------------------------------------------------------
  // Row helpers — parse JSON TEXT columns into JS objects on every read
  // ---------------------------------------------------------------------------

  private parseRow(row: any): AgentRow | null {
    if (!row) return null;
    return {
      ...row,
      metadata: parseJsonObject(row.metadata),
      registry: parseJsonObject(row.registry),
    };
  }

  private parseRows(rows: any[]): AgentRow[] {
    return rows.map(r => this.parseRow(r)!);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async getById(agentId: string): Promise<AgentRow | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL`,
      [agentId],
    );
    return this.parseRow(rows[0]);
  }

  async getByName(teamId: string, name: string): Promise<AgentRow | null> {
    // First try exact name match (also check metadata alias)
    const { rows } = await this.db.query(
      `SELECT * FROM agents
       WHERE team_id = ? AND (name = ? OR json_extract(metadata, '$.alias') = ?)
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [teamId, name, name],
    );
    if (rows[0]) return this.parseRow(rows[0]);

    // Fall back to flexible resolution via parseAgentRef
    try {
      const matches = await this.resolve(teamId, name);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        // Return the most recent if ambiguous
        return matches.sort((a, b) => b.created_at - a.created_at)[0];
      }
    } catch {
      // parseAgentRef may throw on invalid format — fall through
    }
    return null;
  }

  async resolve(teamId: string, ref: string, tokenId?: string): Promise<AgentRow[]> {
    try {
      const parsed = parseAgentRef(ref);

      let sql: string;
      let params: unknown[];

      if (parsed.isFullySpecified && parsed.domain) {
        // ENS domain — exact match
        sql = `SELECT * FROM agents
               WHERE team_id = ?
                 AND (LOWER(name) = ? OR LOWER(domain) = ? OR json_extract(metadata, '$.idchain_domain') = ?)
                 AND deleted_at IS NULL`;
        params = [teamId, parsed.domain, parsed.domain, parsed.domain];
      } else if ((parsed.tokenId || tokenId) && parsed.alias) {
        // alias + tokenId — must match both
        const tid = parsed.tokenId || tokenId;
        sql = `SELECT * FROM agents
               WHERE team_id = ?
                 AND token_id = ?
                 AND (LOWER(name) = ? OR LOWER(json_extract(metadata, '$.alias')) = ?)
                 AND deleted_at IS NULL`;
        params = [teamId, tid, parsed.alias, parsed.alias];
      } else if (parsed.tokenId || tokenId) {
        // Just tokenId
        const tid = parsed.tokenId || tokenId;
        sql = `SELECT * FROM agents
               WHERE team_id = ?
                 AND token_id = ?
                 AND deleted_at IS NULL`;
        params = [teamId, tid];
      } else if (parsed.alias) {
        // Just alias — may be ambiguous
        sql = `SELECT * FROM agents
               WHERE team_id = ?
                 AND (LOWER(name) = ? OR LOWER(json_extract(metadata, '$.alias')) = ?)
                 AND deleted_at IS NULL
               ORDER BY created_at DESC`;
        params = [teamId, parsed.alias, parsed.alias];
      } else {
        return [];
      }

      const { rows } = await this.db.query(sql, params);
      return this.parseRows(rows);
    } catch {
      return [];
    }
  }

  async resolveAcrossTeams(ref: string): Promise<AgentRow[]> {
    try {
      const parsed = parseAgentRef(ref);

      let sql: string;
      let params: unknown[];

      if (parsed.isFullySpecified && parsed.domain) {
        sql = `SELECT * FROM agents
               WHERE (LOWER(name) = ? OR LOWER(domain) = ? OR json_extract(metadata, '$.idchain_domain') = ?)
                 AND deleted_at IS NULL`;
        params = [parsed.domain, parsed.domain, parsed.domain];
      } else if (parsed.alias) {
        sql = `SELECT * FROM agents
               WHERE (LOWER(name) = ? OR LOWER(json_extract(metadata, '$.alias')) = ?)
                 AND deleted_at IS NULL
               ORDER BY created_at DESC`;
        params = [parsed.alias, parsed.alias];
      } else {
        return [];
      }

      const { rows } = await this.db.query(sql, params);
      return this.parseRows(rows);
    } catch {
      return [];
    }
  }

  async getForRouting(teamId: string, ref: string, tokenId?: string): Promise<AgentRow | null> {
    try {
      const parsed = parseAgentRef(ref);

      let sql: string;
      let params: unknown[];

      if (parsed.isFullySpecified && parsed.domain) {
        sql = `SELECT * FROM agents
               WHERE team_id = ?
                 AND (LOWER(name) = ? OR LOWER(domain) = ? OR json_extract(metadata, '$.idchain_domain') = ?)
                 AND deleted_at IS NULL
               ORDER BY created_at DESC
               LIMIT 1`;
        params = [teamId, parsed.domain, parsed.domain, parsed.domain];
      } else if ((parsed.tokenId || tokenId) && parsed.alias) {
        const tid = parsed.tokenId || tokenId;
        sql = `SELECT * FROM agents
               WHERE team_id = ?
                 AND token_id = ?
                 AND (LOWER(name) = ? OR LOWER(json_extract(metadata, '$.alias')) = ?)
                 AND deleted_at IS NULL
               ORDER BY created_at DESC
               LIMIT 1`;
        params = [teamId, tid, parsed.alias, parsed.alias];
      } else if (parsed.tokenId || tokenId) {
        const tid = parsed.tokenId || tokenId;
        sql = `SELECT * FROM agents
               WHERE team_id = ?
                 AND token_id = ?
                 AND deleted_at IS NULL
               ORDER BY created_at DESC
               LIMIT 1`;
        params = [teamId, tid];
      } else if (parsed.alias) {
        sql = `SELECT * FROM agents
               WHERE team_id = ?
                 AND (LOWER(name) = ? OR LOWER(json_extract(metadata, '$.alias')) = ?)
                 AND deleted_at IS NULL
               ORDER BY created_at DESC
               LIMIT 1`;
        params = [teamId, parsed.alias, parsed.alias];
      } else {
        return null;
      }

      const { rows } = await this.db.query(sql, params);
      return this.parseRow(rows[0]);
    } catch {
      return null;
    }
  }

  /** Every non-deleted row for the team — no type filter. Export-only; see the interface. */
  async listAll(teamId: string): Promise<AgentRow[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM agents
       WHERE team_id = ?
         AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [teamId],
    );
    return this.parseRows(rows);
  }

  async list(teamId: string, includeAutomator: boolean = false): Promise<AgentRow[]> {
    const typeFilter = includeAutomator ? '' : `AND type != 'automator'`;
    const { rows } = await this.db.query(
      `SELECT * FROM agents
       WHERE team_id = ?
         AND deleted_at IS NULL
         AND (
           type NOT IN ('interactive', 'virtual')
           OR runtime = 'public-agent-remote'
         )
         ${typeFilter}
       ORDER BY created_at DESC`,
      [teamId],
    );
    return this.parseRows(rows);
  }

  async nextPort(): Promise<number> {
    const { rows } = await this.db.query<{ max_port: number | null }>(
      `SELECT MAX(port) as max_port FROM agents
       WHERE deleted_at IS NULL AND type = 'claude' AND port > 0`,
    );
    const maxPort = rows[0]?.max_port ?? null;
    return maxPort ? maxPort + 1 : 4101;
  }

  async count(teamId: string): Promise<string> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT CAST(COUNT(*) AS TEXT) as count FROM agents
       WHERE team_id = ?
         AND deleted_at IS NULL
         AND (
           type NOT IN ('interactive', 'virtual')
           OR runtime = 'public-agent-remote'
         )`,
      [teamId],
    );
    return rows[0]?.count ?? '0';
  }

  async findInteractive(teamId: string): Promise<AgentRow | null> {
    // Newest-first deterministic selection — when a team has multiple
    // interactive rows (e.g. CLI re-registered after a v3 sync), reply
    // routing must pick the most recently created one consistently.
    const { rows } = await this.db.query(
      `SELECT * FROM agents
       WHERE team_id = ? AND type = 'interactive' AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [teamId],
    );
    return this.parseRow(rows[0]);
  }

  async findHeartbeat(teamId: string): Promise<AgentRow[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM agents
       WHERE team_id = ?
         AND json_extract(metadata, '$.heartbeat') = 'true'
         AND deleted_at IS NULL`,
      [teamId],
    );
    return this.parseRows(rows);
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async create(
    agent: Partial<AgentRow> & {
      team_id: string;
      id: string;
      name: string;
      type: string;
      model: string;
      status: string;
      created_at: number;
    },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO agents
         (team_id, id, name, type, model, port, endpoint, working_directory,
          status, created_at, metadata, registry, runtime, token_id, domain, api_key,
          customer_domain, public_endpoint_url, internal_endpoint_url, ssh_target)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agent.team_id,
        agent.id,
        agent.name,
        agent.type,
        agent.model,
        agent.port ?? 0,
        agent.endpoint ?? null,
        agent.working_directory ?? null,
        agent.status,
        agent.created_at,
        stringifyJson(agent.metadata),
        agent.registry ? stringifyJson(agent.registry) : null,
        agent.runtime ?? 'claude-agent-sdk',
        agent.token_id ?? null,
        agent.domain ?? null,
        agent.api_key ?? null,
        agent.customer_domain ?? null,
        agent.public_endpoint_url ?? null,
        agent.internal_endpoint_url ?? null,
        agent.ssh_target ?? null,
      ],
    );
  }

  async upsert(
    agent: Partial<AgentRow> & { team_id: string; id: string; name: string },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO agents
         (team_id, id, name, type, model, port, endpoint, working_directory,
          status, created_at, metadata, registry, runtime, token_id, domain, api_key,
          customer_domain, public_endpoint_url, internal_endpoint_url, ssh_target)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name                 = excluded.name,
         type                 = COALESCE(excluded.type, agents.type),
         endpoint             = COALESCE(excluded.endpoint, agents.endpoint),
         status               = COALESCE(excluded.status, agents.status),
         metadata             = excluded.metadata,
         token_id             = COALESCE(excluded.token_id, agents.token_id),
         domain               = COALESCE(excluded.domain, agents.domain),
         deleted_at           = NULL`,
      [
        agent.team_id,
        agent.id,
        agent.name,
        agent.type ?? 'virtual',
        agent.model ?? 'external',
        agent.port ?? 0,
        agent.endpoint ?? null,
        agent.working_directory ?? null,
        agent.status ?? 'running',
        agent.created_at ?? Date.now(),
        stringifyJson(agent.metadata),
        agent.registry ? stringifyJson(agent.registry) : null,
        agent.runtime ?? 'claude-agent-sdk',
        agent.token_id ?? null,
        agent.domain ?? null,
        agent.api_key ?? null,
        agent.customer_domain ?? null,
        agent.public_endpoint_url ?? null,
        agent.internal_endpoint_url ?? null,
        agent.ssh_target ?? null,
      ],
    );
  }

  async updateIdentity(
    agentId: string,
    fields: {
      name?: string;
      token_id?: string;
      domain?: string;
      endpoint?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (fields.name !== undefined) {
      sets.push(`name = ?`);
      params.push(fields.name);
    }
    if (fields.token_id !== undefined) {
      sets.push(`token_id = ?`);
      params.push(fields.token_id);
    }
    if (fields.domain !== undefined) {
      sets.push(`domain = ?`);
      params.push(fields.domain);
    }
    if (fields.endpoint !== undefined) {
      sets.push(`endpoint = ?`);
      params.push(fields.endpoint);
    }
    if (fields.metadata !== undefined) {
      sets.push(`metadata = ?`);
      params.push(stringifyJson(fields.metadata));
    }

    if (sets.length === 0) return;

    params.push(agentId);
    await this.db.query(
      `UPDATE agents SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
  }

  async updateMetadata(
    agentId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(
      `UPDATE agents SET metadata = ? WHERE id = ?`,
      [stringifyJson(metadata), agentId],
    );
  }

  async updateStatus(
    agentId: string,
    status: string,
    extra?: {
      port?: number;
      endpoint?: string;
      metadata?: Record<string, unknown>;
      model?: string;
      runtime?: string;
    },
  ): Promise<void> {
    const sets: string[] = ['status = ?'];
    const params: unknown[] = [status];

    if (extra?.port !== undefined) {
      sets.push('port = ?');
      params.push(extra.port);
    }
    if (extra?.endpoint !== undefined) {
      sets.push('endpoint = ?');
      params.push(extra.endpoint);
    }
    if (extra?.metadata !== undefined) {
      sets.push('metadata = ?');
      params.push(stringifyJson(extra.metadata));
    }
    if (extra?.model !== undefined) {
      sets.push('model = ?');
      params.push(extra.model);
    }
    if (extra?.runtime !== undefined) {
      sets.push('runtime = ?');
      params.push(extra.runtime);
    }

    params.push(agentId);
    await this.db.query(
      `UPDATE agents SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
  }

  async softDelete(
    teamId: string,
    name: string,
    excludeId: string,
    timestamp: number,
  ): Promise<void> {
    await this.db.query(
      `UPDATE agents SET deleted_at = ?
       WHERE team_id = ? AND name = ?
         AND type IN ('virtual', 'interactive')
         AND id <> ?
         AND deleted_at IS NULL`,
      [timestamp, teamId, name, excludeId],
    );
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM agents WHERE id = ?`,
      [agentId],
    );
  }

  async updateProbeResult(
    agentId: string,
    fields: {
      last_seen?: number | null;
      last_probed_at: number;
      last_error?: string | null;
      consecutive_failures: number;
    },
  ): Promise<void> {
    const sets: string[] = ['last_probed_at = ?', 'consecutive_failures = ?'];
    const params: unknown[] = [fields.last_probed_at, fields.consecutive_failures];

    if ('last_seen' in fields) {
      sets.push('last_seen = ?');
      params.push(fields.last_seen ?? null);
    }
    if ('last_error' in fields) {
      sets.push('last_error = ?');
      params.push(fields.last_error ?? null);
    }

    params.push(agentId);
    await this.db.query(
      `UPDATE agents SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
  }
}
