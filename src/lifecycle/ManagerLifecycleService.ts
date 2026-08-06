// Copyright (c) 2026 Ride Agentic Inc. All rights reserved.
/**
 * Serializes "ensure the manager is up" for the Electron main process.
 *
 * Order of operations (all deps injected for testing):
 *   1. Probe health — if the daemon answers, ADOPT it (never spawn).
 *   2. Monitor-only URLs (non-loopback / non-:4100) stop here.
 *   3. Re-probe health right before deciding, so a daemon that appeared during
 *      a race is adopted instead of double-spawned.
 *   4. If the port is occupied but unhealthy: adopt if it looks like our own
 *      daemon still coming up, otherwise REFUSE (ambiguous occupant).
 *   5. Only a free port triggers a detached spawn, then readiness backoff.
 *
 * `ensure()` shares a single in-flight promise, so concurrent callers produce
 * exactly one spawn. App quit deliberately leaves any spawned daemon alive.
 */

import type { ManagerLifecyclePhase, ManagerLifecycleState } from './types.js';
import { looksLikeManagerProcess, type PortOccupant } from './process-inspection.js';

export interface LifecycleDeps {
  managerUrl: string;
  managed: boolean;
  probeHealth: () => Promise<boolean>;
  isPortOccupied: () => Promise<boolean>;
  inspectOccupant?: () => PortOccupant | null;
  spawnManager: () => void;
  /** Signal a VERIFIED-local manager. Returns true if the signal was sent. */
  killManager?: (signal: 'SIGTERM' | 'SIGKILL') => boolean;
  /** Confirm the current :4100 occupant is our loopback manager before killing. */
  verifyLocalManager?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  readiness?: { attempts: number; intervalMs: number };
  gracefulExitMs?: number;
  onStateChange?: (state: ManagerLifecycleState) => void;
}

export type EnsureResult =
  | { ok: true; adopted: boolean }
  | { ok: false; reason: 'ambiguous-port' | 'spawn-timeout' | 'remote-not-managed' };

