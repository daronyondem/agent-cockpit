import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { UpdateStatus, UpdateResult, UpdateStep } from '../types';

export class UpdateService {
  private _appRoot: string;
  private _localVersion: string;
  private _latestRemoteVersion: string | null = null;
  private _checkInterval: ReturnType<typeof setInterval> | null = null;
  private _lastCheckAt: string | null = null;
  private _lastError: string | null = null;
  private _updateInProgress = false;

  constructor(appRoot: string) {
    this._appRoot = appRoot;
    this._localVersion = require(path.join(appRoot, 'package.json')).version;
  }

  start(): void {
    this._checkRemoteVersion();
    this._checkInterval = setInterval(() => this._checkRemoteVersion(), 15 * 60 * 1000);
    this._checkInterval.unref();
  }

  stop(): void {
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }
  }

  async checkNow(): Promise<UpdateStatus> {
    await this._checkRemoteVersion();
    return this.getStatus();
  }

  getStatus(): UpdateStatus {
    return {
      localVersion: this._localVersion,
      remoteVersion: this._latestRemoteVersion,
      updateAvailable: this._isNewer(this._latestRemoteVersion, this._localVersion),
      lastCheckAt: this._lastCheckAt,
      lastError: this._lastError,
      updateInProgress: this._updateInProgress,
    };
  }

  async triggerUpdate(opts: { hasActiveStreams?: () => boolean } = {}): Promise<UpdateResult> {
    if (this._updateInProgress) {
      return { success: false, steps: [], error: 'Update already in progress' };
    }

    this._updateInProgress = true;
    const steps: UpdateStep[] = [];

    try {
      if (opts.hasActiveStreams && opts.hasActiveStreams()) {
        return { success: false, steps: [], error: 'Cannot update while conversations are actively running. Please wait for them to complete or abort them first.' };
      }

      const statusOut = await this._exec('git', ['status', '--porcelain']);
      const significantChanges = statusOut.trim().split('\n').filter(line => {
        if (!line.trim()) return false;
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

      try {
        const out = await this._exec('git', ['checkout', 'main']);
        steps.push({ name: 'git checkout main', success: true, output: out.trim() });
      } catch (err: unknown) {
        steps.push({ name: 'git checkout main', success: false, output: (err as Error).message });
        return { success: false, steps, error: 'Failed to checkout main branch: ' + (err as Error).message };
      }

      try {
        const out = await this._exec('git', ['pull', 'origin', 'main'], 60000);
        steps.push({ name: 'git pull origin main', success: true, output: out.trim() });
      } catch (err: unknown) {
        steps.push({ name: 'git pull origin main', success: false, output: (err as Error).message });
        return { success: false, steps, error: 'Failed to pull latest changes: ' + (err as Error).message };
      }

      try {
        const out = await this._exec('npm', ['install'], 120000);
        steps.push({ name: 'npm install', success: true, output: out.trim() });
      } catch (err: unknown) {
        steps.push({ name: 'npm install', success: false, output: (err as Error).message });
        return { success: false, steps, error: 'Failed to install dependencies: ' + (err as Error).message };
      }

      // Verify the interpreter from ecosystem config exists after npm install
      const ecosystemPath = path.join(this._appRoot, 'ecosystem.config.js');
      try {
        const ecoConfig = require(ecosystemPath);
        const app = ecoConfig.apps?.[0];
        if (app?.interpreter) {
          const interpreterPath = path.resolve(this._appRoot, app.interpreter);
          if (!fs.existsSync(interpreterPath)) {
            steps.push({ name: 'verify interpreter', success: false, output: `Interpreter not found: ${interpreterPath}` });
            return { success: false, steps, error: `Interpreter not found after npm install: ${app.interpreter}. Dependencies may not have installed correctly.` };
          }
          steps.push({ name: 'verify interpreter', success: true, output: `Found: ${interpreterPath}` });
        }
      } catch (err: unknown) {
        steps.push({ name: 'verify interpreter', success: false, output: (err as Error).message });
        return { success: false, steps, error: 'Failed to read ecosystem config: ' + (err as Error).message };
      }

      // Delete + start in a single detached shell so pm2 picks up config
      // changes (interpreter, script name, env vars). Must be one detached
      // command because pm2 delete kills the current process.
      //
      // Prepend node_modules/.bin to PATH so the detached shell can always
      // find pm2 (a project dependency) without relying on global installs
      // or npx. Log output so restart failures leave a trace.
      const binDir = path.join(this._appRoot, 'node_modules', '.bin');
      const logFile = path.join(this._appRoot, 'data', 'update-restart.log');
      const pm2 = spawn('sh', ['-c', `export PATH="${binDir}:$PATH"; (pm2 delete "${ecosystemPath}" 2>/dev/null; pm2 start "${ecosystemPath}") >> "${logFile}" 2>&1`], {
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

  private async _checkRemoteVersion(): Promise<void> {
    try {
      await this._exec('git', ['fetch', 'origin', 'main'], 30000);
      const raw = await this._exec('git', ['show', 'origin/main:package.json'], 10000);
      const parsed = JSON.parse(raw);
      this._latestRemoteVersion = parsed.version || null;
      this._lastCheckAt = new Date().toISOString();
      this._lastError = null;
    } catch (err: unknown) {
      this._lastError = (err as Error).message;
      console.error('[updateService] Version check failed:', (err as Error).message);
    }
  }

  private _exec(cmd: string, args: string[], timeout = 30000): Promise<string> {
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

  private _isNewer(remote: string | null, local: string): boolean {
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
