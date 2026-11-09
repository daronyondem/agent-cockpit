import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import type { CliProfile } from '../src/types';
import { DataMigrationService } from '../src/services/dataMigrationService';
import { SettingsService } from '../src/services/settingsService';
import { CORTEX_MIGRATION_WARNING } from '../src/services/cortexMigration';

let root: string;
let snowflakeHome: string | undefined;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex bundle '));
  snowflakeHome = process.env.SNOWFLAKE_HOME; process.env.SNOWFLAKE_HOME = path.join(root, 'shared Snowflake');
});
afterEach(async () => {
  if (snowflakeHome === undefined) delete process.env.SNOWFLAKE_HOME; else process.env.SNOWFLAKE_HOME = snowflakeHome;
  await fs.rm(root, { recursive: true, force: true });
});

test('CoCo profiles, durable chat/media/usage and processor choices survive full replacement with a backup', async () => {
  const sourceRoot = path.join(root, 'source'); const destRoot = path.join(root, 'destination');
  await fs.mkdir(path.join(sourceRoot, 'chat'), { recursive: true });
  const externalHome = path.join(root, 'external Snowflake'); await fs.mkdir(externalHome);
  const nativeFile = path.join(externalHome, 'connections.toml'); await fs.writeFile(nativeFile, '# private native file\n');
  const command = path.join(root, 'external cortex'); await fs.writeFile(command, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const profiles: CliProfile[] = [
    { id: 'setup-cortex-code-account', name: 'Shared CoCo', harness: 'cortex-code', authMode: 'account', command,
      cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '' },
    { id: 'custom', name: 'Custom CoCo', harness: 'cortex-code', authMode: 'account', command,
      configDir: externalHome, cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '' },
    { id: 'disabled', name: 'Disabled CoCo', harness: 'cortex-code', authMode: 'account', disabled: true,
      cortexCode: { connection: 'unavailable' }, createdAt: '', updatedAt: '' },
    { id: 'in-root', name: 'In-root CoCo', harness: 'cortex-code', authMode: 'account', command,
      configDir: path.join(sourceRoot, 'cli-profiles/in-root'), cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '' },
  ];
  const settings = await new SettingsService(path.join(sourceRoot, 'chat')).saveSettings({ theme: 'dark', sendBehavior: 'enter', systemPrompt: '',
    cliProfiles: profiles, defaultCliProfileId: profiles[0].id, defaultModel: 'named-model', defaultEffort: 'high',
    memory: { cliProfileId: 'disabled' }, knowledgeBase: { ingestionCliProfileId: 'custom', digestionCliProfileId: 'missing' },
    workspaceContext: { cliProfileId: 'custom' } });
  const files = {
    'chat/workspaces/registry/index.json': JSON.stringify({ workspaceId: 'fixture', workspacePath: root, conversations: [{ id: 'chat', backend: 'cortex-code', cliProfileId: 'custom', model: 'named-model', effort: 'high',
      currentSessionId: 'cockpit-session', messageQueue: [{ content: 'queued follow-up' }],
      sessions: [{ number: 1, sessionId: 'cockpit-session', externalSessionId: 'native-session', active: true }] }] }),
    'chat/workspaces/registry/chat/session-1.json': JSON.stringify({ sessionNumber: 1, sessionId: 'cockpit-session', startedAt: '2026-11-08T00:00:00.000Z', endedAt: null,
      messages: [{ role: 'assistant', content: 'Durable transcript' }] }),
    'chat/artifacts/chat/image.png': 'fixture image bytes',
    'chat/workspaces/registry/memory/files/accepted.md': 'accepted memory',
    'chat/workspaces/registry/workspace-context/context.md': 'context',
    'chat/workspaces/registry/routines/fixture/routine.md': 'routine',
    'chat/usage-ledger.json': JSON.stringify({ days: [{ date: '2026-11-08', records: [{ backend: 'cortex-code', model: 'named-model',
      usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } }] }] }),
    'auth/owner.json': '{"fixture":true}',
    'cli-profiles/in-root/connections.toml': '# in-root native configuration\n[fixture]\naccount="fixture-account"\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(sourceRoot, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
  }
  const runtimeDirs = ['agent-cockpit-cortex-plugin-Ab123z', 'nested/cockpit-cortex-auth-Aa123z', 'nested/cockpit-cortex-login-Zz123a', 'nested/cockpit-cortex-restricted-Ab123z'];
  for (const dir of runtimeDirs) {
    await fs.mkdir(path.join(sourceRoot, dir), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, dir, 'owner.json'), 'transient fixture ownership');
  }
  await fs.mkdir(destRoot); await fs.writeFile(path.join(destRoot, 'old.txt'), 'destination before replace');
  const source = new DataMigrationService({ dataRoot: sourceRoot, appVersion: 'test' });
  const destination = new DataMigrationService({ dataRoot: destRoot, appVersion: 'test' });
  const bundle = await source.createExportBundle();
  expect(bundle.manifest.warnings).toContain(CORTEX_MIGRATION_WARNING);
  expect(bundle.manifest.excluded).toEqual(expect.arrayContaining(runtimeDirs));
  expect(bundle.manifest.files.map(file => file.path)).toEqual(expect.arrayContaining(Object.keys(files)));
  expect(bundle.manifest.files).toHaveLength(Object.keys(files).length + 1);
  const uploaded = path.join(root, 'upload.acexport'); await fs.copyFile(bundle.filePath, uploaded);
  const uploadId = await destination.saveImportUpload(uploaded);
  expect((await destination.previewImportUpload(uploadId)).warnings).toContain(CORTEX_MIGRATION_WARNING);
  const staged = await destination.scheduleImport(uploadId);
  expect(await fs.readFile(path.join(destRoot, 'old.txt'), 'utf8')).toBe('destination before replace');
  expect(DataMigrationService.applyPendingImport(destRoot)).toEqual({ applied: true, backupPath: staged.backupPath });
  expect(await fs.readFile(path.join(staged.backupPath, 'old.txt'), 'utf8')).toBe('destination before replace');
  await expect(fs.stat(path.join(destRoot, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  for (const [relative, content] of Object.entries(files)) expect(await fs.readFile(path.join(destRoot, relative), 'utf8')).toBe(content);
  for (const dir of runtimeDirs) await expect(fs.stat(path.join(destRoot, dir))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(nativeFile, 'utf8')).toBe('# private native file\n');
  expect(await fs.readFile(path.join(destRoot, 'chat/settings.json'), 'utf8')).toBe(await fs.readFile(path.join(sourceRoot, 'chat/settings.json'), 'utf8'));
  const restored = await new SettingsService(path.join(destRoot, 'chat')).getSettings();
  expect(restored.cliProfiles?.map(profile => ({ ...profile, updatedAt: undefined })))
    .toEqual(settings.cliProfiles?.map(profile => ({ ...profile, updatedAt: undefined })));
  expect(restored).toMatchObject({ defaultCliProfileId: profiles[0].id, defaultModel: 'named-model', defaultEffort: 'high',
    memory: { cliProfileId: 'disabled' }, knowledgeBase: { ingestionCliProfileId: 'custom', digestionCliProfileId: 'missing' }, workspaceContext: { cliProfileId: 'custom' } });
  await fs.rm(sourceRoot, { recursive: true }); // Old absolute homes must not silently remap.
  const checks = await destination.runPostImportChecks();
  expect(checks.tools.cliProfiles[1]).toMatchObject({ status: 'warning', message: expect.stringContaining('connection is unavailable') });
  expect(checks.tools.cliProfiles[2]).toMatchObject({ status: 'skipped' });
  expect(checks.tools.cliProfiles[3]).toMatchObject({ status: 'warning', message: expect.stringContaining('connection is unavailable') });
});

test.each(['plugin', 'auth', 'login', 'restricted', 'empty-directory', 'restricted-empty-directory', 'manifest-only'])('rejects imported %s runtime ownership even with valid manifest checksums', async kind => {
  const folder = kind === 'plugin' ? 'agent-cockpit-cortex-plugin-Ab123z' : `cockpit-cortex-${kind === 'empty-directory' ? 'login' : kind === 'restricted-empty-directory' ? 'restricted' : kind === 'manifest-only' ? 'auth' : kind}-Ab123z`;
  const relative = `nested/${folder}/owner.json`; const content = 'transient';
  const service = new DataMigrationService({ dataRoot: path.join(root, 'data'), appVersion: 'test' });
  const bundle = await service.createExportBundle(); const zip = new AdmZip(bundle.filePath);
  if (kind.endsWith('empty-directory')) zip.addFile(`data/nested/${folder}/`, Buffer.alloc(0));
  else {
    bundle.manifest.files.push({ path: relative, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
    bundle.manifest.counts.files++; bundle.manifest.counts.bytes += content.length;
    if (kind !== 'manifest-only') zip.addFile(`data/${relative}`, Buffer.from(content));
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify(bundle.manifest)));
  }
  const upload = path.join(root, `${kind}.acexport`); zip.writeZip(upload);
  const id = await service.saveImportUpload(upload);
  await expect(service.scheduleImport(id)).rejects.toThrow('transient Cortex Code runtime data');
  expect(service.getStatus().pendingImport).toBe(false);
});

test('tampered CoCo profile bytes fail checksum validation without changing active data', async () => {
  const dataRoot = path.join(root, 'data'); await fs.mkdir(path.join(dataRoot, 'chat'), { recursive: true });
  const file = path.join(dataRoot, 'chat/settings.json');
  await fs.writeFile(file, '{"cliProfiles":[{"harness":"cortex-code","name":"before"}]}');
  const service = new DataMigrationService({ dataRoot, appVersion: 'test' }); const bundle = await service.createExportBundle();
  const zip = new AdmZip(bundle.filePath); zip.updateFile('data/chat/settings.json', Buffer.from('{"cliProfiles":[{"harness":"cortex-code","name":"after!"}]}'));
  const upload = path.join(root, 'tampered.acexport'); zip.writeZip(upload);
  await expect(service.scheduleImport(await service.saveImportUpload(upload))).rejects.toThrow('checksum mismatch');
  expect(await fs.readFile(file, 'utf8')).toContain('before');
  expect(service.getStatus().pendingImport).toBe(false);
});
