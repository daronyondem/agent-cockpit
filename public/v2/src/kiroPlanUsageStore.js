/* Kiro plan usage store — mirrors planUsageStore.js for the Kiro backend.

   Flow:
   - `refresh()` hits GET /api/chat/kiro-plan-usage. The server-side
     KiroPlanUsageService refreshes the Amazon Q GetUsageLimits snapshot
     opportunistically on startup and after each Kiro assistant turn,
     floored at once per 10 min. The endpoint itself never triggers a
     fetch — it just returns the cached snapshot.
   - Subscribers receive the new snapshot (or `null` if the store has
     never fetched yet) via their callback.
   - In-flight fetches are coalesced.

   Exposed as `window.KiroPlanUsageStore`. */

(function(){
  let cached = null;
  let inFlight = null;
  const subs = new Set();

  function notify(){
    for (const fn of subs) {
      try { fn(cached); } catch (err) {
        console.warn('[kiroPlanUsageStore] subscriber threw:', err);
      }
    }
  }

  function get(){ return cached; }

  function refresh(){
    if (inFlight) return inFlight;
    if (!window.AgentApi || !window.AgentApi.getKiroPlanUsage) {
      return Promise.resolve(null);
    }
    inFlight = window.AgentApi.getKiroPlanUsage()
      .then(data => { cached = data || null; return cached; })
      .catch(err => {
        console.warn('[kiroPlanUsageStore] fetch failed:', err && err.message);
        return cached;
      })
      .finally(() => { inFlight = null; notify(); });
    return inFlight;
  }

  function subscribe(fn){
    subs.add(fn);
    return () => { subs.delete(fn); };
  }

  window.KiroPlanUsageStore = { get, refresh, subscribe };
})();
