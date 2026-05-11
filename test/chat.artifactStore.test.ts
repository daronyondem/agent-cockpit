import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ArtifactStore } from '../src/services/chat/artifactStore';

describe('ArtifactStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ac-artifacts-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('stores base64 artifacts under the conversation directory', async () => {
    const store = new ArtifactStore({ artifactsDir: dir, hasConversation: (id) => id === 'conv-1' });

    const artifact = await store.createConversationArtifact('conv-1', {
      dataBase64: Buffer.from('hello').toString('base64'),
      filename: 'bad name',
      mimeType: 'text/plain',
      title: 'Greeting',
      sourceToolId: 'tool-1',
    });

    expect(artifact).toMatchObject({
      filename: 'bad name.txt',
      kind: 'text',
      size: 5,
      mimeType: 'text/plain',
      title: 'Greeting',
      sourceToolId: 'tool-1',
    });
    expect(await fsp.readFile(artifact!.path, 'utf8')).toBe('hello');
  });

  test('returns null for unknown conversations and avoids filename collisions', async () => {
    const source = path.join(dir, 'source.md');
    await fsp.writeFile(source, '# note', 'utf8');
    const store = new ArtifactStore({ artifactsDir: dir, hasConversation: (id) => id === 'conv-1' });

    expect(await store.createConversationArtifact('missing', { sourcePath: source })).toBeNull();

    const first = await store.createConversationArtifact('conv-1', { sourcePath: source, filename: 'note.md' });
    const second = await store.createConversationArtifact('conv-1', { sourcePath: source, filename: 'note.md' });

    expect(first?.filename).toBe('note.md');
    expect(second?.filename).toBe('note-1.md');
  });
});
