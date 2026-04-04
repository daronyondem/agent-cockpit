import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';
import { ChatService } from '../src/services/chatService';
import { createChatRouter } from '../src/routes/chat';
import { attachWebSocket } from '../src/ws';
import { BaseBackendAdapter } from '../src/services/backends/base';
import { BackendRegistry } from '../src/services/backends/registry';
import type { BackendMetadata, SendMessageOptions, SendMessageResult, StreamEvent, Message, ActiveStreamEntry } from '../src/types';

// ── Test helpers ────────────────────────────────────────────────────────────

const DEFAULT_WORKSPACE = '/tmp/test-workspace';
let tmpDir: string;
let chatService: ChatService;
let app: express.Express;
let server: http.Server;
let baseUrl: string;
const CSRF_TOKEN = 'test-csrf-token';

class MockBackendAdapter extends BaseBackendAdapter {
  _lastMessage: string | null;
  _lastOptions: SendMessageOptions | null;
  _mockEvents: StreamEvent[];
  _sendInputCalls: string[];
  _mockTitle?: string;

  constructor() {
    super({ workingDir: '/tmp' });
    this._lastMessage = null;
    this._lastOptions = null;
    this._mockEvents = [];
    this._sendInputCalls = [];
  }

  get metadata(): BackendMetadata {
    return {
      id: 'claude-code',
      label: 'Claude Code',
      icon: null,
      capabilities: { thinking: true, planMode: true, agents: true, toolActivity: true, userQuestions: true, stdinInput: true },
    };
  }

  setMockEvents(events: StreamEvent[]) {
    this._mockEvents = events;
  }

  sendMessage(message: string, options?: SendMessageOptions): SendMessageResult {
    this._lastMessage = message;
    this._lastOptions = options || null;
    const events = this._mockEvents.slice();
    const self = this;

    async function* createStream() {
      for (const event of events) {
        yield event;
      }
    }

    return {
      stream: createStream(),
      abort: () => {},
      sendInput: (text: string) => { self._sendInputCalls.push(text); },
    };
  }

  async generateSummary(messages: Pick<Message, 'role' | 'content'>[], fallback: string) {
    return fallback || `Session (${messages.length} messages)`;
  }

  async generateTitle(userMessage: string, fallback: string) {
    return this._mockTitle || fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
  }
}

function makeRequest(method: string, urlPath: string, body?: any): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const options: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'x-csrf-token': CSRF_TOKEN,
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode!, body: data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function connectWs(convId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/chat/conversations/${convId}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function readWsEvents(ws: WebSocket, timeout = 3000): Promise<any[]> {
  return new Promise((resolve) => {
    const events: any[] = [];
    const timer = setTimeout(() => {
      ws.close();
      resolve(events);
    }, timeout);
    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        events.push(event);
        if (event.type === 'done') {
          clearTimeout(timer);
          ws.close();
          resolve(events);
        }
      } catch {}
    });
    ws.on('close', () => {
      clearTimeout(timer);
      resolve(events);
    });
  });
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

let mockBackend: MockBackendAdapter;
let backendRegistry: BackendRegistry;
let activeStreams: Map<string, ActiveStreamEntry>;
let wsShutdown: () => void;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroute-'));
  mockBackend = new MockBackendAdapter();
  backendRegistry = new BackendRegistry();
  backendRegistry.register(mockBackend);
  chatService = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE, backendRegistry });
  await chatService.initialize();

  app = express();
  app.use(express.json());

  // Mock session middleware
  app.use((req: any, _res: any, next: any) => {
    req.session = { csrfToken: CSRF_TOKEN };
    next();
  });

  const chatResult = createChatRouter({ chatService, backendRegistry, updateService: null as any });
  activeStreams = chatResult.activeStreams;
  app.use('/api/chat', chatResult.router);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const port = (server.address() as any).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Attach WebSocket server (local requests bypass auth)
  const mockStore = {
    get: (_sid: string, cb: (err: any, session: any) => void) => cb(null, null),
    set: (_sid: string, _session: any, cb?: (err?: any) => void) => cb?.(),
    destroy: (_sid: string, cb?: (err?: any) => void) => cb?.(),
  } as any;
  const wsResult = attachWebSocket(server, {
    sessionStore: mockStore,
    sessionSecret: 'test-secret',
    activeStreams,
  });
  wsShutdown = wsResult.shutdown;
  chatResult.setWsFunctions(wsResult);
});

afterEach((done) => {
  wsShutdown();
  server.close(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    done();
  });
});

// ── Tool activity forwarding ────────────────────────────────────────────────

describe('Tool activity forwarding', () => {
  test('forwards enriched tool_activity fields via WebSocket', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Read', description: 'Reading `app.js`', id: 'tool_1' },
      { type: 'text', content: 'Result', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const toolEvent = events.find((e: any) => e.type === 'tool_activity');
    expect(toolEvent).toBeDefined();
    expect(toolEvent.tool).toBe('Read');
    expect(toolEvent.description).toBe('Reading `app.js`');
    expect(toolEvent.id).toBe('tool_1');
  });

  test('forwards isAgent flag via WebSocket', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Agent', description: 'Explore code', isAgent: true, subagentType: 'Explore' },
      { type: 'text', content: 'Done', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'explore',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const agentEvent = events.find((e: any) => e.type === 'tool_activity');
    expect(agentEvent).toBeDefined();
    expect(agentEvent.isAgent).toBe(true);
    expect(agentEvent.subagentType).toBe('Explore');
  });

  test('forwards isPlanMode and planAction via WebSocket', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'EnterPlanMode', isPlanMode: true, planAction: 'enter', description: 'Entering plan mode' },
      { type: 'tool_activity', tool: 'ExitPlanMode', isPlanMode: true, planAction: 'exit', description: 'Plan ready for approval' },
      { type: 'text', content: 'Plan done', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'plan',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const planEvents = events.filter((e: any) => e.type === 'tool_activity' && e.isPlanMode);
    expect(planEvents).toHaveLength(2);
    expect(planEvents[0].planAction).toBe('enter');
    expect(planEvents[1].planAction).toBe('exit');
  });

  test('forwards isQuestion flag and questions via WebSocket', async () => {
    const conv = await chatService.createConversation('Test');
    const questions = [{ question: 'Which approach?', options: [{ label: 'A' }] }];

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'AskUserQuestion', isQuestion: true, questions, description: 'Asking a question' },
      { type: 'text', content: 'Ok', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'question',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const questionEvent = events.find((e: any) => e.type === 'tool_activity' && e.isQuestion);
    expect(questionEvent).toBeDefined();
    expect(questionEvent.questions).toEqual(questions);
  });
});

