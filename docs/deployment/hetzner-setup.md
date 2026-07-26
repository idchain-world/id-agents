# Hetzner VPS Deployment Guide

This guide documents deploying id-agents to a Hetzner VPS for running Claude Code agents in the cloud.

## Prerequisites

1. SSH key for server access (Ed25519 recommended: `~/.ssh/id_ed25519.pub`)
2. Either:
   - **Anthropic API key with credits** (pay-as-you-go), OR
   - **Claude Max subscription** (unlimited usage with OAuth)

## Quick Start (New Server)

```bash
# 1. SSH to your server
ssh root@YOUR_SERVER_IP

# 2. Install dependencies
apt-get update && apt-get install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 3. Clone or copy the project
# Option A: Clone from GitHub
git clone https://github.com/YOUR_ORG/id-agents.git /root/id-agents

# Option B: Copy from local machine (run from your Mac)
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude 'dist' --exclude 'workspace' \
  /path/to/id-agents/ root@YOUR_SERVER_IP:/root/id-agents/

# 4. Configure environment
cd /root/id-agents
cp .env.example .env  # If .env.example exists, otherwise create .env
nano .env

# 5. Create workspace
mkdir -p /root/id-agents/workspace/teams
chmod -R 777 /root/id-agents/workspace

# 6. Build and start
cd /root/id-agents
npm install
npm run build

# 7. Start the manager
npm run id-agents
```

## Environment Configuration

### Minimal .env (with API Key)

```bash
# Required for API-based agents
ANTHROPIC_API_KEY=sk-ant-your-key-here
ID_HOST_WORKSPACE_DIR=/root/id-agents/workspace
```

### Full .env (with Max Plan Support)

```bash
# API Keys (optional if using Max plan)
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Workspace paths (required)
ID_HOST_WORKSPACE_DIR=/root/id-agents/workspace

# Max plan credentials (optional - enables OAuth authentication)
ID_HOST_CLAUDE_DIR=/root/.claude

# Optional: other provider keys
OPENROUTER_API_KEY=sk-or-v1-xxx
OPENAI_API_KEY=sk-xxx

```

## Using Claude Max Plan (Recommended)

The Max plan provides unlimited Claude usage without per-token billing. To use it with agents:

### Step 1: Authenticate Claude on the Server

```bash
ssh root@YOUR_SERVER_IP

# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Authenticate with Max plan
claude login

# Follow the prompts - it will open a browser URL
# Complete OAuth authentication

# Verify credentials exist
cat /root/.claude/.credentials.json
# Should show: "subscriptionType": "max"
```

### Step 2: Configure Environment

Add to your `.env`:
```bash
ID_HOST_CLAUDE_DIR=/root/.claude
```

### Step 3: Restart Services

```bash
cd /root/id-agents
# Restart the manager (or use systemctl restart id-agents)
```

### Step 4: Spawn Agents with Max Plan

Use the `claude-code-cli` runtime to use Max plan credentials:

```bash
curl -X POST http://localhost:4100/agents/spawn \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "model": "sonnet", "runtime": "claude-code-cli"}'
```

The agent will automatically use OAuth credentials instead of API key.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Hetzner VPS                              │
│  ┌─────────────────┐                    ┌────────────────┐  │
│  │   PostgreSQL    │                    │    Manager     │  │
│  │   (port 5432)   │                    │  (port 4100)   │  │
│  └─────────────────┘                    └────────────────┘  │
│                                                │             │
│                                                ▼             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              Agent Processes (port 4101+)               ││
│  │   ┌─────────┐  ┌─────────┐  ┌─────────┐                 ││
│  │   │ dev.1   │  │ coder.2 │  │  ...    │                 ││
│  │   └─────────┘  └─────────┘  └─────────┘                 ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| PostgreSQL | 5432 | Agent state, queries, news |
| Manager | 4100 | REST-AP orchestration, /agents API |
| Agents | 4101+ | Individual Claude Code agent processes |

