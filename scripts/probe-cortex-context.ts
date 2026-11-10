import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import type { CliProfile, MemoryUpdateEvent } from '../src/types';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { CortexSessions } from '../src/services/backends/cortexSessions';
import { cortexVersion, resolveCortexRuntime, startCortexRuntime } from '../src/services/backends/cortexRuntime';
import { cortexRecord } from '../src/services/backends/cortexProtocol';
import { cortexHasCompleteUsage } from '../src/services/backends/cortexUsage';
import { WorkspaceContextScheduler, WorkspaceContextService } from '../src/services/workspaceContext/service';
import { createChatRouterEnv, destroyChatRouterEnv } from '../test/helpers/chatEnv';

/** Native Context services/scheduler with synthetic data; retains terminal auth. */
async function main() {
  assert.equal(process.env.CORTEX_CONTEXT_PROBE, '1', 'Set CORTEX_CONTEXT_PROBE=1 for real inference');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1');
  assert.equal(process.platform, 'darwin', 'This probe certifies macOS only');
  const connection = process.env.CORTEX_TEST_CONNECTION; assert.ok(connection, 'Select an authenticated named connection');
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-context-')); await fs.chmod(reportDir, 0o700);
  const results: Record<string, unknown> = { stage: 'setup' };
  const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  const env = await createChatRouterEnv({ configureDefaultCli: false });
  const workspace = path.join(env.tmpDir, 'workspace'); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), `# Isolated Context compatibility fixture\nOnly perform the supplied Context task using synthetic files under ${env.tmpDir}. Paths supplied by Cockpit are authorized. Update context markdown directly. Do not delete or write Memory inbox files; only Cockpit handles the final action block. No external connectors, SQL, native memory, subagents, scheduling, publishing or outreach.\n`);
  let now = new Date(); let workspaceId = ''; let interruptNext = false; let expired = false;
  let stopPending: Promise<boolean> | undefined;
  const calls: Array<{ usage: boolean; interrupted: boolean }> = [];
  const selections: Array<{ configId: string; value: string }> = [];
  const sessions = new CortexSessions(async (...args) => {
    const runtime = await startCortexRuntime(...args);
    const request = runtime.client.request.bind(runtime.client);
    runtime.client.request = async (method, params, timeout) => {
      if (method === 'session/set_config_option') {
        const values = cortexRecord(params);
        selections.push({ configId: String(values.configId), value: String(values.value) });
      }
      return request(method, params, timeout);
    };
    const prompt = runtime.prompt.bind(runtime);
    runtime.prompt = async (blocks, timeout) => {
      const call = { usage: false, interrupted: interruptNext }; interruptNext = false; calls.push(call);
      const timer = call.interrupted ? setTimeout(() => {
        stopPending = service.stopWorkspace(workspaceId); void stopPending.catch(() => {});
      }, 100) : undefined;
      try { const result = await prompt(blocks, timeout); call.usage = cortexHasCompleteUsage(cortexRecord(result).usage); return result; }
      finally { clearTimeout(timer); }
    };
    return runtime;
  });
  const adapter = new CortexCodeAdapter({ sessions, workingDir: workspace }); env.backendRegistry.register(adapter);
  const updates: MemoryUpdateEvent[] = [];
  const service = new WorkspaceContextService({ chatService: env.chatService, backendRegistry: env.backendRegistry,
    now: () => now, minVisibleNoSourceRunMs: 0, emitMemoryUpdate: (_id, frame) => { updates.push(frame); } });
  const active = new Set<Promise<unknown>>(); const processWorkspace = service.processWorkspace.bind(service);
  service.processWorkspace = (id, options) => {
    if (expired) return Promise.reject(new Error('Native Context probe completion deadline exceeded.'));
    const pending = processWorkspace(id, options); active.add(pending);
    void pending.finally(() => active.delete(pending)).catch(() => {}); return pending;
  };
  const deadline = setTimeout(() => { expired = true; void service.stopWorkspace(workspaceId).catch(() => {}); adapter.shutdown(); }, 10 * 60_000);
  const profile: CliProfile = { id: 'setup-cortex-code-account', name: 'Native Context fixture', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: '', updatedAt: '' };
  const override = { ...profile, id: 'cortex-context-override' };
  const selected: Array<{ override: boolean; model: string | undefined; effort: string | undefined }> = [];
  const run = adapter.runOneShot.bind(adapter);
  adapter.runOneShot = (prompt, options = {}) => {
    if (expired) return Promise.reject(new Error('Native Context probe completion deadline exceeded.'));
    selected.push({ override: options.cliProfile?.id === override.id, model: options.model, effort: options.effort });
    assert.equal(options.allowTools, true); return run(prompt, options);
  };
  async function waitForRun(source: string, timestamp: string) {
    const end = Date.now() + 180_000;
    while (!expired && Date.now() < end) {
      const state = await service.getState(workspaceId);
      if (!service.isRunning(workspaceId) && state.lastRun?.source === source && state.lastRun.startedAt === timestamp) {
        assert.equal(state.lastRun.status, 'completed', 'Scheduled Context run failed'); return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Scheduled Context run did not complete');
  }
  const content = async () => (await Promise.all((await service.listFiles(workspaceId)).map(file => service.readFile(workspaceId, file.path))))
    .map(file => file?.content || '').join('\n');
  const note = (hint: string, text: string) => env.chatService.addMemoryNoteEntry(workspaceId, {
    source: 'memory-note', filenameHint: hint, content: `---\nname: ${hint}\ndescription: Synthetic context fixture\ntype: project\n---\n\n${text}\n`,
  });
  try {
    results.cliVersion = await cortexVersion(resolveCortexRuntime({ profile, workspaceId: 'context-probe', cwd: workspace }));
    await env.chatService.saveSettings({ ...(await env.chatService.getSettings()), cliProfiles: [profile, override], defaultCliProfileId: profile.id,
      workspaceContext: { cliProfileId: profile.id, cliModel: 'claude-sonnet-4-6', cliEffort: 'low',
        scanIntervalMinutes: 5, cliConcurrency: 1, maintenanceIntervalHours: 1, maintenanceCliConcurrency: 1 } });
    const conversation = await env.chatService.createConversation('Context fixture', workspace, 'cortex-code', undefined, undefined, profile.id);
    workspaceId = conversation.workspaceId;
    results.stage = 'disabled-zero-source';
    const agents = await fs.readFile(path.join(workspace, 'AGENTS.md'), 'utf8');
    assert.equal((await service.processWorkspace(workspaceId)).skippedReason, 'disabled');
    assert.equal(await fs.readFile(path.join(workspace, 'AGENTS.md'), 'utf8'), agents);
    await assert.rejects(fs.stat(service.getWorkspaceContextDir(workspaceId)), { code: 'ENOENT' });
    await env.chatService.setWorkspaceContextEnabled(workspaceId, true);
    assert.equal((await service.processWorkspace(workspaceId)).filesConsidered, 0); assert.equal(calls.length, 0);
    results.disabledAndZeroSource = true;
    results.stage = 'native-scan';
    const uploaded = path.join(workspace, 'guidance.txt');
    await fs.writeFile(uploaded, '# Synthetic guidance\nUPLOAD_CONTEXT_4827 requires a SHA256 checksum manifest for every fixture build.\n');
    await env.chatService.addMessage(conversation.id, 'user', `ORCHID_CONTEXT_4827 is the permanent identifier of the synthetic Orchid release project. The fixture maintainer owns delivery.\n[Uploaded files: ${uploaded}]`, 'cortex-code');
    const scan = await service.processWorkspace(workspaceId, { source: 'manual_catchup', forceAll: true });
    assert.equal(scan.filesConsidered, 2); assert.match(await content(), /ORCHID_CONTEXT_4827/); assert.match(await content(), /UPLOAD_CONTEXT_4827/);
    assert.equal(selected[0].override, false); assert.equal(selected[0].model, 'claude-sonnet-4-6'); assert.equal(selected[0].effort, 'low');
    assert.match(await fs.readFile(path.join(workspace, 'AGENTS.md'), 'utf8'), /Agent Cockpit Workspace Context/);
    results.scanAndUploadedSource = true; process.stdout.write('Native Context scan/upload passed\n');
    results.stage = 'native-maintenance-memory';
    await env.chatService.setWorkspaceMemoryEnabled(workspaceId, true);
    const accepted = await note('release-lane', 'MEMORY_CONTEXT_4827 is the permanent magenta release-lane identifier for the Orchid fixture. Add this durable project rule to context.');
    const inactive = await note('superseded-lane', 'INACTIVE_CONTEXT_4827 was an obsolete lane.');
    await env.chatService.patchMemoryEntryMetadata(workspaceId, [{ filename: inactive, patch: { status: 'superseded' } }]);
    const reference = '# Exact release guidance\nREFERENCE_CONTEXT_4827: every fixture delivery includes its build ID and SHA256 checksum. Preserve this reference verbatim.\n';
    await service.writeReference(workspaceId, 'release-guidance.md', reference);
    const asset = Buffer.from('lane,color\nOrchid,magenta\n'); await service.writeAsset(workspaceId, 'palette.csv', asset);
    const root = service.getWorkspaceContextDir(workspaceId);
    const old = new Date(now.getTime() - 8 * 24 * 60 * 60_000).toISOString(); const oldName = old.replace(/[:.]/g, '-') + '-scheduled.md';
    await fs.writeFile(path.join(root, 'runs', oldName), '# Expired synthetic report\n');
    const before = await service.getState(workspaceId);
    await fs.writeFile(path.join(root, 'state.json'), JSON.stringify({ ...before, runs: [...before.runs, {
      runId: 'expired-fixture', source: 'scheduled', status: 'completed', startedAt: old, completedAt: old, filesConsidered: 0, summary: 'Old',
    }] }));
    await env.chatService.setWorkspaceContextSettings(workspaceId, { processorMode: 'override', cliProfileId: override.id,
      cliModel: 'claude-sonnet-4-6', cliEffort: 'medium' });
    now = new Date(now.getTime() + 60_000);
    const maintained = await service.processWorkspace(workspaceId, { source: 'maintenance' });
    assert.match(maintained.summary || '', /Consumed 1 Memory entry/); assert.match(await content(), /MEMORY_CONTEXT_4827/);
    assert.match(await content(), /REFERENCE_CONTEXT_4827/); assert.doesNotMatch(await content(), /INACTIVE_CONTEXT_4827/);
    const inbox = (await env.chatService.getWorkspaceMemory(workspaceId))!.files.map(file => file.filename);
    assert.ok(!inbox.includes(accepted) && inbox.includes(inactive));
    assert.equal(updates.length, 1); assert.deepEqual(updates[0].changedFiles, [accepted]); assert.equal(updates[0].displayInChat, false);
    assert.equal((await service.readReference(workspaceId, 'release-guidance.md'))?.content, reference);
    assert.deepEqual(await fs.readFile(path.join(service.getAssetsDir(workspaceId), 'palette.csv')), asset);
    assert.equal(selected[1].override, true); assert.equal(selected[1].effort, 'medium');
    assert.ok(selections.some(row => row.configId === 'thought_level' && row.value === 'medium'));
    await assert.rejects(fs.stat(path.join(root, 'runs', oldName)), { code: 'ENOENT' });
    assert.ok(!(await service.getState(workspaceId)).runs.some(row => row.runId === 'expired-fixture'));
    assert.match(await fs.readFile(path.join(root, 'runs/latest.md'), 'utf8'), /workspace-context-memory-actions/);
    results.maintenanceMemoryAndRetention = true; process.stdout.write('Native Context maintenance/Memory/retention passed\n');
    results.stage = 'native-schedules';
    const scheduler = new WorkspaceContextScheduler({ chatService: env.chatService, processor: service, now: () => now });
    const beforeTick = calls.length; await scheduler.tick(); assert.equal(calls.length, beforeTick);
    // A new source is newer than the initial scan; advance the scheduler clock, not wall time.
    await env.chatService.addMessage(conversation.id, 'user', 'SCHEDULE_CONTEXT_4827 permanently identifies the fixture verification milestone. Keep it in project context.', 'cortex-code');
    now = new Date(now.getTime() + 6 * 60_000); await scheduler.tick(); await waitForRun('scheduled', now.toISOString());
    assert.match(await content(), /SCHEDULE_CONTEXT_4827/); assert.equal(calls.length, beforeTick + 1);
    await env.chatService.setWorkspaceContextSettings(workspaceId, { processorMode: 'override', cliProfileId: override.id,
      cliModel: 'claude-sonnet-4-6', cliEffort: 'medium', scanIntervalMinutes: 1440 });
    now = new Date(now.getTime() + 65 * 60_000); await scheduler.tick(); await waitForRun('maintenance', now.toISOString());
    assert.equal(calls.length, beforeTick + 2); results.scheduledScanAndMaintenance = true;
    results.stage = 'native-stop';
    const retained = await note('interrupted-lane', 'RETAINED_CONTEXT_4827 identifies the pending blue lane for the fixture.');
    const beforeStop = calls.length; interruptNext = true;
    const stopped = await service.processWorkspace(workspaceId, { source: 'maintenance' });
    assert.equal(await stopPending, true); assert.equal(stopped.stopped, true); assert.equal(service.isRunning(workspaceId), false);
    assert.equal((await service.getState(workspaceId)).lastRun?.status, 'stopped'); assert.equal(calls.length, beforeStop + 1);
    assert.ok((await env.chatService.getWorkspaceMemory(workspaceId))!.files.some(file => file.filename === retained));
    results.stoppedWithoutRetryOrDeletion = true;
    const afterStop = calls.length; await env.chatService.setWorkspaceContextEnabled(workspaceId, false);
    now = new Date(now.getTime() + 2 * 24 * 60 * 60_000); await scheduler.tick();
    assert.equal((await service.processWorkspace(workspaceId)).skippedReason, 'disabled'); assert.equal(calls.length, afterStop);
    assert.equal(await adapter.runOneShot('Reply exactly CONTEXT_READY. Do not use tools.', { allowTools: true, cliProfile: profile,
      model: 'claude-sonnet-4-6', effort: 'low', timeoutMs: 120_000 }), 'CONTEXT_READY');
    results.freshAfterStop = true; results.nativeCalls = calls.length;
    results.completeUsage = calls.filter(call => !call.interrupted).every(call => call.usage); assert.equal(results.completeUsage, true);
    results.passed = true; delete results.stage;
  } catch (error) {
    results.failure = { kind: error instanceof assert.AssertionError ? 'assertion' : 'execution',
      line: error instanceof Error ? error.stack?.match(/probe-cortex-context\.ts:(\d+)/)?.[1] : undefined };
    throw error;
  } finally {
    clearTimeout(deadline); await service.stopWorkspace(workspaceId); adapter.shutdown(); await adapter.stopping;
    await Promise.allSettled(active); await destroyChatRouterEnv(env);
    await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Private Context evidence: ${reportDir}\n`);
  }
}
void main().catch(() => { process.stderr.write('Cortex Context probe failed; inspect the private stage report.\n'); process.exitCode = 1; });
