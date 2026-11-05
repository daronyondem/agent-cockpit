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

  test('Grok coalesces requests per profile and clears unavailable billing', async () => {
    const fetch = jest.fn(async (url: string) => ({ ok: true, json: async () => ({ billing: { profile: url } }) }));
    (window as any).AgentApi.fetch = fetch;
    const store = loadStore<any>('../web/AgentCockpitWeb/src/grokPlanUsageStore.js', 'GrokPlanUsageStore');
    const seen: unknown[] = [];
    const unsubscribe = store.subscribe((data: unknown) => seen.push(data), 'profile-a');
    const first = store.refresh('profile-a');
    expect(store.refresh('profile-a')).toBe(first);
    await first;
    await store.refresh('profile-b');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.get('profile-a')).toEqual({ profile: 'cli-profiles/profile-a/grok-billing' });
    expect(store.get('profile-b')).toEqual({ profile: 'cli-profiles/profile-b/grok-billing' });
    fetch.mockRejectedValueOnce(new Error('unavailable'));
    await store.refresh('profile-a');
    expect(store.get('profile-a')).toBeNull();
    expect(seen.at(-1)).toBeNull();
    expect(store.get('profile-b')).not.toBeNull();
    unsubscribe();
  });

  test('Copilot coalesces by profile and never retains another profile’s quota on failure', async () => {
    const fetch = jest.fn(async (url: string) => ({ ok: true, json: async () => ({ quota: { profile: url } }) }));
    (window as any).AgentApi.fetch = fetch;
    const store = loadStore<any>('../web/AgentCockpitWeb/src/copilotPlanUsageStore.js', 'CopilotPlanUsageStore');
    const first = store.refresh('a'); expect(store.refresh('a')).toBe(first); await first;
    await store.refresh('b');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.get('a')).toEqual({ profile: 'cli-profiles/a/copilot-quota' });
    fetch.mockRejectedValueOnce(new Error('offline'));
    await store.refresh('a');
    expect(store.get('a')).toMatchObject({ status: 'unavailable', rows: [] });
    expect(store.get('b')).toEqual({ profile: 'cli-profiles/b/copilot-quota' });
  });
});
