import fs from 'fs/promises';
import path from 'path';
import type { CliProfile } from '../src/types';
import type { RoutineManifest, RoutineRunRecord } from '../src/contracts/routines';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { RoutinesScheduler, RoutinesService } from '../src/services/routines/service';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';

const posix = process.platform === 'win32' ? describe.skip : describe;
posix('CoCo Routines through the real process adapter', () => {
  let env: ChatRouterEnv;
  let adapter: CortexCodeAdapter;
  let service: RoutinesService;
  let workspace: string;
  let workspaceId: string;
  let conversationId: string;
  let profile: CliProfile;
  let now: Date;
  let notify: jest.Mock;
  let pending: Set<Promise<RoutineRunRecord | null>>;
  const frames = async () => (await fs.readFile(profile.env!.CORTEX_FIXTURE_TRACE, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const prompts = async () => (await frames()).filter(frame => frame.method === 'session/prompt');
  async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 300; i++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Routine fixture did not reach the expected state');
  }
  async function enable() {
    expect((await env.request('PUT', `/api/chat/workspaces/${workspaceId}/routines/enabled`, { enabled: true })).status).toBe(200);
  }
  async function waitForPartialOutput() {
    await waitFor(async () => {
      const run = (await service.getRoutine(workspaceId, 'fixture-radar'))?.lastRun;
      return !!run && !!(await fs.stat(path.join(run.outputDir, 'report.txt')).catch(() => null));
    });
  }
  async function routine(patch: Partial<RoutineManifest> = {}, content = '# Fixture routine\nWrite the fixture output.\n') {
    const manifest: RoutineManifest = { schemaVersion: 1, kind: 'agent-cockpit.routine', id: 'fixture-radar', title: 'Fixture Radar',
      routineFile: 'routine.md', state: 'enabled', trigger: { type: 'manual' },
      harness: { cliProfileId: profile.id, model: 'claude-sonnet-4-6', effort: 'medium' }, timeoutMinutes: 1,
      notification: { mode: 'workspaceDefault' }, ...patch };
    const directory = service.getRoutineDir(workspaceId, manifest.id); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(directory, 'routine.md'), content); return manifest;
  }
  beforeEach(async () => {
    env = await createChatRouterEnv({ configureDefaultCli: false });
    workspace = path.join(env.tmpDir, 'workspace'); await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), '# Preserve workspace instructions\n');
    const command = path.join(env.tmpDir, 'cortex');
    await fs.copyFile(path.join(__dirname, 'fixtures/cortex/chat-acp.cjs'), command); await fs.chmod(command, 0o700);
    profile = { id: 'cortex-routines', name: 'Routine fixture', harness: 'cortex-code', authMode: 'account', command,
      cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '', env: {
        CORTEX_FIXTURE_STATE: path.join(env.tmpDir, 'native-state.json'), CORTEX_FIXTURE_TRACE: path.join(env.tmpDir, 'trace.jsonl'),
        CORTEX_FIXTURE_PROFILE_ID: 'cortex-routines',
      } };
    adapter = new CortexCodeAdapter({ workingDir: workspace }); env.backendRegistry.register(adapter);
    await env.chatService.saveSettings({ ...(await env.chatService.getSettings()), cliProfiles: [profile], defaultCliProfileId: profile.id });
    const conversation = await env.chatService.createConversation('Routine fixture', workspace, 'cortex-code', 'claude-sonnet-4-6', 'low', profile.id);
    workspaceId = conversation.workspaceId; conversationId = conversation.id; now = new Date('2026-11-09T12:00:00.000Z'); notify = jest.fn().mockResolvedValue(undefined);
    service = new RoutinesService({ chatService: env.chatService, backendRegistry: env.backendRegistry, now: () => now, notifier: { sendTelegram: notify } });
    pending = new Set(); const run = service.runRoutine.bind(service);
    service.runRoutine = (...args) => { const job = run(...args); pending.add(job); void job.finally(() => pending.delete(job)).catch(() => {}); return job; };
    profile.env!.CORTEX_FIXTURE_ROUTINE_ITEMS = service.getItemsDir(workspaceId);
    await env.chatService.saveSettings({ ...(await env.chatService.getSettings()), cliProfiles: [profile] });
  });
  afterEach(async () => {
    await adapter.shutdown(); await Promise.allSettled(pending); await destroyChatRouterEnv(env);
  });

  test('disabled routes remove stale managed instructions without scaffolding or native work', async () => {
    await fs.appendFile(path.join(workspace, 'AGENTS.md'), '\n<!-- AGENT_COCKPIT_ROUTINES_START -->\nstale\n<!-- AGENT_COCKPIT_ROUTINES_END -->\n');
    const listed = await env.request('GET', `/api/chat/workspaces/${workspaceId}/routines`);
    expect(listed.body).toMatchObject({ enabled: false, routines: [] });
    expect(await fs.readFile(path.join(workspace, 'AGENTS.md'), 'utf8')).toBe('# Preserve workspace instructions\n');
    await expect(fs.stat(service.getRoutinesDir(workspaceId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await service.runRoutine(workspaceId, 'missing', { source: 'manual' })).toBeNull();
    expect(await new RoutinesScheduler({ service }).tick()).toBe(0); expect(await frames()).toEqual([]);
  });

  test('chat authoring yields a validated proposal that requires installation and revalidates its current state', async () => {
    await enable(); const ws = await env.connectWs(conversationId); const reading = env.readWsEvents(ws);
    try {
      expect((await env.request('POST', `/api/chat/conversations/${conversationId}/message`, { content: 'fixture-propose-routine' })).status).toBe(200);
      expect((await reading).some(frame => frame.type === 'done')).toBe(true);
    } finally { ws.close(); }
    const saved = await env.chatService.getConversation(conversationId);
    const answer = saved!.messages.filter(message => message.role === 'assistant').map(message => message.content).join('\n');
    const validated = await env.request('POST', `/api/chat/workspaces/${workspaceId}/routines/proposals/validate`, { content: answer });
    expect(validated.body.proposals).toHaveLength(1); expect(validated.body.proposals[0].manifest.state).toBe('proposed');
    expect((await env.request('POST', `/api/chat/workspaces/${workspaceId}/routines/fixture-radar/run`, {})).status).toBe(409);
    expect((await env.request('POST', `/api/chat/workspaces/${workspaceId}/routines/fixture-radar/install`, { state: 'disabled' })).status).toBe(200);
    expect((await service.validateProposalMarkers(workspaceId, answer))[0].manifest.state).toBe('disabled');
    expect(await service.validateProposalMarker(workspaceId, path.join(workspace, 'manifest.json'))).toBeNull();
    expect((await fs.readFile(path.join(workspace, 'AGENTS.md'), 'utf8'))).toContain(service.getAuthoringPath(workspaceId));
    expect(await prompts()).toHaveLength(1);
  });

  test('manual runs honor manifest configuration, persist files/history/state and pass notify.md only to the stub', async () => {
    await enable(); await routine({ state: 'disabled' }); // explicitly runnable once, never scheduled
    await service.updateWorkspaceSettings(workspaceId, { telegram: { enabled: true, botToken: 'fixture-token', chatId: 'fixture-destination' } });
    const oneShot = jest.spyOn(adapter, 'runOneShot');
    const run = (await service.runRoutine(workspaceId, 'fixture-radar', { source: 'manual' }))!;
    expect(run.status).toBe('completed'); expect(await fs.readFile(run.finalPath!, 'utf8')).toBe('ROUTINE_FIXTURE_DONE\n');
    expect(await fs.readFile(path.join(run.outputDir, 'report.txt'), 'utf8')).toBe('ROUTINE_FIXTURE_OUTPUT');
    expect(await fs.readFile(path.join(run.tmpDir, 'scratch.txt'), 'utf8')).toBe('SCRATCH');
    expect(oneShot.mock.calls[0][1]).toMatchObject({ allowTools: true, workingDir: workspace, timeoutMs: 60_000,
      model: 'claude-sonnet-4-6', effort: 'medium', cliProfile: { id: profile.id } });
    expect((await frames()).filter(frame => frame.method === 'session/set_config_option').map(frame => frame.params)).toEqual(expect.arrayContaining([
      expect.objectContaining({ configId: 'model', value: 'claude-sonnet-4-6' }), expect.objectContaining({ configId: 'thought_level', value: 'medium' }),
    ]));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ telegram: expect.objectContaining({ chatId: 'fixture-destination' }) }), 'ROUTINE_FIXTURE_NOTIFY');
    expect((await service.getRoutine(workspaceId, 'fixture-radar'))?.runs[0].runId).toBe(run.runId);
    const tree = await env.request('GET', `/api/chat/workspaces/${workspaceId}/explorer/tree?scope=routine-output&routineId=fixture-radar&runId=${encodeURIComponent(run.runId)}`);
    expect(tree.body.entries.map((entry: { name: string }) => entry.name)).toContain('report.txt');
    expect(await fs.readFile(path.join(service.getRoutinePersistentStateDir(workspaceId, 'fixture-radar'), 'cursor.json'), 'utf8')).toBe('{"count":1}');
    await expect(fs.stat(path.join(workspace, '.agent-cockpit'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('scheduler honors enabled state, interval/window and workspace opt-in', async () => {
    await enable(); const trigger = { type: 'schedule' as const, intervalMinutes: 15, timezone: 'UTC', weekdaysOnly: true, windowStart: '08:00', windowEnd: '18:00' };
    await routine({ trigger }); await routine({ id: 'draft', state: 'proposed', trigger }); await routine({ id: 'disabled', state: 'disabled', trigger });
    const scheduler = new RoutinesScheduler({ service }); expect(await scheduler.tick()).toBe(1);
    await waitFor(async () => (await service.getRoutine(workspaceId, 'fixture-radar'))?.lastRun?.status === 'completed');
    expect((await service.getRoutine(workspaceId, 'fixture-radar'))?.lastRun?.source).toBe('scheduled');
    expect(await scheduler.tick()).toBe(0);
    now = new Date(now.getTime() + 16 * 60_000); expect(await scheduler.tick()).toBe(1);
    await waitFor(async () => !service.isRunning(workspaceId, 'fixture-radar') && (await prompts()).length === 2);
    expect(JSON.parse(await fs.readFile(path.join(service.getRoutinePersistentStateDir(workspaceId, 'fixture-radar'), 'cursor.json'), 'utf8')).count).toBe(2);
    now = new Date('2026-11-09T20:00:00.000Z'); expect(await scheduler.tick()).toBe(0);
    now = new Date('2026-11-14T12:00:00.000Z'); expect(await scheduler.tick()).toBe(0);
    expect((await service.getRoutine(workspaceId, 'draft'))?.lastRun).toBeUndefined();
    await env.request('PUT', `/api/chat/workspaces/${workspaceId}/routines/enabled`, { enabled: false });
    expect(await scheduler.tick()).toBe(0); expect(await service.listRoutines(workspaceId)).toEqual([]);
    expect(await fs.readFile(path.join(workspace, 'AGENTS.md'), 'utf8')).toBe('# Preserve workspace instructions\n');
    expect((await fs.stat(service.getRoutineDir(workspaceId, 'fixture-radar'))).isDirectory()).toBe(true); expect(await prompts()).toHaveLength(2);
  });

  test('notification off and delivery failures do not rerun completed tool work', async () => {
    await enable(); await routine({ notification: { mode: 'off' } });
    await service.updateWorkspaceSettings(workspaceId, { telegram: { enabled: true, botToken: 'fixture-token', chatId: 'fixture-destination' } });
    await service.runRoutine(workspaceId, 'fixture-radar', { source: 'manual' }); expect(notify).not.toHaveBeenCalled();
    await service.updateRoutine(workspaceId, 'fixture-radar', { manifest: { notification: { mode: 'workspaceDefault' } } });
    notify.mockRejectedValue(new Error('Fixture delivery unavailable'));
    const run = await service.runRoutine(workspaceId, 'fixture-radar', { source: 'manual' });
    expect(run).toMatchObject({ status: 'completed', notificationError: 'Fixture delivery unavailable' }); expect(notify).toHaveBeenCalledTimes(1);
    expect(await prompts()).toHaveLength(2);
  });

  test('shutdown rejects overlapping work, retains partial files without notification, and allows an explicit fresh run', async () => {
    await enable(); await routine({}, '# Hold\nfixture-routine-hold');
    await service.updateWorkspaceSettings(workspaceId, { telegram: { enabled: true, botToken: 'fixture-token', chatId: 'fixture-destination' } });
    const job = service.runRoutine(workspaceId, 'fixture-radar', { source: 'manual' });
    await waitForPartialOutput(); expect(await prompts()).toHaveLength(1);
    await expect(service.runRoutine(workspaceId, 'fixture-radar', { source: 'manual' })).rejects.toThrow('already running');
    await expect(service.deleteRoutine(workspaceId, 'fixture-radar')).rejects.toThrow('running');
    const stopped = adapter.shutdown(); await expect(job).rejects.toThrow(/shutdown/); await stopped;
    const failed = (await service.getRoutine(workspaceId, 'fixture-radar'))!.lastRun!;
    expect(failed.status).toBe('failed'); expect(failed.finalPath).toBeUndefined(); expect(notify).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(failed.outputDir, 'report.txt'), 'utf8')).toBe('ROUTINE_FIXTURE_OUTPUT'); expect(await prompts()).toHaveLength(1);
    await service.updateRoutine(workspaceId, 'fixture-radar', { routineContent: '# Fresh fixture run' });
    expect((await service.runRoutine(workspaceId, 'fixture-radar', { source: 'manual' }))?.status).toBe('completed'); expect(await prompts()).toHaveLength(2);
  });

  test('the manifest deadline fails once, drains the process and preserves partial state without outreach', async () => {
    await enable(); await routine({}, '# Deadline\nfixture-routine-hold');
    await service.updateWorkspaceSettings(workspaceId, { telegram: { enabled: true, botToken: 'fixture-token', chatId: 'fixture-destination' } });
    const original = setTimeout; const deadline: { fire?: () => void } = {};
    const timer = jest.spyOn(global, 'setTimeout').mockImplementation(((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === 60_000) deadline.fire = () => handler(...args);
      return original(handler, ms, ...args);
    }) as typeof setTimeout);
    try {
      const job = service.runRoutine(workspaceId, 'fixture-radar', { source: 'manual' });
      await waitForPartialOutput(); expect(await prompts()).toHaveLength(1); expect(deadline.fire).toBeDefined(); deadline.fire!();
      await expect(job).rejects.toThrow(/timed out/);
      expect(service.isRunning(workspaceId, 'fixture-radar')).toBe(false);
      expect((await service.getRoutine(workspaceId, 'fixture-radar'))?.lastRun).toMatchObject({ status: 'failed', errorMessage: expect.stringMatching(/timed out/) });
      expect(await prompts()).toHaveLength(1); expect(notify).not.toHaveBeenCalled();
    } finally { timer.mockRestore(); }
  });

  test('headless questions and unavailable models fail once without choosing another model or notifying', async () => {
    await enable(); await routine({}, '# Human decision\nfixture-question');
    await expect(service.runRoutine(workspaceId, 'fixture-radar', { source: 'manual' })).rejects.toThrow(/human decision/);
    await service.updateRoutine(workspaceId, 'fixture-radar', { manifest: { harness: { cliProfileId: profile.id, model: 'missing-model' } }, routineContent: '# Ordinary run' });
    await expect(service.runRoutine(workspaceId, 'fixture-radar', { source: 'manual' })).rejects.toThrow(/selection is unavailable/);
    expect((await service.getRoutine(workspaceId, 'fixture-radar'))?.lastRun?.status).toBe('failed'); expect(await prompts()).toHaveLength(1); expect(notify).not.toHaveBeenCalled();
  });

  test('output retention prunes old run folders while keeping cross-run state and bounded history', async () => {
    now = new Date(); // Retention compares filesystem mtimes to the service clock.
    await enable(); await routine({ outputRetentionDays: 1 });
    const directory = service.getRoutineDir(workspaceId, 'fixture-radar'); const expired = path.join(directory, 'runs', 'expired');
    await fs.mkdir(expired, { recursive: true }); await fs.writeFile(path.join(expired, 'artifact.txt'), 'OLD');
    const old = new Date(now.getTime() - 2 * 24 * 60 * 60_000); await fs.utimes(expired, old, old);
    await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({ version: 1, runs: Array.from({ length: 50 }, (_, i) => ({
      runId: `old-${i}`, routineId: 'fixture-radar', source: 'manual', status: 'completed', startedAt: old.toISOString(), inputPath: '', outputDir: '', tmpDir: '',
    })) }));
    const run = (await service.runRoutine(workspaceId, 'fixture-radar', { source: 'manual' }))!;
    await expect(fs.stat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(run.outputDir)).isDirectory()).toBe(true); expect((await service.getRoutine(workspaceId, 'fixture-radar'))?.runs).toHaveLength(50);
    expect((await fs.stat(path.join(service.getRoutinePersistentStateDir(workspaceId, 'fixture-radar'), 'cursor.json'))).isFile()).toBe(true);
  });
});
