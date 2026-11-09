import type { StreamEvent, CortexRpcMessage } from '../src/types';
import { CortexInteractions } from '../src/services/backends/cortexInteractions';
import { cortexFixture, cortexWire } from './helpers/cortexFixtures';

function fixture(allow = true, onInteractionRequired?: () => void) {
  const f = cortexFixture();
  const events: StreamEvent[] = [];
  const interactions = new CortexInteractions(f.client, 'fixture-session', event => events.push(event), allow, onInteractionRequired);
  f.client.subscribe(frame => frame.id === undefined ? interactions.observe(frame) : interactions.handle(frame));
  const send = (frame: CortexRpcMessage) => f.send({ ...frame, params: { ...frame.params, sessionId: 'fixture-session' } });
  return { ...f, events, interactions, send };
}

test('native ID zero, sequential questions, exact options and free text answer exactly once with stale decisions rejected', async () => {
  const f = fixture();
  const requests = cortexWire('questions').filter(frame => frame.method === 'session/request_permission');
  f.send(requests[0]);
  const first = f.interactions.pendingId!;
  expect(f.events[0]).toMatchObject({ type: 'tool_activity', isQuestion: true, decisionBound: true, questions: [{ question: 'Which fixture color?' }] });
  expect(f.interactions.input('', first)).toBe(false);
  expect(f.interactions.input('Violet fixture', first)).toBe(true);
  expect(f.writes[0]).toMatchObject({ id: 0, result: { outcome: { outcome: 'selected', optionId: 'opt_3', _meta: { freeFormText: 'Violet fixture' } } } });
  f.send(requests[1]);
  const second = f.interactions.pendingId!;
  expect(second).not.toBe(first);
  expect(f.interactions.input('Blue', first)).toBe(false);
  expect(f.interactions.input('Green', second)).toBe(true);
  expect(f.interactions.input('Green', second)).toBe(false);
  expect(f.writes[1]).toMatchObject({ id: 1, result: { outcome: { optionId: 'opt_1' } } });
  await f.client.close();
});

test('plan revision/rejection/approval use the prior document and generate a fresh decision', async () => {
  const f = fixture();
  const frames = cortexWire('plan-revision');
  const plans = frames.filter(frame => (frame.params?.update as any)?.sessionUpdate === 'plan');
  const requests = frames.filter(frame => frame.method === 'session/request_permission');
  f.send(plans[0]); f.send(requests[0]);
  const first = f.interactions.pendingId!;
  expect(f.interactions.input('Add a read-back check', first)).toBe(true);
  expect(f.writes[0]).toMatchObject({ id: 0, result: { outcome: { optionId: 'keep_planning', _meta: { freeFormText: 'Add a read-back check' } } } });
  f.send(plans[1]); f.send(requests[1]);
  const second = f.interactions.pendingId!;
  expect(f.interactions.input('approve', first)).toBe(false);
  expect(f.interactions.input('approve', second)).toBe(true);
  expect(f.writes[1]).toMatchObject({ id: 1, result: { outcome: { optionId: 'proceed' } } });
  const cards = f.events.filter((event): event is Extract<StreamEvent, { type: 'tool_activity' }> => event.type === 'tool_activity' && event.planAction === 'exit');
  expect(cards).toHaveLength(2);
  expect(cards.every(card => card.decisionBound === true)).toBe(true);
  expect(cards[1].planContent).toContain('Read the file back');
  f.send(requests[1]);
  expect(f.interactions.input('reject', f.interactions.pendingId!)).toBe(true);
  expect(f.writes[2]).toMatchObject({ result: { outcome: { optionId: 'keep_planning' } } });
  await f.client.close();
});

test('standard chat can enter native planning without granting finished-plan execution', async () => {
  const f = fixture();
  f.send(cortexWire('plan-entry')[0]);
  expect(f.writes[0]).toMatchObject({ id: 0, result: { outcome: { outcome: 'selected', optionId: 'approve' } } });
  expect(f.events).toEqual([{ type: 'tool_activity', tool: 'EnterPlanMode', id: null,
    description: 'Preparing plan', isPlanMode: true, planAction: 'enter' }]);
  expect(f.interactions.pendingId).toBeNull();
  const frames = cortexWire('plan-revision');
  f.send(frames.find(frame => (frame.params?.update as any)?.sessionUpdate === 'plan')!);
  f.send(frames.find(frame => frame.method === 'session/request_permission')!);
  expect(f.writes).toHaveLength(1);
  expect(f.interactions.pendingId).toMatch(/^cortex-decision:/);
  expect(f.interactions.input('approve', f.interactions.pendingId!)).toBe(true);
  expect(f.writes[1]).toMatchObject({ result: { outcome: { optionId: 'proceed' } } });
  await f.client.close();
});

test('planning entry stays blocked for restricted/headless work and unrecognized entry schemas', async () => {
  const entry = cortexWire('plan-entry')[0];
  const required = jest.fn();
  const restricted = fixture(false), headless = fixture(true, required), unknown = fixture();
  restricted.send(entry); headless.send(entry);
  unknown.send({ ...entry, params: { ...entry.params, toolCall: { ...(entry.params!.toolCall as object), title: 'Unknown switch' } } });
  unknown.send({ ...entry, params: { ...entry.params, options: [
    { kind: 'allow_always', name: 'Approve', optionId: 'approve' }, { kind: 'reject_once', name: 'Decline', optionId: 'decline' },
  ] } });
  for (const f of [restricted, headless, unknown]) {
    expect(f.interactions.pendingId).toBeNull();
    expect(f.events).toEqual([]);
    for (const write of f.writes) expect(write).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
  }
  expect(required).toHaveBeenCalledTimes(1);
  await Promise.all([restricted, headless, unknown].map(f => f.client.close()));
});

test('only known ordinary allow-once permissions are approved; missing plan, denied and unknown requests cancel safely', async () => {
  const ordinary = cortexWire('file-shell').find(frame => frame.method === 'session/request_permission')!;
  const f = fixture(); f.send(ordinary);
  expect(f.writes[0]).toMatchObject({ result: { outcome: { optionId: 'allow' } } });
  const missing = cortexWire('plan-revision').find(frame => frame.method === 'session/request_permission')!;
  f.send(missing);
  expect(f.writes[1]).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
  f.send({ ...ordinary, params: { ...ordinary.params, options: [{ optionId: 'danger', name: 'Unknown', kind: 'allow_always' }] } });
  expect(f.writes[2]).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
  f.send({ jsonrpc: '2.0', id: 'unknown', method: 'terminal/create' });
  expect(f.writes[3]).toMatchObject({ id: 'unknown', error: { code: -32601 } });
  const denied = fixture(false); denied.send(ordinary);
  expect(denied.writes[0]).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
  await Promise.all([f.client.close(), denied.client.close()]);
});

test('abort and process exit invalidate pending decisions; blank, ambiguous and selector-only free form stay pending', async () => {
  const f = fixture();
  const question = cortexWire('questions').find(frame => frame.method === 'session/request_permission')!;
  f.send(question);
  const id = f.interactions.pendingId!;
  expect(f.interactions.input('Something else', id)).toBe(false);
  f.interactions.cancel();
  expect(f.interactions.pendingId).toBeNull();
  expect(f.interactions.input('Green', id)).toBe(false);
  f.send(question);
  f.child.emit('exit', 1);
  expect(f.interactions.pendingId).toBeNull();
  expect(f.interactions.input('Blue', id)).toBe(false);
  await f.client.close();
});
