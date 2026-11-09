import type { SessionEvent } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import { createCopilotWorkState, copilotToolId, reduceCopilotWork, finishCopilotWork } from '../src/services/backends/copilotAgents';
import type { StreamEvent } from '../src/types';

const event = (type: SessionEvent['type'], data: object, agentId?: string) => ({ type, data, agentId }) as SessionEvent;
describe('Copilot delegated work projection', () => {
  let state: ReturnType<typeof createCopilotWorkState>;
  let frames: StreamEvent[];
  const send = (type: SessionEvent['type'], data: object, agentId?: string) => {
    const next = reduceCopilotWork(state, event(type, data, agentId)); state = next.state; frames.push(...next.events); return next.events;
  };
  const start = (id = 'child', taskId = 'spawn', parentId?: string, extra = {}) => send('subagent.started', {
    toolCallId: taskId, agentName: 'general-purpose', agentDisplayName: id, agentDescription: 'Check the fixture', parentId, ...extra,
  }, id);
  const tool = (id = 'same', agentId?: string, extra = {}) => send('tool.execution_start', { toolCallId: id, toolName: 'view', arguments: { path: '/tmp/fixture' }, ...extra }, agentId);
  beforeEach(() => { state = createCopilotWorkState('turn'); frames = []; });

  test('namespaces identical parent/parallel-child tool IDs and preserves all previous maps', () => {
    const initial = state;
    tool(); start('left', 'spawn-left'); start('right', 'spawn-right'); tool('same', 'left'); tool('same', 'right');
    expect(initial.tools.size).toBe(0); expect(initial.agents.size).toBe(0);
    expect(frames.filter(frame => frame.type === 'tool_activity').map(frame => frame.id)).toEqual([
      copilotToolId(state, null, 'same'), copilotToolId(state, null, 'spawn-left'), copilotToolId(state, null, 'spawn-right'),
      copilotToolId(state, 'left', 'same'), copilotToolId(state, 'right', 'same'),
    ]);
    const previous = state;
    send('tool.execution_complete', { toolCallId: 'same', success: false }, 'left');
    expect(previous.finishedTools.size).toBe(0);
    expect(frames.at(-1)).toMatchObject({ type: 'tool_outcomes', outcomes: [{ toolUseId: copilotToolId(state, 'left', 'same'), status: 'error' }] });
    expect(state.tools.has(copilotToolId(state, null, 'same'))).toBe(true);
    expect(state.tools.has(copilotToolId(state, 'right', 'same'))).toBe(true);
    expect(send('tool.execution_complete', { toolCallId: 'same' }, 'left')).toEqual([]);
    expect(send('tool.execution_start', { toolCallId: 'same', toolName: 'view' }, 'left')).toEqual([]);
  });

  test('uses actual native ancestry and flattens nested tools under the top-level card', () => {
    tool('spawn', undefined, { toolName: 'task' });
    expect(frames).toEqual([]);
    start();
    tool('nested', 'child', { toolName: 'task' });
    start('grandchild', 'nested', 'child'); tool('same', 'grandchild');
    const root = copilotToolId(state, null, 'spawn');
    expect(frames.filter(frame => frame.type === 'tool_activity')).toMatchObject([
      { id: root, isAgent: true },
      { id: copilotToolId(state, 'child', 'nested'), isAgent: true, parentAgentId: root },
      { id: copilotToolId(state, 'grandchild', 'same'), parentAgentId: root },
    ]);
    expect(start('grandchild', 'nested', 'child')).toEqual([]);
    expect(start('unowned', 'unknown', 'missing')).toEqual([]);
  });

  test('captures only final child prose as a bounded summary without emitting root text or thinking', () => {
    start();
    expect(send('assistant.message_delta', { messageId: 'a', deltaContent: 'private' }, 'child')).toEqual([]);
    expect(send('assistant.reasoning', { reasoningId: 'r', content: 'private' }, 'child')).toEqual([]);
    send('assistant.message', { messageId: 'progress', content: 'intermediate', toolRequests: [{ name: 'view' }] }, 'child');
    const before = state;
    send('assistant.message', { messageId: 'final', content: 'Summary'.repeat(900), toolRequests: [] }, 'child');
    expect(before.agents.get('child')?.summary).toBeUndefined();
    expect(send('subagent.completed', { toolCallId: 'spawn' }, 'child')).toMatchObject([
      { type: 'tool_outcomes', outcomes: [{ outcome: 'done', summary: expect.any(String) }] },
    ]);
    expect(state.agents.get('child')!.summary).toHaveLength(4001);
    expect(frames.some(frame => frame.type === 'text' || frame.type === 'thinking' || frame.type === 'usage')).toBe(false);
    expect(send('assistant.message', { content: 'late' }, 'child')).toEqual([]);
    expect(send('subagent.completed', { toolCallId: 'spawn' }, 'child')).toEqual([]);
  });

  test('background task acknowledgement never completes its agent card or leaks its status result as summary', () => {
    tool('spawn', undefined, { toolName: 'task' }); start('child', 'spawn', undefined, { executionMode: 'background' });
    expect(frames.at(-1)).toMatchObject({ description: 'Background: Check the fixture' });
    expect(send('tool.execution_complete', { toolCallId: 'spawn', success: true, result: { content: 'Agent is running' } })).toEqual([]);
    expect(state.agents.get('child')?.ended).toBe(false);
    tool('work', 'child'); send('assistant.message', { content: 'Actual result' }, 'child');
    expect(send('subagent.completed', { toolCallId: 'spawn' }, 'child')).toMatchObject([
      { outcomes: [{ outcome: 'done', summary: 'Actual result' }] },
    ]);
    expect(send('tool.execution_start', { toolCallId: 'late', toolName: 'view' }, 'child')).toEqual([]);
  });

  test.each([false, true])('maps native failure/cancellation without ending the root (cancelled: %s)', cancelled => {
    start();
    const result = cancelled ? send('subagent.completed', { toolCallId: 'spawn', cancelled: true }, 'child')
      : send('subagent.failed', { toolCallId: 'spawn', error: 'Synthetic failure' }, 'child');
    expect(result).toMatchObject([{ type: 'tool_outcomes', outcomes: [{ outcome: cancelled ? 'cancelled' : 'failed', status: cancelled ? 'warning' : 'error' }] }]);
    expect(send('tool.execution_complete', { toolCallId: 'spawn', success: true })).toEqual([]);
    expect(send('subagent.failed', { toolCallId: 'spawn', error: 'late' }, 'child')).toEqual([]);
  });

  test('reports task failure before startup and does not promote unknown child events into root tools', () => {
    tool('failed', undefined, { toolName: 'task' });
    expect(send('tool.execution_complete', { toolCallId: 'failed', success: false, error: { message: 'Invalid task' } }))
      .toMatchObject([{ type: 'tool_activity', isAgent: true }, { type: 'tool_outcomes', outcomes: [{ summary: 'Invalid task', status: 'error' }] }]);
    expect(start('late', 'failed')).toEqual([]);
    expect(tool('secret', 'unknown')).toEqual([]);
    expect(send('assistant.message', { content: 'unknown' }, 'unknown')).toEqual([]);
    expect(tool('secret', undefined, { parentToolCallId: 'unknown' })).toEqual([]);
  });

  test('supports unambiguous legacy parent-tool attribution and suppresses ambiguous ownership', () => {
    start('left', 'same-spawn');
    expect(tool('read', undefined, { parentToolCallId: 'same-spawn' })[0]).toMatchObject({ parentAgentId: copilotToolId(state, null, 'same-spawn') });
    start('right', 'outer'); start('nested', 'same-spawn', 'right');
    expect(tool('ambiguous', undefined, { parentToolCallId: 'same-spawn' })).toEqual([]);
    const legacy = reduceCopilotWork(createCopilotWorkState('legacy'), event('subagent.started', { toolCallId: 'legacy-spawn', agentName: 'legacy' }));
    expect(legacy.events[0]).toMatchObject({ isAgent: true });
  });

  test('unknown native completion IDs cannot claim a known child through a reused spawn ID', () => {
    start();
    expect(send('subagent.completed', { toolCallId: 'spawn' }, 'unowned')).toEqual([]);
    expect(send('subagent.failed', { toolCallId: 'spawn', error: 'Unowned failure' }, 'unowned')).toEqual([]);
    expect(state.agents.get('child')?.ended).toBe(false);
    expect(send('subagent.completed', { toolCallId: 'spawn' })).toMatchObject([{ outcomes: [{ outcome: 'done' }] }]);
  });

  test('finalizes outstanding cards/tools exactly once and separates turns and delimiter-containing IDs', () => {
    start(); tool('running', 'child'); tool('root');
    const stopped = finishCopilotWork(state, 'cancelled');
    expect(stopped.events[0]).toMatchObject({ outcomes: [
      { toolUseId: copilotToolId(state, null, 'spawn'), outcome: 'cancelled' },
      { toolUseId: copilotToolId(state, 'child', 'running'), outcome: 'cancelled' },
      { toolUseId: copilotToolId(state, null, 'root'), outcome: 'cancelled' },
    ] });
    expect(state.agents.get('child')?.ended).toBe(false);
    expect(finishCopilotWork(stopped.state, 'interrupted').events).toEqual([]);
    expect(copilotToolId(state, 'a:b', 'c')).not.toBe(copilotToolId(state, 'a', 'b:c'));
    expect(copilotToolId(state, null, 'root')).not.toBe(copilotToolId(createCopilotWorkState('other'), null, 'root'));
  });
});
