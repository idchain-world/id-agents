# Agent Harnesses Reference

Harnesses are pluggable LLM execution backends that allow ID Agents to use different AI coding tools. Each harness wraps a specific CLI or SDK and produces a unified message format for REST-AP compatibility.

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                  Agent REST Server                           │
│               (src/agent-rest-server.ts)                    │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │    Harness Factory    │
              │   createHarness(type) │
              └───────────┬───────────┘
                          │
              ┌───────────┴───────────┐
              │                       │
              ▼                       ▼
      ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
      │ Claude Agent  │   │  Claude Code  │   │     Codex     │
      │  SDK Harness  │   │  CLI Harness  │   │    Harness    │
      └───────────────┘   └───────────────┘   └───────────────┘
```

All harnesses produce `HarnessMessage` objects that map to REST-AP responses.

## Available Harnesses

| Harness | CLI/SDK | Provider | Use Case |
|---------|---------|----------|----------|
| `claude-agent-sdk` | Claude Agent SDK | Anthropic | Primary runtime, full tool access (uses ANTHROPIC_API_KEY) |
| `claude-code-cli` | Claude Code CLI | Anthropic | Uses Max plan subscription |
| `claude-code-local` | Claude Code CLI | Anthropic | Local alias of `claude-code-cli` used by some bootstrap paths |
| `codex` | Codex CLI | OpenAI | CLI-auth runtime for Codex-based agent execution |
| `cursor-cli` | Cursor Agent CLI (`cursor-agent`) | Cursor | CLI-auth runtime; stream-json harness, session resume supported |

## Claude Agent SDK Harness

The primary harness using Anthropic's official Claude Agent SDK.

### Features

- Full tool access (file operations, bash, etc.)
- Session persistence and resumption
- Plugin support for extensibility
- Permission management

### Models

```typescript
const CLAUDE_MODELS = {
  HAIKU: 'claude-haiku-4-5-20251001',   // Fast, efficient
  SONNET: 'claude-sonnet-4-20250514',   // Balanced
  OPUS: 'claude-opus-4-20250514'        // Most capable
};
```

### Configuration

```yaml
agents:
  - name: my-agent
    runtime: claude-agent-sdk
    model: claude-sonnet-4-20250514
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `CLAUDE_MODEL` | No | Default model override |

### Plugin Support

The Claude Agent SDK harness supports plugins:

```yaml
agents:
  - name: my-agent
    runtime: claude-agent-sdk
    skills: [identity, inter-agent, catalog]
```

Skills are deployed to the agent's `.claude/skills/` directory at deploy time.

---

## Claude Code CLI Harness

Uses the Claude Code CLI as a harness. This runtime uses your Max plan subscription instead of an API key.

### Features

- Uses Max plan subscription (no ANTHROPIC_API_KEY needed)
- Session persistence
- Full tool access

### Configuration

```yaml
agents:
  - name: my-agent
    runtime: claude-code-cli
```

---

## Codex CLI Harness

Uses the OpenAI Codex CLI as a harness. This runtime uses your local Codex login or `OPENAI_API_KEY`.

### Features

- Uses Codex CLI authentication
- Full tool access
- Fresh query execution per request

### Configuration

```yaml
agents:
  - name: my-agent
    runtime: codex
    model: gpt-5.4
```

### Environment / Auth

`codex` requires either:

- a successful `codex login`
- or `OPENAI_API_KEY`

### Session Behavior

Codex currently runs each request as a fresh `codex exec` invocation. It does not reuse the REST server's session resume path.

---

## Cursor CLI Harness

