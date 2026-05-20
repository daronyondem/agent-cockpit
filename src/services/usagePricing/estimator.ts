import type { Usage } from '../../types';
import { BUILTIN_USAGE_PRICING_CATALOG } from './catalog';
import type {
  UsageCostEstimate,
  UsageCostInput,
  UsageCostSnapshot,
  UsagePricingEntry,
  UsagePricingProvider,
} from './types';

const MILLION = 1_000_000;

export function providerForBackend(backend: string): UsagePricingProvider | null {
  if (backend === 'codex') return 'openai';
  if (backend === 'claude-code' || backend === 'claude-code-interactive') return 'anthropic';
  if (backend === 'kiro') return 'kiro';
  return null;
}

export function estimateUsageCost(input: UsageCostInput): UsageCostEstimate {
  if (input.usage.costSource === 'estimated' && typeof input.usage.estimatedCostUsd === 'number') {
    return {
      estimatedCostUsd: input.usage.estimatedCostUsd,
      costSource: 'estimated',
      ...(input.usage.costSnapshot ? { costSnapshot: input.usage.costSnapshot } : {}),
    };
  }

  if ((input.usage.costUsd || 0) > 0) {
    return { estimatedCostUsd: 0, costSource: 'reported' };
  }

  const provider = providerForBackend(input.backend);
  if (!provider) return { estimatedCostUsd: 0, costSource: 'none' };

  const entries = input.entries || BUILTIN_USAGE_PRICING_CATALOG.entries;
  const entry = findPricingEntry(entries, provider, input.model);
  if (!entry) return { estimatedCostUsd: 0, costSource: 'none' };

  const estimatedCostUsd = calculateEstimate(input.usage, entry);
  if (!(estimatedCostUsd > 0)) return { estimatedCostUsd: 0, costSource: 'none' };

  return {
    estimatedCostUsd,
    costSource: 'estimated',
    costSnapshot: buildSnapshot(input, provider, entry),
  };
}

export function applyCostEstimate(
  backend: string,
  model: string,
  usage: Usage,
  pricedAt?: string,
  entries?: UsagePricingEntry[],
  catalogVersion?: string,
): Usage {
  const estimate = estimateUsageCost({ backend, model, usage, pricedAt, entries, catalogVersion });
  const next: Usage = {
    ...usage,
    costSource: estimate.costSource,
    estimatedCostUsd: undefined,
    costSnapshot: undefined,
  };
  if (estimate.costSource === 'estimated') {
    next.estimatedCostUsd = estimate.estimatedCostUsd;
    if (estimate.costSnapshot) next.costSnapshot = estimate.costSnapshot;
  }
  return next;
}

export function findPricingEntry(entries: UsagePricingEntry[], provider: UsagePricingProvider, model: string): UsagePricingEntry | null {
  return entries.find(entry => entry.provider === provider && patternMatches(entry.modelPattern, model)) || null;
}

function calculateEstimate(usage: Usage, entry: UsagePricingEntry): number {
  if (entry.unit === 'credits') {
    return (usage.credits || 0) * (entry.usdPerCredit || 0);
  }
  const rates = entry.ratesPerMillion;
  if (!rates) return 0;
  return ((usage.inputTokens || 0) * rates.input
    + (usage.outputTokens || 0) * rates.output
    + (usage.cacheReadTokens || 0) * (rates.cachedInput || rates.input)
    + (usage.cacheWriteTokens || 0) * (rates.cacheWrite || rates.input)) / MILLION;
}

function buildSnapshot(input: UsageCostInput, provider: UsagePricingProvider, entry: UsagePricingEntry): UsageCostSnapshot {
  return {
    catalogVersion: input.catalogVersion || BUILTIN_USAGE_PRICING_CATALOG.version,
    pricedAt: input.pricedAt || new Date().toISOString(),
    provider,
    model: input.model,
    pricingEntryId: entry.id,
    sourceUrl: entry.sourceUrl,
    verifiedAt: entry.verifiedAt,
    effectiveDate: entry.effectiveDate,
    currency: 'USD',
    unit: entry.unit,
    ...(entry.ratesPerMillion ? { ratesPerMillion: { ...entry.ratesPerMillion } } : {}),
    ...(entry.usdPerCredit !== undefined ? { usdPerCredit: entry.usdPerCredit } : {}),
  };
}

function patternMatches(pattern: string, model: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === model;
  const escaped = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(model);
}
