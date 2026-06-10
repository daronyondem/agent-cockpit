import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { BackendRegistry } from './backends/registry';
import { SettingsService } from './settingsService';
import {
  backendForCliProfile,
  cliHarnessForBackend,
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
  ConversationWorkspaceContextStatus,
  EffortLevel,
  ClaudeCodeMode,
  ServiceTier,
  KbState,
  KbCounters,
  KbRawStatus,
  KbAutoDreamConfig,
  ConversationArtifact,
  QueuedMessage,
  CliProfile,
  StreamErrorSource,
  SessionRecoverySnapshot,
  WorkspaceInstructionCompatibilityStatus,
  WorkspaceInstructionPointerResult,
  WorkspaceContextWorkspaceSettings,
  ConversationCheckout,
  WorktreeIsolationSettings,
} from '../types';
import {
  normalizeFolderPath,
  KbDatabase,
} from './knowledgeBase/db';
import { computeDigestProgress } from './knowledgeBase/digest';
import { DEFAULT_KB_AUTO_DREAM_CONFIG, normalizeKbAutoDreamConfig } from './knowledgeBase/autoDream';
import { KbVectorStore } from './knowledgeBase/vectorStore';
import { resolveConfig, type EmbeddingConfig } from './knowledgeBase/embeddings';
import { atomicWriteFile } from '../utils/atomicWrite';
import { KeyedMutex } from '../utils/keyedMutex';
import { logger } from '../utils/logger';
import {
  MessageQueueStore,
  normalizeMessageQueue,
} from './chat/messageQueueStore';
import { WorkspaceSessionStore } from './chat/workspaceSessionStore';
import { ConversationLifecycleStore } from './chat/conversationLifecycleStore';
import {
  buildMessageWindow,
  collectPinnedMessages,
  ConversationMessageStore,
  type ConversationMessagesWindowResult,
  type MessageWindowOptions,
} from './chat/conversationMessageStore';
import { WorkspaceMemoryStore } from './chat/workspaceMemoryStore';
import { WorkspaceKnowledgeStore } from './chat/workspaceKnowledgeStore';
import { WorkspaceInstructionStore } from './chat/workspaceInstructionStore';
import { UsageLedgerStore, emptyUsage } from './chat/usageLedgerStore';
import { ConversationUsageStore } from './chat/conversationUsageStore';
import { ClaudeTranscriptUsageImportService } from './claudeTranscriptUsageImportService';
import { writeSessionRecoverySnapshot } from './chat/sessionRecoveryStore';
import { applyCostEstimate } from './usagePricing/estimator';
import { UsagePricingStore } from './usagePricing/store';
import type { UsagePricingEntry, UsagePricingResponse } from './usagePricing/types';
import { ArtifactStore, type CreateConversationArtifactInput } from './chat/artifactStore';
import { WorkspaceFeatureSettingsStore } from './chat/workspaceFeatureSettingsStore';
import { WorkspaceArchiveStore, type WorkspaceArchiveFinalizerTarget } from './chat/workspaceArchiveStore';
import { WorkspaceSnapshotService } from './chat/workspaceSnapshotService';
import {
  WorkspaceIdentityPathConflictError,
  WorkspaceIdentityStore,
} from './chat/workspaceIdentityStore';
import {
  WorktreeIsolationService,
  WorktreeIsolationError,
  normalizeCheckout,
} from './chat/worktreeIsolationService';
import type { WorktreeIsolationStatusResponse } from '../contracts/worktreeIsolation';
import type {
  WorkspaceArchiveRequest,
  WorkspaceLocationResponse,
  WorkspaceSnapshotEstimateResponse,
  WorkspaceSnapshotInclusionPolicy,
  WorkspaceSummaryResponse,
} from '../contracts/workspaces';

const log = logger.child({ module: 'chat-service' });

export { attachmentFromPath } from './chat/attachments';
export { normalizeMessageQueue, parseUploadedFilesTag } from './chat/messageQueueStore';

export class WorkspaceLocationUpdateError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'WorkspaceLocationUpdateError';
    this.code = code;
    this.status = status;
  }
}

export class WorkspaceArchiveError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'WorkspaceArchiveError';
    this.code = code;
    this.status = status;
  }
}

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

interface ConversationWorkspaceContextStatusRun {
  runId: string;
  source: ConversationWorkspaceContextStatus['latestRunSource'];
  status: ConversationWorkspaceContextStatus['latestRunStatus'];
  startedAt: string;
  completedAt?: string;
}

