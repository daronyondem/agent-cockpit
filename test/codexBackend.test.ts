import { BaseBackendAdapter } from '../src/services/backends/base';
import { BackendRegistry } from '../src/services/backends/registry';
import { CodexAdapter, extractCodexToolDetails } from '../src/services/backends/codex';

// ── CodexAdapter metadata ───────────────────────────────────────────────────

describe('CodexAdapter', () => {
  test('metadata has correct shape', () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    const meta = adapter.metadata;
    expect(meta.id).toBe('codex');
    expect(meta.label).toBe('Codex');
    expect(meta.icon).toContain('<svg');
    expect(meta.capabilities).toEqual({
      thinking: true,
      planMode: false,
      agents: false,
      toolActivity: true,
      userQuestions: false,
      stdinInput: true,
    });
  });

  test('metadata.models is populated immediately with fallback list', () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    const models = adapter.metadata.models;
    expect(models).toBeDefined();
    expect(models!.length).toBeGreaterThanOrEqual(3);
    // Exactly one default model
    expect(models!.filter((m) => m.default).length).toBe(1);
    // Fallback list includes the GPT family
    expect(models!.find((m) => m.id === 'gpt-5.5')).toBeDefined();
  });

  test('stdinInput is true (Codex accepts mid-turn user input via turn/steer)', () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    expect(adapter.metadata.capabilities.stdinInput).toBe(true);
  });

  test('uses default working directory under .codex', () => {
    const adapter = new CodexAdapter();
    expect(adapter.workingDir).toContain('.codex');
  });

  test('accepts custom working directory', () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp/test' });
    expect(adapter.workingDir).toBe('/tmp/test');
  });

  test('extends BaseBackendAdapter', () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    expect(adapter).toBeInstanceOf(BaseBackendAdapter);
  });

  test('can be registered in BackendRegistry', () => {
    const registry = new BackendRegistry();
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    registry.register(adapter);
    expect(registry.get('codex')).toBe(adapter);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].id).toBe('codex');
  });

  test('sendMessage returns stream, abort, and sendInput', () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
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

    // sendInput is a no-op when no active turn (no client/threadId/turnId yet
    // since we never let the spawn complete). Should not throw.
    expect(() => sendInput('some text')).not.toThrow();

    // Abort to prevent the stream from hanging on a real spawn
    abort();
  });
});

// ── Shutdown & Reset ────────────────────────────────────────────────────────

describe('CodexAdapter lifecycle', () => {
  test('shutdown does not throw when no processes', () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    expect(() => adapter.shutdown()).not.toThrow();
  });

  test('onSessionReset does not throw when no processes', () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    expect(() => adapter.onSessionReset('nonexistent-conv')).not.toThrow();
  });
});

// ── BackendRegistry with Codex ─────────────────────────────────────────────

describe('BackendRegistry with CodexAdapter', () => {
  test('registers alongside ClaudeCodeAdapter and KiroAdapter', () => {
    const { ClaudeCodeAdapter } = require('../src/services/backends/claudeCode');
    const { KiroAdapter } = require('../src/services/backends/kiro');
    const registry = new BackendRegistry();
    registry.register(new ClaudeCodeAdapter({ workingDir: '/tmp' }));
    registry.register(new KiroAdapter({ workingDir: '/tmp' }));
    registry.register(new CodexAdapter({ workingDir: '/tmp' }));

    expect(registry.list()).toHaveLength(3);
    expect(registry.get('claude-code')).toBeDefined();
    expect(registry.get('kiro')).toBeDefined();
    expect(registry.get('codex')).toBeDefined();
    expect(registry.getDefault()?.metadata.id).toBe('claude-code'); // First registered = default
  });

  test('shutdownAll calls shutdown on all adapters', () => {
    const registry = new BackendRegistry();
    const codex = new CodexAdapter({ workingDir: '/tmp' });
    const shutdownSpy = jest.spyOn(codex, 'shutdown');
    registry.register(codex);
    registry.shutdownAll();
    expect(shutdownSpy).toHaveBeenCalled();
  });
});

// ── extractCodexToolDetails ─────────────────────────────────────────────────
//
// Codex thread items are typed (not named like ACP `kind` strings), so we
// dispatch on `item.type` rather than tool name. Each branch here is a
// distinct item shape from the protocol.

