import type {
  BackendGoalCapability,
  GoalEvent,
  GoalEventKind,
  ThreadGoal,
  ThreadGoalBackend,
  ThreadGoalStatus,
  ThreadGoalSupportedActions,
} from '../../types';

export function supportedActionsFromGoalCapability(capability: BackendGoalCapability): ThreadGoalSupportedActions {
  return {
    clear: capability.clear === true,
    stopTurn: true,
    pause: capability.pause === true,
    resume: capability.resume === true,
  };
}

export function createRuntimeGoalSnapshot(args: {
  backendId: string;
  objective: string;
  sessionId?: string | null;
  threadId?: string | null;
  supportedActions: ThreadGoalSupportedActions;
}): ThreadGoal {
  const now = Date.now();
  return {
    backend: normalizeGoalBackend(args.backendId),
    threadId: args.threadId || null,
    sessionId: args.sessionId || null,
    objective: cleanGoalObjectiveText(args.objective),
    status: 'active',
    supportedActions: args.supportedActions,
    tokenBudget: null,
    tokensUsed: null,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
    source: 'runtime',
  };
}

export function goalEventFromGoal(kind: GoalEventKind, goal: ThreadGoal, reason?: string | null): GoalEvent {
  const normalizedGoal = normalizeGoalSnapshot(goal);
  return {
    kind,
    backend: normalizedGoal.backend,
    objective: normalizedGoal.objective,
    status: normalizedGoal.status,
    reason: reason ?? normalizedGoal.lastReason ?? null,
    goal: normalizedGoal,
  };
}

export function goalEventFromStatus(goal: ThreadGoal): GoalEvent | null {
  const normalizedGoal = normalizeGoalSnapshot(goal);
  if (normalizedGoal.status === 'complete') return goalEventFromGoal('achieved', normalizedGoal);
  if (normalizedGoal.status === 'budgetLimited') return goalEventFromGoal('budget_limited', normalizedGoal);
  if (normalizedGoal.status === 'paused') return goalEventFromGoal('paused', normalizedGoal);
  if (normalizedGoal.status === 'cleared') return goalEventFromGoal('cleared', normalizedGoal);
  if (normalizedGoal.status === 'unknown' && normalizedGoal.lastReason) return goalEventFromGoal('unknown', normalizedGoal);
  return null;
}

export function clearGoalEvent(backendId: string, objective?: string | null, reason?: string | null): GoalEvent {
  return {
    kind: 'cleared',
    backend: normalizeGoalBackend(backendId),
    objective: objective ? cleanGoalObjectiveText(objective) : undefined,
    status: 'cleared',
    reason: reason || null,
    goal: null,
  };
}

export function formatGoalEventMessage(event: GoalEvent): string {
  const title = goalEventTitle(event);
  const objective = event.objective ? cleanGoalObjectiveText(event.objective) : '';
  const reason = event.reason?.trim();
  const parts = objective ? [`${title}: ${objective}`] : [title];
  if (reason) parts.push(reason);
  return parts.join('\n\n');
}

export function goalEventDedupeKey(event: GoalEvent): string {
  return [
    event.kind,
    event.backend || '',
    event.status || '',
    event.objective || '',
    event.reason || '',
  ].join('|');
}

export function goalEventTitle(event: Pick<GoalEvent, 'kind' | 'status'>): string {
  if (event.kind === 'set') return 'Goal set';
  if (event.kind === 'resumed') return 'Goal resumed';
  if (event.kind === 'paused') return 'Goal paused';
  if (event.kind === 'achieved') return 'Goal achieved';
  if (event.kind === 'budget_limited') return 'Goal budget limited';
  if (event.kind === 'cleared') return 'Goal cleared';
  if (event.status) return goalStatusTitle(event.status);
  return 'Goal updated';
}

export function normalizeGoalSnapshot(goal: ThreadGoal): ThreadGoal {
  const objective = cleanGoalObjectiveText(goal.objective);
  if (objective === goal.objective) return goal;
  return { ...goal, objective };
}

export function cleanGoalObjectiveText(value: string | null | undefined): string {
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
      /^Goal\s*(?:set(?=\s|:|codex|claude-code|$)|resumed(?=\s|:|codex|claude-code|$)|paused(?=\s|:|codex|claude-code|$)|achieved(?=\s|:|codex|claude-code|$)|budget\s*limited(?=\s|:|codex|claude-code|$)|cleared(?=\s|:|codex|claude-code|$)|updated(?=\s|:|codex|claude-code|$))\s*:?\s*/i,
      '',
    ).trim();
    if (withoutEventPrefix !== text) {
      text = withoutEventPrefix;
      strippedPrefix = true;
    }
    if (strippedPrefix) text = text.replace(/^(?:codex|claude-code)\s*/i, '').trim();
    if (text === before) break;
  }

  return text;
}

function goalStatusTitle(status: ThreadGoalStatus): string {
  if (status === 'active') return 'Goal active';
  if (status === 'paused') return 'Goal paused';
  if (status === 'complete') return 'Goal achieved';
  if (status === 'budgetLimited') return 'Goal budget limited';
  if (status === 'cleared') return 'Goal cleared';
  return 'Goal updated';
}

function normalizeGoalBackend(backendId: string): ThreadGoalBackend | undefined {
  if (backendId === 'codex' || backendId === 'claude-code') return backendId;
  return undefined;
}
