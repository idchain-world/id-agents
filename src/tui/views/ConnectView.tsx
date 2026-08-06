// SPDX-License-Identifier: MIT

import React from 'react';
import { Box, Text } from 'ink';
import type { TuiConnectView } from '../connect/view.js';

/**
 * Item 6's screen: Connect, an information surface and nothing more.
 *
 * The operator copies the prompt into a coding agent in a second terminal on
 * this same host. No pairing, no credential, no launching: both terminals are
 * already inside one trust domain, which is also why the management URL shown
 * here is always loopback (the view builder refuses anything else).
 */

interface ConnectViewProps {
  view: TuiConnectView;
  windowSize: number;
  /** Set after Enter copies the prompt, so the operator gets feedback. */
  copied: boolean;
}

export function ConnectView(props: ConnectViewProps): React.ReactElement {
  const { view, windowSize, copied } = props;
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Connect</Text>
        <Text dimColor>{copied ? 'prompt copied to clipboard' : 'Enter to copy the prompt'}</Text>
      </Box>
      <Text dimColor>
        Run a coding agent in another terminal on this machine and paste the prompt below into it.
      </Text>
      <Text> </Text>
      <Text>
        <Text dimColor>manager   </Text>{view.managerUrl}
      </Text>
      <Text>
        <Text dimColor>quickstart </Text>{view.quickstartPath}
      </Text>
      <Text>
        <Text dimColor>skill      </Text>{view.adminSkillPath}
      </Text>
      <Text>
        <Text dimColor>configs    </Text>{view.writableConfigRoot}
      </Text>
      <Text> </Text>
      <Box borderStyle="single" paddingX={1} flexDirection="column">
        <Text wrap="wrap">{view.prompt}</Text>
      </Box>
      {Array.from({ length: Math.max(0, windowSize - 10) }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
    </Box>
  );
}
