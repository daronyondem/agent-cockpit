/** @jest-environment jsdom */
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadMobileModule } from './mobileModuleLoader';
const { useRunSelection } = loadMobileModule('useRunSelection.ts', { react: require('react'), './appModel': loadMobileModule('appModel.ts') });
const jsx = { 'react/jsx-runtime': require('react/jsx-runtime') };
const { ActionsModal, RunSettingsModal } = loadMobileModule('mobileConversationModals.tsx', {
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

test.each([{ models: [] }, { models: [{ id: 'replacement', supportedEffortLevels: ['high', 'xhigh'] }] },
  { models: [{ id: 'removed', supportedEffortLevels: ['high'] }] }])('mobile preserves saved effort when CoCo discovery cannot validate it ($models)', async ({ models }) => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const profile = { id: 'cortex', name: 'CoCo', harness: 'cortex-code', cortexCode: { connection: 'fixture' } };
  const backend = { id: 'cortex-code', label: 'CoCo', models: [] };
  const conversation = { id: 'fixture', cliProfileId: 'cortex', backend: 'cortex-code', model: 'removed', effort: 'xhigh', messages: [] };
  const clientRef = { current: { getCliProfileMetadata: jest.fn().mockResolvedValue({ ...backend, models }) } };
  let view: any; const root = createRoot(document.createElement('div'));
  function Harness() {
    view = useRunSelection({ activeConversation: conversation, backends: [backend], settings: { cliProfiles: [profile] }, clientRef, onError: jest.fn() });
    return createElement('p', null, view.selectedEffort);
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => view.hydrateSelectionFromConversation(conversation));
    expect(view.selectedModel).toBe('removed'); expect(view.selectedEffort).toBe('xhigh');
    expect(view.supportedEfforts).toEqual(models[0]?.id === 'removed' ? ['high'] : []);
    if (models[0]?.id === 'replacement') {
      await act(async () => view.setSelectedModel('replacement'));
      expect(view.supportedEfforts).toEqual(['high', 'xhigh']);
      expect(view.selectedEffort).toBe('xhigh');
      await act(async () => view.setSelectedEffort('high'));
      expect(view.selectedEffort).toBe('high');
    }
  } finally { await act(async () => root.unmount()); }
});

test('mobile explains unavailable CoCo models and keeps saved effort visible until a current model is selected', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'), root = createRoot(container);
  const onEffort = jest.fn();
  const props = { profiles: [], selectedBackendMetadata: { id: 'cortex-code', models: [{ id: 'replacement' }] },
    selectedModel: 'removed', selectedEffort: 'xhigh', supportedEfforts: [], locked: false,
    claudeCodeModeEnabled: false, serviceTierEnabled: false, onClose: jest.fn(), onProfile: jest.fn(), onModel: jest.fn(),
    onEffort, onClaudeCodeMode: jest.fn(), onServiceTier: jest.fn() };
  try {
    await act(async () => root.render(createElement(RunSettingsModal, props)));
    expect(container.textContent).toContain('Choose a current model to change effort');
    const saved = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'xhigh (saved)')!;
    expect(saved.disabled).toBe(true); expect(onEffort).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(RunSettingsModal, { ...props, selectedModel: 'replacement', supportedEfforts: ['high', 'xhigh'] })));
    expect(container.textContent).not.toContain('Choose a current model to change effort');
    const high = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'high')!;
    await act(async () => high.click()); expect(onEffort).toHaveBeenCalledWith('high');
  } finally { await act(async () => root.unmount()); }
});
