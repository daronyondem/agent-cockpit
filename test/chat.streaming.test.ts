/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { MockBackendAdapter } from './helpers/mockBackendAdapter';
import type { BackendMetadata, StreamEvent } from '../src/types';

class KiroMockBackend extends MockBackendAdapter {
  get metadata(): BackendMetadata {
    return {
      ...super.metadata,
      id: 'kiro',
      label: 'Kiro',
    };
  }
}

let env: ChatRouterEnv;

beforeEach(async () => { env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); });

describe('Terminal stream errors', () => {
  test('persists partial output before stream-error message and emits synthetic done', async () => {
    const conv = await env.chatService.createConversation('Terminal Error');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'partial answer', streaming: true },
      { type: 'error', error: 'usage limit reached' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'trigger error',
      backend: 'claude-code',
    });
    expect(res.status).toBe(200);

    const events = await eventsPromise;
    expect(events.find((e: any) => e.type === 'error')?.error).toBe('usage limit reached');
    expect(events.find((e: any) => e.type === 'done')).toBeDefined();

    const saved = await env.chatService.getConversation(conv.id);
    const assistant = saved?.messages.filter(m => m.role === 'assistant') || [];
    expect(assistant.map(m => m.content)).toEqual([
      'partial answer',
      'Stream failed: usage limit reached',
    ]);
    expect(assistant[1].streamError).toEqual({ message: 'usage limit reached', source: 'backend' });
  });

  test('terminal error ends processStream even if backend iterator does not yield done', async () => {
    const conv = await env.chatService.createConversation('Terminal Error No Done');

    let released = false;
    const never = new Promise<void>(() => {});
    env.mockBackend.sendMessage = function() {
      async function* createStream() {
        yield { type: 'error', error: 'fatal without done' } as StreamEvent;
        await never;
        released = true;
      }
      return {
        stream: createStream(),
        abort: () => {},
        sendInput: () => {},
      };
    };

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'trigger stuck error',
      backend: 'claude-code',
    });
    expect(res.status).toBe(200);

    const events = await eventsPromise;
    expect(events.find((e: any) => e.type === 'error')).toMatchObject({
      error: 'fatal without done',
      terminal: true,
    });
    expect(events.find((e: any) => e.type === 'done')).toBeDefined();
    expect(env.activeStreams.has(conv.id)).toBe(false);
    expect(released).toBe(false);
  });

  test('non-terminal adapter warning does not persist stream error or stop final save', async () => {
    const conv = await env.chatService.createConversation('Warning Error');

    env.mockBackend.setMockEvents([
      { type: 'error', error: 'model unavailable, using default', terminal: false },
      { type: 'text', content: 'final answer', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'warn then continue',
      backend: 'claude-code',
    });
    expect(res.status).toBe(200);

    const events = await eventsPromise;
    const warning = events.find((e: any) => e.type === 'error');
    expect(warning).toMatchObject({ error: 'model unavailable, using default', terminal: false });

    const saved = await env.chatService.getConversation(conv.id);
    const assistant = saved?.messages.filter(m => m.role === 'assistant') || [];
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe('final answer');
    expect(assistant[0].streamError).toBeUndefined();
  });
});

describe('Tool activity forwarding', () => {
  test('forwards enriched tool_activity fields via WebSocket', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Read', description: 'Reading `app.js`', id: 'tool_1' },
      { type: 'text', content: 'Result', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const toolEvent = events.find((e: any) => e.type === 'tool_activity');
    expect(toolEvent).toBeDefined();
    expect(toolEvent.tool).toBe('Read');
    expect(toolEvent.description).toBe('Reading `app.js`');
    expect(toolEvent.id).toBe('tool_1');
  });

  test('forwards isAgent flag via WebSocket', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Agent', description: 'Explore code', isAgent: true, subagentType: 'Explore' },
      { type: 'text', content: 'Done', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'explore',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const agentEvent = events.find((e: any) => e.type === 'tool_activity');
    expect(agentEvent).toBeDefined();
    expect(agentEvent.isAgent).toBe(true);
    expect(agentEvent.subagentType).toBe('Explore');
  });

  test('forwards isPlanMode and planAction via WebSocket', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'EnterPlanMode', isPlanMode: true, planAction: 'enter', description: 'Entering plan mode' },
      { type: 'tool_activity', tool: 'ExitPlanMode', isPlanMode: true, planAction: 'exit', description: 'Plan ready for approval' },
      { type: 'text', content: 'Plan done', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'plan',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const planEvents = events.filter((e: any) => e.type === 'tool_activity' && e.isPlanMode);
    expect(planEvents).toHaveLength(2);
    expect(planEvents[0].planAction).toBe('enter');
    expect(planEvents[1].planAction).toBe('exit');
  });

  test('attaches fallback planContent from accumulated text on plan exit', async () => {
    const conv = await env.chatService.createConversation('Plan Content');

    env.mockBackend.setMockEvents([
      { type: 'text', content: '## Proposed plan\n\n1. First step\n2. Second step' } as StreamEvent,
      { type: 'tool_activity', tool: 'ExitPlanMode', isPlanMode: true, planAction: 'exit', description: 'Plan ready for approval' },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'plan',
      backend: 'claude-code',
    });

    const events = await eventsPromise;
    const exitEvent = events.find((e: any) => e.type === 'tool_activity' && e.isPlanMode && e.planAction === 'exit');
    expect(exitEvent).toBeDefined();
    expect(exitEvent.planContent).toContain('## Proposed plan');
    expect(exitEvent.planContent).toContain('1. First step');
  });

  test('forwards isQuestion flag and questions via WebSocket', async () => {
    const conv = await env.chatService.createConversation('Test');
    const questions = [{ question: 'Which approach?', options: [{ label: 'A' }] }];

    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'AskUserQuestion', isQuestion: true, questions, description: 'Asking a question' },
      { type: 'text', content: 'Ok', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'question',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const questionEvent = events.find((e: any) => e.type === 'tool_activity' && e.isQuestion);
    expect(questionEvent).toBeDefined();
    expect(questionEvent.questions).toEqual(questions);
  });
});

