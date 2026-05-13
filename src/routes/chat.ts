import express from 'express';
import fs from 'fs';
import path from 'path';
import type { ChatService } from '../services/chatService';
import type { BackendRegistry } from '../services/backends/registry';
import type { BaseBackendAdapter } from '../services/backends/base';
import type { UpdateService } from '../services/updateService';
import type { CliUpdateService } from '../services/cliUpdateService';
import type { ClaudePlanUsageService } from '../services/claudePlanUsageService';
import type { KiroPlanUsageService } from '../services/kiroPlanUsageService';
import type { CodexPlanUsageService } from '../services/codexPlanUsageService';
import type { InstallStateService } from '../services/installStateService';
import type { InstallDoctorService } from '../services/installDoctorService';
import { CliProfileAuthService } from '../services/cliProfileAuthService';
import { MemoryWatcher } from '../services/memoryWatcher';
import { createMemoryMcpServer, type MemoryMcpServer } from '../services/memoryMcp';
import { StreamJobSupervisor, type PendingMessageSend } from '../services/streamJobSupervisor';
import { KbIngestionService } from '../services/knowledgeBase/ingestion';
import { KbDigestionService } from '../services/knowledgeBase/digest';
import { KbDreamService } from '../services/knowledgeBase/dream';
import { KbDreamScheduler } from '../services/knowledgeBase/autoDream';
import {
  MemoryReviewScheduler,
} from '../services/memoryReview';
import { ContextMapScheduler, ContextMapService } from '../services/contextMap/service';
import { createContextMapMcpServer, type ContextMapMcpServer } from '../services/contextMap/mcp';
import { WorkspaceTaskQueueRegistry } from '../services/knowledgeBase/workspaceTaskQueue';
import { createKbSearchMcpServer } from '../services/kbSearchMcp';
import { SessionFinalizerQueue, type SessionFinalizerJob } from '../services/sessionFinalizerQueue';
import type { Request, Response, ActiveStreamEntry, ContentBlock, ToolActivity, StreamEvent, WsServerFrame, EffortLevel, ServiceTier, StreamErrorSource, MemoryUpdateEvent, MemoryReviewUpdateEvent, ContextMapUpdateEvent, StreamJobRuntimeInfo, SendMessageResult, ThreadGoal, GoalEvent } from '../types';
import { logger } from '../utils/logger';
import type { WsFunctions } from '../ws';
import { createChatStatusRouter } from './chat/statusRoutes';
import { createCliProfileRouter } from './chat/cliProfileRoutes';
import { createContextMapRouter } from './chat/contextMapRoutes';
import { createConversationRouter } from './chat/conversationRoutes';
import { createExplorerRouter } from './chat/explorerRoutes';
import { createFilesystemRouter } from './chat/filesystemRoutes';
import { createGoalRouter } from './chat/goalRoutes';
import { createKbRouter } from './chat/kbRoutes';
import { createMemoryRouter } from './chat/memoryRoutes';
import { buildMemoryMcpAddendum } from './chat/memoryPrompt';
import { createStreamRouter } from './chat/streamRoutes';
import { createUploadRouter } from './chat/uploadRoutes';
import { createWorkspaceInstructionRouter } from './chat/workspaceInstructionRoutes';
import { clearGoalEvent, formatGoalEventMessage, goalEventDedupeKey, goalEventFromStatus, normalizeGoalSnapshot } from '../services/chat/goalEventMessages';

const log = logger.child({ module: 'chat-routes' });

// ── Stream processing ────────────────────────────────────────────────────────

interface ProcessStreamDeps {
  chatService: ChatService;
  streamSupervisor?: StreamJobSupervisor;
  jobId?: string;
}

/**
 * Processes a CLI stream, accumulating state and emitting typed frames.
 * Transport-agnostic: the caller provides `emit` (WS send/buffer)
 * and `isClosed` (checks whether this server-owned stream was cancelled).
 */
