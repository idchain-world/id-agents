// SPDX-License-Identifier: MIT
/**
 * Builds the copy-paste Connect prompt for any coding agent. The prompt POINTS
 * the agent at the quickstart doc, which holds the full add-skill,
 * deploy-default-team, and dispatch procedure, rather than inlining it. Every
 * path is real and supplied by the caller: the immutable id-agents dependency
 * assets and the writable config root are distinct locations, and this module
 * does no path concatenation. Pure and testable.
 *
 * It lives in core because two surfaces need the same text. On macOS the
 * desktop app runs the manager; on a headless VPS the TUI does, and terminal
 * two reaches it over loopback with no pairing or credential, because a manager
 * and its workers on one host are already one trust domain. The prompt must
 * therefore not claim any particular surface owns the manager, only that one is
 * already running.
 */

export interface ConnectPromptInput {
  dependencyRoot: string;
  quickstartPath: string;
  adminSkillPath: string;
  writableConfigRoot: string;
  managerUrl: string;
}

/** The default loopback manager URL, whichever surface started it. */
export const DEFAULT_MANAGER_URL = 'http://127.0.0.1:4100';

export function buildConnectPrompt(input: ConnectPromptInput): string {
  const dependencyRoot = input.dependencyRoot || '<dependencyRoot>';
  const quickstartPath = input.quickstartPath || '<quickstartPath>';
  const adminSkillPath = input.adminSkillPath || '<adminSkillPath>';
  const writableConfigRoot = input.writableConfigRoot || '<writableConfigRoot>';
  const managerUrl = input.managerUrl || DEFAULT_MANAGER_URL;
  return `An ID Agents manager is already running at ${managerUrl}, started by the desktop app or the TUI. Do NOT start, restart, or spawn a second manager.

1. ALWAYS get the idagents-admin-control skill at ${adminSkillPath} and make it available however your agent loads skills (Claude Code: copy into .claude/skills/) — it's how you drive the manager, and a fresh session needs it even when team agents already exist. This does NOT create any team agents.
2. curl ${managerUrl}/agents — if it lists agents this is a RECONNECT: do NOT deploy or add any TEAM agents, just connect and work with them. Only if there are ZERO agents, deploy the default team.

Full steps: the quickstart at ${quickstartPath}. Read it and the skill in place — they're in the read-only id-agents dependency at ${dependencyRoot}; editable configs live at ${writableConfigRoot}.`;
}
