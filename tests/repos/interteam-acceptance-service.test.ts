// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbAdapter } from '../../src/db/db-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { DestinationResolver } from '../../src/inter-team/destination-resolver.js';
import {
  InterTeamAcceptanceService,
} from '../../src/inter-team/acceptance-service.js';
import type { InterTeamRequestEnvelope, Destination } from '../../src/inter-team/protocol.js';

async function q<T = unknown>(db: DbAdapter, text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(text, params)).rows;
}

describe('inter-team acceptance service (commit 8)', () => {
  let db: DbAdapter;
  let resolver: DestinationResolver;
  let service: InterTeamAcceptanceService;
  let nodeId: string;
  let originTeam: string;
  let openTeam: string;
  let closedTeam: string;
  let openLead: string;
  let openWorker: string;

  function envelope(overrides: Partial<InterTeamRequestEnvelope> & { destination?: Destination } = {}): InterTeamRequestEnvelope {
    return {
      protocolVersion: '1.0',
      originNodeId: nodeId,
      originTeamId: originTeam,
      destinationNodeId: nodeId,
      destinationTeamId: openTeam,
      destination: { kind: 'team' },
      conversationId: `conv-${randomUUID()}`,
      messageId: `msg-${randomUUID()}`,
      position: 0,
      predecessorMessageId: null,
      firstSubmittedAt: 1_000,
      body: { ask: 'status' },
      ...overrides,
    };
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
    resolver = new DestinationResolver(db);
    service = new InterTeamAcceptanceService(db, { resolver });
    nodeId = (await q<{ node_id: string }>(db, `SELECT node_id FROM manager_identity`))[0]!.node_id;
    originTeam = randomUUID();
    openTeam = randomUUID();
    closedTeam = randomUUID();
    await q(db, `INSERT INTO teams (id, name) VALUES (?, ?), (?, ?), (?, ?)`, [
      originTeam, `origin-${randomUUID()}`,
      openTeam, `open-${randomUUID()}`,
      closedTeam, `closed-${randomUUID()}`,
    ]);
    await q(db, `UPDATE teams SET inbound_policy = 'open' WHERE id = ?`, [openTeam]);
    openLead = await addAgent(openTeam, 'lead');
    openWorker = await addAgent(openTeam, 'worker');
    await q(db, `UPDATE teams SET lead_agent_id = ? WHERE id = ?`, [openLead, openTeam]);
  });

  afterEach(async () => {
    await db.close();
  });

  it('rejects a federation request claiming the local node before anything durable', async () => {
    const outcome = await service.accept({
      transport: { kind: 'federation', claimedOriginNodeId: nodeId, originTeamId: 'remote-team' },
      envelope: envelope(),
    });
    expect(outcome).toEqual({ kind: 'rejected', reason: 'self_node_claim' });
    expect(await q(db, `SELECT id FROM interteam_messages`)).toHaveLength(0);
  });

  it('accepts same-manager trusted local context using the local node identity', async () => {
    const outcome = await service.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope(),
    });
    expect(outcome).toMatchObject({ kind: 'accepted', status: 'accepted' });
  });

  it('rejects an envelope whose asserted origin disagrees with transport context', async () => {
    const outcome = await service.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope({ originTeamId: 'someone-else' }),
    });
    expect(outcome).toEqual({ kind: 'rejected', reason: 'source_context_mismatch' });
    expect(await q(db, `SELECT id FROM interteam_messages`)).toHaveLength(0);
  });

  it('returns target_closed before any recipient lookup, for known and unknown names alike', async () => {
    const spy = vi.spyOn(resolver, 'resolveNewSendRecipient');
    const leadSpy = vi.spyOn(resolver, 'getTeamLeadAgentId');
    await addAgent(closedTeam, 'known-name');
    for (const destination of [
      { kind: 'agent_name', agentName: 'known-name' } as const,
      { kind: 'agent_name', agentName: 'unknown-name' } as const,
      { kind: 'team' } as const,
    ]) {
      const outcome = await service.accept({
        transport: { kind: 'same_manager', originTeamId: originTeam },
        envelope: envelope({ destinationTeamId: closedTeam, destination }),
      });
      expect(outcome).toEqual({ kind: 'error', code: 'target_closed' });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(leadSpy).not.toHaveBeenCalled();
    expect(await q(db, `SELECT id FROM interteam_messages`)).toHaveLength(0);
    expect(await q(db, `SELECT id FROM interteam_conversations`)).toHaveLength(0);
  });

  it('resolves all three variants on an open team and never consults the lead for a direct target', async () => {
    const leadSpy = vi.spyOn(resolver, 'getTeamLeadAgentId');

    const teamSend = await service.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope({ destination: { kind: 'team' } }),
    });
    expect(teamSend).toMatchObject({ kind: 'accepted' });
    expect(leadSpy).toHaveBeenCalledTimes(1);

    leadSpy.mockClear();
    const byName = await service.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope({ destination: { kind: 'agent_name', agentName: 'worker' } }),
    });
    expect(byName).toMatchObject({ kind: 'accepted' });
    const byId = await service.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope({ destination: { kind: 'agent_id', agentId: openWorker } }),
    });
    expect(byId).toMatchObject({ kind: 'accepted' });
    expect(leadSpy).not.toHaveBeenCalled();

    const pinned = await q<{ resolved_agent_id: string | null; recipient_kind: string }>(
      db,
      `SELECT resolved_agent_id, recipient_kind FROM interteam_messages ORDER BY accepted_at, id`,
    );
    expect(pinned.find((row) => row.recipient_kind === 'team')?.resolved_agent_id).toBeNull();
    expect(pinned.filter((row) => row.recipient_kind !== 'team').every((row) => row.resolved_agent_id === openWorker)).toBe(true);
  });

  it('gives a third node/team the same conversation_not_found as an unknown ID, creating no state', async () => {
    const first = envelope();
    await service.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: first,
    });
    const before = await q(db, `SELECT id FROM interteam_messages`);

    const intruder = await service.accept({
      transport: { kind: 'same_manager', originTeamId: closedTeam },
      envelope: envelope({
        originTeamId: closedTeam,
        conversationId: first.conversationId,
        position: 1,
        predecessorMessageId: first.messageId,
      }),
    });
    expect(intruder).toEqual({ kind: 'error', code: 'conversation_not_found' });

    const unknown = await service.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope({
        conversationId: `conv-${randomUUID()}`,
        position: 1,
        predecessorMessageId: first.messageId,
      }),
    });
    expect(unknown).toEqual({ kind: 'error', code: 'conversation_order_conflict' });

    expect(await q(db, `SELECT id FROM interteam_messages`)).toHaveLength(before.length);
  });

  it('short-circuits an identical accepted duplicate before mutable policy re-evaluation', async () => {
    const request = envelope();
    await service.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: request,
    });

    await q(db, `UPDATE teams SET inbound_policy = 'closed' WHERE id = ?`, [openTeam]);
    const busyService = new InterTeamAcceptanceService(db, {
      resolver,
      bounds: { maxNonTerminalTotal: 0 },
    });
    const retry = await busyService.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: request,
    });
    expect(retry).toMatchObject({ kind: 'deduplicated', status: 'accepted' });

    const changed = await busyService.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: { ...request, body: { ask: 'status', changed: true } },
    });
    expect(changed).toEqual({ kind: 'error', code: 'idempotency_conflict' });
  });

  it('cannot have a continuation binding altered by policy, name, or caller-supplied target', async () => {
    const first = envelope({ destination: { kind: 'agent_name', agentName: 'worker' } });
    await service.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: first,
    });

    await q(db, `UPDATE teams SET inbound_policy = 'closed' WHERE id = ?`, [openTeam]);
    await q(db, `UPDATE agents SET name = 'renamed-worker' WHERE id = ?`, [openWorker]);

    const hijack = await service.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope({
        conversationId: first.conversationId,
        destination: { kind: 'agent_name', agentName: 'lead' },
        position: 1,
        predecessorMessageId: first.messageId,
      }),
    });
    expect(hijack).toEqual({ kind: 'error', code: 'conversation_not_found' });

    const continuation = await service.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope({
        conversationId: first.conversationId,
        destination: { kind: 'agent_name', agentName: 'worker' },
        position: 1,
        predecessorMessageId: first.messageId,
      }),
    });
    expect(continuation).toMatchObject({ kind: 'accepted' });
    const rows = await q<{ resolved_agent_id: string | null }>(
      db,
      `SELECT resolved_agent_id FROM interteam_messages`,
    );
    expect(rows.every((row) => row.resolved_agent_id === openWorker)).toBe(true);
  });

  it('bounds body size and backlog with stable pre-accept errors that allocate nothing', async () => {
    const tiny = new InterTeamAcceptanceService(db, {
      resolver,
      bounds: { maxBodyBytes: 16 },
    });
    const large = await tiny.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope({ body: { pad: 'x'.repeat(64) } }),
    });
    expect(large).toEqual({ kind: 'error', code: 'message_too_large' });

    const capped = new InterTeamAcceptanceService(db, {
      resolver,
      bounds: { maxNonTerminalPerOrigin: 1 },
    });
    const accepted = await capped.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope(),
    });
    expect(accepted).toMatchObject({ kind: 'accepted' });
    const busy = await capped.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope(),
    });
    expect(busy).toEqual({ kind: 'error', code: 'receiver_busy' });
    // The bound rejected the new send without dropping the accepted message.
    expect(await q(db, `SELECT id FROM interteam_messages WHERE status = 'accepted'`)).toHaveLength(1);
  });

  it('admits exactly the bound under concurrent submissions, atomically with acceptance', async () => {
    const capped = new InterTeamAcceptanceService(db, {
      resolver,
      bounds: { maxNonTerminalPerTeam: 2 },
    });
    const outcomes = await Promise.all(Array.from({ length: 6 }, () =>
      capped.accept({
        transport: { kind: 'same_manager', originTeamId: originTeam },
        envelope: envelope({ destination: { kind: 'agent_id', agentId: openWorker } }),
      })));
    const accepted = outcomes.filter((o) => o.kind === 'accepted');
    const busy = outcomes.filter((o) => o.kind === 'error' && o.code === 'receiver_busy');
    expect(accepted).toHaveLength(2);
    expect(busy).toHaveLength(4);
    expect(await q(db, `SELECT id FROM interteam_messages`)).toHaveLength(2);
  });

  it('returns recipient_not_found for a wrong-team agent ID even at its capacity limit', async () => {
    const foreignAgent = await addAgent(closedTeam, 'busy-foreigner');
    // Saturate the foreign agent's per-recipient backlog in its own team.
    await q(db, `UPDATE teams SET inbound_policy = 'open' WHERE id = ?`, [closedTeam]);
    const tight = new InterTeamAcceptanceService(db, {
      resolver,
      bounds: { maxNonTerminalPerDirectRecipient: 1 },
    });
    const fill = await tight.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope({ destinationTeamId: closedTeam, destination: { kind: 'agent_id', agentId: foreignAgent } }),
    });
    expect(fill).toMatchObject({ kind: 'accepted' });

    // Addressed through the WRONG team, the saturated agent must not leak
    // busy-state: membership validation precedes any per-recipient bound.
    const wrongTeam = await tight.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope({ destination: { kind: 'agent_id', agentId: foreignAgent } }),
    });
    expect(wrongTeam).toEqual({ kind: 'error', code: 'recipient_not_found' });

    // Correctly addressed, the bound still holds.
    const saturated = await tight.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope({ destinationTeamId: closedTeam, destination: { kind: 'agent_id', agentId: foreignAgent } }),
    });
    expect(saturated).toEqual({ kind: 'error', code: 'receiver_busy' });
  });

  it('rejects an unsupported protocol major before acceptance', async () => {
    const outcome = await service.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope({ protocolVersion: '2.0' }),
    });
    expect(outcome).toEqual({ kind: 'error', code: 'protocol_unsupported' });
  });

  it('routes a mis-addressed destination node to target_identity_missing', async () => {
    const outcome = await service.accept({
      transport: { kind: 'same_manager', originTeamId: originTeam },
      envelope: envelope({ destinationNodeId: 'another-node' }),
    });
    expect(outcome).toEqual({ kind: 'error', code: 'target_identity_missing' });
  });
});