export async function processStream(
  convId: string,
  entry: ActiveStreamEntry,
  emit: (frame: WsServerFrame) => void,
  isClosed: () => boolean,
  onDone: () => void | Promise<void>,
  deps: ProcessStreamDeps,
): Promise<void> {
  const { chatService } = deps;
  const { stream, backend } = entry;

  let fullResponse = '';
  let thinkingText = '';
  let resultText: string | null = null;
  let pendingPlanContent = '';
  let titleUpdateTriggered = false;
  let titleUpdatePromise: Promise<void> | null = null;
  let toolActivityAccumulator: Array<{
    tool: string;
    description: string;
    id: string | null;
    isAgent?: boolean;
    subagentType?: string;
    parentAgentId?: string;
    outcome?: string;
    status?: string;
    startTime: number;
    batchIndex: number;
  }> = [];
  // Monotonic counter used to tag tool activities. All tool_uses emitted
  // between two CLI `user` events (turn_boundaries) share the same batch —
  // those are the parallel tool calls from a single LLM assistant turn.
  let batchIndex = 0;
  // Set when a turn_boundary fires; the next tool_activity advances batchIndex.
  let pendingNewBatch = false;
  // Ordered interleaving of text / thinking / tool blocks as they arrive
  // from the CLI stream. Parallel to the flat `fullResponse` / `thinkingText`
  // / `toolActivityAccumulator` buckets, but preserves the source ordering
  // that those flat accumulators lose. Persisted as `Message.contentBlocks`.
  let blocks: ContentBlock[] = [];

  function appendTextBlock(content: string): void {
    if (!content) return;
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'text') {
      last.content += content;
    } else {
      blocks.push({ type: 'text', content });
    }
  }

  function appendThinkingBlock(content: string): void {
    if (!content) return;
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'thinking') {
      last.content += content;
    } else {
      blocks.push({ type: 'thinking', content });
    }
  }

  function appendArtifactBlock(artifact: NonNullable<Extract<StreamEvent, { type: 'artifact' }>['artifact']>): void {
    blocks.push({ type: 'artifact', artifact });
  }

  function artifactSummary(contentBlocks: ContentBlock[]): string {
    const names = contentBlocks
      .filter((b): b is Extract<ContentBlock, { type: 'artifact' }> => b.type === 'artifact')
      .map(b => b.artifact.title || b.artifact.filename)
      .filter(Boolean);
    if (names.length === 0) return '';
    return names.length === 1 ? `Generated file: ${names[0]}` : `Generated files: ${names.join(', ')}`;
  }

  function hasArtifactBlock(contentBlocks: ContentBlock[]): boolean {
    return contentBlocks.some(b => b.type === 'artifact');
  }

  function patchToolBlock(id: string | null | undefined, outcome: string | undefined, status: string | undefined): void {
    if (!id) return;
    for (const b of blocks) {
      if (b.type === 'tool' && b.activity.id === id) {
        if (outcome !== undefined) b.activity.outcome = outcome || undefined;
        if (status !== undefined) b.activity.status = status || undefined;
        return;
      }
    }
  }

  function computeToolDurations(activities: typeof toolActivityAccumulator): ToolActivity[] {
    if (!activities.length) return [];
    const now = Date.now();
    return activities.map((t, i) => {
      const nextStart = activities[i + 1]?.startTime || now;
      const duration = t.startTime ? nextStart - t.startTime : null;
      const toolEntry: ToolActivity = { tool: t.tool, description: t.description, id: t.id, duration, startTime: t.startTime };
      if (t.isAgent) { toolEntry.isAgent = true; toolEntry.subagentType = t.subagentType; }
      if (t.parentAgentId) { toolEntry.parentAgentId = t.parentAgentId; }
      if (t.outcome) { toolEntry.outcome = t.outcome; }
      if (t.status) { toolEntry.status = t.status; }
      toolEntry.batchIndex = t.batchIndex;
      return toolEntry;
    });
  }

  // Merge the duration-computed tool activities (in order) back into the
  // ordered `blocks` array, returning a fresh ContentBlock[] suitable for
  // persistence. Text / thinking blocks pass through unchanged; each tool
  // block gets replaced with the next entry from `finalTools`, which
  // matches the order tools were pushed onto the accumulator.
  function finalizeBlocks(finalTools: ToolActivity[]): ContentBlock[] {
    let ti = 0;
    return blocks.map(b => {
      if (b.type === 'tool') {
        const next = finalTools[ti++];
        return { type: 'tool', activity: next || b.activity };
      }
      return { ...b };
    });
  }

  let terminalErrorPersisted = false;
  let terminalErrorSeen = false;
  let doneEmitted = false;
  const persistedGoalEventKeys = new Set<string>();

  async function markJobFinalizing(message: string, source: StreamErrorSource): Promise<void> {
    if (!deps.streamSupervisor || !deps.jobId) return;
    try {
      await deps.streamSupervisor.markFinalizing(deps.jobId, deps.streamSupervisor.terminal(message, source));
    } catch (err: unknown) {
      log.warn('Failed to mark stream job finalizing', { conversationId: convId, error: err });
    }
  }

  async function deleteJobBeforeDone(): Promise<void> {
    if (!deps.streamSupervisor || !deps.jobId || entry.jobId !== deps.jobId) return;
    try {
      await deps.streamSupervisor.completeJob(deps.jobId);
      entry.jobId = undefined;
    } catch (err: unknown) {
      log.warn('Failed to delete completed stream job', { conversationId: convId, error: err });
    }
  }

  async function recordJobRuntimeInfo(runtime: StreamJobRuntimeInfo): Promise<void> {
    if (!deps.streamSupervisor || !deps.jobId) return;
    try {
      await deps.streamSupervisor.recordRuntimeInfo(deps.jobId, runtime);
    } catch (err: unknown) {
      log.warn('Failed to record stream runtime info', { conversationId: convId, error: err });
    }
  }

  async function emitDoneIfNeeded(): Promise<void> {
    if (doneEmitted) return;
    if (titleUpdatePromise) await titleUpdatePromise;
    await deleteJobBeforeDone();
    doneEmitted = true;
    emit({ type: 'done' });
  }

  async function flushAccumulatedAssistant(turn: 'progress' | 'final' = 'progress', forceEmit = false): Promise<void> {
    const finalToolActivity = computeToolDurations(toolActivityAccumulator);
    const finalBlocks = finalizeBlocks(finalToolActivity);
    const text = fullResponse.trim() || resultText?.trim() || artifactSummary(finalBlocks);
    const hasPartialState = !!text || !!thinkingText.trim() || finalToolActivity.length > 0 || finalBlocks.length > 0;
    if (!hasPartialState) return;

    const blocksToPersist = [...finalBlocks];
    if (!fullResponse.trim() && resultText?.trim()) {
      blocksToPersist.push({ type: 'text', content: resultText.trim() });
    }

    const assistantMsg = await chatService.addMessage(
      convId,
      'assistant',
      text || 'Partial assistant output before stream failure',
      backend,
      thinkingText.trim() || null,
      finalToolActivity.length > 0 ? finalToolActivity : undefined,
      turn,
      blocksToPersist.length > 0 ? blocksToPersist : undefined,
    );
    if (assistantMsg && (forceEmit || !isClosed())) emit({ type: 'assistant_message', message: assistantMsg });
    if (text) maybeUpdateTitle();

    fullResponse = '';
    thinkingText = '';
    resultText = null;
    toolActivityAccumulator = [];
    blocks = [];
  }

  async function persistTerminalError(message: string, source: StreamErrorSource, forceEmit = false): Promise<void> {
    if (terminalErrorPersisted) return;
    terminalErrorPersisted = true;
    await flushAccumulatedAssistant('progress', forceEmit);
    const errorMsg = await chatService.addStreamErrorMessage(convId, backend, message, source);
    if (errorMsg && (forceEmit || !isClosed())) emit({ type: 'assistant_message', message: errorMsg });
  }

  async function persistGoalSnapshotEvent(goal: ThreadGoal): Promise<void> {
    const goalEvent = goalEventFromStatus(goal);
    if (!goalEvent) return;
    await flushAccumulatedAssistant('final');
    await persistGoalEvent(goalEvent);
  }

  async function persistGoalEvent(goalEvent: GoalEvent): Promise<void> {
    const key = goalEventDedupeKey(goalEvent);
    if (persistedGoalEventKeys.has(key)) return;
    persistedGoalEventKeys.add(key);
    const goalMsg = await chatService.addMessage(
      convId,
      'system',
      formatGoalEventMessage(goalEvent),
      backend,
      null,
      undefined,
      undefined,
      undefined,
      { goalEvent },
    );
    if (goalMsg && !isClosed()) emit({ type: 'assistant_message', message: goalMsg });
  }

  async function finalizeTerminalError(message: string, source: StreamErrorSource, forceEmit = false): Promise<void> {
    if (entry.terminalFinalizing) return entry.terminalFinalizing;
    entry.terminalFinalizing = (async () => {
      terminalErrorSeen = true;
      await markJobFinalizing(message, source);
      await persistTerminalError(message, source, forceEmit);
      const shouldEmitTerminal = forceEmit || !isClosed();
      if (shouldEmitTerminal) emit({ type: 'error', error: message, terminal: true, source });
      if (shouldEmitTerminal && !doneEmitted) {
        await emitDoneIfNeeded();
      }
    })();
    return entry.terminalFinalizing;
  }

  let abortFinalizePromise: Promise<void> | null = null;
  entry.finalizeAbort = async () => {
    if (entry.terminalFinalizing) return entry.terminalFinalizing;
    if (abortFinalizePromise) return abortFinalizePromise;
    abortFinalizePromise = (async () => {
      if (entry.terminalFinalizing) {
        await entry.terminalFinalizing;
        return;
      }
      const abort = entry.abortRequested || {
        message: 'Aborted by user',
        source: 'abort' as StreamErrorSource,
        at: new Date().toISOString(),
      };
      await finalizeTerminalError(abort.message, abort.source, true);
    })();
    return abortFinalizePromise;
  };

  function maybeUpdateTitle() {
    if (titleUpdateTriggered || !entry.needsTitleUpdate || !entry.titleUpdateMessage) return;
    titleUpdateTriggered = true;
    titleUpdatePromise = chatService.generateAndUpdateTitle(convId, entry.titleUpdateMessage)
      .then((newTitle) => {
        if (newTitle && !isClosed()) {
          log.info('Title updated', { conversationId: convId, title: newTitle });
          emit({ type: 'title_updated', title: newTitle });
        }
      })
      .catch((err: Error) => {
        log.error('Failed to update title', { conversationId: convId, error: err });
      });
  }

  try {
    for await (const event of stream) {
      if (isClosed()) break;
      entry.lastEventAt = new Date().toISOString();
      if (entry.abortRequested && !terminalErrorSeen) {
        if (entry.finalizeAbort) {
          await entry.finalizeAbort();
        } else {
          await finalizeTerminalError(entry.abortRequested.message, entry.abortRequested.source);
        }
        break;
      }
      if (terminalErrorSeen) continue;

      if (event.type === 'text') {
        fullResponse += event.content;
        appendTextBlock(event.content);
        emit({ type: 'text', content: event.content });
      } else if (event.type === 'thinking') {
        thinkingText += event.content;
        appendThinkingBlock(event.content);
        emit({ type: 'thinking', content: event.content });
      } else if (event.type === 'tool_outcomes') {
        for (const outcome of (event.outcomes || [])) {
          const match = toolActivityAccumulator.find(t => t.id === outcome.toolUseId);
          if (match) {
            match.outcome = outcome.outcome || undefined;
            match.status = outcome.status || undefined;
          }
          patchToolBlock(outcome.toolUseId, outcome.outcome || undefined, outcome.status || undefined);
        }
        emit({ type: 'tool_outcomes', outcomes: event.outcomes });
      } else if (event.type === 'artifact') {
        let artifact = event.artifact;
        if (!artifact || event.sourcePath || event.dataBase64) {
          artifact = await chatService.createConversationArtifact(convId, {
            sourcePath: event.sourcePath,
            dataBase64: event.dataBase64,
            filename: event.filename || event.artifact?.filename,
            mimeType: event.mimeType || event.artifact?.mimeType,
            title: event.title || event.artifact?.title,
            sourceToolId: event.sourceToolId ?? event.artifact?.sourceToolId ?? null,
          }) || undefined;
        }
        if (artifact) {
          appendArtifactBlock(artifact);
          emit({ type: 'artifact', artifact });
        }
      } else if (event.type === 'turn_boundary') {
        if (fullResponse.trim()) {
          const turnToolActivity = computeToolDurations(toolActivityAccumulator);
          const turnBlocks = finalizeBlocks(turnToolActivity);
          log.debug('Saving intermediate message', { conversationId: convId, length: fullResponse.trim().length, tools: turnToolActivity.length, blocks: turnBlocks.length });
          const intermediateMsg = await chatService.addMessage(convId, 'assistant', fullResponse.trim(), backend, thinkingText.trim() || null, turnToolActivity.length > 0 ? turnToolActivity : undefined, 'progress', turnBlocks.length > 0 ? turnBlocks : undefined);
          if (intermediateMsg) emit({ type: 'assistant_message', message: intermediateMsg });
          maybeUpdateTitle();
          // Only reset when we actually persisted a segment. A tool-only
          // turn_boundary (no text since the last save) keeps its accumulated
          // tools so they ride along with the next segment that has text —
          // otherwise parallel tools executed sequentially by the CLI get
          // dropped after the first boundary.
          fullResponse = '';
          thinkingText = '';
          toolActivityAccumulator = [];
          blocks = [];
        }
        // Any turn_boundary closes the current batch; the next tool_activity
        // will start a new one. Used by the frontend to group parallel tools.
        pendingNewBatch = true;
        emit({ type: 'turn_complete' });
      } else if (event.type === 'tool_activity') {
        if (event.isPlanFile && event.planContent) {
          pendingPlanContent = event.planContent;
        }
        const { type: _t, planContent: _pc, ...rest } = event;
        const restAny = rest as Record<string, unknown>;
        if (restAny.isPlanMode && restAny.planAction === 'exit') {
          const fallbackPlanContent = pendingPlanContent
            || fullResponse.trim()
            || resultText?.trim()
            || '';
          if (fallbackPlanContent) {
            restAny.planContent = fallbackPlanContent;
          }
        }
        if (restAny.isAgent && restAny.id) {
          log.debug('Agent tool activity detected', { id: restAny.id, parentAgentId: restAny.parentAgentId || null });
        }
        emit({ type: 'tool_activity', ...rest } as WsServerFrame);
        if (!event.isPlanMode && !event.isQuestion) {
          if (pendingNewBatch) {
            batchIndex += 1;
            pendingNewBatch = false;
          }
          const startTime = Date.now();
          toolActivityAccumulator.push({
            tool: rest.tool,
            description: rest.description || '',
            id: rest.id || null,
            isAgent: rest.isAgent || undefined,
            subagentType: rest.subagentType || undefined,
            parentAgentId: rest.parentAgentId || undefined,
            startTime,
            batchIndex,
          });
          const blockActivity: ToolActivity = {
            tool: rest.tool,
            description: rest.description || '',
            id: rest.id || null,
            duration: null,
            startTime,
            batchIndex,
          };
          if (rest.isAgent) { blockActivity.isAgent = true; if (rest.subagentType) blockActivity.subagentType = rest.subagentType; }
          if (rest.parentAgentId) blockActivity.parentAgentId = rest.parentAgentId;
          blocks.push({ type: 'tool', activity: blockActivity });
        }
      } else if (event.type === 'result') {
        resultText = event.content;
      } else if (event.type === 'goal_updated') {
        const normalizedGoal = normalizeGoalSnapshot(event.goal);
        emit({ type: 'goal_updated', goal: normalizedGoal });
        await persistGoalSnapshotEvent(normalizedGoal);
      } else if (event.type === 'goal_cleared') {
        emit({ type: 'goal_cleared', threadId: event.threadId });
        await flushAccumulatedAssistant('final');
        await persistGoalEvent(clearGoalEvent(backend));
      } else if (event.type === 'external_session') {
        // Vendor-agnostic: any backend that obtains its own session ID emits
        // this so we can persist it onto the active SessionEntry and rehydrate
        // after a cockpit server restart. Not forwarded to the frontend.
        try {
          await chatService.setExternalSessionId(convId, event.sessionId);
        } catch (err: unknown) {
          log.warn('Failed to persist external session id', { conversationId: convId, error: err });
        }
        await recordJobRuntimeInfo({ externalSessionId: event.sessionId });
      } else if (event.type === 'backend_runtime') {
        // Backend-specific turn/process identifiers are operational metadata
        // for durable supervision. They are not user-visible stream frames.
        if (event.externalSessionId) {
          try {
            await chatService.setExternalSessionId(convId, event.externalSessionId);
          } catch (err: unknown) {
            log.warn('Failed to persist external session id', { conversationId: convId, error: err });
          }
        }
        await recordJobRuntimeInfo({
          externalSessionId: event.externalSessionId,
          activeTurnId: event.activeTurnId,
          processId: event.processId,
        });
      } else if (event.type === 'usage') {
        const skipLedger = backend === 'kiro';
        const updated = await chatService.addUsage(convId, event.usage, backend, event.model, { skipLedger });
        if (!isClosed()) {
          emit({ type: 'usage', usage: updated?.conversationUsage || event.usage, sessionUsage: updated?.sessionUsage });
        }
      } else if (event.type === 'error') {
        log.error('Stream event error', { conversationId: convId, error: event.error, source: event.source || 'backend' });
        if (event.terminal === false) {
          emit({ type: 'error', error: event.error, terminal: false, source: event.source || 'backend' });
        } else {
          await finalizeTerminalError(event.error, event.source || 'backend');
          break;
        }
      } else if (event.type === 'done') {
        const apiErrPattern = /^API Error:\s*\d{3}\s/;
        const finalToolActivity = computeToolDurations(toolActivityAccumulator);
        const finalToolActivityArg = finalToolActivity.length > 0 ? finalToolActivity : undefined;
        const finalBlocks = finalizeBlocks(finalToolActivity);
        const finalBlocksArg = finalBlocks.length > 0 ? finalBlocks : undefined;
        const finalArtifactSummary = artifactSummary(finalBlocks);
        if (terminalErrorPersisted) {
          log.info('Stream done after terminal error', { conversationId: convId });
        } else if (fullResponse.trim()) {
          if (apiErrPattern.test(fullResponse.trim())) {
            const apiError = fullResponse.trim();
            log.info('Stream done with API error in text', { conversationId: convId });
            fullResponse = '';
            thinkingText = '';
            toolActivityAccumulator = [];
            blocks = [];
            await finalizeTerminalError(apiError, 'backend');
          } else {
            log.info('Stream done saving final segment', { conversationId: convId, length: fullResponse.trim().length, tools: finalToolActivity.length, blocks: finalBlocks.length });
            const assistantMsg = await chatService.addMessage(convId, 'assistant', fullResponse.trim(), backend, thinkingText.trim() || null, finalToolActivityArg, 'final', finalBlocksArg);
            if (assistantMsg) emit({ type: 'assistant_message', message: assistantMsg });
            maybeUpdateTitle();
          }
        } else if (resultText && resultText.trim()) {
          log.info('Stream done saving result', { conversationId: convId, length: resultText.trim().length, tools: finalToolActivity.length, blocks: finalBlocks.length });
          // `resultText` is set by backends that emit a final `result` event
          // instead of streaming text deltas. There are no text blocks in
          // `blocks` in that case, so synthesize one so contentBlocks still
          // reflects the saved content faithfully.
          const resultBlocks: ContentBlock[] = finalBlocks.length > 0
            ? [...finalBlocks, { type: 'text', content: resultText.trim() }]
            : [{ type: 'text', content: resultText.trim() }];
          const assistantMsg = await chatService.addMessage(convId, 'assistant', resultText.trim(), backend, thinkingText.trim() || null, finalToolActivityArg, 'final', resultBlocks);
          if (assistantMsg) emit({ type: 'assistant_message', message: assistantMsg });
          maybeUpdateTitle();
        } else if (hasArtifactBlock(finalBlocks)) {
          log.info('Stream done saving artifacts', { conversationId: convId, artifacts: finalBlocks.filter(b => b.type === 'artifact').length, tools: finalToolActivity.length, blocks: finalBlocks.length });
          const assistantMsg = await chatService.addMessage(convId, 'assistant', finalArtifactSummary || 'Generated file', backend, thinkingText.trim() || null, finalToolActivityArg, 'final', finalBlocksArg);
          if (assistantMsg) emit({ type: 'assistant_message', message: assistantMsg });
          maybeUpdateTitle();
        } else {
          log.info('Stream done with no content to save', { conversationId: convId });
        }
        toolActivityAccumulator = [];
        blocks = [];
        await emitDoneIfNeeded();
      }
    }
    if (terminalErrorPersisted && !doneEmitted && !isClosed()) {
      await emitDoneIfNeeded();
    }
  } catch (err: unknown) {
    log.error('Stream exception', { conversationId: convId, error: err });
    if (!isClosed()) {
      await finalizeTerminalError((err as Error).message, 'server');
    }
  } finally {
    await onDone();
  }
}

