const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ChatService } = require('../src/services/chatService');
const { createChatRouter } = require('../src/routes/chat');

// ── Test helpers ────────────────────────────────────────────────────────────

let tmpDir, chatService, app, server, baseUrl;
const CSRF_TOKEN = 'test-csrf-token';

function createMockCLIBackend() {
  return {
    workingDir: '/tmp',
    _lastMessage: null,
    _lastOptions: null,
    _mockEvents: [],
    _sendInputCalls: [],

    setMockEvents(events) {
      this._mockEvents = events;
    },

    sendMessage(message, options) {
      this._lastMessage = message;
      this._lastOptions = options;
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
        sendInput: (text) => { self._sendInputCalls.push(text); },
      };
    },
  };
}

function makeRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const options = {
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
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function readSSE(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
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

let mockBackend;

beforeEach((done) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroute-'));
  chatService = new ChatService(tmpDir);
  mockBackend = createMockCLIBackend();

  app = express();
  app.use(express.json());

  // Mock session middleware
  app.use((req, _res, next) => {
    req.session = { csrfToken: CSRF_TOKEN };
    next();
  });

  const { router } = createChatRouter({ chatService, cliBackend: mockBackend });
  app.use('/api/chat', router);

  server = app.listen(0, () => {
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
    done();
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
    ]);

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
    ]);

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
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { 'Content-Type': 'application/json' }, // No CSRF token
      }, (r) => {
        let data = '';
        r.on('data', (chunk) => { data += chunk; });
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
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
    ]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    const toolEvent = events.find(e => e.type === 'tool_activity');
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
    ]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'explore',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    const agentEvent = events.find(e => e.type === 'tool_activity');
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
    ]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'plan',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    const planEvents = events.filter(e => e.type === 'tool_activity' && e.isPlanMode);
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
    ]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'question',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    const questionEvent = events.find(e => e.type === 'tool_activity' && e.isQuestion);
    expect(questionEvent).toBeDefined();
    expect(questionEvent.questions).toEqual(questions);
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
    ]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    // Should have two assistant_message events (one intermediate, one final)
    const assistantMessages = events.filter(e => e.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0].message.content).toBe('First response');
    expect(assistantMessages[1].message.content).toBe('Second response');

    // Verify persisted to disk
    const loaded = await chatService.getConversation(conv.id);
    const assistantMsgs = loaded.messages.filter(m => m.role === 'assistant');
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
    ]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    const assistantMessages = events.filter(e => e.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(2);

    // First message should have thinking
    expect(assistantMessages[0].message.thinking).toBe('Let me think...');
    expect(assistantMessages[0].message.content).toBe('Response with thinking');

    // Verify persisted
    const loaded = await chatService.getConversation(conv.id);
    const firstAssistant = loaded.messages.find(m => m.role === 'assistant');
    expect(firstAssistant.thinking).toBe('Let me think...');
  });

  test('does not save intermediate message when no streaming content', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'turn_boundary' }, // boundary with no preceding text
      { type: 'text', content: 'Final', streaming: true },
      { type: 'done' },
    ]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    const assistantMessages = events.filter(e => e.type === 'assistant_message');
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
    ]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    const assistantMessages = events.filter(e => e.type === 'assistant_message');
    // Only the final "New content" should be saved (replayed text is not streaming)
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].message.content).toBe('New content');
  });

  test('saves result text as final message when no streaming deltas', async () => {
    const conv = await chatService.createConversation('Test');

    mockBackend.setMockEvents([
      { type: 'result', content: 'The final result' },
      { type: 'done' },
    ]);

    await makeRequest('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test',
      backend: 'claude-code',
    });

    const events = await readSSE(`/api/chat/conversations/${conv.id}/stream`);

    const assistantMessages = events.filter(e => e.type === 'assistant_message');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].message.content).toBe('The final result');
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

// ── POST /conversations/:id/abort ───────────────────────────────────────────

describe('POST /conversations/:id/abort', () => {
  test('returns ok:false when no active stream', async () => {
    const conv = await chatService.createConversation('Test');
    const res = await makeRequest('POST', `/api/chat/conversations/${conv.id}/abort`, {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  });
});
