import rawCatalog from './catalog.default.json';
import type { UsagePricingCatalog, UsagePricingEntry } from './types';

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`usage pricing catalog ${field} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`usage pricing catalog ${field} must be a non-negative number`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`usage pricing catalog ${field} must be a positive number`);
  }
  return value;
}

function validateTokenRates(value: unknown, field: string) {
  if (!isObject(value)) {
    throw new Error(`usage pricing catalog ${field} must be an object`);
  }
  const rates = {
    input: requireNumber(value.input, `${field}.input`),
    output: requireNumber(value.output, `${field}.output`),
  };
  if (value.cachedInput !== undefined) {
    Object.assign(rates, { cachedInput: requireNumber(value.cachedInput, `${field}.cachedInput`) });
  }
  if (value.cacheWrite !== undefined) {
    Object.assign(rates, { cacheWrite: requireNumber(value.cacheWrite, `${field}.cacheWrite`) });
  }
  return rates;
}

function validateEntry(value: unknown, index: number): UsagePricingEntry {
  if (!isObject(value)) throw new Error(`usage pricing catalog entries[${index}] must be an object`);
  const provider = requireString(value.provider, `entries[${index}].provider`);
  if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'kiro') {
    throw new Error(`usage pricing catalog entries[${index}].provider is unsupported`);
  }
  const unit = requireString(value.unit, `entries[${index}].unit`);
  if (unit !== 'tokens' && unit !== 'credits') {
    throw new Error(`usage pricing catalog entries[${index}].unit is unsupported`);
  }

  const entry: UsagePricingEntry = {
    id: requireString(value.id, `entries[${index}].id`),
    provider,
    modelPattern: requireString(value.modelPattern, `entries[${index}].modelPattern`),
    unit,
    sourceUrl: requireString(value.sourceUrl, `entries[${index}].sourceUrl`),
    verifiedAt: requireString(value.verifiedAt, `entries[${index}].verifiedAt`),
    effectiveDate: requireString(value.effectiveDate, `entries[${index}].effectiveDate`),
  };
  if (value.pricingTier !== undefined) {
    entry.pricingTier = requireString(value.pricingTier, `entries[${index}].pricingTier`);
  }

  if (unit === 'tokens') {
    entry.ratesPerMillion = validateTokenRates(value.ratesPerMillion, `entries[${index}].ratesPerMillion`);
    if (value.longContextThresholdTokens !== undefined || value.longContextRatesPerMillion !== undefined) {
      entry.longContextThresholdTokens = requirePositiveNumber(value.longContextThresholdTokens, `entries[${index}].longContextThresholdTokens`);
      entry.longContextRatesPerMillion = validateTokenRates(value.longContextRatesPerMillion, `entries[${index}].longContextRatesPerMillion`);
    }
  } else {
    entry.usdPerCredit = requireNumber(value.usdPerCredit, `entries[${index}].usdPerCredit`);
  }

  return entry;
}

export function validateUsagePricingCatalog(value: unknown): UsagePricingCatalog {
  if (!isObject(value)) throw new Error('usage pricing catalog must be an object');
  if (value.schemaVersion !== 1) throw new Error('usage pricing catalog schemaVersion must be 1');
  if (value.currency !== 'USD') throw new Error('usage pricing catalog currency must be USD');
  if (!Array.isArray(value.entries)) throw new Error('usage pricing catalog entries must be an array');

  const catalog: UsagePricingCatalog = {
    schemaVersion: 1,
    version: requireString(value.version, 'version'),
    currency: 'USD',
    entries: value.entries.map(validateEntry),
  };

  const ids = new Set<string>();
  for (const entry of catalog.entries) {
    if (ids.has(entry.id)) throw new Error(`usage pricing catalog duplicate entry id: ${entry.id}`);
    ids.add(entry.id);
  }

  return catalog;
}

export const BUILTIN_USAGE_PRICING_CATALOG = validateUsagePricingCatalog(rawCatalog);
