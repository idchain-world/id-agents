// SPDX-License-Identifier: MIT
/**
 * TUI command catalog safety tiers and Phase 4 confirmation defaults.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  catalogEntriesByTier,
  completeBuffer,
  commandConfirmPreview,
  confirmationLevel,
  lookupCommand,
} from '../../src/tui/commands/registry.js';

function command(name: string) {
  const spec = lookupCommand(name);
  expect(spec).not.toBeNull();
  return spec!;
}

describe('TUI command registry tiers', () => {
  it('groups every command under exactly one risk tier', () => {
    const grouped = catalogEntriesByTier();
    const names = Object.values(grouped).flat().map((spec) => spec.name);

    expect(new Set(names).size).toBe(names.length);
    expect(grouped.safe.map((spec) => spec.name)).toContain('help');
    expect(grouped.powerful.map((spec) => spec.name)).toContain('deploy');
    expect(grouped.destructive.map((spec) => spec.name)).toContain('delete');
  });

  it('keeps destructive Phase 4 commands behind exact retype confirmation', () => {
    expect(confirmationLevel(command('delete'), ['worker'])).toBe('retype');
    expect(commandConfirmPreview(command('delete'), ['worker'])).toBe('delete agent worker');

    expect(confirmationLevel(command('cancel'), ['worker'])).toBe('retype');
  });

  it('keeps powerful Phase 3 mutators behind Y/N confirmation by default', () => {
    expect(confirmationLevel(command('agent'), ['worker', 'rebuild'])).toBe('yn');
    expect(commandConfirmPreview(command('agent'), ['worker', 'rebuild'])).toBe('rebuild agent worker');
    expect(confirmationLevel(command('agent'), ['worker', 'stop'])).toBe('yn');
    expect(commandConfirmPreview(command('agent'), ['worker', 'stop'])).toBe('stop agent worker');
    expect(confirmationLevel(command('agent'), ['worker', 'probe'])).toBe('none');

    expect(confirmationLevel(command('deploy'), ['idchain'])).toBe('yn');
    // /sync is REMOVED (commit 9, D2): still registered so it tab-completes
    // and explains itself, but it mutates nothing so it is no longer gated.
    expect(confirmationLevel(command('sync'), ['idchain'])).toBe('none');
    expect(confirmationLevel(command('heartbeat'), ['enable', 'worker'])).toBe('yn');
    expect(confirmationLevel(command('heartbeat'), ['worker'])).toBe('none');
  });

  it('opts only obvious tabular command results into table rendering', () => {
    expect(command('status').resultRenderer).toBe('table');
    expect(command('teams').resultRenderer).toBe('table');
    expect(command('list').resultRenderer).toBe('table');

    expect(command('meta').resultRenderer).toBeUndefined();
    expect(command('configs').resultRenderer).toBeUndefined();
    expect(command('output').resultRenderer).toBe('table');
  });

  it('selects table rendering only for :agents team lifecycle fan-out', () => {
    const renderer = command('agents').resultRenderer;
    expect(typeof renderer).toBe('function');
    if (typeof renderer !== 'function') throw new Error('expected dynamic :agents renderer');

    expect(renderer([])).toBe('json');
    expect(renderer(['idchain'])).toBe('json');
    expect(renderer(['idchain', 'rebuild'])).toBe('table');
  });

  it('routes :configs to a TUI action instead of /remote dispatch', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const result = await command('configs').run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: [],
      });

      expect(result).toEqual({ tuiAction: 'configs' });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps :agents without args on the cross-team dispatch path', async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href.endsWith('/teams')) {
        return new Response(JSON.stringify({ teams: [{ name: 'idchain' }, { name: 'public' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ agents: [{ id: href, name: 'agent' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const result = await command('agents').run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: [],
      });

      expect(result).toEqual({
        count: 2,
        agents: [
          { id: 'http://127.0.0.1:0/agents?team=idchain', name: 'agent', teamName: 'idchain' },
          { id: 'http://127.0.0.1:0/agents?team=public', name: 'agent', teamName: 'public' },
        ],
      });
      expect(calls).toEqual([
        'http://127.0.0.1:0/teams',
        'http://127.0.0.1:0/agents?team=idchain',
        'http://127.0.0.1:0/agents?team=public',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes :agents <team> through the single-team agents endpoint', async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      return new Response(JSON.stringify({ agents: [{ id: '1', name: 'cto' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const result = await command('agents').run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['idchain'],
      });

      expect(result).toEqual({
        count: 1,
        agents: [{ id: '1', name: 'cto', teamName: 'idchain' }],
      });
      expect(calls).toEqual(['http://127.0.0.1:0/agents?team=idchain']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects invalid :agents lifecycle args and completes team names plus actions', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ agents: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const result = await command('agents').run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['foo', 'bar'],
      });
      const tooMany = await command('agents').run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['foo', 'bar', 'baz'],
      });
      const publicTeam = await command('agents').run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['public', 'start'],
      });

      expect(result).toEqual({
        ok: false,
        error: 'Usage: /agents [team] | /agents <team> <rebuild|start|stop>',
      });
      expect(tooMany).toEqual({
        ok: false,
        error: 'Usage: /agents [team] | /agents <team> <rebuild|start|stop>',
      });
      expect(publicTeam).toEqual({
        ok: false,
        error: 'Bulk lifecycle is not supported for the public team',
      });
      expect(calls).toEqual([]);
      expect(completeBuffer(':agents id', {
        agentNames: [],
        teamNames: ['idchain', 'public'],
      })).toBe(':agents idchain ');
      expect(completeBuffer(':agents idchain s', {
        agentNames: [],
        teamNames: ['idchain', 'public'],
      })).toBe(':agents idchain st');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('gates :agents team lifecycle fan-out by action risk', () => {
    const spec = command('agents');

    expect(confirmationLevel(spec, ['idchain'])).toBe('none');
    expect(confirmationLevel(spec, ['idchain', 'start'])).toBe('yn');
    expect(confirmationLevel(spec, ['idchain', 'rebuild'])).toBe('yn');
    expect(confirmationLevel(spec, ['idchain', 'stop'])).toBe('retype');
    expect(commandConfirmPreview(spec, ['idchain', 'stop'])).toBe('stop agents in team idchain');
    expect(commandConfirmPreview(spec, ['idchain', 'stop'], {
      teamCounts: new Map([['idchain', 16]]),
    })).toBe('stop 16 agents in team idchain');
  });

  it('fans :agents team lifecycle through per-agent /remote calls and keeps going after failures', async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init: init ?? {} });
      if (href.endsWith('/agents?team=idchain')) {
        return new Response(JSON.stringify({
          agents: [
            { id: '1', name: 'cto' },
            { id: '2', name: 'tui' },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const body = JSON.parse(String(init?.body ?? '{}')) as { command?: string };
      if (body.command === '/agent tui rebuild') {
        return new Response(JSON.stringify({
          ok: false,
          error: 'Failed to rebuild tui:\nreports/\n2026-04-30-erc8217-migration-report.md\n2026-05-07-erc8004-coverage-report.md',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const promise = command('agents').run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['idchain', 'rebuild'],
      });

      await vi.advanceTimersByTimeAsync(250);
      const result = await promise;

      expect(result).toEqual([
        { agent: 'cto', action: 'rebuild', ok: true },
        {
          agent: 'tui',
          action: 'rebuild',
          ok: false,
          error: 'Failed to rebuild tui: (3 more lines hidden)',
        },
      ]);
      expect(calls.map((c) => c.url)).toEqual([
        'http://127.0.0.1:0/agents?team=idchain',
        'http://127.0.0.1:0/remote',
        'http://127.0.0.1:0/remote',
      ]);
      expect(calls.slice(1).map((c) => JSON.parse(String(c.init.body)))).toEqual([
        { agent: 'tui', command: '/agent cto rebuild' },
        { agent: 'tui', command: '/agent tui rebuild' },
      ]);
      expect(calls.slice(1).map((c) => (c.init.headers as Record<string, string>)['x-id-team'])).toEqual([
        'idchain',
        'idchain',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it('skips already-running agents on /agents <team> start', async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init: init ?? {} });
      if (href.endsWith('/agents?team=idchain')) {
        return new Response(JSON.stringify({
          agents: [
            { id: '1', name: 'cto', status: 'running' },
            { id: '2', name: 'cli', status: 'stopped' },
            { id: '3', name: 'tui', status: 'running' },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const promise = command('agents').run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['idchain', 'start'],
      });
      await vi.advanceTimersByTimeAsync(250);
      const result = await promise;

      expect(result).toEqual([
        { agent: 'cto', action: 'skip (already running)', ok: true },
        { agent: 'tui', action: 'skip (already running)', ok: true },
        { agent: 'cli', action: 'start', ok: true },
      ]);
      // Only one /remote call (for `cli`); the running pair was skipped.
      const dispatched = calls
        .filter((c) => c.url.endsWith('/remote'))
        .map((c) => JSON.parse(String(c.init.body)) as { command: string });
      expect(dispatched).toEqual([{ agent: 'tui', command: '/agent cli start' }]);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it('routes :output <agent> to a scoped TUI action and requires an agent argument', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const spec = command('output');
      const ok = await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['cto'],
      });
      const missing = await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: [],
      });

      expect(ok).toEqual({ tuiAction: 'output', agent: 'cto' });
      expect(missing).toEqual({ ok: false, error: 'Usage: /output <agent>' });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects /schedule list/show with a hint pointing at the calendar view', async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      void init;
    }) as typeof fetch;

    try {
      const spec = command('schedule');
      const list = await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['list'],
      });
      const show = await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['show', 'sched_1'],
      });
      const bare = await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: [],
      });

      const hint = 'Use `c` to open the calendar view. /schedule only handles add, pause, resume, remove.';
      expect(list).toEqual({ ok: false, error: hint });
      expect(show).toEqual({ ok: false, error: hint });
      expect(bare).toEqual({ ok: false, error: hint });
      expect(calls).toEqual([]);

      // Mutators still dispatch.
      await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['pause', 'sched_1'],
      });
      expect(calls).toEqual(['http://127.0.0.1:0/remote']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects bare /heartbeat with a hint pointing at the heartbeats view', async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const spec = command('heartbeat');
      const bare = await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: [],
      });
      const justAgent = await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['worker'],
      });

      const hint = 'Use `h` to open the heartbeats view. /heartbeat only handles enable, disable, fire.';
      expect(bare).toEqual({ ok: false, error: hint });
      expect(justAgent).toEqual({ ok: false, error: hint });
      expect(calls).toEqual([]);

      // Mutators still dispatch.
      await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['enable', 'worker'],
      });
      expect(calls).toEqual(['http://127.0.0.1:0/remote']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects /task list/show with a hint pointing at the tasks view', async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const spec = command('task');
      const list = await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['list'],
      });
      const bare = await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: [],
      });

      const hint = 'Use `t` to open the tasks view. /task only handles assign, status, done, remove, delete. Use the manager dispatch path for /task create.';
      expect(list).toEqual({ ok: false, error: hint });
      expect(bare).toEqual({ ok: false, error: hint });
      expect(calls).toEqual([]);

      // Mutators still dispatch.
      await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['assign', 'foo', 'worker'],
      });
      expect(calls).toEqual(['http://127.0.0.1:0/remote']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes :team <name> through /remote as a safe switch', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, result: { switched: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const spec = command('team');
      expect(spec.tier).toBe('powerful');
      expect(confirmationLevel(spec, [])).toBe('none');
      expect(confirmationLevel(spec, ['skunkworks'])).toBe('none');
      expect(commandConfirmPreview(spec, ['skunkworks'])).toBeNull();

      await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['skunkworks'],
      });

      // Mixed-case team names are normalized to lowercase before dispatch.
      await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['Idchain'],
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]?.url).toBe('http://127.0.0.1:0/remote');
      expect(calls[0]?.init.method).toBe('POST');
      expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
        agent: 'tui',
        command: '/team skunkworks',
      });
      expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
        agent: 'tui',
        command: '/team idchain',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes :team delete <name> through /remote with retype confirmation preview', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, result: { success: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const spec = command('team');
      expect(confirmationLevel(spec, ['delete'])).toBe('none');
      expect(confirmationLevel(spec, ['delete', 'foo'])).toBe('retype');
      expect(commandConfirmPreview(spec, ['delete', 'foo'])).toBe('DELETE team foo');

      await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['delete', 'foo'],
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('http://127.0.0.1:0/remote');
      expect(calls[0]?.init.method).toBe('POST');
      expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
        agent: 'tui',
        command: '/team delete foo',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('escalates hybrid remove/delete subcommands from Y/N to retype', () => {
    expect(confirmationLevel(command('schedule'), ['add', 'daily'])).toBe('yn');
    expect(confirmationLevel(command('schedule'), ['remove', 'daily'])).toBe('retype');

    expect(confirmationLevel(command('task'), ['assign', 'ship-it', 'worker'])).toBe('yn');
    expect(confirmationLevel(command('task'), ['delete', 'ship-it'])).toBe('yn');
    expect(confirmationLevel(command('task'), ['delete', '*'])).toBe('retype');
  });
});
