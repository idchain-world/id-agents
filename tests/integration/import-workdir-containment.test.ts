// SPDX-License-Identifier: MIT
/**
 * File-borne working-directory containment (#4d78adbc).
 *
 * `/import` delegates to the deploy create path, which took
 * `agentConfig.workingDirectory` verbatim when absolute, mkdir'd it, wrote
 * CLAUDE.md into it, copied skills and plugins there and rooted an agent
 * process on it. Commit 7 made a CONFIG FILE an execution surface, so the
 * commit-5 spawn finding came back through a vector nobody had guarded.
 *
 * THE LOAD-BEARING TEST IS "a path under the projects root is ACCEPTED".
 * Containment measured against the live fleet rejects 34 of 38 distinct
 * working directories with roots as configured today, so shipping the guard
 * without a root set that covers reality would 400 every real deploy — a worse
 * regression than the one being closed. A guard people must switch off to get
 * work done is a guard that gets switched off.
 *
 * Fixtures only: in-memory SQLite, stubbed spawn/wallet, temp dirs, and the
 * roots pinned via env so the suite never depends on the host's ~/projects.
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

const TEAM = 'contain-team';

describe('deploy/import workingDirectory containment (#4d78adbc)', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let configDir: string;
  let projectsDir: string;
  let outsideDir: string;
  const savedEnv = {
    projects: process.env.ID_PROJECTS_ROOT,
    extra: process.env.ID_ALLOWED_WORKDIR_ROOTS,
    ws: process.env.ID_WORKSPACE_DIR,
  };

  function writeConfig(team: string, workingDirectory?: string, name = 'alpha'): string {
    const p = path.join(configDir, `${team}-${name}.yaml`);
    fs.writeFileSync(p, `version: "1"
team: ${team}

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-haiku-4-5-20251001

agents:
  - name: ${name}
    description: "containment fixture"
${workingDirectory ? `    workingDirectory: ${workingDirectory}\n` : ''}`);
    return p;
  }

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contain-wd-')));
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contain-cfg-')));
    projectsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contain-projects-')));
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contain-outside-')));

    // Pin the roots: the suite must not depend on the host having ~/projects.
    process.env.ID_PROJECTS_ROOT = projectsDir;
    delete process.env.ID_ALLOWED_WORKDIR_ROOTS;
    delete process.env.ID_WORKSPACE_DIR;

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    (manager as any).spawnLocalAgentProcess = async () => ({ success: true, pid: 7, logFile: '/tmp/x.log' });
    (manager as any).deploySkillsToAgent = () => undefined;
    (manager as any).copyPluginsToAgent = () => [];
    (manager as any).ensureRuntimeReady = () => undefined;
    (manager as any).getOrCreateAgentWallet = () => ({ walletName: 'stub', address: '0xSTUB' });
    await manager.start(port);
  });

  afterEach(async () => {
    await manager.shutdown().catch(() => {});
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 300);
    });
    await db.close();
    for (const [key, value] of [
      ['ID_PROJECTS_ROOT', savedEnv.projects],
      ['ID_ALLOWED_WORKDIR_ROOTS', savedEnv.extra],
      ['ID_WORKSPACE_DIR', savedEnv.ws],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const d of [workDir, configDir, projectsDir, outsideDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  async function run(command: string, team = TEAM) {
    const resp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' },
      body: JSON.stringify({ command }),
    });
    return { status: resp.status, body: await resp.json() as any };
  }

  async function rowsOf(team: string) {
    return db.agents.listAll(await db.teams.getOrCreateTeamId(team));
  }

  describe('THE LOAD-BEARING CASE — real paths still work', () => {
    it('ACCEPTS a path under the projects root', async () => {
      // This is the 42-authored-paths regression test. If it fails, the guard
      // has locked the fleet out of its own working directories.
      const target = path.join(projectsDir, 'idx');
      const { status, body } = await run(`/deploy ${writeConfig(TEAM, target)}`);
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const row = (await rowsOf(TEAM)).find((r) => r.name === 'alpha')!;
      expect(row.working_directory).toBe(target);
    });

    it('ACCEPTS a path under baseWorkDir', async () => {
      const target = path.join(workDir, 'agents', 'chosen-by-hand');
      expect((await run(`/deploy ${writeConfig(TEAM, target)}`)).body.ok).toBe(true);
      expect((await rowsOf(TEAM)).find((r) => r.name === 'alpha')!.working_directory).toBe(target);
    });

    it('ACCEPTS a path an operator opted in via ID_ALLOWED_WORKDIR_ROOTS', async () => {
      process.env.ID_ALLOWED_WORKDIR_ROOTS = outsideDir;
      const target = path.join(outsideDir, 'opted-in');
      expect((await run(`/deploy ${writeConfig(TEAM, target)}`)).body.ok).toBe(true);
    });

    it('still defaults and works when workingDirectory is omitted', async () => {
      expect((await run(`/deploy ${writeConfig(TEAM, undefined)}`)).body.ok).toBe(true);
      const row = (await rowsOf(TEAM)).find((r) => r.name === 'alpha')!;
      expect(row.working_directory).toBe(path.join(workDir, 'agents', row.id));
    });
  });

  describe('rejection', () => {
    it('400s an out-of-root absolute path, naming the path AND what is permitted', async () => {
      const target = path.join(outsideDir, 'not-allowed');
      const { status, body } = await run(`/deploy ${writeConfig(TEAM, target)}`);

      expect(status).toBe(400);
      expect(body.error).toBe('invalid_working_directory');
      expect(body.message).toContain(target);        // which path
      expect(body.message).toContain(projectsDir);   // and what IS allowed
      expect(body.message).toContain('ID_PROJECTS_ROOT');
      expect(body.message).toContain('ID_ALLOWED_WORKDIR_ROOTS');
    });

    it('400s a traversing path and CREATES NOTHING', async () => {
      const target = path.join(projectsDir, '..', path.basename(outsideDir), 'escaped');
      const { status } = await run(`/deploy ${writeConfig(TEAM, target)}`);
      expect(status).toBe(400);

      // No directory, no agent row, no team config recorded: a refusal that
      // already wrote to disk is not a refusal.
      expect(fs.existsSync(path.join(outsideDir, 'escaped'))).toBe(false);
      expect(await rowsOf(TEAM)).toEqual([]);
      const team = await db.teams.getTeamByName(TEAM);
      expect(team?.last_config_path ?? null).toBeNull();
    });

    it('rejects a symlink inside a permitted root that escapes it', async () => {
      // The reason containment is realpath-based and not startsWith.
      const link = path.join(projectsDir, 'escape-hatch');
      fs.symlinkSync(outsideDir, link);
      const { status, body } = await run(`/deploy ${writeConfig(TEAM, path.join(link, 'sub'))}`);

      expect(status).toBe(400);
      expect(body.error).toBe('invalid_working_directory');
      expect(fs.existsSync(path.join(outsideDir, 'sub'))).toBe(false);
    });

    it('stores the RESOLVED path when a symlink stays inside the root', async () => {
      const real = path.join(projectsDir, 'real');
      fs.mkdirSync(real);
      const link = path.join(projectsDir, 'link');
      fs.symlinkSync(real, link);

      expect((await run(`/deploy ${writeConfig(TEAM, link)}`)).body.ok).toBe(true);
      // Storing the raw path would let the symlink be re-pointed after the check.
      expect((await rowsOf(TEAM)).find((r) => r.name === 'alpha')!.working_directory).toBe(real);
    });

    it('refuses the WHOLE config before creating any agent, not half of it', async () => {
      // alpha is fine, beta is not. Pre-flight means neither is created.
      const p = path.join(configDir, 'mixed.yaml');
      fs.writeFileSync(p, `version: "1"
team: ${TEAM}
defaults:
  local: true
  runtime: claude-code-cli
  model: claude-haiku-4-5-20251001
agents:
  - name: alpha
    workingDirectory: ${path.join(projectsDir, 'fine')}
  - name: beta
    workingDirectory: ${path.join(outsideDir, 'bad')}
`);
      const { status, body } = await run(`/deploy ${p}`);
      expect(status).toBe(400);
      expect(body.message).toContain('beta');
      expect(await rowsOf(TEAM)).toEqual([]);
      expect(fs.existsSync(path.join(projectsDir, 'fine'))).toBe(false);
    });
  });

  describe('the file-borne vector itself — /import', () => {
    it('400s an imported config carrying an out-of-root path', async () => {
      const evil = path.join(configDir, 'evil.yaml');
      fs.writeFileSync(evil, `version: "1"
team: whatever
agents:
  - name: gamma
    workingDirectory: ${path.join(outsideDir, 'via-import')}
`);
      const { status, body } = await run(`/import ${evil} --team imported-team`);

      expect(status).toBe(400);
      expect(body.error).toBe('invalid_working_directory');
      expect(fs.existsSync(path.join(outsideDir, 'via-import'))).toBe(false);
      expect(await rowsOf('imported-team')).toEqual([]);
    });

    it('imports a config whose paths are inside the roots', async () => {
      const good = path.join(configDir, 'good.yaml');
      fs.writeFileSync(good, `version: "1"
team: whatever
agents:
  - name: delta
    workingDirectory: ${path.join(projectsDir, 'delta-wd')}
`);
      expect((await run(`/import ${good} --team imported-ok`)).body.ok).toBe(true);
      expect((await rowsOf('imported-ok')).map((r) => r.name)).toContain('delta');
    });
  });

  describe('the boot audit (part 3) — report, never refuse', () => {
    it('reports an agent outside the roots without refusing anything', async () => {
      // Seed a row directly: this is the pre-existing agent the guard postdates.
      const teamId = await db.teams.getOrCreateTeamId(TEAM);
      await db.agents.create({
        team_id: teamId,
        id: 'agent_legacy_1',
        name: 'legacy',
        type: 'claude',
        model: 'claude-haiku-4-5-20251001',
        status: 'stopped',
        created_at: 1700000000,
        working_directory: path.join(outsideDir, 'legacy-home'),
      } as any);

      const findings = await manager.auditAgentWorkdirs();
      expect(findings).toEqual([
        { agent: 'legacy', team: TEAM, path: path.join(outsideDir, 'legacy-home') },
      ]);
      // Still serving: the audit reported, it did not refuse.
      expect((await run(`/agents`, TEAM)).status).toBe(200);
    });

    it('says nothing when every agent is inside the roots', async () => {
      expect((await run(`/deploy ${writeConfig(TEAM, path.join(projectsDir, 'ok'))}`)).body.ok).toBe(true);
      expect(await manager.auditAgentWorkdirs()).toEqual([]);
    });

    it('fresh install: no agents, nothing to report', async () => {
      expect(await manager.auditAgentWorkdirs()).toEqual([]);
    });
  });
});
