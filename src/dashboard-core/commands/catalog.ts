// SPDX-License-Identifier: MIT
/**
 * Renderer-neutral command catalog: the POLICY for every command bar entry —
 * name, description, risk tier, confirmation gates, previews, argument
 * completion, and result-rendering hints. No execution (`run`) lives here; each
 * surface attaches its own runner (see `src/tui/commands/registry.ts`).
 */

import { SYNC_REMOVED_DESCRIPTION } from '../../lib/sync-removed.js';
import type {
  ArgCompleterContext,
  CommandPolicy,
  ConfirmPreviewContext,
  RiskTier,
} from './types.js';

/* ---------------- arg completers ---------------- */

// Slot-0 agent-name completer used by every command whose first positional
// arg is an agent name (output, meta, cancel, delete).
const agentNameSlot0: NonNullable<CommandPolicy['argCompleter']> = (slot, ctx) =>
  slot === 0 ? ctx.agentNames : [];

// `agent <name> <subAction>` — slot 0 is name, slot 1 is the subcommand.
const AGENT_SUBACTIONS = ['rebuild', 'start', 'stop', 'probe', 'logs', 'wallet', 'heartbeat'];
const agentTwoSlot: NonNullable<CommandPolicy['argCompleter']> = (slot, ctx) => {
  if (slot === 0) return ctx.agentNames;
  if (slot === 1) return AGENT_SUBACTIONS;
  return [];
};

// `/heartbeat enable|disable|fire <name>` — slot 0 subcommand, slot 1 agent.
const HEARTBEAT_SUBACTIONS = ['enable', 'disable', 'fire'];
const heartbeatSlots: NonNullable<CommandPolicy['argCompleter']> = (slot, ctx) => {
  if (slot === 0) return HEARTBEAT_SUBACTIONS;
  if (slot === 1) return ctx.agentNames;
  return [];
};

/* ---------------- gate predicate constant sets ---------------- */

const AGENTS_BULK_ACTIONS = new Set(['rebuild', 'start', 'stop']);
const SCHEDULE_MUTATORS = new Set(['add', 'pause', 'resume', 'remove']);
const TASK_MUTATORS = new Set(['assign', 'status', 'done', 'remove', 'delete']);
const AGENT_MUTATORS = new Set(['rebuild', 'start', 'stop', 'wallet']);
const HEARTBEAT_MUTATORS = new Set(['enable', 'disable', 'fire']);
const SCHEDULE_RETYPE = new Set(['remove']);
const TASK_RETYPE = new Set(['remove', 'delete']);
const AGENT_RETYPE = new Set<string>();

/** Shared by the catalog and the TUI runner so both agree on the action set. */
export {
  AGENTS_BULK_ACTIONS,
  SCHEDULE_MUTATORS,
  TASK_MUTATORS,
  AGENT_MUTATORS,
  HEARTBEAT_MUTATORS,
};

/* ---------------- helper for `/remote`-dispatch policies ---------------- */

// Policy for a command that simply forwards to the manager. The execution
// (the actual `/remote` call) is attached by each surface's runner.
function remotePolicy(
  name: string,
  description: string,
  tier: RiskTier,
  extras: Pick<
    CommandPolicy,
    'shouldConfirm' | 'shouldRetype' | 'confirmPreview' | 'argCompleter' | 'resultRenderer'
  > = {},
): CommandPolicy {
  return { name, description, tier, ...extras };
}

/* ---------------- command policies ---------------- */

const agentsPolicy: CommandPolicy = {
  name: 'agents',
  description: 'List agents, or run team lifecycle: `/agents <team> <rebuild|start|stop>`',
  tier: 'powerful',
  // The dashboard already has a dedicated agents view; surfacing :agents as a
  // command is for raw inspection, so force JSON instead of a stripped table.
  resultRenderer: (args) => (args.length === 2 ? 'table' : 'json'),
  argCompleter: (slot, ctx) => {
    if (slot === 0) return ctx.teamNames;
    if (slot === 1) return Array.from(AGENTS_BULK_ACTIONS);
    return [];
  },
  shouldConfirm: (args) => {
    const action = args[1]?.toLowerCase() ?? '';
    return args.length === 2 && (action === 'rebuild' || action === 'start');
  },
  shouldRetype: (args) => args.length === 2 && args[1]?.toLowerCase() === 'stop',
  confirmPreview: (args, ctx) => {
    if (args.length !== 2) return null;
    const team = (args[0] ?? '<team>').toLowerCase();
    const action = args[1]?.toLowerCase() ?? '';
    if (!AGENTS_BULK_ACTIONS.has(action)) return null;
    const count = ctx?.teamCounts?.get(team);
    const countText = typeof count === 'number' ? `${count} ` : '';
    return `${action} ${countText}agents in team ${team}`;
  },
};

