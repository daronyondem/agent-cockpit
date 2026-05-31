const { messageScrollSignature } = require('../web/AgentCockpitWeb/src/chat/messageModel.js');

describe('desktop chat message model helpers', () => {
  test('changes scroll signature when rendered content blocks change without legacy text changes', () => {
    const baseMessage = {
      id: 'assistant-pending',
      role: 'assistant',
      content: '',
      backend: 'codex',
      timestamp: '2026-05-31T00:00:00.000Z',
      contentBlocks: [],
    };
    const firstTool = {
      type: 'tool',
      activity: {
        id: 'tool-1',
        tool: 'Bash',
        description: 'Running tests',
        startTime: 1000,
      },
    };
    const secondTool = {
      type: 'tool',
      activity: {
        id: 'tool-2',
        tool: 'Read',
        description: 'Reading file',
        startTime: 1100,
      },
    };

    const empty = messageScrollSignature(baseMessage);
    const oneTool = messageScrollSignature({ ...baseMessage, contentBlocks: [firstTool] });
    const twoTools = messageScrollSignature({ ...baseMessage, contentBlocks: [firstTool, secondTool] });
    const completedTool = messageScrollSignature({
      ...baseMessage,
      contentBlocks: [{ ...firstTool, activity: { ...firstTool.activity, status: 'done', outcome: 'exit 0', duration: 120 } }],
    });
    const longerThinking = messageScrollSignature({
      ...baseMessage,
      contentBlocks: [{ type: 'thinking', content: 'checking more context' }],
    });

    expect(oneTool).not.toBe(empty);
    expect(twoTools).not.toBe(oneTool);
    expect(completedTool).not.toBe(oneTool);
    expect(longerThinking).not.toBe(empty);
  });
});
