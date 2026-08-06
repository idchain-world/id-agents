// SPDX-License-Identifier: MIT
/**
 * Items 7 and 8: contacts and node connections in the TUI.
 *
 * Two objects, two scopes, kept separate. A contact says who a team may
 * address; a route says whether this machine can reach a node at all. The join
 * between them is what surfaces the most common misconfiguration, a contact
 * pinned to a node with no route, which is invisible today.
 *
 * The load-bearing assertion is that listing never probes. One unreachable peer
 * must not cost a timeout before anything renders.
 */
import { describe, expect, it } from 'vitest';
import {
  InterteamAdminClient,
  contactIsReachable,
  describeProbeOutcome,
  type PeerRouteProbeRow,
} from '../../src/tui/api/interteam.js';

function stubFetch(routes: unknown[], contacts: unknown[], probe?: unknown) {
  const calls: string[] = [];
  const fetchImpl = (async (url: any, init?: any) => {
    const path = String(url);
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const json = path.includes('/probe') ? { probe }
      : path.endsWith('/peer-routes') ? { routes }
      : path.endsWith('/contacts') ? { contacts }
      : {};
    return { ok: true, json: async () => json } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ROUTES = [
  { nodeId: 'node-a', baseUrl: 'http://peer-a:4400', enabled: true, createdAt: 1, updatedAt: 1 },
  { nodeId: 'node-b', baseUrl: 'http://peer-b:4400', enabled: false, createdAt: 1, updatedAt: 1 },
];
const CONTACTS = [
  { id: 'c1', aliasDisplay: 'alpha', remoteNodeId: 'node-a', remoteTeamId: 'team-a' },
  { id: 'c2', aliasDisplay: 'beta', remoteNodeId: 'node-b', remoteTeamId: 'team-b' },
  { id: 'c3', aliasDisplay: 'orphan', remoteNodeId: 'node-z', remoteTeamId: 'team-z' },
];

describe('node connections view data', () => {
  it('lists routes without probing any of them', async () => {
    const { fetchImpl, calls } = stubFetch(ROUTES, CONTACTS);
    const client = new InterteamAdminClient({ managerUrl: 'http://127.0.0.1:4100', team: 'ops', fetchImpl });

    const routes = await client.listRoutes();
    expect(routes).toHaveLength(2);
    // One unreachable peer must not stall the list.
    expect(calls.some((call) => call.includes('/probe'))).toBe(false);
  });

  it('probes one route, only when asked', async () => {
    const probe: PeerRouteProbeRow = {
      nodeId: 'node-a', outcome: 'reachable', baseUrl: 'http://peer-a:4400',
      enabled: true, diagnostic: null, probedAt: 5,
    };
    const { fetchImpl, calls } = stubFetch(ROUTES, CONTACTS, probe);
    const client = new InterteamAdminClient({ managerUrl: 'http://127.0.0.1:4100', team: 'ops', fetchImpl });

    expect(await client.probeRoute('node-a')).toEqual(probe);
    expect(calls.filter((call) => call.includes('/probe'))).toEqual([
      'POST http://127.0.0.1:4100/inter-team/config/peer-routes/node-a/probe',
    ]);
  });

  it('renders every probe outcome as a state, never as an error', () => {
    const base = { nodeId: 'n', baseUrl: null, enabled: null, diagnostic: null, probedAt: 1 };
    expect(describeProbeOutcome({ ...base, outcome: 'reachable' })).toBe('reachable');
    expect(describeProbeOutcome({ ...base, outcome: 'unreachable' })).toBe('unreachable');
    expect(describeProbeOutcome({ ...base, outcome: 'timed_out' })).toBe('timed out');
    expect(describeProbeOutcome({ ...base, outcome: 'no_route' })).toBe('no route');
    expect(describeProbeOutcome({ ...base, outcome: 'no_route', enabled: false })).toBe('route disabled');
    // The mismatch names both nodes, because a stale route and a misconfigured
    // one are different problems with different fixes.
    expect(describeProbeOutcome({
      ...base, outcome: 'node_mismatch', expectedNodeId: 'want', actualNodeId: 'got',
    })).toContain('expected want, got got');
  });
});

describe('contacts view data', () => {
  it('marks a contact whose pinned node has no route, and one whose route is disabled', async () => {
    const { fetchImpl, calls } = stubFetch(ROUTES, CONTACTS);
    const client = new InterteamAdminClient({ managerUrl: 'http://127.0.0.1:4100', team: 'ops', fetchImpl });

    const contacts = await client.listContactsWithReachability();
    const byAlias = Object.fromEntries(contacts.map((c) => [c.aliasDisplay, c]));

    expect(byAlias.alpha).toMatchObject({ routeConfigured: true, routeEnabled: true });
    expect(contactIsReachable(byAlias.alpha!)).toBe(true);

    // A disabled route is configured but cannot carry a message.
    expect(byAlias.beta).toMatchObject({ routeConfigured: true, routeEnabled: false });
    expect(contactIsReachable(byAlias.beta!)).toBe(false);

    // The common misconfiguration, invisible before this view existed.
    expect(byAlias.orphan).toMatchObject({ routeConfigured: false, routeEnabled: false });
    expect(contactIsReachable(byAlias.orphan!)).toBe(false);

    // Still no probing: the join is two reads, not a network sweep.
    expect(calls.some((call) => call.includes('/probe'))).toBe(false);
  });

  it('keeps contacts and routes as separate reads with separate scopes', async () => {
    const { fetchImpl, calls } = stubFetch(ROUTES, CONTACTS);
    const client = new InterteamAdminClient({ managerUrl: 'http://127.0.0.1:4100', team: 'ops', fetchImpl });
    await client.listContactsWithReachability();
    expect(calls).toContain('GET http://127.0.0.1:4100/inter-team/config/contacts');
    expect(calls).toContain('GET http://127.0.0.1:4100/inter-team/config/peer-routes');
  });

  it('surfaces a manager error rather than rendering an empty list as success', async () => {
    const fetchImpl = (async () => ({
      ok: false, json: async () => ({ error: 'operator_context_required' }),
    }) as unknown as Response) as typeof fetch;
    const client = new InterteamAdminClient({ managerUrl: 'http://127.0.0.1:4100', team: 'ops', fetchImpl });
    await expect(client.listRoutes()).rejects.toThrow('operator_context_required');
  });
});
