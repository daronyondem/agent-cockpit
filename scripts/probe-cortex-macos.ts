import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import net from 'net';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { chromium, expect as baseExpect, type Browser } from '@playwright/test';
import { cortexVersion, resolveCortexRuntime } from '../src/services/backends/cortexRuntime';
import { parseCortexProcessTable } from '../src/services/backends/cortexProcess';
import { cortexSnowflakeHome, CortexConnections } from '../src/services/cortexConnections';
import type { CliProfile, CortexProcessIdentity } from '../src/types';

const exec = promisify(execFile);
const expect = baseExpect.configure({ timeout: 120_000 });

/** C51: local release package + real installer helpers, launchd, PM2 and shared native auth. */
async function main(): Promise<void> {
  assert.equal(process.env.CORTEX_MACOS_PROBE, '1', 'Set CORTEX_MACOS_PROBE=1 for native installation/inference');
  assert.equal(process.platform, 'darwin'); assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1');
  const connection = process.env.CORTEX_TEST_CONNECTION || (await new CortexConnections().list())[0]?.name;
  assert.ok(connection, 'Select an authenticated native connection');
  const cwd = process.cwd(), startedAt = new Date().toISOString();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit cortex macos ')); await fs.chmod(root, 0o700);
  const install = path.join(root, 'installed app'), home = path.join(root, 'installer home'), pm2Home = path.join(root, 'private pm2');
  const workspace = path.join(root, 'workspace folder'), assets = path.join(root, 'release assets');
  const current = path.join(install, 'current'), data = path.join(install, 'data');
  const label = `com.agent-cockpit.cortex-probe.${crypto.randomBytes(8).toString('hex')}`;
  const plist = path.join(home, 'Library/LaunchAgents', `${label}.plist`);
  await fs.mkdir(workspace); await fs.mkdir(home); await fs.mkdir(path.join(data, 'chat'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), '# Compatibility fixture\nOnly do the exact requested temporary file work. No SQL, web, MCP, agents, goals, scheduling or background commands.\n');
  const profile: CliProfile = { id: 'setup-cortex-code-account', name: 'CoCo macOS fixture', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: startedAt, updatedAt: startedAt };
  const sourceRuntime = resolveCortexRuntime({ profile, cwd: workspace, workspaceId: 'macos-probe' });
  const executableBefore = await fs.realpath(sourceRuntime.command), executableStat = await fs.stat(executableBefore);
  const distribution = path.basename(path.dirname(executableBefore)); assert.match(distribution, /^1\.2\.35\+/);
  // A retained distribution pins protocol evidence. Retain both terminal homes;
  // cached credential reuse with an isolated HOME is not certified.
  profile.command = executableBefore;
  const sharedSnowflakeHome = cortexSnowflakeHome(sourceRuntime.env);
  const native = resolveCortexRuntime({ profile, cwd: workspace, workspaceId: 'macos-probe',
    managedEnv: { SNOWFLAKE_HOME: sharedSnowflakeHome } });
  const version = await cortexVersion(native); assert.equal(version, '1.2.35', 'Review native version before certification');
  const packageVersion = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')).version as string;
  const results: Record<string, unknown> = { localCurrentBuildPackage: true, retainedPinnedCliWithSharedTerminalHomes: true, publicReleaseDownload: 'not tested',
    privateNodeBootstrap: 'not tested', remoteBrowserOAuth: 'pending C26 human handoff', stage: 'packaging' };
  const stage = (name: string) => { results.stage = name; process.stdout.write(`macOS: ${name}\n`); };
  const report = { startedAt, platform: process.platform, osRelease: os.release(), macOS: (await exec('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim(),
    arch: process.arch, node: process.version, cliVersion: version,
    revision: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    dirty: Boolean((await exec('git', ['status', '--porcelain'])).stdout.trim()), results };
  const port = await new Promise<number>((resolve, reject) => { const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = (server.address() as net.AddressInfo).port; server.close(() => resolve(value)); }); });
  const base = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  let browser: Browser | undefined, loaded = false;
  const observed = new Map<number, CortexProcessIdentity>();
  const deadline = setTimeout(() => { controller.abort(); void browser?.close(); }, 18 * 60_000);
  const run = async (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) =>
    exec(command, args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, signal: controller.signal, ...options });
  const table = async () => parseCortexProcessTable((await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='])).stdout);
  const remember = async (pid: number) => {
    const rows = await table(), owned = new Set([pid]); let changed = true;
    while (changed) { changed = false; for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
    for (const row of rows) if (owned.has(row.pid)) observed.set(row.pid, row);
    return rows.filter(row => owned.has(row.pid) && row.pid !== pid);
  };
  const pm2 = async (args: string[]) => run(process.execPath, [path.join(current, 'node_modules/pm2/bin/pm2'), ...args],
    { cwd: current, env: { ...process.env, PM2_HOME: pm2Home } });
  const serverPid = async () => {
    const apps = JSON.parse((await pm2(['jlist'])).stdout);
    const app = apps.find((item: { name: string }) => item.name === 'agent-cockpit');
    assert.equal(app?.pm2_env?.status, 'online'); assert.ok(app.pid > 0); return app.pid as number;
  };
  const ready = async () => {
    for (let i = 0; i < 120; i++) {
      try { const response = await fetch(`${base}/api/chat/version`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).version === packageVersion) return;
      } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Fixture version health failed');
  };
  try {
    await run(process.execPath, ['scripts/package-release.js', '--version', packageVersion, '--out-dir', assets], { timeout: 120_000 });
    const manifest = JSON.parse(await fs.readFile(path.join(assets, 'release-manifest.json'), 'utf8'));
    await run('/usr/bin/shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: assets });
    const archive = manifest.artifacts.find((item: { role: string }) => item.role === 'app-tarball').name;
    const releases = path.join(install, 'releases'); await fs.mkdir(releases, { recursive: true });
    await run('/usr/bin/tar', ['-xzf', path.join(assets, archive), '-C', releases]);
    await fs.symlink(path.join(releases, manifest.packageRoot), current);
    assert.equal((await fs.lstat(current)).isSymbolicLink(), true);
    stage('installer-helpers');
    const source = await fs.readFile(path.join(cwd, 'scripts/install-macos.sh'), 'utf8');
    const boundary = source.lastIndexOf('\nrequire_macos\n'); assert.ok(boundary > 0);
    // Retain actual installer functions. Scope label/HOME/PM2 only to this fixture;
    // materialize its plist first, then load it with an explicit private PM2 home.
    const prepare = path.join(root, 'prepare.sh');
    await fs.writeFile(prepare, source.slice(0, boundary) + `
INSTALL_DIR="$C51_INSTALL_DIR"
PORT="$C51_PORT"
LAUNCH_AGENT_LABEL="$C51_LABEL"
NODE_RUNTIME_PATH="$(runtime_path_with_user_cli_bins "$PATH")"
install_dependencies "$INSTALL_DIR/current"
ensure_built_assets "$INSTALL_DIR/current" false
write_env_file "$INSTALL_DIR/current" "$INSTALL_DIR/data" "$C51_SECRET" "$C51_TOKEN" "$NODE_RUNTIME_PATH"
write_ecosystem_config "$INSTALL_DIR/current" "$INSTALL_DIR/data" "$C51_SECRET" "$C51_TOKEN" "$NODE_RUNTIME_PATH"
write_install_manifest "$INSTALL_DIR/data" production github-release "$C51_VERSION" "" "$INSTALL_DIR" "$INSTALL_DIR/current" "" "" "" "" "" "$(startup_kind)" "$(startup_name)"
write_helper_scripts "$INSTALL_DIR/current" "$NODE_RUNTIME_PATH"
HOME="$C51_HOME"
launchctl() { return 0; }
register_login_startup
`, { mode: 0o700 });
    const prepared = await run('/bin/bash', [prepare], { timeout: 8 * 60_000, env: { ...process.env,
      PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      C51_INSTALL_DIR: install, C51_PORT: String(port), C51_LABEL: label, C51_HOME: home, C51_VERSION: packageVersion,
      C51_SECRET: crypto.randomBytes(32).toString('hex'), C51_TOKEN: crypto.randomBytes(32).toString('hex') } });
    await fs.writeFile(path.join(root, 'installation.log'), prepared.stdout + prepared.stderr, { mode: 0o600 });
    const installed = JSON.parse(await fs.readFile(path.join(data, 'install.json'), 'utf8'));
    assert.deepEqual(installed.startup, { kind: 'launch-agent', name: label, scope: 'current-user' });
    assert.equal(installed.appDir, current); assert.equal(installed.version, packageVersion);
    results.packagedInstallWithRealDependenciesAndSymlink = true;
    await fs.appendFile(path.join(current, '.env'), `\nDEFAULT_WORKSPACE=${JSON.stringify(workspace)}\n`);
    await fs.writeFile(path.join(data, 'chat/settings.json'), JSON.stringify({ theme: 'light', sendBehavior: 'enter', systemPrompt: '', cliProfiles: [profile],
      defaultCliProfileId: profile.id, defaultModel: 'claude-sonnet-4-6', defaultEffort: 'low' }), { mode: 0o600 });
    await run('/usr/bin/plutil', ['-insert', 'EnvironmentVariables', '-json', JSON.stringify({ PM2_HOME: pm2Home, HOME: os.homedir(),
      SNOWFLAKE_HOME: sharedSnowflakeHome, LANG: 'en_US.UTF-8' }), plist]);
    await run('/usr/bin/plutil', ['-lint', plist]);
    stage('launch-agent');
    // Bootstrap/bootout avoid persistent per-user enable/disable overrides for
    // this disposable label; the installer-generated RunAtLoad plist is retained.
    await run('/bin/launchctl', ['bootstrap', `gui/${process.getuid!()}`, plist]); loaded = true;
    // This host may place its GUI domain in on-demand-only mode. Starting the
    // registered job proves helper execution, not a new user-login event.
    await run('/bin/launchctl', ['kickstart', `gui/${process.getuid!()}/${label}`]);
    results.startupTrigger = 'explicit kickstart; new login not tested';
    await ready();
    await run('/bin/launchctl', ['print', `gui/${process.getuid!()}/${label}`]);
    const firstPid = await serverPid(); await remember(firstPid);
    results.currentUserLaunchAgentStartedPrivatePm2 = true; results.exactPackageVersionHealth = true;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(120_000);
    assert.ok((await page.request.get(`${base}/mobile/`)).ok(), 'Packaged mobile assets are unavailable');
    results.packagedMobileAssetsServed = true;
    const csrf = (await (await page.request.get(`${base}/api/csrf-token`)).json()).csrfToken;
    const headers = { 'x-csrf-token': csrf };
    stage('service-auth');
    const checked = await page.request.post(`${base}/api/chat/cli-profiles/setup-auth/cortex-code/test`, { headers, data: { connection }, timeout: 120_000 });
    assert.ok(checked.ok()); assert.equal((await checked.json()).result?.authenticated, true, 'Service fresh inference failed');
    results.sharedTerminalAuthFreshServiceInference = true;
    await page.request.post(`${base}/api/chat/install/welcome-complete`, { headers, data: {} });
    const created = await page.request.post(`${base}/api/chat/conversations`, { headers, data: { title: 'macOS native fixture', workingDir: workspace,
      cliProfileId: profile.id, model: 'claude-sonnet-4-6', effort: 'low' } });
    assert.ok(created.ok()); const conversation = await created.json();
    const read = async () => (await page.request.get(`${base}/api/chat/conversations/${conversation.id}`)).json();
    const open = async () => { await page.goto(`${base}/v2/`); await page.getByLabel('Workspace filter').selectOption(conversation.workspaceId);
      await page.locator(`.sb-row[data-conv-id="${conversation.id}"]`).click(); };
    const marker = `MACOS_${crypto.randomBytes(8).toString('hex')}`;
    const send = async (text: string) => { const composer = page.locator('.composer'); await composer.locator('textarea').fill(text);
      await composer.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.msg-agent').last()).toContainText(marker); await composer.getByRole('button', { name: 'Send', exact: true }).waitFor(); };
    stage('desktop-chat'); await open();
    await send(`Remember ${marker}. Use native write to create startup-proof.txt containing exactly ${marker}. Return exactly ${marker}. Do no other work.`);
    assert.equal((await fs.readFile(path.join(workspace, 'startup-proof.txt'), 'utf8')).trimEnd(), marker);
    const before = await read(); assert.ok(before.externalSessionId); assert.ok(before.sessionUsage.inputTokens + before.sessionUsage.outputTokens > 0);
    const children = await remember(firstPid);
    const commands = await Promise.all(children.map(async child => ({ pid: child.pid,
      command: (await exec('/bin/ps', ['-p', String(child.pid), '-o', 'comm=']).catch(() => ({ stdout: '' }))).stdout.trim() })));
    const nativePids = commands.filter(child => path.basename(child.command) === 'cortex').map(child => child.pid);
    assert.ok(nativePids.length > 0, 'Native Cortex descendants were not observed');
    for (const child of commands.filter(child => nativePids.includes(child.pid))) {
      assert.equal(await fs.realpath(child.command), executableBefore, 'A different distribution is executing');
    }
    results.nativeDescendantsObserved = nativePids.length;
    results.observedNativeDistribution = distribution;
    results.nativeDesktopWriteAndUsage = true;
    stage('pm2-restart'); await pm2(['restart', 'agent-cockpit']); await ready();
    const secondPid = await serverPid(); assert.notEqual(secondPid, firstPid);
    const alive = await table(); assert.ok(!alive.some(row => observed.get(row.pid)?.started === row.started), 'Old server/native process survived restart');
    results.restartDrainedObservedProcesses = true;
    await open(); await send('Return only the exact marker I asked you to remember. Do not use tools.');
    const after = await read(); assert.equal(after.externalSessionId, before.externalSessionId);
    assert.equal(after.messages.filter((message: { role: string; turn?: string }) => message.role === 'assistant' && message.turn === 'final').length, 2);
    assert.equal(after.messages.filter((message: { role: string; turn?: string }) => message.role === 'assistant' && message.turn === 'final').at(-1).content.trim(), marker);
    await remember(secondPid); results.nativeSessionResumeAfterPm2Restart = true;
    stage('stop');
    const composer = page.locator('.composer');
    await composer.locator('textarea').fill('Use the native shell tool to run exactly: echo $$ > stop.pid; sleep 30; echo LATE > stop-finished.txt. Do no other work.');
    await composer.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => Boolean(await fs.stat(path.join(workspace, 'stop.pid')).catch(() => null))).toBe(true);
    const shellPid = Number(await fs.readFile(path.join(workspace, 'stop.pid'), 'utf8')); assert.ok(shellPid > 0);
    await remember(secondPid);
    await page.getByLabel('Stop agent', { exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(`${base}/api/chat/active-streams`)).json()).ids.includes(conversation.id)).toBe(false);
    await expect.poll(() => { try { process.kill(shellPid, 0); return false; } catch { return true; } }).toBe(true);
    await assert.rejects(fs.access(path.join(workspace, 'stop-finished.txt')));
    assert.equal((await read()).messages.filter((message: { role: string }) => message.role === 'user').length, 3);
    results.nativeStopDrainsShellWithoutReplay = true;
    results.passed = true; delete results.stage;
  } catch (error) {
    results.error = error instanceof Error ? error.name : 'Unknown error';
    await fs.writeFile(path.join(root, 'failure.txt'), String(error instanceof Error ? error.stack : error), { mode: 0o600 });
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline); await browser?.close();
    if (loaded) {
      const state = await exec('/bin/launchctl', ['print', `gui/${process.getuid!()}/${label}`]).catch(() => ({ stdout: 'unavailable' }));
      await fs.writeFile(path.join(root, 'launch-agent-state.txt'), state.stdout, { mode: 0o600 });
    }
    if (loaded) await exec('/bin/launchctl', ['bootout', `gui/${process.getuid!()}/${label}`]).catch(() => { results.launchAgentUnloadFailed = true; });
    if (await fs.stat(path.join(pm2Home, 'pm2.pid')).catch(() => null)) {
      await exec(process.execPath, [path.join(current, 'node_modules/pm2/bin/pm2'), 'kill'], { cwd: current, env: { ...process.env, PM2_HOME: pm2Home }, timeout: 30000 })
        .catch(() => { results.pm2CleanupFailed = true; });
    }
    const alive = await table();
    results.observedProcessesGone = !alive.some(row => observed.get(row.pid)?.started === row.started);
    results.normalExecutableUnchanged = await fs.realpath(sourceRuntime.command) === executableBefore && (await fs.stat(executableBefore)).mtimeMs === executableStat.mtimeMs;
    results.launchAgentRemoved = !results.launchAgentUnloadFailed;
    await fs.rm(plist, { force: true });
    if (!results.observedProcessesGone || !results.normalExecutableUnchanged || results.launchAgentUnloadFailed || results.pm2CleanupFailed) { results.passed = false; process.exitCode = 1; }
    if (results.passed) {
      try {
        await fs.copyFile(path.join(data, 'install.json'), path.join(root, 'install-manifest.json'));
        await fs.rm(install, { recursive: true, force: true });
        await fs.rm(pm2Home, { recursive: true, force: true });
        results.disposableInstallationAndPm2StateRemoved = true;
      } catch { results.passed = false; results.installationRemovalFailed = true; process.exitCode = 1; }
    }
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Cortex macOS acceptance ${results.passed ? 'passed' : 'failed'}: ${path.join(root, 'report.json')}\n`);
  }
}
void main().catch(error => { process.stderr.write(`Cortex macOS probe failed (${error instanceof Error ? error.name : 'unknown'}).\n`); process.exitCode = 1; });
