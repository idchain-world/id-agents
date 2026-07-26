#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { SYNC_REMOVED_MESSAGE } from './lib/sync-removed.js';
import 'dotenv/config';
import readline from 'readline';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import WebSocket from 'ws';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { processConfig, getConfigParameters } from './config-parser.js';
import { validateName } from './name-validation.js';
import {
  findProjectRoot as coreFindProjectRoot,
  readDotEnvFile as coreReadDotEnvFile,
} from './core/index.js';
import { getRuntimeDisplayName, resolveRuntime } from './runtime/registry.js';
import { resolveModelAlias } from './core/model-aliases.js';
import {
  addPublicAgent,
  listPublicAgents,
  removePublicAgent,
} from './cli/public-commands.js';
import {
  maybeRunWorkspaceSyncCli,
  maybeRunWorkspaceUnsyncCli,
} from './cli/workspace-sync.js';
import { waitForAgentReady } from './cli/agent-readiness.js';

const oneShotSyncExit = await maybeRunWorkspaceSyncCli(process.argv.slice(2));
if (oneShotSyncExit !== null) {
  process.exit(oneShotSyncExit);
}
const oneShotUnsyncExit = await maybeRunWorkspaceUnsyncCli(process.argv.slice(2));
if (oneShotUnsyncExit !== null) {
  process.exit(oneShotUnsyncExit);
}

const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  red: '\x1b[31m'
};

/**
 * Play an audio alert sound (cross-platform)
 * - macOS: uses afplay with system sound
 * - Linux: tries paplay, aplay, or terminal bell
 * - Fallback: terminal bell character
 */

function playAlertSound() {
  try {
    if (process.platform === 'darwin') {
      // macOS - use afplay with a pleasant system sound
      const sound = '/System/Library/Sounds/Glass.aiff';
      spawn('afplay', [sound], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'linux') {
      // Linux - try paplay with a freedesktop sound
      spawn('paplay', ['/usr/share/sounds/freedesktop/stereo/message.oga'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      // Fallback for other platforms - terminal bell
      process.stdout.write('\x07');
    }
  } catch {
    // Ignore sound errors - not critical
  }
}

// Help menu items - single source of truth (alphabetically organized)
const HELP_ITEMS: Array<{ cmd: string; desc: string; indent?: boolean }> = [
  { cmd: '/agent <name> rebuild', desc: 'Rebuild a single agent' },
  { cmd: '/agent <name> probe', desc: 'End-to-end dispatch probe of a single agent' },
  { cmd: '/agent <name> wallet provision', desc: 'Provision an OWS wallet for one agent' },
  { cmd: '/agents', desc: 'List all agents' },
  { cmd: '/agents probe', desc: 'End-to-end dispatch probe of every running agent' },
  { cmd: '/agents rebuild --confirm', desc: 'Rebuild all eligible local Claude agents' },
  { cmd: '/ask [/hey] <agent> <msg>', desc: 'Talk to agent (continues session)' },
  { cmd: '/ask * <msg>', desc: 'Broadcast to all agents' },
  { cmd: '/clear [agent]', desc: 'Clear session (start fresh)' },
  { cmd: '/delete <agent>', desc: 'Delete agent by name or id' },
  { cmd: '/delete *', desc: 'Delete all agents in current team' },
  { cmd: '/delete --team <name>', desc: 'Delete all agents in a specific team' },
  { cmd: '/deploy <config> [params]', desc: 'Deploy agents from config' },
  { cmd: '/help', desc: 'Show this help' },
  { cmd: '/output <agent>', desc: 'List files in agent output directory' },
  { cmd: '/artifact <agent> <path>', desc: 'Read file from agent output directory' },
  { cmd: '/news [-l] <agent>', desc: 'Check recent messages (-l for full content)' },
  { cmd: '/public', desc: 'List registered public-team agents' },
  { cmd: '/public add <domain> [--ssh-target=user@host] [--internal-port=N]', desc: 'Register a remote public-agent' },
  { cmd: '/public remove <name|domain>', desc: 'Deregister a public-team agent' },
  { cmd: '/public <n|domain> <msg>', desc: 'Chat with a public agent by index or domain' },
  { cmd: '/public clear', desc: 'Remove all public-team agents (with confirmation)' },
  { cmd: '/respond <num|query_id> [msg]', desc: 'Respond to pending manager inbox work' },
  { cmd: '/heartbeat', desc: 'List heartbeats' },
  { cmd: '/heartbeat add <agent> <seconds> <message>', desc: 'Add heartbeat' },
  { cmd: '/heartbeat pause|resume|remove <id>', desc: 'Manage heartbeat' },
  { cmd: '/calendar', desc: 'List calendar events' },
  { cmd: '/calendar add <agent> <time> <days|date> <message>', desc: 'Add calendar event' },
  { cmd: '/calendar pause|resume|remove <id>', desc: 'Manage calendar event' },
  { cmd: '/task create "<title>" [--owner <agent>] [--team <team>] [--event <id>]', desc: 'Create a task' },
  { cmd: '/task list [--status <status>] [--owner <agent>] [--team <team>]', desc: 'List tasks' },
  { cmd: '/task assign <task-name> <agent>', desc: 'Assign task to agent' },
  { cmd: '/task done <task-name>', desc: 'Mark task done' },
  { cmd: '/task remove <task-name>', desc: 'Remove a task' },
  { cmd: '/sync', desc: 'REMOVED — use /diff for drift, /agents spawn|remove and /model for live changes' },
  { cmd: '/status', desc: 'Check agent status' },
  { cmd: '/update <agent> [--wallet <addr>] [--name <name>]', desc: 'Update agent properties' },
  { cmd: '/wallet <agent> [chain]', desc: 'Show agent wallet address (chain: eip155:1, solana, etc.)' },
  { cmd: '/team', desc: 'Show current team' },
  { cmd: '/team <name>', desc: 'Switch to or create team' },
  { cmd: '/teams', desc: 'List all teams' },
  { cmd: '/team delete <name>', desc: 'Delete a team (must be empty — run /delete --team first)' },
  { cmd: '/quit', desc: 'Exit' },
];

function printHelp(header?: string) {
  if (header) {
    console.log(`\n${colors.bold}${header}${colors.reset}\n`);
  } else {
    console.log(`${colors.gray}Commands:${colors.reset}`);
  }
  for (const item of HELP_ITEMS) {
    const indent = item.indent ? '    ' : '  ';
    console.log(`${indent}${colors.cyan}${item.cmd}${colors.reset} - ${item.desc}`);
  }
  console.log('');
}

/**
 * Modular confirmation prompt utility.
 * Returns a promise that resolves to true if confirmed, false otherwise.
 *
 * @param rl - readline interface
 * @param message - The confirmation message to display
 * @param confirmKeyword - The keyword user must type to confirm (default: 'yes')
 * @param options - Additional styling options
 */
interface ConfirmOptions {
  messageColor?: string;
  keywordColor?: string;
  cancelMessage?: string;
}

// Flag to track when we're waiting for confirmation input
let isAwaitingConfirmation = false;

async function confirmAction(
  rl: readline.Interface,
  message: string,
  confirmKeyword: string = 'yes',
  options: ConfirmOptions = {}
): Promise<boolean> {
  const {
    messageColor = colors.yellow,
    keywordColor = colors.cyan,
    cancelMessage = 'Cancelled.'
  } = options;

  return new Promise((resolve) => {
    isAwaitingConfirmation = true;
    console.log(`\n${messageColor}${message}${colors.reset}`);
    console.log(`${colors.gray}Type ${keywordColor}${confirmKeyword}${colors.gray} to confirm, or anything else to cancel.${colors.reset}`);

    const originalPrompt = rl.getPrompt();
    rl.setPrompt(`${colors.yellow}> ${colors.reset}`);
    rl.prompt();

    const confirmHandler = (answer: string) => {
      rl.removeListener('line', confirmHandler);
      rl.setPrompt(originalPrompt);
      isAwaitingConfirmation = false;

      if (answer.trim().toLowerCase() === confirmKeyword.toLowerCase()) {
        resolve(true);
      } else {
        console.log(`${colors.gray}${cancelMessage}${colors.reset}\n`);
        resolve(false);
      }
    };

    rl.on('line', confirmHandler);
  });
}

/** Check if currently awaiting confirmation input */
function isInConfirmationMode(): boolean {
  return isAwaitingConfirmation;
}

// ES module equivalent of __dirname for macro resolution
const __cli_filename = fileURLToPath(import.meta.url);
const __cli_dirname = path.dirname(__cli_filename);
const MACROS_DIR = path.resolve(__cli_dirname, '..', 'macros');

/**
 * Expand macros in input text.
 * Syntax: :::macroname arg1 arg2::: or :::macroname arg1 arg2 (if at end or followed by another macro)
 *
 * Macros are .md files in the macros/ folder.
 * Arguments are substituted as ${1}, ${2}, etc.
 * ${@} expands to all remaining arguments.
 */
function expandMacros(input: string): string {
  let result = input;
  let hasExpansion = false;

  // Helper to expand a single macro
  const doExpand = (fullMatch: string, macroName: string, argsStr: string | undefined): string => {
    // Parse arguments (space-separated, respecting quotes)
    const args = parseArgs((argsStr || '').trim());

    // Load macro file
    const macroPath = path.join(MACROS_DIR, `${macroName}.md`);
    if (!fs.existsSync(macroPath)) {
      console.log(`${colors.yellow}⚠️  Macro not found: ${macroName} (expected at: ${macroPath})${colors.reset}`);
      return fullMatch; // Leave unchanged if not found
    }

    let macroContent = fs.readFileSync(macroPath, 'utf-8');

    // Remove comment lines (lines starting with #)
    macroContent = macroContent
      .split('\n')
      .filter(line => !line.trim().startsWith('#'))
      .join('\n')
      .trim();

    // Substitute positional arguments ${1}, ${2}, etc.
    for (let i = 0; i < args.length; i++) {
      macroContent = macroContent.replace(new RegExp(`\\$\\{${i + 1}\\}`, 'g'), args[i]);
    }

    // Substitute ${@} with all arguments
    macroContent = macroContent.replace(/\$\{@\}/g, args.join(' '));

    hasExpansion = true;
    return macroContent;
  };

  // First pass: Match macros with explicit closing ::: (e.g., :::name::: or :::name args:::)
  // Use negative lookahead to ensure args don't consume :::
  result = result.replace(/:::([\w-]+)(?:\s+((?:(?!:::).)*?))?:::/g, (match, name, args) => {
    return doExpand(match, name, args);
  });

  // Second pass: Match macros at end of input (no closing :::)
  result = result.replace(/:::([\w-]+)(?:\s+(.+))?$/g, (match, name, args) => {
    return doExpand(match, name, args);
  });

  if (hasExpansion) {
    console.log(`${colors.gray}📜 Macro expanded to: ${result.substring(0, 100)}${result.length > 100 ? '...' : ''}${colors.reset}`);
  }

  return result;
}

/**
 * Parse arguments string, respecting quoted strings
 */
function parseArgs(argsStr: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i];

    if (!inQuote && (char === '"' || char === "'")) {
      inQuote = true;
      quoteChar = char;
    } else if (inQuote && char === quoteChar) {
      inQuote = false;
      quoteChar = '';
    } else if (!inQuote && char === ' ') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}

// Agent name validation: lowercase letters, numbers, and hyphens (like domain names)
const VALID_AGENT_NAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Sanitize agent name by stripping trailing invalid characters.
 * This allows commands like `/hey coder1,` to work (comma is stripped).
 */
function sanitizeAgentName(name: string): string {
  // Strip trailing non-valid characters (keep a-z, 0-9, hyphen)
  return name.replace(/[^a-z0-9-]+$/i, '').toLowerCase();
}

/**
 * Validate agent name format (a-z, 0-9, and hyphens allowed).
 * Cannot start or end with hyphen.
 * Returns error message if invalid, null if valid.
 */
function validateAgentName(name: string): string | null {
  if (!name) {
    return 'Agent name is required';
  }
  if (!VALID_AGENT_NAME_REGEX.test(name)) {
    return `Invalid agent name "${name}". Only lowercase letters (a-z), numbers (0-9), and hyphens (-) are allowed. Cannot start or end with hyphen.`;
  }
  return null;
}

// The CLI is the interface to the manager agent, so we always identify as "manager"
const name = 'manager';

// Parse --port flag: npm run id-agents -- --port 5000
// Priority: --port flag > MANAGER_PORT env > PORT env > default 4100
function parseManagerPort(): number {
  const portIdx = process.argv.indexOf('--port');
  if (portIdx !== -1 && process.argv[portIdx + 1]) {
    const p = parseInt(process.argv[portIdx + 1]);
    if (!isNaN(p) && p > 0) return p;
  }
  if (process.env.MANAGER_PORT) {
    const p = parseInt(process.env.MANAGER_PORT);
    if (!isNaN(p) && p > 0) return p;
  }
  if (process.env.PORT) {
    const p = parseInt(process.env.PORT);
    if (!isNaN(p) && p > 0) return p;
  }
  return 4100;
}

const MANAGER_PORT = parseManagerPort();

// Simplified configuration - all local teams share one manager
let activeTeam = process.env.ID_TEAM || process.env.ID_PROJECT || 'default';

let activeServerName = activeTeam;
let lastAskedAgent: string | null = null;

// Manager URL - derived from MANAGER_PORT
const MANAGER_URL = process.env.MANAGER_URL || `http://localhost:${MANAGER_PORT}`;

// ==================== Agent Display Helpers ====================

/**
 * Get the display name for an agent
 * name is the displayId (ENS domain or local name)
 */
function getAgentDisplayName(agent: any): string {
  if (!agent) return 'unknown';
  return agent.name || 'unknown';
}


// Use core findProjectRoot with current file's directory as starting point
const PROJECT_ROOT = coreFindProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

function getPackageInfo(): { version: string; license: string } {
  try {
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return { version: pkg.version || '0.0.0', license: pkg.license || 'MIT' };
  } catch {
    return { version: '0.0.0', license: 'MIT' };
  }
}

const PKG_INFO = getPackageInfo();

// Wrapper for core readDotEnvFile
function readDotEnvFile(envPath: string): Record<string, string> {
  return coreReadDotEnvFile(envPath);
}

async function managerFetch(pathname: string, init: any = {}) {
  const headers: Record<string, string> = {
    ...(init.headers || {}),
    // New header name (preferred)
    'X-Id-Team': activeTeam,
    // Backwards compatibility
    'X-Id-Project': activeTeam
  };
  return await fetch(`${MANAGER_URL}${pathname}`, { ...init, headers });
}

interface IncomingReply {
  from: string;
  in_reply_to: string;
  message: string;
  sessionId?: string;
  to?: string;
}

interface IncomingMessage {
  type: string;
  from: string;
  message: string;
  timestamp: number;
}

interface ManagerInboxItem {
  query_id: string;
  prompt?: string | null;
  message: string;
  timestamp: number;
  status?: string;
  session_id?: string | null;
  from?: string | null;
  reply_endpoint?: string | null;
  schedule?: Record<string, unknown> | null;
  mode?: string | null;
}

interface CliNewsItem {
  type: string;
  timestamp: number;
  message?: string;
  data?: Record<string, unknown>;
}

// ─── Public agent interactive chat session ──────────────────────────────────
// When the user types `/public <n|name|domain>` with no message, we enter
// a chat loop where every subsequent line goes to that agent's /talk endpoint
// (session_id threaded across turns for continuity). `/exit`, `/quit`, or a
// slash-command resumes the main CLI prompt.
interface PublicSession {
  name: string;
  customerDomain: string;
  talkEndpoint: string;
  sessionId: string | null;
  priorPrompt: string;
}
let publicSession: PublicSession | null = null;


// Track outgoing queries so we can match incoming replies
interface PendingOutgoingQuery {
  queryId: string;
  agentName: string;
  message: string;
  timestamp: number;
}
const pendingOutgoingQueries = new Map<string, PendingOutgoingQuery>();
// Track displayed replies to prevent duplicates (replies can arrive via multiple channels)
const displayedReplies = new Set<string>();
const localNewsItems: CliNewsItem[] = [];

function recordLocalNewsItem(item: CliNewsItem) {
  localNewsItems.push(item);
  if (localNewsItems.length > 200) {
    localNewsItems.splice(0, localNewsItems.length - 200);
  }
}

function handleIncomingReply(reply: IncomingReply) {
  const pending = pendingOutgoingQueries.get(reply.in_reply_to);

  // Only display replies to queries WE sent
  // Inter-agent replies (e.g., dev → pm) are broadcast to manager for monitoring
  // but shouldn't be displayed in the CLI inbox
  if (!pending) {
    return;
  }

  // Deduplicate - replies can arrive via WebSocket, POST /news, and polling
  if (displayedReplies.has(reply.in_reply_to)) {
    return; // Already displayed this reply
  }
  displayedReplies.add(reply.in_reply_to);
  // Clean up old entries (keep last 100)
  if (displayedReplies.size > 100) {
    const oldest = Array.from(displayedReplies).slice(0, displayedReplies.size - 100);
    oldest.forEach(id => displayedReplies.delete(id));
  }

  // Save session ID for future conversations with this agent
  if (reply.sessionId && reply.from) {
    agentSessions.set(reply.from, reply.sessionId);
  }

  // Play audio alert for incoming replies
  try {
    playAlertSound();
  } catch {
    // Ignore sound errors
  }

  // This is a reply to one of our outgoing messages
  pendingOutgoingQueries.delete(reply.in_reply_to);
  console.log(`\n${colors.green}📬 Reply from ${reply.from}:${colors.reset}`);
  const originalMsg = pending.message || '';
  if (originalMsg) {
    console.log(`${colors.gray}   (to: "${originalMsg.substring(0, 50)}${originalMsg.length > 50 ? '...' : ''}")${colors.reset}`);
  }
  console.log(`\n${reply.message}\n`);
  updatePrompt();
  rl.prompt();
}

function handleIncomingMessage(msg: IncomingMessage) {
  console.log(`\n${colors.cyan}📨 New message from ${msg.from}:${colors.reset}`);
  console.log(`\n${msg.message}\n`);
  updatePrompt();
  rl.prompt();
}

async function fetchPendingManagerInbox(): Promise<ManagerInboxItem[]> {
  const response = await managerFetch('/manager/inbox/pending');
  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Failed to fetch pending manager inbox items: ${response.status} ${errorText}`);
  }
  const data = await response.json() as { pending?: ManagerInboxItem[] };
  return Array.isArray(data.pending) ? data.pending : [];
}

async function respondToManagerInboxQuery(queryId: string, message: string, sessionId?: string | null): Promise<void> {
  const body: Record<string, unknown> = { query_id: queryId, message };
  if (sessionId) body.session_id = sessionId;

  const response = await managerFetch('/manager/inbox/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Failed to respond to ${queryId}: ${response.status} ${errorText}`);
  }
}

async function getManagerNewsItems(limit: number = 20): Promise<CliNewsItem[]> {
  const response = await managerFetch(`/news?since=0&limit=${Math.max(limit * 4, 100)}`);
  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Failed to fetch manager news: ${response.status} ${errorText}`);
  }

  const data = await response.json() as { items?: CliNewsItem[] };
  const remoteItems = Array.isArray(data.items) ? data.items : [];
  const combined = [...remoteItems, ...localNewsItems];
  combined.sort((a, b) => b.timestamp - a.timestamp);
  return combined.slice(0, limit);
}

async function recordOutboundMessage(params: {
  to: string;
  message: string;
  queryId?: string;
  type?: 'message' | 'broadcast';
}) {
  const newsType = params.type === 'broadcast' ? 'outbound.broadcast' : 'outbound.message';
  recordLocalNewsItem({
    timestamp: Date.now(),
    type: newsType,
    message: `Sent ${params.type || 'message'} to ${params.to}`,
    data: {
      to: params.to,
      message: params.message,
      query_id: params.queryId,
    },
  });
}

// ==================== WebSocket Connection to Manager ====================
// Use WebSocket for real-time updates from manager (works for both local and remote)

let managerWs: WebSocket | null = null;
let wsReconnectTimer: NodeJS.Timeout | null = null;
let newsPollInterval: NodeJS.Timeout | null = null;
let lastNewsTimestamp = Date.now();
let useWebSocket = true;  // Try WebSocket first

function getWebSocketUrl(): string {
  // Convert http(s)://host:port to ws(s)://host:port/ws
  const url = new URL(MANAGER_URL);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}/ws?team=${encodeURIComponent(activeTeam)}`;
}

function handleWebSocketMessage(data: WebSocket.Data) {
  try {
    const message = JSON.parse(data.toString());

    switch (message.type) {
      case 'connected':
        console.log(`\n${colors.green}🔌 WebSocket connected to ${activeTeam}${colors.reset}`);
        rl.prompt();
        break;

      case 'news': {
        // Real-time news from WebSocket
        const itemData = message.data || {};
        const from = message.from || itemData.from;
        const newsMessage = message.message || itemData.message;
        const inReplyTo = message.in_reply_to || itemData.in_reply_to;
        const sessionId = itemData.sessionId || message.session_id;
        const newsType = message.newsType;
        const replyTo = message.to || itemData.to;  // Intended recipient

        // Check if this is a reply to one of our pending queries
        // Only emit for actual 'reply' type, not status updates like outbound.reply, query.completed
        if (inReplyTo && newsType === 'reply' && pendingOutgoingQueries.has(inReplyTo)) {
          handleIncomingReply({
            from,
            message: newsMessage,
            in_reply_to: inReplyTo,
            sessionId,
            to: replyTo
          });
        } else if (newsType === 'message') {
          // General message (including replies to unknown queries)
          handleIncomingMessage({
            type: newsType,
            from,
            message: newsMessage,
            timestamp: message.timestamp
          });
        }
        break;
      }

      case 'result':
        // Command result - could be used for async commands
        break;

      case 'agents_changed': {
        const change = message.change || {};
        const added: string[] = Array.isArray(change.added) ? change.added : [];
        const updated: string[] = Array.isArray(change.updated) ? change.updated : [];
        const removed: string[] = Array.isArray(change.removed) ? change.removed : [];
        const reason = typeof change.reason === 'string' ? change.reason : 'change';

        // Drop session continuity for any agent that disappeared or was rebuilt;
        // the next /ask starts a fresh session against whatever now answers.
        for (const name of removed) agentSessions.delete(name);
        for (const name of updated) agentSessions.delete(name);

        if (added.length || updated.length || removed.length) {
          const parts: string[] = [];
          if (added.length) parts.push(added.map(n => `+${n}`).join(' '));
          if (updated.length) parts.push(updated.map(n => `~${n}`).join(' '));
          if (removed.length) parts.push(removed.map(n => `-${n}`).join(' '));
          console.log(`\n${colors.gray}🔄 registry: ${parts.join(' ')} (${reason})${colors.reset}`);
          rl.prompt();
        }
        break;
      }

      case 'error':
        console.log(`${colors.red}WebSocket error: ${message.error}${colors.reset}`);
        break;

      case 'pong':
        // Keep-alive response
        break;
    }
  } catch (err) {
    // Ignore parse errors
  }
}

