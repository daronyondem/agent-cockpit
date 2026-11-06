import crypto from 'crypto';
import { CortexRuntime, resolveCortexRuntime, startCortexRuntime, type CortexSessionOptions } from './cortexRuntime';
import type { CortexAcpClient } from './cortexProtocol';

interface CortexSessionEntry {
  fingerprint: string;
  requestedSessionId?: string;
  starting?: Promise<CortexRuntime>;
  client?: CortexAcpClient;
  runtime?: CortexRuntime;
  active: boolean;
  lastUsed: number;
}

/** Per-conversation ownership. Not registered as a runnable adapter until P3/P5. */
export class CortexSessions {
  private entries = new Map<string, CortexSessionEntry>();
  private generation = 0;

  constructor(private start = startCortexRuntime) {}

  async acquire(conversationId: string, options: CortexSessionOptions): Promise<CortexRuntime> {
    const config = resolveCortexRuntime(options);
    let entry = this.entries.get(conversationId);
    if (entry?.active) throw new Error('Cortex conversation is already active');
    // Reserve synchronously, before any asynchronous shutdown/startup work.
    if (entry) entry.active = true;
    if (!entry || entry.fingerprint !== config.fingerprint || entry.runtime?.client.isClosed
      || options.sessionId && entry.requestedSessionId !== options.sessionId && entry.runtime?.sessionId !== options.sessionId) {
      const previous = entry;
      const generation = this.generation;
      entry = { fingerprint: config.fingerprint, requestedSessionId: options.sessionId,
        active: true, lastUsed: Date.now() };
      const owned = entry;
      this.entries.set(conversationId, owned);
      const current = () => this.generation === generation && this.entries.get(conversationId) === owned;
      owned.starting = (async () => {
        if (previous) await this.dispose(previous);
        if (!current()) throw new Error('Cortex startup was reset');
        const runtime = await this.start(config, client => {
          owned.client = client;
          if (!current()) void client.close();
        });
        owned.runtime = runtime;
        if (!current()) { await runtime.close(); throw new Error('Cortex startup was reset'); }
        try {
          await runtime.prepare(options.sessionId);
          if (!current()) throw new Error('Cortex startup was reset');
          return runtime;
        } catch (error) { await runtime.close(); throw error; }
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

  /** Same reusable operation the eventual adapter's shutdown() will delegate to. */
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
    if (entry.client && !entry.runtime) await entry.client.close();
    try {
      const runtime = entry.runtime || await entry.starting;
      await runtime?.close();
    } catch { /* startup failure already tears down its transport */ }
  }
}
