// SPDX-License-Identifier: MIT
/**
 * /sync is REMOVED — SPEC §9 (D2), commit 9.
 *
 * This file used to exercise the /sync reconciliation command. That command no
 * longer exists: the diff-driven mutation and the YAML-as-floor merge are
 * deleted outright rather than hidden behind a flag, because a config file is
 * no longer a source of truth that may overwrite the database.
 *
 * MIGRATED, NOT DELETED. What the old suite asserted, and where that coverage
 * lives now:
 *
 *   'show plan without making changes'      -> /diff, tests/integration/diff-read-only.test.ts
 *                                              (and its five-part no-mutation test)
 *   'skip unchanged agents'                 -> /diff `unchanged`, same file
 *   'preserve agent ID on in-place update'  -> in-place update is GONE (D1). The
 *                                              surviving guarantee — a refused
 *                                              deploy leaves every id
 *                                              byte-identical — is in
 *                                              deploy-create-only.test.ts
 *   'repeated syncs of unchanged skills'    -> skill deployment via
 *                                              deploySkillsToAgent is asserted in
 *                                              spawn-parity.test.ts
 *   'reconcile running team with config'    -> CAPABILITY REMOVED by D2. Its
 *                                              replacement is /export + /import
 *                                              (round-trip coverage in
 *                                              import-team-config.test.ts and
 *                                              roundtrip-every-config-key.test.ts)
 *   'kill old process when redeploying'     -> CAPABILITY REMOVED by D1 §4.1;
 *                                              the recreate block was deleted in
 *                                              commit 4
 *
 * WORTH KNOWING: the old suite was `describe.skipIf(!process.env.ID_CONTROL_API_KEY)`
 * and that variable is not set here, so it had been SKIPPING — it contributed no
 * actual coverage at the point it was removed. The tests below deliberately have
 * no such gate: they run everywhere, on fixtures.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as net from 'net';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';

async function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    events: new SqliteEventsRepo(adapter),
    subscriptions: new SqliteSubscriptionsRepo(adapter),
    checkins: new SqliteCheckinsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

const TEAM = 'sync-removed-team';

describe('/sync removal contract (§9, D2)', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-gone-')));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    await db.teams.getOrCreateTeamId(TEAM);
  });

  afterEach(async () => {
    await manager.shutdown().catch(() => {});
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 300);
    });
    await db.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function run(command: string) {
    const resp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM, 'X-Id-Admin': '1' },
      body: JSON.stringify({ command }),
    });
    return { status: resp.status, body: await resp.json() as any };
  }

  it('rejects /sync', async () => {
    expect((await run('/sync some-config')).body.ok).toBe(false);
  });

  it('NAMES every replacement in the error, so nobody hunts for a bug', async () => {
    // §10.11. The value of this message is that /sync lives in muscle memory
    // and in skill files; a bare "unknown command" would read like a break.
    const error = String((await run('/sync')).body.error);

    expect(error).toContain('/sync has been removed');
    expect(error).toContain('/export');
    expect(error).toContain('/import');
    expect(error).toContain('/diff');
    expect(error).toContain('/model');
    expect(error).toContain('id-agents spawn');
    // And it says WHY, not just what to type instead.
    expect(error).toContain('source of truth');
  });

  it('rejects /sync with arguments too, not just the bare form', async () => {
    for (const variant of ['/sync', '/sync idchain', '/sync configs/team.yaml --dry-run']) {
      const { body } = await run(variant);
      expect(body.ok).toBe(false);
      expect(String(body.error)).toContain('/sync has been removed');
    }
  });

  it('leaves a genuinely unknown command with the ordinary error', async () => {
    // The sync branch must be specific to sync, not swallow every unknown verb.
    const error = String((await run('/floopdedoop')).body.error);
    expect(error).toContain('Unknown command: floopdedoop');
    expect(error).not.toContain('/sync has been removed');
  });

  it('advertises the replacements in the available-command list', async () => {
    const error = String((await run('/floopdedoop')).body.error);
    for (const verb of ['export', 'import', 'diff']) expect(error).toContain(verb);
  });

  it('mutates nothing when /sync is attempted against a live team', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    await db.agents.create({
      team_id: teamId, id: 'local_keep', name: 'keep', type: 'claude',
      model: 'claude-haiku-4-5-20251001', status: 'running', created_at: Date.now(),
      runtime: 'claude-code-cli', metadata: { description: 'must survive' },
    } as any);

    const snapshot = async () =>
      (await db.agents.listAll(teamId))
        .map((r) => JSON.stringify({ id: r.id, name: r.name, metadata: r.metadata }))
        .sort();

    const before = await snapshot();
    await run('/sync anything');
    // The old /sync could delete and recreate rows; the removed command must
    // retain no residue of that behaviour.
    expect(await snapshot()).toEqual(before);
  });
});
