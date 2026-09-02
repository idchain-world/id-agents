// SPDX-License-Identifier: MIT
/**
 * Runtime registry.
 *
 * Central source of truth for runtime defaults, labels, auth mode, and
 * capabilities. Existing harness identifiers remain intact so this layer can
 * be adopted incrementally without changing external config.
 */

import type { HarnessType } from '../harness/types.js';
import type { RuntimeProfile, RuntimeId, RuntimeValidationIssue } from './types.js';
import { execFileSync, spawnSync } from 'child_process';

const DEFAULT_RUNTIME: RuntimeId = 'claude-agent-sdk';
const RUNTIME_ALIASES: Record<string, RuntimeId> = {
  'codex-cli': 'codex',
};

const PROFILES: Record<RuntimeId, RuntimeProfile> = {
  'claude-agent-sdk': {
    id: 'claude-agent-sdk',
    canonicalId: 'claude-agent-sdk',
    displayName: 'Claude',
    providerName: 'Claude Agent SDK',
    defaultModel: 'claude-haiku-4-5-20251001',
    sessionPolicy: 'persistent',
    deploymentShape: 'local-process',
    auth: {
      mode: 'api-key',
      provider: 'Anthropic',
      requiredEnv: ['ANTHROPIC_API_KEY'],
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: true,
      supportsAllowedTools: true,
    },
  },
  'claude-code-cli': {
    id: 'claude-code-cli',
    canonicalId: 'claude-code-cli',
    displayName: 'Claude Code',
    providerName: 'Claude Code CLI',
    defaultModel: 'claude-opus-4-20250514',
    sessionPolicy: 'persistent',
    deploymentShape: 'local-process',
    auth: {
      mode: 'cli-login',
      provider: 'Anthropic',
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: true,
      supportsAllowedTools: true,
    },
  },
  'claude-code-local': {
    id: 'claude-code-local',
    canonicalId: 'claude-code-cli',
    displayName: 'Claude Code',
    providerName: 'Claude Code CLI',
    defaultModel: 'claude-opus-4-20250514',
    sessionPolicy: 'persistent',
    deploymentShape: 'local-process',
    auth: {
      mode: 'cli-login',
      provider: 'Anthropic',
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: true,
      supportsAllowedTools: true,
    },
  },
  codex: {
    id: 'codex',
    canonicalId: 'codex',
    displayName: 'Codex',
    providerName: 'Codex CLI',
    defaultModel: 'gpt-5.4',
    sessionPolicy: 'fresh-per-query',
    deploymentShape: 'local-process',
    auth: {
      mode: 'cli-login',
      provider: 'OpenAI',
    },
    capabilities: {
      supportsResume: false,
      supportsPlugins: true,
      supportsAllowedTools: true,
    },
  },
  'cursor-cli': {
    id: 'cursor-cli',
    canonicalId: 'cursor-cli',
    displayName: 'Cursor',
    providerName: 'Cursor Agent CLI',
    defaultModel: 'sonnet-4',
    sessionPolicy: 'persistent',
    deploymentShape: 'local-process',
    auth: {
      mode: 'cli-login',
      provider: 'Cursor',
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: false,
      supportsAllowedTools: false,
    },
  },
  'public-agent-remote': {
    id: 'public-agent-remote',
    canonicalId: 'public-agent-remote',
    displayName: 'Public Agent (Remote)',
    providerName: 'Public Agent (Remote)',
    defaultModel: 'unknown',
    sessionPolicy: 'remote-owned',
    deploymentShape: 'remote-endpoint',
    auth: {
      mode: 'ssh-tunnel',
    },
    capabilities: {
      supportsResume: false,
      supportsPlugins: false,
      supportsAllowedTools: false,
    },
  },
};

export function getDefaultRuntime(): RuntimeId {
  return DEFAULT_RUNTIME;
}

export function getRuntimeProfile(runtime: HarnessType | string | undefined): RuntimeProfile {
  const alias = runtime ? RUNTIME_ALIASES[runtime] : undefined;
  const id = isRuntimeId(runtime) ? runtime : alias || DEFAULT_RUNTIME;
  return PROFILES[id];
}

export function resolveRuntime(runtime: HarnessType | string | undefined): RuntimeId {
  return getRuntimeProfile(runtime).id;
}

export function getRuntimeDisplayName(runtime: HarnessType | string | undefined): string {
  return getRuntimeProfile(runtime).displayName;
}

export function getRuntimeProviderName(runtime: HarnessType | string | undefined): string {
  return getRuntimeProfile(runtime).providerName;
}

