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
  isWithinRoot,
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

describe('spawnWorkdirRoots', () => {
  const saved = { ws: process.env.ID_WORKSPACE_DIR, extra: process.env.ID_ALLOWED_WORKDIR_ROOTS };
  afterEach(() => {
    if (saved.ws === undefined) delete process.env.ID_WORKSPACE_DIR; else process.env.ID_WORKSPACE_DIR = saved.ws;
    if (saved.extra === undefined) delete process.env.ID_ALLOWED_WORKDIR_ROOTS; else process.env.ID_ALLOWED_WORKDIR_ROOTS = saved.extra;
  });

  it('always includes baseWorkDir', () => {
    delete process.env.ID_WORKSPACE_DIR;
    delete process.env.ID_ALLOWED_WORKDIR_ROOTS;
    expect(spawnWorkdirRoots('/work')).toEqual(['/work']);
  });

  it('honours the operator opt-in roots', () => {
    delete process.env.ID_WORKSPACE_DIR;
    process.env.ID_ALLOWED_WORKDIR_ROOTS = '/projects:/repos';
    expect(spawnWorkdirRoots('/work')).toEqual(['/work', '/projects', '/repos']);
  });
});
