import { BUILTIN_USAGE_PRICING_CATALOG, validateUsagePricingCatalog } from '../src/services/usagePricing/catalog';
import { applyCostEstimate, estimateUsageCost, findPricingEntry, providerForBackend } from '../src/services/usagePricing/estimator';
import type { UsagePricingEntry } from '../src/services/usagePricing/types';

const baseUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

describe('usage pricing catalog', () => {
  test('loads the built-in JSON catalog', () => {
    expect(BUILTIN_USAGE_PRICING_CATALOG.schemaVersion).toBe(1);
    expect(BUILTIN_USAGE_PRICING_CATALOG.currency).toBe('USD');
    expect(BUILTIN_USAGE_PRICING_CATALOG.entries.length).toBeGreaterThan(0);
  });

  test('rejects malformed catalogs', () => {
    expect(() => validateUsagePricingCatalog({ schemaVersion: 1, currency: 'USD', version: 'x', entries: [{ id: 'bad' }] })).toThrow(/provider/);
  });
});

describe('usage cost estimator', () => {
  test('maps known backends to pricing providers', () => {
    expect(providerForBackend('codex')).toBe('openai');
    expect(providerForBackend('claude-code')).toBe('anthropic');
    expect(providerForBackend('claude-code-interactive')).toBe('anthropic');
    expect(providerForBackend('kiro')).toBe('kiro');
    expect(providerForBackend('unknown')).toBeNull();
  });

  test('prefers provider-reported nonzero cost', () => {
    const estimate = estimateUsageCost({
      backend: 'codex',
      model: 'gpt-5.5',
      usage: { ...baseUsage, inputTokens: 1_000_000, costUsd: 0.25 },
    });
    expect(estimate).toEqual({ estimatedCostUsd: 0, costSource: 'reported' });
  });

  test('estimates OpenAI token cost from input, cached input, and output', () => {
    const estimate = estimateUsageCost({
      backend: 'codex',
      model: 'gpt-5.5',
      pricedAt: '2026-05-20T00:00:00.000Z',
      usage: { ...baseUsage, inputTokens: 1_000_000, cacheReadTokens: 2_000_000, outputTokens: 500_000 },
    });
    expect(estimate.costSource).toBe('estimated');
    expect(estimate.estimatedCostUsd).toBeCloseTo(21);
    expect(estimate.costSnapshot).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.5',
      currency: 'USD',
      unit: 'tokens',
    });
  });

  test('uses OpenAI priority pricing when a pricing tier is supplied', () => {
    const estimate = estimateUsageCost({
      backend: 'codex',
      model: 'gpt-5.5',
      pricingTier: 'priority',
      pricedAt: '2026-05-20T00:00:00.000Z',
      usage: { ...baseUsage, inputTokens: 1_000_000, cacheReadTokens: 2_000_000, outputTokens: 500_000 },
    });
    expect(estimate.costSource).toBe('estimated');
    expect(estimate.estimatedCostUsd).toBeCloseTo(52.5);
    expect(estimate.costSnapshot).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.5',
      pricingTier: 'priority',
      pricingEntryId: 'openai-gpt-5.5-priority',
      sourceUrl: 'https://openai.com/api-priority-processing/',
    });
  });

  test('matches more specific model patterns before broad patterns', () => {
    const entry = findPricingEntry(BUILTIN_USAGE_PRICING_CATALOG.entries, 'openai', 'gpt-5.4-mini');
    expect(entry?.id).toBe('openai-gpt-5.4-mini-standard');
  });

  test('matches more specific model patterns within a pricing tier', () => {
    const entry = findPricingEntry(BUILTIN_USAGE_PRICING_CATALOG.entries, 'openai', 'gpt-5.4-mini', 'priority');
    expect(entry?.id).toBe('openai-gpt-5.4-mini-priority');
  });

  test('estimates Claude cache write and cache read cost', () => {
    const estimate = estimateUsageCost({
      backend: 'claude-code',
      model: 'claude-sonnet-4-6',
      usage: { ...baseUsage, inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    expect(estimate.costSource).toBe('estimated');
    expect(estimate.estimatedCostUsd).toBeCloseTo(22.05);
  });

  test('uses current Opus 4.6 pricing instead of deprecated Opus 4 pricing', () => {
    const estimate = estimateUsageCost({
      backend: 'claude-code',
      model: 'claude-opus-4-6',
      usage: { ...baseUsage, inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    expect(estimate.costSource).toBe('estimated');
    expect(estimate.estimatedCostUsd).toBeCloseTo(30);
    expect(estimate.costSnapshot?.pricingEntryId).toBe('anthropic-claude-opus-4.6-family');
  });

  test('retains deprecated Opus 4.1 pricing for older Opus ids', () => {
    const estimate = estimateUsageCost({
      backend: 'claude-code',
      model: 'claude-opus-4-1-20250805',
      usage: { ...baseUsage, inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    expect(estimate.costSource).toBe('estimated');
    expect(estimate.estimatedCostUsd).toBeCloseTo(90);
    expect(estimate.costSnapshot?.pricingEntryId).toBe('anthropic-claude-opus-4.1-family');
  });

  test('uses current Haiku 4.5 pricing before legacy Haiku pricing', () => {
    const estimate = estimateUsageCost({
      backend: 'claude-code',
      model: 'claude-haiku-4-5',
      usage: { ...baseUsage, inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    expect(estimate.costSource).toBe('estimated');
    expect(estimate.estimatedCostUsd).toBeCloseTo(6);
    expect(estimate.costSnapshot?.pricingEntryId).toBe('anthropic-claude-haiku-4.5-family');
  });

  test('estimates Kiro credits using overage value', () => {
    const estimate = estimateUsageCost({
      backend: 'kiro',
      model: 'auto',
      usage: { ...baseUsage, credits: 2.5 },
    });
    expect(estimate.costSource).toBe('estimated');
    expect(estimate.estimatedCostUsd).toBeCloseTo(0.1);
  });

  test('returns no estimate when no pricing entry matches', () => {
    const estimate = estimateUsageCost({
      backend: 'codex',
      model: 'unknown-model',
      usage: { ...baseUsage, inputTokens: 10_000 },
    });
    expect(estimate).toEqual({ estimatedCostUsd: 0, costSource: 'none' });
  });

  test('does not infer pricing for unknown mini variants from broad model prefixes', () => {
    const estimate = estimateUsageCost({
      backend: 'codex',
      model: 'gpt-5.5-mini',
      usage: { ...baseUsage, inputTokens: 1_000_000 },
    });
    expect(estimate.costSource).toBe('none');
  });

  test('applies estimate fields to usage without mutating the source object', () => {
    const source = { ...baseUsage, outputTokens: 1_000_000 };
    const priced = applyCostEstimate('codex', 'gpt-5.5', source, '2026-05-20T00:00:00.000Z');
    expect(source).toEqual({ ...baseUsage, outputTokens: 1_000_000 });
    expect(priced.estimatedCostUsd).toBeCloseTo(30);
    expect(priced.costSource).toBe('estimated');
  });

  test('does not persist zero estimated cost fields for reported or unpriced usage', () => {
    const reported = applyCostEstimate('codex', 'gpt-5.5', {
      ...baseUsage,
      costUsd: 0.42,
    });
    expect(reported.costSource).toBe('reported');
    expect(reported.estimatedCostUsd).toBeUndefined();
    expect(reported.costSnapshot).toBeUndefined();

    const unpriced = applyCostEstimate('codex', 'unknown-model', { ...baseUsage, inputTokens: 1000 });
    expect(unpriced.costSource).toBe('none');
    expect(unpriced.estimatedCostUsd).toBeUndefined();
  });

  test('supports explicit override entries passed by callers', () => {
    const override: UsagePricingEntry = {
      id: 'override',
      provider: 'openai',
      modelPattern: 'gpt-5.5',
      unit: 'tokens',
      sourceUrl: 'user',
      verifiedAt: '2026-05-20',
      effectiveDate: '2026-05-20',
      ratesPerMillion: { input: 1, cachedInput: 0.1, output: 2 },
    };
    const estimate = estimateUsageCost({
      backend: 'codex',
      model: 'gpt-5.5',
      usage: { ...baseUsage, inputTokens: 1_000_000, outputTokens: 1_000_000 },
      catalogVersion: 'override-v1',
      entries: [override, ...BUILTIN_USAGE_PRICING_CATALOG.entries],
    });
    expect(estimate.estimatedCostUsd).toBeCloseTo(3);
    expect(estimate.costSnapshot?.pricingEntryId).toBe('override');
    expect(estimate.costSnapshot?.catalogVersion).toBe('override-v1');
  });

  test('preserves an existing persisted estimate', () => {
    const estimate = estimateUsageCost({
      backend: 'codex',
      model: 'gpt-5.5',
      usage: { ...baseUsage, costSource: 'estimated', estimatedCostUsd: 12.34 },
    });
    expect(estimate).toEqual({ costSource: 'estimated', estimatedCostUsd: 12.34 });
  });
});
