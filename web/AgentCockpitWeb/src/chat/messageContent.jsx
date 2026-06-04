import React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

import { AgentApi } from '../api.js';
import { resolveConversationArtifactHref, resolveLocalFileHref, resolveWorkspaceContextHref } from '../fileLinks';
import { Ico } from '../icons.jsx';
import hljs from '../syntaxHighlight.js';
import { extractFileDeliveries, extractRoutineProposals, extractUploadedFiles } from './messageParsing';

const CHAT_IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

/* Exposes the active workspace hash plus chat-level file preview and image
   lightbox openers to deeply nested text segments. */
export const FileViewerContext = React.createContext({
  wsHash: null,
  workspaceLabel: null,
  convId: null,
  workingDir: null,
  executionDir: null,
  openFileViewer: null,
  openLightbox: null,
  onOpenWorkspaceSettings: null,
});

/* Fullscreen overlay for inline chat-message images. */
export function ImageLightbox({ src, alt, onClose }){
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="kb-lightbox" role="dialog" aria-label="Image preview" onClick={onClose}>
      <img src={src} alt={alt || ''} onClick={(e) => e.stopPropagation()}/>
      <button className="kb-lightbox-close" onClick={onClose}>Close</button>
    </div>
  );
}

function escHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CODE_COLLAPSE_LINES = 200;

/* Custom marked renderer for code blocks. Duck-types the renderer arg so this
   survives both marked v12 (`code, lang`) and v15 (`{text, lang}`). */
export function buildMarkedRenderer(){
  const renderer = new marked.Renderer();
  renderer.code = function(code, language){
    let codeText, lang;
    if (typeof code === 'object' && code !== null) {
      codeText = code.text || '';
      lang = code.lang || language || '';
    } else {
      codeText = code || '';
      lang = language || '';
    }
    const lineCount = codeText.split('\n').length;
    const collapsible = lineCount > CODE_COLLAPSE_LINES;
    const langLabel = lang ? escHtml(lang) : 'code';
    const langClass = lang ? ' class="language-' + escHtml(lang) + '"' : '';
    const cls = 'code-block' + (collapsible ? ' collapsible collapsed' : '');
    return (
      '<div class="' + cls + '">' +
        '<div class="code-header">' +
          '<span class="code-lang">' + langLabel + '</span>' +
          '<button type="button" class="code-copy" data-code-copy="1">Copy</button>' +
        '</div>' +
        '<pre><code' + langClass + '>' + escHtml(codeText) + '</code></pre>' +
        (collapsible
          ? '<button type="button" class="code-toggle" data-code-toggle="1">Show more</button>'
          : '') +
      '</div>'
    );
  };
  return renderer;
}

export function renderMarkdown(md){
  const renderer = buildMarkedRenderer();
  const raw = marked.parse(md || '', { breaks: true, gfm: true, renderer });
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['data-code-copy', 'data-code-toggle'],
  });
}

/* User bubble body. Strips the legacy uploaded-files tag and renders cleaned
   text, inline image thumbs, and cards for non-image attachments. */
