// SPDX-License-Identifier: MIT
/**
 * Path containment policy — SPEC §6.1.
 *
 * `POST /agents/spawn` takes `workingDirectory` straight from the request body.
 * `validateName` covers the agent NAME only, so the directory was entirely
 * caller-controlled: a traversing or absolute path put the agent's workspace
 * — and everything written into it — anywhere on the host.
 *
 * The core analogue of the desktop `resolveWithinRoots`. It lives here rather
 * than inline in the handler so the containment rule can be tested directly,
 * and so the next caller that needs it does not write a second version.
 *
 * TWO THINGS THAT MAKE THIS MORE THAN `startsWith`:
 *
 *   1. SYMLINKS. `/allowed/link -> /etc` passes a naive prefix check and then
 *      resolves outside the root. Both the candidate and the roots are
 *      realpath'd before comparison, and the ACCEPTED value returned is the
 *      resolved one, so callers store a symlink-free path.
 *   2. PATHS THAT DO NOT EXIST YET. A spawn target is usually about to be
 *      created, so `realpathSync` would just throw. We resolve the nearest
 *      EXISTING ancestor and re-attach the remainder, which still catches a
 *      symlinked parent while allowing a not-yet-created leaf.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export type PathPolicyResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Resolve `target` as far as the filesystem allows: realpath the deepest
 * existing ancestor, then re-append the parts that do not exist yet.
 */
