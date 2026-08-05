// SPDX-License-Identifier: MIT
/**
 * Commit 16 container gate: one ID Agents federation node inside a container.
 *
 * This runs the real production modules. The federation listener comes from
 * `resolveFederationListenerConfig`, so the disabled default and the wildcard
 * refusal are the shipped code paths, not a test reimplementation. The
 * management surface binds `127.0.0.1` exactly as the manager does, which is
 * what makes "loopback-only from outside the container" observable.
 *
 * A small control surface on the management port is what the host drives the
 * test through, over `docker exec`. It is deliberately on the loopback bind so
 * the peer container cannot reach it either.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';

import { SqliteAdapter } from './dist/db/sqlite-adapter.js';
import { migrateSqlite } from './dist/db/migrations/sqlite.js';
import { InterTeamAcceptanceService } from './dist/inter-team/acceptance-service.js';
import { InterTeamOriginClient } from './dist/inter-team/origin-client.js';
import { InterTeamProcessor } from './dist/inter-team/processor.js';
import { InterteamFoundationStore } from './dist/inter-team/foundation-store.js';
import { InterTeamOutboundStore } from './dist/inter-team/outbound-store.js';
import { PeerRouteStore } from './dist/inter-team/peer-routes.js';
import { createFederationApp } from './dist/inter-team/federation-app.js';
import { HttpFederationTransport } from './dist/inter-team/federation-client.js';
import {
  describeFederationBind,
  resolveFederationListenerConfig,
} from './dist/inter-team/federation-config.js';

const NAME = process.env.ID_NODE_NAME ?? 'node';
const DB_PATH = process.env.ID_DB_PATH ?? '/data/node.db';
const MGMT_PORT = Number(process.env.ID_MGMT_PORT ?? 4100);

/**
 * Outbound-network spy. Every connection this process attempts is counted, so
 * "the destination opened zero outbound connections" is observable from inside
 * the destination rather than inferred from the origin's side.
 */
const outboundAttempts = [];
const realFetch = globalThis.fetch;
let dropNextSubmitResponse = false;
globalThis.fetch = async (url, init) => {
  outboundAttempts.push(String(url));
  const response = await realFetch(url, init);
  if (dropNextSubmitResponse && String(url).includes('/federation/messages')) {
    // The peer commits and the acceptance response never reaches us.
    dropNextSubmitResponse = false;
    throw Object.assign(new Error('simulated lost acceptance response'), { name: 'FetchError' });
  }
  return response;
};

const db = new SqliteAdapter(DB_PATH);
await migrateSqlite(db);

const sql = (text) => text;
const rows = async (text, params = []) => (await db.query(text, params)).rows;

// Seed once. A restart reuses the same durable database, which is what makes
// the destination-restart assertion meaningful.
let team = (await rows(sql(`SELECT id FROM teams WHERE name = ?`), [`${NAME}-team`]))[0];
if (!team) {
  const teamId = randomUUID();
  const agentId = `agent-${randomUUID()}`;
  await rows(
    sql(`INSERT INTO teams (id, name, inbound_policy) VALUES (?, ?, 'open')`),
    [teamId, `${NAME}-team`],
  );
  await rows(
    sql(`INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
         VALUES (?, ?, ?, 'claude', 'model', 0, 'running', ?, '{}', 'codex')`),
    [agentId, teamId, `${NAME}-worker`, Date.now()],
  );
  await rows(sql(`UPDATE teams SET lead_agent_id = ? WHERE id = ?`), [agentId, teamId]);
  team = { id: teamId };
}
const teamId = team.id;
const agentId = (await rows(sql(`SELECT id FROM agents WHERE team_id = ?`), [teamId]))[0].id;
const nodeId = (await rows(sql(`SELECT node_id FROM manager_identity`)))[0].node_id;

const acceptance = new InterTeamAcceptanceService(db);
const transport = new HttpFederationTransport(db, { timeoutMs: 8000 });
const origin = new InterTeamOriginClient(db, acceptance, { transport });
const processor = new InterTeamProcessor(db, { dispatchFn: async () => {} });
const outbound = new InterTeamOutboundStore(db);
const routes = new PeerRouteStore(db);

