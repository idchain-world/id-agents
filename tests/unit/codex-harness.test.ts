// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { buildCodexExecArgs } from '../../src/harness/codex.js';

describe('buildCodexExecArgs', () => {
  it('passes Codex reasoning effort through the config override flag', () => {
    const args = buildCodexExecArgs({
      workingDirectory: '/work',
      model: 'gpt-5.4',
      effort: 'high',
    }, true);

    expect(args).toEqual([
      'exec',
      '--cd',
      '/work',
      '--json',
      '--model',
      'gpt-5.4',
      '-c',
      'model_reasoning_effort=high',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
    ]);
  });

  it('omits reasoning effort when unset and preserves full-auto mode', () => {
    const args = buildCodexExecArgs({ workingDirectory: '/work' }, false);

    expect(args).toEqual([
      'exec',
      '--cd',
      '/work',
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
    ]);
  });
});
