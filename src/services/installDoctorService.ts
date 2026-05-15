import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { InstallDoctorCheck, InstallDoctorCheckStatus, InstallDoctorStatus, InstallStatus, UpdateStatus } from '../types';
import type { InstallStateService } from './installStateService';
import type { UpdateService } from './updateService';
import { detectLibreOffice, type LibreOfficeStatus } from './knowledgeBase/libreOffice';
import { detectPandoc, type PandocStatus } from './knowledgeBase/pandoc';

const execFileAsync = promisify(execFile);
const NODE_REMEDIATION = 'Install Node.js 22+ from nodejs.org, or rerun the macOS installer without --no-install-node so it can install a private runtime.';
const CLAUDE_CLI_REMEDIATION = 'Install Claude Code only if you want to use that backend. macOS: run `curl -fsSL https://claude.ai/install.sh | bash` or `brew install --cask claude-code`, then run `claude` and finish browser sign-in. Restart Agent Cockpit if the command is still not detected.';
const CODEX_CLI_REMEDIATION = 'Install Codex only if you want to use that backend. Run `npm i -g @openai/codex` or, on macOS, `brew install --cask codex`; then run `codex` and sign in with ChatGPT or an API key. Restart Agent Cockpit if the command is still not detected.';
const KIRO_CLI_REMEDIATION = 'Install Kiro only if you want to use that backend. macOS: run `curl -fsSL https://cli.kiro.dev/install | bash`, then run `kiro-cli login` and finish browser sign-in. Restart Agent Cockpit if the command is still not detected.';
const PANDOC_REMEDIATION = 'Install Pandoc for DOCX knowledge-base ingestion. macOS: run `brew install pandoc`, or use the installer from https://pandoc.org/installing.html, then restart Agent Cockpit.';
const LIBREOFFICE_REMEDIATION = 'Install LibreOffice for PPTX slide-image conversion. macOS: run `brew install --cask libreoffice`, or download it from https://www.libreoffice.org/download/download-libreoffice/, then restart Agent Cockpit.';

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

type CommandRunner = (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<CommandResult>;

interface InstallDoctorServiceOptions {
  appRoot: string;
  dataRoot: string;
  installStateService: InstallStateService;
  updateService?: UpdateService | null;
  commandRunner?: CommandRunner;
  detectPandoc?: () => Promise<PandocStatus>;
  detectLibreOffice?: () => Promise<LibreOfficeStatus>;
}

async function defaultCommandRunner(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 5_000,
      maxBuffer: 256 * 1024,
      env: { ...process.env },
    });
    return {
      ok: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: (e.stdout || '').trim(),
      stderr: (e.stderr || '').trim(),
      error: e.code === 'ENOENT' ? 'not found' : (e.message || 'command failed'),
    };
  }
}

function firstLine(value: string | undefined): string | undefined {
  return value ? value.split(/\r?\n/).find(Boolean) : undefined;
}

function check(id: string, label: string, status: InstallDoctorCheckStatus, required: boolean, summary: string, detail?: string, remediation?: string): InstallDoctorCheck {
  const result: InstallDoctorCheck = { id, label, status, required, summary };
  if (detail) result.detail = detail;
  if (remediation) result.remediation = remediation;
  return result;
}

export class InstallDoctorService {
  private readonly appRoot: string;
  private readonly dataRoot: string;
  private readonly installStateService: InstallStateService;
  private readonly updateService: UpdateService | null;
  private readonly commandRunner: CommandRunner;
  private readonly pandocDetector: () => Promise<PandocStatus>;
  private readonly libreOfficeDetector: () => Promise<LibreOfficeStatus>;

  constructor(options: InstallDoctorServiceOptions) {
    this.appRoot = options.appRoot;
    this.dataRoot = options.dataRoot;
    this.installStateService = options.installStateService;
    this.updateService = options.updateService ?? null;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.pandocDetector = options.detectPandoc ?? detectPandoc;
    this.libreOfficeDetector = options.detectLibreOffice ?? detectLibreOffice;
  }

  async getStatus(): Promise<InstallDoctorStatus> {
    const install = this.installStateService.getStatus();
    const checks: InstallDoctorCheck[] = [];

    checks.push(this.checkNode());
    checks.push(await this.checkCommand('npm', 'npm', ['npm', '--version'], true, 'npm is available.', NODE_REMEDIATION));
    checks.push(await this.checkCommand('pm2', 'PM2', ['npx', '--no-install', 'pm2', '--version'], true, 'Local PM2 is available through npx.', 'Run npm ci in the app directory, then retry.'));
    checks.push(await this.checkDataDir());
    checks.push(this.checkAppDir());
    checks.push(this.checkBuildAsset('web-build', 'Desktop web build', 'public/v2-built/index.html', true));
    checks.push(this.checkBuildAsset('mobile-build', 'Mobile PWA build', 'public/mobile-built/index.html', false));
    checks.push(await this.checkCommand('claude-cli', 'Claude Code CLI', ['claude', '--version'], false, 'Claude Code CLI responded.', CLAUDE_CLI_REMEDIATION));
    checks.push(await this.checkCommand('codex-cli', 'Codex CLI', ['codex', '--version'], false, 'Codex CLI responded.', CODEX_CLI_REMEDIATION));
    checks.push(await this.checkCommand('kiro-cli', 'Kiro CLI', ['kiro-cli', '--version'], false, 'Kiro CLI responded.', KIRO_CLI_REMEDIATION));
    checks.push(await this.checkPandoc());
    checks.push(await this.checkLibreOffice());
    checks.push(this.checkUpdateChannel(install));

    return {
      generatedAt: new Date().toISOString(),
      overallStatus: this.overallStatus(checks),
      install,
      checks,
    };
  }

