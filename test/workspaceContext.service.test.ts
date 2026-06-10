import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { BackendRegistry } from '../src/services/backends/registry';
import { ChatService } from '../src/services/chatService';
import { WorkspaceContextScheduler, WorkspaceContextService } from '../src/services/workspaceContext/service';
import { workspaceHash } from './helpers/workspace';
import { MockBackendAdapter } from './helpers/mockBackendAdapter';

describe('WorkspaceContextService', () => {
  let tmpDir: string;
  let workspacePath: string;
  let chatService: ChatService;
  let mockBackend: MockBackendAdapter;
  let backendRegistry: BackendRegistry;
  let workspaceContextService: WorkspaceContextService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-service-'));
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
      workspaceContext: {
        scanIntervalMinutes: 5,
        cliConcurrency: 1,
        maintenanceIntervalHours: 24,
        maintenanceCliConcurrency: 1,
      },
    });
    workspaceContextService = new WorkspaceContextService({ chatService, backendRegistry });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('ensures markdown context files and installs the AGENTS.md pointer', async () => {
    await chatService.createConversation('Workspace Context setup', workspacePath);
    const hash = workspaceHash(workspacePath);

    const state = await workspaceContextService.ensureWorkspace(hash);

    expect(state).not.toBeNull();
    const contextDir = workspaceContextService.getContextFilesDir(hash);
    const referencesDir = workspaceContextService.getReferenceFilesDir(hash);
    const assetsDir = workspaceContextService.getAssetsDir(hash);
    const instructionPath = workspaceContextService.getInstructionPath(hash);
    expect(fs.existsSync(instructionPath)).toBe(true);
    expect(fs.existsSync(path.join(contextDir, 'overview.md'))).toBe(true);
    expect(fs.existsSync(referencesDir)).toBe(true);
    expect(fs.existsSync(assetsDir)).toBe(true);
    const agents = await fsp.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('Agent Cockpit Workspace Context');
    expect(agents).toContain(instructionPath);
    expect(agents).toContain(contextDir);
    expect(agents).toContain(referencesDir);
    expect(agents).toContain(assetsDir);
    const instructions = await fsp.readFile(instructionPath, 'utf8');
    expect(instructions).toContain('Use "as of YYYY-MM-DD" for status-like claims');
    expect(instructions).toContain('Distinguish source time from ingestion time when useful');
    expect(instructions).toContain('References folder:');
    expect(instructions).toContain('Assets folder:');

    const files = await workspaceContextService.listFiles(hash);
    expect(files.map((file) => file.path)).toEqual(['overview.md']);
    expect((await workspaceContextService.readFile(hash, 'overview.md'))?.content).toContain('# Workspace Overview');
    expect(await workspaceContextService.readFile(hash, '../state.json')).toBeNull();

    await workspaceContextService.writeReference(hash, 'prompts/style.md', '# Style\n');
    expect((await workspaceContextService.listReferences(hash)).map((file) => file.path)).toEqual(['prompts/style.md']);
    expect((await workspaceContextService.readReference(hash, 'prompts/style.md'))?.content).toBe('# Style\n');
    await workspaceContextService.writeAsset(hash, 'images/reference.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect((await workspaceContextService.listAssets(hash)).map((file) => ({
      path: file.path,
      mimeType: file.mimeType,
      previewable: file.previewable,
      kind: file.kind,
    }))).toEqual([{
      path: 'images/reference.png',
      mimeType: 'image/png',
      previewable: true,
      kind: 'image',
    }]);
  });

  test('runs scans through the configured CLI and records markdown run state', async () => {
    const conv = await chatService.createConversation('Workspace Context source', workspacePath);
    await chatService.addMessage(conv.id, 'user', 'Learn that Ada owns Project Atlas.', 'claude-code');
    const hash = workspaceHash(workspacePath);
    await chatService.setWorkspaceContextEnabled(hash, true);

    mockBackend.setOneShotImpl(async (prompt, opts) => {
      expect(prompt).toContain('Workspace Context Catch-Up');
      expect(prompt).toContain('Source Files');
      expect(opts?.allowTools).toBe(true);
      expect(opts?.workingDir).toBe(workspacePath);
      await fsp.writeFile(
        path.join(workspaceContextService.getContextFilesDir(hash), 'people.md'),
        '# People\n\n- Ada owns Project Atlas.\n',
        'utf8',
      );
      return 'Updated people.md with Ada and Project Atlas.';
    });

    const result = await workspaceContextService.processWorkspace(hash, { source: 'manual_catchup', forceAll: true });

    expect(result.skippedReason).toBeUndefined();
    expect(result.filesConsidered).toBe(1);
    expect(result.summary).toContain('Updated people.md');
    expect(mockBackend._oneShotCalls).toHaveLength(1);
    expect((await workspaceContextService.readFile(hash, 'people.md'))?.content).toContain('Project Atlas');
    const state = await workspaceContextService.getState(hash);
    expect(state.lastRun?.status).toBe('completed');
    expect(state.lastRun?.source).toBe('manual_catchup');
    expect(state.lastCompletedAt).toBeTruthy();
    expect(state.lastScanCompletedAt).toBeTruthy();
    expect(fs.existsSync(path.join(workspaceContextService.getWorkspaceContextDir(hash), 'runs', 'latest.md'))).toBe(true);
  });

  test('records zero-source scans so scheduler cadence remains visible', async () => {
    let now = new Date('2026-05-18T00:00:00.000Z');
    workspaceContextService = new WorkspaceContextService({ chatService, backendRegistry, now: () => now });
    await chatService.saveSettings({
      ...(await chatService.getSettings()),
      workspaceContext: {
        scanIntervalMinutes: 5,
        cliConcurrency: 1,
        maintenanceIntervalHours: 24,
        maintenanceCliConcurrency: 1,
      },
    });
    await chatService.createConversation('Workspace Context no sources', workspacePath);
    const hash = workspaceHash(workspacePath);
    await chatService.setWorkspaceContextEnabled(hash, true);

    const first = await workspaceContextService.processWorkspace(hash, { source: 'manual_catchup', forceAll: true });

    expect(first.runId).toBeTruthy();
    expect(first.filesConsidered).toBe(0);
    expect(first.summary).toBe('No source changes were found for this scan.');
    expect(first.skippedReason).toBeUndefined();
    expect(mockBackend._oneShotCalls).toHaveLength(0);
    let state = await workspaceContextService.getState(hash);
    expect(state.lastRun?.status).toBe('completed');
    expect(state.lastRun?.filesConsidered).toBe(0);
    expect(state.lastScanCompletedAt).toBe('2026-05-18T00:00:00.000Z');
    const statePath = path.join(workspaceContextService.getWorkspaceContextDir(hash), 'state.json');
    await fsp.writeFile(statePath, JSON.stringify({
      ...state,
      lastMaintenanceCompletedAt: '2026-05-18T00:00:00.000Z',
    }, null, 2), 'utf8');

    now = new Date('2026-05-18T00:06:00.000Z');
    const scheduler = new WorkspaceContextScheduler({
      chatService: chatService,
      processor: workspaceContextService,
      now: () => now,
    });
    await scheduler.tick();
    for (let i = 0; i < 20; i += 1) {
      state = await workspaceContextService.getState(hash);
      if (
        state.lastRun?.source === 'scheduled'
        && state.lastRun.startedAt === '2026-05-18T00:06:00.000Z'
        && state.lastRun.status === 'completed'
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(state.lastRun).toEqual(expect.objectContaining({
      source: 'scheduled',
      status: 'completed',
      filesConsidered: 0,
      summary: 'No source changes were found for this scan.',
    }));
    expect(state.lastScanCompletedAt).toBe('2026-05-18T00:06:00.000Z');
    expect(mockBackend._oneShotCalls).toHaveLength(0);
    const runReport = await fsp.readFile(path.join(workspaceContextService.getWorkspaceContextDir(hash), 'runs', 'latest.md'), 'utf8');
    expect(runReport).toContain('- Source: scheduled');
    expect(runReport).toContain('No source changes were found for this scan.');
  });

  test('persists running progress before completing zero-source scans', async () => {
    workspaceContextService = new WorkspaceContextService({
      chatService,
      backendRegistry,
      minVisibleNoSourceRunMs: 500,
    });
    await chatService.createConversation('Workspace Context visible progress', workspacePath);
    const hash = workspaceHash(workspacePath);
    await chatService.setWorkspaceContextEnabled(hash, true);

    const runPromise = workspaceContextService.processWorkspace(hash, { source: 'manual_catchup', forceAll: true });
    let runningState = await workspaceContextService.getState(hash);
    const progressDeadline = Date.now() + 2000;
    while (
      runningState.lastRun?.summary !== 'No source changes found; completing this scan.'
      && Date.now() < progressDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      runningState = await workspaceContextService.getState(hash);
    }

    expect(runningState.lastRun).toEqual(expect.objectContaining({
      source: 'manual_catchup',
      status: 'running',
      filesConsidered: 0,
      summary: 'No source changes found; completing this scan.',
    }));

    const result = await runPromise;
    expect(result.summary).toBe('No source changes were found for this scan.');
    const completedState = await workspaceContextService.getState(hash);
    expect(completedState.lastRun).toEqual(expect.objectContaining({
      source: 'manual_catchup',
      status: 'completed',
      filesConsidered: 0,
    }));
  });

  test('normalizes run history by started time newest first', async () => {
    await chatService.createConversation('Workspace Context run order', workspacePath);
    const hash = workspaceHash(workspacePath);
    await chatService.setWorkspaceContextEnabled(hash, true);
    await workspaceContextService.ensureWorkspace(hash);
    const root = workspaceContextService.getWorkspaceContextDir(hash);
    await fsp.writeFile(path.join(root, 'state.json'), JSON.stringify({
      version: 1,
      contextDir: root,
      lastRun: {
        runId: 'old-run',
        source: 'manual_catchup',
        status: 'completed',
        startedAt: '2026-05-18T08:00:00.000Z',
        completedAt: '2026-05-18T08:02:00.000Z',
        filesConsidered: 1,
        summary: 'Old run.',
      },
      runs: [
        {
          runId: 'newer-start-run',
          source: 'scheduled',
          status: 'completed',
          startedAt: '2026-05-18T10:00:00.000Z',
          completedAt: '2026-05-18T10:01:00.000Z',
          filesConsidered: 1,
          summary: 'Newer started run.',
        },
        {
          runId: 'long-earlier-run',
          source: 'maintenance',
          status: 'completed',
          startedAt: '2026-05-18T09:00:00.000Z',
          completedAt: '2026-05-18T11:00:00.000Z',
          filesConsidered: 2,
          summary: 'Earlier run that completed later.',
        },
        {
          runId: 'old-run',
          source: 'manual_catchup',
          status: 'completed',
          startedAt: '2026-05-18T08:00:00.000Z',
          completedAt: '2026-05-18T08:02:00.000Z',
          filesConsidered: 1,
          summary: 'Old run.',
        },
      ],
    }), 'utf8');

    const state = await workspaceContextService.getState(hash);

    expect(state.lastRun?.runId).toBe('old-run');
    expect(state.runs.map((run) => run.runId)).toEqual(['newer-start-run', 'long-earlier-run', 'old-run']);
  });

  test('promotes uploaded files in messages into first-class source paths', async () => {
    const slackPath = path.join(tmpDir, 'sample-slack-export.md');
    const mailPath = path.join(tmpDir, 'sample-mail-export.md');
    await fsp.writeFile(slackPath, '# Slack\n\nLamont shared VM guidance.\n', 'utf8');
    await fsp.writeFile(mailPath, '# Mail\n\nMaria shared CI doc read outcome.\n', 'utf8');
    const conv = await chatService.createConversation('Workspace Context attachments', workspacePath);
    await chatService.addMessage(
      conv.id,
      'user',
      `Learn from these files.\n\n[Uploaded files: ${slackPath}, ${mailPath}]`,
      'claude-code',
    );
    const hash = workspaceHash(workspacePath);
    await chatService.setWorkspaceContextEnabled(hash, true);

    mockBackend.setOneShotImpl(async (prompt) => {
      expect(prompt).toContain('inspect its messages for uploaded-file paths');
      expect(prompt).toContain(slackPath);
      expect(prompt).toContain(mailPath);
      await fsp.writeFile(
        path.join(workspaceContextService.getContextFilesDir(hash), 'sources.md'),
        '# Sources\n\n- Slack and mail files were listed as first-class sources.\n',
        'utf8',
      );
      return 'Updated sources.md from attached files.';
    });

    const result = await workspaceContextService.processWorkspace(hash, { source: 'manual_catchup', forceAll: true });

    expect(result.skippedReason).toBeUndefined();
    expect(result.filesConsidered).toBe(3);
    expect(mockBackend._oneShotCalls).toHaveLength(1);
    const runReport = await fsp.readFile(path.join(workspaceContextService.getWorkspaceContextDir(hash), 'runs', 'latest.md'), 'utf8');
    expect(runReport).toContain(slackPath);
    expect(runReport).toContain(mailPath);
  });

  test('runs maintenance over existing context markdown without conversation ingestion', async () => {
    await chatService.createConversation('Workspace Context maintenance', workspacePath);
    const hash = workspaceHash(workspacePath);
    await chatService.setWorkspaceContextEnabled(hash, true);
    await workspaceContextService.ensureWorkspace(hash);
    const contextDir = workspaceContextService.getContextFilesDir(hash);
    await fsp.writeFile(
      path.join(contextDir, 'people.md'),
      '# People\n\n- Ada owns Atlas.\n- Ada owns Atlas.\n',
      'utf8',
    );
    await workspaceContextService.writeReference(hash, 'prompts/style.md', '# Style\n\nKeep exact wording.\n');
    await workspaceContextService.writeAsset(hash, 'images/reference.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    mockBackend.setOneShotImpl(async (prompt, opts) => {
      expect(prompt).toContain('Workspace Context Maintenance');
      expect(prompt).toContain('This is a maintenance pass, not a conversation source-ingestion pass.');
      expect(prompt).toContain('## Reference Files');
      expect(prompt).toContain('## Asset Inventory');
      expect(prompt).toContain(path.join(contextDir, 'overview.md'));
      expect(prompt).toContain(path.join(contextDir, 'people.md'));
      expect(prompt).toContain(path.join(workspaceContextService.getReferenceFilesDir(hash), 'prompts/style.md'));
      expect(prompt).toContain('images/reference.png (image/png, 4 bytes)');
      expect(prompt).not.toContain('Workspace Context Catch-Up');
      expect(prompt).not.toContain('## Source Files');
      expect(opts?.workingDir).toBe(workspacePath);
      await fsp.writeFile(
        path.join(contextDir, 'people.md'),
        '# People\n\n- Ada owns Atlas. Current as of 2026-05-19.\n',
        'utf8',
      );
      return 'Merged duplicate Ada notes in people.md.';
    });

    const result = await workspaceContextService.processWorkspace(hash, { source: 'maintenance', forceAll: true });

    expect(result.skippedReason).toBeUndefined();
    expect(result.source).toBe('maintenance');
    expect(result.filesConsidered).toBe(4);
    expect((await workspaceContextService.readFile(hash, 'people.md'))?.content).toContain('Current as of 2026-05-19');
    const state = await workspaceContextService.getState(hash);
    expect(state.lastRun?.source).toBe('maintenance');
    expect(state.lastMaintenanceCompletedAt).toBeTruthy();
    const runReport = await fsp.readFile(path.join(workspaceContextService.getWorkspaceContextDir(hash), 'runs', 'latest.md'), 'utf8');
    expect(runReport).toContain('- Source: maintenance');
    expect(runReport).toContain(path.join(contextDir, 'people.md'));
    expect(runReport).toContain(path.join(workspaceContextService.getReferenceFilesDir(hash), 'prompts/style.md'));
    expect(runReport).toContain(path.join(workspaceContextService.getAssetsDir(hash), 'images/reference.png'));
  });

  test('maintenance consumes accepted Memory inbox entries and deletes them', async () => {
    const memoryUpdates: any[] = [];
    workspaceContextService = new WorkspaceContextService({
      chatService,
      backendRegistry,
      emitMemoryUpdate: (_hash, frame) => {
        memoryUpdates.push(frame);
      },
    });
    await chatService.createConversation('Workspace Context consumes Memory', workspacePath);
    const hash = workspaceHash(workspacePath);
    await chatService.setWorkspaceContextEnabled(hash, true);
    await chatService.setWorkspaceMemoryEnabled(hash, true);
    await workspaceContextService.ensureWorkspace(hash);
    const contextDir = workspaceContextService.getContextFilesDir(hash);
    const relPath = await chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: Project Atlas owner\ndescription: Ada owns Project Atlas\ntype: project\n---\n\nAda owns Project Atlas.',
      source: 'memory-note',
      filenameHint: 'project-atlas-owner',
    });
    const memoryFilePath = path.join(chatService.getWorkspaceMemoryFilesDir(hash), relPath);

    mockBackend.setOneShotImpl(async (prompt) => {
      expect(prompt).toContain('## Memory Inbox Handling');
      expect(prompt).toContain('## Memory Inbox Files');
      expect(prompt).toContain(`${relPath}: ${memoryFilePath}`);
      expect(prompt).toContain('workspace-context-memory-actions');
      await fsp.writeFile(
        path.join(contextDir, 'projects.md'),
        '# Projects\n\n- Ada owns Project Atlas.\n',
        'utf8',
      );
      return [
        'Updated projects.md with Project Atlas ownership.',
        '',
        '```workspace-context-memory-actions',
        JSON.stringify({ acceptedMemoryFiles: [relPath] }),
        '```',
      ].join('\n');
    });

    const result = await workspaceContextService.processWorkspace(hash, { source: 'maintenance', forceAll: true });

    expect(result.filesConsidered).toBe(2);
    expect(result.summary).toContain('Consumed 1 Memory entry');
    expect(fs.existsSync(memoryFilePath)).toBe(false);
    const snapshot = await chatService.getWorkspaceMemory(hash);
    expect((snapshot?.files || []).some((file) => file.filename === relPath)).toBe(false);
    expect((await workspaceContextService.readFile(hash, 'projects.md'))?.content).toContain('Project Atlas');
    expect(memoryUpdates).toEqual([
      expect.objectContaining({
        type: 'memory_update',
        changedFiles: [relPath],
        displayInChat: false,
      }),
    ]);
  });

  test('maintenance fails visibly when Memory inbox actions are missing', async () => {
    await chatService.createConversation('Workspace Context missing Memory actions', workspacePath);
    const hash = workspaceHash(workspacePath);
    await chatService.setWorkspaceContextEnabled(hash, true);
    await chatService.setWorkspaceMemoryEnabled(hash, true);
    await workspaceContextService.ensureWorkspace(hash);
    const relPath = await chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: Project Atlas owner\ndescription: Ada owns Project Atlas\ntype: project\n---\n\nAda owns Project Atlas.',
      source: 'memory-note',
      filenameHint: 'project-atlas-owner',
    });

    mockBackend.setOneShotImpl(async () => 'Updated projects.md but omitted the required action block.');

    await expect(workspaceContextService.processWorkspace(hash, { source: 'maintenance', forceAll: true }))
      .rejects.toThrow('memory action block is required');
    const snapshot = await chatService.getWorkspaceMemory(hash);
    expect((snapshot?.files || []).some((file) => file.filename === relPath)).toBe(true);
    const state = await workspaceContextService.getState(hash);
    expect(state.lastRun?.status).toBe('failed');
  });

  test('maintenance fails visibly when Memory inbox actions are duplicated', async () => {
    await chatService.createConversation('Workspace Context duplicate Memory actions', workspacePath);
    const hash = workspaceHash(workspacePath);
    await chatService.setWorkspaceContextEnabled(hash, true);
    await chatService.setWorkspaceMemoryEnabled(hash, true);
    await workspaceContextService.ensureWorkspace(hash);
    const relPath = await chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: Project Atlas owner\ndescription: Ada owns Project Atlas\ntype: project\n---\n\nAda owns Project Atlas.',
      source: 'memory-note',
      filenameHint: 'project-atlas-owner',
    });

    mockBackend.setOneShotImpl(async () => [
      'Updated projects.md.',
      '',
      '```workspace-context-memory-actions',
      JSON.stringify({ acceptedMemoryFiles: [relPath] }),
      '```',
      '',
      '```workspace-context-memory-actions',
      JSON.stringify({ acceptedMemoryFiles: [] }),
      '```',
    ].join('\n'));

    await expect(workspaceContextService.processWorkspace(hash, { source: 'maintenance', forceAll: true }))
      .rejects.toThrow('memory action block must appear exactly once');
    const snapshot = await chatService.getWorkspaceMemory(hash);
    expect((snapshot?.files || []).some((file) => file.filename === relPath)).toBe(true);
  });

  test('maintenance prunes run logs older than one week', async () => {
    const now = new Date('2026-05-20T12:00:00.000Z');
    workspaceContextService = new WorkspaceContextService({ chatService, backendRegistry, now: () => now });
    await chatService.createConversation('Workspace Context maintenance retention', workspacePath);
    const hash = workspaceHash(workspacePath);
    await chatService.setWorkspaceContextEnabled(hash, true);
    await workspaceContextService.ensureWorkspace(hash);
    const root = workspaceContextService.getWorkspaceContextDir(hash);
    const runsDir = path.join(root, 'runs');
    const oldReport = path.join(runsDir, '2026-05-10T12-00-00-000Z-scheduled.md');
    const recentReport = path.join(runsDir, '2026-05-19T12-00-00-000Z-scheduled.md');
    await fsp.writeFile(oldReport, '# Old run\n', 'utf8');
    await fsp.writeFile(recentReport, '# Recent run\n', 'utf8');
    await fsp.writeFile(path.join(runsDir, 'latest.md'), '# Latest run\n', 'utf8');
    await fsp.writeFile(path.join(root, 'state.json'), JSON.stringify({
      version: 1,
      contextDir: root,
      lastRun: {
        runId: 'recent-run',
        source: 'scheduled',
        status: 'completed',
        startedAt: '2026-05-19T12:00:00.000Z',
        completedAt: '2026-05-19T12:00:01.000Z',
        filesConsidered: 1,
        summary: 'Recent run.',
      },
      runs: [
        {
          runId: 'old-run',
          source: 'scheduled',
          status: 'completed',
          startedAt: '2026-05-10T12:00:00.000Z',
          completedAt: '2026-05-10T12:00:01.000Z',
          filesConsidered: 1,
          summary: 'Old run.',
        },
        {
          runId: 'recent-run',
          source: 'scheduled',
          status: 'completed',
          startedAt: '2026-05-19T12:00:00.000Z',
          completedAt: '2026-05-19T12:00:01.000Z',
          filesConsidered: 1,
          summary: 'Recent run.',
        },
      ],
      lastScanCompletedAt: '2026-05-19T12:00:01.000Z',
    }, null, 2), 'utf8');

    mockBackend.setOneShotImpl(async () => 'Maintenance complete.');
    const result = await workspaceContextService.processWorkspace(hash, { source: 'maintenance', forceAll: true });

    expect(result.source).toBe('maintenance');
    expect(fs.existsSync(oldReport)).toBe(false);
    expect(fs.existsSync(recentReport)).toBe(true);
    expect(fs.existsSync(path.join(runsDir, 'latest.md'))).toBe(true);
    const state = await workspaceContextService.getState(hash);
    expect(state.runs.map((run) => run.runId)).toContain('recent-run');
    expect(state.runs.map((run) => run.runId)).not.toContain('old-run');
    expect(state.lastScanCompletedAt).toBe('2026-05-19T12:00:01.000Z');
    expect(state.lastRun?.source).toBe('maintenance');
  });

  test('scheduler runs maintenance on its own interval and records scan skips during maintenance', async () => {
    let now = new Date('2026-05-18T00:00:00.000Z');
    workspaceContextService = new WorkspaceContextService({ chatService, backendRegistry, now: () => now });
    await chatService.saveSettings({
      ...(await chatService.getSettings()),
      workspaceContext: {
        scanIntervalMinutes: 1440,
        cliConcurrency: 1,
        maintenanceIntervalHours: 24,
        maintenanceCliConcurrency: 1,
      },
    });
    const conv = await chatService.createConversation('Workspace Context scheduled maintenance', workspacePath);
    await chatService.addMessage(conv.id, 'user', 'Learn that Ada owns Project Atlas.', 'claude-code');
    const hash = workspaceHash(workspacePath);
    await chatService.setWorkspaceContextEnabled(hash, true);

    mockBackend.setOneShotImpl(async () => 'Initial scan complete.');
    await workspaceContextService.processWorkspace(hash, { source: 'manual_catchup', forceAll: true });
    const statePath = path.join(workspaceContextService.getWorkspaceContextDir(hash), 'state.json');
    const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    state.lastMaintenanceCompletedAt = '2026-05-17T00:00:00.000Z';
    await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    now = new Date('2026-05-18T01:00:00.000Z');
    const releaseMaintenance: { current?: () => void } = {};
    mockBackend.setOneShotImpl((prompt) => new Promise((resolve) => {
      expect(prompt).toContain('Workspace Context Maintenance');
      releaseMaintenance.current = () => resolve('Maintenance complete.');
    }));
    const scheduler = new WorkspaceContextScheduler({
      chatService: chatService,
      processor: workspaceContextService,
      now: () => now,
    });

    await scheduler.tick();
    for (let i = 0; i < 20 && !releaseMaintenance.current; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!releaseMaintenance.current) throw new Error('Workspace Context maintenance did not start');

    now = new Date('2026-05-19T01:00:00.000Z');
    await scheduler.tick();
    const skippedState = await workspaceContextService.getState(hash);
    expect(skippedState.lastRun?.status).toBe('skipped');
    expect(skippedState.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'skipped',
        source: 'scheduled',
        skippedReason: 'maintenance-running',
      }),
      expect.objectContaining({
        status: 'skipped',
        source: 'maintenance',
        skippedReason: 'maintenance-running',
      }),
    ]));

    releaseMaintenance.current();
    for (let i = 0; i < 20 && workspaceContextService.isRunning(hash); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const completedState = await workspaceContextService.getState(hash);
    expect(completedState.lastRun?.source).toBe('maintenance');
    expect(completedState.lastRun?.status).toBe('completed');
    expect(completedState.lastMaintenanceCompletedAt).toBeTruthy();
  });

  test('scheduler starts maintenance when frequent scans updated last scan but no maintenance has completed', async () => {
    let now = new Date('2026-05-18T00:00:00.000Z');
    workspaceContextService = new WorkspaceContextService({ chatService, backendRegistry, now: () => now });
    await chatService.saveSettings({
      ...(await chatService.getSettings()),
      workspaceContext: {
        scanIntervalMinutes: 5,
        cliConcurrency: 1,
        maintenanceIntervalHours: 24,
        maintenanceCliConcurrency: 1,
      },
    });
    const conv = await chatService.createConversation('Workspace Context maintenance bootstrap', workspacePath);
    await chatService.addMessage(conv.id, 'user', 'Learn that Ada owns Project Atlas.', 'claude-code');
    const hash = workspaceHash(workspacePath);
    await chatService.setWorkspaceContextEnabled(hash, true);

    mockBackend.setOneShotImpl(async () => 'Initial scan complete.');
    await workspaceContextService.processWorkspace(hash, { source: 'manual_catchup', forceAll: true });
    const statePath = path.join(workspaceContextService.getWorkspaceContextDir(hash), 'state.json');
    const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    state.lastScanCompletedAt = '2026-05-18T23:59:00.000Z';
    delete state.lastMaintenanceCompletedAt;
    await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    now = new Date('2026-05-19T00:00:00.000Z');
    const releaseMaintenance: { current?: () => void } = {};
    mockBackend.setOneShotImpl((prompt) => new Promise((resolve) => {
      expect(prompt).toContain('Workspace Context Maintenance');
      releaseMaintenance.current = () => resolve('Maintenance complete.');
    }));
    const scheduler = new WorkspaceContextScheduler({
      chatService: chatService,
      processor: workspaceContextService,
      now: () => now,
    });

    await scheduler.tick();
    for (let i = 0; i < 20 && !releaseMaintenance.current; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!releaseMaintenance.current) throw new Error('Workspace Context maintenance did not start');

    releaseMaintenance.current();
    for (let i = 0; i < 20 && workspaceContextService.isRunning(hash); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const completedState = await workspaceContextService.getState(hash);
    expect(completedState.lastRun?.source).toBe('maintenance');
    expect(completedState.lastRun?.status).toBe('completed');
    expect(completedState.lastMaintenanceCompletedAt).toBe('2026-05-19T00:00:00.000Z');
  });
});
