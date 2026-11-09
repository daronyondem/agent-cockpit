/** @jest-environment jsdom */
import { act, createElement, useState, type Dispatch, type SetStateAction } from 'react';
import { createRoot } from 'react-dom/client';
import { loadMobileModule } from './mobileModuleLoader';

type PendingInteraction = { kind: 'question' | 'plan'; prompt: string; options?: unknown[]; decisionId?: string };

const { useSendPipeline } = loadMobileModule('useSendPipeline.ts', {
  react: require('react'), './api': {}, './appModel': loadMobileModule('appModel.ts'),
});

async function renderPipeline(first: PendingInteraction, sendInput: jest.Mock, extra: Record<string, unknown> = {}, client: Record<string, unknown> = {}) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  let current!: {
    interaction: PendingInteraction | null;
    setInteraction: Dispatch<SetStateAction<PendingInteraction | null>>;
    submitInteraction: (answer?: string) => Promise<void>;
    answer: string; setAnswer: Dispatch<SetStateAction<string>>; isResponding: boolean;
  };
  const onError = jest.fn();
  function Harness() {
    const [interaction, setInteraction] = useState<PendingInteraction | null>(first);
    const [answer, setAnswer] = useState('Blue');
    const pipeline = useSendPipeline({
      activeConversation: { id: 'fixture' }, pendingInteraction: interaction, interactionAnswer: answer,
      isStreaming: true, loading: false, clientRef: { current: { sendInput, ...client } },
      setPendingInteraction: setInteraction, setInteractionAnswer: setAnswer, onError, ...extra,
    });
    current = { interaction, setInteraction, answer, setAnswer, isResponding: pipeline.isResponding, submitInteraction: pipeline.submitInteraction };
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
  { first: { ...question, decisionId: 'cortex-decision:original' }, next: { ...question, decisionId: 'cortex-decision:next' } },
])('mobile preserves a follow-up $next.kind received before the input response', async ({ first, next }) => {
  let acknowledge!: (response: { mode: string }) => void;
  const sendInput = jest.fn(() => new Promise(resolve => { acknowledge = resolve; }));
  const view = await renderPipeline(first, sendInput);
  try {
    let answering!: Promise<void>;
    await act(async () => { answering = view.current.submitInteraction('Blue'); });
    await act(async () => { view.current.setInteraction(next); });
    await act(async () => { acknowledge({ mode: 'stdin' }); await answering; });
    expect(view.current.interaction).toBe(next);
    expect(view.container.textContent).toBe(next.prompt);
    expect(sendInput).toHaveBeenCalledWith('fixture', 'Blue', true, first.decisionId);
    sendInput.mockResolvedValueOnce({ mode: 'stdin' });
    await act(async () => { await view.current.submitInteraction('Large'); });
    expect(sendInput).toHaveBeenCalledTimes(2);
    expect(sendInput).toHaveBeenLastCalledWith('fixture', 'Large', true, next.decisionId);
    expect(view.current.interaction).toBeNull();
  } finally { await view.close(); }
});

test('mobile clears the answered interaction after a successful input response', async () => {
  const view = await renderPipeline(question, jest.fn().mockResolvedValue({ mode: 'stdin' }));
  try {
    await act(async () => { await view.current.submitInteraction('Blue'); });
    expect(view.current.interaction).toBeNull();
  } finally { await view.close(); }
});

test('mobile keeps the interaction available when input delivery fails', async () => {
  const error = new Error('Input unavailable');
  const view = await renderPipeline(question, jest.fn().mockRejectedValue(error));
  try {
    await act(async () => { await view.current.submitInteraction('Blue'); });
    expect(view.current.interaction).toBe(question);
    expect(view.onError).toHaveBeenCalledWith(error);
  } finally { await view.close(); }
});

