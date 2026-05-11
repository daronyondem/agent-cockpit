import React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { AgentApi } from '../api.js';
import { Ico } from '../icons.jsx';
import { useDialog } from '../dialog.jsx';

/* Files Browser — modal-swap over the chat main pane.
   Full-screen workspace file explorer: lazy-loaded tree, preview/edit pane,
   CRUD via the anchored Dialog system (useDialog hook), multi-file upload
   with 3-concurrency progress, drag-and-drop onto the tree pane. */

const TEXT_EXTS = new Set(['txt','md','markdown','json','yaml','yml','xml','csv','tsv','log','ini','conf','env','html','htm','css','js','ts','tsx','jsx','py','sh','bash','zsh','go','rs','java','c','cpp','h','hpp','sql','toml','rb','php','swift','kt','scala','r','lua','pl','gitignore','gitattributes','dockerignore','editorconfig']);
const MD_EXTS = new Set(['md','markdown']);
const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','ico']);
const IMAGE_PREVIEW_LIMIT = 25 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 3;

const FX_WIDTH_STORAGE_PREFIX = 'ac:v2:fx-tree-width:';
const FX_WIDTH_DEFAULT = 220;
const FX_WIDTH_MIN = 140;
const FX_WIDTH_MAX = 600;

function loadFxWidth(hash){
  try {
    const raw = window.localStorage.getItem(FX_WIDTH_STORAGE_PREFIX + hash);
    if (!raw) return FX_WIDTH_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return FX_WIDTH_DEFAULT;
    return Math.max(FX_WIDTH_MIN, Math.min(FX_WIDTH_MAX, Math.round(n)));
  } catch { return FX_WIDTH_DEFAULT; }
}

function saveFxWidth(hash, width){
  try {
    window.localStorage.setItem(FX_WIDTH_STORAGE_PREFIX + hash, String(Math.round(width)));
  } catch {}
}

function extOf(name){
  const i = (name || '').lastIndexOf('.');
  if (i < 0) return (name || '').toLowerCase().replace(/^\./, '');
  return (name || '').slice(i + 1).toLowerCase();
}

function previewKind(name, size){
  const e = extOf(name);
  if (IMAGE_EXTS.has(e)) return (size || 0) > IMAGE_PREVIEW_LIMIT ? 'oversize-image' : 'image';
  if (MD_EXTS.has(e)) return 'markdown';
  if (TEXT_EXTS.has(e)) return 'text';
  return 'unsupported';
}

