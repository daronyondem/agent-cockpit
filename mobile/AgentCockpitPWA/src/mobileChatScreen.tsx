import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { AgentCockpitAPI } from './api';
import {
  completedAttachmentMetas,
  displayMessagePreview,
  fileReferencesFromParsed,
  formatGoalElapsed,
  formatPercent,
  goalElapsedSeconds,
  goalStatusLabel,
  goalSupportsAction,
  isActiveGoal,
  isChatScrolledToEnd,
  isClaudeBackend,
  lastTwoPathComponents,
  makeConversationArtifactReference,
  makeConversationWorkspaceContextFileReference,
  opencodeProviderLabel,
  parseMessageFiles,
  profileForID,
  type CliProfileSummary,
  type FileReference,
} from './appModel';
import {
  BackChevronIcon,
  CopyIcon,
  DownArrowIcon,
  MarkdownIcon,
  MoreIcon,
  PaperclipIcon,
  PinIcon,
  SendIcon,
} from './mobileIcons';
import { Button, ErrorBanner, ProgressBar } from './mobilePrimitives';
import type {
  BackendMetadata,
  ContentBlock,
  Conversation,
  EffortLevel,
  Message,
  PendingAttachment,
  PendingInteraction,
  QueuedMessage,
  ServiceTier,
  ThreadGoal,
  Usage,
} from './types';

