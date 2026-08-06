// SPDX-License-Identifier: MIT
/**
 * Integration tests for ManagerLifecycleService with injected probes/spawn:
 * adoption, exactly-one spawn under concurrent ensure, appear-during-race
 * adoption, ambiguous-port refusal, adopting our own starting daemon, readiness
 * gating / spawn timeout, and monitor-only URLs.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ManagerLifecycleService,
  type LifecycleDeps,
} from '../../src/lifecycle/index.js';

function service(overrides: Partial<LifecycleDeps>) {
  const spawnManager = vi.fn();
  const deps: LifecycleDeps = {
    managerUrl: 'http://127.0.0.1:4100',
    managed: true,
    probeHealth: async () => false,
    isPortOccupied: async () => false,
    spawnManager,
    sleep: async () => {},
    readiness: { attempts: 3, intervalMs: 0 },
    ...overrides,
  };
  return { svc: new ManagerLifecycleService(deps), spawnManager };
}

describe('ManagerLifecycleService.ensure', () => {
  it('adopts a healthy daemon without spawning', async () => {
    const { svc, spawnManager } = service({ probeHealth: async () => true });
    const result = await svc.ensure();
    expect(result).toEqual({ ok: true, adopted: true });
    expect(spawnManager).not.toHaveBeenCalled();
    expect(svc.getState().phase).toBe('up');
  });

  it('spawns exactly once under concurrent ensure', async () => {
    let spawned = false;
    const spawnManager = vi.fn(() => {
      spawned = true;
    });
    const svc = new ManagerLifecycleService({
      managerUrl: 'http://127.0.0.1:4100',
      managed: true,
      probeHealth: async () => spawned, // unhealthy until spawned, then ready
      isPortOccupied: async () => false,
      spawnManager,
      sleep: async () => {},
      readiness: { attempts: 3, intervalMs: 0 },
    });

    const [a, b] = await Promise.all([svc.ensure(), svc.ensure()]);
    expect(a).toEqual({ ok: true, adopted: false });
    expect(b).toEqual({ ok: true, adopted: false });
    expect(spawnManager).toHaveBeenCalledTimes(1);
  });

  it('adopts a daemon that appears during the race (re-probe before spawn)', async () => {
    let calls = 0;
    const { svc, spawnManager } = service({
      probeHealth: async () => {
        calls += 1;
        return calls >= 2; // first probe down, second (pre-spawn re-probe) up
      },
    });
    const result = await svc.ensure();
    expect(result).toEqual({ ok: true, adopted: true });
    expect(spawnManager).not.toHaveBeenCalled();
  });

  it('refuses an ambiguous foreign port occupant', async () => {
    const { svc, spawnManager } = service({
      probeHealth: async () => false,
      isPortOccupied: async () => true,
      inspectOccupant: () => ({ pid: 999, command: '/usr/bin/some-other-server' }),
    });
    const result = await svc.ensure();
    expect(result).toEqual({ ok: false, reason: 'ambiguous-port' });
    expect(spawnManager).not.toHaveBeenCalled();
    expect(svc.getState().phase).toBe('down');
  });

  it('adopts our own daemon still coming up on an occupied port (no spawn)', async () => {
    let calls = 0;
    const { svc, spawnManager } = service({
      probeHealth: async () => {
        calls += 1;
        return calls >= 3; // down for adoption + re-probe, up during readiness
      },
      isPortOccupied: async () => true,
      inspectOccupant: () => ({ pid: 4242, command: 'node dist/start-agent-manager.js' }),
    });
    const result = await svc.ensure();
    expect(result).toEqual({ ok: true, adopted: true });
    expect(spawnManager).not.toHaveBeenCalled();
  });

  it('reports spawn-timeout when the daemon never becomes healthy', async () => {
    const { svc, spawnManager } = service({
      probeHealth: async () => false,
      isPortOccupied: async () => false,
      readiness: { attempts: 2, intervalMs: 0 },
    });
    const result = await svc.ensure();
    expect(result).toEqual({ ok: false, reason: 'spawn-timeout' });
    expect(spawnManager).toHaveBeenCalledTimes(1);
  });

  it('does not manage a monitor-only (non-loopback) URL', async () => {
    const { svc, spawnManager } = service({
      managerUrl: 'https://idbot.live',
      managed: false,
      probeHealth: async () => false,
    });
    const result = await svc.ensure();
    expect(result).toEqual({ ok: false, reason: 'remote-not-managed' });
    expect(spawnManager).not.toHaveBeenCalled();
  });

  it('emits starting → up transitions to the state listener', async () => {
    const phases: string[] = [];
    const { svc } = service({
      probeHealth: async () => true,
      onStateChange: (s) => phases.push(s.phase),
    });
    await svc.ensure();
    expect(phases).toEqual(['starting', 'up']);
  });
});
