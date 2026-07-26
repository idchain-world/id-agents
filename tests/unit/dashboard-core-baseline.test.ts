// SPDX-License-Identifier: MIT
/**
 * Characterization ("golden master") baseline for the reusable TUI domain
 * layer that the Electron dashboard (docs/tui-electron/commit-plan.md) will
 * extract into `dashboard-core`.
 *
 * Commit 1 is TESTS ONLY: it freezes the CURRENT behavior of
 *   - src/tui/api/*          (DTO mapping + manager error classification)
 *   - src/tui/commands/registry.ts  (parse / complete / confirm)
 *   - renderer-neutral src/tui/util/*  (format, tabular, status, effort,
 *     runtime, model, color, schedule math)
 * before any production code moves. These assertions encode observed
 * behavior, not desired behavior — a later extraction commit that changes an
 * assertion here must do so deliberately.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  NetworkError,
  ManagerError,
  getManagerUrl,
  runRemoteCommand,
  fetchTeams,
  fetchAgentsByTeam,
  fetchTasks,
  fetchAgentsAllTeams,
  installLibraryTeam,
} from '../../src/tui/api/manager.js';
import {
  parseCommandLine,
  completeCommand,
  completeBuffer,
  confirmationLevel,
  commandConfirmPreview,
  catalogEntriesByTier,
  lookupCommand,
  knownCommandNames,
} from '../../src/tui/commands/registry.js';
import type { CommandSpec } from '../../src/tui/commands/registry.js';
import type { Schedule, Team } from '../../src/tui/api/types.js';
import { parseAgent } from '../../src/dashboard-core/api/validation.js';

import { humanizeUptime, humanizeLastSeen, truncate, padRight } from '../../src/tui/util/format.js';
import { detectTabularResult, isPlainObject } from '../../src/tui/util/tabular.js';
import { abbrevStatus, abbrevHealth } from '../../src/tui/util/status.js';
import { abbrevEffort } from '../../src/tui/util/effort.js';
import { abbrevRuntime } from '../../src/tui/util/runtime.js';
import { abbrevModel } from '../../src/tui/util/models.js';
import {
  statusColor,
  healthColor,
  healthDot,
  taskStatusColor,
  taskStatusGlyph,
  newsAgeColor,
} from '../../src/tui/util/colors.js';
import {
  cadenceLabel,
  formatInterval,
  nextFireSec,
  formatLocalTime,
  formatNextFire,
} from '../../src/tui/util/schedule.js';

/* ---------------------------------------------------------------------- */
/*  Fixtures                                                              */
/* ---------------------------------------------------------------------- */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/dashboard-core');
const fixture = <T = any>(name: string): T =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as T;

const teamsResponse = fixture('teams-response.json');
const agentsResponse = fixture('agents-response.json');
const remoteTasks = fixture('remote-tasks.json');
const schedules = fixture('schedules.json');
const tabularSamples = fixture('tabular-samples.json');

/* ---------------------------------------------------------------------- */
/*  fetch stub helpers                                                    */
/* ---------------------------------------------------------------------- */

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<unknown>;

function withFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(
  body: unknown,
  opts: { ok?: boolean; status?: number; statusText?: string } = {},
): unknown {
  const { ok = true, status = 200, statusText = 'OK' } = opts;
  return {
    ok,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const signal = new AbortController().signal;
const MANAGER = 'http://manager.test';

/* ====================================================================== */
/*  src/tui/api — DTO mapping                                             */
/* ====================================================================== */

describe('dashboard-core baseline: api DTO mapping', () => {
  it('getManagerUrl falls back to localhost:4100 and honors MANAGER_URL', () => {
    const original = process.env.MANAGER_URL;
    try {
      delete process.env.MANAGER_URL;
      expect(getManagerUrl()).toBe('http://localhost:4100');
      process.env.MANAGER_URL = 'http://example:9999';
      expect(getManagerUrl()).toBe('http://example:9999');
    } finally {
      if (original === undefined) delete process.env.MANAGER_URL;
      else process.env.MANAGER_URL = original;
    }
  });

  it('fetchTeams drops the synthetic "all" team (case-insensitive)', async () => {
    const teams = await withFetch(
      async () => jsonResponse(teamsResponse),
      () => fetchTeams(MANAGER, signal),
    );
    expect(teams.map((t) => t.name)).toEqual(['idchain', 'Dappa']);
  });

  it('fetchAgentsByTeam injects teamName onto every returned agent', async () => {
    const agents = await withFetch(
      async () => jsonResponse(agentsResponse),
      () => fetchAgentsByTeam(MANAGER, 'idchain', signal),
    );
    expect(agents).toHaveLength(2);
    expect(agents.every((a) => a.teamName === 'idchain')).toBe(true);
    // Original fields survive the spread.
    expect(agents[0]!.id).toBe('a1');
    expect(agents[0]!.model).toBe('claude-opus-4-8');
  });

  it('fetchTasks unwraps the {ok,result:{tasks}} remote envelope', async () => {
    const tasks = await withFetch(
      async () => jsonResponse(remoteTasks),
      () => fetchTasks(MANAGER, 'coder', signal, 'idchain'),
    );
    expect(tasks.map((t) => t.title)).toEqual(['Task A', 'Task B']);
  });

  it('fetchAgentsAllTeams de-duplicates agents by id across teams', async () => {
    const teams: Team[] = [
      { id: 't1', name: 'idchain', agentCount: 2 },
      { id: 't2', name: 'dappa', agentCount: 2 },
    ];
    // Both teams return the SAME two agent ids → union must collapse to 2.
    const agents = await withFetch(
      async () => jsonResponse(agentsResponse),
      () => fetchAgentsAllTeams(MANAGER, teams, signal),
    );
    expect(agents.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });
});

/* ====================================================================== */
/*  src/tui/api — manager error classification                           */
/* ====================================================================== */

describe('dashboard-core baseline: manager error behavior', () => {
  it('runRemoteCommand returns the unwrapped result on success', async () => {
    const result = await withFetch(
      async () => jsonResponse({ ok: true, result: { foo: 1 } }),
      () => runRemoteCommand<{ foo: number }>(MANAGER, 'coder', '/x', signal),
    );
    expect(result).toEqual({ foo: 1 });
  });

  it('classifies a thrown fetch (connect refused / abort) as NetworkError', async () => {
    await withFetch(
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => {
        await expect(runRemoteCommand(MANAGER, 'coder', '/x', signal)).rejects.toBeInstanceOf(
          NetworkError,
        );
      },
    );
  });

  it('classifies a 5xx as NetworkError (server transient)', async () => {
    await withFetch(
      async () => jsonResponse({}, { ok: false, status: 500, statusText: 'Internal Server Error' }),
      async () => {
        await expect(runRemoteCommand(MANAGER, 'coder', '/x', signal)).rejects.toBeInstanceOf(
          NetworkError,
        );
      },
    );
  });

  it('classifies a 4xx as ManagerError (semantic rejection)', async () => {
    await withFetch(
      async () => jsonResponse({}, { ok: false, status: 400, statusText: 'Bad Request' }),
      async () => {
        await expect(runRemoteCommand(MANAGER, 'coder', '/x', signal)).rejects.toBeInstanceOf(
          ManagerError,
        );
      },
    );
  });

  it('classifies an {ok:false,error} envelope as ManagerError carrying the message', async () => {
    await withFetch(
      async () => jsonResponse({ ok: false, error: 'not allowed' }),
      async () => {
        await expect(runRemoteCommand(MANAGER, 'coder', '/x', signal)).rejects.toThrowError(
          'not allowed',
        );
      },
    );
  });

  it('installLibraryTeam normalizes a non-ok HTTP body into a typed failure', async () => {
    const res = await withFetch(
      async () => jsonResponse({ error: 'exists' }, { ok: false, status: 409, statusText: 'Conflict' }),
      () => installLibraryTeam(MANAGER, { template: 'web', dest: 'web2' }, signal),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.error).toBe('exists');
    }
  });
});

/* ====================================================================== */
/*  src/tui/commands/registry — parsing                                  */
/* ====================================================================== */

describe('dashboard-core baseline: command parsing', () => {
  it('strips leading : and / sigils, trims, and splits on whitespace', () => {
    expect(parseCommandLine('/task done x')).toEqual({ name: 'task', args: ['done', 'x'] });
    expect(parseCommandLine(':help')).toEqual({ name: 'help', args: [] });
    expect(parseCommandLine('//task')).toEqual({ name: 'task', args: [] });
    expect(parseCommandLine('task')).toEqual({ name: 'task', args: [] });
    expect(parseCommandLine('/task   a    b')).toEqual({ name: 'task', args: ['a', 'b'] });
  });

  it('returns null for empty / sigil-only input', () => {
    expect(parseCommandLine('')).toBeNull();
    expect(parseCommandLine('   ')).toBeNull();
    expect(parseCommandLine('///')).toBeNull();
  });
});

/* ====================================================================== */
/*  src/tui/commands/registry — completion                               */
/* ====================================================================== */

describe('dashboard-core baseline: command completion', () => {
  it('completeCommand resolves a unique prefix and appends a space', () => {
    expect(completeCommand(':hel')).toBe(':help ');
  });

  it('completeCommand advances to the longest common prefix when ambiguous', () => {
    // team, teams → common prefix "team", no trailing space.
    expect(completeCommand(':te')).toBe(':team');
  });

  it('completeCommand returns null when already at the common prefix', () => {
    // heartbeat, help share only "he" and the buffer is already "he".
    expect(completeCommand(':he')).toBeNull();
  });

  it('completeCommand returns null for exact match, no match, or missing sigil', () => {
    expect(completeCommand(':help')).toBeNull();
    expect(completeCommand(':zzz')).toBeNull();
    expect(completeCommand('help')).toBeNull();
  });

  it('completeBuffer delegates to first-token completion before any space', () => {
    expect(completeBuffer(':te', { agentNames: [], teamNames: [] })).toBe(':team');
  });

  it('completeBuffer completes an arg slot from the spec argCompleter', () => {
    const ctx = { agentNames: ['coder', 'bisor'], teamNames: [] };
    expect(completeBuffer(':meta co', ctx)).toBe(':meta coder ');
    expect(completeBuffer(':meta b', ctx)).toBe(':meta bisor ');
  });

  it('completeBuffer returns null for a command without an argCompleter', () => {
    expect(completeBuffer(':task ', { agentNames: ['coder'], teamNames: [] })).toBeNull();
  });
});

/* ====================================================================== */
/*  src/tui/commands/registry — confirmation gating                      */
/* ====================================================================== */

describe('dashboard-core baseline: confirmation classification', () => {
  const task = lookupCommand('task') as CommandSpec;
  const sync = lookupCommand('sync') as CommandSpec;
  const help = lookupCommand('help') as CommandSpec;

  it('task mutators require Y/N, bulk delete requires retype (retype wins)', () => {
    expect(confirmationLevel(task, ['done', 'abc'])).toBe('yn');
    expect(confirmationLevel(task, ['delete', 'abc'])).toBe('yn');
    expect(confirmationLevel(task, ['delete', '*'])).toBe('retype');
    expect(confirmationLevel(task, ['delete', '--team', 'idchain'])).toBe('retype');
    expect(confirmationLevel(task, ['list'])).toBe('none');
  });

  it('always-gated commands return yn, read-only commands return none', () => {
    // /sync is REMOVED (commit 9, D2). It stays REGISTERED so it still
    // tab-completes and can explain itself, but it mutates nothing, so it is
    // 'safe' with no confirmation and no preview. Was 'yn' / 'sync team: idchain'.
    expect(confirmationLevel(sync, ['idchain'])).toBe('none');
    expect(confirmationLevel(help, [])).toBe('none');
  });

  it('commandConfirmPreview renders the frozen preview strings', () => {
    expect(commandConfirmPreview(task, ['delete', '*'])).toBe('DELETE ALL tasks in the active team');
    expect(commandConfirmPreview(task, ['status', 't1', 'done'])).toBe('set task t1 to done');
    expect(commandConfirmPreview(task, ['delete', 'abc'])).toBe('delete task abc');
    // No preview: a command that only prints guidance has nothing to preview.
    expect(commandConfirmPreview(sync, ['idchain'])).toBeNull();
    expect(commandConfirmPreview(help, [])).toBeNull();
  });

  it('knownCommandNames is the frozen, sorted catalog', () => {
    const names = knownCommandNames();
    expect(names).toEqual([
      'agent',
      'agents',
      'cancel',
      'configs',
      'delete',
      'deploy',
      'heartbeat',
      'help',
      'list',
      'meta',
      'output',
      'schedule',
      'status',
      'sync',
      'task',
      'team',
      'teams',
    ]);
    expect([...names].sort()).toEqual(names);
  });

  it('catalogEntriesByTier groups by risk with help pinned first in safe', () => {
    const byTier = catalogEntriesByTier();
    expect(byTier.safe[0]!.name).toBe('help');
    expect(byTier.destructive.map((s) => s.name)).toContain('task');
    // Every entry is filed under its own tier.
    for (const tier of ['safe', 'powerful', 'destructive'] as const) {
      expect(byTier[tier].every((s) => s.tier === tier)).toBe(true);
    }
  });
});

/* ====================================================================== */
/*  src/tui/util/format                                                  */
/* ====================================================================== */

describe('dashboard-core baseline: formatting', () => {
  it('humanizeUptime bands seconds/minutes/hours/days', () => {
    expect(humanizeUptime(0, 30_000)).toBe('new');
    expect(humanizeUptime(0, 120_000)).toBe('2m');
    expect(humanizeUptime(0, 7_200_000)).toBe('2h');
    expect(humanizeUptime(0, 172_800_000)).toBe('2d');
    expect(humanizeUptime(100, 0)).toBe('new'); // clamps negative to 0
  });

  it('humanizeLastSeen returns "" for never-probed and "<n> ago" bands otherwise', () => {
    expect(humanizeLastSeen(null, 1_000_000)).toBe('');
    expect(humanizeLastSeen(0, 1_000_000)).toBe('');
    expect(humanizeLastSeen(1000, 1_030_000)).toBe('30s ago');
    expect(humanizeLastSeen(1000, 1_300_000)).toBe('5m ago');
    expect(humanizeLastSeen(1000, 8_200_000)).toBe('2h ago');
    expect(humanizeLastSeen(1000, 173_800_000)).toBe('2d ago');
  });

  it('truncate uses an ellipsis and pads exactly', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 3)).toBe('he…');
    expect(truncate('hello', 1)).toBe('h');
    expect(truncate('hello', 0)).toBe('');
    expect(padRight('ab', 5)).toBe('ab   ');
    expect(padRight('abcdef', 3)).toBe('ab…'); // over-length pads via truncate
  });
});

