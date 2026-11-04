import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { CliProfile, StreamEvent } from '../src/types';
import { CopilotAdapter, __copilotTestUtils, resolveCopilotCliRuntime } from '../src/services/backends/copilot';
import { COPILOT_MODELS } from '../src/services/backends/copilotModels';
import { canonicalCopilotToolName } from '../src/services/backends/copilotTools';
import { copilotMcpConfig } from '../src/services/backends/copilotSessionConfig';
import { checkOneShotMediaInput } from '../src/services/backends/mediaCapabilities';

const {
  buildCopilotRunArgs,
  collectCopilotJson,
  copilotLineInfo,
  translateCopilotLine,
} = __copilotTestUtils;

function copilotProfile(overrides: Partial<CliProfile> = {}): CliProfile {
  const now = '2026-06-17T00:00:00.000Z';
  return {
    id: 'profile-copilot',
    name: 'GitHub Copilot',
    harness: 'copilot',
    authMode: 'server-configured',
    command: 'fixture-copilot-jsonl',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Copilot backend metadata', () => {
  test('custom command metadata preserves capabilities and identifies the fallback catalog', async () => {
    const backend = new CopilotAdapter();
    expect(await backend.getMetadata({ cliProfile: copilotProfile() })).toEqual({ ...backend.metadata,
      modelCatalog: { source: 'fallback', reason: 'Custom command compatibility mode; account model discovery is unavailable.' } });
  });

  test('advertises thinking, tool activity, and media transport', () => {
    const metadata = new CopilotAdapter().metadata;
    expect(metadata.id).toBe('copilot');
    expect(metadata.label).toBe('GitHub Copilot');
    expect(metadata.icon).toContain('<svg');
    expect(metadata.capabilities.thinking).toBe(true);
    expect(metadata.capabilities.toolActivity).toBe(true);
    expect(metadata.capabilities.planMode).toBe(false);
    expect(metadata.capabilities.agents).toBe(false);
    expect(metadata.capabilities.oneShotMediaInput).toEqual({
      image: ['explicit-attachment'],
      pdf: ['explicit-attachment'],
    });
  });

  test('exposes a curated model catalog with a default and effort levels', () => {
    expect(COPILOT_MODELS.length).toBeGreaterThan(0);
    const ids = COPILOT_MODELS.map(model => model.id);
    expect(ids).toContain('claude-sonnet-4.6');
    expect(ids).toContain('gpt-6.1-sol');
    expect(ids).toContain('claude-sonnet-5.5');
    expect(ids).not.toContain('gpt-4.1');
    const defaults = COPILOT_MODELS.filter(model => model.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe('auto');
    for (const model of COPILOT_MODELS) {
      expect(model.capabilities?.input?.pdf).toBe(model.id === 'gpt-6.1-sol');
      if (model.id === 'auto' || model.id.startsWith('claude-haiku') || model.id.startsWith('gemini')) {
        expect(model.supportedEffortLevels).toBeUndefined();
      } else {
        expect(model.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
      }
    }
  });

  test.each(['image', 'pdf'] as const)('gates %s processors on verified explicit models rather than automatic routing', modality => {
    const metadata = new CopilotAdapter().metadata;
    expect(checkOneShotMediaInput(metadata, 'gpt-6.1-sol', modality).ok).toBe(true);
    expect(checkOneShotMediaInput(metadata, undefined, modality).ok).toBe(false);
    expect(checkOneShotMediaInput(metadata, 'auto', modality).ok).toBe(false);
    expect(checkOneShotMediaInput(metadata, 'gemini-3.8-flash', modality).ok).toBe(false);
    expect(checkOneShotMediaInput(metadata, 'claude-sonnet-5.5', modality).ok).toBe(false);
  });

  test('session resume is supported while active turn resume is not', () => {
    const metadata = new CopilotAdapter().metadata;
    expect(metadata.resumeCapabilities.sessionResume).toBe('supported');
    expect(metadata.resumeCapabilities.activeTurnResume).toBe('unsupported');
  });
});

describe('resolveCopilotCliRuntime', () => {
  test('prefers the Windows npm package entrypoint over its command shim', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-windows-'));
    const loader = path.join(root, 'cli-tools', 'node_modules', '@github', 'copilot', 'npm-loader.js');
    fs.mkdirSync(path.dirname(loader), { recursive: true });
    fs.writeFileSync(loader, '');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const runtime = resolveCopilotCliRuntime(copilotProfile({ env: { AGENT_COCKPIT_DATA_DIR: path.join(root, 'data') } }));
      expect(runtime.command).toBe(process.execPath);
      expect(runtime.argsPrefix).toEqual([loader]);
      expect(runtime.windowsCmdShim).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', platform);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('defaults to the copilot command and applies profile env', () => {
    const runtime = resolveCopilotCliRuntime(copilotProfile({ env: { FOO: 'bar', PATH: '/usr/bin:/bin' } }));
    expect(runtime.command).toContain('copilot');
    expect(runtime.env.FOO).toBe('bar');
    expect(runtime.profileKey.startsWith('profile-copilot:')).toBe(true);
  });

  test('honors a profile command override', () => {
    const runtime = resolveCopilotCliRuntime(copilotProfile({ command: '/opt/custom/copilot', env: { PATH: '/usr/bin' } }));
    expect(runtime.command).toBe('/opt/custom/copilot');
  });

  test('throws when the profile harness is not copilot', () => {
    expect(() => resolveCopilotCliRuntime(copilotProfile({ harness: 'opencode' as CliProfile['harness'] })))
      .toThrow(/not copilot/);
  });
});

describe('buildCopilotRunArgs', () => {
  test('builds non-interactive JSON args with full access for the chat path', () => {
    const args = buildCopilotRunArgs('hello world', {
      workingDir: '/tmp/workspace',
      model: 'gpt-6.1-sol',
      effort: 'high',
      externalSessionId: 'sess-123',
      allowTools: true,
    });
    expect(args.slice(0, 8)).toEqual(['-p', 'hello world', '--output-format', 'json', '--no-ask-user', '--no-color', '--log-level', 'none']);
    expect(args).toContain('--allow-all');
    expect(args).not.toContain('--allow-all-tools');
    expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-6.1-sol']));
    expect(args).toEqual(expect.arrayContaining(['--stream', 'on', '--no-auto-update']));
    expect(args).toEqual(expect.arrayContaining(['--reasoning-effort', 'high']));
    expect(args).toEqual(expect.arrayContaining(['--resume', 'sess-123']));
  });

  test('explicitly removes tools from the restricted one-shot path', () => {
    const args = buildCopilotRunArgs('summarize', { workingDir: '/tmp' });
    expect(args).toContain('--allow-all-tools');
    expect(args).not.toContain('--allow-all');
    expect(args).not.toContain('--resume');
    expect(args).toEqual(expect.arrayContaining(['--available-tools', 'none']));
  });

  test.each(['auto', 'claude-haiku-4.5', 'gemini-3.8-flash', 'unknown-model'])('does not send reasoning effort for %s', model => {
    expect(buildCopilotRunArgs('hi', { model, effort: 'high' })).not.toContain('--reasoning-effort');
  });

  test('ignores unsupported effort levels', () => {
    const args = buildCopilotRunArgs('hi', { effort: 'minimal' });
    expect(args).not.toContain('--reasoning-effort');
  });

  test('passes image and pdf attachments through --attachment', () => {
    const args = buildCopilotRunArgs('describe', {
      attachments: [
        { path: '/tmp/a.png', kind: 'image' },
        { path: '/tmp/b.pdf', kind: 'pdf' },
        { path: '/tmp/c.txt', kind: 'text' },
      ],
    });
    expect(args).toEqual(expect.arrayContaining(['--attachment', '/tmp/a.png', '--attachment', '/tmp/b.pdf']));
    expect(args).not.toContain('/tmp/c.txt');
  });

  test('emits --additional-mcp-config when MCP servers are provided', () => {
    const args = buildCopilotRunArgs('hi', {
      mcpServers: [{ name: 'agent-cockpit-memory', command: 'node', args: ['mem.js'], env: [{ name: 'TOKEN', value: 't' }] }],
    });
    const idx = args.indexOf('--additional-mcp-config');
    expect(idx).toBeGreaterThan(-1);
    const config = JSON.parse(args[idx + 1]);
    expect(config.mcpServers['agent-cockpit-memory']).toEqual({
      type: 'local',
      command: 'node',
      args: ['mem.js'],
      tools: ['*'],
      env: { TOKEN: 't' },
    });
    // MCP presence also implies broad access.
    expect(args).toContain('--allow-all');
    expect(args).not.toContain('--available-tools');
  });
});

describe('copilotMcpConfig', () => {
  test('returns null when there are no servers', () => {
    expect(copilotMcpConfig(undefined)).toBeNull();
    expect(copilotMcpConfig([])).toBeNull();
  });
});

describe('translateCopilotLine', () => {
  test.each([
    ['create', { path: '/repo/output.txt' }, 'Write', 'Writing'],
    ['str_replace', { path: '/repo/source.ts' }, 'Edit', 'Editing'],
    ['bash', { command: 'echo hello' }, 'Bash', 'Running:'],
    ['grep', { pattern: 'marker' }, 'Grep', 'Searching for'],
    ['glob', { pattern: '*.ts' }, 'Glob', 'Finding files'],
    ['web_fetch', { url: 'https://example.test' }, 'WebFetch', 'Fetching:'],
    ['web_search', { query: 'marker' }, 'WebSearch', 'Searching:'],
  ])('presents %s tool activity with the correct action and input', (name, args, tool, description) => {
    const [event] = translateCopilotLine(JSON.stringify({
      type: 'tool.execution_start', data: { toolCallId: 'tool1', toolName: name, arguments: args },
    }));
    expect(event).toMatchObject({ type: 'tool_activity', id: 'tool1', tool, description: expect.stringContaining(description) });
  });

  test('retains the tool name when native completion events omit it', () => {
    const names = new Map<string, string>();
    translateCopilotLine(JSON.stringify({
      type: 'tool.execution_start', data: { toolCallId: 'bash1', toolName: 'bash', arguments: { command: 'true' } },
    }), names);
    expect(translateCopilotLine(JSON.stringify({
      type: 'tool.execution_complete', data: { toolCallId: 'bash1', success: true, result: { content: '<exited with exit code 0>' } },
    }), names)).toEqual([{
      type: 'tool_outcomes', outcomes: [{ toolUseId: 'bash1', isError: false, outcome: 'exit 0', status: 'success' }],
    }]);
    expect(names.size).toBe(0);
  });

  test('recognizes native Memory MCP tool names', () => {
    expect(translateCopilotLine(JSON.stringify({
      type: 'tool.execution_start', data: { toolCallId: 'mem1', toolName: 'agent-cockpit-memory-memory_search', arguments: {} },
    }))).toEqual([{
      type: 'tool_activity', id: 'mem1', tool: 'memory_search', description: 'agent-cockpit-memory.memory_search',
    }]);
  });

  test('surfaces structured session and terminal failures', () => {
    expect(translateCopilotLine(JSON.stringify({ type: 'session.error', data: { message: 'Model unavailable' } })))
      .toEqual([{ type: 'error', error: 'Model unavailable' }]);
    expect(translateCopilotLine(JSON.stringify({ type: 'result', exitCode: 1, error: { message: 'Request failed' } })))
      .toEqual([{ type: 'error', error: 'Request failed' }]);
  });

  test('maps assistant.message_delta to streaming text', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'assistant.message_delta',
      data: { messageId: 'm1', deltaContent: 'Hello' },
    }));
    expect(events).toEqual([{ type: 'text', content: 'Hello', streaming: true }]);
  });

  test('maps assistant.reasoning_delta to streaming thinking', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'assistant.reasoning_delta',
      data: { reasoningId: 'r1', deltaContent: 'Let me think' },
    }));
    expect(events).toEqual([{ type: 'thinking', content: 'Let me think', streaming: true }]);
  });

  test('maps tool.execution_start to tool activity with a friendly description', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'tool.execution_start',
      data: { toolCallId: 't1', toolName: 'bash', arguments: { command: 'echo hi', description: 'Echo hi' } },
    }));
    expect(events).toEqual([{ type: 'tool_activity', tool: 'Bash', id: 't1', description: 'Echo hi' }]);
  });

  test('maps a view tool to a Read activity', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'tool.execution_start',
      data: { toolCallId: 't2', toolName: 'view', arguments: { path: '/repo/src/app.ts' } },
    }));
    expect(events[0]).toMatchObject({ type: 'tool_activity', tool: 'Read', id: 't2' });
  });

  test('maps a successful tool.execution_complete to a success outcome', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'tool.execution_complete',
      data: { toolCallId: 't1', toolName: 'bash', success: true, result: { content: 'hello\n<exited with exit code 0>' } },
    }));
    expect(events).toEqual([{
      type: 'tool_outcomes',
      outcomes: [{ toolUseId: 't1', isError: false, outcome: 'exit 0', status: 'success' }],
    }]);
  });

  test('maps a failed tool.execution_complete to an error outcome', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'tool.execution_complete',
      data: { toolCallId: 't9', toolName: 'view', success: false, result: { content: 'no such file' } },
    }));
    expect(events).toEqual([{
      type: 'tool_outcomes',
      outcomes: [{ toolUseId: 't9', isError: true, outcome: 'error', status: 'error' }],
    }]);
  });

  test('maps result to an external_session event', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'result',
      sessionId: 'sess-abc',
      exitCode: 0,
      usage: { premiumRequests: 3 },
    }));
    expect(events).toEqual([{ type: 'external_session', sessionId: 'sess-abc' }]);
  });

  test('ignores envelope and lifecycle events', () => {
    expect(translateCopilotLine(JSON.stringify({ type: 'assistant.turn_start', data: {} }))).toEqual([]);
    expect(translateCopilotLine(JSON.stringify({ type: 'session.mcp_servers_loaded', data: {} }))).toEqual([]);
    expect(translateCopilotLine('not json')).toEqual([]);
    expect(translateCopilotLine('')).toEqual([]);
  });
});

