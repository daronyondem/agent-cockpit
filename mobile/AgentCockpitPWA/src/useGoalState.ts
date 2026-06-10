import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { AgentAPIError } from './api';
import {
  applyConversationRuntimeSelection,
  cleanGoalObjectiveText,
  goalActionUnsupportedMessage,
  goalCapabilityForBackend,
  goalSnapshotTimeMs,
  goalSupportsAction,
  isActiveGoal,
  isClaudeBackend,
  shouldApplyGoalSnapshot,
  shouldPreserveLocalRuntimeGoal,
  wireContent,
} from './appModel';
import type { AgentCockpitAPI } from './api';
import type {
  BackendMetadata,
  ClaudeCodeMode,
  Conversation,
  EffortLevel,
  Message,
  PendingAttachment,
  PendingInteraction,
  QueuedMessage,
  ServiceTier,
  ThreadGoal,
} from './types';
import type { GoalCapability } from './appModel';

type UseGoalStateOptions = {
  activeConversation: Conversation | null;
  activeConversationRef: RefObject<Conversation | null>;
  backends: BackendMetadata[];
  clientRef: RefObject<AgentCockpitAPI>;
  profileMetadata: Record<string, BackendMetadata>;
  selectedBackend: string | undefined;
  selectedBackendID: string | undefined;
  selectedCliProfileId: string | undefined;
  selectedModel: string | undefined;
  selectedEffort: EffortLevel | undefined;
  claudeCodeModeForRequest: ClaudeCodeMode | null | undefined;
  claudeCodeModeForSelection: ClaudeCodeMode | null | undefined;
  selectedServiceTier: ServiceTier | 'default' | undefined;
  selectedGoalCapability: GoalCapability;
  goalCapable: boolean;
  serviceTierEnabled: boolean;
  isStreaming: boolean;
  startStream: (conversationID: string) => void;
  setDraft: Dispatch<SetStateAction<string>>;
  setPendingAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  setPendingInteraction: Dispatch<SetStateAction<PendingInteraction | null>>;
  setActiveConversation: Dispatch<SetStateAction<Conversation | null>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  applyServerMessage: (conversationID: string, message: Message | null | undefined) => void;
  onError: (error: unknown) => void;
};

