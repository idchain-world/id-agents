// SPDX-License-Identifier: MIT
/**
 * A deployer-GENERATED workingDirectory is exported as a comment, not a value
 * (#f37ad05d).
 *
 * Deploy synthesises `<baseWorkDir>/agents/<id>` when a config carries no
 * `workingDirectory`. Export wrote that back verbatim, so a restored agent —
 * which gets a NEW id under create-only deploy — was pointed at the ORIGINAL
 * agent's live directory. Prem's ruling: an exported config is a snapshot a
 * human reads and adjusts, so the path's INFORMATION survives as a comment
 * while its VALUE disappears, and a comment can never reach mkdirSync.
 *
 * THE LOAD-BEARING TEST IS THE AUTHORED ONE. Omitting a generated path fixes a
 * restore that lands in a shared directory; wrongly omitting an AUTHORED path
 * restores a team into an empty scratch directory and loses the operator's own
 * choice. Live data is 43 authored / 4 generated, so a loose match would be
 * wrong roughly ten times as often as it would be right.
 *
 * Pure functions and a temp file only — no manager, no live DB.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

import {
  buildAgentEntry,
  buildTeamConfig,
  exportTeamConfig,
  generatedWorkdirComment,
  insertWorkdirComments,
  isGeneratedWorkdir,
} from '../../src/lib/export-team-config.js';
import { parseTeamConfig } from '../../src/config-parser.js';

const BASE = '/base/work';
const GENERATED_ID = 'agent_1700000000000_abc1234';
const GENERATED_PATH = path.join(BASE, 'agents', GENERATED_ID);
/** A real authored path from the live fleet. */
const AUTHORED_PATH = '/Users/nxt3d/projects/idx';

function generatedRow(overrides: Record<string, unknown> = {}) {
  return { name: 'gen', id: GENERATED_ID, working_directory: GENERATED_PATH, metadata: {}, ...overrides };
}
function authoredRow(workdir = AUTHORED_PATH, overrides: Record<string, unknown> = {}) {
  return { name: 'auth', id: 'agent_9999999999999_zzz9999', working_directory: workdir, metadata: {}, ...overrides };
}

let dir = '';
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wdc-'))); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
const target = (n = 'out.yaml') => path.join(dir, n);

describe('isGeneratedWorkdir — the exact match (#f37ad05d)', () => {
  it('matches the path deploy synthesises', () => {
    expect(isGeneratedWorkdir(generatedRow(), BASE)).toBe(true);
  });

  it('treats an author-chosen path as authored', () => {
    expect(isGeneratedWorkdir(authoredRow(), BASE)).toBe(false);
  });

  /**
   * The mutation target. Every one of these lives INSIDE baseWorkDir, so a
   * `startsWith` or prefix match would call them generated and silently drop a
   * path its author picked on purpose.
   */
  it('does not match a path that merely lives inside baseWorkDir', () => {
    for (const authored of [
      path.join(BASE, 'agents', 'handpicked'),          // right parent, chosen leaf
      path.join(BASE, 'agents', GENERATED_ID, 'sub'),   // below the generated dir
      path.join(BASE, 'custom', GENERATED_ID),          // right leaf, wrong parent
      path.join(BASE, 'agents'),                        // the parent itself
      BASE,
    ]) {
      expect(isGeneratedWorkdir(authoredRow(authored), BASE)).toBe(false);
    }
  });

  it('does not match another agent\'s generated path', () => {
    // Same shape, different id — this is the collision the bug caused.
    expect(isGeneratedWorkdir(generatedRow({ id: 'agent_other_999' }), BASE)).toBe(false);
  });

  it('treats everything as authored when baseWorkDir is unknown', () => {
    // The safe direction: with nothing to compare against, emit the value.
    expect(isGeneratedWorkdir(generatedRow(), undefined)).toBe(false);
  });

  it('ignores rows with no workdir or no id rather than guessing', () => {
    expect(isGeneratedWorkdir({ name: 'a', id: GENERATED_ID, metadata: {} }, BASE)).toBe(false);
    expect(isGeneratedWorkdir({ name: 'a', working_directory: GENERATED_PATH, metadata: {} }, BASE)).toBe(false);
  });
});

