// SPDX-License-Identifier: MIT
/**
 * Manager API Test Client
 * Helper for integration tests using the Manager API directly
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read .env file from project root
function readEnvFile(): Record<string, string> {
  const envPath = path.resolve(__dirname, '../../.env');
  const vars: Record<string, string> = {};
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          const key = trimmed.substring(0, eqIndex);
          const value = trimmed.substring(eqIndex + 1);
          vars[key] = value;
        }
      }
    }
  } catch {
    // .env file not found, use defaults
  }
  return vars;
}

const envVars = readEnvFile();

// Manager API runs on port 4100 by default (for default team)
const MANAGER_URL = process.env.MANAGER_URL || 'http://localhost:4100';
const API_KEY = process.env.ID_CONTROL_API_KEY || envVars.ID_CONTROL_API_KEY;

interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

async function request<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  requiresAuth = false
): Promise<ApiResponse<T>> {
  const url = `${MANAGER_URL}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add API key for authenticated endpoints
  if (requiresAuth && API_KEY) {
    headers['X-API-Key'] = API_KEY;
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      data: data as T,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown fetch error';
    return {
      ok: false,
      status: 0,
      data: { error: `fetch failed: ${message}` } as T,
    };
  }
}

// ==================== Health ====================

export async function getHealth() {
  return request<{ status: string }>('GET', '/health');
}

// ==================== Agents ====================

export interface AgentInfo {
  id: string;
  name: string;
  model: string;
  port: number;
  status: string;
  type: string;
  url?: string;
}

export async function listAgents() {
  const result = await request<{ agents: AgentInfo[] }>('GET', '/agents');
  // Transform response to return agents array directly in data
  return {
    ...result,
    data: result.data?.agents || [],
  };
}

export async function getAgent(agentId: string) {
  return request<AgentInfo>('GET', `/agents/${agentId}`);
}

export async function getAgentByName(name: string) {
  return request<AgentInfo>('GET', `/agents/by-name/${name}`);
}

export async function spawnAgent(
  name: string,
  options?: {
    model?: string;
    systemPrompt?: string;
    runtime?: string;
  }
) {
  return request<AgentInfo>('POST', '/agents/spawn', {
    name,
    model: options?.model || 'haiku',
    systemPrompt: options?.systemPrompt,
    runtime: options?.runtime,
  });
}

export async function deleteAgentByName(name: string) {
  return request<{ ok: boolean }>('DELETE', `/agents/by-name/${name}`);
}

// ==================== Remote Commands ====================
// Uses the /remote endpoint with API key auth

export interface RemoteResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export async function remote(command: string) {
  return request<RemoteResult>('POST', '/remote', { command }, true);
}

// Convenience wrappers for common remote commands
export async function remoteAgents() {
  return remote('/agents');
}

export async function remoteStatus() {
  return remote('/status');
}

export async function remoteSpawn(name: string, model = 'haiku') {
  return remote(`/spawn ${name} --model ${model}`);
}

export async function remoteDelete(name: string) {
  return remote(`/delete ${name}`);
}

export async function remoteAsk(agentName: string, message: string) {
  return remote(`/ask ${agentName} ${message}`);
}

export async function remoteNews(agentName: string) {
  return remote(`/news ${agentName}`);
}

export async function remoteDeploy(configName: string, params?: Record<string, string>) {
  let command = `/deploy ${configName}`;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      command += ` ${key}=${value}`;
    }
  }
  return remote(command);
}

export async function remoteSync(configName: string, params?: Record<string, string>, flags?: string[]) {
  let command = `/sync ${configName}`;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      command += ` ${key}=${value}`;
    }
  }
  if (flags) {
    command += ' ' + flags.join(' ');
  }
  return remote(command);
}

export async function remoteRegister(agentName: string) {
  return remote(`/register ${agentName}`);
}

export async function remoteAgent(agentName: string, action: 'start' | 'stop' | 'rebuild' | 'logs', tailLines?: number) {
  const cmd = action === 'logs' && tailLines
    ? `/agent ${agentName} ${action} ${tailLines}`
    : `/agent ${agentName} ${action}`;
  return remote(cmd);
}

export async function remoteModel(agentName: string, model: string) {
  return remote(`/model ${agentName} ${model}`);
}

export async function remoteDeleteAll() {
  return remote('/delete *');
}

export async function remoteDeleteTeam(teamName: string) {
  return remote(`/delete --team ${teamName}`);
}

export async function remoteOutput(agentName: string) {
  return remote(`/output ${agentName}`);
}

export async function remoteArtifact(agentName: string, filePath: string) {
  return remote(`/artifact ${agentName} ${filePath}`);
}

// ==================== Messaging ====================

export interface SendMessageResult {
  query_id?: string;
  queryId?: string;
  status?: string;
}

export interface NewsItem {
  type: string;
  timestamp: number;
  message: string;
  data: {
    result?: {
      model: string;
      result: string;
    };
    query_id?: string;
  };
}

export async function sendMessage(agentName: string, message: string) {
  // First get the agent to find its URL
  const agentResult = await getAgentByName(agentName);
  if (!agentResult.ok || !agentResult.data) {
    return { ok: false, status: 404, data: { error: `Agent ${agentName} not found` } as SendMessageResult };
  }

  const agentUrl = agentResult.data.url || `http://localhost:${agentResult.data.port}`;

  // Call the agent's /talk endpoint via Manager's proxy or direct
  // For now, use remote command which handles this
  const result = await remoteAsk(agentName, message);
  return {
    ok: result.ok && (result.data as RemoteResult).ok,
    status: result.status,
    data: (result.data as RemoteResult).result as SendMessageResult,
  };
}

export async function pollNews(agentName: string, queryId?: string) {
  const result = await remoteNews(agentName);
  if (!result.ok || !(result.data as RemoteResult).ok) {
    return { ok: false, status: result.status, data: { items: [] } };
  }

  const news = (result.data as RemoteResult).result as { items?: NewsItem[] };
  let items = news.items || [];

  // Filter by query_id if provided
  if (queryId) {
    items = items.filter(item => item.data?.query_id === queryId);
  }

  return { ok: true, status: 200, data: { items } };
}

/**
 * Send a message and wait for a response (polling)
 */
