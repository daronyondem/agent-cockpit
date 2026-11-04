import type { SessionEvent } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import { copilotToolArtifacts } from '../src/services/backends/copilotArtifacts';
import { createCopilotSdkEventState, reduceCopilotSdkEvent } from '../src/services/backends/copilotSdkEvents';
import { copilotPng, copilotPdf } from './helpers/copilotMediaFixtures';

type Complete = Extract<SessionEvent, { type: 'tool.execution_complete' }>['data'];
const data = (): Complete => ({ toolCallId: 'media', success: true, result: { content: 'tool output', contents: [
  { type: 'image', data: copilotPng.toString('base64'), mimeType: 'image/png' },
  { type: 'resource', resource: { uri: 'fixture:///report%20one.pdf', mimeType: 'application/pdf', blob: copilotPdf().toString('base64') } },
], binaryResultsForLlm: [
  { type: 'image', data: copilotPng.toString('base64'), mimeType: 'image/png' },
  { type: 'resource', data: copilotPdf().toString('base64'), mimeType: 'application/pdf' },
] } });
let serial = 0;
const event = (type: SessionEvent['type'], data: object, agentId?: string): SessionEvent =>
  ({ type, data, id: String(++serial), parentId: null, timestamp: '', ...(agentId ? { agentId } : {}) }) as SessionEvent;

test('projects native binary outputs once per tool despite overlapping native views', () => {
  const events = copilotToolArtifacts(data(), 'scoped-tool');
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ type: 'artifact', dataBase64: copilotPng.toString('base64'), filename: expect.stringMatching(/\.png$/), title: 'Tool output', sourceToolId: 'scoped-tool' });
  expect(events[1]).toMatchObject({ filename: 'report one.pdf', mimeType: 'application/pdf' });
});

test('an artifact-only completion is observable output even without a prior tool-start event', () => {
  const initial = createCopilotSdkEventState();
  const projected = reduceCopilotSdkEvent(initial, event('tool.execution_complete', data()));
  expect(projected.events.filter(frame => frame.type === 'artifact')).toHaveLength(2);
  expect(projected.state.hasOutput).toBe(true);
  expect(initial.hasOutput).toBe(false);
});

test('does not scrape text, read URIs, invent omitted bytes, or accept malformed base64', () => {
  const result: Complete = { toolCallId: 'x', success: true, result: { content: '/private/file.png', contents: [
    { type: 'image', data: 'invalid!!', mimeType: 'image/png' },
    { type: 'image', data: 'a', mimeType: 'image/png' },
    { type: 'image', data: '', mimeType: 'image/png' },
    { type: 'resource_link', name: 'remote', uri: 'https://example.com/private.pdf' },
    { type: 'resource', resource: { uri: 'file:///private/file', text: 'ordinary text' } },
  ], binaryResultsForLlm: [{ type: 'image', assetId: 'sha256:missing', byteLength: 500, mimeType: 'image/png' }] } };
  expect(copilotToolArtifacts(result, 'x')).toEqual([]);
  expect(copilotToolArtifacts({ ...data(), success: false }, 'x')).toEqual([]);
  expect(copilotToolArtifacts({ toolCallId: 'x', success: true }, 'x')).toEqual([]);
  const fallback: Complete = { toolCallId: 'x', success: true, result: { content: '', contents: [{ type: 'resource', resource: { uri: 'invalid uri', blob: 'aGVsbG8=', mimeType: 'text/plain' } }] } };
  expect(copilotToolArtifacts(fallback, 'x')).toMatchObject([{ filename: expect.stringMatching(/\.txt$/) }]);
});

test('root and delegated artifacts retain tool ownership and cannot duplicate or reopen ended work', () => {
  let state = createCopilotSdkEventState('scope');
  const apply = (e: SessionEvent) => { const result = reduceCopilotSdkEvent(state, e); state = result.state; return result.events; };
  apply(event('tool.execution_start', { toolCallId: 'task', toolName: 'task' }));
  apply(event('subagent.started', { toolCallId: 'task', agentName: 'child', agentDisplayName: 'Child' }, 'child'));
  apply(event('tool.execution_start', { toolCallId: 'media', toolName: 'mcp__media__output' }, 'child'));
  const child = apply(event('tool.execution_complete', data(), 'child')).filter(frame => frame.type === 'artifact');
  expect(child).toHaveLength(2);
  expect(child[0].sourceToolId).toContain('["child","media"]');
  expect(apply(event('tool.execution_complete', data(), 'child'))).toEqual([]);
  apply(event('tool.execution_start', { toolCallId: 'media', toolName: 'mcp__media__output' }));
  expect(apply(event('tool.execution_complete', data())).filter(frame => frame.type === 'artifact')[0].sourceToolId).toContain('[null,"media"]');
  apply(event('subagent.completed', { toolCallId: 'task' }, 'child'));
  expect(apply(event('tool.execution_complete', { ...data(), toolCallId: 'late' }, 'child'))).toEqual([]);
  apply(event('session.idle', {}));
  expect(apply(event('tool.execution_complete', { ...data(), toolCallId: 'late' }))).toEqual([]);
});
