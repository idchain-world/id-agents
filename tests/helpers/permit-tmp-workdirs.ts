// SPDX-License-Identifier: MIT
/**
 * Permit `os.tmpdir()` as an agent working-directory root, for this file only.
 *
 * WHY THIS EXISTS (#4d78adbc). Deploy and import now resolve every declared
 * `workingDirectory` against `agentWorkdirRoots` and 400 anything outside them.
 * Fixtures build their agent directories under `os.tmpdir()`, which is outside
 * `baseWorkDir` and outside the projects root — so without this a test that
 * merely NEEDS a deployed agent starts failing on containment grounds, and the
 * failure looks like a bug in whatever that test was actually about.
 *
 * This is the same opt-in an operator uses (`ID_ALLOWED_WORKDIR_ROOTS`), not a
 * back door: the guard still runs, still resolves symlinks, and still rejects
 * anything outside the declared root.
 *
 * DELIBERATELY NOT A GLOBAL SETUP FILE. Permitting the temp root for every
 * suite at once would silently defeat the containment tests themselves, whose
 * out-of-root fixtures also live under `os.tmpdir()`. Opting in per file keeps
 * "this suite does not care about containment" a statement each file makes for
 * itself.
 */

import os from 'os';
import { afterEach, beforeEach } from 'vitest';

export function permitTmpWorkdirs(): void {
  const saved = process.env.ID_ALLOWED_WORKDIR_ROOTS;

  beforeEach(() => {
    process.env.ID_ALLOWED_WORKDIR_ROOTS = os.tmpdir();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ID_ALLOWED_WORKDIR_ROOTS;
    else process.env.ID_ALLOWED_WORKDIR_ROOTS = saved;
  });
}
