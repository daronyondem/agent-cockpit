import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentAPIError, AgentCockpitAPI } from './api';
import {
  ALL_WORKSPACES,
  applyConversationRuntimeSelection,
  backendIdForProfile,
  cleanGoalObjectiveText,
  completedAttachmentMetas,
  conversationListItemFromConversation,
  downloadBlob,
  goalActionUnsupportedMessage,
  goalCapabilityForBackend,
  goalSnapshotTimeMs,
  goalSupportsAction,
  isClaudeBackend,
  joinExplorerPath,
  isImageFileName,
  isActiveGoal,
  makeExplorerFileReference,
  parentExplorerPath,
  patchConversationMessage,
  reconcileEffort,
  removeMessagesByID,
  replaceMessageByID,
  shouldApplyGoalSnapshot,
  updateSessionsAfterReset,
  upsertMessage,
  userLabel,
  wireContent,
  workspaceRef,
  type ExplorerUpload,
  type FilePreviewState,
  type FileReference,
} from './appModel';
import {
  ActionsModal,
  ChatScreen,
  ConversationListScreen,
  FilePreviewModal,
  FilesModal,
  MarkdownShareModal,
  NewConversationModal,
  QueueEditorModal,
  ReadOnlySessionScreen,
  RunSettingsModal,
  SessionsModal,
  type MarkdownShareScope,
} from './mobileComponents';
import { useVisibleIntervalRefresh, useVisibleStreamResume } from './useMobileLifecycle';
import { useViewportHeightVar } from './useViewportHeightVar';
import type {
  AttachmentMeta,
  BackendMetadata,
  Conversation,
  ConversationListItem,
  CurrentUser,
  EffortLevel,
  ExplorerEntry,
  ExplorerPreviewResponse,
  Message,
  PendingAttachment,
  PendingInteraction,
  QueuedMessage,
  SessionHistoryItem,
  ServiceTier,
  Settings,
  StreamEvent,
  ThreadGoal,
} from './types';

const LIST_AUTO_REFRESH_MS = 15_000;
const STREAM_RECONNECT_BASE_MS = 1_000;
const STREAM_RECONNECT_MAX_MS = 15_000;

type Screen = 'list' | 'chat';
type SessionViewerState = { session: SessionHistoryItem; messages: Message[] };