/* ====================================================================== */
/*  src/tui/util/tabular                                                 */
/* ====================================================================== */

describe('dashboard-core baseline: tabular detection', () => {
  it('isPlainObject accepts literals / null-proto and rejects arrays and null', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
  });

  it('detectTabularResult recognizes top-level arrays and single array fields', () => {
    const top = detectTabularResult(tabularSamples.topLevelArray);
    expect(top).not.toBeNull();
    expect(top!.fieldName).toBe('rows');
    expect(top!.rows).toHaveLength(2);

    const single = detectTabularResult(tabularSamples.singleArrayField);
    expect(single).not.toBeNull();
    expect(single!.fieldName).toBe('rows');
  });

  it('detectTabularResult returns null for ambiguous / empty / keyless / scalar inputs', () => {
    expect(detectTabularResult(tabularSamples.multipleArrayFields)).toBeNull();
    expect(detectTabularResult(tabularSamples.noCommonKeys)).toBeNull();
    expect(detectTabularResult(tabularSamples.emptyArray)).toBeNull();
    expect(detectTabularResult(tabularSamples.scalar)).toBeNull();
  });
});

/* ====================================================================== */
/*  src/tui/util — status / effort / runtime / model abbreviations       */
/* ====================================================================== */

describe('dashboard-core baseline: abbreviation tables', () => {
  it('abbrevStatus maps known values, passes through unknowns, — for empty', () => {
    expect(abbrevStatus('running')).toBe('run');
    expect(abbrevStatus('offline')).toBe('off');
    expect(abbrevStatus('brand-new-status')).toBe('brand-new-status');
    expect(abbrevStatus(undefined)).toBe('—');
  });

  it('abbrevHealth maps only non-online health labels', () => {
    expect(abbrevHealth('offline')).toBe('off');
    expect(abbrevHealth('online')).toBe('online'); // intentionally absent from table
    expect(abbrevHealth(undefined)).toBe('—');
  });

  it('abbrevEffort maps the four codex tiers', () => {
    expect(abbrevEffort('high')).toBe('hi');
    expect(abbrevEffort('medium')).toBe('med');
    expect(abbrevEffort('low')).toBe('lo');
    expect(abbrevEffort('xhigh')).toBe('xhi');
    expect(abbrevEffort(undefined)).toBe('—');
    expect(abbrevEffort('ultra')).toBe('ultra');
  });

  it('abbrevRuntime and abbrevModel map known values and pass through the rest', () => {
    expect(abbrevRuntime('claude-code-cli')).toBe('claude');
    expect(abbrevRuntime('codex')).toBe('codex');
    expect(abbrevRuntime(undefined)).toBe('—');
    expect(abbrevModel('claude-opus-4-8')).toBe('opus-4.8');
    expect(abbrevModel('gpt-5.6-terra')).toBe('g5.6-ter');
    expect(abbrevModel('some-unlisted-model')).toBe('some-unlisted-model');
    expect(abbrevModel(undefined)).toBe('—');
  });
});

