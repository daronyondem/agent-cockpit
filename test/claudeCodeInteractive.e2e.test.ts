import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { ClaudeCodeInteractiveAdapter } from '../src/services/backends/claudeCodeInteractive';
import { CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION } from '../src/services/backends/claudeInteractiveCompatibility';
import { resolveClaudeProjectDirCandidates } from '../src/services/backends/claudeCode';
import {
  createClaudeInteractiveHookHarness,
  type ClaudeInteractiveHookEvent,
  type ClaudeInteractiveHookEventName,
  type ClaudeInteractiveHookHarness,
} from '../src/services/backends/claudeInteractiveHooks';
import type {
  BackendRuntimeEvent,
  CliProfile,
  SendMessageOptions,
  StreamEvent,
  ThreadGoal,
} from '../src/types';

const runE2E = process.env.CLAUDE_INTERACTIVE_E2E === '1' ? describe : describe.skip;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_ARTIFACT_ROOT = process.env.CLAUDE_INTERACTIVE_E2E_ARTIFACT_DIR || null;

function claudeProfile(configDir?: string): CliProfile {
  return {
    id: 'e2e-claude-code',
    name: 'Claude Code E2E',
    vendor: 'claude-code',
    protocol: 'interactive',
    authMode: 'server-configured',
    command: 'claude',
    ...(configDir ? { configDir } : {}),
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
  };
}

interface ScenarioContext {
  name: string;
  tmp: string;
  workspace: string;
  sessionId: string;
  conversationId: string;
  profile: CliProfile;
  adapter: ClaudeCodeInteractiveAdapter;
  artifactDir: string | null;
  hookEvents: ClaudeInteractiveHookEvent[];
}

interface ScenarioOptions {
  recordHooks?: boolean;
}

function sendOptions(ctx: ScenarioContext, isNewSession = true): SendMessageOptions {
  return {
    sessionId: ctx.sessionId,
    conversationId: ctx.conversationId,
    cliProfileId: ctx.profile.id,
    cliProfile: ctx.profile,
    isNewSession,
    workingDir: ctx.workspace,
    systemPrompt: 'Keep responses exact and short. Follow file/tool instructions literally.',
  };
}

