import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import type { CortexRpcMessage, StreamEvent, WsServerFrame } from '../src/types';
import { CortexArtifacts } from '../src/services/backends/cortexArtifacts';
import { cortexPromptContent } from '../src/services/backends/cortexAttachments';
import { processStream } from '../src/routes/chat';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { createCanvas } from '@napi-rs/canvas';
import { UsageLedgerStore } from '../src/services/chat/usageLedgerStore';
import { CortexTurnUsage } from '../src/services/backends/cortexUsage';
import { applyCostEstimate } from '../src/services/usagePricing/estimator';

let env: ChatRouterEnv;
beforeEach(async () => { env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); });
const frame = (update: object, sessionId = 'owned'): CortexRpcMessage => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });

test('completed generated text/code/office/PDF files persist through processStream and existing download/preview routes', async () => {
  const conv = await env.chatService.createConversation('Cortex artifact integration', env.tmpDir);
  const collector = new CortexArtifacts('owned', env.tmpDir);
  const artifacts: StreamEvent[] = [];
  for (const filename of ['result.txt', 'code.ts', 'report.pptx', 'document.pdf']) {
    const file = path.join(env.tmpDir, filename);
    if (filename === 'report.pptx') await fs.copyFile(path.join(__dirname, 'fixtures/kb/sample.pptx'), file);
    else if (filename === 'document.pdf') await fs.copyFile(path.join(__dirname, 'fixtures/kb/sample.pdf'), file);
    else await fs.writeFile(file, `SYNTHETIC_${filename}`);
    await collector.collect(frame({ sessionUpdate: 'tool_call', toolCallId: filename, title: 'write', kind: 'edit', status: 'pending', rawInput: { file_path: file } }));
    const completed = frame({ sessionUpdate: 'tool_call_update', toolCallId: filename, status: 'completed', content: [{ type: 'diff', path: file, newText: 'synthetic' }] });
    expect(await collector.collect(completed)).toEqual([]);
    artifacts.push(...await collector.deliver([file]));
    expect(await collector.collect(completed)).toEqual([]);
  }
  const frames: WsServerFrame[] = [];
  await processStream(conv.id, { backend: 'cortex-code', abort: () => {}, sendInput: () => {}, needsTitleUpdate: false, titleUpdateMessage: null,
    stream: (async function* () { yield* artifacts; yield { type: 'done' } as const; })() }, event => frames.push(event), () => false, () => {}, { chatService: env.chatService });
  const stored = frames.filter((event): event is Extract<WsServerFrame, { type: 'artifact' }> => event.type === 'artifact');
  expect(stored).toHaveLength(4);
  for (const event of stored) {
    expect(event.artifact!.path).toContain(path.join(env.chatService.artifactsDir, conv.id));
    expect(event.artifact!.filename).not.toMatch(/[/\\]/);
    expect(await fs.readFile(event.artifact!.path)).toEqual(await fs.readFile(path.join(env.tmpDir, event.artifact!.filename)));
    const response = await env.request('GET', `/api/chat/conversations/${conv.id}/files/${encodeURIComponent(event.artifact!.filename)}?mode=download`);
    expect(response.status).toBe(200);
  }
  const preview = await env.request('GET', `/api/chat/conversations/${conv.id}/files/result.txt?mode=view`);
  expect(preview.status).toBe(200);
  expect(preview.body.content).toBe('SYNTHETIC_result.txt');
  const saved = await env.chatService.getConversation(conv.id);
  expect(saved!.messages.some(message => message.contentBlocks?.filter(block => block.type === 'artifact').length === 4)).toBe(true);
  const other = await env.chatService.createConversation('Other conversation', env.tmpDir);
  expect((await env.request('GET', `/api/chat/conversations/${other.id}/files/result.txt`)).status).toBe(404);
});

test('artifact extraction ignores reads, failures, foreign sessions, non-file links, outside paths and symlink escapes', async () => {
  const collector = new CortexArtifacts('owned', env.tmpDir);
  const file = path.join(env.tmpDir, 'output.txt'); await fs.writeFile(file, 'OK');
  const write = { sessionUpdate: 'tool_call', toolCallId: 'write', title: 'write', kind: 'edit', status: 'completed', rawInput: { file_path: file } };
  expect(await collector.collect(frame(write, 'other'))).toEqual([]);
  expect(await collector.collect(frame({ ...write, title: 'read', kind: 'read' }))).toEqual([]);
  expect(await collector.collect(frame({ ...write, status: 'failed' }))).toEqual([]);
  expect(await collector.collect(frame({ ...write, rawInput: { file_path: '/etc/hosts' } }))).toEqual([]);
  await fs.symlink('/etc/hosts', path.join(env.tmpDir, 'escape.txt'));
  expect(await collector.collect(frame({ ...write, rawInput: { file_path: path.join(env.tmpDir, 'escape.txt') } }))).toEqual([]);
  expect(await collector.collect(frame({ ...write, rawInput: {}, content: [{ type: 'content', content: { type: 'resource_link', uri: 'https://private.example/file', name: 'remote' } }] }))).toEqual([]);
  const link = frame({ ...write, toolCallId: 'resource', rawInput: {}, kind: 'execute', title: 'bash', content: [{ type: 'content', content: { type: 'resource_link', uri: pathToFileURL(file).href, name: 'output' } }] });
  expect(await collector.collect(link)).toMatchObject([{ type: 'artifact', filename: 'output.txt' }]);
  expect(await collector.collect(link)).toEqual([]);
});

test('real queued upload metadata survives persistence and reaches the scoped image bridge', async () => {
  const conv = await env.chatService.createConversation('Queued image');
  const png = createCanvas(4, 4).toBuffer('image/png');
  const uploaded = await env.multipartRequest('POST', `/api/chat/conversations/${conv.id}/upload`, 'files', 'queued.png', 'image/png', png);
  expect(uploaded.status).toBe(200);
  const attachments = uploaded.body.files;
  await env.chatService.setQueue(conv.id, [{ content: 'Describe queued image', attachments }]);
  const queued = (await env.chatService.getQueue(conv.id))[0];
  expect(queued.attachments).toHaveLength(1);
  const blocks = await cortexPromptContent(queued.content, queued.attachments!, path.join(env.chatService.artifactsDir, conv.id), 'claude-sonnet-4-6', '1.2.35', true);
  expect(blocks).toMatchObject([{ type: 'text', text: 'Describe queued image' }, { type: 'image', mimeType: 'image/png' }]);
});

test('two normalized native turns enter the existing ledger once each, with separate cache counts and unknown pricing', async () => {
  const ledger = new UsageLedgerStore(path.join(env.tmpDir, 'cortex-ledger.json'), (backend, model, usage) => applyCostEstimate(backend, model, usage));
  const raw = { inputTokens: 3, outputTokens: 5, cachedReadTokens: 11, cachedWriteTokens: 17 };
  for (let turn = 0; turn < 2; turn++) {
    const tracker = new CortexTurnUsage(); tracker.snapshot({ size: 100, used: 25 + turn });
    const events = [tracker.complete(raw, 'claude-sonnet-4-6'), tracker.complete(raw, 'claude-sonnet-4-6')].filter(event => event !== null);
    for (const event of events) await ledger.record('cortex-code', event.model!, event.usage);
  }
  const row = (await ledger.read()).days[0].records[0];
  expect(row.usage).toMatchObject({ inputTokens: 6, outputTokens: 10, cacheReadTokens: 22, cacheWriteTokens: 34, contextUsagePercentage: 26, costSource: 'none' });
  expect(row.usage.estimatedCostUsd).toBeUndefined();
});
