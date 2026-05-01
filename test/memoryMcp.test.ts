import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { createMemoryMcpServer, MEMORY_MCP_STUB_PATH } from '../src/services/memoryMcp';
import { ChatService } from '../src/services/chatService';
import { BackendRegistry } from '../src/services/backends/registry';
import { BaseBackendAdapter, type RunOneShotOptions } from '../src/services/backends/base';
import type {
  BackendMetadata,
  SendMessageOptions,
  SendMessageResult,
  Message,
  MemorySnapshot,
} from '../src/types';

function workspaceHash(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').substring(0, 16);
}

// ── Test adapter that stubs runOneShot ─────────────────────────────────────

class StubMemoryCli extends BaseBackendAdapter {
  _oneShotResponses: string[] = [];
  _oneShotCalls: Array<{ prompt: string; options?: RunOneShotOptions }> = [];

  get metadata(): BackendMetadata {
    return {
      id: 'stub-memory-cli',
      label: 'Stub',
      icon: null,
      capabilities: {
        thinking: false, planMode: false, agents: false,
        toolActivity: false, userQuestions: false, stdinInput: false,
      },
    };
  }
  sendMessage(_msg: string, _opts?: SendMessageOptions): SendMessageResult {
    return {
      stream: (async function*() { yield { type: 'done' as const }; })(),
      abort: () => {},
      sendInput: () => {},
    };
  }
  async generateSummary(_m: Pick<Message, 'role' | 'content'>[], fallback: string) {
    return fallback;
  }
  async extractMemory(_workspacePath: string): Promise<MemorySnapshot | null> {
    return null;
  }
  async runOneShot(prompt: string, options?: RunOneShotOptions): Promise<string> {
    this._oneShotCalls.push({ prompt, options });
    return this._oneShotResponses.shift() || '';
  }

  queueResponse(body: string) {
    this._oneShotResponses.push(body);
  }
}

// ── Fixture ────────────────────────────────────────────────────────────────

