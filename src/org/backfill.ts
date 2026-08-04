// SPDX-License-Identifier: MIT

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { OrgConfig, Group } from '../config-parser.js';
import type { DbAdapter, QueryResult } from '../db/db-adapter.js';
import { parseJsonObject } from '../db/db-json.js';
import {
  NormalizedOrgStore,
  OrgValidationError,
  type OrgStateStatus,
  type OrgValidationMetrics,
} from './normalized-org.js';

export interface OrgBackfillTeamReport {
  teamId: string;
  teamName: string;
  status: OrgStateStatus;
  sourcePath: string | null;
  sourceHash: string | null;
  groupCount: number;
  explicitMembershipCount: number;
  tagCount: number;
  tagAssignmentCount: number;
  recursiveMembers: Record<string, string[]>;
  semanticHash: string | null;
  reason: string | null;
}

export interface OrgBackfillReport {
  runId: string;
  dryRun: boolean;
  startedAt: number;
  completedAt: number;
  teams: OrgBackfillTeamReport[];
  totals: {
    teams: number;
    normalized: number;
    intentionallyNoOrg: number;
    blocked: number;
    groups: number;
    tagAssignments: number;
  };
}

export interface OrgBackfillOptions {
  dryRun: boolean;
  decidedBy: string;
  now?: number;
  runId?: string;
  readSource?: (path: string) => string;
  noOrgOverrides?: Record<string, { reason: string }>;
  acknowledgeSourceDrift?: boolean;
}

interface PlannedTeam extends OrgBackfillTeamReport {
  org?: OrgConfig;
  config: Record<string, unknown>;
}

function parameterize(db: DbAdapter, sql: string): string {
  if (db.dialect === 'sqlite') return sql;
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function query<T>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return db.query<T>(parameterize(db, sql), params);
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = stableValue(entry);
    }
    return out;
  }
  return value;
}

function directMembers(group: Group): string[] {
  return (group.members ?? []).filter((member) => member !== group.lead);
}

export function orgSemanticSnapshot(org: OrgConfig): {
  groups: Array<{
    path: string;
    description: string | null;
    lead: string | null;
    directMembers: string[];
    recursiveMembers: string[];
  }>;
  tags: Array<{ name: string; members: string[] }>;
} {
  const groups: Array<{
    path: string;
    description: string | null;
    lead: string | null;
    directMembers: string[];
    recursiveMembers: string[];
  }> = [];
  const visit = (name: string, group: Group, parentPath: string): string[] => {
    const path = parentPath ? `${parentPath}/${name}` : name;
    const recursive = new Set<string>(directMembers(group));
    if (group.lead) recursive.add(group.lead);
    for (const [childName, child] of Object.entries(group.groups ?? {})) {
      for (const member of visit(childName, child, path)) recursive.add(member);
    }
    const recursiveMembers = [...recursive];
    groups.push({
      path,
      description: group.description ?? null,
      lead: group.lead ?? null,
      directMembers: directMembers(group),
      recursiveMembers,
    });
    return recursiveMembers;
  };
  for (const [name, group] of Object.entries(org.groups ?? {})) visit(name, group, '');
  // visit() is post-order for recursive member calculation; restore source preorder.
  const byPath = new Map(groups.map((group) => [group.path, group]));
  const preorder: typeof groups = [];
  const append = (name: string, group: Group, parentPath: string): void => {
    const path = parentPath ? `${parentPath}/${name}` : name;
    preorder.push(byPath.get(path)!);
    for (const [childName, child] of Object.entries(group.groups ?? {})) append(childName, child, path);
  };
  for (const [name, group] of Object.entries(org.groups ?? {})) append(name, group, '');
  return {
    groups: preorder,
    tags: Object.entries(org.tags ?? {}).map(([name, members]) => ({ name, members: [...members] })),
  };
}

function semanticHash(org: OrgConfig): string {
  return sha256(JSON.stringify(stableValue(orgSemanticSnapshot(org))));
}

function blocked(
  teamId: string,
  teamName: string,
  config: Record<string, unknown>,
  reason: string,
  sourcePath: string | null = null,
  sourceHash: string | null = null,
): PlannedTeam {
  return {
    teamId,
    teamName,
    status: 'blocked',
    sourcePath,
    sourceHash,
    groupCount: 0,
    explicitMembershipCount: 0,
    tagCount: 0,
    tagAssignmentCount: 0,
    recursiveMembers: {},
    semanticHash: null,
    reason,
    config,
  };
}

