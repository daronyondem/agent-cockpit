import fs from 'fs/promises';
import path from 'path';
import type { CliProfile, Settings } from '../src/types';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { MockBackendAdapter } from './helpers/mockBackendAdapter';
import { WorkspaceContextService } from '../src/services/workspaceContext/service';
import { RoutinesService } from '../src/services/routines/service';
import { KbIngestionService } from '../src/services/knowledgeBase/ingestion';
import { KbDigestionService } from '../src/services/knowledgeBase/digest';
import { WorkspaceTaskQueueRegistry } from '../src/services/knowledgeBase/workspaceTaskQueue';
import { createCanvas } from '@napi-rs/canvas';

class PolicyAdapter extends MockBackendAdapter {
  tools = false;
  sequential = false;
  get metadata() {
    const metadata = super.metadata;
    return { ...metadata, id: 'cortex-code', label: 'CoCo policy fixture', capabilities: { ...metadata.capabilities,
      oneShot: { restrictedText: false, toolEnabled: this.tools, sequential: this.sequential } } };
  }
}
describe('processor selections across persistence and execution boundaries', () => {
  let env: ChatRouterEnv;
  let workspace: string;
  let workspaceId: string;
  let adapter: PolicyAdapter;
  let profile: CliProfile;
  beforeEach(async () => {
    env = await createChatRouterEnv(); workspace = path.join(env.tmpDir, 'workspace'); await fs.mkdir(workspace);
    profile = { id: 'cortex-selected', name: 'Saved CoCo', harness: 'cortex-code', authMode: 'account', cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '' };
    const settings = await env.chatService.getSettings(); await env.chatService.saveSettings({ ...settings, cliProfiles: [...settings.cliProfiles!, profile] });
    workspaceId = (await env.chatService.createConversation('Processor fixture', workspace)).workspaceId;
    adapter = new PolicyAdapter(); env.backendRegistry.register(adapter);
  });
  afterEach(async () => { await env.chatService.closeKbVectorStores(); env.chatService.closeKbDatabases(); await destroyChatRouterEnv(env); });
  function selections(id: string): Pick<Settings, 'memory' | 'knowledgeBase' | 'workspaceContext'> {
    return { memory: { cliProfileId: id, cliBackend: 'claude-code' }, knowledgeBase: {
      ingestionCliProfileId: id, ingestionCliBackend: 'claude-code', digestionCliProfileId: id, digestionCliBackend: 'claude-code',
      dreamingCliProfileId: id, dreamingCliBackend: 'claude-code',
    }, workspaceContext: { cliProfileId: id, cliBackend: 'claude-code' } };
  }

  test.each(['missing', 'disabled', 'unconfigured'] as const)('%s global and workspace saved selections survive save/read and fail without a default fallback', async state => {
    const id = state === 'missing' ? 'deleted-profile' : profile.id;
    const settings = await env.chatService.getSettings();
    const changed = { ...profile, disabled: state === 'disabled', cortexCode: state === 'unconfigured' ? undefined : profile.cortexCode };
    await env.chatService.saveSettings({ ...settings, cliProfiles: settings.cliProfiles!.map(item => item.id === profile.id ? changed : item), ...selections(id) });
    const loaded = await env.chatService.getSettings();
    expect(loaded.memory?.cliProfileId).toBe(id); expect(loaded.knowledgeBase).toMatchObject({ ingestionCliProfileId: id, digestionCliProfileId: id, dreamingCliProfileId: id });
    expect(loaded.workspaceContext?.cliProfileId).toBe(id);
    await env.chatService.setWorkspaceContextSettings(workspaceId, { processorMode: 'override', cliProfileId: id, cliBackend: 'claude-code' });
    expect((await env.chatService.getWorkspaceContextSettings(workspaceId))?.cliProfileId).toBe(id);
    await expect(env.chatService.resolveCliProfileRuntime(id, 'claude-code')).rejects.toThrow(state === 'missing' ? /not found/ : state === 'disabled' ? /disabled/ : /connection/);
    await env.chatService.setWorkspaceContextEnabled(workspaceId, true);
    const service = new WorkspaceContextService({ chatService: env.chatService, backendRegistry: env.backendRegistry });
    await expect(service.processWorkspace(workspaceId, { source: 'maintenance' })).rejects.toThrow();
    expect((await service.getState(workspaceId)).lastRun?.status).toBe('failed'); expect(service.isRunning(workspaceId)).toBe(false);
    expect(adapter._oneShotCalls).toHaveLength(0); expect(env.mockBackend._oneShotCalls).toHaveLength(0);
  });

  test('restored settings bytes retain unsupported Memory selection instead of repairing it to the default', async () => {
    const settings = await env.chatService.getSettings();
    await fs.writeFile(path.join(env.tmpDir, 'data/chat/settings.json'), JSON.stringify({ ...settings, ...selections(profile.id) }));
    expect((await env.chatService.getSettings()).memory?.cliProfileId).toBe(profile.id);
    expect((await env.chatService.resolveCliProfileRuntime(profile.id)).backendId).toBe('cortex-code');
    expect(env.mockBackend._oneShotCalls).toHaveLength(0);
  });

  test('tool eligibility blocks ingestion before metadata discovery and records image-only recovery without choosing another harness', async () => {
    await env.chatService.setWorkspaceKbEnabled(workspaceId, true);
    await env.chatService.saveSettings({ ...(await env.chatService.getSettings()), knowledgeBase: { ingestionCliProfileId: profile.id, ingestionCliModel: 'sonnet' } });
    const metadata = jest.spyOn(adapter, 'getMetadata');
    const service = new KbIngestionService({ chatService: env.chatService, backendRegistry: env.backendRegistry, queueRegistry: new WorkspaceTaskQueueRegistry() });
    const uploaded = await service.enqueueUpload(workspaceId, { filename: 'fixture.png', mimeType: 'image/png', buffer: createCanvas(20, 20).toBuffer('image/png') });
    await service.waitForIdle(workspaceId);
    const meta = JSON.parse(await fs.readFile(path.join(env.chatService.getKbConvertedDir(workspaceId), uploaded.entry.rawId, 'meta.json'), 'utf8'));
    expect(meta.metadata.source).toBe('image-only'); expect(metadata).not.toHaveBeenCalled(); expect(adapter._oneShotCalls).toHaveLength(0);
  });

  test('attachment OCR rejects an unsupported tool role before profile discovery', async () => {
    const conversation = await env.chatService.createConversation('OCR policy', workspace, 'cortex-code', 'sonnet', undefined, profile.id);
    const dir = path.join(env.chatService.artifactsDir, conversation.id); await fs.mkdir(dir, { recursive: true });
    const image = path.join(dir, 'fixture.png'); await fs.writeFile(image, createCanvas(20, 20).toBuffer('image/png'));
    const discovery = jest.spyOn(adapter, 'getMetadata');
    const response = await env.request('POST', `/api/chat/conversations/${conversation.id}/attachments/ocr`, { path: image });
    expect(response.status).toBe(400); expect(response.body.error).toMatch(/tool-enabled/);
    expect(discovery).not.toHaveBeenCalled(); expect(adapter._oneShotCalls).toHaveLength(0);
  });

  test.each([false, true])('digestion enforces tool/sequential eligibility (gleaning=%s) without an adapter invocation', async gleaning => {
    adapter.tools = gleaning;
    await env.chatService.setWorkspaceKbEnabled(workspaceId, true);
    await env.chatService.saveSettings({ ...(await env.chatService.getSettings()), knowledgeBase: { digestionCliProfileId: profile.id, kbGleaningEnabled: gleaning } });
    const queueRegistry = new WorkspaceTaskQueueRegistry();
    const ingestion = new KbIngestionService({ chatService: env.chatService, queueRegistry });
    const raw = await ingestion.enqueueUpload(workspaceId, { filename: 'fixture.md', mimeType: 'text/markdown', buffer: Buffer.from('# Policy fixture\nA durable test rule.') });
    await ingestion.waitForIdle(workspaceId);
    const service = new KbDigestionService({ chatService: env.chatService, backendRegistry: env.backendRegistry, queueRegistry });
    expect((await service.enqueueDigest(workspaceId, raw.entry.rawId)).error?.message).toMatch(gleaning ? /sequential/ : /tool-enabled/);
    expect(adapter._oneShotCalls).toHaveLength(0); expect(env.mockBackend._oneShotCalls).toHaveLength(0);
  });

  test('Routine manifests and Workspace Context overrides enforce tool roles before running', async () => {
    await env.chatService.setWorkspaceContextEnabled(workspaceId, true);
    await env.chatService.setWorkspaceContextSettings(workspaceId, { processorMode: 'override', cliProfileId: profile.id });
    const context = new WorkspaceContextService({ chatService: env.chatService, backendRegistry: env.backendRegistry });
    await expect(context.processWorkspace(workspaceId, { source: 'maintenance' })).rejects.toThrow(/tool-enabled/);
    await env.chatService.setWorkspaceRoutinesEnabled(workspaceId, true);
    const routines = new RoutinesService({ chatService: env.chatService, backendRegistry: env.backendRegistry }); await routines.ensureWorkspace(workspaceId);
    const directory = routines.getRoutineDir(workspaceId, 'role-fixture'); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'agent-cockpit.routine', id: 'role-fixture', title: 'Role fixture',
      state: 'enabled', routineFile: 'routine.md', trigger: { type: 'manual' }, harness: { cliProfileId: profile.id } }));
    await fs.writeFile(path.join(directory, 'routine.md'), '# Role fixture');
    await expect(routines.runRoutine(workspaceId, 'role-fixture', { source: 'manual' })).rejects.toThrow(/tool-enabled/);
    expect((await routines.getRoutine(workspaceId, 'role-fixture'))?.lastRun?.status).toBe('failed'); expect(adapter._oneShotCalls).toHaveLength(0);
  });
});
