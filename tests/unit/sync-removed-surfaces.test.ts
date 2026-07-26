// SPDX-License-Identifier: MIT
/**
 * /sync stays DISCOVERABLE but tells the truth — SPEC §9.3, commit 10.
 *
 * Commit 9 removed the manager handler, but the TUI still routed /sync and the
 * dashboard-core catalog still advertised it as "Sync team against YAML" — a
 * description that had become a lie while remaining tab-completable.
 *
 * The requirement is NOT deletion. Deleting the catalog entry would make /sync
 * silently unknown, which is precisely the outcome that sends someone hunting
 * for a bug. It stays registered, stays completable, and every surface explains
 * where the capability went.
 */

import { describe, expect, it } from 'vitest';

import fs from 'fs';

import {
  LIVE_TEAM_CHANGE_HINT,
  SYNC_REMOVED_DESCRIPTION,
  SYNC_REMOVED_MESSAGE,
} from '../../src/lib/sync-removed.js';
import { COMMAND_POLICIES } from '../../src/dashboard-core/commands/catalog.js';

/**
 * The `/agents` subcommands that actually dispatch, read from the source rather
 * than transcribed — a hand-copied list is how the wrong one spread.
 * `interactive-agent-cli.ts` holds the only allow-list:
 *   if (!['start','stop','rebuild','save','reset','probe'].includes(action))
 */
function realAgentsSubcommands(): string[] {
  const source = fs.readFileSync(
    new URL('../../src/interactive-agent-cli.ts', import.meta.url), 'utf8',
  );
  const match = source.match(/\[((?:\s*'(?:start|stop|rebuild|save|reset|probe)',?)+)\]\s*\.includes\(action\)/);
  if (!match) throw new Error('could not locate the /agents subcommand allow-list');
  return [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
}

describe('the removal notice names every replacement', () => {
  it('points at each surviving command', () => {
    for (const replacement of ['/diff', '/model', '/delete', 'id-agents spawn', '/export', '/import']) {
      expect(SYNC_REMOVED_MESSAGE).toContain(replacement);
    }
  });

  it('says WHY, not just what to type instead', () => {
    expect(SYNC_REMOVED_MESSAGE).toContain('source of truth');
    expect(SYNC_REMOVED_MESSAGE).toContain('has been removed');
  });

  /**
   * THE GUARD FOR #6bcd3201. The first version of this notice replaced one dead
   * command with two more: it pointed at `/agents spawn` and `/agents remove`,
   * neither of which has a handler, and that syntax then spread to eleven
   * surfaces including the admin skill an agent follows autonomously.
   *
   * Naming a command that does not exist is worse than saying nothing — the
   * reader burns a cycle discovering it, and an agent cannot discover it at all.
   * So: every `/agents <sub>` this text mentions must be a real subcommand.
   */
  it('names only /agents subcommands that actually dispatch', () => {
    const real = realAgentsSubcommands();
    expect(real).toContain('rebuild'); // sanity: the extraction found something

    for (const text of [SYNC_REMOVED_MESSAGE, SYNC_REMOVED_DESCRIPTION, LIVE_TEAM_CHANGE_HINT]) {
      const named = [...text.matchAll(/\/agents\s+([a-z]+)/g)].map((m) => m[1]);
      const dead = named.filter((sub) => !real.includes(sub));
      expect(dead).toEqual([]);
    }
  });

  it('does not resurrect the specific dead syntax', () => {
    for (const text of [SYNC_REMOVED_MESSAGE, SYNC_REMOVED_DESCRIPTION, LIVE_TEAM_CHANGE_HINT]) {
      expect(text).not.toContain('/agents spawn');
      expect(text).not.toContain('/agents remove');
    }
  });

  it('the live-team hint names the real add/remove/model surfaces', () => {
    // POST /agents/spawn is a ROUTE, not an /agents subcommand — the slash is
    // part of the path, which is exactly why the two got confused.
    expect(LIVE_TEAM_CHANGE_HINT).toContain('/model <agent> <model>');
    expect(LIVE_TEAM_CHANGE_HINT).toContain('/delete <agent>');
    expect(LIVE_TEAM_CHANGE_HINT).toContain('id-agents spawn <name>');
    expect(LIVE_TEAM_CHANGE_HINT).toContain('POST /agents/spawn');
  });

  it('leads the short description with REMOVED so truncation cannot hide it', () => {
    // A narrow completion popup clips the tail. If the first word is not
    // REMOVED, a clipped description reads like a working command.
    expect(SYNC_REMOVED_DESCRIPTION.startsWith('REMOVED')).toBe(true);
    expect(SYNC_REMOVED_DESCRIPTION).toContain('/diff');
  });
});

describe('dashboard-core catalog (tab completion + help)', () => {
  const sync = COMMAND_POLICIES.sync;

  it('still registers sync, so it remains discoverable', () => {
    // Deleting the entry is the tempting move and the wrong one.
    expect(sync).toBeTruthy();
    expect(sync!.name).toBe('sync');
  });

  it('no longer advertises it as a working reconcile command', () => {
    expect(sync!.description).toBe(SYNC_REMOVED_DESCRIPTION);
    expect(sync!.description).not.toMatch(/Sync team against YAML/i);
  });

  it('does not ask for confirmation — there is nothing to confirm', () => {
    expect(sync!.shouldConfirm?.([])).toBe(false);
    expect(sync!.tier).toBe('safe'); // no longer 'powerful': it mutates nothing
  });
});
