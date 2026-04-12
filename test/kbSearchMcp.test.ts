/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── KB Search MCP server tests ───────────────────────────────────────────

import fs from 'fs';
import express from 'express';
import http from 'http';
import { createKbSearchMcpServer } from '../src/services/kbSearchMcp';
import type { KbSearchChatService } from '../src/services/kbSearchMcp';
import * as embeddings from '../src/services/knowledgeBase/embeddings';

// ── Test helpers ──────────────────────────────────────────────────────────

function makeMockChatService(overrides: Partial<KbSearchChatService> = {}): KbSearchChatService {
  return {
    getKbDb: jest.fn().mockReturnValue(null),
    getKbVectorStore: jest.fn().mockResolvedValue(null),
    getWorkspaceKbEmbeddingConfig: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

let server: http.Server;
let baseUrl: string;

function buildAndListen(chatService: KbSearchChatService, kbIngestion?: any) {
  const mcp = createKbSearchMcpServer({ chatService, kbIngestion });
  const app = express();
  app.use(express.json());
  app.use('/mcp', mcp.router);
  return new Promise<{ mcp: typeof mcp; close: () => Promise<void> }>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      const close = () => new Promise<void>((r) => server.close(() => r()));
      resolve({ mcp, close });
    });
  });
}

function makeRequest(
  method: string,
  urlPath: string,
  body?: any,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

// ── issueKbSearchSession / revokeKbSearchSession ──────────────────────────

describe('KB Search MCP session lifecycle', () => {
  test('issueKbSearchSession returns token and mcpServers config', () => {
    const mcp = createKbSearchMcpServer({ chatService: makeMockChatService() });
    const session = mcp.issueKbSearchSession('ws-abc', 'ws-abc');
    expect(session.token).toBeDefined();
    expect(typeof session.token).toBe('string');
    expect(session.token.length).toBeGreaterThan(0);
    expect(session.mcpServers).toHaveLength(1);
    expect(session.mcpServers[0].name).toBe('agent-cockpit-kb-search');
    expect(session.mcpServers[0].command).toBe('node');
    expect(session.mcpServers[0].env).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'KB_SEARCH_TOKEN', value: session.token }),
        expect.objectContaining({ name: 'KB_SEARCH_ENDPOINT' }),
      ]),
    );
  });

  test('issueKbSearchSession reuses token for same session key', () => {
    const mcp = createKbSearchMcpServer({ chatService: makeMockChatService() });
    const s1 = mcp.issueKbSearchSession('ws-abc', 'ws-abc');
    const s2 = mcp.issueKbSearchSession('ws-abc', 'ws-abc');
    expect(s1.token).toBe(s2.token);
  });

  test('issueKbSearchSession returns different tokens for different session keys', () => {
    const mcp = createKbSearchMcpServer({ chatService: makeMockChatService() });
    const s1 = mcp.issueKbSearchSession('ws-abc', 'ws-abc');
    const s2 = mcp.issueKbSearchSession('ws-def', 'ws-def');
    expect(s1.token).not.toBe(s2.token);
  });

  test('different session keys for same workspace get independent tokens', () => {
    const mcp = createKbSearchMcpServer({ chatService: makeMockChatService() });
    const s1 = mcp.issueKbSearchSession('conv-1', 'ws-abc');
    const s2 = mcp.issueKbSearchSession('conv-2', 'ws-abc');
    expect(s1.token).not.toBe(s2.token);
  });

  test('revokeKbSearchSession invalidates the token', async () => {
    const { mcp, close } = await buildAndListen(makeMockChatService());
    const session = mcp.issueKbSearchSession('ws-abc', 'ws-abc');

    // Token works before revocation.
    const r1 = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'get_topic', arguments: { topic_id: 'x' } },
      { 'x-kb-search-token': session.token },
    );
    expect(r1.status).toBe(200);

    mcp.revokeKbSearchSession('ws-abc');

    // Token rejected after revocation.
    const r2 = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'get_topic', arguments: { topic_id: 'x' } },
      { 'x-kb-search-token': session.token },
    );
    expect(r2.status).toBe(401);

    await close();
  });

  test('revokeKbSearchSession is a no-op for unknown workspaces', () => {
    const mcp = createKbSearchMcpServer({ chatService: makeMockChatService() });
    expect(() => mcp.revokeKbSearchSession('unknown')).not.toThrow();
  });
});

// ── HTTP endpoint auth ────────────────────────────────────────────────────

