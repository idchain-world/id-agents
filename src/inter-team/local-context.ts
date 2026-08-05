// SPDX-License-Identifier: MIT

import type { InterteamFoundationStore, TeamContact } from './foundation-store.js';

export const LOCAL_TRUST_BOUNDARY_NOTICE =
  'V1 trusts same-host caller assertions: a malicious same-UID worker can forge another team. '
  + 'The operator surface assumes a direct loopback connection; a reverse proxy changes the admin boundary.';

export type TrustedLocalPrincipal =
  | 'agent-header'
  | 'manager-launch'
  | 'manager-internal'
  | 'operator';

/**
 * A trusted same-host assertion, not an authentication credential.
 *
 * V1 assumes the manager and local workers share one host trust domain. A
 * malicious same-UID process can forge these values; this type exists to keep
 * ordinary source-team routing mistakes out of request bodies.
 */
export interface TrustedLocalSourceContext {
  localTeamId: string;
  principal: TrustedLocalPrincipal;
  agentId?: string | null;
}

export class LocalSourceContextError extends Error {
  constructor(
    readonly code:
      | 'source_context_mismatch'
      | 'source_unauthorized'
      | 'contact_not_found'
      | 'invalid_address',
  ) {
    super(code);
    this.name = 'LocalSourceContextError';
  }
}

const BODY_TEAM_KEYS = [
  'localTeamId',
  'local_team_id',
  'sourceTeamId',
  'source_team_id',
  'teamId',
  'team_id',
  'team',
] as const;

/** Derive local team only from typed/header context; a body may only agree. */
export function deriveLocalTeamId(
  context: TrustedLocalSourceContext,
  body?: Record<string, unknown> | null,
): string {
  if (!context.localTeamId) throw new LocalSourceContextError('source_context_mismatch');
  for (const key of BODY_TEAM_KEYS) {
    if (body?.[key] !== undefined && body[key] !== context.localTeamId) {
      throw new LocalSourceContextError('source_context_mismatch');
    }
  }
  return context.localTeamId;
}

/**
 * Resolve an alias inside the derived team, or validate a globally selected
 * contact ID against that owner. Only the latter can return
 * source_unauthorized; the frozen code is specifically a contact-owner clash.
 */
export async function resolveOwnedContact(
  store: InterteamFoundationStore,
  input: {
    context: TrustedLocalSourceContext;
    body?: Record<string, unknown> | null;
    alias?: string;
    contactId?: string;
  },
): Promise<TeamContact> {
  const localTeamId = deriveLocalTeamId(input.context, input.body);
  if (!!input.alias === !!input.contactId) throw new LocalSourceContextError('invalid_address');

  if (input.contactId) {
    const contact = await store.getContactById(input.contactId);
    if (!contact) throw new LocalSourceContextError('contact_not_found');
    if (contact.localTeamId !== localTeamId) {
      throw new LocalSourceContextError('source_unauthorized');
    }
    return contact;
  }

  const contact = await store.getContactByAlias(localTeamId, input.alias!);
  if (!contact) throw new LocalSourceContextError('contact_not_found');
  return contact;
}
