import path from 'path';
import fs from 'fs';
import { CopilotAdapter } from '../src/services/backends/copilot';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { writeCopilotSdkPeer, waitForCopilotPeer } from './helpers/copilotSdkPeer';

describe('Copilot goals through production routes', () => {
  let env: ChatRouterEnv;
  let peer: ReturnType<typeof writeCopilotSdkPeer>;
  let adapter: CopilotAdapter;
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(async () => {
    env = await createChatRouterEnv();
    savedEnv = { ...process.env };
    process.env.COPILOT_HOME = path.join(env.tmpDir, 'home');
    process.env.COPILOT_PROVIDER_BASE_URL = 'http://127.0.0.1:1';
    peer = writeCopilotSdkPeer(env.tmpDir); adapter = new CopilotAdapter();
    env.backendRegistry.register(adapter);
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, cliProfiles: [...settings.cliProfiles!,
      peer.profile({ COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:1' }),
      { ...peer.profile(), id: 'opaque', command: 'opaque-launcher --fixed' },
    ] });
  });
  afterEach(async () => {
    await adapter.shutdown(); await destroyChatRouterEnv(env);
    for (const key of ['COPILOT_HOME', 'COPILOT_PROVIDER_BASE_URL']) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
  });
  const create = () => env.chatService.createConversation('Copilot goal', env.tmpDir, 'copilot', undefined, undefined, 'sdk-peer');

  test('selected profile enables goals and completion cards survive repeated status reads', async () => {
    const conv = await create();
    const ws = await env.connectWs(conv.id); const reading = env.readWsEvents(ws);
    const set = await env.request('POST', `/api/chat/conversations/${conv.id}/goal`, { objective: 'Route objective', aiCreditLimit: 2 });
    expect(adapter.metadata.capabilities.goals).toBe(false);
    expect(set.status).toBe(200);
    expect(set.body.goal).toMatchObject({ backend: 'copilot', supportedActions: { clear: false, resume: true } });
    expect((await reading).some(frame => frame.type === 'goal_updated' && frame.goal.status === 'complete')).toBe(true);
    for (let i = 0; i < 2; i++) {
      expect((await env.request('GET', `/api/chat/conversations/${conv.id}/goal`)).body.goal).toMatchObject({ backend: 'copilot', status: 'complete', aiCreditLimit: 2 });
    }
    const saved = await env.chatService.getConversation(conv.id);
    expect(saved?.messages.filter(message => message.goalEvent?.kind === 'achieved')).toHaveLength(1);
    expect(saved?.messages.some(message => message.role === 'user')).toBe(false);
    const clear = await env.request('DELETE', `/api/chat/conversations/${conv.id}/goal`);
    expect(clear.status).toBe(400);
    expect(clear.body.error).toContain('clear is not supported');
  }, 20000);

  test('pause preserves history; resume requires an explicit fresh credit window before admission', async () => {
    const conv = await create();
    const ws = await env.connectWs(conv.id); const reading = env.readWsEvents(ws);
    expect((await env.request('POST', `/api/chat/conversations/${conv.id}/goal`, { objective: 'DEFERRED route goal' })).status).toBe(200);
    await waitForCopilotPeer(() => peer.calls().some(call => call.method === 'session.send'));
    const paused = await env.request('POST', `/api/chat/conversations/${conv.id}/goal/pause`, {});
    expect(paused.body.goal).toMatchObject({ backend: 'copilot', objective: 'DEFERRED route goal', status: 'paused' });
    await reading;
    const before = peer.calls().length;
    for (const aiCreditLimit of [undefined, 0, '5', -1]) {
      const rejected = await env.request('POST', `/api/chat/conversations/${conv.id}/goal/resume`, { aiCreditLimit });
      expect(rejected.status).toBe(400); expect(rejected.body.error).toContain('fresh AI credit limit');
    }
    expect(peer.calls()).toHaveLength(before);
    // Release the peer's deferred work in the new runtime, then resume.
    fs.writeFileSync(path.join(env.tmpDir, 'release'), 'finish');
    const resumedWs = await env.connectWs(conv.id); const resumedReading = env.readWsEvents(resumedWs);
    const resumed = await env.request('POST', `/api/chat/conversations/${conv.id}/goal/resume`, { aiCreditLimit: 3.5 });
    expect(resumed.status).toBe(200);
    expect(resumed.body.goal).toMatchObject({ status: 'active', aiCreditLimit: 3.5 });
    expect((await resumedReading).some(frame => frame.type === 'goal_updated' && frame.goal.status === 'complete')).toBe(true);
    expect(peer.calls().filter(call => call.method === 'session.commands.invoke').at(-1)?.params?.input).toBe('--max-ai-credits 3.5');
  }, 20000);

  test('opaque profiles cannot start or read SDK goals', async () => {
    delete process.env.COPILOT_PROVIDER_BASE_URL;
    const conv = await env.chatService.createConversation('Opaque', env.tmpDir, 'copilot', undefined, undefined, 'opaque');
    expect((await env.request('POST', `/api/chat/conversations/${conv.id}/goal`, { objective: 'work' })).status).toBe(400);
    expect((await env.request('GET', `/api/chat/conversations/${conv.id}/goal`)).status).toBe(400);
    expect(peer.calls()).toEqual([]);
  });

  test('rejects invalid controls and empty objectives before native work or job admission', async () => {
    const conv = await create();
    for (const body of [
      { objective: 'work', claudeCodeMode: 'invalid' },
      { objective: 'work', serviceTier: 'invalid' },
      { objective: 'work', aiCreditLimit: '2' },
      { objective: '  ' },
      { objective: 'Goal set: ' },
    ]) {
      expect((await env.request('POST', `/api/chat/conversations/${conv.id}/goal`, body)).status).toBe(400);
    }
    expect(peer.calls()).toEqual([]);
    expect(await env.streamJobs.listActive()).toEqual([]);
    expect((await env.chatService.getConversation(conv.id))?.messages).toEqual([]);
  });

  test('a rejected profile change releases admission and preserves a locked session', async () => {
    const conv = await create();
    await env.chatService.addMessage(conv.id, 'user', 'Keep this discussion', 'copilot');
    const rejected = await env.request('POST', `/api/chat/conversations/${conv.id}/goal`, { objective: 'work', cliProfileId: 'opaque' });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toContain('Cannot switch CLI profile');
    expect((await env.chatService.getConversation(conv.id))?.cliProfileId).toBe('sdk-peer');
    expect(peer.calls()).toEqual([]);
    expect(await env.streamJobs.listActive()).toEqual([]);

    const socket = await env.connectWs(conv.id); const reading = env.readWsEvents(socket);
    expect((await env.request('POST', `/api/chat/conversations/${conv.id}/goal`, { objective: 'Continue the discussion' })).status).toBe(200);
    await reading;
    expect((await env.chatService.getConversation(conv.id))?.messages.some(message => message.content === 'Keep this discussion')).toBe(true);
  }, 20000);

  test('repairs a deleted profile with history and forwards selected model and effort to the goal', async () => {
    const conv = await env.chatService.createConversation('Repair goal', env.tmpDir, 'copilot', undefined, undefined, 'opaque');
    await env.chatService.addMessage(conv.id, 'user', 'Retain the earlier discussion', 'copilot');
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, cliProfiles: settings.cliProfiles!.filter(profile => profile.id !== 'opaque') });
    for (const [method, suffix] of [['GET', ''], ['POST', '/pause'], ['POST', '/resume'], ['DELETE', '']]) {
      const rejected = await env.request(method, `/api/chat/conversations/${conv.id}/goal${suffix}`, method === 'POST' ? {} : undefined);
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toContain('CLI profile');
    }
    expect((await env.request('POST', `/api/chat/conversations/${conv.id}/goal`, { objective: 'Repair', cliProfileId: 'missing' })).status).toBe(400);
    expect(await env.streamJobs.listActive()).toEqual([]);
    expect(peer.calls()).toEqual([]);

    const socket = await env.connectWs(conv.id); const reading = env.readWsEvents(socket);
    const response = await env.request('POST', `/api/chat/conversations/${conv.id}/goal`, {
      objective: 'Continue after repair', cliProfileId: 'sdk-peer', backend: 'copilot', model: 'gpt-6.1-sol', effort: 'high',
    });
    expect(response.status).toBe(200);
    await reading;
    expect(await env.chatService.getConversation(conv.id)).toMatchObject({ cliProfileId: 'sdk-peer', model: 'gpt-6.1-sol', effort: 'high' });
    expect(peer.calls().find(call => call.method === 'session.create')?.params).toMatchObject({ model: 'gpt-6.1-sol', reasoningEffort: 'high' });
    expect((await env.chatService.getConversation(conv.id))?.messages.some(message => message.content === 'Retain the earlier discussion')).toBe(true);
  }, 20000);

  test('starting a replacement goal recovers missing native history from the saved discussion once', async () => {
    const conv = await create();
    await env.chatService.addMessage(conv.id, 'user', 'Remember the earlier acceptance criteria', 'copilot');
    await env.chatService.setExternalSessionId(conv.id, 'missing-goal-session');
    const socket = await env.connectWs(conv.id); const reading = env.readWsEvents(socket);
    expect((await env.request('POST', `/api/chat/conversations/${conv.id}/goal`, { objective: 'Finish the replacement goal' })).status).toBe(200);
    const frames = await reading;
    expect(frames.filter(frame => frame.type === 'assistant_message' && frame.message.sessionRecovery)).toHaveLength(1);
    expect(peer.calls().filter(call => call.method === 'session.resume')).toHaveLength(1);
    expect(peer.calls().filter(call => call.method === 'session.create')).toHaveLength(1);
    const snapshot = (await env.chatService.getConversation(conv.id))?.messages.find(message => message.sessionRecovery)?.sessionRecovery;
    expect(snapshot).toMatchObject({ previousNativeSessionId: 'missing-goal-session', backend: 'copilot' });
    const saved = JSON.parse(fs.readFileSync(snapshot!.snapshotPath!, 'utf8'));
    expect(saved.messages.some((message: { content: string }) => message.content === 'Remember the earlier acceptance criteria')).toBe(true);
    const submissions = peer.calls().filter(call => call.method === 'session.send');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].params?.prompt).toContain(snapshot!.snapshotPath);
  }, 20000);
});