describe('extractCodexToolDetails', () => {
  test('commandExecution maps to Bash with command preview', () => {
    const result = extractCodexToolDetails({
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'npm install',
    });
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('Bash');
    expect(result!.description).toContain('npm install');
    expect(result!.id).toBe('cmd-1');
  });

  test('commandExecution truncates long commands', () => {
    const longCmd = 'a'.repeat(100);
    const result = extractCodexToolDetails({
      type: 'commandExecution',
      id: 'cmd-2',
      command: longCmd,
    });
    expect(result!.description).toContain('...');
  });

  test('commandExecution without command falls back to generic label', () => {
    const result = extractCodexToolDetails({ type: 'commandExecution', id: 'cmd-3' });
    expect(result!.tool).toBe('Bash');
    expect(result!.description).toBe('Running command');
  });

  test('fileChange maps to Edit with first changed path', () => {
    const result = extractCodexToolDetails({
      type: 'fileChange',
      id: 'fc-1',
      changes: [{ path: '/repo/src/app.ts' }],
    });
    expect(result!.tool).toBe('Edit');
    expect(result!.description).toContain('app.ts');
  });

  test('fileChange without changes falls back to generic label', () => {
    const result = extractCodexToolDetails({ type: 'fileChange', id: 'fc-2' });
    expect(result!.tool).toBe('Edit');
    expect(result!.description).toBe('Editing files');
  });

  test('mcpToolCall preserves the underlying tool name', () => {
    const result = extractCodexToolDetails({
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'memory',
      tool: 'memory_note',
    });
    expect(result!.tool).toBe('memory_note');
    expect(result!.description).toBe('memory.memory_note');
  });

  test('dynamicToolCall preserves namespace.tool', () => {
    const result = extractCodexToolDetails({
      type: 'dynamicToolCall',
      id: 'dyn-1',
      namespace: 'plugin',
      tool: 'do_thing',
    });
    expect(result!.tool).toBe('do_thing');
    expect(result!.description).toBe('plugin.do_thing');
  });

  test('webSearch maps to WebSearch with query preview', () => {
    const result = extractCodexToolDetails({
      type: 'webSearch',
      id: 'ws-1',
      query: 'node streams',
    });
    expect(result!.tool).toBe('WebSearch');
    expect(result!.description).toContain('node streams');
  });

  test('imageView maps to Read', () => {
    const result = extractCodexToolDetails({
      type: 'imageView',
      id: 'iv-1',
      path: '/tmp/foo.png',
    });
    expect(result!.tool).toBe('Read');
    expect(result!.description).toContain('foo.png');
  });

  test('imageGeneration maps to ImageGen', () => {
    const result = extractCodexToolDetails({ type: 'imageGeneration', id: 'ig-1' });
    expect(result!.tool).toBe('ImageGen');
  });

  test('unknown item types return null', () => {
    const result = extractCodexToolDetails({ type: 'agentMessage', id: 'm-1' });
    expect(result).toBeNull();
  });
});

// ── generateSummary / generateTitle fallbacks ───────────────────────────────

describe('CodexAdapter generateSummary', () => {
  test('returns fallback for empty messages', async () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    const result = await adapter.generateSummary([], 'fallback text');
    expect(result).toBe('fallback text');
  });

  test('returns default fallback when messages empty and no fallback', async () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    const result = await adapter.generateSummary([], '');
    expect(result).toBe('Empty session');
  });
});

describe('CodexAdapter generateTitle', () => {
  test('returns fallback for empty message', async () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    const result = await adapter.generateTitle('', 'My Fallback');
    expect(result).toBe('My Fallback');
  });

  test('returns New Chat for empty message and no fallback', async () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    const result = await adapter.generateTitle('', '');
    expect(result).toBe('New Chat');
  });
});

// ── CodexAdapter.runOneShot (codex exec) ────────────────────────────────────
//
// runOneShot uses `codex exec` (a non-interactive subcommand) via `execFile`,
// not the JSON-RPC app-server. We mock execFile to capture the args/env and
// drive the callback synchronously.