describe('KB Search MCP auth', () => {
  test('rejects missing token', async () => {
    const { close } = await buildAndListen(makeMockChatService());
    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'get_topic', arguments: { topic_id: 'x' } },
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid or missing/);
    await close();
  });

  test('rejects invalid token', async () => {
    const { close } = await buildAndListen(makeMockChatService());
    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'get_topic', arguments: { topic_id: 'x' } },
      { 'x-kb-search-token': 'bad-token' },
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid or missing/);
    await close();
  });
});

// ── Tool dispatch ─────────────────────────────────────────────────────────

describe('KB Search MCP tool dispatch', () => {
  test('rejects unknown tool', async () => {
    const { mcp, close } = await buildAndListen(makeMockChatService());
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');
    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'nonexistent_tool', arguments: {} },
      { 'x-kb-search-token': session.token },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown tool/);
    await close();
  });

  test('rejects missing tool field', async () => {
    const { mcp, close } = await buildAndListen(makeMockChatService());
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');
    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { arguments: {} },
      { 'x-kb-search-token': session.token },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown tool/);
    await close();
  });
});

// ── get_topic handler ─────────────────────────────────────────────────────

describe('get_topic handler', () => {
  test('returns topic with connections and entries', async () => {
    const mockDb = {
      getTopic: jest.fn().mockReturnValue({
        topicId: 'topic-a', title: 'Topic A', summary: 'Summary A',
        content: 'Content A', entryCount: 1, connectionCount: 1,
      }),
      listConnectionsForTopic: jest.fn().mockReturnValue([
        { sourceTopic: 'topic-a', targetTopic: 'topic-b', relationship: 'relates-to', confidence: 'inferred' },
      ]),
      listTopicEntryIds: jest.fn().mockReturnValue(['e1']),
      getEntry: jest.fn().mockReturnValue({ title: 'Entry 1' }),
    };
    const chatService = makeMockChatService({ getKbDb: jest.fn().mockReturnValue(mockDb) });
    const { mcp, close } = await buildAndListen(chatService);
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'get_topic', arguments: { topic_id: 'topic-a' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.topic_id).toBe('topic-a');
    expect(res.body.title).toBe('Topic A');
    expect(res.body.content).toBe('Content A');
    expect(res.body.connections).toHaveLength(1);
    expect(res.body.connections[0].relationship).toBe('relates-to');
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].title).toBe('Entry 1');
    await close();
  });

  test('returns error for missing topic_id', async () => {
    const { mcp, close } = await buildAndListen(makeMockChatService());
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'get_topic', arguments: {} },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.error).toMatch(/topic_id is required/);
    await close();
  });

  test('returns error when topic not found', async () => {
    const mockDb = { getTopic: jest.fn().mockReturnValue(null) };
    const chatService = makeMockChatService({ getKbDb: jest.fn().mockReturnValue(mockDb) });
    const { mcp, close } = await buildAndListen(chatService);
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'get_topic', arguments: { topic_id: 'nonexistent' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.error).toMatch(/not found/);
    await close();
  });

  test('returns error when DB unavailable', async () => {
    const { mcp, close } = await buildAndListen(makeMockChatService());
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'get_topic', arguments: { topic_id: 'x' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.error).toMatch(/unavailable/);
    await close();
  });
});

// ── search_topics handler ─────────────────────────────────────────────────

describe('search_topics handler', () => {
  test('returns empty array for empty query', async () => {
    const { mcp, close } = await buildAndListen(makeMockChatService());
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'search_topics', arguments: { query: '' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.topics).toEqual([]);
    await close();
  });

  test('returns warning when no embedding config', async () => {
    const { mcp, close } = await buildAndListen(makeMockChatService());
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'search_topics', arguments: { query: 'test query' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.topics).toEqual([]);
    expect(res.body.warning).toMatch(/No embedding config/);
    await close();
  });
});

// ── search_entries handler ────────────────────────────────────────────────

describe('search_entries handler', () => {
  test('returns empty array for empty query', async () => {
    const { mcp, close } = await buildAndListen(makeMockChatService());
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'search_entries', arguments: { query: '' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    await close();
  });

  test('returns warning when no embedding config', async () => {
    const { mcp, close } = await buildAndListen(makeMockChatService());
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'search_entries', arguments: { query: 'test' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.warning).toMatch(/No embedding config/);
    await close();
  });
});

// ── find_similar_topics handler ───────────────────────────────────────────

describe('find_similar_topics handler', () => {
  test('returns error when topic_id missing', async () => {
    const { mcp, close } = await buildAndListen(makeMockChatService());
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'find_similar_topics', arguments: {} },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.error).toMatch(/topic_id is required/);
    await close();
  });

  test('returns warning when no embedding config', async () => {
    const { mcp, close } = await buildAndListen(makeMockChatService());
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'find_similar_topics', arguments: { topic_id: 'x' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.topics).toEqual([]);
    expect(res.body.warning).toMatch(/No embedding config/);
    await close();
  });
});

