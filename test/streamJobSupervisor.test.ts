import fs from 'fs';
import os from 'os';
import path from 'path';
import { StreamJobSupervisor } from '../src/services/streamJobSupervisor';
import type { ActiveStreamEntry } from '../src/types';

describe('stream supervisor reset admission', () => {
  let dir: string;
  let supervisor: StreamJobSupervisor;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-reset-'));
    supervisor = new StreamJobSupervisor(dir);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('reserves one conversation until cleanup and session replacement finish', () => {
    const release = supervisor.tryBeginSessionReset('conversation');
    expect(release).not.toBeNull();
    expect(supervisor.hasInFlightTurn('conversation')).toBe(true);
    expect(supervisor.hasInFlightTurn('other')).toBe(false);
    expect(supervisor.isResetting('conversation', null)).toBe(true);
    expect(supervisor.isResetting('other', null)).toBe(false);
    expect(supervisor.hasAnyInFlightTurn()).toBe(true);
    expect(supervisor.tryBeginSessionReset('conversation')).toBeNull();
    release!();
    expect(supervisor.hasInFlightTurn('conversation')).toBe(false);
    expect(supervisor.isResetting('conversation', null)).toBe(false);
    expect(supervisor.hasAnyInFlightTurn()).toBe(false);
  });

  test('rejects a reset while a send is preparing', () => {
    supervisor.pendingMessageSends.set('conversation', { jobId: 'pending' });
    expect(supervisor.tryBeginSessionReset('conversation')).toBeNull();
    expect(supervisor.resettingConversations.size).toBe(0);
  });

  test('reserves a workspace independently and includes it in the CLI update guard', () => {
    const release = supervisor.tryBeginWorkspaceReset('workspace');
    expect(release).not.toBeNull();
    expect(supervisor.resettingWorkspaces.has('workspace')).toBe(true);
    expect(supervisor.isResetting('conversation', 'workspace')).toBe(true);
    expect(supervisor.isResetting('conversation', 'other')).toBe(false);
    expect(supervisor.hasAnyInFlightTurn()).toBe(true);
    expect(supervisor.tryBeginWorkspaceReset('workspace')).toBeNull();
    release!();
    expect(supervisor.hasAnyInFlightTurn()).toBe(false);
  });

  test('a failed durable turn write releases admission so reset can proceed', async () => {
    jest.spyOn(supervisor.registry, 'create').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(supervisor.beginAcceptedTurn({
      conversationId: 'conversation', sessionId: 'session', backend: 'copilot',
    })).rejects.toThrow('disk unavailable');
    expect(supervisor.pendingMessageSends.size).toBe(0);
    const release = supervisor.tryBeginSessionReset('conversation');
    expect(release).not.toBeNull();
    release!();
  });

  function runtime(jobId: string, abort: () => void): ActiveStreamEntry {
    return {
      stream: (async function* () { yield { type: 'done' } as const; })(),
      abort, sendInput: () => {}, backend: 'copilot', needsTitleUpdate: false, titleUpdateMessage: null, jobId,
    };
  }

  test('conversation cleanup releases admission and durable jobs even if abort throws', async () => {
    const pending = await supervisor.beginAcceptedTurn({
      conversationId: 'conversation', sessionId: 'session', backend: 'copilot',
    });
    supervisor.clearPending('conversation', pending);
    supervisor.attachRuntime('conversation', runtime(pending.jobId, () => { throw new Error('abort failed'); }));
    expect(await supervisor.cleanupRuntimeConversation('conversation')).toEqual({ abortedRuntime: true, deletedJobs: 1 });
    expect(supervisor.hasAnyInFlightTurn()).toBe(false);
    expect(await supervisor.registry.listActive()).toEqual([]);
    const release = supervisor.tryBeginSessionReset('conversation');
    expect(release).not.toBeNull();
    release!();
  });

  test('shutdown marks active jobs interrupted and continues cleanup when one abort throws', async () => {
    const abort = jest.fn();
    for (const id of ['failing', 'healthy']) {
      const pending = await supervisor.beginAcceptedTurn({ conversationId: id, sessionId: id, backend: 'copilot' });
      supervisor.clearPending(id, pending);
      supervisor.attachRuntime(id, runtime(pending.jobId, id === 'failing'
        ? () => { throw new Error('abort failed'); } : abort));
    }
    expect(await supervisor.prepareForShutdown()).toBe(2);
    supervisor.abortAndDetachAllRuntime();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(supervisor.hasAnyInFlightTurn()).toBe(false);
    const interrupted = await supervisor.registry.listActive();
    expect(interrupted).toHaveLength(2);
    expect(interrupted.every(job => job.state === 'finalizing'
      && job.terminalError?.message === 'Interrupted by server shutdown')).toBe(true);
  });
});
