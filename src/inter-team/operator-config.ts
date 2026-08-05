// SPDX-License-Identifier: MIT

import type { DbAdapter, QueryResult } from '../db/db-adapter.js';
import type { Group, OrgConfig } from '../config-parser.js';
import { stringifyJson } from '../db/db-json.js';
import { NormalizedOrgStore, type OrgState } from '../org/normalized-org.js';
import {
  InterteamFoundationStore,
  type TeamContact,
  type TeamInterteamSettings,
} from './foundation-store.js';
import {
  deriveLocalTeamId,
  resolveOwnedContact,
  type TrustedLocalSourceContext,
} from './local-context.js';
import type { InboundPolicy } from './protocol.js';

export interface OperatorConfigContext extends TrustedLocalSourceContext {
  principal: 'operator';
  teamName: string;
}

export interface OperatorAudit {
  seq: number;
  action: string;
  subjectKind: string;
  subjectId: string | null;
  occurredAt: number;
  data: Record<string, unknown>;
}

export interface OrgReplacementRemoval {
  removedGroups: string[];
  removedMembershipAssignments: number;
  removedTagAssignments: number;
}

export interface LeadState {
  agentId: string | null;
  status: string | null;
  available: boolean;
  degradedReason: 'unassigned' | 'recipient_unavailable' | null;
}

function parameterize(db: DbAdapter, sql: string): string {
  if (db.dialect === 'sqlite') return sql;
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function query<T>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return db.query<T>(parameterize(db, sql), params);
}

