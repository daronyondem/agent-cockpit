import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type { CortexRuntimeConfig, CortexSessionOptions } from '../../types';
export type { CortexRuntimeConfig, CortexSessionOptions } from '../../types';
import { parseCortexCodeProfileConfig } from '../../contracts/cliProfiles';
import { isSetupAccountCliProfile } from '../cliProfiles';
import { resolveCliCommandForRuntime } from '../cliCommandResolver';
import { CortexAcpClient, cortexRecord, type CortexRecord, type CortexRpcMessage } from './cortexProtocol';
import { CortexProcessScope } from './cortexProcess';

const exec = promisify(execFile);
export function resolveCortexRuntime(options: CortexSessionOptions): CortexRuntimeConfig {
  if (process.platform === 'win32') throw new Error('Cortex runtime requires POSIX; native Windows support is not certified');
  const { profile } = options;
  if (profile.harness !== 'cortex-code' || profile.disabled) throw new Error('An enabled Cortex Code profile is required');
  const config = parseCortexCodeProfileConfig(profile.cortexCode);
  const shared = isSetupAccountCliProfile(profile);
  const overrides = Object.fromEntries(Object.entries(profile.env || {}).filter(([key]) => !shared || key.toUpperCase() !== 'SNOWFLAKE_HOME'));
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...overrides, ...options.managedEnv, CORTEX_ENABLE_MEMORY: '0', CORTEX_ACP_TEST_MODE: '0', CORTEX_OAUTH_MANUAL: '1',
  };
  if (!shared && profile.configDir?.trim()) env.SNOWFLAKE_HOME = path.resolve(profile.configDir.replace(/^~(?=\/|$)/, os.homedir()));
  const resolved = resolveCliCommandForRuntime('cortex-code', profile.command?.trim() || 'cortex', env);
  // Pin the discovered executable; auth directories never participate in discovery.
  const command = resolved.command.includes('/') ? path.resolve(resolved.command)
    : (env.PATH || '').split(path.delimiter).map(dir => path.resolve(dir, resolved.command)).find(candidate => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
    });
  if (!command) throw new Error('Cortex Code executable was not found');
  let executable: { path: string; size: number; modified: number };
  try {
    const stat = fs.statSync(command);
    fs.accessSync(command, fs.constants.X_OK);
    executable = { path: fs.realpathSync(command), size: stat.size, modified: stat.mtimeMs };
  } catch { throw new Error('Cortex Code executable is unavailable'); }
  const cwd = path.resolve(options.cwd);
  const args = ['acp', 'serve', '-c', config.connection, '-w', cwd,
    '--only-explicit-plugins', '--only-explicit-skills', '--only-explicit-mcp-servers'];
  if (options.pluginDir) args.push('--plugin-dir', path.resolve(options.pluginDir));
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ executable, args,
    env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    profileId: profile.id, workspaceId: options.workspaceId, contextKey: options.contextKey || '',
  })).digest('hex');
  // Native auto-update can replace activation between version detection and
  // ACP/login startup. Both launches must use this exact retained distribution.
  return { command: executable.path, args, env, cwd, fingerprint };
}

export async function cortexVersion(config: CortexRuntimeConfig, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await exec(config.command, ['--no-auto-update', '--version'], { cwd: config.cwd, env: config.env, timeout: 20_000, maxBuffer: 64 * 1024, signal });
    const version = stdout.match(/\bCortex Code v(\d+\.\d+\.\d+(?:[+.-][\w.-]+)?)/)?.[1];
    if (!version) throw new Error('Unexpected version');
    return version;
  } catch { throw new Error('Cortex Code version detection failed'); }
}

export class CortexRuntime {
  sessionId: string | null = null;
  configOptions: unknown[] = [];
  restoring = false;
  private promptPending: Promise<unknown> | null = null;
  private closing: Promise<void> | null = null;

  constructor(readonly client: CortexAcpClient, readonly version: string, readonly init: CortexRecord, readonly config: CortexRuntimeConfig) {}

  async prepare(sessionId?: string): Promise<void> {
    this.restoring = Boolean(sessionId);
    try {
      const result = cortexRecord(await this.client.request(sessionId ? 'session/load' : 'session/new', {
        cwd: this.config.cwd, mcpServers: [], ...(sessionId ? { sessionId } : {}),
      }));
      const id = sessionId || result.sessionId;
      if (typeof id !== 'string' || !id) throw new Error('Cortex returned an invalid session');
      this.sessionId = id;
      this.configOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
    } finally { this.restoring = false; }
  }

  /** History replay from session/load is never delivered as a new update. */
  subscribe(listener: (message: CortexRpcMessage) => boolean | void): () => void {
    return this.client.subscribe(message => this.restoring && message.id === undefined ? false : listener(message));
  }

  prompt(prompt: unknown[], timeoutMs = 300_000): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error('Cortex session is closing'));
    if (!this.sessionId) return Promise.reject(new Error('Cortex session is not prepared'));
    if (this.promptPending) return Promise.reject(new Error('Cortex session already has an active prompt'));
    const request = this.client.request('session/prompt', { sessionId: this.sessionId, prompt }, timeoutMs);
    this.promptPending = request;
    void request.finally(() => { if (this.promptPending === request) this.promptPending = null; }).catch(() => {});
    return request;
  }

  async cancel(graceMs = 3_000): Promise<void> {
    const pending = this.promptPending;
    if (!pending) return;
    this.client.notify('session/cancel', { sessionId: this.sessionId });
    let timer: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      pending.then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), graceMs); }),
    ]);
    clearTimeout(timer);
    if (!completed) await this.client.close(new Error('Cortex cancellation required runtime termination'));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      try {
        if (this.sessionId && !this.promptPending && !this.client.isClosed) {
          await this.client.request('session/close', { sessionId: this.sessionId }, 2_000);
        }
      } catch { /* transport teardown still owns every descendant */ }
      finally { await this.client.close(); }
    })();
    return this.closing;
  }
}

export async function startCortexRuntime(config: CortexRuntimeConfig, onClient?: (client: CortexAcpClient) => void, signal?: AbortSignal): Promise<CortexRuntime> {
  const version = await cortexVersion(config, signal);
  if (signal?.aborted) throw new Error('Cortex startup cancelled');
  const child = spawn(config.command, config.args, { cwd: config.cwd, env: config.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const scope = new CortexProcessScope(child);
  const client = new CortexAcpClient(child, () => scope.stop());
  scope.watch();
  try {
    onClient?.(client);
    const init = cortexRecord(await client.request('initialize', { protocolVersion: 1,
      clientInfo: { name: 'agent-cockpit', version: '1' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }));
    if (init.protocolVersion !== 1) throw new Error('Cortex did not negotiate ACP version 1');
    return new CortexRuntime(client, version, init, config);
  } catch (error) { await client.close(); throw error; }
}
