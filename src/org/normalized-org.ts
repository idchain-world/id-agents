// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { DbAdapter, QueryResult } from '../db/db-adapter.js';
import type { Group, OrgConfig } from '../config-parser.js';
import {
  containsUnexpandedTemplate,
  normalizeOrgKey,
  ORG_MAX_DEPTH,
  ORG_MAX_GROUPS,
} from './normalization.js';

export type OrgStateStatus = 'normalized' | 'intentionally_no_org' | 'blocked';

export interface OrgDecision {
  decidedBy: string;
  decidedAt?: number;
  reason?: string;
  sourceHash?: string;
}

export interface OrgState {
  teamId: string;
  status: OrgStateStatus;
  decidedBy: string;
  decidedAt: number;
  reason: string | null;
  sourceHash: string | null;
}

export interface OrgValidationMetrics {
  groupCount: number;
  explicitMembershipCount: number;
  tagCount: number;
  tagAssignmentCount: number;
}

export class OrgValidationError extends Error {
  constructor(
    readonly code: 'org_data_corrupt' | 'org_reference_unresolved' | 'org_reference_ambiguous' | 'org_template_unexpanded',
    message: string,
  ) {
    super(message);
    this.name = 'OrgValidationError';
  }
}

interface PreparedGroup {
  id: string;
  parentId: string | null;
  name: string;
  normalized: string;
  description: string | null;
  position: number;
  depth: number;
  leadAgentId: string | null;
  memberAgentIds: string[];
}

interface PreparedTag {
  id: string;
  name: string;
  normalized: string;
  position: number;
  agentIds: string[];
}

interface GroupRow {
  id: string;
  parent_group_id: string | null;
  name: string;
  name_normalized: string;
  description: string | null;
  position: number;
}

