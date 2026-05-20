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

type ProviderCalculator = (input: UsageCostInput, provider: UsagePricingProvider, entries: UsagePricingEntry[]) => UsageCostEstimate;

const PROVIDER_CALCULATORS: Record<UsagePricingProvider, ProviderCalculator> = {
  openai: estimateTokenUsage,
  anthropic: estimateTokenUsage,
  kiro: estimateKiroCredits,
};

export function providerForBackend(backend: string): UsagePricingProvider | null {
  if (backend === 'codex') return 'openai';
  if (backend === 'claude-code' || backend === 'claude-code-interactive') return 'anthropic';
  if (backend === 'kiro') return 'kiro';
  return null;
}

export function estimateWithProviderCalculator(input: UsageCostInput): UsageCostEstimate {
  const provider = providerForBackend(input.backend);
  if (!provider) return { estimatedCostUsd: 0, costSource: 'none' };
  const calculator = PROVIDER_CALCULATORS[provider];
  const entries = input.entries || BUILTIN_USAGE_PRICING_CATALOG.entries;
  return calculator(input, provider, entries);
}

export function findPricingEntry(
  entries: UsagePricingEntry[],
  provider: UsagePricingProvider,
  model: string,
  pricingTier?: string,
): UsagePricingEntry | null {
  return entries.find(entry => (
    entry.provider === provider
    && pricingTiersMatch(entry.pricingTier, pricingTier)
    && patternMatches(entry.modelPattern, model)
  )) || null;
}

function estimateTokenUsage(input: UsageCostInput, provider: UsagePricingProvider, entries: UsagePricingEntry[]): UsageCostEstimate {
  const entry = findPricingEntry(entries, provider, input.model, input.pricingTier);
  if (!entry || entry.unit !== 'tokens') return { estimatedCostUsd: 0, costSource: 'none' };

  const estimatedCostUsd = calculateTokenEstimate(input.usage, entry);
  if (!(estimatedCostUsd > 0)) return { estimatedCostUsd: 0, costSource: 'none' };

  return {
    estimatedCostUsd,
    costSource: 'estimated',
    costSnapshot: buildSnapshot(input, provider, entry),
  };
}

function estimateKiroCredits(input: UsageCostInput, provider: UsagePricingProvider, entries: UsagePricingEntry[]): UsageCostEstimate {
  const entry = findPricingEntry(entries, provider, input.model);
  if (!entry || entry.unit !== 'credits') return { estimatedCostUsd: 0, costSource: 'none' };

  const estimatedCostUsd = (input.usage.credits || 0) * (entry.usdPerCredit || 0);
  if (!(estimatedCostUsd > 0)) return { estimatedCostUsd: 0, costSource: 'none' };

  return {
    estimatedCostUsd,
    costSource: 'estimated',
    costSnapshot: buildSnapshot(input, provider, entry),
  };
}

function calculateTokenEstimate(usage: Usage, entry: UsagePricingEntry): number {
  const rates = entry.ratesPerMillion;
  if (!rates) return 0;
  return ((usage.inputTokens || 0) * rates.input
    + (usage.outputTokens || 0) * rates.output
    + (usage.cacheReadTokens || 0) * (rates.cachedInput || rates.input)
    + (usage.cacheWriteTokens || 0) * (rates.cacheWrite || rates.input)) / MILLION;
}

function buildSnapshot(input: UsageCostInput, provider: UsagePricingProvider, entry: UsagePricingEntry): UsageCostSnapshot {
  const pricingTier = normalizedPricingTier(input.pricingTier) || normalizedPricingTier(entry.pricingTier);
  return {
    catalogVersion: input.catalogVersion || BUILTIN_USAGE_PRICING_CATALOG.version,
    pricedAt: input.pricedAt || new Date().toISOString(),
    provider,
    model: input.model,
    ...(pricingTier ? { pricingTier } : {}),
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

function pricingTiersMatch(entryTier: string | undefined, requestedTier: string | undefined): boolean {
  const normalizedEntryTier = normalizedPricingTier(entryTier);
  const normalizedRequestedTier = normalizedPricingTier(requestedTier);
  if (normalizedRequestedTier) return normalizedEntryTier === normalizedRequestedTier;
  return !normalizedEntryTier || normalizedEntryTier === 'standard';
}

function normalizedPricingTier(value: string | undefined): string | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized || undefined;
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
