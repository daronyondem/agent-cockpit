import type { BrowserStreamFrame, StreamErrorSource } from '../../../../src/contracts/streamFrames';
import type {
  Conversation,
  ContentBlock,
  Message,
  QueuedMessage,
  ThreadGoal,
  ToolActivity,
  Usage,
} from '../../../../src/contracts/responses';

export const AFTER_ASSISTANT_MESSAGE_RECONCILE_DELAY_MS = 5000;

export type StreamUiState = 'streaming' | 'awaiting' | 'error' | null;

export type PendingInteraction =
  | { type: 'planApproval'; planContent: string }
  | { type: 'userQuestion'; question: string; options: Array<{ label: string; description?: string }> };

export interface StreamMemoryUpdateMessage {
  id: string;
  role: 'memory';
  timestamp: string;
  memoryUpdate: {
    capturedAt: string;
    fileCount: number;
    changedFiles: string[];
    sourceConversationId: string | null;
    writeOutcomes: Record<string, unknown>[];
  };
}

export type StreamStoreMessage = Message | StreamMemoryUpdateMessage;

export type StreamConversationStatus = Record<string, unknown>;

export type StreamConversationKbStatus = StreamConversationStatus & {
  dreamingStopping?: boolean;
  dreamingStatus?: string;
  _dreamProgress?: unknown;
};

export type StreamConversation = Conversation & {
  kb?: StreamConversationKbStatus | null;
  workspaceContext?: StreamConversationStatus | null;
};

export interface StreamReducerState {
  convId: string;
  conv: StreamConversation | null;
  messages: StreamStoreMessage[];
  streaming: boolean;
  streamError: string | null;
  streamErrorSource: StreamErrorSource | null;
  usage: Usage | null;
  streamingMsgId: string | null;
  replayActive: boolean;
  lastFrameAtMs: number | null;
  wsReconnectAttempts: number;
  uiState: StreamUiState;
  unread: boolean;
  pendingInteraction: PendingInteraction | null;
  goal: ThreadGoal | null;
  goalUpdatedAtMs: number | null;
  queue: QueuedMessage[];
  planModeActive: boolean;
}

export type StreamReducerEffect =
  | { type: 'bumpConversationListActivity'; timestamp?: string }
  | { type: 'patchConversationListItem'; patch: Record<string, unknown> }
  | { type: 'markConversationUnread' }
  | { type: 'refreshConversation' }
  | { type: 'refreshPlanUsage' }
  | { type: 'drainQueue' }
  | { type: 'scheduleReconcile'; delayMs?: number }
  | { type: 'clearReconnectTimer' }
  | { type: 'clearReconcileTimer' }
  | { type: 'dispatchMemoryUpdate'; detail: Record<string, unknown> }
  | { type: 'dispatchWorkspaceContextUpdate'; detail: Record<string, unknown> }
  | { type: 'dispatchKbStateUpdate'; detail: Record<string, unknown> }
  | { type: 'warn'; message: string };

export interface StreamReducerContext {
  activeConvId?: string | null;
  hasActiveSocket?: boolean;
  memoryMessageId?: string;
  placeholderId?: string;
  nowMs: number;
}

export interface StreamReducerResult {
  state: StreamReducerState;
  effects: StreamReducerEffect[];
}

