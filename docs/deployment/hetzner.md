# Hetzner Cloud Deployment Guide

This guide covers deploying ID Agents to Hetzner Cloud (single VM deployment).

## Architecture Overview

### Local Development
```
Local Machine
├── Manager Service (localhost:4100) - Orchestrates agents
├── PostgreSQL (localhost:5432) - Local database
└── Agent Processes - Spawned as local processes
```

### Production Deployment
```
Hetzner VPS (CX11 - €3.29/month)
├── Ubuntu + Node.js
├── Manager Service (port 4100)
│   └── Spawns/stops agent processes
└── Agent Processes (ports 4101+, dynamic sequential)

Railway/PlanetScale
└── PostgreSQL Database (external)
```

## Prerequisites

- Hetzner Cloud account
- Railway or PlanetScale account (for PostgreSQL)
- Railway or Render account (for manager service)
- SSH key pair

## Step 1: Create Hetzner VPS

### 1.1 Create VPS
1. Go to [Hetzner Cloud Console](https://console.hetzner.cloud)
2. Create new project or use existing
3. **Create Server**:
   - **Location**: Choose closest to your users
   - **Image**: Ubuntu 22.04
   - **Type**: CX11 (2 vCPUs, 4 GB RAM, €3.29/month)
   - **Volume**: Add 40GB volume (€0.50/month) for agent workspaces
   - **SSH Keys**: Add your public SSH key
   - **Name**: `id-agents`

### 1.2 Initial Server Setup
```bash
# SSH into your new server
ssh root@your-server-ip

# Run the setup script
curl -fsSL https://raw.githubusercontent.com/your-username/id-agents/main/scripts/setup-hetzner.sh | bash

# Reboot to apply changes
sudo reboot
```

### 1.3 Deploy ID Agents
```bash
# SSH back in after reboot
ssh root@your-server-ip

# Clone the repository
git clone https://github.com/your-username/id-agents.git /opt/id-agents
cd /opt/id-agents
npm install && npm run build

# Configure environment
nano /opt/id-agents/.env
```

## Step 2: Setup External Database

### Option A: Railway (Recommended)
1. Go to [Railway.app](https://railway.app)
2. Create new project
3. Add **PostgreSQL** database
4. Copy the connection string from **Variables** tab
5. Add to your `.env`:
```bash
DATABASE_URL=postgresql://postgres:password@containers-us-west-xxx.railway.app:xxxx/railway
```

### Option B: PlanetScale
1. Go to [PlanetScale.com](https://planetscale.com)
2. Create new database
3. Get connection string
4. Add to `.env`:
```bash
DATABASE_URL=postgresql://user:password@host:port/database?sslmode=require
```

## Step 3: Deploy Manager Service

Run the manager on the same VPS:
```bash
cd /opt/id-agents
ANTHROPIC_API_KEY=your-key-here \
DATABASE_URL=postgresql://... \
NODE_ENV=production \
npm run id-agents
```

Or set up as a systemd service for persistence.

## Step 4: Test Deployment

### 1. Test Manager Service
```bash
# SSH into Hetzner VPS
ssh root@your-hetzner-ip

# Test manager health
curl http://localhost:4100/health

# Should return manager status
```

### 2. Test Agent Deployment
```bash
# Deploy first agent via CLI
npm run id-agents
# First time: /deploy local-agent test-agent
# To change a live team later: /model, /delete, or `id-agents spawn <name>`  (/sync is REMOVED)
```

## Configuration

### Environment Variables

#### Manager (.env on Hetzner)
```bash
# Required
ANTHROPIC_API_KEY=your-anthropic-key
DATABASE_URL=postgresql://... (Railway/PlanetScale)

# Optional
CLAUDE_MODEL=claude-haiku-4-5-20251001
NODE_ENV=production
```

### Security

#### Firewall (Hetzner)
```bash
# Only allow necessary ports
sudo ufw allow ssh
sudo ufw allow 4100  # Manager service
sudo ufw --force enable
```

## Monitoring & Maintenance

### Logs
```bash
# Manager logs (Hetzner)
sudo journalctl -u id-agents -f
```

### Updates
```bash
# Update ID Agents (Hetzner)
cd /opt/id-agents
git pull origin main
npm install
npm run build
sudo systemctl restart id-agents
```

### Backups
- **Database**: Railway/PlanetScale handle automatic backups
- **Code**: Git repository
- **Configuration**: Keep .env files backed up securely

## Cost Breakdown

| Service | Cost | Purpose |
|---------|------|---------|
| Hetzner CX11 | €3.29/mo | Agent orchestration |
| Railway DB | $0-5/mo | PostgreSQL database |
| **Total** | **€3.29-€8.29/mo** | **Full deployment** |

## Troubleshooting

### Manager Won't Start
```bash
# Check service
sudo systemctl status id-agents

# View logs
sudo journalctl -u id-agents -n 50
```

### Agent Deployment Fails
```bash
# Check manager health
curl http://localhost:4100/health

# Check process list
ps aux | grep claude-agent
```

### Database Connection Issues
```bash
# Test database connection
psql "$DATABASE_URL" -c "SELECT 1"

# Check Railway/PlanetScale status
# Ensure SSL mode is correct
```

## Scaling to Phase 2+

When you need more capacity:
1. **Upgrade Hetzner**: CX21 (8GB) or CX31 (16GB)
2. **Add more managers**: Deploy multiple manager instances with shared DB
3. **Multiple VMs**: Distribute agents across VMs with remote manager connections

## Local Development

### Local Development
```bash
# 1. Start PostgreSQL (via brew or system service)
createdb id_agents

# 2. Start the interactive CLI
npm run build
npm run id-agents

# 3. Deploy agents via CLI (first time)
/deploy local-agent my-agent
# To change a running team later: /model, /delete, or `id-agents spawn <name>`  (/sync is REMOVED)
```

### Testing the Setup
```bash
# Test manager health
curl http://localhost:4100/health

# List agents
curl http://localhost:4100/agents
```