describe('copilotLineInfo', () => {
  test('extracts output tokens from assistant.message', () => {
    const info = copilotLineInfo(JSON.stringify({
      type: 'assistant.message',
      data: { messageId: 'm1', content: 'pong', outputTokens: 5 },
    }));
    expect(info.outputTokens).toBe(5);
    expect(info.isResult).toBe(false);
  });

  test('extracts sessionId and premium requests from result', () => {
    const info = copilotLineInfo(JSON.stringify({
      type: 'result',
      sessionId: 'sess-9',
      usage: { premiumRequests: 2 },
    }));
    expect(info.sessionId).toBe('sess-9');
    expect(info.premiumRequests).toBe(2);
    expect(info.isResult).toBe(true);
  });
});

describe('canonicalCopilotToolName', () => {
  test('canonicalizes copilot tool names', () => {
    expect(canonicalCopilotToolName('bash')).toBe('Bash');
    expect(canonicalCopilotToolName('view')).toBe('Read');
    expect(canonicalCopilotToolName('create')).toBe('Write');
    expect(canonicalCopilotToolName('str_replace')).toBe('Edit');
    expect(canonicalCopilotToolName('grep')).toBe('Grep');
    expect(canonicalCopilotToolName('report_intent')).toBe('Intent');
    expect(canonicalCopilotToolName('some_custom_tool')).toBe('SomeCustomTool');
  });
});

