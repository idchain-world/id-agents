// SPDX-License-Identifier: MIT
/**
 * `/import <file> [--team <name>]` — SPEC §7 + §5.2.3 (commit 7).
 *
 * Import creates a NEW team by reusing the /deploy creation path. The point of
 * most of these tests is that "reused" is not the same as "wired": the refusal
 * contract, org persistence and workdir containment are ASSERTED at the import
 * entry point rather than assumed to have come along for the ride.
 *
 * Fixtures only. Live DB on :4100 never touched; no real wallet provisioned.
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
import { importAvatars } from '../../src/lib/import-avatars.js';
import { MAX_AVATAR_BYTES } from '../../src/lib/export-team-config.js';
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

const SOURCE_TEAM = 'import-src';
const NEW_TEAM = 'import-dst';

describe('/import (§7)', () => {
  // #4d78adbc: fixtures live under os.tmpdir(), which containment rejects.
  // Declare it the same way an operator would, so this suite keeps testing
  // what it is about rather than the working-directory guard.
  permitTmpWorkdirs();
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let configDir: string;

  function writeConfig(team: string, opts: { org?: boolean; agent?: string } = {}): string {
    const agentName = opts.agent ?? 'alpha';
    const agentDir = path.join(configDir, `${agentName}-wd`);
    fs.mkdirSync(agentDir, { recursive: true });
    const orgBlock = opts.org
      ? `
org:
  groups:
    engineering:
      description: "Builds the thing"
      members: [${agentName}]
`
      : '';
    const p = path.join(configDir, `${team}.yaml`);
    fs.writeFileSync(p, `version: "1"
team: ${team}
${orgBlock}
agents:
  - name: ${agentName}
    description: "round trip me"
    model: claude-haiku-4-5-20251001
    workingDirectory: ${agentDir}
`);
    return p;
  }

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'import-wd-')));
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'import-cfg-')));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    (manager as any).spawnLocalAgentProcess = async () => ({ success: true, pid: 9, logFile: '/tmp/x.log' });
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

  async function run(command: string, team = SOURCE_TEAM) {
    const resp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' },
      body: JSON.stringify({ command }),
    });
    return { status: resp.status, body: await resp.json() as any };
  }

  async function rowsOf(team: string) {
    const id = await db.teams.getOrCreateTeamId(team);
    return db.agents.listAll(id);
  }

  describe('round-trip: export then import to a new name', () => {
    it('carries config-derived fields, ENS and agent_account; never wallets (D7)', async () => {
      expect((await run(`/deploy ${writeConfig(SOURCE_TEAM)}`)).body.ok).toBe(true);

      // ENS + agent_account exist on zero live rows, so fixture them on.
      const srcRows = await rowsOf(SOURCE_TEAM);
      const alpha = srcRows.find((r) => r.name === 'alpha')!;
      await db.agents.updateIdentity(alpha.id, { token_id: 'agent-9', domain: 'alpha.eth' } as any);
      await db.agents.updateMetadata(alpha.id, {
        ...(alpha.metadata as any),
        agent_account: '0xACCOUNT',
        ows_wallet: 'src-alpha', ows_address: '0xWALLET',
      });

      const exported = path.join(configDir, 'exported.yaml');
      expect((await run(`/export ${SOURCE_TEAM} ${exported}`)).body.ok).toBe(true);

      const imported = await run(`/import ${exported} --team ${NEW_TEAM}`);
      expect(imported.body.ok).toBe(true);

      const dstRows = await rowsOf(NEW_TEAM);
      const dst = dstRows.find((r) => r.name === 'alpha');
      expect(dst).toBeTruthy();
      expect(dst!.model).toBe('claude-haiku-4-5-20251001');
      expect((dst!.metadata as any).description).toBe('round trip me');

      // D9 / D10 survive.
      expect(dst!.token_id).toBe('agent-9');
      expect(dst!.domain).toBe('alpha.eth');
      expect((dst!.metadata as any).agent_account).toBe('0xACCOUNT');

      // D7: wallets are provisioning's job, never import's.
      expect((dst!.metadata as any).ows_wallet).toBeUndefined();
      expect((dst!.metadata as any).ows_address).toBeUndefined();
    });

    it('lands the org block on the NEW team ROW, not just in the file', async () => {
      // This is the requirement that stops import re-creating the bug 6b fixed.
      expect((await run(`/deploy ${writeConfig(SOURCE_TEAM, { org: true })}`)).body.ok).toBe(true);

      const exported = path.join(configDir, 'org-export.yaml');
      expect((await run(`/export ${SOURCE_TEAM} ${exported}`)).body.ok).toBe(true);
      expect((yaml.load(fs.readFileSync(exported, 'utf-8')) as any).org).toBeTruthy();

      expect((await run(`/import ${exported} --team ${NEW_TEAM}`)).body.ok).toBe(true);

      const newTeamId = await db.teams.getOrCreateTeamId(NEW_TEAM);
      const stored = (await db.teams.getConfig(newTeamId)).org as any;
      expect(stored?.groups?.engineering).toBeTruthy();
    });

    it('records last_config_path as the imported file', async () => {
      expect((await run(`/deploy ${writeConfig(SOURCE_TEAM)}`)).body.ok).toBe(true);
      const exported = path.join(configDir, 'lcp.yaml');
      await run(`/export ${SOURCE_TEAM} ${exported}`);
      await run(`/import ${exported} --team ${NEW_TEAM}`);

      const newTeamId = await db.teams.getOrCreateTeamId(NEW_TEAM);
      expect((await db.teams.getConfig(newTeamId)).last_config_path).toBe(exported);
    });
  });

  describe('inherited guarantees, asserted at the import entry point', () => {
    it('refuses importing onto an occupied team with the §4 409 contract', async () => {
      expect((await run(`/deploy ${writeConfig(SOURCE_TEAM)}`)).body.ok).toBe(true);
      const exported = path.join(configDir, 'collide.yaml');
      await run(`/export ${SOURCE_TEAM} ${exported}`);

      const collision = await run(`/import ${exported} --team ${SOURCE_TEAM}`);
      expect(collision.status).toBe(409);
      expect(collision.body.error).toBe('team_exists');
      expect(collision.body.message).toContain(SOURCE_TEAM);
    });

    it('mutates nothing on a refused import', async () => {
      expect((await run(`/deploy ${writeConfig(SOURCE_TEAM)}`)).body.ok).toBe(true);
      const exported = path.join(configDir, 'collide2.yaml');
      await run(`/export ${SOURCE_TEAM} ${exported}`);

      const snapshot = async () =>
        (await rowsOf(SOURCE_TEAM))
          .map((r) => JSON.stringify({ id: r.id, name: r.name, metadata: r.metadata }))
          .sort();

      const before = await snapshot();
      expect((await run(`/import ${exported} --team ${SOURCE_TEAM}`)).status).toBe(409);
      expect(await snapshot()).toEqual(before);
    });

    it('--team overrides the file team key', async () => {
      expect((await run(`/deploy ${writeConfig(SOURCE_TEAM)}`)).body.ok).toBe(true);
      const exported = path.join(configDir, 'override.yaml');
      await run(`/export ${SOURCE_TEAM} ${exported}`);
      // The file says SOURCE_TEAM; --team must win.
      expect((yaml.load(fs.readFileSync(exported, 'utf-8')) as any).team).toBe(SOURCE_TEAM);

      const body = (await run(`/import ${exported} --team ${NEW_TEAM}`)).body;
      expect(body.ok).toBe(true);
      expect(body.result.team).toBe(NEW_TEAM);
      expect((await rowsOf(NEW_TEAM)).map((r) => r.name)).toContain('alpha');
    });

    it('rejects a --team flag with no value', async () => {
      const exported = path.join(configDir, 'noval.yaml');
      fs.writeFileSync(exported, 'version: "1"\nteam: x\nagents: []\n');
      expect((await run(`/import ${exported} --team`)).body.ok).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// §5.2.3 avatar import. Unit-level: the mirror is untrusted input and the
// guards are the whole point, so they are exercised directly.
// ---------------------------------------------------------------------------

describe('importAvatars (§5.2.3)', () => {
  let tmp = '';
  let mirror = '';
  let profiles = '';
  let outside = '';

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-imp-')));
    mirror = path.join(tmp, 'configs', 'avatars');
    profiles = path.join(tmp, 'profiles');
    outside = path.join(tmp, 'outside');
    fs.mkdirSync(mirror, { recursive: true });
    fs.mkdirSync(profiles, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
  });
  afterEach(() => { if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; } });

  function seed(team: string, agent: string, ext = 'png', bytes = 8) {
    const dir = path.join(mirror, team, agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `avatar.${ext}`), Buffer.alloc(bytes));
    return dir;
  }

  it('places the avatar under the NEW team name', () => {
    seed('oldteam', 'ann');
    const { imported, warnings } = importAvatars('newteam', ['ann'], mirror, profiles, undefined, 'oldteam');
    expect(imported).toEqual([path.join(profiles, 'newteam', 'ann', 'avatar.png')]);
    expect(fs.existsSync(path.join(profiles, 'newteam', 'ann', 'avatar.png'))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('writes nothing outside PROFILES_ROOT for a traversing agent name', () => {
    seed('t', 'ann');
    const { imported, warnings } = importAvatars('t', ['../../evil'], mirror, profiles);
    expect(imported).toEqual([]);
    expect(warnings.join(' ')).toMatch(/safe-segment/);
    expect(fs.existsSync(path.join(tmp, 'evil'))).toBe(false);
  });

  it('refuses a traversing TEAM name too', () => {
    const { imported, warnings } = importAvatars('../../evil', ['ann'], mirror, profiles);
    expect(imported).toEqual([]);
    expect(warnings.join(' ')).toMatch(/safe-segment/);
  });

  it('refuses a symlink inside the mirror that points outside it', () => {
    fs.writeFileSync(path.join(outside, 'avatar.png'), Buffer.alloc(4));
    const dir = path.join(mirror, 't', 'sneaky');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(outside, 'avatar.png'), path.join(dir, 'avatar.png'));

    const { imported, warnings } = importAvatars('t', ['sneaky'], mirror, profiles);
    expect(imported).toEqual([]);
    expect(warnings.join(' ')).toMatch(/escapes the avatar mirror/);
  });

  it('skips an oversize avatar and warns — the mirror is not trusted', () => {
    seed('t', 'big', 'png', MAX_AVATAR_BYTES + 1);
    const { imported, warnings } = importAvatars('t', ['big'], mirror, profiles);
    expect(imported).toEqual([]);
    expect(warnings.join(' ')).toMatch(/exceeds/);
  });

  it('ignores a wrong-type file', () => {
    const dir = path.join(mirror, 't', 'giffy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'avatar.gif'), Buffer.alloc(4));
    expect(importAvatars('t', ['giffy'], mirror, profiles).imported).toEqual([]);
  });

  it('overwrites an existing destination avatar', () => {
    seed('t', 'ann', 'png', 16);
    const destDir = path.join(profiles, 't', 'ann');
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'avatar.png'), Buffer.alloc(1));

    importAvatars('t', ['ann'], mirror, profiles);
    expect(fs.statSync(path.join(destDir, 'avatar.png')).size).toBe(16);
  });

  it('is a no-op when the team has no avatars at all', () => {
    const { imported, warnings } = importAvatars('t', ['nobody'], mirror, profiles);
    expect(imported).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
