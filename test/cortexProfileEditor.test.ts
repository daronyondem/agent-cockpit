/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { loadFrontendModule } from './mobileModuleLoader';
import { hasRequiredCliProfileConfig } from '../src/contracts/cliProfiles';
const catalog = require('../web/AgentCockpitWeb/src/profileCatalog.js');
const projection = require('../web/AgentCockpitWeb/src/screens/processorProfiles');
const configField = require('../web/AgentCockpitWeb/src/screens/cliProfileConfigDir.js');
const api = { settings: { get: jest.fn(), backends: jest.fn(), save: jest.fn(), usageStats: jest.fn(), usagePricing: jest.fn() } };
const { SettingsScreen } = loadFrontendModule('web/AgentCockpitWeb/src/screens/settingsScreen.jsx', {
  react: { ...require('react'), lazy: () => () => null }, 'react/jsx-runtime': require('react/jsx-runtime'),
  '../profileCatalog.js': catalog, './processorProfiles': projection, './cliProfileConfigDir.js': configField,
  './cliProfileAuthState.js': require('../web/AgentCockpitWeb/src/screens/cliProfileAuthState.js'),
  './usageStats.js': require('../web/AgentCockpitWeb/src/screens/usageStats.js'),
  '../../../../src/contracts/usagePresentation': require('../src/contracts/usagePresentation'),
  '../../../../src/contracts/cliProfiles': { hasRequiredCliProfileConfig }, '../useProfileBackends.js': { useProfileBackends: () => [{}, () => {}] },
  '../api.js': { AgentApi: api }, '../icons.jsx': { Ico: new Proxy({}, { get: () => () => null }) },
  '../tooltip.jsx': { Tip: ({ children }: any) => children }, '../dialog.jsx': { useDialog: () => ({ alert: jest.fn() }) },
  '../toast.jsx': { useToasts: () => ({ success: jest.fn() }) }, '../cliUpdateStore.js': { CliUpdateStore: {
    get: () => null, subscribe: () => () => {}, ensureFresh: () => Promise.resolve(),
  } },
}, { window, document, localStorage, setInterval, clearInterval });
const profile = { id: 'cortex', name: 'CoCo profile', harness: 'cortex-code', authMode: 'account', cortexCode: { connection: 'fixture' } };
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks();
  api.settings.get.mockResolvedValue({ cliProfiles: [profile], theme: 'system' }); api.settings.backends.mockResolvedValue({ backends: [{ id: 'cortex-code', icon: '<svg></svg>' }] });
  api.settings.save.mockImplementation(settings => Promise.resolve(settings));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const field = (label: string) => Array.from(container.querySelectorAll('label')).find(node => node.querySelector('.settings-field-label')?.textContent === label)!;
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(node => node.textContent?.trim() === label)!;
async function change(input: HTMLInputElement | HTMLSelectElement, value: string){ await act(async () => {
  Object.getOwnPropertyDescriptor(input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}); }

test('saved CoCo profiles expose Harness, native connection, command, shared-auth guidance and enable/delete controls', async () => {
  await act(async () => root.render(createElement(SettingsScreen, { initialTab: 'cli' })));
  expect(field('Harness').querySelector('select')!.value).toBe('cortex-code');
  expect(field('Command').querySelector('input')!.placeholder).toBe('cortex');
  expect(field('Config directory').textContent).toContain('SNOWFLAKE_HOME');
  expect(container.textContent).toContain('shared terminal login'); expect(button('Authenticate')).toBeUndefined();
  await change(field('Name').querySelector('input')!, 'Renamed CoCo');
  await change(field('Snowflake connection').querySelector('input')!, 'other-connection');
  await act(async () => button('Save').click());
  expect(api.settings.save.mock.calls[0][0].cliProfiles[0]).toMatchObject({ name: 'Renamed CoCo', cortexCode: { connection: 'other-connection' } });
  await act(async () => container.querySelector<HTMLInputElement>('.cli-card-head-side input[type="checkbox"]')!.click());
  expect(container.textContent).toContain('Disabled');
  await act(async () => container.querySelector<HTMLButtonElement>('button[title="Delete profile"]')!.click());
  expect(container.textContent).toContain('No CLI profiles are configured');
});

test('switching a profile to CoCo clears another harness auth home and leaving CoCo removes its config', async () => {
  api.settings.get.mockResolvedValue({ cliProfiles: [{ ...profile, harness: 'claude-code', cortexCode: undefined, configDir: '/isolated/claude', env: { CLAUDE_CONFIG_DIR: '/isolated/claude' } }] });
  await act(async () => root.render(createElement(SettingsScreen, { initialTab: 'cli' })));
  await change(field('Harness').querySelector('select')!, 'cortex-code');
  expect(field('Config directory').querySelector('input')!.value).toBe('');
  await change(field('Snowflake connection').querySelector('input')!, 'fixture');
  await act(async () => button('Save').click());
  const changed = api.settings.save.mock.calls[0][0].cliProfiles[0];
  expect(changed).toMatchObject({ harness: 'cortex-code', authMode: 'account' }); expect(changed.configDir).toBeUndefined(); expect(changed.env).toBeUndefined();
  await change(field('Harness').querySelector('select')!, 'codex');
  await act(async () => button('Save').click());
  expect(api.settings.save.mock.calls[1][0].cliProfiles[0].cortexCode).toBeUndefined();
});

test('General cannot promote an incomplete CoCo draft and leaves a saved unknown model visible', async () => {
  api.settings.get.mockResolvedValue({ cliProfiles: [{ ...profile, cortexCode: undefined }], defaultCliProfileId: 'cortex', defaultModel: 'retired' });
  api.settings.backends.mockResolvedValue({ backends: [{ id: 'cortex-code', models: [{ id: 'known' }] }] });
  await act(async () => root.render(createElement(SettingsScreen, { initialTab: 'general' })));
  const option = field('Default CLI profile').querySelector('select')!.selectedOptions[0]; expect(option.disabled).toBe(true);
  const models = field('Default model').querySelector('select')!; expect(models.value).toBe('retired'); expect(models.selectedOptions[0].disabled).toBe(true);
});

test.each([false, true])('Usage settings distinguishes unpriced CoCo from known estimates (mixed=%s)', async mixed => {
  const usage = { inputTokens: 17, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 11, costUsd: 0, costSource: 'none' };
  const records = [{ backend: 'cortex-code', model: 'claude-sonnet-4-6', usage }];
  if (mixed) records.push({ backend: 'codex', model: 'gpt-6', usage: { ...usage, costSource: 'estimated', estimatedCostUsd: 1.25 } } as any);
  api.settings.usageStats.mockResolvedValue({ days: [{ date: new Date().toISOString().slice(0, 10), records }] });
  api.settings.usagePricing.mockResolvedValue({ builtin: { entries: [] }, overrides: { entries: [] } });
  await act(async () => root.render(createElement(SettingsScreen, { initialTab: 'usage' })));
  expect(Array.from(container.querySelectorAll('.stat .num')).map(node => node.textContent)).toEqual(Array(4).fill(mixed ? '$2 + unpriced usage' : 'n/a'));
  const coco = Array.from(container.querySelectorAll('.usage-summary-table tbody tr')).find(row => row.textContent.includes('cortex-code'))!;
  expect(Array.from(coco.querySelectorAll('td')).slice(-2).map(node => node.textContent)).toEqual(['n/a', 'n/a']);
  expect(container.textContent).toContain('Costs exclude usage with unavailable pricing');
  if (mixed) {
    const codex = Array.from(container.querySelectorAll('.usage-summary-table tbody tr')).find(row => row.textContent.includes('codex'))!;
    expect(codex.querySelector('td:last-child')!.textContent).toBe('$2');
  } else expect(container.textContent).toContain('No priced usage for this metric.');
  await act(async () => button('Tokens').click());
  expect(container.querySelector('.bar')!.getAttribute('title')).toContain(`${mixed ? 74 : 37} tokens`);
});
