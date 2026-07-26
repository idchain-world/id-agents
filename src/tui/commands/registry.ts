// SPDX-License-Identifier: MIT
// TUI command-bar EXECUTION adapters.
//
// The renderer-neutral command POLICY (catalog, risk tiers, Y/N + retype gates,
// previews, completion, result-rendering hints) lives in
// `src/dashboard-core/commands/*`. This module attaches the terminal's
// execution to each policy — manager `/remote` dispatch, cross-team fan-out,
// bulk lifecycle, and TUI navigation actions — and re-exports the policy
// surface so App.tsx and existing tests keep their stable imports.

import { SYNC_REMOVED_MESSAGE } from '../../lib/sync-removed.js';
import { fetchAgentsAllTeams, fetchAgentsByTeam, fetchTeams, runRemoteCommand } from '../api/manager.js';
import {
  AGENTS_BULK_ACTIONS,
  SCHEDULE_MUTATORS,
  TASK_MUTATORS,
  HEARTBEAT_MUTATORS,
  catalogEntriesByTier as policyCatalogEntriesByTier,
  lookupPolicy,
  policyNames,
} from '../../dashboard-core/commands/catalog.js';
import { parseCommandLine } from '../../dashboard-core/commands/parser.js';
import { completeBuffer, completeCommand } from '../../dashboard-core/commands/completion.js';
import { commandConfirmPreview, confirmationLevel } from '../../dashboard-core/commands/confirmation.js';
import type {
  ArgCompleterContext,
  CommandPolicy,
  CommandResultRenderer,
  CommandResultRendererSelector,
  ConfirmationLevel,
  ConfirmPreviewContext,
  RiskTier,
} from '../../dashboard-core/commands/types.js';

// Re-export the policy surface so downstream TUI imports are unchanged.
export {
  parseCommandLine,
  completeBuffer,
  completeCommand,
  commandConfirmPreview,
  confirmationLevel,
};
export type {
  ArgCompleterContext,
  CommandResultRenderer,
  CommandResultRendererSelector,
  ConfirmationLevel,
  ConfirmPreviewContext,
  RiskTier,
};

export interface CommandContext {
  manager: string;
  executor: string;
  signal: AbortSignal;
  args: string[];
  // Active team name for the X-Id-Team header. When on the "All" view, callers
  // may pass a sensible fallback (e.g. the first real team) so dispatched
  // commands don't fall through to the daemon's default team.
  teamName?: string;
}

/** A concrete, executable command: renderer-neutral policy + TUI execution. */
export interface CommandSpec extends CommandPolicy {
  run: (ctx: CommandContext) => Promise<unknown>;
}

type Runner = (ctx: CommandContext) => Promise<unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const agentsUsage = 'Usage: /agents [team] | /agents <team> <rebuild|start|stop>';

function summarizeBulkLifecycleError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, ' ').trim())
    .filter(Boolean);
  if (lines.length === 0) return raw.replace(/[\r\n\t]+/g, ' ').trim() || 'unknown error';
  if (lines.length === 1) return lines[0]!;
  return `${lines[0]} (${lines.length - 1} more lines hidden)`;
}

/** Runner that forwards a command to the manager's `/remote` endpoint. */
const remoteRunner =
  (name: string): Runner =>
  async ({ manager, executor, signal, args, teamName }) => {
    const command = ['/' + name, ...args].join(' ');
    return runRemoteCommand(manager, executor, command, signal, teamName);
  };

const agentsRunner: Runner = async ({ manager, executor, signal, args }) => {
  if (args.length > 2) {
    return { ok: false, error: agentsUsage };
  }
  if (args.length === 1) {
    const team = args[0]!.toLowerCase();
    const agents = await fetchAgentsByTeam(manager, team, signal);
    return { count: agents.length, agents };
  }
  if (args.length === 2) {
    const team = args[0]!.toLowerCase();
    const action = args[1]!.toLowerCase();
    if (!AGENTS_BULK_ACTIONS.has(action)) {
      return { ok: false, error: agentsUsage };
    }
    if (team === 'public') {
      return { ok: false, error: 'Bulk lifecycle is not supported for the public team' };
    }
    const agents = await fetchAgentsByTeam(manager, team, signal);
    if (agents.length === 0) {
      return { ok: false, error: `No agents found in team ${team}` };
    }

    const rows: { agent: string; action: string; ok: boolean; error?: string }[] = [];
    // Skip already-running agents on `start` — sending /agent <name> start to a
    // running agent is wasted RPC and may bounce it. Stop and rebuild dispatch
    // unconditionally; rebuild is meant to refresh a live agent.
    const dispatchTargets = action === 'start' ? agents.filter((a) => a.status !== 'running') : agents;
    const skipped = action === 'start' ? agents.filter((a) => a.status === 'running') : [];
    for (const a of skipped) {
      rows.push({ agent: a.name, action: 'skip (already running)', ok: true });
    }
    for (let i = 0; i < dispatchTargets.length; i++) {
      const agent = dispatchTargets[i]!;
      try {
        await runRemoteCommand(manager, executor, `/agent ${agent.name} ${action}`, signal, team);
        rows.push({ agent: agent.name, action, ok: true });
      } catch (err: unknown) {
        rows.push({ agent: agent.name, action, ok: false, error: summarizeBulkLifecycleError(err) });
      }
      if (i < dispatchTargets.length - 1) {
        await sleep(250);
      }
    }
    return rows;
  }
  const teams = await fetchTeams(manager, signal);
  const agents = await fetchAgentsAllTeams(manager, teams, signal);
  return { count: agents.length, agents };
};

