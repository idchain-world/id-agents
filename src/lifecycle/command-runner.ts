// Copyright (c) 2026 Ride Agentic Inc. All rights reserved.
/**
 * Bounded synchronous command runner for port inspection. `execFileSync` holds
 * the main-thread event loop while it runs, so a hung child (`lsof` on a dead
 * network mount or a pathological FD table) would freeze startup in a way no
 * async defense can catch — even the first-paint reveal cannot fire while the
 * loop is held. The timeout kills the child and the runner returns null, which
 * the lifecycle treats as "occupant unknown" and REFUSES to spawn over — the
 * same safe path as any other inspection failure, never "port free".
 */

import { execFileSync } from 'node:child_process';
import type { CommandRunner } from './process-inspection.js';

/** Generous bound — `lsof`/`ps` normally answer in milliseconds. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 3_000;

export function createBoundedCommandRunner(opts: { timeoutMs?: number } = {}): CommandRunner {
  const timeout = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return (cmd, args) => {
    try {
      return execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout,
      }).trim();
    } catch (err) {
      // Same null for every failure (the lifecycle decision is identical), but
      // a killed-by-timeout child gets its own log line so a hang is
      // diagnosable and not mistaken for a plain non-zero exit.
      if (err instanceof Error && (err as { killed?: boolean }).killed === true) {
        console.warn(`[lifecycle] ${cmd} inspection timed out after ${timeout}ms; child killed`);
      }
      return null;
    }
  };
}
