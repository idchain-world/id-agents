// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { MODEL_ALIASES, resolveModelAlias } from '../../src/agent-manager-db.js';
import { modelDisplayName } from '../../src/claude-agent.js';
import { abbrevEffort } from '../../src/tui/util/effort.js';
import { abbrevModel } from '../../src/tui/util/models.js';
import { abbrevRuntime } from '../../src/tui/util/runtime.js';

describe('model alias resolution', () => {
  it('resolves the new fable/mythos aliases to canonical model ids', () => {
    expect(resolveModelAlias('fable')).toBe('claude-fable-5');
    expect(resolveModelAlias('fable-5')).toBe('claude-fable-5');
    expect(resolveModelAlias('mythos')).toBe('claude-mythos-5');
    expect(resolveModelAlias('mythos-5')).toBe('claude-mythos-5');
  });

  it('resolves the opus-5 aliases to the canonical model id', () => {
    expect(resolveModelAlias('opus-5')).toBe('claude-opus-5');
    expect(resolveModelAlias('opus5')).toBe('claude-opus-5');
    expect(resolveModelAlias('OPUS-5')).toBe('claude-opus-5');
    // Idempotent: the canonical id passes through unchanged.
    expect(resolveModelAlias('claude-opus-5')).toBe('claude-opus-5');
  });

  it('resolves the grok aliases to the Cursor CLI model id', () => {
    expect(resolveModelAlias('grok')).toBe('grok-4.5');
    expect(resolveModelAlias('grok-4.5')).toBe('grok-4.5');
    expect(resolveModelAlias('grok-4-5')).toBe('grok-4.5');
    expect(resolveModelAlias('GROK')).toBe('grok-4.5');
  });

  it('does not let opus-5 shadow the older opus aliases', () => {
    expect(resolveModelAlias('opus')).toBe('claude-opus-4-5-20250514');
    expect(resolveModelAlias('opus-4.8')).toBe('claude-opus-4-8');
  });

  it('is case-insensitive', () => {
    expect(resolveModelAlias('Fable')).toBe('claude-fable-5');
    expect(resolveModelAlias('FABLE-5')).toBe('claude-fable-5');
    expect(resolveModelAlias('Mythos')).toBe('claude-mythos-5');
    expect(resolveModelAlias('MYTHOS-5')).toBe('claude-mythos-5');
    expect(resolveModelAlias('OPUS')).toBe('claude-opus-4-5-20250514');
  });

  it('preserves existing aliases (regression)', () => {
    expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-5-20251001');
    expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-5');
    expect(resolveModelAlias('opus')).toBe('claude-opus-4-5-20250514');
    expect(resolveModelAlias('opus-4-8')).toBe('claude-opus-4-8');
    expect(resolveModelAlias('opus-4.8')).toBe('claude-opus-4-8');
  });

  it('passes unknown / already-canonical model strings through unchanged', () => {
    expect(resolveModelAlias('claude-fable-5')).toBe('claude-fable-5');
    expect(resolveModelAlias('gpt-5.4')).toBe('gpt-5.4');
    expect(resolveModelAlias('some-unknown-model')).toBe('some-unknown-model');
  });

  it('keeps the alias table and resolver in sync', () => {
    for (const [alias, canonical] of Object.entries(MODEL_ALIASES)) {
      expect(resolveModelAlias(alias)).toBe(canonical);
    }
  });
});

describe('model display labels', () => {
  it('labels fable and mythos models', () => {
    expect(modelDisplayName('claude-fable-5')).toBe('Fable 5');
    expect(modelDisplayName('fable')).toBe('Fable 5');
    expect(modelDisplayName('anthropic/claude-fable-5-project')).toBe('Fable 5');
    expect(modelDisplayName('claude-mythos-5')).toBe('Mythos 5');
    expect(modelDisplayName('mythos')).toBe('Mythos 5');
    expect(modelDisplayName('anthropic/claude-mythos-5-project')).toBe('Mythos 5');
  });

  it('labels opus 5 distinctly from the opus 4 family', () => {
    expect(modelDisplayName('claude-opus-5')).toBe('Opus 5');
    // The generic `opus` arm must not swallow it, and `opus-4-5` must not
    // accidentally match the `opus-5` substring.
    expect(modelDisplayName('claude-opus-4-5-20250514')).toBe('Opus 4 (Premium)');
    expect(modelDisplayName('claude-opus-4-8')).toBe('Opus 4 (Premium)');
  });

  it('preserves existing model labels (regression)', () => {
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5 (Cheap)');
    expect(modelDisplayName('claude-sonnet-4-20250514')).toBe('Sonnet 4 (Balanced)');
    expect(modelDisplayName('claude-opus-4-20250514')).toBe('Opus 4 (Premium)');
  });

  it('falls back to the raw model string when unrecognized', () => {
    expect(modelDisplayName('gpt-5.4')).toBe('gpt-5.4');
  });
});

describe('TUI model abbreviations', () => {
  it('abbreviates fable and mythos model ids', () => {
    expect(abbrevModel('claude-fable-5')).toBe('fable-5');
    expect(abbrevModel('claude-mythos-5')).toBe('myth-5');
  });

  it('abbreviates opus 5 and the Cursor grok model id', () => {
    expect(abbrevModel('claude-opus-5')).toBe('opus-5');
    expect(abbrevModel('grok-4.5')).toBe('grok-4.5');
  });
});

describe('TUI effort abbreviations', () => {
  it('abbreviates known effort levels and passes unknowns through', () => {
    expect(abbrevEffort('high')).toBe('hi');
    expect(abbrevEffort('medium')).toBe('med');
    expect(abbrevEffort('low')).toBe('lo');
    expect(abbrevEffort('xhigh')).toBe('xhi');
    expect(abbrevEffort(undefined)).toBe('—');
    expect(abbrevEffort('experimental')).toBe('experimental');
  });
});

describe('TUI runtime abbreviations', () => {
  it('abbreviates known runtimes and passes unknowns through', () => {
    expect(abbrevRuntime('claude-code-cli')).toBe('claude');
    expect(abbrevRuntime('cursor-cli')).toBe('cursor');
    expect(abbrevRuntime('codex')).toBe('codex');
    expect(abbrevRuntime(undefined)).toBe('—');
    expect(abbrevRuntime('experimental-runtime')).toBe('experimental-runtime');
  });
});