const helpPolicy: CommandPolicy = {
  name: 'help',
  description: 'Open the scrollable command help (also: ?)',
  tier: 'safe',
};

const configsPolicy: CommandPolicy = {
  name: 'configs',
  description: 'Open the navigable configs/*.yaml browser',
  tier: 'safe',
};

const outputPolicy: CommandPolicy = {
  name: 'output',
  description: "Open an agent's navigable ./output browser (`/output <agent>`)",
  tier: 'safe',
  argCompleter: agentNameSlot0,
  resultRenderer: 'table',
};

const teamPolicy: CommandPolicy = {
  name: 'team',
  description: 'Show/switch active team; delete empty team: `/team delete <name>`',
  tier: 'powerful',
  shouldConfirm: (args) => args[0]?.toLowerCase() === 'delete' && Boolean(args[1]),
  shouldRetype: (args) => args[0]?.toLowerCase() === 'delete' && Boolean(args[1]),
  confirmPreview: (args) => {
    if (args[0]?.toLowerCase() === 'delete') {
      return args[1] ? `DELETE team ${args[1].toLowerCase()}` : null;
    }
    return null;
  },
};

const schedulePolicy: CommandPolicy = {
  name: 'schedule',
  description: 'Mutate schedules: add/pause/resume (Y/N), remove (retype). Browse with `c`.',
  tier: 'powerful',
  shouldConfirm: (args) => SCHEDULE_MUTATORS.has(args[0]?.toLowerCase() ?? ''),
  shouldRetype: (args) => SCHEDULE_RETYPE.has(args[0]?.toLowerCase() ?? ''),
  confirmPreview: (args) =>
    SCHEDULE_MUTATORS.has(args[0]?.toLowerCase() ?? '') ? `schedule ${args.join(' ')}` : null,
};

const taskPolicy: CommandPolicy = {
  name: 'task',
  description: 'Mutate tasks: assign/status/done/delete (Y/N), bulk delete (retype). Browse with `t`.',
  tier: 'destructive',
  shouldConfirm: (args) => TASK_MUTATORS.has(args[0]?.toLowerCase() ?? ''),
  // Retype is reserved for BULK deletes (`*` or `--team`). Single-task delete
  // falls back to Y/N via shouldConfirm — recoverable scope.
  shouldRetype: (args) => {
    const sub = args[0]?.toLowerCase() ?? '';
    if (!TASK_RETYPE.has(sub)) return false;
    const first = args[1];
    return first === '*' || first === '--team';
  },
  confirmPreview: (args) => {
    const sub = args[0]?.toLowerCase() ?? '';
    if (!TASK_MUTATORS.has(sub)) return null;
    if (sub === 'remove' || sub === 'delete') {
      const first = args[1];
      if (!first) return null;
      if (first === '*') return 'DELETE ALL tasks in the active team';
      if (first === '--team') {
        const t = args[2];
        return t ? `DELETE ALL tasks in team ${t}` : 'remove --team (no team name)';
      }
      return `delete task ${first}`;
    }
    if (sub === 'status') {
      const ref = args[1];
      const target = args[2];
      if (!ref || !target) return null;
      return `set task ${ref} to ${target}`;
    }
    return `task ${args.join(' ')}`;
  },
};

const agentPolicy = remotePolicy(
  'agent',
  'Per-agent control: `/agent <name> <rebuild|start|stop|wallet provision|probe|logs>`',
  'powerful',
  {
    shouldConfirm: (args) => AGENT_MUTATORS.has(args[1]?.toLowerCase() ?? ''),
    shouldRetype: (args) => AGENT_RETYPE.has(args[1]?.toLowerCase() ?? ''),
    confirmPreview: (args) => {
      const sub = args[1]?.toLowerCase();
      const name = args[0] ?? '<agent>';
      if (!sub) return null;
      if (sub === 'wallet') return `provision OWS wallet for agent ${name}`;
      if (AGENT_MUTATORS.has(sub)) return `${sub} agent ${name}`;
      return null;
    },
    argCompleter: agentTwoSlot,
  },
);

const deployPolicy = remotePolicy('deploy', 'Deploy a team config: `/deploy <config-name>`', 'powerful', {
  shouldConfirm: () => true,
  confirmPreview: (args) =>
    args.length > 0 ? `deploy config: ${args.join(' ')}` : 'deploy (no args — will error)',
});

