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

import { SYNC_REMOVED_DESCRIPTION, SYNC_REMOVED_MESSAGE } from '../../src/lib/sync-removed.js';
import { COMMAND_POLICIES } from '../../src/dashboard-core/commands/catalog.js';

describe('the removal notice names every replacement', () => {
  it('points at each surviving command', () => {
    for (const replacement of ['/diff', '/agents spawn', '/agents remove', '/model', '/export', '/import']) {
      expect(SYNC_REMOVED_MESSAGE).toContain(replacement);
    }
  });

  it('says WHY, not just what to type instead', () => {
    expect(SYNC_REMOVED_MESSAGE).toContain('source of truth');
    expect(SYNC_REMOVED_MESSAGE).toContain('has been removed');
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
