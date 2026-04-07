import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
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
    getWsFns: () => null,
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

  test('reissuing a session for the same conversation revokes the previous token', () => {
    const first = memoryMcp.issueMemoryMcpSession('conv-x', 'hash-x');
    const second = memoryMcp.issueMemoryMcpSession('conv-x', 'hash-x');
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
