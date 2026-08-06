// SPDX-License-Identifier: MIT
/**
 * Item 6: Connect is an information surface, in a terminal.
 *
 * The prompt builder moved to core rather than being rewritten, so the app and
 * the TUI emit the same text. Its one required change: it used to claim the
 * desktop app owns the manager, which is false on a VPS where the TUI started
 * it, and telling an onboarding agent something false is worse than telling it
 * nothing.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { buildConnectPrompt } from '../../src/connect/connect-prompt.js';
import {
  buildTuiConnectView,
  NonLoopbackManagerUrlError,
} from '../../src/tui/connect/view.js';

describe('connect prompt', () => {
  it('no longer claims a particular surface owns the manager', () => {
    const prompt = buildConnectPrompt({
      dependencyRoot: '/dep',
      quickstartPath: '/dep/QUICKSTART.md',
      adminSkillPath: '/dep/skills/idagents-admin-control',
      writableConfigRoot: '/home/node/.id-agents',
      managerUrl: 'http://127.0.0.1:4100',
    });
    expect(prompt).not.toContain('desktop app is already running and owns');
    expect(prompt).toContain('An ID Agents manager is already running');
    // The instruction that actually matters is still there.
    // Capitalised now because the reworded opening makes it a new sentence.
    expect(prompt).toContain('NOT start, restart, or spawn a second manager');
  });

  it('still substitutes every real path, and concatenates none itself', () => {
    const prompt = buildConnectPrompt({
      dependencyRoot: '/dep',
      quickstartPath: '/dep/QUICKSTART.md',
      adminSkillPath: '/dep/skills/idagents-admin-control',
      writableConfigRoot: '/home/node/.id-agents',
      managerUrl: 'http://127.0.0.1:9999',
    });
    for (const value of [
      '/dep', '/dep/QUICKSTART.md', '/dep/skills/idagents-admin-control',
      '/home/node/.id-agents', 'http://127.0.0.1:9999',
    ]) {
      expect(prompt, value).toContain(value);
    }
  });
});

describe('TUI connect view', () => {
  it('resolves the four values and the prompt from the package, not from cwd', () => {
    const view = buildTuiConnectView();
    expect(view.managerUrl).toBe('http://127.0.0.1:4100');
    expect(fs.existsSync(view.quickstartPath)).toBe(true);
    expect(fs.existsSync(view.adminSkillPath)).toBe(true);
    expect(view.prompt).toContain(view.adminSkillPath);
    expect(view.prompt).toContain(view.quickstartPath);
  });

  it('carries a non-default port through, so a second terminal reaches the right manager', () => {
    const view = buildTuiConnectView({ managerUrl: 'http://127.0.0.1:4321' });
    expect(view.prompt).toContain('http://127.0.0.1:4321');
  });

  it('refuses to display a non-loopback management URL', () => {
    for (const url of [
      'http://203.0.113.10:4100',
      'http://100.101.102.103:4100',
      'http://0.0.0.0:4100',
      'http://example.internal:4100',
    ]) {
      // Displaying one would document an exposure the design forbids, and the
      // management API is loopback-only precisely because terminal two works
      // without configuration.
      expect(() => buildTuiConnectView({ managerUrl: url }), url)
        .toThrow(NonLoopbackManagerUrlError);
    }
  });

  it('launches nothing and asks for no credential', () => {
    const source = fs.readFileSync(
      new URL('../../src/tui/connect/view.ts', import.meta.url), 'utf8',
    );
    for (const forbidden of ['spawn(', 'exec(', 'token', 'credential', 'pair']) {
      expect(source.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase() + '(');
    }
  });
});
