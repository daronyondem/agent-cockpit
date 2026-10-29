import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

export function installerFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-installer-')));
  const source = path.join(root, 'source');
  const release = path.join(root, 'release');
  const install = path.join(root, 'install with spaces');
  const write = (name: string, value: string) => {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  write('package.json', JSON.stringify({ name: 'agent-cockpit', version: '1.2.3', engines: { node: '>=22' } }));
  write('package-lock.json', '{}');
  for (const dir of ['docs', 'mobile', 'src', 'web']) fs.mkdirSync(path.join(source, dir), { recursive: true });
  write('server.ts', 'export {};\n');
  write('public/v2-built/index.html', '<html>desktop</html>');
  write('public/mobile-built/index.html', '<html>mobile</html>');
  for (const name of ['install-macos.sh', 'install-linux.sh', 'install-windows.ps1']) {
    write(`scripts/${name}`, fs.readFileSync(path.join(process.cwd(), 'scripts', name), 'utf8'));
  }
  try {
    execFileSync(process.execPath, [
      'scripts/package-release.js', '--root', source, '--version', '1.2.3', '--out-dir', release,
    ], { stdio: 'pipe', timeout: 60_000 });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  fs.mkdirSync(install, { recursive: true });

  const env = {
    ...process.env,
    AGENT_COCKPIT_INSTALL_LIBRARY_ONLY: '1',
    AGENT_COCKPIT_INSTALL_TEST_RELEASE_DIR: release,
    FIXTURE_ROOT: root,
    FIXTURE_INSTALL: install,
    FIXTURE_NODE: process.execPath,
    FIXTURE_PORT: '',
    FIXTURE_PM2_JSON: '',
    FIXTURE_PM2_UNAVAILABLE: '',
    FIXTURE_PM2_QUERY_MARKER: '',
    PM2_HOME: path.join(install, 'pm2'),
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
  };
  fs.mkdirSync(env.HOME, { recursive: true });

  async function run(command: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
    try {
      const result = await exec(command, args, { env: { ...env, ...extra }, timeout: 60_000 });
      return { ...result, code: 0 };
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string; code?: number | string; signal?: NodeJS.Signals; killed?: boolean };
      if (result.killed || result.signal || typeof result.code !== 'number') throw error;
      return { stdout: result.stdout || '', stderr: result.stderr || result.message, code: result.code };
    }
  }

  function seed() {
    const previous = path.join(install, 'releases', 'previous');
    fs.mkdirSync(previous, { recursive: true });
    fs.writeFileSync(path.join(previous, '.env'), 'PORT=3334\nSESSION_SECRET=keep-session\nAUTH_SETUP_TOKEN=keep-setup\nCUSTOM_SETTING=keep-custom\n');
    const state = {
      schemaVersion: 1, channel: 'production', source: 'github-release', version: '1.2.3',
      installDir: install, appDir: process.platform === 'win32' ? previous : path.join(install, 'current'),
      dataDir: path.join(install, 'data'), installedAt: '2025-01-01', welcomeCompletedAt: '2025-01-02',
    };
    fs.mkdirSync(state.dataDir, { recursive: true });
    fs.writeFileSync(path.join(state.dataDir, 'install.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(state.dataDir, 'owner-fixture.json'), 'owner-data');
    if (process.platform !== 'win32') fs.symlinkSync(previous, state.appDir);
    return { previous, state };
  }

  function mockPm2(previous: string, port: number) {
    const cli = path.join(previous, 'node_modules/pm2/bin/pm2');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, 'if(process.env.FIXTURE_PM2_QUERY_MARKER)require("fs").writeFileSync(process.env.FIXTURE_PM2_QUERY_MARKER,"started");process.stdout.write(process.env.FIXTURE_PM2_JSON || "[]");\n');
    const pm2Root = path.join(previous, 'node_modules/pm2');
    fs.writeFileSync(path.join(pm2Root, 'constants.js'), 'module.exports = { DAEMON_RPC_PORT: "fixture" };\n');
    fs.mkdirSync(path.join(pm2Root, 'modules/pm2-axon'), { recursive: true });
    fs.writeFileSync(path.join(pm2Root, 'modules/pm2-axon/index.js'), `
const { EventEmitter } = require('events');
exports.socket = () => {
  const socket = new EventEmitter();
  socket.connect = () => setImmediate(() => socket.emit(process.env.FIXTURE_PM2_UNAVAILABLE ? 'reconnect attempt' : 'connect'));
  socket.close = () => {};
  return socket;
};
`);
    fs.mkdirSync(path.join(pm2Root, 'modules/pm2-axon-rpc'), { recursive: true });
    fs.writeFileSync(path.join(pm2Root, 'modules/pm2-axon-rpc/index.js'), `
exports.Client = class {
  call(method, args, callback) {
    if (method !== 'getMonitorData') throw new Error('Unexpected ownership RPC');
    callback(null, JSON.parse(process.env.FIXTURE_PM2_JSON || '[]'));
  }
};
`);
    fs.mkdirSync(env.PM2_HOME, { recursive: true });
    fs.writeFileSync(path.join(env.PM2_HOME, 'pm2.pid'), String(process.pid));
    const entry = {
      name: 'agent-cockpit', pid: process.pid,
      pm2_env: {
        status: 'online', pm_cwd: previous, PORT: port,
        AGENT_COCKPIT_DATA_DIR: path.join(install, 'data'),
      },
    };
    env.FIXTURE_PM2_JSON = JSON.stringify([entry]);
    return entry;
  }

  return {
    root, source, release, install, env, run, seed, mockPm2,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export type InstallerFixture = ReturnType<typeof installerFixture>;

export async function runPosix(fixture: InstallerFixture, platform: 'macos' | 'linux', body: string, extra: NodeJS.ProcessEnv = {}) {
  const script = path.join(process.cwd(), 'scripts', `install-${platform}.sh`);
  return fixture.run('bash', ['-c', `
installer="$1"
shift
source "$installer"
INSTALL_DIR="$FIXTURE_INSTALL"
CHANNEL=production
OPEN_BROWSER=false
AUTO_START=false
NODE_BIN_DIR="$(dirname "$FIXTURE_NODE")"
NODE_RUNTIME_SOURCE=system
NODE_RUNTIME_VERSION=22.0.0
NODE_RUNTIME_NPM_VERSION=10.0.0
NODE_RUNTIME_PATH="$PATH"
PORT_EXPLICIT=true
PORT="$FIXTURE_PORT"
launchctl() { printf 'launchctl %s\\n' "$*" >> "$FIXTURE_ROOT/commands"; }
systemctl() { printf 'systemctl %s\\n' "$*" >> "$FIXTURE_ROOT/commands"; }
${process.platform === 'darwin' ? '' : `plutil() {
  "$FIXTURE_NODE" -e "const fs=require('fs'),{XMLParser}=require('fast-xml-parser');const value=new XMLParser().parse(fs.readFileSync(process.argv[1],'utf8')).plist.dict.array.string;process.stdout.write(String(Array.isArray(value)?value[0]:value));" "$6"
}`}
sha256sum() { shasum -a 256 "$@"; }
npm() {
  printf 'npm %s\\n' "$*" >> "$FIXTURE_ROOT/commands"
  [[ "\${FIXTURE_FAILURE:-}" != dependency ]]
}
npx() {
  printf 'npx %s %s\\n' "$PWD" "$*" >> "$FIXTURE_ROOT/commands"
  if [[ "\${FIXTURE_FAILURE:-}" == startup && "$PWD" != "$PREVIOUS_APP_DIR" && "$*" == *startOrRestart* ]]; then return 7; fi
}
${body}
`, 'fixture', script], extra);
}

export async function runPowerShell(fixture: InstallerFixture, body: string, extra: NodeJS.ProcessEnv = {}) {
  const file = path.join(fixture.root, 'fixture.ps1');
  const script = path.join(process.cwd(), 'scripts/install-windows.ps1');
  fs.writeFileSync(file, `
$ErrorActionPreference = 'Stop'
. '${script.replace(/'/g, "''")}'
$InstallDir = $env:FIXTURE_INSTALL
$Channel = 'production'
$NoAutoStart = $true
$SkipOpen = $true
$PortExplicit = $true
$Port = [int]$env:FIXTURE_PORT
$NodeExe = $env:FIXTURE_NODE
$NodeRuntimeBinDir = Split-Path -Parent $NodeExe
$NpmCmd = 'fixture-npm'
$NodeRuntimeSource = 'system'
$WorkDir = Join-Path $env:FIXTURE_ROOT 'work'
Ensure-Directory $WorkDir
function Ensure-UserPathEntry {}
function Get-ScheduledTask { return $null }
function Invoke-Quiet {
  param([string] $FilePath, [string[]] $Arguments, [string] $WorkingDirectory)
  Add-Content (Join-Path $env:FIXTURE_ROOT 'commands') ($Arguments -join ' ')
  if ($env:FIXTURE_FAILURE -eq 'dependency') { throw 'Fixture dependency failure' }
}
function Start-Pm2 {
  param([string] $AppDir)
  Add-Content (Join-Path $env:FIXTURE_ROOT 'commands') "start $AppDir"
  if ($env:FIXTURE_FAILURE -eq 'startup' -and $AppDir -ne $PreviousAppDir) { throw 'Fixture startup failure' }
}
function Invoke-Pm2BestEffort {
  param([string] $AppDir, [string[]] $Arguments, [switch] $PassThru)
  if ($PassThru) { return $true }
}
${body}
`);
  return fixture.run(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-File', file], extra);
}