function connectManagerWebSocket() {
  if (!useWebSocket) return;

  const wsUrl = getWebSocketUrl();

  try {
    managerWs = new WebSocket(wsUrl);

    managerWs.on('open', () => {
      // Silent connection — don't clutter the prompt
      // Stop polling if WebSocket is connected
      if (newsPollInterval) {
        clearInterval(newsPollInterval);
        newsPollInterval = null;
      }
    });

    managerWs.on('message', handleWebSocketMessage);

    managerWs.on('close', () => {
      console.log(`${colors.gray}🔌 WebSocket disconnected${colors.reset}`);
      managerWs = null;
      // Try to reconnect after delay
      if (!wsReconnectTimer) {
        wsReconnectTimer = setTimeout(() => {
          wsReconnectTimer = null;
          if (useWebSocket) {
            connectManagerWebSocket();
          }
        }, 5000);
      }
      // Start polling as fallback
      startNewsPolling();
    });

    managerWs.on('error', (err) => {
      // WebSocket failed, fall back to polling (for both local and remote teams)
      console.log(`${colors.gray}📡 WebSocket unavailable, using polling${colors.reset}`);
      startNewsPolling();
      useWebSocket = false;
      managerWs = null;
    });

  } catch (err) {
    // WebSocket creation failed, use polling as fallback
    useWebSocket = false;
    startNewsPolling();
  }
}

async function pollNews() {
  // Skip if WebSocket is connected (preferred real-time delivery)
  if (managerWs && managerWs.readyState === WebSocket.OPEN) return;

  try {
    const response = await managerFetch(`/news?since=${lastNewsTimestamp}`);
    if (!response.ok) return;

    const data: any = await response.json();
    const items = data.items || data.news || [];

    for (const item of items) {
      // Update timestamp to avoid re-processing
      if (item.timestamp > lastNewsTimestamp) {
        lastNewsTimestamp = item.timestamp;
      }

      // Extract data from nested structure (manager stores: { from, in_reply_to, message, sessionId, to })
      const itemData = item.data || {};
      const from = itemData.from || item.from;
      const message = itemData.message || item.message;
      const inReplyTo = itemData.in_reply_to || item.in_reply_to;
      const sessionId = itemData.sessionId || item.session_id;
      const replyTo = itemData.to || item.to;  // Intended recipient

      // Check if this is a reply to one of our pending queries
      // Only emit for actual 'reply' type, not status updates like outbound.reply, query.completed
      if (inReplyTo && item.type === 'reply' && pendingOutgoingQueries.has(inReplyTo)) {
        handleIncomingReply({
          from,
          message,
          in_reply_to: inReplyTo,
          sessionId,
          to: replyTo
        });
      } else if (item.type === 'reply' && inReplyTo) {
        // Reply to a query we don't have tracked — this is inter-agent traffic
        // (e.g., pm asked dev something on our behalf). Don't show it to avoid noise.
        // The reply we care about (pm's final response) will match pendingOutgoingQueries.
        // User can check with /news <agent> if needed.
        continue;
      } else if (item.type === 'message') {
        // General message
        handleIncomingMessage({
          type: item.type,
          from,
          message,
          timestamp: item.timestamp
        });
      }
    }
  } catch {
    // Ignore polling errors silently
  }
}

function startNewsPolling() {
  if (newsPollInterval) {
    clearInterval(newsPollInterval);
  }
  // Only poll if WebSocket is not connected
  if (!managerWs || managerWs.readyState !== WebSocket.OPEN) {
    lastNewsTimestamp = Date.now();
    newsPollInterval = setInterval(pollNews, 2000); // Poll every 2 seconds
    if (!useWebSocket) {
      console.log(`${colors.gray}📡 Started polling news feed${colors.reset}`);
    }
  }
}

function stopManagerConnection() {
  if (newsPollInterval) {
    clearInterval(newsPollInterval);
    newsPollInterval = null;
  }
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (managerWs) {
    managerWs.close();
    managerWs = null;
  }
}

function startManagerConnection() {
  connectManagerWebSocket();
}

