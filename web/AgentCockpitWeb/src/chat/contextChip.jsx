import React from 'react';

import { getChipRenderer } from '../chip-renderers.jsx';
import { PlanUsageStore } from '../planUsageStore.js';
import { KiroPlanUsageStore } from '../kiroPlanUsageStore.js';
import { CodexPlanUsageStore } from '../codexPlanUsageStore.js';
import { GrokPlanUsageStore } from '../grokPlanUsageStore.js';
import { CopilotPlanUsageStore } from '../copilotPlanUsageStore.js';
import { Tip } from '../tooltip.jsx';
import { CLAUDE_CODE_INTERACTIVE_BACKEND_ID } from './chatHelpers.js';

function isClaudeCodeFamilyBackend(backendId){
  return backendId === 'claude-code' || backendId === CLAUDE_CODE_INTERACTIVE_BACKEND_ID;
}

function shouldShowClaudePlanUsage(backendId, cliProfile){
  if (!isClaudeCodeFamilyBackend(backendId)) return false;
  if (!cliProfile || cliProfile.harness !== 'claude-code') return true;
  return (cliProfile.claudeCode?.provider || 'anthropic') === 'anthropic';
}

export function ContextChip({ backendId, cliProfileId, cliProfile, usage }){
  const renderer = getChipRenderer(backendId);
  const store = shouldShowClaudePlanUsage(backendId, cliProfile) ? PlanUsageStore
    : backendId === 'kiro'        ? KiroPlanUsageStore
    : backendId === 'codex'       ? CodexPlanUsageStore
    : backendId === 'grok-build'  ? GrokPlanUsageStore
    : backendId === 'copilot'     ? CopilotPlanUsageStore
    : null;
  const profileKey = `${backendId || ''}:${cliProfileId || ''}`;
  const [planUsageState, setPlanUsageState] = React.useState(() => ({
    key: profileKey,
    data: store ? store.get(cliProfileId) : null,
  }));
  React.useEffect(() => {
    if (!store) {
      setPlanUsageState({ key: profileKey, data: null });
      return;
    }
    setPlanUsageState({ key: profileKey, data: store.get(cliProfileId) });
    const unsub = store.subscribe(
      data => setPlanUsageState({ key: profileKey, data }),
      cliProfileId,
    );
    store.refresh(cliProfileId);
    const interval = backendId === 'copilot' ? window.setInterval(() => store.refresh(cliProfileId), 60_000) : null;
    return () => { unsub(); if (interval) window.clearInterval(interval); };
  }, [backendId, store, profileKey, cliProfileId]);
  const planUsage = planUsageState.key === profileKey
    ? planUsageState.data
    : (store ? store.get(cliProfileId) : null);
  const chipText = renderer.renderChipText(usage);
  if (chipText == null) return null;
  const card = renderer.renderTooltipCard(usage, { planUsage });
  const chip = (
    <span
      className="u-mono"
      aria-label="Session usage"
      tabIndex={0}
      style={{fontSize:11,color:"var(--text-3)",padding:"0 6px",cursor:"help"}}
    >
      {chipText}
    </span>
  );
  if (!card) return chip;
  return <Tip variant="stat" rich={card}>{chip}</Tip>;
}
