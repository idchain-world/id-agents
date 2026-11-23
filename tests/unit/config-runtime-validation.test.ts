// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import type { DeployConfig } from '../../src/config-parser.js';
import { validateConfig } from '../../src/config-parser.js';

describe('config runtime validation', () => {
  it.each(['antigravity-cli', 'antigravity'] as const)('accepts %s in defaults and agent overrides', runtime => {
    expect(validateConfig({ version: '1', defaults: { runtime, model: 'neon', effort: 'high' },
      agents: [{ name: 'first' }, { name: 'second', runtime, effort: 'low' }] }).errors).toEqual([]);
  });

  it('rejects Codex runtime with a Claude default model', () => {
    const config: DeployConfig = {
      version: '1',
      defaults: {
        runtime: 'codex',
        model: 'claude-haiku-4-5-20251001',
      },
      agents: [
        { name: 'coder' },
      ],
    };

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: 'agents[0].runtime',
        message: 'runtime "codex" is incompatible with Claude model "claude-haiku-4-5-20251001"',
      },
      {
        path: 'defaults.model',
        message: 'runtime "codex" is incompatible with Claude model "claude-haiku-4-5-20251001"',
      },
    ]);
  });

  it('rejects Claude runtime with an OpenAI model', () => {
    const config: DeployConfig = {
      version: '1',
      defaults: {
        runtime: 'claude-agent-sdk',
      },
      agents: [
        {
          name: 'researcher',
          model: 'gpt-5.4',
        },
      ],
    };

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: 'agents[0].model',
        message: 'runtime "claude-agent-sdk" is incompatible with OpenAI model "gpt-5.4"',
      },
    ]);
  });

  it('accepts mixed-runtime configs when each agent model matches its runtime', () => {
    const config: DeployConfig = {
      version: '1',
      defaults: {
        local: true,
      },
      agents: [
        {
          name: 'coder',
          runtime: 'codex',
          model: 'gpt-5.4',
        },
        {
          name: 'reviewer',
          runtime: 'claude-code-cli',
          model: 'claude-sonnet-4-20250514',
        },
      ],
    };

    const result = validateConfig(config);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('still validates runtime ids before model compatibility', () => {
    const config: DeployConfig = {
      version: '1',
      defaults: {
        runtime: 'not-a-runtime' as any,
      },
      agents: [
        { name: 'coder' },
      ],
    };

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      path: 'defaults.runtime',
      message: expect.stringContaining('runtime must be one of:'),
    });
  });
});
