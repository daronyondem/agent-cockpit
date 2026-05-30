import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import type { ChatService } from '../../services/chatService';
import type { MemoryMcpServer } from '../../services/memoryMcp';
import {
  validateMemoryConsolidationApplyRequest,
  validateMemoryConsolidationDraftApplyRequest,
  validateMemoryConsolidationDraftRequest,
  validateMemoryEnabledRequest,
  validateMemoryEntryRestoreRequest,
} from '../../contracts/memory';
import { isContractValidationError } from '../../contracts/validation';
import type {
  MemoryConsolidationAction,
  MemoryConsolidationDraft,
  MemoryStatus,
  MemoryType,
  MemoryUpdateEvent,
  Request,
  Response,
} from '../../types';
import { param, queryStrings } from './routeUtils';

export interface MemoryRoutesOptions {
  chatService: ChatService;
  memoryMcp: MemoryMcpServer;
  broadcastMemoryUpdate: (hash: string, frame: MemoryUpdateEvent) => void;
}

export function createMemoryRouter(opts: MemoryRoutesOptions): express.Router {
  const { chatService, memoryMcp, broadcastMemoryUpdate } = opts;
  const router = express.Router();

  router.get('/workspaces/:workspaceId/memory', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const enabled = await chatService.getWorkspaceMemoryEnabled(hash);
      const snapshot = await chatService.getWorkspaceMemory(hash);
      if (snapshot === null && !enabled) {
        return res.json({ enabled, snapshot: null });
      }
      res.json({ enabled, snapshot });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:workspaceId/memory/search', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
      if (!query) return res.status(400).json({ error: 'query is required' });

      const enabled = await chatService.getWorkspaceMemoryEnabled(hash);
      if (!enabled) {
        return res.json({ enabled, query, results: [] });
      }

      const rawTypes = queryStrings(req.query.type).concat(queryStrings(req.query.types));
      const types = rawTypes.filter((item): item is MemoryType =>
        item === 'user'
        || item === 'feedback'
        || item === 'project'
        || item === 'reference'
        || item === 'unknown',
      );
      const rawStatuses = queryStrings(req.query.status).concat(queryStrings(req.query.statuses));
      const statuses = rawStatuses.filter((item): item is MemoryStatus =>
        item === 'active'
        || item === 'superseded'
        || item === 'redacted'
        || item === 'deleted',
      );
      const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);

      const results = await chatService.searchWorkspaceMemory(hash, {
        query,
        ...(Number.isInteger(limit) ? { limit } : {}),
        ...(types.length ? { types } : {}),
        ...(statuses.length ? { statuses } : {}),
      });
      return res.json({ enabled, query, results });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/memory/consolidate/propose', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const proposal = await memoryMcp.proposeMemoryConsolidation(hash);
      return res.json({ ok: true, proposal });
    } catch (err: unknown) {
      return res.status(memoryConsolidationErrorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/memory/consolidate/draft', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const { action } = validateMemoryConsolidationDraftRequest(req.body);
      const draft = await memoryMcp.draftMemoryConsolidation(hash, { action: action as unknown as MemoryConsolidationAction });
      return res.json({ ok: true, draft });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      return res.status(memoryConsolidationErrorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/memory/consolidate/apply', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const body = validateMemoryConsolidationApplyRequest(req.body);
      const result = await memoryMcp.applyMemoryConsolidation(hash, {
        summary: body.summary,
        actions: body.actions as unknown as MemoryConsolidationAction[],
      });
      return res.json(result);
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      return res.status(memoryConsolidationErrorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:workspaceId/memory/consolidate/drafts/apply', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const body = validateMemoryConsolidationDraftApplyRequest(req.body);
      const result = await memoryMcp.applyMemoryConsolidationDraft(hash, {
        summary: body.summary,
        draft: body.draft as unknown as MemoryConsolidationDraft,
      });
      return res.json(result);
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      return res.status(memoryConsolidationErrorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:workspaceId/memory/entries/restore', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const { relPath } = validateMemoryEntryRestoreRequest(req.body);

      const restored = await chatService.restoreMemoryEntry(hash, relPath);
      if (!restored) return res.status(404).json({ error: 'Entry not found' });
      const snapshot = await chatService.getWorkspaceMemory(hash);

      broadcastMemoryUpdate(hash, {
        type: 'memory_update',
        capturedAt: snapshot?.capturedAt || new Date().toISOString(),
        fileCount: snapshot?.files.length || 0,
        changedFiles: [relPath],
        sourceConversationId: null,
        displayInChat: false,
      });

      return res.json({ ok: true, restored, snapshot });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      const msg = (err as Error).message || 'Restore failed';
      const status = /superseded/i.test(msg) || /traversal/i.test(msg) ? 400 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  router.put('/workspaces/:workspaceId/memory/enabled', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { enabled } = validateMemoryEnabledRequest(req.body);
      const hash = param(req, 'workspaceId');
      const result = await chatService.setWorkspaceMemoryEnabled(hash, enabled);
      if (result === null) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ enabled: result });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.all('/workspaces/:workspaceId/memory/review-schedule', memoryReviewRemoved);
  router.all('/workspaces/:workspaceId/memory/reviews', memoryReviewRemoved);
  router.all('/workspaces/:workspaceId/memory/reviews/pending', memoryReviewRemoved);
  router.all('/workspaces/:workspaceId/memory/reviews/:runId', memoryReviewRemoved);
  router.all('/workspaces/:workspaceId/memory/reviews/:runId/actions/:itemId/apply', memoryReviewRemoved);
  router.all('/workspaces/:workspaceId/memory/reviews/:runId/actions/:itemId/discard', memoryReviewRemoved);
  router.all('/workspaces/:workspaceId/memory/reviews/:runId/drafts/:draftId/apply', memoryReviewRemoved);
  router.all('/workspaces/:workspaceId/memory/reviews/:runId/drafts/:draftId/discard', memoryReviewRemoved);
  router.all('/workspaces/:workspaceId/memory/reviews/:runId/drafts/:draftId/regenerate', memoryReviewRemoved);

  router.delete('/workspaces/:workspaceId/memory/entries/:relpath(*)', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const relPath = decodeURIComponent(param(req, 'relpath'));
      if (!relPath) return res.status(400).json({ error: 'relpath required' });

      const deleted = await chatService.deleteMemoryEntry(hash, relPath);
      if (!deleted) return res.status(404).json({ error: 'Entry not found' });

      const snapshot = await chatService.getWorkspaceMemory(hash);

      broadcastMemoryUpdate(hash, {
        type: 'memory_update',
        capturedAt: snapshot?.capturedAt || new Date().toISOString(),
        fileCount: snapshot?.files.length || 0,
        changedFiles: [relPath],
        sourceConversationId: null,
        displayInChat: false,
      });

      res.json({ ok: true, snapshot });
    } catch (err: unknown) {
      const msg = (err as Error).message || 'Delete failed';
      const status = /traversal/i.test(msg) ? 400 : 500;
      res.status(status).json({ error: msg });
    }
  });

  router.delete('/workspaces/:workspaceId/memory/entries', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const deleted = await chatService.clearWorkspaceMemory(hash);
      const snapshot = await chatService.getWorkspaceMemory(hash);

      broadcastMemoryUpdate(hash, {
        type: 'memory_update',
        capturedAt: snapshot?.capturedAt || new Date().toISOString(),
        fileCount: snapshot?.files.length || 0,
        changedFiles: [],
        sourceConversationId: null,
        displayInChat: false,
      });

      res.json({ ok: true, deleted, snapshot });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message || 'Clear failed' });
    }
  });

  return router;
}

function memoryReviewRemoved(_req: Request, res: Response): void {
  res.status(410).json({
    error: 'Memory Review has been removed. Workspace Context maintenance now consumes accepted Memory entries automatically.',
  });
}

function memoryConsolidationErrorStatus(err: unknown): number {
  const message = (err as Error).message || '';
  if (message.includes('disabled')) return 403;
  if (message.includes('still generating')) return 409;
  if (message.startsWith('Only ')
    || message.startsWith('Cannot ')
    || message.startsWith('Referenced ')
    || message.startsWith('draft.')
    || message.startsWith('Memory CLI output must')) return 400;
  if (message.startsWith('Memory CLI failed') || message.startsWith('Memory CLI returned')) return 502;
  return 500;
}
