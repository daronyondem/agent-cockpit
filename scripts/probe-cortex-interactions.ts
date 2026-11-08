import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawnSync } from 'child_process';
import { chromium, expect as baseExpect, type Page, type Response as PlaywrightResponse } from '@playwright/test';
import { cortexVersion, resolveCortexRuntime } from '../src/services/backends/cortexRuntime';
import type { CliProfile } from '../src/types';

const expect = baseExpect.configure({ timeout: 120_000 });

/** C43 only: real desktop/mobile decisions, isolated PM2/data/workspace, shared terminal auth. */
async function main(): Promise<void> {
  assert.equal(process.env.CORTEX_INTERACTION_PROBE, '1', 'Set CORTEX_INTERACTION_PROBE=1 for native inference');
  assert.equal(process.platform, 'darwin', 'Only macOS is certified by this probe');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1', 'Fake mode is not native evidence');
  const connection = process.env.CORTEX_TEST_CONNECTION; assert.ok(connection, 'Select a saved native connection');
  const cwd = process.cwd(), startedAt = new Date().toISOString();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-interactions-')); await fs.chmod(root, 0o700);
  const workspace = path.join(root, 'workspace'), data = path.join(root, 'data');
  await fs.mkdir(workspace); await fs.mkdir(path.join(data, 'chat'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), '# Scoped compatibility workspace\nOnly perform the exact requested fixture work. No agents, goals, Memory, KB, routines, SQL, web, background work or outreach.\n');
  const profile: CliProfile = { id: 'cortex-interaction-probe', name: 'CoCo interactions', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: startedAt, updatedAt: startedAt };
  await fs.writeFile(path.join(data, 'chat/settings.json'), JSON.stringify({ theme: 'light', sendBehavior: 'enter', systemPrompt: '', cliProfiles: [profile],
    defaultCliProfileId: profile.id, defaultBackend: 'cortex-code', defaultModel: 'claude-sonnet-4-6', defaultEffort: 'low' }), { mode: 0o600 });
  const version = await cortexVersion(resolveCortexRuntime({ profile, workspaceId: 'probe', cwd: workspace }));
  assert.equal(version, '1.2.35', 'Review native compatibility before certifying another version');
  const port = await new Promise<number>((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port));
  }); });
  const app = `cortex-interactions-${process.pid}`, config = path.join(root, 'ecosystem.config.cjs');
  await fs.writeFile(config, `module.exports=${JSON.stringify({ apps: [{ name: app, cwd, script: 'server.ts', interpreter: process.execPath, node_args: ['--import', 'tsx'],
    autorestart: false, kill_timeout: 20000, out_file: path.join(root, 'server-out.log'), error_file: path.join(root, 'server-error.log'),
    env: { NODE_ENV: 'test', PORT: port, BASE_PATH: '', AGENT_COCKPIT_DATA_DIR: data, AUTH_DATA_DIR: path.join(data, 'auth'), DEFAULT_WORKSPACE: workspace,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'), WEB_BUILD_MODE: 'skip' } }] })};\n`, { mode: 0o600 });
  const pm2 = (args: string[]) => spawnSync(process.execPath, [path.join(cwd, 'node_modules/pm2/bin/pm2'), ...args], { cwd, stdio: 'ignore' });
  const results: Record<string, unknown> = {};
  const report = { startedAt, cliVersion: version, platform: process.platform, arch: process.arch, node: process.version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let captureFailure: (() => Promise<void>) | undefined;
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
    captureFailure = async () => { await fs.writeFile(path.join(root, 'failure-ui.txt'), await page.locator('body').innerText(), { mode: 0o600 }); };
    const csrf = (await (await page.request.get(`${base}/api/csrf-token`)).json()).csrfToken;
    const headers = { 'x-csrf-token': csrf };
    assert.ok((await page.request.post(`${base}/api/chat/install/welcome-complete`, { headers, data: {} })).ok());
    async function open(conversation: { title: string; workspaceId: string }, mobile: boolean) {
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
      await page.goto(`${base}/${mobile ? 'mobile' : 'v2'}/`);
      if (mobile) await page.locator('.conversation-card').filter({ hasText: conversation.title }).click();
      else { await page.getByLabel('Workspace filter').selectOption(conversation.workspaceId); await page.locator('.sb-row').filter({ hasText: conversation.title }).click(); }
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
    async function exercise(mobile: boolean) {
      const side = mobile ? 'mobile' : 'desktop'; results.stage = `${side}-questions`;
      const response = await page.request.post(`${base}/api/chat/conversations`, { headers, data: { title: `CoCo ${side} decisions`, workingDir: workspace, cliProfileId: profile.id } });
      assert.ok(response.ok()); const conversation = await response.json();
      const decisions: string[] = [];
      page.on('response', recordInput);
      function recordInput(response: PlaywrightResponse){ if (response.url().endsWith(`/conversations/${conversation.id}/input`) && response.request().method() === 'POST') {
        const id = response.request().postDataJSON()?.decisionId; if (response.status() === 200 && typeof id === 'string') decisions.push(id);
      } }
      try {
        await open(conversation, mobile);
        const card = () => mobile ? page.locator('.interaction-card') : page.getByRole('group', { name: /Clarifying question|Plan approval/ });
        const target = path.join(workspace, `${side}-approved.txt`), nonce = `C43_${crypto.randomBytes(6).toString('hex')}`;
        const prompt = `Use ask_user_question once with TWO sequential questions: "Which fixture color?" with Blue and Green, then "Which backup color?" with Blue and Green. Wait for both answers. Then use enter_plan_mode and exit_plan_mode to plan writing ${path.basename(target)} with exactly ${nonce}. Wait for explicit approval before writing. If asked to revise, include the user's revision marker and an explicit native read-back verification, then call exit_plan_mode again. Only after approval, use native write/read to create and verify the file, then reply exactly ${nonce}. No other tools or work.`;
        await send(page, prompt);
        await expect(card()).toContainText('Which fixture color?');
        await card().locator(mobile ? 'textarea' : 'input').fill('Violet fixture');
        await card().getByRole('button', { name: mobile ? 'Answer' : 'Send', exact: true }).click();
        await expect(card()).toContainText('Which backup color?');
        await expect(card().locator(mobile ? 'textarea' : 'input')).toHaveValue('');
        await card().getByRole('button', { name: 'Green', exact: true }).click();
        await card().getByRole('button', { name: mobile ? 'Answer' : 'Send', exact: true }).click();
        await expect(card().getByRole('button', { name: 'Approve & run', exact: true })).toBeVisible();
        await assert.rejects(fs.access(target)); results.stage = `${side}-revise`;
        const marker = `REVISED_${side.toUpperCase()}`;
        await card().getByLabel('Plan revision feedback').fill(`Add ${marker} to the PLAN TEXT ONLY, and explicitly read the file back before finishing. Keep the file contents exactly ${nonce}, with no marker or other added content. Ask native approval again before writing.`);
        await card().getByRole('button', { name: 'Request changes', exact: true }).click();
        await expect(card()).toContainText(marker);
        await expect(card().getByLabel('Plan revision feedback')).toHaveValue('');
        await assert.rejects(fs.access(target));
        assert.equal(decisions.length, 3); assert.equal(new Set(decisions).size, 3); assert.ok(decisions.every(id => id.startsWith('cortex-decision:')));
        const stale = await page.request.post(`${base}/api/chat/conversations/${conversation.id}/input`, { headers, data: { text: 'yes', streamActive: true, decisionId: decisions[2] } });
        assert.equal(stale.status(), 409); await assert.rejects(fs.access(target));
        results.stage = `${side}-approve`;
        await card().getByRole('button', { name: 'Approve & run', exact: true }).click();
        await expect.poll(() => fs.readFile(target, 'utf8').then(text => text.trimEnd()).catch(() => ''), { timeout: 120_000 }).toBe(nonce);
        await expect.poll(async () => (await (await page.request.get(`${base}/api/chat/active-streams`)).json()).ids.includes(conversation.id), { timeout: 120_000 }).toBe(false);
        const messages = mobile ? page.locator('.message.assistant') : page.locator('.msg-agent');
        await expect(messages.filter({ hasText: nonce }).last()).toBeVisible();
        await expect(card()).toHaveCount(0);
        const duplicate = await page.request.post(`${base}/api/chat/conversations/${conversation.id}/input`, { headers, data: { text: 'yes', streamActive: true, decisionId: decisions[3] } });
        assert.equal(duplicate.status(), 409);
        const saved = await (await page.request.get(`${base}/api/chat/conversations/${conversation.id}`)).json();
        assert.equal(saved.messages.filter((message: { role: string }) => message.role === 'user').length, 1, 'Replies must not resend a prompt');
        results[side] = { sequentialQuestions: true, freeForm: true, revisedPlan: true, freshGenerations: true, staleAndDuplicateRejected: true, noWriteBeforeApproval: true, approvedWriteAndFreshInference: true };
      } finally { page.off('response', recordInput); }
    }
    async function rejectPlan(mobile: boolean) {
      const side = mobile ? 'mobile' : 'desktop'; results.stage = `${side}-reject`;
      const response = await page.request.post(`${base}/api/chat/conversations`, { headers, data: { title: `CoCo ${side} rejection`, workingDir: workspace, cliProfileId: profile.id } });
      assert.ok(response.ok()); const conversation = await response.json();
      let latestPlan: string | undefined;
      const watch = (socket: import('@playwright/test').WebSocket) => socket.on('framereceived', frame => {
        try { const event = JSON.parse(String(frame.payload)); if (event.type === 'tool_activity' && event.planAction === 'exit') latestPlan = event.id; } catch { /* non-JSON heartbeat */ }
      });
      page.on('websocket', watch);
      try {
        await open(conversation, mobile);
        const card = mobile ? page.locator('.interaction-card') : page.getByRole('group', { name: 'Plan approval' });
        const target = path.join(workspace, `${side}-rejected.txt`);
        await send(page, `Use enter_plan_mode and exit_plan_mode to propose writing ${path.basename(target)} with REJECTED_WORK. Request approval before any write. If rejected, do not execute any plan or write any file; you may remain in planning or end the turn. No agents, SQL, web, background or other work.`);
        await expect(card.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
        const rejected = latestPlan; assert.ok(rejected?.startsWith('cortex-decision:')); await assert.rejects(fs.access(target));
        await card.getByRole('button', { name: 'Reject', exact: true }).click();
        const active = async () => (await (await page.request.get(`${base}/api/chat/active-streams`)).json()).ids.includes(conversation.id);
        await expect.poll(async () => !await active() || Boolean(latestPlan && latestPlan !== rejected), { timeout: 120_000 }).toBe(true);
        await assert.rejects(fs.access(target));
        // Native rejection may end in explanatory text or return to another approval gate.
        if (await active()) assert.ok((await page.request.post(`${base}/api/chat/conversations/${conversation.id}/abort`, { headers, data: {} })).ok());
        await expect.poll(active, { timeout: 120_000 }).toBe(false); await assert.rejects(fs.access(target));
        const saved = await (await page.request.get(`${base}/api/chat/conversations/${conversation.id}`)).json();
        assert.equal(saved.messages.filter((message: { role: string }) => message.role === 'user').length, 1);
        results[`${side}Rejection`] = { rejectedNativeDecision: true, noWrite: true, drainedWithoutResend: true };
      } finally { page.off('websocket', watch); }
    }
    await exercise(false); await rejectPlan(false); await exercise(true); await rejectPlan(true); results.passed = true;
    process.stdout.write('PASS native desktop/mobile questions, rejection, revision, approval, decision ownership and no prompt resend\n');
  } catch (error) { await captureFailure?.().catch(() => {}); await fs.writeFile(path.join(root, 'failure.txt'), error instanceof Error ? error.stack || error.message : 'Probe failed', { mode: 0o600 }); throw error;
  } finally { clearTimeout(deadline); await browser?.close(); pm2(['delete', app]); await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Private interaction evidence: ${path.join(root, 'report.json')}\n`); }
}
async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('footer.composer,div.composer').first();
  await composer.locator('textarea').fill(text);
  const sent = page.waitForRequest(request => request.method() === 'POST' && /\/conversations\/[^/]+\/message$/.test(new URL(request.url()).pathname));
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  const body = (await sent).postDataJSON();
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.equal(body.effort, 'low');
}
main().catch(() => { process.stderr.write('Cortex interaction probe failed; inspect its private report.\n'); process.exitCode = 1; });
