import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import { cortexInstallCommand } from '../src/services/cortexInstallation';
import { CliUpdateService } from '../src/services/cliUpdateService';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { CortexSessions } from '../src/services/backends/cortexSessions';
import { BackendRegistry } from '../src/services/backends/registry';
import type { CliProfile, Settings } from '../src/types';

const exec = promisify(execFile);
async function main(): Promise<void> {
  assert.equal(process.env.CORTEX_UPDATE_PROBE, '1', 'Set CORTEX_UPDATE_PROBE=1 to download and update an isolated native CLI');
  assert.equal(process.platform, 'darwin', 'This probe certifies macOS only');
  if (process.argv[2] !== '--fixture') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit cortex updates ')); fs.chmodSync(root, 0o700);
    const fixtureHome = path.join(root, 'user home'); fs.mkdirSync(fixtureHome);
    const result = spawnSync(process.execPath, ['--import', 'tsx', __filename, '--fixture', root], {
      cwd: process.cwd(), env: { ...process.env, HOME: fixtureHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      stdio: 'inherit', timeout: 14 * 60_000,
    });
    assert.equal(result.status, 0, 'Isolated native update probe failed'); return;
  }
  const root = process.argv[3], fixtureHome = path.join(root, 'user home'); assert.equal(process.env.HOME, fixtureHome);
  const cwd = path.join(root, 'workspace folder'); fs.mkdirSync(cwd);
  const results: Record<string, unknown> = {};
  const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  const sessions = new CortexSessions(), adapter = new CortexCodeAdapter({ sessions }), registry = new BackendRegistry();
  registry.register(adapter);
  const nativeFetch = globalThis.fetch;
  const drain = async () => { registry.shutdownAll(); await adapter.stopping; };
  try {
    const installer = cortexInstallCommand()!;
    const install = await exec(installer[0], installer.slice(1), { cwd, timeout: 600_000, maxBuffer: 2 * 1024 * 1024 });
    fs.writeFileSync(path.join(root, 'install.log'), install.stdout + install.stderr, { mode: 0o600 });
    const command = path.join(fixtureHome, '.local/bin/cortex');
    const distribution = path.dirname(fs.realpathSync(command)), version = path.basename(distribution);
    assert.match(version, /^1\.2\.35\+/);
    results.cliVersion = '1.2.35'; results.nativeDistribution = version;
    // Keep the genuine 1.2.35 binary, but label this disposable copy with an
    // older synthetic build to force a real package download/activation today.
    const synthetic = '1.2.35+000000.000000000000', syntheticDir = path.join(path.dirname(distribution), synthetic);
    fs.renameSync(distribution, syntheticDir); fs.writeFileSync(path.join(syntheticDir, 'cortex-version.txt'), synthetic);
    fs.unlinkSync(command); fs.symlinkSync(path.join(syntheticDir, 'cortex'), command);
    const nativeSettings = path.join(fixtureHome, '.snowflake/cortex/settings.json');
    fs.mkdirSync(path.dirname(nativeSettings), { recursive: true }); fs.writeFileSync(nativeSettings, JSON.stringify({ autoUpdate: true }));
    results.syntheticOlderBuildMetadata = true;
    const profile: CliProfile = { id: 'fixture', name: 'fixture', harness: 'cortex-code', authMode: 'account',
      command, configDir: path.join(root, 'profile auth'), env: { SNOWFLAKE_HOME: path.join(root, 'other auth'), PRIVATE_TOKEN: 'fixture-only' },
      cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '' };
    const settings: Settings = { theme: 'light', sendBehavior: 'enter', systemPrompt: '', cliProfiles: [profile] };
    const service = new CliUpdateService(cwd);
    const target = (await service.checkNow(async () => settings)).items[0];
    assert.equal(target.currentVersion, synthetic); assert.equal(target.latestVersion, version);
    assert.deepEqual(target.updateCommand, [command, 'update', version]);
    assert.equal(path.basename(path.dirname(fs.realpathSync(command))), synthetic, 'Passive version detection changed activation');
    assert.equal(JSON.parse(fs.readFileSync(nativeSettings, 'utf8')).autoUpdate, true);
    results.passiveDetectionPreservesActivationAndNativeAutoUpdatePreference = true;
    const before = await sessions.acquire('before-update', { profile, cwd, workspaceId: 'fixture' }); sessions.release('before-update', before);
    const updated = await service.triggerUpdate(target.id, { loadSettings: async () => settings, onUpdated: drain });
    fs.writeFileSync(path.join(root, 'update-result.json'), JSON.stringify(updated, null, 2), { mode: 0o600 });
    assert.equal(updated.success, true, updated.error); assert.equal(updated.item?.currentVersion, version);
    assert.equal(path.basename(path.dirname(fs.realpathSync(command))), version);
    assert.equal(before.client.isClosed, true); assert.equal(before.client.process.exitCode !== null || before.client.process.signalCode !== null, true);
    results.nativeDownloadChecksumActivationAndFreshVersion = true; results.awaitedOwnedRuntimeShutdown = true;
    const after = await sessions.acquire('after-update', { profile, cwd, workspaceId: 'fixture' }); sessions.release('after-update', after);
    assert.notEqual(after.client.process.pid, before.client.process.pid);
    results.reusableNativeRuntime = true; // ACP creation is not authentication.
    const missing = '1.2.35+000001.000000000001'; let inject = true;
    globalThis.fetch = async (input, options) => {
      if (inject && String(input).endsWith('/stable_version.txt')) { inject = false; return new Response(missing); }
      return nativeFetch(input, options);
    };
    const failed = await service.triggerUpdate(target.id, { loadSettings: async () => settings, onUpdated: drain });
    fs.writeFileSync(path.join(root, 'failed-update-result.json'), JSON.stringify(failed, null, 2), { mode: 0o600 });
    assert.equal(failed.success, false); assert.equal(failed.steps.length, 1); assert.equal(failed.steps[0].success, false);
    assert.equal(failed.item?.currentVersion, version); assert.equal(after.client.isClosed, true);
    assert.equal(path.basename(path.dirname(fs.realpathSync(command))), version);
    results.injectedMissingStableTargetNativeFailure = true;
    globalThis.fetch = nativeFetch;
    const retried = await service.triggerUpdate(target.id, { loadSettings: async () => settings, onUpdated: drain });
    assert.equal(retried.success, true, retried.error); assert.equal(retried.item?.currentVersion, version);
    results.explicitRetryAlreadyCurrent = true;
    const final = await sessions.acquire('after-retry', { profile, cwd, workspaceId: 'fixture' });
    assert.equal(final.version, '1.2.35'); await drain();
    assert.ok(!fs.existsSync(path.join(fixtureHome, '.snowflake/connections.toml')));
    results.noAuthenticationAttempted = true;
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ ...report, passed: true }, null, 2), { mode: 0o600 });
    process.stdout.write(`Cortex update probe passed: ${path.join(root, 'report.json')}\n`);
  } catch (error) {
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ ...report, passed: false, error: String(error) }, null, 2), { mode: 0o600 }); throw error;
  } finally {
    globalThis.fetch = nativeFetch; await drain(); fs.rmSync(path.join(fixtureHome, '.local'), { recursive: true, force: true });
  }
}
void main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