// ── Router ──────────────────────────────────────────────────────────────────

interface ChatRouterDeps {
  chatService: ChatService;
  backendRegistry: BackendRegistry;
  updateService: UpdateService;
  installStateService?: InstallStateService | null;
  installDoctorService?: InstallDoctorService | null;
  cliUpdateService?: CliUpdateService | null;
  claudePlanUsageService: ClaudePlanUsageService;
  kiroPlanUsageService: KiroPlanUsageService;
  codexPlanUsageService: CodexPlanUsageService;
}

export function createChatRouter({ chatService, backendRegistry, updateService, installStateService = null, installDoctorService = null, cliUpdateService = null, claudePlanUsageService, kiroPlanUsageService, codexPlanUsageService }: ChatRouterDeps) {
  const router = express.Router();

  const streamSupervisor = new StreamJobSupervisor(chatService.baseDir);
  const activeStreams = streamSupervisor.activeStreams;
  const pendingMessageSends = streamSupervisor.pendingMessageSends;
  const streamJobs = streamSupervisor.registry;
  const memoryWatcher = new MemoryWatcher();
  const cliProfileAuth = new CliProfileAuthService(chatService.baseDir);
  // Per-conversation map of last-known memory file fingerprints (filename → sha-ish)
  // used by the watcher to compute `changedFiles` for the `memory_update` WS frame.
  // Cleared when the watcher is unwatched so a re-watched conversation starts fresh.
  const memoryFingerprints = new Map<string, Map<string, string>>();
  let wsFns: Pick<WsFunctions, 'send' | 'isConnected' | 'isStreamAlive' | 'clearBuffer' | 'forEachConnected' | 'startStreamGracePeriod'> | null = null;

  function hasInFlightTurn(convId: string): boolean {
    return streamSupervisor.hasInFlightTurn(convId);
  }

  function hasAnyInFlightTurn(): boolean {
    return streamSupervisor.hasAnyInFlightTurn();
  }

  async function requestPendingAbort(convId: string): Promise<boolean> {
    return streamSupervisor.requestPendingAbort(convId);
  }

  async function finalizePendingAbortIfRequested(convId: string, backend: string, pending: PendingMessageSend): Promise<boolean> {
    const abort = pending.abortRequested;
    if (!abort) return false;
    await streamSupervisor.markFinalizing(pending.jobId, abort);
    if (wsFns) wsFns.clearBuffer(convId);
    const errorMsg = await chatService.addStreamErrorMessage(convId, backend, abort.message, abort.source);
    if (wsFns && errorMsg) wsFns.send(convId, { type: 'assistant_message', message: errorMsg });
    if (wsFns) {
      wsFns.send(convId, { type: 'error', error: abort.message, terminal: true, source: abort.source });
      wsFns.send(convId, { type: 'done' });
    }
    memoryMcp.revokeMemoryMcpSession(convId);
    kbSearchMcp.revokeKbSearchSession(convId);
    contextMapMcp.revokeContextMapMcpSession(convId);
    await streamSupervisor.completeJob(pending.jobId);
    return true;
  }

  async function abortActiveStream(convId: string): Promise<boolean> {
    const entry = activeStreams.get(convId);
    if (!entry) return false;

    const message = 'Aborted by user';
    const terminalAlreadyFinalizing = !!entry.terminalFinalizing;
    if (terminalAlreadyFinalizing && entry.done) {
      try {
        await entry.done;
      } catch {
        // The terminal finalizer remains authoritative; callers only need
        // this path to wait until processStream has cleaned up runtime state.
      }
      return true;
    }
    if (!entry.abortRequested) {
      if (!terminalAlreadyFinalizing) {
        await streamSupervisor.requestRuntimeAbort(entry, message);
        log.info('Aborting active stream', { conversationId: convId });

        try {
          entry.abort();
        } catch (err: unknown) {
          log.warn('Stream abort threw', { conversationId: convId, error: err });
        }

        if (wsFns) wsFns.clearBuffer(convId);
      }
    }

    try {
      if (!entry.abortFinalizing) {
        entry.abortFinalizing = (async () => {
          if (entry.finalizeAbort) {
            await entry.finalizeAbort();
          } else {
            const errorMsg = await chatService.addStreamErrorMessage(convId, entry.backend, message, 'abort');
            if (wsFns && errorMsg) wsFns.send(convId, { type: 'assistant_message', message: errorMsg });
            if (wsFns) {
              wsFns.send(convId, { type: 'error', error: message, terminal: true, source: 'abort' });
              wsFns.send(convId, { type: 'done' });
            }
          }
        })();
      }
      await entry.abortFinalizing;
    } catch (err: unknown) {
      log.error('Failed to persist stream abort', { conversationId: convId, error: err });
      if (wsFns) {
        wsFns.send(convId, { type: 'error', error: message, terminal: true, source: 'abort' });
        wsFns.send(convId, { type: 'done' });
      }
    }

    streamSupervisor.detachRuntime(convId, entry);
    if (entry.jobId) {
      await streamSupervisor.completeJob(entry.jobId);
      entry.jobId = undefined;
    }
    memoryWatcher.unwatch(convId);
    memoryFingerprints.delete(convId);
    return true;
  }

  function hasMatchingTerminalStreamError(
    messages: import('../types').Message[],
    message: string,
    source: StreamErrorSource,
  ): boolean {
    const last = messages[messages.length - 1];
    return !!last
      && last.role === 'assistant'
      && !!last.streamError
      && last.streamError.message === message
      && last.streamError.source === source;
  }

  async function reconcileInterruptedJobs(): Promise<{ interrupted: number; removed: number }> {
    const jobs = await streamJobs.listActive();
    let interrupted = 0;
    let removed = 0;

    for (const job of jobs) {
      const convId = job.conversationId;
      if (activeStreams.has(convId) || pendingMessageSends.has(convId)) {
        continue;
      }

      const terminal = job.terminalError
        || job.abortRequested
        || {
          message: 'Interrupted by server restart',
          source: 'server' as StreamErrorSource,
          at: new Date().toISOString(),
        };

      await streamSupervisor.markFinalizing(job.id, terminal);

      const conv = await chatService.getConversation(convId);
      const userMessageStillExists = !!job.userMessageId
        && !!conv
        && conv.messages.some((msg) => msg.id === job.userMessageId);

      if (conv && userMessageStillExists) {
        if (!hasMatchingTerminalStreamError(conv.messages, terminal.message, terminal.source)) {
          await chatService.addStreamErrorMessage(convId, job.backend || conv.backend, terminal.message, terminal.source);
        }
        interrupted += 1;
      } else {
        removed += 1;
      }

      await streamSupervisor.completeJob(job.id);
    }

    return { interrupted, removed };
  }

  /**
   * Fan out a `kb_state_update` frame to every conversation with an OPEN
   * WebSocket whose workspace matches the event — regardless of whether
   * that conv has an active agent stream. This is what lets the composer
   * KB status icon update in real time while the user is idle in the
   * conversation (e.g. after uploading files via the KB Browser).
   */
  function broadcastKbStateUpdate(hash: string, frame: import('../types').KbStateUpdateEvent): void {
    if (!wsFns) return;
    const sent = new Set<string>();
    wsFns.forEachConnected((convId) => {
      if (chatService.getWorkspaceHashForConv(convId) !== hash) return;
      if (sent.has(convId)) return;
      sent.add(convId);
      wsFns!.send(convId, frame);
    });
  }

  function broadcastMemoryUpdate(hash: string, frame: MemoryUpdateEvent): void {
    if (!wsFns) return;
    const sent = new Set<string>();
    const sourceConversationId = frame.sourceConversationId || null;
    const wantsChatDisplay = frame.displayInChat === undefined
      ? !!sourceConversationId
      : frame.displayInChat === true;
    wsFns.forEachConnected((convId) => {
      if (chatService.getWorkspaceHashForConv(convId) !== hash) return;
      if (sent.has(convId)) return;
      sent.add(convId);
      wsFns!.send(convId, {
        ...frame,
        sourceConversationId,
        displayInChat: wantsChatDisplay && sourceConversationId === convId,
      });
    });
  }

  function broadcastMemoryReviewUpdate(hash: string, frame: MemoryReviewUpdateEvent): void {
    if (!wsFns) return;
    const sent = new Set<string>();
    wsFns.forEachConnected((convId) => {
      if (chatService.getWorkspaceHashForConv(convId) !== hash) return;
      if (sent.has(convId)) return;
      sent.add(convId);
      wsFns!.send(convId, frame);
    });
  }

  function broadcastContextMapUpdate(hash: string, frame: ContextMapUpdateEvent): void {
    if (!wsFns) return;
    const sent = new Set<string>();
    wsFns.forEachConnected((convId) => {
      if (chatService.getWorkspaceHashForConv(convId) !== hash) return;
      if (sent.has(convId)) return;
      sent.add(convId);
      wsFns!.send(convId, frame);
    });
  }

  async function emitFreshContextMapUpdate(hash: string): Promise<void> {
    const contextMap = await chatService.getContextMapStatus(hash);
    broadcastContextMapUpdate(hash, {
      type: 'context_map_update',
      updatedAt: new Date().toISOString(),
      contextMap,
    });
  }

  // Per-workspace task queue registry. Shared between the ingestion and
  // digestion services so `Settings.knowledgeBase.cliConcurrency` is a
  // unified budget across both pipelines per workspace. Folder ops use
  // `runBarrier` to drain in-flight ingestions before mutating shared
  // structure (raw_locations rows that reference folder paths).
  const kbQueueRegistry = new WorkspaceTaskQueueRegistry();

  // Knowledge Base ingestion orchestrator. Dispatches format handlers
  // (pdf/docx/pptx/passthrough) onto the shared queue and emits
  // `kb_state_update` frames when the DB changes.
  const kbIngestion = new KbIngestionService({
    chatService,
    emit: broadcastKbStateUpdate,
    backendRegistry,
    queueRegistry: kbQueueRegistry,
  });

  // Knowledge Base digestion orchestrator. Runs the configured Digestion
  // CLI in `runOneShot` mode against each raw file's converted text and
  // writes the resulting entries back into the DB + `entries/` tree.
  const kbDigestion = new KbDigestionService({
    chatService,
    backendRegistry,
    emit: broadcastKbStateUpdate,
    queueRegistry: kbQueueRegistry,
  });
  // Late-bind the circular ingestion ↔ digestion dependency so that
  // files auto-digest on ingestion completion when the workspace has
  // `kbAutoDigest=true`.
  kbIngestion.setDigestTrigger(kbDigestion);

  // KB Search MCP server — exposes search and ingestion tools to CLIs
  // during both dreaming and conversation sessions.
  const kbSearchMcp = createKbSearchMcpServer({ chatService, kbIngestion });
  router.use('/mcp', kbSearchMcp.router);

  // Knowledge Base dreaming orchestrator. Runs the configured Dreaming CLI to
  // synthesize entries into a knowledge graph of topics and connections.
  // Manual triggers use POST /kb/dream or /kb/redream; KbDreamScheduler can
  // also start incremental runs from per-workspace Auto-Dream settings.
  const kbDreaming = new KbDreamService({
    chatService,
    backendRegistry,
    emit: broadcastKbStateUpdate,
    kbSearchMcp,
  });
  const kbDreamScheduler = new KbDreamScheduler({ chatService, kbDreaming });

  // Memory MCP server — exposes `memory_search` and `memory_note` tools via
  // the stdio stub in `src/services/memoryMcp/stub.cjs`.  The router is mounted
  // at `/mcp/memory/notes` below; the `issue`/`revoke` helpers are used by
  // the Kiro backend wiring to hand out per-session bearer tokens.
  const memoryMcp: MemoryMcpServer = createMemoryMcpServer({
    chatService,
    backendRegistry,
    emitMemoryUpdate: broadcastMemoryUpdate,
    emitMemoryReviewUpdate: broadcastMemoryReviewUpdate,
  });
  router.use('/mcp', memoryMcp.router);
  const memoryReviewScheduler = new MemoryReviewScheduler({ chatService, runner: memoryMcp });

  // Context Map MCP server — read-only graph retrieval for active chat CLIs.
  const contextMapMcp: ContextMapMcpServer = createContextMapMcpServer({ chatService });
  router.use('/mcp', contextMapMcp.router);

  // Context Map processor. Incremental spans are extracted into pending review
  // candidates before the service advances conversation cursors.
  const contextMapService = new ContextMapService({
    chatService,
    backendRegistry,
    emitUpdate: emitFreshContextMapUpdate,
  });
  const contextMapScheduler = new ContextMapScheduler({
    chatService,
    processor: contextMapService,
  });

  async function runSessionFinalizerJob(job: SessionFinalizerJob): Promise<void> {
    if (job.type === 'session_summary') {
      const summary = await chatService.generateAndStoreSessionSummary(job.conversationId, job.sessionNumber, {
        backendId: readStringPayload(job, 'backendId') || undefined,
        cliProfileId: readStringPayload(job, 'cliProfileId') || undefined,
      });
      if (summary) {
        log.info('Session finalizer summary updated', { conversationId: job.conversationId, sessionNumber: job.sessionNumber });
      }
      return;
    }

    if (job.type === 'memory_extraction') {
      if (!(await chatService.getWorkspaceMemoryEnabled(job.workspaceHash))) return;
      const runtime = await chatService.resolveCliProfileRuntime(
        readStringPayload(job, 'cliProfileId') || undefined,
        readStringPayload(job, 'backendId') || undefined,
      );
      const snapshot = await chatService.captureWorkspaceMemory(job.conversationId, runtime.backendId, runtime.profile);
      if (snapshot) {
        log.info('Session finalizer captured memory files', { conversationId: job.conversationId, fileCount: snapshot.files.length });
      }
      const messages = await chatService.getSessionMessages(job.conversationId, job.sessionNumber);
      if (messages?.length) {
        const savedCount = await memoryMcp.extractMemoryFromSession({
          workspaceHash: job.workspaceHash,
          conversationId: job.conversationId,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });
        if (savedCount > 0) {
          log.info('Session finalizer saved memory entries', { conversationId: job.conversationId, savedCount });
        }
      }
      return;
    }

    const source = readStringPayload(job, 'source');
    if (source !== 'session_reset' && source !== 'archive') {
      throw new Error(`Unknown Context Map finalizer source: ${source || '(missing)'}`);
    }
    if (!(await chatService.getWorkspaceContextMapEnabled(job.workspaceHash))) return;
    const result = await contextMapService.processConversationSession(
      job.workspaceHash,
      job.conversationId,
      job.sessionNumber,
      { source },
    );
    if (result.skippedReason === 'already-running') {
      throw new Error('Context Map processor already running');
    }
    if (result.runId) {
      log.info('Context Map finalizer pass completed', { source, conversationId: job.conversationId, sessionNumber: job.sessionNumber, runId: result.runId, spansInserted: result.spansInserted });
    }
  }

  const sessionFinalizers = new SessionFinalizerQueue({
    workspacesDir: chatService.workspacesDir,
    handleJob: runSessionFinalizerJob,
  });
  void sessionFinalizers.start().catch((err: unknown) => {
    log.warn('Session finalizer startup scan failed', { error: err });
  });

  function readStringPayload(job: SessionFinalizerJob, key: string): string | null {
    const value = job.payload?.[key];
    return typeof value === 'string' && value ? value : null;
  }

  async function enqueueSessionSummaryFinalizer(
    workspaceHash: string,
    convId: string,
    sessionNumber: number,
    runtime: Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>> | null,
  ): Promise<void> {
    await sessionFinalizers.enqueue({
      workspaceHash,
      conversationId: convId,
      sessionNumber,
      type: 'session_summary',
      payload: {
        ...(runtime?.backendId ? { backendId: runtime.backendId } : {}),
        ...(runtime?.cliProfileId ? { cliProfileId: runtime.cliProfileId } : {}),
      },
    });
  }

  async function enqueueMemoryFinalizer(
    workspaceHash: string,
    convId: string,
    sessionNumber: number,
    runtime: Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>> | null,
  ): Promise<void> {
    if (!(await chatService.getWorkspaceMemoryEnabled(workspaceHash))) return;
    await sessionFinalizers.enqueue({
      workspaceHash,
      conversationId: convId,
      sessionNumber,
      type: 'memory_extraction',
      payload: {
        ...(runtime?.backendId ? { backendId: runtime.backendId } : {}),
        ...(runtime?.cliProfileId ? { cliProfileId: runtime.cliProfileId } : {}),
      },
    });
  }

  async function enqueueContextMapFinalizer(
    workspaceHash: string,
    convId: string,
    sessionNumber: number,
    source: 'session_reset' | 'archive',
  ): Promise<void> {
    if (!(await chatService.getWorkspaceContextMapEnabled(workspaceHash))) return;
    await sessionFinalizers.enqueue({
      workspaceHash,
      conversationId: convId,
      sessionNumber,
      type: 'context_map_conversation_final_pass',
      payload: { source },
    });
  }

  function fingerprintMemoryFiles(snapshot: { files: Array<{ filename: string; content: string }> }): Map<string, string> {
    const fp = new Map<string, string>();
    for (const f of snapshot.files) {
      // Cheap content fingerprint: length + first 32 chars hash via djb2.
      // Good enough to detect edits without pulling in crypto.
      let hash = 5381;
      const sample = f.content.slice(0, 256);
      for (let i = 0; i < sample.length; i++) hash = ((hash << 5) + hash) ^ sample.charCodeAt(i);
      fp.set(f.filename, `${f.content.length}:${(hash >>> 0).toString(36)}`);
    }
    return fp;
  }

  function diffFingerprints(prev: Map<string, string> | undefined, next: Map<string, string>): string[] {
    const changed: string[] = [];
    for (const [filename, fp] of next) {
      if (!prev || prev.get(filename) !== fp) changed.push(filename);
    }
    return changed;
  }

  router.use(createCliProfileRouter({ chatService, backendRegistry, cliProfileAuth }));
  router.use(createConversationRouter({
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
    clearWsBuffer: (convId) => { if (wsFns) wsFns.clearBuffer(convId); },
    enqueueSessionSummaryFinalizer,
    enqueueMemoryFinalizer,
    enqueueContextMapFinalizer,
  }));
  router.use(createContextMapRouter({ chatService, contextMapService, emitFreshContextMapUpdate }));
  router.use(createExplorerRouter(chatService));
  router.use(createGoalRouter({
    chatService,
    backendRegistry,
    streamSupervisor,
    hasInFlightTurn,
    finalizePendingAbortIfRequested,
    attachAndPipeStream,
    buildGoalRunEnvironment,
    sendIdleGoalFrame: (convId, frame) => {
      if (wsFns && !activeStreams.has(convId)) wsFns.send(convId, frame);
    },
  }));
  router.use(createKbRouter({ chatService, kbIngestion, kbDigestion, kbDreaming, broadcastKbStateUpdate }));
  router.use(createMemoryRouter({ chatService, memoryMcp, broadcastMemoryUpdate }));
  router.use(createFilesystemRouter());
  router.use(createStreamRouter({
    chatService,
    backendRegistry,
    streamSupervisor,
    streamJobs,
    activeStreams,
    pendingMessageSends,
    memoryMcp,
    kbSearchMcp,
    contextMapMcp,
    hasInFlightTurn,
    requestPendingAbort,
    abortActiveStream,
    finalizePendingAbortIfRequested,
    attachAndPipeStream,
    isWsConnected: (convId) => wsFns ? wsFns.isConnected(convId) : false,
  }));
  router.use(createUploadRouter({ chatService, backendRegistry }));
  router.use(createWorkspaceInstructionRouter(chatService));
  router.use(createChatStatusRouter({
    chatService,
    backendRegistry,
    updateService,
    installStateService,
    installDoctorService,
    cliUpdateService,
    claudePlanUsageService,
    kiroPlanUsageService,
    codexPlanUsageService,
    hasAnyInFlightTurn,
  }));

  async function attachAndPipeStream(args: {
    convId: string;
    conv: NonNullable<Awaited<ReturnType<ChatService['getConversation']>>>;
    backendId: string;
    runtime: Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>>;
    adapter: BaseBackendAdapter;
    sendResult: SendMessageResult;
    jobId: string;
    needsTitleUpdate: boolean;
    titleUpdateMessage: string | null;
    model: string | null;
    effort: EffortLevel | null;
    serviceTier?: ServiceTier | null;
    logUserMessageId?: string | null;
    logUserMessageTimestamp?: string | null;
  }): Promise<void> {
    const {
      convId,
      conv,
      backendId,
      runtime,
      adapter,
      sendResult,
      jobId,
      needsTitleUpdate,
      titleUpdateMessage,
      model,
      effort,
      serviceTier = null,
      logUserMessageId = null,
      logUserMessageTimestamp = null,
    } = args;
    const { stream, abort, sendInput } = sendResult;
    const startedAt = new Date().toISOString();
    streamSupervisor.attachRuntime(convId, {
      stream,
      abort,
      sendInput,
      backend: backendId,
      needsTitleUpdate,
      titleUpdateMessage,
      startedAt,
      lastEventAt: startedAt,
      jobId,
    });
    try {
      await streamSupervisor.markRunning(jobId, {
        startedAt,
        lastEventAt: startedAt,
        model,
        effort,
        serviceTier,
      });
    } catch (err: unknown) {
      log.warn('Failed to mark stream job running', { conversationId: convId, error: err });
    }
    const activeEntry = activeStreams.get(convId)!;
    log.debug('Active stream attached', { conversationId: convId, backend: backendId, userMessageId: logUserMessageId, userMessageTimestamp: logUserMessageTimestamp });

    if (wsFns) {
      wsFns.clearBuffer(convId);
      if (!wsFns.isConnected(convId)) {
        wsFns.startStreamGracePeriod(convId);
      }

      const watchWorkspaceHash = chatService.getWorkspaceHashForConv(convId);
      const memoryOnForWatch = watchWorkspaceHash
        ? await chatService.getWorkspaceMemoryEnabled(watchWorkspaceHash)
        : false;
      const watchWorkspacePath = conv.workingDir || adapter.workingDir || null;
      if (memoryOnForWatch && watchWorkspaceHash && watchWorkspacePath) {
        const memDir = adapter.getMemoryDir(watchWorkspacePath, { cliProfile: runtime.profile });
        if (memDir) {
          try {
            fs.mkdirSync(memDir, { recursive: true });
          } catch (err: unknown) {
            log.warn('Memory watcher directory create failed', { conversationId: convId, path: memDir, error: err });
          }
          memoryWatcher.watch(convId, memDir, async () => {
            try {
              const snapshot = await chatService.captureWorkspaceMemory(convId, backendId, runtime.profile);
              if (snapshot) {
                log.info('Memory watcher recaptured memory files', { conversationId: convId, backend: backendId, fileCount: snapshot.files.length });
                const nextFp = fingerprintMemoryFiles(snapshot);
                const changedFiles = diffFingerprints(memoryFingerprints.get(convId), nextFp);
                memoryFingerprints.set(convId, nextFp);
                broadcastMemoryUpdate(watchWorkspaceHash, {
                  type: 'memory_update',
                  capturedAt: snapshot.capturedAt,
                  fileCount: snapshot.files.length,
                  changedFiles,
                  sourceConversationId: convId,
                  displayInChat: true,
                });
              }
            } catch (err: unknown) {
              log.error('Memory watcher capture failed', { conversationId: convId, error: err });
            }
          });
        }
      }

      const streamDone = processStream(
        convId,
        activeEntry,
        (frame) => { wsFns!.send(convId, frame); },
        () => activeStreams.get(convId) !== activeEntry,
        async () => {
          streamSupervisor.detachRuntime(convId, activeEntry);
          if (activeEntry.jobId) {
            try {
              await streamSupervisor.completeJob(activeEntry.jobId);
              activeEntry.jobId = undefined;
            } catch (err: unknown) {
              log.warn('Failed to delete completed stream job', { conversationId: convId, error: err });
            }
          }
          memoryWatcher.unwatch(convId);
          memoryFingerprints.delete(convId);
          if (backendId === 'claude-code') {
            claudePlanUsageService.maybeRefresh('turn-done', runtime.profile);
          } else if (backendId === 'kiro') {
            kiroPlanUsageService.maybeRefresh('turn-done');
          } else if (backendId === 'codex') {
            codexPlanUsageService.maybeRefresh('turn-done', runtime.profile);
          }
        },
        { chatService, streamSupervisor, jobId },
      ).catch((err) => {
        log.error('WebSocket stream processing failed', { conversationId: convId, error: err });
        if (wsFns) {
          wsFns.send(convId, { type: 'error', error: (err as Error).message, terminal: true, source: 'server' });
          wsFns.send(convId, { type: 'done' });
        }
        streamSupervisor.detachRuntime(convId, activeEntry);
        if (activeEntry.jobId) {
          void streamSupervisor.completeJob(activeEntry.jobId).catch((deleteErr: unknown) => {
            log.warn('Failed to delete stream job', { conversationId: convId, error: deleteErr });
          });
        }
        memoryWatcher.unwatch(convId);
        memoryFingerprints.delete(convId);
      });
      activeEntry.done = streamDone;
    }
  }

  async function buildGoalRunEnvironment(convId: string, isNewSession: boolean): Promise<{
    systemPrompt: string;
    mcpServers?: import('../types').McpServerConfig[];
  }> {
    const wsHash = chatService.getWorkspaceHashForConv(convId);
    const memoryEnabled = wsHash
      ? await chatService.getWorkspaceMemoryEnabled(wsHash)
      : false;
    const kbEnabled = wsHash
      ? await chatService.getWorkspaceKbEnabled(wsHash)
      : false;
    const contextMapEnabled = wsHash
      ? await chatService.getWorkspaceContextMapEnabled(wsHash)
      : false;
    const needsMemoryMcp = memoryEnabled && !!wsHash;
    const needsKbMcp = kbEnabled && !!wsHash;
    const needsContextMapMcp = contextMapEnabled && !!wsHash;

    let systemPrompt = '';
    if (isNewSession) {
      const settings = await chatService.getSettings();
      const globalPrompt = settings.systemPrompt || '';
      const wsInstructions = wsHash ? (await chatService.getWorkspaceInstructions(wsHash)) || '' : '';
      const contextPointers: string[] = [];
      const ctx = chatService.getWorkspaceContext(convId);
      if (ctx) contextPointers.push(ctx);
      if (wsHash) {
        const memPointer = await chatService.getWorkspaceMemoryPointer(wsHash);
        if (memPointer) contextPointers.push(memPointer);
        const kbPointer = await chatService.getWorkspaceKbPointer(wsHash);
        if (kbPointer) contextPointers.push(kbPointer);
      }
      const memoryMcpAddendum = needsMemoryMcp ? buildMemoryMcpAddendum() : '';
      const kbMcpAddendum = needsKbMcp
        ? (() => {
            const kbPath = path.resolve(chatService.getKbKnowledgeDir(wsHash!));
            return [
              '# Knowledge Base',
              'You have access to a workspace knowledge base via MCP tools (from the `agent-cockpit-kb-search` server) and the local filesystem.',
              '',
              '## Search tools (use these to find relevant knowledge)',
              '- `search_topics(query)` — semantic + keyword search across all synthesized topics. Returns topic IDs, titles, summaries, and scores.',
              '- `search_entries(query)` — semantic + keyword search across all digested entries. Returns entry IDs, titles, summaries, and scores.',
              '- `get_topic(topic_id)` — full topic content, connections, and assigned entry list.',
              '- `get_topic_neighborhood(topic_id, depth?, limit?, min_confidence?, include_entries?)` — graph neighbors connected through synthesized relationships.',
              '- `find_similar_topics(topic_id)` — topics with similar embeddings.',
              '- `find_unconnected_similar(topic_id)` — similar topics with no existing connection.',
              '- `list_documents(query?)` — list converted source documents and unit counts.',
              '- `get_document_structure(raw_id)` — inspect page, slide, section, or fallback ranges without reading full content.',
              '- `get_source_range(raw_id, start_unit, end_unit)` — read a bounded converted source range with referenced media paths.',
              '- `kb_ingest(file_path)` — ingest a local file into the knowledge base.',
              '',
              '## Reading full content (use after search narrows results)',
              `- Entries: \`${kbPath}/entries/<entryId>/entry.md\` — YAML frontmatter (title, tags, source) + digested markdown body.`,
              `- Synthesis: \`${kbPath}/synthesis/*.md\` — cross-entry topic synthesis.`,
              `- Reflections: \`${kbPath}/synthesis/reflections/*.md\` — cross-topic insights, patterns, contradictions, and gaps (generated during dreaming).`,
              `- DB: \`${kbPath}/state.db\` — SQLite index of raw files, folders, and entries.`,
              '',
              '## Workflow',
              'Use search tools first to find relevant topics and entries by semantic meaning. For large source documents, inspect structure first, then fetch only the needed source ranges. Search narrows the space; targeted reads give you depth.',
            ].join('\n');
          })()
        : '';
      const contextMapMcpAddendum = needsContextMapMcp
        ? [
            '# Context Map',
            'You have read-only Context Map MCP tools (from the `agent-cockpit-context-map` server). Use them when the user asks about durable workspace entities, people, projects, workflows, decisions, tools, assets, relationships, or prior context that should be grounded in active graph data.',
            '',
            'Tools:',
            '- `entity_search(query, types?, limit?)` — search active entities by name, alias, and non-secret summary/notes/facts.',
            '- `get_entity(id, includeEvidence?)` — inspect one entity with aliases, facts, one-hop relationships, and optional evidence references.',
            '- `get_related_entities(id, depth?, relationshipTypes?, limit?)` — traverse active relationships around an entity.',
            '- `context_pack(query, maxEntities?, includeFiles?, includeConversations?)` — retrieve a compact bundle for the current request.',
            '',
            'Context Map tools are read-only. Do not try to update the map from chat; new or changed graph items are governed through Agent Cockpit review.',
          ].join('\n')
        : '';
      const fileDeliveryAddendum = [
        '# File delivery',
        'When the user explicitly asks you to create, generate, or give them a downloadable file (e.g. "give me a CSV", "create a report file", "export this as JSON"), follow these steps:',
        '1. Create the file in the current working directory.',
        '2. After creating the file, output a reference on its own line using this exact format:',
        '   <!-- FILE_DELIVERY:/absolute/path/to/file.ext -->',
        '3. You may include multiple FILE_DELIVERY markers if the user asks for multiple files.',
        '',
        'Do NOT use FILE_DELIVERY for files you create as part of normal coding tasks (editing source code, config files, etc.). Only use it when the user explicitly wants a deliverable file to download.',
      ].join('\n');
      const parts = [globalPrompt, wsInstructions, ...contextPointers, memoryMcpAddendum, kbMcpAddendum, contextMapMcpAddendum, fileDeliveryAddendum].filter(Boolean);
      systemPrompt = parts.join('\n\n');
    }

    let mcpServers: import('../types').McpServerConfig[] | undefined;
    if (needsMemoryMcp && wsHash) {
      let activeChatRuntime: Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>> | undefined;
      try {
        const conv = await chatService.getConversation(convId);
        if (conv) {
          activeChatRuntime = await chatService.resolveCliProfileRuntime(conv.cliProfileId, conv.backend);
        }
      } catch (err: unknown) {
        log.warn('Unable to attach active chat profile to memory MCP session', {
          conversationId: convId,
          error: err,
        });
      }
      const issued = memoryMcp.issueMemoryMcpSession(convId, wsHash, { activeChatRuntime });
      mcpServers = issued.mcpServers;
      log.debug('Issued memory MCP token', { conversationId: convId, backend: 'codex' });
    }
    if (needsKbMcp && wsHash) {
      const kbIssued = kbSearchMcp.issueKbSearchSession(convId, wsHash);
      mcpServers = [...(mcpServers || []), ...kbIssued.mcpServers];
      log.debug('Issued KB Search MCP token', { conversationId: convId, backend: 'codex' });
    }
    if (needsContextMapMcp && wsHash) {
      const contextMapIssued = contextMapMcp.issueContextMapMcpSession(convId, wsHash);
      mcpServers = [...(mcpServers || []), ...contextMapIssued.mcpServers];
      log.debug('Issued Context Map MCP token', { conversationId: convId, backend: 'codex' });
    }

    return { systemPrompt, mcpServers };
  }

  // ── Shutdown helper ────────────────────────────────────────────────────────
  async function shutdown() {
    try {
      await streamSupervisor.prepareForShutdown();
    } catch (err: unknown) {
      log.warn('Failed to mark active stream jobs interrupted during shutdown', { error: err });
    }
    streamSupervisor.abortAndDetachAllRuntime();
    kbDreamScheduler.stop();
    memoryReviewScheduler.stop();
    contextMapScheduler.stop();
    sessionFinalizers.stop();
    memoryWatcher.unwatchAll();
    memoryFingerprints.clear();
    chatService.closeContextMapDatabases();
    cliProfileAuth.shutdown();
    if (updateService) updateService.stop();
    if (cliUpdateService) cliUpdateService.stop();
  }

  function setWsFunctions(fns: Pick<WsFunctions, 'send' | 'isConnected' | 'isStreamAlive' | 'clearBuffer' | 'forEachConnected' | 'startStreamGracePeriod'>) {
    wsFns = fns;
  }

  return { router, shutdown, activeStreams, streamJobs, setWsFunctions, abortActiveStream, reconcileInterruptedJobs, memoryMcp, contextMapMcp, kbDreamScheduler, memoryReviewScheduler, contextMapService, contextMapScheduler, sessionFinalizers };
}
