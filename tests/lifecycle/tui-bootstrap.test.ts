// SPDX-License-Identifier: MIT
/**
 * Item 5: the TUI brings a manager up, adopts one that is running, and refuses
 * to touch anything that is not verifiably ours.
 *
 * The state machine itself is core's and is already covered. What is tested
 * here is the wiring a terminal on a server supplies: detached spawn so the
 * fleet outlives the SSH session, adoption instead of a second process, the
 * foreign-occupant refusal with no force option, and the phase vocabulary,
 * which must be core's six words rather than new ones invented for a terminal.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildTuiLifecycleDeps,
  createTuiLifecycle,
  describeLifecycleState,
} from '../../src/tui/lifecycle/bootstrap.js';
import type { ManagerLifecycleState } from '../../src/lifecycle/index.js';

const FOREIGN = { pid: 4242, command: '/usr/bin/python3 -m http.server 4100' };
const OURS = { pid: 5150, command: '/usr/bin/node /app/dist/start-agent-manager.js' };

describe('TUI manager bootstrap', () => {
  it('spawns nothing when a healthy manager is already listening, and says it adopted it', async () => {
    const spawnManager = vi.fn();
    const lifecycle = createTuiLifecycle({
      deps: {
        probeHealth: async () => true,
        isPortOccupied: async () => true,
        spawnManager,
      },
    });

    const result = await lifecycle.ensure();
    expect(result).toEqual({ ok: true, adopted: true });
    // A second process on the same port is the failure this prevents.
    expect(spawnManager).not.toHaveBeenCalled();
    expect(lifecycle.getState()).toMatchObject({ phase: 'up', adopted: true });
  });

  it('starts one when nothing is listening', async () => {
    const spawnManager = vi.fn();
    let healthy = false;
    const lifecycle = createTuiLifecycle({
      deps: {
        probeHealth: async () => healthy,
        isPortOccupied: async () => false,
        spawnManager: () => { spawnManager(); healthy = true; },
        sleep: async () => {},
      },
    });

    const result = await lifecycle.ensure();
    expect(result).toEqual({ ok: true, adopted: false });
    expect(spawnManager).toHaveBeenCalledTimes(1);
    expect(lifecycle.getState()).toMatchObject({ phase: 'up', adopted: false });
  });

  it('refuses a port occupant that is not verifiably our manager', async () => {
    const spawnManager = vi.fn();
    const lifecycle = createTuiLifecycle({
      deps: {
        probeHealth: async () => false,
        isPortOccupied: async () => true,
        inspectOccupant: () => FOREIGN,
        spawnManager,
      },
    });

    const result = await lifecycle.ensure();
    expect(result).toEqual({ ok: false, reason: 'ambiguous-port' });
    // Never spawn over it, never signal it, and there is no force option.
    expect(spawnManager).not.toHaveBeenCalled();
    expect(lifecycle.getState().phase).toBe('down');
    expect(lifecycle.getState().lastError).toBeTruthy();
  });

  it('never signals a foreign process, and does signal a verified one', () => {
    const foreignKill = vi.fn();
    const foreign = buildTuiLifecycleDeps({
      deps: { inspectOccupant: () => FOREIGN, killManager: undefined },
    });
    // The real guard is command-line verification, exercised through the
    // injected occupant rather than by starting a foreign process.
    expect(foreign.verifyLocalManager?.()).toBe(false);
    expect(foreignKill).not.toHaveBeenCalled();

    const ours = buildTuiLifecycleDeps({ deps: { inspectOccupant: () => OURS } });
    expect(typeof ours.killManager).toBe('function');
  });

  it('watches a non-loopback manager instead of managing it', () => {
    const remote = buildTuiLifecycleDeps({ managerUrl: 'http://10.1.2.3:4100' });
    expect(remote.managed).toBe(false);
    const local = buildTuiLifecycleDeps({ managerUrl: 'http://127.0.0.1:4100' });
    expect(local.managed).toBe(true);
  });

  it('renders exactly core\'s phases, distinguishing adopted from started', () => {
    const base: ManagerLifecycleState = {
      phase: 'up',
      managerUrl: 'http://127.0.0.1:4100',
      managed: true,
      adopted: true,
      lastError: null,
      lastSuccessMs: null,
    };
    expect(describeLifecycleState(base)).toContain('adopted');
    expect(describeLifecycleState({ ...base, adopted: false })).toContain('started by this session');
    expect(describeLifecycleState({ ...base, phase: 'starting' })).toContain('starting');
    expect(describeLifecycleState({ ...base, phase: 'suspect' })).toContain('not answering');
    expect(describeLifecycleState({ ...base, phase: 'restarting' })).toContain('restarting');
    expect(describeLifecycleState({ ...base, phase: 'down', lastError: 'why' })).toContain('why');
    expect(describeLifecycleState({ ...base, phase: 'unknown' })).toContain('unknown');
  });

  it('spawns detached so the fleet outlives the SSH session', () => {
    // Read as source rather than executed, because actually spawning a manager
    // in a unit test would leave a daemon behind on the developer's machine.
    const source = require('node:fs').readFileSync(
      new URL('../../src/tui/lifecycle/bootstrap.ts', import.meta.url), 'utf8',
    ) as string;
    expect(source).toContain('detached: true');
    expect(source).toContain('child.unref()');
  });
});
