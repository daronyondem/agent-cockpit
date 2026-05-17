/**
 * @jest-environment jsdom
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Frontend test for web/AgentCockpitWeb/src/streamStore.js (PR 4c scope):
// - plan-mode exit and user-question tool_activity frames produce a
//   pendingInteraction on the ConvState and flip uiState to 'awaiting'
// - respond() delegates to POST /input and falls back to /message when
//   the server signals mode:'message'

let fakeWSInstance: FakeWS | null = null;

class FakeWS {
  readyState = 0;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static autoOpen = true;
  private listeners: Record<string, Array<() => void>> = {};
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onclose: ((e: Event) => void) | null = null;
  constructor(_url: string) {
    fakeWSInstance = this;
  }
  addEventListener(type: string, cb: () => void, _opts?: unknown) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(cb);
    if (type === 'open') {
      queueMicrotask(() => {
        if (!FakeWS.autoOpen || this.readyState === FakeWS.CLOSED) return;
        this.readyState = FakeWS.OPEN;
        cb();
      });
    }
  }
  close(code?: number, reason?: string) {
    this.readyState = FakeWS.CLOSED;
    if (this.onclose) this.onclose({ code, reason } as unknown as Event);
  }
  dispatch(frame: Record<string, unknown>) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) });
  }
  failOpen() {
    this.readyState = FakeWS.CLOSED;
    for (const cb of this.listeners.error || []) cb();
    if (this.onerror) this.onerror(new Event('error'));
  }
}

function makeResponse(body: unknown) {
  return { json: async () => body };
}

function loadStore() {
  const api = (global as any).AgentApi;
  jest.resetModules();
  jest.doMock('../web/AgentCockpitWeb/src/api.js', () => ({ AgentApi: api, default: api }));
  const mod = require('../web/AgentCockpitWeb/src/streamStore.js');
  (window as any).StreamStore = mod.StreamStore;
}

beforeEach(() => {
  fakeWSInstance = null;
  FakeWS.autoOpen = true;
  delete (window as any).StreamStore;

  (global as any).WebSocket = FakeWS;
  Object.defineProperty(window, 'WebSocket', { value: FakeWS, configurable: true, writable: true });

  (global as any).AgentApi = {
    chatWsUrl: (id: string) => `ws://test/conv/${id}`,
    fetch: jest.fn(),
    abortConversation: jest.fn().mockResolvedValue({ ok: true, aborted: true }),
    getActiveStreams: jest.fn().mockResolvedValue([]),
    markConversationUnread: jest.fn().mockResolvedValue({}),
  };
  (window as any).AgentApi = (global as any).AgentApi;

  loadStore();
});

async function openWs(convId: string) {
  const Store = (window as any).StreamStore;
  const p = Store.ensureWsOpen(convId);
  await new Promise<void>(r => queueMicrotask(() => r()));
  await p;
  return fakeWSInstance!;
}

async function startAcceptedStream(convId: string, ws: FakeWS) {
  const Store = (window as any).StreamStore;
  const api = (global as any).AgentApi;
  api.fetch.mockResolvedValueOnce(makeResponse({
    userMessage: {
      id: `user-${convId}`,
      role: 'user',
      content: 'active stream',
      backend: 'claude-code',
      timestamp: '2026-05-01T12:00:00.000Z',
    },
  }));
  await Store.send(convId, 'active stream');
  ws.dispatch({
    type: 'assistant_message',
    message: {
      id: `assistant-${convId}`,
      role: 'assistant',
      content: 'active reply',
      backend: 'claude-code',
      timestamp: '2026-05-01T12:00:01.000Z',
      contentBlocks: [{ type: 'text', content: 'active reply' }],
    },
  });
  expect(Store.getState(convId).streaming).toBe(true);
  api.fetch.mockReset();
}

function makeGoal(status: 'active' | 'paused' | 'budgetLimited' | 'complete', updatedAt: number) {
  return {
    threadId: 'thread-goal',
    objective: 'ship the goal',
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 12,
    createdAt: updatedAt - 1000,
    updatedAt,
  };
}

test('plan-exit frame sets pendingInteraction and uiState=awaiting', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({
    type: 'tool_activity',
    tool: 'ExitPlanMode',
    isPlanMode: true,
    planAction: 'exit',
    planContent: '# Plan\n\n- step 1\n- step 2',
    id: 't-plan',
  });

  const state = Store.getState('c1');
  expect(state.pendingInteraction).toEqual({
    type: 'planApproval',
    planContent: '# Plan\n\n- step 1\n- step 2',
  });
  expect(state.uiState).toBe('awaiting');
  expect(Store.convStates()).toEqual({ c1: 'awaiting' });
});

test('plan-enter frame does NOT set pendingInteraction', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({
    type: 'tool_activity',
    tool: 'EnterPlanMode',
    isPlanMode: true,
    planAction: 'enter',
    id: 't-enter',
  });

  const state = Store.getState('c1');
  expect(state.pendingInteraction).toBeNull();
  expect(state.uiState).toBeNull();
});

test('artifact frame appends a generated artifact block to the streaming placeholder', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({
    type: 'artifact',
    artifact: {
      filename: 'chart.png',
      path: '/tmp/data/chat/artifacts/c1/chart.png',
      kind: 'image',
      mimeType: 'image/png',
      title: 'Generated chart',
      sourceToolId: 'ig-1',
    },
  });

  const state = Store.getState('c1');
  const msg = state.messages[state.messages.length - 1];
  expect(msg.role).toBe('assistant');
  expect(msg.content).toBe('Generated chart');
  expect(msg.contentBlocks).toEqual([
    {
      type: 'artifact',
      artifact: {
        filename: 'chart.png',
        path: '/tmp/data/chat/artifacts/c1/chart.png',
        kind: 'image',
        mimeType: 'image/png',
        title: 'Generated chart',
        sourceToolId: 'ig-1',
      },
    },
  ]);
});

test('isQuestion frame sets pendingInteraction with first question + options', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({
    type: 'tool_activity',
    tool: 'AskUserQuestion',
    isQuestion: true,
    questions: [{
      question: 'Light or dark?',
      options: [
        { label: 'Light', description: 'bright' },
        { label: 'Dark', description: 'moody' },
      ],
    }],
  });

  const state = Store.getState('c1');
  expect(state.pendingInteraction).toEqual({
    type: 'userQuestion',
    question: 'Light or dark?',
    options: [
      { label: 'Light', description: 'bright' },
      { label: 'Dark', description: 'moody' },
    ],
  });
  expect(state.uiState).toBe('awaiting');
});

test('plan/question tool frames are NOT pushed into message contentBlocks', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({ type: 'text', content: 'Here is the plan.' });
  ws.dispatch({
    type: 'tool_activity',
    tool: 'ExitPlanMode',
    isPlanMode: true,
    planAction: 'exit',
    planContent: '- a\n- b',
    id: 't-plan',
  });

  const state = Store.getState('c1');
  const ph = state.messages[state.messages.length - 1];
  const tools = (ph.contentBlocks || []).filter((b: { type: string }) => b.type === 'tool');
  expect(tools).toHaveLength(0);
});

test('error frame clears pendingInteraction and flips uiState to error', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({
    type: 'tool_activity', tool: 'ExitPlanMode',
    isPlanMode: true, planAction: 'exit', planContent: 'x', id: 't',
  });
  expect(Store.getState('c1').pendingInteraction).not.toBeNull();

  ws.dispatch({ type: 'error', error: 'boom', source: 'backend' });

  const state = Store.getState('c1');
  expect(state.pendingInteraction).toBeNull();
  expect(state.uiState).toBe('error');
  expect(state.streamError).toBe('boom');
  expect(state.streamErrorSource).toBe('backend');
});

test('non-terminal error frame does not flip uiState to error', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({ type: 'error', error: 'model switch warning', terminal: false });

  const state = Store.getState('c1');
  expect(state.streamError).toBeNull();
  expect(state.uiState).toBeNull();
});

test('hydrateActiveStreams marks server-active conversations as streaming and blocks send', async () => {
  const Store = (window as any).StreamStore;
  const api = (global as any).AgentApi;
  api.getActiveStreams.mockResolvedValueOnce(['c1']);

  await Store.hydrateActiveStreams();

  expect(Store.getState('c1').streaming).toBe(true);
  expect(Store.getState('c1').uiState).toBe('streaming');

  await Store.send('c1', 'should not post');
  expect(api.fetch).not.toHaveBeenCalled();
});

test('active goal keeps sidebar state streaming after the current turn is done', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  Store.setActiveConvId('c1');
  await startAcceptedStream('c1', ws);
  ws.dispatch({ type: 'goal_updated', goal: makeGoal('active', 2000) });
  ws.dispatch({ type: 'done' });

  expect(Store.getState('c1').streaming).toBe(false);
  expect(Store.getState('c1').uiState).toBeNull();
  expect(Store.convStates()['c1']).toBe('streaming');
});

test('paused goal removes goal-derived streaming sidebar state', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({ type: 'goal_updated', goal: makeGoal('active', 2000) });
  expect(Store.convStates()['c1']).toBe('streaming');

  ws.dispatch({ type: 'goal_updated', goal: makeGoal('paused', 3000) });

  expect(Store.getState('c1').goal.status).toBe('paused');
  expect(Store.convStates()['c1']).toBe('idle');
});

test('older replayed goal updates cannot overwrite a newer paused goal', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({ type: 'goal_updated', goal: makeGoal('active', 1000) });
  ws.dispatch({ type: 'goal_updated', goal: makeGoal('paused', 2000) });
  ws.dispatch({ type: 'goal_updated', goal: makeGoal('active', 1000) });

  expect(Store.getState('c1').goal.status).toBe('paused');
  expect(Store.convStates()['c1']).toBe('idle');
});

test('load hydrates active Codex goal and notifies sidebar subscribers', async () => {
  const Store = (window as any).StreamStore;
  const api = (global as any).AgentApi;
  const listener = jest.fn();
  api.fetch.mockResolvedValueOnce(makeResponse({
    id: 'c1',
    title: 'Goal conversation',
    backend: 'codex',
    externalSessionId: 'thread-goal',
    messages: [],
  }));
  api.conv = {
    getGoal: jest.fn().mockResolvedValue({ goal: makeGoal('active', 4000) }),
  };

  Store.subscribeGlobal(listener);
  await Store.load('c1');
  await Promise.resolve();
  await Promise.resolve();

  expect(api.conv.getGoal).toHaveBeenCalledWith('c1');
  expect(Store.getState('c1').goal.status).toBe('active');
  expect(Store.convStates()['c1']).toBe('streaming');
  expect(listener).toHaveBeenCalled();
});

test('done frame preserves pendingInteraction and sets uiState=awaiting', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({
    type: 'tool_activity', tool: 'ExitPlanMode',
    isPlanMode: true, planAction: 'exit', planContent: 'x', id: 't',
  });
  ws.dispatch({ type: 'done' });

  const state = Store.getState('c1');
  expect(state.pendingInteraction).not.toBeNull();
  expect(state.uiState).toBe('awaiting');
  expect(state.streaming).toBe(false);
});

test('respond() with mode:stdin clears pendingInteraction without a fresh send', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({
    type: 'tool_activity', tool: 'ExitPlanMode',
    isPlanMode: true, planAction: 'exit', planContent: 'x', id: 't',
  });

  const api = (global as any).AgentApi;
  api.fetch.mockResolvedValueOnce(makeResponse({ mode: 'stdin' }));

  await Store.respond('c1', 'yes');

  expect(api.fetch).toHaveBeenCalledTimes(1);
  const [callPath, callOpts] = api.fetch.mock.calls[0];
  expect(callPath).toBe('conversations/c1/input');
  expect(callOpts.method).toBe('POST');
  expect(callOpts.body).toEqual({ text: 'yes', streamActive: false });

  const state = Store.getState('c1');
  expect(state.pendingInteraction).toBeNull();
  expect(state.respondPending).toBe(false);
  expect(state.uiState).toBeNull();
});

test('respond() with mode:message clears pendingInteraction and sends as new message', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  // seed a conv so send() has a backend
  ws.dispatch({
    type: 'tool_activity', tool: 'ExitPlanMode',
    isPlanMode: true, planAction: 'exit', planContent: 'x', id: 't',
  });

  const api = (global as any).AgentApi;
  api.fetch
    .mockResolvedValueOnce(makeResponse({ mode: 'message' }))   // /input
    .mockResolvedValueOnce(makeResponse({ userMessage: null })); // /message

  await Store.respond('c1', 'yes');

  expect(api.fetch).toHaveBeenCalledTimes(2);
  expect(api.fetch.mock.calls[0][0]).toBe('conversations/c1/input');
  expect(api.fetch.mock.calls[1][0]).toBe('conversations/c1/message');
  expect(api.fetch.mock.calls[1][1].body).toEqual({ content: 'yes' });

  const state = Store.getState('c1');
  expect(state.pendingInteraction).toBeNull();
  expect(state.streaming).toBe(true);
});

test('send() posts selected CLI profile with its vendor backend', async () => {
  await openWs('c1');
  const Store = (window as any).StreamStore;
  const api = (global as any).AgentApi;

  Store.setComposerCliProfile('c1', 'profile-codex-main', 'codex');
  api.fetch.mockResolvedValueOnce(makeResponse({
    userMessage: {
      id: 'u1',
      role: 'user',
      content: 'hello',
      backend: 'codex',
      timestamp: '2026-04-29T12:00:00.000Z',
    },
  }));

  await Store.send('c1', 'hello');

  expect(api.fetch).toHaveBeenCalledTimes(1);
  expect(api.fetch.mock.calls[0][0]).toBe('conversations/c1/message');
  expect(api.fetch.mock.calls[0][1].body).toEqual({
    content: 'hello',
    cliProfileId: 'profile-codex-main',
    backend: 'codex',
  });
});

test('replay_start wipes placeholder contentBlocks so replayed frames rebuild cleanly', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({ type: 'text', content: 'hello ' });
  ws.dispatch({ type: 'tool_activity', tool: 'Read', description: 'read file', id: 't1' });
  ws.dispatch({
    type: 'tool_activity',
    tool: 'ExitPlanMode',
    isPlanMode: true,
    planAction: 'exit',
    planContent: '# Plan',
    id: 't-plan',
  });

  const before = Store.getState('c1');
  const streamingIdBefore = before.streamingMsgId;
  expect(before.messages[before.messages.length - 1].contentBlocks.length).toBeGreaterThan(0);
  expect(before.pendingInteraction).not.toBeNull();

  ws.dispatch({ type: 'replay_start', bufferedEvents: 2 });

  const afterWipe = Store.getState('c1');
  expect(afterWipe.streamingMsgId).toBe(streamingIdBefore);
  expect(afterWipe.messages[afterWipe.messages.length - 1].contentBlocks).toEqual([]);
  expect(afterWipe.messages[afterWipe.messages.length - 1].content).toBe('');
  expect(afterWipe.pendingInteraction).toBeNull();
  expect(afterWipe.planModeActive).toBe(false);

  ws.dispatch({ type: 'text', content: 'hello ' });
  ws.dispatch({ type: 'text', content: 'world' });
  ws.dispatch({ type: 'replay_end' });

  const afterReplay = Store.getState('c1');
  const blocks = afterReplay.messages[afterReplay.messages.length - 1].contentBlocks;
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toEqual({ type: 'text', content: 'hello world' });
});

test('replay_start is a no-op when no placeholder exists', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  const before = Store.getState('c1');
  expect(before.streamingMsgId).toBeNull();

  ws.dispatch({ type: 'replay_start', bufferedEvents: 0 });

  const after = Store.getState('c1');
  expect(after.streamingMsgId).toBeNull();
  expect(after.messages).toEqual(before.messages);
});

test('replayed assistant_message with id matching an existing message replaces in place (no duplicate)', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  // First arrival appends the message normally (streamingMsgId is null on
  // a fresh socket, so this exercises the append branch).
  const msg = {
    id: 'msg-final-1',
    role: 'assistant',
    content: 'final reply',
    timestamp: '2026-04-26T12:00:00.000Z',
    contentBlocks: [{ type: 'text', content: 'final reply' }],
  };
  ws.dispatch({ type: 'assistant_message', message: msg });
  expect(Store.getState('c1').messages).toHaveLength(1);

  // Server's per-conv buffer replays the same frame on reconnect — must
  // not produce a second copy.
  ws.dispatch({ type: 'assistant_message', message: { ...msg, content: 'final reply (replayed)' } });

  const after = Store.getState('c1');
  expect(after.messages).toHaveLength(1);
  expect(after.messages[0].id).toBe('msg-final-1');
  expect(after.messages[0].content).toBe('final reply (replayed)');
});

test('goal event assistant_message does not replace the streaming placeholder', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({ type: 'text', content: 'working' });
  const placeholderId = Store.getState('c1').streamingMsgId;
  expect(placeholderId).toBeTruthy();

  ws.dispatch({
    type: 'assistant_message',
    message: {
      id: 'goal-set-1',
      role: 'system',
      content: 'Goal set: ship it',
      backend: 'codex',
      timestamp: '2026-04-26T12:00:00.000Z',
      goalEvent: { kind: 'set', backend: 'codex', objective: 'ship it', status: 'active' },
    },
  });

  let state = Store.getState('c1');
  expect(state.streamingMsgId).toBe(placeholderId);
  expect(state.messages.map((m: any) => m.id)).toEqual(['goal-set-1', placeholderId]);

  ws.dispatch({
    type: 'assistant_message',
    message: {
      id: 'msg-final-1',
      role: 'assistant',
      content: 'done',
      backend: 'codex',
      timestamp: '2026-04-26T12:00:01.000Z',
      contentBlocks: [{ type: 'text', content: 'done' }],
    },
  });

  state = Store.getState('c1');
  expect(state.streamingMsgId).toBeNull();
  expect(state.messages.map((m: any) => m.id)).toEqual(['goal-set-1', 'msg-final-1']);
});

test('goal-only stream removes the empty assistant placeholder on done', async () => {
  const Store = (window as any).StreamStore;
  const api = (global as any).AgentApi;
  api.fetch.mockResolvedValueOnce(makeResponse({
    id: 'c1',
    title: 'Goal only',
    backend: 'codex',
    externalSessionId: 'thread-goal',
    messages: [],
  }));
  api.conv = {
    getGoal: jest.fn().mockResolvedValue({ goal: null }),
    setGoal: jest.fn().mockResolvedValue({ streamReady: true, goal: makeGoal('active', 5000) }),
  };

  await Store.load('c1');
  await Store.setGoal('c1', 'ship it');
  const ws = fakeWSInstance!;
  const placeholderId = Store.getState('c1').streamingMsgId;
  expect(placeholderId).toBeTruthy();

  ws.dispatch({
    type: 'assistant_message',
    message: {
      id: 'goal-set-1',
      role: 'system',
      content: 'Goal set: ship it',
      backend: 'codex',
      timestamp: '2026-04-26T12:00:00.000Z',
      goalEvent: { kind: 'set', backend: 'codex', objective: 'ship it', status: 'active' },
    },
  });
  ws.dispatch({ type: 'done' });

  const state = Store.getState('c1');
  expect(state.streamingMsgId).toBeNull();
  expect(state.messages.map((m: any) => m.id)).toEqual(['goal-set-1']);
});

test('setGoal shows an immediate optimistic strip and upserts the returned goal message', async () => {
  const Store = (window as any).StreamStore;
  const api = (global as any).AgentApi;
  api.fetch.mockResolvedValueOnce(makeResponse({
    id: 'c1',
    title: 'Goal optimistic',
    backend: 'codex',
    externalSessionId: 'thread-goal',
    messages: [],
  }));
  let resolveSetGoal: ((value: any) => void) | null = null;
  api.conv = {
    getGoal: jest.fn().mockResolvedValue({ goal: null }),
    setGoal: jest.fn().mockImplementation(() => new Promise((resolve) => { resolveSetGoal = resolve; })),
  };

  await Store.load('c1');
  const pending = Store.setGoal('c1', 'Goal setcodexship it');
  await new Promise((resolve) => setTimeout(resolve, 0));

  let state = Store.getState('c1');
  expect(state.goal).toMatchObject({ objective: 'ship it', status: 'active' });
  expect(state.streaming).toBe(true);
  expect(api.conv.setGoal.mock.calls[0][1].objective).toBe('ship it');

  expect(resolveSetGoal).toBeTruthy();
  (resolveSetGoal as unknown as (value: any) => void)({
    streamReady: true,
    goal: { ...makeGoal('active', 5000), objective: 'ship it' },
    message: {
      id: 'goal-set-1',
      role: 'system',
      content: 'Goal set: ship it',
      backend: 'codex',
      timestamp: '2026-04-26T12:00:00.000Z',
      goalEvent: { kind: 'set', backend: 'codex', objective: 'ship it', status: 'active' },
    },
  });
  await pending;

  state = Store.getState('c1');
  expect(state.messages.map((m: any) => m.id)).toContain('goal-set-1');
  expect(state.goal.objective).toBe('ship it');
});

test('goal status polling keeps a local runtime goal when backend status is not readable yet', async () => {
  const Store = (window as any).StreamStore;
  const api = (global as any).AgentApi;
  api.fetch.mockResolvedValueOnce(makeResponse({
    id: 'c1',
    title: 'Goal status pending',
    backend: 'codex',
    externalSessionId: 'thread-goal',
    messages: [],
  }));
  let resolveSetGoal: ((value: any) => void) | null = null;
  api.conv = {
    getGoal: jest.fn().mockResolvedValue({ goal: null }),
    setGoal: jest.fn().mockImplementation(() => new Promise((resolve) => { resolveSetGoal = resolve; })),
  };

  await Store.load('c1');
  const pending = Store.setGoal('c1', 'ship it');
  await new Promise((resolve) => setTimeout(resolve, 0));

  await Store.refreshGoal('c1');
  expect(Store.getState('c1').goal).toMatchObject({
    objective: 'ship it',
    status: 'active',
    source: 'runtime',
  });

  expect(resolveSetGoal).toBeTruthy();
  (resolveSetGoal as unknown as (value: any) => void)({
    streamReady: true,
    goal: { ...makeGoal('active', 5000), objective: 'ship it', source: 'runtime' },
  });
  await pending;
});

test('replay after turn complete (text → assistant_message) does not duplicate the prior final message', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  // Land a final message exactly as the original turn would: the
  // server emits `text` deltas (which create a placeholder) and then
  // `assistant_message` (which replaces it with the persisted id) and
  // finally `done` (which clears streamingMsgId).
  ws.dispatch({ type: 'text', content: 'final reply' });
  ws.dispatch({
    type: 'assistant_message',
    message: {
      id: 'msg-final-1',
      role: 'assistant',
      content: 'final reply',
      timestamp: '2026-04-26T12:00:00.000Z',
      contentBlocks: [{ type: 'text', content: 'final reply' }],
    },
  });
  ws.dispatch({ type: 'done' });
  expect(Store.getState('c1').messages).toHaveLength(1);
  expect(Store.getState('c1').streamingMsgId).toBeNull();

  // Now simulate a network-change / visibility-revalidate replay: the
  // server replays the same buffered events on the new socket. After
  // turn complete streamingMsgId is null, so the replayed `text` delta
  // creates a *new* placeholder, then `assistant_message` arrives with
  // the same id as the original final message — which without the
  // dedupe leaves two entries sharing one id.
  ws.dispatch({ type: 'replay_start', bufferedEvents: 3 });
  ws.dispatch({ type: 'text', content: 'final reply' });
  ws.dispatch({
    type: 'assistant_message',
    message: {
      id: 'msg-final-1',
      role: 'assistant',
      content: 'final reply',
      timestamp: '2026-04-26T12:00:00.000Z',
      contentBlocks: [{ type: 'text', content: 'final reply' }],
    },
  });
  ws.dispatch({ type: 'done' });
  ws.dispatch({ type: 'replay_end' });

  const after = Store.getState('c1');
  expect(after.messages).toHaveLength(1);
  expect(after.messages[0].id).toBe('msg-final-1');
});

test('replay_end is a no-op', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({ type: 'text', content: 'hi' });
  const before = Store.getState('c1');

  ws.dispatch({ type: 'replay_end' });

  const after = Store.getState('c1');
  expect(after.streamingMsgId).toBe(before.streamingMsgId);
  expect(after.messages[after.messages.length - 1].contentBlocks).toEqual(
    before.messages[before.messages.length - 1].contentBlocks
  );
  expect(after.uiState).toBe(before.uiState);
});

test('turn_complete frame is a no-op (does not clear streamingMsgId or drop contentBlocks)', async () => {
  const ws = await openWs('c1');
  const Store = (window as any).StreamStore;

  ws.dispatch({ type: 'text', content: 'hello ' });
  const before = Store.getState('c1');
  const streamingIdBefore = before.streamingMsgId;
  const blocksBefore = before.messages[before.messages.length - 1].contentBlocks;
  expect(streamingIdBefore).toBeTruthy();
  expect(blocksBefore).toHaveLength(1);

  ws.dispatch({ type: 'turn_complete' });

  const after = Store.getState('c1');
  expect(after.streamingMsgId).toBe(streamingIdBefore);
  expect(after.messages[after.messages.length - 1].contentBlocks).toEqual(blocksBefore);
  expect(after.uiState).toBe(before.uiState);
  expect(after.pendingInteraction).toBeNull();
});

test('conversation list applies title patches that arrive while list is loading', async () => {
  const Store = (window as any).StreamStore;
  const api = (global as any).AgentApi;
  let resolveList: (items: unknown[]) => void = () => {};
  api.listConversations = jest.fn(() => new Promise(resolve => {
    resolveList = resolve;
  }));

  const loading = Store.loadConvList({ query: '', archived: false });
  expect(Store.getConvList().items).toBeNull();

  Store.patchConvListItem('c1', { title: 'Generated Title' });
  resolveList([
    { id: 'c1', title: 'First user message prefix', updatedAt: '2026-05-01T12:00:00.000Z' },
  ]);
  await loading;

  expect(Store.getConvList().items).toEqual([
    { id: 'c1', title: 'Generated Title', updatedAt: '2026-05-01T12:00:00.000Z' },
  ]);
});

describe('attachment + queue helpers', () => {
  test('attachmentKindFromPath infers kind from extension', () => {
    const Store = (window as any).StreamStore;
    expect(Store.attachmentKindFromPath('/tmp/a.png')).toBe('image');
    expect(Store.attachmentKindFromPath('/tmp/b.PDF')).toBe('pdf');
    expect(Store.attachmentKindFromPath('/tmp/c.md')).toBe('md');
    expect(Store.attachmentKindFromPath('/tmp/d.txt')).toBe('text');
    expect(Store.attachmentKindFromPath('/tmp/e.ts')).toBe('code');
    expect(Store.attachmentKindFromPath('/tmp/f.bin')).toBe('file');
    expect(Store.attachmentKindFromPath('/tmp/noext')).toBe('file');
  });

  test('parseUploadedFilesTag extracts paths and strips the tag', () => {
    const Store = (window as any).StreamStore;
    const result = Store.parseUploadedFilesTag('hello\n\n[Uploaded files: /a/x.png, /a/y.pdf]');
    expect(result).toEqual({
      content: 'hello',
      attachments: [
        { name: 'x.png', path: '/a/x.png', kind: 'image' },
        { name: 'y.pdf', path: '/a/y.pdf', kind: 'pdf' },
      ],
    });
  });

  test('parseUploadedFilesTag returns null when no tag present', () => {
    const Store = (window as any).StreamStore;
    expect(Store.parseUploadedFilesTag('hello world')).toBeNull();
    expect(Store.parseUploadedFilesTag('')).toBeNull();
    expect(Store.parseUploadedFilesTag(null as unknown as string)).toBeNull();
  });

  test('blank state has empty pendingAttachments and queue arrays', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const state = Store.getState('c1');
    expect(state.pendingAttachments).toEqual([]);
    expect(state.queue).toEqual([]);
  });
});

describe('queue', () => {
  function queuePutBodies(api: any) {
    return api.fetch.mock.calls
      .filter((call: unknown[]) => call[0] === 'conversations/c1/queue' && (call[1] as any)?.method === 'PUT')
      .map((call: unknown[]) => (call[1] as any).body.queue);
  }

  test('enqueue optimistically updates state and PUTs /queue', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch.mockResolvedValueOnce(makeResponse({ ok: true }));

    await Store.enqueue('c1', 'later message', [
      { name: 'x.png', path: '/a/x.png', kind: 'image' },
    ]);

    const state = Store.getState('c1');
    expect(state.queue).toEqual([
      { content: 'later message', attachments: [{ name: 'x.png', path: '/a/x.png', kind: 'image' }] },
    ]);
    expect(api.fetch).toHaveBeenCalledWith(
      'conversations/c1/queue',
      expect.objectContaining({ method: 'PUT' }),
    );
    const body = api.fetch.mock.calls[0][1].body;
    expect(body.queue).toEqual(state.queue);
  });

  test('removeFromQueue drops the entry and PUTs the shortened queue', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch
      .mockResolvedValueOnce(makeResponse({ ok: true }))  // enqueue #1
      .mockResolvedValueOnce(makeResponse({ ok: true }))  // enqueue #2
      .mockResolvedValueOnce(makeResponse({ ok: true })); // remove

    await Store.enqueue('c1', 'a', []);
    await Store.enqueue('c1', 'b', []);
    await Store.removeFromQueue('c1', 0);

    expect(Store.getState('c1').queue).toEqual([{ content: 'b', attachments: [] }]);
    expect(api.fetch.mock.calls[2][1].body.queue).toEqual([{ content: 'b', attachments: [] }]);
  });

  test('clearQueue empties state and DELETEs /queue', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch
      .mockResolvedValueOnce(makeResponse({ ok: true }))
      .mockResolvedValueOnce(makeResponse({ ok: true }));

    await Store.enqueue('c1', 'a', []);
    await Store.clearQueue('c1');

    expect(Store.getState('c1').queue).toEqual([]);
    expect(api.fetch.mock.calls[1]).toEqual([
      'conversations/c1/queue',
      expect.objectContaining({ method: 'DELETE' }),
    ]);
  });

  test('done frame auto-drains queue head as a wire-format /message', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    await startAcceptedStream('c1', ws);
    api.fetch
      .mockResolvedValueOnce(makeResponse({ ok: true }))            // enqueue PUT
      .mockResolvedValueOnce(makeResponse({ userMessage: null }))   // drainer POST /message
      .mockResolvedValueOnce(makeResponse({ ok: true }));           // drainer persist PUT

    await Store.enqueue('c1', 'queued text', [
      { name: 'x.png', path: '/tmp/x.png', kind: 'image' },
    ]);

    // simulate a finished stream with no pending interaction
    ws.dispatch({ type: 'done' });

    // let the setTimeout(0) fire and the async send() chain run
    await new Promise(r => setTimeout(r, 5));

    const postCall = api.fetch.mock.calls.find((c: unknown[]) => c[0] === 'conversations/c1/message');
    expect(postCall).toBeDefined();
    expect(postCall![1].method).toBe('POST');
    expect(postCall![1].body.content).toBe('queued text\n\n[Uploaded files: /tmp/x.png]');
    expect(Store.getState('c1').queue).toEqual([]);
  });

  test('queued send success persists edits made to later queue items while head is in flight', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    let resolvePost!: (value: unknown) => void;
    const postPromise = new Promise(resolve => { resolvePost = resolve; });

    await startAcceptedStream('c1', ws);
    api.fetch.mockImplementation((url: string) => {
      if (url === 'conversations/c1/message') return postPromise;
      return Promise.resolve(makeResponse({ ok: true }));
    });

    await Store.enqueue('c1', 'head', []);
    await Store.enqueue('c1', 'tail', []);

    ws.dispatch({ type: 'done' });
    await new Promise(r => setTimeout(r, 5));
    expect(api.fetch.mock.calls.some((call: unknown[]) => call[0] === 'conversations/c1/message')).toBe(true);
    expect(Store.getState('c1').queue).toEqual([{ content: 'tail', attachments: [] }]);

    await Store.updateQueueItem('c1', 0, { content: 'edited tail' });
    resolvePost(makeResponse({ userMessage: null }));
    await new Promise(r => setTimeout(r, 5));

    expect(Store.getState('c1').queue).toEqual([{ content: 'edited tail', attachments: [] }]);
    const bodies = queuePutBodies(api);
    expect(bodies[bodies.length - 1]).toEqual([{ content: 'edited tail', attachments: [] }]);
  });

  test('queued send 409 restores original head with attachments and active-stream state', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    const err = new Error('Conversation is already streaming') as Error & { status?: number };
    err.status = 409;

    await startAcceptedStream('c1', ws);
    api.fetch
      .mockResolvedValueOnce(makeResponse({ ok: true }))
      .mockRejectedValueOnce(err);

    const attachment = { name: 'x.png', path: '/tmp/x.png', kind: 'image' };
    await Store.enqueue('c1', 'queued text', [attachment]);

    ws.dispatch({ type: 'done' });
    await new Promise(r => setTimeout(r, 5));

    const state = Store.getState('c1');
    expect(state.queue).toEqual([{ content: 'queued text', attachments: [attachment] }]);
    expect(state.streaming).toBe(true);
    expect(state.uiState).toBe('streaming');
    expect(state.streamError).toBeNull();
    expect(state.messages.some((m: any) => String(m.id).startsWith('pending-'))).toBe(false);
  });

  test('queued send 409 preserves edits made to later queue items while head is in flight', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    const err = new Error('Conversation is already streaming') as Error & { status?: number };
    err.status = 409;
    let rejectPost!: (err: Error) => void;
    const postPromise = new Promise((_resolve, reject) => { rejectPost = reject; });

    await startAcceptedStream('c1', ws);
    api.fetch.mockImplementation((url: string) => {
      if (url === 'conversations/c1/message') return postPromise;
      return Promise.resolve(makeResponse({ ok: true }));
    });

    await Store.enqueue('c1', 'head', []);
    await Store.enqueue('c1', 'tail', []);

    ws.dispatch({ type: 'done' });
    await new Promise(r => setTimeout(r, 5));
    expect(api.fetch.mock.calls.some((call: unknown[]) => call[0] === 'conversations/c1/message')).toBe(true);
    expect(Store.getState('c1').queue).toEqual([{ content: 'tail', attachments: [] }]);

    await Store.updateQueueItem('c1', 0, { content: 'edited tail' });
    rejectPost(err);
    await new Promise(r => setTimeout(r, 5));

    expect(Store.getState('c1').queue).toEqual([
      { content: 'head', attachments: [] },
      { content: 'edited tail', attachments: [] },
    ]);
    const bodies = queuePutBodies(api);
    expect(bodies[bodies.length - 1]).toEqual([
      { content: 'head', attachments: [] },
      { content: 'edited tail', attachments: [] },
    ]);
  });

  test('queued send restores and persists head when WebSocket open fails before POST', async () => {
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    FakeWS.autoOpen = false;
    api.fetch.mockImplementation(() => Promise.resolve(makeResponse({ ok: true })));

    await Store.enqueue('c1', 'head', []);
    Store.resumeSuspendedQueue('c1');
    await new Promise(r => setTimeout(r, 5));

    expect(fakeWSInstance).toBeTruthy();
    fakeWSInstance!.failOpen();
    await new Promise(r => setTimeout(r, 5));

    const state = Store.getState('c1');
    expect(state.queue).toEqual([{ content: 'head', attachments: [] }]);
    expect(state.sending).toBe(false);
    expect(state.streamError).toBe('WebSocket failed');
    expect(api.fetch.mock.calls.some((call: unknown[]) => call[0] === 'conversations/c1/message')).toBe(false);
    const bodies = queuePutBodies(api);
    expect(bodies[bodies.length - 1]).toEqual([{ content: 'head', attachments: [] }]);
  });

  test('done frame does NOT drain queue when pendingInteraction is set', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    await startAcceptedStream('c1', ws);
    api.fetch.mockResolvedValueOnce(makeResponse({ ok: true })); // enqueue PUT only

    await Store.enqueue('c1', 'queued text', []);

    ws.dispatch({
      type: 'tool_activity', tool: 'ExitPlanMode',
      isPlanMode: true, planAction: 'exit', planContent: 'p', id: 't',
    });
    ws.dispatch({ type: 'done' });

    await new Promise(r => setTimeout(r, 5));

    // Queue untouched, no POST /message.
    expect(Store.getState('c1').queue).toEqual([{ content: 'queued text', attachments: [] }]);
    expect(api.fetch.mock.calls.some((c: unknown[]) => c[0] === 'conversations/c1/message')).toBe(false);
  });

  test('replayed done after completion does NOT drain queue added after the original completion', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    await startAcceptedStream('c1', ws);
    ws.dispatch({ type: 'done' });
    expect(Store.getState('c1').streaming).toBe(false);

    api.fetch.mockResolvedValueOnce(makeResponse({ ok: true })); // enqueue PUT only
    await Store.enqueue('c1', 'queued after done', []);

    ws.dispatch({ type: 'replay_start', bufferedEvents: 1 });
    ws.dispatch({ type: 'done' });
    ws.dispatch({ type: 'replay_end' });
    await new Promise(r => setTimeout(r, 5));

    expect(Store.getState('c1').queue).toEqual([{ content: 'queued after done', attachments: [] }]);
    expect(api.fetch.mock.calls.some((c: unknown[]) => c[0] === 'conversations/c1/message')).toBe(false);
  });

  test('updateQueueItem patches text + attachments and PUTs the full queue', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch
      .mockResolvedValueOnce(makeResponse({ ok: true })) // enqueue
      .mockResolvedValueOnce(makeResponse({ ok: true })); // updateQueueItem persist

    await Store.enqueue('c1', 'original', [
      { name: 'a.png', path: '/a/a.png', kind: 'image' },
    ]);

    await Store.updateQueueItem('c1', 0, {
      content: 'edited',
      attachments: [{ name: 'b.pdf', path: '/a/b.pdf', kind: 'pdf' }],
    });

    expect(Store.getState('c1').queue).toEqual([
      { content: 'edited', attachments: [{ name: 'b.pdf', path: '/a/b.pdf', kind: 'pdf' }] },
    ]);
    expect(api.fetch.mock.calls[1][1].body.queue).toEqual([
      { content: 'edited', attachments: [{ name: 'b.pdf', path: '/a/b.pdf', kind: 'pdf' }] },
    ]);
  });

  test('updateQueueItem with only content preserves existing attachments', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch
      .mockResolvedValueOnce(makeResponse({ ok: true }))
      .mockResolvedValueOnce(makeResponse({ ok: true }));

    const atts = [{ name: 'a.png', path: '/a/a.png', kind: 'image' }];
    await Store.enqueue('c1', 'original', atts);

    await Store.updateQueueItem('c1', 0, { content: 'edited' });

    expect(Store.getState('c1').queue).toEqual([
      { content: 'edited', attachments: atts },
    ]);
  });

  test('queue persistence coalesces in-flight PUTs so latest queue wins', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    let resolveFirstPut!: (value: unknown) => void;
    const firstPut = new Promise(resolve => { resolveFirstPut = resolve; });
    let queuePutCount = 0;

    api.fetch.mockImplementation((url: string, opts: any) => {
      if (url === 'conversations/c1/queue' && opts?.method === 'PUT') {
        queuePutCount += 1;
        if (queuePutCount === 1) return firstPut;
      }
      return Promise.resolve(makeResponse({ ok: true }));
    });

    const enqueuePromise = Store.enqueue('c1', 'original', []);
    await Promise.resolve();
    expect(queuePutCount).toBe(1);

    const updatePromise = Store.updateQueueItem('c1', 0, { content: 'latest' });
    await Promise.resolve();
    expect(queuePutCount).toBe(1);

    resolveFirstPut(makeResponse({ ok: true }));
    await Promise.all([enqueuePromise, updatePromise]);

    const bodies = queuePutBodies(api);
    expect(queuePutCount).toBe(2);
    expect(bodies).toEqual([
      [{ content: 'original', attachments: [] }],
      [{ content: 'latest', attachments: [] }],
    ]);
  });

  test('updateQueueItem ignores out-of-range index without a request', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    api.fetch.mockResolvedValueOnce(makeResponse({ ok: true })); // enqueue only
    await Store.enqueue('c1', 'a', []);

    await Store.updateQueueItem('c1', 5, { content: 'nope' });

    expect(Store.getState('c1').queue).toEqual([{ content: 'a', attachments: [] }]);
    // Only the enqueue PUT happened.
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('clearStreamError', () => {
  test('clears streamError and uiState but keeps queue untouched', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch.mockResolvedValueOnce(makeResponse({ ok: true })); // enqueue

    await Store.enqueue('c1', 'later', []);
    // Simulate a WS error landing.
    (window as any).StreamStore; // already loaded
    // Trigger an error frame.
    const ws = fakeWSInstance!;
    ws.dispatch({ type: 'error', error: 'boom', source: 'server' });

    expect(Store.getState('c1').streamError).toBe('boom');
    expect(Store.getState('c1').streamErrorSource).toBe('server');

    Store.clearStreamError('c1');

    const s = Store.getState('c1');
    expect(s.streamError).toBeNull();
    expect(s.streamErrorSource).toBeNull();
    expect(s.uiState).toBeNull();
    // Queue is not drained when resumeQueue is not requested.
    expect(s.queue).toEqual([{ content: 'later', attachments: [] }]);
    expect(api.fetch.mock.calls.some((c: unknown[]) => c[0] === 'conversations/c1/message')).toBe(false);
  });

  test('preserves pendingInteraction and flips uiState back to awaiting', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;

    // Land a plan-approval pending interaction first, then an error.
    ws.dispatch({
      type: 'tool_activity', tool: 'ExitPlanMode',
      isPlanMode: true, planAction: 'exit', planContent: 'p', id: 't',
    });
    // Directly mutate into error state via an error frame.
    ws.dispatch({ type: 'error', error: 'x' });

    expect(Store.getState('c1').streamError).toBe('x');
    // Error frame clears pendingInteraction in the store — so rehydrate by
    // dispatching the plan frame again for this test.
    ws.dispatch({
      type: 'tool_activity', tool: 'ExitPlanMode',
      isPlanMode: true, planAction: 'exit', planContent: 'p', id: 't2',
    });

    Store.clearStreamError('c1');

    const s = Store.getState('c1');
    expect(s.streamError).toBeNull();
    expect(s.pendingInteraction).not.toBeNull();
    expect(s.uiState).toBe('awaiting');
  });

  test('resumeQueue=true drains the head of the queue after clearing', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    api.fetch
      .mockResolvedValueOnce(makeResponse({ ok: true }))            // enqueue
      .mockResolvedValueOnce(makeResponse({ ok: true }))            // drainer persist
      .mockResolvedValueOnce(makeResponse({ userMessage: null }));  // drainer POST /message

    await Store.enqueue('c1', 'resumable', []);
    ws.dispatch({ type: 'error', error: 'oops' });
    expect(Store.getState('c1').streamError).toBe('oops');

    Store.clearStreamError('c1', { resumeQueue: true });
    await new Promise(r => setTimeout(r, 5));

    const postCall = api.fetch.mock.calls.find((c: unknown[]) => c[0] === 'conversations/c1/message');
    expect(postCall).toBeDefined();
    expect(postCall![1].body.content).toBe('resumable');
    expect(Store.getState('c1').queue).toEqual([]);
  });

  test('resumeQueue=true with empty queue is a safe no-op', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    ws.dispatch({ type: 'error', error: 'oops' });
    Store.clearStreamError('c1', { resumeQueue: true });
    await new Promise(r => setTimeout(r, 5));

    expect(Store.getState('c1').streamError).toBeNull();
    expect(api.fetch.mock.calls.some((c: unknown[]) => c[0] === 'conversations/c1/message')).toBe(false);
  });
});

describe('stopStream', () => {
  test('POSTs REST abort and clears local streaming state while streaming', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    const abortMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'Stream failed: Aborted by user',
      streamError: { message: 'Aborted by user', source: 'abort' },
    };
    api.fetch
      .mockResolvedValueOnce(makeResponse({ userMessage: null }))
      .mockResolvedValueOnce(makeResponse({
        id: 'c1',
        messages: [
          { id: 'u1', role: 'user', content: 'hello' },
          abortMessage,
        ],
        messageQueue: [],
        sessionUsage: null,
      }));

    await Store.send('c1', 'hello');
    expect(Store.getState('c1').streaming).toBe(true);

    await Store.stopStream('c1');

    expect(api.abortConversation).toHaveBeenCalledWith('c1');
    expect(Store.getState('c1').streaming).toBe(false);
    expect(Store.getState('c1').streamError).toBe('Aborted by user');
    expect(Store.getState('c1').streamErrorSource).toBe('abort');
    expect(Store.getState('c1').uiState).toBe('error');
    expect(Store.getState('c1').messages.some((m: any) => String(m.id).startsWith('pending-'))).toBe(false);

    ws.dispatch({ type: 'assistant_message', message: abortMessage });
    expect(Store.getState('c1').messages.filter((m: any) => m.id === 'a1')).toHaveLength(1);
  });

  test('no-op when not streaming', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    expect(Store.getState('c1').streaming).toBe(false);
    await Store.stopStream('c1');

    expect(api.abortConversation).not.toHaveBeenCalled();
  });

  test('uses REST abort when WS is closed but server stream is still active', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch
      .mockResolvedValueOnce(makeResponse({ userMessage: null }))
      .mockResolvedValueOnce(makeResponse({
        id: 'c1',
        messages: [{
          id: 'a1',
          role: 'assistant',
          content: 'Stream failed: Aborted by user',
          streamError: { message: 'Aborted by user', source: 'abort' },
        }],
        messageQueue: [],
        sessionUsage: null,
      }));

    await Store.send('c1', 'hello');
    ws.close();

    await Store.stopStream('c1');

    expect(api.abortConversation).toHaveBeenCalledWith('c1');
    expect(Store.getState('c1').streaming).toBe(false);
    expect(Store.getState('c1').messages.some((m: any) => String(m.id).startsWith('pending-'))).toBe(false);
  });

  test('successful REST abort unsticks local UI even when refetch fails', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch
      .mockResolvedValueOnce(makeResponse({ userMessage: null }))
      .mockRejectedValueOnce(new Error('refetch failed'));
    api.abortConversation.mockResolvedValueOnce({ ok: true, aborted: true });

    await Store.send('c1', 'hello');
    const assistantId = Store.getState('c1').streamingMsgId;
    expect(Store.getState('c1').streaming).toBe(true);

    await Store.stopStream('c1');

    const state = Store.getState('c1');
    expect(api.abortConversation).toHaveBeenCalledWith('c1');
    expect(state.streaming).toBe(false);
    expect(state.streamingMsgId).toBeNull();
    expect(state.streamError).toBe('Aborted by user');
    expect(state.streamErrorSource).toBe('abort');
    expect(state.uiState).toBe('error');
    expect(state.messages.some((m: any) => m.id === assistantId)).toBe(false);
  });

  test('refreshes conversation when REST abort finds no active stream', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch
      .mockResolvedValueOnce(makeResponse({ userMessage: null }))
      .mockResolvedValueOnce(makeResponse({ id: 'c1', messages: [{ id: 'm1', role: 'assistant', content: 'done' }], messageQueue: [], sessionUsage: null }));
    api.abortConversation.mockResolvedValueOnce({ ok: true, aborted: false });

    await Store.send('c1', 'hello');
    await Store.stopStream('c1');

    const state = Store.getState('c1');
    expect(state.streaming).toBe(false);
    expect(state.messages).toEqual([{ id: 'm1', role: 'assistant', content: 'done' }]);
  });

  test('refresh after natural-completion race preserves durable streamError and does not drain queue', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch
      .mockResolvedValueOnce(makeResponse({ userMessage: null }))
      .mockResolvedValueOnce(makeResponse({
        id: 'c1',
        messages: [{
          id: 'e1',
          role: 'assistant',
          content: 'Stream failed: usage limit reached',
          streamError: { message: 'usage limit reached', source: 'backend' },
        }],
        messageQueue: [{ content: 'queued', attachments: [] }],
        sessionUsage: null,
      }));
    api.abortConversation.mockResolvedValueOnce({ ok: true, aborted: false });

    await Store.send('c1', 'hello');
    await Store.stopStream('c1');

    const state = Store.getState('c1');
    expect(state.streaming).toBe(false);
    expect(state.streamError).toBe('usage limit reached');
    expect(state.uiState).toBe('error');
    expect(state.queue).toEqual([{ content: 'queued', attachments: [] }]);
    expect(api.fetch.mock.calls.filter((call: unknown[]) => call[0] === 'conversations/c1/message')).toHaveLength(1);
  });
});

/* Draft localStorage persistence (#33) — the composer text + completed
   uploads are mirrored to `ac:v2:draft:<convId>` so a tab crash doesn't
   lose work. Save is debounced 150 ms; clear fires on successful send and
   on enqueue. Rehydrate happens in load() when the live composer is idle. */
