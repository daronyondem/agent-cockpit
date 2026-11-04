import type { SessionEvent } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import { CopilotInputs } from '../src/services/backends/copilotInputs';
import type { StreamEvent } from '../src/types';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
describe('Copilot correlated input ownership', () => {
  let inputs: CopilotInputs;
  let events: StreamEvent[];
  let send: jest.Mock;
  let pause: jest.Mock;
  let withdraw: jest.Mock;
  let fail: jest.Mock;
  beforeEach(() => {
    events = [];
    send = jest.fn().mockResolvedValue('correction');
    pause = jest.fn().mockResolvedValue(undefined);
    withdraw = jest.fn().mockResolvedValue({ removed: true, interrupted: false });
    fail = jest.fn();
    inputs = new CopilotInputs({ send, rpc: { queue: { setDrainPaused: pause, withdrawMessage: withdraw } } } as never,
      event => events.push(event), promise => promise, fail);
  });
  afterEach(() => inputs.cancel());
  const questionId = () => {
    const question = events.filter(event => event.type === 'tool_activity').at(-1);
    if (question?.type !== 'tool_activity' || !question.inputRequestId) throw new Error('Question not presented');
    return question.inputRequestId;
  };
  const consumed = (id = 'correction', extra = {}) => inputs.handle({ type: 'user.message', data: { messageId: id, delivery: 'steering' }, ...extra } as SessionEvent);
  const steer = (inputId = 'input-1', text = 'Use the other approach') => inputs.deliver({ text, inputId, turnId: inputs.turnId });

  test('queues repeated native questions, enforces choices, correlates each answer once, and distinguishes freeform', async () => {
    const answer = inputs.ask({ question: 'Choose', choices: ['Alpha', 'Beta'], allowFreeform: false });
    const next = inputs.ask({ question: 'Choose', choices: ['Alpha', 'Beta'] });
    const firstId = questionId();
    expect(await inputs.deliver({ text: 'Gamma', requestId: firstId })).toMatchObject({ accepted: false, status: 400 });
    expect(await inputs.deliver({ text: 'Beta', requestId: firstId })).toEqual({ accepted: true });
    expect(await answer).toEqual({ answer: 'Beta', wasFreeform: false });
    const nextId = questionId();
    expect(nextId).not.toBe(firstId);
    expect(await inputs.deliver({ text: 'Alpha', requestId: firstId })).toMatchObject({ accepted: false, status: 409 });
    expect(await inputs.deliver({ text: 'Gamma', requestId: nextId })).toEqual({ accepted: true });
    expect(await next).toEqual({ answer: 'Gamma', wasFreeform: true });
    expect(events.filter(event => event.type === 'tool_outcomes')).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();
  });

  test('cancels all pending callbacks on Stop and rejects old request identities on a later turn', async () => {
    const first = expect(inputs.ask({ question: 'First?' })).rejects.toThrow('cancelled');
    const id = questionId();
    const second = expect(inputs.ask({ question: 'Second?' })).rejects.toThrow('cancelled');
    inputs.cancel();
    await Promise.all([first, second]);
    expect(await inputs.deliver({ text: 'late', requestId: id })).toMatchObject({ accepted: false, status: 409 });
    await expect(inputs.ask({ question: 'Late?' })).rejects.toThrow('no longer active');
  });

  test('exposes readiness only after the native queued lane is paused and waits for consumed steering rather than send acknowledgement', async () => {
    await inputs.enableSteering();
    expect(pause).toHaveBeenCalledWith({ paused: true });
    expect(events).toContainEqual({ type: 'input_ready', turnId: inputs.turnId });
    let accepted = false;
    const delivery = steer().then(result => { accepted = true; return result; });
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith({ prompt: 'Use the other approach', mode: 'immediate' });
    expect(accepted).toBe(false);
    consumed();
    expect(await delivery).toEqual({ accepted: true });
    await inputs.finish();
    expect(withdraw).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'input_ready', turnId: null });
  });

  test('handles consumption before acknowledgement and refuses duplicate, concurrent, stale or uncorrelated steering', async () => {
    await inputs.enableSteering();
    const acknowledgement = deferred<string>();
    send.mockReturnValueOnce(acknowledgement.promise);
    const delivery = steer();
    expect(await steer('input-2')).toMatchObject({ accepted: false, status: 409 });
    consumed();
    acknowledgement.resolve('correction');
    expect(await delivery).toEqual({ accepted: true });
    expect(await steer()).toMatchObject({ accepted: false, status: 409 });
    expect(await inputs.deliver({ text: 'late', inputId: 'input-3', turnId: 'old-turn' })).toMatchObject({ accepted: false, status: 409 });
    expect(await inputs.deliver({ text: 'uncorrelated' })).toMatchObject({ accepted: false, status: 400 });
    expect(await inputs.deliver({ text: ' ', inputId: 'input-4', turnId: inputs.turnId })).toMatchObject({ accepted: false, status: 400 });
  });

  test('withdraws a boundary-promoted input while the queued lane stays paused, preserving the draft without a second execution', async () => {
    await inputs.enableSteering();
    const acknowledgement = deferred<string>();
    send.mockReturnValueOnce(acknowledgement.promise);
    const delivery = steer();
    const ending = inputs.finish();
    acknowledgement.resolve('correction');
    await ending;
    expect(withdraw).toHaveBeenCalledWith({ messageId: 'correction', expectedPrompt: 'Use the other approach' });
    expect(await delivery).toMatchObject({ accepted: false, status: 409, error: expect.stringContaining('before consuming') });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await steer('next')).toMatchObject({ accepted: false, status: 409 });
  });

  test('does not expose steering on an older runtime without queue control', async () => {
    pause.mockRejectedValue(new Error('Method not found'));
    await inputs.enableSteering();
    expect(events).toEqual([]);
    expect(await steer()).toMatchObject({ accepted: false, status: 409 });
    expect(send).not.toHaveBeenCalled();
  });

  test('does not steer while a question is pending and ignores child or unrelated delivery notifications', async () => {
    await inputs.enableSteering();
    const answer = expect(inputs.ask({ question: 'Continue?' })).rejects.toThrow('cancelled');
    expect(await steer()).toMatchObject({ accepted: false, status: 409 });
    inputs.cancel();
    await answer;
    consumed('correction', { agentId: 'child' });
    inputs.handle({ type: 'session.idle', data: {} } as SessionEvent);
    expect(send).not.toHaveBeenCalled();
  });

  test('unknown send delivery stops the turn, preserves input and never retries', async () => {
    await inputs.enableSteering();
    send.mockRejectedValueOnce(new Error('Socket closed'));
    expect(await steer()).toMatchObject({ accepted: false, status: 503 });
    expect(fail).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('Stop releases pending steering while native acknowledgement is still outstanding', async () => {
    await inputs.enableSteering();
    const acknowledgement = deferred<string>();
    send.mockReturnValueOnce(acknowledgement.promise);
    const delivery = steer();
    inputs.cancel();
    expect(await delivery).toMatchObject({ accepted: false, status: 409 });
    acknowledgement.reject(new Error('Connection cancelled'));
    await Promise.resolve();
    expect(fail).not.toHaveBeenCalled();
    expect(withdraw).not.toHaveBeenCalled();
  });

  test.each([{ removed: false, interrupted: false }, { removed: true, interrupted: true }, new Error('Disconnected')])(
    'fails closed when unconsumed steering cannot be safely withdrawn (%s)', async result => {
      await inputs.enableSteering();
      if (result instanceof Error) withdraw.mockRejectedValueOnce(result); else withdraw.mockResolvedValueOnce(result);
      const delivery = steer();
      await expect(inputs.finish()).rejects.toThrow();
      expect(await delivery).toMatchObject({ accepted: false, status: 503 });
      expect(pause).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
    });

  test('a late pause acknowledgement cannot reopen a cancelled turn', async () => {
    const acknowledgement = deferred<void>();
    pause.mockReturnValueOnce(acknowledgement.promise);
    const enabling = inputs.enableSteering();
    inputs.cancel();
    acknowledgement.resolve();
    await enabling;
    await inputs.finish();
    expect(events).toEqual([]);
    expect(await steer()).toMatchObject({ accepted: false, status: 409 });
  });
});
