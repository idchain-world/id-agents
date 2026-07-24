// SPDX-License-Identifier: MIT
/**
 * Config path resolution for `/sync` and `/deploy`.
 *
 * Regression context: both commands resolved relative paths against
 * `process.cwd()` only. When the desktop app owns the manager daemon its cwd
 * is `~/Library/Application Support/id-agents-desktop`, so `/sync idchain`
 * failed with "Config file not found" even though the file existed in the
 * user's checkout. These tests pin the search order and the cwd-first
 * guarantee that keeps repo-spawned managers behaving exactly as before.
 */

import { describe, expect, it } from 'vitest';

import { configNotFoundError, resolveConfigPath } from '../../src/core/config-paths.js';

/** Build a lookup whose only existing files are the listed absolute paths. */
function withFiles(paths: string[]) {
  const set = new Set(paths);
  return (p: string) => set.has(p);
}

const BASE = {
  cwd: '/Users/dev/projects/id-agents',
  baseWorkDir: '/var/app-support/id-agents-desktop/workspace',
  homedir: '/Users/dev',
  env: {} as NodeJS.ProcessEnv,
};

describe('resolveConfigPath', () => {
  it('resolves against cwd first, preserving repo-spawned behaviour', () => {
    const r = resolveConfigPath('configs/idchain.yaml', {
      ...BASE,
      exists: withFiles([
        '/Users/dev/projects/id-agents/configs/idchain.yaml',
        '/Users/dev/.id-agents/configs/idchain.yaml',
      ]),
    });
    expect(r.resolved).toBe('/Users/dev/projects/id-agents/configs/idchain.yaml');
    expect(r.searched[0]).toBe('/Users/dev/projects/id-agents/configs/idchain.yaml');
  });

  it('lets ID_AGENTS_CONFIG_ROOT win over cwd when set', () => {
    const r = resolveConfigPath('configs/idchain.yaml', {
      ...BASE,
      env: { ID_AGENTS_CONFIG_ROOT: '/Users/dev/projects/id-agents' } as NodeJS.ProcessEnv,
      cwd: '/var/app-support/id-agents-desktop',
      exists: withFiles([
        '/Users/dev/projects/id-agents/configs/idchain.yaml',
        '/var/app-support/id-agents-desktop/configs/idchain.yaml',
      ]),
    });
    expect(r.resolved).toBe('/Users/dev/projects/id-agents/configs/idchain.yaml');
  });

  it('falls back past a desktop-owned cwd to ~/.id-agents (the reported bug)', () => {
    const r = resolveConfigPath('configs/idchain.yaml', {
      ...BASE,
      // Desktop app owns the daemon: cwd holds no configs/ directory at all.
      cwd: '/var/app-support/id-agents-desktop',
      exists: withFiles(['/Users/dev/.id-agents/configs/idchain.yaml']),
    });
    expect(r.resolved).toBe('/Users/dev/.id-agents/configs/idchain.yaml');
  });

  it('falls back to the manager base work dir before the home dir', () => {
    const r = resolveConfigPath('configs/idchain.yaml', {
      ...BASE,
      cwd: '/var/app-support/id-agents-desktop',
      exists: withFiles([
        '/var/app-support/id-agents-desktop/workspace/configs/idchain.yaml',
        '/Users/dev/.id-agents/configs/idchain.yaml',
      ]),
    });
    expect(r.resolved).toBe('/var/app-support/id-agents-desktop/workspace/configs/idchain.yaml');
  });

  it('treats an absolute path as a direct instruction and never searches around it', () => {
    const abs = '/Users/dev/projects/id-agents/configs/idchain.yaml';
    const hit = resolveConfigPath(abs, { ...BASE, exists: withFiles([abs]) });
    expect(hit.resolved).toBe(abs);
    expect(hit.searched).toEqual([abs]);

    const miss = resolveConfigPath('/nope/absent.yaml', {
      ...BASE,
      // A same-named file under another root must NOT be substituted.
      exists: withFiles(['/Users/dev/.id-agents/nope/absent.yaml']),
    });
    expect(miss.resolved).toBeNull();
    expect(miss.searched).toEqual(['/nope/absent.yaml']);
  });

  it('reports every candidate it tried, without duplicates', () => {
    const r = resolveConfigPath('configs/missing.yaml', {
      ...BASE,
      exists: () => false,
    });
    expect(r.resolved).toBeNull();
    expect(r.searched).toEqual([
      '/Users/dev/projects/id-agents/configs/missing.yaml',
      '/var/app-support/id-agents-desktop/workspace/configs/missing.yaml',
      '/Users/dev/.id-agents/configs/missing.yaml',
    ]);
    expect(new Set(r.searched).size).toBe(r.searched.length);
  });

  it('collapses duplicate roots (cwd === config root) into one candidate', () => {
    const r = resolveConfigPath('configs/x.yaml', {
      ...BASE,
      env: { ID_AGENTS_CONFIG_ROOT: BASE.cwd } as NodeJS.ProcessEnv,
      exists: () => false,
    });
    expect(r.searched.filter((p) => p === `${BASE.cwd}/configs/x.yaml`)).toHaveLength(1);
  });

  it('ignores an empty ID_AGENTS_CONFIG_ROOT rather than resolving against ""', () => {
    const r = resolveConfigPath('configs/idchain.yaml', {
      ...BASE,
      env: { ID_AGENTS_CONFIG_ROOT: '' } as NodeJS.ProcessEnv,
      exists: withFiles(['/Users/dev/projects/id-agents/configs/idchain.yaml']),
    });
    expect(r.resolved).toBe('/Users/dev/projects/id-agents/configs/idchain.yaml');
  });
});

describe('configNotFoundError', () => {
  it('names the file and every path tried, and points at the escape hatch', () => {
    const msg = configNotFoundError('configs/idchain.yaml', ['/a/configs/idchain.yaml', '/b/configs/idchain.yaml']);
    expect(msg).toContain('Config file not found: configs/idchain.yaml');
    expect(msg).toContain('/a/configs/idchain.yaml');
    expect(msg).toContain('/b/configs/idchain.yaml');
    expect(msg).toContain('ID_AGENTS_CONFIG_ROOT');
  });
});
