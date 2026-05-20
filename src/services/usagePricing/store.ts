import fsp from 'fs/promises';
import { atomicWriteFile } from '../../utils/atomicWrite';
import { KeyedMutex } from '../../utils/keyedMutex';
import { logger } from '../../utils/logger';
import { BUILTIN_USAGE_PRICING_CATALOG, validateUsagePricingCatalog } from './catalog';
import type { UsagePricingCatalog, UsagePricingEntry, UsagePricingResponse } from './types';

const USAGE_PRICING_LOCK_KEY = '__usage_pricing__';
const log = logger.child({ module: 'usage-pricing-store' });

export class UsagePricingStore {
  private readonly lock = new KeyedMutex();
  private overridesCache: UsagePricingCatalog | null = null;

  constructor(private readonly overridesFile: string) {}

  async getCatalogs(): Promise<UsagePricingResponse> {
    const overrides = await this.readOverrides();
    return this._catalogs(overrides);
  }

  async readOverrides(): Promise<UsagePricingCatalog> {
    if (this.overridesCache) return this.overridesCache;
    return this.lock.run(USAGE_PRICING_LOCK_KEY, async () => {
      if (this.overridesCache) return this.overridesCache;
      this.overridesCache = await this._readOverridesFromDisk();
      return this.overridesCache;
    });
  }

  getEffectiveCatalogSync(): UsagePricingCatalog {
    return this._catalogs(this.overridesCache || emptyOverridesCatalog()).effective;
  }

  async replaceOverrides(entries: UsagePricingEntry[]): Promise<UsagePricingResponse> {
    return this.lock.run(USAGE_PRICING_LOCK_KEY, async () => {
      const now = new Date().toISOString();
      const overrides = validateUsagePricingCatalog({
        schemaVersion: 1,
        version: `user-overrides:${now}`,
        currency: 'USD',
        entries,
      });
      await atomicWriteFile(this.overridesFile, JSON.stringify(overrides, null, 2));
      this.overridesCache = overrides;
      return this._catalogs(overrides);
    });
  }

  async clearOverrides(): Promise<UsagePricingResponse> {
    return this.lock.run(USAGE_PRICING_LOCK_KEY, async () => {
      const overrides = emptyOverridesCatalog();
      await atomicWriteFile(this.overridesFile, JSON.stringify(overrides, null, 2));
      this.overridesCache = overrides;
      return this._catalogs(overrides);
    });
  }

  private async _readOverridesFromDisk(): Promise<UsagePricingCatalog> {
    try {
      const raw = await fsp.readFile(this.overridesFile, 'utf8');
      return validateUsagePricingCatalog(JSON.parse(raw));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyOverridesCatalog();
      log.warn('Ignoring invalid usage pricing overrides file', { file: this.overridesFile, error: err });
      return emptyOverridesCatalog();
    }
  }

  private _catalogs(overrides: UsagePricingCatalog): UsagePricingResponse {
    const effectiveEntries = [...overrides.entries, ...BUILTIN_USAGE_PRICING_CATALOG.entries];
    return {
      builtin: BUILTIN_USAGE_PRICING_CATALOG,
      overrides,
      effective: {
        schemaVersion: 1,
        version: effectiveCatalogVersion(overrides),
        currency: 'USD',
        entries: effectiveEntries,
      },
    };
  }
}

function emptyOverridesCatalog(): UsagePricingCatalog {
  return {
    schemaVersion: 1,
    version: 'user-overrides:empty',
    currency: 'USD',
    entries: [],
  };
}

function effectiveCatalogVersion(overrides: UsagePricingCatalog): string {
  if (overrides.entries.length === 0) return BUILTIN_USAGE_PRICING_CATALOG.version;
  return `${BUILTIN_USAGE_PRICING_CATALOG.version}+${overrides.version}`;
}