export function getRuntimeAuthProvider(runtime: HarnessType | string | undefined): string {
  return getRuntimeProfile(runtime).auth.provider ?? '';
}

export function getDefaultModelForRuntime(
  runtime: HarnessType | string | undefined,
  configuredDefault?: string
): string {
  return configuredDefault || getRuntimeProfile(runtime).defaultModel;
}

export function usesCliLogin(runtime: HarnessType | string | undefined): boolean {
  return getRuntimeProfile(runtime).auth.mode === 'cli-login';
}

export function supportsSessionResume(runtime: HarnessType | string | undefined): boolean {
  return getRuntimeProfile(runtime).capabilities.supportsResume;
}

/**
 * Runtime-specific filesystem paths for agent templates, skills, and personality files.
 *
 * Claude runtimes use .claude/ conventions (CLAUDE.md, .claude/skills/, .claude/agents/).
 * Codex uses .agents/ conventions (AGENTS.md at project root, .agents/skills/, .agents/{name}/).
 */
export interface RuntimePaths {
  /** Directory containing agent templates, relative to workingDir (e.g. '.claude/agents' or '.agents') */
  templateDir: string;
  /** Where overlay contents are copied to, relative to workingDir (e.g. '.claude' or '.agents') */
  overlayTarget: string;
  /** Directory for deployed skills, relative to workingDir (e.g. '.claude/skills' or '.agents/skills') */
  skillsDir: string;
  /** Personality/instructions file path, relative to workingDir (e.g. '.claude/CLAUDE.md' or 'AGENTS.md') */
  personalityFile: string;
  /** Filename for the personality file inside a template directory (e.g. 'CLAUDE.md' or 'AGENTS.md') */
  personalityFilename: string;
}

export function getRuntimePaths(runtime: HarnessType | string | undefined): RuntimePaths {
  const resolved = resolveRuntime(runtime);
  if (resolved === 'codex') {
    return {
      templateDir: '.agents',
      overlayTarget: '.agents',
      skillsDir: '.agents/skills',
      personalityFile: 'AGENTS.md',
      personalityFilename: 'AGENTS.md',
    };
  }
  if (resolved === 'cursor-cli') {
    return {
      templateDir: '.cursor/agents',
      overlayTarget: '.cursor',
      skillsDir: '.cursor/skills',
      personalityFile: 'AGENTS.md',
      personalityFilename: 'AGENTS.md',
    };
  }
  // All Claude runtimes: claude-agent-sdk, claude-code-cli, claude-code-local
  return {
    templateDir: '.claude/agents',
    overlayTarget: '.claude',
    skillsDir: '.claude/skills',
    personalityFile: '.claude/CLAUDE.md',
    personalityFilename: 'CLAUDE.md',
  };
}

export function getAvailableRuntimes(): RuntimeId[] {
  return Object.keys(PROFILES) as RuntimeId[];
}

export function isRuntimeId(runtime: string | undefined): runtime is RuntimeId {
  return !!runtime && runtime in PROFILES;
}

export function isSupportedRuntimeSpecifier(runtime: string | undefined): boolean {
  return !!runtime && (runtime in PROFILES || runtime in RUNTIME_ALIASES);
}

/**
 * Returns true only for runtimes whose deployment shape is 'remote-endpoint'.
 *
 * Use this single gate in spawners, launchers, lifecycle endpoints, and log-tailers
 * to short-circuit all local-process logic for remote-endpoint runtimes.
 *
 * Currently the only remote-endpoint runtime is 'public-agent-remote'. Additional
 * remote-endpoint runtimes added in the future will be detected automatically via
 * the profile's deploymentShape field.
 */
export function isRemoteEndpointRuntime(runtime: string | undefined): boolean {
  if (!runtime || !(runtime in PROFILES)) return false;
  return PROFILES[runtime as RuntimeId].deploymentShape === 'remote-endpoint';
}

function classifyModelFamily(model: string | undefined): 'claude' | 'openai' | 'unknown' {
  if (!model) return 'unknown';
  const normalized = model.trim().toLowerCase();

  if (['haiku', 'sonnet', 'opus', 'fable', 'fable-5', 'fable-5-1', 'mythos', 'mythos-5'].includes(normalized) || normalized.startsWith('claude')) {
    return 'claude';
  }

  if (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  ) {
    return 'openai';
  }

  return 'unknown';
}

