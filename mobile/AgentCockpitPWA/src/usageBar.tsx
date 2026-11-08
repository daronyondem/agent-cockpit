import type { Usage } from './types';
import { formatPercent } from './appModel';
import { isUsageCostUnavailable, usageTokenTotal } from '../../../src/contracts/usagePresentation';

export function UsageBar({ usage, backend }: { usage?: Usage; backend?: string }) {
  if (!usage) {
    return null;
  }
  const tokens = usageTokenTotal(usage);
  const context = usage.contextUsagePercentage ?? 0;
  const cortex = backend === 'cortex-code';
  const reportedCost = Number(usage.costUsd) || 0;
  const estimatedCost = Number(usage.estimatedCostUsd) || 0;
  const unavailable = isUsageCostUnavailable(usage, backend);
  const estimatedCostLabel = estimatedCost > 0 ? `$${Math.ceil(estimatedCost).toLocaleString()}` : unavailable || backend === 'grok-build' ? 'n/a' : '$0';
  return (
    <>
      <div className="usage-bar">
        <div>
          <span className="usage-label">Tokens</span>
          <span className="usage-value">{tokens.toLocaleString()}</span>
          <span className="usage-track"><i style={{ width: `${Math.min(100, Math.max(cortex ? 0 : 4, context))}%` }} /></span>
        </div>
        <div>
          <span className="usage-label">{backend === 'grok-build' ? 'Reported model cost' : 'Cost'}</span>
          <span className="usage-value">{unavailable ? 'n/a' : `$${reportedCost.toFixed(4)}`}</span>
          <span className="usage-track"><i style={{ width: `${reportedCost > 0 ? 18 : 4}%` }} /></span>
        </div>
        <div>
          <span className="usage-label">Estimated Cost</span>
          <span className="usage-value">{estimatedCostLabel}</span>
          <span className="usage-track"><i style={{ width: `${estimatedCost > 0 ? 18 : 4}%` }} /></span>
        </div>
        <div>
          <span className="usage-label">Context</span>
          <span className="usage-value">{usage.contextUsagePercentage !== undefined ? formatPercent(usage.contextUsagePercentage) : 'n/a'}</span>
          <span className="usage-track"><i style={{ width: `${Math.min(100, Math.max(cortex ? 0 : 4, context))}%` }} /></span>
        </div>
      </div>
      {cortex ? <details className="usage-breakdown">
        <summary>Token breakdown</summary>
        <dl>{[
          ['Fresh input', usage.inputTokens], ['Output', usage.outputTokens],
          ['Cache read', usage.cacheReadTokens], ['Cache write', usage.cacheWriteTokens],
        ].map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{Number(count || 0).toLocaleString()}</dd></div>)}</dl>
        <p>Snowflake pricing is unavailable. Costs exclude unpriced CoCo usage.</p>
      </details> : null}
    </>
  );
}
