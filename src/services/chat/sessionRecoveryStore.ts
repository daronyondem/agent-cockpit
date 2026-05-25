import fsp from 'fs/promises';
import path from 'path';
import { atomicWriteFile } from '../../utils/atomicWrite';
import type { Message, SessionRecoverySnapshot } from '../../types';

export interface WriteSessionRecoverySnapshotInput {
  conversationDir: string;
  conversationId: string;
  conversationTitle: string;
  workspaceId: string;
  workspacePath: string;
  backend: string;
  previousNativeSessionId: string;
  reason: string;
  sourceSessionId: string;
  sourceSessionNumber: number;
  sourceSessionPath: string;
  messages: Message[];
  recoveryCount: number;
}

export async function writeSessionRecoverySnapshot(
  input: WriteSessionRecoverySnapshotInput,
): Promise<SessionRecoverySnapshot> {
  const capturedAt = new Date().toISOString();
  const recoveryDir = path.join(input.conversationDir, 'session-recovery');
  await fsp.mkdir(recoveryDir, { recursive: true });

  const snapshotPath = path.join(recoveryDir, `session-${input.sourceSessionNumber}-latest.json`);
  const payload = {
    schemaVersion: 1,
    type: 'agent-cockpit-session-recovery-snapshot',
    capturedAt,
    conversationId: input.conversationId,
    conversationTitle: input.conversationTitle,
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    backend: input.backend,
    previousNativeSessionId: input.previousNativeSessionId,
    reason: input.reason,
    sourceSessionId: input.sourceSessionId,
    sourceSessionNumber: input.sourceSessionNumber,
    sourceSessionPath: input.sourceSessionPath,
    recoveryCount: input.recoveryCount,
    messageCount: input.messages.length,
    messages: input.messages,
  };

  await atomicWriteFile(snapshotPath, `${JSON.stringify(payload, null, 2)}\n`);
  return {
    snapshotPath,
    sourceSessionPath: input.sourceSessionPath,
    sourceSessionNumber: input.sourceSessionNumber,
    messageCount: input.messages.length,
    capturedAt,
    recoveryCount: input.recoveryCount,
  };
}
