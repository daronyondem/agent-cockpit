#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const windowsPathCleanupFunction = String.raw`
function Remove-SmokePathEntry {
  param([string] $Current, [string] $Entry)
  $key = $Entry.Trim().Replace('/', '\').TrimEnd('\')
  return (($Current -split ';' | Where-Object { $_.Trim().Replace('/', '\').TrimEnd('\') -ine $key }) -join ';')
}
`;

function runCommand(command, argv, options, outputRoot) {
  const directory = fs.mkdtempSync(path.join(outputRoot, 'command-'));
  const stdoutPath = path.join(directory, 'stdout.log');
  const stderrPath = path.join(directory, 'stderr.log');
  const stdoutFd = fs.openSync(stdoutPath, 'w', 0o600);
  let stderrFd;
  let result;
  try {
    stderrFd = fs.openSync(stderrPath, 'w', 0o600);
    // Detached descendants can keep pipes open after the command has exited.
    result = spawnSync(command, argv, { ...options, stdio: ['ignore', stdoutFd, stderrFd] });
  } finally {
    fs.closeSync(stdoutFd);
    if (stderrFd !== undefined) fs.closeSync(stderrFd);
  }
  const stdout = fs.readFileSync(stdoutPath, 'utf8');
  const stderr = fs.readFileSync(stderrPath, 'utf8');
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed (${result.status}): ${[result.error?.message, stderr || stdout].filter(Boolean).join('\n')}`);
  }
  return stdout;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? null : args[index + 1];
  };
  const privateNode = args.includes('--private-node');
  const autoStart = args.includes('--auto-start');
  if (autoStart && process.env.CI !== 'true') throw new Error('--auto-start is restricted to disposable CI runners.');
  const platform = process.platform;
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error(`Unsupported smoke platform: ${platform}`);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(platform === 'darwin' ? '/tmp' : os.tmpdir(), 'cockpit-install-')));
  const installDir = path.join(root, 'installation with spaces');
  const home = path.join(root, 'home');
  const reportDir = path.resolve(value('--report-dir') || path.join(os.tmpdir(), `cockpit-install-report-${Date.now()}`));
  const releaseDir = path.resolve(value('--release-dir') || path.join(root, 'release'));
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PM2_HOME: path.join(installDir, 'pm2'),
    AGENT_COCKPIT_INSTALL_TEST_RELEASE_DIR: releaseDir,
    AGENT_COCKPIT_INSTALL_LIBRARY_ONLY: '',
    PLAYWRIGHT_USE_SYSTEM_CHROME: process.env.PLAYWRIGHT_USE_SYSTEM_CHROME || '0',
  };
  const report = { platform, arch: process.arch, runtime: privateNode ? 'private' : 'system', checks: [], success: false };
  let state;
  const ps = 'powershell.exe';
  const run = (command, argv, options = {}) => runCommand(command, argv, { env, timeout: 15 * 60_000, ...options }, root);
  const readState = () => JSON.parse(fs.readFileSync(path.join(installDir, 'data', 'install.json'), 'utf8'));
  const readEnv = () => fs.readFileSync(path.join(readState().appDir, '.env'), 'utf8');
  const managedPid = () => {
    const current = readState();
    const node = path.join(current.nodeRuntime.binDir, platform === 'win32' ? 'node.exe' : 'node');
    const entries = JSON.parse(run(node, [path.join(current.appDir, 'node_modules/pm2/bin/pm2'), 'jlist', '--silent']))
      .filter(entry => entry.name === 'agent-cockpit');
    assert.equal(entries.length, 1, 'Expected one app in the isolated PM2 daemon.');
    const entry = entries[0], info = entry.pm2_env;
    assert.equal(info.status, 'online');
    assert.equal(Number(info.PORT), port);
    assert.equal(fs.realpathSync(info.pm_cwd), fs.realpathSync(current.appDir));
    assert.equal(fs.realpathSync(info.PM2_HOME), fs.realpathSync(env.PM2_HOME));
    assert.ok(Number.isInteger(entry.pid) && entry.pid > 0);
    process.kill(entry.pid, 0);
    return entry.pid;
  };
  const request = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Connection: 'close' } });
    assert.equal(response.status, 200, url);
    return response;
  };
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const baseURL = `http://127.0.0.1:${port}`;
  const installerName = platform === 'win32' ? 'install-windows.ps1' : platform === 'darwin' ? 'install-macos.sh' : 'install-linux.sh';
  const installerArgs = platform === 'win32'
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(releaseDir, installerName), '-InstallDir', installDir, '-Port', String(port), '-SkipOpen', ...(privateNode ? ['-InstallNode'] : [])]
    : [path.join(releaseDir, installerName), '--install-dir', installDir, '--port', String(port), '--skip-open'];
  const installer = platform === 'win32' ? ps : '/bin/bash';
  const manual = platform === 'win32' ? '-NoAutoStart' : '--no-auto-start';
  try {
    if (!value('--release-dir')) {
      run(process.execPath, ['scripts/package-release.js', '--version', require('../package.json').version, '--out-dir', releaseDir]);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, 'release-manifest.json'), 'utf8'));
    report.version = manifest.version;
    report.sourceCommit = manifest.sourceCommit;
    if (platform !== 'win32' && privateNode) {
      const bin = path.join(root, 'no-system-node');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
      env.PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
    }
    const install = (manualStartup) => run(installer, [...installerArgs, ...(manualStartup ? [manual] : [])]);
    install(!autoStart);
    state = readState();
    assert.equal(state.channel, 'production');
    assert.equal(state.version, manifest.version);
    assert.equal(state.nodeRuntime.source, report.runtime);
    report.nodeVersion = state.nodeRuntime.version;
    assert.equal((await (await request(`${baseURL}/api/chat/version`)).json()).version, manifest.version);
    const initialPid = managedPid();
    const doctor = await (await request(`${baseURL}/api/chat/install/doctor`)).json();
    for (const check of doctor.checks.filter(item => item.required)) assert.equal(check.status, 'ok', check.id);
    for (const route of ['/auth/setup', '/v2/', '/mobile/']) await (await request(`${baseURL}${route}`)).arrayBuffer();
    assert.equal(fs.existsSync(path.join(state.appDir, 'mobile', 'AgentCockpitPWA', 'node_modules')), false);
    report.checks.push('production package, expected version, required doctor checks, desktop/mobile assets, prebuilt mobile fast path');
    if (autoStart) {
      if (platform === 'win32') run(ps, ['-NoProfile', '-Command', 'Get-ScheduledTask -TaskName AgentCockpit -ErrorAction Stop | Out-Null']);
      else assert.ok(fs.existsSync(platform === 'darwin'
        ? path.join(home, 'Library/LaunchAgents/com.agent-cockpit.server.plist')
        : path.join(env.XDG_CONFIG_HOME, 'systemd/user/agent-cockpit.service')));
      report.checks.push('current-user startup registration (not a reboot/login test)');
    }
    const browser = (repaired) => {
      if (!args.includes('--ui')) return;
      run(process.execPath, [
        require.resolve('@playwright/test/cli'), 'test', 'test/e2e/install.ui.pw.ts',
        '--config', 'playwright.config.ts', '--project', 'chromium', '--output', path.join(reportDir, 'browser'),
      ], { env: { ...process.env, AGENT_COCKPIT_E2E_BASE_URL: baseURL, INSTALL_UI_E2E: '1', INSTALL_UI_REPAIRED: repaired ? '1' : '0' } });
    };
    browser(false);
    if (args.includes('--ui')) report.checks.push('browser owner setup and persisted welcome completion without backend authentication');
    state = readState();
    const original = readEnv();
    const secret = original.match(/^SESSION_SECRET=(.+)$/m)[1];
    fs.appendFileSync(path.join(state.appDir, '.env'), '\nINSTALL_SMOKE_CUSTOM=preserved\n');
    fs.writeFileSync(path.join(installDir, 'data/smoke-marker.txt'), 'preserved');
    install(true);
    const repaired = readState();
    assert.equal(repaired.installedAt, state.installedAt);
    assert.equal(repaired.welcomeCompletedAt, state.welcomeCompletedAt);
    assert.ok(readEnv().includes(`SESSION_SECRET=${secret}`));
    assert.ok(readEnv().includes('INSTALL_SMOKE_CUSTOM=preserved'));
    assert.equal(fs.readFileSync(path.join(installDir, 'data/smoke-marker.txt'), 'utf8'), 'preserved');
    assert.equal(repaired.startup.kind, 'manual');
    if (privateNode) assert.equal(repaired.nodeRuntime.runtimeDir, state.nodeRuntime.runtimeDir);
    assert.equal((await (await request(`${baseURL}/api/chat/version`)).json()).version, manifest.version);
    const repairedPid = managedPid();
    assert.notEqual(repairedPid, initialPid, 'Repair must restart the managed process.');
    browser(true);
    if (args.includes('--ui')) report.checks.push('browser repair preserves onboarding and serves mobile without horizontal overflow');
    report.checks.push('same-version repair preserves config, secrets, data, install date, and onboarding');
    fs.writeFileSync(path.join(installDir, 'data/install.json'), '{broken');
    install(true);
    assert.equal((await (await request(`${baseURL}/api/chat/version`)).json()).version, manifest.version);
    assert.ok(readEnv().includes(`SESSION_SECRET=${secret}`));
    assert.ok(readEnv().includes('INSTALL_SMOKE_CUSTOM=preserved'));
    assert.equal(fs.readFileSync(path.join(installDir, 'data/smoke-marker.txt'), 'utf8'), 'preserved');
    const recoveredPid = managedPid();
    assert.notEqual(recoveredPid, repairedPid, 'Corrupt-manifest repair must restart the owned process.');
    report.checks.push('corrupt install manifest recovery verifies live PM2 ownership and preserves config, secrets, and data');
    const helper = (action, cleanStartup = false) => {
      const file = path.join(installDir, 'bin', `${action}-agent-cockpit.${platform === 'win32' ? 'ps1' : 'sh'}`);
      const helperEnv = { ...env };
      if (cleanStartup) delete helperEnv.PM2_HOME;
      run(platform === 'win32' ? ps : '/bin/bash', platform === 'win32' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file] : [file], { env: helperEnv });
    };
    helper('stop');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    helper('start', true);
    for (let attempt = 0; ; attempt++) {
      try { assert.equal((await (await request(`${baseURL}/api/chat/version`)).json()).version, manifest.version); break; }
      catch (error) { if (attempt === 89) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    const restartedPid = managedPid();
    assert.notEqual(restartedPid, recoveredPid);
    report.processPids = { initial: initialPid, repaired: repairedPid, recovered: recoveredPid, restarted: restartedPid };
    report.checks.push('owned PM2 process restarts, stop releases the port, startup helper preserves PM2_HOME without inherited environment');
    report.success = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    if (autoStart) {
      if (platform === 'win32') {
        const cleanup = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          "$env:AGENT_COCKPIT_INSTALL_LIBRARY_ONLY='1'; . $env:INSTALL_SMOKE_INSTALLER; $InstallDir=$env:INSTALL_SMOKE_ROOT; $NodeExe=$env:INSTALL_SMOKE_NODE; $NoAutoStart=$true; Register-LogonTask",
        ], { env: { ...env, INSTALL_SMOKE_INSTALLER: path.join(releaseDir, installerName), INSTALL_SMOKE_ROOT: installDir, INSTALL_SMOKE_NODE: process.execPath }, stdio: 'pipe' });
        if (cleanup.error || cleanup.status !== 0) { report.cleanupError = 'Owned startup task cleanup failed.'; report.success = false; }
      } else if (platform === 'darwin') {
        spawnSync('launchctl', ['unload', path.join(home, 'Library/LaunchAgents/com.agent-cockpit.server.plist')], { env, stdio: 'pipe' });
      } else {
        spawnSync('systemctl', ['--user', 'disable', 'agent-cockpit.service'], { env, stdio: 'pipe' });
        fs.rmSync(path.join(env.XDG_CONFIG_HOME, 'systemd/user/agent-cockpit.service'), { force: true });
        spawnSync('systemctl', ['--user', 'daemon-reload'], { env, stdio: 'pipe' });
      }
    }
    try {
      if (fs.existsSync(path.join(env.PM2_HOME, 'pm2.pid'))) {
        const releases = path.join(installDir, 'releases');
        const candidates = fs.readdirSync(releases).flatMap(name => {
          const dir = path.join(releases, name);
          return [dir, ...fs.readdirSync(dir).filter(child => fs.statSync(path.join(dir, child)).isDirectory()).map(child => path.join(dir, child))];
        });
        const app = candidates.find(dir => fs.existsSync(path.join(dir, 'node_modules/pm2/bin/pm2')));
        assert.ok(app, 'Cannot locate isolated PM2 for cleanup.');
        run(process.execPath, [path.join(app, 'node_modules/pm2/bin/pm2'), 'kill'], { timeout: 30_000 });
      }
    } catch (error) {
      report.cleanupError = error.message;
      report.success = false;
    }
    if (platform === 'win32') {
      try {
        run(ps, ['-NoProfile', '-Command', `${windowsPathCleanupFunction}
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -ne $current) {
  $next = Remove-SmokePathEntry $current $env:INSTALL_SMOKE_PREFIX
  if ($next -cne $current) { [Environment]::SetEnvironmentVariable('Path', $next, 'User') }
}
`], { env: { ...env, INSTALL_SMOKE_PREFIX: path.join(installDir, 'cli-tools') } });
      } catch (error) {
        report.cleanupError = [report.cleanupError, error.message].filter(Boolean).join('\n');
        report.success = false;
      }
    }
    const log = path.join(installDir, 'logs/install.log');
    if (fs.existsSync(log)) fs.copyFileSync(log, path.join(reportDir, 'install.log'));
    fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`Install smoke report: ${reportDir}`);
    if (!report.cleanupError) fs.rmSync(root, { recursive: true, force: true });
  }
  assert.ok(report.success, report.cleanupError || 'Installation smoke failed.');
}

module.exports = { runCommand, windowsPathCleanupFunction };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
