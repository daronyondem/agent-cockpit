import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import {
  conversationListPatchForMessage,
  listStreamEventActions,
  type ListStreamEventAction,
  type StreamEventNotification,
} from './chatStreamEvents';
import { tryCreateWebSocket } from './appModel';
import type { AgentCockpitAPI } from './api';
import type { ConversationListItem, StreamEvent, ThreadGoal } from './types';

type UseListStreamMonitorOptions = {
  activeStreamIDs: Set<string>;
  clientRef: RefObject<AgentCockpitAPI>;
  enabled: boolean;
  setActiveStreamIDs: Dispatch<SetStateAction<Set<string>>>;
  setConversations: Dispatch<SetStateAction<ConversationListItem[]>>;
  applyGoalSnapshot: (conversationID: string, nextGoal: ThreadGoal | null) => boolean;
  refreshConversationList: () => Promise<void>;
  notify: (title: string, body: string) => void;
};

export function useListStreamMonitor(options: UseListStreamMonitorOptions) {
  const listStreamSocketsRef = useRef<Map<string, WebSocket>>(new Map());

  useEffect(() => {
    if (!options.enabled) {
      closeListStreamSockets();
      return;
    }
    syncListStreamSockets(options.activeStreamIDs);
  }, [options.enabled, options.activeStreamIDs]);

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
      const socket = tryCreateWebSocket(options.clientRef.current.websocketURL(conversationID));
      if (!socket) {
        continue;
      }
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
    for (const action of listStreamEventActions(event)) {
      applyListStreamAction(conversationID, action);
    }
  }

  function applyListStreamAction(conversationID: string, action: ListStreamEventAction) {
    switch (action.type) {
      case 'patch-conversation-message':
        options.setConversations((items) =>
          items.map((item) => (item.id === conversationID ? conversationListPatchForMessage(item, action.message) : item)),
        );
        break;
      case 'refresh-conversation-list':
        void options.refreshConversationList();
        break;
      case 'update-title':
        options.setConversations((items) => items.map((item) => (item.id === conversationID ? { ...item, title: action.title || item.title } : item)));
        break;
      case 'apply-goal-snapshot':
        options.applyGoalSnapshot(conversationID, action.goal);
        break;
      case 'mark-list-stream-finished':
        markListStreamFinished(conversationID);
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

  function markListStreamFinished(conversationID: string) {
    options.setActiveStreamIDs((current) => {
      const next = new Set(current);
      next.delete(conversationID);
      return next;
    });
    const socket = listStreamSocketsRef.current.get(conversationID);
    if (socket) {
      listStreamSocketsRef.current.delete(conversationID);
      socket.close();
    }
    void options.refreshConversationList();
  }

  return {
    closeListStreamSockets,
  };
}
