import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawnSync } from 'child_process';
import { chromium, expect as baseExpect, type Browser } from '@playwright/test';
import { cortexVersion, resolveCortexRuntime } from '../src/services/backends/cortexRuntime';
import type { CliAuthJobSnapshot, CliProfile } from '../src/types';

/** Saved-login/UI evidence; a human remote OAuth handoff is a separate gate. */
async function main(): Promise<void> {
  const updatesUiOnly = process.env.CORTEX_UPDATE_UI_PROBE === '1';
  assert.ok(updatesUiOnly || process.env.CORTEX_AUTH_PROBE === '1', 'Set CORTEX_AUTH_PROBE=1 for real inference or CORTEX_UPDATE_UI_PROBE=1 for update status only');
  assert.equal(process.platform, 'darwin', 'This probe certifies macOS only');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1', 'Fake mode is not native evidence');
  const connection = process.env.CORTEX_TEST_CONNECTION || (updatesUiOnly ? 'fixture' : undefined);
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
  const pm2 = (args: string[]) => spawnSync(process.execPath, [path.join(cwd, 'node_modules/pm2/bin/pm2'), ...args], { cwd, stdio: 'ignore', timeout: 30000 });
  const results: Record<string, unknown> = { scope: updatesUiOnly ? 'updates-ui-only' : 'auth-and-responsive-ui', remoteBrowserOAuth: 'pending-human-handoff' };
  const report = { startedAt: now, platform: process.platform, arch: process.arch, node: process.version, cliVersion: version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const deadline = setTimeout(() => { results.deadlineExceeded = true; void browser?.close(); }, 10 * 60_000);
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
    await page.getByText('Cortex Code CLI responded. Login has not been checked.', { exact: true }).waitFor();
    results.welcomeExecutableDetectionSeparateFromLogin = true;
    if (updatesUiOnly) {
      results.stage = 'desktop-update-status';
      await page.getByRole('button', { name: 'CLI Profiles', exact: true }).click();
      await verifyUpdateRow(page);
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'CLI Updates overflow the viewport');
      }
      results.desktopCortexUpdateStatus = true;
      results.noUpdateOrAuthenticationAttempted = true;
      results.passed = true;
      process.stdout.write('PASS Cortex CLI Update status at 1280/390/320 px; no update or authentication attempted\n');
      return;
    }
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
    assert.equal(await panel.getByRole('textbox', { name: 'Native login URL', exact: true }).count(), 0, 'Saved login must not fabricate an OAuth handoff');
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
    if (!process.env.CORTEX_TEST_COMMAND) {
      await verifyUpdateRow(page);
      results.desktopCortexUpdateStatus = true; // Never update the normal installation in this probe.
    }
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
    results.stage = 'synthetic-responsive-handoff';
    results.responsiveHandoff = await verifyResponsiveHandoff(browser, baseUrl, root);
    assert.equal(/C47_SYNTHETIC|code_challenge|redirectUrl|authorizationUrl|oauth\/authorize/.test(await fs.readFile(path.join(data, 'chat/settings.json'), 'utf8')), false,
      'Synthetic handoff material must never enter server settings');
    results.passed = true;
    process.stdout.write('PASS native saved auth, UI jobs, responsive setup/profile editing, desktop catalogs/controls and fresh inference\n');
  } catch (error) {
    await fs.writeFile(path.join(root, 'failure.txt'), error instanceof Error ? error.stack || error.message : 'Probe failed', { mode: 0o600 });
    throw error;
  } finally {
    clearTimeout(deadline);
    await browser?.close(); pm2(['delete', app]);
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Sanitized Cortex auth report: ${path.join(root, 'report.json')}\n`);
  }
}

async function verifyUpdateRow(page: import('@playwright/test').Page): Promise<void> {
  const row = page.locator('.cli-update-row').filter({ hasText: 'Cortex Code (CoCo)' });
  await row.getByText('self-update', { exact: true }).waitFor();
  await baseExpect(row).toContainText('1.2.35+');
  await baseExpect(row.getByRole('button', { name: 'Run updater', exact: true })).toBeEnabled();
}

/** Browser mechanics only: never send these synthetic codes to Snowflake/native auth. */
async function verifyResponsiveHandoff(browser: Browser, baseUrl: string, root: string): Promise<unknown[]> {
  const expect = baseExpect.configure({ timeout: 15000 });
  const results: unknown[] = [];
  for (const surface of ['welcome', 'settings']) for (const width of [1280, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const jobs = new Map<string, CliAuthJobSnapshot>();
    const secrets: string[] = []; let active: CliAuthJobSnapshot | undefined, sequence = 0, submitted = 0;
    let releaseRedirect = () => {}; let rejectRedirect = false;
    const nextTime = () => new Date(Date.now() + ++sequence).toISOString();
    const terminal = (status: 'succeeded' | 'cancelled' | 'failed') => {
      assert.ok(active); active.status = status; active.updatedAt = nextTime(); active.cortex = undefined;
      active.events = [{ at: active.updatedAt, type: 'info', text: `Synthetic handoff ${status}` }];
    };
    await page.route('**/api/chat/cli-profiles/**', async route => {
      const request = route.request(), url = new URL(request.url());
      const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
      if (url.pathname.endsWith('/cortex-code/connections') && request.method() === 'GET') {
        return respond({ connections: [{ name: 'c47-fixture', manualOAuth: true, browserTimeoutMs: 600000 }], job: active?.status === 'running' ? active : null });
      }
      if (url.pathname.endsWith('/setup-auth/cortex-code/start')) {
        const now = nextTime(), secret = `C47_SYNTHETIC_${crypto.randomBytes(16).toString('hex')}`;
        const login = new URL('https://fixture.snowflakecomputing.com/oauth/authorize');
        login.search = new URLSearchParams({ response_type: 'code', client_id: 'fixture-' + 'x'.repeat(128), scope: 'refresh_token session:role-any',
          redirect_uri: 'http://127.0.0.1:54321/', state: secret, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' }).toString();
        active = { id: `cortex-auth-fixture-${sequence}`, profileId: 'setup-cortex-code-account', profileName: 'Fixture', harness: 'cortex-code',
          status: 'running', startedAt: now, updatedAt: now, command: 'cortex', args: [], events: [],
          cortex: { phase: 'waiting-for-browser', generation: crypto.randomUUID(), connection: 'c47-fixture', authorizationUrl: login.href, expiresAt: new Date(Date.now() + 600000).toISOString() } };
        jobs.set(active.id, active); secrets.push(secret, login.href, active.cortex!.generation);
        return respond({ profile: { id: active.profileId, harness: 'cortex-code', authMode: 'account', cortexCode: { connection: 'c47-fixture' } }, job: active });
      }
      const match = url.pathname.match(/\/auth-jobs\/([^/]+)(?:\/(redirect|cancel))?$/);
      if (match) {
        const job = jobs.get(match[1]); assert.ok(job, 'Browser requested an unowned synthetic job');
        if (match[2] === 'redirect') {
          const body = request.postDataJSON(); assert.equal(body.generation, job.cortex?.generation);
          assert.equal(body.redirectUrl, secrets.at(-1), 'Redirect bytes changed during browser copy/paste'); submitted++;
          if (rejectRedirect) return respond({ error: 'This login handoff is no longer active.' }, 400);
          await new Promise<void>(resolve => { releaseRedirect = resolve; });
          job.updatedAt = nextTime(); job.cortex = { ...job.cortex!, phase: 'verifying', authorizationUrl: undefined };
          return respond({ job });
        }
        if (match[2] === 'cancel') terminal('cancelled');
        return respond({ job });
      }
      if (url.pathname.endsWith('/metadata')) return respond({ profileId: url.pathname.split('/').at(-2), backend: { id: 'cortex-code', label: 'CoCo', models: [], capabilities: { goals: false } } });
      return route.continue();
    });
    const panel = page.getByRole('region', { name: 'Cortex Code setup' });
    const open = async () => { await page.goto(`${baseUrl}/v2/?welcome=1`);
      if (surface === 'settings') await page.getByRole('button', { name: 'CLI Profiles', exact: true }).click();
      await panel.getByRole('button', { name: 'Cortex Code (CoCo) setup', exact: true }).click(); };
    const cleanStorage = async () => {
      const snapshot = await page.evaluate(async () => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage),
        history: history.state, url: location.href, databases: await indexedDB.databases(), caches: await caches.keys() }));
      const saved = JSON.stringify({ snapshot, cookies: await context.cookies() });
      assert.ok(secrets.every(secret => !saved.includes(secret)), 'Handoff material reached persistent browser storage/history');
      assert.equal(snapshot.databases.length, 0, 'Unexpected database in the isolated desktop setup context');
      assert.equal(snapshot.caches.length, 0, 'Unexpected Cache Storage in the isolated desktop setup context');
    };
    const pasteRedirect = async () => {
      assert.ok(active?.cortex?.authorizationUrl);
      const url = panel.getByRole('textbox', { name: 'Native login URL', exact: true });
      await url.focus(); await page.keyboard.press('ControlOrMeta+C');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), active.cortex.authorizationUrl, 'Native URL copy was truncated');
      const login = new URL(active.cortex.authorizationUrl), redirect = new URL('http://127.0.0.1:54321/');
      redirect.search = new URLSearchParams({ code: crypto.randomBytes(20).toString('hex'), state: login.searchParams.get('state')!, iss: 'https://fixture.snowflakecomputing.com/oauth' }).toString();
      secrets.push(redirect.searchParams.get('code')!, redirect.href);
      await page.evaluate(value => navigator.clipboard.writeText(value), redirect.href);
      const field = panel.getByLabel('Complete redirect URL', { exact: true }); await field.focus(); await page.keyboard.press('ControlOrMeta+V');
      await expect(field).toHaveValue(redirect.href); await cleanStorage();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Live handoff overflows the viewport');
      for (const control of [url, field, panel.getByRole('button', { name: 'Submit redirect', exact: true })]) {
        const box = await control.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, 'Handoff control extends outside the viewport');
      }
    };
    try {
      await open(); await panel.getByRole('button', { name: 'Authenticate Cortex', exact: true }).click();
      await pasteRedirect();
      await page.screenshot({ path: path.join(root, `handoff-${surface}-${width}-active.png`), fullPage: true });
      // A reload may recover the server-owned URL, but never the unsent local redirect.
      await open(); await expect(panel.getByLabel('Complete redirect URL', { exact: true })).toHaveValue('');
      await pasteRedirect();
      await panel.getByRole('button', { name: 'Submit redirect', exact: true }).click();
      await expect(panel.getByLabel('Complete redirect URL', { exact: true })).toHaveValue('');
      await expect.poll(() => submitted).toBe(1); await cleanStorage(); releaseRedirect();
      await expect(panel.getByRole('textbox', { name: 'Native login URL', exact: true })).toHaveCount(0);
      terminal('succeeded'); await expect(panel.getByRole('status')).toHaveText('Synthetic handoff succeeded');
      await panel.getByRole('button', { name: 'Authenticate Cortex', exact: true }).click(); await pasteRedirect();
      await panel.getByRole('button', { name: 'Cancel Cortex login', exact: true }).click();
      await expect(panel.getByRole('textbox', { name: 'Native login URL', exact: true })).toHaveCount(0);
      await expect(panel.getByLabel('Complete redirect URL', { exact: true })).toHaveCount(0);
      await panel.getByRole('button', { name: 'Authenticate Cortex', exact: true }).click(); await pasteRedirect();
      rejectRedirect = true; await panel.getByRole('button', { name: 'Submit redirect', exact: true }).click();
      await expect(panel.getByRole('alert')).toHaveText('This login handoff is no longer active.');
      await expect(panel.getByLabel('Complete redirect URL', { exact: true })).toHaveValue('');
      await panel.getByLabel('Complete redirect URL', { exact: true }).fill(secrets.at(-1)!);
      terminal('failed'); await expect(panel.getByRole('textbox', { name: 'Native login URL', exact: true })).toHaveCount(0);
      await expect(panel.getByLabel('Complete redirect URL', { exact: true })).toHaveCount(0);
      await cleanStorage(); await open(); await expect(panel.getByRole('textbox', { name: 'Native login URL', exact: true })).toHaveCount(0);
      assert.equal(submitted, 2, 'A redirect was submitted more than once per explicit click');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Setup overflows the viewport');
      await cleanStorage(); await page.screenshot({ path: path.join(root, `handoff-${surface}-${width}.png`), fullPage: true });
      results.push({ surface, width, synthetic: true, completeClipboardRoundTrip: true, transientRedirect: true, serverJobRecovery: true,
        successCancelErrorTimeout: true, noStoredSecrets: true, submissions: submitted });
    } catch (error) {
      await page.screenshot({ path: path.join(root, 'handoff-failure.png'), fullPage: true }).catch(() => {});
      await fs.writeFile(path.join(root, 'handoff-ui.json'), JSON.stringify({ textareas: await panel.locator('textarea').count(),
        exactRole: await panel.getByRole('textbox', { name: 'Native login URL', exact: true }).count(), partialLabel: await panel.getByLabel('Native login URL').count(),
        status: await panel.getByRole('status').textContent() }), { mode: 0o600 }).catch(() => {});
      throw error;
    }
    finally { releaseRedirect(); await page.evaluate(() => navigator.clipboard.writeText('')).catch(() => {}); await context.close(); }
  }
  return results;
}

main().catch(() => { process.stderr.write('Cortex auth probe failed; inspect the private fixture report.\n'); process.exitCode = 1; });
