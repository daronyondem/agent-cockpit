import type { UsageEvent } from '../../types';
import { cortexRecord } from './cortexProtocol';

const FIELDS = ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWriteTokens'] as const;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function cortexHasCompleteUsage(value: unknown): boolean {
  const usage = cortexRecord(value);
  return FIELDS.every(field => count(usage[field]));
}

/** One instance per prompt. Context updates never become billable deltas. */
export class CortexTurnUsage {
  contextPercentage?: number;
  private finalized = false;

  snapshot(value: unknown): void {
    const update = cortexRecord(value);
    if (count(update.used) && count(update.size) && update.size > 0) this.contextPercentage = Math.min(100, update.used / update.size * 100);
  }

  complete(value: unknown, model?: string): UsageEvent | null {
    if (this.finalized) return null;
    this.finalized = true;
    const usage = cortexRecord(value);
    // Missing/partial counters are unknown, not a fabricated zero-token success.
    if (!cortexHasCompleteUsage(usage)) return null;
    return { type: 'usage', model, usage: {
      inputTokens: usage.inputTokens as number, outputTokens: usage.outputTokens as number,
      cacheReadTokens: usage.cachedReadTokens as number, cacheWriteTokens: usage.cachedWriteTokens as number,
      costUsd: 0, costSource: 'none',
      ...(this.contextPercentage !== undefined ? { contextUsagePercentage: this.contextPercentage } : {}),
    } };
  }
}
