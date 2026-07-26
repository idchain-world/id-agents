// SPDX-License-Identifier: MIT
/**
 * Path containment policy — SPEC §6.1.
 *
 * The symlink cases are the point. A prefix check passes them and then the
 * path resolves somewhere else entirely, which is exactly how a "validated"
 * working directory ends up outside its root.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  agentWorkdirRoots,
  auditWorkdirs,
  formatWorkdirAudit,
  isWithinRoot,
  projectsRoot,
  realpathNearest,
  resolveWithinRoots,
  spawnWorkdirRoots,
} from '../../src/lib/path-policy.js';

let tmp = '';
let root = '';
let outside = '';

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'path-policy-')));
  root = path.join(tmp, 'root');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});
afterEach(() => { if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; } });

describe('resolveWithinRoots', () => {
  it('accepts a path inside the root', () => {
    const target = path.join(root, 'agents', 'alpha');
    const verdict = resolveWithinRoots(target, [root]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(isWithinRoot(verdict.path, root)).toBe(true);
  });

  it('accepts the root itself', () => {
    expect(resolveWithinRoots(root, [root]).ok).toBe(true);
  });

  it('rejects ../ traversal that climbs out', () => {
    const verdict = resolveWithinRoots(path.join(root, '..', 'outside'), [root]);
    expect(verdict.ok).toBe(false);
  });

  it('rejects deep traversal to a system path', () => {
    expect(resolveWithinRoots(`${root}/../../../../../../etc/passwd`, [root]).ok).toBe(false);
    expect(resolveWithinRoots('/etc/passwd', [root]).ok).toBe(false);
  });

  it('accepts traversal that stays inside after resolving', () => {
    // `a/../b` is not an escape — only the resolved result matters.
    const verdict = resolveWithinRoots(path.join(root, 'a', '..', 'b'), [root]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.path).toBe(path.join(root, 'b'));
  });

  it('rejects an absolute path outside every root', () => {
    expect(resolveWithinRoots(outside, [root]).ok).toBe(false);
  });

  it('accepts when ANY of several roots contains it', () => {
    expect(resolveWithinRoots(outside, [root, outside]).ok).toBe(true);
  });

  // --- the cases a startsWith check gets wrong -----------------------------

  it('rejects a symlink inside the root that points outside it', () => {
    const link = path.join(root, 'escape');
    fs.symlinkSync(outside, link);
    // Lexically this is "inside root" and would pass a prefix check.
    expect(link.startsWith(root)).toBe(true);
    expect(resolveWithinRoots(link, [root]).ok).toBe(false);
  });

  it('rejects a not-yet-created path underneath a symlinked parent', () => {
    // The leaf does not exist, so realpathSync alone would throw; the nearest
    // existing ancestor is the symlink, which resolves outside.
    const link = path.join(root, 'escape');
    fs.symlinkSync(outside, link);
    expect(resolveWithinRoots(path.join(link, 'not-created-yet'), [root]).ok).toBe(false);
  });

  it('accepts a not-yet-created path under a genuine directory', () => {
    const verdict = resolveWithinRoots(path.join(root, 'brand', 'new', 'leaf'), [root]);
    expect(verdict.ok).toBe(true);
  });

  it('returns a symlink-free path on success', () => {
    const real = path.join(root, 'real');
    fs.mkdirSync(real);
    const link = path.join(root, 'alias');
    fs.symlinkSync(real, link);
    const verdict = resolveWithinRoots(link, [root]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.path).toBe(real); // resolved, not the alias
  });

  it('rejects rubbish input', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}, 'has\0nul']) {
      expect(resolveWithinRoots(bad as unknown, [root]).ok).toBe(false);
    }
  });

  it('rejects everything when no roots are configured', () => {
    expect(resolveWithinRoots(root, []).ok).toBe(false);
  });
});

describe('realpathNearest', () => {
  it('resolves an existing path', () => {
    expect(realpathNearest(root)).toBe(root);
  });

  it('resolves the existing ancestor and keeps the missing tail', () => {
    expect(realpathNearest(path.join(root, 'a', 'b', 'c'))).toBe(path.join(root, 'a', 'b', 'c'));
  });
});

describe('agentWorkdirRoots', () => {
  const saved = {
    ws: process.env.ID_WORKSPACE_DIR,
    extra: process.env.ID_ALLOWED_WORKDIR_ROOTS,
    projects: process.env.ID_PROJECTS_ROOT,
  };
  beforeEach(() => {
    delete process.env.ID_WORKSPACE_DIR;
    delete process.env.ID_ALLOWED_WORKDIR_ROOTS;
    // Pinned so the suite does not depend on whether the HOST has ~/projects.
    process.env.ID_PROJECTS_ROOT = '/pinned-projects';
  });
  afterEach(() => {
    for (const [key, value] of [
      ['ID_WORKSPACE_DIR', saved.ws],
      ['ID_ALLOWED_WORKDIR_ROOTS', saved.extra],
      ['ID_PROJECTS_ROOT', saved.projects],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('always includes baseWorkDir', () => {
    expect(agentWorkdirRoots('/work')[0]).toBe('/work');
  });

  it('honours the operator opt-in roots', () => {
    process.env.ID_ALLOWED_WORKDIR_ROOTS = '/projects:/repos';
    expect(agentWorkdirRoots('/work')).toEqual(['/work', '/projects', '/repos', '/pinned-projects']);
  });

  it('includes the configured projects root', () => {
    expect(agentWorkdirRoots('/work')).toEqual(['/work', '/pinned-projects']);
  });

  it('is the SAME policy under the old spawn-only name', () => {
    // The alias exists so no caller keeps a stale, narrower root set.
    expect(spawnWorkdirRoots('/work')).toEqual(agentWorkdirRoots('/work'));
  });
});

describe('projectsRoot — a rule, never a hardcoded developer path', () => {
  const saved = process.env.ID_PROJECTS_ROOT;
  afterEach(() => {
    if (saved === undefined) delete process.env.ID_PROJECTS_ROOT; else process.env.ID_PROJECTS_ROOT = saved;
  });

  it('prefers the env var when set', () => {
    process.env.ID_PROJECTS_ROOT = '/explicit';
    expect(projectsRoot()).toBe('/explicit');
  });

  it('derives <home>/projects when it exists', () => {
    delete process.env.ID_PROJECTS_ROOT;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    fs.mkdirSync(path.join(home, 'projects'));
    expect(projectsRoot(process.env, home)).toBe(path.join(home, 'projects'));
    fs.rmSync(home, { recursive: true, force: true });
  });

  /**
   * The fresh-install case. No ~/projects means the convention is not in use
   * here, so it contributes NOTHING rather than widening containment to a
   * directory that does not exist.
   */
  it('contributes nothing when <home>/projects is absent — the fresh-install case', () => {
    delete process.env.ID_PROJECTS_ROOT;
    delete process.env.ID_WORKSPACE_DIR;
    delete process.env.ID_ALLOWED_WORKDIR_ROOTS;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    expect(projectsRoot(process.env, home)).toBeNull();
    // Roots collapse to baseWorkDir alone: conservative, never wider.
    expect(agentWorkdirRoots('/work', home)).toEqual(['/work']);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('ignores a <home>/projects that is a FILE, not a directory', () => {
    delete process.env.ID_PROJECTS_ROOT;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    fs.writeFileSync(path.join(home, 'projects'), 'not a dir');
    expect(projectsRoot(process.env, home)).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('hardcodes no developer path anywhere in the module', () => {
    // The rule must generalise: /Users/<someone> in the source would mean it
    // only works on one machine.
    const source = fs.readFileSync(new URL('../../src/lib/path-policy.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\/Users\/[a-z0-9]+\//i);
    expect(source).not.toMatch(/\/home\/[a-z0-9]+\//i);
  });
});

describe('auditWorkdirs — the boot report', () => {
  const roots = ['/work', '/allowed'];

  it('names agents outside every root, with team and path', () => {
    const findings = auditWorkdirs(
      [
        { name: 'inside', working_directory: '/work/agents/a', teamName: 't1' },
        { name: 'outside', working_directory: '/somewhere/else', teamName: 't2' },
      ],
      roots,
    );
    expect(findings).toEqual([{ agent: 'outside', team: 't2', path: '/somewhere/else' }]);
  });

  it('does not flag an agent that chose nothing', () => {
    expect(auditWorkdirs([{ name: 'a', teamName: 't' }], roots)).toEqual([]);
    expect(auditWorkdirs([{ name: 'a', working_directory: '', teamName: 't' }], roots)).toEqual([]);
  });

  it('reports nothing on a fresh install with no agents', () => {
    expect(auditWorkdirs([], roots)).toEqual([]);
    expect(formatWorkdirAudit([], roots)).toEqual([]);
  });

  it('tells the operator which env var to set', () => {
    const lines = formatWorkdirAudit(
      [{ agent: 'a', team: 't', path: '/elsewhere' }], roots,
    ).join('\n');
    expect(lines).toContain('/elsewhere');
    expect(lines).toContain('t/a');
    expect(lines).toContain('ID_PROJECTS_ROOT');
    expect(lines).toContain('ID_ALLOWED_WORKDIR_ROOTS');
    // And that it is a report, not a refusal.
    expect(lines).toContain('keep running');
  });

  it('agrees with the guard by construction', () => {
    // The audit calls resolveWithinRoots, so a path the guard would accept can
    // never be reported — the two cannot drift into disagreement.
    const accepted = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agree-')));
    expect(auditWorkdirs([{ name: 'a', working_directory: accepted }], [accepted])).toEqual([]);
    fs.rmSync(accepted, { recursive: true, force: true });
  });
});
