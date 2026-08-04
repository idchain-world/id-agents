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
  noOrgOverrides?: Record<string, { reason: string }>;
  acknowledgeSourceDrift?: boolean;
}

export function liveDatabasePath(): string {
  return path.join(homedir(), '.id-agents', 'id-agents.db');
}

export function assertSafeDatabasePath(databasePath: string): string {
  if (!path.isAbsolute(databasePath)) throw new Error('database path must be absolute');
  if (!existsSync(databasePath)) throw new Error(`database does not exist: ${databasePath}`);
  const target = realpathSync(databasePath);
  const live = liveDatabasePath();
  const resolvedLive = existsSync(live) ? realpathSync(live) : path.resolve(live);
  if (target === resolvedLive) {
    throw new Error('refusing to open or mutate the live ~/.id-agents/id-agents.db');
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
  noOrgOverrides?: Record<string, { reason: string }>;
  acknowledgeSourceDrift?: boolean;
}): Promise<OrgBackfillReport> {
  const source = assertSafeDatabasePath(options.databasePath);
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'id-agents-org-dryrun-'));
  const tempDatabase = path.join(tempRoot, 'dryrun.db');
  try {
    copyFileSync(source, tempDatabase, fsConstants.COPYFILE_EXCL);
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
  const database = assertSafeDatabasePath(options.databasePath);
  if (!path.isAbsolute(options.rollbackPath) || !path.isAbsolute(options.auditOutputPath)) {
    throw new Error('rollback and audit output paths must be absolute');
  }
  if (existsSync(options.rollbackPath)) throw new Error(`rollback path already exists: ${options.rollbackPath}`);
  if (existsSync(options.auditOutputPath)) throw new Error(`audit output already exists: ${options.auditOutputPath}`);
  assertIntegrity(database);
  const beforeSha256 = fileSha256(database);
  copyFileSync(database, options.rollbackPath, fsConstants.COPYFILE_EXCL);
  assertIntegrity(options.rollbackPath);
  const report = await runOnDatabase(
    database,
    false,
    options.decidedBy,
    options.noOrgOverrides,
    options.acknowledgeSourceDrift,
  );
  assertIntegrity(database);
  const afterSha256 = fileSha256(database);
  writeFileSync(options.auditOutputPath, `${JSON.stringify({
    ...report,
    database,
    rollbackPath: options.rollbackPath,
    beforeSha256,
    afterSha256,
  }, null, 2)}\n`, { flag: 'wx' });
  return { report, beforeSha256, afterSha256 };
}

export function restoreOrgBackfillSnapshot(options: {
  databasePath: string;
  rollbackPath: string;
  expectedCurrentSha256: string;
}): void {
  const database = assertSafeDatabasePath(options.databasePath);
  const rollback = assertSafeDatabasePath(options.rollbackPath);
  if (fileSha256(database) !== options.expectedCurrentSha256) {
    throw new Error('refusing rollback: target database drifted after the audited backfill');
  }
  assertIntegrity(rollback);
  const temporary = `${database}.restore-${process.pid}-${Date.now()}`;
  try {
    copyFileSync(rollback, temporary, fsConstants.COPYFILE_EXCL);
    assertIntegrity(temporary);
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

async function main(args: string[]): Promise<void> {
  const databasePath = option(args, '--database');
  if (!databasePath) throw new Error('--database <absolute path> is required');
  const decidedBy = option(args, '--decided-by') ?? 'org-backfill-cli';
  if (args.includes('--dry-run')) {
    const report = await dryRunOrgBackfill({
      databasePath,
      auditOutputPath: option(args, '--audit-output'),
      decidedBy,
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
    restoreOrgBackfillSnapshot({ databasePath, rollbackPath, expectedCurrentSha256 });
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
