import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { GrokBuildAdapter } from '../src/services/backends/grok';
import { GrokAcpClient, GrokRpcError, type GrokRecord, type GrokRpcMessage } from '../src/services/backends/grokProtocol';
import { startGrokRuntime, resolveGrokCliRuntime } from '../src/services/backends/grokRuntime';
import { normalizeGrokBilling } from '../src/services/backends/grokBilling';
import { BackendRegistry } from '../src/services/backends/registry';
import type { SendMessageOptions, StreamEvent } from '../src/types';

jest.mock('../src/services/backends/grokRuntime', () => ({
  ...jest.requireActual('../src/services/backends/grokRuntime'), startGrokRuntime: jest.fn(),
}));

const usage = { inputTokens: 100, cachedReadTokens: 30, outputTokens: 20, costUsdTicks: 10000000, modelUsage: { 'grok-4.7-build': {} } };
const native = new Map<string, { text: string; goal: GrokRecord | null }>();
// Holds session attachment open so tests can interleave callers deterministically.
let attachGate: Promise<void> | null = null;
const evicted = new Set<string>();
class Peer {
  toolDefinitionsCount = 0;
  private rejectClosed!: (error: Error) => void;
  closed = new Promise<never>((_resolve, reject) => { this.rejectClosed = reject; });
  resident: GrokRecord = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, modelCalls: 0, costUsdTicks: 0 };
  isClosed = false;
  process = { pid: 123 };
  listeners = new Set<(message: GrokRpcMessage) => void>();
  calls: { method: string; params: GrokRecord }[] = [];
  responses: { id: string | number; result: unknown }[] = [];
  waiting: { id: number; sid: string; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  subscribe(fn: (message: GrokRpcMessage) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  constructor() { void this.closed.catch(() => {}); }
  emit(sid: string, update: GrokRecord, method = 'session/update') { if (!this.isClosed) for (const fn of this.listeners) fn({ method, params: { sessionId: sid, update } }); }
  text(sid: string, text: string) { this.emit(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }); }
  close() { this.isClosed = true; this.rejectClosed(new Error('ACP process exited')); this.waiting?.reject(new Error('ACP process exited')); this.waiting = null; }
  reject() { this.close(); }
  respond(id: string | number, result: unknown) {
    this.responses.push({ id, result });
    if (this.waiting) { this.text(this.waiting.sid, JSON.stringify(result)); this.waiting.resolve({ stopReason: 'end_turn', _meta: { usage } }); this.waiting = null; }
  }
  notify(method: string, params: GrokRecord) {
    this.calls.push({ method, params });
    if (method === 'session/cancel' && this.waiting) {
      const goal = native.get(this.waiting.sid)?.goal;
      if (goal) { goal.status = 'user_paused'; this.emit(this.waiting.sid, { sessionUpdate: 'goal_updated', ...goal }); }
      this.waiting.resolve({ stopReason: 'cancelled', _meta: { usage } }); this.waiting = null;
    }
  }
  async request(method: string, params: GrokRecord = {}): Promise<unknown> {
    if (this.isClosed) throw new Error('ACP process exited');
    this.calls.push({ method, params });
    const sid = String(params.sessionId || '');
    if (method === 'session/new') { const id = `native-${native.size + 1}`; native.set(id, { text: '', goal: null }); return { sessionId: id }; }
    if (method === 'session/resume' || method === 'session/load') {
      if (attachGate) await attachGate;
      if (sid.startsWith('missing') || evicted.has(sid)) throw new GrokRpcError('Path not found.', -32603, { code: 'FS_NOT_FOUND' });
      if (sid === 'auth-error') throw new GrokRpcError('Authentication required', -32000);
      this.text(sid, 'REPLAY_MUST_NOT_APPEAR'); return {};
    }
    if (method === '_x.ai/session/info') return { result: { context: { usagePct: 6, toolDefinitionsCount: this.toolDefinitionsCount } } };
    if (method === '_x.ai/session/state') {
      if (typeof params.cwd !== 'string') throw new GrokRpcError('Invalid params: cwd is required', -32602);
      return { goal: native.get(sid)?.goal };
    }
    if (method === '_x.ai/session/usage') return { usage: JSON.parse(JSON.stringify(this.resident)) };
    if (method !== 'session/prompt') return {};
    const prompt = (params.prompt as GrokRecord[]).map(block => block.text || '').join('');
    const record = native.get(sid)!;
    if (prompt === 'prompt-error') throw new Error('Native prompt failed');
    if (prompt === 'background') {
      this.emit(sid, { sessionUpdate: 'subagent_spawned', parent_session_id: sid, child_session_id: 'background-child', subagent_id: 'native-background-task', description: 'Background task' });
      this.text(sid, 'STARTED');
      this.emit(sid, { sessionUpdate: 'turn_completed', usage });
      setTimeout(() => {
        if (this.isClosed) return;
        this.emit('background-child', { sessionUpdate: 'tool_call', toolCallId: 'background-read', title: 'read_file' });
        this.text('background-child', 'CHILD_ONLY');
        this.emit(sid, { sessionUpdate: 'subagent_finished', child_session_id: 'background-child', status: 'completed', will_wake: true, output: 'CHILD_ONLY' });
        this.text(sid, 'BACKGROUND_FINAL');
        this.resident = { inputTokens: 240, outputTokens: 50, cachedReadTokens: 70, modelCalls: 3, costUsdTicks: 25000000,
          modelUsage: { 'grok-4.7-build': { inputTokens: 240, outputTokens: 50, cachedReadTokens: 70, modelCalls: 3, costUsdTicks: 25000000 } } };
        this.emit(sid, { sessionUpdate: 'turn_completed', usage: this.resident });
      }, 20);
      return { stopReason: 'end_turn', _meta: { usage: { ...usage, usageIsIncomplete: true } } };
    }
    if (prompt === '/goal clear') { record.goal = null; return { stopReason: 'end_turn' }; }
    if (prompt === '/goal pause') { if (record.goal) record.goal.status = 'user_paused'; return { stopReason: 'end_turn' }; }
    if (prompt.startsWith('/goal ') && prompt !== '/goal resume') {
      record.goal = { objective: prompt.slice(6), status: 'active', tokens_used: 3 };
      const pending = new Promise((resolve, reject) => { this.waiting = { id: 0, sid, resolve, reject }; });
      this.emit(sid, { sessionUpdate: 'goal_updated', ...record.goal }); return pending;
    }
    if (prompt === '/goal resume') { record.goal!.status = 'complete'; this.emit(sid, { sessionUpdate: 'goal_updated', ...record.goal }); }
    if (prompt === 'question' || prompt === 'plan') {
      const pending = new Promise((resolve, reject) => { this.waiting = { id: 0, sid, resolve, reject }; });
      for (const listener of this.listeners) listener({ id: 0, method: prompt === 'question' ? '_x.ai/ask_user_question' : '_x.ai/exit_plan_mode',
        params: { sessionId: sid, toolCallId: 'interactive', planContent: '# Plan', questions: [{ question: 'Color?', options: [{ label: 'Blue' }] }] } });
      return pending;
    }
    if (prompt === 'children') {
      this.emit(sid, { sessionUpdate: 'subagent_spawned', parent_session_id: sid, child_session_id: 'child', description: 'Inspect file' }, '_x.ai/session_notification');
      this.text('child', 'CHILD_TEXT');
      this.emit('child', { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read_file' });
      this.emit('child', { sessionUpdate: 'turn_completed', usage: { inputTokens: 999 } });
      this.emit(sid, { sessionUpdate: 'subagent_finished', child_session_id: 'child', status: 'completed', output: 'CHILD_TEXT' }, '_x.ai/session_notification');
    }
    const userText = prompt.replace(/^Complete this request with a text response only:\n\n/, '');
    if (userText === 'recall') this.text(sid, record.text);
    else { record.text = userText; this.text(sid, userText === 'children' ? 'ROOT_FINAL' : userText); }
    this.emit(sid, { sessionUpdate: 'turn_completed', usage });
    if (userText === 'evict-after') { evicted.add(sid); this.close(); }
    return { stopReason: 'end_turn', _meta: { usage } };
  }
}

describe('Grok Build adapter', () => {
  let cwd: string;
  let adapter: GrokBuildAdapter;
  let peers: Peer[];
  let options: SendMessageOptions;
  beforeEach(async () => {
    native.clear(); peers = []; attachGate = null; evicted.clear();
    cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'cockpit-grok-test-'));
    adapter = new GrokBuildAdapter({ workingDir: cwd });
    options = { sessionId: 'cockpit-session', conversationId: 'conversation', isNewSession: true, workingDir: cwd, systemPrompt: '' };
    jest.mocked(startGrokRuntime).mockImplementation(async (_profile, _cwd, onClient) => {
      const peer = new Peer(); peers.push(peer); onClient?.(peer as unknown as GrokAcpClient);
      return { client: peer as unknown as GrokAcpClient, init: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }, sessionId: null, busy: null, cancel: null };
    });
  });
  afterEach(async () => { adapter.shutdown(); await fsp.rm(cwd, { recursive: true, force: true }); });
  async function collect(message: string, input?: string) {
    const result = adapter.sendMessage(message, options);
    const events: StreamEvent[] = [];
    for await (const event of result.stream) {
      events.push(event);
      if (event.type === 'tool_activity' && (event.isQuestion || event.planAction === 'exit') && input) result.sendInput(input);
    }
    return events;
  }

  test('streams only root text, grouped children, and exactly one aggregate usage event', async () => {
    const events = await collect('children');
    expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', content: 'ROOT_FINAL', streaming: true }]);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_activity', parentAgentId: 'child' })]));
    expect(events.filter(event => event.type === 'usage')).toEqual([expect.objectContaining({ model: 'grok-4.7-build', usage: expect.objectContaining({ inputTokens: 70, contextUsagePercentage: 6 }) })]);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  test('drains background child activity and parent continuation before reporting settled usage', async () => {
    const events = await collect('background');
    expect(events.filter(event => event.type === 'text').map(event => event.content)).toEqual(['STARTED', 'BACKGROUND_FINAL']);
    const boundary = events.findIndex(event => event.type === 'turn_boundary');
    expect(boundary).toBeGreaterThan(events.findIndex(event => event.type === 'text' && event.content === 'STARTED'));
    expect(boundary).toBeLessThan(events.findIndex(event => event.type === 'text' && event.content === 'BACKGROUND_FINAL'));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_activity', parentAgentId: 'background-child' })]));
    expect(events.filter(event => event.type === 'usage')).toEqual([expect.objectContaining({ usage: expect.objectContaining({ inputTokens: 170, cacheReadTokens: 70, outputTokens: 50, costUsd: 0.0025 }) })]);
    expect(events.find(event => event.type === 'result')).toMatchObject({ content: 'BACKGROUND_FINAL' });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  test('retains reverse request ID zero for questions and plan approval', async () => {
    await collect('question', 'Blue');
    expect(peers[0].responses).toContainEqual({ id: 0, result: { outcome: 'accepted', answers: { 'Color?': ['Blue'] } } });
    await collect('plan', 'yes');
    expect(peers[0].responses).toContainEqual({ id: 0, result: { outcome: 'approved' } });
  });

  test('cancels children using native subagent IDs rather than their session IDs', async () => {
    const result = adapter.sendMessage('background', options);
    for await (const event of result.stream) if (event.type === 'tool_activity' && event.isAgent) result.abort();
    expect(peers[0].calls).toContainEqual({ method: '_x.ai/subagent/cancel', params: { subagentId: 'native-background-task' } });
  });

  test('a terminal prompt failure discards its runtime before the next turn', async () => {
    const events = await collect('prompt-error');
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: 'Native prompt failed' }));
    expect(peers[0].isClosed).toBe(true);
    await collect('next turn');
    expect(peers).toHaveLength(2);
  });

  test('rejecting an overlapping turn leaves the active native goal alive', async () => {
    const first = adapter.setGoalObjective('fixture', options);
    const reading = (async () => { for await (const _event of first.stream) { /* drain */ } })();
    for (let i = 0; i < 100 && !peers[0]?.waiting; i++) await new Promise(resolve => setTimeout(resolve, 1));
    const rejected = await collect('overlap');
    expect(rejected).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('active turn') }));
    expect(peers[0].isClosed).toBe(false);
    first.abort();
    await reading;
  });

  test('native sequential one-shots reuse one process and enforce the no-tool profile', async () => {
    const output = await adapter.runSessionShot(['remember', 'recall'], { workingDir: cwd, allowTools: false, mcpServers: [{ name: 'forbidden', command: 'node', args: [] }] });
    expect(output).toEqual(['remember', 'remember']);
    expect(peers).toHaveLength(1);
    expect(peers[0].calls.find(call => call.method === 'session/new')?.params).toMatchObject({ mcpServers: [], _meta: { agentProfile: { injectDefaultTools: false, disallowedTools: ['read_file'] } } });
    expect(peers[0].isClosed).toBe(true);
  });

  test('media calls fail closed for unverified models and image formats before inference', async () => {
    const pdf = { kind: 'pdf' as const, path: path.join(cwd, 'fixture.pdf') };
    await expect(adapter.runOneShot('Read the document', { workingDir: cwd, allowTools: true, model: 'grok-4.3', attachments: [pdf] })).rejects.toThrow('not been verified');
    const svg = { kind: 'image' as const, path: path.join(cwd, 'fixture.svg'), mimeType: 'image/svg+xml' };
    await expect(adapter.runOneShot('Read the image', { workingDir: cwd, model: 'grok-4.7', attachments: [svg] })).rejects.toThrow('image/svg+xml');
    expect(peers.every(peer => !peer.calls.some(call => call.method === 'session/prompt'))).toBe(true);
    expect(peers.every(peer => peer.isClosed)).toBe(true);
  });

  test('transports verified images explicitly and PDF paths through tool-enabled prompts', async () => {
    const filename = path.join(cwd, 'fixture.png');
    await fsp.writeFile(filename, Buffer.from([1, 2, 3]));
    await adapter.runOneShot('Read the image', { workingDir: cwd, model: 'grok-4.7', attachments: [{ kind: 'image', path: filename }] });
    expect(peers[0].calls.find(call => call.method === 'session/prompt')?.params.prompt).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'AQID' });
    const pdf = path.join(cwd, 'fixture.pdf');
    await adapter.runOneShot('Read the document', { workingDir: cwd, allowTools: true, model: 'grok-4.7', attachments: [{ kind: 'pdf', path: pdf }] });
    expect(peers[1].calls.find(call => call.method === 'session/prompt')?.params.prompt).toContainEqual({ type: 'text', text: `Read the attached PDF with your native file tool: ${pdf}` });
  });

  test('restricted calls fail before inference when native tool definitions are present', async () => {
    jest.mocked(startGrokRuntime).mockImplementationOnce(async (_profile, _cwd, onClient) => {
      const peer = new Peer(); peer.toolDefinitionsCount = 25; peers.push(peer);
      onClient?.(peer as unknown as GrokAcpClient);
      return { client: peer as unknown as GrokAcpClient, init: {}, sessionId: null, busy: null, cancel: null };
    });
    await expect(adapter.runOneShot('private governance input', { workingDir: cwd })).rejects.toThrow('tool-free session');
    expect(peers[0].calls.some(call => call.method === 'session/prompt')).toBe(false);
    expect(peers[0].isClosed).toBe(true);
  });

  test('restricted prompts cannot invoke native goal slash commands', async () => {
    expect(await adapter.runOneShot('/goal create a file', { workingDir: cwd })).toBe('/goal create a file');
    expect([...native.values()].every(session => session.goal === null)).toBe(true);
    const prompt = peers[0].calls.find(call => call.method === 'session/prompt')!.params.prompt as GrokRecord[];
    expect(String(prompt[0].text).startsWith('/')).toBe(false);
  });

  test('caller timeout includes stalled runtime startup', async () => {
    jest.mocked(startGrokRuntime).mockImplementationOnce(() => new Promise(() => {}));
    await expect(adapter.runOneShot('fixture', { workingDir: cwd, timeoutMs: 10 })).rejects.toThrow('timed out');
  });

  test('caller cancellation rejects an unfinished one-shot instead of accepting partial output', async () => {
    const controller = new AbortController();
    const call = adapter.runOneShot('/goal fixture', { workingDir: cwd, allowTools: true, abortSignal: controller.signal });
    for (let i = 0; i < 100 && !peers[0]?.waiting; i++) await new Promise(resolve => setTimeout(resolve, 1));
    controller.abort();
    await expect(call).rejects.toThrow('cancelled');
  });

  test('missing explicit workspaces fail without creating an empty replacement directory', async () => {
    options.workingDir = path.join(cwd, 'missing-workspace');
    const events = await collect('fixture');
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error', error: `Grok working directory is unavailable: ${options.workingDir}` })]));
    expect(await fsp.access(options.workingDir).then(() => true, () => false)).toBe(false);
    expect(peers).toHaveLength(0);
  });

  test('resume suppresses historical chunks and missing sessions invoke snapshot recovery', async () => {
    options.externalSessionId = 'missing-old';
    const createSnapshot = jest.fn().mockResolvedValue(null);
    options.sessionRecovery = { createSnapshot };
    const recovered = await collect('current');
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    expect(recovered).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'session_recovery' })]));
    const id = (recovered.find(event => event.type === 'external_session') as { sessionId: string }).sessionId;
    adapter.onSessionReset('conversation');
    options.externalSessionId = id;
    const resumed = await collect('next');
    expect(resumed.filter(event => event.type === 'text')).toEqual([{ type: 'text', content: 'next', streaming: true }]);
  });

  test('authentication errors do not trigger missing-session recovery', async () => {
    options.externalSessionId = 'auth-error';
    const events = await collect('current');
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error', error: 'Authentication required' })]));
    expect(peers[0].calls.filter(call => call.method === 'session/new')).toHaveLength(0);
  });

  test('goal status does not create a recovery snapshot or replacement native session', async () => {
    options.externalSessionId = 'missing-old';
    const createSnapshot = jest.fn();
    options.sessionRecovery = { createSnapshot };
    expect(await adapter.getGoal(options)).toBeNull();
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(peers[0].calls.some(call => call.method === 'session/new')).toBe(false);
  });

  test('a goal status read racing a resumed turn cannot suppress the turn session recovery', async () => {
    options.externalSessionId = 'missing-old';
    const createSnapshot = jest.fn().mockResolvedValue(null);
    options.sessionRecovery = { createSnapshot };
    let openGate!: () => void;
    attachGate = new Promise<void>(resolve => { openGate = resolve; });
    const status = adapter.getGoal(options);
    for (let i = 0; i < 100 && !peers[0]?.calls.some(call => call.method === 'session/resume'); i++) await new Promise(resolve => setTimeout(resolve, 1));
    const turn = collect('current');
    // The turn subscribes immediately before it requests session preparation.
    for (let i = 0; i < 100 && !peers[0].listeners.size; i++) await new Promise(resolve => setTimeout(resolve, 1));
    openGate();
    expect(await status).toBeNull();
    const events = await turn;
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'session_recovery' }), { type: 'external_session', sessionId: 'native-1' }]));
  });

  test('goal reads and controls never create native sessions, and every turn announces its session', async () => {
    options.externalSessionId = 'missing-old';
    expect(await adapter.getGoal(options)).toBeNull();
    options.externalSessionId = null;
    expect(await adapter.getGoal(options)).toBeNull();
    expect(await adapter.pauseGoal(options)).toBeNull();
    expect(await adapter.clearGoal(options)).toEqual({ cleared: true, sessionId: null });
    expect(peers[0].calls.some(call => call.method === 'session/new' || call.method === 'session/prompt')).toBe(false);
    const turns = [await collect('first'), await collect('second')];
    expect(peers[0].calls.filter(call => call.method === 'session/new')).toHaveLength(1);
    for (const events of turns) {
      expect(events).toContainEqual({ type: 'external_session', sessionId: 'native-1' });
      expect(events).toContainEqual({ type: 'backend_runtime', externalSessionId: 'native-1', processId: 123 });
    }
  });

  test('a goal control reserves the runtime while attaching, so a racing turn is rejected', async () => {
    native.set('paused-goal', { text: '', goal: { objective: 'fixture', status: 'user_paused' } });
    options.externalSessionId = 'paused-goal';
    let openGate!: () => void;
    attachGate = new Promise<void>(resolve => { openGate = resolve; });
    const clearing = adapter.clearGoal(options);
    for (let i = 0; i < 100 && !peers[0]?.calls.some(call => call.method === 'session/resume'); i++) await new Promise(resolve => setTimeout(resolve, 1));
    const overlap = collect('overlap');
    await new Promise(resolve => setTimeout(resolve, 10));
    openGate();
    expect(await overlap).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('active turn') }));
    expect(await clearing).toEqual({ cleared: true, sessionId: 'paused-goal' });
    expect(peers[0].calls.filter(call => call.method === 'session/prompt').map(call => (call.params.prompt as GrokRecord[])[0].text)).toEqual(['/goal clear']);
    expect(native.get('paused-goal')!.goal).toBeNull();
  });

  test('restricted calls keep the text-only wrap when a missing session is recovered', async () => {
    await adapter.runSessionShot(['evict-after', '/goal recovered'], { workingDir: cwd, allowTools: false });
    expect(peers).toHaveLength(2);
    const prompt = String((peers[1].calls.find(call => call.method === 'session/prompt')!.params.prompt as GrokRecord[])[0].text);
    expect(prompt).toContain('Complete this request with a text response only:\n\n/goal recovered');
    expect(prompt.startsWith('/')).toBe(false);
  });

  test('input without a pending interaction steers the active native turn', async () => {
    const result = adapter.setGoalObjective('fixture', options);
    for await (const event of result.stream) {
      if (event.type === 'goal_updated' && event.goal.status === 'active') { result.sendInput('Prefer Blue'); result.abort(); }
    }
    expect(peers[0].calls).toContainEqual({ method: '_x.ai/interject', params: { sessionId: 'native-1', text: 'Prefer Blue', interjectionId: expect.any(String) } });
  });

  test('pauses an active native goal through cancel, then resumes and clears it', async () => {
    const result = adapter.setGoalObjective('fixture', options);
    let paused: Promise<unknown> | undefined;
    for await (const event of result.stream) if (event.type === 'goal_updated' && event.goal.status === 'active') paused = adapter.pauseGoal(options);
    expect(await paused).toMatchObject({ status: 'paused' });
    expect(peers[0].calls.some(call => call.method === 'session/cancel')).toBe(true);
    expect(peers[0].calls.filter(call => call.method === 'session/prompt')).toHaveLength(1);
    options.externalSessionId = String(peers[0].calls.find(call => call.method === 'session/prompt')!.params.sessionId);
    adapter.onSessionReset('conversation');
    options.systemPrompt = 'Updated managed instructions';
    for await (const _event of adapter.resumeGoal(options).stream) { /* consume native completion */ }
    expect(peers[1].calls.find(call => call.method === 'session/prompt')!.params.prompt).toEqual([{ type: 'text', text: '/goal resume' }]);
    expect(await adapter.getGoal(options)).toMatchObject({ status: 'complete' });
    expect(await adapter.clearGoal(options)).toMatchObject({ cleared: true });
    expect(await adapter.getGoal(options)).toBeNull();
  });

  test('refreshes scoped MCP tokens on the same native session', async () => {
    options.mcpServers = [{ name: 'memory', command: 'node', args: [], env: [{ name: 'TOKEN', value: 'a' }] }];
    await collect('first');
    options.mcpServers[0].env![0].value = 'b';
    await collect('second');
    expect(peers[0].calls.find(call => call.method === 'session/resume')?.params).toMatchObject({ mcpServers: [{ env: [{ value: 'b' }] }] });
  });

  test('MCP refresh uses session/load when session/resume was not negotiated', async () => {
    jest.mocked(startGrokRuntime).mockImplementationOnce(async (_profile, _cwd, onClient) => {
      const peer = new Peer(); peers.push(peer); onClient?.(peer as unknown as GrokAcpClient);
      return { client: peer as unknown as GrokAcpClient, init: { agentCapabilities: {} }, sessionId: null, busy: null, cancel: null };
    });
    options.mcpServers = [{ name: 'memory', command: 'node', args: [], env: [{ name: 'TOKEN', value: 'a' }] }];
    await collect('first');
    options.mcpServers[0].env![0].value = 'b';
    const events = await collect('second');
    expect(peers[0].calls.some(call => call.method === 'session/load')).toBe(true);
    expect(peers[0].calls.some(call => call.method === 'session/resume')).toBe(false);
    expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', content: 'second', streaming: true }]);
  });

  test('registry cleanup after a CLI update permits a fresh runtime on the same adapter', async () => {
    await collect('before update');
    const registry = new BackendRegistry();
    registry.register(adapter);
    await registry.shutdownAll();
    await Promise.resolve();
    expect(peers[0].isClosed).toBe(true);
    const events = await collect('after update');
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.find(event => event.type === 'result')).toMatchObject({ content: 'after update' });
    expect(peers).toHaveLength(2);
  });
});

