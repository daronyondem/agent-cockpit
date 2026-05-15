/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ChatService } from '../src/services/chatService';
import { workspaceHash } from './helpers/workspace';


const DEFAULT_WORKSPACE = '/tmp/test-workspace';

let tmpDir: string;
let service: ChatService;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatservice-'));
  service = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
  await service.initialize();
  await service.saveSettings({
    ...(await service.getSettings()),
    defaultBackend: 'claude-code',
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('searchConversations', () => {
  test('finds by title', async () => {
    await service.createConversation('Unique Alpha Title');
    await service.createConversation('Other');

    const results = await service.searchConversations('alpha');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Unique Alpha Title');
  });

  test('finds by message content', async () => {
    const conv = await service.createConversation('Chat');
    await service.addMessage(conv.id, 'user', 'The zebra crossed the road', 'claude-code');

    const results = await service.searchConversations('zebra');
    expect(results).toHaveLength(1);
  });

  test('returns all when query is empty', async () => {
    await service.createConversation('A');
    await service.createConversation('B');

    const results = await service.searchConversations('');
    expect(results).toHaveLength(2);
  });
});

// ── Usage Tracking ──────────────────────────────────────────────────────────

describe('addUsage', () => {
  test('accumulates usage on conversation and returns both conversation and session usage', async () => {
    const conv = await service.createConversation('Usage Test');

    const updated = await service.addUsage(conv.id, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      costUsd: 0.05,
    });

    expect(updated!.conversationUsage.inputTokens).toBe(1000);
    expect(updated!.conversationUsage.outputTokens).toBe(500);
    expect(updated!.conversationUsage.cacheReadTokens).toBe(200);
    expect(updated!.conversationUsage.cacheWriteTokens).toBe(100);
    expect(updated!.conversationUsage.costUsd).toBe(0.05);

    expect(updated!.sessionUsage.inputTokens).toBe(1000);
    expect(updated!.sessionUsage.outputTokens).toBe(500);
    expect(updated!.sessionUsage.costUsd).toBe(0.05);
  });

  test('accumulates across multiple calls', async () => {
    const conv = await service.createConversation('Multi Usage');

    await service.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 0.01 });
    const updated = await service.addUsage(conv.id, { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 10, costUsd: 0.02 });

    expect(updated!.conversationUsage.inputTokens).toBe(300);
    expect(updated!.conversationUsage.outputTokens).toBe(150);
    expect(updated!.conversationUsage.cacheReadTokens).toBe(30);
    expect(updated!.conversationUsage.cacheWriteTokens).toBe(15);
    expect(updated!.conversationUsage.costUsd).toBe(0.03);
  });

  test('returns null for unknown conversation', async () => {
    const result = await service.addUsage('nonexistent', { inputTokens: 100, outputTokens: 50 } as any);
    expect(result).toBeNull();
  });

  test('returns null when usage is null', async () => {
    const conv = await service.createConversation('Null Usage');
    const result = await service.addUsage(conv.id, null as any);
    expect(result).toBeNull();
  });

  test('also tracks usage on active session', async () => {
    const conv = await service.createConversation('Session Usage');
    await service.addUsage(conv.id, { inputTokens: 500, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.03 });

    const hash = workspaceHash(DEFAULT_WORKSPACE);
    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const convEntry = index.conversations.find((c: any) => c.id === conv.id);
    const activeSession = convEntry.sessions.find((s: any) => s.active);

    expect(activeSession.usage.inputTokens).toBe(500);
    expect(activeSession.usage.outputTokens).toBe(250);
    expect(activeSession.usage.costUsd).toBe(0.03);
  });

  test('tracks usageByBackend on conversation and session', async () => {
    const conv = await service.createConversation('Backend Usage');
    await service.addUsage(conv.id, { inputTokens: 500, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.03 }, 'claude-code');

    const hash = workspaceHash(DEFAULT_WORKSPACE);
    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const convEntry = index.conversations.find((c: any) => c.id === conv.id);

    expect(convEntry.usageByBackend['claude-code'].inputTokens).toBe(500);
    expect(convEntry.usageByBackend['claude-code'].outputTokens).toBe(250);

    const activeSession = convEntry.sessions.find((s: any) => s.active);
    expect(activeSession.usageByBackend['claude-code'].inputTokens).toBe(500);
  });

  test('records usage to daily ledger with backend and model', async () => {
    const conv = await service.createConversation('Ledger Test');
    await service.addUsage(conv.id, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05 }, 'claude-code', 'claude-sonnet-4');

    // Wait for fire-and-forget ledger write
    await new Promise(resolve => setTimeout(resolve, 100));

    const ledger = await service.getUsageStats();
    const today = new Date().toISOString().slice(0, 10);
    const dayEntry = ledger.days.find((d: any) => d.date === today);
    expect(dayEntry).toBeDefined();
    const record = dayEntry!.records.find((r: any) => r.backend === 'claude-code' && r.model === 'claude-sonnet-4');
    expect(record).toBeDefined();
    expect(record!.usage.inputTokens).toBe(1000);
    expect(record!.usage.outputTokens).toBe(500);
    expect(record!.usage.costUsd).toBe(0.05);
  });

  test('defaults model to unknown when not provided', async () => {
    const conv = await service.createConversation('Ledger No Model');
    await service.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }, 'claude-code');

    await new Promise(resolve => setTimeout(resolve, 100));

    const ledger = await service.getUsageStats();
    const today = new Date().toISOString().slice(0, 10);
    const dayEntry = ledger.days.find((d: any) => d.date === today);
    const record = dayEntry!.records.find((r: any) => r.backend === 'claude-code');
    expect(record).toBeDefined();
    expect(record!.model).toBe('unknown');
  });

  test('accumulates Kiro credits across calls', async () => {
    const conv = await service.createConversation('Kiro Credits');
    await service.addUsage(conv.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, credits: 0.1 }, 'kiro');
    const updated = await service.addUsage(conv.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, credits: 0.25 }, 'kiro');

    expect(updated!.conversationUsage.credits).toBeCloseTo(0.35);
    expect(updated!.sessionUsage.credits).toBeCloseTo(0.35);
  });

  test('contextUsagePercentage is overwritten (snapshot), not accumulated', async () => {
    const conv = await service.createConversation('Kiro Context');
    await service.addUsage(conv.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, contextUsagePercentage: 30 }, 'kiro');
    const updated = await service.addUsage(conv.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, contextUsagePercentage: 55 }, 'kiro');

    expect(updated!.conversationUsage.contextUsagePercentage).toBe(55);
    expect(updated!.sessionUsage.contextUsagePercentage).toBe(55);
  });

  test('skipLedger option prevents ledger write', async () => {
    const conv = await service.createConversation('Kiro Skip Ledger');
    await service.addUsage(conv.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, credits: 0.5 }, 'kiro', undefined, { skipLedger: true });

    await new Promise(resolve => setTimeout(resolve, 100));

    const ledger = await service.getUsageStats();
    const today = new Date().toISOString().slice(0, 10);
    const dayEntry = ledger.days.find((d: any) => d.date === today);
    // No ledger entry should exist for kiro
    if (dayEntry) {
      const kiroRecord = dayEntry.records.find((r: any) => r.backend === 'kiro');
      expect(kiroRecord).toBeUndefined();
    }
  });

  test('skipLedger still persists usage on conversation and session', async () => {
    const conv = await service.createConversation('Kiro Persist');
    const updated = await service.addUsage(conv.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, credits: 0.3, contextUsagePercentage: 42 }, 'kiro', undefined, { skipLedger: true });

    expect(updated!.conversationUsage.credits).toBeCloseTo(0.3);
    expect(updated!.conversationUsage.contextUsagePercentage).toBe(42);
    expect(updated!.sessionUsage.credits).toBeCloseTo(0.3);
    expect(updated!.sessionUsage.contextUsagePercentage).toBe(42);
  });
});

