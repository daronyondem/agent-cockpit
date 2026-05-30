import React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Ico } from './icons.jsx';
import { AgentApi } from './api.js';
import { StreamStore } from './streamStore.js';
import { Tip } from './tooltip.jsx';
import { useDialog } from './dialog.jsx';
import { useToasts } from './toast.jsx';
import { FolderPicker } from './folderPicker.jsx';

/* ---------- WorkspaceSettingsPage — per-workspace settings screen. ---------- */
/* Opens from the gear button in the sidebar workspace action buttons.
   Five tabs:
     - Instructions: free-form system-prompt prefix (Save button).
     - Memory: enable toggle (immediate-save) + searchable, lifecycle-filtered
       grouped browser with per-file delete and a "Clear all" footer. Refetches
       snapshot after each mutation.
     - Knowledge Base: enable toggle (immediate-save). Full KB management lives
       in the dedicated KB Browser screen.
     - Workspace Context: enable toggle (immediate-save), workspace processor overrides,
       markdown file preview, workspace processor overrides, and scan/maintenance runs.
     - Worktrees: enable toggle for per-conversation Git worktree isolation.
   Reuses the same full-screen `settings-shell` structure as global Settings. */

const WS_SETTINGS_TABS = [
  { id: 'location', label: 'Location' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'memory',       label: 'Memory' },
  { id: 'kb',           label: 'Knowledge Base' },
  { id: 'workspaceContext',   label: 'Workspace Context' },
  { id: 'worktrees',    label: 'Worktrees' },
  { id: 'archive',      label: 'Archive' },
];

const WORKSPACE_CONTEXT_SECTIONS = ['overview', 'processor', 'files', 'runs', 'danger'];
const WORKSPACE_CONTEXT_RUNS_PAGE_SIZE = 5;
const ARCHIVE_MODE_LABELS = {
  history_only: 'Workspace Metadata and Conversations',
  file_snapshot: 'Full Backup with Workspace Folder',
};

function archiveModeLabel(mode){
  return ARCHIVE_MODE_LABELS[mode] || ARCHIVE_MODE_LABELS.history_only;
}

function originalCleanupHint(mode){
  if (mode === 'delete_permanently') {
    return 'After the backup is verified, delete the original workspace folder. This requires the exact DELETE ORIGINAL confirmation.';
  }
  return 'Leave the original workspace folder exactly where it is.';
}

function normalizeArchiveCleanupOriginal(mode){
  return mode === 'delete_permanently' ? 'delete_permanently' : 'keep';
}

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

function cliHarnessForBackend(backendId){
  return backendId === 'claude-code-interactive' ? 'claude-code' : backendId;
}

function workspaceBackendIdForProfile(profile){
  if (!profile) return null;
  if (profile.harness === 'claude-code' && profile.protocol === 'interactive') return 'claude-code-interactive';
  return profile.harness;
}

