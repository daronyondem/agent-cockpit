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

function ClaudeCodeTokenCard({ usage }){
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
    </>
  );
}

function KiroTokenCard({ usage }){
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
    renderTooltipCard(usage){ return <ClaudeCodeTokenCard usage={usage}/>; },
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
    renderTooltipCard(usage){ return <KiroTokenCard usage={usage}/>; },
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
