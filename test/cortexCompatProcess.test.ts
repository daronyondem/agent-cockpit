import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { drainCortexPm2, runCortexProbeProcess } from '../scripts/cortexCompatProcess';

const posix = process.platform === 'win32' ? test.skip : test;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('CoCo probe supervision', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-supervisor-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const run = (program: string, timeoutMs = 5000, signal = new AbortController().signal) => runCortexProbeProcess({
    command: process.execPath, args: ['-e', program], cwd: root, env: process.env, log: path.join(root, 'private.log'), timeoutMs, signal,
  });

  posix('keeps output private and verifies owned process cleanup', async () => {
    const result = await run('console.log("PRIVATE_CALLBACK_CODE");console.error("PRIVATE_ACCOUNT");');
    expect(result).toMatchObject({ passed: true, exitCode: 0, observedProcessesGone: true, timedOut: false });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(await fs.readFile(path.join(root, 'private.log'), 'utf8')).toContain('PRIVATE_CALLBACK_CODE');
    expect((await fs.stat(path.join(root, 'private.log'))).mode & 0o777).toBe(0o600);
  });

  posix('deadline kills a detached resistant descendant, preserves unrelated work and never retries', async () => {
    const counter = path.join(root, 'attempts'), pidFile = path.join(root, 'child.pid');
    const worker = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);';
    const program = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counter)},'1');const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    let descendant: number | undefined;
    try {
      const result = await run(program, 1500); descendant = Number(await fs.readFile(pidFile, 'utf8'));
      expect(result).toMatchObject({ passed: false, timedOut: true, observedProcessesGone: true });
      expect(alive(descendant)).toBe(false); expect(alive(unrelated.pid!)).toBe(true);
      expect(await fs.readFile(counter, 'utf8')).toBe('1');
    } finally {
      unrelated.kill('SIGKILL');
      if (descendant && alive(descendant)) process.kill(descendant, 'SIGKILL');
    }
  });

  posix('cancellation drains a running probe and does not claim success', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try { expect(await run('setInterval(()=>{},1000)', 5000, controller.signal)).toMatchObject({ passed: false, cancelled: true, observedProcessesGone: true }); }
    finally { clearTimeout(timer); }
  });

  posix('spawn failures and excessive output cannot pass', async () => {
    const missing = await runCortexProbeProcess({ command: path.join(root, 'missing'), args: [], cwd: root, env: process.env,
      log: path.join(root, 'missing.log'), timeoutMs: 1000, signal: new AbortController().signal });
    expect(missing).toMatchObject({ passed: false, spawnFailed: true });
    expect(await run('process.stdout.write(Buffer.alloc(9*1024*1024));setInterval(()=>{},1000)')).toMatchObject({ passed: false, logLimitReached: true, observedProcessesGone: true });
    expect((await fs.stat(path.join(root, 'private.log'))).size).toBe(8 * 1024 * 1024);
  });

  posix('stale or reused PM2 PID files do not spawn a daemon or kill unrelated work', async () => {
    const home = path.join(root, 'private-pm2'); await fs.mkdir(home);
    const file = path.join(home, 'pm2.pid');
    // Current test process is live but cannot belong to this private PM2 home.
    await fs.writeFile(file, String(process.pid));
    expect(await drainCortexPm2(home, path.join(root, 'missing-app'), process.env)).toEqual({ drained: true, stalePidRemoved: true });
    expect(alive(process.pid)).toBe(true); await expect(fs.stat(file)).rejects.toThrow();
    expect(await drainCortexPm2(home, root, process.env)).toEqual({ drained: true, stalePidRemoved: false });
    await fs.writeFile(file, 'invalid');
    expect(await drainCortexPm2(home, root, process.env)).toEqual({ drained: false, stalePidRemoved: false });
  });

  posix('tracks an existing private daemon outside the probe ancestry and drains it on cleanup failure', async () => {
    const home = path.join(root, 'private-pm2'); await fs.mkdir(home);
    const daemon = spawn(process.execPath, ['-e', `process.title=${JSON.stringify(`PM2 v7.0.4: God Daemon (${home})`)};setInterval(()=>{},1000);`], { detached: true, stdio: 'ignore' });
    await fs.writeFile(path.join(home, 'pm2.pid'), String(daemon.pid));
    try {
      const value = await runCortexProbeProcess({ command: process.execPath, args: ['-e', 'setTimeout(()=>{},750)'], cwd: root,
        env: process.env, log: path.join(root, 'private.log'), timeoutMs: 5000, signal: new AbortController().signal, pm2Home: home });
      expect(value).toMatchObject({ passed: false, observedProcessesGone: true, pm2Cleanup: { drained: false } });
      expect(value.additionalCleanup).toBeGreaterThan(0); expect(alive(daemon.pid!)).toBe(false);
    } finally { if (alive(daemon.pid!)) daemon.kill('SIGKILL'); }
  });
});
