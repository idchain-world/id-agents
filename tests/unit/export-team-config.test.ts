// SPDX-License-Identifier: MIT
/**
 * /export tests — SPEC §5, export side (commit 2).
 *
 * Fixtures only. The live database on :4100 is Prem's fleet and is never
 * touched; every row here is constructed in the test. The one thing read from
 * the real filesystem is `~/.id-agents/profiles`, and only to reproduce the
 * `.DS_Store` case the spec calls out — guarded so it skips if absent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

import {
  AVATAR_EXTS,
  COLUMN_CONFIG_KEY,
  MAX_AVATAR_BYTES,
  WALLET_EXPORT_WARNING,
  buildAgentEntry,
  buildTeamConfig,
  exportAvatars,
  exportTeamConfig,
  exportedColumns,
  formatExportResult,
  isConfigExpressible,
} from '../../src/lib/export-team-config.js';
import {
  NEVER_EXPORT_COLUMNS,
  classifyAgentColumn,
  listClassifiedColumns,
} from '../../src/lib/metadata-taxonomy.js';

let tmp = '';
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-')); });
afterEach(() => { if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; } });

function target(name = 'team.yaml') { return path.join(tmp, 'configs', name); }
function readYaml(p: string) { return yaml.load(fs.readFileSync(p, 'utf-8')) as any; }

describe('column allow-list is derived from the taxonomy (§5.3, acceptance 5a)', () => {
  it('never includes a credential or sensitive column', () => {
    const cols = exportedColumns();
    for (const forbidden of NEVER_EXPORT_COLUMNS) expect(cols).not.toContain(forbidden);
  });

  it('never includes runtime or derived columns', () => {
    const cols = exportedColumns();
    for (const c of ['id', 'port', 'status', 'created_at', 'team_id', 'endpoint', 'metadata']) {
      expect(cols).not.toContain(c);
    }
  });

  it('includes the config and identifier columns', () => {
    const cols = exportedColumns();
    for (const c of ['name', 'model', 'runtime', 'working_directory', 'token_id', 'domain']) {
      expect(cols).toContain(c);
    }
  });

  // The three assertions above pass even if the taxonomy gate is deleted, because
  // COLUMN_CONFIG_KEY happens to list exactly the config/identifier columns. These
  // two pin the gate itself, so a future divergence is a test failure, not a leak.
  it('drops a column the classifier demotes, even though it is still in the rename map', () => {
    const demoted = (column: string) =>
      column === 'token_id' ? 'never' : classifyAgentColumn(column);

    expect(exportedColumns()).toContain('token_id');
    expect(exportedColumns(demoted)).not.toContain('token_id');
    // and only that one column moves
    expect(exportedColumns(demoted)).toEqual(exportedColumns().filter((c) => c !== 'token_id'));
  });

  it('the rename map and the taxonomy agree exactly, in both directions', () => {
    const fromTaxonomy = listClassifiedColumns().filter((c) => {
      const klass = classifyAgentColumn(c);
      return klass === 'config' || klass === 'identifier';
    });
    const fromMap = Object.keys(COLUMN_CONFIG_KEY);

    // A config column with no rename entry would be dropped silently — the exact
    // data-loss §3.1 rule 1 exists to prevent.
    expect(fromTaxonomy.filter((c) => !fromMap.includes(c))).toEqual([]);
    // A rename entry for a non-config column is how a credential would get out.
    expect(fromMap.filter((c) => !fromTaxonomy.includes(c))).toEqual([]);
  });
});

describe('credential and sensitive columns never export', () => {
  it('a fixture with api_key, ssh_target and internal_endpoint_url exports none of the three', () => {
    const row = {
      name: 'sensitive', model: 'haiku',
      api_key: 'sk-SECRET', ssh_target: 'root@10.0.0.1',
      internal_endpoint_url: 'http://10.0.0.1:9000',
      metadata: {},
    };
    const { entry } = buildAgentEntry(row);
    expect(entry.api_key).toBeUndefined();
    expect(entry.ssh_target).toBeUndefined();
    expect(entry.internal_endpoint_url).toBeUndefined();

    // And nothing resembling the secrets survives into the serialized YAML.
    const p = target();
    exportTeamConfig({ teamName: 't', agents: [row], targetPath: p });
    const text = fs.readFileSync(p, 'utf-8');
    expect(text).not.toContain('sk-SECRET');
    expect(text).not.toContain('root@10.0.0.1');
    expect(text).not.toContain('10.0.0.1:9000');
  });
});

describe('metadata classes drive inclusion (§5.3)', () => {
  it('drops runtime and derived keys, keeps identifier', () => {
    const { entry } = buildAgentEntry({
      name: 'a', metadata: {
        pid: 4242, local: true, endpoint: 'http://localhost:1', service_type: 'REST-AP',
        ows_address: '0xdead', agent_account: '0xbeef', description: 'keep me',
      },
    });
    expect(entry.pid).toBeUndefined();
    expect(entry.local).toBeUndefined();
    expect(entry.endpoint).toBeUndefined();
    expect(entry.service_type).toBeUndefined();
    expect(entry.ows_address).toBeUndefined();
    expect(entry.agent_account).toBe('0xbeef'); // D10
    expect(entry.description).toBe('keep me');
  });

  it('exports neither wallet field (D7)', () => {
    const { entry } = buildAgentEntry({
      name: 'w', metadata: { ows_wallet: 'default-w', ows_address: '0xabc', wallet: true },
    });
    expect(entry.ows_wallet).toBeUndefined();
    expect(entry.ows_address).toBeUndefined();
    expect(entry.wallet).toBe(true); // the opt-in boolean IS config
  });

  it('round-trips ENS from a fixture (D9) — 0 live rows, so only a fixture can prove this', () => {
    const { entry } = buildAgentEntry({
      name: 'ens', token_id: 'agent-5', domain: 'ens.eth', metadata: {},
    });
    expect(entry.tokenId).toBe('agent-5');
    expect(entry.domain).toBe('ens.eth');
  });

  it('exports the six DMZ posture keys, mesh_member especially', () => {
    const { entry } = buildAgentEntry({
      name: 'dmz-agent', metadata: {
        mesh_member: false, mesh_reachable: false, public_endpoint: true, dmz: true,
        allowed_inbound: ['public_http'], allowed_outbound: ['openrouter'],
      },
    });
    // Dropping mesh_member would fail OPEN — absent means mesh-member.
    expect(entry.mesh_member).toBe(false);
    expect(entry.dmz).toBe(true);
    expect(entry.allowed_inbound).toEqual(['public_http']);
  });
});

describe('agents that cannot round-trip are REPORTED, never dropped (§3.1 at agent level)', () => {
  // The bug this exists for: SqliteAgentsRepo.list() hides interactive/virtual
  // rows, so `default/cto` — register-created, type=virtual — vanished from a
  // real export with nothing said. A file that looks complete but is missing an
  // agent is the worst failure this command has.
  const registerShaped = {
    name: 'cto', type: 'virtual', runtime: 'external',
    metadata: { name: 'cto', service_type: 'REST-AP', endpoint: 'http://x', role: 'lead/orchestrator', agent_account: '0xbeef' },
  };

  it('classifies config-expressible rows correctly', () => {
    expect(isConfigExpressible({ name: 'a', type: 'claude' })).toBe(true);
    expect(isConfigExpressible({ name: 'a', type: 'automator' })).toBe(true);
    // A remote-endpoint row IS expressible: customer_domain/public_endpoint_url
    // are real config fields.
    expect(isConfigExpressible({ name: 'a', type: 'virtual', runtime: 'public-agent-remote' })).toBe(true);
    expect(isConfigExpressible(registerShaped)).toBe(false);
    expect(isConfigExpressible({ name: 'a', type: 'interactive', runtime: 'external' })).toBe(false);
  });

  it('names the unexportable agent in warnings and keeps it out of the file', () => {
    const p = target();
    const r = exportTeamConfig({
      teamName: 't',
      agents: [{ name: 'alpha', type: 'claude', metadata: {} }, registerShaped],
      targetPath: p,
    });

    const joined = r.warnings.join('\n');
    expect(joined).toContain('"cto"');
    expect(joined).toContain('type=virtual');
    expect(joined).toContain('runtime=external');
    expect(joined).toMatch(/NOT exported/);

    const doc = readYaml(p);
    expect(doc.agents.map((a: any) => a.name)).toEqual(['alpha']);
  });

  it('accounts for every row handed in: exported + reported === total', () => {
    const r = exportTeamConfig({
      teamName: 't',
      agents: [{ name: 'alpha', type: 'claude', metadata: {} }, registerShaped],
      targetPath: target(),
    });
    const reported = r.warnings.filter((w) => w.includes('NOT exported')).length;
    expect(r.agents + reported).toBe(2);
    expect(r.agents).toBe(1);
  });

  it('still reports the unexportable row\'s unclassified keys, so `role` finally surfaces', () => {
    const r = exportTeamConfig({ teamName: 't', agents: [registerShaped], targetPath: target() });
    const entry = r.skipped.find((s) => s.agent === 'cto');
    expect(entry?.keys).toContain('role');
  });
});

describe('unknown keys are dropped AND reported (§3.1 rule 1)', () => {
  it('reports an unknown key in skipped rather than silently dropping it', () => {
    const { entry, skippedKeys } = buildAgentEntry({
      name: 'u', metadata: { totally_new_key: 'x', role: 'lead/orchestrator' },
    });
    expect(entry.totally_new_key).toBeUndefined();
    expect(entry.role).toBeUndefined();
    expect(skippedKeys.sort()).toEqual(['role', 'totally_new_key']);
  });

  it('surfaces skipped keys per agent in the result', () => {
    const r = exportTeamConfig({
      teamName: 't',
      agents: [{ name: 'a', metadata: { mystery: 1 } }],
      targetPath: target(),
    });
    expect(r.skipped).toEqual([{ agent: 'a', keys: ['mystery'] }]);
    expect(formatExportResult(r)).toContain('mystery');
  });

  it('skips a column added to the table later', () => {
    const { entry } = buildAgentEntry({ name: 'a', some_column_added_in_2027: 'nope', metadata: {} });
    expect(entry.some_column_added_in_2027).toBeUndefined();
  });
});

describe('the exported name folds in the alias (cto decision, interactive-agent-cli.ts:967)', () => {
  it('emits metadata.alias as the name, and reports alias itself as unknown', () => {
    const { entry, skippedKeys } = buildAgentEntry({
      name: 'renamed.eth', metadata: { alias: 'original' },
    });
    expect(entry.name).toBe('original');
    expect(entry.alias).toBeUndefined();
    expect(skippedKeys).toContain('alias');
  });

  it('uses the name column when there is no alias', () => {
    const { entry } = buildAgentEntry({ name: 'plain', metadata: {} });
    expect(entry.name).toBe('plain');
  });
});

describe('heartbeat interval comes from the schedules table (§3.1 rule 4)', () => {
  it('replaces the boolean with the interval from the agent schedule row', () => {
    const { entry } = buildAgentEntry(
      { name: 'hb', metadata: { heartbeat: true } },
      [{ kind: 'heartbeat', active: true, interval_seconds: 900 }],
    );
    expect(entry.heartbeat).toBe(900);
  });

  it('drops the flag when no active heartbeat schedule exists', () => {
    const { entry } = buildAgentEntry(
      { name: 'hb', metadata: { heartbeat: true } },
      [{ kind: 'heartbeat', active: false, interval_seconds: 900 }],
    );
    expect(entry.heartbeat).toBeUndefined();
  });
});

describe('output shape (§5.1, §5.2)', () => {
  it('writes version/team/agents and hoists unanimous defaults', () => {
    const { config } = buildTeamConfig('t', [
      { name: 'a', runtime: 'claude-code-cli', model: 'haiku', metadata: {} },
      { name: 'b', runtime: 'claude-code-cli', model: 'haiku', metadata: {} },
    ]);
    expect(config.team).toBe('t');
    expect((config as any).defaults).toEqual({ runtime: 'claude-code-cli', model: 'haiku' });
    expect((config as any).agents[0].runtime).toBeUndefined();
  });

  it('does not hoist a field the agents disagree on', () => {
    const { config } = buildTeamConfig('t', [
      { name: 'a', model: 'haiku', metadata: {} },
      { name: 'b', model: 'opus', metadata: {} },
    ]);
    expect((config as any).defaults?.model).toBeUndefined();
    expect((config as any).agents[0].model).toBe('haiku');
  });

  it('backs up an existing file before overwriting (§5.1)', () => {
    const p = target();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'original: true\n');
    exportTeamConfig({ teamName: 't', agents: [{ name: 'a', metadata: {} }], targetPath: p });
    expect(fs.readFileSync(`${p}.bak`, 'utf-8')).toBe('original: true\n');
    expect(readYaml(p).team).toBe('t');
  });

  it('returns the §5.1 result shape', () => {
    const r = exportTeamConfig({ teamName: 't', agents: [{ name: 'a', metadata: {} }], targetPath: target() });
    expect(r.ok).toBe(true);
    expect(r.agents).toBe(1);
    expect(Array.isArray(r.skipped)).toBe(true);
  });
});

describe('the §5.6 wallet warning is unconditional', () => {
  it('appears in the JSON result, the human output, and the file header', () => {
    const p = target();
    const r = exportTeamConfig({ teamName: 't', agents: [{ name: 'a', metadata: {} }], targetPath: p });
    expect(r.warnings).toContain(WALLET_EXPORT_WARNING);
    expect(formatExportResult(r)).toContain('Wallets are not exported');
    expect(fs.readFileSync(p, 'utf-8')).toContain('Wallets are not exported');
  });
});

describe('avatar mirror (§5.2.1, §5.2.2)', () => {
  function seedAvatar(root: string, team: string, agent: string, ext = 'png', bytes = 10) {
    const dir = path.join(root, team, agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `avatar.${ext}`), Buffer.alloc(bytes));
    return dir;
  }

  it('mirrors one avatar to configs/avatars/<team>/<agent>/avatar.png', () => {
    const profiles = path.join(tmp, 'profiles');
    const avatars = path.join(tmp, 'configs', 'avatars');
    seedAvatar(profiles, 'blue', 'ann');
    const { copied, warnings } = exportAvatars('blue', ['ann'], profiles, avatars);
    expect(copied).toEqual([path.join(avatars, 'blue', 'ann', 'avatar.png')]);
    expect(fs.existsSync(path.join(avatars, 'blue', 'ann', 'avatar.png'))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('a team with no avatars creates nothing under configs/avatars', () => {
    const profiles = path.join(tmp, 'profiles');
    const avatars = path.join(tmp, 'configs', 'avatars');
    fs.mkdirSync(profiles, { recursive: true });
    const { copied } = exportAvatars('empty', ['nobody'], profiles, avatars);
    expect(copied).toEqual([]);
    expect(fs.existsSync(avatars)).toBe(false);
  });

  it('skips a 6 MB avatar and reports it in warnings', () => {
    const profiles = path.join(tmp, 'profiles');
    const avatars = path.join(tmp, 'configs', 'avatars');
    seedAvatar(profiles, 'blue', 'big', 'png', MAX_AVATAR_BYTES + 1);
    const { copied, warnings } = exportAvatars('blue', ['big'], profiles, avatars);
    expect(copied).toEqual([]);
    expect(warnings.join(' ')).toMatch(/big.*exceeds/);
  });

  it('never copies a non-avatar file — selects avatar.* explicitly', () => {
    const profiles = path.join(tmp, 'profiles');
    const avatars = path.join(tmp, 'configs', 'avatars');
    const dir = seedAvatar(profiles, 'blue', 'ann');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'secret');
    fs.writeFileSync(path.join(profiles, 'blue', '.DS_Store'), 'junk');
    exportAvatars('blue', ['ann'], profiles, avatars);
    expect(fs.existsSync(path.join(avatars, 'blue', 'ann', 'notes.txt'))).toBe(false);
    expect(fs.existsSync(path.join(avatars, 'blue', '.DS_Store'))).toBe(false);
  });

  it('reproduces the real tree: profiles/default/.DS_Store is not copied', () => {
    const realProfiles = path.join(os.homedir(), '.id-agents', 'profiles');
    if (!fs.existsSync(path.join(realProfiles, 'default', '.DS_Store'))) {
      // The spec says this file exists today; if the environment differs, skip
      // rather than assert on someone else's machine layout.
      return;
    }
    const avatars = path.join(tmp, 'configs', 'avatars');
    exportAvatars('default', ['bisor'], realProfiles, avatars);
    expect(fs.existsSync(path.join(avatars, 'default', '.DS_Store'))).toBe(false);
    // bisor/avatar.png exists in the real tree, so the mirror should hold it.
    expect(fs.existsSync(path.join(avatars, 'default', 'bisor', 'avatar.png'))).toBe(true);
  });

  it('refuses an agent name that fails the safe-segment guard', () => {
    const profiles = path.join(tmp, 'profiles');
    const avatars = path.join(tmp, 'configs', 'avatars');
    const { copied, warnings } = exportAvatars('blue', ['../../evil'], profiles, avatars);
    expect(copied).toEqual([]);
    expect(warnings.join(' ')).toMatch(/safe-segment/);
    expect(fs.existsSync(path.join(tmp, 'evil'))).toBe(false);
  });

  it('accepts every extension in AVATAR_EXTS and nothing else', () => {
    const profiles = path.join(tmp, 'profiles');
    const avatars = path.join(tmp, 'configs', 'avatars');
    seedAvatar(profiles, 'blue', 'gif-agent', 'gif');
    expect(exportAvatars('blue', ['gif-agent'], profiles, avatars).copied).toEqual([]);
    for (const ext of AVATAR_EXTS) {
      seedAvatar(profiles, 'blue', `a-${ext}`, ext);
      expect(exportAvatars('blue', [`a-${ext}`], profiles, avatars).copied).toHaveLength(1);
    }
  });
});
