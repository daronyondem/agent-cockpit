import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import type { ChatService } from '../../services/chatService';
import type { WorkspaceContextService } from '../../services/workspaceContext/service';
import {
  validateWorkspaceContextEnabledRequest,
  validateWorkspaceContextSettingsRequest,
} from '../../contracts/workspaceContext';
import { isContractValidationError } from '../../contracts/validation';
import type { Request, Response } from '../../types';
import { logger } from '../../utils/logger';
import { param } from './routeUtils';

const log = logger.child({ module: 'workspace-context-routes' });

export interface WorkspaceContextRoutesOptions {
  chatService: ChatService;
  workspaceContextService: WorkspaceContextService;
  emitFreshWorkspaceContextUpdate: (hash: string) => Promise<void>;
}

export function createWorkspaceContextRouter(opts: WorkspaceContextRoutesOptions): express.Router {
  const { chatService, workspaceContextService, emitFreshWorkspaceContextUpdate } = opts;
  const router = express.Router();

  router.get('/workspaces/:workspaceId/workspace-context/settings', async (req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-store');
      const hash = param(req, 'workspaceId');
      const settings = await chatService.getWorkspaceContextSettings(hash);
      if (settings === null) return res.status(404).json({ error: 'Workspace not found' });
      const enabled = await chatService.getWorkspaceContextEnabled(hash);
      const state = await workspaceContextService.getDisplayState(hash);
      const files = enabled ? await workspaceContextService.listFiles(hash) : [];
      res.json({
        enabled,
        settings,
        state,
        contextDir: workspaceContextService.getContextFilesDir(hash),
        instructionPath: workspaceContextService.getInstructionPath(hash),
        files,
      });
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
        instructionPath: workspaceContextService.getInstructionPath(hash),
        files: result ? await workspaceContextService.listFiles(hash) : [],
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
