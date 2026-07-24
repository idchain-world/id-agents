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
  'opus': 'claude-opus-4-5-20250514',
  'opus-4-8': 'claude-opus-4-8',
  'opus-4.8': 'claude-opus-4-8',
  'opus-5': 'claude-opus-5',
  'opus5': 'claude-opus-5',
  'fable': 'claude-fable-5',
  'fable-5': 'claude-fable-5',
  'mythos': 'claude-mythos-5',
  'mythos-5': 'claude-mythos-5',
  // Cursor CLI first-party models. Resolution is runtime-agnostic (the `/model`
  // command resolves before storing), so non-Claude ids belong here too.
  'grok': 'grok-4.5',
  'grok-4.5': 'grok-4.5',
  'grok-4-5': 'grok-4.5'
};

export function resolveModelAlias(model: string): string {
  return MODEL_ALIASES[model.toLowerCase()] || model;
}
