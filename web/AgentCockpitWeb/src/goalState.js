export function goalTimestampMs(value){
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1e12 ? Math.floor(n) : Math.floor(n * 1000);
}

export function goalSnapshotTimeMs(goal){
  if (!goal || typeof goal !== 'object') return null;
  return goalTimestampMs(goal.updatedAt) || goalTimestampMs(goal.createdAt);
}

export function isActiveGoal(goal){
  return !!goal && goal.status === 'active';
}

export function goalElapsedSeconds(goal, nowMs = Date.now()){
  if (!goal || typeof goal !== 'object') return 0;
  const base = Math.max(0, Math.floor(Number(goal.timeUsedSeconds) || 0));
  if (!isActiveGoal(goal)) return base;
  const snapshotAt = goalSnapshotTimeMs(goal);
  if (!snapshotAt) return base;
  return base + Math.max(0, Math.floor((nowMs - snapshotAt) / 1000));
}
