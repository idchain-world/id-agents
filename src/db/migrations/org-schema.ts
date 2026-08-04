// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../db-adapter.js';
import type { SqliteAdapter } from '../sqlite-adapter.js';

export async function migrateOrgSchemaSqlite(adapter: SqliteAdapter): Promise<void> {
  adapter.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS agents_team_id_id_unique ON agents(team_id, id);

    CREATE TABLE IF NOT EXISTS team_org_state (
      team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('normalized', 'intentionally_no_org', 'blocked')),
      decided_by TEXT NOT NULL,
      decided_at INTEGER NOT NULL,
      reason TEXT,
      source_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS org_groups (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      parent_group_id TEXT,
      name TEXT NOT NULL,
      name_normalized TEXT NOT NULL,
      description TEXT,
      position INTEGER NOT NULL CHECK (position >= 0),
      UNIQUE(team_id, id),
      FOREIGN KEY (team_id, parent_group_id)
        REFERENCES org_groups(team_id, id) ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS org_groups_root_name_unique
      ON org_groups(team_id, name_normalized) WHERE parent_group_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS org_groups_child_name_unique
      ON org_groups(team_id, parent_group_id, name_normalized) WHERE parent_group_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS org_groups_root_position_unique
      ON org_groups(team_id, position) WHERE parent_group_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS org_groups_child_position_unique
      ON org_groups(team_id, parent_group_id, position) WHERE parent_group_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS org_group_leads (
      team_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      PRIMARY KEY (group_id),
      FOREIGN KEY (team_id, group_id)
        REFERENCES org_groups(team_id, id) ON DELETE CASCADE,
      FOREIGN KEY (team_id, agent_id)
        REFERENCES agents(team_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS org_group_members (
      team_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (group_id, agent_id),
      UNIQUE(group_id, position),
      FOREIGN KEY (team_id, group_id)
        REFERENCES org_groups(team_id, id) ON DELETE CASCADE,
      FOREIGN KEY (team_id, agent_id)
        REFERENCES agents(team_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS org_tags (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_normalized TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      UNIQUE(team_id, id),
      UNIQUE(team_id, name_normalized),
      UNIQUE(team_id, position)
    );

    CREATE TABLE IF NOT EXISTS org_agent_tags (
      team_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (tag_id, agent_id),
      UNIQUE(tag_id, position),
      FOREIGN KEY (team_id, tag_id)
        REFERENCES org_tags(team_id, id) ON DELETE CASCADE,
      FOREIGN KEY (team_id, agent_id)
        REFERENCES agents(team_id, id) ON DELETE CASCADE
    );

    CREATE TRIGGER IF NOT EXISTS org_groups_no_cycle_insert
    BEFORE INSERT ON org_groups
    WHEN NEW.parent_group_id IS NOT NULL
    BEGIN
      WITH RECURSIVE ancestors(id) AS (
        SELECT NEW.parent_group_id
        UNION
        SELECT g.parent_group_id
        FROM org_groups g JOIN ancestors a ON g.id = a.id
        WHERE g.parent_group_id IS NOT NULL
      )
      SELECT CASE WHEN EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id)
        THEN RAISE(ABORT, 'org_group_cycle') END;
    END;

    CREATE TRIGGER IF NOT EXISTS org_groups_no_cycle_update
    BEFORE UPDATE OF parent_group_id, team_id ON org_groups
    WHEN NEW.parent_group_id IS NOT NULL
    BEGIN
      WITH RECURSIVE ancestors(id) AS (
        SELECT NEW.parent_group_id
        UNION
        SELECT g.parent_group_id
        FROM org_groups g JOIN ancestors a ON g.id = a.id
        WHERE g.parent_group_id IS NOT NULL
      )
      SELECT CASE WHEN EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id)
        THEN RAISE(ABORT, 'org_group_cycle') END;
    END;

    CREATE TRIGGER IF NOT EXISTS org_groups_compact_after_delete
    AFTER DELETE ON org_groups
    BEGIN
      UPDATE org_groups SET position = position - 1
      WHERE team_id = OLD.team_id
        AND ((OLD.parent_group_id IS NULL AND parent_group_id IS NULL)
          OR parent_group_id = OLD.parent_group_id)
        AND position > OLD.position;
    END;

    CREATE TRIGGER IF NOT EXISTS org_group_members_compact_after_delete
    AFTER DELETE ON org_group_members
    BEGIN
      UPDATE org_group_members SET position = position - 1
      WHERE group_id = OLD.group_id AND position > OLD.position;
    END;

    CREATE TRIGGER IF NOT EXISTS org_agent_tags_compact_after_delete
    AFTER DELETE ON org_agent_tags
    BEGIN
      UPDATE org_agent_tags SET position = position - 1
      WHERE tag_id = OLD.tag_id AND position > OLD.position;
    END;

    CREATE TRIGGER IF NOT EXISTS org_tags_compact_after_delete
    AFTER DELETE ON org_tags
    BEGIN
      UPDATE org_tags SET position = position - 1
      WHERE team_id = OLD.team_id AND position > OLD.position;
    END;
  `);
}

export async function migrateOrgSchemaPostgres(adapter: DbAdapter): Promise<void> {
  await adapter.query(`CREATE UNIQUE INDEX IF NOT EXISTS agents_team_id_id_unique ON agents(team_id, id)`);
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS team_org_state (
      team_id uuid PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('normalized', 'intentionally_no_org', 'blocked')),
      decided_by text NOT NULL,
      decided_at bigint NOT NULL,
      reason text,
      source_hash text
    )
  `);
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS org_groups (
      id uuid PRIMARY KEY,
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      parent_group_id uuid,
      name text NOT NULL,
      name_normalized text NOT NULL,
      description text,
      position integer NOT NULL CHECK (position >= 0),
      UNIQUE(team_id, id),
      FOREIGN KEY (team_id, parent_group_id)
        REFERENCES org_groups(team_id, id) ON DELETE RESTRICT
    )
  `);
  await adapter.query(`CREATE UNIQUE INDEX IF NOT EXISTS org_groups_root_name_unique ON org_groups(team_id, name_normalized) WHERE parent_group_id IS NULL`);
  await adapter.query(`CREATE UNIQUE INDEX IF NOT EXISTS org_groups_child_name_unique ON org_groups(team_id, parent_group_id, name_normalized) WHERE parent_group_id IS NOT NULL`);
  await adapter.query(`CREATE UNIQUE INDEX IF NOT EXISTS org_groups_root_position_unique ON org_groups(team_id, position) WHERE parent_group_id IS NULL`);
  await adapter.query(`CREATE UNIQUE INDEX IF NOT EXISTS org_groups_child_position_unique ON org_groups(team_id, parent_group_id, position) WHERE parent_group_id IS NOT NULL`);
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS org_group_leads (
      team_id uuid NOT NULL,
      group_id uuid PRIMARY KEY,
      agent_id text NOT NULL,
      FOREIGN KEY (team_id, group_id)
        REFERENCES org_groups(team_id, id) ON DELETE CASCADE,
      FOREIGN KEY (team_id, agent_id)
        REFERENCES agents(team_id, id) ON DELETE CASCADE
    )
  `);
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS org_group_members (
      team_id uuid NOT NULL,
      group_id uuid NOT NULL,
      agent_id text NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      PRIMARY KEY (group_id, agent_id),
      UNIQUE(group_id, position),
      FOREIGN KEY (team_id, group_id)
        REFERENCES org_groups(team_id, id) ON DELETE CASCADE,
      FOREIGN KEY (team_id, agent_id)
        REFERENCES agents(team_id, id) ON DELETE CASCADE
    )
  `);
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS org_tags (
      id uuid PRIMARY KEY,
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name text NOT NULL,
      name_normalized text NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      UNIQUE(team_id, id),
      UNIQUE(team_id, name_normalized),
      UNIQUE(team_id, position)
    )
  `);
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS org_agent_tags (
      team_id uuid NOT NULL,
      tag_id uuid NOT NULL,
      agent_id text NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      PRIMARY KEY (tag_id, agent_id),
      UNIQUE(tag_id, position),
      FOREIGN KEY (team_id, tag_id)
        REFERENCES org_tags(team_id, id) ON DELETE CASCADE,
      FOREIGN KEY (team_id, agent_id)
        REFERENCES agents(team_id, id) ON DELETE CASCADE
    )
  `);
  await adapter.query(`
    CREATE OR REPLACE FUNCTION reject_org_group_cycle() RETURNS trigger AS $$
    BEGIN
      IF NEW.parent_group_id IS NULL THEN RETURN NEW; END IF;
      IF EXISTS (
        WITH RECURSIVE ancestors(id) AS (
          SELECT NEW.parent_group_id
          UNION
          SELECT g.parent_group_id
          FROM org_groups g JOIN ancestors a ON g.id = a.id
          WHERE g.parent_group_id IS NOT NULL
        )
        SELECT 1 FROM ancestors WHERE id = NEW.id
      ) THEN
        RAISE EXCEPTION 'org_group_cycle' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await adapter.query(`DROP TRIGGER IF EXISTS org_groups_no_cycle_insert ON org_groups`);
  await adapter.query(`DROP TRIGGER IF EXISTS org_groups_no_cycle_update ON org_groups`);
  await adapter.query(`
    CREATE TRIGGER org_groups_no_cycle_insert
    BEFORE INSERT ON org_groups
    FOR EACH ROW EXECUTE FUNCTION reject_org_group_cycle()
  `);
  await adapter.query(`
    CREATE TRIGGER org_groups_no_cycle_update
    BEFORE UPDATE OF parent_group_id, team_id ON org_groups
    FOR EACH ROW EXECUTE FUNCTION reject_org_group_cycle()
  `);
  await adapter.query(`
    CREATE OR REPLACE FUNCTION compact_org_position_after_delete() RETURNS trigger AS $$
    BEGIN
      IF TG_TABLE_NAME = 'org_groups' THEN
        UPDATE org_groups SET position = position - 1
        WHERE team_id = OLD.team_id
          AND parent_group_id IS NOT DISTINCT FROM OLD.parent_group_id
          AND position > OLD.position;
      ELSIF TG_TABLE_NAME = 'org_group_members' THEN
        UPDATE org_group_members SET position = position - 1
        WHERE group_id = OLD.group_id AND position > OLD.position;
      ELSIF TG_TABLE_NAME = 'org_agent_tags' THEN
        UPDATE org_agent_tags SET position = position - 1
        WHERE tag_id = OLD.tag_id AND position > OLD.position;
      ELSIF TG_TABLE_NAME = 'org_tags' THEN
        UPDATE org_tags SET position = position - 1
        WHERE team_id = OLD.team_id AND position > OLD.position;
      END IF;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql
  `);
  for (const table of ['org_groups', 'org_group_members', 'org_agent_tags', 'org_tags']) {
    await adapter.query(`DROP TRIGGER IF EXISTS ${table}_compact_after_delete ON ${table}`);
    await adapter.query(`
      CREATE TRIGGER ${table}_compact_after_delete
      AFTER DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION compact_org_position_after_delete()
    `);
  }
}