async function waitForManagerReady(timeoutMs: number = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkManager()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Start or restart a local agent process
 * Returns { success, pid?, logFile?, error? }
 */
async function startLocalAgentProcess(agentData: any): Promise<{ success: boolean; pid?: number; logFile?: string; error?: string }> {
  try {
    const { spawn } = await import('child_process');
    const scriptPath = path.resolve(__cli_dirname, 'local-agent-server.js');

    // Use alias (base name like "pm") not name (which may be an ENS domain after registration)
    const agentName = agentData.alias || agentData.name;
    const agentId = agentData.id;
    const agentPort = agentData.port;
    const agentModel = agentData.model;
    const agentTokenId = agentData.tokenId;
    let workingDir = agentData.workingDirectory || agentData.metadata?.workingDirectory;
    let sharedDir = agentData.sharedDirectory || agentData.metadata?.sharedDirectory;

    // Convert workspace paths to host paths for local agents
    // Workspace paths start with /workspace/, host paths use the actual workspace directory
    const hostWorkspace = path.join(PROJECT_ROOT, 'workspace');
    if (workingDir && workingDir.startsWith('/workspace/')) {
      workingDir = workingDir.replace('/workspace/', hostWorkspace + '/');
    }
    if (sharedDir && sharedDir.startsWith('/workspace/')) {
      sharedDir = sharedDir.replace('/workspace/', hostWorkspace + '/');
    }

    // Kill any existing process on this port before starting
    if (agentPort) {
      try {
        const lsofOutput = execFileSync('lsof', ['-ti', `:${agentPort}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        if (lsofOutput) {
          const pids = lsofOutput.split('\n').filter(Boolean);
          for (const pid of pids) {
            try {
              process.kill(parseInt(pid), 'SIGTERM');
            } catch {
              // Process may have already exited
            }
          }
          // Wait a moment for the process to exit
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch {
        // No process on port, that's fine
      }
    }

    // Build command arguments
    const spawnArgs = [
      scriptPath,
      agentName,
      '--team', activeTeam,
      '--port', String(agentPort),
      '--id', agentId
    ];
    if (workingDir) {
      spawnArgs.push('--dir', workingDir);
    }

    // Set environment variables
    const localEnv = {
      ...process.env,
      ID_TEAM: activeTeam,
      MANAGER_URL: MANAGER_URL,
      ...(sharedDir && { ID_SHARED_DIR: sharedDir }),
      ...(agentModel && { CLAUDE_MODEL: resolveModelAlias(agentModel) }),
      // Pass tokenId so agent knows its registry identity
      ...(agentTokenId && { ID_AGENT_TOKEN_ID: agentTokenId })
    };

    // Create log file for the local agent
    const logsDir = path.join(process.env.ID_WORKSPACE_DIR || process.env.WORKSPACE_DIR || '/tmp/id-agents', 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const logFile = path.join(logsDir, `local-${agentName}-${Date.now()}.log`);
    const logStream = fs.openSync(logFile, 'a');

    const localAgent = spawn('node', spawnArgs, {
      env: localEnv,
      stdio: ['ignore', logStream, logStream],
      detached: true
    });

    localAgent.unref();
    fs.closeSync(logStream);

    return { success: true, pid: localAgent.pid, logFile };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Get agent type for start/stop handling
 * Returns: 'local' | 'virtual' | 'interactive'
 */
function getAgentType(agentData: any): 'local' | 'virtual' | 'interactive' {
  if (agentData.type === 'interactive') return 'interactive';
  if (agentData.type === 'virtual') return 'virtual';
  return 'local';
}

/**
 * If configs/<teamName>.yaml is missing, serialize the team's live DB state
 * into a YAML config so a future /deploy has something to read.
 * When force=true, overwrite even if the file exists.
 */
async function regenerateTeamConfigIfMissing(teamName: string, force: boolean = false): Promise<void> {
  const configPath = `configs/${teamName}.yaml`;
  const exists = fs.existsSync(configPath);

  if (exists && !force) {
    console.log(`${colors.gray}   ${configPath} exists, using as-is${colors.reset}`);
    return;
  }

  try {
    const resp = await managerFetch('/agents');
    if (!resp.ok) {
      console.log(`${colors.yellow}   ⚠️  Could not fetch agents to regenerate ${configPath}: ${resp.statusText}${colors.reset}`);
      return;
    }
    const data: any = await resp.json();
    const agents: any[] = (data.agents || []).filter((a: any) => a.type === 'claude');

    if (agents.length === 0) {
      console.log(`${colors.gray}   No agents in team — skipping config regen${colors.reset}`);
      return;
    }

    const serialized: Record<string, any> = {
      version: '1',
      team: teamName,
      agents: agents.map((a: any) => {
        const md = a.metadata || {};
        const entry: Record<string, any> = {
          name: a.alias || a.name,
        };
        if (md.description) entry.description = md.description;
        const runtime = md.runtime || (a as any).runtime;
        if (runtime) entry.runtime = runtime;
        if (a.model) entry.model = a.model;
        if (a.workingDirectory) entry.workingDirectory = a.workingDirectory;
        if (md.local === true) entry.local = true;
        return entry;
      }),
    };

    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const header = exists
      ? `# Regenerated from live team state by /agents rebuild --regenerate-config\n`
      : `# Regenerated from live team state by /agents rebuild (file was missing)\n`;
    fs.writeFileSync(configPath, header + yaml.dump(serialized, { noRefs: true, lineWidth: 120 }));
    console.log(`${colors.green}   ✏️  regenerated ${configPath} from live team state${colors.reset}`);
  } catch (e: any) {
    console.log(`${colors.yellow}   ⚠️  Failed to regenerate ${configPath}: ${e?.message || e}${colors.reset}`);
  }
}

/**
 * Keep the CLI aligned with the effective team after a /sync or /deploy
 * retarget. The daemon owns the manager inbox identity, so the CLI only
 * needs to switch teams and reconnect its manager transport.
 *
 * Returns true if a re-target occurred (caller may want to refresh
 * prompt / log a hint), false otherwise.
 */
async function ensureCliTracksEffectiveTeam(effectiveTeam: string | undefined | null): Promise<boolean> {
  if (!effectiveTeam || effectiveTeam === activeTeam) return false;
  activeTeam = effectiveTeam;
  activeServerName = effectiveTeam;
  updatePrompt();
  stopManagerConnection();
  useWebSocket = true;
  startManagerConnection();
  return true;
}


let rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Check if manager is running
async function checkManager(): Promise<boolean> {
  try {
    const timeout = 2000;
    const response = await managerFetch('/health', {
      method: 'GET',
      signal: AbortSignal.timeout(timeout)
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Show manager not running error
function showManagerNotRunningError() {
  console.log(`\n${colors.red}❌ Manager is not running${colors.reset}`);
  console.log(`${colors.yellow}💡 Start it with: ${colors.cyan}node dist/start-agent-manager.js${colors.reset}\n`);
}

function safeFilenamePart(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'agent';
}

async function saveNewsFeeds() {
  try {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      return;
    }

    const projectRoot = PROJECT_ROOT;
    const outDir = path.join(projectRoot, 'workspace', 'manager', 'news-exports');
    fs.mkdirSync(outDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const combined: any = {
      savedAt: new Date().toISOString(),
      agents: []
    };

    // Pull agent list from manager
    const listResp = await managerFetch('/agents');
    if (!listResp.ok) {
      const text = await listResp.text().catch(() => listResp.statusText);
      console.log(`\n${colors.red}❌ Failed to list agents: ${text}${colors.reset}\n`);
      return;
    }

    const listData: any = await listResp.json();
    const agents: any[] = listData.agents || [];

    // Include the manager daemon itself for the CLI's own inbox view.
    const selfUrl = MANAGER_URL;
    const allTargets: Array<{ name: string; url: string; type: string }> = [
      { name, url: selfUrl, type: 'manager' },
      ...agents.map(a => ({ name: a.name, url: a.url, type: a.type || 'claude' }))
    ];

    // Deduplicate by name (prefer non-self entry if names collide)
    const dedup = new Map<string, { name: string; url: string; type: string }>();
    for (const t of allTargets) {
      const existing = dedup.get(t.name);
      if (!existing) {
        dedup.set(t.name, t);
      } else if (existing.type === 'interactive' && t.type !== 'interactive') {
        dedup.set(t.name, t);
      }
    }

    const targets = Array.from(dedup.values());

    console.log(`\n${colors.gray}💾 Saving news feeds for ${targets.length} agent(s)...${colors.reset}`);
    console.log(`${colors.gray}Output directory:${colors.reset} ${outDir}\n`);

    let saved = 0;
    let failed = 0;

    for (const t of targets) {
      try {
        const resp = t.name.toLowerCase() === name.toLowerCase()
          ? await managerFetch('/news?since=0')
          : await fetch(`${t.url}/news?since=0`, {
              signal: AbortSignal.timeout(5000)
            });
        if (!resp.ok) {
          const text = await resp.text().catch(() => resp.statusText);
          failed++;
          console.log(`${colors.red}✗${colors.reset} ${t.name}: ${resp.status} ${text.substring(0, 80)}`);
          continue;
        }

        const data: any = await resp.json();
        const payload = {
          savedAt: new Date().toISOString(),
          agent: { name: t.name, type: t.type, url: t.url },
          note: 'This is a snapshot of the current in-memory news feed. History beyond the server retention window is not included.',
          news: data
        };

        const filename = `${safeFilenamePart(t.name)}-${stamp}.json`;
        const outPath = path.join(outDir, filename);
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

        combined.agents.push(payload);
        saved++;
        console.log(`${colors.green}✓${colors.reset} ${t.name} → ${path.relative(projectRoot, outPath)}`);
      } catch (e: any) {
        failed++;
        console.log(`${colors.red}✗${colors.reset} ${t.name}: ${e?.message || String(e)}`);
      }
    }

    const combinedPath = path.join(outDir, `all-${stamp}.json`);
    fs.writeFileSync(combinedPath, JSON.stringify(combined, null, 2), 'utf8');

    console.log(`\n${colors.green}✅ Saved ${saved} feed(s), ${failed} failed${colors.reset}`);
    console.log(`${colors.gray}Combined file:${colors.reset} ${path.relative(projectRoot, combinedPath)}\n`);
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

async function saveAgentNewsFeed(targetName: string) {
  try {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      return;
    }

    const resolved = await resolveAgent(targetName);
    if (!resolved) return;

    const projectRoot = PROJECT_ROOT;
    const outDir = path.join(projectRoot, 'workspace', 'manager', 'news-exports');
    fs.mkdirSync(outDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const newsUrl = `${resolved.url}/news?since=0`;
    const resp = await fetch(newsUrl, {
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      console.log(`\n${colors.red}❌ Failed to fetch /news from ${resolved.name}: ${resp.status} ${text}${colors.reset}\n`);
      return;
    }

    const data: any = await resp.json();
    const payload = {
      savedAt: new Date().toISOString(),
      agent: { name: resolved.name, type: resolved.type || 'claude', url: resolved.url },
      news: data
    };

    const filename = `${safeFilenamePart(resolved.name)}-${stamp}.json`;
    const outPath = path.join(outDir, filename);
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

    console.log(`\n${colors.green}✅ Saved${colors.reset} ${resolved.name} → ${path.relative(projectRoot, outPath)}\n`);
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

async function handleLine(line: string) {
  // Skip processing if we're waiting for confirmation input
  if (isInConfirmationMode()) {
    return;
  }

  // Stop all active spinners when user presses Enter
  activeSpinners.forEach(interval => {
    clearInterval(interval);
    activeSpinners.delete(interval);
  });
  process.stderr.write('\r' + ' '.repeat(60) + '\r'); // Clear any spinner line

  let input = line.trim();

  if (!input) {
    rl.prompt();
    return;
  }

  // Public-agent chat session mode: every non-slash line goes to /talk.
  // Any slash command (starting with /) exits the session and runs normally.
  if (publicSession) {
    if (input === '/exit' || input === '/quit' || input === '/q') {
      const name = publicSession.name;
      rl.setPrompt(publicSession.priorPrompt);
      publicSession = null;
      console.log(`${colors.gray}← left public chat with ${name}${colors.reset}\n`);
      rl.prompt();
      return;
    }
    if (input.startsWith('/')) {
      const name = publicSession.name;
      rl.setPrompt(publicSession.priorPrompt);
      publicSession = null;
      console.log(`${colors.gray}← left public chat with ${name} (running slash command)${colors.reset}\n`);
      // fall through to normal handling below
    } else {
      try {
        const body: Record<string, unknown> = { message: input };
        if (publicSession.sessionId) body.session_id = publicSession.sessionId;
        const resp = await (fetch as any)(publicSession.talkEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
        if (!resp.ok) {
          console.log(`${colors.red}❌ Talk failed: HTTP ${resp.status}${colors.reset}`);
        } else {
          const data: any = await resp.json();
          if (typeof data.session_id === 'string') publicSession.sessionId = data.session_id;
          const reply = data.reply ?? data.message ?? data.result ?? JSON.stringify(data);
          console.log(`${colors.bold}${publicSession.name}:${colors.reset} ${reply}\n`);
        }
      } catch (err: any) {
        console.log(`${colors.red}❌ Talk error: ${err?.message ?? err}${colors.reset}`);
      }
      rl.prompt();
      return;
    }
  }

  // Expand macros (:::macroname args:::) before processing
  if (input.includes(':::')) {
    input = expandMacros(input);
  }

  // Handle number input as a quick reply to pending manager inbox work.
  const numericReply = /^\d+$/.test(input) ? parseInt(input, 10) : NaN;
  if (!Number.isNaN(numericReply) && numericReply > 0) {
    try {
      const pending = await fetchPendingManagerInbox();
      if (numericReply <= pending.length) {
        const query = pending[numericReply - 1];
        await promptForManagerInboxResponse(query);
        rl.prompt();
        return;
      }
    } catch (error: any) {
      console.log(`\n${colors.red}❌ ${error?.message || error}${colors.reset}\n`);
      rl.prompt();
      return;
    }
  }
  
  // Handle commands
  if (input === '/quit' || input === '/exit') {
    console.log(`\n${colors.green}👋 Goodbye!${colors.reset}\n`);
    process.exit(0);
  }
  
  // Backwards compatibility aliases
  if (input === '/project') {
    console.log(`\n${colors.bold}📁 Active team:${colors.reset} ${colors.cyan}${activeTeam}${colors.reset}`);
    console.log(`${colors.gray}   Team files: ./workspace/teams/${activeTeam}/${colors.reset}\n`);
    rl.prompt();
    return;
  }

  if (input === '/team') {
    (async () => {
      try {
        const resp = await managerFetch('/teams');
        if (resp.ok) {
          const data = await resp.json() as { teams: Array<{ name: string }> };
          if (data.teams.length === 0) {
            console.log(`\n${colors.gray}No teams yet. Run /team <name> to create one, or /deploy <config> from configs/ to bootstrap.${colors.reset}\n`);
            rl.prompt();
            return;
          }
        }
      } catch {
        // Manager unreachable — fall through to active-team header so the user still gets feedback
      }
      console.log(`\n${colors.bold}📁 Active team:${colors.reset} ${colors.cyan}${activeServerName}${colors.reset}`);
      console.log(`${colors.gray}   Server: ${MANAGER_URL}${colors.reset}`);
      console.log(`${colors.gray}   Team files: ./workspace/teams/${activeTeam}/${colors.reset}`);
      console.log('');
      rl.prompt();
    })();
    return;
  }

  if (input.startsWith('/team ')) {
    const args = input.substring('/team '.length).trim();

    // Parse arguments - handle --url and --key flags
    const parts = args.split(/\s+/);
    const teamName = parts[0];
    const subcommand = parts[1]?.toLowerCase();

    if (!teamName) {
      console.log(`\n${colors.red}❌ Usage: /team <name>${colors.reset}\n`);
      rl.prompt();
      return;
    }

    // Handle /team rebuild - restart manager and all agents with fresh env
    if (teamName === 'rebuild') {
      console.log(`\n${colors.yellow}🔄 Rebuilding local environment...${colors.reset}\n`);

      (async () => {
        try {
          const myPid = process.pid;

          // Step 1: Stop all local agents (by finding processes on agent ports)
          console.log(`${colors.gray}   Stopping local agents...${colors.reset}`);
          try {
            const agentPids = execFileSync('pgrep', ['-f', 'local-agent-server'], { encoding: 'utf8' }).trim();
            for (const pid of agentPids.split('\n').filter(Boolean)) {
              if (pid !== String(myPid)) {
                try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
              }
            }
          } catch {
            // No agents running, that's fine
          }

          // Step 2: Stop the manager
          console.log(`${colors.gray}   Stopping manager on port ${MANAGER_PORT}...${colors.reset}`);
          try {
            const managerPids = execFileSync('lsof', ['-ti', `:${MANAGER_PORT}`], { encoding: 'utf8' }).trim();
            for (const pid of managerPids.split('\n').filter(Boolean)) {
              if (pid !== String(myPid)) {
                try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
              }
            }
          } catch {
            // Nothing on port
          }

          // Wait for processes to die
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Step 3: Restart the manager
          console.log(`${colors.gray}   Starting manager...${colors.reset}`);
          const managerScript = path.resolve(__cli_dirname, 'start-agent-manager.js');
          const managerProc = spawn('node', [managerScript], {
            stdio: 'ignore',
            detached: true,
            env: { ...process.env, AGENT_MANAGER_PORT: String(MANAGER_PORT) }
          });
          managerProc.unref();

          // Wait for manager to start
          console.log(`${colors.gray}   Waiting for manager to be ready...${colors.reset}`);
          let attempts = 0;
          while (attempts < 20) {
            await new Promise(resolve => setTimeout(resolve, 500));
            try {
              const resp = await fetch(`http://localhost:${MANAGER_PORT}/health`);
              if (resp.ok) break;
            } catch {
              // Not ready yet
            }
            attempts++;
          }

          if (attempts >= 20) {
            console.log(`\n${colors.red}❌ Manager failed to start${colors.reset}\n`);
          } else {
            // Reconnect WebSocket
            stopManagerConnection();
            useWebSocket = true;
            startManagerConnection();

            console.log(`\n${colors.green}✅ Rebuild complete${colors.reset}`);
            console.log(`${colors.gray}   Manager restarted with fresh environment${colors.reset}`);
            console.log(`${colors.gray}   Use /deploy to restart agents${colors.reset}\n`);
          }
        } catch (err: any) {
          console.log(`\n${colors.red}❌ Rebuild failed: ${err.message}${colors.reset}\n`);
        }
        rl.prompt();
      })();
      return;
    }

    // Handle /team remove <name> or /team delete <name>
    if (teamName === 'remove' || teamName === 'delete') {
      const nameArg = parts[1];
      if (!nameArg) {
        console.log(`\n${colors.red}❌ Usage: /team delete <name>${colors.reset}\n`);
        rl.prompt();
        return;
      }

      (async () => {
        try {
          if (nameArg === activeTeam) {
            console.log(`\n${colors.red}❌ Cannot delete the active team "${nameArg}". Switch to another team first.${colors.reset}\n`);
            rl.prompt();
            return;
          }

          const confirmed = await confirmAction(
            rl,
            `Delete team "${nameArg}" from database?`,
            'yes',
            { cancelMessage: 'Team deletion cancelled.' }
          );
          if (!confirmed) {
            rl.prompt();
            return;
          }

          const resp = await managerFetch(`/teams/${encodeURIComponent(nameArg)}`, {
            method: 'DELETE'
          });
          const data = await resp.json() as { error?: string; message?: string };

          if (!resp.ok) {
            console.log(`\n${colors.red}❌ ${data.error || 'Failed to delete team'}${colors.reset}\n`);
          } else {
            console.log(`\n${colors.green}✅ ${data.message}${colors.reset}\n`);
          }
        } catch (err: any) {
          console.log(`\n${colors.red}❌ ${err.message}${colors.reset}\n`);
        }
        rl.prompt();
      })();
      return;
    }

    // Handle /team <name> delete - redirect to /team delete <name>
    if (subcommand === 'delete') {
      console.log(`\n${colors.yellow}Use: /team delete ${teamName}${colors.reset}\n`);
      rl.prompt();
      return;
    }

    // Switch to local team
    (async () => {
      try {
        // Check if team already exists
        const listResp = await managerFetch('/teams');
        if (!listResp.ok) {
          console.log(`\n${colors.yellow}⚠️  Could not connect to manager at ${MANAGER_URL}${colors.reset}`);
          console.log(`${colors.gray}   Start manager: node dist/start-agent-manager.js${colors.reset}\n`);
          rl.prompt();
          return;
        }

        const listData = await listResp.json() as { teams: Array<{ name: string }> };
        const existingTeam = listData.teams.find(t => t.name === teamName);

        if (!existingTeam) {
          // Validate name before creating
          const teamNameCheck = validateName(teamName, 'team');
          if (!teamNameCheck.valid) {
            console.log(`\n${colors.red}❌ ${teamNameCheck.error}${colors.reset}\n`);
            rl.prompt();
            return;
          }

          // New team - ask for confirmation
          const confirmed = await confirmAction(
            rl,
            `Team "${teamName}" doesn't exist. Create it?`,
            'yes',
            { cancelMessage: 'Team creation cancelled.' }
          );

          if (!confirmed) {
            rl.prompt();
            return;
          }

          // Create the team
          const createResp = await managerFetch('/teams', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: teamName })
          });
          if (!createResp.ok) {
            const err = await createResp.json() as { error?: string };
            console.log(`\n${colors.red}❌ ${err.error || 'Failed to create team'}${colors.reset}\n`);
            rl.prompt();
            return;
          }
        }

        activeTeam = teamName;
        activeServerName = teamName;
        updatePrompt();
        console.log(`\n${colors.green}✅ Switched to ${colors.cyan}${teamName}${colors.reset}`);
        console.log(`${colors.gray}   Server: ${MANAGER_URL}${colors.reset}\n`);
        stopManagerConnection();
        useWebSocket = true;
        startManagerConnection();
      } catch (err: any) {
        console.log(`\n${colors.yellow}⚠️  Could not connect to manager at ${MANAGER_URL}${colors.reset}`);
        console.log(`${colors.gray}   Start manager: node dist/start-agent-manager.js${colors.reset}\n`);
      }
      rl.prompt();
    })();
    return;
  }

  if (input === '/projects' || input === '/teams') {
    (async () => {
      console.log(`\n${colors.bold}🌐 Teams:${colors.reset}`);

      // Query local teams from manager database
      try {
        const resp = await managerFetch('/teams');
        if (resp.ok) {
          const data = await resp.json() as { teams: Array<{ name: string; agentCount: number }> };
          if (data.teams.length === 0) {
            console.log(`${colors.gray}  No teams yet. Run /team <name> to create one, or /deploy <config> from configs/ to bootstrap.${colors.reset}`);
          } else {
            for (const team of data.teams) {
              const isCurrent = team.name === activeTeam;
              const marker = isCurrent ? `${colors.green}●${colors.reset}` : ' ';
              const nameColor = isCurrent ? colors.cyan : '';
              console.log(`  ${marker} ${nameColor}${team.name}${colors.reset} ${colors.gray}(${team.agentCount} agents)${colors.reset}`);
            }
          }
        } else {
          console.log(`${colors.yellow}  Could not fetch teams from manager${colors.reset}`);
        }
      } catch {
        console.log(`${colors.yellow}  Manager not available - start with: node dist/start-agent-manager.js${colors.reset}`);
      }

      console.log(`\n${colors.gray}Commands:${colors.reset}`);
      console.log(`  ${colors.cyan}/team <name>${colors.reset}             Switch to team (creates if new)`);
      console.log(`  ${colors.cyan}/team delete <name>${colors.reset}      Delete a team\n`);
      rl.prompt();
    })();
    return;
  }

  if (input === '/agents') {
    await listAgents();
    rl.prompt();
    return;
  }

  if (input.startsWith('/agents ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }

    const args = input.substring('/agents '.length).trim();
    const parts = args.split(/\s+/);
    const action = parts[0].toLowerCase();
    const actionArg = parts.slice(1).join(' '); // For reset, this is the optional config path

    if (!['start', 'stop', 'rebuild', 'save', 'reset', 'probe'].includes(action)) {
      console.log(`\n${colors.red}❌ Usage: /agents <start|stop|rebuild|reset|save|probe>${colors.reset}`);
      console.log(`${colors.gray}  /agents rebuild --confirm [--regenerate-config]  - Rebuild all eligible local Claude agents; optionally rewrite configs/<team>.yaml from DB${colors.reset}`);
      console.log(`${colors.gray}  /agents reset [config-file]  - Reset agents with plugins from config${colors.reset}`);
      console.log(`${colors.gray}  /agents probe  - End-to-end dispatch probe of every running agent${colors.reset}\n`);
      rl.prompt();
      return;
    }

    if (action === 'save') {
      await saveNewsFeeds();
      rl.prompt();
      return;
    }

    // Handle reset action specially - it uses a different endpoint
    if (action === 'reset') {
      console.log(`\n${colors.gray}────────────────────────────────────────${colors.reset}`);
      console.log(`${colors.red}${colors.bold}WARNING: COMPLETE RESET${colors.reset}`);
      console.log(`${colors.red}This will wipe all agent working directories!${colors.reset}`);
      console.log(`${colors.gray}────────────────────────────────────────${colors.reset}\n`);
      console.log(`${colors.gray}What will happen:${colors.reset}`);
      console.log(`  - All agents will be stopped`);
      console.log(`  - ${colors.red}ENTIRE working directories will be deleted${colors.reset}`);
      console.log(`  - ${colors.red}All files, plugins, and customizations will be LOST${colors.reset}`);
      console.log(`  - Fresh directories created with plugins from config`);
      console.log(`  - Agents restarted with clean state`);
      console.log(`\n${colors.gray}Config: ${actionArg || 'configs/default.yaml'}${colors.reset}`);
      console.log(`\n${colors.yellow}Type ${colors.bold}RESET${colors.reset}${colors.yellow} to confirm, or press ${colors.bold}Escape${colors.reset}${colors.yellow} to cancel.${colors.reset}\n`);

      const ask = async (): Promise<string> =>
        await new Promise((resolve) => {
          // Enable keypress events
          readline.emitKeypressEvents(process.stdin);
          if (process.stdin.isTTY) process.stdin.setRawMode(true);

          const onKeypress = (ch: string, key: { name: string }) => {
            if (key && key.name === 'escape') {
              cleanup();
              process.stdout.write('\n');
              resolve('__ESCAPE__');
            }
          };

          const cleanup = () => {
            process.stdin.removeListener('keypress', onKeypress);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
          };

          process.stdin.on('keypress', onKeypress);

          rl.question(`${colors.cyan}>>${colors.reset} `, (answer) => {
            cleanup();
            resolve(answer.trim());
          });
        });

      let confirmed = await ask();
      if (confirmed !== 'RESET') {
        console.log(`${colors.yellow}❌ Reset cancelled${colors.reset}\n`);
        rl.prompt();
        return;
      }

      console.log(`\n${colors.yellow}🔄 Resetting agents...${colors.reset}\n`);
      try {
        const body: any = {};
        if (actionArg) body.configPath = actionArg;

        const resp = await managerFetch('/agents/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        const data = await resp.json().catch(() => ({ error: resp.statusText })) as {
          ok?: boolean;
          error?: string;
          message?: string;
          results?: Array<{ name: string; status: string; error?: string }>;
        };

        if (!resp.ok || !data.ok) {
          console.log(`${colors.red}❌ Reset failed: ${data.error || 'Unknown error'}${colors.reset}\n`);
        } else {
          console.log(`${colors.green}✅ ${data.message}${colors.reset}`);
          if (data.results) {
            for (const r of data.results) {
              if (r.status === 'reset') {
                console.log(`   ${colors.green}✓${colors.reset} ${r.name}`);
              } else {
                console.log(`   ${colors.red}✗${colors.reset} ${r.name}: ${r.error || 'failed'}`);
              }
            }
          }
          console.log('');
        }
      } catch (error: any) {
        console.log(`${colors.red}❌ Reset error: ${error.message}${colors.reset}\n`);
      }
      rl.prompt();
      return;
    }

    // Get all agents
    const listResp = await managerFetch('/agents');
    if (!listResp.ok) {
      const text = await listResp.text().catch(() => listResp.statusText);
      console.log(`\n${colors.red}❌ Failed to list agents: ${text}${colors.reset}\n`);
      rl.prompt();
      return;
    }

    const listData: any = await listResp.json();
    const agents: any[] = (listData.agents || []).filter((a: any) => a.type === 'claude');

    if (agents.length === 0) {
      console.log(`\n${colors.yellow}⚠️  No agents to ${action}${colors.reset}\n`);
      rl.prompt();
      return;
    }

    // Probe: forward to /remote so the manager runs the end-to-end dispatch check
    if (action === 'probe') {
      try {
        const resp = await managerFetch('/remote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: '/agents probe' })
        });
        const data = await resp.json() as any;
        if (!resp.ok || !data.ok) {
          console.log(`\n${colors.red}❌ Probe failed: ${data.error || resp.statusText}${colors.reset}\n`);
        } else {
          const r = data.result || {};
          console.log(`\n${colors.cyan}🔍 Probed ${r.probed} agent(s): ${colors.green}${r.passed} passed${colors.reset}, ${colors.red}${r.failed} failed${colors.reset}`);
          for (const row of r.results || []) {
            const mark = row.status === 'ok' ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
            const detail = row.status === 'ok' ? `${row.duration_ms}ms` : `${row.error} (${row.duration_ms}ms)`;
            console.log(`  ${mark} ${row.name}: ${detail}`);
          }
          console.log('');
        }
      } catch (err: any) {
        console.log(`\n${colors.red}❌ Probe error: ${err.message}${colors.reset}\n`);
      }
      rl.prompt();
      return;
    }

    // Rebuild: restart all local agent processes with latest code
    if (action === 'rebuild') {
      const forceRegen = parts.slice(1).includes('--regenerate-config');
      console.log(`\n${colors.yellow}🔨 Rebuilding ${agents.length} agent(s)...${colors.reset}\n`);

      await regenerateTeamConfigIfMissing(activeTeam, forceRegen);

      let success = 0;
      let failed = 0;
      let skipped = 0;

      for (const agent of agents) {
        try {
          const agentType = getAgentType(agent);

          if (agentType === 'local') {
            // Stop existing process
            if (agent.port) {
              try {
                const pids = execFileSync('lsof', ['-ti', `:${agent.port}`], { encoding: 'utf8' }).trim();
                for (const pid of pids.split('\n').filter(Boolean)) {
                  try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
                }
                await new Promise(resolve => setTimeout(resolve, 500));
              } catch {
                // No process on port
              }
            }

            // Start fresh process
            const result = await startLocalAgentProcess(agent);
            if (result.success) {
              console.log(`${colors.green}✅ ${agent.name}${colors.reset} (PID: ${result.pid})`);
              success++;
            } else {
              console.log(`${colors.red}❌ ${agent.name}: ${result.error}${colors.reset}`);
              failed++;
            }
          } else if (agentType === 'virtual' || agentType === 'interactive') {
            console.log(`${colors.gray}⏭️  ${agent.name} (${agentType} - skip)${colors.reset}`);
            skipped++;
          } else {
            console.log(`${colors.yellow}⚠️  ${agent.name}: unknown type${colors.reset}`);
            skipped++;
          }
        } catch (e: any) {
          console.log(`${colors.red}❌ ${agent.name}: ${e?.message || String(e)}${colors.reset}`);
          failed++;
        }
      }

      console.log(`\n${colors.gray}Done: ${success} rebuilt, ${failed} failed, ${skipped} skipped${colors.reset}\n`);
      rl.prompt();
      return;
    }

    console.log(`\n${colors.gray}${action === 'start' ? '🚀' : action === 'stop' ? '🛑' : '🔧'} ${action.charAt(0).toUpperCase() + action.slice(1)}ing ${agents.length} agent(s)...${colors.reset}\n`);

    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (const agent of agents) {
      try {
        const agentType = getAgentType(agent);

        if (action === 'start') {
          // Handle start based on agent type
          if (agentType === 'virtual' || agentType === 'interactive') {
            // Skip virtual and interactive agents
            skipped++;
            continue;
          } else if (agentType === 'local') {
            // Start local agent process
            const result = await startLocalAgentProcess(agent);
            if (result.success) {
              console.log(`${colors.green}✅ ${agent.name}${colors.reset} ${colors.gray}(local, PID: ${result.pid})${colors.reset}`);
              success++;
            } else {
              console.log(`${colors.red}❌ ${agent.name}: ${result.error}${colors.reset}`);
              failed++;
            }
            continue;
          }
        }

        // Handle stop for local agents
        if (action === 'stop') {
          if (agentType === 'virtual' || agentType === 'interactive') {
            skipped++;
            continue;
          } else if (agentType === 'local' && agent.port) {
            try {
              const lsofOutput = execFileSync('lsof', ['-ti', `:${agent.port}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
              if (lsofOutput) {
                const pids = lsofOutput.split('\n').filter(Boolean);
                for (const pid of pids) {
                  try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
                }
                console.log(`${colors.green}✅ ${agent.name}${colors.reset} ${colors.gray}(stopped PID ${pids.join(', ')})${colors.reset}`);
                success++;
              } else {
                console.log(`${colors.yellow}⚠️  ${agent.name}: not running${colors.reset}`);
                skipped++;
              }
            } catch (err: any) {
              if (err.status === 1) {
                console.log(`${colors.yellow}⚠️  ${agent.name}: not running${colors.reset}`);
                skipped++;
              } else {
                throw err;
              }
            }
            continue;
          }
        }

        // Fallback for unknown agent types
        console.log(`${colors.yellow}⚠️  ${agent.name}: unknown type (${agentType})${colors.reset}`);
        skipped++;
      } catch (e: any) {
        console.log(`${colors.red}❌ ${agent.name}: ${e?.message || String(e)}${colors.reset}`);
        failed++;
      }
    }

    const skippedMsg = skipped > 0 ? `, ${skipped} skipped` : '';
    console.log(`\n${colors.gray}Done: ${success} succeeded, ${failed} failed${skippedMsg}${colors.reset}\n`);
    rl.prompt();
    return;
  }

  if (input === '/help' || input === '/h') {
    printHelp('Available Commands:');
    rl.prompt();
    return;
  }

  if (input.startsWith('/respond ')) {
    const rest = input.substring('/respond '.length).trim();
    if (!rest) {
      console.log(`\n${colors.red}❌ Usage: /respond <number|query_id> [response]${colors.reset}`);
      console.log(`${colors.gray}Example: /respond 1${colors.reset}`);
      console.log(`${colors.gray}Example: /respond 1 Yes, I handled it${colors.reset}`);
      console.log(`${colors.gray}Example: /respond query_123 Yes, I handled it${colors.reset}\n`);
      rl.prompt();
      return;
    }

    try {
      const pending = await fetchPendingManagerInbox();
      const parts = rest.split(' ');
      const identifier = parts[0];
      const responseText = parts.slice(1).join(' ').trim();

      let query: ManagerInboxItem | undefined;
      const numericIdentifier = parseInt(identifier, 10);
      if (!Number.isNaN(numericIdentifier) && numericIdentifier > 0 && numericIdentifier <= pending.length) {
        query = pending[numericIdentifier - 1];
      } else {
        query = pending.find((item) => item.query_id === identifier);
      }

      if (!query) {
        console.log(`\n${colors.red}❌ Query "${identifier}" not found in the pending manager inbox${colors.reset}\n`);
        rl.prompt();
        return;
      }

      if (responseText) {
        await respondToManagerInboxQuery(query.query_id, responseText, query.session_id);
        console.log(`\n${colors.green}✅ Response sent!${colors.reset}\n`);
        lastPendingCount = 0;
      } else {
        await promptForManagerInboxResponse(query);
      }
    } catch (error: any) {
      console.log(`\n${colors.red}❌ ${error?.message || error}${colors.reset}\n`);
    }

    rl.prompt();
    return;
  }

  // Legacy /cluster commands removed - use /team rebuild instead

  if (input.startsWith('/agent ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }

    const rest = input.substring('/agent '.length).trim();
    const parts = rest.split(/\s+/).filter(Boolean);
    const target = parts[0];
    const action = (parts[1] || '').toLowerCase();
    const arg = parts.slice(2).join(' ');

    if (!target || !action) {
      console.log(`\n${colors.red}❌ Usage: /agent <name> <start|stop|rebuild [--regenerate-config]|logs [-f]|save|heartbeat|wallet provision|probe>${colors.reset}`);
      console.log(`${colors.gray}   logs: show recent logs (default 200 lines)${colors.reset}`);
      console.log(`${colors.gray}   logs -f: follow logs in real-time (Ctrl+C to stop)${colors.reset}`);
      console.log(`${colors.gray}   logs 50: show last 50 lines${colors.reset}`);
      console.log(`${colors.gray}   wallet provision: create an OWS wallet for this agent (opt-in, requires the ows CLI)${colors.reset}`);
      console.log(`${colors.gray}   probe: send a one-shot dispatch ("reply with OK") and report pass/fail${colors.reset}\n`);
      rl.prompt();
      return;
    }

    try {
      if (action === 'start') {
        // First check agent type
        const agentResp = await managerFetch(`/agents/by-name/${encodeURIComponent(target)}`);
        if (!agentResp.ok) throw new Error(`Agent "${target}" not found`);
        const agentData = await agentResp.json() as any;
        const agentType = getAgentType(agentData);

        if (agentType === 'virtual') {
          console.log(`\n${colors.yellow}⚠️  "${target}" is a virtual agent (external) - nothing to start${colors.reset}\n`);
        } else if (agentType === 'interactive') {
          console.log(`\n${colors.yellow}⚠️  "${target}" is an interactive agent - nothing to start${colors.reset}\n`);
        } else if (agentType === 'local') {
          // Start local agent process
          console.log(`\n${colors.gray}🏠 Starting local agent "${target}"...${colors.reset}`);
          const result = await startLocalAgentProcess(agentData);
          if (result.success) {
            console.log(`${colors.green}✅ Started${colors.reset} ${target}`);
            console.log(`${colors.gray}   PID: ${result.pid}${colors.reset}`);
            console.log(`${colors.gray}   Log: ${result.logFile}${colors.reset}\n`);
          } else {
            throw new Error(result.error || 'Failed to start local agent');
          }
        } else {
          console.log(`\n${colors.yellow}⚠️  "${target}" has unknown type (${agentType})${colors.reset}\n`);
        }
      } else if (action === 'stop') {
        // Check if this is a local agent
        const agentResp = await managerFetch(`/agents/by-name/${encodeURIComponent(target)}`);
        if (!agentResp.ok) throw new Error(`Agent "${target}" not found`);
        const agentData = await agentResp.json() as any;
        const agentType = getAgentType(agentData);

        if (agentType === 'local') {
          // Local agent - kill the process by port
          const port = agentData.port;
          if (!port) throw new Error('Agent has no port assigned');

          try {
            const lsofOutput = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            if (lsofOutput) {
              const pids = lsofOutput.split('\n').filter(Boolean);
              for (const pid of pids) {
                try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
              }
              console.log(`\n${colors.green}✅ Stopped${colors.reset} ${target} (killed PID ${pids.join(', ')})\n`);
            } else {
              console.log(`\n${colors.yellow}⚠️  No process found on port ${port}${colors.reset}\n`);
            }
          } catch (err: any) {
            if (err.status === 1) {
              // No process on port
              console.log(`\n${colors.yellow}⚠️  Agent "${target}" is not running (no process on port ${port})${colors.reset}\n`);
            } else {
              throw err;
            }
          }
        } else if (agentType === 'virtual' || agentType === 'interactive') {
          console.log(`\n${colors.yellow}⚠️  "${target}" is a ${agentType} agent - nothing to stop${colors.reset}\n`);
        } else {
          console.log(`\n${colors.yellow}⚠️  "${target}" has unknown type (${agentType})${colors.reset}\n`);
        }
      } else if (action === 'rebuild') {
        const forceRegen = parts.slice(2).includes('--regenerate-config');
        // Check if this is a local agent
        const agentResp = await managerFetch(`/agents/by-name/${encodeURIComponent(target)}`);
        if (!agentResp.ok) throw new Error(`Agent "${target}" not found`);
        const agentData = await agentResp.json() as any;
        const agentType = getAgentType(agentData);

        if (agentType === 'local') {
          // Local agent rebuild - just restart the process with correct ID
          console.log(`\n${colors.yellow}🔨 Rebuild local agent: ${target}${colors.reset}\n`);
          console.log(`${colors.gray}This will restart the local agent process with the latest code.${colors.reset}\n`);

          await regenerateTeamConfigIfMissing(activeTeam, forceRegen);

          const result = await startLocalAgentProcess(agentData);
          if (result.success) {
            console.log(`${colors.green}✅ Rebuilt${colors.reset} ${target}`);
            console.log(`${colors.gray}   PID: ${result.pid}${colors.reset}`);
            console.log(`${colors.gray}   Log: ${result.logFile}${colors.reset}\n`);
          } else {
            throw new Error(result.error || 'Failed to rebuild local agent');
          }
          rl.prompt();
          return;
        }

        // Non-local agent rebuild - restart via local agent process
        console.log(`\n${colors.yellow}🔨 Rebuild agent: ${target}${colors.reset}\n`);
        console.log(`${colors.gray}This will restart the agent process with the latest code.${colors.reset}\n`);

        await regenerateTeamConfigIfMissing(activeTeam, forceRegen);

        const result = await startLocalAgentProcess(agentData);
        if (result.success) {
          console.log(`${colors.green}✅ Rebuilt${colors.reset} ${target}`);
          console.log(`${colors.gray}   PID: ${result.pid}${colors.reset}`);
          console.log(`${colors.gray}   Log: ${result.logFile}${colors.reset}\n`);
        } else {
          throw new Error(result.error || 'Failed to rebuild agent');
        }
      } else if (action === 'logs') {
        // Parse args: could be "-f", "--follow", a number, or "-f 50"
        const argParts = arg.split(/\s+/).filter(Boolean);
        const followFlag = argParts.includes('-f') || argParts.includes('--follow');
        const numArg = argParts.find(a => /^\d+$/.test(a));

        // Check if this is a local agent
        const agentResp = await managerFetch(`/agents/by-name/${encodeURIComponent(target)}`);
        if (agentResp.ok) {
          const agentData = await agentResp.json() as any;
          const isLocal = agentData.metadata?.local === true;

          if (isLocal) {
            // Local agent - find and display log file
            const logsDir = path.join(process.env.ID_WORKSPACE_DIR || process.env.WORKSPACE_DIR || '/tmp/id-agents', 'logs');

            // Try exact name first, then base name (without tokenId suffix like .107)
            let logFiles = fs.readdirSync(logsDir)
              .filter(f => f.startsWith(`local-${target}-`) && f.endsWith('.log'))
              .sort()
              .reverse(); // Most recent first

            // If no logs found and name has a dot (e.g., ENS domain), try base name
            if (logFiles.length === 0 && target.includes('.')) {
              const baseName = target.split('.')[0];
              logFiles = fs.readdirSync(logsDir)
                .filter(f => f.startsWith(`local-${baseName}-`) && f.endsWith('.log'))
                .sort()
                .reverse();
            }

            if (logFiles.length === 0) {
              console.log(`\n${colors.yellow}⚠️  No log files found for local agent "${target}"${colors.reset}\n`);
            } else {
              const logFile = path.join(logsDir, logFiles[0]);
              if (followFlag) {
                // Use tail -f for following
                console.log(`\n${colors.gray}--- following logs: ${target} (local) ---${colors.reset}`);
                console.log(`${colors.gray}File: ${logFile}${colors.reset}`);
                console.log(`${colors.yellow}Press Ctrl+C to stop${colors.reset}\n`);
                const tailProc = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
                tailProc.on('close', () => {
                  console.log(`\n${colors.gray}--- stopped following logs ---${colors.reset}\n`);
                  rl.prompt();
                });
                return;
              }
              const tail = parseInt(numArg || '100');
              const content = fs.readFileSync(logFile, 'utf-8');
              const lines = content.split('\n');
              const tailLines = lines.slice(-tail).join('\n');
              console.log(`\n${colors.gray}--- logs: ${target} (local) ---${colors.reset}`);
              console.log(`${colors.gray}File: ${logFile}${colors.reset}\n`);
              console.log(tailLines);
            }
            rl.prompt();
            return;
          }
        }

        // Non-follow mode - use existing endpoint
        const tail = parseInt(numArg || '200');
        const q = Number.isFinite(tail) ? `?tail=${tail}` : '';
        const resp = await managerFetch(`/agents/by-name/${encodeURIComponent(target)}/project/logs${q}`);
        const text = await resp.text();
        if (!resp.ok) throw new Error(text || resp.statusText);
        console.log(`\n${colors.gray}--- logs: ${target} ---${colors.reset}\n${text}\n`);
      } else if (action === 'save') {
        await saveAgentNewsFeed(target);
      } else if (action === 'heartbeat') {
        // Send heartbeat and reset timer
        const resp = await managerFetch(`/remote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: `/agent ${target} heartbeat` })
        });
        const data = await resp.json() as any;
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || 'Failed to send heartbeat');
        }
        console.log(`\n${colors.green}♥ Heartbeat sent to ${target}${colors.reset}`);
        if (data.result?.intervalSeconds) {
          console.log(`${colors.gray}   Timer reset: next heartbeat in ${data.result.intervalSeconds}s${colors.reset}\n`);
        }
      } else if (action === 'probe') {
        // /agent <name> probe — single-agent end-to-end dispatch probe.
        const resp = await managerFetch(`/remote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: `/agent ${target} probe` })
        });
        const data = await resp.json() as any;
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || 'Probe failed');
        }
        const row = (data.result?.results || [])[0];
        if (!row) {
          console.log(`\n${colors.yellow}⚠️  Probe returned no result${colors.reset}\n`);
        } else if (row.status === 'ok') {
          console.log(`\n${colors.green}✓ ${row.name}: passed (${row.duration_ms}ms)${colors.reset}\n`);
        } else {
          console.log(`\n${colors.red}✗ ${row.name}: ${row.error} (${row.duration_ms}ms)${colors.reset}\n`);
        }
      } else if (action === 'wallet') {
        // /agent <name> wallet provision — on-demand OWS wallet provisioning.
        const subArg = (parts[2] || '').toLowerCase();
        if (subArg !== 'provision') {
          console.log(`\n${colors.red}❌ Usage: /agent ${target} wallet provision${colors.reset}\n`);
        } else {
          const resp = await managerFetch(`/remote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: `/agent ${target} wallet provision` })
          });
          const data = await resp.json() as any;
          if (!resp.ok || !data.ok) {
            throw new Error(data.error || 'Failed to provision wallet');
          }
          const r = data.result || {};
          if (r.status === 'already-provisioned') {
            console.log(`\n${colors.yellow}ℹ️  ${target} already has wallet ${r.ows_wallet}${colors.reset}\n`);
          } else {
            console.log(`\n${colors.green}✅ Provisioned wallet for ${target}${colors.reset}`);
            console.log(`${colors.gray}   Name: ${r.ows_wallet}${colors.reset}`);
            if (r.ows_address) console.log(`${colors.gray}   Address: ${r.ows_address}${colors.reset}`);
            console.log('');
          }
        }
      } else {
        console.log(`\n${colors.red}❌ Unknown action: ${action}${colors.reset}\n`);
      }
    } catch (e: any) {
      console.log(`\n${colors.red}❌ Error: ${e?.message || String(e)}${colors.reset}\n`);
    }

    rl.prompt();
    return;
  }

  // /manager - control the manager connection
  if (input === '/manager' || input === '/manager help') {
    console.log(`\n${colors.cyan}🎛️  Manager Controls${colors.reset}`);
    console.log(`${colors.gray}Control the agent manager connection.${colors.reset}\n`);
    console.log(`${colors.cyan}Commands:${colors.reset}`);
    console.log(`  /manager status   - Check manager status and connection`);
    console.log(`  /manager reload   - Reconnect to manager (WebSocket)`);
    console.log(`  /manager health   - Check manager health endpoint\n`);
    rl.prompt();
    return;
  }

  if (input.startsWith('/manager ')) {
    const action = input.substring(9).trim().toLowerCase();

    switch (action) {
      case 'status': {
        const wsStatus = managerWs && managerWs.readyState === WebSocket.OPEN ? 'connected' : 'disconnected';
        console.log(`\n${colors.cyan}🎛️  Manager Status${colors.reset}`);
        console.log(`  Team: ${activeTeam}`);
        console.log(`  URL: ${MANAGER_URL}`);
        console.log(`  WebSocket: ${wsStatus === 'connected' ? colors.green : colors.yellow}${wsStatus}${colors.reset}`);
        console.log('');
        rl.prompt();
        return;
      }

      case 'reload': {
        console.log(`${colors.gray}Reconnecting to manager...${colors.reset}`);
        stopManagerConnection();
        useWebSocket = true;  // Reset to try WebSocket again
        startManagerConnection();
        console.log(`${colors.green}✓ Reconnection initiated${colors.reset}\n`);
        rl.prompt();
        return;
      }

      case 'health': {
        (async () => {
          try {
            const response = await managerFetch('/health');
            if (response.ok) {
              const data: any = await response.json();
              console.log(`\n${colors.green}✓ Manager healthy${colors.reset}`);
              console.log(`  Team: ${data.team}`);
              console.log(`  Agents: ${data.agents}`);
              console.log(`  Timestamp: ${new Date(data.timestamp).toISOString()}\n`);
            } else {
              console.log(`${colors.red}✗ Manager unhealthy: ${response.status}${colors.reset}\n`);
            }
          } catch (err: any) {
            console.log(`${colors.red}✗ Manager unreachable: ${err.message}${colors.reset}\n`);
          }
          rl.prompt();
        })();
        return;
      }

      default:
        console.log(`${colors.yellow}Unknown manager command: ${action}${colors.reset}`);
        console.log(`${colors.gray}Use /manager for available commands${colors.reset}\n`);
        rl.prompt();
        return;
    }
  }

  if (input === '/deploy') {
    // List available configs
    const configsDir = path.resolve(process.cwd(), 'configs');
    if (!fs.existsSync(configsDir)) {
      console.log(`\n${colors.yellow}No configs/ directory found.${colors.reset}\n`);
      rl.prompt();
      return;
    }
    const files = fs.readdirSync(configsDir).filter((f: string) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.endsWith('.example'));
    if (files.length === 0) {
      console.log(`\n${colors.yellow}No config files found in configs/${colors.reset}\n`);
    } else {
      console.log(`\n${colors.bold}Available configs:${colors.reset}`);
      for (const f of files) {
        const name = f.replace(/\.(yaml|yml)$/, '');
        console.log(`  ${colors.cyan}/deploy ${name}${colors.reset}`);
      }
      console.log('');
    }
    rl.prompt();
    return;
  }

  if (input.startsWith('/deploy ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }
    const parts = input.substring('/deploy '.length).trim().split(/\s+/);
    let filePath = parts[0];
    const deployArgs = parts.slice(1); // Remaining args are parameters
    const dryRun = deployArgs.includes('--dry-run');
    const filteredDeployArgs = deployArgs.filter(arg => arg !== '--dry-run');

    if (!filePath) {
      console.log(`\n${colors.red}❌ Usage: /deploy <config> [param1] [param2] or [name=value]${colors.reset}`);
      console.log(`${colors.gray}Example: /deploy designer designer1${colors.reset}`);
      console.log(`${colors.gray}Example: /deploy designer name=designer1 model=sonnet${colors.reset}\n`);
      console.log(`${colors.gray}Shorthand: "designer" resolves to "configs/designer.yaml"${colors.reset}\n`);
      console.log(`${colors.gray}Config file with parameters:${colors.reset}`);
      console.log(`  version: "1"`);
      console.log(`  parameters:`);
      console.log(`    - name: name`);
      console.log(`      default: designer`);
      console.log(`      description: Name for this agent`);
      console.log(`  defaults:`);
      console.log(`    model: claude-haiku-4-5-20251001`);
      console.log(`  agents:`);
      console.log(`    - name: \${name}`);
      console.log(`      description: A designer agent\n`);
      rl.prompt();
      return;
    }

    // Resolve shorthand: "designer" -> "configs/designer.yaml"
    let originalArg = filePath;
    if (!filePath.includes('/') && !filePath.includes('\\')) {
      // No path separator - assume configs/ directory
      if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) {
        filePath = `configs/${filePath}.yaml`;
      } else {
        filePath = `configs/${filePath}`;
      }
    } else if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) {
      // Has path but no extension
      filePath = `${filePath}.yaml`;
    }

    // If config doesn't exist, fall back to default.yaml with the arg as the name
    const fs = await import('fs');
    if (!fs.existsSync(filePath)) {
      const defaultPath = 'configs/default.yaml';
      if (fs.existsSync(defaultPath)) {
        console.log(`${colors.gray}Config not found: ${filePath}, using default.yaml with name=${originalArg}${colors.reset}`);
        filePath = defaultPath;
        // Prepend name=<arg> to deployArgs if it doesn't already have a name= param
        if (!filteredDeployArgs.some(a => a.startsWith('name='))) {
          filteredDeployArgs.unshift(originalArg);
        }
      }
    }

    if (dryRun) {
      await dryRunDeploy(filePath, filteredDeployArgs);
    } else {
      await deployFromConfig(filePath, filteredDeployArgs);
    }
    rl.prompt();
    return;
  }

  // §9 (D2): /sync is removed. Matched WITHOUT the trailing space so a bare
  // `/sync` is answered too — the old handler only matched '/sync ' and left
  // the bare form to fall through as an unknown command.
  if (input === '/sync' || input.startsWith('/sync ')) {
    console.log(`\n${colors.yellow}${SYNC_REMOVED_MESSAGE}${colors.reset}\n`);
    rl.prompt();
    return;
  }

  if (input === '/status' || input === '/status -l' || input === '/status --long') {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }
    const longFormat = input === '/status -l' || input === '/status --long';
    await checkAgentStatus(longFormat);
    rl.prompt();
    return;
  }

  if (input === '/logs' || input.startsWith('/logs ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }
    try {
      const parts = input.split(/\s+/);
      const limit = parseInt(parts[1]) || 20;
      const response = await managerFetch(`/logs?limit=${limit}`);
      if (!response.ok) {
        console.log(`${colors.red}Failed to fetch logs: ${response.status}${colors.reset}`);
        rl.prompt();
        return;
      }
      const data: any = await response.json();
      const logs = data.logs || [];
      if (logs.length === 0) {
        console.log(`${colors.gray}No log entries${colors.reset}`);
      } else {
        console.log(`${colors.gray}── Manager Logs (${logs.length} of ${data.total}) ──${colors.reset}`);
        for (const entry of logs) {
          const time = new Date(entry.ts).toLocaleTimeString();
          console.log(`${colors.gray}${time}  ${entry.msg}${colors.reset}`);
        }
      }
    } catch (err: any) {
      console.log(`${colors.red}Error fetching logs: ${err.message}${colors.reset}`);
    }
    rl.prompt();
    return;
  }

  if (input.startsWith('/heartbeats') || input.startsWith('/heartbeat')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }

    try {
      const response = await managerFetch('/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: input })
      });

      const result: any = await response.json();

      if (!result.ok) {
        console.log(`\n${colors.red}❌ ${result.error}${colors.reset}\n`);
      } else {
        const data = result.result;
        if (data.message) {
          console.log(`\n${colors.green}✅ ${data.message}${colors.reset}\n`);
        } else if (data.agent) {
          // Single agent response from /heartbeat <agent>
          const a = data.agent;
          const statusIcon = a.status === 'running' ? '🟢' : '⚪';
          const heartbeatIcon = a.heartbeatActive ? '♥' : '💤';
          const intervalInfo = `interval: ${a.intervalSeconds}s`;
          const nextInfo = a.nextIn ? ` | next: ${a.nextIn}` : '';
          console.log(`\n${colors.cyan}♥ Heartbeat: ${a.name}${colors.reset}`);
          console.log(`${colors.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
          console.log(`   ${statusIcon} ${a.name} (${a.status}) ${heartbeatIcon} ${intervalInfo}${nextInfo}\n`);
        } else if (data.agents) {
          // Multiple agents from /heartbeats
          console.log(`\n${colors.cyan}♥ Heartbeat System${colors.reset}`);
          console.log(`${colors.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
          console.log(`\n${colors.cyan}   Agents with heartbeat:${colors.reset}`);
          if (data.agents.length > 0) {
            for (const a of data.agents) {
              const statusIcon = a.status === 'running' ? '🟢' : '⚪';
              const heartbeatIcon = a.heartbeatActive ? '♥' : '💤';
              const intervalInfo = `interval: ${a.intervalSeconds}s`;
              const nextInfo = a.nextIn ? ` | next: ${a.nextIn}` : '';
              console.log(`   ${statusIcon} ${a.name} (${a.status}) ${heartbeatIcon} ${intervalInfo}${nextInfo}`);
            }
          } else {
            console.log(`   ${colors.gray}No agents with heartbeat configured${colors.reset}`);
          }
          console.log('');
        }
      }
    } catch (error: any) {
      console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
    }

    rl.prompt();
    return;
  }

  if (input.startsWith('/delete ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }
    const target = input.substring(8).trim();
    if (!target) {
      console.log(`\n${colors.red}❌ Usage: /delete <agent-name|agent-id> | /delete * | /delete --team <name>${colors.reset}\n`);
      rl.prompt();
      return;
    }

    // Bulk delete: /delete * or /delete --team <name>
    if (target === '*' || target.startsWith('--team')) {
      const isBulk = target === '*';
      const teamTarget = isBulk ? undefined : target.replace('--team', '').trim();
      if (!isBulk && !teamTarget) {
        console.log(`\n${colors.red}❌ Usage: /delete --team <team-name>${colors.reset}\n`);
        rl.prompt();
        return;
      }

      // Preview: ask the manager how many agents exist
      try {
        const previewResp = await managerFetch('/agents?all=true');
        if (previewResp.ok) {
          const previewData: any = await previewResp.json();
          const count = previewData.agents?.length || 0;
          const label = isBulk ? 'current team' : `team "${teamTarget}"`;
          if (count === 0) {
            console.log(`\n${colors.yellow}No agents to delete in ${label}${colors.reset}\n`);
            rl.prompt();
            return;
          }
          const names = (previewData.agents || []).map((a: any) => a.name).join(', ');
          const confirmed = await confirmAction(
            rl,
            `⚠️  This will delete all ${count} agents in ${label}: ${names}\n   Working directories will NOT be deleted.`,
            'yes',
            { cancelMessage: 'Delete cancelled.' }
          );
          if (!confirmed) {
            rl.prompt();
            return;
          }
        }
      } catch {
        // If preview fails, still proceed with confirmation
        const confirmed = await confirmAction(
          rl,
          `⚠️  This will delete all agents in ${isBulk ? 'the current team' : `team "${teamTarget}"`}.`,
          'yes',
          { cancelMessage: 'Delete cancelled.' }
        );
        if (!confirmed) {
          rl.prompt();
          return;
        }
      }

      // Execute bulk delete via remote command
      const cmd = isBulk ? '/delete *' : `/delete --team ${teamTarget}`;
      try {
        const resp = await managerFetch('/remote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.ID_REMOTE_API_KEY || '' },
          body: JSON.stringify({ command: cmd })
        });
        const data: any = await resp.json();
        if (data.ok) {
          console.log(`\n${colors.green}✅ ${data.result?.message || 'Deleted'}${colors.reset}\n`);
        } else {
          console.log(`\n${colors.red}❌ ${data.error || 'Failed'}${colors.reset}\n`);
        }
      } catch (error: any) {
        console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
      }
      rl.prompt();
      return;
    }

    // Single agent delete
    console.log(`\n${colors.yellow}⚠️  WARNING:${colors.reset} This will permanently delete agent ${colors.bold}${target}${colors.reset}`);
    console.log(`   - Agent process will be stopped`);
    console.log(`   - Agent record will be removed from database`);
    console.log(`   - ${colors.red}Auto-generated working directory will be deleted${colors.reset}`);
    console.log(`${colors.gray}   Type ${colors.bold}DELETE${colors.reset}${colors.gray} to confirm, or anything else to cancel.${colors.reset}\n`);

    const askConfirm = async (): Promise<string> =>
      await new Promise((resolve) => {
        rl.question(`${colors.cyan}>>${colors.reset} `, (answer) => resolve(answer.trim()));
      });

    let confirmed = await askConfirm();
    if (confirmed !== 'DELETE') {
      console.log(`${colors.yellow}⚠️  You typed "${confirmed}". Please type ${colors.bold}DELETE${colors.reset}${colors.yellow} to confirm.${colors.reset}`);
      confirmed = await askConfirm();
    }

    if (confirmed !== 'DELETE') {
      console.log(`\n${colors.yellow}❌ Delete cancelled${colors.reset}\n`);
      rl.prompt();
      return;
    }

    await deleteAgent(target);
    rl.prompt();
    return;
  }

  // /wallet <agent> [chain] — show agent's OWS wallet address
  if (input.startsWith('/wallet ')) {
    const parts = input.substring('/wallet '.length).trim().split(/\s+/);
    const agentName = parts[0];
    const chain = parts[1] || 'all';

    if (!agentName) {
      console.log(`\n${colors.red}❌ Usage: /wallet <agent> [chain]${colors.reset}`);
      console.log(`${colors.gray}  Examples: /wallet contracts eip155:8453${colors.reset}`);
      console.log(`${colors.gray}           /wallet contracts solana${colors.reset}`);
      console.log(`${colors.gray}           /wallet contracts all${colors.reset}\n`);
      rl.prompt();
      return;
    }

    try {
      const agent = await resolveAgent(agentName);
      if (!agent) { rl.prompt(); return; }

      const walletName = (agent as any).metadata?.ows_wallet;
      if (!walletName) {
        console.log(`\n${colors.yellow}⚠️  Agent "${agentName}" has no OWS wallet.${colors.reset}`);
        console.log(`${colors.gray}  Provision one with: /agent ${agentName} wallet provision${colors.reset}\n`);
        rl.prompt();
        return;
      }

      const { execFileSync } = await import('child_process');
      const output = execFileSync('ows', ['wallet', 'list'], { encoding: 'utf8' });
      const lines = output.split('\n');
      let inWallet = false;
      let found = false;
      console.log(`\n${colors.bold}🔑 ${walletName}${colors.reset}`);
      for (const line of lines) {
        if (line.includes('Name:') && line.includes(walletName)) { inWallet = true; continue; }
        if (inWallet && line.includes('Name:')) break;
        if (inWallet && line.includes('→')) {
          const trimmed = line.trim();
          if (chain === 'all' || trimmed.startsWith(chain)) {
            const match = trimmed.match(/(.+?)\s*→\s*(\S+)/);
            if (match) {
              console.log(`  ${colors.gray}${match[1].trim()}${colors.reset} → ${colors.bold}${match[2]}${colors.reset}`);
              found = true;
            }
          }
        }
      }
      if (!found) {
        console.log(`${colors.yellow}  Chain "${chain}" not found. Try: /wallet ${agentName} all${colors.reset}`);
      }
      console.log('');
    } catch (err: any) {
      if (err.message?.includes('ENOENT')) {
        console.log(`\n${colors.yellow}⚠️  OWS CLI not installed. Install with: npm install -g @open-wallet-standard/core${colors.reset}\n`);
      } else {
        console.log(`\n${colors.red}❌ Error: ${err.message}${colors.reset}\n`);
      }
    }
    rl.prompt();
    return;
  }

  // /output <agent> — list files in agent's output directory
  if (input.startsWith('/output ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }
    const agentName = input.substring(8).trim();
    if (!agentName) {
      console.log(`\n${colors.red}❌ Usage: /output <agent-name>${colors.reset}\n`);
      rl.prompt();
      return;
    }
    try {
      const resp = await managerFetch('/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.ID_REMOTE_API_KEY || '' },
        body: JSON.stringify({ command: `/output ${agentName}` })
      });
      const data = await resp.json() as any;
      if (!data.ok) {
        console.log(`\n${colors.red}❌ ${data.error || 'Failed'}${colors.reset}\n`);
      } else {
        const files = data.result?.files || [];
        if (files.length === 0) {
          console.log(`\n${colors.yellow}No output files for ${agentName}${colors.reset}\n`);
        } else {
          console.log(`\n${colors.bold}📁 Output files for ${agentName}:${colors.reset}`);
          for (const f of files) {
            const size = f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`;
            const date = new Date(f.mtime).toLocaleString();
            console.log(`  ${colors.cyan}${f.name}${colors.reset}  ${colors.gray}${size}  ${date}${colors.reset}`);
          }
          console.log('');
        }
      }
    } catch (error: any) {
      console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
    }
    rl.prompt();
    return;
  }

  // /artifact <agent> <path> — read a file from agent's output directory
  if (input.startsWith('/artifact ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }
    const parts = input.substring(10).trim().split(/\s+/);
    const agentName = parts[0];
    const filePath = parts.slice(1).join(' ');
    if (!agentName || !filePath) {
      console.log(`\n${colors.red}❌ Usage: /artifact <agent-name> <path>${colors.reset}\n`);
      rl.prompt();
      return;
    }
    try {
      const resp = await managerFetch('/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.ID_REMOTE_API_KEY || '' },
        body: JSON.stringify({ command: `/artifact ${agentName} ${filePath}` })
      });
      const data = await resp.json() as any;
      if (!data.ok) {
        console.log(`\n${colors.red}❌ ${data.error || 'Failed'}${colors.reset}\n`);
      } else {
        const size = data.result?.size < 1024 ? `${data.result.size}B` : `${(data.result.size / 1024).toFixed(1)}KB`;
        console.log(`\n${colors.bold}📄 ${data.result?.path}${colors.reset} ${colors.gray}(${size})${colors.reset}\n`);
        console.log(data.result?.content || '');
        console.log('');
      }
    } catch (error: any) {
      console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
    }
    rl.prompt();
    return;
  }

  if (input.startsWith('/update ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }
    const updateArgs = input.substring(8).trim();
    if (!updateArgs) {
      console.log(`\n${colors.red}❌ Usage: /update <agent> [--wallet <address>] [--name <newname>]${colors.reset}\n`);
      rl.prompt();
      return;
    }
    try {
      const resp = await managerFetch('/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: `/update ${updateArgs}` })
      });
      const data = await resp.json() as any;
      if (!resp.ok || !data.ok) {
        console.log(`\n${colors.red}❌ ${data.error || 'Update failed'}${colors.reset}\n`);
      } else {
        console.log(`\n${colors.green}✅ ${data.result?.message || 'Agent updated'}${colors.reset}\n`);
      }
    } catch (e: any) {
      console.log(`\n${colors.red}❌ Error: ${e?.message || String(e)}${colors.reset}\n`);
    }
    rl.prompt();
    return;
  }

  // /update <agent> [--wallet <addr>] [--name <newname>]
  if (input.startsWith('/update ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }
    const parts = input.substring('/update '.length).trim().split(/\s+/);
    const agentName = parts[0];
    if (!agentName) {
      console.log(`\n${colors.red}❌ Usage: /update <agent> [--wallet <addr>] [--name <newname>]${colors.reset}\n`);
      rl.prompt();
      return;
    }
    const updates: Record<string, string> = {};
    for (let i = 1; i < parts.length; i++) {
      if (parts[i] === '--wallet' && parts[i + 1]) { updates.wallet = parts[++i]; }
      else if (parts[i] === '--name' && parts[i + 1]) { updates.name = parts[++i]; }
    }
    if (Object.keys(updates).length === 0) {
      console.log(`\n${colors.yellow}No updates specified. Use --wallet <addr> or --name <newname>${colors.reset}\n`);
      rl.prompt();
      return;
    }
    try {
      const agent = await resolveAgent(agentName);
      if (!agent) { rl.prompt(); return; }
      const resp = await managerFetch(`/agents/${encodeURIComponent(agent.id)}/metadata`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (resp.ok) {
        console.log(`\n${colors.green}✓ Updated ${agentName}${colors.reset}`);
        for (const [k, v] of Object.entries(updates)) {
          console.log(`  ${colors.gray}${k}: ${v}${colors.reset}`);
        }
        console.log('');
      } else {
        const text = await resp.text();
        console.log(`\n${colors.red}❌ Update failed: ${text}${colors.reset}\n`);
      }
    } catch (err: any) {
      console.log(`\n${colors.red}❌ Error: ${err.message}${colors.reset}\n`);
    }
    rl.prompt();
    return;
  }


  if (input.startsWith('/ask ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }
    const parts = input.substring(5).trim().split(' ');
    const rawAgentName = parts[0]; // Keep raw for broadcast check
    const message = parts.slice(1).join(' ');

    // Check for broadcast wildcard BEFORE sanitizing (since * gets stripped)
    if (rawAgentName === '*' && message) {
      broadcastToAllAgents(message);
      setImmediate(() => rl.prompt());
      return;
    }

    const agentName = sanitizeAgentName(rawAgentName); // Strip trailing punctuation like commas

    if (!agentName || !message) {
      console.log(`\n${colors.red}❌ Usage: /ask <agent-name> <message>${colors.reset}`);
      console.log(`${colors.gray}Example: /ask helper What should I work on?${colors.reset}`);
      console.log(`${colors.gray}Example: /ask * Hello everyone!${colors.reset}\n`);
      rl.prompt();
      return;
    }

    if (agentName.toLowerCase() === 'manager') {
      console.log(`\n${colors.red}❌ manager is not a peer agent. Use this CLI directly, or POST to ${MANAGER_URL}/talk from another client.${colors.reset}\n`);
      rl.prompt();
      return;
    }

    lastAskedAgent = agentName;
    updatePrompt();
    askAgent(agentName, message, true); // Continue session (use /clear to start fresh)
    // Prompt immediately so user can continue typing, even if askAgent errors early (e.g. agent not found).
    setImmediate(() => rl.prompt());
    return;
  }

  // /hey - like /ask but maintains session continuity
  if (input.startsWith('/hey ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }
    const parts = input.substring(5).trim().split(' ');
    const rawAgentName = parts[0]; // Keep raw for broadcast check
    const message = parts.slice(1).join(' ');

    // Check for broadcast wildcard BEFORE sanitizing (since * gets stripped)
    if (rawAgentName === '*' && message) {
      broadcastToAllAgents(message);
      setImmediate(() => rl.prompt());
      return;
    }

    const agentName = sanitizeAgentName(rawAgentName); // Strip trailing punctuation like commas

    if (!agentName || !message) {
      console.log(`\n${colors.red}❌ Usage: /hey <agent-name> <message>${colors.reset}`);
      console.log(`${colors.gray}Like /ask but continues the session (agent remembers context).${colors.reset}`);
      console.log(`${colors.gray}Example: /hey coder1 now integrate that image${colors.reset}`);
      console.log(`${colors.gray}Example: /hey * Hello everyone!${colors.reset}\n`);
      rl.prompt();
      return;
    }

    if (agentName.toLowerCase() === 'manager') {
      console.log(`\n${colors.red}❌ manager is not a peer agent. Use this CLI directly, or POST to ${MANAGER_URL}/talk from another client.${colors.reset}\n`);
      rl.prompt();
      return;
    }

    lastAskedAgent = agentName;
    updatePrompt();
    askAgent(agentName, message, true); // Continue session
    setImmediate(() => rl.prompt());
    return;
  }

  // /clear - clear session for an agent (start fresh conversation)
  if (input.startsWith('/clear ') || input === '/clear') {
    const agentName = input.substring(7).trim();

    if (!agentName) {
      // Clear all sessions
      const count = agentSessions.size;
      agentSessions.clear();
      lastAskedAgent = null;
      updatePrompt();
      console.log(`\n${colors.green}✓ Cleared all sessions (${count} agent${count !== 1 ? 's' : ''})${colors.reset}`);
      console.log(`${colors.gray}Next /ask will start a fresh conversation.${colors.reset}\n`);
    } else {
      // Clear specific agent session
      const sanitized = sanitizeAgentName(agentName);
      if (agentSessions.has(sanitized)) {
        agentSessions.delete(sanitized);
        console.log(`\n${colors.green}✓ Cleared session for ${sanitized}${colors.reset}`);
        console.log(`${colors.gray}Next /hey to ${sanitized} will start a fresh conversation.${colors.reset}\n`);
      } else {
        console.log(`\n${colors.yellow}⚠️  No active session for ${sanitized}${colors.reset}\n`);
      }
    }
    rl.prompt();
    return;
  }

  if (input.startsWith('/news ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }
    const rest = input.substring(6).trim();

    // Archive old news to files
    if (rest.startsWith('archive')) {
      const daysArg = rest.substring(7).trim();
      const days = parseInt(daysArg) || 30;

      console.log(`\n${colors.yellow}📦 Archiving news older than ${days} days...${colors.reset}\n`);

      try {
        const response = await managerFetch(`/news/archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days })
        });

        if (!response.ok) {
          const err = await response.json() as { error?: string };
          throw new Error(err.error || 'Archive failed');
        }

        const result = await response.json() as { archived: number; file: string };

        if (result.archived === 0) {
          console.log(`${colors.gray}No news items older than ${days} days to archive.${colors.reset}\n`);
        } else {
          console.log(`${colors.green}✅ Archived ${result.archived} items${colors.reset}`);
          console.log(`${colors.gray}   File: ${result.file}${colors.reset}\n`);
        }
      } catch (err: any) {
        console.log(`${colors.red}❌ Error: ${err.message}${colors.reset}\n`);
      }

      rl.prompt();
      return;
    }

    // Check for "top" variant: /news top [-l] <agent>
    if (rest.startsWith('top ') || rest === 'top') {
      let topRest = rest.substring(4).trim();
      let long = false;

      // Check for -l or --long flag
      if (topRest.startsWith('-l ') || topRest.startsWith('--long ')) {
        long = true;
        topRest = topRest.replace(/^(-l|--long)\s+/, '');
      } else if (topRest.endsWith(' -l') || topRest.endsWith(' --long')) {
        long = true;
        topRest = topRest.replace(/\s+(-l|--long)$/, '');
      }

      const agentName = topRest.trim();
      if (!agentName) {
        console.log(`\n${colors.red}❌ Usage: /news top [-l] <agent-name>${colors.reset}`);
        console.log(`${colors.gray}Example: /news top pm${colors.reset}`);
        console.log(`${colors.gray}Example: /news top -l pm  (long format with message content)${colors.reset}\n`);
        rl.prompt();
        return;
      }
      await showAgentNewsTop(agentName, long);
      rl.prompt();
      return;
    }
    
    // Show manager's own news feed if no agent specified
    if (!rest) {
      await showMyNews();
      rl.prompt();
      return;
    }

    // Parse -l/--long flag: /news -l <agent> → redirect to /news top -l <agent>
    let newsRest = rest;
    let newsLong = false;
    if (newsRest.startsWith('-l ') || newsRest.startsWith('--long ')) {
      newsLong = true;
      newsRest = newsRest.replace(/^(-l|--long)\s+/, '');
    } else if (newsRest.endsWith(' -l') || newsRest.endsWith(' --long')) {
      newsLong = true;
      newsRest = newsRest.replace(/\s+(-l|--long)$/, '');
    }

    if (newsLong) {
      await showAgentNewsTop(newsRest.trim(), true);
    } else {
      await checkAgentNews(newsRest);
    }
    rl.prompt();
    return;
  }

  // /cancel <agent> - Cancel the currently running query
  if (input.startsWith('/cancel ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }

    const agentName = input.substring(8).trim();
    if (!agentName) {
      console.log(`\n${colors.red}❌ Usage: /cancel <agent-name>${colors.reset}`);
      console.log(`${colors.gray}Example: /cancel coder1${colors.reset}\n`);
      rl.prompt();
      return;
    }

    try {
      // Resolve agent to get URL
      const response = await managerFetch(`/agents/resolve/${encodeURIComponent(agentName)}`);
      if (!response.ok) {
        console.log(`\n${colors.red}❌ Agent "${agentName}" not found${colors.reset}\n`);
        rl.prompt();
        return;
      }

      const data = await response.json() as any;
      const agent = data.agent || data.agents?.[0];
      if (!agent) {
        console.log(`\n${colors.red}❌ Agent "${agentName}" not found${colors.reset}\n`);
        rl.prompt();
        return;
      }

      // Call the agent's /cancel endpoint
      console.log(`\n${colors.yellow}🛑 Cancelling running query for ${agent.name}...${colors.reset}`);

      const cancelResponse = await fetch(`${agent.url}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!cancelResponse.ok) {
        const err = await cancelResponse.json() as any;
        console.log(`${colors.red}❌ Cancel failed: ${err.error || 'Unknown error'}${colors.reset}\n`);
      } else {
        const result = await cancelResponse.json() as any;
        if (result.cancelled) {
          console.log(`${colors.green}✅ ${result.message}${colors.reset}\n`);
        } else {
          console.log(`${colors.gray}${result.message}${colors.reset}\n`);
        }
      }
    } catch (error: any) {
      console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
    }

    rl.prompt();
    return;
  }

  // /task — forward to manager /remote and format results
  if (input.startsWith('/task')) {
    try {
      const response = await managerFetch('/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: input })
      });
      const data = await response.json() as any;
      if (data.ok) {
        const result = data.result;
        if (result.tasks) {
          if (result.tasks.length === 0) {
            console.log(`\n${colors.gray}No tasks found.${colors.reset}\n`);
          } else {
            console.log(`\n${colors.bold}Tasks (${result.tasks.length})${colors.reset}\n`);
            for (const t of result.tasks) {
              const statusIcon = t.status === 'done' ? '✅' : t.status === 'doing' ? '🔵' : '⚪';
              const owner = t.ownerName ? ` ${colors.cyan}${t.ownerName}${colors.reset}` : '';
              const team = t.teamName ? ` ${colors.gray}[${t.teamName}]${colors.reset}` : '';
              const events = t.linkedEvents?.length ? ` ${colors.gray}events:${t.linkedEvents.join(',')}${colors.reset}` : '';
              console.log(`${statusIcon} ${colors.bold}${t.name}${colors.reset} — ${t.title}${owner}${team}${events}`);
            }
            console.log('');
          }
        } else if (result.task) {
          const t = result.task;
          const statusIcon = t.status === 'done' ? '✅' : t.status === 'doing' ? '🔵' : '⚪';
          console.log(`\n${statusIcon} ${colors.bold}${t.name}${colors.reset} — ${t.title}`);
          if (t.ownerName) console.log(`   Owner: ${colors.cyan}${t.ownerName}${colors.reset}`);
          if (t.teamName) console.log(`   Team: ${t.teamName}`);
          if (t.linkedEvents?.length) console.log(`   Events: ${t.linkedEvents.join(', ')}`);
          console.log(`   Status: ${t.status}\n`);
        } else if (result.removed) {
          console.log(`\n${colors.green}✅ Removed task: ${result.removed}${colors.reset}\n`);
        } else {
          console.log(`\n${colors.green}✅${colors.reset}`, JSON.stringify(result, null, 2), '\n');
        }
      } else {
        console.log(`\n${colors.red}❌ ${data.error}${colors.reset}\n`);
      }
    } catch (error: any) {
      console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
    }
    rl.prompt();
    return;
  }

  // /heartbeat and /calendar — map to /schedule commands on the manager
  if (input.startsWith('/heartbeat') || input.startsWith('/calendar')) {
    const isHeartbeat = input.startsWith('/heartbeat');
    const kind = isHeartbeat ? 'heartbeat' : 'calendar';
    const rest = input.replace(/^\/(heartbeat|calendar)\s*/, '').trim();

    // Map to /schedule commands
    let cmd: string;
    if (!rest || rest === 'list') {
      cmd = '/schedule list';
    } else if (rest.startsWith('add ')) {
      cmd = `/schedule add ${kind} ${rest.slice(4)}`;
    } else if (rest.startsWith('show ') || rest.startsWith('pause ') || rest.startsWith('resume ') || rest.startsWith('remove ')) {
      cmd = `/schedule ${rest}`;
    } else {
      cmd = `/schedule list`;
    }

    try {
      const response = await managerFetch('/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd })
      });
      const data = await response.json() as any;
      if (data.ok) {
        const result = data.result;
        if (result.schedules) {
          // Filter by kind for /heartbeat or /calendar
          const filtered = result.schedules.filter((s: any) => s.kind === kind);
          if (filtered.length === 0) {
            console.log(`\n${colors.gray}No active ${kind}s.${colors.reset}\n`);
          } else {
            const icon = isHeartbeat ? '🔁' : '📆';
            console.log(`\n${colors.bold}${icon} ${kind === 'heartbeat' ? 'Heartbeats' : 'Calendar Events'} (${filtered.length})${colors.reset}\n`);
            for (const s of filtered) {
              const targets = (s.targets || []).join(', ');
              const statusIcon = s.active ? '🟢' : '🟡';

              let timing = '';
              if (s.kind === 'heartbeat') {
                const mins = Math.floor(s.intervalSeconds / 60);
                timing = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? mins % 60 + 'm' : ''}` : `${mins}m`;
              } else {
                const h = Math.floor((s.localTimeSeconds || 0) / 3600);
                const m = Math.floor(((s.localTimeSeconds || 0) % 3600) / 60);
                timing = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${s.daysOfWeek || s.localDate || ''}`;
              }

              console.log(`${statusIcon} ${s.title}`);
              console.log(`   ${timing} ${colors.gray}|${colors.reset} ${targets}`);
              console.log(`   ${colors.gray}${s.id}${colors.reset}`);
              console.log('');
            }
          }
        } else if (result.schedule) {
          const s = result.schedule;
          console.log(`\n${colors.green}✅ ${s.id}${colors.reset}`);
          console.log(`   ${s.kind} | ${s.target || s.targets?.join(', ') || ''}`);
          if (s.intervalSeconds) console.log(`   Every ${s.intervalSeconds}s`);
          if (s.time) console.log(`   Time: ${s.time} ${s.recurrence || s.date || ''} ${s.timezone || ''}`);
          console.log('');
        } else if (result.action) {
          console.log(`\n${colors.green}✅ ${result.action}: ${result.scheduleId || ''}${colors.reset}\n`);
        } else {
          console.log(`\n${colors.green}✅${colors.reset}`, JSON.stringify(result, null, 2), '\n');
        }
      } else {
        console.log(`\n${colors.red}❌ ${data.error}${colors.reset}\n`);
      }
    } catch (error: any) {
      console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
    }
    rl.prompt();
    return;
  }

  // /public — public-team agent management
  if (input === '/public' || input.startsWith('/public ')) {
    if (!(await checkManager())) {
      showManagerNotRunningError();
      rl.prompt();
      return;
    }

    const publicDeps = {
      managerBaseUrl: MANAGER_URL,
      fetch: fetch as unknown as typeof globalThis.fetch,
    };

    const rest = input === '/public' ? '' : input.slice('/public '.length).trim();

    // /public add <domain> [--ssh-target=...] [--internal-port=N]
    if (rest.startsWith('add ')) {
      const addArgs = parseArgs(rest.slice('add '.length));
      const domain = addArgs.find((a) => !a.startsWith('--'));
      if (!domain) {
        console.log(`\n${colors.red}❌ Usage: /public add <domain> [--ssh-target=user@host] [--internal-port=N]${colors.reset}\n`);
        rl.prompt();
        return;
      }
      const sshFlag = addArgs.find((a) => a.startsWith('--ssh-target='));
      const portFlag = addArgs.find((a) => a.startsWith('--internal-port='));
      const sshTarget = sshFlag ? sshFlag.slice('--ssh-target='.length) : null;
      const internalPort = portFlag ? parseInt(portFlag.slice('--internal-port='.length), 10) : null;

      (async () => {
        try {
          const result = await addPublicAgent(domain, { sshTarget, internalPort }, publicDeps);
          if (result.ok) {
            console.log(`\n${colors.green}✅ ${result.message}${colors.reset}\n`);
          } else {
            console.log(`\n${colors.red}❌ ${result.error}${colors.reset}\n`);
          }
        } catch (err: any) {
          console.log(`\n${colors.red}❌ Error: ${err?.message ?? String(err)}${colors.reset}\n`);
        }
        rl.prompt();
      })();
      return;
    }

    // /public remove <name-or-domain>
    if (rest.startsWith('remove ')) {
      const ref = rest.slice('remove '.length).trim();
      if (!ref) {
        console.log(`\n${colors.red}❌ Usage: /public remove <name|domain>${colors.reset}\n`);
        rl.prompt();
        return;
      }
      (async () => {
        try {
          // Fetch list to preview
          const listResult = await listPublicAgents(publicDeps);
          if (!listResult.ok) {
            console.log(`\n${colors.red}❌ ${listResult.error}${colors.reset}\n`);
            rl.prompt();
            return;
          }
          const needle = ref.toLowerCase();
          const found = listResult.agents.find(
            (a) =>
              a.name.toLowerCase() === needle ||
              (a.customer_domain ?? '').toLowerCase() === needle,
          );
          if (!found) {
            console.log(`\n${colors.red}❌ No public agent found matching "${ref}"${colors.reset}\n`);
            rl.prompt();
            return;
          }
          const confirmed = await confirmAction(
            rl,
            `⚠️  Remove public agent "${found.name}" (${found.customer_domain ?? found.id})?`,
            'yes',
            { cancelMessage: 'Remove cancelled.' },
          );
          if (!confirmed) {
            rl.prompt();
            return;
          }
          const result = await removePublicAgent(ref, publicDeps);
          if (result.ok) {
            console.log(`\n${colors.green}✅ ${result.message}${colors.reset}\n`);
          } else {
            console.log(`\n${colors.red}❌ ${result.error}${colors.reset}\n`);
          }
        } catch (err: any) {
          console.log(`\n${colors.red}❌ Error: ${err?.message ?? String(err)}${colors.reset}\n`);
        }
        rl.prompt();
      })();
      return;
    }

    // /public clear
    if (rest === 'clear') {
      (async () => {
        try {
          const listResult = await listPublicAgents(publicDeps);
          if (!listResult.ok) {
            console.log(`\n${colors.red}❌ ${listResult.error}${colors.reset}\n`);
            rl.prompt();
            return;
          }
          if (listResult.agents.length === 0) {
            console.log(`\n${colors.yellow}No public agents to remove.${colors.reset}\n`);
            rl.prompt();
            return;
          }
          const names = listResult.agents.map((a) => a.name).join(', ');
          const confirmed = await confirmAction(
            rl,
            `⚠️  Remove all ${listResult.agents.length} public agents: ${names}`,
            'yes',
            { cancelMessage: 'Clear cancelled.' },
          );
          if (!confirmed) {
            rl.prompt();
            return;
          }
          const errors: string[] = [];
          for (const agent of listResult.agents) {
            const r = await removePublicAgent(agent.name, publicDeps);
            if (!r.ok) errors.push(`${agent.name}: ${r.error}`);
          }
          if (errors.length) {
            console.log(`\n${colors.yellow}⚠️  Some removals failed:\n${errors.join('\n')}${colors.reset}\n`);
          } else {
            console.log(`\n${colors.green}✅ Removed ${listResult.agents.length} public agent(s)${colors.reset}\n`);
          }
        } catch (err: any) {
          console.log(`\n${colors.red}❌ Error: ${err?.message ?? String(err)}${colors.reset}\n`);
        }
        rl.prompt();
      })();
      return;
    }

    // /public <n|name|domain> — enter interactive chat session
    // /public <n|name|domain> <msg> — one-shot chat
    // /public (bare) or /public list — list public agents
    const sessionMatch = rest.match(/^([\w][\w.-]*)$/);
    if (sessionMatch && rest !== 'list') {
      const ref = sessionMatch[1];
      (async () => {
        try {
          const listResult = await listPublicAgents(publicDeps);
          if (!listResult.ok) {
            console.log(`\n${colors.red}❌ ${listResult.error}${colors.reset}\n`);
            rl.prompt();
            return;
          }
          let target = null as any;
          if (/^\d+$/.test(ref)) {
            target = listResult.agents[parseInt(ref, 10) - 1] ?? null;
          } else {
            const needle = ref.toLowerCase();
            target = listResult.agents.find(
              (a) => a.name.toLowerCase() === needle || (a.customer_domain ?? '').toLowerCase() === needle,
            ) ?? null;
          }
          if (!target) {
            console.log(`\n${colors.red}❌ No public agent found for "${ref}". Run /public to list agents.${colors.reset}\n`);
            rl.prompt();
            return;
          }
          const baseUrl = target.public_endpoint_url ?? `https://${target.customer_domain}`;
          let talkEndpoint = `${baseUrl}/talk`;
          try {
            const wkResp: any = await (fetch as any)(`${baseUrl}/.well-known/restap.json`, { signal: AbortSignal.timeout(5000) });
            if (wkResp.ok) {
              const wk: any = await wkResp.json();
              const t = wk?.endpoints?.talk;
              if (typeof t === 'string') talkEndpoint = t.startsWith('http') ? t : `${baseUrl}${t}`;
            }
          } catch { /* fall back to default /talk */ }
          publicSession = {
            name: target.name,
            customerDomain: target.customer_domain ?? '',
            talkEndpoint,
            sessionId: null,
            priorPrompt: (rl as any).getPrompt?.() ?? `${colors.green}> ${colors.reset}`,
          };
          // End the prompt with a visible space AFTER the ANSI reset so
          // readline can anchor the cursor correctly. Putting the reset
          // after the space loses the cursor on some terminals.
          rl.setPrompt(`${colors.cyan}public:${target.customer_domain ?? target.name}>${colors.reset} `);
          console.log(`\n${colors.cyan}→ chatting with ${target.name} (${target.customer_domain ?? baseUrl})${colors.reset}`);
          console.log(`${colors.gray}   ${talkEndpoint}   ·   /exit or any /command to leave${colors.reset}\n`);
          rl.prompt();
        } catch (err: any) {
          console.log(`\n${colors.red}❌ ${err?.message ?? err}${colors.reset}\n`);
          rl.prompt();
        }
      })();
      return;
    }

    const chatMatch = rest.match(/^([\w][\w.-]*)\s+(.+)$/s);
    if (chatMatch && rest !== '' && rest !== 'list') {
      const [, ref, msg] = chatMatch;
      (async () => {
        try {
          const listResult = await listPublicAgents(publicDeps);
          if (!listResult.ok) {
            console.log(`\n${colors.red}❌ ${listResult.error}${colors.reset}\n`);
            rl.prompt();
            return;
          }
          let target = null;
          if (/^\d+$/.test(ref)) {
            const idx = parseInt(ref, 10) - 1;
            target = listResult.agents[idx] ?? null;
          } else {
            const needle = ref.toLowerCase();
            target = listResult.agents.find(
              (a) =>
                a.name.toLowerCase() === needle ||
                (a.customer_domain ?? '').toLowerCase() === needle,
            ) ?? null;
          }
          if (!target) {
            console.log(`\n${colors.red}❌ No public agent found for "${ref}". Run /public to list agents.${colors.reset}\n`);
            rl.prompt();
            return;
          }
          // Fetch well-known to get talk endpoint
          const wellKnownUrl = `${target.public_endpoint_url ?? `https://${target.customer_domain}`}/.well-known/restap.json`;
          let talkEndpoint: string | null = null;
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            let wkResp: any;
            try {
              wkResp = await (fetch as any)(wellKnownUrl, { signal: controller.signal });
            } finally {
              clearTimeout(timeout);
            }
            if (wkResp.ok) {
              const wk: any = await wkResp.json();
              talkEndpoint = wk.endpoints?.talk ?? null;
            }
          } catch { /* fall through */ }
          if (!talkEndpoint) {
            talkEndpoint = `${target.public_endpoint_url ?? `https://${target.customer_domain}`}/talk`;
          }
          console.log(`\n${colors.cyan}→ ${target.name} (${target.customer_domain ?? ''})${colors.reset}`);
          console.log(`${colors.gray}  talk: ${talkEndpoint}${colors.reset}\n`);
          try {
            const talkResp = await (fetch as any)(talkEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: msg }),
            });
            if (!talkResp.ok) {
              console.log(`${colors.red}❌ Talk failed: HTTP ${talkResp.status}${colors.reset}\n`);
            } else {
              const talkData: any = await talkResp.json();
              const reply = talkData.reply ?? talkData.message ?? talkData.result ?? JSON.stringify(talkData);
              console.log(`${colors.bold}${target.name}:${colors.reset} ${reply}\n`);
            }
          } catch (talkErr: any) {
            console.log(`${colors.red}❌ Talk error: ${talkErr?.message ?? String(talkErr)}${colors.reset}\n`);
          }
        } catch (err: any) {
          console.log(`\n${colors.red}❌ Error: ${err?.message ?? String(err)}${colors.reset}\n`);
        }
        rl.prompt();
      })();
      return;
    }

    // /public, /public list, or unrecognized sub-command → show list
    (async () => {
      try {
        const result = await listPublicAgents(publicDeps);
        if (!result.ok) {
          console.log(`\n${colors.red}❌ ${result.error}${colors.reset}\n`);
          rl.prompt();
          return;
        }
        if (result.agents.length === 0) {
          console.log(`\n${colors.gray}No public agents registered. Use /public add <domain> to add one.${colors.reset}\n`);
        } else {
          // Helper: relative time
          const relTime = (unixSec: number | null): string => {
            if (unixSec == null) return 'never';
            const diff = Math.floor(Date.now() / 1000) - unixSec;
            if (diff < 60) return `${diff}s ago`;
            if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
            if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
            return `${Math.floor(diff / 86400)}d ago`;
          };
          // Helper: truncate with ellipsis
          const trunc = (s: string, w: number): string =>
            s.length > w ? s.slice(0, w - 1) + '\u2026' : s;
          // Health color
          const healthColor = (h: string | null): string => {
            if (h === 'online') return colors.green;
            if (h === 'unstable') return colors.yellow;
            if (h === 'offline') return colors.red;
            return colors.gray;
          };

          console.log(`\n${colors.bold}Public agents (${result.agents.length}):${colors.reset}\n`);
          const header = `  ${'#'.padStart(3)}  ${'name'.padEnd(18)}${'domain'.padEnd(20)}${'health'.padEnd(9)}${'last_seen'.padEnd(13)}errors`;
          console.log(`${colors.gray}${header}${colors.reset}`);
          result.agents.forEach((a, i) => {
            const num = String(i + 1).padStart(3);
            const n = trunc(a.name || '', 18).padEnd(18);
            const d = trunc(a.customer_domain || '', 20).padEnd(20);
            const h = a.health || 'unknown';
            const hPad = h.padEnd(9);
            const ls = relTime(a.last_seen).padEnd(13);
            const errStr = a.consecutive_failures > 0
              ? `${a.last_error ?? ''} (${a.consecutive_failures})`
              : '-';
            const hc = healthColor(a.health);
            console.log(`  ${colors.cyan}${num}${colors.reset}  ${n}${colors.gray}${d}${colors.reset}${hc}${hPad}${colors.reset}${colors.gray}${ls}${colors.reset}${errStr}`);
          });
          console.log('');
        }
      } catch (err: any) {
        console.log(`\n${colors.red}❌ Error: ${err?.message ?? String(err)}${colors.reset}\n`);
      }
      rl.prompt();
    })();
    return;
  }

  // Plain text with no / prefix — send to last asked agent
  if (!input.startsWith('/') && lastAskedAgent) {
    askAgent(lastAskedAgent, input, true);
    setImmediate(() => rl.prompt());
    return;
  }

  // Unknown command - show help
  console.log(`\n${colors.yellow}💡 Unknown command. Type /help for available commands.${colors.reset}\n`);
  rl.prompt();
}

