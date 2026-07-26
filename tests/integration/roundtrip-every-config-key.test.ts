// SPDX-License-Identifier: MIT
/**
 * CLASS GUARD — every `config`-classified taxonomy key survives a round-trip.
 *
 * Four times now the same defect has shipped: the exporter is written against
 * the metadata TAXONOMY, the importer against the config-parser ALLOW-LIST, and
 * nobody checks the two agree. org, then ENS (D9), then agent_account (D10),
 * then the six DMZ posture keys — each emitted into a file that nothing could
 * read back. The DMZ one was the dangerous instance: `mesh_member: false`
 * vanished on import, and the gate reads `mesh_member !== false`, so an
 * exported DMZ agent came back MESH-REACHABLE. A silent security downgrade.
 *
 * Fixing four keys does not stop the fifth. This test is the guard for the
 * CLASS: it enumerates every key the taxonomy classifies `config` and proves
 * each one survives export -> parse -> create.
 *
 * ITERATING THE MODULE'S OWN DATA IS CORRECT HERE, and it is the one place in
 * this build where that is true. The taxonomy tests deliberately hand-transcribe
 * their expectations, because there the claim is "this key is classified X" and
 * looping would make the test agree with whatever the table said. Here the claim
 * is different — "whatever is classified `config`, SURVIVES" — and the survival
 * assertion is independent of the classification. Driving it from
 * listClassifiedMetadataKeys() is what makes a future key covered on the day it
 * is added rather than the day someone remembers.
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
import { classifyMetadataKey, listClassifiedMetadataKeys } from '../../src/lib/metadata-taxonomy.js';

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

/**
 * A representative value for each `config` key, used to build the fixture
 * agent. Every config-classified key MUST appear here — a key with no value is
 * a key this guard cannot test, so the completeness check below fails loudly
 * rather than skipping it.
 */
const FIXTURE_VALUES: Record<string, unknown> = {
  name: 'roundtrip',
  description: 'every config key',
  runtime: 'claude-code-cli',
  skills: ['some-skill'],
  plugins: undefined,        // an empty array would pass vacuously; see EXCEPTIONS
  catalog: { role: 'tester', description: 'catalog blurb', status: 'available' },
  dangerouslySkipPermissions: false,
  agent: undefined,          // library overlay name; see EXCEPTIONS
  heartbeat: undefined,      // boolean in metadata, interval in the file; EXCEPTIONS
  bio: 'a bio',
  handles: { x: '@rt' },
  wallet: false,
  effort: undefined,         // codex-only; see EXCEPTIONS
  allowed_tools: ['Read'],
  openMode: true,
  isAutomator: undefined,    // implied by type: automator; see EXCEPTIONS
  mesh_member: false,        // THE one that mattered
  mesh_reachable: false,
  public_endpoint: true,
  dmz: true,
  allowed_inbound: ['public_http'],
  allowed_outbound: ['openrouter'],
};

/**
 * Keys that legitimately do NOT survive unchanged, each with the reason. The
 * test ENFORCES this list: an exception that starts surviving must be removed
 * from it, so the list cannot quietly grow into a place to hide failures.
 */
const EXCEPTIONS: Record<string, string> = {
  plugins: 'export emits DECLARED paths, deploy stores RESOLVED localPlugins (§3.1 rule 3). '
    + 'Deliberately given no fixture value: an empty array would round-trip vacuously and prove nothing.',
  heartbeat: 'boolean in metadata, reconstructed as an interval from the schedules table (§3.1 rule 4)',
  agent: 'library overlay name — only meaningful when the named library agent exists on disk',
  effort: 'codex runtime only; ignored for the claude runtime this fixture uses',
  isAutomator: 'derived from type: automator rather than carried as a value',
};

const TEAM = 'rt-src';
const NEW_TEAM = 'rt-dst';

