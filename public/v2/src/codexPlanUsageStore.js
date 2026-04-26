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
  let cached = null;
  let inFlight = null;
  const subs = new Set();

  function notify(){
    for (const fn of subs) {
      try { fn(cached); } catch (err) {
        console.warn('[codexPlanUsageStore] subscriber threw:', err);
      }
    }
  }

  function get(){ return cached; }

  function refresh(){
    if (inFlight) return inFlight;
    if (!window.AgentApi || !window.AgentApi.getCodexPlanUsage) {
      return Promise.resolve(null);
    }
    inFlight = window.AgentApi.getCodexPlanUsage()
      .then(data => { cached = data || null; return cached; })
      .catch(err => {
        console.warn('[codexPlanUsageStore] fetch failed:', err && err.message);
        return cached;
      })
      .finally(() => { inFlight = null; notify(); });
    return inFlight;
  }

  function subscribe(fn){
    subs.add(fn);
    return () => { subs.delete(fn); };
  }

  window.CodexPlanUsageStore = { get, refresh, subscribe };
})();
