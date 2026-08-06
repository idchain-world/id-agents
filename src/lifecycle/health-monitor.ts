// Copyright (c) 2026 Ride Agentic Inc. All rights reserved.
/**
 * Polls manager health and debounces transient blips into a stable phase. A
 * SINGLE failure is only `suspect` (never a restart or prompt); it takes
 * `downThreshold` consecutive failures to declare a sustained `down` outage. A
 * success immediately returns to `up`. The `OutageEpoch` guarantees at most one
 * user prompt per sustained-down episode and resets on recovery.
 */

export type HealthPhase = 'up' | 'suspect' | 'down';

export interface HealthMonitorOptions {
  probe: () => Promise<boolean>;
  intervalMs: number;
  downThreshold?: number; // consecutive failures before "down" (default 3)
  onChange: (phase: HealthPhase, info: { consecutiveFailures: number; lastSuccessMs: number | null }) => void;
  now?: () => number;
}

export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private phase: HealthPhase = 'up';
  private consecutiveFailures = 0;
  private lastSuccessMs: number | null = null;
  private readonly downThreshold: number;
  private readonly now: () => number;

  constructor(private readonly opts: HealthMonitorOptions) {
    this.downThreshold = opts.downThreshold ?? 3;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One probe cycle — exposed for deterministic tests. */
  async tick(): Promise<HealthPhase> {
    const healthy = await this.opts.probe();
    if (healthy) {
      this.consecutiveFailures = 0;
      this.lastSuccessMs = this.now();
      this.transition('up');
    } else {
      this.consecutiveFailures += 1;
      this.transition(this.consecutiveFailures >= this.downThreshold ? 'down' : 'suspect');
    }
    return this.phase;
  }

  getPhase(): HealthPhase {
    return this.phase;
  }

  private transition(next: HealthPhase): void {
    if (next === this.phase && next !== 'suspect') return; // suspect may re-emit as failures climb
    this.phase = next;
    this.opts.onChange(next, {
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessMs: this.lastSuccessMs,
    });
  }
}

/**
 * At-most-one prompt per sustained-down episode. "Not now" suppresses further
 * prompts until the manager recovers (a new episode).
 */
export class OutageEpoch {
  private prompted = false;

  /** Returns true exactly once when a sustained-down episode begins. */
  onPhase(phase: HealthPhase): boolean {
    if (phase === 'up') {
      this.prompted = false; // recovery → new episode
      return false;
    }
    if (phase === 'down' && !this.prompted) {
      this.prompted = true;
      return true;
    }
    return false;
  }

  /** User chose "Not now" — suppress until recovery. */
  suppress(): void {
    this.prompted = true;
  }
}
