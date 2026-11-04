import path from 'path';
import { CopilotAdapter } from '../src/services/backends/copilot';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { writeCopilotSdkPeer } from './helpers/copilotSdkPeer';

describe('Copilot usage and quota through production routes', () => {
  let env: ChatRouterEnv;
  let adapter: CopilotAdapter;
  let saved: NodeJS.ProcessEnv;
  beforeEach(async () => {
    env = await createChatRouterEnv(); saved = { ...process.env };
    process.env.COPILOT_HOME = path.join(env.tmpDir, 'home');
    process.env.COPILOT_PROVIDER_BASE_URL = 'http://127.0.0.1:1';
    process.env.COPILOT_FIXTURE_CONTEXT = '1';
    const peer = writeCopilotSdkPeer(env.tmpDir); adapter = new CopilotAdapter();
    env.backendRegistry.register(adapter);
    jest.spyOn(env.chatService, 'generateAndUpdateTitle').mockResolvedValue('Usage');
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, cliProfiles: [...settings.cliProfiles!, peer.profile()] });
  });
  afterEach(async () => {
    await adapter.shutdown(); await destroyChatRouterEnv(env);
    for (const key of ['COPILOT_HOME', 'COPILOT_PROVIDER_BASE_URL', 'COPILOT_FIXTURE_CONTEXT']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  test('persists context and separate billing units while charging live/final usage only once', async () => {
    const conv = await env.chatService.createConversation('Usage', env.tmpDir, 'copilot', undefined, undefined, 'sdk-peer');
    const socket = await env.connectWs(conv.id); const reading = env.readWsEvents(socket);
    expect((await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content: 'usage fixture' })).status).toBe(200);
    const frames = await reading;
    expect(frames.some(frame => frame.type === 'usage' && frame.sessionUsage?.contextUsagePercentage === 25)).toBe(true);
    const saved = await env.chatService.getConversation(conv.id);
    expect(saved?.usage).toMatchObject({ inputTokens: 110, outputTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 2,
      contextUsagePercentage: 25, contextWindow: { usedTokens: 250, tokenLimit: 1000 },
      copilot: { tokensStatus: 'complete', premiumRequests: 4, aiCreditsStatus: 'unavailable' }, costSource: 'none' });
    const records = (await env.chatService.getUsageStats()).days.flatMap(day => day.records).filter(row => row.backend === 'copilot');
    expect(records).toHaveLength(1);
    expect(records[0].usage).toMatchObject({ inputTokens: 110, outputTokens: 30, copilot: { premiumRequests: 4 } });
    expect(records[0].usage).not.toHaveProperty('contextWindow');
  }, 15000);

  test('quota endpoint resolves the selected profile, rejects other harnesses and returns unavailable data explicitly', async () => {
    const quota = { status: 'unavailable' as const, fetchedAt: null, stale: false, rows: [], message: 'No native account reading.' };
    const read = jest.spyOn(adapter, 'getQuota').mockResolvedValue(quota);
    const response = await env.request('GET', '/api/chat/cli-profiles/sdk-peer/copilot-quota');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ profileId: 'sdk-peer', quota });
    expect(read).toHaveBeenCalledWith({ cliProfile: expect.objectContaining({ id: 'sdk-peer', harness: 'copilot' }) });
    const wrong = await env.request('GET', '/api/chat/cli-profiles/server-configured-codex/copilot-quota');
    expect(wrong.status).toBe(400);
    expect(read).toHaveBeenCalledTimes(1);
    expect((await env.request('GET', '/api/chat/cli-profiles/missing/copilot-quota')).status).toBe(400);
  });
});
