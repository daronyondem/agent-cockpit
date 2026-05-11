/* CLI update store — cached status for local backend CLI installations.

   The server polls in the background; this store reads the cached snapshot
   and lets the web UI trigger explicit checks or supported updates. It is
  intentionally web-only: the mobile PWA does not expose server-admin CLI
  update controls. */

import { AgentApi } from './api.js';

let cached = null;
let inFlight = null;
const subs = new Set();

  function notify(){
    for (const fn of subs) {
      try { fn(cached); } catch (err) {
        console.warn('[cliUpdateStore] subscriber threw:', err);
      }
    }
  }

  function get(){ return cached; }

  function set(data){
    cached = data || { items: [], lastCheckAt: null, updateInProgress: false };
    notify();
    return cached;
  }

  function refresh(){
    if (inFlight) return inFlight;
    if (!AgentApi || !AgentApi.getCliUpdates) {
      return Promise.resolve(cached);
    }
    inFlight = AgentApi.getCliUpdates()
      .then(set)
      .catch(err => {
        console.warn('[cliUpdateStore] fetch failed:', err && err.message);
        return cached;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  function check(){
    if (!AgentApi || !AgentApi.checkCliUpdates) {
      return Promise.resolve(cached);
    }
    return AgentApi.checkCliUpdates().then(set);
  }

  function update(itemId){
    if (!AgentApi || !AgentApi.triggerCliUpdate) {
      return Promise.reject(new Error('CLI update API is unavailable'));
    }
    return AgentApi.triggerCliUpdate(itemId)
      .then(result => {
        if (result && result.item && cached && Array.isArray(cached.items)) {
          const items = cached.items.map(item => item.id === result.item.id ? result.item : item);
          set({ ...cached, items, updateInProgress: false });
        }
        return result;
      })
      .finally(() => refresh());
  }

  function subscribe(fn){
    subs.add(fn);
    return () => subs.delete(fn);
  }

  function findForSelection(cliProfileId, backendId){
    const items = cached && Array.isArray(cached.items) ? cached.items : [];
    if (cliProfileId) {
      const byProfile = items.find(item => Array.isArray(item.profileIds) && item.profileIds.includes(cliProfileId));
      if (byProfile) return byProfile;
    }
    if (backendId) {
      const serverProfileId = 'server-configured-' + backendId;
      return items.find(item => Array.isArray(item.profileIds) && item.profileIds.includes(serverProfileId))
        || items.find(item => item.vendor === backendId)
        || null;
    }
    return null;
  }

export const CliUpdateStore = { get, refresh, check, update, subscribe, findForSelection };

export default CliUpdateStore;
