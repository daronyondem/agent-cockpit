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
// a FIFO promise chain — one raw at a time per workspace. The batch
// runner (`enqueueBatchDigest`) simply chains every eligible rawId onto
// the workspace queue in order and emits a `batchProgress` frame after
// each one settles.
//
// Cross-file dedup is NOT handled here — that lives in Phase 4
// (Dreaming). Each digest run is self-contained for a single raw file.

import path from 'path';
import { promises as fsp } from 'fs';
import type {
  KbErrorClass,
  KbStateUpdateEvent,
  Settings,
} from '../../types';
import type { BaseBackendAdapter, RunOneShotOptions } from '../backends/base';
import type { BackendRegistry } from '../backends/registry';
import type { KbDatabase } from './db';
import type { KbVectorStore } from './vectorStore';
import { embedBatch, resolveConfig, type EmbeddingConfig } from './embeddings';

/** Version bumped whenever the entry frontmatter/format contract changes. */
export const KB_ENTRY_SCHEMA_VERSION = 1;

/** Subset of chatService the digestion orchestrator depends on. */
export interface KbDigestChatService {
  getWorkspaceKbEnabled(hash: string): Promise<boolean>;
  getWorkspaceKbAutoDigest(hash: string): Promise<boolean>;
  getKbDb(hash: string): KbDatabase | null;
  getSettings(): Promise<Settings>;
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
  /** Per-workspace FIFO promise chain, keyed by workspace hash. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(opts: KbDigestionOptions) {
    this.chatService = opts.chatService;
    this.backendRegistry = opts.backendRegistry;
    this.emit = opts.emit;
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
    return this._enqueue(hash, async () => this._runDigest(hash, rawId));
  }

  /**
   * Queue every eligible raw file in the workspace for digestion. Runs
   * in the order the DB returns them, emitting a `batchProgress: {done,
   * total}` frame after each one settles so the UI's "Digest All
   * Pending" button can show live progress.
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

    const ingested = db.listIngestedRawIds();
    const pending = db.listPendingDeleteRaw().map((r) => r.raw_id);
    const all = [...pending, ...ingested];
    if (all.length === 0) return [];

    const results: DigestResult[] = [];
    let done = 0;
    for (const rawId of all) {
      // Chain every digest onto the shared per-workspace queue so it
      // runs serially even when other callers enqueue in parallel.
      // eslint-disable-next-line no-await-in-loop
      const r = await this._enqueue(hash, async () => this._runDigest(hash, rawId));
      results.push(r);
      done += 1;
      this._emitChange(hash, new Date().toISOString(), {
        raw: [rawId],
        entries: r.entryIds,
        batchProgress: { done, total: all.length },
      });
    }
    return results;
  }

  /** Test hook — wait until every queued digest settles. */
  async waitForIdle(hash: string): Promise<void> {
    const q = this.queues.get(hash);
    if (q) {
      try {
        await q;
      } catch {
        /* per-run errors are captured in DigestResult, not thrown */
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _enqueue<T>(hash: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(hash) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(
      hash,
      next.catch(() => undefined),
    );
    return next;
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
    if (raw.status !== 'ingested' && raw.status !== 'pending-delete') {
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
    const cliBackend = settings.knowledgeBase?.digestionCliBackend;
    const cliModel = settings.knowledgeBase?.digestionCliModel;
    const cliEffort = settings.knowledgeBase?.digestionCliEffort;

    if (!cliBackend) {
      return this._failRaw(hash, rawId, db, 'unknown',
        'No Digestion CLI is configured. Set one under Settings → Knowledge Base.');
    }
    const adapter: BaseBackendAdapter | null = this.backendRegistry.get(cliBackend);
    if (!adapter) {
      return this._failRaw(hash, rawId, db, 'unknown',
        `Configured Digestion CLI "${cliBackend}" is not registered.`);
    }

    const prompt = buildDigestPrompt({
      filename: firstLoc.filename,
      folderPath: firstLoc.folderPath,
      rawId,
      handler: raw.handler ?? 'unknown',
      mimeType: raw.mime_type ?? 'application/octet-stream',
      convertedTextPath: path.relative(
        this.chatService.getKbKnowledgeDir(hash),
        textPath,
      ),
      convertedText,
      handlerMetadata: convertedMeta.metadata as Record<string, unknown> | undefined,
    });

    this._emitChange(hash, new Date().toISOString(), {
      raw: [rawId],
      substep: { rawId, text: 'Running CLI analysis\u2026' },
    });

    let rawOutput = '';
    const runOptions: RunOneShotOptions = {
      model: cliModel,
      effort: cliEffort,
      timeoutMs: 15 * 60_000, // 15 min — large rasterized PDFs can take a long time
      workingDir: this.chatService.getKbKnowledgeDir(hash),
      allowTools: true,
    };
    try {
      rawOutput = await adapter.runOneShot(prompt, runOptions);
    } catch (err: unknown) {
      const message = (err as Error).message || String(err);
      const klass: KbErrorClass = /timeout/i.test(message) ? 'timeout' : 'cli_error';
      return this._failRaw(hash, rawId, db, klass, message);
    }

    this._emitChange(hash, new Date().toISOString(), {
      raw: [rawId],
      substep: { rawId, text: 'Parsing entries\u2026' },
    });

    let parsed: ParsedEntry[];
    try {
      parsed = parseEntries(rawOutput);
    } catch (err: unknown) {
      const debugPath = await this._dumpDebugOutput(hash, rawId, rawOutput);
      const suffix = debugPath ? ` (debug dump: ${debugPath})` : '';
      return this._failRaw(hash, rawId, db, 'malformed_output', (err as Error).message + suffix);
    }
    if (parsed.length === 0) {
      const debugPath = await this._dumpDebugOutput(hash, rawId, rawOutput);
      const suffix = debugPath ? ` (debug dump: ${debugPath})` : '';
      return this._failRaw(hash, rawId, db, 'malformed_output',
        'Digest CLI returned no entries. Expected at least one frontmatter block.' + suffix);
    }

    // Remove any stale entries for this raw before writing fresh ones
    // (re-digest case). Mark co-topic entries as needing synthesis before
    // deletion so the dreaming pipeline knows to update affected topics.
    const staleIds = db.deleteEntriesByRawId(rawId);
    if (staleIds.length > 0) {
      db.markCoTopicEntriesStale(staleIds);
    }
    const entriesRoot = this.chatService.getKbEntriesDir(hash);
    for (const staleId of staleIds) {
      await fsp.rm(path.join(entriesRoot, staleId), { recursive: true, force: true }).catch(() => undefined);
      await fsp.rm(path.join(entriesRoot, `${staleId}.md`), { force: true }).catch(() => undefined);
    }

    const writtenEntryIds: string[] = [];
    const now = new Date().toISOString();
    try {
      for (const entry of parsed) {
        const entryId = this._allocateEntryId(db, rawId, entry.slug);
        const entryDir = path.join(entriesRoot, entryId);
        await fsp.mkdir(entryDir, { recursive: true });
        await fsp.writeFile(
          path.join(entryDir, 'entry.md'),
          stringifyEntry(entry, { uploadedAt: raw.uploaded_at, digestedAt: now }),
          'utf8',
        );
        db.insertEntry({
          entryId,
          rawId,
          title: entry.title,
          slug: entry.slug,
          summary: entry.summary,
          schemaVersion: KB_ENTRY_SCHEMA_VERSION,
          digestedAt: now,
          tags: entry.tags,
        });
        writtenEntryIds.push(entryId);
      }
    } catch (err: unknown) {
      const debugPath = await this._dumpDebugOutput(hash, rawId, rawOutput);
      const suffix = debugPath ? ` (debug dump: ${debugPath})` : '';
      return this._failRaw(hash, rawId, db, 'schema_rejection',
        `Failed to write entry: ${(err as Error).message}${suffix}`);
    }

    // Mark the raw as digested and clear any previous error state.
    db.updateRawStatus(rawId, 'digested');
    db.setRawDigestedAt(rawId, now);

    // ── Embed new entries (best-effort — failures don't block digestion) ──
    try {
      await this._embedEntries(hash, parsed, writtenEntryIds);
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

    // 3) Mark co-topic entries stale, then delete entries on disk.
    const removedEntryIds = db.deleteEntriesByRawId(rawId);
    if (removedEntryIds.length > 0) {
      db.markCoTopicEntriesStale(removedEntryIds);
    }
    const entriesDir = this.chatService.getKbEntriesDir(hash);
    for (const entryId of removedEntryIds) {
      await fsp.rm(path.join(entriesDir, entryId), { recursive: true, force: true }).catch(() => undefined);
      await fsp.rm(path.join(entriesDir, `${entryId}.md`), { force: true }).catch(() => undefined);
    }

    // 4) Delete raw row (cascades to raw_locations + entry rows).
    db.deleteRaw(rawId);
    return removedEntryIds;
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
  ): Promise<string> {
    try {
      const debugDir = path.join(this.chatService.getKbKnowledgeDir(hash), 'digest-debug');
      await fsp.mkdir(debugDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(debugDir, `${rawId}-${stamp}.txt`);
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
  private _allocateEntryId(db: KbDatabase, rawId: string, slug: string): string {
    const base = `${rawId}-${slug}`;
    if (!db.entryIdTaken(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base}-${n}`;
      if (!db.entryIdTaken(candidate)) return candidate;
    }
    // Extreme fallback — should never happen in practice.
    return `${base}-${Date.now()}`;
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