describe('every config-classified key survives export -> import', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let configDir: string;

  const configKeys = () => listClassifiedMetadataKeys().filter((k) => classifyMetadataKey(k) === 'config');

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-wd-')));
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cfg-')));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    (manager as any).spawnLocalAgentProcess = async () => ({ success: true, pid: 1, logFile: '/tmp/x.log' });
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
    for (const d of [workDir, configDir]) {
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

  /** Build a config whose single agent carries every testable config key. */
  function writeFixtureConfig(): string {
    const agentDir = path.join(configDir, 'rt-wd');
    fs.mkdirSync(agentDir, { recursive: true });
    const entry: Record<string, unknown> = { name: 'roundtrip', workingDirectory: agentDir, model: 'claude-haiku-4-5-20251001' };
    for (const key of configKeys()) {
      const value = FIXTURE_VALUES[key];
      if (value === undefined) continue;
      entry[key === 'allowed_tools' ? 'allowedTools' : key] = value;
    }
    const p = path.join(configDir, 'fixture.yaml');
    fs.writeFileSync(p, yaml.dump({ version: '1', team: TEAM, agents: [entry] }, { noRefs: true }));
    return p;
  }

  it('has a fixture value for every config-classified key — no silent gaps', () => {
    // If a key is added to the taxonomy and nobody adds a value here, this
    // fails rather than the guard quietly testing one fewer key.
    const missing = configKeys().filter((k) => !(k in FIXTURE_VALUES));
    expect(missing).toEqual([]);
  });

  it('every exception is a real config key — the list cannot drift', () => {
    const stale = Object.keys(EXCEPTIONS).filter((k) => !configKeys().includes(k));
    expect(stale).toEqual([]);
  });

  it('round-trips every config-classified key through export -> import', async () => {
    expect((await run(`/deploy ${writeFixtureConfig()}`)).body.ok).toBe(true);

    const exported = path.join(configDir, 'exported.yaml');
    expect((await run(`/export ${TEAM} ${exported}`)).body.ok).toBe(true);
    expect((await run(`/import ${exported} --team ${NEW_TEAM}`)).body.ok).toBe(true);

    const newTeamId = await db.teams.getOrCreateTeamId(NEW_TEAM);
    const row = (await db.agents.listAll(newTeamId)).find((r) => r.name === 'roundtrip');
    expect(row).toBeTruthy();
    const meta = (row!.metadata || {}) as Record<string, unknown>;

    const lost: string[] = [];
    for (const key of configKeys()) {
      if (key in EXCEPTIONS) continue;
      if (FIXTURE_VALUES[key] === undefined) continue;
      // Presence AND value: `mesh_member: false` present-but-true would be the
      // exact security downgrade this exists to prevent.
      if (JSON.stringify(meta[key]) !== JSON.stringify(FIXTURE_VALUES[key])) {
        lost.push(`${key}: expected ${JSON.stringify(FIXTURE_VALUES[key])}, got ${JSON.stringify(meta[key])}`);
      }
    }
    expect(lost).toEqual([]);
  });

  it('an exception that starts surviving must be removed from the list', async () => {
    // Keeps EXCEPTIONS honest: it may only hold keys that genuinely do not
    // round-trip, so it cannot become a dumping ground for real failures.
    expect((await run(`/deploy ${writeFixtureConfig()}`)).body.ok).toBe(true);
    const exported = path.join(configDir, 'exc.yaml');
    await run(`/export ${TEAM} ${exported}`);
    await run(`/import ${exported} --team ${NEW_TEAM}`);

    const newTeamId = await db.teams.getOrCreateTeamId(NEW_TEAM);
    const meta = ((await db.agents.listAll(newTeamId)).find((r) => r.name === 'roundtrip')!.metadata || {}) as Record<string, unknown>;

    const nowSurviving = Object.keys(EXCEPTIONS).filter(
      (k) => FIXTURE_VALUES[k] !== undefined && JSON.stringify(meta[k]) === JSON.stringify(FIXTURE_VALUES[k]),
    );
    expect(nowSurviving).toEqual([]);
  });

  it('mesh_member: false survives — a DMZ agent does not re-import mesh-reachable', async () => {
    // The specific live bug, called out on its own so a regression names itself.
    expect((await run(`/deploy ${writeFixtureConfig()}`)).body.ok).toBe(true);
    const exported = path.join(configDir, 'dmz.yaml');
    await run(`/export ${TEAM} ${exported}`);
    await run(`/import ${exported} --team ${NEW_TEAM}`);

    const newTeamId = await db.teams.getOrCreateTeamId(NEW_TEAM);
    const meta = ((await db.agents.listAll(newTeamId)).find((r) => r.name === 'roundtrip')!.metadata || {}) as Record<string, unknown>;

    expect(meta.mesh_member).toBe(false);
    // The gate is `metadata?.mesh_member !== false`, so undefined means REACHABLE.
    expect(meta.mesh_member).not.toBeUndefined();
    expect((meta as any).mesh_member !== false).toBe(false);
    expect(meta.dmz).toBe(true);
    expect(meta.allowed_inbound).toEqual(['public_http']);
  });
});

describe('/import without --team (§7 primary form)', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let configDir: string;

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nt-wd-')));
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nt-cfg-')));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    (manager as any).spawnLocalAgentProcess = async () => ({ success: true, pid: 1, logFile: '/tmp/x.log' });
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

  it('takes the team from the file when no --team is given', async () => {
    // Regression: indexOf returned -1, so the arg filter's `i !== -1 + 1`
    // dropped index 0 — the FILENAME — and the primary form always failed.
    const agentDir = path.join(configDir, 'wd');
    fs.mkdirSync(agentDir, { recursive: true });
    const p = path.join(configDir, 'plain.yaml');
    fs.writeFileSync(p, `version: "1"\nteam: from-file-team\n\nagents:\n  - name: solo\n    workingDirectory: ${agentDir}\n`);

    const resp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': 'caller-team', 'X-Id-Admin': '1' },
      body: JSON.stringify({ command: `/import ${p}` }),
    });
    const body = await resp.json() as any;

    expect(body.ok).toBe(true);
    expect(body.result.team).toBe('from-file-team');

    const teamId = await db.teams.getOrCreateTeamId('from-file-team');
    expect((await db.agents.listAll(teamId)).map((r) => r.name)).toContain('solo');
  });
});
