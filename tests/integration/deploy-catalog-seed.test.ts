// SPDX-License-Identifier: MIT
/**
 * Catalog seed deploy integration test.
 *
 * Proves that:
 *   1. A `catalog:` block in a deploy YAML lands in `agents.metadata.catalog`
 *      on first deploy.
 *   2. A redeploy (sync) re-applies the YAML floor: a runtime PATCH to
 *      `metadata.catalog` is overwritten back to the YAML values, while
 *      runtime-only fields outside the catalog object stay intact.
 *
 * Pattern follows tests/integration/wallet-opt-in.test.ts: in-memory SQLite,
 * a real AgentManagerDb, but `spawnLocalAgentProcess` is stubbed so the test
 * never actually forks node child processes — we only care about the DB row
 * the deploy code writes BEFORE spawn.
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

const TEST_TEAM = 'catalog-seed-test';
const AGENT_JR = 'jrdev';
const AGENT_AUDITOR = 'auditreviewer';

function firstDeployYaml(jrDir: string, auditorDir: string): string {
  return `version: "1"
team: ${TEST_TEAM}

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-haiku-4-5-20251001

agents:
  - name: ${AGENT_JR}
    description: "Junior dev test seed"
    workingDirectory: ${jrDir}
    catalog:
      role: junior-developer
      description: "Junior dev for low-stakes work."
      expertise: [typescript, simple-refactors]
      costTier: low
      notSuitableFor: [security-key-handling]
      status: available

  - name: ${AGENT_AUDITOR}
    description: "Auditor test seed"
    workingDirectory: ${auditorDir}
    catalog:
      role: auditor
      description: "Reviews code and configs."
      expertise: [audit, review]
      costTier: medium
      status: available
`;
}

function redeployYaml(jrDir: string, auditorDir: string): string {
  return `version: "1"
team: ${TEST_TEAM}

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-haiku-4-5-20251001

agents:
  - name: ${AGENT_JR}
    description: "Junior dev test seed"
    workingDirectory: ${jrDir}
    catalog:
      role: junior-developer
      description: "Updated junior dev blurb."
      expertise: [typescript, simple-refactors, doc-edits]
      costTier: low
      notSuitableFor: [security-key-handling, multi-file-schema-migrations]
      status: available

  - name: ${AGENT_AUDITOR}
    description: "Auditor test seed"
    workingDirectory: ${auditorDir}
    catalog:
      role: auditor
      description: "Reviews code and configs."
      expertise: [audit, review]
      costTier: medium
      status: available
`;
}

function adminHeaders(team: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    'X-Id-Admin': '1',
  };
}

describe('catalog seed deploy integration', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let workDir: string;
  let baseUrl: string;
  let configDir: string;
  let firstYamlPath: string;
  let redeployYamlPath: string;

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-seed-int-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-seed-cfg-'));
    const jrDir = path.join(configDir, 'jr-workdir');
    const auditorDir = path.join(configDir, 'auditor-workdir');
    fs.mkdirSync(jrDir);
    fs.mkdirSync(auditorDir);
    firstYamlPath = path.join(configDir, 'first.yaml');
    redeployYamlPath = path.join(configDir, 'redeploy.yaml');
    fs.writeFileSync(firstYamlPath, firstDeployYaml(jrDir, auditorDir));
    fs.writeFileSync(redeployYamlPath, redeployYaml(jrDir, auditorDir));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);

    // Stub spawn so the deploy code path doesn't actually fork node children.
    // The DB row is written BEFORE the spawn call, so this is safe — we
    // verify the row, not the process.
    (manager as any).spawnLocalAgentProcess = async () => ({ success: true, pid: 12345, logFile: '/tmp/catalog-seed-test.log' });

    // Stub plugin/skill deploy steps that touch the filesystem in arbitrary
    // user paths (the test workdirs above point to /tmp, which is fine, but
    // we don't need real skill files for a metadata-shape assertion).
    (manager as any).deploySkillsToAgent = () => undefined;
    (manager as any).copyPluginsToAgent = () => [];
    (manager as any).ensureRuntimeReady = () => undefined;

    await manager.start(port);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
    await db.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function deploy(yamlPath: string) {
    const resp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders(TEST_TEAM),
      body: JSON.stringify({ command: `/deploy ${yamlPath}` }),
    });
    expect(resp.ok).toBe(true);
    const body = await resp.json() as any;
    if (!body.ok) {
      throw new Error(`/deploy returned not-ok: ${JSON.stringify(body)}`);
    }
    return body.result;
  }

  async function readAgentRowByName(name: string) {
    const teamId = await db.teams.getOrCreateTeamId(TEST_TEAM);
    const row = await db.agents.getByName(teamId, name);
    if (!row) throw new Error(`agent row not found for ${name}`);
    return row;
  }

  it('first deploy seeds metadata.catalog from the YAML block', async () => {
    await deploy(firstYamlPath);

    const jr = await readAgentRowByName(AGENT_JR);
    const cat = (jr.metadata as any)?.catalog;
    expect(cat).toBeDefined();
    expect(cat.role).toBe('junior-developer');
    expect(cat.description).toBe('Junior dev for low-stakes work.');
    expect(cat.expertise).toEqual(['typescript', 'simple-refactors']);
    expect(cat.costTier).toBe('low');
    expect(cat.notSuitableFor).toEqual(['security-key-handling']);
    expect(cat.status).toBe('available');

    const auditor = await readAgentRowByName(AGENT_AUDITOR);
    const auditorCat = (auditor.metadata as any)?.catalog;
    expect(auditorCat?.role).toBe('auditor');
    expect(auditorCat?.costTier).toBe('medium');
    // notSuitableFor was omitted in the auditor's YAML — should be absent
    // from the seed (not coerced to []).
    expect(auditorCat?.notSuitableFor).toBeUndefined();
  });

  it('seeds metadata.catalog from a catalogFile (markdown) alongside inline catalog', async () => {
    // Mixed config: jrdev uses catalogFile (markdown w/ frontmatter), auditor stays inline.
    const mdPath = path.join(configDir, 'catalogs', 'jrdev.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, `---
role: junior-developer
expertise: [typescript, simple-refactors]
costTier: low
notSuitableFor: [security-key-handling]
status: available
---

Junior dev for low-stakes work via catalogFile.
`);

    const jrDir = path.join(configDir, 'jr-workdir');
    const auditorDir = path.join(configDir, 'auditor-workdir');
    const mixedYaml = `version: "1"
team: ${TEST_TEAM}

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-haiku-4-5-20251001

agents:
  - name: ${AGENT_JR}
    description: "Junior dev test seed"
    workingDirectory: ${jrDir}
    catalogFile: catalogs/jrdev.md

  - name: ${AGENT_AUDITOR}
    description: "Auditor test seed"
    workingDirectory: ${auditorDir}
    catalog:
      role: auditor
      description: "Reviews code and configs."
      expertise: [audit, review]
      costTier: medium
      status: available
`;
    const mixedPath = path.join(configDir, 'mixed.yaml');
    fs.writeFileSync(mixedPath, mixedYaml);

    await deploy(mixedPath);

    // catalogFile-driven agent
    const jr = await readAgentRowByName(AGENT_JR);
    const jrCat = (jr.metadata as any)?.catalog;
    expect(jrCat).toBeDefined();
    expect(jrCat.role).toBe('junior-developer');
    expect(jrCat.expertise).toEqual(['typescript', 'simple-refactors']);
    expect(jrCat.costTier).toBe('low');
    expect(jrCat.notSuitableFor).toEqual(['security-key-handling']);
    expect(jrCat.status).toBe('available');
    // body became the description
    expect(jrCat.description).toBe(`Junior dev for low-stakes work via catalogFile.
`);

    // inline catalog still works
    const auditor = await readAgentRowByName(AGENT_AUDITOR);
    const auditorCat = (auditor.metadata as any)?.catalog;
    expect(auditorCat?.role).toBe('auditor');
    expect(auditorCat?.costTier).toBe('medium');

    // GET /catalog round-trip via the manager's per-agent /catalog proxy.
    // Manager exposes the catalog at GET /agents/by-name/:name (metadata.catalog
    // is the single source of truth) — verify via that path so we don't need a
    // running agent server (spawnLocalAgentProcess is stubbed).
    const resp = await fetch(`${baseUrl}/agents/by-name/${AGENT_JR}`, {
      headers: adminHeaders(TEST_TEAM),
    });
    expect(resp.ok).toBe(true);
    const body = await resp.json() as any;
    const apiCat = body?.metadata?.catalog ?? body?.agent?.metadata?.catalog;
    expect(apiCat?.role).toBe('junior-developer');
    expect(apiCat?.costTier).toBe('low');
  });

  // SUPERSEDED BY D1 (commit 4). This used to assert that a redeploy re-applied
  // the YAML floor over a runtime PATCH. /deploy is now create-only, so there is
  // no redeploy to re-apply anything — the drift simply survives, because
  // nothing is allowed to overwrite it. The coverage is kept rather than
  // deleted, inverted to the new contract: the second deploy is REFUSED and the
  // runtime state is left exactly as the agent wrote it.
  it('refuses a redeploy and leaves runtime catalog drift untouched (D1)', async () => {
    await deploy(firstYamlPath);
    const beforeRow = await readAgentRowByName(AGENT_JR);
    expect((beforeRow.metadata as any).catalog.description).toBe('Junior dev for low-stakes work.');

    const teamId = await db.teams.getOrCreateTeamId(TEST_TEAM);
    const driftedMeta = {
      ...(beforeRow.metadata as any),
      catalog: {
        role: 'rogue-role',
        description: 'agent rewrote me at runtime',
        expertise: ['nothing'],
        costTier: 'high',
        status: 'busy',
        currentTask: 'doing my own thing',
      },
    };
    await db.agents.updateMetadata(beforeRow.id, driftedMeta);
    expect(((await db.agents.getByName(teamId, AGENT_JR))!.metadata as any).catalog.role).toBe('rogue-role');

    // The redeploy is refused: the team already holds agents.
    const resp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEST_TEAM, 'X-Id-Admin': '1' },
      body: JSON.stringify({ command: `/deploy ${redeployYamlPath}` }),
    });
    expect(resp.status).toBe(409);
    expect((await resp.json() as any).error).toBe('team_exists');

    // Runtime drift is intact — no YAML floor was re-applied over it.
    const afterCat = ((await readAgentRowByName(AGENT_JR)).metadata as any).catalog;
    expect(afterCat.role).toBe('rogue-role');
    expect(afterCat.description).toBe('agent rewrote me at runtime');
    expect(afterCat.currentTask).toBe('doing my own thing');
  });

  it('spawn env handoff carries the catalog seed as base64-encoded ID_AGENT_CATALOG', async () => {
    await deploy(firstYamlPath);

    const teamId = await db.teams.getOrCreateTeamId(TEST_TEAM);
    const jrRow = await db.agents.getByName(teamId, AGENT_JR);
    expect(jrRow).toBeTruthy();

    // Reach into the private env-builder used by spawnLocalAgentProcess.
    // This is the spawn-site change at src/agent-manager-db.ts buildLocalAgentEnv:
    // metadata.catalog must be encoded into ID_AGENT_CATALOG so the spawned
    // local-agent-server can seed in-memory /catalog state before binding.
    const env = (manager as any).buildLocalAgentEnv(TEST_TEAM, 24999, jrRow);
    expect(env.ID_AGENT_CATALOG).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(env.ID_AGENT_CATALOG, 'base64').toString('utf8'));
    expect(decoded.role).toBe('junior-developer');
    expect(decoded.expertise).toEqual(['typescript', 'simple-refactors']);
    expect(decoded.costTier).toBe('low');
    expect(decoded.notSuitableFor).toEqual(['security-key-handling']);
    expect(decoded.status).toBe('available');

    // No catalog on row → no ID_AGENT_CATALOG. Confirms the var is only set
    // when there's something to seed (no empty-string footgun).
    const bareRow = { ...jrRow, metadata: {} as any };
    const bareEnv = (manager as any).buildLocalAgentEnv(TEST_TEAM, 24999, bareRow);
    expect(bareEnv.ID_AGENT_CATALOG).toBeUndefined();
  });

  it('spawn env resolves configured model aliases before setting CLAUDE_MODEL', async () => {
    await deploy(firstYamlPath);

    const teamId = await db.teams.getOrCreateTeamId(TEST_TEAM);
    const jrRow = await db.agents.getByName(teamId, AGENT_JR);
    expect(jrRow).toBeTruthy();

    const cases: Array<[string, string]> = [
      ['fable', 'claude-fable-5'],
      ['mythos', 'claude-mythos-5'],
      ['haiku', 'claude-haiku-4-5-20251001'],
      ['opus-4.8', 'claude-opus-4-8'],
      ['claude-opus-4-8', 'claude-opus-4-8'],
    ];

    for (const [configuredModel, expectedModel] of cases) {
      const env = (manager as any).buildLocalAgentEnv(
        TEST_TEAM,
        24999,
        jrRow,
        configuredModel,
      );
      expect(env.CLAUDE_MODEL).toBe(expectedModel);
    }
  });
});
