import { BaseBackendAdapter } from '../src/services/backends/base';
import { BackendRegistry } from '../src/services/backends/registry';
import { ClaudeCodeAdapter } from '../src/services/backends/claudeCode';
import type { BackendMetadata, SendMessageResult } from '../src/types';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ── BaseBackendAdapter ─────────────────────────────────────────────────────

describe('BaseBackendAdapter', () => {
  test('metadata throws on base class', () => {
    const adapter = new BaseBackendAdapter();
    expect(() => adapter.metadata).toThrow('must be implemented');
  });

  test('sendMessage throws on base class', () => {
    const adapter = new BaseBackendAdapter();
    expect(() => adapter.sendMessage('hi')).toThrow('must be implemented');
  });

  test('generateSummary throws on base class', async () => {
    const adapter = new BaseBackendAdapter();
    await expect(adapter.generateSummary([], 'fallback')).rejects.toThrow('must be implemented');
  });

  test('generateTitle returns fallback by default', async () => {
    const adapter = new BaseBackendAdapter();
    const title = await adapter.generateTitle('Hello world', 'My Fallback');
    expect(title).toBe('My Fallback');
  });

  test('generateTitle truncates user message when no fallback', async () => {
    const adapter = new BaseBackendAdapter();
    const longMsg = 'A'.repeat(100);
    const title = await adapter.generateTitle(longMsg, '');
    expect(title).toBe('A'.repeat(80));
  });

  test('generateTitle returns New Chat for empty message', async () => {
    const adapter = new BaseBackendAdapter();
    const title = await adapter.generateTitle('', null as any);
    expect(title).toBe('New Chat');
  });

  test('stores workingDir from options', () => {
    const adapter = new BaseBackendAdapter({ workingDir: '/tmp/test' });
    expect(adapter.workingDir).toBe('/tmp/test');
  });
});

// ── BackendRegistry ────────────────────────────────────────────────────────

describe('BackendRegistry', () => {
  let registry: BackendRegistry;

  beforeEach(() => {
    registry = new BackendRegistry();
  });

  test('register and get adapter', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    registry.register(adapter);
    expect(registry.get('claude-code')).toBe(adapter);
  });

  test('get returns null for unknown id', () => {
    expect(registry.get('nonexistent')).toBeNull();
  });

  test('list returns metadata array', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    registry.register(adapter);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('claude-code');
    expect(list[0].label).toBe('Claude Code');
    expect(list[0].capabilities.thinking).toBe(true);
    expect(list[0].icon).toContain('<svg');
  });

  test('getDefault returns first registered adapter', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    registry.register(adapter);
    expect(registry.getDefault()).toBe(adapter);
  });

  test('getDefault returns null when empty', () => {
    expect(registry.getDefault()).toBeNull();
  });

  test('register rejects non-BaseBackendAdapter', () => {
    expect(() => registry.register({} as any)).toThrow('must extend BaseBackendAdapter');
  });

  test('register multiple adapters', () => {
    class FakeAdapter extends BaseBackendAdapter {
      get metadata(): BackendMetadata {
        return { id: 'fake', label: 'Fake', icon: null, capabilities: {} as any };
      }
      sendMessage(): SendMessageResult { return { stream: (async function*() {})(), abort: () => {}, sendInput: () => {} }; }
      async generateSummary(_msgs: any[], fb: string) { return fb; }
    }

    const claude = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    const fake = new FakeAdapter();
    registry.register(claude);
    registry.register(fake);

    expect(registry.list()).toHaveLength(2);
    expect(registry.get('claude-code')).toBe(claude);
    expect(registry.get('fake')).toBe(fake);
    expect(registry.getDefault()).toBe(claude);
  });
});

// ── ClaudeCodeAdapter metadata ──────────────────────────────────────────────

describe('ClaudeCodeAdapter', () => {
  test('metadata has correct shape', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    const meta = adapter.metadata;
    expect(meta.id).toBe('claude-code');
    expect(meta.label).toBe('Claude Code');
    expect(meta.icon).toContain('<svg');
    expect(meta.capabilities).toEqual({
      thinking: true,
      planMode: true,
      agents: true,
      toolActivity: true,
      userQuestions: true,
      stdinInput: true,
    });
  });

  test('metadata includes models array', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    const meta = adapter.metadata;
    expect(meta.models).toBeDefined();
    expect(Array.isArray(meta.models)).toBe(true);
    expect(meta.models!.length).toBeGreaterThanOrEqual(3);

    const opus = meta.models!.find(m => m.id === 'opus');
    expect(opus).toBeDefined();
    expect(opus!.label).toBe('Opus 4.6');
    expect(opus!.family).toBe('opus');
    expect(opus!.costTier).toBe('high');

    const sonnet = meta.models!.find(m => m.id === 'sonnet');
    expect(sonnet).toBeDefined();
    expect(sonnet!.default).toBe(true);
    expect(sonnet!.costTier).toBe('medium');

    const haiku = meta.models!.find(m => m.id === 'haiku');
    expect(haiku).toBeDefined();
    expect(haiku!.costTier).toBe('low');
  });

  test('uses default working directory', () => {
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.workingDir).toContain('.openclaw');
  });

  test('accepts custom working directory', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp/test' });
    expect(adapter.workingDir).toBe('/tmp/test');
  });
});

