import type { Usage } from './responses';

export function usageTokenTotal(usage: Partial<Usage>): number {
  return (usage.inputTokens || 0) + (usage.outputTokens || 0)
    + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
}

/** A numeric zero is also the storage placeholder for an unavailable price. */
export function isUsageCostUnavailable(usage: Partial<Usage>, backend?: string): boolean {
  if ((usage.costUsd || 0) > 0 || (usage.estimatedCostUsd || 0) > 0) return false;
  return usage.costSource === 'none' || (!usage.costSource && backend === 'cortex-code');
}
