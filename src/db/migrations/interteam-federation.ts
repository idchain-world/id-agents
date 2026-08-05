// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../db-adapter.js';
import type { SqliteAdapter } from '../sqlite-adapter.js';

/**
 * Commit 14: peer routes and durable origin-side outbound state.
 *
 * A peer route is node-global operational configuration mapping one expected
 * remote node identity to the one address where that node can currently be
 * reached. It is deliberately separate from `team_contacts`, which pins
 * identity and never stores an address, so re-addressing a peer rewrites no
 * contact, conversation, message, or envelope.
 *
 * Outbound state is the origin's own durable record of what it sent. Federation
 * cannot read the destination's rows, so continue, list, resubmit, and collect
 * must all be reconstructable from these tables alone. No address is stored
 * here: every attempt resolves the current route late, by pinned node ID.
 */
export async function migrateInterteamFederationSqlite(adapter: SqliteAdapter): Promise<void> {
  adapter.exec(`
    CREATE TABLE IF NOT EXISTS interteam_peer_routes (
      node_id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interteam_outbound_conversations (
      origin_node_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      origin_team_id TEXT NOT NULL,
      destination_node_id TEXT NOT NULL,
      destination_team_id TEXT NOT NULL,
      destination_kind TEXT NOT NULL CHECK (destination_kind IN ('team', 'agent_name', 'agent_id')),
      destination_agent_id TEXT,
      destination_name_at_acceptance TEXT,
      next_position INTEGER NOT NULL DEFAULT 0 CHECK (next_position >= 0),
      predecessor_message_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (origin_node_id, conversation_id)
    );

    CREATE INDEX IF NOT EXISTS interteam_outbound_conversations_team_idx
      ON interteam_outbound_conversations(origin_node_id, origin_team_id, updated_at);

    CREATE TABLE IF NOT EXISTS interteam_outbound_submissions (
      origin_node_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      origin_team_id TEXT NOT NULL,
      destination_node_id TEXT NOT NULL,
      destination_team_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      predecessor_message_id TEXT,
      protocol_version TEXT NOT NULL,
      first_submitted_at INTEGER NOT NULL,
      envelope_json TEXT NOT NULL,
      attempt_state TEXT NOT NULL DEFAULT 'not_attempted'
        CHECK (attempt_state IN ('not_attempted', 'unknown', 'accepted', 'rejected')),
      last_attempt_at INTEGER,
      last_diagnostic TEXT,
      last_observed_state TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (origin_node_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS interteam_outbound_submissions_conversation_idx
      ON interteam_outbound_submissions(origin_node_id, conversation_id, position);
  `);
}

/** PostgreSQL equivalent of the commit-14 federation schema. */
export async function migrateInterteamFederationPostgres(adapter: DbAdapter): Promise<void> {
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS interteam_peer_routes (
      node_id text PRIMARY KEY,
      base_url text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    )
  `);
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS interteam_outbound_conversations (
      origin_node_id text NOT NULL,
      conversation_id text NOT NULL,
      origin_team_id text NOT NULL,
      destination_node_id text NOT NULL,
      destination_team_id text NOT NULL,
      destination_kind text NOT NULL CHECK (destination_kind IN ('team', 'agent_name', 'agent_id')),
      destination_agent_id text,
      destination_name_at_acceptance text,
      next_position integer NOT NULL DEFAULT 0 CHECK (next_position >= 0),
      predecessor_message_id text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      PRIMARY KEY (origin_node_id, conversation_id)
    )
  `);
  await adapter.query(`
    CREATE INDEX IF NOT EXISTS interteam_outbound_conversations_team_idx
      ON interteam_outbound_conversations(origin_node_id, origin_team_id, updated_at)
  `);
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS interteam_outbound_submissions (
      origin_node_id text NOT NULL,
      message_id text NOT NULL,
      conversation_id text NOT NULL,
      origin_team_id text NOT NULL,
      destination_node_id text NOT NULL,
      destination_team_id text NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      predecessor_message_id text,
      protocol_version text NOT NULL,
      first_submitted_at bigint NOT NULL,
      envelope_json jsonb NOT NULL,
      attempt_state text NOT NULL DEFAULT 'not_attempted'
        CHECK (attempt_state IN ('not_attempted', 'unknown', 'accepted', 'rejected')),
      last_attempt_at bigint,
      last_diagnostic text,
      last_observed_state text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      PRIMARY KEY (origin_node_id, message_id)
    )
  `);
  await adapter.query(`
    CREATE INDEX IF NOT EXISTS interteam_outbound_submissions_conversation_idx
      ON interteam_outbound_submissions(origin_node_id, conversation_id, position)
  `);
}
