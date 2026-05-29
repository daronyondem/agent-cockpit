import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import type { ChatService } from '../../services/chatService';
import { WorkspaceArchiveError } from '../../services/chatService';
import { WorkspaceSnapshotError } from '../../services/chat/workspaceSnapshotService';
import {
  validateWorkspaceArchiveRequest,
  validateWorkspaceRestoreRequest,
  validateWorkspaceSnapshotEstimateRequest,
} from '../../contracts/workspaces';
import { isContractValidationError } from '../../contracts/validation';
import type { Request, Response } from '../../types';
import { param } from './routeUtils';

export interface WorkspaceArchiveRouterOptions {
  chatService: ChatService;
  hasInFlightTurnForWorkspace: (workspaceId: string) => boolean;
  isWorkspaceOperationRunning?: (workspaceId: string) => boolean;
  enqueueWorkspaceArchiveFinalizers: (workspaceId: string) => Promise<void>;
}

export function createWorkspaceArchiveRouter(opts: WorkspaceArchiveRouterOptions): express.Router {
  const {
    chatService,
    hasInFlightTurnForWorkspace,
    isWorkspaceOperationRunning,
    enqueueWorkspaceArchiveFinalizers,
  } = opts;
  const router = express.Router();

  router.get('/workspaces', async (req: Request, res: Response) => {
    try {
      const archivedParam = req.query.archived;
      const includeArchived = archivedParam === 'all';
      const archived = archivedParam === 'true';
      const workspaces = await chatService.listWorkspaces({ archived, includeArchived });
      res.set('Cache-Control', 'no-store');
      res.json({ workspaces });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:workspaceId/archive', async (req: Request, res: Response) => {
    try {
      const workspace = await chatService.getWorkspaceSummary(param(req, 'workspaceId'));
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
      res.set('Cache-Control', 'no-store');
      res.json({ workspace });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/snapshot/estimate', csrfGuard, async (req: Request, res: Response) => {
    try {
      const workspaceRef = param(req, 'workspaceId');
      const request = validateWorkspaceSnapshotEstimateRequest(req.body);
      const estimate = await chatService.estimateWorkspaceSnapshot(workspaceRef, request.inclusionPolicy || 'exclude_common');
      if (!estimate) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ estimate });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      if (err instanceof WorkspaceSnapshotError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/archive', csrfGuard, async (req: Request, res: Response) => {
    try {
      const workspaceRef = param(req, 'workspaceId');
      const existing = await chatService.getWorkspaceSummary(workspaceRef);
      if (!existing) return res.status(404).json({ error: 'Workspace not found' });
      if (hasInFlightTurnForWorkspace(existing.workspaceId)) {
        return res.status(409).json({
          error: 'Cannot archive workspace while a turn is running in this workspace',
          code: 'workspace_busy',
        });
      }
      if (isWorkspaceOperationRunning?.(existing.workspaceId)) {
        return res.status(409).json({
          error: 'Cannot archive workspace while workspace processing is running',
          code: 'workspace_operation_running',
        });
      }

      const request = validateWorkspaceArchiveRequest(req.body);
      let workspace = await chatService.archiveWorkspace(existing.workspaceId, request);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      try {
        await enqueueWorkspaceArchiveFinalizers(workspace.workspaceId);
        workspace = await chatService.getWorkspaceSummary(workspace.workspaceId) || workspace;
      } catch (err: unknown) {
        workspace = await chatService.completeWorkspaceArchiveFinalLearningPass(workspace.workspaceId, (err as Error).message) || workspace;
      }

      res.json({ workspace });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      if (err instanceof WorkspaceArchiveError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      if (err instanceof WorkspaceSnapshotError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/restore', csrfGuard, async (req: Request, res: Response) => {
    try {
      const request = validateWorkspaceRestoreRequest(req.body);
      const existing = await chatService.getWorkspaceSummary(param(req, 'workspaceId'));
      if (!existing) return res.status(404).json({ error: 'Workspace not found' });
      if (hasInFlightTurnForWorkspace(existing.workspaceId)) {
        return res.status(409).json({
          error: 'Cannot restore workspace while a turn is running in this workspace',
          code: 'workspace_busy',
        });
      }
      if (isWorkspaceOperationRunning?.(existing.workspaceId)) {
        return res.status(409).json({
          error: 'Cannot restore workspace while workspace processing is running',
          code: 'workspace_operation_running',
        });
      }
      const workspace = request.restoreFromSnapshot
        ? await chatService.restoreWorkspaceFromSnapshot(existing.workspaceId, request.destinationPath)
        : await chatService.restoreWorkspace(existing.workspaceId);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ workspace });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      if (err instanceof WorkspaceArchiveError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      if (err instanceof WorkspaceSnapshotError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/workspaces/:workspaceId', csrfGuard, async (req: Request, res: Response) => {
    try {
      const existing = await chatService.getWorkspaceSummary(param(req, 'workspaceId'));
      if (!existing) return res.status(404).json({ error: 'Workspace not found' });
      if (hasInFlightTurnForWorkspace(existing.workspaceId)) {
        return res.status(409).json({
          error: 'Cannot delete archived workspace data while a turn is running in this workspace',
          code: 'workspace_busy',
        });
      }
      if (isWorkspaceOperationRunning?.(existing.workspaceId)) {
        return res.status(409).json({
          error: 'Cannot delete archived workspace data while workspace processing is running',
          code: 'workspace_operation_running',
        });
      }
      const ok = await chatService.deleteArchivedWorkspaceData(existing.workspaceId);
      if (!ok) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ ok: true });
    } catch (err: unknown) {
      if (err instanceof WorkspaceArchiveError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
