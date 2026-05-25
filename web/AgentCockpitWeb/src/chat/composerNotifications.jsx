import React from 'react';

import { AgentApi } from '../api.js';
import { CliUpdateStore } from '../cliUpdateStore.js';
import { Ico } from '../icons.jsx';
import { StreamStore } from '../streamStore.js';
import { useToasts } from '../toast.jsx';
import { Tip } from '../tooltip.jsx';
import { useCliUpdates } from '../shellState.jsx';
import { CLAUDE_CODE_INTERACTIVE_BACKEND_ID, workspaceRefForConv } from './chatHelpers.js';

function useFixedPopoverPosition(anchorRef, panelRef, open){
  const [pos, setPos] = React.useState(null);
  React.useEffect(() => {
    if (!open || !anchorRef.current) return undefined;
    const compute = () => {
      const a = anchorRef.current.getBoundingClientRect();
      const p = panelRef.current;
      const pw = p ? p.offsetWidth : 320;
      const ph = p ? p.offsetHeight : 160;
      const margin = 16;
      const gap = 8;
      let left = a.left + a.width / 2 - pw / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
      const above = a.top - gap - ph;
      const below = a.bottom + gap;
      const placeAbove = above >= margin || window.innerHeight - below < ph;
      const top = placeAbove
        ? Math.max(margin, above)
        : Math.min(below, window.innerHeight - ph - margin);
      const arrowX = Math.max(12, Math.min(pw - 18, a.left + a.width / 2 - left - 5));
      setPos({ top, left, placeAbove, arrowX });
    };
    compute();
    const raf = requestAnimationFrame(compute);
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);
  return pos;
}

function ComposerInstructionCompatibilityIcon({ workspaceHash, workspaceLabel, onOpenWorkspaceSettings }){
  const toast = useToasts();
  const buttonRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const pos = useFixedPopoverPosition(buttonRef, panelRef, open);

  const refresh = React.useCallback(async () => {
    if (!workspaceHash) {
      setStatus(null);
      return;
    }
    try {
      const res = await AgentApi.workspace.getInstructionCompatibility(workspaceHash);
      setStatus(res.status || null);
    } catch {
      setStatus(null);
    }
  }, [workspaceHash]);

  React.useEffect(() => {
    let cancelled = false;
    if (!workspaceHash) {
      setStatus(null);
      return undefined;
    }
    AgentApi.workspace.getInstructionCompatibility(workspaceHash)
      .then(res => { if (!cancelled) setStatus(res.status || null); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [workspaceHash]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      if (buttonRef.current && buttonRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  React.useEffect(() => {
    if (!status || !status.shouldNotify) setOpen(false);
  }, [status && status.fingerprint, status && status.shouldNotify]);

  if (!status || !status.shouldNotify) return null;

  const coveredLabels = (status.vendors || []).filter(item => item.covered).map(item => item.label).join(', ') || 'None';
  const missingLabels = (status.missingVendors || []).map(item => item.label).join(', ');
  const presentSources = (status.sources || []).filter(source => source.present);
  const sourceLabel = presentSources.map(source => source.label).join(', ') || 'project instructions';
  const title = 'Instruction pointers needed';

  async function createPointers(){
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await AgentApi.workspace.createInstructionPointers(workspaceHash);
      setStatus(result.status || null);
      const created = result.created || [];
      toast.success(created.length ? 'Instruction pointers created' : 'Instruction pointers already exist');
      if (!result.status || !result.status.shouldNotify) setOpen(false);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function dismiss(){
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await AgentApi.workspace.dismissInstructionCompatibility(workspaceHash);
      setStatus(result.status || null);
      setOpen(false);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  function openInstructions(){
    setOpen(false);
    if (onOpenWorkspaceSettings) {
      onOpenWorkspaceSettings(workspaceHash, workspaceLabel || 'workspace', 'instructions');
    }
  }

  const style = pos
    ? { top: pos.top, left: pos.left }
    : { visibility: 'hidden', top: 0, left: 0 };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="composer-notif state-pending state-instruction-warning"
        aria-label={title}
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => { setError(null); setOpen(v => !v); }}
      >
        {Ico.alert(14)}
        <span className="composer-notif-pulse state-pending"/>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="tt composer-action-popover"
          data-variant="stat"
          data-placement={pos && pos.placeAbove ? 'above' : 'below'}
          data-pinned="true"
          role="dialog"
          aria-label={title}
          style={style}
        >
          <span className="tt-arrow" style={{ left: pos ? pos.arrowX : 12 }}/>
          <div className="tt-header">
            <span className="tt-eye">Instructions</span>
          </div>
          <h4 className="tt-h">{title}</h4>
          <div className="tt-section">
            <div className="tt-rows">
              <div className="tt-kv"><span>Found</span><b title={sourceLabel}>{sourceLabel}</b></div>
              <div className="tt-kv"><span>Covered</span><b title={coveredLabels}>{coveredLabels}</b></div>
              <div className="tt-kv"><span>Needs pointers</span><b title={missingLabels}>{missingLabels}</b></div>
            </div>
          </div>
          <div className="tt-section">
            <div className="hint">
              Create thin pointer files so every supported CLI reads the same workspace instructions.
            </div>
          </div>
          {error ? (
            <div className="tt-section">
              <div className="tt-error-text">{error}</div>
            </div>
          ) : null}
          <div className="tt-foot">
            <span className="hint">No existing instruction files are overwritten.</span>
            <span className="spacer"/>
            <button type="button" className="tt-btn" onClick={openInstructions}>Open</button>
            <button type="button" className="tt-btn" disabled={busy} onClick={dismiss}>Dismiss</button>
            <button type="button" className="tt-btn primary" disabled={busy || !status.canCreatePointers} onClick={createPointers}>
              {busy ? 'Working…' : 'Create pointers'}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function formatInstallMethod(method){
  if (method === 'npm-global') return 'npm global';
  if (method === 'self-update') return 'self updater';
  if (method === 'missing') return 'not found';
  return 'unknown';
}

function ComposerCliUpdateIcon({ cliProfileId, backendId, onOpenSettings }){
  useCliUpdates();
  const toast = useToasts();
  const buttonRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const item = CliUpdateStore.findForSelection(cliProfileId, backendId);
  const interactiveCompatibility = item && Array.isArray(item.interactiveCompatibility)
    ? item.interactiveCompatibility.find(status => status && status.providerId === CLAUDE_CODE_INTERACTIVE_BACKEND_ID && status.severity && status.severity !== 'none')
    : null;
  const showCompatibilityWarning = backendId === CLAUDE_CODE_INTERACTIVE_BACKEND_ID && !!interactiveCompatibility;
  const pos = useFixedPopoverPosition(buttonRef, panelRef, open);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      if (buttonRef.current && buttonRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  React.useEffect(() => {
    if (!item || (!item.updateAvailable && !showCompatibilityWarning)) setOpen(false);
  }, [item && item.id, item && item.updateAvailable, showCompatibilityWarning]);

  if (!item || (!item.updateAvailable && !showCompatibilityWarning)) return null;

  const title = showCompatibilityWarning
    ? 'Claude Code Interactive compatibility warning'
    : item.label + ' update available';
  const showUpdateAction = item.updateAvailable === true;
  const profileLabel = item.profileNames && item.profileNames.length
    ? item.profileNames.slice(0, 2).join(', ') + (item.profileNames.length > 2 ? ' +' + (item.profileNames.length - 2) : '')
    : 'Current profile';

  async function doUpdate(){
    if (!item || busy || !item.updateSupported) return;
    setBusy(true);
    setError(null);
    try {
      const result = await CliUpdateStore.update(item.id);
      if (result && result.success) {
        toast.success(item.label + ' updated');
        setOpen(false);
      } else {
        setError((result && result.error) || 'Update failed');
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  const style = pos
    ? { top: pos.top, left: pos.left }
    : { visibility: 'hidden', top: 0, left: 0 };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="composer-notif state-pending state-cli-update"
        aria-label={title}
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => { setError(null); setOpen(v => !v); }}
      >
        {Ico.terminal(14)}
        <span className="composer-notif-pulse state-pending"/>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="tt composer-action-popover"
          data-variant="stat"
          data-placement={pos && pos.placeAbove ? 'above' : 'below'}
          data-pinned="true"
          role="dialog"
          aria-label={title}
          style={style}
        >
          <span className="tt-arrow" style={{ left: pos ? pos.arrowX : 12 }}/>
          <div className="tt-header">
            <span className="tt-eye">CLI Update</span>
          </div>
          <h4 className="tt-h">{title}</h4>
          <div className="tt-section">
            <div className="tt-rows">
              <div className="tt-kv"><span>Current</span><b>{item.currentVersion || 'unknown'}</b></div>
              <div className="tt-kv"><span>{showCompatibilityWarning ? 'Tested' : 'Available'}</span><b>{showCompatibilityWarning ? interactiveCompatibility.testedVersion : (item.latestVersion || 'unknown')}</b></div>
              <div className="tt-kv"><span>Install</span><b>{formatInstallMethod(item.installMethod)}</b></div>
              <div className="tt-kv"><span>Profile</span><b title={profileLabel}>{profileLabel}</b></div>
            </div>
          </div>
          {showCompatibilityWarning ? (
            <div className="tt-section">
              <div className="tt-error-text">{interactiveCompatibility.message}</div>
            </div>
          ) : item.updateCaution ? (
            <div className="tt-section">
              <div className="tt-error-text">{item.updateCaution}</div>
            </div>
          ) : null}
          {error ? (
            <div className="tt-section">
              <div className="tt-error-text">{error}</div>
            </div>
          ) : null}
          <div className="tt-foot">
            <span className="hint">
              {showUpdateAction
                ? (item.updateSupported ? 'No active stream can be running.' : 'Open settings for update details.')
                : 'Open settings for compatibility details.'}
            </span>
            <span className="spacer"/>
            <button type="button" className="tt-btn" onClick={() => onOpenSettings && onOpenSettings('cli')}>CLI settings</button>
            {showUpdateAction ? (
              <button type="button" className="tt-btn primary" disabled={busy || !item.updateSupported} onClick={doUpdate}>
                {busy ? 'Updating…' : 'Update now'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/* Composer notification icon — car-dashboard-style indicator positioned
   just left of the Send button. Only renders when there is something to
   notify about. Currently sourced exclusively from KB state (pending
   digestions, pending synthesis entries, dreaming-in-progress); designed
   to grow additional notification sources later. Hidden when KB is
   disabled OR when KB is enabled and idle (no pending work, no dream
   running). On hover a rich tooltip shows pending-digestion and
   pending-synthesis counts plus auto-digest state, using the standard
   Tip stat-variant template (.tt-header / .tt-eye / .tt-h / .tt-section
   / .tt-rows / .tt-kv). KB state is hydrated from `conv.kb` on conv
   load and patched live via `kb_state_update` WS frames (handled in
   streamStore). A 2s poll on GET /conversations/:id backstops dream
   progress transitions while a run is in flight. */
function ComposerNotifIcon({ conv, convId }){
  const kb = conv && conv.kb;
  const running = !!(kb && kb.dreamingStatus === 'running');

  React.useEffect(() => {
    if (!running || !convId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await AgentApi.fetch('conversations/' + encodeURIComponent(convId));
        const data = await r.json();
        if (cancelled) return;
        if (data && data.kb) StreamStore.patchConv(convId, { kb: data.kb });
      } catch { /* ignore */ }
    };
    const id = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [running, convId]);

  if (!kb || !kb.enabled) return null;

  const pendingDigest = Math.max(0, kb.pendingDigestions || 0);
  const pendingDream  = Math.max(0, kb.pendingEntries || 0);
  const autoDigest    = !!kb.autoDigest;
  const hasWork       = pendingDigest > 0 || pendingDream > 0;
  if (!running && !hasWork) return null;
  const state = running ? 'running' : 'pending';

  const card = (
    <>
      <div className="tt-header">
        <span className="tt-eye">Knowledge Base</span>
      </div>
      <h4 className="tt-h">
        {running
          ? 'Dreaming…'
          : (pendingDigest + pendingDream) + ' pending'}
      </h4>
      <div className="tt-section">
        <div className="tt-rows">
          <div className="tt-kv">
            <span>Digestion</span>
            <b>
              {pendingDigest === 0
                ? '—'
                : pendingDigest + (pendingDigest === 1 ? ' file' : ' files')}
            </b>
          </div>
          <div className="tt-kv">
            <span>Synthesis</span>
            <b>
              {pendingDream === 0
                ? '—'
                : pendingDream + (pendingDream === 1 ? ' entry' : ' entries')}
            </b>
          </div>
          <div className="tt-kv">
            <span>Auto-digest</span>
            <b>{autoDigest ? 'on' : 'off'}</b>
          </div>
        </div>
      </div>
      {running ? (
        <div className="tt-section">
          <div className="tt-section-label">Dreaming in progress</div>
          <DreamStepper progress={kb._dreamProgress}/>
        </div>
      ) : null}
    </>
  );

  const label = running
    ? 'KB: dreaming in progress'
    : ('KB: ' + (pendingDigest + pendingDream) + ' pending');

  return (
    <Tip variant="stat" rich={card}>
      <button
        type="button"
        className={"composer-notif state-" + state}
        aria-label={label}
      >
        {Ico.book(14)}
        <span className={"composer-notif-pulse state-" + state}/>
      </button>
    </Tip>
  );
}

function DreamStepper({ progress }){
  const phases = ['routing', 'verification', 'synthesis', 'discovery', 'reflection'];
  const currentIdx = progress && progress.phase ? phases.indexOf(progress.phase) : -1;
  return (
    <div className="dream-stepper">
      {phases.map((p, i) => {
        const active = i === currentIdx;
        const done = currentIdx > i;
        const label = p.charAt(0).toUpperCase() + p.slice(1);
        return (
          <React.Fragment key={p}>
            {i > 0 ? <span className="dream-stepper-sep">→</span> : null}
            <span className={"dream-stepper-step" + (active ? ' active' : done ? ' done' : '')}>
              {done ? '✓ ' : ''}{label}{active && progress && progress.total ? ` ${progress.done || 0}/${progress.total}` : ''}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function ComposerMemoryReviewIcon({ conv, workspaceLabel, onOpenMemoryReview }){
  const buttonRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const review = conv && conv.memoryReview;
  const pos = useFixedPopoverPosition(buttonRef, panelRef, open);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      if (buttonRef.current && buttonRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  React.useEffect(() => {
    if (!review || !review.pending) setOpen(false);
  }, [review && review.pending, review && review.latestRunId]);

  if (!review || !review.enabled || !review.pending) return null;

  const drafts = Math.max(0, review.pendingDrafts || 0);
  const safeActions = Math.max(0, review.pendingSafeActions || 0);
  const failed = Math.max(0, review.failedItems || 0);
  const count = drafts + safeActions + failed;
  const title = count === 1 ? '1 Memory Review item' : `${count} Memory Review items`;
  const style = pos
    ? { top: pos.top, left: pos.left }
    : { visibility: 'hidden', top: 0, left: 0 };

  function openReview(){
    setOpen(false);
    const workspaceRef = workspaceRefForConv(conv);
    if (onOpenMemoryReview && workspaceRef) {
      onOpenMemoryReview(workspaceRef, workspaceLabel || 'workspace', review.latestRunId || null);
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="composer-notif state-pending state-memory-review"
        aria-label={title}
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => setOpen(v => !v)}
      >
        {Ico.moon(14)}
        <span className="composer-notif-pulse state-pending"/>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="tt composer-action-popover"
          data-variant="stat"
          data-placement={pos && pos.placeAbove ? 'above' : 'below'}
          data-pinned="true"
          role="dialog"
          aria-label={title}
          style={style}
        >
          <span className="tt-arrow" style={{ left: pos ? pos.arrowX : 12 }}/>
          <div className="tt-header">
            <span className="tt-eye">Memory Review</span>
          </div>
          <h4 className="tt-h">{title}</h4>
          <div className="tt-section">
            <div className="tt-rows">
              <div className="tt-kv"><span>Drafts</span><b>{drafts || '-'}</b></div>
              <div className="tt-kv"><span>Metadata</span><b>{safeActions || '-'}</b></div>
              <div className="tt-kv"><span>Needs attention</span><b>{failed || '-'}</b></div>
            </div>
          </div>
          <div className="tt-foot">
            <span className="hint">{formatMemoryReviewComposerStatus(review.latestRunStatus)}</span>
            <span className="spacer"/>
            <button type="button" className="tt-btn primary" onClick={openReview}>Review</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function formatMemoryReviewComposerStatus(status){
  if (status === 'running') return 'Generating drafts';
  if (status === 'failed') return 'Review needs attention';
  return 'Ready to review';
}

function ComposerWorkspaceContextIcon({ conv, workspaceLabel, onOpenWorkspaceSettings }){
  const buttonRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const workspaceContext = conv && conv.workspaceContext;
  const pos = useFixedPopoverPosition(buttonRef, panelRef, open);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      if (buttonRef.current && buttonRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  React.useEffect(() => {
    if (!workspaceContext || !workspaceContext.pending) setOpen(false);
  }, [workspaceContext && workspaceContext.pending, workspaceContext && workspaceContext.latestRunId]);

  if (!workspaceContext || !workspaceContext.enabled || !workspaceContext.pending) return null;

  const running = Math.max(0, workspaceContext.runningRuns || 0) > 0 || workspaceContext.latestRunStatus === 'running';
  const failures = Math.max(0, workspaceContext.failedRuns || 0);
  const title = running
    ? 'Workspace Context learning'
    : failures === 1 ? '1 Workspace Context run failed' : `${failures} Workspace Context runs failed`;
  const style = pos
    ? { top: pos.top, left: pos.left }
    : { visibility: 'hidden', top: 0, left: 0 };

  function openWorkspaceContext(){
    setOpen(false);
    const workspaceRef = workspaceRefForConv(conv);
    if (onOpenWorkspaceSettings && workspaceRef) {
      const targetSection = running || failures > 0 ? 'runs' : null;
      onOpenWorkspaceSettings(workspaceRef, workspaceLabel || 'workspace', 'workspaceContext', targetSection);
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={"composer-notif state-workspace-context " + (running ? 'state-running' : 'state-pending')}
        aria-label={title}
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => setOpen(v => !v)}
      >
        {Ico.graph(14)}
        <span className={"composer-notif-pulse " + (running ? 'state-running' : 'state-pending')}/>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="tt composer-action-popover"
          data-variant="stat"
          data-placement={pos && pos.placeAbove ? 'above' : 'below'}
          data-pinned="true"
          role="dialog"
          aria-label={title}
          style={style}
        >
          <span className="tt-arrow" style={{ left: pos ? pos.arrowX : 12 }}/>
          <div className="tt-header">
            <span className="tt-eye">Workspace Context</span>
          </div>
          <h4 className="tt-h">{title}</h4>
          <div className="tt-section">
            <div className="tt-rows">
              <div className="tt-kv"><span>Running</span><b>{workspaceContext.runningRuns || '-'}</b></div>
              <div className="tt-kv"><span>Failures</span><b>{failures || '-'}</b></div>
              <div className="tt-kv"><span>Files</span><b>{workspaceContext.fileCount || '-'}</b></div>
              <div className="tt-kv"><span>Latest</span><b>{formatWorkspaceContextComposerStatus(workspaceContext.latestRunStatus)}</b></div>
            </div>
          </div>
          <div className="tt-foot">
            <span className="hint">{formatWorkspaceContextComposerStatus(workspaceContext.latestRunStatus)}</span>
            <span className="spacer"/>
            <button type="button" className="tt-btn primary" onClick={openWorkspaceContext}>Open context</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function formatWorkspaceContextComposerStatus(status){
  if (status === 'running') return 'Learning';
  if (status === 'failed') return 'Failed';
  if (status === 'stopped') return 'Stopped';
  if (status === 'completed') return 'Completed';
  return 'Ready';
}

export {
  ComposerInstructionCompatibilityIcon,
  ComposerCliUpdateIcon,
  ComposerNotifIcon,
  ComposerMemoryReviewIcon,
  ComposerWorkspaceContextIcon,
};
