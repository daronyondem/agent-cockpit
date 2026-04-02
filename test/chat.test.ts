import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ChatService } from '../src/services/chatService';
import { createChatRouter } from '../src/routes/chat';
import { BaseBackendAdapter } from '../src/services/backends/base';
import { BackendRegistry } from '../src/services/backends/registry';
import type { BackendMetadata, SendMessageOptions, SendMessageResult, StreamEvent, Message } from '../src/types';

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
      path: url.pathname,
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

function readSSE(urlPath: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        const events = data.split('\n')
          .filter(line => line.startsWith('data: '))
          .map(line => {
            try { return JSON.parse(line.slice(6)); } catch { return null; }
          })
          .filter(Boolean);
        resolve(events);
      });
    }).on('error', reject);
  });
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

let mockBackend: MockBackendAdapter;
let backendRegistry: BackendRegistry;

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

  const { router } = createChatRouter({ chatService, backendRegistry, updateService: null as any });
  app.use('/api/chat', router);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const port = (server.address() as any).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterEach((done) => {
  server.close(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    done();
  });
});

// ── POST /conversations/:id/input ───────────────────────────────────────────

describe('POST /conversations/:id/input', () => {
  test('returns ok:false when no active stream', async () => {
    const conv = await chatService.createConversation('Test');
    const res = await makeRequest('POST', `/api/chat/conversations/${conv.id}/input`, { text: 'yes' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toBe('No active stream');
  });

  test('forwards text to sendInput and returns ok:true', async () => {
    const conv = await chatService.createConversation('Test');

    // Start a stream by sending a message
    mockBackend.setMockEvents([
      { type: 'text', content: 'hello', streaming: true },
      // Don't include 'done' — keep stream "alive" so activeStreams entry persists
    ] as StreamEvent[]);

    // Send message to populate activeStreams
    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test message',
      backend: 'claude-code',
    });

    // Now send input
    const res = await makeRequest('POST', `/api/chat/conversations/${conv.id}/input`, { text: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify sendInput was called
    expect(mockBackend._sendInputCalls).toContain('approved');
  });

  test('handles empty text gracefully', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'text', content: 'hi', streaming: true },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'hello',
      backend: 'claude-code',
    });

    const res = await makeRequest('POST', `/api/chat/conversations/${conv.id}/input`, { text: '' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockBackend._sendInputCalls).toContain('');
  });

  test('requires CSRF token', async () => {
    const conv = await chatService.createConversation('Test');

    const url = new URL(`/api/chat/conversations/${conv.id}/input`, baseUrl);
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { 'Content-Type': 'application/json' }, // No CSRF token
      }, (r) => {
        let data = '';
        r.on('data', (chunk: Buffer) => { data += chunk; });
        r.on('end', () => resolve({ status: r.statusCode!, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.write(JSON.stringify({ text: 'yes' }));
      req.end();
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Invalid CSRF token');
  });
});

// ── SSE tool_activity forwarding ────────────────────────────────────────────

describe('SSE tool_activity forwarding', () => {
  test('forwards enriched tool_activity fields via SSE', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Read', description: 'Reading `app.js`', id: 'tool_1' },
      { type: 'text', content: 'Result', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    const toolEvent = events.find((e: any) => e.type === 'tool_activity');
    expect(toolEvent).toBeDefined();
    expect(toolEvent.tool).toBe('Read');
    expect(toolEvent.description).toBe('Reading `app.js`');
    expect(toolEvent.id).toBe('tool_1');
  });

  test('forwards isAgent flag via SSE', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Agent', description: 'Explore code', isAgent: true, subagentType: 'Explore' },
      { type: 'text', content: 'Done', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'explore',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    const agentEvent = events.find((e: any) => e.type === 'tool_activity');
    expect(agentEvent).toBeDefined();
    expect(agentEvent.isAgent).toBe(true);
    expect(agentEvent.subagentType).toBe('Explore');
  });

  test('forwards isPlanMode and planAction via SSE', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'EnterPlanMode', isPlanMode: true, planAction: 'enter', description: 'Entering plan mode' },
      { type: 'tool_activity', tool: 'ExitPlanMode', isPlanMode: true, planAction: 'exit', description: 'Plan ready for approval' },
      { type: 'text', content: 'Plan done', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'plan',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    const planEvents = events.filter((e: any) => e.type === 'tool_activity' && e.isPlanMode);
    expect(planEvents).toHaveLength(2);
    expect(planEvents[0].planAction).toBe('enter');
    expect(planEvents[1].planAction).toBe('exit');
  });

  test('forwards isQuestion flag and questions via SSE', async () => {
    const conv = await chatService.createConversation('Test');
    const questions = [{ question: 'Which approach?', options: [{ label: 'A' }] }];

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'AskUserQuestion', isQuestion: true, questions, description: 'Asking a question' },
      { type: 'text', content: 'Ok', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'question',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    const loaded = (await chatService.getConversation(conv.id))!;
    const assistantMsgs = loaded.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs[0].toolActivity).toBeDefined();
    expect(assistantMsgs[0].toolActivity![0].isAgent).toBe(true);
    expect(assistantMsgs[0].toolActivity![0].subagentType).toBe('Explore');
  });

  test('forwards tool_outcomes SSE event to client', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'tool_activity', tool: 'Grep', description: 'Searching', id: 'tool_1' },
      { type: 'tool_outcomes', outcomes: [{ toolUseId: 'tool_1', outcome: '5 matches', status: 'success' }] },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Found it', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test', backend: 'claude-code',
    });
    await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test', backend: 'claude-code',
    });
    await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'New topic question',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello world',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'New session question',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

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

