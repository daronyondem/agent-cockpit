/* global React, Ico, AgentApi, Tip, useDialog, useToasts */

/* ---------- WorkspaceSettingsPage — per-workspace settings screen. ---------- */
/* Opens from the gear button in the sidebar workspace action buttons.
   Four tabs:
     - Instructions: free-form system-prompt prefix (Save button).
     - Memory: enable toggle (immediate-save) + searchable, lifecycle-filtered
       grouped browser with per-file delete and a "Clear all" footer. Refetches
       snapshot after each mutation.
     - Knowledge Base: enable toggle (immediate-save). Full KB management lives
       in the dedicated KB Browser screen.
     - Context Map: enable toggle (immediate-save), workspace processor overrides,
       active-map browsing, and needs-attention items.
   Reuses the same full-screen `settings-shell` structure as global Settings. */

const WS_SETTINGS_TABS = [
  { id: 'instructions', label: 'Instructions' },
  { id: 'memory',       label: 'Memory' },
  { id: 'kb',           label: 'Knowledge Base' },
  { id: 'contextMap',   label: 'Context Map' },
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

function activeWorkspaceCliProfiles(settings){
  return Array.isArray(settings && settings.cliProfiles)
    ? settings.cliProfiles.filter(p => p && !p.disabled)
    : [];
}

function workspaceProfileForBackend(profiles, backendId){
  if (!backendId) return null;
  return profiles.find(p => p.id === 'server-configured-' + backendId)
    || profiles.find(p => p.vendor === backendId)
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
    || (backends || []).find(b => b.id === profile.vendor)
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

function contextMapRunsFromReview(reviewOrRuns){
  if (Array.isArray(reviewOrRuns)) return reviewOrRuns;
  return Array.isArray(reviewOrRuns && reviewOrRuns.runs) ? reviewOrRuns.runs : [];
}

function nextContextMapInitialScanNotice(runs, previous){
  const latestRun = contextMapRunsFromReview(runs)[0] || null;
  if (!latestRun) return previous || null;
  if (latestRun.source !== 'initial_scan') return null;
  if (latestRun.status === 'running') return previous || 'rolling';
  if (latestRun.status === 'completed') return previous ? 'completed' : null;
  return null;
}

function contextMapPayloadLabel(value){
  if (Array.isArray(value)) {
    return value.map(contextMapPayloadLabel).filter(Boolean).join(', ');
  }
  if (value && typeof value === 'object') {
    const objectValue = value.name || value.title || value.id || value.entityId || value.relationshipId || value.targetId || '';
    return objectValue == null ? '' : String(objectValue);
  }
  return value == null ? '' : String(value);
}

function contextMapFirstPayloadValue(payload, keys){
  for (const key of keys) {
    const label = contextMapPayloadLabel(payload && payload[key]);
    if (label) return label;
  }
  return '';
}

function contextMapCompactLabel(value, fallback){
  const text = contextMapPayloadLabel(value) || fallback || 'Unknown';
  return text.length > 54 ? text.slice(0, 51) + '...' : text;
}

function contextMapPayloadChangeList(payload){
  const fields = [];
  [
    ['newName', 'name'],
    ['updatedName', 'name'],
    ['newTypeSlug', 'type'],
    ['updatedTypeSlug', 'type'],
    ['status', 'status'],
    ['sensitivity', 'sensitivity'],
    ['summaryMarkdown', 'summary'],
    ['notesMarkdown', 'notes'],
  ].forEach(([key, label]) => {
    if (payload && payload[key] != null && String(payload[key]).trim()) fields.push(label);
  });
  if (payload && Array.isArray(payload.aliases) && payload.aliases.length) fields.push('aliases');
  if (payload && Array.isArray(payload.facts) && payload.facts.length) fields.push('facts');
  return fields.length ? fields.join(', ') : 'fields';
}

function contextMapCandidateImpactPreview(candidate){
  const payload = (candidate && candidate.payload) || {};
  const type = (candidate && candidate.candidateType) || 'candidate';
  const entityName = contextMapFirstPayloadValue(payload, ['entityName', 'name', 'targetName', 'subjectName', 'objectName', 'entityId', 'targetEntityId']);
  const subjectName = contextMapFirstPayloadValue(payload, ['subjectName', 'subjectEntityName', 'sourceName', 'fromName', 'subjectEntityId']);
  const objectName = contextMapFirstPayloadValue(payload, ['objectName', 'objectEntityName', 'targetName', 'toName', 'objectEntityId']);
  const predicate = contextMapFirstPayloadValue(payload, ['predicate', 'relationship', 'relationshipType', 'label']);
  const relationship = contextMapFirstPayloadValue(payload, ['relationshipId', 'targetRelationshipId']);
  const targetKind = contextMapFirstPayloadValue(payload, ['targetKind', 'kind']);
  const targetId = contextMapFirstPayloadValue(payload, ['targetId', 'targetEntityId', 'entityId', 'factId', 'relationshipId', 'candidateId']);
  const sourceName = contextMapFirstPayloadValue(payload, ['sourceEntityName', 'sourceName', 'fromName', 'sourceEntityId']);
  const targetName = contextMapFirstPayloadValue(payload, ['targetEntityName', 'targetName', 'toName', 'targetEntityId']);

  if (type === 'new_relationship') {
    return {
      left: contextMapCompactLabel(subjectName, 'Subject'),
      edge: contextMapCompactLabel(predicate, 'relates_to'),
      right: contextMapCompactLabel(objectName, 'Object'),
      note: contextMapFirstPayloadValue(payload, ['evidenceMarkdown']) ? 'Evidence included' : '',
    };
  }
  if (type === 'relationship_update') {
    return {
      left: contextMapCompactLabel(relationship || subjectName, 'Relationship'),
      edge: 'updates edge',
      right: contextMapCompactLabel(predicate || objectName, 'relationship fields'),
      note: contextMapPayloadChangeList(payload),
    };
  }
  if (type === 'relationship_removal') {
    return {
      left: contextMapCompactLabel(relationship || subjectName, 'Relationship'),
      edge: 'supersedes',
      right: contextMapCompactLabel(objectName || predicate, 'existing edge'),
      note: 'Relationship history is retained',
    };
  }
  if (type === 'new_entity') {
    return {
      left: contextMapCompactLabel(contextMapFirstPayloadValue(payload, ['typeSlug', 'entityType', 'type']), 'entity'),
      edge: 'creates',
      right: contextMapCompactLabel(entityName, 'Entity'),
      note: contextMapFirstPayloadValue(payload, ['sensitivity']) || '',
    };
  }
  if (type === 'entity_update') {
    return {
      left: contextMapCompactLabel(entityName, 'Entity'),
      edge: 'updates',
      right: contextMapPayloadChangeList(payload),
      note: '',
    };
  }
  if (type === 'entity_merge') {
    return {
      left: contextMapCompactLabel(sourceName || contextMapFirstPayloadValue(payload, ['sourceEntityIds', 'sourceNames']), 'Source entities'),
      edge: 'merge into',
      right: contextMapCompactLabel(targetName || entityName, 'Target entity'),
      note: '',
    };
  }
  if (type === 'alias_addition') {
    return {
      left: contextMapCompactLabel(entityName, 'Entity'),
      edge: 'adds alias',
      right: contextMapCompactLabel(contextMapFirstPayloadValue(payload, ['alias', 'newAlias']), 'Alias'),
      note: '',
    };
  }
  if (type === 'sensitivity_classification') {
    return {
      left: contextMapCompactLabel(entityName, 'Entity'),
      edge: 'classifies as',
      right: contextMapCompactLabel(contextMapFirstPayloadValue(payload, ['sensitivity', 'classification']), 'sensitivity'),
      note: '',
    };
  }
  if (type === 'new_entity_type') {
    return {
      left: 'Type catalog',
      edge: 'adds',
      right: contextMapCompactLabel(contextMapFirstPayloadValue(payload, ['typeSlug', 'slug', 'type']), 'entity type'),
      note: '',
    };
  }
  if (type === 'evidence_link') {
    return {
      left: contextMapCompactLabel(targetKind, 'Target'),
      edge: 'links evidence',
      right: contextMapCompactLabel(targetId, 'Evidence target'),
      note: contextMapFirstPayloadValue(payload, ['sourceId', 'evidenceMarkdown']) || '',
    };
  }
  if (type === 'conflict_flag') {
    return {
      left: contextMapCompactLabel(targetKind, 'Target'),
      edge: 'flags',
      right: contextMapCompactLabel(targetId || entityName, 'Conflict'),
      note: contextMapFirstPayloadValue(payload, ['reason', 'summaryMarkdown']) || '',
    };
  }
  return {
    left: contextMapCompactLabel(type, 'Candidate'),
    edge: 'proposes',
    right: contextMapCompactLabel(entityName || predicate || targetId, 'Graph change'),
    note: '',
  };
}

function WorkspaceSettingsPage({ hash, label, initialTab, onOpenMemoryReview, onClose }){
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
  const [contextMapEnabled, setContextMapEnabled] = React.useState(false);
  const [contextMapSettings, setContextMapSettings] = React.useState({ processorMode: 'global' });
  const [contextMapSettingsDirty, setContextMapSettingsDirty] = React.useState(false);
  const [contextMapReview, setContextMapReview] = React.useState({ candidates: [], counts: {}, runs: [] });
  const [contextMapReviewStatus, setContextMapReviewStatus] = React.useState('pending');
  const [contextMapInitialScanNotice, setContextMapInitialScanNotice] = React.useState(null);
  const [contextMapGraph, setContextMapGraph] = React.useState({ entities: [], relationships: [], counts: {} });
  const [contextMapEntityDetail, setContextMapEntityDetail] = React.useState(null);
  const [contextMapEntityDetailLoading, setContextMapEntityDetailLoading] = React.useState(false);
  const [contextMapSelectedEntityId, setContextMapSelectedEntityId] = React.useState(null);
  const [contextMapGraphLoading, setContextMapGraphLoading] = React.useState(false);
  const [contextMapReviewLoading, setContextMapReviewLoading] = React.useState(false);
  const [contextMapCandidateBusy, setContextMapCandidateBusy] = React.useState(null);
  const [contextMapScanBusy, setContextMapScanBusy] = React.useState(false);
  const [contextMapStopBusy, setContextMapStopBusy] = React.useState(false);
  const [globalSettings, setGlobalSettings] = React.useState({});
  const [backends, setBackends] = React.useState([]);
  const [profileBackends, setProfileBackends] = React.useState({});
  const dialog = useDialog();
  const toast = useToasts();

  /* Load state on open. The endpoints are independent so we fire them
     in parallel; any failure flips the whole page into an error state since
     partial UI would be confusing. */
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
      AgentApi.workspace.getContextMapSettings(hash).catch(() => ({})),
      AgentApi.workspace.getContextMapReview(hash, 'pending').catch(() => ({ candidates: [], counts: {}, runs: [] })),
      AgentApi.workspace.getContextMapGraph(hash, { limit: 100 }).catch(() => ({ entities: [], relationships: [], counts: {} })),
      AgentApi.settings.get().catch(() => ({})),
      AgentApi.settings.backends().catch(() => ({ backends: [] })),
    ]).then(([instrRes, memRes, reviewScheduleRes, kbRes, contextMapRes, contextMapReviewRes, contextMapGraphRes, settingsRes, backendsRes]) => {
      if (cancelled) return;
      setInstructions(instrRes.instructions || '');
      setMemoryEnabled(!!memRes.enabled);
      setMemorySnapshot(memRes.snapshot || null);
      setMemoryReviewSchedule(reviewScheduleRes.schedule || { mode: 'off' });
      setMemoryReviewStatus(reviewScheduleRes.status || null);
      setReviewStarting(false);
      setKbEnabled(!!kbRes.enabled);
      setContextMapEnabled(!!contextMapRes.enabled);
      setContextMapSettings(contextMapRes.settings || { processorMode: 'global' });
      setContextMapSettingsDirty(false);
      setContextMapReview(contextMapReviewRes || { candidates: [], counts: {}, runs: [] });
      setContextMapReviewStatus('pending');
      setContextMapInitialScanNotice(prev => nextContextMapInitialScanNotice(contextMapRunsFromReview(contextMapReviewRes), prev));
      setContextMapGraph(contextMapGraphRes || { entities: [], relationships: [], counts: {} });
      setContextMapEntityDetail(null);
      setContextMapEntityDetailLoading(false);
      setContextMapSelectedEntityId(null);
      setContextMapReviewLoading(false);
      setContextMapGraphLoading(false);
      setContextMapCandidateBusy(null);
      setContextMapScanBusy(false);
      setContextMapStopBusy(false);
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
    if (contextMapInitialScanNotice !== 'started') return undefined;
    const timer = window.setTimeout(() => {
      setContextMapInitialScanNotice(prev => prev === 'started' ? 'rolling' : prev);
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [contextMapInitialScanNotice]);

  React.useEffect(() => {
    if (!hash) return;
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
    const onContextMapUpdate = (event) => {
      if (!event || !event.detail || event.detail.hash !== hash) return;
      const status = contextMapReviewStatus || 'pending';
      const nextContextMap = event.detail.contextMap || null;
      if (nextContextMap && typeof nextContextMap.enabled === 'boolean') {
        setContextMapEnabled(nextContextMap.enabled);
      }
      if (nextContextMap && nextContextMap.latestRunSource === 'initial_scan') {
        if (nextContextMap.latestRunStatus === 'running') {
          setContextMapInitialScanNotice(prev => prev || 'rolling');
        } else if (nextContextMap.latestRunStatus === 'completed') {
          setContextMapInitialScanNotice(prev => prev ? 'completed' : prev);
        }
      }
      if (nextContextMap && nextContextMap.latestRunStatus !== 'running') {
        setContextMapStopBusy(false);
      }
      Promise.all([
        AgentApi.workspace.getContextMapReview(hash, status).catch(() => ({ candidates: [], counts: {}, runs: [] })),
        AgentApi.workspace.getContextMapGraph(hash, { limit: 100 }).catch(() => ({ entities: [], relationships: [], counts: {} })),
      ]).then(([reviewRes, graphRes]) => {
        if (cancelled) return;
        setContextMapReview(reviewRes || { candidates: [], counts: {}, runs: [] });
        setContextMapInitialScanNotice(prev => nextContextMapInitialScanNotice(contextMapRunsFromReview(reviewRes), prev));
        setContextMapGraph(graphRes || { entities: [], relationships: [], counts: {} });
      }).catch(() => {
        // Best-effort live refresh; manual refresh keeps the canonical fallback.
      });
    };
    window.addEventListener('ac:context-map-update', onContextMapUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener('ac:context-map-update', onContextMapUpdate);
    };
  }, [hash, contextMapReviewStatus]);

  React.useEffect(() => {
    if (!hash || tab !== 'contextMap') return undefined;
    const runs = contextMapRunsFromReview(contextMapReview);
    const running = runs.some(run => run && run.status === 'running');
    const waitingForInitialScan = contextMapInitialScanNotice === 'started' || contextMapInitialScanNotice === 'rolling';
    if (!running && !waitingForInitialScan) return undefined;
    let cancelled = false;
    const refresh = () => {
      AgentApi.workspace.getContextMapReview(hash, contextMapReviewStatus || 'pending').then((reviewRes) => {
        if (cancelled) return;
        setContextMapReview(reviewRes || { candidates: [], counts: {}, runs: [] });
        const nextRuns = contextMapRunsFromReview(reviewRes);
        setContextMapInitialScanNotice(prev => nextContextMapInitialScanNotice(nextRuns, prev));
        if (!nextRuns.some(run => run && run.status === 'running')) {
          setContextMapStopBusy(false);
        }
      }).catch(() => {
        // Best-effort status refresh; explicit actions still surface errors.
      });
    };
    const timer = setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hash, tab, contextMapReviewStatus, contextMapReview && contextMapReview.runs, contextMapInitialScanNotice]);

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
      }).catch(() => {
        // Best-effort status refresh; explicit actions still surface errors.
      });
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

  async function toggleContextMap(enabled){
    const prev = contextMapEnabled;
    setContextMapEnabled(enabled);
    if (!enabled) {
      setContextMapInitialScanNotice(null);
      setContextMapEntityDetail(null);
      setContextMapSelectedEntityId(null);
    }
    try {
      const res = await AgentApi.workspace.setContextMapEnabled(hash, enabled);
      if (enabled && res && res.initialScanStarted) {
        setContextMapInitialScanNotice('started');
      }
      const reviewRes = await refreshContextMapReview();
      if (enabled && res && res.initialScanStarted) {
        const latestContextMapRun = Array.isArray(reviewRes && reviewRes.runs) ? reviewRes.runs[0] : null;
        if (latestContextMapRun && latestContextMapRun.source === 'initial_scan' && latestContextMapRun.status === 'completed') {
          setContextMapInitialScanNotice('completed');
        }
      }
      await refreshContextMapGraph();
    } catch (err) {
      setContextMapEnabled(prev);
      setContextMapInitialScanNotice(null);
      dialog.alert({
        variant: 'error',
        title: 'Failed to update Context Map setting',
        body: err.message || String(err),
      });
    }
  }

  async function refreshContextMapReview(status = contextMapReviewStatus){
    setContextMapReviewLoading(true);
    try {
      const res = await AgentApi.workspace.getContextMapReview(hash, status);
      setContextMapReview(res || { candidates: [], counts: {}, runs: [] });
      setContextMapInitialScanNotice(prev => nextContextMapInitialScanNotice(contextMapRunsFromReview(res), prev));
      return res || { candidates: [], counts: {}, runs: [] };
    } catch (err) {
      dialog.alert({
        variant: 'error',
        title: 'Failed to refresh Context Map review',
        body: err.message || String(err),
      });
      return null;
    } finally {
      setContextMapReviewLoading(false);
    }
  }

  async function changeContextMapReviewStatus(status){
    if (status === contextMapReviewStatus) return;
    setContextMapReviewStatus(status);
    await refreshContextMapReview(status);
  }

  async function refreshContextMapGraph(opts){
    setContextMapGraphLoading(true);
    try {
      const res = await AgentApi.workspace.getContextMapGraph(hash, { limit: 100, ...(opts || {}) });
      setContextMapGraph(res || { entities: [], relationships: [], counts: {} });
    } catch (err) {
      dialog.alert({
        variant: 'error',
        title: 'Failed to refresh Context Map',
        body: err.message || String(err),
      });
    } finally {
      setContextMapGraphLoading(false);
    }
  }

  async function loadContextMapEntity(entityId, anchor){
    if (!entityId) return;
    setContextMapSelectedEntityId(entityId);
    setContextMapEntityDetailLoading(true);
    setContextMapEntityDetail(prev => prev && prev.entityId === entityId ? prev : null);
    try {
      const res = await AgentApi.workspace.getContextMapEntity(hash, entityId);
      setContextMapEntityDetail((res && res.entity) || null);
    } catch (err) {
      setContextMapSelectedEntityId(null);
      dialog.alert({
        anchor,
        variant: 'error',
        title: 'Entity detail failed',
        body: err.message || String(err),
      });
    } finally {
      setContextMapEntityDetailLoading(false);
    }
  }

  async function updateContextMapEntity(entityId, patch, anchor){
    if (!entityId) return null;
    try {
      const res = await AgentApi.workspace.updateContextMapEntity(hash, entityId, patch || {});
      const entity = (res && res.entity) || null;
      if (entity) {
        setContextMapEntityDetail(entity);
        setContextMapGraph(prev => ({
          ...(prev || { entities: [], relationships: [], counts: {} }),
          entities: Array.isArray(prev && prev.entities)
            ? prev.entities.map(row => row.entityId === entity.entityId ? { ...row, ...entity } : row)
            : [],
        }));
      }
      toast.success('Context Map entity updated');
      return entity;
    } catch (err) {
      await dialog.alert({
        anchor,
        variant: 'error',
        title: 'Failed to update Context Map entity',
        body: err.message || String(err),
      });
      return null;
    }
  }

  async function runContextMapScan(anchor){
    if (contextMapScanBusy) return;
    setContextMapScanBusy(true);
    try {
      const res = await AgentApi.workspace.runContextMapScan(hash);
      setContextMapReviewStatus('pending');
      await refreshContextMapReview('pending');
      await refreshContextMapGraph();
      if (res && res.started) setContextMapInitialScanNotice(prev => prev || 'rolling');
      toast.success(res && res.started ? 'Context Map scan started' : 'Context Map scan requested');
    } catch (err) {
      dialog.alert({
        anchor,
        variant: 'error',
        title: 'Scan failed',
        body: err.message || String(err),
      });
    } finally {
      setContextMapScanBusy(false);
    }
  }

  async function stopContextMapScan(anchor){
    if (contextMapStopBusy) return;
    setContextMapStopBusy(true);
    try {
      await AgentApi.workspace.stopContextMapScan(hash);
      setContextMapInitialScanNotice(null);
      await refreshContextMapReview(contextMapReviewStatus || 'pending');
      toast.success('Context Map scan stopped');
    } catch (err) {
      dialog.alert({
        anchor,
        variant: 'error',
        title: 'Stop scan failed',
        body: err.message || String(err),
      });
    } finally {
      setContextMapStopBusy(false);
    }
  }

  async function clearContextMap(anchor){
    if (contextMapScanBusy || contextMapCandidateBusy) return;
    const ok = await dialog.confirm({
      anchor,
      title: 'Clear Context Map',
      body: 'Clear all Context Map entities, relationships, candidates, runs, and evidence for this workspace? The workspace setting will stay unchanged.',
      confirmLabel: 'Clear map',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    setContextMapScanBusy(true);
    try {
      await AgentApi.workspace.clearContextMap(hash);
      setContextMapGraph({ entities: [], relationships: [], counts: {} });
      setContextMapReview({ candidates: [], counts: {}, runs: [] });
      setContextMapInitialScanNotice(null);
      setContextMapEntityDetail(null);
      setContextMapSelectedEntityId(null);
      toast.success('Context Map cleared');
    } catch (err) {
      dialog.alert({
        anchor,
        variant: 'error',
        title: 'Clear failed',
        body: err.message || String(err),
      });
    } finally {
      setContextMapScanBusy(false);
    }
  }

  async function updateContextMapCandidate(candidateId, payloadText, confidenceText, anchor){
    if (!candidateId || contextMapCandidateBusy) return false;
    let payload;
    try {
      payload = JSON.parse(payloadText || '{}');
    } catch (err) {
      dialog.alert({
        anchor,
        variant: 'error',
        title: 'Invalid candidate JSON',
        body: err.message || String(err),
      });
      return false;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      dialog.alert({
        anchor,
        variant: 'error',
        title: 'Invalid candidate JSON',
        body: 'Candidate payload must be a JSON object.',
      });
      return false;
    }
    const confidence = confidenceText === '' ? undefined : Number(confidenceText);
    if (confidence !== undefined && !Number.isFinite(confidence)) {
      dialog.alert({
        anchor,
        variant: 'error',
        title: 'Invalid confidence',
        body: 'Confidence must be a number between 0 and 1.',
      });
      return false;
    }
    setContextMapCandidateBusy(candidateId);
    try {
      await AgentApi.workspace.updateContextMapCandidate(hash, candidateId, { payload, confidence });
      await refreshContextMapReview();
      toast.success('Context Map item updated');
      return true;
    } catch (err) {
      dialog.alert({
        anchor,
        variant: 'error',
        title: 'Update failed',
        body: err.message || String(err),
      });
      return false;
    } finally {
      setContextMapCandidateBusy(null);
    }
  }

  async function discardContextMapCandidate(candidateId, anchor){
    if (!candidateId || contextMapCandidateBusy) return;
    const ok = await dialog.confirm({
      anchor,
      title: 'Dismiss candidate',
      body: 'Dismiss this Context Map item? Nothing will be applied to the map.',
      confirmLabel: 'Dismiss',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    setContextMapCandidateBusy(candidateId);
    try {
      await AgentApi.workspace.discardContextMapCandidate(hash, candidateId);
      await refreshContextMapReview();
    } catch (err) {
      dialog.alert({
        variant: 'error',
        title: 'Dismiss failed',
        body: err.message || String(err),
      });
    } finally {
      setContextMapCandidateBusy(null);
    }
  }

  async function applyContextMapCandidate(candidateId, anchor){
    if (!candidateId || contextMapCandidateBusy) return;
    setContextMapCandidateBusy(candidateId);
    try {
      const res = await AgentApi.workspace.applyContextMapCandidate(hash, candidateId);
      await refreshContextMapReview();
      await refreshContextMapGraph();
      const count = contextMapAppliedItemCount(res);
      toast.success(count > 1 ? `Applied ${count} Context Map items` : (count > 0 ? 'Context Map item applied' : 'Context Map item already applied'));
    } catch (err) {
      const dependencies = Array.isArray(err && err.body && err.body.dependencies) ? err.body.dependencies : [];
      if (err && err.status === 409 && dependencies.length > 0) {
        const ok = await dialog.confirm({
          anchor,
          title: 'Apply related Context Map items?',
          body: (
            <div className="ws-cm-dependency-confirm">
          <p>This relationship cannot be added by itself because one or both endpoint entities still need attention.</p>
          <p>Agent Cockpit will apply only the entity items below first, then apply this relationship. Other needs-attention, dismissed, and active items will not be changed.</p>
              <ul className="ws-cm-dependency-list">
                {dependencies.map(dep => (
                  <li key={dep.candidateId}>
                    <b>{dep.role === 'subject' ? 'Subject' : 'Object'}:</b>
                    {' '}{dep.name || dep.candidateId}
                    {dep.typeSlug ? <span> · {dep.typeSlug}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ),
          confirmLabel: `Apply ${dependencies.length + 1} items`,
          cancelLabel: 'Inspect manually',
        });
        if (ok) {
          try {
            const res = await AgentApi.workspace.applyContextMapCandidate(hash, candidateId, { includeDependencies: true });
            await refreshContextMapReview();
            await refreshContextMapGraph();
            const count = contextMapAppliedItemCount(res);
            toast.success(count > 1 ? `Applied ${count} Context Map items` : 'Context Map item applied');
          } catch (applyErr) {
            dialog.alert({
              anchor,
              variant: 'error',
              title: 'Apply failed',
              body: applyErr.message || String(applyErr),
            });
          }
        }
        return;
      }
      dialog.alert({
        anchor,
        variant: 'error',
        title: 'Apply failed',
        body: err.message || String(err),
      });
    } finally {
      setContextMapCandidateBusy(null);
    }
  }

  async function applyAllContextMapCandidates(anchor){
    if (contextMapCandidateBusy) return;
    const ok = await dialog.confirm({
      anchor,
      title: 'Accept all Context Map suggestions',
      body: 'Apply every pending Context Map suggestion. Dismissed suggestions will stay dismissed. Entity suggestions are applied before relationships so relationship endpoints can resolve cleanly.',
      confirmLabel: 'Accept all',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    setContextMapCandidateBusy('__all__');
    try {
      const reviewRes = await AgentApi.workspace.getContextMapReview(hash, 'pending');
      const candidates = Array.isArray(reviewRes && reviewRes.candidates) ? reviewRes.candidates : [];
      const pending = candidates
        .filter(candidate => candidate && candidate.status === 'pending')
        .sort(compareContextMapCandidateApplyOrder);
      if (!pending.length) {
        await refreshContextMapReview(contextMapReviewStatus || 'pending');
        toast.success('No Context Map suggestions to apply');
        return;
      }
      let appliedCount = 0;
      for (const candidate of pending) {
        try {
          const res = await AgentApi.workspace.applyContextMapCandidate(hash, candidate.candidateId);
          appliedCount += contextMapAppliedItemCount(res);
        } catch (err) {
          const dependencies = Array.isArray(err && err.body && err.body.dependencies) ? err.body.dependencies : [];
          if (err && err.status === 409 && dependencies.length > 0) {
            const res = await AgentApi.workspace.applyContextMapCandidate(hash, candidate.candidateId, { includeDependencies: true });
            appliedCount += contextMapAppliedItemCount(res);
            continue;
          }
          throw err;
        }
      }
      await refreshContextMapReview(contextMapReviewStatus || 'pending');
      await refreshContextMapGraph();
      toast.success(appliedCount > 1 ? `Applied ${appliedCount} Context Map items` : 'Context Map suggestions accepted');
    } catch (err) {
      await refreshContextMapReview(contextMapReviewStatus || 'pending');
      await refreshContextMapGraph();
      dialog.alert({
        anchor,
        variant: 'error',
        title: 'Accept all failed',
        body: err.message || String(err),
      });
    } finally {
      setContextMapCandidateBusy(null);
    }
  }

  function contextMapAppliedItemCount(res){
    const primaryApplied = Array.isArray(res && res.applied) && res.applied.length > 0 ? 1 : 0;
    const dependencyCount = Array.isArray(res && res.dependenciesApplied) ? res.dependenciesApplied.length : 0;
    return primaryApplied + dependencyCount;
  }

  function compareContextMapCandidateApplyOrder(a, b){
    const pa = contextMapCandidateApplyPriority(a && a.candidateType);
    const pb = contextMapCandidateApplyPriority(b && b.candidateType);
    if (pa !== pb) return pa - pb;
    return String(a && a.candidateId || '').localeCompare(String(b && b.candidateId || ''));
  }

  function contextMapCandidateApplyPriority(type){
    if (type === 'new_entity') return 10;
    if (type === 'entity_update' || type === 'entity_merge' || type === 'alias_addition' || type === 'sensitivity_classification') return 20;
    if (type === 'evidence_link') return 30;
    if (type === 'new_relationship') return 80;
    if (type === 'relationship_update' || type === 'relationship_removal') return 90;
    return 50;
  }

  async function reopenContextMapCandidate(candidateId){
    if (!candidateId || contextMapCandidateBusy) return;
    setContextMapCandidateBusy(candidateId);
    try {
      await AgentApi.workspace.reopenContextMapCandidate(hash, candidateId);
      await refreshContextMapReview();
    } catch (err) {
      dialog.alert({
        variant: 'error',
        title: 'Restore failed',
        body: err.message || String(err),
      });
    } finally {
      setContextMapCandidateBusy(null);
    }
  }

  function patchContextMapSettings(patch){
    setContextMapSettings(prev => ({ ...(prev || { processorMode: 'global' }), ...patch }));
    setContextMapSettingsDirty(true);
  }

  async function saveContextMapSettings(anchor){
    if (saving) return;
    setSaving(true);
    try {
      const res = await AgentApi.workspace.setContextMapSettings(hash, contextMapSettings || { processorMode: 'global' });
      setContextMapSettings(res.settings || contextMapSettings || { processorMode: 'global' });
      setContextMapSettingsDirty(false);
      toast.success('Context Map settings saved');
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
            className={`settings-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >{t.label}</div>
        ))}
      </div>

      <div className="settings-body workspace-settings-body">
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
        ) : tab === 'contextMap' ? (
          <ContextMapTab
            enabled={contextMapEnabled}
            settings={contextMapSettings}
            review={contextMapReview}
            initialScanNotice={contextMapInitialScanNotice}
            graph={contextMapGraph}
            entityDetail={contextMapEntityDetail}
            entityDetailLoading={contextMapEntityDetailLoading}
            selectedEntityId={contextMapSelectedEntityId}
            graphLoading={contextMapGraphLoading}
            reviewLoading={contextMapReviewLoading}
            reviewStatus={contextMapReviewStatus}
            candidateBusy={contextMapCandidateBusy}
            scanBusy={contextMapScanBusy}
            scanStopping={contextMapStopBusy}
            globalSettings={globalSettings}
            backends={backends}
            profileBackends={profileBackends}
            loadProfileBackend={loadProfileBackend}
            onToggle={toggleContextMap}
            onPatch={patchContextMapSettings}
            onSave={saveContextMapSettings}
            onRefreshReview={refreshContextMapReview}
            onReviewStatusChange={changeContextMapReviewStatus}
            onRefreshGraph={refreshContextMapGraph}
            onSelectEntity={loadContextMapEntity}
            onUpdateEntity={updateContextMapEntity}
            onCloseEntityDetail={() => {
              setContextMapEntityDetail(null);
              setContextMapSelectedEntityId(null);
            }}
            onRunScan={runContextMapScan}
            onStopScan={stopContextMapScan}
            onClearMap={clearContextMap}
            onUpdateCandidate={updateContextMapCandidate}
            onApplyCandidate={applyContextMapCandidate}
            onApplyAllCandidates={applyAllContextMapCandidates}
            onDiscardCandidate={discardContextMapCandidate}
            onReopenCandidate={reopenContextMapCandidate}
            settingsDirty={contextMapSettingsDirty}
            saving={saving}
          />
        ) : null}
      </div>
    </div>
  );
}
window.WorkspaceSettingsPage = WorkspaceSettingsPage;

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

function WorkspaceSettingsHelpTooltip({ children }){
  return (
    <div className="tt-section settings-help-tooltip">
      <div className="tt-body-text">{children}</div>
    </div>
  );
}

function ContextMapTab({
  enabled,
  settings,
  review,
  initialScanNotice,
  graph,
  entityDetail,
  entityDetailLoading,
  selectedEntityId,
  graphLoading,
  reviewLoading,
  reviewStatus,
  candidateBusy,
  scanBusy,
  scanStopping,
  globalSettings,
  backends,
  profileBackends,
  loadProfileBackend,
  onToggle,
  onPatch,
  onSave,
  onRefreshReview,
  onReviewStatusChange,
  onRefreshGraph,
  onSelectEntity,
  onUpdateEntity,
  onCloseEntityDetail,
  onRunScan,
  onStopScan,
  onClearMap,
  onUpdateCandidate,
  onApplyCandidate,
  onApplyAllCandidates,
  onDiscardCandidate,
  onReopenCandidate,
  settingsDirty,
  saving,
}){
  const contextMapTopRef = React.useRef(null);
  const contextMapContentRef = React.useRef(null);
  const ctx = settings || { processorMode: 'global' };
  const globalContext = (globalSettings && globalSettings.contextMap) || {};
  const profiles = activeWorkspaceCliProfiles(globalSettings);
  const fallbackBackend = globalContext.cliBackend || (globalSettings && globalSettings.defaultBackend) || (backends[0] && backends[0].id) || '';
  const mode = ctx.processorMode === 'override' ? 'override' : 'global';
  const globalProfile = workspaceProfileForSetting(profiles, globalContext.cliProfileId, globalContext.cliBackend, fallbackBackend);
  const selectedProfile = mode === 'override'
    ? workspaceProfileForSetting(profiles, ctx.cliProfileId, ctx.cliBackend, fallbackBackend)
    : globalProfile;
  React.useEffect(() => {
    if (selectedProfile && loadProfileBackend) loadProfileBackend(selectedProfile.id);
  }, [selectedProfile && selectedProfile.id, loadProfileBackend]);

  const models = selectedProfile ? workspaceModelsForProfile(backends, profileBackends, selectedProfile) : [];
  const modelId = (mode === 'override' ? ctx.cliModel : globalContext.cliModel) || workspaceDefaultModelId(models) || '';
  const efforts = selectedProfile ? workspaceEffortLevelsForProfile(backends, profileBackends, selectedProfile, modelId) : [];
  const effort = (mode === 'override' ? ctx.cliEffort : globalContext.cliEffort) || workspaceDefaultEffort(efforts) || '';
  const candidates = Array.isArray(review && review.candidates) ? review.candidates : [];
  const pendingCount = (review && review.counts && review.counts.pending) || 0;
  const discardedCount = (review && review.counts && review.counts.discarded) || 0;
  const contextMapRuns = Array.isArray(review && review.runs) ? review.runs : [];
  const latestContextMapRun = contextMapRuns[0] || null;
  const runningContextMapRun = contextMapRuns.find(run => run && run.status === 'running') || null;
  const currentReviewStatus = reviewStatus || 'pending';
  const activeGraph = graph || { entities: [], relationships: [], counts: {} };
  const activeEntities = Array.isArray(activeGraph.entities) ? activeGraph.entities : [];
  const activeRelationships = Array.isArray(activeGraph.relationships) ? activeGraph.relationships : [];
  const activeCounts = activeGraph.counts || {};
  const [graphQuery, setGraphQuery] = React.useState('');
  const [graphType, setGraphType] = React.useState('');
  const [graphStatus, setGraphStatus] = React.useState('active');
  const [graphSensitivity, setGraphSensitivity] = React.useState('');
  const [editingCandidateId, setEditingCandidateId] = React.useState(null);
  const [candidateEditPayload, setCandidateEditPayload] = React.useState('');
  const [candidateEditConfidence, setCandidateEditConfidence] = React.useState('');
  const [editingEntity, setEditingEntity] = React.useState(false);
  const [entityEditDraft, setEntityEditDraft] = React.useState(null);
  const [entityEditSaving, setEntityEditSaving] = React.useState(false);
  const [contextMapSection, setContextMapSection] = React.useState('overview');

  React.useEffect(() => {
    setEditingEntity(false);
    setEntityEditDraft(null);
  }, [entityDetail && entityDetail.entityId]);

  React.useEffect(() => {
    if (!entityDetail && !entityDetailLoading) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onCloseEntityDetail();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [entityDetail && entityDetail.entityId, entityDetailLoading, onCloseEntityDetail]);

  function scrollContextMapTopIntoView(){
    const contentNode = contextMapContentRef.current;
    const node = contextMapTopRef.current;
    if (!contentNode && !node) return;
    window.requestAnimationFrame(() => {
      if (contentNode && typeof contentNode.scrollTo === 'function') {
        contentNode.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (node) {
        node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  async function runScanFromContextMap(anchor){
    setContextMapSection('overview');
    scrollContextMapTopIntoView();
    try {
      await onRunScan(anchor);
    } finally {
      scrollContextMapTopIntoView();
    }
  }

  function editableCandidatePayload(candidate){
    const payload = Object.assign({}, (candidate && candidate.payload) || {});
    delete payload.sourceSpan;
    return payload;
  }

  function beginCandidateEdit(candidate){
    setEditingCandidateId(candidate.candidateId);
    setCandidateEditPayload(JSON.stringify(editableCandidatePayload(candidate), null, 2));
    setCandidateEditConfidence(String(candidate.confidence ?? 1));
  }

  function cancelCandidateEdit(){
    setEditingCandidateId(null);
    setCandidateEditPayload('');
    setCandidateEditConfidence('');
  }

  async function saveCandidateEdit(candidate, anchor){
    const ok = await onUpdateCandidate(
      candidate.candidateId,
      candidateEditPayload,
      candidateEditConfidence,
      anchor,
    );
    if (ok) cancelCandidateEdit();
  }

  function refreshGraphWithFilters(){
    onRefreshGraph({
      query: graphQuery.trim(),
      type: graphType,
      status: graphStatus,
      sensitivity: graphSensitivity,
    });
  }

  function clearGraphFilters(){
    setGraphQuery('');
    setGraphType('');
    setGraphStatus('active');
    setGraphSensitivity('');
    onRefreshGraph({ query: '', type: '', status: 'active', sensitivity: '' });
  }

  function beginEntityEdit(entity){
    setEditingEntity(true);
    setEntityEditDraft({
      name: entity.name || '',
      typeSlug: entity.typeSlug || 'project',
      status: entity.status || 'active',
      sensitivity: entity.sensitivity || 'normal',
      confidence: String(entity.confidence ?? 1),
      summaryMarkdown: entity.summaryMarkdown || '',
      notesMarkdown: entity.notesMarkdown || '',
    });
  }

  function patchEntityEdit(patch){
    setEntityEditDraft(prev => ({ ...(prev || {}), ...patch }));
  }

  async function saveEntityEdit(anchor){
    if (!entityDetail || !entityEditDraft || entityEditSaving) return;
    const confidence = Number(entityEditDraft.confidence);
    setEntityEditSaving(true);
    try {
      const entity = await onUpdateEntity(entityDetail.entityId, {
        name: entityEditDraft.name,
        typeSlug: entityEditDraft.typeSlug,
        status: entityEditDraft.status,
        sensitivity: entityEditDraft.sensitivity,
        confidence: Number.isFinite(confidence) ? confidence : entityDetail.confidence,
        summaryMarkdown: entityEditDraft.summaryMarkdown || null,
        notesMarkdown: entityEditDraft.notesMarkdown || null,
      }, anchor);
      if (entity) {
        setEditingEntity(false);
        setEntityEditDraft(null);
        refreshGraphWithFilters();
      }
    } finally {
      setEntityEditSaving(false);
    }
  }

  function onModeChange(nextMode){
    if (nextMode === 'global') {
      onPatch({
        processorMode: 'global',
        cliProfileId: undefined,
        cliBackend: undefined,
        cliModel: undefined,
        cliEffort: undefined,
        scanIntervalMinutes: undefined,
      });
    } else {
      if (selectedProfile) {
        const m = workspaceModelsForProfile(backends, profileBackends, selectedProfile);
        const newModel = workspaceDefaultModelId(m);
        const e = workspaceEffortLevelsForProfile(backends, profileBackends, selectedProfile, newModel);
        onPatch({
          processorMode: 'override',
          cliProfileId: selectedProfile.id,
          cliBackend: selectedProfile.vendor,
          cliModel: newModel,
          cliEffort: workspaceDefaultEffort(e),
        });
      } else {
        onPatch({ processorMode: 'override' });
      }
    }
  }

  function onProfileChange(v){
    const profile = profiles.find(p => p.id === v);
    if (!profile) return;
    const m = workspaceModelsForProfile(backends, profileBackends, profile);
    const newModel = workspaceDefaultModelId(m);
    const e = workspaceEffortLevelsForProfile(backends, profileBackends, profile, newModel);
    onPatch({
      processorMode: 'override',
      cliProfileId: profile.id,
      cliBackend: profile.vendor,
      cliModel: newModel,
      cliEffort: workspaceDefaultEffort(e),
    });
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
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return;
    onPatch({ scanIntervalMinutes: Math.max(1, Math.min(1440, n)) });
  }

  function candidateTitle(candidate){
    const payload = (candidate && candidate.payload) || {};
    const value = payload.name || payload.title || payload.subjectName || payload.typeSlug || (candidate && candidate.candidateType);
    return value == null ? 'Candidate' : String(value);
  }

  function candidateSummary(candidate){
    const payload = Object.assign({}, (candidate && candidate.payload) || {});
    delete payload.sourceSpan;
    const text = JSON.stringify(payload);
    return text.length > 220 ? text.slice(0, 220) + '...' : text;
  }

  function statusLabel(status){
    if (status === 'pending') return 'Needs attention';
    if (status === 'discarded') return 'Dismissed';
    if (status === 'active') return 'Applied';
    if (status === 'stale') return 'Stale';
    if (status === 'conflict') return 'Conflict';
    if (status === 'failed') return 'Failed';
    if (status === 'stopped') return 'Stopped';
    return status || 'Unknown';
  }

  function runSourceLabel(source){
    if (source === 'initial_scan') return 'Initial scan';
    if (source === 'manual_rebuild') return 'Manual scan';
    if (source === 'session_reset') return 'Session reset';
    if (source === 'archive') return 'Archive';
    if (source === 'scheduled') return 'Scheduled';
    return source || 'Scan';
  }

  function shortCandidateId(value){
    const text = value == null ? '' : String(value);
    return text.length > 10 ? text.slice(0, 10) : text;
  }

  function candidateSourceParts(candidate){
    const sourceSpan = candidate && candidate.payload && candidate.payload.sourceSpan;
    if (!sourceSpan) {
      return {
        key: 'unknown',
        label: 'Unknown source',
        meta: candidate && candidate.runId ? `Run ${shortCandidateId(candidate.runId)}` : '',
      };
    }
    const sourceType = sourceSpan.sourceType || 'source';
    if (sourceType === 'file') {
      const sourceId = sourceSpan.sourceId || (sourceSpan.locator && sourceSpan.locator.path) || 'file';
      return {
        key: `file:${sourceId}:${sourceSpan.runId || ''}`,
        label: `File · ${sourceId}`,
        meta: sourceSpan.runId ? `Run ${shortCandidateId(sourceSpan.runId)}` : '',
      };
    }
    if (sourceType === 'workspace_instruction') {
      return {
        key: `workspace_instruction:${sourceSpan.sourceId || 'workspace'}:${sourceSpan.runId || ''}`,
        label: 'Workspace instructions',
        meta: sourceSpan.runId ? `Run ${shortCandidateId(sourceSpan.runId)}` : '',
      };
    }
    if (sourceType === 'conversation_message') {
      const conversationId = sourceSpan.conversationId || 'conversation';
      const range = sourceSpan.startMessageId && sourceSpan.endMessageId
        ? `${sourceSpan.startMessageId} -> ${sourceSpan.endMessageId}`
        : '';
      return {
        key: `conversation:${conversationId}:${sourceSpan.spanId || ''}`,
        label: `Conversation · ${shortCandidateId(conversationId)}`,
        meta: range,
      };
    }
    return {
      key: `${sourceType}:${sourceSpan.sourceId || sourceSpan.runId || 'source'}`,
      label: sourceType,
      meta: sourceSpan.runId ? `Run ${shortCandidateId(sourceSpan.runId)}` : '',
    };
  }

  function groupContextMapCandidates(items){
    const groups = [];
    const byKey = new Map();
    items.forEach(candidate => {
      const parts = candidateSourceParts(candidate);
      let group = byKey.get(parts.key);
      if (!group) {
        group = { key: parts.key, label: parts.label, meta: parts.meta, items: [] };
        byKey.set(parts.key, group);
        groups.push(group);
      }
      group.items.push(candidate);
    });
    return groups;
  }

  function entitySummary(entity){
    return entity.summaryMarkdown || entity.notesMarkdown || (Array.isArray(entity.facts) && entity.facts[0]) || '';
  }

  function entityMatchesGraphText(entity, text){
    if (!text) return false;
    const fields = [
      entity && entity.name,
      entity && entity.typeSlug,
      ...(Array.isArray(entity && entity.aliases) ? entity.aliases : []),
    ];
    return fields.some(value => String(value || '').toLowerCase().includes(text));
  }

  const graphTypeOptions = Array.from(new Set([
    'person',
    'organization',
    'project',
    'workflow',
    'document',
    'feature',
    'concept',
    'decision',
    'tool',
    'asset',
    ...activeEntities.map(entity => entity.typeSlug).filter(Boolean),
  ])).sort();

  function scanNoticeLabel(){
    if (runningContextMapRun) return 'Keep rolling';
    if (initialScanNotice === 'started') return 'Initial scan started';
    if (initialScanNotice === 'rolling') return 'Keep rolling';
    if (initialScanNotice === 'completed') return 'Initial scan completed';
    return '';
  }

  const scanNotice = runningContextMapRun ? 'rolling' : initialScanNotice;
  const scanNoticeSource = runningContextMapRun ? runSourceLabel(runningContextMapRun.source) : null;
  const candidateGroups = groupContextMapCandidates(candidates);
  const acceptingAllCandidates = candidateBusy === '__all__';
  const candidateActionBusy = !!candidateBusy;
  const acceptAllDisabled = !enabled || reviewLoading || candidateActionBusy || !!editingCandidateId || pendingCount <= 0;
  const activeEntityCount = activeCounts.entities || activeEntities.length;
  const activeRelationshipCount = activeCounts.relationships || activeRelationships.length;
  const reviewCounts = (review && review.counts) || {};
  const topConnectedEntities = activeEntities
    .slice()
    .filter(entity => (entity.relationshipCount || 0) > 0)
    .sort((a, b) => (b.relationshipCount || 0) - (a.relationshipCount || 0))
    .slice(0, 3);
  const isolatedEntities = activeEntities.filter(entity => (entity.relationshipCount || 0) <= 0);
  const recentEntities = activeEntities
    .slice()
    .filter(entity => entity.updatedAt && !Number.isNaN(new Date(entity.updatedAt).getTime()))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 3);
  const needsReviewItems = [
    pendingCount ? `${pendingCount} pending` : '',
    reviewCounts.conflict ? `${reviewCounts.conflict} conflicts` : '',
    reviewCounts.failed ? `${reviewCounts.failed} failed` : '',
    reviewCounts.stale ? `${reviewCounts.stale} stale` : '',
  ].filter(Boolean);
  const overviewInsights = enabled ? [
    {
      title: 'Most connected',
      value: topConnectedEntities.length ? `${topConnectedEntities[0].relationshipCount || 0} links` : '0 links',
      items: topConnectedEntities.length
        ? topConnectedEntities.map(entity => `${entity.name} - ${entity.relationshipCount || 0} links`)
        : ['No relationship hubs in this slice.'],
    },
    {
      title: 'Needs review',
      value: String(pendingCount),
      items: needsReviewItems.length ? needsReviewItems : ['Review queue clear.'],
    },
    {
      title: 'Isolated',
      value: String(isolatedEntities.length),
      items: isolatedEntities.length
        ? isolatedEntities.slice(0, 3).map(entity => entity.name)
        : ['Every entity shown has at least one link.'],
    },
    {
      title: 'Recent changes',
      value: recentEntities.length ? formatMemoryUpdateTime(recentEntities[0].updatedAt) : 'None',
      items: recentEntities.length
        ? recentEntities.map(entity => `${entity.name} - ${formatMemoryUpdateTime(entity.updatedAt)}`)
        : ['No updated entities in this slice.'],
    },
  ] : [];
  const graphQueryText = graphQuery.trim().toLowerCase();
  const graphFocusEntity = (graphQueryText ? activeEntities.find(entity => entityMatchesGraphText(entity, graphQueryText)) : null)
    || topConnectedEntities[0]
    || activeEntities[0]
    || null;
  const focusedRelationshipRows = graphFocusEntity
    ? activeRelationships.filter(rel => rel.subjectEntityId === graphFocusEntity.entityId || rel.objectEntityId === graphFocusEntity.entityId)
    : [];
  const nearbyRelationshipRows = (focusedRelationshipRows.length ? focusedRelationshipRows : activeRelationships).slice(0, 4);
  const nearbyContextLabel = graphFocusEntity ? graphFocusEntity.name : 'Filtered slice';
  const globalScanInterval = Number.isFinite(globalContext.scanIntervalMinutes) ? globalContext.scanIntervalMinutes : 5;
  const statusText = !enabled
    ? 'Disabled'
    : runningContextMapRun
      ? 'Scanning'
      : latestContextMapRun && latestContextMapRun.status === 'failed'
        ? 'Error'
        : 'Enabled';
  const statusClass = statusText.toLowerCase();
  const globalProcessorProfile = globalProfile ? globalProfile.name : (fallbackBackend || 'Default profile');
  const contextMapSections = [
    { id: 'overview', label: 'Overview', desc: statusText },
    { id: 'processor', label: 'Processor', desc: settingsDirty ? 'Unsaved changes' : mode === 'override' ? 'Workspace override' : 'Global defaults' },
    { id: 'active', label: 'Active Map', desc: enabled ? `${activeEntityCount} entities` : 'Disabled' },
    { id: 'attention', label: 'Needs Attention', desc: enabled ? `${pendingCount} pending` : 'Disabled' },
    { id: 'danger', label: 'Danger Zone', desc: 'Rescan or clear' },
  ];

  return (
    <div ref={contextMapTopRef} className="settings-form settings-form-wide ws-form ws-form-context-map">
      <div className="ws-cm-layout">
        <nav className="ws-cm-rail" role="tablist" aria-label="Context Map settings sections">
          {contextMapSections.map(section => (
            <button
              key={section.id}
              type="button"
              id={`ws-cm-tab-${section.id}`}
              className={`ws-cm-nav ${contextMapSection === section.id ? 'active' : ''}`}
              role="tab"
              aria-selected={contextMapSection === section.id}
              aria-controls={`ws-cm-panel-${section.id}`}
              onClick={() => setContextMapSection(section.id)}
            >
              <span>{section.label}</span>
              <small>{section.desc}</small>
            </button>
          ))}
        </nav>

        <div ref={contextMapContentRef} className="ws-cm-content">
          {contextMapSection === 'overview' ? (
            <section
              id="ws-cm-panel-overview"
              className="ws-cm-panel"
              role="tabpanel"
              aria-labelledby="ws-cm-tab-overview"
            >
              <div className="ws-cm-title-row">
                <div>
                  <h3 className="ws-cm-title">Context Map</h3>
                  <p className="ws-desc u-dim">
                    Context Map keeps workspace entities, relationships, and evidence in a separate self-maintained map.
                  </p>
                </div>
                <span className={`ws-cm-status-badge is-${statusClass}`}>{statusText}</span>
              </div>
              <label className="toggle ws-toggle">
                <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)}/>
                <span className="tgl"/>
                <span>Enable Context Map for this workspace</span>
              </label>
              <div className="ws-cm-run-status">
                {latestContextMapRun ? (
                  <>
                    <span>Last scan</span>
                    <b>{runSourceLabel(latestContextMapRun.source)}</b>
                    <span>{formatMemoryUpdateTime(latestContextMapRun.startedAt)}</span>
                    <span className="u-dim">{statusLabel(latestContextMapRun.status)}</span>
                  </>
                ) : (
                  <span className="u-dim">Last scan: None yet</span>
                )}
              </div>
              {enabled ? (
                <>
                  <div className="ws-cm-metrics">
                    <div><b>{activeEntityCount}</b><span>Entities</span></div>
                    <div><b>{activeRelationshipCount}</b><span>Relationships</span></div>
                    <div><b>{pendingCount}</b><span>Needs Attention</span></div>
                  </div>
                  <div className="ws-cm-insights">
                    {overviewInsights.map(insight => (
                      <div key={insight.title} className="ws-cm-insight-card">
                        <div className="ws-cm-insight-head">
                          <span>{insight.title}</span>
                          <b>{insight.value}</b>
                        </div>
                        <ul>
                          {insight.items.map(item => <li key={item}>{item}</li>)}
                        </ul>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="ws-empty u-dim">Enable Context Map to scan this workspace and maintain its active graph.</p>
              )}
              {scanNotice ? (
                <div className={'ws-cm-initial-scan is-' + scanNotice}>
                  <span>{scanNoticeLabel()}{scanNoticeSource ? ` · ${scanNoticeSource}` : ''}</span>
                  {runningContextMapRun ? (
                    <button
                      type="button"
                      className="btn ghost danger ws-cm-stop-scan"
                      disabled={scanStopping}
                      onClick={(e) => onStopScan(e.currentTarget)}
                    >{scanStopping ? 'Stopping...' : 'Stop'}</button>
                  ) : initialScanNotice === 'completed' ? (
                    <span className="ws-cm-initial-scan-check">{Ico.check(12)}</span>
                  ) : (
                    <span className="ws-cm-initial-scan-dots" aria-hidden="true">
                      <i/><i/><i/>
                    </span>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}

          {contextMapSection === 'processor' ? (
            <section
              id="ws-cm-panel-processor"
              className="ws-cm-panel"
              role="tabpanel"
              aria-labelledby="ws-cm-tab-processor"
            >
      <div className="ws-cm-section-title">Processor</div>
      <div className="seg seg-inline ws-cm-seg">
        <button type="button" aria-pressed={mode === 'global'} onClick={() => onModeChange('global')}>Use global defaults</button>
        <button type="button" aria-pressed={mode === 'override'} onClick={() => onModeChange('override')}>Override</button>
      </div>

      {mode === 'override' ? (
        <>
          <label className="ws-cm-field">
            <span>CLI profile</span>
            <select value={selectedProfile ? selectedProfile.id : ''} onChange={(e) => onProfileChange(e.target.value)}>
              {profiles.length === 0 ? <option value="">No CLI profiles available</option> : null}
              {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {models.length ? (
            <label className="ws-cm-field">
              <span>Model</span>
              <select value={modelId} onChange={(e) => onModelChange(e.target.value)}>
                {models.map(m => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
              </select>
            </label>
          ) : null}
          {efforts.length ? (
            <div className="ws-cm-field">
              <span>Effort</span>
              <div className="seg seg-inline ws-cm-seg">
                {efforts.map(lv => (
                  <button
                    key={lv}
                    type="button"
                    aria-pressed={effort === lv}
                    onClick={() => onPatch({ cliEffort: lv })}
                  >{lv}</button>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="ws-cm-readonly-list">
          <div><span>CLI profile</span><b>{globalProcessorProfile}</b></div>
          <div><span>Model</span><b>{globalContext.cliModel || modelId || 'Default model'}</b></div>
          <div><span>Effort</span><b>{globalContext.cliEffort || effort || 'Default effort'}</b></div>
          <div><span>Scan interval</span><b>{globalScanInterval} minutes</b></div>
        </div>
      )}

      {mode === 'override' ? (
        <label className="ws-cm-field">
          <span>Scan interval override (minutes)</span>
          <input
            type="number"
            min={1}
            max={1440}
            placeholder={String(globalScanInterval)}
            value={ctx.scanIntervalMinutes ?? ''}
            onChange={(e) => onScanInterval(e.target.value)}
          />
        </label>
      ) : null}

      {settingsDirty ? (
        <div className="ws-cm-save-row">
          <span className="u-dim">Unsaved Context Map settings changes.</span>
          <button type="button" className="btn primary" disabled={saving} onClick={(e) => onSave(e.currentTarget)}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      ) : null}
            </section>
          ) : null}

          {contextMapSection === 'active' ? (
            <section
              id="ws-cm-panel-active"
              className="ws-cm-panel"
              role="tabpanel"
              aria-labelledby="ws-cm-tab-active"
            >
      <div className="ws-cm-section-title">Active Map</div>
      {enabled ? (
        <>
      <div className="ws-cm-review-head">
        <div className="ws-cm-section-summary u-dim">Browse the active entity and relationship graph.</div>
        <div className="ws-cm-head-actions">
          {!latestContextMapRun ? (
            <button type="button" className="btn ghost" onClick={(e) => runScanFromContextMap(e.currentTarget)} disabled={!enabled || scanBusy}>
              {Ico.search(12)} {scanBusy ? 'Scanning...' : 'Run initial scan'}
            </button>
          ) : null}
          <button type="button" className="btn ghost" onClick={refreshGraphWithFilters} disabled={graphLoading}>
            {Ico.reset(12)} {graphLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>
      <div className="ws-cm-graph-controls">
        <input
          type="search"
          value={graphQuery}
          onChange={(e) => setGraphQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') refreshGraphWithFilters(); }}
          placeholder="Search entities"
          disabled={!enabled}
        />
        <select value={graphType} onChange={(e) => setGraphType(e.target.value)} disabled={!enabled}>
          <option value="">All types</option>
          {graphTypeOptions.map(type => <option key={type} value={type}>{type}</option>)}
        </select>
        <select value={graphStatus} onChange={(e) => setGraphStatus(e.target.value)} disabled={!enabled}>
          <option value="active">Active</option>
          <option value="stale">Stale</option>
          <option value="superseded">Superseded</option>
          <option value="conflict">Conflict</option>
          <option value="discarded">Discarded</option>
          <option value="all">All statuses</option>
        </select>
        <select value={graphSensitivity} onChange={(e) => setGraphSensitivity(e.target.value)} disabled={!enabled}>
          <option value="">All sensitivity</option>
          <option value="normal">Normal</option>
          <option value="work-sensitive">Work-sensitive</option>
          <option value="personal-sensitive">Personal-sensitive</option>
          <option value="secret-pointer">Secret pointer</option>
        </select>
        <button type="button" className="btn ghost" onClick={refreshGraphWithFilters} disabled={!enabled || graphLoading}>
          {Ico.search(12)} Search
        </button>
        <button type="button" className="btn ghost" onClick={clearGraphFilters} disabled={!enabled || graphLoading || (!graphQuery && !graphType && graphStatus === 'active' && !graphSensitivity)}>
          Clear
        </button>
      </div>
      <div className="ws-cm-nearby">
        <div className="ws-cm-nearby-head">
          <span>Nearby context</span>
          <b>{nearbyContextLabel}</b>
        </div>
        {nearbyRelationshipRows.length ? (
          <div className="ws-cm-nearby-paths">
            {nearbyRelationshipRows.map(rel => (
              <div key={rel.relationshipId} className="ws-cm-nearby-row">
                <span>{rel.subjectName}</span>
                <b>{rel.predicate}</b>
                <span>{rel.objectName}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="ws-empty u-dim">No relationships in this slice.</p>
        )}
      </div>
        </>
      ) : null}
      {!enabled ? (
        <p className="ws-empty u-dim">Enable Context Map to scan this workspace and view entities and relationships.</p>
      ) : activeEntities.length === 0 ? (
        <p className="ws-empty u-dim">No active Context Map entities yet.</p>
      ) : (
        <div className="ws-cm-graph">
          <div className="ws-cm-entity-grid">
            {activeEntities.map(entity => {
              const isSelectedEntity = selectedEntityId === entity.entityId || (entityDetail && entityDetail.entityId === entity.entityId);
              const isLoadingEntity = entityDetailLoading && selectedEntityId === entity.entityId;
              return (
                <div key={entity.entityId} className={'ws-cm-entity-card' + (isSelectedEntity ? ' is-selected' : '')}>
                  <div className="ws-cm-entity-top">
                    <div>
                      <div className="ws-cm-entity-name">{entity.name}</div>
                      <div className="ws-cm-entity-type">{entity.typeSlug} · {entity.status || 'active'} · {entity.sensitivity || 'normal'}</div>
                    </div>
                    <span className="ws-cm-entity-confidence">{Math.round(((entity.confidence || 0) * 100))}%</span>
                  </div>
                  {entitySummary(entity) ? (
                    <p className="ws-cm-entity-summary">{entitySummary(entity)}</p>
                  ) : null}
                  {Array.isArray(entity.aliases) && entity.aliases.length ? (
                    <div className="ws-cm-entity-chips">
                      {entity.aliases.slice(0, 4).map(alias => <span key={alias}>{alias}</span>)}
                    </div>
                  ) : null}
                  <div className="ws-cm-entity-foot">
                    <span>{entity.factCount || 0} facts</span>
                    <span>{entity.relationshipCount || 0} links</span>
                    <span>{entity.evidenceCount || 0} evidence</span>
                    <button
                      type="button"
                      className="ws-mem-review-btn ws-cm-details-btn"
                      onClick={(e) => onSelectEntity(entity.entityId, e.currentTarget)}
                      disabled={isLoadingEntity}
                    >{isLoadingEntity ? 'Loading...' : 'Details'}</button>
                  </div>
                </div>
              );
            })}
          </div>
          {(entityDetailLoading || entityDetail) ? (
            <div
              className="ws-cm-detail-modal"
              role="dialog"
              aria-modal="true"
              aria-label={entityDetail ? `Context Map entity details: ${entityDetail.name}` : 'Context Map entity details'}
              onMouseDown={onCloseEntityDetail}
            >
              <div className="ws-cm-detail-panel" onMouseDown={(e) => e.stopPropagation()}>
                {entityDetailLoading && !entityDetail ? (
                  <div id="ws-context-map-entity-detail" className="ws-cm-detail" tabIndex="-1">
                    <div className="ws-cm-detail-head">
                      <div>
                        <div className="ws-cm-detail-title">Loading entity details...</div>
                        <div className="ws-cm-detail-meta"><span>Context Map</span></div>
                      </div>
                      <div className="ws-cm-detail-actions">
                        <button type="button" className="btn ghost" onClick={onCloseEntityDetail}>{Ico.x(12)} Close</button>
                      </div>
                    </div>
                  </div>
                ) : entityDetail ? (
                  <div id="ws-context-map-entity-detail" className="ws-cm-detail" tabIndex="-1">
              <div className="ws-cm-detail-head">
                <div>
                  <div className="ws-cm-detail-title">{entityDetail.name}</div>
                  <div className="ws-cm-detail-meta">
                    <span>{entityDetail.typeSlug}</span>
                    <span>{entityDetail.status}</span>
                    <span>{entityDetail.sensitivity}</span>
                  </div>
                </div>
                <div className="ws-cm-detail-actions">
                  {!editingEntity ? (
                    <button type="button" className="btn ghost" onClick={() => beginEntityEdit(entityDetail)}>{Ico.edit(12)} Edit</button>
                  ) : null}
                  <button type="button" className="btn ghost" onClick={onCloseEntityDetail}>{Ico.x(12)} Close</button>
                </div>
              </div>
              {editingEntity && entityEditDraft ? (
                <div className="ws-cm-entity-edit">
                  <label>
                    <span>Name</span>
                    <input value={entityEditDraft.name} onChange={(e) => patchEntityEdit({ name: e.target.value })}/>
                  </label>
                  <label>
                    <span>Type</span>
                    <select value={entityEditDraft.typeSlug} onChange={(e) => patchEntityEdit({ typeSlug: e.target.value })}>
                      {graphTypeOptions.map(type => <option key={type} value={type}>{type}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Status</span>
                    <select value={entityEditDraft.status} onChange={(e) => patchEntityEdit({ status: e.target.value })}>
                      <option value="active">Active</option>
                      <option value="stale">Stale</option>
                      <option value="superseded">Superseded</option>
                      <option value="conflict">Conflict</option>
                      <option value="discarded">Discarded</option>
                    </select>
                  </label>
                  <label>
                    <span>Sensitivity</span>
                    <select value={entityEditDraft.sensitivity} onChange={(e) => patchEntityEdit({ sensitivity: e.target.value })}>
                      <option value="normal">Normal</option>
                      <option value="work-sensitive">Work-sensitive</option>
                      <option value="personal-sensitive">Personal-sensitive</option>
                      <option value="secret-pointer">Secret pointer</option>
                    </select>
                  </label>
                  <label>
                    <span>Confidence</span>
                    <input type="number" min={0} max={1} step={0.01} value={entityEditDraft.confidence} onChange={(e) => patchEntityEdit({ confidence: e.target.value })}/>
                  </label>
                  <label className="wide">
                    <span>Summary</span>
                    <textarea rows={3} value={entityEditDraft.summaryMarkdown} onChange={(e) => patchEntityEdit({ summaryMarkdown: e.target.value })}/>
                  </label>
                  <label className="wide">
                    <span>Notes</span>
                    <textarea rows={3} value={entityEditDraft.notesMarkdown} onChange={(e) => patchEntityEdit({ notesMarkdown: e.target.value })}/>
                  </label>
                  <div className="ws-cm-edit-actions">
                    <button type="button" className="btn ghost" disabled={entityEditSaving} onClick={() => { setEditingEntity(false); setEntityEditDraft(null); }}>Cancel</button>
                    <button type="button" className="btn primary" disabled={entityEditSaving || !entityEditDraft.name.trim()} onClick={(e) => saveEntityEdit(e.currentTarget)}>
                      {entityEditSaving ? 'Saving...' : 'Save entity'}
                    </button>
                  </div>
                </div>
              ) : entityDetail.summaryMarkdown ? <p className="ws-cm-detail-summary">{entityDetail.summaryMarkdown}</p> : null}
              {Array.isArray(entityDetail.aliases) && entityDetail.aliases.length ? (
                <div className="ws-cm-entity-chips">
                  {entityDetail.aliases.map(alias => <span key={alias}>{alias}</span>)}
                </div>
              ) : null}
              <div className="ws-cm-detail-grid">
                <div>
                  <div className="ws-cm-detail-label">Facts</div>
                  {Array.isArray(entityDetail.facts) && entityDetail.facts.length ? (
                    <ul className="ws-cm-detail-list">
                      {entityDetail.facts.map(fact => (
                        <li key={fact.factId || fact.statementMarkdown}>
                          <span>{fact.statementMarkdown}</span>
                          <b>{Math.round(((fact.confidence || 0) * 100))}%</b>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="ws-empty u-dim">No facts.</p>}
                </div>
                <div>
                  <div className="ws-cm-detail-label">Evidence</div>
                  {Array.isArray(entityDetail.evidence) && entityDetail.evidence.length ? (
                    <ul className="ws-cm-detail-list">
                      {entityDetail.evidence.map(ev => (
                        <li key={ev.evidenceId}>
                          <span>{ev.sourceType}: {ev.sourceId}</span>
                          {ev.excerpt ? <b>{ev.excerpt}</b> : null}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="ws-empty u-dim">No direct evidence.</p>}
                </div>
              </div>
              {Array.isArray(entityDetail.relationships) && entityDetail.relationships.length ? (
                <div className="ws-cm-detail-block">
                  <div className="ws-cm-detail-label">Relationship Neighborhood</div>
                  <div className="ws-cm-neighborhood">
                    {entityDetail.relationships.slice(0, 10).map((rel, index) => {
                      const subjectIsEntity = rel.subjectEntityId === entityDetail.entityId || rel.subjectName === entityDetail.name;
                      const objectIsEntity = rel.objectEntityId === entityDetail.entityId || rel.objectName === entityDetail.name;
                      return (
                        <div key={rel.relationshipId || index} className={'ws-cm-neighborhood-row is-' + (rel.status || 'active')}>
                          <span className={'ws-cm-neighborhood-node' + (subjectIsEntity ? ' is-center' : '')}>{rel.subjectName}</span>
                          <span className="ws-cm-neighborhood-edge">
                            <b>{rel.predicate}</b>
                            <em>{statusLabel(rel.status || 'active')} - {Math.round(((rel.confidence || 0) * 100))}%</em>
                          </span>
                          <span className={'ws-cm-neighborhood-node' + (objectIsEntity ? ' is-center' : '')}>{rel.objectName}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {Array.isArray(entityDetail.audit) && entityDetail.audit.length ? (
                <div className="ws-cm-detail-block">
                  <div className="ws-cm-detail-label">Audit</div>
                  <ul className="ws-cm-detail-list">
                    {entityDetail.audit.slice(0, 5).map(event => (
                      <li key={event.eventId}>
                        <span>{event.eventType}</span>
                        <b>{event.createdAt}</b>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          {activeRelationships.length ? (
            <div className="ws-cm-relationships">
              {activeRelationships.slice(0, 8).map(rel => (
                <div key={rel.relationshipId} className="ws-cm-relationship-row">
                  <span>{rel.subjectName}</span>
                  <b>{rel.predicate}</b>
                  <span>{rel.objectName}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}

            </section>
          ) : null}

          {contextMapSection === 'attention' ? (
            <section
              id="ws-cm-panel-attention"
              className="ws-cm-panel"
              role="tabpanel"
              aria-labelledby="ws-cm-tab-attention"
            >
      <div className="ws-cm-section-title">Needs Attention</div>
      {enabled ? (
        <>
      <div className="ws-cm-review-head">
        <div className="ws-cm-section-summary u-dim">
          {currentReviewStatus === 'discarded' ? `${discardedCount} dismissed` : `${pendingCount} need attention`}
        </div>
        <div className="ws-cm-review-tools">
          <button
            type="button"
            className="btn primary"
            onClick={(e) => onApplyAllCandidates(e.currentTarget)}
            disabled={acceptAllDisabled}
          >{acceptingAllCandidates ? 'Accepting...' : 'Accept All'}</button>
          <div className="seg seg-inline ws-cm-seg ws-cm-review-filter">
            <button type="button" aria-pressed={currentReviewStatus === 'pending'} onClick={() => onReviewStatusChange('pending')} disabled={reviewLoading || candidateActionBusy}>
              Needs Attention
            </button>
            <button type="button" aria-pressed={currentReviewStatus === 'discarded'} onClick={() => onReviewStatusChange('discarded')} disabled={reviewLoading || candidateActionBusy}>
              Dismissed
            </button>
          </div>
          <button type="button" className="btn ghost" onClick={() => onRefreshReview(currentReviewStatus)} disabled={reviewLoading || candidateActionBusy}>
            {Ico.reset(12)} {reviewLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>
        </>
      ) : null}
      {!enabled ? (
        <p className="ws-empty u-dim">Enable Context Map to review proposed entities, relationships, and evidence.</p>
      ) : candidates.length === 0 ? (
        <p className="ws-empty u-dim">{currentReviewStatus === 'discarded' ? 'No dismissed Context Map items.' : 'No Context Map items need attention.'}</p>
      ) : (
        <div className="ws-cm-candidate-groups">
          {candidateGroups.map(group => (
            <section key={group.key} className="ws-cm-candidate-group">
              <div className="ws-cm-candidate-group-head">
                <div>
                  <span>{group.label}</span>
                  {group.meta ? <b>{group.meta}</b> : null}
                </div>
                <em>{group.items.length} {group.items.length === 1 ? 'item' : 'items'}</em>
              </div>
              <div className="ws-cm-candidates">
                {group.items.map(candidate => {
                  const sourceParts = candidateSourceParts(candidate);
                  const impact = contextMapCandidateImpactPreview(candidate);
                  return (
                    <div key={candidate.candidateId} className={'ws-cm-candidate is-' + (candidate.status || 'pending')}>
                      <div className="ws-cm-candidate-top">
                        <div className="ws-cm-candidate-main">
                          <div className="ws-cm-candidate-title">{candidateTitle(candidate)}</div>
                          <div className="ws-cm-candidate-meta">
                            <span>{candidate.candidateType}</span>
                            <span>{Math.round(((candidate.confidence || 0) * 100))}%</span>
                            <span>{statusLabel(candidate.status)}</span>
                          </div>
                        </div>
                        <div className="ws-cm-candidate-actions">
                          {candidate.status === 'active' ? (
                            <button type="button" className="btn ghost" disabled>{Ico.check(12)} Applied</button>
                          ) : candidate.status === 'discarded' ? (
                            <button
                              type="button"
                              className="btn ghost"
                              disabled={candidateActionBusy}
                              onClick={() => onReopenCandidate(candidate.candidateId)}
                            >{Ico.reset(12)} Restore</button>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="btn ghost"
                                disabled={candidateActionBusy}
                                onClick={() => editingCandidateId === candidate.candidateId ? cancelCandidateEdit() : beginCandidateEdit(candidate)}
                              >{editingCandidateId === candidate.candidateId ? Ico.x(12) : Ico.edit(12)} {editingCandidateId === candidate.candidateId ? 'Cancel' : 'Edit'}</button>
                              <button
                                type="button"
                                className="btn ghost"
                                disabled={candidateActionBusy || editingCandidateId === candidate.candidateId}
                                onClick={(e) => onApplyCandidate(candidate.candidateId, e.currentTarget)}
                              >{Ico.check(12)} Apply</button>
                              <button
                                type="button"
                                className="btn ghost danger"
                                disabled={candidateActionBusy}
                                onClick={(e) => onDiscardCandidate(candidate.candidateId, e.currentTarget)}
                              >{Ico.x(12)} Dismiss</button>
                            </>
                          )}
                        </div>
                      </div>
                      {impact ? (
                        <div className="ws-cm-candidate-impact">
                          <span className="ws-cm-impact-node">{impact.left}</span>
                          <span className="ws-cm-impact-edge">{impact.edge}</span>
                          <span className="ws-cm-impact-node">{impact.right}</span>
                          {impact.note ? <em>{impact.note}</em> : null}
                        </div>
                      ) : null}
                      {editingCandidateId === candidate.candidateId ? (
                        <div className="ws-cm-candidate-edit">
                          <label>
                            <span>Payload JSON</span>
                            <textarea value={candidateEditPayload} onChange={(e) => setCandidateEditPayload(e.target.value)}/>
                          </label>
                          <label>
                            <span>Confidence</span>
                            <input
                              type="number"
                              min="0"
                              max="1"
                              step="0.01"
                              value={candidateEditConfidence}
                              onChange={(e) => setCandidateEditConfidence(e.target.value)}
                            />
                          </label>
                          <div className="ws-cm-candidate-edit-actions">
                            <button
                              type="button"
                              className="btn ghost"
                              disabled={candidateActionBusy}
                              onClick={(e) => saveCandidateEdit(candidate, e.currentTarget)}
                            >{Ico.check(12)} Save edit</button>
                            <button type="button" className="btn ghost" disabled={candidateActionBusy} onClick={cancelCandidateEdit}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <pre className="ws-cm-candidate-payload">{candidateSummary(candidate)}</pre>
                      )}
                      <div className="ws-cm-source-ref">
                        {sourceParts.label}{sourceParts.meta ? ` · ${sourceParts.meta}` : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

            </section>
          ) : null}

          {contextMapSection === 'danger' ? (
            <section
              id="ws-cm-panel-danger"
              className="ws-cm-panel"
              role="tabpanel"
              aria-labelledby="ws-cm-tab-danger"
            >
              <div className="ws-cm-section-title">Danger Zone</div>
              {enabled && latestContextMapRun ? (
                <div className="ws-cm-danger-block">
                  <div className="ws-cm-danger-title">Rescan workspace</div>
                  <p className="ws-desc u-dim">
                    Start a full Context Map rescan for this workspace. Existing graph data stays in place while the background scan updates the map and Needs Attention.
                  </p>
                  <div className="ws-actions ws-cm-danger-actions">
                    <button type="button" className="btn ghost" onClick={(e) => runScanFromContextMap(e.currentTarget)} disabled={scanBusy || candidateBusy}>
                      {Ico.search(12)} {scanBusy ? 'Scanning...' : 'Rescan now'}
                    </button>
                    <Tip
                      variant="explain"
                      rich={(
                        <WorkspaceSettingsHelpTooltip>
                          Starts a full Context Map rescan for this workspace. Agent Cockpit reprocesses discovered workspace sources even if they have not changed, checks conversations for anything new, and updates the map and Needs Attention while the scan runs in the background.
                        </WorkspaceSettingsHelpTooltip>
                      )}
                    >
                      <button
                        type="button"
                        className="settings-help-btn ws-cm-rescan-help"
                        aria-label="Rescan now help"
                      >?</button>
                    </Tip>
                  </div>
                </div>
              ) : null}
              <div className="ws-cm-danger-block">
                <div className="ws-cm-danger-title">Clear stored map</div>
                <p className="ws-empty u-dim">
                  Clear all Context Map graph data, candidate review items, evidence, run history, cursors, and audit rows for this workspace. Workspace enablement and processor settings stay in place.
                </p>
                <div className="ws-actions ws-cm-danger-actions">
                  <button
                    className="btn ghost danger"
                    disabled={scanBusy || candidateBusy}
                    onClick={(e) => onClearMap(e.currentTarget)}
                  >{Ico.trash(12)} Clear Context Map</button>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
