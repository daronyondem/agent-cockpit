import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CopilotAdapter } from '../src/services/backends/copilot';
import { CopilotProcessScope } from '../src/services/backends/copilotProcess';
import { BackendRegistry } from '../src/services/backends/registry';
import type { CliProfile, StreamEvent } from '../src/types';

const posix = process.platform === 'win32' ? test.skip : test;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch {
    return false;
  }
}

posix.each(['abort', 'iterator-close', 'timeout', 'signal', 'reset', 'shutdown'])(
  'reaps an npm-shaped wrapper and TERM-resistant native child on %s',
  async action => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-tree-'));
    const pidFile = path.join(dir, 'native.pid');
    const launcher = path.join(dir, 'copilot');
    const childProgram = `
process.on('SIGTERM', () => {});
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')}, String(process.pid));
fs.renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)});
console.log(JSON.stringify({type:'assistant.message_delta',data:{messageId:'ready',deltaContent:'ready'}}));
setInterval(() => {}, 1000);
`;
    fs.writeFileSync(launcher, `#!${process.execPath}
const { spawnSync } = require('child_process');
spawnSync(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { stdio: 'inherit' });
`);
    fs.chmodSync(launcher, 0o755);
    const profile: CliProfile = {
      id: 'fixture', name: 'fixture', harness: 'copilot', authMode: 'server-configured',
      command: launcher, createdAt: '', updatedAt: '',
    };
    const backend = new CopilotAdapter({ workingDir: dir });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    let childPid: number | undefined;
    try {
      const controller = new AbortController();
      const turn = backend.sendMessage('test', {
        sessionId: 'session', conversationId: 'conversation', isNewSession: true, workingDir: dir, systemPrompt: '', cliProfile: profile,
      });
      const events: StreamEvent[] = [];
      const result = action === 'timeout' || action === 'signal'
        ? backend.runOneShot('test', { cliProfile: profile, timeoutMs: action === 'timeout' ? 1_500 : 10_000, abortSignal: controller.signal })
          .then(() => null, (err: Error) => err)
        : (async () => {
          for await (const event of turn.stream) {
            events.push(event);
            if (action === 'iterator-close' && event.type === 'text') break;
          }
          return null;
        })();
      for (let i = 0; i < 100; i += 1) {
        if (fs.existsSync(pidFile)) { childPid = Number(fs.readFileSync(pidFile, 'utf8')); break; }
        await sleep(20);
      }
      expect(childPid).toBeGreaterThan(0);
      const started = Date.now();
      if (action === 'abort') {
        turn.abort();
        const resumed = backend.sendMessage('resume', {
          sessionId: 'session', conversationId: 'conversation', isNewSession: false, workingDir: dir, systemPrompt: '', cliProfile: profile,
        });
        const iterator = resumed.stream[Symbol.asyncIterator]();
        try {
          expect((await iterator.next()).value).toMatchObject({ type: 'backend_runtime' });
          expect(alive(childPid!)).toBe(false);
        } finally {
          resumed.abort();
          await iterator.return?.(undefined);
        }
      }
      if (action === 'signal') controller.abort();
      if (action === 'reset') await backend.onSessionReset('conversation');
      if (action === 'shutdown') {
        const registry = new BackendRegistry();
        registry.register(backend);
        await registry.shutdownAll();
      }
      const error = await result;
      expect(Date.now() - started).toBeLessThan(4_000);
      if (action === 'timeout') expect(error?.message).toContain('timed out');
      if (action === 'signal') expect(error?.message).toContain('aborted');
      if (['abort', 'reset', 'shutdown'].includes(action)) {
        expect(events).toEqual(expect.arrayContaining([{ type: 'error', error: 'Copilot turn aborted.', source: 'abort' }, { type: 'done' }]));
      }
      expect(alive(childPid!)).toBe(false);
      expect(alive(unrelated.pid!)).toBe(true);
    } finally {
      await backend.shutdown();
      unrelated.kill('SIGKILL');
      if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  15_000,
);

posix('tracks detached descendants after their parent exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-detached-'));
  const pidFile = path.join(dir, 'pid');
  const root = spawn(process.execPath, ['-e', `
const child = require('child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')},String(child.pid));
fs.renameSync(${JSON.stringify(pidFile + '.tmp')},${JSON.stringify(pidFile)});
setInterval(()=>{},1000);
`], { detached: true, stdio: 'ignore' });
  const scope = new CopilotProcessScope(root);
  let childPid: number | undefined;
  try {
    for (let i = 0; i < 100; i += 1) {
      if (fs.existsSync(pidFile)) { childPid = Number(fs.readFileSync(pidFile, 'utf8')); break; }
      await sleep(20);
    }
    expect(childPid).toBeGreaterThan(0);
    await sleep(200);
    const exit = new Promise(resolve => root.once('close', resolve));
    root.kill('SIGKILL');
    await exit;
    await scope.stop();
    expect(alive(childPid!)).toBe(false);
  } finally {
    await scope.stop();
    root.kill('SIGKILL');
    if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

posix('reaps an orphan whose detached shell exited before the first ownership snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-orphan-'));
  const pidFile = path.join(dir, 'worker.pid');
  const worker = path.join(dir, 'worker.cjs');
  const token = crypto.randomUUID();
  fs.writeFileSync(worker, `
process.on('SIGTERM', () => {});
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')}, String(process.pid));
fs.renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)});
setInterval(() => {}, 1000);
`);
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const command = `${quote(process.execPath)} ${quote(worker)} </dev/null >/dev/null 2>&1 &`;
  const root = spawn(process.execPath, ['-e', `
require('child_process').spawnSync('/bin/sh', ['-c', ${JSON.stringify(command)}], { detached: true, stdio: 'ignore' });
`], { detached: true, stdio: 'ignore', env: { ...process.env, AGENT_COCKPIT_COPILOT_SCOPE: token } });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore', env: { ...process.env, AGENT_COCKPIT_COPILOT_SCOPE: `${token}-other-run` },
  });
  let scope: CopilotProcessScope | undefined;
  let workerPid: number | undefined;
  try {
    await new Promise(resolve => root.once('close', resolve));
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) await sleep(20);
    workerPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(workerPid)).toBe(true);
    // Neither the launcher nor the detached group leader exists when discovery starts.
    scope = new CopilotProcessScope(root, token);
    await scope.stop();
    expect(alive(workerPid)).toBe(false);
    expect(alive(unrelated.pid!)).toBe(true);
  } finally {
    await (scope || new CopilotProcessScope(root, token)).stop();
    root.kill('SIGKILL');
    unrelated.kill('SIGKILL');
    if (workerPid && alive(workerPid)) process.kill(workerPid, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Copilot process containment edges', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    jest.dontMock('child_process');
  });

  posix.each([false, true])('checks exact run ownership after an in-flight ancestry scan (environment failure=%s)', async failure => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const root = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, kill: jest.fn() });
    const birth = 'Mon Nov  2 10:00:00 2026';
    const rootRow = `100 1 100 ${birth}`;
    const token = crypto.randomUUID();
    let initial!: (err: Error | null, stdout: string) => void;
    let first = true;
    const execFile = jest.fn((_command, args, _options, callback) => {
      if (first) { first = false; initial = callback; return; }
      if (args.includes('eww')) {
        callback(failure ? new Error('environment unavailable') : null, [
          `${rootRow} root AGENT_COCKPIT_COPILOT_SCOPE=${token}`,
          `101 1 99 ${birth} orphan AGENT_COCKPIT_COPILOT_SCOPE=${token}`,
          `200 1 200 ${birth} other AGENT_COCKPIT_COPILOT_SCOPE=${token}-other`,
          `201 1 201 ${birth} other XAGENT_COCKPIT_COPILOT_SCOPE=${token}`,
        ].join('\n'));
      } else callback(null, `${rootRow}\n101 100 99 ${birth}\n`);
    });
    let Scope!: typeof CopilotProcessScope;
    try {
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ execFile }));
        Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
      });
      const scope = new Scope(root as unknown as ChildProcess, token);
      const stopped = scope.stop();
      initial(null, `${rootRow}\n`);
      await stopped;
      expect(kill).toHaveBeenCalledWith(101, 'SIGKILL');
      expect(kill.mock.calls.some(call => [200, -200, 201, -201].includes(call[0]))).toBe(false);
      expect(execFile.mock.calls.filter(call => call[1].includes('eww'))).toHaveLength(2);
    } finally {
      kill.mockRestore();
    }
  });

  test.each([false, true])('Windows uses bounded taskkill tree cleanup (failure=%s)', async fail => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const child = Object.assign(new EventEmitter(), { pid: 77, exitCode: null as number | null, kill: jest.fn(), stdout: { destroy: jest.fn() } });
    const execFile = jest.fn((_command, _args, _options, callback) => {
      callback(fail ? new Error('taskkill failed') : null, '');
      setImmediate(() => { child.exitCode = 1; child.emit('close'); });
    });
    let Scope!: typeof CopilotProcessScope;
    jest.isolateModules(() => {
      jest.doMock('child_process', () => ({ execFile }));
      Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
    });
    const scope = new Scope(child as unknown as ChildProcess);
    await Promise.all([scope.stop(), scope.stop()]);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/pid', '77', '/t', '/f'], expect.objectContaining({ windowsHide: true, timeout: 2_000 }), expect.any(Function));
    expect(child.kill).toHaveBeenCalledTimes(fail ? 1 : 0);
    expect(child.stdout.destroy).toHaveBeenCalled();
  });

  posix('does not signal a reused descendant PID', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const root = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, kill: jest.fn(), stdout: { destroy: jest.fn() } });
    let calls = 0;
    const execFile = jest.fn((_command, _args, _options, callback) => {
      calls += 1;
      callback(null, calls === 1 ? '100 1 100 ROOT\n101 100 101 CHILD\n' : '100 1 100 ROOT\n101 1 101 REUSED\n');
    });
    let Scope!: typeof CopilotProcessScope;
    try {
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ execFile }));
        Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
      });
      const scope = new Scope(root as unknown as ChildProcess);
      await sleep(0);
      await scope.stop();
      expect(kill).toHaveBeenCalledWith(-100, 'SIGTERM');
      expect(kill.mock.calls.some(call => call[0] === 101 || call[0] === -101)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  posix('falls back to the owned group and destroys pipes when ps is unavailable', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const root = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, kill: jest.fn(), stdout: { destroy: jest.fn() } });
    const execFile = jest.fn((_command, _args, _options, callback) => callback(new Error('ps unavailable'), ''));
    let Scope!: typeof CopilotProcessScope;
    try {
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ execFile }));
        Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
      });
      const scope = new Scope(root as unknown as ChildProcess);
      await sleep(0);
      await scope.stop();
      expect(kill).toHaveBeenCalledWith(-100, 'SIGKILL');
      expect(root.kill).toHaveBeenCalledWith('SIGKILL');
      expect(root.stdout.destroy).toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  posix('contains an unobserved child that retains the owned group after launcher close', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const root = Object.assign(new EventEmitter(), { pid: 100, exitCode: null as number | null, kill: jest.fn() });
    let calls = 0;
    const execFile = jest.fn((_command, _args, _options, callback) => {
      calls += 1;
      callback(null, calls === 1 ? '100 1 100 ROOT\n' : '101 1 100 CHILD\n200 1 200 UNRELATED\n');
    });
    let Scope!: typeof CopilotProcessScope;
    try {
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ execFile }));
        Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
      });
      const scope = new Scope(root as unknown as ChildProcess);
      await sleep(0);
      root.exitCode = 0;
      root.emit('close');
      await scope.stop();
      expect(kill).toHaveBeenCalledWith(-100, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(101, 'SIGKILL');
      expect(kill.mock.calls.some(call => call[0] === 200 || call[0] === -200)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  posix('contains orphan jobs in an observed child group after that child leader exits', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const root = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, kill: jest.fn() });
    let calls = 0;
    const execFile = jest.fn((_command, _args, _options, callback) => {
      calls += 1;
      callback(null, calls === 1 ? '100 1 100 ROOT\n101 100 101 CHILD\n' : '100 1 100 ROOT\n102 1 101 ORPHAN\n200 1 200 UNRELATED\n');
    });
    let Scope!: typeof CopilotProcessScope;
    try {
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ execFile }));
        Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
      });
      const scope = new Scope(root as unknown as ChildProcess);
      await sleep(0);
      await scope.stop();
      expect(kill).toHaveBeenCalledWith(-101, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(102, 'SIGKILL');
      expect(kill.mock.calls.some(call => call[0] === 200 || call[0] === -200)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  posix('discovers new detached grandchildren from tracked children after root exit', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const root = Object.assign(new EventEmitter(), { pid: 100, exitCode: null as number | null, kill: jest.fn() });
    let calls = 0;
    const execFile = jest.fn((_command, _args, _options, callback) => {
      calls += 1;
      callback(null, calls === 1 ? '100 1 100 ROOT\n101 100 101 CHILD\n' : '101 1 101 CHILD\n102 101 102 GRANDCHILD\n');
    });
    let Scope!: typeof CopilotProcessScope;
    try {
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ execFile }));
        Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
      });
      const scope = new Scope(root as unknown as ChildProcess);
      await sleep(0);
      root.exitCode = 1;
      root.emit('close');
      await scope.stop();
      expect(kill).toHaveBeenCalledWith(-102, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(102, 'SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });
});