let lastPendingCount = 0;
const activeSpinners: Set<NodeJS.Timeout> = new Set();

// Store session IDs per agent for context continuity
const agentSessions: Map<string, string> = new Map();

function updatePrompt() {
  const displayTeam = activeServerName || activeTeam;
  const agentSuffix = lastAskedAgent ? `:${lastAskedAgent}` : '';
  rl.setPrompt(`${colors.green}> [${name}@${displayTeam}${agentSuffix}]${colors.reset} `);
}

async function promptForManagerInboxResponse(query: ManagerInboxItem): Promise<void> {
  console.log(`\n${colors.bold}${colors.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}📝 Pending:${colors.reset} ${query.message}`);
  console.log(`${colors.gray}Query:${colors.reset} ${query.query_id}`);
  console.log(`${colors.bold}${colors.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  console.log(`${colors.gray}💬 Enter your response (or /cancel to abort):${colors.reset}\n`);

  const responseRl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${colors.cyan}>>${colors.reset} `
  });

  return await new Promise((resolve) => {
    responseRl.prompt();

    responseRl.once('line', async (responseLine) => {
      const response = responseLine.trim();

      if (response === '/cancel' || response === '/c') {
        console.log(`\n${colors.yellow}❌ Response cancelled${colors.reset}\n`);
        responseRl.close();
        resolve();
        return;
      }

      if (!response) {
        console.log(`\n${colors.red}❌ Response cannot be empty${colors.reset}\n`);
        responseRl.close();
        resolve();
        return;
      }

      try {
        await respondToManagerInboxQuery(query.query_id, response, query.session_id);
        console.log(`\n${colors.green}✅ Response sent!${colors.reset}\n`);
        lastPendingCount = 0;
      } catch (error: any) {
        console.log(`\n${colors.red}❌ ${error?.message || error}${colors.reset}\n`);
      }

      responseRl.close();
      resolve();
    });
  });
}

