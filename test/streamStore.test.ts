/**
 * @jest-environment jsdom
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Frontend test for public/v2/src/streamStore.js (PR 4c scope):
// - plan-mode exit and user-question tool_activity frames produce a
//   pendingInteraction on the ConvState and flip uiState to 'awaiting'
// - respond() delegates to POST /input and falls back to /message when
//   the server signals mode:'message'

import * as fs from 'fs';
import * as path from 'path';

let fakeWSInstance: FakeWS | null = null;

class FakeWS {
  readyState = 0;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onclose: ((e: Event) => void) | null = null;
  constructor(_url: string) {
    fakeWSInstance = this;
  }
  addEventListener(type: string, cb: () => void, _opts?: unknown) {
    if (type === 'open') {
      queueMicrotask(() => { this.readyState = FakeWS.OPEN; cb(); });
    }
  }
  close() {
    this.readyState = FakeWS.CLOSED;
    if (this.onclose) this.onclose({} as Event);
  }
  dispatch(frame: Record<string, unknown>) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) });
  }
}

function makeResponse(body: unknown) {
  return { json: async () => body };
}

function loadStore() {
  const src = fs.readFileSync(path.join(__dirname, '../public/v2/src/streamStore.js'), 'utf8');
  new Function(src).call(window);
}

beforeEach(() => {
  fakeWSInstance = null;
  delete (window as any).StreamStore;

  (global as any).WebSocket = FakeWS;
  Object.defineProperty(window, 'WebSocket', { value: FakeWS, configurable: true, writable: true });

  (global as any).AgentApi = {
    chatWsUrl: (id: string) => `ws://test/conv/${id}`,
    fetch: jest.fn(),
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

  ws.dispatch({ type: 'error', error: 'boom' });

  const state = Store.getState('c1');
  expect(state.pendingInteraction).toBeNull();
  expect(state.uiState).toBe('error');
  expect(state.streamError).toBe('boom');
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

    api.fetch
      .mockResolvedValueOnce(makeResponse({ ok: true }))            // enqueue PUT
      .mockResolvedValueOnce(makeResponse({ ok: true }))            // drainer persist PUT
      .mockResolvedValueOnce(makeResponse({ userMessage: null }));  // drainer POST /message

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

  test('done frame does NOT drain queue when pendingInteraction is set', async () => {
    const ws = await openWs('c1');
    const Store = (window as any).StreamStore;
    const api = (global as any).AgentApi;

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
    ws.dispatch({ type: 'error', error: 'boom' });

    expect(Store.getState('c1').streamError).toBe('boom');

    Store.clearStreamError('c1');

    const s = Store.getState('c1');
    expect(s.streamError).toBeNull();
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