describe('draft persistence', () => {
  const KEY = 'ac:v2:draft:c1';

  beforeEach(() => {
    localStorage.clear();
  });

  test('setInput debounces a write to localStorage', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;

    Store.setInput('c1', 'hello');
    expect(localStorage.getItem(KEY)).toBeNull();

    await new Promise(r => setTimeout(r, 200));
    const raw = localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ text: 'hello', attachments: [] });
  });

  test('empty text removes the key', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;

    Store.setInput('c1', 'hello');
    await new Promise(r => setTimeout(r, 200));
    expect(localStorage.getItem(KEY)).not.toBeNull();

    Store.setInput('c1', '');
    await new Promise(r => setTimeout(r, 200));
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test('enqueue clears the draft', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch.mockResolvedValue(makeResponse({ ok: true }));

    Store.setInput('c1', 'hello');
    await new Promise(r => setTimeout(r, 200));
    expect(localStorage.getItem(KEY)).not.toBeNull();

    await Store.enqueue('c1', 'hello', []);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test('load() rehydrates an idle composer from localStorage', async () => {
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    localStorage.setItem(KEY, JSON.stringify({
      text: 'unsent draft',
      attachments: [{ name: 'notes.txt', path: 'artifacts/notes.txt', kind: 'text' }],
    }));

    api.fetch.mockResolvedValueOnce(makeResponse({
      id: 'c1', messages: [], messageQueue: [],
    }));

    await Store.load('c1');
    const state = Store.getState('c1');
    expect(state.input).toBe('unsent draft');
    expect(state.pendingAttachments).toHaveLength(1);
    expect(state.pendingAttachments[0].status).toBe('done');
    expect(state.pendingAttachments[0].result.path).toBe('artifacts/notes.txt');
    expect(state.pendingAttachments[0].restored).toBe(true);
  });

  test('load() rehydrates active streamError from final persisted stream-error message', async () => {
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    api.fetch.mockResolvedValueOnce(makeResponse({
      id: 'c1',
      messages: [
        {
          id: 'e1',
          role: 'assistant',
          content: 'Stream failed: usage limit reached',
          streamError: { message: 'usage limit reached', source: 'backend' },
        },
      ],
      messageQueue: [],
    }));

    await Store.load('c1');

    const state = Store.getState('c1');
    expect(state.streamError).toBe('usage limit reached');
    expect(state.streamErrorSource).toBe('backend');
    expect(state.uiState).toBe('error');
  });

  test('load() ignores older stream-error messages followed by normal conversation activity', async () => {
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    api.fetch.mockResolvedValueOnce(makeResponse({
      id: 'c1',
      messages: [
        {
          id: 'e1',
          role: 'assistant',
          content: 'Stream failed: old failure',
          streamError: { message: 'old failure', source: 'backend' },
        },
        { id: 'u2', role: 'user', content: 'continue' },
      ],
      messageQueue: [],
    }));

    await Store.load('c1');

    const state = Store.getState('c1');
    expect(state.streamError).toBeNull();
    expect(state.uiState).toBeNull();
  });

  test('load() does NOT overwrite a live composer', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    localStorage.setItem(KEY, JSON.stringify({ text: 'stale draft', attachments: [] }));

    Store.setInput('c1', 'live input');
    await new Promise(r => setTimeout(r, 200));

    api.fetch.mockResolvedValueOnce(makeResponse({
      id: 'c1', messages: [], messageQueue: [],
    }));
    await Store.load('c1');
    expect(Store.getState('c1').input).toBe('live input');
  });

  /* Session-expired mid-send (401): send() wipes the composer optimistically
     for a snappy "message queued" feel, then on POST failure must restore
     BOTH input and pendingAttachments so the user doesn't have to retype or
     re-upload. Also verifies the localStorage copy survives the failure so
     a full reload (popup blocked → fallback redirect) hydrates the draft. */
  test('POST failure restores input and keeps the persisted draft', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    Store.setInput('c1', 'my message');
    await new Promise(r => setTimeout(r, 200));
    expect(localStorage.getItem(KEY)).not.toBeNull();

    api.fetch.mockRejectedValueOnce(new Error('Session expired'));
    await Store.send('c1', 'my message');

    const state = Store.getState('c1');
    expect(state.input).toBe('my message');
    expect(state.streamError).toBe('Session expired');
    expect(state.sending).toBe(false);
    const raw = localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ text: 'my message', attachments: [] });
  });

  test('POST 409 rolls back optimistic send and returns to active-stream state', async () => {
    await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    Store.setInput('c1', 'raced message');
    const err = new Error('Conversation is already streaming') as Error & { status?: number };
    err.status = 409;
    api.fetch.mockRejectedValueOnce(err);

    await Store.send('c1', 'raced message');

    const state = Store.getState('c1');
    expect(state.input).toBe('raced message');
    expect(state.streaming).toBe(true);
    expect(state.uiState).toBe('streaming');
    expect(state.streamError).toBeNull();
    expect(state.messages.some((m: any) => String(m.id).startsWith('pending-'))).toBe(false);
  });

  /* clearAllStreamErrors (called by the shell after a silent re-auth)
     sweeps streamError on every conv that has one so stale session-expired
     error cards disappear once the session is back. */
  test('clearAllStreamErrors clears errors across every conv', async () => {
    await openWs('c1');
    await openWs('c2');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    api.fetch.mockRejectedValueOnce(new Error('Session expired'));
    await Store.send('c1', 'msg one');
    api.fetch.mockRejectedValueOnce(new Error('Session expired'));
    await Store.send('c2', 'msg two');

    expect(Store.getState('c1').streamError).toBe('Session expired');
    expect(Store.getState('c2').streamError).toBe('Session expired');

    Store.clearAllStreamErrors();
    expect(Store.getState('c1').streamError).toBeNull();
    expect(Store.getState('c2').streamError).toBeNull();
  });
});

