/** @jest-environment jsdom */
import { act, createElement, useState, type Dispatch, type SetStateAction } from 'react';
import { createRoot } from 'react-dom/client';
import { loadMobileModule } from './mobileModuleLoader';

type PendingInteraction = { kind: 'question' | 'plan'; prompt: string; options?: unknown[]; decisionId?: string; requestId?: string };

class MockApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const { useSendPipeline } = loadMobileModule('useSendPipeline.ts', {
  react: require('react'), './api': { AgentAPIError: MockApiError }, './appModel': loadMobileModule('appModel.ts'),
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
    await act(async () => { view.current.setAnswer('A newer answer'); });
    await act(async () => { acknowledge({ mode: 'stdin' }); await answering; });
    expect(view.current.interaction).toBe(next);
    expect(view.current.answer).toBe('A newer answer');
    expect(view.container.textContent).toBe(next.prompt);
    expect(sendInput).toHaveBeenCalledWith('fixture', 'Blue', true, first.decisionId ? { decisionId: first.decisionId } : {});
    sendInput.mockResolvedValueOnce({ mode: 'stdin' });
    await act(async () => { await view.current.submitInteraction('Large'); });
    expect(sendInput).toHaveBeenCalledTimes(2);
    expect(sendInput).toHaveBeenLastCalledWith('fixture', 'Large', true, next.decisionId ? { decisionId: next.decisionId } : {});
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
    await act(async () => view.current.submitInteraction()); expect(sendInput).toHaveBeenLastCalledWith('fixture', 'Violet draft', true, next.decisionId ? { decisionId: next.decisionId } : {});
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
    expect(sendInput).toHaveBeenCalledWith('fixture', 'Blue', false, {});
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

test.each([false, true])('message-mode answers preserve separate drafts/uploads before and after a send (failure=%s)', async fail => {
  const fixture = messageSendFixture();
  let resolve!: (response: unknown) => void, reject!: (error: Error) => void;
  fixture.sendMessage.mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
  const sendInput = jest.fn().mockResolvedValue({ mode: 'message' });
  const originalUploads = [{ id: 'original-upload', status: 'done' }];
  const newerUploads = [{ id: 'newer-upload', status: 'done' }];
  const onError = jest.fn();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement('div')); let view: any;
  function Harness() {
    const [draft, setDraft] = useState('Separate follow-up');
    const [uploads, setUploads] = useState(originalUploads);
    const [interaction, setInteraction] = useState<PendingInteraction | null>(question);
    const pipeline = useSendPipeline({ ...fixture.extra,
      activeConversation: { id: 'fixture', messages: [] }, pendingInteraction: interaction, interactionAnswer: 'Blue',
      clientRef: { current: { sendInput, sendMessage: fixture.sendMessage } },
      draft, setDraft, pendingAttachments: uploads, setPendingAttachments: setUploads,
      setPendingInteraction: setInteraction, setInteractionAnswer: jest.fn(), onError,
    });
    view = { ...pipeline, draft, uploads, setDraft, setUploads }; return null;
  }
  let sending: Promise<void> | undefined;
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { sending = view.submitInteraction('Blue'); });
    expect(fixture.sendMessage).toHaveBeenCalledWith('fixture', expect.objectContaining({ content: 'Blue' }));
    expect(fixture.sendMessage.mock.calls[0][1]).not.toHaveProperty('attachments');
    expect(view.draft).toBe('Separate follow-up'); expect(view.uploads).toBe(originalUploads);
    await act(async () => { view.setDraft('Newer follow-up'); view.setUploads(newerUploads); });
    await act(async () => {
      if (fail) reject(new Error('Answer send failed'));
      else resolve({ userMessage: { id: 'answer', role: 'user', content: 'Blue' }, streamReady: true });
      await sending;
    });
    expect(view.draft).toBe('Newer follow-up'); expect(view.uploads).toBe(newerUploads);
    expect(onError).toHaveBeenCalledTimes(fail ? 1 : 0);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => { resolve?.({ userMessage: { id: 'answer', role: 'user', content: 'Blue' }, streamReady: true }); await sending; root.unmount(); });
  }
});

test('mobile submits a correlated question once and refuses message fallback', async () => {
  const sendInput = jest.fn().mockResolvedValue({ mode: 'message' });
  const currentQuestion = { ...question, requestId: 'exact-question' };
  const view = await renderPipeline(currentQuestion, sendInput);
  try {
    await act(async () => { await Promise.all([view.current.submitInteraction(), view.current.submitInteraction()]); });
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith('fixture', 'Blue', true, { requestId: 'exact-question' });
    expect(view.current.interaction).toBe(currentQuestion);
    expect(view.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'This question is no longer accepting an answer.' }));
  } finally { await view.close(); }
});

test.each([true, false])('mobile steering preserves the draft/files until acknowledgement and never queues a retry (accepted: %s)', async accepted => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement('div'));
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const sendInput = jest.fn(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
  const saveQueue = jest.fn(); const sendMessage = jest.fn(); const onError = jest.fn();
  const attachment = { id: 'file', status: 'done', result: { name: 'input.txt', path: '/tmp/input.txt' } };
  const conversation = { id: 'fixture', messages: [] };
  let current: any;
  function Harness() {
    const [draft, setDraft] = useState('Correct it');
    const [attachments, setPendingAttachments] = useState([attachment]);
    const pipeline = useSendPipeline({ activeConversation: conversation, activeConversationRef: { current: conversation },
      clientRef: { current: { sendInput, saveQueue, sendMessage } }, draft, setDraft, pendingAttachments: attachments, setPendingAttachments,
      isStreaming: true, inputTurnId: 'turn', setErrorMessage: jest.fn(), onError });
    current = { ...pipeline, draft, attachments, setDraft };
    return null;
  }
  try {
    await act(async () => { root.render(createElement(Harness)); });
    let pending!: Promise<void>;
    await act(async () => { pending = current.steerDraft(); });
    await act(async () => { await current.steerDraft(); await current.sendDraft(); });
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith('fixture', 'Correct it\n\n[Uploaded files: /tmp/input.txt]', true, { turnId: 'turn', inputId: expect.any(String) });
    expect(current.draft).toBe('Correct it'); expect(current.attachments).toEqual([attachment]);
    await act(async () => { current.setDraft('Newer draft'); });
    await act(async () => { if (accepted) resolve({ mode: 'stdin' }); else reject(new Error('Late steering')); await pending; });
    expect(current.draft).toBe('Newer draft');
    expect(current.attachments).toEqual(accepted ? [] : [attachment]);
    expect(current.steeringPending).toBe(false);
    expect(saveQueue).not.toHaveBeenCalled(); expect(sendMessage).not.toHaveBeenCalled();
    if (!accepted) expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Late steering' }));
  } finally { await act(async () => { root.unmount(); }); }
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
    expect(sendMessage).toHaveBeenCalledWith('fixture', expect.objectContaining({ effort: null }));
    expect(attachments).toEqual([attachment]);
    expect(streaming).toBe(false);
    expect(conversation.messages).toEqual([]);
    expect(recoverActiveStream).toHaveBeenCalledWith('fixture', { onlyIfServerActive: true });
    expect(markStreamFinished).toHaveBeenCalledWith('fixture');
    expect(onError).toHaveBeenCalledWith(error);
  } finally { await act(async () => { root.unmount(); }); }
});