// ── Tool activity persistence ────────────────────────────────────────────────

describe('Tool activity persistence', () => {
  test('persists toolActivity on intermediate message at turn_boundary', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Read', description: 'Reading `app.js`', id: 'tool_1' },
      { type: 'tool_activity', tool: 'Grep', description: 'Searching for `foo`', id: 'tool_2' },
      { type: 'text', content: 'First response', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Second response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    // First assistant message (intermediate) should have toolActivity
    expect(assistantMsgs[0].toolActivity).toBeDefined();
    expect(assistantMsgs[0].toolActivity).toHaveLength(2);
    expect(assistantMsgs[0].toolActivity![0].tool).toBe('Read');
    expect(assistantMsgs[0].toolActivity![1].tool).toBe('Grep');
  });

  test('persists toolActivity on final message at done', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Bash', description: 'Running tests', id: 'tool_1' },
      { type: 'text', content: 'Tests passed', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs[0].toolActivity).toBeDefined();
    expect(assistantMsgs[0].toolActivity).toHaveLength(1);
    expect(assistantMsgs[0].toolActivity![0].tool).toBe('Bash');
    expect(assistantMsgs[0].toolActivity![0].duration).toBeGreaterThanOrEqual(0);
    expect(assistantMsgs[0].toolActivity![0].startTime).toBeDefined();
  });

  test('does not persist isPlanMode or isQuestion events as toolActivity', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'EnterPlanMode', isPlanMode: true, planAction: 'enter', description: 'Entering plan mode' },
      { type: 'tool_activity', tool: 'ExitPlanMode', isPlanMode: true, planAction: 'exit', description: 'Plan ready' },
      { type: 'tool_activity', tool: 'AskUserQuestion', isQuestion: true, questions: [], description: 'Asking' },
      { type: 'tool_activity', tool: 'Read', description: 'Reading `file.js`', id: 'tool_1' },
      { type: 'text', content: 'Done', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs[0].toolActivity).toBeDefined();
    // Only the Read tool should be persisted, not plan mode or question events
    expect(assistantMsgs[0].toolActivity).toHaveLength(1);
    expect(assistantMsgs[0].toolActivity![0].tool).toBe('Read');
  });

  test('toolActivity absent when no tool events occur', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Just text', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs[0].toolActivity).toBeUndefined();
  });

  test('persists agent tool activity with isAgent and subagentType', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Agent', description: 'Explore codebase', isAgent: true, subagentType: 'Explore', id: 'agent_1' },
      { type: 'text', content: 'Found results', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs[0].toolActivity).toBeDefined();
    expect(assistantMsgs[0].toolActivity![0].isAgent).toBe(true);
    expect(assistantMsgs[0].toolActivity![0].subagentType).toBe('Explore');
  });

  test('forwards tool_outcomes event to client', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Grep', description: 'Searching', id: 'tool_1' },
      { type: 'tool_outcomes', outcomes: [{ toolUseId: 'tool_1', outcome: '5 matches', status: 'success' }] },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Found it', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const outcomeEvent = events.find((e: any) => e.type === 'tool_outcomes');
    expect(outcomeEvent).toBeDefined();
    expect(outcomeEvent.outcomes[0].outcome).toBe('5 matches');
    expect(outcomeEvent.outcomes[0].status).toBe('success');
  });

  test('persists outcome and status on toolActivity entries', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Bash', description: 'Running tests', id: 'tool_1' },
      { type: 'tool_outcomes', outcomes: [{ toolUseId: 'tool_1', outcome: 'exit 0', status: 'success' }] },
      { type: 'text', content: 'Tests pass', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Done', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    // First message (intermediate, saved at turn_boundary) should have outcome
    expect(assistantMsgs[0].toolActivity).toBeDefined();
    expect(assistantMsgs[0].toolActivity![0].outcome).toBe('exit 0');
    expect(assistantMsgs[0].toolActivity![0].status).toBe('success');
  });
});

// ── Parallel grouping and session overview ────────────────────────────────────

