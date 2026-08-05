// SPDX-License-Identifier: MIT

import { validateName } from '../name-validation.js';

export const INTER_TEAM_PROTOCOL_VERSION = '1.1' as const;
export const RESUBMISSION_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

export type InboundPolicy = 'open' | 'closed';
export type MessageState = 'accepted' | 'processing' | 'completed' | 'failed' | 'unknown';

export type PreAcceptErrorCode =
  | 'invalid_address'
  | 'contact_not_found'
  | 'source_unauthorized'
  | 'target_identity_missing'
  | 'target_closed'
  | 'team_lead_unavailable'
  | 'recipient_not_found'
  | 'recipient_ambiguous'
  | 'recipient_unavailable'
  | 'conversation_not_found'
  | 'conversation_order_conflict'
  | 'idempotency_conflict'
  | 'receiver_busy'
  | 'message_too_large'
  | 'read_rate_limited'
  | 'read_response_too_large'
  | 'org_data_corrupt'
  | 'protocol_unsupported';

export type Destination =
  | { kind: 'team' }
  | { kind: 'agent_name'; agentName: string }
  | { kind: 'agent_id'; agentId: string };

export interface ParsedAddress {
  contactAlias: string;
  destination: Extract<Destination, { kind: 'team' | 'agent_name' }>;
}

export type AddressParseResult =
  | { ok: true; value: ParsedAddress }
  | { ok: false; code: 'invalid_address' };

/**
 * Parse only the human-facing forms. Immutable agent IDs deliberately have no
 * display-string syntax; clients use the structured `agent_id` destination.
 */
export function parseInterTeamAddress(input: string): AddressParseResult {
  if (!input.startsWith('team:')) return { ok: false, code: 'invalid_address' };
  const body = input.slice('team:'.length);
  const firstSlash = body.indexOf('/');
  const alias = firstSlash === -1 ? body : body.slice(0, firstSlash);
  const agentName = firstSlash === -1 ? null : body.slice(firstSlash + 1);

  if (!validateName(alias, 'team').valid) return { ok: false, code: 'invalid_address' };
  if (agentName === null) {
    return { ok: true, value: { contactAlias: alias, destination: { kind: 'team' } } };
  }
  if (agentName.includes('/') || !validateName(agentName, 'agent').valid) {
    return { ok: false, code: 'invalid_address' };
  }
  return {
    ok: true,
    value: { contactAlias: alias, destination: { kind: 'agent_name', agentName } },
  };
}

export interface ProtocolVersion {
  major: number;
  minor: number;
}

export function parseProtocolVersion(value: string): ProtocolVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
  return { major, minor };
}

export function protocolCompatibility(
  receiverVersion: string,
  senderVersion: string,
): { ok: true } | { ok: false; code: 'protocol_unsupported' } {
  const receiver = parseProtocolVersion(receiverVersion);
  const sender = parseProtocolVersion(senderVersion);
  if (!receiver || !sender || receiver.major !== sender.major) {
    return { ok: false, code: 'protocol_unsupported' };
  }
  return { ok: true };
}

export interface ParticipantBinding {
  originNodeId: string;
  originTeamId: string;
  destinationNodeId: string;
  destinationTeamId: string;
  destination: Destination;
}

export interface InterTeamRequestEnvelope extends ParticipantBinding {
  protocolVersion: string;
  /**
   * Origin-asserted display/audit claim. Agent IDs are node-local and never
   * cross the wire. Optional so a 1.1 receiver accepts a 1.0 sender.
   */
  senderName?: string | null;
  conversationId: string;
  messageId: string;
  position: number;
  predecessorMessageId: string | null;
  firstSubmittedAt: number;
  body: unknown;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = canonicalize(entry);
    }
    return out;
  }
  return value;
}

/** The recognized envelope only; minor-version extension fields are ignored. */
export function recognizedEnvelopeIdentity(envelope: InterTeamRequestEnvelope): string {
  return JSON.stringify(canonicalize({
    protocolVersion: envelope.protocolVersion,
    originNodeId: envelope.originNodeId,
    originTeamId: envelope.originTeamId,
    destinationNodeId: envelope.destinationNodeId,
    destinationTeamId: envelope.destinationTeamId,
    destination: envelope.destination,
    conversationId: envelope.conversationId,
    messageId: envelope.messageId,
    position: envelope.position,
    predecessorMessageId: envelope.predecessorMessageId,
    firstSubmittedAt: envelope.firstSubmittedAt,
    body: envelope.body,
  }));
}

