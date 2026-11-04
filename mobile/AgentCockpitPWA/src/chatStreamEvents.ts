import type {
  ConversationListItem,
  ConversationArtifact,
  Message,
  PendingInteraction,
  StreamEvent,
  ThreadGoal,
  Usage,
} from './types';

export type StreamEventNotification = {
  title: string;
  body: string;
};

export type ChatStreamEventAction =
  | { type: 'set-stream-placeholder'; value: boolean }
  | { type: 'append-stream-text'; content: string }
  | { type: 'set-stream-text'; value: string }
  | { type: 'clear-stream-tools' }
  | { type: 'clear-stream-artifacts' }
  | { type: 'append-stream-artifact'; artifact: ConversationArtifact }
  | { type: 'update-stream-tools'; frame: Extract<StreamEvent, { type: 'tool_activity' | 'tool_outcomes' }> }
  | { type: 'upsert-message'; message: Message }
  | { type: 'set-pending-interaction'; interaction: PendingInteraction }
  | { type: 'set-input-turn'; turnId: string | null }
  | { type: 'resolve-input-requests'; requestIds: string[] }
  | { type: 'update-title'; title: string }
  | { type: 'update-usage'; usage: Usage | undefined; sessionUsage: Usage | undefined }
  | { type: 'apply-goal-snapshot'; goal: ThreadGoal | null }
  | { type: 'set-error'; message: string }
  | { type: 'mark-stream-finished' }
  | { type: 'refresh-after-stream' }
  | { type: 'notify'; notification: StreamEventNotification };

export type ListStreamEventAction =
  | { type: 'patch-conversation-message'; message: Message }
  | { type: 'refresh-conversation-list' }
  | { type: 'update-title'; title: string }
  | { type: 'apply-goal-snapshot'; goal: ThreadGoal | null }
  | { type: 'mark-list-stream-finished' }
  | { type: 'notify'; notification: StreamEventNotification };

export function conversationListPatchForMessage<T extends Pick<ConversationListItem, 'lastMessage' | 'updatedAt'>>(
  item: T,
  message: Message,
): T {
  return {
    ...item,
    lastMessage: message.content || item.lastMessage,
    updatedAt: message.timestamp || item.updatedAt,
  };
}

export function streamEventNotification(event: StreamEvent): StreamEventNotification | null {
  if (event.type === 'error' && event.terminal !== false) {
    return {
      title: 'Agent Cockpit stream failed',
      body: event.error || 'The stream ended with an error.',
    };
  }
  if (event.type === 'done') {
    return {
      title: 'Agent Cockpit stream finished',
      body: 'The latest response is ready.',
    };
  }
  if (event.type === 'tool_activity') {
    if (event.isPlanMode && (event.planContent || event.planAction === 'exit')) {
      return {
        title: 'Agent Cockpit needs approval',
        body: event.planContent || 'Plan ready for approval.',
      };
    }
    if (event.isQuestion && event.questions?.length) {
      return {
        title: 'Agent Cockpit has a question',
        body: event.questions[0].question,
      };
    }
  }
  return null;
}