describe('Tool activity Phase 3 features', () => {
  test('persists multiple agents with close startTimes for parallel grouping', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Agent', description: 'Search code', id: 'a1', isAgent: true, subagentType: 'Explore' },
      { type: 'tool_activity', tool: 'Agent', description: 'Check tests', id: 'a2', isAgent: true, subagentType: 'Explore' },
      { type: 'text', content: 'Result', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test', backend: 'claude-code',
    });
    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs[0].toolActivity).toBeDefined();
    expect(assistantMsgs[0].toolActivity).toHaveLength(2);
    expect(assistantMsgs[0].toolActivity![0].isAgent).toBe(true);
    expect(assistantMsgs[0].toolActivity![1].isAgent).toBe(true);
    // Both should have startTime for frontend parallel grouping
    expect(assistantMsgs[0].toolActivity![0].startTime).toBeDefined();
    expect(assistantMsgs[0].toolActivity![1].startTime).toBeDefined();
  });

  test('persists mix of tool and agent activity for session overview aggregation', async () => {
    const conv = await env.chatService.createConversation('Test');

    // First turn: tool activity
    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Read', description: 'Read file.js', id: 't1' },
      { type: 'tool_activity', tool: 'Grep', description: 'Search pattern', id: 't2' },
      { type: 'text', content: 'Found it', streaming: true },
      { type: 'turn_boundary' },
      // Second turn: agent activity
      { type: 'tool_activity', tool: 'Agent', description: 'Explore codebase', id: 'a1', isAgent: true, subagentType: 'Explore' },
      { type: 'text', content: 'Done exploring', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test', backend: 'claude-code',
    });
    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    // Should have 2 assistant messages (turn_boundary + done)
    expect(assistantMsgs.length).toBe(2);
    // First message has Read + Grep
    expect(assistantMsgs[0].toolActivity).toHaveLength(2);
    expect(assistantMsgs[0].toolActivity![0].tool).toBe('Read');
    expect(assistantMsgs[0].toolActivity![1].tool).toBe('Grep');
    // Second message has Agent
    expect(assistantMsgs[1].toolActivity).toHaveLength(1);
    expect(assistantMsgs[1].toolActivity![0].isAgent).toBe(true);
    expect(assistantMsgs[1].toolActivity![0].subagentType).toBe('Explore');
  });
});

// ── Ordered contentBlocks persistence ───────────────────────────────────────