describe('CodexAdapter.runOneShot', () => {
  test('returns trimmed stdout on success', async () => {
    let resultPromise!: Promise<string>;

    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          stdin: { write: () => true, end: () => {} },
          kill: () => {},
          killed: false,
          exitCode: null,
        }),
        execFile: (_cmd: string, _args: string[], _opts: object, cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
          setImmediate(() => cb(null, '  the answer is 42\n  ', ''));
          return { stdin: { end: () => {} } };
        },
      }));
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('what is the answer?', { workingDir: '/tmp' });
    });

    const result = await resultPromise;
    expect(result).toBe('the answer is 42');
  });

  test('rejects with friendly error on ENOENT', async () => {
    let resultPromise!: Promise<string>;

    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          stdin: { write: () => true, end: () => {} },
          kill: () => {},
          killed: false,
          exitCode: null,
        }),
        execFile: (_cmd: string, _args: string[], _opts: object, cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
          const err = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          setImmediate(() => cb(err, '', ''));
          return { stdin: { end: () => {} } };
        },
      }));
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('p', { workingDir: '/tmp' });
    });

    await expect(resultPromise).rejects.toThrow('Codex CLI is not installed');
  });

  test('forwards model option as -m argument to codex exec', async () => {
    let capturedArgs: string[] | null = null;
    let resultPromise!: Promise<string>;

    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          stdin: { write: () => true, end: () => {} },
          kill: () => {},
          killed: false,
          exitCode: null,
        }),
        execFile: (_cmd: string, args: string[], _opts: object, cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
          capturedArgs = args;
          setImmediate(() => cb(null, 'ok', ''));
          return { stdin: { end: () => {} } };
        },
      }));
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('p', { workingDir: '/tmp', model: 'gpt-5.5-codex' });
    });

    await resultPromise;
    expect(capturedArgs).not.toBeNull();
    const idx = capturedArgs!.indexOf('-m');
    expect(idx).toBeGreaterThan(-1);
    expect(capturedArgs![idx + 1]).toBe('gpt-5.5-codex');
  });

  test('passes mcpServers as -c flags when mcpServers are provided', async () => {
    let capturedArgs: string[] | null = null;
    let resultPromise!: Promise<string>;

    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          stdin: { write: () => true, end: () => {} },
          kill: () => {},
          killed: false,
          exitCode: null,
        }),
        execFile: (_cmd: string, args: string[], _opts: object, cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
          capturedArgs = args;
          setImmediate(() => cb(null, 'ok', ''));
          return { stdin: { end: () => {} } };
        },
      }));
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('p', {
        workingDir: '/tmp',
        mcpServers: [{ name: 'memory', command: 'node', args: ['/tmp/mem.js'], env: [{ name: 'TOKEN', value: 'abc' }] }],
      });
    });

    await resultPromise;
    expect(capturedArgs).not.toBeNull();
    // Three -c flags expected: command, args, env
    const cFlagIndices = capturedArgs!.reduce<number[]>((acc, v, i) => (v === '-c' ? [...acc, i] : acc), []);
    expect(cFlagIndices.length).toBe(3);
    const cValues = cFlagIndices.map((i) => capturedArgs![i + 1]);
    expect(cValues.some((v) => v === 'mcp_servers.memory.command="node"')).toBe(true);
    expect(cValues.some((v) => v === 'mcp_servers.memory.args=["/tmp/mem.js"]')).toBe(true);
    expect(cValues.some((v) => v.startsWith('mcp_servers.memory.env=') && v.includes('TOKEN = "abc"'))).toBe(true);
  });

  test('does not pass any -c flags when no mcpServers are provided', async () => {
    let capturedArgs: string[] | null = null;
    let resultPromise!: Promise<string>;

    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: () => ({
          on: () => {},
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          stdin: { write: () => true, end: () => {} },
          kill: () => {},
          killed: false,
          exitCode: null,
        }),
        execFile: (_cmd: string, args: string[], _opts: object, cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
          capturedArgs = args;
          setImmediate(() => cb(null, 'ok', ''));
          return { stdin: { end: () => {} } };
        },
      }));
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('p', { workingDir: '/tmp' });
    });

    await resultPromise;
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.includes('-c')).toBe(false);
  });
});
