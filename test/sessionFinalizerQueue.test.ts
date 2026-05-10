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
      type: 'context_map_conversation_final_pass',
      payload: { source: 'session_reset' },
    });
    const duplicate = await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv1',
      sessionNumber: 2,
      type: 'context_map_conversation_final_pass',
      payload: { source: 'session_reset' },
    });
    const archive = await queue.enqueue({
      workspaceHash: 'ws1',
      conversationId: 'conv1',
      sessionNumber: 2,
      type: 'context_map_conversation_final_pass',
      payload: { source: 'archive' },
    });

    const jobs = await queue.listJobs('ws1');
    expect(duplicate.id).toBe(first.id);
    expect(archive.id).not.toBe(first.id);
    expect(jobs).toHaveLength(2);
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
});
