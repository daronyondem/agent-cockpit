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
});
