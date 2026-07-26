// SPDX-License-Identifier: MIT
/**
 * Agent profile (bio + handles) integration test.
 *
 * Proves that:
 *   1. `bio:` and `handles:` on a deploy YAML agent entry land in
 *      `agents.metadata.bio` / `agents.metadata.handles` on deploy.
 *   2. Deploy records the config path in the team config
 *      (`last_config_path`) so runtime profile edits can persist.
 *   3. `POST /agents/by-name/:name/profile` validates input, updates the
 *      agent record, and surgically writes bio/handles back to the YAML —
 *      preserving comments — so a REDEPLOY of the same file keeps the edit.
 *   4. `null` clears a field from both the record and the YAML.
 *
 * Harness pattern follows tests/integration/deploy-catalog-seed.test.ts:
 * in-memory SQLite, real AgentManagerDb, stubbed process spawn.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as net from 'net';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { AgentRestServer } from '../../src/agent-rest-server.js';
import { InteractiveAgentServer } from '../../src/interactive-agent-server.js';
import { writeProfileToConfig } from '../../src/lib/profile-config-write.js';
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

const TEST_TEAM = 'profile-bio-test';
const AGENT = 'profiledev';

function deployYaml(agentDir: string): string {
  return `version: "1"
team: ${TEST_TEAM}

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-haiku-4-5-20251001

# keep-me: comment preservation sentinel
agents:
  - name: ${AGENT}
    description: "Profile test seed"
    workingDirectory: ${agentDir}
    bio: "Original YAML bio."
    handles:
      x: "@profiledev"
`;
}

function adminHeaders(team: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    'X-Id-Admin': '1',
  };
}

describe('agent profile bio/handles integration', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let workDir: string;
  let baseUrl: string;
  let configDir: string;
  let yamlPath: string;

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-int-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-cfg-'));
    const agentDir = path.join(configDir, 'agent-workdir');
    fs.mkdirSync(agentDir);
    yamlPath = path.join(configDir, 'team.yaml');
    fs.writeFileSync(yamlPath, deployYaml(agentDir));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    (manager as any).spawnLocalAgentProcess = async () => ({ success: true, pid: 12345, logFile: '/tmp/profile-int.log' });
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

  async function deploy() {
    const resp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders(TEST_TEAM),
      body: JSON.stringify({ command: `/deploy ${yamlPath}` }),
    });
    expect(resp.ok).toBe(true);
    const body = await resp.json() as any;
    if (!body.ok) throw new Error(`/deploy returned not-ok: ${JSON.stringify(body)}`);
    return body.result;
  }

  async function readAgentRow() {
    const teamId = await db.teams.getOrCreateTeamId(TEST_TEAM);
    const row = await db.agents.getByName(teamId, AGENT);
    if (!row) throw new Error(`agent row not found for ${AGENT}`);
    return row;
  }

  async function postProfile(body: unknown) {
    return fetch(`${baseUrl}/agents/by-name/${AGENT}/profile`, {
      method: 'POST',
      headers: adminHeaders(TEST_TEAM),
      body: JSON.stringify(body),
    });
  }

  it('deploy seeds metadata.bio/handles and records last_config_path', async () => {
    await deploy();
    const row = await readAgentRow();
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.bio).toBe('Original YAML bio.');
    expect(meta.handles).toEqual({ x: '@profiledev' });

    const teamId = await db.teams.getOrCreateTeamId(TEST_TEAM);
    const teamConfig = await db.teams.getConfig(teamId);
    expect(teamConfig.last_config_path).toBe(yamlPath);
  });

  it('profile POST updates the record, writes back to YAML preserving comments, and survives redeploy', async () => {
    await deploy();

    const resp = await postProfile({
      bio: 'Edited via the dashboard.',
      handles: { x: '@edited', github: 'edited-gh' },
    });
    expect(resp.ok).toBe(true);
    const body = await resp.json() as any;
    expect(body.persistedToConfig).toBe(true);
    expect(body.bio).toBe('Edited via the dashboard.');
    expect(body.handles).toEqual({ x: '@edited', github: 'edited-gh' });

    // Record updated…
    const meta = (await readAgentRow()).metadata as Record<string, unknown>;
    expect(meta.bio).toBe('Edited via the dashboard.');
    // …YAML updated surgically, comment sentinel intact…
    const yamlText = fs.readFileSync(yamlPath, 'utf-8');
    expect(yamlText).toContain('Edited via the dashboard.');
    expect(yamlText).toContain('edited-gh');
    expect(yamlText).toContain('# keep-me: comment preservation sentinel');
    // …and a redeploy of the same file keeps the edited profile (YAML floor).
    await deploy();
    const meta2 = (await readAgentRow()).metadata as Record<string, unknown>;
    expect(meta2.bio).toBe('Edited via the dashboard.');
    expect(meta2.handles).toEqual({ x: '@edited', github: 'edited-gh' });
  });

  it('null clears a field from both record and YAML', async () => {
    await deploy();
    const resp = await postProfile({ handles: null });
    expect(resp.ok).toBe(true);
    const meta = (await readAgentRow()).metadata as Record<string, unknown>;
    expect(meta.handles).toBeUndefined();
    expect(meta.bio).toBe('Original YAML bio.'); // untouched field survives
    expect(fs.readFileSync(yamlPath, 'utf-8')).not.toContain('handles:');
  });

  it('rejects invalid bio/handles and empty bodies', async () => {
    await deploy();
    expect((await postProfile({})).status).toBe(400);
    expect((await postProfile({ bio: 42 })).status).toBe(400);
    expect((await postProfile({ bio: 'x'.repeat(2001) })).status).toBe(400);
    expect((await postProfile({ handles: ['x'] })).status).toBe(400);
    expect((await postProfile({ handles: { 'bad key!': 'v' } })).status).toBe(400);
    // record unchanged after rejected writes
    const meta = (await readAgentRow()).metadata as Record<string, unknown>;
    expect(meta.bio).toBe('Original YAML bio.');
    expect(meta.handles).toEqual({ x: '@profiledev' });
  });

  // A bare "Agent not found" reads identically whether the name is wrong, the
  // team is wrong, or the agent is gone. Naming the searched team is what turns
  // a multi-agent investigation back into a one-line misconfiguration.
  describe('agent-not-found names the team that was searched', () => {
    it('names an explicitly-supplied wrong team on the profile route', async () => {
      await deploy();
      const resp = await fetch(`${baseUrl}/agents/by-name/${AGENT}/profile`, {
        method: 'POST',
        headers: adminHeaders('some-other-team'),
        body: JSON.stringify({ bio: 'from the wrong team' }),
      });
      expect(resp.status).toBe(404);
      const body = await resp.json() as { error: string };
      expect(body.error).toContain('some-other-team');
      expect(body.error).toContain(AGENT);
      // Same request, correct team — proves the 404 was scope, not the name.
      expect((await postProfile({ bio: 'from the right team' })).ok).toBe(true);
    });

    it('names the "default" fallback when the caller sends no team header', async () => {
      await deploy();
      // Exactly the desktop-app bug: no X-Id-Team, so getTeamName falls back.
      // Clear the env inputs that outrank the fallback so 'default' is
      // deterministic under any runner environment.
      const prevTeam = process.env.ID_TEAM;
      const prevProject = process.env.ID_PROJECT;
      delete process.env.ID_TEAM;
      delete process.env.ID_PROJECT;
      try {
        const resp = await fetch(`${baseUrl}/agents/by-name/${AGENT}/profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bio: 'from a team-less caller' }),
        });
        expect(resp.status).toBe(404);
        const body = await resp.json() as { error: string };
        expect(body.error).toContain('default');
      } finally {
        if (prevTeam === undefined) delete process.env.ID_TEAM; else process.env.ID_TEAM = prevTeam;
        if (prevProject === undefined) delete process.env.ID_PROJECT; else process.env.ID_PROJECT = prevProject;
      }
    });

    // The sweep: every team-scoped agent lookup in the manager, not just the
    // one route that was reported.
    const WRONG_TEAM = 'no-such-team';
    const MISSING_ID = 'agent_does_not_exist';
    const MISSING_NAME = 'nosuchagent';
    const scopedLookups: Array<{ label: string; method: string; path: string; body?: unknown; ref: string }> = [
      { label: 'GET /agents/by-name/:name', method: 'GET', path: `/agents/by-name/${MISSING_NAME}`, ref: MISSING_NAME },
      { label: 'POST /agents/by-name/:name/metadata', method: 'POST', path: `/agents/by-name/${MISSING_NAME}/metadata`, body: { metadata: {} }, ref: MISSING_NAME },
      { label: 'POST /agents/by-name/:name/profile', method: 'POST', path: `/agents/by-name/${MISSING_NAME}/profile`, body: { bio: 'x' }, ref: MISSING_NAME },
      { label: 'DELETE /agents/by-name/:name', method: 'DELETE', path: `/agents/by-name/${MISSING_NAME}`, ref: MISSING_NAME },
      { label: 'GET /agents/:id', method: 'GET', path: `/agents/${MISSING_ID}`, ref: MISSING_ID },
      { label: 'POST /agents/:id/metadata', method: 'POST', path: `/agents/${MISSING_ID}/metadata`, body: { metadata: {} }, ref: MISSING_ID },
      { label: 'PATCH /agents/:id/metadata', method: 'PATCH', path: `/agents/${MISSING_ID}/metadata`, body: { wallet: '0xabc' }, ref: MISSING_ID },
      { label: 'POST /agents/:id/model', method: 'POST', path: `/agents/${MISSING_ID}/model`, body: { model: 'claude-haiku-4-5-20251001' }, ref: MISSING_ID },
      { label: 'POST /agents/:id/probe', method: 'POST', path: `/agents/${MISSING_ID}/probe`, body: {}, ref: MISSING_ID },
      { label: 'DELETE /agents/:id', method: 'DELETE', path: `/agents/${MISSING_ID}`, ref: MISSING_ID },
    ];

    it.each(scopedLookups)('$label names the team', async ({ method, path: routePath, body, ref }) => {
      await deploy();
      const resp = await fetch(`${baseUrl}${routePath}`, {
        method,
        headers: adminHeaders(WRONG_TEAM),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(resp.status).toBe(404);
      const parsed = await resp.json() as { error: string };
      expect(parsed.error).toContain(WRONG_TEAM);
      expect(parsed.error).toContain(ref);
    });

    it('leaves the reserved-name guard bare — it searched no team', async () => {
      await deploy();
      const resp = await fetch(`${baseUrl}/agents/by-name/manager`, {
        headers: adminHeaders(TEST_TEAM),
      });
      expect(resp.status).toBe(404);
      // Rejected before any lookup, so the message must not claim a team scope.
      expect((await resp.json() as { error: string }).error).not.toContain(TEST_TEAM);
    });
  });

  it('keeps /agents metadata, /catalog, and restap.json consistent after a profile edit', async () => {
    await deploy();
    const edited = { bio: 'Consistency bio.', handles: { ENS: 'profiledev.eth', x: '@edited' } };
    expect((await postProfile(edited)).ok).toBe(true);

    // Boot a REAL AgentRestServer (the /catalog + restap server every claude/
    // local agent runs) pointed at this manager via env, AFTER the edit so the
    // first self-lookup already sees the new values (no TTL wait).
    const prevManagerUrl = process.env.MANAGER_URL;
    const prevTeam = process.env.ID_TEAM;
    process.env.MANAGER_URL = baseUrl;
    process.env.ID_TEAM = TEST_TEAM;
    const agentServer = new AgentRestServer({
      agentName: AGENT,
      workingDirectory: process.cwd(),
      sharedDirectory: process.cwd(),
    } as never);
    try {
      await agentServer.start(0);
      const port = ((agentServer as never as { httpServer: { address(): { port: number } } }).httpServer.address()).port;
      const agentUrl = `http://127.0.0.1:${port}`;

      const managerView = await (await fetch(`${baseUrl}/agents`, { headers: adminHeaders(TEST_TEAM) })).json() as any;
      const managerMeta = (managerView.agents as Array<{ name: string; metadata: Record<string, unknown> }>)
        .find((a) => a.name === AGENT)!.metadata;
      const catalogView = await (await fetch(`${agentUrl}/catalog`)).json() as any;
      const restapView = await (await fetch(`${agentUrl}/.well-known/restap.json`)).json() as any;

      // All three views agree on the same source of truth.
      expect(managerMeta.bio).toEqual(edited.bio);
      expect(managerMeta.handles).toEqual(edited.handles);
      expect(catalogView.bio).toEqual(edited.bio);
      expect(catalogView.handles).toEqual(edited.handles);
      expect(restapView.agent.profile).toEqual(edited);
    } finally {
      await agentServer.stop();
      if (prevManagerUrl === undefined) delete process.env.MANAGER_URL; else process.env.MANAGER_URL = prevManagerUrl;
      if (prevTeam === undefined) delete process.env.ID_TEAM; else process.env.ID_TEAM = prevTeam;
    }
  });

  it('publishes bio/handles in /.well-known/restap.json after a profile edit', async () => {
    await deploy();

    // A real agent-side server doing TTL-cached self-lookup against this
    // REAL manager (the same publication path human/interactive agents use;
    // claude-agent-server additionally prefers pushed identity metadata).
    const agentPort = await findFreePort();
    const agentServer = new InteractiveAgentServer(AGENT, agentPort, {
      managerUrl: baseUrl,
      team: TEST_TEAM,
      profileTtlMs: 50,
    });
    await agentServer.start();
    try {
      const catalog1 = await (await fetch(`http://127.0.0.1:${agentPort}/.well-known/restap.json`)).json() as any;
      expect(catalog1.agent.profile).toEqual({
        bio: 'Original YAML bio.',
        handles: { x: '@profiledev' },
      });

      const resp = await postProfile({ bio: 'Edited for restap.', handles: { x: '@edited' } });
      expect(resp.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 120)); // pass the profile TTL

      const catalog2 = await (await fetch(`http://127.0.0.1:${agentPort}/.well-known/restap.json`)).json() as any;
      expect(catalog2.agent.profile).toEqual({
        bio: 'Edited for restap.',
        handles: { x: '@edited' },
      });
    } finally {
      await agentServer.close();
    }
  });
});

describe('writeProfileToConfig unit behavior', () => {
  let tmpDir = '';
  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  function writeFixture(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-write-'));
    const p = path.join(tmpDir, 'cfg.yaml');
    fs.writeFileSync(p, content);
    return p;
  }

  it('fails cleanly on missing file, missing agents list, and unknown agent', () => {
    expect(writeProfileToConfig('/nope/absent.yaml', 'a', { bio: 'x' }).ok).toBe(false);
    const noAgents = writeFixture('version: "1"\nname: t\n');
    expect(writeProfileToConfig(noAgents, 'a', { bio: 'x' }).reason).toMatch(/no agents list/);
    fs.writeFileSync(noAgents, 'version: "1"\nagents:\n  - name: other\n');
    expect(writeProfileToConfig(noAgents, 'a', { bio: 'x' }).reason).toMatch(/not found/);
  });

  it('edits only the target entry and leaves neighbors + comments untouched', () => {
    const p = writeFixture([
      'version: "1"',
      '# team comment',
      'agents:',
      '  - name: one',
      '    bio: keep-one',
      '  - name: two   # inline comment',
      '',
    ].join('\n'));
    const result = writeProfileToConfig(p, 'two', { bio: 'new-two', handles: { x: '@two' } });
    expect(result.ok).toBe(true);
    const text = fs.readFileSync(p, 'utf-8');
    expect(text).toContain('bio: keep-one');
    expect(text).toContain('new-two');
    expect(text).toContain('# team comment');
    expect(text).toContain('# inline comment');
    expect(text).toContain('x: "@two"');
  });
});
