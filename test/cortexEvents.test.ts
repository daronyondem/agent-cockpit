import type { StreamEvent } from '../src/types';
import { CortexEventDecoder, cortexToolText } from '../src/services/backends/cortexEvents';
import { cortexTerminalError, cortexRuntimeError } from '../src/services/backends/cortexErrors';
import { CortexRpcError, cortexRecord } from '../src/services/backends/cortexProtocol';
import { CortexTurnUsage } from '../src/services/backends/cortexUsage';
import { applyCostEstimate } from '../src/services/usagePricing/estimator';
import { cortexWire } from './helpers/cortexFixtures';

test('native file/shell excerpt maps thoughts, tools, diff outcomes and fragmented final text', () => {
  const decoder = new CortexEventDecoder('fixture-id-1');
  const frames = cortexWire('file-shell');
  const events = frames.flatMap(frame => decoder.decode(frame));
  expect(events.filter(event => event.type === 'thinking').map(event => event.content).join('')).toContain('fixture.txt');
  expect(events.filter(event => event.type === 'tool_activity').map(event => event.tool)).toEqual(['Read', 'Write', 'Bash']);
  expect(events.filter(event => event.type === 'tool_outcomes')).toHaveLength(3);
  expect(events.filter(event => event.type === 'text').map(event => event.content).join('')).toBe(decoder.finalText);
  expect(decoder.finalText).toContain('verified to match');
  expect(decoder.usage.contextPercentage).toBeCloseTo(3.2737);
});

test('foreign sessions, unknown variants and duplicate IDs do not create extra activity or terminal errors', () => {
  const decoder = new CortexEventDecoder('fixture-id-6');
  const frames = cortexWire('plan-revision');
  const events = frames.flatMap(frame => decoder.decode(frame));
  expect(events.some(event => event.type === 'tool_outcomes' && event.outcomes.some(row => row.isError))).toBe(true);
  expect(events.some(event => event.type === 'error')).toBe(false);
  const tool = frames.find(frame => cortexRecord(frame.params?.update).sessionUpdate === 'tool_call')!;
  expect(decoder.decode(tool)).toEqual([]);
  expect(decoder.decode({ ...tool, params: { ...tool.params, sessionId: 'other-session' } })).toEqual([]);
  expect(decoder.decode({ ...tool, params: { ...tool.params, update: { sessionUpdate: 'new-native-variant' } } })).toEqual([]);
});

test('terminal native errors are held across fragments and classified without echoing account diagnostics', () => {
  for (const name of ['auth-error', 'api-error']) {
    const frames = cortexWire(name);
    const message = frames.find(frame => frame.method === 'session/update')!;
    const decoder = new CortexEventDecoder(String(message.params!.sessionId));
    const text = String(cortexRecord(cortexRecord(message.params!.update).content).text);
    const events: StreamEvent[] = [];
    for (const fragment of text.match(/.{1,3}/gs)!) events.push(...decoder.decode({ ...message,
      params: { ...message.params, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: fragment } } } }));
    expect(events).toEqual([]);
    const final = frames.find(frame => frame.result)!;
    const error = cortexTerminalError(final.result, decoder.finalText, '1.2.35');
    expect(error).toMatchObject({ type: 'error', source: 'backend' });
    expect(error?.error).not.toMatch(/fixture-id|connections.toml|request_id/);
  }
});

test('legitimate error quotations, missing usage, unknown failures and terminal stop reasons stay distinct', () => {
  expect(cortexTerminalError({ stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0 } }, 'Error: a quoted example', '1.2.35')).toBeNull();
  expect(cortexTerminalError({ stopReason: 'end_turn', usage: {} }, 'Error: unknown new failure', '1.2.35')?.error).toContain('unrecognized');
  expect(cortexTerminalError({ stopReason: 'end_turn' }, 'The example is `Error: failed`.', '1.2.35')).toBeNull();
  expect(cortexTerminalError({ stopReason: 'end_turn' }, 'Normal answer without usage', '1.2.35')).toBeNull();
  expect(cortexTerminalError({ stopReason: 'end_turn' }, 'Error: unknown new failure', '1.2.35')?.error).toContain('unrecognized');
  expect(cortexTerminalError({ stopReason: 'end_turn' }, 'Error: Error: API error 408: private', '9.0.0')?.error).toContain('unrecognized');
  expect(cortexTerminalError({ stopReason: 'cancelled' }, '', '1.2.35')?.source).toBe('abort');
  expect(cortexTerminalError({ stopReason: 'max_tokens' }, 'Partial', '1.2.35')?.error).toContain('before completing');
  expect(cortexTerminalError({}, '', '1.2.35')?.type).toBe('error');
  expect(cortexRuntimeError(new CortexRpcError('secret token', -32603, { token: 'private' })).error).not.toContain('secret');
  expect(cortexRuntimeError(new Error('Cortex ACP request timed out')).error).toContain('timed out');
});

