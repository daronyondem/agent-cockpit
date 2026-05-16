import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const WINDOWS_USER_ENV_KEY = 'HKCU\\Environment';
const WINDOWS_MACHINE_ENV_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

export async function resolveCommandOnPath(commandName: string, windowsFallbacks: string[] = []): Promise<string | null> {
  const env = await detectionEnv();
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const { stdout } = await execFileAsync(locator, [commandName], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      env,
      windowsHide: true,
    });
    const line = stdout.split(/\r?\n/)[0]?.trim();
    if (line) return line;
  } catch {}

  if (process.platform !== 'win32') return null;
  return windowsFallbacks.find(candidate => fs.existsSync(candidate)) || null;
}

export async function detectionEnv(): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  if (process.platform !== 'win32') return env;

  const pathValues = [
    env.Path,
    env.PATH,
    await readWindowsRegistryPath(WINDOWS_USER_ENV_KEY),
    await readWindowsRegistryPath(WINDOWS_MACHINE_ENV_KEY),
  ];
  const mergedPath = mergePathEntries(pathValues, env);
  if (mergedPath) {
    env.Path = mergedPath;
    env.PATH = mergedPath;
  }
  return env;
}

export function windowsPath(...parts: Array<string | undefined>): string | null {
  const [base, ...rest] = parts;
  return base ? path.win32.join(base, ...rest.filter((part): part is string => !!part)) : null;
}

async function readWindowsRegistryPath(key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', key, '/v', 'Path'], {
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*Path\s+REG_\w+\s+(.*)$/i);
      if (match?.[1]) return match[1].trim();
    }
  } catch {}
  return null;
}

function mergePathEntries(values: Array<string | null | undefined>, env: NodeJS.ProcessEnv): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const value of values) {
    for (const rawPart of (value || '').split(';')) {
      const expanded = expandWindowsEnvVars(rawPart.trim().replace(/^"+|"+$/g, ''), env);
      if (!expanded) continue;
      const key = expanded.replace(/[\\/]+$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(expanded);
    }
  }
  return parts.join(';');
}

function expandWindowsEnvVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    const direct = env[name];
    if (direct !== undefined) return direct;
    const key = Object.keys(env).find(item => item.toLowerCase() === name.toLowerCase());
    return key && env[key] !== undefined ? String(env[key]) : match;
  });
}
