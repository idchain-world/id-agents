// SPDX-License-Identifier: MIT
/**
 * Tests for the renderer-neutral command POLICY layer extracted in commit 4.
 * These exercise the catalog / parser / completion / confirmation directly from
 * dashboard-core, independent of any TUI execution adapter.
 */

import { describe, expect, it } from 'vitest';
import {
  COMMAND_POLICIES,
  catalogEntriesByTier,
  lookupPolicy,
  policyNames,
} from '../../src/dashboard-core/commands/catalog.js';
import { parseCommandLine } from '../../src/dashboard-core/commands/parser.js';
import { completeBuffer, completeCommand } from '../../src/dashboard-core/commands/completion.js';
import {
  commandConfirmPreview,
  confirmationLevel,
} from '../../src/dashboard-core/commands/confirmation.js';

describe('command catalog', () => {
  it('exposes the frozen, sorted command set', () => {
    expect(policyNames()).toEqual([
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
  });

  it('carries no execution — policies have no run function', () => {
    for (const name of policyNames()) {
      expect('run' in (COMMAND_POLICIES[name] as object)).toBe(false);
    }
  });

  it('groups by tier with help pinned first in safe', () => {
    const byTier = catalogEntriesByTier();
    expect(byTier.safe[0]!.name).toBe('help');
    expect(byTier.powerful.map((p) => p.name)).toContain('deploy');
    expect(byTier.destructive.map((p) => p.name)).toContain('delete');
    for (const tier of ['safe', 'powerful', 'destructive'] as const) {
      expect(byTier[tier].every((p) => p.tier === tier)).toBe(true);
    }
  });
});

describe('command parser', () => {
  it('strips sigils, trims, splits; null on empty', () => {
    expect(parseCommandLine('/task done x')).toEqual({ name: 'task', args: ['done', 'x'] });
    expect(parseCommandLine(':help')).toEqual({ name: 'help', args: [] });
    expect(parseCommandLine('   ')).toBeNull();
  });
});

describe('command completion', () => {
  it('completes a unique prefix and advances to the common prefix', () => {
    expect(completeCommand(':hel')).toBe(':help ');
    expect(completeCommand(':te')).toBe(':team');
    expect(completeCommand(':he')).toBeNull();
  });

  it('completes an arg slot from the policy argCompleter', () => {
    const ctx = { agentNames: ['coder', 'bisor'], teamNames: [] };
    expect(completeBuffer(':meta co', ctx)).toBe(':meta coder ');
    expect(completeBuffer(':task ', ctx)).toBeNull(); // no argCompleter on task
  });
});

describe('confirmation gating', () => {
  const task = lookupPolicy('task')!;
  const sync = lookupPolicy('sync')!;
  const help = lookupPolicy('help')!;

  it('classifies task mutators / bulk delete / safe reads', () => {
    expect(confirmationLevel(task, ['done', 'x'])).toBe('yn');
    expect(confirmationLevel(task, ['delete', 'abc'])).toBe('yn');
    expect(confirmationLevel(task, ['delete', '*'])).toBe('retype');
    expect(confirmationLevel(task, ['list'])).toBe('none');
    // /sync is REMOVED (commit 9, D2). It stays REGISTERED so it still
    // tab-completes and can explain itself, but it mutates nothing, so it is
    // 'safe' with no confirmation and no preview. Was 'yn' / 'sync team: idchain'.
    expect(confirmationLevel(sync, ['idchain'])).toBe('none');
    expect(confirmationLevel(help, [])).toBe('none');
  });

  it('renders the frozen preview strings', () => {
    expect(commandConfirmPreview(task, ['delete', '*'])).toBe('DELETE ALL tasks in the active team');
    expect(commandConfirmPreview(task, ['status', 't1', 'done'])).toBe('set task t1 to done');
    // No preview: a command that only prints guidance has nothing to preview.
    expect(commandConfirmPreview(sync, ['idchain'])).toBeNull();
    expect(commandConfirmPreview(help, [])).toBeNull();
  });
});