test('context snapshots never bill tokens; final cache categories are separate and deduplicated per turn', () => {
  const raw = { inputTokens: 7, outputTokens: 11, cachedReadTokens: 17, cachedWriteTokens: 19, totalTokens: 54 };
  const first = new CortexTurnUsage();
  first.snapshot({ used: 25, size: 100 });
  first.snapshot({ used: -5, size: 100 });
  const event = first.complete(raw, 'claude-sonnet-4-6')!;
  expect(event.usage).toEqual({ inputTokens: 7, outputTokens: 11, cacheReadTokens: 17, cacheWriteTokens: 19, costUsd: 0, costSource: 'none', contextUsagePercentage: 25 });
  expect(first.complete(raw)).toBeNull();
  expect(applyCostEstimate('cortex-code', event.model!, event.usage).costSource).toBe('none');
  expect(applyCostEstimate('cortex-code', event.model!, event.usage).estimatedCostUsd).toBeUndefined();
  const second = new CortexTurnUsage();
  second.snapshot({ used: 200, size: 100 });
  expect(second.complete(raw)?.usage.contextUsagePercentage).toBe(100);
  expect(new CortexTurnUsage().complete({ inputTokens: 1, outputTokens: 3 })).toBeNull();
  expect(new CortexTurnUsage().complete({ ...raw, cachedReadTokens: NaN })).toBeNull();
});

test('diff and embedded resource content stays bounded in outcomes, and normal text boundaries preserve tool order', () => {
  expect(cortexToolText([{ type: 'image', data: 'PRIVATE opaque data' },
    { type: 'content', content: { type: 'resource_link', uri: 'https://PRIVATE.invalid' } }, null])).toBe('');
  expect(cortexToolText([{ type: 'diff', path: 'a.txt', oldText: 'before', newText: 'after' },
    { type: 'content', content: { type: 'resource', resource: { uri: 'memory://note', text: 'Resource body' } } },
    { type: 'content', content: { type: 'resource_link', uri: 'https://example.test', name: 'Reference' } },
    { type: 'resource_link', name: 'Output file' }])).toContain('---\nbefore\n+++\nafter\nResource body\nReference\nOutput file');
  const decoder = new CortexEventDecoder('owned');
  const send = (update: object) => decoder.decode({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'owned', update } });
  send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Preparing' } });
  expect(send({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'read', rawInput: { file_path: 'a.txt' } }).map(event => event.type)).toEqual(['turn_boundary', 'tool_activity']);
  expect(send({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', rawOutput: 'x'.repeat(2000) })[0]).toMatchObject({ outcomes: [{ outcome: 'x'.repeat(1000) }] });
  expect(send({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'unused' } })).toEqual([]);
});

test('delivery markers split across arbitrary chunks become paths, leaving clean streamed text and result', () => {
  const decoder = new CortexEventDecoder('owned');
  const events: StreamEvent[] = [];
  const text = 'Download this file.\n<!-- FILE_DELIVERY:/workspace/a file.pdf -->\nDone. <!-- ordinary comment -->';
  for (const chunk of text) events.push(...decoder.decode({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'owned',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } } }));
  events.push(...decoder.finishText());
  expect(events.filter(event => event.type === 'text').map(event => event.content).join('')).toBe('Download this file.\n\nDone. <!-- ordinary comment -->');
  expect(decoder.deliveries).toEqual(['/workspace/a file.pdf']);
  expect(decoder.resultText).not.toContain('FILE_DELIVERY');
});
