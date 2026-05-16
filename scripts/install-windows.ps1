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

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$NodeMajor = 22
$TaskName = 'AgentCockpit'
$AppName = 'agent-cockpit'
$NodeRuntimeSource = ''
$NodeRuntimeVersion = ''
$NodeRuntimeNpmVersion = ''
$NodeRuntimeBinDir = ''
$NodeRuntimeDir = ''
$NodeExe = ''
$NpmCmd = ''
$NpxCmd = ''
$PreservedSessionSecret = ''
$PreservedSetupToken = ''
$PreservedInstalledAt = ''
$PreservedWelcomeCompletedAt = ''

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$DevDir = [System.IO.Path]::GetFullPath($DevDir)

function Write-Log {
  param([string] $Message)
  Write-Host "[agent-cockpit] $Message"
}

function Fail {
  param([string] $Message)
  Write-Error "[agent-cockpit] ERROR: $Message"
  exit 1
}

function Require-Windows {
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Fail 'This installer supports Windows only.'
  }
}

function Resolve-Architecture {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if ($arch -eq 'x64') {
    return 'x64'
  }
  if ($arch -eq 'arm64') {
    Fail 'Windows arm64 has not been validated for Agent Cockpit yet. Use x64 Windows for this installer.'
  }
  Fail "Unsupported Windows CPU architecture: $arch"
}

