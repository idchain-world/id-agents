// SPDX-License-Identifier: MIT
/**
 * The `/sync` removal notice — SPEC §9 (D2), commit 10.
 *
 * `/sync` is gone, but a user typing it tomorrow is exactly the person who
 * needs to know what replaced it. So the command stays DISCOVERABLE — it is
 * still in the catalog and still tab-completes — and every surface that used to
 * run it now explains where the capability went instead.
 *
 * One definition, imported by every surface: the manager's command handler, the
 * TUI runner, the dashboard-core catalog, and the interactive CLI. The message
 * is user-facing text repeated in four places, which is exactly the sort of
 * thing that drifts until three of them say something slightly different and
 * one of them is wrong.
 *
 * NOT to be confused with `id-agents sync <config>` / `id-agents unsync` in
 * src/cli/workspace-sync.ts. That is the receipt-driven workspace deploy CLI —
 * a different command that shares a name, is not removed, and must not be
 * caught by a name-match sweep.
 */

/** What to say when someone runs the removed command. */
export const SYNC_REMOVED_MESSAGE =
  '/sync has been removed. The database is the source of truth; config files are ' +
  'import/export artifacts. Use /diff <team> <config> to inspect drift without ' +
  'changing anything, /agents spawn and /agents remove (or /model) to change a live ' +
  'team, /export <team> [path] to write a config from the database, and ' +
  '/import <file> [--team <name>] to create a new team from one.';

/**
 * Catalog/help text. Says REMOVED first so the truth survives truncation in a
 * narrow completion popup — the old description ("Sync team against YAML")
 * now actively lies, which is worse than saying nothing.
 */
export const SYNC_REMOVED_DESCRIPTION =
  'REMOVED — use `/diff` for drift, `/agents spawn|remove` and `/model` for live changes';
