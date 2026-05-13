import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { AgentAPIError, AgentCockpitAPI } from './api';
import {
  ALL_WORKSPACES,
  cleanGoalObjectiveText,
  completedAttachmentMetas,
  conversationListItemFromConversation,
  displayMessagePreview,
  downloadBlob,
  fileReferencesFromParsed,
  formatBytes,
  formatDate,
  formatGoalElapsed,
  formatPercent,
  goalElapsedSeconds,
  goalSnapshotTimeMs,
  goalStatusLabel,
  goalSupportsAction,
  joinExplorerPath,
  lastTwoPathComponents,
  isImageFileName,
  isActiveGoal,
  makeConversationArtifactReference,
  makeExplorerFileReference,
  parentExplorerPath,
  parseMessageFiles,
  reconcileEffort,
  shouldApplyGoalSnapshot,
  updateSessionsAfterReset,
  upsertMessage,
  userLabel,
  wireContent,
  workspaceOptions,
  type ExplorerUpload,
  type FilePreviewState,
  type FileReference,
} from './appModel';
import { useViewportHeightVar } from './useViewportHeightVar';
import type {
  AttachmentMeta,
  BackendMetadata,
  ContentBlock,
  Conversation,
  ConversationListItem,
  CurrentUser,
  DirectoryBrowseResponse,
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
  Usage,
} from './types';

const LIST_AUTO_REFRESH_MS = 15_000;
const STREAM_RECONNECT_BASE_MS = 1_000;
const STREAM_RECONNECT_MAX_MS = 15_000;

type Screen = 'list' | 'chat';
type SessionViewerState = { session: SessionHistoryItem; messages: Message[] };
type GoalCapabilityMetadata = NonNullable<NonNullable<BackendMetadata['capabilities']>['goals']>;
type GoalCapability = {
  set: boolean;
  clear: boolean;
  pause: boolean;
  resume: boolean;
  status: 'native' | 'transcript' | 'none';
};

function normalizeGoalCapability(capability: GoalCapabilityMetadata | undefined, backendID?: string): GoalCapability {
  if (capability === true) {
    return { set: true, clear: true, pause: true, resume: true, status: 'native' };
  }
  if (capability && typeof capability === 'object') {
    return {
      set: capability.set === true,
      clear: capability.clear === true,
      pause: capability.pause === true,
      resume: capability.resume === true,
      status: capability.status || 'none',
    };
  }
  if (backendID === 'codex') return { set: true, clear: true, pause: true, resume: true, status: 'native' };
  if (backendID === 'claude-code') return { set: true, clear: true, pause: false, resume: false, status: 'transcript' };
  return { set: false, clear: false, pause: false, resume: false, status: 'none' };
}

function goalCapabilityForBackend(
  backends: BackendMetadata[],
  backendID?: string | null,
  metadata?: BackendMetadata,
): GoalCapability {
  const backend = metadata || (backends || []).find((item) => item.id === backendID);
  return normalizeGoalCapability(backend?.capabilities?.goals, backendID || backend?.id);
}

function goalActionUnsupportedMessage(action: 'pause' | 'resume' | 'clear', backendID?: string | null): string {
  const backendName = backendID === 'claude-code' ? 'Claude Code' : backendID === 'codex' ? 'Codex' : 'this backend';
  return `Goal ${action} is not supported by ${backendName}.`;
}

function messageWithPinned(message: Message, pinned: boolean): Message {
  const next: Message = { ...message };
  if (pinned) next.pinned = true;
  else delete next.pinned;
  return next;
}

