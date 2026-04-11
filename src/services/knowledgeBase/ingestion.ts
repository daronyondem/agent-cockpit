// ─── Knowledge Base ingestion orchestrator ──────────────────────────────────
// Owns the "raw → converted" stage of the pipeline:
//   1. Hash the uploaded buffer → rawId (first 16 hex chars of sha256)
//   2. Stage the raw file under `knowledge/raw/<rawId>.<ext>` (if new)
//   3. Insert raw + raw_locations rows via the KbDatabase layer
//   4. Enqueue background work on a per-workspace FIFO queue:
//      a. mkdir `knowledge/converted/<rawId>/`
//      b. Dispatch to the right format handler (pdf/docx/pptx/passthrough)
//      c. Write `text.md` + `meta.json` + any extracted media
//      d. Update raw.status = 'ingested' (or 'failed' + error_class/message)
//   5. Emit `kb_state_update` WS frames on every state mutation
//
// Multi-location raw files (Phase 3): the same sha256 can be uploaded into
// multiple folders under the same workspace. Each upload creates a new
// `raw_locations` row but reuses the existing `raw` row + on-disk bytes.
// Conversely, deleting a location decrements the location count; the raw
// row is only purged when its last location is removed (and in manual-
// digest mode, files flip to `pending-delete` rather than being dropped,
// so the user sees them in the "Pending" view and can run the batch
// digest before they disappear).
//
// The HTTP layer calls `enqueueUpload`, which returns immediately after
// the raw file is staged and the DB rows exist. The background work is
// serialized per-workspace so two uploads for the same workspace can't
// race on the DB, but different workspaces can ingest in parallel.
//
// The orchestrator does NOT own WS transport. It calls an `emit` callback
// that the caller wires up to whatever WS plumbing exists (see `chat.ts`
// for the active-stream broadcast pattern used by `memory_update`).

import path from 'path';
import crypto from 'crypto';
import { promises as fsp } from 'fs';
import type {
  KbRawEntry,
  KbRawStatus,
  KbStateUpdateEvent,
  Settings,
} from '../../types';
import { ingestFile, UnsupportedFileTypeError } from './handlers';
import type { HandlerResult } from './handlers/types';
import type { KbDatabase } from './db';
import { normalizeFolderPath } from './db';

/** Subset of chatService the orchestrator depends on — keeps tests light. */
export interface KbIngestionChatService {
  getWorkspaceKbEnabled(hash: string): Promise<boolean>;
  getWorkspaceKbAutoDigest(hash: string): Promise<boolean>;
  getKbDb(hash: string): KbDatabase | null;
  getSettings(): Promise<Settings>;
  getKbRawDir(hash: string): string;
  getKbConvertedDir(hash: string): string;
  getKbEntriesDir(hash: string): string;
}

/** Optional digestion orchestrator — called when auto-digest is enabled. */
export interface KbDigestTrigger {
  enqueueDigest(hash: string, rawId: string): Promise<unknown>;
}

/** Emitter for `kb_state_update` frames — fan-out is the caller's job. */
export type KbStateEmitter = (hash: string, frame: KbStateUpdateEvent) => void;

export interface KbIngestionOptions {
  chatService: KbIngestionChatService;
  emit?: KbStateEmitter;
  /** Digest hook for auto-digest (optional, wired after construction). */
  digestTrigger?: KbDigestTrigger;
}

export interface KbUploadInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  /** Virtual folder path, defaults to root (''). */
  folderPath?: string;
}

export interface KbUploadResult {
  /**
   * The resulting raw entry (includes folderPath/filename for this
   * specific location). Status is 'ingesting' on fresh uploads, or the
   * existing status on dedupe hits.
   */
  entry: KbRawEntry;
  /**
   * True when this sha256 already existed in the workspace. On dedupe
   * hits we may still have created a new `raw_locations` row (if the
   * folderPath/filename combination was new). Use `addedLocation` to
   * disambiguate "true dedup, nothing happened" from "dedup + added to
   * another folder".
   */
  deduped: boolean;
  /** True when a new `raw_locations` row was written. */
  addedLocation: boolean;
}

/** Thrown when the workspace is not found or KB is disabled. */
export class KbDisabledError extends Error {
  constructor(hash: string) {
    super(`Knowledge Base is not enabled for workspace ${hash}.`);
    this.name = 'KbDisabledError';
  }
}

