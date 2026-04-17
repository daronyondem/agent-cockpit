// ─── File Explorer ──────────────────────────────────────────────────────────
// Full-screen split-pane workspace file browser (tree left, preview right).
// Opens when the user clicks the folder button on a workspace group header
// in the sidebar. Mirrors the KB Browser pattern for swap-in over the main
// chat area. State is held in-module so closing and reopening is a clean
// reset.

import { state, chatFetch, chatApiUrl, fetchCsrfToken, ICON_CANCEL, ICON_DOWNLOAD, ICON_EDIT, ICON_FILE, ICON_FILE_UPLOAD, ICON_FOLDER, ICON_FOLDER_OPEN, ICON_RESET, ICON_TRASH } from './state.js';
import { esc, chatFormatFileSize } from './utils.js';
import { chatShowAlert, chatShowConfirm, chatShowPrompt } from './modal.js';

const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'xml', 'csv', 'tsv', 'log', 'ini', 'conf', 'env', 'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'zsh', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'sql', 'toml', 'rb', 'php', 'swift', 'kt', 'scala', 'r', 'lua', 'pl', 'gitignore', 'gitattributes', 'dockerignore', 'editorconfig']);
const MD_EXTS = new Set(['md', 'markdown']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const IMAGE_PREVIEW_LIMIT = 25 * 1024 * 1024;

let feState = null;

function _ext(name) {
  const i = name.lastIndexOf('.');
  if (i < 0) return '';
  return name.slice(i + 1).toLowerCase();
}

function _extNoDot(name) {
  const e = _ext(name);
  return e || name.toLowerCase().replace(/^\./, '');
}

function _previewKind(name, size) {
  const e = _extNoDot(name);
  if (IMAGE_EXTS.has(e)) return (size ?? 0) > IMAGE_PREVIEW_LIMIT ? 'oversize-image' : 'image';
  if (MD_EXTS.has(e)) return 'markdown';
  if (TEXT_EXTS.has(e)) return 'text';
  return 'unsupported';
}

function _joinRel(parent, name) {
  return parent ? `${parent}/${name}` : name;
}

function _parentOf(rel) {
  if (!rel) return '';
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

export async function chatOpenFileExplorer(hash, label) {
  const messagesEl = document.getElementById('chat-messages');
  const browserEl = document.getElementById('chat-file-explorer');
  const inputArea = document.querySelector('.chat-input-area');
  const kbEl = document.getElementById('chat-kb-browser');
  if (!messagesEl || !browserEl) return;

  messagesEl.style.display = 'none';
  if (inputArea) inputArea.style.display = 'none';
  if (kbEl) kbEl.style.display = 'none';
  browserEl.style.display = '';

  feState = {
    hash,
    label,
    currentFolder: '',
    entries: [],
    selected: null,
    preview: null,
    loading: false,
    expanded: new Set(['']),
    children: new Map(),
    uploads: [],
  };

  _renderChrome();
  await _loadFolder('');
}

export async function chatCloseFileExplorer() {
  if (feState && feState.uploads.some((u) => u.status === 'uploading')) {
    const ok = await chatShowConfirm('An upload is in progress. Close the file explorer? In-flight uploads will be cancelled.', {
      title: 'Close File Explorer',
      confirmLabel: 'Close',
      destructive: true,
    });
    if (!ok) return;
    for (const u of feState.uploads) {
      if (u.status === 'uploading' && u.xhr) { try { u.xhr.abort(); } catch {} }
    }
  }
  feState = null;
  const messagesEl = document.getElementById('chat-messages');
  const browserEl = document.getElementById('chat-file-explorer');
  const inputArea = document.querySelector('.chat-input-area');
  if (browserEl) {
    browserEl.style.display = 'none';
    browserEl.innerHTML = '';
  }
  if (messagesEl) messagesEl.style.display = '';
  if (inputArea) inputArea.style.display = '';
}

function _renderChrome() {
  const browserEl = document.getElementById('chat-file-explorer');
  if (!browserEl || !feState) return;
  const label = feState.label || 'Workspace';
  browserEl.innerHTML = `
    <div class="chat-fe-header">
      <h2>Files: ${esc(label)}</h2>
      <button class="chat-fe-header-close" id="chat-fe-close-btn">${ICON_CANCEL} Close</button>
    </div>
    <div class="chat-fe-body">
      <div class="chat-fe-tree-pane">
        <div class="chat-fe-toolbar">
          <button class="chat-fe-btn" id="chat-fe-up-btn" title="Up one level">\u2191 Up</button>
          <button class="chat-fe-btn" id="chat-fe-refresh-btn" title="Refresh">${ICON_RESET}</button>
          <button class="chat-fe-btn" id="chat-fe-mkdir-btn" title="Create a new folder in the selected folder">${ICON_FOLDER} New Folder</button>
          <button class="chat-fe-btn" id="chat-fe-newfile-btn" title="Create a new file in the selected folder">${ICON_FILE} New File</button>
          <button class="chat-fe-btn chat-fe-btn-primary" id="chat-fe-upload-btn" title="Upload files to selected folder">${ICON_FILE_UPLOAD} Upload</button>
          <input type="file" id="chat-fe-upload-input" multiple style="display:none;">
        </div>
        <div class="chat-fe-breadcrumb" id="chat-fe-breadcrumb"></div>
        <div class="chat-fe-tree" id="chat-fe-tree"></div>
        <div class="chat-fe-upload-panel" id="chat-fe-upload-panel"></div>
      </div>
      <div class="chat-fe-preview-pane" id="chat-fe-preview-pane"></div>
    </div>
  `;
  document.getElementById('chat-fe-close-btn').onclick = chatCloseFileExplorer;
  document.getElementById('chat-fe-up-btn').onclick = _goUp;
  document.getElementById('chat-fe-refresh-btn').onclick = () => _loadFolder(feState.currentFolder);
  document.getElementById('chat-fe-mkdir-btn').onclick = _handleMkdir;
  document.getElementById('chat-fe-newfile-btn').onclick = _handleNewFile;
  document.getElementById('chat-fe-upload-btn').onclick = () => document.getElementById('chat-fe-upload-input').click();
  document.getElementById('chat-fe-upload-input').onchange = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) _startUploads(files);
    e.target.value = '';
  };

  const treePane = browserEl.querySelector('.chat-fe-tree-pane');
  if (treePane) {
    treePane.addEventListener('dragover', _onDragOver);
    treePane.addEventListener('dragleave', _onDragLeave);
    treePane.addEventListener('drop', _onDrop);
  }

  _renderPreviewPane();
}

