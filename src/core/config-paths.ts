// SPDX-License-Identifier: MIT
/**
 * Config path resolution for `/sync` and `/deploy`.
 *
 * Both commands used to resolve a relative config path against
 * `process.cwd()` alone. That holds only while the manager is spawned from a
 * checkout: when the desktop app owns the daemon its cwd is its own
 * Application Support directory, so a bare `configs/<team>.yaml` never
 * resolved and both commands failed with "Config file not found" even though
 * the file existed in the user's repo.
 *
 * Resolution order:
 *   1. `ID_AGENTS_CONFIG_ROOT` — opt-in override, so setting it is the
 *      documented escape hatch and no existing setup changes behaviour.
 *   2. `process.cwd()` — repo-spawned managers resolve exactly as before.
 *   3. the manager's base work dir.
 *   4. `~/.id-agents` — the same user-level data dir that holds the database.
 *
 * The later roots only ever rescue a lookup that would otherwise have failed.
 */

import os from 'os';
import path from 'path';
import { existsSync } from 'fs';

export interface ConfigLookup {
  /** Absolute path to the config, or null when nothing matched. */
  resolved: string | null;
  /** Every candidate tried, in order, so callers can report where they looked. */
  searched: string[];
}

export interface ResolveConfigPathOptions {
  /** The manager's base work dir, tried after cwd. */
  baseWorkDir?: string;
  /** Overrides for injection in tests. Defaults to the real environment. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homedir?: string;
  /** Existence predicate; injectable so tests need no fixture files. */
  exists?: (p: string) => boolean;
}

export function resolveConfigPath(
  filePath: string,
  options: ResolveConfigPathOptions = {},
): ConfigLookup {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.homedir ?? os.homedir();
  const exists = options.exists ?? existsSync;

  // An absolute path is a direct instruction — never search around it.
  if (path.isAbsolute(filePath)) {
    return { resolved: exists(filePath) ? filePath : null, searched: [filePath] };
  }

  const roots = [
    env.ID_AGENTS_CONFIG_ROOT,
    cwd,
    options.baseWorkDir,
    path.join(home, '.id-agents'),
  ].filter((r): r is string => typeof r === 'string' && r.length > 0);

  const searched: string[] = [];
  for (const root of roots) {
    const candidate = path.resolve(root, filePath);
    if (searched.includes(candidate)) continue;
    searched.push(candidate);
    if (exists(candidate)) return { resolved: candidate, searched };
  }
  return { resolved: null, searched };
}

/** Error text for a config lookup that missed, naming every path tried. */
export function configNotFoundError(filePath: string, searched: string[]): string {
  return [
    `Config file not found: ${filePath}`,
    `Looked in:`,
    ...searched.map((p) => `  ${p}`),
    `Pass an absolute path, or set ID_AGENTS_CONFIG_ROOT to the directory containing configs/.`,
  ].join('\n');
}