export async function askAndWait(
  agentName: string,
  message: string,
  timeoutMs = 60000,
  pollIntervalMs = 2000
): Promise<{ success: boolean; response?: string; error?: string }> {
  const sendResult = await sendMessage(agentName, message);
  if (!sendResult.ok || !sendResult.data) {
    return { success: false, error: `Failed to send message: ${JSON.stringify(sendResult.data)}` };
  }

  const queryId = sendResult.data.query_id || sendResult.data.queryId;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const newsResult = await pollNews(agentName, queryId);
    if (newsResult.ok && newsResult.data.items) {
      const completedItem = newsResult.data.items.find(
        (item) => item.type === 'query.completed' && item.data.query_id === queryId
      );
      if (completedItem && completedItem.data.result) {
        return { success: true, response: completedItem.data.result.result };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { success: false, error: 'Timeout waiting for response' };
}

/**
 * Wait for team manager to be healthy
 */
export async function waitForManager(timeoutMs = 30000, pollIntervalMs = 1000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const health = await getHealth();
      if (health.ok) {
        return true;
      }
    } catch {
      // Ignore connection errors during startup
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

/**
 * Wait for an agent to be ready (status is 'running')
 */
export async function waitForAgent(
  agentName: string,
  timeoutMs = 30000,
  pollIntervalMs = 1000
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const agents = await listAgents();
      if (agents.ok && Array.isArray(agents.data)) {
        const agent = agents.data.find((a) => a.name === agentName);
        if (agent && agent.status === 'running') {
          // Add small delay for full readiness
          await new Promise((resolve) => setTimeout(resolve, 3000));
          return true;
        }
      }
    } catch {
      // Ignore errors during startup
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}
