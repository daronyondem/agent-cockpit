import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { resolveConversationAttachments } from '../src/services/chat/attachments';

test('upload references use server file metadata and reject missing, nested, cross-conversation and symlink files', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-upload-resolution-'));
  const root = path.join(data, 'conversation'), other = path.join(data, 'other.png');
  try {
    await fs.mkdir(root); await fs.writeFile(path.join(root, 'image.png'), 'bytes'); await fs.writeFile(other, 'private');
    await fs.mkdir(path.join(root, 'nested')); await fs.writeFile(path.join(root, 'nested', 'image.png'), 'nested');
    expect(await resolveConversationAttachments(root, [])).toEqual([]);
    expect(await resolveConversationAttachments(root, [{ name: 'image.png' }])).toEqual([
      { name: 'image.png', path: await fs.realpath(path.join(root, 'image.png')), kind: 'image', size: 5, meta: '5 B' },
    ]);
    for (const name of ['missing.png', '../other.png', 'nested', 'nested/image.png', '.']) {
      await expect(resolveConversationAttachments(root, [{ name }])).rejects.toThrow('outside this conversation or unavailable');
    }
    if (process.platform !== 'win32') {
      await fs.symlink(other, path.join(root, 'other-link.png'));
      await fs.symlink(path.join(root, 'image.png'), path.join(root, 'same-link.png'));
      for (const name of ['other-link.png', 'same-link.png']) await expect(resolveConversationAttachments(root, [{ name }])).rejects.toThrow('unavailable');
      await fs.symlink(root, path.join(data, 'root-link'));
      await expect(resolveConversationAttachments(path.join(data, 'root-link'), [{ name: 'image.png' }])).rejects.toThrow('unavailable');
    }
  } finally { await fs.rm(data, { recursive: true, force: true }); }
});
