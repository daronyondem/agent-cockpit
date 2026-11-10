import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import type { CliProfile } from '../src/types';
import { CortexSessions } from '../src/services/backends/cortexSessions';
import { cortexRecord } from '../src/services/backends/cortexProtocol';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 70_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Fixture deadline exceeded'); await delay(100); }
}
async function exists(file: string) { try { await fs.access(file); return true; } catch { return false; } }

async function main() {
  assert.equal(process.env.CORTEX_RUNTIME_PROBE, '1', 'Set CORTEX_RUNTIME_PROBE=1 to authorize real native inference');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1', 'Native test mode is not authentication evidence');
  assert.equal(process.platform, 'darwin', 'This native probe currently certifies macOS only');
  const connection = process.env.CORTEX_TEST_CONNECTION;
  assert.ok(connection, 'Set CORTEX_TEST_CONNECTION to an existing authenticated named connection');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-runtime-'));
  await fs.chmod(root, 0o700);
  const profile: CliProfile = { id: 'runtime-probe', name: 'Runtime probe', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: '', updatedAt: '' };
  const sessions = new CortexSessions();
  const results: Record<string, unknown> = {};
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), platform: process.platform,
    arch: process.arch, node: process.version, results,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()) };
  async function acquire(name: string, selected = profile, sessionId?: string) {
    const cwd = path.join(root, name);
    await fs.mkdir(cwd, { recursive: true });
    const runtime = await sessions.acquire(name, { profile: selected, workspaceId: name, cwd, sessionId });
    report.cliVersion = runtime.version;
    assert.equal(runtime.version, '1.2.35', 'Review this smoke probe before certifying another CLI version');
    for (const [configId, value] of [['model', process.env.CORTEX_TEST_MODEL || 'claude-sonnet-4-6'], ['thought_level', 'low']]) {
      await runtime.client.request('session/set_config_option', { sessionId: runtime.sessionId, configId, value });
    }
    const updates: Record<string, unknown>[] = [];
    runtime.subscribe(frame => {
      if (frame.id !== undefined) {
        const options = frame.params?.options;
        const option = frame.method === 'session/request_permission' && Array.isArray(options)
          ? options.map(cortexRecord).find(item => item.kind === 'allow_once') : undefined;
        runtime.client.respond(frame.id, { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } });
        return true;
      }
      if (frame.method === 'session/update') updates.push(cortexRecord(frame.params?.update));
    });
    function prompt(text: string) {
      const first = updates.length;
      return runtime.prompt([{ type: 'text', text }], 90_000).then(value => ({ result: cortexRecord(value),
        text: updates.slice(first).filter(item => item.sessionUpdate === 'agent_message_chunk')
          .map(item => cortexRecord(item.content).text || '').join('').trim() }));
    }
    return { runtime, cwd, prompt };
  }
  async function sleeper(cwd: string) {
    await fs.writeFile(path.join(cwd, 'fixture-sleeper.py'), 'from pathlib import Path\nimport os,time\np=Path(__file__).parent\n'
      + '(p/"sleeper.pid").write_text(str(os.getpid()))\nprint("SLEEP_STARTED",flush=True)\ntime.sleep(12)\n(p/"unexpected.txt").write_text("UNEXPECTED")\n');
  }
  const sleepPrompt = 'Use bash to run exactly python3 fixture-sleeper.py and wait. This is an intentional cancellation/crash test. '
    + 'Never retry an interrupted command. Do not use agents, SQL, web, or files outside this temporary workspace.';
  try {
    const first = await acquire('managed');
    const turn = await first.prompt('Reply exactly CORTEX_RUNTIME_OK. Do not call tools.');
    assert.equal(turn.text, 'CORTEX_RUNTIME_OK'); assert.ok(turn.result.usage);
    results.authenticatedInference = { passed: true, ...first.runtime.client.diagnostics };
    process.stdout.write('PASS managed launch and actual authenticated inference\n');

    await sleeper(first.cwd);
    const pending = first.prompt(sleepPrompt);
    void pending.catch(() => {});
    await until(() => exists(path.join(first.cwd, 'sleeper.pid')));
    const pid = Number(await fs.readFile(path.join(first.cwd, 'sleeper.pid'), 'utf8'));
    await first.runtime.cancel();
    assert.equal((await pending).result.stopReason, 'cancelled');
    await until(() => !alive(pid), 7_000);
    assert.equal((await first.prompt('Reply exactly CORTEX_AFTER_CANCEL. Do not call tools.')).text, 'CORTEX_AFTER_CANCEL');
    await delay(13_000);
    assert.equal(await exists(path.join(first.cwd, 'unexpected.txt')), false);
    results.cancel = { nativeCancel: true, childStopped: true, noDelayedWrite: true, subsequentTurn: true };
    process.stdout.write('PASS native cancellation, child cleanup and subsequent turn\n');

    const saved = first.runtime.sessionId!;
    await sessions.reset('managed');
    const loaded = await acquire('managed', profile, saved);
    assert.equal((await loaded.prompt('Reply exactly CORTEX_AFTER_LOAD. Do not call tools.')).text, 'CORTEX_AFTER_LOAD');
    results.load = { savedSessionLoadedInFreshProcess: true };
    process.stdout.write('PASS session load in a fresh process\n');

    const crash = await acquire('root-crash');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      await sleeper(crash.cwd);
      const interrupted = crash.prompt(sleepPrompt);
      const rejected = assert.rejects(interrupted);
      await until(() => exists(path.join(crash.cwd, 'sleeper.pid')));
      const descendant = Number(await fs.readFile(path.join(crash.cwd, 'sleeper.pid'), 'utf8'));
      await delay(800);
      crash.runtime.client.process.kill('SIGKILL');
      await rejected;
      await crash.runtime.client.close();
      await until(() => !alive(descendant), 7_000);
      assert.ok(unrelated.pid && alive(unrelated.pid));
      await delay(13_000);
      assert.equal(await exists(path.join(crash.cwd, 'unexpected.txt')), false);
      results.rootExit = { detachedDescendantStopped: true, unrelatedSurvived: true, noDelayedWrite: true };
      process.stdout.write('PASS forced root exit and owned descendant cleanup\n');
    } finally { unrelated.kill(); }

    const emptyHome = path.join(root, 'empty-auth');
    await fs.mkdir(emptyHome);
    const missing = await acquire('missing-auth', { ...profile, configDir: emptyHome });
    const failed = await missing.prompt('Reply exactly CORTEX_AUTH_SHOULD_FAIL. Do not call tools.');
    assert.notEqual(failed.text, 'CORTEX_AUTH_SHOULD_FAIL');
    assert.match(failed.text, /connection|authenticat|credential/i);
    assert.equal(missing.runtime.client.diagnostics.loginPromptSeen, false);
    results.missingAuth = { sessionCreationIsNotAuthEvidence: true, inferenceFailed: true, noWaitingBrowserWizard: true };
    process.stdout.write('PASS missing auth fails actual inference without a browser wizard\n');

    await sessions.shutdown();
    const reused = await acquire('after-shutdown');
    assert.equal((await reused.prompt('Reply exactly CORTEX_AFTER_SHUTDOWN. Do not call tools.')).text, 'CORTEX_AFTER_SHUTDOWN');
    results.shutdown = { reusable: true };
    results.passed = true;
    process.stdout.write('PASS reusable runtime pool after shutdown\n');
  } finally {
    await sessions.shutdown();
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Private runtime evidence: ${root}\n`);
  }
}

main().catch(error => {
  process.stderr.write(`Cortex runtime probe failed (${error instanceof Error ? error.name : 'unknown'}).\n`);
  process.exitCode = 1;
});
