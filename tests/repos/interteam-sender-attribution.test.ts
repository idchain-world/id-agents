// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { InterTeamAcceptanceService } from '../../src/inter-team/acceptance-service.js';
import { InterteamFoundationStore } from '../../src/inter-team/foundation-store.js';
import {
  INTERTEAM_COMPACT_AFTER_MS,
  INTERTEAM_DELETE_AFTER_MS,
  InterteamMessageStore,
} from '../../src/inter-team/message-store.js';
import { InterTeamOriginClient } from '../../src/inter-team/origin-client.js';

const temporaryRoots: string[] = [];
const adapters: SqliteAdapter[] = [];

async function q<T = unknown>(db: SqliteAdapter, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function addAgent(db: SqliteAdapter, teamId: string, id: string, name: string): Promise<void> {
  await db.query(
    `INSERT INTO agents
       (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
     VALUES (?, ?, ?, 'claude', 'model', 0, 'running', 1, '{}', 'codex')`,
    [id, teamId, name],
  );
}

async function fixture(): Promise<{
  db: SqliteAdapter;
  nodeId: string;
  originTeamId: string;
  destinationTeamId: string;
  destinationAgentId: string;
  client: InterTeamOriginClient;
}> {
  const db = new SqliteAdapter(':memory:');
  adapters.push(db);
  await migrateSqlite(db);
  const nodeId = (await q<{ node_id: string }>(db, `SELECT node_id FROM manager_identity`))[0].node_id;
  const originTeamId = randomUUID();
  const destinationTeamId = randomUUID();
  const destinationAgentId = `destination-${randomUUID()}`;
  await db.query(`INSERT INTO teams (id, name) VALUES (?, 'origin')`, [originTeamId]);
  await db.query(
    `INSERT INTO teams (id, name, inbound_policy) VALUES (?, 'destination', 'open')`,
    [destinationTeamId],
  );
  await addAgent(db, destinationTeamId, destinationAgentId, 'receiver');
  await new InterteamFoundationStore(db).createContact({
    localTeamId: originTeamId,
    aliasDisplay: 'partners',
    remoteNodeId: nodeId,
    remoteTeamId: destinationTeamId,
    now: 1,
  });
  return {
    db,
    nodeId,
    originTeamId,
    destinationTeamId,
    destinationAgentId,
    client: new InterTeamOriginClient(db, new InterTeamAcceptanceService(db)),
  };
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('inter-team origin sender attribution', () => {
  it('freezes each sender ID and name locally while another teammate collects', async () => {
    const { db, nodeId, originTeamId, destinationAgentId, client } = await fixture();
    const firstAgentId = `origin-first-${randomUUID()}`;
    const secondAgentId = `origin-second-${randomUUID()}`;
    await addAgent(db, originTeamId, firstAgentId, 'first-sender');
    await addAgent(db, originTeamId, secondAgentId, 'second-sender');
    const firstContext = { localTeamId: originTeamId, principal: 'agent-header' as const, agentId: firstAgentId };
    const secondContext = { localTeamId: originTeamId, principal: 'agent-header' as const, agentId: secondAgentId };
    const destination = { kind: 'agent_id' as const, agentId: destinationAgentId };

    const first = await client.send({
      context: firstContext,
      alias: 'partners',
      destination,
      body: { turn: 1 },
      now: 10,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await q(db, `SELECT * FROM interteam_origin_submissions WHERE message_id = ?`, [first.messageId]))
      .toEqual([{
        node_id: nodeId,
        message_id: first.messageId,
        sender_agent_id: firstAgentId,
        sender_name_at_send: 'first-sender',
        created_at: 10,
      }]);

    await db.query(`UPDATE agents SET name = 'renamed-after-send' WHERE id = ?`, [firstAgentId]);
    await db.query(`DELETE FROM agents WHERE id = ?`, [firstAgentId]);
    expect(await q<{ sender_name_at_send: string }>(
      db,
      `SELECT sender_name_at_send FROM interteam_origin_submissions WHERE message_id = ?`,
      [first.messageId],
    )).toEqual([{ sender_name_at_send: 'first-sender' }]);

    const next = await client.continueConversation({
      context: secondContext,
      conversationId: first.conversationId,
      body: { turn: 2 },
      now: 20,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(await q<{ message_id: string; sender_agent_id: string; sender_name_at_send: string }>(
      db,
      `SELECT message_id, sender_agent_id, sender_name_at_send
       FROM interteam_origin_submissions ORDER BY created_at`,
    )).toEqual([
      { message_id: first.messageId, sender_agent_id: firstAgentId, sender_name_at_send: 'first-sender' },
      { message_id: next.messageId, sender_agent_id: secondAgentId, sender_name_at_send: 'second-sender' },
    ]);

    const collected = await client.collect({
      context: secondContext,
      conversationId: first.conversationId,
      messageId: first.messageId,
    });
    expect(collected.ok).toBe(true);
    if (collected.ok) expect(collected.value).not.toHaveProperty('sender');

    const listed = await client.listConversations({ context: secondContext });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.conversations[0].latestMessage?.sender).toEqual({
      agentId: secondAgentId,
      nameAtSend: 'second-sender',
    });
    expect(JSON.stringify(listed.value).match(/second-sender/g)).toHaveLength(1);
    expect(JSON.stringify(listed.value)).not.toContain('first-sender');
  });

  it('records operator null, leaves legacy gaps null, and never rewrites on teammate retry', async () => {
    const { db, originTeamId, destinationAgentId, client } = await fixture();
    const firstAgentId = `first-${randomUUID()}`;
    const retryAgentId = `retry-${randomUUID()}`;
    await addAgent(db, originTeamId, firstAgentId, 'first');
    await addAgent(db, originTeamId, retryAgentId, 'retry');
    const destination = { kind: 'agent_id' as const, agentId: destinationAgentId };

    const first = await client.send({
      context: { localTeamId: originTeamId, principal: 'agent-header', agentId: firstAgentId },
      alias: 'partners', destination, body: 'same-body', now: 10,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = await client.resubmitSend({
      context: { localTeamId: originTeamId, principal: 'agent-header', agentId: retryAgentId },
      alias: 'partners',
      destination,
      body: 'same-body',
      conversationId: first.conversationId,
      messageId: first.messageId,
      firstSubmittedAt: first.firstSubmittedAt,
      now: 11,
    });
    expect(replay.ok && replay.outcome.kind).toBe('deduplicated');
    expect(await q<{ sender_agent_id: string | null; sender_name_at_send: string | null }>(
      db,
      `SELECT sender_agent_id, sender_name_at_send
       FROM interteam_origin_submissions WHERE message_id = ?`,
      [first.messageId],
    )).toEqual([{ sender_agent_id: firstAgentId, sender_name_at_send: 'first' }]);

    const admin = await client.send({
      context: { localTeamId: originTeamId, principal: 'operator', agentId: null },
      alias: 'partners', destination, body: 'admin', now: 20,
    });
    expect(admin.ok).toBe(true);
    if (!admin.ok) return;
    expect(await q<{ sender_agent_id: string | null; sender_name_at_send: string | null }>(
      db,
      `SELECT sender_agent_id, sender_name_at_send
       FROM interteam_origin_submissions WHERE message_id = ?`,
      [admin.messageId],
    )).toEqual([{ sender_agent_id: null, sender_name_at_send: null }]);
    let listed = await client.listConversations({
      context: { localTeamId: originTeamId, principal: 'operator', agentId: null },
    });
    expect(listed.ok && listed.value.conversations[0].latestMessage?.sender).toBeNull();

    await db.query(`DELETE FROM interteam_origin_submissions WHERE message_id = ?`, [admin.messageId]);
    listed = await client.listConversations({
      context: { localTeamId: originTeamId, principal: 'operator', agentId: null },
    });
    expect(listed.ok && listed.value.conversations[0].latestMessage?.sender).toBeNull();
  });

  it('preserves attribution through compaction and removes it with message deletion', async () => {
    const { db, nodeId, originTeamId, destinationAgentId, client } = await fixture();
    const senderAgentId = `sender-${randomUUID()}`;
    await addAgent(db, originTeamId, senderAgentId, 'sender');
    const sent = await client.send({
      context: { localTeamId: originTeamId, principal: 'agent-header', agentId: senderAgentId },
      alias: 'partners',
      destination: { kind: 'agent_id', agentId: destinationAgentId },
      body: 'retention',
      now: 10,
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const store = new InterteamMessageStore(db);
    await store.recordFailed({
      submitterNodeId: nodeId,
      messageId: sent.messageId,
      failureCode: 'test_terminal',
      now: 20,
    });

    await store.runRetentionSweep({ now: 20 + INTERTEAM_COMPACT_AFTER_MS, batchSize: 10 });
    expect(await q<{ message_id: string }>(
      db,
      `SELECT message_id FROM interteam_origin_submissions WHERE message_id = ?`,
      [sent.messageId],
    )).toEqual([{ message_id: sent.messageId }]);
    let listed = await client.listConversations({
      context: { localTeamId: originTeamId, principal: 'agent-header', agentId: senderAgentId },
    });
    expect(listed.ok && listed.value.conversations[0].latestMessage?.retention).toBe('compacted');
    expect(listed.ok && listed.value.conversations[0].latestMessage?.sender)
      .toEqual({ agentId: senderAgentId, nameAtSend: 'sender' });

    await store.runRetentionSweep({ now: 20 + INTERTEAM_DELETE_AFTER_MS, batchSize: 10 });
    expect(await q(db, `SELECT * FROM interteam_origin_submissions WHERE message_id = ?`, [sent.messageId]))
      .toEqual([]);
    listed = await client.listConversations({
      context: { localTeamId: originTeamId, principal: 'agent-header', agentId: senderAgentId },
    });
    expect(listed.ok && listed.value.conversations[0].latestMessage?.retention).toBe('receipt');
    expect(listed.ok && listed.value.conversations[0].latestMessage?.sender).toBeNull();
  });

  it('adds the origin-submission table idempotently on a disposable Phase B/C copy', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interteam-attribution-migration-'));
    temporaryRoots.push(root);
    const phasePath = path.join(root, 'phase-bc.db');
    const upgradePath = path.join(root, 'upgrade.db');
    const phase = new SqliteAdapter(phasePath);
    await migrateSqlite(phase);
    await phase.query(`DROP TABLE interteam_origin_submissions`);
    await phase.query(
      `INSERT INTO interteam_origin_allocations (node_id, id_kind, allocated_id, created_at)
       VALUES ('node', 'message', 'sentinel', 1)`,
    );
    await phase.close();
    fs.copyFileSync(phasePath, upgradePath);

    const upgraded = new SqliteAdapter(upgradePath);
    adapters.push(upgraded);
    await migrateSqlite(upgraded);
    await migrateSqlite(upgraded);
    expect((await q<{ name: string }>(
      upgraded,
      `SELECT name FROM pragma_table_info('interteam_origin_submissions') ORDER BY cid`,
    )).map((row) => row.name)).toEqual([
      'node_id', 'message_id', 'sender_agent_id', 'sender_name_at_send', 'created_at',
    ]);
    expect(await q<{ allocated_id: string }>(
      upgraded,
      `SELECT allocated_id FROM interteam_origin_allocations WHERE allocated_id = 'sentinel'`,
    )).toEqual([{ allocated_id: 'sentinel' }]);
  });
});
