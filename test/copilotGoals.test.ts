import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CopilotSession } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import { CopilotAdapter } from '../src/services/backends/copilot';
import { CopilotConversations } from '../src/services/backends/copilotConversations';
import { startCopilotSdkRuntime } from '../src/services/backends/copilotSdkRuntime';
import { invokeCopilotGoal, projectCopilotGoal } from '../src/services/backends/copilotGoals';
import { parseGoalAiCreditLimit } from '../src/contracts/goals';
import type { SendMessageOptions, StreamEvent } from '../src/types';
import { waitForCopilotPeer, writeCopilotSdkPeer } from './helpers/copilotSdkPeer';

async function collect(stream: AsyncGenerator<StreamEvent>, frames: StreamEvent[] = []) {
  for await (const frame of stream) frames.push(frame);
  return frames;
}

describe('Copilot native goal boundary', () => {
  test.each(['active', 'paused', 'completed'] as const)('projects only canonical %s state without invented token/time counters', status => {
    const goal = projectCopilotGoal({ id: 4, objective: 'Native objective', status, turnCount: 2,
      creditCountNanoAiu: '999999999', creditLimit: { credits: 5, creditsUsed: 1.25, creditsUsedNanoAiu: '1250000000' },
      ...(status === 'completed' ? { completionSummary: 'Verified' } : { pauseReason: 'native_reason' }),
    }, 'native-session');
    expect(goal).toMatchObject({ backend: 'copilot', objectiveId: 4, status: status === 'completed' ? 'complete' : status,
      sessionId: 'native-session', turns: 2, aiCreditLimit: 5, aiCreditsUsed: 1.25, source: 'native',
      supportedActions: { clear: false, stopTurn: true, pause: true, resume: true } });
    expect(goal).not.toHaveProperty('tokensUsed');
    expect(goal).not.toHaveProperty('timeUsedSeconds');
    expect(goal).not.toHaveProperty('updatedAt');
    expect(projectCopilotGoal(null, 'none')).toBeNull();
  });

  test.each([undefined, null, 0, -1, Infinity, NaN, '5'])('rejects an invalid explicit resume credit limit: %s', value => {
    expect(() => parseGoalAiCreditLimit(value, true)).toThrow('fresh AI credit limit');
  });

  test('allows an optional start limit and preserves decimal limits', () => {
    expect(parseGoalAiCreditLimit(undefined)).toBeUndefined();
    expect(parseGoalAiCreditLimit(0.5, true)).toBe(0.5);
  });

  test('does not turn a non-prompt command response or a nonpaused state into a run', async () => {
    const session = { sessionId: 's', rpc: { commands: { invoke: jest.fn().mockResolvedValue({ kind: 'text', text: 'unsupported' }) },
      autopilotObjective: { getState: jest.fn().mockResolvedValue({ state: null }) } } } as unknown as CopilotSession;
    await expect(invokeCopilotGoal(session, { kind: 'set', objective: 'work' })).rejects.toThrow('did not accept');
    await expect(invokeCopilotGoal(session, { kind: 'resume', aiCreditLimit: 3 })).rejects.toThrow('Only a paused');
    expect(session.rpc.commands.invoke).toHaveBeenCalledTimes(1);
  });
});

