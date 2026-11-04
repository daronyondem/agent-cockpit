import fs from 'fs';
import os from 'os';
import path from 'path';
import { copilotTurnUsage, copilotUsageCheckpoint, copilotUsageMetrics, readCopilotUsageBaseline } from '../src/services/backends/copilotUsage';

function checkpoint(input = 10, output = 20, credits = 2) {
  return {
    type: 'session.usage_checkpoint',
    data: {
      totalPremiumRequests: credits,
      accountingSnapshot: {
        tokenDetails: {
          input: { tokenCount: input }, output: { tokenCount: output },
          cache_read: { tokenCount: 30 }, cache_write: { tokenCount: 40 },
        },
      },
    },
  };
}

describe('Copilot native usage', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  test('parses the disjoint token buckets from current CLI checkpoints', () => {
    expect(copilotUsageCheckpoint(checkpoint())).toMatchObject({
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40,
      credits: 2, costUsd: 0, costSource: 'none',
    });
  });

  test('rejects malformed counters and unrelated events', () => {
    expect(copilotUsageCheckpoint(checkpoint(-1))).toBeNull();
    expect(copilotUsageCheckpoint(checkpoint(NaN))).toBeNull();
    expect(copilotUsageCheckpoint({ type: 'session.usage_checkpoint', data: {} })).toBeNull();
    expect(copilotUsageCheckpoint({ type: 'assistant.message' })).toBeNull();
  });

  test('subtracts cumulative session totals without double-counting cache tokens or credits', () => {
    expect(copilotTurnUsage(copilotUsageCheckpoint(checkpoint(15, 27, 3))!, copilotUsageCheckpoint(checkpoint())!)).toMatchObject({
      inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0,
      credits: 1, costUsd: 0, costSource: 'none',
    });
  });

  test('clamps reset counters instead of emitting negative usage', () => {
    const current = copilotUsageCheckpoint(checkpoint(0, 0, 0))!;
    const previous = copilotUsageCheckpoint(checkpoint())!;
    expect(copilotTurnUsage(current, previous)).toMatchObject({ inputTokens: 0, outputTokens: 0, credits: 0 });
  });

  test('reads the latest saved checkpoint with incomplete trailing data', async () => {
    const dir = path.join(home, 'session-state', 'native-session');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      JSON.stringify(checkpoint(1, 2, 1)),
      JSON.stringify(checkpoint()),
      '{"type":"session.usage_checkpoint",',
    ].join('\n'));
    expect(await readCopilotUsageBaseline('native-session', { COPILOT_HOME: home })).toEqual(copilotUsageCheckpoint(checkpoint()));
    expect(await readCopilotUsageBaseline('native-session', { COPILOT_HOME: home })).toEqual(copilotUsageCheckpoint(checkpoint()));
  });

  test('reads a checkpoint near the end of a large transcript', async () => {
    const dir = path.join(home, 'session-state', 'large');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), 'x'.repeat(4 * 1024 * 1024) + '\n' + JSON.stringify(checkpoint()) + '\n');
    expect(await readCopilotUsageBaseline('large', { COPILOT_HOME: home })).toEqual(copilotUsageCheckpoint(checkpoint()));
  });

  test('does not invent a baseline for missing sessions or unsafe IDs', async () => {
    expect(await readCopilotUsageBaseline('missing', { COPILOT_HOME: home })).toBeNull();
    expect(await readCopilotUsageBaseline('../outside', { COPILOT_HOME: home })).toBeNull();
  });
});

describe('Copilot SDK reconciled metrics', () => {
  const model = (input = 120, output = 30, read = 40, write = 10) => ({ usage: {
    inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write,
  } });

  test('makes model input disjoint from both cache buckets and counts aggregate children once', () => {
    const usage = copilotUsageMetrics({ modelMetrics: { root: model(), child: model(60, 15, 20, 5) },
      agentMetrics: { main: { modelMetrics: { root: model() } } }, totalPremiumRequestCost: 1.5, totalNanoAiu: 900 });
    expect(usage).toMatchObject({ inputTokens: 105, outputTokens: 45, cacheReadTokens: 60, cacheWriteTokens: 15,
      credits: 1.5, costUsd: 0, costSource: 'none' });
  });

  test('prefers provider aggregates without collapsing identical model IDs or adding overlapping maps', () => {
    expect(copilotUsageMetrics({ providerModelMetrics: [{ modelId: 'same', metrics: model() }, { modelId: 'same', metrics: model(60, 15, 20, 5) }],
      modelMetrics: { same: model(999, 999, 0, 0) } })).toMatchObject({ inputTokens: 105, outputTokens: 45,
      cacheReadTokens: 60, cacheWriteTokens: 15, costUsd: 0, costSource: 'none' });
  });

  test('prefers authoritative disjoint token details and never converts nano-AIU into legacy credits', () => {
    expect(copilotUsageMetrics({ tokenDetails: checkpoint().data.accountingSnapshot.tokenDetails, modelMetrics: { model: model() }, totalNanoAiu: 100 })).toMatchObject({
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, costUsd: 0, costSource: 'none',
    });
    expect(copilotTurnUsage({ inputTokens: 15, outputTokens: 25, cacheReadTokens: 35, cacheWriteTokens: 45, costUsd: 0 }, copilotUsageCheckpoint(checkpoint())!)).not.toHaveProperty('credits');
  });

  test('accepts an explicitly empty new-session ledger without inventing missing metrics', () => {
    expect(copilotUsageMetrics({ modelMetrics: {}, totalUserRequests: 0, totalPremiumRequestCost: 0 })).toMatchObject({ inputTokens: 0, credits: 0 });
    expect(copilotUsageMetrics({ providerModelMetrics: [], totalNanoAiu: 100 })).toBeNull();
    expect(copilotUsageMetrics({ totalNanoAiu: 100 })).toBeNull();
  });

  test.each([model(NaN), model(-1), model(10, 30, 40), { usage: { inputTokens: 120, outputTokens: 30 } }, undefined])('rejects incomplete or inconsistent model counters: %j', metric => {
    expect(copilotUsageMetrics({ modelMetrics: { model: metric } })).toBeNull();
  });
});
