import fs from 'fs';
import path from 'path';
import os from 'os';
import { SessionFinalizerQueue, type SessionFinalizerJob } from '../src/services/sessionFinalizerQueue';

describe('SessionFinalizerQueue', () => {
  let tmpDir: string;
  let workspacesDir: string;
  let queue: SessionFinalizerQueue | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-finalizers-'));
    workspacesDir = path.join(tmpDir, 'workspaces');
    queue = null;
  });

  afterEach(() => {
    queue?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function waitUntil(assertion: () => void | Promise<void>, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() <= deadline) {
      try {
        await assertion();
        return;
      } catch (err) {
        lastError = err;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    if (lastError) throw lastError;
    throw new Error('Timed out waiting for assertion');
  }

  function makeStoredJob(overrides: Partial<SessionFinalizerJob> = {}): SessionFinalizerJob {
    const now = new Date().toISOString();
    return {
      id: 'sfj-stored',
      identity: 'session_summary::conv-stored:1',
      workspaceHash: 'ws1',
      conversationId: 'conv-stored',
      sessionNumber: 1,
      type: 'session_summary',
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  function writeStore(workspaceHash: string, jobs: unknown[]): void {
    const workspaceDir = path.join(workspacesDir, workspaceHash);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'session-finalizers.json'), JSON.stringify({
      version: 1,
      jobs,
    }, null, 2));
  }

  test('persists and completes enqueued jobs asynchronously', async () => {
    const handled: SessionFinalizerJob[] = [];
    queue = new SessionFinalizerQueue({
      workspacesDir,
      retryDelayMs: 20,
      handleJob: async (job) => {
        handled.push(job);
      },
    });
    await queue.start();

    await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv1',
      sessionNumber: 1,
      type: 'session_summary',
    });
    await queue.waitForIdle(1_000);

    const jobs = await queue.listJobs('ws1');
    expect(handled.map((job) => job.type)).toEqual(['session_summary']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      workspaceHash: 'ws1',
      conversationId: 'conv1',
      sessionNumber: 1,
      type: 'session_summary',
      status: 'completed',
      attempts: 1,
    });
    expect(fs.existsSync(path.join(workspacesDir, 'ws1', 'session-finalizers.json'))).toBe(true);
  });

  test('de-duplicates jobs by type, source, conversation, and session', async () => {
    queue = new SessionFinalizerQueue({
      workspacesDir,
      handleJob: async () => {},
    });
    queue.stop();

    const first = await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv1',
      sessionNumber: 2,
      type: 'workspace_context_conversation_final_pass',
      payload: { source: 'session_reset' },
    });
    const duplicate = await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv1',
      sessionNumber: 2,
      type: 'workspace_context_conversation_final_pass',
      payload: { source: 'session_reset' },
    });
    const archive = await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv1',
      sessionNumber: 2,
      type: 'workspace_context_conversation_final_pass',
      payload: { source: 'archive' },
    });

    const jobs = await queue.listJobs('ws1');
    expect(duplicate.id).toBe(first.id);
    expect(archive.id).not.toBe(first.id);
    expect(jobs).toHaveLength(2);
  });

  test('uses optional identity keys to separate repeated lifecycle passes', async () => {
    const terminal: SessionFinalizerJob[] = [];
    queue = new SessionFinalizerQueue({
      workspacesDir,
      handleJob: async () => {},
      onTerminalJob: async (job) => {
        terminal.push(job);
      },
    });
    await queue.start();

    const first = await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv1',
      sessionNumber: 2,
      type: 'memory_extraction',
      payload: { identityKey: 'archive:first' },
    });
    const second = await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv1',
      sessionNumber: 2,
      type: 'memory_extraction',
      payload: { identityKey: 'archive:second' },
    });
    await queue.waitForIdle(1_000);

    const jobs = await queue.listJobs('ws1');
    expect(second.id).not.toBe(first.id);
    expect(jobs).toHaveLength(2);
    expect(terminal.map((job) => job.id).sort()).toEqual([first.id, second.id].sort());
  });

  test('stores canonical workspace jobs under the resolved storage key', async () => {
    queue = new SessionFinalizerQueue({
      workspacesDir,
      resolveWorkspaceStorageKey: (workspaceRef) => (workspaceRef === 'workspace-id-1' ? 'legacy-storage-1' : null),
      handleJob: async () => {},
    });
    queue.stop();

    await queue.enqueue({
      workspaceHash: 'workspace-id-1',
      conversationId: 'conv1',
      sessionNumber: 1,
      type: 'session_summary',
    });

    expect(fs.existsSync(path.join(workspacesDir, 'workspace-id-1', 'session-finalizers.json'))).toBe(false);
    expect(fs.existsSync(path.join(workspacesDir, 'legacy-storage-1', 'session-finalizers.json'))).toBe(true);
    const jobs = await queue.listJobs('workspace-id-1');
    expect(jobs[0]).toMatchObject({
      workspaceHash: 'workspace-id-1',
      conversationId: 'conv1',
    });
  });

  test('retries transient failures and records the successful attempt', async () => {
    let attempts = 0;
    queue = new SessionFinalizerQueue({
      workspacesDir,
      retryDelayMs: 20,
      handleJob: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('try again');
      },
    });
    await queue.start();

    await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv1',
      sessionNumber: 1,
      type: 'memory_extraction',
    });
    await queue.waitForIdle(1_000);

    const jobs = await queue.listJobs('ws1');
    expect(attempts).toBe(2);
    expect(jobs[0]).toMatchObject({
      type: 'memory_extraction',
      status: 'completed',
      attempts: 2,
    });
  });

  test('recovers running jobs after restart', async () => {
    const workspaceDir = path.join(workspacesDir, 'ws1');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'session-finalizers.json'), JSON.stringify({
      version: 1,
      jobs: [{
        id: 'sfj-running',
        identity: 'session_summary::conv1:1',
        workspaceHash: 'ws1',
        conversationId: 'conv1',
        sessionNumber: 1,
        type: 'session_summary',
        status: 'running',
        attempts: 1,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      }],
    }, null, 2));

    const handled: string[] = [];
    queue = new SessionFinalizerQueue({
      workspacesDir,
      retryDelayMs: 20,
      handleJob: async (job) => {
        handled.push(job.id);
      },
    });
    await queue.start();
    await queue.waitForIdle(1_000);

    const jobs = await queue.listJobs('ws1');
    expect(handled).toEqual(['sfj-running']);
    expect(jobs[0]).toMatchObject({
      id: 'sfj-running',
      status: 'completed',
      attempts: 2,
    });
  });

  test('marks a job failed after max attempts and notifies terminal observers', async () => {
    const terminal: SessionFinalizerJob[] = [];
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    queue = new SessionFinalizerQueue({
      workspacesDir,
      retryDelayMs: 20,
      logger,
      handleJob: async () => {
        throw new Error('permanent failure');
      },
      onTerminalJob: async (job) => {
        terminal.push(job);
      },
    });
    await queue.start();

    const enqueued = await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv-fail',
      sessionNumber: 1,
      type: 'memory_extraction',
      maxAttempts: 1,
    });
    await queue.waitForIdle(1_000);

    const [job] = await queue.listJobs('ws1');
    expect(job).toMatchObject({
      id: enqueued.id,
      status: 'failed',
      attempts: 1,
      errorMessage: 'permanent failure',
    });
    expect(job.nextAttemptAt).toBeUndefined();
    expect(job.completedAt).toEqual(expect.any(String));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ id: enqueued.id, status: 'failed' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[session-finalizer] memory_extraction failed for conv=conv-fail session=1: permanent failure'));
  });

  test('does not claim retrying jobs before nextAttemptAt', async () => {
    let attempts = 0;
    queue = new SessionFinalizerQueue({
      workspacesDir,
      retryDelayMs: 1_000,
      handleJob: async () => {
        attempts += 1;
        throw new Error('wait until later');
      },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    await queue.start();

    await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv-retry',
      sessionNumber: 1,
      type: 'session_summary',
      maxAttempts: 2,
    });
    await waitUntil(async () => {
      const [job] = await queue!.listJobs('ws1');
      expect(job.status).toBe('retrying');
      expect(job.nextAttemptAt).toEqual(expect.any(String));
    });

    const [retrying] = await queue.listJobs('ws1');
    const nextAttemptAt = Date.parse(retrying.nextAttemptAt!);
    expect(nextAttemptAt - Date.now()).toBeGreaterThan(500);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(attempts).toBe(1);
    expect((await queue.listJobs('ws1'))[0]).toMatchObject({ status: 'retrying', attempts: 1 });
  });

  test('swallows terminal observer errors and continues processing', async () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const handled: string[] = [];
    queue = new SessionFinalizerQueue({
      workspacesDir,
      logger,
      handleJob: async (job) => {
        handled.push(job.conversationId);
      },
      onTerminalJob: async () => {
        throw new Error('observer down');
      },
    });
    await queue.start();

    await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv-a',
      sessionNumber: 1,
      type: 'session_summary',
    });
    await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv-b',
      sessionNumber: 1,
      type: 'memory_extraction',
    });
    await queue.waitForIdle(1_000);

    expect(handled).toEqual(['conv-a', 'conv-b']);
    expect((await queue.listJobs('ws1')).map(job => job.status)).toEqual(['completed', 'completed']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('terminal job observer failed'));
  });

  test('runs no more than the configured concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseAll: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseAll = resolve; });
    queue = new SessionFinalizerQueue({
      workspacesDir,
      concurrency: 2,
      handleJob: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
      },
    });
    await queue.start();

    await Promise.all([0, 1, 2].map(index => queue!.enqueue({
      workspaceHash: 'ws1',
      conversationId: `conv-${index}`,
      sessionNumber: 1,
      type: 'session_summary',
    })));
    await waitUntil(() => {
      expect(inFlight).toBe(2);
    });
    expect(maxInFlight).toBe(2);

    releaseAll();
    await queue.waitForIdle(1_000);
    expect(maxInFlight).toBe(2);
  });

  test('clamps high concurrency to four workers', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseAll: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseAll = resolve; });
    queue = new SessionFinalizerQueue({
      workspacesDir,
      concurrency: 99,
      handleJob: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
      },
    });
    await queue.start();

    await Promise.all(Array.from({ length: 6 }, (_, index) => queue!.enqueue({
      workspaceHash: 'ws1',
      conversationId: `conv-clamp-${index}`,
      sessionNumber: 1,
      type: 'session_summary',
    })));
    await waitUntil(() => {
      expect(inFlight).toBe(4);
    });

    releaseAll();
    await queue.waitForIdle(1_000);
    expect(maxInFlight).toBe(4);
  });

  test('default concurrency processes one job at a time', async () => {
    let firstRelease: () => void = () => {};
    const firstGate = new Promise<void>(resolve => { firstRelease = resolve; });
    const started: string[] = [];
    queue = new SessionFinalizerQueue({
      workspacesDir,
      handleJob: async (job) => {
        started.push(job.conversationId);
        if (job.conversationId === 'conv-first') await firstGate;
      },
    });
    await queue.start();

    await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv-first',
      sessionNumber: 1,
      type: 'session_summary',
    });
    await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv-second',
      sessionNumber: 1,
      type: 'session_summary',
    });
    await waitUntil(() => {
      expect(started).toEqual(['conv-first']);
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(started).toEqual(['conv-first']);

    firstRelease();
    await queue.waitForIdle(1_000);
    expect(started).toEqual(['conv-first', 'conv-second']);
  });

  test('claims the oldest pending job across workspace stores first', async () => {
    writeStore('ws-new', [makeStoredJob({
      id: 'newer',
      identity: 'session_summary::new:1',
      workspaceHash: 'ws-new',
      conversationId: 'new',
      createdAt: '2026-06-01T00:02:00.000Z',
      updatedAt: '2026-06-01T00:02:00.000Z',
    })]);
    writeStore('ws-old', [makeStoredJob({
      id: 'older',
      identity: 'session_summary::old:1',
      workspaceHash: 'ws-old',
      conversationId: 'old',
      createdAt: '2026-06-01T00:01:00.000Z',
      updatedAt: '2026-06-01T00:01:00.000Z',
    })]);
    const order: string[] = [];
    queue = new SessionFinalizerQueue({
      workspacesDir,
      handleJob: async (job) => {
        order.push(job.id);
      },
    });
    await queue.start();
    await queue.waitForIdle(1_000);

    expect(order).toEqual(['older', 'newer']);
  });

  test('stop prevents draining while enqueue still persists jobs', async () => {
    const handled: string[] = [];
    queue = new SessionFinalizerQueue({
      workspacesDir,
      handleJob: async (job) => {
        handled.push(job.conversationId);
      },
    });
    await queue.start();
    queue.stop();

    await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv-stopped',
      sessionNumber: 1,
      type: 'session_summary',
    });
    await new Promise(resolve => setTimeout(resolve, 80));

    expect(handled).toEqual([]);
    expect((await queue.listJobs('ws1'))[0]).toMatchObject({ status: 'pending' });

    await queue.start();
    await queue.waitForIdle(1_000);
    expect(handled).toEqual(['conv-stopped']);
  });

  test('waitForIdle rejects when a running job never finishes', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    queue = new SessionFinalizerQueue({
      workspacesDir,
      handleJob: async () => {
        await gate;
      },
    });
    await queue.start();

    await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv-blocked',
      sessionNumber: 1,
      type: 'session_summary',
    });
    await waitUntil(async () => {
      expect((await queue!.listJobs('ws1'))[0].status).toBe('running');
    });
    await expect(queue.waitForIdle(50)).rejects.toThrow('Timed out waiting');

    release();
    await queue.waitForIdle(1_000);
  });

  test('filters malformed store records and returns an empty list for missing workspace dirs', async () => {
    const valid = makeStoredJob({ id: 'valid', identity: 'session_summary::valid:1' });
    writeStore('ws1', [
      valid,
      { ...valid, id: 12 },
      { ...valid, sessionNumber: '1' },
      { ...valid, type: 'unknown' },
      { ...valid, status: 'unknown' },
      { ...valid, createdAt: null },
    ]);
    queue = new SessionFinalizerQueue({
      workspacesDir,
      handleJob: async () => {},
    });
    queue.stop();

    expect(await queue.listJobs('missing')).toEqual([]);
    expect(await queue.listJobs('ws1')).toEqual([valid]);
  });

  test('handler payload mutation cannot corrupt persisted payload', async () => {
    queue = new SessionFinalizerQueue({
      workspacesDir,
      handleJob: async (job) => {
        if (job.payload) job.payload.changed = true;
      },
    });
    await queue.start();

    await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv-payload',
      sessionNumber: 1,
      type: 'workspace_context_conversation_final_pass',
      payload: { source: 'archive' },
    });
    await queue.waitForIdle(1_000);

    const [job] = await queue.listJobs('ws1');
    expect(job.payload).toEqual({ source: 'archive' });
  });
});
