import { processorProfileChoices } from '../web/AgentCockpitWeb/src/screens/processorProfiles';

test('Memory choices exclude unverified processors and retain a disabled saved selection without choosing a replacement', () => {
  const profiles = [{ id: 'claude' }, { id: 'cortex' }, { id: 'missing' }];
  const metadata = (profile: { id: string }) => profile.id === 'missing' ? null : {
    id: profile.id === 'cortex' ? 'cortex-code' : 'claude-code', label: profile.id,
    models: [],
    capabilities: { thinking: false, planMode: false, agents: false, toolActivity: false, userQuestions: false, stdinInput: false,
      ...(profile.id === 'cortex' ? { oneShot: { restrictedText: false, toolEnabled: true, sequential: true } } : {}) },
  };
  expect(processorProfileChoices(profiles, metadata, 'restrictedText', 'claude').map(choice => choice.profile.id)).toEqual(['claude']);
  const saved = processorProfileChoices(profiles, metadata, 'restrictedText', 'cortex');
  expect(saved.map(choice => choice.profile.id)).toEqual(['claude', 'cortex']);
  expect(saved[1]).toMatchObject({ disabled: true, reason: 'cortex does not support restrictedText.' });
  expect(processorProfileChoices(profiles, metadata, 'toolEnabled', null).map(choice => choice.profile.id)).toEqual(['claude', 'cortex']);
});
