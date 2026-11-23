import React from 'react';
import { Text } from 'ink';
import type { Agent } from '../api/types.js';
import { padRight, truncate, humanizeLastSeen } from '../util/format.js';
import { statusColor, healthColor, healthDot } from '../util/colors.js';
import { formatMemory, memoryColor } from '../util/memory.js';
import { abbrevModel } from '../util/models.js';
import { abbrevEffort } from '../util/effort.js';
import { abbrevRuntime } from '../util/runtime.js';
import { abbrevStatus, abbrevHealth } from '../util/status.js';

interface AgentRowProps {
  agent: Agent;
  selected: boolean;
  uptime: string;
  newsColor: string;
  memBytes: number | null;
  nowMs: number;
}

// Column widths for local agents
const COLS = {
  marker: 2,
  name: 17,
  port: 6,
  runtime: 12,
  model: 10, // abbreviated via util/models.ts (e.g. 'opus-4-7', 'sonn-4-6', 'comp-2')
  effort: 4,
  status: 4,
  health: 6,
  news: 2,
  hb: 3,
  mem: 8,
  uptime: 6,
} as const;

// Column widths for remote agents — port/mem render '—', uptime shows last_seen,
// two extra columns: DOMAIN and DMZ appended at the end.
const REMOTE_COLS = {
  marker: 2,
  name: 17,
  port: 6,    // renders '—' but keeps same width
  runtime: 12,
  model: 10,
  effort: 4,
  status: 4,
  health: 6,
  news: 2,
  hb: 3,
  mem: 8,     // renders '—' but keeps same width
  uptime: 14, // wider to show "Xm ago"
  domain: 16, // customer_domain truncated to 15 chars + overflow '…'
  dmz: 3,     // DMZ badge (3 chars) or empty
} as const;

const NEWS_GLYPH = '●';

function renderHealth(health: string | undefined): string {
  // Online → green dot only (drop the literal "online" label). Other states
  // keep the dot plus a short label.
  if (health === 'online') return healthDot(health);
  return `${healthDot(health)} ${abbrevHealth(health)}`;
}

function renderEffort(agent: Agent): string {
  return abbrevEffort(typeof agent.metadata?.effort === 'string' ? agent.metadata.effort : undefined);
}

function isRemoteAgent(agent: Agent): boolean {
  return agent.deploymentShape === 'remote-endpoint' ||
    agent.metadata?.runtime === 'public-agent-remote';
}

function AgentRowInner({ agent, selected, uptime, newsColor, memBytes, nowMs }: AgentRowProps): React.ReactElement {
  const marker = selected ? '▶ ' : '  ';
  const name = padRight(agent.alias ?? agent.name, COLS.name);
  const runtime = padRight(abbrevRuntime(agent.metadata?.runtime), COLS.runtime);
  const model = padRight(truncate(abbrevModel(agent.model), COLS.model - 1), COLS.model);
  const effort = padRight(renderEffort(agent), COLS.effort);
  const health = padRight(renderHealth(agent.health), COLS.health);
  const hb = padRight(agent.metadata?.heartbeat ? '♥' : '-', COLS.hb);
  const newsGlyph = NEWS_GLYPH;

  if (isRemoteAgent(agent)) {
    // Remote agent row: PORT=—, MEM=—, UPTIME=last_seen, + DOMAIN + DMZ
    const portCell = padRight('—', REMOTE_COLS.port);
    const memCell = padRight('—', REMOTE_COLS.mem);
    const lastSeenStr = humanizeLastSeen(agent.last_seen, nowMs);
    const uptimeCell = padRight(lastSeenStr, REMOTE_COLS.uptime);
    const domainVal = agent.customer_domain ?? '';
    const domainCell = padRight(truncate(domainVal, REMOTE_COLS.domain - 1), REMOTE_COLS.domain);
    const dmzVal = (agent.metadata as Record<string, unknown> | undefined)?.dmz === true ? 'DMZ' : '';
    const dmzCell = padRight(dmzVal, REMOTE_COLS.dmz);

    // STATUS column: for remote agents derive from health
    const remoteStatusLabel = agent.health === 'unknown' ? 'registered' : agent.health;
    const remoteStatus = padRight(abbrevStatus(remoteStatusLabel), REMOTE_COLS.status);
    const remoteHealth = padRight(renderHealth(agent.health), REMOTE_COLS.health);

    return (
      <Text inverse={selected} wrap="truncate-end">
        {marker}
        <Text bold={selected}>{name}</Text>
        <Text dimColor>{portCell}</Text>
        <Text dimColor>{runtime}</Text>
        <Text dimColor>{model}</Text>
        <Text dimColor>{effort}</Text>
        <Text color={healthColor(agent.health)}>{remoteStatus}</Text>
        <Text color={healthColor(agent.health)}>{remoteHealth}</Text>
        <Text color={newsColor}>{newsGlyph}</Text>
        {' '}
        {hb}
        <Text dimColor>{memCell}</Text>
        <Text dimColor>{uptimeCell}</Text>
        <Text dimColor>{domainCell}</Text>
        {dmzVal ? <Text color="yellow">{dmzCell}</Text> : <Text>{dmzCell}</Text>}
      </Text>
    );
  }

  // Local agent row
  const port = padRight(agent.port ? String(agent.port) : '—', COLS.port);
  const status = padRight(abbrevStatus(agent.status), COLS.status);
  const memCell = padRight(formatMemory(memBytes), COLS.mem);
  const uptimeCell = padRight(uptime, COLS.uptime);

  return (
    <Text inverse={selected} wrap="truncate-end">
      {marker}
      <Text bold={selected}>{name}</Text>
      {port}
      <Text dimColor>{runtime}</Text>
      <Text dimColor>{model}</Text>
      <Text dimColor>{effort}</Text>
      <Text color={statusColor(agent.status)}>{status}</Text>
      <Text color={healthColor(agent.health)}>{health}</Text>
      <Text color={newsColor}>{newsGlyph}</Text>
      {' '}
      {hb}
      <Text color={memoryColor(memBytes)}>{memCell}</Text>
      {uptimeCell}
    </Text>
  );
}

