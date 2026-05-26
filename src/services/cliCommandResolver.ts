import fs from 'fs';
import path from 'path';
import type { CliHarness } from '../types';

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

const HARNESS_COMMANDS: Partial<Record<CliHarness, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

const HARNESS_PACKAGES: Partial<Record<CliHarness, string[]>> = {
  'claude-code': ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'],
  codex: ['node_modules', '@openai', 'codex', 'bin', 'codex.js'],
};

const POSIX_USER_BIN_DIRS = [
  '.local/bin',
  '.npm-global/bin',
  '.npm/bin',
  '.bun/bin',
  '.yarn/bin',
];

export function resolveCliCommandForRuntime(
  harness: CliHarness,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): CliCommandResolution {
  if (process.platform !== 'win32') {
    const candidates = nonWindowsCliCommandCandidates(harness, command, env);
    const existing = candidates.find(candidate => candidateExists(candidate, env));
    return existing || { command, displayCommand: command };
  }

  const explicit = resolveExplicitWindowsCommand(command, harness, env);
  if (explicit) return explicit;

  const defaultCommand = HARNESS_COMMANDS[harness] || command;
  const candidates = windowsCliCommandCandidates(harness, defaultCommand, env);
  const existing = candidates.find(candidate => candidateExists(candidate, env));
  if (existing) return existing;

  return {
    command: defaultCommand.endsWith('.cmd') ? defaultCommand : `${defaultCommand}.cmd`,
    windowsCmdShim: true,
    displayCommand: command,
  };
}

export function windowsCliCommandCandidates(
  harness: CliHarness,
  command: string = HARNESS_COMMANDS[harness] || '',
  env: NodeJS.ProcessEnv = process.env,
  extraPrefixes: string[] = [],
): CliCommandResolution[] {
  if (process.platform !== 'win32') return [{ command, displayCommand: command }];
  const defaultCommand = command.replace(/[.](?:cmd|exe)$/i, '');
  const candidates: CliCommandResolution[] = [];
  const prefixes = windowsCliPrefixes(env, extraPrefixes);
  for (const prefix of prefixes) {
    const packageCandidate = windowsPackageCandidate(harness, prefix, env);
    if (packageCandidate && candidateExists(packageCandidate, env)) candidates.push(packageCandidate);
  }
  candidates.push(...windowsPathPackageCandidates(harness, env));
  for (const prefix of prefixes) {
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
    command: `${defaultCommand}.exe`,
    displayCommand: `${defaultCommand}.exe`,
  });
  candidates.push({
    command: `${defaultCommand}.cmd`,
    windowsCmdShim: true,
    displayCommand: `${defaultCommand}.cmd`,
  });
  return dedupeCandidates(candidates);
}

export function nonWindowsCliCommandCandidates(
  harness: CliHarness,
  command: string = HARNESS_COMMANDS[harness] || '',
  env: NodeJS.ProcessEnv = process.env,
): CliCommandResolution[] {
  if (process.platform === 'win32') return [{ command, displayCommand: command }];
  if (command.includes('/') || command.includes('\\')) {
    return [{ command, displayCommand: command }];
  }

  const candidates: CliCommandResolution[] = [{ command, displayCommand: command }];
  for (const dir of nonWindowsCliSearchDirs(env)) {
    const candidate = path.join(dir, command);
    candidates.push({ command: candidate, displayCommand: candidate });
  }
  if (harness === 'claude-code') {
    const home = env.HOME;
    if (home) {
      const candidate = path.join(home, '.claude', 'local', command);
      candidates.push({ command: candidate, displayCommand: candidate });
    }
  }
  if (harness === 'opencode') {
    const home = env.HOME;
    if (home) {
      const candidate = path.join(home, '.opencode', 'bin', command);
      candidates.push({ command: candidate, displayCommand: candidate });
    }
  }
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
  harness: CliHarness,
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
  if (harness === 'codex' && fs.existsSync(command) && /[.]js$/i.test(command)) {
    return {
      command: windowsNodeCommand(env),
      argsPrefix: [command],
      displayCommand: command,
    };
  }
  return { command, displayCommand: command };
}

function windowsPackageCandidate(harness: CliHarness, prefix: string, env: NodeJS.ProcessEnv): CliCommandResolution | null {
  const rel = HARNESS_PACKAGES[harness];
  if (!rel) return null;
  const target = joinForBase(prefix, ...rel);
  if (harness === 'codex') {
    return {
      command: windowsNodeCommand(env),
      argsPrefix: [target],
      displayCommand: target,
    };
  }
  return { command: target, displayCommand: target };
}

function windowsPathPackageCandidates(harness: CliHarness, env: NodeJS.ProcessEnv): CliCommandResolution[] {
  const candidates: CliCommandResolution[] = [];
  for (const prefix of windowsPathDirs(env)) {
    const packageCandidate = windowsPackageCandidate(harness, prefix, env);
    if (packageCandidate && candidateExists(packageCandidate, env)) candidates.push(packageCandidate);
  }
  return candidates;
}

function candidateExists(candidate: CliCommandResolution, env: NodeJS.ProcessEnv): boolean {
  if (candidate.argsPrefix && candidate.argsPrefix.length > 0) {
    return commandExists(candidate.command, env) && fs.existsSync(candidate.argsPrefix[0]);
  }
  if (candidate.command.includes('/') || candidate.command.includes('\\')) {
    return fs.existsSync(candidate.command);
  }
  return commandExists(candidate.command, env);
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

function commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  if (command.includes('/') || command.includes('\\')) {
    return fs.existsSync(command);
  }
  for (const dir of pathDirs(env)) {
    if (fs.existsSync(joinForBase(dir, command))) return true;
  }
  return false;
}

function windowsPathDirs(env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH || env.Path || '';
  return uniqueDirs(pathValue.split(';').map(dir => dir.trim().replace(/^"+|"+$/g, '')).filter(Boolean));
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH || env.Path || '';
  const delimiter = process.platform === 'win32' ? ';' : path.delimiter;
  return uniqueDirs(pathValue.split(delimiter).map(dir => dir.trim().replace(/^"+|"+$/g, '')).filter(Boolean));
}

function nonWindowsCliSearchDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME;
  const homeDirs = home ? POSIX_USER_BIN_DIRS.map(dir => path.join(home, dir)) : [];
  return uniqueDirs([
    ...homeDirs,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]);
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
