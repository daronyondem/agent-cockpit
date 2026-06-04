import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { BackendRegistry } from '../src/services/backends/registry';
import { ChatService } from '../src/services/chatService';
import { RoutinesScheduler, RoutinesService, TelegramRoutineNotifier, type RoutineNotifier } from '../src/services/routines/service';
import { validateRoutineManifest, type WorkspaceRoutineSettings } from '../src/contracts/routines';
import { workspaceHash } from './helpers/workspace';
import { MockBackendAdapter } from './helpers/mockBackendAdapter';

describe('RoutinesService', () => {
  let tmpDir: string;
  let workspacePath: string;
  let chatService: ChatService;
  let mockBackend: MockBackendAdapter;
  let backendRegistry: BackendRegistry;
  let notifier: MockRoutineNotifier;
  let service: RoutinesService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routines-service-'));
    workspacePath = path.join(tmpDir, 'workspace');
    await fsp.mkdir(workspacePath, { recursive: true });
    mockBackend = new MockBackendAdapter();
    backendRegistry = new BackendRegistry();
    backendRegistry.register(mockBackend);
    chatService = new ChatService(tmpDir, { defaultWorkspace: workspacePath, backendRegistry });
    await chatService.initialize();
    await chatService.saveSettings({
      ...(await chatService.getSettings()),
      defaultBackend: 'claude-code',
    });
    const conv = await chatService.createConversation('Routines workspace', workspacePath);
    await chatService.setWorkspaceRoutinesEnabled(conv.workspaceId, true);
    notifier = new MockRoutineNotifier();
    service = new RoutinesService({ chatService, backendRegistry, notifier });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('ensures authoring files and installs a workspace AGENTS pointer', async () => {
    const hash = workspaceHash(workspacePath);

    await service.ensureWorkspace(hash);

    const authoringPath = service.getAuthoringPath(hash);
    const authoring = await fsp.readFile(authoringPath, 'utf8');
    expect(authoring).toContain('Agent Cockpit Routine Authoring');
    expect(authoring).toContain('AGENT_COCKPIT_ROUTINE_PROPOSAL');
    expect(authoring).toContain('persistent state folder under Agent Cockpit data');
    expect(authoring).toContain('Do not create `.agent-cockpit`');
    expect(authoring).not.toContain('Last generated');
    service = new RoutinesService({ chatService, backendRegistry, notifier, now: () => new Date('2035-01-01T00:00:00.000Z') });
    await service.ensureWorkspace(hash);
    expect(await fsp.readFile(authoringPath, 'utf8')).toBe(authoring);
    const agents = await fsp.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('Agent Cockpit Routines');
    expect(agents).toContain(authoringPath);
  });

  test('does not create scaffolding or expose routines while disabled', async () => {
    const hash = workspaceHash(workspacePath);
    await chatService.setWorkspaceRoutinesEnabled(hash, false);

    expect(await service.getSettingsResponse(hash)).toMatchObject({ enabled: false });
    await expect(service.listRoutines(hash)).resolves.toEqual([]);
    await expect(fsp.readFile(service.getAuthoringPath(hash), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(service.runRoutine(hash, 'missing', { source: 'manual' })).resolves.toBeNull();
  });

  test('validates routine proposal markers inside the workspace routines folder', async () => {
    const hash = workspaceHash(workspacePath);
    await service.ensureWorkspace(hash);
    const manifestPath = await writeRoutine(hash, service, {
      id: 'linkedin-comment-radar',
      title: 'LinkedIn Comment Radar',
      state: 'proposed',
    });

    const result = await service.validateProposalMarkers(hash, `done\n<!-- AGENT_COCKPIT_ROUTINE_PROPOSAL:v1:${manifestPath} -->`);

    expect(result).toHaveLength(1);
    expect(result[0].routineId).toBe('linkedin-comment-radar');
    const routines = await service.listRoutines(hash);
    expect(routines.map((item) => item.manifest.id)).toEqual(['linkedin-comment-radar']);
    expect(routines[0].manifest.state).toBe('proposed');
    await expect(service.validateProposalMarker(hash, path.relative(process.cwd(), manifestPath))).resolves.toBeNull();
    const badDir = service.getRoutineDir(hash, 'bad-proposal');
    await fsp.mkdir(badDir, { recursive: true });
    const badManifestPath = path.join(badDir, 'manifest.json');
    await fsp.writeFile(badManifestPath, '{bad json', 'utf8');
    await expect(service.validateProposalMarker(hash, badManifestPath)).resolves.toBeNull();
  });

  test('rejects incomplete schedule windows and invalid timezones', () => {
    expect(() => validateRoutineManifest({
      schemaVersion: 1,
      kind: 'agent-cockpit.routine',
      id: 'bad-window',
      title: 'Bad Window',
      routineFile: 'routine.md',
      state: 'proposed',
      trigger: { type: 'schedule', intervalMinutes: 15, windowStart: '09:00' },
    })).toThrow('schedule windows must include both windowStart and windowEnd');

    expect(() => validateRoutineManifest({
      schemaVersion: 1,
      kind: 'agent-cockpit.routine',
      id: 'bad-timezone',
      title: 'Bad Timezone',
      routineFile: 'routine.md',
      state: 'proposed',
      trigger: { type: 'schedule', intervalMinutes: 15, timezone: 'Nope/Nowhere' },
    })).toThrow('timezone must be a valid IANA timezone');
  });

  test('installs, edits, disables, and deletes a routine', async () => {
    const hash = workspaceHash(workspacePath);
    await service.ensureWorkspace(hash);
    await writeRoutine(hash, service, { id: 'daily-review', title: 'Daily Review', state: 'proposed' });

    await expect(service.runRoutine(hash, 'daily-review', { source: 'manual' })).resolves.toBeNull();
    expect(mockBackend._oneShotCalls).toHaveLength(0);

    let installed = await service.installRoutine(hash, 'daily-review', 'enabled');
    expect(installed?.manifest.state).toBe('enabled');

    installed = await service.updateRoutine(hash, 'daily-review', {
      manifest: {
        title: 'Daily Review Digest',
        state: 'disabled',
        trigger: { type: 'schedule', intervalMinutes: 60 },
      },
      routineContent: '# Updated workflow\n',
    });
    expect(installed?.manifest.title).toBe('Daily Review Digest');
    expect(installed?.manifest.state).toBe('disabled');
    expect(installed?.manifest.trigger).toEqual({ type: 'schedule', intervalMinutes: 60 });
    const detail = await service.getRoutine(hash, 'daily-review');
    expect(detail?.routineContent).toContain('Updated workflow');

    await expect(service.deleteRoutine(hash, 'daily-review')).resolves.toBe(true);
    expect(await service.listRoutines(hash)).toEqual([]);
  });

  test('runs a routine through one-shot, records output, and routes notify.md', async () => {
    const hash = workspaceHash(workspacePath);
    await service.ensureWorkspace(hash);
    await writeRoutine(hash, service, {
      id: 'radar',
      title: 'Radar',
      state: 'enabled',
      notification: { mode: 'workspaceDefault' },
    });
    await service.updateWorkspaceSettings(hash, {
      telegram: { enabled: true, botToken: 'token', chatId: 'chat-1' },
    });
    mockBackend.setOneShotImpl(async (prompt) => {
      const notifyPath = prompt.match(/Notification file: (.*notify\.md)/)?.[1];
      if (!notifyPath) throw new Error('missing notification path');
      const persistentStateDir = prompt.match(/Persistent state folder: (.*persistent-state)/)?.[1];
      if (!persistentStateDir) throw new Error('missing persistent state folder');
      await fsp.writeFile(path.join(persistentStateDir, 'cursor.json'), '{"ok":true}\n', 'utf8');
      await fsp.writeFile(notifyPath, 'Two opportunities are ready.\n', 'utf8');
      return 'Routine completed.';
    });

    const run = await service.runRoutine(hash, 'radar', { source: 'manual' });

    expect(run?.status).toBe('completed');
    expect(run?.finalPath && fs.existsSync(run.finalPath)).toBe(true);
    expect(run?.notifyPath && fs.existsSync(run.notifyPath)).toBe(true);
    expect(run?.notificationSentAt).toBeTruthy();
    expect(notifier.telegramMessages).toEqual(['Two opportunities are ready.']);
    const detail = await service.getRoutine(hash, 'radar');
    expect(detail?.runs[0].runId).toBe(run?.runId);
    expect(mockBackend._oneShotCalls[0].prompt).toContain('Routine Markdown');
    expect(mockBackend._oneShotCalls[0].prompt).toContain('Persistent state folder:');
    expect(mockBackend._oneShotCalls[0].prompt).toContain('Do not create `.agent-cockpit`');
    expect(mockBackend._oneShotCalls[0].options?.allowTools).toBe(true);
    expect(mockBackend._oneShotCalls[0].options?.workingDir).toBe(workspacePath);
    const persistentStateDir = service.getRoutinePersistentStateDir(hash, 'radar');
    expect(fs.existsSync(path.join(persistentStateDir, 'cursor.json'))).toBe(true);
    expect(persistentStateDir.startsWith(workspacePath)).toBe(false);
  });

  test('uses the global Telegram bot token with workspace chat destinations', async () => {
    const hash = workspaceHash(workspacePath);
    await chatService.saveSettings({
      ...(await chatService.getSettings()),
      integrations: { telegram: { botToken: 'global-token' } },
    });
    await service.ensureWorkspace(hash);
    await writeRoutine(hash, service, {
      id: 'global-telegram',
      title: 'Global Telegram',
      state: 'enabled',
      notification: { mode: 'workspaceDefault' },
    });
    await service.updateWorkspaceSettings(hash, {
      telegram: { enabled: true, chatId: 'chat-1' },
    });
    mockBackend.setOneShotImpl(async (prompt) => {
      const notifyPath = prompt.match(/Notification file: (.*notify\.md)/)?.[1];
      if (!notifyPath) throw new Error('missing notification path');
      await fsp.writeFile(notifyPath, 'Global bot token used.\n', 'utf8');
      return 'Routine completed.';
    });

    const run = await service.runRoutine(hash, 'global-telegram', { source: 'manual' });

    expect(run?.notificationSentAt).toBeTruthy();
    expect(notifier.telegramMessages).toEqual(['Global bot token used.']);
    expect(notifier.telegramSettings[0]?.telegram?.botToken).toBe('global-token');
    expect(notifier.telegramSettings[0]?.telegram?.chatId).toBe('chat-1');
  });

  test('discovers and stores a Telegram destination from a connect code', async () => {
    const hash = workspaceHash(workspacePath);

    await expect(service.startTelegramDestinationConnect(hash)).resolves.toEqual({ status: 'missing_bot' });

    await chatService.saveSettings({
      ...(await chatService.getSettings()),
      integrations: { telegram: { botToken: 'global-token' } },
    });
    const started = await service.startTelegramDestinationConnect(hash);
    expect(started.status).toBe('pending');
    expect(started.code).toMatch(/^AC-\d{6}$/);
    expect(started.instruction).toBe(`/connect ${started.code}`);

    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: [{
          update_id: 42,
          message: {
            date: Math.floor(Date.now() / 1000),
            text: `/connect ${started.code}`,
            chat: {
              id: -100123456789,
              type: 'group',
              title: 'Routine Alerts',
            },
          },
        }],
      }),
    } as unknown as Response);

    try {
      const polled = await service.pollTelegramDestinationConnect(hash);

      expect(polled.status).toBe('connected');
      expect(polled.destination).toEqual({
        chatId: '-100123456789',
        chatTitle: 'Routine Alerts',
        chatType: 'group',
      });
      expect(polled.settings?.notification.telegram).toMatchObject({
        enabled: true,
        configured: true,
        botConfigured: true,
        destinationConfigured: true,
        chatId: '-100123456789',
        chatTitle: 'Routine Alerts',
        chatType: 'group',
      });
      expect(fetchSpy.mock.calls[0][0]).toContain('/getUpdates?');
      expect(fetchSpy.mock.calls[0][0]).not.toContain('sendMessage');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('scheduler starts due enabled routines only', async () => {
    const now = new Date('2026-06-03T16:00:00.000Z');
    service = new RoutinesService({ chatService, backendRegistry, notifier, now: () => now });
    const hash = workspaceHash(workspacePath);
    await service.ensureWorkspace(hash);
    await writeRoutine(hash, service, {
      id: 'due-routine',
      title: 'Due Routine',
      state: 'enabled',
      trigger: { type: 'schedule', intervalMinutes: 15, timezone: 'America/Los_Angeles', windowStart: '06:30', windowEnd: '18:30' },
    });
    await writeRoutine(hash, service, {
      id: 'draft-routine',
      title: 'Draft Routine',
      state: 'proposed',
      trigger: { type: 'schedule', intervalMinutes: 15 },
    });
    mockBackend.setOneShotImpl(async () => 'ok');

    const scheduler = new RoutinesScheduler({ service, intervalMs: 1000 });
    const started = await scheduler.tick();

    expect(started).toBe(1);
    await eventually(async () => {
      const due = await service.getRoutine(hash, 'due-routine');
      expect(due?.lastRun?.status).toBe('completed');
    });
    const draft = await service.getRoutine(hash, 'draft-routine');
    expect(draft?.lastRun).toBeUndefined();
  });

  test('Telegram notifier sends a bounded plain-text request', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '',
    } as unknown as Response);

    await new TelegramRoutineNotifier().sendTelegram({
      telegram: {
        enabled: true,
        botToken: '123:abc',
        chatId: 'chat-1',
      },
    }, 'Routine **done**.');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.signal).toBeTruthy();
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: 'chat-1',
      text: 'Routine **done**.',
      disable_web_page_preview: false,
    });
    fetchSpy.mockRestore();
  });
});

class MockRoutineNotifier implements RoutineNotifier {
  telegramMessages: string[] = [];
  telegramSettings: WorkspaceRoutineSettings[] = [];

  async sendTelegram(settings: WorkspaceRoutineSettings, content: string): Promise<void> {
    this.telegramSettings.push(settings);
    this.telegramMessages.push(content);
  }
}

async function writeRoutine(
  hash: string,
  service: RoutinesService,
  input: {
    id: string;
    title: string;
    state: 'proposed' | 'enabled' | 'disabled';
    trigger?: unknown;
    notification?: unknown;
  },
): Promise<string> {
  const routineDir = service.getRoutineDir(hash, input.id);
  await fsp.mkdir(routineDir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    kind: 'agent-cockpit.routine',
    id: input.id,
    title: input.title,
    routineFile: 'routine.md',
    state: input.state,
    trigger: input.trigger || { type: 'manual' },
    notification: input.notification || { mode: 'off' },
  };
  await fsp.writeFile(path.join(routineDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fsp.writeFile(path.join(routineDir, 'routine.md'), `# ${input.title}\n`, 'utf8');
  return path.join(routineDir, 'manifest.json');
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}
