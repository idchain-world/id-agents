// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  INTER_TEAM_PROTOCOL_VERSION,
  RESUBMISSION_HORIZON_MS,
  automaticResubmissionAllowed,
  canTransitionMessage,
  classifyReplay,
  collectMessage,
  newConversationPolicyResult,
  parseInterTeamAddress,
  protocolCompatibility,
  readRoster,
  recognizedEnvelopeIdentity,
  resolveRosterRecipient,
  rosterReadRateResult,
  validateConversationParticipant,
  validateDeliveryContext,
  validateNextRequest,
  type InterTeamRequestEnvelope,
  type RosterAgentInput,
} from '../../src/inter-team/protocol.js';

const envelope: InterTeamRequestEnvelope = {
  protocolVersion: INTER_TEAM_PROTOCOL_VERSION,
  originNodeId: 'node-origin',
  originTeamId: 'team-origin',
  destinationNodeId: 'node-destination',
  destinationTeamId: 'team-destination',
  destination: { kind: 'agent_name', agentName: 'reviewer' },
  conversationId: 'conversation-1',
  messageId: 'message-1',
  position: 0,
  predecessorMessageId: null,
  firstSubmittedAt: 1_000,
  body: { task: 'review', order: ['a', 'b'] },
};

const rosterAgent = (overrides: Partial<RosterAgentInput> = {}): RosterAgentInput => ({
  agentId: 'agent-1',
  teamId: 'team-destination',
  addressName: 'reviewer',
  displayName: 'Reviewer',
  runtime: 'codex-cli',
  model: 'gpt',
  effort: 'high',
  organizationTags: ['security'],
  groups: ['review'],
  catalog: { role: 'reviewer', custom: { retained: true } },
  available: true,
  deleted: false,
  ...overrides,
});

