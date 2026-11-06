import crypto from 'crypto';
import fs from 'fs/promises';
import { writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { McpServerConfig } from '../../types';
import { CortexInputError } from './cortexErrors';

const PREFIX = 'agent-cockpit-cortex-plugin-';

/** Native ACP ignores session/new MCP configuration in 1.2.35. */
export function cortexPluginDefinition(servers: McpServerConfig[]) {
  const env: Record<string, string> = {};
  const mcpServers: Record<string, unknown> = Object.create(null);
  servers.forEach((server, index) => {
    if (Object.hasOwn(mcpServers, server.name)) throw new CortexInputError('Duplicate Cortex MCP server.');
    const variables: Record<string, string> = {};
    for (const [position, variable] of (server.env || []).entries()) {
      const name = `COCKPIT_CORTEX_MCP_${index}_${position}`;
      env[name] = variable.value;
      variables[variable.name] = '${' + name + '}';
    }
    mcpServers[server.name] = { type: 'stdio', command: server.command === 'node' ? process.execPath : server.command,
      args: server.args, env: variables };
  });
  const manifest = JSON.stringify({ name: 'agent-cockpit', version: '1.0.0', mcpServers });
  const key = crypto.createHash('sha256').update(JSON.stringify({ manifest, env })).digest('hex');
  return { manifest, env, key, enabled: servers.length > 0 };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Unknown owners, live/reused PIDs and incomplete startup records are retained. */
export async function pruneCortexPlugins(): Promise<void> {
  const root = os.tmpdir();
  for (const name of await fs.readdir(root)) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = path.join(root, name);
    try {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) continue;
      const owner = JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8'));
      if (owner.version !== 1 || !Number.isSafeInteger(owner.server) || owner.server <= 0
        || !Number.isSafeInteger(owner.child) || owner.child <= 0 || alive(owner.server) || alive(owner.child)) continue;
      await fs.rm(dir, { recursive: true, force: true });
    } catch { /* Incomplete or foreign directories do not authorize removal. */ }
  }
}

export async function createCortexPlugin(definition: ReturnType<typeof cortexPluginDefinition>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), PREFIX));
  try {
    await fs.chmod(dir, 0o700);
    await fs.mkdir(path.join(dir, '.cortex-plugin'), { mode: 0o700 });
    await fs.writeFile(path.join(dir, '.cortex-plugin/plugin.json'), definition.manifest, { mode: 0o600 });
    const ownerFile = path.join(dir, 'owner.json');
    const attach = (child?: number) => {
      writeFileSync(ownerFile, JSON.stringify({ version: 1, server: process.pid, child: child || null }), { mode: 0o600 });
    };
    attach();
    return { dir, attach, remove: () => fs.rm(dir, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}
