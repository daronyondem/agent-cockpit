/**
 * @jest-environment jsdom
 */

import fs from 'fs';
import path from 'path';

function loadScript(relPath: string) {
  const src = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
  new Function(src).call(window);
}

describe('profile-aware plan usage stores', () => {
  beforeEach(() => {
    delete (window as any).CodexPlanUsageStore;
    delete (window as any).PlanUsageStore;
    (window as any).AgentApi = {
      getCodexPlanUsage: jest.fn(async (cliProfileId?: string | null) => ({
        profile: cliProfileId || 'default',
      })),
      getClaudePlanUsage: jest.fn(async (cliProfileId?: string | null) => ({
        profile: cliProfileId || 'default',
      })),
    };
  });

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
    loadScript('public/v2/src/planUsageStore.js');
    await expectStoreIsProfileKeyed(
      (window as any).PlanUsageStore,
      (window as any).AgentApi.getClaudePlanUsage,
    );
  });

  test('Codex plan usage cache is keyed by CLI profile id', async () => {
    loadScript('public/v2/src/codexPlanUsageStore.js');
    await expectStoreIsProfileKeyed(
      (window as any).CodexPlanUsageStore,
      (window as any).AgentApi.getCodexPlanUsage,
    );
  });
});
