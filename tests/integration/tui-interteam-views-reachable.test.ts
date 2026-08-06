// SPDX-License-Identifier: MIT
/**
 * The three inter-team screens are reachable from the app's own navigation.
 *
 * This exists because the previous state was worse than a bug: the views were
 * built and tested but nothing imported them, so running the TUI they simply
 * did not exist. The gate here renders the real App against a real manager and
 * presses the real keys, so "wired in" is proven by navigation, not by import
 * statements.
 *
 * Also proven at app level: a probe against a dead peer renders `unreachable`
 * as a row state with no error dialog, and the inter-team requests stop when
 * the operator navigates away (the manager sees no such traffic while the
 * agents view is showing).
 */
import React from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { render } from 'ink';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';

// ── ink harness: fake TTY streams so the real App renders and takes keys ────
class FakeStdout extends EventEmitter {
  columns = 110;
  rows = 32;
  frames: string[] = [];
  write(chunk: string): boolean {
    this.frames.push(String(chunk));
    return true;
  }
  lastFrame(): string {
    // Strip ANSI so assertions read the text an operator reads.
    // eslint-disable-next-line no-control-regex
    return (this.frames[this.frames.length - 1] ?? '').replace(/\[[0-9;]*[A-Za-z]/g, '');
  }
}
class FakeStdin extends EventEmitter {
  // ink 5 pulls input: it listens for 'readable' and drains with read().
  private queue: string[] = [];
  isTTY = true;
  setRawMode(): void {}
  setEncoding(): void {}
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  press(key: string): void {
    this.queue.push(key);
    this.emit('readable');
    // If the press raced ink's listener attachment the event is lost but the
    // key is still queued; nudge again shortly so it drains.
    setTimeout(() => {
      if (this.queue.length > 0) this.emit('readable');
    }, 100);
  }
}

async function findFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

const admin = (team: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  'X-Id-Team': team,
  'X-Id-Admin': '1',
});

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}\n--- last frame ---\n${lastFrameForDiagnostics()}`);
}

let lastFrameForDiagnostics: () => string = () => '(no renderer yet)';

let manager: AgentManagerDb;
let managerUrl: string;
let workDir: string;
let proxy: http.Server;
let proxyUrl: string;
/** Every path the TUI asked the manager for, in order, via the proxy. */
const requested: string[] = [];

beforeAll(async () => {
  // The manager runs in-process, and a developer shell often carries ID_TEAM.
  // Left set, every headerless request resolves to that team, which does not
  // exist in this fresh database, and the whole app reads as empty.
  delete process.env.ID_TEAM;
  delete process.env.ID_PROJECT;
  const port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-interteam-views-'));
  managerUrl = `http://127.0.0.1:${port}`;

  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  const db = {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    async close() { await adapter.close(); },
  };
  manager = new AgentManagerDb(workDir, db as never);
  await manager.start(port);
  await db.teams.getOrCreateTeamId('default');

  // One peer route to a dead port, so the probe genuinely fails, and one
  // contact pinned to it, so the reachability join has something to say.
  const routePut = await fetch(`${managerUrl}/inter-team/config/peer-routes/peer-node-1`, {
    method: 'PUT',
    headers: admin('default'),
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9' }),
  });
  expect(routePut.status, await routePut.clone().text()).toBeLessThan(300);
  const contactPost = await fetch(`${managerUrl}/inter-team/config/contacts`, {
    method: 'POST',
    headers: admin('default'),
    body: JSON.stringify({
      aliasDisplay: 'beta',
      remoteNodeId: 'peer-node-1',
      remoteTeamId: randomUUID(),
    }),
  });
  expect(contactPost.status, await contactPost.clone().text()).toBe(201);

  // A counting pass-through in front of the manager, so "stops polling when
  // not focused" is asserted from what the manager actually receives.
  proxy = http.createServer((req, res) => {
    requested.push(req.url ?? '');
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const forward = http.request(
        `${managerUrl}${req.url}`,
        { method: req.method, headers: req.headers },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(res);
        },
      );
      forward.on('error', () => { res.writeHead(502); res.end(); });
      forward.end(Buffer.concat(chunks));
    });
  });
  const proxyPort = await findFreePort();
  await new Promise<void>((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  proxyUrl = `http://127.0.0.1:${proxyPort}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => proxy?.close(() => resolve()));
  await new Promise<void>((resolve) => {
    (manager as never as { httpServer?: http.Server }).httpServer?.close(() => resolve());
    if (!(manager as never as { httpServer?: http.Server }).httpServer) resolve();
  });
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('inter-team views are reachable in the running TUI', () => {
  it('navigates to contacts, node connections and connect, and probes for real', async () => {
    process.env.MANAGER_URL = proxyUrl;
    const { App } = await import('../../src/tui/App.js');
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    lastFrameForDiagnostics = () => stdout.lastFrame().slice(0, 1200);
    const instance = render(React.createElement(App), {
      stdout: stdout as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      // The app is up once the real team list has arrived.
      await waitFor(() => stdout.lastFrame().includes('Agents'), 'agents view');

      // Contacts: a menu (help) documented key, per Prem's original request.
      stdin.press('o');
      await waitFor(
        () => stdout.lastFrame().includes('Contacts —'),
        'contacts view title',
      );
      // The fixture contact lives on `default`; Tab cycles the team scope the
      // same way it does on the agents view.
      stdin.press('\t');
      await waitFor(() => stdout.lastFrame().includes('Contacts — public'), 'first tab');
      await new Promise((r) => setTimeout(r, 150));
      stdin.press('\t');
      await waitFor(
        () => stdout.lastFrame().includes('Contacts — default'),
        'contacts scoped to default',
      );
      await waitFor(() => stdout.lastFrame().includes('beta'), 'contact row');
      expect(stdout.lastFrame()).toContain('route ok');

      // Node connections, and a real probe against a dead peer.
      stdin.press('x');
      await waitFor(
        () => stdout.lastFrame().includes('Node connections (1)'),
        'node connections view',
      );
      expect(stdout.lastFrame()).toContain('enabled, not probed');
      stdin.press('p');
      await waitFor(() => stdout.lastFrame().includes('unreachable'), 'probe outcome state');
      // A state on the row, not a dialog: the list chrome is still there.
      expect(stdout.lastFrame()).toContain('press p to probe');
      expect(stdout.lastFrame()).not.toMatch(/error:/i);

      // Connect: the four real paths and the prompt.
      stdin.press('e');
      await waitFor(() => stdout.lastFrame().includes('Connect'), 'connect view');
      expect(stdout.lastFrame()).toContain('idagents-admin-control');
      expect(stdout.lastFrame()).toContain('QUICKSTART.md');
      expect(stdout.lastFrame()).toContain('already running');

      // Away from the inter-team views, their polling stops: the manager
      // receives no inter-team request while the agents view is showing.
      // The controllers poll every 5s, so a 6s window would have caught one.
      stdin.press('a');
      await waitFor(() => stdout.lastFrame().includes('Agents'), 'back to agents');
      const before = requested.filter((url) => url.includes('/inter-team/')).length;
      await new Promise((r) => setTimeout(r, 6100));
      const after = requested.filter((url) => url.includes('/inter-team/')).length;
      expect(after).toBe(before);

      // The slash commands reach the same views, so an operator who lives in
      // the command bar never needs the quick keys. Each press is spaced so
      // the submit handler closes over the fully typed buffer.
      const bySlash: Array<[string, string]> = [
        ['contacts', 'Contacts —'],
        ['connections', 'Node connections ('],
        ['connect', 'Connect'],
      ];
      for (const [command, title] of bySlash) {
        stdin.press('a');
        await waitFor(() => stdout.lastFrame().includes('Agents ('), `agents before /${command}`);
        // Keys drained in one tick are all handled by the same render's
        // closure, so each press waits out a re-render before the next: '/'
        // must flip commandMode before the text arrives, and the text must be
        // in the rendered buffer before Enter submits it.
        stdin.press('/');
        await new Promise((r) => setTimeout(r, 200));
        stdin.press(command);
        await waitFor(() => stdout.lastFrame().includes(`/${command}`), `buffer shows /${command}`);
        await new Promise((r) => setTimeout(r, 200));
        stdin.press('\r');
        await waitFor(() => stdout.lastFrame().includes(title), `/${command} opened its view`);
      }

      // The footer names the three keys, which is the visible menu Prem asked
      // for, and the help view documents them too.
      expect(stdout.lastFrame()).toContain('o contacts');
      expect(stdout.lastFrame()).toContain('x nodes');
      expect(stdout.lastFrame()).toContain('e connect');
      stdin.press('?');
      await waitFor(() => stdout.lastFrame().includes('Contacts (inter-team)'), 'help lists contacts');
      expect(stdout.lastFrame()).toContain('Node connections');
      expect(stdout.lastFrame()).toContain('Connect prompt');
    } finally {
      instance.unmount();
    }
  }, 40_000);
});
