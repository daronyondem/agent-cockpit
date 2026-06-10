import fsp from 'fs/promises';
import type { Usage, UsageLedger, UsageLedgerDay } from '../../types';
import { atomicWriteFile } from '../../utils/atomicWrite';
import { KeyedMutex } from '../../utils/keyedMutex';
import type { UsagePricingContext } from '../usagePricing/types';

const LEDGER_LOCK_KEY = '__usage_ledger__';

export type UsageCostEnricher = (backendId: string, model: string, usage: Usage, context?: UsagePricingContext) => Usage;

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

export function addToUsage(target: Usage, source: Usage): void {
  target.inputTokens += source.inputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  target.cacheReadTokens += source.cacheReadTokens || 0;
  target.cacheWriteTokens += source.cacheWriteTokens || 0;
  target.costUsd += source.costUsd || 0;
  if (source.estimatedCostUsd !== undefined) {
    target.estimatedCostUsd = (target.estimatedCostUsd || 0) + source.estimatedCostUsd;
  }
  const nextCostSource = mergeCostSource(target.costSource, source.costSource, target, source);
  if (nextCostSource !== undefined) target.costSource = nextCostSource;
  if (source.costSnapshot) target.costSnapshot = source.costSnapshot;
  if (source.credits !== undefined) {
    target.credits = (target.credits || 0) + source.credits;
  }
  if (source.contextUsagePercentage !== undefined) {
    target.contextUsagePercentage = source.contextUsagePercentage;
  }
}

export class UsageLedgerStore {
  private readonly lock = new KeyedMutex();

  constructor(private readonly ledgerFile: string, private readonly enrichUsageCost?: UsageCostEnricher) {}

  async read(): Promise<UsageLedger> {
    try {
      const data = await fsp.readFile(this.ledgerFile, 'utf8');
      return JSON.parse(data) as UsageLedger;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { days: [] };
      throw err;
    }
  }

  async write(ledger: UsageLedger): Promise<void> {
    await atomicWriteFile(this.ledgerFile, JSON.stringify(ledger, null, 2));
  }

  async record(backendId: string, model: string, usage: Usage, context?: UsagePricingContext): Promise<void> {
    await this.recordForDate(new Date().toISOString().slice(0, 10), backendId, model, usage, context);
  }

  async recordForDate(date: string, backendId: string, model: string, usage: Usage, context?: UsagePricingContext): Promise<void> {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
    await this.lock.run(LEDGER_LOCK_KEY, async () => {
      const ledger = await this.read();
      const pricingTier = context?.pricingTier || usage.pricingTier;
      const pricingContext = pricingTier ? { pricingTier } : undefined;

      let dayEntry = ledger.days.find(d => d.date === day);
      if (!dayEntry) {
        dayEntry = { date: day, records: [] };
        ledger.days.push(dayEntry);
      }

      const legacy = dayEntry as UsageLedgerDay & { backends?: Record<string, Usage> };
      normalizeDayRecords(legacy);

      let record = dayEntry.records.find(r => (
        r.backend === backendId
        && r.model === model
        && (r.pricingTier || '') === (pricingTier || '')
      ));
      if (!record) {
        record = { backend: backendId, model, ...(pricingTier ? { pricingTier } : {}), usage: emptyUsage() };
        dayEntry.records.push(record);
      }
      addToUsage(record.usage, this._enrich(backendId, model, usage, pricingContext));

      await this.write(ledger);
    });
  }

  async enrichMissingCosts(): Promise<UsageLedger> {
    return this.lock.run(LEDGER_LOCK_KEY, async () => {
      const ledger = await this.read();
      let changed = false;

      for (const day of ledger.days || []) {
        const legacy = day as UsageLedgerDay & { backends?: Record<string, Usage> };
        if (normalizeDayRecords(legacy)) changed = true;
        if (!day.records) continue;
        for (const record of day.records) {
          if (!shouldEnrichCost(record.usage)) continue;
          const pricingContext = record.pricingTier ? { pricingTier: record.pricingTier } : undefined;
          const enriched = this._enrich(record.backend, record.model, record.usage, pricingContext);
          if (!usageCostEqual(record.usage, enriched)) {
            record.usage = enriched;
            changed = true;
          }
        }
      }

      if (changed) await this.write(ledger);
      return ledger;
    });
  }

  async clear(): Promise<void> {
    await this.lock.run(LEDGER_LOCK_KEY, async () => {
      await this.write({ days: [] });
    });
  }

  private _enrich(backendId: string, model: string, usage: Usage, context?: UsagePricingContext): Usage {
    return this.enrichUsageCost ? this.enrichUsageCost(backendId, model, usage, context) : usage;
  }
}

function normalizeDayRecords(day: UsageLedgerDay & { backends?: Record<string, Usage> }): boolean {
  if (!day.backends) return false;
  if (!day.records) day.records = [];
  for (const [backend, usage] of Object.entries(day.backends)) {
    const exists = day.records.some(record => record.backend === backend && record.model === 'unknown');
    if (!exists) day.records.push({ backend, model: 'unknown', usage });
  }
  delete day.backends;
  return true;
}

function mergeCostSource(
  current: Usage['costSource'],
  incoming: Usage['costSource'],
  target: Usage,
  source: Usage,
): Usage['costSource'] | undefined {
  const normalizedCurrent = current || inferCostSource(target);
  const normalizedIncoming = incoming || inferCostSource(source);
  if (normalizedCurrent === 'estimated' || normalizedIncoming === 'estimated') return 'estimated';
  if (normalizedCurrent === 'reported' || normalizedIncoming === 'reported') return 'reported';
  if (normalizedCurrent === 'none' || normalizedIncoming === 'none') return 'none';
  return undefined;
}

function inferCostSource(usage: Usage): Usage['costSource'] | undefined {
  if ((usage.estimatedCostUsd || 0) > 0) return 'estimated';
  if ((usage.costUsd || 0) > 0) return 'reported';
  return undefined;
}

function shouldEnrichCost(usage: Usage): boolean {
  if (usage.costSource === 'estimated' && usage.estimatedCostUsd !== undefined) return false;
  if (usage.costSource === 'reported') return false;
  return true;
}

function usageCostEqual(a: Usage, b: Usage): boolean {
  return a.costSource === b.costSource
    && a.estimatedCostUsd === b.estimatedCostUsd
    && JSON.stringify(a.costSnapshot || null) === JSON.stringify(b.costSnapshot || null);
}
