// SPDX-License-Identifier: MIT
/**
 * `/export` — write a team config YAML from the database (SPEC §5, export side).
 *
 * The database is the source of truth; a config file is an export artifact
 * (D3). Everything this module emits is decided by `metadata-taxonomy.ts`:
 *
 *   - The COLUMN list is DERIVED from `classifyAgentColumn`, never `SELECT *`
 *     and never "all columns except". A column added to the schema later is
 *     `unknown` and is not exported until someone classifies it on purpose.
 *   - METADATA keys go through `classifyMetadataKey`. `config` and `identifier`
 *     are written; `runtime` and `derived` are dropped silently because they
 *     are reproducible; `unknown` is dropped and REPORTED (§3.1 rule 1),
 *     because silent omission is a data-loss bug.
 *
 * Out of scope here, by design: auto-export (§5.4, commit 3), import (§5.2.3 /
 * §7, commit 7), `/diff` (§8).
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import {
  classifyAgentColumn,
  classifyMetadataKey,
  listClassifiedColumns,
} from './metadata-taxonomy.js';

/**
 * §5.6 — REQUIRED in every export result, in the JSON body AND the
 * human-readable output. Export is not a complete backup, and anyone treating
 * it as disaster recovery needs to know the limit before they need the backup.
 */
export const WALLET_EXPORT_WARNING =
  'Wallets are not exported. Imported agents provision new wallets; the originals ' +
  'remain in the OWS vault and are not reachable from the restored team.';

/**
 * Avatar rules (§5.2.2).
 *
 * NOTE: the spec cites `ProfileService.ts` for these constants, but that file
 * lives in the desktop repo — core has no avatar code at all. They are
 * duplicated here deliberately and must be kept in sync with it; if the two
 * ever disagree, export will silently diverge from what the writer accepts.
 */
export const AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'webp'] as const;
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/** Matches ProfileService's path-segment guard. */
export const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface AgentRowLike {
  name: string;
  metadata?: Record<string, unknown> | null;
  [column: string]: unknown;
}

export interface ScheduleLike {
  kind: string;
  active: boolean;
  interval_seconds: number | null;
}

export interface ExportResult {
  ok: true;
  path: string;
  agents: number;
  /** Unknown/unclassified metadata keys per agent (§3.1 rule 1). */
  skipped: Array<{ agent: string; keys: string[] }>;
  warnings: string[];
}

/** Column name -> config field name. Renames only; membership is the taxonomy's call. */
export const COLUMN_CONFIG_KEY: Readonly<Record<string, string>> = Object.freeze({
  name: 'name',
  type: 'type',
  model: 'model',
  runtime: 'runtime',
  working_directory: 'workingDirectory',
  customer_domain: 'customer_domain',
  public_endpoint_url: 'public_endpoint_url',
  token_id: 'tokenId',
  domain: 'domain',
});

/** Metadata key -> config field name, where the two differ. */
const METADATA_CONFIG_KEY: Readonly<Record<string, string>> = Object.freeze({
  allowed_tools: 'allowedTools',
});

/**
 * The exported column allow-list, derived from the taxonomy at call time.
 *
 * This is the §5.3 / acceptance-5a requirement in one function: membership is
 * decided by `classifyAgentColumn`, so `api_key`, `ssh_target` and
 * `internal_endpoint_url` (class `never`) can never appear, and neither can a
 * column nobody has classified.
 *
 * `classify` is injectable ONLY so the taxonomy gate can be tested. Today it and
 * `COLUMN_CONFIG_KEY` cover exactly the same nine columns, so with the real
 * classifier the gate is unobservable — remove it and every output-level
 * assertion still passes. The seam lets a test demote a column and prove the
 * gate, not the rename map, is what drops it.
 */
export function exportedColumns(
  classify: (column: string) => string = classifyAgentColumn,
): string[] {
  return listClassifiedColumns()
    .filter((column) => {
      const klass = classify(column);
      return klass === 'config' || klass === 'identifier';
    })
    .filter((column) => Object.prototype.hasOwnProperty.call(COLUMN_CONFIG_KEY, column));
}

/**
 * Build one `agents[]` entry, plus the unknown keys it had to drop.
 *
 * The agent's exported name is `metadata.alias || name` — the shipped
 * DB→config precedent at `interactive-agent-cli.ts:967`. `alias` itself stays
 * unclassified, so it is dropped and reported like any other unknown key.
 */
export function buildAgentEntry(
  row: AgentRowLike,
  schedules: ScheduleLike[] = [],
): { entry: Record<string, unknown>; skippedKeys: string[] } {
  const entry: Record<string, unknown> = {};
  const skippedKeys: string[] = [];

  for (const column of exportedColumns()) {
    const value = row[column];
    if (value === undefined || value === null || value === '') continue;
    entry[COLUMN_CONFIG_KEY[column]] = value;
  }

  const metadata = (row.metadata || {}) as Record<string, unknown>;
  for (const key of Object.keys(metadata)) {
    const value = metadata[key];
    switch (classifyMetadataKey(key)) {
      case 'config':
      case 'identifier':
        if (value !== undefined && value !== null) {
          entry[METADATA_CONFIG_KEY[key] || key] = value;
        }
        break;
      case 'runtime':
      case 'derived':
        break; // reproducible, never written (§5.3)
      case 'unknown':
        skippedKeys.push(key); // dropped, but never silently (§3.1 rule 1)
        break;
    }
  }

  // The exported name folds in the alias; see interactive-agent-cli.ts:967.
  const alias = metadata.alias;
  if (typeof alias === 'string' && alias) entry.name = alias;

  // §3.1 rule 4: metadata.heartbeat is a boolean. The interval lives in the
  // schedules table, so reconstruct it rather than exporting the flag.
  if (entry.heartbeat !== undefined) {
    const beat = schedules.find((s) => s.kind === 'heartbeat' && s.active);
    if (beat?.interval_seconds) entry.heartbeat = beat.interval_seconds;
    else delete entry.heartbeat;
  }

  return { entry, skippedKeys };
}