export default function App() {
  useViewportHeightVar();

  const clientRef = useRef(new AgentCockpitAPI());
  const socketRef = useRef<WebSocket | null>(null);
  const listStreamSocketsRef = useRef<Map<string, WebSocket>>(new Map());
  const streamReconnectTimerRef = useRef<number | null>(null);
  const streamReconnectAttemptsRef = useRef(0);
  const activeConversationRef = useRef<Conversation | null>(null);
  const isStreamingRef = useRef(false);
  const goalUpdatedAtByConversationRef = useRef<Map<string, number>>(new Map());
  const goalStateRef = useRef<{ conversationID: string | null; goal: ThreadGoal | null; updatedAtMs: number | null }>({
    conversationID: null,
    goal: null,
    updatedAtMs: null,
  });
  const resumeStreamConnectionRef = useRef<(conversationID: string, force?: boolean) => Promise<void> | void>(() => undefined);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const explorerUploadInputRef = useRef<HTMLInputElement | null>(null);

  const [screen, setScreen] = useState<Screen>('list');
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [backends, setBackends] = useState<BackendMetadata[]>([]);
  const [profileMetadata, setProfileMetadata] = useState<Record<string, BackendMetadata>>({});
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [activeStreamIDs, setActiveStreamIDs] = useState<Set<string>>(new Set());
  const [activeGoalIDs, setActiveGoalIDs] = useState<Set<string>>(new Set());
  const [listArchived, setListArchived] = useState(false);
  const [workspaceFilter, setWorkspaceFilter] = useState(ALL_WORKSPACES);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [goal, setGoal] = useState<ThreadGoal | null>(null);
  const [goalUpdatedAtMs, setGoalUpdatedAtMs] = useState<number | null>(null);
  const [goalMode, setGoalMode] = useState(false);
  const [draft, setDraft] = useState('');
  const [streamText, setStreamText] = useState('');
  const [showStreamPlaceholder, setShowStreamPlaceholder] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingInteraction, setPendingInteraction] = useState<PendingInteraction | null>(null);
  const [interactionAnswer, setInteractionAnswer] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [selectedCliProfileId, setSelectedCliProfileId] = useState<string | undefined>();
  const [selectedBackend, setSelectedBackend] = useState<string | undefined>();
  const [selectedModel, setSelectedModel] = useState<string | undefined>();
  const [selectedEffort, setSelectedEffort] = useState<EffortLevel | undefined>();
  const [selectedServiceTier, setSelectedServiceTier] = useState<ServiceTier | 'default' | undefined>();

  const [newConversationVisible, setNewConversationVisible] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newWorkingDir, setNewWorkingDir] = useState('');
  const [actionsVisible, setActionsVisible] = useState(false);
  const [markdownShareVisible, setMarkdownShareVisible] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [settingsVisible, setSettingsVisible] = useState(false);

  const [sessionsVisible, setSessionsVisible] = useState(false);
  const [sessions, setSessions] = useState<SessionHistoryItem[]>([]);
  const [sessionViewer, setSessionViewer] = useState<SessionViewerState | null>(null);

  const [filesVisible, setFilesVisible] = useState(false);
  const [explorerPath, setExplorerPath] = useState('');
  const [explorerParent, setExplorerParent] = useState<string | null>(null);
  const [explorerEntries, setExplorerEntries] = useState<ExplorerEntry[]>([]);
  const [explorerPreview, setExplorerPreview] = useState<ExplorerPreviewResponse | null>(null);
  const [explorerEditContent, setExplorerEditContent] = useState('');
  const [explorerUploads, setExplorerUploads] = useState<ExplorerUpload[]>([]);

  const [filePreview, setFilePreview] = useState<FilePreviewState | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);
  const [queueEditorIndex, setQueueEditorIndex] = useState<number | null>(null);
  const [queueEditorContent, setQueueEditorContent] = useState('');
  const [queueEditorAttachments, setQueueEditorAttachments] = useState<AttachmentMeta[]>([]);

  const availableProfiles = useMemo(() => (settings?.cliProfiles || []).filter((profile) => profile.disabled !== true), [settings]);
  const selectedProfile = useMemo(
    () => availableProfiles.find((profile) => profile.id === selectedCliProfileId),
    [availableProfiles, selectedCliProfileId],
  );
  const profileSelectionLocked = (activeConversation?.messages.length || 0) > 0;
  const selectedProfileBackendID = selectedProfile ? backendIdForProfile(selectedProfile) : undefined;
  const selectedBackendMetadata = useMemo(() => {
    if (selectedProfile) {
      const profileBackendID = profileSelectionLocked ? selectedBackend : selectedProfileBackendID;
      const providerMetadata = backends.find((backend) => backend.id === profileBackendID);
      const selectedProfileMetadata = profileMetadata[selectedCliProfileId || ''];
      if (providerMetadata && selectedProfileMetadata && providerMetadata.id !== selectedProfileMetadata.id) {
        return {
          ...providerMetadata,
          models: selectedProfileMetadata.models || providerMetadata.models,
        };
      }
      return selectedProfileMetadata || providerMetadata;
    }
    if (selectedCliProfileId && profileMetadata[selectedCliProfileId]) {
      return profileMetadata[selectedCliProfileId];
    }
    return backends.find((backend) => backend.id === selectedBackend);
  }, [backends, profileMetadata, profileSelectionLocked, selectedBackend, selectedCliProfileId, selectedProfile, selectedProfileBackendID]);
  const selectedModelMetadata = useMemo(
    () => selectedBackendMetadata?.models?.find((model) => model.id === selectedModel),
    [selectedBackendMetadata, selectedModel],
  );
  const supportedEfforts = selectedModelMetadata?.supportedEffortLevels || [];
  const selectedBackendID = selectedProfile
    ? (profileSelectionLocked ? selectedBackend : selectedProfileBackendID)
    : selectedBackendMetadata?.id || selectedBackend;
  const selectedGoalCapability = useMemo(
    () => goalCapabilityForBackend(backends, selectedBackendID, selectedBackendMetadata),
    [backends, selectedBackendID, selectedBackendMetadata],
  );
  const goalCapable = selectedGoalCapability.set === true;
  const serviceTierEnabled = selectedBackendID === 'codex';
  const hasUploadingAttachments = pendingAttachments.some((attachment) => attachment.status === 'uploading');

  useEffect(() => {
    if (!profileSelectionLocked && selectedProfileBackendID && selectedBackend !== selectedProfileBackendID) {
      setSelectedBackend(selectedProfileBackendID);
    }
  }, [profileSelectionLocked, selectedBackend, selectedProfileBackendID]);

  useEffect(() => {
    void loadDashboard();
    return () => {
      clearStreamReconnectTimer();
      closeStreamSocket();
      closeListStreamSockets();
    };
  }, []);

  useEffect(() => {
    activeConversationRef.current = activeConversation;
  }, [activeConversation]);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    if (!goalCapable && goalMode) {
      setGoalMode(false);
    }
  }, [goalCapable, goalMode]);

  useEffect(() => {
    resumeStreamConnectionRef.current = resumeStreamConnection;
  });

  useVisibleStreamResume(() => {
    const conversationID = activeConversationRef.current?.id;
    if (conversationID && isStreamingRef.current) {
      void resumeStreamConnectionRef.current(conversationID, true);
    }
  });

  useEffect(() => {
    if (workspaceFilter !== ALL_WORKSPACES && conversations.every((conversation) => workspaceRef(conversation) !== workspaceFilter)) {
      setWorkspaceFilter(ALL_WORKSPACES);
    }
  }, [conversations, workspaceFilter]);

  useEffect(() => {
    if (screen !== 'list') {
      closeListStreamSockets();
      return;
    }
    syncListStreamSockets(activeStreamIDs);
  }, [screen, activeStreamIDs]);

  useVisibleIntervalRefresh(screen === 'list', () => void refreshConversationList(), LIST_AUTO_REFRESH_MS);

  useEffect(() => {
    if (selectedCliProfileId) {
      void loadProfileMetadata(selectedCliProfileId);
    }
  }, [selectedCliProfileId]);

  useEffect(() => {
    setSelectedEffort((current) => reconcileEffort(current, supportedEfforts));
  }, [supportedEfforts.join('|')]);

  async function loadDashboard(archived = listArchived) {
    const client = clientRef.current;
    try {
      setLoading(true);
      setErrorMessage(null);
      const [user, loadedSettings, loadedBackends, streamIDs, loadedConversations] = await Promise.all([
        client.getCurrentUser(),
        client.getSettings(),
        client.getBackends(),
        client.getActiveStreams(),
        client.listConversations(archived),
      ]);
      setCurrentUser(user);
      setSettings(loadedSettings);
      setBackends(loadedBackends);
      setActiveStreamIDs(streamIDs);
      setConversations(loadedConversations);
      setListArchived(archived);
      hydrateSelectionDefaults(loadedSettings);
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }

  function hydrateSelectionDefaults(loadedSettings: Settings) {
    const profiles = (loadedSettings.cliProfiles || []).filter((profile) => profile.disabled !== true);
    const profileID = loadedSettings.defaultCliProfileId;
    const profile = profiles.find((item) => item.id === profileID);
    const backendID = loadedSettings.defaultBackend;
    setSelectedCliProfileId(profileID);
    setSelectedBackend(backendIdForProfile(profile) || backendID);
    setSelectedModel(loadedSettings.defaultModel);
    setSelectedEffort(loadedSettings.defaultEffort);
    setSelectedServiceTier(loadedSettings.defaultBackend === 'codex' ? loadedSettings.defaultServiceTier : undefined);
    if (profileID) {
      void loadProfileMetadata(profileID);
    }
  }

  async function loadProfileMetadata(profileID: string) {
    if (profileMetadata[profileID]) {
      return;
    }
    try {
      const metadata = await clientRef.current.getCliProfileMetadata(profileID);
      setProfileMetadata((current) => ({ ...current, [profileID]: metadata }));
    } catch (error) {
      handleError(error);
    }
  }

  async function refreshConversationList() {
    try {
      const [streamIDs, loadedConversations] = await Promise.all([
        clientRef.current.getActiveStreams(),
        clientRef.current.listConversations(listArchived),
      ]);
      setActiveStreamIDs(streamIDs);
      setConversations(loadedConversations);
    } catch (error) {
      handleError(error);
    }
  }

  function clearOpenGoalState(conversationID: string | null = activeConversationRef.current?.id || null) {
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

    if (activeConversationRef.current?.id === conversationID) {
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

  function shouldPreserveLocalRuntimeGoalOnNull(conversationID: string): boolean {
    if (goalStateRef.current.conversationID !== conversationID) return false;
    const currentGoal = goalStateRef.current.goal;
    return !!currentGoal && currentGoal.status === 'active' && currentGoal.source === 'runtime';
  }

  function applyServerMessage(conversationID: string, message: Message | null | undefined) {
    if (!message) return;
    setActiveConversation((current) =>
      current && current.id === conversationID ? { ...current, messages: upsertMessage(current.messages, message) } : current,
    );
    setConversations((items) =>
      items.map((item) =>
        item.id === conversationID
          ? {
              ...item,
              lastMessage: message.content || item.lastMessage,
              updatedAt: message.timestamp || item.updatedAt,
            }
          : item,
      ),
    );
  }

  async function refreshGoalState(conversationID = activeConversationRef.current?.id) {
    const conversation = activeConversationRef.current;
    if (!conversationID || !conversation || conversation.id !== conversationID) {
      return null;
    }
    const conversationGoalCapability = goalCapabilityForBackend(
      backends,
      conversation.backend,
      conversation.cliProfileId ? profileMetadata[conversation.cliProfileId] : undefined,
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
      const response = await clientRef.current.getGoal(conversationID);
      if (!response.goal && shouldPreserveLocalRuntimeGoalOnNull(conversationID)) {
        return goalStateRef.current.goal;
      }
      applyGoalSnapshot(conversationID, response.goal || null);
      return response.goal || null;
    } catch {
      return null;
    }
  }

  async function openConversation(id: string) {
    try {
      setLoading(true);
      setErrorMessage(null);
      closeStreamSocket();
      closeListStreamSockets();
      const [conversation, streamIDs] = await Promise.all([
        clientRef.current.getConversation(id),
        clientRef.current.getActiveStreams(),
      ]);
      const streamActive = streamIDs.has(id);
      setActiveStreamIDs(streamIDs);
      setActiveConversation(conversation);
      activeConversationRef.current = conversation;
      setDraft('');
      setStreamText('');
      setShowStreamPlaceholder(streamActive);
      setPendingInteraction(null);
      setPendingAttachments([]);
      setGoalMode(false);
      hydrateSelectionFromConversation(conversation);
      setIsStreaming(streamActive);
      isStreamingRef.current = streamActive;
      setScreen('chat');
      clearOpenGoalState(id);
      void refreshGoalState(id);
      if (streamActive) {
        startStream(id);
      }
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }

  function hydrateSelectionFromConversation(conversation: Conversation) {
    setSelectedCliProfileId(conversation.cliProfileId || settings?.defaultCliProfileId);
    setSelectedBackend(conversation.backend || settings?.defaultBackend);
    setSelectedModel(conversation.model || settings?.defaultModel);
    setSelectedEffort(conversation.effort || settings?.defaultEffort);
    setSelectedServiceTier(conversation.backend === 'codex' ? (conversation.serviceTier || 'default') : undefined);
  }

  async function createConversation() {
    try {
      const conversation = await clientRef.current.createConversation({
        title: newTitle.trim() || undefined,
        workingDir: newWorkingDir.trim() || undefined,
        backend: selectedBackend,
        cliProfileId: selectedCliProfileId,
        model: selectedModel,
        effort: selectedEffort,
        serviceTier: serviceTierEnabled ? selectedServiceTier : undefined,
      });
      hydrateSelectionFromConversation(conversation);
      setNewConversationVisible(false);
      setNewTitle('');
      setNewWorkingDir('');
      setActiveConversation(conversation);
      activeConversationRef.current = conversation;
      clearOpenGoalState(conversation.id);
      setGoalMode(false);
      setConversations((items) => [conversationListItemFromConversation(conversation), ...items]);
      setScreen('chat');
    } catch (error) {
      handleError(error);
    }
  }

  async function sendDraft() {
    const content = draft.trim();
    const attachments = completedAttachmentMetas(pendingAttachments);
    if (pendingInteraction) {
      setErrorMessage('Answer the prompt above to continue.');
      return;
    }
    if (hasUploadingAttachments) {
      return;
    }
    if (handleGoalSlash(content, attachments)) {
      return;
    }
    if (!content && !attachments.length) {
      return;
    }
    if (goalMode) {
      if (isStreaming) {
        setErrorMessage('Wait for the current stream to finish before setting a goal.');
        return;
      }
      await setGoalNow({ content, attachments: attachments.length ? attachments : undefined });
      return;
    }
    if (isStreaming) {
      await enqueueDraft();
      return;
    }
    await sendMessageNow({ content, attachments: attachments.length ? attachments : undefined });
  }

  function handleGoalSlash(content: string, attachments: AttachmentMeta[]): boolean {
    if (!content || !/^\/goal(?:\s|$)/i.test(content)) {
      return false;
    }
    if (!goalCapable) {
      setErrorMessage('Goals are not available for this backend.');
      return true;
    }
    const arg = content.replace(/^\/goal\b/i, '').trim();
    if (!arg) {
      setDraft('');
      setGoalMode(true);
      setErrorMessage(null);
      return true;
    }
    const command = arg.toLowerCase();
    setDraft('');
    if (command === 'pause') {
      if (!selectedGoalCapability.pause) {
        setErrorMessage(goalActionUnsupportedMessage('pause', selectedBackendID));
        return true;
      }
      void pauseGoalNow();
      return true;
    }
    if (command === 'resume') {
      if (!selectedGoalCapability.resume) {
        setErrorMessage(goalActionUnsupportedMessage('resume', selectedBackendID));
        return true;
      }
      void resumeGoalNow();
      return true;
    }
    if (command === 'clear') {
      if (!selectedGoalCapability.clear) {
        setErrorMessage(goalActionUnsupportedMessage('clear', selectedBackendID));
        return true;
      }
      void clearGoalNow();
      return true;
    }
    if (isStreaming) {
      setErrorMessage('Wait for the current stream to finish before setting a goal.');
      return true;
    }
    void setGoalNow({ content: arg, attachments: attachments.length ? attachments : undefined });
    return true;
  }

  async function sendMessageNow(message: QueuedMessage) {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    const content = wireContent(message);
    const attachmentsSnapshot = pendingAttachments;
    const runtimeSelection = {
      backend: selectedBackendID || selectedBackend || conversation.backend || '',
      cliProfileId: selectedCliProfileId,
      model: selectedModel,
      effort: selectedEffort,
      serviceTier: serviceTierEnabled ? selectedServiceTier : undefined,
    };
    const optimisticID = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const optimisticUserID = `pending-user-${optimisticID}`;
    const optimisticUserMessage: Message = {
      id: optimisticUserID,
      role: 'user',
      content,
      backend: runtimeSelection.backend || '',
      timestamp: new Date().toISOString(),
    };
    try {
      setDraft('');
      setPendingAttachments([]);
      setPendingInteraction(null);
      setStreamText('');
      setShowStreamPlaceholder(true);
      setIsStreaming(true);
      isStreamingRef.current = true;
      setActiveStreamIDs((current) => new Set(current).add(conversation.id));
      setActiveConversation((current) => {
        if (!current || current.id !== conversation.id) return current;
        const next = applyConversationRuntimeSelection(
          { ...current, messages: [...current.messages, optimisticUserMessage] },
          runtimeSelection,
        );
        activeConversationRef.current = next;
        return next;
      });
      const response = await clientRef.current.sendMessage(conversation.id, {
        content,
        backend: selectedBackend,
        cliProfileId: selectedCliProfileId,
        model: selectedModel,
        effort: selectedEffort,
        serviceTier: serviceTierEnabled ? selectedServiceTier : undefined,
      });
      setActiveConversation((current) => {
        if (!current || current.id !== conversation.id) return current;
        const next = applyConversationRuntimeSelection(
          { ...current, messages: replaceMessageByID(current.messages, optimisticUserID, response.userMessage) },
          runtimeSelection,
        );
        activeConversationRef.current = next;
        return next;
      });
      if (response.streamReady) {
        startStream(conversation.id);
      } else {
        markStreamFinished(conversation.id);
      }
    } catch (error) {
      setDraft(message.content);
      setPendingAttachments(attachmentsSnapshot);
      setActiveConversation((current) => {
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
        activeConversationRef.current = next;
        return next;
      });
      markStreamFinished(conversation.id);
      handleError(error);
    }
  }

  async function setGoalNow(message: QueuedMessage) {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    if (!goalCapable) {
      setErrorMessage('Goals are not available for this backend.');
      return;
    }
    const objective = cleanGoalObjectiveText(wireContent(message));
    if (!objective) {
      return;
    }
    const previousGoal = goalStateRef.current.conversationID === conversation.id ? goalStateRef.current.goal : null;
    const previousGoalUpdatedAtMs = goalStateRef.current.conversationID === conversation.id ? goalStateRef.current.updatedAtMs : null;
    const goalStartedAtMs = Date.now();
    const optimisticBackend = selectedBackendID === 'codex' || isClaudeBackend(selectedBackendID)
      ? selectedBackendID as ThreadGoal['backend']
      : undefined;
    const optimisticGoal: ThreadGoal = {
      backend: optimisticBackend,
      objective,
      status: 'active',
      supportedActions: {
        clear: true,
        stopTurn: true,
        pause: selectedGoalCapability.pause,
        resume: selectedGoalCapability.resume,
      },
      tokenBudget: null,
      tokensUsed: null,
      timeUsedSeconds: 0,
      createdAt: goalStartedAtMs,
      updatedAt: goalStartedAtMs,
      source: 'runtime',
    };
    try {
      setDraft('');
      setPendingAttachments([]);
      setPendingInteraction(null);
      commitGoalSnapshot(conversation.id, optimisticGoal, goalStartedAtMs);
      const response = await clientRef.current.setGoal(conversation.id, {
        objective,
        backend: selectedBackend,
        cliProfileId: selectedCliProfileId,
        model: selectedModel,
        effort: selectedEffort,
        serviceTier: serviceTierEnabled ? selectedServiceTier : undefined,
      });
      if (response.goal) applyGoalSnapshot(conversation.id, response.goal);
      applyServerMessage(conversation.id, response.message);
      setGoalMode(false);
      setActiveConversation((current) =>
        current && current.id === conversation.id
          ? {
              ...current,
              backend: selectedBackend || current.backend,
              cliProfileId: selectedCliProfileId || current.cliProfileId,
              model: selectedModel || current.model,
              effort: selectedEffort || current.effort,
              serviceTier: selectedServiceTier === 'fast' ? 'fast' : undefined,
            }
          : current,
      );
      if (response.streamReady !== false) {
        startStream(conversation.id);
      }
    } catch (error) {
      setDraft(message.content);
      commitGoalSnapshot(conversation.id, previousGoal, previousGoalUpdatedAtMs);
      if (error instanceof AgentAPIError && error.status === 409) {
        startStream(conversation.id);
        return;
      }
      handleError(error);
    }
  }

  async function pauseGoalNow() {
    const conversation = activeConversation;
    if (!conversation || !goal) {
      return;
    }
    if (!goalSupportsAction(goal, 'pause')) {
      setErrorMessage(goalActionUnsupportedMessage('pause', goal.backend || conversation.backend));
      return;
    }
    try {
      const response = await clientRef.current.pauseGoal(conversation.id);
      applyGoalSnapshot(conversation.id, response.goal || null);
      applyServerMessage(conversation.id, response.message);
    } catch (error) {
      handleError(error);
    }
  }

  async function resumeGoalNow() {
    const conversation = activeConversation;
    if (!conversation || !goal || isStreaming) {
      return;
    }
    if (!goalSupportsAction(goal, 'resume')) {
      setErrorMessage(goalActionUnsupportedMessage('resume', goal.backend || conversation.backend));
      return;
    }
    const previousGoal = goal;
    commitGoalSnapshot(conversation.id, { ...goal, status: 'active', updatedAt: Date.now() }, goalSnapshotTimeMs(goal) || Date.now());
    try {
      const response = await clientRef.current.resumeGoal(conversation.id);
      if (response.goal) applyGoalSnapshot(conversation.id, response.goal);
      applyServerMessage(conversation.id, response.message);
      if (response.streamReady !== false) {
        startStream(conversation.id);
      }
    } catch (error) {
      commitGoalSnapshot(conversation.id, previousGoal, Date.now());
      if (error instanceof AgentAPIError && error.status === 409) {
        startStream(conversation.id);
        return;
      }
      handleError(error);
    }
  }

  async function clearGoalNow() {
    const conversation = activeConversation;
    if (!conversation || !goal) {
      return;
    }
    if (!goalSupportsAction(goal, 'clear')) {
      setErrorMessage(goalActionUnsupportedMessage('clear', goal.backend || conversation.backend));
      return;
    }
    if (isClaudeBackend(goal.backend) && isStreaming) {
      setErrorMessage('Wait for the current stream to finish before clearing this Claude Code goal.');
      return;
    }
    const previousGoal = goal;
    applyGoalSnapshot(conversation.id, null);
    try {
      const response = await clientRef.current.clearGoal(conversation.id);
      applyServerMessage(conversation.id, response.message);
    } catch (error) {
      commitGoalSnapshot(conversation.id, previousGoal, Date.now());
      handleError(error);
    }
  }

  async function enqueueDraft() {
    const conversation = activeConversation;
    const content = draft.trim();
    const attachments = completedAttachmentMetas(pendingAttachments);
    if (!conversation || (!content && !attachments.length)) {
      return;
    }
    try {
      const queue = [...(conversation.messageQueue || []), { content, attachments: attachments.length ? attachments : undefined }];
      const saved = await clientRef.current.saveQueue(conversation.id, queue);
      setActiveConversation({ ...conversation, messageQueue: saved });
      setDraft('');
      setPendingAttachments([]);
    } catch (error) {
      handleError(error);
    }
  }

  function closeStreamSocket() {
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
  }

  function startStream(conversationID: string) {
    closeStreamSocket();
    setShowStreamPlaceholder(true);
    setIsStreaming(true);
    isStreamingRef.current = true;
    setActiveStreamIDs((current) => new Set(current).add(conversationID));
    const socket = new WebSocket(clientRef.current.websocketURL(conversationID));
    socketRef.current = socket;
    socket.onopen = () => {
      clearStreamReconnectTimer();
      streamReconnectAttemptsRef.current = 0;
      setErrorMessage((current) => (current === 'Stream connection failed.' ? null : current));
      socket.send(JSON.stringify({ type: 'reconnect' }));
    };
    socket.onmessage = (event) => {
      try {
        handleStreamEvent(conversationID, JSON.parse(event.data) as StreamEvent);
      } catch {
        setErrorMessage('The stream returned an invalid event.');
      }
    };
    socket.onerror = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
        socket.close();
      }
      scheduleStreamReconnect(conversationID);
    };
    socket.onclose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
        scheduleStreamReconnect(conversationID);
      }
    };
  }

  function clearStreamReconnectTimer() {
    if (streamReconnectTimerRef.current !== null) {
      window.clearTimeout(streamReconnectTimerRef.current);
      streamReconnectTimerRef.current = null;
    }
  }

  function scheduleStreamReconnect(conversationID: string) {
    if (!isStreamingRef.current || activeConversationRef.current?.id !== conversationID || streamReconnectTimerRef.current !== null) {
      return;
    }
    const attempts = streamReconnectAttemptsRef.current;
    const delay = Math.min(STREAM_RECONNECT_BASE_MS * Math.pow(2, attempts), STREAM_RECONNECT_MAX_MS);
    streamReconnectTimerRef.current = window.setTimeout(() => {
      streamReconnectTimerRef.current = null;
      streamReconnectAttemptsRef.current = attempts + 1;
      void resumeStreamConnectionRef.current(conversationID);
    }, delay);
  }

  async function resumeStreamConnection(conversationID: string, force = false) {
    if (!isStreamingRef.current || activeConversationRef.current?.id !== conversationID) {
      return;
    }
    const currentSocket = socketRef.current;
    if (!force && currentSocket && (currentSocket.readyState === WebSocket.OPEN || currentSocket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      const streamIDs = await clientRef.current.getActiveStreams();
      setActiveStreamIDs(streamIDs);
      if (streamIDs.has(conversationID)) {
        clearStreamReconnectTimer();
        if (force && socketRef.current) {
          const staleSocket = socketRef.current;
          socketRef.current = null;
          staleSocket.close();
        }
        startStream(conversationID);
        return;
      }
      clearStreamReconnectTimer();
      streamReconnectAttemptsRef.current = 0;
      setIsStreaming(false);
      isStreamingRef.current = false;
      setShowStreamPlaceholder(false);
      closeStreamSocket();
      await refreshAfterStream(conversationID);
    } catch {
      scheduleStreamReconnect(conversationID);
    }
  }

  function syncListStreamSockets(streamIDs: Set<string>) {
    const sockets = listStreamSocketsRef.current;
    for (const [conversationID, socket] of sockets) {
      if (!streamIDs.has(conversationID)) {
        socket.close();
        sockets.delete(conversationID);
      }
    }
    for (const conversationID of streamIDs) {
      const existing = sockets.get(conversationID);
      if (existing && existing.readyState !== WebSocket.CLOSED && existing.readyState !== WebSocket.CLOSING) {
        continue;
      }
      const socket = new WebSocket(clientRef.current.websocketURL(conversationID));
      sockets.set(conversationID, socket);
      socket.onopen = () => socket.send(JSON.stringify({ type: 'reconnect' }));
      socket.onmessage = (event) => {
        try {
          handleListStreamEvent(conversationID, JSON.parse(event.data) as StreamEvent);
        } catch {
          // List monitoring is best-effort; the periodic REST refresh remains authoritative.
        }
      };
      socket.onclose = () => {
        if (listStreamSocketsRef.current.get(conversationID) === socket) {
          listStreamSocketsRef.current.delete(conversationID);
        }
      };
    }
  }

  function closeListStreamSockets() {
    for (const socket of listStreamSocketsRef.current.values()) {
      socket.close();
    }
    listStreamSocketsRef.current.clear();
  }

  function handleListStreamEvent(conversationID: string, event: StreamEvent) {
    switch (event.type) {
      case 'assistant_message':
        if (event.message) {
          const message = event.message;
          setConversations((items) =>
            items.map((item) =>
              item.id === conversationID
                ? {
                    ...item,
                    lastMessage: message.content || item.lastMessage,
                    updatedAt: message.timestamp || item.updatedAt,
                  }
                : item,
            ),
          );
        }
        void refreshConversationList();
        break;
      case 'title_updated':
        if (event.title) {
          setConversations((items) => items.map((item) => (item.id === conversationID ? { ...item, title: event.title || item.title } : item)));
        }
        break;
      case 'goal_updated':
        applyGoalSnapshot(conversationID, event.goal);
        break;
      case 'goal_cleared':
        applyGoalSnapshot(conversationID, null);
        break;
      case 'error':
        if (event.terminal !== false) {
          markListStreamFinished(conversationID);
          notify('Agent Cockpit stream failed', event.error || 'The stream ended with an error.');
        }
        break;
      case 'done':
        markListStreamFinished(conversationID);
        notify('Agent Cockpit stream finished', 'The latest response is ready.');
        break;
      case 'tool_activity':
        if (event.isPlanMode && event.planContent && event.planAction !== 'exit') {
          notify('Agent Cockpit needs approval', event.planContent);
        } else if (event.isQuestion && event.questions?.length) {
          notify('Agent Cockpit has a question', event.questions[0].question);
        }
        break;
      default:
        break;
    }
  }

  function markListStreamFinished(conversationID: string) {
    setActiveStreamIDs((current) => {
      const next = new Set(current);
      next.delete(conversationID);
      return next;
    });
    const socket = listStreamSocketsRef.current.get(conversationID);
    if (socket) {
      listStreamSocketsRef.current.delete(conversationID);
      socket.close();
    }
    void refreshConversationList();
  }

  function handleStreamEvent(conversationID: string, event: StreamEvent) {
    switch (event.type) {
      case 'text':
      case 'thinking':
        setShowStreamPlaceholder(false);
        setStreamText((current) => current + (event.content || ''));
        break;
      case 'assistant_message':
        if (event.message) {
          setActiveConversation((current) =>
            current && current.id === conversationID ? { ...current, messages: upsertMessage(current.messages, event.message) } : current,
          );
        }
        setStreamText('');
        setShowStreamPlaceholder(false);
        break;
      case 'tool_activity':
        if (event.isPlanMode && event.planContent && event.planAction !== 'exit') {
          setPendingInteraction({ kind: 'plan', prompt: event.planContent });
          notify('Agent Cockpit needs approval', event.planContent);
        } else if (event.isQuestion && event.questions?.length) {
          const question = event.questions[0];
          setPendingInteraction({ kind: 'question', prompt: question.question, options: question.options || [] });
          notify('Agent Cockpit has a question', question.question);
        }
        break;
      case 'title_updated':
        if (event.title) {
          setActiveConversation((current) => (current && current.id === conversationID ? { ...current, title: event.title || current.title } : current));
          setConversations((items) => items.map((item) => (item.id === conversationID ? { ...item, title: event.title || item.title } : item)));
        }
        break;
      case 'usage':
        setActiveConversation((current) =>
          current && current.id === conversationID ? { ...current, usage: event.usage, sessionUsage: event.sessionUsage || current.sessionUsage } : current,
        );
        break;
      case 'goal_updated':
        applyGoalSnapshot(conversationID, event.goal);
        break;
      case 'goal_cleared':
        applyGoalSnapshot(conversationID, null);
        break;
      case 'error':
        setErrorMessage(event.error || 'The stream ended with an error.');
        if (event.terminal !== false) {
          markStreamFinished(conversationID);
          notify('Agent Cockpit stream failed', event.error || 'The stream ended with an error.');
        }
        break;
      case 'done':
        setStreamText('');
        setShowStreamPlaceholder(false);
        markStreamFinished(conversationID);
        notify('Agent Cockpit stream finished', 'The latest response is ready.');
        void refreshAfterStream(conversationID);
        break;
      case 'replay_start':
        setStreamText('');
        setShowStreamPlaceholder(true);
        break;
      default:
        break;
    }
  }

  function markStreamFinished(conversationID: string) {
    clearStreamReconnectTimer();
    streamReconnectAttemptsRef.current = 0;
    setIsStreaming(false);
    isStreamingRef.current = false;
    setShowStreamPlaceholder(false);
    setActiveStreamIDs((current) => {
      const next = new Set(current);
      next.delete(conversationID);
      return next;
    });
    closeStreamSocket();
  }

  async function refreshAfterStream(conversationID: string) {
    try {
      const [conversation, streamIDs, loadedConversations] = await Promise.all([
        clientRef.current.getConversation(conversationID),
        clientRef.current.getActiveStreams(),
        clientRef.current.listConversations(listArchived),
      ]);
      if (activeConversationRef.current?.id === conversationID) {
        activeConversationRef.current = conversation;
      }
      setActiveConversation((current) => {
        if (current?.id !== conversationID) {
          return current;
        }
        return conversation;
      });
      setActiveStreamIDs(streamIDs);
      setConversations(loadedConversations);
      await refreshGoalState(conversationID);
      if (conversation.messageQueue?.length && !pendingInteraction) {
        await drainNextQueuedMessage(conversation);
      }
    } catch {
      // Keep the streamed assistant message visible if the refresh fails.
    }
  }

  async function drainNextQueuedMessage(conversation: Conversation) {
    const queue = conversation.messageQueue || [];
    if (isStreaming || pendingInteraction || !queue.length) {
      return;
    }
    const [nextMessage, ...remaining] = queue;
    try {
      const savedQueue = await clientRef.current.saveQueue(conversation.id, remaining);
      setActiveConversation({ ...conversation, messageQueue: savedQueue });
      await sendMessageNow(nextMessage);
    } catch (error) {
      await clientRef.current.saveQueue(conversation.id, queue).catch(() => undefined);
      setActiveConversation({ ...conversation, messageQueue: queue });
      handleError(error);
    }
  }

  async function stopStream() {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    try {
      clearStreamReconnectTimer();
      closeStreamSocket();
      setIsStreaming(false);
      isStreamingRef.current = false;
      setShowStreamPlaceholder(false);
      setPendingInteraction(null);
      await clientRef.current.abortConversation(conversation.id);
      const reloaded = await clientRef.current.getConversation(conversation.id);
      activeConversationRef.current = reloaded;
      setActiveConversation(reloaded);
      await refreshGoalState(conversation.id);
      await refreshConversationList();
    } catch (error) {
      handleError(error);
    }
  }

  async function submitInteraction() {
    const conversation = activeConversation;
    const answer = interactionAnswer.trim();
    if (!conversation || !pendingInteraction || !answer) {
      return;
    }
    try {
      const response = await clientRef.current.sendInput(conversation.id, answer, isStreaming || loading);
      setPendingInteraction(null);
      setInteractionAnswer('');
      if (response.mode === 'message') {
        await sendMessageNow({ content: answer });
      }
    } catch (error) {
      handleError(error);
    }
  }

  async function handleAttachmentFiles(files: FileList | null) {
    const conversation = activeConversation;
    if (!conversation || !files?.length) {
      return;
    }
    for (const file of Array.from(files)) {
      const attachmentID = `${Date.now()}-${file.name}-${Math.random().toString(16).slice(2)}`;
      setPendingAttachments((current) => [...current, { id: attachmentID, fileName: file.name, status: 'uploading', progress: 0 }]);
      clientRef.current
        .uploadFile(conversation.id, file, {
          onProgress: (progress) => {
            setPendingAttachments((current) => current.map((item) => (item.id === attachmentID ? { ...item, progress } : item)));
          },
          onXhr: (xhr) => {
            setPendingAttachments((current) => current.map((item) => (item.id === attachmentID ? { ...item, xhr } : item)));
          },
        })
        .then((uploaded) => {
          setPendingAttachments((current) =>
            current.map((item) => (item.id === attachmentID ? { ...item, status: 'done', progress: 100, result: uploaded, xhr: undefined } : item)),
          );
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Upload failed.';
          setPendingAttachments((current) =>
            current.map((item) => (item.id === attachmentID ? { ...item, status: 'error', error: message, xhr: undefined } : item)),
          );
        });
    }
    if (attachInputRef.current) {
      attachInputRef.current.value = '';
    }
  }

  async function removePendingAttachment(id: string) {
    const conversation = activeConversation;
    const attachment = pendingAttachments.find((item) => item.id === id);
    attachment?.xhr?.abort();
    setPendingAttachments((current) => current.filter((item) => item.id !== id));
    if (conversation && !attachment?.xhr && attachment?.result?.name) {
      await clientRef.current.deleteUpload(conversation.id, attachment.result.name).catch(() => undefined);
    }
  }

  async function ocrPendingAttachment(id: string) {
    const conversation = activeConversation;
    const attachment = pendingAttachments.find((item) => item.id === id);
    const path = attachment?.result?.path;
    if (!conversation || !attachment || !path) {
      return;
    }
    if (attachment.ocrMarkdown) {
      appendToDraft(attachment.ocrMarkdown);
      return;
    }
    setPendingAttachments((current) =>
      current.map((item) => (item.id === id ? { ...item, ocrStatus: 'running', ocrError: undefined } : item)),
    );
    try {
      const markdown = await clientRef.current.ocrAttachment(conversation.id, path);
      setPendingAttachments((current) =>
        current.map((item) => (item.id === id ? { ...item, ocrStatus: 'done', ocrMarkdown: markdown } : item)),
      );
      appendToDraft(markdown);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OCR failed.';
      setPendingAttachments((current) =>
        current.map((item) => (item.id === id ? { ...item, ocrStatus: 'error', ocrError: message } : item)),
      );
    }
  }

  function appendToDraft(text: string) {
    const trimmed = text.trim();
    if (trimmed) {
      setDraft((current) => (current.trim() ? `${current.trimEnd()}\n\n${trimmed}` : trimmed));
    }
  }

  async function removeQueuedMessage(index: number) {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    try {
      const queue = [...(conversation.messageQueue || [])];
      queue.splice(index, 1);
      const saved = await clientRef.current.saveQueue(conversation.id, queue);
      setActiveConversation({ ...conversation, messageQueue: saved });
    } catch (error) {
      handleError(error);
    }
  }

  async function moveQueuedMessage(index: number, direction: -1 | 1) {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    const queue = [...(conversation.messageQueue || [])];
    const target = index + direction;
    if (target < 0 || target >= queue.length) {
      return;
    }
    [queue[index], queue[target]] = [queue[target], queue[index]];
    try {
      const saved = await clientRef.current.saveQueue(conversation.id, queue);
      setActiveConversation({ ...conversation, messageQueue: saved });
    } catch (error) {
      handleError(error);
    }
  }

  function openQueueEditor(index: number) {
    const item = activeConversation?.messageQueue?.[index];
    if (!item) {
      return;
    }
    setQueueEditorIndex(index);
    setQueueEditorContent(item.content || '');
    setQueueEditorAttachments(item.attachments || []);
  }

  async function saveQueueEditor() {
    const conversation = activeConversation;
    if (!conversation || queueEditorIndex === null) {
      return;
    }
    const content = queueEditorContent.trim();
    if (!content && !queueEditorAttachments.length) {
      await removeQueuedMessage(queueEditorIndex);
      closeQueueEditor();
      return;
    }
    try {
      const queue = [...(conversation.messageQueue || [])];
      queue[queueEditorIndex] = {
        content,
        attachments: queueEditorAttachments.length ? queueEditorAttachments : undefined,
      };
      const saved = await clientRef.current.saveQueue(conversation.id, queue);
      setActiveConversation({ ...conversation, messageQueue: saved });
      closeQueueEditor();
    } catch (error) {
      handleError(error);
    }
  }

  function closeQueueEditor() {
    setQueueEditorIndex(null);
    setQueueEditorContent('');
    setQueueEditorAttachments([]);
  }

  async function clearQueue() {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    try {
      await clientRef.current.clearQueue(conversation.id);
      setActiveConversation({ ...conversation, messageQueue: [] });
    } catch (error) {
      handleError(error);
    }
  }

  async function renameActiveConversation() {
    const conversation = activeConversation;
    const title = renameTitle.trim();
    if (!conversation || !title) {
      return;
    }
    try {
      const renamed = await clientRef.current.renameConversation(conversation.id, title);
      setActiveConversation(renamed);
      setConversations((items) => items.map((item) => (item.id === renamed.id ? { ...item, title: renamed.title } : item)));
      setActionsVisible(false);
    } catch (error) {
      handleError(error);
    }
  }

  async function archiveOrRestoreActiveConversation() {
    const conversation = activeConversation;
    if (!conversation || isStreaming) {
      return;
    }
    try {
      if (conversation.archived) {
        await clientRef.current.restoreConversation(conversation.id);
      } else {
        await clientRef.current.archiveConversation(conversation.id);
      }
      setActionsVisible(false);
      setActiveConversation(null);
      activeConversationRef.current = null;
      setScreen('list');
      await loadDashboard(listArchived);
    } catch (error) {
      handleError(error);
    }
  }

  async function deleteActiveConversation() {
    const conversation = activeConversation;
    if (!conversation || isStreaming || !window.confirm('Delete this conversation from the server?')) {
      return;
    }
    try {
      await clientRef.current.deleteConversation(conversation.id);
      setActionsVisible(false);
      setActiveConversation(null);
      activeConversationRef.current = null;
      setScreen('list');
      await loadDashboard(listArchived);
    } catch (error) {
      handleError(error);
    }
  }

  async function resetActiveSession() {
    const conversation = activeConversation;
    if (!conversation || isStreaming || !window.confirm('Reset this session and start a fresh CLI session?')) {
      return;
    }
    try {
      setLoading(true);
      setErrorMessage(null);
      setActionsVisible(false);
      const response = await clientRef.current.resetConversation(conversation.id);
      setActiveConversation(response.conversation);
      setConversations((items) =>
        items.map((item) =>
          item.id === response.conversation.id
            ? {
                ...item,
                title: response.conversation.title,
                backend: response.conversation.backend,
                cliProfileId: response.conversation.cliProfileId,
                model: response.conversation.model,
                effort: response.conversation.effort,
                serviceTier: response.conversation.serviceTier,
                updatedAt: new Date().toISOString(),
                messageCount: 0,
                lastMessage: null,
                archived: response.conversation.archived,
              }
            : item,
        ),
      );
      setStreamText('');
      setPendingInteraction(null);
      setPendingAttachments([]);
      setSessions((current) => (
        current.length
          ? updateSessionsAfterReset(current, response)
          : current
      ));
      setSessionViewer(null);
      await refreshConversationList();
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }

  function openMarkdownSharePicker() {
    if (!activeConversation) return;
    setActionsVisible(false);
    setMarkdownShareVisible(true);
  }

  function shareMarkdown(scope: MarkdownShareScope) {
    const conversation = activeConversation;
    if (!conversation) return;
    const url = scope === 'current'
      ? clientRef.current.sessionMarkdownURL(conversation.id, conversation.sessionNumber || 1)
      : clientRef.current.conversationMarkdownURL(conversation.id);
    setMarkdownShareVisible(false);
    window.open(url, '_blank');
  }

  async function toggleMessagePin(messageID: string, pinned: boolean) {
    const conversation = activeConversationRef.current;
    if (!conversation) {
      return;
    }
    const previous = conversation.messages.find((message) => message.id === messageID);
    const previousPinned = !!previous?.pinned;
    setActiveConversation((current) => {
      if (!current || current.id !== conversation.id) return current;
      const next = patchConversationMessage(current, messageID, pinned);
      activeConversationRef.current = next;
      return next;
    });
    try {
      const response = await clientRef.current.setMessagePinned(conversation.id, messageID, pinned);
      setActiveConversation((current) => {
        if (!current || current.id !== conversation.id) return current;
        const next = patchConversationMessage(current, messageID, !!response.message.pinned, response.message);
        activeConversationRef.current = next;
        return next;
      });
    } catch (error) {
      setActiveConversation((current) => {
        if (!current || current.id !== conversation.id) return current;
        const next = patchConversationMessage(current, messageID, previousPinned);
        activeConversationRef.current = next;
        return next;
      });
      handleError(error);
    }
  }

  async function openSessions() {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    try {
      const loaded = await clientRef.current.getSessions(conversation.id);
      setSessions(loaded);
      setSessionViewer(null);
      setSessionsVisible(true);
    } catch (error) {
      handleError(error);
    }
  }

  async function viewSession(session: SessionHistoryItem) {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    try {
      let messages: Message[];
      if (session.isCurrent) {
        messages = conversation.messages;
      } else {
        const response = await clientRef.current.getSessionMessages(conversation.id, session.number);
        messages = response.messages || [];
      }
      setSessionViewer({ session, messages });
      setSessionsVisible(false);
    } catch (error) {
      handleError(error);
    }
  }

  async function openFiles() {
    setFilesVisible(true);
    setExplorerEditContent('');
    await loadExplorer('');
  }

  async function loadExplorer(path: string) {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    try {
      const tree = await clientRef.current.getExplorerTree(workspaceRef(conversation), path);
      setExplorerPath(tree.path || '');
      setExplorerParent(tree.parent ?? null);
      setExplorerEntries(tree.entries || []);
      setExplorerPreview(null);
      setExplorerEditContent('');
    } catch (error) {
      handleError(error);
    }
  }

  async function openExplorerEntry(entry: ExplorerEntry) {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    const entryPath = joinExplorerPath(explorerPath, entry.name);
    if (entry.type === 'dir') {
      await loadExplorer(entryPath);
      return;
    }
    if (isImageFileName(entry.name)) {
      await openFileReference(makeExplorerFileReference(clientRef.current, workspaceRef(conversation), entryPath));
      return;
    }
    try {
      const preview = await clientRef.current.getExplorerPreview(workspaceRef(conversation), entryPath);
      setExplorerPreview(preview);
      setExplorerEditContent(preview.content);
    } catch (error) {
      if (error instanceof AgentAPIError && (error.status === 413 || error.status === 415)) {
        await openFileReference(makeExplorerFileReference(clientRef.current, workspaceRef(conversation), entryPath));
        return;
      }
      handleError(error);
    }
  }

  async function createExplorerFolder() {
    const conversation = activeConversation;
    const name = window.prompt('Folder name');
    if (!conversation || !name?.trim()) {
      return;
    }
    try {
      await clientRef.current.createExplorerFolder(workspaceRef(conversation), explorerPath, name.trim());
      await loadExplorer(explorerPath);
    } catch (error) {
      handleError(error);
    }
  }

  async function createExplorerFile() {
    const conversation = activeConversation;
    const name = window.prompt('File name');
    if (!conversation || !name?.trim()) {
      return;
    }
    try {
      const created = await clientRef.current.createExplorerFile(workspaceRef(conversation), explorerPath, name.trim());
      await loadExplorer(explorerPath);
      if (created.path) {
        const preview = await clientRef.current.getExplorerPreview(workspaceRef(conversation), created.path);
        setExplorerPreview(preview);
        setExplorerEditContent(preview.content);
      }
    } catch (error) {
      handleError(error);
    }
  }

  async function saveExplorerPreview() {
    const conversation = activeConversation;
    if (!conversation || !explorerPreview) {
      return;
    }
    try {
      await clientRef.current.saveExplorerFile(workspaceRef(conversation), explorerPreview.path, explorerEditContent);
      const preview = await clientRef.current.getExplorerPreview(workspaceRef(conversation), explorerPreview.path);
      setExplorerPreview(preview);
      setExplorerEditContent(preview.content);
      await loadExplorer(explorerPath);
    } catch (error) {
      handleError(error);
    }
  }

  async function renameExplorerPath(fromPath: string) {
    const conversation = activeConversation;
    const nextPath = window.prompt('New workspace-relative path', fromPath);
    if (!conversation || !nextPath?.trim() || nextPath.trim() === fromPath) {
      return;
    }
    try {
      await clientRef.current.renameExplorerEntry(workspaceRef(conversation), fromPath, nextPath.trim());
      await loadExplorer(parentExplorerPath(nextPath.trim()));
    } catch (error) {
      if (error instanceof AgentAPIError && error.status === 409 && window.confirm('Destination exists. Overwrite it?')) {
        await clientRef.current.renameExplorerEntry(workspaceRef(conversation), fromPath, nextPath.trim(), true);
        await loadExplorer(parentExplorerPath(nextPath.trim()));
        return;
      }
      handleError(error);
    }
  }

  async function deleteExplorerPath(path: string) {
    const conversation = activeConversation;
    if (!conversation || !window.confirm(`Delete ${path}?`)) {
      return;
    }
    try {
      await clientRef.current.deleteExplorerEntry(workspaceRef(conversation), path);
      await loadExplorer(explorerPath);
    } catch (error) {
      handleError(error);
    }
  }

  async function uploadExplorerFiles(files: FileList | null) {
    const conversation = activeConversation;
    if (!conversation || !files?.length) {
      return;
    }
    for (const file of Array.from(files)) {
      void uploadExplorerFile(file);
    }
    if (explorerUploadInputRef.current) {
      explorerUploadInputRef.current.value = '';
    }
  }

  async function uploadExplorerFile(file: File, overwrite = false, existingID?: string) {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    const id = existingID || `${Date.now()}-${file.name}-${Math.random().toString(16).slice(2)}`;
    if (!existingID) {
      setExplorerUploads((current) => [...current, { id, fileName: file.name, status: 'uploading', progress: 0 }]);
    } else {
      setExplorerUploads((current) => current.map((item) => (item.id === id ? { ...item, status: 'uploading', progress: 0, error: undefined } : item)));
    }
    try {
      await clientRef.current.uploadExplorerFile(workspaceRef(conversation), explorerPath, file, overwrite, {
        onProgress: (progress) => setExplorerUploads((current) => current.map((item) => (item.id === id ? { ...item, progress } : item))),
        onXhr: (xhr) => setExplorerUploads((current) => current.map((item) => (item.id === id ? { ...item, xhr } : item))),
      });
      setExplorerUploads((current) => current.map((item) => (item.id === id ? { ...item, status: 'done', progress: 100, xhr: undefined } : item)));
      await loadExplorer(explorerPath);
    } catch (error) {
      if (error instanceof AgentAPIError && error.status === 409 && !overwrite) {
        setExplorerUploads((current) => current.map((item) => (item.id === id ? { ...item, status: 'error', error: 'File exists', xhr: undefined } : item)));
        if (window.confirm(`${file.name} already exists. Overwrite it?`)) {
          await uploadExplorerFile(file, true, id);
        }
        return;
      }
      const message = error instanceof Error ? error.message : 'Upload failed.';
      setExplorerUploads((current) => current.map((item) => (item.id === id ? { ...item, status: 'error', error: message, xhr: undefined } : item)));
    }
  }

  function clearOrCancelExplorerUpload(upload: ExplorerUpload) {
    upload.xhr?.abort();
    setExplorerUploads((current) => current.filter((item) => item.id !== upload.id));
  }

  async function openFileReference(reference: FileReference) {
    setFilePreview({ title: reference.title, path: reference.path, downloadURL: reference.downloadURL, mimeType: reference.mimeType });
    setFilePreviewLoading(true);
    try {
      if (reference.isImage) {
        setFilePreview({
          title: reference.title,
          path: reference.path,
          downloadURL: reference.downloadURL,
          imageURL: reference.downloadURL,
          mimeType: reference.mimeType,
        });
        return;
      }
      if (reference.fetchPreview) {
        const preview = await reference.fetchPreview();
        setFilePreview({
          title: reference.title,
          path: preview.path || reference.path,
          downloadURL: reference.downloadURL,
          content: preview.content,
          mimeType: preview.mimeType || reference.mimeType,
          truncated: preview.truncated,
        });
        return;
      }
      setFilePreview({ title: reference.title, path: reference.path, downloadURL: reference.downloadURL, error: 'Preview unavailable.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preview failed.';
      setFilePreview({ title: reference.title, path: reference.path, downloadURL: reference.downloadURL, error: message });
    } finally {
      setFilePreviewLoading(false);
    }
  }

  async function shareFileReference(reference: FileReference) {
    try {
      const response = await fetch(reference.downloadURL, { credentials: 'same-origin' });
      if (!response.ok) {
        throw new AgentAPIError(`File download failed with HTTP ${response.status}.`, response.status);
      }
      const blob = await response.blob();
      const file = new File([blob], reference.title, { type: blob.type || reference.mimeType || 'application/octet-stream' });
      if (navigator.canShare?.({ files: [file] }) && navigator.share) {
        await navigator.share({ title: reference.title, files: [file] });
        return;
      }
      downloadBlob(blob, reference.title);
    } catch (error) {
      handleError(error);
    }
  }

  function copyFilePreview() {
    if (filePreview?.content) {
      void navigator.clipboard.writeText(filePreview.content);
    }
  }

  function chooseProfile(profileID: string) {
    if (profileSelectionLocked) {
      return;
    }
    const profile = availableProfiles.find((item) => item.id === profileID);
    setSelectedCliProfileId(profileID);
    setSelectedBackend(backendIdForProfile(profile));
    setSelectedModel(undefined);
    setSelectedEffort(undefined);
    setSelectedServiceTier(profile?.vendor === 'codex' ? (selectedServiceTier || settings?.defaultServiceTier) : undefined);
  }

  function handleError(error: unknown) {
    const message = error instanceof Error ? error.message : 'Something went wrong.';
    setErrorMessage(message);
    if (error instanceof AgentAPIError && error.status === 401) {
      window.location.href = clientRef.current.loginURL();
    }
  }

  function notify(title: string, body: string) {
    if (!document.hidden || !('Notification' in window)) {
      return;
    }
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  }

  if (loading && !conversations.length) {
    return (
      <main className="loading-screen">
        <div className="spinner" />
        <p>Opening Agent Cockpit...</p>
      </main>
    );
  }

  return (
    <main className="app-shell">
      {screen === 'list' ? (
        <ConversationListScreen
          conversations={conversations}
          activeStreamIDs={activeStreamIDs}
          activeGoalIDs={activeGoalIDs}
          archived={listArchived}
          workspaceFilter={workspaceFilter}
          loading={loading}
          currentUser={currentUser}
          errorMessage={errorMessage}
          onRefresh={() => void loadDashboard(listArchived)}
          onToggleArchived={() => void loadDashboard(!listArchived)}
          onWorkspaceFilter={setWorkspaceFilter}
          onOpenConversation={(id) => void openConversation(id)}
          onNewConversation={(initialPath) => {
            setNewWorkingDir(initialPath ?? settings?.workingDirectory ?? '');
            setNewConversationVisible(true);
          }}
        />
      ) : (
        <ChatScreen
          conversation={activeConversation}
          backends={backends}
          cliProfiles={availableProfiles}
          selectedCliProfileId={selectedCliProfileId}
          draft={draft}
          setDraft={setDraft}
          streamText={streamText}
          showStreamPlaceholder={showStreamPlaceholder}
          isStreaming={isStreaming}
          loading={loading}
          errorMessage={errorMessage}
          goal={goal}
          goalUpdatedAtMs={goalUpdatedAtMs}
          goalMode={goalMode}
          goalCapable={goalCapable}
          pendingInteraction={pendingInteraction}
          interactionAnswer={interactionAnswer}
          setInteractionAnswer={setInteractionAnswer}
          pendingAttachments={pendingAttachments}
          hasUploadingAttachments={hasUploadingAttachments}
          selectedProfile={selectedProfile?.name}
          selectedBackend={selectedBackendMetadata?.label || selectedBackend}
          selectedModel={selectedModelMetadata?.label || selectedModel}
          selectedEffort={selectedEffort}
          selectedServiceTier={serviceTierEnabled ? selectedServiceTier : undefined}
          client={clientRef.current}
          onBack={() => {
            clearStreamReconnectTimer();
            closeStreamSocket();
            setSessionsVisible(false);
            setSessionViewer(null);
            setScreen('list');
            void refreshConversationList();
          }}
          onSend={() => void sendDraft()}
          onStop={() => void stopStream()}
          onGoalModeChange={setGoalMode}
          onRefreshGoal={() => void refreshGoalState()}
          onPauseGoal={() => void pauseGoalNow()}
          onResumeGoal={() => void resumeGoalNow()}
          onClearGoal={() => void clearGoalNow()}
          onAttach={() => attachInputRef.current?.click()}
          onRemoveAttachment={(id) => void removePendingAttachment(id)}
          onOcrAttachment={(id) => void ocrPendingAttachment(id)}
          onSubmitInteraction={() => void submitInteraction()}
          onRemoveQueued={(index) => void removeQueuedMessage(index)}
          onEditQueued={openQueueEditor}
          onMoveQueued={(index, direction) => void moveQueuedMessage(index, direction)}
          onClearQueue={() => void clearQueue()}
          onTogglePin={(messageID, pinned) => void toggleMessagePin(messageID, pinned)}
          onOpenFile={(reference) => void openFileReference(reference)}
          onShareFile={(reference) => void shareFileReference(reference)}
          onOpenActions={() => {
            setRenameTitle(activeConversation?.title || '');
            setActionsVisible(true);
          }}
          onOpenSettings={() => setSettingsVisible(true)}
        />
      )}

      <input ref={attachInputRef} className="hidden-input" type="file" multiple onChange={(event) => void handleAttachmentFiles(event.currentTarget.files)} />

      {newConversationVisible ? (
        <NewConversationModal
          client={clientRef.current}
          title={newTitle}
          workingDir={newWorkingDir}
          loading={loading}
          onTitleChange={setNewTitle}
          onWorkingDirChange={setNewWorkingDir}
          onCancel={() => setNewConversationVisible(false)}
          onCreate={() => void createConversation()}
        />
      ) : null}

      {actionsVisible ? (
        <ActionsModal
          conversation={activeConversation}
          renameTitle={renameTitle}
          setRenameTitle={setRenameTitle}
          isStreaming={isStreaming}
          onClose={() => setActionsVisible(false)}
          onRename={() => void renameActiveConversation()}
          onArchiveRestore={() => void archiveOrRestoreActiveConversation()}
          onDelete={() => void deleteActiveConversation()}
          onShare={openMarkdownSharePicker}
          onSessions={() => void openSessions()}
          onFiles={() => void openFiles()}
          onReset={() => void resetActiveSession()}
        />
      ) : null}

      {markdownShareVisible ? (
        <MarkdownShareModal
          conversation={activeConversation}
          onClose={() => setMarkdownShareVisible(false)}
          onShare={shareMarkdown}
        />
      ) : null}

      {settingsVisible ? (
        <RunSettingsModal
          profiles={availableProfiles}
          selectedCliProfileId={selectedCliProfileId}
          selectedBackendMetadata={selectedBackendMetadata}
          selectedModel={selectedModel}
          selectedEffort={selectedEffort}
          selectedServiceTier={selectedServiceTier}
          serviceTierEnabled={serviceTierEnabled}
          supportedEfforts={supportedEfforts}
          locked={profileSelectionLocked}
          onClose={() => setSettingsVisible(false)}
          onProfile={chooseProfile}
          onModel={setSelectedModel}
          onEffort={setSelectedEffort}
          onServiceTier={setSelectedServiceTier}
        />
      ) : null}

      {sessionsVisible ? (
        <SessionsModal
          conversation={activeConversation}
          sessions={sessions}
          onClose={() => setSessionsVisible(false)}
          onView={(session) => void viewSession(session)}
          onShare={(session) => {
            if (activeConversation) window.open(clientRef.current.sessionMarkdownURL(activeConversation.id, session.number), '_blank');
          }}
        />
      ) : null}

      {sessionViewer && activeConversation ? (
        <ReadOnlySessionScreen
          client={clientRef.current}
          backends={backends}
          conversation={activeConversation}
          session={sessionViewer.session}
          messages={sessionViewer.messages}
          onBack={() => {
            setSessionViewer(null);
            setSessionsVisible(true);
          }}
          onShare={() => window.open(clientRef.current.sessionMarkdownURL(activeConversation.id, sessionViewer.session.number), '_blank')}
          onOpenFile={(reference) => void openFileReference(reference)}
          onShareFile={(reference) => void shareFileReference(reference)}
        />
      ) : null}

      {filesVisible ? (
        <FilesModal
          path={explorerPath}
          parent={explorerParent}
          entries={explorerEntries}
          preview={explorerPreview}
          editContent={explorerEditContent}
          uploads={explorerUploads}
          uploadInputRef={explorerUploadInputRef}
          onEditContent={setExplorerEditContent}
          onClose={() => setFilesVisible(false)}
          onParent={() => void loadExplorer(explorerParent ?? '')}
          onRefresh={() => void loadExplorer(explorerPath)}
          onEntry={(entry) => void openExplorerEntry(entry)}
          onNewFolder={() => void createExplorerFolder()}
          onNewFile={() => void createExplorerFile()}
          onUploadFiles={(files) => void uploadExplorerFiles(files)}
          onRenameEntry={(entry) => void renameExplorerPath(joinExplorerPath(explorerPath, entry.name))}
          onDeleteEntry={(entry) => void deleteExplorerPath(joinExplorerPath(explorerPath, entry.name))}
          onSavePreview={() => void saveExplorerPreview()}
          onRenamePreview={() => (explorerPreview ? void renameExplorerPath(explorerPreview.path) : undefined)}
          onDeletePreview={() => (explorerPreview ? void deleteExplorerPath(explorerPreview.path) : undefined)}
          onOpenPreviewFile={() => {
            if (activeConversation && explorerPreview) {
              void openFileReference(makeExplorerFileReference(clientRef.current, workspaceRef(activeConversation), explorerPreview.path));
            }
          }}
          onSharePreviewFile={() => {
            if (activeConversation && explorerPreview) {
              void shareFileReference(makeExplorerFileReference(clientRef.current, workspaceRef(activeConversation), explorerPreview.path));
            }
          }}
          onCancelUpload={clearOrCancelExplorerUpload}
        />
      ) : null}

      {filePreview ? (
        <FilePreviewModal
          preview={filePreview}
          loading={filePreviewLoading}
          onClose={() => setFilePreview(null)}
          onCopy={copyFilePreview}
          onShare={() => void shareFileReference({
            id: filePreview.path,
            title: filePreview.title,
            path: filePreview.path,
            downloadURL: filePreview.downloadURL,
            mimeType: filePreview.mimeType,
          })}
        />
      ) : null}

      {queueEditorIndex !== null ? (
        <QueueEditorModal
          content={queueEditorContent}
          attachments={queueEditorAttachments}
          onContentChange={setQueueEditorContent}
          onRemoveAttachment={(path) => setQueueEditorAttachments((items) => items.filter((attachment) => attachment.path !== path))}
          onCancel={closeQueueEditor}
          onSave={() => void saveQueueEditor()}
        />
      ) : null}
    </main>
  );
}
