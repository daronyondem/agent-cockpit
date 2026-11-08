import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawnSync } from 'child_process';
import { CORTEX_PROBES, readCortexProbeReport, selectCortexProbes } from '../scripts/cortexCompatReports';

const revision = 'a'.repeat(40);

describe('CoCo consolidated compatibility reports', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-compat-test-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const metadata = () => ({ platform: process.platform, arch: process.arch, node: process.version, revision, dirty: true,
    cliVersion: '1.2.35', results: { passed: true } });
  async function report(raw: object, name = 'probe-owned') {
    await fs.mkdir(path.join(root, name), { recursive: true });
    await fs.writeFile(path.join(root, name, 'report.json'), JSON.stringify(raw));
  }

  test('defaults to its catalog and keeps subset scope explicit; rejects ambiguous selections', () => {
    expect(selectCortexProbes('backend', [])).toEqual(CORTEX_PROBES.backend);
    expect(selectCortexProbes('ui', ['--probe', 'queue', '--probe', 'auth']).map(item => item.id)).toEqual(['auth', 'queue']);
    for (const args of [['queue'], ['--probe'], ['--probe', 'queue', '--probe', 'queue'], ['--probe', 'runtime']]) {
      expect(() => selectCortexProbes('ui', args)).toThrow();
    }
  });

  test('projects metadata/outcomes without copying native account text, diagnostics, keys or callback material', async () => {
    const raw = { ...metadata(), account: 'DO_NOT_EXPORT_ACCOUNT', error: 'code=DO_NOT_EXPORT_CODE',
      results: { passed: true, DO_NOT_EXPORT_ACCOUNT: true, nested: { diagnostic: 'DO_NOT_EXPORT_TOKEN' } } };
    await report(raw);
    const value = await readCortexProbeReport(root, 'probe-', revision);
    expect(value).toEqual({ passed: true, cliVersion: '1.2.35', revision, dirty: true });
    expect(JSON.stringify(value)).not.toContain('DO_NOT_EXPORT');
  });

  test('accepts the processor version location but never converts deadline/failure into a pass', async () => {
    await report({ ...metadata(), cliVersion: undefined, results: { cliVersion: '1.2.35', passed: true, deadlineExceeded: true } });
    expect((await readCortexProbeReport(root, 'probe-', revision)).passed).toBe(false);
    await report({ ...metadata(), results: { passed: false } });
    expect((await readCortexProbeReport(root, 'probe-', revision)).passed).toBe(false);
  });

  test.each([{ cliVersion: '1.2.37' }, { platform: 'other' }, { arch: 'other' }, { node: 'other' }, { revision: 'b'.repeat(40) }, { dirty: 'true' }])(
    'rejects mismatched native metadata %j', async mismatch => {
      await report({ ...metadata(), ...mismatch });
      await expect(readCortexProbeReport(root, 'probe-', revision)).rejects.toThrow('metadata mismatch');
    });

  test('rejects absent, duplicate, symlinked, oversized and malformed evidence', async () => {
    await expect(readCortexProbeReport(root, 'probe-', revision)).rejects.toThrow();
    await report(metadata()); await report(metadata(), 'probe-second');
    await expect(readCortexProbeReport(root, 'probe-', revision)).rejects.toThrow();
    await fs.rm(path.join(root, 'probe-second'), { recursive: true });
    const file = path.join(root, 'probe-owned/report.json');
    await fs.rename(file, path.join(root, 'outside.json')); await fs.symlink(path.join(root, 'outside.json'), file);
    await expect(readCortexProbeReport(root, 'probe-', revision)).rejects.toThrow('Invalid native report');
    await fs.rm(file); await fs.writeFile(file, ' '.repeat(1024 * 1024 + 1));
    await expect(readCortexProbeReport(root, 'probe-', revision)).rejects.toThrow('Invalid native report');
    await fs.writeFile(file, 'invalid JSON');
    await expect(readCortexProbeReport(root, 'probe-', revision)).rejects.toThrow();
  });

  test('CLI list is read-only and native execution requires explicit opt-in', async () => {
    for (const entry of ['run-cortex-code-e2e.ts', 'run-cortex-code-ui-e2e.ts']) {
      const env = { ...process.env, CORTEX_CODE_E2E: '', CORTEX_TEST_CONNECTION: 'DO_NOT_PRINT_CONNECTION', TMPDIR: root };
      const listed = spawnSync(process.execPath, ['--import', 'tsx', `scripts/${entry}`, '--list'], { env, encoding: 'utf8', timeout: 30000 });
      expect(listed.status).toBe(0); expect(listed.stdout).not.toContain('DO_NOT_PRINT');
      const denied = spawnSync(process.execPath, ['--import', 'tsx', `scripts/${entry}`], { env, encoding: 'utf8', timeout: 30000 });
      expect(denied.status).toBe(1);
      expect((await fs.readdir(root)).some(name => name.includes('-compat-'))).toBe(false);
    }
  });

  (process.platform === 'darwin' ? test : test.skip)('a competing lock cannot be removed or trigger native work', async () => {
    const lock = path.join(root, 'agent-cockpit-cortex-e2e.lock'); await fs.writeFile(lock, 'another-owner');
    const called = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-cortex-code-e2e.ts'], {
      env: { ...process.env, CORTEX_CODE_E2E: '1', CORTEX_ACP_TEST_MODE: '0', TMPDIR: root,
        CORTEX_TEST_COMMAND: path.join(root, 'missing-cortex') }, encoding: 'utf8', timeout: 30000,
    });
    expect(called.status).toBe(1); expect(await fs.readFile(lock, 'utf8')).toBe('another-owner');
    const file = called.stdout.match(/Report: (.+compatibility-report\.json)/)?.[1]; expect(file).toBeTruthy();
    try {
      const value = JSON.parse(await fs.readFile(file!, 'utf8'));
      expect(value).toMatchObject({ passed: false, lockUnavailable: true, phase: 'lock', results: [] });
      const socket = path.join(path.dirname(file!), 'auth/tmp/tsx-501/12345.pipe');
      await fs.mkdir(path.dirname(socket), { recursive: true });
      const server = net.createServer();
      try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); }); }
      finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    } finally { await fs.rm(path.dirname(file!), { recursive: true, force: true }); }
  });
});
