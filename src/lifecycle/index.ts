// SPDX-License-Identifier: MIT

/**
 * Manager lifecycle, shared by the TUI and the desktop app.
 *
 * This answers "is a manager running, and if not, start one": detect it, adopt
 * one that is already up, spawn one that is not, watch its health, and refuse
 * to signal a port occupant that is not verifiably ours. That refusal is the
 * subtle part and the reason this is one implementation rather than two: a
 * second copy drifts exactly there, and being approximately right is only
 * expensive when it is wrong.
 *
 * Everything here is dependency-injected and free of any UI framework, so a
 * terminal and a window can drive the same state machine. Presentation, IPC,
 * and window behaviour stay with the surface that owns them.
 */

export {
  ManagerLifecycleService,
  type LifecycleDeps,
  type EnsureResult,
  type RestartOutcome,
} from './ManagerLifecycleService.js';
export {
  HealthMonitor,
  OutageEpoch,
  type HealthPhase,
  type HealthMonitorOptions,
} from './health-monitor.js';
export { probeManagerHealth, isPortOccupied, type FetchLike } from './port-probe.js';
export { looksLikeManagerProcess, type PortOccupant } from './process-inspection.js';
export {
  DEFAULT_MANAGER_HOST,
  DEFAULT_MANAGER_PORT,
  DEFAULT_MANAGER_URL,
  resolveManagerUrl,
  isManagedLoopback,
  managerPort,
  type ManagerUrlSources,
} from './manager-paths.js';
export type { ManagerLifecyclePhase, ManagerLifecycleState } from './types.js';
