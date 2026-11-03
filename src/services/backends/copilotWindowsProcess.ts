import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';

// Attach the wrapper before it launches Copilot. Windows then retains ownership
// of descendants even when every intervening launcher has exited. The unnamed,
// non-inheritable handle lives until wrapper exit; closing it kills the whole job.
const wrapper = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CopilotJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits Basic;
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Attach() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    Limits limits = new Limits();
    limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)) ||
        !AssignProcessToJobObject(job, GetCurrentProcess())) {
      int error = Marshal.GetLastWin32Error();
      CloseHandle(job);
      throw new Win32Exception(error);
    }
    // Do not close this handle while the wrapper is alive, or inherit it into
    // Copilot: wrapper termination must close the last handle even after abort.
  }
}
'@
  [CopilotJob]::Attach()
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $invocation = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $invocation.command
  $start.Arguments = $invocation.arguments
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $child = [System.Diagnostics.Process]::Start($start)
  $child.WaitForExit()
  [Environment]::Exit($child.ExitCode)
} catch {
  [Console]::Error.WriteLine('Copilot Windows job failed: ' + $_.Exception.Message)
  [Environment]::Exit(1)
}
`;

export function spawnWindowsCopilotProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wrapper, 'utf16le').toString('base64')], {
    ...options, detached: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Use stdin rather than command interpolation or an environment variable:
  // prompts may contain quotes, Unicode, newlines, or exceed an env value limit.
  proc.stdin.on('error', () => { /* startup failure/abort is reported by the process */ });
  proc.stdin.end(JSON.stringify({ command, arguments: args.map(quoteArgument).join(' ') }));
  return proc;
}

function quoteArgument(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
