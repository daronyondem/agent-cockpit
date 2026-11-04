import type { ChatService } from '../src/services/chatService';
import type { GoalEvent, Message } from '../src/types';
import { persistGoalEventOnce } from '../src/services/chat/goalEventPersistence';

const event = (objectiveId = 1, sessionId = 'native'): GoalEvent => ({ kind: 'achieved', backend: 'copilot', status: 'complete', objective: 'Verified',
  goal: { backend: 'copilot', objective: 'Verified', status: 'complete', objectiveId, sessionId } });

function fixture() {
  const messages: Message[] = [];
  const service = { getConversation: jest.fn(async () => ({ messages })),
    addMessage: jest.fn(async (_id, _role, _text, _backend, _thinking, _tools, _turn, _blocks, metadata) => {
      await Promise.resolve();
      const message = { id: String(messages.length), ...metadata } as Message;
      messages.push(message); return message;
    }),
  };
  return { service: service as unknown as ChatService, messages, add: service.addMessage, get: service.getConversation };
}

test('poll and stream completion share atomic goal check/append and only one caller emits the card', async () => {
  const { service, messages, add } = fixture();
  const results = await Promise.all(Array.from({ length: 6 }, () => persistGoalEventOnce(service, 'conversation', 'copilot', event())));
  expect(add).toHaveBeenCalledTimes(1);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(messages).toHaveLength(1);
  await expect(persistGoalEventOnce(service, 'conversation', 'copilot', event())).resolves.toBeNull();
});

test('replacement objectives and recovered native sessions retain distinct achievement cards', async () => {
  const { service, messages } = fixture();
  await Promise.all([event(), event(2), event(1, 'recovered')].map(goal => persistGoalEventOnce(service, 'conversation', 'copilot', goal)));
  expect(messages).toHaveLength(3);
});

test('failed persistence releases ownership for retry; deleted conversations are not recreated', async () => {
  const { service, add, get } = fixture();
  add.mockRejectedValueOnce(new Error('write failed'));
  await expect(persistGoalEventOnce(service, 'conversation', 'copilot', event())).rejects.toThrow('write failed');
  await expect(persistGoalEventOnce(service, 'conversation', 'copilot', event())).resolves.toBeTruthy();
  get.mockResolvedValueOnce(null as never);
  await expect(persistGoalEventOnce(service, 'gone', 'copilot', event())).resolves.toBeNull();
});