function parameterize(dialect: DbAdapter['dialect'], sql: string): string {
  if (dialect === 'sqlite') return sql;
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function query<T>(db: DbAdapter, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return db.query<T>(parameterize(db.dialect, sql), params);
}

async function inTransaction<T>(db: DbAdapter, callback: (tx: DbAdapter) => Promise<T>): Promise<T> {
  if (db.transaction) return db.transaction(callback);
  await db.query('BEGIN');
  try {
    const result = await callback(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrgValidationError('org_data_corrupt', `${label} must be an object`);
  }
}

function assertText(value: unknown, label: string, optional = false): string | null {
  if (value === undefined && optional) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OrgValidationError('org_data_corrupt', `${label} must be a non-empty string`);
  }
  if (containsUnexpandedTemplate(value)) {
    throw new OrgValidationError('org_template_unexpanded', `${label} contains an unexpanded template`);
  }
  return value;
}

export class NormalizedOrgStore {
  constructor(private readonly db: DbAdapter) {}

  async getState(teamId: string): Promise<OrgState | null> {
    const result = await query<{
      team_id: string;
      status: OrgStateStatus;
      decided_by: string;
      decided_at: number | string;
      reason: string | null;
      source_hash: string | null;
    }>(this.db, `SELECT * FROM team_org_state WHERE team_id = ?`, [teamId]);
    const row = result.rows[0];
    return row ? {
      teamId: row.team_id,
      status: row.status,
      decidedBy: row.decided_by,
      decidedAt: Number(row.decided_at),
      reason: row.reason,
      sourceHash: row.source_hash,
    } : null;
  }

  async replaceFromConfig(teamId: string, org: OrgConfig, decision: OrgDecision): Promise<void> {
    await inTransaction(this.db, async (tx) => {
      await new NormalizedOrgStore(tx).replaceFromConfigInTransaction(teamId, org, decision);
    });
  }

  /**
   * Replace normalized state using an already-open transaction. Operator
   * configuration uses this so the org rows, state decision, and audit event
   * commit or roll back together.
   */
  async replaceFromConfigInTransaction(
    teamId: string,
    org: OrgConfig,
    decision: OrgDecision,
  ): Promise<void> {
    const { groups, tags } = await this.prepare(teamId, org);
    await this.clearOrg(this.db, teamId);
    for (const group of groups) {
      await query(this.db,
        `INSERT INTO org_groups
           (id, team_id, parent_group_id, name, name_normalized, description, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [group.id, teamId, group.parentId, group.name, group.normalized, group.description, group.position],
      );
      if (group.leadAgentId) {
        await query(this.db,
          `INSERT INTO org_group_leads (team_id, group_id, agent_id) VALUES (?, ?, ?)`,
          [teamId, group.id, group.leadAgentId],
        );
      }
      for (let position = 0; position < group.memberAgentIds.length; position++) {
        await query(this.db,
          `INSERT INTO org_group_members (team_id, group_id, agent_id, position)
           VALUES (?, ?, ?, ?)`,
          [teamId, group.id, group.memberAgentIds[position], position],
        );
      }
    }
    for (const tag of tags) {
      await query(this.db,
        `INSERT INTO org_tags (id, team_id, name, name_normalized, position)
         VALUES (?, ?, ?, ?, ?)`,
        [tag.id, teamId, tag.name, tag.normalized, tag.position],
      );
      for (let position = 0; position < tag.agentIds.length; position++) {
        await query(this.db,
          `INSERT INTO org_agent_tags (team_id, tag_id, agent_id, position)
           VALUES (?, ?, ?, ?)`,
          [teamId, tag.id, tag.agentIds[position], position],
        );
      }
    }
    await this.writeState(this.db, teamId, 'normalized', decision);
  }

  async validateFromConfig(teamId: string, org: OrgConfig): Promise<OrgValidationMetrics> {
    const prepared = await this.prepare(teamId, org);
    return {
      groupCount: prepared.groups.length,
      explicitMembershipCount: prepared.groups.reduce(
        (count, group) => count + group.memberAgentIds.length,
        0,
      ),
      tagCount: prepared.tags.length,
      tagAssignmentCount: prepared.tags.reduce((count, tag) => count + tag.agentIds.length, 0),
    };
  }

  async markIntentionallyNoOrg(teamId: string, decision: OrgDecision): Promise<void> {
    await inTransaction(this.db, async (tx) => {
      await this.clearOrg(tx, teamId);
      await this.writeState(tx, teamId, 'intentionally_no_org', decision);
    });
  }

  async markBlocked(teamId: string, decision: OrgDecision): Promise<void> {
    await inTransaction(this.db, async (tx) => {
      const count = await query<{ count: number | string }>(
        tx,
        `SELECT COUNT(*) AS count FROM org_groups WHERE team_id = ?`,
        [teamId],
      );
      if (Number(count.rows[0]?.count ?? 0) !== 0) {
        throw new OrgValidationError('org_data_corrupt', 'refusing to mark a populated org blocked');
      }
      await this.writeState(tx, teamId, 'blocked', decision);
    });
  }

  async readOrg(teamId: string): Promise<OrgConfig | null> {
    const state = await this.getState(teamId);
    if (!state || state.status !== 'normalized') return null;
    const groupResult = await query<GroupRow>(this.db,
      `SELECT id, parent_group_id, name, name_normalized, description, position
       FROM org_groups WHERE team_id = ? ORDER BY parent_group_id, position, id`,
      [teamId],
    );
    if (groupResult.rows.length > ORG_MAX_GROUPS) {
      throw new OrgValidationError('org_data_corrupt', 'org group bound exceeded');
    }

    const leadResult = await query<{ group_id: string; name: string }>(this.db,
      `SELECT l.group_id, a.name
       FROM org_group_leads l JOIN agents a ON a.team_id = l.team_id AND a.id = l.agent_id
       WHERE l.team_id = ? AND a.deleted_at IS NULL`,
      [teamId],
    );
    const memberResult = await query<{ group_id: string; name: string; position: number }>(this.db,
      `SELECT m.group_id, a.name, m.position
       FROM org_group_members m JOIN agents a ON a.team_id = m.team_id AND a.id = m.agent_id
       WHERE m.team_id = ? AND a.deleted_at IS NULL
       ORDER BY m.group_id, m.position`,
      [teamId],
    );
    const tagResult = await query<{ tag_id: string; name: string; position: number }>(this.db,
      `SELECT id AS tag_id, name, position FROM org_tags WHERE team_id = ? ORDER BY position`,
      [teamId],
    );
    const assignmentResult = await query<{ tag_id: string; name: string; position: number }>(this.db,
      `SELECT x.tag_id, a.name, x.position
       FROM org_agent_tags x JOIN agents a ON a.team_id = x.team_id AND a.id = x.agent_id
       WHERE x.team_id = ? AND a.deleted_at IS NULL
       ORDER BY x.tag_id, x.position`,
      [teamId],
    );

    const leads = new Map(leadResult.rows.map((row) => [row.group_id, row.name]));
    const members = new Map<string, string[]>();
    for (const row of memberResult.rows) {
      const list = members.get(row.group_id) ?? [];
      list.push(row.name);
      members.set(row.group_id, list);
    }
    const byParent = new Map<string | null, GroupRow[]>();
    const byId = new Map(groupResult.rows.map((row) => [row.id, row]));
    for (const row of groupResult.rows) {
      if (row.name_normalized !== normalizeOrgKey(row.name)) {
        throw new OrgValidationError('org_data_corrupt', `stored normalization differs for group ${row.id}`);
      }
      if (row.parent_group_id && !byId.has(row.parent_group_id)) {
        throw new OrgValidationError('org_data_corrupt', `missing parent for group ${row.id}`);
      }
      const siblings = byParent.get(row.parent_group_id) ?? [];
      siblings.push(row);
      byParent.set(row.parent_group_id, siblings);
    }
    for (const siblings of byParent.values()) {
      siblings.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
      siblings.forEach((row, index) => {
        if (row.position !== index) {
          throw new OrgValidationError('org_data_corrupt', 'group positions are not gap-free');
        }
      });
    }

    const visiting = new Set<string>();
    const built = new Set<string>();
    const build = (row: GroupRow, depth: number): Group => {
      if (depth > ORG_MAX_DEPTH) throw new OrgValidationError('org_data_corrupt', 'org depth bound exceeded');
      if (visiting.has(row.id)) throw new OrgValidationError('org_data_corrupt', 'org group cycle');
      visiting.add(row.id);
      const group: Group = {};
      if (row.description !== null) group.description = row.description;
      const lead = leads.get(row.id);
      if (lead) group.lead = lead;
      const direct = members.get(row.id);
      if (direct?.length) group.members = direct;
      const children = byParent.get(row.id) ?? [];
      if (children.length) {
        group.groups = {};
        for (const child of children) group.groups[child.name] = build(child, depth + 1);
      }
      visiting.delete(row.id);
      built.add(row.id);
      return group;
    };
    const groups: Record<string, Group> = {};
    for (const root of byParent.get(null) ?? []) groups[root.name] = build(root, 1);
    if (built.size !== groupResult.rows.length) {
      throw new OrgValidationError('org_data_corrupt', 'org contains unreachable groups');
    }

    const assignments = new Map<string, string[]>();
    for (const row of assignmentResult.rows) {
      const list = assignments.get(row.tag_id) ?? [];
      list.push(row.name);
      assignments.set(row.tag_id, list);
    }
    const tags: Record<string, string[]> = {};
    for (const tag of tagResult.rows) tags[tag.name] = assignments.get(tag.tag_id) ?? [];
    return Object.keys(tags).length ? { groups, tags } : { groups };
  }

  async deleteGroup(groupId: string): Promise<void> {
    await inTransaction(this.db, async (tx) => {
      const row = await query<{ team_id: string; parent_group_id: string | null }>(
        tx,
        `SELECT team_id, parent_group_id FROM org_groups WHERE id = ?`,
        [groupId],
      );
      if (!row.rows[0]) return;
      await query(tx, `DELETE FROM org_groups WHERE id = ?`, [groupId]);
      await this.resequenceSiblings(tx, row.rows[0].team_id, row.rows[0].parent_group_id);
    });
  }

  async deleteSubtree(groupId: string): Promise<string[]> {
    return inTransaction(this.db, async (tx) => {
      const root = await query<{ team_id: string; parent_group_id: string | null }>(
        tx,
        `SELECT team_id, parent_group_id FROM org_groups WHERE id = ?`,
        [groupId],
      );
      if (!root.rows[0]) return [];
      const tree = await query<{ id: string; depth: number }>(tx,
        `WITH RECURSIVE subtree(id, depth) AS (
           SELECT id, 0 FROM org_groups WHERE id = ?
           UNION ALL
           SELECT g.id, subtree.depth + 1 FROM org_groups g JOIN subtree ON g.parent_group_id = subtree.id
         ) SELECT id, depth FROM subtree ORDER BY depth DESC`,
        [groupId],
      );
      for (const row of tree.rows) await query(tx, `DELETE FROM org_groups WHERE id = ?`, [row.id]);
      await this.resequenceSiblings(tx, root.rows[0].team_id, root.rows[0].parent_group_id);
      return tree.rows.map((row) => row.id);
    });
  }

  async moveGroup(groupId: string, parentGroupId: string | null, position: number): Promise<void> {
    await inTransaction(this.db, async (tx) => {
      const current = await query<{ team_id: string; parent_group_id: string | null }>(
        tx,
        `SELECT team_id, parent_group_id FROM org_groups WHERE id = ?`,
        [groupId],
      );
      if (!current.rows[0]) throw new OrgValidationError('org_data_corrupt', 'group not found');
      const teamId = current.rows[0].team_id;
      await query(tx, `UPDATE org_groups SET position = position + 100000 WHERE team_id = ?`, [teamId]);
      await query(tx,
        `UPDATE org_groups SET parent_group_id = ?, position = ? WHERE id = ?`,
        [parentGroupId, Math.max(0, position), groupId],
      );
      await this.resequenceSiblings(tx, teamId, current.rows[0].parent_group_id);
      await this.resequenceSiblings(tx, teamId, parentGroupId, groupId, Math.max(0, position));
    });
  }

  async findActiveAgentsByTag(teamId: string, tagName: string): Promise<string[]> {
    const result = await query<{ name: string }>(this.db,
      `SELECT a.name
       FROM org_tags t
       JOIN org_agent_tags x ON x.team_id = t.team_id AND x.tag_id = t.id
       JOIN agents a ON a.team_id = x.team_id AND a.id = x.agent_id
       WHERE t.team_id = ? AND t.name_normalized = ? AND a.deleted_at IS NULL
       ORDER BY x.position`,
      [teamId, normalizeOrgKey(tagName)],
    );
    return result.rows.map((row) => row.name);
  }

  private async prepare(teamId: string, org: OrgConfig): Promise<{ groups: PreparedGroup[]; tags: PreparedTag[] }> {
    assertPlainRecord(org, 'org');
    const rawGroups = org.groups ?? {};
    assertPlainRecord(rawGroups, 'org.groups');
    const agents = await query<{ id: string; name: string }>(this.db,
      `SELECT id, name FROM agents WHERE team_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
      [teamId],
    );
    const idsByName = new Map<string, string[]>();
    for (const agent of agents.rows) idsByName.set(agent.name, [...(idsByName.get(agent.name) ?? []), agent.id]);
    const resolveAgent = (name: unknown, label: string): string => {
      const checked = assertText(name, label)!;
      const matches = idsByName.get(checked) ?? [];
      if (matches.length === 0) throw new OrgValidationError('org_reference_unresolved', `${label} does not resolve: ${checked}`);
      if (matches.length > 1) throw new OrgValidationError('org_reference_ambiguous', `${label} is ambiguous: ${checked}`);
      return matches[0];
    };

    const groups: PreparedGroup[] = [];
    const visit = (entries: Record<string, unknown>, parentId: string | null, depth: number): void => {
      if (depth > ORG_MAX_DEPTH) throw new OrgValidationError('org_data_corrupt', 'org depth bound exceeded');
      const siblingKeys = new Set<string>();
      Object.entries(entries).forEach(([name, raw], position) => {
        assertText(name, `group name at depth ${depth}`);
        const normalized = normalizeOrgKey(name);
        if (siblingKeys.has(normalized)) {
          throw new OrgValidationError('org_data_corrupt', `duplicate normalized sibling group: ${name}`);
        }
        siblingKeys.add(normalized);
        assertPlainRecord(raw, `group ${name}`);
        const id = randomUUID();
        const description = raw.description === undefined ? null : assertText(raw.description, `${name}.description`);
        const leadAgentId = raw.lead === undefined ? null : resolveAgent(raw.lead, `${name}.lead`);
        const memberNames = raw.members ?? [];
        if (!Array.isArray(memberNames)) throw new OrgValidationError('org_data_corrupt', `${name}.members must be an array`);
        const seenMembers = new Set<string>();
        const memberAgentIds = memberNames.map((member, index) => {
          const memberName = assertText(member, `${name}.members[${index}]`)!;
          const agentId = resolveAgent(memberName, `${name}.members[${index}]`);
          if (seenMembers.has(agentId)) throw new OrgValidationError('org_data_corrupt', `${name} repeats member ${memberName}`);
          seenMembers.add(agentId);
          return agentId;
        }).filter((agentId) => agentId !== leadAgentId);
        groups.push({ id, parentId, name, normalized, description, position, depth, leadAgentId, memberAgentIds });
        if (groups.length > ORG_MAX_GROUPS) throw new OrgValidationError('org_data_corrupt', 'org group bound exceeded');
        if (raw.groups !== undefined) {
          assertPlainRecord(raw.groups, `${name}.groups`);
          visit(raw.groups, id, depth + 1);
        }
      });
    };
    visit(rawGroups as unknown as Record<string, unknown>, null, 1);

    const tags: PreparedTag[] = [];
    if (org.tags !== undefined) {
      assertPlainRecord(org.tags, 'org.tags');
      const normalizedTags = new Set<string>();
      Object.entries(org.tags).forEach(([name, rawMembers], position) => {
        assertText(name, `tag name ${position}`);
        const normalized = normalizeOrgKey(name);
        if (normalizedTags.has(normalized)) throw new OrgValidationError('org_data_corrupt', `duplicate normalized tag: ${name}`);
        normalizedTags.add(normalized);
        if (!Array.isArray(rawMembers)) throw new OrgValidationError('org_data_corrupt', `tag ${name} must be an array`);
        const seen = new Set<string>();
        const agentIds = rawMembers.map((member, index) => {
          const agentId = resolveAgent(member, `tags.${name}[${index}]`);
          if (seen.has(agentId)) throw new OrgValidationError('org_data_corrupt', `tag ${name} repeats an agent`);
          seen.add(agentId);
          return agentId;
        });
        tags.push({ id: randomUUID(), name, normalized, position, agentIds });
      });
    }
    return { groups, tags };
  }

  private async clearOrg(tx: DbAdapter, teamId: string): Promise<void> {
    await query(tx, `DELETE FROM org_tags WHERE team_id = ?`, [teamId]);
    const groups = await query<{ id: string; depth: number }>(tx,
      `WITH RECURSIVE tree(id, depth) AS (
         SELECT id, 0 FROM org_groups WHERE team_id = ? AND parent_group_id IS NULL
         UNION ALL
         SELECT g.id, tree.depth + 1 FROM org_groups g JOIN tree ON g.parent_group_id = tree.id
       ) SELECT id, depth FROM tree ORDER BY depth DESC`,
      [teamId],
    );
    for (const group of groups.rows) await query(tx, `DELETE FROM org_groups WHERE id = ?`, [group.id]);
  }

  private async writeState(
    tx: DbAdapter,
    teamId: string,
    status: OrgStateStatus,
    decision: OrgDecision,
  ): Promise<void> {
    await query(tx,
      `INSERT INTO team_org_state (team_id, status, decided_by, decided_at, reason, source_hash)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(team_id) DO UPDATE SET
         status = excluded.status,
         decided_by = excluded.decided_by,
         decided_at = excluded.decided_at,
         reason = excluded.reason,
         source_hash = excluded.source_hash`,
      [teamId, status, decision.decidedBy, decision.decidedAt ?? Date.now(), decision.reason ?? null, decision.sourceHash ?? null],
    );
  }

  private async resequenceSiblings(
    tx: DbAdapter,
    teamId: string,
    parentId: string | null,
    preferredId?: string,
    preferredPosition?: number,
  ): Promise<void> {
    const condition = parentId === null ? 'parent_group_id IS NULL' : 'parent_group_id = ?';
    const params = parentId === null ? [teamId] : [teamId, parentId];
    const rows = await query<{ id: string; position: number }>(tx,
      `SELECT id, position FROM org_groups WHERE team_id = ? AND ${condition} ORDER BY position, id`,
      params,
    );
    const ordered = rows.rows.map((row) => row.id).filter((id) => id !== preferredId);
    if (preferredId && rows.rows.some((row) => row.id === preferredId)) {
      ordered.splice(Math.min(preferredPosition ?? ordered.length, ordered.length), 0, preferredId);
    }
    const maxPosition = rows.rows.reduce((max, row) => Math.max(max, row.position), 0);
    const temporaryBase = maxPosition + ordered.length + 1000;
    for (let index = 0; index < ordered.length; index++) {
      await query(tx, `UPDATE org_groups SET position = ? WHERE id = ?`, [temporaryBase + index, ordered[index]]);
    }
    for (let index = 0; index < ordered.length; index++) {
      await query(tx, `UPDATE org_groups SET position = ? WHERE id = ?`, [index, ordered[index]]);
    }
  }
}