describe('buildAgentEntry — the key is dropped only for a generated path', () => {
  it('omits workingDirectory and reports the path for the comment', () => {
    const { entry, generatedWorkdir } = buildAgentEntry(generatedRow(), [], BASE);
    expect(entry.workingDirectory).toBeUndefined();
    expect('workingDirectory' in entry).toBe(false);
    expect(generatedWorkdir).toBe(GENERATED_PATH);
  });

  it('EMITS AN AUTHORED PATH UNTOUCHED, with nothing to comment', () => {
    const { entry, generatedWorkdir } = buildAgentEntry(authoredRow(), [], BASE);
    expect(entry.workingDirectory).toBe(AUTHORED_PATH);
    expect(generatedWorkdir).toBeUndefined();
  });

  it('emits the path when no baseWorkDir is supplied (unchanged behaviour)', () => {
    const { entry, generatedWorkdir } = buildAgentEntry(generatedRow());
    expect(entry.workingDirectory).toBe(GENERATED_PATH);
    expect(generatedWorkdir).toBeUndefined();
  });
});

describe('the comment itself — Prem-approved wording', () => {
  const comment = generatedWorkdirComment(GENERATED_PATH);

  it('contains the path, so the information survives', () => {
    expect(comment).toContain(GENERATED_PATH);
  });

  it('says the deployer generated it and that import makes a fresh one', () => {
    expect(comment).toContain('generated by the deployer, not chosen');
    expect(comment).toContain('creates a fresh one for the new agent id');
  });

  /**
   * The closing clause is what stops the paste-back. Someone who reads only
   * "here is where it worked" will paste it in as a value and recreate the bug;
   * the concrete consequence is the part that changes the behaviour.
   */
  it('names the consequence of pasting it back', () => {
    expect(comment).toContain('do not paste it back as a value');
    expect(comment).toContain('two agents will share one');
  });

  it('is entirely comment lines — nothing here can be read as a value', () => {
    for (const line of comment.split('\n')) expect(line.trimStart().startsWith('#')).toBe(true);
  });

  it('indents every line when asked', () => {
    for (const line of generatedWorkdirComment(GENERATED_PATH, '  ').split('\n')) {
      expect(line.startsWith('  #')).toBe(true);
    }
  });
});

describe('insertWorkdirComments — anchoring in the dumped string', () => {
  const dumped = () => yaml.dump({ version: '1', team: 't', agents: [{ name: 'gen' }, { name: 'other' }] });

  it('inserts above the right entry, at its indentation', () => {
    const { text, missing } = insertWorkdirComments(dumped(), [{ agent: 'gen', path: GENERATED_PATH }]);
    expect(missing).toEqual([]);
    const lines = text.split('\n');
    const anchor = lines.findIndex((l) => l.includes('- name: gen'));
    const indent = lines[anchor].match(/^\s*/)![0];
    // The five comment lines sit immediately above, at the same indent.
    expect(lines.slice(anchor - 5, anchor).every((l) => l.startsWith(`${indent}#`))).toBe(true);
    expect(lines.slice(anchor - 5, anchor).join('\n')).toContain(GENERATED_PATH);
  });

  it('leaves the other agent alone', () => {
    const { text } = insertWorkdirComments(dumped(), [{ agent: 'gen', path: GENERATED_PATH }]);
    const lines = text.split('\n');
    const other = lines.findIndex((l) => l.includes('- name: other'));
    expect(lines[other - 1].trimStart().startsWith('#')).toBe(false);
  });

  it('REPORTS a miss rather than losing the path silently', () => {
    // The key is already dropped by the time this runs, so a swallowed miss
    // would delete the path from the record entirely.
    const { missing } = insertWorkdirComments(dumped(), [{ agent: 'absent', path: GENERATED_PATH }]);
    expect(missing).toEqual(['absent']);
  });

  it('handles a name the dumper had to quote', () => {
    const quoted = yaml.dump({ agents: [{ name: 'no' }] }); // YAML 1.1 boolean-ish, gets quoted
    const { text, missing } = insertWorkdirComments(quoted, [{ agent: 'no', path: GENERATED_PATH }]);
    expect(missing).toEqual([]);
    expect(text).toContain(GENERATED_PATH);
  });
});

