import React from 'react';
import { Box, Text } from 'ink';

export type FooterView =
  | 'agents'
  | 'agent-detail'
  | 'news'
  | 'news-detail'
  | 'tasks'
  | 'task-detail'
  | 'calendar'
  | 'heartbeats'
  | 'heartbeat-detail'
  | 'library-agents'
  | 'library-agent-detail'
  | 'library-skills'
  | 'library-skill-detail'
  | 'library-teams'
  | 'library-team-detail'
  | 'configs-list'
  | 'config-detail'
  | 'output-list'
  | 'output-detail'
  | 'contacts'
  | 'node-connections'
  | 'connect';

interface FooterProps {
  view: FooterView;
}

// Footer is a one-liner. Press `?` to open the full help modal which
// lists every keybinding. Drill-downs keep a `← back` hint since that
// is the most-used affordance from those views; everything else is in
// the modal.
const HAS_BACK: Record<FooterView, boolean> = {
  agents: false,
  'agent-detail': true,
  tasks: true,
  calendar: false,
  heartbeats: false,
  'task-detail': true,
  'heartbeat-detail': true,
  news: true,
  'news-detail': true,
  'library-agents': true,
  'library-agent-detail': true,
  'library-skills': true,
  'library-skill-detail': true,
  'library-teams': true,
  'library-team-detail': true,
  'configs-list': true,
  'config-detail': true,
  'output-list': true,
  'output-detail': true,
  contacts: true,
  'node-connections': true,
  connect: true,
};

function hintFor(view: FooterView): string {
  const back = HAS_BACK[view] ? ' · ← back' : '';
  // Contacts as a visible menu option was an explicit ask, so the three
  // inter-team keys are named here rather than living only in the help modal.
  return `↑↓ nav${back} · / cmd · o contacts · x nodes · e connect · ? help · q quit`;
}

export function Footer({ view }: FooterProps): React.ReactElement {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>{hintFor(view)}</Text>
      <Text dimColor>ID Agents Dashboard</Text>
    </Box>
  );
}
