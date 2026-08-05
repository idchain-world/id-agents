// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { DbAdapter } from '../../src/db/db-adapter.js';
import { parseJsonObject } from '../../src/db/db-json.js';
import { PgAdapter } from '../../src/db/pg-adapter.js';
import { migratePostgres } from '../../src/db/migrations/postgres.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { InterteamFoundationStore } from '../../src/inter-team/foundation-store.js';
import {
  LOCAL_TRUST_BOUNDARY_NOTICE,
  deriveLocalTeamId,
  resolveOwnedContact,
  type TrustedLocalSourceContext,
} from '../../src/inter-team/local-context.js';
import {
  InterteamOperatorConfigService,
  type OperatorConfigContext,
} from '../../src/inter-team/operator-config.js';

const postgresUrl = process.env.TEST_ORG_POSTGRES_URL;
const dialects: Array<'sqlite' | 'postgres'> = postgresUrl ? ['sqlite', 'postgres'] : ['sqlite'];

function sql(db: DbAdapter, text: string): string {
  if (db.dialect === 'sqlite') return text;
  let index = 0;
  return text.replace(/\?/g, () => `$${++index}`);
}

async function q<T = unknown>(db: DbAdapter, text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql(db, text), params)).rows;
}

async function freshAdapter(dialect: 'sqlite' | 'postgres'): Promise<DbAdapter> {
  if (dialect === 'sqlite') {
    const db = new SqliteAdapter(':memory:');
    await migrateSqlite(db);
    return db;
  }
  if (!postgresUrl || !postgresUrl.includes('org_test')) {
    throw new Error('TEST_ORG_POSTGRES_URL must name a disposable database containing org_test');
  }
  const db = new PgAdapter(new Pool({ connectionString: postgresUrl }));
  await db.query(`DROP SCHEMA public CASCADE`);
  await db.query(`CREATE SCHEMA public`);
  await migratePostgres(db);
  return db;
}

