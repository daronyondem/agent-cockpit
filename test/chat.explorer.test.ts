/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';

let env: ChatRouterEnv;

beforeEach(async () => { env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); });

describe('GET /api/chat/workspaces/:hash/files', () => {
  test('downloads a file from workspace directory', async () => {
    const wsDir = path.join(env.tmpDir, 'ws-file-dl');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'report.csv'), 'a,b,c\n1,2,3\n');

    const conv = await env.chatService.createConversation('Test', wsDir);
    const hash = conv.workspaceHash;

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/files?path=${encodeURIComponent(path.join(wsDir, 'report.csv'))}&mode=download`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('report.csv');
  });

  test('views a file as JSON', async () => {
    const wsDir = path.join(env.tmpDir, 'ws-file-view');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'data.json'), '{"hello":"world"}');

    const conv = await env.chatService.createConversation('Test', wsDir);
    const hash = conv.workspaceHash;

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/files?path=${encodeURIComponent(path.join(wsDir, 'data.json'))}&mode=view`);
    expect(res.status).toBe(200);
    expect(res.body.filename).toBe('data.json');
    expect(res.body.content).toBe('{"hello":"world"}');
    expect(res.body.language).toBe('json');
  });

  test('rejects path traversal', async () => {
    const wsDir = path.join(env.tmpDir, 'ws-file-traversal');
    fs.mkdirSync(wsDir, { recursive: true });

    const conv = await env.chatService.createConversation('Test', wsDir);
    const hash = conv.workspaceHash;

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/files?path=${encodeURIComponent('/etc/passwd')}`);
    expect(res.status).toBe(403);
  });

  test('returns 400 when path is missing', async () => {
    const wsDir = path.join(env.tmpDir, 'ws-file-noparam');
    fs.mkdirSync(wsDir, { recursive: true });

    const conv = await env.chatService.createConversation('Test', wsDir);
    const hash = conv.workspaceHash;

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/files`);
    expect(res.status).toBe(400);
  });

  test('returns 404 for nonexistent file', async () => {
    const wsDir = path.join(env.tmpDir, 'ws-file-missing');
    fs.mkdirSync(wsDir, { recursive: true });

    const conv = await env.chatService.createConversation('Test', wsDir);
    const hash = conv.workspaceHash;

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/files?path=${encodeURIComponent(path.join(wsDir, 'nope.txt'))}`);
    expect(res.status).toBe(404);
  });

  test('returns 404 for unknown workspace', async () => {
    const res = await env.request('GET', `/api/chat/workspaces/0000000000000000/files?path=/tmp/foo`);
    expect(res.status).toBe(404);
  });
});

// ── Workspace file explorer ─────────────────────────────────────────────────

describe('GET /api/chat/workspaces/:hash/explorer/tree', () => {
  test('lists root contents, hidden files included, dirs before files, alphabetical', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-tree-root');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'beta.txt'), 'hi');
    fs.writeFileSync(path.join(wsDir, 'alpha.md'), '# a');
    fs.writeFileSync(path.join(wsDir, '.hidden'), 'x');
    fs.mkdirSync(path.join(wsDir, 'src'));
    fs.mkdirSync(path.join(wsDir, '.cache'));

    const conv = await env.chatService.createConversation('Test', wsDir);
    const hash = conv.workspaceHash;
    const res = await env.request('GET', `/api/chat/workspaces/${hash}/explorer/tree`);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('');
    expect(res.body.parent).toBeNull();
    const names = res.body.entries.map((e: any) => e.name);
    expect(names).toEqual(['.cache', 'src', '.hidden', 'alpha.md', 'beta.txt']);
    const types = res.body.entries.map((e: any) => e.type);
    expect(types).toEqual(['dir', 'dir', 'file', 'file', 'file']);
  });

  test('lists a nested folder and returns parent relative to root', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-tree-nested');
    fs.mkdirSync(path.join(wsDir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'a', 'b', 'f.txt'), 'x');

    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/explorer/tree?path=${encodeURIComponent('a/b')}`);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('a/b');
    expect(res.body.parent).toBe('a');
    expect(res.body.entries.map((e: any) => e.name)).toEqual(['f.txt']);
  });

  test('rejects path traversal', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-tree-trav');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/explorer/tree?path=${encodeURIComponent('../etc')}`);
    expect(res.status).toBe(403);
  });

  test('strips leading slash so absolute-looking paths are treated as relative', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-tree-abs');
    fs.mkdirSync(path.join(wsDir, 'etc'), { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    // `/etc` → `etc` (inside workspace)
    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/explorer/tree?path=${encodeURIComponent('/etc')}`);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('etc');
  });

  test('returns 404 for missing folder', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-tree-404');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/explorer/tree?path=${encodeURIComponent('nope')}`);
    expect(res.status).toBe(404);
  });

  test('returns 400 when path points at a file', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-tree-isfile');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'a.txt'), 'x');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/explorer/tree?path=${encodeURIComponent('a.txt')}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/chat/workspaces/:hash/explorer/preview', () => {
  test('view mode returns JSON content with language and mimeType', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-prev-view');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'data.json'), '{"a":1}');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/explorer/preview?path=${encodeURIComponent('data.json')}&mode=view`);
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('{"a":1}');
    expect(res.body.language).toBe('json');
    expect(res.body.mimeType).toBe('application/json');
  });

  test('view mode 413 when file is over 5 MB', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-prev-big');
    fs.mkdirSync(wsDir, { recursive: true });
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 'a');
    fs.writeFileSync(path.join(wsDir, 'big.txt'), big);
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/explorer/preview?path=${encodeURIComponent('big.txt')}&mode=view`);
    expect(res.status).toBe(413);
  });

  test('download mode sets Content-Disposition', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-prev-dl');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'report.csv'), 'a,b\n1,2\n');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/explorer/preview?path=${encodeURIComponent('report.csv')}&mode=download`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('report.csv');
  });

  test('raw mode streams with inferred mime type', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-prev-raw');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'icon.svg'), '<svg/>');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/explorer/preview?path=${encodeURIComponent('icon.svg')}&mode=raw`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
  });

  test('rejects path traversal', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-prev-trav');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/explorer/preview?path=${encodeURIComponent('../../etc/passwd')}&mode=view`);
    expect(res.status).toBe(403);
  });

  test('400 when path missing', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-prev-noparam');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('GET', `/api/chat/workspaces/${conv.workspaceHash}/explorer/preview`);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/chat/workspaces/:hash/explorer/upload', () => {
  test('uploads a file to the workspace root', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-up-root');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.multipartRequest(
      'POST',
      `/api/chat/workspaces/${conv.workspaceHash}/explorer/upload?path=`,
      'file',
      'hello.txt',
      'text/plain',
      Buffer.from('world'),
    );
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('hello.txt');
    expect(res.body.size).toBe(5);
    expect(fs.readFileSync(path.join(wsDir, 'hello.txt'), 'utf8')).toBe('world');
  });

  test('uploads into a nested folder', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-up-nested');
    fs.mkdirSync(path.join(wsDir, 'sub'), { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.multipartRequest(
      'POST',
      `/api/chat/workspaces/${conv.workspaceHash}/explorer/upload?path=sub`,
      'file',
      'x.txt',
      'text/plain',
      Buffer.from('inside'),
    );
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(wsDir, 'sub', 'x.txt'), 'utf8')).toBe('inside');
  });

  test('409 on conflict without overwrite, does not replace existing', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-up-conflict');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'dup.txt'), 'original');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.multipartRequest(
      'POST',
      `/api/chat/workspaces/${conv.workspaceHash}/explorer/upload?path=`,
      'file',
      'dup.txt',
      'text/plain',
      Buffer.from('replacement'),
    );
    expect(res.status).toBe(409);
    expect(res.body.conflict).toBe(true);
    expect(fs.readFileSync(path.join(wsDir, 'dup.txt'), 'utf8')).toBe('original');
  });

  test('overwrite=true replaces existing file', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-up-over');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'dup.txt'), 'original');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.multipartRequest(
      'POST',
      `/api/chat/workspaces/${conv.workspaceHash}/explorer/upload?path=&overwrite=true`,
      'file',
      'dup.txt',
      'text/plain',
      Buffer.from('replacement'),
    );
    expect(res.status).toBe(200);
    expect(res.body.overwrote).toBe(true);
    expect(fs.readFileSync(path.join(wsDir, 'dup.txt'), 'utf8')).toBe('replacement');
  });

  test('rejects upload to path outside workspace', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-up-trav');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.multipartRequest(
      'POST',
      `/api/chat/workspaces/${conv.workspaceHash}/explorer/upload?path=${encodeURIComponent('../')}`,
      'file',
      'oops.txt',
      'text/plain',
      Buffer.from('x'),
    );
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/chat/workspaces/:hash/explorer/rename', () => {
  test('renames a file', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-ren-file');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'a.txt'), 'x');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('PATCH', `/api/chat/workspaces/${conv.workspaceHash}/explorer/rename`, { from: 'a.txt', to: 'b.txt' });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(wsDir, 'a.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(wsDir, 'b.txt'), 'utf8')).toBe('x');
  });

  test('renames a directory', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-ren-dir');
    fs.mkdirSync(path.join(wsDir, 'old', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'old', 'nested', 'f'), 'y');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('PATCH', `/api/chat/workspaces/${conv.workspaceHash}/explorer/rename`, { from: 'old', to: 'renamed' });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(wsDir, 'renamed', 'nested', 'f'), 'utf8')).toBe('y');
  });

  test('409 when destination exists without overwrite', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-ren-conflict');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(wsDir, 'b.txt'), 'b');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('PATCH', `/api/chat/workspaces/${conv.workspaceHash}/explorer/rename`, { from: 'a.txt', to: 'b.txt' });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(path.join(wsDir, 'b.txt'), 'utf8')).toBe('b');
  });

  test('overwrite=true replaces existing destination', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-ren-over');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(wsDir, 'b.txt'), 'b');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('PATCH', `/api/chat/workspaces/${conv.workspaceHash}/explorer/rename`, { from: 'a.txt', to: 'b.txt', overwrite: true });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(wsDir, 'a.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(wsDir, 'b.txt'), 'utf8')).toBe('a');
  });

  test('rejects rename of workspace root', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-ren-root');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('PATCH', `/api/chat/workspaces/${conv.workspaceHash}/explorer/rename`, { from: '', to: 'oops' });
    expect(res.status).toBe(400);
  });

  test('rejects path traversal in from', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-ren-trav');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('PATCH', `/api/chat/workspaces/${conv.workspaceHash}/explorer/rename`, { from: '../etc/passwd', to: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/chat/workspaces/:hash/explorer/entry', () => {
  test('deletes a file', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-del-file');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'gone.txt'), 'x');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('DELETE', `/api/chat/workspaces/${conv.workspaceHash}/explorer/entry?path=${encodeURIComponent('gone.txt')}`);
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(wsDir, 'gone.txt'))).toBe(false);
  });

  test('recursively deletes a directory', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-del-dir');
    fs.mkdirSync(path.join(wsDir, 'out', 'in'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'out', 'in', 'f'), 'y');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('DELETE', `/api/chat/workspaces/${conv.workspaceHash}/explorer/entry?path=${encodeURIComponent('out')}`);
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(wsDir, 'out'))).toBe(false);
  });

  test('refuses to delete workspace root', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-del-root');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'keep.txt'), 'x');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('DELETE', `/api/chat/workspaces/${conv.workspaceHash}/explorer/entry?path=`);
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(wsDir, 'keep.txt'))).toBe(true);
  });

  test('rejects path traversal', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-del-trav');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('DELETE', `/api/chat/workspaces/${conv.workspaceHash}/explorer/entry?path=${encodeURIComponent('../outside')}`);
    expect(res.status).toBe(403);
  });

  test('returns 404 for non-existent path', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-del-missing');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('DELETE', `/api/chat/workspaces/${conv.workspaceHash}/explorer/entry?path=${encodeURIComponent('nope')}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/chat/workspaces/:hash/explorer/mkdir', () => {
  test('creates a folder inside the workspace root', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-mkdir-root');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/mkdir`, { parent: '', name: 'new-folder' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toBe('new-folder');
    expect(fs.statSync(path.join(wsDir, 'new-folder')).isDirectory()).toBe(true);
  });

  test('creates a folder inside a nested parent', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-mkdir-nested');
    fs.mkdirSync(path.join(wsDir, 'sub'), { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/mkdir`, { parent: 'sub', name: 'child' });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(path.join('sub', 'child'));
    expect(fs.statSync(path.join(wsDir, 'sub', 'child')).isDirectory()).toBe(true);
  });

  test('returns 409 when a folder or file with that name exists', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-mkdir-conflict');
    fs.mkdirSync(path.join(wsDir, 'dup'), { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/mkdir`, { parent: '', name: 'dup' });
    expect(res.status).toBe(409);
  });

  test('rejects names containing slashes', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-mkdir-slash');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/mkdir`, { parent: '', name: 'a/b' });
    expect(res.status).toBe(400);
  });

  test('rejects empty or whitespace-only names', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-mkdir-empty');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/mkdir`, { parent: '', name: '   ' });
    expect(res.status).toBe(400);
  });

  test('rejects path traversal in parent', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-mkdir-trav');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/mkdir`, { parent: '../outside', name: 'x' });
    expect(res.status).toBe(403);
  });

  test('returns 404 when the parent folder does not exist', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-mkdir-missing');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/mkdir`, { parent: 'no-such', name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/chat/workspaces/:hash/explorer/file', () => {
  test('overwrites a text file and returns new size', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-save');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'notes.txt'), 'original');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const next = 'updated contents, longer than before';
    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { path: 'notes.txt', content: next });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.size).toBe(Buffer.byteLength(next, 'utf8'));
    expect(fs.readFileSync(path.join(wsDir, 'notes.txt'), 'utf8')).toBe(next);
  });

  test('saves into a nested file', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-save-nested');
    fs.mkdirSync(path.join(wsDir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'a', 'b', 'n.md'), '# Old');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { path: 'a/b/n.md', content: '# New' });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(wsDir, 'a', 'b', 'n.md'), 'utf8')).toBe('# New');
  });

  test('allows writing an empty string to truncate a file', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-save-empty');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'e.txt'), 'non-empty');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { path: 'e.txt', content: '' });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(wsDir, 'e.txt'), 'utf8')).toBe('');
  });

  test('rejects non-string content', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-save-bad-content');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'x.txt'), 'hi');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { path: 'x.txt', content: 42 });
    expect(res.status).toBe(400);
  });

  test('returns 413 when content exceeds the 5 MB edit limit', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-save-big');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'big.txt'), 'seed');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const huge = 'x'.repeat(5 * 1024 * 1024 + 1);
    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { path: 'big.txt', content: huge });
    expect(res.status).toBe(413);
    expect(fs.readFileSync(path.join(wsDir, 'big.txt'), 'utf8')).toBe('seed');
  });

  test('returns 404 when the file does not exist', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-save-missing');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { path: 'nope.txt', content: 'hi' });
    expect(res.status).toBe(404);
  });

  test('returns 400 when the path is a directory', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-save-dir');
    fs.mkdirSync(path.join(wsDir, 'subdir'), { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { path: 'subdir', content: 'hi' });
    expect(res.status).toBe(400);
  });

  test('refuses to overwrite the workspace root', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-save-root');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { path: '/', content: 'hi' });
    // Leading slash is stripped → '' → resolves to root → 400 "must be a file"
    expect(res.status).toBe(400);
  });

  test('rejects path traversal', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-save-trav');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { path: '../escape.txt', content: 'hi' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/chat/workspaces/:hash/explorer/file', () => {
  test('creates an empty file at the workspace root', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-newfile-root');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { parent: '', name: 'untitled.md' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toBe('untitled.md');
    expect(res.body.size).toBe(0);
    expect(fs.statSync(path.join(wsDir, 'untitled.md')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(wsDir, 'untitled.md'), 'utf8')).toBe('');
  });

  test('creates a file inside a nested parent', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-newfile-nested');
    fs.mkdirSync(path.join(wsDir, 'docs'), { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { parent: 'docs', name: 'plan.md' });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(path.join('docs', 'plan.md'));
    expect(fs.statSync(path.join(wsDir, 'docs', 'plan.md')).isFile()).toBe(true);
  });

  test('accepts optional seed content', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-newfile-seed');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { parent: '', name: 'hello.txt', content: 'hi!' });
    expect(res.status).toBe(200);
    expect(res.body.size).toBe(3);
    expect(fs.readFileSync(path.join(wsDir, 'hello.txt'), 'utf8')).toBe('hi!');
  });

  test('returns 409 when a file with that name already exists', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-newfile-conflict-file');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'dup.md'), 'existing');
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { parent: '', name: 'dup.md' });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(path.join(wsDir, 'dup.md'), 'utf8')).toBe('existing');
  });

  test('returns 409 when a folder with that name already exists', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-newfile-conflict-dir');
    fs.mkdirSync(path.join(wsDir, 'dup'), { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { parent: '', name: 'dup' });
    expect(res.status).toBe(409);
  });

  test('rejects names containing slashes', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-newfile-slash');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { parent: '', name: 'a/b.md' });
    expect(res.status).toBe(400);
  });

  test('rejects empty names', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-newfile-empty');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { parent: '', name: '   ' });
    expect(res.status).toBe(400);
  });

  test('rejects path traversal in parent', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-newfile-trav');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { parent: '../outside', name: 'x.md' });
    expect(res.status).toBe(403);
  });

  test('returns 404 when parent folder does not exist', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-newfile-missing');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { parent: 'no-such', name: 'x.md' });
    expect(res.status).toBe(404);
  });

  test('returns 413 when seed content exceeds the 5 MB edit limit', async () => {
    const wsDir = path.join(env.tmpDir, 'fe-newfile-big');
    fs.mkdirSync(wsDir, { recursive: true });
    const conv = await env.chatService.createConversation('Test', wsDir);
    const huge = 'x'.repeat(5 * 1024 * 1024 + 1);
    const res = await env.request('POST', `/api/chat/workspaces/${conv.workspaceHash}/explorer/file`, { parent: '', name: 'big.txt', content: huge });
    expect(res.status).toBe(413);
    expect(fs.existsSync(path.join(wsDir, 'big.txt'))).toBe(false);
  });
});
