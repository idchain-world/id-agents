// SPDX-License-Identifier: MIT

import { Pool, type PoolClient } from 'pg';
import { DbAdapter, QueryResult } from './db-adapter.js';

export class PgAdapter implements DbAdapter {
  readonly dialect = 'postgres' as const;

  constructor(private pool: Pool) {}

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async transaction<T>(callback: (tx: DbAdapter) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx = new PgTransactionAdapter(client);
    try {
      await client.query('BEGIN');
      const result = await callback(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PgTransactionAdapter implements DbAdapter {
  readonly dialect = 'postgres' as const;

  constructor(private readonly client: PoolClient) {}

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.client.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async transaction<T>(callback: (tx: DbAdapter) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async close(): Promise<void> {
    throw new Error('cannot close a transaction-scoped adapter');
  }
}
