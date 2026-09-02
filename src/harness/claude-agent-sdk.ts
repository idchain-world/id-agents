// SPDX-License-Identifier: MIT
/**
 * Claude Code Harness
 *
 * Wraps the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) as a harness.
 */

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType, PluginConfig } from './types.js';

// Available Claude models
export const CLAUDE_MODELS = {
  HAIKU: 'claude-haiku-4-5-20251001',
  SONNET: 'claude-sonnet-4-20250514',
  OPUS: 'claude-opus-4-20250514',
  FABLE: 'claude-fable-5',
  FABLE_5_1: 'claude-fable-5-1',
  MYTHOS: 'claude-mythos-5'
} as const;

/**
 * Map SDK message to unified HarnessMessage format
 */
function mapSDKMessage(message: SDKMessage): HarnessMessage | null {
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
      return null;

    case 'assistant':
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
      return null;

    case 'result':
      if (message.subtype === 'success') {
        return {
          type: 'result',
          result: message.result,
          session_id: message.session_id
        };
      } else {
        const errorInfo = message as { subtype: string; errors?: string[]; session_id: string };
        const errors = errorInfo.errors ? errorInfo.errors.join(', ') : errorInfo.subtype;
        return {
          type: 'error',
          content: errors,
          session_id: errorInfo.session_id
        };
      }

    case 'tool_progress':
    case 'stream_event':
    case 'auth_status':
    default:
      return null;
  }
}

export class ClaudeAgentSdkHarness implements AgentHarness {
  readonly type: HarnessType = 'claude-agent-sdk';

  /**
   * Normalize model name - strips 'anthropic/' prefix if present for consistency
   * with OpenCode's provider/model format.
   *
   * Examples:
   *   anthropic/claude-sonnet-4-20250514 -> claude-sonnet-4-20250514
   *   claude-sonnet-4-20250514 -> claude-sonnet-4-20250514
   */
  private normalizeModel(model: string): string {
    if (model.startsWith('anthropic/')) {
      return model.substring('anthropic/'.length);
    }
    return model;
  }

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const rawModel = options.model || process.env.CLAUDE_MODEL || CLAUDE_MODELS.HAIKU;
    const model = this.normalizeModel(rawModel);
    const workingDir = options.workingDirectory || process.cwd();

    // Build SDK options
    // Note: permissionMode 'bypassPermissions' and allowDangerouslySkipPermissions
    // cause SDK crashes in newer versions, so we use default permission mode
    const sdkOptions: Options = {
      model,
      cwd: workingDir,
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

    // Add plugins if specified
    if (options.plugins && options.plugins.length > 0) {
      sdkOptions.plugins = options.plugins.map((p: PluginConfig) => ({ type: 'local' as const, path: p.path }));
    }

    // Note: Explicitly setting sdkOptions.env causes "spawn node ENOENT" errors
    // in the SDK subprocess. Let the SDK inherit environment naturally.
    // Only set env if additional options were provided.
    if (options.env && Object.keys(options.env).length > 0) {
      sdkOptions.env = {
        ...process.env,
        ...options.env
      };
    }

    yield { type: 'system', subtype: 'init', content: 'Starting Claude Code harness' };

    try {
      let finalResult: string | undefined;

      for await (const message of query({ prompt, options: sdkOptions })) {
        const mapped = mapSDKMessage(message);
        if (mapped) {
          if (mapped.type === 'result' && mapped.result) {
            finalResult = mapped.result;
          }
          yield mapped;
        }
      }

      if (!finalResult) {
        yield { type: 'error', content: 'Claude Agent SDK returned no result' };
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      yield { type: 'error', content: errorMessage };
      throw error;
    }
  }
}