describe('ContentBlocks ordering', () => {
  test('preserves interleaved text / tool order in contentBlocks', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Let me read the file. ', streaming: true },
      { type: 'tool_activity', tool: 'Read', description: 'Reading `app.js`', id: 't1' },
      { type: 'text', content: 'Now let me search. ', streaming: true },
      { type: 'tool_activity', tool: 'Grep', description: 'Searching for `foo`', id: 't2' },
      { type: 'text', content: 'Step 1: refactor.', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test', backend: 'claude-code',
    });
    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    const msg = assistantMsgs[0];

    // Legacy fields preserved for back-compat
    expect(msg.content).toBe('Let me read the file. Now let me search. Step 1: refactor.');
    expect(msg.toolActivity).toHaveLength(2);

    // New ordered field reflects source ordering
    expect(msg.contentBlocks).toBeDefined();
    expect(msg.contentBlocks).toHaveLength(5);
    expect(msg.contentBlocks![0]).toEqual({ type: 'text', content: 'Let me read the file. ' });
    expect(msg.contentBlocks![1].type).toBe('tool');
    expect((msg.contentBlocks![1] as any).activity.tool).toBe('Read');
    expect(msg.contentBlocks![2]).toEqual({ type: 'text', content: 'Now let me search. ' });
    expect(msg.contentBlocks![3].type).toBe('tool');
    expect((msg.contentBlocks![3] as any).activity.tool).toBe('Grep');
    expect(msg.contentBlocks![4]).toEqual({ type: 'text', content: 'Step 1: refactor.' });
  });

  test('merges adjacent text chunks into one text block', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hello ', streaming: true },
      { type: 'text', content: 'world. ', streaming: true },
      { type: 'tool_activity', tool: 'Read', description: 'Reading `x`', id: 't1' },
      { type: 'text', content: 'Done ', streaming: true },
      { type: 'text', content: 'now.', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test', backend: 'claude-code',
    });
    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const msg = loaded.messages.filter((m: any) => m.role === 'assistant')[0];
    expect(msg.contentBlocks).toHaveLength(3);
    expect(msg.contentBlocks![0]).toEqual({ type: 'text', content: 'Hello world. ' });
    expect(msg.contentBlocks![1].type).toBe('tool');
    expect(msg.contentBlocks![2]).toEqual({ type: 'text', content: 'Done now.' });
  });

  test('includes thinking as an ordered block', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'thinking', content: 'Considering the problem. ', streaming: true },
      { type: 'text', content: 'Here is my answer. ', streaming: true },
      { type: 'tool_activity', tool: 'Read', description: 'Reading `f`', id: 't1' },
      { type: 'text', content: 'Done.', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test', backend: 'claude-code',
    });
    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const msg = loaded.messages.filter((m: any) => m.role === 'assistant')[0];
    expect(msg.contentBlocks).toBeDefined();
    expect(msg.contentBlocks![0]).toEqual({ type: 'thinking', content: 'Considering the problem. ' });
    expect(msg.contentBlocks![1]).toEqual({ type: 'text', content: 'Here is my answer. ' });
    expect(msg.contentBlocks![2].type).toBe('tool');
    expect(msg.contentBlocks![3]).toEqual({ type: 'text', content: 'Done.' });
    // Legacy `thinking` field still populated for back-compat
    expect(msg.thinking).toBe('Considering the problem.');
  });

  test('tool outcomes patch the corresponding tool block', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Bash', description: 'Running tests', id: 't1' },
      { type: 'text', content: 'Tests ran.', streaming: true },
      { type: 'tool_outcomes', outcomes: [{ toolUseId: 't1', outcome: 'exit 0', status: 'success' }] },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test', backend: 'claude-code',
    });
    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const msg = loaded.messages.filter((m: any) => m.role === 'assistant')[0];
    const toolBlock = (msg.contentBlocks || []).find((b: any) => b.type === 'tool') as any;
    expect(toolBlock).toBeDefined();
    expect(toolBlock.activity.outcome).toBe('exit 0');
    expect(toolBlock.activity.status).toBe('success');
  });

  test('persists artifact-only assistant turns in contentBlocks', async () => {
    const conv = await env.chatService.createConversation('Artifact Only');
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8C6YQAAAABJRU5ErkJggg==';

    env.mockBackend.setMockEvents([
      {
        type: 'artifact',
        dataBase64: pngBase64,
        filename: 'chart.png',
        mimeType: 'image/png',
        title: 'Generated chart',
        sourceToolId: 'ig-1',
      },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'generate an image', backend: 'claude-code',
    });
    const events = await eventsPromise;

    const artifactFrame = events.find((e: any) => e.type === 'artifact');
    expect(artifactFrame?.artifact).toMatchObject({
      filename: 'chart.png',
      kind: 'image',
      mimeType: 'image/png',
      title: 'Generated chart',
      sourceToolId: 'ig-1',
    });

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const msg = loaded.messages.filter((m: any) => m.role === 'assistant')[0];
    expect(msg.content).toBe('Generated file: Generated chart');
    expect(msg.contentBlocks).toHaveLength(1);
    expect(msg.contentBlocks![0]).toMatchObject({
      type: 'artifact',
      artifact: {
        filename: 'chart.png',
        kind: 'image',
        mimeType: 'image/png',
      },
    });
    expect(fs.existsSync(path.join(env.chatService.artifactsDir, conv.id, 'chart.png'))).toBe(true);
  });

  test('intermediate message at turn_boundary has its own contentBlocks', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'First ', streaming: true },
      { type: 'tool_activity', tool: 'Read', description: 'Reading `a`', id: 't1' },
      { type: 'text', content: 'segment.', streaming: true },
      { type: 'turn_boundary' },
      { type: 'tool_activity', tool: 'Bash', description: 'Running', id: 't2' },
      { type: 'text', content: 'Second segment.', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test', backend: 'claude-code',
    });
    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const msgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(msgs).toHaveLength(2);

    expect(msgs[0].contentBlocks).toHaveLength(3);
    expect(msgs[0].contentBlocks![0]).toEqual({ type: 'text', content: 'First ' });
    expect(msgs[0].contentBlocks![1].type).toBe('tool');
    expect((msgs[0].contentBlocks![1] as any).activity.tool).toBe('Read');
    expect(msgs[0].contentBlocks![2]).toEqual({ type: 'text', content: 'segment.' });

    expect(msgs[1].contentBlocks).toHaveLength(2);
    expect(msgs[1].contentBlocks![0].type).toBe('tool');
    expect((msgs[1].contentBlocks![0] as any).activity.tool).toBe('Bash');
    expect(msgs[1].contentBlocks![1]).toEqual({ type: 'text', content: 'Second segment.' });
  });

  test('omits contentBlocks when assistant message has no blocks', async () => {
    const conv = await env.chatService.createConversation('Test');

    // No text, no tools — just a plan mode event which is skipped from
    // the accumulator, and a done. Nothing should be saved.
    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'EnterPlanMode', isPlanMode: true, planAction: 'enter' },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test', backend: 'claude-code',
    });
    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(0);
  });
});

// ── Turn boundary intermediate message saving ───────────────────────────────

