import fs from 'fs';
import os from 'os';
import path from 'path';
import { BaseBackendAdapter } from '../src/services/backends/base';
import { BackendRegistry } from '../src/services/backends/registry';
import type { ModelOption } from '../src/types';
import {
  CodexAdapter,
  extractCodexToolDetails,
  lookupParentAgentId,
  eventIsFromChildThread,
  eventBelongsToActiveParentTurn,
  extractCodexThreadId,
  extractCodexTurnId,
  recordSpawnAgentReceivers,
  isParentTurnCompleted,
  deriveCodexUsage,
  buildCodexThreadSecurityParams,
  buildCodexServiceTierArgs,
  normalizeCodexModelOption,
  buildCodexTurnStartParams,
  resolveCodexCliRuntime,
  codexImageArtifactEvent,
  findCodexGeneratedImagePath,
} from '../src/services/backends/codex';

type MockCodexEmit = (message: Record<string, unknown>) => void;
type MockCodexWriteHandler = (req: any, emit: MockCodexEmit) => void;
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function mockProcessPlatform(platform: NodeJS.Platform): () => void {
  Object.defineProperty(process, 'platform', { value: platform });
  return () => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  };
}

function installCodexAppServerMock(
  onWrite: MockCodexWriteHandler,
  writes: any[] = [],
  pid = 7272,
): void {
  jest.doMock('child_process', () => {
    const { EventEmitter } = require('events');
    return {
      spawn: () => {
        const proc = new EventEmitter();
        proc.pid = pid;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.killed = false;
        proc.exitCode = null;
        proc.kill = () => {
          proc.killed = true;
          proc.exitCode = 0;
          setImmediate(() => proc.emit('close', 0, 'SIGTERM'));
        };
        const emit: MockCodexEmit = (message) => {
          proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'));
        };
        proc.stdin = {
          write: (line: string) => {
            const req = JSON.parse(line);
            writes.push(req);
            onWrite(req, emit);
            return true;
          },
          end: () => {},
        };
        return proc;
      },
      execFile: () => ({ stdin: { end: () => {} } }),
    };
  });
}

function codexUsage(totalTokens: number, outputTokens = 1) {
  return {
    total: {
      totalTokens,
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens,
    },
    last: {
      totalTokens,
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens,
    },
    modelContextWindow: 1000,
  };
}

// ── CodexAdapter metadata ───────────────────────────────────────────────────

