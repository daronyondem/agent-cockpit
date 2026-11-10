import { processorProfileChoices, processorProfileForSetting } from '../web/AgentCockpitWeb/src/screens/processorProfiles';

test('explicit missing/disabled identities never fall through to legacy or default profiles', () => {
  const profiles = [{ id: 'default', harness: 'claude-code' }, { id: 'saved', harness: 'cortex-code', disabled: true }];
  expect(processorProfileForSetting(profiles, 'missing', 'claude-code', 'claude-code', 'default')).toBeNull();
  expect(processorProfileForSetting(profiles, 'saved', 'claude-code', 'claude-code', 'default')).toBe(profiles[1]);
  expect(processorProfileForSetting(profiles, null, null, 'cortex-code', 'default')).toBe(profiles[0]);
  expect(processorProfileForSetting(profiles, null, 'cortex-code', 'claude-code', 'default')).toBeNull();
});

test('tool-enabled choices enforce configuration, availability, disablement and sequential support', () => {
  const profiles = [{ id: 'valid', harness: 'cortex-code', cortexCode: { connection: 'fixture' } },
    { id: 'draft', harness: 'cortex-code' }, { id: 'disabled', disabled: true }, { id: 'missing' }];
  const metadata = (profile: { id: string }) => profile.id === 'missing' ? null : {
    id: profile.id === 'valid' || profile.id === 'draft' ? 'cortex-code' : 'claude-code', label: 'Fixture',
    capabilities: { oneShot: { toolEnabled: true, restrictedText: false, sequential: false } },
  };
  expect(processorProfileChoices(profiles, metadata, 'toolEnabled', null).map(choice => choice.profile.id)).toEqual(['valid']);
  expect(processorProfileChoices(profiles, metadata, 'toolEnabled', 'draft')[1]).toMatchObject({ disabled: true, reason: expect.stringMatching(/connection/) });
  expect(processorProfileChoices(profiles, metadata, 'toolEnabled', null, { sequential: true })).toEqual([]);
  expect(processorProfileChoices([profiles[0]], () => ({ id: 'claude-code', label: 'Stale cache', capabilities: {} }), 'restrictedText', null)).toEqual([]);
});

test('Memory choices exclude unverified processors and retain a disabled saved selection without choosing a replacement', () => {
  const profiles = [{ id: 'claude' }, { id: 'cortex', harness: 'cortex-code', cortexCode: { connection: 'fixture' } }, { id: 'missing' }];
  const metadata = (profile: { id: string }) => profile.id === 'missing' ? null : {
    id: profile.id === 'cortex' ? 'cortex-code' : 'claude-code', label: profile.id,
    models: [],
    capabilities: { thinking: false, planMode: false, agents: false, toolActivity: false, userQuestions: false, stdinInput: false,
      ...(profile.id === 'cortex' ? { oneShot: { restrictedText: false, toolEnabled: true, sequential: true } } : {}) },
  };
  expect(processorProfileChoices(profiles, metadata, 'restrictedText', 'claude').map(choice => choice.profile.id)).toEqual(['claude']);
  const saved = processorProfileChoices(profiles, metadata, 'restrictedText', 'cortex');
  expect(saved.map(choice => choice.profile.id)).toEqual(['claude', 'cortex']);
  expect(saved[1]).toMatchObject({ disabled: true, reason: 'cortex does not support tool-free processors.' });
  expect(processorProfileChoices(profiles, metadata, 'toolEnabled', null).map(choice => choice.profile.id)).toEqual(['claude', 'cortex']);
});
