// SPDX-License-Identifier: MIT

import type { CollectionResult, InterTeamRequestEnvelope, MessageState } from './protocol.js';

/**
 * Commit 14: the transport seam only.
 *
 * This declares what a federation transport must do and supplies a default
 * that reports every peer unconfigured. No socket, no client, and no wire
 * format exist in this commit. The seam is what makes ordering observable:
 * outbound state must be durable before any transport can see an attempt, and
 * "before" is only testable if there is something that could have seen it.
 *
 * Every outcome below is origin-local. None of these codes crosses the wire or
 * enlarges the receiver's fixed pre-accept code set.
 */

export type FederationTransportFailure =
  | 'peer_route_unconfigured'
  | 'peer_route_invalid'
  | 'peer_unreachable'
  | 'peer_timeout'
  | 'peer_node_mismatch'
  | 'peer_response_invalid';

/** A transport failure leaves a write's outcome unknown, never failed. */
export interface FederationTransportError {
  ok: false;
  code: FederationTransportFailure;
  diagnostic: string;
  /** True when the peer may have committed, so the write must not be replaced. */
  outcomeUnknown: boolean;
}

export interface FederationSubmitOk {
  ok: true;
  state: MessageState;
  deduplicated: boolean;
  messageId: string;
}

/** A peer's confirmed protocol rejection, distinct from a transport failure. */
export interface FederationPeerRejection {
  ok: false;
  code: string;
  peerRejection: true;
  diagnostic: string;
  outcomeUnknown: false;
}

export type FederationSubmitResult =
  | FederationSubmitOk
  | FederationTransportError
  | FederationPeerRejection;

export type FederationCollectResult =
  | { ok: true; value: CollectionResult }
  | FederationTransportError
  | FederationPeerRejection;

export type FederationDescriptorResult =
  | { ok: true; value: Record<string, unknown> }
  | FederationTransportError
  | FederationPeerRejection;

export interface FederationTransport {
  /** Submit a cold start, continuation, or identical resubmission. */
  submit(input: {
    destinationNodeId: string;
    envelope: InterTeamRequestEnvelope;
  }): Promise<FederationSubmitResult>;

  /** Non-consuming remote read by conversation and message ID. */
  collect(input: {
    destinationNodeId: string;
    originNodeId: string;
    originTeamId: string;
    destinationTeamId: string;
    conversationId: string;
    messageId: string;
  }): Promise<FederationCollectResult>;

  /** Descriptor read addressed by immutable remote team ID. */
  describeTeam(input: {
    destinationNodeId: string;
    originNodeId: string;
    originTeamId: string;
    destinationTeamId: string;
  }): Promise<FederationDescriptorResult>;
}

function unconfigured(destinationNodeId: string): FederationTransportError {
  return {
    ok: false,
    code: 'peer_route_unconfigured',
    diagnostic: `no federation transport is configured for node ${destinationNodeId}`,
    outcomeUnknown: false,
  };
}

/**
 * The default until a transport is supplied. It never opens a connection, so a
 * node with no federation configured behaves exactly as it did before Phase E.
 */
export const UNCONFIGURED_FEDERATION_TRANSPORT: FederationTransport = {
  async submit({ destinationNodeId }) {
    return unconfigured(destinationNodeId);
  },
  async collect({ destinationNodeId }) {
    return unconfigured(destinationNodeId);
  },
  async describeTeam({ destinationNodeId }) {
    return unconfigured(destinationNodeId);
  },
};