describe('CodexAdapter', () => {
  test('buildCodexThreadSecurityParams defaults to full local access', () => {
    expect(buildCodexThreadSecurityParams()).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });

  test('buildCodexThreadSecurityParams supports restricted policy overrides', () => {
    expect(buildCodexThreadSecurityParams('on-request', 'workspace-write')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
  });

  test('buildCodexServiceTierArgs forces Fast mode only when requested', () => {
    expect(buildCodexServiceTierArgs()).toEqual([]);
    expect(buildCodexServiceTierArgs('fast')).toEqual([
      '-c',
      'service_tier="fast"',
      '-c',
      'features.fast_mode=true',
    ]);
  });

  test('metadata has correct shape', () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    const meta = adapter.metadata;
    expect(meta.id).toBe('codex');
    expect(meta.label).toBe('Codex');
    expect(meta.icon).toContain('<svg');
    expect(meta.capabilities).toEqual({
      thinking: true,
      planMode: false,
      agents: true,
      toolActivity: true,
      userQuestions: true,
      stdinInput: true,
      goals: {
        set: true,
        clear: true,
        pause: true,
        resume: true,
        status: 'native',
      },
    });
    expect(meta.resumeCapabilities.activeTurnResume).toBe('unsupported');
    expect(meta.resumeCapabilities.sessionResume).toBe('supported');
    expect(meta.resumeCapabilities.activeTurnResumeReason).toContain('thread/resume');
  });

  test('resolveCodexCliRuntime maps profile configDir to CODEX_HOME and honors command/env', () => {
    const runtime = resolveCodexCliRuntime({
      id: 'profile-codex-work',
      name: 'Codex Work',
      vendor: 'codex',
      command: '/opt/codex/bin/codex',
      authMode: 'account',
      configDir: '/tmp/codex-work-home',
      env: { OPENAI_BASE_URL: 'https://example.test', CODEX_HOME: '/tmp/ignored' },
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    });

    expect(runtime.command).toBe('/opt/codex/bin/codex');
    expect(runtime.env.OPENAI_BASE_URL).toBe('https://example.test');
    expect(runtime.env.CODEX_HOME).toBe('/tmp/codex-work-home');
    expect(runtime.profileKey).toContain('profile-codex-work:');
  });

  test('resolveCodexCliRuntime uses Windows installer-managed Codex package script through node', () => {
    const restorePlatform = mockProcessPlatform('win32');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-win-'));
    const originalDataDir = process.env.AGENT_COCKPIT_DATA_DIR;
    try {
      process.env.AGENT_COCKPIT_DATA_DIR = path.join(root, 'data');
      const codexJs = path.join(root, 'cli-tools', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      fs.mkdirSync(path.dirname(codexJs), { recursive: true });
      fs.writeFileSync(codexJs, '');

      const runtime = resolveCodexCliRuntime();

      expect(runtime.command).toBe(process.execPath);
      expect(runtime.argsPrefix).toEqual([codexJs]);
      expect(runtime.windowsCmdShim).toBeUndefined();
    } finally {
      if (originalDataDir === undefined) {
        delete process.env.AGENT_COCKPIT_DATA_DIR;
      } else {
        process.env.AGENT_COCKPIT_DATA_DIR = originalDataDir;
      }
      fs.rmSync(root, { recursive: true, force: true });
      restorePlatform();
    }
  });

  test('resolveCodexCliRuntime detects self-installed Windows Codex from PATH', () => {
    const restorePlatform = mockProcessPlatform('win32');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-path-win-'));
    const userBin = path.join(root, 'bin');
    const originalDataDir = process.env.AGENT_COCKPIT_DATA_DIR;
    const originalPath = process.env.PATH;
    try {
      process.env.AGENT_COCKPIT_DATA_DIR = path.join(root, 'data');
      process.env.PATH = userBin;
      fs.mkdirSync(userBin, { recursive: true });
      fs.writeFileSync(path.join(userBin, 'codex.cmd'), '');

      const runtime = resolveCodexCliRuntime();

      expect(runtime.command).toBe('codex.cmd');
      expect(runtime.argsPrefix).toBeUndefined();
      expect(runtime.windowsCmdShim).toBe(true);
    } finally {
      if (originalDataDir === undefined) {
        delete process.env.AGENT_COCKPIT_DATA_DIR;
      } else {
        process.env.AGENT_COCKPIT_DATA_DIR = originalDataDir;
      }
      process.env.PATH = originalPath;
      fs.rmSync(root, { recursive: true, force: true });
      restorePlatform();
    }
  });

  test('resolveCodexCliRuntime rejects non-Codex profiles', () => {
    expect(() => resolveCodexCliRuntime({
      id: 'profile-claude',
      name: 'Claude',
      vendor: 'claude-code',
      authMode: 'server-configured',
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    })).toThrow('CLI profile vendor claude-code is not codex');
  });

  test('metadata.models is populated immediately with fallback list', () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    const models = adapter.metadata.models;
    expect(models).toBeDefined();
    expect(models!.length).toBeGreaterThanOrEqual(3);
    // Exactly one default model
    expect(models!.filter((m) => m.default).length).toBe(1);
    // Fallback list includes the GPT family
    const gpt55 = models!.find((m) => m.id === 'gpt-5.5');
    expect(gpt55).toBeDefined();
    expect(gpt55!.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  test('getMetadata falls back when a Windows cmd shim exits before stdin writes complete', async () => {
    let metadataPromise!: Promise<Awaited<ReturnType<CodexAdapter['getMetadata']>>>;

    jest.isolateModules(() => {
      jest.doMock('child_process', () => {
        const { EventEmitter } = require('events');
        return {
          spawn: () => {
            const proc = new EventEmitter();
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.killed = false;
            proc.exitCode = null;
            proc.stdin = new EventEmitter();
            proc.stdin.destroyed = false;
            proc.stdin.writable = true;
            proc.stdin.write = () => {
              setImmediate(() => {
                proc.stdin.destroyed = true;
                proc.stdin.writable = false;
                proc.stdin.emit('error', new Error('write EPIPE'));
                proc.emit('close', 1, null);
              });
              return false;
            };
            proc.kill = () => {
              proc.killed = true;
              proc.emit('close', 1, null);
            };
            return proc;
          },
          execFile: () => ({ stdin: { end: () => {} } }),
        };
      });
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      metadataPromise = adapter.getMetadata();
    });

    try {
      const metadata = await metadataPromise;
      expect(metadata.models?.find((model: ModelOption) => model.id === 'gpt-5.5')).toBeDefined();
    } finally {
      jest.dontMock('child_process');
    }
  });

  test('getMetadata discovers and caches models per Codex profile runtime', async () => {
    let capturedCommand: string | null = null;
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let metadataPromise!: Promise<Awaited<ReturnType<CodexAdapter['getMetadata']>>>;

    jest.isolateModules(() => {
      jest.doMock('child_process', () => {
        const { EventEmitter } = require('events');
        return {
          spawn: (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
            capturedCommand = cmd;
            capturedEnv = opts.env;
            const proc = new EventEmitter();
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.killed = false;
            proc.exitCode = null;
            proc.stdin = {
              write: (line: string) => {
                const req = JSON.parse(line);
                if (req.method === 'initialize') {
                  setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: {},
                  }) + '\n')));
                } else if (req.method === 'model/list') {
                  setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: {
                      data: [{
                        id: 'gpt-profile-only',
                        displayName: 'GPT Profile Only',
                        isDefault: true,
                        supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }],
                      }],
                    },
                  }) + '\n')));
                }
                return true;
              },
              end: () => {},
            };
            proc.kill = () => {
              proc.killed = true;
              proc.emit('close', 0, null);
            };
            expect(args).toEqual(['app-server', '--enable', 'goals']);
            return proc;
          },
          execFile: () => ({ stdin: { end: () => {} } }),
        };
      });
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      metadataPromise = adapter.getMetadata({
        cliProfile: {
          id: 'profile-codex-models',
          name: 'Codex Models',
          vendor: 'codex',
          command: '/opt/codex/bin/codex',
          authMode: 'account',
          configDir: '/tmp/codex-models-home',
          createdAt: '2026-04-29T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        },
      });
    });

    const metadata = await metadataPromise;
    jest.dontMock('child_process');
    expect(capturedCommand).toBe('/opt/codex/bin/codex');
    expect(capturedEnv?.CODEX_HOME).toBe('/tmp/codex-models-home');
    expect(metadata.models?.map((m) => m.id)).toEqual(['gpt-profile-only']);
    expect(metadata.models?.[0].supportedEffortLevels).toEqual(['minimal']);
  });

  test('normalizes Codex model/list reasoning effort metadata', () => {
    const model = normalizeCodexModelOption({
      id: 'gpt-5.5',
      displayName: 'GPT-5.5',
      description: 'Frontier model',
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'none', description: 'No reasoning' },
        { reasoningEffort: 'minimal', description: 'Minimal reasoning' },
        { reasoningEffort: 'low', description: 'Low reasoning' },
        { reasoningEffort: 'high', description: 'High reasoning' },
        { reasoningEffort: 'xhigh', description: 'Extra high reasoning' },
      ],
    });

    expect(model).toEqual({
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      family: 'gpt',
      description: 'Frontier model',
      costTier: 'medium',
      default: true,
      supportedEffortLevels: ['none', 'minimal', 'low', 'high', 'xhigh'],
    });
  });

  test('normalizes debug-style Codex reasoning metadata defensively', () => {
    const model = normalizeCodexModelOption({
      slug: 'gpt-5.4',
      display_name: 'GPT-5.4',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
        { effort: 'unsupported-value' },
      ],
    });

    expect(model!.id).toBe('gpt-5.4');
    expect(model!.label).toBe('GPT-5.4');
    expect(model!.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  test('buildCodexTurnStartParams forwards supported effort only', () => {
    const models = [
      { id: 'gpt-5.5', label: 'GPT-5.5', family: 'gpt', supportedEffortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
      { id: 'basic', label: 'Basic', family: 'gpt' },
    ] satisfies ModelOption[];
    const input = [{ type: 'text', text: 'hello', text_elements: [] }];

    expect(buildCodexTurnStartParams('t1', input, 'gpt-5.5', 'minimal', models)).toEqual({
      threadId: 't1',
      input,
      model: 'gpt-5.5',
      effort: 'minimal',
    });
    expect(buildCodexTurnStartParams('t1', input, 'basic', 'minimal', models)).toEqual({
      threadId: 't1',
      input,
      model: 'basic',
    });
  });

  test('stdinInput is true (Codex accepts mid-turn user input via turn/steer)', () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    expect(adapter.metadata.capabilities.stdinInput).toBe(true);
  });

  test('userQuestions is true (Codex emits item/tool/requestUserInput)', () => {
    const adapter = new CodexAdapter({ workingDir: '/tmp' });
    expect(adapter.metadata.capabilities.userQuestions).toBe(true);
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

  test('sendMessage ignores stale previous-turn events before accepting current-turn events', async () => {
    let streamRef!: AsyncGenerator<any>;
    let adapterRef!: { shutdown: () => void };
    const writes: any[] = [];

    jest.isolateModules(() => {
      installCodexAppServerMock((req, emit) => {
        if (req.method === 'initialize') {
          setImmediate(() => emit({ id: req.id, result: {} }));
        } else if (req.method === 'thread/start') {
          setImmediate(() => emit({ id: req.id, result: { thread: { id: 'thread-1' } } }));
        } else if (req.method === 'turn/start') {
          setImmediate(() => {
            emit({ id: req.id, result: { turn: { id: 'turn-current' } } });
            emit({
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-1', turnId: 'turn-old', itemId: 'msg-old', delta: 'stale text' },
            });
            emit({
              method: 'thread/tokenUsage/updated',
              params: { threadId: 'thread-1', turnId: 'turn-old', tokenUsage: codexUsage(10, 10) },
            });
            emit({
              id: 90,
              method: 'item/commandExecution/requestApproval',
              params: { threadId: 'thread-1', turnId: 'turn-old', itemId: 'cmd-old' },
            });
            emit({
              id: 91,
              method: 'item/tool/requestUserInput',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-old',
                itemId: 'ask-old',
                questions: [{ id: 'q-old', header: 'Old question', question: 'Old?' }],
              },
            });
            emit({
              id: 93,
              method: 'item/permissions/requestApproval',
              params: { threadId: 'thread-1', turnId: 'turn-old', itemId: 'perm-old' },
            });
            emit({
              method: 'item/started',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-old',
                item: { type: 'commandExecution', id: 'cmd-old', command: 'old command' },
              },
            });
            emit({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-old' } },
            });
            emit({
              id: 92,
              method: 'item/commandExecution/requestApproval',
              params: { threadId: 'thread-1', turnId: 'turn-current', itemId: 'cmd-current' },
            });
            emit({
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-1', turnId: 'turn-current', itemId: 'msg-current', delta: 'current text' },
            });
            emit({
              method: 'item/started',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-current',
                item: { type: 'commandExecution', id: 'cmd-current', command: 'npm test' },
              },
            });
            emit({
              method: 'item/completed',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-current',
                item: { type: 'commandExecution', id: 'cmd-current', command: 'npm test', exitCode: 0 },
              },
            });
            emit({
              method: 'thread/tokenUsage/updated',
              params: { threadId: 'thread-1', turnId: 'turn-current', tokenUsage: codexUsage(25, 2) },
            });
            emit({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-current' } },
            });
          });
        }
      }, writes);
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapterRef = adapter;
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-session-stale-turn',
        conversationId: 'test-conv-stale-turn',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    const events: any[] = [];
    for await (const event of streamRef) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events.filter((event) => event.type === 'text').map((event) => event.content)).toEqual(['current text']);
    expect(events.some((event) => event.type === 'tool_activity' && event.id === 'cmd-old')).toBe(false);
    expect(events.some((event) => event.type === 'tool_activity' && event.id === 'ask-old')).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_activity', id: 'cmd-current', tool: 'Bash' }),
      expect.objectContaining({ type: 'tool_outcomes' }),
      expect.objectContaining({ type: 'usage', usage: expect.objectContaining({ outputTokens: 2 }) }),
      { type: 'done' },
    ]));
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
    expect(writes.find((entry) => entry.id === 90)).toMatchObject({ result: { decision: 'cancel' } });
    expect(writes.find((entry) => entry.id === 91)).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining('Stale Codex user-input request ignored') }),
    });
    expect(writes.find((entry) => entry.id === 93)).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining('Stale Codex permissions request ignored') }),
    });
    expect(writes.find((entry) => entry.id === 92)).toMatchObject({ result: { decision: 'acceptForSession' } });
    adapterRef.shutdown();
    jest.dontMock('child_process');
  });

  test('setGoalObjective ignores stale prior goal output before the owned goal turn', async () => {
    let streamRef!: AsyncGenerator<any>;
    let adapterRef!: { shutdown: () => void };

    jest.isolateModules(() => {
      installCodexAppServerMock((req, emit) => {
        const goal = {
          threadId: 'thread-goal',
          objective: 'ship the goal',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        };
        if (req.method === 'initialize') {
          setImmediate(() => emit({ id: req.id, result: {} }));
        } else if (req.method === 'thread/start') {
          setImmediate(() => emit({ id: req.id, result: { thread: { id: 'thread-goal' } } }));
        } else if (req.method === 'thread/goal/set') {
          setImmediate(() => {
            emit({ id: req.id, result: { goal } });
            emit({
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-goal', turnId: 'turn-old-goal', itemId: 'msg-old-goal', delta: 'old goal text' },
            });
            emit({
              method: 'thread/tokenUsage/updated',
              params: { threadId: 'thread-goal', turnId: 'turn-old-goal', tokenUsage: codexUsage(12, 12) },
            });
            emit({
              method: 'turn/completed',
              params: { threadId: 'thread-goal', turn: { id: 'turn-old-goal' } },
            });
          });
        } else if (req.method === 'turn/start') {
          expect(req.params.threadId).toBe('thread-goal');
          expect(req.params.input[0].text).toContain('ship the goal');
          setImmediate(() => {
            emit({ id: req.id, result: { turn: { id: 'turn-goal' } } });
            emit({
              method: 'thread/goal/updated',
              params: { threadId: 'thread-goal', turnId: 'turn-goal', goal },
            });
            emit({
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-goal', turnId: 'turn-goal', itemId: 'msg-goal', delta: 'current goal text' },
            });
            emit({
              method: 'thread/tokenUsage/updated',
              params: { threadId: 'thread-goal', turnId: 'turn-goal', tokenUsage: codexUsage(30, 3) },
            });
            emit({
              method: 'turn/completed',
              params: { threadId: 'thread-goal', turn: { id: 'turn-goal' } },
            });
          });
        }
      });
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapterRef = adapter;
      const { stream } = adapter.setGoalObjective('ship the goal', {
        sessionId: 'test-session-goal-stale',
        conversationId: 'test-conv-goal-stale',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    const events: any[] = [];
    for await (const event of streamRef) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events.filter((event) => event.type === 'text').map((event) => event.content)).toEqual(['current goal text']);
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      { type: 'backend_runtime', externalSessionId: 'thread-goal', activeTurnId: 'turn-goal', processId: 7272 },
      expect.objectContaining({ type: 'usage', usage: expect.objectContaining({ outputTokens: 3 }) }),
      { type: 'done' },
    ]));
    adapterRef.shutdown();
    jest.dontMock('child_process');
  });

  test('sendMessage keeps current child-thread tool attribution while dropping stale child events', async () => {
    let streamRef!: AsyncGenerator<any>;
    let adapterRef!: { shutdown: () => void };

    jest.isolateModules(() => {
      installCodexAppServerMock((req, emit) => {
        if (req.method === 'initialize') {
          setImmediate(() => emit({ id: req.id, result: {} }));
        } else if (req.method === 'thread/start') {
          setImmediate(() => emit({ id: req.id, result: { thread: { id: 'thread-1' } } }));
        } else if (req.method === 'turn/start') {
          setImmediate(() => {
            emit({ id: req.id, result: { turn: { id: 'turn-current' } } });
            emit({
              method: 'item/started',
              params: {
                threadId: 'child-old',
                turnId: 'turn-old-child',
                item: { type: 'commandExecution', id: 'cmd-old-child', command: 'old child command' },
              },
            });
            emit({
              method: 'item/completed',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-current',
                item: {
                  type: 'collabAgentToolCall',
                  id: 'spawn-1',
                  tool: 'spawnAgent',
                  senderThreadId: 'thread-1',
                  receiverThreadIds: ['child-current'],
                },
              },
            });
            emit({
              method: 'item/started',
              params: {
                threadId: 'child-current',
                turnId: 'turn-child-current',
                item: { type: 'commandExecution', id: 'cmd-child-current', command: 'child command' },
              },
            });
            emit({
              method: 'item/agentMessage/delta',
              params: { threadId: 'child-current', turnId: 'turn-child-current', itemId: 'msg-child', delta: 'hidden child text' },
            });
            emit({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-current' } },
            });
          });
        }
      });
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapterRef = adapter;
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-session-child-current',
        conversationId: 'test-conv-child-current',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    const events: any[] = [];
    for await (const event of streamRef) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events.some((event) => event.type === 'tool_activity' && event.id === 'cmd-old-child')).toBe(false);
    expect(events.some((event) => event.type === 'text' && event.content === 'hidden child text')).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_activity',
        id: 'cmd-child-current',
        parentAgentId: 'spawn-1',
      }),
      { type: 'done' },
    ]));
    adapterRef.shutdown();
    jest.dontMock('child_process');
  });

  test('sendMessage emits backend runtime turn id from the turn/start response', async () => {
    let streamRef!: AsyncGenerator<any>;
    let adapterRef!: { shutdown: () => void };

    jest.isolateModules(() => {
      jest.doMock('child_process', () => {
        const { EventEmitter } = require('events');
        return {
          spawn: () => {
            const proc = new EventEmitter();
            proc.pid = 6262;
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.killed = false;
            proc.exitCode = null;
            proc.kill = () => {
              proc.killed = true;
              proc.exitCode = 0;
              setImmediate(() => proc.emit('close', 0, 'SIGTERM'));
            };
            proc.stdin = {
              write: (line: string) => {
                const req = JSON.parse(line);
                if (req.method === 'initialize') {
                  setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: {},
                  }) + '\n')));
                } else if (req.method === 'thread/start') {
                  setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { thread: { id: 'thread-1' } },
                  }) + '\n')));
                } else if (req.method === 'turn/start') {
                  setImmediate(() => {
                    proc.stdout.emit('data', Buffer.from(JSON.stringify({
                      jsonrpc: '2.0',
                      id: req.id,
                      result: { turn: { id: 'turn-1' } },
                    }) + '\n'));
                    proc.stdout.emit('data', Buffer.from(JSON.stringify({
                      jsonrpc: '2.0',
                      method: 'turn/started',
                      params: { turnId: 'turn-1' },
                    }) + '\n'));
                    proc.stdout.emit('data', Buffer.from(JSON.stringify({
                      jsonrpc: '2.0',
                      method: 'turn/completed',
                      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
                    }) + '\n'));
                  });
                }
                return true;
              },
              end: () => {},
            };
            return proc;
          },
          execFile: () => ({ stdin: { end: () => {} } }),
        };
      });
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapterRef = adapter;
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-session-runtime',
        conversationId: 'test-conv-runtime',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    const events: any[] = [];
    for await (const event of streamRef) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events).toEqual(expect.arrayContaining([
      { type: 'external_session', sessionId: 'thread-1' },
      { type: 'backend_runtime', externalSessionId: 'thread-1', processId: 6262 },
      { type: 'backend_runtime', externalSessionId: 'thread-1', activeTurnId: 'turn-1', processId: 6262 },
    ]));
    expect(events.filter((event) => (
      event.type === 'backend_runtime' && event.activeTurnId === 'turn-1'
    ))).toHaveLength(1);
    adapterRef.shutdown();
    jest.dontMock('child_process');
  });

  test('setGoalObjective enables Codex goals and streams goal progress', async () => {
    let streamRef!: AsyncGenerator<any>;
    let adapterRef!: { shutdown: () => void };
    const initializeRequests: any[] = [];
    const spawnArgs: string[][] = [];
    const turnStartRequests: any[] = [];

    jest.isolateModules(() => {
      jest.doMock('child_process', () => {
        const { EventEmitter } = require('events');
        return {
          spawn: (_cmd: string, args: string[]) => {
            spawnArgs.push(args);
            const proc = new EventEmitter();
            proc.pid = 6565;
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.killed = false;
            proc.exitCode = null;
            proc.kill = () => {
              proc.killed = true;
              proc.exitCode = 0;
              setImmediate(() => proc.emit('close', 0, 'SIGTERM'));
            };
            proc.stdin = {
              write: (line: string) => {
                const req = JSON.parse(line);
                if (req.method === 'initialize') {
                  initializeRequests.push(req);
                  setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: {},
                  }) + '\n')));
                } else if (req.method === 'thread/start') {
                  setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { thread: { id: 'thread-goal' } },
                  }) + '\n')));
                } else if (req.method === 'thread/goal/set') {
                  expect(req.params).toEqual({
                    threadId: 'thread-goal',
                    status: 'active',
                    objective: 'ship the goal',
                  });
                  setImmediate(() => {
                    proc.stdout.emit('data', Buffer.from(JSON.stringify({
                      jsonrpc: '2.0',
                      id: req.id,
                      result: {
                        goal: {
                          threadId: 'thread-goal',
                          objective: 'ship the goal',
                          status: 'active',
                          tokenBudget: null,
                          tokensUsed: 0,
                          timeUsedSeconds: 0,
                          createdAt: 1,
                          updatedAt: 1,
                        },
                      },
                    }) + '\n'));
                  });
                } else if (req.method === 'turn/start') {
                  turnStartRequests.push(req);
                  expect(req.params.threadId).toBe('thread-goal');
                  expect(req.params.input[0].text).toContain('ship the goal');
                  setImmediate(() => {
                    proc.stdout.emit('data', Buffer.from(JSON.stringify({
                      jsonrpc: '2.0',
                      id: req.id,
                      result: { turn: { id: 'turn-goal' } },
                    }) + '\n'));
                    proc.stdout.emit('data', Buffer.from(JSON.stringify({
                      jsonrpc: '2.0',
                      method: 'item/agentMessage/delta',
                      params: { threadId: 'thread-goal', turnId: 'turn-goal', delta: 'working' },
                    }) + '\n'));
                    proc.stdout.emit('data', Buffer.from(JSON.stringify({
                      jsonrpc: '2.0',
                      method: 'thread/goal/updated',
                      params: {
                        threadId: 'thread-goal',
                        turnId: 'turn-goal',
                        goal: {
                          threadId: 'thread-goal',
                          objective: 'ship the goal',
                          status: 'complete',
                          tokenBudget: null,
                          tokensUsed: 1,
                          timeUsedSeconds: 2,
                          createdAt: 1,
                          updatedAt: 2,
                        },
                      },
                    }) + '\n'));
                    proc.stdout.emit('data', Buffer.from(JSON.stringify({
                      jsonrpc: '2.0',
                      method: 'turn/completed',
                      params: { threadId: 'thread-goal', turn: { id: 'turn-goal' } },
                    }) + '\n'));
                  });
                }
                return true;
              },
              end: () => {},
            };
            return proc;
          },
          execFile: () => ({ stdin: { end: () => {} } }),
        };
      });
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapterRef = adapter;
      const { stream } = adapter.setGoalObjective('ship the goal', {
        sessionId: 'test-session-goal',
        conversationId: 'test-conv-goal',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    const events: any[] = [];
    for await (const event of streamRef) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(spawnArgs[0]).toEqual(['app-server', '--enable', 'goals']);
    expect(initializeRequests[0].params.capabilities).toEqual({ experimentalApi: true });
    expect(turnStartRequests).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      { type: 'external_session', sessionId: 'thread-goal' },
      { type: 'backend_runtime', externalSessionId: 'thread-goal', processId: 6565 },
      { type: 'backend_runtime', externalSessionId: 'thread-goal', activeTurnId: 'turn-goal', processId: 6565 },
      { type: 'text', content: 'working', streaming: true },
    ]));
    expect(events.filter(event => event.type === 'goal_updated')).toHaveLength(2);
    adapterRef.shutdown();
    jest.dontMock('child_process');
  });

  test('setGoalObjective ends when Codex sends terminal goal status without turn completion', async () => {
    let streamRef!: AsyncGenerator<any>;
    let adapterRef!: { shutdown: () => void };
    let turnStartCount = 0;

    jest.isolateModules(() => {
      installCodexAppServerMock((req, emit) => {
        const activeGoal = {
          threadId: 'thread-goal',
          objective: 'ship the goal',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        };
        const completeGoal = {
          ...activeGoal,
          status: 'complete',
          tokensUsed: 1,
          timeUsedSeconds: 2,
          updatedAt: 2,
        };

        if (req.method === 'initialize') {
          setImmediate(() => emit({ id: req.id, result: {} }));
        } else if (req.method === 'thread/start') {
          setImmediate(() => emit({ id: req.id, result: { thread: { id: 'thread-goal' } } }));
        } else if (req.method === 'thread/goal/set') {
          setImmediate(() => emit({ id: req.id, result: { goal: activeGoal } }));
        } else if (req.method === 'thread/read') {
          setImmediate(() => emit({ id: req.id, result: { thread: { id: 'thread-goal', turns: [] } } }));
        } else if (req.method === 'turn/start') {
          turnStartCount += 1;
          if (turnStartCount === 1) {
            setImmediate(() => {
              emit({ id: req.id, result: { turn: { id: 'turn-goal' } } });
              emit({
                method: 'thread/goal/updated',
                params: { threadId: 'thread-goal', turnId: 'turn-goal', goal: completeGoal },
              });
            });
          } else {
            expect(req.params.input[0].text).toContain('final report');
            setImmediate(() => {
              emit({ id: req.id, result: { turn: { id: 'turn-report' } } });
              emit({
                method: 'item/agentMessage/delta',
                params: { threadId: 'thread-goal', turnId: 'turn-report', delta: 'final report' },
              });
              emit({
                method: 'turn/completed',
                params: { threadId: 'thread-goal', turn: { id: 'turn-report' } },
              });
            });
          }
        }
      });
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapterRef = adapter;
      const { stream } = adapter.setGoalObjective('ship the goal', {
        sessionId: 'test-session-goal-terminal-no-turn-complete',
        conversationId: 'test-conv-goal-terminal-no-turn-complete',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    const events: any[] = [];
    for await (const event of streamRef) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events).toEqual(expect.arrayContaining([
      { type: 'backend_runtime', externalSessionId: 'thread-goal', activeTurnId: 'turn-goal', processId: 7272 },
      { type: 'backend_runtime', externalSessionId: 'thread-goal', activeTurnId: 'turn-report', processId: 7272 },
      expect.objectContaining({
        type: 'goal_updated',
        goal: expect.objectContaining({ status: 'complete' }),
      }),
      { type: 'text', content: 'final report', streaming: true },
      { type: 'done' },
    ]));
    expect(turnStartCount).toBe(2);
    adapterRef.shutdown();
    jest.dontMock('child_process');
  });

  test('setGoalObjective polls terminal goal status when Codex omits stream notifications', async () => {
    let streamRef!: AsyncGenerator<any>;
    let adapterRef!: { shutdown: () => void };
    let turnStartCount = 0;

    jest.isolateModules(() => {
      installCodexAppServerMock((req, emit) => {
        const activeGoal = {
          threadId: 'thread-goal',
          objective: 'ship the goal',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        };
        const completeGoal = {
          ...activeGoal,
          status: 'complete',
          tokensUsed: 1,
          timeUsedSeconds: 2,
          updatedAt: 2,
        };

        if (req.method === 'initialize') {
          setImmediate(() => emit({ id: req.id, result: {} }));
        } else if (req.method === 'thread/start') {
          setImmediate(() => emit({ id: req.id, result: { thread: { id: 'thread-goal' } } }));
        } else if (req.method === 'thread/goal/set') {
          setImmediate(() => emit({ id: req.id, result: { goal: activeGoal } }));
        } else if (req.method === 'thread/goal/get') {
          setImmediate(() => emit({ id: req.id, result: { goal: completeGoal } }));
        } else if (req.method === 'thread/read') {
          setImmediate(() => emit({ id: req.id, result: { thread: { id: 'thread-goal', turns: [] } } }));
        } else if (req.method === 'turn/start') {
          turnStartCount += 1;
          if (turnStartCount === 1) {
            setImmediate(() => emit({ id: req.id, result: { turn: { id: 'turn-goal' } } }));
          } else {
            expect(req.params.input[0].text).toContain('final report');
            setImmediate(() => {
              emit({ id: req.id, result: { turn: { id: 'turn-report' } } });
              emit({
                method: 'item/agentMessage/delta',
                params: { threadId: 'thread-goal', turnId: 'turn-report', delta: 'polled report' },
              });
              emit({
                method: 'turn/completed',
                params: { threadId: 'thread-goal', turn: { id: 'turn-report' } },
              });
            });
          }
        }
      });
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapterRef = adapter;
      const { stream } = adapter.setGoalObjective('ship the goal', {
        sessionId: 'test-session-goal-poll-terminal',
        conversationId: 'test-conv-goal-poll-terminal',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    const events: any[] = [];
    for await (const event of streamRef) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events).toEqual(expect.arrayContaining([
      { type: 'backend_runtime', externalSessionId: 'thread-goal', activeTurnId: 'turn-goal', processId: 7272 },
      { type: 'backend_runtime', externalSessionId: 'thread-goal', activeTurnId: 'turn-report', processId: 7272 },
      expect.objectContaining({
        type: 'goal_updated',
        goal: expect.objectContaining({ status: 'complete' }),
      }),
      { type: 'text', content: 'polled report', streaming: true },
      { type: 'done' },
    ]));
    expect(turnStartCount).toBe(2);
    adapterRef.shutdown();
    jest.dontMock('child_process');
  });

  test('sendMessage emits turn/start response turn id before done when completion is in the same chunk', async () => {
    let streamRef!: AsyncGenerator<any>;
    let adapterRef!: { shutdown: () => void };

    jest.isolateModules(() => {
      jest.doMock('child_process', () => {
        const { EventEmitter } = require('events');
        return {
          spawn: () => {
            const proc = new EventEmitter();
            proc.pid = 6363;
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.killed = false;
            proc.exitCode = null;
            proc.kill = () => {
              proc.killed = true;
              proc.exitCode = 0;
              setImmediate(() => proc.emit('close', 0, 'SIGTERM'));
            };
            proc.stdin = {
              write: (line: string) => {
                const req = JSON.parse(line);
                if (req.method === 'initialize') {
                  setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: {},
                  }) + '\n')));
                } else if (req.method === 'thread/start') {
                  setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { thread: { id: 'thread-1' } },
                  }) + '\n')));
                } else if (req.method === 'turn/start') {
                  setImmediate(() => {
                    const response = JSON.stringify({
                      jsonrpc: '2.0',
                      id: req.id,
                      result: { turn: { id: 'turn-1' } },
                    });
                    const completed = JSON.stringify({
                      jsonrpc: '2.0',
                      method: 'turn/completed',
                      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
                    });
                    proc.stdout.emit('data', Buffer.from(`${response}\n${completed}\n`));
                  });
                }
                return true;
              },
              end: () => {},
            };
            return proc;
          },
          execFile: () => ({ stdin: { end: () => {} } }),
        };
      });
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapterRef = adapter;
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-session-runtime-same-chunk',
        conversationId: 'test-conv-runtime-same-chunk',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    const events: any[] = [];
    for await (const event of streamRef) {
      events.push(event);
      if (event.type === 'done') break;
    }

    const activeTurnEvents = events.filter((event) => (
      event.type === 'backend_runtime' && event.activeTurnId === 'turn-1'
    ));
    expect(activeTurnEvents).toHaveLength(1);
    expect(events.indexOf(activeTurnEvents[0])).toBeLessThan(events.findIndex((event) => event.type === 'done'));
    adapterRef.shutdown();
    jest.dontMock('child_process');
  });

  test('sendMessage emits turn/start response turn id before delayed completion without turn/started', async () => {
    let streamRef!: AsyncGenerator<any>;
    let adapterRef!: { shutdown: () => void };
    let emitCompletion: (() => void) | null = null;

    jest.isolateModules(() => {
      jest.doMock('child_process', () => {
        const { EventEmitter } = require('events');
        return {
          spawn: () => {
            const proc = new EventEmitter();
            proc.pid = 6464;
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.killed = false;
            proc.exitCode = null;
            proc.kill = () => {
              proc.killed = true;
              proc.exitCode = 0;
              setImmediate(() => proc.emit('close', 0, 'SIGTERM'));
            };
            proc.stdin = {
              write: (line: string) => {
                const req = JSON.parse(line);
                if (req.method === 'initialize') {
                  setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: {},
                  }) + '\n')));
                } else if (req.method === 'thread/start') {
                  setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { thread: { id: 'thread-1' } },
                  }) + '\n')));
                } else if (req.method === 'turn/start') {
                  setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { turn: { id: 'turn-1' } },
                  }) + '\n')));
                  emitCompletion = () => {
                    proc.stdout.emit('data', Buffer.from(JSON.stringify({
                      jsonrpc: '2.0',
                      method: 'turn/completed',
                      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
                    }) + '\n'));
                  };
                }
                return true;
              },
              end: () => {},
            };
            return proc;
          },
          execFile: () => ({ stdin: { end: () => {} } }),
        };
      });
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      adapterRef = adapter;
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-session-runtime-delayed-completion',
        conversationId: 'test-conv-runtime-delayed-completion',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    const events: any[] = [];
    const iterator = streamRef[Symbol.asyncIterator]();
    while (!events.some((event) => event.type === 'backend_runtime' && event.activeTurnId === 'turn-1')) {
      const { value, done } = await iterator.next();
      expect(done).toBe(false);
      events.push(value);
      expect(value.type).not.toBe('done');
    }

    const activeTurnEvent = events.find((event) => (
      event.type === 'backend_runtime' && event.activeTurnId === 'turn-1'
    ));
    expect(activeTurnEvent).toEqual({
      type: 'backend_runtime',
      externalSessionId: 'thread-1',
      activeTurnId: 'turn-1',
      processId: 6464,
    });

    expect(emitCompletion).not.toBeNull();
    emitCompletion!();
    while (!events.some((event) => event.type === 'done')) {
      const { value, done } = await iterator.next();
      expect(done).toBe(false);
      events.push(value);
    }

    expect(events.findIndex((event) => (
      event.type === 'backend_runtime' && event.activeTurnId === 'turn-1'
    ))).toBeLessThan(events.findIndex((event) => event.type === 'done'));
    adapterRef.shutdown();
    jest.dontMock('child_process');
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

  test('imageGeneration result emits an artifact event from base64 image data', () => {
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8C6YQAAAABJRU5ErkJggg==';
    const event = codexImageArtifactEvent({
      type: 'imageGeneration',
      id: 'ig-1',
      result: pngBase64,
    } as any, 'thread-1');

    expect(event).toMatchObject({
      type: 'artifact',
      dataBase64: pngBase64,
      filename: 'ig-1.png',
      mimeType: 'image/png',
      sourceToolId: 'ig-1',
    });
  });

  test('findCodexGeneratedImagePath searches profile generated_images folders', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-codex-images-'));
    try {
      const imageDir = path.join(tmp, 'generated_images', 'rollout-1');
      fs.mkdirSync(imageDir, { recursive: true });
      const imagePath = path.join(imageDir, 'ig-1.png');
      fs.writeFileSync(imagePath, 'png');

      expect(findCodexGeneratedImagePath('ig-1', 'thread-1', {
        command: 'codex',
        env: {},
        configDir: tmp,
        profileKey: 'test',
      })).toBe(imagePath);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('collabAgentToolCall (spawnAgent) maps to Agent with prompt preview and isAgent flag', () => {
    const result = extractCodexToolDetails({
      type: 'collabAgentToolCall',
      id: 'collab-1',
      tool: 'spawnAgent',
      prompt: 'Investigate the failing test in src/foo.ts',
    });
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('Agent');
    expect(result!.id).toBe('collab-1');
    expect(result!.description).toContain('Spawning subagent');
    expect(result!.description).toContain('Investigate the failing test');
    expect(result!.isAgent).toBe(true);
    expect(result!.subagentType).toBe('spawnAgent');
  });

  test('collabAgentToolCall (spawnAgent) truncates long prompts', () => {
    const longPrompt = 'a'.repeat(120);
    const result = extractCodexToolDetails({
      type: 'collabAgentToolCall',
      id: 'collab-2',
      tool: 'spawnAgent',
      prompt: longPrompt,
    });
    expect(result!.description).toContain('...');
  });

  test('collabAgentToolCall (sendInput) maps to Agent with input preview', () => {
    const result = extractCodexToolDetails({
      type: 'collabAgentToolCall',
      id: 'collab-3',
      tool: 'sendInput',
      prompt: 'follow up',
    });
    expect(result!.tool).toBe('Agent');
    expect(result!.description).toContain('Subagent input');
    expect(result!.subagentType).toBe('sendInput');
  });

  test('collabAgentToolCall (closeAgent) maps to Agent with closing label', () => {
    const result = extractCodexToolDetails({
      type: 'collabAgentToolCall',
      id: 'collab-4',
      tool: 'closeAgent',
    });
    expect(result!.tool).toBe('Agent');
    expect(result!.description).toBe('Closing subagent');
    expect(result!.subagentType).toBe('closeAgent');
  });

  test('collabAgentToolCall without tool falls back to generic subagent label', () => {
    const result = extractCodexToolDetails({
      type: 'collabAgentToolCall',
      id: 'collab-5',
    });
    expect(result!.tool).toBe('Agent');
    expect(result!.isAgent).toBe(true);
    expect(result!.subagentType).toBe('subagent');
  });

  test('unknown item types return null', () => {
    const result = extractCodexToolDetails({ type: 'agentMessage', id: 'm-1' });
    expect(result).toBeNull();
  });
});