describe('the written file', () => {
  it('has the comment and no workingDirectory key for a generated path', () => {
    const p = target();
    exportTeamConfig({ teamName: 't', agents: [generatedRow()], targetPath: p, baseWorkDir: BASE });
    const text = fs.readFileSync(p, 'utf8');

    expect(text).toContain('# workingDirectory was generated by the deployer');
    expect(text).toContain(GENERATED_PATH);
    // The path appears ONLY inside a comment.
    for (const line of text.split('\n')) {
      if (line.includes(GENERATED_PATH)) expect(line.trimStart().startsWith('#')).toBe(true);
    }
    expect(yaml.load(text) as any).toMatchObject({ agents: [{ name: 'gen' }] });
    expect((yaml.load(text) as any).agents[0].workingDirectory).toBeUndefined();
  });

  it('KEEPS AN AUTHORED PATH AS A VALUE, with no comment', () => {
    const p = target('authored.yaml');
    exportTeamConfig({ teamName: 't', agents: [authoredRow()], targetPath: p, baseWorkDir: BASE });
    const text = fs.readFileSync(p, 'utf8');

    expect((yaml.load(text) as any).agents[0].workingDirectory).toBe(AUTHORED_PATH);
    expect(text).not.toContain('generated by the deployer');
  });

  it('still parses through parseTeamConfig, which sees no workingDirectory', () => {
    const p = target('parsed.yaml');
    exportTeamConfig({
      teamName: 't',
      agents: [generatedRow(), authoredRow()],
      targetPath: p,
      baseWorkDir: BASE,
    });

    const parsed = parseTeamConfig(p);
    const gen = parsed.agents.find((a) => a.name === 'gen')!;
    const auth = parsed.agents.find((a) => a.name === 'auth')!;
    // Absent, so deploy regenerates for the NEW id (agent-manager-db.ts:6122).
    expect(gen.workingDirectory).toBeUndefined();
    expect(auth.workingDirectory).toBe(AUTHORED_PATH);
  });

  it('is byte-identical when exported twice', () => {
    const a = target('a.yaml');
    const b = target('b.yaml');
    const rows = [generatedRow(), authoredRow()];
    exportTeamConfig({ teamName: 't', agents: rows, targetPath: a, baseWorkDir: BASE });
    exportTeamConfig({ teamName: 't', agents: rows, targetPath: b, baseWorkDir: BASE });
    expect(fs.readFileSync(a, 'utf8')).toBe(fs.readFileSync(b, 'utf8'));
  });

  it('comments each generated agent independently in a mixed team', () => {
    const p = target('mixed.yaml');
    const second = generatedRow({ name: 'gen2', id: 'agent_1700000000001_def5678' });
    second.working_directory = path.join(BASE, 'agents', 'agent_1700000000001_def5678');
    exportTeamConfig({
      teamName: 't',
      agents: [generatedRow(), authoredRow(), second],
      targetPath: p,
      baseWorkDir: BASE,
    });
    const text = fs.readFileSync(p, 'utf8');

    expect(text.match(/# workingDirectory was generated by the deployer/g)).toHaveLength(2);
    expect(text).toContain(GENERATED_PATH);
    expect(text).toContain(second.working_directory);
    const loaded = yaml.load(text) as any;
    expect(loaded.agents.find((a: any) => a.name === 'auth').workingDirectory).toBe(AUTHORED_PATH);
    for (const name of ['gen', 'gen2']) {
      expect(loaded.agents.find((a: any) => a.name === name).workingDirectory).toBeUndefined();
    }
  });

  it('anchors on the exported name when an alias renames the agent', () => {
    // buildAgentEntry folds metadata.alias into `name`, so the anchor has to be
    // the alias, not the row name, or the comment lands nowhere.
    const p = target('alias.yaml');
    const r = exportTeamConfig({
      teamName: 't',
      agents: [generatedRow({ metadata: { alias: 'renamed' } })],
      targetPath: p,
      baseWorkDir: BASE,
    });
    const text = fs.readFileSync(p, 'utf8');

    expect(r.warnings.some((w) => w.includes('could not be anchored'))).toBe(false);
    const lines = text.split('\n');
    const anchor = lines.findIndex((l) => l.includes('- name: renamed'));
    expect(lines.slice(anchor - 5, anchor).join('\n')).toContain(GENERATED_PATH);
  });
});

describe('buildTeamConfig reports what was commented', () => {
  it('names only the generated agents', () => {
    const { generatedWorkdirs } = buildTeamConfig(
      't', [generatedRow(), authoredRow()], {}, undefined, BASE,
    );
    expect(generatedWorkdirs).toEqual([{ agent: 'gen', path: GENERATED_PATH }]);
  });

  it('reports none without a baseWorkDir', () => {
    const { generatedWorkdirs } = buildTeamConfig('t', [generatedRow(), authoredRow()]);
    expect(generatedWorkdirs).toEqual([]);
  });
});
