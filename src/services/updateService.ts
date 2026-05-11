import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { UpdateStatus, UpdateResult, UpdateStep } from '../types';
import { WebBuildService, type WebBuildStatus } from './webBuildService';
import { MobileBuildService, type MobileBuildStatus } from './mobileBuildService';

interface UpdateServiceOptions {
  webBuildService?: UpdateWebBuildService;
  mobileBuildService?: UpdateMobileBuildService;
}

interface UpdateWebBuildService {
  ensureBuilt(opts?: { force?: boolean }): Promise<WebBuildStatus>;
}

interface UpdateMobileBuildService {
  ensureBuilt(opts?: { force?: boolean }): Promise<MobileBuildStatus>;
}

export class UpdateService {
  private _appRoot: string;
  private _webBuildService: UpdateWebBuildService;
  private _mobileBuildService: UpdateMobileBuildService;
  private _localVersion: string;
  private _latestRemoteVersion: string | null = null;
  private _checkInterval: ReturnType<typeof setInterval> | null = null;
  private _lastCheckAt: string | null = null;
  private _lastError: string | null = null;
  private _updateInProgress = false;

  constructor(appRoot: string, opts: UpdateServiceOptions = {}) {
    this._appRoot = appRoot;
    this._webBuildService = opts.webBuildService || new WebBuildService(appRoot, { mode: 'auto' });
    this._mobileBuildService = opts.mobileBuildService || new MobileBuildService(appRoot, { mode: 'auto' });
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

      try {
        const out = await this._exec('npm', ['--prefix', 'mobile/AgentCockpitPWA', 'install'], 120000);
        steps.push({ name: 'npm --prefix mobile/AgentCockpitPWA install', success: true, output: out.trim() });
      } catch (err: unknown) {
        steps.push({ name: 'npm --prefix mobile/AgentCockpitPWA install', success: false, output: (err as Error).message });
        return { success: false, steps, error: 'Failed to install mobile dependencies: ' + (err as Error).message };
      }

      try {
        const webBuild = await this._webBuildService.ensureBuilt({ force: true });
        if (webBuild.error) {
          steps.push({ name: 'npm run web:build', success: false, output: webBuild.error });
          return { success: false, steps, error: 'Failed to build V2 web app: ' + webBuild.error };
        }
        const output = webBuild.output?.trim()
          || (webBuild.didBuild ? `Build completed at ${webBuild.marker?.builtAt || 'unknown time'}` : 'V2 web build is fresh');
        steps.push({ name: 'npm run web:build', success: true, output });
      } catch (err: unknown) {
        steps.push({ name: 'npm run web:build', success: false, output: (err as Error).message });
        return { success: false, steps, error: 'Failed to build V2 web app: ' + (err as Error).message };
      }

      try {
        const mobileBuild = await this._mobileBuildService.ensureBuilt({ force: true });
        if (mobileBuild.error) {
          steps.push({ name: 'npm run mobile:build', success: false, output: mobileBuild.error });
          return { success: false, steps, error: 'Failed to build mobile PWA: ' + mobileBuild.error };
        }
        const output = mobileBuild.output?.trim()
          || (mobileBuild.didBuild ? `Build completed at ${mobileBuild.marker?.builtAt || 'unknown time'}` : 'Mobile PWA build is fresh');
        steps.push({ name: 'npm run mobile:build', success: true, output });
      } catch (err: unknown) {
        steps.push({ name: 'npm run mobile:build', success: false, output: (err as Error).message });
        return { success: false, steps, error: 'Failed to build mobile PWA: ' + (err as Error).message };
      }

      // Verify the interpreter from ecosystem config exists after npm install
      const ecosystemPath = path.join(this._appRoot, 'ecosystem.config.js');
      try {
        // Read fresh from disk — require() caches modules and returns stale
        // config even after git pull updates the file
        const ecoSource = fs.readFileSync(ecosystemPath, 'utf8');
        const mod: { exports: Record<string, unknown> } = { exports: {} };
        const ecoDir = path.dirname(ecosystemPath);
        new Function('module', 'exports', '__dirname', ecoSource)(mod, mod.exports, ecoDir);
        const ecoConfig = mod.exports as { apps?: Array<{ interpreter?: string }> };
        const app = ecoConfig.apps?.[0];
        if (app?.interpreter) {
          // Relative or absolute paths: resolve against appRoot and check on disk
          // Bare commands (e.g. "npx", "node"): look up via PATH
          const isPath = app.interpreter.startsWith('.') || app.interpreter.startsWith('/');
          if (isPath) {
            const interpreterPath = path.resolve(this._appRoot, app.interpreter);
            if (!fs.existsSync(interpreterPath)) {
              steps.push({ name: 'verify interpreter', success: false, output: `Interpreter not found: ${interpreterPath}` });
              return { success: false, steps, error: `Interpreter not found after npm install: ${app.interpreter}. Dependencies may not have installed correctly.` };
            }
            steps.push({ name: 'verify interpreter', success: true, output: `Found: ${interpreterPath}` });
          } else {
            try {
              const resolved = await this._exec('which', [app.interpreter], 5000);
              steps.push({ name: 'verify interpreter', success: true, output: `Found on PATH: ${resolved.trim()}` });
            } catch {
              steps.push({ name: 'verify interpreter', success: false, output: `Interpreter not found on PATH: ${app.interpreter}` });
              return { success: false, steps, error: `Interpreter not found on PATH: ${app.interpreter}. Ensure it is installed and available.` };
            }
          }
        }
      } catch (err: unknown) {
        steps.push({ name: 'verify interpreter', success: false, output: (err as Error).message });
        return { success: false, steps, error: 'Failed to read ecosystem config: ' + (err as Error).message };
      }

      this._launchRestartScript();
      steps.push({ name: 'pm2 restart', success: true, output: 'Restart script written and launched' });

      return { success: true, steps };
    } finally {
      this._updateInProgress = false;
    }
  }

  // Plain server restart — same pm2 double-fork mechanism as triggerUpdate()
  // but without the git pull / npm install / interpreter verification steps.
  // Used by the "Restart Server" button in Global Settings so users can pick
  // up side-effects of external changes that are only read at startup (e.g.
  // installing pandoc, whose detection result is cached per process).
  async restart(opts: { hasActiveStreams?: () => boolean } = {}): Promise<UpdateResult> {
    if (this._updateInProgress) {
      return { success: false, steps: [], error: 'Update or restart already in progress' };
    }
    if (opts.hasActiveStreams && opts.hasActiveStreams()) {
      return {
        success: false,
        steps: [],
        error: 'Cannot restart while conversations are actively running. Please wait for them to complete or abort them first.',
      };
    }

    this._updateInProgress = true;
    try {
      this._launchRestartScript();
      return {
        success: true,
        steps: [{ name: 'pm2 restart', success: true, output: 'Restart script written and launched' }],
      };
    } finally {
      this._updateInProgress = false;
    }
  }

  // Write a restart script to disk, then execute it via a double-fork so it
  // survives PM2's treekill. PM2 kills the server process AND all descendants
  // when `pm2 delete` runs. A simple `detached: true` spawn is still a child
  // (by PPID) and gets killed before reaching `pm2 start`. The double-fork
  // (nohup ... &) in a subshell ensures the restart process is reparented to
  // init before treekill runs.
  private _launchRestartScript(): void {
    const ecosystemPath = path.join(this._appRoot, 'ecosystem.config.js');
    const binDir = path.join(this._appRoot, 'node_modules', '.bin');
    const logFile = path.join(this._appRoot, 'data', 'update-restart.log');
    const scriptFile = path.join(this._appRoot, 'data', 'restart.sh');
    const scriptContent = [
      '#!/bin/sh',
      `export PATH="${binDir}:$PATH"`,
      'sleep 2',
      `pm2 delete "${ecosystemPath}" 2>/dev/null`,
      `pm2 start "${ecosystemPath}"`,
    ].join('\n');
    fs.writeFileSync(scriptFile, scriptContent, { mode: 0o755 });
    // Double-fork: subshell backgrounds nohup, then exits immediately.
    // The nohup process gets reparented to init, surviving treekill.
    spawn('sh', ['-c', `(nohup "${scriptFile}" >> "${logFile}" 2>&1 &)`], {
      cwd: this._appRoot,
      stdio: 'ignore',
    });
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
