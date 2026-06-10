import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { UsageLedgerStore, addToUsage, emptyUsage } from '../src/services/chat/usageLedgerStore';
import { BUILTIN_USAGE_PRICING_CATALOG } from '../src/services/usagePricing/catalog';
import { applyCostEstimate } from '../src/services/usagePricing/estimator';
import type { UsageLedger } from '../src/types';

describe('UsageLedgerStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ac-usage-ledger-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('adds usage values including Kiro-specific snapshots', () => {
    const total = emptyUsage();
    addToUsage(total, {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: 0.5,
      credits: 1.25,
      contextUsagePercentage: 40,
    });
    addToUsage(total, {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      costUsd: 1.5,
      credits: 2.75,
      contextUsagePercentage: 60,
    });

    expect(total).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
      costUsd: 2,
      costSource: 'reported',
      credits: 4,
      contextUsagePercentage: 60,
    });
  });

  test('records estimated cost snapshots for zero-cost subscription CLI usage', async () => {
    const ledgerPath = path.join(dir, 'usage-ledger.json');
    const store = new UsageLedgerStore(ledgerPath, (backend, model, usage, context) => (
      applyCostEstimate(backend, model, usage, '2026-05-20T00:00:00.000Z', undefined, undefined, context?.pricingTier)
    ));

    await store.record('codex', 'gpt-5.4', {
      ...emptyUsage(),
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    const ledger = await store.read();
    const record = ledger.days[0].records[0];
    expect(record.usage.costUsd).toBe(0);
    expect(record.usage.costSource).toBe('estimated');
    expect(record.usage.estimatedCostUsd).toBeCloseTo(17.5);
    expect(record.usage.costSnapshot).toMatchObject({
      catalogVersion: BUILTIN_USAGE_PRICING_CATALOG.version,
      pricedAt: '2026-05-20T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5.4',
      pricingEntryId: 'openai-gpt-5.4-standard',
      unit: 'tokens',
    });
  });

  test('keeps separate ledger rows for provider pricing tiers', async () => {
    const ledgerPath = path.join(dir, 'usage-ledger.json');
    const store = new UsageLedgerStore(ledgerPath, (backend, model, usage, context) => (
      applyCostEstimate(backend, model, usage, '2026-05-20T00:00:00.000Z', undefined, undefined, context?.pricingTier)
    ));

    await store.record('codex', 'gpt-5.5', {
      ...emptyUsage(),
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    await store.record('codex', 'gpt-5.5', {
      ...emptyUsage(),
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, { pricingTier: 'priority' });

    const ledger = await store.read();
    expect(ledger.days[0].records).toHaveLength(2);
    const standard = ledger.days[0].records.find(record => !record.pricingTier);
    const priority = ledger.days[0].records.find(record => record.pricingTier === 'priority');
    expect(standard?.usage.estimatedCostUsd).toBeCloseTo(35);
    expect(priority?.usage.estimatedCostUsd).toBeCloseTo(87.5);
    expect(priority?.usage.costSnapshot).toMatchObject({
      pricingTier: 'priority',
      pricingEntryId: 'openai-gpt-5.5-priority',
    });
  });

  test('records usage on an explicit ledger date', async () => {
    const ledgerPath = path.join(dir, 'usage-ledger.json');
    const store = new UsageLedgerStore(ledgerPath);

    await store.recordForDate('2026-06-02', 'claude-code', 'claude-sonnet-4-6', {
      ...emptyUsage(),
      inputTokens: 10,
      outputTokens: 5,
    });

    const ledger = await store.read();
    expect(ledger.days).toEqual([{
      date: '2026-06-02',
      records: [{
        backend: 'claude-code',
        model: 'claude-sonnet-4-6',
        usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 5 },
      }],
    }]);
  });

  test('lazily enriches historical zero-cost ledger rows without repricing stored estimates', async () => {
    const ledgerPath = path.join(dir, 'usage-ledger.json');
    await fsp.writeFile(ledgerPath, JSON.stringify({
      days: [{
        date: '2026-05-20',
        records: [{
          backend: 'claude-code',
          model: 'claude-sonnet-4',
          usage: { ...emptyUsage(), inputTokens: 1_000_000, outputTokens: 1_000_000 },
        }],
      }],
    }), 'utf8');

    const store = new UsageLedgerStore(ledgerPath, (backend, model, usage, context) => (
      applyCostEstimate(backend, model, usage, '2026-05-20T00:00:00.000Z', undefined, undefined, context?.pricingTier)
    ));

    const enriched = await store.enrichMissingCosts();
    expect(enriched.days[0].records[0].usage.costSource).toBe('estimated');
    expect(enriched.days[0].records[0].usage.estimatedCostUsd).toBeCloseTo(18);

    const repricingStore = new UsageLedgerStore(ledgerPath, (_backend, _model, usage) => ({
      ...usage,
      costSource: 'estimated',
      estimatedCostUsd: 999,
    }));
    const preserved = await repricingStore.enrichMissingCosts();
    expect(preserved.days[0].records[0].usage.estimatedCostUsd).toBeCloseTo(18);
  });

  test('normalizes legacy day buckets during lazy enrichment', async () => {
    const ledgerPath = path.join(dir, 'usage-ledger.json');
    const legacy: UsageLedger & { days: Array<UsageLedger['days'][number] & { backends?: Record<string, ReturnType<typeof emptyUsage>> }> } = {
      days: [{
        date: '2026-05-20',
        records: undefined as unknown as UsageLedger['days'][number]['records'],
        backends: { codex: { ...emptyUsage(), inputTokens: 1_000_000, outputTokens: 1_000_000 } },
      }],
    };
    await fsp.writeFile(ledgerPath, JSON.stringify(legacy), 'utf8');

    const store = new UsageLedgerStore(ledgerPath, (backend, model, usage, context) => (
      applyCostEstimate(backend, model, usage, '2026-05-20T00:00:00.000Z', undefined, undefined, context?.pricingTier)
    ));
    const enriched = await store.enrichMissingCosts();

    expect(enriched.days[0].records).toEqual([
      { backend: 'codex', model: 'unknown', usage: { ...emptyUsage(), inputTokens: 1_000_000, outputTokens: 1_000_000, costSource: 'none' } },
    ]);
    expect('backends' in enriched.days[0]).toBe(false);

    const persisted = JSON.parse(await fsp.readFile(ledgerPath, 'utf8'));
    expect('backends' in persisted.days[0]).toBe(false);
  });

  test('removes legacy backends when records already exist', async () => {
    const ledgerPath = path.join(dir, 'usage-ledger.json');
    await fsp.writeFile(ledgerPath, JSON.stringify({
      days: [{
        date: '2026-05-20',
        records: [{ backend: 'codex', model: 'gpt-5.4', usage: { ...emptyUsage(), outputTokens: 1000 } }],
        backends: { codex: { ...emptyUsage(), inputTokens: 1000 } },
      }],
    }), 'utf8');

    const store = new UsageLedgerStore(ledgerPath);
    const ledger = await store.enrichMissingCosts();

    expect(ledger.days[0].records).toHaveLength(2);
    expect(ledger.days[0].records.find(record => record.model === 'unknown')?.usage.inputTokens).toBe(1000);
    expect('backends' in ledger.days[0]).toBe(false);
  });

  test('records per-backend model usage and migrates legacy day buckets', async () => {
    const ledgerPath = path.join(dir, 'usage-ledger.json');
    const legacy: UsageLedger & { days: Array<UsageLedger['days'][number] & { backends?: Record<string, ReturnType<typeof emptyUsage>> }> } = {
      days: [{
        date: new Date().toISOString().slice(0, 10),
        records: undefined as unknown as UsageLedger['days'][number]['records'],
        backends: { codex: { ...emptyUsage(), inputTokens: 3 } },
      }],
    };
    await fsp.writeFile(ledgerPath, JSON.stringify(legacy), 'utf8');

    const store = new UsageLedgerStore(ledgerPath);
    await store.record('codex', 'gpt-5.4', { ...emptyUsage(), outputTokens: 5 });
    const ledger = await store.read();

    expect(ledger.days).toHaveLength(1);
    expect(ledger.days[0].records).toEqual([
      { backend: 'codex', model: 'unknown', usage: { ...emptyUsage(), inputTokens: 3 } },
      { backend: 'codex', model: 'gpt-5.4', usage: { ...emptyUsage(), outputTokens: 5 } },
    ]);
    expect('backends' in ledger.days[0]).toBe(false);
  });
});
