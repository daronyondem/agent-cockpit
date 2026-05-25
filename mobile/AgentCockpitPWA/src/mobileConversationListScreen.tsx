import { useMemo } from 'react';
import {
  ALL_WORKSPACES,
  displayMessagePreview,
  formatDate,
  lastTwoPathComponents,
  userLabel,
  workspaceOptions,
  workspaceRef,
} from './appModel';
import { ChevronDownIcon, PlusIcon, ResetIcon } from './mobileIcons';
import { ErrorBanner } from './mobilePrimitives';
import type { ConversationListItem, CurrentUser } from './types';

export function ConversationListScreen(props: {
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
  onWorkspaceFilter: (workspaceId: string) => void;
  onOpenConversation: (id: string) => void;
  onNewConversation: (initialPath?: string) => void;
}) {
  const workspaces = useMemo(() => workspaceOptions(props.conversations), [props.conversations]);
  const visibleConversations = props.workspaceFilter === ALL_WORKSPACES
    ? props.conversations
    : props.conversations.filter((conversation) => workspaceRef(conversation) === props.workspaceFilter);
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
