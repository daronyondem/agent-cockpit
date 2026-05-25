import { useRef, useState } from 'react';
import type { AgentCockpitAPI } from './api';
import { formatDate, lastTwoPathComponents, type FileReference } from './appModel';
import { BackChevronIcon, CopyIcon, EyeIcon, LockIcon, MarkdownIcon, PinIcon, ShareIcon } from './mobileIcons';
import { Modal } from './mobilePrimitives';
import { AssistantIdentity, ContentBlockView, GoalEventView, MessageTextWithFiles } from './mobileChatScreen';
import type { BackendMetadata, Conversation, Message, SessionHistoryItem } from './types';

export function SessionsModal(props: {
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

export function ReadOnlySessionScreen(props: {
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
