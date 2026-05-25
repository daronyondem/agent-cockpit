import {
  AFTER_ASSISTANT_MESSAGE_RECONCILE_DELAY_MS,
  reduceStreamFrame,
  type StreamConversation,
  type StreamReducerState,
} from '../web/AgentCockpitWeb/src/stream/streamFrameReducer';
import type { Message, StreamEvent } from '../src/contracts/responses';
import type { BrowserStreamFrame } from '../src/contracts/streamFrames';

function baseState(overrides: Partial<StreamReducerState> = {}): StreamReducerState {
  return {
    convId: 'c1',
    conv: null,
    messages: [],
    streaming: false,
    streamError: null,
    streamErrorSource: null,
    usage: null,
    streamingMsgId: null,
    replayActive: false,
    lastFrameAtMs: null,
    wsReconnectAttempts: 0,
    uiState: null,
    unread: false,
    pendingInteraction: null,
    goal: null,
    goalUpdatedAtMs: null,
    queue: [],
    planModeActive: false,
    ...overrides,
  };
}

function baseConversation(overrides: Partial<StreamConversation> = {}): StreamConversation {
  return {
    id: 'c1',
    title: 'Conversation',
    backend: 'codex',
    workingDir: '/repo',
    workspaceId: 'workspace-1',
    workspaceHash: 'hash-1',
    currentSessionId: 'session-1',
    sessionNumber: 1,
    messages: [],
    ...overrides,
  };
}

function assistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: 'Final answer',
    backend: 'codex',
    timestamp: '2026-05-25T00:00:05.000Z',
    turn: 'final',
    ...overrides,
  };
}

function replayFrames(
  initial: StreamReducerState,
  frames: BrowserStreamFrame[],
  options: { activeConvId?: string | null; hasActiveSocket?: boolean } = {},
) {
  return frames.reduce((acc, frame, index) => reduceStreamFrame(acc.state, frame, {
    nowMs: 1_000 + (index * 100),
    activeConvId: options.activeConvId ?? 'c1',
    hasActiveSocket: options.hasActiveSocket,
    placeholderId: 'ph-1',
    memoryMessageId: 'mem-1',
  }), { state: initial, effects: [] as ReturnType<typeof reduceStreamFrame>['effects'] });
}

