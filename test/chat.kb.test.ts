/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { createChatRouterEnv, destroyChatRouterEnv, CSRF_TOKEN, type ChatRouterEnv } from './helpers/chatEnv';
import { workspaceHash } from './helpers/workspace';

let env: ChatRouterEnv;

beforeEach(async () => { env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); });

describe('GET /workspaces/:hash/kb', () => {
  test('returns enabled=false and an empty state scaffold for a new workspace', async () => {
    const conv = await env.chatService.createConversation('KB GET', '/tmp/ws-kb-empty');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const res = await env.request('GET', `/api/chat/workspaces/${hash}/kb`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.state).toBeTruthy();
    expect(res.body.state.version).toBe(1);
    expect(res.body.state.raw).toEqual([]);
    expect(res.body.state.folders).toEqual([]);
    expect(res.body.state.counters.rawTotal).toBe(0);
    expect(res.body.state.counters.entryCount).toBe(0);
  });

  test('returns enabled=true and persists empty state when KB is turned on', async () => {
    const conv = await env.chatService.createConversation('KB ON', '/tmp/ws-kb-on');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/kb`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.state.raw).toEqual([]);
    // Root folder is always present once KB is enabled and a DB is opened.
    expect(res.body.state.folders.some((f: { folderPath: string }) => f.folderPath === '')).toBe(true);
  });

  test('reports active Re-Dream as running in the KB and synthesis snapshots', async () => {
    const conv = await env.chatService.createConversation('KB Redream Running', '/tmp/ws-kb-redream-running');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({
      ...settings,
      knowledgeBase: {
        ...(settings.knowledgeBase || {}),
        dreamingCliBackend: 'claude-code',
      },
    });
    const db = env.chatService.getKbDb(hash)!;
    const now = new Date().toISOString();
    db.insertRaw({
      rawId: 'redreamrunning01',
      sha256: 'a'.repeat(64),
      status: 'digested',
      byteLength: 12,
      mimeType: 'text/plain',
      handler: 'test',
      uploadedAt: now,
      metadata: null,
    });
    db.insertEntry({
      entryId: 'entry-redream-running',
      rawId: 'redreamrunning01',
      title: 'Entry',
      slug: 'entry',
      summary: 'Entry summary',
      schemaVersion: 1,
      digestedAt: now,
      tags: [],
    });
    let releaseOneShot!: () => void;
    const holdOneShot = new Promise<void>((resolve) => { releaseOneShot = resolve; });
    env.mockBackend.setOneShotImpl(async () => {
      await holdOneShot;
      return JSON.stringify({ operations: [] });
    });

    const started = await env.request('POST', `/api/chat/workspaces/${hash}/kb/redream`, {});
    expect(started.status).toBe(202);
    const res = await env.request('GET', `/api/chat/workspaces/${hash}/kb`);

    expect(res.status).toBe(200);
    expect(res.body.state.dreamingStatus).toBe('running');

    const synthesis = await env.request('GET', `/api/chat/workspaces/${hash}/kb/synthesis`);
    expect(synthesis.status).toBe(200);
    expect(synthesis.body.status).toBe('running');

    releaseOneShot();
    await new Promise((r) => setTimeout(r, 80));
  });

  test('returns 404 for unknown workspace', async () => {
    const res = await env.request('GET', '/api/chat/workspaces/nonexistent999/kb');
    expect(res.status).toBe(404);
  });
});

describe('PUT /workspaces/:hash/kb/enabled', () => {
  test('persists the enable flag and is round-tripped via GET', async () => {
    const conv = await env.chatService.createConversation('KB Toggle', '/tmp/ws-kb-toggle');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const put = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/kb/enabled`,
      { enabled: true },
    );
    expect(put.status).toBe(200);
    expect(put.body.enabled).toBe(true);

    const get = await env.request('GET', `/api/chat/workspaces/${hash}/kb`);
    expect(get.status).toBe(200);
    expect(get.body.enabled).toBe(true);
  });

  test('rejects non-boolean enabled values', async () => {
    const conv = await env.chatService.createConversation('KB Bad', '/tmp/ws-kb-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const res = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/kb/enabled`,
      { enabled: 'yes' as unknown as boolean },
    );
    expect(res.status).toBe(400);
  });

  test('returns 404 for unknown workspace', async () => {
    const res = await env.request(
      'PUT',
      `/api/chat/workspaces/nonexistent999/kb/enabled`,
      { enabled: true },
    );
    expect(res.status).toBe(404);
  });

  test('does not touch memoryEnabled when toggled', async () => {
    const conv = await env.chatService.createConversation('KB Split', '/tmp/ws-kb-split');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceMemoryEnabled(hash, true);

    await env.request('PUT', `/api/chat/workspaces/${hash}/kb/enabled`, { enabled: true });

    expect(await env.chatService.getWorkspaceMemoryEnabled(hash)).toBe(true);
    expect(await env.chatService.getWorkspaceKbEnabled(hash)).toBe(true);
  });
});

