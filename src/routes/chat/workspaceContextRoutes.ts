import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { csrfGuard } from '../../middleware/csrf';
import type { ChatService } from '../../services/chatService';
import type { WorkspaceContextService } from '../../services/workspaceContext/service';
import {
  resolveAssetFile,
  resolveContextMarkdownFile,
  resolveReferenceFile,
  WORKSPACE_CONTEXT_ASSET_UPLOAD_LIMIT_BYTES,
  WorkspaceContextMaterialError,
  type ResolvedWorkspaceContextFile,
} from '../../services/workspaceContext/materials';
import {
  validateWorkspaceContextEnabledRequest,
  validateWorkspaceContextReferenceWriteRequest,
  validateWorkspaceContextSettingsRequest,
} from '../../contracts/workspaceContext';
import { isContractValidationError } from '../../contracts/validation';
import type { NextFunction, Request, Response } from '../../types';
import { logger } from '../../utils/logger';
import { param } from './routeUtils';

const log = logger.child({ module: 'workspace-context-routes' });
const WORKSPACE_CONTEXT_VIEW_LIMIT_BYTES = 2 * 1024 * 1024;

export interface WorkspaceContextRoutesOptions {
  chatService: ChatService;
  workspaceContextService: WorkspaceContextService;
  emitFreshWorkspaceContextUpdate: (hash: string) => Promise<void>;
}

