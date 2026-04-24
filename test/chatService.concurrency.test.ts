/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { ChatService } from '../src/services/chatService';
import { workspaceHash } from './helpers/workspace';

// Regression guard for the Apr 2026 prod incident where two concurrent
// fsp.writeFile('w') calls on the same workspace index.json produced a
// byte-interleaved file (smaller writer's full body + larger writer's
// tail), which then failed JSON.parse and crashed the server on restart.
//
// With atomicWriteFile (tmp + rename) every write leaves exactly one
// valid payload on disk, and with the per-hash KeyedMutex each RMW reads
// the last committed state, so no updates are lost.

const DEFAULT_WORKSPACE = '/tmp/test-workspace-concurrency';
const WORKSPACE = '/tmp/test-concurrent-ws';

let tmpDir: string;
let service: ChatService;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatservice-concurrency-'));
  service = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
  await service.initialize();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function readIndex(): Promise<any> {
  const hash = workspaceHash(WORKSPACE);
  const p = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
  return JSON.parse(await fsp.readFile(p, 'utf8'));
}

describe('ChatService concurrency', () => {
  test('many concurrent createConversation calls produce a parseable index with every conversation', async () => {
    const N = 30;
    const ops = Array.from({ length: N }, (_, i) =>
      service.createConversation(`Chat ${i}`, WORKSPACE),
    );
    const created = await Promise.all(ops);

    const index = await readIndex();
    expect(index.conversations).toHaveLength(N);
    const storedIds = new Set(index.conversations.map((c: any) => c.id));
    for (const conv of created) {
      expect(storedIds.has(conv.id)).toBe(true);
    }
  });

  test('concurrent renames on distinct conversations in one workspace all persist', async () => {
    const N = 20;
    const convs = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        service.createConversation(`Initial ${i}`, WORKSPACE),
      ),
    );

    await Promise.all(
      convs.map((c, i) => service.renameConversation(c.id, `Renamed ${i}`)),
    );

    const index = await readIndex();
    const titlesById = new Map<string, string>(
      index.conversations.map((c: any) => [c.id, c.title]),
    );
    convs.forEach((c, i) => {
      expect(titlesById.get(c.id)).toBe(`Renamed ${i}`);
    });
  });

  test('interleaved creates + renames on the same workspace converge with no lost updates', async () => {
    // Seed one conversation we will continuously rename while new ones get
    // created alongside. A RMW race would either corrupt the file or drop
    // one of the two update streams.
    const seed = await service.createConversation('seed', WORKSPACE);

    const CREATE_N = 15;
    const RENAME_N = 15;
    const createOps = Array.from({ length: CREATE_N }, (_, i) =>
      service.createConversation(`new-${i}`, WORKSPACE),
    );
    const renameOps = Array.from({ length: RENAME_N }, (_, i) =>
      service.renameConversation(seed.id, `seed-v${i}`),
    );

    await Promise.all([...createOps, ...renameOps]);

    const index = await readIndex();
    expect(index.conversations).toHaveLength(CREATE_N + 1);
    const seedEntry = index.conversations.find((c: any) => c.id === seed.id);
    expect(seedEntry).toBeDefined();
    // Some rename won — and because renames serialize, it must be one of
    // the values we issued (not a torn mix).
    expect(seedEntry!.title).toMatch(/^seed-v\d+$/);
  });

  test('different workspaces run concurrently without cross-contamination', async () => {
    const WS_A = '/tmp/test-concurrent-ws-a';
    const WS_B = '/tmp/test-concurrent-ws-b';
    const N = 15;

    await Promise.all([
      ...Array.from({ length: N }, (_, i) => service.createConversation(`A${i}`, WS_A)),
      ...Array.from({ length: N }, (_, i) => service.createConversation(`B${i}`, WS_B)),
    ]);

    const hashA = workspaceHash(WS_A);
    const hashB = workspaceHash(WS_B);
    const idxA = JSON.parse(await fsp.readFile(
      path.join(tmpDir, 'data', 'chat', 'workspaces', hashA, 'index.json'), 'utf8'));
    const idxB = JSON.parse(await fsp.readFile(
      path.join(tmpDir, 'data', 'chat', 'workspaces', hashB, 'index.json'), 'utf8'));
    expect(idxA.conversations).toHaveLength(N);
    expect(idxB.conversations).toHaveLength(N);
    expect(idxA.conversations.every((c: any) => c.title.startsWith('A'))).toBe(true);
    expect(idxB.conversations.every((c: any) => c.title.startsWith('B'))).toBe(true);
  });

  test('parallel reads during writes never observe a torn index', async () => {
    const seed = await service.createConversation('seed', WORKSPACE);
    const hash = workspaceHash(WORKSPACE);
    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');

    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      writes.push(service.renameConversation(seed.id, `title-${i}`));
    }
    const reads: Promise<string>[] = [];
    for (let i = 0; i < 100; i++) {
      reads.push(fsp.readFile(indexPath, 'utf8'));
    }

    const readResults = (await Promise.all([...writes, ...reads])).slice(writes.length) as string[];
    for (const raw of readResults) {
      // Must parse cleanly — no partial/torn JSON ever visible to a reader.
      const parsed = JSON.parse(raw);
      expect(parsed.conversations).toHaveLength(1);
      expect(parsed.conversations[0].id).toBe(seed.id);
    }
  });
});
