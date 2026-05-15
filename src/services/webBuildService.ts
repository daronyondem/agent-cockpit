import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { atomicWriteFile } from '../utils/atomicWrite';

export type WebBuildMode = 'auto' | 'skip';

export interface WebBuildMarker {
  sourceHash: string;
  packageJsonHash: string;
  packageLockHash: string;
  gitSha: string | null;
  builtAt: string;
}

export interface WebBuildStatus {
  mode: WebBuildMode;
  buildDir: string;
  markerPath: string;
  fresh: boolean;
  skipped: boolean;
  didBuild: boolean;
  previousBuildAvailable: boolean;
  marker: WebBuildMarker | null;
  expected: Omit<WebBuildMarker, 'builtAt'>;
  output?: string;
  error?: string;
}

export interface WebBuildServiceOptions {
  mode?: WebBuildMode;
  webRoot?: string;
  buildDir?: string;
  buildLabel?: string;
  buildScript?: string;
  buildCommand?: (stagingDir: string) => BuildCommand;
  stagingPrefix?: string;
  now?: () => Date;
  buildRunner?: () => Promise<string>;
}

interface BuildCommand {
  cmd: string;
  args: string[];
  cwd?: string;
  timeout?: number;
}

const MARKER_FILENAME = '.agent-cockpit-build.json';

export class WebBuildService {
  private readonly appRoot: string;
  private readonly webRoot: string;
  private readonly buildDir: string;
  private readonly markerPath: string;
  private readonly mode: WebBuildMode;
  private readonly buildLabel: string;
  private readonly buildScript: string;
  private readonly buildCommand: (stagingDir: string) => BuildCommand;
  private readonly stagingPrefix: string;
  private readonly now: () => Date;
  private readonly buildRunner: () => Promise<string>;
  private inFlight: Promise<WebBuildStatus> | null = null;

  constructor(appRoot: string, opts: WebBuildServiceOptions = {}) {
    this.appRoot = appRoot;
    this.webRoot = opts.webRoot || path.join(appRoot, 'web', 'AgentCockpitWeb');
    this.buildDir = opts.buildDir || path.join(appRoot, 'public', 'v2-built');
    this.markerPath = path.join(this.buildDir, MARKER_FILENAME);
    this.mode = opts.mode || normalizeMode(process.env.WEB_BUILD_MODE);
    this.buildLabel = opts.buildLabel || 'V2 web';
    this.buildScript = opts.buildScript || 'web:build';
    this.buildCommand = opts.buildCommand || ((stagingDir: string) => ({
      cmd: 'npm',
      args: ['run', this.buildScript, '--', '--outDir', stagingDir],
      cwd: this.appRoot,
      timeout: 120_000,
    }));
    this.stagingPrefix = opts.stagingPrefix || 'v2-built';
    this.now = opts.now || (() => new Date());
    this.buildRunner = opts.buildRunner || (() => this.runDefaultBuild());
  }

  getBuildDir(): string {
    return this.buildDir;
  }

  getMarkerPath(): string {
    return this.markerPath;
  }

  async ensureBuilt(opts: { force?: boolean } = {}): Promise<WebBuildStatus> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.ensureBuiltOnce(opts).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async ensureBuiltOnce(opts: { force?: boolean }): Promise<WebBuildStatus> {
    const expected = await this.expectedMarkerFields();
    const marker = await this.readMarker();
    const previousBuildAvailable = await fileExists(path.join(this.buildDir, 'index.html'));
    const fresh = previousBuildAvailable && markerMatches(marker, expected);

    if (this.mode === 'skip' && !opts.force) {
      return {
        mode: this.mode,
        buildDir: this.buildDir,
        markerPath: this.markerPath,
        fresh,
        skipped: true,
        didBuild: false,
        previousBuildAvailable,
        marker,
        expected,
      };
    }

    if (fresh && !opts.force) {
      return {
        mode: this.mode,
        buildDir: this.buildDir,
        markerPath: this.markerPath,
        fresh: true,
        skipped: false,
        didBuild: false,
        previousBuildAvailable,
        marker,
        expected,
      };
    }

    try {
      const output = await this.buildRunner();
      const builtIndexAvailable = await fileExists(path.join(this.buildDir, 'index.html'));
      if (!builtIndexAvailable) {
        throw new Error(`${this.buildLabel} build completed without index.html`);
      }
      const builtAt = this.now().toISOString();
      const nextMarker: WebBuildMarker = { ...expected, builtAt };
      await fsp.mkdir(this.buildDir, { recursive: true });
      await atomicWriteFile(this.markerPath, JSON.stringify(nextMarker, null, 2));
      return {
        mode: this.mode,
        buildDir: this.buildDir,
        markerPath: this.markerPath,
        fresh: true,
        skipped: false,
        didBuild: true,
        previousBuildAvailable: await fileExists(path.join(this.buildDir, 'index.html')),
        marker: nextMarker,
        expected,
        output,
      };
    } catch (err: unknown) {
      const message = (err as Error).message;
      if (previousBuildAvailable) {
        return {
          mode: this.mode,
          buildDir: this.buildDir,
          markerPath: this.markerPath,
          fresh: false,
          skipped: false,
          didBuild: false,
          previousBuildAvailable,
          marker,
          expected,
          error: message,
        };
      }
      throw new Error(`${this.buildLabel} build failed and no previous build is available: ${message}`);
    }
  }

