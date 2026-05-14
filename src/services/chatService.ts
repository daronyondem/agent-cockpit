import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { BackendRegistry } from './backends/registry';
import { SettingsService } from './settingsService';
import {
  cliVendorForBackend,
  cliProfileIdForBackend,
  type CliProfileRuntime,
  ensureServerConfiguredCliProfiles,
  resolveCliProfileRuntime,
  serverConfiguredCliProfileId,
} from './cliProfiles';
import { parseFrontmatter as parseMemoryFrontmatter } from './backends/claudeCode';
import type {
  ContentBlock,
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
  MemorySnapshot,
  MemoryFile,
  MemoryEntryMetadata,
  MemoryMetadataIndex,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  MemoryType,
  MemoryRedaction,
  MemoryConsolidationAudit,
  MemoryReviewRun,
  MemoryReviewScheduleConfig,
  ConversationMemoryReviewStatus,
  ConversationContextMapStatus,
  EffortLevel,
  ServiceTier,
  KbState,
  KbCounters,
  KbRawStatus,
  KbAutoDreamConfig,
  ConversationArtifact,
  QueuedMessage,
  CliProfile,
  StreamErrorSource,
  WorkspaceInstructionCompatibilityStatus,
  WorkspaceInstructionPointerResult,
  ContextMapWorkspaceSettings,
} from '../types';
import {
  openKbDatabase,
  normalizeFolderPath,
  KbDatabase,
} from './knowledgeBase/db';
import {
  ContextMapDatabase,
  openContextMapDatabase,
} from './contextMap/db';
import { computeDigestProgress } from './knowledgeBase/digest';
import { DEFAULT_KB_AUTO_DREAM_CONFIG, normalizeKbAutoDreamConfig } from './knowledgeBase/autoDream';
import { DEFAULT_MEMORY_REVIEW_SCHEDULE, normalizeMemoryReviewScheduleConfig } from './memoryReview';
import { KbVectorStore } from './knowledgeBase/vectorStore';
import { resolveConfig, type EmbeddingConfig } from './knowledgeBase/embeddings';
import { atomicWriteFile } from '../utils/atomicWrite';
import { KeyedMutex } from '../utils/keyedMutex';
import { logger } from '../utils/logger';
import {
  MessageQueueStore,
  normalizeMessageQueue,
} from './chat/messageQueueStore';
import { WorkspaceInstructionStore } from './chat/workspaceInstructionStore';
import { UsageLedgerStore, addToUsage, emptyUsage } from './chat/usageLedgerStore';
import { ArtifactStore, type CreateConversationArtifactInput } from './chat/artifactStore';
import { WorkspaceFeatureSettingsStore } from './chat/workspaceFeatureSettingsStore';

const log = logger.child({ module: 'chat-service' });

export { attachmentFromPath } from './chat/attachments';
export { normalizeMessageQueue, parseUploadedFilesTag } from './chat/messageQueueStore';

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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

function memoryEntryId(filename: string): string {
  const digest = crypto.createHash('sha256').update(filename).digest('hex').slice(0, 16);
  return `mem_${digest}`;
}

function memoryFileFingerprint(file: MemoryFile): string {
  const metadata = file.metadata;
  const payload = {
    filename: file.filename,
    type: file.type,
    name: file.name,
    description: file.description,
    content: file.content,
    status: metadata?.status || 'active',
    supersededBy: metadata?.supersededBy || null,
    supersedes: metadata?.supersedes || [],
    redaction: metadata?.redaction || [],
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

function validMemoryReviewRunId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function normalizeMemorySource(value: unknown, fallback: MemorySource): MemorySource {
  if (value === 'cli-capture' || value === 'memory-note' || value === 'session-extraction') return value;
  return fallback;
}

function memorySourceFromFilename(filename: string): MemorySource {
  if (filename.startsWith('notes/session_')) return 'session-extraction';
  if (filename.startsWith('notes/')) return 'memory-note';
  return 'cli-capture';
}

function normalizeMemoryStatus(value: unknown): MemoryStatus {
  if (value === 'active' || value === 'superseded' || value === 'redacted' || value === 'deleted') return value;
  return 'active';
}

function normalizeMemoryScope(value: unknown): MemoryScope {
  if (value === 'user') return 'user';
  return 'workspace';
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return strings.length ? strings : undefined;
}

function normalizeMemoryRedaction(value: unknown): Array<{ kind: string; reason: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const redaction = value
    .filter((item): item is { kind: string; reason: string } =>
      !!item
      && typeof item === 'object'
      && typeof (item as { kind?: unknown }).kind === 'string'
      && typeof (item as { reason?: unknown }).reason === 'string',
    )
    .map((item) => ({ kind: item.kind, reason: item.reason }));
  return redaction.length ? redaction : undefined;
}

const MEMORY_SEARCH_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'with',
]);

function tokenizeMemorySearch(value: string): string[] {
  const matches = value.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) || [];
  return matches
    .map((token) => token.replace(/^_+|_+$/g, ''))
    .filter((token) => token.length >= 2 && !MEMORY_SEARCH_STOPWORDS.has(token));
}

function memorySearchText(file: MemoryFile): string {
  return [
    file.name || '',
    file.name || '',
    file.description || '',
    file.description || '',
    file.description || '',
    file.type,
    file.filename,
    file.content || '',
  ].join('\n');
}

function normalizeMemorySearchField(value: string | null | undefined): string {
  return tokenizeMemorySearch(value || '').join(' ');
}

function memorySearchExactBoost(file: MemoryFile, normalizedQuery: string, queryTerms: string[]): number {
  if (!normalizedQuery) return 0;
  let boost = 0;
  const fields = [
    { value: file.name, exact: 6, contains: 3, term: 0.5 },
    { value: file.description, exact: 4, contains: 2, term: 0.35 },
    { value: file.filename, exact: 3, contains: 1.5, term: 0.25 },
  ];

  for (const field of fields) {
    const normalized = normalizeMemorySearchField(field.value);
    if (!normalized) continue;
    if (normalized === normalizedQuery) {
      boost += field.exact;
    } else if (normalized.includes(normalizedQuery)) {
      boost += field.contains;
    }
    const tokens = new Set(normalized.split(' ').filter(Boolean));
    const matchedTerms = queryTerms.filter((term) => tokens.has(term)).length;
    boost += matchedTerms * field.term;
  }

  return boost;
}

function memorySearchTypeBoost(
  file: MemoryFile,
  queryTerms: string[],
  allowedTypes: Set<MemoryType> | null,
): number {
  let boost = 0;
  if (allowedTypes?.has(file.type)) boost += 0.75;
  if (queryTerms.includes(file.type)) boost += 2;
  return boost;
}

function memorySearchTimestamp(file: MemoryFile): number {
  const raw = file.metadata?.updatedAt || file.metadata?.createdAt || '';
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : 0;
}

function memorySearchSnippet(content: string, queryTerms: string[]): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const lower = compact.toLowerCase();
  let index = -1;
  for (const term of queryTerms) {
    const found = lower.indexOf(term.toLowerCase());
    if (found !== -1 && (index === -1 || found < index)) index = found;
  }
  const start = index === -1 ? 0 : Math.max(0, index - 90);
  const end = Math.min(compact.length, start + 260);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < compact.length ? '...' : '';
  return `${prefix}${compact.slice(start, end)}${suffix}`;
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

interface ChatServiceOptions {
  defaultWorkspace?: string;
  backendRegistry?: BackendRegistry;
  dataRoot?: string;
}