test('Grok runtime applies isolated homes and includes effective config in identity', () => {
  const profile = { id: 'grok', name: 'Grok', harness: 'grok-build' as const, authMode: 'account' as const, createdAt: '', updatedAt: '', configDir: '/tmp/grok-account', env: { PROBE: 'one' } };
  const one = resolveGrokCliRuntime(profile);
  expect(one.env.GROK_HOME).toBe('/tmp/grok-account');
  expect(one.env.GROK_DISABLE_AUTOUPDATER).toBe('1');
  expect(resolveGrokCliRuntime({ ...profile, env: { PROBE: 'two' } }).profileKey).not.toBe(one.profileKey);
});

test('billing preserves missing quota values and decodes cents separately from model ticks', () => {
  expect(normalizeGrokBilling({ subscription_tier: 'fixture', config: { prepaidBalance: { val: 123 }, onDemandCap: {}, onDemandUsed: null,
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2030-01-01T00:00:00Z' } } }))
    .toEqual(expect.objectContaining({ subscriptionTier: 'fixture', prepaidBalanceUsd: 1.23, onDemandCapUsd: 0, periodType: 'USAGE_PERIOD_TYPE_WEEKLY' }));
  const sparse = normalizeGrokBilling({ config: {} });
  expect(sparse.creditUsagePercent).toBeUndefined();
  expect(sparse.prepaidBalanceUsd).toBeUndefined();
});
