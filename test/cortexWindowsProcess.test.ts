import { execFile, type ChildProcess } from 'child_process';
import { CortexProcessScope } from '../src/services/backends/cortexProcess';
import { readCortexWindowsProcesses, killCortexWindowsProcesses } from '../src/services/backends/cortexWindowsProcess';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn() }));
jest.mock('timers/promises', () => ({ setTimeout: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) }));

describe('CoCo Windows process ownership (simulated snapshots)', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalEnv = process.env;
  const rootStart = '20261109000000000000', childStart = '20261109000000000010', replacedStart = '20261109000000000020';
  const row = (pid: number, parent: number, started = childStart) => ({ pid, parent, started });
  let kill: jest.SpyInstance;
  let scripts: string[];
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env = { SystemRoot: 'C:\\Windows' };
    scripts = []; jest.clearAllMocks(); jest.useFakeTimers();
    kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
  });
  afterEach(() => {
    jest.useRealTimers(); kill.mockRestore(); process.env = originalEnv;
    Object.defineProperty(process, 'platform', platform);
  });
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  function output(snapshots: unknown[], failKill = false) {
    jest.mocked(execFile).mockImplementation(((command: string, args: string[], options: unknown, callback: Function) => {
      expect(command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
      expect(options).toMatchObject({ windowsHide: true, timeout: 5000 });
      const script = Buffer.from(args[4], 'base64').toString('utf16le'); scripts.push(script);
      const data = script.includes('Get-CimInstance') ? snapshots.length ? snapshots.shift() : [] : failKill ? new Error('kill failed') : [];
      callback(data instanceof Error ? data : null, { stdout: JSON.stringify(data) });
    }) as any);
  }

  test('enumerates only identity metadata, validates JSON, and constructs identity-rechecked kills without shell interpolation', async () => {
    output([[row(100, 1, rootStart)]]);
    const table = await readCortexWindowsProcesses();
    expect(table).toEqual([{ pid: 100, parent: 1, group: 100, started: rootStart }]);
    await killCortexWindowsProcesses(table);
    expect(scripts[0]).not.toContain('GetProcessById');
    expect(scripts[0]).not.toContain('catch');
    expect(scripts[0]).toContain('$_.CreationDate');
    expect(scripts[0]).not.toMatch(/CommandLine|Environment/);
    expect(scripts[1]).toContain(`@{ pid=100; started='${rootStart}' }`);
    expect(scripts[1]).toContain('$null=$p.Handle');
    expect(scripts[1]).toContain("$p.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssffffff',$culture) -eq $target.started");
    expect(scripts[1]).toContain('$p.Kill()');
    expect(scripts[1]).not.toMatch(/taskkill|Stop-Process|Kill\(\$true\)/i);
    await killCortexWindowsProcesses([]);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  test.each([null, {}, [row(-1, 1)], [row(100, -1)], [row(100.5, 1)], [row(100, 1, 'invalid')]])('rejects malformed snapshot %j', async snapshot => {
    output([snapshot]);
    await expect(readCortexWindowsProcesses()).rejects.toThrow('Invalid Windows process');
  });

  test('rejects malicious identities before starting a termination helper', async () => {
    await expect(killCortexWindowsProcesses([{ pid: 100, parent: 1, group: 100, started: "';Write-Output secret" }])).rejects.toThrow('Invalid Windows process identity');
    expect(execFile).not.toHaveBeenCalled();
  });

  test('retains detached descendants after root exit, excludes reused PIDs/older children/siblings, and drains once', async () => {
    output([
      [row(100, 1, rootStart), row(101, 100), row(102, 101), row(103, 100, '20251109000000000000'), row(200, 1)],
      [row(100, 1, replacedStart), row(101, 1), row(102, 1, replacedStart), row(103, 100, '20251109000000000000'), row(200, 1)],
      [row(100, 1, replacedStart), row(200, 1)],
    ]);
    const child = { pid: 100, exitCode: null, signalCode: null, kill: jest.fn() } as unknown as ChildProcess;
    const scope = new CortexProcessScope(child); scope.watch(); await flush();
    Object.assign(child, { exitCode: 1 });
    const stopped = scope.stop(); expect(scope.stop()).toBe(stopped); await flush();
    const termination = scripts.find(script => script.includes('$p.Kill()'))!;
    expect(termination).toContain('pid=101;');
    expect(termination).not.toMatch(/pid=(100|102|103|200);/);
    await jest.advanceTimersByTimeAsync(100); await stopped;
    expect(kill).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
  });

  test('failed enumeration can stop only a still-live root and rejects unverified cleanup', async () => {
    output([new Error('enumeration failed'), new Error('enumeration failed')]);
    const child = { pid: 100, exitCode: null, signalCode: null, kill: jest.fn() } as unknown as ChildProcess;
    const scope = new CortexProcessScope(child); scope.watch(); await flush();
    await expect(scope.stop()).rejects.toThrow('could not verify ownership');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(kill).not.toHaveBeenCalled();
    output([new Error('enumeration failed')]);
    await expect(new CortexProcessScope({ ...child, exitCode: 1 } as ChildProcess).stop()).rejects.toThrow('could not verify ownership');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  test('termination helper failures and surviving identities cannot report successful cleanup', async () => {
    output([[row(100, 1, rootStart)]], true);
    await expect(new CortexProcessScope({ pid: 100, exitCode: null, signalCode: null } as ChildProcess).stop()).rejects.toThrow('kill failed');
    output(Array.from({ length: 50 }, () => [row(100, 1, rootStart)]));
    const stop = new CortexProcessScope({ pid: 100, exitCode: null, signalCode: null } as ChildProcess).stop();
    const failed = expect(stop).rejects.toThrow('cleanup is incomplete');
    await jest.advanceTimersByTimeAsync(4000); await failed;
    expect(kill).not.toHaveBeenCalled();
  });
});
