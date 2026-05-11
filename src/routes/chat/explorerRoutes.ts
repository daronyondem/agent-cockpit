import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { csrfGuard } from '../../middleware/csrf';
import type { ChatService } from '../../services/chatService';
import {
  validateExplorerCreateFileRequest,
  validateExplorerMkdirRequest,
  validateExplorerRenameRequest,
  validateExplorerSaveFileRequest,
} from '../../contracts/explorer';
import { isContractValidationError } from '../../contracts/validation';
import type { Request, Response, NextFunction } from '../../types';
import { param } from './routeUtils';

type ResolveOk = { ok: true; abs: string; root: string };
type ResolveErr = { ok: false; status: number; error: string };

const EXPLORER_TEXT_VIEW_LIMIT = 5 * 1024 * 1024;
const EXPLORER_UPLOAD_LIMIT = 500 * 1024 * 1024;

export function createExplorerRouter(chatService: ChatService): express.Router {
  const router = express.Router();

  async function resolveExplorerPath(hash: string, relPath: string): Promise<ResolveOk | ResolveErr> {
    const wsRoot = await chatService.getWorkspacePath(hash);
    if (!wsRoot) return { ok: false, status: 404, error: 'Workspace not found' };
    const root = path.resolve(wsRoot);
    const rel = (relPath || '').replace(/^[/\\]+/, '');
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return { ok: false, status: 403, error: 'Access denied: path is outside workspace' };
    }
    return { ok: true, abs, root };
  }

  router.get('/workspaces/:hash/explorer/tree', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rel = (req.query.path as string) || '';
      const r = await resolveExplorerPath(hash, rel);
      if (!r.ok) return res.status(r.status).json({ error: r.error });

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(r.abs);
      } catch {
        return res.status(404).json({ error: 'Directory not found' });
      }
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }

      let dirents: fs.Dirent[];
      try {
        dirents = await fs.promises.readdir(r.abs, { withFileTypes: true });
      } catch {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const entries = await Promise.all(dirents.map(async (d) => {
        const abs = path.join(r.abs, d.name);
        let size = 0;
        let mtime = 0;
        try {
          const s = await fs.promises.stat(abs);
          size = s.size;
          mtime = s.mtimeMs;
        } catch { /* broken symlinks etc */ }
        return {
          name: d.name,
          type: d.isDirectory() ? 'dir' : 'file',
          size,
          mtime,
        };
      }));

      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      const relPath = path.relative(r.root, r.abs);
      const parent = r.abs === r.root ? null : path.relative(r.root, path.dirname(r.abs));
      res.json({
        path: relPath,
        parent,
        entries,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:hash/explorer/preview', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rel = req.query.path as string | undefined;
      const mode = (req.query.mode as string) || 'view';
      if (!rel) return res.status(400).json({ error: 'path query parameter is required' });

      const r = await resolveExplorerPath(hash, rel);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      if (r.abs === r.root) return res.status(400).json({ error: 'Path must be a file' });

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(r.abs);
      } catch {
        return res.status(404).json({ error: 'File not found' });
      }
      if (!stat.isFile()) return res.status(400).json({ error: 'Path is not a file' });

      const filename = path.basename(r.abs);
      const mimeType = explorerMimeType(filename);

      if (mode === 'view') {
        if (stat.size > EXPLORER_TEXT_VIEW_LIMIT) {
          return res.status(413).json({ error: 'File too large to preview (max 5 MB). Use download.', size: stat.size });
        }
        const content = await fs.promises.readFile(r.abs, 'utf8');
        const ext = path.extname(filename).replace('.', '');
        return res.json({ content, filename, language: ext, mimeType, size: stat.size });
      }

      if (mode === 'download') {
        res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '\\"')}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
      } else {
        res.setHeader('Content-Type', mimeType);
      }
      res.setHeader('Content-Length', String(stat.size));
      fs.createReadStream(r.abs).pipe(res);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const explorerUpload = multer({
    storage: multer.diskStorage({
      destination: (req: express.Request, _file: Express.Multer.File, cb: (err: Error | null, dir: string) => void) => {
        const abs = (req as unknown as { _explorerTargetAbs?: string })._explorerTargetAbs;
        if (!abs) return cb(new Error('Target directory not resolved'), '');
        cb(null, abs);
      },
      filename: (_req: express.Request, file: Express.Multer.File, cb: (err: Error | null, name: string) => void) => {
        const safe = file.originalname.replace(/[/\\]/g, '_');
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        cb(null, `.ac-upload-${nonce}-${safe}`);
      },
    }),
    limits: { fileSize: EXPLORER_UPLOAD_LIMIT, files: 1 },
  });

  const explorerUploadPrelude = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const hash = param(req, 'hash');
      const rel = (req.query.path as string) || '';
      const r = await resolveExplorerPath(hash, rel);
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(r.abs);
      } catch {
        res.status(404).json({ error: 'Target folder not found' });
        return;
      }
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Target path is not a directory' });
        return;
      }
      (req as unknown as { _explorerTargetAbs?: string; _explorerRoot?: string })._explorerTargetAbs = r.abs;
      (req as unknown as { _explorerRoot?: string })._explorerRoot = r.root;
      next();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  };

  const explorerUploadMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    explorerUpload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `File exceeds the ${Math.floor(EXPLORER_UPLOAD_LIMIT / 1024 / 1024)} MB upload limit.`
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

  router.post('/workspaces/:hash/explorer/upload', csrfGuard, explorerUploadPrelude, explorerUploadMiddleware, async (req: Request, res: Response) => {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    const targetDir = (req as unknown as { _explorerTargetAbs?: string })._explorerTargetAbs;
    if (!file || !targetDir) return res.status(400).json({ error: 'Missing file or target directory' });

    const overwrite = req.query.overwrite === 'true' || req.query.overwrite === '1';
    const finalName = file.originalname.replace(/[/\\]/g, '_');
    if (!finalName || finalName === '.' || finalName === '..') {
      await fs.promises.unlink(file.path).catch(() => {});
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const finalPath = path.join(targetDir, finalName);

    try {
      const exists = await fs.promises.stat(finalPath).then(() => true, () => false);
      if (exists && !overwrite) {
        await fs.promises.unlink(file.path).catch(() => {});
        return res.status(409).json({ error: 'File already exists', conflict: true, filename: finalName });
      }
      await fs.promises.rename(file.path, finalPath);
      const s = await fs.promises.stat(finalPath);
      res.json({ name: finalName, size: s.size, overwrote: exists });
    } catch (err: unknown) {
      await fs.promises.unlink(file.path).catch(() => {});
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.patch('/workspaces/:hash/explorer/rename', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const { from, to, overwrite } = validateExplorerRenameRequest(req.body);
      const fromRes = await resolveExplorerPath(hash, from);
      if (!fromRes.ok) return res.status(fromRes.status).json({ error: fromRes.error });
      const toRes = await resolveExplorerPath(hash, to);
      if (!toRes.ok) return res.status(toRes.status).json({ error: toRes.error });
      if (fromRes.abs === fromRes.root) return res.status(400).json({ error: 'Cannot rename workspace root' });
      if (toRes.abs === toRes.root) return res.status(400).json({ error: 'Cannot overwrite workspace root' });
      if (fromRes.abs === toRes.abs) return res.json({ ok: true, unchanged: true });

      try {
        await fs.promises.access(fromRes.abs);
      } catch {
        return res.status(404).json({ error: 'Source not found' });
      }

      const targetExists = await fs.promises.stat(toRes.abs).then(() => true, () => false);
      if (targetExists && !overwrite) {
        return res.status(409).json({ error: 'Destination already exists', conflict: true });
      }
      if (targetExists && overwrite) {
        await fs.promises.rm(toRes.abs, { recursive: true, force: true });
      }

      await fs.promises.mkdir(path.dirname(toRes.abs), { recursive: true });
      await fs.promises.rename(fromRes.abs, toRes.abs);
      res.json({ ok: true });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/explorer/mkdir', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const { parent, name } = validateExplorerMkdirRequest(req.body);
      const trimmed = name.trim();
      if (/[/\\]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
        return res.status(400).json({ error: 'Invalid folder name' });
      }
      const parentRes = await resolveExplorerPath(hash, parent);
      if (!parentRes.ok) return res.status(parentRes.status).json({ error: parentRes.error });

      let parentStat: fs.Stats;
      try {
        parentStat = await fs.promises.stat(parentRes.abs);
      } catch {
        return res.status(404).json({ error: 'Parent folder not found' });
      }
      if (!parentStat.isDirectory()) {
        return res.status(400).json({ error: 'Parent path is not a directory' });
      }

      const targetAbs = path.join(parentRes.abs, trimmed);
      if (!targetAbs.startsWith(parentRes.root + path.sep) && targetAbs !== parentRes.root) {
        return res.status(403).json({ error: 'Access denied: path is outside workspace' });
      }

      const existing = await fs.promises.stat(targetAbs).then((s) => s, () => null);
      if (existing) {
        return res.status(409).json({ error: 'A file or folder with this name already exists' });
      }

      await fs.promises.mkdir(targetAbs);
      const relPath = path.relative(parentRes.root, targetAbs);
      res.json({ ok: true, path: relPath, name: trimmed });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/explorer/file', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const { parent, name, content } = validateExplorerCreateFileRequest(req.body);
      const trimmed = name.trim();
      if (/[/\\]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
        return res.status(400).json({ error: 'Invalid file name' });
      }
      const byteLength = Buffer.byteLength(content, 'utf8');
      if (byteLength > EXPLORER_TEXT_VIEW_LIMIT) {
        return res.status(413).json({ error: `Content exceeds the ${Math.floor(EXPLORER_TEXT_VIEW_LIMIT / 1024 / 1024)} MB edit limit.` });
      }

      const parentRes = await resolveExplorerPath(hash, parent);
      if (!parentRes.ok) return res.status(parentRes.status).json({ error: parentRes.error });

      let parentStat: fs.Stats;
      try {
        parentStat = await fs.promises.stat(parentRes.abs);
      } catch {
        return res.status(404).json({ error: 'Parent folder not found' });
      }
      if (!parentStat.isDirectory()) {
        return res.status(400).json({ error: 'Parent path is not a directory' });
      }

      const targetAbs = path.join(parentRes.abs, trimmed);
      if (!targetAbs.startsWith(parentRes.root + path.sep) && targetAbs !== parentRes.root) {
        return res.status(403).json({ error: 'Access denied: path is outside workspace' });
      }

      const existing = await fs.promises.stat(targetAbs).then((s) => s, () => null);
      if (existing) {
        return res.status(409).json({ error: 'A file or folder with this name already exists' });
      }

      await fs.promises.writeFile(targetAbs, content, 'utf8');
      const s = await fs.promises.stat(targetAbs);
      const relPath = path.relative(parentRes.root, targetAbs);
      res.json({ ok: true, path: relPath, name: trimmed, size: s.size });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/explorer/file', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const { path: rel, content } = validateExplorerSaveFileRequest(req.body);
      const byteLength = Buffer.byteLength(content, 'utf8');
      if (byteLength > EXPLORER_TEXT_VIEW_LIMIT) {
        return res.status(413).json({ error: `Content exceeds the ${Math.floor(EXPLORER_TEXT_VIEW_LIMIT / 1024 / 1024)} MB edit limit.` });
      }

      const r = await resolveExplorerPath(hash, rel);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      if (r.abs === r.root) return res.status(400).json({ error: 'Path must be a file' });

      let stat: fs.Stats | null = null;
      try {
        stat = await fs.promises.stat(r.abs);
      } catch {
        return res.status(404).json({ error: 'File not found' });
      }
      if (!stat.isFile()) {
        return res.status(400).json({ error: 'Path is not a file' });
      }

      await fs.promises.writeFile(r.abs, content, 'utf8');
      const s = await fs.promises.stat(r.abs);
      res.json({ ok: true, size: s.size, mtime: s.mtimeMs });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/workspaces/:hash/explorer/entry', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rel = req.query.path as string | undefined;
      if (!rel) return res.status(400).json({ error: 'path query parameter is required' });
      const r = await resolveExplorerPath(hash, rel);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      if (r.abs === r.root) return res.status(400).json({ error: 'Cannot delete workspace root' });

      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(r.abs);
      } catch {
        return res.status(404).json({ error: 'Not found' });
      }
      if (stat.isDirectory()) {
        await fs.promises.rm(r.abs, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(r.abs);
      }
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

function explorerMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
    '.json': 'application/json', '.xml': 'application/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
    '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.ts': 'application/typescript', '.tsx': 'application/typescript', '.jsx': 'application/javascript',
    '.py': 'text/x-python', '.sh': 'application/x-sh', '.go': 'text/x-go', '.rs': 'text/x-rust',
    '.java': 'text/x-java', '.c': 'text/x-c', '.cpp': 'text/x-c++', '.h': 'text/x-c',
    '.log': 'text/plain', '.ini': 'text/plain', '.conf': 'text/plain', '.env': 'text/plain',
    '.sql': 'application/sql',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}
