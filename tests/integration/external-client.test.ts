// SPDX-License-Identifier: MIT
/**
 * External Client Integration Tests
 *
 * Tests that agents can be reached from completely external clients
 * that don't use the CLI or manager. This proves REST-AP interoperability.
 *
 * Prerequisites:
 * - Manager must be running (`npm start` in CLI)
 * - At least one agent must be deployed
 *
 * Run with: npm test -- tests/integration/external-client.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import {
  waitForManager,
  listAgents,
  remoteDeploy,
  remoteDelete,
  waitForAgent,
} from '../helpers/manager-client.js';

// Manager URL for setup/cleanup (the real manager)
const MANAGER_URL = process.env.MANAGER_URL || 'http://localhost:4100';

// Test manager runs on a different port (simulating external client)
const TEST_MANAGER_PORT = 5555;
const TEST_MANAGER_URL = `http://localhost:${TEST_MANAGER_PORT}`;

// Test agent name
const TEST_AGENT = `external-test-${Date.now()}`;

let testManagerProcess: ChildProcess | null = null;
let agentPort: number | null = null;

/**
 * Start the test manager as a separate process
 */
async function startTestManager(): Promise<boolean> {
  return new Promise((resolve) => {
    testManagerProcess = spawn('node', ['tools/test-manager/index.js', `--port=${TEST_MANAGER_PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TEST_MANAGER_PORT: String(TEST_MANAGER_PORT) }
    });

    let started = false;

    testManagerProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Listening on') && !started) {
        started = true;
        resolve(true);
      }
    });

    testManagerProcess.stderr?.on('data', (data) => {
      console.error('[TestManager]', data.toString());
    });

    testManagerProcess.on('error', (err) => {
      console.error('[TestManager] Failed to start:', err);
      resolve(false);
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      if (!started) {
        console.error('[TestManager] Startup timeout');
        resolve(false);
      }
    }, 10000);
  });
}

/**
 * Stop the test manager
 */
function stopTestManager() {
  if (testManagerProcess) {
    testManagerProcess.kill();
    testManagerProcess = null;
  }
}

/**
 * Make a request to the test manager
 */
async function testManagerRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: boolean; data: T }> {
  try {
    const response = await fetch(`${TEST_MANAGER_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json() as T;
    return { ok: response.ok, data };
  } catch (error) {
    return { ok: false, data: { error: String(error) } as T };
  }
}

/**
 * Direct request to an agent (bypassing both managers)
 */
async function directAgentRequest<T = unknown>(
  port: number,
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: boolean; data: T }> {
  try {
    const response = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json() as T;
    return { ok: response.ok, data };
  } catch (error) {
    return { ok: false, data: { error: String(error) } as T };
  }
}

// Opt-in: requires a running external manager + ID_CONTROL_API_KEY. Run via `npm run test:e2e`.
describe.skipIf(!process.env.ID_CONTROL_API_KEY)('External Client Communication', () => {
  beforeAll(async () => {
    // 1. Ensure real manager is running
    const isHealthy = await waitForManager(30000);
    if (!isHealthy) {
      throw new Error(
        'Manager not healthy. Start the manager with `npm start` before tests.'
      );
    }

    // 2. Deploy a test agent using the real CLI/manager
    console.log(`[Test] Deploying test agent: ${TEST_AGENT}`);
    const deployResult = await remoteDeploy('test', { name: TEST_AGENT });
    if (!deployResult.ok) {
      throw new Error(`Failed to deploy test agent: ${JSON.stringify(deployResult.data)}`);
    }

    // 3. Wait for agent to be ready
    const isReady = await waitForAgent(TEST_AGENT, 60000);
    if (!isReady) {
      throw new Error('Test agent failed to start');
    }

    // 4. Get agent port
    const agents = await listAgents();
    const agent = agents.data.find((a) => a.name === TEST_AGENT || a.name.startsWith(TEST_AGENT));
    if (!agent || !agent.port) {
      throw new Error('Could not find test agent port');
    }
    agentPort = agent.port;
    console.log(`[Test] Agent ${TEST_AGENT} running on port ${agentPort}`);

    // 5. Start the external test manager
    console.log('[Test] Starting external test manager...');
    const testManagerStarted = await startTestManager();
    if (!testManagerStarted) {
      throw new Error('Failed to start test manager');
    }
    console.log(`[Test] Test manager running on port ${TEST_MANAGER_PORT}`);
  }, 120000); // 2 minute timeout for setup

  afterAll(async () => {
    // Stop test manager
    stopTestManager();

    // Clean up test agent
    try {
      await remoteDelete(TEST_AGENT);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Test Manager Health', () => {
    it('test manager should be healthy', async () => {
      const result = await testManagerRequest<{ status: string }>('GET', '/health');
      expect(result.ok).toBe(true);
      expect(result.data.status).toBe('ok');
    });

    it('test manager should serve discovery document', async () => {
      const result = await testManagerRequest<{ restap_version: string }>('GET', '/.well-known/restap.json');
      expect(result.ok).toBe(true);
      expect(result.data.restap_version).toBe('1.0');
    });
  });

  describe('Direct Agent Access (bypassing all managers)', () => {
    it('should get agent discovery document directly', async () => {
      expect(agentPort).not.toBeNull();

      const result = await directAgentRequest<{ restap_version?: string; agent?: { name: string } }>(
        agentPort!,
        'GET',
        '/.well-known/restap.json'
      );

      expect(result.ok).toBe(true);
      // Agent should have a discovery document
      expect(result.data).toBeDefined();
    });

    it('should get agent health directly', async () => {
      expect(agentPort).not.toBeNull();

      const result = await directAgentRequest<{ status?: string }>(
        agentPort!,
        'GET',
        '/health'
      );

      expect(result.ok).toBe(true);
    });

    it('should get agent news feed directly', async () => {
      expect(agentPort).not.toBeNull();

      const result = await directAgentRequest<{ items: unknown[] }>(
        agentPort!,
        'GET',
        '/news?since=0'
      );

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.data.items)).toBe(true);
    });
  });

  describe('External Client to Agent Communication', () => {
    it('should register the agent with test manager', async () => {
      expect(agentPort).not.toBeNull();

      const result = await testManagerRequest<{ ok: boolean; agent: { name: string } }>(
        'POST',
        '/agents/register',
        { name: TEST_AGENT, url: `http://localhost:${agentPort}` }
      );

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);
      expect(result.data.agent.name).toBe(TEST_AGENT);
    });

    it('should list registered agent in test manager', async () => {
      const result = await testManagerRequest<{ agents: Array<{ name: string }> }>('GET', '/agents');

      expect(result.ok).toBe(true);
      expect(result.data.agents.length).toBeGreaterThan(0);

      const agent = result.data.agents.find((a) => a.name === TEST_AGENT);
      expect(agent).toBeDefined();
    });

    it('should send message to agent via test manager and get reply', async () => {
      // This is the key test - external client sends message through test manager
      // which then communicates directly with the agent
      const result = await testManagerRequest<{
        success?: boolean;
        reply?: string;
        error?: string;
      }>(
        'POST',
        '/talk-to',
        {
          to: TEST_AGENT,
          message: 'Hello! What is 2 plus 2? Reply with just the number.',
          timeout: 180000 // 3 minute timeout for Claude API
        }
      );

      // The external test manager should have successfully communicated with the agent
      expect(result.ok).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.reply).toBeDefined();
      // Response should contain the answer
      expect(result.data.reply).toContain('4');
    }, 240000); // 4 minute timeout
  });

  describe('Direct Message to Agent (no manager at all)', () => {
    it('should send message directly to agent /talk endpoint', async () => {
      expect(agentPort).not.toBeNull();

      // Send a message directly to the agent's /talk endpoint
      // This completely bypasses both the real manager and test manager
      const result = await directAgentRequest<{
        ok?: boolean;
        query_id?: string;
        message?: string;
      }>(
        agentPort!,
        'POST',
        '/talk',
        {
          message: 'Say hello in exactly 3 words.',
          from: 'direct-test-client'
        }
      );

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);
      expect(result.data.query_id).toBeDefined();

      // Wait for the agent to process and check news
      await new Promise((resolve) => setTimeout(resolve, 30000)); // Wait 30 seconds

      const newsResult = await directAgentRequest<{ items: Array<{ type: string; message?: string }> }>(
        agentPort!,
        'GET',
        '/news?since=0'
      );

      expect(newsResult.ok).toBe(true);
      // Should have some news items
      expect(newsResult.data.items.length).toBeGreaterThan(0);
    }, 60000); // 1 minute timeout
  });
});
