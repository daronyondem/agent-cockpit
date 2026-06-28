import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { AgentAPIError } from './api';
import {
  applyConversationRuntimeSelection,
  completedAttachmentMetas,
  conversationForSend,
  goalActionUnsupportedMessage,
  parseGoalSlashCommand,
  reconcileRecoveredSendConversation,
  removeMessagesByID,
  replaceMessageByID,
  wireContent,
} from './appModel';
import type { AgentCockpitAPI } from './api';
import type {
  AttachmentMeta,
  ClaudeCodeMode,
  Conversation,
  EffortLevel,
  PendingAttachment,
  PendingInteraction,
  QueuedMessage,
  ServiceTier,
} from './types';
import type { GoalCapability } from './appModel';

type SendMessageResult =
  | { ok: true }
  | { ok: false; reason: 'busy' | 'failed' | 'active-stream-recovered'; error?: unknown };

type UseSendPipelineOptions = {
  activeConversation: Conversation | null;
  activeConversationRef: RefObject<Conversation | null>;
  clientRef: RefObject<AgentCockpitAPI>;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  pendingAttachments: PendingAttachment[];
  setPendingAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  hasUploadingAttachments: boolean;
  pendingInteraction: PendingInteraction | null;
  setPendingInteraction: Dispatch<SetStateAction<PendingInteraction | null>>;
  interactionAnswer: string;
  setInteractionAnswer: Dispatch<SetStateAction<string>>;
  loading: boolean;
  goalMode: boolean;
  setGoalMode: Dispatch<SetStateAction<boolean>>;
  goalCapable: boolean;
  selectedGoalCapability: GoalCapability;
  selectedBackendID: string | undefined;
  selectedBackend: string | undefined;
  selectedCliProfileId: string | undefined;
  selectedModel: string | undefined;
  selectedEffort: EffortLevel | undefined;
  claudeCodeModeForRequest: ClaudeCodeMode | null | undefined;
  claudeCodeModeForSelection: ClaudeCodeMode | null | undefined;
  selectedServiceTier: ServiceTier | 'default' | undefined;
  serviceTierEnabled: boolean;
  isStreaming: boolean;
  startStream: (conversationID: string) => void;
  markStreamFinished: (conversationID: string) => void;
  recoverActiveStream: (conversationID: string, options?: { onlyIfServerActive?: boolean }) => Promise<boolean>;
  setStreamText: Dispatch<SetStateAction<string>>;
  setShowStreamPlaceholder: Dispatch<SetStateAction<boolean>>;
  setIsStreaming: (value: boolean) => void;
  setActiveStreamIDs: Dispatch<SetStateAction<Set<string>>>;
  setActiveConversation: Dispatch<SetStateAction<Conversation | null>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setGoalNow: (message: QueuedMessage) => Promise<void>;
  pauseGoalNow: () => Promise<void>;
  resumeGoalNow: () => Promise<void>;
  clearGoalNow: () => Promise<void>;
  onError: (error: unknown) => void;
};

function isAlreadyStreamingError(error: unknown): error is AgentAPIError {
  return error instanceof AgentAPIError
    && error.status === 409
    && /conversation is already streaming/i.test(error.message);
}