/** Thrown when a raw file cannot be deleted because it doesn't exist. */
export class KbRawNotFoundError extends Error {
  constructor(rawId: string) {
    super(`No raw file with id ${rawId} in this workspace.`);
    this.name = 'KbRawNotFoundError';
  }
}

/** Thrown when a location (folder + filename) is already taken. */
export class KbLocationConflictError extends Error {
  constructor(folderPath: string, filename: string) {
    super(`A file named "${filename}" already exists in folder "${folderPath || '/'}".`);
    this.name = 'KbLocationConflictError';
  }
}

/** Thrown on validation failures (bad folder path, empty filename, …). */
export class KbValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KbValidationError';
  }
}

export class KbIngestionService {
  private readonly chatService: KbIngestionChatService;
  private readonly emit?: KbStateEmitter;
  private digestTrigger?: KbDigestTrigger;
  /**
   * Per-workspace FIFO queue implemented as a chained Promise. All writes
   * to a workspace's DB and `converted/` dir go through this queue so
   * there's no read-modify-write races on a single workspace. Cross-
   * workspace ingestions run in parallel — the Map is keyed by hash.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(opts: KbIngestionOptions) {
    this.chatService = opts.chatService;
    this.emit = opts.emit;
    this.digestTrigger = opts.digestTrigger;
  }

  /**
   * Late-bind the digestion trigger. Ingestion and digestion have a
   * circular dependency at the object level (ingestion needs digest to
   * auto-trigger, digest needs ingestion to re-run after raw update).
   * We break the cycle by letting the caller wire them up after both
   * are constructed.
   */
  setDigestTrigger(trigger: KbDigestTrigger): void {
    this.digestTrigger = trigger;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Stage an uploaded file and kick off background ingestion. Returns as
   * soon as the raw file is on disk and the DB rows exist — the heavy
   * lifting (handler dispatch) runs asynchronously on the workspace queue.
   *
   * Rejects with `KbDisabledError` when KB is not enabled for this workspace
   * so the HTTP route can return 400. All other errors are recorded on the
   * raw row as `status='failed'` rather than propagated, because at the
   * point of failure the upload has already been accepted — the user wants
   * to see the failure in the UI, not receive a late 500.
   */
  async enqueueUpload(hash: string, file: KbUploadInput): Promise<KbUploadResult> {
    const enabled = await this.chatService.getWorkspaceKbEnabled(hash);
    if (!enabled) throw new KbDisabledError(hash);

    const filename = file.filename?.trim();
    if (!filename) {
      throw new KbValidationError('Filename cannot be empty.');
    }
    // Reject path separators or absolute paths — folderPath carries that info.
    if (filename.includes('/') || filename.includes('\\')) {
      throw new KbValidationError('Filename must not contain path separators.');
    }
    const folderPath = normalizeFolderPath(file.folderPath ?? '');

    // Full sha256 is our content-address. rawId (16-hex prefix) is used
    // for URLs and filenames; the full hash lives on `raw.sha256` and is
    // what dedupe checks against.
    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const rawId = sha256.slice(0, 16);
    const ext = path.extname(filename) || '';
    const rawDir = this.chatService.getKbRawDir(hash);
    await fsp.mkdir(rawDir, { recursive: true });
    const rawPath = path.join(rawDir, `${rawId}${ext}`);

    return this._enqueue(hash, async () => {
      const db = this.chatService.getKbDb(hash);
      if (!db) throw new KbDisabledError(hash);

      // ── Dedupe path ────────────────────────────────────────────────────
      // Same bytes already in the workspace → reuse the raw row + bytes,
      // insert a new location row if this (folder, filename) is new.
      const existingBySha = db.getRawBySha(sha256);
      if (existingBySha) {
        // Collision: a different file already occupies this name in this folder?
        const atLocation = db.findLocation(folderPath, filename);
        if (atLocation) {
          if (atLocation.rawId === existingBySha.raw_id) {
            // Exact dedupe — same bytes at same path. No-op.
            return this._buildDedupResult(
              db,
              existingBySha.raw_id,
              folderPath,
              filename,
              false,
            );
          }
          // Same folder+filename but different bytes — refuse so the
          // UI can surface "rename and retry".
          throw new KbLocationConflictError(folderPath, filename);
        }

        // Write raw file if the previous upload's bytes went missing (edge
        // case — a manual rm somewhere). Harmless if the file exists.
        await this._ensureRawBytes(rawPath, file.buffer);

        const now = new Date().toISOString();
        db.addLocation({
          rawId: existingBySha.raw_id,
          folderPath,
          filename,
          uploadedAt: now,
        });
        const result = this._buildDedupResult(
          db,
          existingBySha.raw_id,
          folderPath,
          filename,
          true,
        );
        this._emitChange(hash, now, {
          raw: [existingBySha.raw_id],
          folders: true,
        });
        return result;
      }

      // ── New-content path ────────────────────────────────────────────────
      // Also check for folder+filename conflict, since a different rawId
      // already at this location is still a collision (different bytes,
      // same name). Most common when users upload with the same name
      // after editing a local copy.
      const conflict = db.findLocation(folderPath, filename);
      if (conflict) {
        throw new KbLocationConflictError(folderPath, filename);
      }

      // Write the raw file first so even if the DB insert fails we still
      // have the bytes on disk and can recover by re-scanning.
      try {
        await fsp.writeFile(rawPath, file.buffer);
      } catch (err: unknown) {
        throw new Error(`Failed to stage raw file ${filename}: ${(err as Error).message}`);
      }

      const now = new Date().toISOString();
      db.transaction(() => {
        db.insertRaw({
          rawId,
          sha256,
          status: 'ingesting',
          byteLength: file.buffer.byteLength,
          mimeType: file.mimeType || 'application/octet-stream',
          handler: null,
          uploadedAt: now,
          metadata: null,
        });
        db.addLocation({
          rawId,
          folderPath,
          filename,
          uploadedAt: now,
        });
      });

      const entry = this._readRawEntry(db, rawId, folderPath, filename, now);
      this._emitChange(hash, now, { raw: [rawId], folders: true });

      // Kick off the background conversion — we don't await it because
      // the caller wants the 202 response NOW. The queue chain ensures
      // the next enqueueUpload for this workspace waits for this work.
      this._scheduleConversion(hash, rawId, file);

      return { entry, deduped: false, addedLocation: true };
    });
  }

  /**
   * Remove a specific location for a raw file. If this was the last
   * location, the raw is fully purged (bytes + converted + entries +
   * DB row). Returns `false` when the location doesn't exist so the
   * HTTP route can return 404 without throwing.
   */
  async deleteLocation(
    hash: string,
    rawId: string,
    folderPath: string,
    filename: string,
  ): Promise<boolean> {
    const enabled = await this.chatService.getWorkspaceKbEnabled(hash);
    if (!enabled) throw new KbDisabledError(hash);

    const normalizedFolder = normalizeFolderPath(folderPath);

    return this._enqueue(hash, async () => {
      const db = this.chatService.getKbDb(hash);
      if (!db) return false;

      const loc = db.findLocation(normalizedFolder, filename);
      if (!loc || loc.rawId !== rawId) return false;

      db.removeLocation(rawId, normalizedFolder, filename);
      const remaining = db.countLocations(rawId);
      const now = new Date().toISOString();

      if (remaining > 0) {
        // Other locations still exist — just drop this one, raw stays.
        this._emitChange(hash, now, { raw: [rawId] });
        return true;
      }

      // Last location gone — purge immediately (bytes + converted +
      // entries + DB row) regardless of auto-digest setting. There's
      // nothing to preserve: entries without a source file are stale,
      // and leaving raw bytes on disk for a file the user deleted is
      // confusing.
      await this._purgeRawInternal(hash, rawId, db);
      return true;
    });
  }

  /**
   * Unconditionally delete a raw file and all its downstream artifacts.
   * Removes the raw bytes, converted directory, any digested entries,
   * every `raw_locations` row, and the `raw` row itself. Returns
   * `false` when the raw row doesn't exist.
   */
  async purgeRaw(hash: string, rawId: string): Promise<boolean> {
    const enabled = await this.chatService.getWorkspaceKbEnabled(hash);
    if (!enabled) throw new KbDisabledError(hash);

    return this._enqueue(hash, async () => {
      const db = this.chatService.getKbDb(hash);
      if (!db) return false;
      const raw = db.getRawById(rawId);
      if (!raw) return false;
      await this._purgeRawInternal(hash, rawId, db);
      return true;
    });
  }

  /**
   * Compatibility alias for the Phase 2 `deleteRaw(hash, rawId)` API.
   * Matches the semantics tests relied on: full purge regardless of how
   * many locations the raw has. New callers should prefer the explicit
   * `deleteLocation` or `purgeRaw` methods.
   */
  async deleteRaw(hash: string, rawId: string): Promise<boolean> {
    return this.purgeRaw(hash, rawId);
  }

  /**
   * Create a folder (and any missing ancestors). Idempotent — creating
   * an existing folder is a no-op but still emits a `folders: true`
   * frame so the UI refreshes after a no-op create. Returns the
   * normalized path actually created.
   */
  async createFolder(hash: string, folderPath: string): Promise<string> {
    const enabled = await this.chatService.getWorkspaceKbEnabled(hash);
    if (!enabled) throw new KbDisabledError(hash);
    return this._enqueue(hash, async () => {
      const db = this.chatService.getKbDb(hash);
      if (!db) throw new KbDisabledError(hash);
      const normalized = normalizeFolderPath(folderPath);
      if (normalized === '') throw new KbValidationError('Cannot create root folder.');
      db.createFolder(normalized);
      this._emitChange(hash, new Date().toISOString(), { folders: true });
      return normalized;
    });
  }

  async renameFolder(hash: string, fromPath: string, toPath: string): Promise<void> {
    const enabled = await this.chatService.getWorkspaceKbEnabled(hash);
    if (!enabled) throw new KbDisabledError(hash);
    return this._enqueue(hash, async () => {
      const db = this.chatService.getKbDb(hash);
      if (!db) throw new KbDisabledError(hash);
      db.renameFolder(fromPath, toPath);
      this._emitChange(hash, new Date().toISOString(), { folders: true });
    });
  }

  /**
   * Delete a folder subtree. The UI surfaces this as "Delete folder?
   * This will also remove N files". The caller decides whether to
   * cascade into raw_locations — `cascade=true` removes every
   * `raw_locations` row under the subtree (and follows the same
   * ref-counted delete rules as `deleteLocation`), then removes the
   * now-empty folders. With `cascade=false`, the call throws if any
   * locations still reference the subtree.
   */
  async deleteFolder(
    hash: string,
    folderPath: string,
    opts: { cascade?: boolean } = {},
  ): Promise<void> {
    const enabled = await this.chatService.getWorkspaceKbEnabled(hash);
    if (!enabled) throw new KbDisabledError(hash);
    const cascade = Boolean(opts.cascade);
    const normalized = normalizeFolderPath(folderPath);
    if (normalized === '') throw new KbValidationError('Cannot delete root folder.');

    return this._enqueue(hash, async () => {
      const db = this.chatService.getKbDb(hash);
      if (!db) throw new KbDisabledError(hash);
      const subtree = db.listFolderSubtree(normalized);
      if (subtree.length === 0) throw new KbValidationError(`Folder "${normalized}" does not exist.`);
      // Remove raw_locations across the subtree if cascading.
      for (const folder of subtree) {
        const raws = db.listRawInFolder(folder.folderPath, { limit: 100000 });
        if (raws.length > 0 && !cascade) {
          throw new KbValidationError(
            `Folder "${folder.folderPath}" is not empty. Use cascade=true to delete its files.`,
          );
        }
        for (const entry of raws) {
          db.removeLocation(entry.rawId, folder.folderPath, entry.filename);
          const remaining = db.countLocations(entry.rawId);
          if (remaining === 0) {
            await this._purgeRawInternal(hash, entry.rawId, db);
          }
        }
      }
      // Now delete folders, deepest-first (listFolderSubtree returns in
      // descending-length order already).
      for (const folder of subtree) {
        db.deleteFolder(folder.folderPath);
      }
      this._emitChange(hash, new Date().toISOString(), { folders: true });
    });
  }

  /**
   * Wait for every queued ingestion on a workspace to finish. Intended
   * for tests — production code shouldn't need to block on this because
   * the UI reacts to `kb_state_update` frames as work progresses.
   */
  async waitForIdle(hash: string): Promise<void> {
    const q = this.queues.get(hash);
    if (q) {
      try {
        await q;
      } catch {
        // Individual tasks swallow their own errors onto raw rows.
        // `waitForIdle` shouldn't reject if one of them failed.
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Chain `task` onto the per-workspace queue so only one operation runs
   * at a time for a given workspace. Returns the task's result.
   */
  private _enqueue<T>(hash: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(hash) ?? Promise.resolve();
    const next = prev.then(task, task);
    // Store the chain without the result — the next enqueue only needs
    // to wait for this one to settle, not consume its value. Attach a
    // catch so an unhandled rejection in one task doesn't poison the
    // chain for the next one.
    this.queues.set(
      hash,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Build a `KbUploadResult` for a dedup hit by reading the current DB
   * state. Assumes we're already inside the workspace mutex.
   */
  private _buildDedupResult(
    db: KbDatabase,
    rawId: string,
    folderPath: string,
    filename: string,
    addedLocation: boolean,
  ): KbUploadResult {
    const entry = this._readRawEntry(db, rawId, folderPath, filename);
    return { entry, deduped: true, addedLocation };
  }

  /**
   * Read a `KbRawEntry` from the DB for a specific (rawId, folder, file)
   * triple. Falls back to a synthetic envelope if the row somehow went
   * missing between the write and the read (shouldn't happen, but keeps
   * the caller's result non-null).
   */
  private _readRawEntry(
    db: KbDatabase,
    rawId: string,
    folderPath: string,
    filename: string,
    nowFallback?: string,
  ): KbRawEntry {
    const rows = db.listRawInFolder(folderPath, { limit: 100000 });
    const row = rows.find((r) => r.rawId === rawId && r.filename === filename);
    if (row) return row;
    // Fallback envelope. Keeps TS happy and UI resilient against races.
    const raw = db.getRawById(rawId);
    const now = nowFallback ?? new Date().toISOString();
    return {
      rawId,
      sha256: raw?.sha256 ?? rawId,
      filename,
      folderPath,
      mimeType: raw?.mime_type ?? 'application/octet-stream',
      sizeBytes: raw?.byte_length ?? 0,
      handler: raw?.handler ?? undefined,
      uploadedAt: raw?.uploaded_at ?? now,
      digestedAt: raw?.digested_at ?? null,
      status: (raw?.status as KbRawStatus) ?? 'ingesting',
      errorClass: null,
      errorMessage: null,
    };
  }

  /**
   * Purge a raw row and all its disk artifacts. Caller must be inside
   * the workspace mutex — this method does not re-enqueue.
   */
  private async _purgeRawInternal(hash: string, rawId: string, db: KbDatabase): Promise<void> {
    const raw = db.getRawById(rawId);
    if (!raw) return;

    // 1) Remove the raw file from disk. The locations table may already be
    //    empty here (deleteLocation / deleteFolder remove the row before
    //    calling us), so we can't rely on locations[0].filename for the
    //    extension. Scan the raw dir for anything matching `<rawId>*` and
    //    unlink every hit — catches `<rawId>.txt`, `<rawId>.pdf`, and the
    //    bare-rawId fallback used when the ext was unknown at stage time.
    const rawDir = this.chatService.getKbRawDir(hash);
    try {
      const entries = await fsp.readdir(rawDir);
      const matches = entries.filter(
        (name) => name === rawId || name.startsWith(`${rawId}.`),
      );
      for (const name of matches) {
        await fsp.rm(path.join(rawDir, name), { force: true }).catch(() => undefined);
      }
    } catch {
      // Raw dir doesn't exist yet or is unreadable — nothing to do.
    }

    // 2) Remove the converted subdirectory if it exists.
    const convertedDir = path.join(this.chatService.getKbConvertedDir(hash), rawId);
    await fsp.rm(convertedDir, { recursive: true, force: true }).catch(() => undefined);

    // 3) Mark co-topic entries as needing synthesis before deleting, so
    //    the dreaming pipeline can update topics that referenced this content.
    const removedEntryIds = db.deleteEntriesByRawId(rawId);
    if (removedEntryIds.length > 0) {
      db.markCoTopicEntriesStale(removedEntryIds);
    }
    const entriesDir = this.chatService.getKbEntriesDir(hash);
    for (const entryId of removedEntryIds) {
      const dir = path.join(entriesDir, entryId);
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      const mdFallback = path.join(entriesDir, `${entryId}.md`);
      await fsp.rm(mdFallback, { force: true }).catch(() => undefined);
    }

    // 4) Delete the raw row (cascades to raw_locations).
    db.deleteRaw(rawId);

    const now = new Date().toISOString();
    const changed: KbStateUpdateEvent['changed'] = { raw: [rawId] };
    if (removedEntryIds.length > 0) changed.entries = removedEntryIds;
    this._emitChange(hash, now, changed);
  }

  /**
   * Write `buffer` to `rawPath` if the file is missing. Used in the
   * dedupe path where the DB thinks the bytes exist but an operator
   * may have rm'd them outside our view.
   */
  private async _ensureRawBytes(rawPath: string, buffer: Buffer): Promise<void> {
    try {
      await fsp.access(rawPath);
    } catch {
      await fsp.writeFile(rawPath, buffer);
    }
  }

  /**
   * Run the format handler for a staged raw file and persist its output.
   * This is what runs on the background queue after `enqueueUpload` has
   * returned. All errors are caught and recorded on the raw row as
   * `status='failed'` — we never throw out of this method because the
   * HTTP caller is long gone by the time this runs.
   */
  private _scheduleConversion(hash: string, rawId: string, file: KbUploadInput): void {
    this._enqueue(hash, async () => {
      const db = this.chatService.getKbDb(hash);
      if (!db) return;

      const convertedRoot = this.chatService.getKbConvertedDir(hash);
      const outDir = path.join(convertedRoot, rawId);
      await fsp.mkdir(outDir, { recursive: true });

      const settings = await this.chatService.getSettings();
      const convertSlidesToImages = Boolean(settings.knowledgeBase?.convertSlidesToImages);

      this._emitChange(hash, new Date().toISOString(), {
        raw: [rawId],
        substep: { rawId, text: 'Converting\u2026' },
      });

      let result: HandlerResult | null = null;
      let errorMessage: string | null = null;
      try {
        result = await ingestFile({
          buffer: file.buffer,
          filename: file.filename,
          mimeType: file.mimeType || 'application/octet-stream',
          outDir,
          convertSlidesToImages,
        });
      } catch (err: unknown) {
        errorMessage =
          err instanceof UnsupportedFileTypeError
            ? err.message
            : `Ingestion failed: ${(err as Error).message}`;
      }

      if (result) {
        this._emitChange(hash, new Date().toISOString(), {
          raw: [rawId],
          substep: { rawId, text: 'Storing\u2026' },
        });
        try {
          await fsp.writeFile(path.join(outDir, 'text.md'), result.text, 'utf8');
          const meta = {
            rawId,
            filename: file.filename,
            mimeType: file.mimeType || 'application/octet-stream',
            handler: result.handler,
            mediaFiles: result.mediaFiles,
            metadata: result.metadata ?? {},
            convertedAt: new Date().toISOString(),
          };
          await fsp.writeFile(
            path.join(outDir, 'meta.json'),
            JSON.stringify(meta, null, 2),
            'utf8',
          );
        } catch (err: unknown) {
          errorMessage = `Handler succeeded but writing output failed: ${(err as Error).message}`;
        }
      }

      const status: KbRawStatus = errorMessage ? 'failed' : 'ingested';
      if (errorMessage) {
        db.updateRawStatus(rawId, status, {
          errorClass: 'cli_error',
          errorMessage,
        });
      } else {
        db.updateRawStatus(rawId, status);
        if (result?.handler) db.setRawHandler(rawId, result.handler);
        if (result?.metadata) db.setRawMetadata(rawId, result.metadata);
      }

      this._emitChange(hash, new Date().toISOString(), { raw: [rawId] });

      // Auto-digest hook — fire-and-forget. The digest orchestrator has
      // its own queue + error handling. We don't await it because the
      // ingestion queue should unblock as soon as conversion is recorded.
      if (!errorMessage && this.digestTrigger) {
        const autoDigest = await this.chatService.getWorkspaceKbAutoDigest(hash);
        if (autoDigest) {
          this.digestTrigger.enqueueDigest(hash, rawId).catch((err: unknown) => {
            console.error(
              `[kb:ingestion] auto-digest trigger failed for ${rawId}:`,
              (err as Error).message,
            );
          });
        }
      }
    }).catch((err: unknown) => {
      // Last-ditch safety net: if even the update-status path fails, log
      // and carry on so the queue chain stays unblocked.
      console.error(`[kb:ingestion] background conversion failed for ${rawId}:`, err);
    });
  }

  /** Build and emit a kb_state_update frame if an emitter was provided. */
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
      console.error('[kb:ingestion] emit failed:', (err as Error).message);
    }
  }
}
