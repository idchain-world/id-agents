// SPDX-License-Identifier: MIT
/**
 * Agent Manager (DB-backed)
 *
 * Persistent manager that stores agents/metadata in Postgres with multi-network scoping.
 * Runtime (live HTTP servers) still live in-memory, but all durable state is in the DB.
 *
 * Wallet management: agents no longer have individual wallets stored in the DB.
 * OWS wallets are provisioned per-agent on opt-in (metadata.wallet === true).
 * Per-agent keys can be provided via .env.<agent_id> files in the repo root.
 */

import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { homedir } from 'os';
import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, copyFileSync, statSync, openSync, closeSync } from 'fs';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import yaml from 'js-yaml';
import { AgentRestServer } from './agent-rest-server.js';
import { defaultDeliverFn, redactSshTarget, type DeliverFn } from './lib/ssh-deliver.js';
import { probeRemoteAgent, defaultHealthProbeFn, type HealthProbeFn } from './lib/remote-heartbeat.js';
import { filterClaudeEnvVars } from './lib/env-hygiene.js';
import { LIVE_TEAM_CHANGE_HINT, SYNC_REMOVED_MESSAGE } from './lib/sync-removed.js';
import {
  agentWorkdirRoots,
  auditWorkdirs,
  formatWorkdirAudit,
  PROJECTS_ROOT_ENV,
  resolveWithinRoots,
} from './lib/path-policy.js';
import { type Db } from './db/db-service.js';
import type { AgentRow, ScheduleDefinitionRow, TaskRow } from './db/types.js';
import fetch from 'node-fetch';
import type { AgentHandles, PluginConfig, DeployConfig, HeartbeatConfig, CalendarSpec, ScheduleDeliveryMode, OrgConfig } from './config-parser.js';
import { PROFILE_BIO_MAX_LENGTH, validateAgentHandles } from './config-parser.js';
import { writeProfileToConfig } from './lib/profile-config-write.js';
import { importAvatars } from './lib/import-avatars.js';
import {
  exportTeamConfig,
  resolveExportPath,
  type ScheduleLike,
} from './lib/export-team-config.js';
import {
  autoExportPath,
  createAutoExporter,
  DEFAULT_AUTOEXPORT_DEBOUNCE_MS,
  type AutoExporter,
} from './lib/auto-export.js';
import {
  processConfig,
  copyAgentDirOverlay,
  copyHeartbeatMd,
  copyLibraryAgentOverlay,
  appendLibraryPersonaToAgentsMd,
  writePersonalityFile,
} from './config-parser.js';
import {
  getLibraryAgent,
  getLibrarySkill,
  getLibraryTeam,
  listLibraryAgents,
  listLibrarySkills,
  listLibraryTeams,
  resolveDefaultLibraryRoot,
} from './lib/library-inventory.js';
import {
  installLibraryTeam,
  parseSelector,
} from './lib/library-install.js';
import { PROTOCOL_DEFAULTS } from './protocol-defaults.js';
import { computeSyncPlan, formatSyncSummary, formatSyncVerbose } from './sync.js';
import { validateName } from './name-validation.js';
import {
  emitQueryDelivered,
  emitQueryExpired,
  emitQueryFailed,
  emitTaskClaimed,
  emitTaskCompleted,
  recordCheckinCreated,
} from './wakeup-service/event-producer.js';
import { RetentionService } from './wakeup-service/retention.js';
import { CheckinService } from './checkins/checkin-service.js';
import {
  DEFAULT_CLOSE_WHEN,
  DEFAULT_INTERVAL_SECONDS,
  buildCheckinResponse,
  clampNote,
  generateCheckinId,
  isValidPriority,
  parseDurationSeconds,
  parseStatusFilter,
} from './checkins/checkin-api-helpers.js';
import { closeLinkedCheckinsForTerminalTask } from './checkins/checkin-autoclose.js';
import type { CheckinRow } from './db/types.js';
import { parseAgentRef, normalizeAlias, buildAmbiguityWarning, type AgentMatch } from './core/agent-identifier.js';
import { resolveNewsTrigger } from './core/messaging-service.js';
import { isCodexReasoningEffort, isHarnessType, CODEX_REASONING_EFFORTS, HARNESS_TYPES, type CodexReasoningEffort, type HarnessType } from './harness/types.js';
import { SchedulerService, synthesizeForceHeartbeat } from './scheduling/scheduler-service.js';
import type { DispatchTarget } from './scheduling/schedule-types.js';
import { heartbeatToSchedule, heartbeatScheduleId, calendarToSchedule, validateIntervalSeconds, HEARTBEAT_GENERIC_MESSAGE } from './scheduling/schedule-config.js';
import {
  getAvailableRuntimes,
  getDefaultModelForRuntime,
  getDefaultRuntime,
  getRuntimePaths,
  isRemoteEndpointRuntime,
  isRuntimeId,
  resolveRuntime,
  runtimeIssueHint,
  validateRuntimePreflight,
} from './runtime/registry.js';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Model alias resolution (canonical source in core/model-aliases.ts;
// re-exported here for back-compat with existing import sites).
import { MODEL_ALIASES, resolveModelAlias } from './core/model-aliases.js';
import { configNotFoundError, resolveConfigPath, type ConfigLookup } from './core/config-paths.js';
export { MODEL_ALIASES, resolveModelAlias };

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    tokens.push(value.replace(/\\(["'])/g, '$1'));
  }
  return tokens;
}

function normalizeConfigSkills(skills: unknown): string[] | undefined {
  if (!Array.isArray(skills)) return undefined;

  const normalized = Array.from(
    new Set(
      skills
        .filter((skill): skill is string => typeof skill === 'string')
        .map(skill => skill.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    ),
  );

  return normalized.length > 0 ? normalized : undefined;
}

// REST-AP catalog types
interface RestAPCatalog {
  restap_version?: string;
  agent?: {
    name?: string;
    description?: string;
  };
  endpoints?: {
    talk?: string;
    news?: string;
    news_post?: string;
    schedule?: string;
  } | Array<{
    path?: string;
    method?: string;
  }>;
  capabilities?: Array<{
    id: string;
    method: string;
    endpoint: string;
  }>;
}


/**
 * Wakeup-service topic aliases. The `GET /events` route accepts both
 * concrete topics (e.g. `query:delivered`) and the aliases below, which
 * expand server-side into their concrete topic set. Source of truth:
 * output/wakeup-service-design.md → "Topic set for v1" / "Alias expansions".
 */
const TOPIC_ALIASES: Record<string, readonly string[]> = {
  'query:terminal': ['query:delivered', 'query:failed', 'query:expired'],
  'task:status': ['task:created', 'task:claimed', 'task:completed'],
  'agent:lifecycle': ['agent:started', 'agent:stopped', 'agent:rebuild'],
};

function expandTopicAliases(topics: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of topics) {
    const expansion = TOPIC_ALIASES[t];
    if (expansion) {
      for (const concrete of expansion) out.add(concrete);
    } else {
      out.add(t);
    }
  }
  return Array.from(out);
}

/**
 * /talk-to auto-attach default cadence: 10 minutes. Tighter than the
 * generic checkin default (15m) because delegated work justifies more
 * frequent inspection on the dispatcher's side.
 */
const AUTO_ATTACH_DEFAULT_INTERVAL_SECONDS = 600;

interface AutoAttachFlagsResult {
  disabled: boolean;
  intervalSeconds: number | null;
  maxIterations: number | null;
  error?: string;
}

/**
 * Parse the three /talk-to auto-attach flags from the request body:
 *   - `no_checkin: true`           (--no-checkin)
 *   - `checkin: <duration|seconds>` (--checkin 30m / --checkin 1800)
 *   - `checkin_iters: <N>`          (--checkin-iters 5)
 *
 * Returns either a fully-resolved spec or an `error` code the route handler
 * can return as a 400 body. The returned `intervalSeconds` is null when
 * the caller did not override the default.
 */
function parseAutoAttachFlags(body: Record<string, unknown>): AutoAttachFlagsResult {
  const result: AutoAttachFlagsResult = {
    disabled: body.no_checkin === true,
    intervalSeconds: null,
    maxIterations: null,
  };

  if (body.checkin !== undefined && body.checkin !== null) {
    const parsed = parseDurationSeconds(body.checkin as unknown);
    if (parsed === null) {
      result.error = 'invalid_checkin_duration';
      return result;
    }
    result.intervalSeconds = parsed;
  }

  if (body.checkin_iters !== undefined && body.checkin_iters !== null) {
    const n = Number(body.checkin_iters);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      result.error = 'invalid_checkin_iters';
      return result;
    }
    result.maxIterations = n;
  }

  return result;
}

function makeAutoAttachError(status: number, code: string): Error & { status: number; code: string } {
  const err = new Error(code) as Error & { status: number; code: string };
  err.status = status;
  err.code = code;
  return err;
}

function getCatalogEndpoint(catalog: RestAPCatalog, key: 'talk' | 'news' | 'schedule'): string | null {
  if (catalog.endpoints && !Array.isArray(catalog.endpoints)) {
    return catalog.endpoints[key] || null;
  }
  if (Array.isArray(catalog.endpoints)) {
    const path = `/${key}`;
    const match = catalog.endpoints.find((entry) => entry.path === path);
    return match?.path || null;
  }
  return null;
}

// Cache for REST-AP catalogs (endpoint -> catalog)
const restapCatalogCache = new Map<string, { catalog: RestAPCatalog; fetchedAt: number }>();
const CATALOG_CACHE_TTL = 60000; // 1 minute cache

/**
 * Discover REST-AP endpoints from an agent's catalog
 * @param baseEndpoint The agent's base endpoint (e.g., http://localhost:4101)
 * @returns The discovered endpoints or defaults if catalog unavailable
 */
export async function discoverRestAPEndpoints(baseEndpoint: string): Promise<{ talk: string; news: string; schedule?: string | null }> {
  // After the manager-collapse refactor, "interactive" agents (e.g. manager-<team> rows)
  // have endpoint='' and port=0. A few caller paths fall back to `http://localhost:${port}`
  // which produces `http://localhost:0`, then catalog discovery fails noisily. Those rows
  // never had a per-agent HTTP server, so silently return defaults instead of fetching.
  if (!baseEndpoint || /:0(\/|$)/.test(baseEndpoint)) {
    return { talk: '/talk', news: '/news', schedule: null };
  }

  const now = Date.now();
  const cached = restapCatalogCache.get(baseEndpoint);

  // Return cached catalog if still valid
  if (cached && (now - cached.fetchedAt) < CATALOG_CACHE_TTL) {
    return {
      talk: getCatalogEndpoint(cached.catalog, 'talk') || '/talk',
      news: getCatalogEndpoint(cached.catalog, 'news') || '/news',
      schedule: getCatalogEndpoint(cached.catalog, 'schedule') || null
    };
  }

  try {
    const catalogUrl = `${baseEndpoint.replace(/\/+$/, '')}/.well-known/restap.json`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(catalogUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const catalog = await response.json() as RestAPCatalog;
      restapCatalogCache.set(baseEndpoint, { catalog, fetchedAt: now });

      return {
        talk: getCatalogEndpoint(catalog, 'talk') || '/talk',
        news: getCatalogEndpoint(catalog, 'news') || '/news',
        schedule: getCatalogEndpoint(catalog, 'schedule') || null
      };
    }
  } catch (err) {
    // Catalog fetch failed, use defaults
    console.log(`[REST-AP] Could not fetch catalog from ${baseEndpoint}: ${(err as Error).message}`);
  }

  // Default REST-AP endpoints
  return { talk: '/talk', news: '/news', schedule: null };
}

type AgentMetadata = Record<string, any> & {
  name?: string;
  service_type?: string;  // e.g., "REST-AP", "MCP", "A2A"
  service?: string;       // The service URL (e.g., https://idbot.live/{id})
  agent_account?: string;
};

// WebSocket client tracking
interface WSClient {
  ws: WebSocket;
  teamId: string;
  teamName: string;
  authenticated: boolean;
}

// Pending waiter for /talk-to replies - persists until reply arrives
interface QueryWaiter {
  resolve: (result: { from: string; message: string }) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
}

interface ProcessInspection {
  pid: number;
  ppid: number | null;
  argv0: string;
  commandLine: string;
}

export class AgentManagerDb {
  private managementApp: express.Application;
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private wsClients: Set<WSClient> = new Set();
  private baseWorkDir: string;
  private db: Db;
  private runningServers: Map<string, AgentRestServer> = new Map(); // key: `${teamId}:${agentId}`

  /**
   * §5.4 automatic export. Debounce is overridable via env so tests can drive
   * it without waiting 5s; production never sets it.
   */
  private autoExporter: AutoExporter = createAutoExporter({
    debounceMs: Number(process.env.ID_AUTOEXPORT_DEBOUNCE_MS) || DEFAULT_AUTOEXPORT_DEBOUNCE_MS,
    onError: (err, team) =>
      console.warn(`[AutoExport] team "${team}" failed: ${(err as Error)?.message || String(err)}`),
  });
  private agentRole: 'manager' | 'worker' = 'manager';
  private defaultConfig: DeployConfig['defaults'] | null = null;
  private schedulerService: SchedulerService | null = null;
  private queryWaiters: Map<string, QueryWaiter> = new Map(); // key: query_id
  // Long-poll waiters for GET /query/:id?wait=<seconds>. Wakes when a daemon-side
  // query write (news.in_reply_to completion, agent-stop cancel) transitions
  // the row. Sweeper-expired rows rely on the request's wait-timeout re-read.
  private queryStatusWaiters: Map<string, Set<() => void>> = new Map(); // key: `${teamId}:${queryId}`
  private healthStatus: Map<string, { status: 'online' | 'offline' | 'unknown'; lastCheck: number }> = new Map(); // key: `${teamId}:${agentId}`
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private remoteProbeInterval: NodeJS.Timeout | null = null;
  private querySweeperInterval: NodeJS.Timeout | null = null;
  private retentionService: RetentionService | null = null;
  private checkinService: CheckinService | null = null;
  /**
   * Stuck-query sweeper timeout, in minutes. Queries whose status is still
   * pending/processing this long after their `created` timestamp are assumed
   * to belong to a crashed agent and are marked 'expired'.
   * Starting conservatively at 15 minutes — if an agent is legitimately
   * working on something longer than this, the polling caller should be
   * treating it as abandoned anyway.
   */
  private readonly QUERY_EXPIRY_MINUTES = 15;
  private logBuffer: Array<{ ts: number; msg: string }> = [];
  private readonly LOG_BUFFER_SIZE = 500;
  private managementPort: number = 4100;
  /** Injectable SSH delivery function — override in tests. */
  private deliverFn: DeliverFn = defaultDeliverFn;
  /** Injectable HTTP probe function — override in tests to mock remote health checks. */
  private healthProbeFn: HealthProbeFn = defaultHealthProbeFn;
  /**
   * Library root used by the read-only `/library/*` endpoints. Captured at
   * construction so tests can override without touching process.env. Null
   * means "no library configured" — listings return empty, detail returns 404.
   */
  private libraryRoot: string | null;

  /** Log a manager activity message to the ring buffer (not stdout) */
  private managerLog(msg: string) {
    this.logBuffer.push({ ts: Date.now(), msg });
    if (this.logBuffer.length > this.LOG_BUFFER_SIZE) {
      this.logBuffer.shift();
    }
  }

  constructor(
    baseWorkDir: string = '/workspace',
    db: Db,
    opts?: {
      /** Override SSH delivery function (for tests). */
      deliverFn?: DeliverFn;
      /** Override remote health probe function (for tests). */
      healthProbeFn?: HealthProbeFn;
      /**
       * Override library root for the `/library/*` endpoints. Pass an
       * absolute path to serve a specific library, or `null` to force
       * empty-library behavior. When undefined, resolution falls back to
       * the default (`ID_LIBRARY_ROOT` env, else `<cwd>/configs`, else null).
       */
      libraryRoot?: string | null;
    },
  ) {
    this.baseWorkDir = baseWorkDir;
    this.db = db;
    if (opts?.deliverFn) this.deliverFn = opts.deliverFn;
    if (opts?.healthProbeFn) this.healthProbeFn = opts.healthProbeFn;
    this.libraryRoot =
      opts && Object.prototype.hasOwnProperty.call(opts, 'libraryRoot')
        ? (opts.libraryRoot ?? null)
        : resolveDefaultLibraryRoot();
    this.agentRole = (process.env.AGENT_ROLE as 'manager' | 'worker') || 'manager';

    // Load default deployment config
    this.loadDefaultConfig();

    this.managementApp = express();
    this.managementApp.use(express.json());

    // Ensure teams + manager dirs exist in the mounted workspace
    const teamsDir = `${baseWorkDir}/teams`;
    if (!existsSync(teamsDir)) mkdirSync(teamsDir, { recursive: true });
    const managerDir = `${baseWorkDir}/manager`;
    if (!existsSync(managerDir)) mkdirSync(managerDir, { recursive: true });

    this.setupRoutes();
  }

  /** Resolve a config path against every plausible root. See core/config-paths. */
  private resolveConfigPath(filePath: string): ConfigLookup {
    return resolveConfigPath(filePath, { baseWorkDir: this.baseWorkDir });
  }

  /** Error text for a config lookup that missed, naming every path tried. */
  private configNotFoundError(filePath: string, searched: string[]): string {
    return configNotFoundError(filePath, searched);
  }

  /**
   * Load default deployment configuration from configs/default.yaml
   */
  private loadDefaultConfig(): void {
    // Try multiple possible locations for the default config
    const configPaths = [
      path.join(process.cwd(), 'configs/default.yaml'),  // Local development
      path.join(__dirname, '../configs/default.yaml')    // Relative to dist
    ];

    for (const configPath of configPaths) {
      if (existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, 'utf-8');
          const config = yaml.load(content) as DeployConfig;
          this.defaultConfig = config?.defaults || null;
          console.log(`[AgentManager] Loaded default config from ${configPath}`);
          if (this.defaultConfig?.plugins) {
            console.log(`[AgentManager] Default plugins: ${this.defaultConfig.plugins.map(p => p.name).join(', ')}`);
          }
          return;
        } catch (error) {
          console.warn(`[AgentManager] Failed to load config from ${configPath}:`, error);
        }
      }
    }

    console.warn('[AgentManager] No default config found, agents will have no default plugins');
  }

  /**
   * Get default plugins from config (or empty array if none)
   */
  private getDefaultPlugins(): PluginConfig[] {
    return this.defaultConfig?.plugins || [];
  }

  /**
   * Get default model from config (or fallback)
   */
  private getDefaultModel(): string {
    return getDefaultModelForRuntime(getDefaultRuntime(), this.defaultConfig?.model);
  }

  private ensureRuntimeReady(runtime: HarnessType | string | undefined, model?: string): void {
    const issues = validateRuntimePreflight(runtime, model);
    if (issues.length > 0) {
      throw new Error(issues.map(issue => runtimeIssueHint(issue.code) || issue.message).join('; '));
    }
  }

  private async buildDeployPreflightSummary(
    teamId: string,
    teamName: string,
    absolutePath: string,
    deployArgs: string[]
  ): Promise<{
    agents: Array<{
      name: string;
      type: string;
      runtime: string;
      model: string;
      local: boolean;
      workingDirectory: string;
    }>;
    configPath: string;
    teamName: string;
    calendarCount: number;
  }> {
    const { agents, calendar, errors, teamName: configTeam } = processConfig(absolutePath, this.baseWorkDir, deployArgs);

    let effectiveTeamId = teamId;
    let effectiveTeamName = teamName;
    if (configTeam && configTeam !== teamName) {
      effectiveTeamId = await this.db.teams.getOrCreateTeamId(configTeam);
      effectiveTeamName = configTeam;
    }

    if (errors.length > 0) {
      throw new Error(`Config errors: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
    }

    if (agents.length === 0) {
      throw new Error('No agents defined in config');
    }

    const summarizedAgents = agents.map((agentConfig, index) => {
      const effectiveRuntime = resolveRuntime(agentConfig.runtime) as HarnessType;
      const effectiveModel = agentConfig.model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
      this.ensureRuntimeReady(effectiveRuntime, effectiveModel);

      const previewId = `preview_${Date.now()}_${index}`;
      const workingDirectory = agentConfig.workingDirectory && path.isAbsolute(agentConfig.workingDirectory)
        ? agentConfig.workingDirectory
        : `${this.baseWorkDir}/agents/${previewId}`;

      return {
        name: agentConfig.name,
        type: agentConfig.type || 'claude',
        runtime: effectiveRuntime,
        model: effectiveModel,
        local: agentConfig.local === true,
        workingDirectory,
      };
    });

    return {
      agents: summarizedAgents,
      configPath: absolutePath,
      teamName: effectiveTeamName,
      calendarCount: calendar.length,
    };
  }

  /**
   * Build environment variables for worker agent
   */
  private buildWorkerEnv(teamId: string, teamName: string, agent: AgentRow): Record<string, string> {
    const plugins = agent.metadata?.plugins || [];
    // After registration, agent.name is the ENS domain; the original local
    // alias is stored in metadata.alias.  Use that for ID_AGENT_ALIAS so
    // normalizeAlias() doesn't mangle the ENS domain.
    const agentAlias = (agent.metadata as any)?.alias || agent.name;
    const domain = (agent.metadata as any)?.idchain_domain;
    // After registration, name is the ENS domain; before registration, just the local alias
    const fullName = domain || agentAlias;
    const env: Record<string, string> = {
      ID_AGENT_NAME: fullName,
      ID_AGENT_ALIAS: agentAlias,
      ID_AGENT_TOKEN_ID: agent.token_id || '',
      ID_AGENT_PORT: String(agent.port || ''),
      ID_TEAM: teamName,
      ID_PROJECT: teamName, // deprecated, use ID_TEAM
      ID_SHARED_DIR: `${this.baseWorkDir}/teams/${teamName}`,
      ID_DB_TEAM_ID: teamId,
      ID_DB_AGENT_ID: agent.id,
      ID_HARNESS: resolveRuntime((agent.runtime || agent.metadata?.runtime) as string | undefined),
      ID_PLUGINS: JSON.stringify(plugins)
    };

    // Add talkTimeout setting from metadata (default timeout for /talk-to requests)
    if (agent.metadata?.talkTimeout) {
      env.ID_TALK_TIMEOUT = String(agent.metadata.talkTimeout);
    }
    if (typeof agent.metadata?.effort === 'string') {
      env.ID_AGENT_EFFORT = agent.metadata.effort;
    }

    return env;
  }

  /**
   * Copy a plugin to an agent's working directory
   * Returns the new local path for the plugin
   */
  private copyPluginToAgent(plugin: PluginConfig, agentWorkDir: string): string {
    const pluginsDir = path.join(agentWorkDir, 'plugins');
    const targetDir = path.join(pluginsDir, plugin.name);

    // Create plugins directory if it doesn't exist
    if (!existsSync(pluginsDir)) {
      mkdirSync(pluginsDir, { recursive: true });
    }

    // Resolve source path (handle both absolute and relative paths)
    let sourcePath = plugin.path;
    if (!path.isAbsolute(sourcePath)) {
      // Try multiple possible locations
      const possiblePaths = [
        path.join('/app', sourcePath),
        path.join(process.cwd(), sourcePath),
        path.join(__dirname, '..', sourcePath)
      ];
      for (const p of possiblePaths) {
        if (existsSync(p)) {
          sourcePath = p;
          break;
        }
      }
    }

    if (!existsSync(sourcePath)) {
      console.warn(`[AgentManager] Plugin source not found: ${plugin.path}`);
      return plugin.path; // Return original path if source not found
    }

    // Copy plugin directory recursively
    this.copyDirRecursive(sourcePath, targetDir);
    console.log(`[AgentManager] Copied plugin ${plugin.name} to ${targetDir}`);

    return targetDir;
  }

  /**
   * Recursively copy a directory
   */
  private copyDirRecursive(src: string, dest: string): void {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }

    const entries = readdirSync(src);
    for (const entry of entries) {
      const srcPath = path.join(src, entry);
      const destPath = path.join(dest, entry);

      const stat = statSync(srcPath);
      if (stat.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Copy plugins to agent's working directory and return updated plugin configs with local paths
   */
  private copyPluginsToAgent(plugins: PluginConfig[], agentWorkDir: string): PluginConfig[] {
    return plugins.map(plugin => ({
      name: plugin.name,
      path: this.copyPluginToAgent(plugin, agentWorkDir)
    }));
  }

  private getTeamName(req: express.Request): string {
    // New headers/params (preferred)
    const header = req.headers['x-id-team'];
    const headerName = Array.isArray(header) ? header[0] : header;
    const queryName = typeof req.query.team === 'string' ? req.query.team : undefined;
    // Backwards compatibility: also accept the previous "project" naming.
    const oldProjectHeader = req.headers['x-id-project'];
    const oldProjectHeaderName = Array.isArray(oldProjectHeader) ? oldProjectHeader[0] : oldProjectHeader;
    const oldProjectQueryName = typeof req.query.project === 'string' ? req.query.project : undefined;
    const resolved = (
      headerName ||
      queryName ||
      oldProjectHeaderName ||
      oldProjectQueryName ||
      process.env.ID_TEAM ||
      process.env.ID_PROJECT ||
      'default'
    ).toString();
    // Validate team name to prevent path traversal
    if (!/^[a-zA-Z0-9_.-]+$/.test(resolved)) {
      throw new Error(`Invalid team name: "${resolved}". Only letters, numbers, hyphens, dots, and underscores allowed.`);
    }
    return resolved;
  }

  /**
   * Whether the request explicitly specified a team via header or query.
   * Used by task endpoints to decide if it's safe to fall back to the
   * caller's own team when the caller isn't found in the default team —
   * a team header always wins, so cross-team guards still hold.
   */
  private isTeamExplicit(req: express.Request): boolean {
    return !!(
      req.headers['x-id-team'] ||
      req.headers['x-id-project'] ||
      (typeof req.query.team === 'string' && req.query.team) ||
      (typeof req.query.project === 'string' && req.query.project)
    );
  }

  /**
   * Resolve a caller agent globally when the request omitted the team
   * header. Returns the matching agent row and its team only when the
   * lookup is unambiguous across teams.
   */
  private async resolveCallerAcrossTeams(ref: string): Promise<{ agent: AgentRow; teamId: string } | undefined> {
    const matches = await this.db.agents.resolveAcrossTeams(ref);
    if (matches.length !== 1) return undefined;
    return { agent: matches[0], teamId: matches[0].team_id };
  }

  private async getTeam(req: express.Request): Promise<{ name: string; id: string }> {
    // If the middleware has already resolved the context, use it directly
    const ctx = (req as any).ctx;
    if (ctx?.teamId && ctx?.teamName) {
      return { name: ctx.teamName, id: ctx.teamId };
    }
    // Fallback: resolve inline (used for paths that bypass middleware)
    const name = this.getTeamName(req);
    const id = await this.db.teams.getOrCreateTeamId(name);
    // Ensure per-team directory exists (no cross-team shared files).
    const teamDir = `${this.baseWorkDir}/teams/${name}`;
    if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
    return { name, id };
  }

  private key(teamId: string, agentId: string) {
    return `${teamId}:${agentId}`;
  }

  /**
   * Resolve the logical manager inbox owner for a team.
   * Writes persist only `owner_kind` / `owner_id`; `inboxApiId` is the stable
   * external handle (`manager-<team>`) returned on HTTP surfaces.
   */
  private getManagerInboxRef(teamId: string, teamName: string): {
    inboxApiId: string;
    ownerKind: 'manager';
    ownerId: string;
  } {
    return {
      inboxApiId: `manager-${teamName}`,
      ownerKind: 'manager',
      ownerId: teamId,
    };
  }

  /**
   * Canonical "deliver this query" lifecycle. Single source of truth for the
   * success path of a manager-side query completion: writes the completed
   * status to the queries table, emits `query:delivered` to the wakeup-service
   * event log, wakes any long-poll `GET /query/:id?wait=` blockers, and
   * resolves any in-memory `/talk-to` waiter still parked on the query id.
   *
   * Both POST /news (in_reply_to success branch) and POST /manager/inbox/respond
   * route through this helper so the lifecycle has exactly one implementation
   * — adding a second path would let the two drift on event emission, waiter
   * wakeup, or status semantics. Failure (`reply.error`) uses
   * `queries.markFailed` + `emitQueryFailed` and shares only the waiter
   * wakeup primitives below (which apply to any terminal transition).
   *
   * Idempotent at the DB level: `queries.complete` is gated on `status =
   * 'pending'`, so repeated calls for the same query are no-ops on the row.
   * The event/waiter side effects still fire, mirroring the existing POST
   * /news behavior (see audit finding context above).
   */
  private async completeQueryDelivery(params: {
    teamId: string;
    queryId: string;
    occurredAt: number;
    resultPayload: Record<string, unknown>;
    waiterReply: { from: string; message: string };
    messagePreview: string | null;
  }): Promise<void> {
    const { teamId, queryId, occurredAt, resultPayload, waiterReply, messagePreview } = params;

    await this.db.queries.complete(teamId, queryId, occurredAt, resultPayload);

    const completedRow = await this.db.queries
      .getByQueryIdForTeam(teamId, queryId)
      .catch(() => null);
    if (completedRow && completedRow.status === 'completed') {
      await emitQueryDelivered(this.db.events, {
        teamId,
        queryId,
        agentId:
          completedRow.owner_kind === 'manager'
            ? null
            : completedRow.agent_id,
        occurredAt,
        messagePreview,
      });
    }

    this.wakeQueryWaiters(teamId, queryId, waiterReply);
  }

  /**
   * Wake the long-poll `GET /query/:id?wait=` blockers and resolve any
   * `/talk-to` waiter parked on this query id. Shared between
   * `completeQueryDelivery` (success) and the failure branch in POST /news so
   * neither path duplicates waiter logic.
   */
  private wakeQueryWaiters(
    teamId: string,
    queryId: string,
    waiterReply: { from: string; message: string },
  ): void {
    this.notifyQueryStatusWaiters(teamId, queryId);

    const waiter = this.queryWaiters.get(queryId);
    if (waiter) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      this.queryWaiters.delete(queryId);
      waiter.resolve(waiterReply);
      this.managerLog(`Resolved waiter for query ${queryId}`);
    }
  }

  /**
   * Redact sensitive fields from an agentToResponse result for non-admin callers.
   *
   * Top-level fields removed: ssh_target, internal_endpoint_url.
   * metadata keys removed: any key in SENSITIVE_META_KEYS list, plus any key
   * matching /private_?key/i or /secret/i as a safety net.
   */
  private static readonly SENSITIVE_META_KEYS = new Set([
    'auth_key_ref',
    'ows_wallet_seed',
    'ssh_private_key',
    'ssh_target',
    'internal_endpoint_url',
  ]);

  private static readonly SENSITIVE_META_REGEX = /private_?key|secret/i;

  private redactForNonAdmin<T extends Record<string, any>>(resp: T): T {
    // Remove top-level sensitive fields
    const out: any = { ...resp };
    delete out.ssh_target;
    delete out.internal_endpoint_url;

    // Deep-copy and strip sensitive metadata keys
    if (out.metadata && typeof out.metadata === 'object') {
      const meta: any = { ...out.metadata };
      for (const key of Object.keys(meta)) {
        if (
          AgentManagerDb.SENSITIVE_META_KEYS.has(key) ||
          AgentManagerDb.SENSITIVE_META_REGEX.test(key)
        ) {
          delete meta[key];
        }
      }
      out.metadata = meta;
    }

    return out as T;
  }

  /**
   * Convert an AgentRow to an API response object with identifier fields.
   * Pass opts.isAdmin = true for admin callers to receive the full unredacted record.
   */
  private agentToResponse(a: AgentRow, opts?: { isAdmin?: boolean }) {
    // Interactive CLI agents are reachable via the daemon's management port —
    // the daemon owns /talk and /news for them (see e3b30b9). The CLI's own
    // port (stored in a.endpoint) may not be listening, so wrapper lookups
    // that hit a.endpoint would silently fail. The daemon URL always works:
    // POST /news lands under the manager-inbox agent_id and GET /news reads
    // from the same row. Virtual agents keep their declared endpoint.
    const isRemote = isRemoteEndpointRuntime(a.runtime);
    const url = isRemote
      ? null
      : a.type === 'interactive'
        ? `http://localhost:${this.managementPort}`
        : a.type === 'virtual'
          ? a.endpoint
          : `http://localhost:${a.port}`;

    // After registration, a.name IS the ENS domain and the original local alias
    // is preserved in metadata.alias.
    const alias = (a.metadata as any)?.alias || normalizeAlias(a.name);
    const domain = a.domain || (a.metadata as any)?.idchain_domain;
    const displayId = domain || alias;

    // Lift metadata.pid to the top level so clients (TUI, health probes)
    // don't have to reach into metadata to batch per-agent RSS lookups.
    const metaPid = (a.metadata as { pid?: unknown } | undefined)?.pid;
    const pid = typeof metaPid === 'number' && Number.isFinite(metaPid) && metaPid > 0 ? metaPid : null;

    // Remote-endpoint agents have no local port or pid; health is derived from probe columns.
    const remoteFields = isRemote ? {
      port: null,
      pid: null,
      deploymentShape: 'remote-endpoint' as const,
      health: this.deriveRemoteHealth(a),
      customer_domain: a.customer_domain,
      public_endpoint_url: a.public_endpoint_url,
      internal_endpoint_url: a.internal_endpoint_url,
      ssh_target: a.ssh_target,
      last_seen: a.last_seen ?? null,
      last_probed_at: a.last_probed_at ?? null,
      last_error: a.last_error ?? null,
      consecutive_failures: a.consecutive_failures ?? 0,
    } : {
      deploymentShape: 'local-process' as const,
    };

    const full = {
      id: a.id,
      // name is the displayId (e.g., "agent-5.xid.eth") for inter-agent communication
      // alias is the base name (e.g., "agent") for backwards compatibility
      name: displayId,
      alias,
      model: a.model,
      port: a.port,
      pid,
      status: a.status,
      workingDirectory: a.working_directory,
      createdAt: a.created_at,
      type: a.type,
      runtime: a.runtime,
      url,
      metadata: a.metadata,
      // Identity fields
      tokenId: a.token_id,
      domain,
      displayId,
      // Health monitoring (overridden for remote agents above)
      ...this.getHealthForAgent(a),
      // Runtime shape — remote-endpoint agents override port/pid/health
      ...remoteFields,
    };

    return opts?.isAdmin === true ? full : this.redactForNonAdmin(full);
  }

  private async dbQueryAgentById(teamId: string, id: string): Promise<AgentRow | null> {
    const a = await this.db.agents.getById(id);
    if (!a) return null;
    if (a.team_id !== teamId) return null; // cross-team lookups invisible
    return a;
  }

  private async dbQueryAgentByNameMostRecent(teamId: string, name: string): Promise<AgentRow | null> {
    return this.db.agents.getByName(teamId, name);
  }

  /**
   * Body for a 404 when an agent lookup misses. Names the team that was
   * actually searched: a bare "Agent not found" reads identically whether the
   * name is wrong, the team is wrong, or the agent is gone, which sends
   * operators hunting the name when the real cause is a caller that fell back
   * to the default team. Discloses nothing new — the team name is the value
   * the caller supplied (or the documented default).
   */
  private agentNotFound(ref: string, teamName: string, detail?: string): { error: string } {
    const suffix = detail ? ` ${detail}` : '';
    return { error: `Agent "${ref}" not found in team "${teamName}"${suffix}` };
  }

  /**
   * The team's `org` block. THE single reader — spawn, /export and auto-export
   * all come through here, so there is one definition of where org lives.
   *
   * The database is the source of truth, so the teams row is preferred. Deploy
   * persists the parsed block there at create time.
   *
   * LEGACY FALLBACK: teams deployed before that persistence existed have no
   * org in the row, and their org would otherwise vanish from every export.
   * Those fall back to reading `last_config_path` — but never silently: the
   * caller gets a warning naming the file it had to reach for, because reading
   * a file behind the database's back is exactly the coupling this build is
   * removing, and it should be visible until those teams are re-exported.
   *
   * Any failure yields no org and no throw. A moved or unparseable config must
   * not stop an agent spawning or an export completing.
   */
  private async loadTeamOrg(
    teamId: string,
  ): Promise<{ org?: OrgConfig; warning?: string }> {
    let configPath: unknown;
    try {
      const teamConfig = await this.db.teams.getConfig(teamId);
      if (teamConfig.org) return { org: teamConfig.org as OrgConfig };
      configPath = teamConfig.last_config_path;
    } catch {
      return {};
    }

    if (typeof configPath !== 'string' || !configPath) return {};
    try {
      const parsed = yaml.load(readFileSync(configPath, 'utf-8')) as { org?: OrgConfig };
      if (!parsed?.org) return {}; // no org anywhere: nothing to report
      return {
        org: parsed.org,
        warning:
          `Team org block read from ${configPath} because it is not stored on the team row ` +
          `(team predates org persistence). Re-export or re-deploy to store it in the database.`,
      };
    } catch {
      return {}; // missing or unparseable — best effort, never fatal
    }
  }

  private async dbListAgents(teamId: string, includeAutomator: boolean = false): Promise<AgentRow[]> {
    return this.db.agents.list(teamId, includeAutomator);
  }

  /**
   * §5.4 — queue an automatic export after a team-composition mutation.
   *
   * Fire-and-forget by design. This returns immediately; the write happens
   * after the debounce window, by which point the triggering mutation has long
   * since responded. That ordering is what makes "auto-export failure never
   * fails the mutation" structural rather than a promise we have to keep at
   * every call site.
   *
   * Callers must NOT await this and must not wrap it in their own try/catch —
   * it cannot throw.
   */
  private scheduleAutoExport(teamId: string): void {
    this.autoExporter.schedule(teamId, async () => {
      const team = await this.db.teams.getTeam(teamId);
      if (!team) return; // team deleted between mutation and flush — nothing to write
      // listAll for the same completeness reason as the /export handler.
      const agents = await this.db.agents.listAll(teamId);
      const schedulesByAgent: Record<string, ScheduleLike[]> = {};
      for (const agent of agents) {
        schedulesByAgent[agent.name] = await this.db.schedules.listSchedulesForAgent(agent.id);
      }
      const { org: teamOrg } = await this.loadTeamOrg(teamId);
      exportTeamConfig({
        teamName: team.name,
        agents: agents as unknown as Parameters<typeof exportTeamConfig>[0]['agents'],
        // Hardcoded §5.4 shape. NOT resolveExportPath — that honours
        // last_config_path, which an automatic write must never touch.
        targetPath: autoExportPath(this.baseWorkDir, team.name),
        schedulesByAgent,
        org: teamOrg,
        // #f37ad05d — lets the exporter tell a generated workdir from an authored one.
        baseWorkDir: this.baseWorkDir,
      });
    });
  }

  private async rebuildLocalClaudeAgent(
    teamId: string,
    teamName: string,
    agent: AgentRow,
  ): Promise<{ success: boolean; pid?: number; logFile?: string; error?: string }> {
    await this.killAgentProcess(agent.port);
    await new Promise(r => setTimeout(r, 1000));
    const spawnResult = await this.spawnLocalAgentProcess(teamId, teamName, {
      name: agent.name, id: agent.id, port: agent.port,
      model: agent.model, workingDirectory: agent.working_directory ?? undefined,
      tokenId: agent.token_id ?? undefined
    });
    if (spawnResult.success) {
      await this.db.agents.updateStatus(agent.id, 'running');
    }
    return spawnResult;
  }

  /**
   * Resolve agents matching an identifier pattern
   * Returns all matches for ambiguity detection
   */
  /**
   * Write the two halves of "is this heartbeat on?" together, never separately.
   *
   * `metadata.heartbeat` and the schedule's `active` flag answer two different
   * questions — "should this agent be beating?" and "is this row firing?" — but
   * they are ONE fact and must not diverge. They are read by different queries:
   * `findHeartbeat()` reads the metadata flag, `listSchedulesForAgent()` filters
   * on `active`, and `listAllDefinitions()` (which feeds the Heartbeats view)
   * filters on neither. Setting only the metadata flag would leave `/heartbeat
   * <agent>` and `/heartbeats` listing an agent whose schedule lookup comes back
   * empty — a degraded row with runCount 0. Setting only `active` would leave the
   * agent out of those listings while its row kept the opposite flag.
   *
   * Hence one helper. Do not inline these two writes back into the call sites.
   *
   * Returns false when there is no schedule row to flip (a heartbeat disabled
   * before this became a pause was deleted outright, so first enable must seed).
   */
  private async setHeartbeatEnabled(agent: AgentRow, enabled: boolean): Promise<boolean> {
    await this.db.agents.updateMetadata(agent.id, { ...agent.metadata, heartbeat: enabled });
    const scheduleId = heartbeatScheduleId(agent.id);
    // By id, not `listSchedulesForAgent`: that query filters to active rows, so
    // it can never see the paused schedule we are trying to resume.
    if (!(await this.db.schedules.getDefinition(scheduleId))) return false;
    await this.db.schedules.setActive(scheduleId, enabled);
    this.scheduleAutoExport(agent.team_id); // §5.4 — schedule mutation
    return true;
  }

  private async dbResolveAgents(teamId: string, ref: string): Promise<AgentRow[]> {
    return this.db.agents.resolve(teamId, ref);
  }

  private async dbDeleteAgentRow(teamId: string, agentId: string): Promise<boolean> {
    const result = await this.db.adapter.query(
      `DELETE FROM agents WHERE team_id = $1 AND id = $2`,
      [teamId, agentId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async dbNextPort(_teamId?: string): Promise<number> {
    return this.db.agents.nextPort();
  }

  /**
   * Wallet-only identity delivery for remote public agents: pushes name,
   * ows_address, and service_endpoint — no onchain fields — so the VPS
   * runtime can advertise its wallet address after OWS provisioning.
   */
  private async stageAndDeliverRemoteWalletIdentity(agent: AgentRow): Promise<void> {
    const metadata = (agent.metadata || {}) as Record<string, any>;
    const identity = {
      name: agent.name,
      ows_address: metadata.ows_address || '',
      service_endpoint: agent.public_endpoint_url || (agent.customer_domain ? `https://${agent.customer_domain}` : ''),
      registered_at: new Date().toISOString(),
    };

    await this.stageAndDeliverIdentityFile(agent, identity);
  }

  /**
   * Write an identity payload to the local staging directory and (if
   * ssh_target is set) deliver it to the remote VPS over SCP.
   *
   * On SSH delivery failure the manager-side state is still authoritative;
   * the manager logs a warning and returns successfully.
   */
  private async stageAndDeliverIdentityFile(agent: AgentRow, identity: Record<string, unknown>): Promise<void> {
    // Staging path: <baseWorkDir>/public-agents/<agent.id>/staging/identity.json
    const stagingDir = path.join(this.baseWorkDir, 'public-agents', agent.id, 'staging');
    mkdirSync(stagingDir, { recursive: true });
    const localPath = path.join(stagingDir, 'identity.json');
    writeFileSync(localPath, JSON.stringify(identity, null, 2), 'utf8');
    console.log(`[Register] Staged identity file at ${localPath}`);

    // Deliver over SSH if ssh_target is configured
    if (agent.ssh_target) {
      const remotePath = (agent.metadata as any)?.identity_remote_path || '/opt/public-agent/identity.json';
      const deliverResult = await this.deliverFn(agent.ssh_target, localPath, remotePath);
      // Never log the full ssh_target (raw `user@host`); the user portion is
      // operator PII. Full target is still available via admin API responses.
      const redactedTarget = redactSshTarget(agent.ssh_target);
      if (deliverResult.ok) {
        console.log(`[Register] Delivered identity.json to ${redactedTarget}:${remotePath}`);
      } else {
        console.warn(
          `[Register] SSH delivery failed for agent ${agent.id} (${redactedTarget}): ` +
          `error=${deliverResult.error} stderr=${deliverResult.stderr ?? ''}`,
        );
        // Do NOT throw — manager-side state is authoritative regardless.
      }
    }
  }

  /**
   * Resolve a target agent by name/id, return its info and endpoint URL.
   * Shared by /talk-to and /message endpoints.
   */
  private async resolveTargetAgent(teamId: string, agent: string): Promise<{
    targetAgent: any;
    targetUrl: string;
    targetDisplayId: string;
  } | { error: string; status: number }> {
    // Handle name lookup - supports ENS domains and local names
    let baseName = agent;
    let tokenId: string | null = null;

    const dotIndex = agent.lastIndexOf('.');
    if (dotIndex !== -1) {
      const afterDot = agent.slice(dotIndex + 1);
      if (/^\d+$/.test(afterDot)) {
        baseName = agent.slice(0, dotIndex);
        tokenId = afterDot;
      }
    }

    // After registration, agent.name becomes the ENS domain and the original
    // local alias is in metadata->>'alias'.  Queries must check both.
    const targetAgent = await this.db.agents.getForRouting(teamId, agent, tokenId ?? undefined);

    if (!targetAgent) {
      return { error: `Agent "${agent}" not found`, status: 404 };
    }

    const isLocalAgent = targetAgent.metadata?.local === true;
    const targetUrl = isLocalAgent
      ? (targetAgent.endpoint || `http://localhost:${targetAgent.port}`)
      : targetAgent.type === 'claude'
        ? `http://id-agent-${targetAgent.id}:4100`
        : ((targetAgent.metadata?.internal_url as string | undefined) || targetAgent.endpoint);

    if (!targetUrl) {
      return { error: `Agent "${agent}" has no endpoint`, status: 400 };
    }

    // Prefer ENS domain as display ID, fall back to local name
    const targetDomain = targetAgent.metadata?.idchain_domain as string | undefined;
    const targetDisplayId = targetDomain || targetAgent.name;

    return { targetAgent, targetUrl, targetDisplayId };
  }

  /**
   * Forward a message to an agent's /talk endpoint.
   * Returns the parsed response or an error.
   */
  private async forwardToAgent(targetUrl: string, message: string, from: string, session_id?: string): Promise<{
    ok: true;
    data: any;
  } | { ok: false; status: number; error: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const talkRes = await fetch(`${targetUrl}/talk`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, from, session_id }),
      signal: AbortSignal.timeout(30000)
    });

    if (!talkRes.ok) {
      const errorText = await talkRes.text().catch(() => talkRes.statusText);
      return { ok: false, status: talkRes.status, error: errorText };
    }

    const data: any = await talkRes.json();
    return { ok: true, data };
  }

  /**
   * Unified message handler for both /message and /talk-to.
   * Default: fire-and-forget. With wait:true or timeout: waits for reply.
   */
  private async handleMessage(req: express.Request, res: express.Response) {
    try {
      const { id: teamId } = await this.getTeam(req);
      const { agent: agentField, to: toField, message, from, session_id, wait, timeout: requestTimeout } = req.body || {};
      const agent = toField || agentField;

      if (!agent || !message) {
        return res.status(400).json({ error: 'Missing "to" (agent name) or "message"' });
      }

      // Determine if we should wait for a reply
      const shouldWait = wait === true || requestTimeout !== undefined;

      // Parse timeout (only relevant when waiting)
      const DEFAULT_TIMEOUT = 24 * 60 * 60 * 1000;
      const MAX_TIMEOUT = 24 * 60 * 60 * 1000;
      const timeout = shouldWait
        ? Math.min(Math.max(parseInt(requestTimeout) || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT)
        : 0;

      if (String(agent).toLowerCase() === 'manager') {
        const { name: teamName } = await this.getTeam(req);
        const managerInbox = this.getManagerInboxRef(teamId, teamName);
        const ts = Date.now();

        if (!shouldWait) {
          await this.db.news.add(teamId, null, {
            timestamp: ts,
            type: 'message',
            message: message,
            data: { from: from || 'manager', message },
            kind: 'notify',
            reply_expected: false,
            owner_kind: managerInbox.ownerKind,
            owner_id: managerInbox.ownerId,
          });
          return res.json({
            success: true,
            delivered_to: 'manager',
            status: 'delivered',
          });
        }

        const queryId = `query_${ts}_${Math.random().toString(36).slice(2, 9)}`;
        await this.db.queries.create(
          teamId,
          queryId,
          null,
          `[From: ${from || 'manager'}] ${message}`,
          ts,
          session_id || undefined,
          { owner_kind: managerInbox.ownerKind, owner_id: managerInbox.ownerId },
        );
        await this.db.news.add(teamId, null, {
          timestamp: ts,
          type: 'query.received',
          message: `Query from ${from || 'manager'}: ${String(message).slice(0, 100)}${String(message).length > 100 ? '...' : ''}`,
          data: { from: from || 'manager', message, session_id, query_id: queryId },
          query_id: queryId,
          kind: 'talk',
          reply_expected: true,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        this.managerLog(`Queued reserved-route message to manager, query_id: ${queryId}`);

        let timeoutHandle: NodeJS.Timeout | null = null;
        let httpTimedOut = false;
        const replyPromise = new Promise<{ from: string; message: string }>((resolve) => {
          this.queryWaiters.set(queryId, {
            resolve,
            reject: () => {},
            timeout: null as any,
          });
          if (timeout < 24 * 60 * 60 * 1000) {
            timeoutHandle = setTimeout(() => {
              httpTimedOut = true;
              resolve({ from: '', message: '' });
            }, timeout);
          }
        });
        const replyResult = await replyPromise;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (httpTimedOut) {
          return res.json({
            success: false,
            from: 'manager',
            query_id: queryId,
            message: `Request timed out after ${timeout}ms - reply will be delivered when it arrives`,
            status: 'pending',
          });
        }
        return res.json({
          success: true,
          from: replyResult.from || 'manager',
          reply: replyResult.message,
          query_id: queryId,
        });
      }

      // Resolve the target agent
      const resolved = await this.resolveTargetAgent(teamId, agent);
      if ('error' in resolved) {
        return res.status(resolved.status).json({ error: resolved.error });
      }
      const { targetAgent, targetUrl, targetDisplayId } = resolved;

      // Mesh-membership gate: only mesh members can receive inter-agent messages.
      // mesh_member defaults to true for backward compat (pre-Phase-4 agents have no flag).
      // Admin callers may bypass via ?admin=true for diagnostic purposes — EXCEPT
      // when the target is a public-agent-remote runtime. Public remote agents
      // live in the DMZ; routing manager-proxied traffic to them through an admin
      // escape hatch would rebuild the proxy path the DMZ design explicitly
      // forbids. Public conversations must use direct HTTPS; operator plane must
      // use SSH. No admin override here.
      const meshMember = (targetAgent.metadata as any)?.mesh_member !== false;
      const isPublicRemote = targetAgent.runtime === 'public-agent-remote';
      const adminBypass = this.isAdminRequest(req) && req.query.admin === 'true' && !isPublicRemote;
      if (!meshMember && !adminBypass) {
        return res.status(403).json({
          error: 'not_mesh_reachable',
          message: isPublicRemote
            ? 'Target is a public-agent-remote runtime. Reach it via direct HTTPS (/talk) or SSH (operator plane); no manager-proxied admin bypass.'
            : 'Target agent is not part of the inter-agent mesh.'
        });
      }

      this.managerLog(`${shouldWait ? 'Forwarding' : 'Sending async'} message to ${targetDisplayId} at ${targetUrl}`);

      // Forward the message to the agent's /talk endpoint
      const result = await this.forwardToAgent(targetUrl, message, from || 'manager', session_id);
      if (!result.ok) {
        console.error(`[Manager] Failed to deliver message to ${targetDisplayId}: ${result.status}`);
        return res.status(result.status).json({ error: result.error });
      }

      const queryId = result.data.query_id;

      // Store the query so replies can be routed correctly
      if (queryId) {
        await this.db.queries.create(teamId, queryId, targetAgent.id, message, Date.now());
      }

      // Fire-and-forget: return immediately
      if (!shouldWait) {
        this.managerLog(`Message delivered to ${targetDisplayId}, query_id: ${queryId} (fire-and-forget)`);
        return res.json({
          success: true,
          query_id: queryId,
          delivered_to: targetDisplayId,
          status: 'delivered'
        });
      }

      // Wait mode: block until reply arrives or timeout
      this.managerLog(`Waiting up to ${timeout}ms for reply from ${targetDisplayId}, query_id: ${queryId}`);

      if (!queryId) {
        return res.json(result.data);
      }

      let timeoutHandle: NodeJS.Timeout | null = null;
      let httpTimedOut = false;

      const replyPromise = new Promise<{ from: string; message: string }>((resolve) => {
        this.queryWaiters.set(queryId, {
          resolve,
          reject: () => {},
          timeout: null as any
        });

        if (timeout < 24 * 60 * 60 * 1000) {
          timeoutHandle = setTimeout(() => {
            httpTimedOut = true;
            resolve({ from: '', message: '' });
          }, timeout);
        }
      });

      const replyResult = await replyPromise;

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (httpTimedOut) {
        this.managerLog(`HTTP timeout waiting for ${targetDisplayId} (${timeout}ms) - waiter persists`);
        return res.json({
          success: false,
          from: targetDisplayId,
          query_id: queryId,
          message: `Request timed out after ${timeout}ms - reply will be delivered when it arrives`,
          status: 'pending'
        });
      }

      this.managerLog(`Received reply from ${targetDisplayId} for query ${queryId}`);
      return res.json({
        success: true,
        from: replyResult.from || targetDisplayId,
        reply: replyResult.message,
        query_id: queryId
      });
    } catch (err: any) {
      console.error('[Manager] Error in POST /message:', err);
      res.status(500).json({ error: err?.message || 'Internal server error' });
    }
  }

  /**
   * /talk-to auto-attach hook. Inspects the request body and, if a task
   * delegation is requested, creates the task + (unless opted out) an
   * active checkin watched by the dispatcher. Throws an Error with
   * `status` and `code` properties on validation failures so the caller
   * can return a 4xx response with a stable error code.
   *
   * Returns null when the body has no `task` field (legacy /talk-to path).
   */
  private async maybeAutoAttachForTalkTo(
    req: express.Request,
  ): Promise<{ task: TaskRow; checkin: CheckinRow | null } | null> {
    const body = req.body || {};
    if (!body.task || typeof body.task !== 'object') return null;

    const { id: teamId } = await this.getTeam(req);
    const taskSpec = body.task as { title?: unknown; name?: unknown; description?: unknown };
    if (!taskSpec.title || typeof taskSpec.title !== 'string') {
      throw makeAutoAttachError(400, 'invalid_task_title');
    }

    const targetRef = body.to ?? body.agent;
    if (!targetRef || typeof targetRef !== 'string') {
      throw makeAutoAttachError(400, 'invalid_target_agent');
    }
    const targetResolved = await this.resolveSingleAgentForCommand(teamId, targetRef);
    if (!targetResolved.agent) {
      throw makeAutoAttachError(404, 'target_agent_not_found');
    }
    const targetAgent = targetResolved.agent;

    const fromRef = body.from;
    let fromAgent: AgentRow | undefined;
    if (fromRef && typeof fromRef === 'string') {
      const r = await this.resolveSingleAgentForCommand(teamId, fromRef);
      fromAgent = r.agent;
    }

    const flagsResult = parseAutoAttachFlags(body);
    if (flagsResult.error) {
      throw makeAutoAttachError(400, flagsResult.error);
    }

    const requestedName = typeof taskSpec.name === 'string' && taskSpec.name.length > 0
      ? normalizeAlias(taskSpec.name)
      : null;
    const baseName = requestedName || normalizeAlias(taskSpec.title);
    let name = baseName;
    if (requestedName) {
      if (await this.db.tasks.getByNameForTeam(name, teamId)) {
        throw makeAutoAttachError(409, 'task_name_conflict');
      }
    } else {
      let suffix = 1;
      while (await this.db.tasks.getByNameForTeam(name, teamId)) {
        name = `${baseName}-${suffix++}`;
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const taskRow: TaskRow = {
      id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      name,
      uuid: crypto.randomUUID(),
      team_id: teamId,
      title: taskSpec.title,
      description: typeof taskSpec.description === 'string' ? taskSpec.description : null,
      status: 'doing',
      created_by: fromAgent?.id ?? null,
      owner: targetAgent.id,
      created_at: nowSec,
      updated_at: nowSec,
      completed_at: null,
    };
    await this.db.tasks.create(taskRow);

    if (flagsResult.disabled) {
      return { task: taskRow, checkin: null };
    }

    const nowMs = Date.now();
    const intervalSeconds = flagsResult.intervalSeconds ?? AUTO_ATTACH_DEFAULT_INTERVAL_SECONDS;
    const maxIterations = flagsResult.maxIterations ?? null;

    const checkinRow: CheckinRow = {
      id: generateCheckinId(nowMs),
      team_id: teamId,
      owner_agent_id: fromAgent?.id ?? null,
      created_by_agent_id: fromAgent?.id ?? null,
      linked_task_id: taskRow.id,
      interval_seconds: intervalSeconds,
      priority: 'normal',
      status: 'active',
      close_when: DEFAULT_CLOSE_WHEN,
      max_iterations: maxIterations,
      iteration_count: 0,
      next_fire_at: nowMs + intervalSeconds * 1000,
      snooze_until: null,
      ttl_expires_at: null,
      last_fire_at: null,
      last_event_seq: null,
      note: null,
      created_at: nowMs,
      updated_at: nowMs,
      closed_at: null,
      closed_reason: null,
    };
    await this.db.checkins.create(checkinRow);

    try {
      await recordCheckinCreated(this.db.events, this.db.checkins, {
        teamId,
        checkinId: checkinRow.id,
        ownerAgentId: checkinRow.owner_agent_id,
        createdByAgentId: checkinRow.created_by_agent_id,
        linkedTaskId: checkinRow.linked_task_id,
        priority: checkinRow.priority,
        intervalSeconds: checkinRow.interval_seconds,
        maxIterations: checkinRow.max_iterations,
        nextFireAt: checkinRow.next_fire_at,
        ttlExpiresAt: checkinRow.ttl_expires_at,
        occurredAt: nowMs,
      });
    } catch (err) {
      console.error('[Manager] Failed to emit checkin:created on auto-attach:', err);
    }

    return { task: taskRow, checkin: checkinRow };
  }

  /**
   * Resolve whether a request is from an admin principal.
   * Admin = loopback IP + X-Id-Admin: 1 header.
   */
  private isAdminRequest(req: express.Request): boolean {
    const ip = req.ip || '';
    const isLoopback =
      ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const hasAdminHeader = req.headers['x-id-admin'] === '1';
    return isLoopback && hasAdminHeader;
  }

  /**
   * Team/principal context middleware.
   * Resolves once per request and attaches:
   *   (req as any).ctx = { principal, teamName, teamId }
   *
   * principal:
   *   'admin'  — loopback IP + X-Id-Admin: 1
   *   'agent'  — X-Id-Agent: <id> present and the agent belongs to the resolved team
   *   'anon'   — all other callers
   *
   * teamId resolution:
   *   - admin principals: getOrCreate (same as legacy behaviour)
   *   - non-admin: getTeamByName only; 404 if team does not exist
   */
  private teamContextMiddleware(): express.RequestHandler {
    return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        const teamName = this.getTeamName(req);
        const principal = this.isAdminRequest(req) ? 'admin' : 'anon';

        let teamId: string;
        if (principal === 'admin') {
          // Admin principals may create teams on the fly (legacy behaviour)
          teamId = await this.db.teams.getOrCreateTeamId(teamName);
          // Ensure per-team directory exists
          const teamDir = `${this.baseWorkDir}/teams/${teamName}`;
          if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
        } else {
          // Non-admin: team must already exist
          const teamRow = await this.db.teams.getTeamByName(teamName);
          if (!teamRow) {
            res.status(404).json({ error: 'team_not_found' });
            return;
          }
          teamId = teamRow.id;
          // Ensure per-team directory exists
          const teamDir = `${this.baseWorkDir}/teams/${teamName}`;
          if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
        }

        // Check agent principal claim
        let resolvedPrincipal: 'admin' | 'agent' | 'anon' = principal === 'admin' ? 'admin' : 'anon';
        const agentHeader = req.headers['x-id-agent'];
        if (agentHeader && typeof agentHeader === 'string' && resolvedPrincipal !== 'admin') {
          const agentRow = await this.db.agents.getById(agentHeader);
          if (agentRow && agentRow.team_id === teamId) {
            resolvedPrincipal = 'agent';
          } else if (agentRow && agentRow.team_id !== teamId) {
            // Agent exists but belongs to a different team — reject
            res.status(403).json({ error: 'agent_team_mismatch' });
            return;
          }
          // If agent doesn't exist at all, fall through as 'anon'
        }

        (req as any).ctx = { principal: resolvedPrincipal, teamName, teamId };
        next();
      } catch (err: any) {
        // Invalid team name or other error
        res.status(400).json({ error: err?.message || 'Invalid request context' });
      }
    };
  }

  private setupRoutes() {
    // REST-AP discovery — daemon root advertises itself as the manager so
    // peers can locate the team orchestration and inbox surface directly.
    // Shape mirrors the per-agent catalogs published by claude-agent-server /
    // interactive-agent-server (restap_version + agent + endpoints + capabilities).
    // This route must stay outside team scoping: discovery at the daemon root
    // should not depend on a team already existing or a caller sending a team header.
    this.managementApp.get('/.well-known/restap.json', (_req, res) => {
      res.json({
        restap_version: '1.0',
        agent: {
          name: 'manager',
          description:
            'Manager daemon — team orchestration, inbox, scheduling, registry, and event fan-out for the id-agents control plane.',
        },
        provider: {
          name: 'id-agents',
          version: '1.0',
        },
        endpoints: {
          talk: '/talk',
          schedule: '/schedule',
          news: '/news',
          news_post: '/news',
        },
        capabilities: [
          {
            id: 'talk',
            title: 'Send a message or question to the manager',
            method: 'POST',
            endpoint: '/talk',
            description:
              'Post a message or question to the manager inbox. Persists to the manager DB; replies arrive via /news.',
            input_schema: {
              message: 'string (required)',
              from: 'string (optional) - sender agent name or id',
              session_id: 'string (optional) - prior session id for context continuity',
            },
          },
          {
            id: 'schedule',
            title: 'Enqueue scheduled work for the manager',
            method: 'POST',
            endpoint: '/schedule',
            description:
              'Submit a manager-owned scheduled event. Internal mode enqueues work without auto-reply.',
            input_schema: {
              message: 'string (required)',
              schedule:
                'object (required) - schedule metadata including id, kind, title, scheduledKey',
              mode: 'string (optional) - "internal" for autonomous wake-ups',
            },
          },
          {
            id: 'news',
            title: 'Poll manager news feed',
            method: 'GET',
            endpoint: '/news',
            description:
              'Poll for manager inbox updates and replies. Supports since (timestamp), limit, query_id, chars_start/chars_end.',
            input_schema: {
              since: 'number (optional) - timestamp to filter items after',
              limit: 'number (optional) - maximum number of items to return',
              query_id: 'string (optional) - filter items by specific query_id',
              chars_start: 'number (optional) - start position in character range (0 = newest)',
              chars_end: 'number (optional) - end position in character range (must be > chars_start)',
            },
          },
          {
            id: 'news_receive',
            title: 'Deliver a message or reply to the manager',
            method: 'POST',
            endpoint: '/news',
            description:
              'Receive messages or replies addressed to the manager inbox. Does not trigger LLM processing.',
            input_schema: {
              type: 'string (optional) - message type, e.g. "reply" or "message"',
              from: 'string (optional) - sender agent name',
              message: 'string (required) - the message content',
              in_reply_to: 'string (optional) - query_id this is replying to',
            },
          },
        ],
        extensions: {
          remote: '/remote',
          query: '/query/:id',
          tasks: '/tasks',
          agents: '/agents',
          events: '/events',
          ws: '/ws',
        },
      });
    });

    // Install team/principal context middleware for all remaining routes
    this.managementApp.use(this.teamContextMiddleware());

    this.managementApp.get('/health', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const count = await this.db.agents.count(teamId);
      res.json({ status: 'ok', team: teamName, agents: parseInt(count || '0'), timestamp: Date.now() });
    });

    // Slice 7: read-only library inventory. Library root is captured at
    // manager construction from `opts.libraryRoot` (tests) or from
    // resolveDefaultLibraryRoot() (prod: ID_LIBRARY_ROOT env, else
    // <cwd>/configs, else null). When null, listings return an empty
    // collection and detail routes return 404 — "no library configured"
    // is a first-class state, not an error.
    this.managementApp.get('/library/agents', (_req, res) => {
      res.json(listLibraryAgents(this.libraryRoot));
    });

    this.managementApp.get('/library/agents/:name', (req, res) => {
      const detail = getLibraryAgent(this.libraryRoot, req.params.name);
      if (!detail) {
        res.status(404).json({ error: 'not_found', resource: 'library-agent', name: req.params.name });
        return;
      }
      res.json(detail);
    });

    this.managementApp.get('/library/skills', (_req, res) => {
      res.json(listLibrarySkills(this.libraryRoot));
    });

    this.managementApp.get('/library/skills/:name', (req, res) => {
      const detail = getLibrarySkill(this.libraryRoot, req.params.name);
      if (!detail) {
        res.status(404).json({ error: 'not_found', resource: 'library-skill', name: req.params.name });
        return;
      }
      res.json(detail);
    });

    // Team-template inventory (slice 1). Mirrors /library/agents and
    // /library/skills. Empty list / 404 when no library is configured.
    this.managementApp.get('/library/teams', (_req, res) => {
      res.json(listLibraryTeams(this.libraryRoot));
    });

    this.managementApp.get('/library/teams/:name', (req, res) => {
      const detail = getLibraryTeam(this.libraryRoot, req.params.name);
      if (!detail) {
        res.status(404).json({ error: 'not_found', resource: 'library-team', name: req.params.name });
        return;
      }
      res.json(detail);
    });

    // POST /library/install — installs a library entry into the manager's
    // library root. Slice 1: only `team:<template>` -> `team:<dest>` is
    // implemented; agent/skill installs return 400 with `unsupported_kind`
    // so future slices can add them without a breaking change.
    this.managementApp.post('/library/install', (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const fromSel = parseSelector((body as Record<string, unknown>).from);
      const toSel = parseSelector((body as Record<string, unknown>).to);
      const force = (body as Record<string, unknown>).force === true;
      const paramsRaw = (body as Record<string, unknown>).params;
      const params: Record<string, unknown> = (paramsRaw && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw))
        ? (paramsRaw as Record<string, unknown>)
        : {};

      if (!fromSel) {
        res.status(400).json({ error: 'bad_selector', field: 'from', value: (body as Record<string, unknown>).from ?? null });
        return;
      }
      if (!toSel) {
        res.status(400).json({ error: 'bad_selector', field: 'to', value: (body as Record<string, unknown>).to ?? null });
        return;
      }
      if (fromSel.kind !== toSel.kind) {
        res.status(400).json({ error: 'kind_mismatch', fromKind: fromSel.kind, toKind: toSel.kind });
        return;
      }
      if (fromSel.kind !== 'team') {
        res.status(400).json({ error: 'unsupported_kind', kind: fromSel.kind });
        return;
      }
      if (paramsRaw !== undefined && (paramsRaw === null || typeof paramsRaw !== 'object' || Array.isArray(paramsRaw))) {
        res.status(400).json({ error: 'bad_params', message: 'params must be an object' });
        return;
      }

      const result = installLibraryTeam(this.libraryRoot, {
        template: fromSel.name,
        dest: toSel.name,
        force,
        params,
      });
      if (!result.ok) {
        const { ok: _ok, status, ...rest } = result;
        res.status(status).json(rest);
        return;
      }
      res.json(result);
    });

    // GET /agents/status - check health of all agents (server-side ping)
    this.managementApp.get('/agents/status', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const includeAll = req.query.all === 'true' || req.query.all === '1';
      const agents = await this.dbListAgents(teamId, includeAll);
      const isAdmin = this.isAdminRequest(req);

      const results = await Promise.allSettled(
        agents.map(async (agent) => {
          const agentUrl = agent.endpoint || `http://localhost:${agent.port}`;
          const isInteractive = agent.type === 'interactive';
          let isResponding = false;
          let newsItems: any[] = [];

          if (isInteractive) {
            isResponding = true;
          } else {
            try {
              const catalogResp = await fetch(`${agentUrl}/.well-known/restap.json`, {
                signal: AbortSignal.timeout(3000)
              });
              isResponding = catalogResp.ok;
            } catch { /* not responding */ }
          }

          if (isResponding && !isInteractive) {
            try {
              const newsResp = await fetch(`${agentUrl}/news?since=0&limit=50`, {
                signal: AbortSignal.timeout(2000)
              });
              if (newsResp.ok) {
                const newsData: any = await newsResp.json();
                newsItems = newsData.items || [];
              }
            } catch { /* news fetch failed */ }
          }

          // Check for active heartbeat schedules
          let hasActiveHeartbeat = false;
          if (this.schedulerService) {
            const schedules = await this.db.schedules.listSchedulesForAgent(agent.id);
            hasActiveHeartbeat = schedules.some(s => s.kind === 'heartbeat' && s.active);
          }

          return {
            ...this.agentToResponse(agent, { isAdmin }),
            isResponding,
            newsItems,
            hasActiveHeartbeat
          };
        })
      );

      const agentStatuses = results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        return { ...this.agentToResponse(agents[i], { isAdmin }), isResponding: false, newsItems: [], hasActiveHeartbeat: false };
      });

      res.json({ agents: agentStatuses });
    });

    // GET /agents/:name/news - proxy news feed from a specific agent (for remote CLI)
    this.managementApp.get('/agents/:name/news', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const agentName = req.params.name;
        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);

        if (!agent) {
          return res.status(404).json({ error: `Agent "${agentName}" not found` });
        }

        const agentUrl = agent.endpoint || `http://localhost:${agent.port}`;
        const since = req.query.since || '0';
        const limit = req.query.limit || '50';

        const newsResp = await fetch(`${agentUrl}/news?since=${since}&limit=${limit}`, {
          signal: AbortSignal.timeout(5000)
        });

        if (!newsResp.ok) {
          return res.status(newsResp.status).json({ error: `Agent news fetch failed: ${newsResp.statusText}` });
        }

        const newsData = await newsResp.json();
        res.json(newsData);
      } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to fetch agent news' });
      }
    });

    // POST /agents/:name/cancel - proxy cancel request to a specific agent (for remote CLI)
    this.managementApp.post('/agents/:name/cancel', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const agentName = req.params.name;
        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);

        if (!agent) {
          return res.status(404).json({ error: `Agent "${agentName}" not found` });
        }

        const agentUrl = agent.endpoint || `http://localhost:${agent.port}`;
        const cancelResp = await fetch(`${agentUrl}/cancel`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json' }
        });

        if (!cancelResp.ok) {
          const errData = await cancelResp.json().catch(() => ({ error: cancelResp.statusText }));
          return res.status(cancelResp.status).json(errData);
        }

        const result = await cancelResp.json();
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to cancel agent query' });
      }
    });

    // GET /logs - retrieve recent manager activity logs
    this.managementApp.get('/logs', async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, this.LOG_BUFFER_SIZE);
      const logs = this.logBuffer.slice(-limit);
      res.json({ logs, total: this.logBuffer.length });
    });

    // REST-AP /talk endpoint - receive queries for the manager inbox
    this.managementApp.post('/talk', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const { message, session_id, from } = req.body || {};

        if (!message) {
          return res.status(400).json({ error: 'Missing message' });
        }

        const ts = Date.now();
        const queryId = `query_${ts}_${Math.random().toString(36).slice(2, 9)}`;
        const managerInbox = this.getManagerInboxRef(teamId, teamName);
        const senderName = from || 'external';

        // Store the query in the queries table. Dual-write window: every
        // manager-inbox row carries both legacy agent_id (= manager-<team>)
        // and the new owner_kind/owner_id columns explicitly so a downstream
        // backfill/cutover never has to infer ownership from the agent_id
        // prefix heuristic.
        await this.db.queries.create(
          teamId,
          queryId,
          null,
          `[From: ${senderName}] ${message}`,
          ts,
          session_id || undefined,
          { owner_kind: managerInbox.ownerKind, owner_id: managerInbox.ownerId },
        );

        // Also store as a news item so the CLI can see incoming queries
        await this.db.news.add(teamId, null, {
          timestamp: ts,
          type: 'query.received',
          message: `Query from ${senderName}: ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`,
          data: { from: senderName, message, session_id, query_id: queryId },
          query_id: queryId,
          kind: 'talk',
          reply_expected: true,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        this.managerLog(`Received query ${queryId} from ${senderName}: ${message.slice(0, 50)}...`);

        res.status(202).json({
          query_id: queryId,
          status: 'pending',
          message: 'Query received. Poll /news?query_id=' + queryId + ' for response.'
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /talk:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // POST /schedule - enqueue manager-owned internal scheduled work
    this.managementApp.post('/schedule', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const { message, schedule, mode, linkedTasks } = req.body || {};

        if (!message) {
          return res.status(400).json({ error: 'Missing message' });
        }
        if (!schedule || typeof schedule !== 'object') {
          return res.status(400).json({ error: 'Schedule metadata is required' });
        }
        if (mode && mode !== 'internal') {
          return res.status(400).json({ error: 'Invalid schedule mode' });
        }

        const messageStr = typeof message === 'string' ? message : String(message);
        const ts = Date.now();
        const queryId = `query_${ts}_${Math.random().toString(36).slice(2, 9)}`;

        const managerInbox = this.getManagerInboxRef(teamId, teamName);

        const queryResult: Record<string, unknown> = { schedule, message: messageStr, mode: 'internal' };
        if (Array.isArray(linkedTasks) && linkedTasks.length > 0) {
          queryResult.linkedTasks = linkedTasks;
        }

        await this.db.queries.upsert(teamId, null, {
          query_id: queryId,
          status: 'pending',
          prompt: messageStr,
          created: ts,
          completed: null,
          result: queryResult,
          error: null,
          session_id: null,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        const newsData: Record<string, unknown> = {
          query_id: queryId,
          message: messageStr,
          schedule,
          status: 'awaiting_response',
        };
        if (Array.isArray(linkedTasks) && linkedTasks.length > 0) {
          newsData.linkedTasks = linkedTasks;
        }

        await this.db.news.add(teamId, null, {
          timestamp: ts,
          type: 'schedule.received',
          message: `Scheduled query ${queryId} received`,
          data: newsData,
          query_id: queryId,
          reply_expected: false,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        this.managerLog(`Received scheduled query ${queryId}: ${messageStr.slice(0, 50)}...`);

        res.status(202).json({
          query_id: queryId,
          status: 'pending',
          message: `Scheduled work has been queued for the manager inbox.`,
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /schedule:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // POST /message - DEPRECATED unified endpoint for sending messages to agents.
    // Prefer POST /talk-to (synchronous reply) or POST /news-to (fire-and-forget).
    // Emits an X-Deprecated response header and a manager log line; still
    // functionally equivalent to /talk-to with fire-and-forget defaults.
    this.managementApp.post('/message', (req, res, next) => {
      res.setHeader(
        'X-Deprecated',
        '/message is deprecated; use /talk-to for synchronous replies or /news-to for fire-and-forget notifications',
      );
      const fromHint = (req.body && typeof req.body.from === 'string') ? req.body.from : 'unknown';
      this.managerLog(`[DEPRECATED] /message called (from=${fromHint}); prefer /talk-to or /news-to`);
      this.handleMessage(req, res).catch(next);
    });

    // /talk-to - backwards-compatible alias for /message with wait:true.
    // When the body carries a `task` object the dispatch is treated as a
    // task delegation: the manager creates the task (owner = target agent,
    // status = 'doing') and auto-attaches an active checkin owned by the
    // dispatcher. The auto-attach is governed by these flags on the body:
    //   - no_checkin: true            disables auto-attach for this dispatch
    //   - checkin: <duration|seconds> overrides interval (default 10m)
    //   - checkin_iters: <N>          sets max_iterations (default null)
    // If no `task` object is supplied, /talk-to behaves exactly as before.
    this.managementApp.post('/talk-to', async (req, res, next) => {
      // Inject wait:true if not explicitly set
      if (req.body && req.body.wait === undefined && req.body.timeout === undefined) {
        req.body.wait = true;
      }
      try {
        const result = await this.maybeAutoAttachForTalkTo(req);
        if (result) (req as any)._autoAttach = result;
      } catch (err: any) {
        return res.status(err?.status || 400).json({ error: err?.code || err?.message || 'auto_attach_failed' });
      }
      this.handleMessage(req, res).catch(next);
    });

    // /news-to - fire-and-forget notification to another agent (no reply wait).
    // Mesh-membership gate applies identically to /talk-to (handled inside handleMessage).
    this.managementApp.post('/news-to', (req, res, next) => {
      // Ensure wait is explicitly false (fire-and-forget)
      if (req.body) {
        req.body.wait = false;
      }
      this.handleMessage(req, res).catch(next);
    });

    // REST-AP /news endpoint - receive replies from agents
    this.managementApp.post('/news', async (req, res) => {
      try {
        let { id: teamId, name: teamName } = await this.getTeam(req);
        const { type, from, message, data } = req.body || {};
        // `in_reply_to` is the query_id this row is replying to. Some clients
        // put it at the top level; agent-server `broadcastToManager` started
        // doing so deliberately, but older paths (and the original message
        // shape) only carried it inside `data`. Fall back so either works.
        const in_reply_to: string | undefined = req.body?.in_reply_to ?? data?.in_reply_to ?? undefined;
        // Replies (in_reply_to present) default to trigger=true so the
        // forwarded receiver wakes up when its /talk-to wait has already
        // timed out. Caller can opt out with trigger:false explicitly.
        const trigger = resolveNewsTrigger({ in_reply_to, trigger: req.body?.trigger });
        // skip_persist:true: caller already persisted the canonical row
        // under the actual receiver's inbox (e.g. `broadcastToManager` from
        // the originating agent's /news handler). Skip the manager-inbox
        // insert to avoid duplicate visible rows; still run waiter
        // resolution + queries.complete + emitQueryDelivered below so the
        // synchronous /talk-to caller actually unblocks.
        const skipPersist = req.body?.skip_persist === true;

        if (!message && !data) {
          return res.status(400).json({ error: 'Missing message or data' });
        }

        // If this is a reply to a query, look up the original query's team.
        // Design-doc delta (Phase 1): the queries table does not track which agent
        // endpoint received the original query, so we cannot verify the reply path
        // fully. Instead we apply a lighter constraint: only admin principals are
        // allowed to swing teams via in_reply_to. Non-admin callers (agents, anon)
        // may reply to queries within their own team only. If the query belongs to
        // a different team and the caller is not admin, we still deliver the news
        // to the caller's own team (the reply will be visible there) but we do NOT
        // follow the query across the team boundary.
        if (in_reply_to) {
          const queryTeamId = await this.db.queries.findTeam(in_reply_to);
          const principal = (req as any).ctx?.principal || 'anon';
          if (queryTeamId && queryTeamId !== teamId) {
            if (principal === 'admin') {
              // Admin may cross teams
              teamId = queryTeamId;
              this.managerLog(`Reply to ${in_reply_to} - admin team override to ${teamId}`);
            } else {
              // Non-admin: stay in own team; log that we skipped the cross-team swing
              this.managerLog(`Reply to ${in_reply_to} - non-admin caller; keeping team ${teamId} (query team ${queryTeamId})`);
            }
          } else if (queryTeamId && queryTeamId === teamId) {
            this.managerLog(`Reply to ${in_reply_to} - using query's team ${teamId}`);
          }
        }

        const newsType = type || (in_reply_to ? 'reply' : 'message');
        const newsMessage = message || data?.message || `${newsType} from ${from || 'unknown'}`;
        const ts = Date.now();

        // Store in news_items under the logical manager owner. The legacy
        // agent_id column is still populated for rollback compatibility, but
        // reads no longer depend on an agents-row stub existing.
        const teamRow = teamId
          ? await this.db.teams.getTeam(teamId).catch(() => null)
          : null;
        const resolvedTeamName = teamRow?.name ?? teamName ?? 'unknown';
        const managerInbox = this.getManagerInboxRef(teamId, resolvedTeamName);

        // Replies carry notify semantics (no further reply expected);
        // unsolicited inbound messages default to notify too. Dual-write
        // window: tag the row with owner_kind='manager'/owner_id=teamId so
        // the new ownership columns stay populated alongside the legacy
        // agent_id (= manager-<team>) without depending on the agent-id
        // prefix heuristic in the repo helper.
        if (!skipPersist) {
          await this.db.news.add(teamId, null, {
            timestamp: ts,
            type: newsType,
            message: newsMessage,
            data: { from, in_reply_to, message, ...data },
            query_id: in_reply_to || undefined,
            kind: 'notify',
            reply_expected: false,
            owner_kind: managerInbox.ownerKind,
            owner_id: managerInbox.ownerId,
          });
        }

        // If this is a reply to a query, update the query status and resolve any waiting /talk-to.
        // Distinguish success ('reply') from agent-side failure ('reply.error') —
        // the latter is what claude-agent-server.ts sends from its /talk catch
        // block (see src/claude-agent-server.ts → sendReplyToSender, success=false).
        // We mark the row 'failed' instead of 'completed' and emit `query:failed`
        // instead of `query:delivered` so the wakeup-service event log carries
        // the real lifecycle transition. Audit finding #9
        // (output/security-review-wakeup-service.md).
        const isQueryFailure = newsType === 'reply.error' || type === 'reply.error';
        if (in_reply_to) {
          if (isQueryFailure) {
            const errorText =
              typeof message === 'string' && message.length > 0
                ? message
                : typeof data?.error === 'string'
                  ? data.error
                  : null;
            const transitioned = await this.db.queries.markFailed(teamId, in_reply_to, ts, errorText);
            if (transitioned) {
              const failedRow = await this.db.queries.getByQueryIdForTeam(teamId, in_reply_to).catch(() => null);
              await emitQueryFailed(this.db.events, {
                teamId,
                queryId: in_reply_to,
                agentId:
                  failedRow?.owner_kind === 'manager'
                    ? null
                    : failedRow?.agent_id ?? null,
                occurredAt: ts,
                reason: errorText,
              });
            }
            // Failure path still needs to wake long-poll and /talk-to waiters
            // so blocked callers don't hang waiting for a transition that
            // already happened.
            this.wakeQueryWaiters(teamId, in_reply_to, {
              from: from || 'unknown',
              message: message || '',
            });
          } else {
            // Single canonical completion lifecycle (queries.complete +
            // delivered event + waiter wakeups). Shared with POST
            // /manager/inbox/respond so both paths cannot drift.
            await this.completeQueryDelivery({
              teamId,
              queryId: in_reply_to,
              occurredAt: ts,
              resultPayload: { from, message, ...data },
              waiterReply: { from: from || 'unknown', message: message || '' },
              messagePreview: typeof message === 'string' ? message : null,
            });
          }
        }

        this.managerLog(`Received ${newsType}${from ? ` from ${from}` : ''}${in_reply_to ? ` (reply to ${in_reply_to})` : ''}`);

        // Broadcast to WebSocket clients (real-time delivery)
        this.broadcastNews(teamId, {
          type: newsType,
          from,
          message,
          in_reply_to,
          data: { ...data, sessionId: data?.sessionId },
          timestamp: ts
        });

        // Try to forward to CLI if it can receive direct messages
        // Look up the CLI (interactive agent) to check if it's reachable
        const recipientAgent = await this.db.agents.findInteractive(teamId);

        if (recipientAgent) {
          const recipient = recipientAgent;
          const canReceive = recipient.metadata?.canReceiveDirectMessages === true;

          if (canReceive && recipient.endpoint) {
            // Forward message to CLI's /news endpoint
            try {
              const forwardRes = await fetch(`${recipient.endpoint}/news`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: newsType,
                  from,
                  message,
                  in_reply_to,
                  trigger,
                  session_id: data?.sessionId,
                  ...data
                }),
                signal: AbortSignal.timeout(5000)
              });
              if (forwardRes.ok) {
                this.managerLog(`Forwarded ${newsType} to CLI at ${recipient.endpoint}`);
              } else {
                this.managerLog(`Failed to forward to CLI: ${forwardRes.status}`);
              }
            } catch (fwdErr: any) {
              this.managerLog(`Could not forward to CLI: ${fwdErr.message}`);
            }
          }
        }

        res.status(201).json({
          success: true,
          type: newsType,
          timestamp: ts
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /news:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // REST-AP /news endpoint - poll for updates
    // Preferred cursor: since_id=<monotonic id>&limit=N (server-side, ascending id).
    // Deprecated cursor: since=<ms-timestamp> — still accepted for one release,
    // with an X-Deprecated response header.
    this.managementApp.get('/news', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const hasSinceId = typeof req.query.since_id === 'string' && req.query.since_id !== '';
        const sinceId = hasSinceId ? parseInt(req.query.since_id as string) || 0 : 0;
        const since = parseInt(req.query.since as string) || 0;
        const limit = parseInt(req.query.limit as string) || 100;
        const query_id = req.query.query_id as string | undefined;

        if (!hasSinceId && typeof req.query.since === 'string') {
          res.setHeader(
            'X-Deprecated',
            'since=<ms> is deprecated; use since_id=<int> with the id field on each news item',
          );
        }

        const managerInbox = this.getManagerInboxRef(teamId, teamName);

        const newsRows = hasSinceId
          ? await this.db.news.pollSinceIdByOwner(teamId, managerInbox.ownerKind, managerInbox.ownerId, sinceId, { limit, queryId: query_id })
          : await this.db.news.pollByOwner(teamId, managerInbox.ownerKind, managerInbox.ownerId, since, { limit, queryId: query_id });

        const items = newsRows.map((r: any) => ({
          id: Number(r.id),
          type: r.type,
          timestamp: Number(r.timestamp),
          message: r.message || undefined,
          data: r.data || undefined
        }));

        const nextSinceId = hasSinceId && items.length > 0
          ? items[items.length - 1].id
          : undefined;

        res.json({
          items,
          timestamp: Date.now(),
          total: items.length,
          ...(nextSinceId !== undefined ? { next_since_id: nextSinceId } : {}),
        });
      } catch (err: any) {
        console.error('[Manager] Error in GET /news:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // Archive old news items to files and delete from database
    this.managementApp.post('/news/archive', async (req, res) => {
      try {
        const { name: teamName, id: teamId } = await this.getTeam(req);
        const days = parseInt(req.body?.days) || 30;
        const cutoffTimestamp = Date.now() - (days * 24 * 60 * 60 * 1000);

        // Get all news items older than cutoff
        const items = await this.db.news.fetchForArchive(teamId, cutoffTimestamp);
        if (items.length === 0) {
          return res.json({ archived: 0, message: 'No items to archive' });
        }

        // Create archives directory
        const archiveDir = `${this.baseWorkDir}/teams/${teamName}/archives`;
        if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });

        // Write to file with timestamp
        const filename = `news-archive-${new Date().toISOString().split('T')[0]}-${Date.now()}.json`;
        const filepath = `${archiveDir}/${filename}`;
        const archiveData = {
          archivedAt: new Date().toISOString(),
          teamName,
          cutoffDays: days,
          cutoffTimestamp,
          itemCount: items.length,
          items: items.map((r: any) => ({
            type: r.type,
            timestamp: Number(r.timestamp),
            message: r.message || undefined,
            data: r.data || undefined,
            agentId: r.agent_id || undefined,
            queryId: r.query_id || undefined
          }))
        };
        writeFileSync(filepath, JSON.stringify(archiveData, null, 2));

        // Delete archived items from database
        await this.db.news.deleteArchived(teamId, cutoffTimestamp);

        console.log(`[Manager] Archived ${items.length} news items to ${filepath}`);
        res.json({
          archived: items.length,
          file: filepath,
          cutoffDays: days,
          cutoffDate: new Date(cutoffTimestamp).toISOString()
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /news/archive:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // Step 2 of the manager-collapse migration (docs/design/manager-collapse.md):
    // daemon-owned manager inbox APIs. Lets a CLI (or any team-scoped client)
    // read pending manager queries and post the manager's reply without
    // running its own InteractiveAgentServer process. Reuses the existing
    // queries.complete + emitQueryDelivered + waiter wakeup pipeline used
    // by POST /news so completion semantics stay identical.

    // GET /manager/inbox/pending — returns pending manager queries and
    // scheduled work for the active team. Source of truth is the daemon DB
    // (queries table under the resolved manager-inbox identity), not CLI
    // memory.
    this.managementApp.get('/manager/inbox/pending', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const managerInbox = this.getManagerInboxRef(teamId, teamName);
        const rows = await this.db.queries.getPendingByOwner(teamId, managerInbox.ownerKind, managerInbox.ownerId);
        const pending = rows
          .map((row: any) => {
            const result = (row.result || {}) as Record<string, unknown>;
            return {
              query_id: row.query_id,
              prompt: row.prompt ?? null,
              message: row.prompt || (result.message as string | undefined) || '',
              timestamp: Number(row.created),
              status: row.status,
              session_id: row.session_id ?? null,
              from: (result.from as string | undefined) ?? null,
              reply_endpoint: (result.reply_endpoint as string | undefined) ?? null,
              schedule: (result.schedule as Record<string, unknown> | undefined) ?? null,
              mode: (result.mode as string | undefined) ?? null,
            };
          })
          .sort((a, b) => a.timestamp - b.timestamp);

        res.json({
          ok: true,
          team: teamName,
          inbox_id: managerInbox.inboxApiId,
          count: pending.length,
          pending,
        });
      } catch (err: any) {
        console.error('[Manager] Error in GET /manager/inbox/pending:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // POST /manager/inbox/respond — body: { query_id, message, session_id? }.
    // Preserves the visible response semantics that InteractiveAgentServer.respond
    // emits today: a news row of type `query.completed` with
    // `data: { query_id, result: { result: message } }`, and a queries-table
    // result of `{ result: message }`. The actual completion lifecycle
    // (queries.complete + query:delivered + waiter wakeups) routes through
    // `completeQueryDelivery` so it is the single shared implementation with
    // the POST /news in-reply-to path.
    this.managementApp.post('/manager/inbox/respond', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const body = (req.body || {}) as {
          query_id?: unknown;
          message?: unknown;
          session_id?: unknown;
        };

        const queryId = typeof body.query_id === 'string' ? body.query_id : '';
        const message = typeof body.message === 'string' ? body.message : '';
        const sessionId =
          typeof body.session_id === 'string' && body.session_id.length > 0
            ? body.session_id
            : null;

        if (!queryId) {
          return res.status(400).json({ error: 'Missing query_id' });
        }
        if (!message) {
          return res.status(400).json({ error: 'Missing message' });
        }

        const row = await this.db.queries.getByQueryIdForTeam(teamId, queryId);
        if (!row) {
          return res.status(404).json({ error: 'query_not_found', query_id: queryId });
        }
        if (row.status !== 'pending' && row.status !== 'processing') {
          return res.status(409).json({
            error: 'query_not_pending',
            query_id: queryId,
            status: row.status,
          });
        }

        const managerInbox = this.getManagerInboxRef(teamId, teamName);
        if (row.owner_kind !== managerInbox.ownerKind || row.owner_id !== managerInbox.ownerId) {
          // Pending row exists but isn't owned by the manager inbox — refuse
          // rather than silently completing some other agent's query.
          return res.status(403).json({
            error: 'not_manager_inbox_query',
            query_id: queryId,
          });
        }

        const ts = Date.now();
        // Same shape InteractiveAgentServer.respond writes: queries row stores
        // `{ result: <response text> }`, news row carries
        // `data: { query_id, result: { result: <response text> } }`, type
        // `query.completed`. session_id is folded into both when supplied so
        // resumed CLI sessions continue to work.
        const innerResult: Record<string, unknown> = { result: message };
        if (sessionId) innerResult.session_id = sessionId;
        const newsData: Record<string, unknown> = {
          query_id: queryId,
          result: { result: message },
        };
        if (sessionId) newsData.session_id = sessionId;

        await this.db.news.add(teamId, null, {
          timestamp: ts,
          type: 'query.completed',
          data: newsData,
          query_id: queryId,
          owner_kind: managerInbox.ownerKind,
          owner_id: managerInbox.ownerId,
        });

        // Canonical completion lifecycle. Drives queries.complete +
        // query:delivered emission + long-poll/talk-to waiter wakeups so the
        // wakeup-service event log and any blocked callers see the same
        // transition the POST /news reply path produces.
        await this.completeQueryDelivery({
          teamId,
          queryId,
          occurredAt: ts,
          resultPayload: innerResult,
          waiterReply: { from: 'manager', message },
          messagePreview: message,
        });

        // Fan out to WebSocket subscribers using the same `query.completed`
        // shape the persisted news row carries.
        this.broadcastNews(teamId, {
          type: 'query.completed',
          message,
          in_reply_to: queryId,
          data: newsData,
          timestamp: ts,
        });

        this.managerLog(`/manager/inbox/respond completed query ${queryId}`);

        res.status(200).json({
          ok: true,
          query_id: queryId,
          status: 'completed',
          timestamp: ts,
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /manager/inbox/respond:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // GET /query/:id - one-row lookup for a query's status/result
    // Team-scoped via the team header. Status is mapped to the external
    // vocabulary: { pending, processing, delivered, failed, expired }.
    //
    // Optional `?wait=<seconds>` (0–30, default 0) enables long-poll: if the
    // row is still pending/processing, the handler blocks until a waiter is
    // fired (daemon-side terminal transition) or the wait timeout elapses,
    // then re-reads and returns whatever the DB says.
    this.managementApp.get('/query/:id', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const queryId = req.params.id;

        const waitRaw = req.query.wait;
        let waitSec = 0;
        if (typeof waitRaw === 'string' && waitRaw.length > 0) {
          const parsed = Number.parseInt(waitRaw, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            waitSec = Math.min(parsed, 30);
          }
        }

        const statusMap: Record<string, string> = {
          pending: 'pending',
          processing: 'processing',
          completed: 'delivered',
          cancelled: 'failed',
          failed: 'failed',
          expired: 'expired',
        };
        const isTerminal = (s: string) =>
          s === 'completed' || s === 'delivered' || s === 'failed' || s === 'cancelled' || s === 'expired';

        let row = await this.db.queries.getByQueryIdForTeam(teamId, queryId);
        if (!row) return res.status(404).json({ error: `Query "${queryId}" not found` });

        if (waitSec > 0 && !isTerminal(row.status)) {
          const deadline = Date.now() + waitSec * 1000;
          // Register a single-shot waker and race it against the wait-deadline.
          let wake: () => void = () => {};
          const woke: Promise<void> = new Promise((resolve) => {
            wake = () => resolve();
            this.addQueryStatusWaiter(teamId, queryId, wake);
          });
          try {
            const remaining = deadline - Date.now();
            if (remaining > 0) {
              let timer: NodeJS.Timeout | null = null;
              const timeoutPromise = new Promise<void>((resolve) => {
                timer = setTimeout(resolve, remaining);
              });
              await Promise.race([woke, timeoutPromise]);
              if (timer) clearTimeout(timer);
            }
          } finally {
            this.removeQueryStatusWaiter(teamId, queryId, wake);
          }
          row = await this.db.queries.getByQueryIdForTeam(teamId, queryId);
          if (!row) return res.status(404).json({ error: `Query "${queryId}" not found` });
        }

        const status = statusMap[row.status] || row.status;

        let agentName = 'manager';
        if (row.owner_kind !== 'manager' && row.agent_id) {
          agentName = row.agent_id;
          try {
            const agent = await this.db.agents.getById(row.agent_id);
            if (agent) {
              agentName = (agent.metadata as any)?.alias || agent.name || row.agent_id;
            }
          } catch { /* best-effort */ }
        }

        const response: Record<string, unknown> = {
          query_id: row.query_id,
          status,
          agent: agentName,
          created_at: Number(row.created),
        };
        if (row.completed !== null && row.completed !== undefined) {
          response.completed_at = Number(row.completed);
        }
        if (row.result !== null && row.result !== undefined) {
          response.result = row.result;
        }
        if (row.error) {
          response.error = row.error;
        }

        res.json(response);
      } catch (err: any) {
        console.error('[Manager] Error in GET /query/:id:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.get('/agents', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      // ?all=true includes automator agents (normally hidden)
      const includeAll = req.query.all === 'true' || req.query.all === '1';
      const agents = await this.dbListAgents(teamId, includeAll);
      const isAdmin = this.isAdminRequest(req);
      res.json({
        agents: agents.map(a => this.agentToResponse(a, { isAdmin }))
      });
    });

    // Resolve agent by identifier pattern (alias, ENS domain, tokenId@registry, etc.)
    // Returns warning if multiple agents match
    // NOTE: Must be defined BEFORE /agents/:id to avoid "resolve" matching as an id
    this.managementApp.get('/agents/resolve/:ref', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);
      const ref = decodeURIComponent(req.params.ref);
      const isAdmin = this.isAdminRequest(req);

      if (ref.toLowerCase() === 'manager') {
        return res.status(404).json({ error: `No agent matches "${ref}"` });
      }

      try {
        const matches = await this.dbResolveAgents(teamId, ref);

        if (matches.length === 0) {
          return res.status(404).json({ error: `No agent matches "${ref}"` });
        }

        if (matches.length === 1) {
          return res.json({
            agent: this.agentToResponse(matches[0], { isAdmin }),
            ambiguous: false
          });
        }

        // Multiple matches - build ambiguity warning
        const agentMatches: AgentMatch[] = matches.map(a => ({
          id: a.id,
          alias: normalizeAlias(a.name),
          tokenId: a.token_id || undefined,
          domain: a.domain || undefined,
          port: a.port,
          status: a.status
        }));

        const warning = buildAmbiguityWarning(ref, agentMatches);

        return res.json({
          agents: matches.map(a => this.agentToResponse(a, { isAdmin })),
          ambiguous: true,
          warning
        });
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || 'Invalid identifier format' });
      }
    });

    // Get agent by name (most recent)
    // NOTE: Must be defined BEFORE /agents/:id to avoid "by-name" matching as an id
    this.managementApp.get('/agents/by-name/:name', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      if (req.params.name.toLowerCase() === 'manager') {
        // Reserved-name guard, not a lookup miss — no team was searched, so
        // this message must not claim one.
        return res.status(404).json({ error: 'Agent not found' });
      }
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json(this.agentNotFound(req.params.name, teamName));
      res.json(this.agentToResponse(agent, { isAdmin: this.isAdminRequest(req) }));
    });

    this.managementApp.get('/agents/:id', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json(this.agentNotFound(req.params.id, teamName));
      res.json(this.agentToResponse(agent, { isAdmin: this.isAdminRequest(req) }));
    });

    // List all teams from database
    this.managementApp.get('/teams', async (req, res) => {
      const teams = await this.db.teams.listTeams();

      const teamList = await Promise.all(
        teams.map(async (team) => {
          const agentCount = await this.db.agents.count(team.id);
          return {
            id: team.id,
            name: team.name,
            agentCount: parseInt(agentCount || '0'),
            createdAt: team.created_at
          };
        })
      );

      res.json({ teams: teamList });
    });

    // Create a new team
    this.managementApp.post('/teams', async (req, res) => {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Missing team name' });
      const nameCheck = validateName(name, 'team');
      if (!nameCheck.valid) return res.status(400).json({ error: nameCheck.error });
      try {
        const teamId = await this.db.teams.getOrCreateTeamId(name);

        // Create team directory
        const teamDir = `${this.baseWorkDir}/teams/${name}`;
        if (!existsSync(teamDir)) {
          mkdirSync(teamDir, { recursive: true });
        }

        const team = await this.db.teams.getTeam(teamId);
        if (!team) {
          return res.status(500).json({ error: 'Failed to create team' });
        }
        res.json({
          id: team.id,
          name: team.name,
          createdAt: team.created_at
        });
      } catch (error: any) {
        console.error('Error creating team:', error);
        res.status(500).json({ error: error.message || 'Failed to create team' });
      }
    });

    // Update team settings (port ranges removed — ports are now globally sequential)
    this.managementApp.patch('/teams/:name', async (req, res) => {
      const { name } = req.params;

      try {
        const team = await this.db.teams.getTeamByName(name);
        if (!team) {
          return res.status(404).json({ error: `Team "${name}" not found` });
        }

        res.json({ name: team.name, message: 'Port ranges are no longer used. Ports are allocated globally.' });
      } catch (error: any) {
        res.status(500).json({ error: error.message || 'Failed to update team' });
      }
    });

    // Delete a team
    this.managementApp.delete('/teams/:name', async (req, res) => {
      const { name } = req.params;
      if (!name) {
        return res.status(400).json({ error: 'Missing team name' });
      }

      try {
        const result = await this.deleteEmptyTeamByName(name);
        if (!result.ok) {
          return res.status(result.status).json({ error: result.error });
        }
        res.json(result.result);
      } catch (error: any) {
        console.error('Error deleting team:', error);
        res.status(500).json({ error: error.message || 'Failed to delete team' });
      }
    });

    // Backwards compatibility: /projects endpoints
    this.managementApp.get('/projects', async (req, res) => {
      const teams = await this.db.teams.listTeamsWithConfig();

      const projectList = await Promise.all(
        teams.map(async (team) => {
          // Count agents in this team
          const agentCount = await this.db.agents.count(team.id);

          return {
            id: team.id,
            name: team.name,
            agentCount: parseInt(agentCount || '0'),
            createdAt: team.created_at
          };
        })
      );

      res.json({ projects: projectList });
    });

    // Backwards compatibility: create project
    this.managementApp.post('/projects', async (req, res) => {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Missing project name' });
      const projNameCheck = validateName(name, 'team');
      if (!projNameCheck.valid) return res.status(400).json({ error: projNameCheck.error });

      try {
        // Create team in database (will auto-assign port range)
        const teamId = await this.db.teams.getOrCreateTeamId(name);

        // Get the created team details
        const team = await this.db.teams.getTeam(teamId);

        if (!team) {
          return res.status(500).json({ error: 'Failed to create project' });
        }

        res.json({
          id: team.id,
          name: team.name,
          createdAt: team.created_at
        });
      } catch (error: any) {
        console.error('Error creating project:', error);
        res.status(500).json({ error: error.message || 'Failed to create project' });
      }
    });

    this.managementApp.post('/agents/spawn', async (req, res) => {
      let teamId = '';
      let teamName = '';
      let id = '';
      try {
        const team = await this.getTeam(req);
        teamId = team.id;
        teamName = team.name;

        const { name, type: agentType, model, runtime, allowedTools, pluginPath, plugins, skills, metadata: reqMetadata, local, agent, roleBody, heartbeat, openMode, workingDirectory: configWorkDir, verbose, dangerouslySkipPermissions, effort, domain, tokenId, address, wallet } = req.body || {};
        const agentOverlay = agent;
        if (!name) return res.status(400).json({ error: 'Missing name' });
        const agentNameCheck = validateName(name, 'agent');
        if (!agentNameCheck.valid) return res.status(400).json({ error: agentNameCheck.error });

        // Local agent: runs locally using the selected runtime's auth flow
        const isLocalAgent = local === true || local === 'true';
        if (local !== undefined) {
          console.log(`[AgentManager] Spawn request: name=${name}, local=${local} (type: ${typeof local}), isLocalAgent=${isLocalAgent}`);
        }

        // Note: Duplicate names are allowed - agents are uniquely identified by their token ID (e.g., agent.42)

        // Runtime defaults to the shared runtime registry default
        if (runtime !== undefined && !isRuntimeId(runtime)) {
          return res.status(400).json({
            error: `Unknown runtime "${runtime}". Expected one of: ${getAvailableRuntimes().join(', ')}`
          });
        }

        // Remote-endpoint runtimes are registry-only — they are never spawned locally.
        if (runtime !== undefined && isRemoteEndpointRuntime(runtime)) {
          return res.status(400).json({
            error: 'runtime_not_spawnable',
            message: 'public-agent-remote is a remote endpoint runtime. Use POST /agents/register with customer_domain to register an externally-deployed agent.',
          });
        }

        const effectiveRuntime = resolveRuntime(runtime);
        let reasoningEffort: CodexReasoningEffort | undefined;
        if (effort !== undefined) {
          if (!isCodexReasoningEffort(effort)) {
            return res.status(400).json({
              error: `effort must be one of: low, medium, high, xhigh`
            });
          }
          if (effectiveRuntime !== 'codex') {
            return res.status(400).json({
              error: 'effort is only supported for runtime: codex'
            });
          }
          reasoningEffort = effort;
        }

        id = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        // §6.1: `workingDirectory` comes straight from the request body and
        // validateName covers only the NAME, so an unguarded value put the
        // agent's workspace anywhere on the host. Resolve it against the
        // permitted roots BEFORE it is used to derive any path or touch disk.
        // An omitted value keeps the existing default and is not validated,
        // because we built it ourselves.
        let requestedWorkDir: string | undefined;
        if (configWorkDir !== undefined && configWorkDir !== null && configWorkDir !== '') {
          const verdict = resolveWithinRoots(configWorkDir, agentWorkdirRoots(this.baseWorkDir));
          if (!verdict.ok) {
            console.warn(`[Spawn] rejected workingDirectory: ${verdict.reason}`);
            return res.status(400).json({ error: 'invalid_working_directory' });
          }
          // Store the RESOLVED path: keeping the raw one would let a symlink be
          // re-followed somewhere else after the check.
          requestedWorkDir = verdict.path;
        }

        const workingDirectory = requestedWorkDir || `${this.baseWorkDir}/agents/${id}`;

        // Get default plugins from config
        const defaultPlugins = this.getDefaultPlugins();

        // Merge user plugins with defaults (user plugins take precedence for same name)
        const userPlugins = plugins || [];
        const userPluginNames = new Set(userPlugins.map((p: any) => p.name));
        const mergedPlugins = [
          ...userPlugins,
          ...defaultPlugins.filter(p => !userPluginNames.has(p.name))
        ];

        // Use default model from config if not specified
        const effectiveModel = model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
        this.ensureRuntimeReady(effectiveRuntime, effectiveModel);

        // Create workspace directory first (needed for plugin copy)
        mkdirSync(workingDirectory, { recursive: true });

        // 1. Deploy library-backed agent overlay into the runtime overlay target, if configured
        if (agentOverlay) {
          copyLibraryAgentOverlay(workingDirectory, agentOverlay, effectiveRuntime);
        }

        // §6.2 PARITY STEP 1 — wallet. Deploy provisions on `wallet: true`;
        // spawn did not, so an agent added to a live team had no wallet however
        // the team was configured. Gated identically: only `true` calls the
        // `ows` CLI.
        const spawnWalletOptIn = wallet === true || wallet === 'true';
        const owsWallet = spawnWalletOptIn
          ? this.getOrCreateAgentWallet(teamName, name)
          : null;

        // §6.2 PARITY STEP 2 — org context. Deploy has the parsed config in
        // hand; spawn does not, so it recovers the team's `org` block from the
        // config file the team recorded.
        const { org: spawnOrg } = await this.loadTeamOrg(teamId);
        let spawnOrgContext = '';
        if (spawnOrg?.groups) {
          try {
            const { generateAgentOrgContext } = await import('./org-chart.js');
            spawnOrgContext = generateAgentOrgContext(name, spawnOrg);
          } catch { /* org context is best-effort, exactly as in deploy */ }
        }

        // 2. Deploy team-level skills (runtime-aware: .claude/skills/ or .agents/skills/)
        // Also runs when there are no skills but there IS org context, so the
        // context is not silently dropped for a skill-less spawn — deploy always
        // calls this, which is where the asymmetry came from.
        if ((skills && Array.isArray(skills) && skills.length > 0) || spawnOrgContext) {
          this.deploySkillsToAgent(workingDirectory, Array.isArray(skills) ? skills : [], {
            DISPLAY_NAME: domain || name,
            TEAM: teamName,
            ORG_CONTEXT: spawnOrgContext
              ? `\n## Your Role\n\n${spawnOrgContext}\n\nSee the full org chart at the shared team folder for details on all groups.`
              : '',
          }, { hasWallet: !!owsWallet, runtime: effectiveRuntime });
        }

        // 3. Overlay working-directory template files (runtime-aware)
        copyAgentDirOverlay(workingDirectory, name, effectiveRuntime);
        // Copy HEARTBEAT.md from template to working directory root
        copyHeartbeatMd(workingDirectory, name, effectiveRuntime);

        // 4. Write personality file: protocol defaults + agent role body.
        // For Codex/Cursor this is a marker-fenced framework block inside
        // workspace-root AGENTS.md so user edits and the agent persona block
        // (step 5) survive deploy/sync/rebuild refreshes.
        {
          const parts = [PROTOCOL_DEFAULTS];
          if (roleBody) parts.push(roleBody);
          writePersonalityFile(workingDirectory, effectiveRuntime, parts.join('\n\n'));
        }

        // 5. For Codex/Cursor, append the library persona to AGENTS.md
        // between marker fences (no-op for Claude; persona lives in
        // .claude/rules/ sidecar). Runs AFTER the framework write so the
        // marker block sits below the framework section.
        if (agentOverlay) {
          appendLibraryPersonaToAgentsMd(workingDirectory, agentOverlay, effectiveRuntime);
        }

        // Copy plugins to agent's working directory (agent owns its plugins)
        const localPlugins = this.copyPluginsToAgent(mergedPlugins, workingDirectory);

        // Determine effective agent type (default to 'claude')
        const effectiveAgentType = agentType || 'claude';
        const isAutomator = effectiveAgentType === 'automator';
        const normalizedSkills = normalizeConfigSkills(skills);

        const metadata: AgentMetadata = {
          name,
          // Automators don't have REST-AP endpoints
          ...(isAutomator ? {} : { service_type: 'REST-AP', endpoint: '' }),
          runtime: effectiveRuntime,  // Store runtime for display/querying
          // Store config in metadata for later reference
          ...(reqMetadata?.description && { description: reqMetadata.description }),
          plugins: localPlugins, // Use local paths (agent owns its plugins)
          ...(agentOverlay && { agent: agentOverlay }),
          ...(normalizedSkills && { skills: normalizedSkills }),
          ...(allowedTools && { allowed_tools: allowedTools }),
          ...(isAutomator && { isAutomator: true }),
          // Flag that heartbeat is enabled (actual config read from HEARTBEAT.yaml)
          ...(heartbeat && { heartbeat: true }),
          ...(openMode !== undefined && { openMode: openMode === true || openMode === 'true' }),
          ...(reasoningEffort && { effort: reasoningEffort }),
          ...(dangerouslySkipPermissions !== undefined && { dangerouslySkipPermissions: dangerouslySkipPermissions === true || dangerouslySkipPermissions === 'true' }),
          // §6.2: record the explicit opt-in and the provisioned wallet, same
          // shape deploy writes, so the wallet gate and export see one format.
          ...(wallet !== undefined && { wallet: spawnWalletOptIn }),
          ...(owsWallet && { ows_wallet: owsWallet.walletName, ows_address: owsWallet.address })
        };

        await this.db.agents.create({
          team_id: teamId,
          id,
          name,
          type: effectiveAgentType,
          model: effectiveModel,
          port: 0,
          endpoint: null,
          working_directory: workingDirectory,
          status: 'starting',
          created_at: Date.now(),
          metadata,
          api_key: null,
          token_id: tokenId || null,
          domain: domain || null,
          runtime: effectiveRuntime,
        });

        // Derive agent_account from the explicit request address, if provided
        const agentAccount = address || null;
        const updatedMeta = { ...metadata, ...(agentAccount && { agent_account: agentAccount }) };
        await this.db.agents.updateMetadata(id, updatedMeta);

        // All agents run locally
        const allocatedPort = await this.dbNextPort(teamId);
        const url = `http://localhost:${allocatedPort}`;
        const finalMeta: AgentMetadata = {
          ...updatedMeta,
          service_type: 'REST-AP',
          endpoint: url,
          local: true,
          runtime: effectiveRuntime
        };
        await this.db.agents.updateStatus(id, 'pending', {
          port: allocatedPort,
          endpoint: url,
          metadata: finalMeta,
        });
        this.scheduleAutoExport(teamId); // §5.4 — agent create

        // Use host paths for local agents
        // If configWorkDir is an absolute path, use it directly (project repo)
        const hostWorkspaceDir = process.env.ID_WORKSPACE_DIR || this.baseWorkDir;
        // Derives from the VALIDATED value, never the raw body field.
        const hostWorkingDirectory = requestedWorkDir && path.isAbsolute(requestedWorkDir) ? requestedWorkDir : `${hostWorkspaceDir}/agents/${id}`;
        const hostSharedDirectory = `${hostWorkspaceDir}/teams/${teamName}`;

        // Seed heartbeat schedule if enabled
        if (heartbeat && this.schedulerService) {
          const { definition, agentIds } = heartbeatToSchedule(id, name, heartbeat);
          await this.schedulerService.seedSchedule(definition, agentIds);
          this.scheduleAutoExport(teamId); // §5.4 — schedule mutation
        }

        res.status(201).json({
          id,
          name,
          model: effectiveModel,
          runtime: effectiveRuntime,
          port: allocatedPort,
          status: 'pending',  // Will become 'running' when local process starts
          type: 'claude',
          local: true,
          url,
          restap: `${url}/.well-known/restap.json`,
          metadata: finalMeta,
          // Info for CLI to spawn local agent process
          teamId,
          teamName,
          workingDirectory: hostWorkingDirectory,
          sharedDirectory: hostSharedDirectory
        });
        this.broadcastAgentsChanged(teamId, { reason: 'spawn', added: [name] });
      } catch (error: any) {
        // Ensure we never return Express's default HTML error page (CLI expects JSON).
        try {
          if (teamId && id) {
            await this.db.agents.updateStatus(id, 'error');
          }
        } catch {
          // ignore
        }

        res.status(500).json({ error: error?.message || String(error) });
      }
    });

    this.managementApp.post('/agents/register', async (req, res) => {
      const { id: teamId } = await this.getTeam(req);

      // A request with runtime==='public-agent-remote' adds an externally deployed
      // agent to the manager roster. It has no local port or process.
      if ((req.body as any)?.runtime === 'public-agent-remote') {
        const {
          name: remoteName,
          customer_domain,
          public_endpoint_url,
          internal_endpoint_url,
          ssh_target,
          wallet,
        } = req.body as any;

        // Required fields
        if (!remoteName) return res.status(400).json({ error: 'missing_field', message: 'name is required' });
        if (!customer_domain) return res.status(400).json({ error: 'missing_field', message: 'customer_domain is required' });
        if (!public_endpoint_url) return res.status(400).json({ error: 'missing_field', message: 'public_endpoint_url is required' });

        // Name validation
        const remoteNameCheck = validateName(remoteName, 'agent');
        if (!remoteNameCheck.valid) return res.status(400).json({ error: 'invalid_name', message: remoteNameCheck.error });

        // URL validation
        try { new URL(public_endpoint_url); } catch {
          return res.status(400).json({ error: 'invalid_url', message: 'public_endpoint_url must be a valid URL' });
        }
        if (internal_endpoint_url) {
          try { new URL(internal_endpoint_url); } catch {
            return res.status(400).json({ error: 'invalid_url', message: 'internal_endpoint_url must be a valid URL' });
          }
        }

        // Reject if name already exists in team
        const existing = await this.dbQueryAgentByNameMostRecent(teamId, remoteName);
        if (existing) {
          return res.status(409).json({ error: 'name_conflict', message: `Agent "${remoteName}" already exists in this team` });
        }

        const remoteId = `remote_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const now = Date.now();

        const remoteWalletOptIn = wallet === true;

        // Phase 4 security posture is stamped at manager-join so the DMZ
        // semantics hold from the moment the row exists, independent of any
        // later registration step.
        const remoteMetadata: AgentMetadata = {
          wallet: remoteWalletOptIn,
          mesh_member: false,
          mesh_reachable: false,
          public_endpoint: true,
          dmz: true,
          allowed_inbound: ['public_http'],
          allowed_outbound: ['openrouter'],
        };

        await this.db.agents.create({
          team_id: teamId,
          id: remoteId,
          name: remoteName,
          type: 'virtual',
          model: 'unknown',
          port: 0,
          endpoint: null,
          working_directory: null,
          status: 'registered',
          created_at: now,
          runtime: 'public-agent-remote',
          customer_domain: customer_domain,
          public_endpoint_url: public_endpoint_url,
          internal_endpoint_url: internal_endpoint_url ?? null,
          ssh_target: ssh_target ?? null,
          metadata: remoteMetadata,
        });

        // Wallet opt-in: provision an OWS wallet at join time (the manager
        // host owns the `ows` CLI; the VPS never sees key material).
        // Non-fatal — the agent still joins without a wallet if OWS is
        // missing or creation fails.
        let responseMetadata: AgentMetadata = remoteMetadata;
        if (remoteWalletOptIn) {
          const row = await this.dbQueryAgentById(teamId, remoteId);
          if (row) {
            const refreshed = await this.provisionAgentWalletForRow(teamId, 'public', row);
            if (refreshed) {
              responseMetadata = (refreshed.metadata || remoteMetadata) as AgentMetadata;
              try {
                await this.stageAndDeliverRemoteWalletIdentity(refreshed);
              } catch (err: any) {
                console.warn(`[Register] Wallet identity delivery failed for "${remoteName}": ${err?.message || String(err)}`);
              }
            } else {
              console.warn(`[Register] OWS not installed or wallet creation failed for remote agent "${remoteName}". Proceeding without wallet.`);
            }
          }
        }

        return res.status(201).json({
          id: remoteId,
          name: remoteName,
          runtime: 'public-agent-remote',
          deploymentShape: 'remote-endpoint',
          status: 'registered',
          port: null,
          url: null,
          customer_domain,
          public_endpoint_url,
          internal_endpoint_url: internal_endpoint_url ?? null,
          ssh_target: ssh_target ?? null,
          metadata: responseMetadata,
          health: 'unknown',
        });
      }

      const { id: requestedIdRaw, name, endpoint, metadata, type: requestedTypeRaw } = req.body || {};
      if (!name || !endpoint) return res.status(400).json({ error: 'Missing name or endpoint' });
      const regNameCheck = validateName(name, 'agent');
      if (!regNameCheck.valid) return res.status(400).json({ error: regNameCheck.error });

      const requestedId = typeof requestedIdRaw === 'string' ? requestedIdRaw.trim() : undefined;
      if (requestedId && !/^[a-zA-Z0-9_:-]{1,200}$/.test(requestedId)) {
        return res.status(400).json({ error: 'Invalid id format' });
      }

      const requestedType =
        typeof requestedTypeRaw === 'string' ? requestedTypeRaw.trim().toLowerCase() : undefined;
      // Allow 'claude' type for local agents, 'interactive' for CLI users, 'virtual' for external
      const type = requestedType === 'interactive' ? 'interactive'
        : requestedType === 'claude' ? 'claude'
        : 'virtual';

      // Generate stable ID based on agent type
      const idPrefix = type === 'claude' ? 'local_' : 'virtual_';
      const stableId =
        idPrefix +
        name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 60);

      const id = requestedId || stableId;

      // Backwards-compat: if client didn't provide an id, keep the old "dedupe by name" behavior.
      // If client provides an id, treat id as canonical and do not delete other agents that happen to share the same name.
      if (!requestedId) {
        await this.db.agents.softDelete(teamId, name, id, Date.now());
      }

      // Self-registration lands after spawnLocalAgentProcess already persisted
      // `pid` onto the row's metadata. Merge over the existing row so the pid
      // (and anything else a spawn-time path set) survives registration.
      const priorRow = await this.db.agents.getById(id).catch(() => null);
      const priorMeta = (priorRow?.metadata as Record<string, unknown>) || {};
      const meta: AgentMetadata = {
        ...priorMeta,
        name,
        service_type: (metadata && metadata.service_type) || 'REST-AP',
        endpoint,
        ...(metadata || {}),
        ...(typeof (priorMeta as { pid?: unknown }).pid === 'number'
          ? { pid: (priorMeta as { pid: number }).pid }
          : {}),
      };

      // Extract domain from request body if provided
      const reqDomain = (req.body as any).domain || null;

      await this.db.agents.upsert({
        team_id: teamId,
        id,
        name,
        type,
        model: 'external',
        port: 0,
        endpoint,
        working_directory: '',
        status: 'running',
        created_at: Date.now(),
        metadata: meta,
        domain: reqDomain,
      });

      res.status(201).json({
        id,
        name,
        type,
        status: 'running',
        url: endpoint,
        restap: `${endpoint}/.well-known/restap.json`,
        domain: reqDomain,
        metadata: meta
      });
    });

    this.managementApp.post('/agents/:id/metadata', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json(this.agentNotFound(req.params.id, teamName));

      const { metadata } = req.body || {};
      const nextMetadata = metadata ? { ...(agent.metadata || {}), ...(metadata || {}) } : agent.metadata;

      await this.db.agents.updateMetadata(agent.id, nextMetadata);

      // Agent self-publishing a pid is proof of life — flip status to running.
      // Without this, SQLite-mode deploys leave agents stuck on 'pending'
      // (the db-direct updateStatus path only runs when DATABASE_URL is set).
      const incomingPid = (metadata as { pid?: unknown } | undefined)?.pid;
      if (typeof incomingPid === 'number' && agent.status !== 'running') {
        await this.db.agents.updateStatus(agent.id, 'running');
      }

      const server = this.runningServers.get(this.key(teamId, agent.id));
      if (server && agent.type === 'claude') {
        server.setIdentity({
          name: agent.name,
          metadata: nextMetadata,
          tokenId: agent.token_id || undefined,
          domain: agent.domain || undefined
        });
      }

      this.scheduleAutoExport(teamId); // §5.4
      res.json({ id: agent.id, name: agent.name, metadata: nextMetadata });
    });

    this.managementApp.post('/agents/by-name/:name/metadata', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json(this.agentNotFound(req.params.name, teamName));
      const { metadata } = req.body || {};
      const nextMetadata = metadata ? { ...(agent.metadata || {}), ...(metadata || {}) } : agent.metadata;

      await this.db.agents.updateMetadata(agent.id, nextMetadata);

      const server = this.runningServers.get(this.key(teamId, agent.id));
      if (server && agent.type === 'claude') {
        server.setIdentity({
          name: agent.name,
          metadata: nextMetadata,
          tokenId: agent.token_id || undefined,
          domain: agent.domain || undefined
        });
      }

      this.scheduleAutoExport(teamId); // §5.4
      res.json({ id: agent.id, name: agent.name, metadata: nextMetadata });
    });

    // Runtime profile editor: update bio/handles on the agent record and
    // persist them back to the team's last-deployed config YAML so they
    // survive restart and /sync (which re-applies the YAML floor).
    this.managementApp.post('/agents/by-name/:name/profile', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json(this.agentNotFound(req.params.name, teamName));

      const body = (req.body || {}) as { bio?: unknown; handles?: unknown };
      if (body.bio === undefined && body.handles === undefined) {
        return res.status(400).json({ error: 'Provide bio and/or handles (null clears a field)' });
      }
      if (body.bio !== undefined && body.bio !== null) {
        if (typeof body.bio !== 'string') {
          return res.status(400).json({ error: 'bio must be a string (or null to clear)' });
        }
        if (body.bio.length > PROFILE_BIO_MAX_LENGTH) {
          return res
            .status(400)
            .json({ error: `bio must be at most ${PROFILE_BIO_MAX_LENGTH} characters` });
        }
      }
      if (body.handles !== undefined && body.handles !== null) {
        const handleErrors = validateAgentHandles(body.handles);
        if (handleErrors.length > 0) {
          return res.status(400).json({ error: handleErrors.join('; ') });
        }
      }

      const nextMetadata = { ...(agent.metadata || {}) } as Record<string, unknown>;
      if (body.bio !== undefined) {
        if (body.bio === null) delete nextMetadata.bio;
        else nextMetadata.bio = body.bio;
      }
      if (body.handles !== undefined) {
        if (body.handles === null) delete nextMetadata.handles;
        else nextMetadata.handles = body.handles;
      }
      await this.db.agents.updateMetadata(agent.id, nextMetadata);

      const server = this.runningServers.get(this.key(teamId, agent.id));
      if (server && agent.type === 'claude') {
        server.setIdentity({
          name: agent.name,
          metadata: nextMetadata,
          tokenId: agent.token_id || undefined,
          domain: agent.domain || undefined,
        });
      }

      // Persist to the last-deployed config YAML when the manager knows it.
      // The path comes only from recorded team state, never from the caller.
      let persistedToConfig = false;
      let configNote: string | undefined;
      const teamConfig = await this.db.teams.getConfig(teamId);
      const configPath =
        typeof teamConfig.last_config_path === 'string' ? teamConfig.last_config_path : undefined;
      if (configPath) {
        const writeResult = writeProfileToConfig(configPath, agent.name, {
          bio: body.bio as string | null | undefined,
          handles: body.handles as AgentHandles | null | undefined,
        });
        persistedToConfig = writeResult.ok;
        if (!writeResult.ok) configNote = writeResult.reason;
      } else {
        configNote = 'no deployed config recorded for this team; profile stored on the agent record only';
      }

      res.json({
        id: agent.id,
        name: agent.name,
        bio: (nextMetadata.bio as string | undefined) ?? null,
        handles: (nextMetadata.handles as AgentHandles | undefined) ?? null,
        persistedToConfig,
        ...(configNote && { configNote }),
      });
    });

    // Note: Agent catalogs are managed by agents themselves via their /catalog endpoint
    // This follows REST-AP where each agent owns its own /.well-known/restap.json
    // To view an agent's catalog, fetch their restap.json: GET {agent.url}/.well-known/restap.json

    this.managementApp.post('/agents/:id/model', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const { model } = req.body;

      if (!model) {
        return res.status(400).json({ error: 'Missing model in request body' });
      }

      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json(this.agentNotFound(req.params.id, teamName));

      if (agent.type !== 'claude') {
        return res.status(400).json({ error: 'Only local runtime-backed agents have models' });
      }

      try {
        // Update model in database - agent needs restart to pick up new model
        await this.db.agents.updateStatus(agent.id, 'pending', { model });

        console.log(`[Manager] Updated model for ${agent.name} to ${model} - restart required`);
        this.scheduleAutoExport(teamId); // §5.4

        res.json({
          id: agent.id,
          name: agent.name,
          model: model,
          status: 'pending',
          message: 'Model updated. Restart the agent to apply the new model.'
        });
      } catch (e: any) {
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // POST /agents/:id/probe — ad-hoc heartbeat probe for remote-endpoint agents
    this.managementApp.post('/agents/:id/probe', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const agent = await this.dbQueryAgentById(teamId, req.params.id);
        if (!agent) return res.status(404).json(this.agentNotFound(req.params.id, teamName));

        if (!isRemoteEndpointRuntime(agent.runtime)) {
          return res.status(400).json({ error: 'probe_only_supported_for_remote' });
        }

        await this.probeOneRemoteAgent(teamId, agent);
        // Re-fetch to get the updated values
        const updated = await this.dbQueryAgentById(teamId, agent.id);
        if (!updated) return res.status(404).json(this.agentNotFound(agent.id, teamName, '(after probe)'));

        const health = this.deriveRemoteHealth(updated);
        res.json({
          ok: updated.consecutive_failures === 0,
          source: updated.last_error === 'health probe failed, well-known succeeded'
            ? 'well-known'
            : updated.consecutive_failures === 0 ? 'health' : 'none',
          last_seen: updated.last_seen ?? null,
          last_error: updated.last_error ?? null,
          consecutive_failures: updated.consecutive_failures ?? 0,
          health,
        });
      } catch (err: any) {
        res.status(500).json({ error: err?.message ?? String(err) });
      }
    });

    // PATCH /agents/:id/metadata — update agent properties (wallet, name, etc.)
    this.managementApp.patch('/agents/:id/metadata', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);
        const agent = await this.dbQueryAgentById(teamId, req.params.id);
        if (!agent) return res.status(404).json(this.agentNotFound(req.params.id, teamName));

        const { wallet, name: newName } = req.body;
        const hasUpdates = wallet || newName;

        if (!hasUpdates) return res.status(400).json({ error: 'No updates provided' });

        if (wallet) {
          const metadata = { ...(agent.metadata as any || {}), wallet_address: wallet };
          await this.db.agents.updateMetadata(agent.id, metadata);
        }
        if (newName) {
          const nameCheck = validateName(newName, 'agent');
          if (!nameCheck.valid) return res.status(400).json({ error: nameCheck.error });
          await this.db.agents.updateIdentity(agent.id, { name: newName });
        }

        res.json({ ok: true, updated: Object.keys(req.body) });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.managementApp.delete('/agents/:id', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const agent = await this.dbQueryAgentById(teamId, req.params.id);
      if (!agent) return res.status(404).json(this.agentNotFound(req.params.id, teamName));

      // Stop runtime server if running
      const serverKey = this.key(teamId, agent.id);
      const server = this.runningServers.get(serverKey);
      if (server) {
        try {
          await server.stop();
        } catch (e) {
          console.error(`⚠️ Failed to stop agent server ${agent.name} (${agent.id}):`, e);
        }
        this.runningServers.delete(serverKey);
      }

      // Best-effort delete workspace for claude agents
      if (agent.type === 'claude' && agent.working_directory) {
        try {
          const expectedDir = `${this.baseWorkDir}/agents/${agent.id}`;
          if (agent.working_directory === expectedDir) {
            rmSync(agent.working_directory, { recursive: true, force: true });
          }
        } catch (e) {
          console.error(`⚠️ Failed to delete workspace for ${agent.name} (${agent.id}):`, e);
        }
      }

      // Delete record (cascades wallets/news/queries)
      await this.db.agents.deleteAgent(agent.id);
      this.scheduleAutoExport(teamId); // §5.4
      res.json({ message: 'Agent deleted', id: agent.id, name: agent.name });
      this.broadcastAgentsChanged(teamId, { reason: 'remove', removed: [agent.name] });
    });

    this.managementApp.delete('/agents/by-name/:name', async (req, res) => {
      const { id: teamId, name: teamName } = await this.getTeam(req);
      const agent = await this.dbQueryAgentByNameMostRecent(teamId, req.params.name);
      if (!agent) return res.status(404).json(this.agentNotFound(req.params.name, teamName));
      const serverKey = this.key(teamId, agent.id);
      const server = this.runningServers.get(serverKey);
      if (server) {
        try {
          await server.stop();
        } catch {}
        this.runningServers.delete(serverKey);
      }
      if (agent.type === 'claude' && agent.working_directory) {
        try {
          const expectedDir = `${this.baseWorkDir}/agents/${agent.id}`;
          if (agent.working_directory === expectedDir) rmSync(agent.working_directory, { recursive: true, force: true });
        } catch {}
      }
      await this.db.agents.deleteAgent(agent.id);
      this.scheduleAutoExport(teamId); // §5.4
      res.json({ message: 'Agent deleted', id: agent.id, name: agent.name });
      this.broadcastAgentsChanged(teamId, { reason: 'remove', removed: [agent.name] });
    });



    // ==================== REMOTE CLI ENDPOINT ====================
    // Allows external tools to execute CLI-style commands

    this.managementApp.post('/remote', async (req, res) => {

      const { command, from } = req.body;
      if (!command || typeof command !== 'string') {
        return res.status(400).json({ error: 'Missing command in request body' });
      }

      const { id: teamId, name: teamName } = await this.getTeam(req);

      try {
        const result = await this.executeRemoteCommand(command.trim(), teamId, teamName, typeof from === 'string' ? from : undefined);
        // A command may ask for a specific HTTP status via `httpStatus`. The
        // field is deliberately NOT the older `status` some helpers already
        // return: honouring that one here would silently change the response
        // code of pre-existing paths, which is outside this change.
        if (typeof result.httpStatus === 'number') {
          return res.status(result.httpStatus).json({ error: result.error, message: result.message });
        }
        res.json(result);
      } catch (error: any) {
        res.status(500).json({ error: error.message || 'Command execution failed' });
      }
    });

    // Handle /:tokenId without trailing path - returns agent info
    // NOTE: Must be defined BEFORE the wildcard route to take precedence.
    // Non-numeric paths pass through to allow downstream routes (tasks, etc.) to match.
    this.managementApp.get('/:tokenId', async (req, res, next) => {
      const tokenIdParam = req.params.tokenId;

      // Only handle numeric tokenIds; pass all others to downstream routes
      if (!/^\d+$/.test(tokenIdParam)) {
        return next();
      }

      const { id: teamId } = await this.getTeam(req);

      // Find agent by tokenId
      const agents = await this.dbListAgents(teamId, true);
      const agent = agents.find(a => a.token_id === tokenIdParam);

      if (!agent) {
        return res.status(404).json({ error: `Agent with tokenId ${tokenIdParam} not found` });
      }

      // Return agent info with links
      const baseUrl = `${req.protocol}://${req.get('host')}/${tokenIdParam}`;
      res.json({
        agent: this.agentToResponse(agent, { isAdmin: this.isAdminRequest(req) }),
        links: {
          catalog: `${baseUrl}/.well-known/restap.json`,
          talk: `${baseUrl}/talk`,
          news: `${baseUrl}/news`
        }
      });
    });

    // TokenId-based agent proxy route: /:tokenId/* -> proxy to agent
    // This allows accessing agents via https://idbot.live/23/talk etc.
    // Express 5 uses {*path} syntax for wildcards
    // Use regex for wildcard path matching in Express 5
    // Matches /85/talk, /85/.well-known/restap.json, etc.
    this.managementApp.all(/^\/(\d+)\/(.+)$/, async (req, res) => {
      const tokenIdParam = req.params[0]; // First capture group is tokenId

      const { id: teamId } = await this.getTeam(req);

      // Find agent by tokenId
      const agents = await this.dbListAgents(teamId, true);
      const agent = agents.find(a => a.token_id === tokenIdParam);

      if (!agent) {
        return res.status(404).json({ error: `Agent with tokenId ${tokenIdParam} not found` });
      }

      // Get the agent's internal URL
      const isExternal = agent.type === 'virtual' || agent.type === 'interactive';
      const internalUrl = agent.type === 'claude'
        ? (agent.endpoint || `http://localhost:${agent.port}`)
        : (isExternal ? agent.endpoint : null);
      if (!internalUrl) {
        return res.status(503).json({ error: 'Agent endpoint not available' });
      }

      // Build the proxied path (everything after /:tokenId)
      // Extract path from URL: /23/talk -> talk
      const urlPath = req.path;
      const pathAfterTokenId = urlPath.replace(new RegExp(`^/${tokenIdParam}/?`), '');
      const targetUrl = `${internalUrl.replace(/\/+$/, '')}/${pathAfterTokenId}`;

      try {
        const proxyRes = await fetch(targetUrl, {
          method: req.method,
          headers: {
            'Content-Type': req.headers['content-type'] || 'application/json',
            'Accept': req.headers['accept'] || 'application/json'
          },
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body)
        });

        const contentType = proxyRes.headers.get('content-type') || 'application/json';
        res.status(proxyRes.status).type(contentType);

        const body = await proxyRes.text();
        res.send(body);
      } catch (error: any) {
        res.status(502).json({ error: `Proxy error: ${error.message}` });
      }
    });

    // ==================== TASK REST ENDPOINTS ====================
    // Dedicated task API so agents don't need /remote for task ops

    this.managementApp.post('/tasks', async (req, res) => {
      try {
        let { id: teamId } = await this.getTeam(req);
        const principal = (req as any).ctx?.principal || 'anon';
        const { title, name: rawName, description, team: teamRef, from } = req.body || {};

        if (!title || typeof title !== 'string') {
          return res.status(400).json({ error: 'Missing required field: title' });
        }

        // Resolve created_by from `from` field first so we can recover the
        // caller's team when no explicit team header was supplied. This lets
        // a deployed agent in a non-default team create a task under its own
        // name using the documented protocol (no team header, just `from`).
        let createdBy: string | null = null;
        let callerAgent: AgentRow | undefined;
        if (from && typeof from === 'string') {
          const first = await this.resolveSingleAgentForCommand(teamId, from);
          callerAgent = first.agent;
          if (!callerAgent && !this.isTeamExplicit(req) && !teamRef) {
            const fallback = await this.resolveCallerAcrossTeams(from);
            if (fallback) {
              callerAgent = fallback.agent;
              teamId = fallback.teamId;
            }
          }
          if (callerAgent) createdBy = callerAgent.id;
        }

        // Resolve team — non-admin principals cannot create tasks in another team
        let taskTeamId: string = teamId;
        if (teamRef) {
          const teamRow = await this.db.teams.getTeamByName(teamRef);
          if (!teamRow) return res.status(404).json({ error: `Team "${teamRef}" not found` });
          if (teamRow.id !== teamId && principal !== 'admin') {
            return res.status(403).json({ error: 'Cannot create task in another team without admin principal' });
          }
          taskTeamId = teamRow.id;
        }

        // Generate or validate name slug, scoped to (team_id, name) uniqueness
        let name = rawName ? normalizeAlias(rawName) : normalizeAlias(title);
        if (rawName) {
          if (await this.db.tasks.getByNameForTeam(name, taskTeamId)) {
            return res.status(409).json({ error: `Task name "${name}" already exists in this team` });
          }
        } else {
          let candidate = name;
          let suffix = 1;
          while (await this.db.tasks.getByNameForTeam(candidate, taskTeamId)) {
            candidate = `${name}-${suffix++}`;
          }
          name = candidate;
        }

        const now = Math.floor(Date.now() / 1000);
        const taskRow: TaskRow = {
          id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          name,
          uuid: crypto.randomUUID(),
          team_id: taskTeamId,
          title,
          description: description || null,
          status: 'todo',
          created_by: createdBy,
          owner: null,
          created_at: now,
          updated_at: now,
          completed_at: null,
        };

        await this.db.tasks.create(taskRow);
        res.status(201).json({ ok: true, task: await this.buildTaskResult(taskRow, teamId) });
      } catch (err: any) {
        console.error('[Manager] Error in POST /tasks:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.get('/tasks', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const { status, owner, team: teamRef } = req.query as Record<string, string>;

        // Resolve owner
        let ownerIdFilter: string | undefined;
        if (owner) {
          const { agent, error } = await this.resolveSingleAgentForCommand(teamId, owner);
          if (!agent) return res.status(404).json({ error: error || `Agent "${owner}" not found` });
          ownerIdFilter = agent.id;
        }

        // Resolve team — default to current team for scoped resolution
        let teamIdFilter: string = teamId;
        if (teamRef) {
          const teamRow = await this.db.teams.getTeamByName(teamRef);
          if (!teamRow) return res.status(404).json({ error: `Team "${teamRef}" not found` });
          teamIdFilter = teamRow.id;
        }

        const validStatuses = ['todo', 'doing', 'done'];
        const tasks = await this.db.tasks.list({
          status: status && validStatuses.includes(status) ? status as 'todo' | 'doing' | 'done' : undefined,
          owner: ownerIdFilter,
          teamId: teamIdFilter,
        });

        const results = [];
        for (const t of tasks) {
          results.push(await this.buildTaskResult(t, teamId));
        }
        res.json({ ok: true, tasks: results });
      } catch (err: any) {
        console.error('[Manager] Error in GET /tasks:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.get('/tasks/:ref', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const { task, error } = await this.resolveTaskRef(req.params.ref, teamId);
        if (!task) return res.status(404).json({ error: error || `Task "${req.params.ref}" not found` });
        res.json({ ok: true, task: await this.buildTaskResult(task, teamId) });
      } catch (err: any) {
        console.error('[Manager] Error in GET /tasks/:ref:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.post('/tasks/:ref/claim', async (req, res) => {
      try {
        let { id: teamId } = await this.getTeam(req);
        const { agent_id, from } = req.body || {};
        const callerRef = agent_id || from;

        if (!callerRef || typeof callerRef !== 'string') {
          return res.status(400).json({ error: 'Missing required field: agent_id (or from)' });
        }

        // Resolve the caller first so we can recover the caller's team when
        // the request omitted the X-Id-Team header. A deployed agent whose
        // CLAUDE.md follows `POST $MANAGER_URL/tasks/<name>/claim` with just
        // `{ agent_id }` would otherwise hit the manager's default team and
        // get "agent not found" even though the agent is registered in its
        // own team. The fallback only runs when the caller didn't specify a
        // team explicitly, so cross-team guards still hold for explicit
        // requests.
        let { agent, error } = await this.resolveSingleAgentForCommand(teamId, callerRef);
        if (!agent && !this.isTeamExplicit(req)) {
          const fallback = await this.resolveCallerAcrossTeams(callerRef);
          if (fallback) {
            agent = fallback.agent;
            teamId = fallback.teamId;
          }
        }
        if (!agent) return res.status(404).json({ error: error || `Agent "${callerRef}" not found` });

        const { task, error: taskError } = await this.resolveTaskRef(req.params.ref, teamId);
        if (!task) return res.status(404).json({ error: taskError || `Task "${req.params.ref}" not found` });

        // Guard against cross-team claim
        if (task.team_id && task.team_id !== teamId) {
          return res.status(404).json({ error: `Task "${req.params.ref}" not found` });
        }

        const now = Math.floor(Date.now() / 1000);
        const claimed = await this.db.tasks.claim(task.id, agent.id, now);
        if (!claimed) {
          return res.status(409).json({ error: `Cannot claim "${task.name}" — already owned or not in todo status` });
        }

        const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
        await emitTaskClaimed(this.db.events, {
          teamId,
          taskUuid: updated!.uuid,
          taskName: updated!.name,
          title: updated!.title,
          ownerAgentId: agent.id,
          occurredAt: Date.now(),
        });
        res.json({ ok: true, task: await this.buildTaskResult(updated!, teamId) });
      } catch (err: any) {
        console.error('[Manager] Error in POST /tasks/:ref/claim:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.post('/tasks/:ref/done', async (req, res) => {
      try {
        let { id: teamId } = await this.getTeam(req);
        const { agent_id, from } = req.body || {};
        const callerRef = agent_id || from;

        // Mirror the claim endpoint: when a caller is supplied without an
        // explicit team header, recover the caller's team so agents in
        // non-default teams can mark their own tasks done via the default
        // protocol (`POST $MANAGER_URL/tasks/<name>/done { agent_id }`).
        let callerAgent: AgentRow | undefined;
        if (callerRef && typeof callerRef === 'string') {
          const first = await this.resolveSingleAgentForCommand(teamId, callerRef);
          callerAgent = first.agent;
          if (!callerAgent && !this.isTeamExplicit(req)) {
            const fallback = await this.resolveCallerAcrossTeams(callerRef);
            if (fallback) {
              callerAgent = fallback.agent;
              teamId = fallback.teamId;
            }
          }
        }

        const { task, error: taskError } = await this.resolveTaskRef(req.params.ref, teamId);
        if (!task) return res.status(404).json({ error: taskError || `Task "${req.params.ref}" not found` });

        // Guard against cross-team done
        if (task.team_id && task.team_id !== teamId) {
          return res.status(404).json({ error: `Task "${req.params.ref}" not found` });
        }

        // If caller identifies themselves, enforce ownership
        if (callerAgent && task.owner !== callerAgent.id) {
          return res.status(403).json({ error: `Agent "${callerRef}" is not the owner of task "${task.name}"` });
        }

        const now = Math.floor(Date.now() / 1000);
        await this.db.tasks.updateFields(task.id, {
          status: 'done',
          completed_at: now,
          updated_at: now,
        });

        const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
        const completedAt = Date.now();
        await emitTaskCompleted(this.db.events, {
          teamId,
          taskUuid: updated!.uuid,
          taskName: updated!.name,
          title: updated!.title,
          ownerAgentId: updated!.owner ?? null,
          actorAgentId: callerAgent?.id ?? updated!.owner ?? null,
          occurredAt: completedAt,
        });
        // Auto-close any active/snoozed checkins linked to this task and
        // emit one checkin:closed event per row. Pure consumer of the
        // task:completed signal we just emitted above.
        await closeLinkedCheckinsForTerminalTask(this.db, {
          teamId,
          taskId: updated!.id,
          taskStatus: updated!.status,
          actorAgentId: callerAgent?.id ?? updated!.owner ?? null,
          occurredAt: completedAt,
        });
        res.json({ ok: true, task: await this.buildTaskResult(updated!, teamId) });
      } catch (err: any) {
        console.error('[Manager] Error in POST /tasks/:ref/done:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.delete('/tasks/:ref', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const { task, error } = await this.resolveTaskRef(req.params.ref, teamId);
        if (!task) return res.status(404).json({ error: error || `Task "${req.params.ref}" not found` });
        await this.db.tasks.delete(task.id);
        res.json({ ok: true, removed: task.name });
      } catch (err: any) {
        console.error('[Manager] Error in DELETE /tasks/:ref:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // ==================== WAKEUP SERVICE: GET /events ====================
    // Catch-up read over the team-scoped event log. Wire-format and
    // semantics are defined in output/wakeup-service-design.md
    // ("`GET /events`" section). Auth/team gating is the same as /remote
    // (handled by teamContextMiddleware → getTeam(req)). Producers and
    // SSE/webhook delivery land in separate slices.
    this.managementApp.get('/events', async (req, res) => {
      try {
        const { id: teamId, name: teamName } = await this.getTeam(req);

        // since: default 0, must be a non-negative integer.
        const sinceRaw = req.query.since;
        let since = 0;
        if (sinceRaw !== undefined) {
          const parsed = Number(sinceRaw);
          if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
            return res.status(400).json({
              error: 'invalid_since',
              message: '`since` must be a non-negative integer',
            });
          }
          since = parsed;
        }

        // limit: default 100, hard cap 1000, must be a positive integer.
        const limitRaw = req.query.limit;
        let limit = 100;
        if (limitRaw !== undefined) {
          const parsed = Number(limitRaw);
          if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
            return res.status(400).json({
              error: 'invalid_limit',
              message: '`limit` must be a positive integer',
            });
          }
          limit = Math.min(parsed, 1000);
        }

        // topics: optional CSV; alias expansion happens server-side so
        // callers can request `query:terminal` instead of the three
        // concrete topics it covers.
        let topics: string[] | undefined;
        const topicsRaw = req.query.topics;
        if (typeof topicsRaw === 'string' && topicsRaw.length > 0) {
          const requested = topicsRaw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (requested.length > 0) {
            topics = expandTopicAliases(requested);
          }
        }

        const rows = await this.db.events.query({
          teamId,
          sinceSeq: since,
          topics,
          limit,
        });
        const earliestAvailableSeq = await this.db.events.earliestSeq(teamId);

        const events = rows.map((row) => ({
          seq: row.seq,
          team: teamName,
          topic: row.topic,
          occurred_at: row.occurred_at,
          actor: row.actor_agent_id,
          subject:
            row.subject_kind === null && row.subject_id === null
              ? null
              : { kind: row.subject_kind, id: row.subject_id },
          data: row.data,
        }));

        const nextSeq = events.length > 0
          ? events[events.length - 1].seq
          : since;

        // replay_truncated: the consumer's cursor predates retained
        // history. `since` is an exclusive cursor, so the consumer next
        // expects `since + 1`; truncation is true only when that next
        // expected seq is strictly less than the earliest retained seq.
        // An empty log (earliestAvailableSeq === null) is never truncated.
        const replayTruncated =
          earliestAvailableSeq !== null && since + 1 < earliestAvailableSeq;

        res.json({
          events,
          next_seq: nextSeq,
          replay_truncated: replayTruncated,
          earliest_available_seq: earliestAvailableSeq,
        });
      } catch (err: any) {
        console.error('[Manager] Error in GET /events:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // ==================== CHECKINS API ====================
    // Wire-format and semantics: output/checkin-primitive-design.md.
    // Auth/team gating matches /remote and /events: teamContextMiddleware
    // resolves the team from X-Id-Team and the principal (admin/agent/anon).
    // Event emission (checkin:created/closed/snoozed) is owned by the
    // separate `checkin-events` slice and is not wired here.

    this.managementApp.post('/checkins', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const body = req.body || {};

        // owner: optional. When provided, must resolve to an agent in this team.
        let ownerAgentId: string | null = null;
        let ownerName: string | null = null;
        if (body.owner !== undefined && body.owner !== null) {
          if (typeof body.owner !== 'string') {
            return res.status(400).json({ error: 'invalid_owner' });
          }
          const { agent, error } = await this.resolveSingleAgentForCommand(teamId, body.owner);
          if (!agent) return res.status(404).json({ error: error || `Agent "${body.owner}" not found` });
          ownerAgentId = agent.id;
          ownerName = (agent.metadata as any)?.alias || agent.name;
        }

        // linked_task: optional but enforces same-team via resolveTaskRef.
        // Reject creation when the linked task is already in a terminal status
        // ('done' is the only terminal status today). Without this guard the
        // row would be created with a future next_fire_at and then immediately
        // auto-closed by closeLinkedCheckinsForTerminalTask on the next task
        // event, leaving a confusing closed-with-no-fires audit trail.
        let linkedTaskId: string | null = null;
        let linkedTaskRow: TaskRow | undefined;
        if (body.linked_task !== undefined && body.linked_task !== null) {
          if (typeof body.linked_task !== 'string') {
            return res.status(400).json({ error: 'invalid_linked_task' });
          }
          const { task, error } = await this.resolveTaskRef(body.linked_task, teamId);
          if (!task) return res.status(404).json({ error: error || `Task "${body.linked_task}" not found` });
          if (task.status === 'done') {
            return res.status(409).json({ error: 'linked_task_terminal', task_status: task.status });
          }
          linkedTaskId = task.id;
          linkedTaskRow = task;
        }

        // interval: default 15m
        let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
        if (body.interval !== undefined) {
          const parsed = parseDurationSeconds(body.interval);
          if (parsed === null) {
            return res.status(400).json({ error: 'invalid_interval' });
          }
          intervalSeconds = parsed;
        }

        // priority: default normal
        let priority: 'low' | 'normal' | 'high' = 'normal';
        if (body.priority !== undefined) {
          if (!isValidPriority(body.priority)) {
            return res.status(400).json({ error: 'invalid_priority' });
          }
          priority = body.priority;
        }

        // close_when: default { task_status: ['done'] }
        let closeWhen = DEFAULT_CLOSE_WHEN;
        if (body.close_when !== undefined) {
          if (!body.close_when || typeof body.close_when !== 'object' || Array.isArray(body.close_when)) {
            return res.status(400).json({ error: 'invalid_close_when' });
          }
          closeWhen = body.close_when as Record<string, unknown>;
        }

        // max_iterations: optional positive int
        let maxIterations: number | null = null;
        if (body.max_iterations !== undefined && body.max_iterations !== null) {
          const n = Number(body.max_iterations);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
            return res.status(400).json({ error: 'invalid_max_iterations' });
          }
          maxIterations = n;
        }

        // ttl: optional duration → ttl_expires_at = now + ttl
        let ttlExpiresAt: number | null = null;
        const nowMs = Date.now();
        if (body.ttl !== undefined && body.ttl !== null) {
          const ttl = parseDurationSeconds(body.ttl);
          if (ttl === null) {
            return res.status(400).json({ error: 'invalid_ttl' });
          }
          ttlExpiresAt = nowMs + ttl * 1000;
        }

        // snooze_until: explicit unix-ms cursor. Mutually exclusive with the
        // computed initial next_fire_at.
        let snoozeUntil: number | null = null;
        let initialStatus: 'active' | 'snoozed' = 'active';
        let nextFireAt: number | null = nowMs + intervalSeconds * 1000;
        if (body.snooze_until !== undefined && body.snooze_until !== null) {
          const n = Number(body.snooze_until);
          if (!Number.isFinite(n) || n <= 0) {
            return res.status(400).json({ error: 'invalid_snooze_until' });
          }
          snoozeUntil = n;
          nextFireAt = n;
          initialStatus = 'snoozed';
        }

        const note = clampNote(body.note);

        const row: CheckinRow = {
          id: generateCheckinId(nowMs),
          team_id: teamId,
          owner_agent_id: ownerAgentId,
          created_by_agent_id: ownerAgentId,
          linked_task_id: linkedTaskId,
          interval_seconds: intervalSeconds,
          priority,
          status: initialStatus,
          close_when: closeWhen,
          max_iterations: maxIterations,
          iteration_count: 0,
          next_fire_at: nextFireAt,
          snooze_until: snoozeUntil,
          ttl_expires_at: ttlExpiresAt,
          last_fire_at: null,
          last_event_seq: null,
          note,
          created_at: nowMs,
          updated_at: nowMs,
          closed_at: null,
          closed_reason: null,
        };

        try {
          await this.db.checkins.create(row);
        } catch (err: any) {
          if (typeof err?.message === 'string' && err.message.includes('different team')) {
            return res.status(409).json({ error: 'cross_team_linked_task' });
          }
          throw err;
        }

        const linkedTask = linkedTaskRow
          ? await this.buildTaskResult(linkedTaskRow, teamId)
          : null;
        res.status(201).json({
          ok: true,
          checkin: buildCheckinResponse(row, { ownerName, linkedTask }),
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /checkins:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.get('/checkins', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const q = req.query as Record<string, string | undefined>;

        let ownerAgentId: string | undefined;
        if (q.owner) {
          const { agent, error } = await this.resolveSingleAgentForCommand(teamId, q.owner);
          if (!agent) return res.status(404).json({ error: error || `Agent "${q.owner}" not found` });
          ownerAgentId = agent.id;
        }

        let linkedTaskId: string | undefined;
        if (q.linked_task) {
          const { task, error } = await this.resolveTaskRef(q.linked_task, teamId);
          if (!task) return res.status(404).json({ error: error || `Task "${q.linked_task}" not found` });
          linkedTaskId = task.id;
        }

        const statusFilter = parseStatusFilter(q.status);
        if (statusFilter === null) {
          return res.status(400).json({ error: 'invalid_status' });
        }

        let dueBefore: number | undefined;
        if (q.due_before !== undefined) {
          const n = Number(q.due_before);
          if (!Number.isFinite(n) || n < 0) {
            return res.status(400).json({ error: 'invalid_due_before' });
          }
          dueBefore = n;
        }

        let limit: number | undefined;
        if (q.limit !== undefined) {
          const n = Number(q.limit);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
            return res.status(400).json({ error: 'invalid_limit' });
          }
          limit = n;
        }

        const rows = await this.db.checkins.list({
          teamId,
          owner: ownerAgentId,
          linkedTaskId,
          status: statusFilter.length > 0 ? statusFilter : undefined,
          dueBefore,
          limit,
        });

        // Resolve owner names so GET returns the same `owner` shape as POST.
        // Cache lookups across rows since the same owner often recurs.
        const ownerNameCache = new Map<string, string | null>();
        const resolveOwnerName = async (agentId: string | null): Promise<string | null> => {
          if (!agentId) return null;
          if (ownerNameCache.has(agentId)) return ownerNameCache.get(agentId)!;
          const agent = await this.db.agents.getById(agentId).catch(() => null);
          const name = agent ? ((agent.metadata as any)?.alias || agent.name) : null;
          ownerNameCache.set(agentId, name);
          return name;
        };
        const checkins = await Promise.all(
          rows.map(async (row) => buildCheckinResponse(row, {
            ownerName: await resolveOwnerName(row.owner_agent_id),
          })),
        );
        res.json({ ok: true, checkins });
      } catch (err: any) {
        console.error('[Manager] Error in GET /checkins:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.delete('/checkins/:id', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const principal = (req as any).ctx?.principal || 'anon';
        if (principal !== 'admin') {
          return res.status(403).json({ error: 'admin_required' });
        }
        const removed = await this.db.checkins.delete(req.params.id, teamId);
        if (!removed) return res.status(404).json({ error: 'checkin_not_found' });
        res.json({ ok: true, removed: req.params.id });
      } catch (err: any) {
        console.error('[Manager] Error in DELETE /checkins/:id:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.post('/checkins/:id/close', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const reason =
          typeof req.body?.reason === 'string' && req.body.reason.length > 0
            ? req.body.reason
            : 'manual';
        const closedAt = Date.now();

        const transitioned = await this.db.checkins.close(req.params.id, teamId, closedAt, reason);
        const row = await this.db.checkins.get(req.params.id, teamId);
        if (!row) return res.status(404).json({ error: 'checkin_not_found' });

        const ownerName = await this.resolveAgentNameById(row.owner_agent_id);
        res.json({
          ok: true,
          alreadyClosed: !transitioned,
          checkin: buildCheckinResponse(row, { ownerName }),
        });
      } catch (err: any) {
        console.error('[Manager] Error in POST /checkins/:id/close:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    this.managementApp.post('/checkins/:id/snooze', async (req, res) => {
      try {
        const { id: teamId } = await this.getTeam(req);
        const body = req.body || {};
        if (body.duration === undefined || body.duration === null) {
          return res.status(400).json({ error: 'missing_duration' });
        }
        const seconds = parseDurationSeconds(body.duration);
        if (seconds === null) {
          return res.status(400).json({ error: 'invalid_duration' });
        }

        const existing = await this.db.checkins.get(req.params.id, teamId);
        if (!existing) return res.status(404).json({ error: 'checkin_not_found' });
        if (existing.status === 'closed' || existing.status === 'expired') {
          return res.status(409).json({ error: 'checkin_terminal' });
        }

        const nowMs = Date.now();
        const snoozeUntil = nowMs + seconds * 1000;
        await this.db.checkins.updateFields(req.params.id, teamId, {
          status: 'snoozed',
          snooze_until: snoozeUntil,
          next_fire_at: snoozeUntil,
          updated_at: nowMs,
        });
        const row = await this.db.checkins.get(req.params.id, teamId);
        const ownerName = await this.resolveAgentNameById(row!.owner_agent_id);
        res.json({ ok: true, checkin: buildCheckinResponse(row!, { ownerName }) });
      } catch (err: any) {
        console.error('[Manager] Error in POST /checkins/:id/snooze:', err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

  }

  /**
   * Resolve an agent's display name (alias or `agents.name`) from its id, or
   * `null` if the row is missing. Swallows errors so a transient lookup
   * failure does not break the response envelope.
   */
  private async resolveAgentNameById(agentId: string | null): Promise<string | null> {
    if (!agentId) return null;
    const agent = await this.db.agents.getById(agentId).catch(() => null);
    if (!agent) return null;
    return (agent.metadata as any)?.alias || agent.name;
  }

  /**
   * Probe a list of agents by enqueueing a tiny `/talk` query and then
   * waiting for that query to reach a terminal state on `/query/:id`.
   * This is intentionally end-to-end: a 202 Accepted from `/talk` alone
   * is not enough because the harness can still fail later (for example,
   * when the underlying CLI returns an auth error on every dispatch).
   */
  private async probeAgentsViaTalk(
    teamName: string,
    agents: AgentRow[],
  ): Promise<{
    ok: true;
    result: {
      team: string;
      probed: number;
      passed: number;
      failed: number;
      results: Array<
        { name: string; status: 'ok'; duration_ms: number }
        | { name: string; status: 'failed'; error: string; duration_ms: number }
      >;
    };
  }> {
    const PER_AGENT_TIMEOUT_MS = 30_000;
    const CONCURRENCY = 8;
    const POLL_INTERVAL_MS = 200;

    type ProbeResult =
      | { name: string; status: 'ok'; duration_ms: number }
      | { name: string; status: 'failed'; error: string; duration_ms: number };

    const toErrorString = (status: number, bodyText: string): string => (
      bodyText ? `${status}: ${bodyText}` : `${status}`
    );
    const parseJson = (raw: string): any | null => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    const probeOne = async (agent: AgentRow): Promise<ProbeResult> => {
      const start = Date.now();
      const base = (agent.endpoint || (agent.port ? `http://localhost:${agent.port}` : '')).replace(/\/+$/, '');
      const displayName = (agent.metadata as any)?.alias || agent.name;
      if (!base) {
        return { name: displayName, status: 'failed', error: 'no_endpoint', duration_ms: Date.now() - start };
      }

      const deadline = start + PER_AGENT_TIMEOUT_MS;
      const remainingMs = () => Math.max(0, deadline - Date.now());
      const talkUrl = `${base}/talk`;

      try {
        const talkResp = await fetch(talkUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'reply with OK', from: 'probe' }),
          signal: AbortSignal.timeout(Math.max(1, remainingMs())),
        });

        // Parse the full body so /query/:id responses (which can exceed 200
        // chars once result.messages[] / sessionId / timestamps are included)
        // round-trip cleanly. Only truncate when surfacing the body in an
        // error string.
        const talkText = await talkResp.text().catch(() => '');
        const talkBody = parseJson(talkText);

        if (!talkResp.ok) {
          let bodyText = '';
          if (talkBody && typeof talkBody === 'object' && typeof talkBody.error === 'string') {
            bodyText = talkBody.error;
          } else {
            bodyText = talkText.slice(0, 200);
          }
          return {
            name: displayName,
            status: 'failed',
            error: toErrorString(talkResp.status, bodyText),
            duration_ms: Date.now() - start,
          };
        }

        const queryId = talkBody?.query_id || talkBody?.queryId;
        if (!queryId) {
          const bodyText = typeof talkBody?.message === 'string'
            ? talkBody.message
            : talkText.slice(0, 200);
          if (bodyText) {
            return { name: displayName, status: 'ok', duration_ms: Date.now() - start };
          }
          return {
            name: displayName,
            status: 'failed',
            error: 'missing query_id from /talk response',
            duration_ms: Date.now() - start,
          };
        }

        const queryUrl = `${base}/query/${encodeURIComponent(String(queryId))}`;
        while (remainingMs() > 0) {
          const queryResp = await fetch(queryUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(Math.max(1, Math.min(remainingMs(), 1_000))),
          });

          const queryText = await queryResp.text().catch(() => '');
          const queryBody = parseJson(queryText);

          if (!queryResp.ok) {
            const bodyText = typeof queryBody?.error === 'string'
              ? queryBody.error
              : queryText.slice(0, 200);
            return {
              name: displayName,
              status: 'failed',
              error: toErrorString(queryResp.status, bodyText),
              duration_ms: Date.now() - start,
            };
          }

          const queryStatus = queryBody?.status;
          if (queryStatus === 'completed') {
            return { name: displayName, status: 'ok', duration_ms: Date.now() - start };
          }
          if (queryStatus === 'failed') {
            const error = typeof queryBody?.error === 'string' && queryBody.error.trim()
              ? queryBody.error
              : 'query failed';
            return { name: displayName, status: 'failed', error, duration_ms: Date.now() - start };
          }

          await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remainingMs())));
        }

        return { name: displayName, status: 'failed', error: 'timeout', duration_ms: Date.now() - start };
      } catch (err: any) {
        const duration_ms = Date.now() - start;
        const isTimeout = err?.name === 'AbortError' || err?.name === 'TimeoutError';
        const error = isTimeout ? 'timeout' : (err?.message ? String(err.message) : String(err));
        return { name: displayName, status: 'failed', error, duration_ms };
      }
    };

    const results: ProbeResult[] = new Array(agents.length);
    let next = 0;
    const workerCount = Math.min(CONCURRENCY, agents.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= agents.length) return;
        results[idx] = await probeOne(agents[idx]);
      }
    });
    await Promise.all(workers);

    const passed = results.filter((r) => r.status === 'ok').length;
    return {
      ok: true,
      result: {
        team: teamName,
        probed: results.length,
        passed,
        failed: results.length - passed,
        results,
      },
    };
  }

  private async resolveSingleAgentForCommand(teamId: string, agentName: string): Promise<{ agent?: AgentRow; error?: string }> {
    const matches = await this.dbResolveAgents(teamId, agentName);
    if (matches.length === 0) {
      return { error: `Agent "${agentName}" not found` };
    }
    if (matches.length > 1) {
      return { error: `Multiple agents match "${agentName}". Be more specific.` };
    }
    return { agent: matches[0] };
  }

  private async buildTaskResult(task: TaskRow, teamId: string): Promise<Record<string, unknown>> {
    let ownerName: string | null = null;
    if (task.owner) {
      const ownerAgent = await this.db.agents.getById(task.owner);
      if (ownerAgent) {
        ownerName = (ownerAgent.metadata as any)?.alias || ownerAgent.name;
      }
    }

    let teamName: string | null = null;
    if (task.team_id) {
      const teamRow = await this.db.teams.getTeam(task.team_id);
      if (teamRow) teamName = teamRow.name;
    }

    const links = await this.db.tasks.listEventLinksForTask(task.id);
    const shortId = task.uuid ? `#${task.uuid.replace(/-/g, '').slice(0, 8)}` : null;

    return {
      name: task.name,
      uuid: task.uuid,
      shortId,
      title: task.title,
      description: task.description,
      status: task.status,
      ownerName,
      teamName,
      linkedEvents: links.map(l => l.schedule_id),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      completedAt: task.completed_at,
    };
  }

  /**
   * Resolve a task reference scoped to a team. Accepts either:
   *   - the kebab-case `name` slug (existing behavior), or
   *   - a short-uuid handle `#xxxxxxxx` (8+ hex chars after the `#`).
   *
   * Short refs match on the dash-stripped uuid prefix. If multiple rows
   * share the prefix (within the team), returns an `error` asking the caller
   * to widen it.
   *
   * @param ref   The task reference string.
   * @param teamId  The team scope. Required for name-based resolution.
   */
  private async resolveTaskRef(ref: string, teamId?: string): Promise<{ task?: TaskRow; error?: string }> {
    if (!ref || typeof ref !== 'string') {
      return { error: 'Task reference is required' };
    }
    if (ref.startsWith('#')) {
      const raw = ref.slice(1).toLowerCase();
      if (!/^[0-9a-f]+$/.test(raw) || raw.length < 4) {
        return { error: `Invalid short id "${ref}". Expected #<hex prefix>` };
      }
      // uuids are stored with dashes; the short form strips dashes for
      // display, so match on either form by trying the first 8 hex chars
      // against the leading hex chunk (uuid v4: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).
      const matches = await this.db.tasks.getByUuidPrefix(raw.slice(0, 8));
      const filtered = matches.filter(t => {
        if (!(t.uuid || '').replace(/-/g, '').toLowerCase().startsWith(raw)) return false;
        // When teamId is provided, scope to that team
        if (teamId && t.team_id !== teamId) return false;
        return true;
      });
      if (filtered.length === 0) return { error: `Task ${ref} not found` };
      if (filtered.length > 1) {
        const widened = filtered
          .map(t => `#${(t.uuid || '').replace(/-/g, '').slice(0, raw.length + 2)} (${t.name})`)
          .join(', ');
        return { error: `Short id ${ref} is ambiguous (matches ${filtered.length}): ${widened}. Widen the prefix.` };
      }
      return { task: filtered[0] };
    }
    // Name-based resolution: scope to the team when teamId is provided
    if (teamId) {
      const task = await this.db.tasks.getByNameForTeam(ref, teamId);
      if (!task) return { error: `Task "${ref}" not found` };
      return { task };
    }
    const task = await this.db.tasks.getByName(ref);
    if (!task) return { error: `Task "${ref}" not found` };
    return { task };
  }

  private async listTeamSchedules(teamId: string): Promise<Array<{ definition: ScheduleDefinitionRow; targets: AgentRow[] }>> {
    const teamAgents = await this.dbListAgents(teamId, true);
    const agentsById = new Map(teamAgents.map((agent) => [agent.id, agent]));
    const definitions = await this.db.schedules.listAllDefinitions();
    const schedules: Array<{ definition: ScheduleDefinitionRow; targets: AgentRow[] }> = [];

    for (const definition of definitions) {
      const targetIds = await this.db.schedules.listTargets(definition.id);
      const targets = targetIds
        .map((targetId) => agentsById.get(targetId))
        .filter((target): target is AgentRow => Boolean(target));

      if (targets.length > 0) {
        schedules.push({ definition, targets });
      }
    }

    return schedules;
  }

  private async getTeamScheduleById(teamId: string, scheduleId: string): Promise<{ definition: ScheduleDefinitionRow; targets: AgentRow[] } | null> {
    const definition = await this.db.schedules.getDefinition(scheduleId);
    if (!definition) return null;

    const teamAgents = await this.dbListAgents(teamId, true);
    const agentsById = new Map(teamAgents.map((agent) => [agent.id, agent]));
    const targets = (await this.db.schedules.listTargets(scheduleId))
      .map((targetId) => agentsById.get(targetId))
      .filter((target): target is AgentRow => Boolean(target));

    if (targets.length === 0) return null;
    return { definition, targets };
  }

  private async deleteEmptyTeamByName(
    name: string,
  ): Promise<{ ok: true; result: { success: true; name: string; message: string } } | { ok: false; status: number; error: string }> {
    if (name === 'default') {
      return {
        ok: false,
        status: 400,
        error: 'Cannot delete the "default" team — it is the fallback for all unscoped requests',
      };
    }

    const team = await this.db.teams.getTeamByName(name);
    if (!team) {
      return { ok: false, status: 404, error: `Team "${name}" not found` };
    }

    // NB: no `::text` cast — that's Postgres-only and breaks on SQLite.
    // COUNT(*) returns a number on both backends; parseInt tolerates both.
    const countResult = await this.db.adapter.query<{ count: string | number }>(
      'SELECT COUNT(*) as count FROM agents WHERE team_id = $1 AND deleted_at IS NULL',
      [team.id],
    );
    const agentCount = parseInt(String(countResult.rows[0]?.count ?? '0'));

    if (agentCount > 0) {
      return {
        ok: false,
        status: 400,
        error: `Team "${name}" still has ${agentCount} agent(s). Run /delete --team ${name} first to remove agents, then /team delete ${name} to remove the team.`,
      };
    }

    await this.db.teams.deleteTeam(team.id);
    return {
      ok: true,
      result: { success: true, name, message: `Team "${name}" deleted` },
    };
  }

  /**
   * Execute a CLI-style command and return the result
   */
  private async executeRemoteCommand(
    command: string,
    teamId: string,
    teamName: string,
    callerFrom?: string,
    /**
     * §7: `/import --team <name>` forces the target team, beating the file's
     * own `team:` key. Threaded through rather than duplicated so import
     * REUSES the deploy creation path instead of growing a second one.
     */
    teamOverride?: string,
  ): Promise<{ ok: boolean; result?: any; error?: string; httpStatus?: number; message?: string }> {
    // Remove leading slash if present
    const cmd = command.startsWith('/') ? command.slice(1) : command;
    const parts = tokenizeCommand(cmd);
    const action = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (action) {
      case 'agents': {
        const sub = args[0]?.toLowerCase();
        if (sub === 'probe') {
          // Probe every running agent's /talk dispatch path. Non-running
          // rows are skipped (an offline/stopped agent is expected to
          // fail; including it would skew passed/failed counts toward
          // noise the operator already knows about). For a deliberately
          // selected single agent, see `/agent <name> probe` which does
          // not skip.
          const all = await this.dbListAgents(teamId);
          const running = all.filter((a) => a.status === 'running');
          return this.probeAgentsViaTalk(teamName, running);
        }
        if (sub === 'rebuild') {
          if (!args.includes('--confirm')) {
            return { ok: false, error: 'Usage: /agents rebuild --confirm' };
          }

          const agents = await this.dbListAgents(teamId);
          const results: Array<{ name: string; status: 'rebuilt' | 'skipped' | 'failed'; reason: string }> = [];

          for (const agent of agents) {
            if (isRemoteEndpointRuntime(agent.runtime)) {
              results.push({ name: agent.name, status: 'skipped', reason: 'lifecycle_not_supported_for_remote' });
              continue;
            }
            if (agent.type !== 'claude') {
              results.push({ name: agent.name, status: 'skipped', reason: 'only_claude_agents_can_be_rebuilt' });
              continue;
            }

            try {
              const spawnResult = await this.rebuildLocalClaudeAgent(teamId, teamName, agent);
              if (spawnResult.success) {
                results.push({ name: agent.name, status: 'rebuilt', reason: 'rebuilt' });
              } else {
                results.push({ name: agent.name, status: 'failed', reason: spawnResult.error || 'spawn_failed' });
              }
            } catch (err: any) {
              results.push({ name: agent.name, status: 'failed', reason: err?.message || String(err) });
            }
          }

          return {
            ok: true,
            result: {
              action: 'agents-rebuild',
              rebuilt: results.filter(r => r.status === 'rebuilt').length,
              skipped: results.filter(r => r.status === 'skipped').length,
              failed: results.filter(r => r.status === 'failed').length,
              agents: results
            }
          };
        }
        const agents = await this.dbListAgents(teamId);
        return {
          ok: true,
          result: {
            agents: agents.map(a => ({
              name: a.name,
              id: a.id,
              type: a.type,
              // `type` is the agent KIND (claude/virtual/interactive), not the
              // harness — a Codex agent is still type 'claude'. Clients need
              // `runtime` to show what actually executes the agent, and
              // `effort` to show the reasoning level it was spawned with.
              runtime: a.runtime,
              ...(a.metadata?.effort !== undefined && { effort: a.metadata.effort }),
              status: a.status,
              model: a.model,
              port: a.port,
              url: a.endpoint || (a.port ? `http://localhost:${a.port}` : null)
            }))
          }
        };
      }

      case 'status': {
        const agents = await this.dbListAgents(teamId);
        const running = agents.filter(a => a.status === 'running').length;
        const offline = agents.filter(a => a.status === 'offline').length;
        const agentHealth = agents.map(a => {
          const h = this.getHealthForAgent(a);
          const alias = (a.metadata as any)?.alias || normalizeAlias(a.name);
          return { name: alias, status: a.status, health: h.health, lastHealthCheck: h.lastHealthCheck };
        });
        return {
          ok: true,
          result: {
            team: teamName,
            totalAgents: agents.length,
            runningAgents: running,
            offlineAgents: offline,
            agents: agentHealth,
            status: 'ok'
          }
        };
      }

      case 'schedule': {
        if (!this.schedulerService) {
          return { ok: false, error: 'Scheduler service is not running' };
        }

        const subCmd = args[0]?.toLowerCase() || 'list';

        if (subCmd === 'list') {
          const schedules = await this.listTeamSchedules(teamId);
          return {
            ok: true,
            result: {
              schedules: schedules.map(({ definition, targets }) => ({
                id: definition.id,
                title: definition.title,
                kind: definition.kind,
                active: definition.active,
                deliveryMode: definition.delivery_mode,
                sourceType: definition.source_type,
                targets: targets.map((target) => target.name),
                intervalSeconds: definition.interval_seconds,
                timezone: definition.timezone,
                localTimeSeconds: definition.local_time_seconds,
                localDate: definition.local_date,
                daysOfWeek: definition.days_of_week,
                message: definition.message,
                createdAt: definition.created_at,
              })),
            },
          };
        }

        if (subCmd === 'show') {
          const scheduleId = args[1];
          if (!scheduleId) {
            return { ok: false, error: 'Usage: /schedule show <id>' };
          }

          const schedule = await this.getTeamScheduleById(teamId, scheduleId);
          if (!schedule) {
            return { ok: false, error: `Schedule "${scheduleId}" not found` };
          }

          const runs = await this.db.schedules.listRuns(scheduleId, 10);
          return {
            ok: true,
            result: {
              schedule: {
                ...schedule.definition,
                targets: schedule.targets.map((target) => ({
                  id: target.id,
                  name: target.name,
                  status: target.status,
                })),
                recentRuns: runs,
              },
            },
          };
        }

        if (subCmd === 'pause' || subCmd === 'resume' || subCmd === 'remove') {
          const scheduleId = args[1];
          if (!scheduleId) {
            return { ok: false, error: `Usage: /schedule ${subCmd} <id>` };
          }

          const schedule = await this.getTeamScheduleById(teamId, scheduleId);
          if (!schedule) {
            return { ok: false, error: `Schedule "${scheduleId}" not found` };
          }

          if (subCmd === 'remove') {
            await this.db.schedules.deleteDefinition(scheduleId);
            this.scheduleAutoExport(teamId); // §5.4 — schedule mutation
            return { ok: true, result: { removed: scheduleId } };
          }

          const active = subCmd === 'resume';
          await this.db.schedules.setActive(scheduleId, active);
          this.scheduleAutoExport(teamId); // §5.4 — schedule mutation
          return { ok: true, result: { id: scheduleId, active } };
        }

        if (subCmd === 'add') {
          const kind = args[1]?.toLowerCase();
          if (kind !== 'heartbeat' && kind !== 'calendar') {
            return { ok: false, error: 'Usage: /schedule add <heartbeat|calendar> ...' };
          }

          const rawArgs = args.slice(2);
          let delivery: ScheduleDeliveryMode = kind === 'heartbeat' ? 'internal' : 'talk';
          let timezone: string | undefined;
          let sender: string | undefined;
          const positionals: string[] = [];

          for (let i = 0; i < rawArgs.length; i++) {
            const token = rawArgs[i];
            if (token === '--delivery') {
              const value = rawArgs[i + 1];
              if (value !== 'talk' && value !== 'internal') {
                return { ok: false, error: 'Invalid --delivery value. Use talk or internal.' };
              }
              delivery = value;
              i++;
              continue;
            }
            if (token === '--timezone') {
              timezone = rawArgs[i + 1];
              if (!timezone) {
                return { ok: false, error: 'Missing value for --timezone' };
              }
              i++;
              continue;
            }
            if (token === '--sender') {
              sender = rawArgs[i + 1];
              if (!sender) {
                return { ok: false, error: 'Missing value for --sender' };
              }
              i++;
              continue;
            }
            positionals.push(token);
          }

          if (kind === 'heartbeat') {
            const [agentName, secondsRaw, ...messageParts] = positionals;
            const message = messageParts.join(' ').trim();

            if (!agentName || !secondsRaw || !message) {
              return {
                ok: false,
                error: 'Usage: /schedule add heartbeat <agent> <seconds> <message> [--delivery internal|talk]',
              };
            }

            const { agent, error } = await this.resolveSingleAgentForCommand(teamId, agentName);
            if (!agent) return { ok: false, error };

            const seconds = Number(secondsRaw);
            if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
              return { ok: false, error: `Invalid interval: ${secondsRaw}` };
            }
            try {
              validateIntervalSeconds(seconds);
            } catch (err: any) {
              return { ok: false, error: err.message };
            }

            const nowSec = Math.floor(Date.now() / 1000);
            const scheduleId = `sch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            const definition: ScheduleDefinitionRow = {
              id: scheduleId,
              kind: 'heartbeat',
              title: `Interval: ${agent.name}`,
              description: null,
              active: true,
              message,
              delivery_mode: delivery,
              timezone: null,
              catch_up_policy: 'fire_once',
              dedupe_window_seconds: 90,
              interval_seconds: seconds,
              anchor_at: nowSec,
              max_runs: null,
              expires_at: null,
              local_time_seconds: null,
              local_date: null,
              days_of_week: null,
              source_type: 'cli',
              source_key: `cli:${teamId}:${scheduleId}`,
              sender: sender ?? 'schedule',
              created_at: nowSec,
              updated_at: nowSec,
            };

            await this.schedulerService.seedSchedule(definition, [agent.id]);
            this.scheduleAutoExport(teamId); // §5.4 — schedule mutation
            return {
              ok: true,
              result: {
                schedule: {
                  id: definition.id,
                  kind: definition.kind,
                  target: agent.name,
                  intervalSeconds: seconds,
                  deliveryMode: delivery,
                },
              },
            };
          }

          const [agentName, time, recurrence, ...messageParts] = positionals;
          const message = messageParts.join(' ').trim();
          if (!agentName || !time || !recurrence || !message) {
            return {
              ok: false,
              error: 'Usage: /schedule add calendar <agent> <time> <days|date> <message> [--timezone TZ] [--delivery internal|talk]',
            };
          }

          const { agent, error } = await this.resolveSingleAgentForCommand(teamId, agentName);
          if (!agent) return { ok: false, error };

          const scheduleKey = `cli:${teamId}:${Date.now()}:${Math.random().toString(36).substring(2, 9)}`;
          const isDate = /^\d{4}-\d{2}-\d{2}$/.test(recurrence);
          const spec: CalendarSpec = {
            title: `Calendar: ${agent.name}`,
            time,
            timezone,
            agents: [agent.name],
            message,
            delivery,
            ...(isDate ? { date: recurrence } : { days: recurrence.split(',').map((day) => day.trim()).filter(Boolean) }),
          };

          let definition: ScheduleDefinitionRow;
          try {
            ({ definition } = calendarToSchedule(spec, scheduleKey, [agent.id]));
          } catch (err: any) {
            return { ok: false, error: err.message };
          }
          definition.source_type = 'cli';
          definition.source_key = scheduleKey;
          definition.sender = sender ?? 'schedule';
          await this.schedulerService.seedSchedule(definition, [agent.id]);
          this.scheduleAutoExport(teamId); // §5.4 — schedule mutation

          return {
            ok: true,
            result: {
              schedule: {
                id: definition.id,
                kind: definition.kind,
                target: agent.name,
                time,
                recurrence,
                timezone: definition.timezone,
                deliveryMode: delivery,
              },
            },
          };
        }

        return {
          ok: false,
          error: 'Usage: /schedule <list|show|add|pause|resume|remove> ...'
        };
      }

      case 'heartbeat': {
        // /heartbeat <agent> - show heartbeat status for specific agent
        // /heartbeat enable <agent> - enable heartbeat for agent
        // /heartbeat disable <agent> - disable heartbeat for agent
        // /heartbeat fire <agent> [--force] - operator-fire a one-off beat
        const subCmd = args[0];

        // /heartbeat fire <agent> [--force]
        //
        // Operator-triggered one-off beat. Does NOT advance scheduler
        // cadence or count against max_runs (slice 1 of
        // ship-heartbeat-fire). With --force, synthesize a generic
        // heartbeat schedule for agents that have no config — useful
        // for testing HEARTBEAT.md wake behavior on a fresh agent.
        if (subCmd === 'fire') {
          const agentName = args[1];
          const force = args.includes('--force');
          if (!agentName) {
            return { ok: false, error: 'Usage: /heartbeat fire <agent> [--force]' };
          }
          if (!this.schedulerService) {
            return { ok: false, error: 'Scheduler service is not running' };
          }
          const matches = await this.dbResolveAgents(teamId, agentName);
          if (matches.length === 0) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          if (matches.length > 1) {
            return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
          }
          const agent = matches[0];
          if (!agent.endpoint && (!agent.port || agent.port === 0)) {
            return { ok: false, error: `Agent "${agent.name}" has no endpoint to fire against` };
          }

          // Resolve the agent's heartbeat schedule. When --force is set
          // and no real schedule exists, synthesize a generic in-memory
          // definition (never persisted).
          const schedules = await this.db.schedules.listSchedulesForAgent(agent.id);
          let hbSchedule = schedules.find(s => s.source_key === `heartbeat:${agent.id}`);
          if (!hbSchedule) {
            if (!force) {
              // `listSchedulesForAgent` is active-only, so "not found" now covers two
              // cases: no schedule at all, or one that is merely PAUSED by
              // `/heartbeat disable`. Saying "has no heartbeat schedule" for a paused
              // one would be untrue, so name the actual state. Behaviour is unchanged
              // — both still refuse without --force.
              const paused = await this.db.schedules.getDefinition(heartbeatScheduleId(agent.id));
              return {
                ok: false,
                error: paused
                  ? `Agent "${agent.name}" has a disabled heartbeat schedule. Re-enable it with /heartbeat enable ${agent.name}, or re-run with --force to fire a synthesized generic beat.`
                  : `Agent "${agent.name}" has no heartbeat schedule. Re-run with --force to fire a synthesized generic beat.`,
              };
            }
            hbSchedule = synthesizeForceHeartbeat(agent.id, agent.name);
          }

          const target: DispatchTarget = {
            id: agent.id,
            name: agent.name,
            endpoint: agent.endpoint || `http://localhost:${agent.port}`,
            talkPath: '/talk',
            schedulePath: '/schedule',
            status: agent.status,
          };

          const result = await this.schedulerService.fireManual(hbSchedule, target);
          if (!result.success) {
            return { ok: false, error: `Manual fire failed: ${result.error || 'unknown error'}` };
          }
          return {
            ok: true,
            result: {
              message: `Fired ${force && !schedules.find(s => s.source_key === `heartbeat:${agent.id}`) ? '(synthesized) ' : ''}heartbeat to ${agent.name}`,
              agent: agent.name,
              scheduleId: hbSchedule.id,
              scheduledKey: result.scheduledKey,
              manual: true,
              force,
            },
          };
        }

        // Handle enable/disable subcommands
        if (subCmd === 'enable' || subCmd === 'disable') {
          const agentName = args[1];
          if (!agentName) {
            return { ok: false, error: `Usage: /heartbeat ${subCmd} <agent>` };
          }
          const matches = await this.dbResolveAgents(teamId, agentName);
          if (matches.length === 0) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          if (matches.length > 1) {
            return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
          }
          const agent = matches[0];

          // Enable/disable are a RESUME/PAUSE pair over one schedule row, never a
          // create/delete pair. Deleting on disable made the agent vanish from the
          // Heartbeats view instead of going idle, threw away the user's configured
          // interval and message, and forced enable to rebuild from HEARTBEAT.md —
          // which fails outright once that file is gone. Pausing cannot fail that way.
          const existing = await this.db.schedules.getDefinition(heartbeatScheduleId(agent.id));

          if (subCmd === 'enable') {
            if (existing) {
              // Resume in place — keep the configured interval/message rather than
              // re-deriving them from the file, which may have changed or gone.
              await this.setHeartbeatEnabled(agent, true);
              return { ok: true, result: { message: `Heartbeat enabled for ${agent.name} (interval: ${existing.interval_seconds}s)` } };
            }
            // No schedule yet — this is a first enable, so seed one from the file.
            if (!agent.working_directory) {
              return { ok: false, error: `Agent "${agent.name}" has no working directory` };
            }
            const config = this.readHeartbeatConfig(agent.working_directory);
            if (!config) {
              return { ok: false, error: `Agent "${agent.name}" has no HEARTBEAT.yaml or HEARTBEAT.md in working directory` };
            }
            const newMetadata = { ...agent.metadata, heartbeat: true };
            await this.db.agents.updateMetadata(agent.id, newMetadata);
            if (this.schedulerService) {
              const { definition, agentIds } = heartbeatToSchedule(agent.id, agent.name, config);
              await this.schedulerService.seedSchedule(definition, agentIds);
            }
            return { ok: true, result: { message: `Heartbeat enabled for ${agent.name} (interval: ${config.interval}s)` } };
          } else {
            // Disable: pause the row so it stays visible (idle) and re-armable.
            // Straight to the DB rather than through schedulerService — `setActive`
            // is a plain row update, and the scheduler only ever reads ACTIVE
            // definitions on tick, so a paused row simply stops firing.
            await this.setHeartbeatEnabled(agent, false);
            return { ok: true, result: { message: `Heartbeat disabled for ${agent.name}` } };
          }
        }

        const agentName = subCmd; // First arg is the agent name for status query

        if (agentName) {
          const matches = await this.dbResolveAgents(teamId, agentName);
          if (matches.length === 0) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          if (matches.length > 1) {
            return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
          }
          const agent = matches[0];
          if (agent.metadata?.heartbeat !== true) {
            return { ok: false, error: `Agent "${agent.name}" does not have heartbeat enabled. Use /heartbeat enable ${agent.name}` };
          }
          if (!agent.working_directory) {
            return { ok: false, error: `Agent "${agent.name}" has no working directory` };
          }
          const config = this.readHeartbeatConfig(agent.working_directory);
          const schedules = await this.db.schedules.listSchedulesForAgent(agent.id);
          const hbSchedule = schedules.find(s => s.source_key === `heartbeat:${agent.id}`);
          const runCount = hbSchedule ? await this.db.schedules.countRuns(hbSchedule.id, agent.id) : 0;
          return {
            ok: true,
            result: {
              agent: {
                name: agent.name,
                id: agent.id,
                status: agent.status,
                scheduleActive: hbSchedule?.active ?? false,
                intervalSeconds: hbSchedule?.interval_seconds || config?.interval || 'no file',
                runsSent: runCount,
                maxRuns: hbSchedule?.max_runs ?? config?.maxBeats ?? null,
                expiresAt: hbSchedule?.expires_at ?? null
              }
            }
          };
        }

        // No argument - show usage
        return { ok: false, error: 'Usage: /heartbeat <agent> or /heartbeats (to show all)' };
      }

      case 'heartbeats': {
        // /heartbeats - show all agents with heartbeat enabled
        const heartbeatAgents = await this.db.agents.findHeartbeat(teamId);
        const agentResults = [];
        for (const a of heartbeatAgents) {
          const schedules = await this.db.schedules.listSchedulesForAgent(a.id);
          const hbSchedule = schedules.find(s => s.source_key === `heartbeat:${a.id}`);
          const runCount = hbSchedule ? await this.db.schedules.countRuns(hbSchedule.id, a.id) : 0;
          const config = a.working_directory ? this.readHeartbeatConfig(a.working_directory) : null;
          agentResults.push({
            name: a.name,
            id: a.id,
            status: a.status,
            scheduleActive: hbSchedule?.active ?? false,
            intervalSeconds: hbSchedule?.interval_seconds || config?.interval || 'no file',
            runsSent: runCount,
            maxRuns: hbSchedule?.max_runs ?? config?.maxBeats ?? null,
            expiresAt: hbSchedule?.expires_at ?? null
          });
        }
        return {
          ok: true,
          result: {
            agents: agentResults
          }
        };
      }

      // /export <team> [path] — write a config YAML from the database (§5.1).
      // Deliberately thin: this reads rows and hands them to
      // lib/export-team-config.ts. Every decision about WHAT may be written —
      // the column allow-list, the metadata classes, the §5.6 warning, the
      // .bak-then-overwrite, the result shape — lives in that module, so the
      // handler cannot drift away from what the tests prove.
      case 'export': {
        const requestedTeam = args[0];
        if (!requestedTeam) {
          return { ok: false, error: 'Usage: /export <team> [path]' };
        }
        const team = await this.db.teams.getTeamByName(requestedTeam);
        if (!team) {
          return { ok: false, error: `Team "${requestedTeam}" not found` };
        }

        // listAll, not list(): list() hides interactive/virtual and automator
        // rows, which silently dropped register-created agents from exports.
        const agents = await this.db.agents.listAll(team.id);
        const schedulesByAgent: Record<string, ScheduleLike[]> = {};
        for (const agent of agents) {
          schedulesByAgent[agent.name] = await this.db.schedules.listSchedulesForAgent(agent.id);
        }

        const { org: teamOrg, warning: orgWarning } = await this.loadTeamOrg(team.id);
        const teamConfig = await this.db.teams.getConfig(team.id);
        const targetPath = resolveExportPath(
          args[1],
          teamConfig.last_config_path,
          this.baseWorkDir,
          team.name,
        );
        // §5.2.1: the avatar mirror is a sibling of the config file, and the
        // source is the manager's profiles tree.
        const avatarsRoot = path.join(path.dirname(targetPath), 'avatars');
        const profilesRoot = path.join(homedir(), '.id-agents', 'profiles');

        const result = exportTeamConfig({
          teamName: team.name,
          agents: agents as unknown as Parameters<typeof exportTeamConfig>[0]['agents'],
          targetPath,
          schedulesByAgent,
          org: teamOrg,
          profilesRoot,
          avatarsRoot,
          // #f37ad05d — lets the exporter tell a generated workdir from an authored one.
          baseWorkDir: this.baseWorkDir,
        });
        // A legacy team's org came from a file rather than the row — say so.
        if (orgWarning) result.warnings.push(orgWarning);
        return { ok: true, result };
      }

      case 'delete': {
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /delete <agent-name|agent-id> | /delete * | /delete --team <name>' };
        }

        // Bulk delete: /delete * (current team) or /delete --team <name>
        if (agentName === '*' || agentName === '--team') {
          let bulkTeamId = teamId;
          let bulkTeamName = 'current';
          let shouldDeleteTeamRow = false;
          if (agentName === '--team') {
            const targetTeam = args[1];
            if (!targetTeam) {
              return { ok: false, error: 'Usage: /delete --team <team-name>' };
            }
            if (!/^[a-zA-Z0-9_.-]+$/.test(targetTeam)) {
              return { ok: false, error: `Invalid team name: "${targetTeam}"` };
            }
            bulkTeamId = await this.db.teams.getOrCreateTeamId(targetTeam);
            bulkTeamName = targetTeam;
            shouldDeleteTeamRow = targetTeam !== 'default';
          }

          const agents = await this.dbListAgents(bulkTeamId, true);
          if (agents.length === 0 && !shouldDeleteTeamRow) {
            return { ok: true, result: { deleted: [], count: 0, team: bulkTeamName, message: 'No agents to delete' } };
          }

          const deletedNames: string[] = [];
          for (const agent of agents) {
            const serverKey = this.key(bulkTeamId, agent.id);
            const server = this.runningServers.get(serverKey);
            if (server) {
              await server.stop();
              this.runningServers.delete(serverKey);
            }
            if (agent.port) {
              await this.killAgentProcess(agent.port);
            }
            if (this.schedulerService) {
              await this.schedulerService.removeAgentSchedules(agent.id);
            }
            await this.cancelPendingQueriesForAgent(bulkTeamId, agent.id);
            const deleted = await this.dbDeleteAgentRow(bulkTeamId, agent.id);
            if (!deleted) {
              return { ok: false, error: `Failed to delete agent "${agent.name || agent.id}"` };
            }
            deletedNames.push(agent.name || agent.id);
          }

          if (deletedNames.length) {
            this.broadcastAgentsChanged(bulkTeamId, { reason: 'remove', removed: deletedNames });
          }

          let teamDeleted = false;
          if (shouldDeleteTeamRow) {
            const deletedTeam = await this.deleteEmptyTeamByName(bulkTeamName);
            if (!deletedTeam.ok) {
              return { ok: false, error: deletedTeam.error };
            }
            teamDeleted = true;
          }

          return {
            ok: true,
            result: {
              deleted: deletedNames,
              count: deletedNames.length,
              team: bulkTeamName,
              teamDeleted,
              message: teamDeleted
                ? `Deleted ${deletedNames.length} agents and team ${bulkTeamName}${deletedNames.length ? `: ${deletedNames.join(', ')}` : ''}`
                : `Deleted ${deletedNames.length} agents: ${deletedNames.join(', ')}`
            }
          };
        }

        // Single agent delete
        const matches = await this.dbResolveAgents(teamId, agentName);

        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        if (matches.length > 1) {
          const matchList = matches.map(a => {
            const domain = a.domain || (a.metadata as any)?.idchain_domain;
            const displayId = domain || a.name || a.id;
            return `  - ${displayId} (${a.status})`;
          }).join('\n');
          return {
            ok: false,
            error: `Multiple agents match "${agentName}":\n${matchList}\nUse a specific identifier (e.g., ENS domain or agent_id)`
          };
        }

        const a = matches[0];
        const serverKey = this.key(teamId, a.id);
        const server = this.runningServers.get(serverKey);

        if (server) {
          await server.stop();
          this.runningServers.delete(serverKey);
        }

        if (a.port) {
          await this.killAgentProcess(a.port);
        }

        // Remove any schedules for this agent
        if (this.schedulerService) {
          await this.schedulerService.removeAgentSchedules(a.id);
        }

        // Cancel any pending queries so they don't show as orphaned
        await this.cancelPendingQueriesForAgent(teamId, a.id);

        const deleted = await this.dbDeleteAgentRow(teamId, a.id);
        if (!deleted) {
          return { ok: false, error: `Failed to delete agent "${agentName}"` };
        }

        this.broadcastAgentsChanged(teamId, { reason: 'remove', removed: [a.name || a.id] });

        return { ok: true, result: { deleted: agentName } };
      }

      case 'output': {
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /output <agent-name>' };
        }
        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        const agent = matches[0];
        const outputDir = path.join(agent.working_directory || '', 'output');
        if (!existsSync(outputDir)) {
          return { ok: true, result: { agent: agent.name, files: [] } };
        }
        try {
          const entries = readdirSync(outputDir, { withFileTypes: true });
          const files = entries
            .filter(e => e.isFile())
            .map(e => {
              const st = statSync(path.join(outputDir, e.name));
              return { name: e.name, size: st.size, mtime: st.mtime.toISOString() };
            });
          return { ok: true, result: { agent: agent.name, files } };
        } catch {
          return { ok: true, result: { agent: agent.name, files: [] } };
        }
      }

      case 'artifact': {
        const agentName = args[0];
        const filePath = args.slice(1).join(' ');
        if (!agentName || !filePath) {
          return { ok: false, error: 'Usage: /artifact <agent-name> <path>' };
        }
        if (filePath.includes('..') || filePath.startsWith('/')) {
          return { ok: false, error: 'Invalid path: directory traversal not allowed' };
        }
        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        const agent = matches[0];
        const fullPath = path.join(agent.working_directory || '', 'output', filePath);
        if (!existsSync(fullPath)) {
          return { ok: false, error: `File not found: ${filePath}` };
        }
        try {
          const st = statSync(fullPath);
          if (st.size > 1_048_576) {
            return { ok: false, error: `File too large (${(st.size / 1024 / 1024).toFixed(1)}MB). Max: 1MB` };
          }
          const content = readFileSync(fullPath, 'utf-8');
          return { ok: true, result: { agent: agent.name, path: filePath, content, size: st.size } };
        } catch (err: any) {
          return { ok: false, error: `Failed to read file: ${err.message}` };
        }
      }

      case 'ask':
      case 'hey': {
        const agentName = args[0];
        const message = args.slice(1).join(' ');

        if (!agentName || !message) {
          return { ok: false, error: `Usage: /${action} <agent-name|agent-id> <message>` };
        }

        // Try to resolve by various identifiers
        const matches = await this.dbResolveAgents(teamId, agentName);

        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        if (matches.length > 1) {
          const matchList = matches.map(a => {
            const domain = a.domain || (a.metadata as any)?.idchain_domain;
            const displayId = domain || a.name || a.id;
            return `  - ${displayId} (${a.status})`;
          }).join('\n');
          return {
            ok: false,
            error: `Multiple agents match "${agentName}":\n${matchList}\nUse a specific identifier (e.g., ENS domain or agent_id)`
          };
        }

        const a = matches[0];
        // Use endpoint if set, otherwise construct from port using localhost
        const baseEndpoint = a.endpoint || `http://localhost:${a.port}`;

        // Discover REST-AP endpoints from the agent's catalog
        const endpoints = await discoverRestAPEndpoints(baseEndpoint);
        const talkUrl = `${baseEndpoint.replace(/\/+$/, '')}${endpoints.talk}`;

        // Send message to agent's /talk endpoint
        const talkHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        const talkResp = await fetch(talkUrl, {
          method: 'POST',
          headers: talkHeaders,
          body: JSON.stringify({ message, from: 'remote' })
        });

        if (!talkResp.ok) {
          const err = await talkResp.text();
          return { ok: false, error: `Failed to send message: ${err}` };
        }

        const talkResult = await talkResp.json() as any;
        const askQueryId = talkResult.query_id || talkResult.queryId;

        // Persist the query before handing its id back. Agent processes hold no
        // database handle, so a query dispatched from here would otherwise live
        // only in the target agent's memory: the manager's own `GET /query/:id`
        // would 404 forever and the documented dispatch-then-poll loop could
        // never resolve. The shared `/message` + `/talk-to` handler has always
        // recorded this row; the `/ask` command path never did.
        //
        // Best-effort: the message is already delivered at this point, so a
        // write failure must not turn a successful dispatch into an error.
        if (askQueryId) {
          try {
            await this.db.queries.create(teamId, askQueryId, a.id, message, Date.now());
          } catch (err: any) {
            console.error(
              `[Manager] Delivered query ${askQueryId} to ${agentName} but failed to persist it:`,
              err?.message || err,
            );
          }
        }

        return {
          ok: true,
          result: {
            queryId: askQueryId,
            status: 'processing',
            agent: agentName
          }
        };
      }

      case 'news': {
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /news <agent-name>' };
        }

        const a = await this.db.agents.getByName(teamId, agentName);

        if (!a) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        // Interactive (manager-inbox) agents have no /news HTTP server of
        // their own — the daemon owns the inbox. Read directly from
        // news_items using the same id resolution as GET /news so reads
        // and writes converge on the same row.
        if (a.type === 'interactive') {
          const teamRow = await this.db.teams.getTeam(teamId).catch(() => null);
          const teamName = teamRow?.name ?? 'unknown';
          const managerInbox = this.getManagerInboxRef(teamId, teamName);
          const rows = await this.db.news.pollByOwner(teamId, managerInbox.ownerKind, managerInbox.ownerId, 0, { limit: 100 });
          const items = rows.map((r: any) => ({
            id: Number(r.id),
            type: r.type,
            timestamp: Number(r.timestamp),
            message: r.message || undefined,
            data: r.data || undefined,
          }));
          return { ok: true, result: { items, total: items.length, timestamp: Date.now() } };
        }

        // Agents without a usable local network endpoint (virtual stubs,
        // remote-only rows that have no `port`/`endpoint` filled in) cannot
        // serve `/news` directly; skipping here avoids a catalog fetch
        // against `http://localhost:0` from the CLI's per-agent news poll.
        if (!a.port || !a.endpoint) {
          return { ok: true, result: { items: [], total: 0, timestamp: Date.now() } };
        }

        const baseEndpoint = a.endpoint;

        // Discover REST-AP endpoints from the agent's catalog
        const endpoints = await discoverRestAPEndpoints(baseEndpoint);
        const newsUrl = `${baseEndpoint.replace(/\/+$/, '')}${endpoints.news}`;

        const newsResp = await fetch(newsUrl);
        if (!newsResp.ok) {
          return { ok: false, error: 'Failed to fetch news' };
        }

        const news = await newsResp.json();
        return { ok: true, result: news };
      }


      // §8 (D6) — /diff <team> <config>. READ-ONLY drift inspection.
      //
      // This is what survives the removal of /sync: reconciliation still needs
      // somewhere to SEE drift, it just no longer gets to act on it. The
      // handler therefore does exactly three things — read rows, parse a
      // config, compute — and calls nothing that writes. computeSyncPlan is
      // reused unchanged; sync.ts is deliberately not refactored here because
      // only its mutating CALLERS die in commit 9.
      //
      // Notably absent, and absent on purpose: the updateConfig that /sync
      // performs before planning. /diff records nothing about having been run.
      case 'diff': {
        const diffTeamName = args[0];
        const diffConfigArg = args[1];
        if (!diffTeamName || !diffConfigArg) {
          return { ok: false, error: 'Usage: /diff <team> <config>' };
        }

        const diffTeam = await this.db.teams.getTeamByName(diffTeamName);
        if (!diffTeam) {
          return { ok: false, error: `Team "${diffTeamName}" not found` };
        }

        const diffLookup = this.resolveConfigPath(
          diffConfigArg.endsWith('.yaml') || diffConfigArg.endsWith('.yml')
            ? diffConfigArg
            : `${diffConfigArg}.yaml`,
        );
        if (!diffLookup.resolved) {
          return { ok: false, error: `Config not found: ${diffConfigArg}` };
        }

        const { agents: diffConfigAgents, errors: diffErrors } = processConfig(
          diffLookup.resolved,
          this.baseWorkDir,
          args.slice(2),
        );
        if (diffErrors.length > 0) {
          return {
            ok: false,
            error: `Config errors: ${diffErrors.map(e => `${e.path}: ${e.message}`).join('; ')}`,
          };
        }

        // Same row selection /sync used, so the two agree about what drift is.
        const diffRunning = (await this.db.agents.list(diffTeam.id, true))
          .filter(a => a.type === 'claude' || a.type === 'automator');

        const diffPlan = computeSyncPlan(diffConfigAgents, diffRunning, this.defaultConfig?.model);

        return {
          ok: true,
          result: {
            team: diffTeamName,
            config: diffLookup.resolved,
            added: diffPlan.added,
            removed: diffPlan.removed,
            changed: diffPlan.changed,
            unchanged: diffPlan.unchanged,
            summary: formatSyncSummary(diffPlan),
            verbose: formatSyncVerbose(diffPlan),
          },
        };
      }

      // §7 — /import <file> [--team <name>]. Creates a NEW team by reusing the
      // deploy creation path verbatim, so the §4 refusal contract, org
      // persistence and workdir containment come along rather than being
      // reimplemented. The only import-specific work is the avatar mirror.
      case 'import': {
        const teamFlagIndex = args.indexOf('--team');
        const overrideTeam = teamFlagIndex >= 0 ? args[teamFlagIndex + 1] : undefined;
        if (teamFlagIndex >= 0 && !overrideTeam) {
          return { ok: false, error: 'Usage: /import <file> [--team <name>]' };
        }
        // With no --team, indexOf returns -1 and `i !== teamFlagIndex + 1`
        // becomes `i !== 0`, silently dropping the FILENAME — so the no-flag
        // form (§7's primary form) could never work. Only filter when present.
        const importArgs = teamFlagIndex >= 0
          ? args.filter((_a, i) => i !== teamFlagIndex && i !== teamFlagIndex + 1)
          : args;
        const importFile = importArgs[0];
        if (!importFile) {
          return { ok: false, error: 'Usage: /import <file> [--team <name>]' };
        }

        const created = await this.executeRemoteCommand(
          ['/deploy', ...importArgs].join(' '),
          teamId,
          teamName,
          callerFrom,
          overrideTeam,
        );
        // A refusal (409) or a config error propagates untouched — import must
        // not soften the contract it inherited.
        if (!created.ok) return created;

        // §5.2.3 avatars. Never fatal: a team that will not import because a
        // PNG is corrupt is a worse outcome than a team with no picture.
        const importedTeam = created.result?.team || overrideTeam || teamName;
        const importLookup = this.resolveConfigPath(
          importFile.endsWith('.yaml') || importFile.endsWith('.yml') ? importFile : `${importFile}.yaml`,
        );
        const avatarWarnings = importLookup.resolved
          ? importAvatars(
              importedTeam,
              (created.result?.agents || []).map((a: { name?: string }) => String(a?.name ?? '')),
              path.join(path.dirname(importLookup.resolved), 'avatars'),
              path.join(homedir(), '.id-agents', 'profiles'),
              importLookup.resolved,
            ).warnings
          : [];

        return {
          ok: true,
          result: { ...created.result, imported: true, warnings: [...(created.result?.warnings || []), ...avatarWarnings] },
        };
      }

      case 'deploy': {
        // Deploy agents from a config file
        // Usage: /deploy <config> [param1=value1] [param2=value2] ...
        const dryRun = args.includes('--dry-run');
        const filteredArgs = args.filter(arg => arg !== '--dry-run');
        const configPath = filteredArgs[0];
        if (!configPath) {
          return { ok: false, error: 'Usage: /deploy <config> [param=value ...] [--dry-run]' };
        }

        // Resolve config path (support shorthand like "designer" -> "configs/designer.yaml")
        let filePath = configPath;
        const originalArg = configPath;
        if (!filePath.includes('/') && !filePath.includes('\\')) {
          if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) {
            filePath = `configs/${filePath}.yaml`;
          } else {
            filePath = `configs/${filePath}`;
          }
        } else if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) {
          filePath = `${filePath}.yaml`;
        }

        // Resolve against every plausible config root, not just the manager's cwd
        const deployLookup = this.resolveConfigPath(filePath);
        let absolutePath = deployLookup.resolved ?? '';

        // Parse config with provided parameters
        let deployArgs = filteredArgs.slice(1);

        // If config doesn't exist, fall back to default.yaml with the arg as the name
        if (!deployLookup.resolved) {
          const defaultLookup = this.resolveConfigPath('configs/default.yaml');
          if (defaultLookup.resolved) {
            console.log(`[Deploy] Config not found: ${filePath}, using default.yaml with name=${originalArg}`);
            absolutePath = defaultLookup.resolved;
            // Prepend the original arg as name parameter if not already specified
            if (!deployArgs.some(a => a.startsWith('name='))) {
              deployArgs = [originalArg, ...deployArgs];
            }
          } else {
            return { ok: false, error: this.configNotFoundError(filePath, deployLookup.searched) };
          }
        }
        const preflight = await this.buildDeployPreflightSummary(teamId, teamName, absolutePath, deployArgs);

        if (dryRun) {
          return {
            ok: true,
            result: {
              dryRun: true,
              configPath: preflight.configPath,
              teamName: preflight.teamName,
              calendarCount: preflight.calendarCount,
              agents: preflight.agents,
            }
          };
        }

        const { agents, calendar, errors, teamName: configTeam, org } = processConfig(absolutePath, this.baseWorkDir, deployArgs);

        // §4 REFUSAL CONTRACT (D1). /deploy creates teams; it never writes into
        // an existing one. This runs BEFORE the getOrCreateTeamId / mkdirSync
        // below and before any agent work, so a refusal mutates nothing.
        //
        // The check is "does this team already hold agents", not "does a team
        // row exist". getTeam() on the way in calls getOrCreateTeamId, so a row
        // for the request's team ALWAYS exists by the time deploy runs —
        // refusing on row-existence alone would reject every deploy, including
        // brand-new teams. An empty auto-created row is not a live team; a team
        // with agents in it is exactly what D1 protects.
        const targetTeamName = teamOverride || configTeam || teamName;
        const existingTeam = await this.db.teams.getTeamByName(targetTeamName);
        if (existingTeam) {
          // listAll, not list(): a team holding only a register-created virtual
          // agent is still live, and list() would not see it.
          const occupants = await this.db.agents.listAll(existingTeam.id);
          if (occupants.length > 0) {
            return {
              ok: false,
              httpStatus: 409,
              error: 'team_exists',
              // #6bcd3201: the hint is shared so it cannot name a command that
              // does not exist — the previous text pointed at /agents spawn and
              // /agents remove, neither of which has a handler.
              message: `Team "${targetTeamName}" already exists. /deploy only creates new teams. ${LIVE_TEAM_CHANGE_HINT} To inspect drift, /diff <team> <config>.`,
            };
          }
        }

        // If config specifies a team, use that instead of the request's team
        let effectiveTeamId = teamId;
        let effectiveTeamName = teamName;
        if (targetTeamName !== teamName) {
          effectiveTeamId = await this.db.teams.getOrCreateTeamId(targetTeamName);
          effectiveTeamName = targetTeamName;
          // Ensure team directory exists
          const configTeamDir = `${this.baseWorkDir}/teams/${targetTeamName}`;
          if (!existsSync(configTeamDir)) mkdirSync(configTeamDir, { recursive: true });
          console.log(`[Deploy] Using team: ${targetTeamName}`);
        }

        if (errors.length > 0) {
          return {
            ok: false,
            error: `Config errors: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`
          };
        }

        if (agents.length === 0) {
          return { ok: false, error: 'No agents defined in config' };
        }

        // #4d78adbc — a config file is an EXECUTION SURFACE once /import exists.
        // This path took `workingDirectory` verbatim when absolute, mkdir'd it,
        // wrote CLAUDE.md, copied skills and plugins into it and rooted an agent
        // process there. That is the commit-5 spawn finding reopened through a
        // file-borne vector, so it goes through the SAME guard as :3032 rather
        // than a second policy that could drift.
        //
        // PRE-FLIGHT, not per-agent: every path is checked before ANY agent is
        // created, so a rejected config leaves nothing behind — no rows, no
        // directories, no last_config_path. Validating inside the loop would
        // half-deploy a team and then refuse.
        const workdirRoots = agentWorkdirRoots(this.baseWorkDir);
        const resolvedWorkdirs = new Map<string, string>();
        for (const agentConfig of agents) {
          const declared = agentConfig.workingDirectory;
          if (declared === undefined || declared === null || declared === '') continue;
          const verdict = resolveWithinRoots(declared, workdirRoots);
          if (!verdict.ok) {
            console.warn(`[Deploy] rejected workingDirectory for "${agentConfig.name}": ${verdict.reason}`);
            return {
              ok: false,
              httpStatus: 400,
              error: 'invalid_working_directory',
              // Name the path AND what is allowed: someone importing a file
              // they did not write needs to know why it failed and how to fix it.
              message:
                `Agent "${agentConfig.name}" declares a workingDirectory outside every permitted root: ` +
                `${declared}. Permitted roots: ${workdirRoots.join(', ')}. Set ${PROJECTS_ROOT_ENV} or ` +
                `add the directory to ID_ALLOWED_WORKDIR_ROOTS (colon-separated) to permit it.`,
            };
          }
          // Store the RESOLVED path, as spawn does, so a symlink cannot be
          // re-followed elsewhere after the check.
          resolvedWorkdirs.set(agentConfig.name, verdict.path);
        }

        // Remember the config file for this team so runtime profile edits
        // (POST /agents/by-name/:name/profile) can persist back to YAML.
        // Persist the parsed org block alongside the config path. The database
        // is the source of truth, so export reads org from HERE rather than
        // re-reading the file — which is why /export previously emitted no org
        // block at all: nothing ever wrote this field.
        await this.db.teams.updateConfig(effectiveTeamId, {
          last_config_path: absolutePath,
          ...(org ? { org } : {}),
        });

        for (const agentConfig of agents) {
          const effectiveRuntime = resolveRuntime(agentConfig.runtime) as HarnessType;
          const effectiveModel = agentConfig.model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
          this.ensureRuntimeReady(effectiveRuntime, effectiveModel);
        }

        // Generate org chart if defined in config
        if (org?.groups) {
          try {
            const { generateOrgChart } = await import('./org-chart.js');
            const orgMd = generateOrgChart(effectiveTeamName, org, agents.map(a => ({
              name: a.name,
              description: a.description,
            })));
            const teamDir = `${this.baseWorkDir}/teams/${effectiveTeamName}`;
            if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
            writeFileSync(`${teamDir}/ORG_CHART.md`, orgMd);
            console.log(`[Deploy] Org chart written to teams/${effectiveTeamName}/ORG_CHART.md`);
          } catch (err: any) {
            console.warn(`[Deploy] Could not generate org chart: ${err.message}`);
          }
        }

        // Validate automator naming: first automator must be named "lead-automator"
        const automatorAgents = agents.filter(a => a.type === 'automator');
        if (automatorAgents.length > 0) {
          const existingLeadAutomator = await this.db.agents.getByName(effectiveTeamId, 'lead-automator');
          const hasLeadAutomator = existingLeadAutomator !== null && existingLeadAutomator.type === 'automator';

          if (!hasLeadAutomator) {
            const hasLeadAutomatorInConfig = automatorAgents.some(a => a.name === 'lead-automator');
            if (!hasLeadAutomatorInConfig) {
              return {
                ok: false,
                error: 'First automator must be named "lead-automator". Rename the team-local automator and re-deploy.'
              };
            }
          }
        }

        // Deploy each agent
        const results: { name: string; id?: string; port?: number; success: boolean; error?: string }[] = [];

        // Re-seed calendar schedules idempotently for this config source.
        if (this.schedulerService) {
          await this.db.schedules.deleteBySource('yaml', `calendar:${absolutePath}:`);
          this.scheduleAutoExport(teamId); // §5.4 — schedule mutation
        }

        for (const agentConfig of agents) {
          // Generate unique agent ID outside try so it's available for cleanup
          const agentId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          try {
            const port = await this.dbNextPort(effectiveTeamId);
            // Resolved by the pre-flight guard above (#4d78adbc); an agent that
            // declared nothing keeps the generated default, which we built and
            // therefore do not need to validate.
            const workingDirectory = resolvedWorkdirs.get(agentConfig.name)
              || `${this.baseWorkDir}/agents/${agentId}`;

            if (!existsSync(workingDirectory)) {
              mkdirSync(workingDirectory, { recursive: true });
            }

            // Merge plugins from config
            const effectiveRuntime = resolveRuntime(agentConfig.runtime) as HarnessType;
            const effectiveModel = agentConfig.model || getDefaultModelForRuntime(effectiveRuntime, this.defaultConfig?.model);
            this.ensureRuntimeReady(effectiveRuntime, effectiveModel);
            const mergedPlugins = agentConfig.plugins || [];

            // Copy plugins to agent's working directory
            const localPlugins = this.copyPluginsToAgent(mergedPlugins, workingDirectory);

            // Automator agents are team-local planning workers; they don't have REST-AP endpoints
            console.log(`[Deploy] Agent ${agentConfig.name}: type=${agentConfig.type}, isAutomator=${agentConfig.type === 'automator'}`);
            const isAutomator = agentConfig.type === 'automator';
            const agentType = agentConfig.type || 'claude';
            const normalizedSkills = normalizeConfigSkills(agentConfig.skills);

            // Get heartbeat config
            const heartbeatConfig = agentConfig.heartbeat;

            const metadata: AgentMetadata = {
              name: agentConfig.name,
              service_type: isAutomator ? undefined : 'REST-AP',
              endpoint: isAutomator ? undefined : `http://localhost:${port}`,
              runtime: effectiveRuntime,
              plugins: localPlugins,
              ...(agentConfig.agent && { agent: agentConfig.agent }),
              ...(normalizedSkills && { skills: normalizedSkills }),
              allowed_tools: agentConfig.allowedTools,
              description: agentConfig.description,
              ...(agentConfig.effort && { effort: agentConfig.effort }),
              ...(isAutomator && { isAutomator: true }),
              // Flag that heartbeat is enabled
              ...(heartbeatConfig && { heartbeat: true }),
              ...(agentConfig.openMode !== undefined && { openMode: agentConfig.openMode }),
              ...(agentConfig.dangerouslySkipPermissions !== undefined && { dangerouslySkipPermissions: agentConfig.dangerouslySkipPermissions }),
              // Catalog seed from YAML — lands in metadata.catalog and surfaces
              // via the agent's /catalog endpoint. Runtime PATCH /catalog still
              // works; the next /deploy or /sync re-applies this YAML floor.
              ...(agentConfig.catalog && { catalog: agentConfig.catalog }),
              // D10: an address identifier round-trips through metadata.
              ...(agentConfig.agent_account && { agent_account: agentConfig.agent_account }),
              // DMZ posture. Same shape POST /agents/register stamps at
              // manager-join — one format, not a second. `!== undefined` and
              // not truthiness: `mesh_member: false` is the whole point, and a
              // truthy check would drop exactly the value that matters.
              ...(agentConfig.mesh_member !== undefined && { mesh_member: agentConfig.mesh_member }),
              ...(agentConfig.mesh_reachable !== undefined && { mesh_reachable: agentConfig.mesh_reachable }),
              ...(agentConfig.public_endpoint !== undefined && { public_endpoint: agentConfig.public_endpoint }),
              ...(agentConfig.dmz !== undefined && { dmz: agentConfig.dmz }),
              ...(agentConfig.allowed_inbound && { allowed_inbound: agentConfig.allowed_inbound }),
              ...(agentConfig.allowed_outbound && { allowed_outbound: agentConfig.allowed_outbound }),
              // Profile floor from YAML (bio/handles) — same semantics as catalog.
              ...(agentConfig.bio && { bio: agentConfig.bio }),
              ...(agentConfig.handles && { handles: agentConfig.handles })
            };

            // Wallet opt-in (default off). Record the explicit choice in
            // metadata so the on-demand provisioning command and the
            // wallet auto-provision gate can read it. Only call the `ows`
            // CLI when `wallet: true`.
            if (agentConfig.wallet !== undefined) {
              metadata.wallet = agentConfig.wallet;
            }
            const owsWallet = agentConfig.wallet === true
              ? this.getOrCreateAgentWallet(effectiveTeamName, agentConfig.name)
              : null;
            if (owsWallet) {
              metadata.ows_wallet = owsWallet.walletName;
              metadata.ows_address = owsWallet.address;
            }

            // 1. Deploy library-backed agent overlay into the runtime overlay target, if configured
            if (agentConfig.agent) {
              copyLibraryAgentOverlay(workingDirectory, agentConfig.agent, effectiveRuntime);
            }

            // 2. Deploy skills (runtime-aware)
            const agentSkills: string[] = agentConfig.skills || [];
            let orgContext = '';
            if (org?.groups) {
              try {
                const { generateAgentOrgContext } = await import('./org-chart.js');
                orgContext = generateAgentOrgContext(agentConfig.name, org);
              } catch { /* ignore */ }
            }
            this.deploySkillsToAgent(workingDirectory, agentSkills, {
              DISPLAY_NAME: agentConfig.name,
              TEAM: effectiveTeamName,
              ORG_CONTEXT: orgContext
                ? `\n## Your Role\n\n${orgContext}\n\nSee the full org chart at the shared team folder for details on all groups.`
                : '',
            }, { hasWallet: !!owsWallet, runtime: effectiveRuntime });

            // 3. Overlay working-directory template files (runtime-aware)
            copyAgentDirOverlay(workingDirectory, agentConfig.name, effectiveRuntime);
            copyHeartbeatMd(workingDirectory, agentConfig.name, effectiveRuntime);

            // 4. Write personality file: protocol defaults + agent role body (runtime-aware)
            {
              const parts = [PROTOCOL_DEFAULTS];
              if (agentConfig.roleBody) parts.push(agentConfig.roleBody);
              writePersonalityFile(workingDirectory, effectiveRuntime, parts.join('\n\n'));
            }

            // 5. Codex/Cursor: append library persona to AGENTS.md inside
            // marker fences (no-op for Claude).
            if (agentConfig.agent) {
              appendLibraryPersonaToAgentsMd(workingDirectory, agentConfig.agent, effectiveRuntime);
            }

            // §4.1: the recreate block that used to kill and delete an
            // existing same-named agent is GONE. Under D1 deploy only ever
            // targets an empty team, so it was unreachable — and it was the
            // only path in deploy that could destroy a row it did not create.

            // Insert into database
            console.log(`[Deploy] Storing agent: name=${agentConfig.name}, type=${agentType}, configType=${agentConfig.type}`);
            await this.db.agents.create({
              team_id: effectiveTeamId,
              id: agentId,
              name: agentConfig.name,
              type: agentType,
              model: effectiveModel,
              port,
              endpoint: null,
              working_directory: workingDirectory,
              status: 'starting',
              created_at: Date.now(),
              metadata,
              runtime: effectiveRuntime,
              // D9: ENS identity round-trips through its own columns. Without
              // these the export emitted tokenId/domain that nothing could
              // restore.
              token_id: agentConfig.tokenId ?? null,
              domain: agentConfig.domain ?? null,
              // #42a80a4c: same reason as D9 above, for the remote-endpoint
              // identity. Export emitted customer_domain/public_endpoint_url
              // that nothing could restore, so an imported public-agent-remote
              // agent came back unreachable.
              customer_domain: agentConfig.customer_domain ?? null,
              public_endpoint_url: agentConfig.public_endpoint_url ?? null,
            });

            // All agents run locally - set up database and let CLI spawn the process
            const url = `http://localhost:${port}`;
            const finalMeta = { ...metadata, endpoint: url, local: true };
            await this.db.agents.updateStatus(agentId, 'pending', {
              port,
              endpoint: url,
              metadata: finalMeta,
            });

            // Spawn the agent process
            const spawnResult = await this.spawnLocalAgentProcess(effectiveTeamId, effectiveTeamName, {
              name: agentConfig.name,
              id: agentId,
              port,
              model: effectiveModel,
              workingDirectory,
              address: (agentConfig as any).address || undefined
            });

            // Seed heartbeat schedule if config specified
            if (heartbeatConfig && this.schedulerService) {
              const { definition, agentIds } = heartbeatToSchedule(agentId, agentConfig.name, heartbeatConfig);
              await this.schedulerService.seedSchedule(definition, agentIds);
            }

            const result: { name: string; id: string; port: number; success: boolean; local: boolean; workingDirectory: string; pid?: number; logFile?: string } = {
              name: agentConfig.name,
              id: agentId,
              port,
              success: true,
              local: true,
              workingDirectory
            };

            if (spawnResult.success) {
              result.pid = spawnResult.pid;
              result.logFile = spawnResult.logFile;
              // Update status to running
              await this.db.agents.updateStatus(agentId, 'running');
            }

            results.push(result);
          } catch (err: any) {
            // Clean up the database record if deployment failed
            if (agentId) {
              try {
                await this.db.agents.deleteAgent(agentId);
                console.log(`[Deploy] Cleaned up failed agent record: ${agentId}`);
              } catch (cleanupErr) {
                console.warn(`[Deploy] Failed to clean up agent record: ${cleanupErr}`);
              }
            }
            results.push({ name: agentConfig.name, success: false, error: err.message });
          }
        }

        if (calendar.length > 0 && this.schedulerService) {
          for (let index = 0; index < calendar.length; index++) {
            const spec = calendar[index] as CalendarSpec;
            const targetIds: string[] = [];

            for (const ref of spec.agents) {
              const target = await this.db.agents.getByName(effectiveTeamId, ref);
              if (!target) {
                console.warn(`[Scheduler] Calendar event "${spec.title}" target not found: ${ref}`);
                continue;
              }
              targetIds.push(target.id);
            }

            if (targetIds.length === 0) {
              console.warn(`[Scheduler] Skipping calendar event "${spec.title}" with no resolved targets`);
              continue;
            }

            const { definition, agentIds } = calendarToSchedule(
              spec,
              `calendar:${absolutePath}:${index}`,
              targetIds,
            );
            await this.schedulerService.seedSchedule(definition, agentIds);
          }
        }

        const deployedNames = results.filter(r => r.success).map(r => r.name);
        if (deployedNames.length) {
          this.broadcastAgentsChanged(effectiveTeamId, { reason: 'deploy', added: deployedNames });
        }

        return {
          ok: true,
          result: {
            // Echo the effective team back so the CLI can retarget its
            // daemon connection when /deploy targets a team different
            // from activeTeam.
            team: effectiveTeamName,
            teamId: effectiveTeamId,
            deployed: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            agents: results
          }
        };
      }

      case 'agent': {
        // Control individual agent: /agent <name> <start|stop|rebuild|logs|heartbeat|wallet provision>
        const agentName = args[0];
        const subAction = args[1]?.toLowerCase();

        if (!agentName || !subAction) {
          return { ok: false, error: 'Usage: /agent <name> <start|stop|rebuild|logs|heartbeat|probe|wallet provision>' };
        }

        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
        if (!agent) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        if (subAction === 'probe') {
          // Single named agent — do NOT filter on status. The operator
          // explicitly asked to probe this agent; a downed agent should
          // surface as `failed` (with the timeout/network error string),
          // not be silently skipped.
          return this.probeAgentsViaTalk(teamName, [agent]);
        }

        if (subAction === 'wallet') {
          const walletAction = args[2]?.toLowerCase();
          if (walletAction !== 'provision') {
            return { ok: false, error: 'Usage: /agent <name> wallet provision' };
          }
          const meta = (agent.metadata || {}) as Record<string, any>;
          if (meta.ows_wallet) {
            return {
              ok: true,
              result: {
                action: 'wallet-provision',
                name: agent.name,
                status: 'already-provisioned',
                ows_wallet: meta.ows_wallet,
                ows_address: meta.ows_address || null,
              },
            };
          }
          if (!this.checkOwsInstalled()) {
            return { ok: false, error: 'OWS CLI not installed; cannot provision wallet on demand' };
          }
          const refreshed = await this.provisionAgentWalletForRow(teamId, teamName, agent);
          if (!refreshed) {
            return { ok: false, error: `Failed to provision OWS wallet for ${agent.name}` };
          }
          // Push the wallet identity to the remote VPS (non-fatal) so the
          // public-agent can advertise its new address.
          if (isRemoteEndpointRuntime(refreshed.runtime)) {
            try {
              await this.stageAndDeliverRemoteWalletIdentity(refreshed);
            } catch (err: any) {
              console.warn(`[Wallet] Identity delivery failed for ${refreshed.name}: ${err?.message || String(err)}`);
            }
          }
          const provisionedMeta = (refreshed.metadata || {}) as Record<string, any>;
          return {
            ok: true,
            result: {
              action: 'wallet-provision',
              name: refreshed.name,
              status: 'provisioned',
              ows_wallet: provisionedMeta.ows_wallet,
              ows_address: provisionedMeta.ows_address || null,
            },
          };
        }

        // Remote-endpoint runtimes are lifecycled by the operator, not the manager.
        if (isRemoteEndpointRuntime(agent.runtime)) {
          return { ok: false, error: 'lifecycle_not_supported_for_remote' };
        }

        if (agent.type !== 'claude') {
          return { ok: false, error: 'Only claude agents can be controlled' };
        }

        try {
          switch (subAction) {
            case 'start': {
              const spawnResult = await this.spawnLocalAgentProcess(teamId, teamName, {
                name: agent.name, id: agent.id, port: agent.port,
                model: agent.model, workingDirectory: agent.working_directory ?? undefined,
                tokenId: agent.token_id ?? undefined
              });
              if (spawnResult.success) {
                await this.db.agents.updateStatus(agent.id, 'running');
                return { ok: true, result: { action: 'started', name: agent.name, pid: spawnResult.pid, logFile: spawnResult.logFile } };
              } else {
                return { ok: false, error: `Failed to start ${agent.name}: ${spawnResult.error}` };
              }
            }
            case 'stop': {
              const killResult = await this.killAgentProcess(agent.port);
              const cancelled = await this.cancelPendingQueriesForAgent(teamId, agent.id);
              await this.db.agents.updateStatus(agent.id, 'stopped');
              return { ok: true, result: { action: 'stopped', name: agent.name, ...killResult, queriesCancelled: cancelled } };
            }
            case 'rebuild': {
              const spawnResult = await this.rebuildLocalClaudeAgent(teamId, teamName, agent);
              if (spawnResult.success) {
                return { ok: true, result: { action: 'rebuilt', name: agent.name, pid: spawnResult.pid, logFile: spawnResult.logFile } };
              } else {
                return { ok: false, error: `Failed to rebuild ${agent.name}: ${spawnResult.error}` };
              }
            }
            case 'logs': {
              return { ok: false, error: 'Logs not available for local agents' };
            }
            case 'heartbeat': {
              // Send heartbeat and reset timer
              if (agent.metadata?.heartbeat !== true) {
                return { ok: false, error: `Agent "${agent.name}" does not have heartbeat enabled` };
              }
              if (agent.status !== 'running') {
                return { ok: false, error: `Agent "${agent.name}" is not running` };
              }
              if (!agent.working_directory) {
                return { ok: false, error: `Agent "${agent.name}" has no working directory` };
              }
              // Read config from file
              const config = this.readHeartbeatConfig(agent.working_directory);
              if (!config) {
                return { ok: false, error: `Agent "${agent.name}" has no HEARTBEAT.yaml or HEARTBEAT.md file` };
              }
              // Send one immediate message and reseed the schedule
              if (agent.endpoint) {
                try {
                  await fetch(`${agent.endpoint}/talk`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ from: 'schedule', message: config.message }),
                  });
                } catch { /* ignore */ }
              }
              if (this.schedulerService) {
                const { definition, agentIds } = heartbeatToSchedule(agent.id, agent.name, config);
                await this.schedulerService.seedSchedule(definition, agentIds);
              }
              return { ok: true, result: { action: 'heartbeat', name: agent.name, intervalSeconds: config.interval, message: 'Heartbeat sent and schedule reseeded' } };
            }
            default:
              return { ok: false, error: `Unknown agent action: ${subAction}. Available: start, stop, rebuild, logs, heartbeat, probe, wallet provision` };
          }
        } catch (err: any) {
          return { ok: false, error: `Agent ${subAction} failed: ${err.message}` };
        }
      }

      case 'model': {
        // Change agent model: /model <agent> <model>
        const agentName = args[0];
        const newModel = args[1];

        if (!agentName || !newModel) {
          return { ok: false, error: 'Usage: /model <agent-name> <model>' };
        }

        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
        if (!agent) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }

        // Resolve model alias
        const resolvedModel = resolveModelAlias(newModel);

        // Update model and mark for restart if running
        const newStatus = agent.status === 'running' ? 'pending' : agent.status;
        await this.db.agents.updateStatus(agent.id, newStatus, { model: resolvedModel });

        return {
          ok: true,
          result: {
            name: agent.name,
            model: resolvedModel,
            ...(agent.status === 'running' && { message: 'Model updated. Agent marked for restart.' })
          }
        };
      }

      case 'configs': {
        // List available deployment configs
        const configsDir = path.resolve(process.cwd(), 'configs');
        if (!existsSync(configsDir)) {
          return { ok: true, result: { configs: [] } };
        }
        const files = readdirSync(configsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        const configs = files.map(f => {
          const name = f.replace(/\.(yaml|yml)$/, '');
          const filePath = path.join(configsDir, f);
          try {
            const content = readFileSync(filePath, 'utf-8');
            const parsed = yaml.load(content) as any;
            return {
              name,
              description: parsed?.description || null,
              agents: parsed?.agents?.length || 0
            };
          } catch {
            return { name, description: null, agents: 0 };
          }
        });
        return { ok: true, result: { configs } };
      }

      case 'teams': {
        // List all teams
        const teams = await this.db.teams.listTeams();
        const teamList = await Promise.all(
          teams.map(async (team) => {
            const agentCount = await this.db.agents.count(team.id);
            return {
              id: team.id,
              name: team.name,
              agentCount: parseInt(agentCount || '0')
            };
          })
        );
        return { ok: true, result: { teams: teamList } };
      }

      case 'team': {
        // /team - show current team (from header)
        // /team delete <name> - delete an empty, inactive team.
        // /team <name> - switch to an existing team.
        const targetName = args[0];
        const subcommand = targetName?.toLowerCase();
        if (subcommand === 'delete' || subcommand === 'remove') {
          const nameArg = args[1];
          if (!nameArg || args.length !== 2) {
            return { ok: false, error: 'Usage: /team delete <name>' };
          }
          const nameCheck = validateName(nameArg, 'team');
          if (!nameCheck.valid) {
            return { ok: false, error: nameCheck.error };
          }
          if (nameArg === teamName) {
            return { ok: false, error: `Cannot delete the active team "${nameArg}". Switch to another team first.` };
          }

          const deleted = await this.deleteEmptyTeamByName(nameArg);
          if (!deleted.ok) {
            return { ok: false, error: deleted.error };
          }
          return { ok: true, result: deleted.result };
        }

        if (targetName) {
          if (args.length !== 1) {
            return { ok: false, error: 'Usage: /team [name] | /team delete <name>' };
          }
          const nameCheck = validateName(targetName, 'team');
          if (!nameCheck.valid) {
            return { ok: false, error: nameCheck.error };
          }

          const targetTeam = await this.db.teams.getTeamByName(targetName);
          if (!targetTeam) {
            return {
              ok: false,
              error: `Team ${targetName} not found. Create configs/${targetName}.yaml and run :deploy ${targetName}, or :sync ${targetName} to materialize an existing YAML.`
            };
          }

          const targetAgentCount = await this.db.agents.count(targetTeam.id);
          return {
            ok: true,
            result: {
              id: targetTeam.id,
              name: targetTeam.name,
              agentCount: parseInt(targetAgentCount || '0'),
              switched: true
            }
          };
        }

        const team = await this.db.teams.getTeam(teamId);
        if (!team) {
          return { ok: false, error: 'Team not found' };
        }
        const agentCount = await this.db.agents.count(teamId);
        return {
          ok: true,
          result: {
            id: team.id,
            name: team.name,
            agentCount: parseInt(agentCount || '0')
          }
        };
      }

      case 'meta': {
        // /meta <agent> - show metadata
        // /meta set <agent> <key> <value> - set metadata key
        // /meta setid <agent> <domain> [tokenId] - set agent identity
        const subCmd = args[0];

        if (subCmd === 'set') {
          const agentName = args[1];
          const key = args[2];
          const value = args.slice(3).join(' ');
          if (!agentName || !key) {
            return { ok: false, error: 'Usage: /meta set <agent> <key> <value>' };
          }
          const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
          if (!agent) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          const newMetadata = { ...(agent.metadata || {}), [key]: value || null };
          // When setting 'endpoint', also update the endpoint column (used for routing)
          if (key === 'endpoint') {
            await this.db.agents.updateIdentity(agent.id, {
              endpoint: value || undefined,
              metadata: newMetadata,
            });
          } else {
            await this.db.agents.updateMetadata(agent.id, newMetadata);
          }
          return { ok: true, result: { name: agent.name, metadata: newMetadata } };
        }

        if (subCmd === 'setid') {
          const agentName = args[1];
          const domainArg = args[2];
          const tokenIdArg = args[3];
          if (!agentName || !domainArg) {
            return { ok: false, error: 'Usage: /meta setid <agent> <domain> [tokenId]' };
          }
          const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
          if (!agent) {
            return { ok: false, error: `Agent "${agentName}" not found` };
          }
          await this.db.agents.updateIdentity(agent.id, {
            domain: domainArg,
            token_id: tokenIdArg || undefined,
          });
          return { ok: true, result: { name: agent.name, domain: domainArg, tokenId: tokenIdArg || null } };
        }

        // /meta <agent> - show metadata
        const agentName = subCmd;
        if (!agentName) {
          return { ok: false, error: 'Usage: /meta <agent> or /meta set <agent> <key> <value>' };
        }
        const agent = await this.dbQueryAgentByNameMostRecent(teamId, agentName);
        if (!agent) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        return {
          ok: true,
          result: {
            name: agent.name,
            id: agent.id,
            tokenId: agent.token_id,
            domain: agent.domain,
            metadata: agent.metadata
          }
        };
      }

      case 'cancel': {
        // /cancel <agent> - Cancel running query
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /cancel <agent-name>' };
        }

        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        if (matches.length > 1) {
          return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
        }

        const agent = matches[0];
        const baseEndpoint = agent.endpoint || `http://localhost:${agent.port}`;

        // Write the cancellation marker BEFORE killing the running query so it
        // shows up before the agent's /cancel handler races the process kill.
        // Two writes for two surfaces:
        //   1. Agent-owned row → visible in the TUI's per-agent NewsView
        //      (which fetches /news <agent> → the agent's local /news, which
        //      reads news_items keyed by agent_id).
        //   2. Manager-inbox-owned row → visible to any operator-side tool
        //      that reads the team-level GET /news feed.
        // May duplicate the agent's own /cancel news entry (claude-agent-server
        // line 817) in the no-race case; the duplication is intentional so the
        // marker is guaranteed even when the kill wins the race.
        {
          const cancelTs = Date.now();
          const managerInbox = this.getManagerInboxRef(teamId, teamName);
          await this.db.news.add(teamId, null, {
            timestamp: cancelTs,
            type: 'query.cancelled',
            message: `Cancelled by operator: ${agent.name}`,
            data: { reason: 'operator_cancel', agent: agent.name },
            owner_kind: managerInbox.ownerKind,
            owner_id: managerInbox.ownerId,
          });
          await this.db.news.add(teamId, agent.id, {
            timestamp: cancelTs,
            type: 'query.cancelled',
            message: 'Cancelled by operator',
            data: { reason: 'operator_cancel', agent: agent.name },
          });
        }

        try {
          const cancelResp = await fetch(`${baseEndpoint}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });

          if (!cancelResp.ok) {
            const err = await cancelResp.text();
            return { ok: false, error: `Cancel failed: ${err}` };
          }

          const result = await cancelResp.json() as any;
          return { ok: true, result: { agent: agent.name, ...result } };
        } catch (err: any) {
          return { ok: false, error: `Failed to cancel: ${err.message}` };
        }
      }

      case 'clear': {
        // /clear <agent> - Clear agent session
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /clear <agent-name>' };
        }

        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        if (matches.length > 1) {
          return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
        }

        const agent = matches[0];
        const baseEndpoint = agent.endpoint || `http://localhost:${agent.port}`;

        try {
          const clearResp = await fetch(`${baseEndpoint}/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });

          if (!clearResp.ok) {
            const err = await clearResp.text();
            return { ok: false, error: `Clear failed: ${err}` };
          }

          return { ok: true, result: { agent: agent.name, message: 'Session cleared' } };
        } catch (err: any) {
          return { ok: false, error: `Failed to clear session: ${err.message}` };
        }
      }

      case 'list': {
        // /list - Show all pending queries
        const newsItems = await this.db.news.getRecent(teamId, ['query', 'query.pending', 'pending_question'], 50);

        return {
          ok: true,
          result: {
            queries: newsItems.map((r: any) => ({
              id: r.query_id || r.id,
              type: r.type,
              message: r.message,
              timestamp: Number(r.timestamp),
              from: r.data?.from
            }))
          }
        };
      }

      case 'update': {
        // /update <agent> --wallet <address> --name <newname> --runtime <harness> --effort <level>
        const agentName = args[0];
        if (!agentName) {
          return { ok: false, error: 'Usage: /update <agent> [--wallet <address>] [--name <newname>] [--runtime <harness>] [--effort <low|medium|high|xhigh>]' };
        }

        const matches = await this.dbResolveAgents(teamId, agentName);
        if (matches.length === 0) {
          return { ok: false, error: `Agent "${agentName}" not found` };
        }
        if (matches.length > 1) {
          return { ok: false, error: `Multiple agents match "${agentName}". Be more specific.` };
        }
        const agent = matches[0];
        const updates: string[] = [];
        const newMetadata = { ...agent.metadata };
        // Column-level changes (as opposed to metadata) are applied via
        // updateStatus, which also marks a running agent for restart — the
        // harness and its flags are only read when the process is spawned.
        let newRuntime: HarnessType | undefined;
        let restartRequired = false;

        // Parse --wallet, --name, --runtime and --effort flags
        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--wallet' && args[i + 1]) {
            const walletAddr = args[i + 1];
            newMetadata.ows_address = walletAddr;
            updates.push(`wallet → ${walletAddr}`);
            i++;
          } else if (args[i] === '--name' && args[i + 1]) {
            const newName = args[i + 1];
            const nameCheck = validateName(newName, 'agent');
            if (!nameCheck.valid) return { ok: false, error: nameCheck.error };
            await this.db.agents.updateIdentity(agent.id, { name: newName });
            newMetadata.alias = newMetadata.alias || agent.name;
            updates.push(`name → ${newName}`);
            i++;
          } else if (args[i] === '--runtime' && args[i + 1]) {
            const runtime = args[i + 1];
            if (!isHarnessType(runtime)) {
              return { ok: false, error: `Invalid runtime "${runtime}". Valid: ${HARNESS_TYPES.join(', ')}` };
            }
            newRuntime = runtime;
            restartRequired = true;
            updates.push(`runtime → ${runtime}`);
            i++;
          } else if (args[i] === '--effort' && args[i + 1]) {
            const effort = args[i + 1];
            if (!isCodexReasoningEffort(effort)) {
              return { ok: false, error: `Invalid effort "${effort}". Valid: ${CODEX_REASONING_EFFORTS.join(', ')}` };
            }
            newMetadata.effort = effort;
            restartRequired = true;
            updates.push(`effort → ${effort}`);
            i++;
          }
        }

        if (updates.length === 0) {
          return { ok: false, error: 'Nothing to update. Use --wallet <address>, --name <newname>, --runtime <harness>, or --effort <low|medium|high|xhigh>' };
        }

        await this.db.agents.updateMetadata(agent.id, newMetadata);

        // Runtime lives on the agents row, not in metadata. Mark a running
        // agent pending so the next rebuild spawns it under the new harness.
        const willRestart = restartRequired && agent.status === 'running';
        if (newRuntime !== undefined || willRestart) {
          await this.db.agents.updateStatus(
            agent.id,
            willRestart ? 'pending' : agent.status,
            newRuntime !== undefined ? { runtime: newRuntime } : undefined,
          );
        }

        return {
          ok: true,
          result: {
            message: `Updated ${agent.name}: ${updates.join(', ')}`,
            ...(willRestart && { restart: 'Agent marked for restart.' })
          }
        };
      }

      case 'task': {
        const subCmd = args[0]?.toLowerCase() || 'list';

        if (subCmd === 'create') {
          // /task create "<title>" [--name <slug>] [--description "..."] [--team <team>] [--owner <agent>] [--event <schedule-id>]...
          const rawArgs = args.slice(1);
          let title: string | undefined;
          let name: string | undefined;
          let description: string | undefined;
          let teamRef: string | undefined;
          let ownerRef: string | undefined;
          const eventIds: string[] = [];

          for (let i = 0; i < rawArgs.length; i++) {
            const token = rawArgs[i];
            if (token === '--name') { name = rawArgs[++i]; continue; }
            if (token === '--description') { description = rawArgs[++i]; continue; }
            if (token === '--team') { teamRef = rawArgs[++i]; continue; }
            if (token === '--owner') { ownerRef = rawArgs[++i]; continue; }
            if (token === '--event') { eventIds.push(rawArgs[++i]); continue; }
            if (!title) { title = token; continue; }
          }

          if (!title) {
            return { ok: false, error: 'Usage: /task create "<title>" [--name <slug>] [--description "..."] [--team <team>] [--owner <agent>] [--event <schedule-id>]...' };
          }

          // Resolve optional team first (needed for name uniqueness check)
          let taskTeamId: string = teamId;
          if (teamRef) {
            const teamRow = await this.db.teams.getTeamByName(teamRef);
            if (!teamRow) return { ok: false, error: `Team "${teamRef}" not found` };
            taskTeamId = teamRow.id;
          }

          // Generate name from title if not provided
          if (!name) {
            name = normalizeAlias(title);
            // Ensure uniqueness by appending numeric suffix on conflict (scoped to team)
            let candidate = name;
            let suffix = 1;
            while (await this.db.tasks.getByNameForTeam(candidate, taskTeamId)) {
              candidate = `${name}-${suffix++}`;
            }
            name = candidate;
          } else {
            name = normalizeAlias(name);
            if (await this.db.tasks.getByNameForTeam(name, taskTeamId)) {
              return { ok: false, error: `Task name "${name}" already exists in this team` };
            }
          }

          // Resolve optional owner
          let ownerId: string | null = null;
          if (ownerRef) {
            const resolveTeam = taskTeamId || teamId;
            const { agent, error } = await this.resolveSingleAgentForCommand(resolveTeam, ownerRef);
            if (!agent) return { ok: false, error: error || `Agent "${ownerRef}" not found` };
            ownerId = agent.id;
          }

          // Validate event links
          for (const eid of eventIds) {
            const sDef = await this.db.schedules.getDefinition(eid);
            if (!sDef) return { ok: false, error: `Schedule "${eid}" not found` };
            if (sDef.kind !== 'calendar') return { ok: false, error: `Schedule "${eid}" is not a calendar event (kind: ${sDef.kind})` };
          }

          const now = Math.floor(Date.now() / 1000);
          const status = ownerId ? 'doing' : 'todo';
          // Resolve created_by from callerFrom if present
          let createdBy: string | null = null;
          if (callerFrom) {
            const { agent: callerAgent } = await this.resolveSingleAgentForCommand(teamId, callerFrom);
            if (callerAgent) createdBy = callerAgent.id;
          }

          const taskRow: TaskRow = {
            id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            name,
            uuid: crypto.randomUUID(),
            team_id: taskTeamId,
            title,
            description: description || null,
            status,
            created_by: createdBy,
            owner: ownerId,
            created_at: now,
            updated_at: now,
            completed_at: null,
          };

          await this.db.tasks.create(taskRow, eventIds.length > 0 ? eventIds : undefined);

          return {
            ok: true,
            result: {
              task: await this.buildTaskResult(taskRow, teamId),
            },
          };
        }

        if (subCmd === 'list') {
          // /task list [--status todo|doing|done] [--owner <agent>] [--team <team>]
          const rawArgs = args.slice(1);
          let statusFilter: 'todo' | 'doing' | 'done' | undefined;
          let ownerFilter: string | undefined;
          let teamFilter: string | undefined;

          for (let i = 0; i < rawArgs.length; i++) {
            const token = rawArgs[i];
            if (token === '--status') { statusFilter = rawArgs[++i] as any; continue; }
            if (token === '--owner') { ownerFilter = rawArgs[++i]; continue; }
            if (token === '--team') { teamFilter = rawArgs[++i]; continue; }
          }

          // Resolve owner id
          let ownerIdFilter: string | undefined;
          if (ownerFilter) {
            const { agent, error } = await this.resolveSingleAgentForCommand(teamId, ownerFilter);
            if (!agent) return { ok: false, error: error || `Agent "${ownerFilter}" not found` };
            ownerIdFilter = agent.id;
          }

          // Resolve team id — default to current team for scoped resolution
          let teamIdFilter: string = teamId;
          if (teamFilter) {
            const teamRow = await this.db.teams.getTeamByName(teamFilter);
            if (!teamRow) return { ok: false, error: `Team "${teamFilter}" not found` };
            teamIdFilter = teamRow.id;
          }

          const tasks = await this.db.tasks.list({
            status: statusFilter,
            owner: ownerIdFilter,
            teamId: teamIdFilter,
          });

          const results = [];
          for (const t of tasks) {
            results.push(await this.buildTaskResult(t, teamId));
          }

          return { ok: true, result: { tasks: results } };
        }

        if (subCmd === 'assign') {
          // /task assign <task-name> <agent> [--team <team>]
          const taskName = args[1];
          const agentRef = args[2];
          if (!taskName || !agentRef) {
            return { ok: false, error: 'Usage: /task assign <task-name|#shortid> <agent> [--team <team>]' };
          }

          const { task, error: taskErr } = await this.resolveTaskRef(taskName, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${taskName}" not found` };

          // Check for --team flag
          let resolveTeam = teamId;
          for (let i = 3; i < args.length; i++) {
            if (args[i] === '--team' && args[i + 1]) {
              const teamRow = await this.db.teams.getTeamByName(args[i + 1]);
              if (!teamRow) return { ok: false, error: `Team "${args[i + 1]}" not found` };
              resolveTeam = teamRow.id;
              break;
            }
          }

          const { agent, error } = await this.resolveSingleAgentForCommand(resolveTeam, agentRef);
          if (!agent) return { ok: false, error: error || `Agent "${agentRef}" not found` };

          const now = Math.floor(Date.now() / 1000);
          await this.db.tasks.updateFields(task.id, {
            owner: agent.id,
            status: 'doing',
            updated_at: now,
          });

          const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
          return { ok: true, result: { task: await this.buildTaskResult(updated!, teamId) } };
        }

        if (subCmd === 'claim') {
          // /task claim <task-name|#shortid> (agent API via /remote with from field)
          const taskRef = args[1];
          if (!taskRef) {
            return { ok: false, error: 'Usage: /task claim <task-name|#shortid>' };
          }

          if (!callerFrom) {
            return { ok: false, error: 'Claim requires agent identity. Use /remote with a "from" field.' };
          }

          const { task, error: taskErr } = await this.resolveTaskRef(taskRef, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${taskRef}" not found` };

          // Cross-team claim guard
          if (task.team_id && task.team_id !== teamId) {
            return { ok: false, error: `Task "${taskRef}" not found` };
          }

          // Resolve caller agent
          const { agent: callerAgent, error: callerError } = await this.resolveSingleAgentForCommand(teamId, callerFrom);
          if (!callerAgent) return { ok: false, error: callerError || `Caller agent "${callerFrom}" not found` };

          const now = Math.floor(Date.now() / 1000);
          const claimed = await this.db.tasks.claim(task.id, callerAgent.id, now);
          if (!claimed) {
            return { ok: false, error: `Cannot claim "${task.name}" — task is already owned or not in todo status` };
          }

          const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
          return { ok: true, result: { task: await this.buildTaskResult(updated!, teamId) } };
        }

        if (subCmd === 'done') {
          // /task done <task-name|#shortid>
          // Manager can mark any task done; agent can only mark its own task done
          const taskRef = args[1];
          if (!taskRef) {
            return { ok: false, error: 'Usage: /task done <task-name|#shortid>' };
          }

          const { task, error: taskErr } = await this.resolveTaskRef(taskRef, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${taskRef}" not found` };

          // Cross-team done guard
          if (task.team_id && task.team_id !== teamId) {
            return { ok: false, error: `Task "${taskRef}" not found` };
          }

          // If called by an agent (callerFrom set), enforce ownership
          if (callerFrom) {
            const { agent: callerAgent } = await this.resolveSingleAgentForCommand(teamId, callerFrom);
            if (callerAgent && task.owner !== callerAgent.id) {
              return { ok: false, error: `Agent "${callerFrom}" is not the owner of task "${task.name}"` };
            }
          }

          const now = Math.floor(Date.now() / 1000);
          await this.db.tasks.updateFields(task.id, {
            status: 'done',
            completed_at: now,
            updated_at: now,
          });

          const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
          return { ok: true, result: { task: await this.buildTaskResult(updated!, teamId) } };
        }

        if (subCmd === 'status') {
          // /task status <task-name|#shortid> <todo|doing|done>
          // Sets the status field directly. Does not touch `owner` — use
          // /task assign or /task claim to change ownership.
          const taskRef = args[1];
          const newStatus = args[2]?.toLowerCase();
          if (!taskRef || !newStatus) {
            return { ok: false, error: 'Usage: /task status <task-name|#shortid> <todo|doing|done>' };
          }
          if (newStatus !== 'todo' && newStatus !== 'doing' && newStatus !== 'done') {
            return { ok: false, error: `Invalid status "${newStatus}". Must be todo, doing, or done.` };
          }

          const { task, error: taskErr } = await this.resolveTaskRef(taskRef, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${taskRef}" not found` };

          if (task.team_id && task.team_id !== teamId) {
            return { ok: false, error: `Task "${taskRef}" not found` };
          }

          const now = Math.floor(Date.now() / 1000);
          await this.db.tasks.updateFields(task.id, {
            status: newStatus,
            completed_at: newStatus === 'done' ? now : null,
            updated_at: now,
          });

          const updated = await this.db.tasks.getByNameForTeam(task.name, teamId);
          return { ok: true, result: { task: await this.buildTaskResult(updated!, teamId) } };
        }

        if (subCmd === 'remove' || subCmd === 'delete') {
          // /task remove <task-name|#shortid>
          // /task remove *                  → delete all tasks in active team
          // /task remove --team <team>      → delete all tasks in named team
          const first = args[1];
          if (!first) {
            return { ok: false, error: 'Usage: /task remove <task-name|#shortid> | /task remove * | /task remove --team <team>' };
          }

          if (first === '*') {
            const tasks = await this.db.tasks.list({ teamId });
            const removed: string[] = [];
            for (const t of tasks) {
              await this.db.tasks.delete(t.id);
              removed.push(t.name);
            }
            return { ok: true, result: { removed, count: removed.length, scope: 'active-team' } };
          }

          if (first === '--team') {
            const teamRef = args[2];
            if (!teamRef) {
              return { ok: false, error: 'Usage: /task remove --team <team>' };
            }
            const teamRow = await this.db.teams.getTeamByName(teamRef);
            if (!teamRow) return { ok: false, error: `Team "${teamRef}" not found` };
            const tasks = await this.db.tasks.list({ teamId: teamRow.id });
            const removed: string[] = [];
            for (const t of tasks) {
              await this.db.tasks.delete(t.id);
              removed.push(t.name);
            }
            return { ok: true, result: { removed, count: removed.length, team: teamRow.name } };
          }

          const { task, error: taskErr } = await this.resolveTaskRef(first, teamId);
          if (!task) return { ok: false, error: taskErr || `Task "${first}" not found` };

          await this.db.tasks.delete(task.id);
          return { ok: true, result: { removed: task.name } };
        }

        return {
          ok: false,
          error: 'Usage: /task <create|list|assign|claim|done|remove|delete> ...',
        };
      }

      default:
        // §9 (D2): /sync is REMOVED — the diff-driven mutation and the
        // YAML-as-floor merge are deleted, not hidden behind a flag. There is
        // deliberately no handler for it; it falls through to here. But a bare
        // "unknown command" would send operators and agents — who have /sync in
        // muscle memory and in their skill files — hunting for a bug instead of
        // a replacement, so the removal says where the capability went.
        if (action === 'sync') {
          return {
            ok: false,
            error: SYNC_REMOVED_MESSAGE,
          };
        }
        return { ok: false, error: `Unknown command: ${action}. Available: agents, status, schedule, delete, ask, hey, news, deploy, export, import, diff, agent, model, tasks, task, configs, teams, team, keys, meta, pay, heartbeat, heartbeats, cancel, clear, list, update` };
    }
  }

  /**
   * Derive a health status string for a remote-endpoint agent from its DB probe columns.
   */
  private deriveRemoteHealth(a: AgentRow): 'online' | 'unstable' | 'offline' | 'unknown' {
    if (a.last_probed_at == null) return 'unknown';
    if (a.consecutive_failures === 0) return 'online';
    if (a.consecutive_failures <= 2) return 'unstable';
    return 'offline';
  }

  /**
   * Get health info for an agent to include in API responses.
   */
  private getHealthForAgent(a: AgentRow): { health: string; lastHealthCheck: number | null } {
    const key = `${a.team_id}:${a.id}`;
    const h = this.healthStatus.get(key);
    if (!h) return { health: 'unknown', lastHealthCheck: null };
    return { health: h.status, lastHealthCheck: h.lastCheck };
  }

  /**
   * Start periodic health monitoring of all running agents (every 30s).
   * Also starts the remote heartbeat loop in parallel.
   */
  private startHealthMonitor(): void {
    // Run immediately, then every 30 seconds
    this.runHealthChecks();
    this.healthCheckInterval = setInterval(() => this.runHealthChecks(), 30_000);

    // Remote probe loop — same cadence, parallel to local loop
    this.runRemoteHeartbeat();
    this.remoteProbeInterval = setInterval(() => this.runRemoteHeartbeat(), 30_000);
  }

  /**
   * Start the stuck-query sweeper.
   *
   * Agents that crash mid-query never transition their queries out of
   * 'pending'/'processing' (the agent process is the thing that would have
   * written 'completed' or 'failed'). Without this sweeper the queries table
   * accumulates ghosts and callers polling /query/:id see 'pending' forever.
   *
   * We run every 5 minutes and mark any pending/processing query older than
   * QUERY_EXPIRY_MINUTES as 'expired'. See expireStale() for the actual SQL.
   */
  private startQuerySweeper(): void {
    const intervalMs = 5 * 60 * 1000;
    const runSweep = () => {
      this.sweepStaleQueries().catch((err) => {
        console.error('[Manager] Query sweeper failed:', err);
      });
    };
    runSweep();
    this.querySweeperInterval = setInterval(runSweep, intervalMs);
  }

  /**
   * Start the event_log retention sweep.
   *
   * Audit #6 (output/security-review-wakeup-service.md): the design promises
   * a 7-day age cap and 100k-events-per-team count cap on `event_log`.
   * This loop enforces both, default every 5 minutes. Constants and env
   * overrides live in src/wakeup-service/retention.ts.
   */
  private startEventLogRetentionSweep(): void {
    this.retentionService = new RetentionService({ events: this.db.events, teams: this.db.teams });
    this.retentionService.start();
  }

  private async sweepStaleQueries(): Promise<void> {
    const cutoff = Date.now() - this.QUERY_EXPIRY_MINUTES * 60 * 1000;
    const expired = await this.db.queries.expireStale(cutoff, ['pending', 'processing']);
    const count = expired.length;
    if (count > 0) {
      const occurredAt = Date.now();
      for (const row of expired) {
        await emitQueryExpired(this.db.events, {
          teamId: row.team_id,
          queryId: row.query_id,
          agentId: row.agent_id,
          occurredAt,
        }).catch((err) => {
          console.error('[Manager] Failed to emit query:expired event:', err);
        });
      }
      this.managerLog(
        `Expired ${count} stale queries older than ${this.QUERY_EXPIRY_MINUTES} minutes`,
      );
      console.log(
        `[Manager] Query sweeper expired ${count} stale queries (>${this.QUERY_EXPIRY_MINUTES} min old)`,
      );
    }
  }

  /**
   * Local-agent health check loop.
   *
   * IMPORTANT: NEVER probe remote-endpoint agents here.  Remote agents
   * (public-agent-remote runtime) are handled exclusively by runRemoteHeartbeat().
   * Attempting to probe them from this path would hit their public internet
   * endpoint from the wrong loop, double-count failures, and bypass the
   * concurrency cap enforced by runRemoteHeartbeat.
   *
   * The isRemoteEndpointRuntime() guard below is the canonical firewall.
   * It MUST remain the first runtime check inside the per-agent loop body.
   */
  private async runHealthChecks(): Promise<void> {
    try {
      const teams = await this.db.teams.listTeams();
      for (const team of teams) {
        const agents = await this.dbListAgents(team.id, true);
        for (const agent of agents) {
          // Skip virtual agents — they don't have a local /health endpoint
          if (agent.type === 'virtual') continue;
          // GUARD: Skip remote-endpoint agents — handled exclusively by runRemoteHeartbeat().
          // This check must come before any network I/O so remote agents can never
          // be reached from this local-heartbeat path.
          if (isRemoteEndpointRuntime(agent.runtime)) continue;

          const key = this.key(team.id, agent.id);
          const agentUrl = agent.type === 'interactive' ? agent.endpoint : `http://localhost:${agent.port}`;

          if (!agentUrl) {
            this.healthStatus.set(key, { status: 'unknown', lastCheck: Date.now() });
            continue;
          }

          try {
            const resp = await fetch(`${agentUrl}/health`, {
              signal: AbortSignal.timeout(3000)
            });
            const isOnline = resp.ok;
            this.healthStatus.set(key, { status: isOnline ? 'online' : 'offline', lastCheck: Date.now() });

            // Update DB status if it changed
            if (isOnline && agent.status === 'offline') {
              await this.db.agents.updateStatus(agent.id, 'running');
            } else if (!isOnline && agent.status === 'running') {
              await this.db.agents.updateStatus(agent.id, 'offline');
            }
          } catch {
            this.healthStatus.set(key, { status: 'offline', lastCheck: Date.now() });
            if (agent.status === 'running') {
              await this.db.agents.updateStatus(agent.id, 'offline').catch(() => {});
            }
          }
        }
      }
    } catch (err: any) {
      // Don't crash the interval on transient DB errors
    }
  }

  /**
   * Run a single heartbeat probe tick for all remote-endpoint agents.
   * Probes are bounded to 8 concurrent in-flight requests.
   */
  private async runRemoteHeartbeat(): Promise<void> {
    try {
      const teams = await this.db.teams.listTeams();
      const remoteAgents: Array<{ team: { id: string }; agent: AgentRow }> = [];
      for (const team of teams) {
        const agents = await this.dbListAgents(team.id, true);
        for (const agent of agents) {
          if (isRemoteEndpointRuntime(agent.runtime)) {
            remoteAgents.push({ team, agent });
          }
        }
      }

      // Bounded concurrency: chunks of 8
      const CONCURRENCY = 8;
      for (let i = 0; i < remoteAgents.length; i += CONCURRENCY) {
        const chunk = remoteAgents.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(({ team, agent }) =>
          this.probeOneRemoteAgent(team.id, agent).catch(() => {
            // Swallow errors — don't let one failure kill the loop
          }),
        ));
      }
    } catch {
      // Don't crash the interval on transient DB errors
    }
  }

  /**
   * Probe a single remote agent, persist the result, and update healthStatus.
   */
  private async probeOneRemoteAgent(teamId: string, agent: AgentRow): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const result = await probeRemoteAgent(agent, { fetch: this.healthProbeFn });

    if (result.ok) {
      await this.db.agents.updateProbeResult(agent.id, {
        last_seen: result.last_seen,
        last_probed_at: now,
        last_error: result.last_error,
        consecutive_failures: 0,
      });
      const updated = { ...agent, last_seen: result.last_seen, last_probed_at: now, last_error: result.last_error, consecutive_failures: 0 };
      const health = this.deriveRemoteHealth(updated);
      this.healthStatus.set(this.key(teamId, agent.id), { status: health as any, lastCheck: Date.now() });
    } else {
      const newFailures = (agent.consecutive_failures ?? 0) + 1;
      await this.db.agents.updateProbeResult(agent.id, {
        last_probed_at: now,
        last_error: result.last_error,
        consecutive_failures: newFailures,
      });
      const updated = { ...agent, last_probed_at: now, consecutive_failures: newFailures };
      const health = this.deriveRemoteHealth(updated);
      this.healthStatus.set(this.key(teamId, agent.id), { status: health as any, lastCheck: Date.now() });
    }
  }

  async start(port: number = 4100): Promise<void> {
    this.managementPort = port;
    return new Promise((resolve) => {
      // Create HTTP server from Express app
      this.httpServer = createHttpServer(this.managementApp);

      // Create WebSocket server attached to HTTP server
      this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

      this.wss.on('connection', (ws, req) => {
        this.handleWebSocketConnection(ws, req);
      });

      this.httpServer.listen(port, '127.0.0.1', async () => {
        console.log(`\n🚀 ID Agent Manager (DB-backed)`);
        console.log(`===============================`);
        console.log(`Management API: http://localhost:${port}`);
        console.log(`WebSocket: ws://localhost:${port}/ws`);
        console.log(`\n`);

        // Initialize and start the scheduler service
        this.schedulerService = new SchedulerService(this.db, async (agentId: string) => {
          const agent = await this.db.agents.getById(agentId);
          if (!agent || !agent.endpoint) return null;
          const endpoints = await discoverRestAPEndpoints(agent.endpoint);
          return {
            id: agent.id,
            name: agent.name,
            endpoint: agent.endpoint.replace(/\/+$/, ''),
            talkPath: endpoints.talk || '/talk',
            schedulePath: endpoints.schedule || null,
            status: agent.status,
          };
        });
        this.schedulerService.start();

        // Seed well-known teams (idempotent — getOrCreateTeamId is safe to call repeatedly)
        await this.seedWellKnownTeams();

        // #4d78adbc part 3 — surface a containment misconfiguration at BOOT.
        await this.auditAgentWorkdirs();

        // Start periodic health monitoring (every 30s)
        this.startHealthMonitor();

        // Start stuck-query sweeper (every 5 min, expires >15 min old)
        this.startQuerySweeper();

        // Start event_log retention sweep (every 5 min, 7d / 100k-per-team caps)
        this.startEventLogRetentionSweep();

        // Start checkin due-service tick (default 30s) so active checkins
        // actually fire instead of accumulating with `next_fire_at <= now`.
        // Wake on every fire: every priority POSTs to the owner's /news
        // with trigger:true so the dispatcher's LLM is actually woken.
        // Priority is preserved on the payload as metadata (the LLM reads
        // it to decide urgency); it does NOT gate whether the wake fires —
        // an un-woken check-in is operationally identical to no check-in.
        // Loop safety lives in the receiver's /news handler (noAutoReply on
        // triggered queries).
        this.checkinService = new CheckinService(this.db, {
          dispatchWake: async (input) => {
            const owner = await this.db.agents.getById(input.ownerAgentId).catch(() => null);
            if (!owner || !owner.endpoint) return;
            const url = `${owner.endpoint.replace(/\/+$/, '')}/news`;
            // skip_persist:true: CheckinService.writeOwnerNews already wrote
            // the canonical inbox row before this dispatch ran. The wake POST
            // must trigger startQuery on the receiver but must NOT persist a
            // second news_item — otherwise high-priority fires would create
            // duplicate visible inbox entries.
            //
            // Bounded timeout: fireRow awaits dispatchWake and CheckinService
            // serializes ticks, so a hung owner endpoint would stall the
            // entire due-service loop. 5s matches the /news-to forward path.
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'checkin-service',
                trigger: true,
                skip_persist: true,
                type: 'checkin_due',
                message: input.message,
                data: input.data,
              }),
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
              throw new Error(`wake POST ${url} returned ${res.status}`);
            }
          },
        });
        this.checkinService.start();
        console.log('[Manager] CheckinService started (wake on every fire)');

        resolve();
      });
    });
  }

  /**
   * Stop background services and close the HTTP/WS server. Safe to call
   * multiple times. Wired into SIGTERM/SIGINT in start-agent-manager.ts so
   * the manager shuts down cleanly without leaking timers or sockets.
   */
  async shutdown(): Promise<void> {
    // Drop any pending auto-export timer first: a debounced write firing into
    // a half-torn-down manager would read from a closing database.
    this.autoExporter.dispose();
    if (this.checkinService) {
      this.checkinService.stop();
      this.checkinService = null;
    }
    if (this.schedulerService) {
      this.schedulerService.stop();
      this.schedulerService = null;
    }
    if (this.retentionService) {
      this.retentionService.stop();
      this.retentionService = null;
    }
    if (this.querySweeperInterval) {
      clearInterval(this.querySweeperInterval);
      this.querySweeperInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.remoteProbeInterval) {
      clearInterval(this.remoteProbeInterval);
      this.remoteProbeInterval = null;
    }
    if (this.wss) {
      try { this.wss.close(); } catch { /* swallow */ }
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((res) => this.httpServer!.close(() => res()));
      this.httpServer = null;
    }
  }

  private async initSchedules(): Promise<void> {
    // Intentionally left unused. Schedules persist in the DB and should not be reseeded on boot,
    // because reseeding interval schedules would reset their anchor and expiry.
  }

  /**
   * Ensure well-known teams exist: `default` (fallback for unscoped requests)
   * and `public` (public-agent registrations). Created idempotently on every
   * manager start. User-specific project teams are NOT seeded here — deploy
   * them with `/deploy <config>` instead.
   */
  /**
   * Boot-time containment audit (#4d78adbc part 3).
   *
   * The guard added to spawn and deploy is only as correct as its configuration:
   * `agentWorkdirRoots` reads three env vars and a directory that may not exist,
   * so on a host where none are set the permitted set silently narrows. Without
   * this, the first symptom is a 400 on a deploy someone needed to run — the
   * worst possible moment to discover a setting.
   *
   * REPORTS, NEVER REFUSES. These agents predate the rule and are running now;
   * refusing to boot would break a live fleet to enforce a policy about paths
   * that are already on disk. It is also wrapped so an audit failure can never
   * be the reason the manager did not start.
   *
   * Returns the findings so a test can assert on them without scraping stdout.
   */
  async auditAgentWorkdirs(): Promise<Array<{ agent: string; team: string; path: string }>> {
    try {
      const roots = agentWorkdirRoots(this.baseWorkDir);
      const rows: Array<{ name: string; working_directory?: unknown; teamName?: string }> = [];
      for (const team of await this.db.teams.listTeams()) {
        // listAll: a register-created agent has a working directory too.
        for (const agent of await this.db.agents.listAll(team.id)) {
          rows.push({ name: agent.name, working_directory: agent.working_directory, teamName: team.name });
        }
      }

      const findings = auditWorkdirs(rows, roots);
      for (const line of formatWorkdirAudit(findings, roots)) console.warn(line);
      return findings;
    } catch (err) {
      console.warn(`[WorkdirAudit] skipped: ${(err as Error)?.message || String(err)}`);
      return [];
    }
  }

  private async seedWellKnownTeams(): Promise<void> {
    try {
      const seeded: string[] = [];
      for (const name of ['default', 'public']) {
        await this.db.teams.getOrCreateTeamId(name);
        const teamDir = `${this.baseWorkDir}/teams/${name}`;
        if (!existsSync(teamDir)) mkdirSync(teamDir, { recursive: true });
        seeded.push(name);
      }
      console.log(`[Manager] Well-known teams seeded: ${seeded.join(', ')}`);
    } catch (err: any) {
      // Non-fatal: log and continue
      console.warn('[Manager] Failed to seed well-known teams:', err?.message);
    }
  }


  /**
   * Handle a new WebSocket connection
   */
  private async handleWebSocketConnection(ws: WebSocket, req: any) {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const teamHeader = req.headers['x-id-team'] || req.headers['x-id-project'] || url.searchParams.get('team');

    // Resolve team — look up only; do NOT auto-create. A stale client
    // reconnecting with a team name that was deleted must not resurrect it.
    const teamName = teamHeader ? String(teamHeader) : (process.env.ID_TEAM || 'default');
    const teamRow = await this.db.teams.getTeamByName(teamName);
    if (!teamRow) {
      console.log(`[WS] Rejecting connection for unknown team "${teamName}"`);
      try {
        ws.send(JSON.stringify({ type: 'error', error: 'team_not_found', team: teamName }));
      } catch { /* swallow */ }
      ws.close(1008, 'team_not_found');
      return;
    }
    const teamId = teamRow.id;

    const client: WSClient = { ws, teamId, teamName, authenticated: true };
    this.wsClients.add(client);

    console.log(`[WS] Client connected (team: ${teamName})`);

    ws.send(JSON.stringify({
      type: 'connected',
      team: teamName,
      timestamp: Date.now()
    }));

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleWebSocketMessage(client, message);
      } catch (err: any) {
        ws.send(JSON.stringify({ type: 'error', error: err.message }));
      }
    });

    ws.on('close', () => {
      this.wsClients.delete(client);
      console.log(`[WS] Client disconnected (team: ${teamName})`);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error for client (team: ${teamName}):`, err.message);
      this.wsClients.delete(client);
    });
  }

  /**
   * Handle an incoming WebSocket message
   */
  private async handleWebSocketMessage(client: WSClient, message: any) {
    const { type, command, ...rest } = message;

    switch (type) {
      case 'command': {
        // Execute a CLI-style command (reuse /remote logic)
        if (!command || typeof command !== 'string') {
          client.ws.send(JSON.stringify({ type: 'error', error: 'Missing command' }));
          return;
        }
        const result = await this.executeRemoteCommand(command.trim(), client.teamId, client.teamName);
        client.ws.send(JSON.stringify({ type: 'result', command, ...result }));
        break;
      }

      case 'ping': {
        client.ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
      }

      default: {
        client.ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${type}` }));
      }
    }
  }

  /**
   * Broadcast a news item to all connected WebSocket clients for a team
   */
  broadcastNews(teamId: string, newsItem: { type: string; from?: string; message?: string; in_reply_to?: string; data?: any; timestamp: number }) {
    for (const client of this.wsClients) {
      if (client.teamId === teamId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'news',
          newsType: newsItem.type,
          from: newsItem.from,
          message: newsItem.message,
          in_reply_to: newsItem.in_reply_to,
          data: newsItem.data,
          timestamp: newsItem.timestamp
        }));
      }
    }
  }

  /**
   * Notify connected CLIs that the agent registry for a team changed.
   * Lets the CLI clear stale per-name session state and surface a one-line
   * "registry updated" hint without forcing the operator to restart.
   */
  broadcastAgentsChanged(
    teamId: string,
    change: {
      reason: 'sync' | 'deploy' | 'spawn' | 'remove' | 'update';
      added?: string[];
      updated?: string[];
      removed?: string[];
    }
  ) {
    const payload = JSON.stringify({
      type: 'agents_changed',
      teamId,
      change: {
        reason: change.reason,
        added: change.added || [],
        updated: change.updated || [],
        removed: change.removed || [],
      },
      timestamp: Date.now(),
    });
    for (const client of this.wsClients) {
      if (client.teamId === teamId && client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(payload);
        } catch {
          /* drop send errors — closing handler will clean up */
        }
      }
    }
  }

  // ==================== Heartbeat System ====================

  /**
   * Read heartbeat config from agent's working directory.
   * Checks HEARTBEAT.yaml (legacy) first, then HEARTBEAT.md (new model).
   */
  private readHeartbeatConfig(workingDirectory: string): HeartbeatConfig | null {
    // Legacy: HEARTBEAT.yaml with interval + message
    const yamlPath = path.join(workingDirectory, 'HEARTBEAT.yaml');
    if (existsSync(yamlPath)) {
      try {
        const content = readFileSync(yamlPath, 'utf-8');
        const config = yaml.load(content) as { interval?: number; message?: string; maxBeats?: number; expiresAfter?: number };
        if (typeof config?.interval === 'number' && typeof config?.message === 'string') {
          return {
            interval: config.interval,
            message: config.message.trim(),
            ...(typeof config.maxBeats === 'number' && { maxBeats: config.maxBeats }),
            ...(typeof config.expiresAfter === 'number' && { expiresAfter: config.expiresAfter })
          };
        }
      } catch (error: any) {
        console.log(`[Heartbeat] Error reading ${yamlPath}: ${error.message}`);
      }
    }

    // New model: HEARTBEAT.md exists → agent-driven, use generic message
    const mdPath = path.join(workingDirectory, 'HEARTBEAT.md');
    if (existsSync(mdPath)) {
      return {
        interval: 86400,  // default interval for manual enable; overridden by config
        message: HEARTBEAT_GENERIC_MESSAGE,
      };
    }

    return null;
  }


  /**
   * Cancel all pending/processing queries for an agent when it stops.
   * This prevents orphaned queries from showing up in status.
   */
  async cancelPendingQueriesForAgent(teamId: string, agentId: string): Promise<number> {
    try {
      const ts = Date.now();

      // Cancel all pending/processing queries and get their IDs
      const queryIds = await this.db.queries.cancel(agentId, ts);

      if (queryIds.length === 0) {
        return 0;
      }

      // Add query.cancelled news items for each, and wake any long-poll waiters.
      for (const queryId of queryIds) {
        await this.db.news.add(teamId, agentId, {
          timestamp: ts,
          type: 'query.cancelled',
          message: 'Query cancelled (agent stopped)',
          data: { reason: 'agent_stopped', query_id: queryId },
          query_id: queryId,
        });
        this.notifyQueryStatusWaiters(teamId, queryId);
      }

      console.log(`[Manager] Cancelled ${queryIds.length} pending queries for agent ${agentId}`);
      return queryIds.length;
    } catch (err) {
      console.error(`[Manager] Error cancelling queries for agent ${agentId}:`, err);
      return 0;
    }
  }

  // -- long-poll helpers for GET /query/:id?wait= ---------------------------

  private addQueryStatusWaiter(teamId: string, queryId: string, fn: () => void): void {
    const key = `${teamId}:${queryId}`;
    let set = this.queryStatusWaiters.get(key);
    if (!set) {
      set = new Set();
      this.queryStatusWaiters.set(key, set);
    }
    set.add(fn);
  }

  private removeQueryStatusWaiter(teamId: string, queryId: string, fn: () => void): void {
    const key = `${teamId}:${queryId}`;
    const set = this.queryStatusWaiters.get(key);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this.queryStatusWaiters.delete(key);
  }

  private notifyQueryStatusWaiters(teamId: string, queryId: string): void {
    const key = `${teamId}:${queryId}`;
    const set = this.queryStatusWaiters.get(key);
    if (!set) return;
    const waiters = Array.from(set);
    this.queryStatusWaiters.delete(key);
    for (const fn of waiters) {
      try { fn(); } catch { /* non-fatal */ }
    }
  }

  /**
   * Wallet opt-in: produce the metadata that should be persisted for an
   * agent based on its config. Honors `walletOptIn === true` by calling
   * `getOrCreateAgentWallet` once and merging the resulting wallet name
   * and address into the metadata. Honors `walletOptIn === false` by
   * recording the explicit opt-out flag without calling the OWS CLI.
   * `walletOptIn === undefined` leaves the metadata untouched, preserving
   * legacy behaviour for configs that pre-date the flag.
   *
   * Returns the (possibly updated) metadata and the provisioned wallet
   * descriptor (or null) so callers that need to know about the wallet
   * (e.g. `deploySkillsToAgent`'s `hasWallet` flag) can branch on it.
   */
  private resolveWalletMetadata(
    teamName: string,
    agentName: string,
    metadata: AgentMetadata,
    walletOptIn: boolean | undefined,
  ): { metadata: AgentMetadata; wallet: { walletName: string; address: string } | null } {
    const nextMetadata = this.withWalletConfigMetadata(metadata, walletOptIn);
    if (walletOptIn !== true) {
      return { metadata: nextMetadata, wallet: null };
    }

    const wallet = this.getOrCreateAgentWallet(teamName, agentName);
    if (!wallet) {
      return { metadata: nextMetadata, wallet: null };
    }

    return {
      metadata: {
        ...nextMetadata,
        ows_wallet: wallet.walletName,
        ows_address: wallet.address,
      },
      wallet,
    };
  }

  private isWalletProvisioningEnabled(metadata: unknown): boolean {
    return (metadata as Record<string, unknown> | null | undefined)?.wallet === true;
  }

  private withoutProvisionedWalletMetadata(metadata: AgentMetadata): AgentMetadata {
    const next = { ...metadata };
    delete next.ows_wallet;
    delete next.ows_address;
    return next;
  }

  private withWalletConfigMetadata(metadata: AgentMetadata, walletOptIn: boolean | undefined): AgentMetadata {
    const next = this.withoutProvisionedWalletMetadata(metadata);
    if (walletOptIn !== undefined) {
      next.wallet = walletOptIn;
    } else {
      delete next.wallet;
    }
    return next;
  }

  /**
   * Wallet opt-in: provision (or reuse) an OWS wallet for an existing
   * agent row, persist `wallet: true` plus the wallet identifiers on the
   * row's metadata, and return the refreshed row. Returns `null` if OWS
   * is not installed or wallet creation fails. Used by manager-join and the
   * on-demand `/agent <name> wallet provision` command.
   */
  private async provisionAgentWalletForRow(
    teamId: string,
    walletTeam: string,
    agent: AgentRow,
  ): Promise<AgentRow | null> {
    const meta = (agent.metadata || {}) as Record<string, any>;
    if (meta.ows_wallet) return agent;
    const walletAlias = meta.alias || agent.name;
    const provisioned = this.getOrCreateAgentWallet(walletTeam, walletAlias);
    if (!provisioned) return null;

    const mergedMeta: AgentMetadata = {
      ...((agent.metadata || {}) as AgentMetadata),
      wallet: true,
      ows_wallet: provisioned.walletName,
      ows_address: provisioned.address,
    };
    await this.db.agents.updateMetadata(agent.id, mergedMeta);
    return this.dbQueryAgentById(teamId, agent.id);
  }

  /**
   * Check if the OWS (Open Wallet Standard) CLI is installed and on PATH.
   */
  private checkOwsInstalled(): boolean {
    try {
      execFileSync('ows', ['--version'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get or create an OWS wallet for an agent.
   * Returns { walletName, address } or null if OWS is not installed or creation fails.
   */
  private getOrCreateAgentWallet(team: string, agentName: string): { walletName: string; address: string } | null {
    if (!this.checkOwsInstalled()) return null;
    const walletName = `${team}-${agentName}`;
    try {
      // Check if wallet exists by parsing `ows wallet list` output
      const listOutput = execFileSync('ows', ['wallet', 'list'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      let found = false;
      let ethAddress = '';
      let inWallet = false;
      for (const line of listOutput.split('\n')) {
        if (line.includes('Name:') && line.includes(walletName)) {
          inWallet = true;
          found = true;
          continue;
        }
        if (inWallet && line.includes('Name:')) break;
        if (inWallet) {
          const match = line.trim().match(/^eip155:1\s.*→\s*(0x[0-9a-fA-F]+)/);
          if (match) ethAddress = match[1];
        }
      }
      if (found && ethAddress) {
        console.log(`[OWS] Found existing wallet "${walletName}": ${ethAddress}`);
        return { walletName, address: ethAddress };
      }
    } catch {
      // ows wallet list failed, try creating
    }
    try {
      const output = execFileSync('ows', ['wallet', 'create', '--name', walletName], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      // Parse EVM address from create output
      for (const line of output.split('\n')) {
        const match = line.trim().match(/eip155:1\s.*→\s*(0x[0-9a-fA-F]+)/);
        if (match) {
          console.log(`[OWS] Created wallet "${walletName}": ${match[1]}`);
          return { walletName, address: match[1] };
        }
      }
      console.log(`[OWS] Created wallet "${walletName}" (no EVM address found in output)`);
      return { walletName, address: '' };
    } catch (err: any) {
      console.warn(`[OWS] Failed to create wallet "${walletName}": ${err.message}`);
      return null;
    }
  }

  private buildLocalAgentEnv(
    teamName: string,
    port: number,
    agentRow: AgentRow | null,
    model?: string,
    tokenId?: string,
  ): Record<string, string> {
    const owsWallet = (agentRow?.metadata as any)?.ows_wallet || null;
    const skipPermsRaw = (agentRow?.metadata as any)?.dangerouslySkipPermissions;
    const skipPermissions = skipPermsRaw === false ? false : true;
    const catalogSeed = (agentRow?.metadata as any)?.catalog;
    const effort = (agentRow?.metadata as any)?.effort;
    const catalogEnv = catalogSeed && typeof catalogSeed === 'object'
      ? Buffer.from(JSON.stringify(catalogSeed), 'utf8').toString('base64')
      : undefined;

    return {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      SHELL: process.env.SHELL || '',
      TMPDIR: process.env.TMPDIR || '',
      USER: process.env.USER || '',
      LANG: process.env.LANG || '',
      TERM: process.env.TERM || 'xterm-256color',
      ...(process.env.NVM_DIR && { NVM_DIR: process.env.NVM_DIR }),
      ...(process.env.XDG_CONFIG_HOME && { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }),
      ...filterClaudeEnvVars(process.env),
      ...(agentRow?.runtime && { ID_HARNESS: resolveRuntime(agentRow.runtime) }),
      ID_TEAM: teamName,
      ID_AGENT_PORT: String(port),
      MANAGER_URL: `http://127.0.0.1:4100`,
      ID_AGENT_SKIP_PERMISSIONS: skipPermissions ? 'true' : 'false',
      ...(model && { CLAUDE_MODEL: resolveModelAlias(model) }),
      ...(typeof effort === 'string' && { ID_AGENT_EFFORT: effort }),
      ...(tokenId && { ID_AGENT_TOKEN_ID: tokenId }),
      ...(owsWallet && { OWS_WALLET: owsWallet }),
      ...(catalogEnv && { ID_AGENT_CATALOG: catalogEnv }),
      ...(process.env.ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
      ...(process.env.OPENAI_API_KEY && { OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
    };
  }

  /**
   * Deploy skill files from skills/ templates to an agent's .claude/skills/ folder.
   * Reads skill.md from each skill directory, substitutes {{VAR}} placeholders,
   * and writes to the agent's working directory.
   */
  /**
   * Deploy skill files from skills/ templates to an agent's .claude/skills/ folder.
   * Uses standard Claude Code skill format: .claude/skills/<name>/SKILL.md
   *
   * Skills are specified in the YAML config (defaults.skills + per-agent skills).
   * Plugins can also bundle skills in their own skills/ subdirectory.
   * Substitutes {{VAR}} placeholders with deploy-time values.
   */
  private deploySkillsToAgent(
    workDir: string,
    skillNames: string[],
    vars: Record<string, string>,
    opts: { hasWallet?: boolean; runtime?: HarnessType | string } = {}
  ): void {
    if (skillNames.length === 0) return;
    try {
      const skillsSource = path.resolve(__dirname, '..', 'skills');
      if (!existsSync(skillsSource)) return;

      const rp = getRuntimePaths(opts.runtime);
      let deployed = 0;

      for (const skillName of skillNames) {
        const skillFile = path.join(skillsSource, skillName, 'SKILL.md');
        if (!existsSync(skillFile)) {
          console.warn(`[Deploy] Skill "${skillName}" not found at ${skillFile}`);
          continue;
        }

        // Skip wallet skill if agent has no wallet
        if (skillName === 'wallet' && !opts.hasWallet) continue;

        let content = readFileSync(skillFile, 'utf8');

        // Substitute {{VAR}} placeholders
        for (const [key, value] of Object.entries(vars)) {
          content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
        }

        // Write to runtime-aware skills directory
        const targetSkillDir = path.join(workDir, rp.skillsDir, skillName);
        if (!existsSync(targetSkillDir)) mkdirSync(targetSkillDir, { recursive: true });
        writeFileSync(path.join(targetSkillDir, 'SKILL.md'), content);
        deployed++;
      }

      if (deployed > 0) {
        console.log(`[Deploy] Copied ${deployed} skills to ${path.basename(workDir)}/${rp.skillsDir}/`);
      }
    } catch (err: any) {
      console.warn(`[Deploy] Could not deploy skills: ${err.message}`);
    }
  }

  /**
   * Spawn a local agent process on the server.
   * Used by executeRemoteCommand to start agents server-side.
   */
  private async spawnLocalAgentProcess(
    teamId: string,
    teamName: string,
    agentData: { name: string; id: string; port: number; model?: string; workingDirectory?: string; tokenId?: string; address?: string }
  ): Promise<{ success: boolean; pid?: number; logFile?: string; error?: string }> {
    try {
      const scriptPath = path.resolve(__dirname, 'local-agent-server.js');
      const { name, id, port, model, workingDirectory, tokenId, address } = agentData;

      // Kill any existing process on this port
      await this.killAgentProcess(port);
      await new Promise(r => setTimeout(r, 500));

      // Build command arguments
      const spawnArgs = [
        scriptPath,
        name,
        '--team', teamName,
        '--port', String(port),
        '--id', id
      ];
      if (workingDirectory) {
        spawnArgs.push('--dir', workingDirectory);
      }

      // Set environment
      // Look up OWS wallet name and permissions flag from agent metadata
      const agentRow = await this.dbQueryAgentById(teamId, id);
      const localEnv = this.buildLocalAgentEnv(teamName, port, agentRow, model, tokenId);

      // Create log file
      const logFile = `/tmp/${name}.log`;
      const logFd = openSync(logFile, 'a');

      console.log(`[Manager] Spawning agent process: ${name} (port ${port}, id ${id})`);

      const proc = spawn('node', spawnArgs, {
        env: localEnv,
        stdio: ['ignore', logFd, logFd],
        detached: true
      });

      proc.unref();
      closeSync(logFd);

      console.log(`[Manager] Agent ${name} spawned with PID ${proc.pid}`);

      // Persist pid into agent metadata so /agents responses can carry it.
      // The TUI uses this to resolve per-agent RSS via a batched `ps` call.
      if (proc.pid) {
        try {
          const cur = (agentRow?.metadata as Record<string, unknown>) || {};
          await this.db.agents.updateMetadata(id, { ...cur, pid: proc.pid });
        } catch (metaErr: any) {
          console.warn(`[Manager] Failed to persist pid for ${name}: ${metaErr?.message || metaErr}`);
        }
      }

      return { success: true, pid: proc.pid, logFile };
    } catch (err: any) {
      console.error(`[Manager] Failed to spawn agent ${agentData.name}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  private listPidsListeningOnPort(port: number): number[] {
    try {
      const lsofOutput = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (!lsofOutput) return [];
      return lsofOutput
        .split('\n')
        .filter(Boolean)
        .map(value => parseInt(value, 10))
        .filter(pid => Number.isInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }

  private inspectProcess(pid: number): ProcessInspection | null {
    try {
      const output = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (!output) return null;

      const match = output.match(/^\s*(\d+)\s+(.*)$/s);
      if (!match) return null;

      const ppid = parseInt(match[1], 10);
      const commandLine = match[2].trim();
      const argv0 = tokenizeCommand(commandLine)[0] || '';
      return {
        pid,
        ppid: Number.isInteger(ppid) ? ppid : null,
        argv0,
        commandLine,
      };
    } catch {
      return null;
    }
  }

  private getManagerProcessSignatures(): string[] {
    const signatures = new Set<string>(['start-agent-manager.js', 'start-agent-manager.ts']);
    const currentEntry = process.argv[1] ? path.basename(process.argv[1]).toLowerCase() : '';
    if (currentEntry && currentEntry !== 'node' && currentEntry !== 'tsx') {
      signatures.add(currentEntry);
    }
    return [...signatures];
  }

  private matchesManagerProcessSignature(info: ProcessInspection | null): boolean {
    if (!info) return false;
    const argv0 = path.basename(info.argv0 || '').toLowerCase();
    const commandLine = info.commandLine.toLowerCase();
    return this.getManagerProcessSignatures().some(signature =>
      argv0 === signature || commandLine.includes(signature)
    );
  }

  private isManagerProcess(pid: number): boolean {
    if (pid === process.pid) return true;
    return this.matchesManagerProcessSignature(this.inspectProcess(pid));
  }

  /**
   * Kill the agent process running on a given port.
   */
  private async killAgentProcess(port: number): Promise<{ killed: boolean; pids: number[] }> {
    if (!port) return { killed: false, pids: [] };
    const candidatePids = this.listPidsListeningOnPort(port);
    if (candidatePids.length === 0) return { killed: false, pids: [] };

    const killedPids: number[] = [];
    for (const pid of candidatePids) {
      if (this.isManagerProcess(pid)) {
        console.warn(`[Manager] Skipping manager PID ${pid} on port ${port}`);
        continue;
      }

      try {
        process.kill(pid, 'SIGTERM');
        killedPids.push(pid);
        console.log(`[Manager] Killed process PID ${pid} on port ${port}`);
      } catch {
        // Process may have already exited
      }
    }
    return { killed: killedPids.length > 0, pids: killedPids };
  }

}
