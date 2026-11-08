import { isUsageCostUnavailable } from '../../../../src/contracts/usagePresentation';

export function CortexTokenCard({ usage }){
  const context = usage.contextUsagePercentage;
  const unavailable = isUsageCostUnavailable(usage, 'cortex-code');
  const rows = [
    ['Context', context === undefined ? 'n/a' : `${context.toFixed(2)}%`],
    ['Fresh input', (usage.inputTokens || 0).toLocaleString()],
    ['Output', (usage.outputTokens || 0).toLocaleString()],
    ['Cache read', (usage.cacheReadTokens || 0).toLocaleString()],
    ['Cache write', (usage.cacheWriteTokens || 0).toLocaleString()],
    ['Cost', unavailable ? 'n/a' : `$${(usage.costUsd || 0).toFixed(4)}`],
    ['Estimated Cost', unavailable ? 'n/a' : `$${Math.ceil(usage.estimatedCostUsd || 0).toLocaleString()}`],
  ];
  return <>
    <div className="tt-header"><span className="tt-eye">Session usage</span></div>
    <div className="tt-section">
      <div className="tt-rows">{rows.map(([label, value]) =>
        <div className="tt-kv" key={label}><span>{label}</span><b>{value}</b></div>)}</div>
      {context !== undefined ? <div className="tt-bar"><i style={{width: `${Math.min(100, Math.max(0, context))}%`}}/></div> : null}
    </div>
    <div className="tt-section">Snowflake pricing is unavailable. Costs exclude unpriced CoCo usage.</div>
  </>;
}
