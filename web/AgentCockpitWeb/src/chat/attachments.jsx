import React from 'react';

import { AgentApi } from '../api.js';
import { Ico } from '../icons.jsx';
import { StreamStore } from '../streamStore.js';

/* Returns the background/foreground colors + 3-letter label for a typed
   AttachmentKind. Matches the mock's palette: images -> subagent, pdf ->
   error, text/md -> accent, code -> done, folders -> awaiting. */
function attStyle(kind){
  switch(kind){
    case 'image':  return { bg: "color-mix(in oklch, var(--status-subagent), transparent 86%)", fg: "var(--status-subagent)", label: 'IMG' };
    case 'pdf':    return { bg: "color-mix(in oklch, var(--status-error), transparent 88%)",    fg: "var(--status-error)",    label: 'PDF' };
    case 'text':   return { bg: "color-mix(in oklch, var(--accent), transparent 88%)",          fg: "var(--accent)",          label: 'TXT' };
    case 'code':   return { bg: "color-mix(in oklch, var(--status-done), transparent 88%)",     fg: "var(--status-done)",     label: 'CODE' };
    case 'md':     return { bg: "color-mix(in oklch, var(--accent), transparent 88%)",          fg: "var(--accent)",          label: 'MD' };
    case 'folder': return { bg: "color-mix(in oklch, var(--status-awaiting), transparent 86%)", fg: "var(--status-awaiting)", label: 'DIR' };
    default:       return { bg: 'var(--surface-2)', fg: 'var(--text-3)', label: 'FILE' };
  }
}

/* Typed attachment chip. size='md' renders as a tray card (icon + name +
   meta + x button; images get a thumbnail and a corner kind badge). size='sm'
   renders as a compact pill used in queue rows and sent messages. */
export function AttChip({ att, size = 'md', onRemove, onDissolve, onOcr, ocring, ocrCached, thumbUrl, uploading, progress }){
  const s = attStyle(att.kind);
  const isImage = att.kind === 'image';
  if (size === 'sm') {
    return (
      <span className="att-chip" title={att.name + (att.meta ? ' · ' + att.meta : '')}>
        <span className="att-chip-sm-tile" style={{background: s.bg, color: s.fg}}>
          {isImage && thumbUrl
            ? <span className="att-thumb-sm" style={{backgroundImage: 'url(' + thumbUrl + ')'}}/>
            : <span className="att-label-sm">{s.label}</span>}
        </span>
        <span className="att-chip-sm-name">{att.name}</span>
      </span>
    );
  }
  const dissolveBtn = onDissolve ? (
    <button
      type="button"
      className="att-dissolve"
      onClick={onDissolve}
      title="Inline text back into message"
      aria-label="Inline text back into message"
    >{Ico.up(11)}</button>
  ) : null;
  /* OCR is image-only; spins up a one-shot CLI server-side and inserts the
     resulting Markdown at the composer cursor. ocrCached flips the title so
     the user knows a re-click is instant rather than another CLI run. */
  const ocrBtn = (isImage && onOcr) ? (
    <button
      type="button"
      className={'att-ocr' + (ocring ? ' ocring' : '')}
      onClick={onOcr}
      disabled={!!ocring}
      title={ocring
        ? 'OCR in progress...'
        : (ocrCached ? 'Insert OCR Markdown (cached)' : 'OCR image to Markdown at cursor')}
      aria-label={ocring ? 'OCR in progress' : 'OCR image to Markdown'}
    >{ocring ? <span className="att-ocr-spin"/> : Ico.fileText(11)}</button>
  ) : null;
  if (isImage) {
    return (
      <div className={'att-card att-image' + (uploading ? ' uploading' : '') + (onDissolve ? ' has-dissolve' : '') + (onOcr ? ' has-ocr' : '')}>
        <div
          className="att-thumb"
          style={thumbUrl
            ? { backgroundImage: 'url(' + thumbUrl + ')' }
            : { background: s.bg, color: s.fg }}
        >
          <span className="att-kind-badge">{s.label}</span>
          {uploading ? <span className="att-upload-ring"><span className="ring"/></span> : null}
        </div>
        <div className="att-card-meta">
          <div className="att-name">{att.name}</div>
          <div className="att-sub">{att.meta || ''}</div>
        </div>
        {ocrBtn}
        {dissolveBtn}
        {onRemove ? (
          <button className="att-x" onClick={onRemove} title="Remove" aria-label="Remove">{Ico.x(11)}</button>
        ) : null}
      </div>
    );
  }
  return (
    <div className={'att-card' + (uploading ? ' uploading' : '') + (onDissolve ? ' has-dissolve' : '')}>
      <div className="att-icon" style={{background: s.bg, color: s.fg}}>
        <span className="att-label">{s.label}</span>
      </div>
      <div className="att-card-meta">
        <div className="att-name">{att.name}</div>
        <div className="att-sub">{att.meta || ''}</div>
        {uploading ? (
          <div className="att-progress"><i style={{width: (progress || 0) + '%'}}/></div>
        ) : null}
      </div>
      {dissolveBtn}
      {onRemove ? (
        <button className="att-x" onClick={onRemove} title="Remove" aria-label="Remove">{Ico.x(11)}</button>
      ) : null}
    </div>
  );
}

