const { execFile, spawn } = require('child_process');
const path = require('path');

/**
 * UpdateService — periodically checks the remote main branch for a newer
 * version and executes self-update + PM2 restart when triggered by the user.
 */
class UpdateService {
  constructor(appRoot) {
    this._appRoot = appRoot;
    this._localVersion = require(path.join(appRoot, 'package.json')).version;
    this._latestRemoteVersion = null;
    this._checkInterval = null;
    this._lastCheckAt = null;
    this._lastError = null;
    this._updateInProgress = false;
  }

  /** Start periodic version checks (every 15 minutes). */
  start() {
    this._checkRemoteVersion();
    this._checkInterval = setInterval(() => this._checkRemoteVersion(), 15 * 60 * 1000);
    this._checkInterval.unref();
  }

  /** Stop periodic version checks. */
  stop() {
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }
  }

  /** Return cached update status. */
  getStatus() {
    return {
      localVersion: this._localVersion,
      remoteVersion: this._latestRemoteVersion,
      updateAvailable: this._isNewer(this._latestRemoteVersion, this._localVersion),
      lastCheckAt: this._lastCheckAt,
      lastError: this._lastError,
      updateInProgress: this._updateInProgress,
    };
  }

  /**
   * Execute the full update sequence.
   * @param {object} opts
   * @param {function} opts.hasActiveStreams — returns true if CLI streams are active
   * @returns {{ success: boolean, steps: Array<{ name: string, success: boolean, output?: string }>, error?: string }}
   */
  async triggerUpdate({ hasActiveStreams } = {}) {
    if (this._updateInProgress) {
      return { success: false, steps: [], error: 'Update already in progress' };
    }

    this._updateInProgress = true;
    const steps = [];

    try {
      // Guard: active CLI streams
      if (hasActiveStreams && hasActiveStreams()) {
        return { success: false, steps: [], error: 'Cannot update while conversations are actively running. Please wait for them to complete or abort them first.' };
      }

      // Guard: dirty working tree
      const statusOut = await this._exec('git', ['status', '--porcelain']);
      // Filter out untracked files that are expected (data/, sessions, etc.)
      const significantChanges = statusOut.trim().split('\n').filter(line => {
        if (!line.trim()) return false;
        // Ignore untracked files in data/ and session dirs — they are runtime artifacts
        if (line.startsWith('?? data/')) return false;
        if (line.startsWith('?? .env')) return false;
        if (line.startsWith('?? ecosystem.config.js')) return false;
        if (line.startsWith('?? .DS_Store')) return false;
        if (line.startsWith('?? .claude/')) return false;
        if (line.startsWith('?? coverage/')) return false;
        if (line.startsWith('?? plans/')) return false;
        return true;
      });
      if (significantChanges.length > 0) {
        return {
          success: false,
          steps: [],
          error: 'Uncommitted local changes detected. Please commit or stash changes before updating.',
        };
      }

      // Step 1: git checkout main
      try {
        const out = await this._exec('git', ['checkout', 'main']);
        steps.push({ name: 'git checkout main', success: true, output: out.trim() });
      } catch (err) {
        steps.push({ name: 'git checkout main', success: false, output: err.message });
        return { success: false, steps, error: 'Failed to checkout main branch: ' + err.message };
      }

      // Step 2: git pull origin main
      try {
        const out = await this._exec('git', ['pull', 'origin', 'main'], 60000);
        steps.push({ name: 'git pull origin main', success: true, output: out.trim() });
      } catch (err) {
        steps.push({ name: 'git pull origin main', success: false, output: err.message });
        return { success: false, steps, error: 'Failed to pull latest changes: ' + err.message };
      }

      // Step 3: npm install
      try {
        const out = await this._exec('npm', ['install', '--production'], 120000);
        steps.push({ name: 'npm install', success: true, output: out.trim() });
      } catch (err) {
        steps.push({ name: 'npm install', success: false, output: err.message });
        return { success: false, steps, error: 'Failed to install dependencies: ' + err.message };
      }

      // Step 4: PM2 restart — fire and forget, because PM2 will kill this
      // process before execFile can report success. We spawn detached so the
      // PM2 CLI outlives our process, and return immediately.
      const ecosystemPath = path.join(this._appRoot, 'ecosystem.config.js');
      const pm2 = spawn('pm2', ['restart', ecosystemPath], {
        cwd: this._appRoot,
        detached: true,
        stdio: 'ignore',
      });
      pm2.unref();
      steps.push({ name: 'pm2 restart', success: true, output: 'Restart signal sent' });

      return { success: true, steps };
    } finally {
      this._updateInProgress = false;
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  async _checkRemoteVersion() {
    try {
      await this._exec('git', ['fetch', 'origin', 'main'], 30000);
      const raw = await this._exec('git', ['show', 'origin/main:package.json'], 10000);
      const parsed = JSON.parse(raw);
      this._latestRemoteVersion = parsed.version || null;
      this._lastCheckAt = new Date().toISOString();
      this._lastError = null;
    } catch (err) {
      this._lastError = err.message;
      console.error('[updateService] Version check failed:', err.message);
    }
  }

  /**
   * Run a command via execFile.
   * @param {string} cmd
   * @param {string[]} args
   * @param {number} [timeout=30000]
   * @returns {Promise<string>} stdout
   */
  _exec(cmd, args, timeout = 30000) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd: this._appRoot, timeout, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * Simple semver comparison: returns true if `remote` is strictly newer than `local`.
   * Handles standard three-part versions (e.g. 0.1.6 > 0.1.5).
   */
  _isNewer(remote, local) {
    if (!remote || !local) return false;
    const r = remote.split('.').map(Number);
    const l = local.split('.').map(Number);
    for (let i = 0; i < Math.max(r.length, l.length); i++) {
      const rv = r[i] || 0;
      const lv = l[i] || 0;
      if (rv > lv) return true;
      if (rv < lv) return false;
    }
    return false;
  }
}

module.exports = { UpdateService };
