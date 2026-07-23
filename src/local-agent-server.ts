// SPDX-License-Identifier: MIT
/**
 * Local Agent Server
 *
 * Runs a local runtime-backed agent using the user's existing CLI
 * authentication when applicable. This allows agents to use a logged-in CLI
 * session instead of requiring an API key for CLI-based runtimes.
 *
 * The local agent:
 * - Registers with the manager as a team member
 * - Exposes REST-AP endpoints for inter-agent communication
 * - Uses your configured local runtime for LLM calls
 * - Can participate in multi-agent workflows alongside other local agents
 */

import 'dotenv/config';
import { AgentRestServer } from './agent-rest-server.js';
import { createDb, migrateDb } from './db/index.js';
import type { Db } from './db/db-service.js';
import fetch from 'node-fetch';
import { mkdirSync, existsSync } from 'fs';
import path from 'path';
import net from 'net';
import { pathToFileURL } from 'node:url';
import {
  getDefaultModelForRuntime,
  getRuntimeDisplayName,
  resolveRuntime,
  usesCliLogin,
} from './runtime/registry.js';
import { isCodexReasoningEffort, type CodexReasoningEffort } from './harness/types.js';

interface LocalAgentConfig {
  name: string;
  team?: string;
  port?: number;
  workingDirectory?: string;
  model?: string;
  effort?: CodexReasoningEffort;
  managerUrl?: string;
  agentId?: string;  // Pre-registered agent ID from manager
  verbose?: boolean; // Enable detailed logging of agent activity
}

/**
 * Check if a port is available
 */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

/**
 * Find an available port starting from a given port
 */
async function findAvailablePort(startPort: number, maxAttempts: number = 100): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available ports found in range ${startPort}-${startPort + maxAttempts}`);
}

/**
 * Get port search range for local agents (global sequential allocation, starting at 4101)
 */
async function getPortSearchRange(): Promise<{ portStart: number; portEnd: number }> {
  return { portStart: 4101, portEnd: 65535 };
}

/**
 * Register the local agent with the manager
 */
async function registerWithManager(
  managerUrl: string,
  agentId: string,
  name: string,
  team: string,
  port: number,
  runtime: string
): Promise<void> {
  const endpoint = `http://localhost:${port}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Id-Team': team
  };

  const response = await fetch(`${managerUrl}/agents/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: agentId,
      name,
      endpoint,
      type: 'claude',  // Mark as claude type since it runs Claude Code
      metadata: {
        name,
        service_type: 'REST-AP',
        service: endpoint,
        runtime,
        local: true,  // Flag to indicate this is a local agent
        pid: process.pid
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to register with manager: ${error}`);
  }

  console.log(`✅ Registered with manager at ${managerUrl}`);
}

// Note: We no longer need an unregister function here.
// The stop() function updates status directly via database.
// Agents persist in the database and can be restarted.

/**
 * Start a local runtime-backed agent server
 */
