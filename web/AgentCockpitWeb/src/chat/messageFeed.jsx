import React from 'react';

import { Ico } from '../icons.jsx';
import { AssistantAvatar, useAssistantDisplayName } from '../shellState.jsx';
import { Tip } from '../tooltip.jsx';
import { goalStatusLabel } from '../goalState.js';
import { formatMsgElapsed, msgTime } from './chatTime.js';
import { extractFileDeliveries, extractUploadedFiles } from './messageParsing';
import {
  deriveBlocks,
  groupBlocksForRender,
  shouldShowProcessing,
} from './messageModel.js';
import {
  messageAuthorLabel,
  messageAvatarBackend,
  pinMessageSourceLabel,
} from './messageIdentity.js';
import {
  GeneratedArtifact,
  TextSegment,
  ThinkingBlock,
  UserMessageBody,
} from './messageContent.jsx';
import { ToolRun } from './toolRuns.jsx';

export function PinStrip({ messages, currentIndex, onSelect }){
  if (!messages.length) return null;
  const safeIndex = Math.min(Math.max(currentIndex || 0, 0), messages.length - 1);
  const active = messages[safeIndex];
  const go = (index) => {
    const next = messages[index];
    if (!next) return;
    onSelect(next.id, index);
  };
  const prevIndex = (safeIndex - 1 + messages.length) % messages.length;
  const nextIndex = (safeIndex + 1) % messages.length;
  const jumpIndex = messages.length > 1 ? nextIndex : safeIndex;
  return (
    <div className="pin-strip" aria-label="Pinned messages">
      <button
        type="button"
        className="pin-strip-label"
        onClick={() => go(jumpIndex)}
        title={messages.length > 1 ? 'Jump to next pinned message' : 'Jump to pinned message'}
      >
        <span className="pin-strip-icon">{Ico.pin(13)}</span>
        <span>PINNED</span>
        <span className="pin-strip-count">{messages.length}</span>
      </button>
      <button
        type="button"
        className="pin-strip-item"
        onClick={() => go(jumpIndex)}
        title={messages.length > 1 ? 'Jump to next pinned message' : 'Jump to pinned message'}
      >
        <span className="pin-strip-src">{pinMessageSource(active)}</span>
        <span>{pinMessagePreview(active)}</span>
      </button>
      <div className="pin-strip-nav" aria-label="Pinned message navigation">
        <button type="button" onClick={() => go(prevIndex)} aria-label="Previous pinned message" title="Previous pinned message">
          {Ico.chevU(13)}
        </button>
        <span className="pin-strip-dots" aria-hidden="true">
          {messages.map((message, index) => (
            <i key={message.id} className={index === safeIndex ? 'active' : ''}/>
          ))}
        </span>
        <button type="button" onClick={() => go(nextIndex)} aria-label="Next pinned message" title="Next pinned message">
          {Ico.chevD(13)}
        </button>
      </div>
    </div>
  );
}

function pinMessageSource(message){
  return pinMessageSourceLabel(message);
}

function pinMessagePreview(message){
  const raw = (message && message.content) || '';
  const delivered = extractFileDeliveries(raw).cleaned;
  const uploaded = extractUploadedFiles(delivered).cleaned;
  return uploaded.replace(/\s+/g, ' ').trim() || 'Pinned message';
}

function PinnedTag(){
  return (
    <span className="msg-pin-tag" title="Pinned message">
      <span className="msg-pin-tag-icon">{Ico.up(9)}</span>
      <span>PINNED</span>
    </span>
  );
}

function goalEventTitle(event){
  if (!event) return 'Goal updated';
  if (event.kind === 'set') return 'Goal set';
  if (event.kind === 'resumed') return 'Goal resumed';
  if (event.kind === 'paused') return 'Goal paused';
  if (event.kind === 'achieved') return 'Goal achieved';
  if (event.kind === 'budget_limited') return 'Goal budget limited';
  if (event.kind === 'cleared') return 'Goal cleared';
  return goalStatusLabel(event.status || 'unknown');
}