export function validateRuntimeModelCompatibility(
  runtime: HarnessType | string | undefined,
  model: string | undefined
): RuntimeValidationIssue[] {
  if (!model) return [];

  const resolvedRuntime = resolveRuntime(runtime);
  const family = classifyModelFamily(model);
  const issues: RuntimeValidationIssue[] = [];

  // Cursor Agent CLI supports both Claude-family (sonnet-4, sonnet-4-thinking)
  // and OpenAI-family (gpt-5, ...) models, so skip cross-family checks for it.
  if (resolvedRuntime === 'cursor-cli') return issues;

  if (resolvedRuntime === 'codex' && family === 'claude') {
    issues.push({
      code: 'runtime_model_mismatch',
      message: `runtime "${resolvedRuntime}" is incompatible with Claude model "${model}"`,
    });
  }

  if (resolvedRuntime !== 'codex' && family === 'openai') {
    issues.push({
      code: 'runtime_model_mismatch',
      message: `runtime "${resolvedRuntime}" is incompatible with OpenAI model "${model}"`,
    });
  }

  return issues;
}

function checkCommandAvailable(command: string): RuntimeValidationIssue[] {
  try {
    execFileSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return [];
  } catch {
    return [{
      code: 'runtime_binary_missing',
      message: `required runtime command "${command}" is not installed or not on PATH`,
    }];
  }
}

/**
 * Map a preflight issue code to a one-line setup hint shown at spawn time.
 * Returns null for codes without a curated hint; callers should fall back to issue.message.
 */
export function runtimeIssueHint(code: string): string | null {
  switch (code) {
    case 'anthropic_api_key_missing':
      return 'Missing ANTHROPIC_API_KEY. Add `export ANTHROPIC_API_KEY=sk-...` to ~/.zshrc (or ~/.bashrc) or to a project .env. Get a key: https://console.anthropic.com/settings/keys';
    case 'codex_auth_missing':
      return 'Missing OPENAI_API_KEY. Add `export OPENAI_API_KEY=sk-...` to ~/.zshrc (or ~/.bashrc) or to a project .env, or run `codex login`. Docs: https://github.com/openai/codex';
    case 'cursor_auth_missing':
      return 'Cursor Agent CLI is not authenticated. Set `CURSOR_API_KEY` or run `cursor-agent login` on this host. Install: curl https://cursor.com/install -fsS | bash';
    default:
      return null;
  }
}

export function validateRuntimePreflight(
  runtime: HarnessType | string | undefined,
  model?: string
): RuntimeValidationIssue[] {
  const resolvedRuntime = resolveRuntime(runtime);
  const issues: RuntimeValidationIssue[] = [
    ...validateRuntimeModelCompatibility(resolvedRuntime, model),
  ];

  if (resolvedRuntime === 'claude-agent-sdk') {
    if (!process.env.ANTHROPIC_API_KEY) {
      issues.push({
        code: 'anthropic_api_key_missing',
        message: 'runtime "claude-agent-sdk" requires ANTHROPIC_API_KEY',
      });
    }
    return issues;
  }

  if (resolvedRuntime === 'claude-code-cli' || resolvedRuntime === 'claude-code-local') {
    return [...issues, ...checkCommandAvailable('claude')];
  }

  if (resolvedRuntime === 'cursor-cli') {
    issues.push(...checkCommandAvailable('cursor-agent'));
    if (!process.env.CURSOR_API_KEY) {
      try {
        const result = spawnSync('cursor-agent', ['status'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        });
        const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
        if (/not logged in/i.test(combinedOutput)) {
          issues.push({
            code: 'cursor_auth_missing',
            message: 'runtime "cursor-cli" requires CURSOR_API_KEY or an active `cursor-agent login` session',
          });
        }
      } catch {
        issues.push({
          code: 'cursor_auth_missing',
          message: 'runtime "cursor-cli" requires CURSOR_API_KEY or an active `cursor-agent login` session',
        });
      }
    }
    return issues;
  }

  if (resolvedRuntime === 'codex') {
    issues.push(...checkCommandAvailable('codex'));
    if (!process.env.OPENAI_API_KEY) {
      try {
        const result = spawnSync('codex', ['login', 'status'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        });
        const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
        if (result.status !== 0 && !/logged in/i.test(combinedOutput)) {
          issues.push({
            code: 'codex_auth_missing',
            message: 'runtime "codex" requires OPENAI_API_KEY or an active `codex login` session',
          });
        }
      } catch {
        issues.push({
          code: 'codex_auth_missing',
          message: 'runtime "codex" requires OPENAI_API_KEY or an active `codex login` session',
        });
      }
    }
  }

  return issues;
}
