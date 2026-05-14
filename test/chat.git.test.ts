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

async function createRepo(name: string): Promise<{ wsDir: string; hash: string }> {
  const wsDir = path.join(env.tmpDir, name);
  fs.mkdirSync(wsDir, { recursive: true });
  git(wsDir, ['init']);
  git(wsDir, ['config', 'user.email', 'test@example.com']);
  git(wsDir, ['config', 'user.name', 'Test User']);
  git(wsDir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(wsDir, 'tracked.txt'), 'before\n');
  fs.writeFileSync(path.join(wsDir, 'deleted.txt'), 'delete me\n');
  fs.writeFileSync(path.join(wsDir, 'old.txt'), 'rename me\n');
  git(wsDir, ['add', '.']);
  git(wsDir, ['commit', '-m', 'initial']);
  const conv = await env.chatService.createConversation('Test', wsDir);
  return { wsDir, hash: conv.workspaceHash };
}

describe('GET /api/chat/workspaces/:hash/git/status', () => {
  test('lists uncommitted files for a workspace git repository', async () => {
    const { wsDir, hash } = await createRepo('git-status');
    fs.writeFileSync(path.join(wsDir, 'tracked.txt'), 'after\n');
    fs.unlinkSync(path.join(wsDir, 'deleted.txt'));
    git(wsDir, ['mv', 'old.txt', 'renamed.txt']);
    fs.writeFileSync(path.join(wsDir, 'untracked.txt'), 'new\n');

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/git/status`);

    expect(res.status).toBe(200);
    expect(res.body.isGitRepo).toBe(true);
    const byPath = new Map<string, any>(res.body.files.map((file: any) => [file.path, file]));
    expect(byPath.get('tracked.txt')?.status).toBe('modified');
    expect(byPath.get('deleted.txt')?.status).toBe('deleted');
    expect(byPath.get('renamed.txt')?.status).toBe('renamed');
    expect(byPath.get('renamed.txt')?.oldPath).toBe('old.txt');
    expect(byPath.get('untracked.txt')?.status).toBe('untracked');
  });

  test('returns an empty non-repo response for a plain workspace directory', async () => {
    const wsDir = path.join(env.tmpDir, 'not-git');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);

    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/git/status`);

    expect(res.status).toBe(200);
    expect(res.body.isGitRepo).toBe(false);
    expect(res.body.files).toEqual([]);
  });

  test('detects Git status for a workspace nested inside a repository', async () => {
    const wsDir = path.join(env.tmpDir, 'git-status-nested');
    const subDir = path.join(wsDir, 'packages', 'app');
    fs.mkdirSync(subDir, { recursive: true });
    git(wsDir, ['init']);
    git(wsDir, ['config', 'user.email', 'test@example.com']);
    git(wsDir, ['config', 'user.name', 'Test User']);
    git(wsDir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(subDir, 'tracked.txt'), 'before\n');
    fs.writeFileSync(path.join(wsDir, 'outside.txt'), 'before\n');
    git(wsDir, ['add', '.']);
    git(wsDir, ['commit', '-m', 'initial']);
    fs.writeFileSync(path.join(subDir, 'tracked.txt'), 'after\n');
    fs.writeFileSync(path.join(wsDir, 'outside.txt'), 'after\n');
    const conv = await env.chatService.createConversation('Nested', subDir);

    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/git/status`);

    expect(res.status).toBe(200);
    expect(res.body.isGitRepo).toBe(true);
    expect(res.body.root).toBe(fs.realpathSync(subDir));
    expect(res.body.repoRoot).toBe(fs.realpathSync(wsDir));
    expect(res.body.files).toEqual([
      expect.objectContaining({ path: 'tracked.txt', status: 'modified' }),
    ]);
  });

  test('returns 404 for an unknown workspace', async () => {
    const res = await env.request('GET', '/api/chat/workspaces/not-a-workspace/git/status');

    expect(res.status).toBe(404);
  });
});

describe('GET /api/chat/workspaces/:hash/git/diff', () => {
  test('returns HEAD and working-tree content for a modified file', async () => {
    const { wsDir, hash } = await createRepo('git-diff-modified');
    fs.writeFileSync(path.join(wsDir, 'tracked.txt'), 'after\n');

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/git/diff?path=${encodeURIComponent('tracked.txt')}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('modified');
    expect(res.body.oldContent).toBe('before\n');
    expect(res.body.newContent).toBe('after\n');
    expect(res.body.oldMissing).toBe(false);
    expect(res.body.newMissing).toBe(false);
  });

  test('returns empty old content for an untracked file', async () => {
    const { wsDir, hash } = await createRepo('git-diff-untracked');
    fs.writeFileSync(path.join(wsDir, 'notes.md'), '# Notes\n');

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/git/diff?path=${encodeURIComponent('notes.md')}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('untracked');
    expect(res.body.oldContent).toBe('');
    expect(res.body.newContent).toBe('# Notes\n');
    expect(res.body.oldMissing).toBe(true);
  });

  test('returns empty new content for a deleted file', async () => {
    const { wsDir, hash } = await createRepo('git-diff-deleted');
    fs.unlinkSync(path.join(wsDir, 'deleted.txt'));

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/git/diff?path=${encodeURIComponent('deleted.txt')}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('deleted');
    expect(res.body.oldContent).toBe('delete me\n');
    expect(res.body.newContent).toBe('');
    expect(res.body.newMissing).toBe(true);
  });

  test('rejects path traversal before reading diff content', async () => {
    const { hash } = await createRepo('git-diff-traversal');

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/git/diff?path=${encodeURIComponent('../outside.txt')}`);

    expect(res.status).toBe(403);
  });

  test('diffs a changed file relative to a nested workspace', async () => {
    const wsDir = path.join(env.tmpDir, 'git-diff-nested');
    const subDir = path.join(wsDir, 'packages', 'app');
    fs.mkdirSync(subDir, { recursive: true });
    git(wsDir, ['init']);
    git(wsDir, ['config', 'user.email', 'test@example.com']);
    git(wsDir, ['config', 'user.name', 'Test User']);
    git(wsDir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(subDir, 'tracked.txt'), 'before\n');
    git(wsDir, ['add', '.']);
    git(wsDir, ['commit', '-m', 'initial']);
    fs.writeFileSync(path.join(subDir, 'tracked.txt'), 'after\n');
    const conv = await env.chatService.createConversation('Nested', subDir);

    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/git/diff?path=${encodeURIComponent('tracked.txt')}`);

    expect(res.status).toBe(200);
    expect(res.body.path).toBe('tracked.txt');
    expect(res.body.oldContent).toBe('before\n');
    expect(res.body.newContent).toBe('after\n');
  });
});
