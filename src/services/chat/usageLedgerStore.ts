import fsp from 'fs/promises';
import type { Usage, UsageLedger, UsageLedgerDay } from '../../types';
import { atomicWriteFile } from '../../utils/atomicWrite';
import { KeyedMutex } from '../../utils/keyedMutex';

const LEDGER_LOCK_KEY = '__usage_ledger__';

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

export function addToUsage(target: Usage, source: Usage): void {
  target.inputTokens += source.inputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  target.cacheReadTokens += source.cacheReadTokens || 0;
  target.cacheWriteTokens += source.cacheWriteTokens || 0;
  target.costUsd += source.costUsd || 0;
  if (source.credits !== undefined) {
    target.credits = (target.credits || 0) + source.credits;
  }
  if (source.contextUsagePercentage !== undefined) {
    target.contextUsagePercentage = source.contextUsagePercentage;
  }
}

export class UsageLedgerStore {
  private readonly lock = new KeyedMutex();

  constructor(private readonly ledgerFile: string) {}

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

  async record(backendId: string, model: string, usage: Usage): Promise<void> {
    await this.lock.run(LEDGER_LOCK_KEY, async () => {
      const ledger = await this.read();
      const today = new Date().toISOString().slice(0, 10);

      let dayEntry = ledger.days.find(d => d.date === today);
      if (!dayEntry) {
        dayEntry = { date: today, records: [] };
        ledger.days.push(dayEntry);
      }

      const legacy = dayEntry as UsageLedgerDay & { backends?: Record<string, Usage> };
      if (legacy.backends && !legacy.records) {
        legacy.records = [];
        for (const [bid, u] of Object.entries(legacy.backends)) {
          legacy.records.push({ backend: bid, model: 'unknown', usage: u });
        }
        delete legacy.backends;
      }

      let record = dayEntry.records.find(r => r.backend === backendId && r.model === model);
      if (!record) {
        record = { backend: backendId, model, usage: emptyUsage() };
        dayEntry.records.push(record);
      }
      addToUsage(record.usage, usage);

      await this.write(ledger);
    });
  }

  async clear(): Promise<void> {
    await this.lock.run(LEDGER_LOCK_KEY, async () => {
      await this.write({ days: [] });
    });
  }
}