describe('collectCopilotJson', () => {
  test('returns only the post-tool answer rather than pre-tool narration', () => {
    expect(collectCopilotJson([
      JSON.stringify({ type: 'assistant.message', data: { messageId: 'before', content: 'I will read the file.' } }),
      JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 'read1', toolName: 'view' } }),
      JSON.stringify({ type: 'assistant.message', data: { messageId: 'after', content: '{"answer":"done"}' } }),
    ].join('\n')).text).toBe('{"answer":"done"}');
  });

  test('uses complete final text rather than a partial streamed prefix', () => {
    expect(collectCopilotJson([
      JSON.stringify({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'partial' } }),
      JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', content: 'complete answer' } }),
    ].join('\n')).text).toBe('complete answer');
  });

  test('does not duplicate a final message followed by a delta', () => {
    expect(collectCopilotJson([
      JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', content: 'answer' } }),
      JSON.stringify({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'answer' } }),
    ].join('\n')).text).toBe('answer');
  });

  test('rejects JSON-reported failures', () => {
    expect(() => collectCopilotJson(JSON.stringify({ type: 'result', exitCode: 2 }))).toThrow('code 2');
  });

  test('reconstructs streamed text, session id, and usage from JSONL', () => {
    const stdout = [
      JSON.stringify({ type: 'assistant.message_start', data: { messageId: 'm1' } }),
      JSON.stringify({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'po' } }),
      JSON.stringify({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'ng' } }),
      JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', content: 'pong', outputTokens: 5 } }),
      JSON.stringify({ type: 'result', sessionId: 'sess-xyz', exitCode: 0, usage: { premiumRequests: 3 } }),
    ].join('\n');
    const result = collectCopilotJson(stdout);
    expect(result.text).toBe('pong');
    expect(result.sessionId).toBe('sess-xyz');
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      costSource: 'none',
      credits: 3,
    });

  });

  test('falls back to final message content when no deltas were streamed', () => {
    const stdout = [
      JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', content: 'final answer', outputTokens: 4 } }),
      JSON.stringify({ type: 'result', sessionId: 'sess-1', exitCode: 0, usage: {} }),
    ].join('\n');
    const result = collectCopilotJson(stdout);
    expect(result.text).toBe('final answer');
    expect(result.sessionId).toBe('sess-1');
  });
});

