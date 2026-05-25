import React from 'react';

import { AgentApi } from '../api.js';
import { Ico } from '../icons.jsx';

function FileViewerCode({ content, language, line }){
  const targetRef = React.useRef(null);
  React.useEffect(() => {
    if (!line || !targetRef.current) return;
    targetRef.current.scrollIntoView({ block: 'center' });
  }, [content, line]);

  if (!line) {
    return <pre className="file-viewer-pre"><code className={language ? 'language-' + language : ''}>{content}</code></pre>;
  }

  const lines = String(content || '').split('\n');
  return (
    <pre className="file-viewer-pre file-viewer-lines">
      <code className={language ? 'language-' + language : ''}>
        {lines.map((text, i) => {
          const n = i + 1;
          const active = n === line;
          return (
            <span
              key={n}
              ref={active ? targetRef : null}
              className={"file-viewer-line" + (active ? " is-target" : "")}
            >
              <span className="file-viewer-line-no">{n}</span>
              <span className="file-viewer-line-text">{text || ' '}</span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

export function FileViewerPanel({ filename, viewPath, imageUrl, displayPath, line, onClose }){
  const isImage = !!imageUrl;
  const [state, setState] = React.useState({ loading: !isImage, error: null, content: '', language: '' });

  React.useEffect(() => {
    if (isImage) { setState({ loading: false, error: null, content: '', language: '' }); return; }
    if (!viewPath) { setState({ loading: false, error: 'No view URL for file.', content: '', language: '' }); return; }
    let cancelled = false;
    setState({ loading: true, error: null, content: '', language: '' });
    AgentApi.fetch(viewPath)
      .then(r => r.json().then(data => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok) {
          setState({ loading: false, error: (data && data.error) || 'Failed to load file', content: '', language: '' });
        } else {
          setState({ loading: false, error: null, content: data.content || '', language: data.language || '' });
        }
      })
      .catch(err => {
        if (cancelled) return;
        setState({ loading: false, error: err.message || String(err), content: '', language: '' });
      });
    return () => { cancelled = true; };
  }, [viewPath, isImage]);

  return (
    <aside className="file-viewer" role="dialog" aria-label={`File preview: ${filename}`}>
      <div className="file-viewer-head">
        <span className="file-viewer-title" title={displayPath || filename}>{filename}{line ? `:${line}` : ''}</span>
        <button className="file-viewer-close" type="button" onClick={onClose} title="Close" aria-label="Close">{Ico.x ? Ico.x(14) : '×'}</button>
      </div>
      <div className="file-viewer-body">
        {isImage ? (
          <img src={imageUrl} alt={filename} className="file-viewer-image"/>
        ) : state.loading ? (
          <div className="u-dim" style={{padding:'12px'}}>Loading…</div>
        ) : state.error ? (
          <div className="u-err" style={{padding:'12px'}}>{state.error}</div>
        ) : (
          <FileViewerCode content={state.content} language={state.language} line={line}/>
        )}
      </div>
    </aside>
  );
}
