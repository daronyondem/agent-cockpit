import React from 'react';

import { AgentApi } from '../api.js';
import { Ico } from '../icons.jsx';
import { StreamStore } from '../streamStore.js';
import { useDialog } from '../dialog.jsx';
import { useToasts } from '../toast.jsx';
import { useCliProfileSettings, useConversationSelector, shallowEqual } from '../shellState.jsx';
import { hiddenStreamErrorMessageIds } from './messageParsing';
import { collapseProgressRuns, messageScrollSignature } from './messageModel.js';
import { backendIdForProfile, workspaceRefForConv } from './chatHelpers.js';
import { AgentIndexProvider } from './toolRuns.jsx';
import { FileViewerContext, ImageLightbox } from './messageContent.jsx';
import { MessageBubble, PinStrip, ProgressBreadcrumbBubble, ResetProgressBubble } from './messageFeed.jsx';
import { ChatComposer } from './composer.jsx';
import { ContextChip } from './contextChip.jsx';
import { FileViewerPanel } from './fileViewerPanel.jsx';
import { InteractionCard, MemoryUpdateBubble, PlanModeBanner, StreamErrorCard } from './chatStatusCards.jsx';

const SessionsModal = React.lazy(() => import('../sessionsModal.jsx').then(mod => ({ default: mod.SessionsModal })));

const CHAT_SCROLL_BOTTOM_THRESHOLD_PX = 48;
const chatFeedScrollPositions = new Map();

function isChatScrolledToEnd(el){
  return el.scrollHeight - el.clientHeight - el.scrollTop <= CHAT_SCROLL_BOTTOM_THRESHOLD_PX;
}

function snapshotMessageWindow(window){
  if (!window || typeof window !== 'object') return null;
  return {
    total: Number.isFinite(window.total) ? window.total : null,
    startIndex: Number.isFinite(window.startIndex) ? window.startIndex : null,
    endIndex: Number.isFinite(window.endIndex) ? window.endIndex : null,
    hasOlder: !!window.hasOlder,
    hasNewer: !!window.hasNewer,
  };
}

function messageWindowMatchesSnapshot(window, snapshot){
  if (!window || !snapshot) return false;
  return window.total === snapshot.total
    && window.startIndex === snapshot.startIndex
    && window.endIndex === snapshot.endIndex;
}

function clampFeedScrollTop(feed, top){
  return Math.max(0, Math.min(top, Math.max(0, feed.scrollHeight - feed.clientHeight)));
}

function selectChatLiveState(s){
  if (!s) return null;
  return {
    conv: s.conv,
    messages: s.messages,
    messageWindow: s.messageWindow,
    pinnedMessages: s.pinnedMessages,
    loadingOlder: !!s.loadingOlder,
    loadingAround: !!s.loadingAround,
    sending: s.sending,
    streaming: s.streaming,
    loadError: s.loadError,
    streamError: s.streamError,
    streamErrorSource: s.streamErrorSource,
    usage: s.usage,
    streamingMsgId: s.streamingMsgId,
    pendingInteraction: s.pendingInteraction,
    respondPending: s.respondPending,
    composerCliProfileId: s.composerCliProfileId,
    composerBackend: s.composerBackend,
    planModeActive: s.planModeActive,
    queueLength: (s.queue || []).length,
    resetting: !!s.resetting,
  };
}