function patchConversationMessage(
  conversation: Conversation,
  messageID: string,
  pinned: boolean,
  replacement?: Message,
): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) =>
      message.id === messageID ? (replacement || messageWithPinned(message, pinned)) : message,
    ),
  };
}

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
  const selectedBackendMetadata = useMemo(() => {
    if (selectedCliProfileId && profileMetadata[selectedCliProfileId]) {
      return profileMetadata[selectedCliProfileId];
    }
    return backends.find((backend) => backend.id === selectedBackend);
  }, [backends, profileMetadata, selectedBackend, selectedCliProfileId]);
  const selectedModelMetadata = useMemo(
    () => selectedBackendMetadata?.models?.find((model) => model.id === selectedModel),
    [selectedBackendMetadata, selectedModel],
  );
  const supportedEfforts = selectedModelMetadata?.supportedEffortLevels || [];
  const selectedBackendID = selectedProfile?.vendor || selectedBackendMetadata?.id || selectedBackend;
  const selectedGoalCapability = useMemo(
    () => goalCapabilityForBackend(backends, selectedBackendID, selectedBackendMetadata),
    [backends, selectedBackendID, selectedBackendMetadata],
  );
  const goalCapable = selectedGoalCapability.set === true;
  const serviceTierEnabled = selectedBackendID === 'codex';
  const hasUploadingAttachments = pendingAttachments.some((attachment) => attachment.status === 'uploading');
  const profileSelectionLocked = (activeConversation?.messages.length || 0) > 0;

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

  useEffect(() => {
    const resumeVisibleStream = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      const conversationID = activeConversationRef.current?.id;
      if (conversationID && isStreamingRef.current) {
        void resumeStreamConnectionRef.current(conversationID, true);
      }
    };
    window.addEventListener('focus', resumeVisibleStream);
    window.addEventListener('online', resumeVisibleStream);
    document.addEventListener('visibilitychange', resumeVisibleStream);
    return () => {
      window.removeEventListener('focus', resumeVisibleStream);
      window.removeEventListener('online', resumeVisibleStream);
      document.removeEventListener('visibilitychange', resumeVisibleStream);
    };
  }, []);

  useEffect(() => {
    if (workspaceFilter !== ALL_WORKSPACES && conversations.every((conversation) => conversation.workspaceHash !== workspaceFilter)) {
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

  useEffect(() => {
    if (screen !== 'list') {
      return;
    }
    const refresh = () => void refreshConversationList();
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    };
    const timer = window.setInterval(refresh, LIST_AUTO_REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [screen, listArchived]);

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
      hydrateSelectionDefaults(loadedSettings, loadedBackends);
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }

  function hydrateSelectionDefaults(loadedSettings: Settings, loadedBackends: BackendMetadata[]) {
    const profiles = (loadedSettings.cliProfiles || []).filter((profile) => profile.disabled !== true);
    const profileID = loadedSettings.defaultCliProfileId || profiles[0]?.id;
    const backendID = profileID ? undefined : loadedSettings.defaultBackend || loadedBackends[0]?.id;
    setSelectedCliProfileId(profileID);
    setSelectedBackend(backendID);
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
    setSelectedBackend(conversation.cliProfileId ? undefined : conversation.backend || settings?.defaultBackend);
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
    try {
      setDraft('');
      setPendingAttachments([]);
      const response = await clientRef.current.sendMessage(conversation.id, {
        content: wireContent(message),
        backend: selectedBackend,
        cliProfileId: selectedCliProfileId,
        model: selectedModel,
        effort: selectedEffort,
        serviceTier: serviceTierEnabled ? selectedServiceTier : undefined,
      });
      setActiveConversation((current) =>
        current && current.id === conversation.id
          ? {
              ...current,
              serviceTier: selectedServiceTier === 'fast' ? 'fast' : undefined,
              messages: [...current.messages, response.userMessage],
            }
          : current,
      );
      if (response.streamReady) {
        startStream(conversation.id);
      }
    } catch (error) {
      setDraft(message.content);
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
    const optimisticBackend = selectedBackendID === 'codex' || selectedBackendID === 'claude-code' ? selectedBackendID : undefined;
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
    if (goal.backend === 'claude-code' && isStreaming) {
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
        setStreamText((current) => current + (event.content || ''));
        break;
      case 'assistant_message':
        if (event.message) {
          setActiveConversation((current) =>
            current && current.id === conversationID ? { ...current, messages: upsertMessage(current.messages, event.message) } : current,
          );
        }
        setStreamText('');
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
        markStreamFinished(conversationID);
        notify('Agent Cockpit stream finished', 'The latest response is ready.');
        void refreshAfterStream(conversationID);
        break;
      case 'replay_start':
        setStreamText('');
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

  function shareActiveConversation() {
    if (activeConversation) {
      window.open(clientRef.current.conversationMarkdownURL(activeConversation.id), '_blank');
    }
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
      const tree = await clientRef.current.getExplorerTree(conversation.workspaceHash, path);
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
      await openFileReference(makeExplorerFileReference(clientRef.current, conversation.workspaceHash, entryPath));
      return;
    }
    try {
      const preview = await clientRef.current.getExplorerPreview(conversation.workspaceHash, entryPath);
      setExplorerPreview(preview);
      setExplorerEditContent(preview.content);
    } catch (error) {
      if (error instanceof AgentAPIError && (error.status === 413 || error.status === 415)) {
        await openFileReference(makeExplorerFileReference(clientRef.current, conversation.workspaceHash, entryPath));
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
      await clientRef.current.createExplorerFolder(conversation.workspaceHash, explorerPath, name.trim());
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
      const created = await clientRef.current.createExplorerFile(conversation.workspaceHash, explorerPath, name.trim());
      await loadExplorer(explorerPath);
      if (created.path) {
        const preview = await clientRef.current.getExplorerPreview(conversation.workspaceHash, created.path);
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
      await clientRef.current.saveExplorerFile(conversation.workspaceHash, explorerPreview.path, explorerEditContent);
      const preview = await clientRef.current.getExplorerPreview(conversation.workspaceHash, explorerPreview.path);
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
      await clientRef.current.renameExplorerEntry(conversation.workspaceHash, fromPath, nextPath.trim());
      await loadExplorer(parentExplorerPath(nextPath.trim()));
    } catch (error) {
      if (error instanceof AgentAPIError && error.status === 409 && window.confirm('Destination exists. Overwrite it?')) {
        await clientRef.current.renameExplorerEntry(conversation.workspaceHash, fromPath, nextPath.trim(), true);
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
      await clientRef.current.deleteExplorerEntry(conversation.workspaceHash, path);
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
      await clientRef.current.uploadExplorerFile(conversation.workspaceHash, explorerPath, file, overwrite, {
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
    setSelectedBackend(undefined);
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
          draft={draft}
          setDraft={setDraft}
          streamText={streamText}
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
          onShare={shareActiveConversation}
          onSessions={() => void openSessions()}
          onFiles={() => void openFiles()}
          onReset={() => void resetActiveSession()}
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
              void openFileReference(makeExplorerFileReference(clientRef.current, activeConversation.workspaceHash, explorerPreview.path));
            }
          }}
          onSharePreviewFile={() => {
            if (activeConversation && explorerPreview) {
              void shareFileReference(makeExplorerFileReference(clientRef.current, activeConversation.workspaceHash, explorerPreview.path));
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

function ConversationListScreen(props: {
  conversations: ConversationListItem[];
  activeStreamIDs: Set<string>;
  activeGoalIDs: Set<string>;
  archived: boolean;
  workspaceFilter: string;
  loading: boolean;
  currentUser: CurrentUser | null;
  errorMessage: string | null;
  onRefresh: () => void;
  onToggleArchived: () => void;
  onWorkspaceFilter: (workspaceHash: string) => void;
  onOpenConversation: (id: string) => void;
  onNewConversation: (initialPath?: string) => void;
}) {
  const workspaces = useMemo(() => workspaceOptions(props.conversations), [props.conversations]);
  const visibleConversations = props.workspaceFilter === ALL_WORKSPACES
    ? props.conversations
    : props.conversations.filter((conversation) => conversation.workspaceHash === props.workspaceFilter);
  const selectedWorkspace = props.workspaceFilter === ALL_WORKSPACES
    ? null
    : workspaces.find((workspace) => workspace.hash === props.workspaceFilter) || null;
  const selectedWorkspaceLabel = selectedWorkspace?.label || 'All conversations';
  const activeConversationCount = props.archived ? 0 : props.conversations.length;

  return (
    <section className="screen list-screen">
      <header className="topbar app-header">
        <div>
          <h1>
            <span className="brand-mark" aria-hidden="true">
              <img src="/logo-full-no-text.svg" alt="" />
            </span>
            Agent Cockpit
          </h1>
          <p>{userLabel(props.currentUser)} · {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'}</p>
        </div>
        <button className="icon-btn" type="button" aria-label="New chat" onClick={() => props.onNewConversation(selectedWorkspace?.fullPath)}>
          <PlusIcon />
        </button>
        {props.loading ? <div className="mini-spinner" /> : null}
      </header>
      <nav className="toolbar list-toolbar">
        <div className="segment-control" aria-label="Conversation status">
          <button type="button" aria-pressed={!props.archived} onClick={() => { if (props.archived) props.onToggleArchived(); }}>
            <span className="status-dot running" aria-hidden="true" />
            Active
            <span className="segment-count">{activeConversationCount}</span>
          </button>
          <button type="button" aria-pressed={props.archived} onClick={() => { if (!props.archived) props.onToggleArchived(); }}>
            Archive
          </button>
        </div>
        <button className="toolbar-icon" type="button" aria-label="Refresh" onClick={props.onRefresh}>
          <ResetIcon />
        </button>
        {'Notification' in window && Notification.permission === 'default' ? (
          <button className="btn toolbar-btn" type="button" onClick={() => void Notification.requestPermission()}>Enable Alerts</button>
        ) : null}
        {workspaces.length > 1 ? (
          <label className="filter-select">
            <span>Workspace</span>
            <select value={props.workspaceFilter} onChange={(event) => props.onWorkspaceFilter(event.currentTarget.value)}>
              <option value={ALL_WORKSPACES}>All conversations</option>
              {workspaces.map((workspace) => (
                <option key={workspace.hash} value={workspace.hash}>{workspace.label}</option>
              ))}
            </select>
            <span className="workspace-value" aria-hidden="true"><span className="workspace-dot" />{selectedWorkspaceLabel}</span>
            <ChevronDownIcon />
          </label>
        ) : null}
      </nav>
      {props.errorMessage ? <ErrorBanner message={props.errorMessage} /> : null}
      <div className="conversation-list">
        {visibleConversations.length ? visibleConversations.map((conversation) => {
          const streamActive = props.activeStreamIDs.has(conversation.id);
          const goalActive = props.activeGoalIDs.has(conversation.id);
          const live = streamActive || goalActive;
          return (
            <button
              key={conversation.id}
              className={`conversation-card ${live ? 'streaming' : ''}`}
              onClick={() => props.onOpenConversation(conversation.id)}
            >
              <span className="conversation-kicker">
                <span className="status-dot" aria-hidden="true" />
                <span className="workspace">{lastTwoPathComponents(conversation.workingDir)}</span>
              </span>
              <strong className="conversation-title">{conversation.title || 'Untitled'}</strong>
              {live ? (
                <span className="live-strip"><span className="live-ring" aria-hidden="true" />running · {streamActive ? 'stream active' : 'goal active'}</span>
              ) : conversation.lastMessage ? (
                <span className="last-message">{displayMessagePreview(conversation.lastMessage)}</span>
              ) : (
                <span className="last-message empty-preview">Untitled · first message will name this conversation.</span>
              )}
              <span className="conversation-meta">
                {live ? <span className="meta-live">live</span> : null}
                <span>{conversation.messageCount} msgs</span>
                <span className="meta-spacer" />
                <span>{formatDate(conversation.updatedAt)}</span>
              </span>
            </button>
          );
        }) : <p className="empty">{props.conversations.length ? 'No conversations in this workspace.' : 'No conversations.'}</p>}
      </div>
    </section>
  );
}

function ChatScreen(props: {
  conversation: Conversation | null;
  backends: BackendMetadata[];
  draft: string;
  setDraft: (value: string) => void;
  streamText: string;
  isStreaming: boolean;
  loading: boolean;
  errorMessage: string | null;
  goal: ThreadGoal | null;
  goalUpdatedAtMs: number | null;
  goalMode: boolean;
  goalCapable: boolean;
  pendingInteraction: PendingInteraction | null;
  interactionAnswer: string;
  setInteractionAnswer: (value: string) => void;
  pendingAttachments: PendingAttachment[];
  hasUploadingAttachments: boolean;
  selectedProfile?: string;
  selectedBackend?: string;
  selectedModel?: string;
  selectedEffort?: EffortLevel;
  selectedServiceTier?: ServiceTier | 'default';
  client: AgentCockpitAPI;
  onBack: () => void;
  onSend: () => void;
  onStop: () => void;
  onGoalModeChange: (enabled: boolean) => void;
  onRefreshGoal: () => void;
  onPauseGoal: () => void;
  onResumeGoal: () => void;
  onClearGoal: () => void;
  onAttach: () => void;
  onRemoveAttachment: (id: string) => void;
  onOcrAttachment: (id: string) => void;
  onSubmitInteraction: () => void;
  onRemoveQueued: (index: number) => void;
  onEditQueued: (index: number) => void;
  onMoveQueued: (index: number, direction: -1 | 1) => void;
  onClearQueue: () => void;
  onTogglePin: (messageID: string, pinned: boolean) => void;
  onOpenFile: (reference: FileReference) => void;
  onShareFile: (reference: FileReference) => void;
  onOpenActions: () => void;
  onOpenSettings: () => void;
}) {
  const conversation = props.conversation;
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pinFocusTimerRef = useRef<number | null>(null);
  const [pinStripIndex, setPinStripIndex] = useState(0);
  const [focusedPinID, setFocusedPinID] = useState<string | null>(null);
  const lastMessage = conversation?.messages[conversation.messages.length - 1];
  const pinnedMessages = useMemo(
    () => (conversation?.messages || []).filter((message) => !!message.pinned),
    [conversation?.messages],
  );
  const scrollKey = [
    conversation?.id || '',
    conversation?.messages.length || 0,
    lastMessage?.id || '',
    lastMessage?.content.length || 0,
    props.streamText.length,
    props.isStreaming ? 'streaming' : 'idle',
  ].join(':');
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      return;
    }
    transcript.scrollTop = transcript.scrollHeight;
  }, [scrollKey]);
  useEffect(() => {
    setPinStripIndex(0);
    setFocusedPinID(null);
    if (pinFocusTimerRef.current !== null) {
      window.clearTimeout(pinFocusTimerRef.current);
      pinFocusTimerRef.current = null;
    }
  }, [conversation?.id]);
  useEffect(() => {
    setPinStripIndex((index) => Math.min(index, Math.max(pinnedMessages.length - 1, 0)));
  }, [pinnedMessages.length]);
  useEffect(() => () => {
    if (pinFocusTimerRef.current !== null) window.clearTimeout(pinFocusTimerRef.current);
  }, []);
  function setMessageRef(id: string, node: HTMLDivElement | null) {
    if (node) messageRefs.current.set(id, node);
    else messageRefs.current.delete(id);
  }
  function jumpToPinnedMessage(message: Message, index: number) {
    setPinStripIndex(index);
    const node = messageRefs.current.get(message.id);
    if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFocusedPinID(message.id);
    if (pinFocusTimerRef.current !== null) window.clearTimeout(pinFocusTimerRef.current);
    pinFocusTimerRef.current = window.setTimeout(() => {
      setFocusedPinID(null);
      pinFocusTimerRef.current = null;
    }, 1600);
  }
  if (!conversation) {
    return <section className="screen center">No conversation selected.</section>;
  }
  const sendDisabled =
    (!props.draft.trim() && !completedAttachmentMetas(props.pendingAttachments).length) ||
    props.hasUploadingAttachments ||
    !!props.pendingInteraction ||
    (props.goalMode && props.isStreaming);
  const composerPlaceholder = props.goalMode
    ? (props.isStreaming ? 'Goal can be set after this stream finishes.' : 'Set a goal')
    : (props.isStreaming ? 'Message will be queued while the stream runs.' : 'Message Agent Cockpit');
  const sendLabel = props.goalMode ? 'Set goal' : (props.isStreaming ? 'Queue' : 'Send');

  return (
    <section className="screen chat-screen">
      <header className={`chat-topbar ${props.isStreaming ? 'has-stop' : ''}`}>
        <button className="nav-button back" type="button" onClick={props.onBack}>
          <BackChevronIcon />
          Back
        </button>
        <div className="chat-title">
          <h1>{conversation.title || 'Untitled'}</h1>
          <p>{lastTwoPathComponents(conversation.workingDir)}</p>
        </div>
        {props.isStreaming ? <button className="nav-button danger" type="button" onClick={props.onStop}>Stop</button> : null}
        <button className="nav-icon-button more" type="button" aria-label="More" onClick={props.onOpenActions}>
          <MoreIcon />
        </button>
      </header>
      {props.errorMessage ? <ErrorBanner message={props.errorMessage} /> : null}
      <MobilePinStrip messages={pinnedMessages} backends={props.backends} currentIndex={pinStripIndex} onSelect={jumpToPinnedMessage} />
      <div className="transcript" ref={transcriptRef}>
        {conversation.messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            conversation={conversation}
            client={props.client}
            backends={props.backends}
            focused={focusedPinID === message.id}
            messageRef={(node) => setMessageRef(message.id, node)}
            onTogglePin={(pinned) => props.onTogglePin(message.id, pinned)}
            onOpenFile={props.onOpenFile}
            onShareFile={props.onShareFile}
          />
        ))}
        {props.isStreaming && props.streamText ? (
          <div className="message assistant">
            <div className="message-heading">
              <AssistantIdentity backend={conversation.backend} backends={props.backends} />
            </div>
            <MarkdownContent content={props.streamText} />
            <span className="meta">Streaming...</span>
          </div>
        ) : null}
        {props.loading ? <div className="mini-spinner" /> : null}
      </div>
      {conversation.messageQueue?.length ? (
        <QueueStack
          queue={conversation.messageQueue}
          onRemove={props.onRemoveQueued}
          onEdit={props.onEditQueued}
          onMove={props.onMoveQueued}
          onClear={props.onClearQueue}
        />
      ) : null}
      <UsageBar usage={conversation.sessionUsage || conversation.usage} />
      {props.pendingInteraction ? (
        <InteractionCard
          interaction={props.pendingInteraction}
          answer={props.interactionAnswer}
          setAnswer={props.setInteractionAnswer}
          onSubmit={props.onSubmitInteraction}
        />
      ) : null}
      <AttachmentTray attachments={props.pendingAttachments} onRemove={props.onRemoveAttachment} onOcr={props.onOcrAttachment} />
      <footer className="composer">
        <GoalStrip
          goal={props.goal}
          goalUpdatedAtMs={props.goalUpdatedAtMs}
          isStreaming={props.isStreaming}
          onRefresh={props.onRefreshGoal}
          onPause={props.onPauseGoal}
          onResume={props.onResumeGoal}
          onClear={props.onClearGoal}
        />
        <div className="composer-meta-row">
          <button className="selection-bar composer-profile" type="button" onClick={props.onOpenSettings}>
            <b>{props.selectedProfile || props.selectedBackend || 'Profile'}</b>
            <span>/</span>
            <span>{props.selectedModel || 'Model'}</span>
            {props.selectedEffort ? <span>/ {props.selectedEffort}</span> : null}
            {props.selectedServiceTier === 'fast' ? <span>/ Fast</span> : null}
          </button>
          {props.goalCapable ? (
            <button
              className={`goal-toggle ${props.goalMode ? 'enabled' : ''}`}
              type="button"
              aria-pressed={props.goalMode}
              onClick={() => props.onGoalModeChange(!props.goalMode)}
            >
              Goal
            </button>
          ) : null}
        </div>
        <div className="composer-box">
          <button className="composer-icon" type="button" aria-label="Attach" onClick={props.onAttach}>
            <PaperclipIcon />
          </button>
          <textarea
            value={props.draft}
            onChange={(event) => props.setDraft(event.target.value)}
            placeholder={composerPlaceholder}
            rows={1}
          />
          <button className={`composer-icon send ${sendDisabled ? 'idle' : ''}`} type="button" aria-label={sendLabel} disabled={sendDisabled} onClick={props.onSend}>
            <SendIcon />
          </button>
        </div>
      </footer>
    </section>
  );
}

function GoalStrip(props: {
  goal: ThreadGoal | null;
  goalUpdatedAtMs: number | null;
  isStreaming: boolean;
  onRefresh: () => void;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
}) {
  const [nowMs, setNowMs] = useState(Date.now());
  const goalKey = `${props.goal?.threadId || 'none'}:${props.goal?.status || 'none'}:${props.goalUpdatedAtMs || ''}`;
  useEffect(() => {
    if (!props.goal) {
      return;
    }
    const interval = window.setInterval(() => setNowMs(Date.now()), isActiveGoal(props.goal) ? 1000 : 10_000);
    return () => window.clearInterval(interval);
  }, [goalKey]);
  useEffect(() => {
    if (!props.goal) {
      return;
    }
    const interval = window.setInterval(() => props.onRefresh(), 10_000);
    return () => window.clearInterval(interval);
  }, [goalKey]);
  if (!props.goal) {
    return null;
  }
  const elapsed = formatGoalElapsed(goalElapsedSeconds(props.goal, nowMs));
  const canPause = props.goal.status === 'active' && goalSupportsAction(props.goal, 'pause');
  const canResume = props.goal.status === 'paused' && !props.isStreaming && goalSupportsAction(props.goal, 'resume');
  const canClear = goalSupportsAction(props.goal, 'clear');
  const clearDisabled = props.goal.backend === 'claude-code' && props.isStreaming;
  return (
    <div className={`goal-strip ${props.goal.status}`} aria-live="polite">
      <div className="goal-strip-main">
        <span className="goal-dot" aria-hidden="true" />
        <strong>{goalStatusLabel(props.goal)}</strong>
        <span className="goal-elapsed">{elapsed}</span>
        <span className="goal-objective">{props.goal.objective || 'No objective'}</span>
      </div>
      <div className="goal-actions">
        {canPause ? <button type="button" onClick={props.onPause}>Pause</button> : null}
        {props.goal.status === 'paused' && goalSupportsAction(props.goal, 'resume') ? (
          <button type="button" disabled={!canResume} onClick={props.onResume}>Resume</button>
        ) : null}
        {canClear ? <button type="button" disabled={clearDisabled} onClick={props.onClear}>Clear</button> : null}
      </div>
    </div>
  );
}

function goalEventTitle(event: NonNullable<Message['goalEvent']>): string {
  switch (event.kind) {
    case 'set':
      return 'Goal set';
    case 'resumed':
      return 'Goal resumed';
    case 'paused':
      return 'Goal paused';
    case 'achieved':
      return 'Goal achieved';
    case 'budget_limited':
      return 'Goal budget limited';
    case 'cleared':
      return 'Goal cleared';
    default:
      return event.status ? goalStatusLabel({ status: event.status }) : 'Goal updated';
  }
}

function GoalEventView(props: { message: Message }) {
  const event = props.message.goalEvent;
  if (!event) return null;
  const objective = event.objective || event.goal?.objective || '';
  const reason = event.reason || event.goal?.lastReason || '';
  const backend = event.backend || props.message.backend || '';
  const kind = String(event.kind || event.status || 'updated').replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <div className={`goal-event-card kind-${kind}`}>
      <div className="goal-event-row">
        <strong>{goalEventTitle(event)}</strong>
        {backend ? <span>{backend}</span> : null}
      </div>
      {objective ? <p className="goal-event-objective">{objective}</p> : null}
      {reason ? <p className="goal-event-reason">{reason}</p> : null}
    </div>
  );
}

function MobilePinStrip(props: {
  messages: Message[];
  backends: BackendMetadata[];
  currentIndex: number;
  onSelect: (message: Message, index: number) => void;
}) {
  if (!props.messages.length) {
    return null;
  }
  const currentIndex = Math.min(Math.max(props.currentIndex, 0), props.messages.length - 1);
  const current = props.messages[currentIndex];
  const previousIndex = (currentIndex - 1 + props.messages.length) % props.messages.length;
  const nextIndex = (currentIndex + 1) % props.messages.length;
  const select = (index: number) => {
    const message = props.messages[index];
    if (message) props.onSelect(message, index);
  };
  return (
    <div className="pin-strip" aria-label="Pinned messages">
      <button className="pin-strip-label" onClick={() => select(currentIndex)}>
        <span className="pin-strip-arrow">↑</span>
        <span>PINNED</span>
        <span className="pin-strip-count">{props.messages.length}</span>
      </button>
      <button className="pin-strip-item" onClick={() => select(currentIndex)}>
        <span className="pin-strip-source">{current.role === 'user' ? 'You' : cliDisplayName(props.backends, current.backend)}</span>
        <span>{displayMessagePreview(current.content).replace(/\s+/g, ' ').trim() || 'Pinned message'}</span>
      </button>
      <div className="pin-strip-nav">
        <button onClick={() => select(previousIndex)} aria-label="Previous pinned message">⌃</button>
        <span className="pin-strip-dots" aria-hidden="true">
          {props.messages.map((message, index) => (
            <i key={message.id} className={index === currentIndex ? 'active' : ''} />
          ))}
        </span>
        <button onClick={() => select(nextIndex)} aria-label="Next pinned message">⌄</button>
      </div>
    </div>
  );
}

function cliDisplayName(backends: BackendMetadata[], backend?: string | null): string {
  if (!backend) {
    return 'Agent Cockpit';
  }
  return backends.find((item) => item.id === backend)?.label || backend;
}

function AssistantIdentity(props: { backend?: string | null; backends: BackendMetadata[] }) {
  const icon = props.backend ? props.backends.find((item) => item.id === props.backend)?.icon : null;
  const label = cliDisplayName(props.backends, props.backend);
  return (
    <>
      {icon ? (
        <span className="assistant-avatar backend-avatar" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} />
      ) : (
        <span className="assistant-avatar cockpit-avatar" aria-hidden="true">
          <img src="/logo-small.svg" alt="" />
        </span>
      )}
      <strong>{label}</strong>
    </>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function MarkdownIcon() {
  return (
    <svg className="md-glyph" width="18" height="12" viewBox="0 0 24 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1" y="1" width="22" height="12" rx="2" />
      <path d="M5 10V4l2.5 4L10 4v6" />
      <path d="M14 4v6M14 10l2.5-2.5M14 10l-2.5-2.5" strokeWidth="1.6" />
    </svg>
  );
}

function PinIcon(props: { filled?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill={props.filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={props.filled ? '1.4' : '1.8'} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17v5M9 11V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v6l3 4H6l3-4z" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path d="M16 6l-4-4-4 4" />
      <path d="M12 2v13" />
    </svg>
  );
}

function BackChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg className="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg className="workspace-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3h7v7" />
      <path d="M10 14L21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

function SessionsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M13 2v7h7" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 8v13H3V8" />
      <rect x="1" y="3" width="22" height="5" />
      <path d="M10 12h4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function ParentIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      <path d="M12 11v6M9 14h6" />
    </svg>
  );
}

function FilePlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M13 2v7h7" />
      <path d="M12 12v6M9 15h6" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.4 11.6 12 21a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7L9.6 17.8a2 2 0 1 1-2.8-2.8l8.8-8.8" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function MessageBubble(props: {
  message: Message;
  conversation: Conversation;
  client: AgentCockpitAPI;
  backends: BackendMetadata[];
  focused?: boolean;
  messageRef?: (node: HTMLDivElement | null) => void;
  onTogglePin?: (pinned: boolean) => void;
  showPinAction?: boolean;
  onOpenFile: (reference: FileReference) => void;
  onShareFile: (reference: FileReference) => void;
}) {
  const isUser = props.message.role === 'user';
  const isGoalEvent = !!props.message.goalEvent;
  const isPinned = !!props.message.pinned;
  const [copied, setCopied] = useState<'text' | 'md' | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  function copy(mode: 'text' | 'md') {
    const text = mode === 'md' ? props.message.content : (contentRef.current?.textContent || props.message.content);
    if (!text) return;
    const write = navigator.clipboard?.writeText(text);
    if (!write) return;
    void write.then(() => {
      setCopied(mode);
      window.setTimeout(() => setCopied(null), 1400);
    }).catch(() => undefined);
  }
  return (
    <div ref={props.messageRef} className={`message ${isUser ? 'user' : 'assistant'}${isGoalEvent ? ' goal-event' : ''}${isPinned ? ' pinned' : ''}${props.focused ? ' focused' : ''}`}>
      <div className="message-heading">
        <span className="message-author">
          {isUser ? <strong>You</strong> : isGoalEvent ? <strong>Goal</strong> : <AssistantIdentity backend={props.message.backend} backends={props.backends} />}
        </span>
        <div className="message-actions" role="group" aria-label="Message actions">
          <button title="Copy" aria-label={copied === 'text' ? 'Copied' : 'Copy'} className={copied === 'text' ? 'copied' : ''} onClick={() => copy('text')}>
            <CopyIcon />
          </button>
          <button title="Copy as Markdown" aria-label={copied === 'md' ? 'Copied Markdown' : 'Copy as Markdown'} className={copied === 'md' ? 'copied' : ''} onClick={() => copy('md')}>
            <MarkdownIcon />
          </button>
          {props.onTogglePin || props.showPinAction ? (
            <button title={isPinned ? 'Pinned' : 'Pin'} aria-label={isPinned ? 'Unpin' : 'Pin'} className={isPinned ? 'pinned' : ''} onClick={() => props.onTogglePin?.(!isPinned)}>
              <PinIcon filled={isPinned} />
            </button>
          ) : null}
        </div>
      </div>
      {isPinned ? (
        <div className="message-pin-strip">
          <PinIcon filled />
          pinned
        </div>
      ) : null}
      <div className="message-body" ref={contentRef}>
        {isGoalEvent ? (
          <GoalEventView message={props.message} />
        ) : props.message.contentBlocks?.length ? props.message.contentBlocks.map((block, index) => (
          <ContentBlockView
            key={`${props.message.id}-${index}`}
            block={block}
            message={props.message}
            conversation={props.conversation}
            client={props.client}
            onOpenFile={props.onOpenFile}
            onShareFile={props.onShareFile}
          />
        )) : (
          <MessageTextWithFiles {...props} content={props.message.content} />
        )}
        {props.message.streamError ? <p className="error-text">{props.message.streamError.message}</p> : null}
      </div>
    </div>
  );
}

function ContentBlockView(props: {
  block: ContentBlock;
  message: Message;
  conversation: Conversation;
  client: AgentCockpitAPI;
  onOpenFile: (reference: FileReference) => void;
  onShareFile: (reference: FileReference) => void;
}) {
  if (props.block.type === 'tool') {
    return (
      <div className="tool-block">
        <strong>{props.block.activity.tool}</strong>
        <span>{props.block.activity.description || props.block.activity.status || 'Tool activity'}</span>
      </div>
    );
  }
  if (props.block.type === 'artifact') {
    const reference = makeConversationArtifactReference(props.client, props.conversation, props.block.artifact);
    return (
      <div className="message-content">
        <FileCard reference={reference} onOpen={props.onOpenFile} onShare={props.onShareFile} />
      </div>
    );
  }
  return <MessageTextWithFiles {...props} content={props.block.content} thinking={props.block.type === 'thinking'} />;
}

function MessageTextWithFiles(props: {
  content: string;
  message: Message;
  conversation: Conversation;
  client: AgentCockpitAPI;
  onOpenFile: (reference: FileReference) => void;
  onShareFile: (reference: FileReference) => void;
  thinking?: boolean;
}) {
  const parsed = parseMessageFiles(props.content);
  const references = fileReferencesFromParsed(props.client, props.conversation, props.message.role, parsed);
  const renderAsMarkdown = props.message.role === 'assistant';
  return (
    <div className="message-content">
      {parsed.text ? (
        renderAsMarkdown || props.thinking
          ? <MarkdownContent content={parsed.text} className={props.thinking ? 'thinking' : undefined} />
          : <p className="plain-text">{parsed.text}</p>
      ) : null}
      {references.map((reference) => (
        <FileCard key={reference.id} reference={reference} onOpen={props.onOpenFile} onShare={props.onShareFile} />
      ))}
    </div>
  );
}

function MarkdownContent(props: { content: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(props.content), [props.content]);
  return (
    <div
      className={['markdown-body', props.className].filter(Boolean).join(' ')}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function renderMarkdown(content: string): string {
  const raw = marked.parse(content || '', { breaks: true, gfm: true, async: false }) as string;
  return DOMPurify.sanitize(raw);
}

function FileCard(props: { reference: FileReference; onOpen: (reference: FileReference) => void; onShare: (reference: FileReference) => void }) {
  return (
    <div className="file-card">
      <div>
        <strong>{props.reference.isImage ? '[image] ' : '[file] '}{props.reference.title}</strong>
        <span>{props.reference.path}</span>
      </div>
      <div className="button-row">
        <Button label="Preview" onClick={() => props.onOpen(props.reference)} />
        <Button label="Share" onClick={() => props.onShare(props.reference)} />
      </div>
    </div>
  );
}

function QueueStack(props: {
  queue: QueuedMessage[];
  onRemove: (index: number) => void;
  onEdit: (index: number) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onClear: () => void;
}) {
  return (
    <section className="queue-stack">
      <div className="row">
        <strong>Queued</strong>
        <Button label="Clear" onClick={props.onClear} />
      </div>
      {props.queue.map((item, index) => (
        <div key={`${index}-${item.content.slice(0, 16)}`} className="queue-item">
          <p>{item.content || '[Attachment]'}</p>
          {item.attachments?.length ? <span className="meta">{item.attachments.length} attachment(s)</span> : null}
          <div className="button-row">
            <Button label="Up" disabled={index === 0} onClick={() => props.onMove(index, -1)} />
            <Button label="Down" disabled={index === props.queue.length - 1} onClick={() => props.onMove(index, 1)} />
            <Button label="Edit" onClick={() => props.onEdit(index)} />
            <Button label="Remove" onClick={() => props.onRemove(index)} />
          </div>
        </div>
      ))}
    </section>
  );
}

function AttachmentTray(props: { attachments: PendingAttachment[]; onRemove: (id: string) => void; onOcr: (id: string) => void }) {
  if (!props.attachments.length) {
    return null;
  }
  return (
    <div className="attachment-tray">
      {props.attachments.map((attachment) => (
        <div key={attachment.id} className="attachment-chip">
          <strong>{attachment.fileName}</strong>
          <span className={attachment.status === 'error' ? 'error-text' : 'meta'}>
            {attachment.status === 'uploading'
              ? `Uploading ${attachment.progress ?? 0}%`
              : attachment.status === 'done'
                ? attachment.ocrStatus === 'running'
                  ? 'OCR running'
                  : attachment.ocrStatus === 'error'
                    ? attachment.ocrError || 'OCR failed'
                    : attachment.result?.meta || attachment.result?.kind || 'Ready'
                : attachment.error || 'Error'}
          </span>
          {attachment.status === 'uploading' ? <ProgressBar progress={attachment.progress || 0} /> : null}
          <div className="button-row">
            {attachment.status === 'done' && attachment.result?.kind === 'image' ? (
              <Button label={attachment.ocrMarkdown ? 'Insert OCR' : 'OCR'} disabled={attachment.ocrStatus === 'running'} onClick={() => props.onOcr(attachment.id)} />
            ) : null}
            <Button label={attachment.status === 'uploading' ? 'Cancel' : 'Remove'} onClick={() => props.onRemove(attachment.id)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function InteractionCard(props: {
  interaction: PendingInteraction;
  answer: string;
  setAnswer: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <section className="interaction-card">
      <strong>{props.interaction.kind === 'plan' ? 'Plan Approval' : 'Question'}</strong>
      <p>{props.interaction.prompt}</p>
      {props.interaction.kind === 'question' ? (
        <div className="button-row">
          {props.interaction.options.map((option) => <Button key={option.label} label={option.label} onClick={() => props.setAnswer(option.label)} />)}
        </div>
      ) : null}
      <textarea value={props.answer} onChange={(event) => props.setAnswer(event.target.value)} rows={3} />
      <Button label={props.interaction.kind === 'plan' ? 'Send Response' : 'Answer'} variant="primary" disabled={!props.answer.trim()} onClick={props.onSubmit} />
    </section>
  );
}

function UsageBar({ usage }: { usage?: Usage }) {
  if (!usage) {
    return null;
  }
  const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const context = usage.contextUsagePercentage ?? 0;
  return (
    <div className="usage-bar">
      <div>
        <span className="usage-label">Tokens</span>
        <span className="usage-value">{tokens.toLocaleString()}</span>
        <span className="usage-track"><i style={{ width: `${Math.min(100, Math.max(4, context))}%` }} /></span>
      </div>
      <div>
        <span className="usage-label">Cost</span>
        <span className="usage-value">${usage.costUsd.toFixed(4)}</span>
        <span className="usage-track"><i style={{ width: `${usage.costUsd > 0 ? 18 : 4}%` }} /></span>
      </div>
      <div>
        <span className="usage-label">Context</span>
        <span className="usage-value">{usage.contextUsagePercentage !== undefined ? formatPercent(usage.contextUsagePercentage) : 'n/a'}</span>
        <span className="usage-track"><i style={{ width: `${Math.min(100, Math.max(4, context))}%` }} /></span>
      </div>
    </div>
  );
}

function NewConversationModal(props: {
  client: AgentCockpitAPI;
  title: string;
  workingDir: string;
  loading: boolean;
  onTitleChange: (value: string) => void;
  onWorkingDirChange: (value: string) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  const [pickerVisible, setPickerVisible] = useState(false);
  return (
    <Modal title="New Conversation" onClose={props.onCancel}>
      <label>Title<input value={props.title} onChange={(event) => props.onTitleChange(event.target.value)} /></label>
      <label>
        Working directory
        <div className="directory-picker">
          <button
            className={`directory-display ${props.workingDir ? '' : 'empty'}`}
            type="button"
            disabled={props.loading}
            onClick={() => setPickerVisible(true)}
          >
            {props.workingDir || 'Use default workspace'}
          </button>
          <div className="directory-actions">
            <Button label="Browse" disabled={props.loading} onClick={() => setPickerVisible(true)} />
            {props.workingDir ? <Button label="Default" disabled={props.loading} onClick={() => props.onWorkingDirChange('')} /> : null}
          </div>
        </div>
      </label>
      <div className="modal-actions sheet-actions">
        <button className="sheet-action" type="button" onClick={props.onCancel}>
          <XIcon />
          Cancel
        </button>
        <button className="sheet-action primary" type="button" disabled={props.loading} onClick={props.onCreate}>
          <PlusIcon />
          Create
        </button>
      </div>
      {pickerVisible ? (
        <FolderPickerModal
          client={props.client}
          initialPath={props.workingDir}
          busy={props.loading}
          onClose={() => setPickerVisible(false)}
          onSelect={(path) => {
            props.onWorkingDirChange(path);
            setPickerVisible(false);
          }}
          onUseDefault={() => {
            props.onWorkingDirChange('');
            setPickerVisible(false);
          }}
        />
      ) : null}
    </Modal>
  );
}

function FolderPickerModal(props: {
  client: AgentCockpitAPI;
  initialPath: string;
  busy: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  onUseDefault: () => void;
}) {
  const [data, setData] = useState<DirectoryBrowseResponse | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);

  async function loadDirectory(path?: string | null, hidden = showHidden) {
    setLoading(true);
    setError(null);
    try {
      const next = await props.client.browseDirectory(path || undefined, hidden);
      setData(next);
      setConfirmDelete(false);
      setNewFolderName(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Folder could not be opened.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDirectory(props.initialPath || undefined);
  }, []);

  useEffect(() => {
    if (newFolderName !== null) {
      newFolderInputRef.current?.focus();
    }
  }, [newFolderName]);

  async function toggleHidden(checked: boolean) {
    setShowHidden(checked);
    await loadDirectory(data?.currentPath || props.initialPath || undefined, checked);
  }

  async function createFolder() {
    const name = (newFolderName || '').trim();
    if (!data || !name) {
      return;
    }
    try {
      const result = await props.client.createDirectory(data.currentPath, name);
      await loadDirectory(result.created || data.currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Folder could not be created.');
    }
  }

  async function deleteFolder() {
    if (!data?.parent) {
      return;
    }
    try {
      const result = await props.client.deleteDirectory(data.currentPath);
      await loadDirectory(result.parent || data.parent);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Folder could not be deleted.');
      setConfirmDelete(false);
    }
  }

  const currentName = data ? data.currentPath.split('/').filter(Boolean).pop() || data.currentPath : '';

  return (
    <div className="modal-backdrop folder-picker-backdrop" role="dialog" aria-modal="true">
      <section className="modal folder-picker-modal">
        <header className="modal-header">
          <div>
            <h2>Select Working Directory</h2>
            <p>{error || data?.currentPath || 'Loading...'}</p>
          </div>
          <Button label="Close" onClick={props.onClose} />
        </header>
        <div className="folder-picker-toolbar">
          <label className="folder-toggle">
            <input
              type="checkbox"
              checked={showHidden}
              disabled={loading || props.busy}
              onChange={(event) => void toggleHidden(event.currentTarget.checked)}
            />
            Show hidden
          </label>
          <button className="ftb" type="button" disabled={!data || loading || props.busy} onClick={() => setNewFolderName('')}>
            <FolderPlusIcon />
            New folder
          </button>
          {data?.parent ? (
            <button className="ftb danger" type="button" disabled={loading || props.busy} onClick={() => setConfirmDelete(true)}>
              <TrashIcon />
              Delete
            </button>
          ) : null}
        </div>
        {newFolderName !== null ? (
          <div className="folder-new-row">
            <input
              ref={newFolderInputRef}
              value={newFolderName}
              placeholder="Folder name"
              disabled={props.busy}
              onChange={(event) => setNewFolderName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void createFolder();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setNewFolderName(null);
                }
              }}
            />
            <button className="sheet-action primary" type="button" disabled={!newFolderName.trim() || props.busy} onClick={() => void createFolder()}>
              <PlusIcon />
              Create
            </button>
            <button className="sheet-action" type="button" disabled={props.busy} onClick={() => setNewFolderName(null)}>
              <XIcon />
              Cancel
            </button>
          </div>
        ) : null}
        <div className="modal-scroll folder-list">
          {confirmDelete && data ? (
            <section className="folder-confirm">
              <strong>Delete {currentName}?</strong>
              <div className="button-row">
                <button className="sheet-action danger" type="button" disabled={props.busy} onClick={() => void deleteFolder()}>
                  <TrashIcon />
                  Delete
                </button>
                <button className="sheet-action" type="button" disabled={props.busy} onClick={() => setConfirmDelete(false)}>
                  <XIcon />
                  Cancel
                </button>
              </div>
            </section>
          ) : loading ? (
            <p className="empty">Loading...</p>
          ) : data ? (
            <>
              {data.parent ? (
                <button className="folder-row parent-folder" type="button" onClick={() => void loadDirectory(data.parent)} disabled={props.busy}>
                  ↑ Parent directory
                </button>
              ) : null}
              {data.dirs.length ? data.dirs.map((name) => {
                const fullPath = `${data.currentPath}${data.currentPath.endsWith('/') ? '' : '/'}${name}`;
                return (
                  <button key={name} className="folder-row" type="button" onClick={() => void loadDirectory(fullPath)} disabled={props.busy} title={fullPath}>
                    <span className="folder-glyph" aria-hidden="true" />
                    <span>{name}</span>
                  </button>
                );
              }) : <p className="empty">No subdirectories</p>}
            </>
          ) : null}
        </div>
        <div className="modal-actions sheet-actions">
          <button className="sheet-action" type="button" disabled={props.busy || loading} onClick={props.onUseDefault}>
            <ResetIcon />
            Use Default
          </button>
          <button className="sheet-action" type="button" disabled={props.busy} onClick={props.onClose}>
            <XIcon />
            Cancel
          </button>
          <button className="sheet-action primary" type="button" disabled={!data || props.busy || loading} onClick={() => data && props.onSelect(data.currentPath)}>
            <CheckIcon />
            {props.busy ? 'Creating...' : 'Select'}
          </button>
        </div>
      </section>
    </div>
  );
}

function ActionsModal(props: {
  conversation: Conversation | null;
  renameTitle: string;
  setRenameTitle: (value: string) => void;
  isStreaming: boolean;
  onClose: () => void;
  onRename: () => void;
  onArchiveRestore: () => void;
  onDelete: () => void;
  onShare: () => void;
  onSessions: () => void;
  onFiles: () => void;
  onReset: () => void;
}) {
  return (
    <Modal title="Conversation" className="actions-modal" onClose={props.onClose}>
      <label>Title<input value={props.renameTitle} onChange={(event) => props.setRenameTitle(event.target.value)} /></label>
      <button className="action primary" type="button" disabled={!props.renameTitle.trim()} onClick={props.onRename}>
        <span className="ic"><EditIcon /></span>
        <span>Rename</span>
        <ChevronRightIcon />
      </button>
      <div className="actions">
        <button className="action" type="button" onClick={props.onShare}>
          <span className="ic"><ExternalIcon /></span>
          <span>Share Markdown</span>
          <ChevronRightIcon />
        </button>
        <button className="action" type="button" onClick={props.onSessions}>
          <span className="ic"><SessionsIcon /></span>
          <span>Sessions</span>
          <ChevronRightIcon />
        </button>
        <button className="action" type="button" onClick={props.onFiles}>
          <span className="ic"><FileIcon /></span>
          <span>Files</span>
          <ChevronRightIcon />
        </button>
        <button className="action" type="button" disabled={props.isStreaming} onClick={props.onReset}>
          <span className="ic"><ResetIcon /></span>
          <span>Reset Session</span>
          <ChevronRightIcon />
        </button>
        <button className="action" type="button" disabled={props.isStreaming} onClick={props.onArchiveRestore}>
          <span className="ic"><ArchiveIcon /></span>
          <span>{props.conversation?.archived ? 'Restore' : 'Archive'}</span>
          <ChevronRightIcon />
        </button>
        <button className="action danger" type="button" disabled={props.isStreaming} onClick={props.onDelete}>
          <span className="ic"><TrashIcon /></span>
          <span>Delete</span>
          <ChevronRightIcon />
        </button>
      </div>
    </Modal>
  );
}

function RunSettingsModal(props: {
  profiles: Array<{ id: string; name: string }>;
  selectedCliProfileId?: string;
  selectedBackendMetadata?: BackendMetadata;
  selectedModel?: string;
  selectedEffort?: EffortLevel;
  selectedServiceTier?: ServiceTier | 'default';
  serviceTierEnabled: boolean;
  supportedEfforts: EffortLevel[];
  locked: boolean;
  onClose: () => void;
  onProfile: (id: string) => void;
  onModel: (id: string | undefined) => void;
  onEffort: (effort: EffortLevel | undefined) => void;
  onServiceTier: (serviceTier: ServiceTier | 'default' | undefined) => void;
}) {
  return (
    <Modal title="Run Settings" className="settings-modal" onClose={props.onClose}>
      <div className="modal-scroll run-settings-scroll">
        {props.locked ? <p className="meta">Profile is locked after a session has messages.</p> : null}
        <strong>Profile</strong>
        <div className="choice-grid">
          {props.profiles.map((profile) => <Choice key={profile.id} label={profile.name} selected={props.selectedCliProfileId === profile.id} disabled={props.locked} onClick={() => props.onProfile(profile.id)} />)}
        </div>
        <strong>Model</strong>
        <div className="choice-grid">
          {(props.selectedBackendMetadata?.models || []).map((model) => <Choice key={model.id} label={model.label || model.id} selected={props.selectedModel === model.id} onClick={() => props.onModel(model.id)} />)}
        </div>
        {props.supportedEfforts.length ? (
          <>
            <strong>Effort</strong>
            <div className="choice-grid">
              {props.supportedEfforts.map((effort) => <Choice key={effort} label={effort} selected={props.selectedEffort === effort} onClick={() => props.onEffort(effort)} />)}
            </div>
          </>
        ) : null}
        {props.serviceTierEnabled ? (
          <>
            <strong>Speed</strong>
            <div className="choice-grid">
              <Choice label="Default" selected={!props.selectedServiceTier || props.selectedServiceTier === 'default'} onClick={() => props.onServiceTier('default')} />
              <Choice label="Fast" selected={props.selectedServiceTier === 'fast'} onClick={() => props.onServiceTier('fast')} />
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function SessionsModal(props: {
  conversation: Conversation | null;
  sessions: SessionHistoryItem[];
  onClose: () => void;
  onView: (session: SessionHistoryItem) => void;
  onShare: (session: SessionHistoryItem) => void;
}) {
  const totalMessages = props.sessions.reduce((total, session) => total + session.messageCount, 0);
  return (
    <Modal
      title="Sessions"
      subtitle={`${props.sessions.length} session${props.sessions.length === 1 ? '' : 's'} · ${totalMessages} messages`}
      className="sessions-modal"
      onClose={props.onClose}
      full
    >
      <div className="modal-scroll sessions-list">
        {props.sessions.map((session) => (
          <article key={session.number} className={`session-card ${session.isCurrent ? 'active' : ''}`}>
            <div className="session-card-top">
              <span className="session-index">Session {session.number.toString().padStart(2, '0')}{session.isCurrent ? ' · current' : ''}</span>
              <span className="session-when">{formatSessionDateTime(session.startedAt)}</span>
            </div>
            <h3>{sessionTitle(session)}</h3>
            <p>{sessionSummary(session)}</p>
            <div className="session-card-foot">
              <span className={`session-stat ${session.isCurrent ? 'live' : ''}`}>● {session.isCurrent ? 'live' : 'finalized'}</span>
              <span className="session-stat">{session.messageCount} msg{session.messageCount === 1 ? '' : 's'}</span>
            </div>
            <div className="session-card-actions">
              <button className="session-action view" type="button" onClick={() => props.onView(session)}>
                <EyeIcon />
                View
              </button>
              <button className="session-action share" type="button" onClick={() => props.onShare(session)}>
                <ShareIcon />
                Share
              </button>
            </div>
          </article>
        ))}
        {!props.sessions.length ? <p className="empty">No sessions.</p> : null}
      </div>
    </Modal>
  );
}

function ReadOnlySessionScreen(props: {
  client: AgentCockpitAPI;
  backends: BackendMetadata[];
  conversation: Conversation;
  session: SessionHistoryItem;
  messages: Message[];
  onBack: () => void;
  onShare: () => void;
  onOpenFile: (reference: FileReference) => void;
  onShareFile: (reference: FileReference) => void;
}) {
  return (
    <section className="screen session-viewer-screen">
      <header className="session-viewer-nav">
        <button className="session-back" type="button" onClick={props.onBack}>
          <BackChevronIcon />
          Sessions
        </button>
        <div className="session-viewer-title">
          <h1>{sessionTitle(props.session)}</h1>
          <p>{lastTwoPathComponents(props.conversation.workingDir)} · {formatDate(props.session.startedAt)}</p>
        </div>
        <button className="session-share-icon" type="button" aria-label="Share session" onClick={props.onShare}>
          <ShareIcon />
        </button>
      </header>
      <div className="session-viewer-scroll">
        <div className="session-feed">
          <div className="session-turn-marker">
            <span>Read-only · {props.messages.length || props.session.messageCount} msgs</span>
            <span className="line" />
            <span>{props.session.isCurrent ? 'current' : 'finalized'}</span>
          </div>
          {props.messages.map((message) => (
            <ReadOnlySessionMessage
              key={message.id}
              message={message}
              conversation={props.conversation}
              client={props.client}
              backends={props.backends}
              onOpenFile={props.onOpenFile}
              onShareFile={props.onShareFile}
            />
          ))}
          {!props.messages.length ? <p className="empty">No messages in this session.</p> : null}
        </div>
      </div>
      <SessionViewerMeter session={props.session} messageCount={props.messages.length || props.session.messageCount} />
      <footer className="session-readonly-bar">
        <div>
          <LockIcon />
          read-only · viewing {props.session.isCurrent ? 'current' : 'past'} session
        </div>
      </footer>
    </section>
  );
}

function ReadOnlySessionMessage(props: {
  message: Message;
  conversation: Conversation;
  client: AgentCockpitAPI;
  backends: BackendMetadata[];
  onOpenFile: (reference: FileReference) => void;
  onShareFile: (reference: FileReference) => void;
}) {
  const isUser = props.message.role === 'user';
  const isGoalEvent = !!props.message.goalEvent;
  const isPinned = !!props.message.pinned;
  const [copied, setCopied] = useState<'text' | 'md' | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  function copy(mode: 'text' | 'md') {
    const text = mode === 'md' ? props.message.content : (contentRef.current?.textContent || props.message.content);
    if (!text) return;
    const write = navigator.clipboard?.writeText(text);
    if (!write) return;
    void write.then(() => {
      setCopied(mode);
      window.setTimeout(() => setCopied(null), 1400);
    }).catch(() => undefined);
  }
  return (
    <div className={`session-message ${isUser ? 'user' : 'assistant'}${isGoalEvent ? ' goal-event' : ''}${isPinned ? ' pinned' : ''}`}>
      <div className="session-message-heading">
        <span className="session-message-author">
          {isUser ? (
            <>
              <span className="session-avatar user" aria-hidden="true">Y</span>
              <strong>You</strong>
            </>
          ) : isGoalEvent ? (
            <>
              <span className="session-avatar goal" aria-hidden="true">G</span>
              <strong>Goal</strong>
            </>
          ) : props.message.role === 'system' ? (
            <>
              <span className="session-avatar" aria-hidden="true">S</span>
              <strong>System</strong>
            </>
          ) : (
            <AssistantIdentity backend={props.message.backend} backends={props.backends} />
          )}
          <span>· {formatTime(props.message.timestamp)}</span>
        </span>
        <div className="message-actions" role="group" aria-label="Message actions">
          <button type="button" title="Copy" aria-label={copied === 'text' ? 'Copied' : 'Copy'} className={copied === 'text' ? 'copied' : ''} onClick={() => copy('text')}>
            <CopyIcon />
          </button>
          <button type="button" title="Copy as Markdown" aria-label={copied === 'md' ? 'Copied Markdown' : 'Copy as Markdown'} className={copied === 'md' ? 'copied' : ''} onClick={() => copy('md')}>
            <MarkdownIcon />
          </button>
          <button type="button" title={isPinned ? 'Pinned' : 'Pin'} aria-label={isPinned ? 'Pinned' : 'Pin'} className={isPinned ? 'pinned' : ''}>
            <PinIcon filled={isPinned} />
          </button>
        </div>
      </div>
      {isPinned ? (
        <div className="message-pin-strip">
          <PinIcon filled />
          pinned
        </div>
      ) : null}
      <div className={isUser ? 'session-user-message' : 'session-message-body'} ref={contentRef}>
        {isGoalEvent ? (
          <GoalEventView message={props.message} />
        ) : props.message.contentBlocks?.length ? props.message.contentBlocks.map((block, index) => (
          <ContentBlockView
            key={`${props.message.id}-${index}`}
            block={block}
            message={props.message}
            conversation={props.conversation}
            client={props.client}
            onOpenFile={props.onOpenFile}
            onShareFile={props.onShareFile}
          />
        )) : (
          <MessageTextWithFiles {...props} content={props.message.content} />
        )}
        {props.message.streamError ? <p className="error-text">{props.message.streamError.message}</p> : null}
      </div>
    </div>
  );
}

function SessionViewerMeter(props: { session: SessionHistoryItem; messageCount: number }) {
  return (
    <div className="usage-bar session-viewer-meter">
      <div>
        <span className="usage-label">Messages</span>
        <span className="usage-value">{props.messageCount}</span>
        <span className="usage-track"><i style={{ width: `${Math.min(100, Math.max(8, props.messageCount * 4))}%` }} /></span>
      </div>
      <div>
        <span className="usage-label">Started</span>
        <span className="usage-value">{formatDate(props.session.startedAt)}</span>
        <span className="usage-track"><i style={{ width: '38%' }} /></span>
      </div>
      <div>
        <span className="usage-label">Session</span>
        <span className="usage-value">{props.session.isCurrent ? 'current' : 'closed'}</span>
        <span className="usage-track"><i style={{ width: '100%', background: props.session.isCurrent ? 'var(--status-running)' : 'var(--status-done)' }} /></span>
      </div>
    </div>
  );
}

function sessionTitle(session: SessionHistoryItem): string {
  if (!session.summary) {
    return session.isCurrent ? `Session ${session.number} · Current` : `Session ${session.number}`;
  }
  const normalized = session.summary.replace(/\s+/g, ' ').trim();
  const firstSentence = normalized.match(/^(.+?[.!?])\s/)?.[1] || normalized;
  return firstSentence.length > 72 ? `${firstSentence.slice(0, 69).trim()}...` : firstSentence;
}

function sessionSummary(session: SessionHistoryItem): string {
  if (session.summary) {
    return session.summary;
  }
  return session.isCurrent
    ? 'This is the active CLI session for the conversation.'
    : 'This finalized session is available as a read-only transcript.';
}

function formatSessionDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function FilesModal(props: {
  path: string;
  parent: string | null;
  entries: ExplorerEntry[];
  preview: ExplorerPreviewResponse | null;
  editContent: string;
  uploads: ExplorerUpload[];
  uploadInputRef: React.RefObject<HTMLInputElement | null>;
  onEditContent: (value: string) => void;
  onClose: () => void;
  onParent: () => void;
  onRefresh: () => void;
  onEntry: (entry: ExplorerEntry) => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onUploadFiles: (files: FileList | null) => void;
  onRenameEntry: (entry: ExplorerEntry) => void;
  onDeleteEntry: (entry: ExplorerEntry) => void;
  onSavePreview: () => void;
  onRenamePreview: () => void;
  onDeletePreview: () => void;
  onOpenPreviewFile: () => void;
  onSharePreviewFile: () => void;
  onCancelUpload: (upload: ExplorerUpload) => void;
}) {
  return (
    <Modal title="Files" subtitle={props.path || '/'} className="files-modal" onClose={props.onClose} full>
      <div className="files-toolbar">
        <button className={`ftb ${props.path ? '' : 'muted'}`} type="button" disabled={!props.path} onClick={props.onParent}>
          <ParentIcon />
          Parent
        </button>
        <button className="ftb" type="button" onClick={props.onRefresh}>
          <ResetIcon />
          Refresh
        </button>
        <button className="ftb" type="button" onClick={props.onNewFolder}>
          <FolderPlusIcon />
          New folder
        </button>
        <button className="ftb" type="button" onClick={props.onNewFile}>
          <FilePlusIcon />
          New file
        </button>
        <button className="ftb primary" type="button" onClick={() => props.uploadInputRef.current?.click()}>
          <UploadIcon />
          Upload
        </button>
      </div>
      <input ref={props.uploadInputRef} className="hidden-input" type="file" multiple onChange={(event) => props.onUploadFiles(event.currentTarget.files)} />
      <div className="modal-scroll">
        {props.uploads.length ? (
          <section className="upload-panel">
            <strong>Uploads</strong>
            {props.uploads.map((upload) => (
              <div key={upload.id} className="upload-row">
                <div>
                  <strong>{upload.fileName}</strong>
                  <span className={upload.status === 'error' ? 'error-text' : 'meta'}>
                    {upload.status === 'uploading' ? `Uploading ${upload.progress ?? 0}%` : upload.status === 'done' ? 'Uploaded' : upload.error || 'Upload failed'}
                  </span>
                  {upload.status === 'uploading' ? <ProgressBar progress={upload.progress || 0} /> : null}
                </div>
                <Button label={upload.status === 'uploading' ? 'Cancel' : 'Clear'} onClick={() => props.onCancelUpload(upload)} />
              </div>
            ))}
          </section>
        ) : null}
        {props.entries.map((entry) => (
          <article key={`${entry.type}-${entry.name}`} className={`list-row file-entry ${entry.type}`}>
            <button className="file-entry-main" type="button" onClick={() => props.onEntry(entry)}>
              <span className="file-icon" aria-hidden="true" />
              <span className="file-info">
                <strong>{entry.name}</strong>
                {entry.size !== undefined ? <span>{formatBytes(entry.size)}</span> : null}
              </span>
            </button>
            <div className="file-entry-actions">
              <button className="file-entry-action" type="button" aria-label={`Rename ${entry.name}`} onClick={() => props.onRenameEntry(entry)}>
                <EditIcon />
              </button>
              <button className="file-entry-action danger" type="button" aria-label={`Delete ${entry.name}`} onClick={() => props.onDeleteEntry(entry)}>
                <TrashIcon />
              </button>
            </div>
          </article>
        ))}
        {props.preview ? (
          <section className="preview-panel">
            <div className="row">
              <strong>{props.preview.path}</strong>
              <div className="button-row">
                <Button label="Save" variant="primary" onClick={props.onSavePreview} />
                <Button label="Open" onClick={props.onOpenPreviewFile} />
                <Button label="Copy" onClick={() => void navigator.clipboard.writeText(props.editContent || props.preview?.content || '')} />
                <Button label="Share File" onClick={props.onSharePreviewFile} />
                <Button label="Rename" onClick={props.onRenamePreview} />
                <Button label="Delete" variant="danger" onClick={props.onDeletePreview} />
              </div>
            </div>
            <textarea className="editor" value={props.editContent} onChange={(event) => props.onEditContent(event.target.value)} />
          </section>
        ) : null}
      </div>
    </Modal>
  );
}

function FilePreviewModal(props: {
  preview: FilePreviewState;
  loading: boolean;
  onClose: () => void;
  onCopy: () => void;
  onShare: () => void;
}) {
  return (
    <Modal title={props.preview.title || 'File'} subtitle={props.preview.path} onClose={props.onClose} full>
      <div className="button-row">
        {props.preview.content ? <Button label="Copy" onClick={props.onCopy} /> : null}
        <Button label="Share File" variant="primary" onClick={props.onShare} />
      </div>
      {props.loading ? <div className="mini-spinner" /> : null}
      {props.preview.error ? <ErrorBanner message={props.preview.error} /> : null}
      {props.preview.imageURL ? <img className="preview-image" src={props.preview.imageURL} alt={props.preview.title} /> : null}
      {props.preview.content ? (
        <pre className="code-preview">{props.preview.truncated ? 'Preview truncated.\n\n' : ''}{props.preview.content}</pre>
      ) : null}
    </Modal>
  );
}

function QueueEditorModal(props: {
  content: string;
  attachments: AttachmentMeta[];
  onContentChange: (value: string) => void;
  onRemoveAttachment: (path: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <Modal title="Edit Queue Item" onClose={props.onCancel}>
      <label>Message<textarea value={props.content} onChange={(event) => props.onContentChange(event.target.value)} rows={6} /></label>
      {props.attachments.length ? (
        <section className="preview-panel">
          <strong>Attachments</strong>
          {props.attachments.map((attachment) => (
            <div key={attachment.path} className="upload-row">
              <div>
                <strong>{attachment.name}</strong>
                <span>{attachment.path}</span>
              </div>
              <Button label="Remove" onClick={() => props.onRemoveAttachment(attachment.path)} />
            </div>
          ))}
        </section>
      ) : null}
      <div className="modal-actions">
        <Button label="Save" variant="primary" disabled={!props.content.trim() && !props.attachments.length} onClick={props.onSave} />
      </div>
    </Modal>
  );
}

function Modal(props: { title: string; subtitle?: string; full?: boolean; className?: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className={['modal', props.full ? 'modal-full' : '', props.className].filter(Boolean).join(' ')}>
        <header className="modal-header">
          <div>
            <h2>{props.title}</h2>
            {props.subtitle ? <p>{props.subtitle}</p> : null}
          </div>
          <button className="sheet-close" type="button" onClick={props.onClose}>Close</button>
        </header>
        {props.children}
      </section>
    </div>
  );
}

function Button(props: { label: string; variant?: 'primary' | 'danger'; disabled?: boolean; onClick: () => void }) {
  return (
    <button className={`btn ${props.variant || ''}`} disabled={props.disabled} onClick={props.onClick}>
      {props.label}
    </button>
  );
}

function Choice(props: { label: string; selected?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button className={`choice ${props.selected ? 'selected' : ''}`} disabled={props.disabled} onClick={props.onClick}>
      {props.label}
    </button>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return <div className="error-banner">{message}</div>;
}

function ProgressBar({ progress }: { progress: number }) {
  return <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} /></div>;
}