/* ====================================================================== */
/*  src/tui/util/colors                                                  */
/* ====================================================================== */

describe('dashboard-core baseline: color / glyph classification', () => {
  it('statusColor and healthColor/healthDot classify by state', () => {
    expect(statusColor('running')).toBe('green');
    expect(statusColor('offline')).toBe('red');
    expect(statusColor('starting')).toBe('yellow');
    expect(statusColor('anything-else')).toBe('gray');
    expect(healthColor('online')).toBe('green');
    expect(healthColor('unstable')).toBe('yellow');
    expect(healthColor('offline')).toBe('red');
    expect(healthColor('registered')).toBe('gray');
    expect(healthDot('online')).toBe('●');
    expect(healthDot('offline')).toBe('○');
    expect(healthDot('registered')).toBe('○');
  });

  it('taskStatus color/glyph and newsAgeColor bands are stable', () => {
    expect(taskStatusColor('todo')).toBe('yellow');
    expect(taskStatusColor('doing')).toBe('green');
    expect(taskStatusColor('done')).toBe('gray');
    expect(taskStatusGlyph('done')).toBe('●');
    expect(taskStatusGlyph('todo')).toBe('○');
    expect(taskStatusGlyph('other')).toBe('·');
    expect(newsAgeColor(1000, 1000)).toBe('greenBright');
    expect(newsAgeColor(0, 120_000)).toBe('green');
    expect(newsAgeColor(0, 600_000)).toBe('yellow');
    expect(newsAgeColor(0, 1_000_000)).toBe('gray');
  });
});

