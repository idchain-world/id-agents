// SPDX-License-Identifier: MIT

import type { DbAdapter, QueryResult } from '../db/db-adapter.js';
import { isInterTeamAvailable, DestinationResolver } from './destination-resolver.js';
import { InterteamMessageStore } from './message-store.js';

/**
 * Commit 9 — async processor and recipient lifecycle.
 *
 * Accepted messages are processed after their acceptance transaction, never
 * inside it. A team-addressed message resolves to whoever the team lead is at
 * the moment it is processed; a direct message uses the agent ID pinned at
 * acceptance and is never re-resolved. The durable local-job link (a `queries`
 * row plus `interteam_processing`) exists before the message reports
 * `processing`. A stopped target leaves work `accepted`; a deleted direct
 * recipient is the only agent-level terminal event (`recipient_deleted`).
 * Restart recovery makes no exactly-once claim: the job link is idempotent by
 * deterministic query ID, and `unknown` is entered and left only on durable
 * evidence. Each conversation's request stream is processed serially in
 * position order.
 */

export const INTERTEAM_HANDLER_FAILED = 'handler_failed' as const;
export const INTERTEAM_RECIPIENT_DELETED = 'recipient_deleted' as const;

export interface ProcessorAction {
  messageId: string;
  action:
    | 'dispatched'
    | 'waiting_recipient'
    | 'waiting_stream'
    | 'completed'
    | 'failed_recipient_deleted'
    | 'failed_handler'
    | 'marked_unknown'
    | 'recovered_unknown';
}

export interface DispatchInput {
  localTeamId: string;
  handlerAgentId: string;
  localQueryId: string;
  submitterNodeId: string;
  messageId: string;
  body: unknown;
}

interface PendingMessageRow {
  id: string;
  conversation_pk: string;
  submitter_node_id: string;
  message_id: string;
  position: number;
  recipient_kind: 'team' | 'agent_name' | 'agent_id';
  resolved_agent_id: string | null;
  request_body: string | null;
  status: string;
  destination_team_id: string;
}

function parameterize(db: DbAdapter, sql: string): string {
  if (db.dialect === 'sqlite') return sql;
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function query<T>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return db.query<T>(parameterize(db, sql), params);
}

