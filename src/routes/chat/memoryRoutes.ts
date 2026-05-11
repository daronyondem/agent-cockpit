import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import type { ChatService } from '../../services/chatService';
import type { MemoryMcpServer } from '../../services/memoryMcp';
import { validateMemoryReviewScheduleConfig } from '../../services/memoryReview';
import {
  validateMemoryConsolidationApplyRequest,
  validateMemoryConsolidationDraftApplyRequest,
  validateMemoryConsolidationDraftRequest,
  validateMemoryEnabledRequest,
  validateMemoryEntryRestoreRequest,
  validateMemoryReviewDraftApplyRequest,
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

  router.get('/workspaces/:hash/memory', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
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

  router.get('/workspaces/:hash/memory/search', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
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

  router.post('/workspaces/:hash/memory/consolidate/propose', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const proposal = await memoryMcp.proposeMemoryConsolidation(hash);
      return res.json({ ok: true, proposal });
    } catch (err: unknown) {
      return res.status(memoryConsolidationErrorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/memory/consolidate/draft', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const { action } = validateMemoryConsolidationDraftRequest(req.body);
      const draft = await memoryMcp.draftMemoryConsolidation(hash, { action: action as unknown as MemoryConsolidationAction });
      return res.json({ ok: true, draft });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      return res.status(memoryConsolidationErrorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/memory/consolidate/apply', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
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

  router.post('/workspaces/:hash/memory/consolidate/drafts/apply', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
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

  router.put('/workspaces/:hash/memory/entries/restore', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
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

  router.put('/workspaces/:hash/memory/enabled', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { enabled } = validateMemoryEnabledRequest(req.body);
      const hash = param(req, 'hash');
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

  router.get('/workspaces/:hash/memory/review-schedule', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const schedule = await chatService.getWorkspaceMemoryReviewSchedule(hash);
      const scheduleUpdatedAt = await chatService.getWorkspaceMemoryReviewScheduleUpdatedAt(hash);
      const status = await chatService.getMemoryReviewStatus(hash);
      res.json({ schedule, scheduleUpdatedAt, status });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/memory/review-schedule', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const body = (req.body || {}) as { schedule?: unknown };
      const result = validateMemoryReviewScheduleConfig(body.schedule || req.body);
      if (result.error || !result.config) return res.status(400).json({ error: result.error || 'Invalid schedule' });
      const schedule = await chatService.setWorkspaceMemoryReviewSchedule(hash, result.config);
      if (!schedule) return res.status(404).json({ error: 'Workspace not found' });
      const scheduleUpdatedAt = await chatService.getWorkspaceMemoryReviewScheduleUpdatedAt(hash);
      const status = await chatService.getMemoryReviewStatus(hash);
      res.json({ schedule, scheduleUpdatedAt, status });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/memory/reviews', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const run = await memoryMcp.startMemoryReviewRun(hash, { source: 'manual', replaceExisting: true });
      const status = await chatService.getMemoryReviewStatus(hash);
      res.status(run.status === 'running' ? 202 : 200).json({ ok: true, run, status });
    } catch (err: unknown) {
      return res.status(memoryConsolidationErrorStatus(err)).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:hash/memory/reviews', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const pendingOnly = req.query.pending === '1' || req.query.pending === 'true';
      let runs = await chatService.listMemoryReviewRuns(hash);
      if (pendingOnly) {
        runs = runs.filter((run) => run.status === 'running' || run.status === 'pending_review' || run.status === 'failed');
      }
      const status = await chatService.getMemoryReviewStatus(hash);
      res.json({ status, runs });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:hash/memory/reviews/pending', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const runs = (await chatService.listMemoryReviewRuns(hash))
        .filter((run) => run.status === 'running' || run.status === 'pending_review' || run.status === 'failed');
      const status = await chatService.getMemoryReviewStatus(hash);
      res.json({ status, runs });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:hash/memory/reviews/:runId', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const run = await chatService.getMemoryReviewRun(hash, param(req, 'runId'));
      if (!run) return res.status(404).json({ error: 'Memory Review not found' });
      const status = await chatService.getMemoryReviewStatus(hash);
      res.json({ status, run });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/memory/reviews/:runId/actions/:itemId/apply', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const run = await memoryMcp.applyMemoryReviewSafeAction(hash, param(req, 'runId'), param(req, 'itemId'));
      const status = await chatService.getMemoryReviewStatus(hash);
      res.json({ ok: true, status, run });
    } catch (err: unknown) {
      const message = (err as Error).message;
      res.status(/not found/i.test(message) ? 404 : memoryConsolidationErrorStatus(err)).json({ error: message });
    }
  });

  router.post('/workspaces/:hash/memory/reviews/:runId/actions/:itemId/discard', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const run = await memoryMcp.discardMemoryReviewItem(hash, param(req, 'runId'), param(req, 'itemId'));
      const status = await chatService.getMemoryReviewStatus(hash);
      res.json({ ok: true, status, run });
    } catch (err: unknown) {
      const message = (err as Error).message;
      res.status(/not found/i.test(message) ? 404 : memoryConsolidationErrorStatus(err)).json({ error: message });
    }
  });

  router.post('/workspaces/:hash/memory/reviews/:runId/drafts/:draftId/apply', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const body = validateMemoryReviewDraftApplyRequest(req.body);
      const run = await memoryMcp.applyMemoryReviewDraft(
        hash,
        param(req, 'runId'),
        param(req, 'draftId'),
        body.draft ? { draft: body.draft as unknown as MemoryConsolidationDraft } : undefined,
      );
      const status = await chatService.getMemoryReviewStatus(hash);
      res.json({ ok: true, status, run });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return res.status(400).json({ error: err.message });
      const message = (err as Error).message;
      res.status(/not found/i.test(message) ? 404 : memoryConsolidationErrorStatus(err)).json({ error: message });
    }
  });

  router.post('/workspaces/:hash/memory/reviews/:runId/drafts/:draftId/discard', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const run = await memoryMcp.discardMemoryReviewItem(hash, param(req, 'runId'), param(req, 'draftId'));
      const status = await chatService.getMemoryReviewStatus(hash);
      res.json({ ok: true, status, run });
    } catch (err: unknown) {
      const message = (err as Error).message;
      res.status(/not found/i.test(message) ? 404 : memoryConsolidationErrorStatus(err)).json({ error: message });
    }
  });

  router.post('/workspaces/:hash/memory/reviews/:runId/drafts/:draftId/regenerate', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const run = await memoryMcp.regenerateMemoryReviewDraft(hash, param(req, 'runId'), param(req, 'draftId'));
      const status = await chatService.getMemoryReviewStatus(hash);
      res.json({ ok: true, status, run });
    } catch (err: unknown) {
      const message = (err as Error).message;
      res.status(/not found/i.test(message) ? 404 : memoryConsolidationErrorStatus(err)).json({ error: message });
    }
  });

  router.delete('/workspaces/:hash/memory/entries/:relpath(*)', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
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

  router.delete('/workspaces/:hash/memory/entries', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
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