## Runtime Options

| Runtime | Auth Method | Use Case |
|---------|-------------|----------|
| `claude-code` | API Key (ANTHROPIC_API_KEY) | Default, requires API credits |
| `claude-code-cli` | OAuth (Max plan) or API Key | Recommended for Max subscribers |
| `cursor-cli` | `cursor-agent login` or `CURSOR_API_KEY` | Cursor Agent CLI on the VPS — install and auth per [Harnesses](../reference/harnesses.md#cursor-cli-harness); typical models `composer-2`, `composer-2-fast`, `auto` |

## API Endpoints

### List Agents
```bash
curl http://YOUR_SERVER_IP:4100/agents
```

### Spawn Agent (with API Key)
```bash
curl -X POST http://YOUR_SERVER_IP:4100/agents/spawn \
  -H "Content-Type: application/json" \
  -d '{"name": "dev", "model": "haiku"}'
```

### Spawn Agent (with Max Plan)
```bash
curl -X POST http://YOUR_SERVER_IP:4100/agents/spawn \
  -H "Content-Type: application/json" \
  -d '{"name": "dev", "model": "sonnet", "runtime": "claude-code-cli"}'
```

### Talk to Agent
```bash
curl -X POST http://YOUR_SERVER_IP:4100/agents/{agent-id}/talk \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!"}'
```

### Poll for Response
```bash
curl http://YOUR_SERVER_IP:4100/agents/{agent-id}/news
```

## Alternative: Local Agents with Remote Manager

Run agents on your Mac (using local Max plan) while connecting to the remote manager:

```bash
# On your Mac
cd /path/to/id-agents
MANAGER_URL=http://YOUR_SERVER_IP:4100 npx tsx src/local-agent-server.ts dev --team default
```

Or use the interactive CLI:
```bash
MANAGER_URL=http://YOUR_SERVER_IP:4100 npm run id-agents
# Then: /deploy local-agent dev
# To change a live team later: /agents spawn|remove, /model  (/sync is REMOVED)
```

## Troubleshooting

### Check Logs
```bash
# Manager logs
sudo journalctl -u id-agents --tail 50

# Specific agent logs (check workspace)
tail -50 /root/id-agents/workspace/teams/default/agents/AGENT_NAME/logs/agent.log
```

### "Credit balance is too low"
You're using `claude-code` runtime with an API key that has no credits. Either:
1. Add credits at https://console.anthropic.com
2. Use Max plan with `claude-code-cli` runtime (see above)

### "ANTHROPIC_API_KEY not set"
Either:
1. Add `ANTHROPIC_API_KEY` to your `.env`
2. Set up Max plan credentials (see above)

### Restart Services
```bash
cd /root/id-agents
sudo systemctl restart id-agents
```

### Full Rebuild After Code Changes
```bash
# From your local machine
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude 'dist' --exclude 'workspace' \
  . root@YOUR_SERVER_IP:/root/id-agents/

# On server
ssh root@YOUR_SERVER_IP "cd /root/id-agents && npm install && npm run build && sudo systemctl restart id-agents"
```

## Firewall Configuration

If using ufw or similar:
```bash
ufw allow 22        # SSH
ufw allow 4100      # Manager API
ufw allow 4101:4200/tcp  # Agent ports (optional, for direct access)
```

## Security Considerations

1. **Environment files**: Never commit `.env` files with real keys
2. **Firewall**: Consider restricting port 4100 to known IPs
3. **Max Plan Credentials**: The `/root/.claude` directory contains OAuth tokens - protect server access

## Updating the Deployment

```bash
# 1. Make changes locally and test

# 2. Copy to server
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude 'dist' --exclude 'workspace' \
  . root@YOUR_SERVER_IP:/root/id-agents/

# 3. Rebuild and restart
ssh root@YOUR_SERVER_IP "cd /root/id-agents && npm install && npm run build && sudo systemctl restart id-agents"
```
