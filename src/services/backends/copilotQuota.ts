import type { CopilotQuotaRow, CopilotQuotaSnapshot } from '../../contracts/copilotUsage';
import type { CliProfile } from '../../types';
import { copilotCatalogKey } from './copilotCatalog';
import { copilotChatTransport, resolveCopilotCliRuntime, type CopilotCliRuntime } from './copilotRuntime';
import { startCopilotSdkRuntime } from './copilotSdkRuntime';

const REFRESH_MS = 60_000;
const STALE_MS = 5 * 60_000;
const unavailable = (message: string): CopilotQuotaSnapshot => ({ status: 'unavailable', fetchedAt: null, stale: false, rows: [], message });
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Whitelist account fields; native auth responses and errors may contain secrets. */
export function copilotAccountQuota(value: unknown, tokenBasedBilling: unknown, observedAt: string): CopilotQuotaRow[] {
  return Object.entries(record(record(value).quotaSnapshots)).flatMap(([id, value]) => {
    const quota = record(value);
    const unlimited = quota.isUnlimitedEntitlement === true;
    if (!counter(quota.usedRequests) || (!unlimited && !counter(quota.entitlementRequests))) return [];
    const remaining = quota.remainingPercentage;
    return [{ id, label: id === 'premium_interactions' ? 'Premium interactions' : id.replace(/_/g, ' '),
      // The compatibility RPC omits units on token-based accounts. Do not guess.
      unit: tokenBasedBilling === false ? id === 'premium_interactions' ? 'premium_requests' as const : 'requests' as const : 'unknown' as const,
      observedAt, kind: 'account_snapshot' as const, access: 'unknown', capacity: unlimited ? 'unlimited' : 'unknown',
      used: quota.usedRequests, ...(counter(quota.entitlementRequests) ? { entitlement: quota.entitlementRequests } : {}), unlimited,
      ...(!unlimited && counter(remaining) && remaining <= 100 ? { usedPercentage: 100 - remaining } : {}),
      ...(typeof quota.resetDate === 'string' && Number.isFinite(Date.parse(quota.resetDate)) ? { resetAt: quota.resetDate } : {}),
    }];
  });
}

/** Owned, bounded, profile/runtime/auth-scoped account reads; never create a session. */
export class CopilotQuotaCache {
  private cache = new Map<string, { attemptedAt: number; value: CopilotQuotaSnapshot }>();
  private pending = new Map<string, { controller: AbortController; promise: Promise<CopilotQuotaSnapshot> }>();
  private closing: Promise<void> | null = null;
  constructor(private options: { startRuntime?: typeof startCopilotSdkRuntime; timeoutMs?: number } = {}) {}

  async get(profile?: CliProfile): Promise<CopilotQuotaSnapshot> {
    if (this.closing) return unavailable('Copilot is restarting.');
    if (copilotChatTransport(profile) !== 'sdk') return unavailable('Quota is unavailable for this custom command.');
    const runtime = resolveCopilotCliRuntime(profile);
    if (runtime.env.COPILOT_PROVIDER_BASE_URL) return unavailable('Copilot account quota does not apply to this custom provider.');
    const key = copilotCatalogKey(runtime);
    const existing = this.cache.get(key);
    const pending = this.pending.get(key);
    if (pending) return structuredClone(await pending.promise);
    if (existing && Date.now() - existing.attemptedAt < REFRESH_MS) return this.snapshot(existing.value);
    const controller = new AbortController();
    const promise = this.read(runtime, controller, existing?.value).then(value => {
      if (!this.closing && !controller.signal.aborted) {
        if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { attemptedAt: Date.now(), value });
      }
      this.pending.delete(key);
      return value;
    }); // Failed cleanup deliberately retains the admission barrier.
    this.pending.set(key, { controller, promise });
    return structuredClone(await promise);
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.cache.clear();
    const pending = [...this.pending.values()];
    for (const entry of pending) entry.controller.abort();
    this.closing = Promise.allSettled(pending.map(entry => entry.promise)).then(results => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Copilot quota cleanup failed.');
    }).finally(() => { this.cache.clear(); this.closing = null; });
    return this.closing;
  }

  private snapshot(value: CopilotQuotaSnapshot): CopilotQuotaSnapshot {
    return { ...structuredClone(value), stale: value.stale || !!value.fetchedAt && Date.now() - Date.parse(value.fetchedAt) >= STALE_MS };
  }

  private async read(runtime: CopilotCliRuntime, controller: AbortController, previous?: CopilotQuotaSnapshot): Promise<CopilotQuotaSnapshot> {
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Quota read cancelled.')), { once: true }));
    let owned: Awaited<ReturnType<typeof startCopilotSdkRuntime>> | undefined;
    let startup: ReturnType<typeof startCopilotSdkRuntime> | undefined;
    try {
      startup = (this.options.startRuntime || startCopilotSdkRuntime)(runtime, process.cwd(), { abortSignal: controller.signal });
      owned = await Promise.race([startup, aborted]);
      const quota = owned.client.rpc.account.getQuota({});
      const billing = owned.client.rpc.account.getCurrentAuth().then(result => record(record(result.authInfo).copilotUser).token_based_billing, () => undefined);
      const [data, tokenBasedBilling] = await Promise.race([Promise.all([quota, billing]), aborted, owned.closed.then(error => { throw error; })]);
      const fetchedAt = new Date().toISOString();
      const rows = copilotAccountQuota(data, tokenBasedBilling, fetchedAt);
      return rows.length ? { status: 'available', fetchedAt, stale: false, rows }
        : unavailable('The account did not report a usable quota snapshot.');
    } catch {
      return previous?.status === 'available' ? { ...previous, stale: true, message: 'Quota refresh failed. Showing the last reading.' }
        : unavailable('Account quota is unavailable. Check this profile’s login and access.');
    } finally {
      clearTimeout(timer);
      owned ||= await startup?.catch(() => undefined);
      await owned?.stop();
    }
  }
}
