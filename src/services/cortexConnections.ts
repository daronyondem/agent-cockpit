import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CortexConnectionSummary, CortexConnectionCreate } from '../contracts/cortexAuth';
import { validateCortexConnectionCreate } from '../contracts/cortexAuth';

const MAX_FILE_BYTES = 1024 * 1024;
export const CORTEX_DEFAULT_BROWSER_TIMEOUT = 120_000;

export function cortexSnowflakeHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = process.platform === 'win32'
    ? Object.entries(env).filter(([key]) => key.toUpperCase() === 'SNOWFLAKE_HOME').at(-1)?.[1] : env.SNOWFLAKE_HOME;
  return path.resolve((home || path.join(os.homedir(), '.snowflake')).replace(/^~(?=[\\/]|$)/, os.homedir()));
}

/** Only names and setup capability cross the API; native credentials stay here. */
export class CortexConnections {
  private writing = false;
  constructor(readonly home = cortexSnowflakeHome()) {}

  private async read(): Promise<{ raw: string; connections: Record<string, unknown> }> {
    try {
      const file = path.join(this.home, 'connections.toml');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error();
      const raw = await fs.readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new Error();
      const { parse } = await import('smol-toml');
      return { raw, connections: parse(raw) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: '', connections: {} };
      // Parser errors contain source lines, potentially including passwords.
      throw new Error('Could not safely read Snowflake connections.toml. Check its format, size and permissions.');
    }
  }

  async list(): Promise<CortexConnectionSummary[]> {
    const { connections } = await this.read();
    return Object.entries(connections).flatMap(([name, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const config = value as Record<string, unknown>;
      if (typeof config.account !== 'string') return [];
      return [{ name, manualOAuth: String(config.authenticator || '').toUpperCase() === 'OAUTH_AUTHORIZATION_CODE',
        browserTimeoutMs: this.timeout(config.browserActionTimeout ?? config.browser_action_timeout) }];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async selected(name: string): Promise<CortexConnectionSummary> {
    const connection = (await this.list()).find(item => item.name === name);
    if (!connection) throw new Error('The selected Snowflake connection is unavailable. Refresh connections.');
    return connection;
  }

  async create(input: CortexConnectionCreate): Promise<CortexConnectionSummary[]> {
    const { name, account, user } = validateCortexConnectionCreate(input);
    if (this.writing) throw new Error('A connection write is already running. Try again.');
    this.writing = true;
    let temp: string | undefined;
    let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
    const lockPath = path.join(this.home, '.cockpit-connections.lock');
    try {
      await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
      lock = await fs.open(lockPath, 'wx', 0o600);
      const before = await this.read();
      if (Object.hasOwn(before.connections, name)) throw new Error('A connection with this name already exists. Choose another name.');
      const { parse, stringify } = await import('smol-toml');
      const suffix = stringify({ [name]: { account, user, authenticator: 'OAUTH_AUTHORIZATION_CODE',
        client_store_temporary_credential: true, browserActionTimeout: 600_000 } });
      const next = `${before.raw}${before.raw.endsWith('\n') || !before.raw ? '' : '\n'}\n${suffix}`;
      if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new Error('The Snowflake connection file is too large.');
      parse(next); // The original document is preserved byte for byte.
      temp = path.join(this.home, `.connections-${crypto.randomUUID()}.tmp`);
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(next, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      if ((await this.read()).raw !== before.raw) throw new Error('Snowflake connections changed during creation. Refresh and try again.');
      await fs.rename(temp, path.join(this.home, 'connections.toml'));
      temp = undefined;
      return await this.list();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A connection write is locked. Check for another setup process before retrying.');
      if (error instanceof Error && /^(A connection|Snowflake connections|The Snowflake|Could not safely)/.test(error.message)) throw error;
      throw new Error('Could not create the Snowflake connection. Check the native file and directory permissions.');
    } finally {
      if (temp) await fs.unlink(temp).catch(() => {});
      if (lock) { await lock.close(); await fs.unlink(lockPath).catch(() => {}); }
      this.writing = false;
    }
  }

  private timeout(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : CORTEX_DEFAULT_BROWSER_TIMEOUT;
  }
}