export function realpathNearest(target: string): string {
  let current = path.resolve(target);
  const missing: string[] = [];

  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.length ? path.join(real, ...missing.slice().reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding anything that exists.
        return path.resolve(target);
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Is `child` the same as, or inside, `root`? Both must already be resolved. */
export function isWithinRoot(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  // '' means identical; a leading '..' or an absolute result means outside.
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Accept `candidate` only if it resolves inside one of `roots`.
 *
 * Returns the RESOLVED path on success — callers should store that rather than
 * the raw input, so a symlink cannot be re-followed somewhere else later.
 */
export function resolveWithinRoots(candidate: unknown, roots: string[]): PathPolicyResult {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return { ok: false, reason: 'working directory must be a non-empty string' };
  }
  if (candidate.includes('\0')) {
    return { ok: false, reason: 'working directory contains a NUL byte' };
  }
  if (roots.length === 0) {
    return { ok: false, reason: 'no permitted roots configured' };
  }

  const resolved = realpathNearest(candidate);
  for (const root of roots) {
    if (isWithinRoot(resolved, realpathNearest(root))) {
      return { ok: true, path: resolved };
    }
  }
  return { ok: false, reason: `resolves outside every permitted root: ${resolved}` };
}

/** Env var an operator sets to permit a projects directory outside the default. */
export const PROJECTS_ROOT_ENV = 'ID_PROJECTS_ROOT';

/**
 * The conventional projects root, included ONLY when it actually exists.
 *
 * `ID_PROJECTS_ROOT` wins if set. Otherwise `<homedir>/projects` is used when
 * that directory is present — the near-universal convention for "where my
 * checkouts live", and the reason this is a rule rather than a list: it is
 * derived from `os.homedir()` at call time, so it means something different and
 * correct on every machine. NO DEVELOPER PATH IS EVER HARDCODED.
 *
 * Existence is the gate. On a fresh install with no `~/projects`, this
 * contributes nothing and the permitted set is `baseWorkDir` alone — the
 * conservative default. It cannot silently widen containment on a host where
 * the convention is not in use.
 */
export function projectsRoot(env: NodeJS.ProcessEnv = process.env, home?: string): string | null {
  const configured = env[PROJECTS_ROOT_ENV];
  if (configured && configured.trim()) return configured.trim();

  const candidate = path.join(home ?? os.homedir(), 'projects');
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null; // absent — contribute nothing
  }
}

/**
 * The roots an agent's working directory may live under.
 *
 * ONE POLICY, EVERY CALLER. Used by `POST /agents/spawn` and by the
 * deploy/import create path, deliberately: two root sets would drift, and the
 * second one to drift would be the one nobody was testing.
 *
 * Sources, in order:
 *   1. `baseWorkDir` — where the manager puts agents itself.
 *   2. `ID_WORKSPACE_DIR`.
 *   3. `ID_ALLOWED_WORKDIR_ROOTS`, colon-separated. Spawning an agent onto an
 *      existing checkout is a legitimate, pre-existing use; an operator opting
 *      a directory in is a deliberate act, a request body is not.
 *   4. The projects root above, when it exists.
 *
 * WHY 4 EXISTS. Containment without it is not a safe default, it is an outage:
 * measured against the live fleet, 34 of 38 distinct working directories fall
 * outside sources 1-3, so every real deploy and import would 400. A guard that
 * has to be switched off to get work done teaches people to switch it off.
 */
export function agentWorkdirRoots(baseWorkDir: string, home?: string): string[] {
  const roots = [baseWorkDir];
  if (process.env.ID_WORKSPACE_DIR) roots.push(process.env.ID_WORKSPACE_DIR);
  for (const extra of (process.env.ID_ALLOWED_WORKDIR_ROOTS || '').split(':')) {
    if (extra.trim()) roots.push(extra.trim());
  }
  // `home` is injectable ONLY so the fresh-install case (no ~/projects) is
  // testable without depending on whether the host running the suite has one.
  const projects = projectsRoot(process.env, home);
  if (projects) roots.push(projects);
  return roots;
}

/**
 * The old name, kept as an alias so no caller silently keeps a stale policy.
 * @deprecated use {@link agentWorkdirRoots} — the roots are no longer spawn-only.
 */
export const spawnWorkdirRoots = agentWorkdirRoots;

export interface WorkdirAuditRow {
  name: string;
  working_directory?: unknown;
  teamName?: string;
}

export interface WorkdirAuditEntry {
  agent: string;
  team: string;
  path: string;
}

/**
 * Which live agents sit OUTSIDE the permitted roots?
 *
 * THE POINT OF THIS FUNCTION IS THAT THE GUARD'S CORRECTNESS DEPENDS ON
 * CONFIGURATION. `agentWorkdirRoots` reads three env vars and a directory that
 * may not exist, so on a host where none are set the permitted set silently
 * narrows — and nobody finds out until a deploy 400s, which is the worst moment
 * to learn it. Running this at boot turns a latent misconfiguration into a
 * message, at the one time an operator can act on it before it costs anything.
 *
 * Reports only. Refusing to boot over a pre-existing path would break a running
 * fleet to enforce a rule those agents predate.
 *
 * An agent with no `working_directory` is not a finding: nothing was chosen, so
 * there is nothing to be outside the roots.
 */
export function auditWorkdirs(rows: WorkdirAuditRow[], roots: string[]): WorkdirAuditEntry[] {
  const findings: WorkdirAuditEntry[] = [];
  for (const row of rows) {
    const workdir = row.working_directory;
    if (typeof workdir !== 'string' || !workdir.trim()) continue;
    // Same containment call the guard uses, so the audit cannot disagree with it.
    if (resolveWithinRoots(workdir, roots).ok) continue;
    findings.push({ agent: row.name, team: row.teamName ?? 'unknown', path: workdir });
  }
  return findings;
}

/**
 * The boot report. Names every offending agent AND the env var to set, because
 * a warning that does not say what to do about it gets read once and ignored.
 */
export function formatWorkdirAudit(findings: WorkdirAuditEntry[], roots: string[]): string[] {
  if (findings.length === 0) return [];
  const lines = [
    `[WorkdirAudit] ${findings.length} agent(s) have a working directory outside the permitted roots.`,
    `[WorkdirAudit] Permitted: ${roots.join(', ')}`,
  ];
  for (const f of findings) {
    lines.push(`[WorkdirAudit]   ${f.team}/${f.agent}: ${f.path}`);
  }
  lines.push(
    `[WorkdirAudit] These agents keep running. New deploys, imports and spawns targeting those ` +
    `paths will be REJECTED until the root is permitted — set ${PROJECTS_ROOT_ENV} or add them to ` +
    `ID_ALLOWED_WORKDIR_ROOTS (colon-separated).`,
  );
  return lines;
}
