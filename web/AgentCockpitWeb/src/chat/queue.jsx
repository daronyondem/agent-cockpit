import React from 'react';

import { AgentApi } from '../api.js';
import { useDialog } from '../dialog.jsx';
import { Ico } from '../icons.jsx';
import { StreamStore } from '../streamStore.js';
import { AttChip } from './attachments.jsx';

/* Banner shown above the queue stack when the queue was restored from a
   prior session (server had pending items at conv load time). Auto-drain is
   paused until the user Resumes or Clears, so stale queued messages don't
   fire unexpectedly on next page load. */
export function SuspendedQueueBanner({ count, onResume, onClear }){
  return (
    <div className="qbanner qbanner-suspended">
      <span className="qbanner-text">
        {count} queued message{count !== 1 ? 's' : ''} from a previous session
      </span>
      <span className="qbanner-actions">
        <button type="button" className="btn primary" onClick={onResume} style={{padding:"2px 10px",fontSize:11}}>
          Resume
        </button>
        <button type="button" className="btn ghost" onClick={onClear} style={{padding:"2px 10px",fontSize:11}}>
          Clear
        </button>
      </span>
    </div>
  );
}

/* Queue stack - renders the mirrored server queue while a run is in flight.
   Rows show the text preview + an attachment strip, with per-row reorder
   and remove controls. Auto-drain happens in the StreamStore on each
   `done` frame, so the head disappears as the agent consumes it. */
export function QueueStack({ convId, queue, onClear, onRemove, onMoveUp, onMoveDown }){
  const [expandedIndex, setExpandedIndex] = React.useState(null);
  // Collapse if the expanded row drains/removes out from underneath us.
  React.useEffect(() => {
    if (expandedIndex != null && expandedIndex >= queue.length) setExpandedIndex(null);
  }, [queue.length, expandedIndex]);
  return (
    <div className="qstack">
      <div className="qstack-head">
        <span>Up next · {queue.length} message{queue.length !== 1 ? 's' : ''}</span>
        <span className="spacer"/>
        <button
          type="button"
          className="btn ghost"
          onClick={onClear}
          style={{padding:"2px 8px",fontSize:11}}
        >Clear queue</button>
      </div>
      {queue.map((q, i) => (
        expandedIndex === i && !q.inFlight ? (
          <QueueRowExpanded
            key={i}
            convId={convId}
            item={q}
            position={i + 1}
            index={i}
            first={i === 0}
            onClose={() => setExpandedIndex(null)}
            onRemove={() => { onRemove(i); setExpandedIndex(null); }}
            onMoveUp={() => onMoveUp(i)}
          />
        ) : (
          <QueueRow
            key={i}
            item={q}
            position={i + 1}
            first={i === 0}
            last={i === queue.length - 1}
            onRemove={() => onRemove(i)}
            onMoveUp={() => onMoveUp(i)}
            onMoveDown={() => onMoveDown(i)}
            onEdit={() => setExpandedIndex(i)}
          />
        )
      ))}
    </div>
  );
}

function QueueRow({ item, position, first, last, onRemove, onMoveUp, onMoveDown, onEdit }){
  const atts = Array.isArray(item.attachments) ? item.attachments : [];
  const textPreview = (item.content || '').split('\n')[0];
  const inFlight = !!item.inFlight;
  return (
    <div className={`qrow${inFlight ? ' qrow-in-flight' : ''}`}>
      <div className="qrow-top">
        <button className="qrow-handle" title="Drag to reorder" aria-label="Drag to reorder" disabled={inFlight}>{Ico.dots(12)}</button>
        <span className={`qrow-tag${inFlight ? ' qrow-tag-sending' : ''}`}>{inFlight ? 'sending...' : 'queued'}</span>
        <span className="qrow-num u-mono">#{position}</span>
        <span className="qrow-text">{textPreview || <span className="u-dim">(no text)</span>}</span>
        {inFlight ? null : (
          <span className="qrow-actions">
            <button className="iconbtn" title="Move up" disabled={first} onClick={onMoveUp} aria-label="Move up">{Ico.chevU(11)}</button>
            <button className="iconbtn" title="Move down" disabled={last} onClick={onMoveDown} aria-label="Move down">{Ico.chevD(11)}</button>
            <button className="iconbtn" title="Edit" onClick={onEdit} aria-label="Edit">{Ico.edit(11)}</button>
            <button className="iconbtn" title="Remove" onClick={onRemove} aria-label="Remove">{Ico.x(11)}</button>
          </span>
        )}
      </div>
      {atts.length ? (
        <div className="qrow-atts">
          <span className="qrow-atts-label u-mono">{atts.length} attached</span>
          {atts.map((a, i) => <AttChip key={i} att={a} size="sm"/>)}
        </div>
      ) : null}
    </div>
  );
}

/* Expanded queue row - inline editor. Pre-fills a textarea with the item's
   content and renders each attachment as a removable md AttChip. The "Add
   attachment" button uploads through the same per-conversation endpoint as
   the composer tray. Save persists via StreamStore.updateQueueItem (which
   PUTs /queue); Cancel discards the draft. */