// ── find_unconnected_similar handler ─────────────────────────────────────

describe('find_unconnected_similar handler', () => {
  test('returns error when topic_id missing', async () => {
    const { mcp, close } = await buildAndListen(makeMockChatService());
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'find_unconnected_similar', arguments: {} },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.error).toMatch(/topic_id is required/);
    await close();
  });

  test('returns warning when no embedding config', async () => {
    const mockDb = {
      listConnectionsForTopic: jest.fn().mockReturnValue([]),
    };
    const { mcp, close } = await buildAndListen(
      makeMockChatService({
        getKbDb: jest.fn().mockReturnValue(mockDb) as any,
      }),
    );
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'find_unconnected_similar', arguments: { topic_id: 'x' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/No embedding config/);
    await close();
  });

  test('filters out already-connected topics', async () => {
    const mockDb = {
      listConnectionsForTopic: jest.fn().mockReturnValue([
        { sourceTopic: 'x', targetTopic: 'connected-1', relationship: 'r', confidence: 'inferred', evidence: null },
      ]),
    };
    const mockStore = {
      findSimilarTopics: jest.fn().mockResolvedValue([
        { id: 'connected-1', kind: 'topic', title: 'C1', summary: 'S', score: 0.9 },
        { id: 'unconnected-1', kind: 'topic', title: 'U1', summary: 'S', score: 0.85 },
        { id: 'unconnected-2', kind: 'topic', title: 'U2', summary: 'S', score: 0.7 },
      ]),
    };
    const { mcp, close } = await buildAndListen(
      makeMockChatService({
        getKbDb: jest.fn().mockReturnValue(mockDb) as any,
        getWorkspaceKbEmbeddingConfig: jest.fn().mockResolvedValue({
          model: 'nomic-embed-text', host: 'http://localhost:11434', dimensions: 768,
        }) as any,
        getKbVectorStore: jest.fn().mockResolvedValue(mockStore) as any,
      }),
    );
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'find_unconnected_similar', arguments: { topic_id: 'x' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.topics).toHaveLength(2);
    expect(res.body.topics[0].topic_id).toBe('unconnected-1');
    expect(res.body.topics[1].topic_id).toBe('unconnected-2');
    await close();
  });

  test('respects limit parameter', async () => {
    const mockDb = {
      listConnectionsForTopic: jest.fn().mockReturnValue([]),
    };
    const mockStore = {
      findSimilarTopics: jest.fn().mockResolvedValue([
        { id: 't1', kind: 'topic', title: 'T1', summary: 'S', score: 0.9 },
        { id: 't2', kind: 'topic', title: 'T2', summary: 'S', score: 0.8 },
        { id: 't3', kind: 'topic', title: 'T3', summary: 'S', score: 0.7 },
      ]),
    };
    const { mcp, close } = await buildAndListen(
      makeMockChatService({
        getKbDb: jest.fn().mockReturnValue(mockDb) as any,
        getWorkspaceKbEmbeddingConfig: jest.fn().mockResolvedValue({
          model: 'nomic-embed-text', host: 'http://localhost:11434', dimensions: 768,
        }) as any,
        getKbVectorStore: jest.fn().mockResolvedValue(mockStore) as any,
      }),
    );
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'find_unconnected_similar', arguments: { topic_id: 'x', limit: 1 } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.topics).toHaveLength(1);
    expect(res.body.topics[0].topic_id).toBe('t1');
    await close();
  });
});

// ── kb_ingest handler ────────────────────────────────────────────────────

