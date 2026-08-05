// SPDX-License-Identifier: MIT

import type { DbAdapter, QueryResult } from '../db/db-adapter.js';
import {
  INTER_TEAM_PROTOCOL_VERSION,
  automaticResubmissionAllowed,
  readRoster,
  rosterReadRateResult,
  type Destination,
  type InterTeamRequestEnvelope,
  type RosterAgent,
  type RosterAgentInput,
} from './protocol.js';
import {
  InterteamMessageStore,
  type CollectStoredResult,
  type SenderAttribution,
} from './message-store.js';
import {
  InterTeamAcceptanceService,
  type AcceptanceOutcome,
} from './acceptance-service.js';
import { InterteamFoundationStore, type TeamContact } from './foundation-store.js';
import { resolveOwnedContact, type TrustedLocalSourceContext } from './local-context.js';
import { InterTeamOutboundStore } from './outbound-store.js';
import { PeerRouteStore } from './peer-routes.js';
import {
  UNCONFIGURED_FEDERATION_TRANSPORT,
  type FederationTransport,
} from './federation-transport.js';
import { isInterTeamAvailable } from './destination-resolver.js';

/**
 * Commit 10 — the origin side. Callers address `team:<alias>` (preferred) or a
 * permitted direct path; the client resolves the team-owned contact, allocates
 * durable origin IDs, submits through the one acceptance service, and later
 * collects by conversation and message ID. Collection is pull-only and
 * non-consuming: the origin asks, the destination never connects back.
 */

/** Exact product copy shared by CLI/TUI/API clients. */
export const INTERTEAM_ADDRESS_HINT =
  'Address another team as team:<alias>. Prefer the team address; the team routes it to its lead. '
  + 'When you need one specific agent, team:<alias>/<agent-name> and the immutable agent ID are the direct paths.';

export const DEFAULT_ROSTER_BOUNDS = { maxAgents: 200, maxEncodedBytes: 256 * 1024 };
export const DEFAULT_ROSTER_READS_PER_MINUTE = 60;
export const DEFAULT_CONVERSATION_LIST_BOUNDS = {
  maxConversations: 200,
  maxEncodedBytes: 256 * 1024,
};

export type ConversationListStateFilter = 'outstanding' | 'terminal';

export interface ConversationListEntry {
  conversationId: string;
  destination: {
    kind: Destination['kind'];
    nodeId: string;
    teamId: string;
    /** Current origin-owned decoration for the pinned node/team, never identity. */
    alias: string | null;
    pinnedAgentId: string | null;
    nameAtAcceptance: string | null;
  };
  latestMessage: {
    messageId: string;
    position: number;
    state: 'accepted' | 'processing' | 'completed' | 'failed' | 'unknown';
    lastConfirmedState: 'accepted' | 'processing' | 'completed' | 'failed';
    retention: 'retained' | 'compacted' | 'receipt';
    acceptedAt: number | null;
    updatedAt: number;
    terminalAt: number | null;
    /** Origin-local display metadata. Never used as authority. */
    sender: SenderAttribution | null;
  } | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationList {
  conversations: ConversationListEntry[];
}

export type OriginSendResult =
  | {
      ok: true;
      conversationId: string;
      messageId: string;
      protocolVersion: string;
      firstSubmittedAt: number;
      outcome: Extract<AcceptanceOutcome, { kind: 'accepted' | 'deduplicated' }>;
    }
  | { ok: false; code: string };

/** The frozen descriptor projection: nodeId + teamId are the contact pin. */
export interface TeamDescriptor {
  protocolVersion: string;
  nodeId: string;
  teamId: string;
  teamDisplayName: string;
  inboundPolicy: 'open' | 'closed';
  alias: string;
  agents: RosterAgent[];
}

function parameterize(db: DbAdapter, sql: string): string {
  if (db.dialect === 'sqlite') return sql;
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function query<T>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return db.query<T>(parameterize(db, sql), params);
}

export class InterTeamOriginClient {
  private readonly store: InterteamMessageStore;
  private readonly outbound: InterTeamOutboundStore;
  private readonly routes: PeerRouteStore;
  private readonly transport: FederationTransport;
  private readonly foundation: InterteamFoundationStore;
  private readonly rosterBounds: { maxAgents: number; maxEncodedBytes: number };
  private readonly conversationListBounds: { maxConversations: number; maxEncodedBytes: number };
  private readonly rosterReadsPerMinute: number;
  private readonly rosterReads = new Map<string, { windowStart: number; used: number }>();

