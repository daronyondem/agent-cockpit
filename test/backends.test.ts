import fs from 'fs';
import path from 'path';
import os from 'os';
import { BaseBackendAdapter } from '../src/services/backends/base';
import { BackendRegistry } from '../src/services/backends/registry';
import {
  ClaudeCodeAdapter,
  parseFrontmatter,
  resolveClaudeMemoryDir,
  resolveCanonicalWorkspacePath,
} from '../src/services/backends/claudeCode';
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

  test('metadata declares supportedEffortLevels per model', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    const meta = adapter.metadata;

    // Opus 4.6 supports all four levels including max
    const opus = meta.models!.find(m => m.id === 'opus');
    expect(opus!.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'max']);

    // Sonnet 4.6 supports low/medium/high (no max)
    const sonnet = meta.models!.find(m => m.id === 'sonnet');
    expect(sonnet!.supportedEffortLevels).toEqual(['low', 'medium', 'high']);

    // Haiku does not support effort at all
    const haiku = meta.models!.find(m => m.id === 'haiku');
    expect(haiku!.supportedEffortLevels).toBeUndefined();

    // 1M context variants inherit their base family's effort support
    const opus1m = meta.models!.find(m => m.id === 'opus[1m]');
    expect(opus1m!.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'max']);
    const sonnet1m = meta.models!.find(m => m.id === 'sonnet[1m]');
    expect(sonnet1m!.supportedEffortLevels).toEqual(['low', 'medium', 'high']);
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

  test('passes --effort flag when effort is supported by the selected model', async () => {
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
        sessionId: 'test-effort-high',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
        model: 'sonnet',
        effort: 'high',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    const idx = capturedArgs!.indexOf('--effort');
    expect(idx).toBeGreaterThan(-1);
    expect(capturedArgs![idx + 1]).toBe('high');
  });

  test('passes --effort max only when supported (Opus)', async () => {
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
        sessionId: 'test-effort-max',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
        model: 'opus',
        effort: 'max',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    const idx = capturedArgs!.indexOf('--effort');
    expect(capturedArgs![idx + 1]).toBe('max');
  });

  test('drops --effort when the selected model does not support that level', async () => {
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
      // Sonnet does not support 'max' — adapter must not forward the flag.
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-effort-unsupported',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
        model: 'sonnet',
        effort: 'max',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).not.toContain('--effort');
  });

  test('drops --effort for Haiku (no effort support)', async () => {
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
        sessionId: 'test-effort-haiku',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
        model: 'haiku',
        effort: 'high',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).not.toContain('--effort');
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

// ── Claude Code Memory ─────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  test('extracts name, description, type from valid frontmatter', () => {
    const content = `---
name: testing-preferences
description: Use integration tests instead of mocks
type: feedback
---

Body content here.`;
    const parsed = parseFrontmatter(content);
    expect(parsed.name).toBe('testing-preferences');
    expect(parsed.description).toBe('Use integration tests instead of mocks');
    expect(parsed.type).toBe('feedback');
  });

  test('normalizes unknown type to "unknown"', () => {
    const content = `---
name: weird
description: something
type: pancakes
---
body`;
    const parsed = parseFrontmatter(content);
    expect(parsed.type).toBe('unknown');
  });

  test('strips surrounding quotes from values', () => {
    const content = `---
name: "quoted name"
description: 'single-quoted'
type: user
---
body`;
    const parsed = parseFrontmatter(content);
    expect(parsed.name).toBe('quoted name');
    expect(parsed.description).toBe('single-quoted');
  });

  test('returns nulls + unknown when no frontmatter', () => {
    const parsed = parseFrontmatter('Just a plain markdown file.');
    expect(parsed.name).toBeNull();
    expect(parsed.description).toBeNull();
    expect(parsed.type).toBe('unknown');
  });

  test('returns nulls when opening --- has no closing ---', () => {
    const content = `---
name: unterminated
description: nothing closes this`;
    const parsed = parseFrontmatter(content);
    expect(parsed.name).toBeNull();
    expect(parsed.type).toBe('unknown');
  });
});

