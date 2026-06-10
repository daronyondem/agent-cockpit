import fs from 'fs';
import os from 'os';
import path from 'path';
import { ACTIVE_STREAM_JOB_STATES, StreamJobRegistry } from '../src/services/streamJobRegistry';
import type { DurableStreamJob, StreamJobFile, StreamJobState } from '../src/types';

type StreamJobCreateInput = Parameters<StreamJobRegistry['create']>[0];

const BASE_TIME = '2026-06-01T00:00:00.000Z';

describe('StreamJobRegistry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-jobs-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRegistry(baseDir = path.join(tmpDir, 'chat')): StreamJobRegistry {
    return new StreamJobRegistry(baseDir);
  }

  function makeJobInput(overrides: Partial<StreamJobCreateInput> = {}): StreamJobCreateInput {
    return {
      state: 'accepted',
      conversationId: 'conv-1',
      sessionId: 'session-1',
      backend: 'codex',
      userMessageId: 'msg-user-1',
      cliProfileId: 'profile-1',
      model: 'gpt-5',
      effort: 'medium',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  function makeJob(overrides: Partial<DurableStreamJob> = {}): DurableStreamJob {
    return {
      id: 'job-1',
      state: 'accepted',
      conversationId: 'conv-1',
      sessionId: 'session-1',
      backend: 'codex',
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
      ...overrides,
    };
  }

  function writeJobs(filePath: string, jobs: unknown[], extra: Record<string, unknown> = {}): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, jobs, ...extra }, null, 2), 'utf8');
  }

  function readFile(filePath: string): StreamJobFile {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as StreamJobFile;
  }

  describe('construction and persistence', () => {
    test('creates the base directory and exposes stream-jobs.json as filePath', () => {
      const baseDir = path.join(tmpDir, 'nested', 'chat');
      const registry = makeRegistry(baseDir);

      expect(fs.existsSync(baseDir)).toBe(true);
      expect(registry.filePath).toBe(path.join(baseDir, 'stream-jobs.json'));
    });

    test('create persists a versioned registry readable by a second instance', async () => {
      const registry = makeRegistry();
      const created = await registry.create(makeJobInput({ id: 'job-created' }));
      const restarted = makeRegistry();

      expect(await restarted.get('job-created')).toEqual(created);
      expect(readFile(registry.filePath)).toEqual({ version: 1, jobs: [created] });
    });

    test('create fills defaults and preserves explicit ids and timestamps', async () => {
      const registry = makeRegistry();
      const generated = await registry.create(makeJobInput());
      const explicit = await registry.create(makeJobInput({
        id: 'job-explicit',
        conversationId: 'conv-explicit',
        createdAt: '2026-06-02T00:00:00.000Z',
        updatedAt: '2026-06-02T01:00:00.000Z',
      }));

      expect(generated.id).toEqual(expect.any(String));
      expect(generated.createdAt).toEqual(expect.any(String));
      expect(generated.updatedAt).toEqual(expect.any(String));
      expect(explicit).toMatchObject({
        id: 'job-explicit',
        conversationId: 'conv-explicit',
        createdAt: '2026-06-02T00:00:00.000Z',
        updatedAt: '2026-06-02T01:00:00.000Z',
      });
    });

    test('create upserts an existing id without duplicating it', async () => {
      const registry = makeRegistry();
      await registry.create(makeJobInput({ id: 'job-upsert', state: 'accepted', model: 'first' }));
      const replacement = await registry.create(makeJobInput({ id: 'job-upsert', state: 'running', model: 'second' }));

      const file = readFile(registry.filePath);
      expect(file.jobs).toHaveLength(1);
      expect(file.jobs[0]).toEqual(replacement);
      expect(await registry.get('job-upsert')).toMatchObject({ state: 'running', model: 'second' });
    });
  });

  describe('reads', () => {
    test('get returns null for unknown ids and missing files', async () => {
      const registry = makeRegistry();

      expect(await registry.get('missing')).toBeNull();
      await registry.create(makeJobInput({ id: 'job-known' }));
      expect(await registry.get('missing')).toBeNull();
    });

    test('listActive returns only active stream-job states', async () => {
      const registry = makeRegistry();
      const activeStates = [...ACTIVE_STREAM_JOB_STATES] as StreamJobState[];
      writeJobs(registry.filePath, [
        ...activeStates.map((state, index) => makeJob({ id: `active-${index}`, state })),
        makeJob({ id: 'legacy-completed', state: 'completed' as StreamJobState }),
      ]);

      const active = await registry.listActive();

      expect(active.map((job) => job.id).sort()).toEqual(activeStates.map((_, index) => `active-${index}`).sort());
    });

    test('wrong version or non-array jobs are treated as empty', async () => {
      const registry = makeRegistry();
      fs.mkdirSync(path.dirname(registry.filePath), { recursive: true });

      fs.writeFileSync(registry.filePath, JSON.stringify({ version: 2, jobs: [makeJob()] }), 'utf8');
      expect(await registry.listActive()).toEqual([]);

      fs.writeFileSync(registry.filePath, JSON.stringify({ version: 1, jobs: { id: 'nope' } }), 'utf8');
      expect(await registry.listActive()).toEqual([]);
    });

    test('malformed entries are dropped field-by-field', async () => {
      const registry = makeRegistry();
      const valid = makeJob({ id: 'valid-job' });
      writeJobs(registry.filePath, [
        valid,
        { ...valid, id: 12 },
        { ...valid, conversationId: null },
        { ...valid, sessionId: 5 },
        { ...valid, backend: undefined },
        { ...valid, state: false },
        null,
      ]);

      expect(await registry.listActive()).toEqual([valid]);
    });

    test('corrupt JSON propagates SyntaxError', async () => {
      const registry = makeRegistry();
      fs.mkdirSync(path.dirname(registry.filePath), { recursive: true });
      fs.writeFileSync(registry.filePath, '{ nope', 'utf8');

      await expect(registry.listActive()).rejects.toThrow(SyntaxError);
    });
  });

  describe('update and delete', () => {
    test('update patches fields, bumps updatedAt, and persists', async () => {
      const registry = makeRegistry();
      await registry.create(makeJobInput({
        id: 'job-update',
        state: 'accepted',
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
      }));

      const updated = await registry.update('job-update', {
        state: 'running',
        startedAt: '2026-06-01T00:01:00.000Z',
        runtime: { activeTurnId: 'turn-1', externalSessionId: 'session-external' },
      });

      expect(updated).toMatchObject({
        id: 'job-update',
        state: 'running',
        startedAt: '2026-06-01T00:01:00.000Z',
        runtime: { activeTurnId: 'turn-1', externalSessionId: 'session-external' },
      });
      expect(updated?.updatedAt).not.toBe(BASE_TIME);
      expect(await registry.get('job-update')).toEqual(updated);
    });

    test('update returns null for unknown ids and preserves existing jobs', async () => {
      const registry = makeRegistry();
      const original = await registry.create(makeJobInput({ id: 'job-known', updatedAt: BASE_TIME }));

      expect(await registry.update('missing', { state: 'running' })).toBeNull();
      expect(await registry.get('job-known')).toEqual(original);
    });

    test('delete returns true once and false afterward', async () => {
      const registry = makeRegistry();
      await registry.create(makeJobInput({ id: 'job-delete' }));

      expect(await registry.delete('job-delete')).toBe(true);
      expect(await registry.delete('job-delete')).toBe(false);
      expect(await registry.get('job-delete')).toBeNull();
    });

    test('deleteActiveForConversation removes only active jobs for that conversation', async () => {
      const registry = makeRegistry();
      writeJobs(registry.filePath, [
        makeJob({ id: 'conv-active-1', conversationId: 'conv-target', state: 'accepted' }),
        makeJob({ id: 'conv-active-2', conversationId: 'conv-target', state: 'running' }),
        makeJob({ id: 'conv-legacy-terminal', conversationId: 'conv-target', state: 'completed' as StreamJobState }),
        makeJob({ id: 'other-active', conversationId: 'conv-other', state: 'running' }),
      ]);

      expect(await registry.deleteActiveForConversation('conv-target')).toBe(2);
      expect(readFile(registry.filePath).jobs.map((job) => job.id).sort()).toEqual([
        'conv-legacy-terminal',
        'other-active',
      ]);
    });
  });

  describe('concurrency', () => {
    test('concurrent creates on one registry lose no writes', async () => {
      const registry = makeRegistry();

      await Promise.all(Array.from({ length: 10 }, (_, index) => registry.create(makeJobInput({
        id: `job-${index}`,
        conversationId: `conv-${index}`,
      }))));

      const file = readFile(registry.filePath);
      expect(file.jobs).toHaveLength(10);
      expect(file.jobs.map((job) => job.id).sort()).toEqual(Array.from({ length: 10 }, (_, index) => `job-${index}`));
    });

    test('interleaved update and delete leave a parseable consistent file', async () => {
      const registry = makeRegistry();
      await registry.create(makeJobInput({ id: 'job-race', state: 'accepted' }));

      const [updated, deleted] = await Promise.all([
        registry.update('job-race', { state: 'running' }),
        registry.delete('job-race'),
      ]);

      expect(deleted).toBe(true);
      expect(updated === null || updated.state === 'running').toBe(true);
      expect(await registry.get('job-race')).toBeNull();
      expect(readFile(registry.filePath)).toEqual({ version: 1, jobs: [] });
    });
  });
});