  constructor(
    private readonly db: DbAdapter,
    private readonly acceptance: InterTeamAcceptanceService,
    options: {
      rosterBounds?: { maxAgents: number; maxEncodedBytes: number };
      conversationListBounds?: { maxConversations: number; maxEncodedBytes: number };
      rosterReadsPerMinute?: number;
      /** Supplied from commit 15 onward; unconfigured means no socket exists. */
      transport?: FederationTransport;
    } = {},
  ) {
    this.outbound = new InterTeamOutboundStore(db);
    this.routes = new PeerRouteStore(db);
    this.transport = options.transport ?? UNCONFIGURED_FEDERATION_TRANSPORT;
    this.store = new InterteamMessageStore(db);
    this.foundation = new InterteamFoundationStore(db);
    this.rosterBounds = options.rosterBounds ?? DEFAULT_ROSTER_BOUNDS;
    this.conversationListBounds = options.conversationListBounds ?? DEFAULT_CONVERSATION_LIST_BOUNDS;
    this.rosterReadsPerMinute = options.rosterReadsPerMinute ?? DEFAULT_ROSTER_READS_PER_MINUTE;
  }

  private async resolveContact(
    context: TrustedLocalSourceContext,
    selector: { alias?: string; contactId?: string },
    body?: Record<string, unknown> | null,
  ): Promise<{ ok: true; contact: TeamContact } | { ok: false; code: string }> {
    try {
      const contact = await resolveOwnedContact(this.foundation, { context, body, ...selector });
      return { ok: true, contact };
    } catch (error) {
      return { ok: false, code: (error as Error & { code?: string }).code ?? 'contact_not_found' };
    }
  }

  /**
   * Submit the first request of a new conversation. V1 delivers on this
   * manager only: a pin to a foreign node has no configured peer route yet.
   */
  async send(input: {
    context: TrustedLocalSourceContext;
    alias?: string;
    contactId?: string;
    destination: Destination;
    body: unknown;
    requestBody?: Record<string, unknown> | null;
    now?: number;
  }): Promise<OriginSendResult> {
    const resolved = await this.resolveContact(input.context, {
      alias: input.alias,
      contactId: input.contactId,
    }, input.requestBody);
    if (!resolved.ok) return resolved;
    const localNodeId = await this.acceptance.localNodeId();
    if (resolved.contact.remoteNodeId !== localNodeId) {
      return { ok: false, code: 'peer_route_unconfigured' };
    }

    const now = input.now ?? Date.now();
    const allocated = await this.store.allocateOriginIds(localNodeId, now);
    const envelope: InterTeamRequestEnvelope = {
      protocolVersion: INTER_TEAM_PROTOCOL_VERSION,
      originNodeId: localNodeId,
      originTeamId: input.context.localTeamId,
      destinationNodeId: resolved.contact.remoteNodeId,
      destinationTeamId: resolved.contact.remoteTeamId,
      destination: input.destination,
      conversationId: allocated.conversationId,
      messageId: allocated.messageId,
      position: 0,
      predecessorMessageId: null,
      firstSubmittedAt: now,
      body: input.body,
    };
    return this.submit(envelope, input.context, now);
  }

