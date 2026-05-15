# Windows Installer Implementation Plan

## Objective

Build a first-class Windows installer path for Agent Cockpit that prioritizes end-user quality over reusing macOS-specific mechanics.

The Windows installer should install and run Agent Cockpit as a local, per-user server process, open the existing browser-based setup flow, and start again when that same Windows user logs in. It should not require administrator rights, a global Node.js install, a global PM2 install, or manual cloning for normal production installs.

## Product Decision

The supported first Windows install mode is a per-user, interactive-login install.

In scope:

- Install under the current Windows user.
- Start Agent Cockpit immediately after install.
- Open the browser to first-run setup.
- Start Agent Cockpit automatically when that same Windows user logs in.
- Use the user's normal local workspace paths and CLI credentials.
- Support production installs from GitHub Releases.
- Support dev installs from `main` for maintainers/testers.
- Support production self-update with rollback.

Out of scope for this implementation:

- Running before any user has logged into Windows.
- Running as a Windows Service.
- Running under a dedicated service account.
- Machine-wide install under `Program Files`.
- Admin-required install flows.
- Native Electron/Tauri shell.
- MSI/MSIX signing and SmartScreen polish.
- Automatic setup of Claude/Codex/Kiro credentials.

Rationale: unattended service mode makes the service account the real runtime identity. That complicates CLI auth, `%APPDATA%`, `%USERPROFILE%`, Credential Manager, PM2 home, workspace permissions, mapped drives, browser setup, and debugging. It is the wrong first experience for normal Agent Cockpit users.

## Guiding Principles

- Design Windows around Windows-native primitives. Do not force Unix shell, symlink, `nohup`, `tar`, or `shasum` assumptions onto Windows.
- Reuse only platform-neutral pieces: release manifests, checksums, prebuilt app assets, install state, PM2 as runtime supervisor, and the existing browser setup flow.
- Avoid global mutation. Do not install global Node, global PM2, or modify the user's global PATH.
- Keep the app repairable. Re-running the installer should repair PM2 config, scheduled task, generated scripts, and missing dependencies without wiping user data.
- Preserve user data and auth. Reinstall/update must not reset `.env`, setup state, sessions, chat data, memory, or CLI credentials unless explicitly requested.
- Make failure messages actionable. Installer failures should name the failed command, log path, and next command to inspect logs.
- Keep macOS behavior stable. Windows changes must not regress the existing macOS installer or production update path.

## Target User Experience

Production install command:

```powershell
powershell -ExecutionPolicy Bypass -NoProfile -Command "iwr https://github.com/daronyondem/agent-cockpit/releases/latest/download/install-windows.ps1 -OutFile $env:TEMP\install-agent-cockpit.ps1; & $env:TEMP\install-agent-cockpit.ps1 -Channel production"
```

Expected flow:

1. User runs the command in PowerShell.
2. Installer detects Windows architecture and whether Node.js 22+ is already available.
3. Installer uses system Node.js when suitable, otherwise installs a private Node.js runtime under the Agent Cockpit install root.
4. Installer downloads and verifies the GitHub Release manifest, checksums, and Windows app ZIP.
5. Installer expands the release under a versioned release directory.
6. Installer installs dependencies quietly.
7. Installer writes `.env`, `ecosystem.config.js`, runtime helper scripts, and `install.json`.
8. Installer starts Agent Cockpit with local PM2 using install-local `PM2_HOME`.
9. Installer registers a per-user scheduled task for logon startup unless disabled.
10. Installer waits for `/auth/setup`, prints the setup token, and opens the browser.

## Target Layout

Default install root:

```text
%LOCALAPPDATA%\Agent Cockpit\
  bin\
    start-agent-cockpit.ps1
    stop-agent-cockpit.ps1
    logs-agent-cockpit.ps1
    restart-agent-cockpit.ps1
  data\
    install.json
    update-restart.log
    ...
  pm2\
    ...
  releases\
    agent-cockpit-v0.4.5\
      .env
      ecosystem.config.js
      server.ts
      package.json
      public\
      src\
      ...
  runtime\
    node-v22.x.y-win-x64\
      node.exe
      npm.cmd
      npx.cmd
```