let tmpDir: string;
let service: ChatService;
let registry: BackendRegistry;
let stubCli: StubMemoryCli;
let memoryMcp: ReturnType<typeof createMemoryMcpServer>;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmcp-'));
  stubCli = new StubMemoryCli();
  registry = new BackendRegistry();
  registry.register(stubCli);
  service = new ChatService(tmpDir, { defaultWorkspace: '/tmp/memmcp-default', backendRegistry: registry });
  await service.initialize();
  // Configure the stub as the Memory CLI.
  await service.saveSettings({
    theme: 'system',
    sendBehavior: 'enter',
    systemPrompt: '',
    defaultBackend: 'stub-memory-cli',
    memory: { cliBackend: 'stub-memory-cli' },
  });
  memoryMcp = createMemoryMcpServer({
    chatService: service,
    backendRegistry: registry,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('memoryMcp.issueMemoryMcpSession', () => {
  test('returns a unique token and an mcpServers array pointing at the stub', () => {
    const a = memoryMcp.issueMemoryMcpSession('conv-a', 'hash-a');
    const b = memoryMcp.issueMemoryMcpSession('conv-b', 'hash-b');

    expect(a.token).toBeTruthy();
    expect(b.token).toBeTruthy();
    expect(a.token).not.toBe(b.token);

    expect(a.mcpServers).toHaveLength(1);
    expect(a.mcpServers[0].name).toBe('agent-cockpit-memory');
    expect(a.mcpServers[0].command).toBe('node');
    expect(a.mcpServers[0].args).toEqual([MEMORY_MCP_STUB_PATH]);
    // ACP spec requires env as an array of {name, value} objects, NOT a
    // plain Record.  A plain object crashes strict ACP servers like
    // kiro-cli with "ACP process closed".
    expect(Array.isArray(a.mcpServers[0].env)).toBe(true);
    const tokenEntry = a.mcpServers[0].env.find((e) => e.name === 'MEMORY_TOKEN');
    const endpointEntry = a.mcpServers[0].env.find((e) => e.name === 'MEMORY_ENDPOINT');
    expect(tokenEntry?.value).toBe(a.token);
    expect(endpointEntry?.value).toMatch(/\/api\/chat\/mcp\/memory\/notes$/);
  });

  test('reissuing a session for the same conversation+workspace returns the same token', () => {
    // The MCP stub is spawned once per ACP session (on session/new) and
    // captures its bearer token from its spawn-time env forever.  The chat
    // route calls `issueMemoryMcpSession` on every message, so if this
    // minted a fresh token each time we would revoke the live token the
    // still-running stub is holding and every subsequent memory_note call
    // would hit HTTP 401.  Idempotency is the only correct shape.
    const first = memoryMcp.issueMemoryMcpSession('conv-x', 'hash-x');
    const second = memoryMcp.issueMemoryMcpSession('conv-x', 'hash-x');
    const third = memoryMcp.issueMemoryMcpSession('conv-x', 'hash-x');
    expect(second.token).toBe(first.token);
    expect(third.token).toBe(first.token);
    // And the mcpServers config should carry the same token through.
    const tokenEntry = third.mcpServers[0].env.find((e) => e.name === 'MEMORY_TOKEN');
    expect(tokenEntry?.value).toBe(first.token);
  });

  test('reissuing with a different workspace hash rotates the token', () => {
    // If the conversation's workspace changes out from under us we must
    // rotate — the previous token pointed at a different workspace snapshot.
    const first = memoryMcp.issueMemoryMcpSession('conv-y', 'hash-original');
    const second = memoryMcp.issueMemoryMcpSession('conv-y', 'hash-moved');
    expect(second.token).not.toBe(first.token);
  });

  test('reissuing after an explicit revoke mints a fresh token', () => {
    const first = memoryMcp.issueMemoryMcpSession('conv-z', 'hash-z');
    memoryMcp.revokeMemoryMcpSession('conv-z');
    const second = memoryMcp.issueMemoryMcpSession('conv-z', 'hash-z');
    expect(second.token).not.toBe(first.token);
  });
});

describe('memoryMcp.extractMemoryFromSession', () => {
  test('returns 0 when memory is disabled', async () => {
    const hash = workspaceHash('/tmp/mem-extract-off');
    await service.createConversation('off', '/tmp/mem-extract-off');
    // Memory left disabled.

    const count = await memoryMcp.extractMemoryFromSession({
      workspaceHash: hash,
      conversationId: 'conv-1',
      messages: [
        { role: 'user', content: 'Hi' } as any,
        { role: 'assistant', content: 'Hello' } as any,
      ],
    });
    expect(count).toBe(0);
    expect(stubCli._oneShotCalls).toHaveLength(0);
  });

  test('returns 0 when the CLI says NONE', async () => {
    const hash = workspaceHash('/tmp/mem-extract-none');
    await service.createConversation('none', '/tmp/mem-extract-none');
    await service.setWorkspaceMemoryEnabled(hash, true);

    stubCli.queueResponse('NONE');

    const count = await memoryMcp.extractMemoryFromSession({
      workspaceHash: hash,
      conversationId: 'conv-1',
      messages: [
        { role: 'user', content: 'debug X' } as any,
        { role: 'assistant', content: 'done' } as any,
      ],
    });
    expect(count).toBe(0);
    expect(stubCli._oneShotCalls).toHaveLength(1);
  });

  test('parses a single entry response and saves it', async () => {
    const hash = workspaceHash('/tmp/mem-extract-one');
    await service.createConversation('one', '/tmp/mem-extract-one');
    await service.setWorkspaceMemoryEnabled(hash, true);

    stubCli.queueResponse(`---
name: user-prefers-terse
description: user prefers terse answers
type: feedback
---

**Why:** Asked for short responses.
**How to apply:** keep replies brief.
`);

    const count = await memoryMcp.extractMemoryFromSession({
      workspaceHash: hash,
      conversationId: 'conv-1',
      messages: [
        { role: 'user', content: 'keep it short' } as any,
        { role: 'assistant', content: 'ok' } as any,
      ],
    });
    expect(count).toBe(1);

    const snapshot = await service.getWorkspaceMemory(hash);
    expect(snapshot?.files).toHaveLength(1);
    expect(snapshot?.files[0].type).toBe('feedback');
    expect(snapshot?.files[0].source).toBe('session-extraction');
  });

  test('parses a multi-entry === delimited response and saves all entries', async () => {
    const hash = workspaceHash('/tmp/mem-extract-multi');
    await service.createConversation('multi', '/tmp/mem-extract-multi');
    await service.setWorkspaceMemoryEnabled(hash, true);

    stubCli.queueResponse(`---
name: first
description: first fact
type: user
---

Body1.
===
---
name: second
description: second fact
type: project
---

Body2.
`);

    const count = await memoryMcp.extractMemoryFromSession({
      workspaceHash: hash,
      conversationId: 'conv-1',
      messages: [{ role: 'user', content: 'x' } as any],
    });
    expect(count).toBe(2);

    const snapshot = await service.getWorkspaceMemory(hash);
    expect(snapshot?.files).toHaveLength(2);
    const types = snapshot!.files.map((f) => f.type).sort();
    expect(types).toEqual(['project', 'user']);
  });

  test('swallows runOneShot errors and returns 0', async () => {
    const hash = workspaceHash('/tmp/mem-extract-err');
    await service.createConversation('err', '/tmp/mem-extract-err');
    await service.setWorkspaceMemoryEnabled(hash, true);

    // No response queued — stub returns empty string, which should yield 0.
    const count = await memoryMcp.extractMemoryFromSession({
      workspaceHash: hash,
      conversationId: 'conv-1',
      messages: [{ role: 'user', content: 'x' } as any],
    });
    expect(count).toBe(0);
  });
});

// ── HTTP helper ───────────────────────────────────────────────────────────

let httpServer: http.Server | null = null;
let httpBaseUrl: string = '';

function startHttpServer(router: express.Router): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/mcp', router);
  return new Promise((resolve) => {
    httpServer = app.listen(0, () => {
      const addr = httpServer!.address() as { port: number };
      httpBaseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function stopHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (httpServer) httpServer.close(() => resolve());
    else resolve();
  });
}

function makeRequest(
  method: string,
  urlPath: string,
  body?: any,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, httpBaseUrl);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          let parsed: any;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── POST /memory/notes handler tests ──────────────────────────────────────

describe('POST /mcp/memory/notes', () => {
  afterEach(async () => {
    await stopHttpServer();
  });

  test('returns 401 when x-memory-token is missing', async () => {
    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'test note' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid or missing/i);
  });

  test('returns 401 when x-memory-token is invalid', async () => {
    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'test note' }, {
      'x-memory-token': 'bogus-token-that-does-not-exist',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid or missing/i);
  });

  test('returns 400 when content is missing', async () => {
    await startHttpServer(memoryMcp.router);
    const session = memoryMcp.issueMemoryMcpSession('conv-post-400', 'hash-400');
    const res = await makeRequest('POST', '/mcp/memory/notes', {}, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content is required/i);
  });

  test('returns 400 when content is empty string', async () => {
    await startHttpServer(memoryMcp.router);
    const session = memoryMcp.issueMemoryMcpSession('conv-post-400b', 'hash-400b');
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: '   ' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content is required/i);
  });

  test('returns 403 when memory is disabled for the workspace', async () => {
    const hash = workspaceHash('/tmp/mem-post-403');
    await service.createConversation('conv-post-403', '/tmp/mem-post-403');
    // Memory is NOT enabled — default is disabled.
    const session = memoryMcp.issueMemoryMcpSession('conv-post-403', hash);

    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'some note' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/memory is disabled/i);
  });

  test('returns 200 with ok:true and filename when CLI formats a note', async () => {
    const hash = workspaceHash('/tmp/mem-post-ok');
    await service.createConversation('conv-post-ok', '/tmp/mem-post-ok');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const session = memoryMcp.issueMemoryMcpSession('conv-post-ok', hash);

    stubCli.queueResponse(`---
name: user_likes_typescript
description: user prefers typescript over javascript
type: user
---

User stated they prefer TypeScript.
`);

    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'I prefer TypeScript' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.filename).toBeTruthy();
    // The filename slug has underscores converted to hyphens.
    expect(res.body.filename).toContain('user-likes-typescript');
  });

  test('returns 200 with skipped field when CLI says SKIP', async () => {
    const hash = workspaceHash('/tmp/mem-post-skip');
    await service.createConversation('conv-post-skip', '/tmp/mem-post-skip');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const session = memoryMcp.issueMemoryMcpSession('conv-post-skip', hash);

    stubCli.queueResponse('SKIP: existing_memory_file.md');

    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'duplicate note' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.skipped).toBe('existing_memory_file.md');
  });

  test('returns 502 when CLI returns empty output', async () => {
    const hash = workspaceHash('/tmp/mem-post-empty');
    await service.createConversation('conv-post-empty', '/tmp/mem-post-empty');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const session = memoryMcp.issueMemoryMcpSession('conv-post-empty', hash);

    // No response queued — stub returns empty string.
    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'some note' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/empty output/i);
  });

  test('passes type hint and tags to the Memory CLI prompt', async () => {
    const hash = workspaceHash('/tmp/mem-post-hints');
    await service.createConversation('conv-post-hints', '/tmp/mem-post-hints');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const session = memoryMcp.issueMemoryMcpSession('conv-post-hints', hash);

    stubCli.queueResponse(`---
name: test_hint
description: testing hints
type: feedback
---

Body.
`);

    await startHttpServer(memoryMcp.router);
    await makeRequest(
      'POST',
      '/mcp/memory/notes',
      { content: 'note with hints', type: 'feedback', tags: ['perf', 'ui'] },
      { 'x-memory-token': session.token },
    );

    // Verify the prompt sent to the CLI includes the type hint and tags.
    expect(stubCli._oneShotCalls).toHaveLength(1);
    const sentPrompt = stubCli._oneShotCalls[0].prompt;
    expect(sentPrompt).toContain('Suggested type: feedback');
    expect(sentPrompt).toContain('Suggested tags: perf, ui');
  });

  test('prompt includes existing memory list when workspace has entries', async () => {
    const hash = workspaceHash('/tmp/mem-post-existing');
    await service.createConversation('conv-post-existing', '/tmp/mem-post-existing');
    await service.setWorkspaceMemoryEnabled(hash, true);

    // Pre-populate one memory entry.
    stubCli.queueResponse(`---
name: first_entry
description: the first entry
type: user
---

First body.
`);
    // Use extractMemoryFromSession to persist a first entry.
    await memoryMcp.extractMemoryFromSession({
      workspaceHash: hash,
      conversationId: 'conv-post-existing',
      messages: [{ role: 'user', content: 'I am a data scientist' } as any],
    });
    // Clear call history from the extraction call.
    stubCli._oneShotCalls = [];

    // Now set up a response for the POST handler.
    stubCli.queueResponse(`---
name: second_entry
description: second entry
type: project
---

Second body.
`);

    const session = memoryMcp.issueMemoryMcpSession('conv-post-existing', hash);
    await startHttpServer(memoryMcp.router);
    await makeRequest(
      'POST',
      '/mcp/memory/notes',
      { content: 'new note' },
      { 'x-memory-token': session.token },
    );

    // The prompt should include the existing entry in the "Existing memory entries" block.
    expect(stubCli._oneShotCalls).toHaveLength(1);
    const sentPrompt = stubCli._oneShotCalls[0].prompt;
    // The existing entry appears in the prompt via its full relative path.
    expect(sentPrompt).toContain('first-entry');
    expect(sentPrompt).not.toContain('(none yet)');
  });

  test('prompt says "(none yet)" when workspace has no existing entries', async () => {
    const hash = workspaceHash('/tmp/mem-post-noexist');
    await service.createConversation('conv-post-noexist', '/tmp/mem-post-noexist');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const session = memoryMcp.issueMemoryMcpSession('conv-post-noexist', hash);

    stubCli.queueResponse(`---
name: solo_entry
description: only entry
type: user
---

Body.
`);

    await startHttpServer(memoryMcp.router);
    await makeRequest(
      'POST',
      '/mcp/memory/notes',
      { content: 'first note ever' },
      { 'x-memory-token': session.token },
    );

    expect(stubCli._oneShotCalls).toHaveLength(1);
    const sentPrompt = stubCli._oneShotCalls[0].prompt;
    expect(sentPrompt).toContain('(none yet)');
  });
});

