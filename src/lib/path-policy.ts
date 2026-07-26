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

/**
 * The roots a spawned agent's working directory may live under.
 *
 * `baseWorkDir` and `ID_WORKSPACE_DIR` are where the manager puts agents by
 * default. `ID_ALLOWED_WORKDIR_ROOTS` (colon-separated) exists because
 * spawning an agent onto an existing project checkout is a legitimate,
 * pre-existing use — this keeps that possible without weakening the default to
 * "anywhere on disk". An operator opting a directory in is a deliberate act;
 * a request body should not be.
 */
export function spawnWorkdirRoots(baseWorkDir: string): string[] {
  const roots = [baseWorkDir];
  if (process.env.ID_WORKSPACE_DIR) roots.push(process.env.ID_WORKSPACE_DIR);
  for (const extra of (process.env.ID_ALLOWED_WORKDIR_ROOTS || '').split(':')) {
    if (extra.trim()) roots.push(extra.trim());
  }
  return roots;
}