// ── Tool activity persistence ────────────────────────────────────────────────

describe('Tool activity persistence', () => {
  test('persists toolActivity on intermediate message at turn_boundary', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Read', description: 'Reading `app.js`', id: 'tool_1' },
      { type: 'tool_activity', tool: 'Grep', description: 'Searching for `foo`', id: 'tool_2' },
      { type: 'text', content: 'First response', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Second response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await eventsPromise;

    const loaded = (await chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    // First assistant message (intermediate) should have toolActivity
    expect(assistantMsgs[0].toolActivity).toBeDefined();
    expect(assistantMsgs[0].toolActivity).toHaveLength(2);
    expect(assistantMsgs[0].toolActivity![0].tool).toBe('Read');
    expect(assistantMsgs[0].toolActivity![1].tool).toBe('Grep');
  });

  test('persists toolActivity on final message at done', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Bash', description: 'Running tests', id: 'tool_1' },
      { type: 'text', content: 'Tests passed', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await eventsPromise;

    const loaded = (await chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs[0].toolActivity).toBeDefined();
    expect(assistantMsgs[0].toolActivity).toHaveLength(1);
    expect(assistantMsgs[0].toolActivity![0].tool).toBe('Bash');
    expect(assistantMsgs[0].toolActivity![0].duration).toBeGreaterThanOrEqual(0);
    expect(assistantMsgs[0].toolActivity![0].startTime).toBeDefined();
  });

  test('does not persist isPlanMode or isQuestion events as toolActivity', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'EnterPlanMode', isPlanMode: true, planAction: 'enter', description: 'Entering plan mode' },
      { type: 'tool_activity', tool: 'ExitPlanMode', isPlanMode: true, planAction: 'exit', description: 'Plan ready' },
      { type: 'tool_activity', tool: 'AskUserQuestion', isQuestion: true, questions: [], description: 'Asking' },
      { type: 'tool_activity', tool: 'Read', description: 'Reading `file.js`', id: 'tool_1' },
      { type: 'text', content: 'Done', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await eventsPromise;

    const loaded = (await chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs[0].toolActivity).toBeDefined();
    // Only the Read tool should be persisted, not plan mode or question events
    expect(assistantMsgs[0].toolActivity).toHaveLength(1);
    expect(assistantMsgs[0].toolActivity![0].tool).toBe('Read');
  });

  test('toolActivity absent when no tool events occur', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'text', content: 'Just text', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await eventsPromise;

    const loaded = (await chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs[0].toolActivity).toBeUndefined();
  });

  test('persists agent tool activity with isAgent and subagentType', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Agent', description: 'Explore codebase', isAgent: true, subagentType: 'Explore', id: 'agent_1' },
      { type: 'text', content: 'Found results', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await eventsPromise;

    const loaded = (await chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs[0].toolActivity).toBeDefined();
    expect(assistantMsgs[0].toolActivity![0].isAgent).toBe(true);
    expect(assistantMsgs[0].toolActivity![0].subagentType).toBe('Explore');
  });

  test('forwards tool_outcomes event to client', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Grep', description: 'Searching', id: 'tool_1' },
      { type: 'tool_outcomes', outcomes: [{ toolUseId: 'tool_1', outcome: '5 matches', status: 'success' }] },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Found it', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const outcomeEvent = events.find((e: any) => e.type === 'tool_outcomes');
    expect(outcomeEvent).toBeDefined();
    expect(outcomeEvent.outcomes[0].outcome).toBe('5 matches');
    expect(outcomeEvent.outcomes[0].status).toBe('success');
  });

  test('persists outcome and status on toolActivity entries', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Bash', description: 'Running tests', id: 'tool_1' },
      { type: 'tool_outcomes', outcomes: [{ toolUseId: 'tool_1', outcome: 'exit 0', status: 'success' }] },
      { type: 'text', content: 'Tests pass', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Done', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await eventsPromise;

    const loaded = (await chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    // First message (intermediate, saved at turn_boundary) should have outcome
    expect(assistantMsgs[0].toolActivity).toBeDefined();
    expect(assistantMsgs[0].toolActivity![0].outcome).toBe('exit 0');
    expect(assistantMsgs[0].toolActivity![0].status).toBe('success');
  });
});

// ── Parallel grouping and session overview ────────────────────────────────────