describe('streamFrameReducer', () => {
  test('builds placeholder content blocks from streamed frames', () => {
    const initial = baseState({ conv: baseConversation(), streaming: true, uiState: 'streaming' });

    const result = replayFrames(initial, [
      { type: 'text', content: 'Hello ' },
      { type: 'thinking', content: 'checking' },
      { type: 'text', content: 'world' },
      { type: 'tool_activity', tool: 'Read', description: 'Reading file', id: 'tool-1' },
      { type: 'tool_outcomes', outcomes: [{ toolUseId: 'tool-1', isError: false, outcome: 'ok', status: 'done' }] },
      { type: 'artifact', artifact: { filename: 'out.md', path: '/repo/out.md', kind: 'md', title: 'Output' } },
    ]);

    expect(result.state.streamingMsgId).toBe('ph-1');
    expect(result.state.messages).toHaveLength(1);
    const message = result.state.messages[0];
    expect(message).toMatchObject({ id: 'ph-1', role: 'assistant', content: 'Hello world' });
    if (message.role === 'memory') throw new Error('expected assistant placeholder');
    expect(message.contentBlocks?.map(block => block.type)).toEqual(['text', 'thinking', 'text', 'tool', 'artifact']);
    const tool = message.contentBlocks?.find(block => block.type === 'tool');
    expect(tool).toMatchObject({
      activity: {
        tool: 'Read',
        description: 'Reading file',
        id: 'tool-1',
        outcome: 'ok',
        status: 'done',
        duration: 100,
      },
    });
  });

  test('clears stale pending interactions when a final assistant message arrives', () => {
    const initial = baseState({ streaming: true, uiState: 'streaming' });

    const result = replayFrames(initial, [
      { type: 'tool_activity', isPlanMode: true, planAction: 'enter', tool: 'EnterPlanMode', description: 'Entering plan mode' },
      { type: 'tool_activity', isPlanMode: true, planAction: 'exit', planContent: '# Plan', tool: 'ExitPlanMode', description: 'Plan ready' },
      { type: 'assistant_message', message: assistantMessage() },
    ]);

    expect(result.state.pendingInteraction).toBeNull();
    expect(result.state.planModeActive).toBe(false);
    expect(result.state.uiState).toBe('streaming');
    expect(result.state.messages).toEqual([assistantMessage()]);
  });

  test('falls back to the tool description for empty user-question text', () => {
    const result = reduceStreamFrame(baseState(), {
      type: 'tool_activity',
      isQuestion: true,
      description: 'Choose an option',
      questions: [{ question: '', options: [{ label: 'Continue' }] }],
    }, { nowMs: 2_000, activeConvId: 'c1' });

    expect(result.state.pendingInteraction).toEqual({
      type: 'userQuestion',
      question: 'Choose an option',
      options: [{ label: 'Continue' }],
    });
    expect(result.state.uiState).toBe('awaiting');
  });

  test('collapses duplicate final messages after replayed placeholders', () => {
    const original = assistantMessage({ id: 'final-1', content: 'Original' });
    const replayed = assistantMessage({ id: 'final-1', content: 'Replayed' });
    const initial = baseState({
      streaming: true,
      streamingMsgId: 'ph-1',
      messages: [
        original,
        assistantMessage({ id: 'ph-1', content: 'partial', contentBlocks: [{ type: 'text', content: 'partial' }] }),
      ],
    });

    const result = reduceStreamFrame(initial, { type: 'assistant_message', message: replayed }, {
      nowMs: 2_000,
      activeConvId: 'c1',
    });

    expect(result.state.streamingMsgId).toBeNull();
    expect(result.state.messages).toEqual([replayed]);
  });

  test('keeps assistant-message reconciliation delay aligned with the store behavior', () => {
    const result = reduceStreamFrame(
      baseState({ streaming: true, uiState: 'streaming' }),
      { type: 'assistant_message', message: assistantMessage() },
      { nowMs: 2_000, activeConvId: 'c1', hasActiveSocket: true },
    );

    expect(result.effects).toContainEqual({
      type: 'scheduleReconcile',
      delayMs: AFTER_ASSISTANT_MESSAGE_RECONCILE_DELAY_MS,
    });
  });

  test('does not schedule reconciliation for goal-event assistant messages', () => {
    const result = reduceStreamFrame(
      baseState({ streaming: true, uiState: 'streaming' }),
      { type: 'assistant_message', message: assistantMessage({ goalEvent: { kind: 'updated' } }) },
      { nowMs: 2_000, activeConvId: 'c1', hasActiveSocket: true },
    );

    expect(result.effects.map(effect => effect.type)).toEqual(['bumpConversationListActivity']);
  });

  test('ignores stale goal snapshots and timestamps clears with the frame time', () => {
    const currentGoal = {
      objective: 'Current goal',
      status: 'active' as const,
      updatedAt: 2_000,
    };
    const staleGoal = {
      objective: 'Stale goal',
      status: 'active' as const,
      updatedAt: 1_000,
    };
    const stale = reduceStreamFrame(
      baseState({ goal: currentGoal, goalUpdatedAtMs: 2_000_000 }),
      { type: 'goal_updated', goal: staleGoal },
      { nowMs: 3_000_000, activeConvId: 'c1' },
    );

    expect(stale.state.goal).toBe(currentGoal);
    expect(stale.state.goalUpdatedAtMs).toBe(2_000_000);

    const cleared = reduceStreamFrame(
      stale.state,
      { type: 'goal_cleared', threadId: 'thread-1' },
      { nowMs: 3_100_000, activeConvId: 'c1' },
    );

    expect(cleared.state.goal).toBeNull();
    expect(cleared.state.goalUpdatedAtMs).toBe(3_100_000);
  });

  test('finishes streams with unread and queue-drain effects for inactive conversations', () => {
    const initial = baseState({
      streaming: true,
      streamingMsgId: 'ph-1',
      messages: [assistantMessage({ id: 'ph-1', content: '', contentBlocks: [] })],
      wsReconnectAttempts: 2,
    });

    const result = reduceStreamFrame(initial, { type: 'done' }, { nowMs: 2_000, activeConvId: 'other' });

    expect(result.state).toMatchObject({
      streaming: false,
      streamingMsgId: null,
      replayActive: false,
      wsReconnectAttempts: 0,
      uiState: null,
      unread: true,
    });
    expect(result.state.messages).toEqual([]);
    expect(result.effects.map(effect => effect.type)).toEqual([
      'clearReconnectTimer',
      'clearReconcileTimer',
      'markConversationUnread',
      'refreshPlanUsage',
      'drainQueue',
    ]);
  });

  test('keeps non-terminal errors as warnings and clears state for terminal errors', () => {
    const pending = { type: 'userQuestion' as const, question: 'Proceed?', options: [] };

    const warning = reduceStreamFrame(
      baseState({ pendingInteraction: pending, planModeActive: true }),
      { type: 'error', error: 'Heads up', terminal: false },
      { nowMs: 2_000, activeConvId: 'c1' },
    );

    expect(warning.state.pendingInteraction).toEqual(pending);
    expect(warning.state.planModeActive).toBe(true);
    expect(warning.effects).toEqual([{ type: 'warn', message: 'Heads up' }]);

    const terminal = reduceStreamFrame(
      baseState({ pendingInteraction: pending, planModeActive: true }),
      { type: 'error', error: 'Failed', source: 'backend' },
      { nowMs: 2_000, activeConvId: 'c1' },
    );

    expect(terminal.state).toMatchObject({
      streamError: 'Failed',
      streamErrorSource: 'backend',
      pendingInteraction: null,
      planModeActive: false,
      uiState: 'error',
    });
    expect(terminal.effects).toEqual([]);
  });

  test('fans out memory and kb updates while keeping stream state deterministic', () => {
    const initial = baseState({
      conv: baseConversation({ kb: { enabled: true } }),
    });

    const memoryResult = reduceStreamFrame(initial, {
      type: 'memory_update',
      capturedAt: '2026-05-25T00:00:00.000Z',
      fileCount: 1,
      changedFiles: ['memory.md'],
      displayInChat: true,
      writeOutcomes: [{ status: 'applied' }],
    }, {
      nowMs: 2_000,
      activeConvId: 'c1',
      memoryMessageId: 'mem-1',
    });

    expect(memoryResult.state.messages).toEqual([{
      id: 'mem-1',
      role: 'memory',
      timestamp: '2026-05-25T00:00:00.000Z',
      memoryUpdate: {
        capturedAt: '2026-05-25T00:00:00.000Z',
        fileCount: 1,
        changedFiles: ['memory.md'],
        sourceConversationId: null,
        writeOutcomes: [{ status: 'applied' }],
      },
    }]);
    expect(memoryResult.effects).toEqual([{
      type: 'dispatchMemoryUpdate',
      detail: {
        hash: 'workspace-1',
        capturedAt: '2026-05-25T00:00:00.000Z',
        fileCount: 1,
        changedFiles: ['memory.md'],
        sourceConversationId: null,
        displayInChat: true,
        writeOutcomes: [{ status: 'applied' }],
      },
    }]);

    const kbResult = reduceStreamFrame(memoryResult.state, {
      type: 'kb_state_update',
      changed: { stopping: true, dreamProgress: { done: 1 }, entries: ['entry-1'] },
    }, { nowMs: 2_100, activeConvId: 'c1' });

    expect(kbResult.state.conv?.kb).toMatchObject({
      dreamingStopping: true,
      dreamingStatus: 'running',
      _dreamProgress: { done: 1 },
    });
    expect(kbResult.effects.map(effect => effect.type)).toEqual(['dispatchKbStateUpdate', 'refreshConversation']);
  });

  test('replay frames reset partial placeholder state and schedule reconciliation after replay', () => {
    const initial = baseState({
      streaming: true,
      streamingMsgId: 'ph-1',
      pendingInteraction: { type: 'planApproval', planContent: '# Old' },
      planModeActive: true,
      messages: [assistantMessage({ id: 'ph-1', content: 'partial', contentBlocks: [{ type: 'text', content: 'partial' }] })],
    });

    const replayStart = reduceStreamFrame(initial, { type: 'replay_start', bufferedEvents: 4 }, {
      nowMs: 2_000,
      activeConvId: 'c1',
    });

    expect(replayStart.state.replayActive).toBe(true);
    expect(replayStart.state.pendingInteraction).toBeNull();
    expect(replayStart.state.planModeActive).toBe(false);
    expect(replayStart.effects).toEqual([{ type: 'clearReconcileTimer' }]);
    const placeholder = replayStart.state.messages[0];
    expect(placeholder).toMatchObject({ content: '', contentBlocks: [] });

    const replayEnd = reduceStreamFrame(replayStart.state, { type: 'replay_end' }, {
      nowMs: 2_100,
      activeConvId: 'c1',
      hasActiveSocket: true,
    });

    expect(replayEnd.state.replayActive).toBe(false);
    expect(replayEnd.effects).toEqual([{ type: 'scheduleReconcile' }]);
  });

  test('keeps the legacy response StreamEvent alias aligned with browser frames', () => {
    const frames: StreamEvent[] = [
      { type: 'tool_activity', tool: 'Write', description: 'Writing plan', id: 'plan-write', isPlanFile: true, planFilePath: '/tmp/plan.md' },
      { type: 'tool_outcomes', outcomes: [{ toolUseId: 't1', isError: false, outcome: 'ok', status: 'done' }] },
      { type: 'memory_update', capturedAt: '2026-05-25T00:00:00.000Z', fileCount: 1, changedFiles: ['memory.md'] },
      { type: 'kb_state_update', changed: { synthesis: true } },
    ];

    expect(frames.map(frame => frame.type)).toEqual(['tool_activity', 'tool_outcomes', 'memory_update', 'kb_state_update']);
  });
});
