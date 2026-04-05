import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { BackendRegistry } from './backends/registry';
import type {
  Message,
  ToolActivity,
  Usage,
  UsageLedger,
  SessionEntry,
  SessionFile,
  SessionHistoryItem,
  ConversationEntry,
  WorkspaceIndex,
  Conversation,
  ConversationListItem,
  Settings,
} from '../types';

const DEFAULT_WORKSPACE_FALLBACK = '/tmp/default-workspace';

interface ConvLookupResult {
  hash: string;
  index: WorkspaceIndex;
  convEntry: ConversationEntry;
}

interface ResetSessionResult {
  conversation: Conversation;
  newSessionNumber: number;
  archivedSession: {
    number: number;
    sessionId: string | null;
    startedAt: string;
    endedAt: string;
    messageCount: number;
    summary: string;
  };
}

interface EditMessageResult {
  conversation: Conversation;
  message: Message;
}

export class ChatService {
  baseDir: string;
  workspacesDir: string;
  artifactsDir: string;
  settingsFile: string;
  usageLedgerFile: string;
  private _defaultWorkspace: string;
  private _backendRegistry: BackendRegistry | null;
  private _convWorkspaceMap: Map<string, string>;
  private _legacyConversationsDir: string;
  private _legacyArchivesDir: string;

