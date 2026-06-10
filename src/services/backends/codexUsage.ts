import type { ServiceTier, Usage } from '../../types';

function codexUsagePricingTier(serviceTier?: ServiceTier): string | undefined {
  return serviceTier === 'fast' ? 'priority' : undefined;
}

export function attachCodexUsagePricingTier(usage: Usage, serviceTier?: ServiceTier): Usage {
  const pricingTier = codexUsagePricingTier(serviceTier);
  return pricingTier ? { ...usage, pricingTier } : usage;
}

// Derive a cockpit `Usage` event from a Codex `thread/tokenUsage/updated`
// notification. Codex exposes both `last` (this turn) and `total` (cumulative)
// counters; we deliberately use `last` for two reasons:
//
// 1. `inputTokens` is reported as `last.inputTokens - last.cachedInputTokens` —
//    only the fresh (uncached) portion of this turn's prompt. Codex's raw
//    `last.inputTokens` includes the entire prior conversation as cache reads,
//    so summing it across turns inflates the session input by the conversation
//    length. Subtracting the cached portion gives a per-turn "fresh input"
//    that matches Anthropic's `input_tokens` semantics (which already excludes
//    cache reads) and accumulates meaningfully via the `+=` aggregator.
// 2. `contextUsagePercentage` is computed from `last.totalTokens`, not
//    `total.totalTokens`. The percentage is meant as a snapshot of the current
//    turn's context window usage (always 0-100). Using cumulative total made
//    it grow without bound - a 10-turn session at full window read 1000%+.
export function deriveCodexUsage(tokenUsage: {
  total: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
  last: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
  modelContextWindow: number | null;
}): Usage {
  const last = tokenUsage.last;
  const cached = last.cachedInputTokens || 0;
  const freshInput = Math.max(0, (last.inputTokens || 0) - cached);
  const ctxPct = tokenUsage.modelContextWindow && tokenUsage.modelContextWindow > 0
    ? Math.round((last.totalTokens / tokenUsage.modelContextWindow) * 100)
    : undefined;
  return {
    inputTokens: freshInput,
    outputTokens: last.outputTokens || 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    costUsd: 0,
    contextUsagePercentage: ctxPct,
  };
}