describe('inter-team V1 protocol contract', () => {
  it('parses team and named-agent display addresses', () => {
    expect(parseInterTeamAddress('team:security')).toEqual({
      ok: true,
      value: { contactAlias: 'security', destination: { kind: 'team' } },
    });
    expect(parseInterTeamAddress('team:security/reviewer')).toEqual({
      ok: true,
      value: {
        contactAlias: 'security',
        destination: { kind: 'agent_name', agentName: 'reviewer' },
      },
    });
  });

  it('rejects malformed display addresses and provides no agent-id display form', () => {
    for (const value of ['', 'security', 'team:', 'team:security/', 'team:security/a/b']) {
      expect(parseInterTeamAddress(value)).toEqual({ ok: false, code: 'invalid_address' });
    }
  });

  it('accepts every minor in the receiver major and rejects another major', () => {
    expect(protocolCompatibility('1.0', '1.99')).toEqual({ ok: true });
    expect(protocolCompatibility('1.7', '1.0')).toEqual({ ok: true });
    expect(protocolCompatibility('1.0', '2.0')).toEqual({
      ok: false,
      code: 'protocol_unsupported',
    });
    expect(protocolCompatibility('1', '1.0')).toEqual({
      ok: false,
      code: 'protocol_unsupported',
    });
  });

  it('rejects a federation claim of our node while same-manager delivery succeeds', () => {
    expect(validateDeliveryContext({
      kind: 'federation',
      localNodeId: 'node-local',
      claimedOriginNodeId: 'node-local',
      originTeamId: 'team-a',
    })).toEqual({ ok: false, reason: 'self_node_claim' });

    expect(validateDeliveryContext({
      kind: 'same_manager',
      localNodeId: 'node-local',
      originTeamId: 'team-a',
    })).toEqual({ ok: true, originNodeId: 'node-local', originTeamId: 'team-a' });
  });

  it('requires durable evidence for processing and terminal transitions', () => {
    expect(canTransitionMessage('accepted', 'processing')).toBe(false);
    expect(canTransitionMessage('accepted', 'processing', { durableJobLink: true })).toBe(true);
    expect(canTransitionMessage('processing', 'completed')).toBe(false);
    expect(canTransitionMessage('processing', 'completed', { durableResult: true })).toBe(true);
    expect(canTransitionMessage('accepted', 'failed', { durableFailure: true })).toBe(true);
  });

  it('keeps confirmed states monotonic and exits unknown only on evidence', () => {
    expect(canTransitionMessage('processing', 'accepted')).toBe(false);
    expect(canTransitionMessage('processing', 'unknown')).toBe(true);
    expect(canTransitionMessage('unknown', 'processing', { durableJobLink: true })).toBe(false);
    expect(canTransitionMessage('unknown', 'completed')).toBe(false);
    expect(canTransitionMessage('unknown', 'completed', { durableResult: true })).toBe(true);
    expect(canTransitionMessage('unknown', 'failed', { durableFailure: true })).toBe(true);
  });

  it('makes completed and failed states terminal', () => {
    for (const terminal of ['completed', 'failed'] as const) {
      expect(canTransitionMessage(terminal, 'accepted')).toBe(false);
      expect(canTransitionMessage(terminal, 'processing')).toBe(false);
      expect(canTransitionMessage(terminal, 'unknown')).toBe(false);
    }
  });

  it('collects all five states without consuming them', () => {
    expect(collectMessage({ state: 'accepted', lastConfirmedState: 'accepted' })).toEqual({
      state: 'accepted',
      lastConfirmedState: 'accepted',
    });
    expect(collectMessage({ state: 'processing', lastConfirmedState: 'processing' })).toEqual({
      state: 'processing',
      lastConfirmedState: 'processing',
    });
    expect(collectMessage({ state: 'unknown', lastConfirmedState: 'processing' })).toEqual({
      state: 'unknown',
      lastConfirmedState: 'processing',
    });
    const completed = { state: 'completed' as const, lastConfirmedState: 'completed' as const, durableResult: { value: null } };
    expect(collectMessage(completed)).toEqual(collectMessage(completed));
    expect(collectMessage({ state: 'failed', lastConfirmedState: 'failed', failureCode: 'recipient_deleted' })).toEqual({
      state: 'failed',
      lastConfirmedState: 'failed',
      retention: 'retained',
      failureCode: 'recipient_deleted',
      failureDetailPresent: true,
    });
  });

  it('requires an explicit durable result before completed', () => {
    expect(() => collectMessage({ state: 'completed', lastConfirmedState: 'completed' })).toThrow(
      'completed requires a durable result',
    );
    expect(collectMessage({
      state: 'completed',
      lastConfirmedState: 'completed',
      durableResult: { value: null },
    })).toMatchObject({ resultPresent: true, result: null });
  });

  it('reports compacted and receipt-only collection without pretending a payload exists', () => {
    expect(collectMessage({
      state: 'completed',
      lastConfirmedState: 'completed',
      retention: 'compacted',
    })).toMatchObject({ retention: 'compacted', resultPresent: false });
    expect(collectMessage({
      state: 'failed',
      lastConfirmedState: 'failed',
      retention: 'compacted',
      failureCode: 'recipient_deleted',
    })).toMatchObject({
      retention: 'compacted',
      failureCode: 'recipient_deleted',
      failureDetailPresent: true,
    });
    expect(collectMessage({
      state: 'failed',
      lastConfirmedState: 'failed',
      retention: 'receipt',
      failureCode: 'hidden-by-retention',
    })).toMatchObject({ retention: 'receipt', failureCode: null, failureDetailPresent: false });
  });

  it('treats only the recognized envelope as replay identity', () => {
    const accepted = recognizedEnvelopeIdentity(envelope);
    const withUnknownMinorField = { ...envelope, extensionFromNewerMinor: 'ignored' };
    expect(classifyReplay(accepted, withUnknownMinorField)).toEqual({ kind: 'identical_replay' });
    expect(classifyReplay(accepted, { ...envelope, body: { task: 'different' } })).toEqual({
      kind: 'conflict',
      code: 'idempotency_conflict',
    });
  });

  it('canonicalizes object keys when comparing identical replays', () => {
    const accepted = recognizedEnvelopeIdentity(envelope);
    expect(classifyReplay(accepted, {
      ...envelope,
      body: { order: ['a', 'b'], task: 'review' },
    })).toEqual({ kind: 'identical_replay' });
  });

  it('binds continuations and collection to the original participants', () => {
    const binding = {
      originNodeId: envelope.originNodeId,
      originTeamId: envelope.originTeamId,
      destinationNodeId: envelope.destinationNodeId,
      destinationTeamId: envelope.destinationTeamId,
      destination: { kind: 'agent_id' as const, agentId: 'agent-1' },
    };
    expect(validateConversationParticipant(binding, {
      originNodeId: 'node-origin',
      originTeamId: 'team-origin',
      destinationTeamId: 'team-destination',
    })).toEqual({ ok: true });
    expect(validateConversationParticipant(binding, {
      originNodeId: 'node-other',
      originTeamId: 'team-origin',
      destinationTeamId: 'team-destination',
    })).toEqual({ ok: false, code: 'conversation_not_found' });
  });

  it('keeps open permissive for every destination variant with no behavior flag', () => {
    const destinations = [
      { kind: 'team' as const },
      { kind: 'agent_name' as const, agentName: 'reviewer' },
      { kind: 'agent_id' as const, agentId: 'agent-1' },
    ];
    for (const destination of destinations) {
      expect(newConversationPolicyResult('open', destination)).toEqual({ ok: true });
      expect(newConversationPolicyResult('closed', destination)).toEqual({
        ok: false,
        code: 'target_closed',
      });
    }
  });

  it('rejects gaps, reused positions, and predecessor forks', () => {
    const current = { nextPosition: 2, predecessorMessageId: 'message-1' };
    expect(validateNextRequest(current, { position: 2, predecessorMessageId: 'message-1' })).toEqual({ ok: true });
    expect(validateNextRequest(current, { position: 3, predecessorMessageId: 'message-1' })).toMatchObject({ code: 'conversation_order_conflict' });
    expect(validateNextRequest(current, { position: 1, predecessorMessageId: 'message-1' })).toMatchObject({ code: 'conversation_order_conflict' });
    expect(validateNextRequest(current, { position: 2, predecessorMessageId: 'fork' })).toMatchObject({ code: 'conversation_order_conflict' });
  });

  it('enforces the fixed automatic-resubmission horizon', () => {
    expect(automaticResubmissionAllowed(1_000, 1_000 + RESUBMISSION_HORIZON_MS)).toBe(true);
    expect(automaticResubmissionAllowed(1_000, 1_001 + RESUBMISSION_HORIZON_MS)).toBe(false);
  });

  it('rejects ambiguous names and keeps immutable ID addressing unambiguous', () => {
    const agents = [rosterAgent(), rosterAgent({ agentId: 'agent-2' })];
    expect(resolveRosterRecipient('team-destination', { kind: 'agent_name', agentName: 'reviewer' }, agents)).toEqual({
      ok: false,
      code: 'recipient_ambiguous',
    });
    expect(resolveRosterRecipient('team-destination', { kind: 'agent_id', agentId: 'agent-2' }, agents)).toEqual({
      ok: true,
      agentId: 'agent-2',
    });
  });

  it('does not resolve an ID from another team and reports unavailable recipients', () => {
    expect(resolveRosterRecipient('team-destination', { kind: 'agent_id', agentId: 'agent-other' }, [
      rosterAgent({ agentId: 'agent-other', teamId: 'team-other' }),
    ])).toEqual({ ok: false, code: 'recipient_not_found' });
    expect(resolveRosterRecipient('team-destination', { kind: 'agent_name', agentName: 'reviewer' }, [
      rosterAgent({ available: false }),
    ])).toEqual({ ok: false, code: 'recipient_unavailable' });
  });

  it('returns the same whole, explicitly non-authoritative catalog under either policy', () => {
    const bounds = { maxAgents: 10, maxEncodedBytes: 10_000 };
    const open = readRoster('open', [rosterAgent()], bounds);
    const closed = readRoster('closed', [rosterAgent()], bounds);
    expect(open).toEqual(closed);
    expect(open).toMatchObject({
      ok: true,
      agents: [{
        catalog: { role: 'reviewer', custom: { retained: true } },
        catalogAuthority: 'agent_asserted',
        groups: ['review'],
      }],
    });
  });

  it('rejects bounded roster reads instead of silently truncating', () => {
    expect(rosterReadRateResult(0)).toEqual({ ok: false, code: 'read_rate_limited' });
    expect(readRoster('open', [rosterAgent(), rosterAgent({ agentId: 'agent-2' })], {
      maxAgents: 1,
      maxEncodedBytes: 10_000,
    })).toEqual({ ok: false, code: 'read_response_too_large' });
    expect(readRoster('closed', [rosterAgent()], {
      maxAgents: 10,
      maxEncodedBytes: 1,
    })).toEqual({ ok: false, code: 'read_response_too_large' });
  });
});
