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
  { id: 'routines',     label: 'Routines' },
  { id: 'worktrees',    label: 'Worktrees' },
  { id: 'archive',      label: 'Archive' },
];

const WORKSPACE_CONTEXT_SECTIONS = ['overview', 'processor', 'context', 'references', 'assets', 'runs', 'danger'];
const WORKSPACE_CONTEXT_RUNS_PAGE_SIZE = 5;
const ARCHIVE_MODE_LABELS = {
  history_only: 'Workspace Metadata and Conversations',
  file_snapshot: 'Full Backup with Workspace Folder',
};

function modelDisplayLabel(modelOrId){
  const raw = typeof modelOrId === 'string'
    ? modelOrId
    : String((modelOrId && (modelOrId.label || modelOrId.id)) || '');
  return raw.startsWith('openrouter/') ? raw.slice('openrouter/'.length) : raw;
}

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

function routineRunTimestamp(run){
  const timestamp = Date.parse((run && run.startedAt) || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function routineItemIsRunning(item){
  return !!(item && (item.running || (item.lastRun && item.lastRun.status === 'running')));
}

function browserTimezone(){
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function routineTimezoneOptions(value){
  const current = (value || '').trim();
  let zones = [];
  try {
    if (Intl.supportedValuesOf) zones = Intl.supportedValuesOf('timeZone');
  } catch {}
  if (!zones.length) {
    zones = [
      'UTC',
      'America/Los_Angeles',
      'America/Denver',
      'America/Chicago',
      'America/New_York',
      'America/Toronto',
      'America/Mexico_City',
      'America/Sao_Paulo',
      'Europe/London',
      'Europe/Paris',
      'Europe/Berlin',
      'Europe/Istanbul',
      'Asia/Dubai',
      'Asia/Kolkata',
      'Asia/Singapore',
      'Asia/Tokyo',
      'Australia/Sydney',
    ];
  }
  const deduped = Array.from(new Set(zones));
  if (!deduped.includes('UTC')) deduped.unshift('UTC');
  if (current && !deduped.includes(current)) deduped.unshift(current);
  return deduped;
}

function routineDraftFromDetail(detail){
  const manifest = (detail && detail.manifest) || {};
  const trigger = manifest.trigger || { type: 'manual' };
  const harness = manifest.harness || {};
  const notification = manifest.notification || { mode: 'workspaceDefault' };
  return {
    title: manifest.title || '',
    triggerType: trigger.type === 'schedule' ? 'schedule' : 'manual',
    intervalMinutes: trigger.type === 'schedule' ? String(trigger.intervalMinutes || 60) : '60',
    timezone: trigger.type === 'schedule' ? (trigger.timezone || '') : '',
    weekdaysOnly: trigger.type === 'schedule' ? !!trigger.weekdaysOnly : false,
    windowStart: trigger.type === 'schedule' ? (trigger.windowStart || '') : '',
    windowEnd: trigger.type === 'schedule' ? (trigger.windowEnd || '') : '',
    cliProfileId: harness.cliProfileId || '',
    model: harness.model || '',
    effort: harness.effort || '',
    notificationMode: notification.mode || 'workspaceDefault',
    routineContent: (detail && detail.routineContent) || '',
  };
}

function routineManifestPatchFromDraft(draft){
  const trigger = draft.triggerType === 'schedule'
    ? {
        type: 'schedule',
        intervalMinutes: Math.max(1, Math.min(1440, parseInt(draft.intervalMinutes || '60', 10) || 60)),
        ...(draft.timezone.trim() ? { timezone: draft.timezone.trim() } : {}),
        ...(draft.weekdaysOnly ? { weekdaysOnly: true } : {}),
        ...(draft.windowStart.trim() || draft.windowEnd.trim() ? {
          windowStart: draft.windowStart.trim(),
          windowEnd: draft.windowEnd.trim(),
        } : {}),
      }
    : { type: 'manual' };
  const harness = {
    ...(draft.cliProfileId.trim() ? { cliProfileId: draft.cliProfileId.trim() } : {}),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.effort.trim() ? { effort: draft.effort.trim() } : {}),
  };
  return {
    title: draft.title.trim(),
    trigger,
    ...(Object.keys(harness).length ? { harness } : { harness: {} }),
    notification: { mode: draft.notificationMode === 'off' ? 'off' : 'workspaceDefault' },
  };
}

function routineSettingsDraftFromResponse(response){
  const telegram = response && response.notification && response.notification.telegram;
  return {
    telegramEnabled: !!(telegram && telegram.enabled),
    telegramBotConfigured: !!(telegram && telegram.botConfigured),
    telegramDestinationConfigured: !!(telegram && telegram.destinationConfigured),
    telegramChatId: (telegram && telegram.chatId) || '',
    telegramChatTitle: (telegram && telegram.chatTitle) || '',
    telegramChatType: (telegram && telegram.chatType) || '',
  };
}

function renderWorkspaceContextRunMarkdown(markdown){
  const raw = marked.parse(String(markdown || ''), { breaks: true, gfm: true });
  return DOMPurify.sanitize(raw);
}

function stripWorkspaceContextLineSuffix(value){
  return String(value || '')
    .replace(/(\.(?:md|markdown|txt|json|csv|tsv|ya?ml)):\d+(?::\d+)?$/i, '$1');
}

function matchWorkspaceContextMaterial(raw, available, dir, section){
  const list = Array.isArray(available) ? available : [];
  const normalizedDir = String(dir || '').replace(/\/+$/, '');
  const candidates = new Set([raw.replace(/^\.?\//, '')]);
  if (normalizedDir && raw.startsWith(normalizedDir + '/')) {
    candidates.add(raw.slice(normalizedDir.length + 1));
  }
  const sectionPrefix = section === 'context' ? 'context/' : section + '/';
  if (raw.startsWith(sectionPrefix)) {
    candidates.add(raw.slice(sectionPrefix.length));
  }

  for (const candidate of candidates) {
    const match = list.find(file => file && file.path === candidate);
    if (match) return { section, path: match.path };
  }

  const basename = raw.split('/').pop();
  const basenameMatches = basename
    ? list.filter(file => file && (file.path === basename || file.name === basename || String(file.path || '').endsWith('/' + basename)))
    : [];
  return basenameMatches.length === 1 ? { section, path: basenameMatches[0].path } : null;
}

function resolveWorkspaceContextRunFileLink(href, materials, dirs){
  let raw = String(href || '').trim();
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {}
  raw = raw.split('#')[0].split('?')[0].trim();
  raw = stripWorkspaceContextLineSuffix(raw);

  return matchWorkspaceContextMaterial(raw, materials && materials.files, dirs && dirs.contextDir, 'context')
    || matchWorkspaceContextMaterial(raw, materials && materials.references, dirs && dirs.referencesDir, 'references')
    || matchWorkspaceContextMaterial(raw, materials && materials.assets, dirs && dirs.assetsDir, 'assets');
}

function WorkspaceContextRunSummary({ summary, files, references, assets, contextDir, referencesDir, assetsDir, onOpenMaterial }){
  const html = React.useMemo(() => renderWorkspaceContextRunMarkdown(summary), [summary]);
  const onClick = React.useCallback((event) => {
    if (!onOpenMaterial) return;
    const target = event.target;
    const link = target && typeof target.closest === 'function' ? target.closest('a') : null;
    if (!link) return;
    const material = resolveWorkspaceContextRunFileLink(
      link.getAttribute('href'),
      { files, references, assets },
      { contextDir, referencesDir, assetsDir },
    );
    if (!material) return;
    event.preventDefault();
    onOpenMaterial(material);
  }, [files, references, assets, contextDir, referencesDir, assetsDir, onOpenMaterial]);
  return <div className="ws-wc-run-summary prose" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }}/>;
}

function normalizeWorkspaceContextSection(section){
  if (section === 'files') return 'context';
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


export function WorkspaceSettingsPage({ hash, label, initialTab, initialWorkspaceContextSection, initialRoutineId, onOpenFiles, onOpenSettings, onClose }){
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
  const [workspaceContextReferences, setWorkspaceContextReferences] = React.useState([]);
  const [workspaceContextAssets, setWorkspaceContextAssets] = React.useState([]);
  const [workspaceContextContextDir, setWorkspaceContextContextDir] = React.useState('');
  const [workspaceContextReferencesDir, setWorkspaceContextReferencesDir] = React.useState('');
  const [workspaceContextAssetsDir, setWorkspaceContextAssetsDir] = React.useState('');
  const [workspaceContextInstructionPath, setWorkspaceContextInstructionPath] = React.useState('');
  const [workspaceContextSelectedFile, setWorkspaceContextSelectedFile] = React.useState(null);
  const [workspaceContextFileContent, setWorkspaceContextFileContent] = React.useState('');
  const [workspaceContextFileLoading, setWorkspaceContextFileLoading] = React.useState(false);
  const [workspaceContextScanBusy, setWorkspaceContextScanBusy] = React.useState(false);
  const [workspaceContextStopBusy, setWorkspaceContextStopBusy] = React.useState(false);
  const [routinesEnabled, setRoutinesEnabled] = React.useState(false);
  const [routinesData, setRoutinesData] = React.useState({ routines: [] });
  const [routineSelectedId, setRoutineSelectedId] = React.useState(null);
  const [routineDetail, setRoutineDetail] = React.useState(null);
  const [routineDraft, setRoutineDraft] = React.useState(null);
  const [routineDirty, setRoutineDirty] = React.useState(false);
  const [routineBusy, setRoutineBusy] = React.useState(false);
  const [routineRunBusy, setRoutineRunBusy] = React.useState(false);
  const [routineSettingsDraft, setRoutineSettingsDraft] = React.useState(routineSettingsDraftFromResponse(null));
  const [routineSettingsDirty, setRoutineSettingsDirty] = React.useState(false);
  const [routineTelegramConnect, setRoutineTelegramConnect] = React.useState(null);
  const [routineTelegramConnectBusy, setRoutineTelegramConnectBusy] = React.useState(false);
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
    setWorkspaceContextReferences(Array.isArray(next.references) ? next.references : []);
    setWorkspaceContextAssets(Array.isArray(next.assets) ? next.assets : []);
    setWorkspaceContextContextDir(next.contextDir || '');
    setWorkspaceContextReferencesDir(next.referencesDir || '');
    setWorkspaceContextAssetsDir(next.assetsDir || '');
    setWorkspaceContextInstructionPath(next.instructionPath || '');
  }

  function applyWorkspaceContextRuntimeResponse(res){
    const next = res || {};
    setWorkspaceContextEnabled(!!next.enabled);
    setWorkspaceContextState(next.state || null);
    setWorkspaceContextFiles(Array.isArray(next.files) ? next.files : []);
    setWorkspaceContextReferences(Array.isArray(next.references) ? next.references : []);
    setWorkspaceContextAssets(Array.isArray(next.assets) ? next.assets : []);
    setWorkspaceContextContextDir(next.contextDir || '');
    setWorkspaceContextReferencesDir(next.referencesDir || '');
    setWorkspaceContextAssetsDir(next.assetsDir || '');
    setWorkspaceContextInstructionPath(next.instructionPath || '');
    const running = workspaceContextRunsFromState(next.state).some(run => run && run.status === 'running');
    if (!running) {
      setWorkspaceContextScanBusy(false);
      setWorkspaceContextStopBusy(false);
    }
  }

  function applyRoutinesResponse(res){
    const next = res || {};
    const routines = Array.isArray(next.routines) ? next.routines : [];
    setRoutinesEnabled(!!next.enabled);
    setRoutinesData({ routines });
    if (!routines.some(routineItemIsRunning)) setRoutineRunBusy(false);
    applyRoutineSettingsResponse(next.settings || null);
    if (routineSelectedId && !routines.some(item => item && item.manifest && item.manifest.id === routineSelectedId)) {
      setRoutineSelectedId(null);
      setRoutineDetail(null);
      setRoutineDraft(null);
      setRoutineDirty(false);
    }
  }

  function applyRoutineSettingsResponse(res){
    setRoutineSettingsDraft(routineSettingsDraftFromResponse(res || null));
    setRoutineSettingsDirty(false);
  }

  function mergeRoutineSnapshot(routine){
    if (!routine || !routine.manifest || !routine.manifest.id) return;
    setRoutinesData(prev => {
      const routines = Array.isArray(prev && prev.routines) ? prev.routines : [];
      const seen = routines.some(item => item && item.manifest && item.manifest.id === routine.manifest.id);
      const nextRoutines = seen
        ? routines.map(item => item && item.manifest && item.manifest.id === routine.manifest.id ? { ...item, ...routine } : item)
        : [routine, ...routines];
      return { ...(prev || {}), routines: nextRoutines };
    });
    if (routineSelectedId === routine.manifest.id) {
      applyRoutineDetailResponse({ routine }, { preserveDraft: routineDirty });
    }
    if (!routineItemIsRunning(routine)) setRoutineRunBusy(false);
  }

  const workspaceContextRunPollKey = workspaceContextRunsFromState(workspaceContextState)
    .map(run => `${run.runId || ''}:${run.status || ''}`)
    .join('|');

  const routineRunPollKey = (Array.isArray(routinesData.routines) ? routinesData.routines : [])
    .map(item => {
      const manifest = item && item.manifest;
      const lastRun = item && item.lastRun;
      return `${manifest && manifest.id || ''}:${item && item.running ? 'running' : ''}:${lastRun && lastRun.status || ''}`;
    })
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
      AgentApi.workspace.getRoutines(hash).catch(() => ({ enabled: false, routines: [] })),
      AgentApi.workspace.getWorktreeIsolation(hash).catch((err) => ({ available: false, enabled: false, blockers: [{ code: 'load_failed', message: err.message || String(err) }] })),
      AgentApi.settings.get().catch(() => ({})),
      AgentApi.settings.backends().catch(() => ({ backends: [] })),
    ]).then(([locationRes, archiveRes, instrRes, memRes, kbRes, workspaceContextRes, routinesRes, worktreeRes, settingsRes, backendsRes]) => {
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
      applyRoutinesResponse(routinesRes);
      const routines = Array.isArray(routinesRes && routinesRes.routines) ? routinesRes.routines : [];
      const targetRoutine = routinesRes && routinesRes.enabled
        ? ((initialRoutineId && routines.find(item => item && item.manifest && item.manifest.id === initialRoutineId)) || routines[0] || null)
        : null;
      if (targetRoutine && targetRoutine.manifest && targetRoutine.manifest.id) {
        selectRoutine(targetRoutine.manifest.id).catch(() => {});
      } else {
        setRoutineSelectedId(null);
        setRoutineDetail(null);
        setRoutineDraft(null);
        setRoutineDirty(false);
      }
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
  }, [hash, initialTab, initialRoutineId]);

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

  React.useEffect(() => {
    if (!hash || tab !== 'routines' || !routinesEnabled) return undefined;
    const running = (Array.isArray(routinesData.routines) ? routinesData.routines : []).some(routineItemIsRunning);
    if (!running && !routineRunBusy) return undefined;
    let cancelled = false;
    const refresh = () => {
      AgentApi.workspace.getRoutines(hash).then((res) => {
        if (cancelled) return;
        const selectedStillExists = res && Array.isArray(res.routines) && res.routines.some(item => item && item.manifest && item.manifest.id === routineSelectedId);
        if (routineSelectedId && selectedStillExists) {
          return AgentApi.workspace.getRoutine(hash, routineSelectedId).catch(() => null).then((detailRes) => {
            if (cancelled) return;
            applyRoutinesResponse(res);
            if (detailRes) applyRoutineDetailResponse(detailRes, { preserveDraft: routineDirty });
          });
        }
        applyRoutinesResponse(res);
        return null;
      }).catch(() => {});
    };
    const timer = setInterval(refresh, 1000);
    refresh();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hash, tab, routinesEnabled, routineRunPollKey, routineRunBusy, routineSelectedId, routineDirty]);

  React.useEffect(() => {
    if (!hash || tab !== 'routines' || !routinesEnabled || !routineTelegramConnect || routineTelegramConnect.status !== 'pending') return undefined;
    let cancelled = false;
    let inflight = false;
    const poll = () => {
      if (inflight) return;
      inflight = true;
      setRoutineTelegramConnectBusy(true);
      AgentApi.workspace.pollRoutineTelegramDestinationConnect(hash).then((res) => {
        if (cancelled) return;
        applyRoutineTelegramConnectPollResponse(res || {}, { silent: true });
      }).catch((err) => {
        if (cancelled) return;
        setRoutineTelegramConnect(prev => prev ? { ...prev, status: 'error', error: err.message || String(err) } : prev);
      }).finally(() => {
        inflight = false;
        if (!cancelled) setRoutineTelegramConnectBusy(false);
      });
    };
    poll();
    const timer = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hash, tab, routinesEnabled, routineTelegramConnect && routineTelegramConnect.status, routineTelegramConnect && routineTelegramConnect.code]);

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

  async function toggleRoutines(enabled){
    const prev = routinesEnabled;
    const prevSelectedId = routineSelectedId;
    const prevDetail = routineDetail;
    const prevDraft = routineDraft;
    const prevDirty = routineDirty;
    const prevRunBusy = routineRunBusy;
    const prevTelegramConnect = routineTelegramConnect;
    setRoutinesEnabled(enabled);
    if (!enabled) {
      setRoutineSelectedId(null);
      setRoutineDetail(null);
      setRoutineDraft(null);
      setRoutineDirty(false);
      setRoutineRunBusy(false);
      setRoutineTelegramConnect(null);
    }
    setRoutineBusy(true);
    try {
      const res = await AgentApi.workspace.setRoutinesEnabled(hash, enabled);
      applyRoutinesResponse(res);
      if (enabled) {
        const routines = Array.isArray(res && res.routines) ? res.routines : [];
        const targetId = routines[0] && routines[0].manifest && routines[0].manifest.id;
        if (targetId) await selectRoutine(targetId);
      }
      toast.success(enabled ? 'Workspace Routines enabled' : 'Workspace Routines disabled');
    } catch (err) {
      setRoutinesEnabled(prev);
      setRoutineSelectedId(prevSelectedId);
      setRoutineDetail(prevDetail);
      setRoutineDraft(prevDraft);
      setRoutineDirty(prevDirty);
      setRoutineRunBusy(prevRunBusy);
      setRoutineTelegramConnect(prevTelegramConnect);
      await dialog.alert({ variant: 'error', title: 'Failed to update Routines setting', body: err.message || String(err) });
    } finally {
      setRoutineBusy(false);
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
      body: 'Clear all Workspace Context files, references, assets, and run history for this workspace? The workspace setting will stay unchanged.',
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

  function applyRoutineDetailResponse(res, opts){
    const detail = res && res.routine ? res.routine : res;
    setRoutineDetail(detail || null);
    if (!detail) {
      setRoutineDraft(null);
      setRoutineDirty(false);
      return;
    }
    if (opts && opts.preserveDraft && routineDraft) return;
    setRoutineDraft(routineDraftFromDetail(detail));
    setRoutineDirty(false);
  }

  async function selectRoutine(routineId){
    if (!routineId) return;
    setRoutineSelectedId(routineId);
    setRoutineBusy(true);
    try {
      const res = await AgentApi.workspace.getRoutine(hash, routineId);
      applyRoutineDetailResponse(res);
    } catch (err) {
      setRoutineDetail(null);
      setRoutineDraft(null);
      await dialog.alert({ variant: 'error', title: 'Routine load failed', body: err.message || String(err) });
    } finally {
      setRoutineBusy(false);
    }
  }

  async function refreshRoutines(selectId){
    const res = await AgentApi.workspace.getRoutines(hash);
    applyRoutinesResponse(res);
    const routines = Array.isArray(res && res.routines) ? res.routines : [];
    const targetId = (selectId && routines.some(item => item && item.manifest && item.manifest.id === selectId))
      ? selectId
      : (routines[0] && routines[0].manifest && routines[0].manifest.id);
    if (targetId) {
      await selectRoutine(targetId);
    } else {
      setRoutineSelectedId(null);
      setRoutineDetail(null);
      setRoutineDraft(null);
      setRoutineDirty(false);
    }
    return res;
  }

  function patchRoutineDraft(patch){
    setRoutineDraft(prev => ({ ...(prev || routineDraftFromDetail(routineDetail)), ...patch }));
    setRoutineDirty(true);
  }

  async function saveRoutine(anchor){
    if (!routineDetail || !routineDraft || routineBusy) return;
    if (!routineDraft.title.trim()) {
      await dialog.alert({ anchor, variant: 'error', title: 'Title required', body: 'Routine title is required.' });
      return;
    }
    setRoutineBusy(true);
    try {
      const res = await AgentApi.workspace.updateRoutine(hash, routineDetail.manifest.id, {
        manifest: routineManifestPatchFromDraft(routineDraft),
        routineContent: routineDraft.routineContent,
      });
      applyRoutineDetailResponse(res);
      await refreshRoutines(routineDetail.manifest.id);
      toast.success('Routine saved');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Save routine failed', body: err.message || String(err) });
    } finally {
      setRoutineBusy(false);
    }
  }

  async function installRoutineState(routineId, state, anchor){
    if (!routineId || routineBusy) return;
    setRoutineBusy(true);
    try {
      await AgentApi.workspace.installRoutine(hash, routineId, state);
      await refreshRoutines(routineId);
      toast.success(state === 'enabled' ? 'Routine enabled' : 'Routine disabled');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Routine update failed', body: err.message || String(err) });
    } finally {
      setRoutineBusy(false);
    }
  }

  async function runRoutineNow(routineId, anchor){
    if (!routineId || routineRunBusy) return;
    let keepPolling = false;
    setRoutineRunBusy(true);
    try {
      const res = await AgentApi.workspace.runRoutine(hash, routineId);
      if (res && res.routine) {
        mergeRoutineSnapshot(res.routine);
        keepPolling = routineItemIsRunning(res.routine) || (res.run && res.run.status === 'running');
      } else {
        const refreshed = await refreshRoutines(routineId);
        const routines = Array.isArray(refreshed && refreshed.routines) ? refreshed.routines : [];
        keepPolling = routines.some(routineItemIsRunning);
      }
      toast.success('Routine run started');
    } catch (err) {
      if (err && err.status === 409) {
        const refreshed = await refreshRoutines(routineId).catch(() => null);
        const routines = Array.isArray(refreshed && refreshed.routines) ? refreshed.routines : [];
        keepPolling = routines.length ? routines.some(routineItemIsRunning) : true;
        toast.warn('Routine run already running');
        return;
      }
      keepPolling = false;
      await dialog.alert({ anchor, variant: 'error', title: 'Run routine failed', body: err.message || String(err) });
    } finally {
      if (!keepPolling) setRoutineRunBusy(false);
    }
  }

  async function deleteRoutine(routineId, anchor){
    if (!routineId || routineBusy) return;
    const ok = await dialog.confirm({
      anchor,
      title: 'Delete Routine',
      body: 'Delete this routine and its run history from the workspace?',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    setRoutineBusy(true);
    try {
      await AgentApi.workspace.deleteRoutine(hash, routineId);
      await refreshRoutines(null);
      toast.success('Routine deleted');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Delete routine failed', body: err.message || String(err) });
    } finally {
      setRoutineBusy(false);
    }
  }

  async function repairRoutineInstructions(anchor){
    setRoutineBusy(true);
    try {
      await AgentApi.workspace.repairRoutineInstructions(hash);
      await refreshRoutines(routineSelectedId);
      toast.success('Routine instructions repaired');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Repair failed', body: err.message || String(err) });
    } finally {
      setRoutineBusy(false);
    }
  }

  function patchRoutineSettingsDraft(patch){
    setRoutineSettingsDraft(prev => ({ ...(prev || routineSettingsDraftFromResponse(null)), ...patch }));
    setRoutineSettingsDirty(true);
  }

  function applyRoutineTelegramConnectPollResponse(res, opts = {}){
    const status = res && res.status;
    if (status === 'connected') {
      if (res.settings) applyRoutineSettingsResponse(res.settings);
      setRoutineTelegramConnect({
        status: 'connected',
        destination: res.destination || null,
      });
      if (!opts.silent) toast.success('Telegram destination connected');
      return;
    }
    if (status === 'expired') {
      setRoutineTelegramConnect(prev => prev ? { ...prev, status: 'expired' } : { status: 'expired' });
      return;
    }
    if (status === 'missing_bot') {
      setRoutineTelegramConnect({ status: 'missing_bot' });
      return;
    }
    setRoutineTelegramConnect(prev => ({
      ...(prev || {}),
      status: 'pending',
      code: res && res.code || prev && prev.code || '',
      expiresAt: res && res.expiresAt || prev && prev.expiresAt || '',
    }));
  }

  async function startRoutineTelegramConnect(anchor){
    if (routineTelegramConnectBusy) return;
    setRoutineTelegramConnectBusy(true);
    try {
      const res = await AgentApi.workspace.startRoutineTelegramDestinationConnect(hash);
      if (res && res.status === 'missing_bot') {
        setRoutineTelegramConnect({ status: 'missing_bot' });
        return;
      }
      setRoutineTelegramConnect({
        status: 'pending',
        code: res && res.code || '',
        expiresAt: res && res.expiresAt || '',
        instruction: res && res.instruction || '',
      });
      toast.success('Telegram connection code created');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Telegram connection failed', body: err.message || String(err) });
    } finally {
      setRoutineTelegramConnectBusy(false);
    }
  }

  async function pollRoutineTelegramConnect(anchor){
    if (routineTelegramConnectBusy) return;
    setRoutineTelegramConnectBusy(true);
    try {
      const res = await AgentApi.workspace.pollRoutineTelegramDestinationConnect(hash);
      applyRoutineTelegramConnectPollResponse(res || {});
    } catch (err) {
      setRoutineTelegramConnect(prev => prev ? { ...prev, status: 'error', error: err.message || String(err) } : { status: 'error', error: err.message || String(err) });
      await dialog.alert({ anchor, variant: 'error', title: 'Telegram check failed', body: err.message || String(err) });
    } finally {
      setRoutineTelegramConnectBusy(false);
    }
  }

  async function saveRoutineSettings(anchor){
    setRoutineBusy(true);
    try {
      const telegram = {
        enabled: !!routineSettingsDraft.telegramEnabled,
        chatId: routineSettingsDraft.telegramChatId || '',
        chatTitle: routineSettingsDraft.telegramChatTitle || '',
        chatType: routineSettingsDraft.telegramChatType || '',
      };
      const res = await AgentApi.workspace.saveRoutineSettings(hash, { telegram });
      applyRoutineSettingsResponse(res || null);
      toast.success('Routine notification settings saved');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Save notification settings failed', body: err.message || String(err) });
    } finally {
      setRoutineBusy(false);
    }
  }

  const openRoutineOutputFolder = React.useCallback((run) => {
    if (!onOpenFiles || !run || !run.routineId || !run.runId) return;
    const routineTitle = (routineDetail && routineDetail.manifest && routineDetail.manifest.title) || run.routineId || 'Routine';
    onOpenFiles(hash, `${routineTitle} Output`, {
      readOnly: true,
      returnToWorkspaceSettings: {
        hash,
        label,
        initialTab: 'routines',
        initialRoutineId: run.routineId,
      },
      scope: {
        type: 'routine-output',
        routineId: run.routineId,
        runId: run.runId,
      },
    });
  }, [hash, label, onOpenFiles, routineDetail]);

  const openRoutineOutputs = React.useCallback((routine) => {
    const manifest = routine && routine.manifest;
    if (!onOpenFiles || !manifest || !manifest.id) return;
    onOpenFiles(hash, `${manifest.title || manifest.id} Outputs`, {
      readOnly: true,
      returnToWorkspaceSettings: {
        hash,
        label,
        initialTab: 'routines',
        initialRoutineId: manifest.id,
      },
      scope: {
        type: 'routine-outputs',
        routineId: manifest.id,
      },
    });
  }, [hash, label, onOpenFiles]);

  const openRoutinePersistentState = React.useCallback((routine) => {
    const manifest = routine && routine.manifest;
    if (!onOpenFiles || !manifest || !manifest.id) return;
    onOpenFiles(hash, `${manifest.title || manifest.id} Persistent State`, {
      readOnly: true,
      returnToWorkspaceSettings: {
        hash,
        label,
        initialTab: 'routines',
        initialRoutineId: manifest.id,
      },
      scope: {
        type: 'routine-state',
        routineId: manifest.id,
      },
    });
  }, [hash, label, onOpenFiles]);

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
            hash={hash}
            enabled={workspaceContextEnabled}
            settings={workspaceContextSettings}
            state={workspaceContextState}
            files={workspaceContextFiles}
            references={workspaceContextReferences}
            assets={workspaceContextAssets}
            contextDir={workspaceContextContextDir}
            referencesDir={workspaceContextReferencesDir}
            assetsDir={workspaceContextAssetsDir}
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
        ) : tab === 'routines' ? (
          <RoutinesTab
            hash={hash}
            enabled={routinesEnabled}
            data={routinesData}
            selectedId={routineSelectedId}
            detail={routineDetail}
            draft={routineDraft}
            dirty={routineDirty}
            busy={routineBusy}
            runBusy={routineRunBusy}
            settingsDraft={routineSettingsDraft}
            settingsDirty={routineSettingsDirty}
            telegramConnect={routineTelegramConnect}
            telegramConnectBusy={routineTelegramConnectBusy}
            globalSettings={globalSettings}
            onSelect={selectRoutine}
            onRefresh={() => refreshRoutines(routineSelectedId)}
            onPatchDraft={patchRoutineDraft}
            onSave={saveRoutine}
            onInstallState={installRoutineState}
            onRun={runRoutineNow}
            onOpenOutputs={openRoutineOutputs}
            onOpenPersistentState={openRoutinePersistentState}
            onDelete={deleteRoutine}
            onRepairInstructions={repairRoutineInstructions}
            onPatchSettings={patchRoutineSettingsDraft}
            onSaveSettings={saveRoutineSettings}
            onStartTelegramConnect={startRoutineTelegramConnect}
            onPollTelegramConnect={pollRoutineTelegramConnect}
            onCancelTelegramConnect={() => setRoutineTelegramConnect(null)}
            onOpenOutputFolder={openRoutineOutputFolder}
            onToggleEnabled={toggleRoutines}
            onOpenSettings={onOpenSettings}
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
          <ArchiveMetric label="Routines" value={status && status.routinesEnabled ? 'On' : 'Off'}/>
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

function RoutinesTab({
  data,
  enabled,
  selectedId,
  detail,
  draft,
  dirty,
  busy,
  runBusy,
  settingsDraft,
  settingsDirty,
  telegramConnect,
  telegramConnectBusy,
  globalSettings,
  onSelect,
  onRefresh,
  onPatchDraft,
  onSave,
  onInstallState,
  onRun,
  onOpenOutputs,
  onOpenPersistentState,
  onDelete,
  onRepairInstructions,
  onPatchSettings,
  onSaveSettings,
  onStartTelegramConnect,
  onPollTelegramConnect,
  onCancelTelegramConnect,
  onOpenOutputFolder,
  onToggleEnabled,
  onOpenSettings,
}){
  const routines = Array.isArray(data && data.routines) ? data.routines : [];
  const profiles = activeWorkspaceCliProfiles(globalSettings);
  const routineRuns = React.useMemo(() => {
    const runs = Array.isArray(detail && detail.runs) ? detail.runs : [];
    const lastRun = detail && detail.lastRun;
    const merged = lastRun ? [lastRun, ...runs.filter(run => run && run.runId !== lastRun.runId)] : runs;
    return merged.slice().sort((a, b) => routineRunTimestamp(b) - routineRunTimestamp(a));
  }, [detail]);

  const visibleRuns = routineRuns.slice(0, 6);
  const running = !!(detail && detail.running);
  const state = draft && draft.state || detail && detail.manifest && detail.manifest.state || 'proposed';
  const canRun = detail && state !== 'proposed' && !running;
  const title = detail && detail.manifest ? detail.manifest.title : '';
  const browserTz = browserTimezone();
  const timezoneOptions = React.useMemo(() => routineTimezoneOptions(draft && draft.timezone), [draft && draft.timezone]);
  const telegramConnectStatus = telegramConnect && telegramConnect.status;
  const telegramDestinationLabel = settingsDraft.telegramChatTitle
    ? `${settingsDraft.telegramChatTitle}${settingsDraft.telegramChatType ? ` (${settingsDraft.telegramChatType})` : ''}`
    : settingsDraft.telegramChatId
      ? 'Chat ID configured'
      : 'Add this workspace destination';

  if (!enabled) {
    return (
      <div className="settings-form settings-form-wide ws-form ws-form-routines">
        <p className="ws-desc u-dim">
          Workspace Routines run markdown workflows manually or on a schedule
          through a selected CLI profile. Enabling adds the workspace authoring
          instructions that let conversations create and edit routine proposals.
        </p>
        <label className="toggle ws-toggle">
          <input
            type="checkbox"
            checked={false}
            disabled={busy}
            onChange={(e) => onToggleEnabled(e.target.checked)}
          />
          <span className="tgl"/>
          <span>Enable Workspace Routines for this workspace</span>
        </label>
        <p className="ws-empty u-dim">Workspace Routines are disabled. Existing routine files, outputs, and persistent state are kept.</p>
      </div>
    );
  }

  return (
    <div className="settings-form settings-form-wide ws-form ws-form-workspace-context ws-form-routines">
      <div className="ws-wc-layout">
        <nav className="ws-wc-rail ws-routine-rail" aria-label="Workspace routines">
          <div className="ws-routine-feature-toggle">
            <label className="toggle ws-toggle">
              <input
                type="checkbox"
                checked={true}
                disabled={busy}
                onChange={(e) => onToggleEnabled(e.target.checked)}
              />
              <span className="tgl"/>
              <span>Workspace Routines</span>
            </label>
          </div>
          <div className="ws-routine-rail-head">
            <div>
              <div className="ws-wc-section-title">Routines</div>
              <small>{routines.length} total</small>
            </div>
            <div className="ws-routine-rail-actions">
              <button type="button" className="btn ghost" disabled={busy} onClick={onRefresh} title="Refresh routines" aria-label="Refresh routines">{Ico.reset(12)}</button>
              <button type="button" className="btn ghost" disabled={busy} onClick={(e) => onRepairInstructions(e.currentTarget)} title="Repair routine instructions" aria-label="Repair routine instructions">{Ico.settings(12)}</button>
            </div>
          </div>
          <div className="ws-wc-file-list ws-routine-list">
            <ul>
              {routines.map(item => {
                const manifest = item.manifest || {};
                const itemRunning = !!item.running;
                return (
                  <li key={manifest.id}>
                    <button
                      type="button"
                      className={selectedId === manifest.id ? 'active' : ''}
                      onClick={() => onSelect(manifest.id)}
                    >
                      <span>{manifest.title || manifest.id}</span>
                      <small>{itemRunning ? 'Running' : (manifest.state || 'unknown')}</small>
                    </button>
                  </li>
                );
              })}
            </ul>
            {routines.length === 0 ? (
              <p className="ws-wc-list-empty u-dim">No routines yet.</p>
            ) : null}
          </div>

          <div className="ws-routine-settings">
            <div className="ws-wc-section-title">Outreach</div>
            <label className="toggle ws-toggle">
              <input
                type="checkbox"
                checked={!!settingsDraft.telegramEnabled}
                onChange={(e) => onPatchSettings({ telegramEnabled: e.target.checked })}
              />
              <span className="tgl"/>
              <span>Telegram</span>
            </label>
            <label className="ws-wc-field">
              <span>Chat ID (advanced)</span>
              <input
                value={settingsDraft.telegramChatId || ''}
                onChange={(e) => onPatchSettings({ telegramChatId: e.target.value, telegramChatTitle: '', telegramChatType: '' })}
              />
            </label>
            <div className="ws-muted-metadata">
              <span>Bot: {settingsDraft.telegramBotConfigured ? 'Connected in Global Settings' : 'Connect Telegram in Global Settings'}</span>
              <span>Destination: {settingsDraft.telegramDestinationConfigured ? telegramDestinationLabel : 'Add this workspace destination'}</span>
            </div>
            {!settingsDraft.telegramBotConfigured && onOpenSettings ? (
              <button type="button" className="btn ghost" disabled={busy} onClick={() => onOpenSettings('integrations')}>
                {Ico.message(12)} Open Integrations
              </button>
            ) : null}
            {settingsDraft.telegramBotConfigured && telegramConnectStatus !== 'pending' ? (
              <button type="button" className="btn ghost" disabled={busy || telegramConnectBusy} onClick={(e) => onStartTelegramConnect(e.currentTarget)}>
                {Ico.message(12)} Connect Destination
              </button>
            ) : null}
            {telegramConnectStatus === 'pending' ? (
              <div className="ws-routine-connect-card">
                <div className="ws-routine-connect-code">
                  <span>Send to the target Telegram chat</span>
                  <code>{(telegramConnect && telegramConnect.instruction) || `/connect ${telegramConnect && telegramConnect.code || ''}`}</code>
                </div>
                <div className="ws-muted-metadata">
                  <span>For groups, add the bot first and send the same message in that group.</span>
                  {telegramConnect && telegramConnect.expiresAt ? <span>Expires {formatMemoryUpdateTime(telegramConnect.expiresAt)}</span> : null}
                </div>
                <div className="ws-routine-connect-actions">
                  <button type="button" className="btn ghost" disabled={telegramConnectBusy} onClick={(e) => onPollTelegramConnect(e.currentTarget)}>
                    {telegramConnectBusy ? 'Checking...' : 'Check now'}
                  </button>
                  <button type="button" className="btn ghost" disabled={telegramConnectBusy} onClick={onCancelTelegramConnect}>Cancel</button>
                </div>
              </div>
            ) : null}
            {telegramConnectStatus === 'connected' ? (
              <div className="ws-routine-connect-card is-connected">
                <span>Installed destination: {telegramDestinationLabel}</span>
              </div>
            ) : null}
            {telegramConnectStatus === 'expired' ? (
              <div className="ws-routine-connect-card is-warning">
                <span>Connection code expired. Start again to get a new code.</span>
              </div>
            ) : null}
            {telegramConnectStatus === 'missing_bot' ? (
              <div className="ws-routine-connect-card is-warning">
                <span>Connect Telegram in Global Settings before choosing a destination.</span>
              </div>
            ) : null}
            {telegramConnectStatus === 'error' ? (
              <div className="ws-routine-connect-card is-warning">
                <span>{telegramConnect && telegramConnect.error || 'Telegram connection failed.'}</span>
              </div>
            ) : null}
            <button type="button" className="btn primary" disabled={busy || telegramConnectBusy || !settingsDirty} onClick={(e) => onSaveSettings(e.currentTarget)}>
              {busy ? 'Saving...' : 'Save outreach'}
            </button>
          </div>
        </nav>

        <div className="ws-wc-content">
          {!detail || !draft ? (
            <section className="ws-wc-panel" role="tabpanel">
              <div className="ws-wc-title-row">
                <div>
                  <h3 className="ws-wc-title">Routines</h3>
                </div>
              </div>
            </section>
          ) : (
            <>
              <section className="ws-wc-panel ws-routine-panel" role="tabpanel" aria-label="Selected routine">
                <div className="ws-wc-title-row">
                  <div>
                    <h3 className="ws-wc-title">{title || 'Routine'}</h3>
                    <p className="ws-desc u-dim">{detail.manifest && detail.manifest.id}</p>
                  </div>
                  <span className={'ws-wc-status-badge is-routine-' + state}>{running ? 'Running' : state}</span>
                </div>

                <div className="ws-actions ws-routine-actions">
                  {state === 'proposed' ? (
                    <>
                      <button type="button" className="btn primary" disabled={busy} onClick={(e) => onInstallState(detail.manifest.id, 'enabled', e.currentTarget)}>{Ico.check(12)} Install enabled</button>
                      <button type="button" className="btn ghost" disabled={busy} onClick={(e) => onInstallState(detail.manifest.id, 'disabled', e.currentTarget)}>Install disabled</button>
                    </>
                  ) : (
                    <button type="button" className="btn primary" disabled={busy || runBusy || !canRun} onClick={(e) => onRun(detail.manifest.id, e.currentTarget)}>
                      {Ico.play(12)} {running || runBusy ? 'Running...' : 'Run now'}
                    </button>
                  )}
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => onOpenOutputs && onOpenOutputs(detail)}>
                    {Ico.folder(12)} Outputs
                  </button>
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => onOpenPersistentState && onOpenPersistentState(detail)}>
                    {Ico.archive(12)} Persistent State
                  </button>
                  <button type="button" className="btn primary" disabled={busy || !dirty} onClick={(e) => onSave(e.currentTarget)}>
                    {busy ? 'Saving...' : 'Save Routine'}
                  </button>
                  <span className="ws-routine-actions-spacer" aria-hidden="true" />
                  <button type="button" className="btn ghost" disabled={busy} onClick={onRefresh}>{Ico.reset(12)} Refresh</button>
                  {state !== 'proposed' ? (
                    <button type="button" className="btn ghost" disabled={busy} onClick={(e) => onInstallState(detail.manifest.id, state === 'enabled' ? 'disabled' : 'enabled', e.currentTarget)}>
                      {state === 'enabled' ? 'Disable' : 'Enable'}
                    </button>
                  ) : null}
                  <button type="button" className="btn ghost danger" disabled={busy || running} onClick={(e) => onDelete(detail.manifest.id, e.currentTarget)}>{Ico.trash(12)} Delete</button>
                </div>

                <label className="ws-wc-field">
                  <span>Title</span>
                  <input value={draft.title} onChange={(e) => onPatchDraft({ title: e.target.value })}/>
                </label>
              </section>

              <section className="ws-wc-panel ws-routine-panel" role="tabpanel" aria-label="Routine trigger">
                <div className="ws-wc-section-title">Trigger</div>
                <div className="seg seg-inline ws-wc-seg">
                  <button type="button" aria-pressed={draft.triggerType === 'manual'} onClick={() => onPatchDraft({ triggerType: 'manual' })}>Manual</button>
                  <button type="button" aria-pressed={draft.triggerType === 'schedule'} onClick={() => onPatchDraft({ triggerType: 'schedule' })}>Schedule</button>
                </div>
                {draft.triggerType === 'schedule' ? (
                  <div className="ws-routine-grid">
                    <label className="ws-wc-field">
                      <span>Interval minutes</span>
                      <input type="number" min={1} max={1440} value={draft.intervalMinutes} onChange={(e) => onPatchDraft({ intervalMinutes: e.target.value })}/>
                    </label>
                    <label className="ws-wc-field">
                      <span>Timezone</span>
                      <select value={draft.timezone || ''} onChange={(e) => onPatchDraft({ timezone: e.target.value })}>
                        <option value="">Browser default ({browserTz})</option>
                        {timezoneOptions.map(zone => <option key={zone} value={zone}>{zone}</option>)}
                      </select>
                    </label>
                    <label className="toggle ws-toggle ws-routine-toggle">
                      <input type="checkbox" checked={!!draft.weekdaysOnly} onChange={(e) => onPatchDraft({ weekdaysOnly: e.target.checked })}/>
                      <span className="tgl"/>
                      <span>Weekdays only</span>
                    </label>
                  </div>
                ) : null}
              </section>

              <section className="ws-wc-panel ws-routine-panel" role="tabpanel" aria-label="Routine harness">
                <div className="ws-wc-section-title">Harness</div>
                <label className="ws-wc-field">
                  <span>CLI profile</span>
                  <select value={draft.cliProfileId} onChange={(e) => onPatchDraft({ cliProfileId: e.target.value })}>
                    <option value="">Default CLI Profile</option>
                    {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                  </select>
                </label>
                <div className="ws-wc-field">
                  <span>Notification</span>
                  <div className="seg seg-inline ws-wc-seg">
                    <button type="button" aria-pressed={draft.notificationMode !== 'off'} onClick={() => onPatchDraft({ notificationMode: 'workspaceDefault' })}>Workspace default</button>
                    <button type="button" aria-pressed={draft.notificationMode === 'off'} onClick={() => onPatchDraft({ notificationMode: 'off' })}>Off</button>
                  </div>
                </div>
              </section>

              <section className="ws-wc-panel ws-routine-panel" role="tabpanel" aria-label="Routine markdown">
                <div className="ws-wc-review-head">
                  <div>
                    <div className="ws-wc-section-title">Markdown</div>
                    <div className="ws-wc-section-summary u-dim">{detail.routinePath}</div>
                  </div>
                </div>
                <textarea
                  className="ws-wc-preview-editor ws-routine-editor"
                  value={draft.routineContent}
                  onChange={(e) => onPatchDraft({ routineContent: e.target.value })}
                  rows={20}
                />
              </section>

              <section className="ws-wc-panel ws-routine-panel" role="tabpanel" aria-label="Routine runs">
                <div className="ws-wc-review-head">
                  <div>
                    <div className="ws-wc-section-title">Runs</div>
                    <div className="ws-wc-section-summary u-dim">Latest runs first.</div>
                  </div>
                </div>
                {visibleRuns.length ? (
                  <div className="ws-wc-runs">
                    {visibleRuns.map(run => (
                      <div key={run.runId} className="ws-wc-run-card">
                        <div className="ws-wc-run-card-head">
                          <b>{run.source === 'scheduled' ? 'Scheduled' : 'Manual'}</b>
                          <span>{run.status || 'unknown'}</span>
                        </div>
                        <div className="ws-wc-run-card-meta">
                          <span>{run.startedAt ? formatMemoryUpdateTime(run.startedAt) : ''}</span>
                          {run.outputDir ? (
                            <button
                              type="button"
                              className="btn ghost ws-routine-output-link"
                              onClick={() => onOpenOutputFolder && onOpenOutputFolder(run)}
                            >
                              {Ico.folder(12)} Browse Output Folder
                            </button>
                          ) : null}
                        </div>
                        {run.notificationError ? <p className="u-err">{run.notificationError}</p> : null}
                        {run.errorMessage ? <p className="u-err">{run.errorMessage}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="ws-empty u-dim">No routine runs yet.</p>
                )}
              </section>
            </>
          )}
        </div>
      </div>
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
  hash,
  enabled,
  settings,
  state,
  files,
  references,
  assets,
  contextDir,
  referencesDir,
  assetsDir,
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
  const dialog = useDialog();
  const toast = useToasts();
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
  const [referenceQuery, setReferenceQuery] = React.useState('');
  const [assetQuery, setAssetQuery] = React.useState('');
  const [selectedReference, setSelectedReference] = React.useState(null);
  const [referenceContent, setReferenceContent] = React.useState('');
  const [referenceDraft, setReferenceDraft] = React.useState('');
  const [referenceLoading, setReferenceLoading] = React.useState(false);
  const [referenceSaving, setReferenceSaving] = React.useState(false);
  const [newReferencePath, setNewReferencePath] = React.useState('');
  const [selectedAsset, setSelectedAsset] = React.useState(null);
  const [assetPreview, setAssetPreview] = React.useState(null);
  const [assetLoading, setAssetLoading] = React.useState(false);
  const [assetUploading, setAssetUploading] = React.useState(false);
  const [assetUploadPath, setAssetUploadPath] = React.useState('');
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
  const visibleReferences = (Array.isArray(references) ? references : []).filter(file => {
    const query = referenceQuery.trim().toLowerCase();
    if (!query) return true;
    return String(file.path || file.name || '').toLowerCase().includes(query);
  });
  const visibleAssets = (Array.isArray(assets) ? assets : []).filter(file => {
    const query = assetQuery.trim().toLowerCase();
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

  React.useEffect(() => {
    if (!selectedReference) return;
    const list = Array.isArray(references) ? references : [];
    if (list.some(file => file && file.path === selectedReference)) return;
    setSelectedReference(null);
    setReferenceContent('');
    setReferenceDraft('');
  }, [references, selectedReference]);

  React.useEffect(() => {
    if (!selectedAsset) return;
    const list = Array.isArray(assets) ? assets : [];
    if (list.some(file => file && file.path === selectedAsset)) return;
    setSelectedAsset(null);
    setAssetPreview(null);
  }, [assets, selectedAsset]);

  const workspaceContextSections = [
    { id: 'overview', label: 'Overview', desc: statusText },
    { id: 'processor', label: 'Processor', desc: settingsDirty ? 'Unsaved changes' : mode === 'override' ? 'Workspace override' : 'Global defaults' },
    { id: 'context', label: 'Context', desc: enabled ? String(visibleFiles.length) + ' files' : 'Disabled' },
    { id: 'references', label: 'References', desc: enabled ? String(visibleReferences.length) + ' files' : 'Disabled' },
    { id: 'assets', label: 'Assets', desc: enabled ? String(visibleAssets.length) + ' files' : 'Disabled' },
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

  function startNewWorkspaceContextReference(){
    setSelectedReference(null);
    setReferenceContent('');
    setReferenceDraft('');
    setNewReferencePath('');
  }

  function startWorkspaceContextAssetUpload(){
    setSelectedAsset(null);
    setAssetPreview(null);
    setAssetUploadPath('');
  }

  function selectSection(section){
    setWorkspaceContextSection(section);
    if (workspaceContextContentRef.current && typeof workspaceContextContentRef.current.scrollTo === 'function') {
      workspaceContextContentRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function openWorkspaceContextFileFromRun(relPath){
    if (!relPath) return;
    selectSection('context');
    if (onSelectFile) onSelectFile(relPath);
  }

  async function loadWorkspaceContextReference(relPath){
    if (!hash || !relPath) return;
    setSelectedReference(relPath);
    setReferenceLoading(true);
    try {
      const res = await AgentApi.workspace.getWorkspaceContextReference(hash, relPath);
      const content = (res && res.content) || '';
      setReferenceContent(content);
      setReferenceDraft(content);
    } catch (err) {
      setReferenceContent('');
      setReferenceDraft('');
      await dialog.alert({ variant: 'error', title: 'Reference preview failed', body: err.message || String(err) });
    } finally {
      setReferenceLoading(false);
    }
  }

  async function saveWorkspaceContextReference(anchor){
    const relPath = (selectedReference || newReferencePath || '').trim();
    if (!relPath) {
      await dialog.alert({ anchor, variant: 'error', title: 'Reference path required', body: 'Enter a reference file path ending in .md, .markdown, or .txt.' });
      return;
    }
    setReferenceSaving(true);
    try {
      await AgentApi.workspace.saveWorkspaceContextReference(hash, relPath, referenceDraft);
      setSelectedReference(relPath);
      setReferenceContent(referenceDraft);
      setNewReferencePath('');
      await onRefresh();
      toast.success('Reference saved');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Save reference failed', body: err.message || String(err) });
    } finally {
      setReferenceSaving(false);
    }
  }

  async function deleteWorkspaceContextReference(anchor, relPath){
    const target = relPath || selectedReference;
    if (!target) return;
    const ok = await dialog.confirm({ anchor, title: 'Delete Reference', body: 'Delete reference "' + target + '"?', confirmLabel: 'Delete', cancelLabel: 'Cancel', destructive: true });
    if (!ok) return;
    setReferenceSaving(true);
    try {
      await AgentApi.workspace.deleteWorkspaceContextReference(hash, target);
      if (selectedReference === target) {
        setSelectedReference(null);
        setReferenceContent('');
        setReferenceDraft('');
      }
      await onRefresh();
      toast.success('Reference deleted');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Delete reference failed', body: err.message || String(err) });
    } finally {
      setReferenceSaving(false);
    }
  }

  async function loadWorkspaceContextAsset(relPath){
    if (!hash || !relPath) return;
    setSelectedAsset(relPath);
    setAssetLoading(true);
    try {
      const asset = (Array.isArray(assets) ? assets : []).find(item => item && item.path === relPath) || {};
      if (asset.kind === 'image') {
        setAssetPreview({ imageUrl: AgentApi.workspace.workspaceContextAssetUrl(hash, relPath, 'view'), filename: asset.name || relPath });
      } else if (asset.previewable) {
        const res = await AgentApi.workspace.getWorkspaceContextAsset(hash, relPath, 'view');
        setAssetPreview(res || null);
      } else {
        setAssetPreview({ unsupported: true, filename: asset.name || relPath });
      }
    } catch (err) {
      setAssetPreview(null);
      await dialog.alert({ variant: 'error', title: 'Asset preview failed', body: err.message || String(err) });
    } finally {
      setAssetLoading(false);
    }
  }

  async function uploadWorkspaceContextAsset(event){
    const file = event && event.target && event.target.files && event.target.files[0];
    if (!file) return;
    const relPath = (assetUploadPath || file.name || '').trim();
    setAssetUploading(true);
    try {
      await AgentApi.workspace.uploadWorkspaceContextAsset(hash, relPath, file);
      setAssetUploadPath('');
      await onRefresh();
      await loadWorkspaceContextAsset(relPath);
      toast.success('Asset uploaded');
    } catch (err) {
      await dialog.alert({ variant: 'error', title: 'Asset upload failed', body: err.message || String(err) });
    } finally {
      if (event && event.target) event.target.value = '';
      setAssetUploading(false);
    }
  }

  async function deleteWorkspaceContextAsset(anchor, relPath){
    const target = relPath || selectedAsset;
    if (!target) return;
    const ok = await dialog.confirm({ anchor, title: 'Delete Asset', body: 'Delete asset "' + target + '"?', confirmLabel: 'Delete', cancelLabel: 'Cancel', destructive: true });
    if (!ok) return;
    setAssetUploading(true);
    try {
      await AgentApi.workspace.deleteWorkspaceContextAsset(hash, target);
      if (selectedAsset === target) {
        setSelectedAsset(null);
        setAssetPreview(null);
      }
      await onRefresh();
      toast.success('Asset deleted');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Delete asset failed', body: err.message || String(err) });
    } finally {
      setAssetUploading(false);
    }
  }

  function openWorkspaceContextMaterialFromRun(material){
    if (!material) return;
    if (material.section === 'context') {
      openWorkspaceContextFileFromRun(material.path);
    } else if (material.section === 'references') {
      selectSection('references');
      void loadWorkspaceContextReference(material.path);
    } else if (material.section === 'assets') {
      selectSection('assets');
      void loadWorkspaceContextAsset(material.path);
    }
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
                <div><span>References folder</span><b>{referencesDir || 'Not created yet'}</b></div>
                <div><span>Assets folder</span><b>{assetsDir || 'Not created yet'}</b></div>
                <div><span>Instruction file</span><b>{instructionPath || 'Not created yet'}</b></div>
                <div><span>Context files</span><b>{Array.isArray(files) ? files.length : 0}</b></div>
                <div><span>References</span><b>{Array.isArray(references) ? references.length : 0}</b></div>
                <div><span>Assets</span><b>{Array.isArray(assets) ? assets.length : 0}</b></div>
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
                <span className="settings-field-label-row">
                  <button type="button" className="btn ghost" onClick={(e) => onRepairInstructions(e.currentTarget)} disabled={!enabled}>Repair instructions</button>
                  <Tip variant="explain" rich={<WorkspaceSettingsHelpTooltip>Recreates the generated Workspace Context instruction file, required folders, and the managed AGENTS.md pointer block for this workspace. It does not run a scan or change saved context, references, or assets.</WorkspaceSettingsHelpTooltip>}>
                    <button
                      type="button"
                      className="settings-help-btn"
                      aria-label="Repair instructions help"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    >?</button>
                  </Tip>
                </span>
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
                        {models.map(m => <option key={m.id} value={m.id}>{modelDisplayLabel(m)}</option>)}
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

          {workspaceContextSection === 'context' ? (
            <section id="ws-wc-panel-context" className="ws-wc-panel" role="tabpanel" aria-labelledby="ws-wc-tab-context">
              <div className="ws-wc-review-head">
                <div>
                  <div className="ws-wc-section-title">Context</div>
                  <div className="ws-wc-section-summary u-dim">Read-only preview of synthesized Workspace Context markdown.</div>
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

          {workspaceContextSection === 'references' ? (
            <section id="ws-wc-panel-references" className="ws-wc-panel" role="tabpanel" aria-labelledby="ws-wc-tab-references">
              <div className="ws-wc-review-head">
                <div>
                  <div className="ws-wc-section-title">References</div>
                  <div className="ws-wc-section-summary u-dim">Exact reusable prompts, templates, style rules, and future instructions.</div>
                </div>
                <div className="ws-actions">
                  <button type="button" className="btn ghost" disabled={!enabled || referenceSaving} onClick={startNewWorkspaceContextReference}>New reference</button>
                  <button type="button" className="btn ghost" onClick={onRefresh}>{Ico.reset(12)} Refresh</button>
                </div>
              </div>
              {!enabled ? (
                <p className="ws-empty u-dim">Workspace Context is disabled for this workspace.</p>
              ) : (
                <div className="ws-wc-file-browser">
                  <div className="ws-wc-file-list">
                    <input type="search" value={referenceQuery} onChange={(e) => setReferenceQuery(e.target.value)} placeholder="Search references" aria-label="Search Workspace Context references"/>
                    <ul>
                      {visibleReferences.map(file => (
                        <li key={file.path}>
                          <button type="button" className={selectedReference === file.path ? 'active' : ''} onClick={() => loadWorkspaceContextReference(file.path)}>
                            <span>{workspaceContextFileLabel(file)}</span>
                            <small>{file.updatedAt ? formatMemoryUpdateTime(file.updatedAt) : ''}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {visibleReferences.length === 0 ? (
                      <p className="ws-wc-list-empty u-dim">{referenceQuery.trim() ? 'No references match this search.' : 'No references yet.'}</p>
                    ) : null}
                  </div>
                  <div className="ws-wc-file-preview">
                    {referenceLoading ? (
                      <div className="u-dim">Loading...</div>
                    ) : (
                      <>
                        <div className="ws-wc-file-preview-head">
                          {selectedReference ? (
                            <span>{selectedReference}</span>
                          ) : (
                            <input
                              className="ws-wc-inline-path"
                              type="text"
                              value={newReferencePath}
                              onChange={(e) => setNewReferencePath(e.target.value)}
                              placeholder="new-reference.md"
                              aria-label="New reference path"
                            />
                          )}
                          <small>{selectedReference ? 'Editable reference' : 'New reference'}</small>
                        </div>
                        <textarea
                          className="ws-wc-preview-editor"
                          value={referenceDraft}
                          onChange={(e) => setReferenceDraft(e.target.value)}
                          placeholder="Reference markdown or text"
                          rows={18}
                        />
                        <div className="ws-actions ws-wc-preview-actions">
                          <button type="button" className="btn primary" disabled={referenceSaving} onClick={(e) => saveWorkspaceContextReference(e.currentTarget)}>
                            {referenceSaving ? 'Saving...' : 'Save reference'}
                          </button>
                          {selectedReference ? (
                            <button type="button" className="btn ghost danger" disabled={referenceSaving} onClick={(e) => deleteWorkspaceContextReference(e.currentTarget, selectedReference)}>
                              {Ico.trash(12)} Delete
                            </button>
                          ) : null}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </section>
          ) : null}

          {workspaceContextSection === 'assets' ? (
            <section id="ws-wc-panel-assets" className="ws-wc-panel" role="tabpanel" aria-labelledby="ws-wc-tab-assets">
              <div className="ws-wc-review-head">
                <div>
                  <div className="ws-wc-section-title">Assets</div>
                  <div className="ws-wc-section-summary u-dim">Durable non-executable files linked from context or references.</div>
                </div>
                <div className="ws-actions">
                  <button type="button" className="btn ghost" disabled={!enabled || assetUploading} onClick={startWorkspaceContextAssetUpload}>New upload</button>
                  <button type="button" className="btn ghost" onClick={onRefresh}>{Ico.reset(12)} Refresh</button>
                </div>
              </div>
              {!enabled ? (
                <p className="ws-empty u-dim">Workspace Context is disabled for this workspace.</p>
              ) : (
                <div className="ws-wc-file-browser">
                  <div className="ws-wc-file-list">
                    <input type="search" value={assetQuery} onChange={(e) => setAssetQuery(e.target.value)} placeholder="Search assets" aria-label="Search Workspace Context assets"/>
                    <ul>
                      {visibleAssets.map(file => (
                        <li key={file.path}>
                          <button type="button" className={selectedAsset === file.path ? 'active' : ''} onClick={() => loadWorkspaceContextAsset(file.path)}>
                            <span>{workspaceContextFileLabel(file)}</span>
                            <small>{file.mimeType || ''}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {visibleAssets.length === 0 ? (
                      <p className="ws-wc-list-empty u-dim">{assetQuery.trim() ? 'No assets match this search.' : 'No assets yet.'}</p>
                    ) : null}
                  </div>
                  <div className="ws-wc-file-preview">
                    {assetLoading ? (
                      <div className="u-dim">Loading...</div>
                    ) : selectedAsset ? (
                      <>
                        <div className="ws-wc-file-preview-head">
                          <span>{selectedAsset}</span>
                          <small>{assetPreview && assetPreview.mimeType ? assetPreview.mimeType : 'Asset'}</small>
                        </div>
                        {assetPreview && assetPreview.imageUrl ? (
                          <img src={assetPreview.imageUrl} alt={selectedAsset} className="ws-wc-asset-image"/>
                        ) : assetPreview && typeof assetPreview.content === 'string' ? (
                          <pre>{assetPreview.content}</pre>
                        ) : (
                          <p className="ws-empty u-dim">This asset can be downloaded but not previewed inline.</p>
                        )}
                        <div className="ws-actions ws-wc-preview-actions">
                          <a className="btn primary" href={AgentApi.workspace.workspaceContextAssetUrl(hash, selectedAsset, 'download')}>Download</a>
                          <button type="button" className="btn ghost danger" disabled={assetUploading} onClick={(e) => deleteWorkspaceContextAsset(e.currentTarget, selectedAsset)}>
                            {Ico.trash(12)} Delete
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="ws-wc-file-preview-head">
                          <span>Upload asset</span>
                          <small>Optional path</small>
                        </div>
                        <div className="ws-wc-new-material">
                          <input type="text" value={assetUploadPath} onChange={(e) => setAssetUploadPath(e.target.value)} placeholder="asset path (optional)" aria-label="Workspace Context asset upload path"/>
                          <label className={'btn primary' + (assetUploading ? ' disabled' : '')}>
                            Upload asset
                            <input type="file" style={{ display: 'none' }} disabled={assetUploading} onChange={uploadWorkspaceContextAsset}/>
                          </label>
                        </div>
                        <p className="ws-empty u-dim">Select an asset to preview or download it.</p>
                      </>
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
                        <span>{run.filesConsidered || 0} item{run.filesConsidered === 1 ? '' : 's'}</span>
                      </div>
                      {run.summary ? (
                        <WorkspaceContextRunSummary
                          summary={run.summary}
                          files={files}
                          references={references}
                          assets={assets}
                          contextDir={contextDir}
                          referencesDir={referencesDir}
                          assetsDir={assetsDir}
                          onOpenMaterial={openWorkspaceContextMaterialFromRun}
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
                <p className="ws-empty u-dim">Clear context, references, assets, and run history. Workspace enablement and processor settings stay in place.</p>
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
