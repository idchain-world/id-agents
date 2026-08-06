// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../db/db-adapter.js';
import { PeerRouteStore } from './peer-routes.js';
import { HttpFederationTransport } from './federation-client.js';
import type { FederationTransport } from './federation-transport.js';

/**
 * Item 2: is this peer actually reachable, and is it the node we pinned?
 *
 * A route stores an address and nothing ever asks whether that address answers,
 * so the first sign of a stale route today is a failed send. The probe asks on
 * demand, through the transport's own client, so a green probe means the next
 * send works rather than merely that something is listening. It performs the
 * same responder identity check the transport performs on every attempt, which
 * is what makes reaching the wrong node distinguishable from reaching nothing.
 *
 * It is a read. It never creates, updates, enables, disables, or heals a route,
 * because a diagnostic that repairs what it measures cannot be trusted to
 * report what was wrong.
 *
 * Probing is per route and on demand. Listing routes must not probe them all:
 * one unreachable peer would cost a timeout before the list rendered, which is
 * the same reasoning that keeps the conversation index from fanning out.
 */

export type PeerRouteProbeOutcome =
  | 'reachable'
  | 'node_mismatch'
  | 'unreachable'
  | 'timed_out'
  | 'no_route';

export interface PeerRouteProbeResult {
  nodeId: string;
  outcome: PeerRouteProbeOutcome;
  /** Present when a route exists, so the operator sees what was dialled. */
  baseUrl: string | null;
  enabled: boolean | null;
  /** Set only for node_mismatch: who we expected against who answered. */
  expectedNodeId?: string;
  actualNodeId?: string;
  /** Operator-facing detail. Never a wire code and never reusable as a route. */
  diagnostic: string | null;
  probedAt: number;
}

/**
 * The descriptor read is the cheapest request that still exercises identity.
 * A team ID that cannot exist is deliberate: reachability and identity are what
 * is being measured, and the peer's answer about an unknown team is as good a
 * proof of both as an answer about a real one.
 */
const PROBE_TEAM_ID = '00000000-0000-0000-0000-000000000000';

export class PeerRouteProbe {
  private readonly routes: PeerRouteStore;
  private readonly transport: FederationTransport;

  constructor(
    db: DbAdapter,
    options: { transport?: FederationTransport } = {},
  ) {
    this.routes = new PeerRouteStore(db);
    this.transport = options.transport ?? new HttpFederationTransport(db, { timeoutMs: 5000 });
  }

  async probe(input: {
    nodeId: string;
    localNodeId: string;
    localTeamId: string;
    now?: number;
  }): Promise<PeerRouteProbeResult> {
    const probedAt = input.now ?? Date.now();
    const route = await this.routes.get(input.nodeId);
    if (!route || !route.enabled) {
      return {
        nodeId: input.nodeId,
        outcome: 'no_route',
        baseUrl: route?.baseUrl ?? null,
        enabled: route?.enabled ?? null,
        diagnostic: route
          ? 'a route exists but is disabled, so nothing was dialled'
          : 'no route is configured for this node',
        probedAt,
      };
    }

    const result = await this.transport.describeTeam({
      destinationNodeId: input.nodeId,
      originNodeId: input.localNodeId,
      originTeamId: input.localTeamId,
      destinationTeamId: PROBE_TEAM_ID,
    });

    const base = {
      nodeId: input.nodeId,
      baseUrl: route.baseUrl,
      enabled: route.enabled,
      probedAt,
    };

    // A peer that answers at all has proven both reachability and identity,
    // because the transport validates the responder before returning anything.
    // Its refusal of an unknown team is therefore a successful probe.
    if (result.ok || ('peerRejection' in result && result.peerRejection)) {
      return { ...base, outcome: 'reachable', diagnostic: null };
    }

    if (result.code === 'peer_node_mismatch') {
      return {
        ...base,
        outcome: 'node_mismatch',
        expectedNodeId: input.nodeId,
        actualNodeId: extractActualNodeId(result.diagnostic),
        diagnostic: result.diagnostic,
      };
    }
    if (result.code === 'peer_timeout') {
      return { ...base, outcome: 'timed_out', diagnostic: result.diagnostic };
    }
    return { ...base, outcome: 'unreachable', diagnostic: result.diagnostic };
  }
}

/**
 * The transport's mismatch diagnostic already names both nodes. Parsing it back
 * out keeps one source of truth for that message rather than threading a second
 * structured field through the transport for the sake of one caller.
 */
function extractActualNodeId(diagnostic: string): string | undefined {
  const match = /reached ([^\s]+)/.exec(diagnostic);
  return match?.[1];
}