function workspaceProfileForBackend(profiles, backendId){
  if (!backendId) return null;
  const harness = cliHarnessForBackend(backendId);
  return profiles.find(p => workspaceBackendIdForProfile(p) === backendId)
    || profiles.find(p => p.id === 'server-configured-' + harness)
    || profiles.find(p => p.harness === harness)
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


export function WorkspaceSettingsPage({ hash, label, initialTab, initialWorkspaceContextSection, onClose }){
  const [tab, setTab] = React.useState(() => WS_SETTINGS_TABS.some(t => t.id === initialTab) ? initialTab : 'instructions');
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  const [instructions, setInstructions] = React.useState('');
  const [instructionsDirty, setInstructionsDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [workspaceLocation, setWorkspaceLocation] = React.useState(null);
  const [workspaceLocationDraft, setWorkspaceLocationDraft] = React.useState('');
  const [workspaceLocationDirty, setWorkspaceLocationDirty] = React.useState(false);
  const [workspaceLocationPickerOpen, setWorkspaceLocationPickerOpen] = React.useState(false);
  const [archiveStatus, setArchiveStatus] = React.useState(null);
  const [archiveBusy, setArchiveBusy] = React.useState(false);
  const [archiveEstimate, setArchiveEstimate] = React.useState(null);
  const [archiveForm, setArchiveForm] = React.useState({
    mode: 'history_only',
    note: '',
    inclusionPolicy: 'exclude_common',
    cleanupOriginal: 'keep',
    confirmDeleteOriginal: '',
  });
  const [memoryEnabled, setMemoryEnabled] = React.useState(false);
  const [memorySnapshot, setMemorySnapshot] = React.useState(null);
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
  const [worktreeStatus, setWorktreeStatus] = React.useState(null);
  const [worktreeBusy, setWorktreeBusy] = React.useState(false);
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
    setWorkspaceLocationDirty(false);
    Promise.all([
      AgentApi.workspace.getLocation(hash).catch(() => null),
      AgentApi.workspace.getArchive(hash).catch(() => null),
      AgentApi.workspace.getInstructions(hash).catch(() => ({})),
      AgentApi.workspace.getMemory(hash).catch(() => ({})),
      AgentApi.workspace.getKb(hash).catch(() => ({})),
      AgentApi.workspace.getWorkspaceContextSettings(hash).catch(() => ({})),
      AgentApi.workspace.getWorktreeIsolation(hash).catch((err) => ({ available: false, enabled: false, blockers: [{ code: 'load_failed', message: err.message || String(err) }] })),
      AgentApi.settings.get().catch(() => ({})),
      AgentApi.settings.backends().catch(() => ({ backends: [] })),
    ]).then(([locationRes, archiveRes, instrRes, memRes, kbRes, workspaceContextRes, worktreeRes, settingsRes, backendsRes]) => {
      if (cancelled) return;
      setWorkspaceLocation(locationRes || null);
      setWorkspaceLocationDraft((locationRes && locationRes.workspacePath) || '');
      setArchiveStatus((archiveRes && archiveRes.workspace) || null);
      setArchiveEstimate(null);
      setArchiveBusy(false);
      setInstructions(instrRes.instructions || '');
      setMemoryEnabled(!!memRes.enabled);
      setMemorySnapshot(memRes.snapshot || null);
      setKbEnabled(!!kbRes.enabled);
      applyWorkspaceContextResponse(workspaceContextRes);
      setWorktreeStatus(worktreeRes || null);
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

  async function saveWorkspaceLocation(anchor){
    if (saving || !workspaceLocationDirty) return;
    const nextPath = workspaceLocationDraft.trim();
    if (!nextPath) {
      await dialog.alert({ anchor, variant: 'error', title: 'Path required', body: 'Workspace path is required.' });
      return;
    }
    const ok = await dialog.confirm({
      anchor,
      title: 'Change Workspace Location',
      body: 'Update this workspace to use the selected folder for future chats and workspace tools?',
      confirmLabel: 'Update location',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    setSaving(true);
    try {
      const res = await AgentApi.workspace.updateLocation(hash, nextPath);
      setWorkspaceLocation(res || null);
      setWorkspaceLocationDraft((res && res.workspacePath) || nextPath);
      setWorkspaceLocationDirty(false);
      await StreamStore.refreshConvList().catch(() => {});
      toast.success('Workspace location updated');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Location update failed', body: err.message || String(err) });
    } finally {
      setSaving(false);
    }
  }

  async function refreshArchiveStatus(){
    const res = await AgentApi.workspace.getArchive(hash);
    setArchiveStatus((res && res.workspace) || null);
    return res && res.workspace;
  }

  function patchArchiveForm(patch){
    setArchiveForm(prev => ({ ...prev, ...patch }));
    if (patch.inclusionPolicy || patch.mode) setArchiveEstimate(null);
  }

  async function estimateWorkspaceSnapshot(anchor){
    setArchiveBusy(true);
    try {
      const res = await AgentApi.workspace.estimateSnapshot(hash, { inclusionPolicy: archiveForm.inclusionPolicy });
      setArchiveEstimate((res && res.estimate) || null);
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Backup estimate failed', body: err.message || String(err) });
    } finally {
      setArchiveBusy(false);
    }
  }

  async function archiveWorkspace(anchor){
    const snapshotMode = archiveForm.mode === 'file_snapshot';
    const cleanupOriginal = snapshotMode ? normalizeArchiveCleanupOriginal(archiveForm.cleanupOriginal) : 'keep';
    const destructive = cleanupOriginal === 'delete_permanently';
    const ok = await dialog.confirm({
      anchor,
      title: snapshotMode ? 'Archive With Full Backup' : 'Archive Workspace',
      body: snapshotMode
        ? (destructive
          ? 'Create a verified backup of the workspace folder, archive the workspace, and delete the original folder after backup verification?'
          : 'Create a verified backup of the workspace folder and archive the workspace while keeping the original folder in place?')
        : 'Archive this workspace and pause background workspace processing?',
      confirmLabel: 'Archive',
      cancelLabel: 'Cancel',
      destructive,
    });
    if (!ok) return;
    setArchiveBusy(true);
    try {
      const body = {
        mode: archiveForm.mode,
        note: archiveForm.note,
        ...(snapshotMode ? {
          snapshot: {
            inclusionPolicy: archiveForm.inclusionPolicy,
            cleanupOriginal,
            ...(archiveForm.confirmDeleteOriginal ? { confirmDeleteOriginal: archiveForm.confirmDeleteOriginal } : {}),
          },
        } : {}),
      };
      const res = await AgentApi.workspace.archive(hash, body);
      setArchiveStatus((res && res.workspace) || null);
      await StreamStore.refreshConvList().catch(() => {});
      toast.success('Workspace archived');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Archive failed', body: err.message || String(err) });
    } finally {
      setArchiveBusy(false);
    }
  }

  async function restoreWorkspace(anchor){
    const ok = await dialog.confirm({
      anchor,
      title: 'Restore Workspace',
      body: 'Restore this workspace to the active workspace list?',
      confirmLabel: 'Restore',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    setArchiveBusy(true);
    try {
      const res = await AgentApi.workspace.restore(hash, {});
      setArchiveStatus((res && res.workspace) || null);
      await StreamStore.refreshConvList().catch(() => {});
      toast.success('Workspace restored');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Restore failed', body: err.message || String(err) });
    } finally {
      setArchiveBusy(false);
    }
  }

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

  async function refreshWorktreeIsolation(anchor){
    setWorktreeBusy(true);
    try {
      const res = await AgentApi.workspace.getWorktreeIsolation(hash);
      setWorktreeStatus(res || null);
      return res;
    } catch (err) {
      if (anchor) {
        await dialog.alert({
          anchor,
          variant: 'error',
          title: 'Refresh Worktrees failed',
          body: err.message || String(err),
        });
      }
      throw err;
    } finally {
      setWorktreeBusy(false);
    }
  }

  async function toggleWorktreeIsolation(enabled, anchor){
    const ok = await dialog.confirm({
      anchor,
      title: enabled ? 'Enable Worktrees' : 'Disable Worktrees',
      body: enabled
        ? 'Enable one Git worktree per conversation? This resets every CLI session in this workspace and creates a branch for each conversation.'
        : 'Disable worktree isolation? This removes clean conversation worktrees, returns conversations to the shared workspace folder, and resets every CLI session.',
      confirmLabel: enabled ? 'Enable' : 'Disable',
      cancelLabel: 'Cancel',
      destructive: !enabled,
    });
    if (!ok) return;
    setWorktreeBusy(true);
    try {
      const res = await AgentApi.workspace.setWorktreeIsolation(hash, enabled);
      setWorktreeStatus(res || null);
      const affectedConversationIds = Array.isArray(res && res.conversations)
        ? res.conversations.map((conversation) => conversation.id).filter(Boolean)
        : [];
      StreamStore.refreshConvList().catch(() => {});
      await StreamStore.refreshLoadedConversations(affectedConversationIds).catch(() => {});
      toast.success(enabled ? 'Worktrees enabled' : 'Worktrees disabled');
    } catch (err) {
      const blockers = err && err.body && Array.isArray(err.body.blockers) ? err.body.blockers : [];
      const detail = blockers.length
        ? blockers.map(formatWorktreeBlocker).join('\n')
        : (err.message || String(err));
      await dialog.alert({
        anchor,
        variant: 'error',
        title: enabled ? 'Enable Worktrees failed' : 'Disable Worktrees failed',
        body: detail,
      });
      await refreshWorktreeIsolation().catch(() => {});
    } finally {
      setWorktreeBusy(false);
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
        ) : tab === 'location' ? (
          <LocationTab
            location={workspaceLocation}
            draft={workspaceLocationDraft}
            dirty={workspaceLocationDirty}
            saving={saving}
            onDraftChange={(value) => {
              setWorkspaceLocationDraft(value);
              setWorkspaceLocationDirty(value.trim() !== ((workspaceLocation && workspaceLocation.workspacePath) || ''));
            }}
            onBrowse={() => setWorkspaceLocationPickerOpen(true)}
            onSave={saveWorkspaceLocation}
          />
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
        ) : tab === 'worktrees' ? (
          <WorktreeIsolationTab
            status={worktreeStatus}
            busy={worktreeBusy}
            onToggle={toggleWorktreeIsolation}
            onRefresh={refreshWorktreeIsolation}
          />
        ) : tab === 'archive' ? (
          <ArchiveTab
            status={archiveStatus}
            form={archiveForm}
            estimate={archiveEstimate}
            busy={archiveBusy}
            onPatch={patchArchiveForm}
            onEstimate={estimateWorkspaceSnapshot}
            onArchive={archiveWorkspace}
            onRestore={restoreWorkspace}
            onRefresh={refreshArchiveStatus}
          />
        ) : null}
      </div>
      <FolderPicker
        open={workspaceLocationPickerOpen}
        initialPath={workspaceLocationDraft || (workspaceLocation && workspaceLocation.workspacePath) || ''}
        busy={saving}
        onClose={() => setWorkspaceLocationPickerOpen(false)}
        onSelect={(nextPath) => {
          setWorkspaceLocationDraft(nextPath || '');
          setWorkspaceLocationDirty(String(nextPath || '').trim() !== ((workspaceLocation && workspaceLocation.workspacePath) || ''));
          setWorkspaceLocationPickerOpen(false);
        }}
      />
    </div>
  );
}

function ArchiveTab({ status, form, estimate, busy, onPatch, onEstimate, onArchive, onRestore, onRefresh }){
  const archived = !!(status && status.archived);
  const archive = (status && status.archive) || {};
  const snapshot = archive.snapshot || null;
  const cleanup = archive.originalCleanup || null;
  return (
    <div className="settings-form settings-form-wide ws-form ws-archive-form">
      <section className="ws-archive-panel">
        <div className="settings-card-head">
          <div>
            <h3>{archived ? 'Archived' : 'Active'}</h3>
            <p className="u-dim">{(status && status.workspacePath) || ''}</p>
          </div>
          <span className={'ws-archive-pill ' + (status && status.pathAvailable ? 'ok' : 'warn')}>
            {status && status.pathAvailable ? 'Folder available' : 'Folder missing'}
          </span>
        </div>
        <div className="ws-archive-grid">
          <ArchiveMetric label="Conversations" value={(status && status.conversationCount) || 0}/>
          <ArchiveMetric label="Memory" value={status && status.memoryEnabled ? 'On' : 'Off'}/>
          <ArchiveMetric label="KB" value={status && status.kbEnabled ? 'On' : 'Off'}/>
          <ArchiveMetric label="Context" value={status && status.workspaceContextEnabled ? 'On' : 'Off'}/>
        </div>
        {archived ? (
          <div className="archived-workspace-snapshot">
            <span>{archiveModeLabel(archive.mode)}</span>
            <span>{archive.archivedAt ? formatMemoryUpdateTime(archive.archivedAt) : ''}</span>
            {snapshot ? <span>{formatArchiveBytes(snapshot.sizeBytes || 0)}</span> : null}
            {cleanup ? <span>{cleanup.error ? `Cleanup failed: ${cleanup.error}` : `Cleanup: ${cleanup.mode}`}</span> : null}
          </div>
        ) : null}
        <div className="settings-actions-row">
          {archived ? (
            <button type="button" className="btn primary" onClick={(e) => onRestore(e.currentTarget)} disabled={busy || !(status && status.pathAvailable)}>
              {Ico.reset(14)} Restore
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={(e) => onArchive(e.currentTarget)} disabled={busy}>
              {Ico.archive(14)} Archive
            </button>
          )}
          <button type="button" className="btn" onClick={onRefresh} disabled={busy}>{Ico.reset(14)} Refresh</button>
        </div>
      </section>

      {!archived ? (
        <section className="ws-archive-panel">
          <div className="settings-field">
            <span className="settings-field-label">Archive type</span>
            <div className="ws-archive-choice-grid" role="radiogroup" aria-label="Archive type">
              <button
                type="button"
                className="ws-archive-choice"
                aria-pressed={form.mode === 'history_only'}
                onClick={() => onPatch({ mode: 'history_only' })}
                disabled={busy}
              >
                <span>{ARCHIVE_MODE_LABELS.history_only}</span>
                <small>Keep Agent Cockpit metadata, conversations, Memory, Knowledge Base, and Workspace Context. We leave the workspace folder in your file system as it is.</small>
              </button>
              <button
                type="button"
                className="ws-archive-choice"
                aria-pressed={form.mode === 'file_snapshot'}
                onClick={() => onPatch({ mode: 'file_snapshot' })}
                disabled={busy}
              >
                <span>{ARCHIVE_MODE_LABELS.file_snapshot}</span>
                <small>In addition to Workspace Metadata and Conversations, we add a verified backup of the current workspace folder into your archive.</small>
              </button>
            </div>
          </div>

          <label className="settings-field">
            <span className="settings-field-label">Archive note</span>
            <textarea rows={3} value={form.note} onChange={(e) => onPatch({ note: e.currentTarget.value })}/>
          </label>

          {form.mode === 'file_snapshot' ? (
            <>
              <div className="ws-archive-options">
                <label className="settings-field">
                  <span className="settings-field-label">Backup contents</span>
                  <select value={form.inclusionPolicy} onChange={(e) => onPatch({ inclusionPolicy: e.currentTarget.value })}>
                    <option value="exclude_common">Exclude common build folders</option>
                    <option value="include_all">Include everything</option>
                  </select>
                </label>
                <label className="settings-field">
                  <span className="settings-field-label">Original folder</span>
                  <select value={normalizeArchiveCleanupOriginal(form.cleanupOriginal)} onChange={(e) => onPatch({ cleanupOriginal: e.currentTarget.value })}>
                    <option value="keep">Keep original folder</option>
                    <option value="delete_permanently">Delete original folder</option>
                  </select>
                  <span className="settings-field-hint u-dim">{originalCleanupHint(normalizeArchiveCleanupOriginal(form.cleanupOriginal))}</span>
                </label>
              </div>
              {normalizeArchiveCleanupOriginal(form.cleanupOriginal) === 'delete_permanently' ? (
                <label className="settings-field">
                  <span className="settings-field-label">Delete confirmation</span>
                  <input value={form.confirmDeleteOriginal} onChange={(e) => onPatch({ confirmDeleteOriginal: e.currentTarget.value })}/>
                </label>
              ) : null}
              <div className="settings-actions-row">
                <button type="button" className="btn" onClick={(e) => onEstimate(e.currentTarget)} disabled={busy}>
                  {Ico.search(14)} Estimate backup
                </button>
              </div>
              {estimate ? (
                <div className="ws-archive-estimate">
                  <span>{estimate.fileCount} files</span>
                  <span>{estimate.directoryCount} folders</span>
                  <span>{estimate.symlinkCount} links</span>
                  <span>{estimate.excludedCount} excluded</span>
                  <span>{formatArchiveBytes(estimate.sizeBytes || 0)}</span>
                </div>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ArchiveMetric({ label, value }){
  return (
    <div className="archived-workspace-metric">
      <span className="u-dim">{label}</span>
      <b>{value}</b>
    </div>
  );
}

function formatArchiveBytes(bytes){
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
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

/* ---------- Tabs ---------- */

function LocationTab({ location, draft, dirty, saving, onDraftChange, onBrowse, onSave }){
  const previousPaths = Array.isArray(location && location.previousPaths) ? location.previousPaths : [];
  return (
    <div className="settings-form settings-form-wide ws-form">
      <div className="settings-field">
        <label className="settings-field-label-row">
          <span>Workspace folder</span>
        </label>
        <div className="settings-inline-row">
          <input
            type="text"
            className="settings-text-input u-mono"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder="/path/to/workspace"
            spellCheck={false}
          />
          <button type="button" className="btn ghost" onClick={onBrowse} disabled={saving}>Browse</button>
        </div>
      </div>
      {location && location.workspaceId ? (
        <div className="ws-muted-metadata">
          <div><span className="u-dim">Workspace ID</span> <span className="u-mono">{location.workspaceId}</span></div>
          {previousPaths.length ? (
            <div><span className="u-dim">Previous</span> <span className="u-mono">{previousPaths[previousPaths.length - 1]}</span></div>
          ) : null}
        </div>
      ) : null}
      <div className="ws-actions">
        <button
          type="button"
          className="btn"
          disabled={saving || !dirty}
          onClick={(e) => onSave(e.currentTarget)}
        >{saving ? 'Updating...' : 'Update location'}</button>
      </div>
    </div>
  );
}

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

function MemoryTab({ hash, enabled, snapshot, onToggle, onDelete, onClearAll, onRefresh }){
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

function formatWorktreeBlocker(blocker){
  if (!blocker) return '';
  const prefix = blocker.conversationId ? `${blocker.conversationId}: ` : '';
  const files = Array.isArray(blocker.files) && blocker.files.length
    ? ` (${blocker.files.slice(0, 4).join(', ')}${blocker.files.length > 4 ? ', ...' : ''})`
    : '';
  return `${prefix}${blocker.message || blocker.code || 'Worktree blocker'}${files}`;
}

function WorktreeIsolationTab({ status, busy, onToggle, onRefresh }){
  const enabled = !!(status && status.enabled);
  const available = !!(status && status.available);
  const blockers = Array.isArray(status && status.blockers) ? status.blockers : [];
  const conversations = Array.isArray(status && status.conversations) ? status.conversations : [];
  const affectedGrid = 'minmax(180px, 1fr) minmax(130px, auto) minmax(80px, auto) minmax(80px, auto)';
  return (
    <div className="settings-form settings-form-wide ws-form">
      <p className="ws-desc u-dim">
        Run each conversation in its own Git worktree and session branch. The workspace path stays the same in the sidebar; CLI execution moves to that conversation's worktree.
      </p>
      <label className="toggle ws-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || (!available && !enabled)}
          onChange={(e) => onToggle(e.target.checked, e.currentTarget)}
        />
        <span className="tgl"/>
        <span>Use one worktree per conversation</span>
      </label>
      <div className="ws-actions">
        <button type="button" className="btn ghost" onClick={(e) => onRefresh(e.currentTarget).catch(() => {})} disabled={busy}>Refresh</button>
      </div>
      {status ? (
        <div className="ws-empty">
          <div><b>Status:</b> {enabled ? 'Enabled' : available ? 'Available' : 'Unavailable'}</div>
          {status.repoRoot ? <div><b>Repo:</b> <span className="u-mono">{status.repoRoot}</span></div> : null}
          {status.remoteBaseRef ? <div><b>Base:</b> <span className="u-mono">{status.remoteBaseRef}</span></div> : null}
          {status.worktreeBaseDir ? <div><b>Worktrees:</b> <span className="u-mono">{status.worktreeBaseDir}</span></div> : null}
        </div>
      ) : (
        <p className="ws-empty u-dim">Worktree status has not loaded.</p>
      )}
      {blockers.length ? (
        <div className="ws-empty u-err">
          {blockers.map((blocker, index) => (
            <div key={(blocker.code || 'blocker') + ':' + index}>{formatWorktreeBlocker(blocker)}</div>
          ))}
        </div>
      ) : null}
      {conversations.length ? (
        <div className="ws-empty">
          <div className="u-dim" style={{ marginBottom: 8 }}>Conversations affected</div>
          <div className="u-dim" style={{ display: 'grid', gridTemplateColumns: affectedGrid, gap: 8, padding: '0 0 6px 0' }}>
            <div>Conversation</div>
            <div>Uses</div>
            <div>Status</div>
            <div/>
          </div>
          {conversations.map((conversation) => (
            <div key={conversation.id} style={{ display: 'grid', gridTemplateColumns: affectedGrid, gap: 8, padding: '6px 0', borderTop: '1px solid var(--border)', opacity: conversation.archived ? 0.72 : 1 }}>
              <div>
                <div>{conversation.title || 'New Chat'}</div>
                {conversation.executionDir ? <div className="u-mono u-dim">{conversation.executionDir}</div> : null}
              </div>
              <div className="u-dim">{conversation.mode === 'worktree' ? 'Worktree' : 'Workspace Folder'}</div>
              <div className={conversation.dirty || conversation.missing ? 'u-err' : 'u-dim'}>
                {conversation.missing ? 'Missing' : conversation.dirty ? 'Dirty' : ''}
              </div>
              <div className="u-dim">{conversation.archived ? 'Archived' : ''}</div>
            </div>
          ))}
        </div>
      ) : null}
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
