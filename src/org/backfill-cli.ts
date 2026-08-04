// SPDX-License-Identifier: MIT

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateSqlite } from '../db/migrations/sqlite.js';
import { SqliteAdapter } from '../db/sqlite-adapter.js';
import { backfillOrganizations, type OrgBackfillReport } from './backfill.js';

export interface ApplyBackfillOptions {
  databasePath: string;
  rollbackPath: string;
  auditOutputPath: string;
  decidedBy: string;
  allowLiveDatabase?: boolean;
  noOrgOverrides?: Record<string, { reason: string }>;
  acknowledgeSourceDrift?: boolean;
}

export function liveDatabasePath(): string {
  return path.join(homedir(), '.id-agents', 'id-agents.db');
}

function isLiveDatabase(target: string): boolean {
  const live = liveDatabasePath();
  const resolvedLive = existsSync(live) ? realpathSync(live) : path.resolve(live);
  return target === resolvedLive;
}

export function assertSafeDatabasePath(databasePath: string, allowLiveDatabase = false): string {
  if (!path.isAbsolute(databasePath)) throw new Error('database path must be absolute');
  if (!existsSync(databasePath)) throw new Error(`database does not exist: ${databasePath}`);
  const target = realpathSync(databasePath);
  if (isLiveDatabase(target) && !allowLiveDatabase) {
    throw new Error('refusing to open or mutate the live ~/.id-agents/id-agents.db');
  }
  if (isLiveDatabase(target)) {
    process.stderr.write(
      '*** WARNING: --allow-live-database active; operating on LIVE ~/.id-agents/id-agents.db ***\n',
    );
  }
  return target;
}

export function fileSha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function assertIntegrity(databasePath: string): void {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
      throw new Error(`integrity_check failed for ${databasePath}`);
    }
  } finally {
    db.close();
  }
}

async function snapshotDatabase(sourcePath: string, destinationPath: string, live: boolean): Promise<void> {
  if (!live) {
    copyFileSync(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
    return;
  }

  // A live WAL database cannot be snapshotted by copying only the main file:
  // committed pages may exist solely in -wal. SQLite's online backup API takes
  // one consistent logical snapshot while readers and writers remain attached.
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true, timeout: 10_000 });
  try {
    await source.backup(destinationPath);
  } finally {
    source.close();
  }
}

