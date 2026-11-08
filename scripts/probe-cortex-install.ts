import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { InstallDoctorService } from '../src/services/installDoctorService';
import { cortexVersion, resolveCortexRuntime } from '../src/services/backends/cortexRuntime';
import type { CliProfile, InstallStatus } from '../src/types';

/** Real standalone install in a disposable home; never changes terminal auth. */
async function main(): Promise<void> {
  assert.equal(process.env.CORTEX_INSTALL_PROBE, '1', 'Set CORTEX_INSTALL_PROBE=1 to download the official distribution');
  assert.equal(process.platform, 'darwin', 'This probe certifies macOS only');
  if (process.argv[2] !== '--fixture') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit cortex install ')); fs.chmodSync(root, 0o700);
    const fixtureHome = path.join(root, 'user home'); fs.mkdirSync(fixtureHome);
    const result = spawnSync(process.execPath, ['--import', 'tsx', __filename, '--fixture', root], {
      env: { ...process.env, HOME: fixtureHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      cwd: process.cwd(), stdio: 'inherit', timeout: 12 * 60_000,
    });
    assert.equal(result.status, 0, 'Isolated installation probe failed');
    return;
  }
  const root = process.argv[3], fixtureHome = path.join(root, 'user home');
  assert.equal(process.env.HOME, fixtureHome);
  const shellProfile = path.join(fixtureHome, '.zshrc'), originalShellProfile = '# Existing user shell configuration\n';
  fs.writeFileSync(shellProfile, originalShellProfile);
  const appRoot = path.join(root, 'app folder'), dataRoot = path.join(root, 'data');
  fs.mkdirSync(appRoot);
  const now = new Date().toISOString();
  const results: Record<string, unknown> = {};
  const report = { startedAt: now, platform: process.platform, arch: process.arch, node: process.version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  const doctor = new InstallDoctorService({ appRoot, dataRoot,
    installStateService: { getStatus: () => ({ channel: 'dev', appDir: appRoot, dataDir: dataRoot } as InstallStatus) } as any,
    detectHomebrew: async () => false,
    detectPandoc: async () => ({ available: false, binaryPath: null, version: null, checkedAt: now }),
    detectLibreOffice: async () => ({ available: false, binaryPath: null, checkedAt: now }),
  });
  try {
    const before = (await doctor.getStatus()).checks.find(item => item.id === 'cortex-cli')!;
    assert.equal(before.status, 'warning');
    assert.ok(before.installActions?.some(item => item.id === 'cortex-cli:official-install'));
    results.initiallyMissing = true;
    const installed = await doctor.runInstallAction('cortex-cli:official-install');
    fs.writeFileSync(path.join(root, 'installer-result.json'), JSON.stringify(installed, null, 2), { mode: 0o600 });
    assert.equal(installed.success, true, installed.error);
    assert.equal(installed.doctor?.checks.find(item => item.id === 'cortex-cli')?.status, 'ok');
    assert.equal(process.env.PATH?.includes('.local/bin'), false);
    results.installAndImmediateDetection = true;
    const profile: CliProfile = { id: 'fixture', name: 'fixture', harness: 'cortex-code', authMode: 'account',
      configDir: path.join(root, 'separate auth'), cortexCode: { connection: 'fixture' }, createdAt: now, updatedAt: now };
    const automatic = resolveCortexRuntime({ profile, cwd: appRoot, workspaceId: 'fixture' });
    assert.equal(automatic.command, fs.realpathSync(path.join(fixtureHome, '.local/bin/cortex')));
    const version = await cortexVersion(automatic);
    assert.equal(version, '1.2.35', 'A new stable release requires compatibility review');
    results.nativeVersion = version;
    const override = path.join(root, 'custom tools', 'cortex override'); fs.mkdirSync(path.dirname(override));
    fs.symlinkSync(automatic.command, override);
    const explicit = resolveCortexRuntime({ profile: { ...profile, command: override }, cwd: appRoot, workspaceId: 'fixture' });
    assert.equal(explicit.command, fs.realpathSync(override)); assert.equal(await cortexVersion(explicit), version);
    assert.equal(explicit.env.SNOWFLAKE_HOME, profile.configDir);
    results.spacedCommandOverride = true; results.executableIndependentOfAuthHome = true;
    // --help/--version create native logs even before any connection/login.
    const snowflake = path.join(fixtureHome, '.snowflake');
    const nativeFiles = fs.readdirSync(snowflake, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
    assert.ok(nativeFiles.every(entry => path.relative(snowflake, path.join(entry.parentPath, entry.name)).startsWith(`cortex${path.sep}logs${path.sep}`)));
    const shellText = fs.readFileSync(shellProfile, 'utf8');
    assert.ok(shellText.startsWith(originalShellProfile));
    assert.match(shellText.slice(originalShellProfile.length), /Cortex CLI completion/);
    assert.ok(!shellText.includes('export PATH='));
    assert.ok(!fs.existsSync(path.join(fixtureHome, '.bashrc')));
    results.nativeLogsOnlyNoCredentials = true;
    results.nativeShellCompletionsPreserveExistingProfile = true;
    results.noInstallerPathProfileWrites = true;
    fs.rmSync(path.join(fixtureHome, '.local'), { recursive: true, force: true });
    results.disposableInstallationRemoved = true;
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ ...report, passed: true }, null, 2), { mode: 0o600 });
    process.stdout.write(`Cortex installation probe passed: ${path.join(root, 'report.json')}\n`);
  } catch (error) {
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ ...report, passed: false, error: String(error) }, null, 2), { mode: 0o600 });
    throw error;
  } finally {
    fs.rmSync(path.join(fixtureHome, '.local'), { recursive: true, force: true });
  }
}
void main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
