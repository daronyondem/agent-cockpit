import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import {
  chatStreamEventActions,
  type ChatStreamEventAction,
  type StreamEventNotification,
} from './chatStreamEvents';
import {
  streamReconnectDelayMs,
  tryCreateWebSocket,
  upsertMessage,
} from './appModel';
import { useVisibleStreamResume } from './useMobileLifecycle';
import type { AgentCockpitAPI } from './api';
import type { Conversation, ConversationListItem, PendingInteraction, StreamEvent, ThreadGoal } from './types';

type UseChatStreamConnectionOptions = {
  activeConversationRef: RefObject<Conversation | null>;
  clientRef: RefObject<AgentCockpitAPI>;
  setActiveConversation: Dispatch<SetStateAction<Conversation | null>>;
  setActiveStreamIDs: Dispatch<SetStateAction<Set<string>>>;
  setConversations: Dispatch<SetStateAction<ConversationListItem[]>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setPendingInteraction: Dispatch<SetStateAction<PendingInteraction | null>>;
  applyGoalSnapshot: (conversationID: string, nextGoal: ThreadGoal | null) => boolean;
  refreshAfterStream: (conversationID: string) => Promise<void>;
  notify: (title: string, body: string) => void;
};

export function useChatStreamConnection(options: UseChatStreamConnectionOptions) {
  const socketRef = useRef<WebSocket | null>(null);
  const streamReconnectTimerRef = useRef<number | null>(null);
  const streamReconnectAttemptsRef = useRef(0);
  const isStreamingRef = useRef(false);
  const resumeStreamConnectionRef = useRef<(conversationID: string, force?: boolean) => Promise<void> | void>(() => undefined);
  const [streamText, setStreamText] = useState('');
  const [showStreamPlaceholder, setShowStreamPlaceholder] = useState(false);
  const [isStreaming, setIsStreamingState] = useState(false);

  resumeStreamConnectionRef.current = resumeStreamConnection;

  useVisibleStreamResume(() => {
    const conversationID = options.activeConversationRef.current?.id;
    if (conversationID && isStreamingRef.current) {
      void resumeStreamConnectionRef.current(conversationID, true);
    }
  });

  function setIsStreaming(value: boolean) {
    setIsStreamingState(value);
    isStreamingRef.current = value;
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
    options.setActiveStreamIDs((current) => new Set(current).add(conversationID));
    const socket = tryCreateWebSocket(options.clientRef.current.websocketURL(conversationID));
    if (!socket) {
      scheduleStreamReconnect(conversationID);
      return;
    }
    socketRef.current = socket;
    socket.onopen = () => {
      clearStreamReconnectTimer();
      streamReconnectAttemptsRef.current = 0;
      options.setErrorMessage((current) => (current === 'Stream connection failed.' ? null : current));
      socket.send(JSON.stringify({ type: 'reconnect' }));
    };
    socket.onmessage = (event) => {
      try {
        handleStreamEvent(conversationID, JSON.parse(event.data) as StreamEvent);
      } catch {
        options.setErrorMessage('The stream returned an invalid event.');
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
    if (!isStreamingRef.current || options.activeConversationRef.current?.id !== conversationID || streamReconnectTimerRef.current !== null) {
      return;
    }
    const attempts = streamReconnectAttemptsRef.current;
    const delay = streamReconnectDelayMs(attempts);
    streamReconnectTimerRef.current = window.setTimeout(() => {
      streamReconnectTimerRef.current = null;
      streamReconnectAttemptsRef.current = attempts + 1;
      void resumeStreamConnectionRef.current(conversationID);
    }, delay);
  }

  async function resumeStreamConnection(conversationID: string, force = false) {
    if (!isStreamingRef.current || options.activeConversationRef.current?.id !== conversationID) {
      return;
    }
    const currentSocket = socketRef.current;
    if (!force && currentSocket && (currentSocket.readyState === WebSocket.OPEN || currentSocket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      const streamIDs = await options.clientRef.current.getActiveStreams();
      options.setActiveStreamIDs(streamIDs);
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
      setShowStreamPlaceholder(false);
      closeStreamSocket();
      await options.refreshAfterStream(conversationID);
    } catch {
      scheduleStreamReconnect(conversationID);
    }
  }

  async function recoverActiveStream(conversationID: string, optionsArg: { onlyIfServerActive?: boolean } = {}): Promise<boolean> {
    try {
      const streamIDs = await options.clientRef.current.getActiveStreams();
      options.setActiveStreamIDs(streamIDs);
      if (streamIDs.has(conversationID)) {
        options.setErrorMessage(null);
        startStream(conversationID);
        return true;
      }
      if (!optionsArg.onlyIfServerActive) {
        await options.refreshAfterStream(conversationID);
      }
      return false;
    } catch {
      if (optionsArg.onlyIfServerActive) {
        return false;
      }
      options.setErrorMessage(null);
      startStream(conversationID);
      return true;
    }
  }

  function handleStreamEvent(conversationID: string, event: StreamEvent) {
    for (const action of chatStreamEventActions(event)) {
      applyChatStreamAction(conversationID, action);
    }
  }

  function applyChatStreamAction(conversationID: string, action: ChatStreamEventAction) {
    switch (action.type) {
      case 'set-stream-placeholder':
        setShowStreamPlaceholder(action.value);
        break;
      case 'append-stream-text':
        setStreamText((current) => current + action.content);
        break;
      case 'set-stream-text':
        setStreamText(action.value);
        break;
      case 'upsert-message':
        options.setActiveConversation((current) =>
          current && current.id === conversationID ? { ...current, messages: upsertMessage(current.messages, action.message) } : current,
        );
        break;
      case 'set-pending-interaction':
        options.setPendingInteraction(action.interaction);
        break;
      case 'update-title':
        options.setActiveConversation((current) => (current && current.id === conversationID ? { ...current, title: action.title || current.title } : current));
        options.setConversations((items) => items.map((item) => (item.id === conversationID ? { ...item, title: action.title || item.title } : item)));
        break;
      case 'update-usage':
        options.setActiveConversation((current) =>
          current && current.id === conversationID ? { ...current, usage: action.usage, sessionUsage: action.sessionUsage || current.sessionUsage } : current,
        );
        break;
      case 'apply-goal-snapshot':
        options.applyGoalSnapshot(conversationID, action.goal);
        break;
      case 'set-error':
        options.setErrorMessage(action.message);
        break;
      case 'mark-stream-finished':
        markStreamFinished(conversationID);
        break;
      case 'refresh-after-stream':
        void options.refreshAfterStream(conversationID);
        break;
      case 'notify':
        notify(action.notification);
        break;
      default:
        break;
    }
  }

  function notify(notification: StreamEventNotification) {
    options.notify(notification.title, notification.body);
  }

  function markStreamFinished(conversationID: string) {
    clearStreamReconnectTimer();
    streamReconnectAttemptsRef.current = 0;
    setIsStreaming(false);
    setShowStreamPlaceholder(false);
    options.setActiveStreamIDs((current) => {
      const next = new Set(current);
      next.delete(conversationID);
      return next;
    });
    closeStreamSocket();
  }

  return {
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
  };
}