async function snapshotSha256(databasePath: string): Promise<string> {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'id-agents-org-hash-'));
  const snapshotPath = path.join(tempRoot, 'snapshot.db');
  try {
    await snapshotDatabase(databasePath, snapshotPath, true);
    assertIntegrity(snapshotPath);
    return fileSha256(snapshotPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runOnDatabase(
  databasePath: string,
  dryRun: boolean,
  decidedBy: string,
  noOrgOverrides?: Record<string, { reason: string }>,
  acknowledgeSourceDrift?: boolean,
): Promise<OrgBackfillReport> {
  const adapter = new SqliteAdapter(databasePath);
  try {
    await migrateSqlite(adapter);
    return await backfillOrganizations(adapter, {
      dryRun,
      decidedBy,
      noOrgOverrides,
      acknowledgeSourceDrift,
    });
  } finally {
    await adapter.close();
  }
}

export async function dryRunOrgBackfill(options: {
  databasePath: string;
  auditOutputPath?: string;
  decidedBy: string;
  allowLiveDatabase?: boolean;
  noOrgOverrides?: Record<string, { reason: string }>;
  acknowledgeSourceDrift?: boolean;
}): Promise<OrgBackfillReport> {
  const source = assertSafeDatabasePath(options.databasePath, options.allowLiveDatabase);
  const live = isLiveDatabase(source);
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'id-agents-org-dryrun-'));
  const tempDatabase = path.join(tempRoot, 'dryrun.db');
  try {
    await snapshotDatabase(source, tempDatabase, live);
    const report = await runOnDatabase(
      tempDatabase,
      true,
      options.decidedBy,
      options.noOrgOverrides,
      options.acknowledgeSourceDrift,
    );
    if (options.auditOutputPath) writeFileSync(options.auditOutputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    return report;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function applyOrgBackfill(options: ApplyBackfillOptions): Promise<{
  report: OrgBackfillReport;
  beforeSha256: string;
  afterSha256: string;
}> {
  const database = assertSafeDatabasePath(options.databasePath, options.allowLiveDatabase);
  const live = isLiveDatabase(database);
  if (!path.isAbsolute(options.rollbackPath) || !path.isAbsolute(options.auditOutputPath)) {
    throw new Error('rollback and audit output paths must be absolute');
  }
  if (existsSync(options.rollbackPath)) throw new Error(`rollback path already exists: ${options.rollbackPath}`);
  if (existsSync(options.auditOutputPath)) throw new Error(`audit output already exists: ${options.auditOutputPath}`);
  assertIntegrity(database);
  await snapshotDatabase(database, options.rollbackPath, live);
  assertIntegrity(options.rollbackPath);
  const beforeSha256 = fileSha256(options.rollbackPath);
  const report = await runOnDatabase(
    database,
    false,
    options.decidedBy,
    options.noOrgOverrides,
    options.acknowledgeSourceDrift,
  );
  assertIntegrity(database);
  const afterSha256 = live ? await snapshotSha256(database) : fileSha256(database);
  writeFileSync(options.auditOutputPath, `${JSON.stringify({
    ...report,
    database,
    rollbackPath: options.rollbackPath,
    beforeSha256,
    afterSha256,
  }, null, 2)}\n`, { flag: 'wx' });
  return { report, beforeSha256, afterSha256 };
}

export async function restoreOrgBackfillSnapshot(options: {
  databasePath: string;
  rollbackPath: string;
  expectedCurrentSha256: string;
  allowLiveDatabase?: boolean;
  confirmLiveProcessesStopped?: boolean;
}): Promise<void> {
  const database = assertSafeDatabasePath(options.databasePath, options.allowLiveDatabase);
  const live = isLiveDatabase(database);
  if (live && !options.confirmLiveProcessesStopped) {
    throw new Error(
      'refusing live restore: stop every database holder and pass --confirm-live-processes-stopped',
    );
  }
  const rollback = assertSafeDatabasePath(options.rollbackPath);
  const currentSha256 = live ? await snapshotSha256(database) : fileSha256(database);
  if (currentSha256 !== options.expectedCurrentSha256) {
    throw new Error('refusing rollback: target database drifted after the audited backfill');
  }
  assertIntegrity(rollback);
  const temporary = `${database}.restore-${process.pid}-${Date.now()}`;
  try {
    copyFileSync(rollback, temporary, fsConstants.COPYFILE_EXCL);
    assertIntegrity(temporary);
    if (live) {
      // The explicit confirmation above is mandatory: removing WAL sidecars or
      // replacing the main inode while any process still holds it would fork
      // the running fleet onto an unlinked database.
      rmSync(`${database}-wal`, { force: true });
      rmSync(`${database}-shm`, { force: true });
    }
    renameSync(temporary, database);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
  assertIntegrity(database);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values.push(value);
  }
  return values;
}

export function parseNoOrgOverrides(args: string[]): Record<string, { reason: string }> | undefined {
  const teamNames = options(args, '--intentionally-no-org');
  if (teamNames.length === 0) return undefined;
  const reason = option(args, '--no-org-reason');
  if (!reason?.trim()) {
    throw new Error('--intentionally-no-org requires --no-org-reason <audit reason>');
  }
  const overrides: Record<string, { reason: string }> = {};
  for (const rawName of teamNames) {
    const teamName = rawName.trim();
    if (!teamName) throw new Error('--intentionally-no-org team name must not be empty');
    if (overrides[teamName]) throw new Error(`duplicate --intentionally-no-org team: ${teamName}`);
    overrides[teamName] = { reason: reason.trim() };
  }
  return overrides;
}

async function main(args: string[]): Promise<void> {
  const databasePath = option(args, '--database');
  if (!databasePath) throw new Error('--database <absolute path> is required');
  const decidedBy = option(args, '--decided-by') ?? 'org-backfill-cli';
  const allowLiveDatabase = args.includes('--allow-live-database');
  const noOrgOverrides = parseNoOrgOverrides(args);
  if (args.includes('--dry-run')) {
    const report = await dryRunOrgBackfill({
      databasePath,
      auditOutputPath: option(args, '--audit-output'),
      decidedBy,
      allowLiveDatabase,
      noOrgOverrides,
      acknowledgeSourceDrift: args.includes('--acknowledge-source-drift'),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (args.includes('--restore')) {
    const rollbackPath = option(args, '--rollback');
    const expectedCurrentSha256 = option(args, '--expected-current-sha256');
    if (!rollbackPath || !expectedCurrentSha256) {
      throw new Error('--restore requires --rollback and --expected-current-sha256');
    }
    await restoreOrgBackfillSnapshot({
      databasePath,
      rollbackPath,
      expectedCurrentSha256,
      allowLiveDatabase,
      confirmLiveProcessesStopped: args.includes('--confirm-live-processes-stopped'),
    });
    return;
  }
  if (!args.includes('--apply')) throw new Error('choose exactly one of --dry-run, --apply, or --restore');
  const rollbackPath = option(args, '--rollback');
  const auditOutputPath = option(args, '--audit-output');
  if (!rollbackPath || !auditOutputPath) {
    throw new Error('--apply requires --rollback and --audit-output absolute paths');
  }
  const result = await applyOrgBackfill({
    databasePath,
    rollbackPath,
    auditOutputPath,
    decidedBy,
    allowLiveDatabase,
    noOrgOverrides,
    acknowledgeSourceDrift: args.includes('--acknowledge-source-drift'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
