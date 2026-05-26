import React from 'react';

import { AgentApi } from '../api.js';
import { Ico } from '../icons.jsx';
import { StreamStore } from '../streamStore.js';
import { useDialog } from '../dialog.jsx';
import { useToasts } from '../toast.jsx';
import { BackendInlineIcon, useBackendList, useCliProfileSettings, useConversationSelector, shallowEqual } from '../shellState.jsx';
import { goalElapsedSeconds, goalStatusLabel, goalSupportsAction } from '../goalState.js';
import { AttTray } from './attachments.jsx';
import { QueueStack, SuspendedQueueBanner } from './queue.jsx';
import { backendIdForProfile, CLAUDE_CODE_INTERACTIVE_BACKEND_ID, cliHarnessForBackend, workspaceRefForConv } from './chatHelpers.js';
import {
  ComposerCliUpdateIcon,
  ComposerInstructionCompatibilityIcon,
  ComposerMemoryReviewIcon,
  ComposerNotifIcon,
  ComposerWorkspaceContextIcon,
} from './composerNotifications.jsx';

function selectChatComposerState(s){
  if (!s) return null;
  return {
    conv: s.conv,
    input: s.input,
    sending: s.sending,
    streaming: s.streaming,
    pendingInteraction: s.pendingInteraction,
    composerCliProfileId: s.composerCliProfileId,
    composerBackend: s.composerBackend,
    composerModel: s.composerModel,
    composerEffort: s.composerEffort,
    composerServiceTier: s.composerServiceTier,
    goal: s.goal,
    goalMode: s.goalMode,
    pendingAttachments: s.pendingAttachments,
    queue: s.queue,
    queueSuspended: s.queueSuspended,
  };
}

function compactDuration(seconds){
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return total + 's';
  const mins = Math.floor(total / 60);
  if (mins < 60) return mins + 'm';
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

function normalizeGoalCapability(capability, backendId){
  if (capability === true) {
    return { set: true, clear: true, pause: true, resume: true, status: 'native' };
  }
  if (capability && typeof capability === 'object') {
    return {
      set: capability.set === true,
      clear: capability.clear === true,
      pause: capability.pause === true,
      resume: capability.resume === true,
      status: capability.status || 'none',
    };
  }
  if (backendId === 'codex') return { set: true, clear: true, pause: true, resume: true, status: 'native' };
  if (backendId === 'claude-code' || backendId === CLAUDE_CODE_INTERACTIVE_BACKEND_ID) return { set: true, clear: true, pause: false, resume: false, status: 'transcript' };
  return { set: false, clear: false, pause: false, resume: false, status: 'none' };
}

function goalCapabilityForBackend(backends, backendId){
  const backend = (backends || []).find(b => b && b.id === backendId);
  return normalizeGoalCapability(backend?.capabilities?.goals, backendId);
}

function GoalStrip({ convId, goal, streaming, sending }){
  if (!goal) return null;
  const status = goal.status || 'active';
  const canPause = status === 'active' && goalSupportsAction(goal, 'pause');
  const canResume = status === 'paused' && !streaming && goalSupportsAction(goal, 'resume');
  const canClear = goalSupportsAction(goal, 'clear');
  const claudeGoal = goal.backend === 'claude-code' || goal.backend === CLAUDE_CODE_INTERACTIVE_BACKEND_ID;
  const clearDisabled = sending || (claudeGoal && streaming);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!goal) return undefined;
    StreamStore.refreshGoal(convId);
    const delay = status === 'active' ? 2000 : 5000;
    const poll = setInterval(() => {
      setNowMs(Date.now());
      StreamStore.refreshGoal(convId);
    }, delay);
    return () => clearInterval(poll);
  }, [convId, goal?.threadId, status]);
  React.useEffect(() => {
    if (status !== 'active') return undefined;
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [status, goal?.updatedAt, goal?.timeUsedSeconds]);
  const elapsed = compactDuration(goalElapsedSeconds(goal, nowMs));
  const objective = typeof goal.objective === 'string' ? goal.objective : '';
  return (
    <div className={"goal-strip status-" + status}>
      <div className="goal-strip-main">
        <span className="goal-dot" aria-hidden="true"/>
        <span className="goal-status">{goalStatusLabel(status)}</span>
        {elapsed !== '0s' ? <span className="goal-elapsed">{elapsed}</span> : null}
        {objective ? <span className="goal-objective" title={objective}>{objective}</span> : null}
      </div>
      <div className="goal-strip-actions">
        {canPause ? (
          <button type="button" onClick={() => StreamStore.pauseGoal(convId)} disabled={sending} title="Pause goal">Pause</button>
        ) : null}
        {status === 'paused' && goalSupportsAction(goal, 'resume') ? (
          <button type="button" onClick={() => StreamStore.resumeGoal(convId)} disabled={sending || !canResume} title="Resume goal">Resume</button>
        ) : null}
        {canClear ? (
          <button
            type="button"
            onClick={() => StreamStore.clearGoal(convId)}
            disabled={clearDisabled}
            title={clearDisabled && claudeGoal ? 'Claude Code goals can be cleared after the active turn finishes' : 'Clear goal'}
          >Clear</button>
        ) : null}
      </div>
    </div>
  );
}

