import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ClaudeTranscriptUsageImportService } from '../src/services/claudeTranscriptUsageImportService';
import { UsageLedgerStore } from '../src/services/chat/usageLedgerStore';

describe('ClaudeTranscriptUsageImportService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ac-claude-usage-import-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('imports non-owned Claude transcript usage and skips Agent Cockpit sessions idempotently', async () => {
    const configRoot = path.join(dir, 'claude-home');
    const projectDir = path.join(configRoot, 'projects', '-tmp-workspace');
    await fsp.mkdir(projectDir, { recursive: true });
    await fsp.writeFile(path.join(projectDir, 'outside-session.jsonl'), `${JSON.stringify({
      uuid: 'usage-1',
      type: 'assistant',
      timestamp: '2026-06-02T03:04:05.000Z',
      message: {
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      },
      cost_usd: 0.01,
    })}\n`, 'utf8');
    await fsp.writeFile(path.join(projectDir, 'owned-session.jsonl'), `${JSON.stringify({
      uuid: 'usage-2',
      type: 'assistant',
      timestamp: '2026-06-02T03:04:05.000Z',
      message: {
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 999,
          output_tokens: 999,
        },
      },
    })}\n`, 'utf8');

    const ledgerStore = new UsageLedgerStore(path.join(dir, 'usage-ledger.json'));
    const importer = new ClaudeTranscriptUsageImportService(
      path.join(dir, 'claude-transcript-usage-import.json'),
      ledgerStore,
    );

    const first = await importer.importExternalUsage({
      configRoots: [configRoot],
      ownedSessionIds: new Set(['owned-session']),
    });

    expect(first).toEqual({ scannedFiles: 2, skippedOwnedFiles: 1, importedEntries: 1 });
    let ledger = await ledgerStore.read();
    expect(ledger.days).toHaveLength(1);
    expect(ledger.days[0].date).toBe('2026-06-02');
    expect(ledger.days[0].records).toEqual([{
      backend: 'claude-code',
      model: 'claude-sonnet-4-6',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        costUsd: 0.01,
        costSource: 'reported',
      },
    }]);

    const second = await importer.importExternalUsage({
      configRoots: [configRoot],
      ownedSessionIds: new Set(['owned-session']),
    });
    expect(second.importedEntries).toBe(0);
    ledger = await ledgerStore.read();
    expect(ledger.days[0].records[0].usage.inputTokens).toBe(10);
  });
});
