import type { CortexTurnOptions, ErrorEvent, StreamEvent } from '../../types';
import { CortexRuntime } from './cortexRuntime';
import { cortexRecord } from './cortexProtocol';
import { CortexEventDecoder } from './cortexEvents';
import { CortexInteractions } from './cortexInteractions';
import { configureCortex } from './cortexModels';
import { cortexPromptContent, cortexProcessorContent } from './cortexAttachments';
import { CortexArtifacts } from './cortexArtifacts';
import { CortexInactivityError, cortexRuntimeError, cortexTerminalError } from './cortexErrors';

/** Native prompt mapping; cortex.ts owns durable chat leases. */
export class CortexTurn {
  private events: StreamEvent[] = [];
  private wake?: () => void;
  private ended = false;
  private aborted = false;
  private started = false;
  private prompting = false;
  private interactionRequired = false;
  private watching = false;
  private idleStopped = false;
  private watchdog?: NodeJS.Timeout;
  private interactions: CortexInteractions;

  constructor(private runtime: CortexRuntime, private options: CortexTurnOptions) {
    this.interactions = new CortexInteractions(runtime.client, runtime.sessionId || '', event => this.emit(event), options.allowTools,
      options.headless ? () => {
        if (this.interactionRequired) return;
        this.interactionRequired = true;
        void runtime.cancel().catch(() => {}); // The lease owner still awaits runtime teardown.
      } : undefined);
  }

  get pendingId(): string | null { return this.interactions.pendingId; }
  get didPrompt(): boolean { return this.prompting; }
  input(text: string, decisionId: string): boolean {
    if (this.ended || !this.interactions.input(text, decisionId)) return false;
    this.watch(); // Native work resumes after an answer.
    return true;
  }
  async abort(): Promise<void> {
    this.aborted = true;
    this.interactions.cancel();
    if (this.started && !this.prompting && !this.ended) await this.runtime.client.close();
    else await this.runtime.cancel();
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    if (this.started) throw new Error('Cortex turn stream is already consumed');
    this.started = true;
    const running = this.run();
    try {
      while (!this.ended || this.events.length) {
        if (this.events.length) yield this.events.shift()!;
        else await new Promise<void>(resolve => { this.wake = resolve; });
      }
    } finally {
      if (!this.ended) await this.abort();
      await running;
    }
  }

  private emit(event: StreamEvent): void { this.events.push(event); this.wake?.(); }

  /** Optional inactivity limit; waiting for a human decision is not native inactivity. */
  private watch(): void {
    const idleMs = this.options.idleTimeoutMs;
    if (!idleMs || !this.watching) return;
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.interactions.pendingId) return this.watch();
      this.idleStopped = true;
      void this.runtime.client.close(new CortexInactivityError(
        `Cortex made no progress for ${Math.round(idleMs / 60_000)} minutes; its runtime was stopped.`));
    }, idleMs);
  }

  private stopWatching(): void { this.watching = false; clearTimeout(this.watchdog); }

  private async run(): Promise<void> {
    const decoder = new CortexEventDecoder(this.runtime.sessionId || '');
    const artifacts = new CortexArtifacts(this.runtime.sessionId || '', this.runtime.config.cwd);
    let unsubscribe: (() => void) | undefined;
    let artifactWork = Promise.resolve();
    try {
      if (this.aborted) { this.emit({ type: 'error', error: 'Cortex turn cancelled', source: 'abort' }); return; }
      const model = await configureCortex(this.runtime, this.options);
      const image = cortexRecord(cortexRecord(this.runtime.init.agentCapabilities).promptCapabilities).image === true;
      const content = this.options.headless
        ? await cortexProcessorContent(this.options.text, this.options.processorAttachments || [], model, this.runtime.version, image)
        : await cortexPromptContent(this.options.text, this.options.attachments || [], this.options.attachmentRoot, model, this.runtime.version, image);
      if (this.aborted) { this.emit({ type: 'error', error: 'Cortex turn cancelled', source: 'abort' }); return; }
      unsubscribe = this.runtime.subscribe(message => {
        this.watch();
        if (message.id !== undefined) return this.interactions.handle(message);
        this.interactions.observe(message);
        for (const event of decoder.decode(message)) this.emit(event);
        artifactWork = artifactWork.then(async () => { for (const event of await artifacts.collect(message)) this.emit(event); });
      });
      this.prompting = true;
      this.watching = true;
      this.watch();
      const result = cortexRecord(await this.runtime.prompt(content, this.options.timeoutMs).finally(() => this.stopWatching()));
      await artifactWork;
      const usage = decoder.usage.complete(result.usage, model);
      const error = this.interactionError() || cortexTerminalError(this.aborted ? { ...result, stopReason: 'cancelled' } : result, decoder.finalText, this.runtime.version);
      if (!error) {
        for (const event of decoder.finishText()) this.emit(event);
        for (const event of await artifacts.deliver(decoder.deliveries)) this.emit(event);
      }
      if (usage) this.emit(usage);
      if (error) this.emit(error);
      else if (decoder.resultText) this.emit({ type: 'result', content: decoder.resultText });
      if (!usage && result.stopReason !== 'cancelled' && !error) this.emit({ type: 'error', error: 'Cortex did not report complete token usage for this turn.', terminal: false, source: 'backend' });
    } catch (error) {
      await artifactWork;
      this.emit(this.interactionError() || (this.aborted ? { type: 'error', error: 'Cortex turn cancelled', source: 'abort' } : cortexRuntimeError(error)));
    } finally {
      unsubscribe?.();
      this.interactions.cancel();
      try {
        // Acknowledged native cancellation can leave background shells alive.
        if (this.aborted || this.idleStopped) await this.runtime.close();
      } finally {
        this.emit({ type: 'done' });
        this.ended = true;
        this.wake?.();
      }
    }
  }

  private interactionError(): ErrorEvent | null {
    return this.interactionRequired ? { type: 'error', error: 'Cortex background work requires a human decision. Run this task in chat.', source: 'backend' } : null;
  }
}