export function reduceStreamFrame(
  state: StreamReducerState,
  frame: BrowserStreamFrame,
  context: StreamReducerContext,
): StreamReducerResult {
  const effects: StreamReducerEffect[] = [];
  let next: StreamReducerState = {
    ...state,
    lastFrameAtMs: context.nowMs,
  };

  const withEffects = (stateWithFrame: StreamReducerState): StreamReducerResult => ({
    state: stateWithFrame,
    effects,
  });

  if (frame.type === 'text') {
    return withEffects(appendTextOrThinking(next, 'text', stringOrEmpty(frame.content), context));
  }
  if (frame.type === 'thinking') {
    return withEffects(appendTextOrThinking(next, 'thinking', stringOrEmpty(frame.content), context));
  }
  if (frame.type === 'tool_activity') {
    if (frame.isPlanMode) {
      if (frame.planAction === 'enter') {
        return withEffects({ ...next, planModeActive: true });
      }
      if (frame.planAction === 'exit') {
        return withEffects({
          ...next,
          pendingInteraction: {
            type: 'planApproval',
            planContent: stringOrEmpty(frame.planContent),
          },
          planModeActive: false,
          uiState: 'awaiting',
        });
      }
      return withEffects(next);
    }
    if (frame.isQuestion) {
      const question = firstQuestion(frame);
      return withEffects({
        ...next,
        pendingInteraction: {
          type: 'userQuestion',
          question: question.question,
          options: question.options,
        },
        uiState: 'awaiting',
      });
    }
    return withEffects(pushToolBlock(next, {
      tool: typeof frame.tool === 'string' ? frame.tool : '',
      description: stringOrEmpty(frame.description),
      id: typeof frame.id === 'string' && frame.id ? frame.id : null,
      duration: null,
      startTime: context.nowMs,
      isAgent: frame.isAgent || undefined,
      subagentType: typeof frame.subagentType === 'string' && frame.subagentType ? frame.subagentType : undefined,
      parentAgentId: typeof frame.parentAgentId === 'string' && frame.parentAgentId ? frame.parentAgentId : undefined,
    }, context));
  }
  if (frame.type === 'tool_outcomes') {
    return withEffects(patchToolOutcomes(next, Array.isArray(frame.outcomes) ? frame.outcomes : [], context.nowMs));
  }
  if (frame.type === 'artifact') {
    return withEffects(pushArtifactBlock(next, frame.artifact, context));
  }
  if (frame.type === 'goal_updated') {
    return withEffects(applyGoalSnapshot(next, frame.goal || null, context.nowMs));
  }
  if (frame.type === 'goal_cleared') {
    return withEffects(applyGoalSnapshot(next, null, context.nowMs));
  }
  if (frame.type === 'assistant_message') {
    if (!frame.message) return withEffects(next);
    const isGoalEventMessage = !!frame.message?.goalEvent;
    next = applyAssistantMessage(next, frame.message);
    if (!isGoalEventMessage && context.hasActiveSocket && (next.streaming || next.uiState === 'streaming')) {
      effects.push({ type: 'scheduleReconcile', delayMs: AFTER_ASSISTANT_MESSAGE_RECONCILE_DELAY_MS });
    }
    if (frame.message?.timestamp) {
      effects.push({ type: 'bumpConversationListActivity', timestamp: frame.message.timestamp });
    } else {
      effects.push({ type: 'bumpConversationListActivity' });
    }
    return withEffects(next);
  }
  if (frame.type === 'turn_complete') {
    return withEffects(next);
  }
  if (frame.type === 'replay_start') {
    effects.push({ type: 'clearReconcileTimer' });
    return withEffects(applyReplayStart(next));
  }
  if (frame.type === 'replay_end') {
    next = { ...next, replayActive: false };
    if (context.hasActiveSocket && (next.streaming || next.uiState === 'streaming')) {
      effects.push({ type: 'scheduleReconcile' });
    }
    return withEffects(next);
  }
  if (frame.type === 'title_updated') {
    if (typeof frame.title !== 'string') return withEffects(next);
    next = {
      ...next,
      conv: next.conv ? { ...next.conv, title: frame.title } : next.conv,
    };
    effects.push({ type: 'patchConversationListItem', patch: { title: frame.title } });
    return withEffects(next);
  }
  if (frame.type === 'usage') {
    return withEffects(frame.sessionUsage ? { ...next, usage: frame.sessionUsage } : next);
  }
  if (frame.type === 'error') {
    const message = typeof frame.error === 'string' ? frame.error : 'Stream error';
    if (frame.terminal === false) {
      effects.push({ type: 'warn', message });
      return withEffects(next);
    }
    return withEffects({
      ...next,
      streamError: message,
      streamErrorSource: typeof frame.source === 'string' ? frame.source : null,
      uiState: 'error',
      pendingInteraction: null,
      planModeActive: false,
    });
  }
  if (frame.type === 'done') {
    const wasLocallyStreaming = !!state.streaming;
    const markUnread = wasLocallyStreaming
      && state.convId !== context.activeConvId
      && !state.streamError
      && !state.pendingInteraction;
    effects.push({ type: 'clearReconnectTimer' });
    effects.push({ type: 'clearReconcileTimer' });
    if (markUnread) effects.push({ type: 'markConversationUnread' });
    if (wasLocallyStreaming) {
      effects.push({ type: 'refreshPlanUsage' });
      effects.push({ type: 'drainQueue' });
    }
    return withEffects({
      ...next,
      messages: next.streamingMsgId
        ? next.messages.filter(message => (
          message.id !== next.streamingMsgId || shouldKeepStreamingMessage(message)
        ))
        : next.messages,
      streaming: false,
      streamingMsgId: null,
      planModeActive: false,
      replayActive: false,
      wsReconnectAttempts: 0,
      uiState: next.streamError ? 'error' : next.pendingInteraction ? 'awaiting' : null,
      unread: markUnread ? true : next.unread,
    });
  }
  if (frame.type === 'memory_update') {
    return withEffects(applyMemoryUpdate(next, frame, context, effects));
  }
  if (frame.type === 'workspace_context_update') {
    return withEffects(applyConversationStatusUpdate(next, 'workspaceContext', frame.workspaceContext || null, frame.updatedAt || null, effects));
  }
  if (frame.type === 'kb_state_update') {
    return withEffects(applyKbStateUpdate(next, frame.changed, effects));
  }
  return withEffects(next);
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isoFromMs(value: number): string {
  return new Date(value).toISOString();
}

function goalTimestampMs(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1e12 ? Math.floor(n) : Math.floor(n * 1000);
}

function goalSnapshotTimeMs(goal: ThreadGoal | null): number | null {
  if (!goal || typeof goal !== 'object') return null;
  return goalTimestampMs(goal.updatedAt) || goalTimestampMs(goal.createdAt);
}

function applyGoalSnapshot(state: StreamReducerState, goal: ThreadGoal | null, nowMs: number): StreamReducerState {
  if (!goal) {
    return { ...state, goal: null, goalUpdatedAtMs: nowMs };
  }
  const incomingAt = goalSnapshotTimeMs(goal);
  if (incomingAt && state.goalUpdatedAtMs && incomingAt < state.goalUpdatedAtMs) return state;
  return {
    ...state,
    goal,
    goalUpdatedAtMs: incomingAt || state.goalUpdatedAtMs || null,
  };
}

function ensurePlaceholder(state: StreamReducerState, context: StreamReducerContext): {
  state: StreamReducerState;
  placeholderId: string | null;
} {
  if (state.streamingMsgId) return { state, placeholderId: state.streamingMsgId };
  const placeholderId = context.placeholderId || `pending-assistant-${context.nowMs}`;
  const message: Message = {
    id: placeholderId,
    role: 'assistant',
    content: '',
    backend: state.conv?.backend || '',
    timestamp: isoFromMs(context.nowMs),
    contentBlocks: [],
  };
  return {
    state: {
      ...state,
      streamingMsgId: placeholderId,
      messages: [...state.messages, message],
    },
    placeholderId,
  };
}

function appendTextOrThinking(
  state: StreamReducerState,
  kind: 'text' | 'thinking',
  content: string,
  context: StreamReducerContext,
): StreamReducerState {
  if (!content) return state;
  const ensured = ensurePlaceholder(state, context);
  if (!ensured.placeholderId) return ensured.state;
  const messages = ensured.state.messages.map(message => {
    if (message.id !== ensured.placeholderId || message.role === 'memory') return message;
    const blocks = Array.isArray(message.contentBlocks) ? [...message.contentBlocks] : [];
    const last = blocks[blocks.length - 1];
    if (last && last.type === kind) {
      blocks[blocks.length - 1] = { type: kind, content: `${last.content || ''}${content}` };
    } else {
      blocks.push({ type: kind, content });
    }
    const nextContent = blocks
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.content)
      .join('');
    return { ...message, contentBlocks: blocks, content: nextContent };
  });
  return { ...ensured.state, messages };
}

