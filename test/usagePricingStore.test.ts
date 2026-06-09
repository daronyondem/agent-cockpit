import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { BUILTIN_USAGE_PRICING_CATALOG } from '../src/services/usagePricing/catalog';
import { UsagePricingStore } from '../src/services/usagePricing/store';
import type { UsagePricingEntry } from '../src/services/usagePricing/types';

const overrideEntry: UsagePricingEntry = {
  id: 'user-openai-gpt-5.5',
  provider: 'openai',
  modelPattern: 'gpt-5.5',
  unit: 'tokens',
  sourceUrl: 'user',
  verifiedAt: '2026-05-20',
  effectiveDate: '2026-05-20',
  ratesPerMillion: { input: 1, cachedInput: 0.1, output: 2 },
};

describe('UsagePricingStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ac-usage-pricing-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('returns built-in pricing when no overrides exist', async () => {
    const store = new UsagePricingStore(path.join(dir, 'usage-pricing-overrides.json'));
    const catalogs = await store.getCatalogs();

    expect(catalogs.overrides.entries).toEqual([]);
    expect(catalogs.effective.version).toBe(catalogs.builtin.version);
    expect(catalogs.effective.entries[0]).toEqual(catalogs.builtin.entries[0]);
  });

  test('persists overrides and puts them before built-in entries', async () => {
    const file = path.join(dir, 'usage-pricing-overrides.json');
    const store = new UsagePricingStore(file);
    const catalogs = await store.replaceOverrides([overrideEntry]);

    expect(catalogs.overrides.entries).toEqual([overrideEntry]);
    expect(catalogs.effective.entries[0]).toEqual(overrideEntry);
    expect(catalogs.effective.version).toMatch(new RegExp(`^${BUILTIN_USAGE_PRICING_CATALOG.version}\\+user-overrides:`));

    const reloaded = new UsagePricingStore(file);
    const reloadedCatalogs = await reloaded.getCatalogs();
    expect(reloadedCatalogs.overrides.entries).toEqual([overrideEntry]);
    expect(reloadedCatalogs.effective.entries[0]).toEqual(overrideEntry);
  });

  test('clears overrides without changing built-in defaults', async () => {
    const store = new UsagePricingStore(path.join(dir, 'usage-pricing-overrides.json'));
    await store.replaceOverrides([overrideEntry]);
    const catalogs = await store.clearOverrides();

    expect(catalogs.overrides.entries).toEqual([]);
    expect(catalogs.effective.entries[0]).toEqual(catalogs.builtin.entries[0]);
  });

  test('rejects malformed override entries', async () => {
    const store = new UsagePricingStore(path.join(dir, 'usage-pricing-overrides.json'));
    await expect(store.replaceOverrides([{ ...overrideEntry, ratesPerMillion: undefined }])).rejects.toThrow(/ratesPerMillion/);
  });

  test('ignores invalid override files without overwriting them', async () => {
    const file = path.join(dir, 'usage-pricing-overrides.json');
    await fsp.writeFile(file, '{not-json', 'utf8');

    const store = new UsagePricingStore(file);
    const catalogs = await store.getCatalogs();

    expect(catalogs.overrides.entries).toEqual([]);
    expect(await fsp.readFile(file, 'utf8')).toBe('{not-json');
  });
});
