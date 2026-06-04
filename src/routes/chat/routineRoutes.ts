import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import {
  validateRoutineInstallRequest,
  validateRoutineProposalValidationRequest,
  validateRoutineUpdateRequest,
  validateRoutineWorkspaceSettingsRequest,
} from '../../contracts/routines';
import { isContractValidationError } from '../../contracts/validation';
import type { ChatService } from '../../services/chatService';
import type { RoutinesService } from '../../services/routines/service';
import type { Request, Response } from '../../types';
import { logger } from '../../utils/logger';
import { param } from './routeUtils';

const log = logger.child({ module: 'routine-routes' });

export interface RoutineRoutesOptions {
  chatService: ChatService;
  routinesService: RoutinesService;
}

export function createRoutineRouter(opts: RoutineRoutesOptions): express.Router {
  const { chatService, routinesService } = opts;
  const router = express.Router();

  router.get('/workspaces/:workspaceId/routines', async (req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-store');
      const workspaceId = param(req, 'workspaceId');
      if (!(await chatService.getWorkspacePath(workspaceId))) return res.status(404).json({ error: 'Workspace not found' });
      res.json({
        routines: await routinesService.listRoutines(workspaceId),
        settings: await routinesService.getSettingsResponse(workspaceId),
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:workspaceId/routines/settings', async (req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-store');
      const workspaceId = param(req, 'workspaceId');
      if (!(await chatService.getWorkspacePath(workspaceId))) return res.status(404).json({ error: 'Workspace not found' });
      res.json(await routinesService.getSettingsResponse(workspaceId));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:workspaceId/routines/settings', csrfGuard, async (req: Request, res: Response) => {
    try {
      const workspaceId = param(req, 'workspaceId');
      if (!(await chatService.getWorkspacePath(workspaceId))) return res.status(404).json({ error: 'Workspace not found' });
      const { settings } = validateRoutineWorkspaceSettingsRequest(req.body);
      await routinesService.updateWorkspaceSettings(workspaceId, settings);
      res.json(await routinesService.getSettingsResponse(workspaceId));
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/routines/telegram-destination/start', csrfGuard, async (req: Request, res: Response) => {
    try {
      const workspaceId = param(req, 'workspaceId');
      if (!(await chatService.getWorkspacePath(workspaceId))) return res.status(404).json({ error: 'Workspace not found' });
      res.json(await routinesService.startTelegramDestinationConnect(workspaceId));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/routines/telegram-destination/poll', csrfGuard, async (req: Request, res: Response) => {
    try {
      const workspaceId = param(req, 'workspaceId');
      if (!(await chatService.getWorkspacePath(workspaceId))) return res.status(404).json({ error: 'Workspace not found' });
      res.json(await routinesService.pollTelegramDestinationConnect(workspaceId));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/routines/proposals/validate', csrfGuard, async (req: Request, res: Response) => {
    try {
      const workspaceId = param(req, 'workspaceId');
      if (!(await chatService.getWorkspacePath(workspaceId))) return res.status(404).json({ error: 'Workspace not found' });
      const request = validateRoutineProposalValidationRequest(req.body);
      const proposals = request.marker
        ? [await routinesService.validateProposalMarker(workspaceId, request.marker)].filter(Boolean)
        : await routinesService.validateProposalMarkers(workspaceId, request.content || '');
      res.json({ proposals });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/routines/repair-instructions', csrfGuard, async (req: Request, res: Response) => {
    try {
      const workspaceId = param(req, 'workspaceId');
      if (!(await chatService.getWorkspacePath(workspaceId))) return res.status(404).json({ error: 'Workspace not found' });
      await routinesService.ensureWorkspace(workspaceId);
      res.json({ ok: true, settings: await routinesService.getSettingsResponse(workspaceId) });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:workspaceId/routines/:routineId', async (req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-store');
      const workspaceId = param(req, 'workspaceId');
      if (!(await chatService.getWorkspacePath(workspaceId))) return res.status(404).json({ error: 'Workspace not found' });
      const routine = await routinesService.getRoutine(workspaceId, param(req, 'routineId'));
      if (!routine) return res.status(404).json({ error: 'Routine not found' });
      res.json({ routine });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:workspaceId/routines/:routineId', csrfGuard, async (req: Request, res: Response) => {
    try {
      const workspaceId = param(req, 'workspaceId');
      if (!(await chatService.getWorkspacePath(workspaceId))) return res.status(404).json({ error: 'Workspace not found' });
      const request = validateRoutineUpdateRequest(req.body);
      const routine = await routinesService.updateRoutine(workspaceId, param(req, 'routineId'), request);
      if (!routine) return res.status(404).json({ error: 'Routine not found' });
      res.json({ routine });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/routines/:routineId/install', csrfGuard, async (req: Request, res: Response) => {
    try {
      const workspaceId = param(req, 'workspaceId');
      if (!(await chatService.getWorkspacePath(workspaceId))) return res.status(404).json({ error: 'Workspace not found' });
      const { state } = validateRoutineInstallRequest(req.body);
      const routine = await routinesService.installRoutine(workspaceId, param(req, 'routineId'), state);
      if (!routine) return res.status(404).json({ error: 'Routine not found' });
      res.json({ routine });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/routines/:routineId/run', csrfGuard, async (req: Request, res: Response) => {
    try {
      const workspaceId = param(req, 'workspaceId');
      const routineId = param(req, 'routineId');
      if (!(await chatService.getWorkspacePath(workspaceId))) return res.status(404).json({ error: 'Workspace not found' });
      const routine = await routinesService.getRoutine(workspaceId, routineId);
      if (!routine) return res.status(404).json({ error: 'Routine not found' });
      if (routine.manifest.state === 'proposed') {
        return res.status(409).json({ error: 'Install or disable the routine before running it.' });
      }
      if (routine.running || routinesService.isRunning(workspaceId, routineId)) return res.status(409).json({ error: 'Routine run already running' });
      const previousRunId = routine.lastRun?.runId || null;
      void routinesService.runRoutine(workspaceId, routineId, { source: 'manual' }).catch((err: unknown) => {
        log.warn('Manual routine run failed', { workspaceId, routineId, error: err });
      });
      const startedRoutine = await waitForRoutineRunSnapshot(routinesService, workspaceId, routineId, previousRunId);
      res.json({
        ok: true,
        started: true,
        ...(startedRoutine ? { routine: startedRoutine, run: startedRoutine.lastRun || null } : {}),
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/workspaces/:workspaceId/routines/:routineId', csrfGuard, async (req: Request, res: Response) => {
    try {
      const workspaceId = param(req, 'workspaceId');
      if (!(await chatService.getWorkspacePath(workspaceId))) return res.status(404).json({ error: 'Workspace not found' });
      const deleted = await routinesService.deleteRoutine(workspaceId, param(req, 'routineId'));
      if (!deleted) return res.status(404).json({ error: 'Routine not found' });
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = (err as Error).message || '';
      if (message.includes('running')) return res.status(409).json({ error: message });
      res.status(500).json({ error: message });
    }
  });

  return router;
}

async function waitForRoutineRunSnapshot(
  routinesService: RoutinesService,
  workspaceId: string,
  routineId: string,
  previousRunId: string | null,
): Promise<Awaited<ReturnType<RoutinesService['getRoutine']>>> {
  const deadline = Date.now() + 1500;
  do {
    const routine = await routinesService.getRoutine(workspaceId, routineId);
    const lastRunId = routine?.lastRun?.runId || null;
    if (routine && lastRunId && lastRunId !== previousRunId) return routine;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return routinesService.getRoutine(workspaceId, routineId);
}
