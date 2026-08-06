import React from 'react';
import { Box, Text } from 'ink';
import { knownCommandNames, lookupCommand } from '../commands/registry.js';

interface HelpViewProps {
  windowSize: number;
  scrollOffset: number;
}

// Outer border (2) + header (1) + spacer (1) = 4 rows that don't belong to the
// scrollable list. App.tsx subtracts this from terminal rows so the list gets
// the rest.
export const HELP_VIEW_CHROME_ROWS = 4;

// ── Keybinding groups (in-app keybindings App.tsx's useInput wires) ──
const VIEW_BINDINGS: Array<[string, string]> = [
  ['a', 'Agents'],
  ['t', 'Tasks'],
  ['n', 'News'],
  ['c', 'Calendar'],
  ['h', 'Heartbeats'],
  ['l', 'Library / agents'],
  ['s', 'Library / skills'],
  ['m', 'Library / teams'],
  ['o', 'Contacts (inter-team)'],
  ['x', 'Node connections'],
  ['e', 'Connect prompt'],
];

const NAVIGATE_BINDINGS: Array<[string, string]> = [
  ['↑ ↓', 'Move row'],
  ['j k', 'Move row / scroll'],
  ['PgUp/Dn', 'Move page'],
  ['→', 'Open detail'],
  ['← Esc', 'Back'],
  ['Tab', 'Cycle team'],
  ['i', 'Install (library team detail)'],
  ['F', 'Toggle force (install prompt)'],
  ['f', 'Fire heartbeat (heartbeats view)'],
  ['p', 'Probe route (node connections)'],
  ['Enter', 'Copy prompt (connect view)'],
];

const GLOBAL_BINDINGS: Array<[string, string]> = [
  ['?', 'Toggle help'],
  ['q', 'Quit'],
  ['^C', 'Force quit'],
];

type Row =
  | { kind: 'section'; title: string; color: string; count?: number }
  | { kind: 'kbd'; key: string; description: string }
  | { kind: 'cmd'; name: string; description: string }
  | { kind: 'spacer' };

function buildRows(): Row[] {
  const rows: Row[] = [];
  rows.push({ kind: 'section', title: 'Views', color: 'cyan' });
  for (const [key, desc] of VIEW_BINDINGS) rows.push({ kind: 'kbd', key, description: desc });
  rows.push({ kind: 'spacer' });

  // Flat alphabetical command list. Safety (Y/N or retype confirmation) is
  // enforced at dispatch by each spec's shouldConfirm/shouldRetype, so the
  // help view doesn't need to surface tiers visually.
  const names = knownCommandNames();
  rows.push({ kind: 'section', title: 'Commands', color: 'cyan', count: names.length });
  for (const name of names) {
    const spec = lookupCommand(name);
    if (!spec) continue;
    rows.push({ kind: 'cmd', name: spec.name, description: spec.description });
  }
  rows.push({ kind: 'spacer' });

  rows.push({ kind: 'section', title: 'Navigate', color: 'cyan' });
  for (const [key, desc] of NAVIGATE_BINDINGS) rows.push({ kind: 'kbd', key, description: desc });
  rows.push({ kind: 'spacer' });

  rows.push({ kind: 'section', title: 'Global', color: 'cyan' });
  for (const [key, desc] of GLOBAL_BINDINGS) rows.push({ kind: 'kbd', key, description: desc });

  return rows;
}

const NAME_COL_WIDTH = 16;

function renderRow(row: Row, key: string): React.ReactElement {
  if (row.kind === 'spacer') return <Text key={key}> </Text>;
  if (row.kind === 'section') {
    return (
      <Text key={key} bold color={row.color}>
        {row.title}
        {row.count !== undefined ? <Text dimColor>{`  (${row.count})`}</Text> : null}
      </Text>
    );
  }
  if (row.kind === 'kbd') {
    return (
      <Box key={key}>
        <Box width={NAME_COL_WIDTH}>
          <Text color="yellow">{`  ${row.key}`}</Text>
        </Box>
        <Text wrap="truncate-end">{row.description}</Text>
      </Box>
    );
  }
  return (
    <Box key={key}>
      <Box width={NAME_COL_WIDTH}>
        <Text color="cyan">{`  /${row.name}`}</Text>
      </Box>
      <Text wrap="truncate-end">{row.description}</Text>
    </Box>
  );
}

export function HelpViewImpl(props: HelpViewProps): React.ReactElement {
  const rows = buildRows();
  const total = rows.length;
  const maxStart = Math.max(0, total - props.windowSize);
  const start = Math.min(Math.max(0, props.scrollOffset), maxStart);
  const visible = rows.slice(start, start + props.windowSize);
  const padCount = Math.max(0, props.windowSize - visible.length);
  const endLineNo = start + visible.length;

  const cmdCount = rows.filter((r) => r.kind === 'cmd').length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Help · {cmdCount} commands
        </Text>
        <Text dimColor>
          {total} lines · {total === 0 ? 0 : start + 1}–{endLineNo} · ↑↓/jk scroll · Esc / ? close
        </Text>
      </Box>
      <Text dimColor> </Text>
      {visible.map((row, i) => renderRow(row, `help-row-${start + i}`))}
      {Array.from({ length: padCount }, (_, i) => (
        <Text key={`help-pad-${i}`}> </Text>
      ))}
    </Box>
  );
}

export const HelpView = React.memo(HelpViewImpl);
