import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import type { CliProfile } from '../src/types';
import type { RoutineRunRecord } from '../src/contracts/routines';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { CortexSessions } from '../src/services/backends/cortexSessions';
import { cortexVersion, resolveCortexRuntime, startCortexRuntime } from '../src/services/backends/cortexRuntime';
import { cortexRecord } from '../src/services/backends/cortexProtocol';
import { cortexHasCompleteUsage } from '../src/services/backends/cortexUsage';
import { RoutinesScheduler, RoutinesService } from '../src/services/routines/service';
import { createRoutineRouter } from '../src/routes/chat/routineRoutes';
import { createChatRouterEnv, destroyChatRouterEnv } from '../test/helpers/chatEnv';

/** Native proposal/chat and Routine services; all outreach is an injected stub. */
async function main() {
  assert.equal(process.env.CORTEX_ROUTINES_PROBE, '1', 'Set CORTEX_ROUTINES_PROBE=1 for real inference');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1');
  assert.equal(process.platform, 'darwin', 'This probe certifies macOS only');
  const connection = process.env.CORTEX_TEST_CONNECTION; assert.ok(connection, 'Select an authenticated named connection');
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-routines-')); await fs.chmod(reportDir, 0o700);
  const results: Record<string, unknown> = { stage: 'setup' };
  const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  const env = await createChatRouterEnv({ configureDefaultCli: false });
  const workspace = path.join(env.tmpDir, 'workspace'); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), `# Isolated Routine compatibility fixture\nOnly perform the supplied synthetic fixture work. Paths under ${env.tmpDir} supplied by Cockpit are authorized. Routine authoring proposals and local run files are authorized. Never enable/disable/install/reschedule routines or use native schedules, agents, memory, SQL, external connectors, publishing or outreach. Writing the supplied local notify.md is allowed; only the fixture stub handles it.\n`);
  const calls: Array<{ usage: boolean; timeout: boolean }> = []; let timeoutNext = false; let expired = false;
  const sessions = new CortexSessions(async (...args) => {
    const runtime = await startCortexRuntime(...args); const prompt = runtime.prompt.bind(runtime);
    runtime.prompt = async (blocks, timeout) => {
      const call = { usage: false, timeout: timeoutNext }; timeoutNext = false; calls.push(call);
      const result = await prompt(blocks, timeout); call.usage = cortexHasCompleteUsage(cortexRecord(result).usage); return result;
    };
    return runtime;
  });
  const adapter = new CortexCodeAdapter({ sessions, workingDir: workspace }); env.backendRegistry.register(adapter);
  let now = new Date(); const notifications: string[] = [];
  const service = new RoutinesService({ chatService: env.chatService, backendRegistry: env.backendRegistry, now: () => now,
    notifier: { sendTelegram: async (settings, content) => {
      assert.equal(settings.telegram?.botToken, 'fixture-token'); assert.equal(settings.telegram?.chatId, 'fixture-destination'); notifications.push(content);
    } } });
  // The normal app fixture has its own notifier; all execution routes here use the stub-owned service.
  env.app.use('/cortex-routines-fixture', createRoutineRouter({ chatService: env.chatService, routinesService: service }));
  const pending = new Set<Promise<RoutineRunRecord | null>>(); const execute = service.runRoutine.bind(service);
  service.runRoutine = (...args) => {
    if (expired) return Promise.reject(new Error('Native Routine probe completion deadline exceeded.'));
    const job = execute(...args); pending.add(job); void job.finally(() => pending.delete(job)).catch(() => {}); return job;
  };
  const selected: Array<{ profile: boolean; model?: string; effort?: string; timeoutMs?: number }> = [];
  const oneShot = adapter.runOneShot.bind(adapter);
  adapter.runOneShot = (prompt, options = {}) => {
    if (expired) return Promise.reject(new Error('Native Routine probe completion deadline exceeded.'));
    if (prompt.startsWith('# Agent Cockpit Routine Execution')) {
      assert.equal(options.allowTools, true); assert.equal(options.workingDir, workspace);
      selected.push({ profile: options.cliProfile?.id === 'setup-cortex-code-account', model: options.model, effort: options.effort, timeoutMs: options.timeoutMs });
    }
    return oneShot(prompt, options);
  };
  const deadline = setTimeout(() => {
    expired = true; for (const entry of env.activeStreams.values()) entry.abort(); adapter.shutdown();
  }, 10 * 60_000);
  const profile: CliProfile = { id: 'setup-cortex-code-account', name: 'Native Routine fixture', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: '', updatedAt: '' };
  let workspaceId = '';
  const route = () => `/cortex-routines-fixture/workspaces/${workspaceId}/routines`;
  async function waitForRun(runId: string, status: 'completed' | 'failed') {
    const end = Date.now() + 180_000;
    while (!expired && Date.now() < end) {
      const detail = await service.getRoutine(workspaceId, 'fixture-radar'); const run = detail?.runs.find(item => item.runId === runId);
      if (!service.isRunning(workspaceId, 'fixture-radar') && run && run.status !== 'running') {
        assert.equal(run.status, status, 'Unexpected terminal Routine status'); return run;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Native Routine did not complete');
  }
  try {
    results.cliVersion = await cortexVersion(resolveCortexRuntime({ profile, workspaceId: 'routines-probe', cwd: workspace }));
    await env.chatService.saveSettings({ ...(await env.chatService.getSettings()), cliProfiles: [profile], defaultCliProfileId: profile.id });
    const conversation = await env.chatService.createConversation('Routine fixture', workspace, 'cortex-code', 'claude-sonnet-4-6', 'low', profile.id);
    workspaceId = conversation.workspaceId; const scheduler = new RoutinesScheduler({ service });
    results.stage = 'disabled-opt-in';
    assert.equal((await env.request('GET', route())).body.enabled, false); assert.equal(await scheduler.tick(), 0);
    await assert.rejects(fs.stat(service.getRoutinesDir(workspaceId)), { code: 'ENOENT' }); assert.equal(calls.length, 0);
    assert.equal((await env.request('PUT', `${route()}/enabled`, { enabled: true })).status, 200);
    assert.match(await fs.readFile(path.join(workspace, 'AGENTS.md'), 'utf8'), /Agent Cockpit Routines/);
    results.stage = 'native-chat-proposal';
    const ws = await env.connectWs(conversation.id); const reading = env.readWsEvents(ws, 240_000);
    try {
      assert.equal((await env.request('POST', `/api/chat/conversations/${conversation.id}/message`, { content:
        `Create an Agent Cockpit Routine proposal for this synthetic fixture. Read the installed authoring contract at ${service.getAuthoringPath(workspaceId)}. Use id fixture-radar, title Fixture Radar, state proposed, manual trigger, cliProfileId ${profile.id}, model claude-sonnet-4-6, effort low, timeoutMinutes 2, outputRetentionDays 1, notification mode workspaceDefault. The routine must read its provided persistent state cursor.json (missing means count 0), increment count exactly once per run, write JSON {"count":N} back there, write a report.txt containing ROUTINE_NATIVE_4827 and the count in the provided Output folder, write a scratch.txt in the Temporary folder, and write a concise local notify.md containing ROUTINE_NOTIFY_4827 and the count at the provided Notification file. Its final response must include ROUTINE_DONE_4827 and the count. Use only the runtime-provided paths. Do not install/enable/run/schedule it or send any message yourself. End this proposal reply with the exact AGENT_COCKPIT_ROUTINE_PROPOSAL marker for its manifest.json.` })).status, 200);
      const frames = await reading; assert.equal(frames.filter(frame => frame.type === 'done').length, 1);
      assert.equal(frames.some(frame => frame.type === 'error' && frame.terminal !== false), false); assert.equal(frames.filter(frame => frame.type === 'usage').length, 1);
    } finally { ws.close(); }
    const saved = await env.chatService.getConversation(conversation.id);
    const answer = saved!.messages.filter(message => message.role === 'assistant').map(message => message.content).join('\n');
    const validation = await env.request('POST', `${route()}/proposals/validate`, { content: answer });
    assert.equal(validation.status, 200); assert.equal(validation.body.proposals.length, 1);
    assert.equal(validation.body.proposals[0].routineId, 'fixture-radar'); assert.equal(validation.body.proposals[0].manifest.state, 'proposed');
    assert.equal((await env.request('POST', `${route()}/fixture-radar/run`, {})).status, 409); assert.equal(await scheduler.tick(), 0);
    assert.equal((await env.request('POST', `${route()}/fixture-radar/install`, { state: 'enabled' })).status, 200);
    assert.equal((await service.validateProposalMarkers(workspaceId, answer))[0].manifest.state, 'enabled');
    results.proposalAndInstall = true; process.stdout.write('Native Routine proposal/install passed\n');
    await service.updateWorkspaceSettings(workspaceId, { telegram: { enabled: true, botToken: 'fixture-token', chatId: 'fixture-destination' } });
    results.stage = 'native-manual-run';
    const oldDir = path.join(service.getRoutineDir(workspaceId, 'fixture-radar'), 'runs', 'expired-fixture'); await fs.mkdir(oldDir, { recursive: true });
    const old = new Date(now.getTime() - 2 * 24 * 60 * 60_000); await fs.utimes(oldDir, old, old);
    const started = await env.request('POST', `${route()}/fixture-radar/run`, {}); assert.equal(started.status, 200);
    const manual = await waitForRun(started.body.run.runId, 'completed');
    assert.match(await fs.readFile(manual.finalPath!, 'utf8'), /ROUTINE_DONE_4827/);
    assert.match(await fs.readFile(path.join(manual.outputDir, 'report.txt'), 'utf8'), /ROUTINE_NATIVE_4827/);
    assert.ok((await fs.stat(path.join(manual.tmpDir, 'scratch.txt'))).isFile());
    const cursor = path.join(service.getRoutinePersistentStateDir(workspaceId, 'fixture-radar'), 'cursor.json');
    assert.equal(JSON.parse(await fs.readFile(cursor, 'utf8')).count, 1); assert.equal(notifications.length, 1); assert.match(notifications[0], /ROUTINE_NOTIFY_4827/);
    const input = await fs.readFile(manual.inputPath, 'utf8'); assert.doesNotMatch(input, /fixture-token|fixture-destination/);
    assert.match(input, /Workspace Context: disabled/); assert.match(input, /Knowledge Base: disabled/);
    assert.deepEqual(selected[0], { profile: true, model: 'claude-sonnet-4-6', effort: 'low', timeoutMs: 120_000 });
    await assert.rejects(fs.stat(oldDir), { code: 'ENOENT' });
    const tree = await env.request('GET', `/api/chat/workspaces/${workspaceId}/explorer/tree?scope=routine-output&routineId=fixture-radar&runId=${encodeURIComponent(manual.runId)}`);
    assert.equal(tree.status, 200); assert.ok(tree.body.entries.some((entry: { name: string }) => entry.name === 'report.txt'));
    await assert.rejects(fs.stat(path.join(workspace, '.agent-cockpit')), { code: 'ENOENT' });
    results.manualOutputStateHistoryAndStub = true; process.stdout.write('Native manual Routine/files/stub outreach passed\n');
    results.stage = 'native-scheduled-run';
    await service.updateRoutine(workspaceId, 'fixture-radar', { manifest: { trigger: { type: 'schedule', intervalMinutes: 15, timezone: 'UTC' } } });
    assert.equal(await scheduler.tick(), 0); now = new Date(now.getTime() + 16 * 60_000);
    assert.equal(await scheduler.tick(), 1);
    const end = Date.now() + 10_000; let scheduledId: string | undefined;
    while (!scheduledId && Date.now() < end) {
      const last = (await service.getRoutine(workspaceId, 'fixture-radar'))?.lastRun;
      if (last?.runId !== manual.runId) scheduledId = last?.runId;
      if (!scheduledId) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(scheduledId); const scheduled = await waitForRun(scheduledId, 'completed'); assert.equal(scheduled.source, 'scheduled');
    assert.equal(JSON.parse(await fs.readFile(cursor, 'utf8')).count, 2); assert.equal(notifications.length, 2); assert.equal(await scheduler.tick(), 0);
    assert.equal((await service.getRoutine(workspaceId, 'fixture-radar'))?.runs.length, 2); results.scheduledStateContinuity = true;
    results.stage = 'native-minute-timeout';
    await service.updateRoutine(workspaceId, 'fixture-radar', { manifest: { timeoutMinutes: 1, trigger: { type: 'manual' } },
      routineContent: '# Synthetic deadline fixture\nUse the shell tool for exactly one foreground Python command that writes TIMEOUT_STARTED_4827 into timeout-started.txt under the supplied Output folder, writes TIMEOUT_NOTIFY_4827 into the supplied Notification file, then sleeps for 120 seconds. Do not detach, background, shorten the sleep, stop early, retry, send any messages, or change persistent state. Return only after that command finishes. The Cockpit owner will enforce its configured deadline.\n' });
    const beforeTimeout = calls.length; timeoutNext = true; const startTime = Date.now();
    const timeoutRun = await env.request('POST', `${route()}/fixture-radar/run`, {}); assert.equal(timeoutRun.status, 200);
    const duplicate = await env.request('POST', `${route()}/fixture-radar/run`, {}); assert.equal(duplicate.status, 409);
    const failed = await waitForRun(timeoutRun.body.run.runId, 'failed'); const elapsedMs = Date.now() - startTime;
    assert.match(failed.errorMessage || '', /timed out/i); assert.ok(elapsedMs >= 55_000 && elapsedMs < 100_000);
    assert.equal(selected.at(-1)?.timeoutMs, 60_000); assert.equal(calls.length, beforeTimeout + 1); assert.equal(notifications.length, 2);
    assert.equal(failed.finalPath, undefined); assert.match(await fs.readFile(path.join(failed.outputDir, 'timeout-started.txt'), 'utf8'), /TIMEOUT_STARTED_4827/);
    assert.equal(JSON.parse(await fs.readFile(cursor, 'utf8')).count, 2);
    results.nativeMinuteTimeoutWithoutRetryOrOutreach = true; results.timeoutElapsedMs = elapsedMs;
    process.stdout.write('Native one-minute Routine timeout/no-resend passed\n');
    results.stage = 'disabled-and-fresh'; const beforeDisable = calls.length;
    assert.equal((await env.request('PUT', `${route()}/enabled`, { enabled: false })).status, 200);
    assert.equal((await env.request('GET', route())).body.routines.length, 0); assert.equal(await scheduler.tick(), 0);
    assert.equal((await env.request('POST', `${route()}/fixture-radar/run`, {})).status, 403); assert.equal(calls.length, beforeDisable);
    assert.doesNotMatch(await fs.readFile(path.join(workspace, 'AGENTS.md'), 'utf8'), /AGENT_COCKPIT_ROUTINES_START/);
    assert.equal(JSON.parse(await fs.readFile(cursor, 'utf8')).count, 2);
    assert.equal(await adapter.runOneShot('Reply exactly ROUTINES_READY. Do not use tools.', { allowTools: true, cliProfile: profile,
      model: 'claude-sonnet-4-6', effort: 'low', timeoutMs: 120_000 }), 'ROUTINES_READY');
    results.disabledPreservesDataAndFreshInference = true; results.nativeCalls = calls.length;
    results.completeUsage = calls.filter(call => !call.timeout).every(call => call.usage); assert.equal(results.completeUsage, true);
    results.passed = true; delete results.stage;
  } catch (error) {
    results.failure = { kind: error instanceof assert.AssertionError ? 'assertion' : 'execution',
      line: error instanceof Error ? error.stack?.match(/probe-cortex-routines\.ts:(\d+)/)?.[1] : undefined }; throw error;
  } finally {
    clearTimeout(deadline); adapter.shutdown(); await adapter.stopping; await Promise.allSettled(pending); await destroyChatRouterEnv(env);
    await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Private Routine evidence: ${reportDir}\n`);
  }
}
void main().catch(() => { process.stderr.write('Cortex Routine probe failed; inspect the private stage report.\n'); process.exitCode = 1; });