describe('CopilotAdapter working directory validation', () => {
  test('reports a missing working directory before spawning Copilot', async () => {
    const adapter = new CopilotAdapter({ workingDir: '/tmp' });
    const missing = path.join(os.tmpdir(), `copilot-missing-${Date.now()}`);
    const result = adapter.sendMessage('hello', {
      sessionId: 'session-1',
      isNewSession: true,
      workingDir: missing,
      systemPrompt: '',
    });
    const events: StreamEvent[] = [];
    for await (const event of result.stream) {
      events.push(event);
    }
    expect(events.some(e => e.type === 'error' && /does not exist/.test((e as { error: string }).error))).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });
});

describe('CopilotAdapter streaming', () => {
  test('streams text, thinking, tool activity, session, and usage from the CLI JSONL', async () => {
    let streamRef!: AsyncGenerator<StreamEvent>;
    const spawnArgs: string[][] = [];
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-stream-'));

    jest.isolateModules(() => {
      jest.doMock('child_process', () => {
        const { EventEmitter } = require('events');
        const { PassThrough } = require('stream');
        return {
          spawn: (_cmd: string, args: string[]) => {
            spawnArgs.push(args);
            const proc = new EventEmitter();
            proc.pid = 4242;
            proc.stdout = new PassThrough();
            proc.stderr = new PassThrough();
            proc.kill = () => {};
            setImmediate(() => {
              proc.stdout.write(JSON.stringify({ type: 'assistant.reasoning_delta', data: { reasoningId: 'r1', deltaContent: 'Thinking' } }) + '\n');
              proc.stdout.write(JSON.stringify({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'Hello' } }) + '\n');
              proc.stdout.write(JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'bash', arguments: { command: 'ls', description: 'List files' } } }) + '\n');
              proc.stdout.write(JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId: 't1', toolName: 'bash', success: true, result: { content: 'ok\n<exited with exit code 0>' } } }) + '\n');
              proc.stdout.write(JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', content: 'Hello', outputTokens: 7 } }) + '\n');
              proc.stdout.write(JSON.stringify({ type: 'result', sessionId: 'sess-stream', exitCode: 0, usage: { premiumRequests: 1 } }) + '\n');
              proc.stdout.end();
              proc.stderr.end();
              proc.emit('close', 0, null);
            });
            return proc;
          },
        };
      });
      const { CopilotAdapter: IsolatedAdapter } = require('../src/services/backends/copilot');
      const adapter = new IsolatedAdapter({ workingDir: workdir });
      streamRef = adapter.sendMessage('hi', {
        cliProfile: copilotProfile(),
        sessionId: 'session-1',
        conversationId: 'conv-copilot',
        isNewSession: true,
        workingDir: workdir,
        systemPrompt: 'Be helpful.',
      }).stream;
    });

    const events: StreamEvent[] = [];
    for await (const event of streamRef) {
      events.push(event);
    }
    jest.dontMock('child_process');
    fs.rmSync(workdir, { recursive: true, force: true });

    expect(spawnArgs[0]).toEqual(expect.arrayContaining(['-p', '--output-format', 'json', '--allow-all']));
    expect(events).toEqual(expect.arrayContaining([
      { type: 'thinking', content: 'Thinking', streaming: true },
      { type: 'text', content: 'Hello', streaming: true },
      expect.objectContaining({ type: 'tool_activity', tool: 'Bash', id: 't1' }),
      expect.objectContaining({ type: 'tool_outcomes' }),
      { type: 'external_session', sessionId: 'sess-stream' },
      {
        type: 'usage',
        usage: {
          inputTokens: 0,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          costSource: 'none',
          credits: 1,
        },
      },
      { type: 'done' },
    ]));
  });

  test('resumes a prior session by passing --resume', async () => {
    let streamRef!: AsyncGenerator<StreamEvent>;
    const spawnArgs: string[][] = [];
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-resume-'));

    jest.isolateModules(() => {
      jest.doMock('child_process', () => {
        const { EventEmitter } = require('events');
        const { PassThrough } = require('stream');
        return {
          spawn: (_cmd: string, args: string[]) => {
            spawnArgs.push(args);
            const proc = new EventEmitter();
            proc.pid = 4343;
            proc.stdout = new PassThrough();
            proc.stderr = new PassThrough();
            proc.kill = () => {};
            setImmediate(() => {
              proc.stdout.write(JSON.stringify({ type: 'assistant.message_delta', data: { messageId: 'm2', deltaContent: 'again' } }) + '\n');
              proc.stdout.write(JSON.stringify({ type: 'result', sessionId: 'sess-keep', exitCode: 0, usage: {} }) + '\n');
              proc.stdout.end();
              proc.stderr.end();
              proc.emit('close', 0, null);
            });
            return proc;
          },
        };
      });
      const { CopilotAdapter: IsolatedAdapter } = require('../src/services/backends/copilot');
      const adapter = new IsolatedAdapter({ workingDir: workdir });
      streamRef = adapter.sendMessage('follow up', {
        cliProfile: copilotProfile(),
        sessionId: 'session-1',
        conversationId: 'conv-copilot-resume',
        isNewSession: false,
        externalSessionId: 'sess-keep',
        workingDir: workdir,
        systemPrompt: '',
      }).stream;
    });

    const events: StreamEvent[] = [];
    for await (const event of streamRef) {
      events.push(event);
    }
    jest.dontMock('child_process');
    fs.rmSync(workdir, { recursive: true, force: true });

    expect(spawnArgs[0]).toEqual(expect.arrayContaining(['--resume', 'sess-keep']));
    expect(events).toEqual(expect.arrayContaining([
      { type: 'text', content: 'again', streaming: true },
      { type: 'done' },
    ]));
  });
});