describe('Turn boundary intermediate messages', () => {
  test('saves intermediate message on turn_boundary', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'First response', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Second response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    // Should have two assistant_message events (one intermediate, one final)
    const assistantMessages = events.filter((e: any) => e.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0].message.content).toBe('First response');
    expect(assistantMessages[0].message.turn).toBe('progress');
    expect(assistantMessages[1].message.content).toBe('Second response');
    expect(assistantMessages[1].message.turn).toBe('final');

    // Verify persisted to disk
    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
    expect(assistantMsgs[0].turn).toBe('progress');
    expect(assistantMsgs[1].turn).toBe('final');
  });

  test('saves thinking with intermediate message', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'thinking', content: 'Let me think...', streaming: true },
      { type: 'text', content: 'Response with thinking', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'After tool use', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const assistantMessages = events.filter((e: any) => e.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(2);

    // First message should have thinking
    expect(assistantMessages[0].message.thinking).toBe('Let me think...');
    expect(assistantMessages[0].message.content).toBe('Response with thinking');

    // Verify persisted
    const loaded = (await env.chatService.getConversation(conv.id))!;
    const firstAssistant = loaded.messages.find((m: any) => m.role === 'assistant');
    expect(firstAssistant!.thinking).toBe('Let me think...');
  });

  test('does not save intermediate message when no streaming content', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'turn_boundary' }, // boundary with no preceding text
      { type: 'text', content: 'Final', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const assistantMessages = events.filter((e: any) => e.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(1); // Only the final message
    expect(assistantMessages[0].message.content).toBe('Final');
  });

  test('saves intermediate message for whole-block text without streaming flag', async () => {
    // Claude Code CLI emits text via whole-block `assistant` events with no
    // `streaming: true` flag. Prior to the fix these were silently discarded
    // at turn_boundary, losing any pre-tool-call content. Now they must be
    // saved just like delta text.
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Whole-block pre-tool content' } as StreamEvent,
      { type: 'tool_activity', tool: 'Read', description: 'Reading file', id: 'tool_1' },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Post-tool content' } as StreamEvent,
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const assistantMessages = events.filter((e: any) => e.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0].message.content).toBe('Whole-block pre-tool content');
    expect(assistantMessages[0].message.toolActivity).toHaveLength(1);
    expect(assistantMessages[0].message.toolActivity![0].tool).toBe('Read');
    expect(assistantMessages[1].message.content).toBe('Post-tool content');

    // Verify persisted to disk — this is the regression the bug caused.
    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
    expect(assistantMsgs[0].content).toBe('Whole-block pre-tool content');
    expect(assistantMsgs[1].content).toBe('Post-tool content');
  });

  test('carries tool-only turn_boundary activity forward to next saved segment', async () => {
    // Claude Code CLI processes parallel tool_uses sequentially, firing
    // turn_boundary after each tool_result. Tools after the first boundary
    // arrive with no new text since the last save — they must stay in the
    // accumulator so they land on the next message that has text, instead of
    // being dropped on an empty-text reset.
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Reading all three in parallel.', streaming: true },
      { type: 'tool_activity', tool: 'Read', description: 'Read a.md', id: 't1' },
      { type: 'turn_boundary' }, // tool A result
      { type: 'tool_activity', tool: 'Read', description: 'Read b.md', id: 't2' },
      { type: 'turn_boundary' }, // tool B result — no text since last save
      { type: 'tool_activity', tool: 'Read', description: 'Read c.md', id: 't3' },
      { type: 'turn_boundary' }, // tool C result — still no text
      { type: 'text', content: 'All three read.', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });
    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    // First save: the initial text arrives, then tool A fires, then the first
    // turn_boundary persists a progress message carrying just tool A. Tools B
    // and C are carried by subsequent empty-text boundaries until the final
    // segment saves them all with its own text.
    expect(assistantMsgs.length).toBe(2);
    const firstTools = assistantMsgs[0].toolActivity || [];
    const finalTools = assistantMsgs[1].toolActivity || [];
    const firstToolNames = firstTools.map((t: any) => t.description);
    const finalToolNames = finalTools.map((t: any) => t.description);
    const allToolNames = [...firstToolNames, ...finalToolNames];
    expect(allToolNames).toEqual(['Read a.md', 'Read b.md', 'Read c.md']);
    // Final message must be the text bubble and carry the trailing tools.
    expect(assistantMsgs[1].content).toBe('All three read.');
    expect(finalTools.length).toBeGreaterThanOrEqual(2);
    // Ordered contentBlocks preserve the interleaving.
    const finalBlocks = assistantMsgs[1].contentBlocks || [];
    const finalBlockTypes = finalBlocks.map((b: any) => b.type);
    expect(finalBlockTypes).toContain('tool');
    expect(finalBlockTypes).toContain('text');
  });

  test('tags tool activities with batchIndex that bumps on every turn_boundary', async () => {
    // Tools emitted back-to-back with no turn_boundary between them are the
    // parallel tool_uses of a single LLM assistant turn — they must share a
    // batchIndex so the frontend groups them correctly regardless of how the
    // CLI spaces the tool_result events in time. A turn_boundary always closes
    // the current batch; the next tool starts a new one.
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      // Turn 1: two parallel tools (no turn_boundary between them).
      { type: 'tool_activity', tool: 'Grep', description: 'search', id: 't1' },
      { type: 'tool_activity', tool: 'Glob', description: 'find', id: 't2' },
      { type: 'turn_boundary' }, // results for t1 + t2
      // Turn 2: one sequential tool.
      { type: 'tool_activity', tool: 'Bash', description: 'ls', id: 't3' },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Done.', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });
    await eventsPromise;

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    const finalTools = assistantMsgs[assistantMsgs.length - 1].toolActivity || [];
    const byId: Record<string, any> = {};
    for (const t of finalTools) {
      if (t.id) byId[t.id] = t;
    }
    // t1 and t2 came in one batch (before the first turn_boundary).
    expect(byId.t1.batchIndex).toBe(byId.t2.batchIndex);
    // t3 came after a turn_boundary — strictly newer batchIndex.
    expect(byId.t3.batchIndex).toBeGreaterThan(byId.t1.batchIndex);
  });

  test('forwards whole-block text to WebSocket regardless of streaming flag', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Whole block' } as StreamEvent,
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;
    const textFrames = events.filter((e: any) => e.type === 'text');
    expect(textFrames).toHaveLength(1);
    expect(textFrames[0].content).toBe('Whole block');
  });

  test('forwards whole-block thinking to WebSocket regardless of streaming flag', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'thinking', content: 'Whole-block reasoning' } as StreamEvent,
      { type: 'text', content: 'Answer' } as StreamEvent,
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;
    const thinkingFrames = events.filter((e: any) => e.type === 'thinking');
    expect(thinkingFrames).toHaveLength(1);
    expect(thinkingFrames[0].content).toBe('Whole-block reasoning');
  });

  test('saves result text as final message when no streaming deltas', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'result', content: 'The final result' },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const assistantMessages = events.filter((e: any) => e.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].message.content).toBe('The final result');
  });
});

