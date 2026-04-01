const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const DEFAULT_WORKSPACE_FALLBACK = '/tmp/default-workspace';

class ChatService {
  constructor(appRoot, options = {}) {
    this.baseDir = path.join(appRoot, 'data', 'chat');
    this.workspacesDir = path.join(this.baseDir, 'workspaces');
    this.artifactsDir = path.join(this.baseDir, 'artifacts');
    this.settingsFile = path.join(this.baseDir, 'settings.json');
    this._defaultWorkspace = options.defaultWorkspace || DEFAULT_WORKSPACE_FALLBACK;
    this._backendRegistry = options.backendRegistry || null;
    this._convWorkspaceMap = new Map(); // convId -> workspaceHash

    // Old dirs — kept as properties for migration detection
    this._legacyConversationsDir = path.join(this.baseDir, 'conversations');
    this._legacyArchivesDir = path.join(this.baseDir, 'archives');

    // Ensure directories exist (sync in constructor only — runs once at startup)
    for (const dir of [this.workspacesDir, this.artifactsDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ── Startup ────────────────────────────────────────────────────────────────

  async initialize() {
    // Run migration if old format exists
    if (fs.existsSync(this._legacyConversationsDir)) {
      await this._migrateToWorkspaces();
    }
    // Build convId -> workspaceHash lookup map
    await this._buildLookupMap();
  }

  async _buildLookupMap() {
    this._convWorkspaceMap.clear();
    let dirs;
    try {
      dirs = await fsp.readdir(this.workspacesDir);
    } catch (err) {
      if (err.code === 'ENOENT') return;
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

  _newId() {
    return crypto.randomUUID();
  }

  _workspaceHash(workspacePath) {
    return crypto.createHash('sha256').update(workspacePath).digest('hex').substring(0, 16);
  }

  _workspaceDir(hash) {
    return path.join(this.workspacesDir, hash);
  }

  _workspaceIndexPath(hash) {
    return path.join(this._workspaceDir(hash), 'index.json');
  }

  _sessionFilePath(hash, convId, sessionNumber) {
    return path.join(this._workspaceDir(hash), convId, `session-${sessionNumber}.json`);
  }

  async _readWorkspaceIndex(hash) {
    try {
      const data = await fsp.readFile(this._workspaceIndexPath(hash), 'utf8');
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async _writeWorkspaceIndex(hash, index) {
    const dir = this._workspaceDir(hash);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(this._workspaceIndexPath(hash), JSON.stringify(index, null, 2), 'utf8');
  }

  async _readSessionFile(hash, convId, sessionNumber) {
    try {
      const data = await fsp.readFile(this._sessionFilePath(hash, convId, sessionNumber), 'utf8');
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async _writeSessionFile(hash, convId, sessionNumber, data) {
    const filePath = this._sessionFilePath(hash, convId, sessionNumber);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  async _getConvFromIndex(convId) {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return null;
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return null;
    const convEntry = index.conversations.find(c => c.id === convId);
    if (!convEntry) return null;
    return { hash, index, convEntry };
  }

  async _generateSessionSummary(messages, fallback, backendId) {
    if (!messages || messages.length === 0) return fallback || 'Empty session';
    const adapter = this._backendRegistry?.get(backendId || 'claude-code');
    if (adapter) {
      return adapter.generateSummary(messages, fallback);
    }
    return fallback || `Session (${messages.length} messages)`;
  }

  // ── Conversation CRUD ──────────────────────────────────────────────────────

  async createConversation(title, workingDir) {
    const id = this._newId();
    const now = new Date().toISOString();
    const sessionId = this._newId();
    const workspacePath = workingDir || this._defaultWorkspace;
    const hash = this._workspaceHash(workspacePath);

    // Read or create workspace index
    let index = await this._readWorkspaceIndex(hash);
    if (!index) {
      index = { workspacePath, conversations: [] };
    }

    const convEntry = {
      id,
      title: title || 'New Chat',
      backend: 'claude-code',
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

    // Write empty session file
    await this._writeSessionFile(hash, id, 1, {
      sessionNumber: 1,
      sessionId,
      startedAt: now,
      endedAt: null,
      messages: [],
    });

    // Update lookup map
    this._convWorkspaceMap.set(id, hash);

    // Return API-compatible shape
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

  async getConversation(id) {
    const result = await this._getConvFromIndex(id);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    // Find active session
    const activeSession = convEntry.sessions.find(s => s.active);
    const sessionNumber = activeSession ? activeSession.number : 1;

    // Read active session file
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
    };
  }

  async listConversations() {
    const convs = [];
    let dirs;
    try {
      dirs = await fsp.readdir(this.workspacesDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    for (const hash of dirs) {
      if (hash.startsWith('.')) continue;
      const index = await this._readWorkspaceIndex(hash);
      if (!index || !index.conversations) continue;
      for (const conv of index.conversations) {
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
        });
      }
    }

    convs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return convs;
  }

  async renameConversation(id, newTitle) {
    const result = await this._getConvFromIndex(id);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    convEntry.title = newTitle;
    await this._writeWorkspaceIndex(hash, index);

    return this.getConversation(id);
  }

  async deleteConversation(id) {
    const result = await this._getConvFromIndex(id);
    if (!result) return false;
    const { hash, index } = result;

    // Remove from workspace index
    index.conversations = index.conversations.filter(c => c.id !== id);
    await this._writeWorkspaceIndex(hash, index);

    // Delete conversation folder (session files)
    const convDir = path.join(this._workspaceDir(hash), id);
    try {
      await fsp.rm(convDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    // Clean up artifacts
    const artifactDir = path.join(this.artifactsDir, id);
    try {
      await fsp.rm(artifactDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    // Remove from lookup map
    this._convWorkspaceMap.delete(id);

    return true;
  }

  async updateConversationBackend(convId, backend) {
    const result = await this._getConvFromIndex(convId);
    if (!result) return;
    const { hash, index, convEntry } = result;
    convEntry.backend = backend;
    await this._writeWorkspaceIndex(hash, index);
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async addMessage(convId, role, content, backend, thinking) {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    const msg = {
      id: this._newId(),
      role,
      content,
      backend: backend || convEntry.backend,
      timestamp: new Date().toISOString(),
    };

    if (thinking) {
      msg.thinking = thinking;
    }

    // Auto-title from first user message (only if still default title)
    if (role === 'user' && convEntry.title === 'New Chat') {
      convEntry.title = content.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    }

    // Find active session
    const activeSession = convEntry.sessions.find(s => s.active);
    const sessionNumber = activeSession ? activeSession.number : 1;

    // Read session file, add message, write back
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

    // Update workspace index
    convEntry.lastActivity = msg.timestamp;
    convEntry.lastMessage = content.substring(0, 100);
    if (activeSession) {
      activeSession.messageCount = sessionFile.messages.length;
    }
    await this._writeWorkspaceIndex(hash, index);

    return msg;
  }

  async updateMessageContent(convId, messageId, newContent) {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    const activeSession = convEntry.sessions.find(s => s.active);
    const sessionNumber = activeSession ? activeSession.number : 1;

    const sessionFile = await this._readSessionFile(hash, convId, sessionNumber);
    if (!sessionFile) return null;

    const msgIndex = sessionFile.messages.findIndex(m => m.id === messageId);
    if (msgIndex === -1) return null;

    // Truncate messages after this one (fork conversation)
    sessionFile.messages = sessionFile.messages.slice(0, msgIndex);

    // Add the edited message as a new one
    const msg = {
      id: this._newId(),
      role: 'user',
      content: newContent,
      backend: convEntry.backend,
      timestamp: new Date().toISOString(),
    };
    sessionFile.messages.push(msg);
    await this._writeSessionFile(hash, convId, sessionNumber, sessionFile);

    // Update index
    if (activeSession) {
      activeSession.messageCount = sessionFile.messages.length;
    }
    convEntry.lastActivity = msg.timestamp;
    convEntry.lastMessage = newContent.substring(0, 100);
    await this._writeWorkspaceIndex(hash, index);

    const conversation = await this.getConversation(convId);
    return { conversation, message: msg };
  }

  async generateAndUpdateTitle(convId, userMessage) {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    const adapter = this._backendRegistry?.get(convEntry.backend || 'claude-code');
    const fallback = userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    let newTitle;
    if (adapter && typeof adapter.generateTitle === 'function') {
      newTitle = await adapter.generateTitle(userMessage, fallback);
    } else {
      newTitle = fallback;
    }

    convEntry.title = newTitle;
    await this._writeWorkspaceIndex(hash, index);

    return newTitle;
  }

  // ── Session Management ─────────────────────────────────────────────────────

  async resetSession(convId) {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    const now = new Date();
    const activeSession = convEntry.sessions.find(s => s.active);
    if (!activeSession) return null;

    const currentSessionNumber = activeSession.number;

    // Read current session file
    const sessionFile = await this._readSessionFile(hash, convId, currentSessionNumber);
    const currentMessages = sessionFile ? sessionFile.messages : [];

    // Generate summary via backend adapter
    const fallback = `Session ${currentSessionNumber} (${currentMessages.length} messages)`;
    const summary = await this._generateSessionSummary(currentMessages, fallback, convEntry.backend);

    // Mark current session as inactive in index
    activeSession.active = false;
    activeSession.summary = summary;
    activeSession.endedAt = now.toISOString();
    activeSession.messageCount = currentMessages.length;

    // Update session file with endedAt
    if (sessionFile) {
      sessionFile.endedAt = now.toISOString();
      await this._writeSessionFile(hash, convId, currentSessionNumber, sessionFile);
    }

    // Create new session
    const newSessionNumber = currentSessionNumber + 1;
    const newSessionId = this._newId();

    convEntry.currentSessionId = newSessionId;
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

    // Return compatible shape
    const conversation = await this.getConversation(convId);
    return {
      conversation,
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

  async getSessionHistory(convId) {
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

  async getSessionMessages(convId, sessionNumber) {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash } = result;

    const sessionFile = await this._readSessionFile(hash, convId, sessionNumber);
    return sessionFile ? sessionFile.messages : null;
  }

  // ── Markdown Export ────────────────────────────────────────────────────────

  async sessionToMarkdown(convId, sessionNumber) {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { hash, convEntry } = result;

    const sessionFile = await this._readSessionFile(hash, convId, sessionNumber);
    if (!sessionFile) return null;

    const sessionMeta = { number: sessionNumber, startedAt: sessionFile.startedAt };
    return this._messagesToMarkdown(convEntry.title, convId, sessionMeta, sessionFile.messages);
  }

  _messagesToMarkdown(title, convId, sessionMeta, messages) {
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

  async conversationToMarkdown(convId) {
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
        lines.push(`*Session reset — ${new Date(session.endedAt).toLocaleString()}*`);
        lines.push(`---`);
        lines.push(``);
      }
    }

    return lines.join('\n');
  }

  // ── Workspace Instructions ──────────────────────────────────────────────────

  async getWorkspaceInstructions(hash) {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return null;
    return index.instructions || '';
  }

  async setWorkspaceInstructions(hash, instructions) {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return null;
    index.instructions = instructions || '';
    await this._writeWorkspaceIndex(hash, index);
    return index.instructions;
  }

  getWorkspaceHashForConv(convId) {
    return this._convWorkspaceMap.get(convId) || null;
  }

  // ── Workspace Context ──────────────────────────────────────────────────────

  getWorkspaceContext(convId) {
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

  async searchConversations(query) {
    if (!query) return this.listConversations();
    const q = query.toLowerCase();
    const all = await this.listConversations();
    const results = [];

    for (const c of all) {
      if (c.title.toLowerCase().includes(q)) { results.push(c); continue; }
      if (c.lastMessage && c.lastMessage.toLowerCase().includes(q)) { results.push(c); continue; }
      // Deep search: load all session files
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

  async _migrateToWorkspaces() {
    let files;
    try {
      files = await fsp.readdir(this._legacyConversationsDir);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    files = files.filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      await this._renameLegacyDirs();
      return;
    }

    // Group conversations by workspace
    const workspaceGroups = new Map(); // hash -> { workspacePath, convs: [] }

    for (const f of files) {
      const convId = f.replace('.json', '');
      try {
        const data = await fsp.readFile(path.join(this._legacyConversationsDir, f), 'utf8');
        const conv = JSON.parse(data);
        const workspacePath = conv.workingDir || this._defaultWorkspace;
        const hash = this._workspaceHash(workspacePath);

        if (!workspaceGroups.has(hash)) {
          workspaceGroups.set(hash, { workspacePath, convs: [] });
        }
        workspaceGroups.get(hash).convs.push(conv);
      } catch (err) {
        console.error(`[migration] Failed to read conversation ${convId}:`, err.message);
      }
    }

    // Process each workspace group
    for (const [hash, group] of workspaceGroups) {
      const index = {
        workspacePath: group.workspacePath,
        conversations: [],
      };

      for (const conv of group.convs) {
        const convId = conv.id;
        const sessions = [];

        // Read old archive index if exists
        let oldArchiveIndex = { sessions: [] };
        try {
          const archiveIndexPath = path.join(this._legacyArchivesDir, convId, 'index.json');
          const data = await fsp.readFile(archiveIndexPath, 'utf8');
          oldArchiveIndex = JSON.parse(data);
        } catch {
          // No archive — that's fine
        }

        // Copy archived sessions
        for (const oldSession of oldArchiveIndex.sessions) {
          let sessionData;
          try {
            const oldPath = path.join(this._legacyArchivesDir, convId, `session-${oldSession.number}.json`);
            const data = await fsp.readFile(oldPath, 'utf8');
            sessionData = JSON.parse(data);
          } catch {
            continue;
          }

          await this._writeSessionFile(hash, convId, oldSession.number, sessionData);

          sessions.push({
            number: oldSession.number,
            sessionId: oldSession.sessionId || sessionData.sessionId || null,
            summary: oldSession.summary || '(Migrated session)',
            active: false,
            messageCount: oldSession.messageCount || (sessionData.messages ? sessionData.messages.length : 0),
            startedAt: oldSession.startedAt || sessionData.startedAt,
            endedAt: oldSession.endedAt || sessionData.endedAt,
          });
        }

        // Handle legacy sessions array with dividers (pre-archive migration)
        if (conv.sessions && conv.sessions.length > 0) {
          const hasDividers = conv.messages.some(m => m.isSessionDivider);
          if (hasDividers) {
            const dividerIndices = [];
            for (let i = 0; i < conv.messages.length; i++) {
              if (conv.messages[i].isSessionDivider) dividerIndices.push(i);
            }

            for (const session of conv.sessions) {
              if (!session.endedAt) continue;
              if (sessions.some(s => s.number === session.number)) continue;

              let start, end;
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

              const sessionMessages = conv.messages.slice(start, end).filter(m => !m.isSessionDivider);
              const sessionData = {
                sessionNumber: session.number,
                sessionId: session.sessionId,
                startedAt: session.startedAt,
                endedAt: session.endedAt,
                messages: sessionMessages,
              };
              await this._writeSessionFile(hash, convId, session.number, sessionData);

              sessions.push({
                number: session.number,
                sessionId: session.sessionId || null,
                summary: '(Migrated session)',
                active: false,
                messageCount: sessionMessages.length,
                startedAt: session.startedAt,
                endedAt: session.endedAt,
              });
            }
          }
        }

        // Current session messages
        let currentMessages;
        if (conv.sessions && conv.sessions.length > 0) {
          const lastDividerIdx = conv.messages.reduce((acc, m, i) => m.isSessionDivider ? i : acc, -1);
          currentMessages = lastDividerIdx >= 0
            ? conv.messages.slice(lastDividerIdx + 1).filter(m => !m.isSessionDivider)
            : conv.messages.filter(m => !m.isSessionDivider);
        } else {
          currentMessages = (conv.messages || []).filter(m => !m.isSessionDivider);
        }

        const sessionNumber = conv.sessionNumber || 1;
        const currentSessionId = conv.currentSessionId || this._newId();

        // Write current session file
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

        // Sort sessions by number
        sessions.sort((a, b) => a.number - b.number);

        // Compute lastMessage
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

  async _renameLegacyDirs() {
    for (const [oldName, backupName] of [
      [this._legacyConversationsDir, this._legacyConversationsDir + '_backup'],
      [this._legacyArchivesDir, this._legacyArchivesDir + '_backup'],
    ]) {
      try {
        if (fs.existsSync(oldName)) {
          await fsp.rename(oldName, backupName);
        }
      } catch (err) {
        console.error(`[migration] Failed to rename ${oldName}:`, err.message);
      }
    }
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async getSettings() {
    try {
      const data = await fsp.readFile(this.settingsFile, 'utf8');
      const settings = JSON.parse(data);

      // Migrate legacy customInstructions to systemPrompt
      if (settings.customInstructions && settings.systemPrompt === undefined) {
        const parts = [];
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
    } catch (err) {
      if (err.code === 'ENOENT') {
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

  async saveSettings(settings) {
    await fsp.writeFile(this.settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    return settings;
  }
}

module.exports = { ChatService };