async function displayPendingQuestions(force: boolean = false) {
  const pending = await fetchPendingManagerInbox();
  
  if (pending.length === 0) {
    if (force || lastPendingCount > 0) {
      console.log(`\n${colors.green}✅ All questions answered!${colors.reset}\n`);
    }
    lastPendingCount = 0;
    return;
  }

  if (force || pending.length !== lastPendingCount) {
    console.log(`\n${colors.bold}${colors.yellow}🔔 ${pending.length} PENDING QUESTION${pending.length > 1 ? 'S' : ''}${colors.reset}\n`);

    pending.forEach((q, i) => {
      const time = new Date(q.timestamp).toLocaleTimeString();
      console.log(`${colors.bold}${colors.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
      console.log(`${colors.bold}${colors.yellow}${i + 1}.${colors.reset} ${q.from ? `${colors.cyan}${q.from}${colors.reset} ` : ''}${colors.gray}${time}${colors.reset}`);
      console.log(`${q.message}`);
    });

    console.log(`${colors.bold}${colors.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

    lastPendingCount = pending.length;
  }
}

// Display startup banner
console.log(`
${colors.bold}  ██╗██████╗       █████╗  ██████╗ ███████╗███╗   ██╗████████╗███████╗${colors.reset}
${colors.bold}  ██║██╔══██╗     ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔════╝${colors.reset}
${colors.bold}  ██║██║  ██║     ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ███████╗${colors.reset}
${colors.bold}  ██║██║  ██║     ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ╚════██║${colors.reset}
${colors.bold}  ██║██████╔╝     ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ███████║${colors.reset}
${colors.bold}  ╚═╝╚═════╝      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝${colors.reset}

  ${colors.gray}v${PKG_INFO.version}  •  Multi-agent orchestration  •  ${PKG_INFO.license}${colors.reset}
  ${colors.gray}github.com/idchain-world/id-agents${colors.reset}
`);

// Defensively re-enable the terminal cursor. If the TUI (or any alt-screen
// program) exited without running its cleanup — SIGKILL, crash, power-off —
// the cursor-hide escape `\x1b[?25l` stays applied to the terminal, and
// subsequent shell programs look cursor-less. `\x1b[?25h` restores it.
if (process.stdout.isTTY) {
  process.stdout.write('\x1b[?25h');
}

async function initializeCli() {
  // Check if manager is running, auto-start if not.
  let managerRunning = await checkManager();
  if (!managerRunning) {
    console.log(`${colors.yellow}Starting manager on port ${MANAGER_PORT}...${colors.reset}`);
    const managerScript = path.resolve(__cli_dirname, 'start-agent-manager.js');
    spawn('node', [managerScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, AGENT_MANAGER_PORT: String(MANAGER_PORT) }
    }).unref();
    managerRunning = await waitForManagerReady();
    if (!managerRunning) {
      console.log(`${colors.red}❌ Manager did not start in time${colors.reset}`);
      console.log(`${colors.gray}   Try manually: ${colors.cyan}node dist/start-agent-manager.js${colors.reset}\n`);
      process.exit(1);
      return;
    }
    console.log(`${colors.green}✓ Manager started${colors.reset}\n`);
  }
  
  // Poll for new queries every 2 seconds
  setInterval(() => {
    displayPendingQuestions().catch(() => {});
  }, 2000);

  // Start WebSocket connection to manager (works for both local and remote)
  startManagerConnection();

  console.log(`${colors.gray}Type /help for commands, /deploy <config> to create agents${colors.reset}\n`);
  updatePrompt();
  rl.prompt();
}

void initializeCli().catch((error: any) => {
  console.log(`\n${colors.red}❌ CLI startup failed: ${error?.message || error}${colors.reset}\n`);
  process.exit(1);
});

rl.on('line', handleLine);

async function checkAgentStatus(longFormat: boolean = false) {
  try {
    console.log(`\n${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}📊 Agent Status Check${colors.reset}${longFormat ? ` ${colors.gray}(detailed)${colors.reset}` : ''}\n`);
    
    // Get list of all agents including automators
    const response = await managerFetch('/agents?all=true');
    if (!response.ok) {
      console.log(`\n${colors.red}❌ Could not fetch agents list${colors.reset}\n`);
      return;
    }
    
    const data: any = await response.json();
    const allAgents = data.agents || [];
    
    // Deduplicate by name (keep the most recent one)
    const agentMap = new Map<string, any>();
    allAgents.forEach((agent: any) => {
      const existing = agentMap.get(agent.name);
      if (!existing || (agent.createdAt && existing.createdAt && agent.createdAt > existing.createdAt)) {
        agentMap.set(agent.name, agent);
      }
    });
    const agents = Array.from(agentMap.values());
    
    if (agents.length === 0) {
      console.log(`${colors.gray}📭 No agents in the network${colors.reset}\n`);
      console.log(`${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
      return;
    }

    // Check each agent's status
    const statusChecks = await Promise.allSettled(
      agents.map(async (agent: any) => {
        const isExternal = agent.type === 'virtual' || agent.type === 'interactive';
        const agentUrl = agent.url || (isExternal ? agent.endpoint : `http://localhost:${agent.port}`);

        // Special handling for the daemon-owned manager agent surfaced in the CLI.
        const isManagerAgent = agent.type === 'interactive' && agent.name === name;

        // Try to reach the agent's catalog endpoint
        let isResponding = false;
        let lastActivity = null;
        let activeQueries = 0;
        let orphanedQueries = 0;
        let messagesReceived = 0;
        let repliesSent = 0;
        let totalNewsItems = 0;

        // Manager agent is always "responding" since the daemon owns it.
        if (isManagerAgent) {
          isResponding = true;
          // Try to get activity from manager's own news feed
          try {
            const newsResponse = await managerFetch('/news?since=0&limit=50');
            if (newsResponse.ok) {
              const newsData: any = await newsResponse.json();
              if (newsData.items && newsData.items.length > 0) {
                const latestItem = newsData.items[0];
                lastActivity = latestItem.timestamp;
                // Only count queries from last 10 minutes as potentially active (not old orphans)
                const ACTIVE_QUERY_WINDOW = 10 * 60 * 1000; // 10 minutes
                const cutoffTime = Date.now() - ACTIVE_QUERY_WINDOW;
                const receivedQueryIds = new Map<string, number>(); // query_id -> timestamp
                const completedQueryIds = new Set<string>();
                newsData.items.forEach((item: any) => {
                  if (item.type === 'query.received' && item.data?.query_id) {
                    receivedQueryIds.set(item.data.query_id, item.timestamp || 0);
                  }
                  // Count completed, failed, and cancelled as "done"
                  if ((item.type === 'query.completed' || item.type === 'query.failed' || item.type === 'query.cancelled') && item.data?.query_id) {
                    completedQueryIds.add(item.data.query_id);
                  }
                  if (item.type === 'query.received' || item.type === 'message') {
                    messagesReceived++;
                  }
                  if (item.type === 'outbound.message' || item.type === 'outbound.reply') {
                    repliesSent++;
                  }
                });
                // Count recent uncompleted as active, old uncompleted as orphaned
                receivedQueryIds.forEach((timestamp, id) => {
                  if (!completedQueryIds.has(id)) {
                    if (timestamp > cutoffTime) {
                      activeQueries++;
                    } else {
                      orphanedQueries++;
                    }
                  }
                });
                totalNewsItems = newsData.items.length;
              }
            }
          } catch {
            // Manager news check failed, but agent is still responding
          }
        } else {
          // Reach the catalog endpoint directly
          try {
            const catalogResponse = await fetch(`${agentUrl}/.well-known/restap.json`, {
              signal: AbortSignal.timeout(3000) // 3 second timeout
            });
            isResponding = catalogResponse.ok;

            // Try to get recent news to check activity
            try {
              const newsResponse = await fetch(`${agentUrl}/news?since=0&limit=50`, {
                signal: AbortSignal.timeout(2000)
              });
              if (newsResponse.ok) {
                const newsData: any = await newsResponse.json();
                if (newsData.items && newsData.items.length > 0) {
                  // Items are sorted newest-first, so [0] is the latest
                  const latestItem = newsData.items[0];
                  lastActivity = latestItem.timestamp;

                  // Only count queries from last 10 minutes as potentially active (not old orphans)
                  const ACTIVE_QUERY_WINDOW = 10 * 60 * 1000; // 10 minutes
                  const cutoffTime = Date.now() - ACTIVE_QUERY_WINDOW;

                  // Count message types
                  const receivedQueryIds = new Map<string, number>(); // query_id -> timestamp
                  const completedQueryIds = new Set<string>();
                  newsData.items.forEach((item: any) => {
                    // Track received vs completed queries
                    if (item.type === 'query.received' && item.data?.query_id) {
                      receivedQueryIds.set(item.data.query_id, item.timestamp || 0);
                    }
                    // Count completed, failed, and cancelled as "done"
                    if ((item.type === 'query.completed' || item.type === 'query.failed' || item.type === 'query.cancelled') && item.data?.query_id) {
                      completedQueryIds.add(item.data.query_id);
                    }
                    // Count messages received
                    if (item.type === 'query.received' || item.type === 'message') {
                      messagesReceived++;
                    }
                    // Count messages/replies sent (outbound)
                    if (item.type === 'outbound.message' || item.type === 'outbound.reply') {
                      repliesSent++;
                    }
                  });
                  // Count recent uncompleted as active, old uncompleted as orphaned
                  receivedQueryIds.forEach((timestamp, id) => {
                    if (!completedQueryIds.has(id)) {
                      if (timestamp > cutoffTime) {
                        activeQueries++;
                      } else {
                        orphanedQueries++;
                      }
                    }
                  });
                  totalNewsItems = newsData.items.length;
                }
              }
            } catch {
              // News check failed, that's okay
            }
          } catch {
            isResponding = false;
          }
        }

        return {
          agent,
          isResponding,
          lastActivity,
          activeQueries,
          orphanedQueries,
          messagesReceived,
          repliesSent,
          totalNewsItems
        };
      })
    );
    
    // Display results
    statusChecks.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const { agent, isResponding, lastActivity, activeQueries, orphanedQueries, messagesReceived, repliesSent, totalNewsItems } = result.value;
        const isAutomator = agent.type === 'automator';
        const typeEmoji = isAutomator ? '🧠' : (agent.type === 'virtual' || agent.type === 'interactive' ? '🧑' : '🤖');
        const statusEmoji = isResponding ? '🟢' : '🔴';

        // Build activity indicator
        let recencyBar = '';
        let recencyBarLong = '';
        let recencyColor = colors.gray;
        let timeText = '';
        let timeTextLong = '';

        if (isResponding && lastActivity) {
          const timeAgo = Date.now() - lastActivity;
          const minutesAgo = Math.floor(timeAgo / 60000);
          const secondsAgo = Math.floor(timeAgo / 1000);
          const hoursAgo = Math.floor(minutesAgo / 60);

          if (minutesAgo < 1) {
            recencyColor = colors.green;
            recencyBar = '████';
            recencyBarLong = '████████';
            timeText = `${secondsAgo}s`;
            timeTextLong = `${secondsAgo}s ago`;
          } else if (minutesAgo < 5) {
            recencyColor = colors.green;
            recencyBar = '███░';
            recencyBarLong = '██████░░';
            timeText = `${minutesAgo}m`;
            timeTextLong = `${minutesAgo}m ago`;
          } else if (minutesAgo < 15) {
            recencyColor = colors.yellow;
            recencyBar = '██░░';
            recencyBarLong = '████░░░░';
            timeText = `${minutesAgo}m`;
            timeTextLong = `${minutesAgo}m ago`;
          } else if (minutesAgo < 60) {
            recencyColor = colors.yellow;
            recencyBar = '█░░░';
            recencyBarLong = '██░░░░░░';
            timeText = `${minutesAgo}m`;
            timeTextLong = `${minutesAgo}m ago`;
          } else {
            recencyColor = colors.gray;
            recencyBar = '░░░░';
            recencyBarLong = '░░░░░░░░';
            timeText = hoursAgo > 0 ? `${hoursAgo}h` : `${minutesAgo}m`;
            timeTextLong = hoursAgo > 0 ? `${hoursAgo}h ${minutesAgo % 60}m ago` : `${minutesAgo}m ago`;
          }
        } else if (isResponding) {
          recencyBar = '░░░░';
          recencyBarLong = '░░░░░░░░';
          timeText = '--';
          timeTextLong = 'No recent activity';
        }

        // Build uptime string
        let uptimeStr = '';
        let uptimeStrLong = '';
        if (agent.createdAt) {
          const uptimeMs = Date.now() - agent.createdAt;
          const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
          const uptimeMins = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
          uptimeStr = uptimeHours > 0 ? `${uptimeHours}h${uptimeMins}m` : `${uptimeMins}m`;
          uptimeStrLong = uptimeHours > 0 ? `${uptimeHours}h ${uptimeMins}m` : `${uptimeMins}m`;
        }

        // Build model string (short)
        const model = agent.model || '';

        // Build port from URL
        const portMatch = agent.url?.match(/:(\d+)$/);
        const port = portMatch ? `:${portMatch[1]}` : '';

        const hasHeartbeat = agent.hasActiveHeartbeat === true;

        if (longFormat) {
          // === LONG FORMAT ===
          const automatorTag = isAutomator ? ` ${colors.cyan}[automator]${colors.reset}` : '';
          const heartbeatTag = hasHeartbeat ? ' ♥' : '';
          const statusText = isResponding ? 'online' : 'offline';
          console.log(`${typeEmoji} ${colors.bold}${agent.name}${colors.reset}${automatorTag} ${statusEmoji} ${statusText}${heartbeatTag}`);

          // Runtime and model
          const runtime = agent.metadata?.runtime || agent.type || 'claude';
          const modelInfo = model ? ` / ${model}` : '';
          console.log(`   ${colors.gray}Runtime:${colors.reset} ${runtime}${modelInfo}`);

          // URL
          console.log(`   ${colors.gray}URL:${colors.reset} ${agent.url}`);

          // Uptime
          if (uptimeStrLong) {
            console.log(`   ${colors.gray}Uptime:${colors.reset} ${uptimeStrLong}`);
          }

          // Last activity with visual bar
          if (isResponding) {
            console.log(`   ${colors.gray}Last active:${colors.reset} ${recencyColor}${recencyBarLong}${colors.reset} ${timeTextLong}`);

            // Messages
            if (totalNewsItems > 0) {
              console.log(`   ${colors.gray}Messages:${colors.reset} ${messagesReceived} received, ${repliesSent} sent (${totalNewsItems} total)`);
            }

            // Processing (active = recent, orphaned = old uncompleted)
            if (activeQueries > 0 || orphanedQueries > 0) {
              let processingText = '';
              if (activeQueries > 0) {
                processingText += `${activeQueries} active`;
              }
              if (orphanedQueries > 0) {
                if (processingText) processingText += ', ';
                processingText += `${colors.red}${orphanedQueries} orphaned${colors.reset}`;
              }
              console.log(`   ${colors.yellow}⏳ Processing:${colors.reset} ${processingText}`);
            }
          } else {
            console.log(`   ${colors.red}⚠️  Not responding${colors.reset}`);
          }

          // Token ID
          if (agent.tokenId) {
            const tokenDisplay = agent.domain || agent.tokenId;
            console.log(`   ${colors.gray}Token ID:${colors.reset} ${tokenDisplay}`);
          }

          if (index < statusChecks.length - 1) {
            console.log('');
          }
        } else {
          // === COMPACT FORMAT ===
          const namePadded = agent.name.padEnd(12);
          const automatorTag = isAutomator ? `${colors.cyan}[auto]${colors.reset} ` : '';

          // Line 1: Name, status, activity bar, time, model, uptime, heartbeat
          const heartbeatIcon = hasHeartbeat ? '♥' : '';
          const line1Parts = [
            `${typeEmoji} ${colors.bold}${namePadded}${colors.reset}`,
            automatorTag,
            statusEmoji,
            isResponding ? `${recencyColor}${recencyBar}${colors.reset} ${timeText.padEnd(4)}` : `${colors.red}offline${colors.reset}`,
            model ? `${colors.gray}${model}${colors.reset}` : '',
            uptimeStr ? `${colors.gray}↑${uptimeStr}${colors.reset}` : '',
            heartbeatIcon
          ].filter(Boolean).join(' ');

          console.log(line1Parts);

          // Line 2: Port, messages, processing (only if there's meaningful info)
          const line2Parts: string[] = [];

          if (port) {
            line2Parts.push(`${colors.gray}${port}${colors.reset}`);
          }

          if (messagesReceived > 0 || repliesSent > 0) {
            line2Parts.push(`${colors.gray}${messagesReceived}↓ ${repliesSent}↑${colors.reset}`);
          }

          if (activeQueries > 0) {
            line2Parts.push(`${colors.yellow}⏳${activeQueries}${colors.reset}`);
          }

          if (!isResponding) {
            line2Parts.push(`${colors.red}⚠ not responding${colors.reset}`);
          }

          if (line2Parts.length > 0) {
            console.log(`   ${line2Parts.join('  ')}`);
          }
        }
      }
    });
    
    console.log(`${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

async function deleteAgent(agentNameOrId: string) {
  try {
    // Use resolveAgent to handle all identifier formats (name, id, ENS domain, tokenId@registry)
    const agent = await resolveAgent(agentNameOrId);
    if (!agent?.id) {
      console.log(`\n${colors.red}❌ Agent "${agentNameOrId}" not found${colors.reset}\n`);
      return;
    }

    // Kill local agent process before deleting from manager
    if (agent.port) {
      try {
        const lsofOutput = execFileSync('lsof', ['-ti', `:${agent.port}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        if (lsofOutput) {
          const pids = lsofOutput.split('\n').filter(Boolean);
          for (const pid of pids) {
            try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
          }
          console.log(`${colors.green}✅ Stopped agent process${colors.reset} (killed PID ${pids.join(', ')} on port ${agent.port})`);
        }
      } catch {
        // No process on port — already stopped
      }
    }

    // Delete by resolved ID
    const response = await managerFetch(`/agents/${encodeURIComponent(agent.id)}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const text = await response.text();
      console.log(`\n${colors.red}❌ Failed to delete agent: ${text}${colors.reset}\n`);
      return;
    }

    const data: any = await response.json();
    console.log(`\n${colors.green}✅ ${data.message}${colors.reset}`);
    console.log(`${colors.gray}   ${getAgentDisplayName(agent)} (${data.id})${colors.reset}\n`);
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

async function listAgents(_showAll: boolean = false) {
  try {
    // CLI always shows all agents including automators
    // (Automators are only hidden from other agents querying the API directly)
    const url = '/agents?all=true';
    const response = await managerFetch(url).catch(() => null);
    if (!response || !response.ok) {
      console.log(`\n${colors.yellow}📭 There are no agents on this team yet${colors.reset}`);
      console.log(`${colors.gray}   Deploy an agent with: ${colors.cyan}/deploy <config>${colors.reset}`);
      console.log(`${colors.gray}   Check configs/ directory for available configurations${colors.reset}\n`);
      return;
    }

    const data: any = await response.json();
    const allAgents = data.agents;
    
    // Deduplicate by name (keep the most recent one) - safety check
    const agentMap = new Map<string, any>();
    allAgents.forEach((agent: any) => {
      const existing = agentMap.get(agent.name);
      if (!existing || (agent.createdAt && existing.createdAt && agent.createdAt > existing.createdAt)) {
        agentMap.set(agent.name, agent);
      }
    });
    const agents = Array.from(agentMap.values());

    if (agents.length === 0) {
      console.log(`\n${colors.yellow}📭 There are no agents on this team yet${colors.reset}`);
      console.log(`${colors.gray}   Deploy an agent with: ${colors.cyan}/deploy <config>${colors.reset}`);
      console.log(`${colors.gray}   Check configs/ directory for available configurations${colors.reset}\n`);
      return;
    }
    
    console.log(`\n${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}🤖 Agents in Team "${activeTeam}" (${agents.length})${colors.reset}\n`);
    
    agents.forEach((agent: any, i: number) => {
      // name is the displayId (ENS domain after registration, local name before)
      const displayId = agent.name;
      // Use custom emoji from metadata if available, otherwise default based on type
      const isAutomator = agent.type === 'automator';
      const defaultEmoji = isAutomator ? '🧠' : (agent.type === 'virtual' || agent.type === 'interactive' ? '🧑' : '🤖');
      const typeEmoji = agent?.metadata?.emoji || defaultEmoji;
      const automatorTag = isAutomator ? ` ${colors.yellow}[automator]${colors.reset}` : '';
      console.log(`${typeEmoji} ${colors.bold}${displayId}${colors.reset}${automatorTag}`);
      if (agent.id) {
        console.log(`   ${colors.gray}Id:${colors.reset} ${agent.id}`);
      }
      // Show alias if different from displayId (e.g., "coder" when name is ENS domain)
      if (agent.alias && agent.alias !== agent.name) {
        console.log(`   ${colors.gray}Alias:${colors.reset} ${agent.alias}`);
      }
      // Show runtime if available, otherwise fall back to type
      const runtime = agent.metadata?.runtime || agent.type || 'claude';
      console.log(`   ${colors.gray}Runtime:${colors.reset} ${runtime}`);
      if (agent.model) {
        console.log(`   ${colors.gray}Model:${colors.reset} ${agent.model}`);
      }
      // Show external URL for outside tools, internal URL for agent-to-agent
      const externalUrl = agent.metadata?.external_url || agent.url;
      const internalUrl = agent.metadata?.internal_url || agent.internal_url || agent.url;
      console.log(`   ${colors.gray}URL:${colors.reset} ${externalUrl}`);
      if (internalUrl && internalUrl !== externalUrl) {
        console.log(`   ${colors.gray}Internal:${colors.reset} ${internalUrl}`);
      }
      if (i < agents.length - 1) console.log('');
    });

    console.log(`${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

async function askAgent(agentName: string, message: string, useSession: boolean = true) {
  try {
    console.log(`\n${colors.gray}🔍 Looking for agent "${agentName}"...${colors.reset}`);
    const agent = await resolveAgent(agentName);
    if (!agent) {
      rl.prompt();
      return;
    }

    console.log(`${colors.green}✓${colors.reset} Found ${getAgentDisplayName(agent)}\n`);
    console.log(`${colors.gray}📤 Sending: "${message}"${colors.reset}`);

    // Send message via POST /talk (event-driven pattern)
    // Reply will arrive at our /news endpoint and be displayed by the reply event handler
    // Include session_id if we have one from previous conversation with this agent (and useSession is true)
    const sessionId = useSession ? agentSessions.get(agent.name) : undefined;
    if (sessionId) {
      console.log(`${colors.gray}   (resuming session)${colors.reset}`);
    }

    // Check if we need to route through the manager (for remote teams)
    // If the agent URL is localhost but the manager is remote, use manager's /message (fire-and-forget)
    // Using /message (not /talk-to) because askAgent() uses the event-driven pattern:
    // it registers the query_id and waits for the reply via WebSocket/polling.
    // /talk-to blocks until reply arrives, causing a race condition where the WebSocket
    // reply arrives before pendingOutgoingQueries is populated.
    const agentIsLocal = agent.url?.includes('localhost') || agent.url?.includes('127.0.0.1');
    const managerIsRemote = !MANAGER_URL.includes('localhost') && !MANAGER_URL.includes('127.0.0.1');
    const useManagerProxy = agentIsLocal && managerIsRemote;

    let talkResponse;
    if (useManagerProxy) {
      // Route through manager's /message endpoint (fire-and-forget) for remote teams
      console.log(`${colors.gray}   (routing through manager)${colors.reset}`);
      talkResponse = await managerFetch('/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: agent.name,
          message,
          from: name,
          session_id: sessionId
        })
      });
    } else {
      // Direct connection to agent
      talkResponse = await fetch(`${agent.url}/talk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message, from: name, session_id: sessionId })
      });
    }

    if (!talkResponse.ok) {
      const errorText = await talkResponse.text().catch(() => talkResponse.statusText);
      console.log(`\n${colors.red}❌ Failed to send message: ${talkResponse.status} ${errorText}${colors.reset}\n`);
      rl.prompt();
      return;
    }

    const talkData: any = await talkResponse.json();
    const queryId = talkData.query_id;

    console.log(`${colors.gray}   Query ID: ${queryId}${colors.reset}`);
    console.log(`${colors.gray}⏳ Waiting for reply (will appear when ${getAgentDisplayName(agent)} responds)...${colors.reset}\n`);

    // Track this outgoing query so reply event handler can match and display it
    if (queryId) {
      pendingOutgoingQueries.set(queryId, {
        queryId,
        agentName: agent.name,
        message,
        timestamp: Date.now()
      });

      // Record outbound message in our own news feed
      recordOutboundMessage({
        to: agent.name,
        message,
        queryId,
        type: 'message'
      }).catch(() => {});
    }

    rl.prompt();
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}`);
    // Check if this is a connection error (agent not running)
    if (error.message?.includes('failed, reason:') || error.code === 'ECONNREFUSED') {
      console.log(`${colors.yellow}💡 The agent may not be running. Try:${colors.reset}`);
      console.log(`   ${colors.cyan}/agents start${colors.reset}      - Start all agents`);
      console.log(`   ${colors.cyan}/agent <name> start${colors.reset} - Start a specific agent`);
    }
    console.log('');
    rl.prompt();
  }
}