describe('resolveClaudeMemoryDir', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function mkMemoryDir(dirName: string, files: Record<string, string>): string {
    const full = path.join(tmpHome, '.claude', 'projects', dirName, 'memory');
    fs.mkdirSync(full, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(full, name), content, 'utf8');
    }
    return full;
  }

  test('resolves sanitized path exactly', () => {
    const workspace = '/tmp/my-project';
    const sanitized = '-tmp-my-project';
    const expected = mkMemoryDir(sanitized, { 'MEMORY.md': '- [x] test\n' });
    const resolved = resolveClaudeMemoryDir(workspace);
    expect(resolved).toBe(expected);
  });

  test('returns null when no .md files exist', () => {
    const workspace = '/tmp/empty-ws';
    const sanitized = '-tmp-empty-ws';
    fs.mkdirSync(path.join(tmpHome, '.claude', 'projects', sanitized, 'memory'), { recursive: true });
    expect(resolveClaudeMemoryDir(workspace)).toBeNull();
  });

  test('returns null when projects dir does not exist', () => {
    expect(resolveClaudeMemoryDir('/tmp/never-seen')).toBeNull();
  });

  test('falls back to prefix match for hashed directories', () => {
    const workspace = '/tmp/' + 'a'.repeat(250);
    const sanitized = '-tmp-' + 'a'.repeat(250);
    // Simulate Claude Code's truncation + hash suffix.
    const hashed = sanitized.slice(0, 200) + '-abcdef';
    const expected = mkMemoryDir(hashed, { 'feedback_x.md': '---\ntype: feedback\n---\nbody\n' });
    const resolved = resolveClaudeMemoryDir(workspace);
    expect(resolved).toBe(expected);
  });
});

