// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { DbAdapter } from '../../src/db/db-adapter.js';
import { PgAdapter } from '../../src/db/pg-adapter.js';
import { migratePostgres } from '../../src/db/migrations/postgres.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import {
  INTERTEAM_COMPACT_AFTER_MS,
  INTERTEAM_DELETE_AFTER_MS,
  InterteamMessageStore,
  OWNER_FORCE_DELETED,
} from '../../src/inter-team/message-store.js';
import {
  INTER_TEAM_PROTOCOL_VERSION,
  type Destination,
  type InterTeamRequestEnvelope,
} from '../../src/inter-team/protocol.js';

const postgresUrl = process.env.TEST_ORG_POSTGRES_URL;
const dialects: Array<'sqlite' | 'postgres'> = postgresUrl ? ['sqlite', 'postgres'] : ['sqlite'];

function sql(db: DbAdapter, text: string): string {
  if (db.dialect === 'sqlite') return text;
  let index = 0;
  return text.replace(/\?/g, () => `$${++index}`);
}

async function q<T = unknown>(db: DbAdapter, text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql(db, text), params)).rows;
}

async function freshAdapter(dialect: 'sqlite' | 'postgres'): Promise<DbAdapter> {
  if (dialect === 'sqlite') {
    const db = new SqliteAdapter(':memory:');
    await migrateSqlite(db);
    return db;
  }
  if (!postgresUrl || !postgresUrl.includes('org_test')) {
    throw new Error('TEST_ORG_POSTGRES_URL must name a disposable database containing org_test');
  }
  const db = new PgAdapter(new Pool({ connectionString: postgresUrl }));
  await db.query(`DROP SCHEMA public CASCADE`);
  await db.query(`CREATE SCHEMA public`);
  await migratePostgres(db);
  return db;
}

