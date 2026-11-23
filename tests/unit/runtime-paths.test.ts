// SPDX-License-Identifier: MIT

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { getRuntimePaths } from '../../src/runtime/registry.js';
import {
  loadSubAgentTemplate,
  copyAgentDirOverlay,
  copyHeartbeatMd,
  processConfig,
} from '../../src/config-parser.js';

/* ------------------------------------------------------------------ */
/*  getRuntimePaths — returns correct paths for each runtime           */
/* ------------------------------------------------------------------ */

describe('getRuntimePaths', () => {
  it('returns Claude paths for claude-code-cli', () => {
    const rp = getRuntimePaths('claude-code-cli');
    expect(rp.templateDir).toBe('.claude/agents');
    expect(rp.overlayTarget).toBe('.claude');
    expect(rp.skillsDir).toBe('.claude/skills');
    expect(rp.personalityFile).toBe('.claude/CLAUDE.md');
    expect(rp.personalityFilename).toBe('CLAUDE.md');
  });

  it('returns Claude paths for claude-agent-sdk', () => {
    const rp = getRuntimePaths('claude-agent-sdk');
    expect(rp.templateDir).toBe('.claude/agents');
    expect(rp.personalityFile).toBe('.claude/CLAUDE.md');
  });

  it('returns Claude paths for undefined runtime (default)', () => {
    const rp = getRuntimePaths(undefined);
    expect(rp.templateDir).toBe('.claude/agents');
    expect(rp.personalityFile).toBe('.claude/CLAUDE.md');
  });

  it.each(['codex', 'antigravity-cli', 'antigravity'])('returns .agents paths for %s', runtime => {
    const rp = getRuntimePaths(runtime);
    expect(rp.templateDir).toBe('.agents');
    expect(rp.overlayTarget).toBe('.agents');
    expect(rp.skillsDir).toBe('.agents/skills');
    expect(rp.personalityFile).toBe('AGENTS.md');
    expect(rp.personalityFilename).toBe('AGENTS.md');
  });

  it('returns dedicated .cursor/ paths for cursor-cli runtime', () => {
    const rp = getRuntimePaths('cursor-cli');
    expect(rp.templateDir).toBe('.cursor/agents');
    expect(rp.overlayTarget).toBe('.cursor');
    expect(rp.skillsDir).toBe('.cursor/skills');
    expect(rp.personalityFile).toBe('AGENTS.md');
    expect(rp.personalityFilename).toBe('AGENTS.md');
  });
});

/* ------------------------------------------------------------------ */
/*  loadSubAgentTemplate — runtime-aware lookup                        */
/* ------------------------------------------------------------------ */

describe('loadSubAgentTemplate with runtime', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-rtpath-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads from .claude/agents/ for claude-code-cli', () => {
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'coder.md'), `---
description: Claude coder
---

Write clean code.`);

    const result = loadSubAgentTemplate(tmpDir, 'coder', 'claude-code-cli');
    expect(result).toBeDefined();
    expect(result!.description).toBe('Claude coder');
    expect(result!.body).toBe('Write clean code.');
  });

  it('loads from .agents/ for codex runtime', () => {
    const agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'cto.md'), `---
description: Codex CTO
---

Lead the engineering team.`);

    const result = loadSubAgentTemplate(tmpDir, 'cto', 'codex');
    expect(result).toBeDefined();
    expect(result!.description).toBe('Codex CTO');
    expect(result!.body).toBe('Lead the engineering team.');
  });

  it('loads directory pattern AGENTS.md for codex', () => {
    const agentDir = path.join(tmpDir, '.agents', 'cto');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), `---
description: Codex CTO dir
---

From the directory.`);

    const result = loadSubAgentTemplate(tmpDir, 'cto', 'codex');
    expect(result).toBeDefined();
    expect(result!.description).toBe('Codex CTO dir');
    expect(result!.body).toBe('From the directory.');
  });

  it('codex directory pattern takes priority over single-file', () => {
    const agentsDir = path.join(tmpDir, '.agents');
    const agentDir = path.join(agentsDir, 'dev');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), 'Directory version');
    fs.writeFileSync(path.join(agentsDir, 'dev.md'), 'File version');

    const result = loadSubAgentTemplate(tmpDir, 'dev', 'codex');
    expect(result!.body).toBe('Directory version');
  });

  it('does not find Claude template when runtime is codex', () => {
    // Template exists in .claude/agents/ but not .agents/
    const claudeDir = path.join(tmpDir, '.claude', 'agents');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'cto.md'), 'Claude template');

    const result = loadSubAgentTemplate(tmpDir, 'cto', 'codex');
    expect(result).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  copyAgentDirOverlay — runtime-aware overlay target                 */
