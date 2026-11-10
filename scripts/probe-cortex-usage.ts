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

/** C45: native usage/context/caches/reload, isolated PM2/data/workspace, shared terminal auth. */
async function main(): Promise<void> {
  assert.equal(process.env.CORTEX_USAGE_PROBE, '1', 'Set CORTEX_USAGE_PROBE=1 for native inference');
  assert.equal(process.platform, 'darwin', 'Only macOS is certified by this probe');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1', 'Fake mode is not native evidence');
  const connection = process.env.CORTEX_TEST_CONNECTION; assert.ok(connection, 'Select a saved native connection');
  const cwd = process.cwd(), startedAt = new Date().toISOString();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-usage-')); await fs.chmod(root, 0o700);
  const workspace = path.join(root, 'workspace'), data = path.join(root, 'data');
  await fs.mkdir(workspace); await fs.mkdir(path.join(data, 'chat'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), '# Scoped compatibility workspace\nOnly perform the exact requested fixture work. No agents, goals, Memory, KB, routines, SQL, web, background work or outreach.\n');
  const profile: CliProfile = { id: 'cortex-usage-probe', name: 'CoCo usage', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: startedAt, updatedAt: startedAt };
  await fs.writeFile(path.join(data, 'chat/settings.json'), JSON.stringify({ theme: 'light', sendBehavior: 'enter', systemPrompt: '', cliProfiles: [profile],
    defaultCliProfileId: profile.id, defaultBackend: 'cortex-code', defaultModel: 'claude-sonnet-4-6', defaultEffort: 'low' }), { mode: 0o600 });
  const version = await cortexVersion(resolveCortexRuntime({ profile, workspaceId: 'probe', cwd: workspace }));
  assert.equal(version, '1.2.35', 'Review native compatibility before certifying another version');
  const port = await new Promise<number>((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port));
  }); });
  const app = `cortex-usage-${process.pid}`, config = path.join(root, 'ecosystem.config.cjs');
  await fs.writeFile(config, `module.exports=${JSON.stringify({ apps: [{ name: app, cwd, script: 'server.ts', interpreter: process.execPath, node_args: ['--import', 'tsx'],
    autorestart: false, kill_timeout: 20000, out_file: path.join(root, 'server-out.log'), error_file: path.join(root, 'server-error.log'),
    env: { NODE_ENV: 'test', PORT: port, BASE_PATH: '', AGENT_COCKPIT_DATA_DIR: data, AUTH_DATA_DIR: path.join(data, 'auth'), DEFAULT_WORKSPACE: workspace,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'), WEB_BUILD_MODE: 'skip' } }] })};\n`, { mode: 0o600 });
  const pm2 = (args: string[]) => spawnSync(process.execPath, [path.join(cwd, 'node_modules/pm2/bin/pm2'), ...args], { cwd, stdio: 'ignore' });
  const results: Record<string, unknown> = {};
  const report = { startedAt, cliVersion: version, platform: process.platform, arch: process.arch, node: process.version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const deadline = setTimeout(() => { results.deadlineExceeded = true; void browser?.close(); }, 6 * 60_000);
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
    async function open(conversation: { id: string; title: string; workspaceId: string }, mobile: boolean) {
      conversation.title = (await (await page.request.get(`${base}/api/chat/conversations/${conversation.id}`)).json()).title;
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
    const usageKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
    const totalTokens = (usage: any) => usageKeys.reduce((sum, key) => sum + usage[key], 0);
    const counts = (usage: any) => usageKeys.map(key => usage[key].toLocaleString());
    async function read(id: string) {
      const response = await page.request.get(`${base}/api/chat/conversations/${id}`); assert.ok(response.ok());
      return response.json();
    }
    async function verifyUi(usage: any, mobile: boolean) {
      assert.equal(usage.costSource, 'none'); assert.equal(usage.costUsd, 0);
      assert.equal(usage.estimatedCostUsd, undefined); assert.equal(usage.costSnapshot, undefined);
      for (const key of usageKeys) assert.ok(Number.isFinite(usage[key]) && usage[key] >= 0);
      assert.ok(totalTokens(usage) > 0);
      if (mobile) {
        const context = usage.contextUsagePercentage;
        const expectedContext = context === undefined ? 'n/a' : `${context < 10 ? context.toFixed(1) : Math.round(context)}%`;
        await expect(page.locator('.usage-bar .usage-value')).toHaveText([totalTokens(usage).toLocaleString(), 'n/a', 'n/a', expectedContext]);
        await page.getByText('Token breakdown', { exact: true }).click();
        await expect(page.locator('.usage-breakdown dd')).toHaveText(counts(usage));
        await expect(page.locator('.usage-breakdown')).toContainText('Snowflake pricing is unavailable');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile overflow');
        await page.getByText('Token breakdown', { exact: true }).click();
      } else {
        const chip = page.locator('span.u-mono').filter({ hasText: /cost n\/a/ }).last();
        await expect(chip).toBeVisible();
        if (usage.contextUsagePercentage !== undefined) await expect(chip).toContainText(`${usage.contextUsagePercentage.toFixed(2)}% context`);
        await chip.focus();
        const card = page.locator('.tt-kv').filter({ hasText: 'Fresh input' }); await expect(card).toBeVisible();
        for (const [index, label] of ['Fresh input', 'Output', 'Cache read', 'Cache write'].entries())
          await expect(page.locator('.tt-kv').filter({ hasText: label }).locator('b')).toHaveText(counts(usage)[index]);
        await expect(page.locator('.tt-kv').filter({ hasText: /^Cost/ }).locator('b')).toHaveText('n/a');
        await expect(page.locator('.tt-kv').filter({ hasText: 'Estimated Cost' }).locator('b')).toHaveText('n/a');
        await chip.blur();
      }
    }
    const conversations: Array<{ id: string; title: string; workspaceId: string }> = [];
    for (const mobile of [false, true]) {
      const side = mobile ? 'mobile' : 'desktop'; results.stage = side;
      const response = await page.request.post(`${base}/api/chat/conversations`, { headers, data: { title: `CoCo usage ${side}`, workingDir: workspace, cliProfileId: profile.id } });
      assert.ok(response.ok()); const conversation = await response.json(); conversations.push(conversation);
      await open(conversation, mobile);
      const frames: any[] = []; let recording = false;
      const watch = (socket: import('@playwright/test').WebSocket) => {
        let replaying = false;
        socket.on('framereceived', frame => {
          try {
            const event = JSON.parse(String(frame.payload));
            if (event.type === 'replay_start') replaying = true;
            else if (event.type === 'replay_end') replaying = false;
            else if (event.type === 'usage' && recording && !replaying) frames.push(event);
          } catch { /* heartbeat */ }
        });
      };
      page.on('websocket', watch);
      // Open the live socket after installing the watcher.
      await open(conversation, mobile);
      let saved: any;
      for (let turn = 0; turn < 2; turn++) {
        recording = true;
        const before = frames.length, nonce = `C45_${crypto.randomBytes(6).toString('hex')}`;
        await send(page, `Reply exactly ${nonce}. Do not call tools.`);
        await expect.poll(() => frames.length).toBe(before + 1);
        await expect.poll(async () => (await (await page.request.get(`${base}/api/chat/active-streams`)).json()).ids.includes(conversation.id)).toBe(false);
        await expect((mobile ? page.locator('.message.assistant') : page.locator('.msg-agent')).filter({ hasText: nonce }).last()).toBeVisible();
        recording = false;
        saved = await read(conversation.id); assert.deepEqual(frames.at(-1).sessionUsage, saved.sessionUsage);
        await verifyUi(saved.sessionUsage, mobile);
        const snapshot = JSON.stringify(saved.sessionUsage);
        await open(conversation, mobile); await verifyUi(saved.sessionUsage, mobile);
        assert.equal(JSON.stringify((await read(conversation.id)).sessionUsage), snapshot, 'Reload changed usage');
      }
      assert.equal(frames.length, 2, 'Replay duplicated final usage'); page.off('websocket', watch);
      process.stdout.write(`PASS native ${side} usage/reload\n`);
      results[side] = { passed: true, prompts: 2, usage: saved.sessionUsage, totalTokens: totalTokens(saved.sessionUsage), reloaded: true };
      await page.screenshot({ path: path.join(root, `${side}.png`), fullPage: true });
    }
    results.stage = 'server-restart';
    const snapshots = await Promise.all(conversations.map(async conversation => (await read(conversation.id)).sessionUsage));
    assert.equal(pm2(['restart', app]).status, 0);
    await expect.poll(async () => { try { return (await fetch(`${base}/api/chat/version`)).ok; } catch { return false; } }).toBe(true);
    for (let index = 0; index < conversations.length; index++) {
      assert.deepEqual((await read(conversations[index].id)).sessionUsage, snapshots[index]);
      await open(conversations[index], index === 1); await verifyUi(snapshots[index], index === 1);
    }
    const ledger = await (await page.request.get(`${base}/api/chat/usage-stats`)).json();
    const rows = ledger.days.flatMap((day: any) => day.records).filter((row: any) => row.backend === 'cortex-code');
    const accumulated = Object.fromEntries(usageKeys.map(key => [key, rows.reduce((sum: number, row: any) => sum + row.usage[key], 0)]));
    for (const key of usageKeys) assert.equal(accumulated[key], snapshots.reduce((sum, usage) => sum + usage[key], 0));
    assert.ok(rows.every((row: any) => row.usage.costSource === 'none' && row.usage.costUsd === 0 && row.usage.estimatedCostUsd === undefined));
    results.stage = 'usage-settings';
    await open(conversations[0], false);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Usage & Cost', exact: true }).click();
    await expect(page.locator('.settings-usage .stat .num')).toHaveText(['n/a', 'n/a', 'n/a', 'n/a']);
    const row = page.locator('.usage-summary-table tbody tr').filter({ hasText: 'cortex-code' });
    await expect(row).toHaveCount(1);
    await expect(row.locator('td').nth(7)).toHaveText('n/a');
    await expect(row.locator('td').nth(8)).toHaveText('n/a');
    await expect(page.getByText('No priced usage for this metric.', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(root, 'usage-settings.png'), fullPage: true });
    results.usageSettings = true;
    results.ledgerReconciled = true; results.serverRestart = true; results.passed = true;
  } catch (error) { const failedPage = browser?.contexts()[0]?.pages()[0];
    if (failedPage) await failedPage.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(root, 'failure.txt'), error instanceof Error ? error.stack || error.message : 'Probe failed', { mode: 0o600 }); throw error;
  } finally { clearTimeout(deadline); await browser?.close(); pm2(['delete', app]); await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Private usage evidence: ${path.join(root, 'report.json')}\n`); }
}
async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('footer.composer,div.composer').first(); await composer.locator('textarea').fill(text);
  const sent = page.waitForRequest(request => request.method() === 'POST' && /\/conversations\/[^/]+\/message$/.test(new URL(request.url()).pathname));
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  const body = (await sent).postDataJSON(); assert.equal(body.model, 'claude-sonnet-4-6'); assert.equal(body.effort, 'low');
}
main().catch(() => { process.stderr.write('CoCo usage probe failed; inspect private temporary report.\n'); process.exitCode = 1; });
