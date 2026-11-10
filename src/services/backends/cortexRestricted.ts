import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import type { CortexProcessorJob } from '../../types';
import type { RunOneShotOptions } from './base';
import { cortexVersion, resolveCortexRuntime } from './cortexRuntime';
import { CortexProcessScope } from './cortexProcess';
import { CortexInputError } from './cortexErrors';
import { CortexRestrictedStream } from './cortexRestrictedStream';
import { CORTEX_RESTRICTED_DENY_TOOLS, cortexRestrictedEnv, prepareCortexRestrictedHome, requireCortexRestrictedDistribution } from './cortexRestrictedPolicy';

/** Restricted text owns a private native config/cwd while retaining terminal auth. */
export class CortexRestrictedShots {
  private jobs = new Set<CortexProcessorJob>();

  run(prompts: string[], options: RunOneShotOptions): Promise<string[]> {
    if (!options.cliProfile) return Promise.reject(new CortexInputError('Cortex processors require an explicit CLI profile.'));
    if (options.mcpServers?.length || options.attachments?.length) return Promise.reject(new CortexInputError('Cortex tool-free processors cannot accept MCP servers or attachments.'));
    if (options.effort && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort)) return Promise.reject(new CortexInputError('Cortex restricted effort is unavailable.'));
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new CortexInputError('Cortex processor timeout must be positive.'));
    if (options.abortSignal?.aborted) return Promise.reject(new CortexInputError('Cortex background work cancelled.'));
    if (!prompts.length) return Promise.resolve([]);
    const abort = new AbortController();
    let stream: CortexRestrictedStream | undefined, root: string | undefined, failure: CortexInputError | undefined;
    const job: CortexProcessorJob = { done: Promise.resolve([]), cancel: message => {
      failure ||= new CortexInputError(message); abort.abort(); void stream?.close(failure);
    } };
    const cancelled = () => job.cancel('Cortex background work cancelled.');
    const check = () => { if (failure) throw failure; };
    const timer = setTimeout(() => job.cancel('Cortex background work timed out; its runtime was stopped.'), timeoutMs);
    options.abortSignal?.addEventListener('abort', cancelled, { once: true });
    this.jobs.add(job);
    job.done = (async () => {
      try {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-restricted-'))); await fs.chmod(root, 0o700);
        await prepareCortexRestrictedHome(root); check();
        const config = resolveCortexRuntime({ profile: options.cliProfile!, workspaceId: 'restricted-processor', cwd: root,
          managedEnv: cortexRestrictedEnv(root) });
        const version = await cortexVersion(config, abort.signal); check();
        await requireCortexRestrictedDistribution(config, version); check();
        const args = ['--no-auto-update', '-c', options.cliProfile!.cortexCode!.connection, '-w', root,
          '--setting-sources', '', '--no-mcp', '--only-explicit-plugins', '--only-explicit-skills', '--only-explicit-profiles',
          '--mode', 'standard', '--output-format', 'stream-json', '--input-format', 'stream-json',
          ...(options.model ? ['--model', options.model] : []), ...(options.effort ? ['--effort', options.effort] : []),
          '--disallowed-tools', ...CORTEX_RESTRICTED_DENY_TOOLS];
        const child = spawn(config.command, args, { cwd: root, env: config.env, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const scope = new CortexProcessScope(child); scope.watch();
        stream = new CortexRestrictedStream(child, async () => {
          await scope.stop();
          if (child.pid && child.exitCode === null && child.signalCode === null) throw new CortexInputError('Cortex restricted process did not exit.');
        });
        check(); await stream.ready; check();
        const output: string[] = [];
        for (const prompt of prompts) { check(); output.push(await stream.request(prompt)); check(); }
        return output;
      } catch (error) {
        throw failure || (error instanceof CortexInputError ? error : new CortexInputError('Cortex tool-free processor failed. Check installation, login and model access.'));
      } finally {
        clearTimeout(timer); options.abortSignal?.removeEventListener('abort', cancelled);
        try { await stream?.close(); if (root) await fs.rm(root, { recursive: true, force: true }); }
        catch { throw new CortexInputError('Cortex tool-free processor cleanup failed.'); }
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
