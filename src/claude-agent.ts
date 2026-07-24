// SPDX-License-Identifier: MIT
/**
 * Claude Agent SDK Integration
 *
 * Uses the Claude Agent SDK directly for better future compatibility and features.
 */

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface PluginConfig {
  name: string;
  path: string;
}

export type ClaudeAgentOptions = {
  model?: string;
  allowedTools?: string[];
  workingDirectory?: string;
  pluginPath?: string;  // Kept for backwards compatibility
  plugins?: PluginConfig[];  // New: array of plugins
  resume?: string;
};

export interface ClaudeAgentMessage {
  type: string;
  subtype?: string;
  content?: string;
  result?: string;
  session_id?: string;
  parent_tool_use_id?: string;
  tool_name?: string;
  [key: string]: any;
}

// Available Claude models
export const CLAUDE_MODELS = {
  HAIKU: 'claude-haiku-4-5-20251001',      // Cheapest: $0.25/$1.25 per 1M tokens
  SONNET: 'claude-sonnet-4-20250514',      // Balanced: $3/$15 per 1M tokens
  OPUS: 'claude-opus-4-20250514',          // Most capable: $15/$75 per 1M tokens
  FABLE: 'claude-fable-5',                 // Fable 5: $10/$50 per 1M tokens
  MYTHOS: 'claude-mythos-5'                // Mythos 5: $10/$50 per 1M tokens (Project Glasswing access required)
} as const;

/**
 * Human-friendly display label for a model id/alias.
 * Falls back to the raw model string when unrecognized.
 */
export function modelDisplayName(model: string): string {
  return model.includes('haiku') ? 'Haiku 4.5 (Cheap)' :
         model.includes('sonnet') ? 'Sonnet 4 (Balanced)' :
         // Must precede the generic `opus` arm, which would otherwise label
         // Opus 5 as "Opus 4 (Premium)". Matches `claude-opus-5` and any future
         // dated snapshot; `claude-opus-4-5-…` does not contain `opus-5`.
         model.includes('opus-5') ? 'Opus 5' :
         model.includes('opus') ? 'Opus 4 (Premium)' :
         model.includes('fable') ? 'Fable 5' :
         model.includes('mythos') ? 'Mythos 5' : model;
}

/**
 * Execute Claude using the SDK query() function
 *
 * @param prompt The prompt to send to Claude
 * @param options Agent configuration options
 * @returns AsyncIterator of messages from the agent
 */
export async function* runClaudeAgent(
  prompt: string,
  options: ClaudeAgentOptions = {}
): AsyncGenerator<ClaudeAgentMessage> {
  const model = options.model || process.env.CLAUDE_MODEL || CLAUDE_MODELS.HAIKU;
  const workingDir = options.workingDirectory || process.cwd();

  // Build SDK options
  const sdkOptions: Options = {
    model,
    cwd: workingDir,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: true,
  };

  // Add allowed tools if specified
  if (options.allowedTools && options.allowedTools.length > 0) {
    sdkOptions.allowedTools = options.allowedTools;
  }

  // Add resume/session if provided
  if (options.resume) {
    sdkOptions.resume = options.resume;
  }

  // Add plugins if specified (new array format takes precedence)
  if (options.plugins && options.plugins.length > 0) {
    sdkOptions.plugins = options.plugins.map(p => ({ type: 'local', path: p.path }));
  } else if (options.pluginPath) {
    // Backwards compatibility: single plugin path
    sdkOptions.plugins = [{ type: 'local', path: options.pluginPath }];
  }

  // Set up safe environment variables
  sdkOptions.env = {
    // Essential for Claude operation
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    // Agent/team context (non-sensitive)
    MANAGER_URL: process.env.MANAGER_URL,
    ID_CONTAINER: process.env.ID_CONTAINER,
    ID_PROJECT: process.env.ID_PROJECT,
    // Basic environment needed for shell operations
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    // Safe config (not sensitive)
    CLAUDE_MODEL: process.env.CLAUDE_MODEL,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL
  };

  yield { type: 'system', subtype: 'init', content: 'Starting Claude Agent SDK' };

  try {
    let sessionId: string | undefined;
    let finalResult: string | undefined;

    for await (const message of query({ prompt, options: sdkOptions })) {
      // Map SDK messages to our format
      const mapped = mapSDKMessage(message);
      if (mapped) {
        // Capture session_id from system init
        if (mapped.session_id) {
          sessionId = mapped.session_id;
        }
        // Capture final result
        if (mapped.type === 'result' && mapped.result) {
          finalResult = mapped.result;
        }
        yield mapped;
      }
    }

    // If we didn't yield a result yet, something went wrong
    if (!finalResult) {
      yield { type: 'error', content: 'Claude Agent SDK returned no result' };
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    yield { type: 'error', content: errorMessage };
    throw error;
  }
}

/**
 * Map SDK message to our ClaudeAgentMessage format
 */
function mapSDKMessage(message: SDKMessage): ClaudeAgentMessage | null {
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init') {
        return {
          type: 'system',
          subtype: 'init',
          session_id: message.session_id,
          content: `Model: ${message.model}, Tools: ${message.tools?.join(', ') || 'default'}`
        };
      }
      // Skip other system messages (compact_boundary, status, hook_response)
      return null;

    case 'assistant':
      // Extract tool uses from assistant messages
      if (message.message?.content) {
        for (const block of message.message.content) {
          if ('type' in block && block.type === 'tool_use') {
            return {
              type: 'tool_use',
              tool_name: block.name,
              parent_tool_use_id: message.parent_tool_use_id || undefined,
              session_id: message.session_id
            };
          }
        }
      }
      // Skip pure text assistant messages (they're intermediate)
      return null;

    case 'result':
      if (message.subtype === 'success') {
        return {
          type: 'result',
          result: message.result,
          session_id: message.session_id
        };
      } else {
        // Error result - extract error info
        const errorInfo = message as { subtype: string; errors?: string[]; session_id: string };
        const errors = errorInfo.errors ? errorInfo.errors.join(', ') : errorInfo.subtype;
        return {
          type: 'error',
          content: errors,
          session_id: errorInfo.session_id
        };
      }

    case 'tool_progress':
      // Could emit these if we want progress updates
      return null;

    case 'stream_event':
      // Partial streaming messages - skip unless we want streaming
      return null;

    case 'auth_status':
      // Authentication status - skip
      return null;

    default:
      // Unknown message type
      return null;
  }
}

/**
 * Helper to extract the final result from an agent execution
 */
export async function getClaudeAgentResult(
  prompt: string,
  options: ClaudeAgentOptions = {}
): Promise<string> {
  let result = '';

  for await (const message of runClaudeAgent(prompt, options)) {
    if ('result' in message && message.result) {
      result = message.result;
    }
  }

  return result;
}

/**
 * Helper to run an agent with streaming output
 */
export async function runClaudeAgentWithLogging(
  prompt: string,
  options: ClaudeAgentOptions = {},
  onMessage?: (message: ClaudeAgentMessage) => void
): Promise<string> {
  let result = '';

  for await (const message of runClaudeAgent(prompt, options)) {
    if (onMessage) {
      onMessage(message);
    }

    // Log progress messages
    if (message.type === 'thinking') {
      console.log(`[Agent] ${message.content}`);
    } else if (message.type === 'tool_use') {
      console.log(`[Agent] Using tool: ${message.tool_name}`);
    } else if ('result' in message && message.result) {
      result = message.result;
    }
  }

  return result;
}
