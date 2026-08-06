// SPDX-License-Identifier: MIT

import React from 'react';
import { Box, Text } from 'ink';
import { padRight, truncate } from '../util/format.js';
import type { ContactViewRow } from './interteam-controllers.js';

/**
 * Item 7: contacts, per team. Alias, pinned remote node and team, and whether
 * that node has an enabled route, which is the join this view exists for: a
 * contact pinned to a node with no route looks configured and cannot be
 * reached, and nothing else says so.
 */

interface ContactsViewProps {
  rows: ContactViewRow[];
  team: string;
  selectedIndex: number;
  windowStart: number;
  windowSize: number;
  loading: boolean;
  /** A list-refresh failure. Old rows stay visible beneath it. */
  error: string | null;
}

const COLS = {
  marker: 2,
  alias: 16,
  node: 20,
  team: 20,
  route: 16,
} as const;

export function ContactsView(props: ContactsViewProps): React.ReactElement {
  const { rows, team, selectedIndex, windowStart, windowSize, loading, error } = props;
  const total = rows.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = rows.slice(windowStart, windowEnd);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Contacts — {team} ({total})</Text>
        <Text dimColor>
          {loading && total === 0 ? 'loading…' : null}
          {error ? `refresh failed: ${error}` : null}
        </Text>
      </Box>
      <Text dimColor>
        {padRight('', COLS.marker)}
        {padRight('ALIAS', COLS.alias)}
        {padRight('REMOTE NODE', COLS.node)}
        {padRight('REMOTE TEAM', COLS.team)}
        {padRight('ROUTE', COLS.route)}
      </Text>
      {visible.length === 0 && !loading ? (
        <Text dimColor>no contacts for this team</Text>
      ) : (
        visible.map((row, i) => (
          <Row key={row.contact.id} row={row} selected={windowStart + i === selectedIndex} />
        ))
      )}
    </Box>
  );
}

function Row({ row, selected }: { row: ContactViewRow; selected: boolean }): React.ReactElement {
  const ok = row.reachability === 'route ok';
  return (
    <Text inverse={selected}>
      {padRight(selected ? '>' : '', COLS.marker)}
      {padRight(truncate(row.contact.aliasDisplay, COLS.alias - 1), COLS.alias)}
      {padRight(truncate(row.contact.remoteNodeId, COLS.node - 1), COLS.node)}
      {padRight(truncate(row.contact.remoteTeamId, COLS.team - 1), COLS.team)}
      <Text inverse={selected} color={ok ? 'green' : 'yellow'}>
        {padRight(row.reachability, COLS.route)}
      </Text>
    </Text>
  );
}
