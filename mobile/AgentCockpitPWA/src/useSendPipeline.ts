import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
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

/** Interrupted runs retain queued follow-ups until the user explicitly resumes. */
function queueRequiresResume(conversation: Conversation): boolean {
  return Boolean([...conversation.messages].reverse().find(message => message.role === 'assistant')?.streamError);
}

export function useSendPipeline(options: UseSendPipelineOptions) {
  const sendInFlightRef = useRef(false);
  const queueInFlightRef = useRef(false);
  const suspendedQueues = useRef(new Set<string>());
  const latest = useRef(options);
  latest.current = options;
  const [isSending, setIsSending] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const interactionInFlight = useRef(false);
  const interactionOwner = useRef({ conversationId: options.activeConversation?.id, interaction: options.pendingInteraction });
  interactionOwner.current = { conversationId: options.activeConversation?.id, interaction: options.pendingInteraction };
  const interactionKey = JSON.stringify([options.activeConversation?.id, options.pendingInteraction?.decisionId,
    options.pendingInteraction?.kind, options.pendingInteraction?.prompt]);
  const setInteractionAnswer = options.setInteractionAnswer;
  useEffect(() => { setInteractionAnswer(''); }, [interactionKey, setInteractionAnswer]);

  async function sendDraft() {
    if (sendInFlightRef.current || queueInFlightRef.current
      || options.activeConversation?.id !== latest.current.activeConversation?.id) {
      return;
    }
    const content = options.draft.trim();
    const attachments = completedAttachmentMetas(options.pendingAttachments);
    if (latest.current.pendingInteraction) {
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
    sendOptions: { clearComposer?: boolean; restoreDraftOnFailure?: boolean; conversationID?: string; answering?: PendingInteraction } = {},
  ): Promise<SendMessageResult> {
    const options = latest.current;
    const conversation = conversationForSend(options.activeConversation, options.activeConversationRef, sendOptions.conversationID);
    if (!conversation) {
      return { ok: false, reason: 'busy' };
    }
    // An answered card clears through React state, so the latest render can
    // still show it. Only that exact interaction may send its answer.
    if (sendInFlightRef.current || (options.pendingInteraction && options.pendingInteraction !== sendOptions.answering)) {
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
        ...(message.attachments?.length ? { attachments: message.attachments.map(({ name }) => ({ name })) } : {}),
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
    const current = latest.current;
    const conversation = current.activeConversationRef.current;
    const content = current.draft.trim();
    const attachments = completedAttachmentMetas(current.pendingAttachments);
    if (!conversation || queueInFlightRef.current || (!content && !attachments.length)) return;
    queueInFlightRef.current = true;
    setIsSending(true);
    suspendedQueues.current.delete(conversation.id);
    try {
      const queue = [...(conversation.messageQueue || []), { content, attachments: attachments.length ? attachments : undefined }];
      const saved = await current.clientRef.current.saveQueue(conversation.id, queue);
      setActiveConversationQueue(conversation.id, saved);
      if (latest.current.activeConversationRef.current?.id === conversation.id) {
        if (latest.current.draft === current.draft) current.setDraft('');
        const queuedIds = new Set(current.pendingAttachments.map(attachment => attachment.id));
        current.setPendingAttachments(pending => pending.filter(attachment => !queuedIds.has(attachment.id)));
      }
    } catch (error) {
      current.onError(error);
      return;
    } finally {
      queueInFlightRef.current = false;
      setIsSending(false);
    }
    const conversationNow = latest.current.activeConversationRef.current;
    if (conversationNow?.id === conversation.id) await drainNextQueuedMessage(conversationNow);
  }

  function setActiveConversationQueue(conversationID: string, queue: QueuedMessage[]) {
    options.setActiveConversation((current) => {
      if (!current || current.id !== conversationID) return current;
      const next = { ...current, messageQueue: queue };
      options.activeConversationRef.current = next;
      return next;
    });
  }

  async function drainNextQueuedMessage(conversation: Conversation, resume = false) {
    const current = latest.current;
    const queue = conversation.messageQueue || [];
    if (current.activeConversationRef.current?.id !== conversation.id || current.loading || current.isStreaming
      || current.pendingInteraction || sendInFlightRef.current || queueInFlightRef.current || !queue.length
      || (!resume && (suspendedQueues.current.has(conversation.id) || queueRequiresResume(conversation)))) return;
    if (resume) suspendedQueues.current.delete(conversation.id);
    queueInFlightRef.current = true;
    setIsSending(true);
    const [nextMessage, ...remaining] = queue;
    const restore = async () => {
      await current.clientRef.current.saveQueue(conversation.id, queue);
      setActiveConversationQueue(conversation.id, queue);
    };
    try {
      const savedQueue = await current.clientRef.current.saveQueue(conversation.id, remaining);
      setActiveConversationQueue(conversation.id, savedQueue);
      const now = latest.current;
      if (now.activeConversationRef.current?.id !== conversation.id || now.isStreaming || now.pendingInteraction || suspendedQueues.current.has(conversation.id)) {
        await restore();
        return;
      }
      const result = await sendMessageNow(nextMessage, {
        clearComposer: false,
        restoreDraftOnFailure: false,
        conversationID: conversation.id,
      });
      if (!result.ok) await restore();
    } catch (error) {
      await restore().catch(() => undefined);
      current.onError(error);
    } finally {
      queueInFlightRef.current = false;
      setIsSending(false);
    }
  }

  async function submitInteraction(answerOverride?: string) {
    const conversation = options.activeConversation;
    const interaction = options.pendingInteraction;
    const answer = (answerOverride ?? options.interactionAnswer).trim();
    const ownsInteraction = () => interactionOwner.current.conversationId === conversation?.id && interactionOwner.current.interaction === interaction;
    if (!conversation || !interaction || !answer || interactionInFlight.current || !ownsInteraction()) {
      return;
    }
    interactionInFlight.current = true;
    setIsResponding(true);
    try {
      const response = await options.clientRef.current.sendInput(conversation.id, answer, options.isStreaming || options.loading, interaction.decisionId);
      if (!ownsInteraction()) return;
      options.setPendingInteraction((current) => current === interaction ? null : current);
      options.setInteractionAnswer('');
      if (response.mode === 'message') {
        await sendMessageNow({ content: answer }, { answering: interaction });
      }
    } catch (error) {
      if (ownsInteraction()) options.onError(error);
    } finally {
      interactionInFlight.current = false;
      setIsResponding(false);
    }
  }

  return {
    isSending,
    isResponding,
    sendDraft,
    drainNextQueuedMessage,
    submitInteraction,
    suspendQueue: (conversationID: string) => { suspendedQueues.current.add(conversationID); },
  };
}
