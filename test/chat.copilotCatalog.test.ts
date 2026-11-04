import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { MockBackendAdapter } from './helpers/mockBackendAdapter';
import type { BackendMetadata } from '../src/types';

class CopilotCatalogBackend extends MockBackendAdapter {
  get metadata(): BackendMetadata {
    return { ...super.metadata, id: 'copilot', label: 'Copilot', models: [], modelCatalog: { source: 'fallback' } };
  }
  async getMetadata(): Promise<BackendMetadata> {
    return { ...this.metadata, modelCatalog: { source: 'runtime' }, models: [
      { id: 'auto', label: 'Auto', family: 'auto', default: true },
      { id: 'account-model', label: 'Account model', family: 'account', supportedEffortLevels: ['low', 'max'], capabilities: { input: { image: true, pdf: true } } },
      { id: 'text-model', label: 'Text model', family: 'text' },
    ] };
  }
}

describe('Copilot catalog HTTP admission', () => {
  let env: ChatRouterEnv;
  let adapter: CopilotCatalogBackend;
  beforeEach(async () => {
    env = await createChatRouterEnv();
    adapter = new CopilotCatalogBackend();
    adapter.setMockEvents([{ type: 'done' }]);
    env.backendRegistry.register(adapter);
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, cliProfiles: [...(settings.cliProfiles || []),
      { id: 'catalog-profile', name: 'Copilot', harness: 'copilot', authMode: 'server-configured', createdAt: '', updatedAt: '' }],
    });
  });
  afterEach(async () => { await destroyChatRouterEnv(env); });
  const create = async (model: string, effort?: string) => {
    const response = await env.request('POST', '/api/chat/conversations', { title: 'Catalog', cliProfileId: 'catalog-profile', model, effort });
    expect(response.status).toBe(200);
    return response.body;
  };

  test.each([
    ['retired-model', 'max', 'unavailable'],
    ['account-model', 'high', 'does not support effort'],
  ])('rejects %s/%s with an actionable 400 before persisting a user message or starting tools', async (model, effort, error) => {
    const conv = await create(model, effort);
    const response = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content: 'must not execute' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(error);
    expect(adapter._lastMessage).toBeNull();
    const saved = await env.chatService.getConversation(conv.id);
    expect(saved?.messages).toEqual([]);
    expect(saved?.model).toBe(model);
    expect(saved?.effort).toBe(effort);
    expect(env.activeStreams.has(conv.id)).toBe(false);
  });

  test('preserves effort for a discovered model outside the server fallback and sends the exact selection', async () => {
    const conv = await create('account-model', 'max');
    expect(conv.effort).toBe('max');
    const response = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content: 'valid selection', effort: 'low' });
    expect(response.status).toBe(200);
    expect(adapter._lastOptions).toMatchObject({ model: 'account-model', effort: 'low', cliProfile: { id: 'catalog-profile' } });
  });

  test.each(['auto', 'text-model'])('refuses %s media before persistence or inference, and accepts a corrected selection', async model => {
    const conv = await create(model);
    const content = 'Please inspect.\n\n[Uploaded files: /tmp/upload.png]';
    const response = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('verified image input');
    expect(adapter._lastMessage).toBeNull();
    expect((await env.chatService.getConversation(conv.id))?.messages).toEqual([]);
    const retry = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content, model: 'account-model' });
    expect(retry.status).toBe(200);
    expect(adapter._lastMessage).toContain(content);
  });

  test('an explicit effort clear removes the previous value when the new model has no effort control', async () => {
    const conv = await create('account-model', 'max');
    const response = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content: 'clear effort', model: 'text-model', effort: null });
    expect(response.status).toBe(200);
    expect(adapter._lastOptions?.model).toBe('text-model');
    expect(adapter._lastOptions?.effort).toBeUndefined();
    expect((await env.chatService.getConversation(conv.id))?.effort).toBeUndefined();
  });

  test('rejects an explicit unsupported effort even when no model was saved', async () => {
    const conv = await create('', 'max');
    const response = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content: 'invalid automatic effort', effort: 'high' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('does not support effort');
    expect(adapter._lastMessage).toBeNull();
  });
});
