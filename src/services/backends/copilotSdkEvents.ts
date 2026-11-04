import type { SessionEvent } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import type { StreamEvent } from '../../types';
import { createCopilotWorkState, reduceCopilotWork, finishCopilotWork, type CopilotWorkState } from './copilotAgents';

export interface CopilotSdkEventState {
  textDeltas: ReadonlySet<string>;
  textFinals: ReadonlySet<string>;
  reasoningDeltas: ReadonlySet<string>;
  reasoningFinals: ReadonlySet<string>;
  work: CopilotWorkState;
  hasOutput: boolean;
  started: boolean;
  idle: boolean;
  error: string | null;
  lastEventId?: string;
}

export function createCopilotSdkEventState(namespace = 'turn'): CopilotSdkEventState {
  return { textDeltas: new Set(), textFinals: new Set(), reasoningDeltas: new Set(), reasoningFinals: new Set(),
    work: createCopilotWorkState(namespace), hasOutput: false, started: false, idle: false, error: null };
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
  if (!event.agentId && !data.parentToolCallId && (event.type === 'user.message' || event.type === 'assistant.turn_start' || output)) state.started = true;
  const work = reduceCopilotWork(state.work, event);
  state.work = work.state;
  if (work.handled) return { state, events: work.events };
  if (event.agentId || data.parentToolCallId) return { state, events };

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
    case 'session.error':
      { const ended = finishCopilotWork(state.work, 'interrupted'); state.work = ended.state; events.push(...ended.events); }
      state.error = event.data.message || 'Copilot session failed.';
      events.push({ type: 'error', error: state.error });
      break;
    case 'session.idle':
      if (state.started) {
        const ended = finishCopilotWork(state.work, event.data.aborted ? 'cancelled' : 'interrupted');
        state.work = ended.state; events.push(...ended.events);
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
