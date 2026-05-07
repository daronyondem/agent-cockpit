import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { AgentAPIError, AgentCockpitAPI } from './api';
import type {
  AttachmentMeta,
  BackendMetadata,
  ContentBlock,
  Conversation,
  ConversationArtifact,
  ConversationListItem,
  CurrentUser,
  EffortLevel,
  ExplorerEntry,
  ExplorerPreviewResponse,
  FilePreviewResponse,
  Message,
  PendingAttachment,
  PendingInteraction,
  QueuedMessage,
  ResetSessionResponse,
  SessionHistoryItem,
  ServiceTier,
  Settings,
  StreamEvent,
  Usage,
} from './types';

const effortOrder: EffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const LIST_AUTO_REFRESH_MS = 15_000;
const ALL_WORKSPACES = 'all';

type Screen = 'list' | 'chat';

type ExplorerUpload = {
  id: string;
  fileName: string;
  status: 'uploading' | 'done' | 'error';
  progress?: number;
  error?: string;
  xhr?: XMLHttpRequest;
};

type FileReference = {
  id: string;
  title: string;
  path: string;
  downloadURL: string;
  isImage?: boolean;
  mimeType?: string;
  fetchPreview?: () => Promise<FilePreviewResponse | ExplorerPreviewResponse>;
};

type FilePreviewState = {
  title: string;
  path: string;
  downloadURL: string;
  content?: string;
  imageURL?: string;
  mimeType?: string;
  truncated?: boolean;
  error?: string;
};

