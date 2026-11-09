import { CopilotLiveUsage } from '../src/services/backends/copilotLiveUsage';
import { copilotContextUsage, copilotTurnUsage, copilotUsageMetrics } from '../src/services/backends/copilotUsage';
import { addToUsage, emptyUsage } from '../src/services/chat/usageLedgerStore';
import type { Usage } from '../src/types';

const metrics = (tokens: number, nano: number, status = 'complete') => copilotUsageMetrics({
  totalUserRequests: tokens ? 1 : 0, totalPremiumRequestCost: 0, totalNanoAiu: nano, aiCreditsStatus: status,
  modelMetrics: tokens ? { fixture: { usage: { inputTokens: tokens, outputTokens: 2 * tokens, cacheReadTokens: tokens / 2, cacheWriteTokens: 0 } } } : {},
})!;

test('reconciles live and final snapshots once, including fractional AI credits and disjoint cache tokens', async () => {
  const emitted: Usage[] = [];
  const read = jest.fn().mockResolvedValueOnce(metrics(120, 1.5e9)).mockResolvedValueOnce(metrics(140, 2e9)).mockResolvedValue(metrics(140, 2e9));
  const live = new CopilotLiveUsage(metrics(100, 1e9), read, usage => emitted.push(usage));
  live.request();
  await live.finish();
  const total = emptyUsage();
  emitted.forEach(usage => addToUsage(total, usage));
  expect(total).toMatchObject({ inputTokens: 20, outputTokens: 80, cacheReadTokens: 20,
    copilot: { tokensStatus: 'complete', aiCreditsStatus: 'complete', aiCredits: 1 } });
  await live.finish();
  expect(emitted).toHaveLength(2);
});

test('coalesces in-flight updates while retaining a changed checkpoint', async () => {
  let resolve!: (usage: Usage) => void;
  const read = jest.fn().mockImplementationOnce(() => new Promise<Usage>(done => { resolve = done; })).mockResolvedValue(metrics(30, 3e9));
  const emitted: Usage[] = [];
  const live = new CopilotLiveUsage(metrics(0, 0), read, usage => emitted.push(usage));
  live.request(); live.request(); live.request();
  expect(read).toHaveBeenCalledTimes(1);
  resolve(metrics(20, 2e9));
  await live.finish();
  const total = emptyUsage(); emitted.forEach(usage => addToUsage(total, usage));
  expect(total.copilot?.aiCredits).toBe(3);
  expect(total.outputTokens).toBe(60);
});

test('missing baseline never charges historical tokens or claims zero credits', async () => {
  const emitted: Usage[] = [];
  const live = new CopilotLiveUsage(null, async () => metrics(100, 2e9), usage => emitted.push(usage));
  await live.finish(); await live.finish();
  expect(emitted).toHaveLength(1);
  expect(emitted[0].copilot).toEqual({ tokensStatus: 'unavailable', aiCreditsStatus: 'unavailable' });
  expect(emitted[0].inputTokens).toBe(0);
  expect(emitted[0].copilot).not.toHaveProperty('aiCredits');
});

test('failed live read can recover without resetting the charged checkpoint', async () => {
  const emitted: Usage[] = [];
  const read = jest.fn().mockResolvedValueOnce(null).mockResolvedValue(metrics(20, 2e9));
  const live = new CopilotLiveUsage(metrics(10, 1e9), read, usage => emitted.push(usage));
  live.request(); await live.finish();
  const total = emptyUsage(); emitted.forEach(usage => addToUsage(total, usage));
  expect(total).toMatchObject({ inputTokens: 5, copilot: { tokensStatus: 'partial', aiCreditsStatus: 'partial', aiCredits: 1 } });
});

test('unavailable and partial native AI-credit observations never become complete zero-cost claims', () => {
  expect(metrics(20, 0, 'unavailable').copilot).toEqual({ tokensStatus: 'complete', aiCreditsStatus: 'unavailable', premiumRequests: 0 });
  const partial = copilotTurnUsage(metrics(30, 4e9, 'partial'), metrics(20, 1e9, 'partial'));
  expect(partial.copilot).toMatchObject({ aiCredits: 3, aiCreditsStatus: 'partial' });
  expect(copilotTurnUsage(metrics(30, 4e9), metrics(20, 0, 'unavailable')).copilot).toMatchObject({ aiCreditsStatus: 'unavailable' });
  expect(copilotTurnUsage(metrics(30, 0), metrics(0, 0, 'unavailable')).copilot).toMatchObject({ aiCreditsStatus: 'complete', aiCredits: 0 });
  const missing = { ...metrics(0, 0, 'unavailable'), nativeEmpty: undefined };
  expect(copilotTurnUsage(metrics(30, 0), missing).copilot).toMatchObject({ aiCreditsStatus: 'unavailable' });
});

test('context is a replaceable snapshot, with missing limits clearing stale percentages', () => {
  const total = emptyUsage();
  addToUsage(total, copilotContextUsage(200, 1000, '2026-11-04T20:00:00Z'));
  addToUsage(total, copilotContextUsage(100, 1000, '2026-11-04T20:01:00Z'));
  expect(total.contextUsagePercentage).toBe(10);
  expect(total.contextWindow?.usedTokens).toBe(100);
  expect(total.inputTokens).toBe(0);
  addToUsage(total, copilotContextUsage(10, 0, '2026-11-04T20:02:00Z'));
  expect(total).not.toHaveProperty('contextUsagePercentage');
  expect(total.contextWindow?.status).toBe('unavailable');
});
