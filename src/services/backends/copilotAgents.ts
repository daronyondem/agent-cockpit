import type { SessionEvent } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import type { StreamEvent, ToolOutcome } from '../../types';
import { copilotToolStartEvents, copilotToolCompleteEvents } from './copilotTools';

interface Tool { name: string; rawId: string; owner: string | null }
interface Agent { id: string; cardId: string; rootCardId: string; rawId: string; ended: boolean; summary?: string }
export interface CopilotWorkState {
  namespace: string;
  tools: ReadonlyMap<string, Tool>;
  agents: ReadonlyMap<string, Agent>;
  finishedTools: ReadonlySet<string>;
}
export const createCopilotWorkState = (namespace: string): CopilotWorkState => ({ namespace, tools: new Map(), agents: new Map(), finishedTools: new Set() });
export const copilotToolId = (state: CopilotWorkState, owner: string | null, id: string): string => `copilot:${state.namespace}:${JSON.stringify([owner, id])}`;
const summary = (value: string): string => value.length > 4000 ? value.slice(0, 4000) + '…' : value;
const unique = <T>(values: T[]): T | undefined => values.length === 1 ? values[0] : undefined;

/** Pure ownership projection. Child prose becomes a bounded card summary only. */
export function reduceCopilotWork(previous: CopilotWorkState, event: SessionEvent): { state: CopilotWorkState; events: StreamEvent[]; handled: boolean } {
  const data = event.data as unknown as Record<string, unknown>;
  const child = !!(event.agentId || data.parentToolCallId);
  const lifecycle = event.type === 'subagent.started' || event.type === 'subagent.completed' || event.type === 'subagent.failed';
  const toolEvent = event.type === 'tool.execution_start' || event.type === 'tool.execution_complete';
  if (!lifecycle && !toolEvent && !(child && event.type === 'assistant.message')) return { state: previous, events: [], handled: child };
  const state = { ...previous, tools: new Map(previous.tools), agents: new Map(previous.agents), finishedTools: new Set(previous.finishedTools) };
  const events: StreamEvent[] = [];
  const result = () => ({ state, events, handled: true });
  if (event.type === 'subagent.started') {
    const rawId = event.data.toolCallId;
    const pending = unique([...state.tools.values()].filter(tool => tool.name === 'task' && tool.rawId === rawId));
    const parentId = event.data.parentId || pending?.owner || null;
    const parent = parentId ? state.agents.get(parentId) : undefined;
    if (parentId && !parent) return result();
    const cardId = copilotToolId(state, parentId, rawId);
    const id = event.agentId || `legacy:${cardId}`;
    if (state.agents.has(id) || state.finishedTools.has(cardId)) return result();
    // Without native ancestry, a reused tool ID cannot establish a safe owner.
    if (!event.data.parentId && !pending && [...state.tools.values()].filter(tool => tool.name === 'task' && tool.rawId === rawId).length > 1) return result();
    const rootCardId = parent?.rootCardId || cardId;
    state.agents.set(id, { id, cardId, rootCardId, rawId, ended: false });
    state.tools.set(cardId, { name: 'task', rawId, owner: parentId });
    const label = event.data.agentDescription || event.data.agentDisplayName || event.data.agentName;
    events.push({ type: 'tool_activity', tool: 'Agent', id: cardId, isAgent: true, subagentType: event.data.agentType || event.data.agentName,
      description: event.data.executionMode === 'background' ? `Background: ${label}` : label,
      ...(parent ? { parentAgentId: rootCardId } : {}) });
    return result();
  }
  const agent = event.agentId ? state.agents.get(event.agentId)
    : typeof data.parentToolCallId === 'string' ? unique([...state.agents.values()].filter(value => value.rawId === data.parentToolCallId)) : undefined;
  if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
    const completed = event.agentId ? agent : agent || unique([...state.agents.values()].filter(value => value.rawId === event.data.toolCallId));
    if (!completed || completed.ended) return result();
    const failed = event.type === 'subagent.failed';
    const cancelled = event.type === 'subagent.completed' && event.data.cancelled === true;
    state.agents.set(completed.id, { ...completed, ended: true });
    state.finishedTools.add(completed.cardId);
    const detail = failed ? summary(event.data.error) : completed.summary;
    events.push({ type: 'tool_outcomes', outcomes: [{ toolUseId: completed.cardId, isError: failed,
      outcome: failed ? 'failed' : cancelled ? 'cancelled' : 'done', status: failed ? 'error' : cancelled ? 'warning' : 'success',
      ...(detail ? { summary: detail } : {}) }] });
    return result();
  }
  if (child && (!agent || agent.ended)) return result();
  if (event.type === 'assistant.message') {
    if (agent && event.data.content.trim() && !event.data.toolRequests?.length) state.agents.set(agent.id, { ...agent, summary: summary(event.data.content.trim()) });
    return result();
  }
  if (!toolEvent) return result();
  const owner = agent?.id || null;
  const rawId = String(data.toolCallId);
  const id = copilotToolId(state, owner, rawId);
  if (state.finishedTools.has(id)) return result();
  if (event.type === 'tool.execution_start') {
    if (state.tools.has(id)) return result();
    state.tools.set(id, { name: event.data.toolName, rawId, owner });
    if (event.data.toolName !== 'task') {
      events.push(...copilotToolStartEvents({ ...event.data, toolCallId: id }).map(frame => frame.type === 'tool_activity' && agent
        ? { ...frame, parentAgentId: agent.rootCardId } : frame));
    }
  } else if (event.type === 'tool.execution_complete') {
    const tool = state.tools.get(id);
    state.finishedTools.add(id);
    if (tool?.name === 'task') {
      // Background task acknowledgements are not child completion. The native
      // lifecycle event owns the card's outcome and final summary.
      if ([...state.agents.values()].some(value => value.cardId === id)) return result();
      events.push({ type: 'tool_activity', tool: 'Agent', id, isAgent: true, description: 'Subagent could not start',
        ...(agent ? { parentAgentId: agent.rootCardId } : {}) });
      events.push({ type: 'tool_outcomes', outcomes: [{ toolUseId: id, isError: true, outcome: 'failed', status: 'error',
        summary: summary(event.data.error?.message || event.data.result?.content || 'No native subagent lifecycle was reported.') }] });
    } else events.push(...copilotToolCompleteEvents({ ...event.data, toolCallId: id, toolName: tool?.name }));
    state.tools.delete(id);
  }
  return result();
}

export function finishCopilotWork(previous: CopilotWorkState, outcome: 'cancelled' | 'interrupted'): { state: CopilotWorkState; events: StreamEvent[] } {
  const agents = new Map(previous.agents);
  const finishedTools = new Set(previous.finishedTools);
  const outcomes: ToolOutcome[] = [];
  for (const agent of agents.values()) {
    if (agent.ended) continue;
    agents.set(agent.id, { ...agent, ended: true });
    outcomes.push({ toolUseId: agent.cardId, isError: false, outcome, status: 'warning' });
    finishedTools.add(agent.cardId);
  }
  for (const [id, tool] of previous.tools) {
    if (finishedTools.has(id) || tool.name === 'task') continue;
    outcomes.push({ toolUseId: id, isError: false, outcome, status: 'warning' });
    finishedTools.add(id);
  }
  return { state: { ...previous, agents, finishedTools }, events: outcomes.length ? [{ type: 'tool_outcomes', outcomes }] : [] };
}
