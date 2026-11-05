import path from 'path';
import fs from 'fs';
import type { ContentBlock } from '../src/types';
import { CopilotAdapter } from '../src/services/backends/copilot';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { writeCopilotSdkPeer, waitForCopilotPeer } from './helpers/copilotSdkPeer';
import { copilotPng, copilotPdf } from './helpers/copilotMediaFixtures';

describe('Copilot SDK artifacts through production chat storage', () => {
  let env: ChatRouterEnv;
  let adapter: CopilotAdapter;
  let savedEnv: NodeJS.ProcessEnv;
  const keys = ['COPILOT_HOME', 'COPILOT_PROVIDER_BASE_URL', 'COPILOT_FIXTURE_ARTIFACTS', 'COPILOT_MODEL'];
  beforeEach(async () => {
    env = await createChatRouterEnv(); savedEnv = { ...process.env };
    process.env.COPILOT_HOME = path.join(env.tmpDir, 'home');
    process.env.COPILOT_PROVIDER_BASE_URL = 'http://127.0.0.1:1';
    process.env.COPILOT_FIXTURE_ARTIFACTS = '1'; process.env.COPILOT_MODEL = '';
    const peer = writeCopilotSdkPeer(env.tmpDir); adapter = new CopilotAdapter(); env.backendRegistry.register(adapter);
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, cliProfiles: [...settings.cliProfiles!, peer.profile()] });
  });
  afterEach(async () => {
    await adapter.shutdown(); await destroyChatRouterEnv(env);
    for (const key of keys) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  });

  test.each([false, true])('stores native output once across %s cancellation and conversation reload', async stop => {
    const conv = await env.chatService.createConversation('Media output', env.tmpDir, 'copilot', 'gpt-6.1-sol', undefined, 'sdk-peer');
    await env.chatService.renameConversation(conv.id, conv.title);
    const ws = await env.connectWs(conv.id); const reading = env.readWsEvents(ws);
    const sent = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content: stop ? 'DEFERRED' : 'Media outputs' });
    expect(sent.status).toBe(200);
    if (stop) {
      await waitForCopilotPeer(() => fs.existsSync(path.join(env.chatService.artifactsDir, conv.id, 'report.pdf')));
      expect((await env.request('POST', `/api/chat/conversations/${conv.id}/abort`, {})).status).toBe(200);
    }
    const frames = await reading;
    expect(frames.filter(frame => frame.type === 'artifact')).toHaveLength(2);
    const loaded = await env.request('GET', `/api/chat/conversations/${conv.id}`);
    const blocks: ContentBlock[] = loaded.body.messages.flatMap((message: { contentBlocks?: ContentBlock[] }) => message.contentBlocks || []);
    const artifacts = blocks.flatMap(block => block.type === 'artifact' ? [block.artifact] : []);
    expect(artifacts).toHaveLength(2);
    for (const artifact of artifacts) {
      expect(artifact.sourceToolId).toMatch(/^copilot:/);
      expect(fs.readFileSync(artifact.path)).toEqual(artifact.kind === 'image' ? copilotPng : copilotPdf());
    }
    expect(fs.readdirSync(path.join(env.chatService.artifactsDir, conv.id)).sort()).toEqual(artifacts.map(artifact => artifact.filename).sort());
    const reloaded = await env.request('GET', `/api/chat/conversations/${conv.id}`);
    expect(reloaded.body.messages).toEqual(loaded.body.messages);
  }, 20000);
});