  /** Submit the next ordered request of a conversation this team originated. */
  async continueConversation(input: {
    context: TrustedLocalSourceContext;
    conversationId: string;
    body: unknown;
    now?: number;
  }): Promise<OriginSendResult> {
    const localNodeId = await this.acceptance.localNodeId();
    const binding = await this.ownedConversation(localNodeId, input.context.localTeamId, input.conversationId);
    if (!binding) return { ok: false, code: 'conversation_not_found' };

    const now = input.now ?? Date.now();
    const allocated = await this.store.allocateOriginIds(localNodeId, now);
    const destination: Destination = binding.destination_kind === 'team'
      ? { kind: 'team' }
      : binding.destination_kind === 'agent_name'
        ? { kind: 'agent_name', agentName: binding.destination_name_at_acceptance! }
        : { kind: 'agent_id', agentId: binding.destination_agent_id! };
    const envelope: InterTeamRequestEnvelope = {
      protocolVersion: INTER_TEAM_PROTOCOL_VERSION,
      originNodeId: localNodeId,
      originTeamId: input.context.localTeamId,
      destinationNodeId: binding.destination_node_id,
      destinationTeamId: binding.destination_team_id,
      destination,
      conversationId: input.conversationId,
      messageId: allocated.messageId,
      position: binding.next_position,
      predecessorMessageId: binding.predecessor_message_id,
      firstSubmittedAt: now,
      body: input.body,
    };
    return this.submit(envelope, input.context, now);
  }

  /** Resubmit a previously built envelope verbatim after a lost response. */
  async resubmit(input: {
    context: TrustedLocalSourceContext;
    envelope: InterTeamRequestEnvelope;
    now?: number;
  }): Promise<OriginSendResult> {
    if (input.envelope.originTeamId !== input.context.localTeamId) {
      return { ok: false, code: 'source_context_mismatch' };
    }
    const now = input.now ?? Date.now();
    // The 30-day resubmission horizon is the origin's contract obligation:
    // past it, the receiver may have deleted the terminal row and a retry
    // could re-execute. Refuse locally rather than trusting the caller.
    if (!automaticResubmissionAllowed(input.envelope.firstSubmittedAt, now)) {
      return { ok: false, code: 'resubmission_horizon_exceeded' };
    }
    return this.submit(input.envelope, input.context, now);
  }

  private async submit(
    envelope: InterTeamRequestEnvelope,
    context: TrustedLocalSourceContext,
    now: number,
  ): Promise<OriginSendResult> {
    const sender = await this.senderAtSend(context);
    // Only the human-usable name crosses the node boundary. The immutable ID
    // remains in the origin-local attribution table because it is meaningful
    // only within this manager's namespace.
    const outboundEnvelope: InterTeamRequestEnvelope = {
      ...envelope,
      senderName: sender?.nameAtSend ?? null,
    };

    // The origin's own durable record comes first, before anything could
    // observe an attempt. Recording is uniform for local and remote
    // destinations so the remote path is not a second code path that first
    // executes in production.
    await this.outbound.recordSubmission({ envelope: outboundEnvelope, now });

    const outcome = await this.acceptance.accept({
      transport: { kind: 'same_manager', originTeamId: context.localTeamId },
      envelope: outboundEnvelope,
      now,
    });
    await this.outbound.recordAttemptOutcome({
      originNodeId: outboundEnvelope.originNodeId,
      messageId: outboundEnvelope.messageId,
      attemptState: outcome.kind === 'accepted' || outcome.kind === 'deduplicated' ? 'accepted' : 'rejected',
      observedState: outcome.kind === 'accepted' || outcome.kind === 'deduplicated' ? outcome.status : null,
      diagnostic: outcome.kind === 'error'
        ? outcome.code
        : outcome.kind === 'rejected' ? outcome.reason : null,
      now,
    });
    if (outcome.kind === 'accepted') {
      // Attribution is display metadata, never part of acceptance. A failure
      // here must not turn a durably accepted message into a failed send.
      await this.store.recordOriginSubmission({
        nodeId: outboundEnvelope.originNodeId,
        messageId: outboundEnvelope.messageId,
        sender,
        now,
      }).catch((error) => {
        console.error('[Inter-team] origin sender attribution persistence failed:', error);
      });
    }
    if (outcome.kind === 'accepted' || outcome.kind === 'deduplicated') {
      return {
        ok: true,
        conversationId: outboundEnvelope.conversationId,
        messageId: outboundEnvelope.messageId,
        protocolVersion: outboundEnvelope.protocolVersion,
        firstSubmittedAt: outboundEnvelope.firstSubmittedAt,
        outcome,
      };
    }
    return { ok: false, code: outcome.kind === 'error' ? outcome.code : outcome.reason };
  }

