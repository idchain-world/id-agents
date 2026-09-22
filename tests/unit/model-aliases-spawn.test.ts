// SPDX-License-Identifier: MIT
//
// Focused coverage for the resolver used when a config/db-supplied model is
// written into a spawned agent's CLAUDE_MODEL env (agent-manager-db
// buildLocalAgentEnv + interactive-agent-cli spawn paths). The key guarantee
// for that bug fix is idempotency: a canonical full id must pass through
// unchanged so re-resolving an already-resolved value is always safe.

import { describe, expect, it } from 'vitest';

import { resolveModelAlias } from '../../src/core/model-aliases.js';

describe('resolveModelAlias (spawn CLAUDE_MODEL sites)', () => {
  it('resolves short aliases to canonical model ids', () => {
    expect(resolveModelAlias('fable')).toBe('claude-fable-5-1');
    expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-5-20251001');
    expect(resolveModelAlias('opus-4.8')).toBe('claude-opus-4-8');
    expect(resolveModelAlias('astra-6')).toBe('gpt-6-astra');
    expect(resolveModelAlias('grok-4.6')).toBe('cursor-grok-4.6-high');
  });

  it('is case-insensitive', () => {
    expect(resolveModelAlias('Fable')).toBe('claude-fable-5-1');
    expect(resolveModelAlias('OPUS-4.8')).toBe('claude-opus-4-8');
  });

  it('passes a full canonical model id through unchanged (idempotent)', () => {
    for (const id of [
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-20250514',
      'gpt-6-astra',
      'cursor-grok-4.6-high',
      'claude-opus-5-5',
      'grok-4.7-high',
    ]) {
      expect(resolveModelAlias(id)).toBe(id);
      // resolving twice must equal resolving once
      expect(resolveModelAlias(resolveModelAlias(id))).toBe(id);
    }
  });

  it('passes unknown / non-Claude model strings through unchanged', () => {
    expect(resolveModelAlias('gpt-5.4')).toBe('gpt-5.4');
    expect(resolveModelAlias('some-future-model')).toBe('some-future-model');
  });
});