/* ------------------------------------------------------------------ */

describe('copyAgentDirOverlay with runtime', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-overlay-rt-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('overlays to .claude/ for claude-code-cli', () => {
    const agentDir = path.join(tmpDir, '.claude', 'agents', 'myagent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), '{"key": "value"}');

    copyAgentDirOverlay(tmpDir, 'myagent', 'claude-code-cli');

    expect(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8')).toBe('{"key": "value"}');
  });

  it('overlays to .agents/ for codex runtime', () => {
    const agentDir = path.join(tmpDir, '.agents', 'cto');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'config.json'), '{"codex": true}');

    copyAgentDirOverlay(tmpDir, 'cto', 'codex');

    expect(fs.readFileSync(path.join(tmpDir, '.agents', 'config.json'), 'utf-8')).toBe('{"codex": true}');
  });

  it('returns false when codex template dir does not exist', () => {
    // Only .claude/agents/cto exists, not .agents/cto
    const agentDir = path.join(tmpDir, '.claude', 'agents', 'cto');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), 'content');

    expect(copyAgentDirOverlay(tmpDir, 'cto', 'codex')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  copyHeartbeatMd — runtime-aware template directory                 */
/* ------------------------------------------------------------------ */

describe('copyHeartbeatMd with runtime', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-hbrt-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies from .claude/agents/ for claude-code-cli', () => {
    const agentDir = path.join(tmpDir, '.claude', 'agents', 'myagent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'HEARTBEAT.md'), '# Claude heartbeat');

    expect(copyHeartbeatMd(tmpDir, 'myagent', 'claude-code-cli')).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'HEARTBEAT.md'), 'utf-8')).toBe('# Claude heartbeat');
  });

  it('copies from .agents/ for codex runtime', () => {
    const agentDir = path.join(tmpDir, '.agents', 'cto');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'HEARTBEAT.md'), '# Codex heartbeat');

    expect(copyHeartbeatMd(tmpDir, 'cto', 'codex')).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'HEARTBEAT.md'), 'utf-8')).toBe('# Codex heartbeat');
  });
});

/* ------------------------------------------------------------------ */
/*  processConfig integration — codex runtime loads from .agents/      */
/* ------------------------------------------------------------------ */

describe('processConfig with codex runtime', () => {
  let tmpDir: string;
  let configDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-cfg-rt-'));
    configDir = path.join(tmpDir, 'configs');
    fs.mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads template from .agents/ for codex agent', () => {
    const workDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workDir, { recursive: true });

    // Create template in .agents/ (codex convention)
    const agentsDir = path.join(workDir, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'cto.md'), `---
description: Codex CTO agent
---

You lead the engineering team using OpenAI models.`);

    const configPath = path.join(configDir, 'test.yaml');
    fs.writeFileSync(configPath, `
version: "1.0"
agents:
  - name: cto
    runtime: codex
    workingDirectory: "${workDir}"
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents[0].roleBody).toBe('You lead the engineering team using OpenAI models.');
    expect(result.agents[0].description).toBe('Codex CTO agent');
  });

  it('does not load from .claude/agents/ for codex agent', () => {
    const workDir = path.join(tmpDir, 'workspace2');
    fs.mkdirSync(workDir, { recursive: true });

    // Template exists in .claude/agents/ (wrong location for codex)
    const claudeDir = path.join(workDir, '.claude', 'agents');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'cto.md'), 'Wrong template');

    const configPath = path.join(configDir, 'test2.yaml');
    fs.writeFileSync(configPath, `
version: "1.0"
agents:
  - name: cto
    runtime: codex
    workingDirectory: "${workDir}"
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents[0].roleBody).toBeUndefined();
  });

  it('loads from .claude/agents/ for claude-code-cli agent', () => {
    const workDir = path.join(tmpDir, 'workspace3');
    fs.mkdirSync(workDir, { recursive: true });

    const claudeDir = path.join(workDir, '.claude', 'agents');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'dev.md'), `---
description: Claude dev
---

You write TypeScript.`);

    const configPath = path.join(configDir, 'test3.yaml');
    fs.writeFileSync(configPath, `
version: "1.0"
agents:
  - name: dev
    runtime: claude-code-cli
    workingDirectory: "${workDir}"
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents[0].roleBody).toBe('You write TypeScript.');
  });
});