export class ChatService {
  baseDir: string;
  workspacesDir: string;
  artifactsDir: string;
  usageLedgerFile: string;
  private _settingsService: SettingsService;
  private _messageQueueStore: MessageQueueStore;
  private _workspaceInstructionStore: WorkspaceInstructionStore;
  private _usageLedgerStore: UsageLedgerStore;
  private _artifactStore: ArtifactStore;
  private _featureSettingsStore: WorkspaceFeatureSettingsStore;
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
  /** Per-workspace Context Map database cache. Mirrors `_kbDbs` lifecycle. */
  private _contextMapDbs: Map<string, ContextMapDatabase> = new Map();
  /** Per-workspace PGLite vector store cache. Mirrors `_kbDbs` lifecycle. */
  private _kbVectorStores: Map<string, KbVectorStore> = new Map();
  /**
   * Serializes read-modify-write cycles on a workspace `index.json`. All
   * public methods that mutate the index acquire this lock keyed by workspace
   * hash, so concurrent mutators neither race on the file (byte-level
   * corruption) nor lose each other's updates (stale reads).
   */
  private _indexLock = new KeyedMutex();
  constructor(appRoot: string, options: ChatServiceOptions = {}) {
    const dataRoot = options.dataRoot || path.join(appRoot, 'data');
    this.baseDir = path.join(dataRoot, 'chat');
    this.workspacesDir = path.join(this.baseDir, 'workspaces');
    this.artifactsDir = path.join(this.baseDir, 'artifacts');
    this.usageLedgerFile = path.join(this.baseDir, 'usage-ledger.json');
    this._usageLedgerStore = new UsageLedgerStore(this.usageLedgerFile);
    this._settingsService = new SettingsService(this.baseDir);
    this._defaultWorkspace = options.defaultWorkspace || DEFAULT_WORKSPACE_FALLBACK;
    this._backendRegistry = options.backendRegistry || null;
    this._convWorkspaceMap = new Map();
    this._messageQueueStore = new MessageQueueStore({
      convWorkspaceMap: this._convWorkspaceMap,
      indexLock: this._indexLock,
      getConvFromIndex: (convId) => this._getConvFromIndex(convId),
      writeWorkspaceIndex: (hash, index) => this._writeWorkspaceIndex(hash, index),
    });
    this._workspaceInstructionStore = new WorkspaceInstructionStore({
      indexLock: this._indexLock,
      readWorkspaceIndex: (hash) => this._readWorkspaceIndex(hash),
      writeWorkspaceIndex: (hash, index) => this._writeWorkspaceIndex(hash, index),
    });
    this._artifactStore = new ArtifactStore({
      artifactsDir: this.artifactsDir,
      hasConversation: (convId) => this._convWorkspaceMap.has(convId),
    });
    this._featureSettingsStore = new WorkspaceFeatureSettingsStore({
      workspacesDir: this.workspacesDir,
      indexLock: this._indexLock,
      readWorkspaceIndex: (hash) => this._readWorkspaceIndex(hash),
      writeWorkspaceIndex: (hash, index) => this._writeWorkspaceIndex(hash, index),
      getSettings: () => this.getSettings(),
    });

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
    await this._migrateCliProfiles();
    await this._buildLookupMap();
  }

  async createConversationArtifact(
    convId: string,
    input: CreateConversationArtifactInput,
  ): Promise<ConversationArtifact | null> {
    return this._artifactStore.createConversationArtifact(convId, input);
  }

  private async _migrateCliProfiles(): Promise<void> {
    const usedVendors = new Set<string>();
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
      if (!index || !Array.isArray(index.conversations)) continue;

      let changed = false;
      for (const conv of index.conversations) {
        const vendor = cliVendorForBackend(conv.backend);
        if (!vendor) continue;
        usedVendors.add(vendor);
        if (!conv.cliProfileId) {
          conv.cliProfileId = serverConfiguredCliProfileId(vendor);
          changed = true;
        }
      }

      if (changed) {
        await this._writeWorkspaceIndex(hash, index);
      }
    }

