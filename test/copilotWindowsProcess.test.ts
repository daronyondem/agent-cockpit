import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { spawnWindowsCopilotProcess } from '../src/services/backends/copilotWindowsProcess';
import { spawnCopilotProcess, CopilotProcessScope } from '../src/services/backends/copilotProcess';

const windows = process.platform === 'win32' ? describe : describe.skip;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('passes Windows invocation data through stdin with native argument quoting and no shell interpolation', () => {
  const stdin = Object.assign(new EventEmitter(), { end: jest.fn() });
  const proc = Object.assign(new EventEmitter(), { stdin });
  const spawn = jest.fn(() => proc);
  try {
    jest.isolateModules(() => {
      jest.doMock('child_process', () => ({ spawn }));
      const launch: typeof spawnWindowsCopilotProcess = require('../src/services/backends/copilotWindowsProcess').spawnWindowsCopilotProcess;
      expect(launch('C:\\Copilot tools\\copilot.exe', ['-p', 'a "quote"\n日本語', '', 'C:\\space path\\'], { cwd: 'C:\\workspace', env: { TOKEN: 'fixture' } })).toBe(proc);
    });
    expect(spawn).toHaveBeenCalledWith('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'Text', '-OutputFormat', 'Text', '-EncodedCommand', expect.any(String)], expect.objectContaining({ cwd: 'C:\\workspace', env: { TOKEN: 'fixture' }, detached: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
    expect(JSON.parse(stdin.end.mock.calls[0][0])).toEqual({ command: 'C:\\Copilot tools\\copilot.exe', arguments: '-p "a \\"quote\\"\n日本語" "" "C:\\space path\\\\"' });
    expect(() => stdin.emit('error', new Error('pipe closed on abort'))).not.toThrow();
  } finally { jest.dontMock('child_process'); }
});

test.each(['taskkill', 'fallback', 'timeout'])('Windows cleanup waits for wrapper close after %s', async mode => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const root = Object.assign(new EventEmitter(), {
    pid: 123, exitCode: null as number | null, kill: jest.fn(),
    stdout: { destroy: jest.fn() }, stderr: { destroy: jest.fn() },
  });
  const execFile = jest.fn((_command, _args, _options, callback) => callback(mode === 'fallback' ? new Error('taskkill failed') : null));
  let Scope!: typeof CopilotProcessScope;
  try {
    jest.isolateModules(() => {
      jest.doMock('child_process', () => ({ execFile }));
      Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
    });
    const scope = new Scope(root as unknown as import('child_process').ChildProcess);
    let finished = false;
    const stopping = scope.stop().then(() => { finished = true; });
    await sleep(0);
    expect(finished).toBe(false);
    expect(root.stdout.destroy).not.toHaveBeenCalled();
    if (mode === 'fallback') expect(root.kill).toHaveBeenCalledWith('SIGKILL');
    if (mode === 'timeout') {
      await expect(stopping).rejects.toThrow('wrapper did not close');
      expect(finished).toBe(false);
      await expect(scope.stop()).rejects.toThrow('wrapper did not close');
      expect(execFile).toHaveBeenCalledTimes(1);
      return;
    }
    root.exitCode = 1;
    root.emit('close');
    await stopping;
    expect(finished).toBe(true);
    expect(root.stdout.destroy).toHaveBeenCalled();
    await scope.stop();
    expect(execFile).toHaveBeenCalledTimes(1);
  } finally { Object.defineProperty(process, 'platform', platform); jest.dontMock('child_process'); }
});

windows('native Windows Copilot job ownership', () => {
  test.each(['exit', 'abort'])('reaps detached orphans after launcher %s without touching unrelated work', async action => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot windows '));
    const pidFile = path.join(dir, 'worker.pid');
    const worker = path.join(dir, 'worker.js');
    const middle = path.join(dir, 'middle.js');
    fs.writeFileSync(worker, `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')}, String(process.pid));
fs.renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)});
setInterval(() => fs.appendFileSync(${JSON.stringify(path.join(dir, 'heartbeat'))}, '.'), 10);
`);
    fs.writeFileSync(middle, `require('child_process').spawn(process.execPath, [${JSON.stringify(worker)}], {detached:true,stdio:'ignore'}).unref();`);
    const { proc, scope } = spawnCopilotProcess(process.execPath, ['-e', `
const fs = require('fs');
require('child_process').spawn(process.execPath, [${JSON.stringify(middle)}], {detached:true,stdio:'ignore'}).unref();
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(pidFile)})) return;
  fs.writeSync(1, 'READY\\n');
  clearInterval(timer);
  ${action === 'exit' ? 'process.exit(42);' : 'setInterval(()=>{},1000);'}
}, 10);
`], { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    let pid: number | undefined;
    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr!.on('data', chunk => { stderr += chunk.toString(); });
    const closed = new Promise<number | null>((resolve, reject) => { proc.once('close', resolve); proc.once('error', reject); });
    try {
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(pidFile) && Date.now() < deadline) await sleep(20);
      if (!fs.existsSync(pidFile)) throw new Error(`Worker did not start: ${stderr}`);
      pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (action === 'abort') {
        expect(alive(pid)).toBe(true);
        await Promise.all([scope.stop(), scope.stop()]);
      }
      const code = await closed;
      if (action === 'exit') expect(code).toBe(42);
      await scope.stop(); // Already closed wrappers must still have contained their workers.
      for (let i = 0; i < 100 && alive(pid); i += 1) await sleep(20);
      expect(alive(pid)).toBe(false);
      expect(alive(unrelated.pid!)).toBe(true);
      if (action === 'exit') expect(stdout).toContain('READY');
      expect(stderr).toBe('');
    } finally {
      await scope.stop();
      unrelated.kill('SIGKILL');
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);

  test('preserves native argv, UTF-8 streams, working directory, environment, and exit code', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot ü windows '));
    const args = ['', 'a b', 'a"b', 'a\\"b', 'C:\\space path\\', 'line\nbreak', 'café 日本語 😀', '& | % $ `'];
    const proc = spawnWindowsCopilotProcess(process.execPath, ['-e', `
require('fs').writeSync(1,JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.COPILOT_FIXTURE}));
require('fs').writeSync(2,'é日本語😀'); process.exit(7);
`, '--', ...args], { cwd: dir, env: { ...process.env, COPILOT_FIXTURE: 'é日本語😀' } });
    let stdout = '';
    let stderr = '';
    proc.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    proc.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    try {
      const code = await new Promise((resolve, reject) => { proc.once('close', resolve); proc.once('error', reject); });
      expect(code).toBe(7);
      expect(JSON.parse(stdout)).toEqual({ args, cwd: fs.realpathSync(dir), env: 'é日本語😀' });
      expect(stderr.trim()).toBe('é日本語😀');
    } finally { proc.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);

  test('fails before launching work when the target executable is missing', async () => {
    const proc = spawnWindowsCopilotProcess('Z:\\missing-copilot-fixture.exe', [], {});
    let stderr = '';
    proc.stderr!.on('data', chunk => { stderr += chunk.toString(); });
    expect(await new Promise(resolve => proc.once('close', resolve))).toBe(1);
    expect(stderr).toContain('Copilot Windows job failed');
  }, 20_000);
});
