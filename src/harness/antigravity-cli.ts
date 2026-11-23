// SPDX-License-Identifier: MIT
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { resolveModelAlias } from '../core/model-aliases.js';
import { validateRuntimeModelCompatibility } from '../runtime/registry.js';
import { antigravityEnvironment, prepareAntigravityDirectory } from '../runtime/antigravity.js';
import type { AgentHarness, HarnessMessage, HarnessOptions } from './types.js';

export function buildAntigravityArgs(prompt: string, options: HarnessOptions, dir: string, skipPermissions: boolean) {
  const requested = options.model || 'neon';
  const [issue] = validateRuntimeModelCompatibility('antigravity-cli', requested);
  if (issue) throw new Error(issue.message);
  let model = resolveModelAlias(requested.trim()).toLowerCase();
  if (model === 'gemini-4-neon') {
    throw new Error('gemini-4-neon requires an effort suffix. Use neon or gemini-4-neon-high.');
  }
  if (options.effort && model.startsWith('gemini-4-')) {
    model = model.replace(/-(low|medium|high|xhigh)$/, '-' + options.effort);
  }
  const args = ['--gemini_dir', dir, '--model', model, '--output-format', 'stream-json'];
  if (options.resume) args.push('--conversation', options.resume);
  if (skipPermissions) args.push('--dangerously-skip-permissions');
  args.push('-p=' + prompt);
  return args;
}

export async function* parseAntigravityStream(lines: AsyncIterable<string>, resume?: string): AsyncGenerator<HarnessMessage> {
  const tools = new Set<number>();
  let session: string | undefined;
  for await (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event) continue;
    const id = event.conversation_id || event.result?.conversation_id;
    if (id && id !== session) {
      session = id;
      if (resume && resume !== id) console.warn(`[Antigravity] Requested conversation ${resume}, received ${id}`);
    }
    if (event.event === 'init') {
      yield { type: 'system', subtype: 'init', session_id: session };
    } else if (event.event === 'step_update') {
      const step = event.step_update;
      if (step?.step_type === 'tool' && step.state === 'ACTIVE' && !tools.has(step.step_index)) {
        tools.add(step.step_index);
        yield { type: 'tool_use', tool_name: step.tool_name || step.tool_info?.name, input: step.tool_info?.parameters };
      }
      if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
        yield { type: 'progress', content: step.text_delta };
      }
    } else if (event.event === 'result') {
      const result = event.result;
      if (result?.status !== 'SUCCESS') {
        yield { type: 'error', content: result?.error || 'agy reported an unsuccessful result' };
      } else if (typeof result.response !== 'string' || !result.response.trim()) {
        yield { type: 'error', content: 'agy returned SUCCESS with an empty response' };
      } else {
        yield { type: 'result', result: result.response, content: result.response, session_id: session };
      }
      return;
    }
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}

export class AntigravityCliHarness implements AgentHarness {
  readonly type = 'antigravity-cli';
  private stop?: () => boolean;

  cancel(): boolean {
    return this.stop?.() ?? false;
  }

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const env = antigravityEnvironment({ ...process.env, ...options.env });
    const binary = env.AGY_PATH || 'agy';
    const dir = prepareAntigravityDirectory(env);
    const skip = env.ID_AGENT_SKIP_PERMISSIONS !== 'false';
    const args = buildAntigravityArgs(prompt, options, dir, skip);
    const cwd = options.workingDirectory;
    const version = spawnSync(binary, ['--version'], { cwd, env, encoding: 'utf8', timeout: 5000 });
    console.log(`[Antigravity] ${version.stdout?.trim() || binary}, model=${args[3]}, permissions=${skip ? 'always-proceed' : 'request-review'}`);
    const proc = spawn(binary, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '';
    proc.stderr.setEncoding('utf8').on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
    proc.on('error', error => { diagnostic = error.message; });
    let closed = false;
    const completion = new Promise<number | string | null>(resolve => proc.once('close', (code, signal) => {
      closed = true;
      resolve(signal || code);
    }));
    let escalation: Promise<void> | undefined;
    const stop = () => {
      const pid = proc.pid;
      if (!pid || escalation || !signalGroup(pid, 'SIGINT')) return false;
      // The group can outlive its leader, including after its stdio has closed.
      escalation = (async () => {
        await delay(500);
        if (signalGroup(pid, 'SIGTERM')) {
          await delay(500);
          signalGroup(pid, 'SIGKILL');
        }
      })();
      return true;
    };
    this.stop = stop;
    const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    try {
      let terminal: HarnessMessage | undefined;
      for await (const message of parseAntigravityStream(lines, options.resume)) {
        if (message.type === 'result' || message.type === 'error') terminal = message;
        else yield message;
      }
      proc.stdout.resume();
      const exit = await completion;
      await escalation;
      yield terminal || { type: 'error', content: `agy closed (${exit}) without a result event${diagnostic ? ': ' + diagnostic.trim() : ''}` };
    } finally {
      if (!closed) stop();
      lines.close();
      await completion;
      await escalation;
      if (this.stop === stop) this.stop = undefined;
    }
  }
}
