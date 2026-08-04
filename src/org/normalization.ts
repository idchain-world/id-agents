// SPDX-License-Identifier: MIT

export const ORG_MAX_DEPTH = 32;
export const ORG_MAX_GROUPS = 1_000;

/** Shared key normalization for parser, service, backfill, SQLite and Postgres writes. */
export function normalizeOrgKey(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function containsUnexpandedTemplate(value: string): boolean {
  return /\$\{[^}]+\}/.test(value);
}