export function useSendPipeline(options: UseSendPipelineOptions) {
  const sendInFlightRef = useRef(false);
  const [isSending, setIsSending] = useState(false);

  async function sendDraft() {
    if (sendInFlightRef.current) {
      return;
    }
    const content = options.draft.trim();
    const attachments = completedAttachmentMetas(options.pendingAttachments);
    if (options.pendingInteraction) {
      options.setErrorMessage('Answer the prompt above to continue.');
      return;
    }
    if (options.hasUploadingAttachments) {
      return;
    }
    if (handleGoalSlash(content, attachments)) {
      return;
    }
    if (!content && !attachments.length) {
      return;
    }
    if (options.goalMode) {
      if (options.isStreaming) {
        options.setErrorMessage('Wait for the current stream to finish before setting a goal.');
        return;
      }
      await options.setGoalNow({ content, attachments: attachments.length ? attachments : undefined });
      return;
    }
    if (options.isStreaming) {
      await enqueueDraft();
      return;
    }
    await sendMessageNow({ content, attachments: attachments.length ? attachments : undefined });
  }

  function handleGoalSlash(content: string, attachments: AttachmentMeta[]): boolean {
    const command = parseGoalSlashCommand(content);
    if (!command) {
      return false;
    }
    if (!options.goalCapable) {
      options.setErrorMessage('Goals are not available for this backend.');
      return true;
    }
    if (command.kind === 'enter-goal-mode') {
      options.setDraft('');
      options.setGoalMode(true);
      options.setErrorMessage(null);
      return true;
    }
    options.setDraft('');
    if (command.kind === 'pause') {
      if (!options.selectedGoalCapability.pause) {
        options.setErrorMessage(goalActionUnsupportedMessage('pause', options.selectedBackendID));
        return true;
      }
      void options.pauseGoalNow();
      return true;
    }
    if (command.kind === 'resume') {
      if (!options.selectedGoalCapability.resume) {
        options.setErrorMessage(goalActionUnsupportedMessage('resume', options.selectedBackendID));
        return true;
      }
      void options.resumeGoalNow();
      return true;
    }
    if (command.kind === 'clear') {
      if (!options.selectedGoalCapability.clear) {
        options.setErrorMessage(goalActionUnsupportedMessage('clear', options.selectedBackendID));
        return true;
      }
      void options.clearGoalNow();
      return true;
    }
    if (options.isStreaming) {
      options.setErrorMessage('Wait for the current stream to finish before setting a goal.');
      return true;
    }
    void options.setGoalNow({ content: command.objective, attachments: attachments.length ? attachments : undefined });
    return true;
  }

  async function sendMessageNow(
    message: QueuedMessage,
    sendOptions: { clearComposer?: boolean; restoreDraftOnFailure?: boolean; conversationID?: string } = {},
  ): Promise<SendMessageResult> {
    const conversation = conversationForSend(options.activeConversation, options.activeConversationRef, sendOptions.conversationID);
    if (!conversation) {
      return { ok: false, reason: 'busy' };
    }
    if (sendInFlightRef.current) {
      return { ok: false, reason: 'busy' };
    }
    sendInFlightRef.current = true;
    setIsSending(true);
    const content = wireContent(message);
    const attachmentsSnapshot = options.pendingAttachments;
    const clearComposer = sendOptions.clearComposer !== false;
    const restoreDraftOnFailure = sendOptions.restoreDraftOnFailure !== false;
    const runtimeSelection = {
      backend: options.selectedBackendID || options.selectedBackend || conversation.backend || '',
      cliProfileId: options.selectedCliProfileId,
      model: options.selectedModel,
      effort: options.selectedEffort,
      claudeCodeMode: options.claudeCodeModeForSelection,
      serviceTier: options.serviceTierEnabled ? options.selectedServiceTier : undefined,
    };
    const optimisticID = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const optimisticUserID = `pending-user-${optimisticID}`;
    const optimisticUserMessage = {
      id: optimisticUserID,
      role: 'user' as const,
      content,
      backend: runtimeSelection.backend || '',
      timestamp: new Date().toISOString(),
    };
    try {
      if (clearComposer) {
        options.setDraft('');
        options.setPendingAttachments([]);
      }
      options.setErrorMessage(null);
      options.setPendingInteraction(null);
      options.setStreamText('');
      options.setShowStreamPlaceholder(true);
      options.setIsStreaming(true);
      options.setActiveStreamIDs((current) => new Set(current).add(conversation.id));
      options.setActiveConversation((current) => {
        if (!current || current.id !== conversation.id) return current;
        const next = applyConversationRuntimeSelection(
          { ...current, messages: [...current.messages, optimisticUserMessage] },
          runtimeSelection,
        );
        options.activeConversationRef.current = next;
        return next;
      });
      const response = await options.clientRef.current.sendMessage(conversation.id, {
        content,
        backend: options.selectedBackend,
        cliProfileId: options.selectedCliProfileId,
        model: options.selectedModel,
        effort: options.selectedEffort,
        claudeCodeMode: options.claudeCodeModeForRequest,
        serviceTier: options.serviceTierEnabled ? options.selectedServiceTier : undefined,
      });
      options.setActiveConversation((current) => {
        if (!current || current.id !== conversation.id) return current;
        const next = applyConversationRuntimeSelection(
          { ...current, messages: replaceMessageByID(current.messages, optimisticUserID, response.userMessage) },
          runtimeSelection,
        );
        options.activeConversationRef.current = next;
        return next;
      });
      if (response.streamReady) {
        options.startStream(conversation.id);
      } else {
        options.markStreamFinished(conversation.id);
      }
      return { ok: true };
    } catch (error) {
      if (isAlreadyStreamingError(error)) {
        rollbackOptimisticSend(conversation, optimisticUserID, message, attachmentsSnapshot, restoreDraftOnFailure);
        await options.recoverActiveStream(conversation.id);
        return { ok: false, reason: 'active-stream-recovered', error };
      }
      if (await options.recoverActiveStream(conversation.id, { onlyIfServerActive: true })) {
        await reconcileRecoveredActiveSend(conversation.id, conversation.messages.length, content);
        return { ok: true };
      }
      rollbackOptimisticSend(conversation, optimisticUserID, message, attachmentsSnapshot, restoreDraftOnFailure);
      options.markStreamFinished(conversation.id);
      options.onError(error);
      return { ok: false, reason: 'failed', error };
    } finally {
      sendInFlightRef.current = false;
      setIsSending(false);
    }
  }

  function rollbackOptimisticSend(
    conversation: Conversation,
    optimisticUserID: string,
    message: QueuedMessage,
    attachmentsSnapshot: PendingAttachment[],
    restoreDraftOnFailure: boolean,
  ) {
    if (restoreDraftOnFailure) {
      options.setDraft(message.content);
      options.setPendingAttachments(attachmentsSnapshot);
    }
    options.setActiveConversation((current) => {
      if (!current || current.id !== conversation.id) return current;
      const next = {
        ...current,
        backend: conversation.backend,
        cliProfileId: conversation.cliProfileId,
        model: conversation.model,
        effort: conversation.effort,
        serviceTier: conversation.serviceTier,
        messages: removeMessagesByID(current.messages, [optimisticUserID]),
      };
      options.activeConversationRef.current = next;
      return next;
    });
  }

  async function reconcileRecoveredActiveSend(
    conversationID: string,
    previousMessageCount: number,
    content: string,
  ) {
    try {
      const serverConversation = await options.clientRef.current.getConversation(conversationID);
      options.setActiveConversation((current) => {
        if (!current || current.id !== conversationID) return current;
        const next = reconcileRecoveredSendConversation(
          current,
          serverConversation,
          previousMessageCount,
          content,
        );
        options.activeConversationRef.current = next;
        return next;
      });
    } catch {
      // Keep the optimistic user bubble visible until the post-stream refresh.
    }
  }

  async function enqueueDraft() {
    const conversation = options.activeConversation;
    const content = options.draft.trim();
    const attachments = completedAttachmentMetas(options.pendingAttachments);
    if (!conversation || (!content && !attachments.length)) {
      return;
    }
    try {
      const queue = [...(conversation.messageQueue || []), { content, attachments: attachments.length ? attachments : undefined }];
      const saved = await options.clientRef.current.saveQueue(conversation.id, queue);
      options.setActiveConversation({ ...conversation, messageQueue: saved });
      options.setDraft('');
      options.setPendingAttachments([]);
    } catch (error) {
      options.onError(error);
    }
  }

  function setActiveConversationQueue(conversationID: string, queue: QueuedMessage[]) {
    options.setActiveConversation((current) => {
      if (!current || current.id !== conversationID) return current;
      const next = { ...current, messageQueue: queue };
      options.activeConversationRef.current = next;
      return next;
    });
  }

  async function drainNextQueuedMessage(conversation: Conversation) {
    const queue = conversation.messageQueue || [];
    if (options.isStreaming || options.pendingInteraction || sendInFlightRef.current || !queue.length) {
      return;
    }
    const [nextMessage, ...remaining] = queue;
    try {
      const savedQueue = await options.clientRef.current.saveQueue(conversation.id, remaining);
      setActiveConversationQueue(conversation.id, savedQueue);
      const result = await sendMessageNow(nextMessage, {
        clearComposer: false,
        restoreDraftOnFailure: false,
        conversationID: conversation.id,
      });
      if (!result.ok) {
        await options.clientRef.current.saveQueue(conversation.id, queue).catch(() => undefined);
        setActiveConversationQueue(conversation.id, queue);
      }
    } catch (error) {
      await options.clientRef.current.saveQueue(conversation.id, queue).catch(() => undefined);
      setActiveConversationQueue(conversation.id, queue);
      options.onError(error);
    }
  }

  async function submitInteraction() {
    const conversation = options.activeConversation;
    const answer = options.interactionAnswer.trim();
    if (!conversation || !options.pendingInteraction || !answer) {
      return;
    }
    try {
      const response = await options.clientRef.current.sendInput(conversation.id, answer, options.isStreaming || options.loading);
      options.setPendingInteraction(null);
      options.setInteractionAnswer('');
      if (response.mode === 'message') {
        await sendMessageNow({ content: answer });
      }
    } catch (error) {
      options.onError(error);
    }
  }

  return {
    isSending,
    sendDraft,
    drainNextQueuedMessage,
    submitInteraction,
  };
}
