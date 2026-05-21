/* eslint-disable @typescript-eslint/no-explicit-any */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';

let env: ChatRouterEnv;

beforeEach(async () => { env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); });

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function createRepoWithRemote(name: string): string {
  const repo = path.join(env.tmpDir, name);
  const remote = path.join(env.tmpDir, `${name}.git`);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'hello\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  git(env.tmpDir, ['init', '--bare', remote]);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return repo;
}

describe('worktree isolation routes', () => {
  test('reports unavailable for a non-Git workspace', async () => {
    const workspace = path.join(env.tmpDir, 'plain');
    fs.mkdirSync(workspace, { recursive: true });
    const conv = await env.chatService.createConversation('Plain', workspace);

    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.available).toBe(false);
    expect(res.body.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'not_git_repo' }),
    ]));
  });

  test('requires confirmation before enabling because sessions reset', async () => {
    const repo = createRepoWithRemote('confirm-repo');
    const conv = await env.chatService.createConversation('Confirm', repo);

    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('confirmation_required');
  });

  test('blocks enablement when the base checkout is dirty', async () => {
    const repo = createRepoWithRemote('dirty-base-repo');
    const conv = await env.chatService.createConversation('Dirty Base', repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n');

    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('base_dirty');
    expect(res.body.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'base_dirty', path: fs.realpathSync(repo) }),
    ]));
  });

  test('blocks enablement when origin/main is unavailable', async () => {
    const repo = path.join(env.tmpDir, 'no-origin-repo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test User']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'hello\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial']);
    const conv = await env.chatService.createConversation('No Origin', repo);

    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('remote_unavailable');
    expect(res.body.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'remote_unavailable' }),
    ]));
  });

  test('only blocks toggles for in-flight conversations in the target workspace', async () => {
    const targetRepo = createRepoWithRemote('target-in-flight-repo');
    const otherRepo = createRepoWithRemote('other-in-flight-repo');
    const target = await env.chatService.createConversation('Target', targetRepo);
    const other = await env.chatService.createConversation('Other', otherRepo);

    env.activeStreams.set(other.id, {} as any);
    const allowed = await env.request('PUT', `/api/chat/workspaces/${target.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });
    expect(allowed.status).toBe(200);
    env.activeStreams.delete(other.id);

    env.activeStreams.set(target.id, {} as any);
    const blocked = await env.request('PUT', `/api/chat/workspaces/${target.workspaceHash}/worktree-isolation`, {
      enabled: false,
      confirmedSessionReset: true,
    });
    env.activeStreams.delete(target.id);

    expect(blocked.status).toBe(409);
    expect(blocked.body.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'active_streams' }),
    ]));
  });

  test('enables worktree isolation and migrates existing conversations', async () => {
    const repo = createRepoWithRemote('enable-repo');
    const first = await env.chatService.createConversation('First', repo);
    const second = await env.chatService.createConversation('Second', repo);
    await env.chatService.archiveConversation(second.id);
    await env.chatService.addMessage(first.id, 'user', 'existing context', 'claude-code');
    const resetSpy = jest.spyOn(env.mockBackend, 'onSessionReset');

    const res = await env.request('PUT', `/api/chat/workspaces/${first.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.available).toBe(true);
    expect(res.body.repoRoot).toBe(fs.realpathSync(repo));
    expect(res.body.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, mode: 'worktree' }),
      expect.objectContaining({ id: second.id, mode: 'worktree', archived: true }),
    ]));

    const migrated = await env.chatService.getConversation(first.id);
    expect(migrated?.workingDir).toBe(repo);
    expect(migrated?.executionDir).toBeTruthy();
    expect(migrated?.executionDir).not.toBe(repo);
    expect(fs.existsSync(migrated!.executionDir!)).toBe(true);
    expect(migrated?.checkout?.repoRoot).toBe(migrated?.checkout?.worktreeRoot);
    expect(git(migrated!.executionDir!, ['branch', '--show-current']).trim()).toBe(`ac/${first.id.slice(0, 12)}/session-2`);
    expect(migrated?.messages).toEqual([]);
    expect(migrated?.externalSessionId).toBeNull();

    const sessions = await env.chatService.getSessionHistory(first.id);
    expect(sessions).toHaveLength(2);
    expect(sessions?.[0].isCurrent).toBe(false);
    expect(sessions?.[1].isCurrent).toBe(true);
    expect(resetSpy).toHaveBeenCalledWith(first.id);
    expect(resetSpy).toHaveBeenCalledWith(second.id);
  });

  test('creates new conversations in a worktree after enablement', async () => {
    const repo = createRepoWithRemote('new-conv-repo');
    const existing = await env.chatService.createConversation('Existing', repo);
    await env.request('PUT', `/api/chat/workspaces/${existing.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });

    const created = await env.chatService.createConversation('New', repo);

    expect(created.workingDir).toBe(repo);
    expect(created.executionDir).toBeTruthy();
    expect(created.checkout?.mode).toBe('worktree');
    expect(git(created.executionDir!, ['branch', '--show-current']).trim()).toBe(`ac/${created.id.slice(0, 12)}/session-1`);
  });

  test('sends CLI turns from the conversation worktree', async () => {
    const repo = createRepoWithRemote('send-worktree-repo');
    const conv = await env.chatService.createConversation('Send', repo);
    await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });
    const isolated = await env.chatService.getConversation(conv.id);
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'ok', streaming: true },
      { type: 'done' },
    ] as any);

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(res.status).toBe(200);
    expect(env.mockBackend._lastOptions?.workingDir).toBe(isolated?.executionDir);
    expect(env.mockBackend._lastOptions?.workingDir).not.toBe(repo);
  });

  test('runs attachment OCR from the conversation worktree', async () => {
    const repo = createRepoWithRemote('ocr-worktree-repo');
    const conv = await env.chatService.createConversation('OCR', repo);
    await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });
    const isolated = await env.chatService.getConversation(conv.id);
    const attachmentDir = path.join(env.chatService.artifactsDir, conv.id);
    fs.mkdirSync(attachmentDir, { recursive: true });
    const imagePath = path.join(attachmentDir, 'scan.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    env.mockBackend.setOneShotImpl(async () => '# OCR');

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/attachments/ocr`, {
      path: imagePath,
    });

    expect(res.status).toBe(200);
    expect(env.mockBackend._oneShotCalls[0].options?.workingDir).toBe(isolated?.executionDir);
    expect(env.mockBackend._oneShotCalls[0].options?.workingDir).not.toBe(repo);
  });

  test('starts goals from the conversation worktree', async () => {
    const repo = createRepoWithRemote('goal-worktree-repo');
    const conv = await env.chatService.createConversation('Goal', repo);
    await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });
    const isolated = await env.chatService.getConversation(conv.id);
    const metadata = env.mockBackend.metadata;
    jest.spyOn(env.mockBackend, 'metadata', 'get').mockReturnValue({
      ...metadata,
      capabilities: { ...metadata.capabilities, goals: true },
    });
    let goalOptions: any = null;
    jest.spyOn(env.mockBackend, 'setGoalObjective').mockImplementation((_objective: string, options?: any) => {
      goalOptions = options;
      async function* stream() {
        yield { type: 'done' } as any;
      }
      return { stream: stream(), abort: () => {}, sendInput: () => {} };
    });

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/goal`, {
      objective: 'Ship it',
    });

    expect(res.status).toBe(200);
    expect(goalOptions?.workingDir).toBe(isolated?.executionDir);
    expect(goalOptions?.workingDir).not.toBe(repo);
  });

  test('captures backend memory from the conversation worktree', async () => {
    const repo = createRepoWithRemote('memory-worktree-repo');
    const conv = await env.chatService.createConversation('Memory', repo);
    await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });
    const isolated = await env.chatService.getConversation(conv.id);
    const extractMemory = jest.spyOn(env.mockBackend, 'extractMemory').mockResolvedValue({
      capturedAt: new Date().toISOString(),
      sourceBackend: 'claude-code',
      sourcePath: isolated!.executionDir!,
      index: '',
      files: [],
    });

    await env.chatService.captureWorkspaceMemory(conv.id, 'claude-code');

    expect(extractMemory).toHaveBeenCalledWith(isolated?.executionDir, { cliProfile: undefined });
  });

  test('serves conversation workspace files from the worktree', async () => {
    const repo = createRepoWithRemote('file-route-worktree-repo');
    const conv = await env.chatService.createConversation('File Route', repo);
    await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });
    const isolated = await env.chatService.getConversation(conv.id);
    const deliveredPath = path.join(isolated!.executionDir!, 'report.txt');
    fs.writeFileSync(deliveredPath, 'from worktree\n');

    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/workspace-file?path=${encodeURIComponent(deliveredPath)}&mode=view`);
    const outside = await env.request('GET', `/api/chat/conversations/${conv.id}/workspace-file?path=${encodeURIComponent(path.join(repo, 'tracked.txt'))}&mode=view`);

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('from worktree\n');
    expect(outside.status).toBe(403);
  });

  test('reports Git changes from the conversation worktree without dirtying the base workspace', async () => {
    const repo = createRepoWithRemote('git-route-worktree-repo');
    const conv = await env.chatService.createConversation('Git Route', repo);
    await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });
    const isolated = await env.chatService.getConversation(conv.id);
    fs.writeFileSync(path.join(isolated!.executionDir!, 'tracked.txt'), 'worktree dirty\n');

    const convStatus = await env.request('GET', `/api/chat/conversations/${conv.id}/git/status`);
    const workspaceStatus = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/git/status`);
    const diff = await env.request('GET', `/api/chat/conversations/${conv.id}/git/diff?path=${encodeURIComponent('tracked.txt')}`);

    expect(convStatus.status).toBe(200);
    expect(convStatus.body.branch).toBe(`ac/${conv.id.slice(0, 12)}/session-2`);
    expect(convStatus.body.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt', status: 'modified' }),
    ]));
    expect(workspaceStatus.status).toBe(200);
    expect(workspaceStatus.body.branch).toBe('main');
    expect(workspaceStatus.body.files).toEqual([]);
    expect(diff.status).toBe(200);
    expect(diff.body.oldContent).toBe('hello\n');
    expect(diff.body.newContent).toBe('worktree dirty\n');
  });

  test('resets session branches from the latest origin/main', async () => {
    const repo = createRepoWithRemote('reset-fetch-repo');
    const remote = path.join(env.tmpDir, 'reset-fetch-repo.git');
    const conv = await env.chatService.createConversation('Reset Fetch', repo);
    await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });
    const clone = path.join(env.tmpDir, 'reset-fetch-repo-clone');
    git(env.tmpDir, ['clone', remote, clone]);
    git(clone, ['config', 'user.email', 'test@example.com']);
    git(clone, ['config', 'user.name', 'Test User']);
    git(clone, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(clone, 'tracked.txt'), 'from remote\n');
    git(clone, ['add', '.']);
    git(clone, ['commit', '-m', 'remote update']);
    git(clone, ['push', 'origin', 'main']);
    expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('hello\n');

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/reset`, {});

    expect(res.status).toBe(200);
    const reset = await env.chatService.getConversation(conv.id);
    expect(git(reset!.executionDir!, ['branch', '--show-current']).trim()).toBe(`ac/${conv.id.slice(0, 12)}/session-3`);
    expect(fs.readFileSync(path.join(reset!.executionDir!, 'tracked.txt'), 'utf8')).toBe('from remote\n');
    expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('hello\n');
  });

  test('blocks session reset when the conversation worktree is dirty', async () => {
    const repo = createRepoWithRemote('dirty-reset-repo');
    const conv = await env.chatService.createConversation('Dirty Reset', repo);
    await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });
    const isolated = await env.chatService.getConversation(conv.id);
    fs.writeFileSync(path.join(isolated!.executionDir!, 'tracked.txt'), 'dirty\n');

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/reset`, {});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_dirty');
    const stillIsolated = await env.chatService.getConversation(conv.id);
    expect(git(stillIsolated!.executionDir!, ['branch', '--show-current']).trim()).toBe(`ac/${conv.id.slice(0, 12)}/session-2`);
  });

  test('blocks conversation deletion when the conversation worktree is dirty', async () => {
    const repo = createRepoWithRemote('dirty-delete-repo');
    const conv = await env.chatService.createConversation('Dirty Delete', repo);
    await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });
    const isolated = await env.chatService.getConversation(conv.id);
    fs.writeFileSync(path.join(isolated!.executionDir!, 'tracked.txt'), 'dirty\n');

    const res = await env.request('DELETE', `/api/chat/conversations/${conv.id}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_dirty');
    expect(await env.chatService.getConversation(conv.id)).toBeTruthy();
    expect(fs.existsSync(isolated!.checkout!.worktreeRoot!)).toBe(true);
  });

  test('uses the matching subdirectory inside the conversation worktree', async () => {
    const repo = path.join(env.tmpDir, 'nested-repo');
    const remote = path.join(env.tmpDir, 'nested-repo.git');
    const workspace = path.join(repo, 'packages', 'app');
    fs.mkdirSync(workspace, { recursive: true });
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test User']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'nested\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial']);
    git(env.tmpDir, ['init', '--bare', remote]);
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);
    const conv = await env.chatService.createConversation('Nested', workspace);

    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });

    expect(res.status).toBe(200);
    const migrated = await env.chatService.getConversation(conv.id);
    expect(migrated?.workingDir).toBe(workspace);
    expect(migrated?.checkout?.workspaceRelPath).toBe('packages/app');
    expect(migrated?.executionDir).toBe(path.join(migrated!.checkout!.worktreeRoot!, 'packages', 'app'));
    expect(fs.existsSync(path.join(migrated!.executionDir!, 'tracked.txt'))).toBe(true);

    fs.writeFileSync(path.join(migrated!.executionDir!, 'tracked.txt'), 'nested dirty\n');
    fs.writeFileSync(path.join(migrated!.checkout!.worktreeRoot!, 'outside.txt'), 'outside\n');
    const status = await env.request('GET', `/api/chat/conversations/${conv.id}/git/status`);
    expect(status.status).toBe(200);
    expect(status.body.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt', status: 'modified' }),
    ]));
    expect(status.body.files.some((file: any) => file.path === 'outside.txt')).toBe(false);
  });

  test('blocks disablement when a conversation worktree is dirty', async () => {
    const repo = createRepoWithRemote('dirty-disable-repo');
    const conv = await env.chatService.createConversation('Dirty', repo);
    const second = await env.chatService.createConversation('Also Dirty', repo);
    await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });
    const migrated = await env.chatService.getConversation(conv.id);
    const migratedSecond = await env.chatService.getConversation(second.id);
    fs.writeFileSync(path.join(migrated!.executionDir!, 'tracked.txt'), 'dirty\n');
    fs.writeFileSync(path.join(migratedSecond!.executionDir!, 'tracked.txt'), 'also dirty\n');

    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: false,
      confirmedSessionReset: true,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worktree_dirty');
    expect(res.body.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: conv.id, code: 'worktree_dirty' }),
      expect.objectContaining({ conversationId: second.id, code: 'worktree_dirty' }),
    ]));
  });

  test('disables worktree isolation by removing clean worktrees and keeping conversations', async () => {
    const repo = createRepoWithRemote('disable-repo');
    const conv = await env.chatService.createConversation('Disable', repo);
    await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: true,
      confirmedSessionReset: true,
    });
    const isolated = await env.chatService.getConversation(conv.id);
    const worktreeRoot = isolated!.checkout!.worktreeRoot!;
    expect(fs.existsSync(worktreeRoot)).toBe(true);

    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/worktree-isolation`, {
      enabled: false,
      confirmedSessionReset: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(fs.existsSync(worktreeRoot)).toBe(false);
    const shared = await env.chatService.getConversation(conv.id);
    expect(shared?.checkout).toBeUndefined();
    expect(shared?.executionDir).toBeUndefined();
    expect(shared?.workingDir).toBe(repo);
    const sessions = await env.chatService.getSessionHistory(conv.id);
    expect(sessions).toHaveLength(3);
    expect(sessions?.[2].isCurrent).toBe(true);
  });
});