Important layout choices:

- Do not use a `current` symlink on Windows.
- Store the active app directory in `data\install.json`.
- Scheduled task and helper scripts should read `install.json` to find the active release.
- PM2 state should live under install-local `pm2\` via `PM2_HOME`.
- Old releases may remain for rollback; prune only after a successful update.

## Installer Options

Create `scripts/install-windows.ps1` with these options:

```powershell
param(
  [ValidateSet('production', 'dev')]
  [string] $Channel = 'production',

  [string] $Version = '',
  [string] $Repo = 'daronyondem/agent-cockpit',
  [string] $InstallDir = "$env:LOCALAPPDATA\Agent Cockpit",
  [string] $DevDir = "$env:USERPROFILE\agent-cockpit",
  [int] $Port = 3334,

  [switch] $InstallNode,
  [switch] $NoInstallNode,
  [switch] $SkipOpen,
  [switch] $NoAutoStart,
  [switch] $Repair
)
```

Behavior:

- `-Channel production` downloads from GitHub Releases.
- `-Channel dev` clones or updates `main`.
- `-Version` selects `v<version>` release instead of latest.
- `-InstallNode` keeps the default explicit: install private Node when needed.
- `-NoInstallNode` fails if Node.js 22+ and npm are unavailable.
- `-SkipOpen` suppresses browser launch but still prints the setup URL/token.
- `-NoAutoStart` skips logon scheduled task registration.
- `-Repair` should be accepted even if initially it behaves the same as rerunning the installer; reserve it for future explicit repair UX.

## Release Artifact Changes

### Package Script

Update `scripts/package-release.js`.

Current state:

- Produces `agent-cockpit-v<version>.tar.gz`.
- Produces `release-manifest.json`.
- Produces `SHA256SUMS`.
- Copies `scripts/install-macos.sh` as `install-macos.sh`.

Required changes:

- Produce `agent-cockpit-v<version>.zip` for Windows.
- Copy `scripts/install-windows.ps1` as `install-windows.ps1` when present.
- Include both Windows artifacts in `release-manifest.json`.
- Include both Windows artifacts in `SHA256SUMS`.
- Keep existing tarball and macOS installer behavior unchanged.

Target artifact roles:

```json
[
  {
    "name": "agent-cockpit-v0.4.5.tar.gz",
    "role": "app-archive",
    "platform": "darwin",
    "format": "tar.gz",
    "sha256": "<hash>"
  },
  {
    "name": "agent-cockpit-v0.4.5.zip",
    "role": "app-archive",
    "platform": "win32",
    "format": "zip",
    "sha256": "<hash>"
  },
  {
    "name": "install-macos.sh",
    "role": "macos-installer",
    "platform": "darwin",
    "sha256": "<hash>"
  },
  {
    "name": "install-windows.ps1",
    "role": "windows-installer",
    "platform": "win32",
    "sha256": "<hash>"
  }
]
```

Compatibility:

- Preserve existing `role: "app-tarball"` if changing the role would be too invasive.
- If preserving `app-tarball`, add the Windows ZIP as `role: "app-zip"` rather than replacing the current role.
- Update `UpdateService` and macOS installer only if role changes require it.

### Release Workflow

Update `.github/workflows/release.yml`.

Required changes:

- Upload `dist/release/agent-cockpit-v<VERSION>.zip`.
- Upload `dist/release/install-windows.ps1`.
- Keep the current release gate order unless Windows tests are added in a separate job.

Add a separate Windows CI job before release upload if runtime validation is practical:

```text
windows-smoke:
  runs-on: windows-latest
  steps:
    - checkout
    - setup-node 22
    - npm ci
    - npm --prefix mobile/AgentCockpitPWA ci
    - npm run typecheck
    - npm run web:typecheck
    - npm run mobile:typecheck
    - npm test -- focused Windows-safe tests
