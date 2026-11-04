import type { StreamEvent, ToolActivity } from './types';

export function applyLiveToolFrame(activities: ToolActivity[], frame: Extract<StreamEvent, { type: 'tool_activity' | 'tool_outcomes' }>, now: number): ToolActivity[] {
  if (frame.type === 'tool_activity') {
    if (frame.isQuestion || frame.isPlanMode || !frame.tool || (frame.id && activities.some(activity => activity.id === frame.id))) return activities;
    return [...activities, { tool: frame.tool, description: frame.description || '', id: frame.id || null, startTime: now, duration: null,
      ...(frame.isAgent ? { isAgent: true, subagentType: frame.subagentType } : {}), ...(frame.parentAgentId ? { parentAgentId: frame.parentAgentId } : {}) }];
  }
  return activities.map(activity => {
    const outcome = frame.outcomes?.find(item => item.toolUseId && item.toolUseId === activity.id);
    return outcome ? { ...activity, outcome: outcome.outcome || undefined, status: outcome.status || undefined,
      duration: activity.duration ?? Math.max(0, now - activity.startTime), ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}) } : activity;
  });
}
