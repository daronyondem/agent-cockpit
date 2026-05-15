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
    expect(source).toContain('function Env-Quote');
    expect(source).toContain('"PATH=$(Env-Quote (Runtime-Path))"');
    expect(source).toContain('ecosystem.config.js');
    expect(source).toContain("script = 'node_modules/tsx/dist/cli.mjs'");
    expect(source).toContain("args = 'server.ts'");
    expect(source).toContain('interpreter = $NodeExe');
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
    expect(source).toContain('schtasks.exe /Create /TN $TaskName /SC ONLOGON /RU $currentUser /TR $taskRun /RL LIMITED /F');
    expect(source).toContain('npx.cmd');
    expect(source).toContain("@('pm2', 'startOrRestart', 'ecosystem.config.js', '--update-env')");
    expect(source).toContain('http://127.0.0.1:$Port/auth/setup');
    expect(source).toContain('Start-Process $url');
  });
});
