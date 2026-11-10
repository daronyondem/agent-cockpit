import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CliProfile, CliUpdateStatus } from '../types';
import { resolveCliCommandForRuntime } from './cliCommandResolver';

const DISTRIBUTION_VERSION = /^\d+\.\d+\.\d+\+\d{6}\.[a-f0-9]{7,40}$/;
const STABLE_VERSION_URL = 'https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/stable_version.txt';
// Updater compatibility is independent of chat, login and media certification.
const MANAGED_UPDATER_VERSIONS = new Set(['1.2.35', '1.2.37']);

/** Updating the shared executable never adopts a profile's auth home or secrets. */
export function resolveCortexUpdateRuntime(profile: CliProfile, cwd: string): { command: string; env: NodeJS.ProcessEnv } {
  const searchPath = process.platform === 'win32'
    ? Object.entries(profile.env || {}).filter(([key]) => key.toUpperCase() === 'PATH').at(-1)?.[1] : profile.env?.PATH;
  const env = { ...process.env, ...(searchPath ? { PATH: searchPath } : {}), CORTEX_CHANNEL: 'stable' };
  const resolved = resolveCliCommandForRuntime('cortex-code', profile.command?.trim() || 'cortex', env).command;
  const command = resolved.includes('/') || resolved.includes('\\') ? path.resolve(cwd, resolved)
    : (env.PATH || '').split(path.delimiter).map(dir => path.resolve(dir, resolved)).find(candidate => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
    }) || resolved;
  return { command, env };
}

/** Recognize native activation independently of updater-version eligibility. */
export function cortexInstalledUpdateVersion(command: string | null): string | null {
  if (!command || process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) return null;
  try {
    const home = process.env.HOME || os.homedir();
    if (path.resolve(command) !== path.join(home, '.local/bin/cortex') || !fs.lstatSync(command).isSymbolicLink()) return null;
    const root = fs.realpathSync(path.join(home, '.local/share/cortex'));
    const binary = fs.realpathSync(command);
    const parts = path.relative(root, binary).split(path.sep);
    if (parts.length !== 2 || parts[1] !== 'cortex' || !DISTRIBUTION_VERSION.test(parts[0])) return null;
    fs.accessSync(binary, fs.constants.X_OK);
    const version = fs.readFileSync(path.join(path.dirname(binary), 'cortex-version.txt'), 'utf8').trim();
    return version === parts[0] ? version : null;
  } catch { return null; }
}

export async function cortexStableUpdateVersion(): Promise<string> {
  const response = await fetch(STABLE_VERSION_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Snowflake stable version check failed (HTTP ${response.status}).`);
  const value = (await response.text()).trim();
  if (value.length > 128 || !DISTRIBUTION_VERSION.test(value)) throw new Error('Snowflake returned an invalid stable version.');
  return value;
}


export async function probeCortexUpdateInstallation(versionOutput: string, resolvedPath: string | null, command: string): Promise<Pick<CliUpdateStatus,
  'resolvedPath' | 'installMethod' | 'currentVersion' | 'latestVersion' | 'updateAvailable' | 'updateSupported' | 'updateCommand' | 'lastCheckAt' | 'lastError' | 'updateCaution'>> {
  const nativeVersion = versionOutput.match(/\bCortex Code v(\d+\.\d+\.\d+)/)?.[1] || null;
  const installed = cortexInstalledUpdateVersion(resolvedPath);
  const managed = installed?.split('+')[0] === nativeVersion ? installed : null;
  const supported = Boolean(managed && MANAGED_UPDATER_VERSIONS.has(nativeVersion!));
  const unsupportedReason = managed
    ? `Updating Cortex Code ${nativeVersion} from Agent Cockpit has not been verified yet. Update it in your terminal.`
    : process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)
      ? 'Updating Cortex Code from Agent Cockpit is currently supported only on macOS. Update it in your terminal.'
      : 'This Cortex Code installation could not be verified for managed updates. Use the official standalone installation at ~/.local/bin/cortex, or update it in your terminal.';
  let latestVersion: string | null = null, lastError: string | null = null;
  if (supported) {
    try { latestVersion = await cortexStableUpdateVersion(); }
    catch (error) { lastError = (error as Error).message; }
  }
  const updateCommand = supported && latestVersion ? [command, 'update', latestVersion] : null;
  return {
    resolvedPath, installMethod: managed ? 'self-update' : resolvedPath ? 'unknown' : 'missing',
    currentVersion: managed || nativeVersion, latestVersion,
    updateAvailable: Boolean(managed && latestVersion && managed !== latestVersion),
    updateSupported: Boolean(updateCommand), updateCommand, lastCheckAt: new Date().toISOString(),
    lastError: lastError || (!supported ? unsupportedReason : null),
    updateCaution: managed && latestVersion && managed !== latestVersion && !latestVersion.startsWith('1.2.35+')
      ? `Snowflake stable version ${latestVersion} has not been certified for CoCo chat, login and media. Managed updater support is checked separately.` : null,
  };
}
