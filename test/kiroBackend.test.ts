import { BaseBackendAdapter } from '../src/services/backends/base';
import { BackendRegistry } from '../src/services/backends/registry';
import { KiroAdapter, extractKiroToolDetails, collectImageContentBlocks } from '../src/services/backends/kiro';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BackendMetadata, SendMessageResult } from '../src/types';

// ── KiroAdapter metadata ────────────────────────────────────────────────────

describe('KiroAdapter', () => {
  test('metadata has correct shape', () => {
    const adapter = new KiroAdapter({ workingDir: '/tmp' });
    const meta = adapter.metadata;
    expect(meta.id).toBe('kiro');
    expect(meta.label).toBe('Kiro');
    expect(meta.icon).toContain('<svg');
    expect(meta.capabilities).toEqual({
      thinking: true,
      planMode: false,
      agents: true,
      toolActivity: true,
      userQuestions: false,
      stdinInput: false,
    });
  });

  test('metadata.models is populated immediately with hardcoded list', () => {
    const adapter = new KiroAdapter({ workingDir: '/tmp' });
    const models = adapter.metadata.models;
    expect(models).toBeDefined();
    expect(models!.length).toBe(13); // auto + 3 opus + 3 sonnet + haiku + 5 open-weight

    const auto = models!.find(m => m.id === 'auto');
    expect(auto).toBeDefined();
    expect(auto!.default).toBe(true);
    expect(auto!.family).toBe('router');
    expect(auto!.costTier).toBe('medium');

    // auto is the only default
    expect(models!.filter(m => m.default).length).toBe(1);

    const opus47 = models!.find(m => m.id === 'claude-opus-4.7');
    expect(opus47).toBeDefined();
    expect(opus47!.family).toBe('opus');
    expect(opus47!.costTier).toBe('high');

    const opus45 = models!.find(m => m.id === 'claude-opus-4.5');
    expect(opus45).toBeDefined();
    expect(opus45!.family).toBe('opus');

    const sonnet46 = models!.find(m => m.id === 'claude-sonnet-4.6');
    expect(sonnet46).toBeDefined();
    expect(sonnet46!.family).toBe('sonnet');
    expect(sonnet46!.costTier).toBe('medium');

    const sonnet40 = models!.find(m => m.id === 'claude-sonnet-4.0');
    expect(sonnet40).toBeDefined();
    expect(sonnet40!.family).toBe('sonnet');

    const haiku = models!.find(m => m.id === 'claude-haiku-4.5');
    expect(haiku).toBeDefined();
    expect(haiku!.family).toBe('haiku');
    expect(haiku!.costTier).toBe('low');

    // Open-weight models are tagged family='other' and costTier='low'
    for (const id of ['deepseek-3.2', 'minimax-m2.5', 'minimax-m2.1', 'glm-5', 'qwen3-coder-next']) {
      const m = models!.find(x => x.id === id);
      expect(m).toBeDefined();
      expect(m!.family).toBe('other');
      expect(m!.costTier).toBe('low');
    }
  });

  test('stdinInput is false', () => {
    const adapter = new KiroAdapter();
    expect(adapter.metadata.capabilities.stdinInput).toBe(false);
  });

  test('uses default working directory', () => {
    const adapter = new KiroAdapter();
    expect(adapter.workingDir).toContain('.kiro');
  });

  test('accepts custom working directory', () => {
    const adapter = new KiroAdapter({ workingDir: '/tmp/test' });
    expect(adapter.workingDir).toBe('/tmp/test');
  });

  test('extends BaseBackendAdapter', () => {
    const adapter = new KiroAdapter();
    expect(adapter).toBeInstanceOf(BaseBackendAdapter);
  });

  test('can be registered in BackendRegistry', () => {
    const registry = new BackendRegistry();
    const adapter = new KiroAdapter({ workingDir: '/tmp' });
    registry.register(adapter);
    expect(registry.get('kiro')).toBe(adapter);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].id).toBe('kiro');
  });

  test('sendMessage returns stream, abort, and sendInput', () => {
    const adapter = new KiroAdapter({ workingDir: '/tmp' });
    const { stream, abort, sendInput } = adapter.sendMessage('hello', {
      sessionId: 'test-session',
      isNewSession: true,
      workingDir: '/tmp',
      systemPrompt: '',
    });

    expect(stream).toBeDefined();
    expect(typeof stream[Symbol.asyncIterator]).toBe('function');
    expect(typeof abort).toBe('function');
    expect(typeof sendInput).toBe('function');

    // sendInput is a no-op for Kiro — should not throw
    expect(() => sendInput('some text')).not.toThrow();

    // Abort to prevent the stream from hanging
    abort();
  });
});

