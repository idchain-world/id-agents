// SPDX-License-Identifier: MIT
/**
 * /deploy is create-only — SPEC §4 refusal contract (commit 4, D1).
 *
 * The contract has two halves and both matter:
 *   - a collision returns 409 with the exact error body, and
 *   - it mutates NOTHING: no rows, no ids, no metadata, no files.
 *
 * The second half is the one worth testing hard. A refusal that returns the
 * right status after already having written a file or deleted a row is not a
 * refusal, and only a before/after comparison catches that.
 *
 * Fixtures only. In-memory SQLite; the live DB on :4100 is never touched and
 * the manager is never restarted.
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
import { LIVE_TEAM_CHANGE_HINT } from '../../src/lib/sync-removed.js';
import { permitTmpWorkdirs } from '../helpers/permit-tmp-workdirs.js';

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

const TEAM = 'create-only-team';

describe('/deploy refusal contract (§4)', () => {
  // #4d78adbc: fixtures live under os.tmpdir(), which containment rejects.
  // Declare it the same way an operator would, so this suite keeps testing
  // what it is about rather than the working-directory guard.
  permitTmpWorkdirs();
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let configDir: string;
  let yamlPath: string;

  function writeConfig(team: string, agentName = 'beta', extraDir?: string): string {
    const agentDir = extraDir ?? path.join(configDir, `${agentName}-workdir`);
    fs.mkdirSync(agentDir, { recursive: true });
    // Filename keyed by AGENT, not team: two configs for the same team must be
    // DIFFERENT files, or last_config_path is identical either way and cannot
    // detect a check that ran after updateConfig.
    const p = path.join(configDir, `${team}-${agentName}.yaml`);
    fs.writeFileSync(p, `version: "1"
team: ${team}

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-haiku-4-5-20251001

agents:
  - name: ${agentName}
    description: "deploy target"
    workingDirectory: ${agentDir}
`);
    return p;
  }

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-co-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-cfg-'));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    (manager as any).spawnLocalAgentProcess = async () => ({ success: true, pid: 4242, logFile: '/tmp/deploy-co.log' });
    (manager as any).deploySkillsToAgent = () => undefined;
    (manager as any).copyPluginsToAgent = () => [];
    (manager as any).ensureRuntimeReady = () => undefined;
    await manager.start(port);

    yamlPath = writeConfig(TEAM);
  });

  afterEach(async () => {
    await manager.shutdown().catch(() => {});
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 400);
    });
    await db.close();
    for (const d of [workDir, configDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  async function deploy(configPath = yamlPath) {
    const resp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM, 'X-Id-Admin': '1' },
      body: JSON.stringify({ command: `/deploy ${configPath}` }),
    });
    return { status: resp.status, body: await resp.json() as any };
  }

  /** A comparable snapshot of everything a refusal must leave untouched. */
  async function snapshot() {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const rows = await db.agents.listAll(teamId);
    return rows
      .map((r) => JSON.stringify({ id: r.id, name: r.name, metadata: r.metadata }))
      .sort();
  }

  it('deploys a brand-new team exactly as before', async () => {
    const { status, body } = await deploy();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const rows = await db.agents.listAll(teamId);
    expect(rows.map((r) => r.name)).toContain('beta');
  });

  it('refuses a second deploy onto the same team with 409 and the §4 body', async () => {
    expect((await deploy()).body.ok).toBe(true);

    const { status, body } = await deploy();
    expect(status).toBe(409);
    expect(body.error).toBe('team_exists');
    expect(body.message).toBe(
      `Team "${TEAM}" already exists. /deploy only creates new teams. ${LIVE_TEAM_CHANGE_HINT} ` +
      `To inspect drift, /diff <team> <config>.`,
    );
  });

  it('mutates NOTHING on refusal — count, every id and every metadata identical', async () => {
    expect((await deploy()).body.ok).toBe(true);
    const before = await snapshot();
    expect(before.length).toBeGreaterThan(0);

    const { status } = await deploy();
    expect(status).toBe(409);

    const after = await snapshot();
    // Byte-identical, not merely "same length" — the old recreate block would
    // have deleted the row and inserted a new one with a fresh id, which a
    // count-only assertion would have missed entirely.
    expect(after).toEqual(before);
  });

  it('refuses BEFORE writing anything to the agent working directory', async () => {
    expect((await deploy()).body.ok).toBe(true);

    // Point the second deploy at a working directory that does not exist yet.
    // If the refusal came after any filesystem work, this would be created.
    const untouched = path.join(configDir, 'must-not-be-created');
    const secondConfig = writeConfig(TEAM, 'gamma', untouched);
    fs.rmSync(untouched, { recursive: true, force: true });
    expect(fs.existsSync(untouched)).toBe(false);

    // last_config_path must also be untouched: updateConfig runs BEFORE the
    // agent loop, so a check placed even slightly too late would rewrite it
    // while still leaving the agent working directory alone.
    const teamIdBefore = await db.teams.getOrCreateTeamId(TEAM);
    const configBefore = await db.teams.getConfig(teamIdBefore);

    const { status } = await deploy(secondConfig);
    expect(status).toBe(409);
    expect(fs.existsSync(untouched)).toBe(false);
    expect((await db.teams.getConfig(teamIdBefore)).last_config_path).toBe(configBefore.last_config_path);

    // And no agent named gamma was created anywhere.
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const rows = await db.agents.listAll(teamId);
    expect(rows.map((r) => r.name)).not.toContain('gamma');
  });

  it('offers no override flag — D1 admits no exception', async () => {
    expect((await deploy()).body.ok).toBe(true);
    for (const flag of ['--force', '--overwrite', '--replace']) {
      const resp = await fetch(`${baseUrl}/remote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM, 'X-Id-Admin': '1' },
        body: JSON.stringify({ command: `/deploy ${yamlPath} ${flag}` }),
      });
      expect(resp.status).toBe(409);
    }
  });
});