// ── ClaudeCodeAdapter sendMessage ──────────────────────────────────────────

describe('ClaudeCodeAdapter sendMessage', () => {
  test('returns stream, abort, and sendInput', async () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
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

    abort();
    for await (const event of stream) {
      if (event.type === 'done') break;
    }
    await sleep(500);
  }, 10000);

  test('passes --model flag when model option is set', async () => {
    let capturedArgs: string[] | undefined;
    let streamRef: AsyncGenerator<any>;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: (_cmd: string, args: string[]) => {
          capturedArgs = args;
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          setTimeout(() => proc.emit('close', 0, null), 10);
          return proc;
        },
        execFile: () => {},
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-model',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
        model: 'opus',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    const idx = capturedArgs!.indexOf('--model');
    expect(idx).toBeGreaterThan(-1);
    expect(capturedArgs![idx + 1]).toBe('opus');
  });

  test('omits --model flag when model option is not set', async () => {
    let capturedArgs: string[] | undefined;
    let streamRef: AsyncGenerator<any>;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: (_cmd: string, args: string[]) => {
          capturedArgs = args;
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          setTimeout(() => proc.emit('close', 0, null), 10);
          return proc;
        },
        execFile: () => {},
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-no-model',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).not.toContain('--model');
  });

  test('includes --append-system-prompt for new sessions with systemPrompt', async () => {
    let capturedArgs: string[] | undefined;
    let streamRef: AsyncGenerator<any>;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: (_cmd: string, args: string[]) => {
          capturedArgs = args;
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          setTimeout(() => proc.emit('close', 0, null), 10);
          return proc;
        },
        execFile: () => {},
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-sys-prompt',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: 'You are a helpful assistant',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    const idx = capturedArgs!.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(capturedArgs![idx + 1]).toBe('You are a helpful assistant');
  });

  test('sanitizes system prompt with control characters', async () => {
    let capturedArgs: string[] | undefined;
    let streamRef: AsyncGenerator<any>;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: (_cmd: string, args: string[]) => {
          capturedArgs = args;
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          setTimeout(() => proc.emit('close', 0, null), 10);
          return proc;
        },
        execFile: () => {},
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-sanitize',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: 'Be helpful\x00\x07 and safe',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    const idx = capturedArgs!.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(capturedArgs![idx + 1]).toBe('Be helpful and safe');
  });

  test('omits --append-system-prompt when systemPrompt is only control chars', async () => {
    let capturedArgs: string[] | undefined;
    let streamRef: AsyncGenerator<any>;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: (_cmd: string, args: string[]) => {
          capturedArgs = args;
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          setTimeout(() => proc.emit('close', 0, null), 10);
          return proc;
        },
        execFile: () => {},
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-ctrl-only',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '\x00\x01\x02',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).not.toContain('--append-system-prompt');
  });

  test('omits --append-system-prompt when systemPrompt is empty', async () => {
    let capturedArgs: string[] | undefined;
    let streamRef: AsyncGenerator<any>;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: (_cmd: string, args: string[]) => {
          capturedArgs = args;
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          setTimeout(() => proc.emit('close', 0, null), 10);
          return proc;
        },
        execFile: () => {},
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-no-prompt',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).not.toContain('--append-system-prompt');
  });

  test('omits --append-system-prompt on resumed sessions', async () => {
    let capturedArgs: string[] | undefined;
    let streamRef: AsyncGenerator<any>;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: (_cmd: string, args: string[]) => {
          capturedArgs = args;
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          setTimeout(() => proc.emit('close', 0, null), 10);
          return proc;
        },
        execFile: () => {},
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-resume',
        isNewSession: false,
        workingDir: '/tmp',
        systemPrompt: 'You are a helpful assistant',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).not.toContain('--append-system-prompt');
    expect(capturedArgs).toContain('--resume');
  });

  test('abort yields error and done events', async () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    const { stream, abort } = adapter.sendMessage('hello', {
      sessionId: 'test-abort',
      isNewSession: true,
      workingDir: '/tmp',
      systemPrompt: '',
    });

    abort();

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events.some(e => e.type === 'error')).toBe(true);
    expect(events[events.length - 1].type).toBe('done');
    await sleep(500);
  }, 10000);

  test('sendInput does not throw when process is not started', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    const { sendInput, abort } = adapter.sendMessage('hello', {
      sessionId: 'test-input-safe',
      isNewSession: true,
      workingDir: '/tmp',
      systemPrompt: '',
    });

    abort();
    expect(() => sendInput('some text')).not.toThrow();
  });
});
