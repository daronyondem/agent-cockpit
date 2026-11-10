/** @jest-environment jsdom */
import { act, createElement, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadMobileModule } from './mobileModuleLoader';
const model = loadMobileModule('appModel.ts');
class APIError extends Error { status = 500; }
const { useSendPipeline } = loadMobileModule('useSendPipeline.ts', { react: require('react'), './api': { AgentAPIError: APIError }, './appModel': model });
function deferred() { let resolve!: (value: any) => void, reject!: (error: Error) => void; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture(streaming = true, failed = false) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'), root = createRoot(container);
  const api = { saveQueue: jest.fn(async (_id, queue) => queue), sendMessage: jest.fn(async (_id: string, _body: unknown) => ({ userMessage: { id: 'accepted', role: 'user', content: 'queued' }, streamReady: true })) };
  const onError = jest.fn(); let view: any;
  function Harness() {
    const [conversation, setConversation] = useState({ id: 'fixture', backend: 'cortex-code', messageQueue: [{ content: 'queued' }], messages: failed ? [{ id: 'failed', role: 'assistant', streamError: 'Aborted by user' }] : [] });
    const [draft, setDraft] = useState('draft'), [attachments, setAttachments] = useState<any[]>([]);
    const [isStreaming, setStreaming] = useState(streaming), [interaction, setInteraction] = useState<any>(null);
    const [answer, setAnswer] = useState(''), [error, setError] = useState<string | null>(null);
    const activeRef = useRef(conversation); activeRef.current = conversation;
    const pipeline = useSendPipeline({ activeConversation: conversation, activeConversationRef: activeRef, clientRef: { current: api },
      draft, setDraft, pendingAttachments: attachments, setPendingAttachments: setAttachments, hasUploadingAttachments: false,
      pendingInteraction: interaction, setPendingInteraction: setInteraction, interactionAnswer: answer, setInteractionAnswer: setAnswer,
      loading: false, errorMessage: error, isStreaming, goalMode: false, selectedBackendID: 'cortex-code', selectedBackend: 'cortex-code',
      selectedCliProfileId: 'cortex', selectedModel: 'claude-sonnet-4-6', serviceTierEnabled: false, onError,
      setErrorMessage: setError, setActiveConversation: setConversation, setStreamText: jest.fn(), setShowStreamPlaceholder: jest.fn(),
      setIsStreaming: setStreaming, setActiveStreamIDs: jest.fn(), startStream: () => setStreaming(true), markStreamFinished: jest.fn(), recoverActiveStream: async () => false });
    view = { ...pipeline, conversation, setConversation, draft, setDraft, attachments, setAttachments, setStreaming, interaction, setInteraction, error, setError };
    return createElement('p', null, draft);
  }
  await act(async () => root.render(createElement(Harness)));
  return { get view() { return view; }, api, onError, close: async () => { await act(async () => root.unmount()); } };
}

test.each([false, true])('mobile queues once and retains newer text/attachments or the failed draft (failure=%s)', async failed => {
  const f = await fixture(), saved = deferred(); f.api.saveQueue.mockImplementationOnce(() => saved.promise);
  try {
    const old = { id: 'queued upload', result: { name: 'queued.txt', path: '/fixture/queued.txt', kind: 'text' } };
    await act(async () => f.view.setAttachments([old]));
    let sending!: Promise<void>;
    await act(async () => { sending = f.view.sendDraft(); void f.view.sendDraft(); });
    expect(f.api.saveQueue).toHaveBeenCalledTimes(1); expect(f.view.isSending).toBe(true);
    if (!failed) await act(async () => { f.view.setDraft('newer draft'); f.view.setAttachments([old, { id: 'newer upload' }]); });
    await act(async () => { if (failed) saved.reject(new Error('Queue unavailable')); else saved.resolve([{ content: 'queued' }, { content: 'draft' }]); await sending; });
    expect(f.view.draft).toBe(failed ? 'draft' : 'newer draft');
    expect(f.api.saveQueue.mock.calls[0][1][1].attachments).toEqual([old.result]);
    expect(f.view.attachments).toEqual(failed ? [old] : [{ id: 'newer upload' }]);
    expect(f.view.isSending).toBe(false); expect(f.api.sendMessage).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalledTimes(failed ? 1 : 0);
  } finally { await f.close(); }
});