const teamRunner: Runner = async ({ manager, executor, signal, args, teamName }) => {
  // Team names are lowercase by convention. Normalize whichever arg slot carries
  // the team name before dispatch so `/team Idchain` and `/team delete Idchain`
  // work the same as the lowercase form.
  const normalized =
    args[0]?.toLowerCase() === 'delete'
      ? ['delete', ...args.slice(1).map((a, i) => (i === 0 ? a.toLowerCase() : a))]
      : args.map((a, i) => (i === 0 ? a.toLowerCase() : a));
  return runRemoteCommand(manager, executor, ['/team', ...normalized].join(' '), signal, teamName);
};

const scheduleRunner: Runner = async ({ manager, executor, signal, args, teamName }) => {
  const sub = args[0]?.toLowerCase() ?? '';
  if (!SCHEDULE_MUTATORS.has(sub)) {
    return {
      ok: false,
      error: 'Use `c` to open the calendar view. /schedule only handles add, pause, resume, remove.',
    };
  }
  return runRemoteCommand(manager, executor, ['/schedule', ...args].join(' '), signal, teamName);
};

const taskRunner: Runner = async ({ manager, executor, signal, args, teamName }) => {
  const sub = args[0]?.toLowerCase() ?? '';
  if (!TASK_MUTATORS.has(sub)) {
    return {
      ok: false,
      error:
        'Use `t` to open the tasks view. /task only handles assign, status, done, remove, delete. Use the manager dispatch path for /task create.',
    };
  }
  return runRemoteCommand(manager, executor, ['/task', ...args].join(' '), signal, teamName);
};

// §9 (D2): answered locally rather than forwarded. The manager also refuses
// /sync, but a local answer means the guidance is identical and instant even
// against a manager that has not been restarted since the removal.
const syncRunner: Runner = async () => ({ ok: false, error: SYNC_REMOVED_MESSAGE });

const heartbeatRunner: Runner = async ({ manager, executor, signal, args, teamName }) => {
  const sub = args[0]?.toLowerCase() ?? '';
  if (!HEARTBEAT_MUTATORS.has(sub)) {
    return {
      ok: false,
      error: 'Use `h` to open the heartbeats view. /heartbeat only handles enable, disable, fire.',
    };
  }
  return runRemoteCommand(manager, executor, ['/heartbeat', ...args].join(' '), signal, teamName);
};

// Execution adapters keyed by command name. `help`/`configs`/`output` are
// TUI-side navigation actions — the App-level submit handler intercepts them by
// name before calling run(); the inert bodies keep them in the catalog.
const RUNNERS: Record<string, Runner> = {
  agents: agentsRunner,
  help: async () => ({ tuiAction: 'help' }),
  configs: async () => ({ tuiAction: 'configs' }),
  output: async ({ args }) =>
    args[0] ? { tuiAction: 'output', agent: args[0] } : { ok: false, error: 'Usage: /output <agent>' },
  team: teamRunner,
  schedule: scheduleRunner,
  task: taskRunner,
  sync: syncRunner,
  heartbeat: heartbeatRunner,
  status: remoteRunner('status'),
  teams: remoteRunner('teams'),
  meta: remoteRunner('meta'),
  list: remoteRunner('list'),
  agent: remoteRunner('agent'),
  deploy: remoteRunner('deploy'),
  delete: remoteRunner('delete'),
  cancel: remoteRunner('cancel'),
};

// Compose the executable registry: renderer-neutral policy + TUI runner.
const REGISTRY: Record<string, CommandSpec> = {};
for (const name of policyNames()) {
  const policy = lookupPolicy(name);
  const run = RUNNERS[name];
  if (!policy || !run) continue;
  REGISTRY[name] = { ...policy, run };
}

export function lookupCommand(name: string): CommandSpec | null {
  return REGISTRY[name] ?? null;
}

export function knownCommandNames(): string[] {
  return Object.keys(REGISTRY).sort();
}

/** Help-view catalog grouped by tier, returning executable specs. */
export function catalogEntriesByTier(): Record<RiskTier, CommandSpec[]> {
  const byPolicy = policyCatalogEntriesByTier();
  const out: Record<RiskTier, CommandSpec[]> = { safe: [], powerful: [], destructive: [] };
  for (const tier of ['safe', 'powerful', 'destructive'] as const) {
    out[tier] = byPolicy[tier].map((p) => REGISTRY[p.name]).filter((s): s is CommandSpec => Boolean(s));
  }
  return out;
}
