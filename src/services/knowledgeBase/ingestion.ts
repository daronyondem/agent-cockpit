// ─── Knowledge Base ingestion orchestrator ──────────────────────────────────
// Owns the "raw → converted" stage of the pipeline:
//   1. Hash the uploaded buffer → rawId (first 16 hex chars of sha256)
//   2. Stage the raw file under `knowledge/raw/<rawId>.<ext>`
//   3. Create/update the KbState entry with status='ingesting'
//   4. Enqueue background work on a per-workspace FIFO queue:
//      a. mkdir `knowledge/converted/<rawId>/`
//      b. Dispatch to the right format handler (pdf/docx/pptx/passthrough)
//      c. Write `text.md` + `meta.json` + any extracted media
//      d. Update KbState with status='ingested' (or 'failed' + error)
//   5. Emit `kb_state_update` WS frames on every state mutation
//
// The HTTP layer calls `enqueueUpload`, which returns immediately after the
// raw file is staged and the state entry is created. The background work is
// serialized per-workspace so two uploads for the same workspace can't race
// on `state.json`, but different workspaces can ingest in parallel.
//
// Deletion is synchronous and cascading: `deleteRaw` removes the raw file,
// the converted directory, any downstream entries (by rawId), and the state
// entry — all under the same per-workspace mutex as ingestion.
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
  KbState,
  KbStateUpdateEvent,
  Settings,
} from '../../types';
import { ingestFile, UnsupportedFileTypeError } from './handlers';
import type { HandlerResult } from './handlers/types';

/** Subset of chatService the orchestrator depends on — keeps tests light. */
export interface KbIngestionChatService {
  getWorkspaceKbEnabled(hash: string): Promise<boolean>;
  getOrInitKbState(hash: string): Promise<KbState | null>;
  saveKbState(hash: string, state: KbState): Promise<KbState>;
  getSettings(): Promise<Settings>;
  getKbRawDir(hash: string): string;
  getKbConvertedDir(hash: string): string;
  getKbEntriesDir(hash: string): string;
}

/** Emitter for `kb_state_update` frames — fan-out is the caller's job. */
export type KbStateEmitter = (hash: string, frame: KbStateUpdateEvent) => void;

export interface KbIngestionOptions {
  chatService: KbIngestionChatService;
  emit?: KbStateEmitter;
}

export interface KbUploadInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface KbUploadResult {
  /** The initial raw entry (status='ingesting'). */
  entry: KbRawEntry;
  /** True when this rawId was already present — caller may want to skip. */
  deduped: boolean;
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

export class KbIngestionService {
  private readonly chatService: KbIngestionChatService;
  private readonly emit?: KbStateEmitter;
  /**
   * Per-workspace FIFO queue implemented as a chained Promise. All writes to
   * a workspace's `state.json` and `converted/` dir go through this queue so
   * there's no read-modify-write races on a single workspace. Cross-workspace
   * ingestions run in parallel — the Map is keyed by hash.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(opts: KbIngestionOptions) {
    this.chatService = opts.chatService;
    this.emit = opts.emit;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Stage an uploaded file and kick off background ingestion. Returns as
   * soon as the raw file is on disk and the state entry exists — the heavy
   * lifting (handler dispatch) runs asynchronously on the workspace queue.
   *
   * Rejects with `KbDisabledError` when KB is not enabled for this workspace
   * so the HTTP route can return 400. All other errors are recorded on the
   * raw entry as `status='failed'` rather than propagated, because at the
   * point of failure the upload has already been accepted — the user wants
   * to see the failure in the UI, not receive a late 500.
   */
  async enqueueUpload(hash: string, file: KbUploadInput): Promise<KbUploadResult> {
    const enabled = await this.chatService.getWorkspaceKbEnabled(hash);
    if (!enabled) throw new KbDisabledError(hash);

    // Hash the buffer to derive the stable rawId. First 16 hex chars of
    // sha256 is plenty for collision avoidance within a workspace and
    // keeps filenames short. Matches the design doc in project memory.
    const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const rawId = sha.slice(0, 16);
    const ext = path.extname(file.filename) || '';
    const rawDir = this.chatService.getKbRawDir(hash);
    await fsp.mkdir(rawDir, { recursive: true });
    const rawPath = path.join(rawDir, `${rawId}${ext}`);

    // Under the per-workspace mutex so two rapid uploads of different
    // files can't corrupt state.json. Writes go: fs → state.json → emit.
    return this._enqueue(hash, async () => {
      const state = (await this.chatService.getOrInitKbState(hash)) ?? this._emptyStateShape();

      const existing = state.raw[rawId];
      if (existing && existing.status !== 'failed') {
        // Dedupe — the same content is already in the workspace. Nothing
        // to do on disk (file is already there) and nothing to change in
        // state.json. Caller can surface a "already uploaded" toast.
        return { entry: existing, deduped: true };
      }

      // Write the raw file first so even if the state write fails we
      // still have the bytes on disk and can recover by re-scanning.
      try {
        await fsp.writeFile(rawPath, file.buffer);
      } catch (err: unknown) {
        throw new Error(`Failed to stage raw file ${file.filename}: ${(err as Error).message}`);
      }

      const entry: KbRawEntry = {
        rawId,
        filename: file.filename,
        mimeType: file.mimeType || 'application/octet-stream',
        sizeBytes: file.buffer.byteLength,
        uploadedAt: new Date().toISOString(),
        status: 'ingesting',
      };
      state.raw[rawId] = entry;
      const saved = await this.chatService.saveKbState(hash, state);
      this._emitChange(hash, saved.updatedAt, { raw: [rawId] });

      // Kick off the background conversion — we don't await it because
      // the caller wants the 202 response NOW. The queue chain ensures
      // the next enqueueUpload for this workspace waits for this work,
      // so we don't need to track the Promise here.
      this._scheduleConversion(hash, rawId, file);

      return { entry, deduped: false };
    });
  }

