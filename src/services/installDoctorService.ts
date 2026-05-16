import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { InstallDoctorAction, InstallDoctorActionResult, InstallDoctorCheck, InstallDoctorCheckStatus, InstallDoctorStatus, InstallStatus, UpdateStatus } from '../types';
import type { InstallStateService } from './installStateService';
import type { UpdateService } from './updateService';
import { windowsCliCommandCandidates, windowsCmdCommandLine } from './cliCommandResolver';
import { ensureWindowsCliToolWrappersForInstall } from './windowsCliToolWrappers';
import { persistWindowsUserPathEntry } from './windowsUserPath';
import { detectLibreOffice, resetLibreOfficeDetection, type LibreOfficeStatus } from './knowledgeBase/libreOffice';
import { detectPandoc, resetPandocDetection, type PandocStatus } from './knowledgeBase/pandoc';

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const WINDOWS_CLI_TOOLS_DIR = 'cli-tools';
const NODE_REMEDIATION = 'Install Node.js 22+ from nodejs.org, or rerun the platform installer without the no-install-node option so it can install a private runtime.';
const CLAUDE_CLI_REMEDIATION = 'Install Claude Code only if you want to use that backend. Run `npm i -g @anthropic-ai/claude-code` when npm is available, then run `claude` and finish browser sign-in. Restart Agent Cockpit if the command is still not detected.';
const CODEX_CLI_REMEDIATION = 'Install Codex only if you want to use that backend. Run `npm i -g @openai/codex`, then run `codex` and sign in with ChatGPT or an API key. Restart Agent Cockpit if the command is still not detected.';
function kiroCliRemediation(): string {
  return process.platform === 'win32'
    ? 'Install Kiro only if you want to use that backend. Follow the official Windows guidance, then run `kiro-cli login` and finish browser sign-in. Restart Agent Cockpit if the command is still not detected.'
    : 'Install Kiro only if you want to use that backend. macOS/Linux: run `curl -fsSL https://cli.kiro.dev/install | bash`, then run `kiro-cli login` and finish browser sign-in. Restart Agent Cockpit if the command is still not detected.';
}

function pandocRemediation(): string {
  return process.platform === 'win32'
    ? 'Install Pandoc for DOCX knowledge-base ingestion with the official Windows installer from https://pandoc.org/installing.html. Restart Agent Cockpit after installing.'
    : 'Install Pandoc for DOCX knowledge-base ingestion. If Homebrew is already installed, macOS can run `brew install pandoc`; otherwise use the official installer from https://pandoc.org/installing.html. Restart Agent Cockpit after installing.';
}

function libreOfficeRemediation(): string {
  return process.platform === 'win32'
    ? 'Install LibreOffice for PPTX slide-image conversion with the official Windows download from https://www.libreoffice.org/download/download-libreoffice/. Restart Agent Cockpit after installing.'
    : 'Install LibreOffice for PPTX slide-image conversion. If Homebrew is already installed, macOS can run `brew install --cask libreoffice`; otherwise download LibreOffice from https://www.libreoffice.org/download/download-libreoffice/. Restart Agent Cockpit after installing.';
}

function platformCommand(command: 'npm' | 'npx', install?: InstallStatus): string[] {
  const runtimeBinDir = install?.nodeRuntime?.binDir;
  if (process.platform === 'win32' && runtimeBinDir) {
    const runtimeDir = install.nodeRuntime?.runtimeDir || runtimeBinDir;
    const nodeExe = path.join(runtimeBinDir, 'node.exe');
    const npmCli = path.join(runtimeDir, 'node_modules', 'npm', 'bin', command === 'npm' ? 'npm-cli.js' : 'npx-cli.js');
    if (fs.existsSync(nodeExe) && fs.existsSync(npmCli)) {
      return [nodeExe, npmCli];
    }
  }
  const executable = process.platform === 'win32' ? `${command}.cmd` : command;
  return [runtimeBinDir ? path.join(runtimeBinDir, executable) : executable];
}