function GoalEventCard({ message }){
  const event = message.goalEvent || {};
  const objective = event.objective || (event.goal && event.goal.objective) || '';
  const reason = event.reason || (event.goal && event.goal.lastReason) || '';
  const backend = event.backend || message.backend || '';
  const kind = String(event.kind || event.status || 'updated').replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <div className={"goal-event-card kind-" + kind}>
      <div className="goal-event-row">
        <span className="goal-event-title">{goalEventTitle(event)}</span>
        {backend ? <span className="goal-event-backend">{backend}</span> : null}
      </div>
      {objective ? <div className="goal-event-objective">{objective}</div> : null}
      {reason ? <div className="goal-event-reason">{reason}</div> : null}
    </div>
  );
}

export const MessageBubble = React.memo(function MessageBubble({ message, cliProfileId, isStreaming, attachedProgress, elapsedMs, onPinToggle, setMessageRef, pinFocused }){
  const isUser = message.role === 'user';
  const isGoalEvent = !!message.goalEvent;
  const assistantName = useAssistantDisplayName(message.backend, cliProfileId);
  const authorName = messageAuthorLabel(message, assistantName);
  const avatarBackend = messageAvatarBackend(message);
  const contentRef = React.useRef(null);
  const [copied, setCopied] = React.useState(null);
  const hasContent = !!(message.content && message.content.trim());
  const isPinned = !!message.pinned;
  const messageRef = React.useCallback((node) => {
    if (setMessageRef) setMessageRef(message.id, node);
  }, [message.id, setMessageRef]);

  function copy(mode){
    let text;
    if (mode === 'md') {
      text = message.content || '';
    } else {
      const el = contentRef.current;
      text = el ? (el.textContent || '') : (message.content || '');
    }
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(mode);
      setTimeout(() => setCopied(null), 1500);
    }).catch(() => {});
  }

  const showActions = !isStreaming && !!message.id && (hasContent || !!(message.contentBlocks && message.contentBlocks.length) || !!message.streamError);
  const rootClass = [
    'msg',
    isUser ? 'msg-user' : 'msg-agent',
    isGoalEvent ? 'msg-goal-event' : '',
    message.streamError ? 'msg-stream-error' : '',
    isPinned ? 'msg-pinned' : '',
    pinFocused ? 'msg-pin-focus' : '',
  ].filter(Boolean).join(' ');

  return (
    <div ref={messageRef} className={rootClass}>
      {isUser ? (
        <span className="avatar">DY</span>
      ) : (
        <AssistantAvatar backend={avatarBackend} cliProfileId={cliProfileId}/>
      )}
      <div className="body">
        {isUser ? (
          <div>
            {isPinned ? <div className="msg-pin-row"><PinnedTag/></div> : null}
            <div ref={contentRef}>
              <UserMessageBody content={message.content || ''}/>
            </div>
          </div>
        ) : (
          <>
            <div className="head">
              <span className="who">{authorName}</span>
              <span>·</span>
              <span>{isStreaming ? 'streaming…' : msgTime(message.timestamp)}</span>
              {isPinned ? <PinnedTag/> : null}
              {elapsedMs != null && !isStreaming ? (
                <span className="msg-elapsed" title="Time since the previous user message">{formatMsgElapsed(elapsedMs)}</span>
              ) : null}
            </div>
            {!isGoalEvent && attachedProgress && attachedProgress.length ? (
              <ProgressBreadcrumb progressRun={attachedProgress}/>
            ) : null}
            <div ref={contentRef}>
              {isGoalEvent ? <GoalEventCard message={message}/> : <AssistantBody message={message} isStreaming={isStreaming}/>}
            </div>
          </>
        )}
      </div>
      {showActions ? (
        <div className="msg-actions" role="toolbar" aria-label="Message actions">
          <Tip content={copied === 'msg' ? 'Copied' : 'Copy'} delay={120}>
            <button
              type="button"
              className="msg-action"
              onClick={() => copy('msg')}
              aria-label={copied === 'msg' ? 'Copied message' : 'Copy message'}
            >
              {Ico.copy(14)}
            </button>
          </Tip>
          <Tip content={copied === 'md' ? 'Copied Markdown' : 'Copy Markdown'} delay={120}>
            <button
              type="button"
              className="msg-action"
              onClick={() => copy('md')}
              aria-label={copied === 'md' ? 'Copied markdown' : 'Copy raw markdown'}
            >
              {Ico.markdown(16)}
            </button>
          </Tip>
          <Tip content={isPinned ? 'Unpin' : 'Pin'} delay={120}>
            <button
              type="button"
              className={`msg-action msg-action-pin ${isPinned ? 'pinned' : ''}`}
              onClick={() => onPinToggle && onPinToggle(message)}
              aria-label={isPinned ? 'Unpin message' : 'Pin message'}
              aria-pressed={isPinned}
            >
              {Ico.pin(14)}
            </button>
          </Tip>
        </div>
      ) : null}
    </div>
  );
});