// ── Shutdown & Reset ──────────────────────────────────���───────────────────

describe('KiroAdapter lifecycle', () => {
  test('shutdown does not throw when no processes', () => {
    const adapter = new KiroAdapter();
    expect(() => adapter.shutdown()).not.toThrow();
  });

  test('onSessionReset does not throw when no processes', () => {
    const adapter = new KiroAdapter();
    expect(() => adapter.onSessionReset('nonexistent-conv')).not.toThrow();
  });
});

// ── BackendRegistry with Kiro ───────────────────────────────────────────────

describe('BackendRegistry with KiroAdapter', () => {
  test('registers alongside ClaudeCodeAdapter', () => {
    const { ClaudeCodeAdapter } = require('../src/services/backends/claudeCode');
    const registry = new BackendRegistry();
    registry.register(new ClaudeCodeAdapter({ workingDir: '/tmp' }));
    registry.register(new KiroAdapter({ workingDir: '/tmp' }));

    expect(registry.list()).toHaveLength(2);
    expect(registry.get('claude-code')).toBeDefined();
    expect(registry.get('kiro')).toBeDefined();
    expect(registry.getDefault()?.metadata.id).toBe('claude-code'); // First registered = default
  });

  test('shutdownAll calls shutdown on all adapters', () => {
    const registry = new BackendRegistry();
    const kiro = new KiroAdapter({ workingDir: '/tmp' });
    const shutdownSpy = jest.spyOn(kiro, 'shutdown');
    registry.register(kiro);
    registry.shutdownAll();
    expect(shutdownSpy).toHaveBeenCalled();
  });
});

// ── extractKiroToolDetails ──────────────────────────────────────────────────