function windowsCliToolsDir(install?: InstallStatus): string | null {
  return process.platform === 'win32' && install?.installDir
    ? path.join(install.installDir, WINDOWS_CLI_TOOLS_DIR)
    : null;
}

function windowsUserNpmDir(): string | null {
  return process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm')
    : null;
}

function uniqueWindowsDirs(dirs: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(dir);
  }
  return result;
}

function windowsCliCommandDirs(install?: InstallStatus): string[] {
  if (process.platform !== 'win32') return [];
  return uniqueWindowsDirs([
    windowsCliToolsDir(install),
    install?.nodeRuntime?.binDir,
    windowsUserNpmDir(),
  ]);
}

function npmInstallCommand(pkg: string, install?: InstallStatus): string[] {
  const npmCommand = platformCommand('npm', install);
  const cliToolsDir = windowsCliToolsDir(install);
  return cliToolsDir
    ? [...npmCommand, '--prefix', cliToolsDir, 'i', '-g', pkg]
    : [...npmCommand, 'i', '-g', pkg];
}

function platformCliCommands(command: 'claude' | 'codex', install?: InstallStatus): string[][] {
  if (process.platform !== 'win32') return [[command]];
  const vendor = command === 'claude' ? 'claude-code' : 'codex';
  return windowsCliCommandCandidates(vendor, command, process.env, windowsCliCommandDirs(install))
    .map(candidate => candidate.argsPrefix?.length
      ? [candidate.command, ...candidate.argsPrefix]
      : [candidate.command]);
}

