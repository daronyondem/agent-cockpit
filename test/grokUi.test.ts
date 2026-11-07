/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadFrontendModule, loadMobileModule } from './mobileModuleLoader';
import { checkBackendRoleEligibility } from '../src/contracts/backendCapabilities';
const reactDependencies = { react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime') };
const { GrokBillingSection } = loadFrontendModule('web/AgentCockpitWeb/src/chat/grokBillingSection.jsx', reactDependencies);
const { GrokBilling } = loadMobileModule('grokBilling.tsx', reactDependencies);
const { InteractionCard: MobileInteractionCard } = loadMobileModule('interactionCard.tsx', {
  ...reactDependencies, '../../../src/contracts/backendCapabilities': { checkBackendRoleEligibility }, './mobilePrimitives': loadMobileModule('mobilePrimitives.tsx', reactDependencies),
});
const respond = jest.fn();
const { InteractionCard } = loadFrontendModule('web/AgentCockpitWeb/src/chat/chatStatusCards.jsx', {
  ...reactDependencies, '../../../../src/contracts/backendCapabilities': { checkBackendRoleEligibility }, '../icons.jsx': { Ico: {} }, '../streamStore.js': { StreamStore: { respond } },
  './chatTime.js': { msgTime: () => '' }, './messageContent.jsx': { renderMarkdown: (text: string) => text },
});

test('Grok plans accept revision feedback while other plan cards retain their approval controls', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  respond.mockClear();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const props = { convId: 'fixture', interaction: { type: 'planApproval', planContent: 'Fixture plan' }, respondPending: false };
  try {
    await act(async () => { root.render(createElement(InteractionCard, { ...props, backend: { id: 'grok-build', label: 'Grok', capabilities: { planMode: true } } })); });
    const button = () => Array.from(container.querySelectorAll('button')).find(item => item.textContent === 'Request changes')!;
    expect(button().disabled).toBe(true);
    const input = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Verify Blue first');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button().click(); });
    expect(respond).toHaveBeenCalledWith('fixture', 'Verify Blue first', undefined);
    await act(async () => { root.render(createElement(InteractionCard, props)); });
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).toContain('Approve & run');
  } finally { await act(async () => { root.unmount(); }); container.remove(); }
});

test('mobile plan approval sends explicit decisions and uses advertised revision capability', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onSubmit = jest.fn();
  const props = { interaction: { kind: 'plan', prompt: 'Fixture plan' }, answer: '', setAnswer: jest.fn(), onSubmit, backend: undefined };
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent === label)!;
  try {
    await act(async () => { root.render(createElement(MobileInteractionCard, props)); });
    expect(container.querySelector('textarea')).toBeNull();
    expect(button('Request changes')).toBeUndefined();
    await act(async () => { button('Approve & run').click(); });
    await act(async () => { button('Reject').click(); });
    expect(onSubmit.mock.calls).toEqual([['yes'], ['no']]);
    await act(async () => { root.render(createElement(MobileInteractionCard, { ...props, backend: { id: 'grok-build', label: 'Grok', capabilities: { planMode: true } }, answer: 'Verify Blue first' })); });
    expect(container.querySelector('textarea')!.value).toBe('Verify Blue first');
    await act(async () => { button('Request changes').click(); });
    expect(onSubmit).toHaveBeenLastCalledWith();
    const question = { kind: 'question', prompt: 'Color?', options: [{ label: 'Blue' }] };
    await act(async () => { root.render(createElement(MobileInteractionCard, { ...props, interaction: question, answer: 'Blue' })); });
    await act(async () => { button('Answer').click(); });
    expect(onSubmit).toHaveBeenLastCalledWith();
  } finally { await act(async () => { root.unmount(); }); container.remove(); }
});

describe('Grok billing presentation', () => {
  test('desktop shows reported zero balances and omits missing quota and invalid dates', () => {
    const html = renderToStaticMarkup(createElement(GrokBillingSection, { data: { subscriptionTier: 'Fixture', prepaidBalanceUsd: 0, periodEnd: 'invalid' } }));
    expect(html).toContain('Fixture');
    expect(html).toContain('$0.00');
    expect(html).not.toContain('Credits used');
    expect(html).not.toContain('Resets');
    expect(renderToStaticMarkup(createElement(GrokBillingSection, { data: null }))).toBe('');
  });

  test('mobile hides old profile balances immediately and ignores a late response after switching', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    let resolveB!: (value: unknown) => void;
    const client = { getGrokBilling: jest.fn((id: string) => id === 'a'
      ? Promise.resolve({ billing: { prepaidBalanceUsd: 1 } })
      : new Promise(resolve => { resolveB = resolve; })) } as any;
    try {
      await act(async () => { root.render(createElement(GrokBilling, { client, profileId: 'a', refreshKey: 0 })); });
      expect(container.textContent).toContain('$1.00');
      await act(async () => { root.render(createElement(GrokBilling, { client, profileId: 'b', refreshKey: 0 })); });
      expect(container.textContent).not.toContain('$1.00');
      await act(async () => { root.render(createElement(GrokBilling, { client, profileId: 'a', refreshKey: 1 })); });
      await act(async () => { resolveB({ billing: { prepaidBalanceUsd: 99 } }); });
      expect(container.textContent).toContain('$1.00');
      expect(container.textContent).not.toContain('$99.00');
    } finally { await act(async () => { root.unmount(); }); }
  });
});