function QueueRowExpanded({ convId, item, position, index, first, onClose, onRemove, onMoveUp }){
  const originalText = item.content || '';
  const originalAtts = Array.isArray(item.attachments) ? item.attachments : [];
  const dialog = useDialog();
  const [text, setText] = React.useState(originalText);
  const [atts, setAtts] = React.useState(originalAtts);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState('');
  const fileRef = React.useRef(null);
  const textRef = React.useRef(null);
  /* attName -> original pasted text. Only populated by this component's
     paste-to-attachment flow; lasts until the editor closes (state lives
     with the component). Lookup is what gates the dissolve button. */
  const dissolveMapRef = React.useRef(new Map());
  const dirty = text !== originalText || attsChanged(atts, originalAtts);
  async function save(){
    try {
      await StreamStore.updateQueueItem(convId, index, { content: text, attachments: atts });
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to save');
    }
  }
  function removeAtt(ai){
    const target = atts[ai];
    if (target && target.name) dissolveMapRef.current.delete(target.name);
    setAtts(atts.filter((_, i) => i !== ai));
  }
  function openFilePicker(){ if (fileRef.current) fileRef.current.click(); }
  async function uploadFiles(files, originalsByName){
    if (!files.length) return;
    setUploading(true);
    setError('');
    try {
      const uploaded = [];
      for (const file of files) {
        const result = await AgentApi.conv.uploadFile(convId, file);
        if (result) {
          uploaded.push(result);
          if (originalsByName && originalsByName.has(file.name) && result.name) {
            dissolveMapRef.current.set(result.name, originalsByName.get(file.name));
          }
        }
      }
      setAtts(cur => [...cur, ...uploaded]);
    } catch (err) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }
  async function onPickAdd(e){
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await uploadFiles(files);
  }
  /* Mirrors composer onPaste: >=1000-char text -> synthesized pasted-text-*.txt
     attachment uploaded into the conv's artifacts dir. Image-file pastes also
     route through the same upload path so behavior matches the main composer.
     Original pasted text is stashed in dissolveMapRef so the chip can offer
     a dissolve button (only available within this edit session). */
  function onPaste(e){
    const items = (e.clipboardData && e.clipboardData.items) || null;
    if (items) {
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            const ts = Date.now();
            const ext = file.name && file.name.includes('.') ? '.' + file.name.split('.').pop() : '.png';
            const baseName = file.name ? file.name.replace(/\.[^.]+$/, '') : 'pasted-image';
            const uniqueName = baseName + '-' + ts + '-' + (files.length + 1) + ext;
            files.push(new File([file], uniqueName, { type: file.type }));
          }
        }
      }
      if (files.length) {
        e.preventDefault();
        uploadFiles(files);
        return;
      }
    }
    const pastedText = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (pastedText && pastedText.length >= 1000) {
      e.preventDefault();
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ts = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
        + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
      const fname = 'pasted-text-' + ts + '.txt';
      const textFile = new File([pastedText], fname, { type: 'text/plain' });
      const originals = new Map();
      originals.set(fname, pastedText);
      uploadFiles([textFile], originals);
    }
  }
  async function dissolveAtt(att, ai){
    const original = att && att.name ? dissolveMapRef.current.get(att.name) : null;
    if (!original) return;
    if (original.length > 50000) {
      const ok = await dialog.confirm({
        title: 'Inline this text into the message?',
        body: original.length.toLocaleString() + ' characters will be inserted into the editor.',
        confirmLabel: 'Inline',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
    }
    const ta = textRef.current;
    const current = ta ? ta.value : text;
    let nextValue;
    let caret;
    if (ta && typeof ta.selectionStart === 'number') {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      nextValue = current.slice(0, start) + original + current.slice(end);
      caret = start + original.length;
    } else {
      nextValue = current + original;
      caret = nextValue.length;
    }
    setText(nextValue);
    removeAtt(ai);
    /* Dissolve is the "undo the paste" path - the just-uploaded artifact
       should not linger on disk. Fire-and-forget delete; if it fails the
       chip is already gone from the queue draft so the next save won't
       reference it. Mirrors composer's removeAttachment cleanup. */
    if (att && att.name) AgentApi.conv.deleteUpload(convId, att.name).catch(() => {});
    requestAnimationFrame(() => {
      const t = textRef.current;
      if (!t) return;
      t.focus();
      try { t.setSelectionRange(caret, caret); } catch {}
    });
  }
  return (
    <div className="qexp">
      <div className="qexp-head">
        <span className="qrow-tag">queued</span>
        <span className="qrow-num u-mono">#{position}{index > 0 ? ` · in ${index} position${index === 1 ? '' : 's'}` : ''}</span>
        <span className="spacer"/>
        <span className="u-mono u-dim" style={{fontSize:10.5}}>editing</span>
      </div>
      <textarea
        ref={textRef}
        className="qexp-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        rows={4}
        autoFocus
      />
      <input ref={fileRef} type="file" multiple onChange={onPickAdd} style={{display:'none'}}/>
      {atts.length ? (
        <>
          <div className="qexp-att-head u-mono">{atts.length} attachment{atts.length === 1 ? '' : 's'}</div>
          <div className="qexp-atts">
            {atts.map((a, i) => (
              <AttChip
                key={i}
                att={a}
                onRemove={() => removeAtt(i)}
                onDissolve={a && a.name && dissolveMapRef.current.has(a.name)
                  ? () => dissolveAtt(a, i)
                  : null}
              />
            ))}
          </div>
        </>
      ) : null}
      {error ? <div className="u-mono" style={{fontSize:11, color:'var(--status-error)'}}>{error}</div> : null}
      <div className="qexp-foot">
        <button className="btn ghost" onClick={openFilePicker} disabled={uploading}>
          {Ico.paperclip(12)} <span>{uploading ? 'Uploading...' : 'Add attachment'}</span>
        </button>
        {!first ? (
          <button className="btn ghost" onClick={onMoveUp}>
            {Ico.chevU(12)} <span>Move up</span>
          </button>
        ) : null}
        <span className="spacer"/>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={!dirty || uploading}>Save</button>
        <button className="btn danger" onClick={onRemove} title="Remove from queue">
          {Ico.x(12)} <span>Remove</span>
        </button>
      </div>
    </div>
  );
}

function attsChanged(a, b){
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && (a[i].path || a[i].name) !== (b[i].path || b[i].name)) return true;
  }
  return false;
}
