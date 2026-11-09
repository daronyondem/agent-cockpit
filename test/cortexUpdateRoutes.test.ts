import { createChatRouterEnv, destroyChatRouterEnv } from './helpers/chatEnv';
import { CortexCodeAdapter } from '../src/services/backends/cortex';

describe('CLI update route Cortex cleanup', () => {
  test.each([true, false])('awaits CoCo runtime draining before returning success=%s', async success => {
    const updater = { stop: jest.fn(), triggerUpdate: jest.fn(async (_id, options) => {
      await options.onUpdated(); return { success, steps: [], ...(success ? {} : { error: 'Native update failed' }) };
    }) };
    const env = await createChatRouterEnv({ cliUpdateService: updater });
    const adapter = new CortexCodeAdapter(); env.backendRegistry.register(adapter);
    let release!: () => void, delivered = false;
    const shutdown = jest.spyOn(adapter, 'shutdown').mockImplementation(() => {
      adapter.stopping = new Promise(resolve => { release = resolve; });
      return adapter.stopping;
    });
    try {
      const pending = env.request('POST', '/api/chat/cli-updates/cortex-code%3Afixture/update', {}).then(response => { delivered = true; return response; });
      for (let attempt = 0; attempt < 400 && !release; attempt++) await new Promise(done => setTimeout(done, 5));
      expect(release).toBeDefined(); expect(delivered).toBe(false);
      release(); const response = await pending;
      expect(response.status).toBe(success ? 200 : 400); expect(response.body.success).toBe(success);
    } finally {
      release?.(); shutdown.mockRestore(); await adapter.shutdown(); await destroyChatRouterEnv(env);
    }
  });
});
