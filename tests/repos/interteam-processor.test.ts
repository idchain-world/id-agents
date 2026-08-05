// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbAdapter } from '../../src/db/db-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { InterTeamAcceptanceService } from '../../src/inter-team/acceptance-service.js';
import { InterTeamProcessor } from '../../src/inter-team/processor.js';
import { InterteamMessageStore } from '../../src/inter-team/message-store.js';
import type { InterTeamRequestEnvelope, Destination } from '../../src/inter-team/protocol.js';

async function q<T = unknown>(db: DbAdapter, text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(text, params)).rows;
}

describe('inter-team async processor (commit 9)', () => {
  let db: DbAdapter;
  let acceptance: InterTeamAcceptanceService;
  let processor: InterTeamProcessor;
  let store: InterteamMessageStore;
  let nodeId: string;
  let originTeam: string;
  let destTeam: string;
  let lead: string;
  let worker: string;
  let dispatched: Array<{ handlerAgentId: string; localQueryId: string; localTeamId: string }>;

  function envelope(overrides: Partial<InterTeamRequestEnvelope> & { destination?: Destination } = {}): InterTeamRequestEnvelope {
    return {
      protocolVersion: '1.0',
      originNodeId: nodeId,
      originTeamId: originTeam,
      destinationNodeId: nodeId,
      destinationTeamId: destTeam,
      destination: { kind: 'team' },
      conversationId: `conv-${randomUUID()}`,
      messageId: `msg-${randomUUID()}`,
      position: 0,
      predecessorMessageId: null,
      firstSubmittedAt: 1_000,
      body: { work: 'do it' },
      ...overrides,
    };
  }

  async function accept(e: InterTeamRequestEnvelope): Promise<void> {
    const outcome = await acceptance.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: e,
    });
    expect(outcome).toMatchObject({ kind: 'accepted' });
  }

  async function messageStatus(messageId: string): Promise<string> {
    return (await q<{ status: string }>(
      db, `SELECT status FROM interteam_messages WHERE message_id = ?`, [messageId],
    ))[0]!.status;
  }

  async function completeLinkedQuery(messageId: string, result: unknown): Promise<void> {
    const link = (await q<{ local_team_id: string; local_query_id: string }>(
      db,
      `SELECT p.local_team_id, p.local_query_id
       FROM interteam_processing p JOIN interteam_messages m ON m.id = p.message_pk
       WHERE m.message_id = ?`,
      [messageId],
    ))[0]!;
    await q(
      db,
      `UPDATE queries SET status = 'completed', completed = ?, result = ? WHERE team_id = ? AND query_id = ?`,
      [Date.now(), JSON.stringify(result), link.local_team_id, link.local_query_id],
    );
  }

  async function addAgent(teamId: string, name: string, status = 'running'): Promise<string> {
    const id = `agent-${randomUUID()}`;
    await q(
      db,
      `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
       VALUES (?, ?, ?, 'claude', 'model', 0, ?, ?, '{}', 'codex')`,
      [id, teamId, name, status, Date.now()],
    );
    return id;
  }

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    await migrateSqlite(db as any);
    dispatched = [];
    acceptance = new InterTeamAcceptanceService(db);
    processor = new InterTeamProcessor(db, {
      dispatchFn: async (input) => {
        dispatched.push(input);
      },
    });
    store = new InterteamMessageStore(db);
    nodeId = (await q<{ node_id: string }>(db, `SELECT node_id FROM manager_identity`))[0]!.node_id;
    originTeam = randomUUID();
    destTeam = randomUUID();
    await q(db, `INSERT INTO teams (id, name) VALUES (?, ?), (?, ?)`, [
      originTeam, `origin-${randomUUID()}`, destTeam, `dest-${randomUUID()}`,
    ]);
    await q(db, `UPDATE teams SET inbound_policy = 'open' WHERE id = ?`, [destTeam]);
    lead = await addAgent(destTeam, 'lead');
    worker = await addAgent(destTeam, 'worker');
    await q(db, `UPDATE teams SET lead_agent_id = ? WHERE id = ?`, [lead, destTeam]);
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates the durable job link before reporting processing, then completes on a durable result', async () => {
    const e = envelope({ destination: { kind: 'agent_id', agentId: worker } });
    await accept(e);

    const actions = await processor.scan();
    expect(actions).toEqual([{ messageId: e.messageId, action: 'dispatched' }]);
    expect(await messageStatus(e.messageId)).toBe('processing');
    expect(dispatched[0]).toMatchObject({ handlerAgentId: worker, localTeamId: destTeam });
    const jobs = await q(db, `SELECT query_id FROM queries WHERE agent_id = ?`, [worker]);
    expect(jobs).toHaveLength(1);

    await completeLinkedQuery(e.messageId, { answer: 42 });
    const second = await processor.scan();
    expect(second).toEqual([{ messageId: e.messageId, action: 'completed' }]);
    expect(await messageStatus(e.messageId)).toBe('completed');
  });

  it('leaves accepted work accepted while the target is stopped, and resumes when it returns', async () => {
    const e = envelope({ destination: { kind: 'agent_id', agentId: worker } });
    await accept(e);
    await q(db, `UPDATE agents SET status = 'stopped' WHERE id = ?`, [worker]);

    expect(await processor.scan()).toEqual([{ messageId: e.messageId, action: 'waiting_recipient' }]);
    expect(await messageStatus(e.messageId)).toBe('accepted');

    await q(db, `UPDATE agents SET status = 'running' WHERE id = ?`, [worker]);
    expect(await processor.scan()).toEqual([{ messageId: e.messageId, action: 'dispatched' }]);
  });

  it('re-links the same job on a same-ID restart instead of forking a second one', async () => {
    const e = envelope({ destination: { kind: 'agent_id', agentId: worker } });
    await accept(e);
    await processor.scan();

    const restarted = new InterTeamProcessor(db, { dispatchFn: async () => {} });
    await restarted.scan();
    expect(await q(db, `SELECT query_id FROM queries WHERE agent_id = ?`, [worker])).toHaveLength(1);
    expect(await messageStatus(e.messageId)).toBe('processing');

    await completeLinkedQuery(e.messageId, null);
    expect(await restarted.scan()).toEqual([{ messageId: e.messageId, action: 'completed' }]);
  });

  it('keeps a renamed handler working through its pinned ID', async () => {
    const e = envelope({ destination: { kind: 'agent_name', agentName: 'worker' } });
    await accept(e);
    await q(db, `UPDATE agents SET name = 'renamed' WHERE id = ?`, [worker]);
    expect(await processor.scan()).toEqual([{ messageId: e.messageId, action: 'dispatched' }]);
    expect(dispatched[0]!.handlerAgentId).toBe(worker);
  });

  it('fails bound direct work recipient_deleted, unlike team work which waits for a new lead', async () => {
    const direct = envelope({ destination: { kind: 'agent_id', agentId: worker } });
    const teamMsg = envelope({ destination: { kind: 'team' } });
    await accept(direct);
    await accept(teamMsg);

    await q(db, `UPDATE agents SET deleted_at = ? WHERE id = ?`, [Date.now(), worker]);
    await q(db, `UPDATE agents SET deleted_at = ? WHERE id = ?`, [Date.now(), lead]);

    const actions = await processor.scan();
    expect(actions).toContainEqual({ messageId: direct.messageId, action: 'failed_recipient_deleted' });
    expect(actions).toContainEqual({ messageId: teamMsg.messageId, action: 'waiting_recipient' });
    expect(await messageStatus(direct.messageId)).toBe('failed');
    expect((await q<{ failure_code: string }>(
      db, `SELECT failure_code FROM interteam_messages WHERE message_id = ?`, [direct.messageId],
    ))[0]!.failure_code).toBe('recipient_deleted');
    expect(await messageStatus(teamMsg.messageId)).toBe('accepted');

    const newLead = await addAgent(destTeam, 'new-lead');
    await q(db, `UPDATE teams SET lead_agent_id = ? WHERE id = ?`, [newLead, destTeam]);
    const pickup = await processor.scan();
    expect(pickup).toContainEqual({ messageId: teamMsg.messageId, action: 'dispatched' });
    expect(dispatched.at(-1)!.handlerAgentId).toBe(newLead);
  });

  it('processes each conversation request stream serially in position order', async () => {
    const first = envelope({ destination: { kind: 'agent_id', agentId: worker } });
    await accept(first);
    const second = envelope({
      conversationId: first.conversationId,
      destination: first.destination,
      position: 1,
      predecessorMessageId: first.messageId,
    });
    await accept(second);

    const actions = await processor.scan();
    expect(actions).toContainEqual({ messageId: first.messageId, action: 'dispatched' });
    expect(await messageStatus(second.messageId)).toBe('accepted');

    await completeLinkedQuery(first.messageId, 'done');
    const next = await processor.scan();
    expect(next).toContainEqual({ messageId: first.messageId, action: 'completed' });
    expect(next).toContainEqual({ messageId: second.messageId, action: 'dispatched' });
  });

  it('enters unknown only on lost durable evidence and leaves it only on durable evidence', async () => {
    const e = envelope({ destination: { kind: 'team' } });
    await accept(e);
    await processor.scan();

    const link = (await q<{ local_team_id: string; local_query_id: string }>(
      db,
      `SELECT p.local_team_id, p.local_query_id FROM interteam_processing p
       JOIN interteam_messages m ON m.id = p.message_pk WHERE m.message_id = ?`,
      [e.messageId],
    ))[0]!;
    await q(db, `DELETE FROM queries WHERE team_id = ? AND query_id = ?`, [link.local_team_id, link.local_query_id]);

    expect(await processor.scan()).toContainEqual({ messageId: e.messageId, action: 'marked_unknown' });
    expect(await messageStatus(e.messageId)).toBe('unknown');

    // No guessing while evidence is absent.
    expect(await processor.scan()).toEqual([]);

    await q(
      db,
      `INSERT INTO queries (team_id, query_id, agent_id, prompt, status, created, completed, result, owner_kind, owner_id)
       VALUES (?, ?, ?, 'null', 'completed', ?, ?, ?, 'agent', ?)`,
      [link.local_team_id, link.local_query_id, lead, Date.now(), Date.now(), JSON.stringify({ ok: true }), lead],
    );
    expect(await processor.scan()).toContainEqual({ messageId: e.messageId, action: 'recovered_unknown' });
    expect(await messageStatus(e.messageId)).toBe('completed');
  });

  it('records handler failure with a stable code', async () => {
    const e = envelope({ destination: { kind: 'agent_id', agentId: worker } });
    await accept(e);
    await processor.scan();
    const link = (await q<{ local_team_id: string; local_query_id: string }>(
      db,
      `SELECT p.local_team_id, p.local_query_id FROM interteam_processing p
       JOIN interteam_messages m ON m.id = p.message_pk WHERE m.message_id = ?`,
      [e.messageId],
    ))[0]!;
    await q(db, `UPDATE queries SET status = 'failed', error = 'boom' WHERE team_id = ? AND query_id = ?`,
      [link.local_team_id, link.local_query_id]);

    expect(await processor.scan()).toEqual([{ messageId: e.messageId, action: 'failed_handler' }]);
    expect((await q<{ failure_code: string; status: string }>(
      db, `SELECT status, failure_code FROM interteam_messages WHERE message_id = ?`, [e.messageId],
    ))[0]).toMatchObject({ status: 'failed', failure_code: 'handler_failed' });
  });

  it('re-dispatches when a stop cancels the local job instead of sticking forever', async () => {
    const e = envelope({ destination: { kind: 'agent_id', agentId: worker } });
    await accept(e);
    await processor.scan();
    const link = (await q<{ local_team_id: string; local_query_id: string }>(
      db,
      `SELECT p.local_team_id, p.local_query_id FROM interteam_processing p
       JOIN interteam_messages m ON m.id = p.message_pk WHERE m.message_id = ?`,
      [e.messageId],
    ))[0]!;

    // Stopping an agent cancels its queries; that is not an answer.
    await q(db, `UPDATE queries SET status = 'cancelled' WHERE team_id = ? AND query_id = ?`,
      [link.local_team_id, link.local_query_id]);
    await q(db, `UPDATE agents SET status = 'stopped' WHERE id = ?`, [worker]);

    expect(await processor.scan()).toContainEqual({ messageId: e.messageId, action: 'waiting_recipient' });
    expect(await messageStatus(e.messageId)).toBe('processing');

    await q(db, `UPDATE agents SET status = 'running' WHERE id = ?`, [worker]);
    expect(await processor.scan()).toContainEqual({
      messageId: e.messageId, action: 'redispatched_abandoned_job',
    });
    const fresh = (await q<{ local_query_id: string }>(
      db,
      `SELECT p.local_query_id FROM interteam_processing p
       JOIN interteam_messages m ON m.id = p.message_pk WHERE m.message_id = ?`,
      [e.messageId],
    ))[0]!;
    expect(fresh.local_query_id).not.toBe(link.local_query_id);

    await completeLinkedQuery(e.messageId, 'after-restart');
    expect(await processor.scan()).toContainEqual({ messageId: e.messageId, action: 'completed' });
  });

  it('treats an expired job the same way, never leaving the message stuck', async () => {
    const e = envelope({ destination: { kind: 'agent_id', agentId: worker } });
    await accept(e);
    await processor.scan();
    const link = (await q<{ local_team_id: string; local_query_id: string }>(
      db,
      `SELECT p.local_team_id, p.local_query_id FROM interteam_processing p
       JOIN interteam_messages m ON m.id = p.message_pk WHERE m.message_id = ?`,
      [e.messageId],
    ))[0]!;
    await q(db, `UPDATE queries SET status = 'expired' WHERE team_id = ? AND query_id = ?`,
      [link.local_team_id, link.local_query_id]);

    expect(await processor.scan()).toContainEqual({
      messageId: e.messageId, action: 'redispatched_abandoned_job',
    });
    expect(await messageStatus(e.messageId)).toBe('processing');
  });

  it('adopts an orphaned job owner rather than deadlocking after a crash and lead change', async () => {
    const e = envelope({ destination: { kind: 'team' } });
    await accept(e);
    const messagePk = (await q<{ id: string }>(
      db, `SELECT id FROM interteam_messages WHERE message_id = ?`, [e.messageId],
    ))[0]!.id;

    // Simulate a crash between job creation and linkage: the job exists,
    // owned by the lead at that moment, with no interteam_processing row.
    await q(
      db,
      `INSERT INTO queries (team_id, query_id, agent_id, prompt, status, created, owner_kind, owner_id)
       VALUES (?, ?, ?, 'null', 'pending', ?, 'agent', ?)`,
      [destTeam, InterTeamProcessor.localQueryId(messagePk), lead, Date.now(), lead],
    );
    // The lead then changes; a naive resolver would insist on the new lead.
    const newLead = await addAgent(destTeam, 'later-lead');
    await q(db, `UPDATE teams SET lead_agent_id = ? WHERE id = ?`, [newLead, destTeam]);

    expect(await processor.scan()).toContainEqual({ messageId: e.messageId, action: 'dispatched' });
    expect(await messageStatus(e.messageId)).toBe('processing');
    const link = (await q<{ handler_agent_id: string }>(
      db,
      `SELECT p.handler_agent_id FROM interteam_processing p
       JOIN interteam_messages m ON m.id = p.message_pk WHERE m.message_id = ?`,
      [e.messageId],
    ))[0]!;
    expect(link.handler_agent_id).toBe(lead);
  });

  it('bounds how many messages one scan dispatches', async () => {
    const bounded = new InterTeamProcessor(db, {
      dispatchFn: async () => {},
      maxConcurrentDispatch: 2,
    });
    for (let i = 0; i < 5; i++) {
      await accept(envelope({ destination: { kind: 'agent_id', agentId: worker }, body: { i } }));
    }
    const actions = await bounded.scan();
    expect(actions.filter((a) => a.action === 'dispatched')).toHaveLength(2);
    expect(actions.some((a) => a.action === 'waiting_capacity')).toBe(true);
    expect((await q(db, `SELECT id FROM interteam_messages WHERE status = 'processing'`))).toHaveLength(2);
  });

  it('rolls back the job row when linkage fails, leaving no orphan', async () => {
    const e = envelope({ destination: { kind: 'agent_id', agentId: worker } });
    await accept(e);
    const messagePk = (await q<{ id: string }>(
      db, `SELECT id FROM interteam_messages WHERE message_id = ?`, [e.messageId],
    ))[0]!.id;
    // Pre-create the link row so the INSERT inside the transaction conflicts.
    await q(
      db,
      `INSERT INTO interteam_processing (message_pk, local_team_id, local_query_id, handler_agent_id, created_at, updated_at)
       VALUES (?, ?, 'placeholder', ?, ?, ?)`,
      [messagePk, destTeam, worker, Date.now(), Date.now()],
    );

    await expect(processor.scan()).rejects.toThrow();
    // The query row must not survive the rolled-back transaction.
    expect(await q(
      db, `SELECT query_id FROM queries WHERE query_id = ?`,
      [InterTeamProcessor.localQueryId(messagePk)],
    )).toHaveLength(0);
  });

  it('fails a processing direct message when its pinned recipient is deleted mid-flight', async () => {
    const e = envelope({ destination: { kind: 'agent_id', agentId: worker } });
    await accept(e);
    await processor.scan();
    await q(db, `UPDATE agents SET deleted_at = ? WHERE id = ?`, [Date.now(), worker]);

    expect(await processor.scan()).toContainEqual({ messageId: e.messageId, action: 'failed_recipient_deleted' });
    expect(await messageStatus(e.messageId)).toBe('failed');
  });
});
