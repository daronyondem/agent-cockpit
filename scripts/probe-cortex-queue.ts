import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawnSync } from 'child_process';
import { chromium, expect as baseExpect, type Page } from '@playwright/test';
import { cortexVersion, resolveCortexRuntime } from '../src/services/backends/cortexRuntime';
import type { CliProfile } from '../src/types';

const expect = baseExpect.configure({ timeout: 120_000 });

/** C44: native queue/abort/reconnect, isolated PM2/data/workspace, shared terminal auth. */
async function main(): Promise<void> {
  assert.equal(process.env.CORTEX_QUEUE_PROBE, '1', 'Set CORTEX_QUEUE_PROBE=1 for native inference');
  assert.equal(process.platform, 'darwin', 'Only macOS is certified by this probe');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1', 'Fake mode is not native evidence');
  const connection = process.env.CORTEX_TEST_CONNECTION; assert.ok(connection, 'Select a saved native connection');
  const cwd = process.cwd(), startedAt = new Date().toISOString();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-queue-')); await fs.chmod(root, 0o700);
  const workspace = path.join(root, 'workspace'), data = path.join(root, 'data');
  await fs.mkdir(workspace); await fs.mkdir(path.join(data, 'chat'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), '# Scoped compatibility workspace\nOnly perform the exact requested fixture work. No agents, goals, Memory, KB, routines, SQL, web, background work or outreach.\n');
  const profile: CliProfile = { id: 'cortex-queue-probe', name: 'CoCo queues', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: startedAt, updatedAt: startedAt };
  await fs.writeFile(path.join(data, 'chat/settings.json'), JSON.stringify({ theme: 'light', sendBehavior: 'enter', systemPrompt: '', cliProfiles: [profile],
    defaultCliProfileId: profile.id, defaultBackend: 'cortex-code', defaultModel: 'claude-sonnet-4-6', defaultEffort: 'low' }), { mode: 0o600 });
  const version = await cortexVersion(resolveCortexRuntime({ profile, workspaceId: 'probe', cwd: workspace }));
  assert.equal(version, '1.2.35', 'Review native compatibility before certifying another version');
  const port = await new Promise<number>((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port));
  }); });
  const app = `cortex-queue-${process.pid}`, config = path.join(root, 'ecosystem.config.cjs');
  await fs.writeFile(config, `module.exports=${JSON.stringify({ apps: [{ name: app, cwd, script: 'server.ts', interpreter: process.execPath, node_args: ['--import', 'tsx'],
    autorestart: false, kill_timeout: 20000, out_file: path.join(root, 'server-out.log'), error_file: path.join(root, 'server-error.log'),
    env: { NODE_ENV: 'test', PORT: port, BASE_PATH: '', AGENT_COCKPIT_DATA_DIR: data, AUTH_DATA_DIR: path.join(data, 'auth'), DEFAULT_WORKSPACE: workspace,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'), WEB_BUILD_MODE: 'skip' } }] })};\n`, { mode: 0o600 });
  const pm2 = (args: string[]) => spawnSync(process.execPath, [path.join(cwd, 'node_modules/pm2/bin/pm2'), ...args], { cwd, stdio: 'ignore' });
  const results: Record<string, unknown> = {};
  const report = { startedAt, cliVersion: version, platform: process.platform, arch: process.arch, node: process.version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const deadline = setTimeout(() => { results.deadlineExceeded = true; void browser?.close(); }, 8 * 60_000);
  try {
    assert.equal(pm2(['start', config, '--only', app]).status, 0);
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(`${base}/api/chat/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* startup */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 500)); }
    assert.ok(ready, 'Fixture did not become ready');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(120_000);
    const csrf = (await (await page.request.get(`${base}/api/csrf-token`)).json()).csrfToken;
    const headers = { 'x-csrf-token': csrf };
    assert.ok((await page.request.post(`${base}/api/chat/install/welcome-complete`, { headers, data: {} })).ok());
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      (window as any).__queueSockets = [];
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols); (window as any).__queueSockets.push(this);
        }
      };
    });
    async function open(conversation: { id: string; title: string; workspaceId: string }, mobile: boolean) {
      conversation.title = (await (await page.request.get(`${base}/api/chat/conversations/${conversation.id}`)).json()).title;
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
      await page.goto(`${base}/${mobile ? 'mobile' : 'v2'}/`);
      if (mobile) await page.locator('.conversation-card').filter({ hasText: conversation.title }).click();
      else { await page.getByLabel('Workspace filter').selectOption(conversation.workspaceId); await page.locator(`.sb-row[data-conv-id="${conversation.id}"]`).click(); }
      if (mobile) {
        await page.locator('.composer-profile').click();
        const settings = page.getByRole('dialog').filter({ hasText: 'Run Settings' });
        await settings.getByRole('button', { name: /sonnet.*4.6/i }).click();
        await settings.getByRole('button', { name: 'low', exact: true }).click();
        await settings.getByRole('button', { name: 'Close', exact: true }).click();
      } else {
        await page.getByLabel('Model', { exact: true }).selectOption('claude-sonnet-4-6');
        await expect(page.getByLabel('Model', { exact: true })).toHaveValue('claude-sonnet-4-6');
        await page.getByLabel('Adaptive reasoning effort', { exact: true }).selectOption('low');
        await expect(page.getByLabel('Adaptive reasoning effort', { exact: true })).toHaveValue('low');
      }
    }
    async function exercise(mobile: boolean, abort: boolean) {
      const side = mobile ? 'mobile' : 'desktop', stem = `${side}-${abort ? 'abort' : 'queue'}`;
      results.stage = stem;
      const response = await page.request.post(`${base}/api/chat/conversations`, { headers, data: { title: `CoCo ${stem}`, workingDir: workspace, cliProfileId: profile.id } });
      assert.ok(response.ok()); const conversation = await response.json();
      const name = (suffix: string) => path.join(workspace, `${stem}-${suffix}`);
      const nonce = `C44_${crypto.randomBytes(6).toString('hex')}`;
      const queued = `Reply exactly ${nonce}. Do not run any tools or repeat earlier work.`;
      await fs.writeFile(name('work.py'), `import os,time\nfrom pathlib import Path\np=Path(${JSON.stringify(name('count'))})\np.write_text(str(int(p.read_text())+1) if p.exists() else "1")\nPath(${JSON.stringify(name('pid'))}).write_text(str(os.getpid()))\nfor _ in range(1200):\n if Path(${JSON.stringify(name('release'))}).exists(): break\n time.sleep(0.1)\nelse: raise SystemExit(2)\nPath(${JSON.stringify(name('finished'))}).write_text("FINISHED")\n`);
      if (!abort) await fs.writeFile(name('before.py'), `import time\nfrom pathlib import Path\nPath(${JSON.stringify(name('before-started'))}).write_text("READY")\nfor _ in range(1200):\n if Path(${JSON.stringify(name('before-release'))}).exists(): break\n time.sleep(0.1)\nelse: raise SystemExit(2)\n`);
      let questions = 0, decisionId = '';
      const watch = (socket: import('@playwright/test').WebSocket) => socket.on('framereceived', frame => {
        try { const event = JSON.parse(String(frame.payload)); if (event.type === 'tool_activity' && event.isQuestion) { questions++; decisionId = event.id; } } catch { /* heartbeat */ }
      });
      page.on('websocket', watch);
      let releaseInput: (() => void) | undefined;
      try {
        await open(conversation, mobile);
        const composer = page.locator('footer.composer,div.composer').first(), draft = composer.locator('textarea');
        const card = () => mobile ? page.locator('.interaction-card') : page.getByRole('group', { name: 'Clarifying question' });
        const prompt = abort
          ? `Run python3 ${stem}-work.py with bash and wait for completion. Only run it once. Do no other work.`
          : `First run python3 ${stem}-before.py using bash and wait. Then use ask_user_question once: "C44 fixture color?" with Blue and Green. Wait for the answer. Then run python3 ${stem}-work.py using bash and wait for completion. Reply exactly ORIGINAL_DONE. Run each script once only. No other work, agents, Memory, SQL or web.`;
        await send(page, prompt);
        await expect(draft).toHaveAttribute('placeholder', /Live steering unavailable/);
        if (!abort) {
          await expect.poll(() => fs.access(name('before-started')).then(() => true, () => false)).toBe(true);
          await draft.fill(queued); await fs.writeFile(name('before-release'), 'GO');
          await expect(card()).toContainText('C44 fixture color?');
          assert.ok(decisionId.startsWith('cortex-decision:')); await expect(draft).toHaveValue(queued);
          if (!mobile) { await expect(draft).toBeDisabled(); await expect(page.getByLabel('Stop agent', { exact: true })).toBeEnabled(); }
          const prior = questions; await disconnect(conversation.id);
          await expect.poll(() => questions).toBeGreaterThan(prior);
          await expect(draft).toHaveValue(queued);
          const held = new Promise<void>(resolve => { releaseInput = resolve; });
          await page.route(`**/conversations/${conversation.id}/input`, async route => { const response = await route.fetch(); await held; await route.fulfill({ response }); });
          await card().getByRole('button', { name: 'Green', exact: true }).click();
          await card().getByRole('button', { name: mobile ? 'Answer' : 'Send', exact: true }).click();
        }
        await expect.poll(() => fs.access(name('pid')).then(() => true, () => false)).toBe(true);
        await expect(card()).toHaveCount(0);
        if (abort) await draft.fill(queued);
        await composer.getByRole('button', { name: mobile ? 'Queue' : 'Queue behind current run', exact: true }).click();
        const queue = async () => (await (await page.request.get(`${base}/api/chat/conversations/${conversation.id}/queue`)).json()).queue.map((item: { content: string }) => ({ content: item.content }));
        await expect.poll(queue).toEqual([{ content: queued }]);
        const unsent = `UNSENT_${stem}`; await draft.fill(unsent);
        releaseInput?.(); releaseInput = undefined;
        if (!abort) {
          const stale = await page.request.post(`${base}/api/chat/conversations/${conversation.id}/input`, { headers, data: { text: 'Blue', streamActive: true, decisionId } });
          assert.equal(stale.status(), 409);
          await disconnect(conversation.id); await expect(draft).toHaveValue(unsent);
          await fs.writeFile(name('release'), 'GO');
          await settled(conversation.id, nonce, mobile); await expect(draft).toHaveValue(unsent);
          assert.equal(await fs.readFile(name('finished'), 'utf8'), 'FINISHED');
        } else {
          await (mobile ? page.getByRole('button', { name: 'Stop', exact: true }) : page.getByLabel('Stop agent', { exact: true })).click();
          await expect.poll(async () => (await (await page.request.get(`${base}/api/chat/active-streams`)).json()).ids.includes(conversation.id)).toBe(false);
          const pid = Number(await fs.readFile(name('pid'), 'utf8'));
          await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }).toBe(true);
          await assert.rejects(fs.access(name('finished'))); await expect(draft).toHaveValue(unsent);
          await expect.poll(queue).toEqual([{ content: queued }]);
          const interrupted = await (await page.request.get(`${base}/api/chat/conversations/${conversation.id}`)).json();
          assert.equal(interrupted.messages.filter((message: { role: string }) => message.role === 'user').length, 1);
          await open(conversation, mobile); // Fresh page: persisted queue stays idle until explicit resume.
          await expect(page.getByRole('button', { name: mobile ? 'Resume queue' : 'Resume', exact: true })).toBeVisible();
          await expect.poll(queue).toEqual([{ content: queued }]);
          await page.getByRole('button', { name: mobile ? 'Resume queue' : 'Resume', exact: true }).click();
          await settled(conversation.id, nonce, mobile); await assert.rejects(fs.access(name('finished')));
        }
        assert.equal(await fs.readFile(name('count'), 'utf8'), '1'); await expect.poll(queue).toEqual([]);
        const saved = await (await page.request.get(`${base}/api/chat/conversations/${conversation.id}`)).json();
        const users = saved.messages.filter((message: { role: string }) => message.role === 'user');
        assert.equal(users.length, 2); assert.equal(users[1].content, queued);
        results[stem] = { draftRetained: true, queueOnce: true, noPromptReplay: true, ...(abort ? { descendantsDrained: true, explicitResume: true } : { questionReconnect: true, lateReply: true, completedDecisionReplay: true }) };
        process.stdout.write(`PASS native ${stem}\n`);
      } finally { releaseInput?.(); await page.unrouteAll({ behavior: 'wait' }); page.off('websocket', watch); }
    }
    async function disconnect(conversationId: string) {
      await page.evaluate(id => { for (const socket of (window as any).__queueSockets) if (socket.url.includes(id) && socket.readyState === 1) socket.close(); }, conversationId);
    }
    async function settled(conversationId: string, nonce: string, mobile: boolean) {
      await expect.poll(async () => (await (await page.request.get(`${base}/api/chat/active-streams`)).json()).ids.includes(conversationId), { timeout: 120_000 }).toBe(false);
      await expect((mobile ? page.locator('.message.assistant') : page.locator('.msg-agent')).filter({ hasText: nonce }).last()).toBeVisible();
    }
    await exercise(false, false); await exercise(false, true); await exercise(true, false); await exercise(true, true); results.passed = true;
  } catch (error) { await fs.writeFile(path.join(root, 'failure.txt'), error instanceof Error ? error.stack || error.message : 'Probe failed', { mode: 0o600 }); throw error;
  } finally { clearTimeout(deadline); await browser?.close(); pm2(['delete', app]); await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Private queue evidence: ${path.join(root, 'report.json')}\n`); }
}
async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('footer.composer,div.composer').first(); await composer.locator('textarea').fill(text);
  const sent = page.waitForRequest(request => request.method() === 'POST' && /\/conversations\/[^/]+\/message$/.test(new URL(request.url()).pathname));
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  const body = (await sent).postDataJSON(); assert.equal(body.model, 'claude-sonnet-4-6'); assert.equal(body.effort, 'low');
}
main().catch(() => { process.stderr.write('Cortex queue probe failed; inspect its private report.\n'); process.exitCode = 1; });
