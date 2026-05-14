import fs from 'fs';
import path from 'path';
import os from 'os';
import { BaseBackendAdapter } from '../src/services/backends/base';
import { BackendRegistry } from '../src/services/backends/registry';
import {
  ClaudeCodeAdapter,
  parseFrontmatter,
  parseClaudeGoalFromJsonl,
  resolveClaudeCliRuntime,
  resolveClaudeProjectDir,
  resolveClaudeProjectDirCandidates,
  resolveClaudeMemoryDir,
  resolveCanonicalWorkspacePath,
  mcpServersToClaudeConfigJson,
} from '../src/services/backends/claudeCode';
import type { BackendMetadata, SendMessageResult } from '../src/types';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const TEST_RESUME_CAPABILITIES: BackendMetadata['resumeCapabilities'] = {
  activeTurnResume: 'unsupported',
  activeTurnResumeReason: 'Test adapter does not support active turn reattach.',
  sessionResume: 'unsupported',
  sessionResumeReason: 'Test adapter does not model session resume.',
};

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

  test('getMemoryDir returns null by default', () => {
    const adapter = new BaseBackendAdapter();
    expect(adapter.getMemoryDir('/tmp/anywhere')).toBeNull();
  });

  test('extractMemory returns null by default', async () => {
    const adapter = new BaseBackendAdapter();
    await expect(adapter.extractMemory('/tmp/anywhere')).resolves.toBeNull();
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
    expect(list[0].resumeCapabilities).toMatchObject({
      activeTurnResume: 'unsupported',
      sessionResume: 'supported',
    });
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
        return { id: 'fake', label: 'Fake', icon: null, capabilities: {} as any, resumeCapabilities: TEST_RESUME_CAPABILITIES };
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
      goals: {
        set: true,
        clear: true,
        pause: false,
        resume: false,
        status: 'transcript',
      },
    });
  });

  test('metadata includes models array', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    const meta = adapter.metadata;
    expect(meta.models).toBeDefined();
    expect(Array.isArray(meta.models)).toBe(true);
    expect(meta.models!.length).toBe(4);

    const opus47 = meta.models!.find(m => m.id === 'claude-opus-4-7');
    expect(opus47).toBeDefined();
    expect(opus47!.label).toBe('Opus 4.7');
    expect(opus47!.family).toBe('opus');
    expect(opus47!.costTier).toBe('high');

    const opus46 = meta.models!.find(m => m.id === 'claude-opus-4-6');
    expect(opus46).toBeDefined();
    expect(opus46!.label).toBe('Opus 4.6');
    expect(opus46!.family).toBe('opus');
    expect(opus46!.costTier).toBe('high');

    const sonnet = meta.models!.find(m => m.id === 'claude-sonnet-4-6');
    expect(sonnet).toBeDefined();
    expect(sonnet!.default).toBe(true);
    expect(sonnet!.costTier).toBe('medium');

    const haiku = meta.models!.find(m => m.id === 'claude-haiku-4-5');
    expect(haiku).toBeDefined();
    expect(haiku!.costTier).toBe('low');
  });

  test('metadata declares supportedEffortLevels per model', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    const meta = adapter.metadata;

    // Opus 4.7 is the only model that supports the new xhigh level
    const opus47 = meta.models!.find(m => m.id === 'claude-opus-4-7');
    expect(opus47!.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);

    // Opus 4.6 supports low/medium/high/max (no xhigh)
    const opus46 = meta.models!.find(m => m.id === 'claude-opus-4-6');
    expect(opus46!.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'max']);

    // Sonnet 4.6 supports low/medium/high (no max, no xhigh)
    const sonnet = meta.models!.find(m => m.id === 'claude-sonnet-4-6');
    expect(sonnet!.supportedEffortLevels).toEqual(['low', 'medium', 'high']);

    // Haiku does not support effort at all
    const haiku = meta.models!.find(m => m.id === 'claude-haiku-4-5');
    expect(haiku!.supportedEffortLevels).toBeUndefined();

    // The deprecated [1m] aliases are no longer exposed
    expect(meta.models!.find(m => m.id === 'opus[1m]')).toBeUndefined();
    expect(meta.models!.find(m => m.id === 'sonnet[1m]')).toBeUndefined();
  });

  test('resolveClaudeCliRuntime maps profile configDir to CLAUDE_CONFIG_DIR and honors command/env', () => {
    const runtime = resolveClaudeCliRuntime({
      id: 'profile-claude-work',
      name: 'Claude Work',
      vendor: 'claude-code',
      command: '/opt/claude/bin/claude',
      authMode: 'account',
      configDir: '/tmp/claude-work-home',
      env: { ANTHROPIC_BASE_URL: 'https://example.test', CLAUDE_CONFIG_DIR: '/tmp/ignored' },
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    });

    expect(runtime.command).toBe('/opt/claude/bin/claude');
    expect(runtime.env.ANTHROPIC_BASE_URL).toBe('https://example.test');
    expect(runtime.env.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-work-home');
    expect(runtime.configDir).toBe('/tmp/claude-work-home');
    expect(runtime.profileKey).toContain('profile-claude-work:');
  });

  test('resolveClaudeCliRuntime rejects non-Claude profiles', () => {
    expect(() => resolveClaudeCliRuntime({
      id: 'profile-codex',
      name: 'Codex',
      vendor: 'codex',
      authMode: 'server-configured',
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    })).toThrow('CLI profile vendor codex is not claude-code');
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

describe('Claude Code goals', () => {
  test('parses active and complete goal_status attachments from transcript JSONL', () => {
    const jsonl = [
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-05-13T15:42:50.187Z',
        attachment: {
          type: 'goal_status',
          met: false,
          sentinel: true,
          condition: 'npm test exits 0',
        },
      }),
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-05-13T15:43:00.000Z',
        attachment: {
          type: 'goal_status',
          met: true,
          condition: 'npm test exits 0',
          reason: 'The transcript shows npm test exited 0.',
          iterations: 2,
          durationMs: 12000,
          tokens: 345,
        },
      }),
    ].join('\n');

    expect(parseClaudeGoalFromJsonl(jsonl, 'session-1')).toMatchObject({
      backend: 'claude-code',
      sessionId: 'session-1',
      objective: 'npm test exits 0',
      status: 'complete',
      supportedActions: { clear: true, stopTurn: true, pause: false, resume: false },
      turns: 2,
      iterations: 2,
      timeUsedSeconds: 12,
      tokensUsed: 345,
      lastReason: 'The transcript shows npm test exited 0.',
      source: 'transcript',
    });
  });

  test('returns null when a clear command appears after the latest goal status', () => {
    const jsonl = [
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-05-13T15:42:50.187Z',
        attachment: { type: 'goal_status', met: false, condition: 'finish the task' },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-05-13T15:43:00.000Z',
        message: { role: 'user', content: '<local-command-stdout>Goal cleared: finish the task</local-command-stdout>' },
      }),
    ].join('\n');

    expect(parseClaudeGoalFromJsonl(jsonl, 'session-1')).toBeNull();
  });

  test('resolves deterministic Claude project dir for short workspace paths', () => {
    const dir = resolveClaudeProjectDir('/tmp/goal-project');
    expect(dir).toBe(path.join(process.env.HOME || os.homedir(), '.claude', 'projects', '-tmp-goal-project'));
  });

  test('includes realpath Claude project dir candidates for symlinked workspaces', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-project-dir-'));
    try {
      const realWorkspace = path.join(tmp, 'real-workspace');
      const linkedWorkspace = path.join(tmp, 'linked-workspace');
      const configDir = path.join(tmp, 'claude-config');
      fs.mkdirSync(realWorkspace, { recursive: true });
      fs.symlinkSync(realWorkspace, linkedWorkspace, 'dir');

      const candidates = resolveClaudeProjectDirCandidates(linkedWorkspace, configDir);
      const resolvedWorkspace = fs.realpathSync(realWorkspace);

      expect(candidates).toContain(path.join(configDir, 'projects', linkedWorkspace.replace(/[^a-zA-Z0-9]/g, '-')));
      expect(candidates).toContain(path.join(configDir, 'projects', resolvedWorkspace.replace(/[^a-zA-Z0-9]/g, '-')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reads goal transcript from later long-path candidate when first candidate lacks session file', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-goal-config-'));
    const longWorkspace = path.join(
      os.tmpdir(),
      'workspace-' + 'a'.repeat(220),
    );
    const sanitized = longWorkspace.replace(/[^a-zA-Z0-9]/g, '-');
    const prefix = sanitized.slice(0, 200);
    const firstCandidate = path.join(configDir, 'projects', `${prefix}-aaa`);
    const secondCandidate = path.join(configDir, 'projects', `${prefix}-bbbb`);
    fs.mkdirSync(firstCandidate, { recursive: true });
    fs.mkdirSync(secondCandidate, { recursive: true });
    fs.writeFileSync(
      path.join(secondCandidate, 'session-long.jsonl'),
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-05-13T15:42:50.187Z',
        attachment: { type: 'goal_status', met: false, condition: 'find the right transcript' },
      }),
    );

    const adapter = new ClaudeCodeAdapter({ workingDir: longWorkspace });
    const goal = await adapter.getGoal({
      sessionId: 'session-long',
      workingDir: longWorkspace,
      cliProfile: {
        id: 'profile-claude',
        name: 'Claude',
        vendor: 'claude-code',
        authMode: 'account',
        configDir,
        createdAt: '2026-05-13T00:00:00.000Z',
        updatedAt: '2026-05-13T00:00:00.000Z',
      },
    } as any);

    expect(goal).toMatchObject({
      backend: 'claude-code',
      sessionId: 'session-long',
      objective: 'find the right transcript',
      status: 'active',
    });
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

  test('suppresses pure "no stdin data received" exits in streaming mode', async () => {
    let streamRef: AsyncGenerator<any>;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          setTimeout(() => {
            proc.stderr.emit('data', Buffer.from('no stdin data received\n'));
            proc.emit('close', 1, null);
          }, 10);
          return proc;
        },
        execFile: () => {},
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-stdin-timeout',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    const events: any[] = [];
    for await (const event of streamRef!) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events.some(e => e.type === 'error')).toBe(false);
    expect(events[events.length - 1].type).toBe('done');
  });

  test('emits backend runtime process id for durable job diagnostics', async () => {
    let streamRef: AsyncGenerator<any>;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.pid = 4242;
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
        sessionId: 'test-runtime-pid',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    const events: any[] = [];
    for await (const event of streamRef!) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events).toEqual(expect.arrayContaining([
      { type: 'backend_runtime', processId: 4242 },
    ]));
  });

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
        model: 'claude-opus-4-7',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    const idx = capturedArgs!.indexOf('--model');
    expect(idx).toBeGreaterThan(-1);
    expect(capturedArgs![idx + 1]).toBe('claude-opus-4-7');
  });

  test('uses Claude profile command, env, and CLAUDE_CONFIG_DIR for streaming', async () => {
    let capturedCmd: string | null = null;
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let streamRef: AsyncGenerator<any>;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: (cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
          capturedCmd = cmd;
          capturedEnv = opts.env;
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
        sessionId: 'test-profile',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
        cliProfile: {
          id: 'profile-claude-work',
          name: 'Claude Work',
          vendor: 'claude-code',
          command: '/opt/claude/bin/claude',
          authMode: 'account',
          configDir: '/tmp/claude-work-home',
          env: { ANTHROPIC_BASE_URL: 'https://example.test' },
          createdAt: '2026-04-29T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        },
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedCmd).toBe('/opt/claude/bin/claude');
    expect(capturedEnv?.ANTHROPIC_BASE_URL).toBe('https://example.test');
    expect(capturedEnv?.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-work-home');
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
        model: 'claude-sonnet-4-6',
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
        model: 'claude-opus-4-6',
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

  test('passes --effort xhigh only for Opus 4.7', async () => {
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
        sessionId: 'test-effort-xhigh',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
        model: 'claude-opus-4-7',
        effort: 'xhigh',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    const idx = capturedArgs!.indexOf('--effort');
    expect(idx).toBeGreaterThan(-1);
    expect(capturedArgs![idx + 1]).toBe('xhigh');
  });

  test('drops --effort xhigh on Opus 4.6 (only 4.7 supports it)', async () => {
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
        sessionId: 'test-effort-xhigh-46',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
        model: 'claude-opus-4-6',
        effort: 'xhigh',
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).not.toContain('--effort');
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
        model: 'claude-sonnet-4-6',
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
        model: 'claude-haiku-4-5',
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

  test('passes --mcp-config JSON string when mcpServers are provided', async () => {
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
        sessionId: 'test-mcp',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
        mcpServers: [
          {
            name: 'agent-cockpit-memory',
            command: 'node',
            args: ['/path/to/stub.cjs'],
            env: [
              { name: 'MEMORY_TOKEN', value: 'tok-abc' },
              { name: 'MEMORY_ENDPOINT', value: 'http://127.0.0.1:3335/x' },
            ],
          },
        ],
      });
      streamRef = stream;
    });

    for await (const event of streamRef!) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    const idx = capturedArgs!.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    const configJson = capturedArgs![idx + 1];
    expect(typeof configJson).toBe('string');
    const parsed = JSON.parse(configJson);
    expect(parsed.mcpServers['agent-cockpit-memory']).toEqual({
      command: 'node',
      args: ['/path/to/stub.cjs'],
      env: {
        MEMORY_TOKEN: 'tok-abc',
        MEMORY_ENDPOINT: 'http://127.0.0.1:3335/x',
      },
    });
  });

  test('omits --mcp-config when mcpServers is empty or missing', async () => {
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
        sessionId: 'test-no-mcp',
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
    expect(capturedArgs).not.toContain('--mcp-config');
  });
});

