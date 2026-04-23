import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { BackendRegistry } from './backends/registry';
import { SettingsService } from './settingsService';
import { parseFrontmatter as parseMemoryFrontmatter } from './backends/claudeCode';
import type {
  ContentBlock,
  Message,
  ToolActivity,
  Usage,
  UsageLedger,
  UsageLedgerDay,
  SessionEntry,
  SessionFile,
  SessionHistoryItem,
  ConversationEntry,
  WorkspaceIndex,
  Conversation,
  ConversationListItem,
  Settings,
  MemorySnapshot,
  MemoryFile,
  EffortLevel,
  KbState,
  KbCounters,
  KbRawStatus,
  AttachmentMeta,
  AttachmentKind,
  QueuedMessage,
} from '../types';
import {
  openKbDatabase,
  normalizeFolderPath,
  KbDatabase,
} from './knowledgeBase/db';
import { computeDigestProgress } from './knowledgeBase/digest';
import { KbVectorStore } from './knowledgeBase/vectorStore';
import type { EmbeddingConfig } from './knowledgeBase/embeddings';

/**
 * Schema version of the `state.json` envelope itself. Bumped only when
 * we change the top-level shape (e.g. add a new top-level map). Distinct
 * from `entrySchemaVersion`, which tracks the digestion output format.
 */
const KB_STATE_VERSION = 1;

/**
 * Current digestion entry schema version. Bumped when the digestion
 * prompt or the entry YAML frontmatter format changes. When bumped,
 * existing entries in `state.json` get `staleSchema: true` and are
 * surfaced in the KB Browser as "needs re-digestion".
 */
const KB_ENTRY_SCHEMA_VERSION = 1;

const DEFAULT_WORKSPACE_FALLBACK = '/tmp/default-workspace';

/* ── Attachment metadata helpers ─────────────────────────────────────────────
 * Shared between upload-response enrichment and queue migration. Both paths
 * start from an absolute server path and must produce the same AttachmentMeta
 * so that a queued message enqueued today looks identical to one reloaded
 * from a pre-attachment-schema workspace index. */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.swift',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hh',
  '.cs', '.fs', '.php', '.pl', '.lua', '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.ini', '.env',
]);
const TEXT_EXTS = new Set(['.txt', '.log', '.csv', '.tsv', '.rtf']);

function attachmentKindFromPath(p: string): AttachmentKind {
  const ext = path.extname(p).toLowerCase();
  if (!ext) return 'file';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (CODE_EXTS.has(ext)) return 'code';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'file';
}

function formatAttachmentSize(bytes: number | undefined): string | undefined {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Build AttachmentMeta from an absolute path. When `size` is known (e.g. from
 * multer's `file.size`), pass it in; otherwise this function does NOT stat the
 * file — callers should stat async if they care about size (queue migration
 * best-effort stats inline with a fallback to undefined).
 */
export function attachmentFromPath(abs: string, size?: number): AttachmentMeta {
  const name = path.basename(abs);
  const kind = attachmentKindFromPath(abs);
  return {
    name,
    path: abs,
    size,
    kind,
    meta: formatAttachmentSize(size),
  };
}

/**
 * Parse a legacy `[Uploaded files: <path1>, <path2>, …]` tag out of a message
 * content string. Returns the clean content + inferred attachments, or null
 * when no tag is present. Used to migrate string[] queue entries into the
 * new QueuedMessage shape on first read.
 *
 * The tag is matched greedily on the last occurrence so a user-authored
 * message that happens to contain the literal "[Uploaded files:" earlier in
 * its text survives. The regex is intentionally strict — anything else in
 * the string passes through untouched.
 */
export function parseUploadedFilesTag(content: string): { content: string; attachments: AttachmentMeta[] } | null {
  if (!content) return null;
  const match = content.match(/\n*\[Uploaded files: ([^\]]+)\]\s*$/);
  if (!match) return null;
  const paths = match[1].split(',').map(s => s.trim()).filter(Boolean);
  if (!paths.length) return null;
  return {
    content: content.slice(0, match.index).replace(/\s+$/, ''),
    attachments: paths.map(p => attachmentFromPath(p)),
  };
}

/**
 * Normalize any shape that may appear under `messageQueue` on disk into the
 * canonical `QueuedMessage[]`. Handles three cases:
 *   1. Legacy `string[]`  — each element is parsed for `[Uploaded files: …]`
 *      and split into `{content, attachments}` or `{content}` when absent.
 *   2. Current `QueuedMessage[]` — passed through, with defensive filtering
 *      of unknown fields so a hand-edited index can't smuggle state in.
 *   3. Anything else — coerced to `[]`.
 */
export function normalizeMessageQueue(raw: unknown): QueuedMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: QueuedMessage[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const parsed = parseUploadedFilesTag(entry);
      if (parsed) {
        out.push({ content: parsed.content, attachments: parsed.attachments });
      } else {
        out.push({ content: entry });
      }
    } else if (entry && typeof entry === 'object' && typeof (entry as QueuedMessage).content === 'string') {
      const q = entry as QueuedMessage;
      const clean: QueuedMessage = { content: q.content };
      if (Array.isArray(q.attachments) && q.attachments.length) {
        clean.attachments = q.attachments
          .filter(a => a && typeof a === 'object' && typeof a.path === 'string' && typeof a.name === 'string')
          .map(a => ({
            name: a.name,
            path: a.path,
            size: typeof a.size === 'number' ? a.size : undefined,
            kind: (typeof a.kind === 'string' ? a.kind : attachmentKindFromPath(a.path)) as AttachmentKind,
            meta: typeof a.meta === 'string' ? a.meta : formatAttachmentSize(typeof a.size === 'number' ? a.size : undefined),
          }));
      }
      out.push(clean);
    }
  }
  return out;
}