export function createWorkspaceContextRouter(opts: WorkspaceContextRoutesOptions): express.Router {
  const { chatService, workspaceContextService, emitFreshWorkspaceContextUpdate } = opts;
  const router = express.Router();
  const assetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: WORKSPACE_CONTEXT_ASSET_UPLOAD_LIMIT_BYTES, files: 1 },
  });
  const assetUploadMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    assetUpload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `File exceeds the ${Math.floor(WORKSPACE_CONTEXT_ASSET_UPLOAD_LIMIT_BYTES / 1024 / 1024)} MB upload limit.`
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

  router.get('/conversations/:id/workspace-context-file', async (req: Request, res: Response) => {
    try {
      const convId = param(req, 'id');
      const filePath = req.query.path as string | undefined;
      const mode = (req.query.mode as string) || 'download';

      if (!filePath) {
        return res.status(400).json({ error: 'path query parameter is required' });
      }

      const conv = await chatService.getConversation(convId);
      if (!conv || !conv.workspaceId) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      if (!(await chatService.getWorkspaceContextEnabled(conv.workspaceId))) {
        return res.status(403).json({ error: 'Workspace Context is disabled' });
      }

      const resolved = await resolveWorkspaceContextRequestPath(workspaceContextService, conv.workspaceId, filePath);
      if (!resolved) return res.status(404).json({ error: 'File not found' });
      return serveResolvedWorkspaceContextFile(res, resolved, mode, splitLineSuffix(filePath));
    } catch (err: unknown) {
      if (err instanceof WorkspaceContextMaterialError) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:workspaceId/workspace-context/settings', async (req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-store');
      const hash = param(req, 'workspaceId');
      const settings = await chatService.getWorkspaceContextSettings(hash);
      if (settings === null) return res.status(404).json({ error: 'Workspace not found' });
      const enabled = await chatService.getWorkspaceContextEnabled(hash);
      res.json(await workspaceContextSettingsPayload(workspaceContextService, hash, enabled, settings));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:workspaceId/workspace-context/enabled', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const { enabled } = validateWorkspaceContextEnabledRequest(req.body);
      const wasEnabled = await chatService.getWorkspaceContextEnabled(hash);
      if (enabled === false && workspaceContextService.isRunning(hash)) {
        await workspaceContextService.stopWorkspace(hash);
      }
      const result = await chatService.setWorkspaceContextEnabled(hash, enabled);
      if (result === null) return res.status(404).json({ error: 'Workspace not found' });
      if (enabled) {
        await workspaceContextService.ensureWorkspace(hash);
      } else {
        await workspaceContextService.uninstallWorkspaceInstructions(hash);
      }
      await emitFreshWorkspaceContextUpdate(hash);
      if (enabled && !wasEnabled) {
        void workspaceContextService.processWorkspace(hash, { source: 'initial_scan', forceAll: true }).catch((err: unknown) => {
          log.warn('Workspace Context initial scan failed', { workspace: hash, error: err });
        });
      }
      const state = await workspaceContextService.getDisplayState(hash);
      res.json({
        enabled: result,
        settings: await chatService.getWorkspaceContextSettings(hash),
        state,
        contextDir: workspaceContextService.getContextFilesDir(hash),
        referencesDir: workspaceContextService.getReferenceFilesDir(hash),
        assetsDir: workspaceContextService.getAssetsDir(hash),
        instructionPath: workspaceContextService.getInstructionPath(hash),
        files: result ? await workspaceContextService.listFiles(hash) : [],
        references: result ? await workspaceContextService.listReferences(hash) : [],
        assets: result ? await workspaceContextService.listAssets(hash) : [],
        initialRunStarted: enabled && !wasEnabled,
      });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:workspaceId/workspace-context/settings', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const { settings: input } = validateWorkspaceContextSettingsRequest(req.body);
      const settings = await chatService.setWorkspaceContextSettings(hash, input);
      if (settings === null) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ settings });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/workspace-context/scan', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      if (!(await chatService.getWorkspaceContextEnabled(hash))) {
        return res.status(403).json({ error: 'Workspace Context is disabled' });
      }
      if (workspaceContextService.isRunning(hash)) {
        return res.status(409).json({
          error: 'Workspace Context run already running',
          state: await workspaceContextService.getDisplayState(hash),
          files: await workspaceContextService.listFiles(hash),
          references: await workspaceContextService.listReferences(hash),
          assets: await workspaceContextService.listAssets(hash),
        });
      }
      void workspaceContextService.processWorkspace(hash, { source: 'manual_catchup', forceAll: true }).catch((err: unknown) => {
        log.warn('Workspace Context manual scan failed', { workspace: hash, error: err });
      });
      res.json({ ok: true, started: true, source: 'manual_catchup' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/workspace-context/maintenance', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      if (!(await chatService.getWorkspaceContextEnabled(hash))) {
        return res.status(403).json({ error: 'Workspace Context is disabled' });
      }
      if (workspaceContextService.isRunning(hash)) {
        return res.status(409).json({
          error: 'Workspace Context run already running',
          state: await workspaceContextService.getDisplayState(hash),
          files: await workspaceContextService.listFiles(hash),
          references: await workspaceContextService.listReferences(hash),
          assets: await workspaceContextService.listAssets(hash),
        });
      }
      void workspaceContextService.processWorkspace(hash, { source: 'maintenance', forceAll: true }).catch((err: unknown) => {
        log.warn('Workspace Context maintenance failed', { workspace: hash, error: err });
      });
      res.json({ ok: true, started: true, source: 'maintenance' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/workspace-context/scan/stop', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const stopped = await workspaceContextService.stopWorkspace(hash);
      if (!stopped) return res.status(409).json({ error: 'No Workspace Context run is running' });
      res.json({ ok: true, stopped: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/workspace-context/repair-instructions', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const state = await workspaceContextService.repairInstructions(hash);
      if (!state) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ ok: true, state });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:workspaceId/workspace-context/files', async (req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-store');
      const hash = param(req, 'workspaceId');
      if (!(await chatService.getWorkspaceContextEnabled(hash))) {
        return res.json({ files: [], contextDir: workspaceContextService.getContextFilesDir(hash) });
      }
      res.json({ files: await workspaceContextService.listFiles(hash), contextDir: workspaceContextService.getContextFilesDir(hash) });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:workspaceId/workspace-context/files/*', async (req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-store');
      const hash = param(req, 'workspaceId');
      const relPath = String(req.params[0] || '');
      if (!(await chatService.getWorkspaceContextEnabled(hash))) {
        return res.status(403).json({ error: 'Workspace Context is disabled' });
      }
      const file = await workspaceContextService.readFile(hash, relPath);
      if (!file) return res.status(404).json({ error: 'File not found' });
      res.json(file);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:workspaceId/workspace-context/references', async (req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-store');
      const hash = param(req, 'workspaceId');
      if (!(await chatService.getWorkspaceContextEnabled(hash))) {
        return res.json({ references: [], referencesDir: workspaceContextService.getReferenceFilesDir(hash) });
      }
      res.json({ references: await workspaceContextService.listReferences(hash), referencesDir: workspaceContextService.getReferenceFilesDir(hash) });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:workspaceId/workspace-context/references/*', async (req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-store');
      const hash = param(req, 'workspaceId');
      const relPath = String(req.params[0] || '');
      if (!(await chatService.getWorkspaceContextEnabled(hash))) {
        return res.status(403).json({ error: 'Workspace Context is disabled' });
      }
      const file = await workspaceContextService.readReference(hash, relPath);
      if (!file) return res.status(404).json({ error: 'Reference not found' });
      res.json(file);
    } catch (err: unknown) {
      if (err instanceof WorkspaceContextMaterialError) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:workspaceId/workspace-context/references/*', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const relPath = String(req.params[0] || '');
      if (!(await chatService.getWorkspaceContextEnabled(hash))) {
        return res.status(403).json({ error: 'Workspace Context is disabled' });
      }
      const { content } = validateWorkspaceContextReferenceWriteRequest(req.body);
      const file = await workspaceContextService.writeReference(hash, relPath, content);
      res.json({ file });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      if (err instanceof WorkspaceContextMaterialError) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/workspaces/:workspaceId/workspace-context/references/*', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const relPath = String(req.params[0] || '');
      if (!(await chatService.getWorkspaceContextEnabled(hash))) {
        return res.status(403).json({ error: 'Workspace Context is disabled' });
      }
      const deleted = await workspaceContextService.deleteReference(hash, relPath);
      if (!deleted) return res.status(404).json({ error: 'Reference not found' });
      res.json({ ok: true, deleted: true });
    } catch (err: unknown) {
      if (err instanceof WorkspaceContextMaterialError) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:workspaceId/workspace-context/assets', async (req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-store');
      const hash = param(req, 'workspaceId');
      if (!(await chatService.getWorkspaceContextEnabled(hash))) {
        return res.json({ assets: [], assetsDir: workspaceContextService.getAssetsDir(hash) });
      }
      res.json({ assets: await workspaceContextService.listAssets(hash), assetsDir: workspaceContextService.getAssetsDir(hash) });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/workspace-context/assets/*', csrfGuard, assetUploadMiddleware, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const relPath = String(req.params[0] || '');
      if (!(await chatService.getWorkspaceContextEnabled(hash))) {
        return res.status(403).json({ error: 'Workspace Context is disabled' });
      }
      const file = (req as unknown as { file?: Express.Multer.File }).file;
      if (!file) return res.status(400).json({ error: 'Missing file' });
      const written = await workspaceContextService.writeAsset(hash, relPath || file.originalname, file.buffer);
      res.json({ asset: written });
    } catch (err: unknown) {
      if (err instanceof WorkspaceContextMaterialError) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:workspaceId/workspace-context/assets/*', async (req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-store');
      const hash = param(req, 'workspaceId');
      const relPath = String(req.params[0] || '');
      const mode = (req.query.mode as string) || 'view';
      if (!(await chatService.getWorkspaceContextEnabled(hash))) {
        return res.status(403).json({ error: 'Workspace Context is disabled' });
      }
      const file = await resolveAssetFile(workspaceContextService.getAssetsDir(hash), relPath);
      if (!file) return res.status(404).json({ error: 'Asset not found' });
      return serveResolvedWorkspaceContextFile(res, file, mode, { line: null, column: null });
    } catch (err: unknown) {
      if (err instanceof WorkspaceContextMaterialError) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/workspaces/:workspaceId/workspace-context/assets/*', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const relPath = String(req.params[0] || '');
      if (!(await chatService.getWorkspaceContextEnabled(hash))) {
        return res.status(403).json({ error: 'Workspace Context is disabled' });
      }
      const deleted = await workspaceContextService.deleteAsset(hash, relPath);
      if (!deleted) return res.status(404).json({ error: 'Asset not found' });
      res.json({ ok: true, deleted: true });
    } catch (err: unknown) {
      if (err instanceof WorkspaceContextMaterialError) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/workspaces/:workspaceId/workspace-context', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const settings = await chatService.getWorkspaceContextSettings(hash);
      if (settings === null) return res.status(404).json({ error: 'Workspace not found' });
      if (workspaceContextService.isRunning(hash)) {
        return res.status(409).json({ error: 'Workspace Context run is running. Stop it before clearing context files.' });
      }
      await workspaceContextService.clearWorkspace(hash);
      await workspaceContextService.repairInstructions(hash);
      await emitFreshWorkspaceContextUpdate(hash);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

function splitLineSuffix(filePath: string): { filePath: string; line: number | null; column: number | null } {
  const value = String(filePath || '');
  const columnMatch = value.match(/^(.*):([1-9]\d*):([1-9]\d*)$/);
  if (columnMatch) return { filePath: columnMatch[1], line: Number(columnMatch[2]), column: Number(columnMatch[3]) };
  const lineMatch = value.match(/^(.*):([1-9]\d*)$/);
  if (lineMatch) return { filePath: lineMatch[1], line: Number(lineMatch[2]), column: null };
  return { filePath: value, line: null, column: null };
}

function insideRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

async function workspaceContextSettingsPayload(
  workspaceContextService: WorkspaceContextService,
  hash: string,
  enabled: boolean,
  settings: Awaited<ReturnType<ChatService['getWorkspaceContextSettings']>>,
) {
  return {
    enabled,
    settings,
    state: await workspaceContextService.getDisplayState(hash),
    contextDir: workspaceContextService.getContextFilesDir(hash),
    referencesDir: workspaceContextService.getReferenceFilesDir(hash),
    assetsDir: workspaceContextService.getAssetsDir(hash),
    instructionPath: workspaceContextService.getInstructionPath(hash),
    files: enabled ? await workspaceContextService.listFiles(hash) : [],
    references: enabled ? await workspaceContextService.listReferences(hash) : [],
    assets: enabled ? await workspaceContextService.listAssets(hash) : [],
  };
}

async function resolveWorkspaceContextRequestPath(
  workspaceContextService: WorkspaceContextService,
  hash: string,
  requestedPath: string,
): Promise<ResolvedWorkspaceContextFile | null> {
  const parsed = splitLineSuffix(requestedPath);
  const requested = parsed.filePath.replace(/\\/g, '/');
  if (!requested || requested.split('/').some(part => part === '..')) {
    throw new WorkspaceContextMaterialError(400, 'Invalid path');
  }

  const roots = [
    {
      prefix: 'context',
      root: workspaceContextService.getContextFilesDir(hash),
      resolve: resolveContextMarkdownFile,
    },
    {
      prefix: 'references',
      root: workspaceContextService.getReferenceFilesDir(hash),
      resolve: resolveReferenceFile,
    },
    {
      prefix: 'assets',
      root: workspaceContextService.getAssetsDir(hash),
      resolve: resolveAssetFile,
    },
  ];

  if (path.isAbsolute(requested)) {
    const abs = path.resolve(requested);
    for (const candidate of roots) {
      const root = path.resolve(candidate.root);
      if (!insideRoot(abs, root)) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      return candidate.resolve(candidate.root, rel);
    }
    throw new WorkspaceContextMaterialError(403, 'Access denied: path is outside Workspace Context');
  }

  const rel = requested.replace(/^\/+/, '');
  for (const candidate of roots) {
    const prefix = `${candidate.prefix}/`;
    if (!rel.startsWith(prefix)) continue;
    return candidate.resolve(candidate.root, rel.slice(prefix.length));
  }

  return resolveContextMarkdownFile(workspaceContextService.getContextFilesDir(hash), rel);
}

function serveResolvedWorkspaceContextFile(
  res: Response,
  file: ResolvedWorkspaceContextFile,
  mode: string,
  lineInfo: { line: number | null; column: number | null },
) {
  if (mode !== 'view' && mode !== 'download') {
    return res.status(400).json({ error: 'mode must be view or download' });
  }

  const filename = path.basename(file.absPath);
  if (mode === 'download') {
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '\\"')}"`);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(file.stat.size));
    return fs.createReadStream(file.absPath).pipe(res);
  }

  if (!file.previewable) {
    return res.status(415).json({ error: 'File type cannot be previewed. Use download instead.' });
  }

  if (file.kind === 'image') {
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.stat.size));
    return fs.createReadStream(file.absPath).pipe(res);
  }

  if (file.stat.size > WORKSPACE_CONTEXT_VIEW_LIMIT_BYTES) {
    return res.status(413).json({ error: 'File too large to view (max 2 MB). Use download instead.' });
  }
  return res.json({
    content: fs.readFileSync(file.absPath, 'utf8'),
    filename,
    path: file.absPath,
    language: file.language,
    mimeType: file.mimeType,
    size: file.stat.size,
    line: lineInfo.line,
    column: lineInfo.column,
  });
}
