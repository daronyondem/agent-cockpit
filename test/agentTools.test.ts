/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { loadMobileModule, loadFrontendModule } from './mobileModuleLoader';
import type { ToolActivity, Message } from '../src/contracts/responses';

const desktop = loadFrontendModule('web/AgentCockpitWeb/src/chat/toolRuns.jsx', {
  react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime'),
  './chatTime.js': { formatMsgElapsed: (value: number) => String(value) },
  './messageModel.js': require('../web/AgentCockpitWeb/src/chat/messageModel.js'),
});
const mobile = loadMobileModule('agentTools.tsx', { react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime') });
const live = loadMobileModule('liveToolActivities.ts');
const tool = (id: string, extra: Partial<ToolActivity> = {}): ToolActivity => ({ id, tool: 'Read', description: 'Read fixture', startTime: 1, ...extra });
const message = (id: string, tools: ToolActivity[]): Message => ({ id, role: 'assistant', content: 'Parent only', backend: 'copilot', timestamp: '', contentBlocks: tools.map(activity => ({ type: 'tool', activity })) });

test.each(['desktop', 'mobile'])('%s groups nested and cross-message child tools once, displays statuses and escapes summaries', async client => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); const root = createRoot(container);
  const parent = tool('parent', { tool: 'Agent', isAgent: true, subagentType: 'general-purpose', duration: 1, status: 'success', summary: 'Parent summary' });
  const nested = tool('nested', { tool: 'Agent', isAgent: true, parentAgentId: 'parent', outcome: 'failed', status: 'error', summary: '<script>unsafe()</script>' });
  const child = tool('child', { parentAgentId: 'parent', outcome: 'exit 0', status: 'success' });
  const plain = tool('root', { outcome: 'done', duration: 1 });
  const messages = [message('first', [parent]), message('second', [nested, child, plain])];
  try {
    const node = client === 'desktop'
      ? createElement(desktop.AgentIndexProvider, { messages }, createElement(desktop.ToolRun, { tools: [parent, nested, child, plain] }))
      : createElement(mobile.AgentToolsProvider, { messages, liveTools: [child] }, [parent, nested, child, plain].map(activity => createElement(mobile.ToolActivityView, { key: activity.id, activity })));
    await act(async () => { root.render(node); });
    const cards = container.querySelectorAll(client === 'desktop' ? '.subagent' : '.agent-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector(client === 'desktop' ? '.subagent-head' : 'header')?.textContent).toContain('done');
    expect(cards[0].querySelectorAll(client === 'desktop' ? '.tool' : '.tool-block')).toHaveLength(2);
    expect(cards[0].textContent).toContain('failed');
    expect(cards[0].textContent).toContain('Parent summary');
    expect(cards[0].textContent).toContain('<script>unsafe()</script>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelectorAll('details')).toHaveLength(2);
  } finally { await act(async () => { root.unmount(); }); }
});

test('mobile live tools preserve identity, summaries and outcomes through replay without mutating prior arrays', () => {
  const start = { type: 'tool_activity', id: 'scoped', tool: 'Agent', description: 'Run child', isAgent: true, subagentType: 'general-purpose' };
  const initial = live.applyLiveToolFrame([], start, 1000);
  expect(live.applyLiveToolFrame(initial, start, 1001)).toBe(initial);
  const result = live.applyLiveToolFrame(initial, { type: 'tool_outcomes', outcomes: [{ toolUseId: 'scoped', outcome: 'done', status: 'success', summary: 'Child answer' }] }, 1600);
  expect(initial[0].outcome).toBeUndefined();
  expect(result[0]).toMatchObject({ duration: 600, summary: 'Child answer', outcome: 'done', status: 'success' });
  expect(live.applyLiveToolFrame(result, { ...start, id: 'question', isQuestion: true }, 1700)).toBe(result);
  expect(live.applyLiveToolFrame(result, { type: 'tool_outcomes', outcomes: [{ toolUseId: 'other', outcome: 'failed' }] }, 1800)).toEqual(result);
  expect(mobile.buildMobileAgentIndex([message('saved', result)], result).ids.has('scoped')).toBe(true);
});
