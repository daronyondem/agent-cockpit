import React from 'react';

import { Ico } from '../icons.jsx';
import { StreamStore } from '../streamStore.js';
import { msgTime } from './chatTime.js';
import { renderMarkdown } from './messageContent.jsx';

export function PlanModeBanner(){
  return (
    <div className="plan-mode-banner">
      <span className="plan-mode-icon" aria-hidden="true">📋</span>
      <span>Planning mode — gathering context; no changes will be made yet.</span>
    </div>
  );
}

export function StreamErrorCard({ convId, error, source, queueLength, messages }){
  const lastUser = React.useMemo(() => {
    const arr = Array.isArray(messages) ? messages : [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && arr[i].role === 'user') return arr[i];
    }
    return null;
  }, [messages]);
  const isAbort = source === 'abort' || error === 'Aborted by user';
  const canRetry = !isAbort && !!(lastUser && typeof lastUser.content === 'string' && lastUser.content);

  function onRetry(){
    if (!canRetry) return;
    StreamStore.clearStreamError(convId);
    StreamStore.send(convId, lastUser.content).catch(() => {});
  }
  const title = isAbort ? 'Operation aborted' : 'Stream error';
  const detail = isAbort ? 'Aborted by user' : error;
  const body = isAbort
    ? `The operation was stopped. ${queueLength ? `${queueLength} queued message${queueLength === 1 ? '' : 's'} ${queueLength === 1 ? 'is' : 'are'} paused until you resume.` : 'Dismiss this notice to keep working.'}`
    : `The stream was interrupted. ${queueLength ? `${queueLength} queued message${queueLength === 1 ? '' : 's'} ${queueLength === 1 ? 'is' : 'are'} paused until you resume.` : 'No messages are queued — dismiss this notice to keep working.'}`;

  return (
    <div className={`err-card ${isAbort ? 'err-card-abort' : ''}`}>
      <div className="err-head">
        <span className="dot" style={{background: isAbort ? "var(--status-awaiting)" : "var(--status-error)"}}/>
        {title}
        <span className="spacer" style={{flex:1}}/>
        <span className="u-mono u-dim" style={{fontSize:10.5}}>{detail}</span>
      </div>
      <div className="prose" style={{fontFamily:"var(--prose-font)",fontSize:15,lineHeight:1.55}}>
        <p>{body}</p>
      </div>
      <div className="err-actions">
        <span className="spacer" style={{flex:1}}/>
        <button className="btn ghost" onClick={() => StreamStore.clearStreamError(convId)}>Dismiss</button>
        {canRetry ? (
          <button className="btn ghost" onClick={onRetry}>Retry</button>
        ) : null}
        {queueLength ? (
          <button className="btn" onClick={() => StreamStore.clearStreamError(convId, { resumeQueue: true })}>
            Resume queue
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function MemoryUpdateBubble({ message, onOpen }){
  const mu = message.memoryUpdate || { changedFiles: [], fileCount: 0, capturedAt: message.timestamp };
  const changed = Array.isArray(mu.changedFiles) ? mu.changedFiles : [];
  const outcomes = Array.isArray(mu.writeOutcomes) ? mu.writeOutcomes : [];
  const skipped = outcomes.filter(o => o && String(o.action || '').startsWith('skipped_'));
  const [expanded, setExpanded] = React.useState(false);
  const headline = (() => {
    if (outcomes.length && changed.length === 0 && skipped.length === outcomes.length) {
      return `Memory note skipped: ${formatMemoryOutcomeAction(skipped[0].action)}`;
    }
    if (outcomes.length) return `Memory updated: ${outcomes.length} decision${outcomes.length === 1 ? '' : 's'}`;
    if (changed.length === 0) return `Memory snapshot refreshed (${mu.fileCount} file${mu.fileCount === 1 ? '' : 's'})`;
    return `Memory updated: ${changed.length} file${changed.length === 1 ? '' : 's'} changed`;
  })();
  const preview = outcomes.length ? outcomes.slice(0, 5) : changed.slice(0, 5);
  const extra = Math.max(0, (outcomes.length || changed.length) - preview.length);
  return (
    <div className="msg msg-memory">
      <span className="avatar avatar-memory" aria-hidden="true">{Ico.moon(14)}</span>
      <div className="body">
        <div className="head">
          <span className="who">Memory</span>
          <span>·</span>
          <span>{msgTime(mu.capturedAt)}</span>
        </div>
        <div className="memory-card">
          <button
            type="button"
            className="memory-summary"
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
          >
            <span className={"memory-caret" + (expanded ? ' open' : '')}>▸</span>
            <span className="memory-headline">{headline}</span>
          </button>
          {expanded && outcomes.length > 0 ? (
            <ul className="memory-files">
              {preview.map((o, idx) => (
                <li key={`${o.action || 'outcome'}_${idx}`}>
                  <span>{formatMemoryOutcomeAction(o.action)}</span>
                  {o.filename ? <span className="u-mono"> · {o.filename}</span> : null}
                  {o.duplicateOf ? <span className="u-mono"> · {o.duplicateOf}</span> : null}
                  {o.reason ? <div className="u-dim">{o.reason}</div> : null}
                </li>
              ))}
              {extra > 0 ? <li className="u-dim">+{extra} more</li> : null}
            </ul>
          ) : expanded && changed.length > 0 ? (
            <ul className="memory-files">
              {preview.map(f => (<li key={f} className="u-mono">{f}</li>))}
              {extra > 0 ? <li className="u-dim">+{extra} more</li> : null}
            </ul>
          ) : null}
          <button type="button" className="btn memory-cta" onClick={onOpen}>
            View update →
          </button>
        </div>
      </div>
    </div>
  );
}

function formatMemoryOutcomeAction(action){
  switch (action) {
    case 'saved': return 'Saved';
    case 'redacted_saved': return 'Saved with redaction';
    case 'superseded_saved': return 'Saved and superseded older memory';
    case 'skipped_duplicate': return 'Skipped duplicate';
    case 'skipped_ephemeral': return 'Skipped ephemeral';
    default: return 'Memory decision';
  }
}

export function InteractionCard({ convId, interaction, respondPending }){
  if (!interaction) return null;
  if (interaction.type === 'planApproval') {
    return <PlanApprovalCard convId={convId} planContent={interaction.planContent} respondPending={respondPending}/>;
  }
  if (interaction.type === 'userQuestion') {
    return <QuestionCard convId={convId} question={interaction.question} options={interaction.options} respondPending={respondPending}/>;
  }
  return null;
}

const AWAITING_CHIP_STYLE = {
  fontFamily: "var(--mono-font)", fontSize: 10, letterSpacing: ".1em",
  padding: "2px 7px", borderRadius: 4,
  border: "1px solid color-mix(in oklch, var(--status-awaiting), transparent 70%)",
  background: "color-mix(in oklch, var(--status-awaiting), transparent 92%)",
  marginLeft: 8,
};
const AWAITING_DOT_STYLE = {
  width: 6, height: 6, borderRadius: 999,
  background: "var(--status-awaiting)",
  boxShadow: "0 0 0 3px color-mix(in oklch, var(--status-awaiting), transparent 80%)",
};

function PlanApprovalCard({ convId, planContent, respondPending }){
  const html = planContent ? renderMarkdown(planContent) : '';
  return (
    <div className="plan" role="group" aria-label="Plan approval">
      <div className="plan-head">
        <span style={AWAITING_DOT_STYLE}/>
        Plan
        <span className="u-warn" style={AWAITING_CHIP_STYLE}>NEEDS YOU</span>
        <span className="spacer" style={{flex:1}}/>
      </div>
      {html ? (
        <div className="prose" dangerouslySetInnerHTML={{ __html: html }}/>
      ) : (
        <div className="u-dim" style={{fontSize:13}}>No plan content.</div>
      )}
      <div className="plan-actions">
        <span className="spacer" style={{flex:1}}/>
        <button
          className="btn danger"
          disabled={respondPending}
          onClick={() => StreamStore.respond(convId, 'no')}
        >Reject</button>
        <button
          className="btn primary"
          disabled={respondPending}
          onClick={() => StreamStore.respond(convId, 'yes')}
        >{respondPending ? 'Sending…' : 'Approve & run'}</button>
      </div>
    </div>
  );
}

function QuestionCard({ convId, question, options, respondPending }){
  const [text, setText] = React.useState('');
  const inputRef = React.useRef(null);
  React.useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
  const canSubmit = !!text.trim() && !respondPending;
  function submit(){
    if (!canSubmit) return;
    StreamStore.respond(convId, text.trim());
  }
  function pick(label){
    setText(label);
    if (inputRef.current) inputRef.current.focus();
  }
  const opts = Array.isArray(options) ? options : [];
  return (
    <div className="plan" role="group" aria-label="Clarifying question" style={{borderTopColor:"var(--accent)"}}>
      <div className="plan-head" style={{color:"var(--accent)"}}>
        <span style={{...AWAITING_DOT_STYLE, background:"var(--accent)", boxShadow:"none"}}/>
        Clarifying question
        <span className="spacer" style={{flex:1}}/>
      </div>
      <div className="plan-title" style={{fontSize:16}}>{question}</div>
      {opts.length > 0 ? (
        <div style={{display:"flex",flexWrap:"wrap",gap:6,margin:"4px 0 10px"}}>
          {opts.map((o, i) => {
            const label = typeof o === 'string' ? o : (o && o.label) || '';
            const desc = typeof o === 'string' ? '' : (o && o.description) || '';
            return (
              <button
                key={i}
                type="button"
                className="btn"
                disabled={respondPending}
                onClick={() => pick(label)}
                title={desc}
              >{label}</button>
            );
          })}
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        placeholder="Type your answer…"
        disabled={respondPending}
        style={{
          width:"100%",
          padding:"8px 10px",
          border:"1px solid var(--border)",
          borderRadius:"var(--r-sm)",
          background:"var(--surface-2)",
          color:"var(--text)",
          fontFamily:"inherit",
          fontSize:14,
          outline:"none",
        }}
      />
      <div className="plan-actions">
        <span className="spacer" style={{flex:1}}/>
        <button
          className="btn primary"
          disabled={!canSubmit}
          onClick={submit}
        >{respondPending ? 'Sending…' : 'Send'}</button>
      </div>
    </div>
  );
}