export function classifyReplay(
  acceptedComparisonIdentity: string,
  incoming: InterTeamRequestEnvelope,
): { kind: 'identical_replay' } | { kind: 'conflict'; code: 'idempotency_conflict' } {
  return acceptedComparisonIdentity === recognizedEnvelopeIdentity(incoming)
    ? { kind: 'identical_replay' }
    : { kind: 'conflict', code: 'idempotency_conflict' };
}

export function automaticResubmissionAllowed(firstSubmittedAt: number, now: number): boolean {
  return Number.isFinite(firstSubmittedAt)
    && Number.isFinite(now)
    && now >= firstSubmittedAt
    && now - firstSubmittedAt <= RESUBMISSION_HORIZON_MS;
}

export type DeliveryContext =
  | { kind: 'same_manager'; localNodeId: string; originTeamId: string }
  | { kind: 'federation'; localNodeId: string; claimedOriginNodeId: string; originTeamId: string };

export function validateDeliveryContext(
  context: DeliveryContext,
): { ok: true; originNodeId: string; originTeamId: string } | { ok: false; reason: 'self_node_claim' } {
  if (context.kind === 'federation' && context.claimedOriginNodeId === context.localNodeId) {
    return { ok: false, reason: 'self_node_claim' };
  }
  return {
    ok: true,
    originNodeId: context.kind === 'same_manager' ? context.localNodeId : context.claimedOriginNodeId,
    originTeamId: context.originTeamId,
  };
}

export interface TransitionEvidence {
  durableJobLink?: boolean;
  durableResult?: boolean;
  durableFailure?: boolean;
}

export function canTransitionMessage(
  from: MessageState,
  to: MessageState,
  evidence: TransitionEvidence = {},
): boolean {
  if (from === to) return true;
  if (from === 'completed' || from === 'failed') return false;
  if (to === 'accepted') return false;
  if (to === 'processing') return from === 'accepted' && evidence.durableJobLink === true;
  if (to === 'completed') {
    return (from === 'processing' || from === 'unknown') && evidence.durableResult === true;
  }
  if (to === 'failed') {
    return (from === 'accepted' || from === 'processing' || from === 'unknown')
      && evidence.durableFailure === true;
  }
  return to === 'unknown' && (from === 'accepted' || from === 'processing');
}

export type ResultRetention = 'retained' | 'compacted' | 'receipt';

export type CollectionResult =
  | { state: 'accepted' | 'processing'; lastConfirmedState: 'accepted' | 'processing' }
  | { state: 'unknown'; lastConfirmedState: 'accepted' | 'processing' }
  | {
      state: 'completed';
      lastConfirmedState: 'completed';
      retention: ResultRetention;
      result: unknown;
      resultPresent: boolean;
    }
  | {
      state: 'failed';
      lastConfirmedState: 'failed';
      retention: ResultRetention;
      failureCode: string | null;
      failureDetailPresent: boolean;
    };

export function collectMessage(input: {
  state: MessageState;
  lastConfirmedState: 'accepted' | 'processing' | 'completed' | 'failed';
  retention?: ResultRetention;
  durableResult?: { value: unknown };
  failureCode?: string;
}): CollectionResult {
  if (input.state === 'accepted' || input.state === 'processing') {
    return { state: input.state, lastConfirmedState: input.state };
  }
  if (input.state === 'unknown') {
    if (input.lastConfirmedState !== 'accepted' && input.lastConfirmedState !== 'processing') {
      throw new Error('unknown requires an accepted or processing last-confirmed state');
    }
    return { state: 'unknown', lastConfirmedState: input.lastConfirmedState };
  }
  const retention = input.retention ?? 'retained';
  if (input.state === 'completed') {
    if (retention === 'retained' && !input.durableResult) {
      throw new Error('completed requires a durable result, including an explicit empty result');
    }
    return {
      state: 'completed',
      lastConfirmedState: 'completed',
      retention,
      result: retention === 'retained' ? input.durableResult!.value : null,
      resultPresent: retention === 'retained',
    };
  }
  return {
    state: 'failed',
    lastConfirmedState: 'failed',
    retention,
    failureCode: retention === 'receipt' ? null : (input.failureCode ?? null),
    failureDetailPresent: retention !== 'receipt',
  };
}

