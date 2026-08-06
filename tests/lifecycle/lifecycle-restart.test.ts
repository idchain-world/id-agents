// SPDX-License-Identifier: MIT
/**
 * ManagerLifecycleService.restart(): verified-local graceful/forced kill +
 * respawn, refusal for unverified/monitor-only, and concurrent serialization.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ManagerLifecycleService,
  type LifecycleDeps,
} from '../../src/lifecycle/index.js';

function svc(over: Partial<LifecycleDeps>) {
  const killManager = vi.fn(() => true);
  const spawnManager = vi.fn();
  const deps: LifecycleDeps = {
    managerUrl: 'http://127.0.0.1:4100',
    managed: true,
    probeHealth: async () => false,
    isPortOccupied: async () => false,
    spawnManager,
    killManager,
    verifyLocalManager: () => true,
    sleep: async () => {},
    readiness: { attempts: 3, intervalMs: 0 },
    gracefulExitMs: 0,
    ...over,
  };
  return { service: new ManagerLifecycleService(deps), killManager, spawnManager };
}

describe('ManagerLifecycleService.shutdownManager', () => {
  it('SIGTERMs the verified local manager without respawning', () => {
    const { service, killManager, spawnManager } = svc({});
    expect(service.shutdownManager()).toBe(true);
    expect(killManager).toHaveBeenCalledWith('SIGTERM');
    expect(killManager).not.toHaveBeenCalledWith('SIGKILL');
    expect(spawnManager).not.toHaveBeenCalled(); // shutdown, not restart
  });

  it('is a no-op for a monitor-only (unmanaged) URL', () => {
    const { service, killManager } = svc({ managed: false });
    expect(service.shutdownManager()).toBe(false);
    expect(killManager).not.toHaveBeenCalled();
  });

  it('refuses to signal when the occupant is not our verified manager', () => {
    const { service, killManager } = svc({ verifyLocalManager: () => false });
    expect(service.shutdownManager()).toBe(false);
    expect(killManager).not.toHaveBeenCalled();
  });
});

describe('ManagerLifecycleService.restart', () => {
  it('gracefully SIGTERMs, respawns, and returns up (no SIGKILL when it exits)', async () => {
    let alive = true;
    const killManager = vi.fn((sig: 'SIGTERM' | 'SIGKILL') => {
      if (sig === 'SIGTERM') alive = false; // graceful exit
      return true;
    });
    const spawnManager = vi.fn(() => {
      alive = true;
    });
    const { service } = svc({
      probeHealth: async () => alive, // dead after SIGTERM, healthy again after respawn
      killManager,
      spawnManager,
    });
    const result = await service.restart();
    expect(result).toEqual({ ok: true });
    expect(killManager).toHaveBeenCalledWith('SIGTERM');
    expect(killManager).not.toHaveBeenCalledWith('SIGKILL');
    expect(spawnManager).toHaveBeenCalledTimes(1);
    expect(service.getState().phase).toBe('up');
  });

  it('escalates to SIGKILL when the manager lingers after SIGTERM', async () => {
    // Manager stays healthy through the grace window (ignored SIGTERM), and the
    // respawn is also healthy — so probeHealth is simply always true here.
    const { service, killManager } = svc({ probeHealth: async () => true });
    const result = await service.restart();
    expect(result).toEqual({ ok: true });
    expect(killManager).toHaveBeenCalledWith('SIGTERM');
    expect(killManager).toHaveBeenCalledWith('SIGKILL');
  });

  it('refuses to restart an unverified occupant (never kills a foreign process)', async () => {
    const { service, killManager, spawnManager } = svc({ verifyLocalManager: () => false });
    const result = await service.restart();
    expect(result).toEqual({ ok: false, reason: 'ambiguous-port' });
    expect(killManager).not.toHaveBeenCalled();
    expect(spawnManager).not.toHaveBeenCalled();
  });

  it('refuses to restart a monitor-only URL', async () => {
    const { service, spawnManager } = svc({ managed: false });
    const result = await service.restart();
    expect(result).toEqual({ ok: false, reason: 'remote-not-managed' });
    expect(spawnManager).not.toHaveBeenCalled();
  });

  it('serializes concurrent restarts into one', async () => {
    let ready = false;
    const spawnManager = vi.fn(() => {
      ready = true;
    });
    const { service } = svc({ probeHealth: async () => ready, spawnManager });
    const [a, b] = await Promise.all([service.restart(), service.restart()]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(spawnManager).toHaveBeenCalledTimes(1);
  });
});
