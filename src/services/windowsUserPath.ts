import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface WindowsPathCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export type WindowsPathCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<WindowsPathCommandResult>;

function persistUserPathScript(dir: string): string {
  return `
$ErrorActionPreference = 'Stop'
$dir = ${powershellSingleQuotedString(dir)}
if ([string]::IsNullOrWhiteSpace($dir)) {
  throw 'Missing PATH entry.'
}
function Normalize-PathEntry([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return '' }
  return ($value.Trim() -replace '[\\\\/]+$', '').ToLowerInvariant()
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
    Write-Warning ("Updated user PATH but could not broadcast environment change: {0}" -f $_.Exception.Message)
  }
}
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @()
if ($current) {
  $parts = @($current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}
$key = Normalize-PathEntry $dir
$filtered = @($parts | Where-Object { (Normalize-PathEntry $_) -ne $key })
$newPath = [string]::Join(';', (@($dir) + $filtered))
if ($newPath -ne $current) {
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Notify-EnvironmentChanged
  Write-Output "Added $dir to the current user PATH."
} else {
  Write-Output "$dir is already first in the current user PATH."
}
`.trim();
}

export function prependProcessPathEntry(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!dir) return;
  const delimiter = process.platform === 'win32' ? ';' : path.delimiter;
  const parts = currentPathValue(env).split(delimiter).filter(Boolean);
  const key = pathPartKey(dir);
  env.PATH = [dir, ...parts.filter(part => pathPartKey(part) !== key)].join(delimiter);
}

export async function persistWindowsUserPathEntry(
  dir: string,
  runner: WindowsPathCommandRunner = defaultWindowsPathCommandRunner,
): Promise<WindowsPathCommandResult> {
  if (process.platform !== 'win32') {
    return { ok: true, stdout: 'Skipped user PATH persistence on non-Windows platform.', stderr: '' };
  }
  prependProcessPathEntry(dir);
  return runner('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    persistUserPathScript(dir),
  ], { timeoutMs: 10_000 });
}

async function defaultWindowsPathCommandRunner(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<WindowsPathCommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: 128 * 1024,
      env: { ...process.env },
    });
    return {
      ok: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: (e.stdout || '').trim(),
      stderr: (e.stderr || '').trim(),
      error: e.code === 'ENOENT' ? 'not found' : (e.message || 'command failed'),
    };
  }
}

function currentPathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH || env.Path || '';
}

function pathPartKey(value: string): string {
  return value.trim().replace(/[\\/]+$/, '').toLowerCase();
}

function powershellSingleQuotedString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
