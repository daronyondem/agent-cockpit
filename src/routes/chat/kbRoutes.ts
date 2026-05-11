import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { csrfGuard } from '../../middleware/csrf';
import type { ChatService } from '../../services/chatService';
import {
  KbDisabledError,
  KbIngestionService,
  KbLocationConflictError,
  KbRawNotFoundError,
  KbValidationError,
} from '../../services/knowledgeBase/ingestion';
import { KbDigestDisabledError, KbDigestionService } from '../../services/knowledgeBase/digest';
import type { KbDatabase } from '../../services/knowledgeBase/db';
import { KbDreamService } from '../../services/knowledgeBase/dream';
import { detectPandoc } from '../../services/knowledgeBase/pandoc';
import { planDigestChunks } from '../../services/knowledgeBase/chunkPlanner';
import { estimateSourceUnitTextLengths } from '../../services/knowledgeBase/sourceRange';
import { getKbAutoDreamState, validateKbAutoDreamConfig } from '../../services/knowledgeBase/autoDream';
import { checkOllamaHealth } from '../../services/knowledgeBase/embeddings';
import {
  validateKbAutoDigestRequest,
  validateKbEmbeddingConfigRequest,
  validateKbEnabledRequest,
  validateKbFolderCreateRequest,
  validateKbFolderRenameRequest,
  validateKbGlossaryTermRequest,
} from '../../contracts/knowledgeBase';
import { isContractValidationError } from '../../contracts/validation';
import type { KbStateUpdateEvent, NextFunction, Request, Response } from '../../types';
import { logger } from '../../utils/logger';
import { param } from './routeUtils';

const log = logger.child({ module: 'kb-routes' });

export interface KbRoutesOptions {
  chatService: ChatService;
  kbIngestion: KbIngestionService;
  kbDigestion: KbDigestionService;
  kbDreaming: KbDreamService;
  broadcastKbStateUpdate: (hash: string, frame: KbStateUpdateEvent) => void;
}

async function fileSummary(filePath: string): Promise<{ exists: boolean; bytes: number }> {
  try {
    const stat = await fs.promises.stat(filePath);
    return { exists: stat.isFile(), bytes: stat.isFile() ? stat.size : 0 };
  } catch {
    return { exists: false, bytes: 0 };
  }
}

async function listFilesRecursive(root: string, limit = 50): Promise<string[]> {
  const found: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (found.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) break;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(abs);
      } else if (entry.isFile()) {
        found.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  }
  await visit(root);
  return found;
}

