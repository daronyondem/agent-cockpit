import { processStream } from '../src/routes/chat';
import type { ChatService } from '../src/services/chatService';
import type { ContentBlock, StreamEvent, WsServerFrame } from '../src/types';

function makeStream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  return (async function* stream() {
    for (const event of events) yield event;
  })();
}

async function collectProcessStreamTrace(events: StreamEvent[]) {
  const frames: WsServerFrame[] = [];
  let messageIndex = 0;
  const timestampFor = (index: number) => new Date(Date.UTC(2026, 4, 25, 0, 0, index)).toISOString();
  const chatService = {
    addMessage: jest.fn(async (
      _convId: string,
      role: string,
      content: string,
      backend: string,
      thinking?: string | null,
      toolActivity?: unknown,
      turn?: unknown,
      contentBlocks?: unknown,
      extra?: Record<string, unknown>,
    ) => ({
      id: `msg-${++messageIndex}`,
      role,
      content,
      backend,
      timestamp: timestampFor(messageIndex),
      ...(thinking ? { thinking } : {}),
      ...(toolActivity ? { toolActivity } : {}),
      ...(turn ? { turn } : {}),
      ...(contentBlocks ? { contentBlocks } : {}),
      ...(extra || {}),
    })),
    addStreamErrorMessage: jest.fn(async (_convId: string, backend: string, message: string, source: string) => ({
      id: `msg-${++messageIndex}`,
      role: 'assistant',
      content: `Stream failed: ${message}`,
      backend,
      timestamp: timestampFor(messageIndex),
      streamError: { message, source },
    })),
    addUsage: jest.fn(async (_convId: string, usage: unknown) => ({ conversationUsage: usage, sessionUsage: usage })),
    createConversationArtifact: jest.fn(),
    generateAndUpdateTitle: jest.fn(),
  };

  await processStream(
    'conv-golden',
    {
      stream: makeStream(events),
      abort: () => {},
      sendInput: () => {},
      backend: 'claude-code',
      needsTitleUpdate: false,
      titleUpdateMessage: null,
    },
    frame => frames.push(frame),
    () => false,
    () => {},
    { chatService: chatService as unknown as ChatService },
  );

  return { frames, chatService };
}

describe('processStream golden traces', () => {
  test('emits and persists an ordered mixed-content assistant turn', async () => {
    const { frames, chatService } = await collectProcessStreamTrace([
      { type: 'text', content: 'Hello ' },
      { type: 'thinking', content: 'checking' },
      { type: 'tool_activity', tool: 'Read', description: 'Read file', id: 'tool-1' },
      { type: 'tool_outcomes', outcomes: [{ toolUseId: 'tool-1', isError: false, outcome: 'ok', status: 'success' }] },
      { type: 'artifact', artifact: { filename: 'chart.png', path: '/tmp/chart.png', kind: 'image', title: 'Chart' } },
      { type: 'text', content: 'world' },
      { type: 'done' },
    ] as StreamEvent[]);

    expect(frames.map(frame => frame.type)).toEqual([
      'text',
      'thinking',
      'tool_activity',
      'tool_outcomes',
      'artifact',
      'text',
      'assistant_message',
      'done',
    ]);
    const assistantFrame = frames.find(
      (frame): frame is Extract<WsServerFrame, { type: 'assistant_message' }> => frame.type === 'assistant_message',
    );
    expect(assistantFrame?.message).toMatchObject({
      content: 'Hello world',
      thinking: 'checking',
      turn: 'final',
    });

    expect(chatService.addMessage).toHaveBeenCalledTimes(1);
    const call = chatService.addMessage.mock.calls[0];
    expect(call[2]).toBe('Hello world');
    expect(call[4]).toBe('checking');
    expect(call[6]).toBe('final');
    expect(call[5]).toEqual([
      expect.objectContaining({
        tool: 'Read',
        description: 'Read file',
        id: 'tool-1',
        outcome: 'ok',
        status: 'success',
        duration: expect.any(Number),
      }),
    ]);
    expect((call[7] as ContentBlock[]).map(block => block.type)).toEqual(['text', 'thinking', 'tool', 'artifact', 'text']);
    expect(call[7]).toEqual([
      { type: 'text', content: 'Hello ' },
      { type: 'thinking', content: 'checking' },
      { type: 'tool', activity: expect.objectContaining({ id: 'tool-1', outcome: 'ok', status: 'success' }) },
      { type: 'artifact', artifact: { filename: 'chart.png', path: '/tmp/chart.png', kind: 'image', title: 'Chart' } },
      { type: 'text', content: 'world' },
    ]);
  });

  test('persists result-only streams as a final text block', async () => {
    const { frames, chatService } = await collectProcessStreamTrace([
      { type: 'result', content: 'Final result' },
      { type: 'done' },
    ] as StreamEvent[]);

    expect(frames.map(frame => frame.type)).toEqual(['assistant_message', 'done']);
    expect(chatService.addMessage).toHaveBeenCalledTimes(1);
    expect(chatService.addMessage.mock.calls[0][2]).toBe('Final result');
    expect(chatService.addMessage.mock.calls[0][6]).toBe('final');
    expect(chatService.addMessage.mock.calls[0][7]).toEqual([{ type: 'text', content: 'Final result' }]);
  });

  test('emits synthetic plan approval from a successful plan-file outcome', async () => {
    const { frames, chatService } = await collectProcessStreamTrace([
      { type: 'tool_activity', tool: 'EnterPlanMode', isPlanMode: true, planAction: 'enter', description: 'Entering plan mode' },
      { type: 'tool_activity', tool: 'Write', id: 'plan-write', isPlanFile: true, planContent: '# Plan from file', planFilePath: '/tmp/plan.md', description: 'Writing plan file' },
      { type: 'tool_outcomes', outcomes: [{ toolUseId: 'plan-write', isError: false, outcome: 'written', status: 'success' }] },
      { type: 'done' },
    ] as StreamEvent[]);

    expect(frames.map(frame => frame.type)).toEqual([
      'tool_activity',
      'tool_activity',
      'tool_activity',
      'tool_outcomes',
      'done',
    ]);
    expect(frames[1]).toMatchObject({
      type: 'tool_activity',
      tool: 'Write',
      id: 'plan-write',
      isPlanFile: true,
      planFilePath: '/tmp/plan.md',
      description: 'Writing plan file',
    });
    expect(frames[1]).not.toHaveProperty('planContent');
    const planExit = frames[2];
    expect(planExit).toMatchObject({
      type: 'tool_activity',
      tool: 'ExitPlanMode',
      id: 'plan-write:plan',
      isPlanMode: true,
      planAction: 'exit',
      planContent: '# Plan from file',
    });
    expect(chatService.addMessage).not.toHaveBeenCalled();
  });
});
