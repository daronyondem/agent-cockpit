import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import * as processes from '../src/services/backends/copilotProcess';
import { CliProfileAuthService } from '../src/services/cliProfileAuthService';
import { probeCopilotProfile } from '../src/services/backends/copilotProfileStatus';
import type { CliProfile } from '../src/types';

const native = process.env.COPILOT_AUTH_E2E === '1' ? describe : describe.skip;
native('real Copilot shared device authentication (no authorization or credential writes)', () => {
  const originalEnv = process.env;
  let dir: string;
  let profile: CliProfile;
  const pids = new Set<number>();
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-auth-native-'));
    process.env = Object.fromEntries(Object.entries(originalEnv).filter(([key]) => !/^(COPILOT_|GH_|GITHUB_)/.test(key)));
    Object.assign(process.env, { HOME: dir, USERPROFILE: dir, COPILOT_HOME: path.join(dir, 'copilot'), GH_CONFIG_DIR: path.join(dir, 'gh'),
      XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_CACHE_HOME: path.join(dir, 'cache'), CI: 'true', BROWSER: 'false', COPILOT_DISABLE_KEYTAR: '1' });
    profile = { id: 'native-auth', name: 'Native auth', harness: 'copilot', authMode: 'server-configured', command: originalEnv.COPILOT_AUTH_CLI || 'copilot', createdAt: '', updatedAt: '' };
    const spawn = processes.spawnCopilotProcess;
    jest.spyOn(processes, 'spawnCopilotProcess').mockImplementation((...args) => {
      const owned = spawn(...args); if (owned.proc.pid) pids.add(owned.proc.pid); return owned;
    });
  });
  afterAll(() => {
    jest.restoreAllMocks(); process.env = originalEnv;
    if (originalEnv.COPILOT_AUTH_REPORT_DIR) fs.writeFileSync(path.join(originalEnv.COPILOT_AUTH_REPORT_DIR, 'native-evidence.json'), JSON.stringify({
      pids: [...pids], allRecordedProcessesStopped: [...pids].every(pid => !alive(pid)),
      deviceLoginAuthorized: false, hostedEntitlementVerified: false, twoAccountsVerified: false,
    }, null, 2));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
  function captureChildren() {
    if (process.platform === 'win32') return;
    const table = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    let changed = true;
    while (changed) { changed = false; for (const [pid, parent] of table) if (pids.has(parent) && !pids.has(pid)) { pids.add(pid); changed = true; } }
  }

  test('fresh native account status reports the empty auth home as logged out', async () => {
    const status = await probeCopilotProfile(profile, AbortSignal.timeout(15000));
    expect(status).toMatchObject({ authenticated: false, modelsAvailable: false, modelCount: 0 });
  }, 30000);

  test('displays a real native code, cancels every owned process, and allows another login job', async () => {
    const service = new CliProfileAuthService(dir, { authTimeoutMs: 30000 });
    try {
      for (let round = 0; round < 2; round++) {
        const job = await service.startAuth(profile);
        const deadline = Date.now() + 25000;
        let sawCode = false;
        while (Date.now() < deadline) {
          const snapshot = service.getJob(job.id)!;
          sawCode = snapshot.events.some(event => /https:\/\/github\.com\/login\/device.*[A-Z0-9]{4}-[A-Z0-9]{4}/.test(event.text));
          if (sawCode || snapshot.status !== 'running') break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(sawCode).toBe(true); captureChildren();
        expect(service.cancelJob(job.id).status).toBe('cancelled');
        const stopping = Date.now() + 10000;
        while ([...pids].some(alive) && Date.now() < stopping) await new Promise(resolve => setTimeout(resolve, 100));
        expect([...pids].some(alive)).toBe(false);
      }
    } finally { await service.shutdown(); }
    expect((await probeCopilotProfile(profile, AbortSignal.timeout(15000))).authenticated).toBe(false);
  }, 90000);
});
