// SPDX-License-Identifier: MIT
/**
 * Item 8's presentation state, headless.
 *
 * The two rules that are load-bearing for a TUI on a laptop battery and a
 * flaky link: polling runs only while the view is focused, proven by counting
 * requests across focus changes; and a probe failure lands on the row as a
 * state, never as a thrown error, because `unreachable` is the answer the
 * operator pressed `p` to learn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterteamAdminClient } from '../../src/tui/api/interteam.js';
import {
  ContactsController,
  NodeConnectionsController,
} from '../../src/tui/views/interteam-controllers.js';

const ROUTES = [
  { nodeId: 'node-a', baseUrl: 'http://peer-a:4400', enabled: true, createdAt: 1, updatedAt: 1 },
  { nodeId: 'node-b', baseUrl: 'http://peer-b:4400', enabled: false, createdAt: 1, updatedAt: 1 },
];
const CONTACTS = [
  { id: 'c1', aliasDisplay: 'alpha', remoteNodeId: 'node-a', remoteTeamId: 'team-a' },
  { id: 'c2', aliasDisplay: 'orphan', remoteNodeId: 'node-z', remoteTeamId: 'team-z' },
];

function makeClient(overrides: {
  probe?: () => unknown;
  routes?: () => unknown;
} = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: any, init?: any) => {
    const path = String(url);
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.includes('/probe')) {
      const probe = overrides.probe
        ? overrides.probe()
        : { nodeId: 'node-a', outcome: 'reachable', baseUrl: 'http://peer-a:4400', enabled: true, diagnostic: null, probedAt: 9 };
      return { ok: true, json: async () => ({ probe }) } as unknown as Response;
    }
    if (path.endsWith('/peer-routes')) {
      const routes = overrides.routes ? overrides.routes() : ROUTES;
      return { ok: true, json: async () => ({ routes }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({ contacts: CONTACTS }) } as unknown as Response;
  }) as typeof fetch;
  const client = new InterteamAdminClient({ managerUrl: 'http://127.0.0.1:4100', team: 'ops', fetchImpl });
  return { client, calls };
}

async function flush(): Promise<void> {
  // The refresh chain is pure microtasks (the fetch stub does no I/O), but it
  // is several awaits deep; drain enough turns to reach the bottom.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('focus-gated polling', () => {
  it('does not poll before focus, polls while focused, stops on blur', async () => {
    const { client, calls } = makeClient();
    const controller = new NodeConnectionsController({ client, pollMs: 1000 });

    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(0);

    controller.setFocused(true);
    await flush();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toHaveLength(4);

    controller.setFocused(false);
    const atBlur = calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(atBlur);
  });

  it('keeps old rows visible when a refresh fails, with the failure in the header', async () => {
    let fail = false;
    const { client } = makeClient({
      routes: () => {
        if (fail) throw new Error('manager unreachable');
        return ROUTES;
      },
    });
    // The client throws through fetch rejection when routes() throws.
    const controller = new NodeConnectionsController({ client, pollMs: 1000 });
    controller.setFocused(true);
    await flush();
    expect(controller.rows).toHaveLength(2);

    fail = true;
    await vi.advanceTimersByTimeAsync(1000);
    // "Could not refresh" must not render as "there are no routes".
    expect(controller.rows).toHaveLength(2);
    expect(controller.error).toBeTruthy();

    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.error).toBeNull();
  });
});

describe('node connections controller', () => {
  it('renders unprobed status from the route alone', async () => {
    const { client } = makeClient();
    const controller = new NodeConnectionsController({ client, pollMs: 1000 });
    controller.setFocused(true);
    await flush();
    expect(controller.rows.map((row) => row.status)).toEqual(['enabled, not probed', 'disabled']);
  });

  it('probes one route on demand and keeps the result across later polls', async () => {
    const { client, calls } = makeClient();
    const controller = new NodeConnectionsController({ client, pollMs: 1000 });
    controller.setFocused(true);
    await flush();

    await controller.probe('node-a');
    expect(controller.rows[0]!.status).toBe('reachable');
    expect(calls.filter((call) => call.includes('/probe'))).toEqual([
      'POST http://127.0.0.1:4100/inter-team/config/peer-routes/node-a/probe',
    ]);

    // The poll refreshes routes but never re-probes and never clears the
    // operator's probe result.
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.rows[0]!.status).toBe('reachable');
    expect(calls.filter((call) => call.includes('/probe'))).toHaveLength(1);
  });

  it('renders a failed probe request as a state on the row, not a thrown error', async () => {
    const { client } = makeClient({ probe: () => { throw new Error('boom'); } });
    const controller = new NodeConnectionsController({ client, pollMs: 1000 });
    controller.setFocused(true);
    await flush();

    // Must not reject: the failure is the answer.
    await controller.probe('node-a');
    expect(controller.rows[0]!.status).toBe('unreachable');
    expect(controller.rows[0]!.probe?.diagnostic).toContain('boom');
    expect(controller.error).toBeNull();
  });

  it('ignores a probe for a row that is not listed', async () => {
    const { client, calls } = makeClient();
    const controller = new NodeConnectionsController({ client, pollMs: 1000 });
    controller.setFocused(true);
    await flush();
    await controller.probe('node-nope');
    expect(calls.some((call) => call.includes('/probe'))).toBe(false);
  });
});

describe('contacts controller', () => {
  it('derives the three reachability states from the join', async () => {
    const { client } = makeClient();
    const controller = new ContactsController({ client, pollMs: 1000 });
    controller.setFocused(true);
    await flush();
    expect(controller.rows.map((row) => [row.contact.aliasDisplay, row.reachability])).toEqual([
      ['alpha', 'route ok'],
      ['orphan', 'no route'],
    ]);
  });

  it('also stops polling on blur', async () => {
    const { client, calls } = makeClient();
    const controller = new ContactsController({ client, pollMs: 1000 });
    controller.setFocused(true);
    await flush();
    controller.setFocused(false);
    const atBlur = calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(atBlur);
  });
});