test('a pre-completion mobile handler drains with current state once and preserves an unsent draft', async () => {
  const f = await fixture(); const staleDrain = f.view.drainNextQueuedMessage;
  try {
    await act(async () => f.view.setStreaming(false));
    await act(async () => { await Promise.all([staleDrain(f.view.conversation), staleDrain(f.view.conversation)]); });
    expect(f.api.sendMessage).toHaveBeenCalledTimes(1); expect(f.api.sendMessage.mock.calls[0][1]).toMatchObject({ content: 'queued' });
    expect(f.view.conversation.messageQueue).toEqual([]); expect(f.view.draft).toBe('draft');
  } finally { await f.close(); }
});

test.each([false, true])('mobile sends explicit upload references from the message snapshot (queued=%s)', async queued => {
  const f = await fixture(false);
  const attachment = { name: 'image.png', path: '/fixture/image.png', kind: 'image' };
  try {
    if (queued) await act(async () => f.view.setConversation({ ...f.view.conversation, messageQueue: [{ content: 'queued image', attachments: [attachment] }] }));
    else await act(async () => f.view.setAttachments([{ id: 'uploaded', status: 'done', result: attachment }]));
    await act(async () => { if (queued) await f.view.drainNextQueuedMessage(f.view.conversation); else await f.view.sendDraft(); });
    expect(f.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.api.sendMessage.mock.calls[0][1]).toMatchObject({ attachments: [{ name: 'image.png' }] });
    expect((f.api.sendMessage.mock.calls[0][1] as any).content).toContain('[Uploaded files: /fixture/image.png]');
  } finally { await f.close(); }
});

test.each(['question', 'switch'])('a mobile %s arriving during queue removal restores the queue without sending', async mode => {
  const f = await fixture(false), saved = deferred(); f.api.saveQueue.mockImplementationOnce(() => saved.promise);
  try {
    const original = f.view.conversation; let draining!: Promise<void>;
    await act(async () => { draining = f.view.drainNextQueuedMessage(original); });
    await act(async () => { if (mode === 'question') f.view.setInteraction({ kind: 'question', prompt: 'New question', decisionId: 'cortex-decision:new' });
      else f.view.setConversation({ ...original, id: 'another', messageQueue: [] }); });
    await act(async () => { saved.resolve([]); await draining; });
    expect(f.api.sendMessage).not.toHaveBeenCalled(); expect(f.api.saveQueue).toHaveBeenLastCalledWith('fixture', original.messageQueue);
    expect(f.view.conversation.id).toBe(mode === 'switch' ? 'another' : 'fixture');
    if (mode === 'question') { expect(f.view.conversation.messageQueue).toEqual(original.messageQueue); expect(f.view.interaction.decisionId).toBe('cortex-decision:new'); }
  } finally { await f.close(); }
});

test('mobile interruption does not auto-drain, while an explicit resume sends the queued work once', async () => {
  const f = await fixture(false, true);
  try {
    await act(async () => f.view.drainNextQueuedMessage(f.view.conversation)); expect(f.api.saveQueue).not.toHaveBeenCalled();
    await act(async () => { await Promise.all([f.view.drainNextQueuedMessage(f.view.conversation, true), f.view.drainNextQueuedMessage(f.view.conversation, true)]); });
    expect(f.api.sendMessage).toHaveBeenCalledTimes(1); expect(f.view.draft).toBe('draft');
  } finally { await f.close(); }
});

test('mobile Stop pauses the queue before an older successful transcript refresh completes', async () => {
  const f = await fixture(false);
  try {
    f.view.suspendQueue('fixture');
    await act(async () => f.view.drainNextQueuedMessage(f.view.conversation));
    expect(f.api.sendMessage).not.toHaveBeenCalled(); expect(f.api.saveQueue).not.toHaveBeenCalled();
    await act(async () => f.view.drainNextQueuedMessage(f.view.conversation, true));
    expect(f.api.sendMessage).toHaveBeenCalledTimes(1); expect(f.view.draft).toBe('draft');
  } finally { await f.close(); }
});


test('an unrelated mobile warning does not pause a successful queue', async () => {
  const f = await fixture(false);
  try {
    await act(async () => f.view.setError('Nonterminal warning'));
    await act(async () => f.view.drainNextQueuedMessage(f.view.conversation));
    expect(f.api.sendMessage).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});