describe('PUT /workspaces/:hash/kb/auto-dream', () => {
  test('persists interval config and returns it through KB state', async () => {
    const conv = await env.chatService.createConversation('KB Auto Dream', '/tmp/ws-kb-auto-dream');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const put = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/kb/auto-dream`,
      { autoDream: { mode: 'interval', intervalHours: 12 } },
    );
    expect(put.status).toBe(200);
    expect(put.body.autoDream).toEqual({ mode: 'interval', intervalHours: 12 });

    const get = await env.request('GET', `/api/chat/workspaces/${hash}/kb`);
    expect(get.status).toBe(200);
    expect(get.body.state.autoDream).toEqual({ mode: 'interval', intervalHours: 12 });
  });

  test('rejects invalid window times', async () => {
    const conv = await env.chatService.createConversation('KB Auto Dream Bad', '/tmp/ws-kb-auto-dream-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const res = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/kb/auto-dream`,
      { autoDream: { mode: 'window', windowStart: '2AM', windowEnd: '06:00' } },
    );

    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toMatch(/windowStart/);
  });

  test('synthesis state includes auto-dream timing', async () => {
    const conv = await env.chatService.createConversation('KB Auto Dream Synth', '/tmp/ws-kb-auto-dream-synth');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);
    await env.chatService.setWorkspaceKbAutoDream(hash, { mode: 'window', windowStart: '02:00', windowEnd: '06:00' });

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/kb/synthesis`);

    expect(res.status).toBe(200);
    expect(res.body.autoDream).toEqual(expect.objectContaining({
      mode: 'window',
      windowStart: '02:00',
      windowEnd: '06:00',
    }));
    expect(res.body.autoDream).toHaveProperty('nextRunAt');
  });

  test('returns 404 for unknown workspace', async () => {
    const res = await env.request(
      'PUT',
      '/api/chat/workspaces/nonexistent999/kb/auto-dream',
      { autoDream: { mode: 'off' } },
    );
    expect(res.status).toBe(404);
  });
});

describe('KB glossary routes', () => {
  test('create, list, update, and delete glossary terms', async () => {
    const conv = await env.chatService.createConversation('KB Glossary', '/tmp/ws-kb-glossary');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    const created = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/kb/glossary`,
      { term: 'OEE', expansion: 'Overall Equipment Effectiveness' },
    );
    expect(created.status).toBe(201);
    expect(created.body.term).toMatchObject({
      term: 'OEE',
      expansion: 'Overall Equipment Effectiveness',
    });

    const listed = await env.request('GET', `/api/chat/workspaces/${hash}/kb/glossary`);
    expect(listed.status).toBe(200);
    expect(listed.body.glossary).toHaveLength(1);

    const id = created.body.term.id;
    const updated = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/kb/glossary/${id}`,
      { term: 'OEE target', expansion: 'Overall Equipment Effectiveness target' },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.term).toMatchObject({
      id,
      term: 'OEE target',
      expansion: 'Overall Equipment Effectiveness target',
    });

    const deleted = await env.request('DELETE', `/api/chat/workspaces/${hash}/kb/glossary/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);

    const empty = await env.request('GET', `/api/chat/workspaces/${hash}/kb/glossary`);
    expect(empty.body.glossary).toEqual([]);
  });

  test('rejects blank and duplicate terms', async () => {
    const conv = await env.chatService.createConversation('KB Glossary Bad', '/tmp/ws-kb-glossary-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    const blank = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/kb/glossary`,
      { term: '', expansion: 'x' },
    );
    expect(blank.status).toBe(400);

    const first = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/kb/glossary`,
      { term: 'OEE', expansion: 'Overall Equipment Effectiveness' },
    );
    expect(first.status).toBe(201);

    const duplicate = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/kb/glossary`,
      { term: 'oee', expansion: 'duplicate' },
    );
    expect(duplicate.status).toBe(409);
  });

  test('does not open or create KB state when glossary routes are disabled or unknown', async () => {
    const conv = await env.chatService.createConversation('KB Glossary Disabled', '/tmp/ws-kb-glossary-disabled');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const getKbDb = jest.spyOn(env.chatService, 'getKbDb');

    const disabledGet = await env.request('GET', `/api/chat/workspaces/${hash}/kb/glossary`);
    expect(disabledGet.status).toBe(400);

    const disabledPost = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/kb/glossary`,
      { term: 'OEE', expansion: 'Overall Equipment Effectiveness' },
    );
    expect(disabledPost.status).toBe(400);

    const unknown = await env.request('GET', '/api/chat/workspaces/missing-workspace/kb/glossary');
    expect(unknown.status).toBe(404);
    expect(getKbDb).not.toHaveBeenCalled();
    expect(fs.existsSync(env.chatService.getKbKnowledgeDir(hash))).toBe(false);
  });
});

describe('GET /workspaces/:hash/kb/raw/:rawId/trace', () => {
  test('returns per-document pipeline trace details', async () => {
    const conv = await env.chatService.createConversation('KB Trace', '/tmp/ws-kb-trace');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);
    const db = env.chatService.getKbDb(hash)!;
    const now = '2026-05-05T00:00:00.000Z';
    const rawId = 'abcdefabcdefabcd';

    db.insertRaw({
      rawId,
      sha256: 'a'.repeat(64),
      status: 'digested',
      byteLength: 42,
      mimeType: 'application/pdf',
      handler: 'pdf/rasterized-hybrid',
      uploadedAt: now,
      metadata: { pageCount: 2 },
    });
    db.addLocation({ rawId, folderPath: '', filename: 'trace.pdf', uploadedAt: now });
    db.setRawDigestedAt(rawId, now);
    db.upsertDocumentStructure({
      document: {
        rawId,
        docName: 'trace.pdf',
        docDescription: null,
        unitType: 'page',
        unitCount: 2,
        structureStatus: 'ready',
        structureError: null,
        createdAt: now,
        updatedAt: now,
      },
      nodes: [
        { nodeId: 'page-1', rawId, parentNodeId: null, title: 'Page 1', summary: null, startUnit: 1, endUnit: 1, sortOrder: 1, source: 'deterministic', metadata: undefined },
        { nodeId: 'page-2', rawId, parentNodeId: null, title: 'Page 2', summary: null, startUnit: 2, endUnit: 2, sortOrder: 2, source: 'deterministic', metadata: undefined },
      ],
    });
    db.insertEntry({
      entryId: `${rawId}-entry`,
      rawId,
      title: 'Trace Entry',
      slug: 'entry',
      summary: 'Entry summary',
      schemaVersion: 1,
      digestedAt: now,
      tags: ['trace'],
    });
    db.insertEntrySources([{
      entryId: `${rawId}-entry`,
      rawId,
      nodeId: 'page-1',
      chunkId: 'chunk-0001-u1-2',
      startUnit: 1,
      endUnit: 2,
    }]);
    db.upsertTopic({ topicId: 'trace-topic', title: 'Trace Topic', summary: 'Topic summary', content: 'Topic body', updatedAt: now });
    db.assignEntries('trace-topic', [`${rawId}-entry`]);

    const convertedDir = path.join(env.chatService.getKbConvertedDir(hash), rawId);
    fs.mkdirSync(path.join(convertedDir, 'media'), { recursive: true });
    fs.writeFileSync(path.join(convertedDir, 'text.md'), '## Page 1\nTrace\n## Page 2\nTrace');
    fs.writeFileSync(path.join(convertedDir, 'meta.json'), '{}');
    fs.writeFileSync(path.join(convertedDir, 'media', 'page-1.png'), 'png');

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/kb/raw/${rawId}/trace`);

    expect(res.status).toBe(200);
    expect(res.body.raw.rawId).toBe(rawId);
    expect(res.body.converted.textMd.exists).toBe(true);
    expect(res.body.converted.mediaCount).toBe(1);
    expect(res.body.structure.nodeCount).toBe(2);
    expect(res.body.chunks).toEqual([
      expect.objectContaining({ chunkId: 'chunk-0001-u1-2', digested: true }),
    ]);
    expect(res.body.entries[0]).toMatchObject({
      entryId: `${rawId}-entry`,
      title: 'Trace Entry',
    });
    expect(res.body.entries[0].sources).toHaveLength(1);
    expect(res.body.topics[0]).toMatchObject({
      topicId: 'trace-topic',
      entryIds: [`${rawId}-entry`],
    });
  });

  test('does not open or create KB state when trace is requested while disabled', async () => {
    const conv = await env.chatService.createConversation('KB Trace Disabled', '/tmp/ws-kb-trace-disabled');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const getKbDb = jest.spyOn(env.chatService, 'getKbDb');

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/kb/raw/abcdef/trace`);

    expect(res.status).toBe(400);
    expect(getKbDb).not.toHaveBeenCalled();
    expect(fs.existsSync(env.chatService.getKbKnowledgeDir(hash))).toBe(false);
  });
});

describe('POST /workspaces/:hash/kb/structure/backfill', () => {
  test('creates missing document structure from converted artifacts', async () => {
    const conv = await env.chatService.createConversation('KB Backfill', '/tmp/ws-kb-backfill');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);
    const db = env.chatService.getKbDb(hash)!;
    const rawId = 'baccf11baccf11aa';
    const now = '2026-01-01T00:00:00.000Z';

    db.insertRaw({
      rawId,
      sha256: 'b'.repeat(64),
      status: 'digested',
      byteLength: 32,
      mimeType: 'application/pdf',
      handler: 'pdf',
      uploadedAt: now,
      metadata: null,
    });
    db.addLocation({ rawId, folderPath: '', filename: 'backfill.pdf', uploadedAt: now });

    const convertedDir = path.join(env.chatService.getKbConvertedDir(hash), rawId);
    fs.mkdirSync(convertedDir, { recursive: true });
    fs.writeFileSync(path.join(convertedDir, 'text.md'), '## Page 1\nAlpha\n\n## Page 2\nBeta');
    fs.writeFileSync(path.join(convertedDir, 'meta.json'), JSON.stringify({
      filename: 'backfill.pdf',
      metadata: { pageCount: 2 },
    }));

    const res = await env.request('POST', `/api/chat/workspaces/${hash}/kb/structure/backfill`, {});

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(db.getDocument(rawId)?.unitType).toBe('page');
    expect(db.listDocumentNodes(rawId)).toHaveLength(2);
  });
});

describe('POST /workspaces/:hash/kb/raw/:rawId/structure', () => {
  test('rebuilds structure for a single raw', async () => {
    const conv = await env.chatService.createConversation('KB Rebuild Structure', '/tmp/ws-kb-rebuild-structure');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);
    const db = env.chatService.getKbDb(hash)!;
    const rawId = '5eed5eed5eed5eed';
    const now = '2026-01-01T00:00:00.000Z';

    db.insertRaw({
      rawId,
      sha256: '5'.repeat(64),
      status: 'ingested',
      byteLength: 24,
      mimeType: 'text/markdown',
      handler: 'passthrough',
      uploadedAt: now,
      metadata: null,
    });
    db.addLocation({ rawId, folderPath: '', filename: 'single.md', uploadedAt: now });
    db.upsertDocumentStructure({
      document: {
        rawId,
        docName: 'single.md',
        docDescription: null,
        unitType: 'unknown',
        unitCount: 1,
        structureStatus: 'ready',
        structureError: null,
        createdAt: now,
        updatedAt: now,
      },
      nodes: [
        { nodeId: 'fallback-1', rawId, parentNodeId: null, title: 'Document', summary: null, startUnit: 1, endUnit: 1, sortOrder: 1, source: 'fallback', metadata: undefined },
      ],
    });

    const convertedDir = path.join(env.chatService.getKbConvertedDir(hash), rawId);
    fs.mkdirSync(convertedDir, { recursive: true });
    fs.writeFileSync(path.join(convertedDir, 'text.md'), '## One\nAlpha\n\n## Two\nBeta');
    fs.writeFileSync(path.join(convertedDir, 'meta.json'), JSON.stringify({ filename: 'single.md' }));

    const res = await env.request('POST', `/api/chat/workspaces/${hash}/kb/raw/${rawId}/structure`, {});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rebuilt');
    expect(db.getDocument(rawId)?.unitType).toBe('section');
    expect(db.listDocumentNodes(rawId).map((n) => n.title)).toEqual(['One', 'Two']);
  });
});

describe('GET /kb/libreoffice-status', () => {
  test('returns LibreOfficeStatus shape', async () => {
    const res = await env.request('GET', '/api/chat/kb/libreoffice-status');
    expect(res.status).toBe(200);
    expect(typeof res.body.available).toBe('boolean');
    expect(res.body.binaryPath === null || typeof res.body.binaryPath === 'string').toBe(true);
    expect(typeof res.body.checkedAt).toBe('string');
    // `available` and `binaryPath` must be consistent with each other.
    if (res.body.available) {
      expect(res.body.binaryPath).not.toBeNull();
    } else {
      expect(res.body.binaryPath).toBeNull();
    }
  });
});

// ── memory_update WS frame ────────────────────────────────────────────────


describe('POST /workspaces/:hash/kb/raw', () => {
  test('202 stages a text file and creates a raw entry', async () => {
    const conv = await env.chatService.createConversation('KB upload', '/tmp/ws-kb-up-1');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    const res = await env.multipartRequest(
      'POST',
      `/api/chat/workspaces/${hash}/kb/raw`,
      'file',
      'note.md',
      'text/markdown',
      Buffer.from('# Hello KB'),
    );
    expect(res.status).toBe(202);
    expect(res.body.entry).toBeTruthy();
    expect(res.body.entry.status).toBe('ingesting');
    expect(res.body.entry.filename).toBe('note.md');
    expect(res.body.deduped).toBe(false);

    // After a short wait, the entry should be ingested.
    await new Promise((r) => setTimeout(r, 100));
    const state = await env.chatService.getKbStateSnapshot(hash);
    const entry = state?.raw.find((r) => r.rawId === res.body.entry.rawId);
    expect(entry?.status).toBe('ingested');
  });

  test('400 when KB is disabled', async () => {
    const conv = await env.chatService.createConversation('KB off', '/tmp/ws-kb-up-2');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    // KB intentionally not enabled.

    const res = await env.multipartRequest(
      'POST',
      `/api/chat/workspaces/${hash}/kb/raw`,
      'file',
      'note.md',
      'text/markdown',
      Buffer.from('blocked'),
    );
    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toMatch(/not enabled/i);
  });

  test('unsupported file types land as failed with a helpful error', async () => {
    const conv = await env.chatService.createConversation('KB bad', '/tmp/ws-kb-up-3');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    const res = await env.multipartRequest(
      'POST',
      `/api/chat/workspaces/${hash}/kb/raw`,
      'file',
      'mystery.xyz',
      'application/octet-stream',
      Buffer.from([0x00, 0x01, 0x02]),
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 80));
    const state = await env.chatService.getKbStateSnapshot(hash);
    const entry = state?.raw.find((r) => r.rawId === res.body.entry.rawId);
    expect(entry?.status).toBe('failed');
    expect(entry?.errorMessage || '').toMatch(/Unsupported file type/);
  });

  test('400 rejects legacy .doc files before they ever hit the handler', async () => {
    const conv = await env.chatService.createConversation('KB doc legacy', '/tmp/ws-kb-up-4');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    const res = await env.multipartRequest(
      'POST',
      `/api/chat/workspaces/${hash}/kb/raw`,
      'file',
      'legacy.doc',
      'application/msword',
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), // ole2 magic (doesn't matter, we reject on extension)
    );
    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toMatch(/Legacy \.doc format is not supported/);
    // And no raw entry should have been created.
    const state = await env.chatService.getKbStateSnapshot(hash);
    expect(state?.raw || []).toHaveLength(0);
    expect(state?.counters.rawTotal).toBe(0);
  });

  test('400 rejects .docx uploads with an install hint when pandoc is unavailable', async () => {
    const conv = await env.chatService.createConversation('KB docx no pandoc', '/tmp/ws-kb-up-5');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    // Force the pandoc detection to report "not available" by pointing
    // PATH at an empty directory and clearing the cache.
    const {
      _resetPandocCacheForTests,
    } = require('../src/services/knowledgeBase/pandoc');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'no-pandoc-'));
    const origPath = process.env.PATH;
    process.env.PATH = emptyPath;
    _resetPandocCacheForTests();

    try {
      const res = await env.multipartRequest(
        'POST',
        `/api/chat/workspaces/${hash}/kb/raw`,
        'file',
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      );
      expect(res.status).toBe(400);
      expect(String(res.body.error || '')).toMatch(/Pandoc/);
      expect(String(res.body.error || '')).toMatch(/pandoc\.org/);
      // And no raw entry should have been created.
      const state = await env.chatService.getKbStateSnapshot(hash);
      expect(state?.raw || []).toHaveLength(0);
      expect(state?.counters.rawTotal).toBe(0);
    } finally {
      process.env.PATH = origPath;
      _resetPandocCacheForTests();
      fs.rmSync(emptyPath, { recursive: true, force: true });
    }
  });
});

describe('DELETE /workspaces/:hash/kb/raw/:rawId', () => {
  test('cascades the raw file and converted output', async () => {
    const conv = await env.chatService.createConversation('KB del', '/tmp/ws-kb-del-1');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    const upload = await env.multipartRequest(
      'POST',
      `/api/chat/workspaces/${hash}/kb/raw`,
      'file',
      'note.md',
      'text/markdown',
      Buffer.from('to delete'),
    );
    const rawId = upload.body.entry.rawId;
    await new Promise((r) => setTimeout(r, 80));

    const del = await env.request('DELETE', `/api/chat/workspaces/${hash}/kb/raw/${rawId}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const state = await env.chatService.getKbStateSnapshot(hash);
    expect(state?.raw.find((r) => r.rawId === rawId)).toBeUndefined();
    const rawPath = path.join(env.chatService.getKbRawDir(hash), `${rawId}.md`);
    expect(fs.existsSync(rawPath)).toBe(false);
  });

  test('404 for an unknown rawId', async () => {
    const conv = await env.chatService.createConversation('KB del 2', '/tmp/ws-kb-del-2');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);
    const res = await env.request('DELETE', `/api/chat/workspaces/${hash}/kb/raw/deadbeefdeadbeef`);
    expect(res.status).toBe(404);
  });
});

