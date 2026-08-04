// SPDX-License-Identifier: MIT

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export interface DbAdapter {
  readonly dialect: 'postgres' | 'sqlite';
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run all callback queries on one database transaction/connection. */
  transaction?<T>(callback: (tx: DbAdapter) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
