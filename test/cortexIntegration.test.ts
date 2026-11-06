import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';
import type { CliProfile } from '../src/types';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { CortexSessions } from '../src/services/backends/cortexSessions';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';

const posix = process.platform === 'win32' ? describe.skip : describe;
posix('Cortex durable Cockpit chat integration', () => {
  let env: ChatRouterEnv;
  let adapter: CortexCodeAdapter;
  let sessions: CortexSessions;
  let profile: CliProfile;
  let state: string;
  let trace: string;
  beforeEach(async () => {
    env = await createChatRouterEnv();
    const command = path.join(env.tmpDir, 'cortex');
    await fs.copyFile(path.join(__dirname, 'fixtures/cortex/chat-acp.cjs'), command); await fs.chmod(command, 0o700);
    state = path.join(env.tmpDir, 'native-state.json'); trace = path.join(env.tmpDir, 'native-trace.jsonl');
    profile = { id: 'cortex-fixture', name: 'Cortex fixture', harness: 'cortex-code', authMode: 'account', command,
      cortexCode: { connection: 'fixture' }, env: { CORTEX_FIXTURE_STATE: state, CORTEX_FIXTURE_TRACE: trace }, createdAt: '', updatedAt: '' };
    sessions = new CortexSessions(); adapter = new CortexCodeAdapter({ sessions, workingDir: env.tmpDir });
    env.backendRegistry.register(adapter);
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, cliProfiles: [...(settings.cliProfiles || []), profile] });
  });
  afterEach(async () => { adapter.shutdown(); await adapter.stopping; await destroyChatRouterEnv(env); });
  const conversation = () => env.chatService.createConversation('Cortex fixture', env.tmpDir, 'cortex-code', 'claude-sonnet-4-6', 'low', profile.id);
  async function send(id: string, content: string) {
    env.wsFns.clearBuffer(id);
    const ws = await env.connectWs(id); const reading = env.readWsEvents(ws, 10_000);
    const response = await env.request('POST', `/api/chat/conversations/${id}/message`, { content });
    expect(response.status).toBe(200);
    const events = await reading;
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    return events;
  }
  const calls = async () => (await fs.readFile(trace, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

  test('profile metadata, durable sessions, idle reload and restart retain context and apply usage once', async () => {
    const metadata = await env.request('GET', `/api/chat/cli-profiles/${profile.id}/metadata`);
    expect(metadata.body.backend.models.some((model: { id: string }) => model.id === 'claude-sonnet-4-6')).toBe(true);
    const conv = await conversation();
    const first = await send(conv.id, 'fixture-remember:MAPLE_314');
    expect(first.filter(event => event.type === 'usage')).toHaveLength(1);
    const nativeId = (await env.chatService.getConversation(conv.id))!.externalSessionId;
    expect(nativeId).toBeTruthy();
    await sessions.evictIdle(0);
    await send(conv.id, 'fixture-recall');
    adapter.shutdown(); await adapter.stopping;
    const third = await send(conv.id, 'fixture-recall');
    expect(third.filter(event => event.type === 'assistant_message').map(event => event.message.content)).toContain('MAPLE_314');
    const saved = (await env.chatService.getConversation(conv.id))!;
    expect(saved.externalSessionId).toBe(nativeId);
    expect(saved.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['ANSWER', 'MAPLE_314', 'MAPLE_314']);
    expect(saved.usage?.inputTokens).toBe(30);
    expect((await calls()).filter(call => call.method === 'session/prompt')).toHaveLength(3);
    expect((await env.request('GET', '/api/chat/active-streams')).body.ids).not.toContain(conv.id);
  });

  test('question replies retain their decision generation across reconnect and reject duplicates', async () => {
    const conv = await conversation();
    const ws = await env.connectWs(conv.id);
    const question = new Promise<string>(resolve => ws.on('message', data => {
      const event = JSON.parse(String(data)); if (event.type === 'tool_activity' && event.isQuestion) resolve(event.id);
    }));
    expect((await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content: 'fixture-question' })).status).toBe(200);
    const decisionId = await question; ws.close();
    const reconnected = await env.connectWs(conv.id); const reading = env.readWsEvents(reconnected, 10_000);
    const input = (id?: string) => env.request('POST', `/api/chat/conversations/${conv.id}/input`, { text: 'Blue', streamActive: true, decisionId: id });
    expect((await input('cortex-decision:stale')).status).toBe(409);
    expect((await input()).status).toBe(409);
    expect((await input(decisionId)).status).toBe(200);
    const events = await reading;
    expect(events.some(event => event.type === 'assistant_message' && event.message.content === 'CHOICE_blue')).toBe(true);
    expect((await input(decisionId)).status).toBe(409);
    expect((await env.chatService.getConversation(conv.id))!.messages.filter(message => message.role === 'user')).toHaveLength(1);
    env.wsFns.clearBuffer(conv.id);
    const next = await env.connectWs(conv.id); const nextEvents = env.readWsEvents(next, 10_000);
    next.on('message', data => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'tool_activity' && frame.isQuestion) next.send(JSON.stringify({ type: 'input', text: 'Green', decisionId: frame.id }));
    });
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content: 'fixture-question' });
    expect((await nextEvents).some(event => event.type === 'assistant_message' && event.message.content === 'CHOICE_green')).toBe(true);
  });

  test('missing native session creates a persisted recovery snapshot and sends only the current request', async () => {
    const conv = await conversation(); await send(conv.id, 'fixture-remember:ORIGINAL');
    await sessions.evictIdle(0); await fs.writeFile(state, '{}');
    await send(conv.id, 'current request');
    const saved = (await env.chatService.getConversation(conv.id))!;
    const recovery = saved.messages.find(message => message.sessionRecovery);
    expect(recovery?.sessionRecovery?.snapshotPath).toBeTruthy();
    const snapshot = await fs.readFile(recovery!.sessionRecovery!.snapshotPath!, 'utf8');
    expect(snapshot).toContain('fixture-remember:ORIGINAL'); expect(snapshot).not.toContain('current request');
    const prompts = (await calls()).filter(call => call.method === 'session/prompt');
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain(recovery!.sessionRecovery!.snapshotPath);
    expect(JSON.stringify(prompts[1])).not.toContain('fixture-remember:ORIGINAL');
  });

  test('abort, queue, reset, archive/delete and profile switches retain existing conversation rules', async () => {
    const conv = await conversation();
    await env.request('PUT', `/api/chat/conversations/${conv.id}/queue`, { queue: [{ content: 'queued' }] });
    expect((await env.request('GET', `/api/chat/conversations/${conv.id}/queue`)).body.queue).toHaveLength(1);
    const ws = await env.connectWs(conv.id); const reading = env.readWsEvents(ws, 10_000);
    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content: 'fixture-wait' });
    // Wait until native prompt submission, so this exercises native cancellation.
    for (let i = 0; i < 100 && !(await calls()).some(call => call.method === 'session/prompt'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect((await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content: 'overlap' })).status).toBe(409);
    expect((await env.request('POST', `/api/chat/conversations/${conv.id}/abort`, {})).body.aborted).toBe(true);
    expect((await reading).filter(event => event.type === 'done')).toHaveLength(1);
    expect((await calls()).filter(call => call.method === 'session/prompt')).toHaveLength(1);
    const switched = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content: 'bad switch', cliProfileId: 'server-configured-claude-code', backend: 'claude-code' });
    expect(switched.status).toBe(409);
    expect((await env.request('POST', `/api/chat/conversations/${conv.id}/reset`, {})).status).toBe(200);
    await adapter.stopping;
    await send(conv.id, 'fixture-deliver');
    const saved = (await env.chatService.getConversation(conv.id))!;
    expect(saved.messages.some(message => message.contentBlocks?.some(block => block.type === 'artifact'))).toBe(true);
    expect((await env.request('PATCH', `/api/chat/conversations/${conv.id}/archive`)).status).toBe(200);
    await adapter.stopping;
    expect((await env.request('GET', `/api/chat/conversations/${conv.id}/queue`)).body.queue).toEqual([]);
    expect((await env.request('DELETE', `/api/chat/conversations/${conv.id}`)).status).toBe(200);
    await adapter.stopping;
  });

  test('canonical workspace identity survives relocation and instruction changes refresh only the next turn', async () => {
    const original = path.join(env.tmpDir, 'original'); await fs.mkdir(original);
    const conv = await env.chatService.createConversation('Relocation', original, 'cortex-code', 'claude-sonnet-4-6', 'low', profile.id);
    await env.chatService.setWorkspaceInstructions(conv.workspaceId, 'INSTRUCTIONS_ONE');
    await env.chatService.setWorkspaceContextEnabled(conv.workspaceId, true);
    await env.workspaceContextService.ensureWorkspace(conv.workspaceId);
    expect(await fs.readFile(path.join(original, 'AGENTS.md'), 'utf8')).toContain('Workspace Context');
    await send(conv.id, 'fixture-remember:RELOCATION_NONCE');
    const before = (await env.chatService.getConversation(conv.id))!;
    await env.chatService.setWorkspaceInstructions(conv.workspaceId, 'INSTRUCTIONS_TWO');
    await send(conv.id, 'fixture-recall');
    const target = path.join(env.tmpDir, 'relocated'); await fs.rename(original, target);
    const updated = await env.request('PUT', `/api/chat/workspaces/${conv.workspaceId}/location`, { workspacePath: target });
    expect(updated.status).toBe(200);
    await send(conv.id, 'fixture-recall');
    const after = (await env.chatService.getConversation(conv.id))!;
    expect(after.workspaceId).toBe(before.workspaceId);
    expect(after.messages.filter(message => message.role === 'assistant').at(-1)?.content).toBe('RELOCATION_NONCE');
    const prompts = (await calls()).filter(call => call.method === 'session/prompt');
    expect(JSON.stringify(prompts[0])).toContain('INSTRUCTIONS_ONE');
    expect(JSON.stringify(prompts[1])).toContain('INSTRUCTIONS_TWO');
    expect(new Set(prompts.map(call => call.pid)).size).toBe(3);
    expect((await calls()).filter(call => call.method === 'session/load').at(-1).params.cwd).toBe(target);
    expect(JSON.stringify(prompts[0])).toContain('Workspace discussion history');
    expect(JSON.stringify(prompts[1])).not.toContain('Workspace discussion history');
  });

  test('CoCo writes and delivered artifacts use the conversation worktree rather than the base checkout', async () => {
    const repo = path.join(env.tmpDir, 'repo'); const remote = path.join(env.tmpDir, 'remote.git'); await fs.mkdir(repo);
    const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'Daron Yondem']);
    git(repo, ['config', 'user.email', 'daron@yondem.com']); git(repo, ['config', 'commit.gpgsign', 'false']);
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'fixture'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'Fixture initial']);
    git(env.tmpDir, ['init', '--bare', remote]); git(repo, ['remote', 'add', 'origin', remote]); git(repo, ['push', '-u', 'origin', 'main']);
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    const conv = await env.chatService.createConversation('Worktree', repo, 'cortex-code', 'claude-sonnet-4-6', 'low', profile.id);
    expect((await env.request('PUT', `/api/chat/workspaces/${conv.workspaceId}/worktree-isolation`, { enabled: true, confirmedSessionReset: true })).status).toBe(200);
    await send(conv.id, 'fixture-deliver');
    const saved = (await env.chatService.getConversation(conv.id))!;
    expect(saved.executionDir).not.toBe(repo);
    expect(await fs.readFile(path.join(saved.executionDir!, 'report.txt'), 'utf8')).toBe('FIXTURE_ARTIFACT');
    await expect(fs.access(path.join(repo, 'report.txt'))).rejects.toThrow();
    expect((await env.request('GET', `/api/chat/conversations/${conv.id}/files/report.txt?mode=download`)).status).toBe(200);
    const status = await env.request('GET', `/api/chat/conversations/${conv.id}/git/status`);
    expect(status.status).toBe(200); expect(JSON.stringify(status.body)).toContain('report.txt');
    const second = await env.chatService.createConversation('Separate runtime', repo, 'cortex-code', 'claude-sonnet-4-6', 'low', profile.id);
    await send(second.id, 'fixture-recall');
    const prompts = (await calls()).filter(call => call.method === 'session/prompt');
    expect(prompts[0].pid).not.toBe(prompts[1].pid);
    expect(prompts[0].params.sessionId).not.toBe(prompts[1].params.sessionId);
  });
});
