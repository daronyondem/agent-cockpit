import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { startCopilotSdkRuntime, type CopilotSdkRuntime } from '../src/services/backends/copilotSdkRuntime';
import { resolveCopilotCliRuntime } from '../src/services/backends/copilotRuntime';
import { CopilotAdapter, __copilotTestUtils } from '../src/services/backends/copilot';
import { CopilotConversations } from '../src/services/backends/copilotConversations';
import { CopilotModelCatalog } from '../src/services/backends/copilotCatalog';
import { spawnCopilotProcess } from '../src/services/backends/copilotProcess';
import { buildCliCommandInvocation } from '../src/services/cliCommandResolver';
import type { SendMessageOptions, StreamEvent } from '../src/types';
import { waitForCopilotPeer } from './helpers/copilotSdkPeer';

const native = process.env.COPILOT_SDK_E2E === '1' ? describe : describe.skip;

native('real Copilot owned SDK runtime with fixed local model responses', () => {
  let dir: string;
  let runtime: CopilotSdkRuntime | undefined;
  let provider: http.Server;
  let baseUrl: string;
  let scenario: 'text' | 'question' | 'steer' | 'delegate' | 'wait';
  let requests: Array<Record<string, unknown>>;
  let events: Array<Record<string, unknown>>;
  let releaseSteer: (() => void) | undefined;
  let question: unknown;
  let cliVersion: string;
  let nativeEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-sdk-native-'));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Synthetic instructions\nSDK_MANAGED_INSTRUCTIONS_MARKER\n');
    scenario = 'text'; requests = []; events = []; releaseSteer = undefined; question = undefined;
    provider = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        const data = JSON.parse(body);
        const messages = data.messages as Array<{ role: string; content: unknown }>;
        requests.push(data);
        const tools = (data.tools || []).map((tool: { function?: { name: string }; name?: string }) => tool.function || tool);
        const reply = (delta: object, finish = 'stop') => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const [part, reason] of [[delta, null], [{}, finish]]) res.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'gpt-4', choices: [{ index: 0, delta: part, finish_reason: reason }],
            ...(reason ? { usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 40 } } } : {}) })}\n\n`);
          res.end('data: [DONE]\n\n');
        };
        const say = (content: string) => reply({ role: 'assistant', content });
        const call = (name: string, args: object) => {
          if (!tools.some((tool: { name: string }) => tool.name === name)) { res.writeHead(400); res.end('Fixture tool missing'); return; }
          reply({ role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
        };
        const hasTool = messages.some(message => message.role === 'tool');
        if (scenario === 'question' && !hasTool) call('ask_user', { question: 'Choose a fixture answer', choices: ['Alpha', 'Beta'] });
        else if (scenario === 'wait' && !hasTool) {
          const powershell = process.platform === 'win32' && tools.some((tool: { name: string }) => tool.name === 'powershell');
          const quote = (value: string) => powershell ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
          const program = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(dir, 'worker.pid.tmp'))},String(process.pid));fs.renameSync(${JSON.stringify(path.join(dir, 'worker.pid.tmp'))},${JSON.stringify(path.join(dir, 'worker.pid'))});process.on('SIGTERM',()=>{});setTimeout(()=>fs.writeFileSync(${JSON.stringify(path.join(dir, 'worker-finished'))},'unexpected'),45000);`;
          call(powershell ? 'powershell' : 'bash', { command: `${powershell ? '& ' : ''}${quote(process.execPath)} -e ${quote(program)}`, description: 'Synthetic cancellable SDK worker', initial_wait: 1000 });
        } else if (scenario === 'steer' && !hasTool) {
          releaseSteer = () => {
            releaseSteer = undefined;
            const shell = process.platform === 'win32' && tools.some((tool: { name: string }) => tool.name === 'powershell') ? 'powershell' : 'bash';
            call(shell, { command: 'echo SDK_STEER_CHECKPOINT', description: 'Synthetic steering checkpoint', initial_wait: 1000 });
          };
        } else if (scenario === 'delegate') {
          const lastUser = JSON.stringify(messages.filter(message => message.role === 'user').at(-1)?.content);
          if (lastUser.includes('SDK_CHILD_ONLY')) say('SDK_CHILD_OK');
          else if (!hasTool) call('task', { name: 'fixture-child', agent_type: 'general-purpose', prompt: 'SDK_CHILD_ONLY', description: 'Run local delegate fixture' });
          else say('SDK_PARENT_OK');
        } else if (scenario === 'wait') say('SDK_WAIT_RETURNED');
        else if (scenario === 'steer') say(JSON.stringify(messages).includes('SDK_CORRECTION') ? 'SDK_STEER_OK' : 'SDK_STEER_MISSING');
        else if (scenario === 'question') say(JSON.stringify(messages.at(-1)?.content));
        else say('SDK_TEXT_OK');
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
    const resolved = resolveCopilotCliRuntime({ id: 'native-sdk', name: 'Native SDK fixture', harness: 'copilot', authMode: 'server-configured', command: process.env.COPILOT_SDK_CLI_PATH || 'copilot', createdAt: '', updatedAt: '' });
    nativeEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
      SHELL: process.env.SHELL, TMPDIR: os.tmpdir(), TEMP: os.tmpdir(), TMP: os.tmpdir(),
      HOME: dir, USERPROFILE: dir, APPDATA: path.join(dir, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(dir, 'AppData', 'Local'),
      COPILOT_HOME: path.join(dir, 'home'), GH_CONFIG_DIR: path.join(dir, 'gh'), COPILOT_DISABLE_KEYTAR: '1',
    };
    runtime = await startCopilotSdkRuntime({ ...resolved, env: nativeEnv }, dir);
    const status = await runtime.client.getStatus();
    cliVersion = status.version;
    if (process.env.COPILOT_SDK_REPORT_DIR) {
      fs.mkdirSync(process.env.COPILOT_SDK_REPORT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.COPILOT_SDK_REPORT_DIR, 'runtime.json'), JSON.stringify({ cli: cliVersion, protocolVersion: status.protocolVersion }));
    }
  });

  afterEach(async () => {
    releaseSteer?.();
    await runtime?.stop();
    runtime = undefined;
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    if (process.env.COPILOT_SDK_REPORT_DIR) {
      fs.mkdirSync(process.env.COPILOT_SDK_REPORT_DIR, { recursive: true });
      const label = expect.getState().currentTestName!.replace(/[^a-z0-9]+/gi, '-');
      fs.writeFileSync(path.join(process.env.COPILOT_SDK_REPORT_DIR, `${label}.json`), JSON.stringify({ cli: cliVersion, events, requests }, null, 2));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const config = () => ({
    model: 'gpt-4', streaming: true, workingDirectory: dir, trustWorkingDirectory: 'session' as const,
    provider: { type: 'openai' as const, baseUrl }, memory: { enabled: false },
    onPermissionRequest: () => ({ kind: 'approve-once' as const }),
    onUserInputRequest: (request: unknown) => { question = request; return { answer: 'Beta', wasFreeform: false }; },
    onEvent: (event: unknown) => { events.push(event as Record<string, unknown>); },
  });

  const conversationOptions = (overrides: Partial<SendMessageOptions> = {}): SendMessageOptions => ({
    sessionId: 'cockpit-native', conversationId: 'native-conversation', workingDir: dir,
    isNewSession: true, systemPrompt: 'Synthetic SDK conversation rules.', model: 'gpt-4',
    cliProfile: { id: 'conversation-native', name: 'Native conversation', harness: 'copilot', authMode: 'server-configured',
      command: process.env.COPILOT_SDK_CLI_PATH || 'copilot', createdAt: '', updatedAt: '',
      env: { ...Object.fromEntries(Object.entries(nativeEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '', COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: baseUrl, COPILOT_MODEL: 'gpt-4' },
    }, ...overrides,
  });
  const collectConversation = async (stream: AsyncGenerator<StreamEvent>) => {
    const frames: StreamEvent[] = [];
    for await (const frame of stream) { frames.push(frame); events.push({ source: 'cockpit', ...frame }); }
    return frames;
  };

  test('verifies native status, empty authentication, same-ID session resume, and context APIs', async () => {
    const status = await runtime!.client.getStatus();
    console.info('Copilot SDK compatibility evidence', { ...status, sdk: '1.0.28', platform: process.platform, arch: process.arch, node: process.version });
    expect(status).toMatchObject({ protocolVersion: 3 });
    expect(await runtime!.client.getAuthStatus()).toMatchObject({ isAuthenticated: false });
    await expect(runtime!.client.listModels()).rejects.toThrow(/authenticated/i);
    const catalog = new CopilotModelCatalog();
    const discovered = await catalog.forRuntime({ command: 'copilot', env: nativeEnv, profileKey: 'isolated-no-auth' }, runtime!.client);
    expect(discovered.modelCatalog).toMatchObject({ source: 'fallback', reason: expect.stringContaining('unavailable') });
    expect(discovered.models.find(model => model.id === 'auto')?.capabilities?.input?.image).toBe(false);
    await catalog.shutdown();
    let session = await runtime!.client.createSession(config());
    expect((await session.sendAndWait({ prompt: 'SDK_SMOKE' }))?.data.content).toBe('SDK_TEXT_OK');
    const id = session.sessionId;
    await session.disconnect();
    session = await runtime!.client.resumeSession(id, config());
    expect(session.sessionId).toBe(id);
    expect((await session.sendAndWait({ prompt: 'SDK_RESUME' }))?.data.content).toBe('SDK_TEXT_OK');
    expect(await session.rpc.metadata.contextInfo({ promptTokenLimit: 128000, outputTokenLimit: 4096 })).toMatchObject({ contextInfo: { modelName: 'gpt-4', totalTokens: expect.any(Number), limit: expect.any(Number) } });
    await session.disconnect();
  }, 45000);

  test('round-trips a native structured question through the official SDK callback', async () => {
    scenario = 'question';
    const session = await runtime!.client.createSession(config());
    const result = await session.sendAndWait({ prompt: 'Ask the fixture question' });
    expect(question).toMatchObject({ question: 'Choose a fixture answer', choices: ['Alpha', 'Beta'] });
    expect(result?.data.content).toContain('User selected: Beta');
    expect(events.some(event => event.type === 'user_input.completed')).toBe(true);
    await session.disconnect();
  }, 45000);

  test('resumes an existing JSONL conversation through the owned SDK runtime', async () => {
    const env = Object.fromEntries(Object.entries(nativeEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const profile = { id: 'legacy-interop', name: 'Legacy interop', harness: 'copilot' as const, authMode: 'server-configured' as const,
      command: process.env.COPILOT_SDK_CLI_PATH || 'copilot', createdAt: '', updatedAt: '',
      env: { ...env, COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '', COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: baseUrl, COPILOT_PROVIDER_API_KEY: '', COPILOT_MODEL: 'gpt-4' } };
    let sessionId: string | undefined;
    const resolved = resolveCopilotCliRuntime(profile);
    const invocation = buildCliCommandInvocation(resolved, __copilotTestUtils.buildCopilotRunArgs('SDK_JSONL_SEED', { workingDir: dir, model: 'gpt-4', allowTools: true }));
    const { proc, scope } = spawnCopilotProcess(invocation.command, invocation.args, { cwd: dir, env: resolved.env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      let output = '';
      proc.stdout!.setEncoding('utf8'); proc.stdout!.on('data', chunk => { output += chunk; }); proc.stderr!.resume();
      const code = await new Promise<number | null>((resolve, reject) => { proc.once('error', reject); proc.once('close', resolve); });
      expect(code).toBe(0);
      sessionId = __copilotTestUtils.collectCopilotJson(output).sessionId || undefined;
      expect(sessionId).toBeDefined();
      const session = await runtime!.client.resumeSession(sessionId!, config());
      expect(session.sessionId).toBe(sessionId);
      expect((await session.sendAndWait({ prompt: 'SDK_AFTER_JSONL' }))?.data.content).toBe('SDK_TEXT_OK');
      const last = requests.at(-1)!.messages as Array<{ role: string; content: unknown }>;
      expect(JSON.stringify(last)).toContain('SDK_JSONL_SEED');
      await session.disconnect();
    } finally { await scope.stop(); }
  }, 45000);

  test('steers an active native tool loop without starting a second queued request', async () => {
    scenario = 'steer';
    const session = await runtime!.client.createSession(config());
    const completed = session.sendAndWait({ prompt: 'SDK_INITIAL' });
    const deadline = Date.now() + 10000;
    while (!releaseSteer && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(releaseSteer).toBeDefined();
    await session.send({ prompt: 'SDK_CORRECTION', mode: 'immediate' });
    releaseSteer!();
    expect((await completed)?.data.content).toBe('SDK_STEER_OK');
    const corrections = events.filter(event => event.type === 'user.message' && (event.data as { content?: string }).content === 'SDK_CORRECTION');
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ data: { delivery: 'steering' } });
    expect(requests.length).toBeGreaterThanOrEqual(2);
    await session.disconnect();
  }, 45000);

  test('preserves native child identities and the separate parent answer', async () => {
    scenario = 'delegate';
    const session = await runtime!.client.createSession(config());
    expect((await session.sendAndWait({ prompt: 'SDK_DELEGATE_PARENT' }))?.data.content).toBe('SDK_PARENT_OK');
    const started = events.find(event => event.type === 'subagent.started')!;
    expect(started).toMatchObject({ agentId: expect.any(String), data: { toolCallId: expect.any(String), agentName: 'general-purpose' } });
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.completed', agentId: started.agentId }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'assistant.message', agentId: started.agentId, data: expect.objectContaining({ content: 'SDK_CHILD_OK' }) }));
    await session.disconnect();
  }, 45000);

  test('streams and cold-resumes a conversation through Cockpit ownership without losing its native history', async () => {
    await runtime!.stop(); runtime = undefined;
    const manager = new CopilotConversations({ startRuntime: async (...args) => { runtime = await startCopilotSdkRuntime(...args); return runtime; } });
    try {
      const first = await collectConversation(manager.sendMessage('SDK_CONVERSATION_SEED', conversationOptions()).stream);
      expect(first.some(frame => frame.type === 'error')).toBe(false);
      expect(first.filter(frame => frame.type === 'text')).toEqual([{ type: 'text', content: 'SDK_TEXT_OK', streaming: true }]);
      const id = first.find(frame => frame.type === 'external_session')!;
      expect(id).toMatchObject({ sessionId: expect.any(String) });
      if (id.type !== 'external_session') throw new Error('Missing native session ID');
      const resumed = await collectConversation(manager.sendMessage('SDK_CONVERSATION_RESUME', conversationOptions({ isNewSession: false, externalSessionId: id.sessionId })).stream);
      expect(resumed).toContainEqual(id);
      expect(resumed.some(frame => frame.type === 'error')).toBe(false);
      expect(resumed.filter(frame => frame.type === 'done')).toHaveLength(1);
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain('SDK_CONVERSATION_SEED');
    } finally { await manager.shutdown(); }
  }, 60000);

  test('production facade cold-resumes measured usage without charging history or counting cache twice', async () => {
    await runtime!.stop(); runtime = undefined;
    const adapter = new CopilotAdapter({ workingDir: dir });
    try {
      const first = await collectConversation(adapter.sendMessage('SDK_FACADE_SEED', conversationOptions({ model: 'auto' })).stream);
      const session = first.find(frame => frame.type === 'external_session');
      if (session?.type !== 'external_session') throw new Error('Missing session ID');
      const second = await collectConversation(adapter.sendMessage('SDK_FACADE_RESUME', conversationOptions({ isNewSession: false, externalSessionId: session.sessionId })).stream);
      for (const frames of [first, second]) {
        expect(frames.some(frame => frame.type === 'error')).toBe(false);
        expect(frames.filter(frame => frame.type === 'usage')).toEqual([{ type: 'usage', usage: {
          inputTokens: 80, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 0, credits: 0, costUsd: 0, costSource: 'none',
        } }]);
      }
      expect(second).toContainEqual(session);
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain('SDK_FACADE_SEED');
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain('SDK_MANAGED_INSTRUCTIONS_MARKER');
      scenario = 'delegate';
      const delegated = await collectConversation(adapter.sendMessage('SDK_FACADE_DELEGATE', conversationOptions({ isNewSession: false, externalSessionId: session.sessionId })).stream);
      expect(delegated.some(frame => frame.type === 'error')).toBe(false);
      expect(delegated.filter(frame => frame.type === 'usage')).toEqual([{ type: 'usage', usage: {
        inputTokens: 240, outputTokens: 90, cacheReadTokens: 120, cacheWriteTokens: 0, credits: 0, costUsd: 0, costSource: 'none',
      } }]);
      expect(delegated.filter(frame => frame.type === 'text').map(frame => frame.content).join('')).toBe('SDK_PARENT_OK');
    } finally { await adapter.shutdown(); }
  }, 60000);

  (process.platform === 'win32' ? test.skip : test)('preserves a command wrapper that privately configures its local provider', async () => {
    await runtime!.stop(); runtime = undefined;
    const command = path.join(dir, 'opaque-wrapper');
    fs.writeFileSync(command, `#!${process.execPath}
require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'opaque-args.json'))},JSON.stringify(process.argv.slice(2)));
const child=require('child_process').spawnSync(${JSON.stringify(process.env.COPILOT_SDK_CLI_PATH || 'copilot')},process.argv.slice(2),{stdio:'inherit',env:{...process.env,COPILOT_PROVIDER_TYPE:'openai',COPILOT_PROVIDER_BASE_URL:${JSON.stringify(baseUrl)},COPILOT_MODEL:'gpt-4'}});
if(child.error)throw child.error;process.exit(child.status??1);
`, { mode: 0o755 });
    const adapter = new CopilotAdapter({ workingDir: dir });
    const options = conversationOptions();
    options.cliProfile = { ...options.cliProfile!, command, env: { ...options.cliProfile!.env, COPILOT_PROVIDER_BASE_URL: '' } };
    try {
      const frames = await collectConversation(adapter.sendMessage('SDK_OPAQUE_PROVIDER', options).stream);
      expect(frames.some(frame => frame.type === 'error')).toBe(false);
      expect(frames.some(frame => frame.type === 'text' && frame.content === 'SDK_TEXT_OK')).toBe(true);
      const args = JSON.parse(fs.readFileSync(path.join(dir, 'opaque-args.json'), 'utf8'));
      expect(args).toEqual(expect.arrayContaining(['--output-format', 'json']));
      expect(args).not.toContain('--headless');
    } finally { await adapter.shutdown(); }
  }, 45000);

  test('cancels a native tool worker and immediately starts a replacement conversation turn', async () => {
    await runtime!.stop(); runtime = undefined;
    const manager = new CopilotConversations({ startRuntime: async (...args) => { runtime = await startCopilotSdkRuntime(...args); return runtime; } });
    let worker = 0;
    const alive = () => { try { process.kill(worker, 0); return true; } catch { return false; } };
    try {
      scenario = 'wait';
      const active = manager.sendMessage('SDK_CANCELLABLE_WORKER', conversationOptions());
      const pending = collectConversation(active.stream);
      await waitForCopilotPeer(() => fs.existsSync(path.join(dir, 'worker.pid')));
      worker = Number(fs.readFileSync(path.join(dir, 'worker.pid'), 'utf8'));
      expect(worker).toBeGreaterThan(0);
      const sessionId = events.find(event => event.source === 'cockpit' && event.type === 'external_session')?.sessionId;
      expect(sessionId).toEqual(expect.any(String));
      active.abort();
      scenario = 'text';
      const replacement = collectConversation(manager.sendMessage('SDK_AFTER_STOP', conversationOptions({ isNewSession: false, externalSessionId: String(sessionId) })).stream);
      expect((await pending).some(frame => frame.type === 'error' && frame.source === 'abort')).toBe(true);
      const resumed = await replacement;
      expect(resumed).toContainEqual({ type: 'external_session', sessionId });
      expect(resumed.some(frame => frame.type === 'text' && frame.content === 'SDK_TEXT_OK')).toBe(true);
      await waitForCopilotPeer(() => !alive());
      expect(Number(fs.readFileSync(path.join(dir, 'worker.pid'), 'utf8'))).toBe(worker);
      expect(fs.existsSync(path.join(dir, 'worker-finished'))).toBe(false);
    } finally {
      await manager.shutdown();
      if (worker && alive()) process.kill(worker, 'SIGKILL');
    }
  }, 60000);
});
