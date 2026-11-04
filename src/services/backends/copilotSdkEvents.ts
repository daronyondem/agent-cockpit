import type { SessionEvent } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import type { StreamEvent } from '../../types';
import { copilotToolStartEvents, copilotToolCompleteEvents } from './copilotTools';

export interface CopilotSdkEventState {
  textDeltas: ReadonlySet<string>;
  textFinals: ReadonlySet<string>;
  reasoningDeltas: ReadonlySet<string>;
  reasoningFinals: ReadonlySet<string>;
  tools: ReadonlyMap<string, string>;
  finishedTools: ReadonlySet<string>;
  hasOutput: boolean;
  started: boolean;
  idle: boolean;
  error: string | null;
  lastEventId?: string;
}

export function createCopilotSdkEventState(): CopilotSdkEventState {
  return { textDeltas: new Set(), textFinals: new Set(), reasoningDeltas: new Set(), reasoningFinals: new Set(),
    tools: new Map(), finishedTools: new Set(), hasOutput: false, started: false, idle: false, error: null };
}

/** Pure projection. Session-wide idle, rather than a model-loop turn end, completes a stream. */
export function reduceCopilotSdkEvent(previous: CopilotSdkEventState, event: SessionEvent): { state: CopilotSdkEventState; events: StreamEvent[] } {
  if (previous.idle || previous.error || (event.id && previous.lastEventId === event.id)) return { state: previous, events: [] };
  const state = { ...previous, lastEventId: event.id };
  const events: StreamEvent[] = [];
  const data = event.data as unknown as Record<string, unknown>;
  const output = event.type === 'tool.execution_start' || event.type === 'assistant.message'
    || event.type === 'assistant.message_delta' || event.type === 'assistant.reasoning' || event.type === 'assistant.reasoning_delta' || event.type === 'subagent.started';
  // Child activity prevents recovery/replay, but never enters the root answer.
  if (output) state.hasOutput = true;
  if (event.agentId || data.parentToolCallId) return { state, events };
  if (event.type === 'user.message' || event.type === 'assistant.turn_start' || output) state.started = true;

  switch (event.type) {
    case 'assistant.message_delta':
      if (event.data.deltaContent && !state.textFinals.has(event.data.messageId)) {
        state.textDeltas = new Set([...state.textDeltas, event.data.messageId]);
        events.push({ type: 'text', content: event.data.deltaContent, streaming: true });
      }
      break;
    case 'assistant.message':
      if (!state.textFinals.has(event.data.messageId)) {
        state.textFinals = new Set([...state.textFinals, event.data.messageId]);
        if (!state.textDeltas.has(event.data.messageId) && event.data.content) events.push({ type: 'text', content: event.data.content, streaming: false });
      }
      break;
    case 'assistant.reasoning_delta':
      if (event.data.deltaContent && !state.reasoningFinals.has(event.data.reasoningId)) {
        state.reasoningDeltas = new Set([...state.reasoningDeltas, event.data.reasoningId]);
        events.push({ type: 'thinking', content: event.data.deltaContent, streaming: true });
      }
      break;
    case 'assistant.reasoning':
      if (!state.reasoningFinals.has(event.data.reasoningId)) {
        state.reasoningFinals = new Set([...state.reasoningFinals, event.data.reasoningId]);
        if (!state.reasoningDeltas.has(event.data.reasoningId) && event.data.content) events.push({ type: 'thinking', content: event.data.content, streaming: false });
      }
      break;
    case 'tool.execution_start':
      if (!state.tools.has(event.data.toolCallId) && !state.finishedTools.has(event.data.toolCallId)) {
        state.tools = new Map([...state.tools, [event.data.toolCallId, event.data.toolName]]);
        events.push(...copilotToolStartEvents({ ...event.data }));
      }
      break;
    case 'tool.execution_complete':
      if (!state.finishedTools.has(event.data.toolCallId)) {
        state.finishedTools = new Set([...state.finishedTools, event.data.toolCallId]);
        events.push(...copilotToolCompleteEvents({ ...event.data, toolName: state.tools.get(event.data.toolCallId) }));
        const tools = new Map(state.tools); tools.delete(event.data.toolCallId); state.tools = tools;
      }
      break;
    case 'session.error':
      state.error = event.data.message || 'Copilot session failed.';
      events.push({ type: 'error', error: state.error });
      break;
    case 'session.idle':
      if (state.started) {
        state.idle = true;
        if (event.data.aborted) {
          state.error = 'Copilot turn aborted.';
          events.push({ type: 'error', error: state.error, source: 'abort' });
        }
      }
      break;
  }
  return { state, events };
}