  private async senderAtSend(context: TrustedLocalSourceContext): Promise<SenderAttribution | null> {
    if (!context.agentId) return null;
    const result = await query<{ name: string }>(
      this.db,
      `SELECT name FROM agents WHERE id = ?`,
      [context.agentId],
    );
    return {
      agentId: context.agentId,
      nameAtSend: result.rows[0]?.name ?? null,
    };
  }

  /**
   * Rebuild and resubmit a first-position envelope verbatim after a lost
   * response. The caller supplies the identifiers and original timestamp its
   * first attempt returned (or durably saved); an identical rebuild
   * deduplicates, a divergent one is an idempotency_conflict — never a
   * second acceptance.
   */
  async resubmitSend(input: {
    context: TrustedLocalSourceContext;
    alias?: string;
    contactId?: string;
    destination: Destination;
    body: unknown;
    conversationId: string;
    messageId: string;
    /** Version used for the original attempt; preserves replay identity across upgrades. */
    protocolVersion?: string;
    firstSubmittedAt: number;
    now?: number;
  }): Promise<OriginSendResult> {
    const resolved = await this.resolveContact(input.context, {
      alias: input.alias,
      contactId: input.contactId,
    });
    if (!resolved.ok) return resolved;
    const localNodeId = await this.acceptance.localNodeId();
    if (resolved.contact.remoteNodeId !== localNodeId) {
      return { ok: false, code: 'peer_route_unconfigured' };
    }
    return this.resubmit({
      context: input.context,
      now: input.now,
      envelope: {
        protocolVersion: input.protocolVersion ?? INTER_TEAM_PROTOCOL_VERSION,
        originNodeId: localNodeId,
        originTeamId: input.context.localTeamId,
        destinationNodeId: resolved.contact.remoteNodeId,
        destinationTeamId: resolved.contact.remoteTeamId,
        destination: input.destination,
        conversationId: input.conversationId,
        messageId: input.messageId,
        position: 0,
        predecessorMessageId: null,
        firstSubmittedAt: input.firstSubmittedAt,
        body: input.body,
      },
    });
  }

  /**
   * Non-consuming, origin-only collection. Unknown conversations and
   * non-participants get the identical conversation_not_found.
   */
  async collect(input: {
    context: TrustedLocalSourceContext;
    conversationId: string;
    messageId: string;
  }): Promise<CollectStoredResult> {
    const localNodeId = await this.acceptance.localNodeId();
    const binding = await this.ownedConversation(
      localNodeId,
      input.context.localTeamId,
      input.conversationId,
    );
    if (!binding) return { ok: false, code: 'conversation_not_found' };
    return this.store.collect({
      originNodeId: localNodeId,
      originTeamId: input.context.localTeamId,
      destinationTeamId: binding.destination_team_id,
      conversationId: input.conversationId,
      messageId: input.messageId,
    });
  }

