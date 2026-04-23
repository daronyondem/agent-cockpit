/* global React */
/* ============================================================
   ContextChip renderers — per-CLI registry

   Each backend ID maps to a renderer with two methods:
     renderChipText(usage)   → string shown inside the top-bar chip,
                                or null to hide the chip entirely.
     renderTooltipCard(usage) → ReactNode rendered inside <Tip variant="stat">.

   Unknown backend IDs fall through to DEFAULT_CHIP_RENDERER so new
   CLIs get a safe, generic chip+tooltip until they register their own.

   Exports: window.getChipRenderer(backendId).
   ============================================================ */

function _fmtTokensShort(n){
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
function _fmtCost(c){
  return c.toFixed(c >= 1 ? 2 : 4);
}
function _fmtInt(n){
  return (n || 0).toLocaleString();
}

/* Plan-tier labels arrive as `default_claude_max_20x` / `default_claude_pro`
   etc. Strip the prefix, then title-case the remainder so "max_20x" renders
   as "Max 20x". Unknown tiers fall through to the same treatment. */
function _humanizeTier(tier){
  if (!tier) return 'Plan';
  const stripped = String(tier).replace(/^default_claude_/, '').replace(/_/g, ' ').trim();
  if (!stripped) return 'Plan';
  return stripped.replace(/\b\w/g, c => c.toUpperCase());
}

const RATE_LIMIT_LABELS = {
  five_hour: '5h session',
  seven_day: 'Weekly total',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
  seven_day_oauth_apps: 'Weekly API apps',
};

/* Anthropic ships new rate-limit buckets under codenames
   (seven_day_omelette, iguana_necktie, etc.) before they land with a
   stable name. Fall back to a derived label rather than hiding unknown
   keys so the user still sees them. */
function _deriveRateLimitLabel(key){
  if (RATE_LIMIT_LABELS[key]) return RATE_LIMIT_LABELS[key];
  const core = String(key)
    .replace(/^seven_day_/, '')
    .replace(/^five_hour_/, '')
    .replace(/_/g, ' ')
    .trim();
  const titled = core.replace(/\b\w/g, c => c.toUpperCase());
  if (key.startsWith('seven_day_')) return 'Weekly ' + titled;
  if (key.startsWith('five_hour_')) return '5h ' + titled;
  return titled || key;
}

function _formatResetAt(iso){
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = then - Date.now();
  if (diff <= 0) return 'resets now';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `resets in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `resets in ${h}h`;
  return `resets in ${Math.floor(h / 24)}d`;
}

function _formatFetchedAt(iso){
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'never';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function _buildRateLimitBars(rateLimits){
  const out = [];
  for (const key of Object.keys(rateLimits || {})) {
    if (key === 'extra_usage') continue;
    const v = rateLimits[key];
    if (!v || typeof v.utilization !== 'number') continue;
    out.push({
      key,
      label: _deriveRateLimitLabel(key),
      pct: v.utilization,
      pctLabel: Math.round(v.utilization) + '%',
      resetLabel: _formatResetAt(v.resets_at),
    });
  }
  return out;
}

function PlanUsageSection({ data }){
  const bars = _buildRateLimitBars(data.rateLimits);
  const extra = data.rateLimits ? data.rateLimits.extra_usage : null;
  const tier = _humanizeTier(data.planTier);
  const fetchedLabel = _formatFetchedAt(data.fetchedAt);
  const errored = !!data.lastError;
  const stale = !!data.stale;
  const footerColor = errored
    ? 'var(--status-error)'
    : (stale ? 'var(--status-warning)' : 'var(--text-3)');
  return (
    <>
      <div className="tt-section">
        <div className="tt-section-label">Account · {tier}</div>
        {bars.length ? (
          <div className="tt-rows">
            {bars.map(bar => (
              <div key={bar.key} className="tt-bar-wrap">
                <div className="tt-bar-head">
                  <span>{bar.label}</span>
                  <span>
                    <b>{bar.pctLabel}</b>
                    {bar.resetLabel ? <em> · {bar.resetLabel}</em> : null}
                  </span>
                </div>
                <div className="tt-bar"><i style={{width: Math.min(100, Math.max(0, bar.pct)) + '%'}}/></div>
              </div>
            ))}
            {extra && extra.is_enabled ? (
              <div className="tt-kv">
                <span>Extra credits</span>
                <b>
                  {/* Anthropic ships used_credits / monthly_limit as integer
                     cents — 18734 means $187.34, not $18,734. */}
                  ${((extra.used_credits || 0) / 100).toFixed(2)} / ${((extra.monthly_limit || 0) / 100).toFixed(2)}
                  {extra.currency ? <em>{extra.currency}</em> : null}
                </b>
              </div>
            ) : null}
          </div>
        ) : (
          <div style={{fontFamily: 'var(--mono-font)', fontSize: 11, color: 'var(--text-3)'}}>
            No usage data yet.
          </div>
        )}
      </div>
      <div className="tt-section" style={{padding: '6px 14px 8px'}}>
        <span style={{fontFamily: 'var(--mono-font)', fontSize: 10, color: footerColor}}>
          {errored ? `Last update failed · ` : `Updated `}{fetchedLabel}
        </span>
      </div>
    </>
  );
}

function ClaudeCodeTokenCard({ usage, planUsage }){
  const input      = usage.inputTokens      || 0;
  const output     = usage.outputTokens     || 0;
  const cacheRead  = usage.cacheReadTokens  || 0;
  const cacheWrite = usage.cacheWriteTokens || 0;
  const total      = input + output;
  const cost       = typeof usage.costUsd === 'number' ? usage.costUsd : 0;
  return (
    <>
      <div className="tt-header">
        <span className="tt-eye">Session usage</span>
      </div>
      <h4 className="tt-h">
        {_fmtTokensShort(total)} tokens
        {cost > 0 ? <span className="u-dim"> · ${_fmtCost(cost)}</span> : null}
      </h4>
      <div className="tt-section">
        <div className="tt-section-label">Breakdown</div>
        <div className="tt-rows">
          <div className="tt-kv"><span>Input</span><b>{_fmtInt(input)}</b></div>
          <div className="tt-kv"><span>Output</span><b>{_fmtInt(output)}</b></div>
          {cacheRead > 0 && (
            <div className="tt-kv"><span>Cache read</span><b>{_fmtInt(cacheRead)}</b></div>
          )}
          {cacheWrite > 0 && (
            <div className="tt-kv"><span>Cache write</span><b>{_fmtInt(cacheWrite)}</b></div>
          )}
        </div>
      </div>
      {planUsage ? <PlanUsageSection data={planUsage}/> : null}
    </>
  );
}

function _formatResetDate(epochSeconds){
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return '';
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function _fmtCredits(n){
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 10)   return n.toFixed(0);
  return n.toFixed(2);
}

function _humanizeSubscriptionTitle(title){
  if (!title || typeof title !== 'string') return 'Plan';
  return title
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function KiroPlanUsageSection({ data }){
  const usage = data && data.usage;
  const sub = usage && usage.subscription;
  const breakdown = usage && usage.breakdown;
  const tier = _humanizeSubscriptionTitle(sub && sub.subscriptionTitle);
  const fetchedLabel = _formatFetchedAt(data && data.fetchedAt);
  const errored = !!(data && data.lastError);
  const stale = !!(data && data.stale);
  const footerColor = errored
    ? 'var(--status-error)'
    : (stale ? 'var(--status-warning)' : 'var(--text-3)');

  const used = breakdown && typeof breakdown.currentUsageWithPrecision === 'number'
    ? breakdown.currentUsageWithPrecision
    : (breakdown && breakdown.currentUsage);
  const limit = breakdown && typeof breakdown.usageLimitWithPrecision === 'number'
    ? breakdown.usageLimitWithPrecision
    : (breakdown && breakdown.usageLimit);
  const pct = (typeof used === 'number' && typeof limit === 'number' && limit > 0)
    ? Math.min(100, Math.max(0, (used / limit) * 100))
    : null;
  const unitLabel = breakdown && breakdown.displayNamePlural || 'Credits';
  const resetLabel = breakdown && typeof breakdown.nextDateReset === 'number'
    ? `resets ${_formatResetDate(breakdown.nextDateReset)}`
    : (usage && typeof usage.nextDateReset === 'number' ? `resets ${_formatResetDate(usage.nextDateReset)}` : '');

  const overageEnabled = usage && usage.overageStatus === 'ENABLED';
  const hasOverage = !!(breakdown && typeof breakdown.currentOveragesWithPrecision === 'number'
    && breakdown.currentOveragesWithPrecision > 0);
  const overageCount = breakdown && (typeof breakdown.currentOveragesWithPrecision === 'number'
    ? breakdown.currentOveragesWithPrecision : breakdown.currentOverages) || 0;
  const overageCharges = breakdown && typeof breakdown.overageCharges === 'number'
    ? breakdown.overageCharges : 0;
  const bonuses = breakdown && Array.isArray(breakdown.bonuses) ? breakdown.bonuses : [];

  return (
    <>
      <div className="tt-section">
        <div className="tt-section-label">Account · {tier}</div>
        {breakdown ? (
          <div className="tt-rows">
            <div className="tt-bar-wrap">
              <div className="tt-bar-head">
                <span>{unitLabel}</span>
                <span>
                  <b>{_fmtCredits(used)} / {_fmtCredits(limit)}</b>
                  {resetLabel ? <em> · {resetLabel}</em> : null}
                </span>
              </div>
              {pct != null ? (
                <div className="tt-bar"><i style={{width: pct + '%'}}/></div>
              ) : null}
            </div>
            {overageEnabled ? (
              <div className="tt-kv">
                <span>Overage</span>
                <b>
                  {hasOverage
                    ? <>{_fmtCredits(overageCount)} {unitLabel.toLowerCase()} · ${overageCharges.toFixed(2)}</>
                    : <>Enabled · none used</>}
                </b>
              </div>
            ) : null}
            {bonuses.length > 0 ? (
              <div className="tt-kv">
                <span>Bonus credits</span>
                <b>{bonuses.length}</b>
              </div>
            ) : null}
          </div>
        ) : (
          <div style={{fontFamily: 'var(--mono-font)', fontSize: 11, color: 'var(--text-3)'}}>
            No usage data yet.
          </div>
        )}
      </div>
      <div className="tt-section" style={{padding: '6px 14px 8px'}}>
        <span style={{fontFamily: 'var(--mono-font)', fontSize: 10, color: footerColor}}>
          {errored ? `Last update failed · ` : `Updated `}{fetchedLabel}
        </span>
      </div>
    </>
  );
}

function KiroTokenCard({ usage, planUsage }){
  const input  = usage.inputTokens  || 0;
  const output = usage.outputTokens || 0;
  const total  = input + output;
  const pctRaw = typeof usage.contextUsagePercentage === 'number' ? usage.contextUsagePercentage : null;
  const pct    = pctRaw == null ? 0 : pctRaw;
  const pctStr = pct.toFixed(2) + '%';
  return (
    <>
      <div className="tt-header">
        <span className="tt-eye">Session usage</span>
      </div>
      <h4 className="tt-h">
        {pctRaw != null ? <>{pctStr} context</> : <>{_fmtTokensShort(total)} tokens</>}
        {pctRaw != null && total > 0 ? (
          <span className="u-dim"> · {_fmtTokensShort(total)} tokens</span>
        ) : null}
      </h4>
      {pctRaw != null ? (
        <div className="tt-section">
          <div className="tt-section-label">Context window</div>
          <div className="tt-bar-wrap">
            <div className="tt-bar-head">
              <span><b>{pctStr}</b> <em>used</em></span>
            </div>
            <div className="tt-bar"><i style={{width: Math.min(100, Math.max(0, pct)) + '%'}}/></div>
          </div>
        </div>
      ) : null}
      {total > 0 ? (
        <div className="tt-section">
          <div className="tt-section-label">Tokens</div>
          <div className="tt-rows">
            <div className="tt-kv"><span>Input</span><b>{_fmtInt(input)}</b></div>
            <div className="tt-kv"><span>Output</span><b>{_fmtInt(output)}</b></div>
          </div>
        </div>
      ) : null}
      {planUsage ? <KiroPlanUsageSection data={planUsage}/> : null}
    </>
  );
}

function DefaultTokenCard({ usage }){
  const input  = usage.inputTokens  || 0;
  const output = usage.outputTokens || 0;
  const total  = input + output;
  const cost   = typeof usage.costUsd === 'number' ? usage.costUsd : 0;
  return (
    <>
      <div className="tt-header">
        <span className="tt-eye">Session usage</span>
      </div>
      <h4 className="tt-h">
        {_fmtTokensShort(total)} tokens
        {cost > 0 ? <span className="u-dim"> · ${_fmtCost(cost)}</span> : null}
      </h4>
      {total > 0 ? (
        <div className="tt-section">
          <div className="tt-section-label">Tokens</div>
          <div className="tt-rows">
            <div className="tt-kv"><span>Input</span><b>{_fmtInt(input)}</b></div>
            <div className="tt-kv"><span>Output</span><b>{_fmtInt(output)}</b></div>
          </div>
        </div>
      ) : null}
    </>
  );
}

const CHIP_RENDERERS = {
  'claude-code': {
    renderChipText(usage){
      const total = (usage.inputTokens || 0) + (usage.outputTokens || 0);
      if (total === 0) return null;
      const cost = typeof usage.costUsd === 'number' ? usage.costUsd : 0;
      const tokensLabel = _fmtTokensShort(total);
      return cost > 0 ? `${tokensLabel} · $${_fmtCost(cost)}` : tokensLabel;
    },
    renderTooltipCard(usage, opts){
      return <ClaudeCodeTokenCard usage={usage} planUsage={opts && opts.planUsage}/>;
    },
  },
  'kiro': {
    renderChipText(usage){
      const total = (usage.inputTokens || 0) + (usage.outputTokens || 0);
      const pct   = typeof usage.contextUsagePercentage === 'number' ? usage.contextUsagePercentage : null;
      if (pct == null && total === 0) return null;
      const tokensLabel = total > 0 ? _fmtTokensShort(total) : '';
      if (pct != null && tokensLabel) return `${pct.toFixed(2)}% context · ${tokensLabel}`;
      if (pct != null) return `${pct.toFixed(2)}% context`;
      return tokensLabel;
    },
    renderTooltipCard(usage, opts){
      return <KiroTokenCard usage={usage} planUsage={opts && opts.planUsage}/>;
    },
  },
};

const DEFAULT_CHIP_RENDERER = {
  renderChipText(usage){
    const total = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    if (total === 0) return null;
    const cost = typeof usage.costUsd === 'number' ? usage.costUsd : 0;
    const tokensLabel = _fmtTokensShort(total);
    return cost > 0 ? `${tokensLabel} · $${_fmtCost(cost)}` : tokensLabel;
  },
  renderTooltipCard(usage){ return <DefaultTokenCard usage={usage}/>; },
};

function getChipRenderer(backendId){
  return (backendId && CHIP_RENDERERS[backendId]) || DEFAULT_CHIP_RENDERER;
}

window.getChipRenderer = getChipRenderer;