describe('unread', () => {
  test('done frame on a non-active conv flips unread:true and POSTs the flag', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    Store.setActiveConvId('other');
    await startAcceptedStream('c1', ws);

    ws.dispatch({ type: 'done' });

    expect(Store.getState('c1').unread).toBe(true);
    expect(api.markConversationUnread).toHaveBeenCalledWith('c1', true);
    expect(Store.convStates()['c1']).toBe('unread');
  });

  test('done frame on the active conv does NOT mark unread', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    Store.setActiveConvId('c1');
    await startAcceptedStream('c1', ws);

    ws.dispatch({ type: 'done' });

    expect(Store.getState('c1').unread).toBe(false);
    expect(api.markConversationUnread).not.toHaveBeenCalled();
    expect(Store.convStates()['c1']).toBe('idle');
  });

  test('done frame with pendingInteraction does NOT mark unread (awaiting wins)', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    Store.setActiveConvId('other');
    await startAcceptedStream('c1', ws);

    ws.dispatch({
      type: 'tool_activity', tool: 'ExitPlanMode',
      isPlanMode: true, planAction: 'exit', planContent: 'p', id: 't',
    });
    ws.dispatch({ type: 'done' });

    expect(Store.getState('c1').unread).toBe(false);
    expect(api.markConversationUnread).not.toHaveBeenCalled();
    expect(Store.convStates()['c1']).toBe('awaiting');
  });

  test('done frame with streamError does NOT mark unread (error wins)', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    Store.setActiveConvId('other');
    await startAcceptedStream('c1', ws);

    ws.dispatch({ type: 'error', error: 'boom' });
    ws.dispatch({ type: 'done' });

    expect(Store.getState('c1').unread).toBe(false);
    expect(api.markConversationUnread).not.toHaveBeenCalled();
    expect(Store.convStates()['c1']).toBe('error');
  });

  test('markRead clears unread and POSTs unread:false', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    Store.setActiveConvId('other');
    await startAcceptedStream('c1', ws);
    ws.dispatch({ type: 'done' });
    expect(Store.getState('c1').unread).toBe(true);
    api.markConversationUnread.mockClear();

    Store.markRead('c1');

    expect(Store.getState('c1').unread).toBe(false);
    expect(api.markConversationUnread).toHaveBeenCalledWith('c1', false);
    expect(Store.convStates()['c1']).toBe('idle');
  });

  test('markRead on a cold conv creates an idle entry to override stale c.unread', async () => {
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    expect(Store.getState('cold')).toBeNull();

    Store.markRead('cold');

    expect(Store.getState('cold')).not.toBeNull();
    expect(Store.getState('cold').unread).toBe(false);
    expect(Store.convStates()['cold']).toBe('idle');
    expect(api.markConversationUnread).toHaveBeenCalledWith('cold', false);
  });

  test('markUnread on a cold conv creates an unread entry and POSTs', async () => {
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

    Store.markUnread('cold');

    expect(Store.getState('cold').unread).toBe(true);
    expect(Store.convStates()['cold']).toBe('unread');
    expect(api.markConversationUnread).toHaveBeenCalledWith('cold', true);
  });

  test('subscribeGlobal fires when a new conv first enters convStates', async () => {
    const Store = (window as any).StreamStore;
    const listener = jest.fn();
    Store.subscribeGlobal(listener);

    Store.markUnread('cold');

    expect(listener).toHaveBeenCalled();
  });
});

