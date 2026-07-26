// SPDX-License-Identifier: MIT

/**
 * Normalize deploy config schedule inputs into ScheduleDefinitionRow objects.
 */

import { createHash } from 'node:crypto';
import type { HeartbeatConfig, CalendarSpec } from '../config-parser.js';
import type { ScheduleDefinitionRow } from '../db/types.js';

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function stableId(prefix: string, sourceKey: string): string {
  const hash = createHash('sha1').update(sourceKey).digest('hex').slice(0, 16);
  return `${prefix}_${hash}`;
}

/**
 * Validate that an interval value is within the allowed range.
 */
export function validateIntervalSeconds(seconds: number): void {
  if (seconds < 60) {
    throw new Error(
      `Interval too short: ${seconds}s. Minimum interval is 60 seconds (1 minute).`
    );
  }
  if (seconds > 86400) {
    throw new Error(
      `Interval too long: ${seconds}s. Maximum interval is 86400 seconds (24 hours).`
    );
  }
}

export function parseTimeString(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    throw new Error(`Invalid time format: ${value}. Expected HH:MM or HH:MM:SS.`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || '0');

  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid time value: ${value}.`);
  }

  return hour * 3600 + minute * 60 + second;
}

function normalizeDays(days: string[]): string {
  const allowed = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  const normalized = Array.from(new Set(days.map((d) => d.trim().toLowerCase())));
  for (const day of normalized) {
    if (!allowed.has(day)) {
      throw new Error(`Invalid day of week: ${day}`);
    }
  }
  return normalized.join(',');
}

function calendarMessage(spec: CalendarSpec): string {
  if (spec.message && spec.message.trim()) return spec.message.trim();
  if (spec.description && spec.description.trim()) {
    return `[Calendar Event: "${spec.title}"]
${spec.description.trim()}`;
  }
  return `[Calendar Event: "${spec.title}"]`;
}

/** Generic message sent for new-model heartbeats (agent reads its own HEARTBEAT.md) */
export const HEARTBEAT_GENERIC_MESSAGE = 'Heartbeat: read your HEARTBEAT.md checklist and act on anything that needs attention. If nothing needs action, respond with HEARTBEAT_OK.';

/**
 * The schedule id for an agent's heartbeat. Deterministic, so a heartbeat
 * schedule can be looked up directly by id without a scan — `listSchedulesForAgent`
 * filters to active rows only and therefore cannot find a PAUSED heartbeat.
 */
export function heartbeatScheduleId(agentId: string): string {
  return `hb_${agentId}`;
}

export function heartbeatToSchedule(
  agentId: string,
  agentName: string,
  config: number | HeartbeatConfig,
  nowSec?: number,
): { definition: ScheduleDefinitionRow; agentIds: string[] } {
  const isLegacy = typeof config === 'object';
  const interval = isLegacy ? config.interval : config;
  validateIntervalSeconds(interval);

  const now = nowSec ?? Math.floor(Date.now() / 1000);

  const definition: ScheduleDefinitionRow = {
    id: heartbeatScheduleId(agentId),
    kind: 'heartbeat',
    title: `Heartbeat: ${agentName}`,
    description: null,
    active: true,
    message: isLegacy ? config.message : HEARTBEAT_GENERIC_MESSAGE,
    sender: 'heartbeat',
    delivery_mode: isLegacy ? (config.delivery ?? 'internal') : 'internal',
    timezone: null,
    catch_up_policy: 'fire_once',
    dedupe_window_seconds: 90,
    interval_seconds: interval,
    anchor_at: now,
    max_runs: isLegacy ? (config.maxBeats ?? null) : null,
    expires_at: isLegacy && config.expiresAfter ? now + config.expiresAfter : null,
    local_time_seconds: null,
    local_date: null,
    days_of_week: null,
    source_type: 'yaml',
    source_key: `heartbeat:${agentId}`,
    created_at: now,
    updated_at: now,
  };

  return { definition, agentIds: [agentId] };
}

export function calendarToSchedule(
  spec: CalendarSpec,
  sourceKey: string,
  agentIds: string[],
  nowSec?: number,
): { definition: ScheduleDefinitionRow; agentIds: string[] } {
  if (!spec.date && (!spec.days || spec.days.length === 0)) {
    throw new Error(`Calendar schedule "${spec.title}" must specify either date or days`);
  }
  if (spec.date && spec.days && spec.days.length > 0) {
    throw new Error(`Calendar schedule "${spec.title}" cannot specify both date and days`);
  }

  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const definition: ScheduleDefinitionRow = {
    id: stableId('cal', sourceKey),
    kind: 'calendar',
    title: spec.title,
    description: spec.description ?? null,
    active: true,
    message: calendarMessage(spec),
    sender: 'schedule',
    delivery_mode: spec.delivery ?? 'talk',
    timezone: spec.timezone || DEFAULT_TIMEZONE,
    catch_up_policy: spec.catchUpPolicy ?? 'skip',
    dedupe_window_seconds: 90,
    interval_seconds: null,
    anchor_at: null,
    max_runs: null,
    expires_at: null,
    local_time_seconds: parseTimeString(spec.time),
    local_date: spec.date ?? null,
    days_of_week: spec.days ? normalizeDays(spec.days) : null,
    source_type: 'yaml',
    source_key: sourceKey,
    created_at: now,
    updated_at: now,
  };

  return { definition, agentIds };
}
