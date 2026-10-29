param(
  [ValidateSet('production', 'dev')]
  [string] $Channel = 'production',

  [string] $Version = '',
  [string] $Repo = 'daronyondem/agent-cockpit',
  [string] $InstallDir = "$env:LOCALAPPDATA\Agent Cockpit",
  [string] $DevDir = "$env:USERPROFILE\agent-cockpit",
  [ValidateRange(1, 65535)]
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
$PreviousAppDir = ''
$InstallLog = ''
$WorkDir = ''
$RollbackCandidateStopped = $false
$PortExplicit = $PSBoundParameters.ContainsKey('Port')

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$DevDir = [System.IO.Path]::GetFullPath($DevDir)

function Write-Log {
  param([string] $Message)
  Write-Host "[agent-cockpit] $Message"
  if ($script:InstallLog) {
    Add-Content -Path $script:InstallLog -Value "[agent-cockpit] $Message"
  }
}

function Fail {
  param([string] $Message)
  throw "[agent-cockpit] ERROR: $Message"
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
  if ($env:AGENT_COCKPIT_INSTALL_TEST_RELEASE_DIR -and $Url -like 'https://github.com/*/releases/*') {
    Copy-Item (Join-Path $env:AGENT_COCKPIT_INSTALL_TEST_RELEASE_DIR ([System.IO.Path]::GetFileName($Url))) $Destination
    return
  }
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -Uri $Url -OutFile $Destination
      return
    } catch {
      if ($attempt -eq 2) { throw }
      Start-Sleep -Seconds 2
    }
  }
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

function Expand-ZipFile {
  param([string] $Path, [string] $DestinationPath)
  Ensure-Directory $DestinationPath
  Write-Log "Extracting $Path"
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Path, $DestinationPath)
  } catch {
    Fail "Failed to extract $Path`: $($_.Exception.Message)"
  }
}

function Read-JsonFile {
  param([string] $Path)
  return Get-Content -Raw -Path $Path | ConvertFrom-Json
}