// ── Memory update frames ───────────────────────────────────────────────────

describe('memory_update frames', () => {
  test('refresh-only memory_update dispatches workspace event without appending a chat bubble', async () => {
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch.mockResolvedValueOnce(makeResponse({
      id: 'c1',
      workspaceHash: 'hash-1',
      messages: [],
      messageQueue: [],
    }));
    await Store.load('c1');
    const ws = await openWs('c1');

    const listener = jest.fn();
    window.addEventListener('ac:memory-update', listener);
    try {
      ws.dispatch({
        type: 'memory_update',
        capturedAt: '2026-05-05T12:00:00.000Z',
        fileCount: 1,
        changedFiles: ['notes/example.md'],
        sourceConversationId: 'other-conv',
        displayInChat: false,
        writeOutcomes: [{
          action: 'saved',
          reason: 'Saved memory note.',
          filename: 'notes/example.md',
        }],
      });

      expect(Store.getState('c1').messages).toHaveLength(0);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].detail).toMatchObject({
        hash: 'hash-1',
        capturedAt: '2026-05-05T12:00:00.000Z',
        fileCount: 1,
        changedFiles: ['notes/example.md'],
        sourceConversationId: 'other-conv',
        displayInChat: false,
        writeOutcomes: [{
          action: 'saved',
          reason: 'Saved memory note.',
          filename: 'notes/example.md',
        }],
      });
    } finally {
      window.removeEventListener('ac:memory-update', listener);
    }
  });

  test('displayable memory_update appends one in-chat memory bubble', async () => {
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch.mockResolvedValueOnce(makeResponse({
      id: 'c1',
      workspaceHash: 'hash-1',
      messages: [],
      messageQueue: [],
    }));
    await Store.load('c1');
    const ws = await openWs('c1');

    ws.dispatch({
      type: 'memory_update',
      capturedAt: '2026-05-05T12:00:00.000Z',
      fileCount: 1,
      changedFiles: ['notes/example.md'],
      sourceConversationId: 'c1',
      displayInChat: true,
      writeOutcomes: [{
        action: 'redacted_saved',
        reason: 'Saved after redaction.',
        filename: 'notes/example.md',
      }],
    });

    const messages = Store.getState('c1').messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'memory',
      timestamp: '2026-05-05T12:00:00.000Z',
      memoryUpdate: {
        fileCount: 1,
        changedFiles: ['notes/example.md'],
        sourceConversationId: 'c1',
        writeOutcomes: [{
          action: 'redacted_saved',
          reason: 'Saved after redaction.',
          filename: 'notes/example.md',
        }],
      },
    });
  });
});

