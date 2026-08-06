// SPDX-License-Identifier: MIT
/**
 * Item 4: bind safety on a machine the internet can reach.
 *
 * The wildcard override exists for containers, where an interface address is
 * not knowable in advance. On a public VPS that same override is the dangerous
 * case, because the federation listener has no authentication. So the override
 * stops being sufficient once the machine holds a public address, and the
 * management API has no override at all.
 *
 * Interfaces are injected, so the refusal is proven rather than assumed on a
 * machine that happens not to have a public address today.
 */
import { describe, expect, it } from 'vitest';
import {
  assertManagementBindIsLoopback,
  describeFederationBind,
  resolveFederationListenerConfig,
} from '../../src/inter-team/federation-config.js';
import { inspectPublicAddresses, isPrivateAddress } from '../../src/inter-team/public-address.js';

const privateOnly = {
  lo0: [{ address: '127.0.0.1', internal: true }],
  eth0: [{ address: '172.18.0.2', internal: false }],
};
const withPublic = {
  lo0: [{ address: '127.0.0.1', internal: true }],
  eth0: [{ address: '203.0.113.10', internal: false }],
  tailscale0: [{ address: '100.101.102.103', internal: false }],
};

describe('address classification', () => {
  it('treats loopback, RFC1918, link-local, CGNAT and unique-local as private', () => {
    for (const address of [
      '127.0.0.1', '::1', '10.1.2.3', '192.168.1.4', '172.16.0.1', '172.31.255.254',
      '169.254.1.1', 'fe80::1', 'fd00::1', '100.64.0.1', '100.127.255.254',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('treats routable addresses and the wildcards as not private', () => {
    for (const address of ['203.0.113.10', '8.8.8.8', '172.32.0.1', '2606:4700::1', '0.0.0.0', '::']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('reports public exposure only from external interfaces', () => {
    expect(inspectPublicAddresses(privateOnly)).toEqual({ hasPublicAddress: false, publicAddresses: [] });
    const exposed = inspectPublicAddresses(withPublic);
    expect(exposed.hasPublicAddress).toBe(true);
    // A Tailscale address is CGNAT and is not public exposure.
    expect(exposed.publicAddresses).toEqual(['203.0.113.10']);
  });
});

describe('federation bind', () => {
  const wildcard = {
    ID_FEDERATION_BIND_ADDRESS: '0.0.0.0',
    ID_FEDERATION_BIND_PORT: '4400',
    ID_FEDERATION_ALLOW_WILDCARD_BIND: '1',
  };

  it('still starts on a private-only machine with the container override', () => {
    expect(resolveFederationListenerConfig(wildcard, privateOnly)).toMatchObject({
      enabled: true, address: '0.0.0.0', wildcardAcknowledged: true,
    });
  });

  it('refuses a wildcard on a machine with a public address, override alone not enough', () => {
    expect(() => resolveFederationListenerConfig(wildcard, withPublic)).toThrow('peer_route_invalid');
  });

  it('accepts it only with the separate public-exposure acknowledgement', () => {
    expect(resolveFederationListenerConfig(
      { ...wildcard, ID_FEDERATION_ALLOW_PUBLIC_EXPOSURE: '1' },
      withPublic,
    )).toMatchObject({ enabled: true, address: '0.0.0.0' });
  });

  it('starts on a specific private address on a public machine, no acknowledgement needed', () => {
    // Binding the Tailscale address on a VPS is the intended configuration.
    const config = resolveFederationListenerConfig(
      { ID_FEDERATION_BIND_ADDRESS: '100.101.102.103', ID_FEDERATION_BIND_PORT: '4400' },
      withPublic,
    );
    expect(config).toMatchObject({ enabled: true, address: '100.101.102.103' });
    expect(describeFederationBind(config)).not.toContain('WILDCARD');
  });

  it('still refuses an incomplete bind and stays disabled by default', () => {
    expect(resolveFederationListenerConfig({}, withPublic)).toEqual({ enabled: false });
    expect(() => resolveFederationListenerConfig(
      { ID_FEDERATION_BIND_ADDRESS: '0.0.0.0' }, privateOnly,
    )).toThrow('peer_route_invalid');
  });
});

describe('management bind', () => {
  it('accepts loopback', () => {
    for (const address of ['127.0.0.1', '::1', 'localhost']) {
      expect(() => assertManagementBindIsLoopback(address)).not.toThrow();
    }
  });

  it('refuses anything else, with no override available', () => {
    for (const address of ['0.0.0.0', '::', '203.0.113.10', '100.101.102.103', '192.168.1.4']) {
      expect(() => assertManagementBindIsLoopback(address), address).toThrow('peer_route_invalid');
    }
  });
});
