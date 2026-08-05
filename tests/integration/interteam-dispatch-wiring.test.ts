// SPDX-License-Identifier: MIT
/**
 * Commit 9/10 fix-forward: the processor's production dispatcher must
 * actually wake a runtime. A `queries` row alone does not; the manager
 * forwards to the handling agent's `/talk` exactly as `/talk-to` does, then
 * repoints the durable job at the runtime's own query ID so completion is
 * observed by the reconciler and replies route normally.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import express from 'express';
import type { Server } from 'node:http';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let workDir: string;
let db: any;
let manager: AgentManagerDb;
let baseUrl: string;
let fakeRuntime: Server;
let runtimePort: number;
const talkCalls: Array<{ message: string; from: string }> = [];
const RUNTIME_QUERY_ID = 'runtime_query_abc';

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interteam-wiring-'));

  // A stand-in agent runtime that answers /talk like a real worker.
  runtimePort = await freePort();
  const app = express();
  app.use(express.json());
  app.post('/talk', (req, res) => {
    talkCalls.push({ message: req.body?.message, from: req.body?.from });
    res.json({ query_id: RUNTIME_QUERY_ID, status: 'accepted' });
  });
  fakeRuntime = await new Promise<Server>((resolve) => {
    const server = app.listen(runtimePort, '127.0.0.1', () => resolve(server));
  });

  const adapter = new SqliteAdapter(path.join(workDir, 'wiring.db'));
  await migrateSqlite(adapter);
  db = {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    async close() { await adapter.close(); },
  };

  const managerPort = await freePort();
  baseUrl = `http://127.0.0.1:${managerPort}`;
  manager = new AgentManagerDb(workDir, db);
  await manager.start(managerPort);
}, 30000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    (manager as any).interteamTimer && clearInterval((manager as any).interteamTimer);
    (manager as any).httpServer?.close(() => resolve());
    setTimeout(resolve, 1000);
  });
  await new Promise<void>((resolve) => fakeRuntime.close(() => resolve()));
  await db.close();
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('production inter-team dispatch wiring', () => {
  it('forwards accepted work to the agent runtime and repoints the durable job', async () => {
    const originTeam = await db.teams.getOrCreateTeamId('wiring-origin');
    const destTeam = await db.teams.getOrCreateTeamId('wiring-dest');
    const callerId = `agent-${randomUUID()}`;
    const handlerId = `agent-${randomUUID()}`;
    await db.adapter.query(
      `INSERT INTO agents (id, team_id, name, type, model, port, endpoint, status, created_at, metadata, runtime)
       VALUES (?, ?, 'caller', 'claude', 'model', 0, NULL, 'running', ?, '{}', 'codex')`,
      [callerId, originTeam, Date.now()],
    );
    await db.adapter.query(
      `INSERT INTO agents (id, team_id, name, type, model, port, endpoint, status, created_at, metadata, runtime)
       VALUES (?, ?, 'handler', 'virtual', 'external', ?, ?, 'running', ?, ?, 'agent-remote')`,
      [
        handlerId, destTeam, runtimePort, `http://127.0.0.1:${runtimePort}`, Date.now(),
        JSON.stringify({ internal_url: `http://127.0.0.1:${runtimePort}`, mesh_member: true }),
      ],
    );

    const nodeId = (await db.adapter.query(`SELECT node_id FROM manager_identity`)).rows[0].node_id;
    const admin = (team: string) => ({
      'Content-Type': 'application/json', 'X-Id-Admin': '1', 'X-Id-Team': team,
    });
    await fetch(`${baseUrl}/inter-team/config/policy`, {
      method: 'PUT', headers: admin('wiring-dest'), body: JSON.stringify({ policy: 'open' }),
    });
    await fetch(`${baseUrl}/inter-team/config/contacts`, {
      method: 'POST',
      headers: admin('wiring-origin'),
      body: JSON.stringify({ aliasDisplay: 'peer', remoteNodeId: nodeId, remoteTeamId: destTeam }),
    });

    const send = await fetch(`${baseUrl}/inter-team/send`, {
      method: 'POST',
      headers: { ...admin('wiring-origin'), 'X-Id-Agent': callerId },
      body: JSON.stringify({ address: 'team:peer/handler', body: { ask: 'real-work' } }),
    });
    expect(send.status).toBe(202);
    const sent = await send.json() as { conversationId: string; messageId: string };

    // The send route kicks a scan without blocking its 202, so wait for the
    // dispatch to land rather than assuming it already has.
    const link = await waitFor(async () => {
      const rows = (await db.adapter.query(
        `SELECT local_query_id FROM interteam_processing`,
      )).rows;
      return rows[0]?.local_query_id === RUNTIME_QUERY_ID ? rows[0] : null;
    });

    // The runtime was actually called — a queries row alone would not do this.
    expect(talkCalls).toHaveLength(1);
    expect(JSON.parse(talkCalls[0]!.message)).toEqual({ ask: 'real-work' });
    expect(talkCalls[0]!.from).toBe('inter-team');
    expect(link.local_query_id).toBe(RUNTIME_QUERY_ID);
    const job = (await db.adapter.query(
      `SELECT query_id, agent_id FROM queries WHERE query_id = ?`, [RUNTIME_QUERY_ID],
    )).rows[0];
    expect(job).toMatchObject({ query_id: RUNTIME_QUERY_ID, agent_id: handlerId });

    // Completing that runtime query completes the inter-team message.
    await db.adapter.query(
      `UPDATE queries SET status = 'completed', completed = ?, result = ? WHERE query_id = ?`,
      [Date.now(), JSON.stringify({ done: true }), RUNTIME_QUERY_ID],
    );
    await fetch(`${baseUrl}/inter-team/scan`, { method: 'POST', headers: admin('wiring-origin') });

    const collected = await fetch(
      `${baseUrl}/inter-team/conversations/${sent.conversationId}/messages/${sent.messageId}`,
      { headers: { ...admin('wiring-origin'), 'X-Id-Agent': callerId } },
    );
    expect(collected.status).toBe(200);
    expect(await collected.json()).toMatchObject({
      state: 'completed', result: { done: true }, resultPresent: true,
    });
  }, 20000);
});
