// SPDX-License-Identifier: MIT

/**
 * Row types matching the actual database table schemas.
 *
 * JSON columns (config, metadata, registry, data, result) are typed as
 * Record<string, unknown> | null at the APPLICATION boundary.
 * Repository implementations handle parsing/stringifying internally,
 * so callers always receive parsed JS objects (or null).
 */

/** agents table row */
export interface AgentRow {
  team_id: string;
  id: string;
  name: string;
  type: string;
  model: string;
  port: number;
  endpoint: string | null;
  working_directory: string | null;
  status: string;
  created_at: number;
  registry: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  deleted_at: number | null;
  runtime: string;
  token_id: string | null;
  domain: string | null;
  api_key: string | null;
  /** Remote endpoint columns — populated only for public-agent-remote runtime. */
  customer_domain: string | null;
  public_endpoint_url: string | null;
  internal_endpoint_url: string | null;
  ssh_target: string | null;
  /** Phase 5 heartbeat probe columns. */
  last_seen: number | null;
  last_probed_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
}

/** teams table row */
export interface TeamRow {
  id: string;
  name: string;
  config: Record<string, unknown>;
  port_start: number;
  port_end: number;
  created_at: string;
  inbound_policy: 'open' | 'closed';
  lead_agent_id: string | null;
}

/** Inbox ownership — complements legacy `agent_id` during the transition. */
export type InboxOwnerKind = 'agent' | 'manager';

/** queries table row */
export interface QueryRow {
  team_id: string;
  /** Worker-agent FK when `owner_kind === 'agent'`; null for manager-owned inbox rows. */
  agent_id: string | null;
  query_id: string;
  status: string;
  prompt: string | null;
  created: number;
  completed: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
  session_id: string | null;
  owner_kind: InboxOwnerKind;
  owner_id: string;
}

/** news_items table row */
export interface NewsItemRow {
  id: number;
  team_id: string;
  /** Worker-agent FK when `owner_kind === 'agent'`; null for manager-owned inbox rows. */
  agent_id: string | null;
  timestamp: number;
  type: string;
  message: string | null;
  data: Record<string, unknown> | null;
  query_id: string | null;
  /** Structured classifier: 'talk' (reply expected) or 'notify' (fire-and-forget). */
  kind: 'talk' | 'notify' | null;
  /** Does the sender expect a reply? Mirrors kind but kept explicit for clarity. */
  reply_expected: boolean | null;
  owner_kind: InboxOwnerKind;
  owner_id: string;
}

/** schedule_definitions table row */
export interface ScheduleDefinitionRow {
  id: string;
  kind: 'heartbeat' | 'calendar';
  title: string;
  description: string | null;
  active: boolean;
  message: string;
  sender: string;
  delivery_mode: 'talk' | 'internal';
  timezone: string | null;
  catch_up_policy: 'skip' | 'fire_once';
  dedupe_window_seconds: number;
  interval_seconds: number | null;
  anchor_at: number | null;
  max_runs: number | null;
  expires_at: number | null;
  local_time_seconds: number | null;
  local_date: string | null;
  days_of_week: string | null;
  source_type: string;
  source_key: string | null;
  created_at: number;
  updated_at: number;
}

/** schedule_runs table row */
export interface ScheduleRunRow {
  schedule_id: string;
  agent_id: string;
  scheduled_key: string;
  scheduled_at: number;
  fired_at: number;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  error: string | null;
}

/** tasks table row */
export interface TaskRow {
  id: string;
  name: string;
  uuid: string;
  team_id: string | null;
  title: string;
  description: string | null;
  status: 'todo' | 'doing' | 'done';
  created_by: string | null;
  owner: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

/** task_event_links table row */
export interface TaskEventLinkRow {
  task_id: string;
  schedule_id: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Wakeup service rows (event_log, subscriptions, webhook_delivery_attempts)
// ---------------------------------------------------------------------------

/** event_log table row — append-only durable event bus entry. */
export interface EventLogRow {
  seq: number;
  team_id: string;
  topic: string;
  actor_agent_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  occurred_at: number;
  data: Record<string, unknown>;
}

/** subscriptions table row — durable consumer registration. */
export interface SubscriptionRow {
  id: string;
  team_id: string;
  owner_agent_id: string;
  mode: 'sse' | 'webhook';
  status: 'active' | 'paused' | 'unhealthy' | 'deleted';
  filter: Record<string, unknown>;
  target: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  last_acked_seq: number | null;
  last_error: string | null;
  consecutive_failures: number;
}

/** webhook_delivery_attempts table row — per-event delivery bookkeeping. */
export interface WebhookDeliveryAttemptRow {
  id: string;
  subscription_id: string;
  event_seq: number;
  scheduled_at: number;
  attempted_at: number | null;
  status: 'pending' | 'delivered' | 'failed' | 'dead';
  http_status: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Checkin primitive (output/checkin-primitive-design.md)
// ---------------------------------------------------------------------------

export type CheckinStatus = 'active' | 'snoozed' | 'closed' | 'expired';
export type CheckinPriority = 'low' | 'normal' | 'high';

/** checkins table row — task watch with periodic due fires. */
export interface CheckinRow {
  id: string;
  team_id: string;
  owner_agent_id: string | null;
  created_by_agent_id: string | null;
  linked_task_id: string | null;
  interval_seconds: number;
  priority: CheckinPriority;
  status: CheckinStatus;
  close_when: Record<string, unknown>;
  max_iterations: number | null;
  iteration_count: number;
  next_fire_at: number | null;
  snooze_until: number | null;
  ttl_expires_at: number | null;
  last_fire_at: number | null;
  last_event_seq: number | null;
  note: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  closed_reason: string | null;
}

/**
 * Fields a caller is allowed to mutate on an existing checkin row via
 * `CheckinsRepository.updateFields`. `id`, `team_id`, and `created_at` are
 * immutable; `iteration_count` only goes up; `closed_at`/`closed_reason`
 * are set together by `close` / `closeForTerminalTask`.
 */
export type MutableCheckinFields = Partial<{
  owner_agent_id: string | null;
  linked_task_id: string | null;
  interval_seconds: number;
  priority: CheckinPriority;
  status: CheckinStatus;
  close_when: Record<string, unknown>;
  max_iterations: number | null;
  iteration_count: number;
  next_fire_at: number | null;
  snooze_until: number | null;
  ttl_expires_at: number | null;
  last_fire_at: number | null;
  last_event_seq: number | null;
  note: string | null;
  closed_at: number | null;
  closed_reason: string | null;
}> & { updated_at: number };
