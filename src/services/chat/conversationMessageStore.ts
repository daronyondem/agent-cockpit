import type {
  ContentBlock,
  ConversationEntry,
  ConversationMessageWindow,
  ConversationPinnedMessage,
  Message,
  SessionFile,
  SessionHistoryItem,
  ToolActivity,
  WorkspaceIndex,
} from '../../types';

interface ConversationLookupResult {
  hash: string;
  index: WorkspaceIndex;
  convEntry: ConversationEntry;
}

interface ConversationMessageStoreDeps {
  convWorkspaceMap: Map<string, string>;
  indexLock: { run<T>(key: string, fn: () => Promise<T>): Promise<T> };
  getConvFromIndex(convId: string): Promise<ConversationLookupResult | null>;
  readSessionFile(hash: string, convId: string, sessionNumber: number): Promise<SessionFile | null>;
  writeSessionFile(hash: string, convId: string, sessionNumber: number, data: SessionFile): Promise<void>;
  writeWorkspaceIndex(hash: string, index: WorkspaceIndex): Promise<void>;
  newId(): string;
}

export type MessageWindowMode = 'tail' | 'before' | 'around';

export interface MessageWindowOptions {
  mode?: MessageWindowMode;
  limit?: number;
  beforeMessageId?: string;
  aroundMessageId?: string;
  beforeCount?: number;
  afterCount?: number;
}

export interface ConversationMessagesWindowResult {
  messages: Message[];
  messageWindow: ConversationMessageWindow;
  pinnedMessages: ConversationPinnedMessage[];
}

const DEFAULT_MESSAGE_WINDOW_LIMIT = 160;
const DEFAULT_AROUND_MESSAGE_BEFORE = 80;
const DEFAULT_AROUND_MESSAGE_AFTER = 80;
const MAX_MESSAGE_WINDOW_LIMIT = 500;

function messageWindowLimit(value: number | undefined, fallback = DEFAULT_MESSAGE_WINDOW_LIMIT): number {
  if (!Number.isFinite(value) || !value) return fallback;
  return Math.max(1, Math.min(MAX_MESSAGE_WINDOW_LIMIT, Math.floor(value)));
}

export function collectPinnedMessages(messages: Message[]): ConversationPinnedMessage[] {
  return messages
    .map((message, index) => message.pinned ? { index, message } : null)
    .filter((item): item is ConversationPinnedMessage => item !== null);
}

export function buildMessageWindow(messages: Message[], opts?: MessageWindowOptions): ConversationMessageWindow | null {
  const total = messages.length;
  if (total === 0) {
    return {
      messages: [],
      total: 0,
      startIndex: 0,
      endIndex: 0,
      hasOlder: false,
      hasNewer: false,
    };
  }

  const mode = opts?.mode || 'tail';
  let startIndex = 0;
  let endIndex = total;

  if (mode === 'before') {
    const anchorIndex = messages.findIndex(message => message.id === opts?.beforeMessageId);
    if (anchorIndex < 0) return null;
    const limit = messageWindowLimit(opts?.limit);
    endIndex = anchorIndex;
    startIndex = Math.max(0, endIndex - limit);
  } else if (mode === 'around') {
    const anchorIndex = messages.findIndex(message => message.id === opts?.aroundMessageId);
    if (anchorIndex < 0) return null;
    let beforeCount = messageWindowLimit(opts?.beforeCount, DEFAULT_AROUND_MESSAGE_BEFORE);
    let afterCount = messageWindowLimit(opts?.afterCount, DEFAULT_AROUND_MESSAGE_AFTER);
    const requested = beforeCount + afterCount + 1;
    if (requested > MAX_MESSAGE_WINDOW_LIMIT) {
      let overflow = requested - MAX_MESSAGE_WINDOW_LIMIT;
      const trimAfter = Math.min(afterCount, overflow);
      afterCount -= trimAfter;
      overflow -= trimAfter;
      beforeCount = Math.max(0, beforeCount - overflow);
    }
    startIndex = Math.max(0, anchorIndex - beforeCount);
    endIndex = Math.min(total, anchorIndex + afterCount + 1);
  } else {
    const limit = messageWindowLimit(opts?.limit);
    endIndex = total;
    startIndex = Math.max(0, endIndex - limit);
  }

  return {
    messages: messages.slice(startIndex, endIndex),
    total,
    startIndex,
    endIndex,
    hasOlder: startIndex > 0,
    hasNewer: endIndex < total,
  };
}

export class ConversationMessageStore {
  constructor(private readonly deps: ConversationMessageStoreDeps) {}