function _renderBreadcrumb() {
  const el = document.getElementById('chat-fe-breadcrumb');
  if (!el || !feState) return;
  const parts = feState.currentFolder ? feState.currentFolder.split('/') : [];
  const crumbs = [
    `<span class="chat-fe-crumb" data-fe-crumb="">/</span>`,
    ...parts.map((p, i) => {
      const rel = parts.slice(0, i + 1).join('/');
      return `<span class="chat-fe-crumb-sep">/</span><span class="chat-fe-crumb" data-fe-crumb="${esc(rel)}">${esc(p)}</span>`;
    }),
  ];
  el.innerHTML = crumbs.join('');
  el.querySelectorAll('.chat-fe-crumb').forEach((c) => {
    c.onclick = () => _loadFolder(c.dataset.feCrumb || '');
  });
}

async function _loadFolder(rel) {
  if (!feState) return;
  feState.loading = true;
  try {
    const res = await chatFetch(`workspaces/${encodeURIComponent(feState.hash)}/explorer/tree?path=${encodeURIComponent(rel)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      await chatShowAlert(body.error || `Failed to load folder (${res.status})`);
      return;
    }
    const data = await res.json();
    feState.currentFolder = data.path || '';
    feState.entries = data.entries || [];
    feState.children.set(feState.currentFolder, data.entries || []);
    feState.expanded.add(feState.currentFolder);
    _renderTree();
    _renderBreadcrumb();
  } finally {
    feState.loading = false;
  }
}

async function _expandFolder(rel) {
  if (!feState) return;
  if (!feState.children.has(rel)) {
    const res = await chatFetch(`workspaces/${encodeURIComponent(feState.hash)}/explorer/tree?path=${encodeURIComponent(rel)}`);
    if (!res.ok) return;
    const data = await res.json();
    feState.children.set(data.path || '', data.entries || []);
  }
  feState.expanded.add(rel);
  _renderTree();
}

function _collapseFolder(rel) {
  if (!feState) return;
  feState.expanded.delete(rel);
  _renderTree();
}

function _renderTree() {
  const treeEl = document.getElementById('chat-fe-tree');
  if (!treeEl || !feState) return;
  const root = feState.currentFolder;
  const rootEntries = feState.children.get(root) || feState.entries;
  treeEl.innerHTML = _renderBranch(root, rootEntries, 0);
  treeEl.querySelectorAll('.chat-fe-row').forEach((row) => {
    row.onclick = (e) => _onRowClick(e, row);
    row.ondragover = _onRowDragOver;
    row.ondragleave = _onRowDragLeave;
    row.ondrop = _onRowDrop;
  });
  treeEl.querySelectorAll('.chat-fe-action').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      _onRowAction(btn.dataset.feAction, btn.dataset.feRel, btn.dataset.feType, btn.dataset.feName);
    };
  });
}

function _renderBranch(parentRel, entries, depth) {
  if (!entries || !entries.length) {
    return `<div class="chat-fe-empty">Empty folder</div>`;
  }
  let html = '';
  for (const e of entries) {
    const rel = _joinRel(parentRel, e.name);
    const isSelected = feState.selected && feState.selected.path === rel;
    const isExpanded = e.type === 'dir' && feState.expanded.has(rel);
    const indent = 6 + depth * 14;
    const icon = e.type === 'dir' ? (isExpanded ? ICON_FOLDER_OPEN : ICON_FOLDER) : ICON_FILE;
    const chev = e.type === 'dir'
      ? `<span class="chat-fe-chev ${isExpanded ? 'open' : ''}">▸</span>`
      : `<span class="chat-fe-chev-spacer"></span>`;
    const sizeLabel = e.type === 'file' ? `<span class="chat-fe-size">${chatFormatFileSize(e.size)}</span>` : '';
    html += `
      <div class="chat-fe-row ${isSelected ? 'selected' : ''}" data-fe-rel="${esc(rel)}" data-fe-type="${e.type}" data-fe-name="${esc(e.name)}" style="padding-left:${indent}px;">
        ${chev}
        <span class="chat-fe-row-icon">${icon}</span>
        <span class="chat-fe-row-name">${esc(e.name)}</span>
        ${sizeLabel}
        <span class="chat-fe-row-actions">
          <button class="chat-fe-action" data-fe-action="rename" data-fe-rel="${esc(rel)}" data-fe-type="${e.type}" data-fe-name="${esc(e.name)}" title="Rename">${ICON_EDIT}</button>
          ${e.type === 'file' ? `<button class="chat-fe-action" data-fe-action="download" data-fe-rel="${esc(rel)}" data-fe-type="${e.type}" data-fe-name="${esc(e.name)}" title="Download">${ICON_DOWNLOAD}</button>` : ''}
          <button class="chat-fe-action chat-fe-action-danger" data-fe-action="delete" data-fe-rel="${esc(rel)}" data-fe-type="${e.type}" data-fe-name="${esc(e.name)}" title="Delete">${ICON_TRASH}</button>
        </span>
      </div>
    `;
    if (e.type === 'dir' && isExpanded) {
      const kids = feState.children.get(rel);
      if (kids) html += _renderBranch(rel, kids, depth + 1);
    }
  }
  return html;
}

function _onRowClick(_e, row) {
  const rel = row.dataset.feRel;
  const type = row.dataset.feType;
  const name = row.dataset.feName;
  if (type === 'dir') {
    if (feState.expanded.has(rel)) _collapseFolder(rel);
    else _expandFolder(rel);
    feState.selected = { path: rel, type: 'dir', name };
  } else {
    feState.selected = { path: rel, type: 'file', name };
    _loadPreview(rel);
  }
  _renderTree();
  _renderPreviewPane();
}

async function _onRowAction(action, rel, type, name) {
  if (!feState) return;
  if (action === 'rename') return _handleRename(rel, name);
  if (action === 'download') return _handleDownload(rel);
  if (action === 'delete') return _handleDelete(rel, type, name);
}

async function _handleRename(rel, currentName) {
  const newName = await chatShowPrompt('Rename to:', { defaultValue: currentName, title: 'Rename' });
  if (!newName || newName === currentName) return;
  if (/[/\\]/.test(newName)) {
    await chatShowAlert('Name cannot contain "/" or "\\".');
    return;
  }
  const parent = _parentOf(rel);
  const to = _joinRel(parent, newName);
  await _doRename(rel, to, false);
}

async function _doRename(from, to, overwrite) {
  const res = await chatFetch(`workspaces/${encodeURIComponent(feState.hash)}/explorer/rename`, {
    method: 'PATCH',
    body: { from, to, overwrite },
  });
  if (res.status === 409) {
    const ok = await chatShowConfirm('Destination already exists. Overwrite it?', {
      title: 'Overwrite?',
      confirmLabel: 'Overwrite',
      destructive: true,
    });
    if (!ok) return;
    return _doRename(from, to, true);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await chatShowAlert(body.error || `Rename failed (${res.status})`);
    return;
  }
  // Invalidate caches for both parents and reload the current folder.
  feState.children.clear();
  if (feState.selected && feState.selected.path === from) feState.selected = null;
  feState.preview = null;
  await _loadFolder(feState.currentFolder);
  _renderPreviewPane();
}

async function _handleDownload(rel) {
  const url = chatApiUrl(`workspaces/${encodeURIComponent(feState.hash)}/explorer/preview?path=${encodeURIComponent(rel)}&mode=download`);
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function _handleDelete(rel, type, name) {
  const isDir = type === 'dir';
  const msg = isDir
    ? `Permanently delete folder "${name}" and everything in it? This cannot be undone.`
    : `Permanently delete file "${name}"? This cannot be undone.`;
  const ok = await chatShowConfirm(msg, {
    title: 'Delete',
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!ok) return;
  const res = await chatFetch(`workspaces/${encodeURIComponent(feState.hash)}/explorer/entry?path=${encodeURIComponent(rel)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await chatShowAlert(body.error || `Delete failed (${res.status})`);
    return;
  }
  if (feState.selected && (feState.selected.path === rel || feState.selected.path.startsWith(rel + '/'))) {
    feState.selected = null;
    feState.preview = null;
  }
  feState.children.clear();
  await _loadFolder(feState.currentFolder);
  _renderPreviewPane();
}

async function _loadPreview(rel) {
  if (!feState) return;
  const entry = feState.entries.find((e) => e.name === rel.split('/').pop()) || null;
  const selName = feState.selected?.name || rel.split('/').pop();
  const size = entry?.size ?? 0;
  const kind = _previewKind(selName, size);
  feState.preview = { path: rel, name: selName, size, kind, loading: true, content: null, error: null };
  _renderPreviewPane();

  const hash = feState.hash;
  try {
    if (kind === 'text' || kind === 'markdown') {
      const res = await chatFetch(`workspaces/${encodeURIComponent(hash)}/explorer/preview?path=${encodeURIComponent(rel)}&mode=view`);
      if (res.status === 413) {
        feState.preview = { ...feState.preview, kind: 'oversize-text', loading: false };
      } else if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        feState.preview = { ...feState.preview, loading: false, error: body.error || `Failed (${res.status})` };
      } else {
        const data = await res.json();
        feState.preview = { ...feState.preview, loading: false, content: data.content, language: data.language, size: data.size ?? size };
      }
    } else if (kind === 'image') {
      feState.preview = { ...feState.preview, loading: false };
    } else {
      feState.preview = { ...feState.preview, loading: false };
    }
  } catch (err) {
    feState.preview = { ...feState.preview, loading: false, error: err.message || 'Preview failed' };
  }
  _renderPreviewPane();
}

function _renderPreviewPane() {
  const el = document.getElementById('chat-fe-preview-pane');
  if (!el || !feState) return;
  const p = feState.preview;
  if (!p) {
    el.innerHTML = `<div class="chat-fe-preview-empty">Select a file to preview</div>`;
    return;
  }
  if (p.loading) {
    el.innerHTML = `<div class="chat-fe-preview-empty">Loading ${esc(p.name)}…</div>`;
    return;
  }
  if (p.error) {
    el.innerHTML = `
      <div class="chat-fe-preview-header">
        <span class="chat-fe-preview-name">${esc(p.name)}</span>
        <span class="chat-fe-preview-size">${chatFormatFileSize(p.size)}</span>
      </div>
      <div class="chat-fe-preview-body">
        <div class="chat-fe-preview-empty">Error: ${esc(p.error)}</div>
      </div>
    `;
    return;
  }
  const downloadUrl = chatApiUrl(`workspaces/${encodeURIComponent(feState.hash)}/explorer/preview?path=${encodeURIComponent(p.path)}&mode=download`);
  const rawUrl = chatApiUrl(`workspaces/${encodeURIComponent(feState.hash)}/explorer/preview?path=${encodeURIComponent(p.path)}&mode=raw`);
  const editable = (p.kind === 'text' || p.kind === 'markdown') && typeof p.content === 'string';
  const editing = editable && p.editing === true;
  let body = '';
  let actions = '';

  if (p.kind === 'image') {
    body = `<div class="chat-fe-preview-image-wrap"><img src="${esc(rawUrl)}" alt="${esc(p.name)}"></div>`;
  } else if (p.kind === 'oversize-image' || p.kind === 'oversize-text') {
    const limitLabel = p.kind === 'oversize-image' ? '25 MB (image)' : '5 MB (text)';
    body = `<div class="chat-fe-preview-empty">File too large to preview in-browser (limit ${esc(limitLabel)}). Use Download.</div>`;
  } else if (p.kind === 'unsupported') {
    body = `<div class="chat-fe-preview-empty">Preview not supported for this file type. Use Download to view.</div>`;
  } else if (editing) {
    const draft = typeof p.draft === 'string' ? p.draft : (p.content || '');
    body = `<textarea class="chat-fe-preview-editor" id="chat-fe-editor" spellcheck="false">${esc(draft)}</textarea>`;
  } else if (p.kind === 'markdown') {
    const rendered = window.marked ? window.marked.parse(p.content || '') : esc(p.content || '');
    body = `<div class="chat-fe-preview-markdown">${rendered}</div>`;
  } else {
    const lang = p.language || '';
    const textEsc = esc(p.content || '');
    body = `<pre class="chat-fe-preview-code"><code class="language-${esc(lang)}">${textEsc}</code></pre>`;
  }

  if (editable && editing) {
    const savingAttr = p.saving ? ' disabled' : '';
    const saveLabel = p.saving ? 'Saving…' : 'Save';
    actions = `
      <button class="chat-fe-btn chat-fe-btn-primary" id="chat-fe-editor-save"${savingAttr}>${saveLabel}</button>
      <button class="chat-fe-btn" id="chat-fe-editor-cancel"${savingAttr}>Cancel</button>
    `;
  } else if (editable) {
    actions = `<button class="chat-fe-btn" id="chat-fe-editor-edit">${ICON_EDIT} Edit</button>`;
  }

  el.innerHTML = `
    <div class="chat-fe-preview-header">
      <span class="chat-fe-preview-name">${esc(p.name)}</span>
      <span class="chat-fe-preview-size">${chatFormatFileSize(p.size)}</span>
      ${actions}
      <a class="chat-fe-btn" href="${esc(downloadUrl)}" download="${esc(p.name)}">${ICON_DOWNLOAD} Download</a>
    </div>
    <div class="chat-fe-preview-body">${body}</div>
  `;
  if (window.hljs && !editing && p.kind === 'text') {
    el.querySelectorAll('pre code').forEach((block) => { try { window.hljs.highlightElement(block); } catch {} });
  }

  if (editable && editing) {
    const ta = document.getElementById('chat-fe-editor');
    if (ta) {
      ta.addEventListener('input', () => {
        if (!feState || !feState.preview) return;
        feState.preview.draft = ta.value;
      });
      if (!p.saving) ta.focus();
    }
    const saveBtn = document.getElementById('chat-fe-editor-save');
    if (saveBtn) saveBtn.onclick = _handleEditorSave;
    const cancelBtn = document.getElementById('chat-fe-editor-cancel');
    if (cancelBtn) cancelBtn.onclick = _handleEditorCancel;
  } else if (editable) {
    const editBtn = document.getElementById('chat-fe-editor-edit');
    if (editBtn) editBtn.onclick = _handleEditorStart;
  }
}

function _handleEditorStart() {
  if (!feState || !feState.preview) return;
  if (feState.preview.kind !== 'text' && feState.preview.kind !== 'markdown') return;
  feState.preview = { ...feState.preview, editing: true, draft: feState.preview.content || '' };
  _renderPreviewPane();
}

async function _handleEditorCancel() {
  if (!feState || !feState.preview) return;
  const p = feState.preview;
  if (p.saving) return;
  if (typeof p.draft === 'string' && p.draft !== (p.content || '')) {
    const ok = await chatShowConfirm('Discard unsaved changes?', {
      title: 'Discard changes',
      confirmLabel: 'Discard',
      destructive: true,
    });
    if (!ok) return;
  }
  feState.preview = { ...p, editing: false, draft: undefined };
  _renderPreviewPane();
}

async function _handleEditorSave() {
  if (!feState || !feState.preview) return;
  const p = feState.preview;
  if (p.saving) return;
  const draft = typeof p.draft === 'string' ? p.draft : (p.content || '');
  feState.preview = { ...p, saving: true };
  _renderPreviewPane();
  try {
    const res = await chatFetch(`workspaces/${encodeURIComponent(feState.hash)}/explorer/file`, {
      method: 'PUT',
      body: { path: p.path, content: draft },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      await chatShowAlert(body.error || `Save failed (${res.status})`);
      if (feState && feState.preview) {
        feState.preview = { ...feState.preview, saving: false };
        _renderPreviewPane();
      }
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!feState) return;
    feState.preview = {
      ...feState.preview,
      content: draft,
      draft: undefined,
      editing: false,
      saving: false,
      size: typeof data.size === 'number' ? data.size : feState.preview.size,
    };
    feState.children.clear();
    await _loadFolder(feState.currentFolder);
    _renderPreviewPane();
  } catch (err) {
    await chatShowAlert(err && err.message ? err.message : 'Save failed');
    if (feState && feState.preview) {
      feState.preview = { ...feState.preview, saving: false };
      _renderPreviewPane();
    }
  }
}

async function _handleMkdir() {
  if (!feState) return;
  const parent = _uploadTargetFolder();
  const label = parent ? `/${parent}` : '/ (workspace root)';
  const name = await chatShowPrompt(`Create folder inside ${label}:`, {
    title: 'New Folder',
    defaultValue: '',
    confirmLabel: 'Create',
  });
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  if (/[/\\]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    await chatShowAlert('Name cannot contain "/", "\\", "." or "..".');
    return;
  }
  const res = await chatFetch(`workspaces/${encodeURIComponent(feState.hash)}/explorer/mkdir`, {
    method: 'POST',
    body: { parent, name: trimmed },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await chatShowAlert(body.error || `Failed to create folder (${res.status})`);
    return;
  }
  feState.children.delete(parent);
  feState.expanded.add(parent);
  await _loadFolder(feState.currentFolder);
}

async function _handleNewFile() {
  if (!feState) return;
  const parent = _uploadTargetFolder();
  const label = parent ? `/${parent}` : '/ (workspace root)';
  const input = await chatShowPrompt(`Create file inside ${label}:`, {
    title: 'New File',
    defaultValue: 'untitled.md',
    confirmLabel: 'Create',
  });
  if (!input || !input.trim()) return;
  let trimmed = input.trim();
  if (/[/\\]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    await chatShowAlert('Name cannot contain "/", "\\", "." or "..".');
    return;
  }
  if (!trimmed.includes('.')) trimmed += '.md';
  const res = await chatFetch(`workspaces/${encodeURIComponent(feState.hash)}/explorer/file`, {
    method: 'POST',
    body: { parent, name: trimmed },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await chatShowAlert(body.error || `Failed to create file (${res.status})`);
    return;
  }
  const data = await res.json().catch(() => ({}));
  const newRel = data.path || _joinRel(parent, trimmed);
  feState.children.delete(parent);
  feState.expanded.add(parent);
  await _loadFolder(feState.currentFolder);
  feState.selected = { path: newRel, type: 'file', name: trimmed };
  _renderTree();
  await _loadPreview(newRel);
  if (feState.preview && (feState.preview.kind === 'text' || feState.preview.kind === 'markdown')) {
    feState.preview = { ...feState.preview, editing: true, draft: feState.preview.content || '' };
    _renderPreviewPane();
  }
}

async function _goUp() {
  if (!feState) return;
  if (!feState.currentFolder) return;
  await _loadFolder(_parentOf(feState.currentFolder));
}

// ── Upload flow ─────────────────────────────────────────────────────────────

function _uploadTargetFolder() {
  if (!feState) return '';
  if (feState.selected && feState.selected.type === 'dir') return feState.selected.path;
  return feState.currentFolder || '';
}

function _startUploads(files, overrideTarget) {
  const target = overrideTarget ?? _uploadTargetFolder();
  for (const file of files) {
    feState.uploads.push({
      file,
      target,
      loaded: 0,
      total: file.size,
      status: 'queued',
      error: null,
      xhr: null,
    });
  }
  _renderUploadPanel();
  _drainUploads();
}

function _drainUploads() {
  if (!feState) return;
  const MAX = 3;
  const active = feState.uploads.filter((u) => u.status === 'uploading').length;
  let slots = MAX - active;
  for (const u of feState.uploads) {
    if (slots <= 0) break;
    if (u.status !== 'queued') continue;
    u.status = 'uploading';
    slots--;
    _uploadOne(u);
  }
}

async function _uploadOne(u, overwrite = false) {
  if (!state.csrfToken) await fetchCsrfToken();
  await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    u.xhr = xhr;
    const fd = new FormData();
    fd.append('file', u.file);
    const qs = `path=${encodeURIComponent(u.target)}${overwrite ? '&overwrite=true' : ''}`;
    xhr.open('POST', chatApiUrl(`workspaces/${encodeURIComponent(feState.hash)}/explorer/upload?${qs}`));
    xhr.setRequestHeader('x-csrf-token', state.csrfToken || '');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      u.loaded = e.loaded;
      u.total = e.total;
      _throttledRenderUploadPanel();
    };
    xhr.onload = async () => {
      u.xhr = null;
      if (xhr.status === 409) {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch {}
        const ok = await chatShowConfirm(`"${body.filename || u.file.name}" already exists. Overwrite?`, {
          title: 'Overwrite?',
          confirmLabel: 'Overwrite',
          destructive: true,
        });
        if (!ok) {
          u.status = 'skipped';
          u.error = 'Already exists';
          resolve();
          return;
        }
        u.status = 'uploading';
        u.loaded = 0;
        _renderUploadPanel();
        await _uploadOne(u, true);
        resolve();
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        u.status = 'done';
        u.loaded = u.total;
      } else {
        let msg = `HTTP ${xhr.status}`;
        try { const b = JSON.parse(xhr.responseText); if (b?.error) msg = b.error; } catch {}
        u.status = 'error';
        u.error = msg;
      }
      resolve();
    };
    xhr.onerror = () => {
      u.xhr = null;
      u.status = 'error';
      u.error = 'Network error';
      resolve();
    };
    xhr.onabort = () => {
      u.xhr = null;
      u.status = 'error';
      u.error = 'Cancelled';
      resolve();
    };
    xhr.send(fd);
  });
  _renderUploadPanel();
  if (!feState) return;
  const batchDone = !feState.uploads.some((x) => x.status === 'queued' || x.status === 'uploading');
  if (batchDone) {
    // Refresh the tree: something changed in some folder.
    feState.children.clear();
    await _loadFolder(feState.currentFolder);
  }
  _drainUploads();
}

let _uploadRenderRaf = 0;
function _throttledRenderUploadPanel() {
  if (_uploadRenderRaf) return;
  _uploadRenderRaf = requestAnimationFrame(() => {
    _uploadRenderRaf = 0;
    _renderUploadPanel();
  });
}

function _renderUploadPanel() {
  const el = document.getElementById('chat-fe-upload-panel');
  if (!el || !feState) return;
  if (!feState.uploads.length) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  const hasActive = feState.uploads.some((u) => u.status === 'queued' || u.status === 'uploading');
  el.style.display = '';
  const done = feState.uploads.filter((u) => u.status === 'done').length;
  const total = feState.uploads.length;
  const itemsHtml = feState.uploads.slice(-8).map((u) => {
    const pct = u.total ? Math.round((u.loaded / u.total) * 100) : 0;
    let badge = '';
    if (u.status === 'done') badge = '<span class="chat-fe-upload-badge done">Done</span>';
    else if (u.status === 'error') badge = `<span class="chat-fe-upload-badge error">${esc(u.error || 'Failed')}</span>`;
    else if (u.status === 'skipped') badge = '<span class="chat-fe-upload-badge">Skipped</span>';
    else if (u.status === 'uploading') badge = `<span class="chat-fe-upload-badge">${pct}%</span>`;
    else badge = '<span class="chat-fe-upload-badge">Queued</span>';
    return `
      <div class="chat-fe-upload-row">
        <div class="chat-fe-upload-name" title="${esc(u.file.name)}">${esc(u.file.name)}</div>
        <div class="chat-fe-upload-bar"><div class="chat-fe-upload-bar-fill" style="width:${pct}%;"></div></div>
        ${badge}
      </div>
    `;
  }).join('');
  el.innerHTML = `
    <div class="chat-fe-upload-header">
      <span>Uploads: ${done}/${total}${hasActive ? '' : ' — done'}</span>
      <button class="chat-fe-upload-clear" id="chat-fe-upload-clear">Clear</button>
    </div>
    ${itemsHtml}
  `;
  const clear = document.getElementById('chat-fe-upload-clear');
  if (clear) clear.onclick = () => {
    if (!feState) return;
    feState.uploads = feState.uploads.filter((u) => u.status === 'queued' || u.status === 'uploading');
    _renderUploadPanel();
  };
}

// ── Drag and drop ───────────────────────────────────────────────────────────

function _onDragOver(e) {
  if (!_dragHasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const pane = document.querySelector('.chat-fe-tree-pane');
  if (pane) pane.classList.add('drag-over');
}

function _onDragLeave(e) {
  if (e.target !== e.currentTarget) return;
  const pane = document.querySelector('.chat-fe-tree-pane');
  if (pane) pane.classList.remove('drag-over');
}

function _onDrop(e) {
  if (!_dragHasFiles(e)) return;
  e.preventDefault();
  const pane = document.querySelector('.chat-fe-tree-pane');
  if (pane) pane.classList.remove('drag-over');
  // If the drop target is a row, _onRowDrop handles it instead.
  if (e.target.closest('.chat-fe-row')) return;
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) _startUploads(files);
}

function _onRowDragOver(e) {
  if (!_dragHasFiles(e)) return;
  const row = e.currentTarget;
  if (row.dataset.feType !== 'dir') return;
  e.preventDefault();
  e.stopPropagation();
  row.classList.add('drop-target');
}

function _onRowDragLeave(e) {
  e.currentTarget.classList.remove('drop-target');
}

function _onRowDrop(e) {
  if (!_dragHasFiles(e)) return;
  const row = e.currentTarget;
  row.classList.remove('drop-target');
  if (row.dataset.feType !== 'dir') return;
  e.preventDefault();
  e.stopPropagation();
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) _startUploads(files, row.dataset.feRel);
}

function _dragHasFiles(e) {
  if (!e.dataTransfer) return false;
  return Array.from(e.dataTransfer.types || []).includes('Files');
}
