// SPDX-License-Identifier: MIT

/**
 * Commit 16: federation listener configuration.
 *
 * Disabled is the default. With no bind configured no socket is opened, an
 * inbound peer gets only a connection failure, and the management API is never
 * a fallback federation endpoint. The bound address is the trust boundary in
 * operational terms, so the wildcard is refused rather than warned about: it
 * silently exposes the port to every network the machine is attached to, and a
 * warning is not a gate.
 */

export const FEDERATION_WILDCARD_ADDRESSES = new Set(['0.0.0.0', '::', '[::]', '*']);

export type FederationListenerConfig =
  | { enabled: false }
  | { enabled: true; address: string; port: number; wildcardAcknowledged: boolean };

export class FederationConfigError extends Error {
  constructor(readonly code: 'peer_route_invalid') {
    super('peer_route_invalid');
    this.name = 'FederationConfigError';
  }
}

export interface FederationEnvironment {
  ID_FEDERATION_BIND_ADDRESS?: string;
  ID_FEDERATION_BIND_PORT?: string;
  ID_FEDERATION_ALLOW_WILDCARD_BIND?: string;
}

/**
 * Both an address and a port are required to enable the listener. A partial
 * configuration is refused rather than completed with a default, because
 * guessing half of a trust boundary is how a port ends up somewhere nobody
 * intended.
 */
export function resolveFederationListenerConfig(
  env: FederationEnvironment = process.env as FederationEnvironment,
): FederationListenerConfig {
  const address = env.ID_FEDERATION_BIND_ADDRESS?.trim();
  const rawPort = env.ID_FEDERATION_BIND_PORT?.trim();
  if (!address && !rawPort) return { enabled: false };
  if (!address || !rawPort) throw new FederationConfigError('peer_route_invalid');

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new FederationConfigError('peer_route_invalid');
  }

  const wildcardAcknowledged = env.ID_FEDERATION_ALLOW_WILDCARD_BIND === '1'
    || env.ID_FEDERATION_ALLOW_WILDCARD_BIND === 'true';
  if (FEDERATION_WILDCARD_ADDRESSES.has(address) && !wildcardAcknowledged) {
    throw new FederationConfigError('peer_route_invalid');
  }

  return { enabled: true, address, port, wildcardAcknowledged };
}

/** The exact active bind, reported at startup so exposure is inspectable. */
export function describeFederationBind(config: FederationListenerConfig): string {
  if (!config.enabled) return 'federation listener disabled (no bind configured)';
  const wildcard = FEDERATION_WILDCARD_ADDRESSES.has(config.address)
    ? ' (WILDCARD: reachable on every attached network)'
    : '';
  return `federation listener bound to ${config.address}:${config.port}${wildcard}`;
}
