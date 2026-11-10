/** @jest-environment jsdom */
import { loadFrontendModule } from './mobileModuleLoader';
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
function deferred(){ let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test.each([false, true])('invalidated metadata cannot repopulate the cache or erase a newer request (old failure=%s)', async failure => {
  const old = deferred(), next = deferred(); let count = 0;
  const fetch = jest.fn((url: string) => {
    if (url.endsWith('/csrf-token')) return Promise.resolve(response({ csrfToken: 'fixture' }));
    if (url.endsWith('/settings')) return Promise.resolve(response({ cliProfiles: [] }));
    count++; return count === 1 ? old.promise : next.promise;
  });
  const { AgentApi } = loadFrontendModule('web/AgentCockpitWeb/src/api.js', {}, { window, fetch, CustomEvent, URLSearchParams, FormData });
  const first = AgentApi.getCliProfileMetadata('cortex');
  await AgentApi.settings.save({});
  const second = AgentApi.getCliProfileMetadata('cortex');
  if (failure) { old.reject(new Error('old')); await expect(first).rejects.toThrow('old'); }
  else { old.resolve(response({ backend: { id: 'cortex-code', label: 'STALE' } })); expect(await first).toBeNull(); }
  const duplicate = AgentApi.getCliProfileMetadata('cortex'); expect(count).toBe(2);
  next.resolve(response({ backend: { id: 'cortex-code', label: 'CURRENT' } }));
  expect(await second).toMatchObject({ label: 'CURRENT' }); expect(await duplicate).toMatchObject({ label: 'CURRENT' });
  expect(await AgentApi.getCliProfileMetadata('cortex')).toMatchObject({ label: 'CURRENT' }); expect(count).toBe(2);
});
