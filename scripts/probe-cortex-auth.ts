import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawnSync } from 'child_process';
import { chromium } from '@playwright/test';
import { cortexVersion, resolveCortexRuntime } from '../src/services/backends/cortexRuntime';
import type { CliProfile } from '../src/types';

/** Saved-login/UI evidence; a human remote OAuth handoff is a separate gate. */
async function main(): Promise<void> {
  assert.equal(process.env.CORTEX_AUTH_PROBE, '1', 'Set CORTEX_AUTH_PROBE=1 for real inference');
  assert.equal(process.platform, 'darwin', 'This probe certifies macOS only');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1', 'Fake mode is not native evidence');
  const connection = process.env.CORTEX_TEST_CONNECTION;
  assert.ok(connection, 'Select an authenticated native Snowflake connection');
  const cwd = process.cwd();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-auth-ui-')); await fs.chmod(root, 0o700);
  const data = path.join(root, 'data'), workspace = path.join(root, 'workspace');
  await fs.mkdir(path.join(data, 'chat'), { recursive: true }); await fs.mkdir(workspace);
  const now = new Date().toISOString();
  const profile: CliProfile = { id: 'setup-cortex-code-account', name: 'Cortex setup', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: now, updatedAt: now };
  await fs.writeFile(path.join(data, 'chat/settings.json'), JSON.stringify({ cliProfiles: [profile], theme: 'light', sendBehavior: 'enter', systemPrompt: '' }), { mode: 0o600 });
  const version = await cortexVersion(resolveCortexRuntime({ profile, cwd: workspace, workspaceId: 'auth-probe' }));
  assert.equal(version, '1.2.35', 'Review native login compatibility before certifying another version');
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => {
      const value = (server.address() as net.AddressInfo).port; server.close(() => resolve(value));
    });
  });
  const app = `cortex-auth-probe-${process.pid}`;
  const config = path.join(root, 'ecosystem.config.cjs');
  await fs.writeFile(config, `module.exports=${JSON.stringify({ apps: [{ name: app, cwd, script: 'server.ts', interpreter: process.execPath,
    node_args: ['--import', 'tsx'], autorestart: false, kill_timeout: 20000, out_file: path.join(root, 'server-out.log'), error_file: path.join(root, 'server-error.log'),
    env: { NODE_ENV: 'test', PORT: port, BASE_PATH: '', AGENT_COCKPIT_DATA_DIR: data, AUTH_DATA_DIR: path.join(data, 'auth'),
      DEFAULT_WORKSPACE: workspace, SESSION_SECRET: crypto.randomBytes(32).toString('hex'), WEB_BUILD_MODE: 'skip' },
  }] })};\n`, { mode: 0o600 });
  const pm2 = (args: string[]) => spawnSync(process.execPath, [path.join(cwd, 'node_modules/pm2/bin/pm2'), ...args], { cwd, stdio: 'ignore' });
  const results: Record<string, unknown> = { remoteBrowserOAuth: 'pending-human-handoff' };
  const report = { startedAt: now, platform: process.platform, arch: process.arch, node: process.version, cliVersion: version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    assert.equal(pm2(['start', config, '--only', app]).status, 0, 'PM2 fixture start failed');
    const baseUrl = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = (await fetch(`${baseUrl}/api/chat/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* starting */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(ready, 'PM2 fixture did not become ready');
    // Remote requests still pass through the app's existing authentication wall.
    const unauthorized = await fetch(`${baseUrl}/api/chat/cli-profiles/cortex-code/connections`, { headers: { 'X-Forwarded-Host': 'remote.fixture.invalid' } });
    results.remoteAuthorizationStatus = unauthorized.status;
    assert.equal(unauthorized.status, 401, 'Connection setup must require authenticated remote access');
    results.remoteAuthorization = true;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(45_000);
    results.stage = 'welcome';
    await page.goto(`${baseUrl}/v2/?welcome=1`);
    // A fresh fixture starts at Welcome; no production user data is used.
    const panel = page.getByRole('region', { name: 'Cortex Code setup' });
    await page.getByRole('button', { name: 'Cortex Code (CoCo) setup', exact: true }).click();
    await panel.getByRole('combobox').selectOption(connection);
    results.stage = 'saved-login-check';
    const [check] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/cli-profiles/setup-auth/cortex-code/test'), { timeout: 120_000 }),
      panel.getByRole('button', { name: 'Check Cortex login', exact: true }).click(),
    ]);
    const checked = await check.json();
    results.checkHttpStatus = check.status();
    results.checkStatus = checked.result?.status;
    results.checkAuthenticated = checked.result?.authenticated;
    if (!checked.result?.authenticated) results.checkError = checked.result?.error || 'No successful authentication result.';
    assert.equal(checked.result?.authenticated, true, 'Native fresh-process check did not verify');
    await panel.getByRole('status').filter({ hasText: 'credentials and inference access verified from a fresh process' }).waitFor({ timeout: 120_000 });
    results.savedAuthFreshInference = true;
    results.stage = 'cached-job';
    await panel.getByRole('button', { name: 'Authenticate Cortex', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'credentials and inference access verified from a fresh process' }).waitFor({ timeout: 120_000 });
    results.cachedAuthJob = true;
    results.stage = 'cancel-retry';
    assert.equal(await panel.getByLabel('Native login URL', { exact: true }).count(), 0, 'Saved login must not fabricate an OAuth handoff');
    // Cancel during fresh-process startup, then retry after native cleanup.
    await panel.getByRole('button', { name: 'Authenticate Cortex', exact: true }).click();
    await panel.getByRole('button', { name: 'Cancel Cortex login', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Authentication cancelled.' }).waitFor();
    await new Promise(resolve => setTimeout(resolve, 4000));
    await panel.getByRole('button', { name: 'Authenticate Cortex', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'credentials and inference access verified from a fresh process' }).waitFor({ timeout: 120_000 });
    results.cancelAndRetry = true;
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Setup must fit a narrow browser viewport');
    results.responsiveSetup = true;
    results.stage = 'desktop-profile-editor';
    await page.setViewportSize({ width: 1280, height: 900 });
    results.stage = 'desktop-default-selection';
    await page.getByRole('button', { name: 'CLI Profiles', exact: true }).click();
    const card = page.locator('.cli-card').first();
    if (await card.locator('.cli-card-head').getAttribute('aria-expanded') !== 'true') await card.locator('.cli-card-head').click();
    assert.equal(await card.getByLabel(/^Harness/).inputValue(), 'cortex-code');
    assert.equal(await card.getByLabel(/^Snowflake connection/).inputValue(), connection);
    assert.equal(await card.getByLabel(/^Command/).getAttribute('placeholder'), 'cortex');
    assert.equal(await card.getByRole('button', { name: 'Authenticate', exact: true }).count(), 0, 'CoCo must use its owned shared-auth handoff');
    await card.getByLabel('Name', { exact: true }).fill('CoCo desktop fixture');
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/chat/settings') && response.request().method() === 'PUT'),
      page.getByRole('button', { name: 'Save', exact: true }).click()]);
    results.profileEditor = true;
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Profile fields must fit a narrow browser viewport');
    results.responsiveProfileEditor = true;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'General', exact: true }).click();
    await page.getByLabel(/^Default CLI profile/).selectOption(profile.id);
    await page.getByLabel(/^Default model/).selectOption('claude-sonnet-4-6', { timeout: 120_000 });
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/chat/settings') && response.request().method() === 'PUT'),
      page.getByRole('button', { name: 'Save', exact: true }).click()]);
    results.stage = 'desktop-conversation';
    const csrf = (await (await page.request.get(`${baseUrl}/api/csrf-token`)).json()).csrfToken;
    const headers = { 'x-csrf-token': csrf };
    assert.ok((await page.request.post(`${baseUrl}/api/chat/install/welcome-complete`, { headers, data: {} })).ok());
    const created = await page.request.post(`${baseUrl}/api/chat/conversations`, { headers,
      data: { title: 'CoCo desktop selection', workingDir: workspace, cliProfileId: profile.id, model: 'claude-sonnet-4-6', effort: 'low' } });
    assert.ok(created.ok(), 'Desktop fixture conversation could not be created');
    const conversation = await created.json();
    await page.goto(`${baseUrl}/v2/`);
    await page.getByLabel('Workspace filter').selectOption(conversation.workspaceId);
    await page.locator('.sb-row').filter({ hasText: 'CoCo desktop selection' }).click();
    const composer = page.locator('.composer');
    assert.equal(await composer.getByLabel('CLI Profile', { exact: true }).inputValue(), profile.id);
    await composer.getByLabel('Model', { exact: true }).selectOption('claude-sonnet-4-6', { timeout: 120_000 });
    await composer.getByLabel('Adaptive reasoning effort', { exact: true }).selectOption('low');
    for (const label of ['Claude Code mode', 'Codex service tier']) assert.equal(await composer.getByLabel(label, { exact: true }).count(), 0);
    assert.equal(await composer.locator('.goal-toggle').count(), 0, 'CoCo must not expose goal mode');
    assert.ok(await composer.locator('.backend-inline-icon svg').count(), 'CoCo profile icon is missing');
    results.desktopCatalogAndControls = true;
    results.stage = 'desktop-inference';
    const nonce = `C42-${crypto.randomBytes(6).toString('hex')}`;
    await composer.locator('textarea').fill(`Reply with exactly ${nonce} and no other text.`);
    await composer.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('.msg-agent').filter({ hasText: nonce }).waitFor({ timeout: 120_000 });
    await composer.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 120_000 });
    results.desktopFreshInference = true;
    const persisted = await fs.readFile(path.join(data, 'chat/settings.json'), 'utf8');
    assert.equal(/code_challenge|redirectUrl|authorizationUrl|oauth\/authorize/.test(persisted), false, 'Handoff secrets must never enter settings');
    results.noPersistedHandoff = true;
    process.stdout.write('PASS native saved auth, UI jobs, responsive setup/profile editing, desktop catalogs/controls and fresh inference\n');
  } catch (error) {
    await fs.writeFile(path.join(root, 'failure.txt'), error instanceof Error ? error.stack || error.message : 'Probe failed', { mode: 0o600 });
    throw error;
  } finally {
    await browser?.close(); pm2(['delete', app]);
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Sanitized Cortex auth report: ${path.join(root, 'report.json')}\n`);
  }
}

main().catch(() => { process.stderr.write('Cortex auth probe failed; inspect the private fixture report.\n'); process.exitCode = 1; });
