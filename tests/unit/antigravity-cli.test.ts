// SPDX-License-Identifier: MIT
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { afterEach, expect, it, vi } from 'vitest';
import { buildAntigravityArgs, parseAntigravityStream } from '../../src/harness/antigravity-cli.js';
import { antigravityEnvironment, prepareAntigravityDirectory } from '../../src/runtime/antigravity.js';

async function parse(chunks: string[], resume?: string) {
  const lines = createInterface({ input: Readable.from(chunks) });
  const messages = [];
  for await (const message of parseAntigravityStream(lines, resume)) messages.push(message);
  return messages;
}

afterEach(() => vi.restoreAllMocks());

it.each(['text', 'tool-read', 'resume', 'unknown-model', 'interrupted'])('parses captured %s events', async name => {
  const data = readFileSync(new URL('../fixtures/antigravity/' + name + '.ndjson', import.meta.url), 'utf8');
  const result = JSON.parse(data.trimEnd().split('\n').at(-1)!).result;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const events = await parse(['noise\n', data.slice(0, 17), data.slice(17).trimEnd()], name === 'resume' ? 'missing' : undefined);
  expect(events.at(-1)).toMatchObject(result.status === 'ERROR'
    ? { type: 'error', content: result.error }
    : { type: 'result', result: result.response, session_id: result.conversation_id });
  if (name === 'resume') expect(warn).toHaveBeenCalledWith(expect.stringContaining(result.conversation_id));
  if (name === 'tool-read') expect(events.filter(e => e.type === 'tool_use')).toMatchObject([{ tool_name: 'read_file' }]);
});

it('does not turn progress into a reply when the result is missing', async () => {
  const progress = { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'partial' } };
  expect(await parse([JSON.stringify(progress)])).toEqual([]);
});

it('emits completed intermediate steps once and leaves final text to the result', async () => {
  const step = (index: number, state: string, text: string) => ({
    event: 'step_update', step_update: { step_type: 'agent_response', step_index: index, state, text_delta: text },
  });
  const events = [
    step(1, 'ACTIVE', 'Looking'), step(1, 'DONE', ' now'), step(1, 'DONE', ' now'),
    step(2, 'ACTIVE', 'All'), step(2, 'DONE', ' done'),
    { event: 'result', result: { status: 'SUCCESS', response: 'All done' } },
  ];
  expect(await parse([events.map(e => JSON.stringify(e)).join('\n')])).toMatchObject([
    { type: 'progress', content: 'Looking now' }, { type: 'result', result: 'All done' },
  ]);
});

it('ignores repeated ACTIVE tool events and rejects whitespace-only success', async () => {
  const step = JSON.stringify({ event: 'step_update', step_update: { step_index: 5, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file' } });
  const result = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '  ' } });
  expect((await parse([[step, step, result].join('\n')])).map(e => e.type)).toEqual(['tool_use', 'error']);
});

it('constructs isolated args, preserving a dash-prefixed multiline prompt', () => {
  expect(buildAntigravityArgs('--flag\nhello', { model: 'neon', effort: 'low', resume: 'previous' }, '/dir', false)).toEqual([
    '--gemini_dir', '/dir', '--model', 'gemini-4-neon-low', '--output-format', 'stream-json',
    '--conversation', 'previous', '--mode', 'accept-edits', '-p=--flag\nhello',
  ]);
  expect(buildAntigravityArgs('hello', {}, '/dir', true).slice(-2)).toEqual(['--dangerously-skip-permissions', '-p=hello']);
  expect(() => buildAntigravityArgs('hello', { model: 'astra' }, '/dir', true)).toThrow(/not enabled/);
});

it('requires explicit key opt-in', () => {
  expect(antigravityEnvironment({ HOME: '/home', GEMINI_API_KEY: 'key' })).toEqual({ HOME: '/home' });
  const root = mkdtempSync(join(tmpdir(), 'agy-auth-'));
  try {
    const env = { ID_AGY_GEMINI_DIR: root, ID_AGY_USE_API_KEY: 'true', GEMINI_API_KEY: 'test' };
    expect(antigravityEnvironment(env)).toEqual(env);
    const dir = prepareAntigravityDirectory(env);
    const settings = join(dir, 'antigravity-cli/settings.json');
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ modelProvider: 'gemini' });
    writeFileSync(settings, '{"theme":"blue"}');
    expect(prepareAntigravityDirectory(env)).toBe(dir);
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ theme: 'blue', modelProvider: 'gemini' });
    expect(prepareAntigravityDirectory({ ID_AGY_GEMINI_DIR: root })).toBe(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each([
  ['carbon', 'gemini-4-carbon-high'], ['carbon-medium', 'gemini-4-carbon-medium'],
  ['argon', 'gemini-4-argon-high'], ['argon-low', 'gemini-4-argon-low'],
  ['hydrogen', 'gemini-4-hydrogen-high'], ['hydrogen-xhigh', 'gemini-4-hydrogen-xhigh'],
  ['orchestrator', 'gemini-pro-orchestrator-neon'], ['orchestrator-neon', 'gemini-pro-orchestrator-neon'],
  ['orchestrator-carbon', 'gemini-pro-orchestrator'], ['orchestrator-argon', 'gemini-pro-orchestrator-argon'],
  ['gemini-3.8-flash-low', 'gemini-3.8-flash-low'],
])('passes %s to agy as %s', (model, slug) => {
  expect(buildAntigravityArgs('test', { model }, '/dir', true)[3]).toBe(slug);
});

it.each(['carbon', 'argon', 'gemini-4-carbon-xhigh', 'orchestrator'])('rejects unavailable effort on %s', model => {
  expect(() => buildAntigravityArgs('test', { model, effort: 'xhigh' }, '/dir', false)).toThrow(/effort/);
});

it.each(['authentication required', 'Error: Please sign in to view available models.'])('explains host sign-in for %s', async error => {
  const result = JSON.stringify({ event: 'result', result: { status: 'ERROR', error } });
  for (const output of [error, result]) {
    expect(await parse([output])).toMatchObject([{ type: 'error', content: expect.stringContaining('Run agy once in a terminal on the host') }]);
  }
});
