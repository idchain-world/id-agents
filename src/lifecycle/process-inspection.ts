// Copyright (c) 2026 Ride Agentic Inc. All rights reserved.
/**
 * Best-effort inspection of whatever occupies the manager port, used to tell
 * "our own daemon, still coming up" apart from an ambiguous foreign occupant we
 * must not spawn over. The command runner is injected so this is testable and
 * never shells out in unit tests.
 */

export type CommandRunner = (cmd: string, args: string[]) => string | null;

export interface PortOccupant {
  pid: number;
  command: string;
}

/** True when a process command line looks like the standalone manager daemon. */
export function looksLikeManagerProcess(command: string): boolean {
  return /start-agent-manager(\.js)?\b/.test(command) || /agent-manager-db(\.js)?\b/.test(command);
}

/**
 * Resolve the process occupying `port` on loopback, or null if none/unknown.
 * Uses `lsof` for the pid and `ps` for the command line via the injected runner.
 */
export function inspectPortOccupant(port: number, run: CommandRunner): PortOccupant | null {
  const lsof = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  if (!lsof) return null;
  const pid = Number(lsof.split(/\s+/).filter(Boolean)[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const command = run('ps', ['-p', String(pid), '-o', 'command=']) ?? '';
  return { pid, command: command.trim() };
}
