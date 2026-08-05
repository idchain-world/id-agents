// SPDX-License-Identifier: MIT

import express from 'express';
import type { DbAdapter } from '../db/db-adapter.js';
import { InterTeamAcceptanceService } from './acceptance-service.js';
import { InterteamMessageStore } from './message-store.js';
import { readRoster, rosterReadRateResult, type RosterAgentInput } from './protocol.js';
import { INTER_TEAM_PROTOCOL_VERSION } from './protocol.js';
import { isInterTeamAvailable } from './destination-resolver.js';

/**
 * Commit 15: the receiving half of the federation contract.
 *
 * This is a separate express app from the management API. It exposes only
 * submission, collection, and descriptor reads, and it interprets no local
 * `X-Id-Admin`, `X-Id-Team`, or `X-Id-Agent` header as authority. The asserted
 * origin arrives in federation headers and is trusted because reachability is
 * trusted, which is the V1 assumption, not authentication.
 *
 * Every response carries this node's identity and protocol version outside the
 * operation result so an origin can refuse a substituted peer before it
 * interprets any outcome.
 */

export const FEDERATION_ORIGIN_NODE_HEADER = 'x-interteam-origin-node';
export const FEDERATION_ORIGIN_TEAM_HEADER = 'x-interteam-origin-team';

export const DEFAULT_FEDERATION_BOUNDS = {
  maxRequestBytes: 1024 * 1024,
  maxRosterAgents: 200,
  maxRosterEncodedBytes: 256 * 1024,
  rosterReadsPerMinutePerNode: 60,
};

const STATUS_BY_CODE: Record<string, number> = {
  self_node_claim: 403,
  source_context_mismatch: 403,
  target_closed: 403,
  target_identity_missing: 404,
  recipient_not_found: 404,
  conversation_not_found: 404,
  invalid_address: 400,
  message_too_large: 413,
  protocol_unsupported: 400,
  recipient_ambiguous: 409,
  recipient_unavailable: 409,
  team_lead_unavailable: 409,
  idempotency_conflict: 409,
  conversation_order_conflict: 409,
  receiver_busy: 429,
  read_rate_limited: 429,
  read_response_too_large: 413,
};