Uses the **Cursor Agent CLI** (`cursor-agent`) as a harness. Install from [cursor.com](https://cursor.com):

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent login   # or: export CURSOR_API_KEY=...
```

### Features

- Cursor CLI authentication (`cursor-agent login` or `CURSOR_API_KEY`)
- Stream-json structured output
- Session resume supported (`--resume` when configured)

### Configuration

```yaml
agents:
  - name: my-agent
    runtime: cursor-cli
    model: composer-2   # also common: composer-2-fast, auto
```

Typical model identifiers include `composer-2`, `composer-2-fast`, and `auto` (pass through to Cursor Agent as configured).

### Environment / Auth

`cursor-cli` requires either:

- a successful `cursor-agent login` session on the host, or
- `CURSOR_API_KEY`

---

## Harness Interface

All harnesses implement the `AgentHarness` interface:

```typescript
interface AgentHarness {
  readonly type: HarnessType;

  run(
    prompt: string,
    options: HarnessOptions
  ): AsyncGenerator<HarnessMessage>;
}

type HarnessType = 'claude-agent-sdk' | 'claude-code-cli' | 'claude-code-local' | 'codex' | 'cursor-cli';

interface HarnessOptions {
  model?: string;
  workingDirectory?: string;
  plugins?: PluginConfig[];
  allowedTools?: string[];
  resume?: string;
  env?: Record<string, string | undefined>;
}
```

## Message Format

All harnesses produce unified `HarnessMessage` objects:

```typescript
interface HarnessMessage {
  type: 'system' | 'tool_use' | 'result' | 'error' | 'progress' | 'thinking';
  subtype?: string;
  content?: string;
  result?: string;
  session_id?: string;
  tool_name?: string;
  parent_tool_use_id?: string;
}
```

### Message Types

| Type | Description |
|------|-------------|
| `system` | System messages (init, status) |
| `tool_use` | Tool invocation notification |
| `result` | Final result from the agent |
| `error` | Error message |
| `progress` | Progress update |
| `thinking` | Agent reasoning (if available) |

---

## Usage

### Specifying Runtime

**Via CLI:**
```bash
/deploy local-agent my-agent
```

**Via YAML Config:**
```yaml
defaults:
  runtime: claude-agent-sdk

agents:
  - name: agent-a
    runtime: claude-agent-sdk
  - name: agent-b
    runtime: claude-code-cli
  - name: agent-c
    runtime: codex
  - name: agent-d
    runtime: cursor-cli
    model: composer-2
```

**Dry run before deploy:**
```bash
/deploy default --dry-run
/diff <team> default       # report drift against a running team (read-only)
```

**Via Remote API:**
```bash
curl -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command": "/deploy local-agent my-agent"}'
```

### Checking Available Harnesses

```typescript
import { getAvailableHarnesses, isValidHarnessType } from './harness';

const harnesses = getAvailableHarnesses();
// ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex', 'cursor-cli']

isValidHarnessType('claude-agent-sdk'); // true
isValidHarnessType('invalid');          // false
```

---

## Creating Custom Harnesses

To add a new harness:

1. **Create harness file** in `src/harness/`:

```typescript
// src/harness/my-harness.ts
import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType } from './types.js';

export class MyHarness implements AgentHarness {
  readonly type: HarnessType = 'my-harness' as HarnessType;

  async *run(prompt: string, options: HarnessOptions): AsyncGenerator<HarnessMessage> {
    yield { type: 'system', subtype: 'init', content: 'Starting my harness' };

    // Your implementation here...

    yield { type: 'result', result: 'Agent response' };
  }
}
```

2. **Update types** in `src/harness/types.ts`:

```typescript
export type HarnessType = 'claude-agent-sdk' | 'claude-code-cli' | 'my-harness';
```

3. **Register in factory** in `src/harness/index.ts`:

```typescript
import { MyHarness } from './my-harness.js';

export function createHarness(type: HarnessType): AgentHarness {
  switch (type) {
    // ...
    case 'my-harness':
      return new MyHarness();
    // ...
  }
}
```

---

## Best Practices

1. **Choose the right harness:**
   - `claude-agent-sdk` - When you need full Anthropic integration and plugin support (uses API key)
   - `claude-code-cli` - When you want Claude Code CLI auth and session continuity
   - `codex` - When you want OpenAI Codex CLI auth and fresh-per-query execution
   - `cursor-cli` - When you want Cursor Agent CLI auth (`cursor-agent login` or `CURSOR_API_KEY`) and stream-json execution
   - `claude-code-cli` - When you want to use your Max plan subscription

2. **Model selection:**
   - Use Haiku for fast, simple tasks
   - Use Sonnet for balanced workloads
   - Use Opus for complex reasoning

3. **Session management:**
   - Pass `resume` option to continue conversations
   - Sessions persist context and reduce token usage

4. **Error handling:**
   - Harnesses yield error messages, don't throw
   - Check message type for `error` to handle failures