  /**
   * Origin-team conversation index. This is deliberately an index rather
   * than bulk collection: it exposes the latest message's state and timing,
   * but never request bodies, results, or failure detail. Unknown and
   * non-owner conversations collapse to the same empty result by selecting
   * only rows owned by the trusted caller's team.
   */
  async listConversations(input: {
    context: TrustedLocalSourceContext;
    state?: ConversationListStateFilter;
  }): Promise<
    | { ok: true; value: ConversationList }
    | { ok: false; code: 'read_response_too_large' }
  > {
    const localNodeId = await this.acceptance.localNodeId();
    const statePredicate = input.state === 'outstanding'
      ? `AND latest.status IN ('accepted','processing','unknown')`
      : input.state === 'terminal'
        ? `AND latest.status IN ('completed','failed')`
        : '';
    const result = await query<{
      conversation_id: string;
      destination_node_id: string;
      destination_team_id: string;
      destination_kind: Destination['kind'];
      destination_agent_id: string | null;
      destination_name_at_acceptance: string | null;
      current_alias: string | null;
      created_at: number | string;
      updated_at: number | string;
      latest_message_id: string | null;
      latest_position: number | string | null;
      latest_status: 'accepted' | 'processing' | 'completed' | 'failed' | 'unknown' | null;
      latest_last_confirmed_status: 'accepted' | 'processing' | 'completed' | 'failed' | null;
      latest_retention_tier: 'retained' | 'compacted' | 'receipt' | null;
      latest_accepted_at: number | string | null;
      latest_updated_at: number | string | null;
      latest_terminal_at: number | string | null;
      latest_sender_agent_id: string | null;
      latest_sender_name_at_send: string | null;
    }>(
      this.db,
      `WITH latest_candidates AS (
         SELECT conversation_pk, message_id, position, status, last_confirmed_status,
                retention_tier, accepted_at, updated_at, terminal_at, 0 AS source_rank
         FROM interteam_messages
         UNION ALL
         SELECT conversation_pk, message_id, position, status, last_confirmed_status,
                'receipt' AS retention_tier, NULL AS accepted_at,
                terminal_at AS updated_at, terminal_at, 1 AS source_rank
         FROM interteam_message_receipts
       ), latest_ranked AS (
         SELECT latest_candidates.*,
                ROW_NUMBER() OVER (
                  PARTITION BY conversation_pk
                  ORDER BY position DESC, source_rank, message_id
                ) AS row_number
         FROM latest_candidates
       )
       SELECT c.conversation_id, c.destination_node_id, c.destination_team_id,
              c.destination_kind, c.destination_agent_id,
              c.destination_name_at_acceptance, c.created_at, c.updated_at,
              (
                SELECT tc.alias_display
                FROM team_contacts tc
                WHERE tc.local_team_id = c.origin_team_id
                  AND tc.remote_node_id = c.destination_node_id
                  AND tc.remote_team_id = c.destination_team_id
                ORDER BY tc.alias_normalized, tc.id
                LIMIT 1
              ) AS current_alias,
              latest.message_id AS latest_message_id,
              latest.position AS latest_position,
              latest.status AS latest_status,
              latest.last_confirmed_status AS latest_last_confirmed_status,
              latest.retention_tier AS latest_retention_tier,
              latest.accepted_at AS latest_accepted_at,
              latest.updated_at AS latest_updated_at,
              latest.terminal_at AS latest_terminal_at,
              origin_submission.sender_agent_id AS latest_sender_agent_id,
              origin_submission.sender_name_at_send AS latest_sender_name_at_send
       FROM interteam_conversations c
       LEFT JOIN latest_ranked latest
         ON latest.conversation_pk = c.id AND latest.row_number = 1
       LEFT JOIN interteam_origin_submissions origin_submission
         ON origin_submission.node_id = c.origin_node_id
        AND origin_submission.message_id = latest.message_id
       WHERE c.origin_node_id = ? AND c.origin_team_id = ?
         ${statePredicate}
       ORDER BY c.updated_at DESC, c.id
       LIMIT ?`,
      [localNodeId, input.context.localTeamId, this.conversationListBounds.maxConversations + 1],
    );
    if (result.rows.length > this.conversationListBounds.maxConversations) {
      return { ok: false, code: 'read_response_too_large' };
    }

    const value: ConversationList = {
      conversations: result.rows.map((row) => ({
        conversationId: row.conversation_id,
        destination: {
          kind: row.destination_kind,
          nodeId: row.destination_node_id,
          teamId: row.destination_team_id,
          alias: row.current_alias,
          pinnedAgentId: row.destination_agent_id,
          nameAtAcceptance: row.destination_name_at_acceptance,
        },
        latestMessage: row.latest_message_id === null ? null : {
          messageId: row.latest_message_id,
          position: Number(row.latest_position),
          state: row.latest_status!,
          lastConfirmedState: row.latest_last_confirmed_status!,
          retention: row.latest_retention_tier!,
          acceptedAt: row.latest_accepted_at === null ? null : Number(row.latest_accepted_at),
          updatedAt: Number(row.latest_updated_at),
          terminalAt: row.latest_terminal_at === null ? null : Number(row.latest_terminal_at),
          sender: row.latest_sender_agent_id === null ? null : {
            agentId: row.latest_sender_agent_id,
            nameAtSend: row.latest_sender_name_at_send,
          },
        },
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      })),
    };
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > this.conversationListBounds.maxEncodedBytes) {
      return { ok: false, code: 'read_response_too_large' };
    }
    return { ok: true, value };
  }