describe('GET /workspaces/:hash/kb/raw/:rawId', () => {
  test('streams back the original bytes', async () => {
    const conv = await env.chatService.createConversation('KB get', '/tmp/ws-kb-get-1');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    const original = Buffer.from('# Original content\n');
    const upload = await env.multipartRequest(
      'POST',
      `/api/chat/workspaces/${hash}/kb/raw`,
      'file',
      'original.md',
      'text/markdown',
      original,
    );
    const rawId = upload.body.entry.rawId;

    // Fetch raw bytes via plain http (makeRequest tries to JSON.parse).
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const url = new URL(`/api/chat/workspaces/${hash}/kb/raw/${rawId}`, env.baseUrl);
      http
        .get(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            headers: { 'x-csrf-token': CSRF_TOKEN },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
          },
        )
        .on('error', reject);
    });
    expect(bytes.equals(original)).toBe(true);
  });

  test('400 for a non-hex rawId', async () => {
    const conv = await env.chatService.createConversation('KB bad id', '/tmp/ws-kb-get-2');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);
    const res = await env.request('GET', `/api/chat/workspaces/${hash}/kb/raw/../etc/passwd`);
    // Path has slashes so Express will 404 before we even see it; accept either.
    expect([400, 404]).toContain(res.status);
  });
});

