/** @jest-environment jsdom */
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadMobileModule } from './mobileModuleLoader';
const { useRunSelection } = loadMobileModule('useRunSelection.ts', { react: require('react'), './appModel': loadMobileModule('appModel.ts') });
const jsx = { 'react/jsx-runtime': require('react/jsx-runtime') };
const { ActionsModal } = loadMobileModule('mobileConversationModals.tsx', {
  ...jsx, react: require('react'), './appModel': loadMobileModule('appModel.ts'),
  './mobileIcons': loadMobileModule('mobileIcons.tsx', jsx), './mobilePrimitives': loadMobileModule('mobilePrimitives.tsx', jsx),
});

test('opening Sessions dismisses the Conversation sheet before the read-only viewer appears', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'), root = createRoot(container), transitions: string[] = [];
  function Harness() {
    const [actions, setActions] = useState(true), [viewer, setViewer] = useState(false);
    return createElement('main', null,
      actions && createElement(ActionsModal, { conversation: null, renameTitle: 'Chat', setRenameTitle: jest.fn(), isStreaming: false,
        onClose: () => { transitions.push('close'); setActions(false); },
        onSessions: () => { transitions.push('sessions'); setViewer(true); } }),
      viewer && createElement('section', { className: 'session-viewer-screen' }, 'Past session'),
    );
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    const sessions = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Sessions')!;
    await act(async () => sessions.click());
    expect(transitions).toEqual(['close', 'sessions']);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('.session-viewer-screen')?.textContent).toBe('Past session');
  } finally { await act(async () => root.unmount()); }
});

test.each([false, true])('mobile retains saved CoCo selection through pending/failed discovery (failure=%s)', async failed => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const metadata = new Promise((yes, no) => { resolve = yes; reject = no; });
  const profile = { id: 'cortex', name: 'CoCo', harness: 'cortex-code', cortexCode: { connection: 'fixture' } };
  const backends = [{ id: 'cortex-code', label: 'CoCo', models: [], capabilities: { goals: false } }];
  const conversation = { id: 'fixture', cliProfileId: 'cortex', backend: 'cortex-code', model: 'claude-sonnet-4-6', effort: 'medium', messages: [{ role: 'user', content: 'existing' }] };
  const settings = { cliProfiles: [profile] }, clientRef = { current: { getCliProfileMetadata: jest.fn(() => metadata) } }, onError = jest.fn();
  let view: any; const root = createRoot(document.createElement('div'));
  function Harness() { view = useRunSelection({ activeConversation: conversation, backends, settings, clientRef, onError }); return createElement('p', null, view.selectedEffort); }
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => view.hydrateSelectionFromConversation(conversation));
    expect(view.selectedModel).toBe('claude-sonnet-4-6'); expect(view.selectedEffort).toBe('medium'); expect(view.goalCapable).toBe(false);
    await act(async () => { if (failed) reject(new Error('Catalog unavailable')); else resolve({ ...backends[0], models: [{ id: conversation.model, supportedEffortLevels: ['low', 'medium', 'high'] }] }); });
    expect(view.selectedEffort).toBe('medium'); expect(view.profileSelectionLocked).toBe(true);
    expect(onError).toHaveBeenCalledTimes(failed ? 1 : 0);
  } finally { await act(async () => root.unmount()); }
});
