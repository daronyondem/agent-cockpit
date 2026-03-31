const { BaseBackendAdapter } = require('./base');

/**
 * Registry that maps backend IDs to adapter instances.
 *
 * Usage:
 *   const registry = new BackendRegistry();
 *   registry.register(new ClaudeCodeAdapter({ workingDir: '/tmp' }));
 *   const adapter = registry.get('claude-code');
 */
class BackendRegistry {
  constructor() {
    /** @type {Map<string, BaseBackendAdapter>} */
    this._adapters = new Map();
    /** @type {string|null} */
    this._defaultId = null;
  }

  /**
   * Register a backend adapter.  The first adapter registered becomes the
   * default unless overridden.
   *
   * @param {BaseBackendAdapter} adapter
   */
  register(adapter) {
    if (!(adapter instanceof BaseBackendAdapter)) {
      throw new Error('adapter must extend BaseBackendAdapter');
    }
    const { id } = adapter.metadata;
    this._adapters.set(id, adapter);
    if (!this._defaultId) {
      this._defaultId = id;
    }
  }

  /**
   * Look up an adapter by ID.
   * @param {string} id
   * @returns {BaseBackendAdapter|null}
   */
  get(id) {
    return this._adapters.get(id) || null;
  }

  /**
   * Return the default adapter (first registered).
   * @returns {BaseBackendAdapter|null}
   */
  getDefault() {
    return this._defaultId ? this._adapters.get(this._defaultId) : null;
  }

  /**
   * Return metadata for every registered adapter (safe to send to the
   * frontend — no adapter instances exposed).
   * @returns {Array<{ id, label, icon, capabilities }>}
   */
  list() {
    return [...this._adapters.values()].map(a => a.metadata);
  }
}

module.exports = { BackendRegistry };
