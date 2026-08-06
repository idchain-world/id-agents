// SPDX-License-Identifier: MIT

import { networkInterfaces } from 'node:os';

/**
 * Item 4: is this machine reachable from the internet?
 *
 * The wildcard override exists because a container cannot know its own
 * interface address in advance, and on a private Docker network that is
 * harmless. On a public VPS the same override is the dangerous case, because
 * the federation listener has no authentication and would then be answering the
 * internet. So the override alone stops being sufficient once the machine has a
 * public address, and a second, separate acknowledgement is required.
 *
 * This classifies addresses rather than probing reachability. A machine can
 * hold a public address and still be firewalled, and a machine behind NAT can
 * be exposed by a forwarded port. Neither is knowable from inside the process,
 * so the rule is deliberately conservative: a public address on an interface is
 * treated as public exposure, and the operator can still say yes explicitly.
 */

/** Loopback, RFC1918, link-local, CGNAT, and unique-local ranges. */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/%.*$/, '');
  if (value === '' || value === '::' || value === '0.0.0.0') return false;
  if (value === '::1' || value.startsWith('127.')) return true;
  if (value.startsWith('10.')) return true;
  if (value.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return true;
  // 100.64.0.0/10 is CGNAT, which is also the Tailscale range.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value)) return true;
  if (value.startsWith('169.254.')) return true;
  if (value.startsWith('fe80:')) return true;
  // fc00::/7, unique local.
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true;
  return false;
}

export interface PublicAddressReport {
  hasPublicAddress: boolean;
  publicAddresses: string[];
}

/**
 * Interfaces are injectable so the refusal can be tested without needing a
 * machine that actually holds a public address.
 */
export function inspectPublicAddresses(
  interfaces: NodeJS.Dict<Array<{ address: string; internal: boolean }>> = networkInterfaces(),
): PublicAddressReport {
  const publicAddresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (isPrivateAddress(entry.address)) continue;
      publicAddresses.push(entry.address);
    }
  }
  return { hasPublicAddress: publicAddresses.length > 0, publicAddresses };
}
