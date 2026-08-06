// SPDX-License-Identifier: MIT
/**
 * /contacts, /connections and /connect are navigation commands: the same local
 * category as /help, /configs and /output. They open a TUI view, they never
 * talk to the manager, and they cannot fail with a manager error, so they are
 * deliberately NOT routed through runRemoteCommand. The proof here is a fetch
 * spy: running them performs zero network calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownCommandNames, lookupCommand } from '../../src/tui/commands/registry.js';

const NAVIGATION = [
  ['contacts', 'contacts'],
  ['connections', 'connections'],
  ['connect', 'connect'],
] as const;

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => { throw new Error('navigation command touched the network'); });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe('inter-team navigation commands', () => {
  it('exist in the catalog, tier safe, so the help view lists them', () => {
    for (const [name] of NAVIGATION) {
      const spec = lookupCommand(name);
      expect(spec, name).not.toBeNull();
      expect(spec?.tier, name).toBe('safe');
      // The description points at the quick key, so either entry teaches the other.
      expect(spec?.description, name).toMatch(/also: [oxe]\)/);
      expect(knownCommandNames()).toContain(name);
    }
  });

  it('return their tuiAction marker and never dial the manager', async () => {
    for (const [name, action] of NAVIGATION) {
      const spec = lookupCommand(name)!;
      const result = await spec.run({
        manager: 'http://127.0.0.1:1',
        executor: 'tui',
        signal: new AbortController().signal,
        args: [],
        teamName: 'ops',
      });
      expect(result, name).toEqual({ tuiAction: action });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a remote command by contrast does dial, which is what separates the categories', async () => {
    const spec = lookupCommand('teams')!;
    await spec.run({
      manager: 'http://127.0.0.1:1',
      executor: 'tui',
      signal: new AbortController().signal,
      args: [],
      teamName: 'ops',
    }).catch(() => {});
    expect(fetchSpy).toHaveBeenCalled();
  });
});
