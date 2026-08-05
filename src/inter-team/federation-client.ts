// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../db/db-adapter.js';
import { PeerRouteStore } from './peer-routes.js';
import {
  FEDERATION_ORIGIN_NODE_HEADER,
  FEDERATION_ORIGIN_TEAM_HEADER,
} from './federation-app.js';
import type {
  FederationCollectResult,
  FederationDescriptorResult,
  FederationSubmitResult,
  FederationTransport,
  FederationTransportError,
} from './federation-transport.js';
import type { CollectionResult, InterTeamRequestEnvelope } from './protocol.js';

/**
 * Commit 15: the outbound half of the federation contract.
 *
 * Routes are resolved late, on every attempt, by pinned destination node ID, so
 * an operator can move a peer without touching message identity. The responder
 * identity is checked before any outcome is interpreted, which is what refuses
 * a substituted peer. That check detects accidental substitution only; it is
 * not authentication.
 */

export const DEFAULT_FEDERATION_TIMEOUT_MS = 15_000;
export const DEFAULT_FEDERATION_MAX_RESPONSE_BYTES = 1024 * 1024;

function transportError(
  code: FederationTransportError['code'],
  diagnostic: string,
  outcomeUnknown: boolean,
): FederationTransportError {
  return { ok: false, code, diagnostic, outcomeUnknown };
}

export class HttpFederationTransport implements FederationTransport {
  private readonly routes: PeerRouteStore;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    db: DbAdapter,
    options: {
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      maxResponseBytes?: number;
    } = {},
  ) {
    this.routes = new PeerRouteStore(db);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FEDERATION_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_FEDERATION_MAX_RESPONSE_BYTES;
  }

  /**
   * One request, one late route resolution, one identity check.
   *
   * `writeAttempt` decides whether a failure leaves the outcome unknown. A read
   * that fails consumes nothing; a write that fails may still have committed at
   * the peer, so it must never be replaced by a new message.
   */
  private async call(input: {
    destinationNodeId: string;
    originNodeId: string;
    originTeamId: string;
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    writeAttempt: boolean;
  }): Promise<
    | { ok: true; status: number; payload: Record<string, unknown> }
    | FederationTransportError
  > {
    let route;
    try {
      route = await this.routes.resolveEnabled(input.destinationNodeId);
    } catch (error) {
      return transportError('peer_route_invalid', String((error as Error).message), false);
    }
    if (!route) {
      return transportError(
        'peer_route_unconfigured',
        `no enabled route for node ${input.destinationNodeId}`,
        false,
      );
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${route.baseUrl}${input.path}`, {
        method: input.method,
        headers: {
          'Content-Type': 'application/json',
          [FEDERATION_ORIGIN_NODE_HEADER]: input.originNodeId,
          [FEDERATION_ORIGIN_TEAM_HEADER]: input.originTeamId,
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = String((error as Error)?.name === 'TimeoutError'
        ? 'deadline elapsed'
        : (error as Error)?.message ?? error);
      const timedOut = (error as Error)?.name === 'TimeoutError';
      return transportError(
        timedOut ? 'peer_timeout' : 'peer_unreachable',
        `${route.baseUrl}: ${message}`,
        input.writeAttempt,
      );
    }

    const text = await response.text().catch(() => '');
    if (text.length > this.maxResponseBytes) {
      return transportError('peer_response_invalid', 'response exceeded the bound', input.writeAttempt);
    }
    let payload: Record<string, unknown>;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      return transportError('peer_response_invalid', 'response was not JSON', input.writeAttempt);
    }
    // A peer 5xx is a transport failure, not a protocol answer: the origin
    // cannot prove the receiver did not commit.
    if (response.status >= 500) {
      return transportError('peer_unreachable', `peer returned ${response.status}`, input.writeAttempt);
    }
    if (typeof payload.nodeId !== 'string' || typeof payload.protocolVersion !== 'string') {
      return transportError(
        'peer_response_invalid',
        'response carried no responder identity',
        input.writeAttempt,
      );
    }
    // Identity before outcome. A different node means the route is stale or
    // substituted, and its protocol outcome is discarded entirely.
    if (payload.nodeId !== input.destinationNodeId) {
      return transportError(
        'peer_node_mismatch',
        `expected node ${input.destinationNodeId}, reached ${payload.nodeId} at ${route.baseUrl}`,
        input.writeAttempt,
      );
    }
    return { ok: true, status: response.status, payload };
  }

  async submit(input: {
    destinationNodeId: string;
    envelope: InterTeamRequestEnvelope;
  }): Promise<FederationSubmitResult> {
    const called = await this.call({
      destinationNodeId: input.destinationNodeId,
      originNodeId: input.envelope.originNodeId,
      originTeamId: input.envelope.originTeamId,
      method: 'POST',
      path: '/federation/messages',
      body: { envelope: input.envelope },
      writeAttempt: true,
    });
    if (!called.ok) return called;
    if (called.status === 202 && typeof called.payload.state === 'string') {
      return {
        ok: true,
        state: called.payload.state as FederationSubmitResult extends { state: infer S } ? S : never,
        deduplicated: called.payload.deduplicated === true,
        messageId: String(called.payload.messageId ?? input.envelope.messageId),
      } as FederationSubmitResult;
    }
    return {
      ok: false,
      peerRejection: true,
      code: String(called.payload.error ?? 'peer_response_invalid'),
      diagnostic: `peer rejected the submission with ${called.payload.error}`,
      outcomeUnknown: false,
    };
  }

  async collect(input: {
    destinationNodeId: string;
    originNodeId: string;
    originTeamId: string;
    destinationTeamId: string;
    conversationId: string;
    messageId: string;
  }): Promise<FederationCollectResult> {
    const called = await this.call({
      destinationNodeId: input.destinationNodeId,
      originNodeId: input.originNodeId,
      originTeamId: input.originTeamId,
      method: 'GET',
      path: `/federation/conversations/${encodeURIComponent(input.conversationId)}`
        + `/messages/${encodeURIComponent(input.messageId)}`
        + `?destinationTeamId=${encodeURIComponent(input.destinationTeamId)}`,
      writeAttempt: false,
    });
    if (!called.ok) return called;
    if (called.status === 200 && called.payload.result) {
      return { ok: true, value: called.payload.result as CollectionResult };
    }
    return {
      ok: false,
      peerRejection: true,
      code: String(called.payload.error ?? 'peer_response_invalid'),
      diagnostic: `peer refused the collection with ${called.payload.error}`,
      outcomeUnknown: false,
    };
  }

  async describeTeam(input: {
    destinationNodeId: string;
    originNodeId: string;
    originTeamId: string;
    destinationTeamId: string;
  }): Promise<FederationDescriptorResult> {
    const called = await this.call({
      destinationNodeId: input.destinationNodeId,
      originNodeId: input.originNodeId,
      originTeamId: input.originTeamId,
      method: 'GET',
      path: `/federation/teams/${encodeURIComponent(input.destinationTeamId)}/descriptor`,
      writeAttempt: false,
    });
    if (!called.ok) return called;
    if (called.status === 200 && called.payload.descriptor) {
      return { ok: true, value: called.payload.descriptor as Record<string, unknown> };
    }
    return {
      ok: false,
      peerRejection: true,
      code: String(called.payload.error ?? 'peer_response_invalid'),
      diagnostic: `peer refused the descriptor read with ${called.payload.error}`,
      outcomeUnknown: false,
    };
  }
}
