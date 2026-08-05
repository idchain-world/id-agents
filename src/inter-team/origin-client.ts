// SPDX-License-Identifier: MIT

import type { DbAdapter, QueryResult } from '../db/db-adapter.js';
import {
  readRoster,
  rosterReadRateResult,
  type Destination,
  type InterTeamRequestEnvelope,
  type RosterAgent,
  type RosterAgentInput,
} from './protocol.js';
import { InterteamMessageStore, type CollectStoredResult } from './message-store.js';
import {
  InterTeamAcceptanceService,
  type AcceptanceOutcome,
} from './acceptance-service.js';
import { InterteamFoundationStore, type TeamContact } from './foundation-store.js';
import { resolveOwnedContact, type TrustedLocalSourceContext } from './local-context.js';
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

export type OriginSendResult =
  | {
      ok: true;
      conversationId: string;
      messageId: string;
      outcome: Extract<AcceptanceOutcome, { kind: 'accepted' | 'deduplicated' }>;
    }
  | { ok: false; code: string };

export interface TeamDescriptor {
  alias: string;
  teamName: string;
  inboundPolicy: 'open' | 'closed';
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
  private readonly foundation: InterteamFoundationStore;
  private readonly rosterBounds: { maxAgents: number; maxEncodedBytes: number };
  private readonly rosterReadsPerMinute: number;
  private readonly rosterReads = new Map<string, { windowStart: number; used: number }>();

  constructor(
    private readonly db: DbAdapter,
    private readonly acceptance: InterTeamAcceptanceService,
    options: {
      rosterBounds?: { maxAgents: number; maxEncodedBytes: number };
      rosterReadsPerMinute?: number;
    } = {},
  ) {
    this.store = new InterteamMessageStore(db);
    this.foundation = new InterteamFoundationStore(db);
    this.rosterBounds = options.rosterBounds ?? DEFAULT_ROSTER_BOUNDS;
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
      protocolVersion: '1.0',
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
      protocolVersion: '1.0',
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
    return this.submit(input.envelope, input.context, input.now ?? Date.now());
  }

  private async submit(
    envelope: InterTeamRequestEnvelope,
    context: TrustedLocalSourceContext,
    now: number,
  ): Promise<OriginSendResult> {
    const outcome = await this.acceptance.accept({
      transport: { kind: 'same_manager', originTeamId: context.localTeamId },
      envelope,
      now,
    });
    if (outcome.kind === 'accepted' || outcome.kind === 'deduplicated') {
      return {
        ok: true,
        conversationId: envelope.conversationId,
        messageId: envelope.messageId,
        outcome,
      };
    }
    return { ok: false, code: outcome.kind === 'error' ? outcome.code : outcome.reason };
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
        alias: resolved.contact.aliasDisplay,
        teamName: team.rows[0].name,
        inboundPolicy: team.rows[0].inbound_policy,
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

    // Leaf group names as context only: the member's own groups, never the
    // tree, never IDs, never a lead hint.
    const memberships = await query<{ agent_id: string; name: string }>(
      this.db,
      `SELECT gm.agent_id, g.name FROM org_group_members gm
       JOIN org_groups g ON g.id = gm.group_id WHERE gm.team_id = ?
       UNION
       SELECT gl.agent_id, g.name FROM org_group_leads gl
       JOIN org_groups g ON g.id = gl.group_id WHERE gl.team_id = ?`,
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
        available: isInterTeamAvailable({ status: agent.status, deleted_at: agent.deleted_at }),
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
