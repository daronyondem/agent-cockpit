import fs from 'fs';
import path from 'path';

const scriptPath = path.join(process.cwd(), 'scripts/install-windows.ps1');

describe('Windows installer script', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');

  test('has a strict PowerShell entrypoint and supported options', () => {
    expect(source).toContain("Set-StrictMode -Version Latest");
    expect(source).toContain("$ErrorActionPreference = 'Stop'");
    expect(source).toContain("[ValidateSet('production', 'dev')]");
    expect(source).toContain("$InstallDir = \"$env:LOCALAPPDATA\\Agent Cockpit\"");
    expect(source).toContain('[switch] $InstallNode');
    expect(source).toContain('[switch] $NoAutoStart');
    expect(source).toContain('[switch] $NoInstallNode');
    expect(source).toContain('[switch] $SkipOpen');
  });

  test('uses Windows-native download, checksum, and extraction primitives', () => {
    expect(source).toContain('Invoke-WebRequest -UseBasicParsing');
    expect(source).toContain('Get-FileHash -Algorithm SHA256');
    expect(source).toContain('Expand-Archive');
    expect(source).toContain('SHASUMS256.txt');
    expect(source).toContain('node-v([0-9]+\\.[0-9]+\\.[0-9]+)-win-$nodeArch\\.zip');
    expect(source).toContain('if (-not $InstallNode)');
    expect(source).toContain('Release manifest does not include a Windows app ZIP artifact');
  });

  test('reuses existing private Node runtimes during repair reruns', () => {
    expect(source).toContain('function Use-PrivateNodeRuntime');
    expect(source).toContain('function Invoke-NativeOutput');
    expect(source).toContain('$code = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }');
    expect(source).toContain("$npmCli = Join-Path $RuntimeDir 'node_modules\\npm\\bin\\npm-cli.js'");
    expect(source).toContain("$npmPrefix = Join-Path $RuntimeDir 'node_modules\\npm\\bin\\npm-prefix.js'");
    expect(source).toContain('$npmVersion = Invoke-NativeOutput $nodeExe @($npmCli, \'--version\')');
    expect(source).toContain('Reusing private Node.js');
    expect(source).toContain('if (Use-PrivateNodeRuntime $finalDir $nodeVersion $true)');
    expect(source).toContain('Existing private Node.js runtime at $finalDir is not reusable; installing a fresh copy at $repairDir.');
    expect(source).not.toContain('Remove-Item -Recurse -Force $finalDir');
  });

  test('generates setup secrets with Windows PowerShell 5.1-compatible crypto APIs', () => {
    expect(source).toContain('[System.Security.Cryptography.RandomNumberGenerator]::Create()');
    expect(source).toContain('$rng.GetBytes($buffer)');
    expect(source).toContain('$rng.Dispose()');
    expect(source).not.toContain('[System.Security.Cryptography.RandomNumberGenerator]::Fill(');
  });

  test('installs production releases from GitHub Release ZIP assets', () => {
    expect(source).toContain('/releases/latest/download');
    expect(source).toContain('/releases/download/v');
    expect(source).toContain('release-manifest.json');
    expect(source).toContain('SHA256SUMS');
    expect(source).toContain("($_.role -eq 'app-zip')");
    expect(source).toContain("($_.platform -eq 'win32' -and $_.format -eq 'zip')");
  });

  test('supports dev installs from main', () => {
    expect(source).toContain("Invoke-Quiet $git @('clone', \"https://github.com/$Repo.git\", $DevDir) $devParent");
    expect(source).toContain("Invoke-Quiet $git @('-C', $DevDir, 'fetch', 'origin', 'main') $DevDir");
    expect(source).toContain("Invoke-Quiet $git @('-C', $DevDir, 'checkout', 'main') $DevDir");
    expect(source).toContain("Invoke-Quiet $git @('-C', $DevDir, 'pull', '--ff-only', 'origin', 'main') $DevDir");
    expect(source).toContain("Configure-App $DevDir $dataDir $devVersion 'git-main' 'main' $true");
  });

  test('generates runtime config, helper scripts, local PM2 home, and logon startup', () => {
    expect(source).toContain('Capture-ExistingRuntimeConfig $dataDir $appDir');
    expect(source).toContain("$script:PreservedSessionSecret = Read-EnvValue $envPath 'SESSION_SECRET'");
    expect(source).toContain("$script:PreservedInstalledAt = [string]$install.installedAt");
    expect(source).toContain("$script:PreservedWelcomeCompletedAt = [string]$install.welcomeCompletedAt");
    expect(source).toContain('installedAt = if ($script:PreservedInstalledAt)');
    expect(source).toContain('welcomeCompletedAt = if ($script:PreservedWelcomeCompletedAt)');
    expect(source).toContain('[System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))');
    expect(source).toContain('function Env-Quote');
    expect(source).toContain('"PATH=$(Env-Quote (Runtime-Path))"');
    expect(source).toContain('ecosystem.config.js');
    expect(source).toContain('function Write-WindowsRunnerScript');
    expect(source).toContain('run-agent-cockpit.ps1');
    expect(source).toContain("script = $runnerScript");
    expect(source).toContain("interpreter = 'powershell.exe'");
    expect(source).toContain("node_args = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File')");
    expect(source).toContain("& `$Node '--import' 'tsx' 'server.ts'");
    expect(source).toContain('Agent Cockpit did not answer before timeout; collecting PM2 diagnostics.');
    expect(source).toContain("Invoke-Pm2BestEffort $AppDir @('--no-install', 'pm2', 'logs', $AppName, '--lines', '80', '--nostream')");
    expect(source).toContain('windowsHide = $true');
    expect(source).toContain('PM2_HOME');
    expect(source).toContain('start-agent-cockpit.ps1');
    expect(source).toContain('logs-agent-cockpit.ps1');
    expect(source).toContain('function Invoke-CheckedNative');
    expect(source).toContain('$LASTEXITCODE');
    expect(source).toContain("Invoke-CheckedNative `$Npx @('pm2', 'startOrRestart', (Join-Path `$AppDir 'ecosystem.config.js'), '--update-env')");
    expect(source).toContain('[System.Security.Principal.WindowsIdentity]::GetCurrent().Name');
    expect(source).toContain('New-ScheduledTaskTrigger -AtLogOn -User $currentUser');
    expect(source).toContain('New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited');
    expect(source).toContain('Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal');
    expect(source).toContain('-WindowStyle Hidden');
    expect(source).toContain('schtasks.exe /Create /TN $TaskName /SC ONLOGON /RU $currentUser /TR $taskRun /RL LIMITED /F');
    expect(source).toContain('Failed to register current-user logon task with schtasks.exe');
    expect(source).toContain('function Stop-ExistingAppForReplacement');
    expect(source).toContain('Stopping existing Agent Cockpit process before replacing app files.');
    expect(source).toContain("Invoke-Pm2BestEffort $AppDir @('--no-install', 'pm2', 'stop', $AppName)");
    expect(source).toContain('npx.cmd');
    expect(source).toContain("@('pm2', 'startOrRestart', 'ecosystem.config.js', '--update-env')");
    expect(source).toContain('http://127.0.0.1:$Port/auth/setup');
    expect(source).toContain('Start-Process $url');
  });
});