describe.each(dialects)('interteam message store parity (%s)', (dialect) => {
  let db: DbAdapter;
  let store: InterteamMessageStore;
  let destinationTeamId: string;
  let otherTeamId: string;
  let handlerAgentId: string;
  let directAgentId: string;
  const originNodeId = 'origin-node-opaque';
  const destinationNodeId = 'destination-node-opaque';
  const originTeamId = 'origin-team-opaque';

  const envelope = (input: {
    conversationId?: string;
    messageId?: string;
    position?: number;
    predecessorMessageId?: string | null;
    destination?: Destination;
    destinationTeam?: string;
    body?: unknown;
  } = {}): InterTeamRequestEnvelope => ({
    protocolVersion: INTER_TEAM_PROTOCOL_VERSION,
    originNodeId,
    originTeamId,
    destinationNodeId,
    destinationTeamId: input.destinationTeam ?? destinationTeamId,
    destination: input.destination ?? { kind: 'team' },
    conversationId: input.conversationId ?? 'conversation-1',
    messageId: input.messageId ?? 'message-1',
    position: input.position ?? 0,
    predecessorMessageId: input.predecessorMessageId ?? null,
    firstSubmittedAt: 1,
    body: input.body ?? { task: 'work' },
  });

  async function createDurableQuery(queryId = 'query-1'): Promise<void> {
    await q(
      db,
      `INSERT INTO queries
         (team_id, agent_id, query_id, status, prompt, created, owner_kind, owner_id)
       VALUES (?, ?, ?, 'processing', 'payload copy', 1, 'agent', ?)`,
      [destinationTeamId, handlerAgentId, queryId, handlerAgentId],
    );
  }

  async function processAndComplete(messageId = 'message-1', terminalAt = 1_000): Promise<void> {
    const queryId = `query-${messageId}`;
    await createDurableQuery(queryId);
    await store.recordProcessing({
      submitterNodeId: originNodeId,
      messageId,
      localTeamId: destinationTeamId,
      localQueryId: queryId,
      handlerAgentId,
      now: terminalAt - 1,
    });
    await store.recordCompleted({
      submitterNodeId: originNodeId,
      messageId,
      result: { answer: 42 },
      now: terminalAt,
    });
  }

  beforeEach(async () => {
    db = await freshAdapter(dialect);
    store = new InterteamMessageStore(db);
    destinationTeamId = randomUUID();
    otherTeamId = randomUUID();
    handlerAgentId = `handler-${randomUUID()}`;
    directAgentId = `direct-${randomUUID()}`;
    await q(db, `INSERT INTO teams (id, name) VALUES (?, ?)`, [destinationTeamId, `dest-${randomUUID()}`]);
    await q(db, `INSERT INTO teams (id, name) VALUES (?, ?)`, [otherTeamId, `other-${randomUUID()}`]);
    for (const [id, name] of [[handlerAgentId, 'handler'], [directAgentId, 'direct']]) {
      await q(
        db,
        `INSERT INTO agents
           (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
         VALUES (?, ?, ?, 'claude', 'model', 0, 'running', 1, ?, 'codex')`,
        [id, destinationTeamId, name, dialect === 'sqlite' ? '{}' : {}],
      );
    }
  });

  afterEach(async () => {
    await db.close();
  });

  it('survives repository restart and distinguishes replay from changed content', async () => {
    const request = envelope();
    await expect(store.acceptRequest({ envelope: request, now: 10 })).resolves.toMatchObject({ kind: 'accepted' });
    store = new InterteamMessageStore(db);
    await expect(store.acceptRequest({ envelope: request, now: 11 })).resolves.toMatchObject({
      kind: 'deduplicated',
      status: 'accepted',
      retention: 'retained',
    });
    await expect(store.acceptRequest({
      envelope: { ...request, body: { task: 'changed' } },
      now: 12,
    })).resolves.toEqual({ kind: 'error', code: 'idempotency_conflict' });
    expect(Number((await q<{ count: number | string }>(db, `SELECT COUNT(*) AS count FROM interteam_messages`))[0].count)).toBe(1);
  });

  it('enforces participant binding and one gapless predecessor stream', async () => {
    await store.acceptRequest({ envelope: envelope(), now: 10 });
    await expect(store.acceptRequest({
      envelope: envelope({ messageId: 'gap', position: 2, predecessorMessageId: 'message-1' }),
    })).resolves.toEqual({ kind: 'error', code: 'conversation_order_conflict' });
    await expect(store.acceptRequest({
      envelope: envelope({ messageId: 'fork', position: 1, predecessorMessageId: 'other' }),
    })).resolves.toEqual({ kind: 'error', code: 'conversation_order_conflict' });
    await expect(store.acceptRequest({
      envelope: {
        ...envelope({ messageId: 'participant', position: 1, predecessorMessageId: 'message-1' }),
        originTeamId: 'different-origin-team',
      },
    })).resolves.toEqual({ kind: 'error', code: 'conversation_not_found' });
    await expect(store.acceptRequest({
      envelope: envelope({ messageId: 'message-2', position: 1, predecessorMessageId: 'message-1' }),
    })).resolves.toMatchObject({ kind: 'accepted' });
  });

  it('requires a durable one-to-one query link before processing and an explicit result', async () => {
    await store.acceptRequest({ envelope: envelope(), now: 10 });
    await expect(store.recordCompleted({
      submitterNodeId: originNodeId,
      messageId: 'message-1',
      result: null,
      now: 11,
    })).rejects.toThrow('interteam_transition_invalid');
    await expect(store.recordProcessing({
      submitterNodeId: originNodeId,
      messageId: 'message-1',
      localTeamId: destinationTeamId,
      localQueryId: 'missing-query',
      handlerAgentId,
    })).rejects.toThrow('durable_job_missing');
    await expect(q(
      db,
      `UPDATE interteam_messages SET status = 'processing', last_confirmed_status = 'processing'
       WHERE message_id = 'message-1'`,
    )).rejects.toThrow(/durable_job_missing|constraint/i);
    await expect(q(
      db,
      `UPDATE interteam_messages SET retention_tier = 'compacted'
       WHERE message_id = 'message-1'`,
    )).rejects.toThrow(/constraint/i);
    await createDurableQuery();
    await store.recordProcessing({
      submitterNodeId: originNodeId,
      messageId: 'message-1',
      localTeamId: destinationTeamId,
      localQueryId: 'query-1',
      handlerAgentId,
      now: 11,
    });
    await expect(store.recordCompleted({
      submitterNodeId: originNodeId,
      messageId: 'message-1',
      result: undefined,
      now: 12,
    })).rejects.toThrow('durable_result_required');
    await store.recordCompleted({
      submitterNodeId: originNodeId,
      messageId: 'message-1',
      result: null,
      now: 12,
    });
    await expect(store.collect({
      originNodeId,
      originTeamId,
      destinationTeamId,
      conversationId: 'conversation-1',
      messageId: 'message-1',
    })).resolves.toEqual({
      ok: true,
      value: {
        state: 'completed',
        lastConfirmedState: 'completed',
        retention: 'retained',
        result: null,
        resultPresent: true,
      },
    });
  });

  it('compacts terminal payloads and the linked query at 30 days without breaking replay', async () => {
    const request = envelope();
    await store.acceptRequest({ envelope: request, now: 10 });
    await processAndComplete('message-1', 1_000);
    const sweep = await store.runRetentionSweep({ now: 1_000 + INTERTEAM_COMPACT_AFTER_MS, batchSize: 10 });
    expect(sweep.compacted).toBe(1);
    expect(sweep.deleted).toBe(0);
    expect(Number((await q<{ count: number | string }>(db, `SELECT COUNT(*) AS count FROM queries WHERE query_id = 'query-message-1'`))[0].count)).toBe(0);
    expect((await q<{ request_body: unknown; result_payload: unknown; retention_tier: string }>(
      db,
      `SELECT request_body, result_payload, retention_tier FROM interteam_messages WHERE message_id = 'message-1'`,
    ))[0]).toMatchObject({ request_body: null, result_payload: null, retention_tier: 'compacted' });
    await expect(store.collect({
      originNodeId,
      originTeamId,
      destinationTeamId,
      conversationId: 'conversation-1',
      messageId: 'message-1',
    })).resolves.toMatchObject({
      ok: true,
      value: { state: 'completed', retention: 'compacted', resultPresent: false },
    });
    await expect(store.acceptRequest({ envelope: request })).resolves.toMatchObject({
      kind: 'deduplicated',
      retention: 'compacted',
    });
    await expect(store.acceptRequest({ envelope: { ...request, body: 'changed' } }))
      .resolves.toEqual({ kind: 'error', code: 'idempotency_conflict' });
  });

  it('deletes terminal messages at 365 days, retains receipts, and keeps the conversation usable', async () => {
    const first = envelope();
    await store.acceptRequest({ envelope: first, now: 10 });
    await processAndComplete('message-1', 1_000);
    const sweep = await store.runRetentionSweep({ now: 1_000 + INTERTEAM_DELETE_AFTER_MS, batchSize: 10 });
    expect(sweep.deleted).toBe(1);
    expect(Number((await q<{ count: number | string }>(db, `SELECT COUNT(*) AS count FROM interteam_messages`))[0].count)).toBe(0);
    expect(Number((await q<{ count: number | string }>(db, `SELECT COUNT(*) AS count FROM interteam_message_receipts`))[0].count)).toBe(1);
    await expect(store.collect({
      originNodeId,
      originTeamId,
      destinationTeamId,
      conversationId: 'conversation-1',
      messageId: 'message-1',
    })).resolves.toMatchObject({
      ok: true,
      value: { state: 'completed', retention: 'receipt', resultPresent: false },
    });
    await expect(store.acceptRequest({ envelope: first })).resolves.toMatchObject({
      kind: 'deduplicated',
      retention: 'receipt',
    });
    await expect(store.acceptRequest({ envelope: { ...first, body: 'changed' } }))
      .resolves.toEqual({ kind: 'error', code: 'idempotency_conflict' });
    await expect(store.acceptRequest({
      envelope: envelope({ messageId: 'message-2', position: 1, predecessorMessageId: 'message-1' }),
      now: 2_000,
    })).resolves.toMatchObject({ kind: 'accepted' });
  });

  it('never compacts or deletes accepted, processing, or unknown evidence', async () => {
    await store.acceptRequest({ envelope: envelope(), now: 1 });
    await store.acceptRequest({
      envelope: envelope({ conversationId: 'conversation-2', messageId: 'message-2' }),
      now: 1,
    });
    await store.markUnknown(originNodeId, 'message-2', 2);
    const sweep = await store.runRetentionSweep({ now: INTERTEAM_DELETE_AFTER_MS * 2, batchSize: 100 });
    expect(sweep).toMatchObject({ compacted: 0, deleted: 0 });
    expect((await q<{ status: string }>(db, `SELECT status FROM interteam_messages ORDER BY message_id`))
      .map((row) => row.status)).toEqual(['accepted', 'unknown']);
  });

  it('blocks ordinary team deletion, force-resolves with a dedicated code, and keeps audit/dedup history', async () => {
    const request = envelope();
    await store.acceptRequest({ envelope: request, now: 1 });
    await expect(q(db, `DELETE FROM teams WHERE id = ?`, [destinationTeamId]))
      .rejects.toThrow(/interteam_team_has_active_work|constraint/i);
    await expect(store.forceDeleteTeam(destinationTeamId, 100)).resolves.toBe(true);
    expect((await q<{ failure_code: string; status: string }>(
      db,
      `SELECT failure_code, status FROM interteam_messages WHERE message_id = 'message-1'`,
    ))[0]).toEqual({ failure_code: OWNER_FORCE_DELETED, status: 'failed' });
    await expect(store.collect({
      originNodeId,
      originTeamId,
      destinationTeamId,
      conversationId: 'conversation-1',
      messageId: 'message-1',
    })).resolves.toEqual({ ok: false, code: 'conversation_not_found' });
    await expect(store.acceptRequest({ envelope: request })).resolves.toMatchObject({
      kind: 'deduplicated',
      status: 'failed',
    });
  });

  it('also hides collection after a same-manager origin owner is force-deleted', async () => {
    const localNode = (await q<{ node_id: string }>(
      db,
      `SELECT node_id FROM manager_identity WHERE singleton_key = 1`,
    ))[0].node_id;
    const request = {
      ...envelope(),
      originNodeId: localNode,
      originTeamId: otherTeamId,
      conversationId: 'same-manager-conversation',
      messageId: 'same-manager-message',
    };
    await store.acceptRequest({ envelope: request, now: 1 });
    await store.forceDeleteTeam(otherTeamId, 100);
    await expect(store.collect({
      originNodeId: localNode,
      originTeamId: otherTeamId,
      destinationTeamId,
      conversationId: request.conversationId,
      messageId: request.messageId,
    })).resolves.toEqual({ ok: false, code: 'conversation_not_found' });
    await expect(store.acceptRequest({ envelope: request })).resolves.toMatchObject({
      kind: 'deduplicated',
      status: 'failed',
    });
  });

  it('does not cascade accepted history when the pinned direct agent is deleted', async () => {
    await store.acceptRequest({
      envelope: envelope({ destination: { kind: 'agent_id', agentId: directAgentId } }),
      resolvedAgentId: directAgentId,
      now: 1,
    });
    await q(db, `DELETE FROM agents WHERE id = ?`, [directAgentId]);
    expect(Number((await q<{ count: number | string }>(db, `SELECT COUNT(*) AS count FROM interteam_messages`))[0].count)).toBe(1);
    expect((await q<{ destination_agent_id: string }>(
      db,
      `SELECT destination_agent_id FROM interteam_conversations WHERE conversation_id = 'conversation-1'`,
    ))[0].destination_agent_id).toBe(directAgentId);
  });

  it('allocates origin IDs durably before use', async () => {
    const allocated = await store.allocateOriginIds(originNodeId, 1);
    store = new InterteamMessageStore(db);
    await expect(store.isOriginIdAllocated(originNodeId, 'conversation', allocated.conversationId)).resolves.toBe(true);
    await expect(store.isOriginIdAllocated(originNodeId, 'message', allocated.messageId)).resolves.toBe(true);
    expect(allocated.conversationId).not.toBe(allocated.messageId);
  });

  if (dialect === 'sqlite') {
    it('runs bounded incremental vacuum only after the actual pragma is initialized', async () => {
      expect((await store.runRetentionSweep()).incrementalVacuum).toBe(false);
      await store.initializeSqliteIncrementalVacuum();
      expect((await store.runRetentionSweep()).incrementalVacuum).toBe(true);
    });
  }
});
