import fs from 'fs';
import os from 'os';
import path from 'path';
import { StreamJobSupervisor } from '../src/services/streamJobSupervisor';

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
    expect(supervisor.hasAnyInFlightTurn()).toBe(true);
    expect(supervisor.tryBeginSessionReset('conversation')).toBeNull();
    release!();
    expect(supervisor.hasInFlightTurn('conversation')).toBe(false);
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
    expect(supervisor.hasAnyInFlightTurn()).toBe(true);
    expect(supervisor.tryBeginWorkspaceReset('workspace')).toBeNull();
    release!();
    expect(supervisor.hasAnyInFlightTurn()).toBe(false);
  });
});
