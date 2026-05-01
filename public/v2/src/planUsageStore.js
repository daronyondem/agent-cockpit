/* Claude plan usage store — tiny singleton that fans out cache updates
   to any subscriber. The ContextChip in shell.jsx is the only consumer
   today (Claude Code backend only).

   Flow:
   - `refresh()` hits GET /api/chat/plan-usage. That endpoint returns the
     server-side cached snapshot without triggering a fetch; the server
     refreshes opportunistically on startup and after each Claude Code
     assistant turn, floored at once per 10 min.
   - Subscribers receive the new snapshot (or `null` if the store has
     never fetched yet) via their callback.
   - In-flight fetches are coalesced — concurrent `refresh()` calls share
     one network request.

   Exposed as `window.PlanUsageStore`. */

(function(){
  const DEFAULT_KEY = '__default__';
  const cachedByKey = new Map();
  const inFlightByKey = new Map();
  const subsByKey = new Map();

  function keyFor(cliProfileId){
    return cliProfileId || DEFAULT_KEY;
  }

  function notify(key){
    const subs = subsByKey.get(key);
    if (!subs) return;
    const cached = cachedByKey.get(key) || null;
    for (const fn of subs) {
      try { fn(cached); } catch (err) {
        console.warn('[planUsageStore] subscriber threw:', err);
      }
    }
  }

  function get(cliProfileId){ return cachedByKey.get(keyFor(cliProfileId)) || null; }

  function refresh(cliProfileId){
    const key = keyFor(cliProfileId);
    if (inFlightByKey.has(key)) return inFlightByKey.get(key);
    if (!window.AgentApi || !window.AgentApi.getClaudePlanUsage) {
      return Promise.resolve(null);
    }
    const inFlight = window.AgentApi.getClaudePlanUsage(cliProfileId || null)
      .then(data => { cachedByKey.set(key, data || null); return cachedByKey.get(key); })
      .catch(err => {
        console.warn('[planUsageStore] fetch failed:', err && err.message);
        return cachedByKey.get(key) || null;
      })
      .finally(() => { inFlightByKey.delete(key); notify(key); });
    inFlightByKey.set(key, inFlight);
    return inFlight;
  }

  function subscribe(fn, cliProfileId){
    const key = keyFor(cliProfileId);
    let subs = subsByKey.get(key);
    if (!subs) {
      subs = new Set();
      subsByKey.set(key, subs);
    }
    subs.add(fn);
    return () => {
      subs.delete(fn);
      if (subs.size === 0) subsByKey.delete(key);
    };
  }

  window.PlanUsageStore = { get, refresh, subscribe };
})();