// ── Turn complete event forwarding ───────────────────────────────────────────

describe('Turn complete event forwarding', () => {
  test('sends turn_complete event on turn_boundary even without text', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'turn_boundary' }, // boundary with no preceding text
      { type: 'text', content: 'Final', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    // Should have turn_complete event even though no text was saved
    const turnCompletes = events.filter((e: any) => e.type === 'turn_complete');
    expect(turnCompletes).toHaveLength(1);
  });

  test('sends turn_complete alongside assistant_message when text exists', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'First response', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Second response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    // Should have both assistant_message and turn_complete
    const assistantMessages = events.filter((e: any) => e.type === 'assistant_message');
    const turnCompletes = events.filter((e: any) => e.type === 'turn_complete');
    expect(assistantMessages).toHaveLength(2);
    expect(turnCompletes).toHaveLength(1);

    // turn_complete should come after the intermediate assistant_message
    const assistantIdx = events.findIndex((e: any) => e.type === 'assistant_message');
    const turnCompleteIdx = events.findIndex((e: any) => e.type === 'turn_complete');
    expect(turnCompleteIdx).toBeGreaterThan(assistantIdx);
  });

  test('sends turn_complete for each turn_boundary', async () => {
    const conv = await env.chatService.createConversation('Test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'First', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Second', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Third', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const turnCompletes = events.filter((e: any) => e.type === 'turn_complete');
    expect(turnCompletes).toHaveLength(2);
  });
});

// ── Auto title update on new session ────────────────────────────────────────

describe('Auto title update on new session', () => {
  test('sends title_updated event after first assistant message in reset session', async () => {
    const conv = await env.chatService.createConversation('Original Title');
    await env.chatService.addMessage(conv.id, 'user', 'Old topic', 'claude-code');
    await env.chatService.addMessage(conv.id, 'assistant', 'Old response', 'claude-code');
    await env.chatService.resetSession(conv.id);

    env.mockBackend._mockTitle = 'New Topic Title';
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'New response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'New topic question',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const titleEvents = events.filter((e: any) => e.type === 'title_updated');
    expect(titleEvents).toHaveLength(1);
    expect(titleEvents[0].title).toBe('New Topic Title');

    // Verify title was persisted
    const loaded = (await env.chatService.getConversation(conv.id))!;
    expect(loaded.title).toBe('New Topic Title');
  });

  test('does not send title_updated on first session', async () => {
    const conv = await env.chatService.createConversation('New Chat');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'First response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello world',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const titleEvents = events.filter((e: any) => e.type === 'title_updated');
    expect(titleEvents).toHaveLength(0);
  });

  test('sends title_updated only once even with multiple assistant messages', async () => {
    const conv = await env.chatService.createConversation('Original');
    await env.chatService.addMessage(conv.id, 'user', 'Old msg', 'claude-code');
    await env.chatService.resetSession(conv.id);

    env.mockBackend._mockTitle = 'Updated Title';
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'First part', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Second part', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'New session question',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const titleEvents = events.filter((e: any) => e.type === 'title_updated');
    expect(titleEvents).toHaveLength(1);
  });
});

// ── Workspace context injection ──────────────────────────────────────────────

describe('Workspace context injection', () => {
  test('injects workspace context on new session message', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/inject-test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    // The CLI should receive the injected message
    expect(env.mockBackend._lastMessage).toContain('Workspace discussion history');
    expect(env.mockBackend._lastMessage).toContain('Hello');
  });

  test('does not inject context on subsequent messages', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/inject-test');
    // Add a message first so it's not a new session
    await env.chatService.addMessage(conv.id, 'user', 'First msg', 'claude-code');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Second msg',
      backend: 'claude-code',
    });

    // The CLI should receive just the message, no injection
    expect(env.mockBackend._lastMessage).toBe('Second msg');
    expect(env.mockBackend._lastMessage).not.toContain('Workspace discussion history');
  });

  test('injects memory pointer on new session when memory is enabled', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/inject-mem-on');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceMemoryEnabled(hash, true);

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    // Both pointers should be in the user message on a new session.
    expect(env.mockBackend._lastMessage).toContain('Workspace discussion history');
    expect(env.mockBackend._lastMessage).toContain('Workspace memory is available at');
    expect(env.mockBackend._lastMessage).toContain('memory/files/');
    expect(env.mockBackend._lastMessage).toContain('Hello');

    // Memory content MUST NOT be dumped into the system prompt anymore.
    expect(env.mockBackend._lastOptions!.systemPrompt).not.toContain('Workspace Memory');
    expect(env.mockBackend._lastOptions!.systemPrompt).not.toContain('User Preferences');
  });

  test('does not inject memory pointer when memory is disabled', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/inject-mem-off');
    // Memory stays disabled (default).

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(env.mockBackend._lastMessage).toContain('Workspace discussion history');
    expect(env.mockBackend._lastMessage).not.toContain('Workspace memory is available');
  });

  test('does not inject memory pointer on subsequent messages', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/inject-mem-resume');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceMemoryEnabled(hash, true);
    // Pre-seed a message so this is no longer a new session.
    await env.chatService.addMessage(conv.id, 'user', 'First msg', 'claude-code');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Second msg',
      backend: 'claude-code',
    });

    // On resumed sessions the pointer is NOT re-prepended — the CLI
    // still sees it via its own conversation history from the first
    // new-session message.
    expect(env.mockBackend._lastMessage).toBe('Second msg');
    expect(env.mockBackend._lastMessage).not.toContain('Workspace memory is available');
    expect(env.mockBackend._lastMessage).not.toContain('Workspace discussion history');
  });

  test('stores user message without injection in conversation', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/inject-test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    // The stored message should NOT contain the injection
    expect(res.body.userMessage.content).toBe('Hello');
  });
});

