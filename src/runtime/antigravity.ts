// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process';
import type { RuntimeValidationIssue } from './types.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function antigravityEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ORCA_')) delete env[key];
  }
  if (env.ID_AGY_USE_API_KEY !== 'true') delete env.GEMINI_API_KEY;
  return env;
}

export function prepareAntigravityDirectory(env: NodeJS.ProcessEnv): string {
  const root = env.ID_AGY_GEMINI_DIR || join(homedir(), '.id-agents', 'antigravity');
  if (!isAbsolute(root)) throw new Error('ID_AGY_GEMINI_DIR must be an absolute path');
  if (env.ID_AGY_USE_API_KEY !== 'true') {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return root;
  }
  if (!env.GEMINI_API_KEY) throw new Error('ID_AGY_USE_API_KEY=true requires GEMINI_API_KEY');

  const dir = join(root, 'api-key');
  const config = join(dir, 'antigravity-cli');
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const path = join(config, 'settings.json');
  let settings;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    settings = {};
  }
  if (settings.modelProvider !== 'gemini') {
    const temporary = join(config, randomUUID());
    writeFileSync(temporary, JSON.stringify({ ...settings, modelProvider: 'gemini' }, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, path);
  }
  return dir;
}

export function checkAntigravityPreflight(): RuntimeValidationIssue[] {
  const env = antigravityEnvironment(process.env);
  const binary = env.AGY_PATH || 'agy';
  const version = spawnSync(binary, ['--version'], { env, encoding: 'utf8', timeout: 10000 });
  if (version.status !== 0) {
    return [{ code: 'runtime_binary_missing', message: `Cannot run ${binary} --version. Install agy and run agy once in a terminal to sign in.` }];
  }
  try {
    const dir = prepareAntigravityDirectory(env);
    const probe = spawnSync(binary, ['--gemini_dir', dir, '--output-format', 'json', '-p=/usage'], {
      env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = `${probe.stderr || ''} ${probe.stdout || ''}`;
    if (/gemini_dir/i.test(output) && /unknown|unrecognized|invalid flag|not defined|unsupported/i.test(output)) {
      return [{ code: 'antigravity_config_unsupported', message: 'agy rejected --gemini_dir. Install a version that supports isolated configuration.' }];
    }
    if (probe.error) throw probe.error;
    if (probe.status === 0 && JSON.parse(probe.stdout)?.status === 'SUCCESS') return [];
    return [{ code: 'antigravity_auth_missing', message: 'Antigravity /usage failed. Run agy once in a terminal to sign in.' }];
  } catch (error) {
    return [{ code: 'antigravity_preflight_failed', message: `Antigravity preflight failed: ${error instanceof Error ? error.message : error}. Check configuration and run agy once in a terminal to sign in.` }];
  }
}