describe('kb_ingest handler', () => {
  test('returns error when file_path is missing', async () => {
    const mockIngestion = { enqueueUpload: jest.fn() };
    const { mcp, close } = await buildAndListen(makeMockChatService(), mockIngestion);
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'kb_ingest', arguments: {} },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.error).toMatch(/file_path is required/);
    expect(mockIngestion.enqueueUpload).not.toHaveBeenCalled();
    await close();
  });

  test('returns error when file does not exist', async () => {
    const mockIngestion = { enqueueUpload: jest.fn() };
    const { mcp, close } = await buildAndListen(makeMockChatService(), mockIngestion);
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'kb_ingest', arguments: { file_path: '/tmp/nonexistent-file-xyz.pdf' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.error).toMatch(/not found or not accessible/);
    await close();
  });

  test('returns error when ingestion service not provided', async () => {
    const { mcp, close } = await buildAndListen(makeMockChatService());
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'kb_ingest', arguments: { file_path: '/tmp/test.txt' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.error).toMatch(/not available/);
    await close();
  });

  test('ingests a real file via enqueueUpload', async () => {
    const tmpFile = '/tmp/kb-ingest-test-' + Date.now() + '.txt';
    fs.writeFileSync(tmpFile, 'test content for ingestion');

    const mockIngestion = {
      enqueueUpload: jest.fn().mockResolvedValue({
        entry: { rawId: 'abc123', filename: 'kb-ingest-test.txt' },
        deduped: false,
        addedLocation: true,
      }),
    };
    const { mcp, close } = await buildAndListen(makeMockChatService(), mockIngestion);
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'kb_ingest', arguments: { file_path: tmpFile } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.raw_id).toBe('abc123');
    expect(mockIngestion.enqueueUpload).toHaveBeenCalledTimes(1);
    const call = mockIngestion.enqueueUpload.mock.calls[0];
    expect(call[0]).toBe('ws-test'); // workspace hash
    expect(call[1].folderPath).toBe('conversation-documents');
    expect(call[1].mimeType).toBe('text/plain');
    expect(call[1].buffer).toBeInstanceOf(Buffer);

    fs.rmSync(tmpFile, { force: true });
    await close();
  });

  test('returns error when path is a directory', async () => {
    const mockIngestion = { enqueueUpload: jest.fn() };
    const { mcp, close } = await buildAndListen(makeMockChatService(), mockIngestion);
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'kb_ingest', arguments: { file_path: '/tmp' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.error).toMatch(/not a file/);
    await close();
  });
});

// ── Ollama fallback behavior ─────────────────────────────────────────────

describe('Ollama fallback', () => {
  test('search_topics falls back to keyword search when embedding fails', async () => {
    const mockStore = {
      keywordSearchTopics: jest.fn().mockResolvedValue([
        { id: 't1', kind: 'topic', title: 'Topic 1', summary: 'S', score: 0.5 },
      ]),
      hybridSearchTopics: jest.fn(),
    };

    // Mock embedText to throw (simulates Ollama being down).
    jest.spyOn(embeddings, 'embedText')
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const { mcp, close } = await buildAndListen(
      makeMockChatService({
        getWorkspaceKbEmbeddingConfig: jest.fn().mockResolvedValue({
          model: 'nomic-embed-text', host: 'http://localhost:11434', dimensions: 768,
        }) as any,
        getKbVectorStore: jest.fn().mockResolvedValue(mockStore) as any,
      }),
    );
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'search_topics', arguments: { query: 'test' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.topics).toHaveLength(1);
    expect(res.body.topics[0].topic_id).toBe('t1');
    expect(mockStore.keywordSearchTopics).toHaveBeenCalledWith('test', 10);
    await close();

    jest.restoreAllMocks();
  });

  test('search_entries falls back to keyword search when embedding fails', async () => {
    const mockStore = {
      keywordSearchEntries: jest.fn().mockResolvedValue([
        { id: 'e1', kind: 'entry', title: 'Entry 1', summary: 'S', score: 0.5 },
      ]),
      hybridSearchEntries: jest.fn(),
    };

    jest.spyOn(embeddings, 'embedText')
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const { mcp, close } = await buildAndListen(
      makeMockChatService({
        getWorkspaceKbEmbeddingConfig: jest.fn().mockResolvedValue({
          model: 'nomic-embed-text', host: 'http://localhost:11434', dimensions: 768,
        }) as any,
        getKbVectorStore: jest.fn().mockResolvedValue(mockStore) as any,
      }),
    );
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'search_entries', arguments: { query: 'test' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].entry_id).toBe('e1');
    expect(mockStore.keywordSearchEntries).toHaveBeenCalledWith('test', 10);
    await close();

    jest.restoreAllMocks();
  });

  test('find_similar_topics returns empty when embeddings unavailable', async () => {
    const mockStore = {
      findSimilarTopics: jest.fn().mockRejectedValue(new Error('no embeddings')),
    };
    const { mcp, close } = await buildAndListen(
      makeMockChatService({
        getWorkspaceKbEmbeddingConfig: jest.fn().mockResolvedValue({
          model: 'nomic-embed-text', host: 'http://localhost:11434', dimensions: 768,
        }) as any,
        getKbVectorStore: jest.fn().mockResolvedValue(mockStore) as any,
      }),
    );
    const session = mcp.issueKbSearchSession('ws-test', 'ws-test');

    const res = await makeRequest(
      'POST', '/mcp/kb-search/call',
      { tool: 'find_similar_topics', arguments: { topic_id: 'x' } },
      { 'x-kb-search-token': session.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.topics).toEqual([]);
    await close();
  });
});
