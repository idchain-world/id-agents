// SPDX-License-Identifier: MIT

import type { DbAdapter, QueryResult } from '../db/db-adapter.js';
import type { Destination, InterTeamRequestEnvelope, MessageState } from './protocol.js';

/**
 * Commit 14: the origin's durable record of what it sent.
 *
 * Same-manager delivery can read the destination's rows in one database and
 * federation cannot, so continue, list, resubmit, and collect must all be
 * reconstructable from these rows alone. Recording is uniform for local and
 * remote destinations so the remote path is not a second code path that first
 * executes in production.
 *
 * No address is stored here. Every attempt resolves the current route late, by
 * pinned destination node ID, which is what makes a peer movable without
 * touching message identity.
 */

export type OutboundAttemptState = 'not_attempted' | 'unknown' | 'accepted' | 'rejected';

export interface OutboundConversation {
  originNodeId: string;
  conversationId: string;
  originTeamId: string;
  destinationNodeId: string;
  destinationTeamId: string;
  destinationKind: Destination['kind'];
  destinationAgentId: string | null;
  destinationNameAtAcceptance: string | null;
  nextPosition: number;
  predecessorMessageId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OutboundSubmission {
  originNodeId: string;
  messageId: string;
  conversationId: string;
  originTeamId: string;
  destinationNodeId: string;
  destinationTeamId: string;
  position: number;
  predecessorMessageId: string | null;
  protocolVersion: string;
  firstSubmittedAt: number;
  envelope: InterTeamRequestEnvelope;
  attemptState: OutboundAttemptState;
  lastAttemptAt: number | null;
  lastDiagnostic: string | null;
  lastObservedState: MessageState | null;
  createdAt: number;
  updatedAt: number;
}

interface ConversationRow {
  origin_node_id: string;
  conversation_id: string;
  origin_team_id: string;
  destination_node_id: string;
  destination_team_id: string;
  destination_kind: Destination['kind'];
  destination_agent_id: string | null;
  destination_name_at_acceptance: string | null;
  next_position: number | string;
  predecessor_message_id: string | null;
  created_at: number | string;
  updated_at: number | string;
}

interface SubmissionRow {
  origin_node_id: string;
  message_id: string;
  conversation_id: string;
  origin_team_id: string;
  destination_node_id: string;
  destination_team_id: string;
  position: number | string;
  predecessor_message_id: string | null;
  protocol_version: string;
  first_submitted_at: number | string;
  envelope_json: string | Record<string, unknown>;
  attempt_state: OutboundAttemptState;
  last_attempt_at: number | string | null;
  last_diagnostic: string | null;
  last_observed_state: MessageState | null;
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

function conversation(row: ConversationRow): OutboundConversation {
  return {
    originNodeId: row.origin_node_id,
    conversationId: row.conversation_id,
    originTeamId: row.origin_team_id,
    destinationNodeId: row.destination_node_id,
    destinationTeamId: row.destination_team_id,
    destinationKind: row.destination_kind,
    destinationAgentId: row.destination_agent_id,
    destinationNameAtAcceptance: row.destination_name_at_acceptance,
    nextPosition: Number(row.next_position),
    predecessorMessageId: row.predecessor_message_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function submission(row: SubmissionRow): OutboundSubmission {
  return {
    originNodeId: row.origin_node_id,
    messageId: row.message_id,
    conversationId: row.conversation_id,
    originTeamId: row.origin_team_id,
    destinationNodeId: row.destination_node_id,
    destinationTeamId: row.destination_team_id,
    position: Number(row.position),
    predecessorMessageId: row.predecessor_message_id,
    protocolVersion: row.protocol_version,
    firstSubmittedAt: Number(row.first_submitted_at),
    envelope: (typeof row.envelope_json === 'string'
      ? JSON.parse(row.envelope_json)
      : row.envelope_json) as InterTeamRequestEnvelope,
    attemptState: row.attempt_state,
    lastAttemptAt: row.last_attempt_at === null ? null : Number(row.last_attempt_at),
    lastDiagnostic: row.last_diagnostic,
    lastObservedState: row.last_observed_state,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class InterTeamOutboundStore {
  constructor(private readonly db: DbAdapter) {}

  /**
   * Record the conversation binding and the complete envelope before any
   * transport can observe an attempt. The envelope is stored whole so an
   * identical resubmission needs no reconstruction from parts.
   */
  async recordSubmission(input: {
    envelope: InterTeamRequestEnvelope;
    now?: number;
  }): Promise<OutboundSubmission> {
    const envelope = input.envelope;
    const now = input.now ?? Date.now();
    const destination = envelope.destination;
    const existingConversation = await this.getConversation(envelope.originNodeId, envelope.conversationId);
    if (!existingConversation) {
      await query(
        this.db,
        `INSERT INTO interteam_outbound_conversations
           (origin_node_id, conversation_id, origin_team_id, destination_node_id,
            destination_team_id, destination_kind, destination_agent_id,
            destination_name_at_acceptance, next_position, predecessor_message_id,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
        [
          envelope.originNodeId,
          envelope.conversationId,
          envelope.originTeamId,
          envelope.destinationNodeId,
          envelope.destinationTeamId,
          destination.kind,
          destination.kind === 'agent_id' ? destination.agentId : null,
          destination.kind === 'agent_name' ? destination.agentName : null,
          now,
          now,
        ],
      );
    }

    const existing = await this.getSubmission(envelope.originNodeId, envelope.messageId);
    if (!existing) {
      await query(
        this.db,
        `INSERT INTO interteam_outbound_submissions
           (origin_node_id, message_id, conversation_id, origin_team_id,
            destination_node_id, destination_team_id, position, predecessor_message_id,
            protocol_version, first_submitted_at, envelope_json, attempt_state,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_attempted', ?, ?)`,
        [
          envelope.originNodeId,
          envelope.messageId,
          envelope.conversationId,
          envelope.originTeamId,
          envelope.destinationNodeId,
          envelope.destinationTeamId,
          envelope.position,
          envelope.predecessorMessageId,
          envelope.protocolVersion,
          envelope.firstSubmittedAt,
          JSON.stringify(envelope),
          now,
          now,
        ],
      );
    }
    return (await this.getSubmission(envelope.originNodeId, envelope.messageId))!;
  }

  /**
   * Advance the conversation head only once the destination has durably
   * accepted. A submission whose outcome is unknown must not move the stream.
   */
  async recordAttemptOutcome(input: {
    originNodeId: string;
    messageId: string;
    attemptState: OutboundAttemptState;
    observedState?: MessageState | null;
    diagnostic?: string | null;
    now?: number;
  }): Promise<void> {
    const now = input.now ?? Date.now();
    await query(
      this.db,
      `UPDATE interteam_outbound_submissions
       SET attempt_state = ?, last_attempt_at = ?, last_diagnostic = ?,
           last_observed_state = COALESCE(?, last_observed_state), updated_at = ?
       WHERE origin_node_id = ? AND message_id = ?`,
      [
        input.attemptState,
        now,
        input.diagnostic ?? null,
        input.observedState ?? null,
        now,
        input.originNodeId,
        input.messageId,
      ],
    );
    if (input.attemptState !== 'accepted') return;
    const accepted = await this.getSubmission(input.originNodeId, input.messageId);
    if (!accepted) return;
    await query(
      this.db,
      `UPDATE interteam_outbound_conversations
       SET next_position = ?, predecessor_message_id = ?, updated_at = ?
       WHERE origin_node_id = ? AND conversation_id = ? AND next_position <= ?`,
      [
        accepted.position + 1,
        accepted.messageId,
        now,
        input.originNodeId,
        accepted.conversationId,
        accepted.position,
      ],
    );
  }

  async getConversation(originNodeId: string, conversationId: string): Promise<OutboundConversation | null> {
    const result = await query<ConversationRow>(
      this.db,
      `SELECT * FROM interteam_outbound_conversations WHERE origin_node_id = ? AND conversation_id = ?`,
      [originNodeId, conversationId],
    );
    return result.rows[0] ? conversation(result.rows[0]) : null;
  }

  async listConversations(originNodeId: string, originTeamId: string): Promise<OutboundConversation[]> {
    const result = await query<ConversationRow>(
      this.db,
      `SELECT * FROM interteam_outbound_conversations
       WHERE origin_node_id = ? AND origin_team_id = ?
       ORDER BY updated_at DESC, conversation_id`,
      [originNodeId, originTeamId],
    );
    return result.rows.map(conversation);
  }

  async getSubmission(originNodeId: string, messageId: string): Promise<OutboundSubmission | null> {
    const result = await query<SubmissionRow>(
      this.db,
      `SELECT * FROM interteam_outbound_submissions WHERE origin_node_id = ? AND message_id = ?`,
      [originNodeId, messageId],
    );
    return result.rows[0] ? submission(result.rows[0]) : null;
  }

  async listSubmissions(originNodeId: string, conversationId: string): Promise<OutboundSubmission[]> {
    const result = await query<SubmissionRow>(
      this.db,
      `SELECT * FROM interteam_outbound_submissions
       WHERE origin_node_id = ? AND conversation_id = ?
       ORDER BY position, message_id`,
      [originNodeId, conversationId],
    );
    return result.rows.map(submission);
  }

  /**
   * A continuation is never minted past a submission whose acceptance is still
   * unknown. The origin must first collect or resubmit that envelope.
   */
  async firstUnresolvedSubmission(
    originNodeId: string,
    conversationId: string,
  ): Promise<OutboundSubmission | null> {
    const submissions = await this.listSubmissions(originNodeId, conversationId);
    return submissions.find((row) => row.attemptState === 'not_attempted' || row.attemptState === 'unknown')
      ?? null;
  }
}