describe('extractKiroToolDetails', () => {
  // ── File operations ────────────────────────────────────────────────────
  test('read normalizes to Read', () => {
    const result = extractKiroToolDetails('call-1', 'read', 'Reading /src/index.ts');
    expect(result.tool).toBe('Read');
    expect(result.description).toBe('Reading /src/index.ts');
    expect(result.id).toBe('call-1');
  });

  test('fs_read normalizes to Read', () => {
    const result = extractKiroToolDetails('call-2', 'fs_read', 'Reading file');
    expect(result.tool).toBe('Read');
  });

  test('fsRead normalizes to Read', () => {
    const result = extractKiroToolDetails('call-3', 'fsRead', 'Reading file');
    expect(result.tool).toBe('Read');
  });

  test('write normalizes to Write', () => {
    const result = extractKiroToolDetails('call-4', 'write', 'Creating app.py');
    expect(result.tool).toBe('Write');
    expect(result.description).toBe('Creating app.py');
  });

  test('fs_write normalizes to Write', () => {
    const result = extractKiroToolDetails('call-5', 'fs_write', 'Writing file');
    expect(result.tool).toBe('Write');
  });

  test('fsWrite normalizes to Write', () => {
    const result = extractKiroToolDetails('call-6', 'fsWrite', 'Writing file');
    expect(result.tool).toBe('Write');
  });

  // ── Shell / Bash ───────────────────────────────────────────────────────
  test('shell normalizes to Bash', () => {
    const result = extractKiroToolDetails('call-7', 'shell', 'npm install');
    expect(result.tool).toBe('Bash');
    expect(result.description).toBe('npm install');
  });

  test('execute_bash normalizes to Bash', () => {
    const result = extractKiroToolDetails('call-8', 'execute_bash', 'Running command');
    expect(result.tool).toBe('Bash');
  });

  test('execute_cmd normalizes to Bash', () => {
    const result = extractKiroToolDetails('call-9', 'execute_cmd', 'Running command');
    expect(result.tool).toBe('Bash');
  });

  // ── Search ─────────────────────────────────────────────────────────────
  test('grep normalizes to Grep', () => {
    const result = extractKiroToolDetails('call-10', 'grep', 'Searching for TODO');
    expect(result.tool).toBe('Grep');
  });

  test('glob normalizes to Glob', () => {
    const result = extractKiroToolDetails('call-11', 'glob', 'Finding *.ts files');
    expect(result.tool).toBe('Glob');
  });

  // ── Agent / Delegation ─────────────────────────────────────────────────
  test('delegate normalizes to Agent with isAgent flag', () => {
    const result = extractKiroToolDetails('call-12', 'delegate', 'Researching API docs');
    expect(result.tool).toBe('Agent');
    expect(result.isAgent).toBe(true);
    expect(result.subagentType).toBe('general-purpose');
  });

  test('subagent normalizes to Agent with isAgent flag', () => {
    const result = extractKiroToolDetails('call-13', 'subagent', 'Running sub-agent');
    expect(result.tool).toBe('Agent');
    expect(result.isAgent).toBe(true);
  });

  test('use_subagent normalizes to Agent with isAgent flag', () => {
    const result = extractKiroToolDetails('call-14', 'use_subagent', 'Running sub-agent');
    expect(result.tool).toBe('Agent');
    expect(result.isAgent).toBe(true);
  });

  // ── Web tools ──────────────────────────────────────────────────────────
  test('web_search normalizes to WebSearch', () => {
    const result = extractKiroToolDetails('call-15', 'web_search', 'Searching: node.js streams');
    expect(result.tool).toBe('WebSearch');
  });

  test('web_fetch normalizes to WebFetch', () => {
    const result = extractKiroToolDetails('call-16', 'web_fetch', 'Fetching https://example.com');
    expect(result.tool).toBe('WebFetch');
  });

  // ── Task management ────────────────────────────────────────────────────
  test('todo normalizes to TodoWrite', () => {
    const result = extractKiroToolDetails('call-17', 'todo', 'Updating task list');
    expect(result.tool).toBe('TodoWrite');
  });

  // ── Kiro-specific tools ────────────────────────────────────────────────
  test('aws normalizes to AWS', () => {
    const result = extractKiroToolDetails('call-18', 'aws', 'Running AWS CLI: s3');
    expect(result.tool).toBe('AWS');
  });

  test('use_aws normalizes to AWS', () => {
    const result = extractKiroToolDetails('call-19', 'use_aws', 'Running AWS CLI');
    expect(result.tool).toBe('AWS');
  });

  test('code normalizes to Code', () => {
    const result = extractKiroToolDetails('call-20', 'code', 'Symbol search');
    expect(result.tool).toBe('Code');
  });

  test('introspect normalizes to Introspect', () => {
    const result = extractKiroToolDetails('call-21', 'introspect', 'Checking Kiro docs');
    expect(result.tool).toBe('Introspect');
  });

  test('knowledge normalizes to Knowledge', () => {
    const result = extractKiroToolDetails('call-22', 'knowledge', 'Accessing knowledge base');
    expect(result.tool).toBe('Knowledge');
  });

  // ── Unknown tools ──────────────────────────────────────────────────────
  test('unknown tool passes through name', () => {
    const result = extractKiroToolDetails('call-23', 'some_new_tool', 'Doing something');
    expect(result.tool).toBe('some_new_tool');
    expect(result.description).toBe('Doing something');
  });

  test('unknown tool with empty title gets generic description', () => {
    const result = extractKiroToolDetails('call-24', 'some_new_tool', '');
    expect(result.description).toBe('Using some_new_tool');
  });

  // ── Non-agent tools don't set isAgent ──────────────────────────────────
  test('non-agent tools do not set isAgent', () => {
    const result = extractKiroToolDetails('call-25', 'read', 'Reading file');
    expect(result.isAgent).toBeUndefined();
  });
});