export function chatStreamEventActions(event: StreamEvent): ChatStreamEventAction[] {
  const actions: ChatStreamEventAction[] = [];
  switch (event.type) {
    case 'text':
    case 'thinking':
      actions.push({ type: 'set-stream-placeholder', value: false });
      actions.push({ type: 'append-stream-text', content: event.content || '' });
      break;
    case 'assistant_message':
      if (event.message) {
        actions.push({ type: 'upsert-message', message: event.message });
      }
      actions.push({ type: 'set-stream-text', value: '' });
      actions.push({ type: 'set-stream-placeholder', value: false });
      actions.push({ type: 'clear-stream-tools' });
      actions.push({ type: 'clear-stream-artifacts' });
      break;
    case 'artifact':
      if (event.artifact?.filename) {
        actions.push({ type: 'set-stream-placeholder', value: false });
        actions.push({ type: 'append-stream-artifact', artifact: event.artifact });
      }
      break;
    case 'tool_activity': {
      if (event.isPlanMode && (event.planContent || event.planAction === 'exit')) {
        actions.push({ type: 'set-pending-interaction', interaction: { kind: 'plan', prompt: event.planContent || 'Plan ready for approval.' } });
      } else if (event.isQuestion && event.questions?.length) {
        const question = event.questions[0];
        actions.push({
          type: 'set-pending-interaction',
          interaction: { kind: 'question', prompt: question.question, options: question.options || [],
            ...(event.inputRequestId ? { requestId: event.inputRequestId } : {}),
            ...(question.allowFreeform !== undefined ? { allowFreeform: question.allowFreeform } : {}) },
        });
      }
      const notification = streamEventNotification(event);
      if (notification) actions.push({ type: 'notify', notification });
      if (!event.isQuestion && !event.isPlanMode && event.tool) actions.push({ type: 'update-stream-tools', frame: event });
      break;
    }
    case 'input_ready':
      actions.push({ type: 'set-input-turn', turnId: event.turnId });
      break;
    case 'tool_outcomes':
      actions.push({ type: 'resolve-input-requests', requestIds: (event.outcomes || []).map(outcome => outcome.toolUseId) });
      actions.push({ type: 'update-stream-tools', frame: event });
      break;
    case 'title_updated':
      if (event.title) {
        actions.push({ type: 'update-title', title: event.title });
      }
      break;
    case 'usage':
      actions.push({ type: 'update-usage', usage: event.usage, sessionUsage: event.sessionUsage });
      break;
    case 'goal_updated':
      actions.push({ type: 'apply-goal-snapshot', goal: event.goal });
      break;
    case 'goal_cleared':
      actions.push({ type: 'apply-goal-snapshot', goal: null });
      break;
    case 'error': {
      actions.push({ type: 'set-error', message: event.error || 'The stream ended with an error.' });
      if (event.terminal !== false) {
        actions.push({ type: 'mark-stream-finished' });
        const notification = streamEventNotification(event);
        if (notification) actions.push({ type: 'notify', notification });
      }
      break;
    }
    case 'done': {
      actions.push({ type: 'set-stream-text', value: '' });
      actions.push({ type: 'set-stream-placeholder', value: false });
      actions.push({ type: 'mark-stream-finished' });
      const notification = streamEventNotification(event);
      if (notification) actions.push({ type: 'notify', notification });
      actions.push({ type: 'refresh-after-stream' });
      break;
    }
    case 'replay_start':
      actions.push({ type: 'set-input-turn', turnId: null });
      actions.push({ type: 'clear-stream-tools' });
      actions.push({ type: 'clear-stream-artifacts' });
      actions.push({ type: 'set-stream-text', value: '' });
      actions.push({ type: 'set-stream-placeholder', value: true });
      break;
    default:
      break;
  }
  return actions;
}

export function listStreamEventActions(event: StreamEvent): ListStreamEventAction[] {
  const actions: ListStreamEventAction[] = [];
  switch (event.type) {
    case 'assistant_message':
      if (event.message) {
        actions.push({ type: 'patch-conversation-message', message: event.message });
      }
      actions.push({ type: 'refresh-conversation-list' });
      break;
    case 'title_updated':
      if (event.title) {
        actions.push({ type: 'update-title', title: event.title });
      }
      break;
    case 'goal_updated':
      actions.push({ type: 'apply-goal-snapshot', goal: event.goal });
      break;
    case 'goal_cleared':
      actions.push({ type: 'apply-goal-snapshot', goal: null });
      break;
    case 'error':
      if (event.terminal !== false) {
        actions.push({ type: 'mark-list-stream-finished' });
        const notification = streamEventNotification(event);
        if (notification) actions.push({ type: 'notify', notification });
      }
      break;
    case 'done': {
      actions.push({ type: 'mark-list-stream-finished' });
      const notification = streamEventNotification(event);
      if (notification) actions.push({ type: 'notify', notification });
      break;
    }
    case 'tool_activity': {
      const notification = streamEventNotification(event);
      if (notification) actions.push({ type: 'notify', notification });
      break;
    }
    default:
      break;
  }
  return actions;
}