export const AgentRow = React.memo(AgentRowInner, (prev, next) => {
  if (prev.selected !== next.selected) return false;
  if (prev.uptime !== next.uptime) return false;
  if (prev.newsColor !== next.newsColor) return false;
  if (prev.memBytes !== next.memBytes) return false;
  if (prev.nowMs !== next.nowMs) return false;
  const a = prev.agent;
  const b = next.agent;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.port === b.port &&
    a.status === b.status &&
    a.health === b.health &&
    a.model === b.model &&
    a.metadata?.runtime === b.metadata?.runtime &&
    a.metadata?.effort === b.metadata?.effort &&
    a.metadata?.heartbeat === b.metadata?.heartbeat &&
    (a.metadata as Record<string, unknown> | undefined)?.dmz ===
      (b.metadata as Record<string, unknown> | undefined)?.dmz &&
    a.last_seen === b.last_seen &&
    a.customer_domain === b.customer_domain
  );
});

export function AgentRowHeader(props: { hasRemote?: boolean }): React.ReactElement {
  if (props.hasRemote) {
    return (
      <Text bold dimColor wrap="truncate-end">
        {padRight('', REMOTE_COLS.marker)}
        {padRight('NAME', REMOTE_COLS.name)}
        {padRight('PORT', REMOTE_COLS.port)}
        {padRight('RUNTIME', REMOTE_COLS.runtime)}
        {padRight('MODEL', REMOTE_COLS.model)}
        {padRight('EFF', REMOTE_COLS.effort)}
        {padRight('ST', REMOTE_COLS.status)}
        {padRight('HP', REMOTE_COLS.health)}
        {padRight('N', COLS.news)}
        {padRight('HB', COLS.hb)}
        {padRight('MEM', REMOTE_COLS.mem)}
        {padRight('UPTIME', REMOTE_COLS.uptime)}
        {padRight('DOMAIN', REMOTE_COLS.domain)}
        {padRight('DMZ', REMOTE_COLS.dmz)}
      </Text>
    );
  }
  return (
    <Text bold dimColor wrap="truncate-end">
      {padRight('', COLS.marker)}
      {padRight('NAME', COLS.name)}
      {padRight('PORT', COLS.port)}
      {padRight('RUNTIME', COLS.runtime)}
      {padRight('MODEL', COLS.model)}
      {padRight('EFF', COLS.effort)}
      {padRight('ST', COLS.status)}
      {padRight('HP', COLS.health)}
      {padRight('N', COLS.news)}
      {padRight('HB', COLS.hb)}
      {padRight('MEM', COLS.mem)}
      {padRight('UPTIME', COLS.uptime)}
    </Text>
  );
}