/* ====================================================================== */
/*  src/tui/util/schedule — schedule math                                */
/* ====================================================================== */

describe('dashboard-core baseline: schedule calculations', () => {
  const hb = schedules.heartbeat as Schedule;
  const hbOff = schedules.heartbeatInactive as Schedule;
  const daily = schedules.calendarDaily as Schedule;
  const once = schedules.calendarOnce as Schedule;

  it('formatInterval bands seconds/minutes/hours/days with fractional labels', () => {
    expect(formatInterval(30)).toBe('30s');
    expect(formatInterval(90)).toBe('2m'); // Math.round(1.5) === 2
    expect(formatInterval(3600)).toBe('1h');
    expect(formatInterval(5400)).toBe('1.5h');
    expect(formatInterval(86_400)).toBe('1d');
    expect(formatInterval(129_600)).toBe('1.5d');
  });

  it('cadenceLabel describes heartbeat and calendar schedules', () => {
    expect(cadenceLabel(hb)).toBe('every 1h');
    expect(cadenceLabel(daily)).toBe('daily 09:00');
    expect(cadenceLabel(once)).toBe('2030-01-01 01:00');
  });

  it('formatLocalTime is pure HH:MM from seconds-of-day', () => {
    expect(formatLocalTime(0)).toBe('00:00');
    expect(formatLocalTime(32_400)).toBe('09:00');
    expect(formatLocalTime(3661)).toBe('01:01');
  });

  it('nextFireSec advances a heartbeat by one interval past its anchor', () => {
    // anchor createdAt=1000, interval=3600, now=1000 → next = 1000 + 3600.
    expect(nextFireSec(hb, 1000)).toBe(4600);
    expect(nextFireSec(hbOff, 1000)).toBeNull(); // inactive
  });

  it('nextFireSec resolves calendar fires at the correct UTC instant', () => {
    // Daily @ 09:00 UTC, probing from that day's UTC midnight → same day 09:00.
    const dayMidnight = Math.floor(Date.UTC(2027, 5, 15, 0, 0, 0) / 1000);
    expect(nextFireSec(daily, dayMidnight)).toBe(Math.floor(Date.UTC(2027, 5, 15, 9, 0, 0) / 1000));

    // One-off 2030-01-01 01:00 UTC, probed from two days before (within the
    // 35-day calendar look-ahead window).
    const fire = Math.floor(Date.UTC(2030, 0, 1, 1, 0, 0) / 1000);
    expect(nextFireSec(once, fire - 2 * 86_400)).toBe(fire);
  });

  it('nextFireSec returns null when a one-off is beyond the 35-day look-ahead', () => {
    expect(nextFireSec(once, 1_000_000)).toBeNull();
  });

  it('formatNextFire produces a fixed 11-char countdown + HH:MM cell', () => {
    const now = Math.floor(Date.UTC(2027, 5, 15, 12, 0, 0) / 1000);
    const past = formatNextFire(now - 10, now);
    expect(past.length).toBe(11);
    expect(past.startsWith('  now ')).toBe(true);

    const soon = formatNextFire(now + 120, now);
    expect(soon.length).toBe(11);
    expect(soon.startsWith('   2m ')).toBe(true);
  });
});

describe('dashboard-core baseline: agent bio + handles (additive, Phase 2)', () => {
  it('parseAgent preserves optional bio and handles when present', () => {
    const agent = parseAgent({
      id: 'a1',
      name: 'seniordev',
      bio: 'Lead engineer for the desktop app.',
      handles: { github: 'https://github.com/nxt3d', site: 'https://example.com' },
    });
    expect(agent.bio).toBe('Lead engineer for the desktop app.');
    expect(agent.handles).toEqual({
      github: 'https://github.com/nxt3d',
      site: 'https://example.com',
    });
  });

  it('parseAgent tolerates identity-only rows (bio/handles absent)', () => {
    const agent = parseAgent({ id: 'a2', name: 'x-ray' });
    expect(agent.bio).toBeUndefined();
    expect(agent.handles).toBeUndefined();
  });

  it('parseAgent rejects a present bio/handles of the wrong type', () => {
    expect(() => parseAgent({ id: 'a3', name: 'z', bio: 123 })).toThrow();
    expect(() => parseAgent({ id: 'a4', name: 'z', handles: 'not-an-object' })).toThrow();
  });
});
