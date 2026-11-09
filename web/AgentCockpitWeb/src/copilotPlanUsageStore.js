import { AgentApi } from './api.js';

const snapshots = new Map();
const pending = new Map();
const listeners = new Map();
const keyFor = id => id || 'server-configured-copilot';

function get(id) { return snapshots.get(keyFor(id)) || null; }
function subscribe(fn, id) {
  const key = keyFor(id);
  const set = listeners.get(key) || new Set();
  set.add(fn); listeners.set(key, set);
  return () => { set.delete(fn); if (!set.size) listeners.delete(key); };
}
function refresh(id) {
  const key = keyFor(id);
  if (pending.has(key)) return pending.get(key);
  const request = AgentApi.fetch('cli-profiles/' + encodeURIComponent(key) + '/copilot-quota')
    .then(async response => {
      if (!response.ok) throw new Error('Copilot quota is unavailable');
      const data = await response.json();
      snapshots.set(key, data.quota);
      return data.quota;
    })
    .catch(() => {
      snapshots.set(key, { status: 'unavailable', fetchedAt: null, stale: false, rows: [], message: 'Account quota is unavailable.' });
      return snapshots.get(key);
    })
    .finally(() => { pending.delete(key); for (const fn of listeners.get(key) || []) fn(get(key)); });
  pending.set(key, request);
  return request;
}

export const CopilotPlanUsageStore = { get, refresh, subscribe };
