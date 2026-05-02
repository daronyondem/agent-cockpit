/* global React, Ico, AgentApi, useDialog, useToasts */

/* ---------- WorkspaceSettingsModal — per-workspace settings dialog. ---------- */
/* Opens from the gear button next to each workspace group in the sidebar.
   Three tabs:
     - Instructions: free-form system-prompt prefix (Save button).
     - Memory: enable toggle (immediate-save) + grouped browser with per-file
       delete and a "Clear all" footer. Refetches snapshot after each mutation.
     - Knowledge Base: enable toggle (immediate-save). Full KB management lives
       in the dedicated KB Browser screen.
   Reuses FolderPicker's `.fp-scrim` / `.fp-panel` shell so the visual
   vocabulary stays consistent with the rest of the V2 modals. */

const WS_SETTINGS_TABS = [
  { id: 'instructions', label: 'Instructions' },
  { id: 'memory',       label: 'Memory' },
  { id: 'kb',           label: 'Knowledge Base' },
];

const MEMORY_TYPE_ORDER = ['user', 'feedback', 'project', 'reference', 'unknown'];
const MEMORY_TYPE_LABELS = {
  user: 'User', feedback: 'Feedback', project: 'Project',
  reference: 'Reference', unknown: 'Other',
};

function WorkspaceSettingsModal({ open, hash, label, initialTab, onClose }){
  const [tab, setTab] = React.useState(initialTab || 'instructions');
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  const [instructions, setInstructions] = React.useState('');
  const [instructionsDirty, setInstructionsDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [memoryEnabled, setMemoryEnabled] = React.useState(false);
  const [memorySnapshot, setMemorySnapshot] = React.useState(null);
  const [kbEnabled, setKbEnabled] = React.useState(false);
  const dialog = useDialog();
  const toast = useToasts();

  /* Load state on open. The three endpoints are independent so we fire them
     in parallel; any failure flips the whole modal into an error state since
     partial UI would be confusing. */
  React.useEffect(() => {
    if (!open || !hash) return;
    let cancelled = false;
    setTab(initialTab || 'instructions');
    setLoading(true); setLoadError(null);
    setInstructionsDirty(false);
    Promise.all([
      AgentApi.workspace.getInstructions(hash).catch(() => ({})),
      AgentApi.workspace.getMemory(hash).catch(() => ({})),
      AgentApi.workspace.getKb(hash).catch(() => ({})),
    ]).then(([instrRes, memRes, kbRes]) => {
      if (cancelled) return;
      setInstructions(instrRes.instructions || '');
      setMemoryEnabled(!!memRes.enabled);
      setMemorySnapshot(memRes.snapshot || null);
      setKbEnabled(!!kbRes.enabled);
    }).catch(e => {
      if (!cancelled) setLoadError(e.message || String(e));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, hash]);

  /* Escape closes unless we're mid-save (closing mid-PUT would leave a stale
     success toast in the air). */
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !saving) { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, saving, onClose]);

  if (!open) return null;

  async function saveInstructions(anchor){
    if (saving) return;
    setSaving(true);
    try {
      await AgentApi.workspace.saveInstructions(hash, instructions);
      setInstructionsDirty(false);
      toast.success('Instructions saved');
    } catch (err) {
      await dialog.alert({
        anchor,
        variant: 'error',
        title: 'Save failed',
        body: err.message || String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  async function toggleMemory(enabled){
    const prev = memoryEnabled;
    setMemoryEnabled(enabled);
    try {
      await AgentApi.workspace.setMemoryEnabled(hash, enabled);
      const memRes = await AgentApi.workspace.getMemory(hash);
      setMemoryEnabled(!!memRes.enabled);
      setMemorySnapshot(memRes.snapshot || null);
    } catch (err) {
      setMemoryEnabled(prev);
      dialog.alert({
        variant: 'error',
        title: 'Failed to update memory setting',
        body: err.message || String(err),
      });
    }
  }

  async function toggleKb(enabled){
    const prev = kbEnabled;
    setKbEnabled(enabled);
    try {
      await AgentApi.workspace.setKbEnabled(hash, enabled);
      /* The book icon on the sidebar group reflects workspaceKbEnabled,
         which is workspace-scoped (set on every conv in the group). The
         shell's onCloseWorkspaceSettings refetches the list when the
         modal closes, which is when the icon needs to update. */
    } catch (err) {
      setKbEnabled(prev);
      dialog.alert({
        variant: 'error',
        title: 'Failed to update knowledge base setting',
        body: err.message || String(err),
      });
    }
  }

  async function deleteMemoryEntry(relPath, anchor){
    const ok = await dialog.confirm({
      anchor,
      title: 'Delete entry',
      body: `Delete memory entry "${relPath}"?`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    try {
      await AgentApi.workspace.deleteMemoryEntry(hash, relPath);
      const memRes = await AgentApi.workspace.getMemory(hash);
      setMemoryEnabled(!!memRes.enabled);
      setMemorySnapshot(memRes.snapshot || null);
    } catch (err) {
      dialog.alert({
        variant: 'error',
        title: 'Failed to delete entry',
        body: err.message || String(err),
      });
    }
  }

  async function clearAllMemory(anchor){
    const ok = await dialog.confirm({
      anchor,
      title: 'Clear memory',
      body: 'Clear all memory entries for this workspace? This cannot be undone.',
      confirmLabel: 'Clear all',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    try {
      await AgentApi.workspace.clearMemory(hash);
      const memRes = await AgentApi.workspace.getMemory(hash);
      setMemoryEnabled(!!memRes.enabled);
      setMemorySnapshot(memRes.snapshot || null);
    } catch (err) {
      dialog.alert({
        variant: 'error',
        title: 'Failed to clear memory',
        body: err.message || String(err),
      });
    }
  }

  return (
    <div className="fp-scrim" onClick={saving ? undefined : onClose}>
      <div className="fp-panel ws-panel" role="dialog" aria-modal="true" aria-label={`Workspace settings: ${label || ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="fp-head">
          <span className="fp-title">Workspace Settings: {label || ''}</span>
          <button className="fp-close" type="button" aria-label="Close" title="Close" onClick={onClose} disabled={saving}>{Ico.x(14)}</button>
        </div>

        <div className="ws-tabs">
          {WS_SETTINGS_TABS.map(t => (
            <button
              key={t.id}
              type="button"
              className={`ws-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >{t.label}</button>
          ))}
        </div>

        <div className="ws-body">
          {loading ? (
            <div className="u-dim" style={{padding:'16px'}}>Loading…</div>
          ) : loadError ? (
            <div className="u-err" style={{padding:'16px'}}>{loadError}</div>
          ) : tab === 'instructions' ? (
            <InstructionsTab
              instructions={instructions}
              setInstructions={(v) => { setInstructions(v); setInstructionsDirty(true); }}
              dirty={instructionsDirty}
              saving={saving}
              onSave={saveInstructions}
            />
          ) : tab === 'memory' ? (
            <MemoryTab
              enabled={memoryEnabled}
              snapshot={memorySnapshot}
              onToggle={toggleMemory}
              onDelete={deleteMemoryEntry}
              onClearAll={clearAllMemory}
            />
          ) : tab === 'kb' ? (
            <KbTab enabled={kbEnabled} onToggle={toggleKb}/>
          ) : null}
        </div>
      </div>
    </div>
  );
}
window.WorkspaceSettingsModal = WorkspaceSettingsModal;

/* ---------- Tabs ---------- */

function InstructionsTab({ instructions, setInstructions, dirty, saving, onSave }){
  return (
    <div className="ws-form">
      <p className="ws-desc u-dim">
        Additional instructions prepended to every new CLI session in this workspace.
        Combined with the global system prompt.
      </p>
      <textarea
        className="ws-textarea"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder="Workspace-specific instructions…"
      />
      <div className="ws-actions">
        <button
          type="button"
          className="btn"
          disabled={saving || !dirty}
          onClick={(e) => onSave(e.currentTarget)}
        >{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

function MemoryTab({ enabled, snapshot, onToggle, onDelete, onClearAll }){
  const files = (snapshot && snapshot.files) || [];
  /* Group files by type so Feedback / Project / etc. render as section
     headers. Unknown types fall into "Other" rather than vanishing. */
  const grouped = {};
  for (const t of MEMORY_TYPE_ORDER) grouped[t] = [];
  for (const f of files) (grouped[f.type] || grouped.unknown).push(f);
  const visibleTypes = MEMORY_TYPE_ORDER.filter(t => grouped[t].length > 0);

  return (
    <div className="ws-form">
      <p className="ws-desc u-dim">
        When enabled, memory from prior sessions is injected into every new
        session's system prompt. Claude Code sessions contribute via their
        native memory system; other CLIs contribute via the <code>memory_note</code>
        MCP tool and post-session extraction.
      </p>
      <label className="toggle ws-toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)}/>
        <span className="tgl"/>
        <span>Enable Memory for this workspace</span>
      </label>

      {!enabled ? (
        <p className="ws-empty u-dim">Memory is disabled for this workspace.</p>
      ) : files.length === 0 ? (
        <p className="ws-empty u-dim">
          No memory entries yet. Entries appear here when Claude Code captures
          memory on session reset, or when a non-Claude CLI calls the
          <code> memory_note </code> tool.
        </p>
      ) : (
        <>
          <div className="ws-mem-groups">
            {visibleTypes.map(t => (
              <div key={t} className="ws-mem-group">
                <div className="ws-mem-group-head">
                  {MEMORY_TYPE_LABELS[t]}
                  <span className="ws-mem-group-count">{grouped[t].length}</span>
                </div>
                <ul className="ws-mem-list">
                  {grouped[t].map(f => (
                    <MemoryEntryRow
                      key={f.filename}
                      entry={f}
                      onDelete={(anchor) => onDelete(f.filename, anchor)}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="ws-mem-clear">
            <button
              type="button"
              className="ws-mem-clear-btn"
              onClick={(e) => onClearAll(e.currentTarget)}
            >Clear all memory</button>
            <span className="u-dim" style={{fontSize:12}}>
              Removes every entry for this workspace. Cannot be undone.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function MemoryEntryRow({ entry, onDelete }){
  const [expanded, setExpanded] = React.useState(false);
  const heading = entry.name || entry.filename;
  const sub = entry.description || '';
  return (
    <li className="ws-mem-item">
      <div className="ws-mem-item-head">
        <button
          type="button"
          className={"ws-mem-item-toggle" + (expanded ? " expanded" : "")}
          onClick={() => setExpanded(v => !v)}
        >
          <div className="ws-mem-item-name">{heading}</div>
          {sub ? <div className="ws-mem-item-desc">{sub}</div> : null}
          <div className="ws-mem-item-path">{entry.filename}</div>
        </button>
        <button
          type="button"
          className="ws-mem-item-delete"
          title="Delete entry"
          aria-label="Delete entry"
          onClick={(e) => { e.stopPropagation(); onDelete(e.currentTarget); }}
        >{Ico.trash(12)}</button>
      </div>
      {expanded ? (
        <pre className="ws-mem-item-body">{entry.content || ''}</pre>
      ) : null}
    </li>
  );
}

function KbTab({ enabled, onToggle }){
  return (
    <div className="ws-form">
      <p className="ws-desc u-dim">
        When enabled, files you upload to this workspace are ingested, digested
        into structured entries, and (on demand) synthesized into a cross-linked
        knowledge base. The CLI sees a pointer to the knowledge directory on new
        sessions and reads entries as needed. Configure the digestion and
        dreaming CLIs in global Settings → Knowledge Base.
      </p>
      <label className="toggle ws-toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)}/>
        <span className="tgl"/>
        <span>Enable Knowledge Base for this workspace</span>
      </label>
      {enabled ? (
        <p className="ws-empty u-dim">
          Knowledge Base is enabled. Use the book icon in the sidebar to open
          the KB Browser for file upload, digestion, and synthesis.
        </p>
      ) : (
        <p className="ws-empty u-dim">Knowledge Base is disabled for this workspace.</p>
      )}
    </div>
  );
}
