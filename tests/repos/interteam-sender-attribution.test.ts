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

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('inter-team origin sender attribution', () => {
  it('keeps per-turn ID and send-time name while another teammate collects', async () => {
    const db = new SqliteAdapter(':memory:');
    adapters.push(db);
    await migrateSqlite(db);
    const nodeId = (await q<{ node_id: string }>(db, `SELECT node_id FROM manager_identity`))[0].node_id;
    const originTeamId = randomUUID();
    const destinationTeamId = randomUUID();
    const firstAgentId = `origin-first-${randomUUID()}`;
    const secondAgentId = `origin-second-${randomUUID()}`;
    const destinationAgentId = `destination-${randomUUID()}`;
    await db.query(`INSERT INTO teams (id, name) VALUES (?, 'origin')`, [originTeamId]);
    await db.query(`INSERT INTO teams (id, name, inbound_policy) VALUES (?, 'destination', 'open')`, [destinationTeamId]);
    await addAgent(db, originTeamId, firstAgentId, 'first-sender');
    await addAgent(db, originTeamId, secondAgentId, 'second-sender');
    await addAgent(db, destinationTeamId, destinationAgentId, 'receiver');
    await new InterteamFoundationStore(db).createContact({
      localTeamId: originTeamId,
      aliasDisplay: 'partners',
      remoteNodeId: nodeId,
      remoteTeamId: destinationTeamId,
      now: 1,
    });

    const client = new InterTeamOriginClient(db, new InterTeamAcceptanceService(db));
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
    expect(await q<{ claimed_sender_name: string | null }>(
      db,
      `SELECT claimed_sender_name FROM interteam_messages WHERE message_id = ?`,
      [first.messageId],
    )).toEqual([{ claimed_sender_name: 'first-sender' }]);

    await db.query(`UPDATE agents SET name = 'renamed-after-send' WHERE id = ?`, [firstAgentId]);
    await db.query(`DELETE FROM agents WHERE id = ?`, [firstAgentId]);

    const next = await client.continueConversation({
      context: secondContext,
      conversationId: first.conversationId,
      body: { turn: 2 },
      now: 20,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(await q<{ claimed_sender_name: string | null }>(
      db,
      `SELECT claimed_sender_name FROM interteam_messages WHERE message_id = ?`,
      [next.messageId],
    )).toEqual([{ claimed_sender_name: 'second-sender' }]);

    await expect(client.collect({
      context: secondContext,
      conversationId: first.conversationId,
      messageId: first.messageId,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        sender: { agentId: firstAgentId, nameAtSend: 'first-sender' },
      },
    });

    const listed = await client.listConversations({ context: secondContext });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.conversations[0].latestMessage?.sender).toEqual({
      agentId: secondAgentId,
      nameAtSend: 'second-sender',
    });
  });

  it('records admin null and never rewrites first attribution on teammate deduplication', async () => {
    const db = new SqliteAdapter(':memory:');
    adapters.push(db);
    await migrateSqlite(db);
    const nodeId = (await q<{ node_id: string }>(db, `SELECT node_id FROM manager_identity`))[0].node_id;
    const originTeamId = randomUUID();
    const destinationTeamId = randomUUID();
    const firstAgentId = `first-${randomUUID()}`;
    const retryAgentId = `retry-${randomUUID()}`;
    const destinationAgentId = `dest-${randomUUID()}`;
    await db.query(`INSERT INTO teams (id, name) VALUES (?, 'origin')`, [originTeamId]);
    await db.query(`INSERT INTO teams (id, name, inbound_policy) VALUES (?, 'destination', 'open')`, [destinationTeamId]);
    await addAgent(db, originTeamId, firstAgentId, 'first');
    await addAgent(db, originTeamId, retryAgentId, 'retry');
    await addAgent(db, destinationTeamId, destinationAgentId, 'receiver');
    await new InterteamFoundationStore(db).createContact({
      localTeamId: originTeamId,
      aliasDisplay: 'partners',
      remoteNodeId: nodeId,
      remoteTeamId: destinationTeamId,
      now: 1,
    });

    const client = new InterTeamOriginClient(db, new InterTeamAcceptanceService(db));
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
    expect(await q<{ claimed_sender_name: string | null }>(
      db,
      `SELECT claimed_sender_name FROM interteam_messages WHERE message_id = ?`,
      [first.messageId],
    )).toEqual([{ claimed_sender_name: 'first' }]);
    const store = new InterteamMessageStore(db);
    await store.recordFailed({
      submitterNodeId: nodeId,
      messageId: first.messageId,
      failureCode: 'test_terminal',
      now: 12,
    });
    await store.runRetentionSweep({ now: 12 + INTERTEAM_DELETE_AFTER_MS, batchSize: 10 });
    await expect(client.collect({
      context: { localTeamId: originTeamId, principal: 'agent-header', agentId: retryAgentId },
      conversationId: first.conversationId,
      messageId: first.messageId,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        retention: 'receipt',
        sender: { agentId: firstAgentId, nameAtSend: 'first' },
      },
    });

    const admin = await client.send({
      context: { localTeamId: originTeamId, principal: 'operator', agentId: null },
      alias: 'partners', destination, body: 'admin', now: 20,
    });
    expect(admin.ok).toBe(true);
    if (!admin.ok) return;
    expect(await q<{ claimed_sender_name: string | null }>(
      db,
      `SELECT claimed_sender_name FROM interteam_messages WHERE message_id = ?`,
      [admin.messageId],
    )).toEqual([{ claimed_sender_name: null }]);
    await expect(client.collect({
      context: { localTeamId: originTeamId, principal: 'operator', agentId: null },
      conversationId: admin.conversationId,
      messageId: admin.messageId,
    })).resolves.toMatchObject({ ok: true, value: { sender: null } });

    const legacyIds = await store.allocateOriginIds(nodeId, 30);
    const legacy = await client.resubmit({
      context: { localTeamId: originTeamId, principal: 'agent-header', agentId: firstAgentId },
      envelope: {
        protocolVersion: '1.0',
        originNodeId: nodeId,
        originTeamId,
        destinationNodeId: nodeId,
        destinationTeamId,
        destination,
        conversationId: legacyIds.conversationId,
        messageId: legacyIds.messageId,
        position: 0,
        predecessorMessageId: null,
        firstSubmittedAt: 30,
        body: 'before-minor-upgrade',
      },
      now: 30,
    });
    expect(legacy.ok && legacy.protocolVersion).toBe('1.0');
    const afterUpgrade = await client.resubmitSend({
      context: { localTeamId: originTeamId, principal: 'agent-header', agentId: retryAgentId },
      alias: 'partners',
      destination,
      body: 'before-minor-upgrade',
      conversationId: legacyIds.conversationId,
      messageId: legacyIds.messageId,
      protocolVersion: '1.0',
      firstSubmittedAt: 30,
      now: 31,
    });
    expect(afterUpgrade.ok && afterUpgrade.outcome.kind).toBe('deduplicated');
  });

  it('adds the origin-submission schema idempotently on a disposable Phase B/C copy', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interteam-attribution-migration-'));
    temporaryRoots.push(root);
    const phasePath = path.join(root, 'phase-bc.db');
    const upgradePath = path.join(root, 'upgrade.db');
    const phase = new SqliteAdapter(phasePath);
    await migrateSqlite(phase);
    await phase.query(`DROP TABLE interteam_origin_submissions`);
    await phase.query(`ALTER TABLE interteam_messages DROP COLUMN claimed_sender_name`);
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
    expect(await q<{ name: string }>(
      upgraded,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'interteam_origin_submissions'`,
    )).toEqual([{ name: 'interteam_origin_submissions' }]);
    expect((await q<{ name: string }>(
      upgraded,
      `SELECT name FROM pragma_table_info('interteam_messages')`,
    )).map((row) => row.name)).toContain('claimed_sender_name');
    expect(await q<{ allocated_id: string }>(
      upgraded,
      `SELECT allocated_id FROM interteam_origin_allocations WHERE allocated_id = 'sentinel'`,
    )).toEqual([{ allocated_id: 'sentinel' }]);
  });
});
