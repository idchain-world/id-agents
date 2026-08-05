// SPDX-License-Identifier: MIT

import { INTERTEAM_ADDRESS_HINT } from '../inter-team/origin-client.js';

/**
 * Commit 10 — thin inter-team client over the manager HTTP surface.
 *
 * Clients prefer `team:<alias>` (the team routes it to its lead);
 * `team:<alias>/<agent-name>` and the immutable agent ID are the permitted
 * direct paths. Everything here talks to the local manager only — no caller
 * ever dials a worker URL, and collection is a pull the origin repeats.
 */
export { INTERTEAM_ADDRESS_HINT };

export interface InterTeamCliOptions {
  managerUrl: string;
  team: string;
  agentId?: string;
  fetchImpl?: typeof fetch;
}

export class InterTeamCli {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: InterTeamCliOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Id-Team': this.options.team,
      ...(this.options.agentId
        ? { 'X-Id-Agent': this.options.agentId }
        : { 'X-Id-Admin': '1' }),
    };
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(`${this.options.managerUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers as Record<string, string> | undefined) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = (body as { error?: string }).error ?? `http_${response.status}`;
      throw new Error(code);
    }
    return body;
  }

  /** `address` is `team:<alias>` or `team:<alias>/<agent-name>`; pass agentId for the ID path. */
  async send(input: { address: string; body: unknown; agentId?: string }): Promise<{
    conversationId: string;
    messageId: string;
    state: string;
    deduplicated: boolean;
  }> {
    return await this.request('/inter-team/send', {
      method: 'POST',
      body: JSON.stringify({ address: input.address, agentId: input.agentId, body: input.body }),
    }) as { conversationId: string; messageId: string; state: string; deduplicated: boolean };
  }

  async continueConversation(conversationId: string, body: unknown): Promise<{
    conversationId: string;
    messageId: string;
    state: string;
  }> {
    return await this.request(`/inter-team/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }) as { conversationId: string; messageId: string; state: string };
  }

  /** Non-consuming: safe to repeat until the state is terminal. */
  async collect(conversationId: string, messageId: string): Promise<Record<string, unknown>> {
    return await this.request(
      `/inter-team/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    ) as Record<string, unknown>;
  }

  async listConversations(state?: 'outstanding' | 'terminal'): Promise<Record<string, unknown>> {
    const query = state ? `?state=${state}` : '';
    return await this.request(`/inter-team/conversations${query}`) as Record<string, unknown>;
  }

  async roster(alias: string): Promise<Record<string, unknown>> {
    return await this.request(`/inter-team/descriptor/${encodeURIComponent(alias)}`) as Record<string, unknown>;
  }
}