// ── generateSummary / generateTitle fallbacks ───────────────────────────────

describe('KiroAdapter generateSummary', () => {
  test('returns fallback for empty messages', async () => {
    const adapter = new KiroAdapter();
    const result = await adapter.generateSummary([], 'fallback text');
    expect(result).toBe('fallback text');
  });

  test('returns default fallback when messages empty and no fallback', async () => {
    const adapter = new KiroAdapter();
    const result = await adapter.generateSummary([], '');
    expect(result).toBe('Empty session');
  });
});

describe('KiroAdapter generateTitle', () => {
  test('returns fallback for empty message', async () => {
    const adapter = new KiroAdapter();
    const result = await adapter.generateTitle('', 'My Fallback');
    expect(result).toBe('My Fallback');
  });

  test('returns New Chat for empty message and no fallback', async () => {
    const adapter = new KiroAdapter();
    const result = await adapter.generateTitle('', '');
    expect(result).toBe('New Chat');
  });
});

// ── KiroAdapter.runOneShot (ACP-based) ──────────────────────────────────────
//
// runOneShot speaks ACP (JSON-RPC over stdio) instead of `kiro-cli chat`,
// because chat output bakes tool-call narration into the answer text and
// requires fragile string parsing. ACP gives us structured `agent_message_chunk`
// notifications distinct from `tool_call` / `tool_call_update`, so we can
// collect just the model's final text without seeing tool narration at all.