async function broadcastToAllAgents(message: string) {
  try {
    console.log(`\n${colors.gray}📡 Broadcasting to all agents...${colors.reset}`);
    
    // Get list of all agents
    const response = await managerFetch('/agents');
    if (!response.ok) {
      console.log(`\n${colors.red}❌ Could not fetch agents list${colors.reset}\n`);
      rl.prompt();
      return;
    }
    
    const data: any = await response.json();
    const allAgents = data.agents || [];
    
    // Deduplicate by name (keep the most recent one)
    const agentMap = new Map<string, any>();
    allAgents.forEach((agent: any) => {
      const existing = agentMap.get(agent.name);
      if (!existing || (agent.createdAt && existing.createdAt && agent.createdAt > existing.createdAt)) {
        agentMap.set(agent.name, agent);
      }
    });
    const agents = Array.from(agentMap.values());
    
    // Filter to only agents with active HTTP servers (claude agents and interactive agents)
    // Skip virtual agents that are just onchain records without running servers
    const activeTeams = agents.filter((a: any) => {
      // Only include claude agents (have active servers) and interactive agents (manager, but we'll filter self next)
      return a.type === 'claude' || a.type === 'interactive';
    });
    
    // Filter out self
    const otherAgents = activeTeams.filter((a: any) => a.name.toLowerCase() !== name.toLowerCase());
    
    if (otherAgents.length === 0) {
      console.log(`\n${colors.gray}📭 No active agents found to broadcast to${colors.reset}`);
      console.log(`${colors.gray}   (Only broadcasting to agents with active HTTP servers)${colors.reset}\n`);
      rl.prompt();
      return;
    }
    
    console.log(`${colors.gray}📤 Sending to ${otherAgents.length} active agent(s): "${message}"${colors.reset}\n`);
    
    // Send to all agents without waiting for responses
    let successCount = 0;
    let failCount = 0;
    
    const promises = otherAgents.map(async (agent: any) => {
      try {
        const isExternal = agent.type === 'virtual' || agent.type === 'interactive';
        const agentUrl = agent.url || (isExternal ? agent.endpoint : `http://localhost:${agent.port}`);
        const talkUrl = `${agentUrl}/talk`;
        
        const talkResponse = await fetch(talkUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message,
            from: name
          })
        });
        
        if (talkResponse.ok) {
          const result: any = await talkResponse.json();
          successCount++;
          const queryId = result.query_id;
          console.log(`${colors.green}✓${colors.reset} Sent to ${colors.bold}${getAgentDisplayName(agent)}${colors.reset} (Query ID: ${queryId || 'N/A'})`);
          // Track this outgoing query so we can match incoming replies
          if (queryId) {
            pendingOutgoingQueries.set(queryId, {
              queryId,
              agentName: getAgentDisplayName(agent),
              message,
              timestamp: Date.now()
            });
          }
          // Record outbound broadcast in our own news feed
          recordOutboundMessage({
            to: agent.name,
            message,
            queryId,
            type: 'broadcast'
          }).catch(() => {});
        } else {
          failCount++;
          const errorText = await talkResponse.text();
          console.log(`${colors.red}✗${colors.reset} Failed to send to ${colors.bold}${getAgentDisplayName(agent)}${colors.reset}: ${talkResponse.status} ${errorText.substring(0, 50)}`);
        }
      } catch (error: any) {
        failCount++;
        console.log(`${colors.red}✗${colors.reset} Error sending to ${colors.bold}${getAgentDisplayName(agent)}${colors.reset}: ${error.message}`);
      }
    });
    
    // Wait for all sends to complete
    await Promise.all(promises);
    
    console.log(`\n${colors.green}✅ Broadcast complete: ${successCount} sent, ${failCount} failed${colors.reset}\n`);
    rl.prompt();
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
    rl.prompt();
  }
}