describe('Copilot goal ownership through the official SDK and an executable peer', () => {
  let dir: string;
  let peer: ReturnType<typeof writeCopilotSdkPeer>;
  let adapter: CopilotAdapter;
  const options = (overrides: Partial<SendMessageOptions> = {}): SendMessageOptions => ({ sessionId: 'cockpit', conversationId: 'conversation',
    workingDir: dir, systemPrompt: '', isNewSession: true, cliProfile: peer.profile({ COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:1' }), ...overrides });
  const nativeId = (frames: StreamEvent[]) => frames.find(frame => frame.type === 'external_session')!.sessionId;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-goals-'));
    peer = writeCopilotSdkPeer(dir); adapter = new CopilotAdapter();
  });
  afterEach(async () => { await adapter.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('starts a literal objective, completes from native state and cold-reads without sending work', async () => {
    const frames = await collect(adapter.setGoalObjective('off --max-ai-credits 9', options({ goalAiCreditLimit: 2.5 })).stream);
    expect(frames.filter(frame => frame.type === 'goal_updated').map(frame => frame.goal.status)).toEqual(['active', 'complete']);
    expect(peer.calls().find(call => call.method === 'session.commands.invoke')?.params).toMatchObject({ name: 'autopilot', input: '--max-ai-credits 2.5 -- off --max-ai-credits 9' });
    const before = peer.calls().length;
    const readOptions = options({ isNewSession: false, externalSessionId: nativeId(frames) });
    const [goal, sameGoal] = await Promise.all([adapter.getGoal(readOptions), adapter.getGoal(readOptions)]);
    expect(goal).toMatchObject({ objective: 'off --max-ai-credits 9', status: 'complete', aiCreditLimit: 2.5, aiCreditsUsed: 0 });
    expect(sameGoal).toEqual(goal);
    const controlCalls = peer.calls().slice(before);
    expect(controlCalls.filter(call => call.method === 'session.resume')).toHaveLength(1);
    expect(controlCalls.some(call => ['session.send', 'session.create', 'models.list'].includes(call.method))).toBe(false);
    expect(controlCalls.find(call => call.method === 'session.resume')?.params).toMatchObject({ continuePendingWork: false });
    expect(controlCalls.find(call => call.method === 'session.resume')?.params).toMatchObject({ enableConfigDiscovery: false });
    expect(controlCalls.find(call => call.method === 'session.resume')?.params).not.toHaveProperty('model');
    expect(controlCalls.find(call => call.method === 'session.resume')?.params).not.toHaveProperty('mcpServers');
  }, 15000);

  test('ordinary idle stays active, cold status pauses it, and credit resume preserves objective identity', async () => {
    const frames = await collect(adapter.setGoalObjective('IDLE_GOAL', options()).stream);
    expect(frames.filter(frame => frame.type === 'goal_updated').map(frame => frame.goal.status)).toEqual(['active', 'active']);
    const saved = options({ isNewSession: false, externalSessionId: nativeId(frames) });
    const paused = await adapter.getGoal(saved);
    expect(paused).toMatchObject({ status: 'paused', lastReason: 'resumed_session', objectiveId: 1 });
    const before = peer.calls().length;
    expect(() => adapter.resumeGoal(saved)).toThrow('fresh AI credit limit');
    expect(peer.calls()).toHaveLength(before);
    const resumed = await collect(adapter.resumeGoal({ ...saved, goalAiCreditLimit: 4 }).stream);
    expect(resumed.filter(frame => frame.type === 'goal_updated').every(frame => frame.goal.objectiveId === 1 && frame.goal.aiCreditLimit === 4)).toBe(true);
    expect(peer.calls().filter(call => call.method === 'session.commands.invoke').at(-1)?.params).toMatchObject({ name: 'autopilot', input: '--max-ai-credits 4' });
  }, 15000);

  test('active status and pause reuse the owner, stop work and preserve the paused objective', async () => {
    const frames: StreamEvent[] = [];
    const pending = collect(adapter.setGoalObjective('DEFERRED goal', options()).stream, frames);
    await waitForCopilotPeer(() => frames.some(frame => frame.type === 'text'));
    const before = peer.calls().filter(call => call.method === 'spawn').length;
    expect(await adapter.getGoal(options())).toMatchObject({ status: 'active', objective: 'DEFERRED goal' });
    expect(await adapter.pauseGoal(options())).toMatchObject({ status: 'paused', objective: 'DEFERRED goal', lastReason: 'autopilot_off' });
    expect(peer.calls().filter(call => call.method === 'spawn')).toHaveLength(before);
    expect((await pending).some(frame => frame.type === 'error')).toBe(false);
    expect(frames.at(-2)).toMatchObject({ type: 'goal_updated', goal: { status: 'paused' } });
    const saved = options({ isNewSession: false, externalSessionId: nativeId(frames) });
    expect(await adapter.getGoal(saved)).toMatchObject({ status: 'paused', objective: 'DEFERRED goal' });
    // Resume runs the same objective and remains subject to the normal Stop path.
    const resumedFrames: StreamEvent[] = [];
    const resumed = adapter.resumeGoal({ ...saved, goalAiCreditLimit: 3 });
    const resuming = collect(resumed.stream, resumedFrames);
    await waitForCopilotPeer(() => resumedFrames.some(frame => frame.type === 'text'));
    resumed.abort(); await resuming;
    expect(await adapter.getGoal(saved)).toMatchObject({ status: 'paused', objectiveId: 1 });
  }, 15000);

  test('does not create history on status, recover missing goals, clear, or enable opaque commands', async () => {
    expect(await adapter.getGoal(options())).toBeNull();
    expect(peer.calls()).toEqual([]);
    await expect(adapter.getGoal(options({ externalSessionId: 'missing-native' }))).rejects.toThrow('Session not found');
    expect(peer.calls().some(call => call.method === 'session.create' || call.method === 'session.send')).toBe(false);
    expect(adapter.getGoalCapability({ cliProfile: options().cliProfile })).toMatchObject({ clear: false, resume: true });
    const opaque = { ...peer.profile(), command: 'opaque-launcher --fixed' };
    expect(adapter.getGoalCapability({ cliProfile: opaque })).toBe(false);
    expect(() => adapter.setGoalObjective('work', options({ cliProfile: opaque }))).toThrow('SDK transport');
    await expect(adapter.clearGoal(options())).rejects.toThrow('not implemented');
  }, 15000);

  test('native failures cannot become achievement, and resume never recreates a missing session', async () => {
    const failed = await collect(adapter.setGoalObjective('FAIL_AFTER_SEND', options()).stream);
    expect(failed.some(frame => frame.type === 'goal_updated' && frame.goal.status === 'complete')).toBe(false);
    expect(failed.some(frame => frame.type === 'error')).toBe(true);
    const before = peer.calls().length;
    const resume = await collect(adapter.resumeGoal(options({ isNewSession: false, externalSessionId: 'missing-native', goalAiCreditLimit: 2 })).stream);
    expect(resume.some(frame => frame.type === 'error')).toBe(true);
    expect(peer.calls().slice(before).some(call => ['session.create', 'session.send'].includes(call.method))).toBe(false);
  }, 15000);

  test('setting a goal after missing chat history preserves recovery instructions around its native prompt', async () => {
    const snapshot = jest.fn().mockResolvedValue({ snapshotPath: path.join(dir, 'snapshot.json'), recoveryCount: 1 });
    const frames = await collect(adapter.setGoalObjective('Recovered goal', options({ isNewSession: false, externalSessionId: 'missing-native',
      systemPrompt: 'Recovered workspace rules', sessionRecovery: { createSnapshot: snapshot } })).stream);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(frames.some(frame => frame.type === 'session_recovery')).toBe(true);
    const prompt = String(peer.calls().find(call => call.method === 'session.send')?.params?.prompt);
    expect(prompt).toContain('Recovered workspace rules');
    expect(prompt).toContain('MUST read the prior Agent Cockpit conversation snapshot');
    expect(prompt).toContain('snapshot.json'); expect(prompt).toContain('Recovered goal');
  }, 15000);

  test('a terminal event during goal command admission cannot submit a late prompt', async () => {
    const frames = await collect(adapter.setGoalObjective('Do not submit', options({ cliProfile: peer.profile({
      COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:1', COPILOT_FIXTURE_GOAL: 'session-error',
    }) })).stream);
    expect(frames).toContainEqual({ type: 'error', error: 'Goal failed before prompt submission' });
    expect(peer.calls().some(call => call.method === 'session.send')).toBe(false);
  }, 15000);

  test('new chat cancels an idle status owner and waits for its process cleanup', async () => {
    const checking = adapter.getGoal(options({ externalSessionId: 'saved', cliProfile: peer.profile({ COPILOT_FIXTURE_GOAL: 'hang', COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:1' }) })).catch(error => error);
    await waitForCopilotPeer(() => peer.calls().some(call => call.method === 'session.autopilotObjective.getState'));
    const frames = await collect(adapter.sendMessage('replacement', options()).stream);
    expect(await checking).toBeInstanceOf(Error);
    expect(frames.some(frame => frame.type === 'text')).toBe(true);
    expect(peer.calls().filter(call => call.method === 'spawn')).toHaveLength(2);
  }, 15000);

  test('a status read racing normal idle cleanup retries only after that owner drains', async () => {
    let hold = false, reading = false;
    const owner = new CopilotConversations({ startRuntime: async (...args) => {
      const runtime = await startCopilotSdkRuntime(...args);
      const create = runtime.client.createSession.bind(runtime.client);
      runtime.client.createSession = async config => {
        const session = await create(config);
        const get = session.rpc.autopilotObjective.getState;
        session.rpc.autopilotObjective.getState = () => {
          if (hold) { reading = true; return new Promise(() => {}); }
          return get();
        };
        return session;
      };
      return runtime;
    } });
    try {
      const active = owner.sendMessage('', options(), { kind: 'set', objective: 'Completed goal' });
      const frames: StreamEvent[] = [];
      for (;;) {
        const next = await active.stream.next();
        if (next.done) throw new Error('Missing completion');
        frames.push(next.value);
        if (next.value.type === 'goal_updated' && next.value.goal.status === 'complete') break;
      }
      hold = true;
      const checking = owner.goal(options({ isNewSession: false, externalSessionId: nativeId(frames) }));
      await waitForCopilotPeer(() => reading);
      await collect(active.stream);
      expect(await checking).toMatchObject({ status: 'complete', objective: 'Completed goal' });
      expect(peer.calls().filter(call => call.method === 'spawn')).toHaveLength(2);
      expect(peer.calls().filter(call => call.method === 'session.send')).toHaveLength(1);
    } finally { await owner.shutdown(); }
  }, 15000);

  test.each(['reset', 'shutdown'] as const)('%s drains a late idle-control startup without resuming history', async action => {
    let release!: () => void, allocated!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { allocated = resolve; });
    const owner = new CopilotConversations({ startRuntime: async (...args) => {
      const runtime = await startCopilotSdkRuntime(args[0], args[1]); allocated(); await gate; return runtime;
    } });
    const reading = owner.goal(options({ externalSessionId: 'saved' })).catch(error => error);
    await ready;
    const stopping = action === 'reset' ? owner.onSessionReset('conversation') : owner.shutdown();
    await expect(owner.goal(options({ externalSessionId: 'saved' }))).rejects.toThrow('shutting down or resetting');
    release(); await stopping;
    expect(await reading).toBeInstanceOf(Error);
    expect(peer.calls().some(call => call.method === 'session.resume')).toBe(false);
    await owner.shutdown();
  }, 15000);
});
