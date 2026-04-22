/* global React, Ico, AgentApi */

/* ---------- FolderPicker — used by the sidebar's "New conversation" action. ---------- */
/* Mirrors V1's chatShowFolderPicker (navigate dirs via GET /browse, create via POST */
/* /mkdir, delete via POST /rmdir). `onSelect(path)` fires with the chosen folder; */
/* `onUseDefault()` fires with no workingDir so the server picks its own default. */
function FolderPicker({ open, onClose, onSelect, onUseDefault, busy = false }){
  const [data, setData] = React.useState(null);      // { currentPath, parent, dirs } | null
  const [showHidden, setShowHidden] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [newFolderName, setNewFolderName] = React.useState(null); // null = hidden, string = input value
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const newFolderInputRef = React.useRef(null);

  const load = React.useCallback(async (path) => {
    setLoading(true); setErr(null);
    try {
      const d = await AgentApi.browseDir(path, showHidden);
      setData(d);
      setConfirmDelete(false);
      setNewFolderName(null);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [showHidden]);

  // Initial load when the picker opens; reset state when it closes.
  React.useEffect(() => {
    if (!open) { setData(null); setErr(null); setNewFolderName(null); setConfirmDelete(false); return; }
    load('');
  }, [open, load]);

  // Reload current folder when showHidden flips.
  React.useEffect(() => {
    if (!open || !data) return;
    load(data.currentPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  // Escape closes the modal (unless a sub-input has the key).
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, busy]);

  React.useEffect(() => {
    if (newFolderName !== null && newFolderInputRef.current) {
      newFolderInputRef.current.focus();
    }
  }, [newFolderName]);

  if (!open) return null;

  async function submitNewFolder(){
    const name = (newFolderName || '').trim();
    if (!name || !data) return;
    try {
      const res = await AgentApi.mkdirDir(data.currentPath, name);
      await load(res.created || data.currentPath);
    } catch (e) {
      setErr(e.message || 'Failed to create folder');
    }
  }

  async function submitDelete(){
    if (!data || !data.parent) return;
    try {
      await AgentApi.rmdirDir(data.currentPath);
      await load(data.parent);
    } catch (e) {
      setErr(e.message || 'Failed to delete folder');
      setConfirmDelete(false);
    }
  }

  const currentName = data ? (data.currentPath.split('/').pop() || data.currentPath) : '';

  return (
    <div className="fp-scrim" onClick={busy ? undefined : onClose}>
      <div className="fp-panel" role="dialog" aria-modal="true" aria-label="Select working directory" onClick={(e) => e.stopPropagation()}>
        <div className="fp-head">
          <span className="fp-title">Select working directory</span>
          <button className="fp-close" type="button" aria-label="Close" title="Close" onClick={onClose} disabled={busy}>{Ico.x(14)}</button>
        </div>

        <div className="fp-pathrow">
          <div className="fp-path" title={data ? data.currentPath : ''}>
            {err ? <span className="fp-err">⚠ {err}</span> : (data ? data.currentPath : 'Loading…')}
          </div>
          <div className="fp-pathactions">
            {data && data.parent ? (
              <button className="fp-iconbtn" type="button" title="Go to parent folder" onClick={() => load(data.parent)} disabled={loading || busy}>{Ico.up(12)}</button>
            ) : null}
            {data && data.parent ? (
              <button className="fp-iconbtn fp-iconbtn-danger" type="button" title="Delete this folder" onClick={() => setConfirmDelete(true)} disabled={loading || busy}>{Ico.trash(12)}</button>
            ) : null}
          </div>
        </div>

        <div className="fp-toolbar">
          <label className="fp-toggle">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} disabled={loading || busy}/>
            Show hidden folders
          </label>
          {newFolderName === null ? (
            <button className="btn ghost" style={{padding:"4px 8px"}} type="button" title="New folder" onClick={() => setNewFolderName('')} disabled={!data || loading || busy}>{Ico.folder(12)} New folder</button>
          ) : (
            <div className="fp-newinput">
              <input
                ref={newFolderInputRef}
                type="text"
                placeholder="Folder name"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); submitNewFolder(); }
                  if (e.key === 'Escape') { e.preventDefault(); setNewFolderName(null); }
                }}
                disabled={busy}
              />
              <button type="button" title="Create" onClick={submitNewFolder} disabled={busy}>✓</button>
              <button type="button" title="Cancel" onClick={() => setNewFolderName(null)} disabled={busy}>✕</button>
            </div>
          )}
        </div>

        <div className="fp-list">
          {confirmDelete ? (
            <div className="fp-confirm-delete">
              <div>Delete <b>{currentName}</b> and all its contents?</div>
              <div className="fp-confirm-actions">
                <button type="button" className="fp-btn-danger" onClick={submitDelete} disabled={busy}>Delete</button>
                <button type="button" className="fp-btn-ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>Cancel</button>
              </div>
            </div>
          ) : loading ? (
            <div className="fp-empty u-dim">Loading…</div>
          ) : data ? (
            <>
              {data.parent ? (
                <div className="fp-item fp-parent" onClick={() => load(data.parent)}>↑ Parent directory</div>
              ) : null}
              {data.dirs.length === 0 ? (
                <div className="fp-empty u-dim">No subdirectories</div>
              ) : data.dirs.map(name => {
                const full = data.currentPath.endsWith('/') ? data.currentPath + name : data.currentPath + '/' + name;
                return (
                  <div key={name} className="fp-item" onClick={() => load(full)} title={full}>
                    <span className="fp-item-glyph">{Ico.folder(14)}</span>
                    <span className="fp-item-name">{name}</span>
                  </div>
                );
              })}
            </>
          ) : null}
        </div>

        <div className="fp-foot">
          <button type="button" className="fp-btn-ghost" onClick={() => onUseDefault()} disabled={busy || loading}>Use default (workspace)</button>
          <div style={{flex:1}}/>
          <button type="button" className="fp-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="fp-btn-primary" onClick={() => data && onSelect(data.currentPath)} disabled={!data || busy || loading}>
            {busy ? 'Creating…' : 'Select this folder'}
          </button>
        </div>
      </div>
    </div>
  );
}
window.FolderPicker = FolderPicker;
