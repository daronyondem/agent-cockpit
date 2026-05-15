// ─── Knowledge Base digestion orchestrator ──────────────────────────────────
// Owns the "ingested → digested" stage of the KB pipeline.
//
// For each raw file that made it through conversion, the digestion
// orchestrator:
//   1. Reads the converted `text.md` + metadata
//   2. Builds a prompt describing the file + its folder context
//   3. Shells out to the configured Digestion CLI via `runOneShot(...,
//      { allowTools: true })` so the CLI can read any sibling file in
//      the knowledge/ directory
//   4. Parses the CLI output into one or more structured entries
//      (YAML frontmatter + Markdown body per entry, separated by `---`)
//   5. Writes each entry to `entries/<entryId>/entry.md`
//   6. Inserts entry rows into the workspace DB
//   7. Flips the raw row's status to `digested` (or `failed` + error
//      class/message on any error)
//
// Errors are categorized so the UI can show the user actionable info:
// timeouts differ from CLI exits from malformed output from schema
// rejections. The raw row keeps `errorClass` + `errorMessage` until the
// next successful retry, at which point they're cleared.
//
// Concurrency: like ingestion, all per-workspace work is serialized via
// a FIFO promise chain — one raw at a time per workspace. Every enqueue
// (single, batch, or auto-digest) bumps a shared per-workspace
// `digest_session` counter and emits a `digestProgress` frame after
// each one settles, so the toolbar shows unified `done / total — ~ETA`
// across all three entry points. The session is persisted to the KB DB
// so a browser reload mid-digest rehydrates the progress indicator.
//
// Cross-file dedup is NOT handled here — that lives in Phase 4
// (Dreaming). Each digest run is self-contained for a single raw file.

import path from 'path';
import crypto from 'crypto';
import { promises as fsp } from 'fs';
import type {
  KbDigestChunkPhase,
  KbDigestChunkProgress,
  KbDigestProgress,
  KbErrorClass,
  KbStateUpdateEvent,
  Settings,
} from '../../types';
import type { BaseBackendAdapter, RunOneShotOptions } from '../backends/base';
import type { BackendRegistry } from '../backends/registry';
import type { CliProfileRuntime } from '../cliProfiles';
import type { InsertEntrySourceParams, KbDatabase, ReplaceEntryParams } from './db';
import type { KbVectorStore } from './vectorStore';
import { embedBatch, resolveConfig, type EmbeddingConfig } from './embeddings';
import type { WorkspaceTaskQueueRegistry } from './workspaceTaskQueue';
import { planDigestChunks, type KbDigestChunk } from './chunkPlanner';
import { estimateSourceUnitTextLengths, extractSourceRange } from './sourceRange';

/** Version bumped whenever the entry frontmatter/format contract changes. */
export const KB_ENTRY_SCHEMA_VERSION = 1;

/**
 * Build a `KbDigestProgress` snapshot from raw counters. Shared between
 * the live in-memory path (frame emissions from the orchestrator) and
 * the persisted path (`GET /kb` rehydrating after a browser reload) so
 * the ETA rules stay consistent.
 *
 * ETA is withheld until `done >= 2` — the first-task duration is a
 * noisy sample (CLI warm-up, filesystem cache) and would otherwise
 * produce wild ETA swings the moment the second sample lands.
 */
export function computeDigestProgress(counters: {
  total: number;
  done: number;
  totalElapsedMs: number;
  chunkProgress?: KbDigestChunkProgress | null;
}): KbDigestProgress {
  const avgMsPerItem = counters.done > 0
    ? Math.round(counters.totalElapsedMs / counters.done)
    : 0;
  const snapshot: KbDigestProgress = {
    done: counters.done,
    total: counters.total,
    avgMsPerItem,
  };
  if (counters.done >= 2 && avgMsPerItem > 0) {
    const remaining = Math.max(0, counters.total - counters.done);
    snapshot.etaMs = remaining * avgMsPerItem;
  }
  const chunkProgress = normalizeDigestChunkProgress(counters.chunkProgress);
  if (chunkProgress) snapshot.chunks = chunkProgress;
  return snapshot;
}

function normalizeDigestChunkProgress(
  chunkProgress: KbDigestChunkProgress | null | undefined,
): KbDigestChunkProgress | null {
  if (!chunkProgress) return null;
  const done = Math.max(0, Math.floor(Number(chunkProgress.done) || 0));
  const total = Math.max(0, Math.floor(Number(chunkProgress.total) || 0));
  const active = Math.max(0, Math.floor(Number(chunkProgress.active) || 0));
  if (done === 0 && total === 0 && active === 0 && !chunkProgress.current) return null;
  const phase = isDigestChunkPhase(chunkProgress.phase) ? chunkProgress.phase : 'planning';
  const normalized: KbDigestChunkProgress = {
    done: total > 0 ? Math.min(done, total) : done,
    total,
    active,
    phase,
  };
  if (chunkProgress.current) normalized.current = chunkProgress.current;
  return normalized;
}

function isDigestChunkPhase(value: unknown): value is KbDigestChunkPhase {
  return value === 'planning' ||
    value === 'digesting' ||
    value === 'parsing' ||
    value === 'committing';
}

/** Subset of chatService the digestion orchestrator depends on. */
export interface KbDigestChatService {
  getWorkspaceKbEnabled(hash: string): Promise<boolean>;
  getWorkspaceKbAutoDigest(hash: string): Promise<boolean>;
  getKbDb(hash: string): KbDatabase | null;
  getSettings(): Promise<Settings>;
  resolveCliProfileRuntime?(
    cliProfileId: string | undefined | null,
    fallbackBackend?: string | null,
  ): Promise<CliProfileRuntime>;
  getKbConvertedDir(hash: string): string;
  getKbEntriesDir(hash: string): string;
  getKbRawDir(hash: string): string;
  /** Absolute path of the workspace's `knowledge/` directory. */
  getKbKnowledgeDir(hash: string): string;
  /** Per-workspace embedding configuration (Ollama model/host/dimensions). */
  getWorkspaceKbEmbeddingConfig(hash: string): Promise<EmbeddingConfig | undefined>;
  /** Get or create the PGLite vector store for a workspace. */
  getKbVectorStore(hash: string, dimensions?: number): Promise<KbVectorStore | null>;
}

/** Emitter for kb_state_update frames — same shape as the ingestion emitter. */
export type KbDigestEmitter = (hash: string, frame: KbStateUpdateEvent) => void;

export interface KbDigestionOptions {
  chatService: KbDigestChatService;
  backendRegistry: BackendRegistry;
  emit?: KbDigestEmitter;
  /**
   * Per-workspace task queue registry. Shared with `KbIngestionService`
   * so `cliConcurrency` is a unified budget across both pipelines.
   */
  queueRegistry: WorkspaceTaskQueueRegistry;
}

/** Outcome of one digest run over a single raw file. */
export interface DigestResult {
  rawId: string;
  /** Entry IDs that were successfully written. Empty on failure. */
  entryIds: string[];
  /** True when the raw was purged (pending-delete → batch runner cleaned up). */
  purged: boolean;
  /** Set on failure. */
  error?: { class: KbErrorClass; message: string };
}

/**
 * Parsed entry shape. Free-form by design — the writer stringifies
 * this back out into `entry.md` using a deterministic frontmatter
 * ordering so diffs stay minimal across re-digestions.
 */
export interface ParsedEntry {
  title: string;
  slug: string;
  summary: string;
  tags: string[];
  body: string;
}

type EntrySourceDraft = Omit<InsertEntrySourceParams, 'entryId'>;

interface EntryReplacementManifest {
  version: 1;
  rawId: string;
  stagingName: string;
  staleIds: string[];
  replacementIds: string[];
  replacementDigestedAt: string;
}

interface ParsedEntryWithSources {
  entry: ParsedEntry;
  sources: EntrySourceDraft[];
}

/** Thrown when parsing CLI output fails. Caught and classified internally. */
export class DigestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DigestParseError';
  }
}

/** Thrown when a parsed entry fails schema validation. */
export class DigestSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DigestSchemaError';
  }
}

/** Thrown when the workspace is not found or KB is disabled. */
export class KbDigestDisabledError extends Error {
  constructor(hash: string) {
    super(`Knowledge Base is not enabled for workspace ${hash}.`);
    this.name = 'KbDigestDisabledError';
  }
}

