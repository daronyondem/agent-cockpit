import React from 'react';
import { AgentApi } from './api.js';

/** Settings-owned catalogs expire together when persisted profiles change. */
export function useProfileBackends(){
  const [catalogs, setCatalogs] = React.useState({});
  const scope = React.useRef({ generation: 0, pending: new Set() }).current;
  React.useEffect(() => {
    const reset = () => { scope.generation++; scope.pending.clear(); setCatalogs({}); };
    window.addEventListener('agent-cockpit-settings-saved', reset);
    return () => { scope.generation++; scope.pending.clear(); window.removeEventListener('agent-cockpit-settings-saved', reset); };
  }, [scope]);
  const load = React.useCallback((profileId, key = profileId) => {
    if (!profileId || Object.hasOwn(catalogs, key) || scope.pending.has(key)) return;
    scope.pending.add(key);
    const owner = scope.generation;
    const accept = backend => {
      if (scope.generation !== owner) return;
      scope.pending.delete(key);
      setCatalogs(prev => ({ ...prev, [key]: backend }));
    };
    AgentApi.getCliProfileMetadata(profileId).then(accept).catch(() => accept(null));
  }, [catalogs, scope]);
  return [catalogs, load];
}
