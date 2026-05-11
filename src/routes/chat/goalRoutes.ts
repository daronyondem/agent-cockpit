import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import { parseServiceTierInput } from '../../contracts/chat';
import type { ChatService } from '../../services/chatService';
import type { BackendRegistry } from '../../services/backends/registry';
import type { BaseBackendAdapter } from '../../services/backends/base';
import { StreamJobSupervisor, type PendingMessageSend } from '../../services/streamJobSupervisor';
import type { EffortLevel, McpServerConfig, Request, Response, SendMessageResult, ServiceTier, WsServerFrame } from '../../types';
import { logger } from '../../utils/logger';
import { isCliProfileResolutionError, param } from './routeUtils';

const log = logger.child({ module: 'goal-routes' });

type Conversation = NonNullable<Awaited<ReturnType<ChatService['getConversation']>>>;
type CliRuntime = Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>>;

export interface AttachAndPipeStreamArgs {
  convId: string;
  conv: Conversation;
  backendId: string;
  runtime: CliRuntime;
  adapter: BaseBackendAdapter;
  sendResult: SendMessageResult;
  jobId: string;
  needsTitleUpdate: boolean;
  titleUpdateMessage: string | null;
  model: string | null;
  effort: EffortLevel | null;
  serviceTier?: ServiceTier | null;
}

export interface GoalRoutesOptions {
  chatService: ChatService;
  backendRegistry: BackendRegistry;
  streamSupervisor: StreamJobSupervisor;
  hasInFlightTurn: (convId: string) => boolean;
  finalizePendingAbortIfRequested: (convId: string, backend: string, pending: PendingMessageSend) => Promise<boolean>;
  attachAndPipeStream: (args: AttachAndPipeStreamArgs) => Promise<void>;
  buildGoalRunEnvironment: (convId: string, isNewSession: boolean) => Promise<{ systemPrompt: string; mcpServers?: McpServerConfig[] }>;
  sendIdleGoalFrame: (convId: string, frame: WsServerFrame) => void;
}

