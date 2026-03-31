const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

class ChatService {
  constructor(appRoot) {
    this.baseDir = path.join(appRoot, 'data', 'chat');
    this.conversationsDir = path.join(this.baseDir, 'conversations');
    this.archivesDir = path.join(this.baseDir, 'archives');
    this.artifactsDir = path.join(this.baseDir, 'artifacts');
    this.settingsFile = path.join(this.baseDir, 'settings.json');

    // Ensure directories exist (sync in constructor only — runs once at startup)
    for (const dir of [this.conversationsDir, this.archivesDir, this.artifactsDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ── Conversation CRUD ──────────────────────────────────────────────────────

  _convPath(id) {
    return path.join(this.conversationsDir, `${id}.json`);
  }

  _newId() {
    return crypto.randomUUID();
  }

  // ── Archive helpers ────────────────────────────────────────────────────────

  _archiveDir(convId) {
    return path.join(this.archivesDir, convId);
  }

  _archiveIndexPath(convId) {
    return path.join(this._archiveDir(convId), 'index.json');
  }

  _sessionArchivePath(convId, sessionNumber) {
    return path.join(this._archiveDir(convId), `session-${sessionNumber}.json`);
  }

  async _readArchiveIndex(convId) {
    try {
      const data = await fsp.readFile(this._archiveIndexPath(convId), 'utf8');
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') return { conversationId: convId, conversationTitle: '', sessions: [] };
      throw err;
    }
  }

  async _writeArchiveIndex(convId, index) {
    const dir = this._archiveDir(convId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(this._archiveIndexPath(convId), JSON.stringify(index, null, 2), 'utf8');
  }

  async _writeSessionArchive(convId, sessionNumber, sessionData) {
    const dir = this._archiveDir(convId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(this._sessionArchivePath(convId, sessionNumber), JSON.stringify(sessionData, null, 2), 'utf8');
  }

  async _readSessionArchive(convId, sessionNumber) {
    try {
      const data = await fsp.readFile(this._sessionArchivePath(convId, sessionNumber), 'utf8');
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async _generateSessionSummary(messages, fallback) {
    if (!messages || messages.length === 0) return fallback || 'Empty session';
    try {
      // Build a condensed version of the session for summarization
      let sessionText = '';
      for (const msg of messages) {
        if (msg.isSessionDivider) continue;
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        const content = msg.content.substring(0, 500);
        sessionText += `${role}: ${content}\n\n`;
        if (sessionText.length > 4000) break; // Cap context size
      }
      const prompt = `Summarize the following chat session in one concise sentence (100-150 characters max). Only output the summary, nothing else:\n\n${sessionText}`;

      return await new Promise((resolve) => {
        const proc = execFile('claude', ['--print', '-p', prompt], { timeout: 30000 }, (err, stdout) => {
          if (err || !stdout.trim()) {
            resolve(fallback || `Session (${messages.length} messages)`);
          } else {
            resolve(stdout.trim().substring(0, 200));
          }
        });
      });
    } catch {
      return fallback || `Session (${messages.length} messages)`;
    }
  }

  async createConversation(title, workingDir) {
    const id = this._newId();
    const now = new Date().toISOString();
    const sessionId = this._newId();
    const conv = {
      id,
      title: title || 'New Chat',
      createdAt: now,
      updatedAt: now,
      backend: 'claude-code',
      workingDir: workingDir || null,
      currentSessionId: sessionId,
      sessionNumber: 1,
      messages: [],     // [{id, role, content, backend, timestamp}]
    };
    await fsp.writeFile(this._convPath(id), JSON.stringify(conv, null, 2), 'utf8');
    return conv;
  }

  async getConversation(id) {
    const p = this._convPath(id);
    try {
      const data = await fsp.readFile(p, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async saveConversation(conv) {
    conv.updatedAt = new Date().toISOString();
    await fsp.writeFile(this._convPath(conv.id), JSON.stringify(conv, null, 2), 'utf8');
  }

  async listConversations() {
    let files;
    try {
      files = await fsp.readdir(this.conversationsDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    files = files.filter(f => f.endsWith('.json'));
    const convs = [];
    for (const f of files) {
      try {
        const data = await fsp.readFile(path.join(this.conversationsDir, f), 'utf8');
        const conv = JSON.parse(data);
        convs.push({
          id: conv.id,
          title: conv.title,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          backend: conv.backend,
          workingDir: conv.workingDir || null,
          messageCount: conv.messages.length,
          lastMessage: conv.messages.length > 0
            ? conv.messages[conv.messages.length - 1].content.substring(0, 100)
            : null,
        });
      } catch {}
    }
    // Sort by updatedAt descending
    convs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return convs;
  }

  async renameConversation(id, newTitle) {
    const conv = await this.getConversation(id);
    if (!conv) return null;
    conv.title = newTitle;
    await this.saveConversation(conv);
    return conv;
  }

  async deleteConversation(id) {
    const p = this._convPath(id);
    try {
      await fsp.unlink(p);
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
    // Clean up uploaded artifacts for this conversation
    const artifactDir = path.join(this.artifactsDir, id);
    try {
      await fsp.rm(artifactDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors — directory may not exist
    }
    // Clean up session archives for this conversation
    const archiveDir = this._archiveDir(id);
    try {
      await fsp.rm(archiveDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors — directory may not exist
    }
    return true;
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async addMessage(convId, role, content, backend, thinking) {
    const conv = await this.getConversation(convId);
    if (!conv) return null;

    const msg = {
      id: this._newId(),
      role,
      content,
      backend: backend || conv.backend,
      timestamp: new Date().toISOString(),
    };

    if (thinking) {
      msg.thinking = thinking;
    }

    conv.messages.push(msg);

    // Auto-title from first user message (only if still default title)
    if (role === 'user' && conv.title === 'New Chat') {
      conv.title = content.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    }

    await this.saveConversation(conv);
    return msg;
  }

  async updateMessageContent(convId, messageId, newContent) {
    const conv = await this.getConversation(convId);
    if (!conv) return null;

    const msgIndex = conv.messages.findIndex(m => m.id === messageId);
    if (msgIndex === -1) return null;

    // Truncate messages after this one (fork conversation)
    conv.messages = conv.messages.slice(0, msgIndex);

    // Add the edited message as a new one
    const msg = {
      id: this._newId(),
      role: 'user',
      content: newContent,
      backend: conv.backend,
      timestamp: new Date().toISOString(),
    };
    conv.messages.push(msg);
    await this.saveConversation(conv);
    return { conversation: conv, message: msg };
  }

  // ── Session Management ─────────────────────────────────────────────────────

  async resetSession(convId) {
    const conv = await this.getConversation(convId);
    if (!conv) return null;

    const now = new Date();
    const currentSessionNumber = conv.sessionNumber;
    const currentSessionId = conv.currentSessionId;

    // Get current session start time (from sessions array if legacy, or from first message)
    let startedAt;
    if (conv.sessions && conv.sessions.length > 0) {
      const current = conv.sessions[conv.sessions.length - 1];
      startedAt = current.startedAt;
    } else if (conv.messages.length > 0) {
      startedAt = conv.messages[0].timestamp;
    } else {
      startedAt = conv.createdAt;
    }

    // Extract current session messages (handle both legacy and new format)
    let currentMessages;
    if (conv.sessions && conv.sessions.length > 0) {
      // Legacy: find messages after the last divider
      let lastDividerIdx = -1;
      for (let i = conv.messages.length - 1; i >= 0; i--) {
        if (conv.messages[i].isSessionDivider) { lastDividerIdx = i; break; }
      }
      currentMessages = lastDividerIdx >= 0
        ? conv.messages.slice(lastDividerIdx + 1)
        : conv.messages;
    } else {
      // New format: all messages are current session
      currentMessages = conv.messages;
    }

    // Filter out any divider messages
    currentMessages = currentMessages.filter(m => !m.isSessionDivider);

    // Generate summary via Claude Code CLI
    const fallback = `Session ${currentSessionNumber} (${currentMessages.length} messages)`;
    const summary = await this._generateSessionSummary(currentMessages, fallback);

    // Write session archive file
    const sessionData = {
      sessionNumber: currentSessionNumber,
      sessionId: currentSessionId,
      startedAt,
      endedAt: now.toISOString(),
      messageCount: currentMessages.length,
      messages: currentMessages,
    };
    await this._writeSessionArchive(convId, currentSessionNumber, sessionData);

    // Update archive index
    const index = await this._readArchiveIndex(convId);
    index.conversationTitle = conv.title;
    index.sessions.push({
      number: currentSessionNumber,
      file: `session-${currentSessionNumber}.json`,
      sessionId: currentSessionId,
      startedAt,
      endedAt: now.toISOString(),
      messageCount: currentMessages.length,
      summary,
    });
    await this._writeArchiveIndex(convId, index);

    // Start new session — clear messages and remove legacy sessions array
    const newSessionNumber = currentSessionNumber + 1;
    const newSessionId = this._newId();
    conv.sessionNumber = newSessionNumber;
    conv.currentSessionId = newSessionId;
    conv.messages = [];
    delete conv.sessions;

    await this.saveConversation(conv);

    const archivedSession = index.sessions[index.sessions.length - 1];
    return {
      conversation: conv,
      newSessionNumber,
      archivedSession,
    };
  }

  async getSessionHistory(convId) {
    const conv = await this.getConversation(convId);
    if (!conv) return null;

    const index = await this._readArchiveIndex(convId);
    const sessions = index.sessions.map(s => ({
      number: s.number,
      sessionId: s.sessionId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      messageCount: s.messageCount,
      summary: s.summary || null,
      isCurrent: false,
    }));

    // Append current session
    const startedAt = conv.messages.length > 0
      ? conv.messages[0].timestamp
      : conv.updatedAt;
    sessions.push({
      number: conv.sessionNumber,
      sessionId: conv.currentSessionId,
      startedAt,
      endedAt: null,
      messageCount: conv.messages.filter(m => !m.isSessionDivider).length,
      summary: null,
      isCurrent: true,
    });

    return sessions;
  }

  async getSessionMessages(convId, sessionNumber) {
    const conv = await this.getConversation(convId);
    if (!conv) return null;
    if (sessionNumber === conv.sessionNumber) {
      return conv.messages.filter(m => !m.isSessionDivider);
    }
    const archive = await this._readSessionArchive(convId, sessionNumber);
    return archive ? archive.messages : null;
  }

  async sessionToMarkdown(convId, sessionNumber) {
    const conv = await this.getConversation(convId);
    if (!conv) return null;

    let messages, sessionMeta;
    if (sessionNumber === conv.sessionNumber) {
      messages = conv.messages.filter(m => !m.isSessionDivider);
      sessionMeta = { number: sessionNumber, startedAt: messages.length > 0 ? messages[0].timestamp : conv.updatedAt };
    } else {
      const archive = await this._readSessionArchive(convId, sessionNumber);
      if (!archive) return null;
      messages = archive.messages;
      sessionMeta = { number: archive.sessionNumber, startedAt: archive.startedAt };
    }

    return this._messagesToMarkdown(conv.title, conv.id, sessionMeta, messages);
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
      if (msg.isSessionDivider) continue;
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

  // ── Download entire conversation as Markdown ───────────────────────────────

  async conversationToMarkdown(convId) {
    const conv = await this.getConversation(convId);
    if (!conv) return null;

    const lines = [
      `# ${conv.title}`,
      ``,
      `**Created:** ${conv.createdAt}`,
      `**Backend:** ${conv.backend}`,
      ``,
      `---`,
      ``,
    ];

    // Include archived sessions
    const index = await this._readArchiveIndex(convId);
    for (const entry of index.sessions) {
      const archive = await this._readSessionArchive(convId, entry.number);
      if (archive) {
        lines.push(`## Session ${entry.number}`);
        lines.push(``);
        for (const msg of archive.messages) {
          const role = msg.role === 'user' ? 'User' : 'Assistant';
          const time = new Date(msg.timestamp).toLocaleString();
          lines.push(`### ${role} — ${time}`);
          if (msg.backend) lines.push(`*Backend: ${msg.backend}*`);
          lines.push(``);
          lines.push(msg.content);
          lines.push(``);
        }
        lines.push(`---`);
        lines.push(`*Session reset — ${new Date(entry.endedAt).toLocaleString()}*`);
        lines.push(`---`);
        lines.push(``);
      }
    }

    // Include current session messages
    const currentMsgs = conv.messages.filter(m => !m.isSessionDivider);
    if (currentMsgs.length > 0) {
      lines.push(`## Session ${conv.sessionNumber} (current)`);
      lines.push(``);
      for (const msg of currentMsgs) {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        const time = new Date(msg.timestamp).toLocaleString();
        lines.push(`### ${role} — ${time}`);
        if (msg.backend) lines.push(`*Backend: ${msg.backend}*`);
        lines.push(``);
        lines.push(msg.content);
        lines.push(``);
      }
    }

    return lines.join('\n');
  }

  // ── Migration ──────────────────────────────────────────────────────────────

  async migrateConversation(convId) {
    const conv = await this.getConversation(convId);
    if (!conv) return false;

    // Skip if already migrated (no sessions array)
    if (!conv.sessions) return false;

    // Skip if only one session with no dividers (nothing to migrate)
    const hasDividers = conv.messages.some(m => m.isSessionDivider);
    if (conv.sessions.length <= 1 && !hasDividers) {
      // Just remove the sessions array and save
      delete conv.sessions;
      await this.saveConversation(conv);
      return true;
    }

    // Extract messages per session using divider counting
    const dividerIndices = [];
    for (let i = 0; i < conv.messages.length; i++) {
      if (conv.messages[i].isSessionDivider) dividerIndices.push(i);
    }

    const index = await this._readArchiveIndex(convId);
    index.conversationTitle = conv.title;

    for (const session of conv.sessions) {
      if (!session.endedAt) continue; // Skip active session

      // Already archived? Skip
      if (index.sessions.some(s => s.number === session.number)) continue;

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
        messageCount: sessionMessages.length,
        messages: sessionMessages,
      };
      await this._writeSessionArchive(convId, session.number, sessionData);

      index.sessions.push({
        number: session.number,
        file: `session-${session.number}.json`,
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        messageCount: sessionMessages.length,
        summary: '(Migrated session)',
      });
    }

    // Sort index sessions by number
    index.sessions.sort((a, b) => a.number - b.number);
    await this._writeArchiveIndex(convId, index);

    // Keep only current session messages
    const lastDividerIdx = dividerIndices.length > 0 ? dividerIndices[dividerIndices.length - 1] : -1;
    conv.messages = lastDividerIdx >= 0
      ? conv.messages.slice(lastDividerIdx + 1).filter(m => !m.isSessionDivider)
      : conv.messages.filter(m => !m.isSessionDivider);

    delete conv.sessions;
    await this.saveConversation(conv);
    return true;
  }

  async migrateAllConversations() {
    let files;
    try {
      files = await fsp.readdir(this.conversationsDir);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    files = files.filter(f => f.endsWith('.json'));
    let migrated = 0;
    for (const f of files) {
      const convId = f.replace('.json', '');
      try {
        const result = await this.migrateConversation(convId);
        if (result) migrated++;
      } catch (err) {
        console.error(`[migration] Failed to migrate conversation ${convId}:`, err.message);
      }
    }
    if (migrated > 0) {
      console.log(`[migration] Migrated ${migrated} conversation(s) to new archive format`);
    }
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
      // Deep search: load full conversation
      const conv = await this.getConversation(c.id);
      if (!conv) continue;
      if (conv.messages.some(m => m.content.toLowerCase().includes(q))) results.push(c);
    }
    return results;
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async getSettings() {
    try {
      const data = await fsp.readFile(this.settingsFile, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return {
          theme: 'system',
          sendBehavior: 'enter',
          customInstructions: { aboutUser: '', responseStyle: '' },
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
