import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { UsageLedgerStore, addToUsage, emptyUsage } from '../src/services/chat/usageLedgerStore';
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
      credits: 4,
      contextUsagePercentage: 60,
    });
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