/**
 * Turn an arbitrary string into a short, filesystem-safe slug. Used to
 * build memory-note filenames like `note_<timestamp>_<slug>.md`.
 */
function slugify(input: string): string {
  const cleaned = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'note';
}

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
  usageLedgerFile: string;
  private _settingsService: SettingsService;
  private _defaultWorkspace: string;
  private _backendRegistry: BackendRegistry | null;
  private _convWorkspaceMap: Map<string, string>;
  private _legacyConversationsDir: string;
  private _legacyArchivesDir: string;
  /**
   * Per-workspace KB database cache. Opened on first access (or during
   * enqueueUpload), reused for the lifetime of the process. Closed via
   * `closeKbDatabases()` on shutdown.
   */
  private _kbDbs: Map<string, KbDatabase> = new Map();
  /** Per-workspace PGLite vector store cache. Mirrors `_kbDbs` lifecycle. */
  private _kbVectorStores: Map<string, KbVectorStore> = new Map();

  constructor(appRoot: string, options: { defaultWorkspace?: string; backendRegistry?: BackendRegistry } = {}) {
    this.baseDir = path.join(appRoot, 'data', 'chat');
    this.workspacesDir = path.join(this.baseDir, 'workspaces');
    this.artifactsDir = path.join(this.baseDir, 'artifacts');
    this.usageLedgerFile = path.join(this.baseDir, 'usage-ledger.json');
    this._settingsService = new SettingsService(this.baseDir);
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

  async createConversation(
    title?: string,
    workingDir?: string,
    backend?: string,
    model?: string,
    effort?: EffortLevel,
  ): Promise<Conversation> {
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
    const resolvedBackend = backend || defaultBackend;
    const effective = this._effectiveEffort(resolvedBackend, model, effort);
    const convEntry: ConversationEntry = {
      id,
      title: title || 'New Chat',
      backend: resolvedBackend,
      model: model || undefined,
      effort: effective,
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
      model: convEntry.model,
      effort: convEntry.effort,
      workingDir: workspacePath,
      workspaceHash: hash,
      currentSessionId: sessionId,
      sessionNumber: 1,
      messages: [],
    };
  }

  /**
   * Returns the effort value that should be stored on a conversation given its
   * backend, model, and a requested effort. If the backend/model pair doesn't
   * support the requested level, the result is silently downgraded (to the
   * highest supported level below the request) or cleared if nothing matches.
   */
  private _effectiveEffort(backend: string, model: string | undefined, requested: EffortLevel | undefined): EffortLevel | undefined {
    if (!requested || !model) return undefined;
    const adapter = this._backendRegistry?.get(backend);
    const modelOption = adapter?.metadata.models?.find(m => m.id === model);
    const supported = modelOption?.supportedEffortLevels;
    if (!supported || supported.length === 0) return undefined;
    if (supported.includes(requested)) return requested;
    // Downgrade: pick the highest supported level that is <= the request.
    const order: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    const requestedIdx = order.indexOf(requested);
    for (let i = requestedIdx - 1; i >= 0; i--) {
      if (supported.includes(order[i])) return order[i];
    }
    // Nothing at or below the request is supported — fall back to the first
    // supported level rather than dropping it entirely.
    return supported[0];
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const result = await this._getConvFromIndex(id);
    if (!result) return null;
    const { hash, index, convEntry } = result;

    const activeSession = convEntry.sessions.find(s => s.active);
    const sessionNumber = activeSession ? activeSession.number : 1;

    const sessionFile = await this._readSessionFile(hash, id, sessionNumber);
    const messages = sessionFile ? sessionFile.messages : [];

    // Normalize the queue shape in place so GET/PUT round-trips — and any UI
    // that hydrates from this payload — always see the canonical
    // QueuedMessage[] even for legacy string[] queues on disk.
    const normalizedQueue = normalizeMessageQueue(convEntry.messageQueue);
    if (normalizedQueue.length) {
      convEntry.messageQueue = normalizedQueue;
    } else if (convEntry.messageQueue) {
      delete convEntry.messageQueue;
    }

    return {
      id: convEntry.id,
      title: convEntry.title,
      backend: convEntry.backend,
      model: convEntry.model,
      effort: convEntry.effort,
      workingDir: index.workspacePath,
      workspaceHash: hash,
      currentSessionId: convEntry.currentSessionId,
      sessionNumber,
      messages,
      usage: convEntry.usage || this._emptyUsage(),
      sessionUsage: activeSession?.usage || this._emptyUsage(),
      externalSessionId: activeSession?.externalSessionId || null,
      messageQueue: normalizedQueue.length ? normalizedQueue : undefined,
      archived: convEntry.archived,
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
          model: conv.model,
          effort: conv.effort,
          workingDir: index.workspacePath,
          workspaceHash: hash,
          workspaceKbEnabled: Boolean(index.kbEnabled),
          messageCount: activeSession ? activeSession.messageCount : 0,
          lastMessage: conv.lastMessage,
          usage: conv.usage || null,
          archived: conv.archived,
          unread: conv.unread,
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

  async setConversationUnread(id: string, unread: boolean): Promise<boolean> {
    const result = await this._getConvFromIndex(id);
    if (!result) return false;
    const { hash, index, convEntry } = result;
    if (unread) {
      if (convEntry.unread === true) return true;
      convEntry.unread = true;
    } else {
      if (!convEntry.unread) return true;
      delete convEntry.unread;
    }
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
    const prevBackend = convEntry.backend;
    convEntry.backend = backend;
    // contextUsagePercentage is a live snapshot from the backend (Kiro-only
    // today), not a cumulative value. Clear it on backend switch so a stale
    // Kiro percentage doesn't bleed into a Claude Code chip (or vice versa).
    if (prevBackend !== backend) {
      if (convEntry.usage) convEntry.usage.contextUsagePercentage = undefined;
      const activeSession = convEntry.sessions.find(s => s.active);
      if (activeSession?.usage) activeSession.usage.contextUsagePercentage = undefined;
    }
    await this._writeWorkspaceIndex(hash, index);
  }

  /**
   * Persist a backend-managed session ID onto the active `SessionEntry`.
   * Called by `processStream` when an adapter emits an `external_session`
   * event (e.g. Kiro's ACP session ID after `session/new`). Stored on the
   * active session so `SendMessageOptions.externalSessionId` can rehydrate
   * the backend's in-memory session map after a cockpit server restart.
   * Vendor-agnostic — any backend that manages its own session IDs uses
   * the same field.
   */
  async setExternalSessionId(convId: string, externalSessionId: string): Promise<void> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return;
    const { hash, index, convEntry } = result;
    const activeSession = convEntry.sessions.find(s => s.active);
    if (!activeSession) return;
    if (activeSession.externalSessionId === externalSessionId) return;
    activeSession.externalSessionId = externalSessionId;
    await this._writeWorkspaceIndex(hash, index);
  }

  async updateConversationModel(convId: string, model: string | null): Promise<void> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return;
    const { hash, index, convEntry } = result;
    convEntry.model = model || undefined;
    // Silently downgrade stored effort if the new model doesn't support it.
    if (convEntry.effort) {
      convEntry.effort = this._effectiveEffort(convEntry.backend, convEntry.model, convEntry.effort);
    }
    await this._writeWorkspaceIndex(hash, index);
  }

  async updateConversationEffort(convId: string, effort: EffortLevel | null): Promise<void> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return;
    const { hash, index, convEntry } = result;
    convEntry.effort = effort
      ? this._effectiveEffort(convEntry.backend, convEntry.model, effort)
      : undefined;
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
    turn?: 'progress' | 'final',
    contentBlocks?: ContentBlock[],
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

    if (contentBlocks && contentBlocks.length > 0 && role === 'assistant') {
      msg.contentBlocks = contentBlocks;
    }

    if (turn && role === 'assistant') {
      msg.turn = turn;
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

    // Hard-cut titles to 8 words regardless of adapter output or fallback,
    // so sidebar/header entries don't wrap or crowd out sibling controls.
    const words = newTitle.trim().split(/\s+/);
    if (words.length > 8) {
      newTitle = words.slice(0, 8).join(' ');
    }

    convEntry.title = newTitle;
    await this._writeWorkspaceIndex(hash, index);

    return newTitle;
  }

  // ── Message Queue Persistence ──────────────────────────────────────────────

  /**
   * Return the normalized queue for a conversation. Also migrates a legacy
   * `string[]` queue on disk to the new `QueuedMessage[]` shape in place
   * (the migrated shape is persisted back only when the caller subsequently
   * writes the index — normalization never writes on its own to avoid
   * surprising mutations from what should be a read).
   */
  async getQueue(convId: string): Promise<QueuedMessage[]> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return [];
    const normalized = normalizeMessageQueue(result.convEntry.messageQueue);
    // Mirror the normalized shape back onto the in-memory entry so subsequent
    // writes persist the upgraded shape without requiring a dedicated migration
    // step. Safe: _getConvFromIndex always returns the live index object.
    if (normalized.length) {
      result.convEntry.messageQueue = normalized;
    } else if (result.convEntry.messageQueue) {
      delete result.convEntry.messageQueue;
    }
    return normalized;
  }

  async setQueue(convId: string, queue: QueuedMessage[]): Promise<boolean> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return false;
    const { hash, index, convEntry } = result;
    const normalized = normalizeMessageQueue(queue);
    if (normalized.length === 0) {
      delete convEntry.messageQueue;
    } else {
      convEntry.messageQueue = normalized;
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
    // contextUsagePercentage is a live snapshot tied to the prior session's
    // context window; clear it so the chip doesn't show a stale value before
    // the new session's first turn reports fresh usage.
    if (convEntry.usage) convEntry.usage.contextUsagePercentage = undefined;
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

  async getWorkspacePath(hash: string): Promise<string | null> {
    const index = await this._readWorkspaceIndex(hash);
    return index?.workspacePath || null;
  }

  // ── Workspace Memory ───────────────────────────────────────────────────────
  //
  // Memory is stored per-workspace under `memory/` with this layout:
  //
  //   memory/
  //     snapshot.json     — canonical parsed index (merged view of all files)
  //     files/
  //       claude/         — Claude Code native captures; wiped+rewritten on each capture
  //       notes/          — memory_note MCP writes + post-session extractions; preserved across captures
  //
  // This split is what prevents a Claude Code re-capture from clobbering
  // entries written by the MCP `memory_note` tool or by post-session
  // extraction. `saveWorkspaceMemory()` only wipes `files/claude/`; the
  // notes subtree is left untouched and merged back into the snapshot.

  private _memoryDir(hash: string): string {
    return path.join(this._workspaceDir(hash), 'memory');
  }

  private _memorySnapshotPath(hash: string): string {
    return path.join(this._memoryDir(hash), 'snapshot.json');
  }

  private _memoryFilesDir(hash: string): string {
    return path.join(this._memoryDir(hash), 'files');
  }

  private _memoryClaudeDir(hash: string): string {
    return path.join(this._memoryFilesDir(hash), 'claude');
  }

  private _memoryNotesDir(hash: string): string {
    return path.join(this._memoryFilesDir(hash), 'notes');
  }

  /**
   * Migrate legacy `memory/files/*.md` (flat layout from before this feature)
   * into `memory/files/claude/*.md`.  Idempotent and silent if there's
   * nothing to migrate.
   */
  private async _migrateLegacyMemoryLayout(hash: string): Promise<void> {
    const filesDir = this._memoryFilesDir(hash);
    let entries: string[];
    try {
      entries = await fsp.readdir(filesDir);
    } catch {
      return;
    }
    const loose = entries.filter((e) => e.endsWith('.md'));
    if (loose.length === 0) return;

    const claudeDir = this._memoryClaudeDir(hash);
    await fsp.mkdir(claudeDir, { recursive: true });
    for (const name of loose) {
      const from = path.join(filesDir, name);
      const to = path.join(claudeDir, name);
      try {
        await fsp.rename(from, to);
      } catch (err: unknown) {
        console.warn(`[memory] legacy migration: could not move ${from} → ${to}:`, (err as Error).message);
      }
    }
    console.log(`[memory] migrated ${loose.length} legacy file(s) into ${claudeDir}`);
  }

  /**
   * Enumerate notes stored under `files/notes/` and return them as
   * MemoryFile entries. Returns an empty array if the notes dir doesn't
   * exist yet.
   */
  private async _readNotesFromDisk(hash: string): Promise<MemoryFile[]> {
    const notesDir = this._memoryNotesDir(hash);
    let names: string[];
    try {
      names = await fsp.readdir(notesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const files: MemoryFile[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.md')) continue;
      const full = path.join(notesDir, name);
      let content: string;
      try {
        content = await fsp.readFile(full, 'utf8');
      } catch (err: unknown) {
        console.warn(`[memory] could not read note ${full}:`, (err as Error).message);
        continue;
      }
      const parsed = parseMemoryFrontmatter(content);
      // Infer source from filename prefix if frontmatter didn't say.
      let source: 'memory-note' | 'session-extraction' = 'memory-note';
      if (name.startsWith('session_')) source = 'session-extraction';
      files.push({
        filename: `notes/${name}`,
        name: parsed.name,
        description: parsed.description,
        type: parsed.type,
        content,
        source,
      });
    }
    return files;
  }

  /**
   * Persist a CLI-capture snapshot (e.g. from Claude Code) to the
   * workspace's memory directory. Only the `files/claude/` subtree is
   * wiped — any notes written via `memory_note` or post-session
   * extraction in `files/notes/` are preserved and merged back into the
   * canonical `snapshot.json`.
   */
  async saveWorkspaceMemory(hash: string, snapshot: MemorySnapshot): Promise<void> {
    const memDir = this._memoryDir(hash);
    const filesDir = this._memoryFilesDir(hash);
    const claudeDir = this._memoryClaudeDir(hash);

    await fsp.mkdir(memDir, { recursive: true });
    await fsp.mkdir(filesDir, { recursive: true });

    // Migrate any legacy loose files before we touch things.
    await this._migrateLegacyMemoryLayout(hash);

    // Wipe ONLY the claude subdirectory — notes are preserved.
    try {
      await fsp.rm(claudeDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    await fsp.mkdir(claudeDir, { recursive: true });

    if (snapshot.index) {
      await fsp.writeFile(path.join(claudeDir, 'MEMORY.md'), snapshot.index, 'utf8');
    }
    const claudeFiles: MemoryFile[] = [];
    for (const file of snapshot.files) {
      // The adapter returns bare filenames; guard against path traversal
      // and normalize them into `claude/<name>`.
      const bareName = path.basename(file.filename);
      if (!bareName || bareName === '.' || bareName === '..') continue;
      await fsp.writeFile(path.join(claudeDir, bareName), file.content, 'utf8');
      claudeFiles.push({
        ...file,
        filename: `claude/${bareName}`,
        source: 'cli-capture',
      });
    }

    // Merge preserved notes back into the snapshot.
    const notes = await this._readNotesFromDisk(hash);

    const merged: MemorySnapshot = {
      ...snapshot,
      files: [...claudeFiles, ...notes],
    };

    await fsp.writeFile(
      this._memorySnapshotPath(hash),
      JSON.stringify(merged, null, 2),
      'utf8',
    );
  }

  /**
   * Load the stored memory snapshot for a workspace, or `null` if none.
   * Reconciles the on-disk snapshot with any notes that may have been
   * written since the last CLI capture, so the caller always sees a
   * fresh merged view.
   */
  async getWorkspaceMemory(hash: string): Promise<MemorySnapshot | null> {
    let snapshot: MemorySnapshot | null;
    try {
      const data = await fsp.readFile(this._memorySnapshotPath(hash), 'utf8');
      snapshot = JSON.parse(data) as MemorySnapshot;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      snapshot = null;
    }

    // Even if there's no CLI-capture snapshot yet, notes alone can
    // constitute a memory store (non-Claude workspace that only uses
    // memory_note). Build a minimal snapshot in that case.
    const notes = await this._readNotesFromDisk(hash);
    if (!snapshot) {
      if (notes.length === 0) return null;
      return {
        capturedAt: new Date().toISOString(),
        sourceBackend: 'memory-note',
        sourcePath: null,
        index: '',
        files: notes,
      };
    }

    // Rebuild: keep CLI-capture files as stored, but always re-read notes
    // fresh from disk so post-snapshot writes are reflected.
    const claudeFiles = (snapshot.files || []).filter(
      (f) => (f.source || 'cli-capture') === 'cli-capture',
    );
    return { ...snapshot, files: [...claudeFiles, ...notes] };
  }

  /**
   * Append a memory entry under `files/notes/`. Used by both the
   * `memory_note` MCP tool and post-session extraction. Updates
   * `snapshot.json` atomically so `getWorkspaceMemory()` reflects the
   * write immediately. Returns the relative path (`notes/<name>`).
   */
  async addMemoryNoteEntry(
    hash: string,
    args: {
      content: string;
      source: 'memory-note' | 'session-extraction';
      filenameHint?: string;
    },
  ): Promise<string> {
    const notesDir = this._memoryNotesDir(hash);
    await fsp.mkdir(notesDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slugSource = args.filenameHint || 'note';
    const slug = slugify(slugSource);
    const prefix = args.source === 'session-extraction' ? 'session' : 'note';

    // Pick a non-colliding filename.
    let attempt = 0;
    let name = `${prefix}_${timestamp}_${slug}.md`;
    while (true) {
      try {
        await fsp.access(path.join(notesDir, name));
        attempt++;
        name = `${prefix}_${timestamp}_${slug}_${attempt}.md`;
      } catch {
        break;
      }
    }

    await fsp.writeFile(path.join(notesDir, name), args.content, 'utf8');

    // Rebuild snapshot.json so callers immediately see the new entry.
    await this._refreshSnapshotIndex(hash);

    return `notes/${name}`;
  }

  /**
   * Delete a single memory entry by its relative path (`claude/<name>`
   * or `notes/<name>`). Path is validated to stay inside
   * `files/`. Updates `snapshot.json` after deletion. Returns true if
   * the file was deleted, false if it didn't exist.
   */
  async deleteMemoryEntry(hash: string, relPath: string): Promise<boolean> {
    const filesDir = this._memoryFilesDir(hash);
    const resolved = path.resolve(filesDir, relPath);
    if (!resolved.startsWith(path.resolve(filesDir) + path.sep)) {
      throw new Error('Path traversal rejected');
    }
    if (!resolved.endsWith('.md')) {
      throw new Error('Only .md entries can be deleted');
    }
    try {
      await fsp.unlink(resolved);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }

    // Rebuild snapshot.json so the deletion is reflected.
    await this._refreshSnapshotIndex(hash);
    return true;
  }

  /**
   * Wipe all memory entries for a workspace. Removes every `.md` under
   * `memory/files/claude/` and `memory/files/notes/`, then rewrites
   * `snapshot.json` to reflect the empty state. Leaves the workspace's
   * Memory-enabled flag untouched. Returns the number of files deleted.
   */
  async clearWorkspaceMemory(hash: string): Promise<number> {
    let deleted = 0;
    for (const dir of [this._memoryClaudeDir(hash), this._memoryNotesDir(hash)]) {
      let entries: string[];
      try {
        entries = await fsp.readdir(dir);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      for (const name of entries) {
        if (!name.endsWith('.md')) continue;
        try {
          await fsp.unlink(path.join(dir, name));
          deleted++;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    }

    // Rebuild snapshot.json so getWorkspaceMemory() reflects the wipe
    // immediately. Safe even if no prior snapshot existed.
    await this._refreshSnapshotIndex(hash);
    return deleted;
  }

  /**
   * Rewrite `snapshot.json` from the current on-disk state without
   * re-running capture. Used after note writes and deletions so
   * `getWorkspaceMemory()` stays consistent.
   */
  private async _refreshSnapshotIndex(hash: string): Promise<void> {
    const snapshotPath = this._memorySnapshotPath(hash);
    let snapshot: MemorySnapshot;
    try {
      const data = await fsp.readFile(snapshotPath, 'utf8');
      snapshot = JSON.parse(data) as MemorySnapshot;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // No prior snapshot — synthesize a minimal one keyed on the notes.
      snapshot = {
        capturedAt: new Date().toISOString(),
        sourceBackend: 'memory-note',
        sourcePath: null,
        index: '',
        files: [],
      };
      await fsp.mkdir(this._memoryDir(hash), { recursive: true });
    }

    // Re-read the Claude subtree so deletions of claude/* also take effect.
    const claudeDir = this._memoryClaudeDir(hash);
    const claudeFiles: MemoryFile[] = [];
    try {
      const names = await fsp.readdir(claudeDir);
      for (const name of names.sort()) {
        if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
        const full = path.join(claudeDir, name);
        const content = await fsp.readFile(full, 'utf8');
        const parsed = parseMemoryFrontmatter(content);
        claudeFiles.push({
          filename: `claude/${name}`,
          name: parsed.name,
          description: parsed.description,
          type: parsed.type,
          content,
          source: 'cli-capture',
        });
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const notes = await this._readNotesFromDisk(hash);
    const next: MemorySnapshot = {
      ...snapshot,
      capturedAt: new Date().toISOString(),
      files: [...claudeFiles, ...notes],
    };
    await fsp.writeFile(snapshotPath, JSON.stringify(next, null, 2), 'utf8');
  }

  /** Per-workspace Memory enable/disable (stored on the workspace index). */
  async getWorkspaceMemoryEnabled(hash: string): Promise<boolean> {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return false;
    return Boolean(index.memoryEnabled);
  }

  async setWorkspaceMemoryEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return null;
    index.memoryEnabled = Boolean(enabled);
    await this._writeWorkspaceIndex(hash, index);
    return index.memoryEnabled;
  }

  /**
   * Capture memory from the given backend adapter for the workspace
   * associated with `convId` and persist it.  Returns the snapshot or
   * `null` if the backend doesn't support memory extraction or no
   * memory exists.  Never throws — extraction failures are logged.
   */
  async captureWorkspaceMemory(
    convId: string,
    backendId: string,
  ): Promise<MemorySnapshot | null> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) {
      console.log(`[memory] captureWorkspaceMemory: no workspace hash for conv=${convId}`);
      return null;
    }
    const index = await this._readWorkspaceIndex(hash);
    if (!index) {
      console.log(`[memory] captureWorkspaceMemory: no workspace index for conv=${convId} hash=${hash}`);
      return null;
    }

    const adapter = this._backendRegistry?.get(backendId);
    if (!adapter) {
      console.log(`[memory] captureWorkspaceMemory: no adapter for backend=${backendId}`);
      return null;
    }

    console.log(`[memory] extracting for conv=${convId} backend=${backendId} workspacePath=${index.workspacePath}`);
    let snapshot: MemorySnapshot | null = null;
    try {
      snapshot = await adapter.extractMemory(index.workspacePath);
    } catch (err: unknown) {
      console.error(`[memory] extractMemory threw for backend=${backendId} workspacePath=${index.workspacePath}:`, (err as Error).message);
      return null;
    }

    if (!snapshot) {
      console.log(`[memory] extractMemory returned null for backend=${backendId} workspacePath=${index.workspacePath}`);
      return null;
    }

    try {
      await this.saveWorkspaceMemory(hash, snapshot);
    } catch (err: unknown) {
      console.error(`[memory] saveWorkspaceMemory failed for conv=${convId}:`, (err as Error).message);
      return null;
    }

    return snapshot;
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

  /**
   * Returns a bracketed pointer block that tells the CLI where the
   * workspace's memory directory lives on disk, or `null` when memory
   * is disabled for this workspace.
   *
   * This is the read-side counterpart to the `memory_note` MCP writer.
   * Instead of dumping the entire memory into the system prompt (which
   * pays a token cost on every spawn, doesn't survive `--resume`, and
   * is frozen at session start), we prepend a short pointer to the
   * first user message on new sessions. Because the pointer lives in
   * the user message, it survives `--resume` via the CLI's own
   * conversation history, and because the model reads the files on
   * demand via its normal file tools, mid-session additions (e.g. a
   * `memory_note` call from a different tab) are visible on the very
   * next turn.
   *
   * The method `mkdir -p`s `memory/files/` so the model never hits
   * ENOENT on a brand-new workspace where nothing has been written
   * yet.
   */
  async getWorkspaceMemoryPointer(hash: string): Promise<string | null> {
    if (!hash) return null;
    const enabled = await this.getWorkspaceMemoryEnabled(hash);
    if (!enabled) return null;
    const filesDir = this._memoryFilesDir(hash);
    try {
      await fsp.mkdir(filesDir, { recursive: true });
    } catch (err: unknown) {
      console.warn(`[memory] getWorkspaceMemoryPointer: could not create ${filesDir}:`, (err as Error).message);
    }
    const absPath = path.resolve(filesDir);
    return [
      `[Workspace memory is available at ${absPath}/`,
      `Contains .md files with YAML frontmatter (type, name, description) followed by body text.`,
      `Read these when the user references preferences, feedback, decisions, project context, or prior work style.]`,
    ].join('\n');
  }

  // ── Workspace Knowledge Base ───────────────────────────────────────────────
  //
  // KB directory layout on disk (all under the workspace root to keep
  // per-workspace data colocated):
  //
  //   data/chat/workspaces/{hash}/knowledge/
  //     state.db                         — SQLite index of the KB pipeline state
  //     state.json.migrated              — legacy state snapshot, kept one release
  //     raw/<rawId>.<ext>                — raw uploads, stored verbatim
  //     converted/<rawId>/...            — ingestion output (text, media, etc.)
  //     entries/<entryId>/entry.md       — digestion output (YAML frontmatter + body)
  //     synthesis/                       — dreaming output (populated by PR 4)
  //       manifest.json                  — artifact lineage
  //       *.md                           — synthesis layer files
  //
  // `state.db` is owned by the `KbDatabase` wrapper in `knowledgeBase/db.ts`.
  // chatService opens it lazily per workspace and caches the handle for
  // the life of the process. All KB mutations go through the DB; the
  // filesystem stores only the actual file bytes.

  private _knowledgeDir(hash: string): string {
    return path.join(this._workspaceDir(hash), 'knowledge');
  }

  private _kbDbPath(hash: string): string {
    return path.join(this._knowledgeDir(hash), 'state.db');
  }

  private _kbLegacyStatePath(hash: string): string {
    return path.join(this._knowledgeDir(hash), 'state.json');
  }

  private _kbRawDir(hash: string): string {
    return path.join(this._knowledgeDir(hash), 'raw');
  }

  private _kbConvertedDir(hash: string): string {
    return path.join(this._knowledgeDir(hash), 'converted');
  }

  private _kbEntriesDir(hash: string): string {
    return path.join(this._knowledgeDir(hash), 'entries');
  }

  private _kbSynthesisDir(hash: string): string {
    return path.join(this._knowledgeDir(hash), 'synthesis');
  }

  // ── Public KB directory accessors ────────────────────────────────────────
  // Exposed so the ingestion orchestrator (which lives outside chatService)
  // can resolve paths without duplicating the directory layout. The layout
  // itself stays centralized here — callers never hardcode `knowledge/raw`
  // etc., they always go through one of these getters.
  getKbKnowledgeDir(hash: string): string { return this._knowledgeDir(hash); }
  getKbRawDir(hash: string): string { return this._kbRawDir(hash); }
  getKbConvertedDir(hash: string): string { return this._kbConvertedDir(hash); }
  getKbEntriesDir(hash: string): string { return this._kbEntriesDir(hash); }
  getKbSynthesisDir(hash: string): string { return this._kbSynthesisDir(hash); }

  /**
   * Open (or return cached) per-workspace KB database handle. Creates
   * the `knowledge/` directory on first call and runs the legacy
   * `state.json → state.db` migration if needed (see `openKbDatabase`).
   *
   * Returns `null` when `hash` is falsy. Does NOT check workspace
   * existence — callers should guard on `_readWorkspaceIndex` first
   * if they need that behaviour.
   */
  getKbDb(hash: string): KbDatabase | null {
    if (!hash) return null;
    const cached = this._kbDbs.get(hash);
    if (cached) return cached;
    // Ensure parent dirs exist before better-sqlite3 tries to open.
    fs.mkdirSync(this._knowledgeDir(hash), { recursive: true });
    fs.mkdirSync(this._kbRawDir(hash), { recursive: true });
    const db = openKbDatabase({
      dbPath: this._kbDbPath(hash),
      legacyJsonPath: this._kbLegacyStatePath(hash),
      rawDir: this._kbRawDir(hash),
    });
    this._kbDbs.set(hash, db);
    return db;
  }

  /** Close every cached KB database. Call during graceful shutdown. */
  closeKbDatabases(): void {
    for (const [hash, db] of this._kbDbs.entries()) {
      try {
        db.close();
      } catch (err: unknown) {
        console.warn(
          `[kb] closeKbDatabases: failed to close ${hash}:`,
          (err as Error).message,
        );
      }
    }
    this._kbDbs.clear();
  }

  /**
   * Get or create a PGLite vector store for a workspace. Returns `null`
   * when `hash` is falsy. The store is cached for the process lifetime
   * just like `_kbDbs`.
   */
  async getKbVectorStore(hash: string, dimensions?: number): Promise<KbVectorStore | null> {
    if (!hash) return null;
    const cached = this._kbVectorStores.get(hash);
    if (cached) return cached;
    const knowledgeDir = this._knowledgeDir(hash);
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const store = new KbVectorStore(knowledgeDir, dimensions);
    await store.ready();
    this._kbVectorStores.set(hash, store);
    return store;
  }

  /** Close every cached vector store. Call during graceful shutdown. */
  async closeKbVectorStores(): Promise<void> {
    for (const [hash, store] of this._kbVectorStores.entries()) {
      try {
        await store.close();
      } catch (err: unknown) {
        console.warn(
          `[kb] closeKbVectorStores: failed to close ${hash}:`,
          (err as Error).message,
        );
      }
    }
    this._kbVectorStores.clear();
  }

  /** Per-workspace embedding config (stored on the workspace index). */
  async getWorkspaceKbEmbeddingConfig(hash: string): Promise<EmbeddingConfig | undefined> {
    const index = await this._readWorkspaceIndex(hash);
    return index?.kbEmbedding ?? undefined;
  }

  async setWorkspaceKbEmbeddingConfig(
    hash: string,
    cfg: EmbeddingConfig,
  ): Promise<EmbeddingConfig | null> {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return null;

    const oldCfg = index.kbEmbedding;
    const modelChanged = (cfg.model ?? 'nomic-embed-text') !== (oldCfg?.model ?? 'nomic-embed-text');
    const dimsChanged = (cfg.dimensions ?? 768) !== (oldCfg?.dimensions ?? 768);

    index.kbEmbedding = {
      model: cfg.model,
      ollamaHost: cfg.ollamaHost,
      dimensions: cfg.dimensions,
    };
    await this._writeWorkspaceIndex(hash, index);

    // When model or dimensions change, wipe existing embeddings so they
    // get regenerated on the next digest/dream cycle.
    if ((modelChanged || dimsChanged) && this._kbVectorStores.has(hash)) {
      try {
        const store = this._kbVectorStores.get(hash)!;
        await store.close();
        this._kbVectorStores.delete(hash);
      } catch { /* ignore close errors */ }
    }

    return index.kbEmbedding;
  }

  /**
   * Read the on-disk path of a staged raw file. Returns `null` when the
   * workspace has no KB state or the rawId isn't known. Used by the HTTP
   * layer to stream raw bytes back for the Raw tab preview.
   *
   * The filename used for the extension comes from the first matching
   * `raw_locations` row — multi-location raws all share the same bytes
   * on disk under `<rawId>.<ext>`, and the orchestrator always uses the
   * extension of the first-uploaded location when staging the file.
   */
  async getKbRawFilePath(hash: string, rawId: string): Promise<string | null> {
    if (!hash) return null;
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return null;
    const db = this.getKbDb(hash);
    if (!db) return null;
    const raw = db.getRawById(rawId);
    if (!raw) return null;
    const locations = db.listLocations(rawId);
    // Prefer a named location's extension. When a raw row exists with no
    // locations (pending-delete state), fall back to an empty extension so
    // the file is still streamable by rawId.
    const filename = locations[0]?.filename ?? '';
    const ext = path.extname(filename) || '';
    return path.join(this._kbRawDir(hash), `${rawId}${ext}`);
  }

  /** Per-workspace KB enable/disable (stored on the workspace index). */
  async getWorkspaceKbEnabled(hash: string): Promise<boolean> {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return false;
    return Boolean(index.kbEnabled);
  }

  async setWorkspaceKbEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return null;
    index.kbEnabled = Boolean(enabled);
    await this._writeWorkspaceIndex(hash, index);
    return index.kbEnabled;
  }

  /**
   * Per-workspace auto-digest toggle. When true, newly-ingested files
   * are automatically digested once conversion completes (ingestion
   * handler enqueues a digest task). Toggling off only affects future
   * ingestions — files currently in flight still finish whatever stage
   * they're on.
   *
   * Returns `null` when the workspace doesn't exist, matching
   * `setWorkspaceKbEnabled`. The flag lives on the workspace index so
   * tests that stub `getSettings` don't accidentally reset it.
   */
  async getWorkspaceKbAutoDigest(hash: string): Promise<boolean> {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return false;
    return Boolean(index.kbAutoDigest);
  }

  async setWorkspaceKbAutoDigest(hash: string, autoDigest: boolean): Promise<boolean | null> {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return null;
    index.kbAutoDigest = Boolean(autoDigest);
    await this._writeWorkspaceIndex(hash, index);
    return index.kbAutoDigest;
  }

  /**
   * Build a `KbState` snapshot for the UI. This is what the
   * `GET /workspaces/:hash/kb` endpoint returns.
   *
   *   - Returns `null` when the workspace doesn't exist.
   *   - Returns an all-empty in-memory snapshot when KB is disabled (no
   *     DB is opened — we don't want to pollute disk with a state.db for
   *     workspaces that never opt in).
   *   - Otherwise opens the DB and reads counters + folder tree + a page
   *     of raw rows in `opts.folderPath` (root by default).
   *
   * The `raw` array is always scoped to one folder + page — the UI
   * fetches other folders on demand. Counters are global across the
   * whole workspace so the header badges don't re-flicker on navigation.
   */
  async getKbStateSnapshot(
    hash: string,
    opts: { folderPath?: string; limit?: number; offset?: number } = {},
  ): Promise<KbState | null> {
    if (!hash) return null;
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return null;

    if (!index.kbEnabled) {
      return this._emptyKbSnapshot(Boolean(index.kbAutoDigest));
    }

    const db = this.getKbDb(hash);
    if (!db) return this._emptyKbSnapshot(Boolean(index.kbAutoDigest));

    const folderPath = opts.folderPath !== undefined
      ? normalizeFolderPath(opts.folderPath)
      : '';

    const sessionRow = db.getDigestSession();
    const digestProgress = sessionRow ? computeDigestProgress(sessionRow) : null;

    return {
      version: KB_STATE_VERSION,
      entrySchemaVersion: KB_ENTRY_SCHEMA_VERSION,
      autoDigest: Boolean(index.kbAutoDigest),
      counters: db.getCounters(),
      folders: db.listFolders(),
      raw: db.listRawInFolder(folderPath, {
        limit: opts.limit,
        offset: opts.offset,
      }),
      digestProgress,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Zero-value snapshot used when KB is disabled or not yet initialized. */
  private _emptyKbSnapshot(autoDigest: boolean): KbState {
    const zeroCounters: KbCounters = {
      rawTotal: 0,
      rawByStatus: {
        ingesting: 0,
        ingested: 0,
        digesting: 0,
        digested: 0,
        failed: 0,
        'pending-delete': 0,
      } as Record<KbRawStatus, number>,
      entryCount: 0,
      pendingCount: 0,
      folderCount: 0,
    };
    return {
      version: KB_STATE_VERSION,
      entrySchemaVersion: KB_ENTRY_SCHEMA_VERSION,
      autoDigest,
      counters: zeroCounters,
      folders: [],
      raw: [],
      digestProgress: null,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Returns a bracketed pointer block that tells the CLI where the
   * workspace's knowledge base lives on disk, or `null` when KB is
   * disabled for this workspace. Mirrors `getWorkspaceMemoryPointer`
   * in shape and rationale: read-side access without paying the token
   * cost of dumping the whole KB into the system prompt, and the CLI
   * reads the state file + entries on demand via its own file tools.
   *
   * Creates `knowledge/entries/` so the CLI never hits ENOENT on a
   * brand-new workspace with KB enabled but no files yet.
   */
  async getWorkspaceKbPointer(hash: string): Promise<string | null> {
    if (!hash) return null;
    const enabled = await this.getWorkspaceKbEnabled(hash);
    if (!enabled) return null;
    const kbDir = this._knowledgeDir(hash);
    const entriesDir = this._kbEntriesDir(hash);
    try {
      await fsp.mkdir(entriesDir, { recursive: true });
    } catch (err: unknown) {
      console.warn(`[kb] getWorkspaceKbPointer: could not create ${entriesDir}:`, (err as Error).message);
    }
    const absKbDir = path.resolve(kbDir);
    return [
      `[Workspace knowledge base is available at ${absKbDir}/`,
      `- state.db: SQLite index of raw files, folders, and digested entries (read via CLI helpers).`,
      `- entries/<entryId>/entry.md: digested knowledge entries with YAML frontmatter (title, tags, source).`,
      `- synthesis/*.md: cross-entry synthesis (created by the Dreaming stage).`,
      `Read these when the user references documents they've uploaded, domain knowledge, or asks questions the digested entries may cover.]`,
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
    // Kiro-specific: credits accumulate, contextUsagePercentage is a snapshot (overwrite)
    if (source.credits !== undefined) {
      target.credits = (target.credits || 0) + source.credits;
    }
    if (source.contextUsagePercentage !== undefined) {
      target.contextUsagePercentage = source.contextUsagePercentage;
    }
  }

  async addUsage(convId: string, usage: Usage, backend?: string, model?: string, options?: { skipLedger?: boolean }): Promise<{ conversationUsage: Usage; sessionUsage: Usage } | null> {
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
    // Skip ledger for backends that don't provide token-based usage (e.g. Kiro)
    if (!options?.skipLedger) {
      this._recordToLedger(backendId, model || 'unknown', usage).catch(err => {
        console.error('[usage] Failed to write ledger:', (err as Error).message);
      });
    }

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
    const legacy = dayEntry as UsageLedgerDay & { backends?: Record<string, Usage> };
    if (legacy.backends && !legacy.records) {
      legacy.records = [];
      for (const [bid, u] of Object.entries(legacy.backends)) {
        legacy.records.push({ backend: bid, model: 'unknown', usage: u });
      }
      delete legacy.backends;
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
    return this._settingsService.getSettings();
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    return this._settingsService.saveSettings(settings);
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
