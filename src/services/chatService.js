const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

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
      sessions: [{      // session tracking
        number: 1,
        sessionId,
        startedAt: now,
        endedAt: null,
        messageCount: 0,
      }],
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
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async addMessage(convId, role, content, backend) {
    const conv = await this.getConversation(convId);
    if (!conv) return null;

    const msg = {
      id: this._newId(),
      role,
      content,
      backend: backend || conv.backend,
      timestamp: new Date().toISOString(),
    };

    conv.messages.push(msg);

    // Auto-title from first user message
    if (role === 'user' && conv.messages.filter(m => m.role === 'user').length === 1) {
      conv.title = content.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    }

    // Update session message count
    const currentSession = conv.sessions[conv.sessions.length - 1];
    if (currentSession) currentSession.messageCount++;

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
    const currentSession = conv.sessions[conv.sessions.length - 1];

    // Archive current session to markdown
    const archiveContent = this._sessionToMarkdown(conv, currentSession);
    const archiveFilename = `${conv.id}_${currentSession.number}_${now.toISOString().replace(/[:.]/g, '-')}.md`;
    await fsp.writeFile(
      path.join(this.archivesDir, archiveFilename),
      archiveContent,
      'utf8'
    );

    // Mark current session end
    currentSession.endedAt = now.toISOString();

    // Add session divider as a special message
    conv.messages.push({
      id: this._newId(),
      role: 'system',
      content: `Session reset`,
      timestamp: now.toISOString(),
      isSessionDivider: true,
      sessionNumber: currentSession.number,
    });

    // Start new session with a fresh Claude Code session UUID
    const newSessionNumber = currentSession.number + 1;
    const newSessionId = this._newId();
    conv.sessionNumber = newSessionNumber;
    conv.currentSessionId = newSessionId;
    conv.sessions.push({
      number: newSessionNumber,
      sessionId: newSessionId,
      startedAt: now.toISOString(),
      endedAt: null,
      messageCount: 0,
    });

    await this.saveConversation(conv);
    return {
      conversation: conv,
      archiveFilename,
      newSessionNumber,
    };
  }

  async getSessionHistory(convId) {
    const conv = await this.getConversation(convId);
    if (!conv) return null;
    return conv.sessions.map(s => ({
      ...s,
      isCurrent: !s.endedAt,
    }));
  }

  async sessionToMarkdown(convId, sessionNumber) {
    const conv = await this.getConversation(convId);
    if (!conv) return null;
    const session = conv.sessions.find(s => s.number === sessionNumber);
    if (!session) return null;
    return this._sessionToMarkdown(conv, session);
  }

  _sessionToMarkdown(conv, session) {
    const lines = [
      `# ${conv.title}`,
      ``,
      `**Session ${session.number}** | Started: ${session.startedAt}`,
      `**Conversation ID:** ${conv.id}`,
      ``,
      `---`,
      ``,
    ];

    // Find messages in this session
    let inSession = false;
    let sessionDividerCount = 0;
    for (const msg of conv.messages) {
      if (msg.isSessionDivider) {
        sessionDividerCount++;
        if (sessionDividerCount === session.number) break;
        continue;
      }
      if (sessionDividerCount === session.number - 1) {
        inSession = true;
      }
      if (session.number === 1 && sessionDividerCount === 0) {
        inSession = true;
      }
      if (inSession && !msg.isSessionDivider) {
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

    for (const msg of conv.messages) {
      if (msg.isSessionDivider) {
        const time = new Date(msg.timestamp).toLocaleString();
        lines.push(`---`);
        lines.push(`*Session reset — ${time}*`);
        lines.push(`---`);
        lines.push(``);
        continue;
      }
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const time = new Date(msg.timestamp).toLocaleString();
      lines.push(`### ${role} — ${time}`);
      if (msg.backend) lines.push(`*Backend: ${msg.backend}*`);
      lines.push(``);
      lines.push(msg.content);
      lines.push(``);
    }

    return lines.join('\n');
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