runE2E('Claude Code Interactive real CLI compatibility', () => {
  jest.setTimeout(DEFAULT_TIMEOUT_MS);

  let cliVersion = '';

  beforeAll(async () => {
    cliVersion = await readClaudeVersion();
    if (!cliVersion) {
      throw new Error('CLAUDE_INTERACTIVE_E2E=1 requires an installed/authenticated `claude` CLI on PATH.');
    }
    writeRunMetadata(cliVersion);
  });

  test('smoke: streams a tiny real Claude Code Interactive turn', async () => {
    await withScenario('smoke', async (ctx) => {
      const token = sentinel('AC_INTERACTIVE_SMOKE');
      const events = await collectWithTimeout(
        ctx.adapter.sendMessage(`Reply with exactly this token and nothing else: ${token}`, sendOptions(ctx)).stream,
        90_000,
      );

      expect(events.some(isBackendRuntimeWithPid)).toBe(true);
      expect(textContent(events)).toContain(token);
      expect(doneCount(events)).toBe(1);
      expectNoRawTerminal(events);
      await writeScenarioArtifacts(ctx, events);
    });
  });

  test('resume: sends an immediate follow-up through the same Claude session', async () => {
    await withScenario('resume-follow-up', async (ctx) => {
      const firstToken = sentinel('AC_INTERACTIVE_RESUME_FIRST');
      const secondToken = sentinel('AC_INTERACTIVE_RESUME_SECOND');
      const firstEvents = await collectWithTimeout(
        ctx.adapter.sendMessage(`Reply with exactly this token and nothing else: ${firstToken}`, sendOptions(ctx)).stream,
        90_000,
      );
      const secondEvents = await collectWithTimeout(
        ctx.adapter.sendMessage(`Reply with exactly this token and nothing else: ${secondToken}`, sendOptions(ctx, false)).stream,
        90_000,
      );

      expect(textContent(firstEvents)).toContain(firstToken);
      expect(textContent(secondEvents)).toContain(secondToken);
      expect(textContent(secondEvents)).not.toContain('No response requested.');
      expect(doneCount(firstEvents)).toBe(1);
      expect(doneCount(secondEvents)).toBe(1);
      await writeScenarioArtifacts(ctx, [...firstEvents, ...secondEvents]);
    });
  });

  test('tools: reads and writes workspace files through real Claude Code tools', async () => {
    await withScenario('file-tools', async (ctx) => {
      const inputToken = sentinel('AC_INTERACTIVE_FILE_INPUT');
      const outputToken = sentinel('AC_INTERACTIVE_FILE_OUTPUT');
      fs.writeFileSync(path.join(ctx.workspace, 'input.txt'), `${inputToken}\n`);

      const events = await collectWithTimeout(
        ctx.adapter.sendMessage([
          'Use Claude Code filesystem tools.',
          'Read input.txt.',
          `Create output.txt containing exactly this token and nothing else: ${outputToken}`,
          `Then reply with exactly this token and nothing else: ${outputToken}`,
        ].join('\n'), sendOptions(ctx)).stream,
        120_000,
      );

      expect(textContent(events)).toContain(outputToken);
      expect(fs.readFileSync(path.join(ctx.workspace, 'output.txt'), 'utf8').trim()).toBe(outputToken);
      expect(events.some(event => event.type === 'tool_activity')).toBe(true);
      expect(events.some(event => event.type === 'tool_outcomes')).toBe(true);
      await writeScenarioArtifacts(ctx, events);
    });
  });

  test('tools: runs a shell command and reconstructs tool activity', async () => {
    await withScenario('shell-tool', async (ctx) => {
      const token = sentinel('AC_INTERACTIVE_SHELL');
      const events = await collectWithTimeout(
        ctx.adapter.sendMessage([
          'Use Bash to run this exact command:',
          `printf '${token}'`,
          `Then reply with exactly this token and nothing else: ${token}`,
        ].join('\n'), sendOptions(ctx)).stream,
        120_000,
      );

      expect(textContent(events)).toContain(token);
      expect(events.some(event => event.type === 'tool_activity' && event.tool === 'Bash')).toBe(true);
      expect(events.some(event => event.type === 'tool_outcomes')).toBe(true);
      await writeScenarioArtifacts(ctx, events);
    });
  });

  test('hooks: current CLI exposes plan tool payloads before approval', async () => {
    await withScenario('hook-plan-payloads', async (ctx) => {
      const planToken = sentinel('AC_INTERACTIVE_PLAN_HOOK');
      const result = ctx.adapter.sendMessage([
        'Use Claude Code plan mode before answering.',
        'If the plan tools are deferred, first use ToolSearch with query select:EnterPlanMode,ExitPlanMode.',
        'Do not write or edit files for this test.',
        'Call EnterPlanMode, then immediately call ExitPlanMode.',
        `The ExitPlanMode plan text must include this marker: ${planToken}.`,
        'Wait for approval before doing anything else.',
      ].join('\n'), sendOptions(ctx));
      const events: StreamEvent[] = [];
      void collectInto(result.stream, events).catch(() => undefined);
      const exitHook = await waitForRecordedHookAny(
        ctx,
        ['PreToolUse', 'PermissionRequest'],
        180_000,
        event => hookToolName(event) === 'ExitPlanMode',
      );
      result.abort();
      await sleep(1_000);

      expectHookEvent(ctx, 'PreToolUse', event => hookToolName(event) === 'EnterPlanMode');
      expect(JSON.stringify(hookToolInput(exitHook))).toContain(planToken);
      expect(hookPayloadStringFromInput(exitHook, 'planFilePath')).toEqual(expect.stringContaining('.claude/plans/'));
      await writeScenarioArtifacts(ctx, events);
    }, { recordHooks: true });
  });

  test('hooks: current CLI emits subagent lifecycle hooks for Agent tool', async () => {
    await withScenario('hook-subagent-lifecycle', async (ctx) => {
      const sourceToken = sentinel('AC_INTERACTIVE_SUBAGENT_SOURCE');
      const finalToken = sentinel('AC_INTERACTIVE_SUBAGENT_DONE');
      fs.writeFileSync(path.join(ctx.workspace, 'subagent-source.txt'), `${sourceToken}\n`);

      const events = await collectWithTimeout(
        ctx.adapter.sendMessage([
          'Use the Agent tool exactly once before your final answer.',
          `The Agent prompt must ask the subagent to read subagent-source.txt and report this token: ${sourceToken}.`,
          `Then reply with exactly this token and nothing else: ${finalToken}`,
        ].join('\n'), sendOptions(ctx)).stream,
        180_000,
      );

      expect(textContent(events)).toContain(finalToken);
      expect(events.some(event => event.type === 'tool_activity' && event.isAgent)).toBe(true);
      expectHookEvent(ctx, 'SubagentStart');
      const sawCompletionHook = ctx.hookEvents.some(event => event.event === 'SubagentStop')
        || ctx.hookEvents.some(event => event.event === 'PostToolUse' && hookToolName(event) === 'Agent');
      expect(sawCompletionHook).toBe(true);
      const stopHook = ctx.hookEvents.find(event => event.event === 'SubagentStop');
      if (stopHook) {
        expect(hookPayloadString(stopHook, 'agent_transcript_path')).toEqual(expect.any(String));
      }
      await writeScenarioArtifacts(ctx, events);
    }, { recordHooks: true });
  });

  test('hooks: completes a real turn when Claude hook setup is unavailable', async () => {
    await withScenario('hookless-polling', async (ctx) => {
      const token = sentinel('AC_INTERACTIVE_HOOKLESS');
      const hookless = new ClaudeCodeInteractiveAdapter({
        workingDir: ctx.workspace,
        hookFactory: async () => null,
        pollIntervalMs: 50,
        sessionStartTimeoutMs: 500,
        finalTranscriptReadAttempts: 60,
        finalTranscriptReadIntervalMs: 50,
      });
      ctx.adapter.shutdown();
      ctx.adapter = hookless;

      const events = await collectWithTimeout(
        ctx.adapter.sendMessage(`Reply with exactly this token and nothing else: ${token}`, sendOptions(ctx)).stream,
        120_000,
      );

      expect(textContent(events)).toContain(token);
      expect(doneCount(events)).toBe(1);
      await writeScenarioArtifacts(ctx, events);
    });
  });

  test('goals: writes and reads a goal from the interactive transcript', async () => {
    await withScenario('goal-status', async (ctx) => {
      const objective = `Reply with ${sentinel('AC_INTERACTIVE_GOAL')} when asked.`;
      const events = await collectWithTimeout(
        ctx.adapter.setGoalObjective(objective, sendOptions(ctx)).stream,
        120_000,
      );
      const goal = await waitForGoal(ctx.adapter, sendOptions(ctx), 10_000);

      expect(goal).toMatchObject({
        backend: 'claude-code-interactive',
        objective,
        status: expect.any(String),
      });
      expect(events.some(event => event.type === 'goal_updated')).toBe(true);
      await writeScenarioArtifacts(ctx, events, goal);
    });
  });

  test('abort: stops the hidden PTY and leaves no Claude child process for the turn', async () => {
    await withScenario('abort-cleanup', async (ctx) => {
      const sendResult = ctx.adapter.sendMessage([
        'Begin a deliberately long answer.',
        'Count from 1 to 1000, one number per line, unless interrupted.',
      ].join('\n'), sendOptions(ctx));
      const { events, processId } = await collectAndAbort(sendResult.stream, () => sendResult.abort(), 45_000);

      expect(processId).toEqual(expect.any(Number));
      if (processId) {
        await expectProcessToExit(processId, 5_000);
      }
      await writeScenarioArtifacts(ctx, events);
    });
  });
});