/** SQLite returns JSON columns as text, Postgres as decoded values. */
function parseJsonColumn(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export class InterTeamProcessor {
  private readonly store: InterteamMessageStore;
  private readonly resolver: DestinationResolver;
  private readonly dispatchFn: (input: DispatchInput) => Promise<void>;

  constructor(
    private readonly db: DbAdapter,
    options: {
      resolver?: DestinationResolver;
      /**
       * Hands the durable query row to the local runtime. The default is a
       * no-op: the row itself is the work item and existing queries machinery
       * delivers it. V1 never dials a worker URL from here.
       */
      dispatchFn?: (input: DispatchInput) => Promise<void>;
    } = {},
  ) {
    this.store = new InterteamMessageStore(db);
    this.resolver = options.resolver ?? new DestinationResolver(db);
    this.dispatchFn = options.dispatchFn ?? (async () => {});
  }

  /** Deterministic, so a restart re-links the same job instead of forking one. */
  static localQueryId(messagePk: string): string {
    return `interteam_${messagePk}`;
  }

  /**
   * One pass: reconcile in-flight work from durable evidence, then start
   * eligible accepted messages. Safe to call after every acceptance, on a
   * timer, and on startup — recovery is the same code path.
   */
  async scan(now = Date.now()): Promise<ProcessorAction[]> {
    const actions: ProcessorAction[] = [];
    actions.push(...await this.reconcile(now));
    actions.push(...await this.startEligible(now));
    return actions;
  }

  private async startEligible(now: number): Promise<ProcessorAction[]> {
    const actions: ProcessorAction[] = [];
    // Lowest accepted position per conversation, serially: a message starts
    // only when every earlier position in its conversation is terminal.
    const candidates = await query<PendingMessageRow>(
      this.db,
      `SELECT m.id, m.conversation_pk, m.submitter_node_id, m.message_id, m.position,
              m.recipient_kind, m.resolved_agent_id, m.request_body, m.status,
              c.destination_team_id
       FROM interteam_messages m
       JOIN interteam_conversations c ON c.id = m.conversation_pk
       WHERE m.status = 'accepted'
         AND NOT EXISTS (
           SELECT 1 FROM interteam_messages earlier
           WHERE earlier.conversation_pk = m.conversation_pk
             AND earlier.position < m.position
             AND earlier.status NOT IN ('completed', 'failed')
         )
       ORDER BY m.accepted_at, m.id`,
      [],
    );

    for (const message of candidates.rows) {
      const inFlight = await query<{ id: string }>(
        this.db,
        `SELECT id FROM interteam_messages
         WHERE conversation_pk = ? AND status IN ('processing', 'unknown')`,
        [message.conversation_pk],
      );
      if (inFlight.rows[0]) {
        actions.push({ messageId: message.message_id, action: 'waiting_stream' });
        continue;
      }

      const target = await this.resolveProcessingTarget(message);
      if (target.kind === 'deleted') {
        await this.store.recordFailed({
          submitterNodeId: message.submitter_node_id,
          messageId: message.message_id,
          failureCode: INTERTEAM_RECIPIENT_DELETED,
          now,
        });
        actions.push({ messageId: message.message_id, action: 'failed_recipient_deleted' });
        continue;
      }
      if (target.kind === 'waiting') {
        actions.push({ messageId: message.message_id, action: 'waiting_recipient' });
        continue;
      }

      const localQueryId = InterTeamProcessor.localQueryId(message.id);
      // Durable job first; `ON CONFLICT DO NOTHING` makes a restart re-link
      // rather than fork. Only then does the message report `processing`.
      await query(
        this.db,
        `INSERT INTO queries (team_id, query_id, agent_id, prompt, status, created, owner_kind, owner_id)
         VALUES (?, ?, ?, ?, 'pending', ?, 'agent', ?)
         ON CONFLICT (team_id, query_id) DO NOTHING`,
        [
          target.teamId,
          localQueryId,
          target.agentId,
          message.request_body ?? 'null',
          now,
          target.agentId,
        ],
      );
      await this.store.recordProcessing({
        submitterNodeId: message.submitter_node_id,
        messageId: message.message_id,
        localTeamId: target.teamId,
        localQueryId,
        handlerAgentId: target.agentId,
        now,
      });
      await this.dispatchFn({
        localTeamId: target.teamId,
        handlerAgentId: target.agentId,
        localQueryId,
        submitterNodeId: message.submitter_node_id,
        messageId: message.message_id,
        body: message.request_body === null ? null : parseJsonColumn(message.request_body),
      });
      actions.push({ messageId: message.message_id, action: 'dispatched' });
    }
    return actions;
  }

  private async resolveProcessingTarget(message: PendingMessageRow): Promise<
    | { kind: 'ready'; teamId: string; agentId: string }
    | { kind: 'waiting' }
    | { kind: 'deleted' }
  > {
    if (message.recipient_kind === 'team') {
      // Team messages bind to the team: the lead configured at processing
      // time takes the work, so a newly assigned lead picks up the backlog.
      const leadAgentId = await this.resolver.getTeamLeadAgentId(message.destination_team_id);
      if (!leadAgentId) return { kind: 'waiting' };
      const lead = await this.resolver.getAgent(leadAgentId);
      if (!lead || lead.team_id !== message.destination_team_id || !isInterTeamAvailable(lead)) {
        return { kind: 'waiting' };
      }
      return { kind: 'ready', teamId: message.destination_team_id, agentId: lead.id };
    }

    // Direct work is pinned at acceptance and never re-resolved.
    const pinned = message.resolved_agent_id;
    if (!pinned) return { kind: 'deleted' };
    const agent = await this.resolver.getAgent(pinned);
    if (!agent || agent.deleted_at !== null) return { kind: 'deleted' };
    if (!isInterTeamAvailable(agent)) return { kind: 'waiting' };
    return { kind: 'ready', teamId: agent.team_id, agentId: agent.id };
  }

  private async reconcile(now: number): Promise<ProcessorAction[]> {
    const actions: ProcessorAction[] = [];
    const inFlight = await query<PendingMessageRow & { local_team_id?: string; local_query_id?: string }>(
      this.db,
      `SELECT m.id, m.conversation_pk, m.submitter_node_id, m.message_id, m.position,
              m.recipient_kind, m.resolved_agent_id, m.request_body, m.status,
              c.destination_team_id, p.local_team_id, p.local_query_id
       FROM interteam_messages m
       JOIN interteam_conversations c ON c.id = m.conversation_pk
       LEFT JOIN interteam_processing p ON p.message_pk = m.id
       WHERE m.status IN ('processing', 'unknown')
       ORDER BY m.accepted_at, m.id`,
      [],
    );

    for (const message of inFlight.rows) {
      // A deleted pinned direct recipient is terminal regardless of phase.
      if (message.recipient_kind !== 'team' && message.resolved_agent_id) {
        const agent = await this.resolver.getAgent(message.resolved_agent_id);
        if (!agent || agent.deleted_at !== null) {
          await this.store.recordFailed({
            submitterNodeId: message.submitter_node_id,
            messageId: message.message_id,
            failureCode: INTERTEAM_RECIPIENT_DELETED,
            now,
          });
          actions.push({ messageId: message.message_id, action: 'failed_recipient_deleted' });
          continue;
        }
      }

      if (!message.local_team_id || !message.local_query_id) {
        // Processing without a job link should be unreachable (the commit-5
        // trigger requires the link); treat it as lost evidence.
        if (message.status === 'processing') {
          await this.store.markUnknown(message.submitter_node_id, message.message_id, now);
          actions.push({ messageId: message.message_id, action: 'marked_unknown' });
        }
        continue;
      }

      const job = await query<{ status: string; result: string | null; error: string | null }>(
        this.db,
        `SELECT status, result, error FROM queries WHERE team_id = ? AND query_id = ?`,
        [message.local_team_id, message.local_query_id],
      );
      const row = job.rows[0];
      if (!row) {
        // The durable evidence vanished. Enter unknown on that evidence loss;
        // never guess an outcome.
        if (message.status === 'processing') {
          await this.store.markUnknown(message.submitter_node_id, message.message_id, now);
          actions.push({ messageId: message.message_id, action: 'marked_unknown' });
        }
        continue;
      }

      if (row.status === 'completed') {
        // Durable result exists before the message may report completed. An
        // absent result column is an explicit empty result, not a missing one.
        const value = row.result === null ? null : parseJsonColumn(row.result);
        await this.store.recordCompleted({
          submitterNodeId: message.submitter_node_id,
          messageId: message.message_id,
          result: value,
          now,
        });
        actions.push({
          messageId: message.message_id,
          action: message.status === 'unknown' ? 'recovered_unknown' : 'completed',
        });
      } else if (row.status === 'failed' || row.status === 'error') {
        await this.store.recordFailed({
          submitterNodeId: message.submitter_node_id,
          messageId: message.message_id,
          failureCode: INTERTEAM_HANDLER_FAILED,
          now,
        });
        actions.push({ messageId: message.message_id, action: 'failed_handler' });
      }
      // pending/processing job rows: the work is with the runtime; wait.
    }
    return actions;
  }
}
