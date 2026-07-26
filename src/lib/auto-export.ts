// SPDX-License-Identifier: MIT
/**
 * Automatic export on team mutation — SPEC §5.4.
 *
 * This is the build's data-safety hinge. Once `/deploy` becomes create-only
 * (commit 4) the database is the only complete record of a team, so every
 * composition change has to leave behind a file that can reconstruct it.
 *
 * Three properties matter, and each is a separate design decision here:
 *
 *   1. FAILURE IS NEVER FATAL. An auto-export runs after its triggering
 *      mutation has already returned, and every run is wrapped. A broken
 *      export path must never turn a working `/spawn` into a failed one.
 *   2. DEBOUNCED. A deploy touches a team many times in a row; coalescing to
 *      one write per team per window keeps that from becoming N serializations
 *      of the same rows.
 *   3. THE PATH IS FIXED. `<baseWorkDir>/teams/<team>/<team>.autoexport.yaml`,
 *      never `teams.last_config_path` and never the §5.1 resolution. The
 *      operator's own config file is theirs; an automatic process must not
 *      overwrite it behind their back.
 */

import path from 'path';

/**
 * §5.4 path. Deliberately NOT `resolveExportPath` — that function honours
 * `last_config_path`, which is exactly what this must never touch.
 */
export function autoExportPath(baseWorkDir: string, teamName: string): string {
  return path.join(baseWorkDir, 'teams', teamName, `${teamName}.autoexport.yaml`);
}

export interface AutoExporter {
  /** Queue an export for this team, replacing any pending one. Never throws. */
  schedule(teamKey: string, run: () => void | Promise<void>): void;
  /** Number of teams with a write currently pending. */
  pending(): number;
  /** Cancel everything. Tests and shutdown call this so no timer outlives us. */
  dispose(): void;
}

export interface AutoExporterOptions {
  debounceMs?: number;
  /** Called when a run throws. Failure is logged, never propagated. */
  onError?: (error: unknown, teamKey: string) => void;
}

export const DEFAULT_AUTOEXPORT_DEBOUNCE_MS = 5000;

/**
 * Debouncing scheduler for automatic exports.
 *
 * Timers are `unref`'d where the runtime supports it, so a pending export can
 * never hold the process (or a test run) open. `dispose()` is still the
 * correct way to shut down; unref is the backstop for the case where someone
 * forgets.
 */
export function createAutoExporter(options: AutoExporterOptions = {}): AutoExporter {
  const debounceMs = options.debounceMs ?? DEFAULT_AUTOEXPORT_DEBOUNCE_MS;
  const onError = options.onError ?? (() => {});
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    schedule(teamKey: string, run: () => void | Promise<void>): void {
      const existing = timers.get(teamKey);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        timers.delete(teamKey);
        // Every path out of `run` is swallowed: sync throw, async rejection.
        // The triggering mutation has already returned by now, so there is
        // nothing left to fail — but an unhandled rejection would still take
        // the manager down, which is the same outage by another name.
        try {
          const result = run();
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((err) => onError(err, teamKey));
          }
        } catch (err) {
          onError(err, teamKey);
        }
      }, debounceMs);

      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      timers.set(teamKey, timer);
    },

    pending(): number {
      return timers.size;
    },

    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
