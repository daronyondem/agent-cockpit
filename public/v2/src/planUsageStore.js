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
  let cached = null;
  let inFlight = null;
  const subs = new Set();

  function notify(){
    for (const fn of subs) {
      try { fn(cached); } catch (err) {
        console.warn('[planUsageStore] subscriber threw:', err);
      }
    }
  }

  function get(){ return cached; }

  function refresh(){
    if (inFlight) return inFlight;
    if (!window.AgentApi || !window.AgentApi.getClaudePlanUsage) {
      return Promise.resolve(null);
    }
    inFlight = window.AgentApi.getClaudePlanUsage()
      .then(data => { cached = data || null; return cached; })
      .catch(err => {
        console.warn('[planUsageStore] fetch failed:', err && err.message);
        return cached;
      })
      .finally(() => { inFlight = null; notify(); });
    return inFlight;
  }

  function subscribe(fn){
    subs.add(fn);
    return () => { subs.delete(fn); };
  }

  window.PlanUsageStore = { get, refresh, subscribe };
})();
