/**
 * @jest-environment jsdom
 */

describe('CliUpdateStore', () => {
  function loadStore(api: Record<string, unknown>) {
    jest.resetModules();
    jest.doMock('../web/AgentCockpitWeb/src/api.js', () => ({
      AgentApi: api,
      default: api,
    }));
    return require('../web/AgentCockpitWeb/src/cliUpdateStore.js').CliUpdateStore;
  }

  test('ensureFresh forces a check when cached CLI targets have never been probed', async () => {
    const stale = {
      items: [{
        id: 'codex:abc',
        installMethod: 'unknown',
        currentVersion: null,
        latestVersion: null,
        lastCheckAt: null,
        lastError: null,
      }],
      lastCheckAt: null,
      updateInProgress: false,
    };
    const fresh = {
      items: [{
        ...stale.items[0],
        installMethod: 'npm-global',
        currentVersion: '0.130.0',
        latestVersion: '0.130.0',
        lastCheckAt: '2026-05-17T00:00:00.000Z',
      }],
      lastCheckAt: '2026-05-17T00:00:00.000Z',
      updateInProgress: false,
    };
    const api = {
      getCliUpdates: jest.fn(async () => stale),
      checkCliUpdates: jest.fn(async () => fresh),
    };
    const store = loadStore(api);
    const seen: unknown[] = [];
    store.subscribe((data: unknown) => seen.push(data));

    await expect(store.ensureFresh()).resolves.toBe(fresh);

    expect(api.getCliUpdates).toHaveBeenCalledTimes(1);
    expect(api.checkCliUpdates).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(fresh);
    expect(seen).toEqual([stale, fresh]);
  });

  test('ensureFresh does not force a check for already-probed CLI targets', async () => {
    const probed = {
      items: [{
        id: 'codex:abc',
        installMethod: 'missing',
        currentVersion: null,
        latestVersion: null,
        lastCheckAt: '2026-05-17T00:00:00.000Z',
        lastError: 'not found',
      }],
      lastCheckAt: '2026-05-17T00:00:00.000Z',
      updateInProgress: false,
    };
    const api = {
      getCliUpdates: jest.fn(async () => probed),
      checkCliUpdates: jest.fn(async () => {
        throw new Error('should not check');
      }),
    };
    const store = loadStore(api);

    await expect(store.ensureFresh()).resolves.toBe(probed);

    expect(api.getCliUpdates).toHaveBeenCalledTimes(1);
    expect(api.checkCliUpdates).not.toHaveBeenCalled();
    expect(store.get()).toBe(probed);
  });
});
