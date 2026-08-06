// SPDX-License-Identifier: MIT

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { TuiConnectView } from '../connect/view.js';

/**
 * Item 6's screen: Connect, an information surface and nothing more.
 *
 * The operator copies the prompt into a coding agent in a second terminal on
 * this same host. No pairing, no credential, no launching: both terminals are
 * already inside one trust domain, which is also why the management URL shown
 * here is always loopback (the view builder refuses anything else).
 *
 * The content is flattened to a list of lines and rendered as a window, because
 * the prompt is long and on a short terminal an unwindowed view pushes its own
 * header off the top of the screen. That hid the copy affordance entirely, so
 * the screen appeared to offer no way to copy the thing it exists to show.
 */

interface ConnectViewProps {
  view: TuiConnectView;
  windowSize: number;
  /** First visible line. Owned by App so the arrow keys can move it. */
  windowStart: number;
  /** Set after Enter copies the prompt, so the operator gets feedback. */
  copied: boolean;
}

type Line =
  | { kind: 'title'; text: string }
  | { kind: 'dim'; text: string }
  | { kind: 'plain'; text: string }
  | { kind: 'label'; label: string; value: string }
  | { kind: 'chip'; chip: string; tail: string }
  | { kind: 'blank' };

/** Greedy word wrap. Long unbreakable tokens (paths, URLs) get their own line. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line === '') {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ' ' + word;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line !== '') out.push(line);
  }
  return out;
}

/** Everything the screen shows, in order, one entry per rendered row. */
export function buildConnectLines(
  view: TuiConnectView,
  copied: boolean,
  width: number,
): Line[] {
  const lines: Line[] = [{ kind: 'title', text: 'Connect' }];
  for (const t of wrap(
    'Run a coding agent in another terminal on this machine and paste the prompt below into it.',
    width,
  )) {
    lines.push({ kind: 'dim', text: t });
  }
  lines.push({ kind: 'blank' });
  lines.push({ kind: 'label', label: 'manager   ', value: view.managerUrl });
  lines.push({ kind: 'label', label: 'quickstart', value: view.quickstartPath });
  lines.push({ kind: 'label', label: 'skill     ', value: view.adminSkillPath });
  lines.push({ kind: 'label', label: 'configs   ', value: view.writableConfigRoot });
  lines.push({ kind: 'blank' });
  lines.push({
    kind: 'chip',
    chip: copied ? ' COPIED ' : ' Enter ',
    tail: copied ? ' the prompt is on your clipboard' : ' copy the prompt below',
  });
  lines.push({ kind: 'blank' });
  for (const t of wrap(view.prompt, width)) {
    lines.push(t === '' ? { kind: 'blank' } : { kind: 'plain', text: t });
  }
  return lines;
}

function renderLine(line: Line, key: string): React.ReactElement {
  switch (line.kind) {
    case 'title':
      return <Text key={key} bold>{line.text}</Text>;
    case 'dim':
      return <Text key={key} dimColor>{line.text}</Text>;
    case 'label':
      return (
        <Text key={key}>
          <Text dimColor>{line.label} </Text>
          {line.value}
        </Text>
      );
    case 'chip':
      return (
        <Text key={key}>
          <Text inverse bold>{line.chip}</Text>
          <Text dimColor>{line.tail}</Text>
        </Text>
      );
    case 'blank':
      return <Text key={key}> </Text>;
    default:
      return <Text key={key}>{line.text}</Text>;
  }
}

export function ConnectView(props: ConnectViewProps): React.ReactElement {
  const { view, windowSize, windowStart, copied } = props;
  const { stdout } = useStdout();
  const width = Math.max(32, (stdout?.columns ?? 80) - 6);

  const lines = buildConnectLines(view, copied, width);
  const size = Math.max(1, windowSize);
  const start = Math.min(Math.max(0, windowStart), Math.max(0, lines.length - size));
  const visible = lines.slice(start, start + size);
  const hiddenAbove = start;
  const hiddenBelow = Math.max(0, lines.length - (start + size));

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {visible.map((line, i) => renderLine(line, `c-${start + i}`))}
      {Array.from({ length: Math.max(0, size - visible.length) }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
      {hiddenAbove > 0 || hiddenBelow > 0 ? (
        <Text dimColor>
          {hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ''}
          {hiddenAbove > 0 && hiddenBelow > 0 ? '  ·  ' : ''}
          {hiddenBelow > 0 ? `↓ ${hiddenBelow} more below` : ''}
        </Text>
      ) : null}
    </Box>
  );
}
