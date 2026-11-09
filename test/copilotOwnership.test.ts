import { __copilotTestUtils } from '../src/services/backends/copilot';
const { collectCopilotJson, translateCopilotLine } = __copilotTestUtils;
const line = (event: Record<string, unknown>) => JSON.stringify(event);

describe('Copilot parent/child response ownership', () => {
  const owners = [
    { agentId: 'child' },
    { data: { parentToolCallId: 'task-call' } },
    { agentId: 'grandchild', data: { parentToolCallId: 'nested-task' } },
  ];

  test.each(owners)('isolates child deltas, final messages and reasoning: %j', owner => {
    const events = [
      { type: 'assistant.message_delta', data: { messageId: 'child', deltaContent: 'CHILD' } },
      { type: 'assistant.message', data: { messageId: 'child', content: 'CHILD FINAL' } },
      { type: 'assistant.reasoning_delta', data: { deltaContent: 'CHILD THINKING' } },
      { type: 'tool.execution_start', data: { toolCallId: 'child-tool', toolName: 'bash' } },
      { type: 'tool.execution_complete', data: { toolCallId: 'child-tool', success: true } },
    ].map(event => ({ ...event, ...owner, data: { ...event.data, ...owner.data } }));
    for (const event of events) expect(translateCopilotLine(line(event))).toEqual([]);
    const result = collectCopilotJson([
      line({ type: 'tool.execution_start', data: { toolCallId: 'task-call', toolName: 'task' } }),
      ...events.map(line),
      line({ type: 'assistant.message', data: { messageId: 'parent', content: '{"answer":"PARENT"}' } }),
    ].join('\n'));
    expect(result.text).toBe('{"answer":"PARENT"}');
  });

  test('child work does not erase the parent answer when a background child finishes later', () => {
    const events = [
      { type: 'assistant.message', data: { messageId: 'parent', content: '{"answer":"PARENT"}' } },
      { type: 'tool.execution_start', agentId: 'child', data: { toolCallId: 'child-tool', toolName: 'view' } },
      { type: 'assistant.message', agentId: 'child', data: { messageId: 'child', content: 'CHILD' } },
      { type: 'tool.execution_complete', agentId: 'child', data: { toolCallId: 'child-tool', success: true } },
      { type: 'session.usage_checkpoint', data: {
        totalPremiumRequests: 3, accountingSnapshot: { tokenDetails: {
          input: { tokenCount: 10 }, output: { tokenCount: 20 }, cache_read: { tokenCount: 30 }, cache_write: { tokenCount: 40 },
        } },
      } },
    ];
    const result = collectCopilotJson(events.map(line).join('\n'));
    expect(result.text).toBe('{"answer":"PARENT"}');
    expect(result.usage).toMatchObject({ outputTokens: 20, inputTokens: 10, credits: 3 });
  });
});
