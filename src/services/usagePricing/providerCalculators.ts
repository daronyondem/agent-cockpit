import type { Usage } from '../../types';
import { BUILTIN_USAGE_PRICING_CATALOG } from './catalog';
import type {
  UsageCostEstimate,
  UsageCostInput,
  UsageCostSnapshot,
  UsagePricingEntry,
  UsagePricingProvider,
  UsageTokenRatesPerMillion,
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

  const { estimatedCostUsd, ratesPerMillion, longContextThresholdTokens } = calculateTokenEstimate(input.usage, entry);
  if (!(estimatedCostUsd > 0)) return { estimatedCostUsd: 0, costSource: 'none' };

  return {
    estimatedCostUsd,
    costSource: 'estimated',
    costSnapshot: buildSnapshot(input, provider, entry, { ratesPerMillion, longContextThresholdTokens }),
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

function calculateTokenEstimate(usage: Usage, entry: UsagePricingEntry): {
  estimatedCostUsd: number;
  ratesPerMillion?: UsageTokenRatesPerMillion;
  longContextThresholdTokens?: number;
} {
  const rates = ratesForUsage(usage, entry);
  if (!rates.ratesPerMillion) return { estimatedCostUsd: 0 };
  const selectedRates = rates.ratesPerMillion;
  const estimatedCostUsd = ((usage.inputTokens || 0) * selectedRates.input
    + (usage.outputTokens || 0) * selectedRates.output
    + (usage.cacheReadTokens || 0) * (selectedRates.cachedInput ?? selectedRates.input)
    + (usage.cacheWriteTokens || 0) * (selectedRates.cacheWrite ?? selectedRates.input)) / MILLION;
  return {
    estimatedCostUsd,
    ratesPerMillion: selectedRates,
    ...(rates.longContextThresholdTokens ? { longContextThresholdTokens: rates.longContextThresholdTokens } : {}),
  };
}

function ratesForUsage(usage: Usage, entry: UsagePricingEntry): {
  ratesPerMillion?: UsageTokenRatesPerMillion;
  longContextThresholdTokens?: number;
} {
  const promptInputTokens = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
  if (
    entry.longContextThresholdTokens
    && entry.longContextRatesPerMillion
    && promptInputTokens > entry.longContextThresholdTokens
  ) {
    return {
      ratesPerMillion: entry.longContextRatesPerMillion,
      longContextThresholdTokens: entry.longContextThresholdTokens,
    };
  }
  return { ratesPerMillion: entry.ratesPerMillion };
}

function buildSnapshot(
  input: UsageCostInput,
  provider: UsagePricingProvider,
  entry: UsagePricingEntry,
  tokenRates?: { ratesPerMillion?: UsageTokenRatesPerMillion; longContextThresholdTokens?: number },
): UsageCostSnapshot {
  const pricingTier = normalizedPricingTier(input.pricingTier) || normalizedPricingTier(entry.pricingTier);
  const ratesPerMillion = tokenRates?.ratesPerMillion || entry.ratesPerMillion;
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
    ...(ratesPerMillion ? { ratesPerMillion: { ...ratesPerMillion } } : {}),
    ...(tokenRates?.longContextThresholdTokens ? { longContextThresholdTokens: tokenRates.longContextThresholdTokens } : {}),
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