export class KbDigestionService {
  private readonly chatService: KbDigestChatService;
  private readonly backendRegistry: BackendRegistry;
  private readonly emit?: KbDigestEmitter;
  /**
   * Per-workspace bounded-parallelism queue. Shared with the ingestion
   * service so `cliConcurrency` is a unified budget across pipelines.
   */
  private readonly queueRegistry: WorkspaceTaskQueueRegistry;
  /**
   * Per-workspace digestion session. Present while at least one digest
   * task is pending or in flight; cleared when the last task settles.
   *
   * Counters:
   * - `entriesCreated` — running total of entries written this session.
   * - `pending` — in-flight + queued tasks, used to detect queue drain.
   * - `total` — cumulative tasks enqueued this session (bumps mid-session
   *   when auto-digest or manual enqueues arrive while the queue is busy).
   * - `done` — cumulative tasks completed. Drives the `done / total`
   *   numerator the UI renders.
   * - `totalElapsedMs` — sum of per-file digestion durations; avg is
   *   `totalElapsedMs / done` once `done > 0`.
   * - `startedAt` — ISO timestamp the session opened. Useful for
   *   diagnostics; not currently surfaced to the UI.
   *
   * Mirrored to the KB DB's `digest_session` row on every counter bump
   * so a mid-flight browser reload can rehydrate the toolbar progress.
   */
  private readonly sessions = new Map<
    string,
    {
      entriesCreated: number;
      pending: number;
      total: number;
      done: number;
      totalElapsedMs: number;
      startedAt: string;
      chunkProgress: KbDigestChunkProgress | null;
      activeChunkKeys: Set<string>;
    }
  >();
  private readonly recoveryByWorkspace = new Map<string, Promise<void>>();

