import fs from 'fs';
import path from 'path';
import type { CliVendor, InstallNodeRuntime, InstallStatus } from '../types';

const WINDOWS_CLI_TOOLS_DIR = 'cli-tools';

type WrapperVendor = Extract<CliVendor, 'claude-code' | 'codex'>;

interface EnsureWindowsCliToolWrappersOptions {
  cliToolsDir: string | null | undefined;
  nodeExe: string | null | undefined;
  vendors?: WrapperVendor[];
  requireTargets?: boolean;
}

export interface WindowsCliToolWrapperResult {
  ok: boolean;
  updated: string[];
  skipped: string[];
  error?: string;
}

interface WrapperSpec {
  commandName: 'claude' | 'codex';
  targetPath: string;
  ps1: string;
  cmd: string;
}

export function ensureWindowsCliToolWrappersForInstall(
  install: Pick<InstallStatus, 'installDir' | 'nodeRuntime'>,
  vendors?: WrapperVendor[],
  requireTargets = false,
): WindowsCliToolWrapperResult {
  const cliToolsDir = process.platform === 'win32' && install.installDir
    ? path.join(install.installDir, WINDOWS_CLI_TOOLS_DIR)
    : null;
  return ensureWindowsCliToolWrappers({
    cliToolsDir,
    nodeExe: windowsPrivateNodeExe(install.nodeRuntime),
    vendors,
    requireTargets,
  });
}

export function ensureWindowsCliToolWrappers(options: EnsureWindowsCliToolWrappersOptions): WindowsCliToolWrapperResult {
  const updated: string[] = [];
  const skipped: string[] = [];
  if (process.platform !== 'win32') {
    return { ok: true, updated, skipped: ['not-windows'] };
  }
  const cliToolsDir = options.cliToolsDir || '';
  if (!cliToolsDir) {
    return { ok: true, updated, skipped: ['missing-cli-tools-dir'] };
  }
  const nodeExe = options.nodeExe || '';
  if (!nodeExe || !fs.existsSync(nodeExe)) {
    return { ok: true, updated, skipped: ['missing-private-node'] };
  }

  const vendors: WrapperVendor[] = options.vendors && options.vendors.length > 0
    ? options.vendors
    : ['claude-code', 'codex'];

  try {
    fs.mkdirSync(cliToolsDir, { recursive: true });
    for (const vendor of vendors) {
      const spec = wrapperSpecForVendor(vendor, cliToolsDir, nodeExe);
      if (!fs.existsSync(spec.targetPath)) {
        if (options.requireTargets) {
          return {
            ok: false,
            updated,
            skipped,
            error: `Expected ${spec.commandName} package entrypoint is missing: ${spec.targetPath}`,
          };
        }
        skipped.push(`${spec.commandName}:missing-entrypoint`);
        continue;
      }
      fs.writeFileSync(path.join(cliToolsDir, `${spec.commandName}.ps1`), spec.ps1);
      fs.writeFileSync(path.join(cliToolsDir, `${spec.commandName}.cmd`), spec.cmd);
      updated.push(spec.commandName);
    }
    return { ok: true, updated, skipped };
  } catch (err: unknown) {
    return {
      ok: false,
      updated,
      skipped,
      error: (err as Error).message || 'Failed to write Windows CLI wrappers.',
    };
  }
}

export function windowsPrivateNodeExe(nodeRuntime?: InstallNodeRuntime | null): string | null {
  const binDir = nodeRuntime?.binDir || null;
  if (!binDir) return null;
  const nodeExe = path.join(binDir, 'node.exe');
  return fs.existsSync(nodeExe) ? nodeExe : null;
}

function wrapperSpecForVendor(vendor: WrapperVendor, cliToolsDir: string, nodeExe: string): WrapperSpec {
  if (vendor === 'codex') {
    const targetPath = path.join(cliToolsDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    return {
      commandName: 'codex',
      targetPath,
      ps1: codexPowerShellWrapper(nodeExe, targetPath),
      cmd: codexCmdWrapper(nodeExe, targetPath),
    };
  }
  const targetPath = path.join(cliToolsDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return {
    commandName: 'claude',
    targetPath,
    ps1: executablePowerShellWrapper('Claude Code', targetPath),
    cmd: executableCmdWrapper('Claude Code', targetPath),
  };
}

function codexPowerShellWrapper(nodeExe: string, codexJs: string): string {
  return [
    '$ErrorActionPreference = "Stop"',
    `$node = ${psSingleQuoted(nodeExe)}`,
    `$target = ${psSingleQuoted(codexJs)}`,
    'if (-not (Test-Path -LiteralPath $node)) {',
    '  Write-Error "Agent Cockpit private Node.js runtime was not found. Rerun the Agent Cockpit installer or self-update."',
    '  exit 1',
    '}',
    'if (-not (Test-Path -LiteralPath $target)) {',
    '  Write-Error "Codex CLI package entrypoint was not found. Reinstall Codex from Agent Cockpit."',
    '  exit 1',
    '}',
    '$nodeDir = Split-Path -Parent $node',
    '$env:PATH = "$nodeDir;$env:PATH"',
    '& $node $target @args',
    'exit $LASTEXITCODE',
    '',
  ].join('\n');
}

function codexCmdWrapper(nodeExe: string, codexJs: string): string {
  return [
    '@ECHO off',
    'SETLOCAL',
    `SET "NODE_EXE=${nodeExe}"`,
    `SET "CODEX_JS=${codexJs}"`,
    'IF NOT EXIST "%NODE_EXE%" (',
    '  ECHO Agent Cockpit private Node.js runtime was not found. Rerun the Agent Cockpit installer or self-update. 1>&2',
    '  EXIT /B 1',
    ')',
    'IF NOT EXIST "%CODEX_JS%" (',
    '  ECHO Codex CLI package entrypoint was not found. Reinstall Codex from Agent Cockpit. 1>&2',
    '  EXIT /B 1',
    ')',
    'FOR %%I IN ("%NODE_EXE%") DO SET "PATH=%%~dpI;%PATH%"',
    '"%NODE_EXE%" "%CODEX_JS%" %*',
    'EXIT /B %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

function executablePowerShellWrapper(label: string, executable: string): string {
  return [
    '$ErrorActionPreference = "Stop"',
    `$target = ${psSingleQuoted(executable)}`,
    'if (-not (Test-Path -LiteralPath $target)) {',
    `  Write-Error "${label} CLI executable was not found. Reinstall ${label} from Agent Cockpit."`,
    '  exit 1',
    '}',
    '& $target @args',
    'exit $LASTEXITCODE',
    '',
  ].join('\n');
}

function executableCmdWrapper(label: string, executable: string): string {
  return [
    '@ECHO off',
    'SETLOCAL',
    `SET "TARGET=${executable}"`,
    'IF NOT EXIST "%TARGET%" (',
    `  ECHO ${label} CLI executable was not found. Reinstall ${label} from Agent Cockpit. 1>&2`,
    '  EXIT /B 1',
    ')',
    '"%TARGET%" %*',
    'EXIT /B %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
