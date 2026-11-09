import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import type { BackendRegistry } from '../../services/backends/registry';
import type { ChatService } from '../../services/chatService';
import type { KbSearchMcpServer } from '../../services/kbSearchMcp';
import type { MemoryMcpServer } from '../../services/memoryMcp';
import type { StreamJobSupervisor } from '../../services/streamJobSupervisor';
import { isWorktreeIsolationError } from '../../services/chat/worktreeIsolationService';
import { validateSetWorktreeIsolationRequest } from '../../contracts/worktreeIsolation';
import { isContractValidationError } from '../../contracts/validation';
import type { Request, Response } from '../../types';
import { isCliProfileResolutionError, param } from './routeUtils';

type CliRuntime = Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>> | null;

interface WorktreeIsolationRouteOptions {
  streamSupervisor: StreamJobSupervisor;
  hasInFlightTurnForWorkspace: (workspaceId: string) => boolean;
  clearWsBuffer: (convId: string) => void;
  backendRegistry: BackendRegistry;
  memoryMcp: MemoryMcpServer;
  kbSearchMcp: KbSearchMcpServer;
  enqueueSessionSummaryFinalizer: (workspaceId: string, convId: string, sessionNumber: number, runtime: CliRuntime) => Promise<void>;
  enqueueMemoryFinalizer: (workspaceId: string, convId: string, sessionNumber: number, runtime: CliRuntime) => Promise<void>;
  enqueueWorkspaceContextFinalizer: (workspaceId: string, convId: string, sessionNumber: number, source: 'session_reset') => Promise<void>;
}

interface WorktreeSessionResetTarget {
  convId: string;
  backendId: string;
  sessionNumber: number;
  runtime: CliRuntime;
}

export function createWorktreeIsolationRouter(
  chatService: ChatService,
  opts: WorktreeIsolationRouteOptions,
): express.Router {
  const router = express.Router();

  async function getWorkspaceResetTargets(workspaceId: string): Promise<WorktreeSessionResetTarget[]> {
    const status = await chatService.getWorkspaceWorktreeIsolationStatus(workspaceId);
    const conversations = Array.isArray(status.conversations) ? status.conversations : [];
    const targets: WorktreeSessionResetTarget[] = [];
    for (const row of conversations) {
      const conv = await chatService.getConversation(row.id);
      if (!conv) continue;
      let runtime: CliRuntime = null;
      try {
        runtime = await chatService.resolveCliProfileRuntime(conv.cliProfileId, conv.backend);
      } catch (err: unknown) {
        if (isCliProfileResolutionError(err)) throw err;
        throw err;
      }
      targets.push({ convId: conv.id, backendId: conv.backend, sessionNumber: conv.sessionNumber, runtime });
    }
    return targets;
  }

  async function runSessionResetSideEffects(workspaceId: string, targets: WorktreeSessionResetTarget[]): Promise<void> {
    for (const target of targets) {
      await opts.enqueueSessionSummaryFinalizer(workspaceId, target.convId, target.sessionNumber, target.runtime);
      await opts.enqueueMemoryFinalizer(workspaceId, target.convId, target.sessionNumber, target.runtime);
      await opts.enqueueWorkspaceContextFinalizer(workspaceId, target.convId, target.sessionNumber, 'session_reset');

      opts.memoryMcp.revokeMemoryMcpSession(target.convId);
      opts.kbSearchMcp.revokeKbSearchSession(target.convId);
    }
  }

  router.get('/workspaces/:workspaceId/worktree-isolation', async (req: Request, res: Response) => {
    try {
      const status = await chatService.getWorkspaceWorktreeIsolationStatus(param(req, 'workspaceId'));
      if (!status.available && status.blockers.some((blocker) => blocker.code === 'workspace_not_found')) {
        return res.status(404).json({ error: 'Workspace not found', ...status });
      }
      res.json(status);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:workspaceId/worktree-isolation', csrfGuard, async (req: Request, res: Response) => {
    let releaseReset: (() => void) | null = null;
    try {
      const body = validateSetWorktreeIsolationRequest(req.body);
      const workspaceRef = param(req, 'workspaceId');
      const location = await chatService.getWorkspaceLocation(workspaceRef);
      if (!location) return res.status(404).json({ error: 'Workspace not found' });
      const workspaceId = location.workspaceId;
      if (opts.hasInFlightTurnForWorkspace(workspaceId)) {
        return res.status(409).json({
          error: 'Cannot change worktree mode while a conversation is running',
          blockers: [{
            code: 'active_streams',
            message: 'Cannot change worktree mode while a conversation is running',
          }],
        });
      }
      releaseReset = opts.streamSupervisor.tryBeginWorkspaceReset(workspaceId);
      if (!releaseReset) return res.status(409).json({ error: 'Workspace sessions are resetting' });
      const beforeStatus = await chatService.getWorkspaceWorktreeIsolationStatus(workspaceId);
      const resetTargets = beforeStatus.enabled !== body.enabled
        ? await getWorkspaceResetTargets(workspaceId)
        : [];
      // All old runtimes must stop before any conversation checkout is replaced.
      for (const target of resetTargets) {
        for (const backendId of new Set([target.backendId, target.runtime?.backendId])) {
          if (backendId) await opts.backendRegistry.get(backendId)?.onSessionReset(target.convId);
        }
      }
      for (const target of resetTargets) opts.clearWsBuffer(target.convId);
      const status = await chatService.setWorkspaceWorktreeIsolation(workspaceId, body.enabled, {
        confirmedSessionReset: body.confirmedSessionReset,
      });
      if (!status) return res.status(404).json({ error: 'Workspace not found' });
      await runSessionResetSideEffects(workspaceId, resetTargets);
      res.json({ ok: true, ...status });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      if (isCliProfileResolutionError(err)) {
        return res.status(400).json({ error: (err as Error).message });
      }
      if (isWorktreeIsolationError(err)) {
        return res.status(err.status).json({
          error: err.message,
          code: err.code,
          blockers: err.blockers,
        });
      }
      res.status(500).json({ error: (err as Error).message });
    } finally {
      releaseReset?.();
    }
  });

  return router;
}
