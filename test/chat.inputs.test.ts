import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import type { ActiveStreamEntry, BackendInputResult, StreamEvent } from '../src/types';

describe('correlated conversation input HTTP boundary', () => {
  let env: ChatRouterEnv;
  let id: string;
  const deliverInput = jest.fn<Promise<BackendInputResult>, [unknown]>();
  beforeEach(async () => {
    env = await createChatRouterEnv();
    id = (await env.chatService.createConversation('Inputs')).id;
    deliverInput.mockReset().mockResolvedValue({ accepted: true });
  });
  afterEach(async () => { env.activeStreams.delete(id); await destroyChatRouterEnv(env); });
  const entry = (patch: Partial<ActiveStreamEntry> = {}): ActiveStreamEntry => ({
    stream: (async function* () {})(), abort: () => {}, sendInput: jest.fn(), backend: 'copilot',
    deliverInput, needsTitleUpdate: false, titleUpdateMessage: null, ...patch,
  });
  const input = (body: object) => env.request('POST', `/api/chat/conversations/${id}/input`, body);

  test('awaits native delivery after reload and returns only the acknowledgement without adding a message', async () => {
    let settle!: (result: BackendInputResult) => void;
    deliverInput.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    env.activeStreams.set(id, entry());
    let answered = false;
    const pending = input({ text: 'Beta', requestId: 'question', streamActive: false }).then(response => { answered = true; return response; });
    while (!settle) await new Promise(resolve => setTimeout(resolve, 1));
    expect(answered).toBe(false);
    settle({ accepted: true });
    expect(await pending).toMatchObject({ status: 200, body: { mode: 'stdin' } });
    expect(deliverInput).toHaveBeenCalledWith({ text: 'Beta', requestId: 'question', streamActive: false });
    expect((await env.chatService.getConversation(id))!.messages).toEqual([]);
  });

  test('stale question and steering requests never fall back to a new user message', async () => {
    for (const state of [undefined, entry({ deliverInput: undefined }), entry({ abortFinalizing: Promise.resolve() }),
      entry({ terminalFinalizing: Promise.resolve() }), entry({ abortRequested: { at: '', message: 'Stop', source: 'abort' } })]) {
      if (state) env.activeStreams.set(id, state); else env.activeStreams.delete(id);
      expect((await input({ text: 'late answer', requestId: 'old', streamActive: true })).status).toBe(409);
      expect((await input({ text: 'late steer', turnId: 'old', inputId: 'old', streamActive: true })).status).toBe(409);
    }
    expect(deliverInput).not.toHaveBeenCalled();
    expect((await env.chatService.getConversation(id))!.messages).toEqual([]);
  });

  test.each([400, 409, 503] as const)('propagates native refusal %s without void stdin or fallback dispatch', async status => {
    const active = entry(); env.activeStreams.set(id, active);
    deliverInput.mockResolvedValueOnce({ accepted: false, status, error: 'Draft preserved' });
    expect(await input({ text: 'fix it', turnId: 'turn', inputId: 'input', streamActive: true }))
      .toMatchObject({ status, body: { error: 'Draft preserved' } });
    expect(active.sendInput).not.toHaveBeenCalled();
    deliverInput.mockRejectedValueOnce(new Error('Disconnected'));
    expect((await input({ text: 'fix it', turnId: 'turn', inputId: 'next' })).status).toBe(503);
  });

  test('attaches the awaited handler and broadcasts readiness/questions on the production message route', async () => {
    let end!: () => void;
    const finished = new Promise<void>(resolve => { end = resolve; });
    jest.spyOn(env.mockBackend, 'sendMessage').mockImplementationOnce(() => ({ deliverInput, sendInput: () => {}, abort: end,
      stream: (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'input_ready', turnId: 'owned-turn' };
        yield { type: 'tool_activity', id: 'owned-question', isQuestion: true, tool: 'AskUserQuestion', inputRequestId: 'owned-question', description: 'Choose', questions: [{ question: 'Choose' }] };
        await finished;
        yield { type: 'done' };
      })(),
    }));
    const socket = await env.connectWs(id);
    const frames = env.readWsEvents(socket);
    expect((await env.request('POST', `/api/chat/conversations/${id}/message`, { content: 'Ask' })).status).toBe(200);
    expect(env.activeStreams.get(id)!.deliverInput).toBe(deliverInput);
    expect((await input({ text: 'Beta', requestId: 'owned-question' })).status).toBe(200);
    end();
    const received = await frames;
    expect(received).toContainEqual({ type: 'input_ready', turnId: 'owned-turn' });
    expect(received).toContainEqual(expect.objectContaining({ type: 'tool_activity', inputRequestId: 'owned-question' }));
  });
});
