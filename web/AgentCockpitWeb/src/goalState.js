export function goalTimestampMs(value){
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1e12 ? Math.floor(n) : Math.floor(n * 1000);
}

export function goalSnapshotTimeMs(goal){
  if (!goal || typeof goal !== 'object') return null;
  return goalTimestampMs(goal.updatedAt) || goalTimestampMs(goal.createdAt);
}

export function cleanGoalObjectiveText(value){
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  for (let i = 0; i < 4; i += 1) {
    const before = text;
    let strippedPrefix = false;
    const withoutStatusPrefix = text.replace(
      /^Goal\s*(?:active|paused|achieved|budget\s*limited|cleared|updated)(?=\s|:|\d|$)\s*(?:\d+\s*(?:s|m|h|sec|secs|seconds|min|mins|minutes|hr|hrs|hours)\s*)*/i,
      '',
    ).trim();
    if (withoutStatusPrefix !== text) {
      text = withoutStatusPrefix;
      strippedPrefix = true;
    }
    const withoutEventPrefix = text.replace(
      /^Goal\s*(?:set(?=\s|:|codex|claude-code|claude-code-interactive|$)|resumed(?=\s|:|codex|claude-code|claude-code-interactive|$)|paused(?=\s|:|codex|claude-code|claude-code-interactive|$)|achieved(?=\s|:|codex|claude-code|claude-code-interactive|$)|budget\s*limited(?=\s|:|codex|claude-code|claude-code-interactive|$)|cleared(?=\s|:|codex|claude-code|claude-code-interactive|$)|updated(?=\s|:|codex|claude-code|claude-code-interactive|$))\s*:?\s*/i,
      '',
    ).trim();
    if (withoutEventPrefix !== text) {
      text = withoutEventPrefix;
      strippedPrefix = true;
    }
    if (strippedPrefix) text = text.replace(/^(?:codex|claude-code|claude-code-interactive)\s*/i, '').trim();
    if (text === before) break;
  }
  return text;
}

export function isActiveGoal(goal){
  return !!goal && goal.status === 'active';
}

export function goalSupportsAction(goal, action){
  if (!goal || !action) return false;
  const actions = goal.supportedActions || {};
  if (Object.prototype.hasOwnProperty.call(actions, action)) return actions[action] === true;
  const backend = goal.backend || 'codex';
  if (action === 'clear' || action === 'stopTurn') return true;
  if (action === 'pause' || action === 'resume') return backend === 'codex';
  return false;
}

export function goalStatusLabel(status){
  if (status === 'active') return 'Goal active';
  if (status === 'paused') return 'Goal paused';
  if (status === 'complete') return 'Goal achieved';
  if (status === 'budgetLimited') return 'Goal budget limited';
  if (status === 'cleared') return 'Goal cleared';
  return 'Goal';
}

export function goalElapsedSeconds(goal, nowMs = Date.now()){
  if (!goal || typeof goal !== 'object') return 0;
  const base = Math.max(0, Math.floor(Number(goal.timeUsedSeconds) || 0));
  if (!isActiveGoal(goal)) return base;
  const snapshotAt = goalSnapshotTimeMs(goal);
  if (!snapshotAt) return base;
  return base + Math.max(0, Math.floor((nowMs - snapshotAt) / 1000));
}
