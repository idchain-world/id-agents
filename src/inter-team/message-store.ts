// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { DbAdapter, QueryResult } from '../db/db-adapter.js';
import {
  collectMessage as collectProtocolMessage,
  recognizedEnvelopeIdentity,
  type CollectionResult,
  type Destination,
  type InterTeamRequestEnvelope,
  type MessageState,
} from './protocol.js';

export const INTERTEAM_COMPACT_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const INTERTEAM_DELETE_AFTER_MS = 365 * 24 * 60 * 60 * 1000;
export const OWNER_FORCE_DELETED = 'owner_force_deleted' as const;

type LastConfirmedState = 'accepted' | 'processing' | 'completed' | 'failed';
type RetentionTier = 'retained' | 'compacted';

interface ConversationRow {
  id: string;
  conversation_id: string;
  origin_node_id: string;
  origin_team_id: string;
  destination_node_id: string;
  destination_team_id: string;
  destination_kind: Destination['kind'];
  destination_agent_id: string | null;
  destination_name_at_acceptance: string | null;
  next_position: number;
  predecessor_message_id: string | null;
}

interface MessageRow {
  id: string;
  conversation_pk: string;
  submitter_node_id: string;
  submitter_team_id: string;
  claimed_sender_name: string | null;
  message_id: string;
  position: number;
  predecessor_message_id: string | null;
  comparison_identity: string;
  request_body: unknown;
  status: MessageState;
  last_confirmed_status: LastConfirmedState;
  failure_code: string | null;
  result_payload: unknown;
  result_present: boolean | number;
  retention_tier: RetentionTier;
  terminal_at: number | string | null;
}

interface ReceiptRow {
  submitter_node_id: string;
  message_id: string;
  conversation_pk: string;
  comparison_identity: string;
  status: 'completed' | 'failed';
  last_confirmed_status: 'completed' | 'failed';
}

export interface SenderAttribution {
  agentId: string;
  nameAtSend: string | null;
}

export type AcceptRequestResult =
  | { kind: 'accepted'; status: 'accepted'; retention: 'retained'; messageId: string }
  | {
      kind: 'deduplicated';
      status: MessageState;
      retention: 'retained' | 'compacted' | 'receipt';
      messageId: string;
    }
  | {
      kind: 'error';
      code: 'idempotency_conflict' | 'conversation_order_conflict' | 'conversation_not_found' | 'receiver_busy';
    };

export type CollectStoredResult =
  | { ok: true; value: CollectionResult }
  | { ok: false; code: 'conversation_not_found' };

function parameterize(db: DbAdapter, sql: string): string {
  if (db.dialect === 'sqlite') return sql;
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function query<T>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return db.query<T>(parameterize(db, sql), params);
}

async function inTransaction<T>(db: DbAdapter, callback: (tx: DbAdapter) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new Error('database transaction support is required');
  return db.transaction(callback);
}

function jsonValue(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('interteam_payload_corrupt');
  }
}

function destinationFields(destination: Destination): {
  kind: Destination['kind'];
  name: string | null;
  agentId: string | null;
} {
  if (destination.kind === 'team') return { kind: 'team', name: null, agentId: null };
  if (destination.kind === 'agent_name') {
    return { kind: 'agent_name', name: destination.agentName, agentId: null };
  }
  return { kind: 'agent_id', name: null, agentId: destination.agentId };
}

function retainedFlag(db: DbAdapter, value: boolean): boolean | number {
  return db.dialect === 'sqlite' ? (value ? 1 : 0) : value;
}

function deduplicated(row: MessageRow): AcceptRequestResult {
  return {
    kind: 'deduplicated',
    status: row.status,
    retention: row.retention_tier,
    messageId: row.message_id,
  };
}

/** Commit-5 durable repository. Admission policy and transport orchestration land later. */
export class InterteamMessageStore {
  constructor(private readonly db: DbAdapter) {}

  async allocateOriginIds(nodeId: string, now = Date.now()): Promise<{
    conversationId: string;
    messageId: string;
  }> {
    return inTransaction(this.db, async (tx) => {
      const conversationId = randomUUID();
      const messageId = randomUUID();
      await query(
        tx,
        `INSERT INTO interteam_origin_allocations (node_id, id_kind, allocated_id, created_at)
         VALUES (?, 'conversation', ?, ?)`,
        [nodeId, conversationId, now],
      );
      await query(
        tx,
        `INSERT INTO interteam_origin_allocations (node_id, id_kind, allocated_id, created_at)
         VALUES (?, 'message', ?, ?)`,
        [nodeId, messageId, now],
      );
      return { conversationId, messageId };
    });
  }

