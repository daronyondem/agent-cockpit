// ── Session Recovery Types ───────────────────────────────────────────

export interface SessionRecoveryMetadata {
  backend: string;
  reason: string;
  previousNativeSessionId?: string | null;
  newNativeSessionId?: string | null;
  snapshotPath?: string | null;
  sourceSessionPath?: string | null;
  sourceSessionNumber?: number | null;
  snapshotMessageCount?: number | null;
  recoveryCount: number;
  occurredAt: string;
}

export interface SessionRecoverySnapshot {
  snapshotPath: string;
  sourceSessionPath: string;
  sourceSessionNumber: number;
  messageCount: number;
  capturedAt: string;
  recoveryCount: number;
}

export interface SessionRecoveryOptions {
  createSnapshot: (input: {
    previousNativeSessionId: string;
    reason: string;
  }) => Promise<SessionRecoverySnapshot | null>;
}

export interface SessionRecoveryEvent {
  type: 'session_recovery';
  message: string;
  metadata: SessionRecoveryMetadata;
}
