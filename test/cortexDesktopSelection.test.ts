/** @jest-environment jsdom */
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { loadFrontendModule } from './mobileModuleLoader';
import { hasRequiredCliProfileConfig } from '../src/contracts/cliProfiles';

const catalog = require('../web/AgentCockpitWeb/src/profileCatalog.js');
const icons = new Proxy({}, { get: () => () => null });
const api = { getCliProfileMetadata: jest.fn() };
const store = { setComposerCliProfile: jest.fn(), setComposerModel: jest.fn(), setComposerEffort: jest.fn(), setComposerClaudeCodeMode: jest.fn() };
const { useProfileBackends } = loadFrontendModule('web/AgentCockpitWeb/src/useProfileBackends.js', {
  react: require('react'), './api.js': { AgentApi: api },
}, { window });
const { default: ComposerPicks } = loadFrontendModule('web/AgentCockpitWeb/src/chat/composerPicks.jsx', {
  react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime'),
  '../../../../src/contracts/cliProfiles': { hasRequiredCliProfileConfig }, '../useProfileBackends.js': { useProfileBackends },
  '../streamStore.js': { StreamStore: store }, '../icons.jsx': { Ico: icons },
  '../shellState.jsx': { BackendInlineIcon: () => null, modelDisplayLabel: catalog.modelDisplayLabel },
  './chatHelpers.js': { backendIdForProfile: catalog.backendIdForProfile, cliHarnessForBackend: (id: string) => id === 'claude-code-interactive' ? 'claude-code' : id,
    isClaudeBackend: (id: string) => id === 'claude-code' || id === 'claude-code-interactive' },
}, { window });
const profile = { id: 'cortex', name: 'Saved CoCo', harness: 'cortex-code', cortexCode: { connection: 'fixture' } };
const backend = { id: 'cortex-code', label: 'CoCo', models: [{ id: 'sonnet', label: 'Sonnet', default: true, supportedEffortLevels: ['low', 'high'] }] };
const props = { convId: 'conversation', backends: [{ ...backend, models: [] }], cliProfiles: [profile], composerCliProfileId: 'cortex',
  composerBackend: 'cortex-code', composerModel: 'sonnet', composerEffort: 'low', composerClaudeCodeMode: 'ultracode', composerServiceTier: 'fast' };
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks(); api.getCliProfileMetadata.mockResolvedValue(backend);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = async (value: Record<string, unknown> = props) => { await act(async () => root.render(createElement(ComposerPicks, value))); };
const select = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
function deferred(){ let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('CoCo shows its own model/effort without Claude mode or Codex speed and requires a configured profile', async () => {
  await render({ ...props, cliProfiles: [profile, { ...profile, id: 'draft', cortexCode: undefined } as any] });
  expect(select('CLI Profile').value).toBe('cortex'); expect(select('CLI Profile').options).toHaveLength(1);
  expect(select('Model').value).toBe('sonnet'); expect(select('Adaptive reasoning effort').value).toBe('low');
  expect(select('Claude Code mode')).toBeNull(); expect(select('Codex service tier')).toBeNull();
  expect(store.setComposerModel).not.toHaveBeenCalled(); expect(store.setComposerEffort).not.toHaveBeenCalled();
  expect(store.setComposerClaudeCodeMode).toHaveBeenCalledWith('conversation', null);
});

test('late same-ID connection metadata is ignored; selected model and effort survive loading and discovery failure', async () => {
  const old = deferred(), next = deferred(); api.getCliProfileMetadata.mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  await render(); expect(container.textContent).toContain('Loading CoCo models');
  const changed = { ...props, cliProfiles: [{ ...profile, cortexCode: { connection: 'other' } }] };
  await render(changed); expect(api.getCliProfileMetadata).toHaveBeenCalledTimes(2);
  await act(async () => old.resolve({ ...backend, models: [{ id: 'WRONG', default: true }] }));
  expect(select('Model').value).toBe('sonnet'); expect(container.textContent).not.toContain('WRONG');
  await act(async () => next.reject(new Error('Private native failure')));
  expect(select('Model').value).toBe('sonnet'); expect(select('Model').selectedOptions[0].disabled).toBe(true);
  expect(container.textContent).toContain('CoCo models unavailable'); expect(container.textContent).not.toContain('Private native');
  expect(store.setComposerModel).not.toHaveBeenCalled(); expect(store.setComposerEffort).not.toHaveBeenCalled();
});

test('missing saved model stays disabled while available replacements remain selectable', async () => {
  await render({ ...props, composerModel: 'removed' });
  const model = select('Model'); expect(model.value).toBe('removed'); expect(model.selectedOptions[0].disabled).toBe(true);
  expect(Array.from(model.options).map(option => option.value)).toEqual(['removed', 'sonnet']);
  await act(async () => { model.value = 'sonnet'; model.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(store.setComposerModel).toHaveBeenCalledWith('conversation', 'sonnet'); expect(store.setComposerEffort).not.toHaveBeenCalled();
});

test('a stored incomplete CoCo profile stays visible and disabled without switching to another profile', async () => {
  await render({ ...props, cliProfiles: [{ ...profile, cortexCode: undefined } as any] });
  expect(select('CLI Profile').value).toBe('cortex'); expect(select('CLI Profile').selectedOptions[0].disabled).toBe(true);
  expect(store.setComposerCliProfile).not.toHaveBeenCalled();
});

test.each(['claude-code', 'claude-code-interactive', 'codex', 'grok-build'])('%s keeps existing model/effort/mode/tier behavior', async id => {
  const metadata = { ...backend, id, models: [{ id: 'fixture', supportedEffortLevels: ['high', 'xhigh'] }] };
  api.getCliProfileMetadata.mockResolvedValue(metadata);
  await render({ ...props, backends: [metadata], cliProfiles: [{ id: 'fixture', name: 'Existing', harness: id === 'claude-code-interactive' ? 'claude-code' : id,
    protocol: id === 'claude-code-interactive' ? 'interactive' : undefined } as any], composerCliProfileId: 'fixture', composerBackend: id, composerModel: 'fixture', composerEffort: 'high' });
  expect(!!select('Claude Code mode')).toBe(id.startsWith('claude-code'));
  expect(!!select('Codex service tier')).toBe(id === 'codex');
  expect(select('Model').value).toBe('fixture'); expect(select('Adaptive reasoning effort').value).toBe('high');
});

test('saved-profile invalidation drops catalogs and old hook responses without reviving them after remount', async () => {
  const old = deferred(), next = deferred(); api.getCliProfileMetadata.mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  function Harness(){ const [backends, load] = useProfileBackends(); useEffect(() => { load('cortex'); }, [load]);
    return createElement('pre', null, JSON.stringify(backends)); }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => window.dispatchEvent(new Event('agent-cockpit-settings-saved')));
  await act(async () => next.resolve({ ...backend, label: 'CURRENT' }));
  await act(async () => old.resolve({ ...backend, label: 'STALE' }));
  expect(container.textContent).toContain('CURRENT'); expect(container.textContent).not.toContain('STALE');
});

test('catalog projections preserve protocol identity, labels and effort defaults', () => {
  expect(catalog.backendIdForProfile({ harness: 'claude-code', protocol: 'interactive' })).toBe('claude-code-interactive');
  expect(catalog.backendIdForProfile(null)).toBeNull(); expect(catalog.modelDisplayLabel('openrouter/model')).toBe('model');
  expect(catalog.modelDisplayLabel({ id: 'id', label: 'Label' })).toBe('Label');
  expect(catalog.modelsForProfile([backend], {}, profile)).toEqual(backend.models);
  expect(catalog.modelsForProfile([backend], { cortex: { id: 'codex', models: [{ id: 'WRONG' }] } }, profile)).toEqual(backend.models);
  expect(catalog.effortLevelsForProfile([backend], {}, profile, 'sonnet')).toEqual(['low', 'high']);
  expect(catalog.effortLevelsForProfile([], {}, profile, 'unknown')).toEqual([]);
  expect(catalog.defaultModelId(backend.models)).toBe('sonnet'); expect(catalog.defaultModelId([])).toBeUndefined();
  expect(catalog.defaultEffortFor(['low', 'high'])).toBe('high'); expect(catalog.defaultEffortFor(['low'])).toBe('low');
});
