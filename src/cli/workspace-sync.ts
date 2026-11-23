// SPDX-License-Identifier: MIT

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AgentSpec } from '../config-parser.js';
import {
  parseTeamConfig,
  resolveConfigLibraryRoot,
} from '../config-parser.js';
import { enumerateLibraryAgents, type LibraryAgentEntry } from '../lib/agent-library.js';
import { resolveRuntime } from '../runtime/registry.js';

const RECEIPT_VERSION = 1;
const SKIPPED_SOURCE_BASENAMES = new Set(['README.md', 'LICENSE']);

export interface SyncReceiptEntry {
  sha256: string;
  source: string;
}

export interface SyncReceipt {
  version: number;
  lastDeployedAt: string;
  files: Record<string, SyncReceiptEntry>;
}

export interface SyncFileResult {
  path: string;
  case: 1 | 2 | 3 | 4;
}

export interface SyncWorkspaceResult {
  workspacePath: string;
  receiptPath: string;
  files: SyncFileResult[];
  warnings: string[];
  counts: {
    wroteMissing: number;
    matchedSource: number;
    overwroteManaged: number;
    drifted: number;
  };
}

export interface SyncWorkspaceOptions {
  configPath: string;
  libraryRoot?: string;
  workspacePath?: string;
}

type RuntimeClass = 'claude' | 'codex' | 'cursor';

