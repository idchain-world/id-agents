// SPDX-License-Identifier: MIT
/**
 * Spawn/deploy parity — SPEC §6.2 (commit 6).
 *
 * After commit 4 made /deploy create-only, spawn is the ONLY way to add an
 * agent to a live team. It was missing two things deploy does, so an agent
 * added to a running team came out subtly different from its siblings:
 * no wallet however the team was configured, and no org context.
 *
 * Fixtures only. getOrCreateAgentWallet is STUBBED — a test must never
 * provision a real OWS wallet — and no agent process is really spawned.
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

const TEAM = 'spawn-parity-team';

describe('POST /agents/spawn parity with deploy (§6.2)', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let configDir: string;
  let teamId: string;
  /** Every deploySkillsToAgent call, so org context can be inspected. */
  let skillCalls: Array<{ vars: Record<string, string>; opts: { hasWallet: boolean } }>;
  let walletCalls: Array<{ team: string; agent: string }>;

  // `members` matters: generateAgentOrgContext only emits for a group's lead or
  // a direct member, so the spawned agent has to actually be in the org.
  function writeTeamConfig(withOrg: boolean, members: string[] = ['alpha']): string {
    const p = path.join(configDir, `${TEAM}.yaml`);
    const orgBlock = withOrg
      ? `
org:
  groups:
    engineering:
      description: "Builds the thing"
      members: [${members.join(', ')}]
`
      : '';
    fs.writeFileSync(p, `version: "1"
team: ${TEAM}
${orgBlock}
agents:
  - name: alpha
    description: "seed"
`);
    return p;
  }

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-parity-')));
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-parity-cfg-')));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    skillCalls = [];
    walletCalls = [];

    (manager as any).spawnLocalAgentProcess = async () => ({ success: true, pid: 777, logFile: '/tmp/x.log' });
    (manager as any).copyPluginsToAgent = () => [];
    (manager as any).ensureRuntimeReady = () => undefined;
    (manager as any).deploySkillsToAgent = (_dir: string, _skills: string[], vars: Record<string, string>, opts: { hasWallet: boolean }) => {
      skillCalls.push({ vars, opts });
    };
    // NEVER shell out to the real `ows` CLI from a test.
    (manager as any).getOrCreateAgentWallet = (team: string, agent: string) => {
      walletCalls.push({ team, agent });
      return { walletName: `${team}-${agent}`, address: '0xFIXTURE' };
    };

    await manager.start(port);
    teamId = await db.teams.getOrCreateTeamId(TEAM);
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

  async function spawn(name: string, extra: Record<string, unknown> = {}) {
    const resp = await fetch(`${baseUrl}/agents/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM, 'X-Id-Admin': '1' },
      body: JSON.stringify({ name, type: 'claude', model: 'claude-haiku-4-5-20251001', ...extra }),
    });
    return { status: resp.status, body: await resp.json().catch(() => ({})) as any };
  }

  async function metadataOf(name: string) {
    const row = (await db.agents.listAll(teamId)).find((r) => r.name === name);
    return (row?.metadata || {}) as Record<string, unknown>;
  }

  describe('wallet (deploy provisions on wallet:true; spawn did not)', () => {
    it('spawn with wallet:true gets ows_wallet AND ows_address', async () => {
      const { status } = await spawn('withwallet', { wallet: true });
      expect(status).toBeLessThan(400);

      const meta = await metadataOf('withwallet');
      expect(meta.ows_wallet).toBe(`${TEAM}-withwallet`);
      expect(meta.ows_address).toBe('0xFIXTURE');
      expect(meta.wallet).toBe(true);
      // Provisioned with the same (team, agentName) key deploy uses.
      expect(walletCalls).toEqual([{ team: TEAM, agent: 'withwallet' }]);
    });

    it('spawn without wallet:true gets neither field', async () => {
      const { status } = await spawn('nowallet');
      expect(status).toBeLessThan(400);

      const meta = await metadataOf('nowallet');
      expect(meta.ows_wallet).toBeUndefined();
      expect(meta.ows_address).toBeUndefined();
      // And the ows CLI was never reached at all.
      expect(walletCalls).toEqual([]);
    });

    it('wallet:false is recorded as an explicit opt-out, and provisions nothing', async () => {
      await spawn('optout', { wallet: false });
      const meta = await metadataOf('optout');
      expect(meta.wallet).toBe(false);
      expect(meta.ows_wallet).toBeUndefined();
      expect(walletCalls).toEqual([]);
    });

    it('tells the skills layer whether the agent has a wallet', async () => {
      await spawn('flagged', { wallet: true, skills: ['some-skill'] });
      expect(skillCalls.at(-1)?.opts.hasWallet).toBe(true);
    });
  });

  describe('org context (deploy passes it; spawn passed an empty string)', () => {
    it('a spawn into an org team receives org context in its skills', async () => {
      await db.teams.updateConfig(teamId, { last_config_path: writeTeamConfig(true, ['orgagent', 'alpha']) });

      const { status } = await spawn('orgagent', { skills: ['some-skill'] });
      expect(status).toBeLessThan(400);

      const call = skillCalls.at(-1);
      expect(call).toBeTruthy();
      expect(call!.vars.ORG_CONTEXT).toContain('## Your Role');
      expect(call!.vars.ORG_CONTEXT).toContain('engineering');
    });

    it('a spawn into a NON-org team receives no org context', async () => {
      await db.teams.updateConfig(teamId, { last_config_path: writeTeamConfig(false) });

      await spawn('plainagent', { skills: ['some-skill'] });
      expect(skillCalls.at(-1)?.vars.ORG_CONTEXT).toBe('');
    });

    it('delivers org context even when the spawn requests no skills', async () => {
      // Deploy always calls deploySkillsToAgent, so context always lands there.
      // Spawn only called it when skills were requested, which would have
      // dropped the context for a skill-less spawn.
      await db.teams.updateConfig(teamId, { last_config_path: writeTeamConfig(true, ['noskills', 'alpha']) });

      await spawn('noskills');
      expect(skillCalls.at(-1)?.vars.ORG_CONTEXT).toContain('engineering');
    });

    it('still spawns when the team config file has been moved away', async () => {
      // Org context is best-effort: a missing config must not fail the spawn.
      await db.teams.updateConfig(teamId, { last_config_path: path.join(configDir, 'gone.yaml') });

      const { status } = await spawn('survivor', { skills: ['some-skill'] });
      expect(status).toBeLessThan(400);
      expect(skillCalls.at(-1)?.vars.ORG_CONTEXT).toBe('');
    });
  });
});