// ── Subagent thread demultiplexing helpers ─────────────────────────────────
//
// `item/*` notifications from `codex app-server` carry `threadId` at the
// params level. The cockpit uses three small helpers to attribute child-
// thread activity back to its originating top-level Agent card:
//   • recordSpawnAgentReceivers — populates the threadId → topLevelCallId map
//     when a spawnAgent item completes
//   • lookupParentAgentId       — reads parentAgentId for an event's threadId
//   • eventIsFromChildThread    — boolean variant for drop-decisions

describe('recordSpawnAgentReceivers', () => {
  test('completed spawnAgent populates the map (top-level → call id)', () => {
    const map = new Map<string, string>();
    recordSpawnAgentReceivers(
      {
        type: 'collabAgentToolCall',
        id: 'call-1',
        tool: 'spawnAgent',
        senderThreadId: 'parent-thread',
        receiverThreadIds: ['child-a', 'child-b'],
      },
      map,
    );
    expect(map.get('child-a')).toBe('call-1');
    expect(map.get('child-b')).toBe('call-1');
  });

  test('non-collab item is a no-op', () => {
    const map = new Map<string, string>();
    recordSpawnAgentReceivers(
      { type: 'commandExecution', id: 'cmd-1', command: 'ls' },
      map,
    );
    expect(map.size).toBe(0);
  });

  test('non-spawnAgent collab tool is a no-op', () => {
    const map = new Map<string, string>();
    for (const tool of ['sendInput', 'resumeAgent', 'wait', 'closeAgent']) {
      recordSpawnAgentReceivers(
        {
          type: 'collabAgentToolCall',
          id: `call-${tool}`,
          tool,
          senderThreadId: 'parent-thread',
          receiverThreadIds: ['child-x'],
        },
        map,
      );
    }
    expect(map.size).toBe(0);
  });

  test('spawnAgent with empty receiverThreadIds is a no-op', () => {
    const map = new Map<string, string>();
    recordSpawnAgentReceivers(
      {
        type: 'collabAgentToolCall',
        id: 'call-2',
        tool: 'spawnAgent',
        senderThreadId: 'parent-thread',
        receiverThreadIds: [],
      },
      map,
    );
    expect(map.size).toBe(0);
  });

  test('spawnAgent without receiverThreadIds is a no-op', () => {
    const map = new Map<string, string>();
    recordSpawnAgentReceivers(
      {
        type: 'collabAgentToolCall',
        id: 'call-3',
        tool: 'spawnAgent',
        senderThreadId: 'parent-thread',
      },
      map,
    );
    expect(map.size).toBe(0);
  });

  test('grand-children flatten to the original top-level call id', () => {
    const map = new Map<string, string>();
    // Parent spawns child-a under call-1
    recordSpawnAgentReceivers(
      {
        type: 'collabAgentToolCall',
        id: 'call-1',
        tool: 'spawnAgent',
        senderThreadId: 'parent-thread',
        receiverThreadIds: ['child-a'],
      },
      map,
    );
    // child-a then spawns grand-c under call-2; sender is already in the map,
    // so grand-c should attribute back to call-1, not call-2.
    recordSpawnAgentReceivers(
      {
        type: 'collabAgentToolCall',
        id: 'call-2',
        tool: 'spawnAgent',
        senderThreadId: 'child-a',
        receiverThreadIds: ['grand-c'],
      },
      map,
    );
    expect(map.get('grand-c')).toBe('call-1');
  });

  test('falls back to call id when senderThreadId is missing', () => {
    const map = new Map<string, string>();
    recordSpawnAgentReceivers(
      {
        type: 'collabAgentToolCall',
        id: 'call-1',
        tool: 'spawnAgent',
        receiverThreadIds: ['child-a'],
      },
      map,
    );
    expect(map.get('child-a')).toBe('call-1');
  });
});

