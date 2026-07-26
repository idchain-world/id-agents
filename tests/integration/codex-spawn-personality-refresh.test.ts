// SPDX-License-Identifier: MIT
/**
 * End-to-end coverage for the agent-manager-db spawn-flow personality
 * refresh on Codex/Cursor runtimes.
 *
 * Two complementary tests:
 *
 * 1. **Behavioral**: imports the actual `PROTOCOL_DEFAULTS` constant and
 *    invokes `writePersonalityFile` + `appendLibraryPersonaToAgentsMd`
 *    in the same sequence the spawn-flow paths in
 *    src/agent-manager-db.ts use. Pre-edits AGENTS.md with user content
 *    above, between, and below the managed blocks; redeploys with
 *    rotated library content; asserts every pocket of user content
 *    survives and only the marker blocks are refreshed.
 *
 * 2. **Structural**: greps src/agent-manager-db.ts source to assert
 *    that no `writeFileSync(personalityPath, ...)` call survives, and
 *    that every personality-write path is paired with a
 *    `writePersonalityFile(workingDirectory, ...)` call followed by a
 *    `appendLibraryPersonaToAgentsMd(...)` invocation. Catches a
 *    regression that would re-introduce the old wholesale-rewrite
 *    behavior even if the helpers themselves remain correct.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  appendLibraryPersonaToAgentsMd,
  writePersonalityFile,
} from '../../src/config-parser.js';
import { PROTOCOL_DEFAULTS } from '../../src/protocol-defaults.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------------------------------------------------------ */
/*  1. Behavioral end-to-end (helper sequence matches spawn flow)     */
/* ------------------------------------------------------------------ */

describe('Codex spawn-flow personality refresh — end-to-end', () => {
  let libraryRoot: string;
  let agentsDir: string;
  let workDir: string;

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-codex-e2e-'));
    libraryRoot = path.join(tmp, 'configs');
    agentsDir = path.join(libraryRoot, 'agents');
    workDir = path.join(tmp, 'workspace');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(libraryRoot), { recursive: true, force: true });
  });

  function readAgentsMd(): string {
    return fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf-8');
  }

  /**
   * Replays the file-system steps the manager spawn-flow runs for a
   * Codex agent (steps 4 + 5 in agent-manager-db.ts):
   *   - PROTOCOL_DEFAULTS + roleBody → writePersonalityFile()
   *   - library entry name           → appendLibraryPersonaToAgentsMd()
   * Mirrors the exact call sequence at all four spawn-flow paths
   * (POST /agents, sync rebuild, sync, deploy-from-config rebuild).
   */
  function runManagerSpawnFlow(opts: {
    runtime: 'codex' | 'cursor-cli';
    agentName: string;
    roleBody: string;
  }): void {
    const parts = [PROTOCOL_DEFAULTS];
    if (opts.roleBody) parts.push(opts.roleBody);
    writePersonalityFile(workDir, opts.runtime, parts.join('\n\n'));
    appendLibraryPersonaToAgentsMd(workDir, opts.agentName, opts.runtime, libraryRoot);
  }

  it('Codex deploy → user edits → redeploy: framework + persona refreshed; user edits intact', () => {
    fs.mkdirSync(path.join(agentsDir, 'auditor'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'auditor', 'CLAUDE.md'), '# Auditor persona v1\nv1 body line\n');

    // Initial deploy.
    runManagerSpawnFlow({ runtime: 'codex', agentName: 'auditor', roleBody: 'role v1' });

    // User now hand-edits AGENTS.md: notes above the framework block,
    // notes between the framework block and the agent block, and
    // notes below the agent block.
    const afterFirst = readAgentsMd();
    const split = afterFirst.replace(
      '<!-- END id-agents framework -->\n\n<!-- BEGIN id-agents agent:auditor -->',
      '<!-- END id-agents framework -->\n\n## My audit checklist\nlocal middle line\n\n<!-- BEGIN id-agents agent:auditor -->',
    );
    fs.writeFileSync(
      path.join(workDir, 'AGENTS.md'),
      `# Project preface\nuser preface line\n\n${split}## tail notes\nuser tail line\n`,
    );

    // Redeploy: library persona rotates v1 → v2; framework body kept stable.
    fs.writeFileSync(path.join(agentsDir, 'auditor', 'CLAUDE.md'), '# Auditor persona v2\nv2 body line\n');
    runManagerSpawnFlow({ runtime: 'codex', agentName: 'auditor', roleBody: 'role v1' });

    const out = readAgentsMd();

    // Three pockets of user content survive the refresh verbatim.
    expect(out).toContain('# Project preface\nuser preface line\n');
    expect(out).toContain('## My audit checklist\nlocal middle line\n');
    expect(out).toContain('## tail notes\nuser tail line\n');

    // Framework block is the live framework body (PROTOCOL_DEFAULTS + roleBody).
    expect(out).toContain('<!-- BEGIN id-agents framework -->');
    expect(out).toContain('<!-- END id-agents framework -->');
    expect(out).toContain('role v1');
    // PROTOCOL_DEFAULTS is the actual constant the manager writes — assert
    // its presence so the e2e proves we're using the real framework body.
    expect(out).toContain(PROTOCOL_DEFAULTS.split('\n')[0]);

    // Persona block reflects v2.
    expect(out).toContain('<!-- BEGIN id-agents agent:auditor -->');
    expect(out).toContain('<!-- END id-agents agent:auditor -->');
    expect(out).toContain('# Auditor persona v2\nv2 body line\n');
    // v1 persona body is gone — only the marker block was replaced.
    expect(out).not.toContain('# Auditor persona v1');
    expect(out).not.toContain('v1 body line');
  });

  it('Cursor parity: same refresh semantics over .cursor-cli runtime', () => {
    fs.mkdirSync(path.join(agentsDir, 'reviewer'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'reviewer', 'CLAUDE.md'), '# Reviewer v1\n');

    runManagerSpawnFlow({ runtime: 'cursor-cli', agentName: 'reviewer', roleBody: 'role' });

    // User edit ABOVE the framework markers.
    const afterFirst = readAgentsMd();
    fs.writeFileSync(
      path.join(workDir, 'AGENTS.md'),
      `# user-only preface\nimportant note\n\n${afterFirst}`,
    );

    fs.writeFileSync(path.join(agentsDir, 'reviewer', 'CLAUDE.md'), '# Reviewer v2\n');
    runManagerSpawnFlow({ runtime: 'cursor-cli', agentName: 'reviewer', roleBody: 'role' });

    const out = readAgentsMd();
    expect(out).toContain('# user-only preface\nimportant note\n');
    expect(out).toContain('<!-- BEGIN id-agents agent:reviewer -->\n# Reviewer v2\n<!-- END id-agents agent:reviewer -->\n');
    expect(out).not.toContain('# Reviewer v1');
  });
});

