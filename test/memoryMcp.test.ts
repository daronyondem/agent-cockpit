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
  MemoryMetadataIndex,
  MemorySnapshot,
} from '../src/types';

const TEST_HTTP_HOST = '127.0.0.1';
const TEST_HTTP_TIMEOUT_MS = 2000;

function workspaceHash(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').substring(0, 16);
}

function memoryDir(root: string, hash: string): string {
  return path.join(root, 'data', 'chat', 'workspaces', hash, 'memory');
}

function readMemoryState(root: string, hash: string): MemoryMetadataIndex {
  return JSON.parse(fs.readFileSync(path.join(memoryDir(root, hash), 'state.json'), 'utf8'));
}

const TEST_RESUME_CAPABILITIES: BackendMetadata['resumeCapabilities'] = {
  activeTurnResume: 'unsupported',
  activeTurnResumeReason: 'Test adapter does not support active turn reattach.',
  sessionResume: 'unsupported',
  sessionResumeReason: 'Test adapter does not model session resume.',
};

// ── Test adapter that stubs runOneShot ─────────────────────────────────────

class StubMemoryCli extends BaseBackendAdapter {
  _oneShotResponses: string[] = [];
  _oneShotCalls: Array<{ prompt: string; options?: RunOneShotOptions }> = [];
  constructor(private readonly _id = 'stub-memory-cli', private readonly _label = 'Stub') {
    super();
  }

  get metadata(): BackendMetadata {
    return {
      id: this._id,
      label: this._label,
      icon: null,
      capabilities: {
        thinking: false, planMode: false, agents: false,
        toolActivity: false, userQuestions: false, stdinInput: false,
      },
      resumeCapabilities: TEST_RESUME_CAPABILITIES,
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
    const searchEndpointEntry = a.mcpServers[0].env.find((e) => e.name === 'MEMORY_SEARCH_ENDPOINT');
    expect(tokenEntry?.value).toBe(a.token);
    expect(endpointEntry?.value).toMatch(/\/api\/chat\/mcp\/memory\/notes$/);
    expect(searchEndpointEntry?.value).toMatch(/\/api\/chat\/mcp\/memory\/search$/);
  });

