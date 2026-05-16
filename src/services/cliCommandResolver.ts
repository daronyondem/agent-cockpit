import fs from 'fs';
import path from 'path';
import type { CliVendor } from '../types';

export interface CliCommandResolution {
  command: string;
  argsPrefix?: string[];
  windowsCmdShim?: boolean;
  displayCommand?: string;
}

export interface CliInvocation {
  command: string;
  args: string[];
}

const WINDOWS_CLI_TOOLS_DIR = 'cli-tools';

const VENDOR_COMMANDS: Partial<Record<CliVendor, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
};

const VENDOR_PACKAGES: Partial<Record<CliVendor, string[]>> = {
  'claude-code': ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'],
  codex: ['node_modules', '@openai', 'codex', 'bin', 'codex.js'],
};

export function resolveCliCommandForRuntime(
  vendor: CliVendor,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): CliCommandResolution {
  if (process.platform !== 'win32') {
    return { command, displayCommand: command };
  }

  const explicit = resolveExplicitWindowsCommand(command, vendor, env);
  if (explicit) return explicit;

  const defaultCommand = VENDOR_COMMANDS[vendor] || command;
  const candidates = windowsCliCommandCandidates(vendor, defaultCommand, env);
  const existing = candidates.find(candidateExists);
  if (existing) return existing;

  return {
    command: defaultCommand.endsWith('.cmd') ? defaultCommand : `${defaultCommand}.cmd`,
    windowsCmdShim: true,
    displayCommand: command,
  };
}

export function windowsCliCommandCandidates(
  vendor: CliVendor,
  command: string = VENDOR_COMMANDS[vendor] || '',
  env: NodeJS.ProcessEnv = process.env,
  extraPrefixes: string[] = [],
): CliCommandResolution[] {
  if (process.platform !== 'win32') return [{ command, displayCommand: command }];
  const defaultCommand = command.replace(/[.](?:cmd|exe)$/i, '');
  const candidates: CliCommandResolution[] = [];
  for (const prefix of windowsCliPrefixes(env, extraPrefixes)) {
    const packageCandidate = windowsPackageCandidate(vendor, prefix, env);
    if (packageCandidate && candidateExists(packageCandidate)) candidates.push(packageCandidate);
    const exe = joinForBase(prefix, `${defaultCommand}.exe`);
    if (fs.existsSync(exe)) {
      candidates.push({
        command: exe,
        displayCommand: exe,
      });
    }
    candidates.push({
      command: joinForBase(prefix, `${defaultCommand}.cmd`),
      windowsCmdShim: true,
      displayCommand: joinForBase(prefix, `${defaultCommand}.cmd`),
    });
  }
  candidates.push({
    command: `${defaultCommand}.cmd`,
    windowsCmdShim: true,
    displayCommand: `${defaultCommand}.cmd`,
  });
  return dedupeCandidates(candidates);
}

export function buildCliCommandInvocation(runtime: CliCommandResolution, args: string[]): CliInvocation {
  const fullArgs = [...(runtime.argsPrefix || []), ...args];
  if (process.platform === 'win32' && runtime.windowsCmdShim) {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', windowsCmdCommandLine(runtime.command, fullArgs)],
    };
  }
  return {
    command: runtime.command,
    args: fullArgs,
  };
}

export function windowsCmdCommandLine(command: string, args: string[]): string {
  return `"${[command, ...args].map(windowsCmdQuote).join(' ')}"`;
}

function resolveExplicitWindowsCommand(
  command: string,
  vendor: CliVendor,
  env: NodeJS.ProcessEnv,
): CliCommandResolution | null {
  if (!command.includes('/') && !command.includes('\\')) return null;
  if (/[.](?:cmd|bat)$/i.test(command)) {
    return { command, windowsCmdShim: true, displayCommand: command };
  }
  if (/[.]js$/i.test(command)) {
    return {
      command: windowsNodeCommand(env),
      argsPrefix: [command],
      displayCommand: command,
    };
  }
  if (vendor === 'codex' && fs.existsSync(command) && /[.]js$/i.test(command)) {
    return {
      command: windowsNodeCommand(env),
      argsPrefix: [command],
      displayCommand: command,
    };
  }
  return { command, displayCommand: command };
}

function windowsPackageCandidate(vendor: CliVendor, prefix: string, env: NodeJS.ProcessEnv): CliCommandResolution | null {
  const rel = VENDOR_PACKAGES[vendor];
  if (!rel) return null;
  const target = joinForBase(prefix, ...rel);
  if (vendor === 'codex') {
    return {
      command: windowsNodeCommand(env),
      argsPrefix: [target],
      displayCommand: target,
    };
  }
  return { command: target, displayCommand: target };
}

function candidateExists(candidate: CliCommandResolution): boolean {
  if (candidate.argsPrefix && candidate.argsPrefix.length > 0) {
    return fs.existsSync(candidate.command) && fs.existsSync(candidate.argsPrefix[0]);
  }
  if (candidate.command.includes('/') || candidate.command.includes('\\')) {
    return fs.existsSync(candidate.command);
  }
  return false;
}

function windowsNodeCommand(env: NodeJS.ProcessEnv): string {
  if (process.execPath && fs.existsSync(process.execPath)) return process.execPath;
  const installDir = installDirFromEnv(env);
  if (installDir) {
    const runtimeDir = joinForBase(installDir, 'runtime');
    try {
      const entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
      const nodeDir = entries
        .filter(entry => entry.isDirectory() && /^node-v22[.-]/i.test(entry.name))
        .map(entry => joinForBase(runtimeDir, entry.name))
        .find(dir => fs.existsSync(joinForBase(dir, 'node.exe')));
      if (nodeDir) return joinForBase(nodeDir, 'node.exe');
    } catch {}
  }
  return 'node.exe';
}

function windowsCliPrefixes(env: NodeJS.ProcessEnv, extraPrefixes: string[]): string[] {
  const installDir = installDirFromEnv(env);
  const localAppData = env.LOCALAPPDATA;
  const appData = env.APPDATA;
  return uniqueDirs([
    ...extraPrefixes,
    installDir ? joinForBase(installDir, WINDOWS_CLI_TOOLS_DIR) : null,
    localAppData ? joinForBase(localAppData, 'Agent Cockpit', WINDOWS_CLI_TOOLS_DIR) : null,
    appData ? joinForBase(appData, 'npm') : null,
  ]);
}

function installDirFromEnv(env: NodeJS.ProcessEnv): string | null {
  const dataDir = env.AGENT_COCKPIT_DATA_DIR;
  if (dataDir) {
    const normalized = dataDir.replace(/[\\/]+$/, '');
    const lastSep = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
    if (lastSep > 0 && normalized.slice(lastSep + 1).toLowerCase() === 'data') {
      return normalized.slice(0, lastSep);
    }
  }
  return env.LOCALAPPDATA ? joinForBase(env.LOCALAPPDATA, 'Agent Cockpit') : null;
}

function uniqueDirs(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function dedupeCandidates(values: CliCommandResolution[]): CliCommandResolution[] {
  const seen = new Set<string>();
  const result: CliCommandResolution[] = [];
  for (const value of values) {
    const key = JSON.stringify({
      command: value.command.toLowerCase(),
      argsPrefix: (value.argsPrefix || []).map(item => item.toLowerCase()),
      windowsCmdShim: !!value.windowsCmdShim,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function joinForBase(base: string, ...parts: string[]): string {
  return base.includes('\\') || /^[A-Za-z]:[\\/]/.test(base)
    ? path.win32.join(base, ...parts)
    : path.join(base, ...parts);
}

function windowsCmdQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
