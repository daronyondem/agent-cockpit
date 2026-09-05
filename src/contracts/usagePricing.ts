import { asRecord, contractError, requiredNonEmptyString } from './validation';

export type UsagePricingProvider = 'openai' | 'anthropic' | 'kiro';
export type UsagePricingUnit = 'tokens' | 'credits';
export type UsageCostSource = 'reported' | 'estimated' | 'none';
export type UsagePricingTier = string;

export interface UsageTokenRatesPerMillion {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
}

export interface UsagePricingEntry {
  id: string;
  provider: UsagePricingProvider;
  modelPattern: string;
  /** Optional provider pricing tier, such as OpenAI priority processing. */
  pricingTier?: UsagePricingTier;
  unit: UsagePricingUnit;
  sourceUrl: string;
  verifiedAt: string;
  effectiveDate: string;
  ratesPerMillion?: UsageTokenRatesPerMillion;
  longContextThresholdTokens?: number;
  longContextRatesPerMillion?: UsageTokenRatesPerMillion;
  usdPerCredit?: number;
}

export interface UsagePricingCatalog {
  schemaVersion: 1;
  version: string;
  currency: 'USD';
  entries: UsagePricingEntry[];
}

export interface UsageCostSnapshot {
  catalogVersion: string;
  pricedAt: string;
  provider: UsagePricingProvider;
  model: string;
  pricingTier?: UsagePricingTier;
  pricingEntryId: string;
  sourceUrl: string;
  verifiedAt: string;
  effectiveDate: string;
  currency: 'USD';
  unit: UsagePricingUnit;
  ratesPerMillion?: UsageTokenRatesPerMillion;
  longContextThresholdTokens?: number;
  usdPerCredit?: number;
}

export interface UsagePricingResponse {
  builtin: UsagePricingCatalog;
  overrides: UsagePricingCatalog;
  effective: UsagePricingCatalog;
}

export interface UsagePricingOverridesRequest {
  entries: UsagePricingEntry[];
}

export function validateUsagePricingOverridesRequest(body: unknown): UsagePricingOverridesRequest {
  const record = asRecord(body, 'usage pricing overrides request must be an object');
  if (!Array.isArray(record.entries)) contractError('usage pricing overrides entries must be an array');
  const entries = record.entries.map(validateUsagePricingEntry);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) contractError(`usage pricing overrides duplicate entry id: ${entry.id}`);
    ids.add(entry.id);
  }
  return {
    entries,
  };
}

function validateUsagePricingEntry(value: unknown, index: number): UsagePricingEntry {
  const record = asRecord(value, `usage pricing overrides entries[${index}] must be an object`);
  const provider = requiredEnum(record, 'provider', ['openai', 'anthropic', 'kiro'], `usage pricing overrides entries[${index}].provider is invalid`);
  const unit = requiredEnum(record, 'unit', ['tokens', 'credits'], `usage pricing overrides entries[${index}].unit is invalid`);
  const entry: UsagePricingEntry = {
    id: requiredNonEmptyString(record, 'id', `usage pricing overrides entries[${index}].id is required`),
    provider,
    modelPattern: requiredNonEmptyString(record, 'modelPattern', `usage pricing overrides entries[${index}].modelPattern is required`),
    unit,
    sourceUrl: requiredNonEmptyString(record, 'sourceUrl', `usage pricing overrides entries[${index}].sourceUrl is required`),
    verifiedAt: requiredNonEmptyString(record, 'verifiedAt', `usage pricing overrides entries[${index}].verifiedAt is required`),
    effectiveDate: requiredNonEmptyString(record, 'effectiveDate', `usage pricing overrides entries[${index}].effectiveDate is required`),
  };
  if (record.pricingTier !== undefined) {
    entry.pricingTier = requiredNonEmptyString(record, 'pricingTier', `usage pricing overrides entries[${index}].pricingTier must be a non-empty string`);
  }

  if (unit === 'tokens') {
    const rates = asRecord(record.ratesPerMillion, `usage pricing overrides entries[${index}].ratesPerMillion must be an object`);
    entry.ratesPerMillion = validateTokenRates(rates, `usage pricing overrides entries[${index}].ratesPerMillion`);
    if (record.longContextThresholdTokens !== undefined || record.longContextRatesPerMillion !== undefined) {
      entry.longContextThresholdTokens = requiredPositiveNumber(record.longContextThresholdTokens, `usage pricing overrides entries[${index}].longContextThresholdTokens must be a positive number`);
      const longRates = asRecord(record.longContextRatesPerMillion, `usage pricing overrides entries[${index}].longContextRatesPerMillion must be an object`);
      entry.longContextRatesPerMillion = validateTokenRates(longRates, `usage pricing overrides entries[${index}].longContextRatesPerMillion`);
    }
  } else {
    entry.usdPerCredit = requiredNonNegativeNumber(record.usdPerCredit, `usage pricing overrides entries[${index}].usdPerCredit must be a non-negative number`);
  }

  return entry;
}

function requiredEnum<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[], message: string): T {
  const value = record[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) contractError(message);
  return value as T;
}

function requiredNonNegativeNumber(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) contractError(message);
  return value;
}

function requiredPositiveNumber(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) contractError(message);
  return value;
}

function validateTokenRates(record: Record<string, unknown>, field: string): UsageTokenRatesPerMillion {
  const rates: UsageTokenRatesPerMillion = {
    input: requiredNonNegativeNumber(record.input, `${field}.input must be a non-negative number`),
    output: requiredNonNegativeNumber(record.output, `${field}.output must be a non-negative number`),
  };
  if (record.cachedInput !== undefined) {
    rates.cachedInput = requiredNonNegativeNumber(record.cachedInput, `${field}.cachedInput must be a non-negative number`);
  }
  if (record.cacheWrite !== undefined) {
    rates.cacheWrite = requiredNonNegativeNumber(record.cacheWrite, `${field}.cacheWrite must be a non-negative number`);
  }
  return rates;
}