  async addMessage(
    convId: string,
    role: Message['role'],
    content: string,
    backend: string,
    thinking?: string | null,
    toolActivity?: ToolActivity[],
    turn?: 'progress' | 'final',
    contentBlocks?: ContentBlock[],
    opts?: { streamError?: Message['streamError']; goalEvent?: Message['goalEvent'] },
  ): Promise<Message | null> {
    const hash = this.deps.convWorkspaceMap.get(convId);
    if (!hash) return null;
    return this.deps.indexLock.run(hash, async () => {
      const result = await this.deps.getConvFromIndex(convId);
      if (!result) return null;
      const { index, convEntry } = result;

      const msg: Message = {
        id: this.deps.newId(),
        role,
        content,
        backend: backend || convEntry.backend,
        timestamp: new Date().toISOString(),
      };

      if (thinking) {
        msg.thinking = thinking;
      }

      if (toolActivity && toolActivity.length > 0) {
        msg.toolActivity = toolActivity;
      }

      if (contentBlocks && contentBlocks.length > 0 && role === 'assistant') {
        msg.contentBlocks = contentBlocks;
      }

      if (opts?.streamError && role === 'assistant') {
        msg.streamError = opts.streamError;
      }

      if (opts?.goalEvent && role === 'system') {
        msg.goalEvent = opts.goalEvent;
      }

      if (turn && role === 'assistant') {
        msg.turn = turn;
      }

      const activeSession = convEntry.sessions.find(s => s.active);
      const sessionNumber = activeSession ? activeSession.number : 1;

      if (role === 'user' && convEntry.title === 'New Chat' && sessionNumber <= 1 && !convEntry.titleManuallySet) {
        convEntry.title = content.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
      }

      let sessionFile = await this.deps.readSessionFile(hash, convId, sessionNumber);
      if (!sessionFile) {
        sessionFile = {
          sessionNumber,
          sessionId: convEntry.currentSessionId,
          startedAt: msg.timestamp,
          endedAt: null,
          messages: [],
        };
      }
      sessionFile.messages.push(msg);
      await this.deps.writeSessionFile(hash, convId, sessionNumber, sessionFile);

      convEntry.lastActivity = msg.timestamp;
      convEntry.lastMessage = content.substring(0, 100);
      if (activeSession) {
        activeSession.messageCount = sessionFile.messages.length;
      }
      await this.deps.writeWorkspaceIndex(hash, index);

      return msg;
    });
  }

  async updateMessageContent(convId: string, messageId: string, newContent: string): Promise<Message | null> {
    const hash = this.deps.convWorkspaceMap.get(convId);
    if (!hash) return null;
    return this.deps.indexLock.run(hash, async () => {
      const result = await this.deps.getConvFromIndex(convId);
      if (!result) return null;
      const { index, convEntry } = result;

      const activeSession = convEntry.sessions.find(s => s.active);
      const sessionNumber = activeSession ? activeSession.number : 1;

      const sessionFile = await this.deps.readSessionFile(hash, convId, sessionNumber);
      if (!sessionFile) return null;

      const msgIndex = sessionFile.messages.findIndex(m => m.id === messageId);
      if (msgIndex === -1) return null;

      sessionFile.messages = sessionFile.messages.slice(0, msgIndex);

      const msg: Message = {
        id: this.deps.newId(),
        role: 'user',
        content: newContent,
        backend: convEntry.backend,
        timestamp: new Date().toISOString(),
      };
      sessionFile.messages.push(msg);
      await this.deps.writeSessionFile(hash, convId, sessionNumber, sessionFile);

      if (activeSession) {
        activeSession.messageCount = sessionFile.messages.length;
      }
      convEntry.lastActivity = msg.timestamp;
      convEntry.lastMessage = newContent.substring(0, 100);
      await this.deps.writeWorkspaceIndex(hash, index);

      return msg;
    });
  }

  async setMessagePinned(convId: string, messageId: string, pinned: boolean): Promise<Message | null> {
    const hash = this.deps.convWorkspaceMap.get(convId);
    if (!hash) return null;
    return this.deps.indexLock.run(hash, async () => {
      const result = await this.deps.getConvFromIndex(convId);
      if (!result) return null;
      const { convEntry } = result;

      const activeSession = convEntry.sessions.find(s => s.active);
      const sessionNumber = activeSession ? activeSession.number : 1;

      const sessionFile = await this.deps.readSessionFile(hash, convId, sessionNumber);
      if (!sessionFile) return null;

      const msg = sessionFile.messages.find(m => m.id === messageId);
      if (!msg) return null;

      if (pinned) {
        msg.pinned = true;
      } else {
        delete msg.pinned;
      }
      await this.deps.writeSessionFile(hash, convId, sessionNumber, sessionFile);
      return msg;
    });
  }

  async getSessionHistory(convId: string): Promise<SessionHistoryItem[] | null> {
    const result = await this.deps.getConvFromIndex(convId);
    if (!result) return null;
    const { convEntry } = result;

    return convEntry.sessions.map(s => ({
      number: s.number,
      sessionId: s.active ? convEntry.currentSessionId : (s.sessionId || null),
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      messageCount: s.messageCount,
      summary: s.summary || null,
      isCurrent: s.active,
    }));
  }

  async getSessionMessages(convId: string, sessionNumber: number): Promise<Message[] | null> {
    const result = await this.deps.getConvFromIndex(convId);
    if (!result) return null;
    const { hash } = result;

    const sessionFile = await this.deps.readSessionFile(hash, convId, sessionNumber);
    return sessionFile ? sessionFile.messages : null;
  }
}
