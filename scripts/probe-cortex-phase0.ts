/** Opt-in native research only; this is not the production CoCo adapter. */
import assert from 'assert/strict';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createInterface } from 'readline';
import { GrokAcpClient, grokRecord } from '../src/services/backends/grokProtocol';
import { GrokProcessScope } from '../src/services/backends/grokProcess';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Fixture condition timed out');
    await delay(100);
  }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

async function main(): Promise<void> {
  assert.equal(process.env.CORTEX_PHASE0, '1', 'Set CORTEX_PHASE0=1 to authorize real native requests');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1', 'Native ACP test mode is not real inference evidence');
  assert.equal(process.platform, 'darwin', 'This probe currently certifies macOS only');
  const connection = process.env.CORTEX_TEST_CONNECTION;
  assert.ok(connection, 'Set CORTEX_TEST_CONNECTION to an existing authenticated named connection');
  const command = process.env.CORTEX_TEST_COMMAND || 'cortex';
  const model = process.env.CORTEX_TEST_MODEL || 'claude-sonnet-4-6';
  const version = spawnSync(command, ['--no-auto-update', '--version'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(version.status, 0, 'CLI version probe failed');
  assert.match(version.stdout, /Cortex Code v1\.2\.35\b/, 'Review the probe against a changed CLI version first');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-phase0-'));
  await fs.chmod(root, 0o700);
  const results: Record<string, unknown> = {};
  const report = {
    startedAt: new Date().toISOString(), cliVersion: version.stdout.trim(),
    platform: process.platform, arch: process.arch, node: process.version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()),
    results,
  };

  async function start(name: string, extra: string[] = [], overrides: NodeJS.ProcessEnv = {}) {
    const cwd = path.join(root, name);
    await fs.mkdir(cwd, { recursive: true });
    const child = spawn(command, ['acp', 'serve', '-c', connection!, '-w', cwd,
      '--only-explicit-plugins', '--only-explicit-skills', '--only-explicit-mcp-servers', ...extra], {
      cwd, env: { ...process.env, CORTEX_ENABLE_MEMORY: '0', ...overrides },
      detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Evaluate the existing ownership pattern without introducing a production
    // dependency from CoCo to Grok. These helpers are research-only scaffolding.
    const scope = new GrokProcessScope(child);
    scope.watch();
    const client = new GrokAcpClient(child, () => scope.stop());
    let stderrBytes = 0;
    let loginPromptSeen = false;
    const stderrLines = createInterface({ input: child.stderr });
    stderrLines.on('line', line => {
      stderrBytes += Buffer.byteLength(line);
      if (/https?:\/\/\S+\/(?:oauth|authorize)|paste.*redirect|open.*browser/i.test(line)) loginPromptSeen = true;
    });
    const updates: Record<string, unknown>[] = [];
    client.subscribe(frame => {
      if (frame.id !== undefined && frame.method) {
        const options = grokRecord(frame.params).options;
        const permitted = !extra.includes('--allowed-tools') && Array.isArray(options)
          ? options.map(grokRecord).find(option => option.kind === 'allow_once') : undefined;
        client.respond(frame.id, { outcome: permitted
          ? { outcome: 'selected', optionId: permitted.optionId }
          : { outcome: 'cancelled' } });
      } else if (frame.method === 'session/update') updates.push(grokRecord(frame.params?.update));
    });
    let sessionId: string;
    try {
      await client.request('initialize', { protocolVersion: 1,
        clientInfo: { name: 'cockpit-cortex-phase0', version: '1' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      const session = grokRecord(await client.request('session/new', { cwd, mcpServers: [] }, 60_000));
      assert.equal(typeof session.sessionId, 'string');
      sessionId = session.sessionId as string;
      for (const [configId, value] of [['model', model], ['thought_level', 'low']]) {
        await client.request('session/set_config_option', { sessionId, configId, value });
      }
    } catch (error) { client.close(); throw error; }
    function prompt(text: string) {
      const first = updates.length;
      const started = Date.now();
      const request = client.request('session/prompt', { sessionId,
        prompt: [{ type: 'text', text }] }, 90_000).then(value => {
        const turn = updates.slice(first);
        return { result: grokRecord(value), elapsedMs: Date.now() - started,
          text: turn.filter(update => update.sessionUpdate === 'agent_message_chunk')
            .map(update => grokRecord(update.content).text || '').join('').trim(),
          toolCalls: turn.filter(update => update.sessionUpdate === 'tool_call').length };
      });
      return request;
    }
    async function close() {
      client.close();
      stderrLines.close();
      await until(() => child.exitCode !== null || child.signalCode !== null, 7_000);
    }
    return { cwd, child, client, sessionId, prompt, close, diagnostics: () => ({ stderrBytes, loginPromptSeen }) };
  }

  async function sleeper(cwd: string) {
    await fs.writeFile(path.join(cwd, 'fixture-sleeper.py'),
      'from pathlib import Path\nimport os,time\np=Path(__file__).parent\n' +
      '(p/"sleeper.pid").write_text(str(os.getpid()))\nprint("SLEEP_STARTED",flush=True)\n' +
      'time.sleep(12)\n(p/"unexpected.txt").write_text("UNEXPECTED")\n');
  }
  const sleeperPrompt = 'Use bash to run exactly python3 fixture-sleeper.py and wait. This is an intentional ' +
    'cancellation/crash test. Never retry an interrupted command. Do not use agents, SQL, web, or files outside this temporary workspace.';

  try {
    const runtime = await start('managed');
    try {
      await fs.writeFile(path.join(runtime.cwd, 'AGENTS.md'),
        'When asked to perform the workspace instruction check, reply exactly PHASE0_INSTRUCTIONS_OK.\n');
      const turn = await runtime.prompt('Perform the workspace instruction check defined in AGENTS.md.');
      assert.equal(turn.text, 'PHASE0_INSTRUCTIONS_OK');
      assert.ok(turn.result.usage);
      results.managedStartup = { cleanJsonRpc: true, instructionsFollowed: true,
        authenticatedInference: true, ...runtime.diagnostics() };
      process.stdout.write('PASS managed startup, workspace instructions, authenticated inference\n');

      await sleeper(runtime.cwd);
      const pending = runtime.prompt(sleeperPrompt);
      void pending.catch(() => {});
      await until(() => exists(path.join(runtime.cwd, 'sleeper.pid')), 70_000);
      const pid = Number(await fs.readFile(path.join(runtime.cwd, 'sleeper.pid'), 'utf8'));
      try {
        const began = Date.now();
        runtime.client.notify('session/cancel', { sessionId: runtime.sessionId });
        const cancelled = await pending;
        assert.equal(cancelled.result.stopReason, 'cancelled');
        await until(() => !alive(pid), 7_000);
        const followup = await runtime.prompt('Reply exactly PHASE0_AFTER_CANCEL. Do not call tools.');
        assert.equal(followup.text, 'PHASE0_AFTER_CANCEL');
        await delay(13_000);
        assert.equal(await exists(path.join(runtime.cwd, 'unexpected.txt')), false);
        results.cancellation = { stopReason: cancelled.result.stopReason,
          cancelAndFollowupMs: Date.now() - began - 13_000, sleeperStopped: true,
          delayedFileAbsent: true, subsequentTurnWorks: true };
        process.stdout.write('PASS native cancellation, child cleanup, subsequent turn\n');
      } finally {
        // The runtime scope retains identity checks for fallback cleanup.
        if (alive(pid)) runtime.client.close();
      }
    } finally { await runtime.close(); }

    const crash = await start('root-crash');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      await sleeper(crash.cwd);
      const pending = crash.prompt(sleeperPrompt);
      void pending.catch(() => {});
      await until(() => exists(path.join(crash.cwd, 'sleeper.pid')), 70_000);
      const pid = Number(await fs.readFile(path.join(crash.cwd, 'sleeper.pid'), 'utf8'));
      await delay(800); // Allow the ownership watcher to observe the child before root death.
      crash.child.kill('SIGKILL');
      await assert.rejects(pending);
      await until(() => !alive(pid), 7_000);
      assert.ok(unrelated.pid && alive(unrelated.pid));
      await delay(13_000);
      assert.equal(await exists(path.join(crash.cwd, 'unexpected.txt')), false);
      results.rootCrash = { descendantStopped: true, unrelatedProcessSurvived: true,
        delayedFileAbsent: true, containment: 'existing GrokProcessScope research reuse' };
      process.stdout.write('PASS forced root exit, descendant cleanup, unrelated process preservation\n');
    } finally { unrelated.kill(); await crash.close(); }

    const restricted = await start('restricted', ['--allowed-tools', 'COCKPIT_NO_SUCH_TOOL']);
    try {
      const secret = 'PRIVATE_FIXTURE_' + Date.now();
      await fs.writeFile(path.join(restricted.cwd, 'secret.txt'), secret);
      const turn = await restricted.prompt('Attempt to read secret.txt using the native read tool, then write blocked.txt containing TEST. ' +
        'If denied, stop without retrying or working around it. Do not use agents, SQL, web, or files outside this workspace.');
      assert.equal(turn.text.includes(secret), false);
      assert.equal(await exists(path.join(restricted.cwd, 'blocked.txt')), false);
      results.restrictions = { testedReadWriteBlocked: true, toolCallsEmitted: turn.toolCalls,
        restrictedTextCertified: false, reason: 'Allowlist does not establish zero tool definitions, hooks, commands or deferred execution' };
      process.stdout.write(`GATE restricted text remains unavailable; ${turn.toolCalls} native tool calls emitted\n`);
    } finally { await restricted.close(); }

    const emptyHome = path.join(root, 'empty-snowflake-home');
    await fs.mkdir(emptyHome);
    const missingAuth = await start('missing-auth', [], { SNOWFLAKE_HOME: emptyHome });
    try {
      const turn = await missingAuth.prompt('Reply exactly PHASE0_AUTH_SHOULD_FAIL. Do not call tools.');
      assert.notEqual(turn.text, 'PHASE0_AUTH_SHOULD_FAIL');
      assert.match(turn.text, /connection|authenticat|credential/i);
      assert.equal(missingAuth.diagnostics().loginPromptSeen, false);
      results.missingAuth = { sessionCreationSucceeded: true, inferenceFailed: true,
        stopReason: turn.result.stopReason, hasUsage: Boolean(turn.result.usage),
        boundedMs: turn.elapsedMs, ...missingAuth.diagnostics() };
      process.stdout.write('PASS empty auth home fails actual inference without a waiting login wizard\n');
    } finally { await missingAuth.close(); }
    results.probePassed = true;
  } finally {
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2));
    process.stdout.write(`Private phase-0 evidence: ${root}\n`);
  }
}

main().catch(error => {
  // Native exception text can contain an account/URL; retain only the error type.
  process.stderr.write(`Phase-0 probe failed (${error instanceof Error ? error.name : 'unknown'}).\n`);
  process.exitCode = 1;
});
