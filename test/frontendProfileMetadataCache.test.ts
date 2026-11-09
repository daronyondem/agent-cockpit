import type { BackendMetadata } from '../src/contracts/responses';

type Client = {
  getCliProfileMetadata(id: string): Promise<BackendMetadata>;
  settings: {
    testCliProfile(id: string): Promise<unknown>;
    getCliProfileAuthJob(id: string): Promise<unknown>;
    cancelCliProfileAuth(id: string): Promise<unknown>;
  };
};
describe('browser profile metadata cache', () => {
  let api: Client;
  let fetcher: jest.Mock;
  let originalWindow: PropertyDescriptor | undefined;
  const originalFetch = globalThis.fetch;
  const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: 'https://cockpit.test/v2/' } } });
    fetcher = jest.fn(async (url: string) => response(url.endsWith('csrf-token') ? { csrfToken: 'fixture' }
      : { backend: { id: 'copilot', label: url, models: [] } }));
    globalThis.fetch = fetcher;
    jest.isolateModules(() => { api = require('../web/AgentCockpitWeb/src/api.js').default as Client; });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    jest.restoreAllMocks();
  });
  const metadataCalls = () => fetcher.mock.calls.filter(([url]: [string]) => url.endsWith('/metadata')).length;

  test('coalesces simultaneous profile reads, retains fresh data and refreshes after expiry', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const [first, same] = await Promise.all([api.getCliProfileMetadata('a'), api.getCliProfileMetadata('a')]);
    expect(first).toEqual(same);
    await api.getCliProfileMetadata('a');
    expect(metadataCalls()).toBe(1);
    now.mockReturnValue(61001);
    await api.getCliProfileMetadata('a');
    expect(metadataCalls()).toBe(2);
    await expect(api.getCliProfileMetadata('')).rejects.toThrow('profileId is required');
  });

  test('keeps profile catalogs separate', async () => {
    const [a, b] = await Promise.all([api.getCliProfileMetadata('a'), api.getCliProfileMetadata('b')]);
    expect(a.label).toContain('/a/metadata');
    expect(b.label).toContain('/b/metadata');
    expect(metadataCalls()).toBe(2);
  });

  test('a profile test without settings invalidates cached and pending data; old replies cannot repopulate it', async () => {
    await api.getCliProfileMetadata('warm');
    let finish!: (value: unknown) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = api.getCliProfileMetadata('a');
    // chatFetch has a token and starts the metadata request immediately.
    fetcher.mockImplementationOnce(async () => response({ result: { authenticated: true } }));
    await api.settings.testCliProfile('a');
    fetcher.mockImplementationOnce(async () => response({ backend: { id: 'copilot', label: 'new account', models: [] } }));
    const latest = await api.getCliProfileMetadata('a');
    finish(response({ backend: { id: 'copilot', label: 'old account', models: [] } }));
    expect(await old).toBeNull();
    expect(latest.label).toBe('new account');
    expect((await api.getCliProfileMetadata('a')).label).toBe('new account');
    expect(metadataCalls()).toBe(3);
  });

  test('failed reads do not poison the next request', async () => {
    await api.getCliProfileMetadata('warm');
    fetcher.mockImplementationOnce(async () => response({ error: 'temporarily unavailable' }, 503));
    await expect(api.getCliProfileMetadata('a')).rejects.toThrow('temporarily unavailable');
    expect((await api.getCliProfileMetadata('a')).id).toBe('copilot');
    expect(metadataCalls()).toBe(3);
  });

  test.each([
    ['getCliProfileAuthJob', 'running', 'copilot', false],
    ['getCliProfileAuthJob', 'succeeded', 'copilot', true],
    ['getCliProfileAuthJob', 'failed', 'copilot', true],
    ['getCliProfileAuthJob', 'cancelled', 'copilot', true],
    ['getCliProfileAuthJob', 'succeeded', 'codex', false],
    ['cancelCliProfileAuth', 'cancelled', 'copilot', true],
  ] as const)('%s invalidates shared catalogs for %s/%s=%s', async (method, status, harness, invalidate) => {
    await api.getCliProfileMetadata('a');
    fetcher.mockImplementationOnce(async () => response({ job: { id: 'job', harness, status } }));
    await api.settings[method]('job');
    await api.getCliProfileMetadata('a');
    expect(metadataCalls()).toBe(invalidate ? 2 : 1);
  });

  test('a catalog reply from before shared auth completed cannot overwrite the new account result', async () => {
    await api.getCliProfileMetadata('warm');
    let finish!: (value: unknown) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = api.getCliProfileMetadata('a');
    fetcher.mockImplementationOnce(async () => response({ job: { harness: 'copilot', status: 'succeeded' } }));
    await api.settings.getCliProfileAuthJob('job');
    fetcher.mockImplementationOnce(async () => response({ backend: { id: 'copilot', label: 'new login', models: [] } }));
    await api.getCliProfileMetadata('a');
    finish(response({ backend: { id: 'copilot', label: 'old login', models: [] } })); await old;
    expect((await api.getCliProfileMetadata('a')).label).toBe('new login');
  });
});
