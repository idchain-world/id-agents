// SPDX-License-Identifier: MIT
/**
 * Model alias resolution.
 *
 * Maps operator-friendly short names (e.g. `opus`, `fable`, `opus-4.8`) to the
 * canonical model id the runtimes expect. Resolution is case-insensitive and
 * idempotent: a value that is already a canonical id (or an unknown string)
 * passes through unchanged, so it is always safe to resolve again.
 */
export const MODEL_ALIASES: Record<string, string> = {
  'haiku': 'claude-haiku-4-5-20251001',
  // Bare aliases track the LATEST version; versioned aliases stay pinned.
  'sonnet': 'claude-sonnet-5-5',
  'sonnet-5': 'claude-sonnet-5',
  'sonnet5': 'claude-sonnet-5',
  'sonnet-5.5': 'claude-sonnet-5-5',
  'sonnet-5-5': 'claude-sonnet-5-5',
  'sonnet5.5': 'claude-sonnet-5-5',
  'opus': 'claude-opus-5-5',
  'opus-4-8': 'claude-opus-4-8',
  'opus-4.8': 'claude-opus-4-8',
  'opus-5': 'claude-opus-5',
  'opus5': 'claude-opus-5',
  'opus-5.5': 'claude-opus-5-5',
  'opus-5-5': 'claude-opus-5-5',
  'opus5.5': 'claude-opus-5-5',
  'fable': 'claude-fable-5-2',
  'fable-5': 'claude-fable-5',
  'fable-5.2': 'claude-fable-5-2',
  'fable-5-2': 'claude-fable-5-2',
  'fable-5.1': 'claude-fable-5-1',
  'fable-5-1': 'claude-fable-5-1',
  // Bare Neon tracks the latest version. Versioned aliases stay pinned.
  'neon': 'gemini-4-neon-high',
  'neon-4': 'gemini-4-neon-high',
  'neon4': 'gemini-4-neon-high',
  'neon-low': 'gemini-4-neon-low',
  'neon-medium': 'gemini-4-neon-medium',
  'neon-high': 'gemini-4-neon-high',
  'neon-xhigh': 'gemini-4-neon-xhigh',
  // Bare family names track the latest version. Versioned aliases stay pinned.
  'carbon': 'gemini-4-carbon-high',
  'carbon-4': 'gemini-4-carbon-high',
  'carbon4': 'gemini-4-carbon-high',
  'carbon-low': 'gemini-4-carbon-low',
  'carbon-medium': 'gemini-4-carbon-medium',
  'carbon-high': 'gemini-4-carbon-high',
  'argon': 'gemini-4-argon-high',
  'argon-4': 'gemini-4-argon-high',
  'argon4': 'gemini-4-argon-high',
  'argon-low': 'gemini-4-argon-low',
  'argon-medium': 'gemini-4-argon-medium',
  'argon-high': 'gemini-4-argon-high',
  'hydrogen': 'gemini-4-hydrogen-high',
  'hydrogen-4': 'gemini-4-hydrogen-high',
  'hydrogen4': 'gemini-4-hydrogen-high',
  'hydrogen-low': 'gemini-4-hydrogen-low',
  'hydrogen-medium': 'gemini-4-hydrogen-medium',
  'hydrogen-high': 'gemini-4-hydrogen-high',
  'hydrogen-xhigh': 'gemini-4-hydrogen-xhigh',
  'orchestrator-neon': 'gemini-pro-orchestrator-neon',
  'orchestrator-carbon': 'gemini-pro-orchestrator',
  'orchestrator-argon': 'gemini-pro-orchestrator-argon',
  'orchestrator': 'gemini-pro-orchestrator-neon',
  // OpenAI Codex. Keep the requested short name distinct from the provider ID.
  'astra': 'gpt-6.2-astra',
  'astra-6.2': 'gpt-6.2-astra',
  'astra-6-2': 'gpt-6.2-astra',
  'astra-6': 'gpt-6-astra',
  'sol-6.1': 'gpt-6.1-sol',
  'sol-6-1': 'gpt-6.1-sol',
  // Cursor CLI first-party models. Resolution is runtime-agnostic (the `/model`
  // command resolves before storing), so non-Claude ids belong here too.
  'grok': 'grok-4.7-high',
  'grok-4.5': 'grok-4.5',
  'grok-4-5': 'grok-4.5',
  // Grok 4.6's default Cursor option uses high effort. Preserve older aliases.
  'grok-4.6': 'cursor-grok-4.6-high',
  'grok-4-6': 'cursor-grok-4.6-high',
  // Grok 4.7 ids drop the `cursor-` prefix. Default to high effort as with 4.6.
  'grok-4.7': 'grok-4.7-high',
  'grok-4-7': 'grok-4.7-high',
};

export function resolveModelAlias(model: string): string {
  return MODEL_ALIASES[model.toLowerCase()] || model;
}
