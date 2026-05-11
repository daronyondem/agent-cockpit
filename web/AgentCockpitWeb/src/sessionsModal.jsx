import React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Ico } from './icons.jsx';
import { AgentApi } from './api.js';
import { useDialog } from './dialog.jsx';

/* ---------- SessionsModal — Session history browser for a conversation. ---------- */
/* Triggered from the Sessions button in the chat topbar (next to Download /
   Reset). Mirrors V1's chatShowSessions / chatViewSession: a two-view modal
   that starts on the session list and flips into a read-only message viewer
   when the user clicks "View" on a row. Download buttons delegate to the
   browser via window.open() pointed at the `/sessions/:num/download` route
   (server returns markdown with Content-Disposition: attachment).

   Reuses FolderPicker's `.fp-scrim` / `.fp-panel` shell. The detail view
   renders each past message with a role label and sanitised markdown body —
   no full MessageBubble parity (no tool activity / thinking / streaming), as
   this is a read-only history browser, not a live chat. */

/* Simple markdown→sanitised-HTML — matches the helper used by shell.jsx and
   the KB/Files browsers. Keeping a local copy so the modal is self-contained. */
function sessionRenderMd(md){
  const raw = marked.parse(String(md || ''), { breaks: true, gfm: true });
  return DOMPurify.sanitize(raw);
}

