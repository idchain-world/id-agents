// SPDX-License-Identifier: MIT

import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConnectPrompt, DEFAULT_MANAGER_URL } from '../../connect/connect-prompt.js';

/**
 * Item 6: Connect in a terminal.
 *
 * This is an information surface and nothing more. On macOS the app shows the
 * same four values in a window; over SSH the operator copies them into a second
 * terminal and starts a coding agent there. That works with no pairing, no
 * credential, and no network path, because both terminals are on the same host
 * as the same user, and a manager and its workers there are already one trust
 * domain.
 *
 * The management URL shown is always loopback. The convenience that makes
 * terminal two work with no configuration is the same property that would be
 * catastrophic if the management API were ever bound to a public interface, so
 * this view must never display or offer a non-loopback one.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** The read-only package assets, resolved from this module, never from cwd. */
export function dependencyRoot(): string {
  return path.resolve(here, '../../..');
}

export interface TuiConnectView {
  managerUrl: string;
  dependencyRoot: string;
  quickstartPath: string;
  adminSkillPath: string;
  writableConfigRoot: string;
  /** The copy-paste text for the coding agent in the second terminal. */
  prompt: string;
}

export class NonLoopbackManagerUrlError extends Error {
  constructor(readonly managerUrl: string) {
    super('connect refuses a non-loopback management URL');
    this.name = 'NonLoopbackManagerUrlError';
  }
}

function isLoopbackUrl(managerUrl: string): boolean {
  try {
    const { hostname } = new URL(managerUrl);
    return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost';
  } catch {
    return false;
  }
}

export function buildTuiConnectView(input: {
  managerUrl?: string;
  dependencyRoot?: string;
  writableConfigRoot?: string;
} = {}): TuiConnectView {
  const managerUrl = input.managerUrl ?? DEFAULT_MANAGER_URL;
  // A non-loopback management URL is refused rather than displayed. Showing one
  // would document an exposure the design forbids.
  if (!isLoopbackUrl(managerUrl)) throw new NonLoopbackManagerUrlError(managerUrl);

  const root = input.dependencyRoot ?? dependencyRoot();
  const view = {
    managerUrl,
    dependencyRoot: root,
    quickstartPath: path.join(root, 'QUICKSTART.md'),
    adminSkillPath: path.join(root, 'skills', 'idagents-admin-control'),
    writableConfigRoot: input.writableConfigRoot ?? path.join(os.homedir(), '.id-agents'),
  };
  return { ...view, prompt: buildConnectPrompt(view) };
}