```

Do not block initial implementation on full Playwright/browser validation on Windows unless it is stable.

## PowerShell Installer Design

### Script Safety

At top of `scripts/install-windows.ps1`:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
```

Define small helper functions:

- `Write-Log`
- `Fail`
- `Require-Windows`
- `Resolve-Architecture`
- `Download-File`
- `Get-Sha256`
- `Assert-Checksum`
- `Read-JsonFile`
- `Write-JsonFile`
- `New-RandomHex`
- `Quote-ForJs`
- `Invoke-Quiet`
- `Ensure-Directory`

Use built-in Windows/PowerShell features:

- Downloads: `Invoke-WebRequest`
- Hashing: `Get-FileHash -Algorithm SHA256`
- Archive extraction: `Expand-Archive`
- Browser open: `Start-Process`
- Scheduled task: prefer PowerShell scheduled task cmdlets; fall back to `schtasks.exe` only if needed.

### Platform Detection

Support:

- `win32 x64` first.
- `win32 arm64` only if Node.js, native dependencies, and CLIs validate. If not validated, fail with a clear message.

Detection:

```powershell
$IsWindows
$env:PROCESSOR_ARCHITECTURE
[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
```

### Private Node Runtime

Windows private Node runtime should use official Node.js ZIPs.

Algorithm:

1. If `node` and `npm` are on PATH and Node major >= 22, use system Node.
2. Otherwise, unless `-NoInstallNode`, install private Node.
3. Download `https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt`.
4. Select `node-v<version>-win-x64.zip` for x64.
5. Download ZIP.
6. Verify SHA256 using the checksums file.
7. Expand to `%LOCALAPPDATA%\Agent Cockpit\runtime\node-v<version>-win-x64`.
8. Record:
   - `source: "private"`
   - `version`
   - `npmVersion`
   - `binDir`
   - `runtimeDir`
   - `requiredMajor`

Do not create a symlink or junction. The runtime path is stable because `install.json` and generated config store the versioned runtime path.

### Production Install

Algorithm:

1. Resolve release base:
   - latest: `https://github.com/<repo>/releases/latest/download`
   - versioned: `https://github.com/<repo>/releases/download/v<version>`
2. Download:
   - `release-manifest.json`
   - `SHA256SUMS`
3. Verify manifest checksum.
4. Read manifest.
5. Find Windows app archive:
   - preferred: artifact with `platform: "win32"` and `format: "zip"`
   - compatibility fallback: `role: "app-zip"`
6. Download app ZIP.
7. Verify against `SHA256SUMS`.
8. Verify against artifact `sha256`.
9. Extract into a temporary staging directory under install root.
10. Verify extracted release contains `server.ts`, `package.json`, `public/v2-built/index.html`, and `public/mobile-built/index.html`.
11. Move into `releases\agent-cockpit-v<version>`.
12. Install dependencies.
13. Ensure build assets exist; build only if missing.
14. Generate runtime config.
15. Write install manifest.
16. Generate helper scripts.
17. Register logon startup unless `-NoAutoStart`.
18. Start PM2.
19. Wait for `/auth/setup`.
20. Print setup token and URL.
21. Open browser unless `-SkipOpen`.

### Dev Install

Algorithm:

1. Ensure `git` is available.
2. Clone `https://github.com/<repo>.git` into `-DevDir` if missing.
3. Otherwise:
   - `git fetch origin main`
   - `git checkout main`
   - `git pull --ff-only origin main`
4. Install dependencies.
5. Force web/mobile builds.
6. Generate runtime config in the dev checkout.
7. Write install manifest with:
   - `channel: "dev"`
   - `source: "git-main"`
   - `branch: "main"`
   - `installDir`
   - `appDir: DevDir`
