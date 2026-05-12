import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import type { BackendRegistry } from '../../services/backends/registry';
import type { ChatService } from '../../services/chatService';
import type { KbDreamService } from '../../services/knowledgeBase/dream';
import type { KbSearchMcpServer } from '../../services/kbSearchMcp';
import type { MemoryMcpServer } from '../../services/memoryMcp';
import type { MemoryWatcher } from '../../services/memoryWatcher';
import type { ContextMapMcpServer } from '../../services/contextMap/mcp';
import { StreamJobSupervisor, type PendingMessageSend } from '../../services/streamJobSupervisor';
import { validateQueueUpdateRequest } from '../../contracts/chat';
import {
  validateCreateConversationRequest,
  validateRenameConversationRequest,
  validateSetMessagePinnedRequest,
  validateSetUnreadRequest,
} from '../../contracts/conversations';
import { isContractValidationError } from '../../contracts/validation';
import type { Request, Response } from '../../types';
import { isCliProfileResolutionError, param } from './routeUtils';

type CliRuntime = Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>> | null;

export interface ConversationRoutesOptions {
  chatService: ChatService;
  backendRegistry: BackendRegistry;
  streamSupervisor: StreamJobSupervisor;
  pendingMessageSends: Map<string, PendingMessageSend>;
  memoryWatcher: MemoryWatcher;
  memoryFingerprints: Map<string, Map<string, string>>;
  memoryMcp: MemoryMcpServer;
  kbSearchMcp: KbSearchMcpServer;
  contextMapMcp: ContextMapMcpServer;
  kbDreaming: KbDreamService;
  hasInFlightTurn: (convId: string) => boolean;
  clearWsBuffer: (convId: string) => void;
  enqueueSessionSummaryFinalizer: (workspaceHash: string, convId: string, sessionNumber: number, runtime: CliRuntime) => Promise<void>;
  enqueueMemoryFinalizer: (workspaceHash: string, convId: string, sessionNumber: number, runtime: CliRuntime) => Promise<void>;
  enqueueContextMapFinalizer: (workspaceHash: string, convId: string, sessionNumber: number, source: 'session_reset' | 'archive') => Promise<void>;
}