  test('stub exposes active/all status scope on memory_search', () => {
    const stubSource = fs.readFileSync(MEMORY_MCP_STUB_PATH, 'utf8');
    expect(stubSource).toContain("name: 'memory_search'");
    expect(stubSource).toContain("status: {");
    expect(stubSource).toContain("enum: ['active', 'all']");
    expect(stubSource).toContain('data.message || data.error');
    expect(stubSource).toContain('Memory note was not saved');
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

  test('redacts sensitive values from extracted entries before saving', async () => {
    const hash = workspaceHash('/tmp/mem-extract-redact');
    await service.createConversation('extract-redact', '/tmp/mem-extract-redact');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const token = 'sk-proj-1234567890abcdefghijklmnop';

    stubCli.queueResponse(`---
name: extracted_token_note
description: extracted token note
type: project
---

The deployment token is ${token}.
`);

    const count = await memoryMcp.extractMemoryFromSession({
      workspaceHash: hash,
      conversationId: 'conv-extract-redact',
      messages: [
        { role: 'user', content: 'remember the deployment setup' } as any,
        { role: 'assistant', content: 'noted' } as any,
      ],
    });
    expect(count).toBe(1);

    const snapshot = await service.getWorkspaceMemory(hash);
    expect(snapshot?.files).toHaveLength(1);
    expect(snapshot?.files[0].content).not.toContain(token);
    expect(snapshot?.files[0].content).toContain('[REDACTED: api_token]');
    expect(snapshot?.files[0].metadata).toMatchObject({
      status: 'redacted',
      source: 'session-extraction',
      sourceConversationId: 'conv-extract-redact',
      redaction: [{ kind: 'api_token', reason: 'API tokens must not be written to memory.' }],
    });
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
    httpServer = app.listen(0, TEST_HTTP_HOST, () => {
      const addr = httpServer!.address() as { port: number };
      httpBaseUrl = `http://${TEST_HTTP_HOST}:${addr.port}`;
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
    req.setTimeout(TEST_HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`Timed out after ${TEST_HTTP_TIMEOUT_MS}ms waiting for ${method} ${urlPath} on ${httpBaseUrl}`));
    });
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
    const settings = await service.getSettings();
    expect(settings.memory?.lastProcessorStatus).toMatchObject({
      status: 'last_succeeded',
      backendId: 'stub-memory-cli',
    });
  });

  test('classifies Memory processor auth failures with memory and chat profile context', async () => {
    const codexStub = new StubMemoryCli('codex', 'Codex');
    registry.register(codexStub);
    const now = new Date().toISOString();
    await service.saveSettings({
      theme: 'system',
      sendBehavior: 'enter',
      systemPrompt: '',
      defaultBackend: 'codex',
      defaultCliProfileId: 'chat-codex-profile',
      cliProfiles: [
        {
          id: 'chat-codex-profile',
          name: 'Chat Codex',
          vendor: 'codex',
          authMode: 'account',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'memory-codex-profile',
          name: 'Memory Codex',
          vendor: 'codex',
          authMode: 'account',
          createdAt: now,
          updatedAt: now,
        },
      ],
      memory: { cliProfileId: 'memory-codex-profile', cliBackend: 'codex' },
    });
    const settings = await service.getSettings();
    const activeProfile = settings.cliProfiles?.find((profile) => profile.id === 'chat-codex-profile');
    const hash = workspaceHash('/tmp/mem-post-auth-profile');
    await service.createConversation('conv-post-auth-profile', '/tmp/mem-post-auth-profile');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const session = memoryMcp.issueMemoryMcpSession('conv-post-auth-profile', hash, {
      activeChatRuntime: {
        backendId: 'codex',
        cliProfileId: 'chat-codex-profile',
        profile: activeProfile,
      },
    });
    codexStub.runOneShot = async () => {
      throw new Error('codex exec failed: refresh token was revoked at /Users/daron/.codex/auth.json');
    };

    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'remember this' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('memory_processor_auth_failed');
    expect(res.body.message).toContain('Chat Codex');
    expect(res.body.message).toContain('Memory Codex');
    expect(res.body.message).toContain('failed authentication');
    expect(res.body.message).not.toContain('/Users/daron/.codex/auth.json');
    expect(res.body.memoryProcessor).toMatchObject({
      status: 'authentication_failed',
      profileId: 'memory-codex-profile',
      profileName: 'Memory Codex',
      chatProfileId: 'chat-codex-profile',
      chatProfileName: 'Chat Codex',
      differsFromChatProfile: true,
    });
    expect(res.body.memoryProcessor.error).toContain('[redacted credential path]');

    const savedSettings = await service.getSettings();
    expect(savedSettings.memory?.lastProcessorStatus).toMatchObject({
      status: 'authentication_failed',
      profileId: 'memory-codex-profile',
      profileName: 'Memory Codex',
      chatProfileId: 'chat-codex-profile',
      chatProfileName: 'Chat Codex',
      differsFromChatProfile: true,
    });
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
    expect(res.body.outcome).toMatchObject({
      action: 'skipped_duplicate',
      duplicateOf: 'existing_memory_file.md',
    });
  });

  test('accepts JSON skipped_ephemeral decisions without writing a file', async () => {
    const hash = workspaceHash('/tmp/mem-post-ephemeral');
    await service.createConversation('conv-post-ephemeral', '/tmp/mem-post-ephemeral');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const memoryUpdateCalls: any[] = [];
    const wsMemoryMcp = createMemoryMcpServer({
      chatService: service,
      backendRegistry: registry,
      emitMemoryUpdate: (workspaceHash, payload) => {
        memoryUpdateCalls.push({ workspaceHash, payload });
      },
    });
    const session = wsMemoryMcp.issueMemoryMcpSession('conv-post-ephemeral', hash);

    stubCli.queueResponse(JSON.stringify({
      action: 'skipped_ephemeral',
      reason: 'This is one-off task state.',
    }));

    await startHttpServer(wsMemoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'temporary scratch note' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.skipped).toBe(true);
    expect(res.body.outcome).toMatchObject({
      action: 'skipped_ephemeral',
      reason: 'This is one-off task state.',
    });

    const snapshot = await service.getWorkspaceMemory(hash);
    expect(snapshot).toBeNull();
    expect(memoryUpdateCalls).toHaveLength(1);
    expect(memoryUpdateCalls[0].payload.changedFiles).toEqual([]);
    expect(memoryUpdateCalls[0].payload.writeOutcomes).toEqual([res.body.outcome]);
  });

  test('redacts sensitive values before prompting the Memory CLI and marks saved metadata redacted', async () => {
    const hash = workspaceHash('/tmp/mem-post-redact');
    await service.createConversation('conv-post-redact', '/tmp/mem-post-redact');
    await service.setWorkspaceMemoryEnabled(hash, true);
    const session = memoryMcp.issueMemoryMcpSession('conv-post-redact', hash);
    const token = 'sk-proj-1234567890abcdefghijklmnop';

    stubCli.queueResponse(JSON.stringify({
      action: 'saved',
      reason: 'The note contains a durable integration detail.',
      entry: `---
name: redacted_token_note
description: redacted token handling
type: project
---

The integration token was [REDACTED: api_token].
`,
    }));

    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: `Store this token: ${token}` }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toMatchObject({
      action: 'redacted_saved',
      filename: expect.stringContaining('redacted-token-note'),
    });
    expect(res.body.outcome.redaction).toEqual([
      { kind: 'api_token', reason: 'API tokens must not be written to memory.' },
    ]);

    expect(stubCli._oneShotCalls).toHaveLength(1);
    expect(stubCli._oneShotCalls[0].prompt).not.toContain(token);
    expect(stubCli._oneShotCalls[0].prompt).toContain('[REDACTED: api_token]');

    const snapshot = await service.getWorkspaceMemory(hash);
    const entry = snapshot?.files.find((file) => file.filename === res.body.filename);
    expect(entry?.content).not.toContain(token);
    expect(entry?.metadata).toMatchObject({
      status: 'redacted',
      sourceConversationId: 'conv-post-redact',
      redaction: [{ kind: 'api_token', reason: 'API tokens must not be written to memory.' }],
    });
  });