function normalizeWorkspaceContextStatusRun(value: unknown): ConversationWorkspaceContextStatusRun | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.runId !== 'string' || typeof record.startedAt !== 'string') return undefined;
  const status = record.status === 'running' || record.status === 'completed' || record.status === 'failed' || record.status === 'stopped' || record.status === 'skipped'
    ? record.status
    : undefined;
  const source = record.source === 'initial_scan' || record.source === 'scheduled' || record.source === 'session_reset' || record.source === 'archive' || record.source === 'manual_catchup' || record.source === 'maintenance'
    ? record.source
    : undefined;
  if (!status || !source) return undefined;
  return {
    runId: record.runId,
    source,
    status,
    startedAt: record.startedAt,
    completedAt: typeof record.completedAt === 'string' ? record.completedAt : undefined,
  };
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
  workspaceRegistryFile: string;
  usageLedgerFile: string;
  usagePricingOverridesFile: string;
  private _settingsService: SettingsService;
  private _workspaceSessionStore: WorkspaceSessionStore;
  private _conversationLifecycleStore: ConversationLifecycleStore;
  private _conversationMessageStore: ConversationMessageStore;
  private _workspaceMemoryStore: WorkspaceMemoryStore;
  private _messageQueueStore: MessageQueueStore;
  private _workspaceInstructionStore: WorkspaceInstructionStore;
  private _usageLedgerStore: UsageLedgerStore;
  private _conversationUsageStore: ConversationUsageStore;
  private _claudeTranscriptUsageImporter: ClaudeTranscriptUsageImportService;
  private _usagePricingStore: UsagePricingStore;
  private _artifactStore: ArtifactStore;
  private _workspaceIdentityStore: WorkspaceIdentityStore;
  private _featureSettingsStore: WorkspaceFeatureSettingsStore;
  private _workspaceArchiveStore: WorkspaceArchiveStore;
  private _workspaceSnapshotService: WorkspaceSnapshotService;
  private _worktreeIsolation: WorktreeIsolationService;
  private _defaultWorkspace: string;
  private _backendRegistry: BackendRegistry | null;
  private _convWorkspaceMap: Map<string, string>;
  private _legacyConversationsDir: string;
  private _legacyArchivesDir: string;
  private _workspaceKnowledgeStore: WorkspaceKnowledgeStore;
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
    this.workspaceRegistryFile = path.join(this.baseDir, 'workspaces.json');
    this.usageLedgerFile = path.join(this.baseDir, 'usage-ledger.json');
    this.usagePricingOverridesFile = path.join(this.baseDir, 'usage-pricing-overrides.json');
    this._usagePricingStore = new UsagePricingStore(this.usagePricingOverridesFile);
    this._usageLedgerStore = new UsageLedgerStore(this.usageLedgerFile, (backendId, model, usage, context) => (
      this._estimateUsageCost(backendId, model, usage, context?.pricingTier)
    ));
    this._claudeTranscriptUsageImporter = new ClaudeTranscriptUsageImportService(
      path.join(this.baseDir, 'claude-transcript-usage-import.json'),
      this._usageLedgerStore,
    );
    this._settingsService = new SettingsService(this.baseDir);
    this._defaultWorkspace = options.defaultWorkspace || DEFAULT_WORKSPACE_FALLBACK;
    this._backendRegistry = options.backendRegistry || null;
    this._convWorkspaceMap = new Map();
    this._conversationUsageStore = new ConversationUsageStore({
      convWorkspaceMap: this._convWorkspaceMap,
      indexLock: this._indexLock,
      getConvFromIndex: (convId) => this._getConvFromIndex(convId),
      writeWorkspaceIndex: (hash, index) => this._writeWorkspaceIndex(hash, index),
    });
    this._workspaceIdentityStore = new WorkspaceIdentityStore({
      registryPath: this.workspaceRegistryFile,
      workspacesDir: this.workspacesDir,
    });
    this._workspaceSessionStore = new WorkspaceSessionStore({
      workspacesDir: this.workspacesDir,
      convWorkspaceMap: this._convWorkspaceMap,
      resolveWorkspaceId: (ref) => this._workspaceIdentityStore.resolveWorkspaceId(ref),
      resolveWorkspaceStorageKey: (ref) => this._workspaceIdentityStore.resolveStorageKey(ref),
      resolveWorkspace: (ref) => this._workspaceIdentityStore.resolve(ref),
      log,
    });
    this._conversationLifecycleStore = new ConversationLifecycleStore({
      workspacesDir: this.workspacesDir,
      convWorkspaceMap: this._convWorkspaceMap,
      indexLock: this._indexLock,
      readWorkspaceIndex: (hash) => this._readWorkspaceIndex(hash),
      writeWorkspaceIndex: (hash, index) => this._writeWorkspaceIndex(hash, index),
      getConvFromIndex: (convId) => this._getConvFromIndex(convId),
      resolveWorkspaceId: (ref) => this._workspaceIdentityStore.resolveWorkspaceId(ref),
      workspaceLegacyHashForRef: (ref) => this._workspaceLegacyHashForRef(ref),
    });
    this._conversationMessageStore = new ConversationMessageStore({
      convWorkspaceMap: this._convWorkspaceMap,
      indexLock: this._indexLock,
      getConvFromIndex: (convId) => this._getConvFromIndex(convId),
      readSessionFile: (hash, convId, sessionNumber) => this._readSessionFile(hash, convId, sessionNumber),
      writeSessionFile: (hash, convId, sessionNumber, data) => this._writeSessionFile(hash, convId, sessionNumber, data),
      writeWorkspaceIndex: (hash, index) => this._writeWorkspaceIndex(hash, index),
      newId: () => this._newId(),
    });
    this._workspaceMemoryStore = new WorkspaceMemoryStore({
      getWorkspaceDir: (hash) => this._workspaceDir(hash),
    });
    this._workspaceKnowledgeStore = new WorkspaceKnowledgeStore({
      getWorkspaceDir: (hash) => this._workspaceDir(hash),
      resolveWorkspaceId: (ref) => this._workspaceIdentityStore.resolveWorkspaceId(ref),
      log,
    });
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
    this._worktreeIsolation = new WorktreeIsolationService();
    this._featureSettingsStore = new WorkspaceFeatureSettingsStore({
      workspacesDir: this.workspacesDir,
      getWorkspaceDir: (hash) => this._workspaceDir(hash),
      indexLock: this._indexLock,
      readWorkspaceIndex: (hash) => this._readWorkspaceIndex(hash),
      writeWorkspaceIndex: (hash, index) => this._writeWorkspaceIndex(hash, index),
      getSettings: () => this.getSettings(),
    });
    this._workspaceArchiveStore = new WorkspaceArchiveStore({
      workspacesDir: this.workspacesDir,
      indexLock: this._indexLock,
      readWorkspaceIndex: (hash) => this._readWorkspaceIndex(hash),
      writeWorkspaceIndex: (hash, index) => this._writeWorkspaceIndex(hash, index),
      resolveWorkspaceId: (ref) => this._workspaceIdentityStore.resolveWorkspaceId(ref),
      workspaceLegacyHashForRef: (ref) => this._workspaceLegacyHashForRef(ref),
      getWorkspaceDir: (ref) => this._workspaceDir(ref),
      previousPathsForRef: (ref) => [...(this._workspaceIdentityStore.resolve(ref)?.previousPaths || [])],
    });
    this._workspaceSnapshotService = new WorkspaceSnapshotService({
      snapshotsDir: path.join(this.baseDir, 'workspace-snapshots'),
      trashDir: path.join(this.baseDir, 'workspace-trash'),
      restoredDir: path.join(this.baseDir, 'restored-workspaces'),
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
    await this._workspaceIdentityStore.initialize();
    await this._usagePricingStore.readOverrides();
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
    const usedHarnesses = new Set<string>();
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
        const harness = cliHarnessForBackend(conv.backend);
        if (!harness) continue;
        if (!conv.cliProfileId) {
          usedHarnesses.add(harness);
          conv.cliProfileId = serverConfiguredCliProfileId(harness);
          changed = true;
        }
      }

      if (changed) {
        await this._writeWorkspaceIndex(hash, index);
      }
    }

    await this._ensureServerConfiguredCliProfiles(usedHarnesses);
  }

  private async _ensureServerConfiguredCliProfiles(harnesses: Iterable<string | undefined | null>): Promise<void> {
    const settings = await this._settingsService.getSettings();
    const ensured = ensureServerConfiguredCliProfiles(settings, harnesses);
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
      fallbackBackend,
    );
    if (resolved.error || !resolved.runtime) {
      throw new Error(resolved.error || 'Unable to resolve CLI profile');
    }
    return resolved.runtime;
  }

  async resolveCliProfileRuntimeForSessionReset(
    cliProfileId: string | undefined | null,
    fallbackBackend?: string | null,
  ): Promise<CliProfileRuntime> {
    const settings = await this._settingsService.getSettings();
    const resolved = resolveCliProfileRuntime(settings, cliProfileId, fallbackBackend);
    if (!resolved.error && resolved.runtime) {
      return resolved.runtime;
    }

    const enabledProfiles = Array.isArray(settings.cliProfiles)
      ? settings.cliProfiles.filter((profile) => profile && !profile.disabled)
      : [];
    if (enabledProfiles.length === 0) {
      throw new Error('CLI profile is required to reset this conversation because no enabled CLI profiles are configured. Configure a CLI profile in Global Settings before resetting this conversation.');
    }
    if (enabledProfiles.length === 1) {
      const profile = enabledProfiles[0];
      return {
        backendId: backendForCliProfile(profile, fallbackBackend || settings.defaultBackend),
        cliProfileId: profile.id,
        profile,
      };
    }

    throw new Error(`${resolved.error || 'Unable to resolve CLI profile'}. Multiple CLI profiles are configured, so choose a replacement profile before resetting this conversation.`);
  }

  private async _resolveRuntimeForConversation(
    conv: Pick<ConversationEntry, 'backend' | 'cliProfileId'>,
  ): Promise<CliProfileRuntime> {
    return this.resolveCliProfileRuntime(conv.cliProfileId, conv.backend);
  }

  private async _buildLookupMap(): Promise<void> {
    await this._workspaceSessionStore.rebuildConversationWorkspaceMap();
  }

  // ── Workspace helpers ──────────────────────────────────────────────────────

  private _newId(): string {
    return crypto.randomUUID();
  }

  private _workspaceHash(workspacePath: string): string {
    return this._workspaceIdentityStore.legacyHashForPath(workspacePath);
  }

  private _workspaceIdForRef(ref: string): string {
    return this._workspaceIdentityStore.resolveWorkspaceId(ref) || ref;
  }

  private _workspaceLegacyHashForRef(ref: string): string {
    const record = this._workspaceIdentityStore.resolve(ref);
    return record?.legacyHash || ref;
  }

  private _workspaceDir(hash: string): string {
    return this._workspaceSessionStore.workspaceDir(hash);
  }

  getWorkspaceContextDir(hash: string): string {
    return this._workspaceSessionStore.workspaceContextDir(hash);
  }

  getWorkspaceMemoryFilesDir(hash: string): string {
    return this._memoryFilesDir(this._workspaceIdForRef(hash));
  }

  getConversationSessionFilePath(hash: string, convId: string, sessionNumber: number): string {
    return this._sessionFilePath(hash, convId, sessionNumber);
  }

  private _sessionFilePath(hash: string, convId: string, sessionNumber: number): string {
    return this._workspaceSessionStore.sessionFilePath(hash, convId, sessionNumber);
  }

  private async _readWorkspaceIndex(hash: string): Promise<WorkspaceIndex | null> {
    return this._workspaceSessionStore.readWorkspaceIndex(hash);
  }

  private async _writeWorkspaceIndex(hash: string, index: WorkspaceIndex): Promise<void> {
    await this._workspaceSessionStore.writeWorkspaceIndex(hash, index);
  }

  private async _readSessionFile(hash: string, convId: string, sessionNumber: number): Promise<SessionFile | null> {
    return this._workspaceSessionStore.readSessionFile(hash, convId, sessionNumber);
  }

  private async _writeSessionFile(hash: string, convId: string, sessionNumber: number, data: SessionFile): Promise<void> {
    await this._workspaceSessionStore.writeSessionFile(hash, convId, sessionNumber, data);
  }

  private async _getConvFromIndex(convId: string): Promise<ConvLookupResult | null> {
    return this._workspaceSessionStore.getConvFromIndex(convId);
  }

  private _checkoutForConversation(convEntry: ConversationEntry): ConversationCheckout | undefined {
    const checkout = normalizeCheckout(convEntry.checkout);
    return checkout.mode === 'worktree' ? checkout : undefined;
  }

  private _executionDirForConversation(index: WorkspaceIndex, convEntry: ConversationEntry): string {
    const checkout = this._checkoutForConversation(convEntry);
    return checkout?.executionDir || index.workspacePath;
  }

  private _sessionBranchName(convId: string, sessionNumber: number): string {
    return this._worktreeIsolation.branchName(convId, sessionNumber);
  }

  private async _advanceConversationSession(
    hash: string,
    convEntry: ConversationEntry,
    now: Date,
    opts: { branchName?: string; baseRef?: string } = {},
  ): Promise<ResetSessionResult['archivedSession'] | null> {
    const activeSession = convEntry.sessions.find(s => s.active);
    if (!activeSession) return null;

    const currentSessionNumber = activeSession.number;
    const sessionFile = await this._readSessionFile(hash, convEntry.id, currentSessionNumber);
    const currentMessages = sessionFile ? sessionFile.messages : [];
    const summary = `Session ${currentSessionNumber} (${currentMessages.length} messages)`;

    activeSession.active = false;
    activeSession.summary = summary;
    activeSession.endedAt = now.toISOString();
    activeSession.messageCount = currentMessages.length;

    if (sessionFile) {
      sessionFile.endedAt = now.toISOString();
      await this._writeSessionFile(hash, convEntry.id, currentSessionNumber, sessionFile);
    }

    const newSessionNumber = currentSessionNumber + 1;
    const newSessionId = this._newId();

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

    await this._writeSessionFile(hash, convEntry.id, newSessionNumber, {
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

  private async _generateSessionSummary(
    messages: Pick<Message, 'role' | 'content'>[],
    fallback: string,
    runtime?: CliProfileRuntime,
  ): Promise<string> {
    if (!messages || messages.length === 0) return fallback || 'Empty session';
    const adapter = runtime?.backendId ? this._backendRegistry?.get(runtime.backendId) : undefined;
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
    claudeCodeMode?: ClaudeCodeMode | null,
  ): Promise<Conversation> {
    const id = this._newId();
    const now = new Date().toISOString();
    const sessionId = this._newId();
    const workspacePath = workingDir || this._defaultWorkspace;
    const settings = await this._settingsService.getSettings();
    const requestedCliProfileId = cliProfileId || (!backend ? settings.defaultCliProfileId : undefined);
    const fallbackBackend = backend || (!requestedCliProfileId ? settings.defaultBackend : undefined);
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
    const workspaceRecord = await this._workspaceIdentityStore.ensureWorkspaceForPath(workspacePath);
    const workspaceId = workspaceRecord.workspaceId;
    const legacyHash = workspaceRecord.legacyHash;

    return this._indexLock.run(workspaceId, async () => {
      let index = await this._readWorkspaceIndex(workspaceId);
      if (!index) {
        index = { workspaceId, workspacePath, conversations: [] };
      }
      if (index.archive) {
        throw new WorkspaceArchiveError(
          'workspace_archived',
          'Workspace is archived. Restore it before creating new conversations.',
          409,
        );
      }
      index.workspaceId = workspaceId;

      let checkout: ConversationCheckout | undefined;
      let branchName: string | undefined;
      const isolation = index.worktreeIsolation;
      if (isolation?.enabled) {
        await this._worktreeIsolation.assertBaseReady(isolation);
        branchName = this._sessionBranchName(id, 1);
        checkout = await this._worktreeIsolation.createConversationWorktree(isolation, id, branchName);
      }

      const effective = this._effectiveEffort(resolvedBackend, model, effort);
      const effectiveClaudeCodeMode = this._effectiveClaudeCodeMode(resolvedBackend, model, claudeCodeMode || undefined);
      const requestedServiceTier = serviceTier === undefined ? settings.defaultServiceTier : serviceTier || undefined;
      const effectiveServiceTier = this._effectiveServiceTier(resolvedBackend, requestedServiceTier);
      const convEntry: ConversationEntry = {
        id,
        title: title || 'New Chat',
        backend: resolvedBackend,
        ...(resolvedCliProfileId ? { cliProfileId: resolvedCliProfileId } : {}),
        model: model || undefined,
        effort: effective,
        claudeCodeMode: effectiveClaudeCodeMode,
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
          ...(branchName ? { branchName } : {}),
          ...(isolation?.remoteBaseRef ? { baseRef: isolation.remoteBaseRef } : {}),
        }],
        ...(checkout ? { checkout } : {}),
      };

      index.conversations.push(convEntry);
      await this._writeWorkspaceIndex(workspaceId, index);

      await this._writeSessionFile(workspaceId, id, 1, {
        sessionNumber: 1,
        sessionId,
        startedAt: now,
        endedAt: null,
        messages: [],
      });

      this._convWorkspaceMap.set(id, workspaceId);

      return {
        id,
        title: convEntry.title,
        backend: convEntry.backend,
        cliProfileId: convEntry.cliProfileId,
        model: convEntry.model,
        effort: convEntry.effort,
        claudeCodeMode: convEntry.claudeCodeMode,
        serviceTier: convEntry.serviceTier,
        workingDir: workspacePath,
        ...(checkout ? { executionDir: checkout.executionDir, checkout } : {}),
        workspaceId,
        workspaceHash: legacyHash,
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

  private _effectiveClaudeCodeMode(backend: string, model: string | undefined, requested: ClaudeCodeMode | undefined): ClaudeCodeMode | undefined {
    if (requested !== 'ultracode' || !model) return undefined;
    if (cliHarnessForBackend(backend) !== 'claude-code') return undefined;
    const adapter = this._backendRegistry?.get(backend);
    const modelOption = adapter?.metadata.models?.find(m => m.id === model);
    return modelOption?.supportedEffortLevels?.includes('xhigh') ? 'ultracode' : undefined;
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
    const checkout = this._checkoutForConversation(convEntry);

    return {
      id: convEntry.id,
      title: convEntry.title,
      titleManuallySet: convEntry.titleManuallySet,
      backend: convEntry.backend,
      cliProfileId: convEntry.cliProfileId,
      model: convEntry.model,
      effort: convEntry.effort,
      claudeCodeMode: convEntry.claudeCodeMode,
      serviceTier: convEntry.serviceTier,
      workingDir: index.workspacePath,
      ...(checkout ? { executionDir: checkout.executionDir, checkout } : {}),
      workspaceId: index.workspaceId || hash,
      workspaceHash: this._workspaceLegacyHashForRef(hash),
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

  async getConversationWithMessageWindow(id: string, opts?: MessageWindowOptions): Promise<Conversation | null> {
    const conv = await this.getConversation(id);
    if (!conv) return null;
    const messageWindow = buildMessageWindow(conv.messages, opts);
    if (!messageWindow) return null;
    return {
      ...conv,
      messages: messageWindow.messages,
      messageWindow,
      pinnedMessages: collectPinnedMessages(conv.messages),
    };
  }

  async getConversationMessages(id: string, opts?: MessageWindowOptions): Promise<ConversationMessagesWindowResult | null> {
    const conv = await this.getConversation(id);
    if (!conv) return null;
    const messageWindow = buildMessageWindow(conv.messages, opts);
    if (!messageWindow) return null;
    return {
      messages: messageWindow.messages,
      messageWindow,
      pinnedMessages: collectPinnedMessages(conv.messages),
    };
  }

  async listConversations(opts?: { archived?: boolean; includeArchivedWorkspaces?: boolean }): Promise<ConversationListItem[]> {
    return this._conversationLifecycleStore.listConversations(opts);
  }

  async renameConversation(id: string, newTitle: string): Promise<Conversation | null> {
    const renamed = await this._conversationLifecycleStore.renameConversation(id, newTitle);
    if (!renamed) return null;
    return this.getConversation(id);
  }

  async archiveConversation(id: string): Promise<boolean> {
    return this._conversationLifecycleStore.archiveConversation(id);
  }

  async restoreConversation(id: string): Promise<boolean> {
    return this._conversationLifecycleStore.restoreConversation(id);
  }

  async setConversationUnread(id: string, unread: boolean): Promise<boolean> {
    return this._conversationLifecycleStore.setConversationUnread(id, unread);
  }

  async deleteConversation(id: string): Promise<boolean> {
    const hash = this._convWorkspaceMap.get(id);
    if (!hash) return false;
    return this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(id);
      if (!result) return false;
      const { index, convEntry } = result;

      const checkout = normalizeCheckout(convEntry.checkout);
      if (index.worktreeIsolation?.enabled && checkout.mode === 'worktree') {
        await this._worktreeIsolation.removeConversationWorktree(index.worktreeIsolation, checkout, convEntry);
      }

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
      convEntry.claudeCodeMode = this._effectiveClaudeCodeMode(convEntry.backend, convEntry.model, convEntry.claudeCodeMode);
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
      convEntry.claudeCodeMode = this._effectiveClaudeCodeMode(convEntry.backend, convEntry.model, convEntry.claudeCodeMode);
      await this._writeWorkspaceIndex(hash, index);
    });
  }

  /**
   * Persist a backend-managed session ID onto the active `SessionEntry`.
   * Called by `processStream` when an adapter emits an `external_session`
   * event (e.g. Kiro's ACP session ID after `session/new`). Stored on the
   * active session so `SendMessageOptions.externalSessionId` can rehydrate
   * the backend's in-memory session map after a cockpit server restart.
   * Harness-agnostic — any backend that manages its own session IDs uses
   * the same field.
   */
  async setExternalSessionId(convId: string, externalSessionId: string): Promise<void> {
    await this._conversationLifecycleStore.setExternalSessionId(convId, externalSessionId);
  }

  async createSessionRecoverySnapshot(
    convId: string,
    args: {
      backend: string;
      previousNativeSessionId: string;
      reason: string;
      messageLimit?: number;
    },
  ): Promise<SessionRecoverySnapshot | null> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return null;
    return this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return null;
      const { index, convEntry } = result;
      const activeSession = convEntry.sessions.find(s => s.active);
      const sessionNumber = activeSession ? activeSession.number : 1;
      const sessionFile = await this._readSessionFile(hash, convId, sessionNumber);
      if (!sessionFile) return null;

      const limit = Number.isFinite(args.messageLimit)
        ? Math.max(0, Math.min(sessionFile.messages.length, Math.floor(args.messageLimit!)))
        : sessionFile.messages.length;
      const messages = sessionFile.messages.slice(0, limit);
      const recoveryCount = sessionFile.messages.filter(message => message.sessionRecovery).length + 1;
      const sourceSessionPath = this._sessionFilePath(hash, convId, sessionNumber);

      return writeSessionRecoverySnapshot({
        conversationDir: path.join(this._workspaceDir(hash), convId),
        conversationId: convId,
        conversationTitle: convEntry.title,
        workspaceId: index.workspaceId || hash,
        workspacePath: index.workspacePath,
        backend: args.backend,
        previousNativeSessionId: args.previousNativeSessionId,
        reason: args.reason,
        sourceSessionId: sessionFile.sessionId,
        sourceSessionNumber: sessionNumber,
        sourceSessionPath,
        messages,
        recoveryCount,
      });
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
      convEntry.claudeCodeMode = this._effectiveClaudeCodeMode(convEntry.backend, convEntry.model, convEntry.claudeCodeMode);
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

  async updateConversationClaudeCodeMode(convId: string, claudeCodeMode: ClaudeCodeMode | null): Promise<void> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return;
    await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return;
      const { index, convEntry } = result;
      convEntry.claudeCodeMode = claudeCodeMode
        ? this._effectiveClaudeCodeMode(convEntry.backend, convEntry.model, claudeCodeMode)
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
    opts?: {
      streamError?: Message['streamError'];
      goalEvent?: Message['goalEvent'];
      sessionRecovery?: Message['sessionRecovery'];
    },
  ): Promise<Message | null> {
    return this._conversationMessageStore.addMessage(
      convId,
      role,
      content,
      backend,
      thinking,
      toolActivity,
      turn,
      contentBlocks,
      opts,
    );
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
    const msg = await this._conversationMessageStore.updateMessageContent(convId, messageId, newContent);
    if (!msg) return null;

    const conversation = await this.getConversation(convId);
    return { conversation: conversation!, message: msg };
  }

  async setMessagePinned(convId: string, messageId: string, pinned: boolean): Promise<EditMessageResult | null> {
    const msg = await this._conversationMessageStore.setMessagePinned(convId, messageId, pinned);
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

  async resetSession(
    convId: string,
    opts: { runtime?: CliProfileRuntime } = {},
  ): Promise<ResetSessionResult | null> {
    const hash = this._convWorkspaceMap.get(convId);
    if (!hash) return null;
    const summarySnapshot = await this._indexLock.run(hash, async () => {
      const result = await this._getConvFromIndex(convId);
      if (!result) return null;
      const { index, convEntry } = result;

      const now = new Date();
      const activeSession = convEntry.sessions.find(s => s.active);
      if (!activeSession) return null;

      const runtime = opts.runtime || await this.resolveCliProfileRuntimeForSessionReset(convEntry.cliProfileId, convEntry.backend);
      const previousBackend = convEntry.backend;
      convEntry.backend = runtime.backendId;
      if (runtime.cliProfileId) {
        convEntry.cliProfileId = runtime.cliProfileId;
      } else {
        delete convEntry.cliProfileId;
      }
      if (previousBackend !== runtime.backendId) {
        if (convEntry.usage) convEntry.usage.contextUsagePercentage = undefined;
        if (activeSession.usage) activeSession.usage.contextUsagePercentage = undefined;
      }
      if (runtime.backendId !== 'codex') {
        delete convEntry.serviceTier;
      }
      convEntry.claudeCodeMode = this._effectiveClaudeCodeMode(convEntry.backend, convEntry.model, convEntry.claudeCodeMode);

      const currentSessionNumber = activeSession.number;
      const newSessionNumber = currentSessionNumber + 1;
      let branchName: string | undefined;
      let baseRef: string | undefined;
      if (index.worktreeIsolation?.enabled) {
        branchName = this._sessionBranchName(convEntry.id, newSessionNumber);
        baseRef = index.worktreeIsolation.remoteBaseRef;
        const checkout = await this._worktreeIsolation.resetConversationWorktree(
          index.worktreeIsolation,
          normalizeCheckout(convEntry.checkout),
          convEntry,
          branchName,
        );
        convEntry.checkout = checkout;
      }

      const archivedSession = await this._advanceConversationSession(hash, convEntry, now, { branchName, baseRef });
      if (!archivedSession) return null;

      await this._writeWorkspaceIndex(hash, index);

      return {
        newSessionNumber,
        archivedSession,
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
    return this._conversationMessageStore.getSessionHistory(convId);
  }

  async getSessionMessages(convId: string, sessionNumber: number): Promise<Message[] | null> {
    return this._conversationMessageStore.getSessionMessages(convId, sessionNumber);
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

  private _normalizeWorkspaceInstructionStatus(
    ref: string,
    status: WorkspaceInstructionCompatibilityStatus | null,
  ): WorkspaceInstructionCompatibilityStatus | null {
    if (!status) return null;
    const record = this._workspaceIdentityStore.resolve(ref) || this._workspaceIdentityStore.resolve(status.workspaceId);
    const workspaceId = record?.workspaceId || status.workspaceId;
    return {
      ...status,
      workspaceId,
      workspaceHash: record?.legacyHash || this._workspaceLegacyHashForRef(workspaceId),
    };
  }

  async getWorkspaceInstructions(hash: string): Promise<string | null> {
    return this._workspaceInstructionStore.getInstructions(this._workspaceIdForRef(hash));
  }

  async setWorkspaceInstructions(hash: string, instructions: string): Promise<string | null> {
    return this._workspaceInstructionStore.setInstructions(this._workspaceIdForRef(hash), instructions);
  }

  async getWorkspaceInstructionCompatibility(hash: string): Promise<WorkspaceInstructionCompatibilityStatus | null> {
    const workspaceId = this._workspaceIdForRef(hash);
    return this._normalizeWorkspaceInstructionStatus(
      hash,
      await this._workspaceInstructionStore.getCompatibility(workspaceId),
    );
  }

  async createWorkspaceInstructionPointers(hash: string): Promise<{
    status: WorkspaceInstructionCompatibilityStatus;
    created: WorkspaceInstructionPointerResult[];
  } | null> {
    const workspaceId = this._workspaceIdForRef(hash);
    const result = await this._workspaceInstructionStore.createPointers(workspaceId);
    if (!result) return null;
    return {
      ...result,
      status: this._normalizeWorkspaceInstructionStatus(hash, result.status) || result.status,
    };
  }

  async dismissWorkspaceInstructionCompatibility(hash: string): Promise<WorkspaceInstructionCompatibilityStatus | null> {
    const workspaceId = this._workspaceIdForRef(hash);
    return this._normalizeWorkspaceInstructionStatus(
      hash,
      await this._workspaceInstructionStore.dismissCompatibility(workspaceId),
    );
  }

  getWorkspaceHashForConv(convId: string): string | null {
    const workspaceId = this._convWorkspaceMap.get(convId);
    if (!workspaceId) return null;
    return this._workspaceLegacyHashForRef(workspaceId);
  }

  getWorkspaceIdForConv(convId: string): string | null {
    return this._convWorkspaceMap.get(convId) || null;
  }

  getWorkspaceIdForRef(ref: string): string | null {
    return this._workspaceIdentityStore.resolveWorkspaceId(ref) || null;
  }

  getWorkspaceStorageKey(ref: string): string | null {
    return this._workspaceIdentityStore.resolveStorageKey(ref) || null;
  }

  async getWorkspacePath(hash: string): Promise<string | null> {
    const index = await this._readWorkspaceIndex(hash);
    return index?.workspacePath || null;
  }

  async listWorkspaces(opts?: { archived?: boolean; includeArchived?: boolean }): Promise<WorkspaceSummaryResponse[]> {
    return this._workspaceArchiveStore.listWorkspaces(opts);
  }

  async getWorkspaceSummary(hash: string): Promise<WorkspaceSummaryResponse | null> {
    return this._workspaceArchiveStore.getWorkspaceSummary(hash);
  }

  async isWorkspaceArchived(hash: string): Promise<boolean> {
    return this._workspaceArchiveStore.isWorkspaceArchived(hash);
  }

  async archiveWorkspace(hash: string, request: WorkspaceArchiveRequest): Promise<WorkspaceSummaryResponse | null> {
    const mode = request.mode || 'history_only';
    if (mode === 'file_snapshot') {
      const existing = await this.getWorkspaceSummary(hash);
      if (!existing) return null;
      if (existing.archived) return existing;
      const snapshotRequest = request.snapshot || {};
      const inclusionPolicy = snapshotRequest.inclusionPolicy || 'exclude_common';
      const cleanupOriginal = snapshotRequest.cleanupOriginal || 'keep';
      if (cleanupOriginal === 'delete_permanently' && snapshotRequest.confirmDeleteOriginal !== 'DELETE ORIGINAL') {
        throw new WorkspaceArchiveError(
          'delete_original_confirmation_required',
          'confirmDeleteOriginal must be DELETE ORIGINAL when cleanupOriginal is delete_permanently',
          400,
        );
      }
      const snapshot = await this._workspaceSnapshotService.createSnapshot(existing.workspaceId, existing.workspacePath, inclusionPolicy);
      let workspace = await this._workspaceArchiveStore.archiveWorkspace(existing.workspaceId, {
        mode,
        note: request.note,
        snapshot,
      });
      const archivedSnapshotId = workspace?.archive?.snapshot?.id;
      if (archivedSnapshotId !== snapshot.id) {
        await this._workspaceSnapshotService.deleteSnapshot(snapshot);
      }
      if (cleanupOriginal !== 'keep' && archivedSnapshotId === snapshot.id) {
        try {
          const cleanup = await this._workspaceSnapshotService.cleanupOriginal(existing.workspaceId, existing.workspacePath, cleanupOriginal);
          workspace = await this._workspaceArchiveStore.setOriginalCleanup(existing.workspaceId, {
            mode: cleanupOriginal,
            movedTo: cleanup.movedTo,
          }) || workspace;
        } catch (err: unknown) {
          workspace = await this._workspaceArchiveStore.setOriginalCleanup(existing.workspaceId, {
            mode: cleanupOriginal,
            error: (err as Error).message,
          }) || workspace;
        }
      }
      return workspace;
    }
    return this._workspaceArchiveStore.archiveWorkspace(hash, {
      mode,
      note: request.note,
    });
  }

  async estimateWorkspaceSnapshot(
    hash: string,
    inclusionPolicy: WorkspaceSnapshotInclusionPolicy,
  ): Promise<WorkspaceSnapshotEstimateResponse | null> {
    const summary = await this.getWorkspaceSummary(hash);
    if (!summary) return null;
    return this._workspaceSnapshotService.estimate(summary.workspaceId, summary.workspacePath, inclusionPolicy);
  }

  async completeWorkspaceArchiveFinalLearningPass(hash: string, error?: string): Promise<WorkspaceSummaryResponse | null> {
    return this._workspaceArchiveStore.completeFinalLearningPass(hash, error);
  }

  async restoreWorkspace(hash: string): Promise<WorkspaceSummaryResponse | null> {
    const summary = await this.getWorkspaceSummary(hash);
    if (!summary) return null;
    if (!summary.archived) return summary;
    if (!summary.pathAvailable) {
      throw new WorkspaceArchiveError(
        'workspace_path_unavailable',
        'Workspace folder is unavailable. Remap this archived workspace to an existing folder before restoring.',
        409,
      );
    }
    return this._workspaceArchiveStore.restoreWorkspace(summary.workspaceId);
  }

  async restoreWorkspaceFromSnapshot(hash: string, destinationPath?: string): Promise<WorkspaceSummaryResponse | null> {
    const summary = await this.getWorkspaceSummary(hash);
    if (!summary) return null;
    if (!summary.archived) return summary;
    const snapshot = summary.archive?.snapshot;
    if (!snapshot) {
      throw new WorkspaceArchiveError('snapshot_unavailable', 'Archived workspace does not have a file snapshot', 409);
    }
    const destination = destinationPath?.trim()
      || this._workspaceSnapshotService.defaultRestoreDestination(summary.workspaceId, summary.workspacePath);
    const restoredPath = await this._workspaceSnapshotService.restoreSnapshot(snapshot, destination);
    await this.updateWorkspaceLocation(summary.workspaceId, restoredPath);
    return this._workspaceArchiveStore.restoreWorkspace(summary.workspaceId);
  }

  async deleteArchivedWorkspaceData(hash: string): Promise<boolean> {
    const workspaceId = this._workspaceIdForRef(hash);
    return this._indexLock.run(workspaceId, async () => {
      const index = await this._readWorkspaceIndex(workspaceId);
      if (!index) return false;
      if (!index.archive) {
        throw new WorkspaceArchiveError(
          'workspace_not_archived',
          'Workspace must be archived before its retained data can be deleted.',
          409,
        );
      }
      const conversationIds = index.conversations.map((conv) => conv.id);
      await fsp.rm(this._workspaceDir(workspaceId), { recursive: true, force: true });
      await this._workspaceSnapshotService.deleteRetainedArtifacts(
        workspaceId,
        index.archive?.originalCleanup?.movedTo,
      );
      for (const convId of conversationIds) {
        await fsp.rm(path.join(this.artifactsDir, convId), { recursive: true, force: true });
        this._convWorkspaceMap.delete(convId);
      }
      await this._workspaceIdentityStore.removeWorkspace(workspaceId);
      return true;
    });
  }

  async getWorkspaceArchiveFinalizerTargets(hash: string): Promise<WorkspaceArchiveFinalizerTarget[]> {
    return this._workspaceArchiveStore.getFinalizerTargets(hash);
  }

  async getWorkspaceLocation(hash: string): Promise<WorkspaceLocationResponse | null> {
    const index = await this._readWorkspaceIndex(hash);
    if (!index) return null;
    const workspaceId = index.workspaceId || this._workspaceIdentityStore.resolveWorkspaceId(hash) || hash;
    const record = this._workspaceIdentityStore.resolve(workspaceId);
    return {
      workspaceId,
      workspacePath: index.workspacePath,
      legacyHash: record?.legacyHash || this._workspaceLegacyHashForRef(workspaceId),
      previousPaths: [...(record?.previousPaths || [])],
    };
  }

  async updateWorkspaceLocation(hash: string, workspacePath: string): Promise<WorkspaceLocationResponse | null> {
    const current = await this._readWorkspaceIndex(hash);
    if (!current) return null;
    const workspaceId = current.workspaceId || this._workspaceIdentityStore.resolveWorkspaceId(hash) || hash;
    const nextPath = path.resolve(workspacePath.trim());
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(nextPath);
    } catch {
      throw new WorkspaceLocationUpdateError('path_not_found', 'Workspace path does not exist', 400);
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceLocationUpdateError('not_directory', 'Workspace path must be a directory', 400);
    }

    const existing = this._workspaceIdentityStore.getByPath(nextPath)
      || this._workspaceIdentityStore.getByPath(workspacePath.trim());
    if (existing && existing.workspaceId !== workspaceId) {
      throw new WorkspaceLocationUpdateError('path_already_registered', 'Workspace path is already registered to another workspace', 409);
    }

    return this._indexLock.run(workspaceId, async () => {
      const index = await this._readWorkspaceIndex(workspaceId);
      if (!index) return null;
      if (index.worktreeIsolation?.enabled && !index.archive) {
        throw new WorkspaceLocationUpdateError(
          'worktree_isolation_enabled',
          'Disable Worktrees before changing the workspace location',
          409,
        );
      }
      const record = await (async () => {
        try {
          return await this._workspaceIdentityStore.updateWorkspacePath(workspaceId, nextPath);
        } catch (err) {
          if (err instanceof WorkspaceIdentityPathConflictError) {
            throw new WorkspaceLocationUpdateError('path_already_registered', 'Workspace path is already registered to another workspace', 409);
          }
          throw err;
        }
      })();
      if (!record) return null;
      index.workspaceId = workspaceId;
      index.workspacePath = nextPath;
      await this._writeWorkspaceIndex(workspaceId, index);
      return {
        workspaceId,
        workspacePath: nextPath,
        legacyHash: record.legacyHash,
        previousPaths: [...record.previousPaths],
      };
    });
  }

  async getConversationExecutionDir(convId: string): Promise<string | null> {
    const result = await this._getConvFromIndex(convId);
    if (!result) return null;
    return this._executionDirForConversation(result.index, result.convEntry);
  }

  async getWorkspaceWorktreeIsolationStatus(hash: string): Promise<WorktreeIsolationStatusResponse> {
    const workspaceId = this._workspaceIdForRef(hash);
    const index = await this._readWorkspaceIndex(workspaceId);
    return this._worktreeIsolation.getStatus(workspaceId, index);
  }

  async setWorkspaceWorktreeIsolation(
    hash: string,
    enabled: boolean,
    opts: { confirmedSessionReset?: boolean } = {},
  ): Promise<WorktreeIsolationStatusResponse | null> {
    if (!opts.confirmedSessionReset) {
      throw new WorktreeIsolationError(
        'confirmation_required',
        'Changing worktree mode resets CLI sessions for all conversations in this workspace',
        [{
          code: 'confirmation_required',
          message: 'Changing worktree mode resets CLI sessions for all conversations in this workspace',
        }],
        400,
      );
    }

    const workspaceId = this._workspaceIdForRef(hash);
    await this._indexLock.run(workspaceId, async () => {
      const index = await this._readWorkspaceIndex(workspaceId);
      if (!index) return null;
      if (enabled) {
        await this._enableWorktreeIsolation(workspaceId, index);
      } else {
        await this._disableWorktreeIsolation(workspaceId, index);
      }
      return true;
    });

    const index = await this._readWorkspaceIndex(workspaceId);
    if (!index) return null;
    return this._worktreeIsolation.getStatus(workspaceId, index);
  }

  private async _enableWorktreeIsolation(hash: string, index: WorkspaceIndex): Promise<void> {
    if (index.worktreeIsolation?.enabled) return;
    const settings = await this._worktreeIsolation.buildSettings(hash, index.workspacePath);
    await this._worktreeIsolation.assertBaseReady(settings);
    const now = new Date();
    const created: ConversationCheckout[] = [];
    const migrations: Array<{
      convEntry: ConversationEntry;
      checkout: ConversationCheckout;
      branchName: string;
    }> = [];
    try {
      for (const convEntry of index.conversations) {
        const activeSession = convEntry.sessions.find((session) => session.active);
        if (!activeSession) continue;
        const newSessionNumber = activeSession.number + 1;
        const branchName = this._sessionBranchName(convEntry.id, newSessionNumber);
        const checkout = await this._worktreeIsolation.createConversationWorktree(settings, convEntry.id, branchName);
        created.push(checkout);
        migrations.push({ convEntry, checkout, branchName });
      }

      index.worktreeIsolation = settings;
      for (const migration of migrations) {
        migration.convEntry.checkout = migration.checkout;
        await this._advanceConversationSession(hash, migration.convEntry, now, {
          branchName: migration.branchName,
          baseRef: settings.remoteBaseRef,
        });
      }
      await this._writeWorkspaceIndex(hash, index);
    } catch (err) {
      for (const checkout of created.reverse()) {
        try {
          await this._worktreeIsolation.removeConversationWorktree(settings, checkout, { id: 'rollback', title: 'rollback' });
        } catch {
          // Best-effort cleanup; preserve the original enablement failure.
        }
      }
      delete index.worktreeIsolation;
      throw err;
    }
  }

  private async _disableWorktreeIsolation(hash: string, index: WorkspaceIndex): Promise<void> {
    const settings = index.worktreeIsolation;
    if (!settings?.enabled) return;
    const blockers: Array<{ code: string; message: string; conversationId?: string; path?: string; files?: string[] }> = [];
    const baseDirty = await this._worktreeIsolation.changedFiles(settings.repoRoot);
    if (baseDirty.length > 0) {
      blockers.push({
        code: 'base_dirty',
        message: 'Base checkout has uncommitted changes',
        path: settings.repoRoot,
        files: baseDirty,
      });
    }

    for (const convEntry of index.conversations) {
      const checkout = normalizeCheckout(convEntry.checkout);
      if (checkout.mode === 'worktree') {
        if (!checkout.worktreeRoot || !fs.existsSync(checkout.worktreeRoot)) {
          blockers.push({
            code: 'worktree_missing',
            message: 'Conversation worktree is missing',
            conversationId: convEntry.id,
            path: checkout.worktreeRoot,
          });
          continue;
        }
        const dirtyFiles = await this._worktreeIsolation.changedFiles(checkout.worktreeRoot);
        if (dirtyFiles.length > 0) {
          blockers.push({
            code: 'worktree_dirty',
            message: 'Conversation worktree has uncommitted changes',
            conversationId: convEntry.id,
            path: checkout.worktreeRoot,
            files: dirtyFiles,
          });
        }
      }
    }
    if (blockers.length > 0) {
      throw new WorktreeIsolationError(
        blockers.some((blocker) => blocker.code === 'worktree_dirty') ? 'worktree_dirty' : blockers[0].code,
        'Cannot disable worktree mode until dirty or missing checkouts are resolved',
        blockers,
      );
    }

    const now = new Date();
    for (const convEntry of index.conversations) {
      const checkout = normalizeCheckout(convEntry.checkout);
      if (checkout.mode === 'worktree') {
        await this._worktreeIsolation.removeConversationWorktree(settings, checkout, convEntry);
      }
      delete convEntry.checkout;
      await this._advanceConversationSession(hash, convEntry, now);
    }
    delete index.worktreeIsolation;
    await this._writeWorkspaceIndex(hash, index);
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
    return this._workspaceMemoryStore.memoryDir(hash);
  }

  private _memoryFilesDir(hash: string): string {
    return this._workspaceMemoryStore.filesDir(hash);
  }

  private _memoryClaudeDir(hash: string): string {
    return this._workspaceMemoryStore.claudeDir(hash);
  }

  private _memoryNotesDir(hash: string): string {
    return this._workspaceMemoryStore.notesDir(hash);
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
    const raw = await this._workspaceMemoryStore.readMetadataIndexFile(hash);
    if (!raw) return this._emptyMemoryMetadataIndex();

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
    await this._workspaceMemoryStore.writeMetadataIndex(hash, index);
  }

  private async _attachMemoryMetadata(
    hash: string,
    files: MemoryFile[],
    persist: boolean,
  ): Promise<MemoryFile[]> {
    if (files.length === 0) {
      if (persist) {
        const existing = await this._readMemoryMetadataIndex(hash);
        const deletedEntries = Object.fromEntries(
          Object.entries(existing.entries).filter(([, entry]) => entry.status === 'deleted'),
        );
        await this._writeMemoryMetadataIndex(hash, {
          version: 1,
          updatedAt: new Date().toISOString(),
          entries: deletedEntries,
        });
      }
      return files;
    }

    const existing = await this._readMemoryMetadataIndex(hash);
    const now = new Date().toISOString();
    const entries: Record<string, MemoryEntryMetadata> = {};
    for (const entry of Object.values(existing.entries)) {
      if (entry.status === 'deleted') entries[entry.filename] = entry;
    }

    const enriched: MemoryFile[] = [];
    for (const file of files) {
      const source = normalizeMemorySource(file.source, 'cli-capture');
      const previous = existing.entries[file.filename] || file.metadata;
      const metadata = this._normalizeMemoryMetadata(previous, file.filename, source, now);
      const nextMetadata: MemoryEntryMetadata = {
        ...metadata,
        filename: file.filename,
        source,
      };
      if (nextMetadata.status === 'deleted') {
        entries[file.filename] = nextMetadata;
        continue;
      }
      entries[file.filename] = nextMetadata;
      enriched.push({
        ...file,
        source,
        metadata: nextMetadata,
      });
    }

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

    await this._workspaceMemoryStore.writeSnapshot(hash, merged);
  }

  /**
   * Load the stored memory snapshot for a workspace, or `null` if none.
   * Reconciles the on-disk snapshot with any notes that may have been
   * written since the last CLI capture, so the caller always sees a
   * fresh merged view.
   */
  async getWorkspaceMemory(hash: string): Promise<MemorySnapshot | null> {
    const snapshot = await this._workspaceMemoryStore.readSnapshot(hash);

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
    const existing = await this._readMemoryMetadataIndex(hash);
    try {
      await fsp.unlink(resolved);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }

    const now = new Date().toISOString();
    const source = normalizeMemorySource(existing.entries[relPath]?.source, memorySourceFromFilename(relPath));
    const entries = { ...existing.entries };
    if (source === 'cli-capture') {
      const deleted = this._normalizeMemoryMetadata(
        {
          ...existing.entries[relPath],
          filename: relPath,
          source,
          status: 'deleted',
          updatedAt: now,
        },
        relPath,
        source,
        now,
      );
      entries[relPath] = deleted;
    } else {
      delete entries[relPath];
    }
    await this._writeMemoryMetadataIndex(hash, {
      version: 1,
      updatedAt: now,
      entries,
    });

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

    // Bulk clear is a complete reset, so it drops deleted tombstones too.
    await this._writeMemoryMetadataIndex(hash, this._emptyMemoryMetadataIndex());

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
    return this._workspaceMemoryStore.saveConsolidationAudit(hash, audit);
  }

  /**
   * Rewrite `snapshot.json` from the current on-disk state without
   * re-running capture. Used after note writes and deletions so
   * `getWorkspaceMemory()` stays consistent.
   */
  private async _refreshSnapshotIndex(hash: string): Promise<void> {
    let snapshot = await this._workspaceMemoryStore.readSnapshot(hash);
    if (!snapshot) {
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
    await this._workspaceMemoryStore.writeSnapshot(hash, next);
  }

  /** Per-workspace Memory enable/disable (stored on the workspace index). */
  async getWorkspaceMemoryEnabled(hash: string): Promise<boolean> {
    const workspaceId = this._workspaceIdForRef(hash);
    const index = await this._readWorkspaceIndex(workspaceId);
    if (!index) return false;
    return Boolean(index.memoryEnabled);
  }

  async setWorkspaceMemoryEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    const workspaceId = this._workspaceIdForRef(hash);
    return this._indexLock.run(workspaceId, async () => {
      const index = await this._readWorkspaceIndex(workspaceId);
      if (!index) return null;
      index.memoryEnabled = Boolean(enabled);
      await this._writeWorkspaceIndex(workspaceId, index);
      return index.memoryEnabled;
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

    const workspaceIds: string[] = [];
    for (const storageKey of dirs) {
      if (storageKey.startsWith('.')) continue;
      const index = await this._readWorkspaceIndex(storageKey);
      if (index?.memoryEnabled && !index.archive) {
        workspaceIds.push(index.workspaceId || this._workspaceIdentityStore.resolveWorkspaceId(storageKey) || storageKey);
      }
    }
    return workspaceIds;
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

    const convEntry = index.conversations.find(c => c.id === convId);
    const workspacePath = convEntry
      ? this._executionDirForConversation(index, convEntry)
      : index.workspacePath;

    log.info('Extracting workspace memory', { convId, backendId, workspacePath });
    let snapshot: MemorySnapshot | null = null;
    try {
      snapshot = await adapter.extractMemory(workspacePath, { cliProfile });
    } catch (err: unknown) {
      log.error('Memory extraction failed', { backendId, workspacePath, error: err });
      return null;
    }

    if (!snapshot) {
      log.info('Memory extraction returned no snapshot', { backendId, workspacePath });
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

  getWorkspaceDiscussionHistoryPointer(convId: string): string | null {
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
    let filesDir = this._memoryFilesDir(hash);
    try {
      filesDir = await this._workspaceMemoryStore.ensureFilesDir(hash);
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
    return this._workspaceKnowledgeStore.knowledgeDir(hash);
  }

  private _kbRawDir(hash: string): string {
    return this._workspaceKnowledgeStore.rawDir(hash);
  }

  private _kbConvertedDir(hash: string): string {
    return this._workspaceKnowledgeStore.convertedDir(hash);
  }

  private _kbEntriesDir(hash: string): string {
    return this._workspaceKnowledgeStore.entriesDir(hash);
  }

  private _kbSynthesisDir(hash: string): string {
    return this._workspaceKnowledgeStore.synthesisDir(hash);
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
    return this._workspaceKnowledgeStore.getDb(hash);
  }

  /** Close every cached KB database. Call during graceful shutdown. */
  closeKbDatabases(): void {
    this._workspaceKnowledgeStore.closeDatabases();
  }

  /**
   * Get or create a PGLite vector store for a workspace. Returns `null`
   * when `hash` is falsy. The store is cached for the process lifetime
   * by `WorkspaceKnowledgeStore`.
   */
  async getKbVectorStore(hash: string, dimensions?: number): Promise<KbVectorStore | null> {
    return this._workspaceKnowledgeStore.getVectorStore(hash, dimensions);
  }

  /** Drop the derived PGLite vector store so it can be recreated from SQLite KB state. */
  async resetKbVectorStore(hash: string): Promise<void> {
    await this._workspaceKnowledgeStore.resetVectorStore(hash);
  }

  /** Close every cached vector store. Call during graceful shutdown. */
  async closeKbVectorStores(): Promise<void> {
    await this._workspaceKnowledgeStore.closeVectorStores();
  }

  /** Per-workspace embedding config (stored on the workspace index). */
  async getWorkspaceKbEmbeddingConfig(hash: string): Promise<EmbeddingConfig | undefined> {
    const index = await this._readWorkspaceIndex(this._workspaceIdForRef(hash));
    return index?.kbEmbedding ?? undefined;
  }

  async setWorkspaceKbEmbeddingConfig(
    hash: string,
    cfg: EmbeddingConfig,
  ): Promise<EmbeddingConfig | null> {
    const workspaceId = this._workspaceIdForRef(hash);
    const updated = await this._indexLock.run(workspaceId, async () => {
      const index = await this._readWorkspaceIndex(workspaceId);
      if (!index) return null;

      const oldCfg = index.kbEmbedding;
      const modelChanged = (cfg.model ?? 'nomic-embed-text') !== (oldCfg?.model ?? 'nomic-embed-text');
      const dimsChanged = (cfg.dimensions ?? 768) !== (oldCfg?.dimensions ?? 768);

      index.kbEmbedding = {
        model: cfg.model,
        ollamaHost: cfg.ollamaHost,
        dimensions: cfg.dimensions,
      };
      await this._writeWorkspaceIndex(workspaceId, index);
      return { config: index.kbEmbedding, wipe: modelChanged || dimsChanged };
    });
    if (!updated) return null;

    // When model or dimensions change, wipe existing embeddings so they
    // get regenerated on the next digest/dream cycle.
    if (updated.wipe) {
      await this._workspaceKnowledgeStore.closeVectorStore(workspaceId);
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
    return this._featureSettingsStore.getKbEnabled(this._workspaceIdForRef(hash));
  }

  async setWorkspaceKbEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    return this._featureSettingsStore.setKbEnabled(this._workspaceIdForRef(hash), enabled);
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
    return this._featureSettingsStore.getKbAutoDigest(this._workspaceIdForRef(hash));
  }

  async setWorkspaceKbAutoDigest(hash: string, autoDigest: boolean): Promise<boolean | null> {
    return this._featureSettingsStore.setKbAutoDigest(this._workspaceIdForRef(hash), autoDigest);
  }

  async getWorkspaceKbAutoDream(hash: string): Promise<KbAutoDreamConfig> {
    return this._featureSettingsStore.getKbAutoDream(this._workspaceIdForRef(hash));
  }

  async setWorkspaceKbAutoDream(hash: string, autoDream: KbAutoDreamConfig): Promise<KbAutoDreamConfig | null> {
    return this._featureSettingsStore.setKbAutoDream(this._workspaceIdForRef(hash), autoDream);
  }

  async listKbEnabledWorkspaceHashes(): Promise<string[]> {
    return this._featureSettingsStore.listKbEnabledWorkspaceHashes();
  }

  /** Per-workspace Workspace Context enable/disable (stored on the workspace index). */
  async getWorkspaceContextEnabled(hash: string): Promise<boolean> {
    return this._featureSettingsStore.getWorkspaceContextEnabled(this._workspaceIdForRef(hash));
  }

  async setWorkspaceContextEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    return this._featureSettingsStore.setWorkspaceContextEnabled(this._workspaceIdForRef(hash), enabled);
  }

  async getWorkspaceContextSettings(hash: string): Promise<WorkspaceContextWorkspaceSettings | null> {
    return this._featureSettingsStore.getWorkspaceContextSettings(this._workspaceIdForRef(hash));
  }

  async setWorkspaceContextSettings(
    hash: string,
    settings: unknown,
  ): Promise<WorkspaceContextWorkspaceSettings | null> {
    return this._featureSettingsStore.setWorkspaceContextSettings(this._workspaceIdForRef(hash), settings);
  }

  async listWorkspaceContextEnabledWorkspaceHashes(): Promise<string[]> {
    return this._featureSettingsStore.listWorkspaceContextEnabledWorkspaceHashes();
  }

  /** Per-workspace Workspace Routines enable/disable (stored on the workspace index). */
  async getWorkspaceRoutinesEnabled(hash: string): Promise<boolean> {
    return this._featureSettingsStore.getRoutinesEnabled(this._workspaceIdForRef(hash));
  }

  async setWorkspaceRoutinesEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    return this._featureSettingsStore.setRoutinesEnabled(this._workspaceIdForRef(hash), enabled);
  }

  async listRoutinesEnabledWorkspaceHashes(): Promise<string[]> {
    return this._featureSettingsStore.listRoutinesEnabledWorkspaceHashes();
  }

  async getWorkspaceContextStatus(hash: string): Promise<ConversationWorkspaceContextStatus> {
    const enabled = await this.getWorkspaceContextEnabled(hash);
    const contextDir = this.getWorkspaceContextDir(hash);
    if (!enabled) {
      return {
        enabled: false,
        pending: false,
        runningRuns: 0,
        failedRuns: 0,
        contextDir,
        fileCount: 0,
      };
    }

    const state = await this.readWorkspaceContextState(hash);
    const runs = state.runs || [];
    const latest = state.lastRun || runs[0];
    const failedRuns = runs.filter((run) => run.status === 'failed').length;
    const runningRuns = runs.filter((run) => run.status === 'running').length;
    const fileCount = await this.countWorkspaceContextFiles(hash);

    return {
      enabled: true,
      pending: failedRuns + runningRuns > 0,
      runningRuns,
      failedRuns,
      contextDir,
      fileCount,
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

  private async readWorkspaceContextState(hash: string): Promise<{ lastRun?: ConversationWorkspaceContextStatusRun; runs: ConversationWorkspaceContextStatusRun[] }> {
    try {
      const state = JSON.parse(await fsp.readFile(path.join(this.getWorkspaceContextDir(hash), 'state.json'), 'utf8'));
      return {
        lastRun: normalizeWorkspaceContextStatusRun(state.lastRun),
        runs: Array.isArray(state.runs) ? state.runs.map(normalizeWorkspaceContextStatusRun).filter(Boolean) : [],
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('Failed to read Workspace Context status state', { workspaceHash: hash, error: err });
      }
      return { runs: [] };
    }
  }

  private async countWorkspaceContextFiles(hash: string): Promise<number> {
    const root = path.join(this.getWorkspaceContextDir(hash), 'context');
    let count = 0;
    async function walk(dir: string): Promise<void> {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) count += 1;
      }
    }
    await walk(root);
    return count;
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

  async searchConversations(query: string, opts?: { archived?: boolean; includeArchivedWorkspaces?: boolean }): Promise<ConversationListItem[]> {
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
        workspaceId: this._newId(),
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
    const pricingCatalog = (await this._usagePricingStore.getCatalogs()).effective;
    const mutated = await this._conversationUsageStore.addUsage(convId, usage, pricingCatalog, backend, model);
    if (!mutated) return null;

    // Record to daily ledger (fire-and-forget, don't block the response)
    // Skip ledger for backends that don't provide token-based usage (e.g. Kiro)
    if (!options?.skipLedger) {
      const pricingContext = mutated.pricingTier ? { pricingTier: mutated.pricingTier } : undefined;
      this._usageLedgerStore.record(mutated.backendId, mutated.modelId, mutated.enrichedUsage, pricingContext).catch(err => {
        log.error('Failed to write usage ledger', { error: err });
      });
    }

    return { conversationUsage: mutated.conversationUsage, sessionUsage: mutated.sessionUsage };
  }

  async getUsage(convId: string): Promise<Usage | null> {
    return this._conversationUsageStore.getUsage(convId);
  }

  async getUsageStats(): Promise<UsageLedger> {
    try {
      await this._claudeTranscriptUsageImporter.importExternalUsage({
        configRoots: this._claudeConfigRootsForUsageImport(await this.getSettings()),
        ownedSessionIds: await this._agentCockpitSessionIds(),
      });
    } catch (err: unknown) {
      log.warn('Failed to import external Claude transcript usage', { error: err });
    }
    return this._usageLedgerStore.enrichMissingCosts();
  }

  async clearUsageStats(): Promise<void> {
    await this._usageLedgerStore.clear();
  }

  private _claudeConfigRootsForUsageImport(settings: Settings): string[] {
    const roots: string[] = [];
    for (const profile of settings.cliProfiles || []) {
      if (profile.disabled || profile.harness !== 'claude-code') continue;
      const configDir = profile.configDir?.trim() || profile.env?.CLAUDE_CONFIG_DIR?.trim();
      if (configDir) roots.push(configDir);
    }
    return [...new Set(roots)];
  }

  private async _agentCockpitSessionIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    let workspaceDirs: string[];
    try {
      workspaceDirs = await fsp.readdir(this.workspacesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ids;
      throw err;
    }

    for (const dir of workspaceDirs) {
      const indexPath = path.join(this.workspacesDir, dir, 'index.json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const conversations = (parsed as { conversations?: unknown }).conversations;
      if (!Array.isArray(conversations)) continue;
      for (const conv of conversations) {
        if (!conv || typeof conv !== 'object' || Array.isArray(conv)) continue;
        const sessions = (conv as { sessions?: unknown }).sessions;
        if (!Array.isArray(sessions)) continue;
        for (const session of sessions) {
          if (!session || typeof session !== 'object' || Array.isArray(session)) continue;
          const entry = session as { sessionId?: unknown; externalSessionId?: unknown };
          if (typeof entry.sessionId === 'string' && entry.sessionId) ids.add(entry.sessionId);
          if (typeof entry.externalSessionId === 'string' && entry.externalSessionId) ids.add(entry.externalSessionId);
        }
      }
    }
    return ids;
  }

  async getUsagePricingCatalog(): Promise<UsagePricingResponse> {
    return this._usagePricingStore.getCatalogs();
  }

  async saveUsagePricingOverrides(entries: UsagePricingEntry[]): Promise<UsagePricingResponse> {
    return this._usagePricingStore.replaceOverrides(entries);
  }

  async clearUsagePricingOverrides(): Promise<UsagePricingResponse> {
    return this._usagePricingStore.clearOverrides();
  }

  private _estimateUsageCost(backendId: string, model: string, usage: Usage, pricingTier?: string): Usage {
    const catalog = this._usagePricingStore.getEffectiveCatalogSync();
    return applyCostEstimate(backendId, model, usage, undefined, catalog.entries, catalog.version, pricingTier);
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