export function createKbRouter(opts: KbRoutesOptions): express.Router {
  const { chatService, kbIngestion, kbDigestion, kbDreaming, broadcastKbStateUpdate } = opts;
  const router = express.Router();

  // ── Workspace Knowledge Base ────────────────────────────────────────────────
  // GET returns the KB state snapshot (pipeline counters, folder tree, and a
  // page of raw rows in the currently-focused folder) together with the
  // per-workspace enable flag so the KB Browser can render a single
  // consolidated view. 404 is reserved for "workspace doesn't exist"; an
  // enabled workspace with no files yet returns 200 with an empty snapshot
  // (counters = 0, folders = [root]).
  //
  // Query params:
  //   - folder: virtual folder to scope the raw listing to (default root)
  //   - limit:  page size for the raw listing (default 500)
  //   - offset: page offset for the raw listing (default 0)
  router.get('/workspaces/:hash/kb', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const enabled = await chatService.getWorkspaceKbEnabled(hash);
      const folderParam = typeof req.query.folder === 'string' ? req.query.folder : undefined;
      const limitParam = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const offsetParam = typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined;
      const state = await chatService.getKbStateSnapshot(hash, {
        folderPath: folderParam,
        limit: Number.isFinite(limitParam) ? limitParam : undefined,
        offset: Number.isFinite(offsetParam) ? offsetParam : undefined,
      });
      if (state === null) return res.status(404).json({ error: 'Workspace not found' });
      if (state && kbDreaming.isRunning(hash)) {
        state.dreamingStatus = 'running';
      }
      res.json({ enabled, state });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/kb/enabled', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { enabled } = validateKbEnabledRequest(req.body);
      const hash = param(req, 'hash');
      const result = await chatService.setWorkspaceKbEnabled(hash, enabled);
      if (result === null) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ enabled: result });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB raw-file ingestion ───────────────────────────────────────────────────
  // POST accepts a single file via multipart/form-data under the `file`
  // field, stages it under `knowledge/raw/<rawId>.<ext>`, and kicks off
  // background ingestion on the per-workspace queue. Returns 202 with the
  // initial raw entry (status='ingesting') so the frontend can render the
  // row immediately and swap its badge as `kb_state_update` frames arrive.
  //
  // We use in-memory multer storage because the orchestrator needs the
  // buffer to compute the sha256 rawId *before* deciding where on disk
  // the file belongs. 1 GB comfortably fits real-world PPTX decks and
  // media-heavy PDFs — the conversation-attachment endpoint keeps its
  // own smaller limit since those uploads are a different use case.
  const KB_UPLOAD_LIMIT_GB = 1;
  const kbUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: KB_UPLOAD_LIMIT_GB * 1024 * 1024 * 1024, files: 1 },
  });

  // Multer throws `LIMIT_FILE_SIZE` (and friends) via `next(err)` BEFORE
  // the route handler runs, so an inline try/catch in the handler never
  // sees them — Express's default error handler ends up returning an
  // HTML 500 which the client can't parse. Wrap multer in a shim that
  // converts its errors into proper JSON responses the KB Browser can
  // display to the user.
  const kbUploadMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    kbUpload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `File exceeds the ${KB_UPLOAD_LIMIT_GB} GB upload limit.`
          : err.message;
        res.status(400).json({ error: msg });
        return;
      }
      if (err) {
        res.status(500).json({ error: (err as Error).message });
        return;
      }
      next();
    });
  };

  router.post(
    '/workspaces/:hash/kb/raw',
    csrfGuard,
    kbUploadMiddleware,
    async (req: Request, res: Response) => {
      try {
        const hash = param(req, 'hash');
        const file = (req as unknown as { file?: Express.Multer.File }).file;
        if (!file) return res.status(400).json({ error: 'Missing "file" form field.' });

        // Pre-flight format guards — done here (not in the handler) so the
        // user sees an actionable error immediately instead of a failed
        // ingestion entry sitting in state.db.
        const lowerName = file.originalname.toLowerCase();
        if (lowerName.endsWith('.doc')) {
          return res.status(400).json({
            error:
              'Legacy .doc format is not supported. Please resave the document as .docx in Word or LibreOffice and upload again.',
          });
        }
        if (lowerName.endsWith('.docx')) {
          const pandocStatus = await detectPandoc();
          if (!pandocStatus.available) {
            return res.status(400).json({
              error:
                'DOCX ingestion requires Pandoc, which was not found on the server PATH. ' +
                'Install it from https://pandoc.org/installing.html (or via your package manager: `brew install pandoc`, `apt install pandoc`, `choco install pandoc`) and restart Agent Cockpit.',
            });
          }
        }

        // Virtual folder path is an optional multipart field. Empty string
        // or missing = root. Normalization + segment validation happens
        // inside the orchestrator so the route doesn't duplicate the rules.
        const body = (req as unknown as { body?: Record<string, string> }).body || {};
        const folderPath =
          typeof body.folder === 'string'
            ? body.folder
            : typeof (req.query.folder) === 'string'
              ? (req.query.folder as string)
              : '';

        // Multer gives us the raw bytes on `file.buffer` when using memoryStorage.
        const result = await kbIngestion.enqueueUpload(hash, {
          buffer: file.buffer,
          filename: file.originalname,
          mimeType: file.mimetype || 'application/octet-stream',
          folderPath,
        });
        res.status(202).json(result);
      } catch (err: unknown) {
        if (err instanceof KbDisabledError) {
          return res.status(400).json({ error: err.message });
        }
        if (err instanceof KbLocationConflictError) {
          return res.status(409).json({ error: err.message });
        }
        if (err instanceof KbValidationError) {
          return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  router.delete('/workspaces/:hash/kb/raw/:rawId', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rawId = param(req, 'rawId');
      // `?folder=...&filename=...` scopes the delete to one location
      // and respects ref-counting (other locations + raw row survive).
      // Without those params we purge the raw file entirely.
      const folderParam = typeof req.query.folder === 'string' ? req.query.folder : undefined;
      const filenameParam = typeof req.query.filename === 'string' ? req.query.filename : undefined;
      if (folderParam !== undefined && filenameParam) {
        const removed = await kbIngestion.deleteLocation(hash, rawId, folderParam, filenameParam);
        if (!removed) return res.status(404).json({ error: 'Location not found.' });
        return res.json({ ok: true });
      }
      const removed = await kbIngestion.purgeRaw(hash, rawId);
      if (!removed) return res.status(404).json({ error: 'Raw file not found.' });
      res.json({ ok: true });
    } catch (err: unknown) {
      if (err instanceof KbDisabledError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/kb/structure/backfill', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const force = Boolean((req.body as { force?: unknown } | undefined)?.force);
      const result = await kbIngestion.backfillDocumentStructures(hash, { force });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof KbDisabledError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/kb/raw/:rawId/structure', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rawId = param(req, 'rawId');
      if (!/^[a-f0-9]{1,64}$/i.test(rawId)) {
        return res.status(400).json({ error: 'Invalid rawId.' });
      }
      const result = await kbIngestion.rebuildDocumentStructure(hash, rawId);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof KbDisabledError) {
        return res.status(400).json({ error: err.message });
      }
      if (err instanceof KbRawNotFoundError) {
        return res.status(404).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB auto-digest toggle ───────────────────────────────────────────────────
  // Sets the per-workspace "auto-digest" flag. When true, newly-ingested
  // files are automatically fed through the digestion CLI as soon as
  // conversion completes. When false, the KB Browser exposes a "Digest
  // All Pending" button instead. The flag lives on the workspace index.
  router.put('/workspaces/:hash/kb/auto-digest', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { autoDigest } = validateKbAutoDigestRequest(req.body);
      const hash = param(req, 'hash');
      const result = await chatService.setWorkspaceKbAutoDigest(hash, autoDigest);
      if (result === null) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ autoDigest: result });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/kb/auto-dream', csrfGuard, async (req: Request, res: Response) => {
    try {
      const body = req.body as { autoDream?: unknown };
      const validation = validateKbAutoDreamConfig(body.autoDream ?? req.body);
      if (!validation.config) {
        return res.status(400).json({ error: validation.error || 'Invalid autoDream config' });
      }
      const hash = param(req, 'hash');
      const result = await chatService.setWorkspaceKbAutoDream(hash, validation.config);
      if (result === null) return res.status(404).json({ error: 'Workspace not found' });
      broadcastKbStateUpdate(hash, {
        type: 'kb_state_update',
        updatedAt: new Date().toISOString(),
        changed: { autoDream: true, synthesis: true },
      });
      res.json({ autoDream: result });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB glossary ───────────────────────────────────────────────────────────

  async function openEnabledKbDb(hash: string, res: Response): Promise<KbDatabase | null> {
    const workspacePath = await chatService.getWorkspacePath(hash);
    if (!workspacePath) {
      res.status(404).json({ error: 'Workspace not found' });
      return null;
    }
    const enabled = await chatService.getWorkspaceKbEnabled(hash);
    if (!enabled) {
      res.status(400).json({ error: 'Knowledge Base is not enabled for this workspace.' });
      return null;
    }
    const db = chatService.getKbDb(hash);
    if (!db) {
      res.status(404).json({ error: 'KB database unavailable' });
      return null;
    }
    return db;
  }

  router.get('/workspaces/:hash/kb/glossary', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const db = await openEnabledKbDb(hash, res);
      if (!db) return;
      res.json({ glossary: db.listGlossary() });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/kb/glossary', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { term, expansion } = validateKbGlossaryTermRequest(req.body);
      const hash = param(req, 'hash');
      const db = await openEnabledKbDb(hash, res);
      if (!db) return;
      const row = db.addGlossaryTerm(term, expansion);
      res.status(201).json({ term: row });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      const message = (err as Error).message || String(err);
      if (/UNIQUE constraint failed: kb_glossary\.term/i.test(message)) {
        return res.status(409).json({ error: 'Glossary term already exists' });
      }
      res.status(500).json({ error: message });
    }
  });

  router.put('/workspaces/:hash/kb/glossary/:id', csrfGuard, async (req: Request, res: Response) => {
    try {
      const id = Number(param(req, 'id'));
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: 'Invalid glossary term id' });
      }
      const { term, expansion } = validateKbGlossaryTermRequest(req.body);
      const hash = param(req, 'hash');
      const db = await openEnabledKbDb(hash, res);
      if (!db) return;
      const row = db.updateGlossaryTerm(id, term, expansion);
      if (!row) return res.status(404).json({ error: 'Glossary term not found' });
      res.json({ term: row });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      const message = (err as Error).message || String(err);
      if (/UNIQUE constraint failed: kb_glossary\.term/i.test(message)) {
        return res.status(409).json({ error: 'Glossary term already exists' });
      }
      res.status(500).json({ error: message });
    }
  });

  router.delete('/workspaces/:hash/kb/glossary/:id', csrfGuard, async (req: Request, res: Response) => {
    try {
      const id = Number(param(req, 'id'));
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: 'Invalid glossary term id' });
      }
      const hash = param(req, 'hash');
      const db = await openEnabledKbDb(hash, res);
      if (!db) return;
      if (!db.deleteGlossaryTerm(id)) {
        return res.status(404).json({ error: 'Glossary term not found' });
      }
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB embedding config ─────────────────────────────────────────────────────

  router.get('/workspaces/:hash/kb/embedding-config', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const cfg = await chatService.getWorkspaceKbEmbeddingConfig(hash);
      res.json({ embeddingConfig: cfg ?? null });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/kb/embedding-config', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { model, ollamaHost, dimensions } = validateKbEmbeddingConfigRequest(req.body);
      const hash = param(req, 'hash');
      const result = await chatService.setWorkspaceKbEmbeddingConfig(hash, {
        model, ollamaHost, dimensions,
      });
      if (result === null) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ embeddingConfig: result });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/kb/embedding-health', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const cfg = await chatService.getWorkspaceKbEmbeddingConfig(hash);
      const result = await checkOllamaHealth(cfg);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB digestion ────────────────────────────────────────────────────────────
  // Trigger digestion for a single raw file (manual "Digest now" button).
  // Fire-and-forget: returns 202 immediately; progress is streamed via
  // `kb_state_update` WS frames. Errors land on the raw row's errorClass.
  router.post(
    '/workspaces/:hash/kb/raw/:rawId/digest',
    csrfGuard,
    async (req: Request, res: Response) => {
      try {
        const hash = param(req, 'hash');
        const rawId = param(req, 'rawId');
        kbDigestion.enqueueDigest(hash, rawId).catch((err) => {
          log.error('KB digest failed', { rawId, error: err });
        });
        res.status(202).json({ accepted: true });
      } catch (err: unknown) {
        if (err instanceof KbDigestDisabledError) {
          return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // Trigger digestion for every eligible raw file in the workspace
  // (ingested + pending-delete). Fire-and-forget: returns 202 immediately.
  // The digestion orchestrator emits `kb_state_update` frames with
  // `digestProgress: { done, total, avgMsPerItem, etaMs? }` as the run
  // proceeds (unified across batch, single-file, and auto-digest runs)
  // so the toolbar can render live `N / M — ~X min remaining`.
  router.post('/workspaces/:hash/kb/digest-all', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      kbDigestion.enqueueBatchDigest(hash).catch((err) => {
        log.error('KB digest-all failed', { error: err });
      });
      res.status(202).json({ accepted: true });
    } catch (err: unknown) {
      if (err instanceof KbDigestDisabledError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB entries ──────────────────────────────────────────────────────────────
  // GET /entries returns a paginated list of digested entries with
  // filtering by title substring (`search`), folder, tag(s), rawId, and
  // date ranges on uploaded (raw.uploaded_at) and digested
  // (entries.digested_at) timestamps. Multi-tag filtering uses AND
  // semantics — an entry must carry every tag in the `tags` csv. The
  // response includes a `total` count (pre-pagination) so the UI can
  // render pagination controls.
  router.get('/workspaces/:hash/kb/entries', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const enabled = await chatService.getWorkspaceKbEnabled(hash);
      if (!enabled) return res.json({ entries: [], total: 0 });
      const db = chatService.getKbDb(hash);
      if (!db) return res.json({ entries: [], total: 0 });

      const folder = typeof req.query.folder === 'string' ? req.query.folder : undefined;
      const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
      const tags = typeof req.query.tags === 'string'
        ? req.query.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
        : undefined;
      const rawId = typeof req.query.rawId === 'string' ? req.query.rawId : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const uploadedFrom = typeof req.query.uploadedFrom === 'string' ? req.query.uploadedFrom : undefined;
      const uploadedTo = typeof req.query.uploadedTo === 'string' ? req.query.uploadedTo : undefined;
      const digestedFrom = typeof req.query.digestedFrom === 'string' ? req.query.digestedFrom : undefined;
      const digestedTo = typeof req.query.digestedTo === 'string' ? req.query.digestedTo : undefined;
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined;

      const filter = {
        folderPath: folder,
        tag,
        tags,
        rawId,
        search,
        uploadedFrom,
        uploadedTo,
        digestedFrom,
        digestedTo,
      };
      const entries = db.listEntries({
        ...filter,
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      });
      const total = db.countEntries(filter);
      res.json({ entries, total });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /tags returns every distinct tag in the KB with its entry count,
  // ordered most-used first. Feeds the entries-tab tag picker.
  router.get('/workspaces/:hash/kb/tags', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const enabled = await chatService.getWorkspaceKbEnabled(hash);
      if (!enabled) return res.json({ tags: [] });
      const db = chatService.getKbDb(hash);
      if (!db) return res.json({ tags: [] });
      res.json({ tags: db.listAllTags() });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /entries/:entryId returns a single entry's metadata + full body
  // read from disk. The body is the rendered `entry.md` (YAML frontmatter
  // + markdown) — the UI strips the frontmatter for preview.
  router.get('/workspaces/:hash/kb/entries/:entryId', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const entryId = param(req, 'entryId');
      if (!/^[a-zA-Z0-9_.-]+$/.test(entryId)) {
        return res.status(400).json({ error: 'Invalid entryId.' });
      }
      const db = chatService.getKbDb(hash);
      if (!db) return res.status(404).json({ error: 'KB not enabled' });
      const entry = db.getEntry(entryId);
      if (!entry) return res.status(404).json({ error: 'Entry not found' });
      const entryPath = path.join(chatService.getKbEntriesDir(hash), entryId, 'entry.md');
      let body = '';
      try {
        body = await fs.promises.readFile(entryPath, 'utf8');
      } catch {
        body = '';
      }
      const locations = entry.rawId ? db.listLocations(entry.rawId) : [];
      const sources = db.listEntrySources(entryId);
      res.json({ entry, body, locations, sources });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB folders ──────────────────────────────────────────────────────────────
  // Create a virtual folder. Idempotent — re-creating an existing folder
  // is a no-op and returns 200 with the normalized path.
  router.post('/workspaces/:hash/kb/folders', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const { folderPath } = validateKbFolderCreateRequest(req.body);
      const normalized = await kbIngestion.createFolder(hash, folderPath);
      res.json({ folderPath: normalized });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      if (err instanceof KbDisabledError) return res.status(400).json({ error: err.message });
      if (err instanceof KbValidationError) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Rename a folder subtree in-place. All files under the old path move
  // to the new path via a single raw_locations update (no disk moves).
  router.put('/workspaces/:hash/kb/folders', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const { fromPath, toPath } = validateKbFolderRenameRequest(req.body);
      await kbIngestion.renameFolder(hash, fromPath, toPath);
      res.json({ ok: true });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      if (err instanceof KbDisabledError) return res.status(400).json({ error: err.message });
      if (err instanceof KbValidationError) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Delete a folder subtree. `?cascade=true` removes every location
  // under the subtree (following ref-counted raw delete rules). Without
  // cascade the call errors if the subtree contains any files.
  router.delete('/workspaces/:hash/kb/folders', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const folderPath = typeof req.query.folder === 'string' ? req.query.folder : undefined;
      if (!folderPath) return res.status(400).json({ error: 'folder query parameter is required.' });
      const cascade = req.query.cascade === 'true' || req.query.cascade === '1';
      await kbIngestion.deleteFolder(hash, folderPath, { cascade });
      res.json({ ok: true });
    } catch (err: unknown) {
      if (err instanceof KbDisabledError) return res.status(400).json({ error: err.message });
      if (err instanceof KbValidationError) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:hash/kb/raw/:rawId/trace', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rawId = param(req, 'rawId');
      if (!/^[a-f0-9]{1,64}$/i.test(rawId)) {
        return res.status(400).json({ error: 'Invalid rawId.' });
      }
      const db = await openEnabledKbDb(hash, res);
      if (!db) return;
      const raw = db.getRawById(rawId);
      if (!raw) return res.status(404).json({ error: 'Raw file not found.' });

      let metadata: Record<string, unknown> | null = null;
      if (raw.metadata_json) {
        try {
          metadata = JSON.parse(raw.metadata_json) as Record<string, unknown>;
        } catch {
          metadata = null;
        }
      }

      const convertedDir = path.join(chatService.getKbConvertedDir(hash), rawId);
      const textMd = await fileSummary(path.join(convertedDir, 'text.md'));
      const metaJson = await fileSummary(path.join(convertedDir, 'meta.json'));
      const convertedFiles = await listFilesRecursive(convertedDir, 200);
      const mediaFiles = convertedFiles.filter((file) => file !== 'text.md' && file !== 'meta.json');

      const document = db.getDocument(rawId);
      const nodes = document ? db.listDocumentNodes(rawId) : [];
      let unitTextLengths: Record<number, number> | undefined;
      if (document && textMd.exists) {
        try {
          const convertedText = await fs.promises.readFile(path.join(convertedDir, 'text.md'), 'utf8');
          const documentUnitCount = Math.max(
            document.unitCount,
            nodes.reduce((max, node) => Math.max(max, node.endUnit), 0),
          );
          unitTextLengths = estimateSourceUnitTextLengths(convertedText, document.unitType, documentUnitCount);
        } catch {
          unitTextLengths = undefined;
        }
      }
      const chunks = document
        ? planDigestChunks(document, nodes, { unitTextLengths }).map((chunk) => ({
          chunkId: chunk.chunkId,
          nodeIds: chunk.nodeIds,
          startUnit: chunk.startUnit,
          endUnit: chunk.endUnit,
          estimatedTokens: chunk.estimatedTokens,
          reason: chunk.reason,
        }))
        : [];

      const entries = db.listEntries({ rawId, limit: 1000 });
      const entryDetails = entries.map((entry) => ({
        entryId: entry.entryId,
        title: entry.title,
        summary: entry.summary,
        digestedAt: entry.digestedAt,
        tags: entry.tags,
        sources: db.listEntrySources(entry.entryId),
      }));
      const sourceChunkIds = new Set(
        entryDetails.flatMap((entry) => entry.sources.map((source) => source.chunkId)),
      );

      const topicMap = new Map<string, { topicId: string; title: string; summary: string | null; entryIds: Set<string> }>();
      for (const entry of entries) {
        for (const topicId of db.listEntryTopicIds(entry.entryId)) {
          const topic = db.getTopic(topicId);
          const existing = topicMap.get(topicId) ?? {
            topicId,
            title: topic?.title ?? topicId,
            summary: topic?.summary ?? null,
            entryIds: new Set<string>(),
          };
          existing.entryIds.add(entry.entryId);
          topicMap.set(topicId, existing);
        }
      }

      const embeddingCfg = await chatService.getWorkspaceKbEmbeddingConfig(hash);
      let embeddings: {
        configured: boolean;
        entryEmbeddedCount: number | null;
        entryTotal: number;
        topicEmbeddedCount: number | null;
        topicTotal: number;
      } = {
        configured: Boolean(embeddingCfg),
        entryEmbeddedCount: null,
        entryTotal: entries.length,
        topicEmbeddedCount: null,
        topicTotal: topicMap.size,
      };
      if (embeddingCfg) {
        try {
          const resolvedDimensions = embeddingCfg.dimensions ?? 768;
          const store = await chatService.getKbVectorStore(hash, resolvedDimensions);
          if (store) {
            const embeddedEntryIds = await store.embeddedEntryIds();
            const embeddedTopicIds = await store.embeddedTopicIds();
            embeddings = {
              configured: true,
              entryEmbeddedCount: entries.filter((entry) => embeddedEntryIds.has(entry.entryId)).length,
              entryTotal: entries.length,
              topicEmbeddedCount: [...topicMap.keys()].filter((topicId) => embeddedTopicIds.has(topicId)).length,
              topicTotal: topicMap.size,
            };
          }
        } catch {
          embeddings = { ...embeddings, configured: true };
        }
      }

      const digestDebugFiles = (await listFilesRecursive(
        path.join(chatService.getKbKnowledgeDir(hash), 'digest-debug'),
        200,
      )).filter((file) => file.startsWith(rawId));

      res.json({
        raw: {
          rawId: raw.raw_id,
          sha256: raw.sha256,
          status: raw.status,
          byteLength: raw.byte_length,
          mimeType: raw.mime_type,
          handler: raw.handler,
          uploadedAt: raw.uploaded_at,
          digestedAt: raw.digested_at,
          errorClass: raw.error_class,
          errorMessage: raw.error_message,
          metadata,
        },
        locations: db.listLocations(rawId),
        converted: {
          textMd,
          metaJson,
          mediaCount: mediaFiles.length,
          mediaFiles: mediaFiles.slice(0, 50),
        },
        structure: document ? {
          document,
          nodeCount: nodes.length,
          nodes: nodes.slice(0, 100),
        } : null,
        chunks: chunks.map((chunk) => ({
          ...chunk,
          digested: sourceChunkIds.has(chunk.chunkId),
        })),
        digestion: {
          status: raw.status,
          digestedAt: raw.digested_at,
          entryCount: entries.length,
        },
        entries: entryDetails,
        embeddings,
        topics: [...topicMap.values()].map((topic) => ({
          topicId: topic.topicId,
          title: topic.title,
          summary: topic.summary,
          entryIds: [...topic.entryIds].sort(),
        })),
        debug: {
          digestDumps: digestDebugFiles,
        },
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Stream the original bytes back for the Raw tab preview. We sanitize
  // the rawId against a hex character class to prevent path traversal —
  // the ingestion path already guarantees this shape, but belt-and-braces
  // here because this endpoint reads from disk and returns whatever it
  // finds under the safely-joined path.
  router.get('/workspaces/:hash/kb/raw/:rawId', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rawId = param(req, 'rawId');
      if (!/^[a-f0-9]{1,64}$/i.test(rawId)) {
        return res.status(400).json({ error: 'Invalid rawId.' });
      }
      const diskPath = await chatService.getKbRawFilePath(hash, rawId);
      if (!diskPath) return res.status(404).json({ error: 'Raw file not found.' });
      // Confirm the resolved path is still inside the workspace KB dir —
      // defense in depth against a path that somehow escapes.
      const rawDir = path.resolve(chatService.getKbRawDir(hash));
      if (!path.resolve(diskPath).startsWith(rawDir)) {
        return res.status(400).json({ error: 'Invalid path.' });
      }
      try {
        await fs.promises.access(diskPath);
      } catch {
        return res.status(404).json({ error: 'Raw file not found on disk.' });
      }
      res.sendFile(path.resolve(diskPath));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Serve a media file produced by ingestion under `converted/<rawId>/`.
  // Entry bodies reference embedded images / extracted slides / rasterized
  // pages with relative paths like `media/Slide123.jpg` or
  // `slides/slide-001.png`, all rooted at the per-raw converted directory.
  // The frontend rewrites those into URLs that hit this endpoint.
  router.get('/workspaces/:hash/kb/raw/:rawId/media/:mediapath(*)', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rawId = param(req, 'rawId');
      if (!/^[a-f0-9]{1,64}$/i.test(rawId)) {
        return res.status(400).json({ error: 'Invalid rawId.' });
      }
      const relPath = decodeURIComponent(param(req, 'mediapath') || '');
      if (!relPath) return res.status(400).json({ error: 'media path required' });
      // Reject any segment that would escape the rawId directory. The
      // resolve-and-startsWith check below is the real guard, but keep this
      // as a fast, explicit rejection for traversal attempts.
      if (relPath.split(/[\\/]+/).some((seg) => seg === '..')) {
        return res.status(400).json({ error: 'Invalid path.' });
      }
      const rawDir = path.resolve(chatService.getKbConvertedDir(hash), rawId);
      const diskPath = path.resolve(rawDir, relPath);
      if (!diskPath.startsWith(rawDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid path.' });
      }
      try {
        await fs.promises.access(diskPath);
      } catch {
        return res.status(404).json({ error: 'Media file not found.' });
      }
      res.sendFile(diskPath);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB Dreaming / Synthesis ────────────────────────────────────────────────

  // Start an incremental dreaming run. Returns 202 immediately; the run
  // progresses in the background with WS frames for progress.
  router.post('/workspaces/:hash/kb/dream', csrfGuard, async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    try {
      if (kbDreaming.isRunning(hash)) {
        res.status(409).json({ error: 'A dreaming run is already in progress.' });
        return;
      }
      const dreamDb = chatService.getKbDb(hash);
      if (dreamDb && dreamDb.countNeedsSynthesis() === 0) {
        res.status(400).json({ error: 'No entries pending synthesis. Upload and digest files first.' });
        return;
      }
      // Fire and forget — the service manages its own status in the DB.
      kbDreaming.dream(hash).catch((err) => {
        log.error('KB incremental dreaming run failed', { workspace: hash, error: err });
      });
      res.status(202).json({ ok: true, mode: 'incremental' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Wipe all synthesis and run a full rebuild.
  router.post('/workspaces/:hash/kb/redream', csrfGuard, async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    try {
      if (kbDreaming.isRunning(hash)) {
        res.status(409).json({ error: 'A dreaming run is already in progress.' });
        return;
      }
      const redreamDb = chatService.getKbDb(hash);
      if (redreamDb && redreamDb.getCounters().entryCount === 0) {
        res.status(400).json({ error: 'No entries to rebuild. Upload and digest files first.' });
        return;
      }
      kbDreaming.redream(hash).catch((err) => {
        log.error('KB full dreaming rebuild failed', { workspace: hash, error: err });
      });
      res.status(202).json({ ok: true, mode: 'full-rebuild' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Cooperatively stop an in-progress dream run. Honored at the next
  // batch/phase boundary; already-committed work is preserved. Returns 404
  // if no run is in progress.
  router.post('/workspaces/:hash/kb/dream/stop', csrfGuard, async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    try {
      if (!kbDreaming.isRunning(hash)) {
        res.status(404).json({ ok: false, error: 'No dreaming run in progress.' });
        return;
      }
      kbDreaming.requestStop(hash);
      res.json({ ok: true, stopping: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Synthesis state: topics, connections, status for the KB Browser synthesis tab.
  router.get('/workspaces/:hash/kb/synthesis', async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    try {
      const db = chatService.getKbDb(hash);
      if (!db) {
        res.status(404).json({ error: 'Knowledge Base not found.' });
        return;
      }
      const snapshot = db.getSynthesisSnapshot();
      const status = kbDreaming.isRunning(hash) ? 'running' : snapshot.status;
      const autoDream = await chatService.getWorkspaceKbAutoDream(hash);
      const topics = db.listTopics();
      const connections = db.listAllConnections();
      const godNodes = new Set(snapshot.godNodes);

      res.json({
        status,
        stopping: kbDreaming.isStopRequested(hash),
        lastRunAt: snapshot.lastRunAt,
        lastRunError: snapshot.lastRunError,
        topicCount: snapshot.topicCount,
        connectionCount: snapshot.connectionCount,
        needsSynthesisCount: snapshot.needsSynthesisCount,
        godNodes: snapshot.godNodes,
        dreamProgress: snapshot.dreamProgress,
        reflectionCount: snapshot.reflectionCount,
        staleReflectionCount: snapshot.staleReflectionCount,
        autoDream: getKbAutoDreamState(autoDream, snapshot.lastRunAt),
        topics: topics.map((t) => ({
          topicId: t.topicId,
          title: t.title,
          summary: t.summary,
          entryCount: t.entryCount,
          connectionCount: t.connectionCount,
          isGodNode: godNodes.has(t.topicId),
        })),
        connections: connections.map((c) => ({
          sourceTopic: c.sourceTopic,
          targetTopic: c.targetTopic,
          relationship: c.relationship,
          confidence: c.confidence,
        })),
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Single topic detail: prose + entries + connections.
  router.get('/workspaces/:hash/kb/synthesis/:topicId', async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    const topicId = param(req, 'topicId');
    try {
      const db = chatService.getKbDb(hash);
      if (!db) {
        res.status(404).json({ error: 'Knowledge Base not found.' });
        return;
      }
      const topic = db.getTopic(topicId);
      if (!topic) {
        res.status(404).json({ error: `Topic "${topicId}" not found.` });
        return;
      }
      const godNodesRaw = db.getSynthesisMeta('god_nodes');
      const godNodes: string[] = godNodesRaw ? JSON.parse(godNodesRaw) : [];

      const entryIds = db.listTopicEntryIds(topicId);
      const entries = entryIds
        .map((eid) => db.getEntry(eid))
        .filter((e) => e !== null);

      const connections = db.listConnectionsForTopic(topicId).map((c) => ({
        sourceTopic: c.sourceTopic,
        targetTopic: c.targetTopic,
        relationship: c.relationship,
        confidence: c.confidence,
      }));

      res.json({
        topicId: topic.topicId,
        title: topic.title,
        summary: topic.summary,
        content: topic.content,
        updatedAt: topic.updatedAt,
        entryCount: topic.entryCount,
        connectionCount: topic.connectionCount,
        isGodNode: godNodes.includes(topicId),
        entries,
        connections,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB Reflections ──────────────────────────────────────────────────────

  // List all reflections with stale detection.
  router.get('/workspaces/:hash/kb/reflections', async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    try {
      const db = chatService.getKbDb(hash);
      if (!db) {
        res.status(404).json({ error: 'Knowledge Base not found.' });
        return;
      }
      const reflections = db.listReflections();
      const staleIds = new Set(db.listStaleReflectionIds());

      res.json({
        reflections: reflections.map((r) => ({
          reflectionId: r.reflectionId,
          title: r.title,
          type: r.type,
          summary: r.summary,
          citationCount: r.citationCount,
          createdAt: r.createdAt,
          isStale: staleIds.has(r.reflectionId),
        })),
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Single reflection detail: full content + cited entries.
  router.get('/workspaces/:hash/kb/reflections/:reflectionId', async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    const reflectionId = param(req, 'reflectionId');
    try {
      const db = chatService.getKbDb(hash);
      if (!db) {
        res.status(404).json({ error: 'Knowledge Base not found.' });
        return;
      }
      const detail = db.getReflection(reflectionId);
      if (!detail) {
        res.status(404).json({ error: `Reflection "${reflectionId}" not found.` });
        return;
      }
      // Resolve cited entry metadata.
      const citedEntries = detail.citedEntryIds
        .map((eid) => db.getEntry(eid))
        .filter((e) => e !== null);

      res.json({
        reflectionId: detail.reflectionId,
        title: detail.title,
        type: detail.type,
        summary: detail.summary,
        content: detail.content,
        createdAt: detail.createdAt,
        citationCount: detail.citationCount,
        citedEntries,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });


  return router;
}