  test('accepts JSON superseded_saved decisions and marks older entries superseded', async () => {
    const hash = workspaceHash('/tmp/mem-post-supersede');
    await service.createConversation('conv-post-supersede', '/tmp/mem-post-supersede');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const oldRelPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: old_memory
description: old memory
type: project
---

Old body.
`,
      source: 'memory-note',
      filenameHint: 'old-memory',
    });
    const oldEntryId = readMemoryState(tmpDir, hash).entries[oldRelPath].entryId;

    const session = memoryMcp.issueMemoryMcpSession('conv-post-supersede', hash);
    stubCli.queueResponse(JSON.stringify({
      action: 'superseded_saved',
      reason: 'The new note replaces the old project memory.',
      supersedes: [oldRelPath],
      entry: `---
name: new_memory
description: new memory
type: project
---

New body.
`,
    }));

    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/notes', { content: 'replace the old project memory' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toMatchObject({
      action: 'superseded_saved',
      filename: expect.stringContaining('new-memory'),
      superseded: [oldRelPath],
    });

    const state = readMemoryState(tmpDir, hash);
    const newEntryId = state.entries[res.body.filename].entryId;
    expect(state.entries[res.body.filename]).toMatchObject({
      status: 'active',
      supersedes: [oldEntryId],
    });
    expect(state.entries[oldRelPath]).toMatchObject({
      status: 'superseded',
      supersededBy: newEntryId,
    });
  });

  test('proposes manual consolidation without exposing redacted content', async () => {
    const hash = workspaceHash('/tmp/mem-consolidate-propose');
    await service.createConversation('consolidate-propose', '/tmp/mem-consolidate-propose');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const oldRelPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: old_token_memory
description: old token memory
type: project
---

The sensitive token is sk-proj-secretsecretsecretsecret.
`,
      source: 'memory-note',
      filenameHint: 'old-token-memory',
    });
    const newRelPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: current_token_policy
description: current token policy
type: project
---

Tokens must not be stored in memory.
`,
      source: 'memory-note',
      filenameHint: 'current-token-policy',
    });
    await service.patchMemoryEntryMetadata(hash, [{
      filename: oldRelPath,
      patch: {
        status: 'redacted',
        redaction: [{ kind: 'api_token', reason: 'API tokens must not be written to memory.' }],
      },
    }]);

    stubCli.queueResponse(JSON.stringify({
      summary: 'Found one stale redacted project memory.',
      actions: [
        {
          action: 'mark_superseded',
          filename: oldRelPath,
          supersededBy: newRelPath,
          reason: 'The current policy replaces the old token memory.',
        },
        {
          action: 'merge_candidates',
          filenames: [oldRelPath, newRelPath],
          reason: 'Both entries concern token handling.',
        },
      ],
    }));

    const proposal = await memoryMcp.proposeMemoryConsolidation(hash);

    expect(proposal.summary).toBe('Found one stale redacted project memory.');
    expect(proposal.actions).toEqual([
      {
        action: 'mark_superseded',
        filename: oldRelPath,
        supersededBy: newRelPath,
        reason: 'The current policy replaces the old token memory.',
      },
      {
        action: 'merge_candidates',
        filenames: [oldRelPath, newRelPath],
        reason: 'Both entries concern token handling.',
      },
    ]);
    expect(stubCli._oneShotCalls[0].prompt).not.toContain('sk-proj-secretsecretsecretsecret');
    expect(stubCli._oneShotCalls[0].prompt).toContain('redacted content withheld');
  });

  test('applies only supersession consolidation actions and writes an audit', async () => {
    const hash = workspaceHash('/tmp/mem-consolidate-apply');
    await service.createConversation('consolidate-apply', '/tmp/mem-consolidate-apply');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const oldRelPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: old_project_deadline
description: old deadline
type: project
---

The deadline is Thursday.
`,
      source: 'memory-note',
      filenameHint: 'old-project-deadline',
    });
    const newRelPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: new_project_deadline
