import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CopilotClient } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import type { BackendMetadata, CliProfile, EffortLevel, ModelOption } from '../../types';
import { copilotFallbackModels, copilotRuntimeModels } from './copilotModels';
import { copilotChatTransport, resolveCopilotCliRuntime, type CopilotCliRuntime } from './copilotRuntime';
import { startCopilotSdkRuntime } from './copilotSdkRuntime';

export type CopilotCatalog = Required<Pick<BackendMetadata, 'models' | 'modelCatalog'>>;
const CACHE_MS = 60_000;

function fallback(reason: string, runtime?: CopilotCliRuntime): CopilotCatalog {
  const models = copilotFallbackModels(runtime?.env);
  return { models: structuredClone(models), modelCatalog: { source: 'fallback', reason } };
}

/** Cache only digests: credentials, process environments and native errors never leave this module. */
export function copilotCatalogKey(runtime: CopilotCliRuntime): string {
  const home = runtime.env.HOME || runtime.env.USERPROFILE || os.homedir();
  const authHome = runtime.env.COPILOT_HOME || path.join(home, '.copilot');
  const executable = path.basename(runtime.command) === runtime.command
    ? (runtime.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, runtime.command)).find(file => fs.existsSync(file)) || runtime.command
    : runtime.command;
  const files = [executable, ...(runtime.argsPrefix || []), path.join(authHome, 'config.json'),
    path.join(runtime.env.GH_CONFIG_DIR || path.join(home, '.config', 'gh'), 'hosts.yml')];
  const signatures = files.map(file => {
    try { const stat = fs.statSync(file); return [file, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]; }
    catch { return [file, null]; }
  });
  return crypto.createHash('sha256').update(JSON.stringify({ profile: runtime.profileKey,
    env: Object.entries(runtime.env).sort(([a], [b]) => a.localeCompare(b)), signatures })).digest('hex');
}

export class CopilotModelCatalog {
  private cache = new Map<string, { expires: number; catalog: CopilotCatalog }>();
  private pending = new Map<string, { controller: AbortController; promise: Promise<CopilotCatalog> }>();
  private closing: Promise<void> | null = null;
  private revision = 0;

  constructor(private timeoutMs = 10_000) {}

  async get(profile?: CliProfile): Promise<CopilotCatalog> {
    const runtime = resolveCopilotCliRuntime(profile);
    if (this.closing) return fallback('Copilot is restarting. Refresh the model list shortly.');
    if (copilotChatTransport(profile) === 'jsonl') return fallback('Custom command compatibility mode; account model discovery is unavailable.', runtime);
    const key = copilotCatalogKey(runtime);
    const pending = this.pending.get(key);
    if (pending) return pending.promise;
    const existing = this.lookup(runtime);
    if (existing) return existing;
    const controller = new AbortController();
    const promise = this.discover(runtime, controller).then(catalog => {
      this.pending.delete(key);
      return catalog;
    }, error => {
      // Retain failed cleanup as an admission barrier; never replace an owned
      // process whose termination could not be proved.
      this.cache.delete(key);
      throw error;
    });
    this.pending.set(key, { controller, promise });
    return promise;
  }

  /** Reuse a turn's owned connection. No second process, session or prompt is created. */
  async forRuntime(runtime: CopilotCliRuntime, client: CopilotClient, signal?: AbortSignal): Promise<CopilotCatalog> {
    const pending = this.pending.get(copilotCatalogKey(runtime));
    return pending ? pending.promise : this.load(runtime, client, signal);
  }

  private async load(runtime: CopilotCliRuntime, client: CopilotClient, signal?: AbortSignal): Promise<CopilotCatalog> {
    const existing = this.lookup(runtime);
    if (existing) return existing;
    const key = copilotCatalogKey(runtime), revision = this.revision;
    let catalog: CopilotCatalog;
    try {
      const models = copilotRuntimeModels(await client.listModels());
      // An authoritative empty catalog must not offer unavailable fallback models.
      catalog = { models, modelCatalog: { source: 'runtime', fetchedAt: new Date().toISOString() } };
    } catch (error) {
      const status = String(error).match(/"status"\s*:\s*(\d{3})/)?.[1];
      catalog = fallback(status ? `Account model discovery failed (HTTP ${status}). Check this profile's access.`
        : 'Account model discovery is unavailable. Check this profile or try again.', runtime);
    }
    if (!signal?.aborted) this.remember(key, catalog, revision);
    return catalog;
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.revision++;
    this.cache.clear();
    const pending = [...this.pending.values()];
    for (const entry of pending) entry.controller.abort();
    this.closing = Promise.allSettled(pending.map(entry => entry.promise)).then(results => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Copilot model discovery cleanup failed.');
    }).finally(() => { this.cache.clear(); this.closing = null; });
    return this.closing;
  }

  private lookup(runtime: CopilotCliRuntime): CopilotCatalog | undefined {
    if (runtime.env.COPILOT_PROVIDER_BASE_URL) return fallback('Custom provider: model availability is determined by your endpoint.', runtime);
    const key = copilotCatalogKey(runtime);
    const entry = this.cache.get(key);
    if (entry && entry.expires > Date.now()) return structuredClone(entry.catalog);
    this.cache.delete(key);
    return undefined;
  }

  private remember(key: string, catalog: CopilotCatalog, revision: number): void {
    if (this.closing || revision !== this.revision) return;
    // Bound entries for deleted/edited profiles and old runtime/auth identities.
    if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expires: Date.now() + CACHE_MS, catalog: structuredClone(catalog) });
  }

  private async discover(runtime: CopilotCliRuntime, controller: AbortController): Promise<CopilotCatalog> {
    const key = copilotCatalogKey(runtime), revision = this.revision;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Copilot model discovery cancelled.')), { once: true });
    });
    let owned: Awaited<ReturnType<typeof startCopilotSdkRuntime>> | undefined;
    let startup: ReturnType<typeof startCopilotSdkRuntime> | undefined;
    try {
      startup = startCopilotSdkRuntime(runtime, process.cwd(), { abortSignal: controller.signal });
      owned = await Promise.race([startup, aborted]);
      return await Promise.race([this.load(runtime, owned.client, controller.signal), aborted, owned.closed.then(error => { throw error; })]);
    } catch {
      const catalog = fallback('Account model discovery is unavailable. Check this profile or try again.', runtime);
      if (!controller.signal.aborted) this.remember(key, catalog, revision);
      return catalog;
    } finally {
      clearTimeout(timer);
      // A late startup still belongs to this request, including during shutdown.
      owned ||= await startup?.catch(() => undefined);
      await owned?.stop();
    }
  }
}

export function assertCopilotSelection(metadata: Pick<BackendMetadata, 'models'>,
  selection: { model?: string | null; effort?: EffortLevel | null }, env: NodeJS.ProcessEnv): void {
  const requested = selection.model?.trim();
  const id = requested && requested !== 'auto' ? requested : env.COPILOT_MODEL?.trim() || 'auto';
  const model: ModelOption | undefined = metadata.models?.find(candidate => candidate.id === id);
  if (!model) throw new Error(`Copilot model "${id}" is unavailable for this profile. Choose a model from the current list or check the profile's access.`);
  if (selection.effort && !model.supportedEffortLevels?.includes(selection.effort)) {
    throw new Error(`Copilot model "${id}" does not support effort "${selection.effort}". Choose a supported effort level or clear it.`);
  }
}