  /**
   * Cascade-delete a raw file and all its downstream artifacts. Removes:
   *   - The raw file itself (`raw/<rawId>.<ext>`)
   *   - The converted directory (`converted/<rawId>/`)
   *   - Any digested entry files whose rawId matches (best-effort — PR 3
   *     will add the actual digest entries, for PR 2 this is a no-op)
   *   - The raw entry and matching entry refs in `state.json`
   *
   * Returns `true` if the raw existed, `false` if it didn't (so the HTTP
   * route can return 404 without throwing).
   */
  async deleteRaw(hash: string, rawId: string): Promise<boolean> {
    const enabled = await this.chatService.getWorkspaceKbEnabled(hash);
    if (!enabled) throw new KbDisabledError(hash);

    return this._enqueue(hash, async () => {
      const state = await this.chatService.getOrInitKbState(hash);
      if (!state || !state.raw[rawId]) return false;

      // 1) Remove the raw file. We don't know the extension without looking
      //    at state, but we have the full entry — use the filename's ext.
      const ext = path.extname(state.raw[rawId].filename) || '';
      const rawPath = path.join(this.chatService.getKbRawDir(hash), `${rawId}${ext}`);
      await fsp.rm(rawPath, { force: true }).catch(() => undefined);

      // 2) Remove the converted subdirectory if it exists.
      const convertedDir = path.join(this.chatService.getKbConvertedDir(hash), rawId);
      await fsp.rm(convertedDir, { recursive: true, force: true }).catch(() => undefined);

      // 3) Remove any digested entries that point at this rawId. PR 3
      //    will flesh out entry deletion — for now we just clear refs
      //    from state and remove any matching `.md` in entries/.
      const removedEntryIds: string[] = [];
      for (const [entryId, ref] of Object.entries(state.entries)) {
        if (ref.rawId === rawId) {
          removedEntryIds.push(entryId);
          delete state.entries[entryId];
          const entryMd = path.join(this.chatService.getKbEntriesDir(hash), `${entryId}.md`);
          await fsp.rm(entryMd, { force: true }).catch(() => undefined);
        }
      }

      // 4) Drop the raw entry itself.
      delete state.raw[rawId];

      const saved = await this.chatService.saveKbState(hash, state);
      const changed: KbStateUpdateEvent['changed'] = { raw: [rawId] };
      if (removedEntryIds.length > 0) changed.entries = removedEntryIds;
      this._emitChange(hash, saved.updatedAt, changed);
      return true;
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
        // Individual tasks swallow their own errors into state.json.
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
    // to wait for this one to settle, not consume its value. We attach
    // a catch so an unhandled rejection in one task doesn't poison the
    // chain for the next one.
    this.queues.set(
      hash,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Run the format handler for a staged raw file and persist its output.
   * This is what runs on the background queue after `enqueueUpload` has
   * returned. All errors are caught and recorded on the raw entry as
   * `status='failed'` — we never throw out of this method because the
   * HTTP caller is long gone by the time this runs.
   */
  private _scheduleConversion(hash: string, rawId: string, file: KbUploadInput): void {
    this._enqueue(hash, async () => {
      const convertedRoot = this.chatService.getKbConvertedDir(hash);
      const outDir = path.join(convertedRoot, rawId);
      await fsp.mkdir(outDir, { recursive: true });

      const settings = await this.chatService.getSettings();
      const convertSlidesToImages = Boolean(settings.knowledgeBase?.convertSlidesToImages);

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
      await this._updateRawEntry(hash, rawId, (entry) => {
        entry.status = status;
        if (errorMessage) entry.error = errorMessage;
        else delete entry.error;
      });
    }).catch((err: unknown) => {
      // Last-ditch safety net: if even the update-status path fails, log
      // and carry on so the queue chain stays unblocked.
      console.error(`[kb:ingestion] background conversion failed for ${rawId}:`, err);
    });
  }

  /** Read → mutate → write a single raw entry under the queue. */
  private async _updateRawEntry(
    hash: string,
    rawId: string,
    mutator: (entry: KbRawEntry) => void,
  ): Promise<void> {
    const state = await this.chatService.getOrInitKbState(hash);
    if (!state || !state.raw[rawId]) return;
    mutator(state.raw[rawId]);
    const saved = await this.chatService.saveKbState(hash, state);
    this._emitChange(hash, saved.updatedAt, { raw: [rawId] });
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

  /**
   * Fallback shape used when `getOrInitKbState` returns null (e.g. because
   * the workspace just flipped to enabled mid-request). Never persisted —
   * the caller writes the filled-in shape back via `saveKbState`.
   */
  private _emptyStateShape(): KbState {
    return {
      version: 1,
      entrySchemaVersion: 1,
      raw: {},
      entries: {},
      synthesis: {
        status: 'empty',
        lastDreamedAt: null,
        staleEntryIds: [],
      },
      updatedAt: new Date().toISOString(),
    };
  }
}