/** `open` admits all three destination variants; there is no direct-addressing flag. */
export function newConversationPolicyResult(
  inboundPolicy: InboundPolicy,
  _destination: Destination,
): { ok: true } | { ok: false; code: 'target_closed' } {
  return inboundPolicy === 'open' ? { ok: true } : { ok: false, code: 'target_closed' };
}

export function validateConversationParticipant(
  binding: ParticipantBinding,
  caller: { originNodeId: string; originTeamId: string; destinationTeamId: string },
): { ok: true } | { ok: false; code: 'conversation_not_found' } {
  if (
    caller.originNodeId !== binding.originNodeId
    || caller.originTeamId !== binding.originTeamId
    || caller.destinationTeamId !== binding.destinationTeamId
  ) {
    return { ok: false, code: 'conversation_not_found' };
  }
  return { ok: true };
}

export function validateNextRequest(
  current: { nextPosition: number; predecessorMessageId: string | null },
  incoming: { position: number; predecessorMessageId: string | null },
): { ok: true } | { ok: false; code: 'conversation_order_conflict' } {
  return incoming.position === current.nextPosition
    && incoming.predecessorMessageId === current.predecessorMessageId
    ? { ok: true }
    : { ok: false, code: 'conversation_order_conflict' };
}

export interface RosterAgentInput {
  agentId: string;
  teamId: string;
  addressName: string;
  displayName: string;
  runtime: string;
  model: string;
  effort: string | null;
  organizationTags: string[];
  groups: string[];
  catalog: Record<string, unknown>;
  available: boolean;
  deleted: boolean;
}

export type RecipientResolution =
  | { ok: true; agentId: string }
  | { ok: false; code: 'recipient_not_found' | 'recipient_ambiguous' | 'recipient_unavailable' };

export function resolveRosterRecipient(
  destinationTeamId: string,
  destination: Exclude<Destination, { kind: 'team' }>,
  agents: RosterAgentInput[],
): RecipientResolution {
  const active = agents.filter((agent) => agent.teamId === destinationTeamId && !agent.deleted);
  if (destination.kind === 'agent_id') {
    const match = active.find((agent) => agent.agentId === destination.agentId);
    if (!match) return { ok: false, code: 'recipient_not_found' };
    return match.available
      ? { ok: true, agentId: match.agentId }
      : { ok: false, code: 'recipient_unavailable' };
  }
  const matches = active.filter((agent) => agent.addressName === destination.agentName);
  if (matches.length === 0) return { ok: false, code: 'recipient_not_found' };
  if (matches.length > 1) return { ok: false, code: 'recipient_ambiguous' };
  return matches[0].available
    ? { ok: true, agentId: matches[0].agentId }
    : { ok: false, code: 'recipient_unavailable' };
}

export interface RosterAgent {
  agentId: string;
  addressName: string;
  displayName: string;
  runtime: string;
  model: string;
  effort: string | null;
  organizationTags: string[];
  groups: string[];
  catalog: Record<string, unknown>;
  catalogAuthority: 'agent_asserted';
}

export function readRoster(
  _inboundPolicy: InboundPolicy,
  agents: RosterAgentInput[],
  bounds: { maxAgents: number; maxEncodedBytes: number },
): { ok: true; agents: RosterAgent[] } | { ok: false; code: 'read_response_too_large' } {
  const visible = agents.filter((agent) => !agent.deleted).map((agent) => ({
    agentId: agent.agentId,
    addressName: agent.addressName,
    displayName: agent.displayName,
    runtime: agent.runtime,
    model: agent.model,
    effort: agent.effort,
    organizationTags: [...agent.organizationTags],
    groups: [...agent.groups],
    catalog: { ...agent.catalog },
    catalogAuthority: 'agent_asserted' as const,
  }));
  if (visible.length > bounds.maxAgents) return { ok: false, code: 'read_response_too_large' };
  if (Buffer.byteLength(JSON.stringify({ agents: visible }), 'utf8') > bounds.maxEncodedBytes) {
    return { ok: false, code: 'read_response_too_large' };
  }
  return { ok: true, agents: visible };
}

export function rosterReadRateResult(
  requestsRemaining: number,
): { ok: true } | { ok: false; code: 'read_rate_limited' } {
  return requestsRemaining > 0 ? { ok: true } : { ok: false, code: 'read_rate_limited' };
}
