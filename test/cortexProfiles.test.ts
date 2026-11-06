import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CliProfile, Settings } from '../src/types';
import { parseCortexCodeProfileConfig } from '../src/contracts/cliProfiles';
import { validateCliProfileDraftRequest, validateSettingsRequest } from '../src/contracts/chat';
import { SettingsService } from '../src/services/settingsService';
import {
  backendForCliProfile, cliHarnessForBackend, createServerConfiguredCliProfile,
  ensureServerConfiguredCliProfiles, hasRequiredCliProfileConfig,
  isSetupAccountCliProfile, resolveCliProfileRuntime,
} from '../src/services/cliProfiles';

const settings: Settings = { theme: 'system', sendBehavior: 'enter', systemPrompt: '' };
function profile(overrides: Partial<CliProfile> = {}): CliProfile {
  return { id: 'coco-work', name: 'CoCo Work', harness: 'cortex-code',
    authMode: 'server-configured', cortexCode: { connection: 'work-connection' },
    createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z', ...overrides };
}

describe('CoCo profile contracts and resolution', () => {
  test.each(['Work Connection', '"quoted connection"', '--connection=literal', 'literal$(name)', ' work '])(
    'preserves a named connection verbatim: %s', connection => {
      expect(parseCortexCodeProfileConfig({ connection })).toEqual({ connection });
      const record = profile({ cortexCode: { connection } });
      expect(validateCliProfileDraftRequest({ profile: record }).profile.cortexCode).toEqual({ connection });
      expect(validateSettingsRequest({ ...settings, cliProfiles: [record] }).cliProfiles?.[0].cortexCode).toEqual({ connection });
    },
  );

  test.each([null, [], 'work', {}, { connection: null }, { connection: 4 },
    { connection: '' }, { connection: '  ' }, { connection: 'bad\nname' },
    { connection: 'bad\u0000name' }, { connection: 'bad\u007fname' }, { connection: 'bad\u0085name' }])(
    'rejects invalid connection configuration without echoing values: %j', value => {
      expect(() => parseCortexCodeProfileConfig(value)).toThrow(/cortexCode/);
      const record = { ...profile(), cortexCode: value };
      expect(() => validateSettingsRequest({ cliProfiles: [record] })).toThrow(/cortexCode/);
      expect(() => validateCliProfileDraftRequest({ profile: record })).toThrow(/cortexCode/);
    },
  );

  test('rejects credentials and unknown config fields rather than returning them in draft responses', () => {
    const record = { ...profile(), cortexCode: { connection: 'work', password: 'PRIVATE_VALUE' } };
    expect(() => validateCliProfileDraftRequest({ profile: record })).toThrow('cortexCode accepts only a connection name');
    try { parseCortexCodeProfileConfig(record.cortexCode); }
    catch (error) { expect(String(error)).not.toContain('PRIVATE_VALUE'); }
    expect(() => validateSettingsRequest({ cliProfiles: [{ ...record, harness: 'codex' }] })).toThrow('requires the cortex-code harness');
  });

  test('resolves configured CoCo identity without reinterpreting provider/protocol', () => {
    const record = profile({ protocol: 'interactive' });
    expect(cliHarnessForBackend('cortex-code')).toBe('cortex-code');
    expect(backendForCliProfile(record)).toBe('cortex-code');
    expect(resolveCliProfileRuntime({ ...settings, cliProfiles: [record] }, record.id, null)).toEqual({
      runtime: { backendId: 'cortex-code', cliProfileId: record.id, profile: record },
    });
    expect(resolveCliProfileRuntime({ ...settings, cliProfiles: [profile({ disabled: true })] }, record.id, null).error).toMatch(/disabled/);
    expect(resolveCliProfileRuntime(settings, 'missing', null).error).toMatch(/not found/);
  });

  test('recognizes setup identity while keeping incomplete generated profiles out of defaults and execution', () => {
    const draft = createServerConfiguredCliProfile('cortex-code');
    expect(draft).toMatchObject({ id: 'server-configured-cortex-code', name: 'Cortex Code (CoCo) (Server Configured)' });
    expect(hasRequiredCliProfileConfig(draft)).toBe(false);
    expect(isSetupAccountCliProfile(profile({ id: 'setup-cortex-code-account-2', authMode: 'account' }))).toBe(true);
    expect(isSetupAccountCliProfile(profile({ id: 'other-account', authMode: 'account' }))).toBe(false);
    const generated = ensureServerConfiguredCliProfiles({ ...settings, defaultBackend: 'cortex-code' }, ['cortex-code']);
    expect(generated.settings.defaultCliProfileId).toBeUndefined();
    expect(resolveCliProfileRuntime(generated.settings, draft.id, null).error).toMatch(/named Snowflake connection/);
    expect(resolveCliProfileRuntime(settings, undefined, 'cortex-code').error).toMatch(/named Snowflake connection/);
    expect(resolveCliProfileRuntime({ ...settings, cliProfiles: [draft] }, undefined, 'cortex-code').error).toMatch(/named Snowflake connection/);
    const configured = { ...draft, cortexCode: { connection: 'work' } };
    expect(resolveCliProfileRuntime({ ...settings, cliProfiles: [configured] }, undefined, 'cortex-code').runtime?.profile).toEqual(configured);
    expect(ensureServerConfiguredCliProfiles({ ...settings, defaultBackend: 'cortex-code', cliProfiles: [configured] }, ['cortex-code']).settings.defaultCliProfileId).toBe(configured.id);
  });
});

describe('CoCo profile persistence', () => {
  let dir: string;
  let service: SettingsService;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-profiles-')); service = new SettingsService(dir); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('round-trips and edits connection, command and env without persisting other profile fields', async () => {
    const record = profile({ command: '/custom path/cortex', env: { KEEP: 'yes' }, protocol: 'interactive',
      claudeCode: { provider: 'bedrock' } });
    await service.saveSettings({ ...settings, cliProfiles: [record] });
    const loaded = await service.getSettings();
    expect(loaded.cliProfiles?.[0]).toMatchObject({ cortexCode: record.cortexCode, command: record.command, env: record.env });
    expect(loaded.cliProfiles?.[0].protocol).toBeUndefined();
    expect(loaded.cliProfiles?.[0].claudeCode).toBeUndefined();
    await service.saveSettings({ ...loaded, cliProfiles: [profile({ cortexCode: { connection: 'changed' } })] });
    expect((await service.getSettings()).cliProfiles?.[0].cortexCode).toEqual({ connection: 'changed' });
  });

  test('retains an incomplete setup draft without promoting it over an existing default', async () => {
    const old = createServerConfiguredCliProfile('codex');
    const draft = profile({ cortexCode: undefined });
    const saved = await service.saveSettings({ ...settings, cliProfiles: [draft, old], defaultCliProfileId: old.id });
    expect(saved.cliProfiles?.[0].id).toBe(draft.id);
    expect(saved.defaultCliProfileId).toBe(old.id);
    const onlyDraft = await service.saveSettings({ ...settings, cliProfiles: [draft], defaultCliProfileId: draft.id });
    expect(onlyDraft.defaultCliProfileId).toBeUndefined();
    expect(onlyDraft.defaultBackend).toBeUndefined();
  });

  test('complete CoCo setup can become the first default after chat registration while explicit defaults remain intact', async () => {
    const record = profile({ id: 'setup-cortex-code-account', authMode: 'account' });
    const saved = await service.saveSettings({ ...settings, cliProfiles: [record] });
    expect(saved.defaultCliProfileId).toBe(record.id); expect(saved.defaultBackend).toBe('cortex-code');
    const old = createServerConfiguredCliProfile('codex');
    expect((await service.saveSettings({ ...settings, cliProfiles: [record, old], defaultCliProfileId: old.id })).defaultCliProfileId).toBe(old.id);
  });

  test('rejects bad direct saves atomically, including credentials in the config object', async () => {
    await service.saveSettings({ ...settings, cliProfiles: [profile()] });
    const original = await fs.readFile(path.join(dir, 'settings.json'), 'utf8');
    const bad = { ...profile(), cortexCode: { connection: 'work', token: 'PRIVATE_VALUE' } };
    await expect(service.saveSettings({ ...settings, cliProfiles: [bad] })).rejects.toThrow('only a connection name');
    expect(await fs.readFile(path.join(dir, 'settings.json'), 'utf8')).toBe(original);
  });

  test('migrates legacy identity and removes only setup-owned auth homes', async () => {
    const setup = { ...profile({ id: 'setup-cortex-code-account', authMode: 'account',
      configDir: '/old/setup-home', env: { snowflake_home: '/old/env-home', KEEP: 'yes' } }), vendor: 'cortex-code', harness: undefined };
    const isolated = profile({ id: 'explicit-account', authMode: 'account', configDir: '/explicit/home', env: { SNOWFLAKE_HOME: '/explicit/env' } });
    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ ...settings, cliProfiles: [setup, isolated] }));
    const loaded = await service.getSettings();
    expect(loaded.cliProfiles?.[0]).toMatchObject({ harness: 'cortex-code', cortexCode: { connection: 'work-connection' }, env: { KEEP: 'yes' } });
    expect(loaded.cliProfiles?.[0].configDir).toBeUndefined();
    expect(loaded.cliProfiles?.[1]).toMatchObject({ configDir: '/explicit/home', env: { SNOWFLAKE_HOME: '/explicit/env' } });
    const persisted = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'));
    expect(persisted.cliProfiles[0].vendor).toBeUndefined();
    expect(persisted.cliProfiles[0].configDir).toBeUndefined();
  });
});
