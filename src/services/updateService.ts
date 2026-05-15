import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { InstallNodeRuntime, InstallStatus, UpdateStatus, UpdateResult, UpdateStep } from '../types';
import { WebBuildService, type WebBuildStatus } from './webBuildService';
import { MobileBuildService, type MobileBuildStatus } from './mobileBuildService';

const DEFAULT_REQUIRED_NODE_MAJOR = 22;

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
  platform?: string;
  format?: string;
  size?: number;
  sha256: string;
}

interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  packageRoot: string;
  artifacts: ReleaseManifestArtifact[];
  requiredRuntime?: {
    node?: {
      engine?: string | null;
      minimumMajor?: number | null;
    };
  };
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
    this._webBuildService = opts.webBuildService || this._createWebBuildService(appRoot, null);
    this._mobileBuildService = opts.mobileBuildService || this._createMobileBuildService(appRoot, null);
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
      const npmCmd = this._npmCommand(this._installStateService?.getStatus().nodeRuntime || null);
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
        const out = await this._exec(npmCmd, ['install'], 120000);
        steps.push({ name: 'npm install', success: true, output: out.trim() });
      } catch (err: unknown) {
        steps.push({ name: 'npm install', success: false, output: (err as Error).message });
        return { success: false, steps, error: 'Failed to install dependencies: ' + (err as Error).message };
      }

      try {
        const out = await this._exec(npmCmd, ['--prefix', 'mobile/AgentCockpitPWA', 'install'], 120000);
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
              const resolved = await this._exec(process.platform === 'win32' ? 'where' : 'which', [app.interpreter], 5000);
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

    const isWindows = process.platform === 'win32';
    const previousAppDir = isWindows ? installStatus.appDir : fs.realpathSync(installStatus.appDir);
    const currentLink = installStatus.appDir;
    const releasesDir = path.join(installStatus.installDir, 'releases');
    let switched = false;

    try {
      const release = await this._downloadLatestRelease(installStatus, steps);
      if (!this._isNewer(release.manifest.version, this._localVersion)) {
        return { success: false, steps, error: `No production update available. Installed version ${this._localVersion} is current.` };
      }

      const finalAppDir = await this._extractRelease(release.tarballPath, release.manifest.packageRoot, releasesDir, steps);
      const nodeRuntime = await this._ensureProductionNodeRuntime(installStatus, release.manifest, finalAppDir, steps);
      const npmCmd = this._npmCommand(nodeRuntime);

      try {
        const out = await this._exec(npmCmd, ['ci'], 120000, finalAppDir);
        steps.push({ name: 'npm ci', success: true, output: out.trim() });
      } catch (err: unknown) {
        steps.push({ name: 'npm ci', success: false, output: (err as Error).message });
        return { success: false, steps, error: 'Failed to install production dependencies: ' + (err as Error).message };
      }

      try {
        const out = await this._exec(npmCmd, ['--prefix', 'mobile/AgentCockpitPWA', 'ci'], 120000, finalAppDir);
        steps.push({ name: 'npm --prefix mobile/AgentCockpitPWA ci', success: true, output: out.trim() });
      } catch (err: unknown) {
        steps.push({ name: 'npm --prefix mobile/AgentCockpitPWA ci', success: false, output: (err as Error).message });
        return { success: false, steps, error: 'Failed to install production mobile dependencies: ' + (err as Error).message };
      }

      try {
        await this._ensureProductionBuilds(finalAppDir, steps, nodeRuntime);
      } catch (err: unknown) {
        return { success: false, steps, error: (err as Error).message };
      }

      this._copyRuntimeConfig(previousAppDir, finalAppDir, nodeRuntime, installStatus);
      steps.push({ name: 'copy runtime config', success: true, output: '.env and ecosystem.config.js copied' });

      const nextAppDir = isWindows ? finalAppDir : currentLink;
      if (isWindows) {
        switched = true;
        steps.push({ name: 'activate release', success: true, output: finalAppDir });
      } else {
        this._switchCurrentSymlink(currentLink, finalAppDir);
        switched = true;
        steps.push({ name: 'switch current release', success: true, output: `${currentLink} -> ${finalAppDir}` });
      }

      if (this._installStateService?.writeState) {
        await this._installStateService.writeState({
          channel: 'production',
          source: 'github-release',
          repo: installStatus.repo,
          version: release.manifest.version,
          branch: null,
          installDir: installStatus.installDir,
          appDir: nextAppDir,
          dataDir: installStatus.dataDir,
          nodeRuntime,
          startup: installStatus.startup,
        });
        steps.push({ name: 'write install manifest', success: true, output: `version ${release.manifest.version}` });
      }

      this._localVersion = release.manifest.version;
      this._launchRestartScript({
        appRoot: nextAppDir,
        healthUrl: this._healthUrl(finalAppDir),
        currentLink: isWindows ? undefined : currentLink,
        rollbackTarget: previousAppDir,
        rollbackInstallStatus: installStatus,
        nodeRuntime,
      });
      steps.push({ name: 'pm2 restart', success: true, output: 'Restart script written and launched with health-check rollback' });

      return { success: true, steps };
    } catch (err: unknown) {
      if (switched && !isWindows) {
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
    rollbackInstallStatus?: InstallStatus;
    nodeRuntime?: InstallNodeRuntime | null;
  } = {}): void {
    if (process.platform === 'win32') {
      this._launchWindowsRestartScript(options);
      return;
    }

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

  private _launchWindowsRestartScript(options: {
    appRoot?: string;
    healthUrl?: string;
    rollbackTarget?: string;
    rollbackInstallStatus?: InstallStatus;
    nodeRuntime?: InstallNodeRuntime | null;
  } = {}): void {
    const appRoot = options.appRoot || this._appRoot;
    const ecosystemPath = path.join(appRoot, 'ecosystem.config.js');
    const logFile = path.join(this._dataRoot, 'update-restart.log');
    const scriptFile = path.join(this._dataRoot, 'restart.ps1');
    const installJsonPath = path.join(this._dataRoot, 'install.json');
    const nodeRuntime = options.nodeRuntime || this._installStateService?.getStatus().nodeRuntime || null;
    const nodeBin = nodeRuntime?.binDir || path.join(appRoot, 'node_modules', '.bin');
    const pm2Home = path.join(path.dirname(this._dataRoot), 'pm2');
    const npxPath = this._windowsNpxCommand(nodeRuntime);
    const scriptLines = [
      'Set-StrictMode -Version Latest',
      "$ErrorActionPreference = 'Stop'",
      `Start-Transcript -Path ${this._psQuote(logFile)} -Append | Out-Null`,
      'try {',
      '  function Invoke-CheckedNative {',
      '    param([string] $FilePath, [string[]] $Arguments, [switch] $AllowFailure)',
      '    & $FilePath @Arguments',
      '    $code = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }',
      '    if ($code -ne 0 -and -not $AllowFailure) {',
      '      throw ("Command failed with exit code {0}: {1} {2}" -f $code, $FilePath, ($Arguments -join " "))',
      '    }',
      '    $global:LASTEXITCODE = 0',
      '  }',
      '  Start-Sleep -Seconds 2',
      `  $env:PM2_HOME = ${this._psQuote(pm2Home)}`,
      `  $env:Path = ${this._psQuote(nodeBin)} + ';' + $env:Path`,
      `  Invoke-CheckedNative ${this._psQuote(npxPath)} @('pm2', 'delete', 'agent-cockpit') -AllowFailure`,
      `  Invoke-CheckedNative ${this._psQuote(npxPath)} @('pm2', 'startOrRestart', ${this._psQuote(ecosystemPath)}, '--update-env')`,
    ];
    if (options.healthUrl) {
      scriptLines.push(
        '  $ok = $false',
        '  for ($i = 0; $i -lt 20; $i++) {',
        '    try {',
        `      Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ${this._psQuote(options.healthUrl)} | Out-Null`,
        '      $ok = $true',
        '      break',
        '    } catch {',
        '      Start-Sleep -Seconds 1',
        '    }',
        '  }',
        '  if (-not $ok) {',
      );
      if (options.rollbackInstallStatus && options.rollbackTarget) {
        const rollbackNodeRuntime = options.rollbackInstallStatus.nodeRuntime || null;
        const rollbackNodeBin = rollbackNodeRuntime?.binDir || path.join(options.rollbackTarget, 'node_modules', '.bin');
        const rollbackNpxPath = this._windowsNpxCommand(rollbackNodeRuntime);
        scriptLines.push(
          `    ${this._psWriteFileCommand(installJsonPath, JSON.stringify(this._persistedInstallStatus(options.rollbackInstallStatus), null, 2) + '\n')}`,
          `    $env:Path = ${this._psQuote(rollbackNodeBin)} + ';' + $env:Path`,
          `    Invoke-CheckedNative ${this._psQuote(rollbackNpxPath)} @('pm2', 'delete', 'agent-cockpit') -AllowFailure`,
          `    Invoke-CheckedNative ${this._psQuote(rollbackNpxPath)} @('pm2', 'startOrRestart', ${this._psQuote(path.join(options.rollbackTarget, 'ecosystem.config.js'))}, '--update-env')`,
          `    Invoke-CheckedNative ${this._psQuote(rollbackNpxPath)} @('pm2', 'save')`,
        );
      }
      scriptLines.push(
        '    exit 1',
        '  }',
      );
    }
    scriptLines.push(
      `  Invoke-CheckedNative ${this._psQuote(npxPath)} @('pm2', 'save')`,
      '} finally {',
      '  Stop-Transcript | Out-Null',
      '}',
    );
    fs.mkdirSync(this._dataRoot, { recursive: true });
    fs.writeFileSync(scriptFile, scriptLines.join('\r\n'));
    const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
      cwd: appRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }

  private _windowsNpxCommand(nodeRuntime: InstallNodeRuntime | null): string {
    return nodeRuntime?.binDir ? path.join(nodeRuntime.binDir, 'npx.cmd') : 'npx.cmd';
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

  private async _ensureProductionNodeRuntime(
    installStatus: InstallStatus,
    manifest: ReleaseManifest,
    appDir: string,
    steps: UpdateStep[],
  ): Promise<InstallNodeRuntime | null> {
    const required = this._requiredNodeRuntime(manifest, appDir);
    const current = await this._readCurrentNodeRuntime(installStatus, required.minimumMajor);
    if (this._nodeMajor(current.version) >= required.minimumMajor) {
      if (current.source === 'private' && current.binDir) this._prependPath(current.binDir);
      const verified = { ...current, requiredMajor: required.minimumMajor };
      steps.push({
        name: 'verify Node.js runtime',
        success: true,
        output: `Node.js ${current.version || 'unknown'} satisfies ${required.engine || `>=${required.minimumMajor}`}`,
      });
      return verified;
    }

    steps.push({
      name: 'verify Node.js runtime',
      success: false,
      output: `Node.js ${current.version || 'unknown'} does not satisfy ${required.engine || `>=${required.minimumMajor}`}; installing a private runtime`,
    });
    const updated = await this._installPrivateNodeRuntime(installStatus, required.minimumMajor, steps);
    this._prependPath(updated.binDir || '');
    return updated;
  }

  private _requiredNodeRuntime(manifest: ReleaseManifest, appDir: string): { engine: string | null; minimumMajor: number } {
    const manifestNode = manifest.requiredRuntime?.node;
    if (manifestNode && typeof manifestNode.minimumMajor === 'number' && Number.isFinite(manifestNode.minimumMajor)) {
      return {
        engine: typeof manifestNode.engine === 'string' ? manifestNode.engine : null,
        minimumMajor: manifestNode.minimumMajor,
      };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
      const engine = typeof parsed.engines?.node === 'string' ? parsed.engines.node : null;
      return {
        engine,
        minimumMajor: this._parseMinimumNodeMajor(engine) || DEFAULT_REQUIRED_NODE_MAJOR,
      };
    } catch {
      return { engine: null, minimumMajor: DEFAULT_REQUIRED_NODE_MAJOR };
    }
  }

  private _parseMinimumNodeMajor(engine: string | null): number | null {
    if (!engine) return null;
    const match = engine.match(/>=\s*(\d+)/);
    return match ? Number(match[1]) : null;
  }

  private async _readCurrentNodeRuntime(installStatus: InstallStatus, requiredMajor: number): Promise<InstallNodeRuntime> {
    const privateRuntime = this._privateNodeRuntime(installStatus);
    const stored = installStatus.nodeRuntime;
    if (stored?.source === 'private' || fs.existsSync(privateRuntime.nodePath)) {
      let version = stored?.version || null;
      if (!version && fs.existsSync(privateRuntime.nodePath)) {
        try {
          version = (await this._exec(privateRuntime.nodePath, ['-p', 'process.versions.node'], 5000)).trim();
        } catch {
          version = null;
        }
      }
      return {
        source: 'private',
        version,
        npmVersion: stored?.npmVersion || null,
        binDir: stored?.binDir || privateRuntime.binDir,
        runtimeDir: stored?.runtimeDir || privateRuntime.runtimeDir,
        requiredMajor,
        updatedAt: stored?.updatedAt || null,
      };
    }

    return {
      source: stored?.source === 'unknown' ? 'unknown' : 'system',
      version: process.versions.node || stored?.version || null,
      npmVersion: stored?.npmVersion || null,
      binDir: stored?.binDir || path.dirname(process.execPath),
      runtimeDir: stored?.runtimeDir || null,
      requiredMajor,
      updatedAt: stored?.updatedAt || null,
    };
  }

  private _privateNodeRuntime(installStatus: InstallStatus): { runtimeRoot: string; runtimeDir: string; binDir: string; nodePath: string } {
    const installDir = installStatus.installDir || path.dirname(this._appRoot);
    const runtimeRoot = path.join(installDir, 'runtime');
    if (process.platform === 'win32' && installStatus.nodeRuntime?.source === 'private' && installStatus.nodeRuntime.runtimeDir) {
      const runtimeDir = installStatus.nodeRuntime.runtimeDir;
      const binDir = installStatus.nodeRuntime.binDir || runtimeDir;
      return {
        runtimeRoot,
        runtimeDir,
        binDir,
        nodePath: path.join(binDir, 'node.exe'),
      };
    }
    const runtimeDir = path.join(runtimeRoot, 'node');
    const binDir = process.platform === 'win32' ? runtimeDir : path.join(runtimeDir, 'bin');
    return {
      runtimeRoot,
      runtimeDir,
      binDir,
      nodePath: path.join(binDir, process.platform === 'win32' ? 'node.exe' : 'node'),
    };
  }

  private async _installPrivateNodeRuntime(installStatus: InstallStatus, requiredMajor: number, steps: UpdateStep[]): Promise<InstallNodeRuntime> {
    if (!installStatus.installDir) {
      throw new Error('Production install manifest is missing installDir; cannot update private Node.js runtime.');
    }
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      throw new Error('Private Node.js runtime updates are currently supported on macOS and Windows only.');
    }

    const nodeArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
    if (!nodeArch) throw new Error(`Unsupported CPU architecture for Node.js runtime update: ${process.arch}`);

    const runtime = this._privateNodeRuntime(installStatus);
    const downloadDir = fs.mkdtempSync(path.join(this._dataRoot, 'node-runtime-download-'));
    try {
      const base = `https://nodejs.org/dist/latest-v${requiredMajor}.x`;
      const checksumsRaw = await this._downloadText(`${base}/SHASUMS256.txt`, 30000);
      const tarballName = this._findNodeRuntimeArchiveName(checksumsRaw, requiredMajor, nodeArch);
      const tarballPath = path.join(downloadDir, tarballName);
      await this._downloadToFile(`${base}/${tarballName}`, tarballPath, 120000);
      this._verifyChecksum(tarballPath, tarballName, checksumsRaw);

      const version = tarballName.replace(/^node-v/, '')
        .replace(new RegExp(`-${process.platform === 'win32' ? 'win' : 'darwin'}-${nodeArch}[.](?:tar[.]gz|zip)$`), '');
      fs.mkdirSync(runtime.runtimeRoot, { recursive: true });
      const stagingParent = fs.mkdtempSync(path.join(runtime.runtimeRoot, '.node-extract-'));
      try {
        if (process.platform === 'win32') {
          await this._exec('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `Expand-Archive -Path ${this._psQuote(tarballPath)} -DestinationPath ${this._psQuote(stagingParent)} -Force`,
          ], 120000);
        } else {
          await this._exec('tar', ['-xzf', tarballPath, '-C', stagingParent], 120000);
        }
        const extractedDir = path.join(stagingParent, `node-v${version}-${process.platform === 'win32' ? 'win' : 'darwin'}-${nodeArch}`);
        const finalDir = path.join(runtime.runtimeRoot, process.platform === 'win32' ? `node-v${version}-win-${nodeArch}` : `node-v${version}`);
        fs.rmSync(finalDir, { recursive: true, force: true });
        fs.renameSync(extractedDir, finalDir);
        if (process.platform === 'win32') {
          runtime.runtimeDir = finalDir;
          runtime.binDir = finalDir;
          runtime.nodePath = path.join(finalDir, 'node.exe');
        } else {
          if (fs.existsSync(runtime.runtimeDir) && !fs.lstatSync(runtime.runtimeDir).isSymbolicLink()) {
            throw new Error(`${runtime.runtimeDir} exists and is not a symlink.`);
          }
          fs.rmSync(runtime.runtimeDir, { force: true });
          fs.symlinkSync(finalDir, runtime.runtimeDir);
        }
      } finally {
        fs.rmSync(stagingParent, { recursive: true, force: true });
      }

      const npmVersion = await this._readPrivateNpmVersion(runtime.runtimeDir, runtime.binDir);
      const result: InstallNodeRuntime = {
        source: 'private',
        version,
        npmVersion,
        binDir: runtime.binDir,
        runtimeDir: runtime.runtimeDir,
        requiredMajor,
        updatedAt: new Date().toISOString(),
      };
      steps.push({
        name: 'install Node.js runtime',
        success: true,
        output: `Installed private Node.js v${version} for required runtime >=${requiredMajor}`,
      });
      return result;
    } catch (err: unknown) {
      steps.push({ name: 'install Node.js runtime', success: false, output: (err as Error).message });
      throw err;
    } finally {
      fs.rmSync(downloadDir, { recursive: true, force: true });
    }
  }

  private _findNodeRuntimeArchiveName(checksumsRaw: string, requiredMajor: number, nodeArch: string): string {
    const platform = process.platform === 'win32' ? 'win' : 'darwin';
    const extension = process.platform === 'win32' ? 'zip' : 'tar[.]gz';
    const pattern = new RegExp(`^node-v${requiredMajor}[.][0-9]+[.][0-9]+-${platform}-${nodeArch}[.]${extension}$`);
    for (const line of checksumsRaw.split(/\r?\n/)) {
      const [, name] = line.trim().split(/\s+/);
      if (name && pattern.test(name)) return name;
    }
    throw new Error(`Could not find a ${process.platform === 'win32' ? 'Windows' : 'macOS'} ${nodeArch} Node.js ${requiredMajor} archive in SHASUMS256.txt.`);
  }

  private _nodeMajor(version: string | null): number {
    if (!version) return 0;
    const major = Number(version.replace(/^v/, '').split('.')[0]);
    return Number.isFinite(major) ? major : 0;
  }

  private _prependPath(binDir: string): void {
    if (!binDir) return;
    const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    process.env.PATH = [binDir, ...parts.filter(part => part !== binDir)].join(path.delimiter);
  }

  private async _readPrivateNpmVersion(runtimeDir: string, binDir: string): Promise<string | null> {
    if (process.platform === 'win32') {
      const npmPath = path.join(binDir, 'npm.cmd');
      if (!fs.existsSync(npmPath)) return null;
      try {
        return (await this._exec(npmPath, ['--version'], 5000)).trim() || null;
      } catch {
        return null;
      }
    }
    const nodePath = path.join(binDir, 'node');
    const npmCliPath = path.join(runtimeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(nodePath) || !fs.existsSync(npmCliPath)) return null;
    try {
      return (await this._exec(nodePath, [npmCliPath, '--version'], 5000)).trim() || null;
    } catch {
      return null;
    }
  }

  private async _downloadReleaseManifest(installStatus: InstallStatus): Promise<ReleaseManifest> {
    const raw = await this._downloadText(`${this._releaseDownloadBase(installStatus)}/release-manifest.json`, 30000);
    return this._parseReleaseManifest(raw);
  }

  private async _downloadLatestRelease(installStatus: InstallStatus, steps: UpdateStep[]): Promise<{ manifest: ReleaseManifest; tarballPath: string }> {
    const base = this._releaseDownloadBase(installStatus);
    fs.mkdirSync(this._dataRoot, { recursive: true });
    const downloadDir = fs.mkdtempSync(path.join(this._dataRoot, 'release-download-'));
    const manifestPath = path.join(downloadDir, 'release-manifest.json');
    const checksumsPath = path.join(downloadDir, 'SHA256SUMS');
    fs.mkdirSync(downloadDir, { recursive: true });

    await this._downloadToFile(`${base}/release-manifest.json`, manifestPath, 30000);
    const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    await this._downloadToFile(`${base}/SHA256SUMS`, checksumsPath, 30000);
    const checksumsRaw = fs.readFileSync(checksumsPath, 'utf8');
    this._verifyChecksum(manifestPath, 'release-manifest.json', checksumsRaw);
    const manifest = this._parseReleaseManifest(manifestRaw);
    steps.push({ name: 'download release manifest', success: true, output: `version ${manifest.version}` });

    const tarball = this._selectReleaseArchive(manifest);
    if (!tarball) throw new Error(`Release manifest does not include a ${process.platform === 'win32' ? 'Windows app ZIP' : 'macOS app tarball'} artifact.`);

    const tarballPath = path.join(downloadDir, tarball.name);
    await this._downloadToFile(`${base}/${tarball.name}`, tarballPath, 120000);
    this._verifyChecksum(tarballPath, tarball.name, checksumsRaw);
    const actualSha = this._sha256File(tarballPath);
    if (tarball.sha256 && actualSha !== tarball.sha256) {
      throw new Error(`Release manifest checksum mismatch for ${tarball.name}`);
    }
    steps.push({ name: process.platform === 'win32' ? 'download release zip' : 'download release tarball', success: true, output: tarball.name });
    return { manifest, tarballPath };
  }

  private _parseReleaseManifest(raw: string): ReleaseManifest {
    const parsed = JSON.parse(raw) as Partial<ReleaseManifest>;
    if (parsed.schemaVersion !== 1 || !parsed.version || !parsed.packageRoot || !Array.isArray(parsed.artifacts)) {
      throw new Error('Invalid release manifest.');
    }
    return parsed as ReleaseManifest;
  }

  private _selectReleaseArchive(manifest: ReleaseManifest): ReleaseManifestArtifact | undefined {
    if (process.platform === 'win32') {
      return manifest.artifacts.find(artifact =>
        artifact.role === 'app-zip'
        || (artifact.platform === 'win32' && artifact.format === 'zip')
      );
    }
    return manifest.artifacts.find(artifact => artifact.role === 'app-tarball');
  }

  private async _downloadText(url: string, timeout = 30000): Promise<string> {
    if (process.platform !== 'win32') {
      return this._exec('curl', ['-fsSL', url], timeout);
    }
    fs.mkdirSync(this._dataRoot, { recursive: true });
    const tempFile = path.join(this._dataRoot, `download-${crypto.randomBytes(8).toString('hex')}.txt`);
    try {
      await this._downloadToFile(url, tempFile, timeout);
      return fs.readFileSync(tempFile, 'utf8');
    } finally {
      fs.rmSync(tempFile, { force: true });
    }
  }

  private async _downloadToFile(url: string, dest: string, timeout = 30000): Promise<void> {
    if (process.platform === 'win32') {
      await this._exec('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Invoke-WebRequest -UseBasicParsing -Uri ${this._psQuote(url)} -OutFile ${this._psQuote(dest)}`,
      ], timeout);
      return;
    }
    const bytes = await this._execBuffer('curl', ['-fsSL', url], timeout);
    fs.writeFileSync(dest, bytes);
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
      if (process.platform === 'win32') {
        await this._exec('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Expand-Archive -Path ${this._psQuote(tarballPath)} -DestinationPath ${this._psQuote(stagingParent)} -Force`,
        ], 120000);
      } else {
        await this._exec('tar', ['-xzf', tarballPath, '-C', stagingParent], 120000);
      }
      const extractedDir = path.join(stagingParent, packageRoot);
      if (!fs.existsSync(path.join(extractedDir, 'server.ts'))) {
        throw new Error('Extracted release is missing server.ts.');
      }
      const finalDir = path.join(releasesDir, packageRoot);
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(extractedDir, finalDir);
      steps.push({ name: process.platform === 'win32' ? 'extract release zip' : 'extract release', success: true, output: finalDir });
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

  private async _ensureProductionBuilds(appDir: string, steps: UpdateStep[], nodeRuntime: InstallNodeRuntime | null): Promise<void> {
    const webBuildService = this._createWebBuildService(appDir, nodeRuntime);
    const mobileBuildService = this._createMobileBuildService(appDir, nodeRuntime);

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

  private _createWebBuildService(appRoot: string, nodeRuntime: InstallNodeRuntime | null): WebBuildService {
    return new WebBuildService(appRoot, {
      mode: 'auto',
      buildCommand: (stagingDir: string) => ({
        cmd: this._npmCommand(nodeRuntime),
        args: ['run', 'web:build', '--', '--outDir', stagingDir],
        cwd: appRoot,
        timeout: 120000,
      }),
    });
  }

  private _createMobileBuildService(appRoot: string, nodeRuntime: InstallNodeRuntime | null): MobileBuildService {
    return new MobileBuildService(appRoot, {
      mode: 'auto',
      buildCommand: (stagingDir: string) => ({
        cmd: this._npmCommand(nodeRuntime),
        args: ['--prefix', 'mobile/AgentCockpitPWA', 'run', 'build', '--', '--outDir', stagingDir],
        cwd: appRoot,
        timeout: 120000,
      }),
    });
  }

  private _npmCommand(nodeRuntime: InstallNodeRuntime | null = null): string {
    if (process.platform !== 'win32') return 'npm';
    if (nodeRuntime?.binDir) return path.join(nodeRuntime.binDir, 'npm.cmd');
    return 'npm.cmd';
  }

  private _copyRuntimeConfig(fromDir: string, toDir: string, nodeRuntime: InstallNodeRuntime | null, installStatus?: InstallStatus): void {
    const envSource = path.join(fromDir, '.env');
    if (!fs.existsSync(envSource)) {
      throw new Error('Current runtime config is missing .env.');
    }
    fs.copyFileSync(envSource, path.join(toDir, '.env'));

    if (process.platform === 'win32') {
      this._writeWindowsEcosystemConfig(toDir, nodeRuntime, installStatus);
    } else {
      const ecosystemSource = path.join(fromDir, 'ecosystem.config.js');
      if (!fs.existsSync(ecosystemSource)) {
        throw new Error('Current runtime config is missing ecosystem.config.js.');
      }
      fs.copyFileSync(ecosystemSource, path.join(toDir, 'ecosystem.config.js'));
    }
    if (nodeRuntime?.source === 'private' && nodeRuntime.binDir) {
      this._persistPrivateRuntimePath(toDir, nodeRuntime.binDir);
    }
  }

  private _writeWindowsEcosystemConfig(appDir: string, nodeRuntime: InstallNodeRuntime | null, installStatus?: InstallStatus): void {
    const envPath = path.join(appDir, '.env');
    const nodePath = nodeRuntime?.source === 'private' && nodeRuntime.binDir
      ? path.join(nodeRuntime.binDir, 'node.exe')
      : process.execPath;
    const dataDir = installStatus?.dataDir || this._dataRoot;
    const pm2Home = path.join(path.dirname(dataDir), 'pm2');
    const config = {
      apps: [{
        name: 'agent-cockpit',
        script: 'node_modules/tsx/dist/cli.mjs',
        args: 'server.ts',
        interpreter: nodePath,
        cwd: appDir,
        windowsHide: true,
        env: {
          PORT: Number(this._readEnvValue(envPath, 'PORT')) || 3334,
          SESSION_SECRET: this._readEnvValue(envPath, 'SESSION_SECRET') || '',
          AUTH_SETUP_TOKEN: this._readEnvValue(envPath, 'AUTH_SETUP_TOKEN') || '',
          AGENT_COCKPIT_DATA_DIR: dataDir,
          WEB_BUILD_MODE: this._readEnvValue(envPath, 'WEB_BUILD_MODE') || 'auto',
          AUTH_ENABLE_LEGACY_OAUTH: this._readEnvValue(envPath, 'AUTH_ENABLE_LEGACY_OAUTH') || 'false',
          PM2_HOME: pm2Home,
          PATH: nodeRuntime?.binDir ? this._runtimePath(nodeRuntime.binDir) : process.env.PATH || '',
        },
      }],
    };
    fs.writeFileSync(path.join(appDir, 'ecosystem.config.js'), `module.exports = ${JSON.stringify(config, null, 2)};\n`);
  }

  private _readEnvValue(envPath: string, name: string): string | null {
    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      const match = raw.match(new RegExp(`^${name}=(.+)$`, 'm'));
      return match?.[1]?.trim().replace(/^['"]|['"]$/g, '') || null;
    } catch {
      return null;
    }
  }

  private _persistPrivateRuntimePath(appDir: string, binDir: string): void {
    const runtimePath = this._runtimePath(binDir);
    const envPath = path.join(appDir, '.env');
    const envRaw = fs.readFileSync(envPath, 'utf8');
    const envLine = `PATH=${this._dotenvQuote(runtimePath)}`;
    const envNext = /^PATH=.*$/m.test(envRaw)
      ? envRaw.replace(/^PATH=.*$/m, envLine)
      : `${envRaw.replace(/\s*$/, '')}\n${envLine}\n`;
    fs.writeFileSync(envPath, envNext);

    const ecosystemPath = path.join(appDir, 'ecosystem.config.js');
    const source = fs.readFileSync(ecosystemPath, 'utf8');
    const mod: { exports: unknown } = { exports: {} };
    new Function('module', 'exports', '__dirname', source)(mod, mod.exports, appDir);
    const config = mod.exports as { apps?: Array<{ env?: Record<string, unknown> }> };
    if (!config || !Array.isArray(config.apps) || !config.apps[0]) {
      throw new Error('Current ecosystem.config.js does not export an app config.');
    }
    config.apps[0].env = { ...(config.apps[0].env || {}), PATH: runtimePath };
    fs.writeFileSync(ecosystemPath, `module.exports = ${JSON.stringify(config, null, 2)};\n`);
  }

  private _runtimePath(binDir: string): string {
    const delimiter = process.platform === 'win32' ? ';' : path.delimiter;
    const parts = (process.env.PATH || '').split(delimiter).filter(Boolean);
    return [binDir, ...parts.filter(part => part !== binDir)].join(delimiter);
  }

  private _dotenvQuote(value: string): string {
    return `\`${value.replace(/`/g, '\\`')}\``;
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

  private _psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private _psWriteFileCommand(filePath: string, content: string): string {
    return `[System.IO.File]::WriteAllText(${this._psQuote(filePath)}, ${this._psQuote(content)}, (New-Object System.Text.UTF8Encoding($false)))`;
  }

  private _persistedInstallStatus(status: InstallStatus): Record<string, unknown> {
    return {
      schemaVersion: 1,
      channel: status.channel,
      source: status.source,
      repo: status.repo,
      version: status.version,
      branch: status.branch,
      installDir: status.installDir,
      appDir: status.appDir,
      dataDir: status.dataDir,
      installedAt: status.installedAt,
      welcomeCompletedAt: status.welcomeCompletedAt,
      nodeRuntime: status.nodeRuntime,
      startup: status.startup,
    };
  }

  private _exec(cmd: string, args: string[], timeout = 30000, cwd = this._appRoot): Promise<string> {
    return new Promise((resolve, reject) => {
      const command = this._resolveExecCommand(cmd, args);
      execFile(command.cmd, command.args, { cwd, timeout, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
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
      const command = this._resolveExecCommand(cmd, args);
      execFile(command.cmd, command.args, { cwd, timeout, maxBuffer: 100 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.toString() || err.message));
        } else {
          resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout)));
        }
      });
    });
  }

  private _resolveExecCommand(cmd: string, args: string[]): { cmd: string; args: string[] } {
    if (process.platform !== 'win32' || !/[.](?:cmd|bat)$/i.test(cmd)) {
      return { cmd, args };
    }
    return {
      cmd: 'cmd.exe',
      args: ['/d', '/s', '/c', [cmd, ...args].map(this._windowsCmdQuote).join(' ')],
    };
  }

  private _windowsCmdQuote(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
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
