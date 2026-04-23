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

    // CLI should still be alive (grace period)
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

  test('CLI survives WS disconnect during grace period', async () => {
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
      content: 'test grace',
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
});

// ── Message Queue Persistence ──────────────────────────────────────────────

