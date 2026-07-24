// SPDX-License-Identifier: MIT
// Short names for model strings shown in the TUI agents table.
//
// Maintain this table by hand. When a new model appears, add an entry.
// Until then the row will display the full model string and visibly
// overflow the column — that's a feature, not a bug, because it makes
// missing entries obvious.

export const MODEL_ABBREVIATIONS: Record<string, string> = {
  // Anthropic Claude
  'claude-opus-4-20250514': 'opus-4-0',
  'claude-opus-4-5-20250514': 'opus-4-5',
  'claude-opus-4-6': 'opus-4-6',
  'claude-opus-4-7': 'opus-4-7',
  'claude-opus-4-8': 'opus-4.8',
  'claude-opus-5': 'opus-5',
  'claude-sonnet-4-5-20250514': 'sonn-4-5',
  'claude-sonnet-4-6': 'sonn-4-6',
  'claude-sonnet-5': 'sonn-5',
  'claude-haiku-4-5-20251001': 'haiku-4-5',
  'claude-fable-5': 'fable-5',
  'claude-mythos-5': 'myth-5',
  // Raw alias some agents store verbatim (e.g. `model: fable` in YAML)
  'fable': 'fable-5',

  // OpenAI Codex
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.5': 'gpt-5.5',
  // 5.6 named variants — compress to a 'g5.6-' prefix + 3-letter suffix so the
  // version stays visible and the cell fits the MODEL column (9 chars shown).
  'gpt-5.6-luna': 'g5.6-lun',
  'gpt-5.6-terra': 'g5.6-ter',
  'gpt-5.6-sol': 'g5.6-sol',

  // Cursor / Composer
  'composer-2': 'comp-2',
  'grok-4.5': 'grok-4.5',
};

/**
 * Look up the short display name for a model.
 *
 *   - In the table → returns the abbreviation.
 *   - Not in the table → returns the input unchanged (will overflow the
 *     column, which signals "add me to the table").
 *   - Missing/empty → returns `—`.
 */
export function abbrevModel(model: string | undefined): string {
  if (!model) return '—';
  return MODEL_ABBREVIATIONS[model] ?? model;
}
