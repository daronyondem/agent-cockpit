import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { csrfGuard } from '../../middleware/csrf';
import { attachmentFromPath, type ChatService } from '../../services/chatService';
import type { BackendRegistry } from '../../services/backends/registry';
import { validateAttachmentOcrRequest } from '../../contracts/uploads';
import { isContractValidationError } from '../../contracts/validation';
import type { Request, Response } from '../../types';
import { logger } from '../../utils/logger';
import { isCliProfileResolutionError, param } from './routeUtils';

const log = logger.child({ module: 'chat-upload-routes' });

export interface UploadRoutesOptions {
  chatService: ChatService;
  backendRegistry: BackendRegistry;
}

export function createUploadRouter(opts: UploadRoutesOptions): express.Router {
  const { chatService, backendRegistry } = opts;
  const router = express.Router();

  const upload = multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        const id = (_req as Request).params.id;
        const dir = path.join(chatService.artifactsDir, Array.isArray(id) ? id[0] : id);
        await fs.promises.mkdir(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const safe = file.originalname.replace(/[\/\\]/g, '_');
        cb(null, safe);
      },
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  router.post('/conversations/:id/upload', csrfGuard, upload.array('files', 10), (req: Request, res: Response) => {
    const files = ((req as unknown as { files?: Express.Multer.File[] }).files || []).map((f) => {
      const meta = attachmentFromPath(f.path, f.size);
      return {
        name: meta.name,
        path: meta.path,
        size: meta.size,
        kind: meta.kind,
        meta: meta.meta,
      };
    });
    res.json({ files });
  });

  router.get('/conversations/:id/files/:filename', async (req: Request, res: Response) => {
    const safe = param(req, 'filename').replace(/[\/\\]/g, '_');
    const filePath = path.join(chatService.artifactsDir, param(req, 'id'), safe);
    if (!path.resolve(filePath).startsWith(path.resolve(chatService.artifactsDir))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    try {
      await fs.promises.access(filePath);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }
    const mode = (req.query.mode as string) || '';
    if (mode === 'view') {
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size > 2 * 1024 * 1024) {
          return res.status(413).json({ error: 'File too large to view (max 2 MB). Use download instead.' });
        }
        const content = await fs.promises.readFile(filePath, 'utf8');
        const ext = path.extname(safe).replace('.', '');
        return res.json({ content, filename: safe, language: ext });
      } catch (err: unknown) {
        return res.status(500).json({ error: (err as Error).message });
      }
    }
    if (mode === 'download') {
      res.setHeader('Content-Disposition', `attachment; filename="${safe.replace(/"/g, '\\"')}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      return fs.createReadStream(filePath).pipe(res);
    }
    res.sendFile(path.resolve(filePath));
  });

  router.delete('/conversations/:id/upload/:filename', csrfGuard, async (req: Request, res: Response) => {
    const safe = param(req, 'filename').replace(/[\/\\]/g, '_');
    const filePath = path.join(chatService.artifactsDir, param(req, 'id'), safe);
    if (!path.resolve(filePath).startsWith(path.resolve(chatService.artifactsDir))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    try {
      await fs.promises.unlink(filePath);
      res.json({ ok: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });

  router.post('/conversations/:id/attachments/ocr', csrfGuard, async (req: Request, res: Response) => {
    const convId = param(req, 'id');
    let attachmentPath: string;
    try {
      ({ path: attachmentPath } = validateAttachmentOcrRequest(req.body));
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const convDir = path.resolve(path.join(chatService.artifactsDir, convId));
    const resolved = path.resolve(attachmentPath);
    if (resolved !== convDir && !resolved.startsWith(convDir + path.sep)) {
      return res.status(400).json({ error: 'Invalid attachment path' });
    }

    try {
      await fs.promises.access(resolved);
    } catch {
      return res.status(404).json({ error: 'Attachment not found' });
    }
    const meta = attachmentFromPath(resolved);
    if (meta.kind !== 'image') {
      return res.status(400).json({ error: 'OCR is only supported for image attachments' });
    }

    const conv = await chatService.getConversation(convId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    let runtime: Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>>;
    try {
      runtime = await chatService.resolveCliProfileRuntime(conv.cliProfileId, conv.backend);
    } catch (err: unknown) {
      if (isCliProfileResolutionError(err)) {
        return res.status(400).json({ error: (err as Error).message });
      }
      throw err;
    }
    const backendId = runtime.backendId;
    const adapter = backendRegistry.get(backendId);
    if (!adapter) {
      return res.status(500).json({ error: `Backend not registered: ${backendId}` });
    }

    const prompt = [
      `Read the image at ${resolved} and convert its contents to clean Markdown.`,
      'Preserve structure — use headings for headings, lists for lists, and proper Markdown tables (| col | col | with a |---|---| separator) for any tabular data.',
      'If the image contains diagrams or non-text visuals you cannot transcribe, briefly note them in italics (e.g. *[diagram: network topology]*).',
      'Output only the Markdown. No preamble, no commentary, no fenced code wrapper around the whole thing.',
    ].join(' ');

    try {
      const markdown = await adapter.runOneShot(prompt, {
        model: conv.model || undefined,
        effort: conv.effort || undefined,
        timeoutMs: 90_000,
        allowTools: true,
        workingDir: conv.workingDir || undefined,
        cliProfile: runtime.profile,
        serviceTier: conv.serviceTier || undefined,
      });
      const cleaned = (markdown || '').trim();
      if (!cleaned) {
        return res.status(502).json({ error: 'OCR returned empty output' });
      }
      res.json({ markdown: cleaned });
    } catch (err: unknown) {
      log.error('Attachment OCR failed', { backendId, convId, error: err });
      return res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:hash/files', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const filePath = req.query.path as string | undefined;
      const mode = (req.query.mode as string) || 'download';

      if (!filePath) {
        return res.status(400).json({ error: 'path query parameter is required' });
      }

      const workspacePath = await chatService.getWorkspacePath(hash);
      if (!workspacePath) {
        return res.status(404).json({ error: 'Workspace not found' });
      }

      const resolved = path.resolve(filePath);
      const wsRoot = path.resolve(workspacePath);
      if (!resolved.startsWith(wsRoot + path.sep) && resolved !== wsRoot) {
        return res.status(403).json({ error: 'Access denied: path is outside workspace' });
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        return res.status(404).json({ error: 'File not found' });
      }
      if (!stat.isFile()) {
        return res.status(400).json({ error: 'Path is not a file' });
      }

      const filename = path.basename(resolved);

      if (mode === 'view') {
        if (stat.size > 2 * 1024 * 1024) {
          return res.status(413).json({ error: 'File too large to view (max 2 MB). Use download instead.' });
        }
        const content = fs.readFileSync(resolved, 'utf8');
        const ext = path.extname(filename).replace('.', '');
        return res.json({ content, filename, language: ext });
      }

      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '\\"')}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      fs.createReadStream(resolved).pipe(res);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
