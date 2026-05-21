import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import type { ChatService } from '../../services/chatService';
import { WorkspaceLocationUpdateError } from '../../services/chatService';
import { validateWorkspaceLocationUpdateRequest } from '../../contracts/workspaces';
import { isContractValidationError } from '../../contracts/validation';
import type { Request, Response } from '../../types';
import { param } from './routeUtils';

export interface WorkspaceLocationRouterOptions {
  chatService: ChatService;
  hasInFlightTurnForWorkspace: (workspaceId: string) => boolean;
  isWorkspaceOperationRunning?: (workspaceId: string) => boolean;
}

export function createWorkspaceLocationRouter(opts: WorkspaceLocationRouterOptions): express.Router {
  const { chatService, hasInFlightTurnForWorkspace, isWorkspaceOperationRunning } = opts;
  const router = express.Router();

  router.get('/workspaces/:workspaceId/location', async (req: Request, res: Response) => {
    try {
      const location = await chatService.getWorkspaceLocation(param(req, 'workspaceId'));
      if (!location) return res.status(404).json({ error: 'Workspace not found' });
      res.set('Cache-Control', 'no-store');
      res.json(location);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:workspaceId/location', csrfGuard, async (req: Request, res: Response) => {
    try {
      const workspaceRef = param(req, 'workspaceId');
      const location = await chatService.getWorkspaceLocation(workspaceRef);
      if (!location) return res.status(404).json({ error: 'Workspace not found' });
      if (hasInFlightTurnForWorkspace(location.workspaceId)) {
        return res.status(409).json({
          error: 'Cannot change workspace location while a turn is running in this workspace',
          code: 'workspace_busy',
        });
      }
      if (isWorkspaceOperationRunning?.(location.workspaceId)) {
        return res.status(409).json({
          error: 'Cannot change workspace location while workspace processing is running',
          code: 'workspace_operation_running',
        });
      }
      const { workspacePath } = validateWorkspaceLocationUpdateRequest(req.body);
      const updated = await chatService.updateWorkspaceLocation(location.workspaceId, workspacePath);
      if (!updated) return res.status(404).json({ error: 'Workspace not found' });
      res.json(updated);
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      if (err instanceof WorkspaceLocationUpdateError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
