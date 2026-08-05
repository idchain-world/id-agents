// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../db-adapter.js';
import type { SqliteAdapter } from '../sqlite-adapter.js';

/** Commit 5 durable conversation/message/receipt persistence for SQLite. */
export async function migrateInterteamMessagesSqlite(adapter: SqliteAdapter): Promise<void> {
  adapter.exec(`
    CREATE TABLE IF NOT EXISTS interteam_conversations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      origin_node_id TEXT NOT NULL,
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
      UNIQUE(origin_node_id, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS interteam_messages (
      id TEXT PRIMARY KEY,
      conversation_pk TEXT NOT NULL REFERENCES interteam_conversations(id) ON DELETE RESTRICT,
      submitter_node_id TEXT NOT NULL,
      submitter_team_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      predecessor_message_id TEXT,
      recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('team', 'agent_name', 'agent_id')),
      recipient_name_at_acceptance TEXT,
      resolved_agent_id TEXT,
      comparison_identity TEXT NOT NULL,
      request_body TEXT,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'processing', 'completed', 'failed', 'unknown')),
      last_confirmed_status TEXT NOT NULL CHECK (last_confirmed_status IN ('accepted', 'processing', 'completed', 'failed')),
      failure_code TEXT,
      result_payload TEXT,
      result_present INTEGER NOT NULL DEFAULT 0 CHECK (result_present IN (0, 1)),
      retention_tier TEXT NOT NULL DEFAULT 'retained' CHECK (retention_tier IN ('retained', 'compacted')),
      accepted_at INTEGER NOT NULL,
      processing_at INTEGER,
      terminal_at INTEGER,
      compact_after INTEGER,
      delete_after INTEGER,
      updated_at INTEGER NOT NULL,
      CHECK (
        (status IN ('completed', 'failed') AND terminal_at IS NOT NULL
          AND compact_after IS NOT NULL AND delete_after IS NOT NULL)
        OR
        (status IN ('accepted', 'processing', 'unknown') AND terminal_at IS NULL
          AND compact_after IS NULL AND delete_after IS NULL)
      ),
      CHECK (
        (status = 'accepted' AND last_confirmed_status = 'accepted')
        OR (status = 'processing' AND last_confirmed_status = 'processing')
        OR (status = 'unknown' AND last_confirmed_status IN ('accepted', 'processing'))
        OR (status = 'completed' AND last_confirmed_status = 'completed')
        OR (status = 'failed' AND last_confirmed_status = 'failed')
      ),
      CHECK (status = 'failed' OR failure_code IS NULL),
      CHECK (status != 'failed' OR (failure_code IS NOT NULL AND length(failure_code) > 0)),
      CHECK (status != 'completed' OR result_present = 1 OR retention_tier = 'compacted'),
      CHECK (retention_tier = 'retained' OR status IN ('completed', 'failed')),
      UNIQUE(submitter_node_id, message_id),
      UNIQUE(conversation_pk, position)
    );

    CREATE INDEX IF NOT EXISTS interteam_messages_retention_idx
      ON interteam_messages(status, retention_tier, compact_after, delete_after);

    CREATE TABLE IF NOT EXISTS interteam_processing (
      message_pk TEXT PRIMARY KEY REFERENCES interteam_messages(id) ON DELETE CASCADE,
      local_team_id TEXT NOT NULL,
      local_query_id TEXT NOT NULL,
      handler_agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(local_team_id, local_query_id)
    );

    CREATE TABLE IF NOT EXISTS interteam_message_receipts (
      submitter_node_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      conversation_pk TEXT NOT NULL REFERENCES interteam_conversations(id) ON DELETE RESTRICT,
      comparison_identity TEXT NOT NULL,
      position INTEGER NOT NULL,
      predecessor_message_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
      last_confirmed_status TEXT NOT NULL CHECK (last_confirmed_status IN ('completed', 'failed')),
      terminal_at INTEGER NOT NULL,
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (submitter_node_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS interteam_origin_allocations (
      node_id TEXT NOT NULL,
      id_kind TEXT NOT NULL CHECK (id_kind IN ('conversation', 'message')),
      allocated_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (node_id, id_kind, allocated_id)
    );

    CREATE TRIGGER IF NOT EXISTS interteam_messages_initial_status
    BEFORE INSERT ON interteam_messages
    WHEN NEW.status != 'accepted'
    BEGIN
      SELECT RAISE(ABORT, 'interteam_initial_status_invalid');
    END;

    CREATE TRIGGER IF NOT EXISTS interteam_messages_processing_requires_link
    BEFORE UPDATE OF status ON interteam_messages
    WHEN NEW.status = 'processing' AND OLD.status != 'processing'
      AND NOT EXISTS (SELECT 1 FROM interteam_processing WHERE message_pk = NEW.id)
    BEGIN
      SELECT RAISE(ABORT, 'durable_job_missing');
    END;

    CREATE TRIGGER IF NOT EXISTS teams_block_delete_with_interteam_work
    BEFORE DELETE ON teams
    WHEN EXISTS (
      SELECT 1
      FROM interteam_messages m
      JOIN interteam_conversations c ON c.id = m.conversation_pk
      WHERE (c.origin_team_id = OLD.id OR c.destination_team_id = OLD.id)
        AND m.status IN ('accepted', 'processing', 'unknown')
    )
    BEGIN
      SELECT RAISE(ABORT, 'interteam_team_has_active_work');
    END;
  `);
}

