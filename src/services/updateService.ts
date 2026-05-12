import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { InstallStatus, UpdateStatus, UpdateResult, UpdateStep } from '../types';
import { WebBuildService, type WebBuildStatus } from './webBuildService';
import { MobileBuildService, type MobileBuildStatus } from './mobileBuildService';

interface UpdateServiceOptions {
  webBuildService?: UpdateWebBuildService;
  mobileBuildService?: UpdateMobileBuildService;
  dataRoot?: string;
  installStateService?: UpdateInstallStateService;
}

interface UpdateInstallStateService {
  getStatus(): InstallStatus;
  writeState?(state: Partial<InstallStatus>): Promise<InstallStatus>;
}

interface ReleaseManifestArtifact {
  name: string;
  role: string;
  size?: number;
  sha256: string;
}

interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  packageRoot: string;
  artifacts: ReleaseManifestArtifact[];
}

interface UpdateWebBuildService {
  ensureBuilt(opts?: { force?: boolean }): Promise<WebBuildStatus>;
}

interface UpdateMobileBuildService {
  ensureBuilt(opts?: { force?: boolean }): Promise<MobileBuildStatus>;
}

export class UpdateService {
  private _appRoot: string;
  private _dataRoot: string;
  private _installStateService: UpdateInstallStateService | null;
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
    this._dataRoot = opts.dataRoot || path.join(appRoot, 'data');
    this._installStateService = opts.installStateService || null;
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
    const installStatus = this._installStateService?.getStatus();
    return {
      localVersion: this._localVersion,
      remoteVersion: this._latestRemoteVersion,
      updateAvailable: this._isNewer(this._latestRemoteVersion, this._localVersion),
      lastCheckAt: this._lastCheckAt,
      lastError: this._lastError,
      updateInProgress: this._updateInProgress,
      installChannel: installStatus?.channel || 'dev',
      installSource: installStatus?.source || 'git-main',
      installStateSource: installStatus?.stateSource || 'inferred',
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

      const installStatus = this._installStateService?.getStatus();
      if (installStatus?.channel === 'production' && installStatus.source === 'github-release') {
        return await this._triggerProductionUpdate(installStatus, steps);
      }

      return await this._triggerDevUpdate(steps);
    } finally {
      this._updateInProgress = false;
    }
  }

  private async _triggerDevUpdate(steps: UpdateStep[]): Promise<UpdateResult> {
      const statusOut = await this._exec('git', ['status', '--porcelain']);
      const significantChanges = statusOut.trim().split('\n').filter(line => {
        if (!line.trim()) return false;
        if (line.startsWith('?? data/')) return false;
        const relDataRoot = path.relative(this._appRoot, this._dataRoot);
        if (relDataRoot && !relDataRoot.startsWith('..') && !path.isAbsolute(relDataRoot)) {
          const normalized = relDataRoot.split(path.sep).join('/');
          if (line.startsWith(`?? ${normalized}/`)) return false;
        }
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
  }

  private async _triggerProductionUpdate(installStatus: InstallStatus, steps: UpdateStep[]): Promise<UpdateResult> {
    if (!installStatus.installDir || !installStatus.appDir) {
      return { success: false, steps, error: 'Production install manifest is missing installDir or appDir.' };
    }

    const previousAppDir = fs.realpathSync(installStatus.appDir);
    const currentLink = installStatus.appDir;
    const releasesDir = path.join(installStatus.installDir, 'releases');
    let switched = false;

    try {
      const release = await this._downloadLatestRelease(installStatus, steps);
      if (!this._isNewer(release.manifest.version, this._localVersion)) {
        return { success: false, steps, error: `No production update available. Installed version ${this._localVersion} is current.` };
      }

      const finalAppDir = await this._extractRelease(release.tarballPath, release.manifest.packageRoot, releasesDir, steps);

      try {
        const out = await this._exec('npm', ['ci'], 120000, finalAppDir);
        steps.push({ name: 'npm ci', success: true, output: out.trim() });
      } catch (err: unknown) {
        steps.push({ name: 'npm ci', success: false, output: (err as Error).message });
        return { success: false, steps, error: 'Failed to install production dependencies: ' + (err as Error).message };
      }

      try {
        const out = await this._exec('npm', ['--prefix', 'mobile/AgentCockpitPWA', 'ci'], 120000, finalAppDir);
        steps.push({ name: 'npm --prefix mobile/AgentCockpitPWA ci', success: true, output: out.trim() });
      } catch (err: unknown) {
        steps.push({ name: 'npm --prefix mobile/AgentCockpitPWA ci', success: false, output: (err as Error).message });
        return { success: false, steps, error: 'Failed to install production mobile dependencies: ' + (err as Error).message };
      }

      try {
        await this._ensureProductionBuilds(finalAppDir, steps);
      } catch (err: unknown) {
        return { success: false, steps, error: (err as Error).message };
      }

      this._copyRuntimeConfig(previousAppDir, finalAppDir);
      steps.push({ name: 'copy runtime config', success: true, output: '.env and ecosystem.config.js copied' });

      this._switchCurrentSymlink(currentLink, finalAppDir);
      switched = true;
      steps.push({ name: 'switch current release', success: true, output: `${currentLink} -> ${finalAppDir}` });

      if (this._installStateService?.writeState) {
        await this._installStateService.writeState({
          channel: 'production',
          source: 'github-release',
          repo: installStatus.repo,
          version: release.manifest.version,
          branch: null,
          installDir: installStatus.installDir,
          appDir: currentLink,
          dataDir: installStatus.dataDir,
        });
        steps.push({ name: 'write install manifest', success: true, output: `version ${release.manifest.version}` });
      }

      this._localVersion = release.manifest.version;
      this._launchRestartScript({
        appRoot: currentLink,
        healthUrl: this._healthUrl(finalAppDir),
        currentLink,
        rollbackTarget: previousAppDir,
      });
      steps.push({ name: 'pm2 restart', success: true, output: 'Restart script written and launched with health-check rollback' });

      return { success: true, steps };
    } catch (err: unknown) {
      if (switched) {
        try {
          this._switchCurrentSymlink(currentLink, previousAppDir);
        } catch {
          // Preserve the original error; the restart script also has rollback data.
        }
      }
      return { success: false, steps, error: 'Failed to apply production release: ' + (err as Error).message };
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
  private _launchRestartScript(options: {
    appRoot?: string;
    healthUrl?: string;
    currentLink?: string;
    rollbackTarget?: string;
  } = {}): void {
    const appRoot = options.appRoot || this._appRoot;
    const ecosystemPath = path.join(appRoot, 'ecosystem.config.js');
    const binDir = path.join(appRoot, 'node_modules', '.bin');
    const logFile = path.join(this._dataRoot, 'update-restart.log');
    const scriptFile = path.join(this._dataRoot, 'restart.sh');
    const scriptLines = [
      '#!/bin/sh',
      `export PATH="${binDir}:$PATH"`,
      'sleep 2',
      `pm2 delete "${ecosystemPath}" 2>/dev/null`,
      `pm2 start "${ecosystemPath}"`,
    ];
    if (options.healthUrl) {
      scriptLines.push(
        'ok=0',
        'i=0',
        'while [ "$i" -lt 20 ]; do',
        `  if curl -fsS "${options.healthUrl}" >/dev/null 2>&1; then ok=1; break; fi`,
        '  i=$((i + 1))',
        '  sleep 1',
        'done',
        'if [ "$ok" -ne 1 ]; then',
      );
      if (options.currentLink && options.rollbackTarget) {
        scriptLines.push(
          `  rm -f "${options.currentLink}"`,
          `  ln -s "${options.rollbackTarget}" "${options.currentLink}"`,
          `  pm2 delete "${ecosystemPath}" 2>/dev/null`,
          `  pm2 start "${ecosystemPath}"`,
        );
      }
      scriptLines.push('  exit 1', 'fi');
    }
    const scriptContent = scriptLines.join('\n');
    fs.mkdirSync(this._dataRoot, { recursive: true });
    fs.writeFileSync(scriptFile, scriptContent, { mode: 0o755 });
    // Double-fork: subshell backgrounds nohup, then exits immediately.
    // The nohup process gets reparented to init, surviving treekill.
    spawn('sh', ['-c', `(nohup "${scriptFile}" >> "${logFile}" 2>&1 &)`], {
      cwd: appRoot,
      stdio: 'ignore',
    });
  }

  private async _checkRemoteVersion(): Promise<void> {
    try {
      const installStatus = this._installStateService?.getStatus();
      if (installStatus?.channel === 'production' && installStatus.source === 'github-release') {
        const manifest = await this._downloadReleaseManifest(installStatus);
        this._latestRemoteVersion = manifest.version || null;
      } else {
        await this._exec('git', ['fetch', 'origin', 'main'], 30000);
        const raw = await this._exec('git', ['show', 'origin/main:package.json'], 10000);
        const parsed = JSON.parse(raw);
        this._latestRemoteVersion = parsed.version || null;
      }
      this._lastCheckAt = new Date().toISOString();
      this._lastError = null;
    } catch (err: unknown) {
      this._lastError = (err as Error).message;
      console.error('[updateService] Version check failed:', (err as Error).message);
    }
  }

  private _releaseDownloadBase(installStatus: InstallStatus): string {
    return `https://github.com/${installStatus.repo}/releases/latest/download`;
  }

  private async _downloadReleaseManifest(installStatus: InstallStatus): Promise<ReleaseManifest> {
    const raw = await this._exec('curl', ['-fsSL', `${this._releaseDownloadBase(installStatus)}/release-manifest.json`], 30000);
    return this._parseReleaseManifest(raw);
  }

  private async _downloadLatestRelease(installStatus: InstallStatus, steps: UpdateStep[]): Promise<{ manifest: ReleaseManifest; tarballPath: string }> {
    const base = this._releaseDownloadBase(installStatus);
    fs.mkdirSync(this._dataRoot, { recursive: true });
    const downloadDir = fs.mkdtempSync(path.join(this._dataRoot, 'release-download-'));
    const manifestPath = path.join(downloadDir, 'release-manifest.json');
    const checksumsPath = path.join(downloadDir, 'SHA256SUMS');
    fs.mkdirSync(downloadDir, { recursive: true });

    const manifestRaw = await this._exec('curl', ['-fsSL', `${base}/release-manifest.json`], 30000);
    fs.writeFileSync(manifestPath, manifestRaw);
    const checksumsRaw = await this._exec('curl', ['-fsSL', `${base}/SHA256SUMS`], 30000);
    fs.writeFileSync(checksumsPath, checksumsRaw);
    this._verifyChecksum(manifestPath, 'release-manifest.json', checksumsRaw);
    const manifest = this._parseReleaseManifest(manifestRaw);
    steps.push({ name: 'download release manifest', success: true, output: `version ${manifest.version}` });

    const tarball = manifest.artifacts.find(artifact => artifact.role === 'app-tarball');
    if (!tarball) throw new Error('Release manifest does not include an app-tarball artifact.');

    const tarballPath = path.join(downloadDir, tarball.name);
    const tarballBytes = await this._execBuffer('curl', ['-fsSL', `${base}/${tarball.name}`], 120000);
    fs.writeFileSync(tarballPath, tarballBytes);
    this._verifyChecksum(tarballPath, tarball.name, checksumsRaw);
    const actualSha = this._sha256File(tarballPath);
    if (tarball.sha256 && actualSha !== tarball.sha256) {
      throw new Error(`Release manifest checksum mismatch for ${tarball.name}`);
    }
    steps.push({ name: 'download release tarball', success: true, output: tarball.name });
    return { manifest, tarballPath };
  }

  private _parseReleaseManifest(raw: string): ReleaseManifest {
    const parsed = JSON.parse(raw) as Partial<ReleaseManifest>;
    if (parsed.schemaVersion !== 1 || !parsed.version || !parsed.packageRoot || !Array.isArray(parsed.artifacts)) {
      throw new Error('Invalid release manifest.');
    }
    return parsed as ReleaseManifest;
  }

  private _verifyChecksum(filePath: string, fileName: string, checksums: string): void {
    const expected = checksums.split(/\r?\n/)
      .map(line => line.trim().split(/\s+/))
      .find(parts => parts[1] === fileName)?.[0];
    if (!expected) throw new Error(`No checksum found for ${fileName}.`);
    const actual = this._sha256File(filePath);
    if (actual !== expected) throw new Error(`Checksum mismatch for ${fileName}.`);
  }

  private _sha256File(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }

  private async _extractRelease(tarballPath: string, packageRoot: string, releasesDir: string, steps: UpdateStep[]): Promise<string> {
    fs.mkdirSync(releasesDir, { recursive: true });
    const stagingParent = fs.mkdtempSync(path.join(releasesDir, '.extract-'));
    try {
      await this._exec('tar', ['-xzf', tarballPath, '-C', stagingParent], 120000);
      const extractedDir = path.join(stagingParent, packageRoot);
      if (!fs.existsSync(path.join(extractedDir, 'server.ts'))) {
        throw new Error('Extracted release is missing server.ts.');
      }
      const finalDir = path.join(releasesDir, packageRoot);
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(extractedDir, finalDir);
      steps.push({ name: 'extract release', success: true, output: finalDir });
      return finalDir;
    } finally {
      fs.rmSync(stagingParent, { recursive: true, force: true });
    }
  }

  private _assertReleaseBuilds(appDir: string): void {
    for (const relPath of ['public/v2-built/index.html', 'public/mobile-built/index.html']) {
      if (!fs.existsSync(path.join(appDir, relPath))) {
        throw new Error(`Release is missing ${relPath}.`);
      }
    }
  }

  private async _ensureProductionBuilds(appDir: string, steps: UpdateStep[]): Promise<void> {
    const webBuildService = new WebBuildService(appDir, { mode: 'auto' });
    const mobileBuildService = new MobileBuildService(appDir, { mode: 'auto' });

    const webBuild = await webBuildService.ensureBuilt();
    if (webBuild.error) {
      steps.push({ name: 'npm run web:build', success: false, output: webBuild.error });
      throw new Error('Failed to build production V2 web app: ' + webBuild.error);
    }
    steps.push({
      name: webBuild.didBuild ? 'npm run web:build' : 'verify V2 web build',
      success: true,
      output: webBuild.output?.trim()
        || (webBuild.didBuild ? `Build completed at ${webBuild.marker?.builtAt || 'unknown time'}` : 'V2 web build is fresh'),
    });

    const mobileBuild = await mobileBuildService.ensureBuilt();
    if (mobileBuild.error) {
      steps.push({ name: 'npm run mobile:build', success: false, output: mobileBuild.error });
      throw new Error('Failed to build production mobile PWA: ' + mobileBuild.error);
    }
    steps.push({
      name: mobileBuild.didBuild ? 'npm run mobile:build' : 'verify mobile PWA build',
      success: true,
      output: mobileBuild.output?.trim()
        || (mobileBuild.didBuild ? `Build completed at ${mobileBuild.marker?.builtAt || 'unknown time'}` : 'Mobile PWA build is fresh'),
    });

    this._assertReleaseBuilds(appDir);
    steps.push({ name: 'verify release assets', success: true, output: 'Found public/v2-built and public/mobile-built' });
  }

  private _copyRuntimeConfig(fromDir: string, toDir: string): void {
    for (const filename of ['.env', 'ecosystem.config.js']) {
      const source = path.join(fromDir, filename);
      if (!fs.existsSync(source)) {
        throw new Error(`Current runtime config is missing ${filename}.`);
      }
      fs.copyFileSync(source, path.join(toDir, filename));
    }
  }

  private _switchCurrentSymlink(currentLink: string, target: string): void {
    const parent = path.dirname(currentLink);
    if (!fs.existsSync(parent)) {
      throw new Error(`Current release parent does not exist: ${parent}`);
    }
    if (fs.existsSync(currentLink)) {
      const stat = fs.lstatSync(currentLink);
      if (!stat.isSymbolicLink()) {
        throw new Error(`${currentLink} exists and is not a symlink.`);
      }
      fs.rmSync(currentLink, { force: true });
    }
    fs.symlinkSync(target, currentLink);
  }

  private _healthUrl(appDir: string): string {
    const envPath = path.join(appDir, '.env');
    let port = '3334';
    try {
      const env = fs.readFileSync(envPath, 'utf8');
      const match = env.match(/^PORT=(.+)$/m);
      if (match?.[1]) port = match[1].trim().replace(/^['"]|['"]$/g, '');
    } catch {
      // Keep default.
    }
    return `http://127.0.0.1:${port}/api/chat/version`;
  }

  private _exec(cmd: string, args: string[], timeout = 30000, cwd = this._appRoot): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd, timeout, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout.toString());
        }
      });
    });
  }

  private _execBuffer(cmd: string, args: string[], timeout = 30000, cwd = this._appRoot): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd, timeout, maxBuffer: 100 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.toString() || err.message));
        } else {
          resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout)));
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
