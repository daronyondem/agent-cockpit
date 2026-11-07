import React from 'react';
import { hasRequiredCliProfileConfig } from '../../../../src/contracts/cliProfiles';
import { useProfileBackends } from '../useProfileBackends.js';
import { StreamStore } from '../streamStore.js';
import { Ico } from '../icons.jsx';
import { BackendInlineIcon, modelDisplayLabel } from '../shellState.jsx';
import { backendIdForProfile, cliHarnessForBackend, isClaudeBackend } from './chatHelpers.js';

/* Cascading pickers below the composer: Profile → Model → Effort → Speed.
   Values flush to the server with the next /message POST (see StreamStore.send).
   Each chip wraps a transparent native <select> so we get native dropdown
   UX, keyboard/a11y for free, and the chip's styled shell. */
export default function ComposerPicks({ convId, backends, cliProfiles, composerCliProfileId, composerBackend, composerModel, composerEffort, composerClaudeCodeMode, composerServiceTier, profileLocked, disabled }){
  const activeProfiles = Array.isArray(cliProfiles) ? cliProfiles.filter(p => p && !p.disabled && (hasRequiredCliProfileConfig(p) || p.id === composerCliProfileId)) : [];
  const exactProfile = activeProfiles.find(p => p.id === composerCliProfileId) || null;
  const canRepairMissingProfile = profileLocked && !!composerCliProfileId && !exactProfile;
  const canChangeProfile = !profileLocked || canRepairMissingProfile;
  const selectedProfile = exactProfile
    || (canChangeProfile && composerBackend ? activeProfiles.find(p => p.harness === cliHarnessForBackend(composerBackend)) : null)
    || (canChangeProfile && activeProfiles.length === 1 ? activeProfiles[0] : null)
    || null;
  const selectedProfileId = selectedProfile ? selectedProfile.id : null;
  const selectedProfileKey = JSON.stringify(selectedProfile);
  const effectiveBackendId = selectedProfile
    ? backendIdForProfile(selectedProfile)
    : composerBackend;
  const [catalogs, loadProfileBackend] = useProfileBackends();
  const profileBackend = catalogs[selectedProfileKey];
  React.useEffect(() => {
    if (selectedProfileId) loadProfileBackend(selectedProfileId, selectedProfileKey);
  }, [selectedProfileId, selectedProfileKey, loadProfileBackend]);
  React.useEffect(() => {
    if (!canChangeProfile || !selectedProfileId || !effectiveBackendId) return;
    if (composerCliProfileId !== selectedProfileId || composerBackend !== effectiveBackendId) {
      StreamStore.setComposerCliProfile(convId, selectedProfileId, effectiveBackendId);
    }
  }, [convId, canChangeProfile, selectedProfileId, effectiveBackendId, composerCliProfileId, composerBackend]);

  const profileMetadataPending = !!selectedProfileId && !Object.hasOwn(catalogs, selectedProfileKey);
  const backend = (!profileMetadataPending && selectedProfile && profileBackend && profileBackend.id === effectiveBackendId)
    ? profileBackend
    : (backends.find(b => b.id === effectiveBackendId) || null);
  const backendModels = (backend && Array.isArray(backend.models)) ? backend.models : [];
  const cortexCatalogUnavailable = effectiveBackendId === 'cortex-code' && (profileMetadataPending || !backendModels.length);
  const modelFromCatalog = backendModels.find(m => m.id === composerModel) || null;
  const fallbackModel = profileMetadataPending
    ? null
    : (backendModels.find(m => m.default) || backendModels[0] || null);
  const pendingModel = (profileMetadataPending || effectiveBackendId === 'cortex-code') && composerModel
    ? { id: composerModel, label: composerModel }
    : null;
  const model = modelFromCatalog
    || pendingModel
    || fallbackModel
    || null;
  const modelOptions = (profileMetadataPending || effectiveBackendId === 'cortex-code') && !modelFromCatalog && pendingModel
    ? [{ value: pendingModel.id, label: modelDisplayLabel(pendingModel), disabled: true }]
    : backendModels.map(m => ({ value: m.id, label: modelDisplayLabel(m) + costTierDot(m.costTier) }));
  if (!profileMetadataPending && pendingModel && !modelFromCatalog) modelOptions.push(...backendModels.map(m => ({ value: m.id, label: modelDisplayLabel(m) })));
  const backendId = backend ? backend.id : null;
  const modelId = model ? model.id : null;
  const effortLevels = (model && Array.isArray(model.supportedEffortLevels)) ? model.supportedEffortLevels : [];
  const effort = effortLevels.includes(composerEffort)
    ? composerEffort
    : (effortLevels.includes('high') ? 'high' : (effortLevels[0] || null));
  const claudeCodeModeSupported = isClaudeBackend(effectiveBackendId) && effortLevels.includes('xhigh');
  const claudeCodeMode = composerClaudeCodeMode === 'ultracode' ? 'ultracode' : 'default';
  const serviceTier = composerServiceTier === 'fast' ? 'fast' : 'default';

  /* If picker state drifted out of the backend's catalog (e.g. backend change
      invalidated the chosen model), push the reconciled value back down so
     the next send uses a valid pair. */
  React.useEffect(() => {
    if (profileMetadataPending || cortexCatalogUnavailable) return;
    if (backendId && modelId && composerModel !== modelId) {
      StreamStore.setComposerModel(convId, modelId);
    }
  }, [convId, backendId, modelId, composerModel, profileMetadataPending, cortexCatalogUnavailable]);
  React.useEffect(() => {
    if (profileMetadataPending || cortexCatalogUnavailable || (effectiveBackendId === 'cortex-code' && !modelFromCatalog)) return;
    if (effort !== composerEffort) {
      StreamStore.setComposerEffort(convId, effort);
    }
  }, [convId, effort, composerEffort, profileMetadataPending, cortexCatalogUnavailable, effectiveBackendId, modelFromCatalog]);
  React.useEffect(() => {
    if (profileMetadataPending) return;
    if (!claudeCodeModeSupported && composerClaudeCodeMode) {
      StreamStore.setComposerClaudeCodeMode(convId, null);
    }
  }, [convId, claudeCodeModeSupported, composerClaudeCodeMode, profileMetadataPending]);

  if (backends.length === 0) return <span className="picks"/>;

  return (
    <span className="picks">
      {effectiveBackendId === 'cortex-code' && (profileMetadataPending || !backendModels.length) ? <span role="status" className="u-dim">{profileMetadataPending ? 'Loading CoCo models…' : 'CoCo models unavailable. Save the connection and check Cortex login in Settings.'}</span> : null}
      {activeProfiles.length > 0 ? (
        <PickChip
          label="Profile"
          value={selectedProfile ? selectedProfile.name : 'Select profile'}
          disabled={disabled || !canChangeProfile}
          options={[
            ...(!selectedProfile ? [{ value: '', label: 'Select profile', disabled: true }] : []),
            ...activeProfiles.map(p => ({ value: p.id, label: p.name, disabled: !hasRequiredCliProfileConfig(p) })),
          ]}
          currentValue={selectedProfile ? selectedProfile.id : ''}
          icon={selectedProfile ? <BackendInlineIcon backends={backends} backendId={effectiveBackendId}/> : null}
          onChange={v => {
            const profile = activeProfiles.find(p => p.id === v);
            if (profile && hasRequiredCliProfileConfig(profile)) {
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
      {modelOptions.length > 0 ? (
        <PickChip
          label="Model"
          value={model ? modelDisplayLabel(model) : (composerModel ? modelDisplayLabel(composerModel) : '—')}
          disabled={disabled || (profileMetadataPending && !modelFromCatalog)}
          options={modelOptions}
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
      {claudeCodeModeSupported ? (
        <PickChip
          label="Mode"
          value={claudeCodeMode === 'ultracode' ? 'Ultracode' : 'Default'}
          disabled={disabled}
          options={[
            { value: 'default', label: 'Default' },
            { value: 'ultracode', label: 'Ultracode' },
          ]}
          currentValue={claudeCodeMode}
          onChange={v => StreamStore.setComposerClaudeCodeMode(convId, v)}
          title="Claude Code mode"
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