export function SessionsModal({ open, convId, currentSessionNumber = null, currentMessages = null, onClose }){
  const [view, setView] = React.useState('list'); // 'list' | 'detail'
  const [sessions, setSessions] = React.useState(null); // null = loading, [] = empty
  const [listError, setListError] = React.useState(null);
  const [activeSession, setActiveSession] = React.useState(null); // { number, startedAt, endedAt, messageCount } | null
  const [detailMessages, setDetailMessages] = React.useState(null);
  const [detailError, setDetailError] = React.useState(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const dialog = useDialog();

  /* Load the session list whenever the modal opens. Resets detail state so a
     second open doesn't briefly flash the previous detail view. */
  React.useEffect(() => {
    if (!open || !convId) return;
    let cancelled = false;
    setView('list');
    setSessions(null);
    setListError(null);
    setActiveSession(null);
    setDetailMessages(null);
    setDetailError(null);
    AgentApi.conv.getSessions(convId).then(data => {
      if (cancelled) return;
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    }).catch(err => {
      if (cancelled) return;
      setListError(err.message || String(err));
    });
    return () => { cancelled = true; };
  }, [open, convId]);

  /* Escape closes the modal (from either view). */
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function openSession(session){
    setActiveSession(session);
    setView('detail');
    setDetailMessages(null);
    setDetailError(null);
    /* Current session's messages are already in memory (passed from ChatLive) —
       skip the fetch to avoid a round-trip for the row the user is in. */
    if (currentSessionNumber != null && session.number === currentSessionNumber && Array.isArray(currentMessages)) {
      setDetailMessages(currentMessages);
      return;
    }
    setDetailLoading(true);
    try {
      const data = await AgentApi.conv.getSessionMessages(convId, session.number);
      setDetailMessages(Array.isArray(data.messages) ? data.messages : []);
    } catch (err) {
      setDetailError(err.message || String(err));
    } finally {
      setDetailLoading(false);
    }
  }

  function backToList(){
    setView('list');
    setActiveSession(null);
    setDetailMessages(null);
    setDetailError(null);
  }

  async function downloadSession(sessionNumber){
    try {
      window.open(AgentApi.conv.sessionDownloadUrl(convId, sessionNumber), '_blank', 'noopener');
    } catch (err) {
      dialog.alert({
        variant: 'error',
        title: 'Download failed',
        body: err.message || String(err),
      });
    }
  }

  const title = view === 'detail' && activeSession
    ? `Session ${activeSession.number}`
    : 'Session History';

  return (
    <div className="fp-scrim" onClick={onClose}>
      <div className="fp-panel sh-panel" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="fp-head">
          <span className="fp-title">{title}</span>
          <button className="fp-close" type="button" aria-label="Close" title="Close" onClick={onClose}>{Ico.x(14)}</button>
        </div>

        {view === 'detail' ? (
          <SessionDetailView
            session={activeSession}
            messages={detailMessages}
            loading={detailLoading}
            error={detailError}
            onBack={backToList}
            onDownload={() => activeSession && downloadSession(activeSession.number)}
          />
        ) : (
          <SessionListView
            sessions={sessions}
            error={listError}
            onOpen={openSession}
            onDownload={downloadSession}
          />
        )}
      </div>
    </div>
  );
}

/* ---------- List view ---------- */

function SessionListView({ sessions, error, onOpen, onDownload }){
  if (error) {
    return <div className="sh-body"><div className="u-err" style={{padding:'12px 0'}}>{error}</div></div>;
  }
  if (sessions === null) {
    return <div className="sh-body"><div className="u-dim" style={{padding:'12px 0', fontSize:13}}>Loading…</div></div>;
  }
  if (sessions.length === 0) {
    return <div className="sh-body"><div className="u-dim" style={{padding:'12px 0', fontSize:13}}>No sessions yet.</div></div>;
  }
  return (
    <div className="sh-body">
      <ul className="sh-list">
        {sessions.map(s => (
          <SessionRow key={s.number} session={s} onOpen={onOpen} onDownload={onDownload}/>
        ))}
      </ul>
    </div>
  );
}

function SessionRow({ session, onOpen, onDownload }){
  const started = session.startedAt ? new Date(session.startedAt).toLocaleString() : '';
  const ended = session.endedAt ? new Date(session.endedAt).toLocaleString() : null;
  return (
    <li className="sh-item">
      <div className="sh-item-head">
        <div className="sh-item-title">
          <strong>Session {session.number}</strong>
          {session.isCurrent ? <span className="sh-pill sh-pill-current">Current</span> : null}
        </div>
        <div className="sh-item-actions">
          <button
            type="button"
            className="btn ghost sh-item-btn"
            title="Download as markdown"
            onClick={(e) => { e.stopPropagation(); onDownload(session.number); }}
          >{Ico.download(12)} Download</button>
          <button
            type="button"
            className="btn sh-item-btn"
            onClick={(e) => { e.stopPropagation(); onOpen(session); }}
          >View</button>
        </div>
      </div>
      {session.summary ? <div className="sh-item-summary">{session.summary}</div> : null}
      <div className="sh-item-meta u-dim">
        Started: {started}
        {ended ? <> &middot; Ended: {ended}</> : null}
        {typeof session.messageCount === 'number' ? <> &middot; {session.messageCount} messages</> : null}
      </div>
    </li>
  );
}

/* ---------- Detail view ---------- */

function SessionDetailView({ session, messages, loading, error, onBack, onDownload }){
  const dateLabel = React.useMemo(() => {
    if (!messages || messages.length === 0) return '';
    const ts = messages[0].timestamp;
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return ''; }
  }, [messages]);

  return (
    <>
      <div className="sh-detail-head">
        <button type="button" className="sh-back-btn" onClick={onBack}>← Back to Session List</button>
        {session ? (
          <div className="sh-detail-meta">
            {dateLabel ? <span className="u-dim">{dateLabel}</span> : null}
            <button
              type="button"
              className="btn ghost sh-item-btn"
              onClick={onDownload}
              title="Download as markdown"
            >{Ico.download(12)} Download</button>
          </div>
        ) : null}
      </div>
      <div className="sh-detail-body">
        {error ? (
          <div className="u-err" style={{padding:'12px 0'}}>{error}</div>
        ) : loading || messages === null ? (
          <div className="u-dim" style={{padding:'12px 0', fontSize:13}}>Loading…</div>
        ) : messages.length === 0 ? (
          <div className="u-dim" style={{padding:'12px 0', fontSize:13}}>No messages in this session.</div>
        ) : (
          messages.map((m, i) => <SessionMessageRow key={i} message={m}/>)
        )}
      </div>
    </>
  );
}

function SessionMessageRow({ message }){
  const isUser = message.role === 'user';
  const roleLabel = isUser ? 'You' : 'Assistant';
  const html = React.useMemo(() => sessionRenderMd(message.content), [message.content]);
  return (
    <div className={"sh-msg" + (isUser ? " sh-msg-user" : " sh-msg-assistant")}>
      <div className="sh-msg-role">
        {roleLabel}
        {!isUser && message.backend ? <span className="sh-msg-backend u-dim">{message.backend}</span> : null}
      </div>
      <div className="sh-msg-body prose" dangerouslySetInnerHTML={{ __html: html }}/>
    </div>
  );
}