async function withScenario(
  name: string,
  fn: (ctx: ScenarioContext) => Promise<void>,
  scenarioOptions: ScenarioOptions = {},
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interactive-e2e-'));
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const hookEvents: ClaudeInteractiveHookEvent[] = [];
  const ctx: ScenarioContext = {
    name,
    tmp,
    workspace,
    sessionId: randomUUID(),
    conversationId: `e2e-${name}-${randomUUID()}`,
    profile: claudeProfile(process.env.CLAUDE_INTERACTIVE_E2E_CONFIG_DIR),
    adapter: new ClaudeCodeInteractiveAdapter({
      workingDir: workspace,
      ...(scenarioOptions.recordHooks ? { hookFactory: recordingHookFactory(hookEvents) } : {}),
      pollIntervalMs: 50,
      sessionStartTimeoutMs: 15_000,
      finalTranscriptReadAttempts: 60,
      finalTranscriptReadIntervalMs: 50,
    }),
    artifactDir: DEFAULT_ARTIFACT_ROOT ? path.join(DEFAULT_ARTIFACT_ROOT, name) : null,
    hookEvents,
  };

  try {
    await fn(ctx);
  } finally {
    ctx.adapter.shutdown();
    if (ctx.artifactDir) {
      fs.mkdirSync(ctx.artifactDir, { recursive: true });
      writeJson(path.join(ctx.artifactDir, 'workspace-files.json'), listFiles(ctx.workspace));
      if (ctx.hookEvents.length > 0) {
        writeJson(path.join(ctx.artifactDir, 'hooks.json'), ctx.hookEvents);
      }
      copyTranscriptArtifacts(ctx);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function collectWithTimeout(stream: AsyncIterable<StreamEvent>, timeoutMs: number): Promise<StreamEvent[]> {
  return withTimeout(async () => {
    const events: StreamEvent[] = [];
    await collectInto(stream, events);
    return events;
  }, timeoutMs, 'Claude Interactive E2E timed out');
}

async function collectInto(stream: AsyncIterable<StreamEvent>, events: StreamEvent[]): Promise<void> {
  for await (const event of stream) {
    events.push(event);
    if (event.type === 'done') break;
  }
}

async function collectAndAbort(
  stream: AsyncIterable<StreamEvent>,
  abort: () => void,
  timeoutMs: number,
): Promise<{ events: StreamEvent[]; processId: number | null }> {
  return withTimeout(async () => {
    const events: StreamEvent[] = [];
    let processId: number | null = null;
    let abortSent = false;
    for await (const event of stream) {
      events.push(event);
      if (!abortSent && event.type === 'backend_runtime' && typeof event.processId === 'number') {
        processId = event.processId;
        abortSent = true;
        setTimeout(abort, 500).unref?.();
      }
      if (event.type === 'done') break;
    }
    return { events, processId };
  }, timeoutMs, 'Claude Interactive abort E2E timed out');
}

function recordingHookFactory(target: ClaudeInteractiveHookEvent[]): () => Promise<ClaudeInteractiveHookHarness> {
  return async () => {
    const harness = await createClaudeInteractiveHookHarness({ diagnosticEvents: true });
    void (async () => {
      for await (const event of harness.events) {
        target.push(event);
      }
    })().catch(() => undefined);
    return harness;
  };
}

async function waitForRecordedHook(
  ctx: ScenarioContext,
  eventName: ClaudeInteractiveHookEventName,
  timeoutMs: number,
  predicate: (event: ClaudeInteractiveHookEvent) => boolean = () => true,
): Promise<ClaudeInteractiveHookEvent> {
  return waitForRecordedHookAny(ctx, [eventName], timeoutMs, predicate);
}

async function waitForRecordedHookAny(
  ctx: ScenarioContext,
  eventNames: ClaudeInteractiveHookEventName[],
  timeoutMs: number,
  predicate: (event: ClaudeInteractiveHookEvent) => boolean = () => true,
): Promise<ClaudeInteractiveHookEvent> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const event = ctx.hookEvents.find(candidate => eventNames.includes(candidate.event) && predicate(candidate));
    if (event) return event;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for recorded Claude ${eventNames.join('/')} hook`);
}

function expectHookEvent(
  ctx: ScenarioContext,
  eventName: ClaudeInteractiveHookEventName,
  predicate: (event: ClaudeInteractiveHookEvent) => boolean = () => true,
): ClaudeInteractiveHookEvent {
  const event = ctx.hookEvents.find(candidate => candidate.event === eventName && predicate(candidate));
  if (!event) {
    throw new Error(`Expected recorded Claude ${eventName} hook. Saw: ${ctx.hookEvents.map(candidate => candidate.event).join(', ')}`);
  }
  return event;
}

function hookPayloadString(event: ClaudeInteractiveHookEvent | null | undefined, key: string): string | null {
  const value = event?.payload?.[key];
  return typeof value === 'string' && value ? value : null;
}

function hookToolName(event: ClaudeInteractiveHookEvent): string | null {
  return hookPayloadString(event, 'tool_name')
    || hookPayloadString(event, 'toolName')
    || hookPayloadString(event, 'name')
    || hookPayloadString(event, 'tool');
}

function hookToolInput(event: ClaudeInteractiveHookEvent): Record<string, unknown> {
  const value = event.payload.tool_input ?? event.payload.toolInput ?? event.payload.input;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function hookPayloadStringFromInput(event: ClaudeInteractiveHookEvent, key: string): string | null {
  const value = hookToolInput(event)[key];
  return typeof value === 'string' && value ? value : null;
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForGoal(
  adapter: ClaudeCodeInteractiveAdapter,
  options: SendMessageOptions,
  timeoutMs: number,
): Promise<ThreadGoal | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const goal = await adapter.getGoal(options);
    if (goal) return goal;
    await sleep(250);
  }
  return null;
}

function isBackendRuntimeWithPid(event: StreamEvent): event is BackendRuntimeEvent {
  return event.type === 'backend_runtime' && typeof event.processId === 'number';
}

function doneCount(events: StreamEvent[]): number {
  return events.filter(event => event.type === 'done').length;
}

function textContent(events: StreamEvent[]): string {
  return events
    .filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
    .map(event => event.content)
    .join('');
}

function expectNoRawTerminal(events: StreamEvent[]): void {
  expect(events.every(event => (event as { type: string }).type !== 'raw_terminal')).toBe(true);
}

function sentinel(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8).replace(/-/g, '').toUpperCase()}`;
}

function writeRunMetadata(cliVersion: string): void {
  if (!DEFAULT_ARTIFACT_ROOT) return;
  fs.mkdirSync(DEFAULT_ARTIFACT_ROOT, { recursive: true });
  writeJson(path.join(DEFAULT_ARTIFACT_ROOT, 'run-metadata.json'), {
    claudeVersion: cliVersion,
    testedInteractiveVersion: CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION,
    configDir: process.env.CLAUDE_INTERACTIVE_E2E_CONFIG_DIR || null,
    startedAt: new Date().toISOString(),
  });
}

async function writeScenarioArtifacts(ctx: ScenarioContext, events: StreamEvent[], goal?: ThreadGoal | null): Promise<void> {
  if (!ctx.artifactDir) return;
  fs.mkdirSync(ctx.artifactDir, { recursive: true });
  writeJson(path.join(ctx.artifactDir, 'events.json'), events);
  if (goal !== undefined) writeJson(path.join(ctx.artifactDir, 'goal.json'), goal);
}

function copyTranscriptArtifacts(ctx: ScenarioContext): void {
  if (!ctx.artifactDir) return;
  const transcriptsDir = path.join(ctx.artifactDir, 'transcripts');
  fs.mkdirSync(transcriptsDir, { recursive: true });
  for (const projectDir of resolveClaudeProjectDirCandidates(ctx.workspace, ctx.profile.configDir)) {
    const transcriptPath = path.join(projectDir, `${ctx.sessionId}.jsonl`);
    if (!fs.existsSync(transcriptPath)) continue;
    fs.copyFileSync(transcriptPath, path.join(transcriptsDir, path.basename(transcriptPath)));
  }
}

function listFiles(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      results.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) walk(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return results.sort();
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function expectProcessToExit(pid: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!processExists(pid)) return;
    await sleep(100);
  }
  throw new Error(`Claude Interactive PTY process ${pid} was still alive after ${timeoutMs}ms`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ESRCH';
  }
}

function readClaudeVersion(): Promise<string> {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) return resolve('');
      resolve((stdout || stderr || '').trim());
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