describe('getUsage', () => {
  test('returns empty usage for new conversation', async () => {
    const conv = await service.createConversation('Empty Usage');
    const usage = await service.getUsage(conv.id);
    expect(usage!.inputTokens).toBe(0);
    expect(usage!.outputTokens).toBe(0);
    expect(usage!.cacheReadTokens).toBe(0);
    expect(usage!.cacheWriteTokens).toBe(0);
    expect(usage!.costUsd).toBe(0);
  });

  test('returns accumulated usage', async () => {
    const conv = await service.createConversation('Get Usage');
    await service.addUsage(conv.id, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50, costUsd: 0.05 });

    const usage = await service.getUsage(conv.id);
    expect(usage!.inputTokens).toBe(1000);
    expect(usage!.outputTokens).toBe(500);
    expect(usage!.costUsd).toBe(0.05);
  });

  test('returns null for unknown conversation', async () => {
    const result = await service.getUsage('nonexistent');
    expect(result).toBeNull();
  });
});

describe('getConversation includes usage', () => {
  test('returns empty usage for new conversation', async () => {
    const conv = await service.createConversation('With Usage');
    const loaded = await service.getConversation(conv.id);
    expect(loaded!.usage).toBeDefined();
    expect(loaded!.usage!.inputTokens).toBe(0);
    expect(loaded!.sessionUsage).toBeDefined();
    expect(loaded!.sessionUsage!.inputTokens).toBe(0);
  });

  test('returns accumulated usage and session usage', async () => {
    const conv = await service.createConversation('With Usage');
    await service.addUsage(conv.id, { inputTokens: 500, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 });

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.usage!.inputTokens).toBe(500);
    expect(loaded!.usage!.outputTokens).toBe(250);
    expect(loaded!.usage!.costUsd).toBe(0.02);

    expect(loaded!.sessionUsage!.inputTokens).toBe(500);
    expect(loaded!.sessionUsage!.outputTokens).toBe(250);
    expect(loaded!.sessionUsage!.costUsd).toBe(0.02);
  });
});

