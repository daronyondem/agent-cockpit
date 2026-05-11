import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { csrfGuard } from '../../middleware/csrf';
import type { Request, Response } from '../../types';

export function createFilesystemRouter(): express.Router {
  const router = express.Router();

  router.get('/browse', (req: Request, res: Response) => {
    try {
      const dirPath = (req.query.path as string) || os.homedir();
      const showHidden = req.query.showHidden === 'true';

      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved)) {
        return res.status(400).json({ error: 'Path does not exist' });
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(resolved, { withFileTypes: true });
      } catch {
        return res.status(403).json({ error: 'Permission denied: ' + resolved });
      }
      let dirs: string[] = [];
      for (const entry of entries) {
        try {
          if (entry.isDirectory()) dirs.push(entry.name);
        } catch {
          // Skip entries that cannot be stat'd.
        }
      }
      dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      if (!showHidden) {
        dirs = dirs.filter((dir) => !dir.startsWith('.'));
      }
      res.json({
        currentPath: resolved,
        parent: path.dirname(resolved) !== resolved ? path.dirname(resolved) : null,
        dirs,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/mkdir', csrfGuard, (req: Request, res: Response) => {
    try {
      const { parentPath, name } = req.body as { parentPath?: string; name?: string };
      if (!parentPath || !name) {
        return res.status(400).json({ error: 'parentPath and name are required' });
      }
      if (/[/\\]/.test(name) || name === '.' || name === '..') {
        return res.status(400).json({ error: 'Invalid folder name' });
      }
      const parent = path.resolve(parentPath);
      const fullPath = path.resolve(parent, name);
      if (path.dirname(fullPath) !== parent) {
        return res.status(400).json({ error: 'Invalid folder name' });
      }
      if (fs.existsSync(fullPath)) {
        return res.status(409).json({ error: 'Folder already exists' });
      }
      try {
        fs.mkdirSync(fullPath);
      } catch {
        return res.status(403).json({ error: 'Permission denied' });
      }
      res.json({ created: fullPath });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/rmdir', csrfGuard, (req: Request, res: Response) => {
    try {
      const { dirPath } = req.body as { dirPath?: string };
      if (!dirPath) {
        return res.status(400).json({ error: 'dirPath is required' });
      }
      const resolved = path.resolve(dirPath);
      const parent = path.dirname(resolved);
      if (parent === resolved) {
        return res.status(400).json({ error: 'Cannot delete filesystem root' });
      }
      if (!fs.existsSync(resolved)) {
        return res.status(404).json({ error: 'Folder does not exist' });
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }
      try {
        fs.rmSync(resolved, { recursive: true, force: true });
      } catch {
        return res.status(403).json({ error: 'Permission denied' });
      }
      res.json({ deleted: resolved, parent });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
