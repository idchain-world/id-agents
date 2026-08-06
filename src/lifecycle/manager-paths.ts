// Copyright (c) 2026 Ride Agentic Inc. All rights reserved.
/**
 * Pure resolution of the manager URL and local lifecycle policy.
 *
 * URL precedence (highest first): persisted preference → `--manager-url` argv →
 * `MANAGER_URL` / `ID_MANAGER_URL` env → loopback default. Automatic lifecycle
 * control is limited to the loopback default (`127.0.0.1:4100`); a remote or
 * non-default URL is monitored only, never spawned or killed.
 */

export const DEFAULT_MANAGER_HOST = '127.0.0.1';
export const DEFAULT_MANAGER_PORT = 4100;
export const DEFAULT_MANAGER_URL = `http://${DEFAULT_MANAGER_HOST}:${DEFAULT_MANAGER_PORT}`;

export interface ManagerUrlSources {
  preference?: string | null;
  argv?: string[];
  env?: Record<string, string | undefined>;
}

function argFlag(argv: string[] | undefined, flag: string): string | undefined {
  if (!argv) return undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === flag && i + 1 < argv.length) return argv[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

function normalize(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, '');
}

export function resolveManagerUrl(sources: ManagerUrlSources = {}): string {
  return (
    normalize(sources.preference) ??
    normalize(argFlag(sources.argv, '--manager-url')) ??
    normalize(sources.env?.MANAGER_URL) ??
    normalize(sources.env?.ID_MANAGER_URL) ??
    DEFAULT_MANAGER_URL
  );
}

/**
 * True only when the URL is the loopback daemon this app is allowed to
 * auto-manage (spawn/adopt). Any other host or port is monitor-only.
 */
export function isManagedLoopback(url: string, allowNonDefaultPort = false): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return isLoopback && (port === DEFAULT_MANAGER_PORT || allowNonDefaultPort);
}

export function managerPort(url: string): number {
  try {
    const parsed = new URL(url);
    return Number(parsed.port) || DEFAULT_MANAGER_PORT;
  } catch {
    return DEFAULT_MANAGER_PORT;
  }
}

// The manager daemon entry is resolved from the installed id-agents
// dependency by `src/main/runtime/id-agents-paths.ts` (plan §5, commit 10);
// the old repoRoot-based managerEntryPath() helper was removed with the
// conflated repoRoot.