description: new deadline
type: project
---

The deadline is Friday.
`,
      source: 'memory-note',
      filenameHint: 'new-project-deadline',
    });
    const oldEntryId = readMemoryState(tmpDir, hash).entries[oldRelPath].entryId;
    const newEntryId = readMemoryState(tmpDir, hash).entries[newRelPath].entryId;
    const memoryUpdateCalls: any[] = [];
    const wsMemoryMcp = createMemoryMcpServer({
      chatService: service,
      backendRegistry: registry,
      emitMemoryUpdate: (workspaceHash, payload) => {
        memoryUpdateCalls.push({ workspaceHash, payload });
      },
    });

    const result = await wsMemoryMcp.applyMemoryConsolidation(hash, {
      summary: 'Deadline cleanup.',
      actions: [
        {
          action: 'mark_superseded',
          filename: oldRelPath,
          supersededBy: newRelPath,
          reason: 'Friday replaces Thursday.',
        },
        {
          action: 'normalize_candidate',
          filename: newRelPath,
          title: 'New deadline',
          reason: 'Title could be clearer.',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.auditPath).toMatch(/^audits\/consolidation_/);
    expect(fs.existsSync(path.join(memoryDir(tmpDir, hash), result.auditPath!))).toBe(true);

    const state = readMemoryState(tmpDir, hash);
    expect(state.entries[oldRelPath]).toMatchObject({
      status: 'superseded',
      supersededBy: newEntryId,
    });
    expect(state.entries[newRelPath].supersedes).toEqual([oldEntryId]);
    expect(memoryUpdateCalls).toHaveLength(1);
    expect(memoryUpdateCalls[0].payload.changedFiles.sort()).toEqual([newRelPath, oldRelPath].sort());
  });

  test('drafts merge consolidation operations with full non-redacted source content', async () => {
    const hash = workspaceHash('/tmp/mem-consolidate-draft');
    await service.createConversation('consolidate-draft', '/tmp/mem-consolidate-draft');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const firstRelPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: node_tests
description: node test preference
type: feedback
---

Use node:test for small service tests.
`,
      source: 'memory-note',
      filenameHint: 'node-tests',
    });
    const secondRelPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: service_tests
