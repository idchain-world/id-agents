// SPDX-License-Identifier: MIT

import {
  InterteamAdminClient,
  contactIsReachable,
  describeProbeOutcome,
  type ContactWithReachability,
  type PeerRouteProbeRow,
  type PeerRouteRow,
} from '../api/interteam.js';

/**
 * Item 8's presentation state, headless. The Ink components render whatever
 * these controllers hold; everything that can go wrong lives here, where it is
 * testable, because the repo's TUI tests exercise logic rather than rendered
 * frames.
 *
 * Two rules are load-bearing. Polling runs only while the view is focused, so
 * a backgrounded view costs nothing and a probe result the operator asked for
 * is not silently replaced mid-read. And a probe failure is a state on the row,
 * never a thrown error: `unreachable` is a fact about the network, and the
 * operator asked precisely in order to learn it.
 */

export interface ControllerOptions {
  client: InterteamAdminClient;
  pollMs?: number;
  /** Injected in tests. Defaults to real timers. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  onChange?: () => void;
}

const DEFAULT_POLL_MS = 5000;

abstract class FocusPolledController<Row> {
  rows: Row[] = [];
  // Starts true so the first paint says loading rather than claiming an empty
  // list; the first refresh, triggered by focus, settles it either way.
  loading = true;
  /** A list failure, rendered in the header. Cleared by the next good read. */
  error: string | null = null;
  private focused = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;

  protected constructor(protected readonly options: ControllerOptions) {}

  protected abstract load(): Promise<Row[]>;

  /** Focus is the only thing that starts polling; blur is what stops it. */
  setFocused(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    if (focused) {
      void this.refresh();
      const setIntervalFn = this.options.setIntervalFn ?? setInterval;
      this.timer = setIntervalFn(() => void this.refresh(), this.options.pollMs ?? DEFAULT_POLL_MS);
    } else if (this.timer !== null) {
      const clearIntervalFn = this.options.clearIntervalFn ?? clearInterval;
      clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  isFocused(): boolean {
    return this.focused;
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.loading = true;
    this.options.onChange?.();
    try {
      const rows = await this.load();
      // A stale response from before a blur/refocus must not clobber a newer one.
      if (generation !== this.generation) return;
      this.rows = rows;
      this.error = null;
    } catch (error) {
      if (generation !== this.generation) return;
      // The old rows stay visible: a poll failure means "could not refresh",
      // not "there are no rows", and rendering an empty list would say the latter.
      this.error = (error as Error).message;
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.options.onChange?.();
      }
    }
  }

  dispose(): void {
    this.setFocused(false);
  }
}

/** One route as the node connections view renders it. */
export interface NodeConnectionRow {
  route: PeerRouteRow;
  /** Last explicit probe of this route, if any. Never fetched by polling. */
  probe: PeerRouteProbeRow | null;
  probing: boolean;
  /** The status cell: 'enabled'/'disabled' until probed, then the outcome. */
  status: string;
}

export class NodeConnectionsController extends FocusPolledController<NodeConnectionRow> {
  constructor(options: ControllerOptions) {
    super(options);
  }

  protected async load(): Promise<NodeConnectionRow[]> {
    const routes = await this.options.client.listRoutes();
    // Probe results survive the poll: they are the operator's, replaced only by
    // the operator probing again or the route disappearing.
    const previous = new Map(this.rows.map((row) => [row.route.nodeId, row]));
    return routes.map((route) => {
      const before = previous.get(route.nodeId);
      const probe = before?.probe ?? null;
      return {
        route,
        probe,
        probing: before?.probing ?? false,
        status: statusCell(route, probe),
      };
    });
  }

  /** Explicit, one route. The outcome lands on the row as a state. */
  async probe(nodeId: string): Promise<void> {
    const row = this.rows.find((candidate) => candidate.route.nodeId === nodeId);
    if (!row || row.probing) return;
    row.probing = true;
    row.status = 'probing…';
    this.options.onChange?.();
    try {
      row.probe = await this.options.client.probeRoute(nodeId);
    } catch (error) {
      // A failed probe request is itself an answer about reachability of the
      // manager, shown on the row like any other outcome.
      row.probe = {
        nodeId,
        outcome: 'unreachable',
        baseUrl: row.route.baseUrl,
        enabled: row.route.enabled,
        diagnostic: (error as Error).message,
        probedAt: Date.now(),
      };
    } finally {
      row.probing = false;
      row.status = statusCell(row.route, row.probe);
      this.options.onChange?.();
    }
  }
}

function statusCell(route: PeerRouteRow, probe: PeerRouteProbeRow | null): string {
  if (probe) return describeProbeOutcome(probe);
  return route.enabled ? 'enabled, not probed' : 'disabled';
}

/** One contact as the contacts view renders it. */
export interface ContactViewRow {
  contact: ContactWithReachability;
  /** 'route ok' | 'route disabled' | 'no route' — the join item 7 exists for. */
  reachability: string;
}

export class ContactsController extends FocusPolledController<ContactViewRow> {
  constructor(options: ControllerOptions) {
    super(options);
  }

  protected async load(): Promise<ContactViewRow[]> {
    const contacts = await this.options.client.listContactsWithReachability();
    return contacts.map((contact) => ({
      contact,
      reachability: contactIsReachable(contact)
        ? 'route ok'
        : contact.routeConfigured
          ? 'route disabled'
          : 'no route',
    }));
  }
}
