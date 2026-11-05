import { CopilotQuotaCache, copilotAccountQuota } from '../src/services/backends/copilotQuota';
import type { CliProfile } from '../src/types';
import type { startCopilotSdkRuntime } from '../src/services/backends/copilotSdkRuntime';
import { CopilotAdapter } from '../src/services/backends/copilot';

const snapshot = (usedRequests = 0, extra = {}) => ({ quotaSnapshots: { premium_interactions: {
  usedRequests, entitlementRequests: 100, remainingPercentage: 100 - usedRequests, isUnlimitedEntitlement: false, ...extra,
} } });
const profile = (id = 'a', env: Record<string, string> = {}): CliProfile => ({ id, name: id, harness: 'copilot', authMode: 'server-configured',
  command: 'copilot', createdAt: '', updatedAt: '', env: { COPILOT_PROVIDER_BASE_URL: '', ...env } });

test('preserves real zero, unlimited entitlement, native percentages and dates without inferring exhaustion', () => {
  expect(copilotAccountQuota(snapshot(), false, 'now')[0]).toMatchObject({ unit: 'premium_requests', used: 0, usedPercentage: 0, capacity: 'unknown' });
  const unlimited = copilotAccountQuota(snapshot(12, { entitlementRequests: -1, isUnlimitedEntitlement: true, remainingPercentage: 0 }), false, 'now')[0];
  expect(unlimited).toMatchObject({ unlimited: true, capacity: 'unlimited' });
  expect(unlimited).not.toHaveProperty('usedPercentage');
  expect(unlimited).not.toHaveProperty('entitlement');
  expect(copilotAccountQuota(snapshot(25, { resetDate: '2026-12-01T00:00:00Z' }), false, 'now')[0].resetAt).toBe('2026-12-01T00:00:00Z');
});

test('missing numeric measurements are unknown; token-based compatibility units are never guessed', () => {
  expect(copilotAccountQuota({ quotaSnapshots: { premium_interactions: { remainingPercentage: 0 } } }, false, 'now')).toEqual([]);
  expect(copilotAccountQuota(snapshot(NaN), false, 'now')).toEqual([]);
  expect(copilotAccountQuota(snapshot(1, { entitlementRequests: -1 }), false, 'now')).toEqual([]);
  expect(copilotAccountQuota(snapshot(0, { resetDate: 'bad', remainingPercentage: 1000 }), true, 'now')[0]).toMatchObject({ used: 0, unit: 'unknown' });
  expect(copilotAccountQuota(snapshot(), undefined, 'now')[0].unit).toBe('unknown');
});

