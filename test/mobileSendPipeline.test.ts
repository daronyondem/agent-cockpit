/** @jest-environment jsdom */
import { act, createElement, useState, type Dispatch, type SetStateAction } from 'react';
import { createRoot } from 'react-dom/client';
import { loadMobileModule } from './mobileModuleLoader';

type PendingInteraction = { kind: 'question' | 'plan'; prompt: string; options?: unknown[] };

class MockApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const { useSendPipeline } = loadMobileModule('useSendPipeline.ts', {
  react: require('react'), './api': { AgentAPIError: MockApiError }, './appModel': loadMobileModule('appModel.ts'),
});

async function renderPipeline(first: PendingInteraction, sendInput: jest.Mock) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  let current!: {
    interaction: PendingInteraction | null;
    setInteraction: Dispatch<SetStateAction<PendingInteraction | null>>;
    submitInteraction: (answer?: string) => Promise<void>;
  };
  const onError = jest.fn();
  function Harness() {
    const [interaction, setInteraction] = useState<PendingInteraction | null>(first);
    const [answer, setAnswer] = useState('Blue');
    const pipeline = useSendPipeline({
      activeConversation: { id: 'fixture' }, pendingInteraction: interaction, interactionAnswer: answer,
      isStreaming: true, loading: false, clientRef: { current: { sendInput } },
      setPendingInteraction: setInteraction, setInteractionAnswer: setAnswer, onError,
    });
    current = { interaction, setInteraction, submitInteraction: pipeline.submitInteraction };
    return createElement('p', null, interaction?.prompt);
  }
  await act(async () => { root.render(createElement(Harness)); });
  return {
    get current() { return current; }, container, onError,
    close: async () => { await act(async () => { root.unmount(); }); },
  };
}

const question: PendingInteraction = { kind: 'question', prompt: 'Color?', options: [] };
test.each<{ first: PendingInteraction; next: PendingInteraction }>([
  { first: question, next: { kind: 'question', prompt: 'Size?', options: [] } },
  { first: { kind: 'plan', prompt: '# Original plan' }, next: { kind: 'plan', prompt: '# Revised plan' } },
])('mobile preserves a follow-up $next.kind received before the input response', async ({ first, next }) => {
  let acknowledge!: (response: { mode: string }) => void;
  const sendInput = jest.fn(() => new Promise(resolve => { acknowledge = resolve; }));
  const view = await renderPipeline(first, sendInput);
  try {
    let answering!: Promise<void>;
    await act(async () => { answering = view.current.submitInteraction(); });
    await act(async () => { view.current.setInteraction(next); });
    await act(async () => { acknowledge({ mode: 'stdin' }); await answering; });
    expect(view.current.interaction).toBe(next);
    expect(view.container.textContent).toBe(next.prompt);
    expect(sendInput).toHaveBeenCalledWith('fixture', 'Blue', true);
    sendInput.mockResolvedValueOnce({ mode: 'stdin' });
    await act(async () => { await view.current.submitInteraction('Large'); });
    expect(sendInput).toHaveBeenCalledTimes(2);
    expect(view.current.interaction).toBeNull();
  } finally { await view.close(); }
});

test('mobile clears the answered interaction after a successful input response', async () => {
  const view = await renderPipeline(question, jest.fn().mockResolvedValue({ mode: 'stdin' }));
  try {
    await act(async () => { await view.current.submitInteraction(); });
    expect(view.current.interaction).toBeNull();
  } finally { await view.close(); }
});

test('mobile keeps the interaction available when input delivery fails', async () => {
  const error = new Error('Input unavailable');
  const view = await renderPipeline(question, jest.fn().mockRejectedValue(error));
  try {
    await act(async () => { await view.current.submitInteraction(); });
    expect(view.current.interaction).toBe(question);
    expect(view.onError).toHaveBeenCalledWith(error);
  } finally { await view.close(); }
});

test('mobile reset admission failures restore the draft without attaching a phantom stream', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const error = new MockApiError('Session is resetting. Try again shortly.', 503);
  const sendMessage = jest.fn().mockRejectedValue(error);
  const recoverActiveStream = jest.fn().mockResolvedValue(false);
  const onError = jest.fn();
  const attachment = { id: 'attachment', name: 'image.png', status: 'done', result: { name: 'image.png', path: '/tmp/image.png', kind: 'image' } };
  let draft = 'Keep this draft';
  let attachments = [attachment];
  let streaming = false;
  let conversation: any = { id: 'fixture', backend: 'copilot', cliProfileId: 'profile', messages: [] };
  const activeConversationRef = { current: conversation };
  const markStreamFinished = jest.fn(() => { streaming = false; });
  let pipeline: any;
  function Harness() {
    pipeline = useSendPipeline({
      activeConversation: conversation, activeConversationRef,
      clientRef: { current: { sendMessage } }, pendingAttachments: attachments,
      draft, isStreaming: streaming, goalMode: false, hasUploadingAttachments: false,
      setDraft: (value: string) => { draft = value; },
      setPendingAttachments: (value: typeof attachments) => { attachments = value; },
      setErrorMessage: jest.fn(), setPendingInteraction: jest.fn(), setStreamText: jest.fn(),
      setShowStreamPlaceholder: jest.fn(), setIsStreaming: (value: boolean) => { streaming = value; },
      setActiveStreamIDs: jest.fn(), setActiveConversation: (update: (value: any) => any) => { conversation = update(conversation); },
      recoverActiveStream, markStreamFinished, onError,
    });
    return null;
  }
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { await pipeline.sendDraft(); });
    expect(draft).toBe('Keep this draft');
    expect(attachments).toEqual([attachment]);
    expect(streaming).toBe(false);
    expect(conversation.messages).toEqual([]);
    expect(recoverActiveStream).toHaveBeenCalledWith('fixture', { onlyIfServerActive: true });
    expect(markStreamFinished).toHaveBeenCalledWith('fixture');
    expect(onError).toHaveBeenCalledWith(error);
  } finally { await act(async () => { root.unmount(); }); }
});
