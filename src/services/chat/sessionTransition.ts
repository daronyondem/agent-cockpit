import type { ConversationEntry, SessionFile } from '../../types';

export interface ArchivedSessionResult {
  number: number;
  sessionId: string | null;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  summary: string;
}

interface SessionTransitionDeps {
  readSessionFile(hash: string, convId: string, sessionNumber: number): Promise<SessionFile | null>;
  writeSessionFile(hash: string, convId: string, sessionNumber: number, data: SessionFile): Promise<void>;
  newId(): string;
}

/**
 * Archives the active session and opens the next session file.
 * Caller must hold the workspace index lock and owns the subsequent
 * `index.json` write.
 */
export async function advanceConversationSession(
  deps: SessionTransitionDeps,
  hash: string,
  convEntry: ConversationEntry,
  now: Date,
  opts: { branchName?: string; baseRef?: string } = {},
): Promise<ArchivedSessionResult | null> {
  const activeSession = convEntry.sessions.find(s => s.active);
  if (!activeSession) return null;

  const currentSessionNumber = activeSession.number;
  const sessionFile = await deps.readSessionFile(hash, convEntry.id, currentSessionNumber);
  const currentMessages = sessionFile ? sessionFile.messages : [];
  const summary = `Session ${currentSessionNumber} (${currentMessages.length} messages)`;

  activeSession.active = false;
  activeSession.summary = summary;
  activeSession.endedAt = now.toISOString();
  activeSession.messageCount = currentMessages.length;

  if (sessionFile) {
    sessionFile.endedAt = now.toISOString();
    await deps.writeSessionFile(hash, convEntry.id, currentSessionNumber, sessionFile);
  }

  const newSessionNumber = currentSessionNumber + 1;
  const newSessionId = deps.newId();

  delete convEntry.messageQueue;
  delete convEntry.claudeCodeMode;
  if (convEntry.usage) convEntry.usage.contextUsagePercentage = undefined;
  convEntry.currentSessionId = newSessionId;
  if (!convEntry.titleManuallySet) {
    convEntry.title = 'New Chat';
  }
  convEntry.lastActivity = now.toISOString();
  convEntry.lastMessage = null;
  delete convEntry.unread;
  convEntry.sessions.push({
    number: newSessionNumber,
    sessionId: newSessionId,
    summary: null,
    active: true,
    messageCount: 0,
    startedAt: now.toISOString(),
    endedAt: null,
    ...(opts.branchName ? { branchName: opts.branchName } : {}),
    ...(opts.baseRef ? { baseRef: opts.baseRef } : {}),
  });

  await deps.writeSessionFile(hash, convEntry.id, newSessionNumber, {
    sessionNumber: newSessionNumber,
    sessionId: newSessionId,
    startedAt: now.toISOString(),
    endedAt: null,
    messages: [],
  });

  return {
    number: currentSessionNumber,
    sessionId: activeSession.sessionId || null,
    startedAt: activeSession.startedAt,
    endedAt: now.toISOString(),
    messageCount: currentMessages.length,
    summary,
  };
}