describe('owned Copilot account reads', () => {
  let quota: jest.Mock;
  let stop: jest.Mock;
  let start: jest.Mock;
  let auth: jest.Mock;
  let cache: CopilotQuotaCache;
  beforeEach(() => {
    quota = jest.fn().mockResolvedValue(snapshot(25));
    stop = jest.fn().mockResolvedValue(undefined);
    auth = jest.fn().mockResolvedValue({ authInfo: { token: 'must-never-leak', copilotUser: { token_based_billing: false } } });
    start = jest.fn().mockImplementation(async () => ({ stop, closed: new Promise(() => {}), client: { rpc: { account: {
      getQuota: quota, getCurrentAuth: auth,
    } } } }));
    cache = new CopilotQuotaCache({ startRuntime: start as typeof startCopilotSdkRuntime, timeoutMs: 100 });
  });
  afterEach(async () => { jest.restoreAllMocks(); await cache.shutdown(); });

  test('coalesces requests, returns isolated copies and never creates a model session', async () => {
    const [a, b] = await Promise.all([cache.get(profile()), cache.get(profile())]);
    expect(start).toHaveBeenCalledTimes(1); expect(quota).toHaveBeenCalledWith({}); expect(stop).toHaveBeenCalledTimes(1);
    a.rows[0].used = 99;
    expect(b.rows[0].used).toBe(25);
    expect((await cache.get(profile())).rows[0].used).toBe(25);
    expect(JSON.stringify(b)).not.toContain('must-never-leak');
    expect(start).toHaveBeenCalledTimes(1);
  });

  test('profile and credential edits cannot share a quota cache', async () => {
    await cache.get(profile()); await cache.get(profile('b')); await cache.get(profile('a', { GH_TOKEN: 'different-fixture-account' }));
    expect(start).toHaveBeenCalledTimes(3);
    quota.mockRejectedValueOnce(new Error('native credential must-never-leak'));
    const unavailable = await cache.get(profile('c'));
    expect(unavailable).toMatchObject({ status: 'unavailable', rows: [] });
    expect(JSON.stringify(unavailable)).not.toContain('must-never-leak');
  });

  test('failed refresh retains only this identity’s last known snapshot and marks it stale', async () => {
    const first = await cache.get(profile());
    const now = Date.now(); jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    quota.mockRejectedValueOnce(new Error('offline'));
    expect(await cache.get(profile())).toMatchObject({ status: 'available', stale: true, fetchedAt: first.fetchedAt, rows: first.rows });
    expect(await cache.get(profile('new'))).toMatchObject({ stale: false, rows: expect.any(Array) });
  });

  test('empty quota and custom providers do not become a zero balance', async () => {
    quota.mockResolvedValueOnce({ quotaSnapshots: {} });
    expect(await cache.get(profile())).toMatchObject({ status: 'unavailable', rows: [], fetchedAt: null });
    expect(await cache.get(profile('custom', { COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:1' }))).toMatchObject({ status: 'unavailable', rows: [] });
    expect(start).toHaveBeenCalledTimes(1);
  });

  test('older auth metadata does not suppress quota or invent token-billing units', async () => {
    auth.mockRejectedValueOnce(new Error('Method unavailable'));
    expect((await cache.get(profile())).rows[0].unit).toBe('unknown');
  });

  test('read timeout closes the owned runtime and missing CLI startup stays unavailable', async () => {
    const bounded = new CopilotQuotaCache({ startRuntime: start as typeof startCopilotSdkRuntime, timeoutMs: 10 });
    quota.mockImplementationOnce(() => new Promise(() => {}));
    expect(await bounded.get(profile())).toMatchObject({ status: 'unavailable', rows: [] });
    expect(stop).toHaveBeenCalledTimes(1);
    await bounded.shutdown();
    start.mockRejectedValueOnce(new Error('Missing CLI'));
    expect(await cache.get(profile())).toMatchObject({ status: 'unavailable', rows: [] });
  });

  test('cache size is bounded and evicted identities must be read again', async () => {
    for (let n = 0; n < 33; n++) await cache.get(profile(String(n)));
    await cache.get(profile('32'));
    expect(start).toHaveBeenCalledTimes(33);
    await cache.get(profile('0'));
    expect(start).toHaveBeenCalledTimes(34);
  });

  test('failed cleanup blocks replacement rather than hiding a possibly live process', async () => {
    stop.mockRejectedValue(new Error('Termination unproved'));
    const failed = new CopilotQuotaCache({ startRuntime: start as typeof startCopilotSdkRuntime });
    await expect(failed.get(profile())).rejects.toThrow('Termination unproved');
    await expect(failed.get(profile())).rejects.toThrow('Termination unproved');
    expect(start).toHaveBeenCalledTimes(1);
    await expect(failed.shutdown()).rejects.toThrow('Copilot quota cleanup failed');
  });

  test('adapter exposes unavailable custom-provider quota and rejects admission after shutdown', async () => {
    const adapter = new CopilotAdapter();
    expect(await adapter.getQuota({ cliProfile: profile('custom', { COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:1' }) })).toMatchObject({ status: 'unavailable', rows: [] });
    await adapter.shutdown({ permanent: true });
    await expect(adapter.getQuota()).rejects.toThrow('shutting down');
    expect(start).not.toHaveBeenCalled();
  });

  test('timeout and shutdown await late startup cleanup before reuse', async () => {
    let resolve!: (value: unknown) => void;
    const owned = await start(); start.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = cache.get(profile());
    const closing = cache.shutdown();
    expect((await cache.get(profile())).status).toBe('unavailable');
    resolve(owned); await pending; await closing;
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await cache.get(profile())).status).toBe('available');
  });
});
