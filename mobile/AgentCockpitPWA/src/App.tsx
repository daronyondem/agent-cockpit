import { useEffect, useRef, useState } from 'react';
import { AgentAPIError, AgentCockpitAPI } from './api';
import {
  ALL_WORKSPACES,
  backendIdForProfile,
  chooseResetProfileRepair,
  conversationListItemFromConversation,
  modelDisplayLabel,
  patchConversationMessage,
  upsertMessage,
  userLabel,
  workspaceRef,
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
import { useFilePreview } from './useFilePreview';
import { useSessionHistory } from './useSessionHistory';
import { useQueueEditor } from './useQueueEditor';
import { usePendingAttachments } from './usePendingAttachments';
import { useGoalState } from './useGoalState';
import { useChatStreamConnection } from './useChatStreamConnection';
import { useListStreamMonitor } from './useListStreamMonitor';
import { useSendPipeline } from './useSendPipeline';
import { useRunSelection } from './useRunSelection';
import { useWorkspaceExplorer } from './useWorkspaceExplorer';
import { useVisibleIntervalRefresh } from './useMobileLifecycle';
import { useViewportHeightVar } from './useViewportHeightVar';
import type {
  BackendMetadata,
  Conversation,
  ConversationListItem,
  CurrentUser,
  Message,
  PendingInteraction,
  Settings,
  ThreadGoal,
} from './types';

const LIST_AUTO_REFRESH_MS = 15_000;

type Screen = 'list' | 'chat';

export default function App() {
  useViewportHeightVar();

  const clientRef = useRef(new AgentCockpitAPI());
  const activeConversationRef = useRef<Conversation | null>(null);
  const applyGoalSnapshotRef = useRef<(conversationID: string, nextGoal: ThreadGoal | null) => boolean>(() => false);

  const [screen, setScreen] = useState<Screen>('list');
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [backends, setBackends] = useState<BackendMetadata[]>([]);
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [activeStreamIDs, setActiveStreamIDs] = useState<Set<string>>(new Set());
  const [listArchived, setListArchived] = useState(false);
  const [workspaceFilter, setWorkspaceFilter] = useState(ALL_WORKSPACES);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingInteraction, setPendingInteraction] = useState<PendingInteraction | null>(null);
  const [interactionAnswer, setInteractionAnswer] = useState('');
  const {
    availableProfiles,
    selectedProfile,
    profileSelectionLocked,
    profileMetadata,
    selectedCliProfileId,
    selectedBackend,
    selectedModel,
    selectedEffort,
    selectedClaudeCodeMode,
    selectedServiceTier,
    selectedBackendMetadata,
    selectedModelMetadata,
    supportedEfforts,
    selectedBackendID,
    selectedGoalCapability,
    goalCapable,
    serviceTierEnabled,
    claudeCodeModeEnabled,
    claudeCodeModeForRequest,
    claudeCodeModeForSelection,
    setSelectedModel,
    setSelectedEffort,
    setSelectedClaudeCodeMode,
    setSelectedServiceTier,
    hydrateSelectionDefaults,
    hydrateSelectionFromConversation,
    chooseProfile,
  } = useRunSelection({
    activeConversation,
    backends,
    clientRef,
    settings,
    onError: handleError,
  });
  const {
    attachInputRef,
    pendingAttachments,
    setPendingAttachments,
    hasUploadingAttachments,
    handleAttachmentFiles,
    removePendingAttachment,
    ocrPendingAttachment,
  } = usePendingAttachments({
    activeConversation,
    activeConversationRef,
    clientRef,
    selectedBackend,
    selectedCliProfileId,
    setActiveConversation,
    applyServerMessage,
    appendToDraft,
  });
  const {
    streamText,
    setStreamText,
    showStreamPlaceholder,
    setShowStreamPlaceholder,
    isStreaming,
    setIsStreaming,
    closeStreamSocket,
    startStream,
    clearStreamReconnectTimer,
    recoverActiveStream,
    markStreamFinished,
  } = useChatStreamConnection({
    activeConversationRef,
    clientRef,
    setActiveConversation,
    setActiveStreamIDs,
    setConversations,
    setErrorMessage,
    setPendingInteraction,
    applyGoalSnapshot: (conversationID, nextGoal) => applyGoalSnapshotRef.current(conversationID, nextGoal),
    refreshAfterStream,
    notify,
  });
  const {
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
  } = useGoalState({
    activeConversation,
    activeConversationRef,
    backends,
    clientRef,
    profileMetadata,
    selectedBackend,
    selectedBackendID,
    selectedCliProfileId,
    selectedModel,
    selectedEffort,
    claudeCodeModeForRequest,
    claudeCodeModeForSelection,
    selectedServiceTier,
    selectedGoalCapability,
    goalCapable,
    serviceTierEnabled,
    isStreaming,
    startStream,
    setDraft,
    setPendingAttachments,
    setPendingInteraction,
    setActiveConversation,
    setErrorMessage,
    applyServerMessage,
    onError: handleError,
  });
  applyGoalSnapshotRef.current = applyGoalSnapshot;
  const { closeListStreamSockets } = useListStreamMonitor({
    activeStreamIDs,
    clientRef,
    enabled: screen === 'list',
    setActiveStreamIDs,
    setConversations,
    applyGoalSnapshot,
    refreshConversationList,
    notify,
  });
  const {
    isSending,
    sendDraft,
    drainNextQueuedMessage,
    submitInteraction,
  } = useSendPipeline({
    activeConversation,
    activeConversationRef,
    clientRef,
    draft,
    setDraft,
    pendingAttachments,
    setPendingAttachments,
    hasUploadingAttachments,
    pendingInteraction,
    setPendingInteraction,
    interactionAnswer,
    setInteractionAnswer,
    loading,
    goalMode,
    setGoalMode,
    goalCapable,
    selectedGoalCapability,
    selectedBackendID,
    selectedBackend,
    selectedCliProfileId,
    selectedModel,
    selectedEffort,
    claudeCodeModeForRequest,
    claudeCodeModeForSelection,
    selectedServiceTier,
    serviceTierEnabled,
    isStreaming,
    startStream,
    markStreamFinished,
    recoverActiveStream,
    setStreamText,
    setShowStreamPlaceholder,
    setIsStreaming,
    setActiveStreamIDs,
    setActiveConversation,
    setErrorMessage,
    setGoalNow,
    pauseGoalNow,
    resumeGoalNow,
    clearGoalNow,
    onError: handleError,
  });

  const [newConversationVisible, setNewConversationVisible] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newWorkingDir, setNewWorkingDir] = useState('');
  const [actionsVisible, setActionsVisible] = useState(false);
  const [markdownShareVisible, setMarkdownShareVisible] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [settingsVisible, setSettingsVisible] = useState(false);

  const {
    filePreview,
    filePreviewLoading,
    openFileReference,
    shareFileReference,
    copyFilePreview,
    closeFilePreview,
  } = useFilePreview({ onError: handleError });
  const {
    sessionsVisible,
    sessions,
    sessionViewer,
    openSessions,
    viewSession,
    applySessionReset,
    closeSessions,
    closeSessionSurfaces,
    backToSessions,
  } = useSessionHistory({
    clientRef,
    getActiveConversation: () => activeConversation,
    onError: handleError,
  });
  const {
    queueEditorIndex,
    queueEditorContent,
    queueEditorAttachments,
    setQueueEditorContent,
    removeQueueEditorAttachment,
    removeQueuedMessage,
    moveQueuedMessage,
    openQueueEditor,
    saveQueueEditor,
    closeQueueEditor,
    clearQueue,
  } = useQueueEditor({
    activeConversation,
    clientRef,
    setActiveConversation,
    onError: handleError,
  });
  const {
    filesVisible,
    explorerPath,
    explorerParent,
    explorerEntries,
    explorerPreview,
    explorerEditContent,
    explorerUploads,
    explorerUploadInputRef,
    setExplorerEditContent,
    openFiles,
    closeFiles,
    loadParent,
    refreshExplorer,
    openExplorerEntry,
    createExplorerFolder,
    createExplorerFile,
    uploadExplorerFiles,
    renameExplorerEntry,
    deleteExplorerEntry,
    saveExplorerPreview,
    renameExplorerPreview,
    deleteExplorerPreview,
    openExplorerPreviewFile,
    shareExplorerPreviewFile,
    clearOrCancelExplorerUpload,
  } = useWorkspaceExplorer({
    activeConversation,
    clientRef,
    onError: handleError,
    openFileReference,
    shareFileReference,
  });

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
    if (workspaceFilter !== ALL_WORKSPACES && conversations.every((conversation) => workspaceRef(conversation) !== workspaceFilter)) {
      setWorkspaceFilter(ALL_WORKSPACES);
    }
  }, [conversations, workspaceFilter]);

  useVisibleIntervalRefresh(screen === 'list', () => void refreshConversationList(), LIST_AUTO_REFRESH_MS);

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

  async function createConversation() {
    try {
      const conversation = await clientRef.current.createConversation({
        title: newTitle.trim() || undefined,
        workingDir: newWorkingDir.trim() || undefined,
        backend: selectedBackend,
        cliProfileId: selectedCliProfileId,
        model: selectedModel,
        effort: selectedEffort,
        claudeCodeMode: claudeCodeModeForRequest,
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

  async function stopStream() {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    try {
      clearStreamReconnectTimer();
      closeStreamSocket();
      setIsStreaming(false);
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

  function appendToDraft(text: string) {
    const trimmed = text.trim();
    if (trimmed) {
      setDraft((current) => (current.trim() ? `${current.trimEnd()}\n\n${trimmed}` : trimmed));
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
    const storedProfileMissing = !!conversation.cliProfileId
      && !availableProfiles.some((profile) => profile.id === conversation.cliProfileId);
    const resetProfile = chooseResetProfileRepair(availableProfiles, conversation, selectedCliProfileId);
    if (storedProfileMissing) {
      if (!resetProfile) {
        setErrorMessage('Choose a replacement CLI profile before resetting this conversation.');
        return;
      }
    }
    try {
      setLoading(true);
      setErrorMessage(null);
      setActionsVisible(false);
      const response = await clientRef.current.resetConversation(conversation.id, resetProfile ? {
        cliProfileId: resetProfile.id,
        backend: backendIdForProfile(resetProfile),
      } : undefined);
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
      applySessionReset(response);
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
          isSending={isSending}
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
          selectedModel={selectedModelMetadata ? modelDisplayLabel(selectedModelMetadata) : (selectedModel ? modelDisplayLabel(selectedModel) : undefined)}
          selectedEffort={selectedEffort}
          selectedServiceTier={serviceTierEnabled ? selectedServiceTier : undefined}
          client={clientRef.current}
          onBack={() => {
            clearStreamReconnectTimer();
            closeStreamSocket();
            closeSessionSurfaces();
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
          selectedClaudeCodeMode={selectedClaudeCodeMode}
          selectedServiceTier={selectedServiceTier}
          claudeCodeModeEnabled={claudeCodeModeEnabled}
          serviceTierEnabled={serviceTierEnabled}
          supportedEfforts={supportedEfforts}
          locked={profileSelectionLocked}
          onClose={() => setSettingsVisible(false)}
          onProfile={chooseProfile}
          onModel={setSelectedModel}
          onEffort={setSelectedEffort}
          onClaudeCodeMode={setSelectedClaudeCodeMode}
          onServiceTier={setSelectedServiceTier}
        />
      ) : null}

      {sessionsVisible ? (
        <SessionsModal
          conversation={activeConversation}
          sessions={sessions}
          onClose={closeSessions}
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
          onBack={backToSessions}
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
          onClose={closeFiles}
          onParent={loadParent}
          onRefresh={refreshExplorer}
          onEntry={(entry) => void openExplorerEntry(entry)}
          onNewFolder={() => void createExplorerFolder()}
          onNewFile={() => void createExplorerFile()}
          onUploadFiles={(files) => void uploadExplorerFiles(files)}
          onRenameEntry={renameExplorerEntry}
          onDeleteEntry={deleteExplorerEntry}
          onSavePreview={() => void saveExplorerPreview()}
          onRenamePreview={renameExplorerPreview}
          onDeletePreview={deleteExplorerPreview}
          onOpenPreviewFile={openExplorerPreviewFile}
          onSharePreviewFile={shareExplorerPreviewFile}
          onCancelUpload={clearOrCancelExplorerUpload}
        />
      ) : null}

      {filePreview ? (
        <FilePreviewModal
          preview={filePreview}
          loading={filePreviewLoading}
          onClose={closeFilePreview}
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
          onRemoveAttachment={removeQueueEditorAttachment}
          onCancel={closeQueueEditor}
          onSave={() => void saveQueueEditor()}
        />
      ) : null}
    </main>
  );
}
