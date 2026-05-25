import type {
  SendMessageOptions,
  SessionRecoveryEvent,
  SessionRecoveryMetadata,
  SessionRecoverySnapshot,
} from '../../types';

export const SESSION_RECOVERY_USER_MESSAGE =
  'Your previous harness session could not be resumed. Agent Cockpit recovered the conversation in a new session and will continue from the saved discussion context.';

export interface NativeSessionRecovery {
  metadata: SessionRecoveryMetadata;
  prompt: string;
}

export function isMissingNativeSessionError(message: string): boolean {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  return (
    /\b(no|missing|unknown|invalid)\s+(conversation|session)\b/.test(text)
    || /\b(conversation|session)\s+(was\s+)?(not\s+found|missing|does\s+not\s+exist|no\s+longer\s+exists|unknown|invalid)\b/.test(text)
    || /\bnot\s+found\b.*\b(conversation|session)\b/.test(text)
  );
}

export async function createRecoverySnapshot(
  options: SendMessageOptions,
  input: { previousNativeSessionId: string; reason: string },
): Promise<SessionRecoverySnapshot | null> {
  if (!options.sessionRecovery) return null;
  return options.sessionRecovery.createSnapshot(input);
}

export function buildSessionRecoveryEvent(metadata: SessionRecoveryMetadata): SessionRecoveryEvent {
  return {
    type: 'session_recovery',
    message: SESSION_RECOVERY_USER_MESSAGE,
    metadata,
  };
}

export function buildNativeSessionRecovery(input: {
  backend: string;
  previousNativeSessionId: string;
  newNativeSessionId?: string | null;
  reason: string;
  snapshot: SessionRecoverySnapshot | null;
  currentPrompt: string;
}): NativeSessionRecovery {
  const occurredAt = new Date().toISOString();
  const metadata: SessionRecoveryMetadata = {
    backend: input.backend,
    reason: input.reason,
    previousNativeSessionId: input.previousNativeSessionId,
    newNativeSessionId: input.newNativeSessionId || null,
    snapshotPath: input.snapshot?.snapshotPath || null,
    sourceSessionPath: input.snapshot?.sourceSessionPath || null,
    sourceSessionNumber: input.snapshot?.sourceSessionNumber || null,
    snapshotMessageCount: input.snapshot?.messageCount || null,
    recoveryCount: input.snapshot?.recoveryCount || 1,
    occurredAt,
  };

  return {
    metadata,
    prompt: buildHarnessRecoveryPrompt(metadata, input.currentPrompt),
  };
}

export function buildHarnessRecoveryPrompt(metadata: SessionRecoveryMetadata, currentPrompt: string): string {
  const snapshotInstruction = metadata.snapshotPath
    ? [
        'Required action:',
        `1. You MUST read the prior Agent Cockpit conversation snapshot before answering: ${metadata.snapshotPath}`,
        '2. You MUST use that snapshot as the source of prior-turn context.',
        '3. Do not answer the current request until you have inspected the snapshot. Do not continue from the latest user message alone.',
        'If the file is large, search or page through it, but you still MUST inspect it before answering.',
      ].join('\n')
    : [
        'Agent Cockpit could not write a prior-conversation snapshot.',
        'Before answering, state that the previous harness session could not be resumed and prior context may be incomplete.',
      ].join('\n');

  return [
    '[Agent Cockpit recovery instructions]',
    'The previous native harness session could not be resumed. Agent Cockpit has started a new native session.',
    snapshotInstruction,
    '[/Agent Cockpit recovery instructions]',
    '',
    currentPrompt,
  ].join('\n');
}
