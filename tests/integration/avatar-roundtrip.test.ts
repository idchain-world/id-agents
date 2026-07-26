// SPDX-License-Identifier: MIT
/**
 * Avatar round-trip, end-to-end — SPEC §5.2.1 / §5.2.2 / §5.2.3, acceptance 6a/6b.
 *
 * Written by cto during the §10 acceptance sweep. Both halves were already
 * tested in isolation — export writes the mirror (export-team-config.test.ts),
 * import reads one (import-team-config.test.ts) — but nothing had ever driven a
 * single avatar through BOTH. That is precisely the seam where the export and
 * import sides can disagree about a path and each still pass its own suite: the
 * same class of defect as the four silent-loss bugs this build already found
 * (org, D9, D10, the DMZ posture), where each side was individually correct.
 *
 * The assertion that matters is §5.2.1's: a round-trip changes ONLY the root
 * segment. Export maps PROFILES_ROOT -> <configDir>/avatars; import maps it
 * back, under the NEW team name.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { exportAvatars, MAX_AVATAR_BYTES } from '../../src/lib/export-team-config.js';
import { importAvatars } from '../../src/lib/import-avatars.js';

const SRC_TEAM = 'avatar-src';
const NEW_TEAM = 'avatar-restored';

let profilesRoot = '';
let mirrorRoot = '';
let importedProfilesRoot = '';

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-rt-'));
  profilesRoot = path.join(base, 'profiles');
  mirrorRoot = path.join(base, 'configs', 'avatars');
  importedProfilesRoot = path.join(base, 'profiles-imported');
  fs.mkdirSync(profilesRoot, { recursive: true });
});

afterEach(() => {
  for (const dir of [profilesRoot, mirrorRoot, importedProfilesRoot]) {
    try { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function plantAvatar(team: string, agent: string, ext = 'png', bytes = 64): string {
  const dir = path.join(profilesRoot, team, agent);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `avatar.${ext}`);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

describe('avatar round-trip: export -> import (acceptance 6a/6b)', () => {
  it('lands the file under the NEW team, byte-identical, changing only the root', () => {
    const original = plantAvatar(SRC_TEAM, 'alpha');
    const originalBytes = fs.readFileSync(original);

    const exported = exportAvatars(SRC_TEAM, ['alpha'], profilesRoot, mirrorRoot);
    expect(exported.warnings).toEqual([]);

    // The mirror keeps the <team>/<agent>/avatar.<ext> nesting (§5.2.1).
    const mirrored = path.join(mirrorRoot, SRC_TEAM, 'alpha', 'avatar.png');
    expect(fs.existsSync(mirrored)).toBe(true);

    // Import under a DIFFERENT team name — a rename is the normal import case.
    const result = importAvatars(NEW_TEAM, ['alpha'], mirrorRoot, importedProfilesRoot, undefined, SRC_TEAM);
    expect(result.warnings).toEqual([]);

    const restored = path.join(importedProfilesRoot, NEW_TEAM, 'alpha', 'avatar.png');
    expect(fs.existsSync(restored)).toBe(true);
    expect(fs.readFileSync(restored).equals(originalBytes)).toBe(true);

    // §5.2.1: only the root segment differs. Strip each root and the tails must
    // match except for the team name.
    const originalTail = path.relative(path.join(profilesRoot, SRC_TEAM), original);
    const restoredTail = path.relative(path.join(importedProfilesRoot, NEW_TEAM), restored);
    expect(restoredTail).toBe(originalTail);
  });

  it('preserves a non-png extension across the whole journey', () => {
    plantAvatar(SRC_TEAM, 'beta', 'webp');
    exportAvatars(SRC_TEAM, ['beta'], profilesRoot, mirrorRoot);
    const result = importAvatars(NEW_TEAM, ['beta'], mirrorRoot, importedProfilesRoot, undefined, SRC_TEAM);
    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(path.join(importedProfilesRoot, NEW_TEAM, 'beta', 'avatar.webp'))).toBe(true);
  });

  it('a team with no avatars round-trips to nothing, silently', () => {
    const exported = exportAvatars(SRC_TEAM, ['ghost'], profilesRoot, mirrorRoot);
    expect(exported.warnings).toEqual([]);
    expect(fs.existsSync(mirrorRoot)).toBe(false);

    const result = importAvatars(NEW_TEAM, ['ghost'], mirrorRoot, importedProfilesRoot, undefined, SRC_TEAM);
    expect(result.warnings).toEqual([]);
    expect(result.imported).toEqual([]);
  });

  it('does not carry .DS_Store through the round-trip', () => {
    plantAvatar(SRC_TEAM, 'alpha');
    fs.writeFileSync(path.join(profilesRoot, SRC_TEAM, 'alpha', '.DS_Store'), 'junk');

    exportAvatars(SRC_TEAM, ['alpha'], profilesRoot, mirrorRoot);
    expect(fs.existsSync(path.join(mirrorRoot, SRC_TEAM, 'alpha', '.DS_Store'))).toBe(false);

    importAvatars(NEW_TEAM, ['alpha'], mirrorRoot, importedProfilesRoot, undefined, SRC_TEAM);
    expect(fs.existsSync(path.join(importedProfilesRoot, NEW_TEAM, 'alpha', '.DS_Store'))).toBe(false);
  });

  it('an oversize avatar is dropped at export and never reaches the restored team', () => {
    plantAvatar(SRC_TEAM, 'alpha', 'png', MAX_AVATAR_BYTES + 1);

    const exported = exportAvatars(SRC_TEAM, ['alpha'], profilesRoot, mirrorRoot);
    expect(exported.warnings.join(' ')).toContain('alpha');
    expect(fs.existsSync(path.join(mirrorRoot, SRC_TEAM, 'alpha', 'avatar.png'))).toBe(false);

    const result = importAvatars(NEW_TEAM, ['alpha'], mirrorRoot, importedProfilesRoot, undefined, SRC_TEAM);
    expect(fs.existsSync(path.join(importedProfilesRoot, NEW_TEAM, 'alpha', 'avatar.png'))).toBe(false);
    expect(result.imported).toEqual([]);
  });
});
