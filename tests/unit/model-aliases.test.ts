// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { MODEL_ALIASES, resolveModelAlias } from '../../src/agent-manager-db.js';
import { modelDisplayName } from '../../src/claude-agent.js';
import { abbrevEffort } from '../../src/tui/util/effort.js';
import { abbrevModel } from '../../src/tui/util/models.js';
import { abbrevRuntime } from '../../src/tui/util/runtime.js';

describe('model alias resolution', () => {
  it.each([
    ['astra-6', 'gpt-6-astra'],
    ['ASTRA-6', 'gpt-6-astra'],
    ['grok-4.6', 'cursor-grok-4.6-high'],
    ['grok-4-6', 'cursor-grok-4.6-high'],
    ['GROK-4.6', 'cursor-grok-4.6-high'],
    ['grok-4.7', 'grok-4.7-high'],
    ['grok-4-7', 'grok-4.7-high'],
    ['GROK-4.7', 'grok-4.7-high'],
  ])('resolves %s to %s and remains idempotent', (alias, canonical) => {
    expect(resolveModelAlias(alias)).toBe(canonical);
    expect(resolveModelAlias(resolveModelAlias(alias))).toBe(canonical);
  });

  it.each([
    'gpt-6-astra',
    'cursor-grok-4.6-low',
    'cursor-grok-4.6-medium',
    'cursor-grok-4.6-high',
    'cursor-grok-4.6-xhigh',
    'cursor-grok-4.6-high-fast',
  ])('preserves the explicit model choice %s', (model) => {
    expect(resolveModelAlias(model)).toBe(model);
  });

  it('resolves the fable aliases to canonical model ids', () => {
    expect(resolveModelAlias('fable')).toBe('claude-fable-5-1'); // bare alias = latest
    expect(resolveModelAlias('fable-5')).toBe('claude-fable-5');
  });

  it('resolves the opus-5 aliases to the canonical model id', () => {
    expect(resolveModelAlias('opus-5')).toBe('claude-opus-5');
    expect(resolveModelAlias('opus5')).toBe('claude-opus-5');
    expect(resolveModelAlias('OPUS-5')).toBe('claude-opus-5');
    // Idempotent: the canonical id passes through unchanged.
    expect(resolveModelAlias('claude-opus-5')).toBe('claude-opus-5');
  });

  it('resolves the opus-5.5 aliases to the canonical model id', () => {
    expect(resolveModelAlias('opus-5.5')).toBe('claude-opus-5-5');
    expect(resolveModelAlias('opus-5-5')).toBe('claude-opus-5-5');
    expect(resolveModelAlias('opus5.5')).toBe('claude-opus-5-5');
    expect(resolveModelAlias('OPUS-5.5')).toBe('claude-opus-5-5');
    expect(resolveModelAlias('claude-opus-5-5')).toBe('claude-opus-5-5');
    // 5.5 must not shadow 5: the shorter alias still resolves to Opus 5.
    expect(resolveModelAlias('opus-5')).toBe('claude-opus-5');
  });

  it('resolves the grok aliases to the Cursor CLI model id', () => {
    expect(resolveModelAlias('grok')).toBe('grok-4.7-high'); // bare alias = latest
    expect(resolveModelAlias('grok-4.5')).toBe('grok-4.5');
    expect(resolveModelAlias('grok-4-5')).toBe('grok-4.5');
    expect(resolveModelAlias('GROK')).toBe('grok-4.7-high');
  });

  it('bare opus tracks the latest Opus; versioned aliases keep their version', () => {
    expect(resolveModelAlias('opus')).toBe('claude-opus-5-5');
    expect(resolveModelAlias('opus-5')).toBe('claude-opus-5');
    expect(resolveModelAlias('opus-4.8')).toBe('claude-opus-4-8');
  });

  it('is case-insensitive', () => {
    expect(resolveModelAlias('Fable')).toBe('claude-fable-5-1');
    expect(resolveModelAlias('FABLE-5')).toBe('claude-fable-5');
    expect(resolveModelAlias('OPUS')).toBe('claude-opus-5-5');
  });

  // Bare aliases (opus/grok/fable) track the LATEST version by policy; the
  // versioned aliases below are the ones that must never move.
  it('preserves existing aliases (regression)', () => {
    expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-5-20251001');
    expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-5');
    expect(resolveModelAlias('opus')).toBe('claude-opus-5-5');
    expect(resolveModelAlias('opus-4-8')).toBe('claude-opus-4-8');
    expect(resolveModelAlias('opus-4.8')).toBe('claude-opus-4-8');
  });

  it('passes unknown / already-canonical model strings through unchanged', () => {
    // `mythos` was removed on 2026-09-22 (not generally available): it is now an unknown string.
    expect(resolveModelAlias('mythos')).toBe('mythos');
    expect(resolveModelAlias('mythos-5')).toBe('mythos-5');
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
  it('labels fable models', () => {
    expect(modelDisplayName('claude-fable-5')).toBe('Fable 5');
    expect(modelDisplayName('fable')).toBe('Fable 5');
    expect(modelDisplayName('anthropic/claude-fable-5-project')).toBe('Fable 5');
  });

  it('labels opus 5 distinctly from the opus 4 family', () => {
    expect(modelDisplayName('claude-opus-5')).toBe('Opus 5');
    // The generic `opus` arm must not swallow it, and `opus-4-5` must not
    // accidentally match the `opus-5` substring.
    expect(modelDisplayName('claude-opus-4-5-20250514')).toBe('Opus 4 (Premium)');
    expect(modelDisplayName('claude-opus-4-8')).toBe('Opus 4 (Premium)');
  });

  it('labels opus 5.5 distinctly from opus 5', () => {
    // `claude-opus-5-5` contains the `opus-5` substring; the 5.5 arm must win.
    expect(modelDisplayName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelDisplayName('claude-opus-5')).toBe('Opus 5');
  });

  it('preserves existing model labels (regression)', () => {
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5 (Cheap)');
    expect(modelDisplayName('claude-sonnet-4-20250514')).toBe('Sonnet 4 (Balanced)');
    expect(modelDisplayName('claude-opus-4-20250514')).toBe('Opus 4 (Premium)');
  });

  it('falls back to the raw model string when unrecognized', () => {
    expect(modelDisplayName('mythos')).toBe('mythos'); // no longer labelled
    expect(modelDisplayName('gpt-5.4')).toBe('gpt-5.4');
  });
});

describe('TUI model abbreviations', () => {
  it.each([
    ['gpt-6-astra', 'astra-6'],
    ['astra-6', 'astra-6'],
    ['grok-4.6', 'grok-4.6'],
    ['grok-4-6', 'grok-4.6'],
    ['cursor-grok-4.6-high', 'grok-4.6'],
    ['cursor-grok-4.6-low', 'g4.6-lo'],
    ['cursor-grok-4.6-medium', 'g4.6-med'],
    ['cursor-grok-4.6-xhigh', 'g4.6-xhi'],
    ['cursor-grok-4.6-low-fast', 'g4.6-lo-f'],
    ['cursor-grok-4.6-medium-fast', 'g4.6-md-f'],
    ['cursor-grok-4.6-high-fast', 'g4.6-hi-f'],
    ['cursor-grok-4.6-xhigh-fast', 'g4.6-xh-f'],
    ['claude-opus-5-5', 'opus-5.5'],
    ['grok-4.7', 'grok-4.7'],
    ['grok-4-7', 'grok-4.7'],
    ['grok-4.7-high', 'grok-4.7'],
    ['grok-4.7-low', 'g4.7-lo'],
    ['grok-4.7-medium', 'g4.7-med'],
    ['grok-4.7-xhigh', 'g4.7-xhi'],
    ['grok-4.7-low-fast', 'g4.7-lo-f'],
    ['grok-4.7-medium-fast', 'g4.7-md-f'],
    ['grok-4.7-high-fast', 'g4.7-hi-f'],
    ['grok-4.7-xhigh-fast', 'g4.7-xh-f'],
  ])('displays %s as %s without overflowing the MODEL column', (model, label) => {
    expect(abbrevModel(model)).toBe(label);
    expect(label.length).toBeLessThanOrEqual(9);
  });

  it('preserves missing and unknown model fallbacks', () => {
    expect(abbrevModel(undefined)).toBe('—');
    expect(abbrevModel('')).toBe('—');
    expect(abbrevModel('future-model')).toBe('future-model');
  });

  it('abbreviates fable model ids', () => {
    expect(abbrevModel('claude-fable-5')).toBe('fable-5');
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
