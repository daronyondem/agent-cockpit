import React from 'react';
import { Ico } from '../icons.jsx';
import { AgentApi } from '../api.js';
import { useDialog } from '../dialog.jsx';
import { useToasts } from '../toast.jsx';

export function MemoryReviewPage({ hash, label, runId, onClose }){
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [run, setRun] = React.useState(null);
  const [snapshot, setSnapshot] = React.useState(null);
  const [acting, setActing] = React.useState(null);
  const [regenDone, setRegenDone] = React.useState({});
  const [applyDone, setApplyDone] = React.useState({});
  const regenDoneTimers = React.useRef({});
  const applyDoneTimers = React.useRef({});
  const dialog = useDialog();
  const toast = useToasts();

  const load = React.useCallback(async (opts) => {
    if (!hash) return;
    const silent = opts && opts.silent;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [reviewRes, memoryRes] = await Promise.all([
        runId
          ? AgentApi.workspace.getMemoryReview(hash, runId)
          : AgentApi.workspace.getPendingMemoryReviews(hash),
        AgentApi.workspace.getMemory(hash).catch(() => ({})),
      ]);
      const runs = Array.isArray(reviewRes.runs) ? reviewRes.runs : [];
      setStatus(reviewRes.status || null);
      setRun(reviewRes.run || runs[0] || null);
      setSnapshot(memoryRes.snapshot || null);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [hash, runId]);

  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => () => {
    Object.values(regenDoneTimers.current).forEach((timer) => clearTimeout(timer));
    Object.values(applyDoneTimers.current).forEach((timer) => clearTimeout(timer));
    regenDoneTimers.current = {};
    applyDoneTimers.current = {};
  }, []);

  React.useEffect(() => {
    if (!run || run.status !== 'running') return undefined;
    const timer = setInterval(() => load({ silent: true }), 2000);
    return () => clearInterval(timer);
  }, [load, run && run.status]);

  React.useEffect(() => {
    if (!hash) return;
    const onReviewUpdate = (event) => {
      if (!event || !event.detail || event.detail.hash !== hash) return;
      load({ silent: !!run });
    };
    window.addEventListener('ac:memory-review-update', onReviewUpdate);
    return () => window.removeEventListener('ac:memory-review-update', onReviewUpdate);
  }, [hash, load, run]);

  async function runAction(key, progressLabel, action, successLabel){
    if (acting) return;
    setActing({ key, label: progressLabel });
    try {
      const res = await action();
      if (res && res.run) setRun(res.run);
      if (res && res.status) setStatus(res.status);
      const mem = await AgentApi.workspace.getMemory(hash).catch(() => ({}));
      setSnapshot(mem.snapshot || null);
      if (key.startsWith('apply:')) {
        const itemId = key.slice('apply:'.length);
        clearTimeout(applyDoneTimers.current[itemId]);
        setApplyDone(prev => ({ ...prev, [itemId]: true }));
        applyDoneTimers.current[itemId] = setTimeout(() => {
          setApplyDone(prev => {
            const next = { ...prev };
            delete next[itemId];
            return next;
          });
          delete applyDoneTimers.current[itemId];
        }, 5000);
      }
      if (key.startsWith('regen:')) {
        const itemId = key.slice('regen:'.length);
        clearTimeout(regenDoneTimers.current[itemId]);
        setRegenDone(prev => ({ ...prev, [itemId]: true }));
        regenDoneTimers.current[itemId] = setTimeout(() => {
          setRegenDone(prev => {
            const next = { ...prev };
            delete next[itemId];
            return next;
          });
          delete regenDoneTimers.current[itemId];
        }, 5000);
      }
      if (successLabel) toast.success(successLabel);
    } catch (err) {
      await dialog.alert({
        variant: 'error',
        title: 'Memory Review failed',
        body: err.message || String(err),
      });
    } finally {
      setActing(null);
    }
  }

  function showReviewItem(item){
    return item.status !== 'applied' || !!applyDone[item.id];
  }

  const filesByName = React.useMemo(() => {
    const map = new Map();
    for (const file of (snapshot && snapshot.files) || []) map.set(file.filename, file);
    return map;
  }, [snapshot]);

  return (
    <section className="main main-memory-review">
      <div className="mr-shell">
        <div className="mr-head">
          <div>
            <div className="mr-eyebrow">Memory Review</div>
            <h2>{label || 'Workspace memory'}</h2>
          </div>
          <button type="button" className="btn ghost" onClick={onClose}>{Ico.x(13)} Close</button>
        </div>

        {loading ? (
          <div className="mr-empty u-dim">Loading...</div>
        ) : error ? (
          <div className="mr-empty u-err">{error}</div>
        ) : !run ? (
          <div className="mr-empty u-dim">No pending Memory Review.</div>
        ) : (() => {
          const visibleSafeActions = (run.safeActions || []).filter(showReviewItem);
          const visibleDrafts = (run.drafts || []).filter(showReviewItem);
          const visibleCount = visibleSafeActions.length + visibleDrafts.length;
          return (
          <>
            <div className="mr-summary">
              <div>
                <div className="mr-status-row">
                  <span className={'mr-pill status-' + (run.status || 'pending_review')}>{formatMemoryReviewStatus(run.status)}</span>
                  <span className="u-dim">{formatMemoryReviewSource(run.source)}</span>
                  <span className="u-dim">{formatMemoryReviewTime(run.createdAt)}</span>
                </div>
                <p>{run.summary || 'Review generated.'}</p>
              </div>
              <div className="mr-counts">
                <span><b>{(run.drafts || []).length}</b> drafts</span>
                <span><b>{(run.safeActions || []).length}</b> metadata</span>
                <span><b>{(run.failures || []).length}</b> failed</span>
              </div>
            </div>

            {run.status === 'running' ? (
              <div className="mr-progress-row">
                <MemoryReviewInlineProgress label="Generating draft review..."/>
              </div>
            ) : null}

            {Array.isArray(run.failures) && run.failures.length ? (
              <div className="mr-errors">
                {run.failures.map((failure, idx) => (
                  <div key={idx}>{failure.message || 'Review step failed.'}</div>
                ))}
              </div>
            ) : null}

            <div className="mr-items">
              {visibleSafeActions.map(item => (
                <MemoryReviewSafeActionCard
                  key={item.id}
                  item={item}
                  acting={acting}
                  applyDone={!!applyDone[item.id]}
                  onApply={() => runAction(
                    'apply:' + item.id,
                    'Applying metadata update...',
                    () => AgentApi.workspace.applyMemoryReviewAction(hash, run.id, item.id),
                    'Memory metadata updated',
                  )}
                  onDiscard={() => runAction(
                    'discard:' + item.id,
                    'Dismissing review item...',
                    () => AgentApi.workspace.discardMemoryReviewAction(hash, run.id, item.id),
                    'Memory Review item dismissed',
                  )}
                />
              ))}
              {visibleDrafts.map(item => (
                <MemoryReviewDraftCard
                  key={item.id}
                  item={item}
                  filesByName={filesByName}
                  acting={acting}
                  applyDone={!!applyDone[item.id]}
                  regenDone={!!regenDone[item.id]}
                  onApply={(reviewedDraft) => runAction(
                    'apply:' + item.id,
                    'Applying memory draft...',
                    () => AgentApi.workspace.applyMemoryReviewDraft(hash, run.id, item.id, reviewedDraft ? { draft: reviewedDraft } : undefined),
                    'Memory draft applied',
                  )}
                  onDiscard={() => runAction(
                    'discard:' + item.id,
                    'Dismissing draft...',
                    () => AgentApi.workspace.discardMemoryReviewDraft(hash, run.id, item.id),
                    'Memory Review item dismissed',
                  )}
                  onRegenerate={() => runAction(
                    'regen:' + item.id,
                    'Regenerating draft...',
                    () => AgentApi.workspace.regenerateMemoryReviewDraft(hash, run.id, item.id),
                    'Memory draft regenerated',
                  )}
                />
              ))}
              {run.status !== 'running' && visibleCount === 0 ? (
                <div className="mr-empty-inline u-dim">No open review items.</div>
              ) : null}
            </div>
          </>
          );
        })()}
      </div>
    </section>
  );
}