export function useGoalState(options: UseGoalStateOptions) {
  const goalUpdatedAtByConversationRef = useRef<Map<string, number>>(new Map());
  const goalStateRef = useRef<{ conversationID: string | null; goal: ThreadGoal | null; updatedAtMs: number | null }>({
    conversationID: null,
    goal: null,
    updatedAtMs: null,
  });
  const [activeGoalIDs, setActiveGoalIDs] = useState<Set<string>>(new Set());
  const [goal, setGoal] = useState<ThreadGoal | null>(null);
  const [goalUpdatedAtMs, setGoalUpdatedAtMs] = useState<number | null>(null);
  const [goalMode, setGoalMode] = useState(false);

  useEffect(() => {
    if (!options.goalCapable && goalMode) {
      setGoalMode(false);
    }
  }, [options.goalCapable, goalMode]);

  function clearOpenGoalState(conversationID: string | null = options.activeConversationRef.current?.id || null) {
    goalStateRef.current = { conversationID, goal: null, updatedAtMs: null };
    setGoal(null);
    setGoalUpdatedAtMs(null);
  }

  function commitGoalSnapshot(conversationID: string, nextGoal: ThreadGoal | null, timestampMs: number | null) {
    if (timestampMs) {
      goalUpdatedAtByConversationRef.current.set(conversationID, timestampMs);
    } else {
      goalUpdatedAtByConversationRef.current.delete(conversationID);
    }

    setActiveGoalIDs((current) => {
      const next = new Set(current);
      if (isActiveGoal(nextGoal)) next.add(conversationID);
      else next.delete(conversationID);
      return next;
    });

    if (options.activeConversationRef.current?.id === conversationID) {
      goalStateRef.current = {
        conversationID,
        goal: nextGoal,
        updatedAtMs: timestampMs,
      };
      setGoal(nextGoal);
      setGoalUpdatedAtMs(timestampMs);
    }
  }

  function applyGoalSnapshot(conversationID: string, nextGoal: ThreadGoal | null): boolean {
    const currentTimestamp = goalUpdatedAtByConversationRef.current.get(conversationID) || null;
    if (!shouldApplyGoalSnapshot(currentTimestamp, nextGoal)) {
      return false;
    }

    const nextTimestamp = nextGoal ? goalSnapshotTimeMs(nextGoal) || currentTimestamp : Date.now();
    commitGoalSnapshot(conversationID, nextGoal, nextTimestamp || null);
    return true;
  }

  async function refreshGoalState(conversationID = options.activeConversationRef.current?.id) {
    const conversation = options.activeConversationRef.current;
    if (!conversationID || !conversation || conversation.id !== conversationID) {
      return null;
    }
    const conversationGoalCapability = goalCapabilityForBackend(
      options.backends,
      conversation.backend,
      conversation.cliProfileId ? options.profileMetadata[conversation.cliProfileId] : undefined,
    );
    if (conversationGoalCapability.status === 'none') {
      applyGoalSnapshot(conversationID, null);
      return null;
    }
    if (!conversation.externalSessionId && conversation.backend === 'codex') {
      if (!goalStateRef.current.goal) applyGoalSnapshot(conversationID, null);
      return goalStateRef.current.goal;
    }
    try {
      const response = await options.clientRef.current.getGoal(conversationID);
      if (!response.goal && shouldPreserveLocalRuntimeGoal(goalStateRef.current, conversationID)) {
        return goalStateRef.current.goal;
      }
      applyGoalSnapshot(conversationID, response.goal || null);
      return response.goal || null;
    } catch {
      return null;
    }
  }

  async function setGoalNow(message: QueuedMessage) {
    const conversation = options.activeConversation;
    if (!conversation) {
      return;
    }
    if (!options.goalCapable) {
      options.setErrorMessage('Goals are not available for this backend.');
      return;
    }
    const objective = cleanGoalObjectiveText(wireContent(message));
    if (!objective) {
      return;
    }
    const previousGoal = goalStateRef.current.conversationID === conversation.id ? goalStateRef.current.goal : null;
    const previousGoalUpdatedAtMs = goalStateRef.current.conversationID === conversation.id ? goalStateRef.current.updatedAtMs : null;
    const goalStartedAtMs = Date.now();
    const runtimeSelection = {
      backend: options.selectedBackendID || options.selectedBackend || conversation.backend || '',
      cliProfileId: options.selectedCliProfileId,
      model: options.selectedModel,
      effort: options.selectedEffort,
      claudeCodeMode: options.claudeCodeModeForSelection,
      serviceTier: options.serviceTierEnabled ? options.selectedServiceTier : undefined,
    };
    const optimisticBackend = options.selectedBackendID === 'codex' || isClaudeBackend(options.selectedBackendID)
      ? options.selectedBackendID as ThreadGoal['backend']
      : undefined;
    const optimisticGoal: ThreadGoal = {
      backend: optimisticBackend,
      objective,
      status: 'active',
      supportedActions: {
        clear: true,
        stopTurn: true,
        pause: options.selectedGoalCapability.pause,
        resume: options.selectedGoalCapability.resume,
      },
      tokenBudget: null,
      tokensUsed: null,
      timeUsedSeconds: 0,
      createdAt: goalStartedAtMs,
      updatedAt: goalStartedAtMs,
      source: 'runtime',
    };
    try {
      options.setDraft('');
      options.setPendingAttachments([]);
      options.setPendingInteraction(null);
      commitGoalSnapshot(conversation.id, optimisticGoal, goalStartedAtMs);
      const response = await options.clientRef.current.setGoal(conversation.id, {
        objective,
        backend: options.selectedBackend,
        cliProfileId: options.selectedCliProfileId,
        model: options.selectedModel,
        effort: options.selectedEffort,
        claudeCodeMode: options.claudeCodeModeForRequest,
        serviceTier: options.serviceTierEnabled ? options.selectedServiceTier : undefined,
      });
      if (response.goal) applyGoalSnapshot(conversation.id, response.goal);
      options.applyServerMessage(conversation.id, response.message);
      setGoalMode(false);
      options.setActiveConversation((current) => {
        if (!current || current.id !== conversation.id) return current;
        const next = applyConversationRuntimeSelection(current, runtimeSelection);
        options.activeConversationRef.current = next;
        return next;
      });
      if (response.streamReady !== false) {
        options.startStream(conversation.id);
      }
    } catch (error) {
      options.setDraft(message.content);
      commitGoalSnapshot(conversation.id, previousGoal, previousGoalUpdatedAtMs);
      if (error instanceof AgentAPIError && error.status === 409) {
        options.startStream(conversation.id);
        return;
      }
      options.onError(error);
    }
  }

  async function pauseGoalNow() {
    const conversation = options.activeConversation;
    if (!conversation || !goal) {
      return;
    }
    if (!goalSupportsAction(goal, 'pause')) {
      options.setErrorMessage(goalActionUnsupportedMessage('pause', goal.backend || conversation.backend));
      return;
    }
    try {
      const response = await options.clientRef.current.pauseGoal(conversation.id);
      applyGoalSnapshot(conversation.id, response.goal || null);
      options.applyServerMessage(conversation.id, response.message);
    } catch (error) {
      options.onError(error);
    }
  }

  async function resumeGoalNow() {
    const conversation = options.activeConversation;
    if (!conversation || !goal || options.isStreaming) {
      return;
    }
    if (!goalSupportsAction(goal, 'resume')) {
      options.setErrorMessage(goalActionUnsupportedMessage('resume', goal.backend || conversation.backend));
      return;
    }
    const previousGoal = goal;
    commitGoalSnapshot(conversation.id, { ...goal, status: 'active', updatedAt: Date.now() }, goalSnapshotTimeMs(goal) || Date.now());
    try {
      const response = await options.clientRef.current.resumeGoal(conversation.id);
      if (response.goal) applyGoalSnapshot(conversation.id, response.goal);
      options.applyServerMessage(conversation.id, response.message);
      if (response.streamReady !== false) {
        options.startStream(conversation.id);
      }
    } catch (error) {
      commitGoalSnapshot(conversation.id, previousGoal, Date.now());
      if (error instanceof AgentAPIError && error.status === 409) {
        options.startStream(conversation.id);
        return;
      }
      options.onError(error);
    }
  }

  async function clearGoalNow() {
    const conversation = options.activeConversation;
    if (!conversation || !goal) {
      return;
    }
    if (!goalSupportsAction(goal, 'clear')) {
      options.setErrorMessage(goalActionUnsupportedMessage('clear', goal.backend || conversation.backend));
      return;
    }
    if (isClaudeBackend(goal.backend) && options.isStreaming) {
      options.setErrorMessage('Wait for the current stream to finish before clearing this Claude Code goal.');
      return;
    }
    const previousGoal = goal;
    applyGoalSnapshot(conversation.id, null);
    try {
      const response = await options.clientRef.current.clearGoal(conversation.id);
      options.applyServerMessage(conversation.id, response.message);
    } catch (error) {
      commitGoalSnapshot(conversation.id, previousGoal, Date.now());
      options.onError(error);
    }
  }

  return {
    activeGoalIDs,
    goal,
    goalUpdatedAtMs,
    goalMode,
    setGoalMode,
    clearOpenGoalState,
    applyGoalSnapshot,
    refreshGoalState,
    setGoalNow,
    pauseGoalNow,
    resumeGoalNow,
    clearGoalNow,
  };
}