describe('listConversations includes usage', () => {
  test('returns usage in conversation list', async () => {
    const conv = await service.createConversation('List Usage');
    await service.addUsage(conv.id, { inputTokens: 300, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });

    const list = await service.listConversations();
    const found = list.find((c: any) => c.id === conv.id);
    expect(found!.usage).toBeDefined();
    expect(found!.usage!.inputTokens).toBe(300);
    expect(found!.usage!.costUsd).toBe(0.01);
  });

  test('returns null usage for conversation without usage', async () => {
    await service.createConversation('No Usage');
    const list = await service.listConversations();
    expect(list[0].usage).toBeNull();
  });
});

describe('usage stats ledger', () => {
  test('getUsageStats returns empty ledger initially', async () => {
    const ledger = await service.getUsageStats();
    expect(ledger.days).toEqual([]);
  });

  test('clearUsageStats resets ledger', async () => {
    const conv = await service.createConversation('Ledger Clear');
    await service.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }, 'claude-code');
    // Wait for ledger write
    await new Promise(resolve => setTimeout(resolve, 100));

    let ledger = await service.getUsageStats();
    expect(ledger.days.length).toBeGreaterThan(0);

    await service.clearUsageStats();
    ledger = await service.getUsageStats();
    expect(ledger.days).toEqual([]);
  });

  test('ledger accumulates across multiple addUsage calls', async () => {
    const conv = await service.createConversation('Ledger Accum');
    await service.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }, 'claude-code', 'claude-sonnet-4');
    await new Promise(resolve => setTimeout(resolve, 50));
    await service.addUsage(conv.id, { inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 }, 'claude-code', 'claude-sonnet-4');
    await new Promise(resolve => setTimeout(resolve, 100));

    const ledger = await service.getUsageStats();
    const today = new Date().toISOString().slice(0, 10);
    const dayEntry = ledger.days.find((d: any) => d.date === today);
    expect(dayEntry).toBeDefined();
    const record = dayEntry!.records.find((r: any) => r.backend === 'claude-code' && r.model === 'claude-sonnet-4');
    expect(record).toBeDefined();
    expect(record!.usage.inputTokens).toBe(300);
    expect(record!.usage.outputTokens).toBe(150);
    expect(record!.usage.costUsd).toBeCloseTo(0.03);
  });

  test('ledger separates different models for same backend', async () => {
    const conv = await service.createConversation('Ledger Models');
    await service.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }, 'claude-code', 'claude-sonnet-4');
    await new Promise(resolve => setTimeout(resolve, 50));
    await service.addUsage(conv.id, { inputTokens: 500, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.10 }, 'claude-code', 'claude-opus-4');
    await new Promise(resolve => setTimeout(resolve, 100));

    const ledger = await service.getUsageStats();
    const today = new Date().toISOString().slice(0, 10);
    const dayEntry = ledger.days.find((d: any) => d.date === today);
    expect(dayEntry!.records.length).toBe(2);

    const sonnet = dayEntry!.records.find((r: any) => r.model === 'claude-sonnet-4');
    expect(sonnet!.usage.inputTokens).toBe(100);

    const opus = dayEntry!.records.find((r: any) => r.model === 'claude-opus-4');
    expect(opus!.usage.inputTokens).toBe(500);
  });
});

// ── Workspace Memory ─────────────────────────────────────────────────────────