describe('Tool activity Phase 3 features', () => {
  test('persists multiple agents with close startTimes for parallel grouping', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Agent', description: 'Search code', id: 'a1', isAgent: true, subagentType: 'Explore' },
      { type: 'tool_activity', tool: 'Agent', description: 'Check tests', id: 'a2', isAgent: true, subagentType: 'Explore' },
      { type: 'text', content: 'Result', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);
    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test', backend: 'claude-code',
    });
    await eventsPromise;

    const loaded = (await chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs[0].toolActivity).toBeDefined();
    expect(assistantMsgs[0].toolActivity).toHaveLength(2);
    expect(assistantMsgs[0].toolActivity![0].isAgent).toBe(true);
    expect(assistantMsgs[0].toolActivity![1].isAgent).toBe(true);
    // Both should have startTime for frontend parallel grouping
    expect(assistantMsgs[0].toolActivity![0].startTime).toBeDefined();
    expect(assistantMsgs[0].toolActivity![1].startTime).toBeDefined();
  });

  test('persists mix of tool and agent activity for session overview aggregation', async () => {
    const conv = await chatService.createConversation('Test');

    // First turn: tool activity
    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Read', description: 'Read file.js', id: 't1' },
      { type: 'tool_activity', tool: 'Grep', description: 'Search pattern', id: 't2' },
      { type: 'text', content: 'Found it', streaming: true },
      { type: 'turn_boundary' },
      // Second turn: agent activity
      { type: 'tool_activity', tool: 'Agent', description: 'Explore codebase', id: 'a1', isAgent: true, subagentType: 'Explore' },
      { type: 'text', content: 'Done exploring', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);
    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test', backend: 'claude-code',
    });
    await eventsPromise;

    const loaded = (await chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    // Should have 2 assistant messages (turn_boundary + done)
    expect(assistantMsgs.length).toBe(2);
    // First message has Read + Grep
    expect(assistantMsgs[0].toolActivity).toHaveLength(2);
    expect(assistantMsgs[0].toolActivity![0].tool).toBe('Read');
    expect(assistantMsgs[0].toolActivity![1].tool).toBe('Grep');
    // Second message has Agent
    expect(assistantMsgs[1].toolActivity).toHaveLength(1);
    expect(assistantMsgs[1].toolActivity![0].isAgent).toBe(true);
    expect(assistantMsgs[1].toolActivity![0].subagentType).toBe('Explore');
  });
});

// ── Turn boundary intermediate message saving ───────────────────────────────

describe('Turn boundary intermediate messages', () => {
  test('saves intermediate message on turn_boundary', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'text', content: 'First response', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Second response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    // Should have two assistant_message events (one intermediate, one final)
    const assistantMessages = events.filter((e: any) => e.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0].message.content).toBe('First response');
    expect(assistantMessages[1].message.content).toBe('Second response');

    // Verify persisted to disk
    const loaded = (await chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
  });

  test('saves thinking with intermediate message', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'thinking', content: 'Let me think...', streaming: true },
      { type: 'text', content: 'Response with thinking', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'After tool use', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const assistantMessages = events.filter((e: any) => e.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(2);

    // First message should have thinking
    expect(assistantMessages[0].message.thinking).toBe('Let me think...');
    expect(assistantMessages[0].message.content).toBe('Response with thinking');

    // Verify persisted
    const loaded = (await chatService.getConversation(conv.id))!;
    const firstAssistant = loaded.messages.find((m: any) => m.role === 'assistant');
    expect(firstAssistant!.thinking).toBe('Let me think...');
  });

  test('does not save intermediate message when no streaming content', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'turn_boundary' }, // boundary with no preceding text
      { type: 'text', content: 'Final', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const assistantMessages = events.filter((e: any) => e.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(1); // Only the final message
    expect(assistantMessages[0].message.content).toBe('Final');
  });

  test('does not save intermediate message for non-streaming text', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'text', content: 'Replayed history' }, // No streaming: true flag
      { type: 'turn_boundary' },
      { type: 'text', content: 'New content', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const assistantMessages = events.filter((e: any) => e.type === 'assistant_message');
    // Only the final "New content" should be saved (replayed text is not streaming)
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].message.content).toBe('New content');
  });

  test('saves result text as final message when no streaming deltas', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'result', content: 'The final result' },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const assistantMessages = events.filter((e: any) => e.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].message.content).toBe('The final result');
  });
});

// ── Turn complete event forwarding ───────────────────────────────────────────

describe('Turn complete event forwarding', () => {
  test('sends turn_complete event on turn_boundary even without text', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'turn_boundary' }, // boundary with no preceding text
      { type: 'text', content: 'Final', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    // Should have turn_complete event even though no text was saved
    const turnCompletes = events.filter((e: any) => e.type === 'turn_complete');
    expect(turnCompletes).toHaveLength(1);
  });

  test('sends turn_complete alongside assistant_message when text exists', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'text', content: 'First response', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Second response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    // Should have both assistant_message and turn_complete
    const assistantMessages = events.filter((e: any) => e.type === 'assistant_message');
    const turnCompletes = events.filter((e: any) => e.type === 'turn_complete');
    expect(assistantMessages).toHaveLength(2);
    expect(turnCompletes).toHaveLength(1);

    // turn_complete should come after the intermediate assistant_message
    const assistantIdx = events.findIndex((e: any) => e.type === 'assistant_message');
    const turnCompleteIdx = events.findIndex((e: any) => e.type === 'turn_complete');
    expect(turnCompleteIdx).toBeGreaterThan(assistantIdx);
  });

  test('sends turn_complete for each turn_boundary', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'text', content: 'First', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Second', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Third', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const turnCompletes = events.filter((e: any) => e.type === 'turn_complete');
    expect(turnCompletes).toHaveLength(2);
  });
});

// ── Auto title update on new session ────────────────────────────────────────