  constructor(appRoot: string, options: { defaultWorkspace?: string; backendRegistry?: BackendRegistry } = {}) {
    this.baseDir = path.join(appRoot, 'data', 'chat');
    this.workspacesDir = path.join(this.baseDir, 'workspaces');
    this.artifactsDir = path.join(this.baseDir, 'artifacts');
    this.settingsFile = path.join(this.baseDir, 'settings.json');
    this.usageLedgerFile = path.join(this.baseDir, 'usage-ledger.json');
    this._defaultWorkspace = options.defaultWorkspace || DEFAULT_WORKSPACE_FALLBACK;
    this._backendRegistry = options.backendRegistry || null;
    this._convWorkspaceMap = new Map();

    this._legacyConversationsDir = path.join(this.baseDir, 'conversations');
    this._legacyArchivesDir = path.join(this.baseDir, 'archives');

    for (const dir of [this.workspacesDir, this.artifactsDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ── Startup ────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (fs.existsSync(this._legacyConversationsDir)) {
      await this._migrateToWorkspaces();
    }
    await this._buildLookupMap();
  }

  private async _buildLookupMap(): Promise<void> {
    this._convWorkspaceMap.clear();
    let dirs: string[];
    try {
      dirs = await fsp.readdir(this.workspacesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const hash of dirs) {
      if (hash.startsWith('.')) continue;
      const index = await this._readWorkspaceIndex(hash);
      if (!index || !index.conversations) continue;
      for (const conv of index.conversations) {
        this._convWorkspaceMap.set(conv.id, hash);
      }
    }
  }

  // ── Workspace helpers ──────────────────────────────────────────────────────

  private _newId(): string {
    return crypto.randomUUID();
  }

  private _workspaceHash(workspacePath: string): string {
    return crypto.createHash('sha256').update(workspacePath).digest('hex').substring(0, 16);
  }

  private _workspaceDir(hash: string): string {
    return path.join(this.workspacesDir, hash);
  }

  private _workspaceIndexPath(hash: string): string {
    return path.join(this._workspaceDir(hash), 'index.json');
  }

  private _sessionFilePath(hash: string, convId: string, sessionNumber: number): string {
    return path.join(this._workspaceDir(hash), convId, `session-${sessionNumber}.json`);
  }

  private async _readWorkspaceIndex(hash: string): Promise<WorkspaceIndex | null> {
    try {
      const data = await fsp.readFile(this._workspaceIndexPath(hash), 'utf8');
      return JSON.parse(data) as WorkspaceIndex;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async _writeWorkspaceIndex(hash: string, index: WorkspaceIndex): Promise<void> {
    const dir = this._workspaceDir(hash);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(this._workspaceIndexPath(hash), JSON.stringify(index, null, 2), 'utf8');
  }

  private async _readSessionFile(hash: string, convId: string, sessionNumber: number): Promise<SessionFile | null> {
    try {
      const data = await fsp.readFile(this._sessionFilePath(hash, convId, sessionNumber), 'utf8');
      return JSON.parse(data) as SessionFile;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async _writeSessionFile(hash: string, convId: string, sessionNumber: number, data: SessionFile): Promise<void> {
    const filePath = this._sessionFilePath(hash, convId, sessionNumber);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  private async _getConvFromIndex(convId: string): Promise<ConvLookupResult | null> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return null;
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return null;
    const convEntry = index.conversations.find(c => c.id === convId);
    if (!convEntry) return null;
    return { hash, index, convEntry };
  }

  private async _generateSessionSummary(
    messages: Pick<Message, 'role' | 'content'>[],
    fallback: string,
    backendId?: string,
  ): Promise<string> {
    if (!messages || messages.length === 0) return fallback || 'Empty session';
    const adapter = this._backendRegistry?.get(backendId || 'claude-code');
    if (adapter) {
      return adapter.generateSummary(messages, fallback);
    }
    return fallback || `Session (${messages.length} messages)`;
  }

  // ── Conversation CRUD ──────────────────────────────────────────────────────

  async createConversation(title?: string, workingDir?: string, backend?: string): Promise<Conversation> {
    const id = this._newId();
    const now = new Date().toISOString();
    const sessionId = this._newId();
    const workspacePath = workingDir || this._defaultWorkspace;
    const hash = this._workspaceHash(workspacePath);

    let index = await this._readWorkspaceIndex(hash);
    if (!index) {
      index = { workspacePath, conversations: [] };
    }

    const defaultBackend = this._backendRegistry?.getDefault()?.metadata.id || 'claude-code';
    const convEntry: ConversationEntry = {
      id,
      title: title || 'New Chat',
      backend: backend || defaultBackend,
      currentSessionId: sessionId,
      lastActivity: now,
      lastMessage: null,
      sessions: [{
        number: 1,
        sessionId,
        summary: null,
        active: true,
        messageCount: 0,
        startedAt: now,
        endedAt: null,
      }],
    };

    index.conversations.push(convEntry);
    await this._writeWorkspaceIndex(hash, index);

    await this._writeSessionFile(hash, id, 1, {
      sessionNumber: 1,
      sessionId,
      startedAt: now,
      endedAt: null,
      messages: [],
    });

    this._convWorkspaceMap.set(id, hash);

    return {
      id,
      title: convEntry.title,
      backend: convEntry.backend,
      workingDir: workspacePath,
      currentSessionId: sessionId,
      sessionNumber: 1,
      messages: [],
    };
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const result = await this._getConvFromIndex(id);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    const activeSession = convEntry.sessions.find(s => s.active);
    const sessionNumber = activeSession ? activeSession.number : 1;

    const sessionFile = await this._readSessionFile(hash, id, sessionNumber);
    const messages = sessionFile ? sessionFile.messages : [];

    return {
      id: convEntry.id,
      title: convEntry.title,
      backend: convEntry.backend,
      workingDir: index.workspacePath,
      currentSessionId: convEntry.currentSessionId,
      sessionNumber,
      messages,
      usage: convEntry.usage || this._emptyUsage(),
      sessionUsage: activeSession?.usage || this._emptyUsage(),
      externalSessionId: activeSession?.externalSessionId || null,
      messageQueue: convEntry.messageQueue || undefined,
    };
  }

  async listConversations(opts?: { archived?: boolean }): Promise<ConversationListItem[]> {
    const wantArchived = opts?.archived === true;
    const convs: ConversationListItem[] = [];
    let dirs: string[];
    try {
      dirs = await fsp.readdir(this.workspacesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    for (const hash of dirs) {
      if (hash.startsWith('.')) continue;
      const index = await this._readWorkspaceIndex(hash);
      if (!index || !index.conversations) continue;
      for (const conv of index.conversations) {
        const isArchived = !!conv.archived;
        if (isArchived !== wantArchived) continue;
        const activeSession = conv.sessions.find(s => s.active);
        convs.push({
          id: conv.id,
          title: conv.title,
          updatedAt: conv.lastActivity,
          backend: conv.backend,
          workingDir: index.workspacePath,
          workspaceHash: hash,
          messageCount: activeSession ? activeSession.messageCount : 0,
          lastMessage: conv.lastMessage,
          usage: conv.usage || null,
          archived: conv.archived,
        });
      }
    }

    convs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return convs;
  }

  async renameConversation(id: string, newTitle: string): Promise<Conversation | null> {
    const result = await this._getConvFromIndex(id);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    convEntry.title = newTitle;
    await this._writeWorkspaceIndex(hash, index);

    return this.getConversation(id);
  }

  async archiveConversation(id: string): Promise<boolean> {
    const result = await this._getConvFromIndex(id);
    if (!result) return false;
    const { hash, index, convEntry } = result;
    convEntry.archived = true;
    delete convEntry.messageQueue;
    await this._writeWorkspaceIndex(hash, index);
    return true;
  }

  async restoreConversation(id: string): Promise<boolean> {
    const result = await this._getConvFromIndex(id);
    if (!result) return false;
    const { hash, index, convEntry } = result;
    delete convEntry.archived;
    await this._writeWorkspaceIndex(hash, index);
    return true;
  }

  async deleteConversation(id: string): Promise<boolean> {
    const result = await this._getConvFromIndex(id);
    if (!result) return false;
    const { hash, index } = result;

    index.conversations = index.conversations.filter(c => c.id !== id);
    await this._writeWorkspaceIndex(hash, index);

    const convDir = path.join(this._workspaceDir(hash), id);
    try {
      await fsp.rm(convDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    const artifactDir = path.join(this.artifactsDir, id);
    try {
      await fsp.rm(artifactDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    this._convWorkspaceMap.delete(id);
    return true;
  }

  async updateConversationBackend(convId: string, backend: string): Promise<void> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return;
    const { hash, index, convEntry } = result;
    convEntry.backend = backend;
    await this._writeWorkspaceIndex(hash, index);
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async addMessage(
    convId: string,
    role: Message['role'],
    content: string,
    backend: string,
    thinking?: string | null,
    toolActivity?: ToolActivity[],
  ): Promise<Message | null> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    const msg: Message = {
      id: this._newId(),
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

    const activeSession = convEntry.sessions.find(s => s.active);
    const sessionNumber = activeSession ? activeSession.number : 1;

    if (role === 'user' && convEntry.title === 'New Chat' && sessionNumber <= 1) {
      convEntry.title = content.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    }

    let sessionFile = await this._readSessionFile(hash, convId, sessionNumber);
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
    await this._writeSessionFile(hash, convId, sessionNumber, sessionFile);

    convEntry.lastActivity = msg.timestamp;
    convEntry.lastMessage = content.substring(0, 100);
    if (activeSession) {
      activeSession.messageCount = sessionFile.messages.length;
    }
    await this._writeWorkspaceIndex(hash, index);

    return msg;
  }

  async updateMessageContent(convId: string, messageId: string, newContent: string): Promise<EditMessageResult | null> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    const activeSession = convEntry.sessions.find(s => s.active);
    const sessionNumber = activeSession ? activeSession.number : 1;

    const sessionFile = await this._readSessionFile(hash, convId, sessionNumber);
    if (!sessionFile) return null;

    const msgIndex = sessionFile.messages.findIndex(m => m.id === messageId);
    if (msgIndex === -1) return null;

    sessionFile.messages = sessionFile.messages.slice(0, msgIndex);

    const msg: Message = {
      id: this._newId(),
      role: 'user',
      content: newContent,
      backend: convEntry.backend,
      timestamp: new Date().toISOString(),
    };
    sessionFile.messages.push(msg);
    await this._writeSessionFile(hash, convId, sessionNumber, sessionFile);

    if (activeSession) {
      activeSession.messageCount = sessionFile.messages.length;
    }
    convEntry.lastActivity = msg.timestamp;
    convEntry.lastMessage = newContent.substring(0, 100);
    await this._writeWorkspaceIndex(hash, index);

    const conversation = await this.getConversation(convId);
    return { conversation: conversation!, message: msg };
  }

  async generateAndUpdateTitle(convId: string, userMessage: string): Promise<string | null> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    const adapter = this._backendRegistry?.get(convEntry.backend || 'claude-code');
    const fallback = userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    let newTitle: string;
    if (adapter && typeof adapter.generateTitle === 'function') {
      newTitle = await adapter.generateTitle(userMessage, fallback);
    } else {
      newTitle = fallback;
    }

    convEntry.title = newTitle;
    await this._writeWorkspaceIndex(hash, index);

    return newTitle;
  }

  // ── Message Queue Persistence ──────────────────────────────────────────────

  async getQueue(convId: string): Promise<string[]> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return [];
    return result.convEntry.messageQueue || [];
  }

  async setQueue(convId: string, queue: string[]): Promise<boolean> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return false;
    const { hash, index, convEntry } = result;
    if (queue.length === 0) {
      delete convEntry.messageQueue;
    } else {
      convEntry.messageQueue = queue;
    }
    await this._writeWorkspaceIndex(hash, index);
    return true;
  }

  async clearQueue(convId: string): Promise<boolean> {
    return this.setQueue(convId, []);
  }

  // ── Session Management ─────────────────────────────────────────────────────

  async resetSession(convId: string): Promise<ResetSessionResult | null> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    const now = new Date();
    const activeSession = convEntry.sessions.find(s => s.active);
    if (!activeSession) return null;

    const currentSessionNumber = activeSession.number;

    const sessionFile = await this._readSessionFile(hash, convId, currentSessionNumber);
    const currentMessages = sessionFile ? sessionFile.messages : [];

    const fallback = `Session ${currentSessionNumber} (${currentMessages.length} messages)`;
    const summary = await this._generateSessionSummary(currentMessages, fallback, convEntry.backend);

    activeSession.active = false;
    activeSession.summary = summary;
    activeSession.endedAt = now.toISOString();
    activeSession.messageCount = currentMessages.length;

    if (sessionFile) {
      sessionFile.endedAt = now.toISOString();
      await this._writeSessionFile(hash, convId, currentSessionNumber, sessionFile);
    }

    const newSessionNumber = currentSessionNumber + 1;
    const newSessionId = this._newId();

    delete convEntry.messageQueue;
    convEntry.currentSessionId = newSessionId;
    convEntry.title = 'New Chat';
    convEntry.sessions.push({
      number: newSessionNumber,
      sessionId: newSessionId,
      summary: null,
      active: true,
      messageCount: 0,
      startedAt: now.toISOString(),
      endedAt: null,
    });

    await this._writeSessionFile(hash, convId, newSessionNumber, {
      sessionNumber: newSessionNumber,
      sessionId: newSessionId,
      startedAt: now.toISOString(),
      endedAt: null,
      messages: [],
    });

    await this._writeWorkspaceIndex(hash, index);

    const conversation = await this.getConversation(convId);
    return {
      conversation: conversation!,
      newSessionNumber,
      archivedSession: {
        number: currentSessionNumber,
        sessionId: activeSession.sessionId || null,
        startedAt: activeSession.startedAt,
        endedAt: now.toISOString(),
        messageCount: currentMessages.length,
        summary,
      },
    };
  }

  async getSessionHistory(convId: string): Promise<SessionHistoryItem[] | null> {
    const result = await this._getConvFromIndex(convId);
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
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash } = result;

    const sessionFile = await this._readSessionFile(hash, convId, sessionNumber);
    return sessionFile ? sessionFile.messages : null;
  }

  // ── Markdown Export ────────────────────────────────────────────────────────

  async sessionToMarkdown(convId: string, sessionNumber: number): Promise<string | null> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash, convEntry } = result;

    const sessionFile = await this._readSessionFile(hash, convId, sessionNumber);
    if (!sessionFile) return null;

    const sessionMeta = { number: sessionNumber, startedAt: sessionFile.startedAt };
    return this._messagesToMarkdown(convEntry.title, convId, sessionMeta, sessionFile.messages);
  }

  private _messagesToMarkdown(
    title: string,
    convId: string,
    sessionMeta: { number: number; startedAt: string },
    messages: Message[],
  ): string {
    const lines = [
      `# ${title}`,
      ``,
      `**Session ${sessionMeta.number}** | Started: ${sessionMeta.startedAt}`,
      `**Conversation ID:** ${convId}`,
      ``,
      `---`,
      ``,
    ];

    for (const msg of messages) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const time = new Date(msg.timestamp).toLocaleString();
      lines.push(`### ${role} — ${time}`);
      if (msg.backend) lines.push(`*Backend: ${msg.backend}*`);
      lines.push(``);
      lines.push(msg.content);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }

    return lines.join('\n');
  }

  async conversationToMarkdown(convId: string): Promise<string | null> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash, convEntry } = result;

    const lines = [
      `# ${convEntry.title}`,
      ``,
      `**Backend:** ${convEntry.backend}`,
      ``,
      `---`,
      ``,
    ];

    for (const session of convEntry.sessions) {
      const sessionFile = await this._readSessionFile(hash, convId, session.number);
      if (!sessionFile || !sessionFile.messages.length) continue;

      const label = session.active ? `Session ${session.number} (current)` : `Session ${session.number}`;
      lines.push(`## ${label}`);
      lines.push(``);

      for (const msg of sessionFile.messages) {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        const time = new Date(msg.timestamp).toLocaleString();
        lines.push(`### ${role} — ${time}`);
        if (msg.backend) lines.push(`*Backend: ${msg.backend}*`);
        lines.push(``);
        lines.push(msg.content);
        lines.push(``);
      }

      if (!session.active) {
        lines.push(`---`);
        lines.push(`*Session reset — ${new Date(session.endedAt!).toLocaleString()}*`);
        lines.push(`---`);
        lines.push(``);
      }
    }

    return lines.join('\n');
  }

  // ── Workspace Instructions ──────────────────────────────────────────────────

  async getWorkspaceInstructions(hash: string): Promise<string | null> {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return null;
    return index.instructions || '';
  }

  async setWorkspaceInstructions(hash: string, instructions: string): Promise<string | null> {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return null;
    index.instructions = instructions || '';
    await this._writeWorkspaceIndex(hash, index);
    return index.instructions;
  }

  getWorkspaceHashForConv(convId: string): string | null {
    return this._convWorkspaceMap.get(convId) || null;
  }

  // ── Workspace Context ──────────────────────────────────────────────────────

  getWorkspaceContext(convId: string): string | null {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return null;
    const absPath = path.resolve(this._workspaceDir(hash));
    return [
      `[Workspace discussion history is available at ${absPath}/`,
      `Read index.json for all past and current conversations in this workspace with per-session summaries.`,
      `Each conversation subfolder contains session-N.json files with full message histories.`,
      `When the user references previous work, decisions, or discussions, consult the relevant session files for context.]`,
    ].join('\n');
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async searchConversations(query: string, opts?: { archived?: boolean }): Promise<ConversationListItem[]> {
    if (!query) return this.listConversations(opts);
    const q = query.toLowerCase();
    const all = await this.listConversations(opts);
    const results: ConversationListItem[] = [];

    for (const c of all) {
      if (c.title.toLowerCase().includes(q)) { results.push(c); continue; }
      if (c.lastMessage && c.lastMessage.toLowerCase().includes(q)) { results.push(c); continue; }
      const result = await this._getConvFromIndex(c.id);
      if (!result) continue;
      const { hash, convEntry } = result;
      let found = false;
      for (const session of convEntry.sessions) {
        const sessionFile = await this._readSessionFile(hash, c.id, session.number);
        if (!sessionFile) continue;
        if (sessionFile.messages.some(m => m.content.toLowerCase().includes(q))) {
          found = true;
          break;
        }
      }
      if (found) results.push(c);
    }

    return results;
  }

  // ── Migration ──────────────────────────────────────────────────────────────

  private async _migrateToWorkspaces(): Promise<void> {
    let files: string[];
    try {
      files = await fsp.readdir(this._legacyConversationsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    files = files.filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      await this._renameLegacyDirs();
      return;
    }

    const workspaceGroups = new Map<string, { workspacePath: string; convs: LegacyConversation[] }>();

    for (const f of files) {
      const convId = f.replace('.json', '');
      try {
        const data = await fsp.readFile(path.join(this._legacyConversationsDir, f), 'utf8');
        const conv = JSON.parse(data) as LegacyConversation;
        const workspacePath = conv.workingDir || this._defaultWorkspace;
        const hash = this._workspaceHash(workspacePath);

        if (!workspaceGroups.has(hash)) {
          workspaceGroups.set(hash, { workspacePath, convs: [] });
        }
        workspaceGroups.get(hash)!.convs.push(conv);
      } catch (err: unknown) {
        console.error(`[migration] Failed to read conversation ${convId}:`, (err as Error).message);
      }
    }

    for (const [hash, group] of workspaceGroups) {
      const index: WorkspaceIndex = {
        workspacePath: group.workspacePath,
        conversations: [],
      };

      for (const conv of group.convs) {
        const convId = conv.id;
        const sessions: SessionEntry[] = [];

        let oldArchiveIndex: { sessions: LegacyArchiveSession[] } = { sessions: [] };
        try {
          const archiveIndexPath = path.join(this._legacyArchivesDir, convId, 'index.json');
          const data = await fsp.readFile(archiveIndexPath, 'utf8');
          oldArchiveIndex = JSON.parse(data);
        } catch {
          // No archive
        }

        for (const oldSession of oldArchiveIndex.sessions) {
          let sessionData: SessionFile;
          try {
            const oldPath = path.join(this._legacyArchivesDir, convId, `session-${oldSession.number}.json`);
            const data = await fsp.readFile(oldPath, 'utf8');
            sessionData = JSON.parse(data) as SessionFile;
          } catch {
            continue;
          }

          await this._writeSessionFile(hash, convId, oldSession.number, sessionData);

          sessions.push({
            number: oldSession.number,
            sessionId: oldSession.sessionId || sessionData.sessionId || '',
            summary: oldSession.summary || '(Migrated session)',
            active: false,
            messageCount: oldSession.messageCount || (sessionData.messages ? sessionData.messages.length : 0),
            startedAt: oldSession.startedAt || sessionData.startedAt,
            endedAt: oldSession.endedAt || sessionData.endedAt,
          });
        }

        if (conv.sessions && conv.sessions.length > 0) {
          const hasDividers = conv.messages.some(m => m.isSessionDivider);
          if (hasDividers) {
            const dividerIndices: number[] = [];
            for (let i = 0; i < conv.messages.length; i++) {
              if (conv.messages[i].isSessionDivider) dividerIndices.push(i);
            }

            for (const session of conv.sessions) {
              if (!session.endedAt) continue;
              if (sessions.some(s => s.number === session.number)) continue;

              let start: number, end: number;
              if (session.number === 1) {
                start = 0;
                end = dividerIndices.length > 0 ? dividerIndices[0] : conv.messages.length;
              } else {
                const divIdx = dividerIndices[session.number - 2];
                if (divIdx === undefined) continue;
                start = divIdx + 1;
                const nextDiv = dividerIndices[session.number - 1];
                end = nextDiv !== undefined ? nextDiv : conv.messages.length;
              }

              const sessionMessages = conv.messages.slice(start, end).filter(m => !m.isSessionDivider) as Message[];
              const sessionData: SessionFile = {
                sessionNumber: session.number,
                sessionId: session.sessionId,
                startedAt: session.startedAt,
                endedAt: session.endedAt,
                messages: sessionMessages,
              };
              await this._writeSessionFile(hash, convId, session.number, sessionData);

              sessions.push({
                number: session.number,
                sessionId: session.sessionId || '',
                summary: '(Migrated session)',
                active: false,
                messageCount: sessionMessages.length,
                startedAt: session.startedAt,
                endedAt: session.endedAt,
              });
            }
          }
        }

        let currentMessages: Message[];
        if (conv.sessions && conv.sessions.length > 0) {
          const lastDividerIdx = conv.messages.reduce((acc: number, m: LegacyMessage, i: number) => m.isSessionDivider ? i : acc, -1);
          currentMessages = lastDividerIdx >= 0
            ? conv.messages.slice(lastDividerIdx + 1).filter(m => !m.isSessionDivider) as Message[]
            : conv.messages.filter(m => !m.isSessionDivider) as Message[];
        } else {
          currentMessages = (conv.messages || []).filter(m => !m.isSessionDivider) as Message[];
        }

        const sessionNumber = conv.sessionNumber || 1;
        const currentSessionId = conv.currentSessionId || this._newId();

        const currentStartedAt = currentMessages.length > 0
          ? currentMessages[0].timestamp
          : (conv.updatedAt || new Date().toISOString());
        await this._writeSessionFile(hash, convId, sessionNumber, {
          sessionNumber,
          sessionId: currentSessionId,
          startedAt: currentStartedAt,
          endedAt: null,
          messages: currentMessages,
        });

        sessions.push({
          number: sessionNumber,
          sessionId: currentSessionId,
          summary: null,
          active: true,
          messageCount: currentMessages.length,
          startedAt: currentStartedAt,
          endedAt: null,
        });

        sessions.sort((a, b) => a.number - b.number);

        const lastMsg = currentMessages.length > 0
          ? currentMessages[currentMessages.length - 1].content.substring(0, 100)
          : null;

        index.conversations.push({
          id: convId,
          title: conv.title,
          backend: conv.backend || 'claude-code',
          currentSessionId,
          lastActivity: conv.updatedAt || new Date().toISOString(),
          lastMessage: lastMsg,
          sessions,
        });
      }

      await this._writeWorkspaceIndex(hash, index);
    }

    await this._renameLegacyDirs();
    console.log(`[migration] Migrated ${files.length} conversation(s) to workspace format`);
  }

  private async _renameLegacyDirs(): Promise<void> {
    for (const [oldName, backupName] of [
      [this._legacyConversationsDir, this._legacyConversationsDir + '_backup'],
      [this._legacyArchivesDir, this._legacyArchivesDir + '_backup'],
    ] as const) {
      try {
        if (fs.existsSync(oldName)) {
          await fsp.rename(oldName, backupName);
        }
      } catch (err: unknown) {
        console.error(`[migration] Failed to rename ${oldName}:`, (err as Error).message);
      }
    }
  }

  // ── Usage Tracking ─────────────────────────────────────────────────────────

  private _emptyUsage(): Usage {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  }

  private _addToUsage(target: Usage, source: Usage): void {
    target.inputTokens += source.inputTokens || 0;
    target.outputTokens += source.outputTokens || 0;
    target.cacheReadTokens += source.cacheReadTokens || 0;
    target.cacheWriteTokens += source.cacheWriteTokens || 0;
    target.costUsd += source.costUsd || 0;
  }

  async addUsage(convId: string, usage: Usage, backend?: string, model?: string): Promise<{ conversationUsage: Usage; sessionUsage: Usage } | null> {
    if (!usage) return null;
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    // Conversation-level totals
    if (!convEntry.usage) convEntry.usage = this._emptyUsage();
    this._addToUsage(convEntry.usage, usage);

    // Per-backend on conversation
    const backendId = backend || convEntry.backend;
    if (!convEntry.usageByBackend) convEntry.usageByBackend = {};
    if (!convEntry.usageByBackend[backendId]) convEntry.usageByBackend[backendId] = this._emptyUsage();
    this._addToUsage(convEntry.usageByBackend[backendId], usage);

    // Session-level totals + per-backend
    let sessionUsage = this._emptyUsage();
    const activeSession = convEntry.sessions.find(s => s.active);
    if (activeSession) {
      if (!activeSession.usage) activeSession.usage = this._emptyUsage();
      this._addToUsage(activeSession.usage, usage);
      sessionUsage = activeSession.usage;

      if (!activeSession.usageByBackend) activeSession.usageByBackend = {};
      if (!activeSession.usageByBackend[backendId]) activeSession.usageByBackend[backendId] = this._emptyUsage();
      this._addToUsage(activeSession.usageByBackend[backendId], usage);
    }

    await this._writeWorkspaceIndex(hash, index);

    // Record to daily ledger (fire-and-forget, don't block the response)
    this._recordToLedger(backendId, model || 'unknown', usage).catch(err => {
      console.error('[usage] Failed to write ledger:', (err as Error).message);
    });

    return { conversationUsage: convEntry.usage, sessionUsage };
  }

  async getUsage(convId: string): Promise<Usage | null> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { convEntry } = result;
    return convEntry.usage || this._emptyUsage();
  }

  // ── Usage Ledger ──────────────────────────────────────────────────────────

  private async _readLedger(): Promise<UsageLedger> {
    try {
      const data = await fsp.readFile(this.usageLedgerFile, 'utf8');
      return JSON.parse(data) as UsageLedger;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { days: [] };
      throw err;
    }
  }

  private async _writeLedger(ledger: UsageLedger): Promise<void> {
    await fsp.writeFile(this.usageLedgerFile, JSON.stringify(ledger, null, 2), 'utf8');
  }

  private async _recordToLedger(backendId: string, model: string, usage: Usage): Promise<void> {
    const ledger = await this._readLedger();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    let dayEntry = ledger.days.find(d => d.date === today);
    if (!dayEntry) {
      dayEntry = { date: today, records: [] };
      ledger.days.push(dayEntry);
    }

    // Migrate old format: if day has 'backends' but no 'records', convert
    if ((dayEntry as any).backends && !dayEntry.records) {
      dayEntry.records = [];
      for (const [bid, u] of Object.entries((dayEntry as any).backends)) {
        dayEntry.records.push({ backend: bid, model: 'unknown', usage: u as Usage });
      }
      delete (dayEntry as any).backends;
    }

    let record = dayEntry.records.find(r => r.backend === backendId && r.model === model);
    if (!record) {
      record = { backend: backendId, model, usage: this._emptyUsage() };
      dayEntry.records.push(record);
    }
    this._addToUsage(record.usage, usage);

    await this._writeLedger(ledger);
  }

  async getUsageStats(): Promise<UsageLedger> {
    return this._readLedger();
  }

  async clearUsageStats(): Promise<void> {
    await this._writeLedger({ days: [] });
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async getSettings(): Promise<Settings> {
    try {
      const data = await fsp.readFile(this.settingsFile, 'utf8');
      const settings = JSON.parse(data) as Settings;

      if (settings.customInstructions && settings.systemPrompt === undefined) {
        const parts: string[] = [];
        if (settings.customInstructions.aboutUser) {
          parts.push(settings.customInstructions.aboutUser.trim());
        }
        if (settings.customInstructions.responseStyle) {
          parts.push(settings.customInstructions.responseStyle.trim());
        }
        settings.systemPrompt = parts.join('\n\n');
        delete settings.customInstructions;
        await this.saveSettings(settings);
      }

      return settings;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          theme: 'system',
          sendBehavior: 'enter',
          systemPrompt: '',
          defaultBackend: 'claude-code',
          workingDirectory: '',
        };
      }
      throw err;
    }
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    await fsp.writeFile(this.settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    return settings;
  }
}

// ── Legacy types for migration ───────────────────────────────────────────────

interface LegacyMessage extends Message {
  isSessionDivider?: boolean;
}

interface LegacySession {
  number: number;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
}

interface LegacyConversation {
  id: string;
  title: string;
  backend: string;
  workingDir?: string;
  currentSessionId?: string;
  sessionNumber?: number;
  updatedAt?: string;
  messages: LegacyMessage[];
  sessions: LegacySession[];
}

interface LegacyArchiveSession {
  number: number;
  sessionId?: string;
  summary?: string;
  messageCount?: number;
  startedAt: string;
  endedAt: string | null;
}
