// SPDX-License-Identifier: MIT
/**
 * Avatar import — SPEC §5.2.3.
 *
 * Mirror `<configDir>/avatars/<team>/<agent>/avatar.<ext>` back into
 * `~/.id-agents/profiles/<newteam>/<agent>/avatar.<ext>`.
 *
 * The mirror is UNTRUSTED INPUT. A config and its avatar directory can come
 * from anywhere, and the agent names reaching this function come out of that
 * YAML — so both are attacker-influenced and every limit the writer enforces
 * has to be enforced again here. Three rules follow:
 *
 *   1. NAMES ARE VALIDATED BEFORE A PATH IS BUILT, not after. A name that fails
 *      SAFE_SEGMENT never reaches path.join, so `../../evil` cannot become a
 *      path we then try to reason about.
 *   2. BOTH ENDS ARE CONTAINED. Source and destination are each resolved and
 *      confirmed inside their own root, so a symlink planted in the mirror
 *      cannot read from, or write to, somewhere else.
 *   3. AN AVATAR NEVER FAILS THE IMPORT. Missing, oversize, wrong-type,
 *      unreadable, escaping — all skip with a warning and the team still
 *      imports. A team that will not restore because a PNG is corrupt is a
 *      worse outcome than a team with no picture.
 */

import fs from 'fs';
import path from 'path';

import { AVATAR_EXTS, MAX_AVATAR_BYTES, SAFE_SEGMENT } from './export-team-config.js';
import { isWithinRoot, realpathNearest } from './path-policy.js';

export interface ImportAvatarsResult {
  imported: string[];
  warnings: string[];
}

/**
 * @param teamName    the NEW team's name (destination side)
 * @param agentNames  agent names from the imported config — untrusted
 * @param mirrorRoot  `<configDir>/avatars`
 * @param profilesRoot`~/.id-agents/profiles`
 * @param sourceTeam  team name to read from under the mirror; defaults to teamName
 */
export function importAvatars(
  teamName: string,
  agentNames: string[],
  mirrorRoot: string,
  profilesRoot: string,
  _configPath?: string,
  sourceTeam?: string,
): ImportAvatarsResult {
  const imported: string[] = [];
  const warnings: string[] = [];

  // Validate BEFORE building any path.
  if (!SAFE_SEGMENT.test(teamName)) {
    warnings.push(`Avatar import skipped: team name "${teamName}" fails the safe-segment guard.`);
    return { imported, warnings };
  }
  const readTeam = sourceTeam ?? teamName;
  if (!SAFE_SEGMENT.test(readTeam)) {
    warnings.push(`Avatar import skipped: source team "${readTeam}" fails the safe-segment guard.`);
    return { imported, warnings };
  }
  if (!fs.existsSync(mirrorRoot)) return { imported, warnings }; // nothing to import

  for (const agentName of agentNames) {
    if (!SAFE_SEGMENT.test(agentName)) {
      warnings.push(`Avatar skipped for "${agentName}": name fails the safe-segment guard.`);
      continue;
    }

    for (const ext of AVATAR_EXTS) {
      const source = path.join(mirrorRoot, readTeam, agentName, `avatar.${ext}`);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(source);
      } catch {
        continue; // no avatar with this extension — not a problem
      }
      if (!stat.isFile()) continue;

      // Containment on the SOURCE: a symlink inside the mirror must not read
      // from outside it.
      if (!isWithinRoot(realpathNearest(source), realpathNearest(mirrorRoot))) {
        warnings.push(`Avatar skipped for "${agentName}": source escapes the avatar mirror.`);
        continue;
      }
      // Re-validate the size the writer was supposed to enforce.
      if (stat.size > MAX_AVATAR_BYTES) {
        warnings.push(
          `Avatar skipped for "${agentName}": ${stat.size} bytes exceeds the ${MAX_AVATAR_BYTES}-byte limit.`,
        );
        continue;
      }

      const destDir = path.join(profilesRoot, teamName, agentName);
      const dest = path.join(destDir, `avatar.${ext}`);
      // Containment on the DESTINATION: never write outside PROFILES_ROOT.
      if (!isWithinRoot(realpathNearest(dest), realpathNearest(profilesRoot))) {
        warnings.push(`Avatar skipped for "${agentName}": destination escapes the profiles root.`);
        continue;
      }

      try {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(source, dest); // an existing avatar is overwritten
        imported.push(dest);
      } catch (err: unknown) {
        warnings.push(`Avatar skipped for "${agentName}": ${(err as Error)?.message || String(err)}`);
      }
    }
  }

  return { imported, warnings };
}