/* ------------------------------------------------------------------ */
/*  2. Structural guard against regression of the wiring               */
/* ------------------------------------------------------------------ */

describe('agent-manager-db spawn-flow wiring guard', () => {
  let source: string;

  beforeEach(() => {
    const sourcePath = path.resolve(__dirname, '..', '..', 'src', 'agent-manager-db.ts');
    source = fs.readFileSync(sourcePath, 'utf-8');
  });

  it('no leftover writeFileSync(personalityPath, ...) calls remain', () => {
    // The wholesale rewrite that was clobbering AGENTS.md on Codex/Cursor
    // refresh paths must not reappear. Both spaced and tight forms.
    expect(source).not.toMatch(/writeFileSync\(\s*personalityPath/);
  });

  it('every spawn-flow path calls writePersonalityFile + appendLibraryPersonaToAgentsMd', () => {
    const writeCalls = source.match(/writePersonalityFile\(workingDirectory,/g) ?? [];
    const appendCalls = source.match(/appendLibraryPersonaToAgentsMd\(workingDirectory,/g) ?? [];

    // Was 4 until commit 9 removed /sync (D2). Two of the four were sync's own
    // branches — the added-agent path and the changed-agent rebuild — so both
    // went with it, leaving spawn and deploy. The GUARANTEE is unchanged: every
    // remaining creation path still writes a personality file. Only the number
    // of paths moved, which is the point of counting them by name rather than
    // trusting a magic number.
    const SPAWN_FLOW_PATHS = 2; // spawn (:3113), deploy (:6109)
    expect(writeCalls.length).toBe(SPAWN_FLOW_PATHS);
    expect(appendCalls.length).toBe(SPAWN_FLOW_PATHS);
    // The real invariant: the two always travel together, whatever the count.
    expect(appendCalls.length).toBe(writeCalls.length);
  });

  it('writePersonalityFile is imported from config-parser', () => {
    expect(source).toMatch(/writePersonalityFile,?[\s\S]{0,200}from '\.\/config-parser\.js'/);
  });
});