  /**
   * Contact-addressed descriptor and roster. Reads are unaffected by inbound
   * policy; only new conversations are refused by `closed`. Bounded, and
   * never a silent partial: over-bound reads fail whole.
   */
  async describeContact(input: {
    context: TrustedLocalSourceContext;
    alias: string;
    now?: number;
  }): Promise<{ ok: true; descriptor: TeamDescriptor } | { ok: false; code: string }> {
    const resolved = await this.resolveContact(input.context, { alias: input.alias });
    if (!resolved.ok) return resolved;
    const localNodeId = await this.acceptance.localNodeId();
    if (resolved.contact.remoteNodeId !== localNodeId) {
      return { ok: false, code: 'peer_route_unconfigured' };
    }

    const rate = this.consumeRosterRead(localNodeId, input.now ?? Date.now());
    if (!rate.ok) return rate;

    const team = await query<{ id: string; name: string; inbound_policy: 'open' | 'closed' }>(
      this.db,
      `SELECT id, name, inbound_policy FROM teams WHERE id = ?`,
      [resolved.contact.remoteTeamId],
    );
    if (!team.rows[0]) return { ok: false, code: 'target_identity_missing' };

    const roster = readRoster(
      team.rows[0].inbound_policy,
      await this.rosterInputs(team.rows[0].id),
      this.rosterBounds,
    );
    if (!roster.ok) return roster;
    return {
      ok: true,
      descriptor: {
        protocolVersion: INTER_TEAM_PROTOCOL_VERSION,
        nodeId: localNodeId,
        teamId: team.rows[0].id,
        teamDisplayName: team.rows[0].name,
        inboundPolicy: team.rows[0].inbound_policy,
        alias: resolved.contact.aliasDisplay,
        agents: roster.agents,
      },
    };
  }

  private consumeRosterRead(originNodeId: string, now: number): { ok: true } | { ok: false; code: 'read_rate_limited' } {
    const window = this.rosterReads.get(originNodeId);
    if (!window || now - window.windowStart >= 60_000) {
      this.rosterReads.set(originNodeId, { windowStart: now, used: 1 });
      return { ok: true };
    }
    const result = rosterReadRateResult(this.rosterReadsPerMinute - window.used);
    if (result.ok) window.used += 1;
    return result;
  }

