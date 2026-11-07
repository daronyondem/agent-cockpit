/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { loadFrontendModule, loadMobileModule } from './mobileModuleLoader';
import { checkBackendRoleEligibility } from '../src/contracts/backendCapabilities';
const deps = { react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime') };
const respond = jest.fn();
const { InteractionCard: Desktop } = loadFrontendModule('web/AgentCockpitWeb/src/chat/chatStatusCards.jsx', {
  ...deps, '../../../../src/contracts/backendCapabilities': { checkBackendRoleEligibility }, '../icons.jsx': { Ico: {} },
  '../streamStore.js': { StreamStore: { respond } }, './chatTime.js': {}, './messageContent.jsx': { renderMarkdown: (text: string) => text },
});
const { InteractionCard: Mobile } = loadMobileModule('interactionCard.tsx', {
  ...deps, '../../../src/contracts/backendCapabilities': { checkBackendRoleEligibility },
  './mobilePrimitives': loadMobileModule('mobilePrimitives.tsx', deps),
});
let root: Root, container: HTMLDivElement;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; respond.mockClear(); container = document.createElement('div'); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); });
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(node => node.textContent === label)!;
async function type(value: string){ await act(async () => { const input = container.querySelector('input,textarea')!;
  Object.getOwnPropertyDescriptor(input.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true })); }); }

test.each([
  ['cortex-code', true, true], ['grok-build', undefined, true], ['grok-build', false, false],
  ['claude-code', undefined, false], ['claude-code-interactive', undefined, false], ['codex', undefined, false],
] as const)('%s plan revision obeys shared metadata (declared=%s)', async (id, declared, allowed) => {
  const backend = { id, label: id, capabilities: { planMode: true, planRevision: declared } };
  const submit = jest.fn();
  for (const mobile of [false, true]) {
    await act(async () => root.render(mobile ? createElement(Mobile, { backend, interaction: { kind: 'plan', prompt: 'Plan' }, answer: 'Verify read-back', onSubmit: submit, setAnswer: jest.fn() })
      : createElement(Desktop, { backend, convId: 'fixture', interaction: { type: 'planApproval', planContent: 'Plan', decisionId: 'cortex-decision:plan' } })));
    expect(!!button('Request changes')).toBe(allowed);
    await act(async () => button('Reject').click()); await act(async () => button('Approve & run').click());
  }
  expect(respond.mock.calls).toEqual([['fixture', 'no', 'cortex-decision:plan'], ['fixture', 'yes', 'cortex-decision:plan']]);
  expect(submit.mock.calls).toEqual([['no'], ['yes']]);
});

test('desktop resets identical question/plan drafts for a fresh decision and binds replies to its rendered generation', async () => {
  const backend = { id: 'cortex-code', label: 'CoCo', capabilities: { planMode: true, planRevision: true } };
  const question = { type: 'userQuestion', question: 'Color?', options: [{ label: 'Blue' }], decisionId: 'cortex-decision:first' };
  await act(async () => root.render(createElement(Desktop, { convId: 'fixture', backend, interaction: question })));
  await type('Violet fixture'); await act(async () => button('Send').click());
  expect(respond).toHaveBeenLastCalledWith('fixture', 'Violet fixture', question.decisionId);
  await act(async () => root.render(createElement(Desktop, { convId: 'fixture', backend, interaction: { ...question, decisionId: 'cortex-decision:next' } })));
  expect(container.querySelector('input')!.value).toBe(''); expect(button('Send').disabled).toBe(true);
  const plan = { type: 'planApproval', planContent: 'Plan', decisionId: 'cortex-decision:plan' };
  await act(async () => root.render(createElement(Desktop, { convId: 'fixture', backend, interaction: plan })));
  await type('Read back first'); await act(async () => button('Request changes').click());
  expect(respond).toHaveBeenLastCalledWith('fixture', 'Read back first', plan.decisionId);
  await act(async () => root.render(createElement(Desktop, { convId: 'fixture', backend, interaction: { ...plan, decisionId: 'cortex-decision:revised' } })));
  expect(container.querySelector('textarea')!.value).toBe(''); expect(button('Request changes').disabled).toBe(true);
});

test.each(['plan', 'question'])('mobile %s controls disable all submissions while a reply is pending', async kind => {
  const onSubmit = jest.fn();
  await act(async () => root.render(createElement(Mobile, { backend: { id: 'cortex-code', label: 'CoCo', capabilities: { planMode: true, planRevision: true } },
    interaction: { kind, prompt: 'Fixture', options: [{ label: 'Blue' }] }, answer: 'Blue', respondPending: true, setAnswer: jest.fn(), onSubmit })));
  expect(Array.from(container.querySelectorAll('button')).every(node => node.disabled)).toBe(true);
  expect(container.querySelector('textarea')!.disabled).toBe(true);
  await act(async () => Array.from(container.querySelectorAll('button')).forEach(node => node.click())); expect(onSubmit).not.toHaveBeenCalled();
});