function parameterize(db: DbAdapter, sql: string): string {
  if (db.dialect === 'sqlite') return sql;
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

export interface FederationAppOptions {
  bounds?: Partial<typeof DEFAULT_FEDERATION_BOUNDS>;
  /** Invoked after a durable acceptance so the processor can pick work up. */
  onAccepted?: () => void;
}

export function createFederationApp(
  db: DbAdapter,
  acceptance: InterTeamAcceptanceService,
  options: FederationAppOptions = {},
): express.Express {
  const bounds = { ...DEFAULT_FEDERATION_BOUNDS, ...options.bounds };
  const store = new InterteamMessageStore(db);
  const rosterReads = new Map<string, { windowStart: number; used: number }>();
  const app = express();
  app.use(express.json({ limit: bounds.maxRequestBytes }));

  const identity = async () => ({
    nodeId: await acceptance.localNodeId(),
    protocolVersion: INTER_TEAM_PROTOCOL_VERSION,
  });

  /** The asserted origin comes only from federation headers, never from the body. */
  function assertedOrigin(req: express.Request): { nodeId: string; teamId: string } | null {
    const nodeId = req.headers[FEDERATION_ORIGIN_NODE_HEADER];
    const teamId = req.headers[FEDERATION_ORIGIN_TEAM_HEADER];
    if (typeof nodeId !== 'string' || !nodeId || typeof teamId !== 'string' || !teamId) return null;
    return { nodeId, teamId };
  }

  async function fail(res: express.Response, code: string): Promise<void> {
    res.status(STATUS_BY_CODE[code] ?? 400).json({ ...(await identity()), error: code });
  }

  app.post('/federation/messages', async (req, res) => {
    try {
      const origin = assertedOrigin(req);
      if (!origin) return void await fail(res, 'source_context_mismatch');
      const envelope = req.body?.envelope;
      if (!envelope || typeof envelope !== 'object') return void await fail(res, 'invalid_address');

      const outcome = await acceptance.accept({
        transport: {
          kind: 'federation',
          claimedOriginNodeId: origin.nodeId,
          originTeamId: origin.teamId,
        },
        envelope,
      });
      if (outcome.kind === 'accepted' || outcome.kind === 'deduplicated') {
        // 202 is returned only after the acceptance transaction has committed.
        res.status(202).json({
          ...(await identity()),
          state: outcome.status,
          deduplicated: outcome.kind === 'deduplicated',
          messageId: outcome.messageId,
        });
        options.onAccepted?.();
        return;
      }
      await fail(res, outcome.kind === 'error' ? outcome.code : outcome.reason);
    } catch (error) {
      res.status(500).json({ ...(await identity()), error: 'federation_internal_error' });
      console.error('[Federation] submission failed:', error);
    }
  });

  app.get('/federation/conversations/:conversationId/messages/:messageId', async (req, res) => {
    try {
      const origin = assertedOrigin(req);
      if (!origin) return void await fail(res, 'source_context_mismatch');
      const destinationTeamId = typeof req.query.destinationTeamId === 'string'
        ? req.query.destinationTeamId
        : null;
      // The pinned destination team selects the conversation; participants are
      // never taken from parameters after selection.
      if (!destinationTeamId) return void await fail(res, 'conversation_not_found');

      const collected = await store.collect({
        originNodeId: origin.nodeId,
        originTeamId: origin.teamId,
        destinationTeamId,
        conversationId: req.params.conversationId,
        messageId: req.params.messageId,
      });
      if (!collected.ok) return void await fail(res, collected.code);
      res.json({ ...(await identity()), result: collected.value });
    } catch (error) {
      res.status(500).json({ ...(await identity()), error: 'federation_internal_error' });
      console.error('[Federation] collection failed:', error);
    }
  });

  app.get('/federation/teams/:teamId/descriptor', async (req, res) => {
    try {
      const origin = assertedOrigin(req);
      if (!origin) return void await fail(res, 'source_context_mismatch');

      // Read limiting is keyed by the asserted source node: different peers
      // must not share one local bucket.
      const now = Date.now();
      const window = rosterReads.get(origin.nodeId);
      if (!window || now - window.windowStart >= 60_000) {
        rosterReads.set(origin.nodeId, { windowStart: now, used: 1 });
      } else {
        const allowed = rosterReadRateResult(bounds.rosterReadsPerMinutePerNode - window.used);
        if (!allowed.ok) return void await fail(res, allowed.code);
        window.used += 1;
      }

      const team = await db.query<{ id: string; name: string; inbound_policy: 'open' | 'closed' }>(
        parameterize(db, `SELECT id, name, inbound_policy FROM teams WHERE id = ?`),
        [req.params.teamId],
      );
      if (!team.rows[0]) return void await fail(res, 'target_identity_missing');

      const agents = await db.query<{
        id: string; name: string; status: string; deleted_at: number | string | null;
        runtime: string; model: string; metadata: string | Record<string, unknown> | null;
      }>(
        parameterize(db, `SELECT id, name, status, deleted_at, runtime, model, metadata
           FROM agents WHERE team_id = ? AND deleted_at IS NULL ORDER BY name, id`),
        [req.params.teamId],
      );
      const memberships = await db.query<{ agent_id: string; name: string }>(
        parameterize(db, `SELECT gm.agent_id, g.name FROM org_group_members gm
           JOIN org_groups g ON g.id = gm.group_id
           WHERE gm.team_id = ?
             AND NOT EXISTS (SELECT 1 FROM org_groups child WHERE child.parent_group_id = g.id)
           UNION
           SELECT gl.agent_id, g.name FROM org_group_leads gl
           JOIN org_groups g ON g.id = gl.group_id
           WHERE gl.team_id = ?
             AND NOT EXISTS (SELECT 1 FROM org_groups child WHERE child.parent_group_id = g.id)`),
        [req.params.teamId, req.params.teamId],
      );
      const tags = await db.query<{ agent_id: string; name: string }>(
        parameterize(db, `SELECT at.agent_id, t.name FROM org_agent_tags at
           JOIN org_tags t ON t.id = at.tag_id WHERE at.team_id = ?`),
        [req.params.teamId],
      );
      const groupsByAgent = new Map<string, string[]>();
      for (const row of memberships.rows) {
        groupsByAgent.set(row.agent_id, [...(groupsByAgent.get(row.agent_id) ?? []), row.name]);
      }
      const tagsByAgent = new Map<string, string[]>();
      for (const row of tags.rows) {
        tagsByAgent.set(row.agent_id, [...(tagsByAgent.get(row.agent_id) ?? []), row.name]);
      }

      const inputs: RosterAgentInput[] = agents.rows.map((agent) => {
        const metadata = (typeof agent.metadata === 'string'
          ? JSON.parse(agent.metadata || '{}')
          : agent.metadata ?? {}) as Record<string, unknown>;
        const catalog = metadata.catalog && typeof metadata.catalog === 'object' && !Array.isArray(metadata.catalog)
          ? metadata.catalog as Record<string, unknown>
          : {};
        return {
          agentId: agent.id,
          teamId: req.params.teamId,
          addressName: agent.name,
          displayName: agent.name,
          runtime: agent.runtime,
          model: agent.model,
          effort: typeof metadata.effort === 'string' ? metadata.effort : null,
          organizationTags: (tagsByAgent.get(agent.id) ?? []).sort(),
          groups: (groupsByAgent.get(agent.id) ?? []).sort(),
          catalog,
          available: isInterTeamAvailable({
            status: agent.status, deleted_at: agent.deleted_at,
            runtime: agent.runtime, metadata: agent.metadata,
          }),
          deleted: agent.deleted_at !== null,
        };
      });

      // Reads are unaffected by inbound policy: only new conversations are
      // refused by `closed`.
      const roster = readRoster(team.rows[0].inbound_policy, inputs, {
        maxAgents: bounds.maxRosterAgents,
        maxEncodedBytes: bounds.maxRosterEncodedBytes,
      });
      if (!roster.ok) return void await fail(res, roster.code);

      res.json({
        ...(await identity()),
        descriptor: {
          protocolVersion: INTER_TEAM_PROTOCOL_VERSION,
          nodeId: (await identity()).nodeId,
          teamId: team.rows[0].id,
          teamDisplayName: team.rows[0].name,
          inboundPolicy: team.rows[0].inbound_policy,
          agents: roster.agents,
        },
      });
    } catch (error) {
      res.status(500).json({ ...(await identity()), error: 'federation_internal_error' });
      console.error('[Federation] descriptor read failed:', error);
    }
  });

  return app;
}
