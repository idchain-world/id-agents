// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { DbAdapter } from '../db-adapter.js';
import type { SqliteAdapter } from '../sqlite-adapter.js';

/** Commit 4: intrinsic manager identity, team settings, and sender-owned contacts. */
export async function migrateInterteamFoundationSqlite(adapter: SqliteAdapter): Promise<void> {
  adapter.exec(`
    CREATE TABLE IF NOT EXISTS manager_identity (
      singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
      node_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const now = Date.now();
  await adapter.query(
    `INSERT OR IGNORE INTO manager_identity
       (singleton_key, node_id, created_at, updated_at)
     VALUES (1, ?, ?, ?)`,
    [randomUUID(), now, now],
  );

  const teamColumns = await adapter.query<{ name: string }>(`SELECT name FROM pragma_table_info('teams')`);
  const existingTeamColumns = new Set(teamColumns.rows.map((row) => row.name));
  if (!existingTeamColumns.has('inbound_policy')) {
    adapter.exec(`ALTER TABLE teams ADD COLUMN inbound_policy TEXT NOT NULL DEFAULT 'closed'
      CHECK (inbound_policy IN ('open', 'closed'))`);
  }
  if (!existingTeamColumns.has('lead_agent_id')) {
    adapter.exec(`ALTER TABLE teams ADD COLUMN lead_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL`);
  }

  adapter.exec(`
    CREATE TABLE IF NOT EXISTS team_contacts (
      id TEXT PRIMARY KEY,
      local_team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      alias_normalized TEXT NOT NULL,
      alias_display TEXT NOT NULL,
      remote_node_id TEXT NOT NULL,
      remote_team_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(local_team_id, alias_normalized)
    );

    CREATE INDEX IF NOT EXISTS team_contacts_remote_pin_idx
      ON team_contacts(remote_node_id, remote_team_id);

    CREATE TRIGGER IF NOT EXISTS teams_lead_same_team_insert
    BEFORE INSERT ON teams
    WHEN NEW.lead_agent_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agents
        WHERE id = NEW.lead_agent_id AND team_id = NEW.id AND deleted_at IS NULL
      )
    BEGIN
      SELECT RAISE(ABORT, 'team_lead_invalid');
    END;

    CREATE TRIGGER IF NOT EXISTS teams_lead_same_team_update
    BEFORE UPDATE OF lead_agent_id, id ON teams
    WHEN NEW.lead_agent_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agents
        WHERE id = NEW.lead_agent_id AND team_id = NEW.id AND deleted_at IS NULL
      )
    BEGIN
      SELECT RAISE(ABORT, 'team_lead_invalid');
    END;

    CREATE TRIGGER IF NOT EXISTS agents_clear_team_lead_soft_delete
    AFTER UPDATE OF deleted_at ON agents
    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
    BEGIN
      UPDATE teams SET lead_agent_id = NULL WHERE lead_agent_id = NEW.id;
    END;
  `);
}

/** PostgreSQL equivalent of the commit-4 foundation migration. */
export async function migrateInterteamFoundationPostgres(adapter: DbAdapter): Promise<void> {
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS manager_identity (
      singleton_key smallint PRIMARY KEY CHECK (singleton_key = 1),
      node_id uuid NOT NULL UNIQUE,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    )
  `);
  const now = Date.now();
  await adapter.query(
    `INSERT INTO manager_identity (singleton_key, node_id, created_at, updated_at)
     VALUES (1, $1, $2, $2)
     ON CONFLICT (singleton_key) DO NOTHING`,
    [randomUUID(), now],
  );

  await adapter.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS inbound_policy text NOT NULL DEFAULT 'closed'`);
  await adapter.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS lead_agent_id text`);
  await adapter.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_inbound_policy_check') THEN
        ALTER TABLE teams ADD CONSTRAINT teams_inbound_policy_check
          CHECK (inbound_policy IN ('open', 'closed'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_lead_agent_fk') THEN
        ALTER TABLE teams ADD CONSTRAINT teams_lead_agent_fk
          FOREIGN KEY (lead_agent_id) REFERENCES agents(id) ON DELETE SET NULL;
      END IF;
    END $$
  `);

  await adapter.query(`
    CREATE TABLE IF NOT EXISTS team_contacts (
      id uuid PRIMARY KEY,
      local_team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      alias_normalized text NOT NULL,
      alias_display text NOT NULL,
      remote_node_id text NOT NULL,
      remote_team_id text NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      UNIQUE(local_team_id, alias_normalized)
    )
  `);
  await adapter.query(`CREATE INDEX IF NOT EXISTS team_contacts_remote_pin_idx ON team_contacts(remote_node_id, remote_team_id)`);

  await adapter.query(`
    CREATE OR REPLACE FUNCTION validate_team_lead() RETURNS trigger AS $$
    BEGIN
      IF NEW.lead_agent_id IS NULL THEN RETURN NEW; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM agents
        WHERE id = NEW.lead_agent_id AND team_id = NEW.id AND deleted_at IS NULL
      ) THEN
        RAISE EXCEPTION 'team_lead_invalid' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await adapter.query(`DROP TRIGGER IF EXISTS teams_lead_same_team ON teams`);
  await adapter.query(`
    CREATE TRIGGER teams_lead_same_team
    BEFORE INSERT OR UPDATE OF lead_agent_id, id ON teams
    FOR EACH ROW EXECUTE FUNCTION validate_team_lead()
  `);

  await adapter.query(`
    CREATE OR REPLACE FUNCTION clear_team_lead_on_soft_delete() RETURNS trigger AS $$
    BEGIN
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        UPDATE teams SET lead_agent_id = NULL WHERE lead_agent_id = NEW.id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await adapter.query(`DROP TRIGGER IF EXISTS agents_clear_team_lead_soft_delete ON agents`);
  await adapter.query(`
    CREATE TRIGGER agents_clear_team_lead_soft_delete
    AFTER UPDATE OF deleted_at ON agents
    FOR EACH ROW EXECUTE FUNCTION clear_team_lead_on_soft_delete()
  `);
}