  private checkNode(): InstallDoctorCheck {
    const version = process.versions.node;
    const major = Number(version.split('.')[0]);
    if (Number.isFinite(major) && major >= 22) {
      return check('node', 'Node.js', 'ok', true, `Node.js ${version} is running.`);
    }
    return check('node', 'Node.js', 'error', true, `Node.js ${version} is too old.`, undefined, NODE_REMEDIATION);
  }

  private async checkCommand(id: string, label: string, commandAndArgs: string[], required: boolean, okSummary: string, remediation: string): Promise<InstallDoctorCheck> {
    const [command, ...args] = commandAndArgs;
    const result = await this.commandRunner(command, args, { cwd: this.appRoot, timeoutMs: 5_000 });
    if (result.ok) {
      return check(id, label, 'ok', required, okSummary, firstLine(result.stdout) || firstLine(result.stderr));
    }
    return check(
      id,
      label,
      required ? 'error' : 'warning',
      required,
      `${label} is not ready.`,
      result.error || firstLine(result.stderr) || firstLine(result.stdout),
      remediation,
    );
  }

  private async checkDataDir(): Promise<InstallDoctorCheck> {
    const probe = path.join(this.dataRoot, `.doctor-${process.pid}-${Date.now()}`);
    try {
      fs.mkdirSync(this.dataRoot, { recursive: true });
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return check('data-dir', 'Data directory', 'ok', true, 'Runtime data directory is writable.', this.dataRoot);
    } catch (err: unknown) {
      return check('data-dir', 'Data directory', 'error', true, 'Runtime data directory is not writable.', (err as Error).message, 'Choose a writable AGENT_COCKPIT_DATA_DIR and restart.');
    }
  }

  private checkAppDir(): InstallDoctorCheck {
    try {
      fs.accessSync(this.appRoot, fs.constants.W_OK);
      return check('app-dir', 'App directory', 'ok', false, 'App directory is writable.', this.appRoot);
    } catch (err: unknown) {
      return check('app-dir', 'App directory', 'warning', false, 'App directory is not writable by the server process.', (err as Error).message, 'Production updates need a writable release directory or installer-managed replacement.');
    }
  }

  private checkBuildAsset(id: string, label: string, relPath: string, required: boolean): InstallDoctorCheck {
    const assetPath = path.join(this.appRoot, relPath);
    if (fs.existsSync(assetPath)) {
      const markerPath = path.join(path.dirname(assetPath), '.agent-cockpit-build.json');
      const markerDetail = fs.existsSync(markerPath) ? `marker: ${markerPath}` : 'release asset present';
      return check(id, label, 'ok', required, `${label} is present.`, markerDetail);
    }
    return check(id, label, required ? 'error' : 'warning', required, `${label} is missing.`, relPath, `Run ${id === 'web-build' ? 'npm run web:build' : 'npm run mobile:build'}.`);
  }

  private async checkPandoc(): Promise<InstallDoctorCheck> {
    const status = await this.pandocDetector();
    if (status.available) {
      return check('pandoc', 'Pandoc', 'ok', false, status.version ? `Pandoc ${status.version} is available.` : 'Pandoc is available.', status.binaryPath || undefined);
    }
    return check('pandoc', 'Pandoc', 'warning', false, 'Pandoc is not installed.', undefined, PANDOC_REMEDIATION);
  }

  private async checkLibreOffice(): Promise<InstallDoctorCheck> {
    const status = await this.libreOfficeDetector();
    if (status.available) {
      return check('libreoffice', 'LibreOffice', 'ok', false, 'LibreOffice is available.', status.binaryPath || undefined);
    }
    return check('libreoffice', 'LibreOffice', 'warning', false, 'LibreOffice is not installed.', undefined, LIBREOFFICE_REMEDIATION);
  }

  private checkUpdateChannel(install: InstallStatus): InstallDoctorCheck {
    const updateStatus = this.updateService?.getStatus() as UpdateStatus | undefined;
    const detail = updateStatus
      ? `local=${updateStatus.localVersion}; remote=${updateStatus.remoteVersion || 'unknown'}; available=${updateStatus.updateAvailable ? 'yes' : 'no'}`
      : undefined;

    if (install.stateSource === 'corrupt') {
      return check('update-channel', 'Update channel', 'warning', false, 'Install manifest is corrupt; update channel is inferred.', install.stateError || detail, 'Repair or rewrite install.json.');
    }
    return check('update-channel', 'Update channel', 'ok', false, `${install.channel} channel via ${install.source}.`, detail);
  }

  private overallStatus(checks: InstallDoctorCheck[]): InstallDoctorCheckStatus {
    if (checks.some(item => item.required && item.status === 'error')) return 'error';
    if (checks.some(item => item.status === 'warning' || item.status === 'error')) return 'warning';
    return 'ok';
  }
}