export async function startLocalAgent(config: LocalAgentConfig): Promise<{
  server: AgentRestServer;
  port: number;
  agentId: string;
  stop: () => Promise<void>;
}> {
  const runtime = resolveRuntime(process.env.ID_HARNESS || 'claude-code-cli');
  process.env.ID_HARNESS = runtime;

  const {
    name,
    team = process.env.ID_TEAM || 'default',
    port: requestedPort,
    workingDirectory: configWorkDir,
    model = process.env.CLAUDE_MODEL || getDefaultModelForRuntime(runtime),
    effort = isCodexReasoningEffort(process.env.ID_AGENT_EFFORT) ? process.env.ID_AGENT_EFFORT : undefined,
    managerUrl = process.env.MANAGER_URL || 'http://127.0.0.1:4100',
    agentId: preRegisteredId
  } = config;

  const tokenId = process.env.ID_AGENT_TOKEN_ID;

  // Use pre-registered ID or generate one
  const agentId = preRegisteredId || `local_${name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}_${Date.now()}`;
  const isPreRegistered = !!preRegisteredId;

  // Set up working directory
  const baseWorkDir = process.env.ID_WORKSPACE_DIR || process.env.WORKSPACE_DIR || '/tmp/id-agents';
  const workingDirectory = configWorkDir || path.join(baseWorkDir, 'local-agents', agentId);
  const sharedDirectory = path.join(baseWorkDir, 'teams', team);

  // Create directories if they don't exist
  if (!existsSync(workingDirectory)) {
    mkdirSync(workingDirectory, { recursive: true });
  }
  if (!existsSync(sharedDirectory)) {
    mkdirSync(sharedDirectory, { recursive: true });
  }

  // Determine port
  let port: number;
  if (requestedPort) {
    if (await isPortAvailable(requestedPort)) {
      port = requestedPort;
    } else {
      throw new Error(`Requested port ${requestedPort} is not available`);
    }
  } else {
    // Find available port using global sequential allocation
    const portRange = await getPortSearchRange();
    port = await findAvailablePort(portRange.portStart, portRange.portEnd - portRange.portStart);
  }

  // Open the shared DB (SQLite default or Postgres via DATABASE_URL). Query and
  // news rows must land in this shared store so the manager daemon at :4100
  // can serve /query/<id> and /news polling. Memory-only fallback remains for
  // resilience, but daemon polling will 404 in that mode.
  let db: Db | undefined;
  let dbTeamId: string | undefined;

  try {
    db = await createDb();
    await migrateDb(db);
    // Use pre-configured team ID if available
    dbTeamId = process.env.ID_DB_TEAM_ID || await db.teams.getOrCreateTeamId(team);

    if (isPreRegistered) {
      // Just update status to 'running' - agent was already registered by manager
      await db.agents.updateStatus(agentId, 'running');
      console.log(`📦 Updated status to running in database`);
    } else {
      // Register agent in database (standalone mode)
      await db.agents.upsert({
        team_id: dbTeamId,
        id: agentId,
        name,
        type: 'claude',
        model,
        port,
        endpoint: `http://localhost:${port}`,
        working_directory: workingDirectory,
        status: 'running',
        created_at: Date.now(),
        metadata: { name, service_type: 'REST-AP', service: `http://localhost:${port}`, runtime, local: true, pid: process.pid, ...(effort && { effort }) },
      });
      console.log(`📦 Registered in database (team: ${team})`);
    }
  } catch (err) {
    console.warn(`⚠️  Database connection failed, running in memory-only mode: ${err}`);
    console.warn(`⚠️  Manager daemon polling (GET :4100/query/<id>, /news) will NOT find this agent's queries while memory-only.`);
    db = undefined;
    dbTeamId = undefined;
  }

  // For Claude CLI runtimes, prefer the local Claude session over ambient API keys.
  // Codex still supports OPENAI_API_KEY and should inherit it when present.
  if (usesCliLogin(runtime) && runtime !== 'codex') {
    delete process.env.ANTHROPIC_API_KEY;
  }

  // Set manager URL for AgentRestServer to use
  process.env.MANAGER_URL = managerUrl;

  // Enable verbose logging if configured
  if (config.verbose || process.env.ID_AGENT_VERBOSE === 'true') {
    process.env.ID_AGENT_VERBOSE = 'true';
    console.log('📋 Verbose logging enabled - will show tool calls and progress');
  }

  // Catalog seed handoff: the manager passes the YAML-floored catalog object
  // via ID_AGENT_CATALOG (base64-encoded JSON) so the in-memory /catalog state
  // is correct on the first request — no manual PATCH required.
  let catalogSeed: Record<string, unknown> | undefined;
  const rawCatalog = process.env.ID_AGENT_CATALOG;
  if (rawCatalog) {
    try {
      const decoded = Buffer.from(rawCatalog, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        catalogSeed = parsed as Record<string, unknown>;
      }
    } catch (err: any) {
      console.warn(`⚠️  Failed to decode ID_AGENT_CATALOG: ${err?.message || err}`);
    }
  }

  // Create the server
  const server = new AgentRestServer({
    model,
    effort,
    workingDirectory,
    sharedDirectory,
    agentName: name,
    agentIdentity: {
      name,
      team,
      ...(tokenId && { tokenId }),
      ...(catalogSeed && { metadata: { catalog: catalogSeed } }),
    },
    ...(db && dbTeamId && { db: { db, teamId: dbTeamId, agentId } })
  });

  // Start the server
  await server.start(port);

  // Register with manager (only if not pre-registered)
  if (!isPreRegistered) {
    try {
      await registerWithManager(managerUrl, agentId, name, team, port, runtime);
    } catch (err) {
      console.warn(`⚠️  Could not register with manager: ${err}`);
      console.log(`   Agent is running but may not be discoverable by other agents.`);
      console.log(`   Make sure the manager is running at ${managerUrl}`);
    }
  } else {
    console.log(`✅ Agent pre-registered with manager (ID: ${agentId})`);
  }

  // Always publish our process pid to the manager so the TUI / health probes
  // can do per-agent RSS lookups. Pre-registered and self-registered flows
  // both hit this path since the manager-side metadata was written before we
  // existed; without this the pid field stays null forever and memory shows
  // as "—" in the TUI.
  try {
    const metaRes = await fetch(`${managerUrl}/agents/${agentId}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': team },
      body: JSON.stringify({ metadata: { pid: process.pid } }),
    });
    if (metaRes.ok) console.log(`📝 Published pid ${process.pid} to manager`);
  } catch {
    // Non-fatal: memory column will just show "—" until next restart.
  }

  // Create stop function for graceful shutdown
  const stop = async () => {
    console.log('\n🛑 Stopping local agent...');

    // Update database status and cancel pending queries
    if (db && dbTeamId) {
      try {
        const ts = Date.now();

        // Cancel pending queries so they don't show as orphaned
        const queryIds = await db.queries.cancel(agentId, ts);

        if (queryIds.length > 0) {
          // Add query.cancelled news items
          for (const queryId of queryIds) {
            await db.news.add(dbTeamId, agentId, {
              timestamp: ts,
              type: 'query.cancelled',
              message: 'Query cancelled (agent stopped)',
              data: { reason: 'agent_stopped', query_id: queryId },
              query_id: queryId,
            });
          }
          console.log(`📋 Cancelled ${queryIds.length} pending queries`);
        }

        await db.agents.updateStatus(agentId, 'stopped');
      } catch {
        // Ignore errors
      }
    }

    // Stop the server
    await server.stop();

    // Close database connection
    if (db) {
      await db.close();
    }
  };

  return { server, port, agentId, stop };
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let name = args[0];
  let team = process.env.ID_TEAM || 'default';
  let port: number | undefined;
  let workingDirectory: string | undefined;
  let agentId: string | undefined;

  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--team' || args[i] === '-t') {
      team = args[++i];
    } else if (args[i] === '--port' || args[i] === '-p') {
      port = parseInt(args[++i]);
    } else if (args[i] === '--dir' || args[i] === '-d') {
      workingDirectory = args[++i];
    } else if (args[i] === '--id') {
      agentId = args[++i];
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Local Agent Server - Run local agents using your existing CLI authentication

Usage:
  node dist/local-agent-server.js <name> [options]

Options:
  --team, -t <name>    Team name (default: ID_TEAM env or 'default')
  --port, -p <port>    Port to listen on (auto-allocated if not specified)
  --dir, -d <path>     Working directory (auto-created if not specified)
  --id <agent-id>      Pre-registered agent ID (from /deploy)
  --verbose, -v        Enable detailed logging (show tool calls, progress)
  --help, -h           Show this help message

Environment Variables:
  ID_TEAM              Default team name
  MANAGER_URL          Manager URL (default: http://localhost:4100)
  DATABASE_URL         PostgreSQL connection string (optional)
  CLAUDE_MODEL         Default model (default: claude-opus-4-20250514)
Examples:
  node dist/local-agent-server.js my-agent
  node dist/local-agent-server.js coder --team myproject --port 24001
  ID_TEAM=myteam node dist/local-agent-server.js researcher
`);
      process.exit(0);
    } else if (!args[i].startsWith('-') && !name) {
      name = args[i];
    }
  }

  if (!name) {
    console.error('❌ Missing agent name');
    console.error('Usage: node dist/local-agent-server.js <name> [--team <team>] [--port <port>]');
    process.exit(1);
  }

  const bannerName = getRuntimeDisplayName(process.env.ID_HARNESS || 'claude-code-cli');
  const bannerTitle = `🏠 Local ${bannerName} Agent Server`;
  const bannerSubtitle = `Running ${bannerName} with your local authentication`;

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║ ${bannerTitle.padEnd(61)}║
╠═══════════════════════════════════════════════════════════════╣
║ ${bannerSubtitle.padEnd(61)}║
║  Other agents can communicate via REST-AP protocol            ║
╚═══════════════════════════════════════════════════════════════╝
`);

  const { port: actualPort, agentId: finalAgentId, stop } = await startLocalAgent({
    name,
    team,
    port,
    workingDirectory,
    agentId,
    verbose
  });

  console.log(`\n📍 Agent Details:`);
  console.log(`   ID:      ${finalAgentId}`);
  console.log(`   Name:    ${name}`);
  console.log(`   Team:    ${team}`);
  console.log(`   Port:    ${actualPort}`);
  console.log(`   URL:     http://localhost:${actualPort}`);
  console.log(`   REST-AP: http://localhost:${actualPort}/.well-known/restap.json`);
  console.log(`\n🎯 Talk to this agent:`);
  console.log(`   curl -X POST http://localhost:${actualPort}/talk \\`);
  console.log(`     -H "Content-Type: application/json" \\`);
  console.log(`     -d '{"message": "Hello!"}'`);
  console.log('\nPress Ctrl+C to stop the agent\n');

  // Handle shutdown gracefully
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive
  const heartbeat = setInterval(() => {}, 1000 * 60 * 60);
  process.on('exit', () => clearInterval(heartbeat));
}

// Run if called directly. Compare via pathToFileURL so paths containing
// characters that get percent-encoded in a file URL (e.g. the space in
// "/Applications/ID Agents Dashboard.app") still match — a hand-built
// `file://${process.argv[1]}` does not encode them, so main() would be
// silently skipped and the agent process would exit 0 without starting.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
