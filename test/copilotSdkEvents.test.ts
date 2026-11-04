import type { SessionEvent } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import { copilotToolId } from '../src/services/backends/copilotAgents';
import { createCopilotSdkEventState, reduceCopilotSdkEvent } from '../src/services/backends/copilotSdkEvents';

let serial = 0;
const event = (type: SessionEvent['type'], data: object = {}, agentId?: string) =>
  ({ type, data, id: String(++serial), parentId: null, timestamp: '', ...(agentId ? { agentId } : {}) }) as SessionEvent;

test('projects text once, preserves whitespace, and does not mutate the previous state', () => {
  const initial = createCopilotSdkEventState();
  const delta = event('assistant.message_delta', { messageId: 'a', deltaContent: ' café 😀 ' });
  const streamed = reduceCopilotSdkEvent(initial, delta);
  expect(streamed.events).toEqual([{ type: 'text', content: ' café 😀 ', streaming: true }]);
  expect(initial.textDeltas.size).toBe(0);
  expect(reduceCopilotSdkEvent(streamed.state, delta).events).toEqual([]);
  const final = reduceCopilotSdkEvent(streamed.state, event('assistant.message', { messageId: 'a', content: ' café 😀 ' }));
  expect(final.events).toEqual([]);
  expect(reduceCopilotSdkEvent(final.state, event('assistant.message', { messageId: 'a', content: ' café 😀 ' })).events).toEqual([]);
  expect(reduceCopilotSdkEvent(final.state, event('assistant.message_delta', { messageId: 'a', deltaContent: 'late' })).events).toEqual([]);
  const empty = reduceCopilotSdkEvent(final.state, event('assistant.message_delta', { messageId: 'b', deltaContent: '' }));
  expect(reduceCopilotSdkEvent(empty.state, event('assistant.message', { messageId: 'b', content: 'fallback' })).events).toEqual([{ type: 'text', content: 'fallback', streaming: false }]);
});

