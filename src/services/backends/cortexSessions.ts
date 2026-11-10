import crypto from 'crypto';
import { CortexRuntime, resolveCortexRuntime, startCortexRuntime, type CortexSessionOptions } from './cortexRuntime';
import type { CortexAcpClient } from './cortexProtocol';
import { cortexPluginDefinition, createCortexPlugin, pruneCortexPlugins } from './cortexPlugin';
import { cortexMissingSession, CortexMissingSessionError } from './cortexErrors';

interface CortexSessionEntry {
  fingerprint: string;
  requestedSessionId?: string;
  starting?: Promise<CortexRuntime>;
  client?: CortexAcpClient;
  runtime?: CortexRuntime;
  plugin?: Awaited<ReturnType<typeof createCortexPlugin>>;
  abort: AbortController;
  active: boolean;
  lastUsed: number;
}

/** Per-conversation ownership; runtime refresh happens only between turn leases. */
export class CortexSessions {
  private entries = new Map<string, CortexSessionEntry>();
  private generation = 0;
  private pruning?: Promise<void>;

  constructor(private start = startCortexRuntime) {}

  async acquire(conversationId: string, options: CortexSessionOptions): Promise<CortexRuntime> {
    const definition = cortexPluginDefinition(options.mcpServers || []);
    const config = resolveCortexRuntime({ ...options,
      managedEnv: { ...options.managedEnv, ...definition.env },
      contextKey: `${options.contextKey || ''}:${definition.key}` });
    let entry = this.entries.get(conversationId);
    if (entry?.active) throw new Error('Cortex conversation is already active');
    // Reserve synchronously, before any asynchronous shutdown/startup work.
    if (entry) entry.active = true;
    if (!entry || entry.fingerprint !== config.fingerprint || entry.runtime?.client.isClosed
      || options.sessionId && entry.requestedSessionId !== options.sessionId && entry.runtime?.sessionId !== options.sessionId) {
      const previous = entry;
      const generation = this.generation;
      entry = { fingerprint: config.fingerprint, requestedSessionId: options.sessionId,
        active: true, lastUsed: Date.now(), abort: new AbortController() };
      const owned = entry;
      this.entries.set(conversationId, owned);
      const current = () => this.generation === generation && this.entries.get(conversationId) === owned;
      owned.starting = (async () => {
        if (previous) await this.dispose(previous);
        if (!current()) throw new Error('Cortex startup was reset');
        try {
          if (definition.enabled) {
            await (this.pruning ||= pruneCortexPlugins());
            owned.plugin = await createCortexPlugin(definition);
          }
          if (!current()) throw new Error('Cortex startup was reset');
          const runtime = await this.start({ ...config,
            args: owned.plugin ? [...config.args, '--plugin-dir', owned.plugin.dir] : config.args }, client => {
            owned.client = client;
            owned.plugin?.attach(client.process.pid);
            if (!current()) void client.close();
          }, owned.abort.signal);
          owned.runtime = runtime;
          if (!current()) throw new Error('Cortex startup was reset');
          await runtime.prepare(options.sessionId);
          if (!current()) throw new Error('Cortex startup was reset');
          return runtime;
        } catch (error) {
          await owned.runtime?.close();
          await owned.client?.close();
          await owned.plugin?.remove();
          if (!current()) throw new Error('Cortex startup was reset');
          if (options.sessionId && owned.runtime && cortexMissingSession(error, options.sessionId, owned.runtime.version)) {
            throw new CortexMissingSessionError('Cortex saved session was not found');
          }
          throw error;
        }
      })();
    }
    const owned = entry;
    try { return await owned.starting!; }
    catch (error) {
      if (this.entries.get(conversationId) === owned) this.entries.delete(conversationId);
      throw error;
    }
  }

  release(conversationId: string, runtime: CortexRuntime): void {
    const entry = this.entries.get(conversationId);
    if (entry?.runtime === runtime) { entry.active = false; entry.lastUsed = Date.now(); }
  }

  async reset(conversationId: string): Promise<void> {
    const entry = this.entries.get(conversationId);
    this.entries.delete(conversationId);
    if (entry) await this.dispose(entry);
  }

  async evictIdle(idleMs: number, now = Date.now()): Promise<void> {
    await Promise.all([...this.entries].filter(([, entry]) => !entry.active && now - entry.lastUsed >= idleMs)
      .map(([id]) => this.reset(id)));
  }

  /** Reusable across server shutdown and CLI updates. */
  async shutdown(): Promise<void> {
    this.generation++;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(entry => this.dispose(entry)));
  }

  /** No cross-profile cache/fallback; catalog failures reject instead of returning stale models. */
  async discover(options: CortexSessionOptions): Promise<{ version: string; configOptions: unknown[] }> {
    const generation = this.generation;
    const id = `metadata:${crypto.randomUUID()}`;
    try {
      const runtime = await this.acquire(id, { ...options, sessionId: undefined });
      if (generation !== this.generation) throw new Error('Cortex discovery was reset');
      return { version: runtime.version, configOptions: runtime.configOptions };
    } finally { await this.reset(id); }
  }

  private async dispose(entry: CortexSessionEntry): Promise<void> {
    entry.abort.abort();
    if (entry.client && !entry.runtime) await entry.client.close();
    try {
      const runtime = entry.runtime || await entry.starting;
      await runtime?.close();
    } catch { /* startup failure already tears down its transport */ }
    finally { await entry.plugin?.remove(); }
  }
}