async function probeNewAgentsReady(names: string[]): Promise<void> {
  for (const name of names) {
    try {
      const resp = await managerFetch(`/agents/by-name/${encodeURIComponent(name)}`);
      if (!resp.ok) continue;
      const row: any = await resp.json();
      const agentUrl = row?.url || row?.endpoint || (row?.port ? `http://localhost:${row.port}` : null);
      if (!agentUrl) continue;
      const ready = await waitForAgentReady(agentUrl);
      if (!ready) {
        console.log(`   ${colors.yellow}⚠️  ${name} did not become ready within 8s — first /ask may fail. Retry once it appears in /agents status.${colors.reset}`);
      }
    } catch {
      /* best-effort — don't block the sync output on readiness probing */
    }
  }
}

async function deployFromConfig(filePath: string, args: string[] = []) {
  const savedTeam = activeTeam;
  try {
    console.log(`\n${colors.gray}📄 Loading config from: ${filePath}${colors.reset}`);
    if (args.length > 0) {
      console.log(`${colors.gray}   Parameters: ${args.join(' ')}${colors.reset}`);
    }

    // Resolve path relative to current working directory
    const absolutePath = path.resolve(process.cwd(), filePath);

    // Show available parameters if config has them and no args provided
    const configParams = getConfigParameters(absolutePath);
    if (configParams.length > 0 && args.length === 0) {
      console.log(`${colors.gray}   Config has parameters (using defaults):${colors.reset}`);
      configParams.forEach(p => {
        const defaultVal = p.default !== undefined ? ` = ${p.default}` : ' (required)';
        console.log(`     ${colors.cyan}${p.name}${colors.reset}${defaultVal}${p.description ? ` - ${p.description}` : ''}`);
      });
    }

    // Process config file with parameters
    const { agents, teamContext, teamName: configTeam, errors, parameters } = processConfig(absolutePath, '/workspace', args);

    if (errors.length > 0) {
      console.log(`\n${colors.red}❌ Config validation errors:${colors.reset}`);
      errors.forEach(err => {
        console.log(`   ${colors.red}• ${err.path}: ${err.message}${colors.reset}`);
      });
      if (parameters && parameters.length > 0) {
        console.log(`\n${colors.gray}Available parameters:${colors.reset}`);
        parameters.forEach(p => {
          const defaultVal = p.default !== undefined ? ` = ${p.default}` : ' (required)';
          console.log(`   ${colors.cyan}${p.name}${colors.reset}${defaultVal}`);
        });
      }
      console.log('');
      return;
    }

    if (agents.length === 0) {
      console.log(`\n${colors.yellow}⚠️  No agents defined in config${colors.reset}\n`);
      return;
    }

    console.log(`${colors.gray}   Found ${agents.length} agent(s) to deploy${colors.reset}`);

    // Switch to config's team if specified
    if (configTeam && configTeam !== activeTeam) {
      activeTeam = configTeam;
      activeServerName = configTeam;
      console.log(`${colors.gray}   Using team from config: ${configTeam}${colors.reset}`);
    }
    if (teamContext) {
      console.log(`${colors.gray}   Team context loaded${colors.reset}`);
    }

    // Deploy each agent
    const results: { name: string; success: boolean; error?: string }[] = [];

    for (const agent of agents) {
      // Check if this is a local agent
      if (agent.local) {
        console.log(`\n${colors.cyan}🏠 Deploying local agent "${agent.name}"...${colors.reset}`);
        const runtimeName = getRuntimeDisplayName(agent.runtime || 'claude-code-cli');
        console.log(`${colors.gray}   Using your local ${runtimeName} authentication${colors.reset}`);

        try {
          // First, register the agent with the manager to get a port allocation and DB entry
          const payload = {
            name: agent.name,
            model: agent.model,
            local: true,  // Local agent
            runtime: resolveRuntime(agent.runtime || 'claude-code-cli'),
            plugins: agent.plugins,
            verbose: agent.verbose,
            workingDirectory: agent.workingDirectory,
            agent: agent.agent,
            roleBody: agent.roleBody,
            address: agent.address,
            heartbeat: agent.heartbeat,
            metadata: {
              description: agent.description,
              runtime: resolveRuntime(agent.runtime || 'claude-code-cli')
            }
          };

          const response = await managerFetch('/agents/spawn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          if (!response.ok) {
            const error: any = await response.json();
            results.push({ name: agent.name, success: false, error: error.error || 'Unknown error' });
            console.log(`   ${colors.red}❌ Failed to register: ${error.error}${colors.reset}`);
            continue;
          }

          const result: any = await response.json();
          console.log(`   ${colors.gray}   Registered: ${result.id} on port ${result.port}${colors.reset}`);

          // Spawn the local agent in a background process
          const { spawn } = await import('child_process');
          const scriptPath = path.resolve(__cli_dirname, 'local-agent-server.js');

          // Check if port is already in use and warn
          if (result.port) {
            try {
              const lsofOutput = execFileSync('lsof', ['-ti', `:${result.port}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
              if (lsofOutput) {
                const pids = lsofOutput.split('\n').filter(Boolean);
                console.log(`${colors.yellow}   ⚠️  Warning: Port ${result.port} is in use by PID ${pids.join(', ')}${colors.reset}`);
                console.log(`${colors.yellow}      Run: kill ${pids.join(' ')}  (to free the port)${colors.reset}`);
              }
            } catch {
              // No process on port, that's fine
            }
          }

          // Build command arguments - pass all the info from the manager
          const spawnArgs = [
            scriptPath,
            agent.name,
            '--team', activeTeam,
            '--port', String(result.port),
            '--id', result.id,
            '--dir', result.workingDirectory
          ];

          // Add verbose flag if enabled in config
          if (agent.verbose === true || agent.verbose === 'true') {
            spawnArgs.push('--verbose');
          }

          // Set environment variables
          const localEnv = {
            ...process.env,
            ID_TEAM: activeTeam,
            ID_AGENT_PORT: String(result.port),
            MANAGER_URL: MANAGER_URL,
            ...(agent.runtime && { ID_HARNESS: agent.runtime }),
            ID_DB_TEAM_ID: result.teamId,
            ID_DB_AGENT_ID: result.id,
            ID_SHARED_DIR: result.sharedDirectory,
            ...(agent.model && { CLAUDE_MODEL: resolveModelAlias(agent.model) }),
            ...((agent.verbose === true || agent.verbose === 'true') && { ID_AGENT_VERBOSE: 'true' }),
            // Default to skip-permissions; honor explicit false from config
            ID_AGENT_SKIP_PERMISSIONS: agent.dangerouslySkipPermissions === false ? 'false' : 'true'
          };

          // Create log file for the local agent
          const logsDir = path.join(process.env.ID_WORKSPACE_DIR || process.env.WORKSPACE_DIR || '/tmp/id-agents', 'logs');
          if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
          }
          const logFile = path.join(logsDir, `local-${agent.name}-${Date.now()}.log`);
          const logStream = fs.openSync(logFile, 'a');

          const localAgent = spawn('node', spawnArgs, {
            env: localEnv,
            stdio: ['ignore', logStream, logStream],
            detached: true
          });

          localAgent.unref();
          fs.closeSync(logStream);

          results.push({ name: agent.name, success: true });
          console.log(`   ${colors.green}✅ Local agent "${agent.name}" is starting...${colors.reset}`);
          console.log(`   ${colors.gray}   ID: ${result.id}${colors.reset}`);
          console.log(`   ${colors.gray}   Port: ${result.port}${colors.reset}`);
          console.log(`   ${colors.gray}   PID: ${localAgent.pid}${colors.reset}`);
          console.log(`   ${colors.gray}   Log: ${logFile}${colors.reset}`);

          if (result.port) {
            const ready = await waitForAgentReady(`http://localhost:${result.port}`);
            if (!ready) {
              console.log(`   ${colors.yellow}⚠️  ${agent.name} did not become ready within 8s — first /ask may fail. Retry once it appears in /agents status.${colors.reset}`);
            }
          }

        } catch (err: any) {
          results.push({ name: agent.name, success: false, error: err.message });
          console.log(`   ${colors.red}❌ Error spawning local agent: ${err.message}${colors.reset}`);
        }
        continue;
      }

      // Standard agent deployment
      console.log(`\n${colors.gray}🚀 Deploying agent "${agent.name}"...${colors.reset}`);

      const payload: any = {
        name: agent.name,
        type: agent.type,  // 'claude' (default) or 'automator'
        model: agent.model,
        runtime: agent.runtime,
        plugins: agent.plugins,
        allowedTools: agent.allowedTools,
        agent: agent.agent,  // Library overlay name (resolves configs/agents/<agent>/ into the runtime overlay target)
        roleBody: agent.roleBody,  // Agent role from .claude/agents/<name>.md (resolved by processConfig)
        heartbeat: agent.heartbeat,  // Number (seconds) or {interval, message} for legacy
        address: agent.address,
        metadata: {
          description: agent.description,
          runtime: agent.runtime,
          plugins: agent.plugins,
          allowed_tools: agent.allowedTools
        }
      };

      try {
        const response = await managerFetch('/agents/spawn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const error: any = await response.json();
          results.push({ name: agent.name, success: false, error: error.error || 'Unknown error' });
          console.log(`   ${colors.red}❌ Failed: ${error.error}${colors.reset}`);
        } else {
          const result: any = await response.json();
          results.push({ name: agent.name, success: true });
          console.log(`   ${colors.green}✅ Deployed: ${result.name} on port ${result.port}${colors.reset}`);

          if (result.port) {
            const ready = await waitForAgentReady(`http://localhost:${result.port}`);
            if (!ready) {
              console.log(`   ${colors.yellow}⚠️  ${agent.name} did not become ready within 8s — first /ask may fail. Retry once it appears in /agents status.${colors.reset}`);
            }
          }

        }
      } catch (err: any) {
        results.push({ name: agent.name, success: false, error: err.message });
        console.log(`   ${colors.red}❌ Error: ${err.message}${colors.reset}`);
      }
    }

    // Summary
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`\n${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}Deployment Summary${colors.reset}`);
    console.log(`   ${colors.green}✅ Successful: ${successful}${colors.reset}`);
    if (failed > 0) {
      console.log(`   ${colors.red}❌ Failed: ${failed}${colors.reset}`);
    }
    console.log(`${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

    // Keep the config team active after successful deploy so /ask, /agents etc. work against it.
    if (configTeam && activeTeam !== savedTeam && successful > 0) {
      console.log(`${colors.green}   Active team switched to "${configTeam}"${colors.reset}\n`);
      await ensureCliTracksEffectiveTeam(configTeam);
    } else if (activeTeam !== savedTeam && successful === 0) {
      // Restore if nothing deployed successfully
      activeTeam = savedTeam;
      activeServerName = savedTeam;
      console.log(`${colors.gray}   Restored active team: ${savedTeam} (no agents deployed)${colors.reset}\n`);
    }

  } catch (error: any) {
    activeTeam = savedTeam;  // Restore on error
    activeServerName = savedTeam;
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

async function dryRunDeploy(filePath: string, args: string[] = []) {
  console.log(`\n${colors.gray}📄 Dry run config: ${filePath}${colors.reset}`);
  if (args.length > 0) {
    console.log(`${colors.gray}   Parameters: ${args.join(' ')}${colors.reset}`);
  }

  const command = `/deploy ${filePath} ${args.join(' ')} --dry-run`.replace(/\s+/g, ' ').trim();
  const response = await managerFetch('/remote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command })
  });

  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = data.error || `Dry run failed: ${response.statusText}`;
    console.log(`\n${colors.red}❌ ${error}${colors.reset}\n`);
    return;
  }

  const result = data.result || {};
  const agents: any[] = result.agents || [];

  console.log(`${colors.green}✅ Dry run passed${colors.reset}`);
  console.log(`${colors.gray}   Team: ${result.teamName || activeTeam}${colors.reset}`);
  console.log(`${colors.gray}   Config: ${result.configPath || filePath}${colors.reset}`);
  console.log(`${colors.gray}   Agents: ${agents.length}${colors.reset}`);
  if (typeof result.calendarCount === 'number') {
    console.log(`${colors.gray}   Calendar events: ${result.calendarCount}${colors.reset}`);
  }

  for (const agent of agents) {
    console.log(`\n${colors.cyan}${agent.name}${colors.reset}`);
    console.log(`   ${colors.gray}Type:${colors.reset} ${agent.type}`);
    console.log(`   ${colors.gray}Runtime:${colors.reset} ${agent.runtime}`);
    console.log(`   ${colors.gray}Model:${colors.reset} ${agent.model}`);
    console.log(`   ${colors.gray}Local:${colors.reset} ${agent.local ? 'yes' : 'no'}`);
    console.log(`   ${colors.gray}Workdir:${colors.reset} ${agent.workingDirectory}`);
  }

  console.log('');
}

async function resolveAgent(agentNameOrId: string): Promise<any | null> {
  try {
    // First try the resolve endpoint for identifier-based lookup
    const resolveResponse = await managerFetch(`/agents/resolve/${encodeURIComponent(agentNameOrId)}`);

    if (resolveResponse.ok) {
      const data: any = await resolveResponse.json();

      // Handle ambiguous matches - fail and ask for specific ID
      if (data.ambiguous) {
        console.log(`\n${colors.red}❌ Multiple agents match "${agentNameOrId}":${colors.reset}`);
        data.agents.forEach((a: any, i: number) => {
          const displayId = a.domain || a.displayId || a.name || a.id;
          const status = a.status || 'unknown';
          console.log(`   ${i + 1}. ${colors.cyan}${displayId}${colors.reset} (${status})`);
        });
        console.log(`\n${colors.yellow}Please use a specific identifier:${colors.reset}`);
        const firstAgent = data.agents[0];
        const firstDisplay = firstAgent?.domain || firstAgent?.displayId || firstAgent?.name;
        console.log(`   ${colors.gray}• By name: ${colors.cyan}/ask ${firstDisplay} <message>${colors.reset}`);
        console.log(`   ${colors.gray}• By agent ID: ${colors.cyan}/ask ${firstAgent?.id} <message>${colors.reset}\n`);
        return null;
      }

      return data.agent;
    }

    // Fall back to listing agents for backwards compatibility
    const listResponse = await managerFetch('/agents');
    if (!listResponse.ok) {
      console.log(`\n${colors.red}❌ Could not fetch agents${colors.reset}\n`);
      return null;
    }

    const data: any = await listResponse.json();
    const needle = agentNameOrId.toLowerCase();
    const agents: any[] = Array.isArray(data.agents) ? data.agents : [];

    // Check for multiple name matches (also check alias for pre-registration local names)
    const byName = agents.filter((a: any) =>
      String(a.name || '').toLowerCase() === needle ||
      String(a.alias || '').toLowerCase() === needle
    );
    if (byName.length > 1) {
      console.log(`\n${colors.red}❌ Multiple agents match "${agentNameOrId}":${colors.reset}`);
      byName.forEach((a: any, i: number) => {
        const displayId = a.domain || a.displayId || a.name || a.id;
        const status = a.status || 'unknown';
        console.log(`   ${i + 1}. ${colors.cyan}${displayId}${colors.reset} (${status})`);
      });
      console.log(`\n${colors.yellow}Please use a specific identifier:${colors.reset}`);
      const first = byName[0];
      const firstDisplay = first?.domain || first?.displayId || first?.name;
      console.log(`   ${colors.gray}• By name: ${colors.cyan}/ask ${firstDisplay} <message>${colors.reset}`);
      console.log(`   ${colors.gray}• By agent ID: ${colors.cyan}/ask ${first?.id} <message>${colors.reset}\n`);
      return null;
    }

    // Prefer handle match over display-name match to avoid collisions like onchain agents whose metadata.name is "manager".
    const byId = agents.find((a: any) => String(a.id || '').toLowerCase() === needle);
    const byHandle = agents.find((a: any) => String(a.name || '').toLowerCase() === needle);
    // Also check alias (original local name before registration)
    const byAlias = agents.find((a: any) => String(a.alias || '').toLowerCase() === needle);
    const byDisplay = agents.find((a: any) => String(a?.metadata?.name || '').toLowerCase() === needle);
    // Also check displayId for new identifier format
    const byDisplayId = agents.find((a: any) => String(a.displayId || '').toLowerCase() === needle);
    const agent = byId || byHandle || byAlias || byDisplayId || byDisplay;

    if (!agent) {
      console.log(`\n${colors.red}❌ Agent "${agentNameOrId}" not found${colors.reset}`);
      console.log(
        `${colors.gray}Available agents: ${data.agents
          .map((a: any) => a.displayId || a?.metadata?.name || a.name)
          .join(', ')}${colors.reset}\n`
      );
      return null;
    }

    return agent;
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
    return null;
  }
}


async function checkAgentNews(agentName: string) {
  try {
    // Special case: check manager's own news feed
    if (agentName.toLowerCase() === 'manager' || agentName.toLowerCase() === name.toLowerCase()) {
      console.log(`\n${colors.gray}📰 Checking manager's news feed...${colors.reset}\n`);

      // Use managerFetch to hit the manager's /news endpoint (not the CLI's own port)
      const response = await managerFetch('/news?since=0&limit=10');
      
      if (!response.ok) {
        console.log(`${colors.red}❌ Failed to fetch news: ${response.status} ${response.statusText}${colors.reset}\n`);
        return;
      }

      const data: any = await response.json();
      const items = data.items || [];

      if (items.length === 0) {
        console.log(`${colors.yellow}📭 No news items found${colors.reset}\n`);
        return;
      }

      // Show the most recent item
      const mostRecent = items[0];
      const timestamp = new Date(mostRecent.timestamp).toLocaleTimeString();
      
      console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
      console.log(`${colors.bold}📰 Most Recent Update${colors.reset}`);
      console.log(`${colors.gray}Time: ${timestamp}${colors.reset}`);
      console.log(`${colors.gray}Type: ${mostRecent.type}${colors.reset}\n`);
      
      if (mostRecent.message) {
        console.log(`${mostRecent.message}\n`);
      }
      
      if (mostRecent.data) {
        console.log(`${colors.gray}Data: ${JSON.stringify(mostRecent.data, null, 2)}${colors.reset}\n`);
      }
      
      console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
      return;
    }

    console.log(`\n${colors.gray}🔍 Looking for agent "${agentName}"...${colors.reset}`);
    const agent = await resolveAgent(agentName);
    if (!agent) return;

    console.log(`${colors.green}✓${colors.reset} Found ${getAgentDisplayName(agent)}\n`);

    const response = await fetch(`${agent.url}/news?since=0&limit=50`);

    if (!response.ok) {
      console.log(`${colors.red}❌ Failed to fetch news: ${response.status} ${response.statusText}${colors.reset}\n`);
      return;
    }

    const data: any = await response.json();
    const items = data.items || [];

    if (items.length === 0) {
      console.log(`${colors.yellow}📭 No news items found${colors.reset}\n`);
      return;
    }

    // Get the session ID if we have one
    const sessionId = agentSessions.get(agent.name);

    // Try to find relevant items first, but show most recent if none found
    let relevantItems = items;
    if (sessionId) {
      const filtered = items.filter((item: any) =>
        item.data?.session_id === sessionId ||
        item.data?.query_id?.includes(sessionId)
      );
      if (filtered.length > 0) {
        relevantItems = filtered;
        console.log(`${colors.gray}📰 Checking news for your session: ${sessionId}${colors.reset}\n`);
      } else {
        console.log(`${colors.gray}📰 Showing most recent news (no session-specific items found)${colors.reset}\n`);
      }
    } else {
      console.log(`${colors.gray}📰 Showing most recent news${colors.reset}\n`);
    }

    // Show the most recent item
    const mostRecent = relevantItems[0];
    const timestamp = new Date(mostRecent.timestamp).toLocaleTimeString();
    
    console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}📰 Most Recent Update from ${getAgentDisplayName(agent)}${colors.reset}`);
    console.log(`${colors.gray}Time: ${timestamp}${colors.reset}`);
    console.log(`${colors.gray}Type: ${mostRecent.type}${colors.reset}\n`);
    
    if (mostRecent.message) {
      console.log(`${mostRecent.message}\n`);
    }
    
    if (mostRecent.data?.result) {
      console.log(`${colors.green}Result:${colors.reset}`);
      console.log(`${mostRecent.data.result}\n`);
    }
    
    console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

async function showMyNews() {
  try {
    console.log(`\n${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}📰 Your News Feed (${name})${colors.reset}\n`);

    const items = await getManagerNewsItems(15);

    if (items.length === 0) {
      console.log(`${colors.yellow}📭 No news items yet${colors.reset}`);
      console.log(`${colors.gray}News appears when you send/receive messages${colors.reset}\n`);
      console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
      return;
    }

    items.forEach((item: any, index: number) => {
      const timestamp = new Date(item.timestamp).toLocaleTimeString();
      const typeColor = item.type.startsWith('outbound') ? colors.cyan
                      : item.type === 'reply' ? colors.green
                      : item.type === 'response.saved' ? colors.yellow
                      : colors.gray;

      console.log(`${colors.gray}[${timestamp}]${colors.reset} ${typeColor}${item.type}${colors.reset}`);

      // Show relevant details based on type
      if (item.data?.from) {
        console.log(`   ${colors.gray}From:${colors.reset} ${item.data.from}`);
      }
      if (item.data?.to) {
        console.log(`   ${colors.gray}To:${colors.reset} ${item.data.to}`);
      }
      if (item.data?.in_reply_to) {
        console.log(`   ${colors.gray}Reply to:${colors.reset} ${item.data.in_reply_to}`);
      }

      // Show message preview
      const msg = item.data?.message || item.message;
      if (msg) {
        const preview = msg.length > 80 ? msg.substring(0, 80) + '...' : msg;
        console.log(`   ${colors.gray}Message:${colors.reset} ${preview}`);
      }

      console.log('');
    });

    console.log(`${colors.gray}Showing ${items.length} most recent items${colors.reset}`);
    console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  } catch (error: any) {
    console.log(`${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

async function showAgentNewsTop(agentName: string, long: boolean = false) {
  // Helper to display a news item
  const displayNewsItem = (item: any, index: number) => {
    const timestamp = new Date(item.timestamp).toLocaleTimeString();
    console.log(`${colors.cyan}${index + 1}.${colors.reset} ${colors.gray}[${timestamp}]${colors.reset} ${colors.yellow}${item.type}${colors.reset}`);

    if (item.message) {
      const maxLen = long ? 500 : 100;
      const truncated = item.message.length > maxLen
        ? item.message.substring(0, maxLen) + '...'
        : item.message;
      console.log(`   ${truncated}`);
    }

    // In long mode, show data.message content too (the actual message body)
    if (long && item.data?.message && item.data.message !== item.message) {
      const msgContent = item.data.message;
      const maxLen = 500;
      const truncated = msgContent.length > maxLen
        ? msgContent.substring(0, maxLen) + '...'
        : msgContent;
      console.log(`   ${colors.green}Content:${colors.reset} ${truncated}`);
    }

    if (item.data?.query_id) {
      console.log(`   ${colors.gray}Query: ${item.data.query_id}${colors.reset}`);
    }

    if (item.data?.from) {
      console.log(`   ${colors.gray}From: ${item.data.from}${colors.reset}`);
    }

    if (long && item.data?.in_reply_to) {
      console.log(`   ${colors.gray}In reply to: ${item.data.in_reply_to}${colors.reset}`);
    }

    console.log('');
  };

  try {
    // Special case: check manager's own news feed
    if (agentName.toLowerCase() === 'manager' || agentName.toLowerCase() === name.toLowerCase()) {
      console.log(`\n${colors.gray}📰 Fetching manager's recent news...${colors.reset}\n`);

      // Use managerFetch to hit the manager's /news endpoint (not the CLI's own port)
      const response = await managerFetch('/news?since=0&limit=10');

      if (!response.ok) {
        console.log(`${colors.red}❌ Failed to fetch news: ${response.status} ${response.statusText}${colors.reset}\n`);
        return;
      }

      const data: any = await response.json();
      const items = data.items || [];

      if (items.length === 0) {
        console.log(`${colors.yellow}📭 No news items found${colors.reset}\n`);
        return;
      }

      console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
      console.log(`${colors.bold}📰 Recent News from Manager${colors.reset}${long ? ' (long)' : ''}`);
      console.log(`${colors.gray}Showing ${items.length} most recent items${colors.reset}\n`);

      items.forEach((item: any, index: number) => displayNewsItem(item, index));

      console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
      return;
    }

    console.log(`\n${colors.gray}🔍 Looking for agent "${agentName}"...${colors.reset}`);
    const agent = await resolveAgent(agentName);
    if (!agent) return;

    console.log(`${colors.green}✓${colors.reset} Found ${getAgentDisplayName(agent)}\n`);
    console.log(`${colors.gray}📰 Fetching recent news...${colors.reset}\n`);

    const response = await fetch(`${agent.url}/news?since=0&limit=10`);

    if (!response.ok) {
      console.log(`${colors.red}❌ Failed to fetch news: ${response.status} ${response.statusText}${colors.reset}\n`);
      return;
    }

    const data: any = await response.json();
    const items = data.items || [];

    if (items.length === 0) {
      console.log(`${colors.yellow}📭 No news items found${colors.reset}\n`);
      return;
    }

    console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}📰 Recent News from ${getAgentDisplayName(agent)}${colors.reset}${long ? ' (long)' : ''}`);
    console.log(`${colors.gray}Showing ${items.length} most recent items${colors.reset}\n`);

    items.forEach((item: any, index: number) => displayNewsItem(item, index));

    console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
    if (!long) {
      console.log(`${colors.gray}💡 Use /news top -l ${getAgentDisplayName(agent)} to see full message content${colors.reset}\n`);
    }
  } catch (error: any) {
    console.log(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
  }
}

rl.on('close', () => {
  console.log(`\n${colors.green}👋 Goodbye!${colors.reset}\n`);
  process.exit(0);
});
