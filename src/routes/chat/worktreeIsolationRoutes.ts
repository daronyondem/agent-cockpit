import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import type { BackendRegistry } from '../../services/backends/registry';
import type { ChatService } from '../../services/chatService';
import type { KbSearchMcpServer } from '../../services/kbSearchMcp';
import type { MemoryMcpServer } from '../../services/memoryMcp';
import { isWorktreeIsolationError } from '../../services/chat/worktreeIsolationService';
import { validateSetWorktreeIsolationRequest } from '../../contracts/worktreeIsolation';
import { isContractValidationError } from '../../contracts/validation';
import type { Request, Response } from '../../types';
import { isCliProfileResolutionError, param } from './routeUtils';

type CliRuntime = Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>> | null;

interface WorktreeIsolationRouteOptions {
  hasInFlightTurnForWorkspace: (workspaceHash: string) => boolean;
  clearWsBuffer: (convId: string) => void;
  backendRegistry: BackendRegistry;
  memoryMcp: MemoryMcpServer;
  kbSearchMcp: KbSearchMcpServer;
  enqueueSessionSummaryFinalizer: (workspaceHash: string, convId: string, sessionNumber: number, runtime: CliRuntime) => Promise<void>;
  enqueueMemoryFinalizer: (workspaceHash: string, convId: string, sessionNumber: number, runtime: CliRuntime) => Promise<void>;
  enqueueWorkspaceContextFinalizer: (workspaceHash: string, convId: string, sessionNumber: number, source: 'session_reset') => Promise<void>;
}

interface WorktreeSessionResetTarget {
  convId: string;
  sessionNumber: number;
  runtime: CliRuntime;
}

export function createWorktreeIsolationRouter(
  chatService: ChatService,
  opts: WorktreeIsolationRouteOptions,
): express.Router {
  const router = express.Router();

  async function getWorkspaceResetTargets(workspaceHash: string): Promise<WorktreeSessionResetTarget[]> {
    const status = await chatService.getWorkspaceWorktreeIsolationStatus(workspaceHash);
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
      targets.push({ convId: conv.id, sessionNumber: conv.sessionNumber, runtime });
    }
    return targets;
  }

  async function runSessionResetSideEffects(workspaceHash: string, targets: WorktreeSessionResetTarget[]): Promise<void> {
    for (const target of targets) {
      await opts.enqueueSessionSummaryFinalizer(workspaceHash, target.convId, target.sessionNumber, target.runtime);
      await opts.enqueueMemoryFinalizer(workspaceHash, target.convId, target.sessionNumber, target.runtime);
      await opts.enqueueWorkspaceContextFinalizer(workspaceHash, target.convId, target.sessionNumber, 'session_reset');

      const adapter = target.runtime ? opts.backendRegistry.get(target.runtime.backendId) : null;
      if (adapter) adapter.onSessionReset(target.convId);

      opts.memoryMcp.revokeMemoryMcpSession(target.convId);
      opts.kbSearchMcp.revokeKbSearchSession(target.convId);
    }
  }

  router.get('/workspaces/:hash/worktree-isolation', async (req: Request, res: Response) => {
    try {
      const status = await chatService.getWorkspaceWorktreeIsolationStatus(param(req, 'hash'));
      if (!status.available && status.blockers.some((blocker) => blocker.code === 'workspace_not_found')) {
        return res.status(404).json({ error: 'Workspace not found', ...status });
      }
      res.json(status);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/worktree-isolation', csrfGuard, async (req: Request, res: Response) => {
    try {
      const body = validateSetWorktreeIsolationRequest(req.body);
      const workspaceHash = param(req, 'hash');
      if (opts.hasInFlightTurnForWorkspace(workspaceHash)) {
        return res.status(409).json({
          error: 'Cannot change worktree mode while a conversation is running',
          blockers: [{
            code: 'active_streams',
            message: 'Cannot change worktree mode while a conversation is running',
          }],
        });
      }
      const beforeStatus = await chatService.getWorkspaceWorktreeIsolationStatus(workspaceHash);
      const resetTargets = beforeStatus.enabled !== body.enabled
        ? await getWorkspaceResetTargets(workspaceHash)
        : [];
      for (const target of resetTargets) opts.clearWsBuffer(target.convId);
      const status = await chatService.setWorkspaceWorktreeIsolation(workspaceHash, body.enabled, {
        confirmedSessionReset: body.confirmedSessionReset,
      });
      if (!status) return res.status(404).json({ error: 'Workspace not found' });
      await runSessionResetSideEffects(workspaceHash, resetTargets);
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
    }
  });

  return router;
}