function MemoryReviewSafeActionCard({ item, acting, applyDone, onApply, onDiscard }){
  const busy = acting && acting.key && acting.key.endsWith(item.id);
  const applyBusy = acting && acting.key === 'apply:' + item.id;
  const discardBusy = acting && acting.key === 'discard:' + item.id;
  const done = item.status === 'applied' || item.status === 'discarded';
  return (
    <div className={'mr-card status-' + item.status}>
      <div className="mr-card-head">
        <div>
          <div className="mr-card-title">{formatMemoryReviewAction(item.action && item.action.action)}</div>
          <div className="mr-card-sub">{item.action && item.action.reason ? item.action.reason : 'Metadata-only memory update.'}</div>
        </div>
        <span className={'mr-pill status-' + item.status}>{formatMemoryReviewItemStatus(item.status)}</span>
      </div>
      {busy && !applyBusy ? <MemoryReviewInlineProgress label={acting.label}/> : null}
      <MemoryReviewDecisionNote status={item.status}/>
      <div className="mr-kv">
        <span>Entry</span><b>{item.action && item.action.filename ? item.action.filename : '-'}</b>
        <span>Superseded by</span><b>{item.action && item.action.supersededBy ? item.action.supersededBy : '-'}</b>
      </div>
      {item.failure ? <div className="mr-item-error">{item.failure}</div> : null}
      <div className="mr-actions">
        <button
          type="button"
          className={'btn primary' + (applyDone ? ' mr-btn-success' : '')}
          disabled={busy || done || applyDone}
          onClick={onApply}
        >
          {applyBusy
            ? <MemoryReviewButtonProgress label="Applying..."/>
            : applyDone
              ? <>{Ico.check(13)} Applied</>
              : <>{Ico.check(13)} Apply</>}
        </button>
        <button type="button" className="btn ghost" disabled={busy || done} onClick={onDiscard}>
          {discardBusy ? 'Dismissing...' : <>{Ico.x(13)} Dismiss</>}
        </button>
      </div>
    </div>
  );
}

