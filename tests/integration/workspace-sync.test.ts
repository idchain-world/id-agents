// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  maybeRunWorkspaceSyncCli,
  maybeRunWorkspaceUnsyncCli,
  syncWorkspaceFromConfig,
  unsyncWorkspaceFromConfig,
} from '../../src/cli/workspace-sync.js';

const FIXTURE_CONFIG = '/Users/nxt3d/projects/id2/public-agents/configs/foundry-demo.yaml';
const FIXTURE_LIBRARY_ROOT = '/Users/nxt3d/projects/id2/public-agents/configs';
const FIXTURE_AGENT_ROOT = '/Users/nxt3d/projects/id2/public-agents/configs/agents/foundry-dev';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-workspace-sync-'));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeConfig(configPath: string, runtime: string, workspacePath: string, agentName = 'foundry-dev'): void {
  writeFile(
    configPath,
    [
      'name: test-sync',
      'agents:',
      '  - name: test-agent',
      `    runtime: ${runtime}`,
      `    workingDirectory: ${workspacePath}`,
      `    agent: ${agentName}`,
      '',
    ].join('\n'),
  );
}

function seedFoundryLibrary(rootDir: string): void {
  const targetDir = path.join(rootDir, 'agents', 'foundry-dev');
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(FIXTURE_AGENT_ROOT, targetDir, { recursive: true });
}

function seedAgentsMdLibrary(rootDir: string): void {
  writeFile(path.join(rootDir, 'agents', 'builder.md'), '# Builder Persona\n');
  writeFile(path.join(rootDir, 'agents', 'builder', 'skills', 'forge', 'SKILL.md'), '# Forge Skill\n');
}

function walkFiles(rootDir: string): string[] {
  const results: string[] = [];

  const walk = (currentDir: string): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile()) {
        results.push(path.relative(rootDir, absolutePath).split(path.sep).join('/'));
      }
    }
  };

  walk(rootDir);
  return results;
}

function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