function pushToolBlock(
  state: StreamReducerState,
  activity: ToolActivity,
  context: StreamReducerContext,
): StreamReducerState {
  const ensured = ensurePlaceholder(state, context);
  if (!ensured.placeholderId) return ensured.state;
  return {
    ...ensured.state,
    messages: ensured.state.messages.map(message => {
      if (message.id !== ensured.placeholderId || message.role === 'memory') return message;
      const blocks = Array.isArray(message.contentBlocks) ? [...message.contentBlocks] : [];
      blocks.push({ type: 'tool', activity });
      return { ...message, contentBlocks: blocks };
    }),
  };
}

function pushArtifactBlock(
  state: StreamReducerState,
  artifact: Extract<BrowserStreamFrame, { type: 'artifact' }>['artifact'],
  context: StreamReducerContext,
): StreamReducerState {
  if (!artifact || !artifact.filename) return state;
  const ensured = ensurePlaceholder(state, context);
  if (!ensured.placeholderId) return ensured.state;
  return {
    ...ensured.state,
    messages: ensured.state.messages.map(message => {
      if (message.id !== ensured.placeholderId || message.role === 'memory') return message;
      const blocks = Array.isArray(message.contentBlocks) ? [...message.contentBlocks] : [];
      blocks.push({ type: 'artifact', artifact });
      const content = message.content || artifact.title || artifact.filename || 'Generated file';
      return { ...message, contentBlocks: blocks, content };
    }),
  };
}