// ── System prompt passthrough ──────────────────────────────────────────────

describe('System prompt passthrough', () => {
  test('passes systemPrompt to backend on new session', async () => {
    // Save a system prompt to settings
    await env.chatService.saveSettings({ theme: 'system', systemPrompt: 'You are a pirate' } as any);

    const conv = await env.chatService.createConversation('Test');
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Ahoy', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(env.mockBackend._lastOptions!.systemPrompt).toContain('You are a pirate');
    expect(env.mockBackend._lastOptions!.systemPrompt).toContain('FILE_DELIVERY');
  });

  test('passes file delivery addendum when no other prompt configured', async () => {
    const conv = await env.chatService.createConversation('Test');
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(env.mockBackend._lastOptions!.systemPrompt).toContain('FILE_DELIVERY');
  });

  test('does not pass systemPrompt on subsequent messages', async () => {
    await env.chatService.saveSettings({ theme: 'system', systemPrompt: 'You are a pirate' } as any);

    const conv = await env.chatService.createConversation('Test');
    await env.chatService.addMessage(conv.id, 'user', 'First msg', 'claude-code');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Second msg',
      backend: 'claude-code',
    });

    // On resumed sessions, systemPrompt should be empty (not fetched)
    expect(env.mockBackend._lastOptions!.systemPrompt).toBe('');
  });
});

// ── conversationId and externalSessionId passthrough ──────────────────────────

describe('sendMessage options passthrough', () => {
  test('passes conversationId to backend adapter', async () => {
    const conv = await env.chatService.createConversation('Test');
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(env.mockBackend._lastOptions!.conversationId).toBe(conv.id);
  });

  test('passes externalSessionId from conversation to backend adapter', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ext-test');
    // Write externalSessionId to the workspace index
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/tmp/ext-test').digest('hex').substring(0, 16);
    const indexPath = path.join(env.tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const activeSession = index.conversations[0].sessions.find((s: any) => s.active);
    activeSession.externalSessionId = 'kiro-session-xyz';
    fs.writeFileSync(indexPath, JSON.stringify(index));

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(env.mockBackend._lastOptions!.externalSessionId).toBe('kiro-session-xyz');
  });

  test('passes null externalSessionId when not set', async () => {
    const conv = await env.chatService.createConversation('Test');
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(env.mockBackend._lastOptions!.externalSessionId).toBeNull();
  });

  test('external_session stream event persists sessionId on active SessionEntry', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ext-persist-test');
    env.mockBackend.setMockEvents([
      { type: 'external_session', sessionId: 'backend-sess-xyz' },
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });
    await eventsPromise;

    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('/tmp/ext-persist-test').digest('hex').substring(0, 16);
    const indexPath = path.join(env.tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const activeSession = index.conversations[0].sessions.find((s: any) => s.active);
    expect(activeSession.externalSessionId).toBe('backend-sess-xyz');
  });

  test('external_session frame is not forwarded to the frontend WebSocket', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ext-no-leak');
    env.mockBackend.setMockEvents([
      { type: 'external_session', sessionId: 'backend-sess-hidden' },
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });
    const events = await eventsPromise;

    expect(events.find((e: any) => e.type === 'external_session')).toBeUndefined();
  });

  test('persisted externalSessionId flows back to the adapter on the next send', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ext-roundtrip');
    env.mockBackend.setMockEvents([
      { type: 'external_session', sessionId: 'backend-sess-rt' },
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws1 = await env.connectWs(conv.id);
    const eventsPromise1 = env.readWsEvents(ws1);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'First',
      backend: 'claude-code',
    });
    await eventsPromise1;

    // Second send — adapter should now see the ID that was persisted from the
    // first send's external_session event.
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Ok', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);
    const ws2 = await env.connectWs(conv.id);
    const eventsPromise2 = env.readWsEvents(ws2);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Second',
      backend: 'claude-code',
    });
    await eventsPromise2;

    expect(env.mockBackend._lastOptions!.externalSessionId).toBe('backend-sess-rt');
  });

  test('passes model to backend adapter', async () => {
    const conv = await env.chatService.createConversation('Test');
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
      model: 'opus',
    });

    expect(env.mockBackend._lastOptions!.model).toBe('opus');
  });

  test('uses stored conversation model when not in request', async () => {
    const conv = await env.chatService.createConversation('Test', undefined, undefined, 'haiku');
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(env.mockBackend._lastOptions!.model).toBe('haiku');
  });

  test('updates stored model when request includes different model', async () => {
    const conv = await env.chatService.createConversation('Test', undefined, undefined, 'haiku');
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
      model: 'opus',
    });

    expect(env.mockBackend._lastOptions!.model).toBe('opus');
    const loaded = await env.chatService.getConversation(conv.id);
    expect(loaded!.model).toBe('opus');
  });

  test('passes effort to backend adapter on send', async () => {
    const conv = await env.chatService.createConversation('Test', undefined, 'claude-code', 'opus');
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
      model: 'opus',
      effort: 'max',
    });

    expect(env.mockBackend._lastOptions!.effort).toBe('max');
    const loaded = await env.chatService.getConversation(conv.id);
    expect(loaded!.effort).toBe('max');
  });

  test('downgrades effort when request switches to a weaker model', async () => {
    const conv = await env.chatService.createConversation('Test', undefined, 'claude-code', 'opus', 'max');
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    // Switch to sonnet — route should downgrade stored effort from 'max' to 'high'
    // before passing options to the adapter.
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
      model: 'sonnet',
    });

    const loaded = await env.chatService.getConversation(conv.id);
    expect(loaded!.model).toBe('sonnet');
    expect(loaded!.effort).toBe('high');
  });

  test('uses stored conversation effort when request omits it', async () => {
    const conv = await env.chatService.createConversation('Test', undefined, 'claude-code', 'opus', 'high');
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(env.mockBackend._lastOptions!.effort).toBe('high');
  });
});

