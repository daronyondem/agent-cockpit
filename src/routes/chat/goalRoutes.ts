import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import { parseServiceTierInput } from '../../contracts/chat';
import type { ChatService } from '../../services/chatService';
import type { BackendRegistry } from '../../services/backends/registry';
import type { BaseBackendAdapter } from '../../services/backends/base';
import { StreamJobSupervisor, type PendingMessageSend } from '../../services/streamJobSupervisor';
import type { BackendGoalCapability, EffortLevel, GoalEvent, McpServerConfig, Request, Response, SendMessageResult, ServiceTier, ThreadGoal, WsServerFrame } from '../../types';
import { logger } from '../../utils/logger';
import {
  cleanGoalObjectiveText,
  clearGoalEvent,
  createRuntimeGoalSnapshot,
  formatGoalEventMessage,
  goalEventDedupeKey,
  goalEventFromGoal,
  goalEventFromStatus,
  normalizeGoalSnapshot,
  supportedActionsFromGoalCapability,
} from '../../services/chat/goalEventMessages';
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

  function normalizeGoalCapability(capability: unknown): BackendGoalCapability {
    if (capability === true) {
      return { set: true, clear: true, pause: true, resume: true, status: 'native' };
    }
    if (capability && typeof capability === 'object') {
      const value = capability as Partial<BackendGoalCapability>;
      return {
        set: value.set === true,
        clear: value.clear === true,
        pause: value.pause === true,
        resume: value.resume === true,
        status: value.status === 'native' || value.status === 'transcript' ? value.status : 'none',
      };
    }
    return { set: false, clear: false, pause: false, resume: false, status: 'none' };
  }

  async function resolveGoalAdapter(conv: NonNullable<Awaited<ReturnType<ChatService['getConversation']>>>) {
    const runtime = await chatService.resolveCliProfileRuntime(conv.cliProfileId, conv.backend);
    const adapter = backendRegistry.get(runtime.backendId);
    if (!adapter) {
      throw new Error(`Unknown backend: ${runtime.backendId}`);
    }
    const goals = normalizeGoalCapability(adapter.metadata.capabilities.goals);
    if (!goals.set && goals.status === 'none' && !goals.clear) {
      throw new Error(`Goals are not supported by ${adapter.metadata.label || runtime.backendId}`);
    }
    return { runtime, adapter, backendId: runtime.backendId, goals };
  }

  function unsupportedGoalAction(backendId: string, action: string): Error {
    const adapter = backendRegistry.get(backendId);
    const label = adapter?.metadata.label || backendId;
    return new Error(`Goal ${action} is not supported by ${label}`);
  }

  async function persistGoalEventMessage(convId: string, backendId: string, goalEvent: GoalEvent) {
    const goalMessage = await chatService.addMessage(
      convId,
      'system',
      formatGoalEventMessage(goalEvent),
      backendId,
      null,
      undefined,
      undefined,
      undefined,
      { goalEvent },
    );
    if (goalMessage) {
      sendIdleGoalFrame(convId, { type: 'assistant_message', message: goalMessage });
    }
    return goalMessage;
  }

  function conversationHasGoalEvent(conv: Conversation, goalEvent: GoalEvent): boolean {
    const key = goalEventDedupeKey(goalEvent);
    return conv.messages.some((message) => message.goalEvent && goalEventDedupeKey(message.goalEvent) === key);
  }

  async function persistGoalEventMessageOnce(convId: string, backendId: string, goalEvent: GoalEvent) {
    const latestConv = await chatService.getConversation(convId);
    if (latestConv && conversationHasGoalEvent(latestConv, goalEvent)) return null;
    return persistGoalEventMessage(convId, backendId, goalEvent);
  }

  router.get('/conversations/:id/goal', async (req: Request, res: Response) => {
    try {
      const convId = param(req, 'id');
      const conv = await chatService.getConversation(convId);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      const { runtime, adapter, goals } = await resolveGoalAdapter(conv);
      if (goals.status === 'none') throw unsupportedGoalAction(runtime.backendId, 'status');
      const rawGoal = await adapter.getGoal({
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
      const goal = rawGoal ? normalizeGoalSnapshot(rawGoal) : null;
      const terminalGoalEvent = goal ? goalEventFromStatus(goal) : null;
      if (terminalGoalEvent) {
        await persistGoalEventMessageOnce(convId, runtime.backendId, terminalGoalEvent);
      }
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
    const cleanObjective = cleanGoalObjectiveText(objective);
    if (!cleanObjective) {
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
          const profileOrProviderChanged = cliProfileId !== conv.cliProfileId || (backend && backend !== conv.backend);
          if (profileOrProviderChanged) {
            if (conv.messages.length > 0) {
              return res.status(409).json({ error: 'Cannot switch CLI profile after the active session has messages' });
            }
            await chatService.updateConversationCliProfile(convId, cliProfileId, backend || conv.backend);
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
      if (cliProfileId && backend && backend !== backendId) {
        return res.status(400).json({ error: `CLI profile backend ${backendId} does not match requested backend ${backend}` });
      }
      const adapter = backendRegistry.get(backendId);
      if (!adapter) {
        return res.status(400).json({ error: `Unknown backend: ${backendId}` });
      }
      const goals = normalizeGoalCapability(adapter.metadata.capabilities.goals);
      if (!goals.set) {
        return res.status(400).json({ error: unsupportedGoalAction(backendId, 'set').message });
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
      const sendResult = adapter.setGoalObjective(cleanObjective, {
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
      const runtimeGoal = createRuntimeGoalSnapshot({
        backendId,
        objective: cleanObjective,
        sessionId: conv.currentSessionId,
        threadId: conv.externalSessionId || null,
        supportedActions: supportedActionsFromGoalCapability(goals),
      });
      const goalMessage = await persistGoalEventMessage(convId, backendId, goalEventFromGoal('set', runtimeGoal));
      sendIdleGoalFrame(convId, { type: 'goal_updated', goal: runtimeGoal });
      await attachAndPipeStream({
        convId,
        conv,
        backendId,
        runtime,
        adapter,
        sendResult,
        jobId,
        needsTitleUpdate: isNewSession && !conv.titleManuallySet,
        titleUpdateMessage: cleanObjective,
        model: model || conv.model || null,
        effort: effectiveEffort || null,
        serviceTier: effectiveServiceTier || null,
      });
      jobHandedOff = true;
      res.json({ streamReady: true, goal: runtimeGoal, message: goalMessage });
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
      const { runtime, adapter, backendId, goals } = await resolveGoalAdapter(conv);
      if (!goals.resume) throw unsupportedGoalAction(backendId, 'resume');
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
      let resumedGoal: ThreadGoal | null = null;
      try {
        const currentGoal = await adapter.getGoal({
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
        resumedGoal = currentGoal
          ? normalizeGoalSnapshot({ ...currentGoal, status: 'active', updatedAt: Date.now() })
          : null;
      } catch (err: unknown) {
        log.debug('Goal resume could not read current goal snapshot', { conversationId: convId, error: err });
      }
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
      const goalMessage = resumedGoal
        ? await persistGoalEventMessage(convId, backendId, goalEventFromGoal('resumed', resumedGoal))
        : null;
      if (resumedGoal) sendIdleGoalFrame(convId, { type: 'goal_updated', goal: resumedGoal });
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
      res.json({ streamReady: true, goal: resumedGoal, message: goalMessage });
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
      const { runtime, adapter, backendId, goals } = await resolveGoalAdapter(conv);
      if (!goals.pause) throw unsupportedGoalAction(backendId, 'pause');
      const rawGoal = await adapter.pauseGoal({
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
      const goal = rawGoal ? normalizeGoalSnapshot(rawGoal) : null;
      const goalMessage = goal
        ? await persistGoalEventMessage(convId, backendId, goalEventFromGoal('paused', goal))
        : null;
      if (goal) sendIdleGoalFrame(convId, { type: 'goal_updated', goal });
      res.json({ goal, message: goalMessage });
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
      const { runtime, adapter, backendId, goals } = await resolveGoalAdapter(conv);
      if (!goals.clear) throw unsupportedGoalAction(backendId, 'clear');
      if ((backendId === 'claude-code' || backendId === 'claude-code-interactive') && hasInFlightTurn(convId)) {
        return res.status(409).json({ error: 'Cannot clear a Claude Code goal while a turn is active' });
      }
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
      const goalMessage = await persistGoalEventMessage(convId, backendId, clearGoalEvent(backendId));
      sendIdleGoalFrame(convId, { type: 'goal_cleared', threadId: result.threadId || result.sessionId || conv.externalSessionId || conv.currentSessionId || null });
      res.json({ ...result, message: goalMessage });
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
