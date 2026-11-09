import fs from 'fs/promises';
import path from 'path';
import { GrokBuildAdapter } from '../src/services/backends/grok';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { KbIngestionService } from '../src/services/knowledgeBase/ingestion';
import { KbDigestionService } from '../src/services/knowledgeBase/digest';
import { WorkspaceTaskQueueRegistry } from '../src/services/knowledgeBase/workspaceTaskQueue';
import { RoutinesService } from '../src/services/routines/service';

const native = process.env.GROK_BUILD_E2E === '1' ? describe : describe.skip;
native('Grok Build application workflow compatibility', () => {
  let env: ChatRouterEnv;
  let workspace: string;
  let workspaceId: string;
  let previousPort: string | undefined;
  const profileId = 'grok-workflows';
  beforeEach(async () => {
    env = await createChatRouterEnv({ configureDefaultCli: false });
    previousPort = process.env.PORT;
    process.env.PORT = String((env.server.address() as { port: number }).port);
    workspace = path.join(env.tmpDir, 'workspace');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), `# Compatibility fixture\nOnly perform the requested fixture work. Paths under ${env.tmpDir} supplied by Cockpit processor prompts are authorized temporary test data. No publishing, external connectors, native memory, or scheduled work.\n`);
    const adapter = new GrokBuildAdapter({ workingDir: workspace });
    env.backendRegistry.register(adapter);
    await adapter.getMetadata();
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, defaultBackend: 'grok-build', defaultCliProfileId: profileId,
      cliProfiles: [{ id: profileId, name: 'Grok workflows', harness: 'grok-build', authMode: 'server-configured', command: 'grok', createdAt: '', updatedAt: '' }],
      memory: { cliProfileId: profileId, cliModel: 'grok-4.7', cliEffort: 'low' },
      knowledgeBase: { digestionCliProfileId: profileId, digestionCliModel: 'grok-4.7', digestionCliEffort: 'low', cliConcurrency: 1 },
      workspaceContext: { cliProfileId: profileId, cliModel: 'grok-4.7', cliEffort: 'low', scanIntervalMinutes: 1440, cliConcurrency: 1 },
    });
    workspaceId = (await env.chatService.createConversation('Fixture seed', workspace, 'grok-build', 'grok-4.7', 'low', profileId)).workspaceId;
  });
  afterEach(async () => {
    await env.backendRegistry.shutdownAll();
    await destroyChatRouterEnv(env);
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  });

  test('digests a KB document and uses real token-scoped KB and Memory MCP tools in chat', async () => {
    await env.chatService.setWorkspaceKbEnabled(workspaceId, true);
    await env.chatService.setWorkspaceMemoryEnabled(workspaceId, true);
    const queueRegistry = new WorkspaceTaskQueueRegistry();
    const ingestion = new KbIngestionService({ chatService: env.chatService, backendRegistry: env.backendRegistry, queueRegistry });
    const uploaded = await ingestion.enqueueUpload(workspaceId, { filename: 'fixture.md', mimeType: 'text/markdown',
      buffer: Buffer.from('# Indigo fixture project\nThe INDIGO_KB_314 release policy requires every fixture release to include a checksum file. The fixture maintainer owns checksum verification. This policy applies to all Indigo fixture builds.\n') });
    await ingestion.waitForIdle(workspaceId);
    const digest = await new KbDigestionService({ chatService: env.chatService, backendRegistry: env.backendRegistry, queueRegistry }).enqueueDigest(workspaceId, uploaded.entry.rawId);
    expect(digest.error).toBeUndefined();
    expect(digest.entryIds.length).toBeGreaterThan(0);
    const conv = await env.chatService.createConversation('MCP fixture', workspace, 'grok-build', 'grok-4.7', 'low', profileId);
    const ws = await env.connectWs(conv.id);
    const reading = env.readWsEvents(ws, 180_000);
    try {
      const sent = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content:
        'Use the Agent Cockpit memory_note MCP tool to save this durable project rule: The synthetic fixture project uses MAUVE_MEMORY_314 as its permanent accent-color identifier. Then call memory_search for MAUVE_MEMORY_314 and the Agent Cockpit KB search_entries MCP tool for INDIGO_KB_314. Confirm the checksum policy from KB and the accent identifier from Memory in your final response. Do no other work. If a tool fails, report it and do not write fallback memory files.' });
      expect(sent.status).toBe(200);
      const events = await reading;
      expect(events.some(event => event.type === 'tool_activity' && /memory_note/.test(event.tool))).toBe(true);
      expect(events.some(event => event.type === 'tool_activity' && /memory_search/.test(event.tool))).toBe(true);
      expect(events.some(event => event.type === 'tool_activity' && /search_entries/.test(event.tool))).toBe(true);
      const saved = await env.chatService.getConversation(conv.id);
      const text = saved!.messages.filter(message => message.role === 'assistant').map(message => message.content).join('\n');
      expect(text).toContain('MAUVE_MEMORY_314');
      expect(text).toMatch(/checksum/i);
      expect((await env.chatService.searchWorkspaceMemory(workspaceId, { query: 'MAUVE_MEMORY_314' })).length).toBeGreaterThan(0);
    } finally { ws.close(); }
  }, 240_000);

  test('the Workspace Context processor updates actual markdown from a fixture source', async () => {
    await env.chatService.setWorkspaceContextEnabled(workspaceId, true);
    const service = env.workspaceContextService;
    await service.ensureWorkspace(workspaceId);
    await fs.writeFile(path.join(service.getReferenceFilesDir(workspaceId), 'fixture.md'), '# Indigo fixture\nThe durable project identifier is CONTEXT_FIXTURE_314. Indigo fixture builds must include a checksum manifest.\n');
    const result = await service.processWorkspace(workspaceId, { source: 'maintenance', forceAll: true });
    expect(result.skippedReason).toBeUndefined();
    expect(result.filesConsidered).toBeGreaterThan(0);
    const directory = service.getContextFilesDir(workspaceId);
    const contents = await Promise.all((await fs.readdir(directory)).filter(name => name.endsWith('.md')).map(name => fs.readFile(path.join(directory, name), 'utf8')));
    expect(contents.join('\n')).toContain('CONTEXT_FIXTURE_314');
  }, 180_000);

  test('an explicitly enabled manual Routine runs through Grok and records its output', async () => {
    await env.chatService.setWorkspaceRoutinesEnabled(workspaceId, true);
    const service = new RoutinesService({ chatService: env.chatService, backendRegistry: env.backendRegistry });
    await service.ensureWorkspace(workspaceId);
    const directory = service.getRoutineDir(workspaceId, 'fixture-run');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'agent-cockpit.routine', id: 'fixture-run', title: 'Fixture run',
      routineFile: 'routine.md', state: 'enabled', trigger: { type: 'manual' }, notification: { mode: 'off' },
      harness: { cliProfileId: profileId, model: 'grok-4.7', effort: 'low' }, timeoutMinutes: 2 }));
    await fs.writeFile(path.join(directory, 'routine.md'), '# Fixture routine\nReply exactly ROUTINE_FIXTURE_OK. Do no tools or other work.\n');
    const run = await service.runRoutine(workspaceId, 'fixture-run', { source: 'manual' });
    expect(run?.status).toBe('completed');
    expect(await fs.readFile(run!.finalPath!, 'utf8')).toContain('ROUTINE_FIXTURE_OK');
    expect(run?.notificationSentAt).toBeFalsy();
  }, 150_000);
});
