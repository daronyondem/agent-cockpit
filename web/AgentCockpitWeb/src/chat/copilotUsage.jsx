const units = { premium_requests: 'premium requests', requests: 'requests', ai_credits: 'AI credits', tokens: 'tokens', unknown: 'quota units (unit not reported)' };
const amount = value => value.toLocaleString(undefined, { maximumFractionDigits: 9 });

export function CopilotUsageDetails({ usage, quota }) {
  const credit = usage.copilot;
  const aiCredits = credit?.aiCredits === undefined || credit.aiCreditsStatus === 'unavailable' ? 'Unavailable'
    : amount(credit.aiCredits) + (credit.aiCreditsStatus === 'partial' ? ' reported subtotal' : '');
  return <>
    <div className="tt-section">
      <div className="tt-section-label">Copilot billing units</div>
      <div className="tt-rows">
        <div className="tt-kv"><span>AI credits</span><b>{aiCredits}</b></div>
        <div className="tt-kv"><span>Premium requests</span><b>{typeof credit?.premiumRequests === 'number' ? amount(credit.premiumRequests) : 'Unavailable'}</b></div>
        <div className="tt-kv"><span>USD cost / estimate</span><b>Unavailable</b></div>
        {credit?.tokensStatus && credit.tokensStatus !== 'complete' ? <div>Token totals are incomplete; showing recorded usage.</div> : null}
        {usage.contextWindow ? <div>Context {usage.contextWindow.status === 'available'
          ? `${amount(usage.contextWindow.usedTokens)} / ${amount(usage.contextWindow.tokenLimit)} tokens · measured ${new Date(usage.contextWindow.observedAt).toLocaleString()}`
          : 'unavailable'}</div> : null}
      </div>
    </div>
    <div className="tt-section" aria-label="Copilot account quota">
      <div className="tt-section-label">Copilot account quota{quota?.stale ? ' · stale' : ''}</div>
      {quota?.status === 'available' ? quota.rows.map(row => <div className="tt-kv" key={row.id}>
        <span>{row.label}</span><b>{amount(row.used)} / {row.unlimited ? 'Unlimited' : amount(row.entitlement)} {units[row.unit]}
          {typeof row.usedPercentage === 'number' ? ` · ${row.usedPercentage.toFixed(1)}% used` : ''}
          {row.resetAt ? ` · resets ${new Date(row.resetAt).toLocaleString()}` : ''}</b>
      </div>) : <div>{quota?.message || 'Account quota unavailable.'}</div>}
      {quota?.fetchedAt ? <div>Account reading {new Date(quota.fetchedAt).toLocaleString()} · service updates may be delayed.</div> : null}
      {quota?.stale && quota.message ? <div>{quota.message}</div> : null}
    </div>
  </>;
}
