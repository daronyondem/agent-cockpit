/**
 * @jest-environment jsdom
 */

describe('profile-aware plan usage stores', () => {
  beforeEach(() => {
    (window as any).AgentApi = {
      getCodexPlanUsage: jest.fn(async (cliProfileId?: string | null) => ({
        profile: cliProfileId || 'default',
      })),
      getClaudePlanUsage: jest.fn(async (cliProfileId?: string | null) => ({
        profile: cliProfileId || 'default',
      })),
    };
  });

  function loadStore<T>(relPath: string, exportName: string): T {
    const api = (window as any).AgentApi;
    jest.resetModules();
    jest.doMock('../web/AgentCockpitWeb/src/api.js', () => ({
      AgentApi: api,
      default: api,
    }));
    return require(relPath)[exportName];
  }

  async function expectStoreIsProfileKeyed(
    store: any,
    fetchMock: jest.Mock,
  ) {
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];

    const unsubA = store.subscribe((data: unknown) => seenA.push(data), 'profile-a');
    const unsubB = store.subscribe((data: unknown) => seenB.push(data), 'profile-b');
    await store.refresh('profile-a');
    await store.refresh('profile-b');

    expect(fetchMock).toHaveBeenCalledWith('profile-a');
    expect(fetchMock).toHaveBeenCalledWith('profile-b');
    expect(store.get('profile-a')).toEqual({ profile: 'profile-a' });
    expect(store.get('profile-b')).toEqual({ profile: 'profile-b' });
    expect(seenA).toEqual([{ profile: 'profile-a' }]);
    expect(seenB).toEqual([{ profile: 'profile-b' }]);

    unsubA();
    unsubB();
  }

  test('Claude plan usage cache is keyed by CLI profile id', async () => {
    const store = loadStore<any>('../web/AgentCockpitWeb/src/planUsageStore.js', 'PlanUsageStore');
    await expectStoreIsProfileKeyed(
      store,
      (window as any).AgentApi.getClaudePlanUsage,
    );
  });

  test('Codex plan usage cache is keyed by CLI profile id', async () => {
    const store = loadStore<any>('../web/AgentCockpitWeb/src/codexPlanUsageStore.js', 'CodexPlanUsageStore');
    await expectStoreIsProfileKeyed(
      store,
      (window as any).AgentApi.getCodexPlanUsage,
    );
  });
});
