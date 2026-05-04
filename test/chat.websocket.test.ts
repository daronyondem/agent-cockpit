/* eslint-disable @typescript-eslint/no-explicit-any */

import WebSocket from 'ws';
import { createChatRouterEnv, destroyChatRouterEnv, CSRF_TOKEN, type ChatRouterEnv } from './helpers/chatEnv';
import type { StreamEvent, SendMessageOptions } from '../src/types';

let env: ChatRouterEnv;

beforeEach(async () => { env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); });

describe('WebSocket streaming', () => {
  test('receives text and done events via WebSocket', async () => {
    const conv = await env.chatService.createConversation('WS Test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hello from WS', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    // Connect WS first, then POST message
    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test ws',
      backend: 'claude-code',
    });

    const events = await eventsPromise;
    const textEvent = events.find((e: any) => e.type === 'text');
    expect(textEvent).toBeDefined();
    expect(textEvent.content).toBe('Hello from WS');

    const doneEvent = events.find((e: any) => e.type === 'done');
    expect(doneEvent).toBeDefined();
  });

  test('broadcasts stream events to multiple WebSockets for the same conversation', async () => {
    const conv = await env.chatService.createConversation('WS Multi Client');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hello both clients', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws1 = await env.connectWs(conv.id);
    const ws2 = await env.connectWs(conv.id);
    const events1Promise = env.readWsEvents(ws1);
    const events2Promise = env.readWsEvents(ws2);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test multi-client ws',
      backend: 'claude-code',
    });

    const [events1, events2] = await Promise.all([events1Promise, events2Promise]);
    expect(events1.find((e: any) => e.type === 'text')?.content).toBe('Hello both clients');
    expect(events2.find((e: any) => e.type === 'text')?.content).toBe('Hello both clients');
    expect(events1.some((e: any) => e.type === 'done')).toBe(true);
    expect(events2.some((e: any) => e.type === 'done')).toBe(true);
  });

  test('records backend runtime without forwarding it over WebSocket', async () => {
    const conv = await env.chatService.createConversation('WS Runtime Metadata');
    let unblock!: () => void;
    const blockPromise = new Promise<void>(resolve => { unblock = resolve; });
    env.mockBackend.sendMessage = function() {
      async function* createStream() {
        yield { type: 'backend_runtime', externalSessionId: 'backend-session-1', activeTurnId: 'turn-1', processId: 1234 } as StreamEvent;
        yield { type: 'text', content: 'visible', streaming: true } as StreamEvent;
        await blockPromise;
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => { unblock(); },
        sendInput: () => {},
      };
    };

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    const send = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'runtime metadata',
      backend: 'claude-code',
    });
    expect(send.status).toBe(200);

    let jobs: Awaited<ReturnType<typeof env.streamJobs.listActive>> = [];
    try {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        jobs = await env.streamJobs.listActive();
        if (jobs.some(job => job.conversationId === conv.id && job.runtime?.activeTurnId === 'turn-1')) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      expect(jobs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          conversationId: conv.id,
          runtime: {
            externalSessionId: 'backend-session-1',
            activeTurnId: 'turn-1',
            processId: 1234,
          },
        }),
      ]));
    } finally {
      unblock();
    }

    const events = await eventsPromise;
    expect(events.some((e: any) => e.type === 'backend_runtime')).toBe(false);
    expect(events.find((e: any) => e.type === 'text')?.content).toBe('visible');
    expect(events.some((e: any) => e.type === 'done')).toBe(true);
  });

  test('receives tool_activity and tool_outcomes via WebSocket', async () => {
    const conv = await env.chatService.createConversation('WS Tools');

    env.mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Read', description: 'Reading file', id: 'tool_ws_1' },
      { type: 'tool_outcomes', outcomes: [{ toolUseId: 'tool_ws_1', isError: false, outcome: 'read', status: 'success' }] },
      { type: 'text', content: 'Done', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test tools',
      backend: 'claude-code',
    });

    const events = await eventsPromise;
    const toolEvent = events.find((e: any) => e.type === 'tool_activity');
    expect(toolEvent).toBeDefined();
    expect(toolEvent.tool).toBe('Read');

    const outcomeEvent = events.find((e: any) => e.type === 'tool_outcomes');
    expect(outcomeEvent).toBeDefined();
    expect(outcomeEvent.outcomes[0].status).toBe('success');
  });

  test('sends stdin input via WebSocket', async () => {
    const conv = await env.chatService.createConversation('WS Input');

    // Use a blocking generator so the stream stays alive until we signal
    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    const origSendMessage = env.mockBackend.sendMessage.bind(env.mockBackend);
    env.mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
      (this as any)._lastMessage = msg;
      (this as any)._lastOptions = opts || null;
      const self = this;
      async function* createStream() {
        yield { type: 'text', content: 'waiting', streaming: true } as StreamEvent;
        await blockPromise; // Block until unblock() is called
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => {},
        sendInput: (text: string) => { (self as any)._sendInputCalls.push(text); },
      };
    };

    const ws = await env.connectWs(conv.id);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test input',
      backend: 'claude-code',
    });

    // Wait for stream to start processing
    await new Promise(resolve => setTimeout(resolve, 100));

    // Send input via WS
    ws.send(JSON.stringify({ type: 'input', text: 'yes' }));

    // Wait for the input to be processed
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(env.mockBackend._sendInputCalls).toContain('yes');

    // Unblock to clean up
    unblock!();
    await new Promise(resolve => setTimeout(resolve, 50));
    ws.close();
  });

  test('delivers interaction input via HTTP when a stream is active', async () => {
    const conv = await env.chatService.createConversation('HTTP Input');

    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    env.mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
      (this as any)._lastMessage = msg;
      (this as any)._lastOptions = opts || null;
      const self = this;
      async function* createStream() {
        yield { type: 'text', content: 'waiting', streaming: true } as StreamEvent;
        await blockPromise;
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => {},
        sendInput: (text: string) => { (self as any)._sendInputCalls.push(text); },
      };
    };

    const ws = await env.connectWs(conv.id);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test input',
      backend: 'claude-code',
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/input`, {
      text: 'yes',
      streamActive: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('stdin');
    expect(env.mockBackend._sendInputCalls).toContain('yes');

    unblock!();
    await new Promise(resolve => setTimeout(resolve, 50));
    ws.close();
  });

  test('interaction input endpoint requests message fallback when no active stream exists', async () => {
    const conv = await env.chatService.createConversation('HTTP Input Fallback');

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/input`, {
      text: 'yes',
      streamActive: false,
    });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('message');
  });

  test('interaction input endpoint prefers message fallback when client stream is inactive', async () => {
    const conv = await env.chatService.createConversation('HTTP Input Race');

    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    env.mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
      (this as any)._lastMessage = msg;
      (this as any)._lastOptions = opts || null;
      const self = this;
      async function* createStream() {
        yield { type: 'text', content: 'waiting', streaming: true } as StreamEvent;
        await blockPromise;
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => {},
        sendInput: (text: string) => { (self as any)._sendInputCalls.push(text); },
      };
    };

    const ws = await env.connectWs(conv.id);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test input',
      backend: 'claude-code',
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/input`, {
      text: 'yes',
      streamActive: false,
    });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('message');
    expect(env.mockBackend._sendInputCalls).not.toContain('yes');

    unblock!();
    await new Promise(resolve => setTimeout(resolve, 50));
    ws.close();
  });

  test('sends abort via WebSocket', async () => {
    const conv = await env.chatService.createConversation('WS Abort');

    // Use a blocking generator so the stream stays alive
    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    let aborted = false;
    env.mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
      (this as any)._lastMessage = msg;
      (this as any)._lastOptions = opts || null;
      async function* createStream() {
        yield { type: 'text', content: 'working', streaming: true } as StreamEvent;
        await blockPromise;
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => { aborted = true; unblock!(); },
        sendInput: () => {},
      };
    };

    const ws = await env.connectWs(conv.id);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test abort',
      backend: 'claude-code',
    });

    // Wait for stream to start
    await new Promise(resolve => setTimeout(resolve, 100));

    // Abort via WS
    ws.send(JSON.stringify({ type: 'abort' }));

    // Wait for abort to be processed
    await new Promise(resolve => setTimeout(resolve, 100));

    // env.activeStreams should be cleared after abort
    expect(env.activeStreams.has(conv.id)).toBe(false);
    expect(aborted).toBe(true);

    const saved = await env.chatService.getConversation(conv.id);
    const assistant = saved?.messages.filter(m => m.role === 'assistant') || [];
    expect(assistant[assistant.length - 1].streamError).toEqual({
      message: 'Aborted by user',
      source: 'abort',
    });
    ws.close();
  });

  test('rejects WebSocket for invalid conversation path', async () => {
    const port = (env.server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/chat/invalid-path`);
    await new Promise<void>((resolve) => {
      ws.on('error', () => resolve());
      ws.on('close', () => resolve());
    });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });

  test('receives assistant_message via WebSocket', async () => {
    const conv = await env.chatService.createConversation('WS Msg Save');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Saved response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test save',
      backend: 'claude-code',
    });

    const events = await eventsPromise;
    const msgEvent = events.find((e: any) => e.type === 'assistant_message');
    expect(msgEvent).toBeDefined();
    expect(msgEvent.message.content).toBe('Saved response');
    expect(msgEvent.message.role).toBe('assistant');
  });
});

