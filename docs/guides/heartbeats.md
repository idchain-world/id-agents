# Heartbeats

Heartbeats are recurring wake-ups for single-agent work. The agent reads its own `HEARTBEAT.md` checklist and decides what to do. If nothing needs attention, it responds with `HEARTBEAT_OK` and the response is silently suppressed from the news feed.

## Configuration

Set `heartbeat` to a number of seconds in the YAML config:

```yaml
agents:
  - name: monitor
    heartbeat: 300  # wake up every 5 minutes
```

The `heartbeat` field can also be set in `defaults` to apply to all agents:

```yaml
defaults:
  heartbeat: 86400  # daily for all agents

agents:
  - name: monitor
    heartbeat: 300  # override: every 5 minutes
  - name: auditor
    # inherits 86400 from defaults
```

## HEARTBEAT.md Checklist

Create a `HEARTBEAT.md` file in the agent's template directory. For Claude agents, this is `.claude/agents/{name}/HEARTBEAT.md`. For Codex agents, `.agents/{name}/HEARTBEAT.md`. For Cursor (`cursor-cli`) agents, `.cursor/agents/{name}/HEARTBEAT.md`.

The file is copied to the agent's working directory root at spawn time. When the heartbeat fires, the scheduler sends a generic wake-up message and the agent reads `HEARTBEAT.md` from its working directory.

**Example checklist:**

```markdown
# Security Review Checklist

- [ ] Check for new dependency vulnerabilities
- [ ] Review open PRs for security issues
- [ ] Scan for hardcoded secrets or credentials
- [ ] Verify test coverage on auth paths

If nothing needs attention, respond with exactly: HEARTBEAT_OK
```

## HEARTBEAT_OK Suppression

When an agent responds with exactly `HEARTBEAT_OK`, the response is:

- Suppressed from `query.completed` and `response.saved` news items
- Logged at debug level with a green heart icon
- Not visible in `/news` output

This keeps the news feed clean when agents have nothing to report.

## Legacy Format

The older object format still works for backward compatibility:

```yaml
agents:
  - name: coder
    heartbeat:
      interval: 300
      message: Review open PRs and summarize risks
      delivery: internal
```

With the legacy format, the scheduler sends the configured `message` directly instead of the generic wake-up. The `maxBeats` and `expiresAfter` fields are supported in both formats.

## How It Works

1. At deploy/spawn time, `HEARTBEAT.md` is copied from the agent template directory to the working directory root
2. The `heartbeat` value compiles into an internal `interval` schedule targeting the agent
3. When the schedule fires, the manager sends a generic message: "Read your HEARTBEAT.md checklist..."
4. The agent reads `HEARTBEAT.md`, performs any needed checks, and responds
5. If the response is exactly `HEARTBEAT_OK`, it is silently suppressed

## Related

- [Configuration Reference](../reference/configuration.md) - Full heartbeat config options
- [Task Tracking](./tasks.md) - Coordinate work between agents
- [News Feed](./news-feed.md) - Where heartbeat results appear (unless suppressed)
