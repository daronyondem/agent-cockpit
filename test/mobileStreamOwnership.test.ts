/** @jest-environment jsdom */
import { act, createElement, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadMobileModule, loadFrontendModule } from './mobileModuleLoader';
const sockets: any[] = [];
function socket() { const value: any = { readyState: 1, close: jest.fn(() => value.onclose?.()), send: jest.fn() }; sockets.push(value); return value; }
const events = loadMobileModule('chatStreamEvents.ts');
const { useChatStreamConnection } = loadFrontendModule('mobile/AgentCockpitPWA/src/useChatStreamConnection.ts', { react: require('react'), './chatStreamEvents': events,
  './appModel': { tryCreateWebSocket: socket, streamReconnectDelayMs: () => 1000 }, './useMobileLifecycle': { useVisibleStreamResume: () => {} } }, { window, WebSocket: { OPEN: 1, CONNECTING: 0 } });

test('mobile reconnect keeps decision ownership, clears matched completions, and ignores superseded sockets', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.useFakeTimers(); sockets.length = 0;
  const root = createRoot(document.createElement('div')); let view: any;
  const api = { websocketURL: () => 'ws://fixture', getActiveStreams: jest.fn(async () => new Set(['fixture'])), sendMessage: jest.fn() };
  const refresh = jest.fn(), setError = jest.fn();
  function Harness() {
    const conversation = useRef({ id: 'fixture' }), [interaction, setInteraction] = useState<any>(null);
    const pipeline = useChatStreamConnection({ activeConversationRef: conversation, clientRef: { current: api },
      setActiveConversation: jest.fn(), setActiveStreamIDs: jest.fn(), setConversations: jest.fn(), setErrorMessage: setError,
      setPendingInteraction: setInteraction, applyGoalSnapshot: jest.fn(), refreshAfterStream: refresh, notify: jest.fn() });
    view = { ...pipeline, interaction, conversation }; return createElement('p', null, interaction?.prompt);
  }
  const frame = (connection: any, data: object) => connection.onmessage({ data: JSON.stringify(data) });
  const question = (id: string) => ({ type: 'tool_activity', id, isQuestion: true, questions: [{ question: 'Color?', options: [] }] });
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => view.startStream('fixture')); const original = sockets[0];
    await act(async () => frame(original, question('cortex-decision:first')));
    await act(async () => { original.onerror(); await jest.advanceTimersByTimeAsync(1000); });
    expect(sockets).toHaveLength(2); const current = sockets[1];
    await act(async () => frame(current, question('cortex-decision:first')));
    expect(view.interaction.decisionId).toBe('cortex-decision:first');
    await act(async () => frame(current, { type: 'tool_outcomes', outcomes: [{ toolUseId: 'cortex-decision:first' }] }));
    expect(view.interaction).toBeNull();
    await act(async () => frame(current, question('cortex-decision:new')));
    await act(async () => { frame(original, { type: 'done' }); frame(original, question('cortex-decision:old')); original.onerror();
      frame(current, { type: 'tool_outcomes', outcomes: [{ toolUseId: 'cortex-decision:first' }] }); });
    expect(view.interaction.decisionId).toBe('cortex-decision:new'); expect(view.isStreaming).toBe(true);
    expect(refresh).not.toHaveBeenCalled(); expect(api.sendMessage).not.toHaveBeenCalled();
    await act(async () => frame(current, { type: 'error', error: 'Aborted by user', terminal: true, source: 'abort' }));
    expect(view.interaction).toBeNull(); expect(view.isStreaming).toBe(false);
  } finally { await act(async () => root.unmount()); jest.useRealTimers(); }
});
