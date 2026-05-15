import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ClaudeCodeInteractiveAdapter } from '../src/services/backends/claudeCodeInteractive';
import {
  ClaudeInteractivePtyController,
  ensureNodePtySpawnHelperExecutable,
  findQuestionOptionIndex,
  type ClaudeInteractivePtyFactory,
} from '../src/services/backends/claudeInteractivePty';
import {
  buildClaudeInteractiveHookSettings,
  hookPayloadString,
  parseClaudeInteractiveHookLine,
  type ClaudeInteractiveHookEvent,
  type ClaudeInteractiveHookEventName,
  type ClaudeInteractiveHookHarness,
} from '../src/services/backends/claudeInteractiveHooks';
import { collectClaudeTerminalResponses } from '../src/services/backends/claudeInteractiveTerminal';
import { ClaudeTranscriptTailer } from '../src/services/backends/claudeTranscriptTailer';
import { resolveClaudeProjectDir } from '../src/services/backends/claudeCode';
import {
  buildClaudeInteractiveCompatibilityStatus,
  CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION,
} from '../src/services/backends/claudeInteractiveCompatibility';
import { mapClaudeTranscriptEntryToStreamEvents } from '../src/services/backends/claudeTranscriptEvents';
import { resolveCliProfileRuntime, serverConfiguredCliProfileId } from '../src/services/cliProfiles';
import { ChatService } from '../src/services/chatService';
import type { CliProfile, SendMessageOptions, StreamEvent } from '../src/types';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

class FakeHookHarness implements ClaudeInteractiveHookHarness {
  readonly settingsJson = '{"hooks":{"SessionStart":[],"Stop":[]}}';
  readonly env = { AGENT_COCKPIT_TEST_HOOKS: '1' };
  readonly events: AsyncIterable<ClaudeInteractiveHookEvent> = {
    [Symbol.asyncIterator]: () => this._iterateEvents(),
  };
  private readonly _seen = new Map<ClaudeInteractiveHookEventName, ClaudeInteractiveHookEvent>();
  private readonly _waiters = new Map<ClaudeInteractiveHookEventName, Array<(event: ClaudeInteractiveHookEvent) => void>>();
  private readonly _events: ClaudeInteractiveHookEvent[] = [];
  private readonly _eventWaiters: Array<() => void> = [];
  private _closed = false;

  constructor(started = true) {
    if (started) this.emit('SessionStart');
  }

  waitForSessionStart(_timeoutMs?: number): Promise<ClaudeInteractiveHookEvent> {
    return this._waitFor('SessionStart');
  }

  waitForStop(_timeoutMs?: number): Promise<ClaudeInteractiveHookEvent> {
    return this._waitFor('Stop');
  }

  async close(): Promise<void> {
    this._closed = true;
    for (const resolve of this._eventWaiters.splice(0)) resolve();
  }

  emit(event: ClaudeInteractiveHookEventName, payload: Record<string, unknown> = {}): void {
    const hookEvent = { event, payload, rawPayload: JSON.stringify(payload) };
    this._seen.set(event, hookEvent);
    this._events.push(hookEvent);
    for (const resolve of this._eventWaiters.splice(0)) resolve();
    const waiters = this._waiters.get(event) || [];
    this._waiters.delete(event);
    for (const resolve of waiters) resolve(hookEvent);
  }

  private _waitFor(event: ClaudeInteractiveHookEventName): Promise<ClaudeInteractiveHookEvent> {
    const seen = this._seen.get(event);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => {
      const waiters = this._waiters.get(event) || [];
      waiters.push(resolve);
      this._waiters.set(event, waiters);
    });
  }

  private async *_iterateEvents(): AsyncIterator<ClaudeInteractiveHookEvent> {
    let index = 0;
    while (!this._closed || index < this._events.length) {
      if (index < this._events.length) {
        yield this._events[index];
        index += 1;
        continue;
      }
      await new Promise<void>((resolve) => {
        this._eventWaiters.push(resolve);
      });
    }
  }
}

function claudeProfile(configDir: string, protocol: CliProfile['protocol'] = 'standard'): CliProfile {
  return {
    id: 'server-configured-claude-code',
    name: 'Claude Code (Server Configured)',
    vendor: 'claude-code',
    protocol,
    authMode: 'server-configured',
    command: 'claude-test',
    configDir,
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
  };
}

