// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { DbAdapter } from '../../src/db/db-adapter.js';
import { PgAdapter } from '../../src/db/pg-adapter.js';
import { migratePostgres } from '../../src/db/migrations/postgres.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { InterTeamAcceptanceService } from '../../src/inter-team/acceptance-service.js';
import { InterteamFoundationStore } from '../../src/inter-team/foundation-store.js';
import {
  INTERTEAM_DELETE_AFTER_MS,
  InterteamMessageStore,
} from '../../src/inter-team/message-store.js';
import { InterTeamOriginClient } from '../../src/inter-team/origin-client.js';
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

describe.each(dialects)('interteam conversation list parity (%s)', (dialect) => {
  let db: DbAdapter;
  let store: InterteamMessageStore;
  let client: InterTeamOriginClient;
  let localNodeId: string;
  let originTeamId: string;
  let destinationTeamId: string;
  let otherOriginTeamId: string;

  const context = (localTeamId: string) => ({
    localTeamId,
    principal: 'agent-header' as const,
    agentId: null,
  });

  const envelope = (input: {
    conversationId: string;
    messageId: string;
    originTeamId?: string;
    originNodeId?: string;
    destination?: Destination;
    body: unknown;
  }): InterTeamRequestEnvelope => ({
    protocolVersion: INTER_TEAM_PROTOCOL_VERSION,
    originNodeId: input.originNodeId ?? localNodeId,
    originTeamId: input.originTeamId ?? originTeamId,
    destinationNodeId: localNodeId,
    destinationTeamId,
    destination: input.destination ?? { kind: 'team' },
    conversationId: input.conversationId,
    messageId: input.messageId,
    position: 0,
    predecessorMessageId: null,
    firstSubmittedAt: 1,
    body: input.body,
  });

  beforeEach(async () => {
    db = await freshAdapter(dialect);
    store = new InterteamMessageStore(db);
    const acceptance = new InterTeamAcceptanceService(db);
    client = new InterTeamOriginClient(db, acceptance);
    localNodeId = (await q<{ node_id: string }>(db, `SELECT node_id FROM manager_identity`))[0].node_id;
    originTeamId = randomUUID();
    destinationTeamId = randomUUID();
    otherOriginTeamId = randomUUID();
    await q(db, `INSERT INTO teams (id, name) VALUES (?, ?)`, [originTeamId, `origin-${randomUUID()}`]);
    await q(db, `INSERT INTO teams (id, name) VALUES (?, ?)`, [destinationTeamId, `dest-${randomUUID()}`]);
    await q(db, `INSERT INTO teams (id, name) VALUES (?, ?)`, [otherOriginTeamId, `other-${randomUUID()}`]);
    await new InterteamFoundationStore(db).createContact({
      localTeamId: originTeamId,
      aliasDisplay: 'Partners',
      remoteNodeId: localNodeId,
      remoteTeamId: destinationTeamId,
      now: 1,
    });

    await store.acceptRequest({
      envelope: envelope({
        conversationId: 'conversation-outstanding',
        messageId: 'message-outstanding',
        body: { secret: 'outstanding-body-must-not-leak' },
      }),
      now: 10,
    });
    await store.acceptRequest({
      envelope: envelope({
        conversationId: 'conversation-terminal',
        messageId: 'message-terminal',
        destination: { kind: 'agent_name', agentName: 'reviewer' },
        body: { secret: 'terminal-body-must-not-leak' },
      }),
      resolvedAgentId: 'pinned-reviewer-id',
      now: 30,
    });
    await store.recordFailed({
      submitterNodeId: localNodeId,
      messageId: 'message-terminal',
      failureCode: 'handler_failed',
      now: 40,
    });
    await store.acceptRequest({
      envelope: envelope({
        conversationId: 'conversation-other-team',
        messageId: 'message-other-team',
        originTeamId: otherOriginTeamId,
        body: 'other-team-body',
      }),
      now: 50,
    });
    await store.acceptRequest({
      envelope: envelope({
        conversationId: 'conversation-other-node',
        messageId: 'message-other-node',
        originNodeId: `node-${randomUUID()}`,
        body: 'other-node-body',
      }),
      now: 60,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('returns only the trusted origin team, with destination pins and no bodies', async () => {
    const result = await client.listConversations({ context: context(originTeamId) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.conversations.map((row) => row.conversationId)).toEqual([
      'conversation-terminal',
      'conversation-outstanding',
    ]);
    expect(result.value.conversations[0]).toMatchObject({
      destination: {
        kind: 'agent_name',
        nodeId: localNodeId,
        teamId: destinationTeamId,
        alias: 'Partners',
        pinnedAgentId: 'pinned-reviewer-id',
        nameAtAcceptance: 'reviewer',
      },
      latestMessage: {
        messageId: 'message-terminal',
        state: 'failed',
        lastConfirmedState: 'failed',
        retention: 'retained',
        acceptedAt: 30,
        updatedAt: 40,
        terminalAt: 40,
      },
      createdAt: 30,
      updatedAt: 30,
    });
    const encoded = JSON.stringify(result.value);
    expect(encoded).not.toContain('outstanding-body-must-not-leak');
    expect(encoded).not.toContain('terminal-body-must-not-leak');
    expect(encoded).not.toContain('handler_failed');

    await expect(client.listConversations({ context: context(destinationTeamId) }))
      .resolves.toEqual({ ok: true, value: { conversations: [] } });
    const otherTeam = await client.listConversations({ context: context(otherOriginTeamId) });
    expect(otherTeam.ok && otherTeam.value.conversations.map((row) => row.conversationId))
      .toEqual(['conversation-other-team']);
  });

  it('filters over the latest message state, including receipt-backed terminal state', async () => {
    const outstanding = await client.listConversations({
      context: context(originTeamId),
      state: 'outstanding',
    });
    expect(outstanding.ok && outstanding.value.conversations.map((row) => row.conversationId))
      .toEqual(['conversation-outstanding']);

    await store.runRetentionSweep({ now: 40 + INTERTEAM_DELETE_AFTER_MS, batchSize: 10 });
    const terminal = await client.listConversations({
      context: context(originTeamId),
      state: 'terminal',
    });
    expect(terminal.ok).toBe(true);
    if (!terminal.ok) return;
    expect(terminal.value.conversations).toHaveLength(1);
    expect(terminal.value.conversations[0].latestMessage).toMatchObject({
      messageId: 'message-terminal',
      state: 'failed',
      lastConfirmedState: 'failed',
      retention: 'receipt',
      acceptedAt: null,
      updatedAt: 40,
      terminalAt: 40,
    });
  });

  it('fails the whole selected read at the count cap instead of truncating', async () => {
    const bounded = new InterTeamOriginClient(db, new InterTeamAcceptanceService(db), {
      conversationListBounds: { maxConversations: 1, maxEncodedBytes: 256 * 1024 },
    });
    await expect(bounded.listConversations({ context: context(originTeamId) }))
      .resolves.toEqual({ ok: false, code: 'read_response_too_large' });
    const outstanding = await bounded.listConversations({
      context: context(originTeamId),
      state: 'outstanding',
    });
    expect(outstanding.ok && outstanding.value.conversations).toHaveLength(1);
  });

  it('fails the whole selected read at the encoded-size cap', async () => {
    const bounded = new InterTeamOriginClient(db, new InterTeamAcceptanceService(db), {
      conversationListBounds: { maxConversations: 10, maxEncodedBytes: 1 },
    });
    await expect(bounded.listConversations({
      context: context(originTeamId),
      state: 'terminal',
    })).resolves.toEqual({ ok: false, code: 'read_response_too_large' });
  });
});
