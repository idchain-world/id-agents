// SPDX-License-Identifier: MIT

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ManagerLifecycleService,
  createBoundedCommandRunner,
  inspectPortOccupant,
  isPortOccupied,
  looksLikeManagerProcess,
  managerPort,
  probeManagerHealth,
  resolveManagerUrl,
  isManagedLoopback,
  type LifecycleDeps,
  type ManagerLifecycleState,
} from '../../lifecycle/index.js';

/**
 * Item 5: the TUI brings a manager up instead of requiring one.
 *
 * The state machine, the adoption rules, and the signalling guard all come from
 * core, so this file only supplies what a terminal on a server knows that an
 * Electron window does not: where Node lives, where the manager entry is, and
 * which directory is writable. Nothing here re-decides when a manager is
 * suspect or whether a port occupant may be signalled.
 *
 * Two behaviours matter on a VPS specifically. The manager is spawned detached
 * and unref'd, so closing the SSH session leaves the fleet answering. And the
 * TUI never stops it on exit: the next session adopts it, which is the same
 * adoption path the desktop app already uses.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** The compiled manager entry, resolved from this module rather than from cwd. */
export function defaultManagerEntry(): string {
  return path.resolve(here, '../../start-agent-manager.js');
}

/** A writable root under the user's home, the terminal's answer to userData. */
export function defaultStateRoot(): string {
  return path.join(os.homedir(), '.id-agents');
}

export interface TuiLifecycleOptions {
  managerUrl?: string;
  stateRoot?: string;
  managerEntry?: string;
  env?: NodeJS.ProcessEnv;
  onStateChange?: (state: ManagerLifecycleState) => void;
  /** Injected in tests so the guard can be exercised without a real process. */
  deps?: Partial<LifecycleDeps>;
}

export function buildTuiLifecycleDeps(options: TuiLifecycleOptions = {}): LifecycleDeps {
  const env = options.env ?? process.env;
  const managerUrl = options.managerUrl ?? resolveManagerUrl({ env: env as Record<string, string | undefined> });
  const port = managerPort(managerUrl);
  const stateRoot = options.stateRoot ?? defaultStateRoot();
  const managerEntry = options.managerEntry ?? defaultManagerEntry();
  const runCommand = createBoundedCommandRunner();

  // A remote or non-default URL is watched, never spawned or signalled. The
  // TUI has no business managing a manager it did not start on loopback.
  const managed = isManagedLoopback(managerUrl);

  // One source of truth for who holds the port. Inspecting it separately in
  // the verify and kill paths would let them disagree, and the one that
  // disagreed would be the one deciding whether to signal a process.
  const inspectOccupant = options.deps?.inspectOccupant
    ?? (() => inspectPortOccupant(port, runCommand));

  const verifyLocalManager = (): boolean => {
    const occupant = inspectOccupant();
    return !!occupant && looksLikeManagerProcess(occupant.command);
  };

  const base: LifecycleDeps = {
    managerUrl,
    managed,
    probeHealth: () => probeManagerHealth(managerUrl, globalThis.fetch as never, 750),
    isPortOccupied: () => isPortOccupied(port),
    inspectOccupant,
    spawnManager: () => {
      // Detached and unref'd on purpose. The operator closes the SSH session
      // and expects the fleet to keep working, so the manager must outlive the
      // terminal that started it.
      const child = spawn(process.execPath, [managerEntry], {
        cwd: stateRoot,
        detached: true,
        stdio: 'ignore',
        env: { ...env, AGENT_MANAGER_PORT: String(port) },
      });
      child.unref();
    },
    verifyLocalManager,
    killManager: (signal) => {
      // Only ever a verified local manager. A foreign occupant is never
      // touched, and there is deliberately no force option to override this.
      const occupant = inspectOccupant();
      if (!occupant || !looksLikeManagerProcess(occupant.command)) return false;
      try {
        process.kill(occupant.pid, signal);
        return true;
      } catch {
        return false;
      }
    },
    onStateChange: options.onStateChange,
  };
  return { ...base, ...options.deps };
}

export function createTuiLifecycle(options: TuiLifecycleOptions = {}): ManagerLifecycleService {
  return new ManagerLifecycleService(buildTuiLifecycleDeps(options));
}

/**
 * How a phase reads in a terminal. The words are core's six phases and the
 * adopted flag, not new ones, so an operator moving between the TUI and the
 * desktop app sees the same vocabulary for the same states.
 */
export function describeLifecycleState(state: ManagerLifecycleState): string {
  const suffix = state.lastError ? `: ${state.lastError}` : '';
  switch (state.phase) {
    case 'up':
      return state.adopted
        ? `manager up at ${state.managerUrl} (adopted, already running)`
        : `manager up at ${state.managerUrl} (started by this session)`;
    case 'starting':
      return `manager starting at ${state.managerUrl}`;
    case 'restarting':
      return `manager restarting at ${state.managerUrl}`;
    case 'suspect':
      return `manager not answering at ${state.managerUrl}, retrying${suffix}`;
    case 'down':
      return `manager down at ${state.managerUrl}${suffix}`;
    default:
      return `manager state unknown at ${state.managerUrl}${suffix}`;
  }
}