// §9 (D2): /sync is removed but stays REGISTERED, so it still tab-completes
// and the person who types it gets told what replaced it. Deleting the entry
// would make it silently unknown, which is the outcome that sends people
// hunting for a bug. Tier drops to 'safe' and confirmation is off: there is
// nothing to confirm about a command that only prints guidance.
const syncPolicy: CommandPolicy = {
  name: 'sync',
  description: SYNC_REMOVED_DESCRIPTION,
  tier: 'safe',
  shouldConfirm: () => false,
};

const heartbeatPolicy: CommandPolicy = {
  name: 'heartbeat',
  description: 'Toggle/fire heartbeat: `/heartbeat enable|disable|fire <agent>`. Browse with `h`.',
  tier: 'powerful',
  shouldConfirm: (args) => HEARTBEAT_MUTATORS.has(args[0]?.toLowerCase() ?? ''),
  confirmPreview: (args) => {
    const sub = args[0]?.toLowerCase() ?? '';
    const name = args[1] ?? '<agent>';
    if (!HEARTBEAT_MUTATORS.has(sub)) return null;
    if (sub === 'fire') return `manually fire heartbeat for agent ${name}`;
    return `${sub} heartbeat for agent ${name}`;
  },
  argCompleter: heartbeatSlots,
};

const deletePolicy = remotePolicy(
  'delete',
  'Delete agent(s): `/delete <name>` | `/delete *` | `/delete --team <name>`',
  'destructive',
  {
    shouldRetype: () => true,
    confirmPreview: (args) => {
      const first = args[0];
      if (!first) return 'delete (no args — will error)';
      if (first === '*') return 'DELETE ALL agents in the active team';
      if (first === '--team') {
        const t = args[1];
        return t ? `DELETE ALL agents in team ${t}` : 'delete --team (no team name)';
      }
      return `delete agent ${first}`;
    },
    argCompleter: agentNameSlot0,
  },
);

const cancelPolicy = remotePolicy('cancel', "Cancel an agent's running query: `/cancel <agent>`", 'powerful', {
  shouldRetype: () => true,
  confirmPreview: (args) =>
    args[0] ? `cancel running query on agent ${args[0]}` : 'cancel (no args — will error)',
  argCompleter: agentNameSlot0,
});

/**
 * The full catalog, keyed by command name. Every entry is renderer-neutral
 * policy; execution is attached per surface.
 */
export const COMMAND_POLICIES: Record<string, CommandPolicy> = {
  agents: agentsPolicy,
  help: helpPolicy,
  status: remotePolicy('status', 'Team health summary (running/offline + per-agent health)', 'safe', {
    resultRenderer: 'table',
  }),
  teams: remotePolicy('teams', 'List all teams in the manager DB', 'safe', { resultRenderer: 'table' }),
  team: teamPolicy,
  configs: configsPolicy,
  output: outputPolicy,
  meta: remotePolicy('meta', 'Show agent metadata (`/meta <agent>`)', 'safe', {
    argCompleter: agentNameSlot0,
  }),
  list: remotePolicy('list', 'Show all pending queries in the active team', 'safe', {
    resultRenderer: 'table',
  }),
  schedule: schedulePolicy,
  task: taskPolicy,
  agent: agentPolicy,
  deploy: deployPolicy,
  sync: syncPolicy,
  heartbeat: heartbeatPolicy,
  delete: deletePolicy,
  cancel: cancelPolicy,
};

export function lookupPolicy(name: string): CommandPolicy | null {
  return COMMAND_POLICIES[name] ?? null;
}

export function policyNames(): string[] {
  return Object.keys(COMMAND_POLICIES).sort();
}

// Pinned to the front of their tier in the help catalog. Everything else stays
// alphabetical underneath.
const PINNED_FIRST = ['help'];

/**
 * Ordered iteration over all catalog entries grouped by tier (safe, powerful,
 * destructive), commands within a tier sorted alphabetically with pinned
 * entries first. Used by the help view.
 */
export function catalogEntriesByTier(): Record<RiskTier, CommandPolicy[]> {
  const out: Record<RiskTier, CommandPolicy[]> = { safe: [], powerful: [], destructive: [] };
  const pinned = new Set(PINNED_FIRST);
  for (const name of PINNED_FIRST) {
    const p = lookupPolicy(name);
    if (p) out[p.tier].push(p);
  }
  for (const name of policyNames()) {
    if (pinned.has(name)) continue;
    const p = lookupPolicy(name);
    if (!p) continue;
    out[p.tier].push(p);
  }
  return out;
}

export type { ConfirmPreviewContext, ArgCompleterContext };