function MemoryReviewDraftCard({ item, filesByName, acting, applyDone, regenDone, onApply, onDiscard, onRegenerate }){
  const [contentEdits, setContentEdits] = React.useState({});
  const [editing, setEditing] = React.useState({});
  const busy = acting && acting.key && acting.key.endsWith(item.id);
  const applyBusy = acting && acting.key === 'apply:' + item.id;
  const discardBusy = acting && acting.key === 'discard:' + item.id;
  const regenerateBusy = acting && acting.key === 'regen:' + item.id;
  const applied = item.status === 'applied';
  const dismissed = item.status === 'discarded';
  const done = applied || dismissed;
  const draft = item.draft || null;
  const operations = (draft && Array.isArray(draft.operations)) ? draft.operations : [];
  React.useEffect(() => {
    setContentEdits({});
    setEditing({});
  }, [item.id, draft && draft.id, item.status]);
  const operationContent = (operation, idx) => (
    Object.prototype.hasOwnProperty.call(contentEdits, idx)
      ? contentEdits[idx]
      : operation.content || ''
  );
  const setOperationContent = (idx, value) => {
    setContentEdits((prev) => ({ ...prev, [idx]: value }));
  };
  const toggleOperationEdit = (idx) => {
    setEditing((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };
  const resetOperationEdit = (idx) => {
    setContentEdits((prev) => {
      const next = { ...prev };
      delete next[idx];
      return next;
    });
  };
  const buildReviewedDraft = () => {
    if (!draft) return null;
    return {
      ...draft,
      operations: operations.map((operation, idx) => ({
        ...operation,
        content: operationContent(operation, idx),
      })),
    };
  };
  return (
    <div className={'mr-card status-' + item.status}>
      <div className="mr-card-head">
        <div>
          <div className="mr-card-title">{formatMemoryReviewAction(item.action && item.action.action)}</div>
          <div className="mr-card-sub">{draft && draft.summary ? draft.summary : item.action && item.action.reason ? item.action.reason : 'Drafted memory rewrite.'}</div>
        </div>
        <span className={'mr-pill status-' + item.status}>{formatMemoryReviewItemStatus(item.status)}</span>
      </div>
      {busy && !applyBusy && !regenerateBusy ? <MemoryReviewInlineProgress label={acting.label}/> : null}
      <MemoryReviewDecisionNote status={item.status}/>
      {item.failure ? <div className="mr-item-error">{item.failure}</div> : null}
      {operations.length ? (
        <div className="mr-diffs">
          {operations.map((operation, idx) => (
            <MemoryReviewOperationDiff
              key={idx}
              operation={operation}
              filesByName={filesByName}
              after={operationContent(operation, idx)}
              editing={!!editing[idx]}
              edited={operationContent(operation, idx) !== (operation.content || '')}
              onChange={(value) => setOperationContent(idx, value)}
              onToggleEdit={() => toggleOperationEdit(idx)}
              onReset={() => resetOperationEdit(idx)}
            />
          ))}
        </div>
      ) : !item.failure ? (
        <div className="mr-empty-inline u-dim">No draft content available.</div>
      ) : null}
      <div className="mr-actions">
        <button
          type="button"
          className={'btn primary' + (applyDone ? ' mr-btn-success' : '')}
          disabled={busy || done || !draft || applyDone}
          onClick={() => onApply(buildReviewedDraft())}
        >
          {applyBusy
            ? <MemoryReviewButtonProgress label="Applying..."/>
            : applyDone
              ? <>{Ico.check(13)} Applied</>
              : <>{Ico.check(13)} Apply</>}
        </button>
        <button
          type="button"
          className={'btn ghost' + (regenDone ? ' mr-btn-success' : '')}
          disabled={busy || applied || regenDone}
          onClick={onRegenerate}
        >
          {regenerateBusy
            ? <MemoryReviewButtonProgress label="Regenerating..."/>
            : regenDone
              ? <>{Ico.check(13)} Regenerated</>
              : <>{Ico.reset(13)} Regenerate</>}
        </button>
        <button type="button" className="btn ghost" disabled={busy || done} onClick={onDiscard}>
          {discardBusy ? 'Dismissing...' : <>{Ico.x(13)} Dismiss</>}
        </button>
      </div>
    </div>
  );
}

function MemoryReviewInlineProgress({ label }){
  return (
    <div className="mr-progress" role="status" aria-live="polite">
      <span className="typing-dots" aria-hidden="true">
        <span className="typing-dot"/>
        <span className="typing-dot"/>
        <span className="typing-dot"/>
      </span>
      <span>{label || 'Working...'}</span>
    </div>
  );
}

function MemoryReviewButtonProgress({ label }){
  return (
    <span className="mr-btn-progress">
      <span className="typing-dots" aria-hidden="true">
        <span className="typing-dot"/>
        <span className="typing-dot"/>
        <span className="typing-dot"/>
      </span>
      <span>{label}</span>
    </span>
  );
}

function MemoryReviewDecisionNote({ status }){
  if (status !== 'discarded') return null;
  return (
    <div className="mr-item-note">
      Dismissed from this review. Nothing will be applied; the item remains only in the review record.
    </div>
  );
}

function MemoryReviewOperationDiff({ operation, filesByName, after, editing, edited, onChange, onToggleEdit, onReset }){
  const sourceNames = operation.operation === 'create'
    ? (operation.supersedes || [])
    : operation.filename ? [operation.filename] : [];
  const before = sourceNames.map((name) => {
    const file = filesByName.get(name);
    return `# ${name}\n\n${file ? file.content : '(not in current snapshot)'}`;
  }).join('\n\n---\n\n');
  const afterContent = typeof after === 'string' ? after : operation.content || '';
  const diff = buildMemoryReviewLineDiff(before || '(new entry)', afterContent);
  return (
    <div className="mr-diff">
      <div className="mr-diff-head">
        <div className="mr-diff-title">
          <span>{formatMemoryReviewDraftOperation(operation.operation)}</span>
          <span className="u-dim">{operation.reason || ''}</span>
        </div>
        <div className="mr-diff-tools">
          {edited ? <span className="mr-edit-state">Edited</span> : null}
          <button type="button" className="btn ghost" onClick={onToggleEdit}>
            {Ico.edit(12)} {editing ? 'Done editing' : 'Edit markdown'}
          </button>
          {edited ? (
            <button type="button" className="btn ghost" onClick={onReset}>
              {Ico.reset(12)} Reset
            </button>
          ) : null}
        </div>
      </div>
      <div className="mr-diff-grid">
        <MemoryReviewDiffPane title="Before" lines={diff.before}/>
        <MemoryReviewDiffPane title="After" lines={diff.after}/>
      </div>
      {editing ? (
        <div className="mr-edit-panel">
          <textarea
            className="mr-edit-textarea"
            value={afterContent}
            onChange={(event) => onChange(event.target.value)}
            spellCheck="false"
            aria-label="Edited memory markdown"
          />
        </div>
      ) : null}
    </div>
  );
}

function MemoryReviewDiffPane({ title, lines }){
  return (
    <div className="mr-pane">
      <div className="mr-pane-head">{title}</div>
      <div className="mr-code" aria-label={title + ' memory content'}>
        {(lines || []).map((line, idx) => (
          <div key={idx} className={'mr-code-line' + (line.changed ? ' is-changed' : '')}>
            <span className="mr-code-line-num">{idx + 1}</span>
            <span className="mr-code-line-text">{line.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildMemoryReviewLineDiff(beforeText, afterText){
  const beforeLines = splitMemoryReviewLines(beforeText);
  const afterLines = splitMemoryReviewLines(afterText);
  const beforeChanged = new Array(beforeLines.length).fill(false);
  const afterChanged = new Array(afterLines.length).fill(false);
  const table = Array.from({ length: beforeLines.length + 1 }, () => new Array(afterLines.length + 1).fill(0));

  for (let i = beforeLines.length - 1; i >= 0; i--) {
    for (let j = afterLines.length - 1; j >= 0; j--) {
      table[i][j] = beforeLines[i] === afterLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      beforeChanged[i] = true;
      i++;
    } else {
      afterChanged[j] = true;
      j++;
    }
  }
  while (i < beforeLines.length) beforeChanged[i++] = true;
  while (j < afterLines.length) afterChanged[j++] = true;

  return {
    before: beforeLines.map((line, idx) => ({ text: line, changed: beforeChanged[idx] })),
    after: afterLines.map((line, idx) => ({ text: line, changed: afterChanged[idx] })),
  };
}

function splitMemoryReviewLines(value){
  const text = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return text.length ? text.split('\n') : [''];
}

function formatMemoryReviewStatus(status){
  const labels = {
    running: 'Running',
    pending_review: 'Pending',
    completed: 'Completed',
    partially_applied: 'Partially applied',
    dismissed: 'Dismissed',
    failed: 'Failed',
  };
  return labels[status] || 'Pending';
}

function formatMemoryReviewItemStatus(status){
  const labels = {
    pending: 'Pending',
    applied: 'Applied',
    discarded: 'Dismissed',
    stale: 'Stale',
    failed: 'Failed',
  };
  return labels[status] || 'Pending';
}

function formatMemoryReviewSource(source){
  return source === 'scheduled' ? 'Scheduled' : 'Manual';
}

function formatMemoryReviewTime(value){
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value || '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatMemoryReviewAction(action){
  const labels = {
    mark_superseded: 'Mark superseded',
    merge_candidates: 'Merge memories',
    split_candidate: 'Split memory',
    normalize_candidate: 'Normalize memory',
    keep: 'Keep',
  };
  return labels[action] || 'Memory update';
}

function formatMemoryReviewDraftOperation(operation){
  if (operation === 'create') return 'Create';
  if (operation === 'replace') return 'Replace';
  return 'Change';
}
