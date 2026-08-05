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
    | 'recovered_unknown'
    | 'waiting_capacity'
    | 'redispatched_abandoned_job';
}

export interface DispatchInput {
  localTeamId: string;
  handlerAgentId: string;
  localQueryId: string;
  submitterNodeId: string;
  messageId: string;
  body: unknown;
}

/** Local job states that mean the handler will never answer this job. */
const ABANDONED_JOB_STATUSES = new Set(['cancelled', 'canceled', 'expired']);

export const DEFAULT_MAX_CONCURRENT_DISPATCH = 4;

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
      /** Cap on messages dispatched in one scan pass. */
      maxConcurrentDispatch?: number;
    } = {},
  ) {
    this.store = new InterteamMessageStore(db);
    this.resolver = options.resolver ?? new DestinationResolver(db);
    this.dispatchFn = options.dispatchFn ?? (async () => {});
    this.maxConcurrentDispatch = options.maxConcurrentDispatch ?? DEFAULT_MAX_CONCURRENT_DISPATCH;
  }

  private readonly maxConcurrentDispatch: number;

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

    let dispatchedThisPass = 0;
    for (const message of candidates.rows) {
      if (dispatchedThisPass >= this.maxConcurrentDispatch) {
        actions.push({ messageId: message.message_id, action: 'waiting_capacity' });
        continue;
      }
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
      // A crash between job creation and linkage could previously strand the
      // job with an earlier handler. Adopt an existing job's owner instead of
      // resolving a new one, so the deterministic ID can never deadlock.
      const existingJob = await query<{ agent_id: string | null; team_id: string; status: string }>(
        this.db,
        `SELECT agent_id, team_id, status FROM queries WHERE query_id = ?`,
        [localQueryId],
      );
      const orphan = existingJob.rows[0];
      const handlerAgentId = orphan?.agent_id ?? target.agentId;
      const handlerTeamId = orphan?.team_id ?? target.teamId;

      await this.store.recordProcessing({
        submitterNodeId: message.submitter_node_id,
        messageId: message.message_id,
        localTeamId: handlerTeamId,
        localQueryId,
        handlerAgentId,
        now,
        // Job row, link row, and the `processing` transition in one
        // transaction: a crash can no longer split them.
        ensureJob: async (tx) => {
          await query(
            tx,
            `INSERT INTO queries (team_id, query_id, agent_id, prompt, status, created, owner_kind, owner_id)
             VALUES (?, ?, ?, ?, 'pending', ?, 'agent', ?)
             ON CONFLICT (team_id, query_id) DO NOTHING`,
            [handlerTeamId, localQueryId, handlerAgentId, message.request_body ?? 'null', now, handlerAgentId],
          );
        },
      });
      await this.dispatchFn({
        localTeamId: handlerTeamId,
        handlerAgentId,
        localQueryId,
        submitterNodeId: message.submitter_node_id,
        messageId: message.message_id,
        body: message.request_body === null ? null : parseJsonColumn(message.request_body),
      });
      dispatchedThisPass += 1;
      actions.push({ messageId: message.message_id, action: 'dispatched' });
    }
    return actions;
  }

  /**
   * Replace a dead local job (cancelled by an agent stop, or expired by the
   * sweeper) with a fresh one. Returns null while no handler is available,
   * leaving the message processing and unlinked so a later scan retries.
   */
  private async redispatchAbandoned(
    message: PendingMessageRow & { local_team_id?: string; local_query_id?: string },
    now: number,
  ): Promise<ProcessorAction | null> {
    const target = await this.resolveProcessingTarget(message);
    if (target.kind === 'deleted') {
      await this.store.recordFailed({
        submitterNodeId: message.submitter_node_id,
        messageId: message.message_id,
        failureCode: INTERTEAM_RECIPIENT_DELETED,
        now,
      });
      return { messageId: message.message_id, action: 'failed_recipient_deleted' };
    }
    if (target.kind === 'waiting') {
      // Keep the dead job and its link in place: they are the durable record
      // that this message is mid-flight. Removing them would look like lost
      // evidence and wrongly drive the message to `unknown`. A later scan
      // sees the same abandoned job and retries once a handler returns.
      return { messageId: message.message_id, action: 'waiting_recipient' };
    }

    const localQueryId = `${InterTeamProcessor.localQueryId(message.id)}_r${now}`;
    await query(
      this.db,
      `DELETE FROM queries WHERE team_id = ? AND query_id = ?`,
      [message.local_team_id, message.local_query_id],
    );
    await this.store.recordProcessing({
      submitterNodeId: message.submitter_node_id,
      messageId: message.message_id,
      localTeamId: target.teamId,
      localQueryId,
      handlerAgentId: target.agentId,
      now,
      allowRelink: true,
      ensureJob: async (tx) => {
        await query(
          tx,
          `INSERT INTO queries (team_id, query_id, agent_id, prompt, status, created, owner_kind, owner_id)
           VALUES (?, ?, ?, ?, 'pending', ?, 'agent', ?)
           ON CONFLICT (team_id, query_id) DO NOTHING`,
          [target.teamId, localQueryId, target.agentId, message.request_body ?? 'null', now, target.agentId],
        );
      },
    });
    await this.dispatchFn({
      localTeamId: target.teamId,
      handlerAgentId: target.agentId,
      localQueryId,
      submitterNodeId: message.submitter_node_id,
      messageId: message.message_id,
      body: message.request_body === null ? null : parseJsonColumn(message.request_body),
    });
    return { messageId: message.message_id, action: 'redispatched_abandoned_job' };
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
      } else if (ABANDONED_JOB_STATUSES.has(row.status)) {
        // Stopping an agent cancels its queries and the sweeper expires stale
        // ones. Neither is an answer and neither is terminal for us: an
        // accepted message waits for its target. Drop the dead job and
        // re-dispatch when a handler is available again. The message stays
        // `processing` because the receiver still owns the work — the
        // protocol has no accepted <- processing transition.
        const action = await this.redispatchAbandoned(message, now);
        if (action) actions.push(action);
      }
      // pending/processing job rows: the work is with the runtime; wait.
    }
    return actions;
  }
}