function Ensure-Directory {
  param([string] $Path)
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Command-Path {
  param([string] $Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return $null
  }
  return $command.Source
}

function Download-File {
  param([string] $Url, [string] $Destination)
  Write-Log "Downloading $Url"
  Ensure-Directory ([System.IO.Path]::GetDirectoryName($Destination))
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
}

function Get-Sha256 {
  param([string] $Path)
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Assert-Checksum {
  param([string] $FilePath, [string] $FileName, [string] $ChecksumsPath)
  $line = Get-Content -Path $ChecksumsPath | Where-Object { $_ -match "^\s*([a-fA-F0-9]{64})\s+\*?$([regex]::Escape($FileName))\s*$" } | Select-Object -First 1
  if (-not $line) {
    Fail "No checksum found for $FileName"
  }
  $expected = ($line -split '\s+')[0].ToLowerInvariant()
  $actual = Get-Sha256 $FilePath
  if ($actual -ne $expected) {
    Fail "Checksum mismatch for $FileName"
  }
  Write-Log "Verified SHA256 for $FileName."
}

function Read-JsonFile {
  param([string] $Path)
  return Get-Content -Raw -Path $Path | ConvertFrom-Json
}

function Write-JsonFile {
  param([string] $Path, [object] $Value)
  Ensure-Directory ([System.IO.Path]::GetDirectoryName($Path))
  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

function New-RandomHex {
  param([int] $Bytes)
  $buffer = [byte[]]::new($Bytes)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
  } finally {
    $rng.Dispose()
  }
  return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

function Read-EnvValue {
  param([string] $EnvPath, [string] $Name)
  if (-not (Test-Path $EnvPath)) {
    return $null
  }
  $pattern = '^' + [regex]::Escape($Name) + '=(.*)$'
  foreach ($line in Get-Content -Path $EnvPath) {
    if ($line -match $pattern) {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

function Capture-ExistingRuntimeConfig {
  param([string] $DataDir, [string] $AppDir)
  $candidates = @()
  if ($AppDir) {
    $candidates += (Join-Path $AppDir '.env')
  }
  $manifestPath = Join-Path $DataDir 'install.json'
  if (Test-Path $manifestPath) {
    try {
      $install = Read-JsonFile $manifestPath
      if (-not $script:PreservedInstalledAt -and $install.PSObject.Properties.Name -contains 'installedAt' -and $install.installedAt) {
        $script:PreservedInstalledAt = [string]$install.installedAt
      }
      if (-not $script:PreservedWelcomeCompletedAt -and $install.PSObject.Properties.Name -contains 'welcomeCompletedAt' -and $install.welcomeCompletedAt) {
        $script:PreservedWelcomeCompletedAt = [string]$install.welcomeCompletedAt
      }
      if ($install.appDir) {
        $candidates += (Join-Path ([string]$install.appDir) '.env')
      }
    } catch {
      # A corrupt install manifest should not block repair-friendly reinstalls.
    }
  }
  foreach ($envPath in ($candidates | Select-Object -Unique)) {
    if (-not $script:PreservedSessionSecret) {
      $script:PreservedSessionSecret = Read-EnvValue $envPath 'SESSION_SECRET'
    }
    if (-not $script:PreservedSetupToken) {
      $script:PreservedSetupToken = Read-EnvValue $envPath 'AUTH_SETUP_TOKEN'
    }
  }
}

function Invoke-Quiet {
  param([string] $FilePath, [string[]] $Arguments, [string] $WorkingDirectory)
  Write-Log "$FilePath $($Arguments -join ' ')"
  $previous = Get-Location
  try {
    Set-Location $WorkingDirectory
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      Fail "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
    }
  } finally {
    Set-Location $previous
  }
}

function Invoke-NativeOutput {
  param([string] $FilePath, [string[]] $Arguments)
  $output = & $FilePath @Arguments 2>&1
  $code = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  $global:LASTEXITCODE = 0
  if ($code -ne 0) {
    $text = (($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
    throw "Command failed with exit code $code`: $FilePath $($Arguments -join ' ') $text"
  }
  return (($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
}

function Resolve-Node {
  $script:NodeExe = ''
  $script:NpmCmd = ''
  $script:NpxCmd = ''

  if (-not $InstallNode) {
    $systemNode = Command-Path 'node.exe'
    $systemNpm = Command-Path 'npm.cmd'
    $systemNpx = Command-Path 'npx.cmd'
    if ($systemNode -and $systemNpm -and $systemNpx) {
      try {
        $major = Invoke-NativeOutput $systemNode @('-p', "process.versions.node.split('.')[0]")
        if ([int]$major -ge $NodeMajor) {
          $script:NodeExe = $systemNode
          $script:NpmCmd = $systemNpm
          $script:NpxCmd = $systemNpx
          $script:NodeRuntimeSource = 'system'
          $script:NodeRuntimeVersion = Invoke-NativeOutput $systemNode @('-p', 'process.versions.node')
          $script:NodeRuntimeNpmVersion = Invoke-NativeOutput $systemNpm @('-v')
          $script:NodeRuntimeBinDir = Split-Path -Parent $systemNode
          $script:NodeRuntimeDir = ''
          Write-Log "Found Node.js v$NodeRuntimeVersion and npm $NodeRuntimeNpmVersion."
          return
        }
      } catch {
        # Fall through to private runtime.
      }
    }
  }

  if ($NoInstallNode) {
    Fail 'Node.js 22+ and npm are required. Re-run without -NoInstallNode to let the installer install a private Node runtime, or install Node from https://nodejs.org.'
  }

  Install-PrivateNode
}

function Use-PrivateNodeRuntime {
  param([string] $RuntimeDir, [string] $ExpectedVersion, [bool] $Reused)
  $nodeExe = Join-Path $RuntimeDir 'node.exe'
  $npmCmd = Join-Path $RuntimeDir 'npm.cmd'
  $npxCmd = Join-Path $RuntimeDir 'npx.cmd'
  $npmCli = Join-Path $RuntimeDir 'node_modules\npm\bin\npm-cli.js'
  $npxCli = Join-Path $RuntimeDir 'node_modules\npm\bin\npx-cli.js'
  $npmPrefix = Join-Path $RuntimeDir 'node_modules\npm\bin\npm-prefix.js'
  if (-not ((Test-Path $nodeExe) -and (Test-Path $npmCmd) -and (Test-Path $npxCmd) -and (Test-Path $npmCli) -and (Test-Path $npxCli) -and (Test-Path $npmPrefix))) {
    return $false
  }
  try {
    $actualVersion = Invoke-NativeOutput $nodeExe @('-p', 'process.versions.node')
    if ($ExpectedVersion -and $actualVersion -ne $ExpectedVersion) {
      return $false
    }
    $actualMajor = [int](Invoke-NativeOutput $nodeExe @('-p', "process.versions.node.split('.')[0]"))
    if ($actualMajor -lt $NodeMajor) {
      return $false
    }
    $npmVersion = Invoke-NativeOutput $nodeExe @($npmCli, '--version')
    Invoke-NativeOutput $nodeExe @($npxCli, '--version') | Out-Null
  } catch {
    $global:LASTEXITCODE = 0
    return $false
  }

  $script:NodeRuntimeSource = 'private'
  $script:NodeRuntimeVersion = $actualVersion
  $script:NodeRuntimeDir = $RuntimeDir
  $script:NodeRuntimeBinDir = $RuntimeDir
  $script:NodeExe = $nodeExe
  $script:NpmCmd = $npmCmd
  $script:NpxCmd = $npxCmd
  $script:NodeRuntimeNpmVersion = $npmVersion
  $env:Path = "$RuntimeDir;$env:Path"
  if ($Reused) {
    Write-Log "Reusing private Node.js v$actualVersion and npm $npmVersion."
  } else {
    Write-Log "Using private Node.js v$actualVersion and npm $npmVersion."
  }
  return $true
}

function Install-PrivateNode {
  $nodeArch = Resolve-Architecture
  $runtimeRoot = Join-Path $InstallDir 'runtime'
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "agent-cockpit-node-$([System.Guid]::NewGuid().ToString('n'))"
  Ensure-Directory $tmp
  try {
    $checksumsPath = Join-Path $tmp 'SHASUMS256.txt'
    $baseUrl = "https://nodejs.org/dist/latest-v$NodeMajor.x"
    Download-File "$baseUrl/SHASUMS256.txt" $checksumsPath
    $pattern = "^([a-fA-F0-9]{64})\s+node-v([0-9]+\.[0-9]+\.[0-9]+)-win-$nodeArch\.zip$"
    $matchLine = Get-Content -Path $checksumsPath | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if (-not $matchLine) {
      Fail "Could not find a Windows $nodeArch Node.js $NodeMajor ZIP in SHASUMS256.txt"
    }
    $zipName = ($matchLine -split '\s+')[1]
    $nodeVersion = [regex]::Match($zipName, '^node-v(.+)-win-.+\.zip$').Groups[1].Value
    $finalDir = Join-Path $runtimeRoot "node-v$nodeVersion-win-$nodeArch"
    if (Use-PrivateNodeRuntime $finalDir $nodeVersion $true) {
      return
    }

    $zipPath = Join-Path $tmp $zipName
    Download-File "$baseUrl/$zipName" $zipPath
    Assert-Checksum $zipPath $zipName $checksumsPath

    Ensure-Directory $runtimeRoot
    $extractRoot = Join-Path $runtimeRoot ".node-extract-$([System.Guid]::NewGuid().ToString('n'))"
    Ensure-Directory $extractRoot
    try {
      Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force
      $extracted = Join-Path $extractRoot "node-v$nodeVersion-win-$nodeArch"
      if (Test-Path $finalDir) {
        $repairDir = Join-Path $runtimeRoot "node-v$nodeVersion-win-$nodeArch-$([System.Guid]::NewGuid().ToString('n'))"
        Write-Log "Existing private Node.js runtime at $finalDir is not reusable; installing a fresh copy at $repairDir."
        $finalDir = $repairDir
      }
      Move-Item -Path $extracted -Destination $finalDir
    } finally {
      if (Test-Path $extractRoot) {
        Remove-Item -Recurse -Force $extractRoot
      }
    }

    if (-not (Use-PrivateNodeRuntime $finalDir $nodeVersion $false)) {
      Fail "Installed private Node.js runtime at $finalDir could not be verified."
    }
  } finally {
    if (Test-Path $tmp) {
      Remove-Item -Recurse -Force $tmp
    }
  }
}

function Runtime-Path {
  if ($NodeRuntimeBinDir) {
    return "$NodeRuntimeBinDir;$env:Path"
  }
  return $env:Path
}

function Env-Quote {
  param([string] $Value)
  return '`' + $Value.Replace('`', '\`') + '`'
}

function Write-WindowsRunnerScript {
  $binDir = Join-Path $InstallDir 'bin'
  Ensure-Directory $binDir
  $common = @"
Set-StrictMode -Version Latest
`$ErrorActionPreference = 'Stop'
`$InstallDir = '$($InstallDir.Replace("'", "''"))'
`$Install = Get-Content -Raw -Path (Join-Path `$InstallDir 'data\install.json') | ConvertFrom-Json
`$AppDir = `$Install.appDir
`$NodeBin = if (`$Install.nodeRuntime -and `$Install.nodeRuntime.binDir) { `$Install.nodeRuntime.binDir } else { '' }
if (`$NodeBin) { `$env:Path = "`$NodeBin;`$env:Path" }
function Resolve-NodeExe {
  if (`$NodeBin) {
    `$candidate = Join-Path `$NodeBin 'node.exe'
    if (Test-Path `$candidate) { return `$candidate }
  }
  return 'node.exe'
}
"@
  Set-Content -Path (Join-Path $binDir 'run-agent-cockpit.ps1') -Encoding UTF8 -Value ($common + @"
`$Node = Resolve-NodeExe
Set-Location `$AppDir
& `$Node '--import' 'tsx' 'server.ts'
`$code = if (`$null -eq `$LASTEXITCODE) { 0 } else { `$LASTEXITCODE }
exit `$code
"@)
}

function Write-EnvFile {
  param([string] $AppDir, [string] $DataDir, [string] $SessionSecret, [string] $SetupToken)
  $envPath = Join-Path $AppDir '.env'
  $lines = @(
    "PORT=$Port",
    "SESSION_SECRET=$SessionSecret",
    "AUTH_SETUP_TOKEN=$SetupToken",
    "AGENT_COCKPIT_DATA_DIR=$(Env-Quote $DataDir)",
    'WEB_BUILD_MODE=auto',
    'AUTH_ENABLE_LEGACY_OAUTH=false',
    "PM2_HOME=$(Env-Quote (Join-Path $InstallDir 'pm2'))"
  )
  if ($NodeRuntimeBinDir) {
    $lines += "PATH=$(Env-Quote (Runtime-Path))"
  }
  Set-Content -Path $envPath -Value ($lines -join [Environment]::NewLine) -Encoding UTF8
}

function Write-EcosystemConfig {
  param([string] $AppDir, [string] $DataDir, [string] $SessionSecret, [string] $SetupToken)
  $runnerScript = Join-Path $InstallDir 'bin\run-agent-cockpit.ps1'
  $config = [ordered]@{
    apps = @(
      [ordered]@{
        name = $AppName
        script = $runnerScript
        interpreter = 'powershell.exe'
        node_args = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File')
        cwd = $AppDir
        windowsHide = $true
        env = [ordered]@{
          PORT = $Port
          SESSION_SECRET = $SessionSecret
          AUTH_SETUP_TOKEN = $SetupToken
          AGENT_COCKPIT_DATA_DIR = $DataDir
          WEB_BUILD_MODE = 'auto'
          AUTH_ENABLE_LEGACY_OAUTH = 'false'
          PM2_HOME = (Join-Path $InstallDir 'pm2')
          PATH = (Runtime-Path)
        }
      }
    )
  }
  $json = $config | ConvertTo-Json -Depth 10
  Set-Content -Path (Join-Path $AppDir 'ecosystem.config.js') -Value "module.exports = $json;" -Encoding UTF8
}

function Write-InstallManifest {
  param([string] $DataDir, [string] $AppDir, [string] $InstallVersion, [string] $InstallSource, [string] $Branch)
  $nodeRuntime = $null
  if ($NodeRuntimeSource) {
    $nodeRuntime = [ordered]@{
      source = $NodeRuntimeSource
      version = if ($NodeRuntimeVersion) { $NodeRuntimeVersion } else { $null }
      npmVersion = if ($NodeRuntimeNpmVersion) { $NodeRuntimeNpmVersion } else { $null }
      binDir = if ($NodeRuntimeBinDir) { $NodeRuntimeBinDir } else { $null }
      runtimeDir = if ($NodeRuntimeDir) { $NodeRuntimeDir } else { $null }
      requiredMajor = $NodeMajor
      updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
  }
  $manifest = [ordered]@{
    schemaVersion = 1
    channel = $Channel
    source = $InstallSource
    repo = $Repo
    version = $InstallVersion
    branch = if ($Branch) { $Branch } else { $null }
    installDir = $InstallDir
    appDir = $AppDir
    dataDir = $DataDir
    installedAt = if ($script:PreservedInstalledAt) { $script:PreservedInstalledAt } else { (Get-Date).ToUniversalTime().ToString('o') }
    welcomeCompletedAt = if ($script:PreservedWelcomeCompletedAt) { $script:PreservedWelcomeCompletedAt } else { $null }
    nodeRuntime = $nodeRuntime
    startup = [ordered]@{
      kind = if ($NoAutoStart) { 'manual' } else { 'scheduled-task' }
      name = if ($NoAutoStart) { $null } else { $TaskName }
      scope = 'current-user'
    }
  }
  Write-JsonFile (Join-Path $DataDir 'install.json') $manifest
}

function Install-Dependencies {
  param([string] $AppDir)
  $env:NPM_CONFIG_AUDIT = 'false'
  $env:NPM_CONFIG_FUND = 'false'
  $env:NPM_CONFIG_LOGLEVEL = 'error'
  $env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  $env:PM2_HOME = Join-Path $InstallDir 'pm2'
  Write-Log 'Installing root dependencies.'
  Invoke-Quiet $NpmCmd @('ci', '--no-audit', '--no-fund', '--loglevel=error') $AppDir
  Write-Log 'Installing mobile PWA dependencies.'
  Invoke-Quiet $NpmCmd @('--prefix', 'mobile/AgentCockpitPWA', 'ci', '--no-audit', '--no-fund', '--loglevel=error') $AppDir
}

function Ensure-BuiltAssets {
  param([string] $AppDir, [bool] $ForceBuild)
  if ($ForceBuild -or -not (Test-Path (Join-Path $AppDir 'public/v2-built/index.html'))) {
    Write-Log 'Building desktop web assets.'
    Invoke-Quiet $NpmCmd @('run', 'web:build') $AppDir
  }
  if ($ForceBuild -or -not (Test-Path (Join-Path $AppDir 'public/mobile-built/index.html'))) {
    Write-Log 'Building mobile PWA assets.'
    Invoke-Quiet $NpmCmd @('run', 'mobile:build') $AppDir
  }
}

function Write-HelperScripts {
  $binDir = Join-Path $InstallDir 'bin'
  Ensure-Directory $binDir
  Write-WindowsRunnerScript
  $common = @"
Set-StrictMode -Version Latest
`$ErrorActionPreference = 'Stop'
`$InstallDir = '$($InstallDir.Replace("'", "''"))'
`$Install = Get-Content -Raw -Path (Join-Path `$InstallDir 'data\install.json') | ConvertFrom-Json
`$AppDir = `$Install.appDir
`$Pm2Home = Join-Path `$InstallDir 'pm2'
`$NodeBin = if (`$Install.nodeRuntime -and `$Install.nodeRuntime.binDir) { `$Install.nodeRuntime.binDir } else { '' }
if (`$NodeBin) { `$env:Path = "`$NodeBin;`$env:Path" }
`$env:PM2_HOME = `$Pm2Home
function Resolve-Npx {
  if (`$NodeBin) {
    `$candidate = Join-Path `$NodeBin 'npx.cmd'
    if (Test-Path `$candidate) { return `$candidate }
  }
  return 'npx.cmd'
}
function Invoke-CheckedNative {
  param([string] `$FilePath, [string[]] `$Arguments, [switch] `$AllowFailure)
  & `$FilePath @Arguments
  `$code = if (`$null -eq `$LASTEXITCODE) { 0 } else { `$LASTEXITCODE }
  if (`$code -ne 0 -and -not `$AllowFailure) {
    throw ("Command failed with exit code {0}: {1} {2}" -f `$code, `$FilePath, (`$Arguments -join ' '))
  }
  `$global:LASTEXITCODE = 0
}
"@
  Set-Content -Path (Join-Path $binDir 'start-agent-cockpit.ps1') -Encoding UTF8 -Value ($common + @"
`$Npx = Resolve-Npx
Invoke-CheckedNative `$Npx @('pm2', 'startOrRestart', (Join-Path `$AppDir 'ecosystem.config.js'), '--update-env')
Invoke-CheckedNative `$Npx @('pm2', 'save')
"@)
  Set-Content -Path (Join-Path $binDir 'stop-agent-cockpit.ps1') -Encoding UTF8 -Value ($common + @"
`$Npx = Resolve-Npx
Invoke-CheckedNative `$Npx @('pm2', 'delete', 'agent-cockpit') -AllowFailure
Invoke-CheckedNative `$Npx @('pm2', 'save')
"@)
  Set-Content -Path (Join-Path $binDir 'logs-agent-cockpit.ps1') -Encoding UTF8 -Value ($common + @"
`$Npx = Resolve-Npx
& `$Npx pm2 logs agent-cockpit --lines 100
"@)
}

function Register-LogonTask {
  if ($NoAutoStart) {
    Write-Log 'Skipping logon startup registration.'
    return
  }
  $startScript = Join-Path $InstallDir 'bin\start-agent-cockpit.ps1'
  $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  Write-Log "Registering current-user logon task $TaskName."
  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Description 'Start Agent Cockpit when this Windows user logs in.' -Force | Out-Null
  } catch {
    $taskRun = "powershell.exe $arguments"
    schtasks.exe /Create /TN $TaskName /SC ONLOGON /RU $currentUser /TR $taskRun /RL LIMITED /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Fail "Failed to register current-user logon task with schtasks.exe (exit code $LASTEXITCODE)."
    }
  }
}

function Invoke-Pm2BestEffort {
  param([string] $AppDir, [string[]] $Arguments)
  if (-not $NpxCmd -or -not (Test-Path $AppDir)) {
    return
  }
  $env:PM2_HOME = Join-Path $InstallDir 'pm2'
  if ($NodeRuntimeBinDir) {
    $env:Path = "$NodeRuntimeBinDir;$env:Path"
  }
  $previous = Get-Location
  try {
    Set-Location $AppDir
    & $NpxCmd @Arguments
    if ($LASTEXITCODE -ne 0) {
      Write-Log "Ignoring PM2 cleanup exit code $LASTEXITCODE for: $NpxCmd $($Arguments -join ' ')"
    }
    $global:LASTEXITCODE = 0
  } catch {
    Write-Log "Ignoring PM2 cleanup error: $($_.Exception.Message)"
    $global:LASTEXITCODE = 0
  } finally {
    Set-Location $previous
  }
}

function Stop-ExistingAppForReplacement {
  param([string] $AppDir)
  if (-not (Test-Path $AppDir)) {
    return
  }
  Write-Log 'Stopping existing Agent Cockpit process before replacing app files.'
  Invoke-Pm2BestEffort $AppDir @('--no-install', 'pm2', 'stop', $AppName)
}

function Start-Pm2 {
  param([string] $AppDir)
  $env:PM2_HOME = Join-Path $InstallDir 'pm2'
  if ($NodeRuntimeBinDir) {
    $env:Path = "$NodeRuntimeBinDir;$env:Path"
  }
  Write-Log 'Starting Agent Cockpit with local PM2.'
  Invoke-Quiet $NpxCmd @('pm2', 'startOrRestart', 'ecosystem.config.js', '--update-env') $AppDir
  Invoke-Quiet $NpxCmd @('pm2', 'save') $AppDir
}

function Wait-ForServer {
  param([string] $AppDir)
  $url = "http://127.0.0.1:$Port/auth/setup"
  Write-Log "Waiting for Agent Cockpit to answer at $url."
  for ($i = 0; $i -lt 90; $i++) {
    try {
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $url | Out-Null
      return
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  Write-Log 'Agent Cockpit did not answer before timeout; collecting PM2 diagnostics.'
  Invoke-Pm2BestEffort $AppDir @('--no-install', 'pm2', 'describe', $AppName)
  Invoke-Pm2BestEffort $AppDir @('--no-install', 'pm2', 'logs', $AppName, '--lines', '80', '--nostream')
  $logs = Join-Path $InstallDir 'bin\logs-agent-cockpit.ps1'
  Fail "Agent Cockpit did not answer at $url. Check logs with: powershell -NoProfile -ExecutionPolicy Bypass -File `"$logs`""
}

function Open-Setup {
  param([string] $SetupToken)
  $url = "http://localhost:$Port/auth/setup"
  Write-Log "First-run setup token: $SetupToken"
  Write-Log "Agent Cockpit is ready at $url"
  if (-not $SkipOpen) {
    Start-Process $url
  }
}

function Existing-OrNewSecret {
  param([string] $AppDir, [string] $Name, [int] $Bytes)
  if ($Name -eq 'SESSION_SECRET' -and $script:PreservedSessionSecret) {
    return $script:PreservedSessionSecret
  }
  if ($Name -eq 'AUTH_SETUP_TOKEN' -and $script:PreservedSetupToken) {
    return $script:PreservedSetupToken
  }
  $existing = Read-EnvValue (Join-Path $AppDir '.env') $Name
  if ($existing) {
    return $existing
  }
  return New-RandomHex $Bytes
}

function Configure-App {
  param([string] $AppDir, [string] $DataDir, [string] $InstallVersion, [string] $InstallSource, [string] $Branch, [bool] $ForceBuild)
  Ensure-Directory $DataDir
  $sessionSecret = Existing-OrNewSecret $AppDir 'SESSION_SECRET' 48
  $setupToken = Existing-OrNewSecret $AppDir 'AUTH_SETUP_TOKEN' 32
  Install-Dependencies $AppDir
  Ensure-BuiltAssets $AppDir $ForceBuild
  Write-EnvFile $AppDir $DataDir $sessionSecret $setupToken
  Write-EcosystemConfig $AppDir $DataDir $sessionSecret $setupToken
  Write-InstallManifest $DataDir $AppDir $InstallVersion $InstallSource $Branch
  Write-HelperScripts
  Register-LogonTask
  Start-Pm2 $AppDir
  Wait-ForServer $AppDir
  Open-Setup $setupToken
}

function Install-Production {
  $releasesDir = Join-Path $InstallDir 'releases'
  $dataDir = Join-Path $InstallDir 'data'
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "agent-cockpit-release-$([System.Guid]::NewGuid().ToString('n'))"
  Ensure-Directory $tmp
  try {
    if ($Version) {
      $releaseBase = "https://github.com/$Repo/releases/download/v$($Version.TrimStart('v'))"
    } else {
      $releaseBase = "https://github.com/$Repo/releases/latest/download"
    }
    $manifestPath = Join-Path $tmp 'release-manifest.json'
    $checksumsPath = Join-Path $tmp 'SHA256SUMS'
    Download-File "$releaseBase/release-manifest.json" $manifestPath
    Download-File "$releaseBase/SHA256SUMS" $checksumsPath
    Assert-Checksum $manifestPath 'release-manifest.json' $checksumsPath
    $manifest = Read-JsonFile $manifestPath
    $zipArtifact = $manifest.artifacts | Where-Object { ($_.role -eq 'app-zip') -or ($_.platform -eq 'win32' -and $_.format -eq 'zip') } | Select-Object -First 1
    if (-not $zipArtifact) {
      Fail 'Release manifest does not include a Windows app ZIP artifact.'
    }
    $zipPath = Join-Path $tmp $zipArtifact.name
    Download-File "$releaseBase/$($zipArtifact.name)" $zipPath
    Assert-Checksum $zipPath $zipArtifact.name $checksumsPath
    $actualZipSha = Get-Sha256 $zipPath
    if ($zipArtifact.sha256 -and $actualZipSha -ne $zipArtifact.sha256.ToLowerInvariant()) {
      Fail "Release manifest checksum mismatch for $($zipArtifact.name)"
    }
    Ensure-Directory $releasesDir
    Ensure-Directory $dataDir
    $extractRoot = Join-Path $tmp 'extract'
    Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force
    $packageRoot = $manifest.packageRoot
    $extracted = Join-Path $extractRoot $packageRoot
    if (-not (Test-Path (Join-Path $extracted 'server.ts'))) {
      Fail 'Extracted release is missing server.ts'
    }
    $appDir = Join-Path $releasesDir $packageRoot
    Capture-ExistingRuntimeConfig $dataDir $appDir
    if (Test-Path $appDir) {
      Stop-ExistingAppForReplacement $appDir
      Remove-Item -Recurse -Force $appDir
    }
    Move-Item -Path $extracted -Destination $appDir
    Configure-App $appDir $dataDir $manifest.version 'github-release' '' $false
  } finally {
    if (Test-Path $tmp) {
      Remove-Item -Recurse -Force $tmp
    }
  }
}

function Install-Dev {
  $dataDir = Join-Path $InstallDir 'data'
  Ensure-Directory $InstallDir
  Ensure-Directory $dataDir
  $git = Command-Path 'git.exe'
  if (-not $git) {
    Fail 'git is required for dev installs. Install Git for Windows, then retry.'
  }
  $devParent = Split-Path -Parent $DevDir
  Ensure-Directory $devParent
  if (-not (Test-Path (Join-Path $DevDir '.git'))) {
    Write-Log "Cloning $Repo into $DevDir."
    Invoke-Quiet $git @('clone', "https://github.com/$Repo.git", $DevDir) $devParent
  } else {
    Write-Log "Updating existing dev checkout at $DevDir."
    Invoke-Quiet $git @('-C', $DevDir, 'fetch', 'origin', 'main') $DevDir
    Invoke-Quiet $git @('-C', $DevDir, 'checkout', 'main') $DevDir
    Invoke-Quiet $git @('-C', $DevDir, 'pull', '--ff-only', 'origin', 'main') $DevDir
  }
  Capture-ExistingRuntimeConfig $dataDir $DevDir
  $devVersion = (& $NodeExe -e "process.stdout.write(require(process.argv[1]).version)" (Join-Path $DevDir 'package.json')).Trim()
  Configure-App $DevDir $dataDir $devVersion 'git-main' 'main' $true
}

if ($InstallNode -and $NoInstallNode) {
  Fail 'Use either -InstallNode or -NoInstallNode, not both.'
}

Require-Windows
Resolve-Architecture | Out-Null
Resolve-Node

if ($Channel -eq 'production') {
  Install-Production
} else {
  Install-Dev
}
