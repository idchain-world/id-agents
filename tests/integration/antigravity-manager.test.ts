// SPDX-License-Identifier: MIT
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it, expect, vi } from 'vitest';
import { createDb, migrateDb } from '../../src/db.js';
// Exercise the shipped manager: it starts local-agent-server.js beside its module.
import { AgentManagerDb } from '../../dist/agent-manager-db.js';

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

it('boots a manager-created worker and round-trips Antigravity through the manager', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-manager-'));
  const name = 'agy-' + Date.now();
  const binary = path.join(dir, 'agy');
  writeFileSync(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('fake-agy');
else if (args.includes('-p=/usage')) console.log('{"status":"SUCCESS"}');
else console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:JSON.stringify({
  runtime:process.env.ID_HARNESS, model:args[args.indexOf('--model')+1], manager:process.env.MANAGER_URL
}),usage:{input_tokens:3,output_tokens:2,total_tokens:5}}}));
`, { mode: 0o755 });
  vi.stubEnv('SQLITE_PATH', path.join(dir, 'test.db'));
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-fixture');
  vi.stubEnv('ID_WORKSPACE_DIR', dir);
  vi.stubEnv('ID_AGENT_PORT_BASE', String(await unusedPort()));
  vi.stubEnv('AGY_PATH', binary);
  vi.stubEnv('ID_AGY_GEMINI_DIR', path.join(dir, 'state'));
  vi.stubEnv('ID_AGY_USE_API_KEY', 'false');
  const db = await createDb();
  await migrateDb(db);
  const manager = new AgentManagerDb(dir, db);
  // Port availability is checked by the worker. Never signal a pre-existing listener.
  vi.spyOn(manager as any, 'killAgentProcess').mockResolvedValue({});
  const port = await unusedPort();
  const url = 'http://127.0.0.1:' + port;
  const headers = { 'Content-Type': 'application/json', 'X-Id-Team': 'agy-test' };
  const post = async (route: string, data: unknown) => (await fetch(url + route, {
    method: 'POST', headers, body: JSON.stringify(data),
  })).json() as Promise<any>;
  const remote = async (command: string) => post('/remote', { command });
  const log = '/tmp/' + name + '.log';
  let pid: number | undefined;
  try {
    await manager.start(port);
    const cli = (args: string[]) => promisify(execFile)(process.execPath, [
      path.resolve('dist/interactive-agent-cli.js'), 'spawn', ...args,
    ], { env: { ...process.env, MANAGER_URL: url, ID_TEAM: 'agy-test' } });
    const team = await db.teams.getOrCreateTeamId('agy-test');
    const worker = await post('/agents/spawn', { name, runtime: 'antigravity', model: 'hydrogen', effort: 'low' });
    expect((await remote('/agent ' + worker.id + ' start')).ok).toBe(true);
    const row = (await db.agents.list(team)).find(a => a.name === name)!;
    pid = Number(row.metadata?.pid);
    await vi.waitFor(async () => expect((await fetch(row.endpoint + '/catalog')).ok).toBe(true), { timeout: 10000 });
    const talk = await fetch(row.endpoint + '/talk', {
      method: 'POST', headers, body: JSON.stringify({ message: 'report' }),
    });
    const { query_id } = await talk.json() as any;
    await vi.waitFor(async () => {
      const query = await db.queries.getById(row.id, query_id);
      expect(query?.status).toBe('completed');
      expect(query?.result?.usage).toEqual({ input_tokens: 3, output_tokens: 2, total_tokens: 5 });
      expect(query?.result?.model).toBe('gemini-4-hydrogen-low');
      expect(JSON.parse(String(query?.result?.result))).toEqual({ runtime: 'antigravity-cli', model: query?.result?.model, manager: url });
    }, { timeout: 10000 });
    expect(readFileSync(log, 'utf8')).toContain('[Query ' + query_id + '] usage=');

    // The remaining paths check registration, preflight and the launch arguments.
    const launches = new Map<string, Record<string, string>>();
    vi.spyOn(manager as any, 'spawnLocalAgentProcess').mockImplementation(async (teamId, teamName, agent: any) => {
      const row = await db.agents.getById(agent.id);
      launches.set(teamName + '/' + agent.name, (manager as any).buildLocalAgentEnv(teamName, agent.port, row, agent.model));
      return { success: true };
    });
    await cli(['pinned', 'carbon-low', '--runtime', 'antigravity-cli']);
    const direct = await post('/agents/spawn', { name: 'overlay', runtime: 'antigravity-cli',
      model: 'argon-medium', effort: 'low', dangerouslySkipPermissions: false, agent: 'editor', skills: ['catalog'] });
    const persona = readFileSync(path.join(direct.workingDirectory, 'AGENTS.md'), 'utf8');
    expect(persona).toContain('agent:editor');
    for (const skill of ['identity', 'inter-agent', 'catalog']) {
      expect(readFileSync(path.join(direct.workingDirectory, '.agents/skills', skill, 'SKILL.md'), 'utf8')).toContain(skill);
    }
    expect((await post('/agents/spawn', { name: 'automatic', runtime: 'antigravity' })).model).toBe('neon');
    expect((await remote('/model overlay neon-xhigh')).result.model).toBe('gemini-4-neon-xhigh');
    const mismatch = (await post('/agents/spawn', { name: 'bad', runtime: 'antigravity', model: 'opus' })).error;
    expect((await remote('/model overlay opus')).error).toBe(mismatch);
    expect((await post('/agents/' + direct.id + '/model', { model: 'opus' })).error).toBe(mismatch);
    expect((await remote('/update overlay --runtime claude-code-cli')).error).toMatch(/requires runtime/);
    expect((await post('/agents/' + direct.id + '/model', { model: 'neon-high' })).model).toBe('gemini-4-neon-high');
    expect((await remote('/model overlay neon-xhigh')).ok).toBe(true);
    const claude = await post('/agents/spawn', { name: 'claude-worker', runtime: 'claude-agent-sdk', model: 'opus' });
    expect(claude.id).toBeTruthy();
    expect((await remote('/model claude-worker neon')).error).toMatch(/requires runtime/);
    expect((await post('/agents/spawn', { name: 'invalid', runtime: 'antigravity', model: 'carbon', effort: 'xhigh' })).error).toMatch(/supported by carbon/);
    const target = path.join(dir, 'exported.yaml');
    expect((await remote('/export agy-test ' + target)).ok).toBe(true);
    expect((await remote('/import ' + target + ' --team imported')).ok).toBe(true);
    const imported = await db.agents.list(await db.teams.getOrCreateTeamId('imported'));
    expect(imported.find(a => a.name === 'overlay')).toMatchObject({ runtime: 'antigravity-cli',
      model: 'gemini-4-neon-xhigh', metadata: { effort: 'low', dangerouslySkipPermissions: false } });
    const config = path.join(dir, 'deploy.yaml');
    writeFileSync(config, 'version: "1"\nteam: deploy-agy\nagents:\n  - name: defaulted\n    runtime: antigravity\n  - name: pinned\n    runtime: antigravity-cli\n    model: hydrogen-xhigh\n');
    const deployed = await remote('/deploy ' + config);
    expect(deployed.ok, JSON.stringify(deployed)).toBe(true);
    expect((await db.agents.list(await db.teams.getOrCreateTeamId('deploy-agy'))).map(a => a.model).sort())
      .toEqual(['hydrogen-xhigh', 'neon']);
    for (const [key, model] of Object.entries({
      'agy-test/pinned': 'gemini-4-carbon-low',
      'imported/automatic': 'gemini-4-neon-high',
      'imported/overlay': 'gemini-4-neon-xhigh',
      'deploy-agy/defaulted': 'gemini-4-neon-high',
      'deploy-agy/pinned': 'gemini-4-hydrogen-xhigh',
    })) {
      expect(launches.get(key)).toMatchObject({ ID_HARNESS: 'antigravity-cli', CLAUDE_MODEL: model });
    }
  } finally {
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await manager.shutdown();
    await db.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(log, { force: true });
    rmSync(dir, { force: true, recursive: true });
  }
});