    await this._ensureServerConfiguredCliProfiles(usedVendors);
  }

  private async _ensureServerConfiguredCliProfiles(vendors: Iterable<string | undefined | null>): Promise<void> {
    const settings = await this._settingsService.getSettings();
    const ensured = ensureServerConfiguredCliProfiles(settings, vendors);
    if (ensured.changed) {
      await this._settingsService.saveSettings(ensured.settings);
    }
  }

  async resolveCliProfileRuntime(
    cliProfileId: string | undefined | null,
    fallbackBackend?: string | null,
  ): Promise<CliProfileRuntime> {
    const settings = await this._settingsService.getSettings();
    const resolved = resolveCliProfileRuntime(
      settings,
      cliProfileId,
      fallbackBackend || (!cliProfileId ? settings.defaultBackend || 'claude-code' : undefined),
    );
    if (resolved.error || !resolved.runtime) {
      throw new Error(resolved.error || 'Unable to resolve CLI profile');
    }
    return resolved.runtime;
  }

  private async _resolveRuntimeForConversation(
    conv: Pick<ConversationEntry, 'backend' | 'cliProfileId'>,
  ): Promise<CliProfileRuntime> {
    return this.resolveCliProfileRuntime(conv.cliProfileId, conv.backend);
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
      let index: WorkspaceIndex | null;
      try {
        index = await this._readWorkspaceIndex(hash);
      } catch (err) {
        // A corrupt index.json must not take the server down on startup.
        // Log and skip — the affected workspace becomes invisible until the
        // file is repaired, but every other workspace stays usable.
        log.error('Skipping workspace because index.json could not be read', { workspaceHash: hash, error: err });
        continue;
      }
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

  private _contextMapDir(hash: string): string {
    return path.join(this._workspaceDir(hash), 'context-map');
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
    await atomicWriteFile(this._workspaceIndexPath(hash), JSON.stringify(index, null, 2));
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
    await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
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
    runtime?: CliProfileRuntime,
  ): Promise<string> {
    if (!messages || messages.length === 0) return fallback || 'Empty session';
    const adapter = this._backendRegistry?.get(runtime?.backendId || 'claude-code');
    if (adapter) {
      return adapter.generateSummary(messages, fallback, { cliProfile: runtime?.profile });
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
    cliProfileId?: string,
    serviceTier?: ServiceTier | null,
  ): Promise<Conversation> {
    const id = this._newId();
    const now = new Date().toISOString();
    const sessionId = this._newId();
    const workspacePath = workingDir || this._defaultWorkspace;
    const hash = this._workspaceHash(workspacePath);
    const defaultBackend = this._backendRegistry?.getDefault()?.metadata.id || 'claude-code';
    const settings = await this._settingsService.getSettings();
    const requestedCliProfileId = cliProfileId || (!backend ? settings.defaultCliProfileId : undefined);
    const fallbackBackend = backend || (!requestedCliProfileId ? settings.defaultBackend || defaultBackend : undefined);
    const resolved = resolveCliProfileRuntime(
      settings,
      requestedCliProfileId,
      fallbackBackend,
    );
    if (resolved.error || !resolved.runtime) {
      throw new Error(resolved.error || 'Unable to resolve CLI profile');
    }
    const runtime = resolved.runtime;
    const resolvedBackend = runtime.backendId;
    if (backend && backend !== resolvedBackend) {
      throw new Error(`CLI profile backend ${resolvedBackend} does not match requested backend ${backend}`);
    }
    const resolvedCliProfileId = runtime.cliProfileId || cliProfileIdForBackend(resolvedBackend);
    if (!runtime.cliProfileId && resolvedCliProfileId) {
      await this._ensureServerConfiguredCliProfiles([resolvedBackend]);
    }

    return this._indexLock.run(hash, async () => {
      let index = await this._readWorkspaceIndex(hash);
      if (!index) {
        index = { workspacePath, conversations: [] };
      }

      const effective = this._effectiveEffort(resolvedBackend, model, effort);
      const requestedServiceTier = serviceTier === undefined ? settings.defaultServiceTier : serviceTier || undefined;
      const effectiveServiceTier = this._effectiveServiceTier(resolvedBackend, requestedServiceTier);
      const convEntry: ConversationEntry = {
        id,
        title: title || 'New Chat',
        backend: resolvedBackend,
        ...(resolvedCliProfileId ? { cliProfileId: resolvedCliProfileId } : {}),
        model: model || undefined,
        effort: effective,
        serviceTier: effectiveServiceTier,
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
        cliProfileId: convEntry.cliProfileId,
        model: convEntry.model,
        effort: convEntry.effort,
        serviceTier: convEntry.serviceTier,
        workingDir: workspacePath,
        workspaceHash: hash,
        currentSessionId: sessionId,
        sessionNumber: 1,
        messages: [],
      };
    });
  }

  /**
   * Returns the effort value that should be stored on a conversation given its
   * backend, model, and a requested effort. If the backend/model pair doesn't
   * support the requested level, the result falls back to `high` when
   * available, then the first supported level, or clears if nothing matches.
   */
  private _effectiveEffort(backend: string, model: string | undefined, requested: EffortLevel | undefined): EffortLevel | undefined {
    if (!requested || !model) return undefined;
    const adapter = this._backendRegistry?.get(backend);
    const modelOption = adapter?.metadata.models?.find(m => m.id === model);
    const supported = modelOption?.supportedEffortLevels;
    if (!supported || supported.length === 0) return undefined;
    if (supported.includes(requested)) return requested;
    if (supported.includes('high')) return 'high';
    return supported[0];
  }

  private _effectiveServiceTier(backend: string, requested: ServiceTier | undefined): ServiceTier | undefined {
    if (backend !== 'codex') return undefined;
    return requested === 'fast' ? 'fast' : undefined;
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
      cliProfileId: convEntry.cliProfileId,
      model: convEntry.model,
      effort: convEntry.effort,
      serviceTier: convEntry.serviceTier,
      workingDir: index.workspacePath,
      workspaceHash: hash,
      currentSessionId: convEntry.currentSessionId,
      sessionNumber,
      messages,
      usage: convEntry.usage || emptyUsage(),
      sessionUsage: activeSession?.usage || emptyUsage(),
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
          cliProfileId: conv.cliProfileId,
          model: conv.model,
          effort: conv.effort,
          serviceTier: conv.serviceTier,
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
    const hash = this._convWorkspaceMap.get(id);
    if (!hash) return null;
    await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(id);
      if (!result) return;
      const { index, convEntry } = result;
      convEntry.title = newTitle;
      convEntry.titleManuallySet = true;
      await this._writeWorkspaceIndex(hash, index);
    });
    return this.getConversation(id);
  }

  async archiveConversation(id: string): Promise<boolean> {
    const hash = this._convWorkspaceMap.get(id);
    if (!hash) return false;
    return this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(id);
      if (!result) return false;
      const { index, convEntry } = result;
      convEntry.archived = true;
      delete convEntry.messageQueue;
      await this._writeWorkspaceIndex(hash, index);
      return true;
    });
  }

  async restoreConversation(id: string): Promise<boolean> {
    const hash = this._convWorkspaceMap.get(id);
    if (!hash) return false;
    return this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(id);
      if (!result) return false;
      const { index, convEntry } = result;
      delete convEntry.archived;
      await this._writeWorkspaceIndex(hash, index);
      return true;
    });
  }

  async setConversationUnread(id: string, unread: boolean): Promise<boolean> {
    const hash = this._convWorkspaceMap.get(id);
    if (!hash) return false;
    return this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(id);
      if (!result) return false;
      const { index, convEntry } = result;
      if (unread) {
        if (convEntry.unread === true) return true;
        convEntry.unread = true;
      } else {
        if (!convEntry.unread) return true;
        delete convEntry.unread;
      }
      await this._writeWorkspaceIndex(hash, index);
      return true;
    });
  }

  async deleteConversation(id: string): Promise<boolean> {
    const hash = this._convWorkspaceMap.get(id);
    if (!hash) return false;
    return this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(id);
      if (!result) return false;
      const { index } = result;

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
    });
  }

  async updateConversationBackend(convId: string, backend: string): Promise<void> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return;
    const cliProfileId = cliProfileIdForBackend(backend);
    if (cliProfileId) {
      await this._ensureServerConfiguredCliProfiles([backend]);
    }
    await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return;
      const { index, convEntry } = result;
      const prevBackend = convEntry.backend;
      convEntry.backend = backend;
      if (cliProfileId) {
        convEntry.cliProfileId = cliProfileId;
      } else {
        delete convEntry.cliProfileId;
      }
      // contextUsagePercentage is a live snapshot from the backend (Kiro-only
      // today), not a cumulative value. Clear it on backend switch so a stale
      // Kiro percentage doesn't bleed into a Claude Code chip (or vice versa).
      if (prevBackend !== backend) {
        if (convEntry.usage) convEntry.usage.contextUsagePercentage = undefined;
        const activeSession = convEntry.sessions.find(s => s.active);
        if (activeSession?.usage) activeSession.usage.contextUsagePercentage = undefined;
      }
      if (backend !== 'codex') {
        delete convEntry.serviceTier;
      }
      await this._writeWorkspaceIndex(hash, index);
    });
  }

  async updateConversationCliProfile(convId: string, cliProfileId: string, requestedBackend?: string | null): Promise<void> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return;
    const current = await this._getConvFromIndex(convId);
    const runtime = await this.resolveCliProfileRuntime(cliProfileId, requestedBackend || current?.convEntry.backend);

    await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return;
      const { index, convEntry } = result;
      const prevBackend = convEntry.backend;
      convEntry.backend = runtime.backendId;
      convEntry.cliProfileId = runtime.cliProfileId;
      if (prevBackend !== runtime.backendId) {
        if (convEntry.usage) convEntry.usage.contextUsagePercentage = undefined;
        const activeSession = convEntry.sessions.find(s => s.active);
        if (activeSession?.usage) activeSession.usage.contextUsagePercentage = undefined;
      }
      if (runtime.backendId !== 'codex') {
        delete convEntry.serviceTier;
      }
      await this._writeWorkspaceIndex(hash, index);
    });
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
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return;
    await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return;
      const { index, convEntry } = result;
      const activeSession = convEntry.sessions.find(s => s.active);
      if (!activeSession) return;
      if (activeSession.externalSessionId === externalSessionId) return;
      activeSession.externalSessionId = externalSessionId;
      await this._writeWorkspaceIndex(hash, index);
    });
  }

  async updateConversationModel(convId: string, model: string | null): Promise<void> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return;
    await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return;
      const { index, convEntry } = result;
      convEntry.model = model || undefined;
      // Silently downgrade stored effort if the new model doesn't support it.
      if (convEntry.effort) {
        convEntry.effort = this._effectiveEffort(convEntry.backend, convEntry.model, convEntry.effort);
      }
      await this._writeWorkspaceIndex(hash, index);
    });
  }

  async updateConversationEffort(convId: string, effort: EffortLevel | null): Promise<void> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return;
    await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return;
      const { index, convEntry } = result;
      convEntry.effort = effort
        ? this._effectiveEffort(convEntry.backend, convEntry.model, effort)
        : undefined;
      await this._writeWorkspaceIndex(hash, index);
    });
  }

  async updateConversationServiceTier(convId: string, serviceTier: ServiceTier | null): Promise<void> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return;
    await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return;
      const { index, convEntry } = result;
      convEntry.serviceTier = serviceTier
        ? this._effectiveServiceTier(convEntry.backend, serviceTier)
        : undefined;
      await this._writeWorkspaceIndex(hash, index);
    });
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
    opts?: { streamError?: Message['streamError']; goalEvent?: Message['goalEvent'] },
  ): Promise<Message | null> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return null;
    return this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return null;
      const { index, convEntry } = result;

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
    });
  }

  async addStreamErrorMessage(
    convId: string,
    backend: string,
    message: string,
    source: StreamErrorSource = 'backend',
  ): Promise<Message | null> {
    const content = `Stream failed: ${message}`;
    return this.addMessage(
      convId,
      'assistant',
      content,
      backend,
      null,
      undefined,
      'final',
      undefined,
      { streamError: { message, source } },
    );
  }

  async updateMessageContent(convId: string, messageId: string, newContent: string): Promise<EditMessageResult | null> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return null;
    const msg = await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return null;
      const { index, convEntry } = result;

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

      return msg;
    });
    if (!msg) return null;

    const conversation = await this.getConversation(convId);
    return { conversation: conversation!, message: msg };
  }

  async setMessagePinned(convId: string, messageId: string, pinned: boolean): Promise<EditMessageResult | null> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return null;
    const msg = await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return null;
      const { convEntry } = result;

      const activeSession = convEntry.sessions.find(s => s.active);
      const sessionNumber = activeSession ? activeSession.number : 1;

      const sessionFile = await this._readSessionFile(hash, convId, sessionNumber);
      if (!sessionFile) return null;

      const msg = sessionFile.messages.find(m => m.id === messageId);
      if (!msg) return null;

      if (pinned) {
        msg.pinned = true;
      } else {
        delete msg.pinned;
      }
      await this._writeSessionFile(hash, convId, sessionNumber, sessionFile);
      return msg;
    });
    if (!msg) return null;

    const conversation = await this.getConversation(convId);
    return { conversation: conversation!, message: msg };
  }

  async generateAndUpdateTitle(convId: string, userMessage: string): Promise<string | null> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return null;

    // Resolve the adapter title OUTSIDE the lock — adapter calls are slow
    // (backend round-trips) and holding the per-workspace lock during that
    // window would stall every other mutator for this workspace, including
    // addMessage during active streams.
    const conv = await this._getConvFromIndex(convId);
    if (!conv) return null;
    // Skip auto-titling once the user has manually renamed: the adapter
    // round-trip is wasted work and we'd just overwrite the manual rename.
    if (conv.convEntry.titleManuallySet) return conv.convEntry.title;
    const runtime = await this._resolveRuntimeForConversation(conv.convEntry);
    const adapter = this._backendRegistry?.get(runtime.backendId);
    const fallback = userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    let newTitle: string;
    if (adapter && typeof adapter.generateTitle === 'function') {
      newTitle = await adapter.generateTitle(userMessage, fallback, { cliProfile: runtime.profile });
    } else {
      newTitle = fallback;
    }

    // Hard-cut titles to 8 words regardless of adapter output or fallback,
    // so sidebar/header entries don't wrap or crowd out sibling controls.
    const words = newTitle.trim().split(/\s+/);
    if (words.length > 8) {
      newTitle = words.slice(0, 8).join(' ');
    }

    return this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return null;
      const { index, convEntry } = result;
      // Re-check inside the lock: a manual rename may have landed between the
      // outer read above and acquiring the lock here. Don't clobber it.
      if (convEntry.titleManuallySet) return convEntry.title;
      convEntry.title = newTitle;
      await this._writeWorkspaceIndex(hash, index);
      return newTitle;
    });
  }

  // ── Message Queue Persistence ──────────────────────────────────────────────

  async getQueue(convId: string): Promise<QueuedMessage[]> {
    return this._messageQueueStore.getQueue(convId);
  }

  async setQueue(convId: string, queue: QueuedMessage[]): Promise<boolean> {
    return this._messageQueueStore.setQueue(convId, queue);
  }

  async clearQueue(convId: string): Promise<boolean> {
    return this._messageQueueStore.clearQueue(convId);
  }

  // ── Session Management ─────────────────────────────────────────────────────

  async resetSession(convId: string): Promise<ResetSessionResult | null> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return null;
    const summarySnapshot = await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return null;
      const { index, convEntry } = result;

      const now = new Date();
      const activeSession = convEntry.sessions.find(s => s.active);
      if (!activeSession) return null;

      const currentSessionNumber = activeSession.number;

      const sessionFile = await this._readSessionFile(hash, convId, currentSessionNumber);
      const currentMessages = sessionFile ? sessionFile.messages : [];

      const summary = `Session ${currentSessionNumber} (${currentMessages.length} messages)`;

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
      // Preserve a user-set title across resets; only auto-titled conversations
      // get stamped back to "New Chat" so the next session can re-derive a title.
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
      });

      await this._writeSessionFile(hash, convId, newSessionNumber, {
        sessionNumber: newSessionNumber,
        sessionId: newSessionId,
        startedAt: now.toISOString(),
        endedAt: null,
        messages: [],
      });

      await this._writeWorkspaceIndex(hash, index);

      return {
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
    });
    if (!summarySnapshot) return null;

    const conversation = await this.getConversation(convId);
    return {
      conversation: conversation!,
      newSessionNumber: summarySnapshot.newSessionNumber,
      archivedSession: summarySnapshot.archivedSession,
    };
  }

  async generateAndStoreSessionSummary(
    convId: string,
    sessionNumber: number,
    opts: { backendId?: string; cliProfileId?: string | null } = {},
  ): Promise<string | null> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return null;

    const snapshot = await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return null;
      const { convEntry } = result;
      const session = convEntry.sessions.find((candidate) => candidate.number === sessionNumber);
      if (!session || session.active) return null;
      const sessionFile = await this._readSessionFile(hash, convId, sessionNumber);
      const messages = sessionFile ? sessionFile.messages : [];
      return {
        messages,
        fallback: `Session ${sessionNumber} (${messages.length} messages)`,
        backendId: opts.backendId || convEntry.backend,
        cliProfileId: opts.cliProfileId === undefined ? convEntry.cliProfileId : opts.cliProfileId || undefined,
      };
    });
    if (!snapshot) return null;

    const runtime = await this.resolveCliProfileRuntime(snapshot.cliProfileId, snapshot.backendId);
    const summary = await this._generateSessionSummary(snapshot.messages, snapshot.fallback, runtime);

    return this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return null;
      const { index, convEntry } = result;
      const session = convEntry.sessions.find((candidate) => candidate.number === sessionNumber);
      if (!session || session.active) return null;
      session.summary = summary;
      await this._writeWorkspaceIndex(hash, index);
      return summary;
    });
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
      if (msg.streamError) {
        lines.push(`*Stream error${msg.streamError.source ? ` (${msg.streamError.source})` : ''}: ${msg.streamError.message}*`);
      }
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
        if (msg.streamError) {
          lines.push(`*Stream error${msg.streamError.source ? ` (${msg.streamError.source})` : ''}: ${msg.streamError.message}*`);
        }
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
    return this._workspaceInstructionStore.getInstructions(hash);
  }

  async setWorkspaceInstructions(hash: string, instructions: string): Promise<string | null> {
    return this._workspaceInstructionStore.setInstructions(hash, instructions);
  }

  async getWorkspaceInstructionCompatibility(hash: string): Promise<WorkspaceInstructionCompatibilityStatus | null> {
    return this._workspaceInstructionStore.getCompatibility(hash);
  }

  async createWorkspaceInstructionPointers(hash: string): Promise<{
    status: WorkspaceInstructionCompatibilityStatus;
    created: WorkspaceInstructionPointerResult[];
  } | null> {
    return this._workspaceInstructionStore.createPointers(hash);
  }

  async dismissWorkspaceInstructionCompatibility(hash: string): Promise<WorkspaceInstructionCompatibilityStatus | null> {
    return this._workspaceInstructionStore.dismissCompatibility(hash);
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

  private _memoryStatePath(hash: string): string {
    return path.join(this._memoryDir(hash), 'state.json');
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

  private _memoryReviewsDir(hash: string): string {
    return path.join(this._memoryDir(hash), 'reviews');
  }

  private _memoryReviewRunPath(hash: string, runId: string): string {
    return path.join(this._memoryReviewsDir(hash), `${runId}.json`);
  }

  private _emptyMemoryMetadataIndex(): MemoryMetadataIndex {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: {},
    };
  }

  private _normalizeMemoryMetadata(
    raw: unknown,
    fallbackFilename: string,
    fallbackSource: MemorySource,
    now: string,
  ): MemoryEntryMetadata {
    const candidate = raw && typeof raw === 'object'
      ? raw as Partial<MemoryEntryMetadata>
      : {};
    const filename = typeof candidate.filename === 'string' && candidate.filename
      ? candidate.filename
      : fallbackFilename;
    const createdAt = typeof candidate.createdAt === 'string' && candidate.createdAt
      ? candidate.createdAt
      : now;
    const updatedAt = typeof candidate.updatedAt === 'string' && candidate.updatedAt
      ? candidate.updatedAt
      : createdAt;
    const confidence = typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence)
      ? candidate.confidence
      : undefined;
    return {
      entryId: typeof candidate.entryId === 'string' && candidate.entryId
        ? candidate.entryId
        : memoryEntryId(filename),
      filename,
      status: normalizeMemoryStatus(candidate.status),
      scope: normalizeMemoryScope(candidate.scope),
      source: normalizeMemorySource(candidate.source, fallbackSource),
      createdAt,
      updatedAt,
      ...(typeof candidate.sourceConversationId === 'string' && candidate.sourceConversationId
        ? { sourceConversationId: candidate.sourceConversationId }
        : {}),
      ...(normalizeStringArray(candidate.supersedes) ? { supersedes: normalizeStringArray(candidate.supersedes) } : {}),
      ...(typeof candidate.supersededBy === 'string' && candidate.supersededBy
        ? { supersededBy: candidate.supersededBy }
        : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(normalizeMemoryRedaction(candidate.redaction) ? { redaction: normalizeMemoryRedaction(candidate.redaction) } : {}),
    };
  }

  private async _readMemoryMetadataIndex(hash: string): Promise<MemoryMetadataIndex> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(this._memoryStatePath(hash), 'utf8'));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this._emptyMemoryMetadataIndex();
      throw err;
    }

    const now = new Date().toISOString();
    const entries: Record<string, MemoryEntryMetadata> = {};
    const rawEntries = raw && typeof raw === 'object'
      ? (raw as { entries?: unknown }).entries
      : null;
    if (rawEntries && typeof rawEntries === 'object') {
      for (const [filename, entry] of Object.entries(rawEntries as Record<string, unknown>)) {
        const normalized = this._normalizeMemoryMetadata(entry, filename, memorySourceFromFilename(filename), now);
        entries[normalized.filename] = normalized;
      }
    }

    return {
      version: 1,
      updatedAt: raw && typeof raw === 'object' && typeof (raw as { updatedAt?: unknown }).updatedAt === 'string'
        ? (raw as { updatedAt: string }).updatedAt
        : now,
      entries,
    };
  }

  private async _writeMemoryMetadataIndex(hash: string, index: MemoryMetadataIndex): Promise<void> {
    await fsp.mkdir(this._memoryDir(hash), { recursive: true });
    await atomicWriteFile(this._memoryStatePath(hash), JSON.stringify(index, null, 2));
  }

  private async _attachMemoryMetadata(
    hash: string,
    files: MemoryFile[],
    persist: boolean,
  ): Promise<MemoryFile[]> {
    if (files.length === 0) {
      if (persist) {
        await this._writeMemoryMetadataIndex(hash, this._emptyMemoryMetadataIndex());
      }
      return files;
    }

    const existing = await this._readMemoryMetadataIndex(hash);
    const now = new Date().toISOString();
    const entries: Record<string, MemoryEntryMetadata> = {};
    const enriched = files.map((file) => {
      const source = normalizeMemorySource(file.source, 'cli-capture');
      const previous = existing.entries[file.filename] || file.metadata;
      const metadata = this._normalizeMemoryMetadata(previous, file.filename, source, now);
      const nextMetadata: MemoryEntryMetadata = {
        ...metadata,
        filename: file.filename,
        source,
      };
      entries[file.filename] = nextMetadata;
      return {
        ...file,
        source,
        metadata: nextMetadata,
      };
    });

    if (persist) {
      await this._writeMemoryMetadataIndex(hash, {
        version: 1,
        updatedAt: now,
        entries,
      });
    }

    return enriched;
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
        log.warn('Legacy memory migration could not move file', { from, to, error: err });
      }
    }
    log.info('Migrated legacy memory files', { count: loose.length, destination: claudeDir });
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
        log.warn('Could not read memory note', { path: full, error: err });
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

    const mergedFiles = await this._attachMemoryMetadata(hash, [...claudeFiles, ...notes], true);
    const merged: MemorySnapshot = {
      ...snapshot,
      files: mergedFiles,
    };

    await atomicWriteFile(
      this._memorySnapshotPath(hash),
      JSON.stringify(merged, null, 2),
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
      const files = await this._attachMemoryMetadata(hash, notes, false);
      return {
        capturedAt: new Date().toISOString(),
        sourceBackend: 'memory-note',
        sourcePath: null,
        index: '',
        files,
      };
    }

    // Rebuild: keep CLI-capture files as stored, but always re-read notes
    // fresh from disk so post-snapshot writes are reflected.
    const claudeFiles = (snapshot.files || []).filter(
      (f) => (f.source || 'cli-capture') === 'cli-capture',
    );
    const files = await this._attachMemoryMetadata(hash, [...claudeFiles, ...notes], false);
    return { ...snapshot, files };
  }

  async searchWorkspaceMemory(
    hash: string,
    options: MemorySearchOptions,
  ): Promise<MemorySearchResult[]> {
    const query = typeof options.query === 'string' ? options.query.trim() : '';
    const queryTerms = [...new Set(tokenizeMemorySearch(query))];
    if (queryTerms.length === 0) return [];
    const normalizedQuery = queryTerms.join(' ');

    const limit = Number.isInteger(options.limit)
      ? Math.max(1, Math.min(20, options.limit || 5))
      : 5;
    const allowedTypes: Set<MemoryType> | null = options.types && options.types.length
      ? new Set(options.types)
      : null;
    const allowedStatuses = options.statuses && options.statuses.length
      ? new Set(options.statuses)
      : new Set<MemoryStatus>(['active', 'redacted']);

    const snapshot = await this.getWorkspaceMemory(hash);
    const files = (snapshot?.files || [])
      .filter((file) => file.metadata)
      .filter((file) => allowedStatuses.has(file.metadata!.status))
      .filter((file) => !allowedTypes || allowedTypes.has(file.type));
    if (files.length === 0) return [];

    const docs = files.map((file) => {
      const tokens = tokenizeMemorySearch(memorySearchText(file));
      const counts = new Map<string, number>();
      for (const token of tokens) {
        counts.set(token, (counts.get(token) || 0) + 1);
      }
      return { file, tokens, counts };
    });
    const avgLen = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / Math.max(1, docs.length);
    const k1 = 1.2;
    const b = 0.75;

    const scored = docs.map((doc) => {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.counts.get(term) || 0;
        if (tf === 0) continue;
        const df = docs.reduce((count, candidate) => count + (candidate.counts.has(term) ? 1 : 0), 0);
        const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
        const lenNorm = k1 * (1 - b + b * (doc.tokens.length / Math.max(1, avgLen)));
        score += idf * ((tf * (k1 + 1)) / (tf + lenNorm));
      }
      score += memorySearchExactBoost(doc.file, normalizedQuery, queryTerms);
      score += memorySearchTypeBoost(doc.file, queryTerms, allowedTypes);
      return { ...doc, score, updatedAtMs: memorySearchTimestamp(doc.file) };
    })
      .filter((doc) => doc.score > 0)
      .sort((a, b) => b.score - a.score || b.updatedAtMs - a.updatedAtMs || a.file.filename.localeCompare(b.file.filename))
      .slice(0, limit);

    return scored.map((doc) => {
      const metadata = doc.file.metadata!;
      return {
        filename: doc.file.filename,
        entryId: metadata.entryId,
        name: doc.file.name,
        description: doc.file.description,
        type: doc.file.type,
        source: normalizeMemorySource(doc.file.source, memorySourceFromFilename(doc.file.filename)),
        status: metadata.status,
        score: Math.round(doc.score * 1000) / 1000,
        snippet: memorySearchSnippet(doc.file.content, queryTerms),
        content: doc.file.content,
        metadata,
      };
    });
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
   * Replace an existing Agent Cockpit-owned note entry in place. Claude
   * capture files are immutable from this path because the next native
   * capture can rewrite that subtree.
   */
  async replaceMemoryNoteEntry(hash: string, relPath: string, content: string): Promise<boolean> {
    if (!relPath.startsWith('notes/')) {
      throw new Error('Only notes entries can be replaced');
    }
    if (!relPath.endsWith('.md')) {
      throw new Error('Only .md entries can be replaced');
    }

    const notesDir = this._memoryNotesDir(hash);
    const resolved = path.resolve(this._memoryFilesDir(hash), relPath);
    if (!resolved.startsWith(path.resolve(notesDir) + path.sep)) {
      throw new Error('Path traversal rejected');
    }

    try {
      await fsp.access(resolved);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }

    await atomicWriteFile(resolved, content);
    await this._refreshSnapshotIndex(hash);
    return true;
  }

  /**
   * Restore a superseded entry to active state and remove its entry ID
   * from replacement entries' `supersedes[]` lists.
   */
  async restoreMemoryEntry(hash: string, relPath: string): Promise<MemoryEntryMetadata | null> {
    const snapshot = await this.getWorkspaceMemory(hash);
    if (!snapshot || !snapshot.files.length) return null;

    const existing = await this._readMemoryMetadataIndex(hash);
    const now = new Date().toISOString();
    const entries: Record<string, MemoryEntryMetadata> = {};
    for (const file of snapshot.files) {
      const source = normalizeMemorySource(file.source, memorySourceFromFilename(file.filename));
      const metadata = this._normalizeMemoryMetadata(
        existing.entries[file.filename] || file.metadata,
        file.filename,
        source,
        now,
      );
      entries[file.filename] = {
        ...metadata,
        filename: file.filename,
        source,
      };
    }

    const current = entries[relPath];
    if (!current) return null;
    if (current.status !== 'superseded') {
      throw new Error('Only superseded memory entries can be restored');
    }

    const { supersededBy: _supersededBy, ...restoredBase } = current;
    const restored = this._normalizeMemoryMetadata(
      {
        ...restoredBase,
        status: 'active',
        updatedAt: now,
      },
      current.filename,
      current.source,
      now,
    );
    entries[relPath] = restored;

    for (const [filename, entry] of Object.entries(entries)) {
      if (filename === relPath || !entry.supersedes?.includes(current.entryId)) continue;
      const nextSupersedes = entry.supersedes.filter((entryId) => entryId !== current.entryId);
      const { supersedes: _supersedes, ...entryBase } = entry;
      entries[filename] = this._normalizeMemoryMetadata(
        {
          ...entryBase,
          ...(nextSupersedes.length ? { supersedes: nextSupersedes } : {}),
          updatedAt: now,
        },
        entry.filename,
        entry.source,
        now,
      );
    }

    await this._writeMemoryMetadataIndex(hash, {
      version: 1,
      updatedAt: now,
      entries,
    });
    await this._refreshSnapshotIndex(hash);

    return restored;
  }

  /**
   * Patch Agent Cockpit-owned lifecycle metadata for existing memory files.
   * The markdown files remain untouched; the sidecar and snapshot are
   * reconciled so future reads expose the same metadata.
   */
  async patchMemoryEntryMetadata(
    hash: string,
    updates: Array<{
      filename: string;
      patch: {
        status?: MemoryStatus;
        scope?: MemoryScope;
        sourceConversationId?: string;
        supersedes?: string[];
        supersededBy?: string;
        confidence?: number;
        redaction?: MemoryRedaction[];
      };
    }>,
  ): Promise<MemoryEntryMetadata[]> {
    if (updates.length === 0) return [];

    const snapshot = await this.getWorkspaceMemory(hash);
    if (!snapshot || !snapshot.files.length) return [];

    const existing = await this._readMemoryMetadataIndex(hash);
    const now = new Date().toISOString();
    const entries: Record<string, MemoryEntryMetadata> = {};
    for (const file of snapshot.files) {
      const source = normalizeMemorySource(file.source, memorySourceFromFilename(file.filename));
      const metadata = this._normalizeMemoryMetadata(
        existing.entries[file.filename] || file.metadata,
        file.filename,
        source,
        now,
      );
      entries[file.filename] = {
        ...metadata,
        filename: file.filename,
        source,
      };
    }

    const patched: MemoryEntryMetadata[] = [];
    for (const update of updates) {
      const current = entries[update.filename];
      if (!current) continue;
      const next = this._normalizeMemoryMetadata(
        {
          ...current,
          ...update.patch,
          entryId: current.entryId,
          filename: current.filename,
          source: current.source,
          createdAt: current.createdAt,
          updatedAt: now,
        },
        current.filename,
        current.source,
        now,
      );
      entries[update.filename] = next;
      patched.push(next);
    }

    if (patched.length === 0) return [];

    await this._writeMemoryMetadataIndex(hash, {
      version: 1,
      updatedAt: now,
      entries,
    });
    await this._refreshSnapshotIndex(hash);

    return patched;
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
   * Persist a reviewable audit record for manual memory consolidation.
   * Consolidation never deletes files; this file captures metadata-only
   * supersession changes plus any advisory actions the user left unapplied.
   */
  async saveMemoryConsolidationAudit(
    hash: string,
    audit: Omit<MemoryConsolidationAudit, 'version' | 'createdAt'> & { createdAt?: string },
  ): Promise<string> {
    const createdAt = audit.createdAt || new Date().toISOString();
    const dir = path.join(this._memoryDir(hash), 'audits');
    await fsp.mkdir(dir, { recursive: true });
    const safeTimestamp = createdAt.replace(/[:.]/g, '-');
    const name = `consolidation_${safeTimestamp}.json`;
    const relPath = `audits/${name}`;
    const payload: MemoryConsolidationAudit = {
      version: 1,
      createdAt,
      summary: audit.summary,
      applied: audit.applied,
      skipped: audit.skipped,
      appliedDraftOperations: audit.appliedDraftOperations,
      skippedDraftOperations: audit.skippedDraftOperations,
    };
    await atomicWriteFile(path.join(dir, name), JSON.stringify(payload, null, 2));
    return relPath;
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
    const files = await this._attachMemoryMetadata(hash, [...claudeFiles, ...notes], true);
    const next: MemorySnapshot = {
      ...snapshot,
      capturedAt: new Date().toISOString(),
      files,
    };
    await atomicWriteFile(snapshotPath, JSON.stringify(next, null, 2));
  }

  /** Per-workspace Memory enable/disable (stored on the workspace index). */
  async getWorkspaceMemoryEnabled(hash: string): Promise<boolean> {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return false;
    return Boolean(index.memoryEnabled);
  }

  async setWorkspaceMemoryEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    return this._indexLock.run(hash, async () => {
      const index = await this._readWorkspaceIndex(hash);
      if (!index) return null;
      index.memoryEnabled = Boolean(enabled);
      await this._writeWorkspaceIndex(hash, index);
      return index.memoryEnabled;
    });
  }

  async getWorkspaceMemoryReviewSchedule(hash: string): Promise<MemoryReviewScheduleConfig> {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return { ...DEFAULT_MEMORY_REVIEW_SCHEDULE };
    return normalizeMemoryReviewScheduleConfig(index.memoryReviewSchedule);
  }

  async getWorkspaceMemoryReviewScheduleUpdatedAt(hash: string): Promise<string | undefined> {
    const index = await this._readWorkspaceIndex(hash);
    return index?.memoryReviewScheduleUpdatedAt;
  }

  async setWorkspaceMemoryReviewSchedule(
    hash: string,
    schedule: MemoryReviewScheduleConfig,
  ): Promise<MemoryReviewScheduleConfig | null> {
    return this._indexLock.run(hash, async () => {
      const index = await this._readWorkspaceIndex(hash);
      if (!index) return null;
      const next = normalizeMemoryReviewScheduleConfig(schedule);
      const prev = normalizeMemoryReviewScheduleConfig(index.memoryReviewSchedule);
      index.memoryReviewSchedule = next;
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        index.memoryReviewScheduleUpdatedAt = new Date().toISOString();
      }
      await this._writeWorkspaceIndex(hash, index);
      return index.memoryReviewSchedule;
    });
  }

  async listMemoryEnabledWorkspaceHashes(): Promise<string[]> {
    let dirs: string[];
    try {
      dirs = await fsp.readdir(this.workspacesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const hashes: string[] = [];
    for (const hash of dirs) {
      if (hash.startsWith('.')) continue;
      const index = await this._readWorkspaceIndex(hash);
      if (index?.memoryEnabled) hashes.push(hash);
    }
    return hashes;
  }

  async saveMemoryReviewRun(hash: string, run: MemoryReviewRun): Promise<MemoryReviewRun> {
    if (!validMemoryReviewRunId(run.id)) {
      throw new Error('Invalid memory review run id');
    }
    await fsp.mkdir(this._memoryReviewsDir(hash), { recursive: true });
    await atomicWriteFile(this._memoryReviewRunPath(hash, run.id), JSON.stringify(run, null, 2));
    return run;
  }

  async getMemoryReviewRun(hash: string, runId: string): Promise<MemoryReviewRun | null> {
    if (!validMemoryReviewRunId(runId)) return null;
    try {
      const raw = await fsp.readFile(this._memoryReviewRunPath(hash, runId), 'utf8');
      return JSON.parse(raw) as MemoryReviewRun;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async listMemoryReviewRuns(hash: string): Promise<MemoryReviewRun[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this._memoryReviewsDir(hash));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const runs: MemoryReviewRun[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const runId = name.slice(0, -'.json'.length);
      if (!validMemoryReviewRunId(runId)) continue;
      const run = await this.getMemoryReviewRun(hash, runId);
      if (run) runs.push(run);
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return runs;
  }

  async getMemoryReviewSourceFingerprints(
    hash: string,
    filenames: string[],
  ): Promise<Record<string, string>> {
    const unique = [...new Set(filenames.filter(Boolean))];
    const snapshot = await this.getWorkspaceMemory(hash);
    const byFilename = new Map((snapshot?.files || []).map((file) => [file.filename, file]));
    const fingerprints: Record<string, string> = {};
    for (const filename of unique) {
      const file = byFilename.get(filename);
      fingerprints[filename] = file ? memoryFileFingerprint(file) : `missing:${filename}`;
    }
    return fingerprints;
  }

  async getMemorySnapshotFingerprint(hash: string): Promise<string> {
    const snapshot = await this.getWorkspaceMemory(hash);
    const files = (snapshot?.files || [])
      .slice()
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .map((file) => `${file.filename}:${memoryFileFingerprint(file)}`);
    return crypto.createHash('sha256').update(files.join('\n')).digest('hex');
  }

  async hasMemoryChangedSinceLastReview(hash: string): Promise<boolean> {
    const current = await this.getMemorySnapshotFingerprint(hash);
    const runs = await this.listMemoryReviewRuns(hash);
    const latest = runs.find((run) => run.status !== 'running');
    if (!latest) {
      const snapshot = await this.getWorkspaceMemory(hash);
      return (snapshot?.files || []).length > 0;
    }
    return latest.sourceSnapshotFingerprint !== current;
  }

  async hasMemoryChangedSinceLastScheduledReview(hash: string, since?: string): Promise<boolean> {
    const current = await this.getMemorySnapshotFingerprint(hash);
    const runs = await this.listMemoryReviewRuns(hash);
    const latest = runs.find((run) => (
      run.source === 'scheduled'
      && run.status !== 'running'
      && (!since || run.createdAt >= since)
    ));
    if (!latest) {
      const snapshot = await this.getWorkspaceMemory(hash);
      return (snapshot?.files || []).length > 0;
    }
    return latest.sourceSnapshotFingerprint !== current;
  }

  async getMemoryReviewStatus(hash: string): Promise<ConversationMemoryReviewStatus> {
    const enabled = await this.getWorkspaceMemoryEnabled(hash);
    const runs = await this.listMemoryReviewRuns(hash);
    const actionableRuns = runs.filter((run) => run.status === 'pending_review' || run.status === 'running' || run.status === 'failed');
    const latest = actionableRuns[0] || runs[0];
    const lastRun = runs[0];
    const pendingDrafts = actionableRuns.reduce(
      (sum, run) => sum + run.drafts.filter((item) => item.status === 'pending' || item.status === 'stale' || item.status === 'failed').length,
      0,
    );
    const pendingSafeActions = actionableRuns.reduce(
      (sum, run) => sum + run.safeActions.filter((item) => item.status === 'pending' || item.status === 'stale' || item.status === 'failed').length,
      0,
    );
    const failedItems = actionableRuns.reduce(
      (sum, run) => sum
        + run.failures.length
        + run.drafts.filter((item) => item.status === 'failed' || item.status === 'stale').length
        + run.safeActions.filter((item) => item.status === 'failed' || item.status === 'stale').length,
      0,
    );
    return {
      enabled,
      pending: actionableRuns.length > 0 || failedItems > 0,
      pendingRuns: actionableRuns.length,
      pendingDrafts,
      pendingSafeActions,
      failedItems,
      ...(latest ? {
        latestRunId: latest.id,
        latestRunStatus: latest.status,
        latestRunCreatedAt: latest.createdAt,
        latestRunUpdatedAt: latest.updatedAt,
        latestRunSource: latest.source,
      } : {}),
      ...(lastRun ? {
        lastRunId: lastRun.id,
        lastRunStatus: lastRun.status,
        lastRunCreatedAt: lastRun.createdAt,
        lastRunUpdatedAt: lastRun.updatedAt,
        lastRunSource: lastRun.source,
      } : {}),
    };
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
    cliProfile?: CliProfile,
  ): Promise<MemorySnapshot | null> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) {
      log.info('Skipping memory capture because conversation has no workspace hash', { convId });
      return null;
    }
    const index = await this._readWorkspaceIndex(hash);
    if (!index) {
      log.info('Skipping memory capture because workspace index is missing', { convId, workspaceHash: hash });
      return null;
    }

    const adapter = this._backendRegistry?.get(backendId);
    if (!adapter) {
      log.info('Skipping memory capture because backend adapter is missing', { backendId });
      return null;
    }

    log.info('Extracting workspace memory', { convId, backendId, workspacePath: index.workspacePath });
    let snapshot: MemorySnapshot | null = null;
    try {
      snapshot = await adapter.extractMemory(index.workspacePath, { cliProfile });
    } catch (err: unknown) {
      log.error('Memory extraction failed', { backendId, workspacePath: index.workspacePath, error: err });
      return null;
    }

    if (!snapshot) {
      log.info('Memory extraction returned no snapshot', { backendId, workspacePath: index.workspacePath });
      return null;
    }

    try {
      await this.saveWorkspaceMemory(hash, snapshot);
    } catch (err: unknown) {
      log.error('Saving workspace memory failed', { convId, workspaceHash: hash, error: err });
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
      log.warn('Could not create workspace memory pointer directory', { path: filesDir, error: err });
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
        log.warn('Failed to close KB database', { workspaceHash: hash, error: err });
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
        log.warn('Failed to close KB vector store', { workspaceHash: hash, error: err });
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
    const updated = await this._indexLock.run(hash, async () => {
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
      return { config: index.kbEmbedding, wipe: modelChanged || dimsChanged };
    });
    if (!updated) return null;

    // When model or dimensions change, wipe existing embeddings so they
    // get regenerated on the next digest/dream cycle.
    if (updated.wipe && this._kbVectorStores.has(hash)) {
      try {
        const store = this._kbVectorStores.get(hash)!;
        await store.close();
        this._kbVectorStores.delete(hash);
      } catch { /* ignore close errors */ }
    }

    return updated.config;
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
    return this._featureSettingsStore.getKbEnabled(hash);
  }

  async setWorkspaceKbEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    return this._featureSettingsStore.setKbEnabled(hash, enabled);
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
    return this._featureSettingsStore.getKbAutoDigest(hash);
  }

  async setWorkspaceKbAutoDigest(hash: string, autoDigest: boolean): Promise<boolean | null> {
    return this._featureSettingsStore.setKbAutoDigest(hash, autoDigest);
  }

  async getWorkspaceKbAutoDream(hash: string): Promise<KbAutoDreamConfig> {
    return this._featureSettingsStore.getKbAutoDream(hash);
  }

  async setWorkspaceKbAutoDream(hash: string, autoDream: KbAutoDreamConfig): Promise<KbAutoDreamConfig | null> {
    return this._featureSettingsStore.setKbAutoDream(hash, autoDream);
  }

  async listKbEnabledWorkspaceHashes(): Promise<string[]> {
    return this._featureSettingsStore.listKbEnabledWorkspaceHashes();
  }

  /** Per-workspace Context Map enable/disable (stored on the workspace index). */
  async getWorkspaceContextMapEnabled(hash: string): Promise<boolean> {
    return this._featureSettingsStore.getContextMapEnabled(hash);
  }

  async setWorkspaceContextMapEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    return this._featureSettingsStore.setContextMapEnabled(hash, enabled);
  }

  async getWorkspaceContextMapSettings(hash: string): Promise<ContextMapWorkspaceSettings | null> {
    return this._featureSettingsStore.getContextMapSettings(hash);
  }

  async setWorkspaceContextMapSettings(
    hash: string,
    settings: unknown,
  ): Promise<ContextMapWorkspaceSettings | null> {
    return this._featureSettingsStore.setContextMapSettings(hash, settings);
  }

  async listContextMapEnabledWorkspaceHashes(): Promise<string[]> {
    return this._featureSettingsStore.listContextMapEnabledWorkspaceHashes();
  }

  async getContextMapStatus(hash: string): Promise<ConversationContextMapStatus> {
    const enabled = await this.getWorkspaceContextMapEnabled(hash);
    if (!enabled) {
      return {
        enabled: false,
        pending: false,
        pendingCandidates: 0,
        staleCandidates: 0,
        conflictCandidates: 0,
        failedCandidates: 0,
        runningRuns: 0,
        failedRuns: 0,
      };
    }

    const db = this.getContextMapDb(hash);
    const candidates = db ? db.listCandidates() : [];
    const runs = db ? db.listRuns() : [];
    const latest = runs.length ? runs[runs.length - 1] : undefined;
    const failedRuns = runs.filter((run) => run.status === 'failed').length;
    const runningRuns = runs.filter((run) => run.status === 'running').length;
    const pendingCandidates = candidates.filter((candidate) => candidate.status === 'pending').length;
    const staleCandidates = candidates.filter((candidate) => candidate.status === 'stale').length;
    const conflictCandidates = candidates.filter((candidate) => candidate.status === 'conflict').length;
    const failedCandidates = candidates.filter((candidate) => candidate.status === 'failed').length;

    return {
      enabled: true,
      pending: pendingCandidates + staleCandidates + conflictCandidates + failedCandidates + failedRuns + runningRuns > 0,
      pendingCandidates,
      staleCandidates,
      conflictCandidates,
      failedCandidates,
      runningRuns,
      failedRuns,
      ...(latest ? {
        latestRunId: latest.runId,
        latestRunStatus: latest.status,
        latestRunCreatedAt: latest.startedAt,
        latestRunUpdatedAt: latest.completedAt || latest.startedAt,
        latestRunSource: latest.source,
        lastRunId: latest.runId,
        lastRunStatus: latest.status,
        lastRunCreatedAt: latest.startedAt,
        lastRunUpdatedAt: latest.completedAt || latest.startedAt,
        lastRunSource: latest.source,
      } : {}),
    };
  }

  getContextMapDb(hash: string): ContextMapDatabase | null {
    if (!hash) return null;
    const cached = this._contextMapDbs.get(hash);
    if (cached) return cached;
    fs.mkdirSync(this._contextMapDir(hash), { recursive: true });
    const db = openContextMapDatabase(this._contextMapDir(hash));
    this._contextMapDbs.set(hash, db);
    return db;
  }

  /** Close every cached Context Map database. Call during graceful shutdown. */
  closeContextMapDatabases(): void {
    for (const [hash, db] of this._contextMapDbs.entries()) {
      try {
        db.close();
      } catch (err: unknown) {
        log.warn('Failed to close Context Map database', { workspaceHash: hash, error: err });
      }
    }
    this._contextMapDbs.clear();
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
      return this._emptyKbSnapshot(Boolean(index.kbAutoDigest), index.kbAutoDream);
    }

    const db = this.getKbDb(hash);
    if (!db) return this._emptyKbSnapshot(Boolean(index.kbAutoDigest), index.kbAutoDream);

    const folderPath = opts.folderPath !== undefined
      ? normalizeFolderPath(opts.folderPath)
      : '';

    const sessionRow = db.getDigestSession();
    const digestProgress = sessionRow ? computeDigestProgress(sessionRow) : null;
    const synthesisSnapshot = db.getSynthesisSnapshot();
    const counters = await this._withKbEmbeddingCounters(hash, db, index.kbEmbedding, db.getCounters());

    return {
      version: KB_STATE_VERSION,
      entrySchemaVersion: KB_ENTRY_SCHEMA_VERSION,
      autoDigest: Boolean(index.kbAutoDigest),
      autoDream: normalizeKbAutoDreamConfig(index.kbAutoDream),
      dreamingStatus: synthesisSnapshot.status,
      dreamProgress: synthesisSnapshot.dreamProgress,
      needsSynthesisCount: synthesisSnapshot.needsSynthesisCount,
      counters,
      folders: db.listFolders(),
      raw: db.listRawInFolder(folderPath, {
        limit: opts.limit,
        offset: opts.offset,
      }),
      digestProgress,
      updatedAt: new Date().toISOString(),
    };
  }

  private async _withKbEmbeddingCounters(
    hash: string,
    db: KbDatabase,
    cfg: EmbeddingConfig | undefined,
    counters: KbCounters,
  ): Promise<KbCounters> {
    const enriched: KbCounters = {
      ...counters,
      embeddingConfigured: Boolean(cfg),
      entryEmbeddedCount: null,
      topicEmbeddedCount: null,
      embeddingIndexError: null,
    };
    if (!cfg) return enriched;
    try {
      const resolved = resolveConfig(cfg);
      const store = await this.getKbVectorStore(hash, resolved.dimensions);
      if (!store) {
        enriched.embeddingIndexError = 'Vector store unavailable';
        return enriched;
      }
      const [embeddedEntryIds, embeddedTopicIds] = await Promise.all([
        store.embeddedEntryIds(),
        store.embeddedTopicIds(),
      ]);
      enriched.entryEmbeddedCount = db.listEntryIds().filter((entryId) => embeddedEntryIds.has(entryId)).length;
      enriched.topicEmbeddedCount = db.listTopicIds().filter((topicId) => embeddedTopicIds.has(topicId)).length;
    } catch (err: unknown) {
      enriched.embeddingIndexError = (err as Error).message || 'Vector store unavailable';
    }
    return enriched;
  }

  /** Zero-value snapshot used when KB is disabled or not yet initialized. */
  private _emptyKbSnapshot(autoDigest: boolean, autoDream?: KbAutoDreamConfig): KbState {
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
      failedByStage: {
        conversion: 0,
        digestion: 0,
        unknown: 0,
      },
      entryCount: 0,
      pendingCount: 0,
      folderCount: 0,
      documentCount: 0,
      documentNodeCount: 0,
      entrySourceCount: 0,
      topicCount: 0,
      connectionCount: 0,
      reflectionCount: 0,
      staleReflectionCount: 0,
      embeddingConfigured: false,
      entryEmbeddedCount: null,
      topicEmbeddedCount: null,
      embeddingIndexError: null,
    };
    return {
      version: KB_STATE_VERSION,
      entrySchemaVersion: KB_ENTRY_SCHEMA_VERSION,
      autoDigest,
      autoDream: normalizeKbAutoDreamConfig(autoDream),
      dreamingStatus: 'idle',
      dreamProgress: null,
      needsSynthesisCount: 0,
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
      log.warn('Could not create workspace KB pointer directory', { path: entriesDir, error: err });
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
        log.error('Failed to read legacy conversation during migration', { convId, error: err });
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
    log.info('Migrated legacy conversations to workspace format', { count: files.length });
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
        log.error('Failed to rename legacy directory during migration', { path: oldName, backupPath: backupName, error: err });
      }
    }
  }

  // ── Usage Tracking ─────────────────────────────────────────────────────────

  async addUsage(convId: string, usage: Usage, backend?: string, model?: string, options?: { skipLedger?: boolean }): Promise<{ conversationUsage: Usage; sessionUsage: Usage } | null> {
    if (!usage) return null;
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return null;
    const mutated = await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return null;
      const { index, convEntry } = result;

      // Conversation-level totals
      if (!convEntry.usage) convEntry.usage = emptyUsage();
      addToUsage(convEntry.usage, usage);

      // Per-backend on conversation
      const backendId = backend || convEntry.backend;
      if (!convEntry.usageByBackend) convEntry.usageByBackend = {};
      if (!convEntry.usageByBackend[backendId]) convEntry.usageByBackend[backendId] = emptyUsage();
      addToUsage(convEntry.usageByBackend[backendId], usage);

      // Session-level totals + per-backend
      let sessionUsage = emptyUsage();
      const activeSession = convEntry.sessions.find(s => s.active);
      if (activeSession) {
        if (!activeSession.usage) activeSession.usage = emptyUsage();
        addToUsage(activeSession.usage, usage);
        sessionUsage = activeSession.usage;

        if (!activeSession.usageByBackend) activeSession.usageByBackend = {};
        if (!activeSession.usageByBackend[backendId]) activeSession.usageByBackend[backendId] = emptyUsage();
        addToUsage(activeSession.usageByBackend[backendId], usage);
      }

      await this._writeWorkspaceIndex(hash, index);
      return { conversationUsage: convEntry.usage, sessionUsage, backendId };
    });
    if (!mutated) return null;

    // Record to daily ledger (fire-and-forget, don't block the response)
    // Skip ledger for backends that don't provide token-based usage (e.g. Kiro)
    if (!options?.skipLedger) {
      this._usageLedgerStore.record(mutated.backendId, model || 'unknown', usage).catch(err => {
        log.error('Failed to write usage ledger', { error: err });
      });
    }

    return { conversationUsage: mutated.conversationUsage, sessionUsage: mutated.sessionUsage };
  }

  async getUsage(convId: string): Promise<Usage | null> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    const { convEntry } = result;
    return convEntry.usage || emptyUsage();
  }

  async getUsageStats(): Promise<UsageLedger> {
    return this._usageLedgerStore.read();
  }

  async clearUsageStats(): Promise<void> {
    await this._usageLedgerStore.clear();
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