export function createConversationRouter(opts: ConversationRoutesOptions): express.Router {
  const {
    chatService,
    backendRegistry,
    streamSupervisor,
    pendingMessageSends,
    memoryWatcher,
    memoryFingerprints,
    memoryMcp,
    kbSearchMcp,
    contextMapMcp,
    kbDreaming,
    hasInFlightTurn,
    clearWsBuffer,
    enqueueSessionSummaryFinalizer,
    enqueueMemoryFinalizer,
    enqueueContextMapFinalizer,
  } = opts;
  const router = express.Router();

  router.get('/conversations/:id/queue', async (req: Request, res: Response) => {
    try {
      const convId = param(req, 'id');
      const conv = await chatService.getConversation(convId);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      const queued = await chatService.getQueue(convId);
      res.json({ queue: queued });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/conversations/:id/queue', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { queue } = validateQueueUpdateRequest(req.body);
      const convId = param(req, 'id');
      const updated = await chatService.setQueue(convId, queue);
      if (!updated) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ ok: true, queue });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/conversations/:id/queue', csrfGuard, async (req: Request, res: Response) => {
    try {
      const updated = await chatService.clearQueue(param(req, 'id'));
      if (!updated) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ ok: true, queue: [] });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── List conversations ─────────────────────────────────────────────────────
  router.get('/conversations', async (req: Request, res: Response) => {
    try {
      const q = (req.query.q as string) || '';
      const archived = req.query.archived === 'true';
      const opts = { archived };
      const convs = q ? await chatService.searchConversations(q, opts) : await chatService.listConversations(opts);
      res.json({ conversations: convs });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Get single conversation ────────────────────────────────────────────────
  router.get('/conversations/:id', async (req: Request, res: Response) => {
    try {
      const conv = await chatService.getConversation(param(req, 'id'));
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });

      // Augment with KB status so the frontend's composer KB status icon
      // can render without a separate round-trip to GET /kb.
      const kbEnabled = await chatService.getWorkspaceKbEnabled(conv.workspaceHash);
      if (kbEnabled) {
        const db = chatService.getKbDb(conv.workspaceHash);
        if (db) {
          const snapshot = db.getSynthesisSnapshot();
          const counters = db.getCounters();
          const autoDigest = await chatService.getWorkspaceKbAutoDigest(conv.workspaceHash);
          (conv as unknown as Record<string, unknown>).kb = {
            enabled: true,
            dreamingNeeded: snapshot.needsSynthesisCount > 0,
            pendingEntries: snapshot.needsSynthesisCount,
            pendingDigestions: counters.pendingCount,
            autoDigest,
            dreamingStatus: kbDreaming.isRunning(conv.workspaceHash) ? 'running' : snapshot.status,
            dreamingStopping: kbDreaming.isStopRequested(conv.workspaceHash),
            failedItems: counters.rawByStatus.failed,
          };
        }
      }
      if (await chatService.getWorkspaceMemoryEnabled(conv.workspaceHash)) {
        (conv as unknown as Record<string, unknown>).memoryReview = await chatService.getMemoryReviewStatus(conv.workspaceHash);
      }
      if (await chatService.getWorkspaceContextMapEnabled(conv.workspaceHash)) {
        (conv as unknown as Record<string, unknown>).contextMap = await chatService.getContextMapStatus(conv.workspaceHash);
      }

      res.json(conv);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Create conversation ────────────────────────────────────────────────────
  router.post('/conversations', csrfGuard, async (req: Request, res: Response) => {
    try {
      const body = validateCreateConversationRequest(req.body);
      const conv = await chatService.createConversation(
        body.title,
        body.workingDir,
        body.backend,
        body.model,
        body.effort,
        body.cliProfileId,
        body.serviceTier,
      );
      res.json(conv);
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      if (isCliProfileResolutionError(err)) {
        return res.status(400).json({ error: (err as Error).message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Rename conversation ────────────────────────────────────────────────────
  router.put('/conversations/:id', csrfGuard, async (req: Request, res: Response) => {
    try {
      const body = validateRenameConversationRequest(req.body);
      const conv = await chatService.renameConversation(param(req, 'id'), body.title);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      res.json(conv);
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Delete conversation ────────────────────────────────────────────────────
  router.delete('/conversations/:id', csrfGuard, async (req: Request, res: Response) => {
    try {
      const convId = param(req, 'id');
      if (pendingMessageSends.has(convId)) {
        return res.status(409).json({ error: 'Conversation is already streaming' });
      }
      await streamSupervisor.cleanupRuntimeConversation(convId);
      clearWsBuffer(convId);
      memoryWatcher.unwatch(convId);
      memoryFingerprints.delete(convId);
      memoryMcp.revokeMemoryMcpSession(convId);
      kbSearchMcp.revokeKbSearchSession(convId);
      contextMapMcp.revokeContextMapMcpSession(convId);
      const ok = await chatService.deleteConversation(convId);
      if (!ok) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Archive conversation ───────────────────────────────────────────────────
  router.patch('/conversations/:id/archive', csrfGuard, async (req: Request, res: Response) => {
    try {
      const convId = param(req, 'id');
      if (pendingMessageSends.has(convId)) {
        return res.status(409).json({ error: 'Conversation is already streaming' });
      }
      await streamSupervisor.cleanupRuntimeConversation(convId);
      clearWsBuffer(convId);
      memoryWatcher.unwatch(convId);
      memoryFingerprints.delete(convId);
      const preConv = await chatService.getConversation(convId);
      const ok = await chatService.archiveConversation(convId);
      if (!ok) return res.status(404).json({ error: 'Conversation not found' });
      if (preConv) {
        await enqueueContextMapFinalizer(preConv.workspaceHash, convId, preConv.sessionNumber, 'archive');
      }
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Restore conversation ──────────────────────────────────────────────────
  router.patch('/conversations/:id/restore', csrfGuard, async (req: Request, res: Response) => {
    try {
      const ok = await chatService.restoreConversation(param(req, 'id'));
      if (!ok) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Set / clear unread flag ───────────────────────────────────────────────
  router.patch('/conversations/:id/unread', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { unread } = validateSetUnreadRequest(req.body);
      const ok = await chatService.setConversationUnread(param(req, 'id'), unread);
      if (!ok) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ ok: true, unread });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Pin / unpin an active-session message ────────────────────────────────
  router.patch('/conversations/:id/messages/:messageId/pin', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { pinned } = validateSetMessagePinnedRequest(req.body);
      const result = await chatService.setMessagePinned(param(req, 'id'), param(req, 'messageId'), pinned);
      if (!result) return res.status(404).json({ error: 'Conversation or message not found' });
      res.json({ ok: true, pinned, message: result.message });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Download conversation as markdown ──────────────────────────────────────
  router.get('/conversations/:id/download', async (req: Request, res: Response) => {
    try {
      const md = await chatService.conversationToMarkdown(param(req, 'id'));
      if (!md) return res.status(404).json({ error: 'Conversation not found' });
      const conv = await chatService.getConversation(param(req, 'id'));
      const filename = (conv!.title || 'conversation').replace(/[^a-zA-Z0-9-_ ]/g, '').substring(0, 50).trim() + '.md';
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(md);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Download session as markdown ────────────────────────────────────────────
  router.get('/conversations/:id/sessions/:num/download', async (req: Request, res: Response) => {
    try {
      const sessionNumber = Number(param(req, 'num'));
      const md = await chatService.sessionToMarkdown(param(req, 'id'), sessionNumber);
      if (!md) return res.status(404).json({ error: 'Session not found' });
      const conv = await chatService.getConversation(param(req, 'id'));
      const title = (conv!.title || 'conversation').replace(/[^a-zA-Z0-9-_ ]/g, '').substring(0, 50).trim();
      const filename = `${title}-session-${sessionNumber}.md`;
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(md);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Session history ────────────────────────────────────────────────────────
  router.get('/conversations/:id/sessions', async (req: Request, res: Response) => {
    try {
      const sessions = await chatService.getSessionHistory(param(req, 'id'));
      if (!sessions) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ sessions });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Get session messages ───────────────────────────────────────────────────
  router.get('/conversations/:id/sessions/:num/messages', async (req: Request, res: Response) => {
    try {
      const sessionNumber = Number(param(req, 'num'));
      if (!sessionNumber || sessionNumber < 1) {
        return res.status(400).json({ error: 'Invalid session number' });
      }
      const messages = await chatService.getSessionMessages(param(req, 'id'), sessionNumber);
      if (!messages) return res.status(404).json({ error: 'Session not found' });
      res.json({ messages });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Reset session ──────────────────────────────────────────────────────────
  router.post('/conversations/:id/reset', csrfGuard, async (req: Request, res: Response) => {
    try {
      const convId = param(req, 'id');
      if (hasInFlightTurn(convId)) {
        return res.status(409).json({ error: 'Cannot reset session while streaming' });
      }
      // Capture the current backend BEFORE resetting the session, so
      // memory is extracted from whichever CLI the ending session used.
      const preConv = await chatService.getConversation(convId);
      let endingRuntime: Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>> | null = null;
      if (preConv) {
        try {
          endingRuntime = await chatService.resolveCliProfileRuntime(preConv.cliProfileId, preConv.backend);
        } catch (err: unknown) {
          if (isCliProfileResolutionError(err)) {
            return res.status(400).json({ error: (err as Error).message });
          }
          throw err;
        }
      }

      // Clear any stale event buffer so a subsequent WS connection
      // doesn't replay old-session events into the new session.
      clearWsBuffer(convId);
      const result = await chatService.resetSession(convId);
      if (!result) return res.status(404).json({ error: 'Conversation not found' });

      const resetWsHash = chatService.getWorkspaceHashForConv(convId);
      if (resetWsHash) {
        await enqueueSessionSummaryFinalizer(resetWsHash, convId, result.archivedSession.number, endingRuntime);
        await enqueueMemoryFinalizer(resetWsHash, convId, result.archivedSession.number, endingRuntime);
        await enqueueContextMapFinalizer(resetWsHash, convId, result.archivedSession.number, 'session_reset');
      }

      // Let the backend adapter clean up per-conversation state (e.g. ACP processes)
      const conv = await chatService.getConversation(convId);
      if (conv) {
        const runtime = await chatService.resolveCliProfileRuntime(conv.cliProfileId, conv.backend);
        const adapter = backendRegistry.get(runtime.backendId);
        if (adapter) adapter.onSessionReset(convId);
      }

      // Revoke any Memory / KB Search / Context Map MCP tokens issued for this
      // conversation — new ones will be minted on the next message send.
      memoryMcp.revokeMemoryMcpSession(convId);
      kbSearchMcp.revokeKbSearchSession(convId);
      contextMapMcp.revokeContextMapMcpSession(convId);

      res.json(result);
    } catch (err: unknown) {
      if (isCliProfileResolutionError(err)) {
        return res.status(400).json({ error: (err as Error).message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });


  return router;
}
