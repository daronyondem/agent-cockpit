import fsp from 'fs/promises';
import path from 'path';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { workspaceHash } from './helpers/workspace';

describe('Workspace Context routes', () => {
  let env: ChatRouterEnv;

  beforeEach(async () => {
    env = await createChatRouterEnv();
    env.mockBackend.setOneShotImpl(async () => 'No durable context changes needed.');
  });

  afterEach(async () => {
    await destroyChatRouterEnv(env);
  });

  test('enables Workspace Context and exposes read-only markdown files', async () => {
    const workspacePath = path.join(env.tmpDir, 'workspace-context-route');
    await fsp.mkdir(workspacePath, { recursive: true });
    const conv = await env.chatService.createConversation('Workspace Context Routes', workspacePath);
    const hash = workspaceHash(workspacePath);

    const enabled = await env.request('PUT', `/api/chat/workspaces/${hash}/workspace-context/enabled`, { enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled).toBe(true);
    expect(enabled.body.contextDir).toContain('workspace-context/context');
    expect(enabled.body.instructionPath).toContain('workspace-context/WORKSPACE_CONTEXT.md');
    expect(enabled.body.files.map((file: { path: string }) => file.path)).toContain('overview.md');

    await fsp.writeFile(
      path.join(env.workspaceContextService.getContextFilesDir(hash), 'projects.md'),
      '# Projects\n\n- Route test project.\n',
      'utf8',
    );

    const files = await env.request('GET', `/api/chat/workspaces/${hash}/workspace-context/files`);
    expect(files.status).toBe(200);
    expect(files.headers['cache-control']).toBe('no-store');
    expect(files.body.files.map((file: { path: string }) => file.path)).toContain('projects.md');

    const file = await env.request('GET', `/api/chat/workspaces/${hash}/workspace-context/files/${encodeURIComponent('projects.md')}`);
    expect(file.status).toBe(200);
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.body).toEqual({
      path: 'projects.md',
      content: '# Projects\n\n- Route test project.\n',
    });

    const convWithStatus = await env.request('GET', `/api/chat/conversations/${conv.id}`);
    expect(convWithStatus.status).toBe(200);
    expect(convWithStatus.body.workspaceContext.enabled).toBe(true);
    expect(convWithStatus.body.workspaceContext.contextDir).toContain('workspace-context');
  });

  test('serves conversation-scoped Workspace Context markdown previews only for that workspace', async () => {
    const workspacePath = path.join(env.tmpDir, 'workspace-context-chat-link');
    await fsp.mkdir(workspacePath, { recursive: true });
    const conv = await env.chatService.createConversation('Workspace Context Chat Link', workspacePath);
    const hash = workspaceHash(workspacePath);
    await env.chatService.setWorkspaceContextEnabled(hash, true);
    await env.workspaceContextService.ensureWorkspace(hash);

    const contextDir = env.workspaceContextService.getContextFilesDir(hash);
    const contextFile = path.join(contextDir, 'projects.md');
    await fsp.writeFile(contextFile, '# Projects\n\n- Render this as markdown.\n', 'utf8');

    const preview = await env.request(
      'GET',
      `/api/chat/conversations/${conv.id}/workspace-context-file?path=${encodeURIComponent(contextFile)}&mode=view`,
    );
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      content: '# Projects\n\n- Render this as markdown.\n',
      filename: 'projects.md',
      language: 'markdown',
    });
    expect(preview.body.path).toContain('workspace-context');

    const otherWorkspacePath = path.join(env.tmpDir, 'workspace-context-other-chat-link');
    await fsp.mkdir(otherWorkspacePath, { recursive: true });
    await env.chatService.createConversation('Other Workspace Context', otherWorkspacePath);
    const otherHash = workspaceHash(otherWorkspacePath);
    await env.chatService.setWorkspaceContextEnabled(otherHash, true);
    await env.workspaceContextService.ensureWorkspace(otherHash);
    const otherFile = path.join(env.workspaceContextService.getContextFilesDir(otherHash), 'projects.md');
    await fsp.writeFile(otherFile, '# Other workspace\n', 'utf8');

    const rejected = await env.request(
      'GET',
      `/api/chat/conversations/${conv.id}/workspace-context-file?path=${encodeURIComponent(otherFile)}&mode=view`,
    );
    expect(rejected.status).toBe(403);

    const traversal = await env.request(
      'GET',
      `/api/chat/conversations/${conv.id}/workspace-context-file?path=${encodeURIComponent(`${contextDir}/../secret.md`)}&mode=view`,
    );
    expect(traversal.status).toBe(400);
  });

  test('starts and stops manual scans through route controls', async () => {
    const workspacePath = path.join(env.tmpDir, 'workspace-context-stop');
    await fsp.mkdir(workspacePath, { recursive: true });
    const conv = await env.chatService.createConversation('Workspace Context Stop', workspacePath);
    await env.chatService.addMessage(conv.id, 'user', 'Workspace Context stop source.', 'claude-code');
    const hash = workspaceHash(workspacePath);
    await env.chatService.setWorkspaceContextEnabled(hash, true);
    await env.workspaceContextService.ensureWorkspace(hash);

    const releaseRun: { current?: () => void } = {};
    env.mockBackend.setOneShotImpl(() => new Promise((resolve) => {
      releaseRun.current = () => resolve('Stopped test run.');
    }));

    const started = await env.request('POST', `/api/chat/workspaces/${hash}/workspace-context/scan`, {});
    expect(started.status).toBe(200);
    expect(started.body.started).toBe(true);
    const runningStatus = await env.request('GET', `/api/chat/workspaces/${hash}/workspace-context/settings`);
    expect(runningStatus.headers['cache-control']).toBe('no-store');
    expect(runningStatus.body.state.lastRun).toMatchObject({
      source: 'manual_catchup',
      status: 'running',
    });
    const duplicateStart = await env.request('POST', `/api/chat/workspaces/${hash}/workspace-context/scan`, {});
    expect(duplicateStart.status).toBe(409);
    expect(duplicateStart.body.state.lastRun).toMatchObject({
      source: 'manual_catchup',
      status: 'running',
    });

    for (let i = 0; i < 20 && !releaseRun.current; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!releaseRun.current) throw new Error('Workspace Context test run did not start');
    const stopped = await env.request('POST', `/api/chat/workspaces/${hash}/workspace-context/scan/stop`, {});
    expect(stopped.status).toBe(200);
    expect(stopped.body.stopped).toBe(true);
    releaseRun.current();
    for (let i = 0; i < 20 && env.workspaceContextService.isRunning(hash); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(env.workspaceContextService.isRunning(hash)).toBe(false);
  });

  test('starts maintenance through route controls', async () => {
    const workspacePath = path.join(env.tmpDir, 'workspace-context-maintenance');
    await fsp.mkdir(workspacePath, { recursive: true });
    await env.chatService.createConversation('Workspace Context Maintenance', workspacePath);
    const hash = workspaceHash(workspacePath);
    await env.chatService.setWorkspaceContextEnabled(hash, true);
    await env.workspaceContextService.ensureWorkspace(hash);
    const contextDir = env.workspaceContextService.getContextFilesDir(hash);
    await fsp.writeFile(path.join(contextDir, 'people.md'), '# People\n\n- Duplicate.\n- Duplicate.\n', 'utf8');

    env.mockBackend.setOneShotImpl(async (prompt) => {
      expect(prompt).toContain('Workspace Context Maintenance');
      expect(prompt).toContain(path.join(contextDir, 'people.md'));
      await fsp.writeFile(path.join(contextDir, 'people.md'), '# People\n\n- Duplicate merged.\n', 'utf8');
      return 'Maintained people.md.';
    });

    const started = await env.request('POST', `/api/chat/workspaces/${hash}/workspace-context/maintenance`, {});
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ ok: true, started: true, source: 'maintenance' });

    for (let i = 0; i < 50; i += 1) {
      const state = await env.workspaceContextService.getState(hash);
      if (state.lastRun?.source === 'maintenance' && state.lastRun.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const state = await env.workspaceContextService.getState(hash);
    expect(state.lastRun?.source).toBe('maintenance');
    expect(state.lastRun?.status).toBe('completed');
    expect((await env.workspaceContextService.readFile(hash, 'people.md'))?.content).toContain('Duplicate merged');
  });
});
