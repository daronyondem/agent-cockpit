import crypto from 'crypto';
import type { CortexProcessorJob } from '../../types';
import type { RunOneShotOptions } from './base';
import { CortexSessions } from './cortexSessions';
import { CortexTurn } from './cortexTurn';
import { CortexInputError, cortexRuntimeError } from './cortexErrors';

/** Ephemeral native sessions, with one deadline across startup and all prompts. */
export class CortexShots {
  private jobs = new Set<CortexProcessorJob>();

  constructor(private sessions: CortexSessions, private workingDir: string | null) {}

  run(prompts: string[], options: RunOneShotOptions): Promise<string[]> {
    // This check precedes session creation, plugin generation and native startup.
    if (options.allowTools !== true) return Promise.reject(new CortexInputError('Cortex ACP processors require allowTools:true; restricted text uses its dedicated native headless runtime.'));
    if (!options.cliProfile) return Promise.reject(new CortexInputError('Cortex processors require an explicit CLI profile.'));
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new CortexInputError('Cortex processor timeout must be positive.'));
    if (options.abortSignal?.aborted) return Promise.reject(new CortexInputError('Cortex background work cancelled.'));
    const id = `cortex-processor:${crypto.randomUUID()}`;
    const deadline = Date.now() + timeoutMs;
    let turn: CortexTurn | undefined;
    let failure: CortexInputError | undefined;
    let cancelling: Promise<void> | undefined;
    const job: CortexProcessorJob = { cancel: message => {
      if (failure) return;
      failure = new CortexInputError(message);
      cancelling = (async () => { await turn?.abort(); await this.sessions.reset(id); })();
      // The owner awaits cleanup in finally; observe failures immediately too.
      void cancelling.catch(() => {});
    }, done: Promise.resolve([]) };
    const abort = () => job.cancel('Cortex background work cancelled.');
    const check = () => { if (failure) throw failure; };
    const timer = setTimeout(() => job.cancel('Cortex background work timed out; its runtime was stopped.'), timeoutMs);
    options.abortSignal?.addEventListener('abort', abort, { once: true });
    this.jobs.add(job);
    job.done = (async () => {
      try {
        if (!prompts.length) return [];
        const runtime = await this.sessions.acquire(id, { profile: options.cliProfile!, workspaceId: id,
          cwd: options.workingDir || this.workingDir || process.cwd(), mcpServers: options.mcpServers });
        check();
        const outputs: string[] = [];
        for (const text of prompts) {
          check();
          turn = new CortexTurn(runtime, { text, model: options.model, effort: options.effort, allowTools: true,
            headless: true, processorAttachments: options.attachments, timeoutMs: Math.max(1, deadline - Date.now()) });
          let output = '';
          for await (const event of turn.stream()) {
            check();
            if (event.type === 'error' && event.terminal !== false) throw new CortexInputError(event.error);
            if (event.type === 'result') output = event.content;
          }
          check();
          outputs.push(output.trim());
        }
        return outputs;
      } catch (error) {
        throw failure || new CortexInputError(cortexRuntimeError(error).error);
      } finally {
        clearTimeout(timer);
        options.abortSignal?.removeEventListener('abort', abort);
        try {
          try { await cancelling; }
          finally { await this.sessions.reset(id); }
        } catch { throw failure || new CortexInputError('Cortex processor cleanup failed.'); }
        finally { this.jobs.delete(job); }
      }
    })();
    return job.done;
  }

  async shutdown(): Promise<void> {
    const jobs = [...this.jobs];
    for (const job of jobs) job.cancel('Cortex background work stopped during shutdown.');
    await Promise.allSettled(jobs.map(job => job.done));
  }
}