describe('lookupParentAgentId', () => {
  test('returns mapped value for a known child threadId', () => {
    const map = new Map<string, string>([['child-a', 'call-1']]);
    expect(lookupParentAgentId({ threadId: 'child-a' }, map)).toBe('call-1');
  });

  test('returns undefined when threadId is missing', () => {
    const map = new Map<string, string>([['child-a', 'call-1']]);
    expect(lookupParentAgentId({}, map)).toBeUndefined();
  });

  test('returns undefined for parent (unmapped) threadId', () => {
    const map = new Map<string, string>([['child-a', 'call-1']]);
    expect(lookupParentAgentId({ threadId: 'parent-thread' }, map)).toBeUndefined();
  });
});

describe('Codex turn ownership helpers', () => {
  test('extractCodexThreadId reads params.threadId defensively', () => {
    expect(extractCodexThreadId({ threadId: 'thread-1' })).toBe('thread-1');
    expect(extractCodexThreadId({ threadId: '' })).toBeNull();
    expect(extractCodexThreadId({})).toBeNull();
  });

  test('extractCodexTurnId reads params.turnId and params.turn.id', () => {
    expect(extractCodexTurnId({ turnId: 'turn-1' })).toBe('turn-1');
    expect(extractCodexTurnId({ turn: { id: 'turn-2' } })).toBe('turn-2');
    expect(extractCodexTurnId({ turn: { id: '' } })).toBeNull();
    expect(extractCodexTurnId({})).toBeNull();
  });

  test('eventBelongsToActiveParentTurn requires matching thread and turn', () => {
    expect(eventBelongsToActiveParentTurn(
      { threadId: 'thread-1', turnId: 'turn-1' },
      'thread-1',
      'turn-1',
    )).toBe(true);
    expect(eventBelongsToActiveParentTurn(
      { threadId: 'thread-1', turnId: 'turn-old' },
      'thread-1',
      'turn-1',
    )).toBe(false);
    expect(eventBelongsToActiveParentTurn(
      { threadId: 'thread-2', turnId: 'turn-1' },
      'thread-1',
      'turn-1',
    )).toBe(false);
    expect(eventBelongsToActiveParentTurn(
      { threadId: 'thread-1' },
      'thread-1',
      'turn-1',
    )).toBe(false);
  });
});

