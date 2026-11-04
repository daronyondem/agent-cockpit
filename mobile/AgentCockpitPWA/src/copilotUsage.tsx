import { useEffect, useState } from 'react';
import type { CopilotQuotaSnapshot } from '../../../src/contracts/copilotUsage';
import type { AgentCockpitAPI } from './api';
import type { Usage } from './types';

const amount = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 9 });
const units = { premium_requests: 'premium requests', requests: 'requests', ai_credits: 'AI credits', tokens: 'tokens', unknown: 'quota units (unit not reported)' };

export function CopilotUsage({ usage }: { usage: Usage }) {
  const credit = usage.copilot;
  const values: Array<[string, string]> = [
    ['Fresh input', amount(usage.inputTokens)], ['Output', amount(usage.outputTokens)],
    ['Cache read', amount(usage.cacheReadTokens)], ['Cache write', amount(usage.cacheWriteTokens)],
    ['AI credits', credit?.aiCredits === undefined || credit.aiCreditsStatus === 'unavailable' ? 'Unavailable'
      : amount(credit.aiCredits) + (credit.aiCreditsStatus === 'partial' ? ' reported subtotal' : '')],
    ['Premium requests', credit?.premiumRequests === undefined ? 'Unavailable' : amount(credit.premiumRequests)],
    ['USD cost / estimate', 'Unavailable'],
    ['Context', usage.contextWindow?.status === 'available' ? `${amount(usage.contextWindow.usedTokens!)} / ${amount(usage.contextWindow.tokenLimit!)} tokens` : 'Unavailable'],
  ];
  if (credit?.tokensStatus && credit.tokensStatus !== 'complete') values.push(['Token totals', 'Incomplete; showing recorded usage']);
  if (usage.contextWindow?.status === 'available') values.push(['Context measured', new Date(usage.contextWindow.observedAt).toLocaleString()]);
  const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return <details className="copilot-usage-details" aria-label="Copilot session usage">
    <summary>Copilot usage · {amount(tokens)} tokens{usage.contextUsagePercentage !== undefined ? ` · ${usage.contextUsagePercentage.toFixed(1)}% context` : ''}</summary>
    <div className="usage-bar">
      {values.map(([label, value]) => <div key={label}><span className="usage-label">{label}</span><span className="usage-value">{value}</span></div>)}
    </div>
  </details>;
}

export function CopilotQuota({ client, profileId, refreshKey }: { client: AgentCockpitAPI; profileId?: string; refreshKey: number }) {
  const id = profileId || 'server-configured-copilot';
  const [state, setState] = useState<{ id: string; quota: CopilotQuotaSnapshot | null }>({ id, quota: null });
  useEffect(() => {
    let active = true;
    const refresh = () => client.getCopilotQuota(id).then(response => {
      if (active) setState({ id, quota: response.quota });
    }).catch(() => { if (active) setState({ id, quota: null }); });
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [client, id, refreshKey]);
  const quota = state.id === id ? state.quota : null;
  return <details className="copilot-usage-details" aria-label="Copilot account quota">
    <summary>Account quota · {quota?.stale ? 'stale' : quota?.status === 'available' ? 'reported reading' : 'unavailable'}</summary>
    <div className="usage-bar copilot-quota-grid">
    <div><span className="usage-label">Account quota{quota?.stale ? ' · stale' : ''}</span><span className="usage-value">{quota?.message || (quota?.status === 'available' ? 'Reported account reading' : 'Unavailable')}</span></div>
    {quota?.rows.map(row => <div key={row.id}><span className="usage-label">{row.label}</span><span className="usage-value">{amount(row.used!)} / {row.unlimited ? 'Unlimited' : amount(row.entitlement!)} {units[row.unit]}{typeof row.usedPercentage === 'number' ? ` · ${row.usedPercentage.toFixed(1)}% used` : ''}{row.resetAt ? ` · resets ${new Date(row.resetAt).toLocaleString()}` : ''}</span></div>)}
    {quota?.fetchedAt ? <div><span className="usage-label">Account reading</span><span className="usage-value">{new Date(quota.fetchedAt).toLocaleString()} · service updates may be delayed</span></div> : null}
    </div>
  </details>;
}