async function planTeam(
  db: DbAdapter,
  store: NormalizedOrgStore,
  row: { id: string; name: string; config: unknown },
  options: OrgBackfillOptions,
): Promise<PlannedTeam> {
  const config = parseJsonObject(row.config);
  const override = options.noOrgOverrides?.[row.name];
  const intentionallyNoOrg = (team: PlannedTeam): PlannedTeam => {
    if (!override) return team;
    return {
      ...team,
      status: 'intentionally_no_org',
      reason: override.reason,
    };
  };

  let sourcePath: string | null = null;
  let sourceHash: string | null = null;
  let org: OrgConfig | undefined;
  const priorState = await store.getState(row.id);
  const driftBlock = (): PlannedTeam | null => {
    if (
      priorState?.sourceHash &&
      priorState.sourceHash !== sourceHash &&
      !options.acknowledgeSourceDrift
    ) {
      return blocked(
        row.id,
        row.name,
        config,
        `source_drift_requires_acknowledgment: ${priorState.sourceHash} -> ${sourceHash}`,
        sourcePath,
        sourceHash,
      );
    }
    return null;
  };
  if (config.org && typeof config.org === 'object') {
    const serialized = JSON.stringify(stableValue(config.org));
    sourcePath = 'teams.config.org';
    sourceHash = sha256(serialized);
    const drift = driftBlock();
    if (drift) return drift;
    org = config.org as OrgConfig;
  } else {
    if (typeof config.last_config_path !== 'string' || !config.last_config_path) {
      return intentionallyNoOrg(blocked(row.id, row.name, config, 'missing_source_path'));
    }
    sourcePath = config.last_config_path;
    let source: string;
    try {
      source = (options.readSource ?? ((path: string) => readFileSync(path, 'utf8')))(sourcePath);
    } catch (error) {
      return intentionallyNoOrg(blocked(
        row.id,
        row.name,
        config,
        `source_unreadable: ${(error as Error).message}`,
        sourcePath,
      ));
    }
    sourceHash = sha256(source);
    const drift = driftBlock();
    if (drift) return drift;
    if (/\$\{[^}]+\}/.test(source)) {
      return blocked(row.id, row.name, config, 'source_contains_unexpanded_template', sourcePath, sourceHash);
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(source);
    } catch (error) {
      return blocked(row.id, row.name, config, `source_yaml_invalid: ${(error as Error).message}`, sourcePath, sourceHash);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return blocked(row.id, row.name, config, 'source_config_invalid', sourcePath, sourceHash);
    }
    org = (parsed as { org?: OrgConfig }).org;
  }
  if (!org) {
    return intentionallyNoOrg(blocked(
      row.id,
      row.name,
      config,
      'source_has_no_org',
      sourcePath,
      sourceHash,
    ));
  }

  let metrics: OrgValidationMetrics;
  try {
    metrics = await store.validateFromConfig(row.id, org);
  } catch (error) {
    const reason = error instanceof OrgValidationError
      ? `${error.code}: ${error.message}`
      : `org_validation_failed: ${(error as Error).message}`;
    return blocked(row.id, row.name, config, reason, sourcePath, sourceHash);
  }
  const semantic = orgSemanticSnapshot(org);
  const normalized: PlannedTeam = {
    teamId: row.id,
    teamName: row.name,
    status: 'normalized',
    sourcePath,
    sourceHash,
    groupCount: metrics.groupCount,
    explicitMembershipCount: metrics.explicitMembershipCount,
    tagCount: metrics.tagCount,
    tagAssignmentCount: metrics.tagAssignmentCount,
    recursiveMembers: Object.fromEntries(semantic.groups.map((group) => [group.path, group.recursiveMembers])),
    semanticHash: semanticHash(org),
    reason: null,
    config,
    org,
  };
  if (!override) return normalized;
  // A no-org override is evidence for an absent/unrecoverable source, never
  // permission to erase a resolvable organization. Preserve the discovered
  // metrics in the report so an operator can see exactly what conflicted.
  return {
    ...normalized,
    status: 'blocked',
    reason: `override_conflicts_with_resolvable_org: ${override.reason}`,
    org: undefined,
  };
}

