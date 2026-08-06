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

import { inspectPublicAddresses } from './public-address.js';

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
  /** Separate from the wildcard override, and required on a public machine. */
  ID_FEDERATION_ALLOW_PUBLIC_EXPOSURE?: string;
}

/**
 * The management API is loopback and stays loopback. Unlike the federation
 * bind, this has no override at all: an unauthenticated management API
 * reachable from the internet is not a degraded configuration, it is total
 * compromise. This is a guard on an invariant rather than a setting, so it
 * cannot be made violable by a later change that adds configurability.
 */
export function assertManagementBindIsLoopback(address: string): void {
  if (address !== '127.0.0.1' && address !== '::1' && address !== 'localhost') {
    throw new FederationConfigError('peer_route_invalid');
  }
}

/**
 * Both an address and a port are required to enable the listener. A partial
 * configuration is refused rather than completed with a default, because
 * guessing half of a trust boundary is how a port ends up somewhere nobody
 * intended.
 */
export function resolveFederationListenerConfig(
  env: FederationEnvironment = process.env as FederationEnvironment,
  interfaces?: NodeJS.Dict<Array<{ address: string; internal: boolean }>>,
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
  const isWildcard = FEDERATION_WILDCARD_ADDRESSES.has(address);
  if (isWildcard && !wildcardAcknowledged) {
    throw new FederationConfigError('peer_route_invalid');
  }

  // The container override is not enough once the machine can be reached from
  // the internet, because the federation listener has no authentication. A
  // second, separate acknowledgement is required, so nobody carries a Docker
  // habit onto a public VPS by accident.
  if (isWildcard) {
    const exposure = inspectPublicAddresses(interfaces);
    const publicExposureAcknowledged = env.ID_FEDERATION_ALLOW_PUBLIC_EXPOSURE === '1'
      || env.ID_FEDERATION_ALLOW_PUBLIC_EXPOSURE === 'true';
    if (exposure.hasPublicAddress && !publicExposureAcknowledged) {
      throw new FederationConfigError('peer_route_invalid');
    }
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
