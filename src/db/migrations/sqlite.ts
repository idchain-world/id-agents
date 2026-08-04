// SPDX-License-Identifier: MIT

import crypto from 'crypto';
import type { SqliteAdapter } from '../sqlite-adapter.js';
import { migrateOrgSchemaSqlite } from './org-schema.js';

/** PK (team_id, query_id); nullable agent_id for manager inbox rows. */
async function migrateQueriesTeamQueryPkSqlite(adapter: SqliteAdapter): Promise<void> {
  const { rows } = await adapter.query<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='queries'`,
  );
  if (!rows[0]?.sql) return;
  const norm = rows[0].sql.toLowerCase().replace(/\s+/g, ' ');
  if (
    norm.includes('primary key (team_id, query_id)') ||
    norm.includes('primary key(team_id,query_id)')
  ) {
    return;
  }

  adapter.exec(`
    ALTER TABLE queries RENAME TO queries_legacy_mgrfk;

    CREATE TABLE queries (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      query_id TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT,
      created INTEGER NOT NULL,
      completed INTEGER,
      result TEXT,
      error TEXT,
      session_id TEXT,
      owner_kind TEXT NOT NULL DEFAULT 'agent',
      owner_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (team_id, query_id)
    );

    INSERT INTO queries SELECT * FROM queries_legacy_mgrfk;

    DROP TABLE queries_legacy_mgrfk;
  `);
  adapter.exec(
    `CREATE INDEX IF NOT EXISTS queries_team_owner_idx ON queries(team_id, owner_kind, owner_id)`,
  );
}

/** Nullable agent_id for manager-owned news rows (preserve ids). */
async function migrateNewsItemsNullableAgentSqlite(adapter: SqliteAdapter): Promise<void> {
  const meta = await adapter.query<Record<string, unknown>>(
    `SELECT * FROM pragma_table_info('news_items') WHERE name='agent_id'`,
  );
  const pinfo = meta.rows[0];
  if (!pinfo) return;
  const nn = Number((pinfo as { notnull?: unknown }).notnull ?? 0);
  if (nn === 0) return;

  adapter.exec(`DROP INDEX IF EXISTS news_items_agent_time_idx`);
  adapter.exec(`DROP INDEX IF EXISTS news_items_query_idx`);

  adapter.exec(`
    ALTER TABLE news_items RENAME TO news_items_legacy_nn;

    CREATE TABLE news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT,
      data TEXT,
      query_id TEXT,
      kind TEXT,
      reply_expected INTEGER,
      owner_kind TEXT NOT NULL DEFAULT 'agent',
      owner_id TEXT NOT NULL DEFAULT ''
    );

    INSERT INTO news_items SELECT * FROM news_items_legacy_nn;

    DROP TABLE news_items_legacy_nn;
  `);

  adapter.exec(`
    CREATE INDEX IF NOT EXISTS news_items_agent_time_idx ON news_items(team_id, agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS news_items_query_idx ON news_items(team_id, agent_id, query_id);
    CREATE INDEX IF NOT EXISTS news_items_team_owner_time_idx ON news_items(team_id, owner_kind, owner_id, timestamp);
    CREATE INDEX IF NOT EXISTS news_items_owner_query_idx ON news_items(team_id, owner_kind, owner_id, query_id);
  `);
}

/**
 * Null manager-owned FK slots and delete hidden manager-<team> shadow agent rows.
 * Hard-fails if orphan refs would violate integrity (runs after PK/nullable migrations).
 */
export async function migrateDeleteManagerShadowAgentsSqlite(adapter: SqliteAdapter): Promise<void> {
  const probe = async (sql: string): Promise<number> => {
    try {
      const r = await adapter.query<{ c: number }>(sql);
      return Number(r.rows[0]?.c ?? 0);
    } catch {
      return 0;
    }
  };

  const hardOrphans: Array<{ label: string; sql: string }> = [
    { label: 'wallets', sql: `SELECT COUNT(*) as c FROM wallets WHERE agent_id GLOB 'manager-*'` },
    {
      label: 'schedule_targets',
      sql: `SELECT COUNT(*) as c FROM schedule_targets WHERE agent_id GLOB 'manager-*'`,
    },
    { label: 'schedule_runs', sql: `SELECT COUNT(*) as c FROM schedule_runs WHERE agent_id GLOB 'manager-*'` },
  ];
  for (const { label, sql } of hardOrphans) {
    const c = await probe(sql);
    if (c > 0) {
      throw new Error(
        `migrateDeleteManagerShadowAgentsSqlite: ${c} row(s) in ${label} still reference manager-* ids`,
      );
    }
  }

  // Historical manager-created tasks/checkins can safely lose the shadow FK:
  // these columns are nullable metadata, unlike wallets/schedule tables above.
  await adapter.query(`UPDATE tasks SET owner = NULL WHERE owner GLOB 'manager-*' OR owner = 'virtual_manager'`);
  await adapter.query(`UPDATE tasks SET created_by = NULL WHERE created_by GLOB 'manager-*' OR created_by = 'virtual_manager'`);
  await adapter.query(`UPDATE checkins SET owner_agent_id = NULL WHERE owner_agent_id GLOB 'manager-*' OR owner_agent_id = 'virtual_manager'`);
  await adapter.query(`UPDATE checkins SET created_by_agent_id = NULL WHERE created_by_agent_id GLOB 'manager-*' OR created_by_agent_id = 'virtual_manager'`);

  // Legacy default-team manager rows used `virtual_manager` as the agent FK
  // before owner_kind/owner_id existed. Promote them to manager ownership so
  // the rest of the cleanup can treat them exactly like manager-<team> rows.
  await adapter.query(`
    UPDATE queries
    SET owner_kind = 'manager',
        owner_id = team_id
    WHERE agent_id = 'virtual_manager'
      AND owner_kind = 'agent'
      AND owner_id = 'virtual_manager'
  `);
  await adapter.query(`
    UPDATE news_items
    SET owner_kind = 'manager',
        owner_id = team_id
    WHERE agent_id = 'virtual_manager'
      AND owner_kind = 'agent'
      AND owner_id = 'virtual_manager'
  `);

  const badQ = await adapter.query<{ c: number }>(`
    SELECT COUNT(*) as c FROM queries
    WHERE agent_id IS NOT NULL AND (agent_id GLOB 'manager-*' OR agent_id = 'virtual_manager')
      AND (owner_kind != 'manager' OR owner_id != team_id)
  `);
  if (Number(badQ.rows[0]?.c) > 0) {
    throw new Error(
      'migrateDeleteManagerShadowAgentsSqlite: queries rows carry manager-* agent_id without owner_kind=manager + owner_id=team_id',
    );
  }

  const badN = await adapter.query<{ c: number }>(`
    SELECT COUNT(*) as c FROM news_items
    WHERE agent_id IS NOT NULL AND (agent_id GLOB 'manager-*' OR agent_id = 'virtual_manager')
      AND (owner_kind != 'manager' OR owner_id != team_id)
  `);
  if (Number(badN.rows[0]?.c) > 0) {
    throw new Error(
      'migrateDeleteManagerShadowAgentsSqlite: news_items carry manager-* agent_id without owner_kind=manager + owner_id=team_id',
    );
  }

  await adapter.query(`UPDATE queries SET agent_id = NULL WHERE owner_kind = 'manager'`);
  await adapter.query(`UPDATE news_items SET agent_id = NULL WHERE owner_kind = 'manager'`);

  const leftQ = await adapter.query<{ c: number }>(
    `SELECT COUNT(*) as c FROM queries WHERE agent_id IS NOT NULL AND (agent_id GLOB 'manager-*' OR agent_id = 'virtual_manager')`,
  );
  if (Number(leftQ.rows[0]?.c) > 0) {
    throw new Error(
      'migrateDeleteManagerShadowAgentsSqlite: queries still reference manager-* after owner nulling — migrate writes before rerunning delete migration',
    );
  }

  const leftN = await adapter.query<{ c: number }>(
    `SELECT COUNT(*) as c FROM news_items WHERE agent_id IS NOT NULL AND (agent_id GLOB 'manager-*' OR agent_id = 'virtual_manager')`,
  );
  if (Number(leftN.rows[0]?.c) > 0) {
    throw new Error(
      'migrateDeleteManagerShadowAgentsSqlite: news_items still reference manager-* after owner nulling',
    );
  }

  await adapter.query(`DELETE FROM agents WHERE id GLOB 'manager-*' OR id = 'virtual_manager'`);
}

export async function migrateSqlite(adapter: SqliteAdapter): Promise<void> {
  adapter.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      port_start INTEGER NOT NULL DEFAULT 4101,
      port_end INTEGER NOT NULL DEFAULT 4125,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      model TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 0,
      endpoint TEXT,
      working_directory TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      registry TEXT,
      metadata TEXT,
      deleted_at INTEGER,
      runtime TEXT DEFAULT 'claude-agent-sdk',
      token_id TEXT,
      domain TEXT,
      api_key TEXT,
      customer_domain TEXT,
      public_endpoint_url TEXT,
      internal_endpoint_url TEXT,
      ssh_target TEXT
    );

    CREATE TABLE IF NOT EXISTS wallets (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      address TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id)
    );

    CREATE TABLE IF NOT EXISTS news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT,
      data TEXT,
      query_id TEXT,
      kind TEXT,
      reply_expected INTEGER,
      owner_kind TEXT NOT NULL DEFAULT 'agent',
      owner_id TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS queries (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      query_id TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT,
      created INTEGER NOT NULL,
      completed INTEGER,
      result TEXT,
      error TEXT,
      session_id TEXT,
      owner_kind TEXT NOT NULL DEFAULT 'agent',
      owner_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (team_id, query_id)
    );

    CREATE INDEX IF NOT EXISTS agents_team_name_idx ON agents(team_id, name);
    CREATE INDEX IF NOT EXISTS news_items_agent_time_idx ON news_items(team_id, agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS news_items_query_idx ON news_items(team_id, agent_id, query_id);
    CREATE INDEX IF NOT EXISTS agents_token_idx ON agents(token_id) WHERE token_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS schedule_definitions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      message TEXT NOT NULL,
      sender TEXT NOT NULL DEFAULT 'schedule',
      delivery_mode TEXT NOT NULL DEFAULT 'talk',
      timezone TEXT,
      catch_up_policy TEXT NOT NULL DEFAULT 'skip',
      dedupe_window_seconds INTEGER NOT NULL DEFAULT 90,
      interval_seconds INTEGER,
      anchor_at INTEGER,
      max_runs INTEGER,
      expires_at INTEGER,
      local_time_seconds INTEGER,
      local_date TEXT,
      days_of_week TEXT,
      source_type TEXT NOT NULL DEFAULT 'yaml',
      source_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_targets (
      schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      PRIMARY KEY (schedule_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS schedule_runs (
      schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      scheduled_key TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      fired_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      PRIMARY KEY (schedule_id, agent_id, scheduled_key)
    );

    CREATE INDEX IF NOT EXISTS schedule_runs_schedule_idx ON schedule_runs(schedule_id, fired_at);
    CREATE INDEX IF NOT EXISTS schedule_runs_agent_idx ON schedule_runs(agent_id, fired_at);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      uuid TEXT,
      team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      created_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
      owner TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(team_id, name)
    );

    CREATE TABLE IF NOT EXISTS task_event_links (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, schedule_id)
    );

    CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner, status, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_team_idx ON tasks(team_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS task_event_links_schedule_idx ON task_event_links(schedule_id, task_id);

    CREATE TABLE IF NOT EXISTS event_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      actor_agent_id TEXT,
      subject_kind TEXT,
      subject_id TEXT,
      occurred_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS event_log_team_seq_idx ON event_log(team_id, seq);
    CREATE INDEX IF NOT EXISTS event_log_team_topic_seq_idx ON event_log(team_id, topic, seq);
    CREATE INDEX IF NOT EXISTS event_log_team_subject_idx ON event_log(team_id, subject_kind, subject_id, seq);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      owner_agent_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      filter_json TEXT NOT NULL,
      target_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_acked_seq INTEGER,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS subscriptions_team_owner_idx
      ON subscriptions(team_id, owner_agent_id, status);

    CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      event_seq INTEGER NOT NULL,
      scheduled_at INTEGER NOT NULL,
      attempted_at INTEGER,
      status TEXT NOT NULL,
      http_status INTEGER,
      error TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS webhook_delivery_once_idx
      ON webhook_delivery_attempts(subscription_id, event_seq);

    CREATE TABLE IF NOT EXISTS checkins (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      linked_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      interval_seconds INTEGER NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL,
      close_when TEXT NOT NULL,
      max_iterations INTEGER,
      iteration_count INTEGER NOT NULL DEFAULT 0,
      next_fire_at INTEGER,
      snooze_until INTEGER,
      ttl_expires_at INTEGER,
      last_fire_at INTEGER,
      last_event_seq INTEGER REFERENCES event_log(seq) ON DELETE SET NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      closed_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS checkins_due_idx
      ON checkins(team_id, status, next_fire_at)
      WHERE next_fire_at IS NOT NULL;

    CREATE INDEX IF NOT EXISTS checkins_owner_idx
      ON checkins(team_id, owner_agent_id, status, updated_at);

    CREATE INDEX IF NOT EXISTS checkins_task_idx
      ON checkins(team_id, linked_task_id, status);

    CREATE INDEX IF NOT EXISTS checkins_ttl_idx
      ON checkins(team_id, ttl_expires_at)
      WHERE ttl_expires_at IS NOT NULL AND status IN ('active', 'snoozed');
  `);

  try {
    adapter.exec(`ALTER TABLE schedule_definitions ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'talk'`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // Tasks: add uuid column for short-id lookups (#xxxxxxxx)
  try {
    adapter.exec(`ALTER TABLE tasks ADD COLUMN uuid TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // news_items: layered metadata (talk|notify plus reply_expected) on top of
  // the existing event `type`. Populated on new writes; old rows stay null.
  try {
    adapter.exec(`ALTER TABLE news_items ADD COLUMN kind TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE news_items ADD COLUMN reply_expected INTEGER`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // queries / news_items: inbox ownership (owner_kind + owner_id), legacy agent_id retained.
  try {
    adapter.exec(`ALTER TABLE queries ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'agent'`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE queries ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE news_items ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'agent'`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE news_items ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`);
  } catch {
    // Column already exists in upgraded databases.
  }
  await adapter.query(`
    UPDATE queries SET
      owner_kind = CASE WHEN agent_id GLOB 'manager-*' THEN 'manager' ELSE 'agent' END,
      owner_id = CASE WHEN agent_id GLOB 'manager-*' THEN team_id ELSE agent_id END
    WHERE owner_id = ''
  `);
  await adapter.query(`
    UPDATE news_items SET
      owner_kind = CASE WHEN agent_id GLOB 'manager-*' THEN 'manager' ELSE 'agent' END,
      owner_id = CASE WHEN agent_id GLOB 'manager-*' THEN team_id ELSE agent_id END
    WHERE owner_id = ''
  `);
  adapter.exec(`
    CREATE INDEX IF NOT EXISTS queries_team_owner_idx ON queries(team_id, owner_kind, owner_id);
    CREATE INDEX IF NOT EXISTS news_items_team_owner_time_idx ON news_items(team_id, owner_kind, owner_id, timestamp);
    CREATE INDEX IF NOT EXISTS news_items_owner_query_idx ON news_items(team_id, owner_kind, owner_id, query_id);
  `);

  // Remote endpoint columns for public-agent-remote registry entries (Phase 2).
  // All four columns are nullable so existing rows stay intact (backfill-safe).
  // Each ALTER is wrapped in try/catch so a repeated migration call is a no-op.
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN customer_domain TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN public_endpoint_url TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN internal_endpoint_url TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN ssh_target TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // Phase 5: remote heartbeat probe columns.
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN last_seen INTEGER`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN last_probed_at INTEGER`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN last_error TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // Backfill uuid for any existing rows that lack one
  const missing = await adapter.query<{ id: string }>(`SELECT id FROM tasks WHERE uuid IS NULL OR uuid = ''`);
  for (const row of missing.rows) {
    await adapter.query(`UPDATE tasks SET uuid = ? WHERE id = ?`, [crypto.randomUUID(), row.id]);
  }

  adapter.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tasks_uuid_idx ON tasks(uuid)`);

  await migrateQueriesTeamQueryPkSqlite(adapter);
  await migrateNewsItemsNullableAgentSqlite(adapter);
  await migrateDeleteManagerShadowAgentsSqlite(adapter);

  // Tasks: migrate from global name UNIQUE to (team_id, name) UNIQUE.
  // SQLite does not support DROP CONSTRAINT, so we use the rename-copy-swap pattern
  // guarded by a PRAGMA check to detect whether the old global uniqueness is still present.
  await migrateTasks_TeamNameUnique(adapter);
  await migrateTaskEventLinks_TasksReference(adapter);
  await migrateOrgSchemaSqlite(adapter);
}

/**
 * Idempotent migration: change tasks uniqueness from `name UNIQUE` to
 * `UNIQUE(team_id, name)`.
 *
 * Approach: check if the tasks table has a column-level UNIQUE on `name`
 * (present when `name TEXT NOT NULL UNIQUE` was used). If it does, rebuild
 * the table with the new composite constraint.
 *
 * This runs on every start but is a no-op if the constraint is already correct.
 */
async function migrateTasks_TeamNameUnique(adapter: SqliteAdapter): Promise<void> {
  // Inspect the existing CREATE TABLE SQL for the tasks table
  const { rows } = await adapter.query<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`,
  );
  if (!rows[0]) return; // table doesn't exist yet (first run handled by CREATE TABLE above)

  const ddl = rows[0].sql || '';

  // If the DDL already has UNIQUE(team_id, name), migration is done
  if (ddl.includes('UNIQUE(team_id, name)') || ddl.includes('UNIQUE (team_id, name)')) return;

  // Check whether the old global name UNIQUE is present (column-level UNIQUE on name)
  // Look for 'name TEXT NOT NULL UNIQUE' pattern
  if (!ddl.toLowerCase().includes('name text not null unique')) return;

  // Rename-copy-swap migration
  adapter.exec(`
    ALTER TABLE tasks RENAME TO tasks_old;

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      uuid TEXT,
      team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      created_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
      owner TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(team_id, name)
    );

    INSERT INTO tasks SELECT * FROM tasks_old;

    DROP TABLE tasks_old;

    CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner, status, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_team_idx ON tasks(team_id, status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_uuid_idx ON tasks(uuid);
  `);
}

/**
 * Repair task_event_links databases that were present during the tasks table
 * rebuild above. SQLite rewrites child foreign-key DDL on ALTER TABLE RENAME,
 * so task_event_links can end up referencing the temporary tasks_old table
 * after tasks_old is dropped.
 */
async function migrateTaskEventLinks_TasksReference(adapter: SqliteAdapter): Promise<void> {
  const { rows } = await adapter.query<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_event_links'`,
  );
  const ddl = rows[0]?.sql || '';
  if (!ddl.includes('tasks_old')) return;

  adapter.exec(`DROP INDEX IF EXISTS task_event_links_schedule_idx`);
  adapter.exec(`
    CREATE TABLE task_event_links_new (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, schedule_id)
    );

    INSERT INTO task_event_links_new (task_id, schedule_id, created_at)
      SELECT task_id, schedule_id, created_at FROM task_event_links;

    DROP TABLE task_event_links;
    ALTER TABLE task_event_links_new RENAME TO task_event_links;
  `);
  adapter.exec(`CREATE INDEX IF NOT EXISTS task_event_links_schedule_idx ON task_event_links(schedule_id, task_id)`);
}

/**
 * Reverse inbox ownership projection for legacy readers: for rows with
 * `owner_kind = 'manager'`, set `agent_id = manager-<team name>` from `teams`.
 * Not run on startup — tests call this explicitly.
 */
export async function downMigrateInboxOwnershipSqlite(adapter: SqliteAdapter): Promise<void> {
  await adapter.query(`
    UPDATE queries
    SET agent_id = 'manager-' || (SELECT name FROM teams WHERE teams.id = queries.team_id)
    WHERE owner_kind = 'manager'
  `);
  await adapter.query(`
    UPDATE news_items
    SET agent_id = 'manager-' || (SELECT name FROM teams WHERE teams.id = news_items.team_id)
    WHERE owner_kind = 'manager'
  `);
}

/**
 * Recreate hidden manager-<team> stub rows then dual-write legacy agent_id (tests / rollback).
 */
export async function downMigrateRecreateManagerShadowAgentsSqlite(adapter: SqliteAdapter): Promise<void> {
  const ts = Date.now();
  const meta = JSON.stringify({ canReceiveDirectMessages: false, shadowOnly: true });
  const { rows: teams } = await adapter.query<{ id: string; name: string }>(
    `SELECT id, name FROM teams`,
  );
  for (const t of teams) {
    const shadowId = `manager-${t.name}`;
    const { rows: cntRows } = await adapter.query<{ c: number }>(
      `SELECT (
        (SELECT COUNT(*) FROM queries WHERE team_id = ? AND owner_kind = 'manager') +
        (SELECT COUNT(*) FROM news_items WHERE team_id = ? AND owner_kind = 'manager')
      ) AS c`,
      [t.id, t.id],
    );
    if (Number(cntRows[0]?.c) === 0) continue;

    await adapter.query(
      `INSERT OR REPLACE INTO agents (
        id, team_id, name, type, model, port, endpoint, working_directory,
        status, created_at, registry, metadata, deleted_at, runtime,
        token_id, domain, api_key,
        customer_domain, public_endpoint_url, internal_endpoint_url, ssh_target,
        last_seen, last_probed_at, last_error, consecutive_failures
      ) VALUES (
        ?, ?, 'manager', 'interactive', '', 0, '', NULL,
        'stub', ?, NULL, ?, ?, 'claude-agent-sdk',
        NULL, NULL, NULL,
        NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, 0
      )`,
      [shadowId, t.id, ts, meta, ts],
    );
  }
  await downMigrateInboxOwnershipSqlite(adapter);
}