async function inTransaction<T>(db: DbAdapter, callback: (tx: DbAdapter) => Promise<T>): Promise<T> {
  if (db.transaction) return db.transaction(callback);
  await db.query('BEGIN');
  try {
    const value = await callback(db);
    await db.query('COMMIT');
    return value;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

function nonEmpty(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code);
  return value;
}

async function appendAudit(
  db: DbAdapter,
  context: OperatorConfigContext,
  input: {
    action: string;
    subjectKind: string;
    subjectId?: string | null;
    occurredAt: number;
    data: Record<string, unknown>;
  },
): Promise<OperatorAudit> {
  const data = {
    principal: 'loopback_admin',
    teamName: context.teamName,
    ...input.data,
  };
  const result = await query<{ seq: number | string }>(
    db,
    `INSERT INTO event_log
       (team_id, topic, actor_agent_id, subject_kind, subject_id, occurred_at, data)
     VALUES (?, 'interteam:operator_config', ?, ?, ?, ?, ?)
     RETURNING seq`,
    [
      context.localTeamId,
      context.agentId ?? null,
      input.subjectKind,
      input.subjectId ?? null,
      input.occurredAt,
      stringifyJson({ action: input.action, ...data }),
    ],
  );
  return {
    seq: Number(result.rows[0]!.seq),
    action: input.action,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId ?? null,
    occurredAt: input.occurredAt,
    data,
  };
}

function visitGroups(
  groups: Record<string, Group> | undefined,
  parent: string[],
  groupPaths: Set<string>,
  memberships: Set<string>,
): void {
  for (const [name, group] of Object.entries(groups ?? {})) {
    const path = [...parent, name].join('/');
    groupPaths.add(path);
    for (const member of group.members ?? []) memberships.add(`${path}\u0000${member}`);
    visitGroups(group.groups, [...parent, name], groupPaths, memberships);
  }
}

function orgRemoval(before: OrgConfig | null, after: OrgConfig): OrgReplacementRemoval {
  const beforeGroups = new Set<string>();
  const beforeMemberships = new Set<string>();
  const afterGroups = new Set<string>();
  const afterMemberships = new Set<string>();
  visitGroups(before?.groups, [], beforeGroups, beforeMemberships);
  visitGroups(after.groups, [], afterGroups, afterMemberships);

  const beforeTags = new Set<string>();
  const afterTags = new Set<string>();
  for (const [tag, agents] of Object.entries(before?.tags ?? {})) {
    for (const agent of agents) beforeTags.add(`${tag}\u0000${agent}`);
  }
  for (const [tag, agents] of Object.entries(after.tags ?? {})) {
    for (const agent of agents) afterTags.add(`${tag}\u0000${agent}`);
  }
  return {
    removedGroups: [...beforeGroups].filter((path) => !afterGroups.has(path)).sort(),
    removedMembershipAssignments: [...beforeMemberships].filter((item) => !afterMemberships.has(item)).length,
    removedTagAssignments: [...beforeTags].filter((item) => !afterTags.has(item)).length,
  };
}

/** Commit-6 mutation service. Every write and audit append shares one transaction. */
export class InterteamOperatorConfigService {
  constructor(private readonly db: DbAdapter) {}

  async read(context: OperatorConfigContext): Promise<{
    settings: TeamInterteamSettings;
    lead: LeadState;
    contacts: TeamContact[];
    orgState: OrgState | null;
    org: OrgConfig | null;
  }> {
    const teamId = deriveLocalTeamId(context);
    const foundation = new InterteamFoundationStore(this.db);
    const settings = await foundation.getTeamSettings(teamId);
    if (!settings) throw new Error('team_not_found');
    const lead = await this.readLead(settings.leadAgentId);
    const orgStore = new NormalizedOrgStore(this.db);
    return {
      settings,
      lead,
      contacts: await foundation.listContacts(teamId),
      orgState: await orgStore.getState(teamId),
      org: await orgStore.readOrg(teamId),
    };
  }

  async createContact(
    context: OperatorConfigContext,
    body: Record<string, unknown>,
    now = Date.now(),
  ): Promise<{ contact: TeamContact; audit: OperatorAudit }> {
    const teamId = deriveLocalTeamId(context, body);
    const aliasDisplay = nonEmpty(body.aliasDisplay, 'contact_alias_invalid');
    const remoteNodeId = nonEmpty(body.remoteNodeId, 'remote_node_id_invalid');
    const remoteTeamId = nonEmpty(body.remoteTeamId, 'remote_team_id_invalid');
    return inTransaction(this.db, async (tx) => {
      const contact = await new InterteamFoundationStore(tx).createContact({
        localTeamId: teamId,
        aliasDisplay,
        remoteNodeId,
        remoteTeamId,
        now,
      });
      const audit = await appendAudit(tx, context, {
        action: 'contact_created',
        subjectKind: 'interteam_contact',
        subjectId: contact.id,
        occurredAt: now,
        data: { aliasDisplay, remoteNodeId, remoteTeamId },
      });
      return { contact, audit };
    });
  }

  async renameContact(
    context: OperatorConfigContext,
    contactId: string,
    body: Record<string, unknown>,
    now = Date.now(),
  ): Promise<{ contact: TeamContact; audit: OperatorAudit }> {
    deriveLocalTeamId(context, body);
    const aliasDisplay = nonEmpty(body.aliasDisplay, 'contact_alias_invalid');
    if (body.remoteNodeId !== undefined || body.remoteTeamId !== undefined) {
      throw new Error('contact_pin_immutable');
    }
    return inTransaction(this.db, async (tx) => {
      const foundation = new InterteamFoundationStore(tx);
      const before = await resolveOwnedContact(foundation, { context, body, contactId });
      const contact = await foundation.renameContact({
        id: contactId,
        localTeamId: context.localTeamId,
        aliasDisplay,
        now,
      });
      const audit = await appendAudit(tx, context, {
        action: 'contact_renamed',
        subjectKind: 'interteam_contact',
        subjectId: contact.id,
        occurredAt: now,
        data: { beforeAliasDisplay: before.aliasDisplay, aliasDisplay },
      });
      return { contact, audit };
    });
  }

  async deleteContact(
    context: OperatorConfigContext,
    contactId: string,
    body: Record<string, unknown> = {},
    now = Date.now(),
  ): Promise<{ deleted: true; audit: OperatorAudit }> {
    deriveLocalTeamId(context, body);
    return inTransaction(this.db, async (tx) => {
      const foundation = new InterteamFoundationStore(tx);
      const before = await resolveOwnedContact(foundation, { context, body, contactId });
      if (!await foundation.deleteContact(contactId, context.localTeamId)) {
        throw new Error('contact_not_found');
      }
      const audit = await appendAudit(tx, context, {
        action: 'contact_deleted',
        subjectKind: 'interteam_contact',
        subjectId: contactId,
        occurredAt: now,
        data: {
          aliasDisplay: before.aliasDisplay,
          remoteNodeId: before.remoteNodeId,
          remoteTeamId: before.remoteTeamId,
        },
      });
      return { deleted: true, audit };
    });
  }

  async setInboundPolicy(
    context: OperatorConfigContext,
    body: Record<string, unknown>,
    now = Date.now(),
  ): Promise<{ settings: TeamInterteamSettings; audit: OperatorAudit }> {
    const teamId = deriveLocalTeamId(context, body);
    const policy = body.policy;
    if (policy !== 'open' && policy !== 'closed') throw new Error('inbound_policy_invalid');
    return inTransaction(this.db, async (tx) => {
      const foundation = new InterteamFoundationStore(tx);
      const before = await foundation.getTeamSettings(teamId);
      if (!before) throw new Error('team_not_found');
      await foundation.setInboundPolicy(teamId, policy as InboundPolicy);
      const settings = (await foundation.getTeamSettings(teamId))!;
      const audit = await appendAudit(tx, context, {
        action: 'inbound_policy_set',
        subjectKind: 'team',
        subjectId: teamId,
        occurredAt: now,
        data: { before: before.inboundPolicy, policy },
      });
      return { settings, audit };
    });
  }

  async setTeamLead(
    context: OperatorConfigContext,
    body: Record<string, unknown>,
    now = Date.now(),
  ): Promise<{ settings: TeamInterteamSettings; lead: LeadState; audit: OperatorAudit }> {
    const teamId = deriveLocalTeamId(context, body);
    if (body.agentId !== null && typeof body.agentId !== 'string') throw new Error('team_lead_invalid');
    const agentId = body.agentId as string | null;
    return inTransaction(this.db, async (tx) => {
      const foundation = new InterteamFoundationStore(tx);
      const before = await foundation.getTeamSettings(teamId);
      if (!before) throw new Error('team_not_found');
      await foundation.setTeamLead(teamId, agentId);
      const settings = (await foundation.getTeamSettings(teamId))!;
      const audit = await appendAudit(tx, context, {
        action: 'team_lead_set',
        subjectKind: 'team',
        subjectId: teamId,
        occurredAt: now,
        data: { beforeAgentId: before.leadAgentId, agentId },
      });
      return { settings, lead: await this.readLead(agentId, tx), audit };
    });
  }

  async replaceOrg(
    context: OperatorConfigContext,
    body: Record<string, unknown>,
    now = Date.now(),
  ): Promise<{
    state: OrgState;
    org: OrgConfig;
    removal: OrgReplacementRemoval;
    audit: OperatorAudit;
  }> {
    const teamId = deriveLocalTeamId(context, body);
    if (!body.org || typeof body.org !== 'object' || Array.isArray(body.org)) {
      throw new Error('org_data_corrupt');
    }
    const org = body.org as OrgConfig;
    const reason = body.reason === undefined
      ? 'operator normalized org replacement'
      : nonEmpty(body.reason, 'org_reason_invalid');
    return inTransaction(this.db, async (tx) => {
      const store = new NormalizedOrgStore(tx);
      const before = await store.readOrg(teamId);
      const removal = orgRemoval(before, org);
      await store.replaceFromConfigInTransaction(teamId, org, {
        decidedBy: context.agentId ? `operator:${context.agentId}` : 'operator:loopback_admin',
        decidedAt: now,
        reason,
      });
      const audit = await appendAudit(tx, context, {
        action: 'normalized_org_replaced',
        subjectKind: 'organization',
        subjectId: teamId,
        occurredAt: now,
        data: { reason, ...removal },
      });
      return {
        state: (await store.getState(teamId))!,
        org: (await store.readOrg(teamId))!,
        removal,
        audit,
      };
    });
  }

  private async readLead(agentId: string | null, db: DbAdapter = this.db): Promise<LeadState> {
    if (!agentId) {
      return { agentId: null, status: null, available: false, degradedReason: 'unassigned' };
    }
    const result = await query<{ status: string; deleted_at: number | string | null }>(
      db,
      `SELECT status, deleted_at FROM agents WHERE id = ?`,
      [agentId],
    );
    const row = result.rows[0];
    const available = !!row && row.deleted_at === null && row.status === 'running';
    return {
      agentId,
      status: row?.status ?? null,
      available,
      degradedReason: available ? null : 'recipient_unavailable',
    };
  }
}
