import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CliProfile } from '../src/types';
import { checkCortexMigrationProfile, isCortexMigrationRuntimePath } from '../src/services/cortexMigration';

let root: string;
let profile: CliProfile;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex migration '));
  const command = path.join(root, 'cortex command');
  // Executing a restored command during GET /checks would leave this sentinel.
  await fs.writeFile(command, `#!/bin/sh\ntouch '${root}/executed'\n`, { mode: 0o700 });
  await fs.writeFile(path.join(root, 'connections.toml'), '[fixture]\naccount="fixture-account"\nauthenticator="OAUTH_AUTHORIZATION_CODE"\n');
  profile = { id: 'fixture', name: 'Fixture CoCo', harness: 'cortex-code', authMode: 'account', command,
    configDir: root, cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '' };
});
afterEach(async () => { jest.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

test('present executable and connection remain an explicit unchecked-auth warning without invoking native code', async () => {
  const result = await checkCortexMigrationProfile(profile, root);
  expect(result).toMatchObject({ status: 'warning', message: expect.stringContaining('executable file and selected Snowflake connection are present') });
  expect(result.message).toContain('Authentication has not been checked; run Check login');
  expect(result.message).not.toContain('fixture-account');
  await expect(fs.stat(path.join(root, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('incomplete profiles request a connection without selecting another one', async () => {
  delete profile.cortexCode;
  expect((await checkCortexMigrationProfile(profile, root)).message).toContain('Select a Snowflake connection');
});

test('a missing restored executable is actionable and never falls back to the shared command', async () => {
  profile.command = path.join(root, 'missing');
  expect((await checkCortexMigrationProfile(profile, root)).message).toContain('executable/runtime is unavailable');
});

test('native Windows remains unavailable rather than claiming runtime compatibility', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { expect((await checkCortexMigrationProfile(profile, root)).message).toContain('executable/runtime is unavailable'); }
  finally { Object.defineProperty(process, 'platform', platform); }
});

test.each(['missing', 'invalid', 'other', 'symlink'])('reports %s native connections with no credential contents', async kind => {
  const file = path.join(root, 'connections.toml');
  await fs.unlink(file);
  if (kind === 'invalid') await fs.writeFile(file, '[fixture]\npassword="private-password"\ninvalid syntax');
  if (kind === 'other') await fs.writeFile(file, '[other]\naccount="private-account"\n');
  if (kind === 'symlink') {
    const target = path.join(root, 'private.toml');
    await fs.writeFile(target, '[fixture]\naccount="private-account"\n');
    await fs.symlink(target, file);
  }
  const result = await checkCortexMigrationProfile(profile, root);
  expect(result.message).toContain('selected Snowflake connection is unavailable');
  expect(result.message).not.toMatch(/private-(?:password|account)/);
});

test('custom env and shared setup resolve the same native homes as runtime execution', async () => {
  const shared = path.join(root, 'shared'); await fs.mkdir(shared);
  const prior = process.env.SNOWFLAKE_HOME; process.env.SNOWFLAKE_HOME = shared;
  try {
    profile.env = { SNOWFLAKE_HOME: root }; delete profile.configDir;
    expect((await checkCortexMigrationProfile(profile, root)).message).toContain('connection are present');
    profile.id = 'setup-cortex-code-account';
    expect((await checkCortexMigrationProfile(profile, root)).message).toContain('connection is unavailable');
    await fs.copyFile(path.join(root, 'connections.toml'), path.join(shared, 'connections.toml'));
    expect((await checkCortexMigrationProfile(profile, root)).message).toContain('connection are present');
  } finally {
    if (prior === undefined) delete process.env.SNOWFLAKE_HOME; else process.env.SNOWFLAKE_HOME = prior;
  }
});

test('recognizes only reserved native temporary folder segments', () => {
  for (const prefix of ['agent-cockpit-cortex-plugin-', 'cockpit-cortex-auth-', 'cockpit-cortex-login-']) {
    expect(isCortexMigrationRuntimePath(`nested/${prefix}Ab123z/owner.json`)).toBe(true);
  }
  for (const file of ['chat/cortex-auth.json', 'notes/cockpit-cortex-auth-guide.md', 'cortex/profile.json', 'agent-cockpit-cortex-plugin-Ab123z.md']) {
    expect(isCortexMigrationRuntimePath(file)).toBe(false);
  }
});