// ── WebSocket reconnection ─────────────────────────────────────────────────

describe('WebSocket reconnection', () => {
  test('replays buffered events on reconnect', async () => {
    const conv = await env.chatService.createConversation('WS Reconnect');

    // Use a blocking generator so stream stays alive across disconnect/reconnect
    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    env.mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
      (this as any)._lastMessage = msg;
      (this as any)._lastOptions = opts || null;
      async function* createStream() {
        yield { type: 'text', content: 'chunk1', streaming: true } as StreamEvent;
        yield { type: 'text', content: 'chunk2', streaming: true } as StreamEvent;
        await blockPromise;
        yield { type: 'text', content: 'chunk3', streaming: true } as StreamEvent;
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => { unblock!(); },
        sendInput: () => {},
      };
    };

    // Connect WS, start stream, receive first two chunks
    const ws1 = await env.connectWs(conv.id);
    const events1: any[] = [];
    const gotChunk2 = new Promise<void>((resolve) => {
      ws1.on('message', (data) => {
        const event = JSON.parse(data.toString());
        events1.push(event);
        if (event.type === 'text' && event.content === 'chunk2') resolve();
      });
    });

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test reconnect',
      backend: 'claude-code',
    });

    await gotChunk2;
    expect(events1.filter(e => e.type === 'text')).toHaveLength(2);

    // Disconnect WS (simulate network drop)
    ws1.close();
    await new Promise(resolve => setTimeout(resolve, 100));

    // CLI should still be alive after browser transport disconnects.
    expect(env.activeStreams.has(conv.id)).toBe(true);

    // Reconnect — set up message listener BEFORE open so we don't miss replay
    const port = (env.server.address() as any).port;
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/api/chat/conversations/${conv.id}/ws`);
    const allEvents: any[] = [];
    const gotDone = new Promise<void>((resolve) => {
      ws2.on('message', (data) => {
        const event = JSON.parse(data.toString());
        allEvents.push(event);
        if (event.type === 'done') resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws2.on('open', () => resolve());
      ws2.on('error', reject);
    });

    // Unblock stream so it can finish
    unblock!();
    await gotDone;

    // Should have: replay_start, chunk1, chunk2, replay_end, chunk3, assistant_message, done
    expect(allEvents[0].type).toBe('replay_start');
    expect(allEvents[0].bufferedEvents).toBe(2);
    const replayEnd = allEvents.find(e => e.type === 'replay_end');
    expect(replayEnd).toBeDefined();
    const replayEndIdx = allEvents.indexOf(replayEnd);
    // Replayed texts come between replay_start and replay_end
    const replayedTexts = allEvents.slice(1, replayEndIdx).filter(e => e.type === 'text');
    expect(replayedTexts).toHaveLength(2);
    expect(replayedTexts[0].content).toBe('chunk1');
    expect(replayedTexts[1].content).toBe('chunk2');
    // Live events come after replay_end
    const liveEvents = allEvents.slice(replayEndIdx + 1);
    const liveText = liveEvents.find(e => e.type === 'text' && e.content === 'chunk3');
    expect(liveText).toBeDefined();
    const doneEvent = liveEvents.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();

    ws2.close();
  });

  test('cleans completed replay buffer even when WebSocket is connected at done', async () => {
    await destroyChatRouterEnv(env);
    env = await createChatRouterEnv({ bufferCleanupMs: 50 });

    const conv = await env.chatService.createConversation('Connected Done Cleanup');
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'short run', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws1 = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws1);

    const postRes = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'finish while connected',
      backend: 'claude-code',
    });
    expect(postRes.status).toBe(200);
    const events = await eventsPromise;
    expect(events.some(e => e.type === 'done')).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 100));
    ws1.close();

    const ws2 = await env.connectWs(conv.id);
    const reconnectEvents: any[] = [];
    await new Promise<void>(resolve => {
      setTimeout(() => resolve(), 100);
      ws2.on('message', (data) => {
        try { reconnectEvents.push(JSON.parse(data.toString())); } catch {}
      });
    });

    expect(reconnectEvents.some(e => e.type === 'replay_start')).toBe(false);
    ws2.close();
  });

  test('uses configured cleanup timeout after replaying a completed buffer', async () => {
    await destroyChatRouterEnv(env);
    env = await createChatRouterEnv({ bufferCleanupMs: 50 });

    const conv = await env.chatService.createConversation('Replay Cleanup Timeout');
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'buffered completion', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const postRes = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'finish before connect',
      backend: 'claude-code',
    });
    expect(postRes.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 10));

    const port = (env.server.address() as any).port;
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/api/chat/conversations/${conv.id}/ws`);
    const replayed: any[] = [];
    const gotReplayEnd = new Promise<void>((resolve) => {
      ws1.on('message', (data) => {
        const event = JSON.parse(data.toString());
        replayed.push(event);
        if (event.type === 'replay_end') resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws1.on('open', () => resolve());
      ws1.on('error', reject);
    });
    await gotReplayEnd;
    expect(replayed.some(e => e.type === 'replay_start')).toBe(true);
    ws1.close();

    await new Promise(resolve => setTimeout(resolve, 100));

    const ws2 = await env.connectWs(conv.id);
    const secondConnectEvents: any[] = [];
    await new Promise<void>(resolve => {
      setTimeout(() => resolve(), 100);
      ws2.on('message', (data) => {
        try { secondConnectEvents.push(JSON.parse(data.toString())); } catch {}
      });
    });

    expect(secondConnectEvents.some(e => e.type === 'replay_start')).toBe(false);
    ws2.close();
  });

  test('explicit reconnect replays buffer created after WebSocket connection', async () => {
    const conv = await env.chatService.createConversation('Explicit Reconnect Fresh Buffer');
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'created-after-connect', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const gotDone = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === 'done') resolve();
      });
    });

    const postRes = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'buffer after connect',
      backend: 'claude-code',
    });
    expect(postRes.status).toBe(200);
    await gotDone;

    const replayEvents: any[] = [];
    const gotReplayEnd = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const event = JSON.parse(data.toString());
        replayEvents.push(event);
        if (event.type === 'replay_end') resolve();
      });
    });
    ws.send(JSON.stringify({ type: 'reconnect' }));
    await gotReplayEnd;

    expect(replayEvents[0]).toMatchObject({ type: 'replay_start', bufferedEvents: expect.any(Number) });
    expect(replayEvents.some(e => e.type === 'text' && e.content === 'created-after-connect')).toBe(true);
    expect(replayEvents.some(e => e.type === 'done')).toBe(true);
    ws.close();
  });

  test('CLI survives WS disconnect without abort timer', async () => {
    const conv = await env.chatService.createConversation('WS Grace');

    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    env.mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
      (this as any)._lastMessage = msg;
      (this as any)._lastOptions = opts || null;
      async function* createStream() {
        yield { type: 'text', content: 'alive', streaming: true } as StreamEvent;
        await blockPromise;
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => { unblock!(); },
        sendInput: () => {},
      };
    };

    const ws = await env.connectWs(conv.id);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test disconnect',
      backend: 'claude-code',
    });

    // Wait for stream to start
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(env.activeStreams.has(conv.id)).toBe(true);

    // Disconnect — stream should survive
    ws.close();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(env.activeStreams.has(conv.id)).toBe(true);

    // Cleanup
    unblock!();
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  test('CLI crash during disconnect buffers error for replay', async () => {
    const conv = await env.chatService.createConversation('WS Crash');

    let triggerError: () => void;
    const errorPromise = new Promise<void>(r => { triggerError = r; });
    env.mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
      (this as any)._lastMessage = msg;
      (this as any)._lastOptions = opts || null;
      async function* createStream() {
        yield { type: 'text', content: 'partial', streaming: true } as StreamEvent;
        await errorPromise;
        throw new Error('CLI crashed');
      }
      return {
        stream: createStream(),
        abort: () => { triggerError!(); },
        sendInput: () => {},
      };
    };

    const ws1 = await env.connectWs(conv.id);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test crash',
      backend: 'claude-code',
    });

    // Wait for first event
    await new Promise(resolve => setTimeout(resolve, 100));

    // Disconnect
    ws1.close();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Trigger CLI crash while disconnected
    triggerError!();
    await new Promise(resolve => setTimeout(resolve, 200));

    // Reconnect — set up listener before open to catch replay
    const port = (env.server.address() as any).port;
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/api/chat/conversations/${conv.id}/ws`);
    const events: any[] = [];
    const gotReplayEnd = new Promise<void>((resolve) => {
      ws2.on('message', (data) => {
        const event = JSON.parse(data.toString());
        events.push(event);
        if (event.type === 'replay_end') resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws2.on('open', () => resolve());
      ws2.on('error', reject);
    });
    await gotReplayEnd;

    expect(events[0].type).toBe('replay_start');
    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error).toBe('CLI crashed');
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();

    ws2.close();
  });

  test('abort via WS clears buffer', async () => {
    const conv = await env.chatService.createConversation('WS Abort Buffer');

    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    let aborted = false;
    env.mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
      (this as any)._lastMessage = msg;
      (this as any)._lastOptions = opts || null;
      async function* createStream() {
        yield { type: 'text', content: 'work', streaming: true } as StreamEvent;
        await blockPromise;
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => { aborted = true; unblock!(); },
        sendInput: () => {},
      };
    };

    const ws = await env.connectWs(conv.id);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test abort buffer',
      backend: 'claude-code',
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    // Abort via WS — should clear buffer and stream
    ws.send(JSON.stringify({ type: 'abort' }));
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(aborted).toBe(true);
    expect(env.activeStreams.has(conv.id)).toBe(false);

    ws.close();
  });

  test('session reset clears stale event buffer', async () => {
    const conv = await env.chatService.createConversation('WS Reset Buffer');

    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    env.mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
      (this as any)._lastMessage = msg;
      (this as any)._lastOptions = opts || null;
      async function* createStream() {
        yield { type: 'text', content: 'old-session', streaming: true } as StreamEvent;
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => { unblock!(); },
        sendInput: () => {},
      };
    };

    // Start a stream and let it complete — events get buffered
    const ws1 = await env.connectWs(conv.id);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'old session message',
      backend: 'claude-code',
    });
    const events1 = await env.readWsEvents(ws1);
    expect(events1.some(e => e.type === 'done')).toBe(true);

    // Disconnect — buffer still exists on server
    await new Promise(resolve => setTimeout(resolve, 100));

    // Reset session — should clear the buffer
    const resetRes = await env.request('POST', `/api/chat/conversations/${conv.id}/reset`);
    expect(resetRes.status).toBe(200);

    // Reconnect after reset — should NOT replay old events
    const ws2 = await env.connectWs(conv.id);
    const reconnectEvents: any[] = [];
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => resolve(), 500);
      ws2.on('message', (data) => {
        try { reconnectEvents.push(JSON.parse(data.toString())); } catch {}
      });
    });

    // No replay_start means the buffer was cleared
    expect(reconnectEvents.some(e => e.type === 'replay_start')).toBe(false);
    expect(reconnectEvents.some(e => e.type === 'text')).toBe(false);

    ws2.close();
  });

  test('does not replay live-only KB state frames after reconnect', async () => {
    const conv = await env.chatService.createConversation('Live KB Frame');
    const ws1 = await env.connectWs(conv.id);
    const gotLiveFrame = new Promise<void>((resolve) => {
      ws1.on('message', (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === 'kb_state_update') resolve();
      });
    });

    env.wsFns.send(conv.id, {
      type: 'kb_state_update',
      updatedAt: '2026-05-01T00:00:00.000Z',
      changed: { synthesis: true },
    });
    await gotLiveFrame;
    await new Promise<void>(resolve => {
      ws1.once('close', () => resolve());
      ws1.close();
    });

    const ws2 = await env.connectWs(conv.id);
    const reconnectEvents: any[] = [];
    await new Promise<void>(resolve => {
      setTimeout(() => resolve(), 100);
      ws2.on('message', (data) => {
        try { reconnectEvents.push(JSON.parse(data.toString())); } catch {}
      });
    });

    expect(reconnectEvents.some(e => e.type === 'replay_start')).toBe(false);
    expect(reconnectEvents.some(e => e.type === 'kb_state_update')).toBe(false);
    ws2.close();
  });

  test('idle connected workspace conversation receives memory_update on memory delete', async () => {
    const conv = await env.chatService.createConversation('Idle Memory Fanout', '/tmp/ws-idle-memory-fanout');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const relPath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: drop\ndescription: drop me\ntype: user\n---\n\nDrop.',
      source: 'memory-note',
      filenameHint: 'drop',
    });

    const ws = await env.connectWs(conv.id);
    expect(env.activeStreams.has(conv.id)).toBe(false);

    const gotMemoryUpdate = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for memory_update')), 1000);
      ws.on('message', (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === 'memory_update') {
          clearTimeout(timer);
          resolve(event);
        }
      });
    });

    const res = await env.request(
      'DELETE',
      `/api/chat/workspaces/${hash}/memory/entries/${encodeURIComponent(relPath)}`,
    );
    expect(res.status).toBe(200);

    const frame = await gotMemoryUpdate;
    expect(frame).toMatchObject({
      type: 'memory_update',
      fileCount: 0,
      changedFiles: [relPath],
    });
    ws.close();
  });
});

// ── POST without WebSocket — network-change recovery ──────────────────────

describe('POST /message without an open WebSocket', () => {
  test('stream still runs and buffered events replay on later WS connect', async () => {
    const conv = await env.chatService.createConversation('POST No WS');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'buffered text', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    // POST /message WITHOUT opening a WS first — pre-fix this would buffer
    // the user message but never spawn the CLI.
    const postRes = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'no ws yet',
      backend: 'claude-code',
    });
    expect(postRes.status).toBe(200);

    // Give the stream a moment to run and emit into the buffer.
    await new Promise(resolve => setTimeout(resolve, 200));

    // Now connect — server should replay the buffered events. Register the
    // message listener BEFORE 'open' so the synchronous replay isn't missed.
    const port = (env.server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/chat/conversations/${conv.id}/ws`);
    const events: any[] = [];
    const gotReplayEnd = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const event = JSON.parse(data.toString());
        events.push(event);
        if (event.type === 'replay_end') resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await gotReplayEnd;

    expect(events[0].type).toBe('replay_start');
    const replayedText = events.find(e => e.type === 'text' && e.content === 'buffered text');
    expect(replayedText).toBeDefined();
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();

    ws.close();
  });

  test('CLI continues beyond old disconnect grace and replays buffered completion on reconnect', async () => {
    await destroyChatRouterEnv(env);
    env = await createChatRouterEnv({ gracePeriodMs: 200 });

    const conv = await env.chatService.createConversation('No Grace Abort');

    let aborted = false;
    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    env.mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
      (this as any)._lastMessage = msg;
      (this as any)._lastOptions = opts || null;
      async function* createStream() {
        yield { type: 'text', content: 'partial', streaming: true } as StreamEvent;
        await blockPromise;
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => { aborted = true; unblock!(); },
        sendInput: () => {},
      };
    };

    const postRes = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'client away',
      backend: 'claude-code',
    });
    expect(postRes.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 500));

    expect(aborted).toBe(false);
    expect(env.activeStreams.has(conv.id)).toBe(true);

    unblock!();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(env.activeStreams.has(conv.id)).toBe(false);

    const port = (env.server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/chat/conversations/${conv.id}/ws`);
    const events: any[] = [];
    const gotReplayEnd = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const event = JSON.parse(data.toString());
        events.push(event);
        if (event.type === 'replay_end') resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await gotReplayEnd;

    expect(events[0].type).toBe('replay_start');
    const textEvent = events.find(e => e.type === 'text' && e.content === 'partial');
    expect(textEvent).toBeDefined();
    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent).toBeUndefined();
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();

    ws.close();
  });
});

// ── Message Queue Persistence ──────────────────────────────────────────────
