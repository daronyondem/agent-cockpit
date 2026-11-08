/** @jest-environment jsdom */
import { act, createElement, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadFrontendModule, loadMobileModule } from './mobileModuleLoader';
const { usePendingAttachments } = loadFrontendModule('mobile/AgentCockpitPWA/src/usePendingAttachments.ts', {
  react: require('react'), './appModel': loadMobileModule('appModel.ts'),
}, { Error });
function deferred() { let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture() {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'), root = createRoot(container), response = deferred();
  const api = { ocrAttachment: jest.fn(() => response.promise), deleteUpload: jest.fn(async () => {}) };
  const applyServerMessage = jest.fn(); let view: any;
  function Harness() {
    const [conversation, setConversation] = useState({ id: 'first', currentSessionId: 'session-1', backend: 'cortex-code', cliProfileId: 'cortex', model: 'auto', messages: [] });
    const [draft, setDraft] = useState('draft'), [model, setModel] = useState('claude-sonnet-4-6');
    const activeRef = useRef(conversation); activeRef.current = conversation;
    const attachments = usePendingAttachments({ activeConversation: conversation, activeConversationRef: activeRef, clientRef: { current: api },
      selectedCliProfileId: 'cortex', selectedBackend: 'cortex-code', selectedModel: model, selectedEffort: 'low',
      setActiveConversation: setConversation, applyServerMessage, appendToDraft: (text: string) => setDraft(current => `${current}\n${text}`) });
    view = { ...attachments, conversation, setConversation, draft, setDraft, setModel };
    return createElement('p', null, draft);
  }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => view.setPendingAttachments([{ id: 'image', fileName: 'image.png', status: 'done', result: { name: 'image.png', kind: 'image', path: '/fixture/image.png' } }]));
  return { get view() { return view; }, api, response, applyServerMessage, close: async () => { await act(async () => root.unmount()); } };
}

test('mobile OCR sends current model/effort once, appends to the latest draft and reuses its cache', async () => {
  const f = await fixture();
  try {
    let running!: Promise<void>;
    await act(async () => { running = f.view.ocrPendingAttachment('image'); void f.view.ocrPendingAttachment('image'); });
    expect(f.api.ocrAttachment).toHaveBeenCalledTimes(1);
    expect(f.api.ocrAttachment).toHaveBeenCalledWith('first', '/fixture/image.png', { backend: 'cortex-code', cliProfileId: 'cortex', model: 'claude-sonnet-4-6', effort: 'low' });
    await act(async () => f.view.setDraft('newer draft'));
    await act(async () => { f.response.resolve({ markdown: 'OCR FIXTURE' }); await running; });
    expect(f.view.draft).toBe('newer draft\nOCR FIXTURE');
    await act(async () => f.view.ocrPendingAttachment('image'));
    expect(f.view.draft).toBe('newer draft\nOCR FIXTURE\nOCR FIXTURE'); expect(f.api.ocrAttachment).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test.each(['switch', 'reset', 'remove', 'clear', 'model', 'unmount'])('late mobile OCR cannot insert after %s', async mode => {
  const f = await fixture(); let closed = false;
  try {
    let running!: Promise<void>; await act(async () => { running = f.view.ocrPendingAttachment('image'); });
    if (mode === 'unmount') { await f.close(); closed = true; }
    else await act(async () => {
      if (mode === 'switch') { f.view.setConversation({ ...f.view.conversation, id: 'second' }); f.view.setDraft('second draft'); }
      if (mode === 'reset') f.view.setConversation({ ...f.view.conversation, currentSessionId: 'session-2' });
      if (mode === 'remove') void f.view.removePendingAttachment('image');
      if (mode === 'clear') f.view.setPendingAttachments([]);
      if (mode === 'model') f.view.setModel('auto');
    });
    await act(async () => { f.response.resolve({ markdown: 'LATE OCR', recoveryMessage: { id: 'recovered', role: 'system', content: 'recovered' } }); await running; });
    expect(f.view.draft).toBe(mode === 'switch' ? 'second draft' : 'draft');
    if (mode !== 'model') expect(f.applyServerMessage).not.toHaveBeenCalled();
  } finally { if (!closed) await f.close(); }
});

test('a failed OCR retains the image and draft and permits an explicit retry', async () => {
  const f = await fixture();
  try {
    let running!: Promise<void>; await act(async () => { running = f.view.ocrPendingAttachment('image'); });
    await act(async () => { f.response.reject(new Error('Native OCR failed')); await running; });
    expect(f.view.draft).toBe('draft'); expect(f.view.pendingAttachments[0].ocrError).toBe('Native OCR failed');
    f.api.ocrAttachment.mockResolvedValueOnce({ markdown: 'RETRY' });
    await act(async () => f.view.ocrPendingAttachment('image'));
    expect(f.view.draft).toBe('draft\nRETRY'); expect(f.api.ocrAttachment).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});
