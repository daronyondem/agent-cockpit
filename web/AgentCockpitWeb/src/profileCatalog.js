/** Shared profile catalog projection for Settings, workspace overrides and chat. */
export function backendIdForProfile(profile){
  if (!profile) return null;
  if (profile.harness === 'claude-code' && profile.protocol === 'interactive') return 'claude-code-interactive';
  return profile.harness;
}

export function backendForProfile(backends, profileBackends, profile){
  if (!profile) return null;
  const id = backendIdForProfile(profile);
  const scoped = profileBackends && profileBackends[profile.id];
  return (scoped && scoped.id === id ? scoped : null)
    || (backends || []).find(b => b.id === id)
    || null;
}

export function modelsForProfile(backends, profileBackends, profile){
  const b = backendForProfile(backends, profileBackends, profile);
  return (b && Array.isArray(b.models)) ? b.models : [];
}

export function modelDisplayLabel(modelOrId){
  const raw = typeof modelOrId === 'string'
    ? modelOrId
    : String((modelOrId && (modelOrId.label || modelOrId.id)) || '');
  return raw.startsWith('openrouter/') ? raw.slice('openrouter/'.length) : raw;
}

export function defaultModelId(models){
  if (!models || !models.length) return undefined;
  const def = models.find(m => m.default);
  return def ? def.id : models[0].id;
}

export function effortLevelsForProfile(backends, profileBackends, profile, modelId){
  const models = modelsForProfile(backends, profileBackends, profile);
  const m = models.find(x => x.id === modelId);
  if (!m || !Array.isArray(m.supportedEffortLevels)) return [];
  return m.supportedEffortLevels;
}

export function defaultEffortFor(levels){
  if (!levels || !levels.length) return undefined;
  return levels.includes('high') ? 'high' : levels[0];
}
