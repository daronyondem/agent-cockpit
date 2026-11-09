import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import type { CortexProcessIdentity } from '../../types';

const exec = promisify(execFile);

async function powershell(script: string): Promise<string> {
  const command = path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await exec(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference='Stop';\n${script}`, 'utf16le').toString('base64')],
  { windowsHide: true, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** Only process identity metadata leaves PowerShell; no command lines or env. */
export async function readCortexWindowsProcesses(): Promise<CortexProcessIdentity[]> {
  const text = await powershell(`
$culture=[Globalization.CultureInfo]::InvariantCulture
$rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object {
  # Snapshot without opening a process handle: access denial must not hide an owner.
  @{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId;
     started=$_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff',$culture) }
})
ConvertTo-Json -InputObject $rows -Compress`);
  const rows: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!Array.isArray(rows)) throw new Error('Invalid Windows process snapshot');
  return rows.map(row => {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.parent) || row.parent < 0
      || typeof row.started !== 'string' || !/^\d{20}$/.test(row.started)) throw new Error('Invalid Windows process identity');
    return { pid: row.pid, parent: row.parent, group: row.pid, started: row.started };
  });
}

/** Hold and recheck each process handle; never taskkill an unverified tree. */
export async function killCortexWindowsProcesses(owned: CortexProcessIdentity[]): Promise<void> {
  if (!owned.length) return;
  const targets = owned.map(item => {
    if (!Number.isSafeInteger(item.pid) || item.pid <= 0 || !/^\d{20}$/.test(item.started)) throw new Error('Invalid Windows process identity');
    return `@{ pid=${item.pid}; started='${item.started}' }`;
  }).join(',');
  await powershell(`
$culture=[Globalization.CultureInfo]::InvariantCulture
foreach ($target in @(${targets})) {
  $p=$null
  try {
    $p=[Diagnostics.Process]::GetProcessById($target.pid)
    $null=$p.Handle
    if ($p.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssffffff',$culture) -eq $target.started) { $p.Kill() }
  } catch [ArgumentException] { }
    catch [InvalidOperationException] { if ($null -eq $p -or -not $p.HasExited) { throw } }
    finally { if ($null -ne $p) { $p.Dispose() } }
}`);
}