function patchToolOutcomes(
  state: StreamReducerState,
  outcomes: NonNullable<Extract<BrowserStreamFrame, { type: 'tool_outcomes' }>['outcomes']>,
  nowMs: number,
): StreamReducerState {
  const id = state.streamingMsgId;
  if (!id || !outcomes.length) return state;
  let anyChanged = false;
  const messages = state.messages.map(message => {
    if (message.id !== id || message.role === 'memory' || !Array.isArray(message.contentBlocks)) return message;
    let changed = false;
    const blocks = message.contentBlocks.map(block => {
      if (block.type !== 'tool') return block;
      const outcome = outcomes.find(item => item.toolUseId && block.activity.id === item.toolUseId);
      if (!outcome) return block;
      changed = true;
      anyChanged = true;
      const duration = block.activity.duration != null
        ? block.activity.duration
        : block.activity.startTime ? Math.max(0, nowMs - block.activity.startTime) : null;
      return {
        type: 'tool' as const,
        activity: {
          ...block.activity,
          outcome: outcome.outcome || undefined,
          status: outcome.status || undefined,
          duration,
        },
      };
    });
    return changed ? { ...message, contentBlocks: blocks } : message;
  });
  return anyChanged ? { ...state, messages } : state;
}

function applyAssistantMessage(state: StreamReducerState, message: Message): StreamReducerState {
  if (!message) return state;
  if (message.goalEvent) {
    const existing = message.id ? state.messages.findIndex(item => item.id === message.id) : -1;
    if (existing >= 0) {
      const messages = state.messages.slice();
      messages[existing] = message;
      return { ...state, messages };
    }
    const placeholderIndex = state.streamingMsgId
      ? state.messages.findIndex(item => item.id === state.streamingMsgId)
      : -1;
    if (placeholderIndex >= 0) {
      const messages = state.messages.slice();
      messages.splice(placeholderIndex, 0, message);
      return { ...state, messages };
    }
    return { ...state, messages: [...state.messages, message] };
  }

  const placeholderId = state.streamingMsgId;
  const incomingId = message.id;
  const duplicateExists = !!incomingId && state.messages.some(item => item.id === incomingId && item.id !== placeholderId);
  const cleaned = duplicateExists
    ? state.messages.filter(item => item.id !== incomingId)
    : state.messages;
  const placeholderStillPresent = !!placeholderId && cleaned.some(item => item.id === placeholderId);
  const messages = placeholderStillPresent
    ? cleaned.map(item => item.id === placeholderId ? message : item)
    : [...cleaned, message];
  const isFinalTurn = message.turn === 'final';
  return {
    ...state,
    messages,
    streamingMsgId: null,
    pendingInteraction: isFinalTurn ? null : state.pendingInteraction,
    uiState: isFinalTurn && state.pendingInteraction
      ? (state.streaming ? 'streaming' : state.streamError ? 'error' : null)
      : state.uiState,
  };
}

function applyReplayStart(state: StreamReducerState): StreamReducerState {
  if (!state.streamingMsgId) return { ...state, replayActive: true };
  return {
    ...state,
    replayActive: true,
    messages: state.messages.map(message => {
      if (message.id !== state.streamingMsgId || message.role === 'memory') return message;
      return { ...message, contentBlocks: [], content: '' };
    }),
    pendingInteraction: null,
    planModeActive: false,
  };
}

function shouldKeepStreamingMessage(message: StreamStoreMessage): boolean {
  if (message.role === 'memory') return true;
  return !!(
    (message.content && String(message.content).trim())
    || (Array.isArray(message.contentBlocks) && message.contentBlocks.length)
    || message.streamError
  );
}

function firstQuestion(frame: Extract<BrowserStreamFrame, { type: 'tool_activity' }>): PendingInteraction & { type: 'userQuestion' } {
  const questions = Array.isArray(frame.questions) ? frame.questions : [];
  const first = questions[0] as unknown;
  if (typeof first === 'string') {
    return { type: 'userQuestion', question: first, options: [] };
  }
  if (first && typeof first === 'object') {
    const record = first as { question?: unknown; options?: unknown };
    return {
      type: 'userQuestion',
      question: typeof record.question === 'string' && record.question
        ? record.question
        : stringOrEmpty(frame.description) || 'Input needed',
      options: Array.isArray(record.options)
        ? record.options.filter(isQuestionOption)
        : [],
    };
  }
  return {
    type: 'userQuestion',
    question: stringOrEmpty(frame.description) || 'Input needed',
    options: [],
  };
}