describe('isParentTurnCompleted', () => {
  test('returns true when threadId matches parent', () => {
    expect(isParentTurnCompleted({ threadId: 'parent' }, 'parent')).toBe(true);
  });

  test('returns false when threadId is a child', () => {
    expect(isParentTurnCompleted({ threadId: 'child-a' }, 'parent')).toBe(false);
  });

  test('returns true (legacy) when params has no threadId', () => {
    expect(isParentTurnCompleted({}, 'parent')).toBe(true);
  });

  test('returns true (legacy) when parentThreadId is null', () => {
    expect(isParentTurnCompleted({ threadId: 'anything' }, null)).toBe(true);
  });

  test('requires the active turn id when provided', () => {
    expect(isParentTurnCompleted(
      { threadId: 'parent', turn: { id: 'turn-1' } },
      'parent',
      'turn-1',
    )).toBe(true);
    expect(isParentTurnCompleted(
      { threadId: 'parent', turn: { id: 'turn-old' } },
      'parent',
      'turn-1',
    )).toBe(false);
    expect(isParentTurnCompleted(
      { threadId: 'parent' },
      'parent',
      'turn-1',
    )).toBe(false);
  });
});

describe('eventIsFromChildThread', () => {
  test('returns true for known child threadId', () => {
    const map = new Map<string, string>([['child-a', 'call-1']]);
    expect(eventIsFromChildThread({ threadId: 'child-a' }, map)).toBe(true);
  });

  test('returns false for unknown threadId', () => {
    const map = new Map<string, string>([['child-a', 'call-1']]);
    expect(eventIsFromChildThread({ threadId: 'parent-thread' }, map)).toBe(false);
  });

  test('returns false when threadId is missing', () => {
    const map = new Map<string, string>([['child-a', 'call-1']]);
    expect(eventIsFromChildThread({}, map)).toBe(false);
  });

  test('returns false for empty map', () => {
    expect(eventIsFromChildThread({ threadId: 'anything' }, new Map())).toBe(false);
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
  test('uses full bypass exec mode by default', async () => {
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
    expect(capturedArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(capturedArgs).not.toContain('--full-auto');
  });

  test('uses explicit policy flags when configured for restricted access', async () => {
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
      const adapter = new IsolatedAdapter({
        workingDir: '/tmp',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      });
      resultPromise = adapter.runOneShot('p', { workingDir: '/tmp' });
    });

    await resultPromise;
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs).toEqual(expect.arrayContaining(['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write']));
    expect(capturedArgs).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(capturedArgs).not.toContain('--full-auto');
  });

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

  test('rejects as timeout when codex exec exits cleanly after SIGTERM', async () => {
    let resultPromise!: Promise<string>;
    let killedWithSigterm = false;

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
        execFile: (_cmd: string, _args: string[], _opts: object, cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => ({
          stdin: { end: () => {} },
          kill: (signal?: NodeJS.Signals) => {
            if (signal === 'SIGTERM') {
              killedWithSigterm = true;
              setTimeout(() => cb(null, '', ''), 0);
            }
            return true;
          },
        }),
      }));
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('p', { workingDir: '/tmp', timeoutMs: 10 });
    });

    const assertion = expect(resultPromise).rejects.toThrow(/timeout after 0\.01s/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await assertion;
    expect(killedWithSigterm).toBe(true);
    jest.dontMock('child_process');
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

  test('forwards supported effort option as model_reasoning_effort config to codex exec', async () => {
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
      resultPromise = adapter.runOneShot('p', { workingDir: '/tmp', model: 'gpt-5.5', effort: 'xhigh' });
    });

    await resultPromise;
    expect(capturedArgs).not.toBeNull();
    const configIdx = capturedArgs!.indexOf('-c');
    expect(configIdx).toBeGreaterThan(-1);
    expect(capturedArgs![configIdx + 1]).toBe('model_reasoning_effort="xhigh"');
  });

  test('forwards Fast service tier config to codex exec', async () => {
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
      resultPromise = adapter.runOneShot('p', { workingDir: '/tmp', serviceTier: 'fast' });
    });

    await resultPromise;
    expect(capturedArgs).not.toBeNull();
    const cFlagIndices = capturedArgs!.reduce<number[]>((acc, v, i) => (v === '-c' ? [...acc, i] : acc), []);
    expect(cFlagIndices.map((i) => capturedArgs![i + 1])).toEqual([
      'service_tier="fast"',
      'features.fast_mode=true',
    ]);
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

  test('uses Codex profile command, env, and CODEX_HOME for codex exec', async () => {
    let capturedCmd: string | null = null;
    let capturedEnv: NodeJS.ProcessEnv | undefined;
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
        execFile: (cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }, cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
          capturedCmd = cmd;
          capturedEnv = opts.env;
          setImmediate(() => cb(null, 'ok', ''));
          return { stdin: { end: () => {} } };
        },
      }));
      const { CodexAdapter: IsolatedAdapter } = require('../src/services/backends/codex');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      resultPromise = adapter.runOneShot('p', {
        workingDir: '/tmp',
        cliProfile: {
          id: 'profile-codex-work',
          name: 'Codex Work',
          vendor: 'codex',
          command: '/opt/codex/bin/codex',
          authMode: 'account',
          configDir: '/tmp/codex-work-home',
          env: { OPENAI_BASE_URL: 'https://example.test' },
          createdAt: '2026-04-29T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        },
      });
    });

    await resultPromise;
    expect(capturedCmd).toBe('/opt/codex/bin/codex');
    expect(capturedEnv?.OPENAI_BASE_URL).toBe('https://example.test');
    expect(capturedEnv?.CODEX_HOME).toBe('/tmp/codex-work-home');
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

