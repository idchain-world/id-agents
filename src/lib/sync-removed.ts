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

/**
 * How to change a LIVE team, in the words of commands that actually exist.
 *
 * Verified against the code, because this is the sentence that got it wrong
 * last time:
 *   - `/model <agent> <model>`  agent-manager-db.ts, case 'model'
 *   - `/delete <agent>`         agent-manager-db.ts, case 'delete'
 *   - `id-agents spawn <name>`  id-agents-cli.ts, case 'spawn'
 *   - `POST /agents/spawn`      the HTTP route, which also takes a library
 *                               `agent` overlay the CLI cannot express
 *
 * Shared so the 409 refusal and the /sync removal notice cannot drift into
 * saying different things — the drift is how the dead syntax spread to eleven
 * surfaces in the first place.
 */
export const LIVE_TEAM_CHANGE_HINT =
  'To change a live team use /model <agent> <model>, /delete <agent>, or ' +
  '`id-agents spawn <name> [model]` (POST /agents/spawn over HTTP) to add one.';

/**
 * What to say when someone runs the removed command.
 *
 * EVERY COMMAND NAMED HERE MUST EXIST (#6bcd3201). The first version of this
 * message pointed at `/agents spawn` and `/agents remove`, which have no
 * handler — `/agents` dispatches only start|stop|rebuild|save|reset|probe. A
 * removal notice that replaces one dead command with two more is worse than no
 * notice at all, and an agent following it autonomously has no way to tell.
 */
export const SYNC_REMOVED_MESSAGE =
  '/sync has been removed. The database is the source of truth; config files are ' +
  'import/export artifacts. Use /diff <team> <config> to inspect drift without ' +
  'changing anything, /model <agent> <model> to change a model, /delete <agent> to ' +
  'remove one, `id-agents spawn <name> [model]` or POST /agents/spawn to add one, ' +
  '/export <team> [path] to write a config from the database, and ' +
  '/import <file> [--team <name>] to create a new team from one.';

/**
 * Catalog/help text. Says REMOVED first so the truth survives truncation in a
 * narrow completion popup — the old description ("Sync team against YAML")
 * now actively lies, which is worse than saying nothing.
 */
export const SYNC_REMOVED_DESCRIPTION =
  'REMOVED — use `/diff` for drift, `/model` and `/delete` for live changes';