  async isOriginIdAllocated(nodeId: string, kind: 'conversation' | 'message', id: string): Promise<boolean> {
    const result = await query<{ allocated_id: string }>(
      this.db,
      `SELECT allocated_id FROM interteam_origin_allocations
       WHERE node_id = ? AND id_kind = ? AND allocated_id = ?`,
      [nodeId, kind, id],
    );
    return Boolean(result.rows[0]);
  }

  /**
   * Persist origin-local display attribution after the receiver durably
   * accepts a submission. The ID is deliberately absent from the envelope;
   * the published name is deliberately absent from recognized envelope
   * identity. First acceptance wins; a retry by a different teammate cannot
   * rewrite the original sender.
   */
  async recordOriginSubmission(input: {
    originNodeId: string;
    originTeamId: string;
    conversationId: string;
    messageId: string;
    sender: SenderAttribution | null;
    now?: number;
  }): Promise<void> {
    const conflict = this.db.dialect === 'sqlite'
      ? `ON CONFLICT(origin_node_id, message_id) DO NOTHING`
      : `ON CONFLICT (origin_node_id, message_id) DO NOTHING`;
    await query(
      this.db,
      `INSERT INTO interteam_origin_submissions
         (origin_node_id, origin_team_id, conversation_id, message_id,
          sender_agent_id, sender_name_at_send, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ${conflict}`,
      [
        input.originNodeId,
        input.originTeamId,
        input.conversationId,
        input.messageId,
        input.sender?.agentId ?? null,
        input.sender?.nameAtSend ?? null,
        input.now ?? Date.now(),
      ],
    );
  }

  async originSender(originNodeId: string, messageId: string): Promise<SenderAttribution | null> {
    const result = await query<{ sender_agent_id: string | null; sender_name_at_send: string | null }>(
      this.db,
      `SELECT sender_agent_id, sender_name_at_send
       FROM interteam_origin_submissions
       WHERE origin_node_id = ? AND message_id = ?`,
      [originNodeId, messageId],
    );
    const row = result.rows[0];
    if (!row?.sender_agent_id) return null;
    return { agentId: row.sender_agent_id, nameAtSend: row.sender_name_at_send };
  }