/** PostgreSQL equivalent of the commit-5 durable messaging schema. */
export async function migrateInterteamMessagesPostgres(adapter: DbAdapter): Promise<void> {
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS interteam_conversations (
      id uuid PRIMARY KEY,
      conversation_id text NOT NULL,
      origin_node_id text NOT NULL,
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
      UNIQUE(origin_node_id, conversation_id)
    )
  `);
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS interteam_messages (
      id uuid PRIMARY KEY,
      conversation_pk uuid NOT NULL REFERENCES interteam_conversations(id) ON DELETE RESTRICT,
      submitter_node_id text NOT NULL,
      submitter_team_id text NOT NULL,
      message_id text NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      predecessor_message_id text,
      recipient_kind text NOT NULL CHECK (recipient_kind IN ('team', 'agent_name', 'agent_id')),
      recipient_name_at_acceptance text,
      resolved_agent_id text,
      comparison_identity text NOT NULL,
      request_body jsonb,
      status text NOT NULL CHECK (status IN ('accepted', 'processing', 'completed', 'failed', 'unknown')),
      last_confirmed_status text NOT NULL CHECK (last_confirmed_status IN ('accepted', 'processing', 'completed', 'failed')),
      failure_code text,
      result_payload jsonb,
      result_present boolean NOT NULL DEFAULT false,
      retention_tier text NOT NULL DEFAULT 'retained' CHECK (retention_tier IN ('retained', 'compacted')),
      accepted_at bigint NOT NULL,
      processing_at bigint,
      terminal_at bigint,
      compact_after bigint,
      delete_after bigint,
      updated_at bigint NOT NULL,
      CHECK (
        (status IN ('completed', 'failed') AND terminal_at IS NOT NULL
          AND compact_after IS NOT NULL AND delete_after IS NOT NULL)
        OR
        (status IN ('accepted', 'processing', 'unknown') AND terminal_at IS NULL
          AND compact_after IS NULL AND delete_after IS NULL)
      ),
      CHECK (
        (status = 'accepted' AND last_confirmed_status = 'accepted')
        OR (status = 'processing' AND last_confirmed_status = 'processing')
        OR (status = 'unknown' AND last_confirmed_status IN ('accepted', 'processing'))
        OR (status = 'completed' AND last_confirmed_status = 'completed')
        OR (status = 'failed' AND last_confirmed_status = 'failed')
      ),
      CHECK (status = 'failed' OR failure_code IS NULL),
      CHECK (status != 'failed' OR (failure_code IS NOT NULL AND length(failure_code) > 0)),
      CHECK (status != 'completed' OR result_present OR retention_tier = 'compacted'),
      CHECK (retention_tier = 'retained' OR status IN ('completed', 'failed')),
      UNIQUE(submitter_node_id, message_id),
      UNIQUE(conversation_pk, position)
    )
  `);
  await adapter.query(`CREATE INDEX IF NOT EXISTS interteam_messages_retention_idx ON interteam_messages(status, retention_tier, compact_after, delete_after)`);
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS interteam_processing (
      message_pk uuid PRIMARY KEY REFERENCES interteam_messages(id) ON DELETE CASCADE,
      local_team_id text NOT NULL,
      local_query_id text NOT NULL,
      handler_agent_id text NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      UNIQUE(local_team_id, local_query_id)
    )
  `);
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS interteam_message_receipts (
      submitter_node_id text NOT NULL,
      message_id text NOT NULL,
      conversation_pk uuid NOT NULL REFERENCES interteam_conversations(id) ON DELETE RESTRICT,
      comparison_identity text NOT NULL,
      position integer NOT NULL,
      predecessor_message_id text,
      status text NOT NULL CHECK (status IN ('completed', 'failed')),
      last_confirmed_status text NOT NULL CHECK (last_confirmed_status IN ('completed', 'failed')),
      terminal_at bigint NOT NULL,
      deleted_at bigint NOT NULL,
      PRIMARY KEY (submitter_node_id, message_id)
    )
  `);
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS interteam_origin_allocations (
      node_id text NOT NULL,
      id_kind text NOT NULL CHECK (id_kind IN ('conversation', 'message')),
      allocated_id text NOT NULL,
      created_at bigint NOT NULL,
      PRIMARY KEY (node_id, id_kind, allocated_id)
    )
  `);

  await adapter.query(`
    CREATE OR REPLACE FUNCTION validate_interteam_message_transition() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' AND NEW.status != 'accepted' THEN
        RAISE EXCEPTION 'interteam_initial_status_invalid' USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'UPDATE' AND NEW.status = 'processing' AND OLD.status != 'processing'
        AND NOT EXISTS (SELECT 1 FROM interteam_processing WHERE message_pk = NEW.id)
      THEN
        RAISE EXCEPTION 'durable_job_missing' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await adapter.query(`DROP TRIGGER IF EXISTS interteam_messages_validate_transition ON interteam_messages`);
  await adapter.query(`
    CREATE TRIGGER interteam_messages_validate_transition
    BEFORE INSERT OR UPDATE OF status ON interteam_messages
    FOR EACH ROW EXECUTE FUNCTION validate_interteam_message_transition()
  `);

  await adapter.query(`
    CREATE OR REPLACE FUNCTION block_team_delete_with_interteam_work() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM interteam_messages m
        JOIN interteam_conversations c ON c.id = m.conversation_pk
        WHERE (c.origin_team_id = OLD.id::text OR c.destination_team_id = OLD.id::text)
          AND m.status IN ('accepted', 'processing', 'unknown')
      ) THEN
        RAISE EXCEPTION 'interteam_team_has_active_work' USING ERRCODE = '23503';
      END IF;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql
  `);
  await adapter.query(`DROP TRIGGER IF EXISTS teams_block_delete_with_interteam_work ON teams`);
  await adapter.query(`
    CREATE TRIGGER teams_block_delete_with_interteam_work
    BEFORE DELETE ON teams
    FOR EACH ROW EXECUTE FUNCTION block_team_delete_with_interteam_work()
  `);
}