  constructor(opts: KbDigestionOptions) {
    this.chatService = opts.chatService;
    this.backendRegistry = opts.backendRegistry;
    this.emit = opts.emit;
    this.queueRegistry = opts.queueRegistry;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Queue a single raw file for digestion. The caller awaits the returned
   * promise to know when the CLI has finished and the DB/filesystem
   * reflect the new entries. Rejects with `KbDigestDisabledError` when
   * the workspace has KB disabled.
   *
   * Other failures — CLI errors, parse errors, schema violations —
   * resolve with a `DigestResult` whose `error` field is populated, so
   * the caller can fan out to multiple raw IDs without having to wrap
   * each call in try/catch. The raw row's status + error_class land in
   * the DB via the per-run handler, not via an exception here.
   */
  async enqueueDigest(hash: string, rawId: string): Promise<DigestResult> {
    const enabled = await this.chatService.getWorkspaceKbEnabled(hash);
    if (!enabled) throw new KbDigestDisabledError(hash);
    const db = this.chatService.getKbDb(hash);
    if (!db) throw new KbDigestDisabledError(hash);
    await this._recoverWorkspaceEntryReplacements(hash, db);
    await this._refreshConcurrency(hash);
    this._trackPending(hash, 1);
    try {
      const startedAt = Date.now();
      const result = await this._enqueue(hash, async () => this._runDigest(hash, rawId));
      this._recordTaskDone(hash, Date.now() - startedAt);
      this._recordEntriesCreated(hash, result.entryIds.length);
      return result;
    } finally {
      this._trackPending(hash, -1);
    }
  }

  /**
   * Queue every eligible raw file in the workspace for digestion. Runs
   * in the order the DB returns them, emitting a `digestProgress` frame
   * after each one settles so the UI's toolbar can show live
   * `done / total — ~ETA` progress.
   *
   * Eligible = `status ∈ {ingested, pending-delete}`. Pending-delete
   * raws are purged (not digested) — the user already deleted the last
   * location, so there's nothing to digest.
   */
  async enqueueBatchDigest(hash: string): Promise<DigestResult[]> {
    const enabled = await this.chatService.getWorkspaceKbEnabled(hash);
    if (!enabled) throw new KbDigestDisabledError(hash);
    const db = this.chatService.getKbDb(hash);
    if (!db) throw new KbDigestDisabledError(hash);
    await this._recoverWorkspaceEntryReplacements(hash, db);

    const ingested = db.listIngestedRawIds();
    const pending = db.listPendingDeleteRaw().map((r) => r.raw_id);
    const all = [...pending, ...ingested];
    if (all.length === 0) return [];

    await this._refreshConcurrency(hash);
    this._trackPending(hash, all.length);
    // Dispatch every raw onto the shared bounded-parallelism queue and
    // collect results as they settle. The queue runs up to
    // `cliConcurrency` digests in parallel, which is the unified budget
    // shared with ingestion for this workspace.
    const dispatched = all.map((rawId) => {
      const startedAt = Date.now();
      return this._enqueue(hash, async () => this._runDigest(hash, rawId)).then(
        (r) => {
          this._recordTaskDone(hash, Date.now() - startedAt);
          this._recordEntriesCreated(hash, r.entryIds.length);
          this._emitChange(hash, new Date().toISOString(), {
            raw: [rawId],
            entries: r.entryIds,
          });
          this._trackPending(hash, -1);
          return r;
        },
        (err: unknown) => {
          // _runDigest never throws — this fires only if the queue
          // promise rejects. Balance pending so the session closes.
          this._trackPending(hash, -1);
          throw err;
        },
      );
    });
    return Promise.all(dispatched);
  }

  /** Test hook — wait until every queued digest settles. */
  async waitForIdle(hash: string): Promise<void> {
    await this.queueRegistry.waitForIdle(hash);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Adjust the per-workspace pending task count. Opens a fresh session
   * on the first positive delta into an idle queue; bumps the `total`
   * counter by that delta so mid-session enqueues (e.g. auto-digest
   * arrivals during an active batch) extend the progress bar. When the
   * count drops to zero, emits a final `digestion: { active: false, … }`
   * frame, a `digestProgress: null` signal, and clears both in-memory
   * and persisted session state.
   */
  private _trackPending(hash: string, delta: number): void {
    let session = this.sessions.get(hash);
    if (!session) {
      if (delta <= 0) return; // no-op: closing an already-closed session
      session = {
        entriesCreated: 0,
        pending: 0,
        total: 0,
        done: 0,
        totalElapsedMs: 0,
        startedAt: new Date().toISOString(),
        chunkProgress: null,
        activeChunkKeys: new Set<string>(),
      };
      this.sessions.set(hash, session);
    }
    session.pending += delta;
    if (delta > 0) {
      session.total += delta;
      this._persistSession(hash, session);
      this._emitProgress(hash, session);
    }
    if (session.pending <= 0) {
      const total = session.entriesCreated;
      this.sessions.delete(hash);
      this._clearPersistedSession(hash);
      this._emitChange(hash, new Date().toISOString(), {
        digestion: { active: false, entriesCreated: total },
        digestProgress: null,
      });
    }
  }

  /**
   * Record a settled digest task's wall-clock duration. Bumps `done` and
   * accumulates `totalElapsedMs` so the progress frame carries a stable
   * rolling `avgMsPerItem` (and, once `done >= 2`, an `etaMs`).
   */
  private _recordTaskDone(hash: string, elapsedMs: number): void {
    const session = this.sessions.get(hash);
    if (!session) return;
    session.done += 1;
    session.totalElapsedMs += Math.max(0, elapsedMs);
    this._persistSession(hash, session);
    this._emitProgress(hash, session);
  }

  /**
   * Bump the active session's entry counter and emit a progress frame
   * so the UI can render a live count-up during digestion.
   */
  private _recordEntriesCreated(hash: string, count: number): void {
    if (count <= 0) return;
    const session = this.sessions.get(hash);
    if (!session) return;
    session.entriesCreated += count;
    this._emitChange(hash, new Date().toISOString(), {
      digestion: { active: true, entriesCreated: session.entriesCreated },
    });
  }

  private _recordChunkPlanning(hash: string, rawId: string): void {
    const session = this.sessions.get(hash);
    if (!session) return;
    session.chunkProgress = {
      done: session.chunkProgress?.done ?? 0,
      total: session.chunkProgress?.total ?? 0,
      active: session.activeChunkKeys.size,
      phase: 'planning',
      current: { rawId },
    };
    this._persistSession(hash, session);
    this._emitProgress(hash, session);
  }

  private _recordChunksPlanned(
    hash: string,
    rawId: string,
    chunks: KbDigestChunk[],
    unitType: string,
  ): void {
    const session = this.sessions.get(hash);
    if (!session) return;
    const prior = session.chunkProgress;
    session.chunkProgress = {
      done: prior?.done ?? 0,
      total: (prior?.total ?? 0) + chunks.length,
      active: session.activeChunkKeys.size,
      phase: 'planning',
      current: { rawId, total: chunks.length, unitType },
    };
    this._persistSession(hash, session);
    this._emitProgress(hash, session);
  }

  private _recordChunkStarted(
    hash: string,
    rawId: string,
    chunk: KbDigestChunk,
    index: number,
    total: number,
    unitType: string,
  ): void {
    const session = this.sessions.get(hash);
    if (!session) return;
    session.activeChunkKeys.add(chunkProgressKey(rawId, chunk.chunkId));
    this._setChunkProgress(hash, session, 'digesting', rawId, chunk, index, total, unitType);
  }

  private _recordChunkPhase(
    hash: string,
    rawId: string,
    chunk: KbDigestChunk,
    index: number,
    total: number,
    unitType: string,
    phase: KbDigestChunkPhase,
  ): void {
    const session = this.sessions.get(hash);
    if (!session) return;
    this._setChunkProgress(hash, session, phase, rawId, chunk, index, total, unitType);
  }

  private _recordChunkDone(
    hash: string,
    rawId: string,
    chunk: KbDigestChunk,
    index: number,
    total: number,
    unitType: string,
  ): void {
    const session = this.sessions.get(hash);
    if (!session) return;
    session.activeChunkKeys.delete(chunkProgressKey(rawId, chunk.chunkId));
    const prior = session.chunkProgress;
    const chunkTotal = Math.max(prior?.total ?? total, total);
    session.chunkProgress = {
      done: Math.min((prior?.done ?? 0) + 1, chunkTotal),
      total: chunkTotal,
      active: session.activeChunkKeys.size,
      phase: 'digesting',
      current: makeCurrentChunk(rawId, chunk, index, total, unitType),
    };
    this._persistSession(hash, session);
    this._emitProgress(hash, session);
  }

  private _recordChunkStopped(hash: string, rawId: string, chunk: KbDigestChunk): void {
    const session = this.sessions.get(hash);
    if (!session) return;
    session.activeChunkKeys.delete(chunkProgressKey(rawId, chunk.chunkId));
    if (session.chunkProgress) session.chunkProgress.active = session.activeChunkKeys.size;
    this._persistSession(hash, session);
    this._emitProgress(hash, session);
  }

  private _recordChunkCommitting(hash: string, rawId: string): void {
    const session = this.sessions.get(hash);
    if (!session) return;
    const prior = session.chunkProgress;
    session.chunkProgress = {
      done: prior?.done ?? 0,
      total: prior?.total ?? 0,
      active: session.activeChunkKeys.size,
      phase: 'committing',
      current: { rawId },
    };
    this._persistSession(hash, session);
    this._emitProgress(hash, session);
  }

  private _setChunkProgress(
    hash: string,
    session: {
      chunkProgress: KbDigestChunkProgress | null;
      activeChunkKeys: Set<string>;
      total: number;
      done: number;
      totalElapsedMs: number;
      startedAt: string;
    },
    phase: KbDigestChunkPhase,
    rawId: string,
    chunk: KbDigestChunk,
    index: number,
    total: number,
    unitType: string,
  ): void {
    const prior = session.chunkProgress;
    session.chunkProgress = {
      done: prior?.done ?? 0,
      total: Math.max(prior?.total ?? total, total),
      active: session.activeChunkKeys.size,
      phase,
      current: makeCurrentChunk(rawId, chunk, index, total, unitType),
    };
    this._persistSession(hash, session);
    this._emitProgress(hash, session);
  }

  /** Write the current session state to the KB DB (best-effort; swallows DB errors). */
  private _persistSession(
    hash: string,
    session: {
      total: number;
      done: number;
      totalElapsedMs: number;
      startedAt: string;
      chunkProgress?: KbDigestChunkProgress | null;
    },
  ): void {
    try {
      const db = this.chatService.getKbDb(hash);
      db?.upsertDigestSession({
        total: session.total,
        done: session.done,
        totalElapsedMs: session.totalElapsedMs,
        startedAt: session.startedAt,
        chunkProgress: session.chunkProgress ?? null,
      });
    } catch (err: unknown) {
      console.warn(
        `[kb:digest] failed to persist session for ${hash}:`,
        (err as Error).message,
      );
    }
  }

  /** Remove the persisted session row when the queue drains. */
  private _clearPersistedSession(hash: string): void {
    try {
      const db = this.chatService.getKbDb(hash);
      db?.clearDigestSession();
    } catch (err: unknown) {
      console.warn(
        `[kb:digest] failed to clear session for ${hash}:`,
        (err as Error).message,
      );
    }
  }

  /** Emit a `digestProgress` frame for the current session. */
  private _emitProgress(
    hash: string,
    session: {
      total: number;
      done: number;
      totalElapsedMs: number;
      chunkProgress?: KbDigestChunkProgress | null;
    },
  ): void {
    this._emitChange(hash, new Date().toISOString(), {
      digestProgress: computeDigestProgress(session),
    });
  }

  /**
   * Read the current session progress snapshot for a workspace. Returns
   * `null` when the queue is idle. Used by `chatService.getKbStateSnapshot`
   * so `GET /kb` can rehydrate the toolbar after a browser reload.
   */
  getSessionProgress(hash: string): KbDigestProgress | null {
    const session = this.sessions.get(hash);
    if (!session) return null;
    return computeDigestProgress(session);
  }

  /**
   * Read the current `cliConcurrency` setting and push it to the queue
   * registry so the workspace's queue picks up budget changes on the
   * next dispatch.
   */
  private async _refreshConcurrency(hash: string): Promise<void> {
    try {
      const settings = await this.chatService.getSettings();
      const n = settings.knowledgeBase?.cliConcurrency ?? 2;
      this.queueRegistry.setConcurrency(hash, n);
    } catch {
      // Settings unavailable — keep the registry's last-known value.
    }
  }

  private _enqueue<T>(hash: string, task: () => Promise<T>): Promise<T> {
    return this.queueRegistry.get(hash).run(task);
  }

  /**
   * Run the full digestion pipeline for one raw file. Never throws —
   * all errors are caught and landed on the raw row as `status='failed'`
   * with an appropriate error class.
   */
  private async _runDigest(hash: string, rawId: string): Promise<DigestResult> {
    const db = this.chatService.getKbDb(hash);
    if (!db) {
      return {
        rawId,
        entryIds: [],
        purged: false,
        error: { class: 'unknown', message: 'KB database unavailable' },
      };
    }
    const raw = db.getRawById(rawId);
    if (!raw) {
      return {
        rawId,
        entryIds: [],
        purged: false,
        error: { class: 'unknown', message: `No raw row for ${rawId}` },
      };
    }
    if (
      raw.status !== 'ingested' &&
      raw.status !== 'pending-delete' &&
      raw.status !== 'failed' &&
      raw.status !== 'digested'
    ) {
      // Nothing to do; don't mutate state.
      return { rawId, entryIds: [], purged: false };
    }
    const wasPendingDelete = raw.status === 'pending-delete';

    // Flip to 'digesting' and emit so the UI can spin the row.
    db.updateRawStatus(rawId, 'digesting');
    this._emitChange(hash, new Date().toISOString(), { raw: [rawId] });

    // Pending-delete raws: the user deleted the last location, so there's
    // nothing to digest. Purge the raw + bytes + converted dir + any
    // leftover entries and return immediately.
    if (wasPendingDelete) {
      try {
        const removedIds = await this._purgeRaw(hash, rawId, db);
        const now = new Date().toISOString();
        const changed: KbStateUpdateEvent['changed'] = { raw: [rawId] };
        if (removedIds.length > 0) changed.entries = removedIds;
        this._emitChange(hash, now, changed);
        return { rawId, entryIds: [], purged: true };
      } catch (err: unknown) {
        return this._failRaw(hash, rawId, db, 'unknown',
          `Purge failed: ${(err as Error).message || String(err)}`);
      }
    }

    // Wrap the full digestion pipeline in a try/catch so unexpected errors
    // land as 'failed' on the raw row instead of leaving it stuck in
    // 'digesting' forever.
    try {
      const result = await this._runDigestPipeline(hash, rawId, db, raw);
      return result;
    } catch (err: unknown) {
      console.error(`[kb:digest] unexpected error for ${rawId}:`, (err as Error).message || err);
      return this._failRaw(hash, rawId, db, 'unknown',
        `Unexpected error: ${(err as Error).message || String(err)}`);
    }
  }

  /**
   * The actual digest pipeline — read converted text, call CLI, parse
   * entries, write to DB + disk. Separated from `_runDigest` so the
   * top-level try/catch can cover everything cleanly.
   */
  private async _runDigestPipeline(
    hash: string,
    rawId: string,
    db: KbDatabase,
    raw: ReturnType<KbDatabase['getRawById']> & object,
  ): Promise<DigestResult> {
    const convertedDir = path.join(this.chatService.getKbConvertedDir(hash), rawId);
    const textPath = path.join(convertedDir, 'text.md');
    const metaPath = path.join(convertedDir, 'meta.json');

    // Read the converted text + metadata. If either is missing, surface
    // a clear error — the user will normally fix this by re-uploading.
    let convertedText = '';
    let convertedMeta: Record<string, unknown> = {};
    try {
      convertedText = await fsp.readFile(textPath, 'utf8');
    } catch (err: unknown) {
      return this._failRaw(hash, rawId, db, 'malformed_output',
        `Converted text.md is missing or unreadable: ${(err as Error).message}`);
    }
    try {
      const metaRaw = await fsp.readFile(metaPath, 'utf8');
      convertedMeta = JSON.parse(metaRaw) as Record<string, unknown>;
    } catch {
      // meta.json is best-effort — continue without it.
    }

    // Locations → folder + filename for the prompt context.
    const locations = db.listLocations(rawId);
    const firstLoc = locations[0] ?? { folderPath: '', filename: 'unknown' };

    const settings = await this.chatService.getSettings();
    const configuredCliProfileId = settings.knowledgeBase?.digestionCliProfileId;
    const configuredCliBackend = settings.knowledgeBase?.digestionCliBackend;
    const cliProfileId = configuredCliProfileId || (!configuredCliBackend ? settings.defaultCliProfileId : undefined);
    const cliBackend = configuredCliBackend || (!cliProfileId ? settings.defaultBackend : undefined);
    const cliModel = settings.knowledgeBase?.digestionCliModel;
    const cliEffort = settings.knowledgeBase?.digestionCliEffort;
    const gleaningEnabled = Boolean(settings.knowledgeBase?.kbGleaningEnabled);

    if (!cliProfileId && !cliBackend) {
      return this._failRaw(hash, rawId, db, 'unknown',
        'No Digestion CLI profile is configured. Set a Default CLI profile in Global Settings or choose one under Settings → Knowledge Base.');
    }
    let runtime: CliProfileRuntime;
    try {
      runtime = this.chatService.resolveCliProfileRuntime
        ? await this.chatService.resolveCliProfileRuntime(cliProfileId, cliBackend || undefined)
        : { backendId: cliBackend || '' };
    } catch (err: unknown) {
      return this._failRaw(hash, rawId, db, 'unknown', (err as Error).message);
    }
    const adapter: BaseBackendAdapter | null = this.backendRegistry.get(runtime.backendId);
    if (!adapter) {
      return this._failRaw(hash, rawId, db, 'unknown',
        `Configured Digestion CLI profile "${runtime.cliProfileId || runtime.backendId}" uses unregistered backend "${runtime.backendId}".`);
    }

    const handlerMeta = convertedMeta.metadata as Record<string, unknown> | undefined;
    const handlerUnitCount =
      typeof handlerMeta?.pageCount === 'number' ? handlerMeta.pageCount :
      typeof handlerMeta?.slideCount === 'number' ? handlerMeta.slideCount :
      0;

    this._recordChunkPlanning(hash, rawId);
    const document = db.getDocument(rawId);
    const documentNodes = document ? db.listDocumentNodes(rawId) : [];
    const documentUnitCount = document
      ? Math.max(
        document.unitCount,
        documentNodes.reduce((max, node) => Math.max(max, node.endUnit), 0),
      )
      : 0;
    const unitTextLengths = document
      ? estimateSourceUnitTextLengths(convertedText, document.unitType, documentUnitCount)
      : undefined;
    const chunks = document
      ? planDigestChunks(document, documentNodes, { unitTextLengths })
      : [makeWholeDocumentChunk(rawId, handlerUnitCount)];
    const chunkUnitType = document?.unitType ?? 'unknown';
    this._recordChunksPlanned(hash, rawId, chunks, chunkUnitType);
    const convertedTextRelPath = path.relative(
      this.chatService.getKbKnowledgeDir(hash),
      textPath,
    );

    const parsedWithSources: ParsedEntryWithSources[] = [];
    const rawOutputs: string[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const chunkText = document
        ? extractSourceRange(convertedText, document.unitType, chunk.startUnit, chunk.endUnit)
        : convertedText;
      if (!chunkText) {
        return this._failRaw(hash, rawId, db, 'malformed_output',
          `Could not extract chunk ${chunk.chunkId} range ${chunk.startUnit}-${chunk.endUnit}.`);
      }
      const chunkNodes = documentNodes.filter((n) => chunk.nodeIds.includes(n.nodeId));
      const prompt = buildDigestPrompt({
        filename: firstLoc.filename,
        folderPath: firstLoc.folderPath,
        rawId,
        handler: raw.handler ?? 'unknown',
        mimeType: raw.mime_type ?? 'application/octet-stream',
        convertedTextPath: convertedTextRelPath,
        convertedText: chunkText,
        handlerMetadata: handlerMeta,
        chunk: {
          chunkId: chunk.chunkId,
          index: i + 1,
          total: chunks.length,
          unitType: chunkUnitType,
          startUnit: chunk.startUnit,
          endUnit: chunk.endUnit,
          nodeTitles: chunkNodes.map((n) => n.title),
        },
      });

      this._recordChunkStarted(hash, rawId, chunk, i + 1, chunks.length, chunkUnitType);
      this._emitChange(hash, new Date().toISOString(), {
        raw: [rawId],
        substep: {
          rawId,
          text: chunks.length === 1
            ? 'Running CLI analysis\u2026'
            : `Running CLI analysis for chunk ${i + 1}/${chunks.length} (${chunk.startUnit}-${chunk.endUnit})\u2026`,
        },
      });

      const chunkUnitCount = document ? chunk.endUnit - chunk.startUnit + 1 : handlerUnitCount;
      const digestTimeoutMs = Math.max(30 * 60_000, chunkUnitCount * 10 * 60_000);
      const runOptions: RunOneShotOptions = {
        model: cliModel,
        effort: cliEffort,
        timeoutMs: digestTimeoutMs,
        workingDir: this.chatService.getKbKnowledgeDir(hash),
        allowTools: true,
        cliProfile: runtime.profile,
      };

      let rawOutput = '';
      let gleanOutput = '';
      try {
        if (gleaningEnabled) {
          const outputs = await adapter.runSessionShot(
            [prompt, buildGleaningPrompt()],
            runOptions,
          );
          rawOutput = outputs[0] ?? '';
          gleanOutput = outputs[1] ?? '';
        } else {
          rawOutput = await adapter.runOneShot(prompt, runOptions);
        }
      } catch (err: unknown) {
        this._recordChunkStopped(hash, rawId, chunk);
        const message = (err as Error).message || String(err);
        const klass = classifyCliError(message);
        return this._failRaw(hash, rawId, db, klass, `Chunk ${chunk.chunkId} failed: ${message}`);
      }
      rawOutputs.push(`## ${chunk.chunkId}\n\n${rawOutput}`);

      this._recordChunkPhase(hash, rawId, chunk, i + 1, chunks.length, chunkUnitType, 'parsing');
      this._emitChange(hash, new Date().toISOString(), {
        raw: [rawId],
        substep: {
          rawId,
          text: chunks.length === 1 ? 'Parsing entries\u2026' : `Parsing chunk ${i + 1}/${chunks.length}\u2026`,
        },
      });

      let chunkParsed: ParsedEntry[];
      try {
        chunkParsed = parseEntries(rawOutput);
      } catch (err: unknown) {
        this._recordChunkStopped(hash, rawId, chunk);
        const debugPath = await this._dumpDebugOutput(hash, rawId, rawOutput, chunk.chunkId);
        const suffix = debugPath ? ` (debug dump: ${debugPath})` : '';
        return this._failRaw(hash, rawId, db, 'malformed_output',
          `Chunk ${chunk.chunkId}: ${(err as Error).message}${suffix}`);
      }
      if (chunkParsed.length === 0) {
        this._recordChunkStopped(hash, rawId, chunk);
        const debugPath = await this._dumpDebugOutput(hash, rawId, rawOutput, chunk.chunkId);
        const suffix = debugPath ? ` (debug dump: ${debugPath})` : '';
        return this._failRaw(hash, rawId, db, 'malformed_output',
          `Chunk ${chunk.chunkId} returned no entries. Expected at least one frontmatter block.${suffix}`);
      }
      const chunkSource = makeEntrySourceForChunk(rawId, chunk);
      parsedWithSources.push(
        ...chunkParsed.map((entry) => ({ entry, sources: [chunkSource] })),
      );
      if (gleanOutput.trim()) {
        try {
          parsedWithSources.push(
            ...parseEntries(gleanOutput).map((entry) => ({ entry, sources: [chunkSource] })),
          );
        } catch (err: unknown) {
          this._recordChunkStopped(hash, rawId, chunk);
          const debugPath = await this._dumpDebugOutput(hash, rawId, gleanOutput, `${chunk.chunkId}-glean`);
          const suffix = debugPath ? ` (debug dump: ${debugPath})` : '';
          return this._failRaw(hash, rawId, db, 'malformed_output',
            `Gleaning for ${chunk.chunkId}: ${(err as Error).message}${suffix}`);
        }
      }
      this._recordChunkDone(hash, rawId, chunk, i + 1, chunks.length, chunkUnitType);
    }
    const parsed = mergeDuplicateParsedEntries(parsedWithSources);
    this._recordChunkCommitting(hash, rawId);

    const entriesRoot = this.chatService.getKbEntriesDir(hash);
    const writtenEntryIds: string[] = [];
    const now = new Date().toISOString();
    const staleIds = db.listEntryIdsByRawId(rawId);
    const staleIdSet = new Set(staleIds);
    const reservedEntryIds = new Set<string>();
    const replacementRunName = `${rawId}-${crypto.randomUUID()}`;
    const stagingRoot = path.join(entriesRoot, '.staging', replacementRunName);
    const backupRoot = path.join(entriesRoot, '.backup', replacementRunName);
    const stagedEntries: Array<{
      entryId: string;
      stagedDir: string;
      finalDir: string;
      replacement: ReplaceEntryParams;
    }> = [];
    const installedDirs: string[] = [];
    const backedUpPaths: Array<{ from: string; to: string }> = [];
    try {
      await fsp.mkdir(stagingRoot, { recursive: true });
      for (const item of parsed) {
        const entry = item.entry;
        const entryId = this._allocateEntryId(db, rawId, entry.slug, {
          reservedIds: reservedEntryIds,
          reusableIds: staleIdSet,
        });
        const stagedDir = path.join(stagingRoot, entryId);
        await fsp.mkdir(stagedDir, { recursive: true });
        await fsp.writeFile(
          path.join(stagedDir, 'entry.md'),
          stringifyEntry(entry, { uploadedAt: raw.uploaded_at, digestedAt: now }),
          'utf8',
        );
        stagedEntries.push({
          entryId,
          stagedDir,
          finalDir: path.join(entriesRoot, entryId),
          replacement: {
            entryId,
            rawId,
            title: entry.title,
            slug: entry.slug,
            summary: entry.summary,
            schemaVersion: KB_ENTRY_SCHEMA_VERSION,
            digestedAt: now,
            tags: entry.tags,
            sources: item.sources,
          },
        });
      }

      // Move old entry files out of the way only after every replacement has
      // been staged. The manifest lets the next process recover this window
      // if a crash lands between filesystem installation and the DB commit.
      await fsp.mkdir(backupRoot, { recursive: true });
      await fsp.writeFile(
        path.join(backupRoot, 'manifest.json'),
        JSON.stringify({
          version: 1,
          rawId,
          stagingName: replacementRunName,
          staleIds,
          replacementIds: stagedEntries.map((entry) => entry.entryId),
          replacementDigestedAt: now,
        } satisfies EntryReplacementManifest, null, 2),
        'utf8',
      );
      for (const staleId of staleIds) {
        const entryDir = path.join(entriesRoot, staleId);
        if (await pathExists(entryDir)) {
          const backupDir = path.join(backupRoot, staleId);
          await fsp.rename(entryDir, backupDir);
          backedUpPaths.push({ from: backupDir, to: entryDir });
        }
        const legacyEntryFile = path.join(entriesRoot, `${staleId}.md`);
        if (await pathExists(legacyEntryFile)) {
          const backupFile = path.join(backupRoot, `${staleId}.md`);
          await fsp.rename(legacyEntryFile, backupFile);
          backedUpPaths.push({ from: backupFile, to: legacyEntryFile });
        }
      }
      for (const staged of stagedEntries) {
        await fsp.rename(staged.stagedDir, staged.finalDir);
        installedDirs.push(staged.finalDir);
      }

      const removedEntryIds = db.replaceEntriesForRawId(rawId, stagedEntries.map((entry) => entry.replacement));
      await this._deleteEntryEmbeddings(hash, removedEntryIds);
      writtenEntryIds.push(...stagedEntries.map((entry) => entry.entryId));
      await fsp.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    } catch (err: unknown) {
      for (const installedDir of [...installedDirs].reverse()) {
        await fsp.rm(installedDir, { recursive: true, force: true }).catch(() => undefined);
      }
      for (const backup of [...backedUpPaths].reverse()) {
        if (!(await pathExists(backup.from))) continue;
        await fsp.rm(backup.to, { recursive: true, force: true }).catch(() => undefined);
        await fsp.mkdir(path.dirname(backup.to), { recursive: true });
        await fsp.rename(backup.from, backup.to).catch(() => undefined);
      }
      await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      await fsp.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
      const debugPath = await this._dumpDebugOutput(hash, rawId, rawOutputs.join('\n\n'));
      const suffix = debugPath ? ` (debug dump: ${debugPath})` : '';
      return this._failRaw(hash, rawId, db, 'schema_rejection',
        `Failed to write entry: ${(err as Error).message}${suffix}`);
    } finally {
      await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    // Mark the raw as digested and clear any previous error state.
    db.updateRawStatus(rawId, 'digested');
    db.setRawDigestedAt(rawId, now);

    // ── Embed new entries (best-effort — failures don't block digestion) ──
    try {
      await this._embedEntries(hash, parsed.map((item) => item.entry), writtenEntryIds);
    } catch (err: unknown) {
      console.warn(
        `[kb] digest: embedding failed for raw ${rawId}:`,
        (err as Error).message,
      );
    }

    this._emitChange(hash, now, { raw: [rawId], entries: writtenEntryIds });
    return { rawId, entryIds: writtenEntryIds, purged: false };
  }

  /**
   * Embed newly-digested entries into the PGLite vector store.
   * Skips silently when no embedding config is set or Ollama is unreachable.
   */
  private async _embedEntries(
    hash: string,
    parsed: ParsedEntry[],
    entryIds: string[],
  ): Promise<void> {
    const cfg = await this.chatService.getWorkspaceKbEmbeddingConfig(hash);
    if (!cfg) return; // embedding not configured for this workspace

    const resolved = resolveConfig(cfg);
    const store = await this.chatService.getKbVectorStore(hash, resolved.dimensions);
    if (!store) return;

    // Build "title — summary" texts for batch embedding.
    const texts = parsed.map((e) => `${e.title} — ${e.summary}`);
    const results = await embedBatch(texts, cfg);

    // Store model info and upsert each entry's embedding.
    await store.setModel(resolved.model);
    for (let i = 0; i < entryIds.length; i++) {
      await store.upsertEntry(
        entryIds[i],
        parsed[i].title,
        parsed[i].summary,
        results[i].embedding,
      );
    }
  }

  /**
   * Purge a raw row and all its disk artifacts. Used when a pending-delete
   * raw reaches the digest queue — there's nothing to digest, just clean up.
   * Returns the list of entry IDs that were removed (may be empty).
   */
  private async _purgeRaw(hash: string, rawId: string, db: KbDatabase): Promise<string[]> {
    // 1) Remove raw file(s) from disk.
    const rawDir = this.chatService.getKbRawDir(hash);
    try {
      const files = await fsp.readdir(rawDir);
      for (const name of files.filter((n) => n === rawId || n.startsWith(`${rawId}.`))) {
        await fsp.rm(path.join(rawDir, name), { force: true }).catch(() => undefined);
      }
    } catch { /* dir missing or unreadable */ }

    // 2) Remove converted directory.
    await fsp.rm(
      path.join(this.chatService.getKbConvertedDir(hash), rawId),
      { recursive: true, force: true },
    ).catch(() => undefined);

    // 3) Delete entries. The DB method marks co-topic entries stale before
    // cascade-deleting topic assignments.
    const removedEntryIds = db.deleteEntriesByRawId(rawId);
    await this._deleteEntryEmbeddings(hash, removedEntryIds);
    const entriesDir = this.chatService.getKbEntriesDir(hash);
    for (const entryId of removedEntryIds) {
      await fsp.rm(path.join(entriesDir, entryId), { recursive: true, force: true }).catch(() => undefined);
      await fsp.rm(path.join(entriesDir, `${entryId}.md`), { force: true }).catch(() => undefined);
    }

    // 4) Delete raw row (cascades to raw_locations + entry rows).
    db.deleteRaw(rawId);
    return removedEntryIds;
  }

  private async _deleteEntryEmbeddings(hash: string, entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) return;
    try {
      const cfg = await this.chatService.getWorkspaceKbEmbeddingConfig(hash);
      if (!cfg) return;
      const resolved = resolveConfig(cfg);
      const store = await this.chatService.getKbVectorStore(hash, resolved.dimensions);
      if (!store) return;
      for (const entryId of entryIds) {
        await store.deleteEntry(entryId);
      }
    } catch (err: unknown) {
      console.warn(
        `[kb] digest: failed to delete stale entry embeddings for entries ${entryIds.join(',')}:`,
        (err as Error).message,
      );
    }
  }

  /**
   * Fail-path: update the DB row and emit a frame so the UI shows the
   * error. Returns a populated DigestResult for the caller.
   */
  private _failRaw(
    hash: string,
    rawId: string,
    db: KbDatabase,
    klass: KbErrorClass,
    message: string,
  ): DigestResult {
    db.updateRawStatus(rawId, 'failed', { errorClass: klass, errorMessage: message });
    this._emitChange(hash, new Date().toISOString(), { raw: [rawId] });
    return { rawId, entryIds: [], purged: false, error: { class: klass, message } };
  }

  /**
   * Dump the raw CLI output to `knowledge/digest-debug/<rawId>-<iso>.txt`
   * so failed parses can be inspected later. Returns the path on success,
   * empty string on I/O failure (best-effort).
   */
  private async _dumpDebugOutput(
    hash: string,
    rawId: string,
    rawOutput: string,
    label?: string,
  ): Promise<string> {
    try {
      const debugDir = path.join(this.chatService.getKbKnowledgeDir(hash), 'digest-debug');
      await fsp.mkdir(debugDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const suffix = label ? `-${label.replace(/[^a-z0-9_-]+/gi, '-')}` : '';
      const filePath = path.join(debugDir, `${rawId}${suffix}-${stamp}.txt`);
      await fsp.writeFile(filePath, rawOutput, 'utf8');
      return filePath;
    } catch {
      return '';
    }
  }

  /**
   * Build a unique entry ID as `<rawId>-<slug>` with a numeric suffix on
   * collisions. Collisions can happen both across runs (re-digest hit the
   * same slug) and within a single run (the CLI emitted two entries with
   * the same slug).
   */
  private _allocateEntryId(
    db: KbDatabase,
    rawId: string,
    slug: string,
    opts: { reservedIds?: Set<string>; reusableIds?: Set<string> } = {},
  ): string {
    const base = `${rawId}-${slug}`;
    const reserve = (entryId: string): string => {
      opts.reservedIds?.add(entryId);
      return entryId;
    };
    const isTaken = (entryId: string): boolean => (
      Boolean(opts.reservedIds?.has(entryId))
      || (!opts.reusableIds?.has(entryId) && db.entryIdTaken(entryId))
    );
    if (!isTaken(base)) return reserve(base);
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base}-${n}`;
      if (!isTaken(candidate)) return reserve(candidate);
    }
    // Extreme fallback — should never happen in practice.
    return reserve(`${base}-${Date.now()}`);
  }

  private async _recoverWorkspaceEntryReplacements(hash: string, db: KbDatabase): Promise<void> {
    const existing = this.recoveryByWorkspace.get(hash);
    if (existing) return existing;

    const recovery = this._recoverWorkspaceEntryReplacementsOnce(hash, db)
      .catch((err: unknown) => {
        this.recoveryByWorkspace.delete(hash);
        throw err;
      });
    this.recoveryByWorkspace.set(hash, recovery);
    return recovery;
  }

  private async _recoverWorkspaceEntryReplacementsOnce(hash: string, db: KbDatabase): Promise<void> {
    const entriesRoot = this.chatService.getKbEntriesDir(hash);
    const backupParent = path.join(entriesRoot, '.backup');
    const stagingParent = path.join(entriesRoot, '.staging');

    let backupEntries: string[];
    try {
      backupEntries = await fsp.readdir(backupParent);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      backupEntries = [];
    }

    for (const backupName of backupEntries) {
      const backupRoot = path.join(backupParent, backupName);
      const manifest = await readEntryReplacementManifest(path.join(backupRoot, 'manifest.json'));
      if (!manifest) continue;

      if (this._entryReplacementCommitted(db, manifest)) {
        await fsp.rm(backupRoot, { recursive: true, force: true });
        continue;
      }

      for (const replacementId of manifest.replacementIds) {
        await fsp.rm(path.join(entriesRoot, replacementId), { recursive: true, force: true }).catch(() => undefined);
        await fsp.rm(path.join(entriesRoot, `${replacementId}.md`), { force: true }).catch(() => undefined);
      }

      const backedUp = await fsp.readdir(backupRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of backedUp) {
        if (entry.name === 'manifest.json') continue;
        const from = path.join(backupRoot, entry.name);
        const to = path.join(entriesRoot, entry.name);
        await fsp.rm(to, { recursive: true, force: true }).catch(() => undefined);
        await fsp.rename(from, to).catch(() => undefined);
      }
      await fsp.rm(backupRoot, { recursive: true, force: true });
    }

    await fsp.rm(stagingParent, { recursive: true, force: true }).catch(() => undefined);
    await removeIfEmpty(backupParent);
  }

  private _entryReplacementCommitted(db: KbDatabase, manifest: EntryReplacementManifest): boolean {
    if (manifest.replacementIds.length === 0) return false;
    const replacementSet = new Set(manifest.replacementIds);
    const currentIds = db.listEntryIdsByRawId(manifest.rawId);
    if (currentIds.length !== replacementSet.size) return false;
    for (const entryId of currentIds) {
      if (!replacementSet.has(entryId)) return false;
      const entry = db.getEntry(entryId);
      if (!entry || entry.digestedAt !== manifest.replacementDigestedAt) return false;
    }
    return true;
  }

  private _emitChange(
    hash: string,
    updatedAt: string,
    changed: KbStateUpdateEvent['changed'],
  ): void {
    if (!this.emit) return;
    const frame: KbStateUpdateEvent = {
      type: 'kb_state_update',
      updatedAt,
      changed,
    };
    try {
      this.emit(hash, frame);
    } catch (err: unknown) {
      console.error('[kb:digest] emit failed:', (err as Error).message);
    }
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readEntryReplacementManifest(filePath: string): Promise<EntryReplacementManifest | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8')) as Partial<EntryReplacementManifest>;
    if (
      parsed.version !== 1 ||
      typeof parsed.rawId !== 'string' ||
      typeof parsed.stagingName !== 'string' ||
      typeof parsed.replacementDigestedAt !== 'string' ||
      !Array.isArray(parsed.staleIds) ||
      !Array.isArray(parsed.replacementIds) ||
      !parsed.staleIds.every((id) => typeof id === 'string') ||
      !parsed.replacementIds.every((id) => typeof id === 'string')
    ) {
      return null;
    }
    return {
      version: 1,
      rawId: parsed.rawId,
      stagingName: parsed.stagingName,
      staleIds: parsed.staleIds,
      replacementIds: parsed.replacementIds,
      replacementDigestedAt: parsed.replacementDigestedAt,
    };
  } catch {
    return null;
  }
}

async function removeIfEmpty(dirPath: string): Promise<void> {
  try {
    const remaining = await fsp.readdir(dirPath);
    if (remaining.length === 0) {
      await fsp.rmdir(dirPath);
    }
  } catch {
    // Best-effort cleanup only.
  }
}

// ─── Prompt builder ─────────────────────────────────────────────────────────

export interface BuildDigestPromptInput {
  filename: string;
  folderPath: string;
  rawId: string;
  handler: string;
  mimeType: string;
  convertedTextPath: string;
  convertedText: string;
  handlerMetadata?: Record<string, unknown>;
  chunk?: {
    chunkId: string;
    index: number;
    total: number;
    unitType: string;
    startUnit: number;
    endUnit: number;
    nodeTitles: string[];
  };
}

/**
 * Build the prompt fed to the Digestion CLI. Keeps the schema contract
 * at the top so the CLI sees it first, then the file context, then the
 * converted text. We include the full converted text inline (capped)
 * because most handlers produce compact Markdown; for very large files
 * the CLI can still tool-read the raw file path at the top.
 */
export function buildDigestPrompt(input: BuildDigestPromptInput): string {
  const folderLabel = input.folderPath ? input.folderPath : '<root>';
  const metaLines: string[] = [];
  if (input.handlerMetadata) {
    for (const [k, v] of Object.entries(input.handlerMetadata)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') continue;
      metaLines.push(`  ${k}: ${String(v)}`);
    }
  }

  const header = [
    `# Knowledge Base digestion request`,
    ``,
    `You are ingesting a file into a workspace knowledge base. Produce one or`,
    `more structured entries in the exact format described below.`,
    ``,
    `## Output format`,
    ``,
    `Return ONE OR MORE entries separated by a line containing only "---".`,
    `Each entry MUST start with YAML frontmatter and MUST include:`,
    ``,
    `  ---`,
    `  title: <short title, 1 line>`,
    `  slug: <url-safe slug, lowercase, hyphens only>`,
    `  summary: <one-sentence summary, 1 line>`,
    `  tags: [tag1, tag2, tag3]`,
    `  ---`,
    `  <Markdown body of the entry — as much or as little as the source demands>`,
    ``,
    `Rules:`,
    `- Output nothing outside the entry blocks. No preamble, no explanation.`,
    `- Tags must be lowercase, alphanumeric + hyphens, no spaces.`,
    `- A slug is required. If you can't derive a good one, use "overview".`,
    `- Prefer MANY focused entries over one mega-entry when the source covers`,
    `  several distinct ideas. Prefer ONE entry when the source is a single`,
    `  coherent topic.`,
    `- Do NOT include the original filename in the title unless the filename`,
    `  itself is the canonical name (e.g. a person's memoir).`,
    `- The converted text annotates each section (e.g. \`## Page N\`, \`## Slide N\`)`,
    `  with a \`> source: <label>\` blockquote. The label tells you how reliable`,
    `  the text is and when to open the accompanying image:`,
    ``,
    `  * \`source: pdfjs\` (PDF) or \`source: xml-extract\` (PPTX) — text was`,
    `    deterministically extracted; the image link is backup. Consult the image`,
    `    only when the text seems incomplete, contradictory, or references a`,
    `    visual element you can't see in the markdown.`,
    ``,
    `  * \`source: artificial-intelligence\` — markdown was reconstructed from the`,
    `    image by a multimodal AI converter at ingest time (tables and figure`,
    `    descriptions already captured). The markdown is your primary source;`,
    `    open the image directly to verify a specific table cell, figure detail,`,
    `    or layout when accuracy matters.`,
    ``,
    `  * \`source: image-only\` — no text was extractable and AI conversion failed.`,
    `    The image IS the content; you MUST open and analyze it with your Read`,
    `    tool.`,
    ``,
    `  Image paths are relative to the converted text file's directory.`,
    ``,
    `## Source file`,
    ``,
    `- Filename: ${input.filename}`,
    `- Folder: ${folderLabel}`,
    `- Raw ID: ${input.rawId}`,
    `- Handler: ${input.handler}`,
    `- MIME type: ${input.mimeType}`,
    `- Converted text (relative to knowledge/): ${input.convertedTextPath}`,
  ];
  if (metaLines.length > 0) {
    header.push(`- Handler metadata:`);
    header.push(...metaLines);
  }
  if (input.chunk) {
    header.push(``);
    header.push(`## Chunk context`);
    header.push(``);
    header.push(`- Chunk: ${input.chunk.chunkId} (${input.chunk.index} of ${input.chunk.total})`);
    header.push(`- Unit type: ${input.chunk.unitType}`);
    header.push(`- Unit range: ${input.chunk.startUnit}-${input.chunk.endUnit}`);
    if (input.chunk.nodeTitles.length > 0) {
      header.push(`- Structure nodes: ${input.chunk.nodeTitles.join(' | ')}`);
    }
    header.push(`- The converted text below is only this chunk's source range, not necessarily the whole document.`);
  }
  header.push(``);
  header.push(`## Converted text`);
  header.push(``);
  header.push('```markdown');
  header.push(input.convertedText);
  header.push('```');
  header.push(``);
  header.push(`Now produce the entries.`);

  return header.join('\n');
}

export function buildGleaningPrompt(): string {
  return [
    '# Knowledge Base gleaning pass',
    '',
    'Review the source range and the entries you just extracted.',
    'Identify important entities, relationships, concepts, or facts that were missed or under-represented.',
    'Return only additional entries in the exact same frontmatter + Markdown format.',
    'If nothing important was missed, return no entries.',
    '',
    'Do not repeat entries you already extracted.',
  ].join('\n');
}

// ─── Parser + stringifier ───────────────────────────────────────────────────

/**
 * Parse one or more entries out of a digestion CLI output blob. Entries
 * are separated by a line containing only `---`. Each entry starts with
 * YAML frontmatter (key: value, one per line; `tags` may be an inline
 * array `[a, b, c]` or a YAML list) followed by a Markdown body.
 *
 * Throws `DigestParseError` or `DigestSchemaError` with a clear message
 * on malformed input. The caller classifies these.
 */
export function parseEntries(rawOutput: string): ParsedEntry[] {
  let cleaned = rawOutput.trim();
  if (!cleaned) return [];

  // Strip leading/trailing triple-backtick code fences the CLI sometimes
  // wraps around the entire output (e.g. ```yaml ... ```).
  cleaned = cleaned.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  if (!cleaned) return [];

  // Split on lines containing only `---` — this is both the entry
  // boundary AND the frontmatter fence. We handle the ambiguity by
  // treating the first `---` in a non-empty segment as the opener, the
  // second as the closer, and any additional `---` as an inter-entry
  // separator.
  //
  // Implementation: walk the text line by line, tracking a small state
  // machine: outside → in-fm → in-body. Switching from in-body back to
  // outside on an empty-prefix `---` line lets us start a new entry.
  const lines = cleaned.split(/\r?\n/);
  const entries: ParsedEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    // Skip blank lines between entries.
    while (i < lines.length && lines[i].trim() === '') i += 1;
    if (i >= lines.length) break;
    // Skip preamble prose (e.g. "Here are the entries:") before the
    // first `---` fence. After the first entry, we still require `---`.
    if (lines[i].trim() !== '---') {
      if (entries.length === 0) {
        while (i < lines.length && lines[i].trim() !== '---') i += 1;
        if (i >= lines.length) break;
      } else {
        throw new DigestParseError(
          `Expected "---" at line ${i + 1}; got: ${JSON.stringify(lines[i])}`,
        );
      }
    }
    i += 1; // consume opener
    const fmLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '---') {
      fmLines.push(lines[i]);
      i += 1;
    }
    if (i >= lines.length) {
      throw new DigestParseError('Unterminated frontmatter block (missing closing ---)');
    }
    i += 1; // consume closer
    const bodyLines: string[] = [];
    while (i < lines.length) {
      if (lines[i].trim() === '---') {
        // Peek ahead: if the next non-blank line looks like frontmatter
        // (starts with "title:"), this `---` is an entry boundary.
        // Otherwise it's a markdown horizontal rule within the body.
        let peek = i + 1;
        while (peek < lines.length && lines[peek].trim() === '') peek += 1;
        if (peek >= lines.length || /^title\s*:/i.test(lines[peek].trim())) {
          break;
        }
      }
      bodyLines.push(lines[i]);
      i += 1;
    }
    const fields = parseFrontmatterLines(fmLines);
    const entry = validateEntry(fields, bodyLines.join('\n').trim());
    entries.push(entry);
  }
  return entries;
}