  private async rosterInputs(teamId: string): Promise<RosterAgentInput[]> {
    const agents = await query<{
      id: string;
      name: string;
      status: string;
      deleted_at: number | string | null;
      runtime: string;
      model: string;
      metadata: string | Record<string, unknown> | null;
    }>(
      this.db,
      `SELECT id, name, status, deleted_at, runtime, model, metadata
       FROM agents WHERE team_id = ? AND deleted_at IS NULL ORDER BY name, id`,
      [teamId],
    );

    // LEAF group names as context only: only groups with no child groups
    // qualify, so no parent name can be used to reconstruct the hierarchy —
    // never the tree, never IDs, never a lead hint.
    const memberships = await query<{ agent_id: string; name: string }>(
      this.db,
      `SELECT gm.agent_id, g.name FROM org_group_members gm
       JOIN org_groups g ON g.id = gm.group_id
       WHERE gm.team_id = ?
         AND NOT EXISTS (SELECT 1 FROM org_groups child WHERE child.parent_group_id = g.id)
       UNION
       SELECT gl.agent_id, g.name FROM org_group_leads gl
       JOIN org_groups g ON g.id = gl.group_id
       WHERE gl.team_id = ?
         AND NOT EXISTS (SELECT 1 FROM org_groups child WHERE child.parent_group_id = g.id)`,
      [teamId, teamId],
    );
    const tags = await query<{ agent_id: string; name: string }>(
      this.db,
      `SELECT at.agent_id, t.name FROM org_agent_tags at
       JOIN org_tags t ON t.id = at.tag_id WHERE at.team_id = ?`,
      [teamId],
    );
    const groupsByAgent = new Map<string, string[]>();
    for (const row of memberships.rows) {
      groupsByAgent.set(row.agent_id, [...(groupsByAgent.get(row.agent_id) ?? []), row.name]);
    }
    const tagsByAgent = new Map<string, string[]>();
    for (const row of tags.rows) {
      tagsByAgent.set(row.agent_id, [...(tagsByAgent.get(row.agent_id) ?? []), row.name]);
    }

    return agents.rows.map((agent) => {
      const metadata = typeof agent.metadata === 'string'
        ? JSON.parse(agent.metadata || '{}')
        : agent.metadata ?? {};
      const catalog = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        && metadata.catalog && typeof metadata.catalog === 'object' && !Array.isArray(metadata.catalog)
        ? metadata.catalog as Record<string, unknown>
        : {};
      return {
        agentId: agent.id,
        teamId,
        addressName: agent.name,
        displayName: agent.name,
        runtime: agent.runtime,
        model: agent.model,
        effort: typeof metadata.effort === 'string' ? metadata.effort : null,
        organizationTags: (tagsByAgent.get(agent.id) ?? []).sort(),
        groups: (groupsByAgent.get(agent.id) ?? []).sort(),
        catalog,
        available: isInterTeamAvailable({
          status: agent.status,
          deleted_at: agent.deleted_at,
          runtime: agent.runtime,
          metadata: agent.metadata,
        }),
        deleted: agent.deleted_at !== null,
      };
    });
  }

  private async ownedConversation(
    originNodeId: string,
    originTeamId: string,
    conversationId: string,
  ): Promise<{
    destination_node_id: string;
    destination_team_id: string;
    destination_kind: 'team' | 'agent_name' | 'agent_id';
    destination_agent_id: string | null;
    destination_name_at_acceptance: string | null;
    next_position: number;
    predecessor_message_id: string | null;
  } | null> {
    const result = await query<{
      origin_team_id: string;
      destination_node_id: string;
      destination_team_id: string;
      destination_kind: 'team' | 'agent_name' | 'agent_id';
      destination_agent_id: string | null;
      destination_name_at_acceptance: string | null;
      next_position: number;
      predecessor_message_id: string | null;
    }>(
      this.db,
      `SELECT origin_team_id, destination_node_id, destination_team_id, destination_kind,
              destination_agent_id, destination_name_at_acceptance, next_position,
              predecessor_message_id
       FROM interteam_conversations WHERE origin_node_id = ? AND conversation_id = ?`,
      [originNodeId, conversationId],
    );
    const row = result.rows[0];
    // A conversation owned by another local team is indistinguishable from a
    // missing one: same conversation_not_found, no information leak.
    if (!row || row.origin_team_id !== originTeamId) return null;
    return row;
  }
}
