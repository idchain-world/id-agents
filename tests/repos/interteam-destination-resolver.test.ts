// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbAdapter } from '../../src/db/db-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import {
  DestinationResolver,
  isInterTeamAvailable,
} from '../../src/inter-team/destination-resolver.js';

async function q<T = unknown>(db: DbAdapter, text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(text, params)).rows;
}

describe('inter-team destination resolution (commit 7)', () => {
  let db: DbAdapter;
  let resolver: DestinationResolver;
  let teamA: string;
  let teamB: string;

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
    resolver = new DestinationResolver(db);
    teamA = randomUUID();
    teamB = randomUUID();
    await q(db, `INSERT INTO teams (id, name) VALUES (?, ?), (?, ?)`, [teamA, `a-${randomUUID()}`, teamB, `b-${randomUUID()}`]);
  });

  afterEach(async () => {
    await db.close();
  });

  it('resolves the destination team only by immutable ID', async () => {
    expect(await resolver.resolveDestinationTeam(teamA)).toEqual({ ok: true, teamId: teamA });
    expect(await resolver.resolveDestinationTeam('no-such-team'))
      .toEqual({ ok: false, code: 'target_identity_missing' });
  });

  it('resolves a valid exact name to its immutable ID for pinning', async () => {
    const id = await addAgent(teamA, 'researcher');
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_name', agentName: 'researcher' }))
      .toEqual({ ok: true, kind: 'agent', agentId: id });
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_id', agentId: id }))
      .toEqual({ ok: true, kind: 'agent', agentId: id });
  });

  it('returns recipient_not_found for an unknown name and never matches across teams', async () => {
    await addAgent(teamB, 'researcher');
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_name', agentName: 'researcher' }))
      .toEqual({ ok: false, code: 'recipient_not_found' });
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_name', agentName: 'nobody' }))
      .toEqual({ ok: false, code: 'recipient_not_found' });
  });

  it('rejects a duplicated name as ambiguous rather than picking most-recent', async () => {
    await addAgent(teamA, 'twin');
    await addAgent(teamA, 'twin');
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_name', agentName: 'twin' }))
      .toEqual({ ok: false, code: 'recipient_ambiguous' });
  });

  it('returns recipient_unavailable for a stopped named agent', async () => {
    await addAgent(teamA, 'napper', 'stopped');
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_name', agentName: 'napper' }))
      .toEqual({ ok: false, code: 'recipient_unavailable' });
  });

  it('rejects an exact ID that lives outside the destination team', async () => {
    const foreign = await addAgent(teamB, 'outsider');
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_id', agentId: foreign }))
      .toEqual({ ok: false, code: 'recipient_not_found' });
  });

  it('keeps ID addressing working across a rename while the old name stops resolving', async () => {
    const id = await addAgent(teamA, 'before-rename');
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_name', agentName: 'before-rename' }))
      .toEqual({ ok: true, kind: 'agent', agentId: id });

    await q(db, `UPDATE agents SET name = ? WHERE id = ?`, ['after-rename', id]);
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_name', agentName: 'before-rename' }))
      .toEqual({ ok: false, code: 'recipient_not_found' });
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_name', agentName: 'after-rename' }))
      .toEqual({ ok: true, kind: 'agent', agentId: id });
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_id', agentId: id }))
      .toEqual({ ok: true, kind: 'agent', agentId: id });
  });

  it('treats a soft-deleted agent as gone for both name and ID', async () => {
    const id = await addAgent(teamA, 'leaver');
    await q(db, `UPDATE agents SET deleted_at = ? WHERE id = ?`, [Date.now(), id]);
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_name', agentName: 'leaver' }))
      .toEqual({ ok: false, code: 'recipient_not_found' });
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_id', agentId: id }))
      .toEqual({ ok: false, code: 'recipient_not_found' });
  });

  it('resolves a delete-recreate name to the new immutable ID only', async () => {
    const oldId = await addAgent(teamA, 'phoenix');
    await q(db, `UPDATE agents SET deleted_at = ? WHERE id = ?`, [Date.now(), oldId]);
    const newId = await addAgent(teamA, 'phoenix');
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_name', agentName: 'phoenix' }))
      .toEqual({ ok: true, kind: 'agent', agentId: newId });
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_id', agentId: oldId }))
      .toEqual({ ok: false, code: 'recipient_not_found' });
  });

  it('routes a team destination through the assigned lead without pinning it', async () => {
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'team' }))
      .toEqual({ ok: false, code: 'team_lead_unavailable' });

    const lead = await addAgent(teamA, 'lead');
    await q(db, `UPDATE teams SET lead_agent_id = ? WHERE id = ?`, [lead, teamA]);
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'team' }))
      .toEqual({ ok: true, kind: 'team' });

    await q(db, `UPDATE agents SET status = 'stopped' WHERE id = ?`, [lead]);
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'team' }))
      .toEqual({ ok: false, code: 'team_lead_unavailable' });
  });

  it('shares one availability predicate between routing and processing', () => {
    const base = { status: 'running', deleted_at: null, runtime: 'codex', metadata: '{}' };
    expect(isInterTeamAvailable(base)).toBe(true);
    expect(isInterTeamAvailable({ ...base, status: 'stopped' })).toBe(false);
    expect(isInterTeamAvailable({ ...base, deleted_at: 5 })).toBe(false);
    expect(isInterTeamAvailable(null)).toBe(false);
  });

  it('excludes agent kinds the manager cannot dispatch to', async () => {
    // A DMZ public-remote runtime and a non-mesh member are both refused by
    // the delivery path, so acceptance must not promise them work.
    expect(isInterTeamAvailable({
      status: 'running', deleted_at: null, runtime: 'public-agent-remote', metadata: '{}',
    })).toBe(false);
    expect(isInterTeamAvailable({
      status: 'running', deleted_at: null, runtime: 'codex',
      metadata: JSON.stringify({ mesh_member: false }),
    })).toBe(false);

    const dmz = `agent-${randomUUID()}`;
    await q(
      db,
      `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
       VALUES (?, ?, 'dmz-agent', 'virtual', 'external', 0, 'running', ?, '{}', 'public-agent-remote')`,
      [dmz, teamA, Date.now()],
    );
    expect(await resolver.resolveNewSendRecipient(teamA, { kind: 'agent_id', agentId: dmz }))
      .toEqual({ ok: false, code: 'recipient_unavailable' });
  });
});
