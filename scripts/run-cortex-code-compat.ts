import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { cortexVersion, resolveCortexRuntime } from '../src/services/backends/cortexRuntime';
import { CortexConnections } from '../src/services/cortexConnections';
import { CORTEX_PROBES, CORTEX_WORKFLOW_CHECKS, readCortexProbeReport, selectCortexProbes, type CortexCompatSuite } from './cortexCompatReports';
import { drainCortexPm2, runCortexProbeProcess } from './cortexCompatProcess';
import type { CliProfile } from '../src/types';

const exec = promisify(execFile);

export async function runCortexCompatibility(suite: CortexCompatSuite, args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && ['--list', '--help'].includes(args[0])) {
    process.stdout.write(`CoCo ${suite}: ${CORTEX_PROBES[suite].map(probe => probe.id).join(', ')}\nUse CORTEX_CODE_E2E=1; optionally repeat --probe <id>. ${suite === 'auth-control' ? 'Expected failure with empty native configuration; no saved account is selected.' : 'Native inference uses shared terminal auth.'}\n`);
    return;
  }
  const selected = selectCortexProbes(suite, args);
  assert.equal(process.env.CORTEX_CODE_E2E, '1', 'Set CORTEX_CODE_E2E=1 to authorize native inference');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1', 'Native fake mode is not evidence');
  assert.equal(process.platform, 'darwin', 'These consolidated probes currently certify macOS only');
  assert.ok(process.getuid!() > 0, 'Run as the normal logged-in user');
  const cwd = process.cwd(), startedAt = new Date().toISOString();
  // Keep tsx/PM2 Unix sockets below macOS's path limit, including native children.
  const root = await fs.mkdtemp(path.join('/tmp', `cockpit-cortex-${suite}-compat-`)); await fs.chmod(root, 0o700);
  const pm2Home = path.join(root, 'private-pm2'), lock = path.join(os.tmpdir(), 'agent-cockpit-cortex-e2e.lock');
  const nonce = crypto.randomBytes(16).toString('hex');
  const lockValue = JSON.stringify({ pid: process.pid, nonce });
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const deadline = setTimeout(abort, ({ backend: 40, ui: 70, workflows: 85, 'auth-control': 5 }[suite]) * 60_000);
  const results: Array<Record<string, unknown>> = [];
  const report: Record<string, unknown> = { startedAt, suite, platform: process.platform, osRelease: os.release(), arch: process.arch, node: process.version,
    selected: selected.map(probe => probe.id), omitted: CORTEX_PROBES[suite].filter(probe => !selected.some(item => item.id === probe.id)).map(probe => probe.id),
    scope: selected.length === CORTEX_PROBES[suite].length ? 'all catalog probes' : 'selected catalog probes',
    authScope: suite === 'auth-control' ? 'empty native configuration; expected failure only' : 'shared terminal credentials; real account inference required',
    pending: ['C26 human remote OAuth', 'C52 Ubuntu', 'C53 Windows', 'physical mobile devices',
      ...(selected.some(probe => probe.id === 'restricted') ? [] : ['C35 restricted Memory outside this run']),
      ...(suite === 'workflows' && selected.length === CORTEX_PROBES.workflows.length ? [] : ['complete workflow catalog outside this run'])],
    historicalObservations: [
      'C49 saved-auth verification failure and cached-job timeout; later passes do not establish their cause.',
      'C51 native activation drift to 1.2.37, including after query flags; originating process unproven.',
      'C51 isolated HOME/shared SNOWFLAKE_HOME returned null auth; isolation and its cause remain uncertified.',
    ], results, passed: false, phase: 'lock' };
  let ownsLock = false, executable: string | undefined, executableBefore: { size: number; mtimeMs: number } | undefined;
  const activation = path.join(os.homedir(), '.local/bin/cortex');
  let activationBefore: string | null | undefined;
  const jobEnv: NodeJS.ProcessEnv = { ...process.env, PM2_HOME: pm2Home };
  const run = async (id: string, command: string, commandArgs: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }) => {
    const job = path.join(root, id), tmp = path.join(job, 'tmp'); await fs.mkdir(tmp, { recursive: true });
    process.stdout.write(`CoCo ${suite}: ${id}\n`);
    const outcome = await runCortexProbeProcess({ command, args: commandArgs, cwd: options.cwd || cwd,
      env: { ...jobEnv, ...options.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, log: path.join(job, 'private.log'),
      timeoutMs: options.timeoutMs, signal: controller.signal, pm2Home });
    const result: Record<string, unknown> = { id, ...outcome };
    results.push(result); return { tmp, result };
  };
  try {
    const handle = await fs.open(lock, 'wx', 0o600); ownsLock = true;
    await handle.writeFile(lockValue); await handle.close();
    report.phase = 'preflight';
    const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd, timeout: 10000 })).stdout.trim(); assert.match(revision, /^[a-f0-9]{40}$/);
    report.revision = revision;
    report.dirty = Boolean((await exec('git', ['status', '--porcelain'], { cwd, timeout: 10000 })).stdout.trim());
    activationBefore = await fs.realpath(activation).catch(() => null);
    const connection = suite === 'auth-control' ? 'cortex_missing_auth_fixture'
      : process.env.CORTEX_TEST_CONNECTION || (await new CortexConnections().list())[0]?.name;
    assert.ok(connection, 'Select a saved native connection');
    const profile: CliProfile = { id: 'cortex-compatibility', name: 'CoCo compatibility', harness: 'cortex-code', authMode: 'account',
      command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: startedAt, updatedAt: startedAt };
    const runtime = resolveCortexRuntime({ profile, cwd, workspaceId: 'cortex-compatibility' });
    executable = runtime.command; executableBefore = await fs.stat(executable);
    const distribution = path.basename(path.dirname(executable)); assert.match(distribution, /^1\.2\.35\+\d{6}\.[a-f0-9]{7,40}$/);
    report.cliVersion = await cortexVersion(runtime, controller.signal); assert.equal(report.cliVersion, '1.2.35');
    report.cliDistribution = distribution; report.versionAndLaunchPinned = true;
    jobEnv.CORTEX_TEST_COMMAND = executable; jobEnv.CORTEX_TEST_CONNECTION = connection;
    jobEnv.CORTEX_TEST_MODEL = 'claude-sonnet-4-6';
    // Subset flags must never silently change a catalog probe's meaning.
    delete jobEnv.CORTEX_UPDATE_UI_PROBE;
    if (suite === 'auth-control') delete jobEnv.CORTEX_TEST_CONNECTION;
    if (suite === 'ui' || suite === 'workflows') {
      report.phase = 'build';
      for (const side of ['web', 'mobile']) {
        const mobile = side === 'mobile', app = mobile ? path.join(cwd, 'mobile/AgentCockpitPWA') : cwd;
        const built = await run(`build-${side}`, process.execPath,
          [path.join(app, 'node_modules/vite/bin/vite.js'), 'build', ...(mobile ? [] : ['--config', 'web/AgentCockpitWeb/vite.config.ts'])],
          { cwd: app, env: { NODE_ENV: 'production' }, timeoutMs: 120000 });
        assert.equal(built.result.passed, true, 'Production asset build failed');
      }
    }
    report.phase = 'probes';
    for (const probe of selected) {
      const { tmp, result } = await run(probe.id, process.execPath, ['--import', 'tsx', `scripts/probe-cortex-${probe.id}.ts`],
        { env: { [probe.flag]: '1' }, timeoutMs: probe.minutes * 60_000 });
      try {
        const checks = suite === 'workflows' || suite === 'auth-control' ? CORTEX_WORKFLOW_CHECKS[probe.id] : [];
        const native = await readCortexProbeReport(tmp, probe.prefix, revision, checks);
        result.native = native; result.passed = result.passed === true && native.passed;
      }
      catch { result.reportInvalid = true; result.passed = false; }
      assert.equal(result.passed, true, 'Probe failed or did not drain');
      assert.equal((result.native as { passed: boolean }).passed, true, 'Native report did not pass');
    }
    report.passed = true; delete report.phase;
  } catch (error) {
    report.failureKind = error instanceof Error ? error.name : 'Unknown';
    if (!ownsLock) report.lockUnavailable = true;
    // Keep diagnostics private; shareable reports never copy raw probe errors.
    await fs.writeFile(path.join(root, 'private-failure.txt'), error instanceof Error ? error.stack || error.message : 'Compatibility run failed', { mode: 0o600 });
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline); process.off('SIGINT', abort); process.off('SIGTERM', abort);
    report.pm2Cleanup = await drainCortexPm2(pm2Home, cwd, jobEnv);
    if (!(report.pm2Cleanup as { drained: boolean }).drained) report.passed = false;
    if (executable && executableBefore) {
      const after = await fs.stat(executable).catch(() => null);
      report.retainedExecutableUnchanged = after?.size === executableBefore.size && after.mtimeMs === executableBefore.mtimeMs;
      if (!report.retainedExecutableUnchanged) report.passed = false;
    }
    if (activationBefore !== undefined) {
      report.normalActivationUnchanged = await fs.realpath(activation).catch(() => null) === activationBefore;
      if (!report.normalActivationUnchanged) report.passed = false;
    }
    if (ownsLock) {
      if (await fs.readFile(lock, 'utf8').catch(() => null) === lockValue) await fs.rm(lock);
      else { report.lockOwnershipChanged = true; report.passed = false; }
    }
    if (!report.passed) process.exitCode = 1;
    await fs.writeFile(path.join(root, 'compatibility-report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    const completed = results.filter(result => selected.some(probe => probe.id === result.id)).length;
    process.stdout.write(`CoCo ${suite} ${report.scope}: ${report.passed ? 'passed' : 'failed'} (completed ${completed}/${selected.length}, selected ${selected.length}/${CORTEX_PROBES[suite].length}). Report: ${path.join(root, 'compatibility-report.json')}\n`);
  }
}