class CopilotTestProcess extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = jest.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    this.finish([], 0, signal);
    return true;
  });

  finish(events: Record<string, unknown>[] = [], code = 0, signal: NodeJS.Signals | null = null): void {
    for (const event of events) this.stdout.write(JSON.stringify(event) + '\n');
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

describe('Copilot lifecycle regressions', () => {
  let workdir: string;
  let processes: CopilotTestProcess[];
  let spawn: jest.Mock;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-lifecycle-'));
    processes = [];
  });

  afterEach(() => {
    jest.dontMock('child_process');
    jest.dontMock('../src/services/backends/copilotUsage');
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  function adapter(handler: (proc: CopilotTestProcess, index: number) => void): CopilotAdapter {
    let result!: CopilotAdapter;
    spawn = jest.fn(() => {
      const proc = new CopilotTestProcess();
      const index = processes.push(proc) - 1;
      setImmediate(() => handler(proc, index));
      return proc;
    });
    jest.isolateModules(() => {
      jest.doMock('child_process', () => ({ spawn }));
      const { CopilotAdapter: IsolatedAdapter } = require('../src/services/backends/copilot');
      result = new IsolatedAdapter({ workingDir: workdir });
      jest.spyOn(result, 'getMetadata').mockResolvedValue(result.metadata);
    });
    return result;
  }

  function options() {
    return { sessionId: 'test-session', workingDir: workdir, systemPrompt: '', isNewSession: true, cliProfile: copilotProfile() };
  }

  async function collect(stream: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  test('gives chat and one-shot children distinct inherited ownership without changing the profile environment', async () => {
    const backend = adapter(proc => proc.finish());
    const profile = copilotProfile({ env: { FIXTURE_ENV: 'preserved' } });
    await collect(backend.sendMessage('chat', { ...options(), cliProfile: profile }).stream);
    await backend.runOneShot('one-shot', { cliProfile: profile });
    const [chat, oneShot] = spawn.mock.calls.map(call => call[2].env);
    expect(chat.AGENT_COCKPIT_COPILOT_SCOPE).toMatch(/^[a-f0-9-]{36}$/);
    expect(oneShot.AGENT_COCKPIT_COPILOT_SCOPE).not.toBe(chat.AGENT_COCKPIT_COPILOT_SCOPE);
    expect(chat.FIXTURE_ENV).toBe('preserved');
    expect(profile.env).toEqual({ FIXTURE_ENV: 'preserved' });
  });

  test('does not spawn a stream cancelled before consumption', async () => {
    const result = adapter(proc => proc.finish()).sendMessage('hi', options());
    result.abort();
    expect(await collect(result.stream)).toEqual([
      { type: 'error', error: 'Copilot turn aborted.', source: 'abort' },
      { type: 'done' },
    ]);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('shutdown during asynchronous baseline loading prevents a late native spawn', async () => {
    let release!: (value: null) => void;
    jest.doMock('../src/services/backends/copilotUsage', () => ({
      ...jest.requireActual('../src/services/backends/copilotUsage'),
      readCopilotUsageBaseline: () => new Promise<null>(resolve => { release = resolve; }),
    }));
    const backend = adapter(proc => proc.finish());
    const turn = backend.sendMessage('resume', { ...options(), isNewSession: false, externalSessionId: 'saved' });
    const first = turn.stream.next();
    await backend.shutdown();
    release(null);
    expect((await first).value).toEqual({ type: 'error', error: 'Copilot turn aborted.', source: 'abort' });
    expect(await collect(turn.stream)).toEqual([{ type: 'done' }]);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('flushes an unterminated final JSONL message and checkpoint usage when no result frame arrives', async () => {
    const backend = adapter(proc => {
      proc.stdout.write(JSON.stringify({ type: 'session.usage_checkpoint', data: {
        totalPremiumRequests: 1, accountingSnapshot: { tokenDetails: {
          input: { tokenCount: 10 }, output: { tokenCount: 5 }, cache_read: { tokenCount: 0 }, cache_write: { tokenCount: 0 },
        } },
      } }) + '\n');
      proc.stdout.write(JSON.stringify({ type: 'assistant.message', data: { messageId: 'final', content: 'complete' } }));
      proc.finish();
    });
    const events = await collect(backend.sendMessage('test', options()).stream);
    expect(events).toEqual(expect.arrayContaining([
      { type: 'text', content: 'complete', streaming: false },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, credits: 1, costUsd: 0, costSource: 'none' } },
      { type: 'done' },
    ]));
  });

  test('stdout read failures remain terminal and close the native process', async () => {
    const backend = adapter(proc => { proc.stdout.destroy(new Error('stream disconnected')); });
    const events = await collect(backend.sendMessage('test', options()).stream);
    expect(events).toEqual(expect.arrayContaining([{ type: 'error', error: 'stream disconnected' }, { type: 'done' }]));
    expect(processes[0].kill).toHaveBeenCalled();
  });

  test('rejects a path beneath a regular file before starting native work', async () => {
    const backend = adapter(proc => proc.finish());
    const file = path.join(workdir, 'regular-file');
    fs.writeFileSync(file, 'fixture');
    await expect(backend.runOneShot('test', { workingDir: path.join(file, 'child') })).rejects.toThrow('not a directory');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('does not spawn for an already-aborted one-shot signal', async () => {
    const backend = adapter(proc => proc.finish());
    const controller = new AbortController();
    controller.abort();
    await expect(backend.runOneShot('hi', { abortSignal: controller.signal })).rejects.toThrow('aborted');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('rejects non-directory one-shot workspaces before spawning', async () => {
    const file = path.join(workdir, 'file.txt');
    fs.writeFileSync(file, '');
    const backend = adapter(proc => proc.finish());
    await expect(backend.runOneShot('hi', { workingDir: file })).rejects.toThrow('not a directory');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('uses restricted one-shots for title and summary generation', async () => {
    const backend = adapter(proc => proc.finish());
    const run = jest.spyOn(backend, 'runOneShot').mockResolvedValue('  A useful\n title  ');
    expect(await backend.generateTitle('hi', 'fallback')).toBe('A useful title');
    expect(await backend.generateSummary([{ role: 'user', content: 'hi' }], 'fallback')).toBe('A useful\n title');
    expect(run).toHaveBeenCalledWith(expect.stringContaining('user: hi'), { cliProfile: undefined, timeoutMs: 60_000 });
  });

  test('preserves title and summary fallbacks on one-shot failure', async () => {
    const backend = adapter(proc => proc.finish());
    jest.spyOn(backend, 'runOneShot').mockRejectedValue(new Error('CLI unavailable'));
    expect(await backend.generateTitle('first\nmessage', '')).toBe('first message');
    expect(await backend.generateSummary([], 'saved summary')).toBe('saved summary');
  });

  test('reports in-flight abort even when the child closes cleanly', async () => {
    const result = adapter(() => {}).sendMessage('hi', options());
    await result.stream.next();
    result.abort();
    expect(await collect(result.stream)).toEqual([
      { type: 'error', error: 'Copilot turn aborted.', source: 'abort' },
      { type: 'done' },
    ]);
    expect(processes[0].kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('kills the child when the stream consumer stops', async () => {
    const result = adapter(() => {}).sendMessage('hi', options());
    await result.stream.next();
    await result.stream.return(undefined);
    expect(processes[0].kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('one-shot timeout rejects rather than accepting a clean termination', async () => {
    const backend = adapter(() => {});
    await expect(backend.runOneShot('hi', { timeoutMs: 10 })).rejects.toThrow('timed out');
    expect(processes[0].kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('one-shot abort rejects rather than accepting a clean termination', async () => {
    const controller = new AbortController();
    const backend = adapter(() => controller.abort());
    await expect(backend.runOneShot('hi', { abortSignal: controller.signal })).rejects.toThrow('aborted');
    expect(processes[0].kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('one-shot errors preserve structured diagnostics on nonzero exit', async () => {
    const backend = adapter(proc => proc.finish([{ type: 'session.error', data: { message: 'Model unavailable' } }], 1));
    await expect(backend.runOneShot('hi')).rejects.toThrow('Model unavailable');
  });

  test('stream errors preserve a failed JSON result even on zero process exit', async () => {
    const backend = adapter(proc => proc.finish([{ type: 'result', exitCode: 1, message: 'Request failed' }]));
    expect(await collect(backend.sendMessage('hi', options()).stream)).toEqual(expect.arrayContaining([
      { type: 'error', error: 'Request failed' },
      { type: 'done' },
    ]));
  });

  test.each(['stream', 'one-shot'])('preserves split UTF-8 text in %s output', async mode => {
    const text = '\u00e7\u011f\ud83d\ude80';
    const backend = adapter(proc => {
      const bytes = Buffer.from(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: text } }) + '\n');
      const split = bytes.indexOf(Buffer.from('\u00e7')) + 1;
      proc.stdout.write(bytes.subarray(0, split));
      proc.stdout.write(bytes.subarray(split));
      proc.finish([{ type: 'assistant.message', data: { content: text } }]);
    });
    if (mode === 'one-shot') {
      await expect(backend.runOneShot('hi')).resolves.toBe(text);
    } else {
      const events = await collect(backend.sendMessage('hi', options()).stream);
      expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', content: text, streaming: true }]);
    }
  });

  test('recovers a missing resumed session from JSON diagnostics exactly once', async () => {
    const backend = adapter((proc, index) => {
      if (index === 0) proc.finish([{ type: 'session.error', data: { message: 'Session not found' } }], 1);
      else proc.finish([{ type: 'result', sessionId: 'new-session', exitCode: 0 }]);
    });
    const createSnapshot = jest.fn(async () => ({
      snapshotPath: '/tmp/recovery.md', sourceSessionPath: '/tmp/session.json',
      sourceSessionNumber: 1, messageCount: 2, recoveryCount: 1,
      capturedAt: '2026-10-26T00:00:00.000Z',
    }));
    const events = await collect(backend.sendMessage('continue', {
      ...options(), isNewSession: false, externalSessionId: 'old-session', sessionRecovery: { createSnapshot },
    }).stream);
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['--resume', 'old-session']));
    expect(spawn.mock.calls[1][1]).not.toContain('--resume');
    expect(spawn.mock.calls[1][1][1]).toContain('/tmp/recovery.md');
    expect(events.filter(event => event.type === 'session_recovery')).toHaveLength(1);
    expect(events.filter(event => event.type === 'error')).toHaveLength(0);
  });

  test('does not replay a failed turn after tools have started', async () => {
    const backend = adapter(proc => {
      proc.stderr.write('Session not found');
      proc.finish([{ type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'bash' } }], 1);
    });
    const events = await collect(backend.sendMessage('continue', {
      ...options(), isNewSession: false, externalSessionId: 'old-session',
    }).stream);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === 'session_recovery')).toHaveLength(0);
    expect(events.some(event => event.type === 'error')).toBe(true);
  });

  test('stops after one missing-session recovery attempt', async () => {
    const backend = adapter(proc => proc.finish([{ type: 'session.error', data: { message: 'Session not found' } }], 1));
    const events = await collect(backend.sendMessage('continue', {
      ...options(), isNewSession: false, externalSessionId: 'old-session',
    }).stream);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(events.filter(event => event.type === 'session_recovery')).toHaveLength(1);
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
  });

  test('keeps child prose, reasoning, and tool activity out of the parent stream', async () => {
    const backend = adapter(proc => proc.finish([
      { type: 'tool.execution_start', data: { toolCallId: 'task1', toolName: 'task' } },
      { type: 'assistant.message_delta', agentId: 'child', data: { messageId: 'child1', deltaContent: 'CHILD' } },
      { type: 'assistant.message', data: { parentToolCallId: 'task1', content: 'CHILD FINAL' } },
      { type: 'assistant.reasoning_delta', agentId: 'child', data: { deltaContent: 'CHILD THINKING' } },
      { type: 'tool.execution_start', agentId: 'child', data: { toolCallId: 'child-tool', toolName: 'bash' } },
      { type: 'tool.execution_complete', agentId: 'child', data: { toolCallId: 'child-tool', success: true } },
      { type: 'assistant.message', data: { messageId: 'parent1', content: '{"answer":"PARENT"}' } },
      { type: 'result', exitCode: 0 },
    ]));
    const events = await collect(backend.sendMessage('test', options()).stream);
    expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', content: '{"answer":"PARENT"}', streaming: false }]);
    expect(events.filter(event => event.type === 'thinking')).toHaveLength(0);
    expect(events.filter(event => event.type === 'tool_activity')).toHaveLength(1);
    expect(events.filter(event => event.type === 'tool_outcomes')).toHaveLength(0);
  });

  test('suppressed child tool work still prevents automatic prompt replay', async () => {
    const backend = adapter(proc => proc.finish([
      { type: 'tool.execution_start', agentId: 'child', data: { toolCallId: 'child-tool', toolName: 'bash' } },
      { type: 'session.error', data: { message: 'Session not found' } },
    ], 1));
    const events = await collect(backend.sendMessage('test', {
      ...options(), isNewSession: false, externalSessionId: 'old-session',
    }).stream);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === 'session_recovery')).toHaveLength(0);
  });

  test('shutdown cancels unconsumed turns but leaves the adapter reusable', async () => {
    const backend = adapter(proc => proc.finish([{ type: 'assistant.message', data: { content: 'new turn' } }]));
    const old = backend.sendMessage('old', options());
    await backend.shutdown();
    expect(await collect(old.stream)).toEqual([
      { type: 'error', error: 'Copilot turn aborted.', source: 'abort' }, { type: 'done' },
    ]);
    expect(spawn).not.toHaveBeenCalled();
    expect(await collect(backend.sendMessage('new', options()).stream)).toEqual(expect.arrayContaining([
      { type: 'text', content: 'new turn', streaming: false },
    ]));
  });

  test('shutdown cancels one-shots even when the launcher closes cleanly with partial text', async () => {
    const backend = adapter(proc => {
      proc.stdout.write(JSON.stringify({ type: 'assistant.message', data: { content: 'partial' } }) + '\n');
      void backend.shutdown();
    });
    await expect(backend.runOneShot('test')).rejects.toThrow('aborted');
    expect(processes[0].kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('shutdown during summary generation preserves the supplied fallback', async () => {
    const backend = adapter(proc => {
      proc.stdout.write(JSON.stringify({ type: 'assistant.message', data: { content: 'partial' } }) + '\n');
      void backend.shutdown();
    });
    await expect(backend.generateSummary([{ role: 'user', content: 'test' }], 'saved summary')).resolves.toBe('saved summary');
  });

  test('reports asynchronous spawn failures with the install diagnostic', async () => {
    const backend = adapter(proc => {
      proc.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      proc.finish();
    });
    expect(await collect(backend.sendMessage('test', options()).stream)).toEqual(expect.arrayContaining([
      { type: 'error', error: 'GitHub Copilot CLI is not installed or is not available on PATH.' }, { type: 'done' },
    ]));
  });

  test('stream read failures stay terminal and clean up the child', async () => {
    const backend = adapter(proc => { proc.stdout.destroy(new Error('pipe failed')); });
    expect(await collect(backend.sendMessage('test', options()).stream)).toEqual(expect.arrayContaining([
      { type: 'error', error: 'pipe failed' }, { type: 'done' },
    ]));
    expect(processes[0].kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('missing-session recovery remains bounded when snapshot persistence fails', async () => {
    const backend = adapter((proc, index) => {
      if (index === 0) proc.finish([{ type: 'session.error', data: { message: 'Session not found' } }], 1);
      else proc.finish([{ type: 'assistant.message', data: { content: 'recovered' } }]);
    });
    const events = await collect(backend.sendMessage('continue', {
      ...options(), isNewSession: false, externalSessionId: 'old-session',
      sessionRecovery: { createSnapshot: async () => { throw new Error('disk full'); } },
    }).stream);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(events.filter(event => event.type === 'session_recovery')).toHaveLength(1);
    expect(events.filter(event => event.type === 'error')).toHaveLength(0);
    expect(spawn.mock.calls[1][1][1]).toContain('prior context may be incomplete');
  });

  test('permanent shutdown rejects late starts without spawning', async () => {
    const backend = adapter(proc => proc.finish());
    await backend.shutdown({ permanent: true });
    expect(await collect(backend.sendMessage('late', options()).stream)).toEqual([
      { type: 'error', error: 'Copilot turn aborted.', source: 'abort' }, { type: 'done' },
    ]);
    await expect(backend.runOneShot('late')).rejects.toThrow('shutting down');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('reusable shutdown blocks starts during its asynchronous drain', async () => {
    const backend = adapter(() => {});
    const first = backend.sendMessage('first', options());
    await first.stream.next();
    const scope = (backend as unknown as { scopes: Set<{ stop(): Promise<void> }> }).scopes.values().next().value!;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const original = scope.stop.bind(scope);
    jest.spyOn(scope, 'stop').mockImplementation(async () => { await pending; await original(); });
    const drain = backend.shutdown();
    const second = backend.sendMessage('second', options());
    expect(await collect(second.stream)).toEqual([
      { type: 'error', error: 'Copilot turn aborted.', source: 'abort' }, { type: 'done' },
    ]);
    await expect(backend.runOneShot('third')).rejects.toThrow('shutting down');
    expect(spawn).toHaveBeenCalledTimes(1);
    release();
    await drain;
    await first.stream.return(undefined);
  });

  test('spawn failure is reported without session recovery', async () => {
    const backend = adapter(() => {});
    spawn.mockImplementationOnce(() => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); });
    expect(await collect(backend.sendMessage('test', options()).stream)).toEqual([
      { type: 'error', error: 'GitHub Copilot CLI is not installed or is not available on PATH.' }, { type: 'done' },
    ]);
  });

  test('subtracts the saved native usage baseline after an adapter restart', async () => {
    const checkpoint = (input: number, output: number, credits: number) => ({
      type: 'session.usage_checkpoint',
      data: {
        totalPremiumRequests: credits,
        accountingSnapshot: { tokenDetails: {
          input: { tokenCount: input }, output: { tokenCount: output },
          cache_read: { tokenCount: 50 }, cache_write: { tokenCount: 100 },
        } },
      },
    });
    const dir = path.join(workdir, 'session-state', 'saved-session');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(checkpoint(10, 20, 2)) + '\n');
    const backend = adapter(proc => proc.finish([
      checkpoint(15, 27, 3),
      { type: 'result', sessionId: 'saved-session', exitCode: 0, usage: { premiumRequests: 3 } },
    ]));
    const events = await collect(backend.sendMessage('continue', {
      ...options(), isNewSession: false, externalSessionId: 'saved-session',
      cliProfile: copilotProfile({ env: { COPILOT_HOME: workdir } }),
    }).stream);
    expect(events.find(event => event.type === 'usage')).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0,
        credits: 1, costUsd: 0, costSource: 'none',
      },
    });
  });
});