// ── DELETE /conversations/:id/upload/:filename ────────────────────────────────

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

// ── POST /conversations/:id/abort ───────────────────────────────────────────

describe('POST /conversations/:id/abort', () => {
  test('returns ok:false when no active stream', async () => {
    const conv = await chatService.createConversation('Test');
    const res = await makeRequest('POST', `/api/chat/conversations/${conv.id}/abort`, {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
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

describe('SSE usage event forwarding', () => {
  test('forwards usage events via SSE and persists to conversation', async () => {
    const conv = await chatService.createConversation('Usage Test');

    mockBackend.setMockEvents([
      { type: 'text', content: 'Hello', streaming: true },
      { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50, costUsd: 0.05 } },
      { type: 'done' },
    ] as StreamEvent[]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test usage',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    // Verify usage event was forwarded
    const usageEvent = events.find((e: any) => e.type === 'usage');
    expect(usageEvent).toBeDefined();
    expect(usageEvent.usage.inputTokens).toBe(1000);
    expect(usageEvent.usage.outputTokens).toBe(500);
    expect(usageEvent.usage.costUsd).toBe(0.05);

    // Verify usage was persisted
    const loaded = (await chatService.getConversation(conv.id))!;
    expect(loaded.usage!.inputTokens).toBe(1000);
    expect(loaded.usage!.outputTokens).toBe(500);
    expect(loaded.usage!.costUsd).toBe(0.05);
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

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'multi turn',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    const usageEvents = events.filter((e: any) => e.type === 'usage');
    expect(usageEvents).toHaveLength(2);

    // Second event should show cumulative totals
    expect(usageEvents[1].usage.inputTokens).toBe(800);
    expect(usageEvents[1].usage.outputTokens).toBe(300);
    expect(usageEvents[1].usage.costUsd).toBeCloseTo(0.03);
  });

  test('getConversation includes usage in response', async () => {
    const conv = await chatService.createConversation('API Usage');
    await chatService.addUsage(conv.id, { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 200, costUsd: 0.10 });

    const res = await makeRequest('GET', `/api/chat/conversations/${conv.id}`);
    expect(res.status).toBe(200);
    expect(res.body.usage).toBeDefined();
    expect(res.body.usage.inputTokens).toBe(2000);
    expect(res.body.usage.outputTokens).toBe(1000);
    expect(res.body.usage.costUsd).toBe(0.10);
  });
});