// ── CLI profile runtime selection ───────────────────────────────────────────

describe('CLI profile runtime selection', () => {
  test('creates and sends through the selected profile vendor adapter', async () => {
    const kiroBackend = new KiroMockBackend();
    env.backendRegistry.register(kiroBackend);
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({
      ...settings,
      cliProfiles: [
        ...(settings.cliProfiles || []),
        {
          id: 'profile-kiro-work',
          name: 'Kiro Work',
          vendor: 'kiro',
          authMode: 'server-configured',
          createdAt: '2026-04-29T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        },
      ],
    });

    const createRes = await env.request('POST', '/api/chat/conversations', {
      title: 'Profile Chat',
      cliProfileId: 'profile-kiro-work',
    });
    expect(createRes.status).toBe(200);
    expect(createRes.body.backend).toBe('kiro');
    expect(createRes.body.cliProfileId).toBe('profile-kiro-work');

    kiroBackend.setMockEvents([
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(createRes.body.id);
    const eventsPromise = env.readWsEvents(ws);
    const sendRes = await env.request('POST', `/api/chat/conversations/${createRes.body.id}/message`, {
      content: 'Hello from profile',
    });
    await eventsPromise;

    expect(sendRes.status).toBe(200);
    expect(kiroBackend._lastOptions!.cliProfileId).toBe('profile-kiro-work');
    expect(kiroBackend._lastMessage).toContain('Hello from profile');
    expect(env.mockBackend._lastMessage).toBeNull();

    const loaded = await env.chatService.getConversation(createRes.body.id);
    expect(loaded!.backend).toBe('kiro');
    expect(loaded!.cliProfileId).toBe('profile-kiro-work');
  });

  test('returns 400 when creating with an unknown CLI profile', async () => {
    const res = await env.request('POST', '/api/chat/conversations', {
      title: 'Unknown Profile',
      cliProfileId: 'missing-profile',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CLI profile not found: missing-profile');
  });

  test('rejects message requests with mismatched backend and CLI profile', async () => {
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({
      ...settings,
      cliProfiles: [
        ...(settings.cliProfiles || []),
        {
          id: 'profile-kiro-mismatch',
          name: 'Kiro Mismatch',
          vendor: 'kiro',
          authMode: 'server-configured',
          createdAt: '2026-04-29T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        },
      ],
    });
    const conv = await env.chatService.createConversation(
      'Mismatch Test',
      undefined,
      undefined,
      undefined,
      undefined,
      'profile-kiro-mismatch',
    );

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Should not send',
      cliProfileId: 'profile-kiro-mismatch',
      backend: 'claude-code',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CLI profile vendor kiro does not match backend claude-code');
    expect(env.mockBackend._lastMessage).toBeNull();
  });

  test('allows profile selection before the first message and blocks it after messages exist', async () => {
    const kiroBackend = new KiroMockBackend();
    env.backendRegistry.register(kiroBackend);
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({
      ...settings,
      cliProfiles: [
        ...(settings.cliProfiles || []),
        {
          id: 'profile-kiro-switch',
          name: 'Kiro Switch',
          vendor: 'kiro',
          authMode: 'server-configured',
          createdAt: '2026-04-29T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        },
      ],
    });

    const conv = await env.chatService.createConversation('Switch Test');
    kiroBackend.setMockEvents([
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);
    const firstSend = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Use Kiro before first message',
      cliProfileId: 'profile-kiro-switch',
    });
    await eventsPromise;

    expect(firstSend.status).toBe(200);
    expect(kiroBackend._lastOptions!.cliProfileId).toBe('profile-kiro-switch');

    const blocked = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Try switching later',
      cliProfileId: 'server-configured-claude-code',
    });

    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('Cannot switch CLI profile after the active session has messages');
  });
});

// ── PATCH /conversations/:id/archive ─────────────────────────────────────────
