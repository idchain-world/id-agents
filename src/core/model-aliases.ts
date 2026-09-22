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
  'sonnet': 'claude-sonnet-5',
  'sonnet-5': 'claude-sonnet-5',
  'sonnet5': 'claude-sonnet-5',
  // Bare aliases track the LATEST version; versioned aliases stay pinned.
  'opus': 'claude-opus-5-5',
  'opus-4-8': 'claude-opus-4-8',
  'opus-4.8': 'claude-opus-4-8',
  'opus-5': 'claude-opus-5',
  'opus5': 'claude-opus-5',
  'opus-5.5': 'claude-opus-5-5',
  'opus-5-5': 'claude-opus-5-5',
  'opus5.5': 'claude-opus-5-5',
  'fable': 'claude-fable-5-1',
  'fable-5': 'claude-fable-5',
  'fable-5.1': 'claude-fable-5-1',
  'fable-5-1': 'claude-fable-5-1',
  // OpenAI Codex. Keep the requested short name distinct from the provider ID.
  'astra-6': 'gpt-6-astra',
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