  async acceptRequest(input: {
    envelope: InterTeamRequestEnvelope;
    resolvedAgentId?: string | null;
    now?: number;
    /**
     * Capacity admission, evaluated inside the acceptance transaction after
     * every dedup/participant/order check has passed and immediately before
     * the durable insert, so concurrent submissions cannot both pass a bound
     * that only admits one. Returning a code rejects without allocating state.
     */
    admission?: (tx: DbAdapter) => Promise<'receiver_busy' | null>;
  }): Promise<AcceptRequestResult> {
    const envelope = input.envelope;
    const comparisonIdentity = recognizedEnvelopeIdentity(envelope);
    const now = input.now ?? Date.now();
    return inTransaction(this.db, async (tx) => {
      const receiptResult = await query<ReceiptRow>(
        tx,
        `SELECT * FROM interteam_message_receipts
         WHERE submitter_node_id = ? AND message_id = ?`,
        [envelope.originNodeId, envelope.messageId],
      );
      const receipt = receiptResult.rows[0];
      if (receipt) {
        if (receipt.comparison_identity !== comparisonIdentity) {
          return { kind: 'error', code: 'idempotency_conflict' };
        }
        return {
          kind: 'deduplicated',
          status: receipt.status,
          retention: 'receipt',
          messageId: receipt.message_id,
        };
      }

      const existingResult = await query<MessageRow>(
        tx,
        `SELECT * FROM interteam_messages WHERE submitter_node_id = ? AND message_id = ?`,
        [envelope.originNodeId, envelope.messageId],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        return existing.comparison_identity === comparisonIdentity
          ? deduplicated(existing)
          : { kind: 'error', code: 'idempotency_conflict' };
      }

      const conversationResult = await query<ConversationRow>(
        tx,
        `SELECT * FROM interteam_conversations
         WHERE origin_node_id = ? AND conversation_id = ?`,
        [envelope.originNodeId, envelope.conversationId],
      );
      let conversation = conversationResult.rows[0];
      const destination = destinationFields(envelope.destination);
      const resolvedAgentId = destination.kind === 'agent_id'
        ? destination.agentId
        : (input.resolvedAgentId ?? null);

      if (!conversation) {
        if (envelope.position !== 0 || envelope.predecessorMessageId !== null) {
          return { kind: 'error', code: 'conversation_order_conflict' };
        }
        if (destination.kind !== 'team' && !resolvedAgentId) {
          return { kind: 'error', code: 'conversation_not_found' };
        }
        const id = randomUUID();
        await query(
          tx,
          `INSERT INTO interteam_conversations
             (id, conversation_id, origin_node_id, origin_team_id, destination_node_id,
              destination_team_id, destination_kind, destination_agent_id,
              destination_name_at_acceptance, next_position, predecessor_message_id,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
          [
            id,
            envelope.conversationId,
            envelope.originNodeId,
            envelope.originTeamId,
            envelope.destinationNodeId,
            envelope.destinationTeamId,
            destination.kind,
            resolvedAgentId,
            destination.name,
            now,
            now,
          ],
        );
        conversation = {
          id,
          conversation_id: envelope.conversationId,
          origin_node_id: envelope.originNodeId,
          origin_team_id: envelope.originTeamId,
          destination_node_id: envelope.destinationNodeId,
          destination_team_id: envelope.destinationTeamId,
          destination_kind: destination.kind,
          destination_agent_id: resolvedAgentId,
          destination_name_at_acceptance: destination.name,
          next_position: 0,
          predecessor_message_id: null,
        };
      } else {
        const participantMismatch = conversation.origin_team_id !== envelope.originTeamId
          || conversation.destination_node_id !== envelope.destinationNodeId
          || conversation.destination_team_id !== envelope.destinationTeamId
          || conversation.destination_kind !== destination.kind
          || conversation.destination_name_at_acceptance !== destination.name
          || (
            conversation.destination_kind === 'agent_id'
            && conversation.destination_agent_id !== destination.agentId
          )
          || (
            conversation.destination_kind === 'agent_name'
            && input.resolvedAgentId !== undefined
            && conversation.destination_agent_id !== input.resolvedAgentId
          );
        if (participantMismatch) return { kind: 'error', code: 'conversation_not_found' };
      }

      if (
        conversation.next_position !== envelope.position
        || conversation.predecessor_message_id !== envelope.predecessorMessageId
      ) {
        return { kind: 'error', code: 'conversation_order_conflict' };
      }

      if (input.admission) {
        const rejection = await input.admission(tx);
        if (rejection) return { kind: 'error', code: rejection };
      }

      const messagePk = randomUUID();
      await query(
        tx,
        `INSERT INTO interteam_messages
           (id, conversation_pk, submitter_node_id, submitter_team_id,
            claimed_sender_name, message_id,
            position, predecessor_message_id, recipient_kind,
            recipient_name_at_acceptance, resolved_agent_id, comparison_identity,
            request_body, status, last_confirmed_status, result_present,
            retention_tier, accepted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 'accepted', ?,
                 'retained', ?, ?)`,
        [
          messagePk,
          conversation.id,
          envelope.originNodeId,
          envelope.originTeamId,
          typeof envelope.senderName === 'string' ? envelope.senderName : null,
          envelope.messageId,
          envelope.position,
          envelope.predecessorMessageId,
          destination.kind,
          destination.name,
          conversation.destination_agent_id,
          comparisonIdentity,
          jsonValue(envelope.body),
          retainedFlag(tx, false),
          now,
          now,
        ],
      );
      await query(
        tx,
        `UPDATE interteam_conversations
         SET next_position = ?, predecessor_message_id = ?, updated_at = ?
         WHERE id = ?`,
        [envelope.position + 1, envelope.messageId, now, conversation.id],
      );
      return { kind: 'accepted', status: 'accepted', retention: 'retained', messageId: envelope.messageId };
    });
  }

  private async messageByIdentity(db: DbAdapter, submitterNodeId: string, messageId: string): Promise<MessageRow> {
    const result = await query<MessageRow>(
      db,
      `SELECT * FROM interteam_messages WHERE submitter_node_id = ? AND message_id = ?`,
      [submitterNodeId, messageId],
    );
    if (!result.rows[0]) throw new Error('interteam_message_not_found');
    return result.rows[0];
  }

  async recordProcessing(input: {
    submitterNodeId: string;
    messageId: string;
    localTeamId: string;
    localQueryId: string;
    handlerAgentId: string;
    now?: number;
    /**
     * Creates the durable local job inside this transaction, so the query
     * row, the link, and the `processing` transition commit or roll back
     * together. A crash can no longer leave a job owned by one handler and
     * an unlinked message resolving to another.
     */
    ensureJob?: (tx: DbAdapter) => Promise<void>;
    /** Allows re-linking a message that is already processing (job replacement). */
    allowRelink?: boolean;
  }): Promise<void> {
    const now = input.now ?? Date.now();
    await inTransaction(this.db, async (tx) => {
      const message = await this.messageByIdentity(tx, input.submitterNodeId, input.messageId);
      const expected = input.allowRelink ? ['accepted', 'processing'] : ['accepted'];
      if (!expected.includes(message.status)) throw new Error('interteam_transition_invalid');
      if (input.ensureJob) await input.ensureJob(tx);
      if (input.allowRelink) {
        await query(tx, `DELETE FROM interteam_processing WHERE message_pk = ?`, [message.id]);
      }
      const durableQuery = await query<{ query_id: string }>(
        tx,
        `SELECT query_id FROM queries
         WHERE team_id = ? AND query_id = ? AND agent_id = ?`,
        [input.localTeamId, input.localQueryId, input.handlerAgentId],
      );
      if (!durableQuery.rows[0]) throw new Error('durable_job_missing');
      await query(
        tx,
        `INSERT INTO interteam_processing
           (message_pk, local_team_id, local_query_id, handler_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [message.id, input.localTeamId, input.localQueryId, input.handlerAgentId, now, now],
      );
      await query(
        tx,
        `UPDATE interteam_messages
         SET status = 'processing', last_confirmed_status = 'processing',
             processing_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, message.id],
      );
    });
  }

  async markUnknown(submitterNodeId: string, messageId: string, now = Date.now()): Promise<void> {
    await inTransaction(this.db, async (tx) => {
      const message = await this.messageByIdentity(tx, submitterNodeId, messageId);
      if (message.status !== 'accepted' && message.status !== 'processing') {
        throw new Error('interteam_transition_invalid');
      }
      await query(
        tx,
        `UPDATE interteam_messages SET status = 'unknown', updated_at = ? WHERE id = ?`,
        [now, message.id],
      );
    });
  }

  async recordCompleted(input: {
    submitterNodeId: string;
    messageId: string;
    result: unknown;
    now?: number;
  }): Promise<void> {
    if (!Object.prototype.hasOwnProperty.call(input, 'result') || input.result === undefined) {
      throw new Error('durable_result_required');
    }
    const now = input.now ?? Date.now();
    await inTransaction(this.db, async (tx) => {
      const message = await this.messageByIdentity(tx, input.submitterNodeId, input.messageId);
      if (message.status !== 'processing' && message.status !== 'unknown') {
        throw new Error('interteam_transition_invalid');
      }
      const mapping = await query<{ message_pk: string }>(
        tx,
        `SELECT message_pk FROM interteam_processing WHERE message_pk = ?`,
        [message.id],
      );
      if (!mapping.rows[0]) throw new Error('durable_job_missing');
      await query(
        tx,
        `UPDATE interteam_messages
         SET status = 'completed', last_confirmed_status = 'completed',
             result_payload = ?, result_present = ?, terminal_at = ?, compact_after = ?,
             delete_after = ?, updated_at = ?
         WHERE id = ?`,
        [
          jsonValue(input.result),
          retainedFlag(tx, true),
          now,
          now + INTERTEAM_COMPACT_AFTER_MS,
          now + INTERTEAM_DELETE_AFTER_MS,
          now,
          message.id,
        ],
      );
    });
  }

  async recordFailed(input: {
    submitterNodeId: string;
    messageId: string;
    failureCode: string;
    now?: number;
  }): Promise<void> {
    if (!input.failureCode.trim()) throw new Error('failure_code_required');
    const now = input.now ?? Date.now();
    await inTransaction(this.db, async (tx) => {
      const message = await this.messageByIdentity(tx, input.submitterNodeId, input.messageId);
      if (!['accepted', 'processing', 'unknown'].includes(message.status)) {
        throw new Error('interteam_transition_invalid');
      }
      await query(
        tx,
        `UPDATE interteam_messages
         SET status = 'failed', last_confirmed_status = 'failed', failure_code = ?,
             terminal_at = ?, compact_after = ?, delete_after = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.failureCode,
          now,
          now + INTERTEAM_COMPACT_AFTER_MS,
          now + INTERTEAM_DELETE_AFTER_MS,
          now,
          message.id,
        ],
      );
    });
  }

  async collect(input: {
    originNodeId: string;
    originTeamId: string;
    destinationTeamId: string;
    conversationId: string;
    messageId: string;
  }): Promise<CollectStoredResult> {
    const conversationResult = await query<ConversationRow>(
      this.db,
      `SELECT * FROM interteam_conversations
       WHERE origin_node_id = ? AND conversation_id = ?
         AND origin_team_id = ? AND destination_team_id = ?`,
      [input.originNodeId, input.conversationId, input.originTeamId, input.destinationTeamId],
    );
    const conversation = conversationResult.rows[0];
    if (!conversation) return { ok: false, code: 'conversation_not_found' };
    const localTeam = await query<{ id: string }>(
      this.db,
      `SELECT id FROM teams WHERE id = ?`,
      [conversation.destination_team_id],
    );
    if (!localTeam.rows[0]) return { ok: false, code: 'conversation_not_found' };
    const identity = await query<{ node_id: string }>(
      this.db,
      `SELECT node_id FROM manager_identity WHERE singleton_key = 1`,
    );
    if (identity.rows[0]?.node_id === conversation.origin_node_id) {
      const localOriginTeam = await query<{ id: string }>(
        this.db,
        `SELECT id FROM teams WHERE id = ?`,
        [conversation.origin_team_id],
      );
      if (!localOriginTeam.rows[0]) return { ok: false, code: 'conversation_not_found' };
    }

    const messageResult = await query<MessageRow>(
      this.db,
      `SELECT * FROM interteam_messages
       WHERE conversation_pk = ? AND submitter_node_id = ? AND message_id = ?`,
      [conversation.id, input.originNodeId, input.messageId],
    );
    const message = messageResult.rows[0];
    if (message) {
      if (message.status === 'completed') {
        return {
          ok: true,
          value: collectProtocolMessage({
            state: 'completed',
            lastConfirmedState: 'completed',
            retention: message.retention_tier,
            ...(message.retention_tier === 'retained' && Boolean(message.result_present)
              ? { durableResult: { value: parseJsonValue(message.result_payload) } }
              : {}),
          }),
        };
      }
      if (message.status === 'failed') {
        return {
          ok: true,
          value: collectProtocolMessage({
            state: 'failed',
            lastConfirmedState: 'failed',
            retention: message.retention_tier,
            ...(message.failure_code ? { failureCode: message.failure_code } : {}),
          }),
        };
      }
      return {
        ok: true,
        value: collectProtocolMessage({
          state: message.status,
          lastConfirmedState: message.last_confirmed_status,
        }),
      };
    }

    const receiptResult = await query<ReceiptRow>(
      this.db,
      `SELECT * FROM interteam_message_receipts
       WHERE conversation_pk = ? AND submitter_node_id = ? AND message_id = ?`,
      [conversation.id, input.originNodeId, input.messageId],
    );
    const receipt = receiptResult.rows[0];
    if (!receipt) return { ok: false, code: 'conversation_not_found' };
    return {
      ok: true,
      value: collectProtocolMessage({
        state: receipt.status,
        lastConfirmedState: receipt.last_confirmed_status,
        retention: 'receipt',
      }),
    };
  }

  private async deleteLinkedQuery(tx: DbAdapter, messagePk: string): Promise<void> {
    const mappings = await query<{ local_team_id: string; local_query_id: string }>(
      tx,
      `SELECT local_team_id, local_query_id FROM interteam_processing WHERE message_pk = ?`,
      [messagePk],
    );
    for (const mapping of mappings.rows) {
      await query(
        tx,
        `DELETE FROM queries WHERE team_id = ? AND query_id = ?`,
        [mapping.local_team_id, mapping.local_query_id],
      );
    }
  }

  async runRetentionSweep(input: {
    now?: number;
    batchSize?: number;
  } = {}): Promise<{ compacted: number; deleted: number; incrementalVacuum: boolean }> {
    const now = input.now ?? Date.now();
    const batchSize = Math.max(1, Math.min(input.batchSize ?? 100, 1_000));
    const counts = await inTransaction(this.db, async (tx) => {
      const compactCandidates = await query<MessageRow>(
        tx,
        `SELECT * FROM interteam_messages
         WHERE status IN ('completed', 'failed') AND retention_tier = 'retained'
           AND compact_after IS NOT NULL AND compact_after <= ?
         ORDER BY compact_after, id LIMIT ?`,
        [now, batchSize],
      );
      for (const message of compactCandidates.rows) {
        await this.deleteLinkedQuery(tx, message.id);
        await query(
          tx,
          `UPDATE interteam_messages
           SET request_body = NULL, result_payload = NULL, result_present = ?,
               retention_tier = 'compacted', updated_at = ?
           WHERE id = ?`,
          [retainedFlag(tx, false), now, message.id],
        );
      }

      const deleteCandidates = await query<MessageRow>(
        tx,
        `SELECT * FROM interteam_messages
         WHERE status IN ('completed', 'failed')
           AND delete_after IS NOT NULL AND delete_after <= ?
         ORDER BY delete_after, id LIMIT ?`,
        [now, batchSize],
      );
      for (const message of deleteCandidates.rows) {
        await this.deleteLinkedQuery(tx, message.id);
        await query(
          tx,
          `INSERT INTO interteam_message_receipts
             (submitter_node_id, message_id, conversation_pk, comparison_identity,
              position, predecessor_message_id, status, last_confirmed_status,
              terminal_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            message.submitter_node_id,
            message.message_id,
            message.conversation_pk,
            message.comparison_identity,
            message.position,
            message.predecessor_message_id,
            message.status,
            message.last_confirmed_status,
            Number(message.terminal_at),
            now,
          ],
        );
        await query(tx, `DELETE FROM interteam_messages WHERE id = ?`, [message.id]);
      }
      return { compacted: compactCandidates.rows.length, deleted: deleteCandidates.rows.length };
    });

    let incrementalVacuum = false;
    if (this.db.dialect === 'sqlite') {
      const pragma = await query<{ auto_vacuum: number }>(
        this.db,
        `SELECT auto_vacuum FROM pragma_auto_vacuum`,
      );
      if (Number(pragma.rows[0]?.auto_vacuum) === 2) {
        const sqlite = this.db as DbAdapter & { exec?: (sql: string) => void };
        sqlite.exec?.('PRAGMA incremental_vacuum(100)');
        incrementalVacuum = true;
      }
    }
    return { ...counts, incrementalVacuum };
  }

  /** Explicit operator action: this performs the one locking, file-rewriting VACUUM. */
  async initializeSqliteIncrementalVacuum(): Promise<void> {
    if (this.db.dialect !== 'sqlite') throw new Error('sqlite_only_operation');
    const sqlite = this.db as DbAdapter & { exec?: (sql: string) => void };
    if (!sqlite.exec) throw new Error('sqlite_exec_unavailable');
    sqlite.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;');
    const pragma = await query<{ auto_vacuum: number }>(this.db, `SELECT auto_vacuum FROM pragma_auto_vacuum`);
    if (Number(pragma.rows[0]?.auto_vacuum) !== 2) throw new Error('incremental_vacuum_initialization_failed');
  }

  async forceDeleteTeam(teamId: string, now = Date.now()): Promise<boolean> {
    return inTransaction(this.db, async (tx) => {
      const team = await query<{ id: string }>(tx, `SELECT id FROM teams WHERE id = ?`, [teamId]);
      if (!team.rows[0]) return false;
      const active = await query<{ id: string }>(
        tx,
        `SELECT m.id
         FROM interteam_messages m
         JOIN interteam_conversations c ON c.id = m.conversation_pk
         WHERE (c.origin_team_id = ? OR c.destination_team_id = ?)
           AND m.status IN ('accepted', 'processing', 'unknown')`,
        [teamId, teamId],
      );
      for (const message of active.rows) {
        await query(
          tx,
          `UPDATE interteam_messages
           SET status = 'failed', last_confirmed_status = 'failed', failure_code = ?,
               terminal_at = ?, compact_after = ?, delete_after = ?, updated_at = ?
           WHERE id = ?`,
          [
            OWNER_FORCE_DELETED,
            now,
            now + INTERTEAM_COMPACT_AFTER_MS,
            now + INTERTEAM_DELETE_AFTER_MS,
            now,
            message.id,
          ],
        );
      }
      await query(tx, `DELETE FROM teams WHERE id = ?`, [teamId]);
      return true;
    });
  }
}