// ── nameFromFrontmatter coverage (tested indirectly via POST handler) ─────

describe('nameFromFrontmatter via POST /mcp/memory/notes', () => {
  afterEach(async () => {
    await stopHttpServer();
  });

  test('extracts unquoted name from frontmatter into filename', async () => {
    const hash = workspaceHash('/tmp/mem-name-unquoted');
    await service.createConversation('conv-name-unquoted', '/tmp/mem-name-unquoted');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const session = memoryMcp.issueMemoryMcpSession('conv-name-unquoted', hash);

    stubCli.queueResponse(`---
name: my_slug_name
description: a test
type: user
---

Body.
`);

    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'test' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(200);
    // Underscores in the slug are converted to hyphens in the final filename.
    expect(res.body.filename).toContain('my-slug-name');
  });

  test('extracts double-quoted name from frontmatter into filename', async () => {
    const hash = workspaceHash('/tmp/mem-name-dquoted');
    await service.createConversation('conv-name-dquoted', '/tmp/mem-name-dquoted');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const session = memoryMcp.issueMemoryMcpSession('conv-name-dquoted', hash);

    stubCli.queueResponse(`---
name: "quoted_slug_name"
description: test with quotes
type: feedback
---

Body.
`);

    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'test' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(200);
    // The filename should contain the unquoted name (with hyphens).
    expect(res.body.filename).toContain('quoted-slug-name');
  });

  test('falls back when frontmatter has no name field', async () => {
    const hash = workspaceHash('/tmp/mem-name-noname');
    await service.createConversation('conv-name-noname', '/tmp/mem-name-noname');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const session = memoryMcp.issueMemoryMcpSession('conv-name-noname', hash);

    // Frontmatter without a name: field — parseFrontmatter will also have
    // name: null, so it falls back to typeHint or 'note'.
    stubCli.queueResponse(`---
description: no name here
type: reference
---

Body without name.
`);

    await startHttpServer(memoryMcp.router);
    const res = await makeRequest(
      'POST',
      '/mcp/memory/notes',
      { content: 'test', type: 'reference' },
      { 'x-memory-token': session.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Filename should fall back to the typeHint 'reference'.
    expect(res.body.filename).toContain('reference');
  });

  test('falls back to "note" when no name, no typeHint', async () => {
    const hash = workspaceHash('/tmp/mem-name-fallback');
    await service.createConversation('conv-name-fallback', '/tmp/mem-name-fallback');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const session = memoryMcp.issueMemoryMcpSession('conv-name-fallback', hash);

    stubCli.queueResponse(`---
description: minimal entry
type: unknown
---

Body.
`);

    await startHttpServer(memoryMcp.router);
    const res = await makeRequest(
      'POST',
      '/mcp/memory/notes',
      { content: 'minimal' },
      { 'x-memory-token': session.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Without name or typeHint, falls back to 'note'.
    expect(res.body.filename).toContain('note');
  });
});

// ── Additional POST handler edge-case tests ───────────────────────────────

describe('POST /mcp/memory/notes — edge cases', () => {
  afterEach(async () => {
    await stopHttpServer();
  });

  test('returns 502 when the Memory CLI throws an error', async () => {
    const hash = workspaceHash('/tmp/mem-post-clierr');
    await service.createConversation('conv-post-clierr', '/tmp/mem-post-clierr');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const session = memoryMcp.issueMemoryMcpSession('conv-post-clierr', hash);

    // Override runOneShot to throw instead of returning a queued response.
    const origRunOneShot = stubCli.runOneShot.bind(stubCli);
    stubCli.runOneShot = async () => { throw new Error('CLI process crashed'); };

    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'trigger error' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Memory CLI failed/);
    expect(res.body.error).toContain('CLI process crashed');

    // Restore.
    stubCli.runOneShot = origRunOneShot;
  });

  test('saves note even when CLI output lacks frontmatter delimiters', async () => {
    const hash = workspaceHash('/tmp/mem-post-nofm');
    await service.createConversation('conv-post-nofm', '/tmp/mem-post-nofm');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const session = memoryMcp.issueMemoryMcpSession('conv-post-nofm', hash);

    // CLI returns plain text without frontmatter.
    stubCli.queueResponse('This is a raw note without frontmatter.');

    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'raw note' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.filename).toBeTruthy();
  });

  test('emits workspace memory_update after memory_note write', async () => {
    const hash = workspaceHash('/tmp/mem-post-ws');
    await service.createConversation('conv-post-ws', '/tmp/mem-post-ws');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const memoryUpdateCalls: any[] = [];
    const wsMemoryMcp = createMemoryMcpServer({
      chatService: service,
      backendRegistry: registry,
      emitMemoryUpdate: (workspaceHash, payload) => {
        memoryUpdateCalls.push({ workspaceHash, payload });
      },
    });

    const session = wsMemoryMcp.issueMemoryMcpSession('conv-post-ws', hash);

    stubCli.queueResponse(`---
name: ws_note
description: note with ws
type: user
---

WS body.
`);

    await startHttpServer(wsMemoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'ws test' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(memoryUpdateCalls).toHaveLength(1);
    expect(memoryUpdateCalls[0].workspaceHash).toBe(hash);
    expect(memoryUpdateCalls[0].payload.type).toBe('memory_update');
    expect(memoryUpdateCalls[0].payload.fileCount).toBeGreaterThanOrEqual(1);
    expect(memoryUpdateCalls[0].payload.changedFiles).toHaveLength(1);
  });

  test('emits workspace memory_update after session extraction saves entries', async () => {
    const hash = workspaceHash('/tmp/mem-extract-ws');
    await service.createConversation('conv-extract-ws', '/tmp/mem-extract-ws');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const memoryUpdateCalls: any[] = [];
    const wsMemoryMcp = createMemoryMcpServer({
      chatService: service,
      backendRegistry: registry,
      emitMemoryUpdate: (workspaceHash, payload) => {
        memoryUpdateCalls.push({ workspaceHash, payload });
      },
    });

    stubCli.queueResponse(`---
name: extracted_ws_note
description: extracted note with ws
type: feedback
---

Extracted body.
`);

    const count = await wsMemoryMcp.extractMemoryFromSession({
      workspaceHash: hash,
      conversationId: 'conv-extract-ws',
      messages: [{ role: 'user', content: 'remember this' } as any],
    });

    expect(count).toBe(1);
    expect(memoryUpdateCalls).toHaveLength(1);
    expect(memoryUpdateCalls[0].workspaceHash).toBe(hash);
    expect(memoryUpdateCalls[0].payload).toMatchObject({
      type: 'memory_update',
      fileCount: 1,
    });
    expect(memoryUpdateCalls[0].payload.changedFiles).toHaveLength(1);
  });
});