describe.each(dialects)('interteam operator configuration parity (%s)', (dialect) => {
  let db: DbAdapter;
  let service: InterteamOperatorConfigService;
  let teamA: string;
  let teamB: string;
  let agentA: string;
  let contextA: OperatorConfigContext;
  let contextB: OperatorConfigContext;

  beforeEach(async () => {
    db = await freshAdapter(dialect);
    service = new InterteamOperatorConfigService(db);
    teamA = randomUUID();
    teamB = randomUUID();
    agentA = `agent-${randomUUID()}`;
    await q(db, `INSERT INTO teams (id, name) VALUES (?, ?), (?, ?)`, [teamA, `a-${randomUUID()}`, teamB, `b-${randomUUID()}`]);
    await q(
      db,
      `INSERT INTO agents
         (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
       VALUES (?, ?, 'worker-a', 'claude', 'model', 0, 'stopped', 1, ?, 'codex')`,
      [agentA, teamA, dialect === 'sqlite' ? '{}' : {}],
    );
    await q(
      db,
      `INSERT INTO agents
         (id, team_id, name, type, model, port, status, created_at, metadata, runtime)
       VALUES (?, ?, 'worker-from-another-team', 'claude', 'model', 0, 'running', 1, ?, 'codex')`,
      [`agent-${randomUUID()}`, teamB, dialect === 'sqlite' ? '{}' : {}],
    );
    contextA = { localTeamId: teamA, teamName: 'team-a', principal: 'operator', agentId: agentA };
    contextB = { localTeamId: teamB, teamName: 'team-b', principal: 'operator', agentId: null };
  });

  afterEach(async () => {
    await db.close();
  });

  it('derives source team from context and keeps contact-owner errors distinct', async () => {
    const createdA = await service.createContact(contextA, {
      aliasDisplay: 'Partner',
      remoteNodeId: 'opaque-node-a',
      remoteTeamId: 'opaque-team-a',
    }, 10);
    const createdB = await service.createContact(contextB, {
      aliasDisplay: 'Partner',
      remoteNodeId: 'opaque-node-b',
      remoteTeamId: 'opaque-team-b',
    }, 11);
    expect(createdA.contact.aliasNormalized).toBe(createdB.contact.aliasNormalized);
    expect(createdA.contact.localTeamId).not.toBe(createdB.contact.localTeamId);

    expect(() => deriveLocalTeamId(contextA, { localTeamId: teamB }))
      .toThrow('source_context_mismatch');
    await expect(resolveOwnedContact(new InterteamFoundationStore(db), {
      context: contextB,
      contactId: createdA.contact.id,
    })).rejects.toMatchObject({ code: 'source_unauthorized' });
    await expect(resolveOwnedContact(new InterteamFoundationStore(db), {
      context: contextB,
      alias: 'partner',
    })).resolves.toMatchObject({ id: createdB.contact.id });
    expect(Number((await q<{ count: number | string }>(
      db,
      `SELECT COUNT(*) AS count FROM event_log WHERE topic = 'interteam:operator_config'`,
    ))[0].count)).toBe(2);
  });

  it('allows stopped leads and open policy while reporting degraded availability', async () => {
    const lead = await service.setTeamLead(contextA, { agentId: agentA }, 20);
    expect(lead.lead).toEqual({
      agentId: agentA,
      status: 'stopped',
      available: false,
      degradedReason: 'recipient_unavailable',
    });
    const policy = await service.setInboundPolicy(contextA, { policy: 'open' }, 21);
    expect(policy.settings).toMatchObject({ inboundPolicy: 'open', leadAgentId: agentA });
    expect((await service.read(contextA)).lead.available).toBe(false);
  });

  it('atomically replaces org state and enumerates every destructive removal', async () => {
    await service.replaceOrg(contextA, {
      org: {
        groups: { Root: { groups: { Old: { members: ['worker-a'] } } } },
        tags: { Maintainer: ['worker-a'] },
      },
      reason: 'initial chart',
    }, 30);
    const replaced = await service.replaceOrg(contextA, {
      org: { groups: { Root: {} } },
      reason: 'remove retired subgroup',
    }, 31);
    expect(replaced.removal).toEqual({
      removedGroups: ['Root/Old'],
      removedMembershipAssignments: 1,
      removedTagAssignments: 1,
    });
    expect(replaced.audit.data).toMatchObject(replaced.removal);
    const auditRow = (await q<{ data: unknown }>(
      db,
      `SELECT data FROM event_log WHERE topic = 'interteam:operator_config' ORDER BY seq DESC LIMIT 1`,
    ))[0];
    expect(parseJsonObject(auditRow.data)).toMatchObject({
      action: 'normalized_org_replaced',
      ...replaced.removal,
    });
    await expect(service.replaceOrg(contextA, {
      org: { groups: { Invalid: { members: ['worker-from-another-team'] } } },
    })).rejects.toMatchObject({ code: 'org_reference_unresolved' });
    expect((await service.read(contextA)).org).toEqual({ groups: { Root: {} } });
  });

  it('rolls back a mutation when its audit append fails', async () => {
    if (dialect === 'sqlite') {
      await db.query(`CREATE TRIGGER reject_interteam_operator_audit
        BEFORE INSERT ON event_log
        WHEN NEW.topic = 'interteam:operator_config'
        BEGIN SELECT RAISE(ABORT, 'audit_failed'); END`);
    } else {
      await db.query(`CREATE FUNCTION reject_interteam_operator_audit() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'audit_failed'; END; $$ LANGUAGE plpgsql`);
      await db.query(`CREATE TRIGGER reject_interteam_operator_audit
        BEFORE INSERT ON event_log FOR EACH ROW
        WHEN (NEW.topic = 'interteam:operator_config')
        EXECUTE FUNCTION reject_interteam_operator_audit()`);
    }
    await expect(service.createContact(contextA, {
      aliasDisplay: 'Rollback',
      remoteNodeId: 'node',
      remoteTeamId: 'team',
    })).rejects.toThrow(/audit_failed/);
    expect(Number((await q<{ count: number | string }>(
      db,
      `SELECT COUNT(*) AS count FROM team_contacts WHERE local_team_id = ?`,
      [teamA],
    ))[0].count)).toBe(0);
  });
});

describe('trusted local context boundary', () => {
  it('documents assertions as forgeable same-host context, not credentials', () => {
    expect(LOCAL_TRUST_BOUNDARY_NOTICE).toContain('malicious same-UID worker can forge');
    expect(LOCAL_TRUST_BOUNDARY_NOTICE).toContain('reverse proxy changes the admin boundary');
    const asserted: TrustedLocalSourceContext = {
      localTeamId: 'forged-team-assertion',
      principal: 'agent-header',
      agentId: 'forged-agent-assertion',
    };
    expect(deriveLocalTeamId(asserted)).toBe('forged-team-assertion');
    expect(JSON.stringify(asserted)).not.toMatch(/token|secret|capability/i);
  });
});
