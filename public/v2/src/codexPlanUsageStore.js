/* Codex plan usage store — mirrors planUsageStore.js for the Codex backend.

   Flow:
   - `refresh()` hits GET /api/chat/codex-plan-usage. The server-side
     CodexPlanUsageService refreshes the `account/read` +
     `account/rateLimits/read` snapshot opportunistically on startup and
     after each Codex assistant turn, floored at once per 10 min. The
     endpoint itself never triggers a fetch — it just returns the cached
     snapshot.
   - Subscribers receive the new snapshot (or `null` if the store has
     never fetched yet) via their callback.
   - In-flight fetches are coalesced.

   Exposed as `window.CodexPlanUsageStore`. */

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
        console.warn('[codexPlanUsageStore] subscriber threw:', err);
      }
    }
  }

  function get(cliProfileId){ return cachedByKey.get(keyFor(cliProfileId)) || null; }

  function refresh(cliProfileId){
    const key = keyFor(cliProfileId);
    if (inFlightByKey.has(key)) return inFlightByKey.get(key);
    if (!window.AgentApi || !window.AgentApi.getCodexPlanUsage) {
      return Promise.resolve(null);
    }
    const inFlight = window.AgentApi.getCodexPlanUsage(cliProfileId || null)
      .then(data => { cachedByKey.set(key, data || null); return cachedByKey.get(key); })
      .catch(err => {
        console.warn('[codexPlanUsageStore] fetch failed:', err && err.message);
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

  window.CodexPlanUsageStore = { get, refresh, subscribe };
})();
