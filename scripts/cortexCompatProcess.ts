import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { setTimeout as delay } from 'timers/promises';
import { CortexProcessScope, parseCortexProcessTable } from '../src/services/backends/cortexProcess';
import type { CortexProcessIdentity } from '../src/types';

const exec = promisify(execFile);

async function pm2Owner(home: string) {
  const raw = await fs.promises.readFile(path.join(home, 'pm2.pid'), 'utf8');
  const pid = Number(raw.trim()); if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid private daemon PID');
  let command: string;
  try { command = (await exec('ps', ['-ww', '-p', String(pid), '-o', 'args='], { timeout: 2000 })).stdout; }
  catch (error) { if ((error as { code?: unknown }).code !== 1) throw new Error('Cannot observe private daemon'); command = ''; }
  return { raw, pid, owned: command.includes('PM2') && command.includes('God Daemon') && command.includes(home) };
}

/** Do not start a new daemon merely to clean up an already-dead fixture. */
export async function drainCortexPm2(home: string, cwd: string, env: NodeJS.ProcessEnv) {
  const file = path.join(home, 'pm2.pid');
  let owner: Awaited<ReturnType<typeof pm2Owner>>;
  try { owner = await pm2Owner(home); }
  catch (error) { return { drained: (error as NodeJS.ErrnoException).code === 'ENOENT', stalePidRemoved: false }; }
  if (!owner.owned) {
    if (await fs.promises.readFile(file, 'utf8').catch(() => null) !== owner.raw) return { drained: false, stalePidRemoved: false };
    await fs.promises.rm(file); return { drained: true, stalePidRemoved: true };
  }
  try { await exec(process.execPath, [path.join(cwd, 'node_modules/pm2/bin/pm2'), 'kill'], { cwd, env: { ...env, PM2_HOME: home }, timeout: 30000 }); }
  catch { return { drained: false, stalePidRemoved: false }; }
  return { drained: !fs.existsSync(file), stalePidRemoved: false };
}

/** Own the probe as well as detached native/browser descendants; never replay it. */
export async function runCortexProbeProcess(options: {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  log: string; timeoutMs: number; signal: AbortSignal; pm2Home?: string;
}) {
  options.signal.throwIfAborted();
  const output = fs.openSync(options.log, 'wx', 0o600);
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const scope = new CortexProcessScope(child); scope.watch();
  const observed = new Map<number, CortexProcessIdentity>();
  let timedOut = false, cancelled = false, spawnFailed = false, logLimitReached = false, logWriteFailed = false, observationFailed = false;
  let bytes = 0, sampling: Promise<void> | undefined;
  const table = async () => parseCortexProcessTable((await exec('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 })).stdout);
  const sample = () => sampling ||= Promise.all([table(), options.pm2Home ? pm2Owner(options.pm2Home).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null;
  }) : null]).then(([rows, daemon]) => {
    const owned = new Set(rows.filter(row => row.pid === child.pid && child.exitCode === null && child.signalCode === null
      || observed.get(row.pid)?.started === row.started || daemon?.owned && row.pid === daemon.pid).map(row => row.pid));
    let changed = true;
    while (changed) { changed = false; for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
    for (const row of rows) if (owned.has(row.pid)) observed.set(row.pid, row);
  }).catch(() => { observationFailed = true; }).finally(() => { sampling = undefined; });
  const stop = () => { void scope.stop(); };
  const abort = () => { cancelled = true; stop(); };
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  const deadline = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
  const watch = setInterval(() => { void sample(); }, 250); void sample();
  const write = (chunk: Buffer) => {
    try {
      const allowed = Math.max(0, 8 * 1024 * 1024 - bytes);
      fs.writeSync(output, chunk.subarray(0, allowed)); bytes += Math.min(chunk.length, allowed);
      if (chunk.length > allowed) { logLimitReached = true; stop(); }
    } catch { logWriteFailed = true; stop(); }
  };
  child.stdout.on('data', write); child.stderr.on('data', write);
  child.once('error', () => { spawnFailed = true; });
  let exitCode: number | null = null;
  try {
    exitCode = await new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  } finally {
    clearTimeout(deadline); clearInterval(watch); options.signal.removeEventListener('abort', abort);
    await sample(); await scope.stop(); fs.closeSync(output);
  }
  const pm2Cleanup = options.pm2Home ? await drainCortexPm2(options.pm2Home, options.cwd, options.env) : { drained: true, stalePidRemoved: false };
  let alive = await table().catch(() => { observationFailed = true; return []; });
  const owned = () => alive.filter(row => observed.get(row.pid)?.started === row.started);
  const survivors = owned();
  for (const row of survivors) { try { process.kill(row.pid, 'SIGKILL'); } catch { /* already gone */ } }
  const cleanupDeadline = Date.now() + 2000;
  while (owned().length && Date.now() < cleanupDeadline) { await delay(100); alive = await table().catch(() => { observationFailed = true; return []; }); }
  const observedProcessesGone = !observationFailed && owned().length === 0;
  return { exitCode, timedOut, cancelled, spawnFailed, logLimitReached, logWriteFailed, observationFailed,
    observedProcesses: observed.size, additionalCleanup: survivors.length, observedProcessesGone, pm2Cleanup,
    passed: exitCode === 0 && !timedOut && !cancelled && !spawnFailed && !logLimitReached && !logWriteFailed && observedProcessesGone && pm2Cleanup.drained };
}