test.each([false, true])('mobile blocks duplicates/stale callbacks and preserves a newer draft (old reply fails=%s)', async fail => {
  let acknowledge!: (response: { mode: string }) => void;
  const sendInput = jest.fn(() => new Promise(resolve => { acknowledge = resolve; }));
  let reject!: (error: Error) => void;
  sendInput.mockImplementation(() => new Promise((resolve, no) => { acknowledge = resolve; reject = no; }));
  const first = { ...question, decisionId: 'cortex-decision:first' };
  const view = await renderPipeline(first, sendInput);
  try {
    const staleSubmit = view.current.submitInteraction;
    let answering!: Promise<void>;
    await act(async () => { answering = staleSubmit('Blue'); void staleSubmit('Blue'); });
    expect(sendInput).toHaveBeenCalledTimes(1); expect(view.current.isResponding).toBe(true);
    const next = { ...question, decisionId: 'cortex-decision:next' };
    await act(async () => view.current.setInteraction(next));
    expect(view.current.answer).toBe('');
    await act(async () => view.current.setAnswer('Violet draft'));
    await act(async () => { if (fail) reject(new Error('old reply failed')); else acknowledge({ mode: 'stdin' }); await answering; });
    expect(view.onError).not.toHaveBeenCalled();
    expect(view.current.answer).toBe('Violet draft'); expect(view.current.interaction).toBe(next); expect(view.current.isResponding).toBe(false);
    await act(async () => staleSubmit('Blue')); expect(sendInput).toHaveBeenCalledTimes(1);
    sendInput.mockResolvedValueOnce({ mode: 'stdin' });
    await act(async () => view.current.submitInteraction()); expect(sendInput).toHaveBeenLastCalledWith('fixture', 'Violet draft', true, next.decisionId);
  } finally { await view.close(); }
});

function messageSendFixture() {
  const sendMessage = jest.fn().mockResolvedValue({ userMessage: { id: 'server-user', role: 'user', content: 'Blue' }, streamReady: true });
  const startStream = jest.fn();
  const extra = { activeConversationRef: { current: null }, isStreaming: false, startStream, markStreamFinished: jest.fn(),
    recoverActiveStream: jest.fn().mockResolvedValue(false), setDraft: jest.fn(), setPendingAttachments: jest.fn(),
    setErrorMessage: jest.fn(), setStreamText: jest.fn(), setShowStreamPlaceholder: jest.fn(), setIsStreaming: jest.fn(),
    setActiveStreamIDs: jest.fn(), setActiveConversation: jest.fn() };
  return { sendMessage, startStream, extra };
}

test('mobile sends a message-mode answer before its cleared card re-renders', async () => {
  const { sendMessage, startStream, extra } = messageSendFixture();
  const sendInput = jest.fn().mockResolvedValue({ mode: 'message' });
  const view = await renderPipeline(question, sendInput, extra, { sendMessage });
  try {
    await act(async () => { await view.current.submitInteraction('Blue'); });
    expect(sendInput).toHaveBeenCalledWith('fixture', 'Blue', false, undefined);
    expect(sendMessage).toHaveBeenCalledWith('fixture', expect.objectContaining({ content: 'Blue' }));
    expect(startStream).toHaveBeenCalledWith('fixture');
    expect(view.current.interaction).toBeNull();
    expect(view.onError).not.toHaveBeenCalled();
  } finally { await view.close(); }
});

test('a message-mode answer cannot bypass a newer card', async () => {
  const { sendMessage, extra } = messageSendFixture();
  let acknowledge!: (response: { mode: string }) => void;
  const view = await renderPipeline(question, jest.fn(() => new Promise(resolve => { acknowledge = resolve; })), extra, { sendMessage });
  try {
    let answering!: Promise<void>;
    await act(async () => { answering = view.current.submitInteraction('Blue'); });
    const next: PendingInteraction = { kind: 'plan', prompt: '# Newer plan' };
    await act(async () => { view.current.setInteraction(next); });
    await act(async () => { acknowledge({ mode: 'message' }); await answering; });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(view.current.interaction).toBe(next);
  } finally { await view.close(); }
});