/**
 * Parse a set of frontmatter lines into a typed-ish record. Values are
 * always strings except `tags`, which may be an inline `[a, b]` array
 * or a YAML list form.
 */
function parseFrontmatterLines(lines: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  let listMode = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (listMode && trimmed.startsWith('- ')) {
      const value = trimmed.slice(2).trim().replace(/^['"]|['"]$/g, '');
      if (currentKey) {
        const existing = out[currentKey];
        if (Array.isArray(existing)) existing.push(value);
        else out[currentKey] = [value];
      }
      continue;
    }
    listMode = false;
    const sep = trimmed.indexOf(':');
    if (sep === -1) continue;
    const key = trimmed.slice(0, sep).trim().toLowerCase();
    let value = trimmed.slice(sep + 1).trim();
    if (!key) continue;
    currentKey = key;
    if (value === '') {
      // Potential list on the next lines.
      listMode = true;
      out[key] = [];
      continue;
    }
    // Inline array?
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      if (inner === '') {
        out[key] = [];
      } else {
        out[key] = inner
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter((s) => s.length > 0);
      }
      continue;
    }
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Validate a parsed frontmatter object + body against the entry
 * schema. Throws `DigestSchemaError` on any violation. Normalizes the
 * slug + tags so downstream code can trust them.
 */
function validateEntry(
  fields: Record<string, string | string[]>,
  body: string,
): ParsedEntry {
  const title = takeString(fields.title);
  const summary = takeString(fields.summary);
  let slug = takeString(fields.slug);
  const tagsField = fields.tags;

  if (!title) throw new DigestSchemaError('Entry missing required field: title');
  if (!summary) throw new DigestSchemaError('Entry missing required field: summary');
  if (!slug) slug = slugify(title);
  slug = slugify(slug);
  if (!slug) throw new DigestSchemaError('Entry slug is empty after normalization');

  let tags: string[] = [];
  if (Array.isArray(tagsField)) {
    tags = tagsField;
  } else if (typeof tagsField === 'string' && tagsField) {
    tags = tagsField.split(',').map((s) => s.trim());
  }
  tags = tags
    .map((t) => normalizeTag(t))
    .filter((t) => t.length > 0)
    .filter((t, idx, arr) => arr.indexOf(t) === idx);

  if (!body) throw new DigestSchemaError('Entry body is empty');

  return { title, slug, summary, tags, body };
}

function takeString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
    return (value[0] as string).trim();
  }
  return '';
}

