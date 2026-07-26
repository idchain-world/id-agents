// SPDX-License-Identifier: MIT
/**
 * `/diff <team> <config>` — SPEC §8 (D6), commit 8.
 *
 * /diff is what survives the removal of /sync: reconciliation still needs
 * somewhere to SEE drift, it just no longer gets to act on it.
 *
 * So the load-bearing test here is not "does it report drift correctly" — it is
 * "does it change NOTHING". A diff that reports perfectly and quietly writes
 * last_config_path, or rebuilds an agent, is the mutating /sync wearing a new
 * name, which is exactly what D2 removes.
 *
 * Fixtures only; live DB on :4100 never touched.
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

const TEAM = 'diff-team';

describe('/diff (§8, D6) — read-only drift inspection', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let configDir: string;

  /** Writes a config listing exactly `agents`, each with the given model. */
  function writeConfig(name: string, agents: Array<{ name: string; model?: string; description?: string }>): string {
    const body = agents
      .map((a) => {
        const dir = path.join(configDir, `${a.name}-wd`);
        fs.mkdirSync(dir, { recursive: true });
        return `  - name: ${a.name}
    description: "${a.description ?? 'baseline'}"
    model: ${a.model ?? 'claude-haiku-4-5-20251001'}
    workingDirectory: ${dir}`;
      })
      .join('\n');
    const p = path.join(configDir, `${name}.yaml`);
    fs.writeFileSync(p, `version: "1"\nteam: ${TEAM}\n\nagents:\n${body}\n`);
    return p;
  }

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diff-wd-')));
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diff-cfg-')));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    (manager as any).spawnLocalAgentProcess = async () => ({ success: true, pid: 3, logFile: '/tmp/x.log' });
    (manager as any).deploySkillsToAgent = () => undefined;
    (manager as any).copyPluginsToAgent = () => [];
    (manager as any).ensureRuntimeReady = () => undefined;
    await manager.start(port);

    // Seed a live team: alpha + beta.
    const baseline = writeConfig('baseline', [{ name: 'alpha' }, { name: 'beta' }]);
    const deployed = await run(`/deploy ${baseline}`);
    expect(deployed.body.ok).toBe(true);
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
    return { status: resp.status, body: await resp.json() as any };
  }

  const names = (items: Array<{ name: string }>) => items.map((i) => i.name).sort();

  it('reports added, removed, changed and unchanged against a drifted config', async () => {
    // alpha: model changed. beta: dropped. gamma: new.
    const drifted = writeConfig('drifted', [
      { name: 'alpha', model: 'claude-opus-5' },
      { name: 'gamma' },
    ]);

    const { body } = await run(`/diff ${TEAM} ${drifted}`);
    expect(body.ok).toBe(true);

    expect(names(body.result.added)).toEqual(['gamma']);
    expect(names(body.result.removed)).toEqual(['beta']);
    expect(names(body.result.changed)).toEqual(['alpha']);
    expect(names(body.result.unchanged)).toEqual([]);
  });

  it('names the fields that changed, not just the agent', async () => {
    const drifted = writeConfig('fields', [
      { name: 'alpha', model: 'claude-opus-5', description: 'rewritten' },
      { name: 'beta' },
    ]);

    const { body } = await run(`/diff ${TEAM} ${drifted}`);
    const alpha = (body.result.changed as Array<{ name: string; changes?: string[] }>)
      .find((c) => c.name === 'alpha');
    expect(alpha?.changes).toBeTruthy();
    expect(alpha!.changes).toContain('model');
    expect(alpha!.changes).toContain('description');
  });

  it('reports everything unchanged when the config matches the live team', async () => {
    const same = writeConfig('same', [{ name: 'alpha' }, { name: 'beta' }]);
    const { body } = await run(`/diff ${TEAM} ${same}`);
    expect(names(body.result.unchanged)).toEqual(['alpha', 'beta']);
    expect(body.result.added).toEqual([]);
    expect(body.result.removed).toEqual([]);
    expect(body.result.changed).toEqual([]);
  });

  it('MUTATES NOTHING — rows byte-identical, and last_config_path untouched', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const snapshot = async () =>
      (await db.agents.listAll(teamId))
        .map((r) => JSON.stringify({
          id: r.id, name: r.name, model: r.model, status: r.status,
          working_directory: r.working_directory, metadata: r.metadata,
        }))
        .sort();

    // Point last_config_path somewhere recognisable: /sync rewrites this before
    // planning, so if /diff inherited that behaviour it would show up here.
    const sentinel = path.join(configDir, 'sentinel-not-rewritten.yaml');
    await db.teams.updateConfig(teamId, { last_config_path: sentinel });

    const before = await snapshot();
    const beforeConfig = await db.teams.getConfig(teamId);
    expect(before.length).toBe(2);

    const drifted = writeConfig('nomutate', [
      { name: 'alpha', model: 'claude-opus-5' },
      { name: 'gamma' },
    ]);
    // Run it twice: a mutation that is idempotent would still be a mutation.
    expect((await run(`/diff ${TEAM} ${drifted}`)).body.ok).toBe(true);
    expect((await run(`/diff ${TEAM} ${drifted}`)).body.ok).toBe(true);

    expect(await snapshot()).toEqual(before);
    const afterConfig = await db.teams.getConfig(teamId);
    expect(afterConfig.last_config_path).toBe(sentinel);
    expect(afterConfig).toEqual(beforeConfig);

    // The reported-added agent was never actually created.
    expect((await db.agents.listAll(teamId)).map((r) => r.name)).not.toContain('gamma');
  });

  it('writes no file for the config it inspected', async () => {
    const drifted = writeConfig('nofiles', [{ name: 'alpha' }]);
    const teamDir = path.join(workDir, 'teams', TEAM);
    const before = fs.existsSync(teamDir) ? fs.readdirSync(teamDir).sort() : [];

    await run(`/diff ${TEAM} ${drifted}`);

    const after = fs.existsSync(teamDir) ? fs.readdirSync(teamDir).sort() : [];
    expect(after).toEqual(before);
  });

  it('errors cleanly on an unknown team and a missing config', async () => {
    const missingTeam = await run(`/diff no-such-team ${writeConfig('x', [{ name: 'alpha' }])}`);
    expect(missingTeam.body.ok).toBe(false);
    expect(String(missingTeam.body.error)).toContain('no-such-team');

    const missingConfig = await run(`/diff ${TEAM} ${path.join(configDir, 'absent.yaml')}`);
    expect(missingConfig.body.ok).toBe(false);
    expect(String(missingConfig.body.error)).toMatch(/Config not found/);

    const noArgs = await run('/diff');
    expect(noArgs.body.ok).toBe(false);
    expect(String(noArgs.body.error)).toMatch(/Usage: \/diff/);
  });

  it('returns human-readable summary and verbose output', async () => {
    const drifted = writeConfig('human', [{ name: 'alpha', model: 'claude-opus-5' }]);
    const { body } = await run(`/diff ${TEAM} ${drifted}`);
    expect(typeof body.result.summary).toBe('string');
    expect(typeof body.result.verbose).toBe('string');
    expect(body.result.verbose).toContain('alpha');
  });
});
