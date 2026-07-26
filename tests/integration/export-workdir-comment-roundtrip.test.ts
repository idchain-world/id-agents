// SPDX-License-Identifier: MIT
/**
 * The generated-workdir comment, driven end to end (#f37ad05d).
 *
 * The unit tests prove the exporter's halves. This one proves the thing that
 * actually mattered: deploy an agent with NO workingDirectory (so the deployer
 * synthesises one), export it, import it under a new team — and the restored
 * agent must get a FRESH directory derived from its OWN new id, not a pointer
 * into the original agent's live one.
 *
 * That is the whole bug in one journey, and neither half could catch it alone.
 *
 * Fixtures only: in-memory SQLite, stubbed spawn and wallet, temp dirs. The
 * live DB and the manager on :4100 are never touched.
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

const SRC = 'wdc-src';
const DST = 'wdc-dst';

describe('generated workingDirectory: deploy -> export -> import (#f37ad05d)', () => {
  // #4d78adbc: fixtures live under os.tmpdir(), which containment rejects.
  // Declare it the same way an operator would, so this suite keeps testing
  // what it is about rather than the working-directory guard.
  permitTmpWorkdirs();
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let configDir: string;

  /** `authored` gets an explicit workingDirectory; the other is left to the deployer. */
  function writeConfig(team: string): string {
    const authoredDir = path.join(configDir, 'authored-wd');
    fs.mkdirSync(authoredDir, { recursive: true });
    const p = path.join(configDir, `${team}.yaml`);
    fs.writeFileSync(p, `version: "1"
team: ${team}

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-haiku-4-5-20251001

agents:
  - name: gen
    description: "no workingDirectory — the deployer synthesises one"
  - name: auth
    description: "author chose this one"
    workingDirectory: ${authoredDir}
  - name: inside
    description: "authored, but INSIDE baseWorkDir/agents — a prefix match would eat it"
    workingDirectory: ${path.join(workDir, 'agents', 'chosen-by-hand')}
`);
    return p;
  }

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wdc-wd-')));
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wdc-cfg-')));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    (manager as any).spawnLocalAgentProcess = async () => ({ success: true, pid: 11, logFile: '/tmp/x.log' });
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

  async function run(command: string, team = SRC) {
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

  async function seedAndExport() {
    expect((await run(`/deploy ${writeConfig(SRC)}`)).body.ok).toBe(true);
    const out = path.join(configDir, 'exported.yaml');
    expect((await run(`/export ${SRC} ${out}`)).body.ok).toBe(true);
    return out;
  }

  it('the deployer really did generate a path for the un-configured agent', async () => {
    // Positive control: without this the rest of the file could pass vacuously.
    await run(`/deploy ${writeConfig(SRC)}`);
    const gen = (await rowsOf(SRC)).find((r) => r.name === 'gen')!;
    expect(gen.working_directory).toBe(path.join(workDir, 'agents', gen.id));
  });

  it('exports the generated path as a comment and the authored one as a value', async () => {
    const out = await seedAndExport();
    const text = fs.readFileSync(out, 'utf8');
    const gen = (await rowsOf(SRC)).find((r) => r.name === 'gen')!;

    expect(text).toContain('# workingDirectory was generated by the deployer');
    expect(text).toContain(gen.working_directory as string);
    // The generated path never appears as a value.
    for (const line of text.split('\n')) {
      if (line.includes(gen.working_directory as string)) {
        expect(line.trimStart().startsWith('#')).toBe(true);
      }
    }

    const loaded = yaml.load(text) as any;
    expect(loaded.agents.find((a: any) => a.name === 'gen').workingDirectory).toBeUndefined();
    expect(loaded.agents.find((a: any) => a.name === 'auth').workingDirectory)
      .toBe(path.join(configDir, 'authored-wd'));
  });

  it('THE BUG: the imported agent gets its OWN fresh directory', async () => {
    const out = await seedAndExport();
    const originalGen = (await rowsOf(SRC)).find((r) => r.name === 'gen')!;

    expect((await run(`/import ${out} --team ${DST}`)).body.ok).toBe(true);

    const restored = (await rowsOf(DST)).find((r) => r.name === 'gen')!;
    // A NEW id, and a directory derived from it...
    expect(restored.id).not.toBe(originalGen.id);
    expect(restored.working_directory).toBe(path.join(workDir, 'agents', restored.id));
    // ...which is emphatically NOT the original agent's live directory.
    expect(restored.working_directory).not.toBe(originalGen.working_directory);
  });

  it('the authored path survives the round-trip unchanged', async () => {
    const out = await seedAndExport();
    await run(`/import ${out} --team ${DST}`);

    const restored = (await rowsOf(DST)).find((r) => r.name === 'auth')!;
    // The operator's choice is a fact about the team and must be preserved.
    expect(restored.working_directory).toBe(path.join(configDir, 'authored-wd'));
  });

  /**
   * The dangerous false positive, end to end. `inside` sits at
   * `<baseWorkDir>/agents/chosen-by-hand` — inside the generated parent, but a
   * name its author picked. A prefix or startsWith match would classify it as
   * generated, drop the key, and restore the team into an empty scratch
   * directory: worse than the bug being fixed, and silent.
   */
  it('an AUTHORED path inside baseWorkDir/agents is emitted as a value and survives', async () => {
    const out = await seedAndExport();
    const text = fs.readFileSync(out, 'utf8');
    const chosen = path.join(workDir, 'agents', 'chosen-by-hand');

    // Emitted as a value, not swallowed into a comment.
    expect((yaml.load(text) as any).agents.find((a: any) => a.name === 'inside').workingDirectory)
      .toBe(chosen);

    expect((await run(`/import ${out} --team ${DST}`)).body.ok).toBe(true);
    const restored = (await rowsOf(DST)).find((r) => r.name === 'inside')!;
    expect(restored.working_directory).toBe(chosen);
  });

  it('re-exporting the imported team is byte-identical to exporting it twice', async () => {
    const out = await seedAndExport();
    await run(`/import ${out} --team ${DST}`);

    const a = path.join(configDir, 'dst-a.yaml');
    const b = path.join(configDir, 'dst-b.yaml');
    expect((await run(`/export ${DST} ${a}`, DST)).body.ok).toBe(true);
    expect((await run(`/export ${DST} ${b}`, DST)).body.ok).toBe(true);
    expect(fs.readFileSync(a, 'utf8')).toBe(fs.readFileSync(b, 'utf8'));

    // And the comment is still there, now naming the RESTORED agent's directory.
    const restored = (await rowsOf(DST)).find((r) => r.name === 'gen')!;
    expect(fs.readFileSync(a, 'utf8')).toContain(restored.working_directory as string);
  });
});