export const ProgressBreadcrumbBubble = React.memo(function ProgressBreadcrumbBubble({ progressRun, cliProfileId }){
  const firstBackend = (progressRun && progressRun[0] && progressRun[0].backend) || null;
  return (
    <div className="msg msg-agent">
      <AssistantAvatar backend={firstBackend} cliProfileId={cliProfileId}/>
      <div className="body">
        <div className="head">
          <span className="who">progress</span>
          <span>·</span>
          <span>{progressRun.length} segment{progressRun.length !== 1 ? 's' : ''}</span>
        </div>
        <ProgressBreadcrumb progressRun={progressRun}/>
      </div>
    </div>
  );
});

export function ResetProgressBubble(){
  return (
    <div className="msg msg-agent">
      <AssistantAvatar backend={null}/>
      <div className="body">
        <div className="head">
          <span className="who">Agent Cockpit</span>
        </div>
        <div className="reset-progress">
          <span className="typing-dots" aria-hidden="true">
            <span className="typing-dot"/>
            <span className="typing-dot"/>
            <span className="typing-dot"/>
          </span>
          <span>Archiving session…</span>
        </div>
      </div>
    </div>
  );
}

function ProgressBreadcrumb({ progressRun }){
  const [open, setOpen] = React.useState(false);
  const count = progressRun.length;
  let preview = '';
  for (const m of progressRun) {
    const blocks = deriveBlocks(m);
    const textBlock = blocks.find(b => b.type === 'text' && b.content);
    if (textBlock) {
      preview = textBlock.content.trim().split('\n')[0].slice(0, 80);
      if (preview) break;
    }
  }
  return (
    <div className="progress-breadcrumb">
      <button
        type="button"
        className="progress-head"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <span className="marker"/>
        <span className="label">
          {count} segment{count !== 1 ? 's' : ''}
          {preview ? <> · <span className="preview">{preview}</span></> : null}
        </span>
        <span className="chev" style={{transform: open ? 'rotate(180deg)' : undefined}}>
          {Ico.chev(12)}
        </span>
      </button>
      {open ? (
        <div className="progress-body">
          {progressRun.map((m, i) => (
            <div key={m.id || i} className="progress-row">
              <AssistantBody message={m}/>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AssistantBody({ message, isStreaming }){
  const blocks = deriveBlocks(message);
  if (blocks.length === 0) {
    if (isStreaming) {
      return <div className="prose" style={{opacity:.6}}>…</div>;
    }
    return null;
  }
  const segments = groupBlocksForRender(blocks);
  const showProcessing = isStreaming && shouldShowProcessing(blocks);
  return (
    <>
      {segments.map((seg, i) => renderSegment(seg, i))}
      {showProcessing ? <ProcessingIndicator/> : null}
    </>
  );
}

function ProcessingIndicator(){
  return (
    <div className="processing-indicator">
      <span className="typing-dots" aria-hidden="true">
        <span className="typing-dot"/>
        <span className="typing-dot"/>
        <span className="typing-dot"/>
      </span>
      <span>Processing…</span>
    </div>
  );
}

function renderSegment(seg, key){
  if (seg.kind === 'text') {
    return <TextSegment key={key} content={seg.content}/>;
  }
  if (seg.kind === 'thinking') {
    return <ThinkingBlock key={key} content={seg.content}/>;
  }
  if (seg.kind === 'tool-run') {
    return <ToolRun key={key} tools={seg.tools}/>;
  }
  if (seg.kind === 'artifact') {
    return <GeneratedArtifact key={key} artifact={seg.artifact}/>;
  }
  return null;
}