describe('KiroAdapter.runOneShot', () => {
  // Build a fake kiro-cli acp process. Tests interact with it via
  // `respond` / `notify` / `sessionUpdate` to drive the JSON-RPC exchange.
  function createKiroSimulator() {
    const { EventEmitter } = require('events');
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();

    const stdinWrites: string[] = [];
    const requestLog: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
    let lineBuf = '';

    const sim: {
      proc: any;
      requestLog: typeof requestLog;
      stdinWrites: string[];
      onRequest: ((msg: { id: number; method: string; params?: Record<string, unknown> }) => void) | null;
      respond: (id: number, result: unknown) => void;
      rejectRequest: (id: number, message: string) => void;
      notify: (method: string, params?: unknown, id?: number) => void;
      sessionUpdate: (sessionId: string, update: Record<string, unknown>) => void;
      findRequest: (method: string) => { id: number; method: string; params?: Record<string, unknown> } | undefined;
      findResponseTo: (id: number) => Record<string, unknown> | undefined;
    } = {
      proc,
      requestLog,
      stdinWrites,
      onRequest: null,
      respond: (id, result) => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'));
      },
      rejectRequest: (id, message) => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n'));
      },
      notify: (method, params, id) => {
        const msg: Record<string, unknown> = { jsonrpc: '2.0', method, params };
        if (id != null) msg.id = id;
        proc.stdout.emit('data', Buffer.from(JSON.stringify(msg) + '\n'));
      },
      sessionUpdate: (sessionId, update) => {
        sim.notify('session/update', { sessionId, update });
      },
      findRequest: (method) => requestLog.find((r) => r.method === method),
      findResponseTo: (id) => {
        for (const line of stdinWrites.flatMap((w) => w.split('\n'))) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === id && !msg.method) return msg;
          } catch {
            // ignore
          }
        }
        return undefined;
      },
    };

    proc.stdin = {
      write: (s: string) => {
        stdinWrites.push(s);
        lineBuf += s;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.method && msg.id != null) {
              requestLog.push(msg);
              if (sim.onRequest) sim.onRequest(msg);
            }
          } catch {
            // ignore
          }
        }
        return true;
      },
      destroyed: false,
    };
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = () => {
      if (!proc.killed) {
        proc.killed = true;
        proc.exitCode = 0;
        setImmediate(() => proc.emit('close', 0, 'SIGTERM'));
      }
    };

    return sim;
  }

  // Wait for a request with a given method to arrive. Polls every 5ms.
  async function waitForRequest(sim: ReturnType<typeof createKiroSimulator>, method: string, timeoutMs = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const req = sim.findRequest(method);
      if (req) return req;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`Timed out waiting for ${method} request`);
  }

  test('returns only post-tool agent text (filters out pre-tool reasoning)', async () => {
    let resultPromise!: Promise<string>;
    let sim!: ReturnType<typeof createKiroSimulator>;

    jest.isolateModules(() => {
      sim = createKiroSimulator();
      jest.mock('child_process', () => ({
        spawn: () => sim.proc,
        execFile: () => {},
      }));
      const { KiroAdapter: IsolatedAdapter } = require('../src/services/backends/kiro');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('OCR this image', { workingDir: '/tmp' });
    });

    const initReq = await waitForRequest(sim, 'initialize');
    sim.respond(initReq.id, {});
    const newReq = await waitForRequest(sim, 'session/new');
    sim.respond(newReq.id, { sessionId: 'sess-1' });
    const promptReq = await waitForRequest(sim, 'session/prompt');

    // Pre-tool reasoning — should be discarded when tool_call arrives
    sim.sessionUpdate('sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Let me read the image first.' },
    });
    await new Promise((r) => setTimeout(r, 20));
    sim.sessionUpdate('sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-read',
      kind: 'read',
      title: 'Reading image',
      status: 'pending',
    });
    await new Promise((r) => setTimeout(r, 20));
    sim.sessionUpdate('sess-1', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-read',
      status: 'completed',
    });
    // Post-tool answer — should be the only thing returned
    sim.sessionUpdate('sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '# Heading\n\n| col | col |\n|---|---|\n| a | b |' },
    });
    await new Promise((r) => setTimeout(r, 30));
    sim.respond(promptReq.id, { stopReason: 'end_turn' });

    const result = await resultPromise;
    expect(result).toBe('# Heading\n\n| col | col |\n|---|---|\n| a | b |');
    expect(result).not.toContain('Let me read');
  });

  test('returns concatenated text when no tools are called', async () => {
    let resultPromise!: Promise<string>;
    let sim!: ReturnType<typeof createKiroSimulator>;

    jest.isolateModules(() => {
      sim = createKiroSimulator();
      jest.mock('child_process', () => ({
        spawn: () => sim.proc,
        execFile: () => {},
      }));
      const { KiroAdapter: IsolatedAdapter } = require('../src/services/backends/kiro');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('hi', { workingDir: '/tmp' });
    });

    const initReq = await waitForRequest(sim, 'initialize');
    sim.respond(initReq.id, {});
    const newReq = await waitForRequest(sim, 'session/new');
    sim.respond(newReq.id, { sessionId: 'sess-2' });
    const promptReq = await waitForRequest(sim, 'session/prompt');

    sim.sessionUpdate('sess-2', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hello ' },
    });
    sim.sessionUpdate('sess-2', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'world!' },
    });
    await new Promise((r) => setTimeout(r, 30));
    sim.respond(promptReq.id, { stopReason: 'end_turn' });

    const result = await resultPromise;
    expect(result).toBe('Hello world!');
  });

  test('forwards mcpServers in session/new params', async () => {
    let resultPromise!: Promise<string>;
    let sim!: ReturnType<typeof createKiroSimulator>;
    const servers = [{ name: 'memory', command: 'node', args: ['memory.js'], env: {} }];

    jest.isolateModules(() => {
      sim = createKiroSimulator();
      jest.mock('child_process', () => ({
        spawn: () => sim.proc,
        execFile: () => {},
      }));
      const { KiroAdapter: IsolatedAdapter } = require('../src/services/backends/kiro');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('p', { workingDir: '/tmp', mcpServers: servers });
    });

    const initReq = await waitForRequest(sim, 'initialize');
    sim.respond(initReq.id, {});
    const newReq = await waitForRequest(sim, 'session/new');
    expect((newReq.params as { mcpServers: unknown }).mcpServers).toEqual(servers);
    sim.respond(newReq.id, { sessionId: 'sess-3' });
    const promptReq = await waitForRequest(sim, 'session/prompt');
    sim.sessionUpdate('sess-3', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
    await new Promise((r) => setTimeout(r, 20));
    sim.respond(promptReq.id, { stopReason: 'end_turn' });

    await resultPromise;
  });

  test('issues session/set_model when model option is provided', async () => {
    let resultPromise!: Promise<string>;
    let sim!: ReturnType<typeof createKiroSimulator>;

    jest.isolateModules(() => {
      sim = createKiroSimulator();
      jest.mock('child_process', () => ({
        spawn: () => sim.proc,
        execFile: () => {},
      }));
      const { KiroAdapter: IsolatedAdapter } = require('../src/services/backends/kiro');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('p', { workingDir: '/tmp', model: 'claude-opus-4.7' });
    });

    const initReq = await waitForRequest(sim, 'initialize');
    sim.respond(initReq.id, {});
    const newReq = await waitForRequest(sim, 'session/new');
    sim.respond(newReq.id, { sessionId: 'sess-4' });
    const setModelReq = await waitForRequest(sim, 'session/set_model');
    expect((setModelReq.params as { modelId: string }).modelId).toBe('claude-opus-4.7');
    sim.respond(setModelReq.id, {});
    const promptReq = await waitForRequest(sim, 'session/prompt');
    sim.sessionUpdate('sess-4', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
    await new Promise((r) => setTimeout(r, 20));
    sim.respond(promptReq.id, { stopReason: 'end_turn' });

    await resultPromise;
  });

  test('auto-approves session/request_permission notifications', async () => {
    let resultPromise!: Promise<string>;
    let sim!: ReturnType<typeof createKiroSimulator>;

    jest.isolateModules(() => {
      sim = createKiroSimulator();
      jest.mock('child_process', () => ({
        spawn: () => sim.proc,
        execFile: () => {},
      }));
      const { KiroAdapter: IsolatedAdapter } = require('../src/services/backends/kiro');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('p', { workingDir: '/tmp' });
    });

    const initReq = await waitForRequest(sim, 'initialize');
    sim.respond(initReq.id, {});
    const newReq = await waitForRequest(sim, 'session/new');
    sim.respond(newReq.id, { sessionId: 'sess-5' });
    const promptReq = await waitForRequest(sim, 'session/prompt');

    // Simulate Kiro asking for permission (server-to-client request: method + id)
    sim.notify('session/request_permission', { sessionId: 'sess-5', toolCall: { kind: 'shell' } }, 9999);
    await new Promise((r) => setTimeout(r, 30));

    // Adapter must auto-respond on stdin with allow_always
    const response = sim.findResponseTo(9999);
    expect(response).toBeDefined();
    expect((response!.result as { outcome: { outcome: string; optionId: string } }).outcome).toEqual({
      outcome: 'selected',
      optionId: 'allow_always',
    });

    sim.sessionUpdate('sess-5', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
    await new Promise((r) => setTimeout(r, 20));
    sim.respond(promptReq.id, { stopReason: 'end_turn' });

    await expect(resultPromise).resolves.toBe('done');
  });

  test('rejects with friendly error on spawn ENOENT', async () => {
    let resultPromise!: Promise<string>;
    let proc: any;

    jest.isolateModules(() => {
      const { EventEmitter } = require('events');
      proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: () => true, destroyed: false };
      proc.kill = () => {};
      proc.killed = false;
      jest.mock('child_process', () => ({
        spawn: () => proc,
        execFile: () => {},
      }));
      const { KiroAdapter: IsolatedAdapter } = require('../src/services/backends/kiro');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('p', { workingDir: '/tmp' });
    });

    setImmediate(() => proc.emit('error', new Error('spawn kiro-cli ENOENT')));

    await expect(resultPromise).rejects.toThrow('Kiro CLI is not installed');
  });

  test('rejects on timeoutMs', async () => {
    let resultPromise!: Promise<string>;
    let sim!: ReturnType<typeof createKiroSimulator>;

    jest.isolateModules(() => {
      sim = createKiroSimulator();
      jest.mock('child_process', () => ({
        spawn: () => sim.proc,
        execFile: () => {},
      }));
      const { KiroAdapter: IsolatedAdapter } = require('../src/services/backends/kiro');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('p', { workingDir: '/tmp', timeoutMs: 100 });
    });

    // Don't respond to anything — let the timeout fire
    await expect(resultPromise).rejects.toThrow(/timed out after 100ms/);
  });
});

