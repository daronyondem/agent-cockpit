import type { ChatService } from '../chatService';
import type { GoalEvent, Message } from '../../types';
import { formatGoalEventMessage, goalEventDedupeKey } from './goalEventMessages';

const pending = new WeakMap<ChatService, Map<string, Promise<Message | null>>>();

/** Polling and stream completion must share one check-and-append boundary. */
export function persistGoalEventOnce(service: ChatService, conversationId: string, backend: string, goalEvent: GoalEvent): Promise<Message | null> {
  let conversations = pending.get(service);
  if (!conversations) { conversations = new Map(); pending.set(service, conversations); }
  const owners = conversations;
  const previous = owners.get(conversationId) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const conversation = await service.getConversation(conversationId);
    const key = goalEventDedupeKey(goalEvent);
    if (!conversation || conversation.messages.some(message => message.goalEvent && goalEventDedupeKey(message.goalEvent) === key)) return null;
    return service.addMessage(conversationId, 'system', formatGoalEventMessage(goalEvent), backend, null,
      undefined, undefined, undefined, { goalEvent });
  });
  owners.set(conversationId, write);
  void write.finally(() => { if (owners.get(conversationId) === write) owners.delete(conversationId); }).catch(() => {});
  return write;
}