// ── runOneShot MCP passthrough ─────────────────────────────────────────────

describe('ClaudeCodeAdapter runOneShot', () => {
  test('passes --mcp-config when mcpServers provided', async () => {
    let capturedArgs: string[] | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
          capturedArgs = args;
          cb(null, 'output text', '');
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapter.runOneShot('test prompt', {
        mcpServers: [
          {
            name: 'agent-cockpit-kb-search',
            command: 'node',
            args: ['/path/to/stub.cjs'],
            env: [
              { name: 'KB_SEARCH_TOKEN', value: 'tok-xyz' },
              { name: 'KB_SEARCH_ENDPOINT', value: 'http://127.0.0.1:3335/x' },
            ],
          },
        ],
      });
    });

    expect(capturedArgs).toBeDefined();
    const idx = capturedArgs!.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    const configJson = capturedArgs![idx + 1];
    const parsed = JSON.parse(configJson);
    expect(parsed.mcpServers['agent-cockpit-kb-search']).toEqual({
      command: 'node',
      args: ['/path/to/stub.cjs'],
      env: {
        KB_SEARCH_TOKEN: 'tok-xyz',
        KB_SEARCH_ENDPOINT: 'http://127.0.0.1:3335/x',
      },
    });
  });

  test('omits --mcp-config when mcpServers not provided', async () => {
    let capturedArgs: string[] | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
          capturedArgs = args;
          cb(null, 'output text', '');
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapter.runOneShot('test prompt', {});
    });

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).not.toContain('--mcp-config');
  });

  test('returns stdout on successful execution', async () => {
    let result: Promise<string> | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, _args: string[], _opts: any, cb: any) => {
          cb(null, '  hello world  ', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      result = adapter.runOneShot('test prompt');
    });

    await expect(result!).resolves.toBe('hello world');
  });

  test('returns empty string when stdout is empty', async () => {
    let result: Promise<string> | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, _args: string[], _opts: any, cb: any) => {
          cb(null, '', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      result = adapter.runOneShot('test prompt');
    });

    await expect(result!).resolves.toBe('');
  });

  test('rejects with stderr message on execution error', async () => {
    let result: Promise<string> | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, _args: string[], _opts: any, cb: any) => {
          const err = new Error('exec failed') as any;
          err.code = 1;
          cb(err, '', 'something went wrong');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      result = adapter.runOneShot('test prompt');
    });

    await expect(result!).rejects.toThrow('claude --print failed: something went wrong');
  });

  test('rejects with exit code when stderr is empty', async () => {
    let result: Promise<string> | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, _args: string[], _opts: any, cb: any) => {
          const err = new Error('exec failed') as any;
          err.code = 42;
          cb(err, '', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      result = adapter.runOneShot('test prompt');
    });

    await expect(result!).rejects.toThrow('claude --print failed: Process exited with code 42');
  });

  test('rejects with timeout message when process is killed', async () => {
    let result: Promise<string> | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, _args: string[], _opts: any, cb: any) => {
          const err = new Error('killed') as any;
          err.killed = true;
          cb(err, '', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      result = adapter.runOneShot('test prompt', { timeoutMs: 30000 });
    });

    await expect(result!).rejects.toThrow('claude --print failed: Process killed (timeout after 30s)');
  });

  test('filters "no stdin data received" from stderr in error messages', async () => {
    let result: Promise<string> | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, _args: string[], _opts: any, cb: any) => {
          const err = new Error('exec failed') as any;
          err.code = 1;
          cb(err, '', 'no stdin data received\nreal error here');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      result = adapter.runOneShot('test prompt');
    });

    await expect(result!).rejects.toThrow('claude --print failed: real error here');
  });

  test('passes --model and --effort flags when both are supported', async () => {
    let capturedArgs: string[] | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
          capturedArgs = args;
          cb(null, 'ok', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapter.runOneShot('test prompt', { model: 'claude-opus-4-6', effort: 'high' });
    });

    expect(capturedArgs).toBeDefined();
    const modelIdx = capturedArgs!.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(capturedArgs![modelIdx + 1]).toBe('claude-opus-4-6');
    const effortIdx = capturedArgs!.indexOf('--effort');
    expect(effortIdx).toBeGreaterThan(-1);
    expect(capturedArgs![effortIdx + 1]).toBe('high');
  });

  test('drops --effort when model does not support that level', async () => {
    let capturedArgs: string[] | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
          capturedArgs = args;
          cb(null, 'ok', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapter.runOneShot('test prompt', { model: 'claude-sonnet-4-6', effort: 'max' });
    });

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).toContain('--model');
    expect(capturedArgs).not.toContain('--effort');
  });

  test('drops --effort for Haiku (no effort support)', async () => {
    let capturedArgs: string[] | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
          capturedArgs = args;
          cb(null, 'ok', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapter.runOneShot('test prompt', { model: 'claude-haiku-4-5', effort: 'high' });
    });

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).toContain('--model');
    expect(capturedArgs).not.toContain('--effort');
  });

  test('drops --effort when no model is specified', async () => {
    let capturedArgs: string[] | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
          capturedArgs = args;
          cb(null, 'ok', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapter.runOneShot('test prompt', { effort: 'high' });
    });

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).not.toContain('--model');
    expect(capturedArgs).not.toContain('--effort');
  });

  test('passes timeout to execFile options', async () => {
    let capturedOpts: any;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, _args: string[], opts: any, cb: any) => {
          capturedOpts = opts;
          cb(null, 'ok', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapter.runOneShot('test prompt', { timeoutMs: 120000 });
    });

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts.timeout).toBe(120000);
  });

  test('uses default 60s timeout when timeoutMs is not specified', async () => {
    let capturedOpts: any;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, _args: string[], opts: any, cb: any) => {
          capturedOpts = opts;
          cb(null, 'ok', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapter.runOneShot('test prompt');
    });

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts.timeout).toBe(60000);
  });

  test('passes --permission-mode bypassPermissions when allowTools is true', async () => {
    let capturedArgs: string[] | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
          capturedArgs = args;
          cb(null, 'ok', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapter.runOneShot('test prompt', { allowTools: true });
    });

    expect(capturedArgs).toBeDefined();
    const idx = capturedArgs!.indexOf('--permission-mode');
    expect(idx).toBeGreaterThan(-1);
    expect(capturedArgs![idx + 1]).toBe('bypassPermissions');
  });

  test('omits --permission-mode when allowTools is false or unset', async () => {
    let capturedArgs: string[] | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
          capturedArgs = args;
          cb(null, 'ok', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapter.runOneShot('test prompt', { allowTools: false });
    });

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).not.toContain('--permission-mode');
  });

  test('passes workingDir as cwd to execFile', async () => {
    let capturedOpts: any;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, _args: string[], opts: any, cb: any) => {
          capturedOpts = opts;
          cb(null, 'ok', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapter.runOneShot('test prompt', { workingDir: '/some/workspace' });
    });

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts.cwd).toBe('/some/workspace');
  });

  test('uses Claude profile command, env, and CLAUDE_CONFIG_DIR for one-shot calls', async () => {
    let capturedCmd: string | null = null;
    let capturedOpts: any;
    let result: Promise<string> | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (cmd: string, _args: string[], opts: any, cb: any) => {
          capturedCmd = cmd;
          capturedOpts = opts;
          cb(null, 'ok', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      result = adapter.runOneShot('test prompt', {
        cliProfile: {
          id: 'profile-claude-work',
          name: 'Claude Work',
          vendor: 'claude-code',
          command: '/opt/claude/bin/claude',
          authMode: 'account',
          configDir: '/tmp/claude-work-home',
          env: { ANTHROPIC_BASE_URL: 'https://example.test' },
          createdAt: '2026-04-29T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        },
      });
    });

    await expect(result!).resolves.toBe('ok');
    expect(capturedCmd).toBe('/opt/claude/bin/claude');
    expect(capturedOpts.env.ANTHROPIC_BASE_URL).toBe('https://example.test');
    expect(capturedOpts.env.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-work-home');
  });

  test('always includes --print -p flags with the prompt', async () => {
    let capturedArgs: string[] | undefined;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
          capturedArgs = args;
          cb(null, 'ok', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapter.runOneShot('my test prompt');
    });

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).toContain('--print');
    const pIdx = capturedArgs!.indexOf('-p');
    expect(pIdx).toBeGreaterThan(-1);
    expect(capturedArgs![pIdx + 1]).toBe('my test prompt');
  });

  test('sets maxBuffer to 4MB in execFile options', async () => {
    let capturedOpts: any;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        execFile: (_cmd: string, _args: string[], opts: any, cb: any) => {
          capturedOpts = opts;
          cb(null, 'ok', '');
          return { stdin: { end: () => {} } };
        },
        spawn: () => {
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          return proc;
        },
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapter.runOneShot('test prompt');
    });

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts.maxBuffer).toBe(4 * 1024 * 1024);
  });
});