// ── deriveCodexUsage ────────────────────────────────────────────────────────

describe('deriveCodexUsage', () => {
  test('inputTokens is fresh (uncached) input only — accumulating across turns must not double-count history', () => {
    // Simulate three turns of a Codex conversation with a 272k context window.
    // Each turn re-sends the full prior context as cached input; only ~5k of
    // new content per turn is truly "fresh" (the user's message + prior
    // assistant output that hadn't been cache-written yet).
    const t1 = deriveCodexUsage({
      last: { totalTokens: 6000, inputTokens: 5000, cachedInputTokens: 0, outputTokens: 1000 },
      total: { totalTokens: 6000, inputTokens: 5000, cachedInputTokens: 0, outputTokens: 1000 },
      modelContextWindow: 272_000,
    });
    const t2 = deriveCodexUsage({
      last: { totalTokens: 13_000, inputTokens: 11_000, cachedInputTokens: 5000, outputTokens: 2000 },
      total: { totalTokens: 19_000, inputTokens: 16_000, cachedInputTokens: 5000, outputTokens: 3000 },
      modelContextWindow: 272_000,
    });
    const t3 = deriveCodexUsage({
      last: { totalTokens: 21_000, inputTokens: 18_000, cachedInputTokens: 11_000, outputTokens: 3000 },
      total: { totalTokens: 40_000, inputTokens: 34_000, cachedInputTokens: 16_000, outputTokens: 6000 },
      modelContextWindow: 272_000,
    });
    // Fresh input per turn = last.inputTokens - last.cachedInputTokens
    expect(t1.inputTokens).toBe(5000);  // 5000 - 0
    expect(t2.inputTokens).toBe(6000);  // 11000 - 5000
    expect(t3.inputTokens).toBe(7000);  // 18000 - 11000
    // Output is per-turn (no overlap), accumulates cleanly
    expect(t1.outputTokens).toBe(1000);
    expect(t2.outputTokens).toBe(2000);
    expect(t3.outputTokens).toBe(3000);
    // Cache-read tracks the cached portion of this turn's prompt
    expect(t1.cacheReadTokens).toBe(0);
    expect(t2.cacheReadTokens).toBe(5000);
    expect(t3.cacheReadTokens).toBe(11_000);
  });

  test('contextUsagePercentage is a snapshot of the current turn, never cumulative — must stay 0–100 in normal use', () => {
    // 10 turns each filling ~270k of a 272k window. Pre-fix bug used
    // total.totalTokens here and reported 1000%+; correct behavior is to
    // reflect *this turn's* context size.
    const usage = deriveCodexUsage({
      last: { totalTokens: 270_000, inputTokens: 268_000, cachedInputTokens: 250_000, outputTokens: 2000 },
      total: { totalTokens: 2_700_000, inputTokens: 2_680_000, cachedInputTokens: 2_500_000, outputTokens: 20_000 },
      modelContextWindow: 272_000,
    });
    expect(usage.contextUsagePercentage).toBe(99); // 270000 / 272000 ≈ 99.26 → round → 99
  });

  test('contextUsagePercentage is undefined when modelContextWindow is null or zero', () => {
    const noWindow = deriveCodexUsage({
      last: { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 0, outputTokens: 1000 },
      total: { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 0, outputTokens: 1000 },
      modelContextWindow: null,
    });
    expect(noWindow.contextUsagePercentage).toBeUndefined();

    const zeroWindow = deriveCodexUsage({
      last: { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 0, outputTokens: 1000 },
      total: { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 0, outputTokens: 1000 },
      modelContextWindow: 0,
    });
    expect(zeroWindow.contextUsagePercentage).toBeUndefined();
  });

  test('clamps inputTokens to 0 if cached exceeds raw input (defensive against malformed input)', () => {
    const usage = deriveCodexUsage({
      last: { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 5000, outputTokens: 1000 },
      total: { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 5000, outputTokens: 1000 },
      modelContextWindow: 272_000,
    });
    expect(usage.inputTokens).toBe(0);
  });
});