  private async expectedMarkerFields(): Promise<Omit<WebBuildMarker, 'builtAt'>> {
    const [sourceHash, packageJsonHash, packageLockHash, gitSha] = await Promise.all([
      hashPath(this.webRoot),
      hashFileIfExists(path.join(this.appRoot, 'package.json')),
      hashFileIfExists(path.join(this.appRoot, 'package-lock.json')),
      this.gitSha(),
    ]);
    return { sourceHash, packageJsonHash, packageLockHash, gitSha };
  }

  private async readMarker(): Promise<WebBuildMarker | null> {
    try {
      const raw = await fsp.readFile(this.markerPath, 'utf8');
      const parsed = JSON.parse(raw) as WebBuildMarker;
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.sourceHash !== 'string') return null;
      if (typeof parsed.packageJsonHash !== 'string') return null;
      if (typeof parsed.packageLockHash !== 'string') return null;
      if (typeof parsed.builtAt !== 'string') return null;
      return {
        sourceHash: parsed.sourceHash,
        packageJsonHash: parsed.packageJsonHash,
        packageLockHash: parsed.packageLockHash,
        gitSha: typeof parsed.gitSha === 'string' ? parsed.gitSha : null,
        builtAt: parsed.builtAt,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null;
    }
  }

  private async runDefaultBuild(): Promise<string> {
    const parentDir = path.dirname(this.buildDir);
    const stagingDir = path.join(parentDir, `.${this.stagingPrefix}-staging-${process.pid}-${Date.now()}`);
    await fsp.rm(stagingDir, { recursive: true, force: true });
    try {
      const command = this.buildCommand(stagingDir);
      const output = await execFileText(
        command.cmd,
        command.args,
        command.cwd || this.appRoot,
        command.timeout || 120_000,
      );
      if (!(await fileExists(path.join(stagingDir, 'index.html')))) {
        throw new Error(`${this.buildLabel} build completed without index.html`);
      }
      await this.replaceBuildDir(stagingDir);
      return output;
    } catch (err: unknown) {
      await fsp.rm(stagingDir, { recursive: true, force: true });
      throw err;
    }
  }

  private async replaceBuildDir(stagingDir: string): Promise<void> {
    const parentDir = path.dirname(this.buildDir);
    const previousDir = path.join(parentDir, `.${this.stagingPrefix}-previous-${process.pid}-${Date.now()}`);
    await fsp.mkdir(parentDir, { recursive: true });
    await fsp.rm(previousDir, { recursive: true, force: true });
    const hadPrevious = await pathExists(this.buildDir);
    if (hadPrevious) {
      await fsp.rename(this.buildDir, previousDir);
    }
    try {
      await fsp.rename(stagingDir, this.buildDir);
      await fsp.rm(previousDir, { recursive: true, force: true });
    } catch (err: unknown) {
      if (hadPrevious && !(await pathExists(this.buildDir)) && (await pathExists(previousDir))) {
        await fsp.rename(previousDir, this.buildDir);
      }
      throw err;
    }
  }

  private async gitSha(): Promise<string | null> {
    try {
      const out = await execFileText('git', ['rev-parse', 'HEAD'], this.appRoot, 5_000);
      return out.trim() || null;
    } catch {
      return null;
    }
  }
}

function normalizeMode(value: string | undefined): WebBuildMode {
  return value === 'skip' ? 'skip' : 'auto';
}

function markerMatches(marker: WebBuildMarker | null, expected: Omit<WebBuildMarker, 'builtAt'>): boolean {
  return !!marker
    && marker.sourceHash === expected.sourceHash
    && marker.packageJsonHash === expected.packageJsonHash
    && marker.packageLockHash === expected.packageLockHash;
}

async function hashPath(root: string): Promise<string> {
  const files = await listFiles(root);
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    hash.update(rel);
    hash.update('\0');
    hash.update(await fsp.readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.vite') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  await visit(root);
  return out.sort();
}

async function hashFileIfExists(filePath: string): Promise<string> {
  try {
    return crypto.createHash('sha256').update(await fsp.readFile(filePath)).digest('hex');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function execFileText(cmd: string, args: string[], cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = resolveExecCommand(cmd, args);
    execFile(command.cmd, command.args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || stdout || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

function resolveExecCommand(cmd: string, args: string[]): { cmd: string; args: string[] } {
  if (process.platform !== 'win32' || !/[.](?:cmd|bat)$/i.test(cmd)) {
    return { cmd, args };
  }
  return {
    cmd: 'cmd.exe',
    args: ['/d', '/s', '/c', [cmd, ...args].map(windowsCmdQuote).join(' ')],
  };
}

function windowsCmdQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
