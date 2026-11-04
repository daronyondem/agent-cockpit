import fs, { type FileHandle } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Usage } from '../../types';
import { logger } from '../../utils/logger';

const usageLog = logger.child({ module: 'copilot-usage' });
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Native metrics include children already; provider/model and agent maps overlap. */
export function copilotUsageMetrics(value: unknown): Usage | null {
  const metrics = record(value);
  let counters: unknown[];
  if (metrics.tokenDetails !== undefined) {
    const details = record(metrics.tokenDetails);
    counters = ['input', 'output', 'cache_read', 'cache_write'].map(key => record(details[key]).tokenCount);
  } else {
    const models = Array.isArray(metrics.providerModelMetrics)
      ? metrics.providerModelMetrics.map(entry => record(entry).metrics)
      : metrics.modelMetrics && typeof metrics.modelMetrics === 'object' && !Array.isArray(metrics.modelMetrics)
        ? Object.values(metrics.modelMetrics) : null;
    if (!models || (!models.length && metrics.totalUserRequests !== 0)) return null;
    const totals = [0, 0, 0, 0];
    for (const model of models) {
      const usage = record(record(model).usage);
      const counts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
      if (!counts.every(counter)) return null;
      const [input, output, read, write] = counts;
      // Native model metrics include both cache buckets in their input total.
      if (input < read + write) return null;
      [input - read - write, output, read, write].forEach((count, index) => { totals[index] += count; });
    }
    counters = totals;
  }
  if (!counters.every(counter)) return null;
  const [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = counters;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd: 0, costSource: 'none',
    ...(counter(metrics.totalPremiumRequestCost) ? { credits: metrics.totalPremiumRequestCost } : {}) };
}

export function copilotUsageCheckpoint(event: Record<string, unknown>): Usage | null {
  if (event.type !== 'session.usage_checkpoint') return null;
  const data = record(event.data);
  const details = record(record(data.accountingSnapshot).tokenDetails);
  const counters = ['input', 'output', 'cache_read', 'cache_write'].map(key => record(details[key]).tokenCount);
  const credits = data.totalPremiumRequests;
  if (!counters.every((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    || typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0) return null;
  const [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = counters;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, credits, costUsd: 0, costSource: 'none' };
}

export function copilotTurnUsage(current: Usage, previous: Usage): Usage {
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    cacheReadTokens: Math.max(0, current.cacheReadTokens - previous.cacheReadTokens),
    cacheWriteTokens: Math.max(0, current.cacheWriteTokens - previous.cacheWriteTokens),
    ...(counter(current.credits) && counter(previous.credits) ? { credits: Math.max(0, current.credits - previous.credits) } : {}),
    costUsd: 0,
    costSource: 'none',
  };
}

export async function readCopilotUsageBaseline(sessionId: string, env: NodeJS.ProcessEnv): Promise<Usage | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    usageLog.warn('Cannot read usage baseline for an invalid Copilot session ID');
    return null;
  }
  const home = env.COPILOT_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.copilot');
  const transcript = path.join(home, 'session-state', sessionId, 'events.jsonl');
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(transcript, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    if (size > length) lines.shift();
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"session.usage_checkpoint"')) continue;
      let event: unknown;
      try {
        event = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const usage = copilotUsageCheckpoint(record(event));
      if (usage) return usage;
    }
    usageLog.warn('Copilot transcript has no usable usage checkpoint; cumulative usage will not be charged', { sessionId });
  } catch (err: unknown) {
    usageLog.warn('Cannot read Copilot usage baseline; cumulative usage will not be charged', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await handle?.close();
  }
  return null;
}