describe('resolveCanonicalWorkspacePath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns workspacePath unchanged for non-git workspace', () => {
    const workspace = path.join(tmpDir, 'plain-ws');
    fs.mkdirSync(workspace, { recursive: true });
    expect(resolveCanonicalWorkspacePath(workspace)).toBe(workspace);
  });

  test('returns workspacePath unchanged for main repo (.git is a directory)', () => {
    const workspace = path.join(tmpDir, 'main-repo');
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    expect(resolveCanonicalWorkspacePath(workspace)).toBe(workspace);
  });

  test('resolves worktree with relative commondir to main repo', () => {
    // Layout:
    //   tmpDir/main/.git/                        ← main repo .git dir
    //   tmpDir/main/.git/worktrees/feature/      ← worktree metadata
    //   tmpDir/feature/.git                      ← file containing "gitdir: ..."
    const main = path.join(tmpDir, 'main');
    const mainGit = path.join(main, '.git');
    const worktreeMeta = path.join(mainGit, 'worktrees', 'feature');
    const worktree = path.join(tmpDir, 'feature');

    fs.mkdirSync(worktreeMeta, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeMeta}\n`, 'utf8');
    // commondir is typically "../.." (relative to worktreeMeta) → points at mainGit
    fs.writeFileSync(path.join(worktreeMeta, 'commondir'), '../..\n', 'utf8');

    expect(resolveCanonicalWorkspacePath(worktree)).toBe(main);
  });

  test('resolves worktree with absolute commondir to main repo', () => {
    const main = path.join(tmpDir, 'main-abs');
    const mainGit = path.join(main, '.git');
    const worktreeMeta = path.join(mainGit, 'worktrees', 'feature');
    const worktree = path.join(tmpDir, 'feature-abs');

    fs.mkdirSync(worktreeMeta, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeMeta}\n`, 'utf8');
    fs.writeFileSync(path.join(worktreeMeta, 'commondir'), mainGit + '\n', 'utf8');

    expect(resolveCanonicalWorkspacePath(worktree)).toBe(main);
  });

  test('resolves worktree when .git file uses relative gitdir', () => {
    const main = path.join(tmpDir, 'main-relgit');
    const mainGit = path.join(main, '.git');
    const worktreeMeta = path.join(mainGit, 'worktrees', 'feature');
    const worktree = path.join(tmpDir, 'feature-relgit');

    fs.mkdirSync(worktreeMeta, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    // relative gitdir from the worktree
    const relGitdir = path.relative(worktree, worktreeMeta);
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${relGitdir}\n`, 'utf8');
    fs.writeFileSync(path.join(worktreeMeta, 'commondir'), '../..\n', 'utf8');

    expect(resolveCanonicalWorkspacePath(worktree)).toBe(main);
  });

  test('returns workspacePath unchanged when .git file is malformed', () => {
    const worktree = path.join(tmpDir, 'bad-git-file');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), 'this is not a valid gitdir pointer\n', 'utf8');
    expect(resolveCanonicalWorkspacePath(worktree)).toBe(worktree);
  });

  test('returns workspacePath unchanged when commondir file is missing', () => {
    const worktree = path.join(tmpDir, 'no-commondir');
    const worktreeMeta = path.join(tmpDir, 'meta-no-commondir');
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(worktreeMeta, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeMeta}\n`, 'utf8');
    // no commondir file written
    expect(resolveCanonicalWorkspacePath(worktree)).toBe(worktree);
  });

  test('returns workspacePath unchanged when resolved main repo has no .git dir', () => {
    const fakeMain = path.join(tmpDir, 'fake-main');
    const worktreeMeta = path.join(fakeMain, '.git', 'worktrees', 'feature');
    const worktree = path.join(tmpDir, 'orphan-worktree');

    fs.mkdirSync(worktreeMeta, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    // mainGit directory exists as a regular dir because we just built the
    // worktrees/feature path, but let's delete it to simulate a dangling pointer.
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeMeta}\n`, 'utf8');
    fs.writeFileSync(path.join(worktreeMeta, 'commondir'), '../..\n', 'utf8');
    // Remove the entire main .git dir so dirname(mainGitDir) has no .git anymore.
    fs.rmSync(path.join(fakeMain, '.git'), { recursive: true, force: true });

    expect(resolveCanonicalWorkspacePath(worktree)).toBe(worktree);
  });

  test('returns empty string unchanged', () => {
    expect(resolveCanonicalWorkspacePath('')).toBe('');
  });
});

describe('ClaudeCodeAdapter.extractMemory', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function mkMemory(workspace: string, files: Record<string, string>): void {
    const sanitized = workspace.replace(/[^a-zA-Z0-9]/g, '-');
    const full = path.join(tmpHome, '.claude', 'projects', sanitized, 'memory');
    fs.mkdirSync(full, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(full, name), content, 'utf8');
    }
  }

  test('returns null when no memory directory exists', async () => {
    const snapshot = await adapter.extractMemory('/tmp/no-memory-here');
    expect(snapshot).toBeNull();
  });

  test('returns null when workspacePath is empty', async () => {
    const snapshot = await adapter.extractMemory('');
    expect(snapshot).toBeNull();
  });

  test('captures MEMORY.md and per-topic files with parsed frontmatter', async () => {
    mkMemory('/tmp/memtest', {
      'MEMORY.md': '- [Testing](feedback_testing.md) — use real DB\n',
      'feedback_testing.md': `---
name: testing-preferences
description: use real DB not mocks
type: feedback
---

Integration tests must use real DB.
`,
      'user_role.md': `---
name: user-role
description: senior backend engineer
type: user
---

Backend engineer with deep Go experience.
`,
    });

    const snapshot = await adapter.extractMemory('/tmp/memtest');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.sourceBackend).toBe('claude-code');
    expect(snapshot!.index).toContain('Testing');
    expect(snapshot!.files).toHaveLength(2);

    const byName = Object.fromEntries(snapshot!.files.map(f => [f.filename, f]));
    expect(byName['feedback_testing.md'].type).toBe('feedback');
    expect(byName['feedback_testing.md'].description).toBe('use real DB not mocks');
    expect(byName['user_role.md'].type).toBe('user');
    expect(snapshot!.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('returns null when only non-md files are present', async () => {
    mkMemory('/tmp/non-md', { 'notes.txt': 'not markdown' });
    const snapshot = await adapter.extractMemory('/tmp/non-md');
    expect(snapshot).toBeNull();
  });

  test('captures MEMORY.md even with no topic files', async () => {
    mkMemory('/tmp/index-only', { 'MEMORY.md': '- nothing yet\n' });
    const snapshot = await adapter.extractMemory('/tmp/index-only');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.index).toBe('- nothing yet\n');
    expect(snapshot!.files).toHaveLength(0);
  });

  test('worktree workspaces read memory from the main repo', async () => {
    // Build a fake main repo + worktree inside the temp HOME (any dir works,
    // as long as they're real directories and resolveCanonicalWorkspacePath
    // can stat them).  The main repo's sanitized path is what Claude Code
    // stores memory under — the worktree path is NOT stored separately.
    const reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-worktree-'));
    try {
      const main = path.join(reposRoot, 'main');
      const mainGit = path.join(main, '.git');
      const worktreeMeta = path.join(mainGit, 'worktrees', 'feature');
      const worktree = path.join(reposRoot, 'feature');
      fs.mkdirSync(worktreeMeta, { recursive: true });
      fs.mkdirSync(worktree, { recursive: true });
      fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeMeta}\n`, 'utf8');
      fs.writeFileSync(path.join(worktreeMeta, 'commondir'), '../..\n', 'utf8');

      // Sanity-check the canonicalization before setting up memory.
      expect(resolveCanonicalWorkspacePath(worktree)).toBe(main);

      // Write memory at the MAIN repo's sanitized path.
      mkMemory(main, {
        'MEMORY.md': '- [Shared](user_shared.md) — shared across worktrees\n',
        'user_shared.md': `---
name: shared-role
description: should apply to all worktrees
type: user
---

Shared memory body.
`,
      });

      // Request extraction via the WORKTREE path — should resolve to main.
      const snapshot = await adapter.extractMemory(worktree);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.index).toContain('Shared');
      expect(snapshot!.files).toHaveLength(1);
      expect(snapshot!.files[0].filename).toBe('user_shared.md');
      expect(snapshot!.files[0].type).toBe('user');
      // sourcePath should be the main repo's memory dir, not the worktree's.
      const expectedDir = path.join(
        tmpHome, '.claude', 'projects',
        main.replace(/[^a-zA-Z0-9]/g, '-'),
        'memory',
      );
      expect(snapshot!.sourcePath).toBe(expectedDir);
    } finally {
      fs.rmSync(reposRoot, { recursive: true, force: true });
    }
  });
});