function platformPm2Command(appRoot: string, install?: InstallStatus): { command: string[]; summary: string } {
  if (process.platform === 'win32') {
    const pm2Root = install?.appDir && fs.existsSync(install.appDir) ? install.appDir : appRoot;
    const runtimeBinDir = install?.nodeRuntime?.binDir;
    const nodeExe = runtimeBinDir && fs.existsSync(path.join(runtimeBinDir, 'node.exe'))
      ? path.join(runtimeBinDir, 'node.exe')
      : 'node.exe';
    return {
      command: [nodeExe, path.join(pm2Root, 'node_modules', 'pm2', 'bin', 'pm2'), '--version'],
      summary: 'Local PM2 command is available.',
    };
  }
  return {
    command: [...platformCommand('npx', install), '--no-install', 'pm2', '--version'],
    summary: 'Local PM2 is available through npx.',
  };
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

type CommandRunner = (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<CommandResult>;

interface InstallActionDefinition {
  action: InstallDoctorAction;
  command?: string[];
}

interface InstallDoctorServiceOptions {
  appRoot: string;
  dataRoot: string;
  installStateService: InstallStateService;
  updateService?: UpdateService | null;
  commandRunner?: CommandRunner;
  installRunner?: CommandRunner;
  detectHomebrew?: () => Promise<boolean>;
  detectPandoc?: () => Promise<PandocStatus>;
  detectLibreOffice?: () => Promise<LibreOfficeStatus>;
  resetPandocDetection?: () => void;
  resetLibreOfficeDetection?: () => void;
}

async function defaultCommandRunner(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
  try {
    const resolved = resolveExecCommand(command, args);
    const result = await execFileAsync(resolved.command, resolved.args, {
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

function resolveExecCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32' || !/[.](?:cmd|bat)$/i.test(command)) {
    return { command, args };
  }
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', windowsCmdCommandLine(command, args)],
  };
}

function firstLine(value: string | undefined): string | undefined {
  return value ? value.split(/\r?\n/).find(Boolean) : undefined;
}

function check(id: string, label: string, status: InstallDoctorCheckStatus, required: boolean, summary: string, detail?: string, remediation?: string, installActions?: InstallDoctorAction[]): InstallDoctorCheck {
  const result: InstallDoctorCheck = { id, label, status, required, summary };
  if (detail) result.detail = detail;
  if (remediation) result.remediation = remediation;
  if (installActions && installActions.length > 0) result.installActions = installActions;
  return result;
}

export class InstallDoctorService {
  private readonly appRoot: string;
  private readonly dataRoot: string;
  private readonly installStateService: InstallStateService;
  private readonly updateService: UpdateService | null;
  private readonly commandRunner: CommandRunner;
  private readonly installRunner: CommandRunner;
  private readonly homebrewDetector: () => Promise<boolean>;
  private readonly pandocDetector: () => Promise<PandocStatus>;
  private readonly libreOfficeDetector: () => Promise<LibreOfficeStatus>;
  private readonly resetPandocDetector: () => void;
  private readonly resetLibreOfficeDetector: () => void;
  private readonly installInProgress = new Set<string>();

  constructor(options: InstallDoctorServiceOptions) {
    this.appRoot = options.appRoot;
    this.dataRoot = options.dataRoot;
    this.installStateService = options.installStateService;
    this.updateService = options.updateService ?? null;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.installRunner = options.installRunner ?? this.commandRunner;
    this.homebrewDetector = options.detectHomebrew ?? (() => this.defaultHasHomebrew());
    this.pandocDetector = options.detectPandoc ?? detectPandoc;
    this.libreOfficeDetector = options.detectLibreOffice ?? detectLibreOffice;
    this.resetPandocDetector = options.resetPandocDetection ?? resetPandocDetection;
    this.resetLibreOfficeDetector = options.resetLibreOfficeDetection ?? resetLibreOfficeDetection;
  }

  async getStatus(): Promise<InstallDoctorStatus> {
    const install = this.installStateService.getStatus();
    const checks: InstallDoctorCheck[] = [];
    const npmCommand = platformCommand('npm', install);
    const pm2Command = platformPm2Command(this.appRoot, install);

    checks.push(this.checkNode());
    checks.push(await this.checkCommand('npm', 'npm', [...npmCommand, '--version'], true, 'npm is available.', NODE_REMEDIATION));
    checks.push(await this.checkCommand('pm2', 'PM2', pm2Command.command, true, pm2Command.summary, 'Run npm ci in the app directory, then retry.'));
    checks.push(await this.checkDataDir());
    checks.push(this.checkAppDir());
    const startupCheck = await this.checkWindowsStartup(install);
    if (startupCheck) checks.push(startupCheck);
    checks.push(this.checkBuildAsset('web-build', 'Desktop web build', 'public/v2-built/index.html', true));
    checks.push(this.checkBuildAsset('mobile-build', 'Mobile PWA build', 'public/mobile-built/index.html', false));
    const homebrewAvailable = await this.homebrewDetector();
    checks.push(await this.checkCommandCandidates('claude-cli', 'Claude Code CLI', platformCliCommands('claude', install).map(command => [...command, '--version']), false, 'Claude Code CLI responded.', CLAUDE_CLI_REMEDIATION, this.actionsForCheck('claude-cli', homebrewAvailable, install)));
    checks.push(await this.checkCommandCandidates('codex-cli', 'Codex CLI', platformCliCommands('codex', install).map(command => [...command, '--version']), false, 'Codex CLI responded.', CODEX_CLI_REMEDIATION, this.actionsForCheck('codex-cli', homebrewAvailable, install)));
    checks.push(await this.checkCommand('kiro-cli', 'Kiro CLI', ['kiro-cli', '--version'], false, 'Kiro CLI responded.', kiroCliRemediation(), this.actionsForCheck('kiro-cli', homebrewAvailable, install)));
    checks.push(await this.checkPandoc(homebrewAvailable));
    checks.push(await this.checkLibreOffice(homebrewAvailable));
    checks.push(this.checkUpdateChannel(install));

    return {
      generatedAt: new Date().toISOString(),
      overallStatus: this.overallStatus(checks),
      install,
      checks,
    };
  }

  async runInstallAction(actionId: string, opts: { hasActiveStreams?: () => boolean } = {}): Promise<InstallDoctorActionResult> {
    if (this.installInProgress.size > 0) {
      return { success: false, steps: [], error: 'Install action already in progress.' };
    }
    if (opts.hasActiveStreams && opts.hasActiveStreams()) {
      return {
        success: false,
        steps: [],
        error: 'Cannot install a dependency while conversations are actively running. Please wait for them to complete or abort them first.',
      };
    }

    const definition = await this.installActionDefinition(actionId);
    if (!definition) {
      return { success: false, steps: [], error: 'Install action not found.' };
    }
    if (definition.action.kind !== 'command' || !definition.command || definition.command.length === 0) {
      return { success: false, action: definition.action, steps: [], error: 'This install action opens a download page instead of running on the server.' };
    }

    this.installInProgress.add(actionId);
    const steps = [];
    try {
      const [command, ...args] = definition.command;
      const result = await this.installRunner(command, args, { cwd: this.appRoot, timeoutMs: INSTALL_TIMEOUT_MS });
      const output = commandOutput(result);
      steps.push({ name: definition.command.join(' '), success: result.ok, output });
      if (!result.ok) {
        return {
          success: false,
          action: definition.action,
          steps,
          error: result.error || firstLine(result.stderr) || firstLine(result.stdout) || 'Install command failed.',
        };
      }

      const pathResult = await this.persistWindowsCliToolsPath(actionId);
      if (pathResult) {
        const pathOutput = commandOutput(pathResult);
        steps.push({ name: 'Add Agent Cockpit CLI tools to user PATH', success: pathResult.ok, output: pathOutput });
        if (!pathResult.ok) {
          return {
            success: false,
            action: definition.action,
            steps,
            error: pathResult.error || firstLine(pathResult.stderr) || firstLine(pathResult.stdout) || 'Failed to update the current user PATH.',
          };
        }
      }

      const wrapperResult = this.repairWindowsCliToolWrappers(actionId);
      if (wrapperResult) {
        const output = [
          wrapperResult.updated.length > 0 ? `Updated: ${wrapperResult.updated.join(', ')}` : '',
          wrapperResult.skipped.length > 0 ? `Skipped: ${wrapperResult.skipped.join(', ')}` : '',
          wrapperResult.error || '',
        ].filter(Boolean).join('\n');
        steps.push({ name: 'Repair Agent Cockpit CLI wrappers', success: wrapperResult.ok, output });
        if (!wrapperResult.ok) {
          return {
            success: false,
            action: definition.action,
            steps,
            error: wrapperResult.error || 'Failed to repair Agent Cockpit CLI wrappers.',
          };
        }
      }

      this.invalidateDetectionForAction(actionId);
      return {
        success: true,
        action: definition.action,
        steps,
        doctor: await this.getStatus(),
      };
    } finally {
      this.installInProgress.delete(actionId);
    }
  }

  private checkNode(): InstallDoctorCheck {
    const version = process.versions.node;
    const major = Number(version.split('.')[0]);
    if (Number.isFinite(major) && major >= 22) {
      return check('node', 'Node.js', 'ok', true, `Node.js ${version} is running.`);
    }
    return check('node', 'Node.js', 'error', true, `Node.js ${version} is too old.`, undefined, NODE_REMEDIATION);
  }

  private async checkCommand(id: string, label: string, commandAndArgs: string[], required: boolean, okSummary: string, remediation: string, installActions?: InstallDoctorAction[]): Promise<InstallDoctorCheck> {
    return this.checkCommandCandidates(id, label, [commandAndArgs], required, okSummary, remediation, installActions);
  }

  private async checkCommandCandidates(id: string, label: string, commandCandidates: string[][], required: boolean, okSummary: string, remediation: string, installActions?: InstallDoctorAction[]): Promise<InstallDoctorCheck> {
    let lastResult: CommandResult | null = null;
    for (const commandAndArgs of commandCandidates) {
      const [command, ...args] = commandAndArgs;
      const result = await this.commandRunner(command, args, { cwd: this.appRoot, timeoutMs: 5_000 });
      if (result.ok) {
        return check(id, label, 'ok', required, okSummary, firstLine(result.stdout) || firstLine(result.stderr));
      }
      lastResult = result;
    }
    const result = lastResult || { ok: false, stdout: '', stderr: '', error: 'not found' };
    return check(
      id,
      label,
      required ? 'error' : 'warning',
      required,
      `${label} is not ready.`,
      result.error || firstLine(result.stderr) || firstLine(result.stdout),
      remediation,
      installActions,
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

  private async checkWindowsStartup(install: InstallStatus): Promise<InstallDoctorCheck | null> {
    if (process.platform !== 'win32') return null;
    if (install.startup?.kind === 'manual') {
      return check('windows-logon-startup', 'Windows logon startup', 'ok', false, 'Logon startup is disabled for this install.', undefined, 'Rerun the Windows installer without -NoAutoStart to enable startup on login.');
    }
    const taskName = install.startup?.name || 'AgentCockpit';
    const result = await this.commandRunner('schtasks.exe', ['/Query', '/TN', taskName], { cwd: this.appRoot, timeoutMs: 5_000 });
    if (result.ok) {
      return check('windows-logon-startup', 'Windows logon startup', 'ok', false, 'Agent Cockpit is registered to start when this Windows user logs in.', firstLine(result.stdout) || taskName);
    }
    return check('windows-logon-startup', 'Windows logon startup', 'warning', false, 'Agent Cockpit is not registered to start on Windows login.', result.error || firstLine(result.stderr) || firstLine(result.stdout), 'Rerun the Windows installer to repair the current-user ONLOGON scheduled task.');
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

  private async checkPandoc(homebrewAvailable: boolean): Promise<InstallDoctorCheck> {
    const status = await this.pandocDetector();
    if (status.available) {
      return check('pandoc', 'Pandoc', 'ok', false, status.version ? `Pandoc ${status.version} is available.` : 'Pandoc is available.', status.binaryPath || undefined);
    }
    return check('pandoc', 'Pandoc', 'warning', false, 'Pandoc is not installed.', undefined, pandocRemediation(), this.actionsForCheck('pandoc', homebrewAvailable));
  }

  private async checkLibreOffice(homebrewAvailable: boolean): Promise<InstallDoctorCheck> {
    const status = await this.libreOfficeDetector();
    if (status.available) {
      return check('libreoffice', 'LibreOffice', 'ok', false, 'LibreOffice is available.', status.binaryPath || undefined);
    }
    return check('libreoffice', 'LibreOffice', 'warning', false, 'LibreOffice is not installed.', undefined, libreOfficeRemediation(), this.actionsForCheck('libreoffice', homebrewAvailable));
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

  private async defaultHasHomebrew(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    const result = await this.commandRunner('brew', ['--version'], { cwd: this.appRoot, timeoutMs: 5_000 });
    return result.ok;
  }

  private async installActionDefinition(actionId: string): Promise<InstallActionDefinition | null> {
    const homebrewAvailable = await this.homebrewDetector();
    return this.actionDefinitions(homebrewAvailable, this.installStateService.getStatus()).get(actionId) || null;
  }

  private actionsForCheck(checkId: string, homebrewAvailable: boolean, install?: InstallStatus): InstallDoctorAction[] {
    return [...this.actionDefinitions(homebrewAvailable, install).values()]
      .filter((definition) => definition.action.id.startsWith(`${checkId}:`))
      .map((definition) => definition.action)
      .sort((a, b) => {
        if (a.kind === b.kind) return 0;
        return a.kind === 'command' ? -1 : 1;
      });
  }

  private actionDefinitions(homebrewAvailable: boolean, install?: InstallStatus): Map<string, InstallActionDefinition> {
    const claudeNpmInstall = npmInstallCommand('@anthropic-ai/claude-code@latest', install);
    const codexNpmInstall = npmInstallCommand('@openai/codex@latest', install);
    const definitions: InstallActionDefinition[] = [
      {
        action: { id: 'claude-cli:npm-install', kind: 'command', label: 'Install Claude Code', description: 'Installs the Claude Code CLI with npm.', command: claudeNpmInstall },
        command: claudeNpmInstall,
      },
      { action: { id: 'claude-cli:docs', kind: 'link', label: 'Open docs', href: 'https://code.claude.com/docs/en/setup' } },
      {
        action: { id: 'codex-cli:npm-install', kind: 'command', label: 'Install Codex', description: 'Installs the Codex CLI with npm.', command: codexNpmInstall },
        command: codexNpmInstall,
      },
      { action: { id: 'codex-cli:docs', kind: 'link', label: 'Open docs', href: 'https://github.com/openai/codex' } },
      { action: { id: 'kiro-cli:docs', kind: 'link', label: 'Open docs', href: 'https://kiro.dev/docs/cli/installation/' } },
      { action: { id: 'pandoc:official-download', kind: 'link', label: 'Open installer', href: 'https://pandoc.org/installing.html' } },
      { action: { id: 'libreoffice:official-download', kind: 'link', label: 'Open download', href: 'https://www.libreoffice.org/download/download-libreoffice/' } },
    ];

    if (process.platform !== 'win32') {
      definitions.push({
        action: { id: 'kiro-cli:official-install', kind: 'command', label: 'Install Kiro', description: 'Runs the official Kiro CLI installer.', command: ['sh', '-c', 'curl -fsSL https://cli.kiro.dev/install | bash'] },
        command: ['sh', '-c', 'curl -fsSL https://cli.kiro.dev/install | bash'],
      });
    }

    if (homebrewAvailable) {
      definitions.push({
        action: { id: 'pandoc:brew-install', kind: 'command', label: 'Install with Homebrew', description: 'Installs Pandoc using the existing Homebrew installation.', command: ['brew', 'install', 'pandoc'] },
        command: ['brew', 'install', 'pandoc'],
      });
      definitions.push({
        action: { id: 'libreoffice:brew-install', kind: 'command', label: 'Install with Homebrew', description: 'Installs LibreOffice using the existing Homebrew installation.', command: ['brew', 'install', '--cask', 'libreoffice'] },
        command: ['brew', 'install', '--cask', 'libreoffice'],
      });
    }

    return new Map(definitions.map((definition) => [definition.action.id, definition]));
  }

  private invalidateDetectionForAction(actionId: string): void {
    if (actionId.startsWith('pandoc:')) this.resetPandocDetector();
    if (actionId.startsWith('libreoffice:')) this.resetLibreOfficeDetector();
  }

  private async persistWindowsCliToolsPath(actionId: string): Promise<CommandResult | null> {
    if (process.platform !== 'win32') return null;
    if (!actionId.startsWith('claude-cli:') && !actionId.startsWith('codex-cli:')) return null;
    const install = this.installStateService.getStatus();
    const dir = windowsCliToolsDir(install);
    if (!dir) return null;
    fs.mkdirSync(dir, { recursive: true });
    return persistWindowsUserPathEntry(dir, this.commandRunner);
  }

  private repairWindowsCliToolWrappers(actionId: string) {
    if (process.platform !== 'win32') return null;
    const vendor = actionId.startsWith('claude-cli:')
      ? 'claude-code'
      : actionId.startsWith('codex-cli:')
        ? 'codex'
        : null;
    if (!vendor) return null;
    return ensureWindowsCliToolWrappersForInstall(
      this.installStateService.getStatus(),
      [vendor],
      true,
    );
  }
}

function commandOutput(result: CommandResult): string {
  const parts = [result.stdout, result.stderr, result.error].filter(Boolean);
  const output = parts.join('\n').trim();
  return output.length > 12_000 ? `${output.slice(0, 12_000)}\n...` : output;
}