export default function App() {
  useViewportHeightVar();

  const clientRef = useRef(new AgentCockpitAPI());
  const socketRef = useRef<WebSocket | null>(null);
  const listStreamSocketsRef = useRef<Map<string, WebSocket>>(new Map());
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
  const [listArchived, setListArchived] = useState(false);
  const [workspaceFilter, setWorkspaceFilter] = useState(ALL_WORKSPACES);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
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
  const [sessionPreviewTitle, setSessionPreviewTitle] = useState('');
  const [sessionPreviewMessages, setSessionPreviewMessages] = useState<Message[]>([]);

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
  const serviceTierEnabled = selectedBackendID === 'codex';
  const hasUploadingAttachments = pendingAttachments.some((attachment) => attachment.status === 'uploading');
  const profileSelectionLocked = (activeConversation?.messages.length || 0) > 0;

  useEffect(() => {
    void loadDashboard();
    return () => {
      socketRef.current?.close();
      closeListStreamSockets();
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

  async function openConversation(id: string) {
    try {
      setLoading(true);
      setErrorMessage(null);
      socketRef.current?.close();
      closeListStreamSockets();
      const [conversation, streamIDs] = await Promise.all([
        clientRef.current.getConversation(id),
        clientRef.current.getActiveStreams(),
      ]);
      const streamActive = streamIDs.has(id);
      setActiveStreamIDs(streamIDs);
      setActiveConversation(conversation);
      setDraft('');
      setStreamText('');
      setPendingInteraction(null);
      setPendingAttachments([]);
      hydrateSelectionFromConversation(conversation);
      setIsStreaming(streamActive);
      setScreen('chat');
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
        workingDir: newWorkingDir.trim() || settings?.workingDirectory,
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
    if (hasUploadingAttachments || (!content && !attachments.length)) {
      return;
    }
    if (isStreaming) {
      await enqueueDraft();
      return;
    }
    await sendMessageNow({ content, attachments: attachments.length ? attachments : undefined });
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

  function startStream(conversationID: string) {
    socketRef.current?.close();
    setIsStreaming(true);
    setActiveStreamIDs((current) => new Set(current).add(conversationID));
    const socket = new WebSocket(clientRef.current.websocketURL(conversationID));
    socketRef.current = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'reconnect' }));
    socket.onmessage = (event) => {
      try {
        handleStreamEvent(conversationID, JSON.parse(event.data) as StreamEvent);
      } catch {
        setErrorMessage('The stream returned an invalid event.');
      }
    };
    socket.onerror = () => setErrorMessage('Stream connection failed.');
    socket.onclose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
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
    setIsStreaming(false);
    setActiveStreamIDs((current) => {
      const next = new Set(current);
      next.delete(conversationID);
      return next;
    });
    socketRef.current?.close();
    socketRef.current = null;
  }

  async function refreshAfterStream(conversationID: string) {
    try {
      const [conversation, streamIDs, loadedConversations] = await Promise.all([
        clientRef.current.getConversation(conversationID),
        clientRef.current.getActiveStreams(),
        clientRef.current.listConversations(listArchived),
      ]);
      setActiveConversation((current) => (current?.id === conversationID ? conversation : current));
      setActiveStreamIDs(streamIDs);
      setConversations(loadedConversations);
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
      socketRef.current?.close();
      setIsStreaming(false);
      setPendingInteraction(null);
      await clientRef.current.abortConversation(conversation.id);
      const reloaded = await clientRef.current.getConversation(conversation.id);
      setActiveConversation(reloaded);
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
                lastMessage: undefined,
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
      setSessionPreviewTitle('');
      setSessionPreviewMessages([]);
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

  async function openSessions() {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    try {
      const loaded = await clientRef.current.getSessions(conversation.id);
      setSessions(loaded);
      setSessionPreviewTitle('');
      setSessionPreviewMessages([]);
      setSessionsVisible(true);
    } catch (error) {
      handleError(error);
    }
  }

  async function previewSession(session: SessionHistoryItem) {
    const conversation = activeConversation;
    if (!conversation) {
      return;
    }
    try {
      setSessionPreviewTitle(`Session ${session.number}`);
      if (session.isCurrent) {
        setSessionPreviewMessages(conversation.messages);
      } else {
        const response = await clientRef.current.getSessionMessages(conversation.id, session.number);
        setSessionPreviewMessages(response.messages || []);
      }
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
      setExplorerParent(tree.parent || null);
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

  function chooseBackend(backendID: string) {
    if (profileSelectionLocked) {
      return;
    }
    setSelectedCliProfileId(undefined);
    setSelectedBackend(backendID);
    setSelectedModel(undefined);
    setSelectedEffort(undefined);
    setSelectedServiceTier(backendID === 'codex' ? (selectedServiceTier || settings?.defaultServiceTier) : undefined);
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
          archived={listArchived}
          workspaceFilter={workspaceFilter}
          loading={loading}
          currentUser={currentUser}
          errorMessage={errorMessage}
          onRefresh={() => void loadDashboard(listArchived)}
          onToggleArchived={() => void loadDashboard(!listArchived)}
          onWorkspaceFilter={setWorkspaceFilter}
          onOpenConversation={(id) => void openConversation(id)}
          onNewConversation={() => {
            setNewWorkingDir(settings?.workingDirectory || '');
            setNewConversationVisible(true);
          }}
        />
      ) : (
        <ChatScreen
          conversation={activeConversation}
          draft={draft}
          setDraft={setDraft}
          streamText={streamText}
          isStreaming={isStreaming}
          loading={loading}
          errorMessage={errorMessage}
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
            socketRef.current?.close();
            setScreen('list');
            void refreshConversationList();
          }}
          onSend={() => void sendDraft()}
          onStop={() => void stopStream()}
          onAttach={() => attachInputRef.current?.click()}
          onRemoveAttachment={(id) => void removePendingAttachment(id)}
          onOcrAttachment={(id) => void ocrPendingAttachment(id)}
          onSubmitInteraction={() => void submitInteraction()}
          onRemoveQueued={(index) => void removeQueuedMessage(index)}
          onEditQueued={openQueueEditor}
          onMoveQueued={(index, direction) => void moveQueuedMessage(index, direction)}
          onClearQueue={() => void clearQueue()}
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
          backends={backends}
          selectedCliProfileId={selectedCliProfileId}
          selectedBackend={selectedBackend}
          selectedBackendMetadata={selectedBackendMetadata}
          selectedModel={selectedModel}
          selectedEffort={selectedEffort}
          selectedServiceTier={selectedServiceTier}
          serviceTierEnabled={serviceTierEnabled}
          supportedEfforts={supportedEfforts}
          locked={profileSelectionLocked}
          onClose={() => setSettingsVisible(false)}
          onProfile={chooseProfile}
          onBackend={chooseBackend}
          onModel={setSelectedModel}
          onEffort={setSelectedEffort}
          onServiceTier={setSelectedServiceTier}
        />
      ) : null}

      {sessionsVisible ? (
        <SessionsModal
          client={clientRef.current}
          conversation={activeConversation}
          sessions={sessions}
          previewTitle={sessionPreviewTitle}
          previewMessages={sessionPreviewMessages}
          onClose={() => setSessionsVisible(false)}
          onPreview={(session) => void previewSession(session)}
          onShare={(session) => {
            if (activeConversation) window.open(clientRef.current.sessionMarkdownURL(activeConversation.id, session.number), '_blank');
          }}
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
          onParent={() => void loadExplorer(explorerParent || '')}
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
  archived: boolean;
  workspaceFilter: string;
  loading: boolean;
  currentUser: CurrentUser | null;
  errorMessage: string | null;
  onRefresh: () => void;
  onToggleArchived: () => void;
  onWorkspaceFilter: (workspaceHash: string) => void;
  onOpenConversation: (id: string) => void;
  onNewConversation: () => void;
}) {
  const workspaces = useMemo(() => workspaceOptions(props.conversations), [props.conversations]);
  const visibleConversations = props.workspaceFilter === ALL_WORKSPACES
    ? props.conversations
    : props.conversations.filter((conversation) => conversation.workspaceHash === props.workspaceFilter);

  return (
    <section className="screen">
      <header className="topbar">
        <div>
          <h1>{props.archived ? 'Archived' : 'Agent Cockpit'}</h1>
          <p>{userLabel(props.currentUser)}</p>
        </div>
        {props.loading ? <div className="mini-spinner" /> : null}
      </header>
      <nav className="toolbar">
        <Button label="New" variant="primary" onClick={props.onNewConversation} />
        <Button label={props.archived ? 'Active' : 'Archived'} onClick={props.onToggleArchived} />
        {workspaces.length > 1 ? (
          <label className="filter-select">
            <span>Workspace</span>
            <select value={props.workspaceFilter} onChange={(event) => props.onWorkspaceFilter(event.currentTarget.value)}>
              <option value={ALL_WORKSPACES}>All conversations</option>
              {workspaces.map((workspace) => (
                <option key={workspace.hash} value={workspace.hash}>{workspace.label}</option>
              ))}
            </select>
          </label>
        ) : null}
        <Button label="Refresh" onClick={props.onRefresh} />
        {'Notification' in window && Notification.permission === 'default' ? (
          <Button label="Enable Alerts" onClick={() => void Notification.requestPermission()} />
        ) : null}
      </nav>
      {props.errorMessage ? <ErrorBanner message={props.errorMessage} /> : null}
      <div className="conversation-list">
        {visibleConversations.length ? visibleConversations.map((conversation) => (
          <button key={conversation.id} className="conversation-card" onClick={() => props.onOpenConversation(conversation.id)}>
            <span className="row">
              <strong>{conversation.title || 'Untitled'}</strong>
              {props.activeStreamIDs.has(conversation.id) ? <span className="badge">Running</span> : null}
            </span>
            <span className="workspace">{lastTwoPathComponents(conversation.workingDir)}</span>
            {conversation.lastMessage ? <span className="last-message">{displayMessagePreview(conversation.lastMessage)}</span> : null}
            <span className="row meta">
              <span>{conversation.messageCount} messages</span>
              <span>{formatDate(conversation.updatedAt)}</span>
            </span>
          </button>
        )) : <p className="empty">{props.conversations.length ? 'No conversations in this workspace.' : 'No conversations.'}</p>}
      </div>
    </section>
  );
}

function ChatScreen(props: {
  conversation: Conversation | null;
  draft: string;
  setDraft: (value: string) => void;
  streamText: string;
  isStreaming: boolean;
  loading: boolean;
  errorMessage: string | null;
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
  onAttach: () => void;
  onRemoveAttachment: (id: string) => void;
  onOcrAttachment: (id: string) => void;
  onSubmitInteraction: () => void;
  onRemoveQueued: (index: number) => void;
  onEditQueued: (index: number) => void;
  onMoveQueued: (index: number, direction: -1 | 1) => void;
  onClearQueue: () => void;
  onOpenFile: (reference: FileReference) => void;
  onShareFile: (reference: FileReference) => void;
  onOpenActions: () => void;
  onOpenSettings: () => void;
}) {
  const conversation = props.conversation;
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const lastMessage = conversation?.messages[conversation.messages.length - 1];
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
  if (!conversation) {
    return <section className="screen center">No conversation selected.</section>;
  }
  const sendDisabled =
    (!props.draft.trim() && !completedAttachmentMetas(props.pendingAttachments).length) ||
    props.hasUploadingAttachments ||
    !!props.pendingInteraction;

  return (
    <section className="screen chat-screen">
      <header className="chat-topbar">
        <Button label="Back" onClick={props.onBack} />
        <div className="chat-title">
          <h1>{conversation.title || 'Untitled'}</h1>
          <p>{lastTwoPathComponents(conversation.workingDir)}</p>
        </div>
        {props.isStreaming ? <Button label="Stop" variant="danger" onClick={props.onStop} /> : null}
        <Button label="More" onClick={props.onOpenActions} />
      </header>
      {props.errorMessage ? <ErrorBanner message={props.errorMessage} /> : null}
      <div className="transcript" ref={transcriptRef}>
        {conversation.messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            conversation={conversation}
            client={props.client}
            onOpenFile={props.onOpenFile}
            onShareFile={props.onShareFile}
          />
        ))}
        {props.isStreaming && props.streamText ? (
          <div className="message assistant">
            <strong>Assistant</strong>
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
      <button className="selection-bar" onClick={props.onOpenSettings}>
        {(props.selectedProfile || props.selectedBackend || 'Backend')
          + ' / ' + (props.selectedModel || 'Model')
          + (props.selectedEffort ? ` / ${props.selectedEffort}` : '')
          + (props.selectedServiceTier === 'fast' ? ' / Fast' : '')}
      </button>
      <footer className="composer">
        <Button label="Attach" onClick={props.onAttach} />
        <textarea
          value={props.draft}
          onChange={(event) => props.setDraft(event.target.value)}
          placeholder={props.isStreaming ? 'Message will be queued while the stream runs.' : 'Message Agent Cockpit'}
          rows={2}
        />
        <Button label={props.isStreaming ? 'Queue' : 'Send'} variant="primary" disabled={sendDisabled} onClick={props.onSend} />
      </footer>
    </section>
  );
}

function MessageBubble(props: {
  message: Message;
  conversation: Conversation;
  client: AgentCockpitAPI;
  onOpenFile: (reference: FileReference) => void;
  onShareFile: (reference: FileReference) => void;
}) {
  const isUser = props.message.role === 'user';
  return (
    <div className={`message ${isUser ? 'user' : 'assistant'}`}>
      <strong>{isUser ? 'You' : 'Assistant'}</strong>
      {props.message.contentBlocks?.length ? props.message.contentBlocks.map((block, index) => (
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
  return (
    <div className="usage-bar">
      <span>{tokens.toLocaleString()} tokens</span>
      <span>${usage.costUsd.toFixed(4)}</span>
      {usage.contextUsagePercentage !== undefined ? <span>{formatPercent(usage.contextUsagePercentage)} context</span> : null}
    </div>
  );
}

function NewConversationModal(props: {
  title: string;
  workingDir: string;
  loading: boolean;
  onTitleChange: (value: string) => void;
  onWorkingDirChange: (value: string) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <Modal title="New Conversation" onClose={props.onCancel}>
      <label>Title<input value={props.title} onChange={(event) => props.onTitleChange(event.target.value)} /></label>
      <label>Working directory<input value={props.workingDir} onChange={(event) => props.onWorkingDirChange(event.target.value)} /></label>
      <div className="modal-actions">
        <Button label="Cancel" onClick={props.onCancel} />
        <Button label="Create" variant="primary" disabled={props.loading} onClick={props.onCreate} />
      </div>
    </Modal>
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
    <Modal title="Conversation" onClose={props.onClose}>
      <label>Title<input value={props.renameTitle} onChange={(event) => props.setRenameTitle(event.target.value)} /></label>
      <Button label="Rename" variant="primary" disabled={!props.renameTitle.trim()} onClick={props.onRename} />
      <div className="stack">
        <Button label="Share Markdown" onClick={props.onShare} />
        <Button label="Sessions" onClick={props.onSessions} />
        <Button label="Files" onClick={props.onFiles} />
        <Button label="Reset Session" disabled={props.isStreaming} onClick={props.onReset} />
        <Button label={props.conversation?.archived ? 'Restore' : 'Archive'} disabled={props.isStreaming} onClick={props.onArchiveRestore} />
        <Button label="Delete" variant="danger" disabled={props.isStreaming} onClick={props.onDelete} />
      </div>
    </Modal>
  );
}

function RunSettingsModal(props: {
  profiles: Array<{ id: string; name: string }>;
  backends: BackendMetadata[];
  selectedCliProfileId?: string;
  selectedBackend?: string;
  selectedBackendMetadata?: BackendMetadata;
  selectedModel?: string;
  selectedEffort?: EffortLevel;
  selectedServiceTier?: ServiceTier | 'default';
  serviceTierEnabled: boolean;
  supportedEfforts: EffortLevel[];
  locked: boolean;
  onClose: () => void;
  onProfile: (id: string) => void;
  onBackend: (id: string) => void;
  onModel: (id: string | undefined) => void;
  onEffort: (effort: EffortLevel | undefined) => void;
  onServiceTier: (serviceTier: ServiceTier | 'default' | undefined) => void;
}) {
  return (
    <Modal title="Run Settings" onClose={props.onClose}>
      {props.locked ? <p className="meta">Profile and backend are locked after a session has messages.</p> : null}
      <strong>Profile</strong>
      <div className="choice-grid">
        {props.profiles.map((profile) => <Choice key={profile.id} label={profile.name} selected={props.selectedCliProfileId === profile.id} disabled={props.locked} onClick={() => props.onProfile(profile.id)} />)}
      </div>
      <strong>Backend</strong>
      <div className="choice-grid">
        {props.backends.map((backend) => <Choice key={backend.id} label={backend.label || backend.id} selected={!props.selectedCliProfileId && props.selectedBackend === backend.id} disabled={props.locked} onClick={() => props.onBackend(backend.id)} />)}
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
    </Modal>
  );
}

function SessionsModal(props: {
  client: AgentCockpitAPI;
  conversation: Conversation | null;
  sessions: SessionHistoryItem[];
  previewTitle: string;
  previewMessages: Message[];
  onClose: () => void;
  onPreview: (session: SessionHistoryItem) => void;
  onShare: (session: SessionHistoryItem) => void;
  onOpenFile: (reference: FileReference) => void;
  onShareFile: (reference: FileReference) => void;
}) {
  return (
    <Modal title="Sessions" onClose={props.onClose} full>
      <div className="modal-scroll">
        {props.sessions.map((session) => (
          <article key={session.number} className="list-row">
            <button onClick={() => props.onPreview(session)}>
              <strong>Session {session.number}{session.isCurrent ? ' (current)' : ''}</strong>
              <span>{session.messageCount} messages / {formatDate(session.startedAt)}</span>
              {session.summary ? <p>{session.summary}</p> : null}
            </button>
            <Button label="Share" onClick={() => props.onShare(session)} />
          </article>
        ))}
        {props.previewTitle && props.conversation ? (
          <section className="preview-panel">
            <strong>{props.previewTitle}</strong>
            {props.previewMessages.map((message) => (
              <MessageBubble key={message.id} message={message} conversation={props.conversation!} client={props.client} onOpenFile={props.onOpenFile} onShareFile={props.onShareFile} />
            ))}
          </section>
        ) : null}
      </div>
    </Modal>
  );
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
    <Modal title={`Files ${props.path || '/'}`} onClose={props.onClose} full>
      <div className="toolbar">
        <Button label="Parent" disabled={!props.parent} onClick={props.onParent} />
        <Button label="Refresh" onClick={props.onRefresh} />
        <Button label="New Folder" onClick={props.onNewFolder} />
        <Button label="New File" onClick={props.onNewFile} />
        <Button label="Upload" onClick={() => props.uploadInputRef.current?.click()} />
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
          <article key={`${entry.type}-${entry.name}`} className="list-row">
            <button onClick={() => props.onEntry(entry)}>
              <strong>{entry.type === 'dir' ? '[dir] ' : ''}{entry.name}</strong>
              {entry.size !== undefined ? <span>{formatBytes(entry.size)}</span> : null}
            </button>
            <div className="button-row">
              <Button label="Rename" onClick={() => props.onRenameEntry(entry)} />
              <Button label="Delete" variant="danger" onClick={() => props.onDeleteEntry(entry)} />
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

function Modal(props: { title: string; subtitle?: string; full?: boolean; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className={`modal ${props.full ? 'modal-full' : ''}`}>
        <header className="modal-header">
          <div>
            <h2>{props.title}</h2>
            {props.subtitle ? <p>{props.subtitle}</p> : null}
          </div>
          <Button label="Close" onClick={props.onClose} />
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

function useViewportHeightVar() {
  useEffect(() => {
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty('--app-height', `${window.visualViewport?.height || window.innerHeight}px`);
      root.scrollLeft = 0;
      document.body.scrollLeft = 0;
      if (window.scrollX !== 0) {
        window.scrollTo(0, window.scrollY);
      }
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, []);
}

function parseMessageFiles(content: string): { text: string; uploadedPaths: string[]; deliveredPaths: string[] } {
  const deliveredPaths: string[] = [];
  let text = content.replace(/<!--\s*FILE_DELIVERY:([\s\S]*?)-->/g, (_match, path: string) => {
    const trimmed = path.trim();
    if (trimmed) deliveredPaths.push(trimmed);
    return '';
  });
  const uploadedPaths: string[] = [];
  const uploadMatch = text.match(/\n*\[Uploaded files?:\s*([^\]]+)\]\s*$/i);
  if (uploadMatch) {
    uploadedPaths.push(...(uploadMatch[1] || '').split(',').map((path) => path.trim()).filter(Boolean));
    text = text.slice(0, uploadMatch.index).trimEnd();
  }
  return { text: text.trim(), uploadedPaths, deliveredPaths };
}

function displayMessagePreview(content: string): string {
  const parsed = parseMessageFiles(content);
  if (parsed.text) {
    return parsed.text;
  }
  if (parsed.uploadedPaths.length) {
    const names = parsed.uploadedPaths.map(basenameFromPath).join(', ');
    return `${parsed.uploadedPaths.length === 1 ? 'Attachment' : `${parsed.uploadedPaths.length} attachments`}: ${names}`;
  }
  if (parsed.deliveredPaths.length) {
    const names = parsed.deliveredPaths.map(basenameFromPath).join(', ');
    return `${parsed.deliveredPaths.length === 1 ? 'File' : `${parsed.deliveredPaths.length} files`}: ${names}`;
  }
  return content;
}

function fileReferencesFromParsed(
  client: AgentCockpitAPI,
  conversation: Conversation,
  role: Message['role'],
  parsed: { uploadedPaths: string[]; deliveredPaths: string[] },
): FileReference[] {
  const references: FileReference[] = [];
  if (role === 'user') {
    references.push(...parsed.uploadedPaths.map((path) => makeConversationUploadReference(client, conversation, path)));
  }
  references.push(...parsed.deliveredPaths.map((path) => makeWorkspaceFileReference(client, conversation.workspaceHash, path)));
  return references;
}

function makeConversationUploadReference(client: AgentCockpitAPI, conversation: Conversation, path: string): FileReference {
  const title = basenameFromPath(path);
  return {
    id: `conversation:${conversation.id}:${path}`,
    title,
    path,
    downloadURL: client.conversationFileURL(conversation.id, title, 'download'),
    isImage: isImageFileName(title),
    fetchPreview: () => client.getConversationFilePreview(conversation.id, title),
  };
}

function makeConversationArtifactReference(client: AgentCockpitAPI, conversation: Conversation, artifact: ConversationArtifact): FileReference {
  const title = artifact.title || artifact.filename || basenameFromPath(artifact.path);
  const filename = artifact.filename || basenameFromPath(artifact.path);
  return {
    id: `artifact:${conversation.id}:${filename}:${artifact.sourceToolId || ''}`,
    title,
    path: artifact.path || filename,
    downloadURL: client.conversationFileURL(conversation.id, filename, 'download'),
    isImage: artifact.kind === 'image' || isImageFileName(filename),
    mimeType: artifact.mimeType,
    fetchPreview: () => client.getConversationFilePreview(conversation.id, filename),
  };
}

function makeWorkspaceFileReference(client: AgentCockpitAPI, workspaceHash: string, path: string): FileReference {
  const title = basenameFromPath(path);
  return {
    id: `workspace:${workspaceHash}:${path}`,
    title,
    path,
    downloadURL: client.workspaceFileURL(workspaceHash, path, 'download'),
    isImage: isImageFileName(title),
    fetchPreview: () => client.getWorkspaceFilePreview(workspaceHash, path),
  };
}

function makeExplorerFileReference(client: AgentCockpitAPI, workspaceHash: string, path: string): FileReference {
  const title = basenameFromPath(path);
  return {
    id: `explorer:${workspaceHash}:${path}`,
    title,
    path,
    downloadURL: client.explorerFileURL(workspaceHash, path, 'download'),
    isImage: isImageFileName(title),
    fetchPreview: () => client.getExplorerPreview(workspaceHash, path),
  };
}

function conversationListItemFromConversation(conversation: Conversation): ConversationListItem {
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: new Date().toISOString(),
    backend: conversation.backend,
    cliProfileId: conversation.cliProfileId,
    model: conversation.model,
    effort: conversation.effort,
    serviceTier: conversation.serviceTier,
    workingDir: conversation.workingDir,
    workspaceHash: conversation.workspaceHash,
    workspaceKbEnabled: false,
    messageCount: conversation.messages.length,
    archived: conversation.archived,
  };
}

function updateSessionsAfterReset(sessions: SessionHistoryItem[], response: ResetSessionResponse): SessionHistoryItem[] {
  const archived = response.archivedSession;
  const updated = sessions.map((session) => {
    if (archived && session.number === archived.number) {
      return {
        ...session,
        sessionId: archived.sessionId || session.sessionId,
        startedAt: archived.startedAt,
        endedAt: archived.endedAt,
        messageCount: archived.messageCount,
        summary: archived.summary,
        isCurrent: false,
      };
    }
    return { ...session, isCurrent: false };
  });
  if (!updated.some((session) => session.number === response.newSessionNumber)) {
    updated.push({
      number: response.newSessionNumber,
      sessionId: response.conversation.currentSessionId,
      startedAt: new Date().toISOString(),
      endedAt: undefined,
      messageCount: 0,
      summary: undefined,
      isCurrent: true,
    });
  }
  return updated.map((session) => (
    session.number === response.newSessionNumber
      ? { ...session, isCurrent: true, messageCount: 0, summary: undefined, endedAt: undefined }
      : session
  ));
}

function wireContent(message: QueuedMessage): string {
  const paths = (message.attachments || []).map((attachment) => attachment.path).filter(Boolean);
  if (!paths.length) return message.content;
  const tag = `[Uploaded files: ${paths.join(', ')}]`;
  return message.content.trim() ? `${message.content}\n\n${tag}` : tag;
}

function completedAttachmentMetas(attachments: PendingAttachment[]): AttachmentMeta[] {
  return attachments.map((attachment) => attachment.result).filter(Boolean) as AttachmentMeta[];
}

function upsertMessage(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index === -1) return [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
}

function userLabel(user: CurrentUser | null): string {
  if (!user) return 'Not loaded';
  return user.displayName || user.email || 'Local session';
}

function reconcileEffort(current: EffortLevel | undefined, supported: EffortLevel[]): EffortLevel | undefined {
  if (!supported.length) return undefined;
  if (current && supported.includes(current)) return current;
  if (supported.includes('high')) return 'high';
  return supported.slice().sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b))[0];
}

function lastTwoPathComponents(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return path || 'Default workspace';
  return parts.slice(-2).join('/');
}

function workspaceOptions(conversations: ConversationListItem[]): Array<{ hash: string; label: string }> {
  const byHash = new Map<string, string>();
  for (const conversation of conversations) {
    if (!byHash.has(conversation.workspaceHash)) {
      byHash.set(conversation.workspaceHash, lastTwoPathComponents(conversation.workingDir));
    }
  }
  return Array.from(byHash, ([hash, label]) => ({ hash, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatPercent(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toString()}%`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function joinExplorerPath(parent: string, name: string): string {
  return [parent, name].filter(Boolean).join('/');
}

function parentExplorerPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function basenameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() || path || 'file';
}

function isImageFileName(fileName: string): boolean {
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(fileName);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