function Write-JsonFile {
  param([string] $Path, [object] $Value)
  Ensure-Directory ([System.IO.Path]::GetDirectoryName($Path))
  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText("$Path.tmp", $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -Force "$Path.tmp" $Path
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
        $script:PreviousAppDir = [string]$install.appDir
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
      Expand-ZipFile $zipPath $extractRoot
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
  $cliToolsDir = Join-Path $InstallDir 'cli-tools'
  $parts = @($cliToolsDir)
  if ($NodeRuntimeBinDir) {
    $parts += $NodeRuntimeBinDir
  }
  if ($env:APPDATA) {
    $parts += (Join-Path $env:APPDATA 'npm')
  }
  foreach ($part in ($env:Path -split ';')) {
    if ($part -and -not ($parts -contains $part)) {
      $parts += $part
    }
  }
  return ($parts -join ';')
}

function Normalize-PathEntry {
  param([string] $Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  return $Value.Trim().TrimEnd('\', '/').ToLowerInvariant()
}

function Notify-EnvironmentChanged {
  try {
    $signature = @'
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, UInt32 Msg, UIntPtr wParam, string lParam, UInt32 fuFlags, UInt32 uTimeout, out UIntPtr lpdwResult);
'@
    $type = Add-Type -MemberDefinition $signature -Name NativeMethods -Namespace AgentCockpit -PassThru
    $result = [UIntPtr]::Zero
    [void]$type::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  } catch {
    Write-Log "Updated user PATH but could not broadcast environment change: $($_.Exception.Message)"
  }
}

function Ps-SingleQuote {
  param([string] $Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Write-TextFile {
  param([string] $Path, [string] $Value)
  Ensure-Directory ([System.IO.Path]::GetDirectoryName($Path))
  [System.IO.File]::WriteAllText($Path, $Value, (New-Object System.Text.UTF8Encoding($false)))
}

function Ensure-UserPathEntry {
  param([string] $Entry)
  if ([string]::IsNullOrWhiteSpace($Entry)) { return }
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  if ($current) {
    $parts = @($current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }
  $key = Normalize-PathEntry $Entry
  $filtered = @($parts | Where-Object { (Normalize-PathEntry $_) -ne $key })
  $next = [string]::Join(';', (@($Entry) + $filtered))
  if ($next -ne $current) {
    [Environment]::SetEnvironmentVariable('Path', $next, 'User')
    Notify-EnvironmentChanged
    Write-Log "Added $Entry to the current user PATH."
  }
}

function Env-Quote {
  param([string] $Value)
  return '`' + $Value.Replace('`', '\`') + '`'
}

function Repair-CliToolWrappers {
  $cliToolsDir = Join-Path $InstallDir 'cli-tools'
  if (-not (Test-Path $cliToolsDir)) {
    return
  }
  if (-not $NodeExe -or -not (Test-Path $NodeExe)) {
    Write-Log 'Skipping CLI wrapper repair because Node.js is not resolved.'
    return
  }

  $updated = @()
  $codexJs = Join-Path $cliToolsDir 'node_modules\@openai\codex\bin\codex.js'
  if (Test-Path $codexJs) {
    $codexPs1 = @"
`$ErrorActionPreference = "Stop"
`$node = $(Ps-SingleQuote $NodeExe)
`$target = $(Ps-SingleQuote $codexJs)
if (-not (Test-Path -LiteralPath `$node)) {
  Write-Error "Agent Cockpit private Node.js runtime was not found. Rerun the Agent Cockpit installer or self-update."
  exit 1
}
if (-not (Test-Path -LiteralPath `$target)) {
  Write-Error "Codex CLI package entrypoint was not found. Reinstall Codex from Agent Cockpit."
  exit 1
}
`$nodeDir = Split-Path -Parent `$node
`$env:PATH = "`$nodeDir;`$env:PATH"
& `$node `$target @args
exit `$LASTEXITCODE
"@
    $codexCmd = @"
@ECHO off
SETLOCAL
SET "NODE_EXE=$NodeExe"
SET "CODEX_JS=$codexJs"
IF NOT EXIST "%NODE_EXE%" (
  ECHO Agent Cockpit private Node.js runtime was not found. Rerun the Agent Cockpit installer or self-update. 1>&2
  EXIT /B 1
)
IF NOT EXIST "%CODEX_JS%" (
  ECHO Codex CLI package entrypoint was not found. Reinstall Codex from Agent Cockpit. 1>&2
  EXIT /B 1
)
FOR %%I IN ("%NODE_EXE%") DO SET "PATH=%%~dpI;%PATH%"
"%NODE_EXE%" "%CODEX_JS%" %*
EXIT /B %ERRORLEVEL%
"@
    Write-TextFile (Join-Path $cliToolsDir 'codex.ps1') ($codexPs1 + [Environment]::NewLine)
    Write-TextFile (Join-Path $cliToolsDir 'codex.cmd') ($codexCmd + [Environment]::NewLine)
    $updated += 'codex'
  }

  $claudeExe = Join-Path $cliToolsDir 'node_modules\@anthropic-ai\claude-code\bin\claude.exe'
  if (Test-Path $claudeExe) {
    $claudePs1 = @"
`$ErrorActionPreference = "Stop"
`$target = $(Ps-SingleQuote $claudeExe)
if (-not (Test-Path -LiteralPath `$target)) {
  Write-Error "Claude Code CLI executable was not found. Reinstall Claude Code from Agent Cockpit."
  exit 1
}
& `$target @args
exit `$LASTEXITCODE
"@
    $claudeCmd = @"
@ECHO off
SETLOCAL
SET "TARGET=$claudeExe"
IF NOT EXIST "%TARGET%" (
  ECHO Claude Code CLI executable was not found. Reinstall Claude Code from Agent Cockpit. 1>&2
  EXIT /B 1
)
"%TARGET%" %*
EXIT /B %ERRORLEVEL%
"@
    Write-TextFile (Join-Path $cliToolsDir 'claude.ps1') ($claudePs1 + [Environment]::NewLine)
    Write-TextFile (Join-Path $cliToolsDir 'claude.cmd') ($claudeCmd + [Environment]::NewLine)
    $updated += 'claude'
  }

  $grokJs = Join-Path $cliToolsDir 'node_modules\@xai-official\grok\bin\grok'
  if (Test-Path $grokJs) {
    $grokPs1 = @"
`$ErrorActionPreference = "Stop"
`$node = $(Ps-SingleQuote $NodeExe)
`$target = $(Ps-SingleQuote $grokJs)
if (-not (Test-Path -LiteralPath `$node)) {
  Write-Error "Agent Cockpit private Node.js runtime was not found. Rerun the Agent Cockpit installer or self-update."
  exit 1
}
if (-not (Test-Path -LiteralPath `$target)) {
  Write-Error "Grok Build CLI package entrypoint was not found. Reinstall Grok Build from Agent Cockpit."
  exit 1
}
`$nodeDir = Split-Path -Parent `$node
`$env:PATH = "`$nodeDir;`$env:PATH"
& `$node `$target @args
exit `$LASTEXITCODE
"@
    $grokCmd = @"
@ECHO off
SETLOCAL
SET "NODE_EXE=$NodeExe"
SET "GROK_JS=$grokJs"
IF NOT EXIST "%NODE_EXE%" (
  ECHO Agent Cockpit private Node.js runtime was not found. Rerun the Agent Cockpit installer or self-update. 1>&2
  EXIT /B 1
)
IF NOT EXIST "%GROK_JS%" (
  ECHO Grok Build CLI package entrypoint was not found. Reinstall Grok Build from Agent Cockpit. 1>&2
  EXIT /B 1
)
FOR %%I IN ("%NODE_EXE%") DO SET "PATH=%%~dpI;%PATH%"
"%NODE_EXE%" "%GROK_JS%" %*
EXIT /B %ERRORLEVEL%
"@
    Write-TextFile (Join-Path $cliToolsDir 'grok.ps1') ($grokPs1 + [Environment]::NewLine)
    Write-TextFile (Join-Path $cliToolsDir 'grok.cmd') ($grokCmd + [Environment]::NewLine)
    $updated += 'grok'
  }

  if ($updated.Count -gt 0) {
    Write-Log "Repaired Windows CLI wrapper(s): $($updated -join ', ')."
  }
}

function Vbs-Quote {
  param([string] $Value)
  return '"' + $Value.Replace('"', '""') + '"'
}

function Write-WindowsRunnerScript {
  param([string] $AppDir)
  $binDir = Join-Path $InstallDir 'bin'
  $logDir = Join-Path $InstallDir 'pm2\logs'
  Ensure-Directory $binDir
  Ensure-Directory $logDir
  $nodeForRunner = if ($NodeExe) { $NodeExe } else { 'node.exe' }
  $outLog = Join-Path $logDir 'agent-cockpit-runner-out.log'
  $errLog = Join-Path $logDir 'agent-cockpit-runner-error.log'
  $script = @"
Option Explicit
Dim shell, nodeExe, appDir, outLog, errLog, comspec, cmd, exitCode
Set shell = CreateObject("WScript.Shell")
nodeExe = $(Vbs-Quote $nodeForRunner)
appDir = $(Vbs-Quote $AppDir)
outLog = $(Vbs-Quote $outLog)
errLog = $(Vbs-Quote $errLog)
shell.CurrentDirectory = appDir
comspec = shell.ExpandEnvironmentStrings("%ComSpec%")
cmd = Q(comspec) & " /d /s /c " & Q(Q(nodeExe) & " --import tsx server.ts >> " & Q(outLog) & " 2>> " & Q(errLog))
exitCode = shell.Run(cmd, 0, True)
WScript.Quit exitCode

Function Q(value)
  Q = Chr(34) & value & Chr(34)
End Function
"@
  Set-Content -Path (Join-Path $binDir 'run-agent-cockpit.vbs') -Encoding ASCII -Value $script
}

function Write-EnvFile {
  param([string] $AppDir, [string] $DataDir, [string] $SessionSecret, [string] $SetupToken)
  $envPath = Join-Path $AppDir '.env'
  $cliToolsDir = Join-Path $InstallDir 'cli-tools'
  Ensure-Directory $cliToolsDir
  Ensure-UserPathEntry $cliToolsDir
  $preserved = @()
  if (Test-Path $envPath) {
    $preserved = @(Get-Content $envPath | Where-Object { $_ -notmatch '^(PORT|SESSION_SECRET|AUTH_SETUP_TOKEN|AGENT_COCKPIT_DATA_DIR|WEB_BUILD_MODE|AUTH_ENABLE_LEGACY_OAUTH|PM2_HOME|PATH)=' })
  }
  $lines = $preserved + @(
    "PORT=$Port",
    "SESSION_SECRET=$SessionSecret",
    "AUTH_SETUP_TOKEN=$SetupToken",
    "AGENT_COCKPIT_DATA_DIR=$(Env-Quote $DataDir)",
    'WEB_BUILD_MODE=auto',
    'AUTH_ENABLE_LEGACY_OAUTH=false',
    "PM2_HOME=$(Env-Quote (Join-Path $InstallDir 'pm2'))",
    "PATH=$(Env-Quote (Runtime-Path))"
  )
  Set-Content -Path $envPath -Value ($lines -join [Environment]::NewLine) -Encoding UTF8
}

function Write-EcosystemConfig {
  param([string] $AppDir, [string] $DataDir, [string] $SessionSecret, [string] $SetupToken)
  $runnerScript = Join-Path $InstallDir 'bin\run-agent-cockpit.vbs'
  $config = [ordered]@{
    apps = @(
      [ordered]@{
        name = $AppName
        script = $runnerScript
        interpreter = 'wscript.exe'
        node_args = @('//B', '//NoLogo')
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
  if ($Channel -eq 'dev' -or -not (Test-Path (Join-Path $AppDir 'public/mobile-built/index.html'))) {
    Write-Log 'Installing mobile PWA dependencies.'
    Invoke-Quiet $NpmCmd @('--prefix', 'mobile/AgentCockpitPWA', 'ci', '--no-audit', '--no-fund', '--loglevel=error') $AppDir
  }
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
  param([string] $AppDir)
  $binDir = Join-Path $InstallDir 'bin'
  Ensure-Directory $binDir
  Write-WindowsRunnerScript $AppDir
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
function Resolve-Pm2 {
  `$candidate = Join-Path `$AppDir 'node_modules\.bin\pm2.cmd'
  if (Test-Path `$candidate) { return `$candidate }
  throw "Local PM2 command is missing at `$candidate. Run npm ci in `$AppDir, then retry."
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
`$Pm2 = Resolve-Pm2
Invoke-CheckedNative `$Pm2 @('delete', 'agent-cockpit') -AllowFailure
Invoke-CheckedNative `$Pm2 @('startOrRestart', (Join-Path `$AppDir 'ecosystem.config.js'), '--update-env')
Invoke-CheckedNative `$Pm2 @('save')
"@)
  Set-Content -Path (Join-Path $binDir 'stop-agent-cockpit.ps1') -Encoding UTF8 -Value ($common + @"
`$Pm2 = Resolve-Pm2
Invoke-CheckedNative `$Pm2 @('delete', 'agent-cockpit') -AllowFailure
Invoke-CheckedNative `$Pm2 @('save')
"@)
  Set-Content -Path (Join-Path $binDir 'logs-agent-cockpit.ps1') -Encoding UTF8 -Value ($common + @"
`$Pm2 = Resolve-Pm2
`$runnerOut = Join-Path `$Pm2Home 'logs\agent-cockpit-runner-out.log'
`$runnerErr = Join-Path `$Pm2Home 'logs\agent-cockpit-runner-error.log'
foreach (`$logPath in @(`$runnerOut, `$runnerErr)) {
  if (Test-Path `$logPath) {
    Write-Host "=== `$logPath ==="
    Get-Content -Path `$logPath -Tail 100
  }
}
& `$Pm2 logs agent-cockpit --lines 100
"@)
}

function Test-LogonTaskOwnership {
  param([object] $Task)
  if (-not $Task -or -not $Task.PSObject.Properties['Actions']) { return $false }
  $expected = Normalize-PathEntry (Resolve-InstallPath (Join-Path $InstallDir 'bin\start-agent-cockpit.ps1') -AllowMissing)
  if (-not $expected) { return $false }
  foreach ($action in @($Task.Actions)) {
    if (-not $action.PSObject.Properties['Arguments']) { continue }
    $match = [regex]::Match([string]$action.Arguments, '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
    if (-not $match.Success) { continue }
    $target = ($match.Groups | Select-Object -Skip 1 | Where-Object { $_.Success } | Select-Object -First 1).Value
    try {
      $actual = Normalize-PathEntry (Resolve-InstallPath ([Environment]::ExpandEnvironmentVariables($target)) -AllowMissing)
      if ($actual -and $actual -eq $expected) { return $true }
    } catch { continue }
  }
  return $false
}

function Register-LogonTask {
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
  if ($task -and -not (Test-LogonTaskOwnership $task)) {
    if ($NoAutoStart) {
      Write-Log 'Leaving the startup task for a different installation unchanged.'
      return
    }
    Fail 'The existing startup task belongs to another installation. It will not be replaced.'
  }
  if ($NoAutoStart) {
    if ($task) {
      Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false
    }
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
  param([string] $AppDir, [string[]] $Arguments, [switch] $PassThru)
  if (-not (Test-Path $AppDir)) {
    if ($PassThru) { return $false }
    return
  }
  $pm2Cmd = Join-Path $AppDir 'node_modules\.bin\pm2.cmd'
  if (-not (Test-Path $pm2Cmd)) {
    Write-Log "Skipping PM2 cleanup for $AppDir because local PM2 is not installed yet."
    if ($PassThru) { return $false }
    return
  }
  $env:PM2_HOME = Join-Path $InstallDir 'pm2'
  if ($NodeRuntimeBinDir) {
    $env:Path = "$NodeRuntimeBinDir;$env:Path"
  }
  $previous = Get-Location
  $succeeded = $false
  try {
    Set-Location $AppDir
    if ($PassThru) { & $pm2Cmd @Arguments > $null } else { & $pm2Cmd @Arguments }
    $succeeded = $LASTEXITCODE -eq 0
    if ($LASTEXITCODE -ne 0) {
      Write-Log "Ignoring PM2 cleanup exit code $LASTEXITCODE for: $pm2Cmd $($Arguments -join ' ')"
    }
    $global:LASTEXITCODE = 0
  } catch {
    Write-Log "Ignoring PM2 cleanup error: $($_.Exception.Message)"
    $global:LASTEXITCODE = 0
  } finally {
    Set-Location $previous
  }
  if ($PassThru) { return $succeeded }
}

function Start-Pm2 {
  param([string] $AppDir)
  $env:PM2_HOME = Join-Path $InstallDir 'pm2'
  if ($NodeRuntimeBinDir) {
    $env:Path = "$NodeRuntimeBinDir;$env:Path"
  }
  Write-Log 'Starting Agent Cockpit with local PM2.'
  Invoke-Pm2BestEffort $AppDir @('delete', $AppName)
  $pm2Cmd = Join-Path $AppDir 'node_modules\.bin\pm2.cmd'
  if (-not (Test-Path $pm2Cmd)) {
    Fail "Local PM2 command is missing at $pm2Cmd after dependency install."
  }
  Invoke-Quiet $pm2Cmd @('startOrRestart', 'ecosystem.config.js', '--update-env') $AppDir
  Invoke-Quiet $pm2Cmd @('save') $AppDir
}

function Wait-ForServer {
  param([string] $AppDir, [string] $ExpectedVersion, [int] $Attempts = 90)
  $url = "http://127.0.0.1:$Port/auth/setup"
  Write-Log "Waiting for Agent Cockpit to answer at $url."
  for ($i = 0; $i -lt $Attempts; $i++) {
    $version = Read-HttpJson "http://127.0.0.1:$Port/api/chat/version"
    if ($version -and $version.PSObject.Properties['version'] -and $version.version -ceq $ExpectedVersion -and (Test-HttpReady $url)) {
      return
    }
    Start-Sleep -Seconds 1
  }
  Write-Log 'Agent Cockpit did not answer before timeout; collecting PM2 diagnostics.'
  Invoke-Pm2BestEffort $AppDir @('describe', $AppName)
  Invoke-Pm2BestEffort $AppDir @('logs', $AppName, '--lines', '80', '--nostream')
  foreach ($logName in @('agent-cockpit-runner-out.log', 'agent-cockpit-runner-error.log')) {
    $logPath = Join-Path (Join-Path $InstallDir 'pm2\logs') $logName
    if (Test-Path $logPath) {
      Write-Log "Last lines from $logPath"
      Get-Content -Path $logPath -Tail 80
    }
  }
  $logs = Join-Path $InstallDir 'bin\logs-agent-cockpit.ps1'
  Fail "Agent Cockpit did not answer at $url. Check logs with: powershell -NoProfile -ExecutionPolicy Bypass -File `"$logs`""
}

function Test-HttpReady {
  param([string] $Url)
  $request = $null
  $response = $null
  try {
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.Method = 'GET'
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    $request.AllowAutoRedirect = $true
    $response = $request.GetResponse()
    $statusCode = [int]$response.StatusCode
    return ($statusCode -ge 200 -and $statusCode -lt 400)
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) {
      $response = $_.Exception.Response
      $statusCode = [int]$response.StatusCode
      return ($statusCode -ge 200 -and $statusCode -lt 400)
    }
    return $false
  } catch {
    return $false
  } finally {
    if ($response) {
      $response.Close()
    }
  }
}

function Read-HttpJson {
  param([string] $Url)
  $response = $null
  $reader = $null
  try {
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    $response = $request.GetResponse()
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    return ($reader.ReadToEnd() | ConvertFrom-Json)
  } catch {
    return $null
  } finally {
    if ($reader) { $reader.Dispose() }
    if ($response) { $response.Close() }
  }
}

function Resolve-InstallPath {
  param([string] $Value, [switch] $AllowMissing)
  if (-not $Value -or -not $NodeExe) { return '' }
  $code = @'
const fs = require('fs'), path = require('path');
let current = path.resolve(process.argv[1]), missing = [];
for (;;) {
  try { process.stdout.write(path.join(fs.realpathSync(current), ...missing)); break; }
  catch (error) {
    if (process.argv[2] !== 'allow-missing' || error.code !== 'ENOENT' || path.dirname(current) === current) throw error;
    missing.unshift(path.basename(current)); current = path.dirname(current);
  }
}
'@
  $mode = if ($AllowMissing) { 'allow-missing' } else { 'existing' }
  try {
    return Invoke-NativeOutput $NodeExe @('-e', $code, '--', $Value, $mode)
  } catch { return '' }
}

function Get-OwnedPm2App {
  param([int] $ExpectedPort = 0)
  if (-not $NodeExe) { return '' }
  $code = @'
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const { root, previous, dev, expected } = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
function canonical(value) {
  try { const result = fs.realpathSync(value); return process.platform === 'win32' ? result.toLowerCase() : result; } catch { return null; }
}
function alive(pid) { try { if (!Number.isInteger(pid) || pid <= 0) return false; process.kill(pid, 0); return true; } catch { return false; } }
try {
  const home = path.join(root, 'pm2');
  if (!alive(Number(fs.readFileSync(path.join(home, 'pm2.pid'), 'utf8')))) process.exit();
  const releases = path.join(root, 'releases');
  const candidates = [previous, dev, ...(fs.existsSync(releases) ? fs.readdirSync(releases).map(name => path.join(releases, name)) : [])].filter(Boolean);
  const cli = candidates.map(dir => path.join(dir, 'node_modules/pm2/bin/pm2')).find(file => fs.existsSync(file));
  if (!cli) process.exit();
  // Query existing RPC directly; invoking the CLI can start a missing daemon.
  const query = `
const path = require('path'), root = process.argv[1];
const socket = require(path.join(root, 'modules/pm2-axon')).socket('req');
const client = new (require(path.join(root, 'modules/pm2-axon-rpc')).Client)(socket);
let finished = false;
function finish(error, list) {
  if (finished) return;
  finished = true; socket.close();
  if (error) process.exit(1);
  process.stdout.write(JSON.stringify(list), () => process.exit(0));
}
socket.once('error', finish);
socket.once('reconnect attempt', () => finish(new Error('Daemon unavailable')));
socket.once('connect', () => client.call('getMonitorData', {}, finish));
socket.connect(require(path.join(root, 'constants.js')).DAEMON_RPC_PORT);
`;
  const output = execFileSync(process.execPath, ['-e', query, '--', path.dirname(path.dirname(cli))], { timeout: 3000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PM2_HOME: home } });
  const releaseRoot = canonical(releases), data = canonical(path.join(root, 'data'));
  for (const entry of JSON.parse(output.toString())) {
    const env = entry.pm2_env || {}, cwd = canonical(env.pm_cwd);
    if (entry.name !== 'agent-cockpit' || env.status !== 'online' || !alive(entry.pid) || !cwd || !data) continue;
    if (Number(expected) && Number(env.PORT ?? env.env?.PORT) !== Number(expected)) continue;
    if (canonical(env.AGENT_COCKPIT_DATA_DIR ?? env.env?.AGENT_COCKPIT_DATA_DIR) !== data) continue;
    if (cwd === canonical(previous) || cwd === canonical(dev) || (releaseRoot && cwd.startsWith(releaseRoot + path.sep))) {
      process.stdout.write(fs.realpathSync(env.pm_cwd)); break;
    }
  }
} catch {}
'@
  $inputJson = @{ root = $InstallDir; previous = $script:PreviousAppDir; dev = $DevDir; expected = $ExpectedPort } | ConvertTo-Json -Compress
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($inputJson))
  try { return Invoke-NativeOutput $NodeExe @('-e', $code, $encoded) } catch { return '' }
}

function Test-InstallPreflight {
  if (-not $script:PortExplicit -and $script:PreviousAppDir) {
    $existingPort = Read-EnvValue (Join-Path $script:PreviousAppDir '.env') 'PORT'
    if ($existingPort) { $script:Port = [int]$existingPort }
  }
  if ($Port -lt 1 -or $Port -gt 65535) { Fail 'Port must be from 1 to 65535.' }
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
  try {
    $listener.Start()
  } catch {
    $state = Read-HttpJson "http://127.0.0.1:$Port/api/chat/install/status"
    $reported = if ($state -and $state.PSObject.Properties['installDir']) { Resolve-InstallPath ([string]$state.installDir) } else { '' }
    if (-not $reported -or $reported -ne (Resolve-InstallPath $InstallDir)) {
      $owned = Get-OwnedPm2App $Port
      if (-not $owned) { Fail "Port $Port is already used by another application." }
      $script:PreviousAppDir = $owned
      Capture-ExistingRuntimeConfig (Join-Path $InstallDir 'data') $owned
    }
  } finally {
    $listener.Stop()
  }
}

function Open-Setup {
  param([string] $SetupToken)
  $url = "http://localhost:$Port/auth/setup"
  Write-Host "[agent-cockpit] First-run setup token: $SetupToken"
  Write-Log "Agent Cockpit is ready at $url"
  if (-not $SkipOpen) {
    try { Start-Process $url } catch { Write-Log "Warning: unable to open the browser. Open $url manually." }
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

function Prepare-App {
  param([string] $AppDir, [string] $DataDir, [bool] $ForceBuild)
  Ensure-Directory $DataDir
  if ($script:PreviousAppDir -and (Test-Path (Join-Path $script:PreviousAppDir '.env'))) {
    $source = Resolve-InstallPath (Join-Path $script:PreviousAppDir '.env')
    $target = Resolve-InstallPath (Join-Path $AppDir '.env') -AllowMissing
    if (-not $source -or -not $target) { Fail 'Could not resolve the existing runtime configuration for repair.' }
    if ($source -ne $target) { Copy-Item (Join-Path $script:PreviousAppDir '.env') (Join-Path $AppDir '.env') }
  }
  $sessionSecret = Existing-OrNewSecret $AppDir 'SESSION_SECRET' 48
  $setupToken = Existing-OrNewSecret $AppDir 'AUTH_SETUP_TOKEN' 32
  Install-Dependencies $AppDir
  Ensure-BuiltAssets $AppDir $ForceBuild
  Write-EnvFile $AppDir $DataDir $sessionSecret $setupToken
  Write-EcosystemConfig $AppDir $DataDir $sessionSecret $setupToken
}

function Configure-App {
  param([string] $AppDir, [string] $DataDir, [string] $InstallVersion, [string] $InstallSource, [string] $Branch, [bool] $ForceBuild, [switch] $Prepared)
  if (-not $Prepared) { Prepare-App $AppDir $DataDir $ForceBuild }
  Write-InstallManifest $DataDir $AppDir $InstallVersion $InstallSource $Branch
  Write-HelperScripts $AppDir
  Repair-CliToolWrappers
  Register-LogonTask
  Start-Pm2 $AppDir
  Wait-ForServer $AppDir $InstallVersion
  Write-Log "Stage 4/4: release $InstallVersion is ready."
  Open-Setup (Read-EnvValue (Join-Path $AppDir '.env') 'AUTH_SETUP_TOKEN')
}

function Save-Activation {
  $manifest = Join-Path $InstallDir 'data\install.json'
  if (Test-Path $manifest) { Copy-Item $manifest (Join-Path $WorkDir 'install.json') }
  $bin = Join-Path $InstallDir 'bin'
  if (Test-Path $bin) { Copy-Item -Recurse $bin (Join-Path $WorkDir 'bin') }
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
  if (Test-LogonTaskOwnership $task) {
    Export-ScheduledTask -TaskName $TaskName -TaskPath '\' | Set-Content (Join-Path $WorkDir 'startup.xml')
  }
}

function Restore-Activation {
  param([string] $Candidate)
  Write-Log 'Restoring the previous installation.'
  try {
    $script:RollbackCandidateStopped = [bool](Invoke-Pm2BestEffort $Candidate @('delete', $AppName) -PassThru)
    $manifest = Join-Path $InstallDir 'data\install.json'
    if (Test-Path (Join-Path $WorkDir 'install.json')) {
      Copy-Item -Force (Join-Path $WorkDir 'install.json') $manifest
    } else {
      Remove-Item -Force -ErrorAction SilentlyContinue $manifest
    }
    if (Test-Path (Join-Path $WorkDir 'bin')) {
      Copy-Item -Recurse -Force (Join-Path $WorkDir 'bin\*') (Join-Path $InstallDir 'bin')
    } else {
      foreach ($name in @('start-agent-cockpit.ps1', 'stop-agent-cockpit.ps1', 'logs-agent-cockpit.ps1', 'run-agent-cockpit.vbs')) {
        Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path (Join-Path $InstallDir 'bin') $name)
      }
    }
    try {
      $task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
      if ($task -and -not (Test-LogonTaskOwnership $task)) {
        Write-Log 'Leaving the startup task for a different installation unchanged during rollback.'
      } elseif (Test-Path (Join-Path $WorkDir 'startup.xml')) {
        Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Xml (Get-Content -Raw (Join-Path $WorkDir 'startup.xml')) -Force | Out-Null
      } elseif ($task) {
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false
      }
    } catch {
      Write-Log "Warning: startup task restoration failed: $($_.Exception.Message)"
    }
  } finally {
    if ($script:PreviousAppDir -and (Test-Path $script:PreviousAppDir)) { Start-Pm2 $script:PreviousAppDir }
  }
}

function Install-Production {
  $releasesDir = Join-Path $InstallDir 'releases'
  $dataDir = Join-Path $InstallDir 'data'
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "agent-cockpit-release-$([System.Guid]::NewGuid().ToString('n'))"
  Ensure-Directory $tmp
  $appDir = ''
  $activationStarted = $false
  $installed = $false
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
    if ($Version -and $manifest.version -cne $Version.TrimStart('v')) { Fail "Release version mismatch: expected $Version, received $($manifest.version)" }
    $zipArtifact = $manifest.artifacts | Where-Object { ($_.role -eq 'app-zip') -or ($_.platform -eq 'win32' -and $_.format -eq 'zip') } | Select-Object -First 1
    if (-not $zipArtifact) {
      Fail 'Release manifest does not include a Windows app ZIP artifact.'
    }
    if ($zipArtifact.name -match '[/\\]' -or $zipArtifact.name -notlike '*.zip') { Fail 'Invalid release archive name.' }
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
    Expand-ZipFile $zipPath $extractRoot
    $packageRoot = $manifest.packageRoot
    if ($packageRoot -notmatch '^agent-cockpit-v[0-9A-Za-z.+-]+$') { Fail 'Invalid release package root.' }
    $extracted = Join-Path $extractRoot $packageRoot
    if (-not (Test-Path (Join-Path $extracted 'server.ts'))) {
      Fail 'Extracted release is missing server.ts'
    }
    $appDir = Join-Path $releasesDir "$packageRoot-$([System.Guid]::NewGuid().ToString('n'))"
    Capture-ExistingRuntimeConfig $dataDir $appDir
    Test-InstallPreflight
    Write-Log "Stage 2/4: preparing release $($manifest.version)."
    Move-Item -Path $extracted -Destination $appDir
    Prepare-App $appDir $dataDir $false
    Save-Activation
    $activationStarted = $true
    Write-Log 'Stage 3/4: activating the prepared release.'
    try {
      Configure-App $appDir $dataDir $manifest.version 'github-release' '' $false -Prepared
      $installed = $true
    } catch {
      $failure = $_
      try { Restore-Activation $appDir } catch { Write-Log "Rollback failed: $($_.Exception.Message)" }
      throw $failure
    }
  } finally {
    if (-not $installed -and $appDir -and (Test-Path $appDir)) {
      $removeCandidate = -not $activationStarted -or $script:RollbackCandidateStopped
      try {
        $candidate = Resolve-InstallPath $appDir
        $parent = Resolve-InstallPath ([System.IO.Path]::GetDirectoryName($appDir))
        $releaseRoot = Resolve-InstallPath $releasesDir
        if (-not $candidate -or -not $parent -or $parent -ne $releaseRoot) { $removeCandidate = $false }
        $manifestPath = Join-Path $dataDir 'install.json'
        if ($removeCandidate -and $activationStarted -and (Test-Path $manifestPath)) {
          $selected = Read-JsonFile $manifestPath
          $active = if ($selected -and $selected.PSObject.Properties['appDir']) { Resolve-InstallPath ([string]$selected.appDir) } else { '' }
          if (-not $active -or $active -eq $candidate) { $removeCandidate = $false }
        }
        if ($removeCandidate) {
          Remove-Item -Recurse -Force $appDir
        } else {
          Write-Log "Keeping failed candidate $appDir because it may still be active."
        }
      } catch {
        Write-Log "Warning: could not safely clean failed candidate $appDir`: $($_.Exception.Message)"
      }
    }
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
  Test-InstallPreflight
  $devVersion = (& $NodeExe -e "process.stdout.write(require(process.argv[1]).version)" (Join-Path $DevDir 'package.json')).Trim()
  Configure-App $DevDir $dataDir $devVersion 'git-main' 'main' $true
}

if ($env:AGENT_COCKPIT_INSTALL_LIBRARY_ONLY -eq '1') { return }
if ($InstallNode -and $NoInstallNode) {
  Fail 'Use either -InstallNode or -NoInstallNode, not both.'
}

Require-Windows
Resolve-Architecture | Out-Null
try {
  Ensure-Directory $InstallDir
  Ensure-Directory (Join-Path $InstallDir 'logs')
  $InstallLog = Join-Path $InstallDir 'logs\install.log'
  $WorkDir = Join-Path $InstallDir ".install-$([System.Guid]::NewGuid().ToString('n'))"
  Ensure-Directory $WorkDir
  Write-Log "Stage 1/4: checking the installation. Diagnostic log: $InstallLog"
  Capture-ExistingRuntimeConfig (Join-Path $InstallDir 'data') ''
  Resolve-Node
  if (-not $script:PreviousAppDir) {
    $owned = Get-OwnedPm2App
    if ($owned) {
      $script:PreviousAppDir = $owned
      Capture-ExistingRuntimeConfig (Join-Path $InstallDir 'data') $owned
    }
  }
  Test-InstallPreflight
  if ($Channel -eq 'production') { Install-Production } else { Install-Dev }
} catch {
  Write-Log "Installation failed: $($_.Exception.Message)"
  exit 1
} finally {
  if ($WorkDir -and (Test-Path $WorkDir)) { Remove-Item -Recurse -Force $WorkDir }
}
