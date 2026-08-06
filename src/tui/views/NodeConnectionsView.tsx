// SPDX-License-Identifier: MIT

import React from 'react';
import { Box, Text } from 'ink';
import { padRight, truncate } from '../util/format.js';
import type { NodeConnectionRow } from './interteam-controllers.js';

/**
 * Item 8: node connections, node-global. Routes with probe status.
 *
 * Deliberately not merged with contacts: a contact says who a team may
 * address, a route says whether this machine can reach a node at all. The
 * status column renders states, including failed probes; there is no error
 * dialog anywhere in this view, because `unreachable` is the answer the
 * operator pressed `p` to learn.
 */

interface NodeConnectionsViewProps {
  rows: NodeConnectionRow[];
  selectedIndex: number;
  windowStart: number;
  windowSize: number;
  loading: boolean;
  /** A list-refresh failure. Old rows stay visible beneath it. */
  error: string | null;
}

const COLS = {
  marker: 2,
  node: 20,
  address: 30,
  status: 28,
} as const;

export function NodeConnectionsView(props: NodeConnectionsViewProps): React.ReactElement {
  const { rows, selectedIndex, windowStart, windowSize, loading, error } = props;
  const total = rows.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = rows.slice(windowStart, windowEnd);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Node connections ({total})</Text>
        <Text dimColor>
          {loading && total === 0 ? 'loading…' : null}
          {error ? `refresh failed: ${error}` : null}
        </Text>
      </Box>
      <Text dimColor>
        {padRight('', COLS.marker)}
        {padRight('NODE', COLS.node)}
        {padRight('ADDRESS', COLS.address)}
        {padRight('STATUS', COLS.status)}
      </Text>
      {visible.length === 0 && !loading ? (
        <Text dimColor>no peer routes configured on this node</Text>
      ) : (
        visible.map((row, i) => (
          <Row key={row.route.nodeId} row={row} selected={windowStart + i === selectedIndex} />
        ))
      )}
      {Array.from(
        { length: Math.max(0, windowSize - Math.max(visible.length, visible.length === 0 && !loading ? 1 : 0)) },
        (_, i) => (<Text key={`pad-${i}`}> </Text>),
      )}
      <Text dimColor>press p to probe the selected route</Text>
    </Box>
  );
}

function Row({ row, selected }: { row: NodeConnectionRow; selected: boolean }): React.ReactElement {
  const reachable = row.probe?.outcome === 'reachable';
  const probedBad = row.probe !== null && !reachable;
  return (
    <Text inverse={selected}>
      {padRight(selected ? '>' : '', COLS.marker)}
      {padRight(truncate(row.route.nodeId, COLS.node - 1), COLS.node)}
      {padRight(truncate(row.route.baseUrl, COLS.address - 1), COLS.address)}
      <Text
        inverse={selected}
        color={reachable ? 'green' : probedBad ? 'yellow' : undefined}
        dimColor={row.probe === null && !row.probing}
      >
        {padRight(truncate(row.status, COLS.status - 1), COLS.status)}
      </Text>
    </Text>
  );
}
