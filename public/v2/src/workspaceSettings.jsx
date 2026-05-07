/* global React, Ico, AgentApi, useDialog, useToasts */

/* ---------- WorkspaceSettingsModal — per-workspace settings dialog. ---------- */
/* Opens from the gear button in the sidebar workspace action buttons.
   Three tabs:
     - Instructions: free-form system-prompt prefix (Save button).
     - Memory: enable toggle (immediate-save) + searchable, lifecycle-filtered
       grouped browser with per-file delete and a "Clear all" footer. Refetches
       snapshot after each mutation.
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
const MEMORY_STATUS_LABELS = {
  current: 'Current',
  active: 'Active',
  redacted: 'Redacted',
  superseded: 'Superseded',
  all: 'All states',
};
const MEMORY_ALL_STATUSES = 'active,redacted,superseded,deleted';

function WorkspaceSettingsModal({ open, hash, label, initialTab, onOpenMemoryReview, onClose }){
  const [tab, setTab] = React.useState(initialTab || 'instructions');
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  const [instructions, setInstructions] = React.useState('');
  const [instructionsDirty, setInstructionsDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [memoryEnabled, setMemoryEnabled] = React.useState(false);
  const [memorySnapshot, setMemorySnapshot] = React.useState(null);
  const [memoryReviewSchedule, setMemoryReviewSchedule] = React.useState({ mode: 'off' });
  const [memoryReviewStatus, setMemoryReviewStatus] = React.useState(null);
  const [reviewStarting, setReviewStarting] = React.useState(false);
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
      AgentApi.workspace.getMemoryReviewSchedule(hash).catch(() => ({})),
      AgentApi.workspace.getKb(hash).catch(() => ({})),
    ]).then(([instrRes, memRes, reviewScheduleRes, kbRes]) => {
      if (cancelled) return;
      setInstructions(instrRes.instructions || '');
      setMemoryEnabled(!!memRes.enabled);
      setMemorySnapshot(memRes.snapshot || null);
      setMemoryReviewSchedule(reviewScheduleRes.schedule || { mode: 'off' });
      setMemoryReviewStatus(reviewScheduleRes.status || null);
      setReviewStarting(false);
      setKbEnabled(!!kbRes.enabled);
    }).catch(e => {
      if (!cancelled) setLoadError(e.message || String(e));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, hash]);

  React.useEffect(() => {
    if (!open || !hash) return;
    let cancelled = false;
    const onMemoryUpdate = (event) => {
      if (!event || !event.detail || event.detail.hash !== hash) return;
      AgentApi.workspace.getMemory(hash).then((memRes) => {
        if (cancelled) return;
        setMemoryEnabled(!!memRes.enabled);
        setMemorySnapshot(memRes.snapshot || null);
      }).catch(() => {
        // Best-effort live refresh; the next manual open/mutation refetches.
      });
    };
    window.addEventListener('ac:memory-update', onMemoryUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener('ac:memory-update', onMemoryUpdate);
    };
  }, [open, hash]);

  React.useEffect(() => {
    if (!open || !hash) return;
    const onReviewUpdate = (event) => {
      if (!event || !event.detail || event.detail.hash !== hash) return;
      const review = event.detail.review || null;
      setMemoryReviewStatus(review);
      if (!review || review.latestRunStatus !== 'running') setReviewStarting(false);
    };
    window.addEventListener('ac:memory-review-update', onReviewUpdate);
    return () => window.removeEventListener('ac:memory-review-update', onReviewUpdate);
  }, [open, hash]);

  React.useEffect(() => {
    if (!open || !hash || tab !== 'memory') return undefined;
    let cancelled = false;
    const running = reviewStarting || (memoryReviewStatus && memoryReviewStatus.latestRunStatus === 'running');
    const refresh = () => {
      AgentApi.workspace.getMemoryReviewSchedule(hash).then((res) => {
        if (cancelled) return;
        setMemoryReviewSchedule(res.schedule || { mode: 'off' });
        setMemoryReviewStatus(res.status || null);
        if (!res.status || res.status.latestRunStatus !== 'running') setReviewStarting(false);
      }).catch(() => {
        // Best-effort status refresh; explicit actions still surface errors.
      });
    };
    const timer = setInterval(refresh, running ? 2000 : 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, hash, tab, reviewStarting, memoryReviewStatus && memoryReviewStatus.latestRunStatus]);

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
      await refreshMemory();
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
      await refreshMemory();
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
      await refreshMemory();
    } catch (err) {
      dialog.alert({
        variant: 'error',
        title: 'Failed to clear memory',
        body: err.message || String(err),
      });
    }
  }

  async function refreshMemory(){
    const memRes = await AgentApi.workspace.getMemory(hash);
    setMemoryEnabled(!!memRes.enabled);
    setMemorySnapshot(memRes.snapshot || null);
  }

  async function saveMemoryReviewSchedule(schedule){
    const prev = memoryReviewSchedule || { mode: 'off' };
    setMemoryReviewSchedule(schedule);
    try {
      const res = await AgentApi.workspace.setMemoryReviewSchedule(hash, schedule);
      setMemoryReviewSchedule(res.schedule || schedule);
      if (res.status) setMemoryReviewStatus(res.status);
    } catch (err) {
      setMemoryReviewSchedule(prev);
      dialog.alert({
        variant: 'error',
        title: 'Schedule update failed',
        body: err.message || String(err),
      });
    }
  }

  async function startMemoryReview(anchor){
    if (reviewStarting || (memoryReviewStatus && memoryReviewStatus.latestRunStatus === 'running')) return;
    const now = new Date().toISOString();
    setReviewStarting(true);
    setMemoryReviewStatus(prev => ({
      ...(prev || {}),
      enabled: true,
      pending: true,
      pendingRuns: Math.max(1, (prev && prev.pendingRuns) || 0),
      latestRunStatus: 'running',
      latestRunCreatedAt: (prev && prev.latestRunCreatedAt) || now,
      latestRunUpdatedAt: now,
      latestRunSource: 'manual',
    }));
    try {
      const res = await AgentApi.workspace.startMemoryReview(hash);
      const run = res.run || null;
      if (res.status) setMemoryReviewStatus(res.status);
      if (onOpenMemoryReview) onOpenMemoryReview(hash, label || 'workspace', run ? run.id : null);
    } catch (err) {
      await dialog.alert({
        anchor,
        variant: 'error',
        title: 'Memory Review failed',
        body: err.message || String(err),
      });
    } finally {
      setReviewStarting(false);
    }
  }

  function auditMemoryReview(){
    const runId = memoryReviewStatus && (memoryReviewStatus.latestRunId || memoryReviewStatus.lastRunId);
    if (onOpenMemoryReview) onOpenMemoryReview(hash, label || 'workspace', runId || null);
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
              hash={hash}
              enabled={memoryEnabled}
              snapshot={memorySnapshot}
              onToggle={toggleMemory}
              onDelete={deleteMemoryEntry}
              onClearAll={clearAllMemory}
              onRefresh={refreshMemory}
              schedule={memoryReviewSchedule}
              reviewStatus={memoryReviewStatus}
              reviewStarting={reviewStarting}
              onScheduleChange={saveMemoryReviewSchedule}
              onReviewNow={startMemoryReview}
              onAuditReview={auditMemoryReview}
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

function MemoryUpdateModal({ open, hash, label, update, onClose, onViewAll }){
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  const [snapshot, setSnapshot] = React.useState(null);

  React.useEffect(() => {
    if (!open || !hash) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSnapshot(null);
    AgentApi.workspace.getMemory(hash)
      .then(res => {
        if (cancelled) return;
        setSnapshot(res.snapshot || null);
      })
      .catch(err => {
        if (!cancelled) setLoadError(err.message || String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, hash, update && update.capturedAt]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const changedFiles = Array.isArray(update && update.changedFiles) ? update.changedFiles : [];
  const outcomes = Array.isArray(update && update.writeOutcomes) ? update.writeOutcomes : [];
  const files = (snapshot && snapshot.files) || [];
  const filesByName = new Map(files.map(f => [f.filename, f]));
  const changedEntries = changedFiles
    .map(filename => ({ filename, entry: filesByName.get(filename) || null }));
  const capturedAt = (update && update.capturedAt) || new Date().toISOString();

  return (
    <div className="fp-scrim" onClick={onClose}>
      <div className="fp-panel ws-panel mu-panel" role="dialog" aria-modal="true" aria-label={`Memory update: ${label || ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="fp-head">
          <span className="fp-title">Memory Update: {label || ''}</span>
          <button className="fp-close" type="button" aria-label="Close" title="Close" onClick={onClose}>{Ico.x(14)}</button>
        </div>
        <div className="mu-body">
          <div className="mu-meta">
            <span>{formatMemoryUpdateTime(capturedAt)}</span>
            <span>{changedFiles.length} changed file{changedFiles.length === 1 ? '' : 's'}</span>
            {outcomes.length ? <span>{outcomes.length} decision{outcomes.length === 1 ? '' : 's'}</span> : null}
          </div>
          {loading ? (
            <div className="u-dim" style={{padding:'12px 0'}}>Loading…</div>
          ) : loadError ? (
            <div className="u-err" style={{padding:'12px 0'}}>{loadError}</div>
          ) : changedFiles.length === 0 && outcomes.length === 0 ? (
            <div className="ws-empty u-dim">No specific memory file was included in this update.</div>
          ) : (
            <>
              {outcomes.length ? (
                <ul className="ws-mem-list mu-list">
                  {outcomes.map((outcome, idx) => (
                    <li key={`${outcome.action || 'outcome'}_${idx}`} className="ws-mem-item">
                      <div className="ws-mem-item-toggle">
                        <div className="ws-mem-item-name">{formatMemoryOutcomeAction(outcome.action)}</div>
                        {outcome.reason ? <div className="ws-mem-item-desc">{outcome.reason}</div> : null}
                        {outcome.filename ? <div className="ws-mem-item-path">{outcome.filename}</div> : null}
                        {outcome.duplicateOf ? <div className="ws-mem-item-path">Duplicate: {outcome.duplicateOf}</div> : null}
                        {Array.isArray(outcome.superseded) && outcome.superseded.length ? (
                          <div className="ws-mem-item-path">Superseded: {outcome.superseded.join(', ')}</div>
                        ) : null}
                        {Array.isArray(outcome.redaction) && outcome.redaction.length ? (
                          <div className="ws-mem-item-desc">{outcome.redaction.length} redaction{outcome.redaction.length === 1 ? '' : 's'} applied</div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
              {changedFiles.length ? (
                <ul className="ws-mem-list mu-list">
                  {changedEntries.map(({ filename, entry }) => entry ? (
                    <MemoryEntryRow
                      key={filename}
                      entry={entry}
                      defaultExpanded={true}
                      showDelete={false}
                    />
                  ) : (
                    <li key={filename} className="ws-mem-item mu-missing">
                      <div className="ws-mem-item-toggle">
                        <div className="ws-mem-item-name">Memory file unavailable</div>
                        <div className="ws-mem-item-desc">This file is not in the current memory snapshot.</div>
                        <div className="ws-mem-item-path">{filename}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
        <div className="mu-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
          <button type="button" className="btn" onClick={onViewAll}>View all memory items</button>
        </div>
      </div>
    </div>
  );
}
window.MemoryUpdateModal = MemoryUpdateModal;

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

function formatMemoryUpdateTime(value){
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value || '';
  return d.toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function formatSettingsMemoryReviewSource(source){
  return source === 'scheduled' ? 'Scheduled' : 'Manual';
}

function formatSettingsMemoryReviewStatus(status){
  const labels = {
    running: 'Running',
    pending_review: 'Pending review',
    completed: 'Completed',
    partially_applied: 'Partially applied',
    dismissed: 'Dismissed',
    failed: 'Failed',
  };
  return labels[status] || 'Unknown';
}

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

function MemoryTab({ hash, enabled, snapshot, onToggle, onDelete, onClearAll, onRefresh, schedule, reviewStatus, reviewStarting, onScheduleChange, onReviewNow, onAuditReview }){
  const [query, setQuery] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState('all');
  const [statusFilter, setStatusFilter] = React.useState('current');
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState(null);
  const [searchResults, setSearchResults] = React.useState(null);
  const dialog = useDialog();
  const files = (snapshot && snapshot.files) || [];
  const trimmedQuery = query.trim();

  React.useEffect(() => {
    if (!enabled || !hash || !trimmedQuery) {
      setSearchResults(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      AgentApi.workspace.searchMemory(hash, {
        query: trimmedQuery,
        limit: 20,
        ...(typeFilter !== 'all' ? { type: typeFilter } : {}),
        ...(statusFilter === 'all'
          ? { status: MEMORY_ALL_STATUSES }
          : statusFilter !== 'current' ? { status: statusFilter } : {}),
      }).then((res) => {
        if (cancelled) return;
        setSearchResults(Array.isArray(res.results) ? res.results : []);
      }).catch((err) => {
        if (!cancelled) setSearchError(err.message || String(err));
      }).finally(() => {
        if (!cancelled) setSearching(false);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, hash, trimmedQuery, typeFilter, statusFilter]);

  function entryStatus(entry){
    return entry && entry.metadata && entry.metadata.status ? entry.metadata.status : 'active';
  }

  function entryMatchesFilters(entry){
    if (typeFilter !== 'all' && entry.type !== typeFilter) return false;
    const status = entryStatus(entry);
    if (statusFilter === 'current') return status === 'active' || status === 'redacted';
    if (statusFilter === 'all') return true;
    return status === statusFilter;
  }

  const visibleFiles = trimmedQuery
    ? (searchResults || [])
    : files.filter(entryMatchesFilters);
  /* Group files by type so Feedback / Project / etc. render as section
     headers. Unknown types fall into "Other" rather than vanishing. */
  const grouped = {};
  for (const t of MEMORY_TYPE_ORDER) grouped[t] = [];
  for (const f of visibleFiles) (grouped[f.type] || grouped.unknown).push(f);
  const visibleTypes = MEMORY_TYPE_ORDER.filter(t => grouped[t].length > 0);

  async function restoreMemoryEntry(relPath, anchor){
    if (!relPath) return;
    const ok = await dialog.confirm({
      anchor,
      title: 'Restore memory entry',
      body: 'Move this superseded entry back to Current memory?',
      confirmLabel: 'Restore',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    try {
      await AgentApi.workspace.restoreMemoryEntry(hash, relPath);
      await onRefresh();
      toast.success('Memory entry restored');
    } catch (err) {
      await dialog.alert({
        anchor,
        variant: 'error',
        title: 'Restore failed',
        body: err.message || String(err),
      });
    }
  }

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
      {enabled ? (
        <MemoryReviewScheduleEditor
          schedule={schedule || { mode: 'off' }}
          reviewStatus={reviewStatus}
          reviewStarting={reviewStarting}
          onChange={onScheduleChange}
          onReviewNow={onReviewNow}
          onAuditReview={onAuditReview}
        />
      ) : null}

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
          <div className="ws-mem-controls">
            <input
              className="ws-mem-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memory"
              aria-label="Search memory"
            />
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter memory type">
              <option value="all">All types</option>
              {MEMORY_TYPE_ORDER.map(type => (
                <option key={type} value={type}>{MEMORY_TYPE_LABELS[type]}</option>
              ))}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter memory state">
              {Object.keys(MEMORY_STATUS_LABELS).map(status => (
                <option key={status} value={status}>{MEMORY_STATUS_LABELS[status]}</option>
              ))}
            </select>
          </div>
          <div className="ws-mem-filter-meta">
            {searching ? <span>Searching…</span> : trimmedQuery ? <span>{visibleFiles.length} result{visibleFiles.length === 1 ? '' : 's'}</span> : <span>{visibleFiles.length} shown</span>}
            {searchError ? <span className="u-err">{searchError}</span> : null}
          </div>
          {!searching && visibleFiles.length === 0 ? (
            <p className="ws-empty u-dim">No memory entries match the current filters.</p>
          ) : null}
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
                      searchSnippet={trimmedQuery ? f.snippet : null}
                      onDelete={(anchor) => onDelete(f.filename, anchor)}
                      onRestore={(anchor) => restoreMemoryEntry(f.filename, anchor)}
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

function MemoryReviewScheduleEditor({ schedule, reviewStatus, reviewStarting, onChange, onReviewNow, onAuditReview }){
  const current = schedule && schedule.mode === 'window'
    ? schedule
    : {
        mode: 'window',
        days: 'daily',
        windowStart: '01:00',
        windowEnd: '04:00',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      };
  const enabled = schedule && schedule.mode === 'window';
  const reviewRunning = !!reviewStarting || (reviewStatus && reviewStatus.latestRunStatus === 'running');
  const auditRunId = reviewStatus && (reviewStatus.latestRunId || reviewStatus.lastRunId);
  const showAudit = !!auditRunId && !reviewRunning;

  function update(patch){
    onChange({ ...current, ...patch, mode: 'window' });
  }

  function toggleCustomDay(day){
    const existing = Array.isArray(current.customDays) ? current.customDays : [];
    const next = existing.includes(day)
      ? existing.filter(item => item !== day)
      : [...existing, day].sort((a, b) => a - b);
    update({ days: 'custom', customDays: next.length ? next : [day] });
  }

  return (
    <div className="ws-mem-schedule">
      <div className="ws-mem-schedule-head">
        <div>
          <div className="ws-mem-schedule-title">Memory Review</div>
          <div className="ws-mem-schedule-desc u-dim">Generate review drafts during a quiet window.</div>
        </div>
        <div className="ws-mem-review-actions">
          <button
            type="button"
            className="ws-mem-review-btn"
            disabled={reviewRunning}
            onClick={(e) => onReviewNow(e.currentTarget)}
          >{reviewRunning ? 'Review running...' : 'Start new review'}</button>
          {showAudit ? (
            <button type="button" className="ws-mem-review-btn primary" onClick={onAuditReview}>Audit Current Review</button>
          ) : null}
        </div>
      </div>
      {reviewRunning ? <MemoryReviewSettingsProgress status={reviewStatus} starting={reviewStarting}/> : null}
      <MemoryReviewLastRun status={reviewStatus}/>
      <label className="toggle ws-toggle">
        <input
          type="checkbox"
          checked={!!enabled}
          onChange={(e) => onChange(e.target.checked ? current : { mode: 'off' })}
        />
        <span className="tgl"/>
        <span>Scheduled review</span>
      </label>
      {enabled ? (
        <div className="ws-mem-schedule-grid">
          <label>
            <span>Days</span>
            <select value={current.days || 'daily'} onChange={(e) => update({ days: e.target.value })}>
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label>
            <span>Start</span>
            <input type="time" value={current.windowStart || '01:00'} onChange={(e) => update({ windowStart: e.target.value })}/>
          </label>
          <label>
            <span>End</span>
            <input type="time" value={current.windowEnd || '04:00'} onChange={(e) => update({ windowEnd: e.target.value })}/>
          </label>
          {current.days === 'custom' ? (
            <div className="ws-mem-weekdays" role="group" aria-label="Custom review days">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, idx) => (
                <button
                  key={idx}
                  type="button"
                  className={Array.isArray(current.customDays) && current.customDays.includes(idx) ? 'active' : ''}
                  onClick={() => toggleCustomDay(idx)}
                >{day}</button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MemoryReviewSettingsProgress({ status, starting }){
  const source = status && (status.latestRunSource || status.lastRunSource);
  const createdAt = status && (status.latestRunCreatedAt || status.lastRunCreatedAt);
  return (
    <div className="ws-mem-review-progress" role="status" aria-live="polite">
      <span className="typing-dots" aria-hidden="true">
        <span className="typing-dot"/>
        <span className="typing-dot"/>
        <span className="typing-dot"/>
      </span>
      <div>
        <div className="ws-mem-review-progress-title">Generating draft review</div>
        <div className="ws-mem-review-progress-meta">
          {source ? formatSettingsMemoryReviewSource(source) : starting ? 'Manual' : 'Review'}{createdAt ? ` - Started ${formatMemoryUpdateTime(createdAt)}` : ''}
        </div>
      </div>
    </div>
  );
}

function MemoryReviewLastRun({ status }){
  const createdAt = status && (status.lastRunCreatedAt || status.latestRunCreatedAt);
  if (!createdAt) {
    return <div className="ws-mem-review-last u-dim">Last run: None yet</div>;
  }
  const source = status.lastRunSource || status.latestRunSource || 'manual';
  const runStatus = status.lastRunStatus || status.latestRunStatus;
  return (
    <div className="ws-mem-review-last">
      <span>Last run</span>
      <b>{formatSettingsMemoryReviewSource(source)}</b>
      <span>{formatMemoryUpdateTime(createdAt)}</span>
      {runStatus ? <span className="u-dim">{formatSettingsMemoryReviewStatus(runStatus)}</span> : null}
    </div>
  );
}

function MemoryConsolidationReview({ proposal, error, applying, draftingKey, safeCount, onDraft, onApply, onDismiss }){
  const actions = proposal && Array.isArray(proposal.actions) ? proposal.actions : [];
  const draftable = new Set(['merge_candidates', 'split_candidate', 'normalize_candidate']);
  if (!proposal && error) {
    return (
      <div className="ws-mem-review">
        <div className="u-err">{error}</div>
      </div>
    );
  }
  if (!proposal) return null;
  return (
    <div className="ws-mem-review">
      <div className="ws-mem-review-head">
        <div>
          <div className="ws-mem-review-title">Memory review</div>
          <div className="ws-mem-review-summary">{proposal.summary || 'Review completed.'}</div>
        </div>
        <div className="ws-mem-review-actions">
          {safeCount > 0 ? (
            <button
              type="button"
              className="ws-mem-review-apply"
              onClick={(e) => onApply(e.currentTarget)}
              disabled={applying}
            >{applying ? 'Applying…' : `Apply ${safeCount}`}</button>
          ) : null}
          <button type="button" className="ws-mem-review-dismiss" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
      {actions.length === 0 ? (
        <div className="ws-empty u-dim">No consolidation changes proposed.</div>
      ) : (
        <ul className="ws-mem-review-list">
          {actions.map((action, idx) => (
            <li key={`${action.action}_${idx}`} className="ws-mem-review-item">
              <div className="ws-mem-review-item-head">
                <div className="ws-mem-review-action">{formatMemoryConsolidationAction(action.action)}</div>
                {draftable.has(action.action) ? (
                  <button
                    type="button"
                    className="ws-mem-review-draft"
                    disabled={!!draftingKey}
                    onClick={(e) => onDraft(action, idx, e.currentTarget)}
                  >{draftingKey === `${action.action}_${action.filename || (Array.isArray(action.filenames) ? action.filenames.join('|') : '')}_${idx}` ? 'Drafting…' : 'Draft'}</button>
                ) : null}
              </div>
              <div className="ws-mem-review-summary">{action.reason || 'No reason provided.'}</div>
              {action.filename ? <div className="ws-mem-item-path">{action.filename}</div> : null}
              {action.supersededBy ? <div className="ws-mem-item-path">Superseded by: {action.supersededBy}</div> : null}
              {Array.isArray(action.filenames) && action.filenames.length ? (
                <div className="ws-mem-item-path">{action.filenames.join(', ')}</div>
              ) : null}
              {action.title ? <div className="ws-mem-review-summary">{action.title}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MemoryConsolidationDraftReview({ draft, error, applying, files, onApply, onDismiss }){
  const operations = draft && Array.isArray(draft.operations) ? draft.operations : [];
  const byFilename = new Map((files || []).map(entry => [entry.filename, entry]));
  if (!draft && error) {
    return (
      <div className="ws-mem-review ws-mem-draft">
        <div className="u-err">{error}</div>
      </div>
    );
  }
  if (!draft) return null;
  return (
    <div className="ws-mem-review ws-mem-draft">
      <div className="ws-mem-review-head">
        <div>
          <div className="ws-mem-review-title">Drafted memory changes</div>
          <div className="ws-mem-review-summary">{draft.summary || 'Draft generated.'}</div>
        </div>
        <div className="ws-mem-review-actions">
          <button
            type="button"
            className="ws-mem-review-apply"
            onClick={(e) => onApply(e.currentTarget)}
            disabled={applying || operations.length === 0}
          >{applying ? 'Applying…' : 'Apply draft'}</button>
          <button type="button" className="ws-mem-review-dismiss" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
      {error ? <div className="u-err">{error}</div> : null}
      <ul className="ws-mem-review-list">
        {operations.map((operation, idx) => (
          <li key={`${operation.operation}_${idx}`} className="ws-mem-review-item">
            <div className="ws-mem-review-action">{formatMemoryDraftOperation(operation.operation)}</div>
            <div className="ws-mem-review-summary">{operation.reason || 'No reason provided.'}</div>
            {operation.filename ? <div className="ws-mem-item-path">{operation.filename}</div> : null}
            {operation.filenameHint ? <div className="ws-mem-item-path">Filename hint: {operation.filenameHint}</div> : null}
            {Array.isArray(operation.supersedes) && operation.supersedes.length ? (
              <div className="ws-mem-item-path">Supersedes: {operation.supersedes.join(', ')}</div>
            ) : null}
            {operation.operation === 'replace' && operation.filename ? (
              <div className="ws-mem-draft-compare">
                <div className="ws-mem-draft-pane">
                  <div className="ws-mem-draft-label">Current</div>
                  <pre className="ws-mem-draft-body">{byFilename.get(operation.filename)?.content || ''}</pre>
                </div>
                <div className="ws-mem-draft-pane">
                  <div className="ws-mem-draft-label">Draft</div>
                  <pre className="ws-mem-draft-body">{operation.content || ''}</pre>
                </div>
              </div>
            ) : (
              <>
                <div className="ws-mem-draft-label">Draft</div>
                <pre className="ws-mem-draft-body">{operation.content || ''}</pre>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatMemoryDraftOperation(operation){
  switch (operation) {
    case 'create': return 'Create note';
    case 'replace': return 'Replace note';
    default: return 'Draft operation';
  }
}

function formatMemoryConsolidationAction(action){
  switch (action) {
    case 'mark_superseded': return 'Mark superseded';
    case 'merge_candidates': return 'Merge candidate';
    case 'split_candidate': return 'Split candidate';
    case 'normalize_candidate': return 'Normalize metadata';
    case 'keep': return 'Keep';
    default: return 'Review item';
  }
}

function MemoryEntryRow({ entry, onDelete, onRestore, defaultExpanded = false, showDelete = true, searchSnippet = null }){
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const heading = entry.name || entry.filename;
  const sub = entry.description || '';
  const status = entry && entry.metadata && entry.metadata.status ? entry.metadata.status : entry.status;
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
          <div className="ws-mem-item-path">
            {entry.filename}
            {status && status !== 'active' ? <span className={`ws-mem-status ${status}`}>{status}</span> : null}
          </div>
          {searchSnippet ? <div className="ws-mem-item-desc">{searchSnippet}</div> : null}
        </button>
        {showDelete && onDelete ? (
          <button
            type="button"
            className="ws-mem-item-delete"
            title="Delete entry"
            aria-label="Delete entry"
            onClick={(e) => { e.stopPropagation(); onDelete(e.currentTarget); }}
          >{Ico.trash(12)}</button>
        ) : null}
        {status === 'superseded' && onRestore ? (
          <button
            type="button"
            className="ws-mem-item-restore"
            title="Restore entry"
            aria-label="Restore entry"
            onClick={(e) => { e.stopPropagation(); onRestore(e.currentTarget); }}
          >Restore</button>
        ) : null}
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
