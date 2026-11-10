import { configureCortex, cortexConfigOptions, cortexModels } from '../src/services/backends/cortexModels';
import { cortexFixture } from './helpers/cortexFixtures';
import { cortexRecord } from '../src/services/backends/cortexProtocol';

test('native catalog preserves opaque IDs/Auto, safe modes, profile separation and verified image evidence', async () => {
  const f = cortexFixture();
  const models = cortexModels(f.runtime.configOptions, '1.2.35');
  expect(models.map(model => model.id)).toEqual(['auto', 'claude-sonnet-4-6']);
  expect(models[0]).toMatchObject({ default: true, capabilities: { input: { image: false } } });
  expect(models[1]).toMatchObject({ family: 'cortex', supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], capabilities: { input: { image: true } } });
  expect(cortexModels(f.runtime.configOptions, '9.0.0')[1].capabilities!.input!.image).toBe(false);
  expect(cortexModels([], '1.2.35')).toEqual([]);
  expect(cortexConfigOptions([{ id: 'bad', type: 'text' }])).toEqual([]);
  await f.client.close();
});

test('model/effort/mode changes use config RPC and omitted overrides explicitly reset native auto', async () => {
  const f = cortexFixture();
  await configureCortex(f.runtime, { model: 'claude-sonnet-4-6', effort: 'low', mode: 'plan' });
  await configureCortex(f.runtime, {});
  expect(f.writes.map(frame => [frame.method, frame.params?.configId, frame.params?.value])).toEqual([
    ['session/set_config_option', 'model', 'claude-sonnet-4-6'], ['session/set_config_option', 'thought_level', 'low'], ['session/set_config_option', 'mode', 'plan'],
    ['session/set_config_option', 'model', 'auto'], ['session/set_config_option', 'thought_level', 'auto'], ['session/set_config_option', 'mode', 'standard'],
  ]);
  expect(f.writes.some(frame => frame.params?.configId === '_restricted_session_scope')).toBe(false);
  await f.client.close();
});

test('invalid selections and stale/failed catalog responses cannot send a prompt or reuse another profile catalog', async () => {
  const f = cortexFixture();
  await expect(configureCortex(f.runtime, { model: 'private-missing-model' })).rejects.toThrow('model selection is unavailable');
  await expect(configureCortex(f.runtime, { effort: 'ultra' })).rejects.toThrow('effort selection is unavailable');
  await expect(configureCortex(f.runtime, { mode: 'bypass' as any })).rejects.toThrow('standard or plan');
  expect(f.writes).toEqual([]);
  const request = jest.spyOn(f.client, 'request').mockResolvedValue({ configOptions: [] });
  await expect(configureCortex(f.runtime, { model: 'claude-sonnet-4-6' })).rejects.toThrow('did not confirm');
  expect(f.runtime.configOptions).toEqual([]);
  request.mockRestore();
  await expect(configureCortex(f.runtime, {})).rejects.toThrow('unavailable');
  const other = cortexFixture();
  expect(cortexRecord(other.runtime.configOptions[0]).currentValue).toBe('auto');
  await Promise.all([f.client.close(), other.client.close()]);
});
