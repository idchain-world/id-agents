// SPDX-License-Identifier: MIT
/**
 * ID Agents CLI
 * 
 * Simple CLI for managing agents
 */

import fetch from 'node-fetch';
import { pathToFileURL } from 'node:url';
import { InterTeamCli, INTERTEAM_ADDRESS_HINT } from './cli/interteam-commands.js';

const MANAGER_URL = process.env.ID_MANAGER_URL || 'http://localhost:3100';

interface Agent {
  id: string;
  name: string;
  model: string;
  port: number;
  status: string;
  url: string;
  createdAt: number;
}

export class IdAgentsCLI {
  private managerUrl: string;

  constructor(managerUrl: string = MANAGER_URL) {
    this.managerUrl = managerUrl;
  }

  /**
   * Spawn a new agent
   */
  async spawn(options: {
    name: string;
    model?: string;
    allowedTools?: string[];
    pluginPath?: string;
  }): Promise<Agent> {
    const response = await fetch(`${this.managerUrl}/agents/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Failed to spawn agent: ${(error as any).error}`);
    }

    return await response.json() as Agent;
  }

  /**
   * Register a virtual agent (external endpoint)
   */
  async register(options: {
    name: string;
    endpoint: string;
  }): Promise<Agent> {
    const response = await fetch(`${this.managerUrl}/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Failed to register agent: ${(error as any).error}`);
    }

    return await response.json() as Agent;
  }

  /**
   * List all agents
   */
  async list(): Promise<Agent[]> {
    const response = await fetch(`${this.managerUrl}/agents`);
    
    if (!response.ok) {
      throw new Error('Failed to list agents');
    }

    const data: any = await response.json();
    return data.agents;
  }

  /**
   * Get agent details
   */
  async get(id: string): Promise<Agent> {
    const response = await fetch(`${this.managerUrl}/agents/${id}`);
    
    if (!response.ok) {
      throw new Error(`Agent not found: ${id}`);
    }

    return await response.json() as Agent;
  }

  /**
   * Stop an agent
   */
  async stop(id: string): Promise<void> {
    const response = await fetch(`${this.managerUrl}/agents/${id}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error(`Failed to stop agent: ${id}`);
    }
  }

  /**
   * Talk to an agent via REST-AP
   */
  async talk(agentId: string, message: string, sessionId?: string): Promise<any> {
    const agent = await this.get(agentId);
    
    const response = await fetch(`${agent.url}/talk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, session_id: sessionId })
    });

    if (!response.ok) {
      throw new Error('Failed to send message to agent');
    }

    return await response.json();
  }

  /**
   * Get news from an agent
   */
  async news(agentId: string, since: number = 0): Promise<any> {
    const agent = await this.get(agentId);
    
    const response = await fetch(`${agent.url}/news?since=${since}`);
    
    if (!response.ok) {
      throw new Error('Failed to get news from agent');
    }

    return await response.json();
  }
}

// CLI command handler
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const cli = new IdAgentsCLI();

  try {
    switch (command) {
      case 'spawn':
        const name = args[1];
        const model = args[2];
        const pluginPath = args[3];
        if (!name) {
          console.error('Usage: id-agents spawn <name> [model] [plugin-path]');
          process.exit(1);
        }
        const agent = await cli.spawn({ name, model, pluginPath });
        console.log(`✅ Agent spawned: ${agent.name}`);
        console.log(`   ID: ${agent.id}`);
        console.log(`   URL: ${agent.url}`);
        console.log(`   Model: ${agent.model}`);
        if (pluginPath) {
          console.log(`   Plugin: ${pluginPath}`);
        }
        break;

      case 'register':
        const regName = args[1];
        const endpoint = args[2];
        if (!regName || !endpoint) {
          console.error('Usage: id-agents register <name> <endpoint>');
          console.error('Example: id-agents register "helper" https://helper.example.com');
          process.exit(1);
        }
        const virtualAgent = await cli.register({ name: regName, endpoint });
        console.log(`✅ Virtual agent registered: ${virtualAgent.name}`);
        console.log(`   ID: ${virtualAgent.id}`);
        console.log(`   URL: ${virtualAgent.url}`);
        break;

      case 'list':
        const agents = await cli.list();
        console.log(`\n📋 Agents (${agents.length}):\n`);
        for (const a of agents) {
          console.log(`  ${a.name} (${a.id})`);
          console.log(`    Status: ${a.status}`);
          console.log(`    Model: ${a.model}`);
          console.log(`    URL: ${a.url}`);
          console.log('');
        }
        break;

      case 'stop':
        const id = args[1];
        if (!id) {
          console.error('Usage: id-agents stop <agent-id>');
          process.exit(1);
        }
        await cli.stop(id);
        console.log(`✅ Agent stopped: ${id}`);
        break;

      case 'interteam': {
        const sub = args[1];
        const team = process.env.ID_TEAM;
        if (!team) {
          console.error('interteam commands need ID_TEAM set to your team name');
          process.exit(1);
        }
        const interteam = new InterTeamCli({
          managerUrl: MANAGER_URL,
          team,
          agentId: process.env.ID_AGENT_ID,
        });
        if (sub === 'send') {
          const address = args[2];
          const message = args[3];
          if (!address || !message) {
            console.error('Usage: id-agents interteam send <team:alias[/agent-name]> <message>');
            console.error(INTERTEAM_ADDRESS_HINT);
            process.exit(1);
          }
          const sent = await interteam.send({ address, body: message });
          console.log(`✅ ${sent.deduplicated ? 'Already accepted' : 'Accepted'}`);
          console.log(`   Conversation: ${sent.conversationId}`);
          console.log(`   Message: ${sent.messageId}`);
          console.log(`   Collect with: id-agents interteam collect ${sent.conversationId} ${sent.messageId}`);
        } else if (sub === 'collect') {
          const conversationId = args[2];
          const messageId = args[3];
          if (!conversationId || !messageId) {
            console.error('Usage: id-agents interteam collect <conversation-id> <message-id>');
            process.exit(1);
          }
          console.log(JSON.stringify(await interteam.collect(conversationId, messageId), null, 2));
        } else if (sub === 'roster') {
          const alias = args[2];
          if (!alias) {
            console.error('Usage: id-agents interteam roster <alias>');
            process.exit(1);
          }
          console.log(JSON.stringify(await interteam.roster(alias), null, 2));
        } else {
          console.error('Usage: id-agents interteam <send|collect|roster> ...');
          console.error(INTERTEAM_ADDRESS_HINT);
          process.exit(1);
        }
        break;
      }

      default:
        console.log(`
ID Agents CLI

Usage:
  id-agents spawn <name> [model] [plugin-path] - Spawn a new local agent
  id-agents register <name> <endpoint> - Register a virtual agent (external endpoint)
  id-agents list                       - List all agents
  id-agents stop <agent-id>            - Stop an agent

Examples:
  id-agents spawn "coding-agent" claude-haiku-4-5-20251001
  id-agents spawn "research-agent" claude-sonnet-4-20250514
  id-agents spawn "coding-agent" claude-haiku-4-5-20251001 /path/to/plugin
  id-agents register "helper" https://helper.example.com
  id-agents list
  id-agents stop agent_123

Inter-team (needs ID_TEAM, optionally ID_AGENT_ID):
  id-agents interteam send <team:alias[/agent-name]> <message>
  id-agents interteam collect <conversation-id> <message-id>
  id-agents interteam roster <alias>
`);
    }
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run CLI if executed directly. Use pathToFileURL so paths with characters
// that percent-encode in a file URL (e.g. spaces) still match import.meta.url.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export default IdAgentsCLI;