/** Assemble the full team config document. `defaults` holds only unanimous values. */
export function buildTeamConfig(
  teamName: string,
  agents: AgentRowLike[],
  schedulesByAgent: Record<string, ScheduleLike[]> = {},
  org?: unknown,
): { config: Record<string, unknown>; skipped: ExportResult['skipped'] } {
  const skipped: ExportResult['skipped'] = [];
  const entries = agents.map((row) => {
    const { entry, skippedKeys } = buildAgentEntry(row, schedulesByAgent[String(row.name)] || []);
    if (skippedKeys.length) skipped.push({ agent: String(entry.name ?? row.name), keys: skippedKeys });
    return entry;
  });

  // §5.2: `defaults` carries a field only where every agent agrees on it.
  const defaults: Record<string, unknown> = {};
  for (const field of ['runtime', 'model', 'type'] as const) {
    const values = entries.map((e) => e[field]);
    if (values.length > 1 && values.every((v) => v !== undefined && v === values[0])) {
      defaults[field] = values[0];
      for (const e of entries) delete e[field];
    }
  }

  const config: Record<string, unknown> = { version: '1', team: teamName };
  if (Object.keys(defaults).length) config.defaults = defaults;
  if (org !== undefined && org !== null) config.org = org;
  config.agents = entries;
  return { config, skipped };
}

/**
 * Mirror avatars into `configs/avatars/<team>/<agent>/avatar.<ext>` (§5.2.1).
 *
 * Root swap only. Selects `avatar.*` EXPLICITLY rather than sweeping the
 * directory, so the `.DS_Store` that exists beside a live avatar today is
 * never copied, and re-validates size because export does not trust what is
 * already on disk (§5.2.2 rule 3).
 */
export function exportAvatars(
  teamName: string,
  agentNames: string[],
  profilesRoot: string,
  avatarsRoot: string,
): { copied: string[]; warnings: string[] } {
  const copied: string[] = [];
  const warnings: string[] = [];
  if (!SAFE_SEGMENT.test(teamName)) {
    warnings.push(`Avatar export skipped for team "${teamName}": unsafe team name.`);
    return { copied, warnings };
  }

  for (const agentName of agentNames) {
    if (!SAFE_SEGMENT.test(agentName)) {
      warnings.push(`Avatar skipped for "${agentName}": name fails the safe-segment guard.`);
      continue;
    }
    const sourceDir = path.join(profilesRoot, teamName, agentName);
    for (const ext of AVATAR_EXTS) {
      const source = path.join(sourceDir, `avatar.${ext}`);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(source);
      } catch {
        continue; // no avatar with this extension
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_AVATAR_BYTES) {
        warnings.push(
          `Avatar skipped for "${agentName}": ${stat.size} bytes exceeds the ${MAX_AVATAR_BYTES}-byte limit.`,
        );
        continue;
      }
      const destDir = path.join(avatarsRoot, teamName, agentName);
      try {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(source, path.join(destDir, `avatar.${ext}`));
        copied.push(path.join(destDir, `avatar.${ext}`));
      } catch (err: unknown) {
        warnings.push(`Avatar skipped for "${agentName}": ${(err as Error)?.message || String(err)}`);
      }
    }
  }
  return { copied, warnings };
}

export interface ExportOptions {
  teamName: string;
  agents: AgentRowLike[];
  targetPath: string;
  schedulesByAgent?: Record<string, ScheduleLike[]>;
  org?: unknown;
  profilesRoot?: string;
  avatarsRoot?: string;
}

/** Write the team config YAML, backing up any existing file first (§5.1). */
export function exportTeamConfig(options: ExportOptions): ExportResult {
  const { teamName, agents, targetPath, schedulesByAgent = {}, org } = options;
  const { config, skipped } = buildTeamConfig(teamName, agents, schedulesByAgent, org);

  const warnings: string[] = [WALLET_EXPORT_WARNING];
  if (options.profilesRoot && options.avatarsRoot) {
    const avatars = exportAvatars(
      teamName,
      agents.map((a) => String(a.name)),
      options.profilesRoot,
      options.avatarsRoot,
    );
    warnings.push(...avatars.warnings);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (fs.existsSync(targetPath)) fs.copyFileSync(targetPath, `${targetPath}.bak`);
  fs.writeFileSync(
    targetPath,
    `# Exported from the database by /export — the database is the source of truth.\n` +
      `# ${WALLET_EXPORT_WARNING}\n` +
      yaml.dump(config, { noRefs: true, lineWidth: 120 }),
  );

  return { ok: true, path: targetPath, agents: agents.length, skipped, warnings };
}

/** Human-readable output. §5.6 requires the warning here too, not only in JSON. */
export function formatExportResult(result: ExportResult): string {
  const lines = [`Exported ${result.agents} agent(s) to ${result.path}`];
  for (const { agent, keys } of result.skipped) {
    lines.push(`  skipped unknown key(s) on ${agent}: ${keys.join(', ')}`);
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  return lines.join('\n');
}