function isQuestionOption(value: unknown): value is { label: string; description?: string } {
  return !!value
    && typeof value === 'object'
    && typeof (value as { label?: unknown }).label === 'string'
    && (
      (value as { description?: unknown }).description === undefined
      || typeof (value as { description?: unknown }).description === 'string'
    );
}

function workspaceRefForConv(conv: StreamConversation | null): string | null {
  return conv ? (conv.workspaceId || conv.workspaceHash || null) : null;
}

function applyMemoryUpdate(
  state: StreamReducerState,
  frame: Extract<BrowserStreamFrame, { type: 'memory_update' }>,
  context: StreamReducerContext,
  effects: StreamReducerEffect[],
): StreamReducerState {
  const changedFiles = Array.isArray(frame.changedFiles) ? frame.changedFiles : [];
  const writeOutcomes = Array.isArray(frame.writeOutcomes) ? frame.writeOutcomes : [];
  const fileCount = typeof frame.fileCount === 'number' ? frame.fileCount : 0;
  const capturedAt = typeof frame.capturedAt === 'string' ? frame.capturedAt : isoFromMs(context.nowMs);
  const sourceConversationId = typeof frame.sourceConversationId === 'string' ? frame.sourceConversationId : null;
  const displayInChat = frame.displayInChat === true;
  const workspaceRef = workspaceRefForConv(state.conv);
  if (workspaceRef) {
    effects.push({
      type: 'dispatchMemoryUpdate',
      detail: {
        hash: workspaceRef,
        capturedAt,
        fileCount,
        changedFiles,
        sourceConversationId,
        displayInChat,
        writeOutcomes,
      },
    });
  }
  if (!displayInChat) return state;
  const message: StreamMemoryUpdateMessage = {
    id: context.memoryMessageId || `mem_${capturedAt}_${context.nowMs}`,
    role: 'memory',
    timestamp: capturedAt,
    memoryUpdate: {
      capturedAt,
      fileCount,
      changedFiles,
      sourceConversationId,
      writeOutcomes,
    },
  };
  return { ...state, messages: [...state.messages, message] };
}

function applyConversationStatusUpdate(
  state: StreamReducerState,
  field: 'workspaceContext',
  value: Record<string, unknown> | null,
  updatedAt: string | null,
  effects: StreamReducerEffect[],
): StreamReducerState {
  if (!state.conv) return state;
  const workspaceRef = workspaceRefForConv(state.conv);
  if (workspaceRef) {
    effects.push({
      type: 'dispatchWorkspaceContextUpdate',
      detail: { hash: workspaceRef, workspaceContext: value, updatedAt },
    });
  }
  return {
    ...state,
    conv: {
      ...state.conv,
      [field]: value,
    },
  };
}

function applyKbStateUpdate(
  state: StreamReducerState,
  changedValue: unknown,
  effects: StreamReducerEffect[],
): StreamReducerState {
  if (!state.conv) return state;
  const changed = isRecord(changedValue) ? changedValue : {};
  const workspaceRef = workspaceRefForConv(state.conv);
  if (workspaceRef) {
    effects.push({ type: 'dispatchKbStateUpdate', detail: { hash: workspaceRef, changed } });
  }
  if (!state.conv.kb) {
    return state;
  }
  const kb: StreamConversationKbStatus = { ...state.conv.kb };
  if (changed.stopping) kb.dreamingStopping = true;
  if (changed.dreamProgress) {
    kb.dreamingStatus = 'running';
    kb._dreamProgress = changed.dreamProgress;
  }
  const next = { ...state, conv: { ...state.conv, kb } };
  if (kbNeedsConversationRefresh(changed)) {
    effects.push({ type: 'refreshConversation' });
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function kbNeedsConversationRefresh(changed: Record<string, unknown>): boolean {
  return (
    (changed.synthesis === true && changed.stopping !== true)
    || (Array.isArray(changed.raw) && changed.raw.length > 0)
    || (Array.isArray(changed.entries) && changed.entries.length > 0)
    || (
      isRecord(changed.digestion)
      && typeof changed.digestion.active === 'boolean'
    )
  );
}