// ── mcpServersToClaudeConfigJson ───────────────────────────────────────────

describe('mcpServersToClaudeConfigJson', () => {
  test('transforms ACP env array into Claude Code env object', () => {
    const json = mcpServersToClaudeConfigJson([
      {
        name: 'agent-cockpit-memory',
        command: 'node',
        args: ['/path/to/stub.cjs'],
        env: [
          { name: 'MEMORY_TOKEN', value: 'abc123' },
          { name: 'MEMORY_ENDPOINT', value: 'http://127.0.0.1:3335/x' },
        ],
      },
    ]);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({
      mcpServers: {
        'agent-cockpit-memory': {
          command: 'node',
          args: ['/path/to/stub.cjs'],
          env: {
            MEMORY_TOKEN: 'abc123',
            MEMORY_ENDPOINT: 'http://127.0.0.1:3335/x',
          },
        },
      },
    });
  });

  test('omits env key when no env vars are provided', () => {
    const json = mcpServersToClaudeConfigJson([
      { name: 'plain', command: 'node', args: [] },
    ]);
    const parsed = JSON.parse(json);
    expect(parsed.mcpServers.plain).toEqual({ command: 'node', args: [] });
    expect(parsed.mcpServers.plain.env).toBeUndefined();
  });

  test('handles multiple servers', () => {
    const json = mcpServersToClaudeConfigJson([
      { name: 'first', command: 'node', args: ['a.js'], env: [{ name: 'K1', value: 'v1' }] },
      { name: 'second', command: 'python', args: ['b.py'], env: [{ name: 'K2', value: 'v2' }] },
    ]);
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed.mcpServers)).toEqual(['first', 'second']);
    expect(parsed.mcpServers.first.env).toEqual({ K1: 'v1' });
    expect(parsed.mcpServers.second.env).toEqual({ K2: 'v2' });
  });

  test('coerces missing args to empty array', () => {
    const json = mcpServersToClaudeConfigJson([
      { name: 'x', command: 'node', args: undefined as any },
    ]);
    const parsed = JSON.parse(json);
    expect(parsed.mcpServers.x.args).toEqual([]);
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

  test('returns the deterministic short-path even when the dir is empty', () => {
    const workspace = '/tmp/empty-ws';
    const sanitized = '-tmp-empty-ws';
    const memDir = path.join(tmpHome, '.claude', 'projects', sanitized, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    // Empty dir — but the watcher needs a path to attach to, so we return
    // the deterministic path for short workspaces regardless of contents.
    expect(resolveClaudeMemoryDir(workspace)).toBe(memDir);
  });

  test('returns the deterministic short-path even when projects dir is absent', () => {
    const workspace = '/tmp/never-seen';
    const sanitized = '-tmp-never-seen';
    const expected = path.join(tmpHome, '.claude', 'projects', sanitized, 'memory');
    // The watcher attach site mkdir's the path, so we must return it even
    // when nothing exists yet.  extractMemory handles ENOENT separately.
    expect(resolveClaudeMemoryDir(workspace)).toBe(expected);
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

  function mkProfileMemory(configDir: string, workspace: string, files: Record<string, string>): void {
    const sanitized = workspace.replace(/[^a-zA-Z0-9]/g, '-');
    const full = path.join(configDir, 'projects', sanitized, 'memory');
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

  test('extracts memory from profile configDir when supplied', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-config-'));
    try {
      mkProfileMemory(configDir, '/tmp/profile-memtest', {
        'MEMORY.md': '- [Profile](project_profile.md) — profile scoped\n',
        'project_profile.md': `---
name: profile-memory
description: profile scoped memory
type: project
---

Profile scoped body.
`,
      });

      const snapshot = await adapter.extractMemory('/tmp/profile-memtest', {
        cliProfile: {
          id: 'profile-claude-work',
          name: 'Claude Work',
          vendor: 'claude-code',
          authMode: 'account',
          configDir,
          createdAt: '2026-04-29T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        },
      });
      expect(snapshot).not.toBeNull();
      expect(snapshot!.sourcePath).toBe(path.join(configDir, 'projects', '-tmp-profile-memtest', 'memory'));
      expect(snapshot!.files[0].type).toBe('project');
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
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

describe('ClaudeCodeAdapter.getMemoryDir', () => {
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

  function mkMemory(workspace: string, files: Record<string, string>): string {
    const sanitized = workspace.replace(/[^a-zA-Z0-9]/g, '-');
    const full = path.join(tmpHome, '.claude', 'projects', sanitized, 'memory');
    fs.mkdirSync(full, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(full, name), content, 'utf8');
    }
    return full;
  }

  function mkProfileMemory(configDir: string, workspace: string, files: Record<string, string>): string {
    const sanitized = workspace.replace(/[^a-zA-Z0-9]/g, '-');
    const full = path.join(configDir, 'projects', sanitized, 'memory');
    fs.mkdirSync(full, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(full, name), content, 'utf8');
    }
    return full;
  }

  test('returns null for empty workspacePath', () => {
    expect(adapter.getMemoryDir('')).toBeNull();
  });

  test('returns the deterministic short-path even when the dir does not exist', () => {
    // getMemoryDir is used by the real-time watcher, which needs a path
    // to attach to before Claude Code has written anything.  For short
    // workspace paths we can compute the exact dirname, so return it
    // regardless of whether anything exists on disk yet.
    const sanitized = '-tmp-never-seen';
    const expected = path.join(tmpHome, '.claude', 'projects', sanitized, 'memory');
    expect(adapter.getMemoryDir('/tmp/never-seen')).toBe(expected);
  });

  test('returns the sanitized directory path when memory exists', () => {
    const expected = mkMemory('/tmp/mem-getter', {
      'MEMORY.md': '- nothing\n',
      'feedback_x.md': '---\ntype: feedback\n---\nbody\n',
    });
    expect(adapter.getMemoryDir('/tmp/mem-getter')).toBe(expected);
  });

  test('resolves memory dir under profile configDir when supplied', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-config-'));
    try {
      const expected = mkProfileMemory(configDir, '/tmp/profile-mem-getter', {
        'MEMORY.md': '- profile\n',
      });
      expect(adapter.getMemoryDir('/tmp/profile-mem-getter', {
        cliProfile: {
          id: 'profile-claude-work',
          name: 'Claude Work',
          vendor: 'claude-code',
          authMode: 'account',
          configDir,
          createdAt: '2026-04-29T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        },
      })).toBe(expected);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('worktree workspaces resolve to the main repo memory dir', () => {
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

      const expected = mkMemory(main, { 'MEMORY.md': '- shared\n' });
      // Resolving via the worktree path should return the main repo's memory dir.
      expect(adapter.getMemoryDir(worktree)).toBe(expected);
    } finally {
      fs.rmSync(reposRoot, { recursive: true, force: true });
    }
  });
});