export function createGoalRouter(opts: GoalRoutesOptions): express.Router {
  const {
    chatService,
    backendRegistry,
    streamSupervisor,
    hasInFlightTurn,
    finalizePendingAbortIfRequested,
    attachAndPipeStream,
    buildGoalRunEnvironment,
    sendIdleGoalFrame,
  } = opts;
  const router = express.Router();

  async function resolveCodexGoalAdapter(conv: NonNullable<Awaited<ReturnType<ChatService['getConversation']>>>) {
    const runtime = await chatService.resolveCliProfileRuntime(conv.cliProfileId, conv.backend);
    if (runtime.backendId !== 'codex') {
      throw new Error(`Goals are only available for Codex conversations`);
    }
    const adapter = backendRegistry.get(runtime.backendId);
    if (!adapter) {
      throw new Error(`Unknown backend: ${runtime.backendId}`);
    }
    return { runtime, adapter, backendId: runtime.backendId };
  }

  router.get('/conversations/:id/goal', async (req: Request, res: Response) => {
    try {
      const convId = param(req, 'id');
      const conv = await chatService.getConversation(convId);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      const { runtime, adapter } = await resolveCodexGoalAdapter(conv);
      const goal = await adapter.getGoal({
        sessionId: conv.currentSessionId,
        conversationId: convId,
        cliProfileId: runtime.cliProfileId || conv.cliProfileId || undefined,
        cliProfile: runtime.profile,
        isNewSession: false,
        workingDir: conv.workingDir || null,
        systemPrompt: '',
        externalSessionId: conv.externalSessionId || null,
        model: conv.model || undefined,
        effort: conv.effort || undefined,
        serviceTier: conv.serviceTier || undefined,
      });
      res.json({ goal });
    } catch (err: unknown) {
      if (isCliProfileResolutionError(err)) {
        return res.status(400).json({ error: (err as Error).message });
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/conversations/:id/goal', csrfGuard, async (req: Request, res: Response) => {
    const convId = param(req, 'id');
    const { objective, backend, model, effort, cliProfileId } = req.body as {
      objective?: string;
      backend?: string;
      model?: string;
      effort?: EffortLevel;
      cliProfileId?: string;
    };
    let serviceTier: ServiceTier | null | undefined;
    try {
      serviceTier = parseServiceTierInput(req.body.serviceTier);
    } catch (err: unknown) {
      return res.status(400).json({ error: (err as Error).message });
    }
    if (!objective || typeof objective !== 'string' || !objective.trim()) {
      return res.status(400).json({ error: 'Goal objective required' });
    }

    let conv = await chatService.getConversation(convId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (hasInFlightTurn(convId)) {
      return res.status(409).json({ error: 'Conversation is already streaming' });
    }

    let jobHandedOff = false;
    let pendingMessageSend: PendingMessageSend | null = null;
    try {
      pendingMessageSend = await streamSupervisor.beginAcceptedTurn({
        conversationId: convId,
        sessionId: conv.currentSessionId,
        backend: conv.backend,
        cliProfileId: conv.cliProfileId || cliProfileId || null,
        model: model !== undefined ? (model || null) : (conv.model || null),
        effort: effort !== undefined ? (effort || null) : (conv.effort || null),
        serviceTier: serviceTier !== undefined ? serviceTier : (conv.serviceTier || null),
        workingDir: conv.workingDir || null,
      });
      const jobId = pendingMessageSend.jobId;

      try {
        if (cliProfileId) {
          if (cliProfileId !== conv.cliProfileId) {
            if (conv.messages.length > 0) {
              return res.status(409).json({ error: 'Cannot switch CLI profile after the active session has messages' });
            }
            await chatService.updateConversationCliProfile(convId, cliProfileId);
          }
        } else if (backend && backend !== conv.backend) {
          await chatService.updateConversationBackend(convId, backend);
        }
      } catch (err: unknown) {
        if (isCliProfileResolutionError(err)) {
          return res.status(400).json({ error: (err as Error).message });
        }
        throw err;
      }
      if (model !== undefined && model !== (conv.model || undefined)) {
        await chatService.updateConversationModel(convId, model || null);
      }
      if (effort !== undefined && effort !== (conv.effort || undefined)) {
        await chatService.updateConversationEffort(convId, effort || null);
      }
      if (serviceTier !== undefined && serviceTier !== (conv.serviceTier || null)) {
        await chatService.updateConversationServiceTier(convId, serviceTier);
      }
      conv = (await chatService.getConversation(convId))!;

      let runtime: Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>>;
      try {
        runtime = await chatService.resolveCliProfileRuntime(conv.cliProfileId, conv.backend);
      } catch (err: unknown) {
        if (isCliProfileResolutionError(err)) {
          return res.status(400).json({ error: (err as Error).message });
        }
        throw err;
      }
      const backendId = runtime.backendId;
      if (backendId !== 'codex') {
        return res.status(400).json({ error: 'Goals are only available for Codex conversations' });
      }
      if (cliProfileId && backend && backend !== backendId) {
        return res.status(400).json({ error: `CLI profile vendor ${backendId} does not match backend ${backend}` });
      }
      await streamSupervisor.markPreparing(jobId, {
        backend: backendId,
        sessionId: conv.currentSessionId,
        cliProfileId: runtime.cliProfileId || conv.cliProfileId || null,
        model: conv.model || null,
        effort: conv.effort || null,
        serviceTier: conv.serviceTier || null,
        workingDir: conv.workingDir || null,
      });
      if (await finalizePendingAbortIfRequested(convId, backendId, pendingMessageSend)) {
        return res.json({ streamReady: false, aborted: true });
      }

      const adapter = backendRegistry.get(backendId);
      if (!adapter) {
        return res.status(400).json({ error: `Unknown backend: ${backendId}` });
      }
      const isNewSession = conv.messages.length === 0;
      const { systemPrompt, mcpServers } = await buildGoalRunEnvironment(convId, isNewSession);
      const refreshedConv = await chatService.getConversation(convId);
      if (await finalizePendingAbortIfRequested(convId, backendId, pendingMessageSend)) {
        return res.json({ streamReady: false, aborted: true });
      }
      const effectiveEffort = effort !== undefined
        ? (refreshedConv?.effort || undefined)
        : (conv.effort || undefined);
      const effectiveServiceTier = serviceTier !== undefined
        ? (refreshedConv?.serviceTier || undefined)
        : (conv.serviceTier || undefined);
      const sendResult = adapter.setGoalObjective(objective.trim(), {
        sessionId: conv.currentSessionId,
        conversationId: convId,
        cliProfileId: runtime.cliProfileId || refreshedConv?.cliProfileId || conv.cliProfileId || undefined,
        cliProfile: runtime.profile,
        isNewSession,
        workingDir: conv.workingDir || null,
        systemPrompt,
        externalSessionId: conv.externalSessionId || null,
        model: model || conv.model || undefined,
        effort: effectiveEffort,
        serviceTier: effectiveServiceTier,
        mcpServers,
      });
      await attachAndPipeStream({
        convId,
        conv,
        backendId,
        runtime,
        adapter,
        sendResult,
        jobId,
        needsTitleUpdate: isNewSession && !conv.titleManuallySet,
        titleUpdateMessage: objective.trim(),
        model: model || conv.model || null,
        effort: effectiveEffort || null,
        serviceTier: effectiveServiceTier || null,
      });
      jobHandedOff = true;
      res.json({ streamReady: true });
    } finally {
      if (pendingMessageSend) {
        streamSupervisor.clearPending(convId, pendingMessageSend);
      }
      if (!jobHandedOff) {
        try {
          if (pendingMessageSend) await streamSupervisor.completeJob(pendingMessageSend.jobId);
        } catch (err: unknown) {
          log.warn('Failed to delete unstarted goal job', { conversationId: convId, error: err });
        }
      }
    }
  });

  router.post('/conversations/:id/goal/resume', csrfGuard, async (req: Request, res: Response) => {
    const convId = param(req, 'id');
    let conv = await chatService.getConversation(convId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (hasInFlightTurn(convId)) {
      return res.status(409).json({ error: 'Conversation is already streaming' });
    }

    let jobHandedOff = false;
    let pendingMessageSend: PendingMessageSend | null = null;
    try {
      const { runtime, adapter, backendId } = await resolveCodexGoalAdapter(conv);
      pendingMessageSend = await streamSupervisor.beginAcceptedTurn({
        conversationId: convId,
        sessionId: conv.currentSessionId,
        backend: backendId,
        cliProfileId: runtime.cliProfileId || conv.cliProfileId || null,
        model: conv.model || null,
        effort: conv.effort || null,
        serviceTier: conv.serviceTier || null,
        workingDir: conv.workingDir || null,
      });
      const jobId = pendingMessageSend.jobId;
      await streamSupervisor.markPreparing(jobId, {
        backend: backendId,
        sessionId: conv.currentSessionId,
        cliProfileId: runtime.cliProfileId || conv.cliProfileId || null,
        model: conv.model || null,
        effort: conv.effort || null,
        serviceTier: conv.serviceTier || null,
        workingDir: conv.workingDir || null,
      });
      if (await finalizePendingAbortIfRequested(convId, backendId, pendingMessageSend)) {
        return res.json({ streamReady: false, aborted: true });
      }
      conv = (await chatService.getConversation(convId))!;
      const { systemPrompt, mcpServers } = await buildGoalRunEnvironment(convId, false);
      const sendResult = adapter.resumeGoal({
        sessionId: conv.currentSessionId,
        conversationId: convId,
        cliProfileId: runtime.cliProfileId || conv.cliProfileId || undefined,
        cliProfile: runtime.profile,
        isNewSession: false,
        workingDir: conv.workingDir || null,
        systemPrompt,
        externalSessionId: conv.externalSessionId || null,
        model: conv.model || undefined,
        effort: conv.effort || undefined,
        serviceTier: conv.serviceTier || undefined,
        mcpServers,
      });
      await attachAndPipeStream({
        convId,
        conv,
        backendId,
        runtime,
        adapter,
        sendResult,
        jobId,
        needsTitleUpdate: false,
        titleUpdateMessage: null,
        model: conv.model || null,
        effort: conv.effort || null,
        serviceTier: conv.serviceTier || null,
      });
      jobHandedOff = true;
      res.json({ streamReady: true });
    } catch (err: unknown) {
      if (isCliProfileResolutionError(err)) {
        return res.status(400).json({ error: (err as Error).message });
      }
      res.status(400).json({ error: (err as Error).message });
    } finally {
      if (pendingMessageSend) {
        streamSupervisor.clearPending(convId, pendingMessageSend);
      }
      if (!jobHandedOff) {
        try {
          if (pendingMessageSend) await streamSupervisor.completeJob(pendingMessageSend.jobId);
        } catch (err: unknown) {
          log.warn('Failed to delete unstarted goal resume job', { conversationId: convId, error: err });
        }
      }
    }
  });

  router.post('/conversations/:id/goal/pause', csrfGuard, async (req: Request, res: Response) => {
    try {
      const convId = param(req, 'id');
      const conv = await chatService.getConversation(convId);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      const { runtime, adapter } = await resolveCodexGoalAdapter(conv);
      const goal = await adapter.pauseGoal({
        sessionId: conv.currentSessionId,
        conversationId: convId,
        cliProfileId: runtime.cliProfileId || conv.cliProfileId || undefined,
        cliProfile: runtime.profile,
        isNewSession: false,
        workingDir: conv.workingDir || null,
        systemPrompt: '',
        externalSessionId: conv.externalSessionId || null,
        model: conv.model || undefined,
        effort: conv.effort || undefined,
        serviceTier: conv.serviceTier || undefined,
      });
      if (goal) sendIdleGoalFrame(convId, { type: 'goal_updated', goal });
      res.json({ goal });
    } catch (err: unknown) {
      if (isCliProfileResolutionError(err)) {
        return res.status(400).json({ error: (err as Error).message });
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete('/conversations/:id/goal', csrfGuard, async (req: Request, res: Response) => {
    try {
      const convId = param(req, 'id');
      const conv = await chatService.getConversation(convId);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      const { runtime, adapter } = await resolveCodexGoalAdapter(conv);
      const result = await adapter.clearGoal({
        sessionId: conv.currentSessionId,
        conversationId: convId,
        cliProfileId: runtime.cliProfileId || conv.cliProfileId || undefined,
        cliProfile: runtime.profile,
        isNewSession: false,
        workingDir: conv.workingDir || null,
        systemPrompt: '',
        externalSessionId: conv.externalSessionId || null,
        model: conv.model || undefined,
        effort: conv.effort || undefined,
        serviceTier: conv.serviceTier || undefined,
      });
      sendIdleGoalFrame(convId, { type: 'goal_cleared', threadId: result.threadId || conv.externalSessionId || null });
      res.json(result);
    } catch (err: unknown) {
      if (isCliProfileResolutionError(err)) {
        return res.status(400).json({ error: (err as Error).message });
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── Send message + stream response ────────────────────────────────────────

  return router;
}
