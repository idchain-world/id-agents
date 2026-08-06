// Copyright (c) 2026 Ride Agentic Inc. All rights reserved.
/**
 * Health and port probes for the loopback manager. `fetch`/`net` are injected
 * so the lifecycle service is fully unit/integration testable without real
 * sockets. A health probe hits `GET <url>/health`; a 2xx means "adopt me".
 */

import net from 'node:net';

export type FetchLike = (
  url: string,
  init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number }>;

/**
 * True when the manager answers `GET <url>/health` with a 2xx inside `timeoutMs`.
 * Any network error, timeout, or non-2xx is treated as "not healthy".
 */
export async function probeManagerHealth(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs = 750,
  headers?: Record<string, string>,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url}/health`, { method: 'GET', signal: controller.signal, headers });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when something is already listening on `host:port`. Used only after a
 * failed health probe: an occupied-but-unhealthy port is an ambiguous occupant
 * the app must refuse to spawn over.
 */
export function isPortOccupied(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true)); // something is listening
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false)); // ECONNREFUSED → nothing listening
    socket.connect(port, host);
  });
}
