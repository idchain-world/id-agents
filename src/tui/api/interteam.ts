// SPDX-License-Identifier: MIT

/**
 * Items 7 and 8: what the contacts and node connections views read.
 *
 * These are two objects with two scopes and they stay separate on purpose. A
 * contact answers who a team may address. A route answers whether this machine
 * can reach a node at all. Merging them would hide the most common
 * misconfiguration, which is a contact pinned to a node with no route, so the
 * contacts view carries that join explicitly instead.
 *
 * Listing never probes. One unreachable peer would otherwise cost a timeout
 * before anything rendered, so probing is a per-route action the operator asks
 * for, exactly as it is on the server side.
 */

export interface PeerRouteRow {
  nodeId: string;
  baseUrl: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type PeerRouteProbeOutcome =
  | 'reachable'
  | 'node_mismatch'
  | 'unreachable'
  | 'timed_out'
  | 'no_route';

export interface PeerRouteProbeRow {
  nodeId: string;
  outcome: PeerRouteProbeOutcome;
  baseUrl: string | null;
  enabled: boolean | null;
  expectedNodeId?: string;
  actualNodeId?: string;
  diagnostic: string | null;
  probedAt: number;
}

export interface ContactRow {
  id: string;
  aliasDisplay: string;
  remoteNodeId: string;
  remoteTeamId: string;
}

/** A contact plus whether the machine can actually reach the node it pins. */
export interface ContactWithReachability extends ContactRow {
  routeConfigured: boolean;
  routeEnabled: boolean;
  /** Present only after an explicit probe, never fetched by the list. */
  probe?: PeerRouteProbeRow;
}

export interface InterteamClientOptions {
  managerUrl: string;
  team: string;
  fetchImpl?: typeof fetch;
}

export class InterteamAdminClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: InterteamClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(`${this.options.managerUrl}${path}`, {
      ...init,
      headers: {
        'X-Id-Admin': '1',
        'X-Id-Team': this.options.team,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((body as { error?: string }).error ?? `http_${response.status}`);
    return body;
  }

  async listRoutes(): Promise<PeerRouteRow[]> {
    const body = await this.request('/inter-team/config/peer-routes') as { routes?: PeerRouteRow[] };
    return body.routes ?? [];
  }

  /** Explicit, per route. Never called while listing. */
  async probeRoute(nodeId: string): Promise<PeerRouteProbeRow> {
    const body = await this.request(
      `/inter-team/config/peer-routes/${encodeURIComponent(nodeId)}/probe`,
      { method: 'POST' },
    ) as { probe: PeerRouteProbeRow };
    return body.probe;
  }

  async listContacts(): Promise<ContactRow[]> {
    const body = await this.request('/inter-team/config/contacts') as { contacts?: ContactRow[] };
    return body.contacts ?? [];
  }

  /**
   * The join that makes the contacts view worth having: a contact whose pinned
   * node has no enabled route cannot be reached, and nothing says so today.
   */
  async listContactsWithReachability(): Promise<ContactWithReachability[]> {
    const [contacts, routes] = await Promise.all([this.listContacts(), this.listRoutes()]);
    const byNode = new Map(routes.map((route) => [route.nodeId, route]));
    return contacts.map((contact) => {
      const route = byNode.get(contact.remoteNodeId);
      return {
        ...contact,
        routeConfigured: !!route,
        routeEnabled: route?.enabled ?? false,
      };
    });
  }
}

/** How a probe outcome reads in a terminal, as a state rather than an error. */
export function describeProbeOutcome(probe: PeerRouteProbeRow): string {
  switch (probe.outcome) {
    case 'reachable':
      return 'reachable';
    case 'node_mismatch':
      return `wrong node answered (expected ${probe.expectedNodeId ?? '?'}, got ${probe.actualNodeId ?? '?'})`;
    case 'unreachable':
      return 'unreachable';
    case 'timed_out':
      return 'timed out';
    default:
      return probe.enabled === false ? 'route disabled' : 'no route';
  }
}

/** A contact the machine cannot reach, which is the misconfiguration to surface. */
export function contactIsReachable(contact: ContactWithReachability): boolean {
  return contact.routeConfigured && contact.routeEnabled;
}
