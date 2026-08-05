// SPDX-License-Identifier: MIT

import type { DbAdapter, QueryResult } from '../db/db-adapter.js';
import {
  INTER_TEAM_PROTOCOL_VERSION,
  protocolCompatibility,
  validateConversationParticipant,
  validateDeliveryContext,
  type InterTeamRequestEnvelope,
  type PreAcceptErrorCode,
} from './protocol.js';
import { DestinationResolver } from './destination-resolver.js';
import { InterteamMessageStore, type AcceptRequestResult } from './message-store.js';

/**
 * Commit 8 — one post-transport acceptance service.
 *
 * Same-manager delivery and future federation transports meet here after
 * their transport step. The service enforces the design's resolution order:
 * a federation request claiming the local node is rejected first; the
 * destination team resolves by immutable ID; a continuation validates its
 * pinned participants before deduplication or any other conversation access;
 * an accepted-duplicate retry short-circuits before mutable policy/capacity
 * re-evaluation; a closed team returns target_closed before any recipient
 * lookup (provable with a resolver spy); and every pre-accept error is
 * returned before the store transaction, so it allocates no accepted or
 * deduplication state. The store commits before the transport returns 202.
 */

export interface AcceptanceBounds {
  maxBodyBytes: number;
  maxNonTerminalPerOrigin: number;
  maxNonTerminalPerTeam: number;
  maxNonTerminalPerDirectRecipient: number;
  maxNonTerminalTotal: number;
}

export const DEFAULT_ACCEPTANCE_BOUNDS: AcceptanceBounds = {
  maxBodyBytes: 256 * 1024,
  maxNonTerminalPerOrigin: 64,
  maxNonTerminalPerTeam: 128,
  maxNonTerminalPerDirectRecipient: 32,
  maxNonTerminalTotal: 512,
};

export type AcceptanceTransport =
  | { kind: 'same_manager'; originTeamId: string }
  | { kind: 'federation'; claimedOriginNodeId: string; originTeamId: string };

export type AcceptanceOutcome =
  | AcceptRequestResult
  | { kind: 'error'; code: PreAcceptErrorCode }
  | { kind: 'rejected'; reason: 'self_node_claim' | 'source_context_mismatch' };

function parameterize(db: DbAdapter, sql: string): string {
  if (db.dialect === 'sqlite') return sql;
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function query<T>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return db.query<T>(parameterize(db, sql), params);
}

const NON_TERMINAL = `('accepted', 'processing', 'unknown')`;

