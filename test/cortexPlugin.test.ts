import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { cortexPluginDefinition, createCortexPlugin, pruneCortexPlugins } from '../src/services/backends/cortexPlugin';

const posix = process.platform === 'win32' ? describe.skip : describe;
posix('Cortex managed native plugins', () => {
  const servers = [
    { name: 'agent-cockpit-memory', command: 'node', args: ['/fixture/memory.cjs'], env: [{ name: 'MEMORY_TOKEN', value: 'memory-secret' }] },
    { name: 'agent-cockpit-kb-search', command: 'node', args: ['/fixture/kb.cjs'], env: [{ name: 'KB_SEARCH_TOKEN', value: 'kb-secret' }] },
  ];
  test('uses the current Node executable and separate child-only env placeholders', () => {
    const definition = cortexPluginDefinition(servers);
    const manifest = JSON.parse(definition.manifest);
    expect(manifest.mcpServers['agent-cockpit-memory']).toEqual({ type: 'stdio', command: process.execPath,
      args: ['/fixture/memory.cjs'], env: { MEMORY_TOKEN: '${COCKPIT_CORTEX_MCP_0_0}' } });
    expect(manifest.mcpServers['agent-cockpit-kb-search'].env).toEqual({ KB_SEARCH_TOKEN: '${COCKPIT_CORTEX_MCP_1_0}' });
    expect(definition.env).toEqual({ COCKPIT_CORTEX_MCP_0_0: 'memory-secret', COCKPIT_CORTEX_MCP_1_0: 'kb-secret' });
    expect(definition.manifest).not.toMatch(/memory-secret|kb-secret/);
    expect(definition.key).not.toBe(cortexPluginDefinition(servers.slice(0, 1)).key);
    expect(definition.key).not.toBe(cortexPluginDefinition([{ ...servers[0], env: [{ name: 'MEMORY_TOKEN', value: 'rotated' }] }, servers[1]]).key);
    expect(cortexPluginDefinition([]).enabled).toBe(false);
    expect(() => cortexPluginDefinition([servers[0], servers[0]])).toThrow('Duplicate');
  });

  test('private leases clean up only after their owner releases them', async () => {
    const lease = await createCortexPlugin(cortexPluginDefinition(servers));
    try {
      lease.attach(process.pid);
      expect((await fs.stat(lease.dir)).mode & 0o777).toBe(0o700);
      const manifest = path.join(lease.dir, '.cortex-plugin/plugin.json');
      expect((await fs.stat(manifest)).mode & 0o777).toBe(0o600);
      await pruneCortexPlugins();
      expect(await fs.readFile(manifest, 'utf8')).not.toContain('secret');
      expect(JSON.parse(await fs.readFile(path.join(lease.dir, 'owner.json'), 'utf8'))).toEqual({ version: 1, server: process.pid, child: process.pid });
    } finally { await lease.remove(); }
    await expect(fs.access(lease.dir)).rejects.toThrow();
  });

  test('startup pruning retains live, unknown and incomplete owners; removes proven dead owners', async () => {
    const dirs: string[] = [];
    for (const owner of [null, { version: 1, server: process.pid, child: 2_000_000_000 },
      { version: 1, server: 2_000_000_000, child: process.pid }, { version: 1, server: -1, child: -1 },
      { version: 1, server: 2_000_000_000, child: null }, { version: 1, server: 2_000_000_000, child: 2_000_000_001 }]) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-cortex-plugin-'));
      dirs.push(dir);
      if (owner) await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify(owner));
    }
    try {
      await pruneCortexPlugins();
      for (const dir of dirs.slice(0, -1)) await expect(fs.access(dir)).resolves.toBeUndefined();
      await expect(fs.access(dirs.at(-1)!)).rejects.toThrow();
    } finally { await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true }))); }
  });

  test('an unreadable temp root never rejects the once-per-process prune', async () => {
    const readdir = jest.spyOn(fs, 'readdir').mockRejectedValueOnce(Object.assign(new Error('too many open files'), { code: 'EMFILE' }));
    try {
      await expect(pruneCortexPlugins()).resolves.toBeUndefined();
      expect(readdir).toHaveBeenCalledWith(os.tmpdir());
    } finally { readdir.mockRestore(); }
  });
});