8. Generate helper scripts.
9. Register logon startup unless disabled.
10. Start PM2.
11. Wait for setup endpoint and open browser.

### Dependency Install

Use private/system Node command paths explicitly.

For private runtime:

```powershell
& "$NodeBin\npm.cmd" ci --no-audit --no-fund --loglevel=error
& "$NodeBin\npm.cmd" --prefix mobile/AgentCockpitPWA ci --no-audit --no-fund --loglevel=error
```

Set env vars during install:

```powershell
$env:NPM_CONFIG_AUDIT = 'false'
$env:NPM_CONFIG_FUND = 'false'
$env:NPM_CONFIG_LOGLEVEL = 'error'
$env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
$env:PM2_HOME = "$InstallDir\pm2"
```

### Runtime Config

Write `.env` in active app dir:

```text
PORT=3334
SESSION_SECRET=<random>
AUTH_SETUP_TOKEN=<random>
AGENT_COCKPIT_DATA_DIR="<install-dir>\data"
WEB_BUILD_MODE=auto
AUTH_ENABLE_LEGACY_OAUTH=false
PATH="<node-bin>;<existing path>"
PM2_HOME="<install-dir>\pm2"
```

If reinstalling over an existing install:

- Preserve existing `SESSION_SECRET` if present.
- Preserve existing `AUTH_SETUP_TOKEN` only if owner setup is incomplete.
- Preserve existing `AGENT_COCKPIT_DATA_DIR` unless user supplied a new install dir or explicit override.

Write `ecosystem.config.js` in active app dir.

Preferred Windows PM2 shape:

```js
module.exports = {
  apps: [{
    name: 'agent-cockpit',
    script: 'node_modules/tsx/dist/cli.mjs',
    args: 'server.ts',
    interpreter: 'C:\\Users\\...\\runtime\\node-v22.x.y-win-x64\\node.exe',
    cwd: 'C:\\Users\\...\\releases\\agent-cockpit-v0.4.5',
    env: {
      PORT: 3334,
      SESSION_SECRET: '...',
      AUTH_SETUP_TOKEN: '...',
      AGENT_COCKPIT_DATA_DIR: 'C:\\Users\\...\\Agent Cockpit\\data',
      WEB_BUILD_MODE: 'auto',
      AUTH_ENABLE_LEGACY_OAUTH: 'false',
      PM2_HOME: 'C:\\Users\\...\\Agent Cockpit\\pm2',
      PATH: 'C:\\Users\\...\\runtime\\node-v22.x.y-win-x64;...'
    }
  }]
};
```

Why this shape:

- It avoids relying on `.cmd` shims in `node_modules\.bin`.
- It keeps the interpreter explicit.
- It should work for both private and system Node.

Validate this shape on Windows. If PM2 handles `node_modules\.bin\tsx.cmd` more reliably, document the reason and use that instead.

### Install Manifest

Reuse schema version 1 if possible.

Windows example:

```json
{
  "schemaVersion": 1,
  "channel": "production",
  "source": "github-release",
  "repo": "daronyondem/agent-cockpit",
  "version": "0.4.5",
  "branch": null,
  "installDir": "C:\\Users\\Daron\\AppData\\Local\\Agent Cockpit",
  "appDir": "C:\\Users\\Daron\\AppData\\Local\\Agent Cockpit\\releases\\agent-cockpit-v0.4.5",
  "dataDir": "C:\\Users\\Daron\\AppData\\Local\\Agent Cockpit\\data",
  "installedAt": "2026-05-15T00:00:00.000Z",
  "welcomeCompletedAt": null,
  "nodeRuntime": {
    "source": "private",
    "version": "22.22.3",
    "npmVersion": "10.9.8",
    "binDir": "C:\\Users\\Daron\\AppData\\Local\\Agent Cockpit\\runtime\\node-v22.22.3-win-x64",
    "runtimeDir": "C:\\Users\\Daron\\AppData\\Local\\Agent Cockpit\\runtime\\node-v22.22.3-win-x64",
    "requiredMajor": 22,
    "updatedAt": "2026-05-15T00:00:00.000Z"
  },
  "startup": {
    "kind": "scheduled-task",
    "name": "AgentCockpit",
    "scope": "current-user"
  }
}
```