export function UserMessageBody({ content }){
  const { convId, openFileViewer, openLightbox } = React.useContext(FileViewerContext);
  const { cleaned, paths } = extractUploadedFiles(content);
  const attachments = paths.map(filePath => {
    const filename = (filePath.split('/').pop() || filePath);
    const isImage = CHAT_IMAGE_EXTS.test(filename);
    return { filePath, filename, isImage };
  });
  const imageUrl = (filename) => convId
    ? AgentApi.chatUrl('conversations/' + encodeURIComponent(convId) + '/files/' + encodeURIComponent(filename))
    : null;
  return (
    <>
      {cleaned ? <div style={{whiteSpace:"pre-wrap"}}>{cleaned}</div> : null}
      {attachments.length ? (
        <div className="file-cards">
          {attachments.filter(a => !a.isImage).map(a => (
            <UploadedFileCard
              key={a.filePath}
              filePath={a.filePath}
              convId={convId}
              onOpenView={openFileViewer}
            />
          ))}
          {attachments.filter(a => a.isImage).map(a => {
            const src = imageUrl(a.filename);
            if (!src) return null;
            return (
              <button
                key={a.filePath}
                type="button"
                className="user-image-thumb"
                onClick={() => openLightbox && openLightbox(src, a.filename)}
                title={a.filename}
              >
                <img src={src} alt={a.filename}/>
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

function buildWorkspaceFileDescriptor(ref, wsHash, convId){
  if (!ref || !ref.filePath || (!wsHash && !convId)) return null;
  const filename = (ref.filePath.split('/').pop() || ref.filePath);
  const basePath = convId
    ? 'conversations/' + encodeURIComponent(convId) + '/workspace-file?path=' + encodeURIComponent(ref.filePath)
    : 'workspaces/' + encodeURIComponent(wsHash) + '/files?path=' + encodeURIComponent(ref.filePath);
  const viewPath = basePath + '&mode=view';
  const downloadUrl = AgentApi.chatUrl(basePath + '&mode=download');
  const isImage = CHAT_IMAGE_EXTS.test(filename);
  return {
    filename,
    viewPath,
    imageUrl: isImage ? downloadUrl : null,
    displayPath: ref.filePath,
    line: ref.line || null,
    column: ref.column || null,
  };
}

function buildConversationArtifactDescriptor(ref, convId){
  if (!ref || !ref.filename || !convId) return null;
  const filename = ref.filename;
  const basePath = 'conversations/' + encodeURIComponent(convId) + '/files/' + encodeURIComponent(filename);
  const viewPath = basePath + '?mode=view';
  const downloadUrl = AgentApi.chatUrl(basePath + '?mode=download');
  const isImage = CHAT_IMAGE_EXTS.test(filename);
  return {
    filename,
    viewPath,
    imageUrl: isImage ? downloadUrl : null,
    displayPath: ref.filePath || filename,
    line: ref.line || null,
    column: ref.column || null,
  };
}

function buildWorkspaceContextFileDescriptor(ref, convId){
  if (!ref || !ref.filename || !convId) return null;
  const basePath = 'conversations/' + encodeURIComponent(convId) + '/workspace-context-file?path=' + encodeURIComponent(ref.filePath);
  const isImage = ref.section === 'assets' && CHAT_IMAGE_EXTS.test(ref.filename);
  return {
    filename: ref.filename,
    viewPath: basePath + '&mode=view',
    imageUrl: isImage ? AgentApi.chatUrl(basePath + '&mode=view') : null,
    displayPath: ref.filePath,
    line: ref.line || null,
    column: ref.column || null,
  };
}

export function GeneratedArtifact({ artifact }){
  const { convId, openFileViewer, openLightbox } = React.useContext(FileViewerContext);
  if (!artifact) return null;
  const filename = artifact.filename || (artifact.path || '').split('/').pop() || 'artifact';
  const isImage = (artifact.kind === 'image') || CHAT_IMAGE_EXTS.test(filename);
  const basePath = convId
    ? 'conversations/' + encodeURIComponent(convId) + '/files/' + encodeURIComponent(filename)
    : null;
  const downloadUrl = basePath ? AgentApi.chatUrl(basePath + '?mode=download') : null;
  const rawUrl = basePath ? AgentApi.chatUrl(basePath) : null;
  if (isImage && rawUrl) {
    return (
      <div className="file-cards">
        <button
          type="button"
          className="user-image-thumb generated-image-thumb"
          onClick={() => openLightbox && openLightbox(rawUrl, artifact.title || filename)}
          title={artifact.path || filename}
        >
          <img src={rawUrl} alt={artifact.title || filename}/>
        </button>
        <GeneratedArtifactCard
          artifact={artifact}
          filename={filename}
          viewPath={basePath ? basePath + '?mode=view' : null}
          downloadUrl={downloadUrl}
          imageUrl={rawUrl}
          onOpenView={openFileViewer}
        />
      </div>
    );
  }
  return (
    <div className="file-cards">
      <GeneratedArtifactCard
        artifact={artifact}
        filename={filename}
        viewPath={basePath ? basePath + '?mode=view' : null}
        downloadUrl={downloadUrl}
        imageUrl={null}
        onOpenView={openFileViewer}
      />
    </div>
  );
}

function GeneratedArtifactCard({ artifact, filename, viewPath, downloadUrl, imageUrl, onOpenView }){
  return (
    <div className="file-card" title={artifact.path || filename}>
      <span className="file-card-icon" aria-hidden="true">{Ico.file ? Ico.file(18) : '📄'}</span>
      <span className="file-card-name">{artifact.title || filename}</span>
      <span className="file-card-actions">
        <button
          type="button"
          className="btn ghost file-card-btn"
          onClick={() => onOpenView && onOpenView({
            filename,
            viewPath,
            imageUrl,
            displayPath: artifact.path || filename,
          })}
          disabled={!viewPath || !onOpenView}
        >View</button>
        {downloadUrl ? (
          <a className="btn ghost file-card-btn" href={downloadUrl} download={filename}>Download</a>
        ) : null}
      </span>
    </div>
  );
}

export const TextSegment = React.memo(function TextSegment({ content }){
  const { wsHash, convId, workingDir, executionDir, openFileViewer, openLightbox } = React.useContext(FileViewerContext);
  const fileExtraction = extractFileDeliveries(content);
  const routineExtraction = extractRoutineProposals(fileExtraction.cleaned);
  const cleaned = routineExtraction.cleaned;
  const files = fileExtraction.files;
  const routineMarkers = routineExtraction.markers;
  const html = React.useMemo(() => renderMarkdown(cleaned), [cleaned]);
  const proseRef = React.useRef(null);

  React.useEffect(() => {
    const root = proseRef.current;
    if (!root) return;
    if (hljs) {
      root.querySelectorAll('pre code').forEach(el => {
        if (el.dataset.hljsHighlighted) return;
        try { hljs.highlightElement(el); } catch (e) {}
        el.dataset.hljsHighlighted = '1';
      });
    }
    function onClick(e){
      const copyBtn = e.target.closest && e.target.closest('[data-code-copy]');
      if (copyBtn && root.contains(copyBtn)) {
        const block = copyBtn.closest('.code-block');
        const codeEl = block && block.querySelector('pre code');
        if (codeEl && navigator.clipboard) {
          navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
          }).catch(() => {});
        }
        return;
      }
      const toggleBtn = e.target.closest && e.target.closest('[data-code-toggle]');
      if (toggleBtn && root.contains(toggleBtn)) {
        const block = toggleBtn.closest('.code-block');
        if (!block) return;
        block.classList.toggle('collapsed');
        toggleBtn.textContent = block.classList.contains('collapsed') ? 'Show more' : 'Show less';
        return;
      }
      const link = e.target.closest && e.target.closest('a[href]');
      if (link && root.contains(link)) {
        const href = link.getAttribute('href');
        const artifactRef = resolveConversationArtifactHref(href, convId);
        const artifactDescriptor = buildConversationArtifactDescriptor(artifactRef, convId);
        if (artifactDescriptor && openFileViewer) {
          e.preventDefault();
          openFileViewer(artifactDescriptor);
          return;
        }
        let ref = executionDir ? resolveLocalFileHref(href, executionDir) : null;
        let descriptorConvId = convId;
        if (!ref) {
          ref = workingDir ? resolveLocalFileHref(href, workingDir) : null;
          descriptorConvId = null;
        }
        const descriptor = buildWorkspaceFileDescriptor(ref, wsHash, descriptorConvId);
        if (descriptor && openFileViewer) {
          e.preventDefault();
          openFileViewer(descriptor);
          return;
        }
        const workspaceContextRef = resolveWorkspaceContextHref(href);
        const workspaceContextDescriptor = buildWorkspaceContextFileDescriptor(workspaceContextRef, convId);
        if (workspaceContextDescriptor && openFileViewer) {
          e.preventDefault();
          openFileViewer(workspaceContextDescriptor);
        }
        return;
      }
      const img = e.target.closest && e.target.closest('img');
      if (img && img.src && openLightbox) {
        e.preventDefault();
        openLightbox(img.src, img.alt || '');
      }
    }
    root.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      const artifactRef = resolveConversationArtifactHref(href, convId);
      if (artifactRef) {
        link.classList.add('local-file-link');
        link.title = artifactRef.line ? `Preview ${artifactRef.filename}:${artifactRef.line}` : `Preview ${artifactRef.filename}`;
        return;
      }
      const ref = (executionDir ? resolveLocalFileHref(href, executionDir) : null)
        || (workingDir ? resolveLocalFileHref(href, workingDir) : null);
      const workspaceContextRef = ref ? null : resolveWorkspaceContextHref(href);
      if (!ref && !workspaceContextRef) return;
      link.classList.add('local-file-link');
      if (ref) {
        link.title = ref.line ? `Preview ${ref.filePath}:${ref.line}` : `Preview ${ref.filePath}`;
      } else {
        link.title = workspaceContextRef.line
          ? `Preview ${workspaceContextRef.relativePath}:${workspaceContextRef.line}`
          : `Preview ${workspaceContextRef.relativePath}`;
      }
    });
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [cleaned, convId, executionDir, openFileViewer, openLightbox, workingDir, wsHash]);

  return (
    <>
      {cleaned ? (
        <div
          ref={proseRef}
          className="prose"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : null}
      {files.length ? (
        <div className="file-cards">
          {files.map((p, i) => (
            <FileDeliveryCard
              key={p + ':' + i}
              filePath={p}
              wsHash={wsHash}
              convId={convId}
              onOpenView={openFileViewer}
            />
          ))}
        </div>
      ) : null}
      {routineMarkers.length ? (
        <div className="routine-proposal-stack">
          {routineMarkers.map((marker, i) => (
            <RoutineProposalCard key={marker + ':' + i} marker={marker}/>
          ))}
        </div>
      ) : null}
    </>
  );
});

function RoutineProposalCard({ marker }){
  const { wsHash, workspaceLabel, onOpenWorkspaceSettings } = React.useContext(FileViewerContext);
  const installKey = React.useMemo(() => routineProposalInstallKey(wsHash, marker), [marker, wsHash]);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState('');
  const [installed, setInstalled] = React.useState(() => loadRoutineProposalInstalled(installKey));

  React.useEffect(() => {
    let cancelled = false;
    const markInstalled = () => {
      saveRoutineProposalInstalled(installKey);
      if (!cancelled) {
        setInstalled(true);
        setStatus('Installed');
      }
    };
    const locallyInstalled = loadRoutineProposalInstalled(installKey);
    setInstalled(locallyInstalled);
    setStatus('');
    if (!wsHash || !marker || locallyInstalled) return () => { cancelled = true; };
    AgentApi.workspace.validateRoutineProposal(wsHash, { marker }).then((res) => {
      const proposal = res && Array.isArray(res.proposals) ? res.proposals[0] : null;
      if (routineProposalIsInstalled(proposal)) markInstalled();
    }).catch(() => {});
    const onInstalled = (event) => {
      if (event && event.detail && event.detail.installKey === installKey) markInstalled();
    };
    window.addEventListener('ac:routine-proposal-installed', onInstalled);
    return () => {
      cancelled = true;
      window.removeEventListener('ac:routine-proposal-installed', onInstalled);
    };
  }, [installKey, marker, wsHash]);

  async function validate(){
    if (!wsHash) throw new Error('Workspace unavailable');
    const res = await AgentApi.workspace.validateRoutineProposal(wsHash, { marker });
    const proposal = res && Array.isArray(res.proposals) ? res.proposals[0] : null;
    if (!proposal || !proposal.routineId) throw new Error('Routine proposal is no longer available');
    return proposal;
  }

  async function install(state){
    if (installed) return;
    setBusy(true);
    setStatus('');
    try {
      const proposal = await validate();
      if (!routineProposalIsInstalled(proposal)) {
        await AgentApi.workspace.installRoutine(wsHash, proposal.routineId, state);
      }
      saveRoutineProposalInstalled(installKey);
      setInstalled(true);
      setStatus('Installed');
      window.dispatchEvent(new CustomEvent('ac:routine-proposal-installed', { detail: { installKey } }));
      if (onOpenWorkspaceSettings) onOpenWorkspaceSettings(wsHash, workspaceLabel || 'workspace', 'routines');
    } catch (err) {
      setStatus((err && err.message) || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="routine-proposal-card">
      <span className="routine-proposal-icon" aria-hidden="true">{Ico.clock(16)}</span>
      <span className="routine-proposal-main">
        <b>{installed ? 'Installed' : 'Routine proposal'}</b>
      </span>
      <span className="routine-proposal-actions">
        {installed ? (
          <span className="routine-proposal-installed">{Ico.check(12)} Installed</span>
        ) : (
          <>
            <button type="button" className="btn primary file-card-btn" disabled={busy || !wsHash} onClick={() => install('enabled')}>
              {busy ? 'Installing...' : 'Install'}
            </button>
            <button type="button" className="btn ghost file-card-btn" disabled={busy || !wsHash} onClick={() => install('disabled')}>Install disabled</button>
          </>
        )}
      </span>
      {status && !installed ? <span className="routine-proposal-status">{status}</span> : null}
    </div>
  );
}

function routineProposalInstallKey(wsHash, marker){
  if (!wsHash || !marker) return '';
  return `ac:v2:routine-proposal-installed:${wsHash}:${encodeURIComponent(marker)}`;
}

function routineProposalIsInstalled(proposal){
  const state = proposal && proposal.manifest && proposal.manifest.state;
  return state === 'enabled' || state === 'disabled';
}

function loadRoutineProposalInstalled(key){
  if (!key) return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function saveRoutineProposalInstalled(key){
  if (!key) return;
  try {
    window.localStorage.setItem(key, '1');
  } catch {}
}

function FileDeliveryCard({ filePath, wsHash, convId, onOpenView }){
  const filename = (filePath.split('/').pop() || filePath);
  const basePath = convId
    ? 'conversations/' + encodeURIComponent(convId) + '/workspace-file?path=' + encodeURIComponent(filePath)
    : wsHash
    ? 'workspaces/' + encodeURIComponent(wsHash) + '/files?path=' + encodeURIComponent(filePath)
    : null;
  const viewPath = basePath ? basePath + '&mode=view' : null;
  const downloadUrl = basePath ? AgentApi.chatUrl(basePath + '&mode=download') : null;
  const isImage = CHAT_IMAGE_EXTS.test(filename);
  return (
    <div className="file-card" title={filePath}>
      <span className="file-card-icon" aria-hidden="true">{Ico.file ? Ico.file(18) : '📄'}</span>
      <span className="file-card-name">{filename}</span>
      <span className="file-card-actions">
        <button
          type="button"
          className="btn ghost file-card-btn"
          onClick={() => onOpenView && onOpenView({
            filename,
            viewPath,
            imageUrl: isImage ? downloadUrl : null,
            displayPath: filePath,
          })}
          disabled={!basePath || !onOpenView}
        >View</button>
        {downloadUrl ? (
          <a className="btn ghost file-card-btn" href={downloadUrl} download={filename}>Download</a>
        ) : null}
      </span>
    </div>
  );
}

function UploadedFileCard({ filePath, convId, onOpenView }){
  const filename = (filePath.split('/').pop() || filePath);
  const basePath = convId
    ? 'conversations/' + encodeURIComponent(convId) + '/files/' + encodeURIComponent(filename)
    : null;
  const viewPath = basePath ? basePath + '?mode=view' : null;
  const downloadUrl = basePath ? AgentApi.chatUrl(basePath + '?mode=download') : null;
  return (
    <div className="file-card" title={filePath}>
      <span className="file-card-icon" aria-hidden="true">{Ico.file ? Ico.file(18) : 'File'}</span>
      <span className="file-card-name">{filename}</span>
      <span className="file-card-actions">
        <button
          type="button"
          className="btn ghost file-card-btn"
          onClick={() => onOpenView && onOpenView({
            filename,
            viewPath,
            imageUrl: null,
            displayPath: filePath,
          })}
          disabled={!convId || !onOpenView}
        >View</button>
        {downloadUrl ? (
          <a className="btn ghost file-card-btn" href={downloadUrl} download={filename}>Download</a>
        ) : null}
      </span>
    </div>
  );
}

export function ThinkingBlock({ content }){
  const [open, setOpen] = React.useState(false);
  const preview = (content || '').trim().split('\n')[0].slice(0, 80);
  return (
    <div style={{margin:"6px 0"}}>
      <button
        type="button"
        className="thinking"
        onClick={() => setOpen(v => !v)}
        style={{border:"1px dashed var(--border-strong)",background:"transparent",font:"inherit"}}
      >
        <span className="dot"/>
        <span>{open ? 'Hide thinking' : (preview ? `Thinking · ${preview}` : 'Thinking')}</span>
      </button>
      {open ? (
        <div style={{
          marginTop:6,
          padding:"10px 12px",
          border:"1px dashed var(--border-strong)",
          borderRadius:"var(--r-sm)",
          whiteSpace:"pre-wrap",
          fontSize:12,
          color:"var(--text-3)",
          lineHeight:1.55,
        }}>
          {content}
        </div>
      ) : null}
    </div>
  );
}
