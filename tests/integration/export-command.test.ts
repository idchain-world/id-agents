// SPDX-License-Identifier: MIT
/**
 * `/export <team> [path]` command wiring — SPEC §5.1 (commit 2b).
 *
 * The module's behaviour is already proved in tests/unit/export-team-config.test.ts.
 * What these tests pin is the WIRING: that the handler reads the right rows,
 * resolves the right path, and returns the module's result unchanged — i.e.
 * that it stayed thin and did not re-implement any export decision.
 *
 * Fixtures only. In-memory SQLite; the live database on :4100 is never touched
 * and the manager is never restarted.
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
import { WALLET_EXPORT_WARNING } from '../../src/lib/export-team-config.js';

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

const TEAM = 'export-wiring';

describe('/export command wiring', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let outDir: string;
  let teamId: string;

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-wire-'));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-out-'));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);

    teamId = await db.teams.getOrCreateTeamId(TEAM);
    await db.agents.create({
      team_id: teamId, id: 'local_alpha', name: 'alpha', type: 'claude',
      model: 'claude-haiku-4-5-20251001', status: 'running', created_at: Date.now(),
      runtime: 'claude-code-cli', working_directory: `${workDir}/alpha`,
      // Sensitive columns set on purpose: none may reach the file.
      api_key: 'sk-MUST-NOT-EXPORT',
      ssh_target: 'root@10.9.9.9',
      internal_endpoint_url: 'http://10.9.9.9:9000',
      metadata: {
        description: 'first agent', pid: 999, local: true,
        endpoint: 'http://localhost:1', ows_wallet: 'w', ows_address: '0xdead',
        agent_account: '0xbeef', surprise_key: 'unclassified',
      },
    } as any);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 400);
    });
    await db.close();
    for (const d of [workDir, outDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  async function runCommand(command: string) {
    const resp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM, 'X-Id-Admin': '1' },
      body: JSON.stringify({ command }),
    });
    return await resp.json() as any;
  }

  it('writes the config to an explicit path and returns the module result', async () => {
    const target = path.join(outDir, 'explicit.yaml');
    const body = await runCommand(`/export ${TEAM} ${target}`);

    expect(body.ok).toBe(true);
    expect(body.result.path).toBe(target);
    expect(body.result.agents).toBe(1);
    expect(fs.existsSync(target)).toBe(true);

    const doc = yaml.load(fs.readFileSync(target, 'utf-8')) as any;
    expect(doc.team).toBe(TEAM);
    expect(doc.agents[0].name).toBe('alpha');
    expect(doc.agents[0].description).toBe('first agent');
  });

  it('carries the §5.6 wallet warning through the command result', async () => {
    const target = path.join(outDir, 'warn.yaml');
    const body = await runCommand(`/export ${TEAM} ${target}`);
    expect(body.result.warnings).toContain(WALLET_EXPORT_WARNING);
  });

  it('reports unknown metadata keys in skipped rather than dropping them silently', async () => {
    const target = path.join(outDir, 'skipped.yaml');
    const body = await runCommand(`/export ${TEAM} ${target}`);
    expect(body.result.skipped).toEqual([{ agent: 'alpha', keys: ['surprise_key'] }]);
  });

  it('never writes a credential or sensitive column through the command path', async () => {
    const target = path.join(outDir, 'secrets.yaml');
    await runCommand(`/export ${TEAM} ${target}`);
    const text = fs.readFileSync(target, 'utf-8');
    expect(text).not.toContain('sk-MUST-NOT-EXPORT');
    expect(text).not.toContain('root@10.9.9.9');
    expect(text).not.toContain('10.9.9.9:9000');
    // runtime/derived dropped too; the identifier kept.
    expect(text).not.toContain('0xdead');
    expect(text).toContain('0xbeef');
  });

  it('falls back to teams.last_config_path when no path is given (§5.1)', async () => {
    const recorded = path.join(outDir, 'recorded.yaml');
    await db.teams.updateConfig(teamId, { last_config_path: recorded });
    const body = await runCommand(`/export ${TEAM}`);
    expect(body.result.path).toBe(recorded);
    expect(fs.existsSync(recorded)).toBe(true);
  });

  it('falls back to <baseWorkDir>/teams/<team>/<team>.yaml when nothing is recorded', async () => {
    const body = await runCommand(`/export ${TEAM}`);
    expect(body.result.path).toBe(path.join(workDir, 'teams', TEAM, `${TEAM}.yaml`));
    expect(fs.existsSync(body.result.path)).toBe(true);
  });

  it('backs up an existing file before overwriting', async () => {
    const target = path.join(outDir, 'bak.yaml');
    fs.writeFileSync(target, 'previous: true\n');
    await runCommand(`/export ${TEAM} ${target}`);
    expect(fs.readFileSync(`${target}.bak`, 'utf-8')).toBe('previous: true\n');
  });

  it('rejects a missing team argument and an unknown team', async () => {
    const noArg = await runCommand('/export');
    expect(noArg.ok).toBe(false);
    expect(String(noArg.error)).toMatch(/Usage: \/export/);

    const missing = await runCommand('/export no-such-team');
    expect(missing.ok).toBe(false);
    expect(String(missing.error)).toContain('no-such-team');
  });
});