description: service test preference
type: feedback
---

Prefer node:test for service-level coverage.
`,
      source: 'memory-note',
      filenameHint: 'service-tests',
    });

    stubCli.queueResponse(JSON.stringify({
      summary: 'Merge duplicate testing preferences.',
      operations: [{
        operation: 'create',
        filenameHint: 'node-test-preference',
        supersedes: [firstRelPath, secondRelPath],
        reason: 'Both entries describe the same testing preference.',
        content: `---
name: node_test_preference
description: user prefers node:test for service tests
type: feedback
---

Use node:test for focused service-level coverage.
`,
      }],
    }));

    const draft = await memoryMcp.draftMemoryConsolidation(hash, {
      action: {
        action: 'merge_candidates',
        filenames: [firstRelPath, secondRelPath],
        reason: 'Duplicate testing preferences.',
      },
    });

    expect(draft.summary).toBe('Merge duplicate testing preferences.');
    expect(draft.operations).toEqual([{
      operation: 'create',
      filenameHint: 'node-test-preference',
      supersedes: [firstRelPath, secondRelPath],
      reason: 'Both entries describe the same testing preference.',
      content: `---
name: node_test_preference
description: user prefers node:test for service tests
type: feedback
---

Use node:test for focused service-level coverage.`,
    }]);
    expect(stubCli._oneShotCalls[0].prompt).toContain(firstRelPath);
    expect(stubCli._oneShotCalls[0].prompt).toContain('Use node:test for small service tests.');
    expect(stubCli._oneShotCalls[0].prompt).toContain('Draft exact');
  });

  test('does not draft rewrites for redacted source entries', async () => {
    const hash = workspaceHash('/tmp/mem-consolidate-draft-redacted');
    await service.createConversation('consolidate-draft-redacted', '/tmp/mem-consolidate-draft-redacted');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const relPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: token_policy
description: token policy
type: project
---

Token sk-proj-secretsecretsecretsecret must never be stored.
`,
      source: 'memory-note',
      filenameHint: 'token-policy',
    });
    await service.patchMemoryEntryMetadata(hash, [{
      filename: relPath,
      patch: {
        status: 'redacted',
        redaction: [{ kind: 'api_token', reason: 'API tokens must not be written to memory.' }],
      },
    }]);

    await expect(memoryMcp.draftMemoryConsolidation(hash, {
      action: {
        action: 'normalize_candidate',
        filename: relPath,
        reason: 'Clean up redacted entry.',
      },
    })).rejects.toThrow(/redacted/);
    expect(stubCli._oneShotCalls).toHaveLength(0);
  });

  test('applies create draft operations by writing a note and superseding sources', async () => {
    const hash = workspaceHash('/tmp/mem-consolidate-apply-draft');
    await service.createConversation('consolidate-apply-draft', '/tmp/mem-consolidate-apply-draft');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const firstRelPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: old_testing_a
description: testing preference a
type: feedback
---

Use node:test for services.
`,
      source: 'memory-note',
      filenameHint: 'old-testing-a',
    });
    const secondRelPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: old_testing_b
description: testing preference b
type: feedback
---

Use node:test for service modules.
`,
      source: 'memory-note',
      filenameHint: 'old-testing-b',
    });
    const firstEntryId = readMemoryState(tmpDir, hash).entries[firstRelPath].entryId;
    const secondEntryId = readMemoryState(tmpDir, hash).entries[secondRelPath].entryId;
    const memoryUpdateCalls: any[] = [];
    const wsMemoryMcp = createMemoryMcpServer({
      chatService: service,
      backendRegistry: registry,
      emitMemoryUpdate: (workspaceHash, payload) => {
        memoryUpdateCalls.push({ workspaceHash, payload });
      },
    });

    const result = await wsMemoryMcp.applyMemoryConsolidationDraft(hash, {
      summary: 'Apply merged testing preference.',
      draft: {
        id: 'draft-test',
        createdAt: '2026-04-07T12:00:00.000Z',
        summary: 'Merge testing preferences.',
        action: {
          action: 'merge_candidates',
          filenames: [firstRelPath, secondRelPath],
          reason: 'Duplicate testing preferences.',
        },
        operations: [{
          operation: 'create',
          filenameHint: 'node-test-preference',
          supersedes: [firstRelPath, secondRelPath],
          reason: 'Merged duplicate preferences.',
          content: `---
name: node_test_preference
description: user prefers node:test for services
type: feedback
---

Use node:test for focused service coverage.
`,
        }],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toHaveLength(1);
    expect(result.createdFiles).toHaveLength(1);
    expect(result.auditPath).toMatch(/^audits\/consolidation_/);

    const createdPath = result.createdFiles[0];
    const state = readMemoryState(tmpDir, hash);
    expect(state.entries[createdPath].supersedes).toEqual([firstEntryId, secondEntryId]);
    expect(state.entries[firstRelPath]).toMatchObject({
      status: 'superseded',
      supersededBy: state.entries[createdPath].entryId,
    });
    expect(state.entries[secondRelPath]).toMatchObject({
      status: 'superseded',
      supersededBy: state.entries[createdPath].entryId,
    });
    const audit = JSON.parse(fs.readFileSync(path.join(memoryDir(tmpDir, hash), result.auditPath!), 'utf8'));
    expect(audit.appliedDraftOperations).toHaveLength(1);
    expect(audit.applied).toEqual([]);
    expect(memoryUpdateCalls).toHaveLength(1);
    expect(memoryUpdateCalls[0].payload.changedFiles.sort()).toEqual([createdPath, firstRelPath, secondRelPath].sort());
  });

  test('applies replace draft operations only to selected notes entries', async () => {
    const hash = workspaceHash('/tmp/mem-consolidate-replace-draft');
    await service.createConversation('consolidate-replace-draft', '/tmp/mem-consolidate-replace-draft');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const relPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: messy_title
description: old description
type: project
---

Keep the body.
`,
      source: 'memory-note',
      filenameHint: 'messy-title',
    });

    const result = await memoryMcp.applyMemoryConsolidationDraft(hash, {
      draft: {
        id: 'draft-replace',
        createdAt: '2026-04-07T12:00:00.000Z',
        summary: 'Normalize metadata.',
        action: {
          action: 'normalize_candidate',
          filename: relPath,
          reason: 'Clean title.',
        },
        operations: [{
          operation: 'replace',
          filename: relPath,
          reason: 'Normalize name and description.',
          content: `---
name: project_memory_title
description: clear project memory description
type: project
---

Keep the body.
`,
        }],
      },
    });

    expect(result.applied).toHaveLength(1);
    expect(result.createdFiles).toHaveLength(0);
    const snapshot = await service.getWorkspaceMemory(hash);
    const file = snapshot!.files.find((item) => item.filename === relPath);
    expect(file?.name).toBe('project_memory_title');
    expect(file?.description).toBe('clear project memory description');
    expect(readMemoryState(tmpDir, hash).entries[relPath].status).toBe('active');
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
    expect(res.body.code).toBe('memory_processor_bad_output');
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

describe('POST /mcp/memory/search', () => {
  afterEach(async () => {
    await stopHttpServer();
  });

  test('returns 401 when x-memory-token is missing', async () => {
    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/search', { query: 'typescript' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid or missing/i);
  });

  test('returns 400 when query is missing', async () => {
    await startHttpServer(memoryMcp.router);
    const session = memoryMcp.issueMemoryMcpSession('conv-search-400', 'hash-search-400');
    const res = await makeRequest('POST', '/mcp/memory/search', {}, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query is required/i);
  });

  test('returns 403 when memory is disabled for the workspace', async () => {
    const hash = workspaceHash('/tmp/mem-search-disabled');
    await service.createConversation('conv-search-disabled', '/tmp/mem-search-disabled');
    const session = memoryMcp.issueMemoryMcpSession('conv-search-disabled', hash);

    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/search', { query: 'typescript' }, {
      'x-memory-token': session.token,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/memory is disabled/i);
  });

  test('returns lexical memory results and omits content when requested', async () => {
    const hash = workspaceHash('/tmp/mem-search-ok');
    await service.createConversation('conv-search-ok', '/tmp/mem-search-ok');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const relPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: prefers_typescript
description: user prefers TypeScript examples
type: user
---

Use TypeScript examples when showing frontend code.
`,
      source: 'memory-note',
      filenameHint: 'prefers-typescript',
    });
    await service.addMemoryNoteEntry(hash, {
      content: `---
name: unrelated_deadline
description: rollout deadline
type: project
---

The rollout deadline is Friday.
`,
      source: 'memory-note',
      filenameHint: 'deadline',
    });

    const session = memoryMcp.issueMemoryMcpSession('conv-search-ok', hash);
    await startHttpServer(memoryMcp.router);
    const res = await makeRequest('POST', '/mcp/memory/search', {
      query: 'typescript frontend examples',
      limit: 3,
      include_content: false,
    }, {
      'x-memory-token': session.token,
    });

    expect(res.status).toBe(200);
    expect(res.body.query).toBe('typescript frontend examples');
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({
      filename: relPath,
      type: 'user',
      status: 'active',
      score: expect.any(Number),
      snippet: expect.stringMatching(/TypeScript/i),
    });
    expect(res.body.results[0]).not.toHaveProperty('content');
  });

  test('honors memory_search status all scope', async () => {
    const hash = workspaceHash('/tmp/mem-search-status-all');
    await service.createConversation('conv-search-status-all', '/tmp/mem-search-status-all');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const activePath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: active_typescript
description: active TypeScript guidance
type: user
---

Use TypeScript examples.
`,
      source: 'memory-note',
      filenameHint: 'active-typescript',
    });
    const oldPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: old_typescript
description: old TypeScript guidance
type: user
---

Old TypeScript examples.
`,
      source: 'memory-note',
      filenameHint: 'old-typescript',
    });
    await service.patchMemoryEntryMetadata(hash, [{
      filename: oldPath,
      patch: { status: 'superseded' },
    }]);

    const session = memoryMcp.issueMemoryMcpSession('conv-search-status-all', hash);
    await startHttpServer(memoryMcp.router);
    const defaultRes = await makeRequest('POST', '/mcp/memory/search', {
      query: 'typescript',
      limit: 5,
    }, {
      'x-memory-token': session.token,
    });
    expect(defaultRes.status).toBe(200);
    expect(defaultRes.body.results.map((result: { filename: string }) => result.filename)).toEqual([activePath]);

    const allRes = await makeRequest('POST', '/mcp/memory/search', {
      query: 'typescript',
      status: 'all',
      limit: 5,
    }, {
      'x-memory-token': session.token,
    });
    expect(allRes.status).toBe(200);
    expect(allRes.body.results.map((result: { filename: string }) => result.filename)).toEqual(
      expect.arrayContaining([activePath, oldPath]),
    );
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
    expect(res.body.error).toMatch(/Memory note was not saved/);
    expect(res.body.code).toBe('memory_processor_runtime_failed');
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
    expect(memoryUpdateCalls[0].payload.sourceConversationId).toBe('conv-post-ws');
    expect(memoryUpdateCalls[0].payload.displayInChat).toBe(true);
    expect(memoryUpdateCalls[0].payload.writeOutcomes).toEqual([
      expect.objectContaining({
        action: 'saved',
        filename: res.body.filename,
      }),
    ]);
  });

  test('emits refresh-only workspace memory_update after session extraction saves entries', async () => {
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
      sourceConversationId: null,
      displayInChat: false,
    });
    expect(memoryUpdateCalls[0].payload.changedFiles).toHaveLength(1);
  });
});
