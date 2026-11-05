import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { randomUUID } from 'crypto';
import { startCopilotSdkRuntime, type CopilotSdkRuntime } from '../src/services/backends/copilotSdkRuntime';
import { resolveCopilotCliRuntime } from '../src/services/backends/copilotRuntime';
import { CopilotAdapter, __copilotTestUtils } from '../src/services/backends/copilot';
import { CopilotConversations } from '../src/services/backends/copilotConversations';
import { CopilotModelCatalog } from '../src/services/backends/copilotCatalog';
import { spawnCopilotProcess } from '../src/services/backends/copilotProcess';
import { buildCliCommandInvocation } from '../src/services/cliCommandResolver';
import type { SendMessageOptions, StreamEvent } from '../src/types';
import { waitForCopilotPeer } from './helpers/copilotSdkPeer';
import { addToUsage, emptyUsage } from '../src/services/chat/usageLedgerStore';
import { CopilotQuotaCache } from '../src/services/backends/copilotQuota';
import { copilotPng, copilotPdf, writeCopilotMediaTool } from './helpers/copilotMediaFixtures';

const native = process.env.COPILOT_SDK_E2E === '1' ? describe : describe.skip;

native('real Copilot owned SDK runtime with fixed local model responses', () => {
  let dir: string;
  let runtime: CopilotSdkRuntime | undefined;
  let provider: http.Server;
  let baseUrl: string;
  let scenario: 'text' | 'question' | 'questions' | 'steer' | 'steer-tool' | 'delegate' | 'delegation' | 'wait' | 'goal' | 'media';
  let goalDelegation: boolean;
  let delegationMode: 'parallel' | 'nested' | 'background' | 'error' | 'cancel';
  let releaseDelegate: (() => void) | undefined;
  let finalBeforeSteer: boolean;
  let requests: Array<Record<string, unknown>>;
  let events: Array<Record<string, unknown>>;
  let releaseSteer: (() => void) | undefined;
  let question: unknown;
  let cliVersion: string;
  let nativeEnv: NodeJS.ProcessEnv;
  let startupFailure: unknown;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-sdk-native-'));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Synthetic instructions\nSDK_MANAGED_INSTRUCTIONS_MARKER\n');
    scenario = 'text'; requests = []; events = []; releaseSteer = undefined; question = undefined; finalBeforeSteer = false;
    delegationMode = 'parallel'; releaseDelegate = undefined; goalDelegation = false;
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
          if (req.url?.split('?')[0].endsWith('/messages')) {
            const emit = (type: string, payload: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
            emit('message_start', { message: { id: 'fixture', type: 'message', role: 'assistant', model: data.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 0 } } });
            emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
            emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'SDK_MEDIA_OK' } });
            emit('content_block_stop', { index: 0 });
            emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } });
            emit('message_stop', {}); res.end(); return;
          }
          for (const [part, reason] of [[delta, null], [{}, finish]]) res.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'gpt-4', choices: [{ index: 0, delta: part, finish_reason: reason }],
            ...(reason ? { usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 40 } } } : {}) })}\n\n`);
          res.end('data: [DONE]\n\n');
        };
        const say = (content: string) => reply({ role: 'assistant', content });
        const call = (name: string, args: object) => {
          if (!tools.some((tool: { name: string }) => tool.name === name)) { res.writeHead(400); res.end('Fixture tool missing'); return; }
          reply({ role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${name}-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
        };
        const hasTool = messages.some(message => message.role === 'tool');
        const currentUserIndex = messages.reduce((last, message, index) => message.role === 'user' ? index : last, -1);
        const currentHasTool = messages.slice(currentUserIndex).some(message => message.role === 'tool');
        if (scenario === 'steer-tool') {
          // A resumed turn already contains tools. Find this turn's original
          // prompt even after the native runtime inserts the steering message.
          const start = messages.reduce((last, message, index) => message.role === 'user' && /SDK_TOOL_(WARMUP|INITIAL)/.test(JSON.stringify(message.content)) ? index : last, -1);
          const warmup = JSON.stringify(messages[start]?.content).includes('SDK_TOOL_WARMUP');
          if (messages.slice(start).some(message => message.role === 'tool')) {
            const respond = () => say(warmup ? 'SDK_WARMUP_OK' : JSON.stringify(messages).includes('SDK_RUNNING_CORRECTION') ? 'SDK_RUNNING_STEER_OK' : 'SDK_RUNNING_STEER_MISSING');
            if (warmup || fs.existsSync(path.join(dir, 'steer-worker-finished'))) respond();
            else {
              const timer = setInterval(() => { if (fs.existsSync(path.join(dir, 'steer-worker-finished'))) { clearInterval(timer); respond(); } }, 20);
              res.on('close', () => clearInterval(timer));
            }
          } else {
            const powershell = process.platform === 'win32' && tools.some((tool: { name: string }) => tool.name === 'powershell');
            const quote = (value: string) => powershell ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
            const program = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(dir, 'steer-worker.pid'))},String(process.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(dir, 'steer-worker-release'))})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(path.join(dir, 'steer-worker-finished'))},'done');console.log('WAIT_DONE');}},20);setTimeout(()=>process.exit(1),90000).unref();`;
            call(powershell ? 'powershell' : 'bash', { command: warmup ? 'echo SDK_WARMUP_TOOL' : `${powershell ? '& ' : ''}${quote(process.execPath)} -e ${quote(program)}`,
              description: warmup ? 'Warm the existing conversation with a tool' : 'Wait for release while steering a running tool', mode: 'sync', initial_wait: 120 });
          }
          return;
        }
        if (scenario === 'media') {
          const mediaTool = tools.find((tool: { name?: string }) => tool.name?.endsWith('media_output'));
          if (!hasTool && mediaTool) call(mediaTool.name, {}); else say('SDK_MEDIA_OK');
          return;
        }
        if ((scenario === 'goal' || goalDelegation) && requests.length > 12) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Goal fixture request deadline', type: 'invalid_request_error' } })); return;
        }
        if (scenario === 'delegation') {
          const lastUser = String(messages.filter(message => message.role === 'user').at(-1)?.content || '');
          const child = /SDK_PHASE6_CHILD_(LEFT|RIGHT|OUTER|INNER)$/.exec(lastUser)?.[1];
          const task = (name: string) => ({ name: 'task', args: { name, agent_type: 'general-purpose', description: `Check ${name}`, prompt: name,
            ...(delegationMode === 'background' ? { mode: 'background' } : {}) } });
          const tasks = (names: string[]) => reply({ role: 'assistant', tool_calls: names.map((name, index) => {
            const tool = task(name); return { index, id: `phase6-${requests.length}-${index}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } };
          }) }, 'tool_calls');
          if (child) {
            if (delegationMode === 'error') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Synthetic child model failure', type: 'invalid_request_error' } })); return; }
            if (!hasTool && delegationMode === 'nested' && child === 'OUTER') { tasks(['SDK_PHASE6_CHILD_INNER']); return; }
            if (!hasTool) {
              const send = () => {
                releaseDelegate = undefined;
                const powershell = process.platform === 'win32' && tools.some((tool: { name: string }) => tool.name === 'powershell');
                const quote = (value: string) => powershell ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
                const program = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(dir, 'worker.pid'))},String(process.pid));process.on('SIGTERM',()=>{});setTimeout(()=>fs.writeFileSync(${JSON.stringify(path.join(dir, 'worker-finished'))},'unexpected'),45000);`;
                call(powershell ? 'powershell' : 'bash', { command: delegationMode === 'cancel' ? `${powershell ? '& ' : ''}${quote(process.execPath)} -e ${quote(program)}` : 'echo SDK_PHASE6_TOOL', description: `Child ${child} tool`, initial_wait: 1000 });
              };
              if (delegationMode === 'background') releaseDelegate = send; else send();
              return;
            }
            say(`SDK_PHASE6_SUMMARY_${child}`); return;
          }
          if (!hasTool) tasks(delegationMode === 'parallel' ? ['SDK_PHASE6_CHILD_LEFT', 'SDK_PHASE6_CHILD_RIGHT'] : [delegationMode === 'nested' ? 'SDK_PHASE6_CHILD_OUTER' : 'SDK_PHASE6_CHILD_LEFT']);
          else if (goalDelegation && !messages.some(message => (message as { tool_calls?: Array<{ function: { name: string } }> }).tool_calls?.some(tool => tool.function.name === 'task_complete'))) call('task_complete', { summary: 'SDK_GOAL_DELEGATION_VERIFIED' });
          else say('SDK_PHASE6_PARENT_OK');
          return;
        }
        if (scenario === 'goal') { call('task_complete', { summary: 'SDK_GOAL_VERIFIED' }); return; }
        if (scenario === 'questions' && messages.filter(message => message.role === 'tool').length < 2) {
          call('ask_user', { question: 'Choose a fixture answer', choices: ['Alpha', 'Beta'] });
        } else if (scenario === 'question' && !currentHasTool) call('ask_user', { question: 'Choose a fixture answer', choices: ['Alpha', 'Beta'] });
        else if (scenario === 'wait' && !hasTool) {
          const powershell = process.platform === 'win32' && tools.some((tool: { name: string }) => tool.name === 'powershell');
          const quote = (value: string) => powershell ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
          const program = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(dir, 'worker.pid.tmp'))},String(process.pid));fs.renameSync(${JSON.stringify(path.join(dir, 'worker.pid.tmp'))},${JSON.stringify(path.join(dir, 'worker.pid'))});process.on('SIGTERM',()=>{});setTimeout(()=>fs.writeFileSync(${JSON.stringify(path.join(dir, 'worker-finished'))},'unexpected'),45000);`;
          call(powershell ? 'powershell' : 'bash', { command: `${powershell ? '& ' : ''}${quote(process.execPath)} -e ${quote(program)}`, description: 'Synthetic cancellable SDK worker', initial_wait: 1000 });
        } else if (scenario === 'steer' && !hasTool) {
          releaseSteer = () => {
            releaseSteer = undefined;
            if (finalBeforeSteer) { say('SDK_FINISHED_BEFORE_CORRECTION'); return; }
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
        else if (scenario === 'question' || scenario === 'questions') say(JSON.stringify(messages.at(-1)?.content));
        else say('SDK_TEXT_OK');
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
    const resolved = resolveCopilotCliRuntime({ id: 'native-sdk', name: 'Native SDK fixture', harness: 'copilot', authMode: 'server-configured', command: process.env.COPILOT_SDK_CLI_PATH || 'copilot', createdAt: '', updatedAt: '' });
    nativeEnv = {
      // Keep OS/PowerShell initialization variables on Windows. Isolate auth and
      // provider configuration instead of replacing the entire OS environment.
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(COPILOT_|GH_|GITHUB_|OPENAI_|ANTHROPIC_|AZURE_|AWS_|NODE_OPTIONS$)/i.test(key))),
      TMPDIR: os.tmpdir(), TEMP: os.tmpdir(), TMP: os.tmpdir(),
      HOME: dir, USERPROFILE: dir, APPDATA: path.join(dir, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(dir, 'AppData', 'Local'),
      COPILOT_HOME: path.join(dir, 'home'), GH_CONFIG_DIR: path.join(dir, 'gh'), COPILOT_DISABLE_KEYTAR: '1',
      COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '',
    };
    if (startupFailure) throw startupFailure;
    try {
      runtime = await startCopilotSdkRuntime({ ...resolved, env: nativeEnv }, dir);
    } catch (error) {
      // A broken native startup cannot qualify subsequent scenarios. Retain one
      // isolated diagnostic rather than spending every case's startup deadline.
      startupFailure = error;
      if (process.platform === 'win32' && process.env.COPILOT_SDK_REPORT_DIR) {
        const invocation = buildCliCommandInvocation(resolved, ['--headless', '--no-auto-update', '--log-level', 'none']);
        const { proc, scope } = spawnCopilotProcess(invocation.command, invocation.args, {
          cwd: dir, env: { ...nativeEnv, COPILOT_CONNECTION_TOKEN: randomUUID() }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = ''; let stderr = '';
        proc.stdout!.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-16_384); });
        proc.stderr!.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16_384); });
        try {
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 5000);
            proc.once('error', () => { clearTimeout(timer); resolve(); });
            proc.once('close', () => { clearTimeout(timer); resolve(); });
          });
        } finally {
          await scope.stop();
          fs.writeFileSync(path.join(process.env.COPILOT_SDK_REPORT_DIR, 'startup-failure.json'), JSON.stringify({ stdout, stderr, exitCode: proc.exitCode }, null, 2));
        }
      }
      throw error;
    }
    const status = await runtime.client.getStatus();
    cliVersion = status.version;
    if (process.env.COPILOT_SDK_REPORT_DIR) {
      fs.mkdirSync(process.env.COPILOT_SDK_REPORT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.COPILOT_SDK_REPORT_DIR, 'runtime.json'), JSON.stringify({ cli: cliVersion, protocolVersion: status.protocolVersion }));
    }
  });

  afterEach(async () => {
    releaseSteer?.();
    releaseDelegate?.();
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
  const totalUsage = (frames: StreamEvent[]) => {
    const total = emptyUsage();
    for (const frame of frames) if (frame.type === 'usage') addToUsage(total, frame.usage);
    return total;
  };

  test('transports native SDK image bytes without file tools', async () => {
    scenario = 'media';
    const session = await runtime!.client.createSession({ ...config(), model: 'gpt-6.1-sol', availableTools: [] });
    const image = path.join(dir, 'image.png');
    fs.writeFileSync(image, copilotPng);
    await session.send({ prompt: '', attachments: [{ type: 'file', path: image }] });
    await waitForCopilotPeer(() => events.some(event => event.type === 'session.idle'));
    expect(events.some(event => event.type === 'tool.execution_start')).toBe(false);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain(`data:image/png;base64,${copilotPng.toString('base64')}`);
  }, 30000);

  test('exposes native MCP image and PDF output bytes', async () => {
    scenario = 'media';
    await runtime!.stop(); runtime = undefined;
    fs.writeFileSync(path.join(nativeEnv.COPILOT_HOME!, 'mcp-config.json'), JSON.stringify({ mcpServers: {
      'fixture-media': { type: 'local', command: process.execPath, args: [writeCopilotMediaTool(dir)], tools: ['*'] },
    } }));
    const adapter = new CopilotAdapter({ workingDir: dir });
    try {
      const frames = await collectConversation(adapter.sendMessage('SDK_MEDIA_OUTPUT', conversationOptions({ model: 'gpt-6.1-sol' })).stream);
      expect(frames.some(frame => frame.type === 'error')).toBe(false);
      const artifacts = frames.filter(frame => frame.type === 'artifact');
      expect(artifacts).toHaveLength(2);
      expect(artifacts).toMatchObject([{ mimeType: 'image/png', dataBase64: copilotPng.toString('base64') },
        { mimeType: 'application/pdf', filename: 'report.pdf', dataBase64: copilotPdf().toString('base64') }]);
    } finally { await adapter.shutdown(); }
  }, 30000);

  test('transports native PDF through an Anthropic provider without file tools', async () => {
    scenario = 'media';
    const session = await runtime!.client.createSession({ ...config(), model: 'claude-sonnet-4.6',
      provider: { type: 'anthropic', baseUrl, apiKey: 'synthetic-local-key' }, availableTools: [] });
    const pdf = path.join(dir, 'report.pdf'); fs.writeFileSync(pdf, copilotPdf());
    await session.send({ prompt: 'SDK_MEDIA_PDF', attachments: [{ type: 'file', path: pdf }] });
    await waitForCopilotPeer(() => events.some(event => event.type === 'session.idle'));
    expect(events.some(event => event.type === 'tool.execution_start')).toBe(false);
    expect(JSON.stringify(requests)).toContain(copilotPdf().toString('base64'));
    events = [];
    const image = path.join(dir, 'image.png'); fs.writeFileSync(image, copilotPng);
    await session.send({ prompt: 'SDK_MEDIA_IMAGE', attachments: [{ type: 'file', path: image }] });
    await waitForCopilotPeer(() => events.some(event => event.type === 'session.idle'));
    expect(JSON.stringify(requests.at(-1))).toContain(copilotPng.toString('base64'));
  }, 30000);

  test('chat sends image attachments across cold resume and gates an OpenAI-provider PDF before model work', async () => {
    scenario = 'media'; await runtime!.stop(); runtime = undefined;
    const image = path.join(dir, 'chat.png'); fs.writeFileSync(image, copilotPng);
    const adapter = new CopilotAdapter({ workingDir: dir });
    const options = conversationOptions({ model: 'gpt-6.1-sol' });
    try {
      const first = await collectConversation(adapter.sendMessage(`SDK_MEDIA_CHAT\n\n[Uploaded files: ${image}]`, options).stream);
      expect(first.some(frame => frame.type === 'error')).toBe(false);
      const id = first.find(frame => frame.type === 'external_session')!.sessionId;
      const second = await collectConversation(adapter.sendMessage(`[Uploaded files: ${image}]`, { ...options, isNewSession: false, externalSessionId: String(id) }).stream);
      expect(second.some(frame => frame.type === 'error')).toBe(false);
      expect(requests).toHaveLength(2);
      for (const request of requests) expect(JSON.stringify(request)).toContain(`data:image/png;base64,${copilotPng.toString('base64')}`);
      const refused = await collectConversation(adapter.sendMessage(`[Uploaded files: ${path.join(dir, 'report.pdf')}]`, options).stream);
      expect(refused).toContainEqual({ type: 'error', error: expect.stringContaining('verified pdf input') });
      expect(requests).toHaveLength(2);
    } finally { await adapter.shutdown(); }
  }, 30000);

  test('chat sends PDF bytes through the verified Anthropic selection', async () => {
    scenario = 'media'; await runtime!.stop(); runtime = undefined;
    const pdf = path.join(dir, 'chat.pdf'); fs.writeFileSync(pdf, copilotPdf());
    const options = conversationOptions({ model: 'claude-sonnet-4.6' });
    options.cliProfile!.env = { ...options.cliProfile!.env, COPILOT_PROVIDER_TYPE: 'anthropic', COPILOT_PROVIDER_API_KEY: 'synthetic-local-key', COPILOT_MODEL: 'claude-sonnet-4.6' };
    const adapter = new CopilotAdapter({ workingDir: dir });
    try {
      const frames = await collectConversation(adapter.sendMessage(`SDK_MEDIA_PDF\n\n[Uploaded files: ${pdf}]`, options).stream);
      expect(frames.some(frame => frame.type === 'error')).toBe(false);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain(copilotPdf().toString('base64'));
    } finally { await adapter.shutdown(); }
  }, 30000);

  test('restricted one-shots transport a PDF through Anthropic with zero file tools', async () => {
    scenario = 'media'; await runtime!.stop(); runtime = undefined;
    const pdf = path.join(dir, 'one-shot.pdf'); fs.writeFileSync(pdf, copilotPdf());
    const options = conversationOptions({ model: 'claude-sonnet-4.6' });
    options.cliProfile!.env = { ...options.cliProfile!.env, COPILOT_PROVIDER_TYPE: 'anthropic', COPILOT_PROVIDER_API_KEY: 'synthetic-local-key', COPILOT_MODEL: 'claude-sonnet-4.6' };
    const adapter = new CopilotAdapter({ workingDir: dir });
    try {
      expect(await adapter.runOneShot('SDK_MEDIA_ONESHOT', { model: options.model, cliProfile: options.cliProfile,
        attachments: [{ path: pdf, kind: 'pdf' }], allowTools: false, timeoutMs: 20000 })).toBe('SDK_MEDIA_OK');
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain(copilotPdf().toString('base64'));
      expect(requests[0].tools || []).toHaveLength(0);
    } finally { await adapter.shutdown(); }
  }, 30000);

  test('reports native context and credit availability without inventing an unauthenticated quota', async () => {
    await expect(runtime!.client.rpc.account.getQuota({})).rejects.toThrow();
    const session = await runtime!.client.createSession(config());
    const quota = await session.rpc.quota.get();
    events.push({ source: 'probe', quota });
    expect(quota.snapshots).toEqual({});
    await session.send({ prompt: 'SDK_USAGE_SNAPSHOT' });
    await waitForCopilotPeer(() => events.some(event => event.type === 'session.idle'));
    const context = await session.rpc.metadata.contextInfo({ promptTokenLimit: 128000, outputTokenLimit: 4096 });
    const metrics = await session.rpc.usage.getMetrics();
    events.push({ source: 'probe', context, metrics });
    expect(context.contextInfo).toMatchObject({ totalTokens: expect.any(Number), limit: 128000 });
    expect(events.some(event => event.type === 'session.usage_info')).toBe(true);
    expect(metrics).toMatchObject({ totalNanoAiu: 0, aiCreditsStatus: 'unavailable' });
  }, 30000);

  test('owned account quota service closes an unauthenticated native probe without sessions or inference', async () => {
    await runtime!.stop(); runtime = undefined;
    const options = conversationOptions();
    const profile = { ...options.cliProfile!, command: 'copilot', env: { ...options.cliProfile!.env,
      COPILOT_PROVIDER_BASE_URL: '', COPILOT_MODEL: '' } };
    let launches = 0;
    const quota = new CopilotQuotaCache({ startRuntime: async (resolved, dir, options) => {
      launches++;
      const selected = resolveCopilotCliRuntime({ ...profile, command: process.env.COPILOT_SDK_CLI_PATH || 'copilot' });
      runtime = await startCopilotSdkRuntime({ ...selected, env: resolved.env }, dir, options);
      return runtime;
    } });
    try {
      expect(await quota.get(profile)).toMatchObject({ status: 'unavailable', rows: [], fetchedAt: null });
      expect(await quota.get(profile)).toMatchObject({ status: 'unavailable', rows: [] });
      expect(launches).toBe(1);
      expect(requests).toHaveLength(0);
      expect(events).toHaveLength(0);
      expect(runtime!.process.exitCode !== null || runtime!.process.signalCode !== null).toBe(true);
    } finally { await quota.shutdown(); }
  }, 30000);

  test('native goals complete, replace literal objectives and retain credit units after cold status reads', async () => {
    await runtime!.stop(); runtime = undefined;
    const adapter = new CopilotAdapter({ workingDir: dir });
    try {
      scenario = 'goal';
      const first = await collectConversation(adapter.setGoalObjective('SDK_GOAL_OBJECTIVE', conversationOptions()).stream);
      expect(first.filter(frame => frame.type === 'goal_updated').map(frame => frame.goal.status)).toEqual(['active', 'complete']);
      const id = String(first.find(frame => frame.type === 'external_session')!.sessionId);
      const saved = conversationOptions({ isNewSession: false, externalSessionId: id });
      expect(await adapter.getGoal(saved)).toMatchObject({ objectiveId: 1, status: 'complete', lastReason: 'SDK_GOAL_VERIFIED' });
      const second = await collectConversation(adapter.setGoalObjective('off --max-ai-credits 9', { ...saved, goalAiCreditLimit: 2.5 }).stream);
      expect(second.filter(frame => frame.type === 'goal_updated').at(-1)?.goal).toMatchObject({ objectiveId: 2, objective: 'off --max-ai-credits 9', status: 'complete', aiCreditLimit: 2.5, aiCreditsUsed: 0 });
      expect(await adapter.getGoal(saved)).toMatchObject({ objectiveId: 2, status: 'complete', aiCreditLimit: 2.5 });
      expect(requests).toHaveLength(2);
      // Read-only attaches must not leave later interactive tools disabled.
      scenario = 'question';
      const active = adapter.sendMessage('SDK_GOAL_AFTER_CONTROL_QUESTION', saved);
      const pending = collectConversation(active.stream);
      await waitForCopilotPeer(() => events.some(event => event.type === 'tool_activity' && event.inputRequestId));
      const question = events.find(event => event.type === 'tool_activity' && event.inputRequestId)!;
      expect(await active.deliverInput!({ text: 'Beta', requestId: String(question.inputRequestId) })).toEqual({ accepted: true });
      expect((await pending).some(frame => frame.type === 'text' && frame.content.includes('Beta'))).toBe(true);
      expect(requests).toHaveLength(4);
    } finally { await adapter.shutdown(); }
  }, 60000);

  test('native idle does not achieve an objective and removed Clear leaves it intact', async () => {
    const session = await runtime!.client.createSession({ ...config(), autopilot: { continuationEnabled: false, maxContinues: 0 } });
    const effect = await session.rpc.commands.invoke({ name: 'autopilot', input: '-- SDK_IDLE_GOAL' });
    if (effect.kind !== 'agent-prompt') throw new Error('Missing goal prompt');
    await session.send({ prompt: effect.prompt });
    await waitForCopilotPeer(() => events.some(event => event.type === 'session.idle'));
    expect((await session.rpc.autopilotObjective.getState()).state).toMatchObject({ objective: 'SDK_IDLE_GOAL', status: 'active' });
    await session.rpc.commands.invoke({ name: 'autopilot', input: 'off' });
    const clear = await session.rpc.commands.invoke({ name: 'goal', input: 'clear' });
    expect(clear).toMatchObject({ kind: 'text' });
    expect(JSON.stringify(clear)).toContain('removed');
    expect((await session.rpc.autopilotObjective.getState()).state).toMatchObject({ objective: 'SDK_IDLE_GOAL', status: 'paused' });
    await runtime!.stop(); runtime = undefined;
    const adapter = new CopilotAdapter();
    try {
      expect(await adapter.getGoal(conversationOptions({ isNewSession: false, externalSessionId: session.sessionId }))).toMatchObject({ status: 'paused', objective: 'SDK_IDLE_GOAL' });
      expect(requests).toHaveLength(1);
    } finally { await adapter.shutdown(); }
  }, 60000);

  test.each(['pause', 'stop', 'reset'] as const)('goal %s terminates native tools and explicit credit resume completes without replay', async action => {
    await runtime!.stop(); runtime = undefined;
    const adapter = new CopilotAdapter();
    let worker = 0;
    const alive = () => { try { process.kill(worker, 0); return true; } catch { return false; } };
    try {
      scenario = 'wait';
      const active = adapter.setGoalObjective('SDK_GOAL_WORKER', conversationOptions());
      const pending = collectConversation(active.stream);
      await waitForCopilotPeer(() => fs.existsSync(path.join(dir, 'worker.pid')));
      worker = Number(fs.readFileSync(path.join(dir, 'worker.pid'), 'utf8'));
      expect(await adapter.getGoal(conversationOptions())).toMatchObject({ status: 'active', objective: 'SDK_GOAL_WORKER' });
      if (action === 'pause') expect(await adapter.pauseGoal(conversationOptions())).toMatchObject({ status: 'paused', objective: 'SDK_GOAL_WORKER' });
      else if (action === 'reset') await adapter.onSessionReset('native-conversation');
      else active.abort();
      const frames = await pending;
      if (action === 'pause') expect(frames.some(frame => frame.type === 'error')).toBe(false);
      await waitForCopilotPeer(() => !alive());
      expect(frames.some(frame => frame.type === 'goal_updated' && frame.goal.status === 'complete')).toBe(false);
      const id = String(frames.find(frame => frame.type === 'external_session')!.sessionId);
      const saved = conversationOptions({ isNewSession: false, externalSessionId: id });
      expect(await adapter.getGoal(saved)).toMatchObject({ objectiveId: 1, status: 'paused', objective: 'SDK_GOAL_WORKER' });
      expect(() => adapter.resumeGoal(saved)).toThrow('fresh AI credit limit');
      scenario = 'goal';
      const resumed = await collectConversation(adapter.resumeGoal({ ...saved, goalAiCreditLimit: 3 }).stream);
      expect(resumed.filter(frame => frame.type === 'goal_updated').at(-1)?.goal).toMatchObject({ objectiveId: 1, status: 'complete', aiCreditLimit: 3 });
      expect(await adapter.getGoal(saved)).toMatchObject({ status: 'complete', turns: 2, aiCreditLimit: 3 });
      expect(Number(fs.readFileSync(path.join(dir, 'worker.pid'), 'utf8'))).toBe(worker);
      expect(fs.existsSync(path.join(dir, 'worker-finished'))).toBe(false);
    } finally { await adapter.shutdown(); if (worker && alive()) process.kill(worker, 'SIGKILL'); }
  }, 60000);

  test('goal completion drains attached background delegates before closing the stream', async () => {
    await runtime!.stop(); runtime = undefined;
    const adapter = new CopilotAdapter();
    const frames: StreamEvent[] = [];
    try {
      scenario = 'delegation'; delegationMode = 'background'; goalDelegation = true;
      const active = adapter.setGoalObjective('SDK_GOAL_BACKGROUND', conversationOptions());
      const deadline = setTimeout(() => active.abort(), 20000);
      const pending = (async () => { for await (const frame of active.stream) { frames.push(frame); events.push({ source: 'cockpit', ...frame }); } })();
      try {
        await waitForCopilotPeer(() => !!releaseDelegate);
        expect(frames.some(frame => frame.type === 'done')).toBe(false);
        releaseDelegate!(); await pending;
      } finally { clearTimeout(deadline); }
      expect(frames.some(frame => frame.type === 'error')).toBe(false);
      expect(frames.filter(frame => frame.type === 'goal_updated').at(-1)?.goal).toMatchObject({ status: 'complete', lastReason: 'SDK_GOAL_DELEGATION_VERIFIED' });
      expect(frames.filter(frame => frame.type === 'tool_outcomes').flatMap(frame => frame.outcomes)).toContainEqual(expect.objectContaining({ status: 'success', summary: 'SDK_PHASE6_SUMMARY_LEFT' }));
    } finally { releaseDelegate?.(); await adapter.shutdown(); }
  }, 60000);

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
        expect(totalUsage(frames)).toMatchObject({
          inputTokens: 80, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 0, credits: 0, costUsd: 0, costSource: 'none',
          copilot: { tokensStatus: 'complete', aiCreditsStatus: 'unavailable', premiumRequests: 0 },
          contextWindow: { status: 'available', tokenLimit: 128000 },
        });
      }
      expect(second).toContainEqual(session);
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain('SDK_FACADE_SEED');
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain('SDK_MANAGED_INSTRUCTIONS_MARKER');
      scenario = 'delegate';
      const delegated = await collectConversation(adapter.sendMessage('SDK_FACADE_DELEGATE', conversationOptions({ isNewSession: false, externalSessionId: session.sessionId })).stream);
      expect(delegated.some(frame => frame.type === 'error')).toBe(false);
      expect(totalUsage(delegated)).toMatchObject({
        inputTokens: 240, outputTokens: 90, cacheReadTokens: 120, cacheWriteTokens: 0, credits: 0, costUsd: 0, costSource: 'none',
      });
      expect(delegated.filter(frame => frame.type === 'text').map(frame => frame.content).join('')).toBe('SDK_PARENT_OK');
    } finally { await adapter.shutdown(); }
  }, 60000);

  test.each(['parallel', 'nested', 'background', 'background-steering', 'error'] as const)('production %s delegation keeps tools/summaries separate and counts all inference once', async mode => {
    await runtime!.stop(); runtime = undefined;
    const adapter = new CopilotAdapter({ workingDir: dir });
    const frames: StreamEvent[] = [];
    try {
      scenario = 'delegation'; delegationMode = mode === 'background-steering' ? 'background' : mode;
      const active = adapter.sendMessage('SDK_PHASE6_PARENT', conversationOptions());
      let finished = false;
      const pending = (async () => { for await (const frame of active.stream) { frames.push(frame); events.push({ source: 'cockpit', ...frame }); } finished = true; })();
      if (delegationMode === 'background') {
        await waitForCopilotPeer(() => !!releaseDelegate && frames.some(frame => frame.type === 'text'));
        expect(finished).toBe(false);
        expect(frames.some(frame => frame.type === 'done')).toBe(false);
        expect(frames.filter(frame => frame.type === 'tool_outcomes').flatMap(frame => frame.outcomes).some(outcome => outcome.outcome === 'done')).toBe(false);
        if (mode === 'background-steering') await waitForCopilotPeer(() => frames.some(frame => frame.type === 'input_ready' && frame.turnId));
        const turn = frames.find(frame => frame.type === 'input_ready' && frame.turnId);
        const delivery = mode === 'background-steering' && turn?.type === 'input_ready'
          ? active.deliverInput!({ text: 'SDK_PHASE6_CORRECTION', turnId: turn.turnId!, inputId: 'background-correction' }) : undefined;
        if (delivery) await new Promise(resolve => setTimeout(resolve, 150));
        releaseDelegate!();
        if (delivery) { const result = await delivery; events.push({ source: 'input', result }); expect(result.accepted || result.status === 409).toBe(true); }
      }
      await pending;
      const agents = frames.filter((frame): frame is Extract<StreamEvent, { type: 'tool_activity' }> => frame.type === 'tool_activity' && frame.isAgent === true);
      const outcomes = frames.filter(frame => frame.type === 'tool_outcomes').flatMap(frame => frame.outcomes);
      expect(agents).toHaveLength(mode === 'parallel' || mode === 'nested' ? 2 : 1);
      expect(new Set(agents.map(agent => agent.id)).size).toBe(agents.length);
      expect(frames.some(frame => frame.type === 'error')).toBe(false);
      expect(frames.filter(frame => frame.type === 'text').map(frame => frame.content).join('').replaceAll('SDK_PHASE6_PARENT_OK', '')).toBe('');
      for (const agent of agents) {
        expect(outcomes.filter(outcome => outcome.toolUseId === agent.id)).toHaveLength(1);
        expect(outcomes.find(outcome => outcome.toolUseId === agent.id)).toMatchObject(mode === 'error'
          ? { status: 'error', summary: expect.stringContaining('Synthetic child model failure') }
          : { status: 'success', summary: expect.stringContaining('SDK_PHASE6_SUMMARY_') });
      }
      if (mode === 'nested') {
        const root = agents.find(agent => !agent.parentAgentId)!;
        expect(agents.find(agent => agent.parentAgentId)?.parentAgentId).toBe(root.id);
        expect(frames.some(frame => frame.type === 'tool_activity' && !frame.isAgent && frame.parentAgentId === root.id)).toBe(true);
      }
      const measuredCalls = requests.length - (mode === 'error' ? 1 : 0);
      expect(totalUsage(frames)).toMatchObject({
        inputTokens: measuredCalls * 80, outputTokens: measuredCalls * 30, cacheReadTokens: measuredCalls * 40, cacheWriteTokens: 0, credits: 0, costUsd: 0, costSource: 'none',
      });
      const session = frames.find(frame => frame.type === 'external_session');
      if (session?.type !== 'external_session') throw new Error('Missing native session ID');
      scenario = 'text';
      const resumed = await collectConversation(adapter.sendMessage('SDK_PHASE6_COLD_RESUME', conversationOptions({ isNewSession: false, externalSessionId: session.sessionId })).stream);
      expect(resumed.some(frame => frame.type === 'error' || (frame.type === 'tool_activity' && frame.isAgent))).toBe(false);
      expect(totalUsage(resumed)).toMatchObject({ inputTokens: 80, outputTokens: 30, cacheReadTokens: 40 });
    } finally { await adapter.shutdown(); }
  }, 60000);

  test('Stop terminates a delegated tool worker and cold resume does not replay its interrupted work', async () => {
    await runtime!.stop(); runtime = undefined;
    const adapter = new CopilotAdapter({ workingDir: dir });
    let worker = 0;
    const alive = () => { try { process.kill(worker, 0); return true; } catch { return false; } };
    try {
      scenario = 'delegation'; delegationMode = 'cancel';
      const active = adapter.sendMessage('SDK_PHASE6_CANCEL_PARENT', conversationOptions());
      const pending = collectConversation(active.stream);
      await waitForCopilotPeer(() => fs.existsSync(path.join(dir, 'worker.pid')));
      worker = Number(fs.readFileSync(path.join(dir, 'worker.pid'), 'utf8'));
      active.abort();
      const frames = await pending;
      const agent = frames.find(frame => frame.type === 'tool_activity' && frame.isAgent);
      expect(agent).toBeDefined();
      expect(frames.filter(frame => frame.type === 'tool_outcomes').flatMap(frame => frame.outcomes)).toContainEqual(expect.objectContaining({ toolUseId: agent?.type === 'tool_activity' ? agent.id : '', outcome: 'cancelled' }));
      await waitForCopilotPeer(() => !alive());
      const session = frames.find(frame => frame.type === 'external_session');
      if (session?.type !== 'external_session') throw new Error('Missing native session ID');
      scenario = 'text';
      const resumed = await collectConversation(adapter.sendMessage('SDK_AFTER_DELEGATE_STOP', conversationOptions({ isNewSession: false, externalSessionId: session.sessionId })).stream);
      expect(resumed.some(frame => frame.type === 'text' && frame.content === 'SDK_TEXT_OK')).toBe(true);
      expect(Number(fs.readFileSync(path.join(dir, 'worker.pid'), 'utf8'))).toBe(worker);
      expect(fs.existsSync(path.join(dir, 'worker-finished'))).toBe(false);
    } finally { await adapter.shutdown(); if (worker && alive()) process.kill(worker, 'SIGKILL'); }
  }, 60000);

  test('production questions retain distinct identities, reject duplicate answers, and accept freeform', async () => {
    await runtime!.stop(); runtime = undefined;
    const adapter = new CopilotAdapter({ workingDir: dir });
    try {
      scenario = 'questions';
      const active = adapter.sendMessage('SDK_REPEATED_QUESTIONS', conversationOptions());
      const pending = collectConversation(active.stream);
      const questions = () => events.filter(event => event.type === 'tool_activity' && event.inputRequestId);
      await waitForCopilotPeer(() => questions().length === 1);
      const first = String(questions()[0].inputRequestId);
      expect(await active.deliverInput!({ text: 'Beta', requestId: first })).toEqual({ accepted: true });
      await waitForCopilotPeer(() => questions().length === 2);
      const second = String(questions()[1].inputRequestId);
      expect(second).not.toBe(first);
      expect(await active.deliverInput!({ text: 'Alpha', requestId: first })).toMatchObject({ accepted: false, status: 409 });
      expect(await active.deliverInput!({ text: 'SDK_FREEFORM', requestId: second })).toEqual({ accepted: true });
      const frames = await pending;
      expect(frames.some(frame => frame.type === 'error')).toBe(false);
      expect(frames.some(frame => frame.type === 'text' && frame.content.includes('SDK_FREEFORM'))).toBe(true);
      expect(requests).toHaveLength(3);
    } finally { await adapter.shutdown(); }
  }, 60000);

  test.each([false, true])('production steering confirms consumption or withdraws the late message (final boundary: %s)', async finalBoundary => {
    await runtime!.stop(); runtime = undefined;
    const adapter = new CopilotAdapter({ workingDir: dir });
    try {
      scenario = 'steer'; finalBeforeSteer = finalBoundary;
      const active = adapter.sendMessage('SDK_INITIAL', conversationOptions());
      const pending = collectConversation(active.stream);
      const turn = () => events.find(event => event.type === 'input_ready' && event.turnId);
      await waitForCopilotPeer(() => !!turn() && !!releaseSteer);
      const delivery = active.deliverInput!({ text: 'SDK_CORRECTION', turnId: String(turn()!.turnId), inputId: 'native-correction' });
      // Hold the fixture response while the native immediate RPC is admitted.
      await new Promise(resolve => setTimeout(resolve, 150));
      releaseSteer!();
      expect(await delivery).toMatchObject(finalBoundary ? { accepted: false, status: 409 } : { accepted: true });
      const frames = await pending;
      expect(frames.some(frame => frame.type === 'error')).toBe(false);
      const replies = frames.filter(frame => frame.type === 'text');
      expect(replies.length).toBeGreaterThan(0);
      expect(replies.every(frame => frame.content === (finalBoundary ? 'SDK_FINISHED_BEFORE_CORRECTION' : 'SDK_STEER_OK'))).toBe(true);
      if (finalBoundary) expect(replies).toHaveLength(1);
      if (finalBoundary) expect(requests).toHaveLength(1);
      const session = frames.find(frame => frame.type === 'external_session');
      if (session?.type !== 'external_session') throw new Error('Missing session ID');
      if (!finalBoundary) {
        // Native shell background completion can add a valid parent reply.
        // Prove one correction delivery instead of assuming one model response.
        const history = fs.readFileSync(path.join(dir, 'home', 'session-state', session.sessionId, 'events.jsonl'), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line));
        const deliveries = history.filter(event => event.type === 'user.message' && event.data?.delivery === 'steering' && event.data?.content === 'SDK_CORRECTION');
        expect(deliveries).toHaveLength(1);
        events.push({ source: 'native-history', correctionDeliveries: deliveries });
      }
      scenario = 'text';
      const resumed = await collectConversation(adapter.sendMessage('SDK_AFTER_CORRECTION', conversationOptions({ isNewSession: false, externalSessionId: session.sessionId })).stream);
      expect(resumed.some(frame => frame.type === 'error')).toBe(false);
      expect(resumed.filter(frame => frame.type === 'text').map(frame => frame.content).join('')).toBe('SDK_TEXT_OK');
      if (finalBoundary) {
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('SDK_CORRECTION');
      }
    } finally { await adapter.shutdown(); }
  }, 60000);

  test.each([300, 61000])('production steering during a running foreground tool survives a warmed session and cold resume (completion delay: %s ms)', async completionDelay => {
    await runtime!.stop(); runtime = undefined;
    const adapter = new CopilotAdapter({ workingDir: dir });
    try {
      scenario = 'steer-tool';
      const warmup = await collectConversation(adapter.sendMessage('SDK_TOOL_WARMUP', conversationOptions()).stream);
      expect(warmup.some(frame => frame.type === 'error')).toBe(false);
      expect(warmup.some(frame => frame.type === 'text' && frame.content === 'SDK_WARMUP_OK')).toBe(true);
      const session = warmup.find(frame => frame.type === 'external_session');
      if (session?.type !== 'external_session') throw new Error('Missing warmed session ID');
      const options = conversationOptions({ isNewSession: false, externalSessionId: session.sessionId });
      const frames: StreamEvent[] = [];
      const active = adapter.sendMessage('SDK_TOOL_INITIAL: after the current command finishes reply ORIGINAL, without another command.', options);
      const pending = (async () => { for await (const frame of active.stream) { frames.push(frame); events.push({ source: 'cockpit', ...frame }); } })();
      const turn = () => frames.find(frame => frame.type === 'input_ready');
      await waitForCopilotPeer(() => fs.existsSync(path.join(dir, 'steer-worker.pid')) && !!turn());
      expect(frames.some(frame => frame.type === 'done')).toBe(false);
      const ready = turn();
      if (ready?.type !== 'input_ready') throw new Error('Missing running turn ID');
      const delivery = active.deliverInput!({ text: 'Correction: after the current command finishes reply SDK_RUNNING_CORRECTION instead. Do not start another command.', turnId: ready.turnId!, inputId: 'running-tool-correction' });
      // The worker is really running while the immediate RPC is admitted; it
      // cannot finish or produce another model response before this release.
      await new Promise(resolve => setTimeout(resolve, completionDelay));
      await fs.promises.writeFile(path.join(dir, 'steer-worker-release'), 'finish');
      expect(await delivery).toMatchObject({ accepted: true });
      await pending;
      expect(frames.some(frame => frame.type === 'error')).toBe(false);
      const replies = frames.filter(frame => frame.type === 'text');
      expect(replies.length).toBeGreaterThan(0);
      expect(replies.every(frame => frame.content === 'SDK_RUNNING_STEER_OK')).toBe(true);
      const history = () => fs.readFileSync(path.join(dir, 'home', 'session-state', session.sessionId, 'events.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      const beforeResume = history();
      const commands = (history: Array<{ type: string; data: { toolName?: string } }>) => history.filter(event => event.type === 'tool.execution_start' && ['bash', 'powershell'].includes(event.data.toolName || ''));
      // Immediate steering can background a native foreground command; its
      // automatic read/completion may add a reply, but must not start a command.
      expect(commands(beforeResume)).toHaveLength(2);
      expect(beforeResume.filter(event => event.type === 'user.message' && event.data?.delivery === 'steering' && event.data?.content.includes('SDK_RUNNING_CORRECTION'))).toHaveLength(1);
      scenario = 'text';
      const resumed = await collectConversation(adapter.sendMessage('SDK_AFTER_RUNNING_STEER', options).stream);
      expect(resumed.some(frame => frame.type === 'error')).toBe(false);
      expect(resumed.filter(frame => frame.type === 'text').map(frame => frame.content).join('')).toBe('SDK_TEXT_OK');
      expect(history().filter(event => event.type === 'user.message' && event.data?.delivery === 'steering')).toHaveLength(1);
      expect(commands(history())).toHaveLength(2);
      events.push({ source: 'native-history', history: history() });
    } finally { await adapter.shutdown(); }
  }, 120000);

  test.each(['question', 'steer'] as const)('Stop releases pending %s input and cold resume never replays it', async kind => {
    await runtime!.stop(); runtime = undefined;
    const adapter = new CopilotAdapter({ workingDir: dir });
    try {
      scenario = kind;
      const active = adapter.sendMessage('SDK_PENDING_INPUT', conversationOptions());
      const pending = collectConversation(active.stream);
      await waitForCopilotPeer(() => kind === 'question'
        ? events.some(event => event.type === 'tool_activity' && event.inputRequestId)
        : !!releaseSteer && events.some(event => event.type === 'input_ready' && event.turnId));
      const sessionId = String(events.find(event => event.type === 'external_session')!.sessionId);
      const questionId = String(events.find(event => event.inputRequestId)?.inputRequestId);
      const delivery = kind === 'steer' ? active.deliverInput!({ text: 'SDK_MUST_NOT_REPLAY', inputId: 'cancelled-input',
        turnId: String(events.find(event => event.type === 'input_ready' && event.turnId)!.turnId) }) : undefined;
      active.abort();
      if (delivery) expect(await delivery).toMatchObject({ accepted: false, status: 409 });
      expect((await pending).some(frame => frame.type === 'error' && frame.source === 'abort')).toBe(true);
      expect(await active.deliverInput!({ text: 'stale answer', requestId: questionId })).toMatchObject({ accepted: false, status: 409 });
      releaseSteer?.();
      scenario = 'text';
      const resumed = await collectConversation(adapter.sendMessage('SDK_AFTER_INPUT_STOP', conversationOptions({ isNewSession: false, externalSessionId: sessionId })).stream);
      expect(resumed.some(frame => frame.type === 'error')).toBe(false);
      expect(resumed.some(frame => frame.type === 'text' && frame.content === 'SDK_TEXT_OK')).toBe(true);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('SDK_MUST_NOT_REPLAY');
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
