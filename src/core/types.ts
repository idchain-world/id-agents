// SPDX-License-Identifier: MIT
/**
 * Core types and interfaces shared between CLI and Control API
 */

// ==================== Operation Results ====================

/**
 * Standard result type for all core service operations
 */
export interface OperationResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

// ==================== Team Types ====================

export interface TeamConfig {
  [teamName: string]: {
    port: number;
    managerId: string;
    createdAt: string;
  };
}

export interface TeamInfo {
  name: string;
  port: number;
  managerId: string;
  managerUrl: string;
  status: 'running' | 'stopped' | 'unknown';
  createdAt: string;
}

export interface CreateTeamOptions {
  name: string;
}

export interface CreateTeamResult {
  team: TeamInfo;
  isNew: boolean;
}

// ==================== Agent Types ====================

export type AgentType = 'claude' | 'virtual' | 'interactive';
export type AgentStatus = 'running' | 'stopped' | 'starting' | 'error' | 'unknown' | 'offline';

export interface AgentMetadata {
  name?: string;
  description?: string;
  runtime?: string;
  isManager?: boolean;
  external_url?: string;
  internal_url?: string;
  requireAuth?: boolean;
  // Honored explicitly true/false; defaults to true when undefined.
  // Maps to --dangerously-skip-permissions for claude-code-cli and to
  // --dangerously-bypass-approvals-and-sandbox for codex.
  dangerouslySkipPermissions?: boolean;
  // Codex reasoning effort or the effort suffix on a Gemini 4 model.
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  [key: string]: any;
}

export interface AgentInfo {
  id: string;
  name: string;
  type: AgentType;
  model?: string;
  port?: number;
  url?: string;
  internalUrl?: string;
  status?: AgentStatus;
  workingDirectory?: string;
  createdAt?: string;
  metadata?: AgentMetadata;
  // Identity fields
  tokenId?: string;           // Token ID / label (e.g., "agent-5")
  domain?: string;            // ENS domain name (e.g., "agent-5.xid.eth") — the identity
  displayId?: string;         // Formatted display identifier
}

export interface SpawnAgentOptions {
  name: string;
  model?: string;
  runtime?: string;
  systemPrompt?: string;
  config?: Record<string, any>;
}

export interface AgentStatusReport {
  agent: AgentInfo;
  healthy: boolean;
  responseTime?: number;
  lastActivity?: number;
  activeQueries?: number;
  error?: string;
}

// ==================== Messaging Types ====================

export interface NewsItem {
  type: string;
  timestamp: number;
  message?: string;
  data?: {
    query_id?: string;
    from?: string;
    to?: string;
    in_reply_to?: string;
    message?: string;
    result?: any;
    error?: string;
    [key: string]: any;
  };
}

export interface SendMessageOptions {
  message: string;
  sessionId?: string;
  from?: string;
}

export interface SendMessageResult {
  queryId: string;
  status: 'pending' | 'completed' | 'failed';
}

export interface PollNewsOptions {
  since?: number;
  limit?: number;
  queryId?: string;
}

// ==================== File Types ====================

export interface FileInfo {
  name: string;
  size?: number;
  modified?: string;
}

// ==================== Deploy Types ====================

export interface DeployConfig {
  version: string;
  parameters?: Array<{
    name: string;
    description?: string;
    required?: boolean;
    default?: string;
  }>;
  defaults?: {
    model?: string;
    runtime?: string;
    plugins?: Array<{
      name: string;
      path?: string;
    }>;
  };
  agents: Array<{
    name: string;
    system_prompt?: string;
    model?: string;
    runtime?: string;
  }>;
}

export interface DeployResult {
  agents: AgentInfo[];
  errors?: string[];
}

// ==================== Service Context ====================

/**
 * Context passed to core services for configuration
 */
export interface ServiceContext {
  projectRoot: string;
  teamName: string;
  managerUrl: string;
  envVars: Record<string, string>;
}
