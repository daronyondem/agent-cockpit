import type { CortexConfigOption, CortexSelection, EffortLevel, ModelOption } from '../../types';
import { cortexRecord } from './cortexProtocol';
import type { CortexRuntime } from './cortexRuntime';
import { CortexInputError } from './cortexErrors';

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function cortexConfigOptions(value: unknown): CortexConfigOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap(item => {
    const row = cortexRecord(item);
    if (typeof row.id !== 'string' || seen.has(row.id) || row.type !== 'select' || typeof row.currentValue !== 'string' || !Array.isArray(row.options)) return [];
    seen.add(row.id);
    const choices = new Set<string>();
    const options = row.options.flatMap(item => {
      const option = cortexRecord(item);
      if (typeof option.value !== 'string' || !option.value || choices.has(option.value) || typeof option.name !== 'string') return [];
      choices.add(option.value);
      return [{ value: option.value, name: option.name }];
    });
    return [{ id: row.id, currentValue: row.currentValue, options }];
  });
}

export function cortexImageVerified(model: string | undefined, version: string): boolean {
  return model === 'claude-sonnet-4-6' && (version === '1.2.35' || version.startsWith('1.2.35+'));
}

export function cortexModels(value: unknown, version: string): ModelOption[] {
  const config = cortexConfigOptions(value);
  const models = config.find(option => option.id === 'model');
  const efforts = config.find(option => option.id === 'thought_level')?.options.map(option => option.value)
    .filter((effort): effort is EffortLevel => EFFORTS.has(effort)) || [];
  return (models?.options || []).map(option => ({ id: option.value, label: option.name, family: 'cortex',
    default: models!.currentValue === option.value,
    ...(efforts.length ? { supportedEffortLevels: efforts } : {}),
    capabilities: { input: { text: true, image: cortexImageVerified(option.value, version) }, output: { text: true }, toolcall: true },
  }));
}

/** Always read this runtime's current catalog, including each set response. */
export async function configureCortex(runtime: CortexRuntime, selection: CortexSelection): Promise<string> {
  if (selection.mode !== undefined && selection.mode !== 'standard' && selection.mode !== 'plan') throw new CortexInputError('Cortex mode must be standard or plan.');
  const set = async (id: string, value: string) => {
    const option = cortexConfigOptions(runtime.configOptions).find(option => option.id === id);
    if (!option?.options.some(option => option.value === value)) throw new CortexInputError(`Cortex ${id === 'thought_level' ? 'effort' : id} selection is unavailable in this profile.`);
    if (option.currentValue === value) return;
    try {
      const response = cortexRecord(await runtime.client.request('session/set_config_option', { sessionId: runtime.sessionId, configId: id, value }));
      runtime.configOptions = Array.isArray(response.configOptions) ? response.configOptions : [];
      const updated = cortexConfigOptions(runtime.configOptions).find(option => option.id === id);
      if (updated?.currentValue !== value) throw new CortexInputError('Cortex did not confirm the requested configuration.');
    } catch (error) {
      // Native selection is now unknown. Retire this runtime so the next lease
      // reloads the saved session with a fresh catalog instead of reusing it.
      runtime.configOptions = [];
      await runtime.close();
      throw error;
    }
  };
  await set('model', selection.model || 'auto');
  await set('thought_level', selection.effort || 'auto');
  await set('mode', selection.mode || 'standard');
  return selection.model || 'auto';
}
