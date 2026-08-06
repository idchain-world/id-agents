import React from 'react';
import { Box, Text, useStdout } from 'ink';

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

/**
 * Hints, shortened as the terminal narrows. The Connect chip is not in this
 * string: it renders separately as an inverse chip ahead of the hints, because
 * attaching a coding agent is the first thing an operator does on a machine
 * they have just reached, and it must never be the part that gets dropped.
 *
 * The footer wrapped at 80 columns once the three inter-team hints were added,
 * which pushed `q quit` onto a second line and collided with the right-hand
 * label. Rather than guess a terminal width, hints are shed in reverse order of
 * usefulness so the line always fits.
 */
function hintFor(view: FooterView, cols: number): string {
  const back = HAS_BACK[view] ? ' · ← back' : '';
  // On Connect, the copy key is the whole point of the screen, so it sits ahead
  // of the navigation hints and is the last thing shed as the terminal narrows.
  const parts = view === 'connect'
    ? ['Enter copy', `↑↓ nav${back}`, '/ cmd', 'o contacts', 'x nodes', '? help', 'q quit']
    : [`↑↓ nav${back}`, '/ cmd', 'o contacts', 'x nodes', '? help', 'q quit'];
  // Budget: the chip, a gap, the right-hand label, and the box padding.
  let budget = cols - CHIP.length - 1 - RIGHT_LABEL.length - 3;
  const kept: string[] = [];
  for (const part of parts) {
    const cost = kept.length === 0 ? part.length : part.length + 3;
    if (cost > budget) break;
    budget -= cost;
    kept.push(part);
  }
  return kept.join(' · ');
}

const CHIP = ' e CONNECT ';
const RIGHT_LABEL = 'ID Agents Dashboard';

/** The Connect affordance, drawn as an inverse chip so it reads as a button. */
export function ConnectChip(): React.ReactElement {
  return (
    <Text inverse bold>
      {CHIP}
    </Text>
  );
}

export function Footer({ view }: FooterProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <ConnectChip />
        <Text dimColor>{' ' + hintFor(view, cols)}</Text>
      </Box>
      {cols >= CHIP.length + RIGHT_LABEL.length + 8 ? (
        <Text dimColor>{RIGHT_LABEL}</Text>
      ) : null}
    </Box>
  );
}
