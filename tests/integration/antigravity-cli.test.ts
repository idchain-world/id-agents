// SPDX-License-Identifier: MIT
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHarness } from '../../src/harness/index.js';
import { validateRuntimePreflight } from '../../src/runtime/registry.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-harness-'));
  vi.stubEnv('PATH', dir + ':' + process.env.PATH);
  vi.stubEnv('AGY_PATH', '');
  vi.stubEnv('ID_AGY_GEMINI_DIR', join(dir, 'state'));
  vi.stubEnv('ID_AGY_USE_API_KEY', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function fake(source: string) {
  writeFileSync(join(dir, 'agy'), '#!/usr/bin/env node\n' +
    "if (process.argv[2] === '--version') { require('node:fs').appendFileSync(require('node:path').join(__dirname, 'version-calls'), '1'); console.log('1.5.15'); process.exit(0); }\n" + source, { mode: 0o755 });
}

it('runs the fixture through the registered harness and resumes the reported session', async () => {
  fake(`
    const fs = require('node:fs');
    fs.writeFileSync('args', JSON.stringify(process.argv.slice(2)));
    if (process.env.ORCA_TEST || fs.readFileSync(0).length) process.exit(2);
    fs.createReadStream(process.env.FIXTURE, {highWaterMark: 7}).pipe(process.stdout);
  `);
  const harness = createHarness('antigravity-cli');
  const env = { ORCA_TEST: 'strip', FIXTURE: fileURLToPath(new URL('../fixtures/antigravity/tool-read.ndjson', import.meta.url)) };
  const events = [];
  for await (const event of harness.run('first', { workingDirectory: dir, env })) events.push(event);
  const session = events[0].session_id;
  expect(session).toBe('4f7ccb6e-591d-4020-8829-02020f50bdc2');
  expect(events.filter(e => e.type === 'tool_use')).toMatchObject([{ tool_name: 'read_file' }]);
  expect(events.at(-1)).toMatchObject({ type: 'result', result: 'secret-token-QZ41-7731\n', session_id: session });
  for await (const event of harness.run('--next', { workingDirectory: dir, env, resume: session })) events.push(event);
  expect(readFileSync(join(dir, 'version-calls'), 'utf8')).toBe('1');
  expect(JSON.parse(readFileSync(join(dir, 'args'), 'utf8'))).toEqual([
    '--gemini_dir', join(dir, 'state'), '--model', 'gemini-4-neon-high', '--output-format', 'stream-json',
    '--conversation', session, '--dangerously-skip-permissions', '-p=--next',
  ]);
});

it.each([0, 7])('reports missing result on exit %s', async code => {
  fake(`console.log('noise'); console.error('diagnostic'); process.exitCode = ${code};`);
  const run = createHarness('antigravity-cli').run('prompt', {});
  const events = [];
  for await (const event of run) events.push(event);
  expect(events).toMatchObject([{ type: 'error', content: expect.stringContaining('(' + code + ') without a result event: diagnostic') }]);
});

it('returns after agy exits while a child still holds stdout', async () => {
  fake(`
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
      stdio: ['ignore', 'inherit', 'ignore'],
    });
    require('node:fs').writeFileSync('child.pid', String(child.pid));
    child.unref();
    console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'done' } }));
  `);
  try {
    const events = [];
    for await (const event of createHarness('antigravity-cli').run('prompt', { workingDirectory: dir })) events.push(event);
    expect(events).toMatchObject([{ type: 'result', result: 'done' }]);
    process.kill(Number(readFileSync(join(dir, 'child.pid'), 'utf8')), 0);
  } finally {
    try { process.kill(Number(readFileSync(join(dir, 'child.pid'), 'utf8')), 'SIGKILL'); } catch {}
  }
});

it('kills a tool that ignores INT and TERM and outlives the CLI', async () => {
  fake(`
    const child = require('node:child_process').spawn(process.execPath, ['-e',
      "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 5000);"
    ], {stdio: ['ignore','pipe','ignore']});
    child.stdout.once('data', () => console.log(JSON.stringify({event: 'init', conversation_id: String(process.pid)})));
    process.on('SIGINT', () => process.exit(1));
  `);
  const harness = createHarness('antigravity-cli');
  const run = harness.run('wait', {});
  const init = await run.next();
  const pid = Number(init.value?.session_id);
  try {
    expect(pid).toBeGreaterThan(0);
    expect(harness.cancel?.()).toBe(true);
    for await (const event of run) expect(event.type).toBe('error');
    await vi.waitFor(() => expect(() => process.kill(-pid, 0)).toThrow(/ESRCH/), { timeout: 4000 });
    expect(harness.cancel?.()).toBe(false);
  } finally {
    if (pid > 0) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  }
});

it('checks /usage in the isolated directory and diagnoses auth, flag and binary failures', () => {
  fake(`if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--gemini_dir', process.env.ID_AGY_GEMINI_DIR, '--output-format', 'json', '-p=/usage'])) process.exit(1);
    console.log('{"status":"SUCCESS"}');`);
  expect(validateRuntimePreflight('antigravity')).toEqual([]);
  fake("console.log('{\"status\":\"ERROR\"}'); process.exitCode = 1;");
  expect(validateRuntimePreflight('antigravity')[0].message).toMatch(/run agy once in a terminal/i);
  fake("console.error('flag provided but not defined: --gemini_dir'); process.exitCode = 2;");
  expect(validateRuntimePreflight('antigravity')[0].message).toMatch(/rejected --gemini_dir/);
  vi.stubEnv('AGY_PATH', join(dir, 'missing'));
  expect(validateRuntimePreflight('antigravity')[0].code).toBe('runtime_binary_missing');
});