describe('workspace sync integration', () => {
  let workspacePath = '';
  const tempPaths: string[] = [];

  afterEach(() => {
    if (workspacePath) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      workspacePath = '';
    }
    while (tempPaths.length > 0) {
      const tempPath = tempPaths.pop()!;
      fs.rmSync(tempPath, { recursive: true, force: true });
    }
  });

  it('materializes the foundry demo tree and receipt, then handles no-op and drift cases', () => {
    workspacePath = mkTmp();

    const first = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    expect(first.counts).toEqual({
      wroteMissing: 6,
      matchedSource: 0,
      overwroteManaged: 0,
      drifted: 0,
    });
    expect(first.warnings).toEqual([]);

    expect(walkFiles(workspacePath)).toEqual([
      '.claude/CLAUDE.md',
      '.claude/skills/foundry-scripting-and-deploy/SKILL.md',
      '.claude/skills/gas-optimization-foundry/SKILL.md',
      '.claude/skills/solidity-style-modern/SKILL.md',
      '.claude/skills/using-foundry/SKILL.md',
      '.claude/skills/writing-foundry-tests/SKILL.md',
      '.id-agents/receipt.json',
    ]);

    const receipt = JSON.parse(fs.readFileSync(path.join(workspacePath, '.id-agents', 'receipt.json'), 'utf-8')) as {
      version: number;
      lastDeployedAt: string;
      files: Record<string, { sha256: string; source: string }>;
    };

    expect(receipt.version).toBe(1);
    expect(Object.keys(receipt.files).sort()).toEqual([
      '.claude/CLAUDE.md',
      '.claude/skills/foundry-scripting-and-deploy/SKILL.md',
      '.claude/skills/gas-optimization-foundry/SKILL.md',
      '.claude/skills/solidity-style-modern/SKILL.md',
      '.claude/skills/using-foundry/SKILL.md',
      '.claude/skills/writing-foundry-tests/SKILL.md',
    ]);

    for (const [relativeTargetPath, entry] of Object.entries(receipt.files)) {
      expect(entry.source).toBe('agent:foundry-dev');
      const targetPath = path.join(workspacePath, relativeTargetPath);
      expect(entry.sha256).toBe(sha256File(targetPath));

      const sourceRelativePath = relativeTargetPath.replace(/^\.claude\//, '');
      const sourcePath = path.join(FIXTURE_AGENT_ROOT, sourceRelativePath);
      expect(entry.sha256).toBe(sha256File(sourcePath));
    }

    const second = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    expect(second.counts).toEqual({
      wroteMissing: 0,
      matchedSource: 6,
      overwroteManaged: 0,
      drifted: 0,
    });
    expect(second.files.every(file => file.case === 2)).toBe(true);
    expect(second.warnings).toEqual([]);

    const driftPath = path.join(workspacePath, '.claude', 'CLAUDE.md');
    fs.writeFileSync(driftPath, `${fs.readFileSync(driftPath, 'utf-8')}\nlocal change\n`);

    const third = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    expect(third.counts).toEqual({
      wroteMissing: 0,
      matchedSource: 5,
      overwroteManaged: 0,
      drifted: 1,
    });
    expect(third.warnings).toEqual(['Skipped drifted file: .claude/CLAUDE.md']);
    expect(fs.readFileSync(driftPath, 'utf-8')).toMatch(/local change/);
  });

  /* ------------------------------------------------------------------ */
  /*  Slice 4: Claude memory-file fallback (sidecar routing)             */
  /* ------------------------------------------------------------------ */

  it('routes to .claude/rules/agent-<name>.md when the workspace already has a CLAUDE.md we do not own', () => {
    workspacePath = mkTmp();

    // Seed a user-owned CLAUDE.md before any sync runs.
    const userClaudeMdPath = path.join(workspacePath, '.claude', 'CLAUDE.md');
    const userClaudeMdContent = '# my own CLAUDE.md\n\nhand-written instructions\n';
    fs.mkdirSync(path.dirname(userClaudeMdPath), { recursive: true });
    fs.writeFileSync(userClaudeMdPath, userClaudeMdContent);

    const first = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    expect(first.counts).toEqual({
      wroteMissing: 6,
      matchedSource: 0,
      overwroteManaged: 0,
      drifted: 0,
    });
    expect(first.warnings).toEqual([]);

    // User's CLAUDE.md is sacred.
    expect(fs.readFileSync(userClaudeMdPath, 'utf-8')).toBe(userClaudeMdContent);

    // Library persona lands in the sidecar under .claude/rules/.
    const sidecarPath = path.join(workspacePath, '.claude', 'rules', 'agent-foundry-dev.md');
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(sha256File(sidecarPath)).toBe(sha256File(path.join(FIXTURE_AGENT_ROOT, 'CLAUDE.md')));

    // Skills still land at their normal paths.
    expect(walkFiles(workspacePath)).toEqual([
      '.claude/CLAUDE.md',
      '.claude/rules/agent-foundry-dev.md',
      '.claude/skills/foundry-scripting-and-deploy/SKILL.md',
      '.claude/skills/gas-optimization-foundry/SKILL.md',
      '.claude/skills/solidity-style-modern/SKILL.md',
      '.claude/skills/using-foundry/SKILL.md',
      '.claude/skills/writing-foundry-tests/SKILL.md',
      '.id-agents/receipt.json',
    ]);

    // Receipt tracks the sidecar, not the user's CLAUDE.md.
    const receipt = JSON.parse(fs.readFileSync(path.join(workspacePath, '.id-agents', 'receipt.json'), 'utf-8')) as {
      version: number;
      files: Record<string, { sha256: string; source: string }>;
    };
    expect(Object.keys(receipt.files).sort()).toEqual([
      '.claude/rules/agent-foundry-dev.md',
      '.claude/skills/foundry-scripting-and-deploy/SKILL.md',
      '.claude/skills/gas-optimization-foundry/SKILL.md',
      '.claude/skills/solidity-style-modern/SKILL.md',
      '.claude/skills/using-foundry/SKILL.md',
      '.claude/skills/writing-foundry-tests/SKILL.md',
    ]);
    expect(receipt.files['.claude/rules/agent-foundry-dev.md'].source).toBe('agent:foundry-dev');
    expect(receipt.files['.claude/rules/agent-foundry-dev.md'].sha256).toBe(sha256File(sidecarPath));
    expect(receipt.files['.claude/CLAUDE.md']).toBeUndefined();
  });

  it('is idempotent when re-syncing into a sidecar-owned workspace', () => {
    workspacePath = mkTmp();

    const userClaudeMdPath = path.join(workspacePath, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(userClaudeMdPath), { recursive: true });
    fs.writeFileSync(userClaudeMdPath, '# user CLAUDE.md\n');

    syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    const second = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    expect(second.counts).toEqual({
      wroteMissing: 0,
      matchedSource: 6,
      overwroteManaged: 0,
      drifted: 0,
    });
    expect(second.files.every(file => file.case === 2)).toBe(true);
    expect(second.warnings).toEqual([]);
  });

  it('claims ownership of root CLAUDE.md when disk bytes already match source (Case 2, no sidecar)', () => {
    workspacePath = mkTmp();

    // Pre-seed a root CLAUDE.md whose bytes exactly match the library
    // source. No receipt exists yet.
    const sourceClaudeMdBytes = fs.readFileSync(path.join(FIXTURE_AGENT_ROOT, 'CLAUDE.md'));
    const primaryPath = path.join(workspacePath, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(primaryPath), { recursive: true });
    fs.writeFileSync(primaryPath, sourceClaudeMdBytes);

    const first = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    // Root file is Case 2 matched-source (no write); skills are Case 1 writes.
    expect(first.counts).toEqual({
      wroteMissing: 5,
      matchedSource: 1,
      overwroteManaged: 0,
      drifted: 0,
    });
    expect(first.warnings).toEqual([]);

    // No sidecar was created.
    expect(
      fs.existsSync(path.join(workspacePath, '.claude', 'rules', 'agent-foundry-dev.md')),
    ).toBe(false);

    // Root bytes stayed identical; receipt now tracks the primary key.
    expect(fs.readFileSync(primaryPath)).toEqual(sourceClaudeMdBytes);

    const receipt = JSON.parse(
      fs.readFileSync(path.join(workspacePath, '.id-agents', 'receipt.json'), 'utf-8'),
    ) as { files: Record<string, { sha256: string; source: string }> };
    expect(receipt.files['.claude/CLAUDE.md']).toBeDefined();
    expect(receipt.files['.claude/CLAUDE.md'].source).toBe('agent:foundry-dev');
    expect(receipt.files['.claude/rules/agent-foundry-dev.md']).toBeUndefined();
  });

  it('keeps root path and warns on drift of a previously-managed CLAUDE.md (no sidecar flip)', () => {
    workspacePath = mkTmp();

    // First sync establishes ownership of .claude/CLAUDE.md via the root path.
    syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    // User edits the managed CLAUDE.md in place.
    const primaryPath = path.join(workspacePath, '.claude', 'CLAUDE.md');
    fs.writeFileSync(primaryPath, `${fs.readFileSync(primaryPath, 'utf-8')}\nuser edit\n`);

    const second = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    // Drift stays on the root path — case 4 skip-and-warn — and no sidecar
    // is created, matching slice-3 semantics.
    expect(second.counts).toEqual({
      wroteMissing: 0,
      matchedSource: 5,
      overwroteManaged: 0,
      drifted: 1,
    });
    expect(second.warnings).toEqual(['Skipped drifted file: .claude/CLAUDE.md']);
    expect(fs.readFileSync(primaryPath, 'utf-8')).toMatch(/user edit/);
    expect(
      fs.existsSync(path.join(workspacePath, '.claude', 'rules', 'agent-foundry-dev.md')),
    ).toBe(false);

    // Receipt still tracks the primary key with its prior SHA (we didn't
    // overwrite, so receipt ownership for that file is preserved).
    const receipt = JSON.parse(
      fs.readFileSync(path.join(workspacePath, '.id-agents', 'receipt.json'), 'utf-8'),
    ) as { files: Record<string, { sha256: string; source: string }> };
    expect(receipt.files['.claude/CLAUDE.md']).toBeDefined();
    expect(receipt.files['.claude/rules/agent-foundry-dev.md']).toBeUndefined();
  });

  it('uses the primary .claude/CLAUDE.md path when no pre-existing CLAUDE.md is on disk', () => {
    workspacePath = mkTmp();

    const first = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    // No sidecar file should be created when the baseline path is free.
    expect(fs.existsSync(path.join(workspacePath, '.claude', 'rules'))).toBe(false);
    expect(
      fs.existsSync(path.join(workspacePath, '.claude', 'rules', 'agent-foundry-dev.md')),
    ).toBe(false);

    // Library CLAUDE.md lands at the primary target.
    expect(
      sha256File(path.join(workspacePath, '.claude', 'CLAUDE.md')),
    ).toBe(sha256File(path.join(FIXTURE_AGENT_ROOT, 'CLAUDE.md')));

    const receipt = JSON.parse(fs.readFileSync(path.join(workspacePath, '.id-agents', 'receipt.json'), 'utf-8')) as {
      files: Record<string, { sha256: string; source: string }>;
    };
    expect(receipt.files['.claude/CLAUDE.md']).toBeDefined();
    expect(receipt.files['.claude/CLAUDE.md'].source).toBe('agent:foundry-dev');

    void first; // reference so the linter sees it used even if no other assertions follow
  });

  it('maps a claude-native library entry into the Codex target shape', () => {
    workspacePath = mkTmp();
    const configDir = mkTmp();
    tempPaths.push(configDir);
    const configPath = path.join(configDir, 'codex.yaml');
    writeConfig(configPath, 'codex-cli', workspacePath);

    const first = syncWorkspaceFromConfig({
      configPath,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    expect(first.counts).toEqual({
      wroteMissing: 6,
      matchedSource: 0,
      overwroteManaged: 0,
      drifted: 0,
    });
    expect(first.warnings).toEqual([]);
    expect(walkFiles(workspacePath)).toEqual([
      '.agents/skills/foundry-scripting-and-deploy/SKILL.md',
      '.agents/skills/gas-optimization-foundry/SKILL.md',
      '.agents/skills/solidity-style-modern/SKILL.md',
      '.agents/skills/using-foundry/SKILL.md',
      '.agents/skills/writing-foundry-tests/SKILL.md',
      '.id-agents/receipt.json',
      'AGENTS.md',
    ]);
    expect(fs.existsSync(path.join(workspacePath, '.claude'))).toBe(false);
    expect(fs.readFileSync(path.join(workspacePath, 'AGENTS.md'), 'utf-8')).toBe(
      fs.readFileSync(path.join(FIXTURE_AGENT_ROOT, 'CLAUDE.md'), 'utf-8'),
    );
  });

  it('maps a claude-native library entry into the Cursor target shape with .mdc rules', () => {
    workspacePath = mkTmp();
    const libraryRoot = mkTmp();
    const configDir = mkTmp();
    tempPaths.push(libraryRoot, configDir);
    seedFoundryLibrary(libraryRoot);
    writeFile(
      path.join(libraryRoot, 'agents', 'foundry-dev', 'rules', 'code-style.md'),
      '# Cursor Rule\n',
    );
    const configPath = path.join(configDir, 'cursor.yaml');
    writeConfig(configPath, 'cursor-cli', workspacePath);

    const first = syncWorkspaceFromConfig({
      configPath,
      libraryRoot,
      workspacePath,
    });

    expect(first.counts).toEqual({
      wroteMissing: 2,
      matchedSource: 0,
      overwroteManaged: 0,
      drifted: 0,
    });
    expect(first.warnings).toEqual([]);
    expect(walkFiles(workspacePath)).toEqual([
      '.cursor/rules/code-style.mdc',
      '.id-agents/receipt.json',
      'AGENTS.md',
    ]);
    expect(fs.existsSync(path.join(workspacePath, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(workspacePath, '.agents'))).toBe(false);
    expect(fs.readFileSync(path.join(workspacePath, '.cursor', 'rules', 'code-style.mdc'), 'utf-8')).toBe('# Cursor Rule\n');
  });

  it('maps an AGENTS.md-native library entry into the Claude target shape', () => {
    workspacePath = mkTmp();
    const libraryRoot = mkTmp();
    const configDir = mkTmp();
    tempPaths.push(libraryRoot, configDir);
    seedAgentsMdLibrary(libraryRoot);
    const configPath = path.join(configDir, 'claude.yaml');
    writeConfig(configPath, 'claude-code-cli', workspacePath, 'builder');

    const first = syncWorkspaceFromConfig({
      configPath,
      libraryRoot,
      workspacePath,
    });

    expect(first.counts).toEqual({
      wroteMissing: 2,
      matchedSource: 0,
      overwroteManaged: 0,
      drifted: 0,
    });
    expect(first.warnings).toEqual([]);
    expect(walkFiles(workspacePath)).toEqual([
      '.claude/CLAUDE.md',
      '.claude/skills/forge/SKILL.md',
      '.id-agents/receipt.json',
    ]);
    expect(fs.readFileSync(path.join(workspacePath, '.claude', 'CLAUDE.md'), 'utf-8')).toBe('# Builder Persona\n');
  });

  it('refuses Codex sync when AGENTS.md already exists outside the receipt', async () => {
    workspacePath = mkTmp();
    const configDir = mkTmp();
    tempPaths.push(configDir);
    const configPath = path.join(configDir, 'codex.yaml');
    writeConfig(configPath, 'codex', workspacePath);
    writeFile(path.join(workspacePath, 'AGENTS.md'), '# user-owned AGENTS.md\n');

    const exitCode = await maybeRunWorkspaceSyncCli([
      'sync',
      configPath,
      '--library-root',
      FIXTURE_LIBRARY_ROOT,
      '--workspace',
      workspacePath,
    ]);

    expect(exitCode).toBe(1);
    expect(fs.readFileSync(path.join(workspacePath, 'AGENTS.md'), 'utf-8')).toBe('# user-owned AGENTS.md\n');
    expect(fs.existsSync(path.join(workspacePath, '.id-agents', 'receipt.json'))).toBe(false);
    expect(fs.existsSync(path.join(workspacePath, '.agents'))).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  Regression guard: managed root CLAUDE.md drift must NOT sidecar    */
  /*  (task: fix-slice-4-claude-fallback-drift)                          */
  /* ------------------------------------------------------------------ */

  it('regression: full replacement of managed CLAUDE.md stays on root with Case 4 warn', () => {
    workspacePath = mkTmp();

    // Initial deploy establishes managed ownership of .claude/CLAUDE.md.
    const first = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });
    expect(first.counts.wroteMissing).toBe(6);

    // User replaces .claude/CLAUDE.md wholesale with unrelated content.
    // Neither the append-drift test nor the user-authored-first-deploy test
    // cover this exact transition; pinning it here locks in that a
    // post-ownership replacement never flips to the sidecar.
    const primaryPath = path.join(workspacePath, '.claude', 'CLAUDE.md');
    fs.writeFileSync(primaryPath, '# completely different content\n\nhand-written by the user\n');

    const second = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    expect(second.counts).toEqual({
      wroteMissing: 0,
      matchedSource: 5,
      overwroteManaged: 0,
      drifted: 1,
    });
    expect(second.warnings).toEqual(['Skipped drifted file: .claude/CLAUDE.md']);

    // Sacredness: user's replacement is preserved verbatim.
    expect(fs.readFileSync(primaryPath, 'utf-8')).toBe(
      '# completely different content\n\nhand-written by the user\n',
    );

    // No sidecar file was created.
    expect(
      fs.existsSync(path.join(workspacePath, '.claude', 'rules', 'agent-foundry-dev.md')),
    ).toBe(false);
    expect(fs.existsSync(path.join(workspacePath, '.claude', 'rules'))).toBe(false);

    // Receipt still carries the primary key (prior SHA from the initial
    // deploy); no sidecar entry was added.
    const receipt = JSON.parse(
      fs.readFileSync(path.join(workspacePath, '.id-agents', 'receipt.json'), 'utf-8'),
    ) as { files: Record<string, { sha256: string; source: string }> };
    expect(receipt.files['.claude/CLAUDE.md']).toBeDefined();
    expect(receipt.files['.claude/rules/agent-foundry-dev.md']).toBeUndefined();
  });

  /* ------------------------------------------------------------------ */
  /*  Slice 5: runtime-aware remap (Codex / Cursor / agents-md-native)   */
  /* ------------------------------------------------------------------ */

  const writeYaml = (dir: string, runtime: string, workspace: string, agentName: string): string => {
    const configPath = path.join(dir, `team.yaml`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        `name: slice-5-demo`,
        `agents:`,
        `  - name: dev-agent`,
        `    runtime: ${runtime}`,
        `    workingDirectory: ${workspace}`,
        `    agent: ${agentName}`,
        ``,
      ].join('\n'),
    );
    return configPath;
  };

  it.each(['codex', 'antigravity-cli', 'antigravity'])('maps a claude-native library onto the %s target (AGENTS.md + .agents/skills)', runtime => {
    workspacePath = mkTmp();
    const configDir = mkTmp();
    const configPath = writeYaml(configDir, runtime, workspacePath, 'foundry-dev');

    try {
      const result = syncWorkspaceFromConfig({
        configPath,
        libraryRoot: FIXTURE_LIBRARY_ROOT,
        workspacePath,
      });

      expect(result.counts).toEqual({
        wroteMissing: 6,
        matchedSource: 0,
        overwroteManaged: 0,
        drifted: 0,
      });
      expect(result.warnings).toEqual([]);

      expect(walkFiles(workspacePath)).toEqual([
        '.agents/skills/foundry-scripting-and-deploy/SKILL.md',
        '.agents/skills/gas-optimization-foundry/SKILL.md',
        '.agents/skills/solidity-style-modern/SKILL.md',
        '.agents/skills/using-foundry/SKILL.md',
        '.agents/skills/writing-foundry-tests/SKILL.md',
        '.id-agents/receipt.json',
        'AGENTS.md',
      ]);

      expect(sha256File(path.join(workspacePath, 'AGENTS.md'))).toBe(
        sha256File(path.join(FIXTURE_AGENT_ROOT, 'CLAUDE.md')),
      );

      const receipt = JSON.parse(
        fs.readFileSync(path.join(workspacePath, '.id-agents', 'receipt.json'), 'utf-8'),
      ) as { files: Record<string, { sha256: string; source: string }> };
      expect(Object.keys(receipt.files).sort()).toEqual([
        '.agents/skills/foundry-scripting-and-deploy/SKILL.md',
        '.agents/skills/gas-optimization-foundry/SKILL.md',
        '.agents/skills/solidity-style-modern/SKILL.md',
        '.agents/skills/using-foundry/SKILL.md',
        '.agents/skills/writing-foundry-tests/SKILL.md',
        'AGENTS.md',
      ]);

      // No Claude surfaces were created.
      expect(fs.existsSync(path.join(workspacePath, '.claude'))).toBe(false);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('maps a claude-native library onto the cursor target (AGENTS.md only; skills + rules subset)', () => {
    workspacePath = mkTmp();
    const configDir = mkTmp();
    const libraryRoot = mkTmp();

    // Build a richer tmp library so the Cursor remap rules/*.md rename and
    // the skills skip can both be exercised in one test.
    const agentDir = path.join(libraryRoot, 'agents', 'cursor-agent');
    fs.mkdirSync(path.join(agentDir, 'skills', 'dropped-skill'), { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'rules', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), '# cursor persona\n');
    fs.writeFileSync(path.join(agentDir, 'skills', 'dropped-skill', 'SKILL.md'), 'skill body');
    fs.writeFileSync(path.join(agentDir, 'rules', 'style.md'), 'rule body');
    fs.writeFileSync(path.join(agentDir, 'rules', 'nested', 'deep.md'), 'nested rule');
    fs.writeFileSync(path.join(agentDir, 'rules', 'notes.txt'), 'non-md rule file');
    fs.writeFileSync(path.join(agentDir, 'agents', 'sub.md'), 'sub-agent def');

    const configPath = writeYaml(configDir, 'cursor-cli', workspacePath, 'cursor-agent');

    try {
      const result = syncWorkspaceFromConfig({
        configPath,
        libraryRoot,
        workspacePath,
      });

      // 3 writes: AGENTS.md + 2 .mdc rules (top-level + nested). Skills,
      // rules/*.txt, and agents/ are all dropped by the cursor remap.
      expect(result.counts).toEqual({
        wroteMissing: 3,
        matchedSource: 0,
        overwroteManaged: 0,
        drifted: 0,
      });
      expect(result.warnings).toEqual([]);

      expect(walkFiles(workspacePath)).toEqual([
        '.cursor/rules/nested/deep.mdc',
        '.cursor/rules/style.mdc',
        '.id-agents/receipt.json',
        'AGENTS.md',
      ]);

      expect(fs.readFileSync(path.join(workspacePath, 'AGENTS.md'), 'utf-8'))
        .toBe('# cursor persona\n');
      expect(fs.readFileSync(path.join(workspacePath, '.cursor', 'rules', 'style.mdc'), 'utf-8'))
        .toBe('rule body');
      expect(
        fs.readFileSync(path.join(workspacePath, '.cursor', 'rules', 'nested', 'deep.mdc'), 'utf-8'),
      ).toBe('nested rule');

      // Dropped surfaces: no .agents/, no .claude/, no agents/ or
      // commands/ rewrites, no rules/notes.txt copy.
      expect(fs.existsSync(path.join(workspacePath, '.agents'))).toBe(false);
      expect(fs.existsSync(path.join(workspacePath, '.claude'))).toBe(false);
      expect(fs.existsSync(path.join(workspacePath, '.cursor', 'rules', 'notes.txt'))).toBe(false);
      expect(fs.existsSync(path.join(workspacePath, '.cursor', 'skills'))).toBe(false);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(libraryRoot, { recursive: true, force: true });
    }
  });

  it('maps an agents-md-native library onto the claude target (persona + bundled skills)', () => {
    workspacePath = mkTmp();
    const configDir = mkTmp();
    const libraryRoot = mkTmp();

    // agents-md-native library entry: sibling .md + <name>/ directory with
    // bundled skills. No CLAUDE.md inside the directory.
    const agentsDir = path.join(libraryRoot, 'agents');
    fs.mkdirSync(path.join(agentsDir, 'persona-dev', 'skills', 'demo-skill'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'persona-dev.md'), '# agents-md persona\n');
    fs.writeFileSync(
      path.join(agentsDir, 'persona-dev', 'skills', 'demo-skill', 'SKILL.md'),
      'demo skill body',
    );

    const configPath = writeYaml(configDir, 'claude-code-cli', workspacePath, 'persona-dev');

    try {
      const result = syncWorkspaceFromConfig({
        configPath,
        libraryRoot,
        workspacePath,
      });

      // The sibling .md is treated as the canonical CLAUDE.md; bundled skill
      // lands at .claude/skills/. 2 writes total.
      expect(result.counts).toEqual({
        wroteMissing: 2,
        matchedSource: 0,
        overwroteManaged: 0,
        drifted: 0,
      });
      expect(result.warnings).toEqual([]);

      expect(walkFiles(workspacePath)).toEqual([
        '.claude/CLAUDE.md',
        '.claude/skills/demo-skill/SKILL.md',
        '.id-agents/receipt.json',
      ]);

      expect(fs.readFileSync(path.join(workspacePath, '.claude', 'CLAUDE.md'), 'utf-8'))
        .toBe('# agents-md persona\n');
      expect(fs.readFileSync(path.join(workspacePath, '.claude', 'skills', 'demo-skill', 'SKILL.md'), 'utf-8'))
        .toBe('demo skill body');

      const receipt = JSON.parse(
        fs.readFileSync(path.join(workspacePath, '.id-agents', 'receipt.json'), 'utf-8'),
      ) as { files: Record<string, { sha256: string; source: string }> };
      expect(Object.keys(receipt.files).sort()).toEqual([
        '.claude/CLAUDE.md',
        '.claude/skills/demo-skill/SKILL.md',
      ]);
      expect(receipt.files['.claude/CLAUDE.md'].source).toBe('agent:persona-dev');
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(libraryRoot, { recursive: true, force: true });
    }
  });

  it('exits with code 1 when the real CLI binary refuses a Codex sync over an unmanaged AGENTS.md', () => {
    // End-to-end coverage for the actual entry path:
    //   id-agents sync <config>  (process exit code)
    // The helper-level Codex-refusal test covers maybeRunWorkspaceSyncCli in
    // isolation; this test spawns the CLI via tsx to verify that the
    // top-level await + process.exit wiring propagates non-zero status.
    workspacePath = mkTmp();
    const configDir = mkTmp();
    const configPath = writeYaml(configDir, 'codex', workspacePath, 'foundry-dev');
    fs.writeFileSync(path.join(workspacePath, 'AGENTS.md'), '# user-owned AGENTS.md\n');

    try {
      const { spawnSync } = require('child_process') as typeof import('child_process');
      const tsxBin = path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
      const cliEntry = path.resolve(__dirname, '..', '..', 'src', 'interactive-agent-cli.ts');
      const result = spawnSync(
        tsxBin,
        [cliEntry, 'sync', configPath, '--library-root', FIXTURE_LIBRARY_ROOT],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );

      expect(result.status).toBe(1);
      expect(result.stderr || '').toMatch(/Refusing to sync/);
      // User's AGENTS.md is untouched, no partial writes.
      expect(fs.readFileSync(path.join(workspacePath, 'AGENTS.md'), 'utf-8'))
        .toBe('# user-owned AGENTS.md\n');
      expect(fs.existsSync(path.join(workspacePath, '.id-agents'))).toBe(false);
      expect(fs.existsSync(path.join(workspacePath, '.agents'))).toBe(false);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('refuses codex sync when workspace already has an unmanaged AGENTS.md', () => {
    workspacePath = mkTmp();
    const configDir = mkTmp();
    const configPath = writeYaml(configDir, 'codex', workspacePath, 'foundry-dev');

    // Seed an existing user-owned AGENTS.md before any sync runs.
    const userAgentsMd = '# user AGENTS.md\n\nhand-written instructions\n';
    fs.writeFileSync(path.join(workspacePath, 'AGENTS.md'), userAgentsMd);

    try {
      expect(() =>
        syncWorkspaceFromConfig({
          configPath,
          libraryRoot: FIXTURE_LIBRARY_ROOT,
          workspacePath,
        }),
      ).toThrow(/Refusing to sync/);

      // User's AGENTS.md is untouched, byte for byte.
      expect(fs.readFileSync(path.join(workspacePath, 'AGENTS.md'), 'utf-8')).toBe(userAgentsMd);

      // No partial writes: no skills dir, no receipt, no .agents or .claude.
      expect(fs.existsSync(path.join(workspacePath, '.agents'))).toBe(false);
      expect(fs.existsSync(path.join(workspacePath, '.claude'))).toBe(false);
      expect(fs.existsSync(path.join(workspacePath, '.id-agents'))).toBe(false);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  /* ------------------------------------------------------------------ */
  /*  Slice 6: undeploy (`id-agents unsync <config>`)                    */
  /* ------------------------------------------------------------------ */

  it('fresh sync followed by unsync leaves a pristine tree (no receipt, no .id-agents)', () => {
    workspacePath = mkTmp();

    syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });
    // Sanity: receipt and managed files landed.
    expect(fs.existsSync(path.join(workspacePath, '.id-agents', 'receipt.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.claude', 'CLAUDE.md'))).toBe(true);

    const result = unsyncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      workspacePath,
    });

    expect(result.counts).toEqual({ deleted: 6, preserved: 0, missing: 0 });
    expect(result.warnings).toEqual([]);
    // Workspace is empty — every managed file and directory is gone.
    expect(walkFiles(workspacePath)).toEqual([]);
    expect(fs.existsSync(path.join(workspacePath, '.id-agents'))).toBe(false);
    expect(fs.existsSync(path.join(workspacePath, '.claude'))).toBe(false);
  });

  it('unsync preserves user-edited files and removes the rest with cleaned receipt', () => {
    workspacePath = mkTmp();

    syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    // User edits one of the managed skills in place.
    const editedPath = path.join(workspacePath, '.claude', 'skills', 'using-foundry', 'SKILL.md');
    const originalBytes = fs.readFileSync(editedPath, 'utf-8');
    const editedBytes = `${originalBytes}\nuser edit\n`;
    fs.writeFileSync(editedPath, editedBytes);

    const result = unsyncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      workspacePath,
    });

    expect(result.counts).toEqual({ deleted: 5, preserved: 1, missing: 0 });
    expect(result.warnings).toEqual([
      'Preserved user-edited file (ownership released): .claude/skills/using-foundry/SKILL.md',
    ]);

    // Edited file stays byte-for-byte.
    expect(fs.readFileSync(editedPath, 'utf-8')).toBe(editedBytes);
    // Ancestor directories are preserved because the edited file still lives there.
    expect(fs.existsSync(path.join(workspacePath, '.claude', 'skills', 'using-foundry'))).toBe(true);
    // Other skill directories are gone.
    expect(fs.existsSync(path.join(workspacePath, '.claude', 'skills', 'gas-optimization-foundry')))
      .toBe(false);
    // CLAUDE.md was deleted.
    expect(fs.existsSync(path.join(workspacePath, '.claude', 'CLAUDE.md'))).toBe(false);
    // Receipt is always removed at end of unsync; ownership was released.
    expect(fs.existsSync(path.join(workspacePath, '.id-agents'))).toBe(false);
  });

  it('unsync with no receipt is a no-op and exits with code 0', async () => {
    workspacePath = mkTmp();
    const configDir = mkTmp();
    const configPath = writeYaml(configDir, 'claude-code-cli', workspacePath, 'foundry-dev');

    try {
      const programmatic = unsyncWorkspaceFromConfig({ configPath, workspacePath });
      expect(programmatic.counts).toEqual({ deleted: 0, preserved: 0, missing: 0 });
      expect(programmatic.files).toEqual([]);
      expect(programmatic.warnings).toEqual([]);

      // Workspace is untouched (beyond the empty dir we handed in).
      expect(walkFiles(workspacePath)).toEqual([]);
      expect(fs.existsSync(path.join(workspacePath, '.id-agents'))).toBe(false);

      // CLI hook returns 0 for this case.
      const exitCode = await maybeRunWorkspaceUnsyncCli([
        'unsync',
        configPath,
        '--workspace',
        workspacePath,
      ]);
      expect(exitCode).toBe(0);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('unsync on a codex workspace removes AGENTS.md and .agents/skills while preserving user-authored files', () => {
    workspacePath = mkTmp();
    const configDir = mkTmp();
    const configPath = writeYaml(configDir, 'codex', workspacePath, 'foundry-dev');

    try {
      // Drop a user-authored file that was never in the receipt.
      const userFilePath = path.join(workspacePath, '.env');
      fs.writeFileSync(userFilePath, 'USER_SECRET=abc\n');

      // Sync to the Codex target.
      syncWorkspaceFromConfig({
        configPath,
        libraryRoot: FIXTURE_LIBRARY_ROOT,
        workspacePath,
      });
      expect(fs.existsSync(path.join(workspacePath, 'AGENTS.md'))).toBe(true);
      expect(fs.existsSync(path.join(workspacePath, '.agents', 'skills'))).toBe(true);

      const result = unsyncWorkspaceFromConfig({
        configPath,
        workspacePath,
      });

      expect(result.counts).toEqual({ deleted: 6, preserved: 0, missing: 0 });
      expect(result.warnings).toEqual([]);

      // Our managed artifacts are gone.
      expect(fs.existsSync(path.join(workspacePath, 'AGENTS.md'))).toBe(false);
      expect(fs.existsSync(path.join(workspacePath, '.agents'))).toBe(false);
      expect(fs.existsSync(path.join(workspacePath, '.id-agents'))).toBe(false);

      // User-authored file is preserved verbatim.
      expect(fs.existsSync(userFilePath)).toBe(true);
      expect(fs.readFileSync(userFilePath, 'utf-8')).toBe('USER_SECRET=abc\n');
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
