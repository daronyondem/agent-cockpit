import React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Ico } from './icons.jsx';
import { AgentApi } from './api.js';
import { Tip } from './tooltip.jsx';
import { useDialog } from './dialog.jsx';
import { useToasts } from './toast.jsx';

/* ---------- WorkspaceSettingsPage — per-workspace settings screen. ---------- */
/* Opens from the gear button in the sidebar workspace action buttons.
   Four tabs:
     - Instructions: free-form system-prompt prefix (Save button).
     - Memory: enable toggle (immediate-save) + searchable, lifecycle-filtered
       grouped browser with per-file delete and a "Clear all" footer. Refetches
       snapshot after each mutation.
     - Knowledge Base: enable toggle (immediate-save). Full KB management lives
       in the dedicated KB Browser screen.
     - Workspace Context: enable toggle (immediate-save), workspace processor overrides,
       markdown file preview, workspace processor overrides, and scan/maintenance runs.
   Reuses the same full-screen `settings-shell` structure as global Settings. */

const WS_SETTINGS_TABS = [
  { id: 'instructions', label: 'Instructions' },
  { id: 'memory',       label: 'Memory' },
  { id: 'kb',           label: 'Knowledge Base' },
  { id: 'workspaceContext',   label: 'Workspace Context' },
];

const WORKSPACE_CONTEXT_SECTIONS = ['overview', 'processor', 'files', 'runs', 'danger'];
const WORKSPACE_CONTEXT_RUNS_PAGE_SIZE = 5;

function workspaceContextRunsFromState(state){
  const runs = Array.isArray(state && state.runs) ? state.runs : [];
  const lastRun = state && state.lastRun;
  const mergedRuns = lastRun ? [lastRun, ...runs.filter(run => run && run.runId !== lastRun.runId)] : runs;
  return mergedRuns.slice().sort((a, b) => workspaceContextRunTimestamp(b) - workspaceContextRunTimestamp(a));
}

function workspaceContextRunFromStatus(status, previousState){
  if (!status || !status.lastRunId) return null;
  const existing = workspaceContextRunsFromState(previousState).find(run => run && run.runId === status.lastRunId) || {};
  const running = status.lastRunStatus === 'running';
  return {
    ...existing,
    runId: status.lastRunId,
    source: status.lastRunSource || existing.source || 'scheduled',
    status: status.lastRunStatus || existing.status || 'running',
    startedAt: status.lastRunCreatedAt || existing.startedAt || status.lastRunUpdatedAt || new Date().toISOString(),
    completedAt: running ? undefined : (status.lastRunUpdatedAt || existing.completedAt),
    filesConsidered: existing.filesConsidered || 0,
    summary: existing.summary || null,
  };
}