// The federation listener, from the shipped configuration resolver. An invalid
// or unacknowledged-wildcard bind throws here, before any socket exists.
const federationConfig = resolveFederationListenerConfig(process.env);
console.log(`[${NAME}] ${describeFederationBind(federationConfig)}`);
if (federationConfig.enabled) {
  const federationServer = createServer(
    createFederationApp(db, acceptance, { onAccepted: () => { void processor.scan(); } }),
  );
  federationServer.listen(federationConfig.port, federationConfig.address, () => {
    console.log(`[${NAME}] federation listening on ${federationConfig.address}:${federationConfig.port}`);
  });
}

const context = { localTeamId: teamId, principal: 'agent-header', agentId: null };
const control = express();
control.use(express.json());

control.get('/whoami', (_req, res) => res.json({ name: NAME, nodeId, teamId, agentId }));
control.get('/outbound-attempts', (_req, res) =>
  res.json({ count: outboundAttempts.length, attempts: outboundAttempts }));

control.put('/route', async (req, res) => {
  try {
    res.json({ route: await routes.upsert({
      nodeId: req.body.nodeId, baseUrl: req.body.baseUrl, localNodeId: nodeId,
    }) });
  } catch (error) { res.status(400).json({ error: error.code ?? String(error.message) }); }
});

control.put('/contact', async (req, res) => {
  const contact = await new InterteamFoundationStore(db).createContact({
    localTeamId: teamId,
    aliasDisplay: req.body.alias,
    remoteNodeId: req.body.remoteNodeId,
    remoteTeamId: req.body.remoteTeamId,
  });
  res.json({ contact });
});

control.post('/send', async (req, res) => {
  if (req.body.dropResponse) dropNextSubmitResponse = true;
  const destination = req.body.agentId
    ? { kind: 'agent_id', agentId: req.body.agentId }
    : { kind: 'team' };
  res.json(await origin.send({
    context, alias: req.body.alias, destination, body: req.body.body ?? null,
  }));
});

control.post('/resubmit-unknown', async (req, res) => {
  const pending = (await rows(
    sql(`SELECT message_id FROM interteam_outbound_submissions WHERE attempt_state = 'unknown' ORDER BY created_at DESC`),
  ))[0];
  if (!pending) return res.status(404).json({ error: 'no_unknown_submission' });
  const record = await outbound.getSubmission(nodeId, pending.message_id);
  res.json({ messageId: pending.message_id, result: await origin.resubmit({ context, envelope: record.envelope }) });
});

control.get('/collect', async (req, res) => {
  res.json(await origin.collect({
    context, conversationId: req.query.conversationId, messageId: req.query.messageId,
  }));
});

control.post('/scan', async (_req, res) => res.json({ actions: await processor.scan() }));

/** Complete the destination's local job, standing in for a handler answering. */
control.post('/complete', async (req, res) => {
  const link = (await rows(
    sql(`SELECT p.local_team_id, p.local_query_id FROM interteam_processing p
         JOIN interteam_messages m ON m.id = p.message_pk WHERE m.message_id = ?`),
    [req.body.messageId],
  ))[0];
  if (!link) return res.status(404).json({ error: 'no_link' });
  await rows(
    sql(`UPDATE queries SET status = 'completed', completed = ?, result = ? WHERE team_id = ? AND query_id = ?`),
    [Date.now(), JSON.stringify(req.body.result ?? null), link.local_team_id, link.local_query_id],
  );
  res.json({ completed: true, actions: await processor.scan() });
});

control.get('/count-messages', async (req, res) => {
  const found = await rows(
    sql(`SELECT COUNT(*) AS count FROM interteam_messages WHERE message_id = ?`), [req.body?.messageId ?? req.query.messageId],
  );
  res.json({ count: Number(found[0].count) });
});

control.get('/health', (_req, res) => res.json({ ok: true, name: NAME, nodeId }));

// Management binds loopback only. The peer container cannot reach this.
control.listen(MGMT_PORT, '127.0.0.1', () => {
  console.log(`[${NAME}] management listening on 127.0.0.1:${MGMT_PORT}`);
  console.log(`[${NAME}] ready node=${nodeId} team=${teamId} agent=${agentId}`);
});