/* Composer attachment tray. Renders one AttChip (md) per PendingAttachment
   plus a dashed "Add" tile at the end. Image previews use a blob: URL
   created from the in-memory File so the thumbnail appears immediately -
   the URL is revoked when the entry unmounts. */
export function AttTray({ convId, attachments, onRemove, onDissolve, onOcr, onAdd }){
  return (
    <div className="att-tray">
      {attachments.map(entry => (
        <PendingAttChip
          key={entry.id}
          convId={convId}
          entry={entry}
          onRemove={() => onRemove(entry.id)}
          onDissolve={onDissolve ? () => onDissolve(entry) : null}
          onOcr={onOcr ? () => onOcr(entry) : null}
        />
      ))}
      <button type="button" className="att-add" onClick={onAdd} title="Add attachment" aria-label="Add attachment">
        <span className="att-add-icon">{Ico.plus(14)}</span>
        <span>Add</span>
      </button>
    </div>
  );
}

/* AttChip wrapper that derives kind/meta/thumb from an in-flight or
   uploaded PendingAttachment. Image thumbs come from the File blob for
   fresh uploads; for entries rehydrated from localStorage (no Blob in
   memory), we fall back to the server-side file URL so the thumb still
   renders after a page reload. */
function PendingAttChip({ convId, entry, onRemove, onDissolve, onOcr }){
  const { file, status, progress, error, result } = entry;
  const kind = result ? result.kind : kindFromFile(file);
  const isImage = kind === 'image';
  const restored = !!entry.restored;
  const restoredName = restored ? ((result && result.name) || (file && file.name) || '') : '';
  /* Dissolve is only meaningful when we still have the original Blob in
     memory AND it's a paste-synthesized text file. Restored entries (loaded
     from localStorage on reload) lost the Blob, so the original text isn't
     recoverable client-side and we don't offer dissolve. */
  const dissolvable = !restored
    && file instanceof Blob
    && file.name && file.name.startsWith('pasted-text-')
    && typeof onDissolve === 'function';
  /* OCR offered only once the upload has landed (need result.path); restored
     entries qualify too since the file still lives on the server. */
  const ocrable = isImage
    && status === 'done'
    && result && result.path
    && typeof onOcr === 'function';
  const [thumb, setThumb] = React.useState(null);
  React.useEffect(() => {
    if (!isImage) return;
    if (restored) {
      if (convId && restoredName) {
        setThumb(AgentApi.chatUrl('conversations/' + encodeURIComponent(convId) + '/files/' + encodeURIComponent(restoredName)));
      }
      return;
    }
    if (!(file instanceof Blob)) return;
    const url = URL.createObjectURL(file);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage, restored, convId, restoredName]);
  const att = {
    name: (result && result.name) || (file && file.name) || '',
    path: result ? result.path : '',
    kind,
    meta: result && result.meta ? result.meta : fmtFileSize(file && file.size),
  };
  return (
    <div title={error || undefined} style={status === 'error' ? { outline: '1px solid var(--status-error)', borderRadius: 'var(--r-sm)' } : undefined}>
      <AttChip
        att={att}
        size="md"
        onRemove={onRemove}
        onDissolve={dissolvable ? onDissolve : null}
        onOcr={ocrable ? onOcr : null}
        ocring={entry.ocrStatus === 'running'}
        ocrCached={!!entry.ocrMarkdown}
        thumbUrl={thumb}
        uploading={status === 'uploading'}
        progress={progress}
      />
    </div>
  );
}

export function kindFromFile(file){
  const name = file && file.name ? file.name : '';
  return StreamStore.attachmentKindFromPath
    ? StreamStore.attachmentKindFromPath(name)
    : 'file';
}

export function fmtFileSize(n){
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}
