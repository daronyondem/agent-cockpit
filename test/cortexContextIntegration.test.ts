import fs from 'fs/promises';
import path from 'path';
import type { CliProfile, MemoryUpdateEvent } from '../src/types';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { WorkspaceContextScheduler, WorkspaceContextService } from '../src/services/workspaceContext/service';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';

const posix = process.platform === 'win32' ? describe.skip : describe;
posix('CoCo Workspace Context through the real process adapter', () => {
  let env: ChatRouterEnv;
  let adapter: CortexCodeAdapter;
  let service: WorkspaceContextService;
  let workspace: string;
  let workspaceId: string;
  let conversationId: string;
  let profile: CliProfile;
  let now: Date;
  let updates: MemoryUpdateEvent[];
  const frames = async (file = profile.env!.CORTEX_FIXTURE_TRACE) => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const prompts = async () => (await frames()).filter(frame => frame.method === 'session/prompt');
  async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 300; i++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Context fixture did not reach the expected state');
  }
  async function mode(value: string) {
    profile = { ...profile, env: { ...profile.env, CORTEX_FIXTURE_CONTEXT_MODE: value } };
    await env.chatService.saveSettings({ ...(await env.chatService.getSettings()), cliProfiles: [profile] });
  }
  async function note(hint: string) {
    return env.chatService.addMemoryNoteEntry(workspaceId, { source: 'memory-note', filenameHint: hint,
      content: `---\nname: ${hint}\ndescription: Synthetic context fixture\ntype: project\n---\n\n${hint} owns checksum verification.\n` });
  }
  beforeEach(async () => {
    env = await createChatRouterEnv({ configureDefaultCli: false });
    workspace = path.join(env.tmpDir, 'workspace'); await fs.mkdir(workspace);
    const command = path.join(env.tmpDir, 'cortex');
    await fs.copyFile(path.join(__dirname, 'fixtures/cortex/chat-acp.cjs'), command); await fs.chmod(command, 0o700);
    profile = { id: 'cortex-context', name: 'Context fixture', harness: 'cortex-code', authMode: 'account', command,
      cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '', env: {
        CORTEX_FIXTURE_STATE: path.join(env.tmpDir, 'native-state.json'), CORTEX_FIXTURE_TRACE: path.join(env.tmpDir, 'trace.jsonl'),
        CORTEX_FIXTURE_CONTEXT_MODE: 'write',
      } };
    adapter = new CortexCodeAdapter({ workingDir: workspace }); env.backendRegistry.register(adapter);
    await env.chatService.saveSettings({ ...(await env.chatService.getSettings()), cliProfiles: [profile], defaultCliProfileId: profile.id,
      workspaceContext: { cliProfileId: profile.id, cliModel: 'claude-sonnet-4-6', cliEffort: 'medium',
        scanIntervalMinutes: 5, cliConcurrency: 1, maintenanceIntervalHours: 1, maintenanceCliConcurrency: 1 } });
    const conversation = await env.chatService.createConversation('Context fixture', workspace, 'cortex-code', undefined, undefined, profile.id);
    workspaceId = conversation.workspaceId; conversationId = conversation.id; now = new Date(); updates = [];
    service = new WorkspaceContextService({ chatService: env.chatService, backendRegistry: env.backendRegistry,
      now: () => now, minVisibleNoSourceRunMs: 0, emitMemoryUpdate: (_id, event) => { updates.push(event); } });
  });
  afterEach(async () => {
    await service.stopWorkspace(workspaceId);
    await adapter.shutdown();
    await waitFor(async () => !service.isRunning(workspaceId));
    await destroyChatRouterEnv(env);
  });

  test('disabled processing is passive, and a zero-source enabled scan records cadence without spawning', async () => {
    expect((await service.processWorkspace(workspaceId)).skippedReason).toBe('disabled');
    await expect(fs.stat(service.getWorkspaceContextDir(workspaceId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(workspace, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await env.chatService.setWorkspaceContextEnabled(workspaceId, true);
    expect(await service.processWorkspace(workspaceId)).toMatchObject({ source: 'initial_scan', filesConsidered: 0 });
    expect((await service.getState(workspaceId)).lastRun).toMatchObject({ status: 'completed', filesConsidered: 0 });
    expect((await service.getState(workspaceId)).lastScanCompletedAt).toBe(now.toISOString());
    expect(await frames()).toEqual([]);
  });

  test('scans use global settings and explicit workspace profile/model/effort overrides, including uploaded sources', async () => {
    await env.chatService.setWorkspaceContextEnabled(workspaceId, true);
    const upload = path.join(workspace, 'uploaded.txt'); await fs.writeFile(upload, 'CONTEXT_UPLOAD');
    await env.chatService.addMessage(conversationId, 'user', `CONTEXT_SOURCE\n[Uploaded files: ${upload}]`, 'cortex-code');
    expect(await service.processWorkspace(workspaceId, { source: 'manual_catchup', forceAll: true })).toMatchObject({ filesConsidered: 2 });
    expect((await service.readFile(workspaceId, 'fixture-context.md'))?.content).toContain('CONTEXT_FIXTURE_UPDATED');
    expect((await prompts())[0].params.prompt[0].text).toContain(upload);
    expect(await frames()).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'session/new', params: expect.objectContaining({ cwd: workspace }) }),
      expect.objectContaining({ method: 'session/set_config_option', params: expect.objectContaining({ configId: 'model', value: 'claude-sonnet-4-6' }) }),
      expect.objectContaining({ method: 'session/set_config_option', params: expect.objectContaining({ configId: 'thought_level', value: 'medium' }) }),
    ]));
    const override = { ...profile, id: 'cortex-context-override', env: { ...profile.env, CORTEX_FIXTURE_TRACE: path.join(env.tmpDir, 'override.jsonl') } };
    await env.chatService.saveSettings({ ...(await env.chatService.getSettings()), cliProfiles: [profile, override] });
    await env.chatService.setWorkspaceContextSettings(workspaceId, { processorMode: 'override', cliProfileId: override.id, cliModel: 'auto', cliEffort: 'high' });
    await service.processWorkspace(workspaceId, { source: 'manual_catchup', forceAll: true });
    const overridden = await frames(override.env.CORTEX_FIXTURE_TRACE);
    expect(overridden.filter(frame => frame.method === 'session/prompt')).toHaveLength(1);
    expect(overridden.filter(frame => frame.method === 'session/set_config_option').map(frame => frame.params)).toEqual([
      expect.objectContaining({ configId: 'thought_level', value: 'high' }),
    ]);
    expect(await prompts()).toHaveLength(1);
    expect(await fs.readFile(path.join(service.getWorkspaceContextDir(workspaceId), 'runs/latest.md'), 'utf8')).toContain('- Source: manual_catchup');
  });

  test('maintenance folds only eligible active inbox files and emits a silent deletion update', async () => {
    await env.chatService.setWorkspaceContextEnabled(workspaceId, true); await env.chatService.setWorkspaceMemoryEnabled(workspaceId, true);
    const active = await note('active-owner'); const inactive = await note('old-owner');
    await env.chatService.patchMemoryEntryMetadata(workspaceId, [{ filename: inactive, patch: { status: 'superseded' } }]);
    await service.processWorkspace(workspaceId, { source: 'maintenance' });
    const prompt = (await prompts())[0].params.prompt[0].text;
    expect(prompt).toContain(active); expect(prompt).not.toContain(inactive);
    const files = (await env.chatService.getWorkspaceMemory(workspaceId))!.files.map(file => file.filename);
    expect(files).not.toContain(active); expect(files).toContain(inactive);
    expect(updates).toEqual([expect.objectContaining({ changedFiles: [active], displayInChat: false })]);
    expect((await service.getState(workspaceId)).lastRun?.summary).toContain('Consumed 1 Memory entry');
  });

  test.each(['missing-actions', 'duplicate-actions', 'unknown-actions'])('%s fails once and retains Memory despite direct context edits', async value => {
    await mode(value); await env.chatService.setWorkspaceContextEnabled(workspaceId, true); await env.chatService.setWorkspaceMemoryEnabled(workspaceId, true);
    const filename = await note('pending-owner');
    await expect(service.processWorkspace(workspaceId, { source: 'maintenance' })).rejects.toThrow(/memory action block/i);
    expect((await env.chatService.getWorkspaceMemory(workspaceId))!.files.map(file => file.filename)).toContain(filename);
    expect((await service.getState(workspaceId)).lastRun?.status).toBe('failed');
    expect((await service.readFile(workspaceId, 'fixture-context.md'))?.content).toContain('CONTEXT_FIXTURE_UPDATED');
    expect(await prompts()).toHaveLength(1); expect(updates).toEqual([]);
  });

  test('disabled Memory is excluded from maintenance sources and retained', async () => {
    await env.chatService.setWorkspaceContextEnabled(workspaceId, true);
    const filename = await note('disabled-memory');
    await env.chatService.setWorkspaceMemoryEnabled(workspaceId, false);
    await service.processWorkspace(workspaceId, { source: 'maintenance' });
    expect((await prompts())[0].params.prompt[0].text).not.toContain('## Memory Inbox Files');
    expect((await env.chatService.getWorkspaceMemory(workspaceId))!.files.map(file => file.filename)).toContain(filename);
  });

  test('a native human question fails headlessly without accepting or resending inbox work', async () => {
    await env.chatService.setWorkspaceContextEnabled(workspaceId, true); await env.chatService.setWorkspaceMemoryEnabled(workspaceId, true);
    const filename = await note('retained-owner');
    await service.writeReference(workspaceId, 'fixture-question.md', '# Needs human input');
    await expect(service.processWorkspace(workspaceId, { source: 'maintenance' })).rejects.toThrow(/human|question|background/i);
    expect((await service.getState(workspaceId)).lastRun?.status).toBe('failed');
    expect((await env.chatService.getWorkspaceMemory(workspaceId))!.files.map(file => file.filename)).toContain(filename);
    expect(await prompts()).toHaveLength(1);
  });

  test('stop drains an active native prompt, retains Memory, prevents overlap and allows a fresh run', async () => {
    await env.chatService.setWorkspaceContextEnabled(workspaceId, true); await env.chatService.setWorkspaceMemoryEnabled(workspaceId, true);
    const filename = await note('cancelled-owner');
    await service.writeReference(workspaceId, 'fixture-wait.md', '# Wait fixture');
    const pending = service.processWorkspace(workspaceId, { source: 'maintenance' });
    await waitFor(async () => (await prompts()).length === 1);
    expect((await service.processWorkspace(workspaceId)).skippedReason).toBe('already-running');
    expect(await service.stopWorkspace(workspaceId)).toBe(true);
    expect(await pending).toMatchObject({ stopped: true });
    expect(service.isRunning(workspaceId)).toBe(false);
    expect((await service.getState(workspaceId)).lastRun?.status).toBe('stopped');
    expect((await env.chatService.getWorkspaceMemory(workspaceId))!.files.map(file => file.filename)).toContain(filename);
    expect(await prompts()).toHaveLength(1);
    await service.deleteReference(workspaceId, 'fixture-wait.md');
    await service.processWorkspace(workspaceId, { source: 'maintenance' });
    expect((await service.getState(workspaceId)).lastRun?.status).toBe('completed');
    expect(await prompts()).toHaveLength(2);
  });

  test('scheduler respects scan and maintenance cadence, prunes old logs, and stops when disabled', async () => {
    await env.chatService.setWorkspaceContextEnabled(workspaceId, true);
    await service.processWorkspace(workspaceId); // zero sources: no native request
    const root = service.getWorkspaceContextDir(workspaceId); const state = await service.getState(workspaceId);
    await fs.writeFile(path.join(root, 'state.json'), JSON.stringify({ ...state, lastMaintenanceCompletedAt: now.toISOString() }));
    const scheduler = new WorkspaceContextScheduler({ chatService: env.chatService, processor: service, now: () => now });
    await scheduler.tick(); expect(await prompts()).toHaveLength(0);
    await env.chatService.addMessage(conversationId, 'user', 'CONTEXT_SCHEDULED', 'cortex-code');
    now = new Date(now.getTime() + 6 * 60_000); await scheduler.tick();
    await waitFor(async () => !service.isRunning(workspaceId) && (await service.getState(workspaceId)).lastRun?.source === 'scheduled');
    expect((await service.getState(workspaceId)).lastRun).toMatchObject({ source: 'scheduled', status: 'completed' });
    expect(await prompts()).toHaveLength(1);
    await env.chatService.setWorkspaceContextSettings(workspaceId, { scanIntervalMinutes: 1440 });
    const old = new Date(now.getTime() - 8 * 24 * 60 * 60_000).toISOString();
    const oldName = old.replace(/[:.]/g, '-') + '-scheduled.md'; await fs.writeFile(path.join(root, 'runs', oldName), '# Old run');
    const recent = await service.getState(workspaceId);
    await fs.writeFile(path.join(root, 'state.json'), JSON.stringify({ ...recent, runs: [...recent.runs, {
      runId: 'expired', source: 'scheduled', status: 'completed', startedAt: old, completedAt: old, filesConsidered: 0, summary: 'Old',
    }] }));
    now = new Date(now.getTime() + 65 * 60_000); await scheduler.tick();
    await waitFor(async () => !service.isRunning(workspaceId) && (await service.getState(workspaceId)).lastRun?.source === 'maintenance');
    expect((await service.getState(workspaceId)).lastRun).toMatchObject({ source: 'maintenance', status: 'completed' });
    expect((await service.getState(workspaceId)).runs.map(run => run.runId)).not.toContain('expired');
    await expect(fs.stat(path.join(root, 'runs', oldName))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await prompts()).toHaveLength(2);
    await env.chatService.setWorkspaceContextEnabled(workspaceId, false); now = new Date(now.getTime() + 2 * 24 * 60 * 60_000);
    await scheduler.tick(); expect((await service.processWorkspace(workspaceId)).skippedReason).toBe('disabled');
    expect(await prompts()).toHaveLength(2);
  });
});