export function ChatScreen(props: {
  conversation: Conversation | null;
  backends: BackendMetadata[];
  cliProfiles: CliProfileSummary[];
  selectedCliProfileId?: string;
  draft: string;
  setDraft: (value: string) => void;
  streamText: string;
  showStreamPlaceholder: boolean;
  isStreaming: boolean;
  isSending: boolean;
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
  const transcriptAutoFollowRef = useRef(true);
  const transcriptStreamingRef = useRef(false);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pinFocusTimerRef = useRef<number | null>(null);
  const [pinStripIndex, setPinStripIndex] = useState(0);
  const [focusedPinID, setFocusedPinID] = useState<string | null>(null);
  const [showTranscriptBackToEnd, setShowTranscriptBackToEnd] = useState(false);
  const lastMessage = conversation?.messages[conversation.messages.length - 1];
  transcriptStreamingRef.current = props.isStreaming;
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

  function handleTranscriptScroll() {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    if (isChatScrolledToEnd(transcript)) {
      transcriptAutoFollowRef.current = true;
      setShowTranscriptBackToEnd(false);
      return;
    }
    transcriptAutoFollowRef.current = false;
    if (transcriptStreamingRef.current) setShowTranscriptBackToEnd(true);
  }

  function scrollTranscriptToEnd(behavior: ScrollBehavior = 'auto') {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcriptAutoFollowRef.current = true;
    setShowTranscriptBackToEnd(false);
    if (typeof transcript.scrollTo === 'function') {
      transcript.scrollTo({ top: transcript.scrollHeight, behavior });
    } else {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }

  useEffect(() => {
    transcriptAutoFollowRef.current = true;
    setShowTranscriptBackToEnd(false);
  }, [conversation?.id]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      return;
    }
    if (transcriptAutoFollowRef.current) {
      transcript.scrollTop = transcript.scrollHeight;
      setShowTranscriptBackToEnd(false);
    } else {
      setShowTranscriptBackToEnd(true);
    }
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
    props.isSending ||
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
      <MobilePinStrip
        messages={pinnedMessages}
        backends={props.backends}
        cliProfiles={props.cliProfiles}
        cliProfileId={conversation.cliProfileId || props.selectedCliProfileId}
        currentIndex={pinStripIndex}
        onSelect={jumpToPinnedMessage}
      />
      <div className="transcript-wrap">
        <div className="transcript" ref={transcriptRef} onScroll={handleTranscriptScroll}>
          {conversation.messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              conversation={conversation}
              client={props.client}
              backends={props.backends}
              cliProfiles={props.cliProfiles}
              focused={focusedPinID === message.id}
              messageRef={(node) => setMessageRef(message.id, node)}
              onTogglePin={(pinned) => props.onTogglePin(message.id, pinned)}
              onOpenFile={props.onOpenFile}
              onShareFile={props.onShareFile}
            />
          ))}
          {props.isStreaming && (props.streamText || props.showStreamPlaceholder) ? (
            <div className={`message assistant${props.streamText ? '' : ' stream-placeholder'}`}>
              <div className="message-heading">
                <AssistantIdentity
                  backend={conversation.backend}
                  backends={props.backends}
                  cliProfiles={props.cliProfiles}
                  cliProfileId={conversation.cliProfileId || props.selectedCliProfileId}
                />
              </div>
              {props.streamText ? (
                <MarkdownContent content={props.streamText} />
              ) : (
                <span className="streaming-dots" aria-label="Assistant is writing">
                  <span />
                  <span />
                  <span />
                </span>
              )}
              <span className="meta">Streaming...</span>
            </div>
          ) : null}
          {props.loading ? <div className="mini-spinner" /> : null}
        </div>
        {showTranscriptBackToEnd ? (
          <button
            className="mobile-back-to-end"
            type="button"
            aria-label="Back to end"
            onClick={() => scrollTranscriptToEnd()}
          >
            <DownArrowIcon />
            <span>Back to end</span>
          </button>
        ) : null}
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
  const clearDisabled = isClaudeBackend(props.goal.backend) && props.isStreaming;
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

export function GoalEventView(props: { message: Message }) {
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
  cliProfiles: CliProfileSummary[];
  cliProfileId?: string;
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
        <span className="pin-strip-source">
          {current.role === 'user' ? 'You' : cliDisplayName(props.backends, props.cliProfiles, current.backend, props.cliProfileId)}
        </span>
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

function cliDisplayName(
  backends: BackendMetadata[],
  cliProfiles: CliProfileSummary[] | undefined,
  backend?: string | null,
  cliProfileId?: string | null,
): string {
  if (!backend) {
    return 'Agent Cockpit';
  }
  if (backend === 'opencode') {
    const providerLabel = opencodeProviderLabel(profileForID(cliProfiles, cliProfileId)?.opencode?.provider);
    if (providerLabel) return providerLabel;
  }
  return backends.find((item) => item.id === backend)?.label || backend;
}

export function AssistantIdentity(props: {
  backend?: string | null;
  backends: BackendMetadata[];
  cliProfiles?: CliProfileSummary[];
  cliProfileId?: string | null;
}) {
  const icon = props.backend ? props.backends.find((item) => item.id === props.backend)?.icon : null;
  const provider = props.backend === 'opencode'
    ? String(profileForID(props.cliProfiles, props.cliProfileId)?.opencode?.provider || '').trim().toLowerCase()
    : '';
  const providerAvatar = provider === 'deepseek' || provider === 'ollama' || provider === 'opencode' ? provider : '';
  const label = cliDisplayName(props.backends, props.cliProfiles, props.backend, props.cliProfileId);
  return (
    <>
      {providerAvatar ? (
        <span className={`assistant-avatar provider-avatar provider-${providerAvatar}`} aria-hidden="true" />
      ) : icon ? (
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


function MessageBubble(props: {
  message: Message;
  conversation: Conversation;
  client: AgentCockpitAPI;
  backends: BackendMetadata[];
  cliProfiles: CliProfileSummary[];
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
          {isUser ? <strong>You</strong> : isGoalEvent ? <strong>Goal</strong> : (
            <AssistantIdentity
              backend={props.message.backend}
              backends={props.backends}
              cliProfiles={props.cliProfiles}
              cliProfileId={props.conversation.cliProfileId}
            />
          )}
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

export function ContentBlockView(props: {
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

export function MessageTextWithFiles(props: {
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
  const openMarkdownLink = (href: string): boolean => {
    const reference = makeConversationWorkspaceContextFileReference(props.client, props.conversation, href);
    if (!reference) return false;
    props.onOpenFile(reference);
    return true;
  };
  return (
    <div className="message-content">
      {parsed.text ? (
        renderAsMarkdown || props.thinking
          ? <MarkdownContent content={parsed.text} className={props.thinking ? 'thinking' : undefined} onOpenLink={openMarkdownLink} />
          : <p className="plain-text">{parsed.text}</p>
      ) : null}
      {references.map((reference) => (
        <FileCard key={reference.id} reference={reference} onOpen={props.onOpenFile} onShare={props.onShareFile} />
      ))}
    </div>
  );
}

function MarkdownContent(props: { content: string; className?: string; onOpenLink?: (href: string) => boolean }) {
  const html = useMemo(() => renderMarkdown(props.content), [props.content]);
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!props.onOpenLink) return;
    const target = event.target as HTMLElement | null;
    const link = target?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!link) return;
    if (props.onOpenLink(link.getAttribute('href') || '')) {
      event.preventDefault();
    }
  };
  return (
    <div
      className={['markdown-body', props.className].filter(Boolean).join(' ')}
      onClick={onClick}
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
  const reportedCost = Number(usage.costUsd) || 0;
  const estimatedCost = Number(usage.estimatedCostUsd) || 0;
  const estimatedCostLabel = estimatedCost > 0 ? `$${Math.ceil(estimatedCost).toLocaleString()}` : '$0';
  return (
    <div className="usage-bar">
      <div>
        <span className="usage-label">Tokens</span>
        <span className="usage-value">{tokens.toLocaleString()}</span>
        <span className="usage-track"><i style={{ width: `${Math.min(100, Math.max(4, context))}%` }} /></span>
      </div>
      <div>
        <span className="usage-label">Cost</span>
        <span className="usage-value">${reportedCost.toFixed(4)}</span>
        <span className="usage-track"><i style={{ width: `${reportedCost > 0 ? 18 : 4}%` }} /></span>
      </div>
      <div>
        <span className="usage-label">Estimated Cost</span>
        <span className="usage-value">{estimatedCostLabel}</span>
        <span className="usage-track"><i style={{ width: `${estimatedCost > 0 ? 18 : 4}%` }} /></span>
      </div>
      <div>
        <span className="usage-label">Context</span>
        <span className="usage-value">{usage.contextUsagePercentage !== undefined ? formatPercent(usage.contextUsagePercentage) : 'n/a'}</span>
        <span className="usage-track"><i style={{ width: `${Math.min(100, Math.max(4, context))}%` }} /></span>
      </div>
    </div>
  );
}
