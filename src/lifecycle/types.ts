// SPDX-License-Identifier: MIT

/**
 * Manager lifecycle state, shared by every surface that starts or watches a
 * manager.
 *
 * These moved here from the desktop app so the TUI and the app render the same
 * phases from the same implementation. A second copy of this union would drift,
 * and it would drift in the states that matter least often and cost most when
 * wrong. The app re-exports these from its own shared module so nothing in its
 * renderer changes.
 */

/** The phases a manager can be in, as surfaced to any client. */
export type ManagerLifecyclePhase =
  | 'unknown'
  | 'starting'
  | 'up'
  | 'suspect'
  | 'down'
  | 'restarting';

export interface ManagerLifecycleState {
  phase: ManagerLifecyclePhase;
  managerUrl: string;
  /** Loopback :4100 this surface may auto-spawn/adopt; false = monitor-only. */
  managed: boolean;
  /** True when an already-running daemon was reused rather than spawned. */
  adopted: boolean;
  lastError: string | null;
  /** Epoch-ms of the last successful health probe, or null. */
  lastSuccessMs: number | null;
}
