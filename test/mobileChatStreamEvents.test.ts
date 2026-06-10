import { loadMobileModule } from './mobileModuleLoader';

describe('mobile chat stream event projections', () => {
  const events = loadMobileModule('chatStreamEvents.ts');

  test('projects incremental text and assistant messages for the open chat', () => {
    expect(events.chatStreamEventActions({ type: 'text', content: 'Hello' })).toEqual([
      { type: 'set-stream-placeholder', value: false },
      { type: 'append-stream-text', content: 'Hello' },
    ]);
    expect(events.chatStreamEventActions({ type: 'thinking', content: '' })).toEqual([
      { type: 'set-stream-placeholder', value: false },
      { type: 'append-stream-text', content: '' },
    ]);

    const message = { id: 'm1', role: 'assistant', content: 'Done', timestamp: '2026-06-10T00:00:00.000Z' };
    expect(events.chatStreamEventActions({ type: 'assistant_message', message })).toEqual([
      { type: 'upsert-message', message },
      { type: 'set-stream-text', value: '' },
      { type: 'set-stream-placeholder', value: false },
    ]);
    expect(events.chatStreamEventActions({ type: 'assistant_message' })).toEqual([
      { type: 'set-stream-text', value: '' },
      { type: 'set-stream-placeholder', value: false },
    ]);
  });

  test('projects plan and question tool activity interactions with matching notifications', () => {
    expect(events.chatStreamEventActions({
      type: 'tool_activity',
      isPlanMode: true,
      planAction: 'enter',
      planContent: '# Plan',
    })).toEqual([
      { type: 'set-pending-interaction', interaction: { kind: 'plan', prompt: '# Plan' } },
      { type: 'notify', notification: { title: 'Agent Cockpit needs approval', body: '# Plan' } },
    ]);
    expect(events.chatStreamEventActions({
      type: 'tool_activity',
      isPlanMode: true,
      planAction: 'exit',
      planContent: '# Plan',
    })).toEqual([]);
    expect(events.chatStreamEventActions({
      type: 'tool_activity',
      isQuestion: true,
      questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
    })).toEqual([
      { type: 'set-pending-interaction', interaction: { kind: 'question', prompt: 'Continue?', options: [{ label: 'Yes' }] } },
      { type: 'notify', notification: { title: 'Agent Cockpit has a question', body: 'Continue?' } },
    ]);
  });

  test('projects title, usage, goal, error, done, and replay events for the open chat', () => {
    const goal = { objective: 'Ship', status: 'active' };
    const usage = { inputTokens: 1, outputTokens: 2 };
    const sessionUsage = { inputTokens: 3, outputTokens: 4 };

    expect(events.chatStreamEventActions({ type: 'title_updated', title: 'New title' })).toEqual([
      { type: 'update-title', title: 'New title' },
    ]);
    expect(events.chatStreamEventActions({ type: 'usage', usage, sessionUsage })).toEqual([
      { type: 'update-usage', usage, sessionUsage },
    ]);
    expect(events.chatStreamEventActions({ type: 'goal_updated', goal })).toEqual([
      { type: 'apply-goal-snapshot', goal },
    ]);
    expect(events.chatStreamEventActions({ type: 'goal_cleared' })).toEqual([
      { type: 'apply-goal-snapshot', goal: null },
    ]);
    expect(events.chatStreamEventActions({ type: 'error', error: 'Failed', terminal: false })).toEqual([
      { type: 'set-error', message: 'Failed' },
    ]);
    expect(events.chatStreamEventActions({ type: 'error', error: '', terminal: true })).toEqual([
      { type: 'set-error', message: 'The stream ended with an error.' },
      { type: 'mark-stream-finished' },
      { type: 'notify', notification: { title: 'Agent Cockpit stream failed', body: 'The stream ended with an error.' } },
    ]);
    expect(events.chatStreamEventActions({ type: 'done' })).toEqual([
      { type: 'set-stream-text', value: '' },
      { type: 'set-stream-placeholder', value: false },
      { type: 'mark-stream-finished' },
      { type: 'notify', notification: { title: 'Agent Cockpit stream finished', body: 'The latest response is ready.' } },
      { type: 'refresh-after-stream' },
    ]);
    expect(events.chatStreamEventActions({ type: 'replay_start' })).toEqual([
      { type: 'set-stream-text', value: '' },
      { type: 'set-stream-placeholder', value: true },
    ]);
  });

  test('projects list stream monitor events without open-chat side effects', () => {
    const message = { id: 'm1', role: 'assistant', content: 'Updated', timestamp: '2026-06-10T00:00:00.000Z' };
    const goal = { objective: 'Ship', status: 'active' };

    expect(events.listStreamEventActions({ type: 'assistant_message', message })).toEqual([
      { type: 'patch-conversation-message', message },
      { type: 'refresh-conversation-list' },
    ]);
    expect(events.listStreamEventActions({ type: 'assistant_message' })).toEqual([
      { type: 'refresh-conversation-list' },
    ]);
    expect(events.listStreamEventActions({ type: 'title_updated', title: 'New title' })).toEqual([
      { type: 'update-title', title: 'New title' },
    ]);
    expect(events.listStreamEventActions({ type: 'goal_updated', goal })).toEqual([
      { type: 'apply-goal-snapshot', goal },
    ]);
    expect(events.listStreamEventActions({ type: 'goal_cleared' })).toEqual([
      { type: 'apply-goal-snapshot', goal: null },
    ]);
    expect(events.listStreamEventActions({ type: 'error', error: 'Lost', terminal: false })).toEqual([]);
    expect(events.listStreamEventActions({ type: 'done' })).toEqual([
      { type: 'mark-list-stream-finished' },
      { type: 'notify', notification: { title: 'Agent Cockpit stream finished', body: 'The latest response is ready.' } },
    ]);
  });

  test('shares stream notifications and conversation list message patching', () => {
    expect(events.streamEventNotification({
      type: 'tool_activity',
      isQuestion: true,
      questions: [{ question: 'Pick one?' }],
    })).toEqual({ title: 'Agent Cockpit has a question', body: 'Pick one?' });
    expect(events.streamEventNotification({ type: 'error', error: 'Lost', terminal: false })).toBeNull();

    expect(events.conversationListPatchForMessage(
      { id: 'c1', lastMessage: 'Old', updatedAt: 'old-time' },
      { id: 'm1', content: '', timestamp: '' },
    )).toEqual({ id: 'c1', lastMessage: 'Old', updatedAt: 'old-time' });
    expect(events.conversationListPatchForMessage(
      { id: 'c1', lastMessage: 'Old', updatedAt: 'old-time' },
      { id: 'm1', content: 'New', timestamp: 'new-time' },
    )).toEqual({ id: 'c1', lastMessage: 'New', updatedAt: 'new-time' });
  });
});