async function writeAudit(db: DbAdapter, runId: string, now: number, team: OrgBackfillTeamReport): Promise<void> {
  await query(db,
    `INSERT INTO org_migration_audit
       (id, run_id, team_id, status, source_path, source_hash, group_count,
        tag_assignment_count, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      runId,
      team.teamId,
      team.status,
      team.sourcePath,
      team.sourceHash,
      team.groupCount,
      team.tagAssignmentCount,
      team.reason,
      now,
    ],
  );
}

export async function backfillOrganizations(
  db: DbAdapter,
  options: OrgBackfillOptions,
): Promise<OrgBackfillReport> {
  const startedAt = options.now ?? Date.now();
  const runId = options.runId ?? randomUUID();
  const store = new NormalizedOrgStore(db);
  const teamRows = await query<{ id: string; name: string; config: unknown }>(
    db,
    `SELECT id, name, config FROM teams ORDER BY name`,
  );
  const planned: PlannedTeam[] = [];
  for (const row of teamRows.rows) planned.push(await planTeam(db, store, row, options));

  if (!options.dryRun) {
    const refusal = planned.find((team) =>
      team.reason?.startsWith('source_drift_requires_acknowledgment') ||
      team.reason?.startsWith('override_conflicts_with_resolvable_org'),
    );
    if (refusal) {
      throw new Error(`${refusal.teamName}: ${refusal.reason}`);
    }
    for (const team of planned) {
      try {
        if (team.status === 'normalized' && team.org) {
          await store.replaceFromConfig(team.teamId, team.org, {
            decidedBy: options.decidedBy,
            decidedAt: startedAt,
            reason: 'audited org backfill',
            sourceHash: team.sourceHash ?? undefined,
          });
          const stored = await store.readOrg(team.teamId);
          if (!stored || semanticHash(stored) !== team.semanticHash) {
            throw new OrgValidationError('org_data_corrupt', 'semantic verification failed after write');
          }
        } else if (team.status === 'intentionally_no_org') {
          await store.markIntentionallyNoOrg(team.teamId, {
            decidedBy: options.decidedBy,
            decidedAt: startedAt,
            reason: team.reason ?? 'operator no-org override',
            sourceHash: team.sourceHash ?? undefined,
          });
        } else {
          await store.markBlocked(team.teamId, {
            decidedBy: options.decidedBy,
            decidedAt: startedAt,
            reason: team.reason ?? 'org migration blocked',
            sourceHash: team.sourceHash ?? undefined,
          });
        }
      } catch (error) {
        team.status = 'blocked';
        team.reason = `apply_failed: ${(error as Error).message}`;
        team.groupCount = 0;
        team.explicitMembershipCount = 0;
        team.tagCount = 0;
        team.tagAssignmentCount = 0;
        team.recursiveMembers = {};
        team.semanticHash = null;
        const count = await query<{ count: number | string }>(
          db,
          `SELECT COUNT(*) AS count FROM org_groups WHERE team_id = ?`,
          [team.teamId],
        );
        if (Number(count.rows[0]?.count ?? 0) === 0) {
          await store.markBlocked(team.teamId, {
            decidedBy: options.decidedBy,
            decidedAt: startedAt,
            reason: team.reason,
            sourceHash: team.sourceHash ?? undefined,
          });
        } else {
          throw error;
        }
      }
      await writeAudit(db, runId, startedAt, team);
    }

    const stateCount = await query<{ count: number | string }>(db, `SELECT COUNT(*) AS count FROM team_org_state`);
    if (Number(stateCount.rows[0]?.count ?? 0) !== teamRows.rows.length) {
      throw new Error('org_migration_required: not every team has a terminal classification');
    }
    const auditCount = await query<{ count: number | string }>(
      db,
      `SELECT COUNT(*) AS count FROM org_migration_audit WHERE run_id = ?`,
      [runId],
    );
    if (Number(auditCount.rows[0]?.count ?? 0) !== teamRows.rows.length) {
      throw new Error('org_migration_required: not every team has an audited terminal classification');
    }
    // Retire the deprecated JSON copy only after every team has a terminal state.
    // This cleanup is resumable rather than fleet-atomic; normalized authority
    // is already final, so a crash can only leave an ignored legacy copy behind.
    for (const team of planned) {
      if (!Object.prototype.hasOwnProperty.call(team.config, 'org')) continue;
      const next = { ...team.config };
      delete next.org;
      await query(db, `UPDATE teams SET config = ? WHERE id = ?`, [JSON.stringify(next), team.teamId]);
    }
  }

  const teams = planned.map(({ org: _org, config: _config, ...team }) => team);
  const report: OrgBackfillReport = {
    runId,
    dryRun: options.dryRun,
    startedAt,
    completedAt: Date.now(),
    teams,
    totals: {
      teams: teams.length,
      normalized: teams.filter((team) => team.status === 'normalized').length,
      intentionallyNoOrg: teams.filter((team) => team.status === 'intentionally_no_org').length,
      blocked: teams.filter((team) => team.status === 'blocked').length,
      groups: teams.reduce((count, team) => count + team.groupCount, 0),
      tagAssignments: teams.reduce((count, team) => count + team.tagAssignmentCount, 0),
    },
  };
  return report;
}