test('deduplicates reasoning deltas/finals independently from text and supplies non-streamed reasoning', () => {
  let state = createCopilotSdkEventState();
  state = reduceCopilotSdkEvent(state, event('assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'thinking' })).state;
  const final = reduceCopilotSdkEvent(state, event('assistant.reasoning', { reasoningId: 'r', content: 'thinking' }));
  expect(final.events).toEqual([]);
  expect(reduceCopilotSdkEvent(final.state, event('assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'late' })).events).toEqual([]);
  const fallback = reduceCopilotSdkEvent(final.state, event('assistant.reasoning', { reasoningId: 'other', content: 'full' }));
  expect(fallback.events).toEqual([{ type: 'thinking', content: 'full', streaming: false }]);
  expect(reduceCopilotSdkEvent(fallback.state, event('assistant.reasoning', { reasoningId: 'other', content: 'full' })).events).toEqual([]);
});

test('keeps root and child tools separate, remembers names, and deduplicates outcomes', () => {
  const initial = createCopilotSdkEventState();
  let state = reduceCopilotSdkEvent(initial, event('tool.execution_start', { toolCallId: 't', toolName: 'view', arguments: { path: '/tmp/example' } })).state;
  expect(initial.work.tools.size).toBe(0);
  expect(state.work.tools.get(copilotToolId(state.work, null, 't'))?.name).toBe('view');
  expect(reduceCopilotSdkEvent(state, event('tool.execution_start', { toolCallId: 't', toolName: 'view' })).events).toEqual([]);
  expect(reduceCopilotSdkEvent(state, event('tool.execution_complete', { toolCallId: 't', success: false }, 'child')).events).toEqual([]);
  const completed = reduceCopilotSdkEvent(state, event('tool.execution_complete', { toolCallId: 't', success: true, result: { content: '1→hello' } }));
  expect(completed.events).toMatchObject([{ type: 'tool_outcomes', outcomes: [{ toolUseId: copilotToolId(state.work, null, 't'), isError: false, status: 'success' }] }]);
  expect(state.work.tools.has(copilotToolId(state.work, null, 't'))).toBe(true);
  state = completed.state;
  expect(state.work.tools.size).toBe(0);
  expect(reduceCopilotSdkEvent(state, event('tool.execution_complete', { toolCallId: 't', success: true })).events).toEqual([]);
  expect(reduceCopilotSdkEvent(state, event('tool.execution_start', { toolCallId: 't', toolName: 'view' })).events).toEqual([]);
});

test('isolates child prose/errors/idle while recording that child work prevents replay', () => {
  let state = createCopilotSdkEventState();
  for (const e of [event('assistant.message', { messageId: 'a', content: 'CHILD' }, 'child'),
    event('assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'CHILD', parentToolCallId: 'legacy-child' }),
    event('session.error', { message: 'child failed', errorType: 'query' }, 'child'), event('session.idle', {}, 'child')]) {
    const result = reduceCopilotSdkEvent(state, e); expect(result.events).toEqual([]); state = result.state;
  }
  expect(state).toMatchObject({ hasOutput: true, idle: false, error: null });
  expect(state.textFinals.size).toBe(0);
});

test('finishes only at root session idle after activity and ignores late output', () => {
  const initial = createCopilotSdkEventState();
  expect(reduceCopilotSdkEvent(initial, event('session.idle')).state.idle).toBe(false);
  let state = reduceCopilotSdkEvent(initial, event('user.message', { messageId: 'u', content: 'request' })).state;
  state = reduceCopilotSdkEvent(state, event('assistant.turn_end', { turnId: '0' })).state;
  expect(state.idle).toBe(false);
  state = reduceCopilotSdkEvent(state, event('session.idle')).state;
  expect(state.idle).toBe(true);
  expect(reduceCopilotSdkEvent(state, event('assistant.message', { messageId: 'late', content: 'late' })).events).toEqual([]);
});

test('native abort and root errors are terminal and cannot reopen the projection', () => {
  const started = reduceCopilotSdkEvent(createCopilotSdkEventState(), event('assistant.turn_start', { turnId: '0' })).state;
  expect(reduceCopilotSdkEvent(started, event('session.idle', { aborted: true })).events).toEqual([{ type: 'error', error: 'Copilot turn aborted.', source: 'abort' }]);
  const failed = reduceCopilotSdkEvent(started, event('session.error', { message: 'denied', errorType: 'authorization' }));
  expect(failed.events).toEqual([{ type: 'error', error: 'denied' }]);
  expect(reduceCopilotSdkEvent(failed.state, event('assistant.message_delta', { messageId: 'late', deltaContent: 'late' })).events).toEqual([]);
});

test('leaves accounting to the reconciled native metrics API rather than projecting checkpoints', () => {
  const data = { totalPremiumRequests: 2, accountingSnapshot: { tokenDetails: {
    input: { tokenCount: 10 }, output: { tokenCount: 20 }, cache_read: { tokenCount: 3 }, cache_write: { tokenCount: 4 },
  } } };
  const known = reduceCopilotSdkEvent(createCopilotSdkEventState(), event('session.usage_checkpoint', data));
  expect(known.events).toEqual([]);
  expect(reduceCopilotSdkEvent(known.state, event('session.usage_checkpoint', { totalNanoAiu: 100 })).events).toEqual([]);
});

test('projects root context snapshots independently of token charges and ignores child context', () => {
  let state = createCopilotSdkEventState();
  const context = reduceCopilotSdkEvent(state, event('session.usage_info', { currentTokens: 25, tokenLimit: 100, messagesLength: 2 }));
  expect(context.events).toMatchObject([{ type: 'usage', usage: { inputTokens: 0, contextUsagePercentage: 25, contextWindow: { status: 'available', usedTokens: 25, tokenLimit: 100 } } }]);
  state = context.state;
  expect(reduceCopilotSdkEvent(state, event('session.usage_info', { currentTokens: 90, tokenLimit: 100 }, 'child')).events).toEqual([]);
  expect(reduceCopilotSdkEvent(state, event('session.compaction_start')).events).toMatchObject([{ usage: { contextWindow: { status: 'unavailable' } } }]);
});