describe('memory_review_update frames', () => {
  test('patches conversation Memory Review status and dispatches workspace event', async () => {
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch.mockResolvedValueOnce(makeResponse({
      id: 'c1',
      workspaceHash: 'hash-1',
      messages: [],
      messageQueue: [],
      memoryReview: { enabled: true, pending: false, pendingRuns: 0, pendingDrafts: 0, pendingSafeActions: 0, failedItems: 0 },
    }));
    await Store.load('c1');
    const ws = await openWs('c1');
    const listener = jest.fn();
    window.addEventListener('ac:memory-review-update', listener);
    try {
      const review = {
        enabled: true,
        pending: true,
        pendingRuns: 1,
        pendingDrafts: 2,
        pendingSafeActions: 1,
        failedItems: 0,
        latestRunId: 'memreview_123',
      };
      ws.dispatch({
        type: 'memory_review_update',
        updatedAt: '2026-05-06T01:00:00.000Z',
        review,
      });

      expect(Store.getState('c1').conv.memoryReview).toEqual(review);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].detail).toMatchObject({
        hash: 'hash-1',
        updatedAt: '2026-05-06T01:00:00.000Z',
        review,
      });
    } finally {
      window.removeEventListener('ac:memory-review-update', listener);
    }
  });
});

describe('context_map_update frames', () => {
  test('patches conversation Context Map status and dispatches workspace event', async () => {
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.fetch.mockResolvedValueOnce(makeResponse({
      id: 'c1',
      workspaceHash: 'hash-1',
      messages: [],
      messageQueue: [],
      contextMap: { enabled: true, pending: false, pendingCandidates: 0, staleCandidates: 0, conflictCandidates: 0, failedCandidates: 0, runningRuns: 0, failedRuns: 0 },
    }));
    await Store.load('c1');
    const ws = await openWs('c1');
    const listener = jest.fn();
    window.addEventListener('ac:context-map-update', listener);
    try {
      const contextMap = {
        enabled: true,
        pending: true,
        pendingCandidates: 3,
        staleCandidates: 0,
        conflictCandidates: 1,
        failedCandidates: 0,
        runningRuns: 0,
        failedRuns: 0,
        latestRunId: 'cm-run-123',
      };
      ws.dispatch({
        type: 'context_map_update',
        updatedAt: '2026-05-07T23:00:00.000Z',
        contextMap,
      });

      expect(Store.getState('c1').conv.contextMap).toEqual(contextMap);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].detail).toMatchObject({
        hash: 'hash-1',
        updatedAt: '2026-05-07T23:00:00.000Z',
        contextMap,
      });
    } finally {
      window.removeEventListener('ac:context-map-update', listener);
    }
  });
});