function workspaceContextRunTimestamp(run){
  const timestamp = Date.parse((run && run.startedAt) || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function renderWorkspaceContextRunMarkdown(markdown){
  const raw = marked.parse(String(markdown || ''), { breaks: true, gfm: true });
  return DOMPurify.sanitize(raw);
}

function resolveWorkspaceContextRunFileLink(href, files, contextDir){
  let raw = String(href || '').trim();
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {}
  raw = raw.split('#')[0].split('?')[0].trim();
  raw = raw.replace(/\.md:\d+(?::\d+)?$/i, '.md');
  raw = raw.replace(/\.markdown:\d+(?::\d+)?$/i, '.markdown');
  if (!/\.(md|markdown)$/i.test(raw)) return null;

  const available = Array.isArray(files) ? files : [];
  const normalizedContextDir = String(contextDir || '').replace(/\/+$/, '');
  const candidates = new Set([raw.replace(/^\.?\//, '')]);
  if (normalizedContextDir && raw.startsWith(normalizedContextDir + '/')) {
    candidates.add(raw.slice(normalizedContextDir.length + 1));
  }

  for (const candidate of candidates) {
    const match = available.find(file => file && file.path === candidate);
    if (match) return match.path;
  }

  const basename = raw.split('/').pop();
  const basenameMatches = basename
    ? available.filter(file => file && (file.path === basename || file.name === basename || String(file.path || '').endsWith('/' + basename)))
    : [];
  return basenameMatches.length === 1 ? basenameMatches[0].path : null;
}

function WorkspaceContextRunSummary({ summary, files, contextDir, onOpenFile }){
  const html = React.useMemo(() => renderWorkspaceContextRunMarkdown(summary), [summary]);
  const onClick = React.useCallback((event) => {
    if (!onOpenFile) return;
    const target = event.target;
    const link = target && typeof target.closest === 'function' ? target.closest('a') : null;
    if (!link) return;
    const relPath = resolveWorkspaceContextRunFileLink(link.getAttribute('href'), files, contextDir);
    if (!relPath) return;
    event.preventDefault();
    onOpenFile(relPath);
  }, [files, contextDir, onOpenFile]);
  return <div className="ws-wc-run-summary prose" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }}/>;
}

function normalizeWorkspaceContextSection(section){
  return WORKSPACE_CONTEXT_SECTIONS.includes(section) ? section : 'overview';
}

function formatWorkspaceContextRunStatus(status){
  const labels = {
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    stopped: 'Stopped',
    skipped: 'Skipped',
  };
  return labels[status] || status || 'Unknown';
}

function formatWorkspaceContextRunSource(source){
  const labels = {
    initial_scan: 'Initial scan',
    scheduled: 'Scheduled',
    session_reset: 'Session reset',
    archive: 'Archive',
    manual_catchup: 'Manual scan',
    maintenance: 'Maintenance',
  };
  return labels[source] || source || 'Workspace Context';
}

function isWorkspaceContextMaintenanceRun(run){
  return run && run.source === 'maintenance';
}

function isWorkspaceContextScanRun(run){
  return run && run.source !== 'maintenance';
}

function workspaceContextFileLabel(file){
  return (file && (file.name || file.path)) || 'Untitled.md';
}

function WorkspaceSettingsHelpTooltip({ children }){
  return (
    <div className="tt-section settings-help-tooltip">
      <div className="tt-body-text">{children}</div>
    </div>
  );
}

function WorkspaceContextLabel({ children, help }){
  return (
    <span className="settings-field-label-row">
      <span>{children}</span>
      {help ? (
        <Tip variant="explain" rich={<WorkspaceSettingsHelpTooltip>{help}</WorkspaceSettingsHelpTooltip>}>
          <button
            type="button"
            className="settings-help-btn"
            aria-label={`${children} help`}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          >?</button>
        </Tip>
      ) : null}
    </span>
  );
}

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

function activeWorkspaceCliProfiles(settings){
  return Array.isArray(settings && settings.cliProfiles)
    ? settings.cliProfiles.filter(p => p && !p.disabled)
    : [];
}

function cliVendorForBackend(backendId){
  return backendId === 'claude-code-interactive' ? 'claude-code' : backendId;
}

function workspaceBackendIdForProfile(profile){
  if (!profile) return null;
  if (profile.vendor === 'claude-code' && profile.protocol === 'interactive') return 'claude-code-interactive';
  return profile.vendor;
}

function workspaceProfileForBackend(profiles, backendId){
  if (!backendId) return null;
  const vendor = cliVendorForBackend(backendId);
  return profiles.find(p => workspaceBackendIdForProfile(p) === backendId)
    || profiles.find(p => p.id === 'server-configured-' + vendor)
    || profiles.find(p => p.vendor === vendor)
    || null;
}

function workspaceProfileForSetting(profiles, profileId, backendId, fallbackBackend){
  return (profileId ? profiles.find(p => p.id === profileId) : null)
    || workspaceProfileForBackend(profiles, backendId)
    || workspaceProfileForBackend(profiles, fallbackBackend)
    || null;
}

function workspaceBackendForProfile(backends, profileBackends, profile){
  if (!profile) return null;
  return (profileBackends && profileBackends[profile.id])
    || (backends || []).find(b => b.id === workspaceBackendIdForProfile(profile))
    || null;
}

function workspaceModelsForProfile(backends, profileBackends, profile){
  const b = workspaceBackendForProfile(backends, profileBackends, profile);
  return (b && Array.isArray(b.models)) ? b.models : [];
}

function workspaceDefaultModelId(models){
  const def = (models || []).find(m => m.default);
  return (def || (models || [])[0] || {}).id;
}

function workspaceEffortLevelsForProfile(backends, profileBackends, profile, modelId){
  const models = workspaceModelsForProfile(backends, profileBackends, profile);
  const m = models.find(x => x.id === modelId);
  if (!m || !Array.isArray(m.supportedEffortLevels)) return [];
  return m.supportedEffortLevels;
}

function workspaceDefaultEffort(levels){
  if (!levels || !levels.length) return undefined;
  return levels.includes('high') ? 'high' : levels[0];
}


export function WorkspaceSettingsPage({ hash, label, initialTab, initialWorkspaceContextSection, onOpenMemoryReview, onClose }){
  const [tab, setTab] = React.useState(() => WS_SETTINGS_TABS.some(t => t.id === initialTab) ? initialTab : 'instructions');
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
  const [workspaceContextEnabled, setWorkspaceContextEnabled] = React.useState(false);
  const [workspaceContextSettings, setWorkspaceContextSettings] = React.useState({ processorMode: 'global' });
  const [workspaceContextSettingsDirty, setWorkspaceContextSettingsDirty] = React.useState(false);
  const [workspaceContextState, setWorkspaceContextState] = React.useState(null);
  const [workspaceContextFiles, setWorkspaceContextFiles] = React.useState([]);
  const [workspaceContextContextDir, setWorkspaceContextContextDir] = React.useState('');
  const [workspaceContextInstructionPath, setWorkspaceContextInstructionPath] = React.useState('');
  const [workspaceContextSelectedFile, setWorkspaceContextSelectedFile] = React.useState(null);
  const [workspaceContextFileContent, setWorkspaceContextFileContent] = React.useState('');
  const [workspaceContextFileLoading, setWorkspaceContextFileLoading] = React.useState(false);
  const [workspaceContextScanBusy, setWorkspaceContextScanBusy] = React.useState(false);
  const [workspaceContextStopBusy, setWorkspaceContextStopBusy] = React.useState(false);
  const [globalSettings, setGlobalSettings] = React.useState({});
  const [backends, setBackends] = React.useState([]);
  const [profileBackends, setProfileBackends] = React.useState({});
  const dialog = useDialog();
  const toast = useToasts();

  function applyWorkspaceContextResponse(res){
    const next = res || {};
    setWorkspaceContextEnabled(!!next.enabled);
    setWorkspaceContextSettings(next.settings || { processorMode: 'global' });
    setWorkspaceContextSettingsDirty(false);
    setWorkspaceContextState(next.state || null);
    setWorkspaceContextFiles(Array.isArray(next.files) ? next.files : []);
    setWorkspaceContextContextDir(next.contextDir || '');
    setWorkspaceContextInstructionPath(next.instructionPath || '');
  }

  function applyWorkspaceContextRuntimeResponse(res){
    const next = res || {};
    setWorkspaceContextEnabled(!!next.enabled);
    setWorkspaceContextState(next.state || null);
    setWorkspaceContextFiles(Array.isArray(next.files) ? next.files : []);
    setWorkspaceContextContextDir(next.contextDir || '');
    setWorkspaceContextInstructionPath(next.instructionPath || '');
    const running = workspaceContextRunsFromState(next.state).some(run => run && run.status === 'running');
    if (!running) {
      setWorkspaceContextScanBusy(false);
      setWorkspaceContextStopBusy(false);
    }
  }

  const workspaceContextRunPollKey = workspaceContextRunsFromState(workspaceContextState)
    .map(run => `${run.runId || ''}:${run.status || ''}`)
    .join('|');

  React.useEffect(() => {
    if (!hash) return;
    let cancelled = false;
    setTab(WS_SETTINGS_TABS.some(t => t.id === initialTab) ? initialTab : 'instructions');
    setLoading(true); setLoadError(null);
    setInstructionsDirty(false);
    Promise.all([
      AgentApi.workspace.getInstructions(hash).catch(() => ({})),
      AgentApi.workspace.getMemory(hash).catch(() => ({})),
      AgentApi.workspace.getMemoryReviewSchedule(hash).catch(() => ({})),
      AgentApi.workspace.getKb(hash).catch(() => ({})),
      AgentApi.workspace.getWorkspaceContextSettings(hash).catch(() => ({})),
      AgentApi.settings.get().catch(() => ({})),
      AgentApi.settings.backends().catch(() => ({ backends: [] })),
    ]).then(([instrRes, memRes, reviewScheduleRes, kbRes, workspaceContextRes, settingsRes, backendsRes]) => {
      if (cancelled) return;
      setInstructions(instrRes.instructions || '');
      setMemoryEnabled(!!memRes.enabled);
      setMemorySnapshot(memRes.snapshot || null);
      setMemoryReviewSchedule(reviewScheduleRes.schedule || { mode: 'off' });
      setMemoryReviewStatus(reviewScheduleRes.status || null);
      setReviewStarting(false);
      setKbEnabled(!!kbRes.enabled);
      applyWorkspaceContextResponse(workspaceContextRes);
      setWorkspaceContextSelectedFile(null);
      setWorkspaceContextFileContent('');
      setWorkspaceContextFileLoading(false);
      setWorkspaceContextScanBusy(false);
      setWorkspaceContextStopBusy(false);
      setGlobalSettings(settingsRes || {});
      setBackends((backendsRes && backendsRes.backends) || []);
    }).catch(e => {
      if (!cancelled) setLoadError(e.message || String(e));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [hash, initialTab]);

  React.useEffect(() => {
    if (!hash) return;
    let cancelled = false;
    const onMemoryUpdate = (event) => {
      if (!event || !event.detail || event.detail.hash !== hash) return;
      AgentApi.workspace.getMemory(hash).then((memRes) => {
        if (cancelled) return;
        setMemoryEnabled(!!memRes.enabled);
        setMemorySnapshot(memRes.snapshot || null);
      }).catch(() => {});
    };
    window.addEventListener('ac:memory-update', onMemoryUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener('ac:memory-update', onMemoryUpdate);
    };
  }, [hash]);

  React.useEffect(() => {
    if (!hash) return;
    const onReviewUpdate = (event) => {
      if (!event || !event.detail || event.detail.hash !== hash) return;
      const review = event.detail.review || null;
      setMemoryReviewStatus(review);
      if (!review || review.latestRunStatus !== 'running') setReviewStarting(false);
    };
    window.addEventListener('ac:memory-review-update', onReviewUpdate);
    return () => window.removeEventListener('ac:memory-review-update', onReviewUpdate);
  }, [hash]);

  React.useEffect(() => {
    if (!hash) return;
    let cancelled = false;
    const onWorkspaceContextUpdate = (event) => {
      if (!event || !event.detail || event.detail.hash !== hash) return;
      const status = event.detail.workspaceContext || null;
      if (status) {
        setWorkspaceContextEnabled(!!status.enabled);
        setWorkspaceContextState(prev => {
          const run = workspaceContextRunFromStatus(status, prev);
          if (!run) return prev;
          const runs = workspaceContextRunsFromState({ ...(prev || {}), lastRun: run }).slice(0, 25);
          return { ...(prev || {}), lastRun: run, runs };
        });
        if (status.lastRunStatus !== 'running') {
          setWorkspaceContextScanBusy(false);
          setWorkspaceContextStopBusy(false);
        }
      }
      AgentApi.workspace.getWorkspaceContextSettings(hash).then((res) => {
        if (!cancelled) applyWorkspaceContextRuntimeResponse(res);
      }).catch(() => {});
    };
    window.addEventListener('ac:workspace-context-update', onWorkspaceContextUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener('ac:workspace-context-update', onWorkspaceContextUpdate);
    };
  }, [hash]);

  React.useEffect(() => {
    if (!hash || tab !== 'workspaceContext') return undefined;
    let cancelled = false;
    const intervalMs = 1000;
    const refresh = () => {
      AgentApi.workspace.getWorkspaceContextSettings(hash).then((res) => {
        if (!cancelled) applyWorkspaceContextRuntimeResponse(res);
      }).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hash, tab, workspaceContextRunPollKey, workspaceContextScanBusy, workspaceContextStopBusy]);

  React.useEffect(() => {
    if (!hash || tab !== 'memory') return undefined;
    let cancelled = false;
    const running = reviewStarting || (memoryReviewStatus && memoryReviewStatus.latestRunStatus === 'running');
    const refresh = () => {
      AgentApi.workspace.getMemoryReviewSchedule(hash).then((res) => {
        if (cancelled) return;
        setMemoryReviewSchedule(res.schedule || { mode: 'off' });
        setMemoryReviewStatus(res.status || null);
        if (!res.status || res.status.latestRunStatus !== 'running') setReviewStarting(false);
      }).catch(() => {});
    };
    const timer = setInterval(refresh, running ? 2000 : 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hash, tab, reviewStarting, memoryReviewStatus && memoryReviewStatus.latestRunStatus]);

  const loadProfileBackend = React.useCallback((profileId) => {
    if (!profileId || profileBackends[profileId]) return;
    AgentApi.getCliProfileMetadata(profileId)
      .then((backend) => {
        if (!backend) return;
        setProfileBackends(prev => ({ ...prev, [profileId]: backend }));
      })
      .catch(() => {});
  }, [profileBackends]);

  if (!hash) return null;

  async function saveInstructions(anchor){
    if (saving) return;
    setSaving(true);
    try {
      await AgentApi.workspace.saveInstructions(hash, instructions);
      setInstructionsDirty(false);
      toast.success('Instructions saved');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Save failed', body: err.message || String(err) });
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
      dialog.alert({ variant: 'error', title: 'Failed to update memory setting', body: err.message || String(err) });
    }
  }

  async function toggleKb(enabled){
    const prev = kbEnabled;
    setKbEnabled(enabled);
    try {
      await AgentApi.workspace.setKbEnabled(hash, enabled);
    } catch (err) {
      setKbEnabled(prev);
      dialog.alert({ variant: 'error', title: 'Failed to update knowledge base setting', body: err.message || String(err) });
    }
  }

  async function toggleWorkspaceContext(enabled){
    const prev = workspaceContextEnabled;
    setWorkspaceContextEnabled(enabled);
    if (!enabled) {
      setWorkspaceContextSelectedFile(null);
      setWorkspaceContextFileContent('');
    }
    try {
      const res = await AgentApi.workspace.setWorkspaceContextEnabled(hash, enabled);
      applyWorkspaceContextResponse(res);
      if (enabled && res && res.initialRunStarted) {
        setWorkspaceContextScanBusy(true);
        toast.success('Workspace Context scan started');
      }
    } catch (err) {
      setWorkspaceContextEnabled(prev);
      dialog.alert({ variant: 'error', title: 'Failed to update Workspace Context setting', body: err.message || String(err) });
    }
  }

  function patchWorkspaceContextSettings(patch){
    setWorkspaceContextSettings(prev => ({ ...(prev || { processorMode: 'global' }), ...patch }));
    setWorkspaceContextSettingsDirty(true);
  }

  async function saveWorkspaceContextSettings(anchor){
    if (saving) return;
    setSaving(true);
    try {
      const res = await AgentApi.workspace.setWorkspaceContextSettings(hash, workspaceContextSettings || { processorMode: 'global' });
      setWorkspaceContextSettings(res.settings || workspaceContextSettings || { processorMode: 'global' });
      setWorkspaceContextSettingsDirty(false);
      toast.success('Workspace Context settings saved');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Save failed', body: err.message || String(err) });
    } finally {
      setSaving(false);
    }
  }

  async function refreshWorkspaceContext(){
    const res = await AgentApi.workspace.getWorkspaceContextSettings(hash);
    applyWorkspaceContextRuntimeResponse(res);
    return res;
  }

  async function runWorkspaceContextScan(anchor){
    if (workspaceContextScanBusy) return;
    setWorkspaceContextScanBusy(true);
    try {
      const res = await AgentApi.workspace.runWorkspaceContextScan(hash);
      await refreshWorkspaceContext();
      toast.success(res && res.started ? 'Workspace Context scan started' : 'Workspace Context scan requested');
    } catch (err) {
      if (err && err.status === 409) {
        await refreshWorkspaceContext().catch(() => {});
        toast.warn('Workspace Context run already running');
        return;
      }
      dialog.alert({ anchor, variant: 'error', title: 'Scan failed', body: err.message || String(err) });
    } finally {
      setWorkspaceContextScanBusy(false);
    }
  }

  async function runWorkspaceContextMaintenance(anchor){
    if (workspaceContextScanBusy) return;
    setWorkspaceContextScanBusy(true);
    try {
      const res = await AgentApi.workspace.runWorkspaceContextMaintenance(hash);
      await refreshWorkspaceContext();
      toast.success(res && res.started ? 'Workspace Context maintenance started' : 'Workspace Context maintenance requested');
    } catch (err) {
      if (err && err.status === 409) {
        await refreshWorkspaceContext().catch(() => {});
        toast.warn('Workspace Context run already running');
        return;
      }
      dialog.alert({ anchor, variant: 'error', title: 'Maintenance failed', body: err.message || String(err) });
    } finally {
      setWorkspaceContextScanBusy(false);
    }
  }

  async function stopWorkspaceContextScan(anchor){
    if (workspaceContextStopBusy) return;
    setWorkspaceContextStopBusy(true);
    try {
      await AgentApi.workspace.stopWorkspaceContextScan(hash);
      await refreshWorkspaceContext();
      toast.success('Workspace Context run stopped');
    } catch (err) {
      dialog.alert({ anchor, variant: 'error', title: 'Stop Workspace Context run failed', body: err.message || String(err) });
    } finally {
      setWorkspaceContextStopBusy(false);
    }
  }

  async function repairWorkspaceContextInstructions(anchor){
    try {
      const res = await AgentApi.workspace.repairWorkspaceContextInstructions(hash);
      await refreshWorkspaceContext();
      if (res && res.ok) toast.success('Workspace Context instructions repaired');
    } catch (err) {
      dialog.alert({ anchor, variant: 'error', title: 'Repair failed', body: err.message || String(err) });
    }
  }

  async function clearWorkspaceContext(anchor){
    const ok = await dialog.confirm({
      anchor,
      title: 'Clear Workspace Context',
      body: 'Clear all Workspace Context markdown and run history for this workspace? The workspace setting will stay unchanged.',
      confirmLabel: 'Clear context',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    setWorkspaceContextScanBusy(true);
    try {
      await AgentApi.workspace.clearWorkspaceContext(hash);
      setWorkspaceContextSelectedFile(null);
      setWorkspaceContextFileContent('');
      await refreshWorkspaceContext();
      toast.success('Workspace Context cleared');
    } catch (err) {
      dialog.alert({ anchor, variant: 'error', title: 'Clear failed', body: err.message || String(err) });
    } finally {
      setWorkspaceContextScanBusy(false);
    }
  }

  async function selectWorkspaceContextFile(relPath){
    if (!relPath) return;
    setWorkspaceContextSelectedFile(relPath);
    setWorkspaceContextFileLoading(true);
    try {
      const res = await AgentApi.workspace.getWorkspaceContextFile(hash, relPath);
      setWorkspaceContextFileContent((res && res.content) || '');
    } catch (err) {
      setWorkspaceContextFileContent('');
      dialog.alert({ variant: 'error', title: 'File preview failed', body: err.message || String(err) });
    } finally {
      setWorkspaceContextFileLoading(false);
    }
  }

  async function deleteMemoryEntry(relPath, anchor){
    const ok = await dialog.confirm({ anchor, title: 'Delete entry', body: 'Delete memory entry "' + relPath + '"?', confirmLabel: 'Delete', cancelLabel: 'Cancel', destructive: true });
    if (!ok) return;
    try {
      await AgentApi.workspace.deleteMemoryEntry(hash, relPath);
      await refreshMemory();
    } catch (err) {
      dialog.alert({ variant: 'error', title: 'Failed to delete entry', body: err.message || String(err) });
    }
  }

  async function clearAllMemory(anchor){
    const ok = await dialog.confirm({ anchor, title: 'Clear memory', body: 'Clear all memory entries for this workspace? This cannot be undone.', confirmLabel: 'Clear all', cancelLabel: 'Cancel', destructive: true });
    if (!ok) return;
    try {
      await AgentApi.workspace.clearMemory(hash);
      await refreshMemory();
    } catch (err) {
      dialog.alert({ variant: 'error', title: 'Failed to clear memory', body: err.message || String(err) });
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
      dialog.alert({ variant: 'error', title: 'Schedule update failed', body: err.message || String(err) });
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
      await dialog.alert({ anchor, variant: 'error', title: 'Memory Review failed', body: err.message || String(err) });
    } finally {
      setReviewStarting(false);
    }
  }

  function auditMemoryReview(){
    const runId = memoryReviewStatus && (memoryReviewStatus.latestRunId || memoryReviewStatus.lastRunId);
    if (onOpenMemoryReview) onOpenMemoryReview(hash, label || 'workspace', runId || null);
  }

  return (
    <div className="settings-shell workspace-settings-shell">
      <div className="settings-top">
        <div className="settings-title-block">
          <div className="settings-title">Workspace Settings</div>
          <div className="settings-subtitle u-dim">{label || 'Workspace'}</div>
        </div>
        <button type="button" className="btn" onClick={onClose} disabled={saving}>Close</button>
      </div>

      <div className="settings-tabs">
        {WS_SETTINGS_TABS.map(t => (
          <div
            key={t.id}
            className={'settings-tab ' + (tab === t.id ? 'active' : '')}
            onClick={() => setTab(t.id)}
          >{t.label}</div>
        ))}
      </div>

      <div className="settings-body workspace-settings-body">
        {loading ? (
          <div className="u-dim" style={{padding:'16px'}}>Loading...</div>
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
        ) : tab === 'workspaceContext' ? (
          <WorkspaceContextTab
            enabled={workspaceContextEnabled}
            settings={workspaceContextSettings}
            state={workspaceContextState}
            files={workspaceContextFiles}
            contextDir={workspaceContextContextDir}
            instructionPath={workspaceContextInstructionPath}
            selectedFile={workspaceContextSelectedFile}
            fileContent={workspaceContextFileContent}
            fileLoading={workspaceContextFileLoading}
            scanBusy={workspaceContextScanBusy}
            scanStopping={workspaceContextStopBusy}
            globalSettings={globalSettings}
            backends={backends}
            profileBackends={profileBackends}
            loadProfileBackend={loadProfileBackend}
            onToggle={toggleWorkspaceContext}
            onPatch={patchWorkspaceContextSettings}
            onSave={saveWorkspaceContextSettings}
            onRefresh={refreshWorkspaceContext}
            onSelectFile={selectWorkspaceContextFile}
            onRunScan={runWorkspaceContextScan}
            onRunMaintenance={runWorkspaceContextMaintenance}
            onStopScan={stopWorkspaceContextScan}
            onRepairInstructions={repairWorkspaceContextInstructions}
            onClear={clearWorkspaceContext}
            settingsDirty={workspaceContextSettingsDirty}
            saving={saving}
            initialSection={initialWorkspaceContextSection}
          />
        ) : null}
      </div>
    </div>
  );
}

export function MemoryUpdateModal({ open, hash, label, update, onClose, onViewAll }){
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
      <div className="fp-panel mu-panel" role="dialog" aria-modal="true" aria-label={`Memory update: ${label || ''}`} onClick={(e) => e.stopPropagation()}>
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
    <div className="settings-form settings-form-wide ws-form">
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
    <div className="settings-form settings-form-wide ws-form">
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
    <div className="settings-form settings-form-wide ws-form">
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

function WorkspaceContextTab({
  enabled,
  settings,
  state,
  files,
  contextDir,
  instructionPath,
  selectedFile,
  fileContent,
  fileLoading,
  scanBusy,
  scanStopping,
  globalSettings,
  backends,
  profileBackends,
  loadProfileBackend,
  onToggle,
  onPatch,
  onSave,
  onRefresh,
  onSelectFile,
  onRunScan,
  onRunMaintenance,
  onStopScan,
  onRepairInstructions,
  onClear,
  settingsDirty,
  saving,
  initialSection,
}){
  const workspaceContextContentRef = React.useRef(null);
  const ctx = settings || { processorMode: 'global' };
  const globalContext = (globalSettings && globalSettings.workspaceContext) || {};
  const profiles = activeWorkspaceCliProfiles(globalSettings);
  const fallbackBackend = globalContext.cliBackend || (globalSettings && globalSettings.defaultBackend) || '';
  const mode = ctx.processorMode === 'override' ? 'override' : 'global';
  const globalProfile = workspaceProfileForSetting(profiles, globalContext.cliProfileId, globalContext.cliBackend, fallbackBackend);
  const selectedProfile = mode === 'override'
    ? workspaceProfileForSetting(profiles, ctx.cliProfileId, ctx.cliBackend, fallbackBackend)
    : globalProfile;
  const [workspaceContextSection, setWorkspaceContextSection] = React.useState(() => normalizeWorkspaceContextSection(initialSection));
  const [fileQuery, setFileQuery] = React.useState('');
  const [runPage, setRunPage] = React.useState(0);

  React.useEffect(() => {
    setWorkspaceContextSection(normalizeWorkspaceContextSection(initialSection));
  }, [initialSection]);

  React.useEffect(() => {
    if (selectedProfile && loadProfileBackend) loadProfileBackend(selectedProfile.id);
  }, [selectedProfile && selectedProfile.id, loadProfileBackend]);

  const models = selectedProfile ? workspaceModelsForProfile(backends, profileBackends, selectedProfile) : [];
  const modelId = (mode === 'override' ? ctx.cliModel : globalContext.cliModel) || workspaceDefaultModelId(models) || '';
  const efforts = selectedProfile ? workspaceEffortLevelsForProfile(backends, profileBackends, selectedProfile, modelId) : [];
  const effort = (mode === 'override' ? ctx.cliEffort : globalContext.cliEffort) || workspaceDefaultEffort(efforts) || '';
  const runs = workspaceContextRunsFromState(state);
  const latestRun = runs[0] || null;
  const latestScanRun = runs.find(isWorkspaceContextScanRun) || null;
  const latestMaintenanceRun = runs.find(isWorkspaceContextMaintenanceRun) || null;
  const runningRun = runs.find(run => run && run.status === 'running') || null;
  const failedRun = runs.find(run => run && run.status === 'failed') || null;
  const visibleFiles = (Array.isArray(files) ? files : []).filter(file => {
    const query = fileQuery.trim().toLowerCase();
    if (!query) return true;
    return String(file.path || file.name || '').toLowerCase().includes(query);
  });
  const globalScanInterval = Number.isFinite(globalContext.scanIntervalMinutes) ? globalContext.scanIntervalMinutes : 5;
  const globalMaintenanceInterval = Number.isFinite(globalContext.maintenanceIntervalHours) ? globalContext.maintenanceIntervalHours : 24;
  const statusText = !enabled ? 'Disabled' : runningRun ? 'Running' : failedRun ? 'Error' : 'Enabled';
  const statusClass = statusText.toLowerCase();
  const globalProcessorProfile = globalProfile ? globalProfile.name : (fallbackBackend || 'Default profile');
  const runPageCount = Math.max(1, Math.ceil(runs.length / WORKSPACE_CONTEXT_RUNS_PAGE_SIZE));
  const safeRunPage = Math.min(runPage, runPageCount - 1);
  const visibleRuns = runs.slice(
    safeRunPage * WORKSPACE_CONTEXT_RUNS_PAGE_SIZE,
    safeRunPage * WORKSPACE_CONTEXT_RUNS_PAGE_SIZE + WORKSPACE_CONTEXT_RUNS_PAGE_SIZE,
  );
  const canShowNewerRuns = safeRunPage > 0;
  const canShowOlderRuns = safeRunPage < runPageCount - 1;

  React.useEffect(() => {
    if (runPage > runPageCount - 1) setRunPage(Math.max(0, runPageCount - 1));
  }, [runPage, runPageCount]);

  React.useEffect(() => {
    if (runningRun) setRunPage(0);
  }, [runningRun && runningRun.runId]);
  const workspaceContextSections = [
    { id: 'overview', label: 'Overview', desc: statusText },
    { id: 'processor', label: 'Processor', desc: settingsDirty ? 'Unsaved changes' : mode === 'override' ? 'Workspace override' : 'Global defaults' },
    { id: 'files', label: 'Markdown Files', desc: enabled ? String(visibleFiles.length) + ' files' : 'Disabled' },
    { id: 'runs', label: 'Runs', desc: runs.length ? String(runs.length) + ' recent' : 'None yet' },
    { id: 'danger', label: 'Danger Zone', desc: 'Clear data' },
  ];

  function onModeChange(nextMode){
    if (nextMode === 'global') {
      onPatch({ processorMode: 'global', cliProfileId: undefined, cliBackend: undefined, cliModel: undefined, cliEffort: undefined, scanIntervalMinutes: undefined, maintenanceIntervalHours: undefined });
      return;
    }
    if (selectedProfile) {
      const m = workspaceModelsForProfile(backends, profileBackends, selectedProfile);
      const newModel = workspaceDefaultModelId(m);
      const e = workspaceEffortLevelsForProfile(backends, profileBackends, selectedProfile, newModel);
      onPatch({ processorMode: 'override', cliProfileId: selectedProfile.id, cliBackend: workspaceBackendIdForProfile(selectedProfile), cliModel: newModel, cliEffort: workspaceDefaultEffort(e) });
    } else {
      onPatch({ processorMode: 'override' });
    }
  }

  function onProfileChange(v){
    const profile = profiles.find(p => p.id === v);
    if (!profile) return;
    const m = workspaceModelsForProfile(backends, profileBackends, profile);
    const newModel = workspaceDefaultModelId(m);
    const e = workspaceEffortLevelsForProfile(backends, profileBackends, profile, newModel);
    onPatch({ processorMode: 'override', cliProfileId: profile.id, cliBackend: workspaceBackendIdForProfile(profile), cliModel: newModel, cliEffort: workspaceDefaultEffort(e) });
  }

  function onModelChange(v){
    const e = selectedProfile ? workspaceEffortLevelsForProfile(backends, profileBackends, selectedProfile, v) : [];
    onPatch({ cliModel: v, cliEffort: workspaceDefaultEffort(e) });
  }

  function onScanInterval(v){
    if (v === '') {
      onPatch({ scanIntervalMinutes: undefined });
      return;
    }
    const n = Number(v);
    if (!Number.isInteger(n)) return;
    onPatch({ scanIntervalMinutes: Math.max(1, Math.min(1440, n)) });
  }

  function onMaintenanceInterval(v){
    if (v === '') {
      onPatch({ maintenanceIntervalHours: undefined });
      return;
    }
    const n = Number(v);
    if (!Number.isInteger(n)) return;
    onPatch({ maintenanceIntervalHours: Math.max(1, Math.min(8760, n)) });
  }

  function selectSection(section){
    setWorkspaceContextSection(section);
    if (workspaceContextContentRef.current && typeof workspaceContextContentRef.current.scrollTo === 'function') {
      workspaceContextContentRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function openWorkspaceContextFileFromRun(relPath){
    if (!relPath) return;
    selectSection('files');
    if (onSelectFile) onSelectFile(relPath);
  }

  return (
    <div className="settings-form settings-form-wide ws-form ws-form-workspace-context">
      <div className="ws-wc-layout">
        <nav className="ws-wc-rail" role="tablist" aria-label="Workspace Context settings sections">
          {workspaceContextSections.map(section => (
            <button
              key={section.id}
              type="button"
              id={'ws-wc-tab-' + section.id}
              className={'ws-wc-nav ' + (workspaceContextSection === section.id ? 'active' : '')}
              role="tab"
              aria-selected={workspaceContextSection === section.id}
              aria-controls={'ws-wc-panel-' + section.id}
              onClick={() => selectSection(section.id)}
            >
              <span>{section.label}</span>
              <small>{section.desc}</small>
            </button>
          ))}
        </nav>

        <div ref={workspaceContextContentRef} className="ws-wc-content">
          {workspaceContextSection === 'overview' ? (
            <section id="ws-wc-panel-overview" className="ws-wc-panel" role="tabpanel" aria-labelledby="ws-wc-tab-overview">
              <div className="ws-wc-title-row">
                <div>
                  <h3 className="ws-wc-title">Workspace Context</h3>
                  <p className="ws-desc u-dim">Markdown-first operating memory maintained by the workspace CLI.</p>
                </div>
                <span className={'ws-wc-status-badge is-' + statusClass}>{statusText}</span>
              </div>
              <label className="toggle ws-toggle">
                <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)}/>
                <span className="tgl"/>
                <span>Enable Workspace Context for this workspace</span>
              </label>
              <div className="ws-wc-readonly-list">
                <div><span>Context folder</span><b>{contextDir || 'Not created yet'}</b></div>
                <div><span>Instruction file</span><b>{instructionPath || 'Not created yet'}</b></div>
                <div><span>Markdown files</span><b>{Array.isArray(files) ? files.length : 0}</b></div>
                <div><span>Last scan</span><b>{latestScanRun ? formatWorkspaceContextRunSource(latestScanRun.source) + ' - ' + formatWorkspaceContextRunStatus(latestScanRun.status) : 'None yet'}</b></div>
                <div><span>Last maintenance</span><b>{latestMaintenanceRun ? formatWorkspaceContextRunStatus(latestMaintenanceRun.status) : 'None yet'}</b></div>
              </div>
              {runningRun ? (
                <div className="ws-wc-initial-scan is-rolling">
                  <span>{formatWorkspaceContextRunSource(runningRun.source)} running</span>
                  <button type="button" className="btn ghost danger ws-wc-stop-scan" disabled={scanStopping} onClick={(e) => onStopScan(e.currentTarget)}>
                    {scanStopping ? 'Stopping...' : 'Stop'}
                  </button>
                </div>
              ) : null}
              <div className="ws-actions ws-wc-danger-actions">
                <button type="button" className="btn ghost" onClick={(e) => onRunScan(e.currentTarget)} disabled={!enabled || scanBusy || !!runningRun}>
                  {Ico.search(12)} {scanBusy || runningRun ? 'Running...' : 'Run scan'}
                </button>
                <button type="button" className="btn ghost" onClick={(e) => onRunMaintenance(e.currentTarget)} disabled={!enabled || scanBusy || !!runningRun}>
                  {Ico.reset(12)} Run maintenance
                </button>
                <button type="button" className="btn ghost" onClick={onRefresh}>{Ico.reset(12)} Refresh</button>
                <button type="button" className="btn ghost" onClick={(e) => onRepairInstructions(e.currentTarget)} disabled={!enabled}>Repair instructions</button>
              </div>
            </section>
          ) : null}

          {workspaceContextSection === 'processor' ? (
            <section id="ws-wc-panel-processor" className="ws-wc-panel" role="tabpanel" aria-labelledby="ws-wc-tab-processor">
              <div className="ws-wc-section-title">Processor</div>
              <div className="seg seg-inline ws-wc-seg">
                <button type="button" aria-pressed={mode === 'global'} onClick={() => onModeChange('global')}>Use global defaults</button>
                <button type="button" aria-pressed={mode === 'override'} onClick={() => onModeChange('override')}>Override</button>
              </div>
              {mode === 'override' ? (
                <>
                  <label className="ws-wc-field">
                    <span>CLI profile</span>
                    <select value={selectedProfile ? selectedProfile.id : ''} onChange={(e) => onProfileChange(e.target.value)}>
                      {profiles.length === 0 ? <option value="">No CLI profiles available</option> : null}
                      {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                  {models.length ? (
                    <label className="ws-wc-field">
                      <span>Model</span>
                      <select value={modelId} onChange={(e) => onModelChange(e.target.value)}>
                        {models.map(m => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
                      </select>
                    </label>
                  ) : null}
                  {efforts.length ? (
                    <div className="ws-wc-field">
                      <span>Effort</span>
                      <div className="seg seg-inline ws-wc-seg">
                        {efforts.map(lv => (
                          <button key={lv} type="button" aria-pressed={effort === lv} onClick={() => onPatch({ cliEffort: lv })}>{lv}</button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <label className="ws-wc-field">
                    <WorkspaceContextLabel help="How often this workspace checks recent conversations and referenced attachments for durable context updates. Leave blank to use the global scan interval.">
                      Scan interval override (minutes)
                    </WorkspaceContextLabel>
                    <input type="number" min={1} max={1440} step={1} placeholder={String(globalScanInterval)} value={ctx.scanIntervalMinutes ?? ''} onChange={(e) => onScanInterval(e.target.value)}/>
                  </label>
                  <label className="ws-wc-field">
                    <WorkspaceContextLabel help="How often this workspace runs maintenance over existing context markdown to merge duplicates, improve organization, and preserve temporal clarity. Leave blank to use the global maintenance interval.">
                      Maintenance interval override (hours)
                    </WorkspaceContextLabel>
                    <input type="number" min={1} max={8760} step={1} placeholder={String(globalMaintenanceInterval)} value={ctx.maintenanceIntervalHours ?? ''} onChange={(e) => onMaintenanceInterval(e.target.value)}/>
                  </label>
                </>
              ) : (
                <div className="ws-wc-readonly-list">
                  <div><span>CLI profile</span><b>{globalProcessorProfile}</b></div>
                  <div><span>Model</span><b>{globalContext.cliModel || modelId || 'Default model'}</b></div>
                  <div><span>Effort</span><b>{globalContext.cliEffort || effort || 'Default effort'}</b></div>
                  <div><span>Scan interval</span><b>{globalScanInterval} minutes</b></div>
                  <div><span>Maintenance interval</span><b>{globalMaintenanceInterval} hours</b></div>
                </div>
              )}
              {settingsDirty ? (
                <div className="ws-wc-save-row">
                  <span className="u-dim">Unsaved Workspace Context settings changes.</span>
                  <button type="button" className="btn primary" disabled={saving} onClick={(e) => onSave(e.currentTarget)}>
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}

          {workspaceContextSection === 'files' ? (
            <section id="ws-wc-panel-files" className="ws-wc-panel" role="tabpanel" aria-labelledby="ws-wc-tab-files">
              <div className="ws-wc-review-head">
                <div>
                  <div className="ws-wc-section-title">Markdown Files</div>
                  <div className="ws-wc-section-summary u-dim">Read-only preview of the Workspace Context markdown folder.</div>
                </div>
                <button type="button" className="btn ghost" onClick={onRefresh}>{Ico.reset(12)} Refresh</button>
              </div>
              {!enabled ? (
                <p className="ws-empty u-dim">Workspace Context is disabled for this workspace.</p>
              ) : !files || files.length === 0 ? (
                <p className="ws-empty u-dim">No Workspace Context markdown files yet.</p>
              ) : (
                <div className="ws-wc-file-browser">
                  <div className="ws-wc-file-list">
                    <input type="search" value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} placeholder="Search files" aria-label="Search Workspace Context files"/>
                    <ul>
                      {visibleFiles.map(file => (
                        <li key={file.path}>
                          <button type="button" className={selectedFile === file.path ? 'active' : ''} onClick={() => onSelectFile(file.path)}>
                            <span>{workspaceContextFileLabel(file)}</span>
                            <small>{file.updatedAt ? formatMemoryUpdateTime(file.updatedAt) : ''}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="ws-wc-file-preview">
                    {fileLoading ? (
                      <div className="u-dim">Loading...</div>
                    ) : selectedFile ? (
                      <>
                        <div className="ws-wc-file-preview-head">
                          <span>{selectedFile}</span>
                          <small>Read-only</small>
                        </div>
                        <pre>{fileContent || ''}</pre>
                      </>
                    ) : (
                      <p className="ws-empty u-dim">Select a markdown file to preview it.</p>
                    )}
                  </div>
                </div>
              )}
            </section>
          ) : null}

          {workspaceContextSection === 'runs' ? (
            <section id="ws-wc-panel-runs" className="ws-wc-panel" role="tabpanel" aria-labelledby="ws-wc-tab-runs">
              <div className="ws-wc-review-head">
                <div>
                  <div className="ws-wc-section-title">Runs</div>
                  <div className="ws-wc-section-summary u-dim">Latest run logs first.</div>
                </div>
                {runs.length > WORKSPACE_CONTEXT_RUNS_PAGE_SIZE ? (
                  <div className="ws-wc-run-pager" aria-label="Workspace Context run log pages">
                    <button type="button" className="btn ghost" disabled={!canShowNewerRuns} onClick={() => setRunPage(page => Math.max(0, page - 1))}>
                      <span className="ws-wc-pager-icon is-left">{Ico.chev(12)}</span> Newer
                    </button>
                    <button type="button" className="btn ghost" disabled={!canShowOlderRuns} onClick={() => setRunPage(page => Math.min(runPageCount - 1, page + 1))}>
                      Older {Ico.chev(12)}
                    </button>
                  </div>
                ) : null}
              </div>
              {runs.length ? (
                <div className="ws-wc-runs">
                  {visibleRuns.map(run => (
                    <div key={run.runId} className="ws-wc-run-card">
                      <div className="ws-wc-run-card-head">
                        <b>{formatWorkspaceContextRunSource(run.source)}</b>
                        <span>{formatWorkspaceContextRunStatus(run.status)}</span>
                      </div>
                      <div className="ws-wc-run-card-meta">
                        <span>{run.startedAt ? formatMemoryUpdateTime(run.startedAt) : ''}</span>
                        <span>{run.filesConsidered || 0} file{run.filesConsidered === 1 ? '' : 's'}</span>
                      </div>
                      {run.summary ? (
                        <WorkspaceContextRunSummary
                          summary={run.summary}
                          files={files}
                          contextDir={contextDir}
                          onOpenFile={openWorkspaceContextFileFromRun}
                        />
                      ) : null}
                      {run.errorMessage ? <p className="u-err">{run.errorMessage}</p> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="ws-empty u-dim">No Workspace Context runs yet.</p>
              )}
            </section>
          ) : null}

          {workspaceContextSection === 'danger' ? (
            <section id="ws-wc-panel-danger" className="ws-wc-panel" role="tabpanel" aria-labelledby="ws-wc-tab-danger">
              <div className="ws-wc-section-title">Danger Zone</div>
              <div className="ws-wc-danger-block">
                <div className="ws-wc-danger-title">Clear Workspace Context</div>
                <p className="ws-empty u-dim">Clear the markdown context folder and run history. Workspace enablement and processor settings stay in place.</p>
                <div className="ws-actions ws-wc-danger-actions">
                  <button className="btn ghost danger" disabled={scanBusy || !!runningRun} onClick={(e) => onClear(e.currentTarget)}>{Ico.trash(12)} Clear Workspace Context</button>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
