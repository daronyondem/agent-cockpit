import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { CortexProcessScope, parseCortexProcessTable } from '../src/services/backends/cortexProcess';

const posix = process.platform === 'win32' ? test.skip : test;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('process table parser ignores malformed lines and keeps identity data', () => {
  expect(parseCortexProcessTable('header\n10 1 10 Fri Nov 6 10:00:00 2026\nwrong\n')).toEqual([
    { pid: 10, parent: 1, group: 10, started: 'Fri Nov 6 10:00:00 2026' },
  ]);
});

posix('reaps a detached SIGTERM-resistant tool after root exit and preserves an unrelated process', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-scope-'));
  const file = path.join(dir, 'child.pid');
  const program = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
  const rootProgram = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(program)}],{detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(file)},String(c.pid));setInterval(()=>{},1000);`;
  const root = spawn(process.execPath, ['-e', rootProgram], { detached: true, stdio: 'ignore' });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  const scope = new CortexProcessScope(root);
  scope.watch();
  let childPid: number | undefined;
  try {
    for (let i = 0; i < 100; i++) {
      try { childPid = Number(await fs.readFile(file, 'utf8')); break; } catch { await delay(20); }
    }
    expect(childPid).toBeGreaterThan(0);
    await delay(600);
    const exited = new Promise(resolve => root.once('exit', resolve));
    root.kill('SIGKILL');
    await exited;
    const first = scope.stop();
    expect(scope.stop()).toBe(first);
    await first;
    expect(alive(childPid!)).toBe(false);
    expect(alive(unrelated.pid!)).toBe(true);
  } finally {
    await scope.stop();
    root.kill('SIGKILL'); unrelated.kill('SIGKILL');
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* fixture reaped */ } }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('identity checks and enumeration failures', () => {
  let kill: jest.SpyInstance;
  beforeEach(() => { kill = jest.spyOn(process, 'kill').mockImplementation(() => true); jest.useFakeTimers(); });
  afterEach(() => {
    kill.mockRestore(); jest.useRealTimers(); jest.dontMock('child_process'); jest.resetModules();
  });
  const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  function load(execFile: jest.Mock): typeof CortexProcessScope {
    jest.doMock('child_process', () => ({ ...jest.requireActual('child_process'), execFile }));
    let loaded!: typeof import('../src/services/backends/cortexProcess');
    jest.isolateModules(() => { loaded = require('../src/services/backends/cortexProcess'); });
    return loaded.CortexProcessScope;
  }
  const table = (stdout: string) => (_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string }) => void) => callback(null, { stdout });

  posix('never signals reused identities or unrelated siblings after root exit', async () => {
    const exec = jest.fn()
      .mockImplementationOnce(table('100 1 100 ROOT\n101 100 101 TOOL\n102 100 100 CHILD\n200 1 200 OTHER\n'))
      .mockImplementationOnce(table('100 1 100 REUSED\n101 1 101 TOOL\n102 1 102 REUSED\n200 1 200 OTHER\n'))
      .mockImplementation(table('100 1 100 REUSED\n200 1 200 OTHER\n'));
    const child = { pid: 100, exitCode: null, signalCode: null } as unknown as ChildProcess;
    const scope = new (load(exec))(child);
    scope.watch();
    await flush();
    Object.assign(child, { exitCode: 1 });
    const stopped = scope.stop();
    await flush();
    expect(kill.mock.calls).toEqual([[-101, 'SIGTERM'], [101, 'SIGTERM']]);
    await jest.advanceTimersByTimeAsync(100);
    await stopped;
  });

  posix('enumeration failure during stop falls back only to the still-live root group', async () => {
    const exec = jest.fn((_command, _args, _options, callback) => callback(new Error('private diagnostics')));
    const child = { pid: 100, exitCode: null, signalCode: null, kill: jest.fn() } as unknown as ChildProcess;
    const scope = new (load(exec))(child);
    scope.watch();
    await flush();
    expect(kill).not.toHaveBeenCalled();
    await scope.stop();
    expect(kill.mock.calls).toEqual([[-100, 'SIGKILL']]);
    const exited = new (load(exec))({ ...child, exitCode: 1 } as ChildProcess);
    await exited.stop();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  posix('scans every 250 ms only while active and every 2 s while idle', async () => {
    const exec = jest.fn(table('100 1 100 ROOT\n'));
    const scope = new (load(exec))({ pid: 100, exitCode: null, signalCode: null } as unknown as ChildProcess);
    scope.watch();
    await flush();
    scope.pace(false);
    exec.mockClear();
    await jest.advanceTimersByTimeAsync(1_999);
    expect(exec).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(exec).toHaveBeenCalledTimes(1);
    exec.mockClear();
    scope.pace(true);
    await flush();
    expect(exec).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(exec).toHaveBeenCalledTimes(5);
    exec.mockImplementation(table(''));
    await scope.stop();
  });

  test('failed spawn without a PID is safe to stop', async () => {
    const scope = new CortexProcessScope({} as ChildProcess);
    await scope.stop();
    expect(kill).not.toHaveBeenCalled();
  });
});
