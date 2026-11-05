import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ModelInfo } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import type { CliProfile } from '../src/types';
import { CopilotModelCatalog, assertCopilotSelection, copilotCatalogKey } from '../src/services/backends/copilotCatalog';
import { copilotRuntimeModels } from '../src/services/backends/copilotModels';
import { resolveCopilotCliRuntime } from '../src/services/backends/copilotRuntime';
import { startCopilotSdkRuntime } from '../src/services/backends/copilotSdkRuntime';

jest.mock('../src/services/backends/copilotSdkRuntime', () => ({ startCopilotSdkRuntime: jest.fn() }));
const start = jest.mocked(startCopilotSdkRuntime);
const profile = (id = 'catalog', env: Record<string, string> = {}): CliProfile => ({ id, name: id, harness: 'copilot', authMode: 'server-configured', createdAt: '', updatedAt: '',
  env: { COPILOT_PROVIDER_BASE_URL: '', COPILOT_MODEL: '', ...env } });
const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, name: id.toUpperCase(),
  capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: 1000 } },
  supportedReasoningEfforts: ['high', 'max'], ...extra });

describe('Copilot runtime model projection and selection validation', () => {
  test('maps account IDs and exact efforts, filters policy/duplicates, and never infers media from model names or vision alone', () => {
    const models = copilotRuntimeModels([model('new-model'), model('new-model'), model('auto'), model(''),
      model('disabled', { policy: { state: 'disabled', terms: '' } }), model('unconfigured', { policy: { state: 'unconfigured', terms: '' } }),
      model('gpt-6.1-sol'), model('gpt-6-sol', { supportedReasoningEfforts: undefined }), model('no-reasoning', {
        capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 1000 } } }),
      model('minimal', { name: '', capabilities: undefined as never, supportedReasoningEfforts: ['high'] }),
    ]);
    expect(models.map(candidate => candidate.id)).toEqual(['auto', 'new-model', 'gpt-6.1-sol', 'gpt-6-sol', 'no-reasoning', 'minimal']);
    expect(models[1]).toMatchObject({ label: 'NEW-MODEL', supportedEffortLevels: ['high', 'max'], capabilities: { input: { image: false, pdf: false } } });
    expect(models[2].capabilities?.input).toEqual({ text: true, image: true, pdf: true });
    expect(models[3].supportedEffortLevels).toBeUndefined();
    expect(models[4].supportedEffortLevels).toBeUndefined();
    expect(models[5].label).toBe('minimal');
    expect(copilotRuntimeModels([])).toEqual([]);
    expect(copilotRuntimeModels([model('gpt-6.1-sol', { capabilities: { supports: { vision: false, reasoningEffort: true }, limits: { max_context_window_tokens: 0 } } })])[1].capabilities?.input?.image).toBe(false);
  });

  test('rejects unavailable models and unsupported effort, including automatic/env selections', () => {
    const catalog = { models: copilotRuntimeModels([model('new-model')]) };
    expect(() => assertCopilotSelection(catalog, { model: 'new-model', effort: 'max' }, {})).not.toThrow();
    expect(() => assertCopilotSelection(catalog, { model: 'retired' }, {})).toThrow('Choose a model from the current list');
    expect(() => assertCopilotSelection(catalog, { model: 'new-model', effort: 'low' }, {})).toThrow('does not support effort "low"');
    expect(() => assertCopilotSelection(catalog, { model: 'auto', effort: 'high' }, {})).toThrow('does not support effort');
    expect(() => assertCopilotSelection(catalog, { model: 'auto', effort: 'max' }, { COPILOT_MODEL: 'new-model' })).not.toThrow();
    expect(() => assertCopilotSelection(catalog, {}, { COPILOT_MODEL: 'removed' })).toThrow('removed');
    expect(() => assertCopilotSelection({ models: [] }, {}, {})).toThrow('unavailable');
  });
});