describe('Auto title update on new session', () => {
  test('sends title_updated event after first assistant message in reset session', async () => {
    const conv = await chatService.createConversation('Original Title');
    await chatService.addMessage(conv.id, 'user', 'Old topic', 'claude-code');
    await chatService.addMessage(conv.id, 'assistant', 'Old response', 'claude-code');
    await chatService.resetSession(conv.id);

    mockBackend._mockTitle = 'New Topic Title';
    mockBackend.setMockEvents([
      { type: 'text', content: 'New response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'New topic question',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const titleEvents = events.filter((e: any) => e.type === 'title_updated');
    expect(titleEvents).toHaveLength(1);
    expect(titleEvents[0].title).toBe('New Topic Title');

    // Verify title was persisted
    const loaded = (await chatService.getConversation(conv.id))!;
    expect(loaded.title).toBe('New Topic Title');
  });

  test('does not send title_updated on first session', async () => {
    const conv = await chatService.createConversation('New Chat');

    mockBackend.setMockEvents([
      { type: 'text', content: 'First response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello world',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const titleEvents = events.filter((e: any) => e.type === 'title_updated');
    expect(titleEvents).toHaveLength(0);
  });

  test('sends title_updated only once even with multiple assistant messages', async () => {
    const conv = await chatService.createConversation('Original');
    await chatService.addMessage(conv.id, 'user', 'Old msg', 'claude-code');
    await chatService.resetSession(conv.id);

    mockBackend._mockTitle = 'Updated Title';
    mockBackend.setMockEvents([
      { type: 'text', content: 'First part', streaming: true },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Second part', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'New session question',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const titleEvents = events.filter((e: any) => e.type === 'title_updated');
    expect(titleEvents).toHaveLength(1);
  });
});

// ── Workspace context injection ──────────────────────────────────────────────

describe('Workspace context injection', () => {
  test('injects workspace context on new session message', async () => {
    const conv = await chatService.createConversation('Test', '/tmp/inject-test');

    mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    // The CLI should receive the injected message
    expect(mockBackend._lastMessage).toContain('Workspace discussion history');
    expect(mockBackend._lastMessage).toContain('Hello');
  });

  test('does not inject context on subsequent messages', async () => {
    const conv = await chatService.createConversation('Test', '/tmp/inject-test');
    // Add a message first so it's not a new session
    await chatService.addMessage(conv.id, 'user', 'First msg', 'claude-code');

    mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Second msg',
      backend: 'claude-code',
    });

    // The CLI should receive just the message, no injection
    expect(mockBackend._lastMessage).toBe('Second msg');
    expect(mockBackend._lastMessage).not.toContain('Workspace discussion history');
  });

  test('stores user message without injection in conversation', async () => {
    const conv = await chatService.createConversation('Test', '/tmp/inject-test');

    mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const res = await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    // The stored message should NOT contain the injection
    expect(res.body.userMessage.content).toBe('Hello');
  });
});

// ── System prompt passthrough ──────────────────────────────────────────────

describe('System prompt passthrough', () => {
  test('passes systemPrompt to backend on new session', async () => {
    // Save a system prompt to settings
    await chatService.saveSettings({ theme: 'system', systemPrompt: 'You are a pirate' } as any);

    const conv = await chatService.createConversation('Test');
    mockBackend.setMockEvents([
      { type: 'text', content: 'Ahoy', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(mockBackend._lastOptions!.systemPrompt).toBe('You are a pirate');
  });

  test('passes empty systemPrompt when none configured', async () => {
    const conv = await chatService.createConversation('Test');
    mockBackend.setMockEvents([
      { type: 'text', content: 'Hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(mockBackend._lastOptions!.systemPrompt).toBe('');
  });

  test('does not pass systemPrompt on subsequent messages', async () => {
    await chatService.saveSettings({ theme: 'system', systemPrompt: 'You are a pirate' } as any);

    const conv = await chatService.createConversation('Test');
    await chatService.addMessage(conv.id, 'user', 'First msg', 'claude-code');

    mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Second msg',
      backend: 'claude-code',
    });

    // On resumed sessions, systemPrompt should be empty (not fetched)
    expect(mockBackend._lastOptions!.systemPrompt).toBe('');
  });
});

// ── PATCH /conversations/:id/archive ───────────────────��─────────────────────

describe('PATCH /conversations/:id/archive', () => {
  test('archives a conversation', async () => {
    const conv = await chatService.createConversation('Test');
    const res = await makeRequest('PATCH', `/api/chat/conversations/${conv.id}/archive`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Should not appear in default list
    const listRes = await makeRequest('GET', '/api/chat/conversations');
    expect(listRes.body.conversations.find((c: any) => c.id === conv.id)).toBeUndefined();

    // Should appear in archived list
    const archiveRes = await makeRequest('GET', '/api/chat/conversations?archived=true');
    expect(archiveRes.body.conversations.find((c: any) => c.id === conv.id)).toBeDefined();
  });

  test('returns 404 for non-existent conversation', async () => {
    const res = await makeRequest('PATCH', '/api/chat/conversations/nope/archive');
    expect(res.status).toBe(404);
  });
});

// ── PATCH /conversations/:id/restore ─────────────────────────────────────────

describe('PATCH /conversations/:id/restore', () => {
  test('restores an archived conversation', async () => {
    const conv = await chatService.createConversation('Test');
    await chatService.archiveConversation(conv.id);

    const res = await makeRequest('PATCH', `/api/chat/conversations/${conv.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Should appear in default list again
    const listRes = await makeRequest('GET', '/api/chat/conversations');
    expect(listRes.body.conversations.find((c: any) => c.id === conv.id)).toBeDefined();
  });

  test('returns 404 for non-existent conversation', async () => {
    const res = await makeRequest('PATCH', '/api/chat/conversations/nope/restore');
    expect(res.status).toBe(404);
  });
});

// ── GET /conversations?archived=true ──────��─────────────────────────────────

describe('GET /conversations?archived=true', () => {
  test('returns only archived conversations', async () => {
    const c1 = await chatService.createConversation('Active');
    const c2 = await chatService.createConversation('Archived');
    await chatService.archiveConversation(c2.id);

    const activeRes = await makeRequest('GET', '/api/chat/conversations');
    expect(activeRes.body.conversations).toHaveLength(1);
    expect(activeRes.body.conversations[0].id).toBe(c1.id);

    const archivedRes = await makeRequest('GET', '/api/chat/conversations?archived=true');
    expect(archivedRes.body.conversations).toHaveLength(1);
    expect(archivedRes.body.conversations[0].id).toBe(c2.id);
  });
});

// ── DELETE /conversations/:id/upload/:filename ─────────────────────────────��──

describe('DELETE /conversations/:id/upload/:filename', () => {
  test('deletes an uploaded file', async () => {
    const conv = await chatService.createConversation('Test');
    const artifactDir = path.join(tmpDir, 'data', 'chat', 'artifacts', conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'test.txt'), 'hello');

    const res = await makeRequest('DELETE', `/api/chat/conversations/${conv.id}/upload/test.txt`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'test.txt'))).toBe(false);
  });

  test('returns 404 for non-existent file', async () => {
    const conv = await chatService.createConversation('Test');
    const res = await makeRequest('DELETE', `/api/chat/conversations/${conv.id}/upload/nope.txt`);
    expect(res.status).toBe(404);
  });

  test('sanitizes slashes in filename', async () => {
    const conv = await chatService.createConversation('Test');
    const artifactDir = path.join(tmpDir, 'data', 'chat', 'artifacts', conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'a_b.txt'), 'data');

    // Filename with slash gets sanitized to underscore, matching upload behavior
    const res = await makeRequest('DELETE', `/api/chat/conversations/${conv.id}/upload/a%2Fb.txt`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'a_b.txt'))).toBe(false);
  });
});

// ── GET /conversations/:id/files/:filename ──────────────────────────────────

describe('GET /conversations/:id/files/:filename', () => {
  test('serves an uploaded file', async () => {
    const conv = await chatService.createConversation('Test');
    const artifactDir = path.join(tmpDir, 'data', 'chat', 'artifacts', conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'photo.png'), 'fakeimage');

    const res = await makeRequest('GET', `/api/chat/conversations/${conv.id}/files/photo.png`);
    expect(res.status).toBe(200);
  });

  test('returns 404 for non-existent file', async () => {
    const conv = await chatService.createConversation('Test');
    const res = await makeRequest('GET', `/api/chat/conversations/${conv.id}/files/nope.png`);
    expect(res.status).toBe(404);
  });

  test('sanitizes slashes in filename', async () => {
    const conv = await chatService.createConversation('Test');
    const artifactDir = path.join(tmpDir, 'data', 'chat', 'artifacts', conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'a_b.png'), 'data');

    const res = await makeRequest('GET', `/api/chat/conversations/${conv.id}/files/a%2Fb.png`);
    expect(res.status).toBe(200);
  });
});

// ── POST /mkdir ─────────────────────────────────────────────────────────────

describe('POST /mkdir', () => {
  test('creates a folder and returns its path', async () => {
    const res = await makeRequest('POST', '/api/chat/mkdir', { parentPath: tmpDir, name: 'new-folder' });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(path.join(tmpDir, 'new-folder'));
    expect(fs.existsSync(path.join(tmpDir, 'new-folder'))).toBe(true);
  });

  test('returns 400 when parentPath is missing', async () => {
    const res = await makeRequest('POST', '/api/chat/mkdir', { name: 'test' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when name is missing', async () => {
    const res = await makeRequest('POST', '/api/chat/mkdir', { parentPath: tmpDir });
    expect(res.status).toBe(400);
  });

  test('rejects name containing slash', async () => {
    const res = await makeRequest('POST', '/api/chat/mkdir', { parentPath: tmpDir, name: 'a/b' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid folder name');
  });

  test('rejects name containing backslash', async () => {
    const res = await makeRequest('POST', '/api/chat/mkdir', { parentPath: tmpDir, name: 'a\\b' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid folder name');
  });

  test('rejects dot-dot traversal', async () => {
    const res = await makeRequest('POST', '/api/chat/mkdir', { parentPath: tmpDir, name: '..' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid folder name');
  });

  test('rejects single dot', async () => {
    const res = await makeRequest('POST', '/api/chat/mkdir', { parentPath: tmpDir, name: '.' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid folder name');
  });

  test('returns 409 when folder already exists', async () => {
    fs.mkdirSync(path.join(tmpDir, 'existing'));
    const res = await makeRequest('POST', '/api/chat/mkdir', { parentPath: tmpDir, name: 'existing' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Folder already exists');
  });

  test('returns 403 for read-only parent directory', async () => {
    const readonlyDir = path.join(tmpDir, 'readonly');
    fs.mkdirSync(readonlyDir);
    fs.chmodSync(readonlyDir, 0o444);
    const res = await makeRequest('POST', '/api/chat/mkdir', { parentPath: readonlyDir, name: 'nope' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Permission denied');
    // Restore permissions for cleanup
    fs.chmodSync(readonlyDir, 0o755);
  });
});

// ── GET /conversations/:id/sessions/:num/messages ──────────────────────────

describe('GET /conversations/:id/sessions/:num/messages', () => {
  test('returns current session messages', async () => {
    const conv = await chatService.createConversation('Test');
    await chatService.addMessage(conv.id, 'user', 'Hello', 'claude-code');
    await chatService.addMessage(conv.id, 'assistant', 'Hi', 'claude-code');

    const loaded = (await chatService.getConversation(conv.id))!;
    const res = await makeRequest('GET', `/api/chat/conversations/${conv.id}/sessions/${loaded.sessionNumber}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].content).toBe('Hello');
  });

  test('returns archived session messages', async () => {
    const conv = await chatService.createConversation('Test');
    await chatService.addMessage(conv.id, 'user', 'Old msg', 'claude-code');

    // Mock summary generation to avoid CLI calls
    (chatService as any)._generateSessionSummary = async (msgs: any, fallback: any) => fallback;
    await chatService.resetSession(conv.id);

    const res = await makeRequest('GET', `/api/chat/conversations/${conv.id}/sessions/1/messages`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].content).toBe('Old msg');
  });

  test('returns 404 for non-existent session', async () => {
    const conv = await chatService.createConversation('Test');
    const res = await makeRequest('GET', `/api/chat/conversations/${conv.id}/sessions/99/messages`);
    expect(res.status).toBe(404);
  });

  test('returns 400 for invalid session number', async () => {
    const conv = await chatService.createConversation('Test');
    const res = await makeRequest('GET', `/api/chat/conversations/${conv.id}/sessions/0/messages`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid session number');
  });
});

// ── POST /rmdir ─────────────────────────────────────────────────────────────

describe('POST /rmdir', () => {
  test('deletes a folder and returns parent path', async () => {
    const target = path.join(tmpDir, 'to-delete');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'file.txt'), 'data');
    const res = await makeRequest('POST', '/api/chat/rmdir', { dirPath: target });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(target);
    expect(res.body.parent).toBe(tmpDir);
    expect(fs.existsSync(target)).toBe(false);
  });

  test('recursively deletes nested contents', async () => {
    const target = path.join(tmpDir, 'nested');
    fs.mkdirSync(path.join(target, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(target, 'sub', 'deep', 'file.txt'), 'data');
    const res = await makeRequest('POST', '/api/chat/rmdir', { dirPath: target });
    expect(res.status).toBe(200);
    expect(fs.existsSync(target)).toBe(false);
  });

  test('returns 400 when dirPath is missing', async () => {
    const res = await makeRequest('POST', '/api/chat/rmdir', {});
    expect(res.status).toBe(400);
  });

  test('returns 400 when trying to delete filesystem root', async () => {
    const res = await makeRequest('POST', '/api/chat/rmdir', { dirPath: '/' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot delete filesystem root');
  });

  test('returns 404 when folder does not exist', async () => {
    const res = await makeRequest('POST', '/api/chat/rmdir', { dirPath: path.join(tmpDir, 'nonexistent') });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Folder does not exist');
  });

  test('returns 400 when path is a file not a directory', async () => {
    const filePath = path.join(tmpDir, 'afile.txt');
    fs.writeFileSync(filePath, 'data');
    const res = await makeRequest('POST', '/api/chat/rmdir', { dirPath: filePath });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Path is not a directory');
  });
});

// ── Workspace instructions API ─────────────────────────────────────────────

describe('GET /workspaces/:hash/instructions', () => {
  test('returns empty instructions for workspace with no instructions', async () => {
    const conv = await chatService.createConversation('Test', '/tmp/ws-api');
    const hash = chatService.getWorkspaceHashForConv(conv.id)!;
    const res = await makeRequest('GET', `/api/chat/workspaces/${hash}/instructions`);
    expect(res.status).toBe(200);
    expect(res.body.instructions).toBe('');
  });

  test('returns 404 for non-existent workspace', async () => {
    const res = await makeRequest('GET', '/api/chat/workspaces/nonexistent123/instructions');
    expect(res.status).toBe(404);
  });
});

describe('PUT /workspaces/:hash/instructions', () => {
  test('saves and returns instructions', async () => {
    const conv = await chatService.createConversation('Test', '/tmp/ws-put');
    const hash = chatService.getWorkspaceHashForConv(conv.id)!;

    const res = await makeRequest('PUT', `/api/chat/workspaces/${hash}/instructions`, {
      instructions: 'Always use TypeScript',
    });
    expect(res.status).toBe(200);
    expect(res.body.instructions).toBe('Always use TypeScript');

    // Verify persisted
    const getRes = await makeRequest('GET', `/api/chat/workspaces/${hash}/instructions`);
    expect(getRes.body.instructions).toBe('Always use TypeScript');
  });

  test('returns 400 when instructions is not a string', async () => {
    const conv = await chatService.createConversation('Test', '/tmp/ws-bad');
    const hash = chatService.getWorkspaceHashForConv(conv.id)!;

    const res = await makeRequest('PUT', `/api/chat/workspaces/${hash}/instructions`, {
      instructions: 123,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('instructions must be a string');
  });

  test('returns 404 for non-existent workspace', async () => {
    const res = await makeRequest('PUT', '/api/chat/workspaces/nonexistent123/instructions', {
      instructions: 'test',
    });
    expect(res.status).toBe(404);
  });
});

describe('Workspace instructions in system prompt', () => {
  test('combines global system prompt with workspace instructions on new session', async () => {
    await chatService.saveSettings({ theme: 'system', systemPrompt: 'Global prompt' } as any);

    const conv = await chatService.createConversation('Test', '/tmp/ws-combo');
    const hash = chatService.getWorkspaceHashForConv(conv.id)!;
    await chatService.setWorkspaceInstructions(hash, 'Workspace instructions');

    mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(mockBackend._lastOptions!.systemPrompt).toContain('Global prompt');
    expect(mockBackend._lastOptions!.systemPrompt).toContain('Workspace instructions');
  });

  test('sends only workspace instructions when no global prompt', async () => {
    const conv = await chatService.createConversation('Test', '/tmp/ws-only');
    const hash = chatService.getWorkspaceHashForConv(conv.id)!;
    await chatService.setWorkspaceInstructions(hash, 'Only workspace');

    mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(mockBackend._lastOptions!.systemPrompt).toBe('Only workspace');
  });

  test('does not include workspace instructions on subsequent messages', async () => {
    const conv = await chatService.createConversation('Test', '/tmp/ws-resume');
    const hash = chatService.getWorkspaceHashForConv(conv.id)!;
    await chatService.setWorkspaceInstructions(hash, 'Workspace instructions');
    await chatService.addMessage(conv.id, 'user', 'First msg', 'claude-code');

    mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Second msg',
      backend: 'claude-code',
    });

    expect(mockBackend._lastOptions!.systemPrompt).toBe('');
  });
});

// ── GET /api/chat/version ──────────────────────────────────────────────────

describe('GET /api/chat/version', () => {
  test('returns version from package.json', async () => {
    const expected = require('../package.json').version;
    const res = await makeRequest('GET', '/api/chat/version');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(expected);
    expect(res.body).toHaveProperty('remoteVersion');
    expect(res.body).toHaveProperty('updateAvailable');
  });
});

// ── Usage event forwarding ───────────────────────────────────────────────────

describe('Usage event forwarding', () => {
  test('forwards usage events via WebSocket and persists to conversation', async () => {
    const conv = await chatService.createConversation('Usage Test');

    mockBackend.setMockEvents([
      { type: 'text', content: 'Hello', streaming: true },
      { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50, costUsd: 0.05 } },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test usage',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    // Verify usage event was forwarded with both conversation and session usage
    const usageEvent = events.find((e: any) => e.type === 'usage');
    expect(usageEvent).toBeDefined();
    expect(usageEvent.usage.inputTokens).toBe(1000);
    expect(usageEvent.usage.outputTokens).toBe(500);
    expect(usageEvent.usage.costUsd).toBe(0.05);
    expect(usageEvent.sessionUsage).toBeDefined();
    expect(usageEvent.sessionUsage.inputTokens).toBe(1000);
    expect(usageEvent.sessionUsage.outputTokens).toBe(500);

    // Verify usage was persisted
    const loaded = (await chatService.getConversation(conv.id))!;
    expect(loaded.usage!.inputTokens).toBe(1000);
    expect(loaded.usage!.outputTokens).toBe(500);
    expect(loaded.usage!.costUsd).toBe(0.05);
    expect(loaded.sessionUsage!.inputTokens).toBe(1000);
  });

  test('accumulates usage across multiple usage events', async () => {
    const conv = await chatService.createConversation('Multi Usage');

    mockBackend.setMockEvents([
      { type: 'text', content: 'First turn', streaming: true },
      { type: 'usage', usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 } },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Second turn', streaming: true },
      { type: 'usage', usage: { inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 } },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'multi turn',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const usageEvents = events.filter((e: any) => e.type === 'usage');
    expect(usageEvents).toHaveLength(2);

    // Second event should show cumulative totals
    expect(usageEvents[1].usage.inputTokens).toBe(800);
    expect(usageEvents[1].usage.outputTokens).toBe(300);
    expect(usageEvents[1].usage.costUsd).toBeCloseTo(0.03);
  });

  test('getConversation includes usage and sessionUsage in response', async () => {
    const conv = await chatService.createConversation('API Usage');
    await chatService.addUsage(conv.id, { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 200, costUsd: 0.10 });

    const res = await makeRequest('GET', `/api/chat/conversations/${conv.id}`);
    expect(res.status).toBe(200);
    expect(res.body.usage).toBeDefined();
    expect(res.body.usage.inputTokens).toBe(2000);
    expect(res.body.usage.outputTokens).toBe(1000);
    expect(res.body.usage.costUsd).toBe(0.10);
    expect(res.body.sessionUsage).toBeDefined();
    expect(res.body.sessionUsage.inputTokens).toBe(2000);
  });
});

// ── Usage stats endpoints ───────────────────────────────────────────────────

describe('Usage stats endpoints', () => {
  test('GET /usage-stats returns empty ledger initially', async () => {
    const res = await makeRequest('GET', '/api/chat/usage-stats');
    expect(res.status).toBe(200);
    expect(res.body.days).toEqual([]);
  });

  test('GET /usage-stats returns ledger data after usage', async () => {
    const conv = await chatService.createConversation('Stats Test');
    await chatService.addUsage(conv.id, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05 }, 'claude-code', 'claude-sonnet-4');
    // Wait for fire-and-forget ledger write
    await new Promise(resolve => setTimeout(resolve, 100));

    const res = await makeRequest('GET', '/api/chat/usage-stats');
    expect(res.status).toBe(200);
    expect(res.body.days.length).toBeGreaterThan(0);
    const today = new Date().toISOString().slice(0, 10);
    const day = res.body.days.find((d: any) => d.date === today);
    expect(day).toBeDefined();
    const record = day.records.find((r: any) => r.backend === 'claude-code');
    expect(record).toBeDefined();
    expect(record.usage.inputTokens).toBe(1000);
    expect(record.model).toBe('claude-sonnet-4');
  });

  test('DELETE /usage-stats clears all stats', async () => {
    const conv = await chatService.createConversation('Clear Stats');
    await chatService.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }, 'claude-code');
    await new Promise(resolve => setTimeout(resolve, 100));

    const delRes = await makeRequest('DELETE', '/api/chat/usage-stats');
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    const res = await makeRequest('GET', '/api/chat/usage-stats');
    expect(res.body.days).toEqual([]);
  });
});

// ── WebSocket streaming ─────────────────────────────────────────────────────

describe('WebSocket streaming', () => {
  test('receives text and done events via WebSocket', async () => {
    const conv = await chatService.createConversation('WS Test');

    mockBackend.setMockEvents([
      { type: 'text', content: 'Hello from WS', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    // Connect WS first, then POST message
    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
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
    const conv = await chatService.createConversation('WS Tools');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Read', description: 'Reading file', id: 'tool_ws_1' },
      { type: 'tool_outcomes', outcomes: [{ toolUseId: 'tool_ws_1', isError: false, outcome: 'read', status: 'success' }] },
      { type: 'text', content: 'Done', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
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
    const conv = await chatService.createConversation('WS Input');

    // Use a blocking generator so the stream stays alive until we signal
    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    const origSendMessage = mockBackend.sendMessage.bind(mockBackend);
    mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
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

    const ws = await connectWs(conv.id);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test input',
      backend: 'claude-code',
    });

    // Wait for stream to start processing
    await new Promise(resolve => setTimeout(resolve, 100));

    // Send input via WS
    ws.send(JSON.stringify({ type: 'input', text: 'yes' }));

    // Wait for the input to be processed
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockBackend._sendInputCalls).toContain('yes');

    // Unblock to clean up
    unblock!();
    await new Promise(resolve => setTimeout(resolve, 50));
    ws.close();
  });

  test('sends abort via WebSocket', async () => {
    const conv = await chatService.createConversation('WS Abort');

    // Use a blocking generator so the stream stays alive
    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    let aborted = false;
    mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
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

    const ws = await connectWs(conv.id);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test abort',
      backend: 'claude-code',
    });

    // Wait for stream to start
    await new Promise(resolve => setTimeout(resolve, 100));

    // Abort via WS
    ws.send(JSON.stringify({ type: 'abort' }));

    // Wait for abort to be processed
    await new Promise(resolve => setTimeout(resolve, 100));

    // activeStreams should be cleared after abort
    expect(activeStreams.has(conv.id)).toBe(false);
    expect(aborted).toBe(true);
    ws.close();
  });

  test('rejects WebSocket for invalid conversation path', async () => {
    const port = (server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/chat/invalid-path`);
    await new Promise<void>((resolve) => {
      ws.on('error', () => resolve());
      ws.on('close', () => resolve());
    });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });

  test('receives assistant_message via WebSocket', async () => {
    const conv = await chatService.createConversation('WS Msg Save');

    mockBackend.setMockEvents([
      { type: 'text', content: 'Saved response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await connectWs(conv.id);
    const eventsPromise = readWsEvents(ws);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
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
    const conv = await chatService.createConversation('WS Reconnect');

    // Use a blocking generator so stream stays alive across disconnect/reconnect
    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
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
    const ws1 = await connectWs(conv.id);
    const events1: any[] = [];
    const gotChunk2 = new Promise<void>((resolve) => {
      ws1.on('message', (data) => {
        const event = JSON.parse(data.toString());
        events1.push(event);
        if (event.type === 'text' && event.content === 'chunk2') resolve();
      });
    });

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test reconnect',
      backend: 'claude-code',
    });

    await gotChunk2;
    expect(events1.filter(e => e.type === 'text')).toHaveLength(2);

    // Disconnect WS (simulate network drop)
    ws1.close();
    await new Promise(resolve => setTimeout(resolve, 100));

    // CLI should still be alive (grace period)
    expect(activeStreams.has(conv.id)).toBe(true);

    // Reconnect — set up message listener BEFORE open so we don't miss replay
    const port = (server.address() as any).port;
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
    const conv = await chatService.createConversation('WS Grace');

    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
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

    const ws = await connectWs(conv.id);
    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test grace',
      backend: 'claude-code',
    });

    // Wait for stream to start
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(activeStreams.has(conv.id)).toBe(true);

    // Disconnect — stream should survive
    ws.close();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(activeStreams.has(conv.id)).toBe(true);

    // Cleanup
    unblock!();
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  test('CLI crash during disconnect buffers error for replay', async () => {
    const conv = await chatService.createConversation('WS Crash');

    let triggerError: () => void;
    const errorPromise = new Promise<void>(r => { triggerError = r; });
    mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
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

    const ws1 = await connectWs(conv.id);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
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
    const port = (server.address() as any).port;
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
    const conv = await chatService.createConversation('WS Abort Buffer');

    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    let aborted = false;
    mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
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

    const ws = await connectWs(conv.id);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test abort buffer',
      backend: 'claude-code',
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    // Abort via WS — should clear buffer and stream
    ws.send(JSON.stringify({ type: 'abort' }));
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(aborted).toBe(true);
    expect(activeStreams.has(conv.id)).toBe(false);

    ws.close();
  });

  test('session reset clears stale event buffer', async () => {
    const conv = await chatService.createConversation('WS Reset Buffer');

    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    mockBackend.sendMessage = function(msg: string, opts?: SendMessageOptions) {
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
    const ws1 = await connectWs(conv.id);
    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'old session message',
      backend: 'claude-code',
    });
    const events1 = await readWsEvents(ws1);
    expect(events1.some(e => e.type === 'done')).toBe(true);

    // Disconnect — buffer still exists on server
    await new Promise(resolve => setTimeout(resolve, 100));

    // Reset session — should clear the buffer
    const resetRes = await makeRequest('POST', `/api/chat/conversations/${conv.id}/reset`);
    expect(resetRes.status).toBe(200);

    // Reconnect after reset — should NOT replay old events
    const ws2 = await connectWs(conv.id);
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
