// SPDX-License-Identifier: MIT

import Database from 'better-sqlite3';
import { DbAdapter, QueryResult } from './db-adapter.js';

export class SqliteAdapter implements DbAdapter {
  readonly dialect = 'sqlite' as const;
  private db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
  }

  /**
   * Normalise Postgres-style positional params ($1, $2, …) to SQLite-style (?)
   * so that the same SQL can be used across both adapters.
   * Named params that are NOT numeric (e.g. $name) are left untouched.
   */
  private normaliseSql(sql: string): string {
    return sql.replace(/\$(\d+)/g, '?');
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const normSql = this.normaliseSql(sql);
    const stmt = this.db.prepare(normSql);

    if (/^\s*(SELECT|WITH)\b/i.test(normSql) || /\bRETURNING\b/i.test(normSql)) {
      const rows = stmt.all(...params) as T[];
      return { rows, rowCount: rows.length };
    }

    const info = stmt.run(...params);
    return { rows: [] as T[], rowCount: info.changes };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  async transaction<T>(callback: (tx: DbAdapter) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}