function sendOptions(workspace: string, profile: CliProfile): SendMessageOptions {
  return {
    sessionId: 'session-1',
    conversationId: 'conv-1',
    cliProfileId: profile.id,
    cliProfile: profile,
    isNewSession: true,
    workingDir: workspace,
    systemPrompt: 'System prompt',
  };
}

describe('ClaudeCodeInteractiveAdapter', () => {
  test('ignores synthetic no-response transcript entries from local exit commands', () => {
    const events = mapClaudeTranscriptEntryToStreamEvents({
      type: 'assistant',
      message: {
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'No response requested.' }],
      },
    } as any);

    expect(events).toEqual([]);
  });

  test('maps Claude local goal clear output to a goal_cleared event', () => {
    const events = mapClaudeTranscriptEntryToStreamEvents({
      type: 'system',
      subtype: 'local_command',
      sessionId: 'session-1',
      content: '<local-command-stdout>Goal cleared: Ship the feature.</local-command-stdout>',
    });

    expect(events).toEqual([{ type: 'goal_cleared', threadId: 'session-1' }]);
  });

  test('declares a separate backend that shares Claude Code capabilities', () => {
    const adapter = new ClaudeCodeInteractiveAdapter({ workingDir: '/tmp/workspace' });
    expect(adapter.metadata).toMatchObject({
      id: 'claude-code-interactive',
      label: 'Claude Code Interactive',
      capabilities: {
        thinking: true,
        agents: true,
        userQuestions: true,
        stdinInput: true,
        goals: {
          set: true,
          clear: true,
          pause: false,
          resume: false,
          status: 'transcript',
        },
      },
      resumeCapabilities: {
        activeTurnResume: 'unsupported',
        sessionResume: 'supported',
      },
    });
    expect(adapter.metadata.models?.length).toBeGreaterThan(0);
  });

  test('streams transcript JSONL from a hidden PTY turn', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interactive-'));
    const workspace = path.join(tmp, 'workspace');
    const configDir = path.join(tmp, 'claude');
    fs.mkdirSync(workspace, { recursive: true });
    const transcriptDir = resolveClaudeProjectDir(workspace, configDir)!;
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, 'session-1.jsonl');

    let capturedArgs: string[] = [];
    let capturedCwd: string | undefined;
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | null = null;
    let wrotePrompt = false;
    const writes: string[] = [];
    const hookHarness = new FakeHookHarness();
    const factory: ClaudeInteractivePtyFactory = (_command, args, options) => {
      capturedArgs = args;
      capturedCwd = options.cwd;
      return {
        pid: 4321,
        write(data: string | Buffer) {
          const value = String(data);
          writes.push(value);
          if (!wrotePrompt && value === '\x1b[200~Hello\x1b[201~') {
            wrotePrompt = true;
            setTimeout(() => {
              fs.writeFileSync(transcriptPath, [
                JSON.stringify({
                  uuid: 'assistant-1',
                  type: 'assistant',
                  sessionId: 'session-1',
                  entrypoint: 'cli',
                  message: {
                    role: 'assistant',
                    model: 'claude-sonnet-4-6',
                    usage: {
                      input_tokens: 10,
                      output_tokens: 5,
                      cache_read_input_tokens: 2,
                      cache_creation_input_tokens: 1,
                    },
                    content: [
                      { type: 'text', text: 'Hi there' },
                      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: path.join(workspace, 'app.ts') } },
                    ],
                  },
                  cost_usd: 0.01,
                }),
                JSON.stringify({
                  uuid: 'user-1',
                  type: 'user',
                  sessionId: 'session-1',
                  entrypoint: 'cli',
                  message: {
                    role: 'user',
                    content: [
                      { type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' },
                    ],
                  },
                }),
                JSON.stringify({
                  uuid: 'done-1',
                  type: 'system',
                  subtype: 'turn_duration',
                  sessionId: 'session-1',
                  entrypoint: 'cli',
                }),
              ].join('\n') + '\n');
              onExit?.({ exitCode: 0 });
            }, 10);
          }
        },
        kill() {},
        onData() { return { dispose() {} }; },
        onExit(listener) {
          onExit = listener;
          return { dispose() {} };
        },
      };
    };

    const adapter = new ClaudeCodeInteractiveAdapter({
      workingDir: workspace,
      ptyFactory: factory,
      hookFactory: async () => hookHarness,
      pollIntervalMs: 5,
      exitGraceMs: 0,
      exitSettleMs: 0,
      promptReadyDelayMs: 0,
      promptEnterDelayMs: 1,
    });
    const result = adapter.sendMessage('Hello', sendOptions(workspace, claudeProfile(configDir)));
    const events: StreamEvent[] = [];
    for await (const event of result.stream) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(capturedCwd).toBe(workspace);
    expect(capturedArgs).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions', '--session-id', 'session-1', '--append-system-prompt', 'System prompt']));
    expect(capturedArgs).toEqual(expect.arrayContaining(['--settings', hookHarness.settingsJson]));
    expect(capturedArgs).not.toContain('-p');
    expect(writes).toContain('\x1b[200~Hello\x1b[201~');
    expect(writes).toContain('\r');
    expect(events).toEqual(expect.arrayContaining([
      { type: 'backend_runtime', processId: 4321 },
      { type: 'text', content: 'Hi there' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, costUsd: 0.01 }, model: 'claude-sonnet-4-6' },
      expect.objectContaining({ type: 'tool_activity', tool: 'Read', id: 'tool-1' }),
      expect.objectContaining({ type: 'tool_outcomes' }),
      { type: 'turn_boundary' },
      { type: 'done' },
    ]));

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('clearGoal returns after Claude writes local goal clear output', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interactive-clear-goal-'));
    const workspace = path.join(tmp, 'workspace');
    const configDir = path.join(tmp, 'claude');
    fs.mkdirSync(workspace, { recursive: true });
    const transcriptDir = resolveClaudeProjectDir(workspace, configDir)!;
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, 'session-1.jsonl');
    const hookHarness = new FakeHookHarness();
    const writes: string[] = [];
    let wroteClear = false;
    const factory: ClaudeInteractivePtyFactory = () => ({
      pid: 7654,
      write(data: string | Buffer) {
        const value = String(data);
        writes.push(value);
        if (!wroteClear && value === '\x1b[200~/goal clear\x1b[201~') {
          wroteClear = true;
          setTimeout(() => {
            fs.writeFileSync(transcriptPath, JSON.stringify({
              uuid: 'goal-clear',
              type: 'system',
              subtype: 'local_command',
              sessionId: 'session-1',
              content: '<local-command-stdout>Goal cleared: Ship the feature.</local-command-stdout>',
            }) + '\n');
          }, 5);
        }
      },
      kill() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
    });

    const adapter = new ClaudeCodeInteractiveAdapter({
      workingDir: workspace,
      ptyFactory: factory,
      hookFactory: async () => hookHarness,
      pollIntervalMs: 5,
      exitGraceMs: 0,
      exitSettleMs: 0,
      promptReadyDelayMs: 0,
      promptEnterDelayMs: 1,
    });

    await expect(adapter.clearGoal(sendOptions(workspace, claudeProfile(configDir))))
      .resolves.toEqual({ cleared: true, sessionId: 'session-1' });
    expect(writes).toContain('\x1b[200~/goal clear\x1b[201~');
    expect(writes).toContain('/exit\r');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('clearGoal rejects when Claude exits without goal clear confirmation', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interactive-clear-goal-missing-'));
    const workspace = path.join(tmp, 'workspace');
    const configDir = path.join(tmp, 'claude');
    fs.mkdirSync(workspace, { recursive: true });
    const transcriptDir = resolveClaudeProjectDir(workspace, configDir)!;
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, 'session-1.jsonl');
    const hookHarness = new FakeHookHarness();
    let wroteClear = false;
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | null = null;
    const factory: ClaudeInteractivePtyFactory = () => ({
      pid: 7655,
      write(data: string | Buffer) {
        if (!wroteClear && String(data) === '\x1b[200~/goal clear\x1b[201~') {
          wroteClear = true;
          setTimeout(() => {
            fs.writeFileSync(transcriptPath, JSON.stringify({
              uuid: 'done-without-clear',
              type: 'system',
              subtype: 'turn_duration',
              sessionId: 'session-1',
            }) + '\n');
            onExit?.({ exitCode: 0 });
          }, 5);
        }
      },
      kill() {},
      onData() { return { dispose() {} }; },
      onExit(listener) {
        onExit = listener;
        return { dispose() {} };
      },
    });

    const adapter = new ClaudeCodeInteractiveAdapter({
      workingDir: workspace,
      ptyFactory: factory,
      hookFactory: async () => hookHarness,
      pollIntervalMs: 5,
      exitGraceMs: 0,
      exitSettleMs: 0,
      promptReadyDelayMs: 0,
      promptEnterDelayMs: 1,
    });

    await expect(adapter.clearGoal(sendOptions(workspace, claudeProfile(configDir))))
      .rejects.toThrow('Claude Code Interactive goal clear did not confirm completion');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('waits for SessionStart before submitting the prompt', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interactive-ready-'));
    const workspace = path.join(tmp, 'workspace');
    const configDir = path.join(tmp, 'claude');
    fs.mkdirSync(resolveClaudeProjectDir(workspace, configDir)!, { recursive: true });
    const transcriptPath = path.join(resolveClaudeProjectDir(workspace, configDir)!, 'session-1.jsonl');
    const hookHarness = new FakeHookHarness(false);
    const writes: string[] = [];
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | null = null;
    const factory: ClaudeInteractivePtyFactory = () => ({
      pid: 9876,
      write(data: string | Buffer) {
        const value = String(data);
        writes.push(value);
        if (value === '\x1b[200~Hello\x1b[201~') {
          fs.writeFileSync(transcriptPath, JSON.stringify({
            uuid: 'done-1',
            type: 'system',
            subtype: 'turn_duration',
            sessionId: 'session-1',
          }) + '\n');
          setTimeout(() => onExit?.({ exitCode: 0 }), 5);
        }
      },
      kill() {},
      onData() { return { dispose() {} }; },
      onExit(listener) {
        onExit = listener;
        return { dispose() {} };
      },
    });

    const adapter = new ClaudeCodeInteractiveAdapter({
      workingDir: workspace,
      ptyFactory: factory,
      hookFactory: async () => hookHarness,
      pollIntervalMs: 5,
      exitGraceMs: 0,
      exitSettleMs: 0,
      promptReadyDelayMs: 0,
      promptEnterDelayMs: 1,
    });
    const result = adapter.sendMessage('Hello', sendOptions(workspace, claudeProfile(configDir)));
    const iterator = result.stream[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: 'backend_runtime', processId: 9876 });
    result.sendInput?.('queued answer');
    await sleep(5);
    expect(writes).not.toContain('\x1b[200~Hello\x1b[201~');
    expect(writes).not.toContain('queued answer\r');
    hookHarness.emit('SessionStart');

    const events: StreamEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === 'done') break;
    }

    expect(writes).toContain('\x1b[200~Hello\x1b[201~');
    expect(writes.indexOf('\x1b[200~Hello\x1b[201~')).toBeLessThan(writes.indexOf('queued answer\r'));
    expect(events).toContainEqual({ type: 'done' });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('surfaces AskUserQuestion from the PreToolUse hook before transcript flush', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interactive-question-hook-'));
    const workspace = path.join(tmp, 'workspace');
    const configDir = path.join(tmp, 'claude');
    fs.mkdirSync(resolveClaudeProjectDir(workspace, configDir)!, { recursive: true });
    const transcriptPath = path.join(resolveClaudeProjectDir(workspace, configDir)!, 'session-1.jsonl');
    const hookHarness = new FakeHookHarness();
    const writes: string[] = [];
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | null = null;
    let sawQuestionDownArrow = false;
    const factory: ClaudeInteractivePtyFactory = () => ({
      pid: 2468,
      write(data: string | Buffer) {
        const value = String(data);
        writes.push(value);
        if (value === '\x1b[200~Hello\x1b[201~') {
          setTimeout(() => hookHarness.emit('PreToolUse', {
            tool_name: 'AskUserQuestion',
            tool_use_id: 'tool-question',
            tool_input: {
              questions: [{
                question: 'Choose the E2E option.',
                options: [{ label: 'Alpha' }, { label: 'Beta' }],
              }],
            },
          }), 5);
        }
        if (value === '\x1b[B') sawQuestionDownArrow = true;
        if (sawQuestionDownArrow && value === '\r') {
          fs.writeFileSync(transcriptPath, JSON.stringify({
            uuid: 'done-1',
            type: 'system',
            subtype: 'turn_duration',
            sessionId: 'session-1',
          }) + '\n');
          setTimeout(() => onExit?.({ exitCode: 0 }), 1);
        }
      },
      kill() {},
      onData() { return { dispose() {} }; },
      onExit(listener) {
        onExit = listener;
        return { dispose() {} };
      },
    });

    const adapter = new ClaudeCodeInteractiveAdapter({
      workingDir: workspace,
      ptyFactory: factory,
      hookFactory: async () => hookHarness,
      pollIntervalMs: 5,
      exitGraceMs: 0,
      exitSettleMs: 0,
      promptReadyDelayMs: 0,
      promptEnterDelayMs: 1,
    });
    const result = adapter.sendMessage('Hello', sendOptions(workspace, claudeProfile(configDir)));
    const iterator = result.stream[Symbol.asyncIterator]();
    let questionEvent: StreamEvent | null = null;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === 'tool_activity' && next.value.isQuestion) {
        questionEvent = next.value;
        break;
      }
    }

    expect(questionEvent).toEqual(expect.objectContaining({
      type: 'tool_activity',
      tool: 'AskUserQuestion',
      id: 'tool-question',
      isQuestion: true,
      questions: [{ question: 'Choose the E2E option.', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
    }));
    result.sendInput?.('Beta');

    const remaining: StreamEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
      if (next.value.type === 'done') break;
    }

    expect(writes).toContain('\x1b[B');
    expect(remaining).toContainEqual({ type: 'done' });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('uses Stop hook transcript path and retries final transcript reads', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interactive-stop-'));
    const workspace = path.join(tmp, 'workspace');
    const configDir = path.join(tmp, 'claude');
    const transcriptPath = path.join(tmp, 'hook-transcript.jsonl');
    fs.mkdirSync(workspace, { recursive: true });
    const hookHarness = new FakeHookHarness();
    const factory: ClaudeInteractivePtyFactory = () => ({
      pid: 2222,
      write(data: string | Buffer) {
        if (String(data) !== '\x1b[200~Hello\x1b[201~') return;
        setTimeout(() => hookHarness.emit('Stop', { transcript_path: transcriptPath }), 1);
        setTimeout(() => {
          fs.writeFileSync(transcriptPath, JSON.stringify({
            uuid: 'assistant-final',
            type: 'assistant',
            sessionId: 'session-1',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Final after stop' }] },
          }) + '\n');
        }, 8);
      },
      kill() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
    });

    const adapter = new ClaudeCodeInteractiveAdapter({
      workingDir: workspace,
      ptyFactory: factory,
      hookFactory: async () => hookHarness,
      pollIntervalMs: 2,
      exitGraceMs: 0,
      exitSettleMs: 0,
      promptReadyDelayMs: 0,
      promptEnterDelayMs: 1,
      finalTranscriptReadAttempts: 10,
      finalTranscriptReadIntervalMs: 5,
    });

    const events: StreamEvent[] = [];
    for await (const event of adapter.sendMessage('Hello', sendOptions(workspace, claudeProfile(configDir))).stream) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events).toContainEqual({ type: 'text', content: 'Final after stop' });
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('uses Stop hook last assistant message only as an empty-transcript fallback', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interactive-fallback-'));
    const workspace = path.join(tmp, 'workspace');
    const configDir = path.join(tmp, 'claude');
    fs.mkdirSync(workspace, { recursive: true });
    const hookHarness = new FakeHookHarness();
    const factory: ClaudeInteractivePtyFactory = () => ({
      pid: 3333,
      write(data: string | Buffer) {
        if (String(data) === '\x1b[200~Hello\x1b[201~') {
          setTimeout(() => hookHarness.emit('Stop', {
            transcript_path: path.join(tmp, 'missing.jsonl'),
            last_assistant_message: 'Fallback answer',
          }), 1);
        }
      },
      kill() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
    });

    const adapter = new ClaudeCodeInteractiveAdapter({
      workingDir: workspace,
      ptyFactory: factory,
      hookFactory: async () => hookHarness,
      pollIntervalMs: 2,
      exitGraceMs: 0,
      exitSettleMs: 0,
      promptReadyDelayMs: 0,
      promptEnterDelayMs: 1,
      finalTranscriptReadAttempts: 2,
      finalTranscriptReadIntervalMs: 1,
    });

    const events: StreamEvent[] = [];
    for await (const event of adapter.sendMessage('Hello', sendOptions(workspace, claudeProfile(configDir))).stream) {
      events.push(event);
      if (event.type === 'done') break;
    }

    expect(events).toContainEqual({ type: 'text', content: 'Fallback answer' });
    expect(events.filter(event => event.type === 'text')).toHaveLength(1);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('ClaudeTranscriptTailer', () => {
  test('reads from the beginning when a transcript file is created after tailing starts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transcript-'));
    const workspace = path.join(tmp, 'workspace');
    const configDir = path.join(tmp, 'claude');
    fs.mkdirSync(resolveClaudeProjectDir(workspace, configDir)!, { recursive: true });
    const transcriptPath = path.join(resolveClaudeProjectDir(workspace, configDir)!, 'session-1.jsonl');
    const tailer = new ClaudeTranscriptTailer({ workspacePath: workspace, configDir, sessionId: 'session-1', startAtEnd: true });

    expect(await tailer.readAvailable()).toEqual([]);
    await fsp.writeFile(transcriptPath, JSON.stringify({
      uuid: 'first',
      type: 'assistant',
      sessionId: 'session-1',
      message: { content: [{ type: 'text', text: 'first line' }] },
    }) + '\n');
    await sleep(5);

    const entries = await tailer.readAvailable();
    expect(entries).toHaveLength(1);
    expect(entries[0].uuid).toBe('first');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('discovers long-path Claude project directories created after tailing starts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transcript-long-'));
    const workspace = path.join(tmp, `workspace-${'x'.repeat(220)}`);
    const configDir = path.join(tmp, 'claude');
    const sessionId = 'session-long';
    fs.mkdirSync(workspace, { recursive: true });

    const tailer = new ClaudeTranscriptTailer({ workspacePath: workspace, configDir, sessionId, startAtEnd: true });
    expect(await tailer.readAvailable()).toEqual([]);

    const sanitized = workspace.replace(/[^a-zA-Z0-9]/g, '-');
    const projectDir = path.join(configDir, 'projects', `${sanitized.slice(0, 200)}-hash`);
    fs.mkdirSync(projectDir, { recursive: true });
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    await fsp.writeFile(transcriptPath, JSON.stringify({
      uuid: 'long-path-question',
      type: 'assistant',
      sessionId,
      message: {
        content: [{
          type: 'tool_use',
          id: 'question-1',
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] },
        }],
      },
    }) + '\n');

    const entries = await tailer.readAvailable();
    expect(tailer.transcriptPath).toBe(transcriptPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].uuid).toBe('long-path-question');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('reads a complete final JSON object before Claude appends the trailing newline', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transcript-buffer-'));
    const workspace = path.join(tmp, 'workspace');
    const configDir = path.join(tmp, 'claude');
    fs.mkdirSync(resolveClaudeProjectDir(workspace, configDir)!, { recursive: true });
    const transcriptPath = path.join(resolveClaudeProjectDir(workspace, configDir)!, 'session-1.jsonl');
    const tailer = new ClaudeTranscriptTailer({ workspacePath: workspace, configDir, sessionId: 'session-1', startAtEnd: true });

    expect(await tailer.readAvailable()).toEqual([]);
    await fsp.writeFile(transcriptPath, JSON.stringify({
      uuid: 'plan-exit',
      type: 'assistant',
      sessionId: 'session-1',
      message: {
        content: [{
          type: 'tool_use',
          id: 'plan-1',
          name: 'ExitPlanMode',
          input: { plan: 'Approve this plan' },
        }],
      },
    }));

    const entries = await tailer.readAvailable();
    expect(entries).toHaveLength(1);
    expect(entries[0].uuid).toBe('plan-exit');
    await fsp.appendFile(transcriptPath, '\n');
    expect(await tailer.readAvailable()).toEqual([]);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('Claude interactive helpers', () => {
  test('responds to Claude terminal capability queries', () => {
    expect(collectClaudeTerminalResponses('\x1b[c')).toEqual(['\x1b[?1;2c']);
    expect(collectClaudeTerminalResponses('\x1b[>c')).toEqual(['\x1b[>0;0;0c']);
    expect(collectClaudeTerminalResponses('\x1b[6n')).toEqual(['\x1b[1;1R']);
    expect(collectClaudeTerminalResponses('\x1b[>q')[0]).toBe('\x1bP>|AgentCockpit\x1b\\');
    expect(collectClaudeTerminalResponses('\x1b[18t', { rows: 24, cols: 80 })).toEqual(['\x1b[8;24;80t']);
    expect(collectClaudeTerminalResponses(`hello\x1b[cthere\x1b[>0c`)).toEqual(['\x1b[?1;2c', '\x1b[>0;0;0c']);
    expect(collectClaudeTerminalResponses('\x1b[')).toEqual([]);
  });

  test('parses Claude hook settings and payloads', () => {
    const settings = JSON.parse(buildClaudeInteractiveHookSettings('/tmp/hook path/hook.sh'));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("'/tmp/hook path/hook.sh' SessionStart");
    expect(settings.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(' PreToolUse');
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(' Stop');
    expect(settings.hooks.PostToolUse).toBeUndefined();

    const diagnosticSettings = JSON.parse(buildClaudeInteractiveHookSettings('/tmp/hook path/hook.sh', { diagnosticEvents: true }));
    expect(diagnosticSettings.hooks.PreToolUse[0].matcher).toBe('*');
    expect(diagnosticSettings.hooks.PostToolUse[0].hooks[0].command).toContain(' PostToolUse');
    expect(diagnosticSettings.hooks.PermissionRequest[0].hooks[0].command).toContain(' PermissionRequest');
    expect(diagnosticSettings.hooks.PermissionDenied[0].hooks[0].command).toContain(' PermissionDenied');
    expect(diagnosticSettings.hooks.SubagentStart[0].hooks[0].command).toContain(' SubagentStart');
    expect(diagnosticSettings.hooks.SubagentStop[0].hooks[0].command).toContain(' SubagentStop');
    expect(parseClaudeInteractiveHookLine('PreToolUse\t{"tool_name":"AskUserQuestion"}\n')?.event).toBe('PreToolUse');
    expect(parseClaudeInteractiveHookLine('PermissionDenied\t{"tool_name":"Bash"}\n')?.event).toBe('PermissionDenied');
    expect(parseClaudeInteractiveHookLine('SubagentStop\t{"agent_transcript_path":"/tmp/agent.jsonl"}\n')?.event).toBe('SubagentStop');
    const event = parseClaudeInteractiveHookLine('Stop\t{"transcript_path":"/tmp/session.jsonl","last_assistant_message":"done"}\n');
    expect(event).toMatchObject({ event: 'Stop' });
    expect(hookPayloadString(event, 'transcript_path')).toBe('/tmp/session.jsonl');
    expect(hookPayloadString(event, 'last_assistant_message')).toBe('done');
    expect(parseClaudeInteractiveHookLine('malformed')).toBeNull();
    expect(parseClaudeInteractiveHookLine('Stop\t{')).toBeNull();
  });

  test('writes terminal query responses and buffered trust confirmations through the PTY', async () => {
    const listeners: { onData?: (data: string) => void } = {};
    const writes: string[] = [];
    const controller = new ClaudeInteractivePtyController({
      command: 'claude-test',
      args: [],
      cwd: '/tmp/workspace',
      env: {},
      factory: () => ({
        pid: 1234,
        write(data: string | Buffer) { writes.push(String(data)); },
        kill() {},
        onData(listener) {
          listeners.onData = listener;
          return { dispose() {} };
        },
        onExit() { return { dispose() {} }; },
      }),
    });

    controller.start();
    listeners.onData?.('\x1b[c');
    await Promise.resolve();
    expect(writes).toContain('\x1b[?1;2c');

    listeners.onData?.('Do you tru');
    listeners.onData?.('st the files in this folder?');
    await Promise.resolve();
    expect(writes).toContain('\r');
  });

  test('auto-confirms current Claude trust screen with cursor-moved words', async () => {
    const listeners: { onData?: (data: string) => void } = {};
    const writes: string[] = [];
    const controller = new ClaudeInteractivePtyController({
      command: 'claude-test',
      args: [],
      cwd: '/tmp/workspace',
      env: {},
      factory: () => ({
        pid: 1234,
        write(data: string | Buffer) { writes.push(String(data)); },
        kill() {},
        onData(listener) {
          listeners.onData = listener;
          return { dispose() {} };
        },
        onExit() { return { dispose() {} }; },
      }),
    });

    controller.start();
    listeners.onData?.('Quick\x1b[1Csafety\x1b[1Ccheck:\x1b[1CIs\x1b[1Cthis\x1b[1Ca\x1b[1Cproject\x1b[1Cyou\x1b[1Ctrust?');
    listeners.onData?.('❯\x1b[1C1.\x1b[1CYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder');
    listeners.onData?.('Claude\x1b[1CCode\\\'ll\x1b[1Cbe\x1b[1Cable\x1b[1Cto\x1b[1Cread,\x1b[1Cedit,\x1b[1Cand\x1b[1Cexecute\x1b[1Cfiles\x1b[1Chere.');
    await Promise.resolve();
    expect(writes).toContain('\r');
  });

  test('does not auto-confirm non-trust permission text', async () => {
    const listeners: { onData?: (data: string) => void } = {};
    const writes: string[] = [];
    const controller = new ClaudeInteractivePtyController({
      command: 'claude-test',
      args: [],
      cwd: '/tmp/workspace',
      env: {},
      factory: () => ({
        pid: 1234,
        write(data: string | Buffer) { writes.push(String(data)); },
        kill() {},
        onData(listener) {
          listeners.onData = listener;
          return { dispose() {} };
        },
        onExit() { return { dispose() {} }; },
      }),
    });

    controller.start();
    listeners.onData?.('Permission required to run Bash command');
    await Promise.resolve();
    expect(writes).not.toContain('\r');
  });

  test('maps user answers to question option indexes', () => {
    expect(findQuestionOptionIndex('2', ['Alpha', 'Beta'])).toBe(1);
    expect(findQuestionOptionIndex('beta', ['Alpha', 'Beta'])).toBe(1);
    expect(findQuestionOptionIndex('beta', [{ label: 'Alpha' }, { label: 'Beta', description: 'Beta option' }])).toBe(1);
    expect(findQuestionOptionIndex('missing', ['Alpha', 'Beta'])).toBeNull();
  });

  test('repairs node-pty spawn-helper executable permissions', () => {
    if (process.platform === 'win32') return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-helper-'));
    const helperDir = path.join(tmp, 'prebuilds', `${process.platform}-${process.arch}`);
    fs.mkdirSync(helperDir, { recursive: true });
    const helperPath = path.join(helperDir, 'spawn-helper');
    fs.writeFileSync(helperPath, '#!/bin/sh\n');
    fs.chmodSync(helperPath, 0o644);

    ensureNodePtySpawnHelperExecutable(tmp);

    expect(fs.statSync(helperPath).mode & 0o111).not.toBe(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('warns when installed Claude Code is newer than the tested interactive version', () => {
    const status = buildClaudeInteractiveCompatibilityStatus('claude', '99.0.0');
    expect(status).toMatchObject({
      providerId: 'claude-code-interactive',
      currentVersion: '99.0.0',
      testedVersion: CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION,
      status: 'newer',
      severity: 'warning',
    });
    expect(status.message).toContain('newer than the version Agent Cockpit currently supports');
    expect(status.message).toContain('Standard mode is fully supported');
    expect(status.message).toContain('https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan');
  });

  test('resolves Claude Code Interactive backend through the shared Claude CLI profile', () => {
    const profile = claudeProfile('/tmp/claude-config', 'interactive');
    const resolved = resolveCliProfileRuntime({
      theme: 'system',
      sendBehavior: 'enter',
      systemPrompt: '',
      defaultBackend: 'claude-code-interactive',
      defaultCliProfileId: serverConfiguredCliProfileId('claude-code'),
      cliProfiles: [profile],
    }, profile.id, 'claude-code-interactive');

    expect(resolved.error).toBeUndefined();
    expect(resolved.runtime).toMatchObject({
      backendId: 'claude-code-interactive',
      cliProfileId: profile.id,
      profile: expect.objectContaining({ vendor: 'claude-code' }),
    });
  });

  test('creates conversations with the interactive provider on the shared Claude profile', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interactive-chat-'));
    const service = new ChatService(tmp, { defaultWorkspace: '/tmp/claude-interactive-workspace' });
    await service.initialize();
    const settings = await service.getSettings();
    await service.saveSettings({
      ...settings,
      defaultBackend: 'claude-code-interactive',
      defaultCliProfileId: serverConfiguredCliProfileId('claude-code'),
      cliProfiles: (settings.cliProfiles || []).map(profile => (
        profile.id === serverConfiguredCliProfileId('claude-code')
          ? { ...profile, protocol: 'interactive' }
          : profile
      )),
    });

    const conv = await service.createConversation(
      'Interactive',
      '/tmp/claude-interactive-workspace',
      undefined,
      undefined,
      undefined,
      serverConfiguredCliProfileId('claude-code'),
    );

    expect(conv.backend).toBe('claude-code-interactive');
    expect(conv.cliProfileId).toBe(serverConfiguredCliProfileId('claude-code'));

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
