import { useState, type RefObject } from 'react';
import { updateSessionsAfterReset } from './appModel';
import type { AgentCockpitAPI } from './api';
import type { Conversation, Message, ResetSessionResponse, SessionHistoryItem } from './types';

export type SessionViewerState = { session: SessionHistoryItem; messages: Message[] };

type UseSessionHistoryOptions = {
  clientRef: RefObject<AgentCockpitAPI>;
  getActiveConversation: () => Conversation | null;
  onError: (error: unknown) => void;
};

export function useSessionHistory(options: UseSessionHistoryOptions) {
  const [sessionsVisible, setSessionsVisible] = useState(false);
  const [sessions, setSessions] = useState<SessionHistoryItem[]>([]);
  const [sessionViewer, setSessionViewer] = useState<SessionViewerState | null>(null);

  async function openSessions() {
    const conversation = options.getActiveConversation();
    if (!conversation) {
      return;
    }
    try {
      const loaded = await options.clientRef.current.getSessions(conversation.id);
      setSessions(loaded);
      setSessionViewer(null);
      setSessionsVisible(true);
    } catch (error) {
      options.onError(error);
    }
  }

  async function viewSession(session: SessionHistoryItem) {
    const conversation = options.getActiveConversation();
    if (!conversation) {
      return;
    }
    try {
      let messages: Message[];
      if (session.isCurrent) {
        messages = conversation.messages;
      } else {
        const response = await options.clientRef.current.getSessionMessages(conversation.id, session.number);
        messages = response.messages || [];
      }
      setSessionViewer({ session, messages });
      setSessionsVisible(false);
    } catch (error) {
      options.onError(error);
    }
  }

  function applySessionReset(response: ResetSessionResponse) {
    setSessions((current) => (
      current.length
        ? updateSessionsAfterReset(current, response)
        : current
    ));
    setSessionViewer(null);
  }

  function closeSessions() {
    setSessionsVisible(false);
  }

  function closeSessionSurfaces() {
    setSessionsVisible(false);
    setSessionViewer(null);
  }

  function backToSessions() {
    setSessionViewer(null);
    setSessionsVisible(true);
  }

  return {
    sessionsVisible,
    sessions,
    sessionViewer,
    openSessions,
    viewSession,
    applySessionReset,
    closeSessions,
    closeSessionSurfaces,
    backToSessions,
  };
}