// ── WebSocket revalidation on network change / sleep ───────────────────────

describe('WebSocket revalidation', () => {
  test('failed WebSocket open clears stale socket state so retry can create a new socket', async () => {
    const Store = (window as any).StreamStore;
    FakeWS.autoOpen = false;

    const firstOpen = Store.ensureWsOpen('c1');
    const firstWs = fakeWSInstance!;
    firstWs.failOpen();
    await expect(firstOpen).rejects.toThrow('WebSocket failed');
    expect(Store.getState('c1').ws).toBeNull();
    expect(Store.getState('c1').wsOpening).toBeNull();

    FakeWS.autoOpen = true;
    await Store.ensureWsOpen('c1');
    expect(fakeWSInstance).not.toBe(firstWs);
    expect(fakeWSInstance!.readyState).toBe(FakeWS.OPEN);
  });

  test('unexpected close during streaming schedules reconnect', async () => {
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;
    api.getActiveStreams.mockResolvedValueOnce(['c1']);

    await Store.hydrateActiveStreams();
    api.getActiveStreams.mockResolvedValue(['c1']);
    const initialWs = await openWs('c1');

    initialWs.close(1006, 'network lost');
    expect(Store.getState('c1').ws).toBeNull();

    await new Promise(r => setTimeout(r, 1100));
    await new Promise<void>(r => queueMicrotask(() => r()));

    expect(fakeWSInstance).not.toBe(initialWs);
    expect(fakeWSInstance!.readyState).toBe(FakeWS.OPEN);
  });

  test('revalidateAllSockets closes the existing socket and opens a fresh one', async () => {
    const initialWs = await openWs('c1');
    const Store = (window as any).StreamStore;

    expect(initialWs.readyState).toBe(FakeWS.OPEN);

    Store.revalidateAllSockets();

    // Old socket gets closed by the helper.
    expect(initialWs.readyState).toBe(FakeWS.CLOSED);

    // ensureWsOpen creates a new FakeWS — fakeWSInstance reflects the latest.
    const newWs = fakeWSInstance!;
    expect(newWs).not.toBe(initialWs);

    // Wait for the queued microtask in FakeWS.addEventListener('open') so the
    // new socket transitions to OPEN before we assert.
    await new Promise<void>(r => queueMicrotask(() => r()));
    expect(newWs.readyState).toBe(FakeWS.OPEN);
  });

  test('visibility change with >=30s hidden gap triggers revalidation', async () => {
    const initialWs = await openWs('c1');
    const Store = (window as any).StreamStore;

    const t0 = 1_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);

    // Tab goes hidden — record lastHiddenAt = t0.
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    Store._handleVisibilityChange();

    // Advance virtual clock past the 30s threshold.
    dateSpy.mockReturnValue(t0 + 31_000);

    // Tab returns visible — should trigger revalidateAllSockets.
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    Store._handleVisibilityChange();

    expect(initialWs.readyState).toBe(FakeWS.CLOSED);
    expect(fakeWSInstance).not.toBe(initialWs);

    dateSpy.mockRestore();
  });

  test('visibility change with <30s hidden gap does NOT revalidate', async () => {
    const initialWs = await openWs('c1');
    const Store = (window as any).StreamStore;

    const t0 = 2_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    Store._handleVisibilityChange();

    // A brief tab switch — well under the 30s threshold.
    dateSpy.mockReturnValue(t0 + 5_000);

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    Store._handleVisibilityChange();

    // Original socket survives — replay would otherwise wipe the streaming
    // placeholder's contentBlocks unnecessarily.
    expect(initialWs.readyState).toBe(FakeWS.OPEN);
    expect(fakeWSInstance).toBe(initialWs);

    dateSpy.mockRestore();
  });
});