function sha256Hex(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function toPortableRelativePath(p: string): string {
  return p.split(path.sep).join('/');
}

function expandHomeDir(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Classify an AgentSpec runtime into the coarse target-mapping families used
 * by slice-5 remap rules. Unknown or remote-endpoint runtimes return null.
 */
function classifyRuntime(runtime: AgentSpec['runtime']): RuntimeClass | null {
  const resolved = resolveRuntime(runtime);
  if (resolved === 'claude-agent-sdk' || resolved === 'claude-code-cli' || resolved === 'claude-code-local') {
    return 'claude';
  }
  if (resolved === 'codex' || resolved === 'antigravity-cli') return 'codex';
  if (resolved === 'cursor-cli') return 'cursor';
  return null;
}

function loadReceipt(receiptPath: string): SyncReceipt {
  if (!fs.existsSync(receiptPath)) {
    return { version: RECEIPT_VERSION, lastDeployedAt: '', files: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf-8')) as Partial<SyncReceipt>;
  return {
    version: typeof parsed.version === 'number' ? parsed.version : RECEIPT_VERSION,
    lastDeployedAt: typeof parsed.lastDeployedAt === 'string' ? parsed.lastDeployedAt : '',
    files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
  };
}

function writeReceiptAtomic(receiptPath: string, receipt: SyncReceipt): void {
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const tempPath = `${receiptPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.renameSync(tempPath, receiptPath);
}

interface SourceFile {
  absolutePath: string;
  /**
   * Canonical relative path as if the library entry were always claude-native.
   *
   * - claude-native:    walked directly from dirPath; CLAUDE.md appears at 'CLAUDE.md'.
   * - agents-md-native: walked from dirPath (which does not contain CLAUDE.md) AND the
   *                     sibling `<name>.md` is injected with a virtual relativePath of
   *                     'CLAUDE.md' so the rest of the pipeline is shape-agnostic.
   */
  relativePath: string;
}

function walkDirectory(rootDir: string): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (currentDir: string, prefix: string): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;

      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (SKIPPED_SOURCE_BASENAMES.has(entry.name)) continue;

      files.push({ absolutePath, relativePath: toPortableRelativePath(relativePath) });
    }
  };

  walk(rootDir, '');
  return files;
}

/**
 * Produce the canonical source-file list for a library entry. For both
 * native shapes the caller gets a list rooted at a claude-native layout:
 * `CLAUDE.md` at the top, plus optional `skills/`, `agents/`, `commands/`,
 * `rules/`, `hooks/`, `settings.json`, and arbitrary nested files.
 */
function listSourceFilesForEntry(entry: LibraryAgentEntry): SourceFile[] {
  const files = walkDirectory(entry.dirPath);
  if (entry.shape === 'agents-md-native') {
    // Inject the sibling persona file as the canonical CLAUDE.md.
    files.push({ absolutePath: entry.memoryFile, relativePath: 'CLAUDE.md' });
  }
  // Stable ordering for determinism.
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

/**
 * Remap a canonical source-file relative path into the workspace-relative
 * target path for a given runtime. Returns null when the source should be
 * skipped for that runtime (e.g. Cursor dropping `skills/`).
 *
 * Mapping table (slice 5):
 *
 *   source               claude              codex                cursor
 *   -------------------- ------------------- -------------------- -------------------
 *   CLAUDE.md (root)     .claude/CLAUDE.md   AGENTS.md            AGENTS.md
 *   skills/<x>/...       .claude/skills/...  .agents/skills/...   (skip)
 *   agents/...           .claude/agents/...  (skip)               (skip)
 *   commands/...         .claude/commands/...(skip)               (skip)
 *   rules/<x>.md         .claude/rules/...   (skip)               .cursor/rules/<x>.mdc
 *   rules/... (non-.md)  .claude/rules/...   (skip)               (skip)
 *   hooks/...            .claude/hooks/...   (skip)               (skip)
 *   settings.json (root) .claude/settings.j  (skip)               (skip)
 *   anything else        .claude/<src>       (skip)               (skip)
 *
 * Claude-runtime sidecar rewrite for CLAUDE.md is applied later by the
 * caller, not here; this function only computes the primary target.
 */
function remapTarget(sourceRelativePath: string, runtime: RuntimeClass): string | null {
  const parts = sourceRelativePath.split('/');
  const first = parts[0];

  // Root persona file.
  if (parts.length === 1 && first === 'CLAUDE.md') {
    return runtime === 'claude' ? '.claude/CLAUDE.md' : 'AGENTS.md';
  }

  if (first === 'skills') {
    if (runtime === 'claude') return `.claude/${sourceRelativePath}`;
    if (runtime === 'codex') return `.agents/${sourceRelativePath}`;
    return null; // cursor skips skills
  }

  if (first === 'rules') {
    if (runtime === 'claude') return `.claude/${sourceRelativePath}`;
    if (runtime === 'cursor') {
      // Extension rename only, structure preserved. Non-.md files are skipped.
      if (!parts[parts.length - 1].endsWith('.md')) return null;
      const withoutMd = sourceRelativePath.slice(0, -'.md'.length);
      return `.cursor/${withoutMd}.mdc`;
    }
    return null; // codex skips rules
  }

  if (first === 'agents' || first === 'commands' || first === 'hooks') {
    if (runtime === 'claude') return `.claude/${sourceRelativePath}`;
    return null;
  }

  if (parts.length === 1 && first === 'settings.json') {
    return runtime === 'claude' ? '.claude/settings.json' : null;
  }

  // Passthrough for any other file: claude keeps it, codex/cursor drop it.
  return runtime === 'claude' ? `.claude/${sourceRelativePath}` : null;
}

function resolveSingleAgent(configPath: string): AgentSpec {
  const config = parseTeamConfig(configPath);
  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error(`No agents defined in config: ${configPath}`);
  }
  if (config.agents.length !== 1) {
    throw new Error(`Workspace sync currently supports exactly one agent per config: ${configPath}`);
  }

  const agent = config.agents[0];
  if (!agent.agent) {
    throw new Error(`Agent "${agent.name}" is missing required agent: field`);
  }
  if (!agent.workingDirectory) {
    throw new Error(`Agent "${agent.name}" is missing required workingDirectory`);
  }
  if (classifyRuntime(agent.runtime) === null) {
    throw new Error(
      `Agent "${agent.name}" uses unsupported runtime for workspace sync: ${agent.runtime || 'default'}`,
    );
  }

  return agent;
}

export function syncWorkspaceFromConfig(options: SyncWorkspaceOptions): SyncWorkspaceResult {
  const configPath = path.resolve(options.configPath);
  const agent = resolveSingleAgent(configPath);
  const runtime = classifyRuntime(agent.runtime);
  if (runtime === null) {
    throw new Error(`Unsupported runtime for workspace sync: ${agent.runtime || 'default'}`);
  }
  const libraryRoot = path.resolve(options.libraryRoot || resolveConfigLibraryRoot(configPath));
  const workspacePath = path.resolve(expandHomeDir(options.workspacePath || agent.workingDirectory!));

  const scan = enumerateLibraryAgents(path.join(libraryRoot, 'agents'));
  if (scan.errors.length > 0) {
    throw new Error(scan.errors.map(error => error.message).join('; '));
  }

  const sourceEntry = scan.entries.find(entry => entry.name === agent.agent);
  if (!sourceEntry) {
    throw new Error(`Agent library entry not found: ${agent.agent}`);
  }

  fs.mkdirSync(workspacePath, { recursive: true });

  const receiptPath = path.join(workspacePath, '.id-agents', 'receipt.json');
  const previousReceipt = loadReceipt(receiptPath);

  // Refusal rule for Codex/Cursor: if the workspace already has an AGENTS.md
  // we never wrote, we must not silently sidecar or overwrite. Fail the sync
  // with zero writes and a clear recovery path.
  if (runtime === 'codex' || runtime === 'cursor') {
    const agentsMdPath = path.join(workspacePath, 'AGENTS.md');
    if (fs.existsSync(agentsMdPath) && !previousReceipt.files['AGENTS.md']) {
      throw new Error(
        `Refusing to sync: workspace already has an AGENTS.md that is not tracked in the id-agents receipt. ` +
        `Remove ${agentsMdPath} and re-run sync, or manually merge the library persona into it and re-run ` +
        `once the workspace is quiescent.`,
      );
    }
  }

  const nextReceipt: SyncReceipt = {
    version: RECEIPT_VERSION,
    lastDeployedAt: new Date().toISOString(),
    files: { ...previousReceipt.files },
  };

  const results: SyncFileResult[] = [];
  const warnings: string[] = [];
  const counts = {
    wroteMissing: 0,
    matchedSource: 0,
    overwroteManaged: 0,
    drifted: 0,
  };

  // Pre-pass (Claude runtime only): decide whether to route the library's
  // root CLAUDE.md into the persona sidecar at .claude/rules/agent-<name>.md.
  // Sidecar fires only when a user-authored root CLAUDE.md is in the way
  // (file exists, no receipt entry for it, AND bytes differ from the source).
  // Every other state stays on the primary path so the main-loop 4-case
  // engine keeps slice-3/4 semantics.
  const claudePrimaryKey = toPortableRelativePath(path.join('.claude', 'CLAUDE.md'));
  const claudePrimaryPath = path.join(workspacePath, '.claude', 'CLAUDE.md');
  const claudeSidecarKey = toPortableRelativePath(path.join('.claude', 'rules', `agent-${agent.agent}.md`));

  let useClaudeSidecar = false;
  if (
    runtime === 'claude' &&
    fs.existsSync(claudePrimaryPath) &&
    !previousReceipt.files[claudePrimaryKey]
  ) {
    const personaSourcePath =
      sourceEntry.shape === 'claude-native'
        ? path.join(sourceEntry.dirPath, 'CLAUDE.md')
        : sourceEntry.memoryFile;
    const sourceSha = sha256Hex(fs.readFileSync(personaSourcePath));
    const diskSha = sha256Hex(fs.readFileSync(claudePrimaryPath));
    useClaudeSidecar = diskSha !== sourceSha;
  }

  for (const sourceFile of listSourceFilesForEntry(sourceEntry)) {
    const primaryTargetRel = remapTarget(sourceFile.relativePath, runtime);
    if (primaryTargetRel === null) continue; // silently skipped per runtime

    const isRootPersona = sourceFile.relativePath === 'CLAUDE.md';
    const routedToSidecar = runtime === 'claude' && isRootPersona && useClaudeSidecar;
    const relativeTargetPath = routedToSidecar ? claudeSidecarKey : primaryTargetRel;
    const targetPath = path.join(workspacePath, relativeTargetPath);

    const sourceBytes = fs.readFileSync(sourceFile.absolutePath);
    const sourceSha = sha256Hex(sourceBytes);
    const receiptEntry = previousReceipt.files[relativeTargetPath];

    if (!fs.existsSync(targetPath)) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, sourceBytes);
      nextReceipt.files[relativeTargetPath] = {
        sha256: sourceSha,
        source: `agent:${agent.agent}`,
      };
      results.push({ path: relativeTargetPath, case: 1 });
      counts.wroteMissing += 1;
      continue;
    }

    const targetBytes = fs.readFileSync(targetPath);
    const targetSha = sha256Hex(targetBytes);

    if (targetSha === sourceSha) {
      nextReceipt.files[relativeTargetPath] = {
        sha256: sourceSha,
        source: `agent:${agent.agent}`,
      };
      results.push({ path: relativeTargetPath, case: 2 });
      counts.matchedSource += 1;
      continue;
    }

    if (receiptEntry && targetSha === receiptEntry.sha256) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, sourceBytes);
      nextReceipt.files[relativeTargetPath] = {
        sha256: sourceSha,
        source: `agent:${agent.agent}`,
      };
      results.push({ path: relativeTargetPath, case: 3 });
      counts.overwroteManaged += 1;
      continue;
    }

    warnings.push(`Skipped drifted file: ${relativeTargetPath}`);
    if (receiptEntry) {
      nextReceipt.files[relativeTargetPath] = receiptEntry;
    }
    results.push({ path: relativeTargetPath, case: 4 });
    counts.drifted += 1;
  }

  writeReceiptAtomic(receiptPath, nextReceipt);

  return {
    workspacePath,
    receiptPath,
    files: results,
    warnings,
    counts,
  };
}

function parseSyncArgs(args: string[]): SyncWorkspaceOptions {
  if (args.length === 0) {
    throw new Error('Usage: id-agents sync <config> [--library-root <path>] [--workspace <path>]');
  }

  const options: SyncWorkspaceOptions = { configPath: args[0] };

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--library-root') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --library-root');
      options.libraryRoot = value;
      i += 1;
      continue;
    }
    if (arg === '--workspace') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --workspace');
      options.workspacePath = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export async function maybeRunWorkspaceSyncCli(argv: string[]): Promise<number | null> {
  if (argv[0] !== 'sync') {
    return null;
  }

  try {
    const result = syncWorkspaceFromConfig(parseSyncArgs(argv.slice(1)));
    const total = result.files.length;
    console.log(`Synced ${total} files into ${result.workspacePath}`);
    console.log(
      `Case1=${result.counts.wroteMissing} ` +
      `Case2=${result.counts.matchedSource} ` +
      `Case3=${result.counts.overwroteManaged} ` +
      `Case4=${result.counts.drifted}`
    );
    console.log(`Receipt: ${result.receiptPath}`);
    for (const warning of result.warnings) {
      console.warn(`WARN ${warning}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}

/* -------------------------------------------------------------------------- */
/*  Slice 6: undeploy (`id-agents unsync <config>`)                            */
/* -------------------------------------------------------------------------- */

export interface UnsyncWorkspaceOptions {
  configPath: string;
  workspacePath?: string;
}

export type UnsyncOutcome = 'deleted' | 'preserved' | 'missing';

export interface UnsyncFileResult {
  path: string;
  outcome: UnsyncOutcome;
}

export interface UnsyncWorkspaceResult {
  workspacePath: string;
  receiptPath: string;
  files: UnsyncFileResult[];
  warnings: string[];
  counts: {
    deleted: number;
    preserved: number;
    missing: number;
  };
}

/**
 * Resolve the workspace path from a config file, allowing an explicit
 * override. Only the first agent's workingDirectory is consulted.
 *
 * Unlike sync, undeploy does not require a valid runtime or library entry
 * because the operation is driven entirely by the receipt on disk.
 */
function resolveUnsyncWorkspacePath(configPath: string, override?: string): string {
  if (override) return path.resolve(expandHomeDir(override));

  const config = parseTeamConfig(configPath);
  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error(`No agents defined in config: ${configPath}`);
  }
  const agent = config.agents[0];
  if (!agent.workingDirectory) {
    throw new Error(`Agent "${agent.name}" is missing required workingDirectory`);
  }
  return path.resolve(expandHomeDir(agent.workingDirectory));
}

/**
 * Walk each parent directory from the given set upward toward the workspace
 * root, calling `rmdirSync` at each level. Stops at the workspace root or the
 * first non-empty directory. Directories are processed deepest-first so that
 * nested cleanup is possible in a single pass.
 */
function cleanupEmptyParents(workspaceRoot: string, touchedDirs: Set<string>): void {
  const sorted = [...touchedDirs].sort((a, b) => b.length - a.length);
  const rootPrefix = workspaceRoot + path.sep;
  for (const dir of sorted) {
    let current = dir;
    while (current !== workspaceRoot && current.startsWith(rootPrefix)) {
      try {
        fs.rmdirSync(current);
      } catch {
        break; // not empty or inaccessible — stop climbing this branch
      }
      current = path.dirname(current);
    }
  }
}

/**
 * Undeploy an agent library overlay from a workspace using the sync receipt
 * as the sole source of ownership truth.
 *
 * For each receipt entry:
 *   - file missing from disk        → drop the claim (no-op, `missing`)
 *   - disk SHA matches receipt SHA  → delete the file (`deleted`)
 *   - disk SHA differs              → preserve the file, drop the claim,
 *                                     warn (`preserved`)
 *
 * After the file loop, empty parent directories that contained deleted
 * files are removed (rmdir-only, never recursive force), walking upward
 * until we hit the workspace root or a non-empty directory.
 *
 * The receipt file is always removed at the end. If `.id-agents/` becomes
 * empty after that it is removed too; otherwise it is preserved.
 *
 * No receipt at `<workspace>/.id-agents/receipt.json` is a clean no-op.
 */
export function unsyncWorkspaceFromConfig(options: UnsyncWorkspaceOptions): UnsyncWorkspaceResult {
  const configPath = path.resolve(options.configPath);
  const workspacePath = resolveUnsyncWorkspacePath(configPath, options.workspacePath);
  const receiptPath = path.join(workspacePath, '.id-agents', 'receipt.json');

  if (!fs.existsSync(receiptPath)) {
    return {
      workspacePath,
      receiptPath,
      files: [],
      warnings: [],
      counts: { deleted: 0, preserved: 0, missing: 0 },
    };
  }

  const receipt = loadReceipt(receiptPath);
  const results: UnsyncFileResult[] = [];
  const warnings: string[] = [];
  const counts = { deleted: 0, preserved: 0, missing: 0 };
  const touchedDirs = new Set<string>();

  // Process receipt entries in sorted order for deterministic output.
  const entries = Object.entries(receipt.files).sort(([a], [b]) => a.localeCompare(b));
  for (const [relativePath, entry] of entries) {
    const absolutePath = path.join(workspacePath, relativePath);

    if (!fs.existsSync(absolutePath)) {
      results.push({ path: relativePath, outcome: 'missing' });
      counts.missing += 1;
      continue;
    }

    const diskSha = sha256Hex(fs.readFileSync(absolutePath));
    if (diskSha === entry.sha256) {
      fs.unlinkSync(absolutePath);
      touchedDirs.add(path.dirname(absolutePath));
      results.push({ path: relativePath, outcome: 'deleted' });
      counts.deleted += 1;
    } else {
      warnings.push(`Preserved user-edited file (ownership released): ${relativePath}`);
      results.push({ path: relativePath, outcome: 'preserved' });
      counts.preserved += 1;
    }
  }

  // Always remove the receipt at the end — we've released every claim.
  try {
    fs.unlinkSync(receiptPath);
    touchedDirs.add(path.dirname(receiptPath));
  } catch {
    // Ignore: receipt existed at loadReceipt time; if it's gone now, fine.
  }

  cleanupEmptyParents(workspacePath, touchedDirs);

  return {
    workspacePath,
    receiptPath,
    files: results,
    warnings,
    counts,
  };
}

function parseUnsyncArgs(args: string[]): UnsyncWorkspaceOptions {
  if (args.length === 0) {
    throw new Error('Usage: id-agents unsync <config> [--workspace <path>]');
  }

  const options: UnsyncWorkspaceOptions = { configPath: args[0] };

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--workspace') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --workspace');
      options.workspacePath = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export async function maybeRunWorkspaceUnsyncCli(argv: string[]): Promise<number | null> {
  if (argv[0] !== 'unsync') {
    return null;
  }

  try {
    const result = unsyncWorkspaceFromConfig(parseUnsyncArgs(argv.slice(1)));
    console.log(`Unsynced from ${result.workspacePath}`);
    console.log(
      `Deleted=${result.counts.deleted} ` +
      `Preserved=${result.counts.preserved} ` +
      `Missing=${result.counts.missing}`
    );
    for (const warning of result.warnings) {
      console.warn(`WARN ${warning}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}