/** Turn arbitrary text into a url-safe slug. */
export function slugify(input: string): string {
  return (input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeTag(tag: string): string {
  return (tag || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Render a ParsedEntry back out as the canonical `entry.md` content.
 * Field order is deterministic (title → slug → summary → tags) so
 * re-digestions produce stable diffs.
 */
export interface StringifyEntryOptions {
  uploadedAt?: string;
  digestedAt?: string;
}

export function stringifyEntry(entry: ParsedEntry, opts: StringifyEntryOptions = {}): string {
  const fmLines = [
    '---',
    `title: ${yamlString(entry.title)}`,
    `slug: ${yamlString(entry.slug)}`,
    `summary: ${yamlString(entry.summary)}`,
    `tags: [${entry.tags.map(yamlString).join(', ')}]`,
    `schemaVersion: ${KB_ENTRY_SCHEMA_VERSION}`,
  ];
  if (opts.uploadedAt) fmLines.push(`uploadedAt: ${yamlString(opts.uploadedAt)}`);
  if (opts.digestedAt) fmLines.push(`digestedAt: ${yamlString(opts.digestedAt)}`);
  fmLines.push('---', '');
  return fmLines.join('\n') + entry.body.trim() + '\n';
}

/**
 * Minimal YAML string quoting — wraps in double quotes only when the
 * value contains characters that would confuse a YAML parser (`:`, `#`,
 * `[`, `]`, `"`, newlines). Keeps the output readable for simple values.
 */
function yamlString(value: string): string {
  if (!value) return '""';
  if (/[:\#\[\]\"\n,]/.test(value)) {
    return '"' + value.replace(/"/g, '\\"') + '"';
  }
  return value;
}

function chunkProgressKey(rawId: string, chunkId: string): string {
  return `${rawId}:${chunkId}`;
}

function makeCurrentChunk(
  rawId: string,
  chunk: KbDigestChunk,
  index: number,
  total: number,
  unitType: string,
): NonNullable<KbDigestChunkProgress['current']> {
  return {
    rawId,
    chunkId: chunk.chunkId,
    index,
    total,
    startUnit: chunk.startUnit,
    endUnit: chunk.endUnit,
    unitType,
  };
}

function makeWholeDocumentChunk(rawId: string, unitCount: number): KbDigestChunk {
  const endUnit = Math.max(1, unitCount || 1);
  return {
    chunkId: `chunk-0001-u1-${endUnit}`,
    rawId,
    nodeIds: [],
    startUnit: 1,
    endUnit,
    estimatedTokens: endUnit * 500,
    reason: 'fallback',
  };
}

function classifyCliError(message: string): KbErrorClass {
  return /\b(?:timeout|time(?:d)?[-_\s]*out)\b/i.test(message) ? 'timeout' : 'cli_error';
}

function makeEntrySourceForChunk(rawId: string, chunk: KbDigestChunk): EntrySourceDraft {
  return {
    rawId,
    nodeId: chunk.nodeIds.length === 1 ? chunk.nodeIds[0] : null,
    chunkId: chunk.chunkId,
    startUnit: chunk.startUnit,
    endUnit: chunk.endUnit,
  };
}

function mergeDuplicateParsedEntries(items: ParsedEntryWithSources[]): ParsedEntryWithSources[] {
  const bySlug = new Map<string, ParsedEntryWithSources>();
  const byTitle = new Map<string, ParsedEntryWithSources>();
  const merged: ParsedEntryWithSources[] = [];

  for (const item of items) {
    const slugKey = item.entry.slug;
    const titleKey = normalizeEntryTitleKey(item.entry.title);
    const existing = bySlug.get(slugKey) || byTitle.get(titleKey);
    if (existing) {
      existing.entry.summary = mergeEntrySummaries(existing.entry.summary, item.entry.summary);
      existing.entry.body = mergeEntryBodies(existing.entry.body, item.entry.body);
      existing.entry.tags = uniqueStrings([...existing.entry.tags, ...item.entry.tags]);
      existing.sources = mergeEntrySources(existing.sources, item.sources);
      bySlug.set(slugKey, existing);
      byTitle.set(titleKey, existing);
      continue;
    }

    const clone: ParsedEntryWithSources = {
      entry: {
        ...item.entry,
        tags: uniqueStrings(item.entry.tags),
      },
      sources: mergeEntrySources([], item.sources),
    };
    merged.push(clone);
    bySlug.set(slugKey, clone);
    byTitle.set(titleKey, clone);
  }

  return merged;
}

function normalizeEntryTitleKey(title: string): string {
  return slugify(title) || title.toLowerCase().trim().replace(/\s+/g, ' ');
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index, arr) => value && arr.indexOf(value) === index);
}

function mergeEntrySummaries(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return right;
  if (!right || left === right) return left;
  return `${left} ${right}`;
}

function mergeEntryBodies(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return right;
  if (!right || left === right) return left;
  return `${left}\n\n***\n\n${right}`;
}

function mergeEntrySources(a: EntrySourceDraft[], b: EntrySourceDraft[]): EntrySourceDraft[] {
  const out: EntrySourceDraft[] = [];
  const seen = new Set<string>();
  for (const source of [...a, ...b]) {
    const key = `${source.rawId}|${source.chunkId}|${source.startUnit}|${source.endUnit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...source });
  }
  return out;
}