export type RestartOutcome =
  | { ok: true }
  | { ok: false; reason: 'remote-not-managed' | 'ambiguous-port' | 'spawn-timeout' };

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ManagerLifecycleService {
  private state: ManagerLifecycleState;
  private inflight: Promise<EnsureResult> | null = null;
  private restartInflight: Promise<RestartOutcome> | null = null;

  constructor(private readonly deps: LifecycleDeps) {
    this.state = {
      phase: 'unknown',
      managerUrl: deps.managerUrl,
      managed: deps.managed,
      adopted: false,
      lastError: null,
      lastSuccessMs: null,
    };
  }

  getState(): ManagerLifecycleState {
    return this.state;
  }

  /** Called by the health monitor to surface phase + last-success to the UI. */
  reportHealth(phase: ManagerLifecycleState['phase'], lastSuccessMs: number | null): void {
    // Never override an in-progress restart with a monitor phase.
    if (this.state.phase === 'restarting') return;
    this.setPhase(phase, lastSuccessMs != null ? { lastSuccessMs } : {});
  }

  /**
   * User-/recovery-initiated restart of a VERIFIED local manager: graceful
   * SIGTERM, bounded SIGKILL fallback if it lingers, detached respawn, then
   * readiness. Serialized — concurrent callers share one restart. Refuses when
   * the URL is monitor-only or the occupant is not our verified manager, so a
   * foreign/adopted-unverified process is never killed.
   */
  restart(): Promise<RestartOutcome> {
    if (this.restartInflight) return this.restartInflight;
    this.restartInflight = this.doRestart().finally(() => {
      this.restartInflight = null;
    });
    return this.restartInflight;
  }

  private async doRestart(): Promise<RestartOutcome> {
    if (!this.deps.managed) {
      this.setPhase('down', { lastError: 'restart refused: monitor-only URL' });
      return { ok: false, reason: 'remote-not-managed' };
    }
    if (this.deps.verifyLocalManager && !this.deps.verifyLocalManager()) {
      this.setPhase('down', { lastError: 'restart refused: :4100 occupant is not our verified manager' });
      return { ok: false, reason: 'ambiguous-port' };
    }

    this.setPhase('restarting', { lastError: null });
    const sleep = this.deps.sleep ?? defaultSleep;

    this.deps.killManager?.('SIGTERM');
    await sleep(this.deps.gracefulExitMs ?? 3000);
    // Still answering after the grace window → force it, then wait for the port.
    if (await this.deps.probeHealth()) {
      this.deps.killManager?.('SIGKILL');
      await sleep(500);
    }

    this.deps.spawnManager();
    if (await this.waitForReady()) {
      this.setPhase('up', { adopted: false });
      return { ok: true };
    }
    this.setPhase('down', { lastError: 'manager did not become healthy after restart' });
    return { ok: false, reason: 'spawn-timeout' };
  }

  /**
   * Tear down our VERIFIED local manager WITHOUT respawning. Used when the app
   * is quitting to install an update: freeing :4100 lets the newly-installed
   * version spawn a fresh manager from its own bundle. Without this the new app
   * adopts the old, stale daemon still squatting the port and the UI hangs on
   * "connecting" (and would run new app code against an old manager). No-op for
   * a monitor-only URL or a foreign/unverified occupant. Synchronous + best
   * effort so it can run inside a non-awaitable quit path; SIGTERM lets the
   * manager close its HTTP server and release the port cleanly.
   */
  shutdownManager(): boolean {
    if (!this.deps.managed) return false;
    if (this.deps.verifyLocalManager && !this.deps.verifyLocalManager()) return false;
    const sent = this.deps.killManager?.('SIGTERM') ?? false;
    if (sent) this.setPhase('down', { lastError: null });
    return sent;
  }

  /** Idempotent while in flight: concurrent callers share one ensure → one spawn. */
  ensure(): Promise<EnsureResult> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private setPhase(phase: ManagerLifecyclePhase, patch: Partial<ManagerLifecycleState> = {}): void {
    this.state = { ...this.state, phase, ...patch };
    this.deps.onStateChange?.(this.state);
  }

  private async run(): Promise<EnsureResult> {
    this.setPhase('starting', { lastError: null });

    if (await this.deps.probeHealth()) {
      this.setPhase('up', { adopted: true });
      return { ok: true, adopted: true };
    }

    if (!this.deps.managed) {
      this.setPhase('down', { lastError: 'manager unreachable (monitor-only URL — not auto-managed)' });
      return { ok: false, reason: 'remote-not-managed' };
    }

    // Re-probe immediately before deciding: adopt a daemon that appeared mid-race.
    if (await this.deps.probeHealth()) {
      this.setPhase('up', { adopted: true });
      return { ok: true, adopted: true };
    }

    if (await this.deps.isPortOccupied()) {
      const occupant = this.deps.inspectOccupant?.() ?? null;
      if (!occupant || !looksLikeManagerProcess(occupant.command)) {
        this.setPhase('down', {
          lastError: `manager port occupied by an unrecognized process${
            occupant ? ` (pid ${occupant.pid})` : ''
          } — refusing to spawn`,
        });
        return { ok: false, reason: 'ambiguous-port' };
      }
      // Our own daemon appears to be starting — wait for it rather than spawn again.
      if (await this.waitForReady()) {
        this.setPhase('up', { adopted: true });
        return { ok: true, adopted: true };
      }
      this.setPhase('down', { lastError: 'existing manager did not become healthy' });
      return { ok: false, reason: 'spawn-timeout' };
    }

    // Free port → spawn a detached daemon and wait for readiness.
    this.deps.spawnManager();
    if (await this.waitForReady()) {
      this.setPhase('up', { adopted: false });
      return { ok: true, adopted: false };
    }
    this.setPhase('down', { lastError: 'manager did not become healthy after spawn' });
    return { ok: false, reason: 'spawn-timeout' };
  }

  private async waitForReady(): Promise<boolean> {
    const { attempts, intervalMs } = this.deps.readiness ?? { attempts: 20, intervalMs: 250 };
    const sleep = this.deps.sleep ?? defaultSleep;
    for (let i = 0; i < attempts; i++) {
      if (await this.deps.probeHealth()) return true;
      await sleep(intervalMs);
    }
    return this.deps.probeHealth();
  }
}
