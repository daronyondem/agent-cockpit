import { BaseBackendAdapter } from './base';
import type { BackendMetadata } from '../../types';

/**
 * Registry that maps backend IDs to adapter instances.
 */
export class BackendRegistry {
  private _adapters: Map<string, BaseBackendAdapter> = new Map();
  private _defaultId: string | null = null;

  register(adapter: BaseBackendAdapter): void {
    if (!(adapter instanceof BaseBackendAdapter)) {
      throw new Error('adapter must extend BaseBackendAdapter');
    }
    const { id } = adapter.metadata;
    this._adapters.set(id, adapter);
    if (!this._defaultId) {
      this._defaultId = id;
    }
  }

  get(id: string): BaseBackendAdapter | null {
    return this._adapters.get(id) || null;
  }

  getDefault(): BaseBackendAdapter | null {
    return this._defaultId ? this._adapters.get(this._defaultId) || null : null;
  }

  list(): BackendMetadata[] {
    return [...this._adapters.values()].map(a => a.metadata);
  }

  /**
   * Call shutdown() on every registered adapter.
   * Used during graceful server shutdown to clean up long-lived processes.
   */
  shutdownAll(): void {
    for (const adapter of this._adapters.values()) {
      adapter.shutdown();
    }
  }
}
