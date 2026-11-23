// SPDX-License-Identifier: MIT
// Short names for runtime identifiers shown in the TUI agents table.
//
// Maintain this table by hand. Unknown values intentionally pass through so
// a new runtime is visible until it receives an appropriate display label.

export const RUNTIME_ABBREVIATIONS: Record<string, string> = {
  'claude-code-cli': 'claude',
  'antigravity-cli': 'antigravity',
  'cursor-cli': 'cursor',
  codex: 'codex',
};

/**
 * Short display name for an agent runtime.
 *   - In the table → returns the abbreviation.
 *   - Not in the table → returns the input unchanged.
 *   - Missing/empty → returns `—`.
 */
export function abbrevRuntime(runtime: string | undefined): string {
  if (!runtime) return '—';
  return RUNTIME_ABBREVIATIONS[runtime] ?? runtime;
}