export const ChatComposer = React.memo(function ChatComposer({ convId, profileLocked, workspaceLabel, onOpenMemoryReview, onOpenWorkspaceSettings, onOpenSettings }){
  const state = useConversationSelector(convId, selectChatComposerState, shallowEqual);
  const backends = useBackendList();
  const { profiles: cliProfiles } = useCliProfileSettings();
  const dialog = useDialog();
  const toast = useToasts();
  const fileInputRef = React.useRef(null);
  const composerTextRef = React.useRef(null);
  if (!state || !state.conv) return null;

  const conv = state.conv;
  const input = state.input || '';
  const sending = !!state.sending;
  const streaming = !!state.streaming;
  const pendingInteraction = state.pendingInteraction || null;
  const pendingAttachments = state.pendingAttachments || [];
  const queue = state.queue || [];
  const queueSuspended = !!state.queueSuspended;
  const awaiting = !!pendingInteraction;
  const hasUploadingFiles = pendingAttachments.some(f => f.status === 'uploading');
  const hasDoneFiles = pendingAttachments.some(f => f.status === 'done');
  const topbarCliProfileId = profileLocked
    ? (conv.cliProfileId || null)
    : (state.composerCliProfileId || conv.cliProfileId || null);
  const topbarProfile = topbarCliProfileId
    ? cliProfiles.find(profile => profile && profile.id === topbarCliProfileId)
    : null;
  const topbarBackendCandidate = profileLocked
    ? conv.backend
    : (state.composerBackend || conv.backend);
  const topbarBackendId = topbarProfile
    ? (profileLocked ? topbarBackendCandidate : backendIdForProfile(topbarProfile))
    : profileLocked
      ? conv.backend
      : (state.composerBackend || conv.backend);
  const goalCapability = goalCapabilityForBackend(backends, topbarBackendId);
  const goalCapable = goalCapability.set === true;
  const goalMode = goalCapable && !!state.goalMode;
  const activeGoal = state.goal || null;
  const hasContent = !!input.trim() || hasDoneFiles;
  const effectiveHasContent = goalMode ? !!input.trim() : hasContent;
  const canSend = effectiveHasContent && !sending && !streaming && !awaiting && !hasUploadingFiles;
  /* While the agent is streaming, Enter enqueues instead of sending. The
     send button turns into a stop-styled affordance; clicking it enqueues
     whatever is in the composer so the user can stack follow-ups. */
  const canEnqueue = hasContent && !sending && !awaiting && !hasUploadingFiles && streaming;

  function openFilePicker(){ if (fileInputRef.current) fileInputRef.current.click(); }

  function onPickFiles(e){
    const files = Array.from(e.target.files || []);
    if (files.length) StreamStore.addAttachments(convId, files);
    e.target.value = '';
  }

  /* Clipboard parity with V1: pasted image files become attachments (renamed
     to avoid collisions with prior pastes), and pasted text >=1000 chars is
     converted into a synthesized .txt file named pasted-text-<ts>.txt so the
     composer stays readable. Shorter text falls through to the default
     textarea paste. */
  function onPaste(e){
    const items = (e.clipboardData && e.clipboardData.items) || null;
    if (items) {
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            const ts = Date.now();
            const ext = file.name && file.name.includes('.') ? '.' + file.name.split('.').pop() : '.png';
            const baseName = file.name ? file.name.replace(/\.[^.]+$/, '') : 'pasted-image';
            const uniqueName = baseName + '-' + ts + '-' + (files.length + 1) + ext;
            files.push(new File([file], uniqueName, { type: file.type }));
          }
        }
      }
      if (files.length) {
        e.preventDefault();
        StreamStore.addAttachments(convId, files);
        return;
      }
    }
    const pastedText = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (pastedText && pastedText.length >= 1000) {
      e.preventDefault();
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ts = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
        + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
      const textFile = new File([pastedText], 'pasted-text-' + ts + '.txt', { type: 'text/plain' });
      StreamStore.addAttachments(convId, [textFile]);
    }
  }

  /* Reverse a paste-to-attachment: read the synthesized .txt blob back, splice
     it into the composer at the current cursor, then drop the attachment. Only
     wired for fresh pasted-text-*.txt entries that still have a Blob in memory
     (rehydrated entries lose their Blob, so dissolve isn't offered there).
     Confirm before inserting >50KB so a huge dump doesn't surprise the user. */
  async function dissolveAttachment(entry){
    if (!entry || !(entry.file instanceof Blob)) return;
    let text = '';
    try { text = await entry.file.text(); } catch { return; }
    if (text.length > 50000) {
      const ok = await dialog.confirm({
        title: 'Inline this text into the message?',
        body: text.length.toLocaleString() + ' characters will be inserted into the composer.',
        confirmLabel: 'Inline',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
    }
    insertAtComposerCursor(text);
    StreamStore.removeAttachment(convId, entry.id);
  }

  /* Splice text into the composer at the current cursor position (or at the
     end if the textarea isn't focused). Restores the caret after the React
     re-render so the user can keep typing immediately. Shared by attachment
     dissolve and OCR. */
  function insertAtComposerCursor(text){
    if (!text) return;
    const ta = composerTextRef.current;
    const current = (ta ? ta.value : (StreamStore.getState(convId) || {}).input) || '';
    let nextValue;
    let caret;
    if (ta && typeof ta.selectionStart === 'number') {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      nextValue = current.slice(0, start) + text + current.slice(end);
      caret = start + text.length;
    } else {
      nextValue = current + text;
      caret = nextValue.length;
    }
    StreamStore.setInput(convId, nextValue);
    requestAnimationFrame(() => {
      const t = composerTextRef.current;
      if (!t) return;
      t.focus();
      try { t.setSelectionRange(caret, caret); } catch {}
    });
  }

  /* OCR a pasted screenshot to Markdown via a one-shot CLI call and splice
     the result at the cursor. The original image attachment stays put; the
     user decides whether to remove it or keep it. */
  async function ocrAttachment(entry){
    if (!entry || !entry.result || entry.result.kind !== 'image') return;
    try {
      const markdown = await StreamStore.ocrAttachment(convId, entry.id);
      if (!markdown) {
        toast.error('OCR returned no text');
        return;
      }
      insertAtComposerCursor(markdown);
    } catch (err) {
      toast.error('OCR failed: ' + (err.message || 'unknown error'));
    }
  }

  function handleGoalSlash(text){
    if (!text || !/^\/goal(?:\s|$)/i.test(text)) return false;
    if (!goalCapable) {
      const backendLabel = (backends.find(b => b && b.id === topbarBackendId) || {}).label || topbarBackendId || 'this backend';
      toast.error('Goals are not supported by ' + backendLabel);
      return true;
    }
    const arg = text.replace(/^\/goal\b/i, '').trim();
    if (!arg) {
      StreamStore.setInput(convId, '');
      StreamStore.setGoalMode(convId, true);
      return true;
    }
    const command = arg.toLowerCase();
    StreamStore.setInput(convId, '');
    if (command === 'pause') {
      if (!goalCapability.pause) {
        const backendLabel = (backends.find(b => b && b.id === topbarBackendId) || {}).label || topbarBackendId || 'this backend';
        toast.error('Goal pause is not supported by ' + backendLabel);
        return true;
      }
      StreamStore.pauseGoal(convId);
      return true;
    }
    if (command === 'resume') {
      if (!goalCapability.resume) {
        const backendLabel = (backends.find(b => b && b.id === topbarBackendId) || {}).label || topbarBackendId || 'this backend';
        toast.error('Goal resume is not supported by ' + backendLabel);
        return true;
      }
      StreamStore.resumeGoal(convId);
      return true;
    }
    if (command === 'clear') {
      StreamStore.clearGoal(convId);
      return true;
    }
    StreamStore.setGoal(convId, arg);
    return true;
  }

  function doSend(){
    if (!canSend) return;
    const text = input.trim();
    if (handleGoalSlash(text)) return;
    if (goalMode) {
      StreamStore.setGoal(convId, text);
      return;
    }
    StreamStore.send(convId, text);
  }

  /* Enqueue the current composer contents as a QueuedMessage behind the
     live run. Attachments detach from pendingAttachments and ride the
     queue entry directly; the server copies already live in artifacts/. */
  function doEnqueue(){
    if (!canEnqueue) return;
    const text = input.trim();
    const atts = pendingAttachments.filter(f => f.status === 'done').map(f => f.result).filter(Boolean);
    StreamStore.enqueue(convId, text, atts);
    StreamStore.setInput(convId, '');
    StreamStore.clearPendingAttachments(convId);
  }

  function doEnqueueOrSend(preferQueue){
    if (preferQueue && hasContent && !sending && !awaiting && !hasUploadingFiles) {
      const text = input.trim();
      const atts = pendingAttachments.filter(f => f.status === 'done').map(f => f.result).filter(Boolean);
      StreamStore.enqueue(convId, text, atts);
      StreamStore.setInput(convId, '');
      StreamStore.clearPendingAttachments(convId);
      return;
    }
    if (canSend) doSend();
  }

  function doStop(){
    if (!streaming) return;
    StreamStore.stopStream(convId);
  }

  function onKeyDown(e){
    if (e.key !== 'Enter' || e.shiftKey || e.altKey) return;
    const isMeta = e.metaKey || e.ctrlKey;
    e.preventDefault();
    if (isMeta) {
      /* Ctrl/Command+Enter always enqueues, matching the composer hint. */
      if (canEnqueue || canSend) doEnqueueOrSend(/* preferQueue */ true);
      return;
    }
    if (canSend) doSend();
    else if (canEnqueue) doEnqueue();
  }

  return (
    <div className="composer">
      <div className="composer-inner">
        {activeGoal ? (
          <GoalStrip
            convId={convId}
            goal={activeGoal}
            streaming={streaming}
            sending={sending}
          />
        ) : null}
        <div className="composer-box">
          <textarea
            ref={composerTextRef}
            rows={3}
            placeholder={
              awaiting
                ? 'Answer the prompt above to continue…'
                : streaming ? 'Agent is running — Enter queues behind the current run.'
                  : goalMode ? 'Set a goal…' : 'Message Agent Cockpit…'
            }
            value={input}
            onChange={(e)=>StreamStore.setInput(convId, e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={awaiting}
            style={{
              width:"100%",
              border:0,
              outline:"none",
              background:"transparent",
              color:"var(--text)",
              resize:"none",
              fontFamily:"inherit",
              fontSize:14,
              lineHeight:1.5,
              padding:"12px 14px",
              display:"block",
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={onPickFiles}
            style={{display:"none"}}
          />
          {pendingAttachments.length ? (
            <AttTray
              convId={convId}
              attachments={pendingAttachments}
              onRemove={(id) => StreamStore.removeAttachment(convId, id)}
              onDissolve={dissolveAttachment}
              onOcr={ocrAttachment}
              onAdd={openFilePicker}
            />
          ) : null}
          {queue.length && queueSuspended ? (
            <SuspendedQueueBanner
              count={queue.length}
              onResume={() => StreamStore.resumeSuspendedQueue(convId)}
              onClear={() => StreamStore.clearQueue(convId)}
            />
          ) : null}
          {queue.length ? (
            <QueueStack
              convId={convId}
              queue={queue}
              onClear={() => StreamStore.clearQueue(convId)}
              onRemove={(i) => StreamStore.removeFromQueue(convId, i)}
              onMoveUp={(i) => StreamStore.reorderQueue(convId, i, i - 1)}
              onMoveDown={(i) => StreamStore.reorderQueue(convId, i, i + 1)}
            />
          ) : null}
          <div className="composer-foot">
            <ComposerPicks
              convId={convId}
              backends={backends}
              cliProfiles={cliProfiles}
              composerCliProfileId={state.composerCliProfileId || conv.cliProfileId || null}
              composerBackend={state.composerBackend || conv.backend || null}
              composerModel={state.composerModel || conv.model || null}
              composerEffort={state.composerEffort || conv.effort || null}
              composerServiceTier={state.composerServiceTier != null ? state.composerServiceTier : (conv.serviceTier || 'default')}
              profileLocked={profileLocked}
              disabled={awaiting || sending}
            />
            <span className="attach">
              <button
                type="button"
                className="btn ghost"
                onClick={openFilePicker}
                disabled={awaiting}
                title="Attach files"
                aria-label="Attach files"
                style={{padding:"4px 8px"}}
              >
                {Ico.paperclip(12)}
                <span style={{fontSize:11.5}}>Attach…</span>
              </button>
            </span>
            <ComposerNotifIcon conv={conv} convId={convId}/>
            <ComposerMemoryReviewIcon conv={conv} workspaceLabel={workspaceLabel} onOpenMemoryReview={onOpenMemoryReview}/>
            <ComposerWorkspaceContextIcon conv={conv} workspaceLabel={workspaceLabel} onOpenWorkspaceSettings={onOpenWorkspaceSettings}/>
            <ComposerInstructionCompatibilityIcon
              workspaceHash={workspaceRefForConv(conv)}
              workspaceLabel={workspaceLabel}
              onOpenWorkspaceSettings={onOpenWorkspaceSettings}
            />
            <ComposerCliUpdateIcon
              cliProfileId={topbarCliProfileId}
              backendId={topbarBackendId}
              onOpenSettings={onOpenSettings}
            />
            {goalCapable ? (
              <label className={"goal-toggle" + (goalMode ? " active" : "")}>
                <input
                  type="checkbox"
                  checked={goalMode}
                  onChange={(e) => StreamStore.setGoalMode(convId, e.target.checked)}
                  disabled={awaiting || sending || streaming}
                />
                <span>Goal</span>
              </label>
            ) : null}
            {streaming ? (
              hasContent ? (
                <button
                  className="send"
                  onClick={doEnqueue}
                  disabled={!canEnqueue}
                  title={canEnqueue ? 'Queue behind current run' : 'Agent is running'}
                  aria-label="Queue behind current run"
                  style={!canEnqueue ? {opacity:.5,cursor:"not-allowed"} : undefined}
                >
                  {Ico.up(14)}
                </button>
              ) : (
                <button
                  className="send stop"
                  onClick={doStop}
                  title="Stop agent"
                  aria-label="Stop agent"
                >
                  {Ico.stop(14)}
                </button>
              )
            ) : (
              <button
                className="send"
                onClick={doSend}
                disabled={!canSend}
                title={goalMode ? 'Set goal' : 'Send'}
                aria-label={goalMode ? 'Set goal' : 'Send'}
                style={!canSend ? {opacity:.4,cursor:"not-allowed"} : undefined}
              >
                {Ico.up(14)}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

/* Cascading pickers below the composer: Profile → Model → Effort → Speed.
   Values flush to the server with the next /message POST (see StreamStore.send).
   Each chip wraps a transparent native <select> so we get native dropdown
   UX, keyboard/a11y for free, and the chip's styled shell. */
function ComposerPicks({ convId, backends, cliProfiles, composerCliProfileId, composerBackend, composerModel, composerEffort, composerServiceTier, profileLocked, disabled }){
  const activeProfiles = Array.isArray(cliProfiles) ? cliProfiles.filter(p => p && !p.disabled) : [];
  const exactProfile = activeProfiles.find(p => p.id === composerCliProfileId) || null;
  const canRepairMissingProfile = profileLocked && !!composerCliProfileId && !exactProfile;
  const canChangeProfile = !profileLocked || canRepairMissingProfile;
  const selectedProfile = exactProfile
    || (canChangeProfile && composerBackend ? activeProfiles.find(p => p.harness === cliHarnessForBackend(composerBackend)) : null)
    || (canChangeProfile && activeProfiles.length === 1 ? activeProfiles[0] : null)
    || null;
  const effectiveBackendId = selectedProfile
    ? backendIdForProfile(selectedProfile)
    : composerBackend;
  const [profileBackend, setProfileBackend] = React.useState(null);

  React.useEffect(() => {
    if (!selectedProfile) {
      setProfileBackend(null);
      return;
    }
    let cancelled = false;
    setProfileBackend(null);
    AgentApi.getCliProfileMetadata(selectedProfile.id)
      .then(backend => {
        if (!cancelled) setProfileBackend(backend || null);
      })
      .catch(() => {
        if (!cancelled) setProfileBackend(null);
      });
    return () => { cancelled = true; };
  }, [selectedProfile && selectedProfile.id]);
  React.useEffect(() => {
    if (!canChangeProfile || !selectedProfile || !effectiveBackendId) return;
    if (composerCliProfileId !== selectedProfile.id || composerBackend !== effectiveBackendId) {
      StreamStore.setComposerCliProfile(convId, selectedProfile.id, effectiveBackendId);
    }
  }, [convId, canChangeProfile, selectedProfile && selectedProfile.id, effectiveBackendId, composerCliProfileId, composerBackend]);

  const backend = (selectedProfile && profileBackend && profileBackend.id === effectiveBackendId)
    ? profileBackend
    : (backends.find(b => b.id === effectiveBackendId) || null);
  const backendModels = (backend && Array.isArray(backend.models)) ? backend.models : [];
  const model = backendModels.find(m => m.id === composerModel)
    || backendModels.find(m => m.default)
    || backendModels[0]
    || null;
  const effortLevels = (model && Array.isArray(model.supportedEffortLevels)) ? model.supportedEffortLevels : [];
  const effort = effortLevels.includes(composerEffort)
    ? composerEffort
    : (effortLevels.includes('high') ? 'high' : (effortLevels[0] || null));
  const serviceTier = composerServiceTier === 'fast' ? 'fast' : 'default';

  /* If picker state drifted out of the backend's catalog (e.g. backend change
      invalidated the chosen model), push the reconciled value back down so
     the next send uses a valid pair. */
  React.useEffect(() => {
    if (backend && model && composerModel !== model.id) {
      StreamStore.setComposerModel(convId, model.id);
    }
  }, [convId, backend && backend.id, model && model.id, composerModel]);
  React.useEffect(() => {
    if (effort !== composerEffort) {
      StreamStore.setComposerEffort(convId, effort);
    }
  }, [convId, effort, composerEffort]);

  if (backends.length === 0) return <span className="picks"/>;

  return (
    <span className="picks">
      {activeProfiles.length > 0 ? (
        <PickChip
          label="Profile"
          value={selectedProfile ? selectedProfile.name : 'Select profile'}
          disabled={disabled || !canChangeProfile}
          options={[
            ...(!selectedProfile ? [{ value: '', label: 'Select profile', disabled: true }] : []),
            ...activeProfiles.map(p => ({ value: p.id, label: p.name })),
          ]}
          currentValue={selectedProfile ? selectedProfile.id : ''}
          icon={selectedProfile ? <BackendInlineIcon backends={backends} backendId={effectiveBackendId}/> : null}
          onChange={v => {
            const profile = activeProfiles.find(p => p.id === v);
            if (profile) {
              const nextBackend = backendIdForProfile(profile);
              StreamStore.setComposerCliProfile(convId, profile.id, nextBackend);
            }
          }}
          title={canRepairMissingProfile ? 'Select replacement CLI profile' : (profileLocked ? 'CLI profile locked for this session' : 'CLI Profile')}
        />
      ) : (
        <PickChip
          label="Backend"
          value={backend ? backend.label : (composerBackend || '—')}
          disabled={disabled || profileLocked}
          options={backends.map(b => ({ value: b.id, label: b.label }))}
          currentValue={backend ? backend.id : ''}
          icon={backend ? <BackendInlineIcon backends={backends} backendId={backend.id}/> : null}
          onChange={v => StreamStore.setComposerBackend(convId, v)}
          title={profileLocked ? 'Backend locked for this session' : 'Backend'}
        />
      )}
      {backendModels.length > 0 ? (
        <PickChip
          label="Model"
          value={model ? model.label : (composerModel || '—')}
          disabled={disabled}
          options={backendModels.map(m => ({ value: m.id, label: m.label + costTierDot(m.costTier) }))}
          currentValue={model ? model.id : ''}
          onChange={v => StreamStore.setComposerModel(convId, v)}
          title="Model"
        />
      ) : null}
      {effortLevels.length > 0 ? (
        <PickChip
          label="Effort"
          value={effort || '—'}
          disabled={disabled}
          options={effortLevels.map(lv => ({ value: lv, label: lv[0].toUpperCase() + lv.slice(1) }))}
          currentValue={effort || ''}
          onChange={v => StreamStore.setComposerEffort(convId, v)}
          title="Adaptive reasoning effort"
        />
      ) : null}
      {effectiveBackendId === 'codex' ? (
        <PickChip
          label="Speed"
          value={serviceTier === 'fast' ? 'Fast' : 'Default'}
          disabled={disabled}
          options={[
            { value: 'default', label: 'Default' },
            { value: 'fast', label: 'Fast' },
          ]}
          currentValue={serviceTier}
          onChange={v => StreamStore.setComposerServiceTier(convId, v)}
          title="Codex service tier"
        />
      ) : null}
    </span>
  );
}

function costTierDot(tier){
  if (tier === 'high') return ' \u25cf';  // ●
  if (tier === 'low')  return ' \u25cb';  // ○
  return '';
}

function PickChip({ label, value, options, currentValue, onChange, disabled, title, icon }){
  const accessibleLabel = title || label;
  return (
    <span className="pick" title={accessibleLabel} aria-disabled={disabled ? 'true' : 'false'}>
      {icon ? <span className="pick-icon">{icon}</span> : null}
      <b>{value}</b>
      <span className="chev">{Ico.chevD(10)}</span>
      <select
        className="pick-select"
        value={currentValue}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        aria-label={accessibleLabel}
      >
        {options.map(o => (
          <option key={o.value} value={o.value} disabled={!!o.disabled}>{o.label}</option>
        ))}
      </select>
    </span>
  );
}