export function ChatLive({ convId, onArchived, onDeleted, onOpenMemoryUpdate, onOpenWorkspaceSettings, onOpenSettings }){
  const state = useConversationSelector(convId, selectChatLiveState, shallowEqual);
  const { profiles: cliProfiles } = useCliProfileSettings();
  const dialog = useDialog();
  const toast = useToasts();
  const feedRef = React.useRef(null);
  const feedAutoFollowRef = React.useRef(true);
  const feedStreamingRef = React.useRef(false);
  const messageWindowRef = React.useRef(null);
  const loadingOlderRef = React.useRef(false);
  const scrollRestoreRef = React.useRef(null);
  const forceBackToEndRef = React.useRef(false);
  const dragCounterRef = React.useRef(0);
  const [dragOver, setDragOver] = React.useState(false);
  const [sessionsOpen, setSessionsOpen] = React.useState(false);
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState('');
  const [savingTitle, setSavingTitle] = React.useState(false);
  const [showFeedBackToEnd, setShowFeedBackToEnd] = React.useState(false);
  const titleInputRef = React.useRef(null);
  const [fileViewer, setFileViewer] = React.useState(null);
  const openFileViewer = React.useCallback((descriptor) => {
    if (!descriptor) return;
    setFileViewer(descriptor);
  }, []);
  const closeFileViewer = React.useCallback(() => setFileViewer(null), []);
  React.useEffect(() => { setFileViewer(null); }, [convId]);
  React.useEffect(() => {
    if (!fileViewer) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeFileViewer(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fileViewer, closeFileViewer]);

  const [lightbox, setLightbox] = React.useState(null);
  const openLightbox = React.useCallback((src, alt) => setLightbox({ src, alt: alt || '' }), []);
  const closeLightbox = React.useCallback(() => setLightbox(null), []);
  React.useEffect(() => { setLightbox(null); }, [convId]);

  React.useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);

  const stateMessages = state ? state.messages : null;
  const messages = React.useMemo(() => stateMessages || [], [stateMessages]);
  const messageWindow = state ? state.messageWindow : null;
  const messageWindowStartIndex = messageWindow ? messageWindow.startIndex : null;
  const messageWindowEndIndex = messageWindow ? messageWindow.endIndex : null;
  const loadingOlder = !!(state && state.loadingOlder);
  const loadingAround = !!(state && state.loadingAround);
  const activeStreamError = state ? state.streamError : null;
  const activeStreamErrorSource = state ? state.streamErrorSource : null;
  const conv = state ? state.conv : null;
  const sending = state ? state.sending : false;
  const streaming = state ? state.streaming : false;
  const streamError = state ? state.streamError : null;
  const usage = state ? state.usage : null;
  const streamingMsgId = state ? state.streamingMsgId : null;
  const pendingInteraction = state ? state.pendingInteraction : null;
  const respondPending = state ? state.respondPending : false;
  const queueLength = state ? (state.queueLength || 0) : 0;
  const resetting = !!(state && state.resetting);
  const planModeActive = !!(state && state.planModeActive);
  feedStreamingRef.current = streaming;
  messageWindowRef.current = messageWindow;
  loadingOlderRef.current = loadingOlder;
  const streamingMsgIdRef = React.useRef(streamingMsgId);
  streamingMsgIdRef.current = streamingMsgId;
  const profileLocked = messages.length > 0;
  const lastMessage = messages[messages.length - 1] || null;
  const lastMessageScrollSignature = messageScrollSignature(lastMessage);
  const hiddenStreamErrorMessageIdsSet = React.useMemo(
    () => hiddenStreamErrorMessageIds(messages, activeStreamError, activeStreamErrorSource),
    [messages, activeStreamError, activeStreamErrorSource]
  );
  const feedMessages = React.useMemo(
    () => hiddenStreamErrorMessageIdsSet.size
      ? messages.filter(m => !hiddenStreamErrorMessageIdsSet.has(m.id))
      : messages,
    [messages, hiddenStreamErrorMessageIdsSet]
  );
  const messageFeedEntries = React.useMemo(
    () => collapseProgressRuns(feedMessages),
    [feedMessages]
  );
  const pinnedMessageEntries = state && Array.isArray(state.pinnedMessages) ? state.pinnedMessages : null;
  const pinnedMessages = React.useMemo(() => {
    const entries = pinnedMessageEntries || [];
    const fromServer = entries
      .map(entry => entry && entry.message)
      .filter(m => m && m.pinned && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'));
    if (fromServer.length) return fromServer;
    return feedMessages.filter(m => m && m.pinned && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'));
  }, [pinnedMessageEntries, feedMessages]);
  const messageRefs = React.useRef(new Map());
  const pendingPinJumpRef = React.useRef(null);
  const pinJumpSerialRef = React.useRef(0);
  const feedRestoreDoneRef = React.useRef(false);
  const pinFocusTimerRef = React.useRef(null);
  const [pinStripIndex, setPinStripIndex] = React.useState(0);
  const [pinJumpToken, setPinJumpToken] = React.useState(0);
  const [focusedPinId, setFocusedPinId] = React.useState(null);
  const setMessageRef = React.useCallback((id, node) => {
    if (!id) return;
    if (node) messageRefs.current.set(id, node);
    else messageRefs.current.delete(id);
  }, []);

  React.useEffect(() => {
    pendingPinJumpRef.current = null;
    forceBackToEndRef.current = false;
    pinJumpSerialRef.current += 1;
    feedRestoreDoneRef.current = false;
    setPinStripIndex(0);
    setFocusedPinId(null);
    if (pinFocusTimerRef.current) {
      clearTimeout(pinFocusTimerRef.current);
      pinFocusTimerRef.current = null;
    }
  }, [convId]);

  React.useEffect(() => () => {
    if (pinFocusTimerRef.current) clearTimeout(pinFocusTimerRef.current);
  }, []);

  React.useEffect(() => {
    setPinStripIndex(index => Math.min(index, Math.max(pinnedMessages.length - 1, 0)));
  }, [pinnedMessages.length]);

  const saveFeedPosition = React.useCallback(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const currentWindow = messageWindowRef.current;
    const feedRect = feed.getBoundingClientRect();
    let anchor = null;
    for (const [messageId, node] of messageRefs.current) {
      if (!node || !feed.contains(node)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < feedRect.top || rect.top > feedRect.bottom) continue;
      if (anchor && rect.top >= anchor.rectTop) continue;
      anchor = {
        messageId,
        offsetTop: rect.top - feedRect.top,
        rectTop: rect.top,
      };
    }
    chatFeedScrollPositions.set(convId, {
      messageId: anchor ? anchor.messageId : null,
      offsetTop: anchor ? anchor.offsetTop : 0,
      scrollTop: feed.scrollTop,
      atTail: isChatScrolledToEnd(feed) && !(currentWindow && currentWindow.hasNewer) && !forceBackToEndRef.current,
      messageWindow: snapshotMessageWindow(currentWindow),
      savedAt: Date.now(),
    });
  }, [convId]);

  const restoreSavedFeedPosition = React.useCallback(() => {
    const saved = chatFeedScrollPositions.get(convId);
    if (!saved) return true;
    const feed = feedRef.current;
    if (!feed) return false;
    const currentWindow = messageWindowRef.current;
    if (saved.atTail && !(currentWindow && currentWindow.hasNewer)) {
      feedAutoFollowRef.current = true;
      forceBackToEndRef.current = false;
      feed.scrollTop = feed.scrollHeight;
      setShowFeedBackToEnd(false);
      return true;
    }
    feedAutoFollowRef.current = false;
    const node = saved.messageId ? messageRefs.current.get(saved.messageId) : null;
    if (node && feed.contains(node)) {
      const feedRect = feed.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      feed.scrollTop = clampFeedScrollTop(
        feed,
        feed.scrollTop + (nodeRect.top - feedRect.top) - (saved.offsetTop || 0)
      );
      setShowFeedBackToEnd(true);
      return true;
    }
    if (messageWindowMatchesSnapshot(currentWindow, saved.messageWindow) || !saved.messageId || messages.length > 0) {
      feed.scrollTop = clampFeedScrollTop(feed, saved.scrollTop || 0);
      setShowFeedBackToEnd(!isChatScrolledToEnd(feed) || !!(currentWindow && currentWindow.hasNewer));
      return true;
    }
    return false;
  }, [convId, messages.length]);

  const focusPinnedMessage = React.useCallback((messageId, behavior = 'smooth') => {
    const feed = feedRef.current;
    const node = messageRefs.current.get(messageId);
    if (!feed || !node || !feed.contains(node)) return false;
    const feedRect = feed.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const targetTop = feed.scrollTop
      + (nodeRect.top - feedRect.top)
      - Math.max(24, (feed.clientHeight - nodeRect.height) / 2);
    if (typeof feed.scrollTo === 'function') {
      feed.scrollTo({ top: Math.max(0, targetTop), behavior });
    } else {
      feed.scrollTop = Math.max(0, targetTop);
    }
    setFocusedPinId(messageId);
    if (pinFocusTimerRef.current) clearTimeout(pinFocusTimerRef.current);
    pinFocusTimerRef.current = setTimeout(() => {
      setFocusedPinId(null);
      pinFocusTimerRef.current = null;
    }, 1600);
    requestAnimationFrame(saveFeedPosition);
    return true;
  }, [saveFeedPosition]);

  React.useLayoutEffect(() => {
    const pending = pendingPinJumpRef.current;
    if (!pending || !pending.messageId) return;
    feedAutoFollowRef.current = false;
    forceBackToEndRef.current = true;
    if (focusPinnedMessage(pending.messageId, pending.behavior || 'smooth')) {
      pendingPinJumpRef.current = null;
    }
    setShowFeedBackToEnd(true);
  }, [
    pinJumpToken,
    messages.length,
    messageWindowStartIndex,
    messageWindowEndIndex,
    focusPinnedMessage,
  ]);

  const jumpToPinnedMessage = React.useCallback(async (messageId, index) => {
    if (typeof index === 'number') setPinStripIndex(index);
    feedAutoFollowRef.current = false;
    forceBackToEndRef.current = true;
    setShowFeedBackToEnd(true);
    const serial = pinJumpSerialRef.current + 1;
    pinJumpSerialRef.current = serial;
    pendingPinJumpRef.current = { messageId, behavior: 'smooth' };
    if (focusPinnedMessage(messageId)) {
      pendingPinJumpRef.current = null;
      requestAnimationFrame(() => setShowFeedBackToEnd(true));
      return;
    }
    pendingPinJumpRef.current = { messageId, behavior: 'auto' };
    const feed = feedRef.current;
    const node = messageRefs.current.get(messageId);
    const targetMounted = !!(feed && node && feed.contains(node));
    if (!targetMounted) {
      try {
        await StreamStore.loadAroundMessage(convId, messageId);
      } catch (err) {
        if (pinJumpSerialRef.current === serial) pendingPinJumpRef.current = null;
        toast.error({
          title: 'Pinned message unavailable',
          message: (err && err.message) || 'The pinned message could not be loaded.',
        });
        return;
      }
    }
    if (pinJumpSerialRef.current !== serial) return;
    setPinJumpToken(token => token + 1);
  }, [convId, focusPinnedMessage, toast]);

  const toggleMessagePin = React.useCallback(async (message) => {
    if (!message || !message.id || message.id === streamingMsgIdRef.current) return;
    try {
      await StreamStore.setMessagePinned(convId, message.id, !message.pinned);
    } catch (err) {
      toast.error({
        title: 'Pin update failed',
        message: (err && err.message) || 'The message pin could not be saved.',
      });
    }
  }, [convId, toast]);

  /* Elapsed = time since the preceding user message in the feed. Walks
     backward from each assistant message; caps at 1 h to match V1
     `rendering.js:201-210`. One pass per render is fine — the feed is
     bounded and the memo hides it behind `messages` identity. */
  const elapsedByMsgId = React.useMemo(() => {
    const map = new Map();
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'assistant' || !m.timestamp) continue;
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j];
        if (prev.role === 'user' && prev.timestamp) {
          const delta = new Date(m.timestamp).getTime() - new Date(prev.timestamp).getTime();
          if (delta > 0 && delta < 3600000) map.set(m.id, delta);
          break;
        }
      }
    }
    return map;
  }, [messages]);

  const handleFeedScroll = React.useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    const currentWindow = messageWindowRef.current;
    const hasNewer = !!(currentWindow && currentWindow.hasNewer);
    if (el.scrollTop <= 120 && currentWindow && currentWindow.hasOlder && !loadingOlderRef.current) {
      scrollRestoreRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
      loadingOlderRef.current = true;
      feedAutoFollowRef.current = false;
      StreamStore.loadOlderMessages(convId).catch(err => {
        scrollRestoreRef.current = null;
        loadingOlderRef.current = false;
        toast.error({
          title: 'Could not load earlier messages',
          message: (err && err.message) || 'The earlier transcript page could not be loaded.',
        });
      });
    }
    if (isChatScrolledToEnd(el) && !hasNewer && !forceBackToEndRef.current) {
      feedAutoFollowRef.current = true;
      setShowFeedBackToEnd(false);
      saveFeedPosition();
      return;
    }
    feedAutoFollowRef.current = false;
    if (forceBackToEndRef.current || feedStreamingRef.current || hasNewer) setShowFeedBackToEnd(true);
    saveFeedPosition();
  }, [convId, saveFeedPosition, toast]);

  React.useLayoutEffect(() => {
    const restore = scrollRestoreRef.current;
    const el = feedRef.current;
    if (!restore || !el) return;
    scrollRestoreRef.current = null;
    loadingOlderRef.current = false;
    el.scrollTop = restore.scrollTop + Math.max(0, el.scrollHeight - restore.scrollHeight);
    saveFeedPosition();
  }, [messages.length, loadingOlder, messageWindowStartIndex, saveFeedPosition]);

  React.useLayoutEffect(() => {
    if (feedRestoreDoneRef.current) return;
    if (restoreSavedFeedPosition()) feedRestoreDoneRef.current = true;
  }, [
    restoreSavedFeedPosition,
    messages.length,
    messageWindowStartIndex,
    messageWindowEndIndex,
  ]);

  React.useLayoutEffect(() => () => {
    saveFeedPosition();
  }, [saveFeedPosition]);

  const scrollFeedToEnd = React.useCallback(async (behavior = 'auto') => {
    const doScroll = () => {
      const el = feedRef.current;
      if (!el) return;
      forceBackToEndRef.current = false;
      pendingPinJumpRef.current = null;
      feedAutoFollowRef.current = true;
      setShowFeedBackToEnd(false);
      if (typeof el.scrollTo === 'function') {
        el.scrollTo({ top: el.scrollHeight, behavior });
      } else {
        el.scrollTop = el.scrollHeight;
      }
      requestAnimationFrame(saveFeedPosition);
    };
    const currentWindow = messageWindowRef.current;
    if (currentWindow && currentWindow.hasNewer) {
      try {
        await StreamStore.loadTailMessages(convId);
      } catch (err) {
        toast.error({
          title: 'Could not load latest messages',
          message: (err && err.message) || 'The latest transcript page could not be loaded.',
        });
        return;
      }
      requestAnimationFrame(doScroll);
      return;
    }
    doScroll();
  }, [convId, saveFeedPosition, toast]);

  React.useEffect(() => {
    const saved = chatFeedScrollPositions.get(convId);
    const restoreNonTail = !!(saved && !saved.atTail);
    forceBackToEndRef.current = false;
    pendingPinJumpRef.current = null;
    feedAutoFollowRef.current = !restoreNonTail;
    setShowFeedBackToEnd(restoreNonTail);
  }, [convId]);

  // Auto-follow new content until the user scrolls away from the active conv.
  const resettingDep = !!(state && state.resetting);
  const feedScrollKey = [
    convId,
    messages.length,
    lastMessage && lastMessage.id,
    lastMessage && (lastMessage.content || '').length,
    lastMessageScrollSignature,
    streaming ? 'streaming' : 'idle',
    resettingDep ? 'resetting' : 'ready',
  ].join(':');
  React.useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const currentWindow = messageWindowRef.current;
    if (forceBackToEndRef.current) {
      feedAutoFollowRef.current = false;
      setShowFeedBackToEnd(true);
      return;
    }
    if (feedAutoFollowRef.current && !(currentWindow && currentWindow.hasNewer)) {
      el.scrollTop = el.scrollHeight;
      setShowFeedBackToEnd(false);
    } else {
      setShowFeedBackToEnd(true);
    }
  }, [feedScrollKey]);

  if (!state || state.loadError) {
    return (
      <section className="main">
        <div className="feed"><div className="feed-inner" style={{padding:"40px 24px"}}>
          <div className="u-dim" style={{fontSize:13}}>
            {state && state.loadError
              ? `Failed to load conversation: ${state.loadError}`
              : 'Loading…'}
          </div>
        </div></div>
      </section>
    );
  }

  if (!conv) {
    return (
      <section className="main">
        <div className="feed"><div className="feed-inner" style={{padding:"40px 24px"}}>
          <div className="u-dim" style={{fontSize:13}}>Loading…</div>
        </div></div>
      </section>
    );
  }

  const wsLabel = conv.workingDir
    ? conv.workingDir.split('/').filter(Boolean).slice(-2).join('/')
    : 'workspace';
  const topbarCliProfileId = profileLocked
    ? (conv.cliProfileId || null)
    : (state.composerCliProfileId || conv.cliProfileId || null);
  const topbarProfile = topbarCliProfileId
    ? cliProfiles.find(profile => profile && profile.id === topbarCliProfileId)
    : null;
  const topbarBackendCandidate = profileLocked
    ? conv.backend
    : (state.composerBackend || conv.backend);
  const topbarBackendId = topbarProfile
    ? (profileLocked ? topbarBackendCandidate : backendIdForProfile(topbarProfile))
    : profileLocked
      ? conv.backend
      : (state.composerBackend || conv.backend);

  function handleDragEnter(e){
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setDragOver(true);
  }
  function handleDragOver(e){
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }
  function handleDragLeave(){
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragOver(false);
  }
  function handleDrop(e){
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOver(false);
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) StreamStore.addAttachments(convId, files);
  }

  async function handleDownload(anchor){
    const sessionNumber = Number(conv.sessionNumber || 1);
    const scope = await dialog.choice({
      anchor,
      title: 'Download conversation',
      body: 'Choose which transcript to export as Markdown.',
      confirmLabel: 'Download',
      choices: [
        { id: 'all', label: 'All sessions', hint: 'Every session in this conversation.' },
        { id: 'current', label: 'Current session', hint: `Session ${sessionNumber}.` },
      ],
      defaultChoice: 'all',
    });
    if (!scope) return;
    const url = scope === 'current'
      ? AgentApi.conv.sessionDownloadUrl(convId, sessionNumber)
      : AgentApi.conv.conversationDownloadUrl(convId);
    window.open(url, '_blank', 'noopener');
  }

  async function handleReset(anchor){
    if (streaming || sending) return;
    const activeProfiles = Array.isArray(cliProfiles) ? cliProfiles.filter(p => p && !p.disabled) : [];
    const storedProfileMissing = profileLocked
      && !!conv.cliProfileId
      && !activeProfiles.some(p => p.id === conv.cliProfileId);
    let resetProfile = null;
    if (storedProfileMissing) {
      const backendMatches = activeProfiles.filter(p => backendIdForProfile(p) === conv.backend);
      resetProfile = activeProfiles.find(p => p.id === state.composerCliProfileId)
        || (backendMatches.length === 1 ? backendMatches[0] : null)
        || (activeProfiles.length === 1 ? activeProfiles[0] : null);
      if (!resetProfile) {
        toast.error({
          title: 'Choose a replacement CLI profile',
          message: 'This conversation references a CLI profile that no longer exists.',
        });
        return;
      }
    }
    const ok = await dialog.confirm({
      anchor,
      title: 'Reset this conversation?',
      body: 'The current session ends and a new one starts. Past messages remain in the session history.',
      confirmLabel: 'Reset',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    const success = await StreamStore.reset(convId, resetProfile ? {
      cliProfileId: resetProfile.id,
      backend: backendIdForProfile(resetProfile),
    } : undefined);
    if (success) toast.success('Session reset');
  }

  async function handleArchive(anchor){
    if (streaming || sending) return;
    const ok = await dialog.confirm({
      anchor,
      title: `Archive "${conv.title || 'Untitled'}"?`,
      body: 'It will disappear from the active sidebar but can be restored later.',
      confirmLabel: 'Archive',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    const result = await StreamStore.archive(convId);
    if (result && onArchived) onArchived();
  }

  async function handleUnarchive(){
    if (streaming || sending) return;
    try {
      await AgentApi.restoreConversation(convId);
      StreamStore.patchConv(convId, { archived: false });
      /* Conv leaves whatever view the sidebar is showing (archived view
         only, since you can't unarchive an active conv). */
      StreamStore.removeConvListItem(convId);
      toast.success('Conversation restored');
    } catch (err) {
      await dialog.alert({ variant: 'error', title: 'Restore failed', body: err.message || String(err) });
    }
  }

  async function handleDelete(anchor){
    if (streaming || sending) return;
    const ok = await dialog.confirm({
      anchor,
      title: `Delete "${conv.title || 'Untitled'}"?`,
      body: 'This permanently removes the conversation and all its sessions. This cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    try {
      await AgentApi.deleteConversation(convId);
      StreamStore.removeConvListItem(convId);
      if (onDeleted) onDeleted();
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Delete failed', body: err.message || String(err) });
    }
  }

  /* Inline title rename — hover surfaces the affordance, click opens an
     input. Enter saves (PUT /conversations/:id), Escape cancels. */
  function startTitleEdit(){
    if (!conv || savingTitle) return;
    setTitleDraft(conv.title || '');
    setEditingTitle(true);
  }
  async function saveTitle(){
    if (!conv) { setEditingTitle(false); return; }
    const next = (titleDraft || '').trim();
    if (!next || next === (conv.title || '')) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    try {
      const updated = await AgentApi.renameConversation(convId, next);
      if (updated && updated.title) {
        StreamStore.patchConv(convId, { title: updated.title });
        StreamStore.patchConvListItem(convId, { title: updated.title });
      }
      setEditingTitle(false);
    } catch (err) {
      await dialog.alert({ variant: 'error', title: 'Rename failed', body: err.message || String(err) });
    } finally {
      setSavingTitle(false);
    }
  }

  return (
    <section
      className={"main" + (dragOver ? " main-dragover" : "")}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver ? (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-inner">Drop files to attach</div>
        </div>
      ) : null}
      <div className="topbar">
        <div className="crumbs">
          <span>{wsLabel}</span>
          <span className="sep">/</span>
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className="topbar-title-edit"
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); saveTitle(); }
                else if (e.key === 'Escape') { e.preventDefault(); setEditingTitle(false); }
              }}
              disabled={savingTitle}
            />
          ) : (
            <span
              className="here topbar-title"
              onClick={startTitleEdit}
              title="Click to rename"
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startTitleEdit(); } }}
            >
              {conv.title || 'Untitled'}
            </span>
          )}
        </div>
        <div className="right">
          {usage ? <ContextChip backendId={topbarBackendId} cliProfileId={topbarCliProfileId} usage={usage}/> : null}
          <button className="btn ghost" onClick={(e) => handleDownload(e.currentTarget)} title="Download as markdown">↓ Download</button>
          <button className="btn ghost" onClick={(e) => handleReset(e.currentTarget)} disabled={streaming || sending || resetting} title="Reset session">{resetting ? '↺ Resetting…' : '↺ Reset'}</button>
          <button className="btn ghost" onClick={() => setSessionsOpen(true)} title="Session history">{Ico.clock(12)} Sessions</button>
          {conv.archived ? (
            <>
              <button className="btn ghost" onClick={handleUnarchive} disabled={streaming || sending} title="Restore conversation">Unarchive</button>
              <button className="btn danger" onClick={(e) => handleDelete(e.currentTarget)} disabled={streaming || sending} title="Delete conversation">Delete</button>
            </>
          ) : (
            <button className="btn danger" onClick={(e) => handleArchive(e.currentTarget)} disabled={streaming || sending} title="Archive conversation">Archive</button>
          )}
        </div>
      </div>

      <div className="feed-wrap">
        <div className="feed" ref={feedRef} onScroll={handleFeedScroll}>
          <PinStrip
            messages={pinnedMessages}
            currentIndex={pinStripIndex}
            onSelect={jumpToPinnedMessage}
          />
          {loadingOlder ? (
            <div className="feed-page-status feed-page-status-top" role="status" aria-live="polite">
              <span className="feed-page-spinner" aria-hidden="true"/>
              <span>Loading earlier messages...</span>
            </div>
          ) : null}
          <div className="feed-inner">
            {messages.length === 0 && !streaming && (
              <div className="u-dim" style={{padding:"24px 12px",fontSize:13}}>
                No messages yet. Say hello below.
              </div>
            )}
            <FileViewerContext.Provider value={{
              wsHash: workspaceRefForConv(conv),
              workspaceLabel: wsLabel,
              convId,
              workingDir: conv.workingDir || null,
              executionDir: conv.executionDir || conv.workingDir || null,
              openFileViewer,
              openLightbox,
              onOpenWorkspaceSettings,
            }}>
            <AgentIndexProvider messages={feedMessages}>
              {messageFeedEntries.map(entry => {
                if (entry.kind === 'plain') {
                  if (entry.message.role === 'memory') {
                    return (
                      <MemoryUpdateBubble
                        key={entry.message.id}
                        message={entry.message}
                        onOpen={() => {
                          const workspaceRef = workspaceRefForConv(conv);
                          if (!onOpenMemoryUpdate || !workspaceRef) return;
                          onOpenMemoryUpdate(workspaceRef, wsLabel, entry.message.memoryUpdate || null);
                        }}
                      />
                    );
                  }
                  const isEntryStreaming = streaming && streamingMsgId === entry.message.id;
                  const entryCliProfileId = entry.message.cliProfileId
                    || (isEntryStreaming ? state.composerCliProfileId : null)
                    || conv.cliProfileId
                    || null;
                  return (
                    <MessageBubble
                      key={entry.message.id}
                      message={entry.message}
                      cliProfileId={entryCliProfileId}
                      isStreaming={isEntryStreaming}
                      elapsedMs={elapsedByMsgId.get(entry.message.id)}
                      onPinToggle={toggleMessagePin}
                      setMessageRef={setMessageRef}
                      pinFocused={focusedPinId === entry.message.id}
                    />
                  );
                }
                if (entry.kind === 'final-with-progress') {
                  const isEntryStreaming = streaming && streamingMsgId === entry.message.id;
                  const entryCliProfileId = entry.message.cliProfileId
                    || (isEntryStreaming ? state.composerCliProfileId : null)
                    || conv.cliProfileId
                    || null;
                  return (
                    <MessageBubble
                      key={entry.message.id}
                      message={entry.message}
                      cliProfileId={entryCliProfileId}
                      isStreaming={isEntryStreaming}
                      attachedProgress={entry.progressRun}
                      elapsedMs={elapsedByMsgId.get(entry.message.id)}
                      onPinToggle={toggleMessagePin}
                      setMessageRef={setMessageRef}
                      pinFocused={focusedPinId === entry.message.id}
                    />
                  );
                }
                // progress-trailing
                return (
                  <ProgressBreadcrumbBubble
                    key={entry.progressRun[0].id}
                    progressRun={entry.progressRun}
                    cliProfileId={conv.cliProfileId || null}
                  />
                );
              })}
            </AgentIndexProvider>
            </FileViewerContext.Provider>
            {planModeActive && !pendingInteraction ? <PlanModeBanner/> : null}
            {pendingInteraction ? (
              <InteractionCard
                convId={convId}
                interaction={pendingInteraction}
                respondPending={!!respondPending}
              />
            ) : null}
            {streamError && (
              <StreamErrorCard
                convId={convId}
                error={streamError}
                source={activeStreamErrorSource}
                queueLength={queueLength}
                messages={messages}
              />
            )}
            {resetting ? <ResetProgressBubble/> : null}
          </div>
        </div>
        {showFeedBackToEnd ? (
          <button
            type="button"
            className="chat-back-to-end"
            onClick={() => scrollFeedToEnd()}
            aria-label="Back to end"
            title="Back to end"
          >
            {Ico.down(14)}
            <span>Back to end</span>
          </button>
        ) : null}
        {loadingAround ? (
          <div className="feed-page-status feed-page-status-floating" role="status" aria-live="polite">
            <span className="feed-page-spinner" aria-hidden="true"/>
            <span>Opening pinned message...</span>
          </div>
        ) : null}
      </div>

      <ChatComposer
        convId={convId}
        profileLocked={profileLocked}
        workspaceLabel={wsLabel}
        onOpenWorkspaceSettings={onOpenWorkspaceSettings}
        onOpenSettings={onOpenSettings}
      />
      {sessionsOpen ? (
        <React.Suspense fallback={null}>
          <SessionsModal
            open={true}
            convId={convId}
            currentSessionNumber={conv.sessionNumber || null}
            currentMessages={messageWindow && (messageWindow.hasOlder || messageWindow.hasNewer) ? null : messages}
            onClose={() => setSessionsOpen(false)}
          />
        </React.Suspense>
      ) : null}
      {fileViewer ? (
        <FileViewerPanel
          filename={fileViewer.filename}
          viewPath={fileViewer.viewPath}
          imageUrl={fileViewer.imageUrl}
          displayPath={fileViewer.displayPath || fileViewer.filename}
          line={fileViewer.line || null}
          onClose={closeFileViewer}
        />
      ) : null}
      {lightbox ? (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={closeLightbox}/>
      ) : null}
    </section>
  );
}