If adding `startup` is too large for schema 1, keep it out of the manifest and let doctor infer scheduled task state. Prefer adding it if tests/docs are updated.

## PM2 And Helper Scripts

### PM2 Home

Always set:

```text
PM2_HOME=<install-dir>\pm2
```

This avoids mixing Agent Cockpit PM2 state with other PM2 apps the user may have.

### Start Script

Generate `bin\start-agent-cockpit.ps1`.

Responsibilities:

- Read `data\install.json`.
- Resolve active `appDir`.
- Resolve private/system Node and npm/npx paths.
- Set `PM2_HOME`.
- Set `PATH`.
- Run:

```powershell
& "$NodeBin\npx.cmd" pm2 startOrRestart "$AppDir\ecosystem.config.js" --update-env
& "$NodeBin\npx.cmd" pm2 save
```

For system Node, resolve `npx.cmd` through PATH.

### Stop Script

Generate `bin\stop-agent-cockpit.ps1`.

Run:

```powershell
pm2 delete agent-cockpit
pm2 save
```

Use the same `PM2_HOME` and Node path resolution as start script.

### Logs Script

Generate `bin\logs-agent-cockpit.ps1`.

Run:

```powershell
pm2 logs agent-cockpit --lines 100
```

Print this command whenever installer readiness fails.

### Scheduled Task

Register a current-user logon task named `AgentCockpit`.

Preferred implementation:

- Use `New-ScheduledTaskAction`.
- Use `New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME` if reliable.
- Use `Register-ScheduledTask -TaskName "AgentCockpit" -Action ... -Trigger ... -Description ... -Force`.
- The action should call:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<install-dir>\bin\start-agent-cockpit.ps1"
```

Fallback:

```powershell
schtasks.exe /Create /TN AgentCockpit /SC ONLOGON /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""<script>""" /F
```

Do not use `Run whether user is logged on or not`. That crosses into service-mode behavior and requires credentials.

## Production Self-Update

Current `UpdateService` has macOS/POSIX assumptions:

- `current` symlink.
- `restart.sh`.
- `sh`.
- `nohup`.
- `tar -xzf`.
- Node Darwin tarballs.
- `curl`.
- symlink rollback.

Refactor carefully instead of adding scattered `if (win32)` checks.

### Suggested Module Split

Add focused private modules under `src/services/update/`:

- `releaseManifest.ts`
  - parse and validate release manifest
  - choose platform archive artifact
  - checksum helpers
- `archive.ts`
  - extract `.tar.gz` on POSIX
  - extract `.zip` on Windows
- `nodeRuntime.ts`
  - detect current runtime
  - install private Node for darwin/win32
  - resolve npm/npx paths
- `activation.ts`
  - macOS symlink activation
  - Windows manifest-based activation
- `restart.ts`
  - POSIX `restart.sh` double-fork
  - Windows `restart.ps1` detached start

Keep the public `UpdateService` facade stable.

### Windows Update Algorithm

1. Read current install status.
2. Require `installDir`, `appDir`, and `dataDir`.
3. Download latest release manifest/checksums.
4. If version is not newer, return current no-update behavior.
5. Select Windows ZIP artifact.
6. Download and verify ZIP.
7. Extract under `releases\.extract-<id>`.
8. Move to `releases\agent-cockpit-v<version>`.
9. Ensure private Node runtime satisfies required major.
10. Run root `npm ci`.
11. Run mobile `npm --prefix mobile/AgentCockpitPWA ci`.
12. Verify/build web and mobile assets.
13. Copy `.env` from old app dir to new app dir.
14. Generate new `ecosystem.config.js` for new app dir and current runtime.
15. Write new `install.json` with `appDir` pointing directly to new versioned release.
16. Launch `restart-agent-cockpit.ps1` detached.
17. Restart script:
    - sets `PM2_HOME`
    - starts new app
    - polls health URL
    - on failure, restores previous `install.json` and starts old app
18. Keep old release for rollback.
19. Prune older releases only after successful health check.

### Windows Restart Script

Generate restart script under `data\restart-agent-cockpit.ps1` for each update.

High-level shape:

```powershell
Start-Sleep -Seconds 2
$env:PM2_HOME = '<install-dir>\pm2'
$env:PATH = '<node-bin>;' + $env:PATH
& '<node-bin>\npx.cmd' pm2 delete agent-cockpit
& '<node-bin>\npx.cmd' pm2 startOrRestart '<new-app-dir>\ecosystem.config.js' --update-env

$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '<health-url>' | Out-Null
    $ok = $true
    break
  } catch {
    Start-Sleep -Seconds 1
  }
}

if (-not $ok) {
  Copy-Item '<previous-install-json-backup>' '<data-dir>\install.json' -Force
  & '<node-bin>\npx.cmd' pm2 delete agent-cockpit
  & '<node-bin>\npx.cmd' pm2 startOrRestart '<old-app-dir>\ecosystem.config.js' --update-env
  exit 1
}

& '<node-bin>\npx.cmd' pm2 save
```

Launch detached from Node with:

```ts
spawn('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  scriptFile,
], {
  cwd: appRoot,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
}).unref();
```

Validate that PM2 treekill does not kill the detached PowerShell on Windows. If it does, use `Start-Process powershell.exe ...` from an intermediate script.

## Install Doctor And UX Follow-Up

Update `src/services/installDoctorService.ts`.

Required Windows-aware checks:

- Node.js runtime satisfies required major.
- npm is available through runtime.
- local PM2 works with install-local `PM2_HOME`.
- data directory writable.
- active app directory exists.
- desktop web build exists.
- mobile PWA build exists.
- logon scheduled task exists unless user opted out.
- update channel metadata is valid.

Remediation copy:

- Do not tell Windows users to rerun the macOS installer.
- Do not suggest Homebrew on Windows.
- For Pandoc/LibreOffice, link official Windows installers/downloads.
- For CLIs, only show Windows commands/links that have been validated.

Backend caveat:

- Claude Code Interactive hooks currently explicitly do not support Windows. Do not present Windows as full parity for that backend until compatibility is validated and documented.
- Standard Claude Code, Codex, and Kiro CLI behavior must be tested on Windows before docs promise them.

## Tests

### New Tests

Add `test/windowsInstallerScript.test.ts`.

Static coverage should verify:

- PowerShell strict/error settings.
- Windows platform guard.
- production/dev options.
- private Node ZIP path and checksum verification.
- `Get-FileHash`.
- `Expand-Archive`.
- release manifest/checksum/app ZIP download.
- `.env` generation.
- `ecosystem.config.js` generation.
- `PM2_HOME` usage.
- helper script generation.
- scheduled task registration.
- setup endpoint polling.
- browser opening through `Start-Process`.

Extend `test/releasePackage.test.ts`.

Coverage:

- ZIP artifact exists.
- `install-windows.ps1` exists.
- manifest includes Windows archive and installer artifacts.
- checksums include Windows artifacts.
- ZIP includes required source/build files.
- ZIP excludes mutable/local state.

Extend `test/updateService.test.ts`.

Coverage:

- Windows production update selects ZIP artifact.
- Windows extraction uses ZIP flow.
- Windows private Node selects `node-v<version>-win-x64.zip`.
- Windows activation writes `install.json` appDir to versioned release, not symlink.
- Windows restart script uses PowerShell.
- Windows rollback restores previous install state.
- macOS/POSIX tests still pass.

Extend `test/installDoctorService.test.ts`.

Coverage:

- Windows remediation text.
- scheduled task check.
- no Homebrew/macOS installer references on Windows.

### CI

Add Windows smoke workflow or job.

Minimum:

```text
npm ci
npm --prefix mobile/AgentCockpitPWA ci
npm run typecheck
npm run web:typecheck
npm run mobile:typecheck
npm test -- test/windowsInstallerScript.test.ts test/releasePackage.test.ts
```

Optional after stabilizing:

```text
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows.ps1 -Channel production -InstallDir "$env:TEMP\Agent Cockpit" -SkipOpen -NoAutoStart
```

Only add installer smoke to release gating after it is reliable.

## Documentation And ADR

Create a new ADR:

```bash
npm run adr:new -- "Adopt per-user Windows installer"
```

ADR decision points:

- Windows uses per-user install under `%LOCALAPPDATA%`.
- Windows uses PowerShell and ZIP artifacts.
- Windows uses Scheduled Task at logon, not Windows Service.
- Windows does not use symlinks/junctions for active releases.
- Windows uses install-local `PM2_HOME`.
- Unattended no-login/service mode is out of scope.

Update specs:

- `docs/spec-deployment.md`
  - Windows install command, options, layout, logon startup behavior.
- `docs/spec-data-models.md`
  - release manifest Windows artifacts.
  - install manifest Windows example.
- `docs/spec-backend-services.md`
  - UpdateService Windows update/restart/rollback behavior.
  - InstallDoctor Windows checks.
- `docs/spec-api-endpoints.md`
  - update endpoint platform behavior if response semantics change.
- `docs/spec-testing.md`
  - Windows installer, package, update, doctor tests.
- `docs/spec-coverage.md`
  - update deployment/installer coverage row.
- `README.md`
  - Windows install section.
  - note that service/no-login mode is not supported.

Evaluate `AGENTS.md`:

- Update only if this creates a recurring workflow convention for Windows installer work.
- Likely add a note that Windows server management still uses PM2 through installer helper scripts, not direct `node server.ts`.

## Implementation Phases

### Phase 0: Validation Spike

Goal: remove unknowns before large edits.

Tasks:

- Run `npm ci` on Windows with Node 22.
- Verify `node-pty`, `better-sqlite3`, and `@napi-rs/canvas` install on Windows.
- Verify PM2 starts this app on Windows using the proposed `script: node_modules/tsx/dist/cli.mjs`, `args: server.ts`, explicit `node.exe` interpreter config.
- Verify `PM2_HOME` local directory works.
- Verify scheduled task at logon can run `start-agent-cockpit.ps1`.
- Verify detached PowerShell restart survives PM2 delete/restart.

Acceptance:

- Document exact PM2 config shape that works.
- Document any dependency build requirements.
- Decide whether arm64 is supported or explicitly blocked.

### Phase 1: Release Artifact Support

Tasks:

- Update package script to emit Windows ZIP and installer asset.
- Update release manifest/checksums.
- Update release workflow upload list.
- Add/extend release package tests.

Acceptance:

- `npm run release:package -- --version <version> ...` produces tarball, ZIP, manifest, checksums, macOS installer, Windows installer.
- Existing macOS package tests still pass.

### Phase 2: First Windows Installer

Tasks:

- Implement `scripts/install-windows.ps1`.
- Implement production path.
- Implement dev path.
- Generate `.env`, `ecosystem.config.js`, `install.json`, and helper scripts.
- Register scheduled task.
- Start PM2 and poll setup endpoint.
- Add static installer tests.

Acceptance:

- Fresh Windows user can run one command and reach `/auth/setup`.
- No admin rights required.
- No global Node required.
- No global PM2 required.
- Re-running installer repairs startup and PM2 config without deleting data.

### Phase 3: Platform-Aware UpdateService

Tasks:

- Refactor platform-neutral update helpers.
- Add Windows ZIP download/extract path.
- Add Windows private Node runtime update.
- Add manifest-based release activation.
- Add PowerShell restart/rollback script.
- Add focused tests.

Acceptance:

- Production self-update works on Windows from one release to a newer release.
- Failed health check rolls back to previous release.
- macOS production update tests still pass.

### Phase 4: Doctor, Docs, And UX Polish

Tasks:

- Make install doctor platform-aware.
- Add scheduled task status.
- Replace macOS-only remediation on Windows.
- Update specs, ADR, README.
- Add Windows troubleshooting commands.

Acceptance:

- Windows user sees accurate install status and remediation.
- Docs match implemented behavior.
- `npm run maintainability:check`, `npm run spec:drift`, tests, and ADR lint pass.

### Phase 5: Optional EXE Wrapper

Only after PowerShell installer is stable.

Options:

- Small signed/un-signed bootstrap EXE that downloads/runs `install-windows.ps1`.
- Inno Setup/NSIS wrapper that embeds the PowerShell script.

Out of scope until requested:

- MSI/MSIX.
- Code signing.
- Windows Service mode.

## Verification Commands

Run before PR:

```bash
npm ci
npm --prefix mobile/AgentCockpitPWA ci
npm run typecheck
npm run web:typecheck
npm run web:build
npm run web:budget
npm run mobile:typecheck
npm run mobile:build
npm test
npm run maintainability:check
npm run spec:drift
npm run adr:lint
npm run release:package -- --version 0.0.0-test --source-ref main --commit local --out-dir dist/release-test
```

Windows-specific checks:

```powershell
npm ci
npm --prefix mobile/AgentCockpitPWA ci
npm run typecheck
npm run web:typecheck
npm run mobile:typecheck
npm test -- test/windowsInstallerScript.test.ts test/releasePackage.test.ts
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows.ps1 -Channel production -InstallDir "$env:TEMP\Agent Cockpit" -SkipOpen -NoAutoStart
```

Do not run `node server.ts` directly. Use PM2 or installer helper scripts.

## Risks And Mitigations

Risk: native npm dependencies fail on Windows.

Mitigation: run Windows validation spike first; document Visual Studio Build Tools requirement only if unavoidable.

Risk: PM2 restart process is killed during update.

Mitigation: validate detached PowerShell behavior; if needed, launch via `Start-Process` from an intermediate script.

Risk: scheduled task registration differs by Windows edition/policy.

Mitigation: implement PowerShell scheduled task cmdlets first and `schtasks.exe` fallback; doctor should report missing task and repair instructions.

Risk: Windows path quoting breaks generated JS/PowerShell.

Mitigation: generate JS config through JSON serialization; add tests with spaces in install path.

Risk: Windows Defender/SmartScreen warns on scripts.

Mitigation: use transparent PowerShell script first; later add signed EXE wrapper if distribution requires it.

Risk: backend CLIs have uneven Windows support.

Mitigation: installer supports Agent Cockpit server first; doctor reports each backend separately and docs avoid overpromising parity.

Risk: changing release manifest breaks macOS installer/updater.

Mitigation: preserve existing artifact roles where needed and add Windows fields additively.

## Definition Of Done

- A fresh Windows machine with no Node.js can install Agent Cockpit with one PowerShell command.
- The app starts under PM2 using install-local Node/PM2 state.
- The browser opens to first-run setup and the printed setup token works.
- The app starts again when the same user logs into Windows.
- Production self-update works on Windows with rollback on failed health check.
- Re-running the installer repairs the install without deleting user data.
- macOS installer and updater behavior remain unchanged.
- Docs/specs/ADR describe the supported Windows path and explicitly exclude no-login service mode.
- Tests cover release packaging, Windows installer script shape, Windows update behavior, and doctor remediation.
