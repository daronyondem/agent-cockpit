/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { loadFrontendModule } from './mobileModuleLoader';
import { processorProfileChoices } from '../web/AgentCockpitWeb/src/screens/processorProfiles';

const { default: MemoryProcessorSelect, ProcessorProfileSelect } = loadFrontendModule('web/AgentCockpitWeb/src/screens/memoryProcessorSelect.jsx', {
  'react/jsx-runtime': require('react/jsx-runtime'), './processorProfiles': { processorProfileChoices },
});
const profiles = [{ id: 'claude', name: 'Claude profile' }, { id: 'cortex', name: 'Cortex profile', harness: 'cortex-code', cortexCode: { connection: 'fixture' } }];
const metadataForProfile = (profile: { id: string }) => ({ id: profile.id === 'cortex' ? 'cortex-code' : 'claude-code', label: profile.id,
  capabilities: profile.id === 'cortex' ? { oneShot: { restrictedText: false, toolEnabled: true, sequential: true } } : {} });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

test.each(['Workspace Context', 'KB digestion', 'Routines'])('%s retains missing saved IDs and requires an explicit eligible choice', async label => {
  const onChange = jest.fn();
  await act(async () => { root.render(createElement(ProcessorProfileSelect, { profiles, selectedId: 'deleted-profile', metadataForProfile, onChange, label })); });
  const select = container.querySelector('select')!;
  expect(select.value).toBe('deleted-profile'); expect(select.selectedOptions[0].disabled).toBe(true);
  expect(container.textContent).toContain('Saved CLI profile is missing'); expect(onChange).not.toHaveBeenCalled();
  await act(async () => { select.value = 'cortex'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(onChange).toHaveBeenCalledWith('cortex');
});

test('disabled and unconfigured saved profiles remain visible and cannot be selected programmatically', async () => {
  const onChange = jest.fn(); const disabled = profiles.map(profile => profile.id === 'cortex' ? { ...profile, disabled: true } : profile);
  await act(async () => { root.render(createElement(ProcessorProfileSelect, { profiles: disabled, selectedId: 'cortex', metadataForProfile, onChange })); });
  const select = container.querySelector('select')!; expect(select.value).toBe('cortex'); expect(container.textContent).toContain('profile is disabled');
  await act(async () => { select.dispatchEvent(new Event('change', { bubbles: true })); }); expect(onChange).not.toHaveBeenCalled();
});

test('saved CoCo remains selected and disabled until the user explicitly chooses an eligible Memory profile', async () => {
  const onChange = jest.fn();
  await act(async () => { root.render(createElement(MemoryProcessorSelect, { profiles, selectedId: 'cortex', metadataForProfile, onChange })); });
  const select = container.querySelector('select')!;
  expect(select.value).toBe('cortex');
  expect(select.querySelector<HTMLOptionElement>('option[value="cortex"]')!.disabled).toBe(true);
  expect(container.textContent).toContain('run without tools');
  expect(container.textContent).not.toContain('restrictedText');
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => { select.value = 'claude'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(onChange).toHaveBeenCalledWith('claude');
  await act(async () => { root.render(createElement(MemoryProcessorSelect, { profiles, selectedId: 'claude', metadataForProfile, onChange })); });
  expect(container.querySelector('option[value="cortex"]')).toBeNull();
});

test('no eligible profiles renders an explicit empty choice', async () => {
  await act(async () => { root.render(createElement(MemoryProcessorSelect, { profiles: [profiles[1]], selectedId: null, metadataForProfile, onChange: jest.fn() })); });
  expect(container.textContent).toBe('No eligible CLI profiles available');
  expect(container.querySelector('select')!.value).toBe('');
});
