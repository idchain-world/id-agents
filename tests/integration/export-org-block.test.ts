// SPDX-License-Identifier: MIT
/**
 * The team `org` block survives to export — commit 6b (#946af687).
 *
 * The bug: nothing ever wrote `org` into the teams config row, so
 * `teamConfig.org` was always undefined and /export emitted no org block for
 * ANY team. Silent, and invisible to a row-level completeness check because it
 * is team-level state, not agent state.
 *
 * The fix is persistence, not file-reading: deploy stores the parsed block on
 * the team row, export reads it from there. Legacy teams — deployed before that
 * existed — fall back to the config file WITH a warning, never silently.
 *
 * Fixtures only; the live DB on :4100 is never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as net from 'net';
import yaml from 'js-yaml';

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

const TEAM = 'org-block-team';

describe('team org block reaches export (#946af687)', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let configDir: string;

  function writeConfig(withOrg: boolean, name = 'team'): string {
    const p = path.join(configDir, `${name}.yaml`);
    const orgBlock = withOrg
      ? `
org:
  groups:
    engineering:
      description: "Builds the thing"
      members: [alpha]
`
      : '';
    fs.writeFileSync(p, `version: "1"
team: ${TEAM}
${orgBlock}
agents:
  - name: alpha
    description: "seed"
    workingDirectory: ${path.join(configDir, 'alpha-wd')}
`);
    fs.mkdirSync(path.join(configDir, 'alpha-wd'), { recursive: true });
    return p;
  }

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-block-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-block-cfg-'));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    (manager as any).spawnLocalAgentProcess = async () => ({ success: true, pid: 5, logFile: '/tmp/x.log' });
    (manager as any).deploySkillsToAgent = () => undefined;
    (manager as any).copyPluginsToAgent = () => [];
    (manager as any).ensureRuntimeReady = () => undefined;
    await manager.start(port);
  });

  afterEach(async () => {
    await manager.shutdown().catch(() => {});
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 300);
    });
    await db.close();
    for (const d of [workDir, configDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  async function run(command: string) {
    const resp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM, 'X-Id-Admin': '1' },
      body: JSON.stringify({ command }),
    });
    return await resp.json() as any;
  }

  it('deploy persists org on the team row, and export emits it from there', async () => {
    expect((await run(`/deploy ${writeConfig(true)}`)).ok).toBe(true);

    // Persisted in the database — the source of truth.
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const stored = (await db.teams.getConfig(teamId)).org as any;
    expect(stored?.groups?.engineering?.members).toEqual(['alpha']);

    const target = path.join(configDir, 'exported.yaml');
    const body = await run(`/export ${TEAM} ${target}`);
    expect(body.ok).toBe(true);

    const doc = yaml.load(fs.readFileSync(target, 'utf-8')) as any;
    expect(doc.org?.groups?.engineering?.members).toEqual(['alpha']);
    // Read from the row, so no legacy warning.
    expect((body.result.warnings as string[]).join('\n')).not.toContain('not stored on the team row');
  });

  it('a LEGACY team (org in the file, not the row) still exports it, WITH a warning', async () => {
    // Reproduce the pre-fix world: config path recorded, org absent from the row.
    const legacyConfig = writeConfig(true, 'legacy');
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    await db.teams.updateConfig(teamId, { last_config_path: legacyConfig });
    expect((await db.teams.getConfig(teamId)).org).toBeUndefined();

    const target = path.join(configDir, 'legacy-out.yaml');
    const body = await run(`/export ${TEAM} ${target}`);
    expect(body.ok).toBe(true);

    // Emitted...
    const doc = yaml.load(fs.readFileSync(target, 'utf-8')) as any;
    expect(doc.org?.groups?.engineering).toBeTruthy();
    // ...and never silently: the warning names the file it had to reach for.
    const warnings = (body.result.warnings as string[]).join('\n');
    expect(warnings).toContain('not stored on the team row');
    expect(warnings).toContain(legacyConfig);
  });

  it('a team with no org anywhere emits no block and no warning', async () => {
    expect((await run(`/deploy ${writeConfig(false)}`)).ok).toBe(true);

    const target = path.join(configDir, 'noorg.yaml');
    const body = await run(`/export ${TEAM} ${target}`);
    const doc = yaml.load(fs.readFileSync(target, 'utf-8')) as any;

    expect(doc.org).toBeUndefined();
    expect((body.result.warnings as string[]).join('\n')).not.toContain('not stored on the team row');
  });

  it('an unreadable recorded config yields no org and no failure', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    await db.teams.updateConfig(teamId, { last_config_path: path.join(configDir, 'gone.yaml') });

    const target = path.join(configDir, 'missing-src.yaml');
    const body = await run(`/export ${TEAM} ${target}`);
    expect(body.ok).toBe(true);
    expect((yaml.load(fs.readFileSync(target, 'utf-8')) as any).org).toBeUndefined();
  });

  it('spawn org context still works when org comes from the row', async () => {
    // The shared reader has to serve spawn too, not just export.
    expect((await run(`/deploy ${writeConfig(true)}`)).ok).toBe(true);

    const calls: Array<Record<string, string>> = [];
    (manager as any).deploySkillsToAgent = (_d: string, _s: string[], vars: Record<string, string>) => { calls.push(vars); };

    const resp = await fetch(`${baseUrl}/agents/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM, 'X-Id-Admin': '1' },
      body: JSON.stringify({ name: 'alpha2', type: 'claude', model: 'claude-haiku-4-5-20251001', skills: ['s'] }),
    });
    expect(resp.status).toBeLessThan(400);

    // `alpha` is the org member, so spawning `alpha` would be the direct case;
    // here we assert the reader reached the row at all by checking a member
    // agent gets context. Spawn a name that IS in the group:
    const resp2 = await fetch(`${baseUrl}/agents/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM, 'X-Id-Admin': '1' },
      body: JSON.stringify({ name: 'alpha', type: 'claude', model: 'claude-haiku-4-5-20251001', skills: ['s'] }),
    });
    expect(resp2.status).toBeLessThan(400);
    expect(calls.at(-1)?.ORG_CONTEXT).toContain('engineering');
  });
});