function joinRel(parent, name){ return parent ? `${parent}/${name}` : name; }
function parentOf(rel){
  if (!rel) return '';
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

function formatBytes(bytes){
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function renderFileMd(md){
  if (!md) return '';
  const raw = marked.parse(String(md), { breaks: true, gfm: true });
  return DOMPurify.sanitize(raw);
}

export function FilesBrowser({ hash, label, onClose }){
  const dialog = useDialog();
  const [currentFolder, setCurrentFolder] = React.useState('');
  const [entries, setEntries] = React.useState([]);
  const [childrenMap, setChildrenMap] = React.useState(() => new Map());
  const [expanded, setExpanded] = React.useState(() => new Set(['']));
  const [selected, setSelected] = React.useState(null); // { path, type, name }
  const [preview, setPreview] = React.useState(null);   // { path, name, size, kind, loading, content, language, editing, draft, saving, error }
  const [uploads, setUploads] = React.useState([]);     // [{ id, file, target, loaded, total, status, error, xhr }]
  const [err, setErr] = React.useState(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [treeWidth, setTreeWidth] = React.useState(() => loadFxWidth(hash));
  const [resizing, setResizing] = React.useState(false);

  React.useEffect(() => { setTreeWidth(loadFxWidth(hash)); }, [hash]);

  const treeWidthRef = React.useRef(treeWidth);
  treeWidthRef.current = treeWidth;

  const onResizerMouseDown = React.useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeWidthRef.current;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      const next = Math.max(FX_WIDTH_MIN, Math.min(FX_WIDTH_MAX, startW + (ev.clientX - startX)));
      setTreeWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
      saveFxWidth(hash, treeWidthRef.current);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [hash]);

  const onResizerDoubleClick = React.useCallback(() => {
    setTreeWidth(FX_WIDTH_DEFAULT);
    saveFxWidth(hash, FX_WIDTH_DEFAULT);
  }, [hash]);

  /* ----- tree loading ----- */
  const loadFolder = React.useCallback(async (rel) => {
    try {
      const data = await AgentApi.explorer.tree(hash, rel || '');
      setCurrentFolder(data.path || '');
      setEntries(data.entries || []);
      setChildrenMap(prev => {
        const next = new Map(prev);
        next.set(data.path || '', data.entries || []);
        return next;
      });
      setExpanded(prev => {
        const next = new Set(prev);
        next.add(data.path || '');
        return next;
      });
      setErr(null);
    } catch (e) {
      setErr(e.message || String(e));
    }
  }, [hash]);

  React.useEffect(() => { loadFolder(''); }, [loadFolder]);

  const currentFolderRef = React.useRef(currentFolder);
  currentFolderRef.current = currentFolder;

  /* Refresh a single folder's children in the map in place. Used after any
     mutation so only the affected branch is re-fetched — avoids the
     "clear whole map + reload currentFolder" pattern that left sibling/child
     branches rendering empty when the mutation targeted a non-current folder. */
  const refreshBranch = React.useCallback(async (rel) => {
    try {
      const data = await AgentApi.explorer.tree(hash, rel || '');
      const key = data.path || rel || '';
      setChildrenMap(prev => {
        const next = new Map(prev);
        next.set(key, data.entries || []);
        return next;
      });
      if (key === (currentFolderRef.current || '')) {
        setEntries(data.entries || []);
      }
      setErr(null);
    } catch (e) {
      setErr(e.message || String(e));
    }
  }, [hash]);

  const expandFolder = React.useCallback(async (rel) => {
    if (!childrenMap.has(rel)) {
      try {
        const data = await AgentApi.explorer.tree(hash, rel);
        setChildrenMap(prev => {
          const next = new Map(prev);
          next.set(data.path || rel, data.entries || []);
          return next;
        });
      } catch (e) {
        setErr(e.message || String(e));
        return;
      }
    }
    setExpanded(prev => {
      const next = new Set(prev);
      next.add(rel);
      return next;
    });
  }, [hash, childrenMap]);

  const collapseFolder = React.useCallback((rel) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.delete(rel);
      return next;
    });
  }, []);

  const refreshAll = React.useCallback(async () => {
    setChildrenMap(new Map());
    await loadFolder(currentFolder);
  }, [currentFolder, loadFolder]);

  /* ----- preview loading ----- */
  const loadPreview = React.useCallback(async (rel, entry) => {
    const name = entry ? entry.name : rel.split('/').pop();
    const size = entry ? entry.size : 0;
    const kind = previewKind(name, size);
    const base = { path: rel, name, size, kind, loading: true, content: null, language: null, editing: false, draft: undefined, saving: false, error: null };
    setPreview(base);
    if (kind === 'text' || kind === 'markdown') {
      try {
        const data = await AgentApi.explorer.preview(hash, rel);
        setPreview({ ...base, loading: false, content: data.content || '', language: data.language || null, size: typeof data.size === 'number' ? data.size : size });
      } catch (e) {
        if (e.status === 413) {
          setPreview({ ...base, loading: false, kind: 'oversize-text' });
        } else {
          setPreview({ ...base, loading: false, error: e.message || 'Preview failed' });
        }
      }
    } else {
      setPreview({ ...base, loading: false });
    }
  }, [hash]);

  const handleRowClick = React.useCallback((rel, type, name) => {
    if (type === 'dir') {
      if (expanded.has(rel)) collapseFolder(rel);
      else expandFolder(rel);
      setSelected({ path: rel, type: 'dir', name });
    } else {
      setSelected({ path: rel, type: 'file', name });
      const parent = parentOf(rel);
      const siblings = childrenMap.get(parent) || entries;
      const entry = siblings.find(e => e.name === name) || null;
      loadPreview(rel, entry);
    }
  }, [expanded, expandFolder, collapseFolder, childrenMap, entries, loadPreview]);

  /* ----- toolbar actions ----- */
  const targetFolder = React.useCallback(() => {
    if (selected && selected.type === 'dir') return selected.path;
    return currentFolder || '';
  }, [selected, currentFolder]);

  const doMkdir = React.useCallback(async (anchor) => {
    const parent = targetFolder();
    const raw = await dialog.prompt({
      anchor,
      title: 'New folder',
      inputLabel: `Create inside ${parent ? '/' + parent : '/ (workspace root)'}`,
      placeholder: 'folder name',
      confirmLabel: 'Create',
    });
    if (raw == null) return;
    const name = raw.trim();
    if (!name) return;
    if (/[/\\]/.test(name) || name === '.' || name === '..') {
      await dialog.alert({ anchor, variant: 'error', title: 'Invalid name', body: 'Name cannot contain "/", "\\", "." or "..".' });
      return;
    }
    try {
      await AgentApi.explorer.mkdir(hash, parent, name);
      setExpanded(prev => {
        const next = new Set(prev);
        next.add(parent);
        return next;
      });
      await refreshBranch(parent);
    } catch (e) {
      await dialog.alert({ anchor, variant: 'error', title: 'Failed to create folder', body: e.message || 'Unknown error' });
    }
  }, [hash, targetFolder, refreshBranch, dialog]);

  const doNewFile = React.useCallback(async (anchor) => {
    const parent = targetFolder();
    const raw = await dialog.prompt({
      anchor,
      title: 'New file',
      inputLabel: `Create inside ${parent ? '/' + parent : '/ (workspace root)'}`,
      inputDefault: 'untitled.md',
      placeholder: 'filename',
      confirmLabel: 'Create',
    });
    if (raw == null) return;
    let name = raw.trim();
    if (!name) return;
    if (/[/\\]/.test(name) || name === '.' || name === '..') {
      await dialog.alert({ anchor, variant: 'error', title: 'Invalid name', body: 'Name cannot contain "/", "\\", "." or "..".' });
      return;
    }
    if (!name.includes('.')) name += '.md';
    try {
      const data = await AgentApi.explorer.createFile(hash, parent, name, '');
      const newRel = data.path || joinRel(parent, name);
      setExpanded(prev => {
        const next = new Set(prev);
        next.add(parent);
        return next;
      });
      await refreshBranch(parent);
      setSelected({ path: newRel, type: 'file', name });
      await loadPreview(newRel, { name, size: 0 });
      setPreview(p => p ? { ...p, editing: true, draft: p.content || '' } : p);
    } catch (e) {
      await dialog.alert({ anchor, variant: 'error', title: 'Failed to create file', body: e.message || 'Unknown error' });
    }
  }, [hash, targetFolder, refreshBranch, loadPreview, dialog]);

  const doRename = React.useCallback(async (rel, currentName, anchor) => {
    const raw = await dialog.prompt({
      anchor,
      title: 'Rename',
      inputLabel: `Rename "${currentName}" to`,
      inputDefault: currentName,
      confirmLabel: 'Rename',
    });
    if (raw == null || raw === currentName || !raw.trim()) return;
    if (/[/\\]/.test(raw)) {
      await dialog.alert({ anchor, variant: 'error', title: 'Invalid name', body: 'Name cannot contain "/" or "\\".' });
      return;
    }
    const parent = parentOf(rel);
    const to = joinRel(parent, raw);
    const attempt = async (overwrite) => {
      try {
        await AgentApi.explorer.rename(hash, rel, to, overwrite);
        if (selected && selected.path === rel) setSelected(null);
        if (preview && preview.path === rel) setPreview(null);
        await refreshBranch(parent);
      } catch (e) {
        if (e.status === 409) {
          const ok = await dialog.confirm({
            anchor,
            title: 'Destination exists',
            body: 'Overwrite the existing file?',
            confirmLabel: 'Overwrite',
            destructive: true,
          });
          if (ok) await attempt(true);
          return;
        }
        await dialog.alert({ anchor, variant: 'error', title: 'Rename failed', body: e.message || 'Unknown error' });
      }
    };
    await attempt(false);
  }, [hash, selected, preview, refreshBranch, dialog]);

  const doDelete = React.useCallback(async (rel, type, name, anchor) => {
    const body = type === 'dir'
      ? `Permanently delete folder "${name}" and everything in it? This cannot be undone.`
      : `Permanently delete file "${name}"? This cannot be undone.`;
    const ok = await dialog.confirm({
      anchor,
      title: type === 'dir' ? 'Delete folder?' : 'Delete file?',
      body,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await AgentApi.explorer.deleteEntry(hash, rel);
      if (selected && (selected.path === rel || selected.path.startsWith(rel + '/'))) setSelected(null);
      if (preview && (preview.path === rel || preview.path.startsWith(rel + '/'))) setPreview(null);
      await refreshBranch(parentOf(rel));
    } catch (e) {
      await dialog.alert({ anchor, variant: 'error', title: 'Delete failed', body: e.message || 'Unknown error' });
    }
  }, [hash, selected, preview, refreshBranch, dialog]);

  const doDownload = React.useCallback((rel) => {
    const url = AgentApi.explorer.downloadUrl(hash, rel);
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [hash]);

  /* ----- uploads ----- */
  const uploadsRef = React.useRef(uploads);
  uploadsRef.current = uploads;

  const updateUpload = React.useCallback((id, patch) => {
    setUploads(prev => prev.map(u => u.id === id ? { ...u, ...patch } : u));
  }, []);

  const runUpload = React.useCallback(async (upload, overwrite) => {
    try {
      await AgentApi.explorer.upload(
        hash,
        upload.target,
        upload.file,
        overwrite,
        (loaded, total) => updateUpload(upload.id, { loaded, total })
      );
      updateUpload(upload.id, { status: 'done', loaded: upload.total });
      await refreshBranch(upload.target);
    } catch (e) {
      if (e.status === 409) {
        const ok = await dialog.confirm({
          title: 'File exists',
          body: `"${upload.file.name}" already exists. Overwrite?`,
          confirmLabel: 'Overwrite',
          destructive: true,
        });
        if (ok) {
          updateUpload(upload.id, { status: 'uploading', loaded: 0 });
          await runUpload(upload, true);
          return;
        }
        updateUpload(upload.id, { status: 'skipped', error: 'Already exists' });
      } else {
        updateUpload(upload.id, { status: 'error', error: e.message || 'Upload failed' });
      }
    }
  }, [hash, updateUpload, refreshBranch, dialog]);

  const drainUploads = React.useCallback(() => {
    const list = uploadsRef.current;
    const activeCount = list.filter(u => u.status === 'uploading').length;
    let slots = UPLOAD_CONCURRENCY - activeCount;
    const toStart = [];
    for (const u of list) {
      if (slots <= 0) break;
      if (u.status !== 'queued') continue;
      toStart.push(u);
      slots--;
    }
    if (!toStart.length) return;
    setUploads(prev => prev.map(u => toStart.find(t => t.id === u.id) ? { ...u, status: 'uploading' } : u));
    for (const u of toStart) {
      runUpload({ ...u, status: 'uploading' }, false).then(() => { drainUploads(); });
    }
  }, [runUpload]);

  const startUploads = React.useCallback((files, overrideTarget) => {
    const target = overrideTarget != null ? overrideTarget : targetFolder();
    const fresh = Array.from(files).map(file => ({
      id: `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      target,
      loaded: 0,
      total: file.size,
      status: 'queued',
      error: null,
    }));
    setUploads(prev => prev.concat(fresh));
    setTimeout(drainUploads, 0);
  }, [targetFolder, drainUploads]);

  const clearDoneUploads = React.useCallback(() => {
    setUploads(prev => prev.filter(u => u.status === 'queued' || u.status === 'uploading'));
  }, []);

  /* Auto-dismiss the progress panel after uploads finish. Once no upload is
     queued or in progress, clear the 'done' rows (keep 'error' / 'skipped'
     so the user can still see what failed). 1 s delay gives the user a
     glimpse of the "Done" badge before the row disappears. */
  React.useEffect(() => {
    if (!uploads.length) return;
    const active = uploads.some(u => u.status === 'queued' || u.status === 'uploading');
    if (active) return;
    if (!uploads.some(u => u.status === 'done')) return;
    const t = setTimeout(() => {
      setUploads(prev => {
        const filtered = prev.filter(u => u.status !== 'done');
        return filtered.length === prev.length ? prev : filtered;
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [uploads]);

  /* ----- editor actions ----- */
  const startEdit = React.useCallback(() => {
    setPreview(p => p ? { ...p, editing: true, draft: p.content || '' } : p);
  }, []);

  const cancelEdit = React.useCallback(async (anchor) => {
    if (!preview || preview.saving) return;
    if (typeof preview.draft === 'string' && preview.draft !== (preview.content || '')) {
      const ok = await dialog.confirm({
        anchor,
        title: 'Discard unsaved changes?',
        body: 'Your edits to this file will be lost.',
        confirmLabel: 'Discard',
        destructive: true,
      });
      if (!ok) return;
    }
    setPreview(prev => prev ? { ...prev, editing: false, draft: undefined } : prev);
  }, [preview, dialog]);

  const saveEdit = React.useCallback(async (anchor) => {
    const p = preview;
    if (!p || p.saving) return;
    const draft = typeof p.draft === 'string' ? p.draft : (p.content || '');
    setPreview({ ...p, saving: true });
    try {
      const data = await AgentApi.explorer.saveFile(hash, p.path, draft);
      setPreview(prev => prev ? {
        ...prev,
        content: draft,
        draft: undefined,
        editing: false,
        saving: false,
        size: typeof data.size === 'number' ? data.size : prev.size,
      } : prev);
      await refreshBranch(parentOf(p.path));
    } catch (e) {
      await dialog.alert({ anchor, variant: 'error', title: 'Save failed', body: e.message || 'Unknown error' });
      setPreview(prev => prev ? { ...prev, saving: false } : prev);
    }
  }, [preview, hash, refreshBranch, dialog]);

  /* ----- drag-and-drop on tree pane ----- */
  const onPaneDragOver = React.useCallback((e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }, []);

  const onPaneDragLeave = React.useCallback((e) => {
    if (e.target !== e.currentTarget) return;
    setDragOver(false);
  }, []);

  const onPaneDrop = React.useCallback((e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    setDragOver(false);
    if (e.target.closest && e.target.closest('.fx-tree-row[data-dir="1"]')) {
      const row = e.target.closest('.fx-tree-row[data-dir="1"]');
      const rel = row.getAttribute('data-rel') || '';
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) startUploads(files, rel);
      return;
    }
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) startUploads(files);
  }, [startUploads]);

  /* ----- render ----- */
  const rootEntries = childrenMap.get(currentFolder) || entries;
  const crumbs = currentFolder ? currentFolder.split('/') : [];
  const fileInputRef = React.useRef(null);

  const onUploadClick = () => { if (fileInputRef.current) fileInputRef.current.click(); };
  const onUploadInputChange = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) startUploads(files);
    e.target.value = '';
  };

  return (
    <div className="fx fx-live" style={{'--fx-tree-w': treeWidth + 'px'}}>
      <div className="fx-top">
        <span style={{display:"inline-flex",alignItems:"center",gap:8}}>
          <span style={{width:18,height:18,borderRadius:4,background:"var(--accent-soft)",display:"inline-flex",alignItems:"center",justifyContent:"center",color:"var(--accent)"}}>
            {Ico.folder(12)}
          </span>
          <span className="u-mono" style={{fontSize:12}}>Files</span>
        </span>
        <span className="path">
          <span
            className="fx-crumb"
            role="button"
            tabIndex={0}
            onClick={() => loadFolder('')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadFolder(''); } }}
          >{label || 'workspace'}</span>
          {crumbs.map((p, i) => {
            const rel = crumbs.slice(0, i + 1).join('/');
            const isLast = i === crumbs.length - 1;
            return (
              <React.Fragment key={rel}>
                <span className="slash">/</span>
                <span
                  className="fx-crumb"
                  role="button"
                  tabIndex={0}
                  style={isLast ? { color: 'var(--text)' } : undefined}
                  onClick={() => loadFolder(rel)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadFolder(rel); } }}
                >{p}</span>
              </React.Fragment>
            );
          })}
        </span>
        <span style={{marginLeft:"auto",display:"flex",gap:6}}>
          <button className="btn ghost" style={{padding:"4px 8px"}} onClick={refreshAll} title="Refresh">{Ico.reset(12)}</button>
          <button className="btn ghost" style={{padding:"4px 8px"}} onClick={(e) => doMkdir(e.currentTarget)} title="New folder">{Ico.folder(12)} New folder</button>
          <button className="btn ghost" style={{padding:"4px 8px"}} onClick={(e) => doNewFile(e.currentTarget)} title="New file">{Ico.fileAdd(12)} New file</button>
          <button className="btn primary" style={{padding:"4px 10px"}} onClick={onUploadClick} title="Upload files">{Ico.upload(12)} Upload</button>
          <input ref={fileInputRef} type="file" multiple style={{display:"none"}} onChange={onUploadInputChange}/>
          <button className="btn" onClick={onClose}>Close</button>
        </span>
      </div>

      <div
        className={`fx-tree ${dragOver ? 'drag-over' : ''}`}
        onDragOver={onPaneDragOver}
        onDragLeave={onPaneDragLeave}
        onDrop={onPaneDrop}
      >
        {err ? (
          <div className="u-err" style={{padding:"12px 8px",fontSize:12}}>{err}</div>
        ) : null}
        <FxTreeBranch
          parentRel={currentFolder}
          entries={rootEntries}
          depth={0}
          expanded={expanded}
          childrenMap={childrenMap}
          selectedPath={selected ? selected.path : null}
          onRowClick={handleRowClick}
          onRename={doRename}
          onDelete={doDelete}
          onDownload={doDownload}
        />
        {uploads.length ? (
          <FxUploadPanel uploads={uploads} onClear={clearDoneUploads}/>
        ) : null}
      </div>

      <div
        className={"fx-resizer" + (resizing ? " dragging" : "")}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize · double-click to reset"
        onMouseDown={onResizerMouseDown}
        onDoubleClick={onResizerDoubleClick}
      />

      <div className="fx-edit">
        <FxPreviewPane
          preview={preview}
          hash={hash}
          onStartEdit={startEdit}
          onCancelEdit={cancelEdit}
          onSaveEdit={saveEdit}
          onDraftChange={(v) => setPreview(p => p ? { ...p, draft: v } : p)}
          onDownload={doDownload}
        />
      </div>
    </div>
  );
}

function FxTreeBranch({ parentRel, entries, depth, expanded, childrenMap, selectedPath, onRowClick, onRename, onDelete, onDownload }){
  if (!entries || !entries.length) {
    return depth === 0 ? (
      <div className="u-dim" style={{padding:"10px 8px",fontSize:12}}>Empty folder</div>
    ) : null;
  }
  return (
    <>
      {entries.map(e => {
        const rel = joinRel(parentRel, e.name);
        const isDir = e.type === 'dir';
        const isExpanded = isDir && expanded.has(rel);
        const isSelected = selectedPath === rel;
        return (
          <React.Fragment key={rel}>
            <FxTreeRow
              rel={rel}
              name={e.name}
              isDir={isDir}
              size={e.size}
              isExpanded={isExpanded}
              isSelected={isSelected}
              depth={depth}
              onClick={() => onRowClick(rel, e.type, e.name)}
              onRename={(anchor) => onRename(rel, e.name, anchor)}
              onDelete={(anchor) => onDelete(rel, e.type, e.name, anchor)}
              onDownload={() => onDownload(rel)}
            />
            {isDir && isExpanded ? (
              <FxTreeBranch
                parentRel={rel}
                entries={childrenMap.get(rel) || []}
                depth={depth + 1}
                expanded={expanded}
                childrenMap={childrenMap}
                selectedPath={selectedPath}
                onRowClick={onRowClick}
                onRename={onRename}
                onDelete={onDelete}
                onDownload={onDownload}
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </>
  );
}

function FxTreeRow({ rel, name, isDir, size, isExpanded, isSelected, depth, onClick, onRename, onDelete, onDownload }){
  const indent = depth * 14;
  const chev = isDir
    ? (isExpanded ? Ico.chevD(12) : Ico.chev(12))
    : null;
  return (
    <div
      className={`fx-tree-row ${isSelected ? 'active' : ''} ${isDir ? 'folder' : ''}`}
      data-rel={rel}
      data-dir={isDir ? '1' : '0'}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={{paddingLeft: 6 + indent}}
      title={name}
    >
      <span className="fx-tree-chev">{chev}</span>
      <span className="fx-tree-ico">{isDir ? Ico.folder(12) : Ico.file(12)}</span>
      <span className="fx-tree-name">{name}</span>
      {!isDir && size != null ? <span className="fx-tree-size u-mono u-dim">{formatBytes(size)}</span> : null}
      <span className="fx-tree-actions">
        <button
          className="iconbtn"
          title="Rename"
          onClick={(e) => { e.stopPropagation(); onRename(e.currentTarget); }}
        >{Ico.edit(12)}</button>
        {!isDir ? (
          <button
            className="iconbtn"
            title="Download"
            onClick={(e) => { e.stopPropagation(); onDownload(); }}
          >{Ico.download(12)}</button>
        ) : null}
        <button
          className="iconbtn danger"
          title="Delete"
          onClick={(e) => { e.stopPropagation(); onDelete(e.currentTarget); }}
        >{Ico.trash(12)}</button>
      </span>
    </div>
  );
}

function FxUploadPanel({ uploads, onClear }){
  const done = uploads.filter(u => u.status === 'done').length;
  const total = uploads.length;
  const active = uploads.some(u => u.status === 'queued' || u.status === 'uploading');
  return (
    <div className="fx-uploads">
      <div className="fx-uploads-head">
        <span className="u-mono" style={{fontSize:11}}>Uploads: {done}/{total}{active ? '' : ' — done'}</span>
        <button className="btn ghost" style={{padding:"2px 8px",fontSize:11}} onClick={onClear}>Clear</button>
      </div>
      {uploads.slice(-8).map(u => {
        const pct = u.total ? Math.round((u.loaded / u.total) * 100) : 0;
        let badge;
        if (u.status === 'done') badge = <span className="fx-uploads-badge done">Done</span>;
        else if (u.status === 'error') badge = <span className="fx-uploads-badge err">{u.error || 'Failed'}</span>;
        else if (u.status === 'skipped') badge = <span className="fx-uploads-badge">Skipped</span>;
        else if (u.status === 'uploading') badge = <span className="fx-uploads-badge">{pct}%</span>;
        else badge = <span className="fx-uploads-badge">Queued</span>;
        return (
          <div key={u.id} className="fx-uploads-row">
            <div className="fx-uploads-name" title={u.file.name}>{u.file.name}</div>
            <div className="fx-uploads-bar"><div className="fx-uploads-bar-fill" style={{width: `${pct}%`}}/></div>
            {badge}
          </div>
        );
      })}
    </div>
  );
}

function FxPreviewPane({ preview, hash, onStartEdit, onCancelEdit, onSaveEdit, onDraftChange, onDownload }){
  if (!preview) {
    return (
      <div style={{padding:"24px 18px"}} className="u-dim">Select a file to preview</div>
    );
  }
  if (preview.loading) {
    return (
      <div style={{padding:"24px 18px"}} className="u-dim">Loading {preview.name}…</div>
    );
  }
  if (preview.error) {
    return (
      <>
        <div className="fx-edit-head">
          <span className="filename">{preview.name}</span>
          <span className="u-mono u-dim" style={{fontSize:10.5}}>{formatBytes(preview.size)}</span>
          <span className="spacer" style={{flex:1}}/>
          <button className="btn" onClick={() => onDownload(preview.path)}>{Ico.download(12)} Download</button>
        </div>
        <div className="fx-edit-body">
          <div className="u-err">Error: {preview.error}</div>
        </div>
      </>
    );
  }

  const editable = (preview.kind === 'text' || preview.kind === 'markdown') && typeof preview.content === 'string';
  const editing = editable && preview.editing;
  const dirty = editing && typeof preview.draft === 'string' && preview.draft !== (preview.content || '');

  return (
    <>
      <div className="fx-edit-head">
        <span className="filename">{preview.name}</span>
        <span className="u-mono u-dim" style={{fontSize:10.5}}>
          {formatBytes(preview.size)}{preview.language ? ` · ${preview.language}` : ''}
        </span>
        <span className="spacer" style={{flex:1}}/>
        {editing ? (
          <>
            <span className={`saved ${dirty ? 'dirty' : ''}`}>{dirty ? '● unsaved' : '● saved'}</span>
            <button className="btn ghost" onClick={(e) => onCancelEdit(e.currentTarget)} disabled={preview.saving}>Cancel</button>
            <button className="btn primary" onClick={(e) => onSaveEdit(e.currentTarget)} disabled={preview.saving}>{preview.saving ? 'Saving…' : 'Save'}</button>
          </>
        ) : editable ? (
          <button className="btn ghost" onClick={onStartEdit}>{Ico.edit(12)} Edit</button>
        ) : null}
        <button className="btn" onClick={() => onDownload(preview.path)}>{Ico.download(12)} Download</button>
      </div>
      <div className="fx-edit-body">
        {preview.kind === 'image' ? (
          <div style={{display:"flex",justifyContent:"center",padding:"8px"}}>
            <img
              src={AgentApi.explorer.rawUrl(hash, preview.path)}
              alt={preview.name}
              style={{maxWidth:"100%",maxHeight:"70vh",height:"auto"}}
            />
          </div>
        ) : preview.kind === 'oversize-image' ? (
          <div className="u-dim">File too large to preview in-browser (limit 25 MB). Use Download.</div>
        ) : preview.kind === 'oversize-text' ? (
          <div className="u-dim">File too large to preview in-browser (limit 5 MB). Use Download.</div>
        ) : preview.kind === 'unsupported' ? (
          <div className="u-dim">Preview not supported for this file type. Use Download.</div>
        ) : editing ? (
          <textarea
            className="fx-editor"
            spellCheck={false}
            value={typeof preview.draft === 'string' ? preview.draft : (preview.content || '')}
            onChange={(e) => onDraftChange(e.target.value)}
            autoFocus
          />
        ) : preview.kind === 'markdown' ? (
          <div className="prose" dangerouslySetInnerHTML={{ __html: renderFileMd(preview.content || '') }}/>
        ) : (
          <pre className="fx-code"><code>{preview.content || ''}</code></pre>
        )}
      </div>
    </>
  );
}
