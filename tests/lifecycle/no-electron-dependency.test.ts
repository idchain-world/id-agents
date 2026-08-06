// SPDX-License-Identifier: MIT
/**
 * The lifecycle code is shared by a terminal and an Electron window, so it must
 * not depend on either. This checks the whole directory rather than trusting a
 * reading of the imports, because the failure mode is a future edit adding a
 * convenient Electron import that nobody notices until the TUI cannot start.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const lifecycleDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/lifecycle',
);

function sourceFiles(): string[] {
  return fs.readdirSync(lifecycleDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(lifecycleDir, name));
}

describe('shared manager lifecycle', () => {
  it('imports nothing from Electron or any UI framework', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1]!;
        if (/^(electron|react|ink|@electron)/.test(specifier)) {
          offenders.push(`${path.basename(file)} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reaches outside its own directory only for node builtins', () => {
    const escapes: string[] = [];
    for (const file of sourceFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1]!;
        if (specifier.startsWith('node:')) continue;
        if (specifier.startsWith('./')) continue;
        escapes.push(`${path.basename(file)} imports ${specifier}`);
      }
    }
    // A relative path that climbs out would couple this to one host app again,
    // which is exactly what moving it here undid.
    expect(escapes).toEqual([]);
  });

  it('covers every file that moved, so a new one cannot slip the check', () => {
    const names = sourceFiles().map((file) => path.basename(file)).sort();
    expect(names).toEqual([
      'ManagerLifecycleService.ts',
      'health-monitor.ts',
      'index.ts',
      'manager-paths.ts',
      'port-probe.ts',
      'process-inspection.ts',
      'types.ts',
    ].sort());
  });
});