describe('GET /workspaces/:hash/kb/raw/:rawId/media/*', () => {
  async function seedMediaFile(hash: string, rawId: string, relPath: string, bytes: Buffer): Promise<void> {
    const full = path.join(env.chatService.getKbConvertedDir(hash), rawId, relPath);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, bytes);
  }

  function fetchRaw(hash: string, rawId: string, mediaPath: string): Promise<{ status: number; bytes: Buffer }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`/api/chat/workspaces/${hash}/kb/raw/${rawId}/media/${mediaPath}`, env.baseUrl);
      http.get(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: { 'x-csrf-token': CSRF_TOKEN },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode || 0, bytes: Buffer.concat(chunks) }));
        },
      ).on('error', reject);
    });
  }

  test('streams back a media file from converted/<rawId>/', async () => {
    const conv = await env.chatService.createConversation('KB media get', '/tmp/ws-kb-media-1');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    const rawId = 'deadbeef01';
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    await seedMediaFile(hash, rawId, path.join('media', 'Slide123.jpg'), jpg);

    const { status, bytes } = await fetchRaw(hash, rawId, 'media/Slide123.jpg');
    expect(status).toBe(200);
    expect(bytes.equals(jpg)).toBe(true);
  });

  test('serves nested subdirs (slides/, pages/)', async () => {
    const conv = await env.chatService.createConversation('KB nested media', '/tmp/ws-kb-media-2');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    const rawId = 'deadbeef02';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await seedMediaFile(hash, rawId, path.join('slides', 'slide-001.png'), png);

    const { status, bytes } = await fetchRaw(hash, rawId, 'slides/slide-001.png');
    expect(status).toBe(200);
    expect(bytes.equals(png)).toBe(true);
  });

  test('404 when the media file does not exist', async () => {
    const conv = await env.chatService.createConversation('KB media missing', '/tmp/ws-kb-media-3');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/kb/raw/deadbeef03/media/missing.jpg`);
    expect(res.status).toBe(404);
  });

  test('400 for a non-hex rawId', async () => {
    const conv = await env.chatService.createConversation('KB media bad id', '/tmp/ws-kb-media-4');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/kb/raw/not-hex-id/media/foo.jpg`);
    expect(res.status).toBe(400);
  });

  test('400 on path traversal via ..', async () => {
    const conv = await env.chatService.createConversation('KB media traversal', '/tmp/ws-kb-media-5');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/kb/raw/deadbeef04/media/..%2F..%2Fsecret.txt`);
    expect(res.status).toBe(400);
  });
});

// ── POST /conversations (create) ──────────────────────────────────────────
