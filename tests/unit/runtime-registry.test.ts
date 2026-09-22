// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  getDefaultModelForRuntime,
  getDefaultRuntime,
  getRuntimeDisplayName,
  getRuntimeProfile,
  getRuntimeProviderName,
  resolveRuntime,
  supportsSessionResume,
  usesCliLogin,
  validateRuntimeModelCompatibility,
} from '../../src/runtime/registry.js';

describe('runtime registry', () => {
  it('returns the shared default runtime', () => {
    expect(getDefaultRuntime()).toBe('claude-agent-sdk');
  });

  it('resolves unknown runtimes to the shared default', () => {
    expect(resolveRuntime(undefined)).toBe('claude-agent-sdk');
    expect(resolveRuntime('not-a-runtime')).toBe('claude-agent-sdk');
  });

  it('maps codex-cli to the codex runtime profile', () => {
    expect(resolveRuntime('codex-cli')).toBe('codex');
    expect(getRuntimeProfile('codex-cli').canonicalId).toBe('codex');
    expect(getRuntimeDisplayName('codex-cli')).toBe('Codex');
  });

  it('maps claude-code-local to the Claude Code profile while preserving id', () => {
    const profile = getRuntimeProfile('claude-code-local');
    expect(profile.id).toBe('claude-code-local');
    expect(profile.canonicalId).toBe('claude-code-cli');
    expect(profile.displayName).toBe('Claude Code');
  });

  it('returns runtime display and provider labels', () => {
    expect(getRuntimeDisplayName('codex')).toBe('Codex');
    expect(getRuntimeProviderName('codex')).toBe('Codex CLI');
    expect(getRuntimeDisplayName('claude-agent-sdk')).toBe('Claude');
  });

  it('returns runtime-specific default models', () => {
    expect(getDefaultModelForRuntime('codex')).toBe('gpt-5.4');
    expect(getDefaultModelForRuntime('claude-agent-sdk')).toBe('claude-haiku-4-5-20251001');
    // The Claude CLI runtimes default to the BARE alias so an agent with no model set
    // re-resolves to the latest Opus at every spawn, rather than pinning one version.
    expect(getDefaultModelForRuntime('claude-code-cli')).toBe('opus');
    expect(getDefaultModelForRuntime('claude-code-local')).toBe('opus');
  });

  it('honors explicit configured defaults when provided', () => {
    expect(getDefaultModelForRuntime('codex', 'gpt-5.5-preview')).toBe('gpt-5.5-preview');
  });

  it('tracks auth and session behavior by runtime', () => {
    expect(usesCliLogin('codex')).toBe(true);
    expect(usesCliLogin('claude-code-cli')).toBe(true);
    expect(usesCliLogin('claude-agent-sdk')).toBe(false);

    expect(supportsSessionResume('codex')).toBe(false);
    expect(supportsSessionResume('claude-code-cli')).toBe(true);
  });

  it('flags incompatible runtime/model combinations', () => {
    expect(validateRuntimeModelCompatibility('codex', 'claude-haiku-4-5-20251001')).toEqual([
      {
        code: 'runtime_model_mismatch',
        message: 'runtime "codex" is incompatible with Claude model "claude-haiku-4-5-20251001"',
      },
    ]);

    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'gpt-5.4')).toEqual([
      {
        code: 'runtime_model_mismatch',
        message: 'runtime "claude-agent-sdk" is incompatible with OpenAI model "gpt-5.4"',
      },
    ]);
  });

  it('accepts models from the matching provider family', () => {
    expect(validateRuntimeModelCompatibility('codex', 'gpt-5.4')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-code-cli', 'claude-sonnet-4-20250514')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'haiku')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'fable')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'fable-5')).toEqual([]);
  });

  it.each(['astra-6', 'ASTRA-6', 'gpt-6-astra'])('validates the Astra model %s as OpenAI', (model) => {
    expect(validateRuntimeModelCompatibility('codex', model)).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-code-cli', model)).toEqual([
      { code: 'runtime_model_mismatch', message: `runtime "claude-code-cli" is incompatible with OpenAI model "${model}"` },
    ]);
  });

  // Grok 4.6 ids carry a `cursor-` prefix; 4.5 and 4.7 do not. All must classify as Cursor.
  it.each(['grok', 'grok-4.5', 'grok-4.6', 'grok-4-6', 'cursor-grok-4.6-high', 'cursor-grok-4.6-xhigh-fast', 'grok-4.7', 'grok-4-7', 'grok-4.7-high', 'grok-4.7-xhigh-fast'])(
    'requires cursor-cli for %s', (model) => {
      expect(validateRuntimeModelCompatibility('cursor-cli', model)).toEqual([]);
      for (const runtime of ['codex', 'claude-code-cli', 'claude-agent-sdk']) {
        expect(validateRuntimeModelCompatibility(runtime, model)).toEqual([
          { code: 'runtime_model_mismatch', message: `runtime "${runtime}" is incompatible with Cursor model "${model}"; use runtime "cursor-cli"` },
        ]);
      }
    },
  );

  it('treats fable short names as the Claude family', () => {
    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'fable')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-code-cli', 'claude-fable-5')).toEqual([]);
    // The mythos SHORT NAME is gone, but a canonical claude-* id still classifies as Claude (passthrough).
    expect(validateRuntimeModelCompatibility('claude-code-cli', 'claude-mythos-5')).toEqual([]);
    // ...and therefore incompatible with the codex (OpenAI) runtime
    expect(validateRuntimeModelCompatibility('codex', 'fable')).toEqual([
      {
        code: 'runtime_model_mismatch',
        message: 'runtime "codex" is incompatible with Claude model "fable"',
      },
    ]);
  });

  it('exposes the cursor-cli runtime profile', () => {
    const profile = getRuntimeProfile('cursor-cli');
    expect(profile.id).toBe('cursor-cli');
    expect(profile.canonicalId).toBe('cursor-cli');
    expect(profile.displayName).toBe('Cursor');
    expect(profile.auth.mode).toBe('cli-login');
    expect(profile.capabilities.supportsResume).toBe(true);
    expect(getDefaultModelForRuntime('cursor-cli')).toBe('sonnet-4');
  });

  it('accepts both OpenAI and Claude model families for cursor-cli', () => {
    expect(validateRuntimeModelCompatibility('cursor-cli', 'gpt-5')).toEqual([]);
    expect(validateRuntimeModelCompatibility('cursor-cli', 'sonnet-4')).toEqual([]);
    expect(validateRuntimeModelCompatibility('cursor-cli', 'claude-opus-4-20250514')).toEqual([]);
  });
});