export class InterTeamAcceptanceService {
  private readonly bounds: AcceptanceBounds;
  private readonly store: InterteamMessageStore;
  private readonly resolver: DestinationResolver;
  /**
   * In-process admission queue. Concurrent accepts on one manager serialize
   * here: SQLite's adapter transaction is not reentrant under interleaved
   * async callers, and capacity admission must not be judged twice against
   * the same count. Cross-process Postgres admission additionally takes an
   * advisory transaction lock inside the store transaction.
   */
  private acceptQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: DbAdapter,
    options: { bounds?: Partial<AcceptanceBounds>; resolver?: DestinationResolver } = {},
  ) {
    this.bounds = { ...DEFAULT_ACCEPTANCE_BOUNDS, ...options.bounds };
    this.store = new InterteamMessageStore(db);
    this.resolver = options.resolver ?? new DestinationResolver(db);
  }

  async localNodeId(): Promise<string> {
    const result = await query<{ node_id: string }>(
      this.db,
      `SELECT node_id FROM manager_identity WHERE singleton_key = 1`,
    );
    if (!result.rows[0]?.node_id) throw new Error('manager_identity_missing');
    return result.rows[0].node_id;
  }

  async accept(input: {
    transport: AcceptanceTransport;
    envelope: InterTeamRequestEnvelope;
    now?: number;
  }): Promise<AcceptanceOutcome> {
    const run = this.acceptQueue.then(() => this.acceptSerialized(input), () => this.acceptSerialized(input));
    this.acceptQueue = run.catch(() => undefined);
    return run;
  }

  private async acceptSerialized(input: {
    transport: AcceptanceTransport;
    envelope: InterTeamRequestEnvelope;
    now?: number;
  }): Promise<AcceptanceOutcome> {
    const { transport, envelope } = input;
    const localNodeId = await this.localNodeId();

    // 1. Transport identity. A federation request claiming our own node is
    //    rejected before anything durable; same-manager context derives the
    //    origin node locally. The origin-team assertion is trusted as-is.
    const context = validateDeliveryContext(
      transport.kind === 'same_manager'
        ? { kind: 'same_manager', localNodeId, originTeamId: transport.originTeamId }
        : {
            kind: 'federation',
            localNodeId,
            claimedOriginNodeId: transport.claimedOriginNodeId,
            originTeamId: transport.originTeamId,
          },
    );
    if (!context.ok) return { kind: 'rejected', reason: context.reason };

    // The envelope must agree with the transport-derived participants; a body
    // can never override who is speaking or who is addressed.
    if (
      envelope.originNodeId !== context.originNodeId
      || envelope.originTeamId !== context.originTeamId
    ) {
      return { kind: 'rejected', reason: 'source_context_mismatch' };
    }
    if (envelope.destinationNodeId !== localNodeId) {
      return { kind: 'error', code: 'target_identity_missing' };
    }

    // 2. Protocol version.
    const compatibility = protocolCompatibility(INTER_TEAM_PROTOCOL_VERSION, envelope.protocolVersion);
    if (!compatibility.ok) return { kind: 'error', code: compatibility.code };

    // 3. Stateless body bound.
    if (Buffer.byteLength(JSON.stringify(envelope.body ?? null), 'utf8') > this.bounds.maxBodyBytes) {
      return { kind: 'error', code: 'message_too_large' };
    }

    // 4. Destination team by immutable ID only.
    const team = await this.resolver.resolveDestinationTeam(envelope.destinationTeamId);
    if (!team.ok) return { kind: 'error', code: team.code };

    // 5. Cold start vs continuation. A continuation validates its pinned
    //    participants before deduplication or any other conversation access.
    const conversation = await query<{
      origin_node_id: string;
      origin_team_id: string;
      destination_team_id: string;
      destination_agent_id: string | null;
    }>(
      this.db,
      `SELECT origin_node_id, origin_team_id, destination_team_id, destination_agent_id
       FROM interteam_conversations WHERE origin_node_id = ? AND conversation_id = ?`,
      [envelope.originNodeId, envelope.conversationId],
    );
    const existing = conversation.rows[0];
    if (existing) {
      const participant = validateConversationParticipant(
        {
          originNodeId: existing.origin_node_id,
          originTeamId: existing.origin_team_id,
          destinationNodeId: localNodeId,
          destinationTeamId: existing.destination_team_id,
          destination: envelope.destination,
        },
        {
          originNodeId: envelope.originNodeId,
          originTeamId: envelope.originTeamId,
          destinationTeamId: envelope.destinationTeamId,
        },
      );
      if (!participant.ok) return { kind: 'error', code: participant.code };
    }

    // 6. Accepted-duplicate short-circuit before any mutable re-evaluation:
    //    a committed message must never be re-judged by policy or capacity.
    const known = await this.isKnownSubmission(envelope);
    if (!known && !existing) {
      // A cold start can only open at position 0. Rejecting here keeps the
      // resolver out of a request that can never be accepted, so a bogus
      // continuation cannot harvest recipient-existence errors.
      if (envelope.position !== 0 || envelope.predecessorMessageId !== null) {
        return { kind: 'error', code: 'conversation_order_conflict' };
      }
      // Policy guards new conversations only, and runs before any
      // recipient lookup: a closed team must not learn who was addressed.
      const settings = await query<{ inbound_policy: 'open' | 'closed' }>(
        this.db,
        `SELECT inbound_policy FROM teams WHERE id = ?`,
        [envelope.destinationTeamId],
      );
      if (settings.rows[0]?.inbound_policy !== 'open') {
        return { kind: 'error', code: 'target_closed' };
      }
    }

    // 7-8. Variant resolution and availability, for new conversations only.
    //    A continuation never re-resolves a contact, policy, or recipient
    //    name; its binding was pinned at cold start.
    let resolvedAgentId: string | null | undefined;
    if (!existing && !known) {
      const recipient = await this.resolver.resolveNewSendRecipient(
        envelope.destinationTeamId,
        envelope.destination,
      );
      if (!recipient.ok) return { kind: 'error', code: recipient.code };
      resolvedAgentId = recipient.kind === 'agent' ? recipient.agentId : null;
    }

    // 9. Durable acceptance. Capacity admission runs INSIDE the store
    //    transaction, after its dedup/participant/order checks and right
    //    before the insert, so two concurrent submissions cannot both pass a
    //    bound that only admits one. Per-direct-recipient bounds use only a
    //    validated pinned ID — after resolution for new sends, the stored
    //    binding for continuations — so an invalid target can never leak
    //    busy-state instead of recipient_not_found. The transaction commits
    //    before the transport can return 202.
    const directRecipientId = resolvedAgentId ?? existing?.destination_agent_id ?? null;
    return this.store.acceptRequest({
      envelope,
      resolvedAgentId,
      now: input.now,
      admission: async (tx) => {
        if (tx.dialect === 'postgres') {
          await tx.query(`SELECT pg_advisory_xact_lock(hashtext('interteam_admission'))`);
        }
        const total = await this.countNonTerminal(tx, ``, []);
        if (total >= this.bounds.maxNonTerminalTotal) return 'receiver_busy';
        const perOrigin = await this.countNonTerminal(
          tx, `AND m.submitter_node_id = ?`, [envelope.originNodeId],
        );
        if (perOrigin >= this.bounds.maxNonTerminalPerOrigin) return 'receiver_busy';
        const perTeam = await this.countNonTerminal(
          tx, `AND c.destination_team_id = ?`, [envelope.destinationTeamId],
        );
        if (perTeam >= this.bounds.maxNonTerminalPerTeam) return 'receiver_busy';
        if (directRecipientId) {
          const perRecipient = await this.countNonTerminal(
            tx, `AND m.resolved_agent_id = ?`, [directRecipientId],
          );
          if (perRecipient >= this.bounds.maxNonTerminalPerDirectRecipient) return 'receiver_busy';
        }
        return null;
      },
    });
  }

  private async isKnownSubmission(envelope: InterTeamRequestEnvelope): Promise<boolean> {
    const message = await query<{ id: string }>(
      this.db,
      `SELECT id FROM interteam_messages WHERE submitter_node_id = ? AND message_id = ?`,
      [envelope.originNodeId, envelope.messageId],
    );
    if (message.rows[0]) return true;
    const receipt = await query<{ message_id: string }>(
      this.db,
      `SELECT message_id FROM interteam_message_receipts
       WHERE submitter_node_id = ? AND message_id = ?`,
      [envelope.originNodeId, envelope.messageId],
    );
    return Boolean(receipt.rows[0]);
  }

  private async countNonTerminal(db: DbAdapter, condition: string, params: unknown[]): Promise<number> {
    const result = await query<{ count: number | string }>(
      db,
      `SELECT COUNT(*) AS count
       FROM interteam_messages m
       JOIN interteam_conversations c ON c.id = m.conversation_pk
       WHERE m.status IN ${NON_TERMINAL} ${condition}`,
      params,
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}
