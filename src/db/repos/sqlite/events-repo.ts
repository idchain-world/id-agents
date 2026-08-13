// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { EventsRepository } from '../../db-service.js';
import type { EventLogRow } from '../../types.js';
import { parseJsonObject, stringifyJson } from '../../db-json.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export class SqliteEventsRepo implements EventsRepository {
  constructor(private readonly db: DbAdapter) {}

  async insert(event: {
    team_id: string;
    topic: string;
    actor_agent_id?: string | null;
    subject_kind?: string | null;
    subject_id?: string | null;
    occurred_at: number;
    data: Record<string, unknown>;
  }): Promise<{ seq: number }> {
    const { rows } = await this.db.query<{ seq: number }>(
      `INSERT INTO event_log
         (team_id, topic, actor_agent_id, subject_kind, subject_id, occurred_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING seq`,
      [
        event.team_id,
        event.topic,
        event.actor_agent_id ?? null,
        event.subject_kind ?? null,
        event.subject_id ?? null,
        event.occurred_at,
        stringifyJson(event.data),
      ],
    );
    return { seq: Number(rows[0]!.seq) };
  }

  async query(opts: {
    teamId: string;
    sinceSeq?: number;
    topics?: string[];
    limit?: number;
  }): Promise<EventLogRow[]> {
    const limit = clampLimit(opts.limit);
    const params: unknown[] = [opts.teamId];
    let sql = `SELECT seq, team_id, topic, actor_agent_id, subject_kind, subject_id, occurred_at, data
               FROM event_log
               WHERE team_id = ?`;

    if (opts.sinceSeq !== undefined) {
      sql += ` AND seq > ?`;
      params.push(opts.sinceSeq);
    }

    if (opts.topics && opts.topics.length > 0) {
      const placeholders = opts.topics.map(() => '?').join(', ');
      sql += ` AND topic IN (${placeholders})`;
      params.push(...opts.topics);
    }

    sql += ` ORDER BY seq ASC LIMIT ?`;
    params.push(limit);

    const { rows } = await this.db.query<any>(sql, params);
    return rows.map(parseEventRow);
  }

  async earliestSeq(teamId: string): Promise<number | null> {
    const { rows } = await this.db.query<{ seq: number | null }>(
      `SELECT MIN(seq) AS seq FROM event_log WHERE team_id = ?`,
      [teamId],
    );
    const seq = rows[0]?.seq;
    return seq === null || seq === undefined ? null : Number(seq);
  }

  async latestSeq(teamId: string): Promise<number | null> {
    const { rows } = await this.db.query<{ seq: number | null }>(
      `SELECT MAX(seq) AS seq FROM event_log WHERE team_id = ?`,
      [teamId],
    );
    const seq = rows[0]?.seq;
    return seq === null || seq === undefined ? null : Number(seq);
  }

  async pruneByAge(teamId: string, beforeOccurredAt: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM event_log WHERE team_id = ? AND occurred_at < ?`,
      [teamId, beforeOccurredAt],
    );
    return rowCount ?? 0;
  }

  async pruneByCount(teamId: string, keepCount: number): Promise<number> {
    if (keepCount < 0) keepCount = 0;
    const total = await this.countForTeam(teamId);
    const excess = total - keepCount;
    if (excess <= 0) return 0;
    const { rowCount } = await this.db.query(
      `DELETE FROM event_log
       WHERE team_id = ?
         AND seq IN (
           SELECT seq FROM event_log
           WHERE team_id = ?
           ORDER BY seq ASC
           LIMIT ?
         )`,
      [teamId, teamId, excess],
    );
    return rowCount ?? 0;
  }

  async countForTeam(teamId: string): Promise<number> {
    const { rows } = await this.db.query<{ c: number | string }>(
      `SELECT COUNT(*) AS c FROM event_log WHERE team_id = ?`,
      [teamId],
    );
    return Number(rows[0]?.c ?? 0);
  }
}

function clampLimit(limit?: number): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function parseEventRow(row: any): EventLogRow {
  return {
    seq: Number(row.seq),
    team_id: row.team_id,
    topic: row.topic,
    actor_agent_id: row.actor_agent_id ?? null,
    subject_kind: row.subject_kind ?? null,
    subject_id: row.subject_id ?? null,
    occurred_at: Number(row.occurred_at),
    data: parseJsonObject(row.data),
  };
}