describe('Copilot model catalog ownership and cache isolation', () => {
  let catalog: CopilotModelCatalog;
  let listModels: jest.Mock;
  let stop: jest.Mock;
  beforeEach(() => {
    start.mockReset();
    catalog = new CopilotModelCatalog(1000);
    listModels = jest.fn().mockResolvedValue([model('account-model')]);
    stop = jest.fn().mockResolvedValue(undefined);
    start.mockResolvedValue({ client: { listModels }, stop, closed: new Promise(() => {}) } as never);
  });
  afterEach(async () => { await catalog.shutdown(); jest.restoreAllMocks(); });

  test('coalesces reads, stops discovery without creating a session, and returns isolated cached copies', async () => {
    const [a, b] = await Promise.all([catalog.get(profile()), catalog.get(profile())]);
    expect(a).toEqual(b);
    expect(a.modelCatalog).toMatchObject({ source: 'runtime', fetchedAt: expect.any(String) });
    expect(a.models.map(candidate => candidate.id)).toEqual(['auto', 'account-model']);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    a.models[1].label = 'mutated';
    expect((await catalog.get(profile())).models[1].label).toBe('ACCOUNT-MODEL');
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  test('separates profiles, effective server/profile env credentials and executable/auth file revisions without exposing values', async () => {
    await catalog.get(profile('a'));
    await catalog.get(profile('b'));
    await catalog.get(profile('a', { GH_TOKEN: 'private-fixture-token' }));
    expect(start).toHaveBeenCalledTimes(3);
    const runtime = resolveCopilotCliRuntime(profile('a'));
    expect(copilotCatalogKey(runtime)).not.toContain('private');
    expect(copilotCatalogKey({ ...runtime, env: { ...runtime.env, GH_TOKEN: 'changed' } })).not.toBe(copilotCatalogKey(runtime));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-catalog-key-'));
    try {
      const file = path.join(dir, 'copilot');
      fs.writeFileSync(file, 'v1');
      const local = { ...runtime, command: 'copilot', env: { ...runtime.env, PATH: dir, COPILOT_HOME: dir } };
      const first = copilotCatalogKey(local);
      fs.writeFileSync(file, 'longer v2');
      expect(copilotCatalogKey(local)).not.toBe(first);
      const second = copilotCatalogKey(local);
      fs.writeFileSync(path.join(dir, 'config.json'), '{"loggedInUser":"fixture"}');
      expect(copilotCatalogKey(local)).not.toBe(second);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('refreshes expired and bounded cache entries', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    await catalog.get(profile());
    now.mockReturnValue(61001);
    await catalog.get(profile());
    expect(listModels).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 33; i++) await catalog.get(profile(String(i)));
    await catalog.get(profile('0'));
    expect(listModels).toHaveBeenCalledTimes(36);
  });

  test('keeps an authoritative empty catalog empty rather than claiming fallback access', async () => {
    listModels.mockResolvedValue([model('disabled', { policy: { state: 'disabled', terms: '' } })]);
    expect(await catalog.get(profile())).toMatchObject({ models: [], modelCatalog: { source: 'runtime' } });
  });

  test('labels discovery failure and strips native error bodies, headers and credentials', async () => {
    listModels.mockRejectedValue(new Error('models.list failed: {"status":403,"headers":["private-fixture"],"body":"private-fixture"}'));
    const result = await catalog.get(profile());
    expect(result.modelCatalog).toEqual({ source: 'fallback', reason: 'Account model discovery failed (HTTP 403). Check this profile\'s access.' });
    expect(JSON.stringify(result)).not.toContain('private-fixture');
    expect(stop).toHaveBeenCalledTimes(1);
    await catalog.get(profile());
    expect(listModels).toHaveBeenCalledTimes(1);
    await catalog.shutdown();
    listModels.mockRejectedValue('private-fixture');
    expect((await catalog.get(profile())).modelCatalog.reason).toContain('unavailable');
  });

  test('retains curated compatibility models and adds only a text model for a custom endpoint', async () => {
    const opaque = await catalog.get({ ...profile(), command: '/wrapper' });
    expect(opaque.modelCatalog).toMatchObject({ source: 'fallback', reason: expect.stringContaining('compatibility') });
    const configuredWrapper = await catalog.get({ ...profile('wrapper', { COPILOT_MODEL: 'wrapper-model' }), command: '/wrapper' });
    expect(configuredWrapper.models.at(-1)).toMatchObject({ id: 'wrapper-model', capabilities: { input: { text: true } } });
    const custom = await catalog.get(profile('custom', { COPILOT_PROVIDER_BASE_URL: 'http://localhost:1', COPILOT_MODEL: 'private-model' }));
    expect(custom.modelCatalog.reason).toContain('Custom provider');
    expect(custom.models.at(-1)).toMatchObject({ id: 'private-model', capabilities: { input: { text: true } } });
    expect(custom.models.at(-1)?.supportedEffortLevels).toBeUndefined();
    expect(start.mock.calls.length).toBe(0);
  });

  test('times out a hanging request and drains the owned process', async () => {
    catalog = new CopilotModelCatalog(20);
    listModels.mockReturnValue(new Promise(() => {}));
    expect((await catalog.get(profile())).modelCatalog.source).toBe('fallback');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('releases failed startups', async () => {
    start.mockRejectedValueOnce(new Error('private-fixture'));
    expect((await catalog.get(profile())).modelCatalog.source).toBe('fallback');
  });

  test('failed cleanup blocks replacement and remains visible to shutdown', async () => {
    stop.mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(catalog.get(profile('other'))).rejects.toThrow('cleanup failed');
    await expect(catalog.get(profile('other'))).rejects.toThrow('cleanup failed');
    await expect(catalog.forRuntime(resolveCopilotCliRuntime(profile('other')), { listModels } as never)).rejects.toThrow('cleanup failed');
    expect(start.mock.calls.length).toBe(1);
    await expect(catalog.shutdown()).rejects.toThrow('cleanup failed');
    // The failed instance deliberately remains closed to replacement.
    catalog = new CopilotModelCatalog();
  });

  test('shutdown drains late startup, blocks discovery during cleanup and permits a fresh runtime afterwards', async () => {
    let release!: (value: unknown) => void;
    start.mockImplementationOnce(() => new Promise(resolve => { release = resolve as never; }));
    const pending = catalog.get(profile());
    const shutdown = catalog.shutdown();
    expect((await catalog.get(profile('other'))).modelCatalog.reason).toContain('restarting');
    release({ client: { listModels }, stop, closed: new Promise(() => {}) });
    await shutdown;
    await pending;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(listModels).not.toHaveBeenCalled();
    expect((await catalog.get(profile())).modelCatalog.source).toBe('runtime');
    expect(start).toHaveBeenCalledTimes(2);
  });
});