// ── collectImageContentBlocks ──────────────────────────────────────────────
//
// Kiro's `fs_read` Image-mode would otherwise base64-inline image bytes into
// the prompt transcript and overflow the upstream model's prompt budget.
// The adapter sidesteps that by attaching matching images as proper ACP
// `{type:"image"}` content blocks. These tests cover the helper directly
// (filesystem branches) and the end-to-end attach into `session/prompt`.

describe('collectImageContentBlocks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-img-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('returns empty when workingDir is undefined', async () => {
    const blocks = await collectImageContentBlocks('Read foo.png', undefined);
    expect(blocks).toEqual([]);
  });

  test('returns empty when workingDir does not exist', async () => {
    const blocks = await collectImageContentBlocks('Read foo.png', path.join(tmpDir, 'missing'));
    expect(blocks).toEqual([]);
  });

  test('returns empty when no image basename appears in the prompt', async () => {
    fs.writeFileSync(path.join(tmpDir, 'unrelated.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const blocks = await collectImageContentBlocks('do something', tmpDir);
    expect(blocks).toEqual([]);
  });

  test('attaches matching image as base64-encoded content block', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(path.join(tmpDir, 'foo.png'), bytes);
    const blocks = await collectImageContentBlocks('Read the image file `foo.png`', tmpDir);
    expect(blocks).toEqual([
      { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
    ]);
  });

  test('maps extensions to the right MIME type', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.jpg'), Buffer.from([0xff, 0xd8]));
    fs.writeFileSync(path.join(tmpDir, 'b.JPEG'), Buffer.from([0xff, 0xd8]));
    fs.writeFileSync(path.join(tmpDir, 'c.gif'), Buffer.from([0x47, 0x49, 0x46]));
    fs.writeFileSync(path.join(tmpDir, 'd.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46]));
    const blocks = await collectImageContentBlocks('a.jpg b.JPEG c.gif d.webp', tmpDir);
    const mimes = blocks.map((b) => b.mimeType).sort();
    expect(mimes).toEqual(['image/gif', 'image/jpeg', 'image/jpeg', 'image/webp']);
  });

  test('ignores unsupported extensions', async () => {
    fs.writeFileSync(path.join(tmpDir, 'doc.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46]));
    fs.writeFileSync(path.join(tmpDir, 'note.txt'), 'hello');
    const blocks = await collectImageContentBlocks('doc.pdf note.txt', tmpDir);
    expect(blocks).toEqual([]);
  });

  test('caps total attachments at 5', async () => {
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(path.join(tmpDir, `img${i}.png`), Buffer.from([0x89, 0x50]));
    }
    const prompt = Array.from({ length: 8 }, (_, i) => `img${i}.png`).join(' ');
    const blocks = await collectImageContentBlocks(prompt, tmpDir);
    expect(blocks).toHaveLength(5);
  });
});

describe('KiroAdapter.runOneShot image attachment', () => {
  function createKiroSimulator() {
    const { EventEmitter } = require('events');
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();

    const stdinWrites: string[] = [];
    const requestLog: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
    let lineBuf = '';

    const sim: any = {
      proc,
      requestLog,
      respond: (id: number, result: unknown) => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'));
      },
      notify: (method: string, params: unknown, id?: number) => {
        const msg: Record<string, unknown> = { jsonrpc: '2.0', method, params };
        if (id != null) msg.id = id;
        proc.stdout.emit('data', Buffer.from(JSON.stringify(msg) + '\n'));
      },
      sessionUpdate: (sessionId: string, update: Record<string, unknown>) => {
        sim.notify('session/update', { sessionId, update });
      },
      findRequest: (method: string) => requestLog.find((r) => r.method === method),
    };

    proc.stdin = {
      write: (s: string) => {
        stdinWrites.push(s);
        lineBuf += s;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.method && msg.id != null) requestLog.push(msg);
          } catch { /* ignore */ }
        }
        return true;
      },
      destroyed: false,
    };
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = () => {
      if (!proc.killed) {
        proc.killed = true;
        proc.exitCode = 0;
        setImmediate(() => proc.emit('close', 0, 'SIGTERM'));
      }
    };
    return sim;
  }

  async function waitForRequest(sim: any, method: string, timeoutMs = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const req = sim.findRequest(method);
      if (req) return req;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`Timed out waiting for ${method} request`);
  }

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-img-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('appends image content block to session/prompt when workingDir contains a referenced image', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xde, 0xad, 0xbe, 0xef]);
    fs.writeFileSync(path.join(tmpDir, 'page1.png'), bytes);

    let resultPromise!: Promise<string>;
    let sim!: ReturnType<typeof createKiroSimulator>;
    const workingDir = tmpDir;

    jest.isolateModules(() => {
      sim = createKiroSimulator();
      jest.mock('child_process', () => ({
        spawn: () => sim.proc,
        execFile: () => {},
      }));
      const { KiroAdapter: IsolatedAdapter } = require('../src/services/backends/kiro');
      const adapter = new IsolatedAdapter({ workingDir });
      resultPromise = adapter.runOneShot('Read the image file `page1.png` and convert.', { workingDir });
    });

    const initReq = await waitForRequest(sim, 'initialize');
    sim.respond(initReq.id, {});
    const newReq = await waitForRequest(sim, 'session/new');
    sim.respond(newReq.id, { sessionId: 'sess-img-1' });
    const promptReq = await waitForRequest(sim, 'session/prompt');

    const promptArr = (promptReq.params as { prompt: Array<Record<string, unknown>> }).prompt;
    expect(promptArr).toHaveLength(2);
    expect(promptArr[0]).toEqual({ type: 'text', text: 'Read the image file `page1.png` and convert.' });
    expect(promptArr[1]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: bytes.toString('base64'),
    });

    sim.sessionUpdate('sess-img-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
    await new Promise((r) => setTimeout(r, 20));
    sim.respond(promptReq.id, { stopReason: 'end_turn' });

    await expect(resultPromise).resolves.toBe('ok');
  });

  test('sends only the text block when no images match', async () => {
    fs.writeFileSync(path.join(tmpDir, 'other.png'), Buffer.from([0x89, 0x50]));

    let resultPromise!: Promise<string>;
    let sim!: ReturnType<typeof createKiroSimulator>;
    const workingDir = tmpDir;

    jest.isolateModules(() => {
      sim = createKiroSimulator();
      jest.mock('child_process', () => ({
        spawn: () => sim.proc,
        execFile: () => {},
      }));
      const { KiroAdapter: IsolatedAdapter } = require('../src/services/backends/kiro');
      const adapter = new IsolatedAdapter({ workingDir });
      resultPromise = adapter.runOneShot('plain text prompt', { workingDir });
    });

    const initReq = await waitForRequest(sim, 'initialize');
    sim.respond(initReq.id, {});
    const newReq = await waitForRequest(sim, 'session/new');
    sim.respond(newReq.id, { sessionId: 'sess-img-2' });
    const promptReq = await waitForRequest(sim, 'session/prompt');

    const promptArr = (promptReq.params as { prompt: Array<Record<string, unknown>> }).prompt;
    expect(promptArr).toHaveLength(1);
    expect(promptArr[0]).toEqual({ type: 'text', text: 'plain text prompt' });

    sim.sessionUpdate('sess-img-2', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
    await new Promise((r) => setTimeout(r, 20));
    sim.respond(promptReq.id, { stopReason: 'end_turn' });

    await resultPromise;
  });
});
