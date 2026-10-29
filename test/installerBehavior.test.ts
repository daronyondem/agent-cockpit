import fs from 'fs';
import path from 'path';
import http from 'http';
import net from 'net';
import { spawnSync } from 'child_process';
import { installerFixture, runPosix, runPowerShell, type InstallerFixture } from './helpers/installerFixture';
import { InstallStateService } from '../src/services/installStateService';

// Allow sequential 60-second fixture commands to finish before test cleanup.
jest.setTimeout(240_000);

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

let fixture: InstallerFixture;
let port: number;
beforeEach(async () => {
  fixture = installerFixture();
  port = await unusedPort();
  fixture.env.FIXTURE_PORT = String(port);
});
afterEach(() => fixture?.cleanup());

test('fixture commands distinguish installer exit codes from spawn failures', async () => {
  expect(await fixture.run(process.execPath, ['-e', 'process.exit(7)'])).toMatchObject({ code: 7 });
  await expect(fixture.run(path.join(fixture.root, 'missing-command'), [])).rejects.toMatchObject({ code: 'ENOENT' });
});

(process.platform === 'win32' ? test.skip : test)('fixture commands reject terminated processes', async () => {
  await expect(fixture.run(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']))
    .rejects.toMatchObject({ signal: 'SIGTERM' });
});

const posix = process.platform === 'win32' ? describe.skip : describe;
posix.each(['macos', 'linux'] as const)('%s executable installer behavior', platform => {
  const registerStartup = platform === 'macos' ? 'register_login_startup' : 'register_user_startup';
  const startupFile = () => platform === 'macos'
    ? path.join(fixture.env.HOME, 'Library/LaunchAgents/com.agent-cockpit.server.plist')
    : path.join(fixture.env.XDG_CONFIG_HOME, 'systemd/user/agent-cockpit.service');
  async function createStartup(installDir: string) {
    const result = await runPosix(fixture, platform, `INSTALL_DIR="$FIXTURE_STARTUP_INSTALL"\nAUTO_START=true\n${registerStartup}`, { FIXTURE_STARTUP_INSTALL: installDir });
    expect(result).toMatchObject({ code: 0 });
    return fs.readFileSync(startupFile(), 'utf8');
  }
  const install = `
prepare_install
capture_existing_install
wait_for_server() { if [[ "\${FIXTURE_FAILURE:-}" == health ]]; then fail "Fixture health failure"; fi; }
install_production
`;
  test('installs production assets without mobile build dependencies', async () => {
    const result = await runPosix(fixture, platform, install);
    expect(result).toMatchObject({ code: 0 });
    const state = JSON.parse(fs.readFileSync(path.join(fixture.install, 'data/install.json'), 'utf8'));
    expect(state).toMatchObject({ version: '1.2.3', startup: { kind: 'manual' } });
    expect(fs.readFileSync(path.join(state.appDir, 'public/mobile-built/index.html'), 'utf8')).toContain('mobile');
    expect(fs.readFileSync(path.join(fixture.root, 'commands'), 'utf8')).not.toContain('--prefix');
    const env = fs.readFileSync(path.join(state.appDir, '.env'), 'utf8');
    const secret = env.match(/^SESSION_SECRET=(.*)$/m)![1];
    expect(fs.readFileSync(path.join(fixture.install, 'logs/install.log'), 'utf8')).not.toContain(secret);
  });

  test('repairs the same version without replacing secrets, data, or onboarding state', async () => {
    const { previous, state } = fixture.seed();
    const result = await runPosix(fixture, platform, install);
    expect(result).toMatchObject({ code: 0 });
    const saved = JSON.parse(fs.readFileSync(path.join(fixture.install, 'data/install.json'), 'utf8'));
    expect(saved).toMatchObject({ installedAt: state.installedAt, welcomeCompletedAt: state.welcomeCompletedAt });
    const env = fs.readFileSync(path.join(saved.appDir, '.env'), 'utf8');
    expect(env).toContain('SESSION_SECRET=keep-session');
    expect(env).toContain('AUTH_SETUP_TOKEN=keep-setup');
    expect(env).toContain('CUSTOM_SETTING=keep-custom');
    expect(fs.existsSync(previous)).toBe(true);
    expect(fs.readFileSync(path.join(fixture.install, 'data/owner-fixture.json'), 'utf8')).toBe('owner-data');
  });

  test.each(['dependency', 'startup', 'health'])('keeps the previous release after %s failure', async failure => {
    const { previous, state } = fixture.seed();
    const bin = path.join(fixture.install, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'start-agent-cockpit.sh'), 'previous helper');
    const startup = await createStartup(fixture.install);
    const result = await runPosix(fixture, platform, install, { FIXTURE_FAILURE: failure });
    expect(result.code).not.toBe(0);
    expect(fs.realpathSync(path.join(fixture.install, 'current'))).toBe(previous);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.install, 'data/install.json'), 'utf8'))).toEqual(state);
    expect(fs.readFileSync(path.join(bin, 'start-agent-cockpit.sh'), 'utf8')).toBe('previous helper');
    expect(fs.readFileSync(startupFile(), 'utf8')).toBe(startup);
    expect(fs.readdirSync(path.join(fixture.install, 'releases'))).toEqual(['previous']);
  });

  test.each(['manual', 'automatic'])('preserves foreign startup entries during %s registration', async mode => {
    const original = await createStartup(path.join(fixture.root, 'production install'));
    fs.unlinkSync(path.join(fixture.root, 'commands'));
    const result = await runPosix(fixture, platform, `AUTO_START=${mode === 'manual' ? 'false' : 'true'}\n${registerStartup}`);
    expect(result.code === 0).toBe(mode === 'manual');
    expect(fs.readFileSync(startupFile(), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(fixture.root, 'commands'))).toBe(false);
  });

  test('does not unload or disable foreign startup entries during rollback', async () => {
    fixture.seed();
    const original = await createStartup(path.join(fixture.root, 'production install'));
    fs.unlinkSync(path.join(fixture.root, 'commands'));
    const result = await runPosix(fixture, platform, install, { FIXTURE_FAILURE: 'health' });
    expect(result.code).not.toBe(0);
    expect(fs.readFileSync(startupFile(), 'utf8')).toBe(original);
    const commands = fs.readFileSync(path.join(fixture.root, 'commands'), 'utf8');
    expect(commands.split('\n').filter(line => /^(launchctl|systemctl) /.test(line))).toEqual([]);
  });

  test('normalizes restored ports before writing environment and runtime config', async () => {
    const { previous } = fixture.seed();
    fs.writeFileSync(path.join(previous, '.env'), `PORT=0${port}\n`);
    const result = await runPosix(fixture, platform, `
prepare_install
PORT_EXPLICIT=false
capture_existing_install
wait_for_server() { :; }
install_production
`);
    expect(result).toMatchObject({ code: 0 });
    const current = path.join(fixture.install, 'current');
    expect(fs.readFileSync(path.join(current, '.env'), 'utf8')).toContain(`PORT=${port}\n`);
    const config = await fixture.run(process.execPath, ['-p', 'require(process.argv[1]).apps[0].env.PORT', path.join(current, 'ecosystem.config.js')]);
    expect(config).toMatchObject({ code: 0 });
    expect(Number(config.stdout.trim())).toBe(port);
  });

  test('removes candidates from repeated preparation failures', async () => {
    fixture.seed();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await runPosix(fixture, platform, install, { FIXTURE_FAILURE: 'dependency' })).code).not.toBe(0);
    }
    expect(fs.readdirSync(path.join(fixture.install, 'releases'))).toEqual(['previous']);
  });

  test('retains the candidate when rollback cannot restore the active pointer', async () => {
    fixture.seed();
    const result = await runPosix(fixture, platform, `
switch_current() {
  if [[ "$1" == "$PREVIOUS_APP_DIR" ]]; then return 1; fi
  rm -f "$INSTALL_DIR/current"
  ln -s "$1" "$INSTALL_DIR/current"
}
${install}
`, { FIXTURE_FAILURE: 'health' });
    expect(result.code).not.toBe(0);
    const active = fs.realpathSync(path.join(fixture.install, 'current'));
    expect(fs.existsSync(path.join(active, 'server.ts'))).toBe(true);
    expect(fs.readdirSync(path.join(fixture.install, 'releases'))).toHaveLength(2);
  });

  test('retains a failed candidate when stopping its process cannot be confirmed', async () => {
    fixture.seed();
    const result = await runPosix(fixture, platform, `
npx() { if [[ "$*" == 'pm2 delete agent-cockpit' ]]; then return 7; fi; }
${install}
`, { FIXTURE_FAILURE: 'health' });
    expect(result.code).not.toBe(0);
    expect(fs.readdirSync(path.join(fixture.install, 'releases'))).toHaveLength(2);
  });

  test('uses the saved port when no explicit port was supplied', async () => {
    const { previous } = fixture.seed();
    fs.writeFileSync(path.join(previous, '.env'), `PORT=${port}\n`);
    const result = await runPosix(fixture, platform, 'prepare_install\nPORT_EXPLICIT=false\ncapture_existing_install\nprintf "saved-port=%s" "$PORT"');
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain(`saved-port=${port}`);
  });

  test.each(['0', '65536'])('rejects invalid port %s before bootstrap', async invalid => {
    const result = await fixture.run('bash', [path.join(process.cwd(), `scripts/install-${platform}.sh`), '--port', invalid]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('1 to 65535');
    expect(fs.readdirSync(fixture.install)).toEqual([]);
  });

  test('rejects an unwritable install path before activation', async () => {
    fs.writeFileSync(path.join(fixture.root, 'not-a-directory'), 'file');
    const result = await runPosix(fixture, platform, 'INSTALL_DIR="$FIXTURE_ROOT/not-a-directory/child"\nprepare_install');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('not writable');
  });

  test('leaves the active release intact when a download fails', async () => {
    const { previous } = fixture.seed();
    fs.unlinkSync(path.join(fixture.release, 'agent-cockpit-v1.2.3.tar.gz'));
    const result = await runPosix(fixture, platform, install);
    expect(result.code).not.toBe(0);
    expect(fs.realpathSync(path.join(fixture.install, 'current'))).toBe(previous);
    expect(fs.existsSync(path.join(fixture.root, 'commands'))).toBe(false);
    expect(fs.readdirSync(fixture.install).filter(name => name.startsWith('.install-'))).toEqual([]);
  });

  test.each(['old-node', 'broken-npm'])('falls back to private Node for %s', async scenario => {
    const result = await runPosix(fixture, platform, `
node() { if [[ "$FIXTURE_RUNTIME" == old-node ]]; then printf '20'; else "$FIXTURE_NODE" "$@"; fi; }
npm() { return 1; }
install_private_node() { printf 'private-fallback'; }
ensure_node
`, { FIXTURE_RUNTIME: scenario });
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain('private-fallback');
  });

  test('removes incomplete activation after a failed first start', async () => {
    const result = await runPosix(fixture, platform, install, { FIXTURE_FAILURE: 'health' });
    expect(result.code).not.toBe(0);
    expect(fs.existsSync(path.join(fixture.install, 'current'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.install, 'data/install.json'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.install, 'bin/start-agent-cockpit.sh'))).toBe(false);
  });

  test('installs mobile build dependencies only when prebuilt mobile assets are missing', async () => {
    fs.unlinkSync(path.join(fixture.source, 'public/mobile-built/index.html'));
    const result = await runPosix(fixture, platform, 'install_dependencies "$FIXTURE_ROOT/source"');
    expect(result).toMatchObject({ code: 0 });
    expect(fs.readFileSync(path.join(fixture.root, 'commands'), 'utf8')).toContain('--prefix mobile/AgentCockpitPWA ci');
  });

  test('rejects a corrupt archive before activation', async () => {
    const { previous } = fixture.seed();
    fs.appendFileSync(path.join(fixture.release, 'agent-cockpit-v1.2.3.tar.gz'), 'corrupt');
    const result = await runPosix(fixture, platform, install);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Checksum mismatch');
    expect(fs.realpathSync(path.join(fixture.install, 'current'))).toBe(previous);
    expect(fs.existsSync(path.join(fixture.root, 'commands'))).toBe(false);
  });

  test('rejects a manifest that does not match the explicitly requested release', async () => {
    const result = await runPosix(fixture, platform, `VERSION=9.9.9\n${install}`);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Release version mismatch');
    expect(fs.existsSync(path.join(fixture.root, 'commands'))).toBe(false);
  });

  if (platform === 'macos') {
    test('activates RunAtLoad startup only after the runtime has started', async () => {
      const result = await runPosix(fixture, platform, `
prepare_install
capture_existing_install
AUTO_START=true
start_pm2() { touch "$FIXTURE_ROOT/runtime-started"; }
activate_login_startup() {
  [[ -f "$FIXTURE_ROOT/runtime-started" ]] || fail 'Runtime not started'
  touch "$FIXTURE_ROOT/startup-activated"
}
wait_for_server() { :; }
install_production
`);
      expect(result).toMatchObject({ code: 0 });
      expect(fs.existsSync(path.join(fixture.root, 'startup-activated'))).toBe(true);
    });

    test('keeps a ready installation when the optional browser cannot open', async () => {
      const result = await runPosix(fixture, platform, 'OPEN_BROWSER=true\nopen() { return 1; }\nopen_setup');
      expect(result).toMatchObject({ code: 0 });
      expect(result.stdout).toContain('Open http://localhost:');
    });
  }

  test('rejects another application on the requested port', async () => {
    const server = http.createServer((_req, res) => res.end('<html>unrelated</html>'));
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      const result = await runPosix(fixture, platform, 'prepare_install\ncapture_existing_install');
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('already used');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('recognizes a legacy symlink path for the same running installation', async () => {
    fixture.seed();
    const alias = path.join(fixture.root, 'install alias');
    fs.symlinkSync(fixture.install, alias);
    const server = http.createServer((_req, res) => res.end(JSON.stringify({ installDir: alias })));
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      const result = await runPosix(fixture, platform, 'prepare_install\ncapture_existing_install');
      expect(result).toMatchObject({ code: 0 });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test.each(['owned', 'wrong-port', 'wrong-directory', 'dead-process'])('checks PM2 ownership during corrupt-manifest repair: %s', async ownership => {
    const { previous, state } = fixture.seed();
    fs.writeFileSync(path.join(state.dataDir, 'install.json'), '{broken');
    const process = fixture.mockPm2(previous, port);
    if (ownership === 'wrong-port') process.pm2_env.PORT = port + 1;
    if (ownership === 'wrong-directory') process.pm2_env.pm_cwd = fixture.source;
    if (ownership === 'dead-process') process.pid = -1;
    fixture.env.FIXTURE_PM2_JSON = JSON.stringify([process]);
    const service = new InstallStateService({ appRoot: previous, dataRoot: state.dataDir });
    const server = http.createServer((_req, res) => res.end(JSON.stringify(service.getStatus())));
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      const result = await runPosix(fixture, platform, 'prepare_install\ncapture_existing_install');
      expect(result.code === 0).toBe(ownership === 'owned');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('does not start a daemon when a stale PM2 PID points to an unrelated live process', async () => {
    const { previous } = fixture.seed();
    fixture.mockPm2(previous, port);
    fixture.env.FIXTURE_PM2_UNAVAILABLE = '1';
    fixture.env.FIXTURE_PM2_JSON = '[]';
    fixture.env.FIXTURE_PM2_QUERY_MARKER = path.join(fixture.root, 'daemon-started');
    const server = http.createServer((_req, res) => res.end('{}'));
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      const result = await runPosix(fixture, platform, 'prepare_install\ncapture_existing_install');
      expect(result.code).not.toBe(0);
      expect(fs.existsSync(fixture.env.FIXTURE_PM2_QUERY_MARKER)).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('persists PM2_HOME for helpers launched without the installer environment', async () => {
    fs.mkdirSync(path.join(fixture.install, 'app'));
    const result = await runPosix(fixture, platform, `
write_helper_scripts "$INSTALL_DIR/app" "$PATH"
npx() { printf '%s\\n' "\${PM2_HOME:-default}" >> "$FIXTURE_ROOT/helper-homes"; }
export -f npx
env -u PM2_HOME bash "$INSTALL_DIR/bin/start-agent-cockpit.sh"
env -u PM2_HOME bash "$INSTALL_DIR/bin/stop-agent-cockpit.sh"
`);
    expect(result).toMatchObject({ code: 0 });
    const homes = fs.readFileSync(path.join(fixture.root, 'helper-homes'), 'utf8').trim().split('\n');
    expect(new Set(homes)).toEqual(new Set([fixture.env.PM2_HOME]));
  });

  test.each(['wrong-version', 'invalid-json', 'correct-version'])('checks release readiness: %s', async response => {
    const server = http.createServer((req, res) => {
      res.end(req.url === '/api/chat/version'
        ? response === 'invalid-json' ? '<html>not JSON</html>' : JSON.stringify({ version: response === 'correct-version' ? '1.2.3' : '1.0.0' })
        : '<html>setup</html>');
    });
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      const result = await runPosix(fixture, platform, 'wait_for_server "$FIXTURE_INSTALL" 1.2.3 1');
      expect(result.code === 0).toBe(response === 'correct-version');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const hasPowerShell = !spawnSync(shell, ['-NoProfile', '-Command', 'exit 0']).error;
(hasPowerShell ? describe : describe.skip)('PowerShell executable installer behavior', () => {
  const install = `
function Wait-ForServer { if ($env:FIXTURE_FAILURE -eq 'health') { throw 'Fixture health failure' } }
$InstallLog = Join-Path $InstallDir 'install.log'
Install-Production
`;
  test('installs prebuilt production assets without mobile dependencies', async () => {
    const result = await runPowerShell(fixture, install);
    expect(result).toMatchObject({ code: 0 });
    const state = JSON.parse(fs.readFileSync(path.join(fixture.install, 'data/install.json'), 'utf8'));
    expect(state).toMatchObject({ version: '1.2.3', startup: { kind: 'manual' } });
    expect(fs.readFileSync(path.join(fixture.root, 'commands'), 'utf8')).not.toContain('--prefix');
    expect(fs.readFileSync(path.join(fixture.install, 'install.log'), 'utf8')).not.toContain('First-run setup token');
  });

  test.each(['dependency', 'startup', 'health'])('preserves the prior installation after %s failure', async failure => {
    const { previous, state } = fixture.seed();
    const result = await runPowerShell(fixture, install, { FIXTURE_FAILURE: failure });
    expect(result.code).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.install, 'data/install.json'), 'utf8'))).toEqual(state);
    expect(fs.existsSync(previous)).toBe(true);
    expect(fs.readdirSync(path.join(fixture.install, 'releases'))).toEqual(['previous']);
  });

  test('cleans repeated Windows preparation failures without removing the previous release', async () => {
    fixture.seed();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await runPowerShell(fixture, install, { FIXTURE_FAILURE: 'dependency' })).code).not.toBe(0);
    }
    expect(fs.readdirSync(path.join(fixture.install, 'releases'))).toEqual(['previous']);
  });

  test('retains a Windows candidate still referenced after metadata restoration fails', async () => {
    fixture.seed();
    const result = await runPowerShell(fixture, `
function Wait-ForServer {
  function script:Copy-Item { throw 'Fixture metadata restore failure' }
  throw 'Fixture health failure'
}
Install-Production
`);
    expect(result.code).not.toBe(0);
    const selected = JSON.parse(fs.readFileSync(path.join(fixture.install, 'data/install.json'), 'utf8'));
    expect(fs.existsSync(path.join(selected.appDir, 'server.ts'))).toBe(true);
    expect(fs.readdirSync(path.join(fixture.install, 'releases'))).toHaveLength(2);
  });

  test('retains a Windows candidate when process stop cannot be confirmed', async () => {
    fixture.seed();
    const result = await runPowerShell(fixture, `
function Invoke-Pm2BestEffort {
  param([string] $AppDir, [string[]] $Arguments, [switch] $PassThru)
  if ($PassThru) { return $false }
}
${install}
`, { FIXTURE_FAILURE: 'health' });
    expect(result.code).not.toBe(0);
    expect(fs.readdirSync(path.join(fixture.install, 'releases'))).toHaveLength(2);
  });

  test('preserves custom config, secrets, and completed onboarding on repair', async () => {
    fixture.seed();
    const result = await runPowerShell(fixture, install);
    expect(result).toMatchObject({ code: 0 });
    const state = JSON.parse(fs.readFileSync(path.join(fixture.install, 'data/install.json'), 'utf8'));
    expect(state.welcomeCompletedAt).toBe('2025-01-02');
    const env = fs.readFileSync(path.join(state.appDir, '.env'), 'utf8');
    expect(env).toContain('keep-session');
    expect(env).toContain('keep-setup');
    expect(env).toContain('CUSTOM_SETTING=keep-custom');
  });

  test('rejects corrupted ZIP bytes before installing dependencies', async () => {
    fs.appendFileSync(path.join(fixture.release, 'agent-cockpit-v1.2.3.zip'), 'corrupt');
    const result = await runPowerShell(fixture, install);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Checksum mismatch');
    expect(fs.existsSync(path.join(fixture.root, 'commands'))).toBe(false);
  });

  test('rejects a manifest that differs from the requested release', async () => {
    const result = await runPowerShell(fixture, `$Version = '9.9.9'\n${install}`);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Release version mismatch');
  });

  test('does not undo a ready install when browser opening fails', async () => {
    const result = await runPowerShell(fixture, `
$SkipOpen = $false
function Start-Process { throw 'No browser' }
Open-Setup 'synthetic-setup-token'
`);
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain('Open http://localhost:');
  });

  test.each(['wrong-version', 'invalid-json', 'missing-version', 'correct-version'])('checks native JSON readiness: %s', async response => {
    const server = http.createServer((req, res) => {
      res.end(req.url === '/api/chat/version'
        ? response === 'invalid-json' ? '<html>not JSON</html>' : response === 'missing-version' ? '{}' : JSON.stringify({ version: response === 'correct-version' ? '1.2.3' : '1.0.0' })
        : '<html>setup</html>');
    });
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      const result = await runPowerShell(fixture, 'Wait-ForServer $InstallDir 1.2.3 1');
      expect(result.code === 0).toBe(response === 'correct-version');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('fails clearly when Node is missing and automatic installation is disabled', async () => {
    const result = await runPowerShell(fixture, `
$NoInstallNode = $true
function Command-Path { return $null }
Resolve-Node
`);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Node.js 22+ and npm are required');
  });

  test('rejects an unrelated service on the requested port', async () => {
    const server = http.createServer((_req, res) => res.end('{}'));
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      const result = await runPowerShell(fixture, 'Test-InstallPreflight');
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('already used');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('leaves a different installation startup task unchanged during install and rollback', async () => {
    const result = await runPowerShell(fixture, `
$script:FixtureTask = [pscustomobject]@{ Actions = @([pscustomobject]@{ Arguments = '-File "C:\\OtherInstall\\bin\\start-agent-cockpit.ps1"' }) }
function Get-ScheduledTask { return $script:FixtureTask }
function Export-ScheduledTask { Add-Content (Join-Path $env:FIXTURE_ROOT 'task-mutated') 'export'; return '<Task/>' }
function Unregister-ScheduledTask { Add-Content (Join-Path $env:FIXTURE_ROOT 'task-mutated') 'delete' }
function Register-ScheduledTask { Add-Content (Join-Path $env:FIXTURE_ROOT 'task-mutated') 'replace' }
Save-Activation
Register-LogonTask
Restore-Activation $InstallDir
`);
    expect(result).toMatchObject({ code: 0 });
    expect(fs.existsSync(path.join(fixture.root, 'task-mutated'))).toBe(false);
  });

  test('removes its own startup task when manual startup is selected', async () => {
    const result = await runPowerShell(fixture, `
$start = Join-Path $InstallDir 'bin/start-agent-cockpit.ps1'
$script:FixtureTask = [pscustomobject]@{ Actions = @([pscustomobject]@{ Arguments = ('-File "' + $start + '"') }) }
function Get-ScheduledTask { return $script:FixtureTask }
function Unregister-ScheduledTask { Add-Content (Join-Path $env:FIXTURE_ROOT 'task-mutated') 'delete' }
Register-LogonTask
`);
    expect(result).toMatchObject({ code: 0 });
    expect(fs.readFileSync(path.join(fixture.root, 'task-mutated'), 'utf8')).toContain('delete');
  });

  test.each(['present', 'missing'])('recognizes its Windows task through an alias with the helper %s', async helper => {
    const bin = path.join(fixture.install, 'bin');
    fs.mkdirSync(bin);
    if (helper === 'present') fs.writeFileSync(path.join(bin, 'start-agent-cockpit.ps1'), 'fixture');
    const alias = path.join(fixture.root, 'same install alias');
    fs.symlinkSync(fixture.install, alias, 'junction');
    const result = await runPowerShell(fixture, `
$start = Join-Path $env:FIXTURE_ALIAS 'bin/start-agent-cockpit.ps1'
$script:FixtureTask = [pscustomobject]@{ Actions = @([pscustomobject]@{ Arguments = ('-File "' + $start + '"') }) }
function Get-ScheduledTask { return $script:FixtureTask }
function Unregister-ScheduledTask { Add-Content (Join-Path $env:FIXTURE_ROOT 'task-mutated') 'delete' }
Register-LogonTask
`, { FIXTURE_ALIAS: alias });
    expect(result).toMatchObject({ code: 0 });
    expect(fs.readFileSync(path.join(fixture.root, 'task-mutated'), 'utf8')).toContain('delete');
  });

  test('refuses to replace a startup task owned by a different installation', async () => {
    const result = await runPowerShell(fixture, `
$NoAutoStart = $false
function Get-ScheduledTask { return [pscustomobject]@{ Actions = @([pscustomobject]@{ Arguments = '-File "C:\\OtherInstall\\start.ps1"' }) } }
function Register-ScheduledTask { Add-Content (Join-Path $env:FIXTURE_ROOT 'task-mutated') 'replace' }
Register-LogonTask
`);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('belongs to another');
    expect(fs.existsSync(path.join(fixture.root, 'task-mutated'))).toBe(false);
  });

  test.each(['task', 'files'])('still restarts the previous app when restoring %s fails', async failure => {
    const { previous } = fixture.seed();
    const result = await runPowerShell(fixture, `
$PreviousAppDir = $env:FIXTURE_PREVIOUS
Set-Content (Join-Path $WorkDir 'startup.xml') '<Task/>'
Set-Content (Join-Path $WorkDir 'install.json') '{}'
function Register-ScheduledTask { throw 'Fixture task restore failure' }
${failure === 'files' ? "function Copy-Item { throw 'Fixture file restore failure' }" : ''}
Restore-Activation $InstallDir
`, { FIXTURE_PREVIOUS: previous });
    expect(result.code === 0).toBe(failure === 'task');
    expect(fs.readFileSync(path.join(fixture.root, 'commands'), 'utf8')).toContain(`start ${previous}`);
    if (failure === 'task') expect(result.stdout).toContain('Fixture task restore failure');
  });

  test.each(['owned', 'wrong-port', 'wrong-directory', 'dead-process'])('checks Windows PM2 ownership when a corrupt manifest hides its app: %s', async ownership => {
    const { previous, state } = fixture.seed();
    fs.writeFileSync(path.join(state.dataDir, 'install.json'), '{broken');
    const process = fixture.mockPm2(previous, port);
    if (ownership === 'wrong-port') process.pm2_env.PORT = port + 1;
    if (ownership === 'wrong-directory') process.pm2_env.pm_cwd = fixture.source;
    if (ownership === 'dead-process') process.pid = -1;
    fixture.env.FIXTURE_PM2_JSON = JSON.stringify([process]);
    const service = new InstallStateService({ appRoot: previous, dataRoot: state.dataDir });
    const server = http.createServer((_req, res) => res.end(JSON.stringify(service.getStatus())));
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      const result = await runPowerShell(fixture, 'Test-InstallPreflight\nWrite-Output "recovered=$PreviousAppDir"');
      expect(result.code === 0).toBe(ownership === 'owned');
      if (ownership === 'owned') expect(result.stdout).toContain(`recovered=${previous}`);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('recognizes a Windows installation reported through a directory alias', async () => {
    fixture.seed();
    const alias = path.join(fixture.root, 'install alias');
    fs.symlinkSync(fixture.install, alias, 'junction');
    const server = http.createServer((_req, res) => res.end(JSON.stringify({ installDir: alias })));
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      expect(await runPowerShell(fixture, 'Test-InstallPreflight')).toMatchObject({ code: 0 });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('prepares an existing dev app without copying its env file onto itself through an alias', async () => {
    const { previous } = fixture.seed();
    const alias = path.join(fixture.root, 'dev alias');
    fs.symlinkSync(previous, alias, 'junction');
    const result = await runPowerShell(fixture, `
$PreviousAppDir = $env:FIXTURE_ALIAS
$Channel = 'dev'
Prepare-App $env:FIXTURE_PREVIOUS (Join-Path $InstallDir 'data') $true
`, { FIXTURE_ALIAS: alias, FIXTURE_PREVIOUS: previous });
    expect(result).toMatchObject({ code: 0 });
    expect(fs.readFileSync(path.join(previous, '.env'), 'utf8')).toContain('SESSION_SECRET=keep-session');
    expect(fs.readFileSync(path.join(previous, '.env'), 'utf8')).toContain('CUSTOM_SETTING=keep-custom');
  });

  test('does not start a Windows PM2 daemon from a reused PID during rejected preflight', async () => {
    const { previous } = fixture.seed();
    fixture.mockPm2(previous, port);
    fixture.env.FIXTURE_PM2_UNAVAILABLE = '1';
    fixture.env.FIXTURE_PM2_JSON = '[]';
    fixture.env.FIXTURE_PM2_QUERY_MARKER = path.join(fixture.root, 'daemon-started');
    const server = http.createServer((_req, res) => res.end('{}'));
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      expect((await runPowerShell(fixture, 'Test-InstallPreflight')).code).not.toBe(0);
      expect(fs.existsSync(fixture.env.FIXTURE_PM2_QUERY_MARKER)).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
