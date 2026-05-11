import React from 'react';

import { AgentApi } from './api.js';
import { StreamStore } from './streamStore.js';
import { CliUpdateStore } from './cliUpdateStore.js';

export function ScreenLoading({ label = 'Loading...' }){
  return <div className="u-dim" style={{padding:'16px'}}>{label}</div>;
}

/* Subscribe to a single conversation's state in the StreamStore. Returns
   the current ConvState snapshot (or null when no convId is selected). */
export function useConversationState(convId){
  const [, tick] = React.useReducer(x => x + 1, 0);
  React.useEffect(() => {
    if (!convId) return;
    StreamStore.load(convId);
    StreamStore.ensureWsOpen(convId).catch(() => {});
    return StreamStore.subscribe(convId, tick);
  }, [convId]);
  return convId ? StreamStore.getState(convId) : null;
}

/* Subscribe to the global per-conv uiState map used by the sidebar to light
   up every conversation that is currently streaming / errored. */
export function useConvStates(){
  const [map, setMap] = React.useState(() => StreamStore.convStates());
  React.useEffect(() => StreamStore.subscribeGlobal(() => setMap(StreamStore.convStates())), []);
  return map;
}

/* Fetches the backend registry once per page load. Returns [] until the
   server responds; composer pickers hide themselves until the list arrives. */
function useBackends(){
  const [backends, setBackends] = React.useState([]);
  React.useEffect(() => {
    let cancelled = false;
    AgentApi.getBackendsCached()
      .then(list => { if (!cancelled) setBackends(Array.isArray(list) ? list : []); })
      .catch(() => { /* composer stays in display-only mode */ });
    return () => { cancelled = true; };
  }, []);
  return backends;
}

/* Backends context — populated once at the root so assistant-message avatars
   can look up a backend's `icon` SVG without re-fetching per render. */
const BackendsContext = React.createContext([]);
export function BackendsProvider({ children }){
  const backends = useBackends();
  return <BackendsContext.Provider value={backends}>{children}</BackendsContext.Provider>;
}
export function useBackendList(){ return React.useContext(BackendsContext); }

/* CLI profiles live in Settings. They change rarely, but Settings can save
   them without a page reload, so this provider refetches on the save event. */
const CliProfilesContext = React.createContext({ profiles: [], defaultCliProfileId: null });
export function CliProfilesProvider({ children }){
  const [state, setState] = React.useState({ profiles: [], defaultCliProfileId: null });
  React.useEffect(() => {
    let cancelled = false;
    function applySettings(s){
      if (cancelled) return;
      setState({
        profiles: Array.isArray(s && s.cliProfiles) ? s.cliProfiles : [],
        defaultCliProfileId: (s && s.defaultCliProfileId) || null,
      });
    }
    AgentApi.getSettingsCached().then(applySettings).catch(() => {});
    const onSaved = (ev) => {
      if (ev && ev.detail) applySettings(ev.detail);
      else AgentApi.settings.get().then(applySettings).catch(() => {});
    };
    window.addEventListener('agent-cockpit-settings-saved', onSaved);
    return () => {
      cancelled = true;
      window.removeEventListener('agent-cockpit-settings-saved', onSaved);
    };
  }, []);
  return <CliProfilesContext.Provider value={state}>{children}</CliProfilesContext.Provider>;
}
export function useCliProfileSettings(){ return React.useContext(CliProfilesContext); }

export function useCliUpdates(){
  const [snapshot, setSnapshot] = React.useState(() => CliUpdateStore.get() || null);
  React.useEffect(() => {
    const unsub = CliUpdateStore.subscribe(setSnapshot);
    CliUpdateStore.refresh();
    const timer = setInterval(() => CliUpdateStore.refresh(), 5 * 60 * 1000);
    return () => {
      clearInterval(timer);
      unsub();
    };
  }, []);
  return snapshot;
}

function backendIconFor(backends, backendId){
  if (!backendId) return null;
  const b = (backends || []).find(x => x.id === backendId);
  return (b && b.icon) || null;
}

export function BackendInlineIcon({ backends, backendId, className }){
  const icon = backendIconFor(backends, backendId);
  if (!icon) return null;
  return <span className={className || 'backend-inline-icon'} aria-hidden="true" dangerouslySetInnerHTML={{__html: icon}}/>;
}

/* Renders the avatar for an assistant message. When the backend exposes an
   inline SVG icon (claude-code, kiro), render that. Otherwise fall back to
   the Agent Cockpit logo. */
export function AssistantAvatar({ backend }){
  const backends = useBackendList();
  const icon = backendIconFor(backends, backend);
  if (icon) {
    return <span className="avatar avatar-svg" dangerouslySetInnerHTML={{__html: icon}}/>;
  }
  return (
    <span className="avatar avatar-cockpit">
      <img src="/logo-small.svg" alt="Agent Cockpit"/>
    </span>
  );
}
