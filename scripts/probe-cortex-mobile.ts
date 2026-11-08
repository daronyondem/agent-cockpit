import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import net from 'net';
import { createCanvas } from '@napi-rs/canvas';
import { spawnSync } from 'child_process';
import { chromium, expect as baseExpect, type Page } from '@playwright/test';
import { cortexVersion, resolveCortexRuntime } from '../src/services/backends/cortexRuntime';
import type { CliProfile } from '../src/types';

const expect = baseExpect.configure({ timeout: 120_000 });

/** C46: native mobile media/history/recovery, isolated PM2/data/workspace, shared terminal auth. */
async function main(): Promise<void> {
  assert.equal(process.env.CORTEX_MOBILE_PROBE, '1', 'Set CORTEX_MOBILE_PROBE=1 for native inference');
  assert.equal(process.platform, 'darwin', 'Only macOS is certified by this probe');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1', 'Fake mode is not native evidence');
  const connection = process.env.CORTEX_TEST_CONNECTION; assert.ok(connection, 'Select a saved native connection');
  const cwd = process.cwd(), startedAt = new Date().toISOString();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-mobile-')); await fs.chmod(root, 0o700);
  const workspace = path.join(root, 'workspace'), data = path.join(root, 'data');
  await fs.mkdir(workspace); await fs.mkdir(path.join(data, 'chat'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), '# Scoped compatibility workspace\nThis is a user-owned local compatibility workspace. The user authorizes reading synthetic uploaded files, reviewing and running the local Python fixture scripts, and creating/delivering the fixture CSV to this browser. Review scripts before execution; do not change them. No credential access, agents, goals, Memory, KB, SQL, web, background work or outreach.\n');
  const profile: CliProfile = { id: 'cortex-mobile-probe', name: 'CoCo mobile', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: startedAt, updatedAt: startedAt };
  await fs.writeFile(path.join(data, 'chat/settings.json'), JSON.stringify({ theme: 'light', sendBehavior: 'enter', systemPrompt: '', cliProfiles: [{ ...profile, id: 'cortex-mobile-initial', name: 'CoCo initial' }, profile],
    defaultCliProfileId: profile.id, defaultBackend: 'cortex-code', defaultModel: 'auto' }), { mode: 0o600 });
  const version = await cortexVersion(resolveCortexRuntime({ profile, workspaceId: 'probe', cwd: workspace }));
  assert.equal(version, '1.2.35', 'Review native compatibility before certifying another version');
  const port = await new Promise<number>((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port));
  }); });
  const app = `cortex-mobile-${process.pid}`, config = path.join(root, 'ecosystem.config.cjs');
  await fs.writeFile(config, `module.exports=${JSON.stringify({ apps: [{ name: app, cwd, script: 'server.ts', interpreter: process.execPath, node_args: ['--import', 'tsx'],
    autorestart: false, kill_timeout: 20000, out_file: path.join(root, 'server-out.log'), error_file: path.join(root, 'server-error.log'),
    env: { NODE_ENV: 'test', PORT: port, BASE_PATH: '', AGENT_COCKPIT_DATA_DIR: data, AUTH_DATA_DIR: path.join(data, 'auth'), DEFAULT_WORKSPACE: workspace,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'), WEB_BUILD_MODE: 'skip' } }] })};\n`, { mode: 0o600 });
  const pm2 = (args: string[]) => spawnSync(process.execPath, [path.join(cwd, 'node_modules/pm2/bin/pm2'), ...args], { cwd, stdio: 'ignore' });
  const results: Record<string, unknown> = {};
  const report = { startedAt, cliVersion: version, platform: process.platform, arch: process.arch, node: process.version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const deadline = setTimeout(() => { results.deadlineExceeded = true; void browser?.close(); }, 10 * 60_000);
  try {
    assert.equal(pm2(['start', config, '--only', app]).status, 0);
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(`${base}/api/chat/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* startup */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 500)); }
    assert.ok(ready, 'Fixture did not become ready');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(120_000);
    const catalogs: Array<{ status: number; models: number }> = []; results.catalogs = catalogs;
    page.on('response', response => {
      if (/\/cli-profiles\/[^/]+\/metadata$/.test(new URL(response.url()).pathname)) {
        void response.json().then(body => catalogs.push({ status: response.status(), models: body.backend?.models?.length || 0 })).catch(() => {});
      }
    });
    const csrf = (await (await page.request.get(`${base}/api/csrf-token`)).json()).csrfToken;
    const headers = { 'x-csrf-token': csrf };
    assert.ok((await page.request.post(`${base}/api/chat/install/welcome-complete`, { headers, data: {} })).ok());
    const nonce = `C46_${crypto.randomBytes(6).toString('hex')}`, imageText = 'CORTEX MOBILE 7319';
    const image = path.join(root, 'mobile.png'), text = path.join(root, 'mobile.txt'), csv = path.join(workspace, 'mobile.csv');
    const canvas = createCanvas(950, 220), context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 950, 220);
    context.fillStyle = 'black'; context.font = '48px sans-serif'; context.fillText(imageText, 40, 110);
    await fs.writeFile(image, canvas.toBuffer('image/png')); await fs.writeFile(text, nonce);
    await page.addInitScript(() => {
      const Native = window.WebSocket; (window as any).__mobileSockets = [];
      window.WebSocket = class extends Native { constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols); (window as any).__mobileSockets.push(this);
      } };
    });
    const frames: any[] = [];
    page.on('websocket', socket => socket.on('framereceived', frame => { try { frames.push(JSON.parse(String(frame.payload))); } catch { /* heartbeat */ } }));
    const response = await page.request.post(`${base}/api/chat/conversations`, { headers, data: {
      title: 'CoCo mobile acceptance', workingDir: workspace, cliProfileId: 'cortex-mobile-initial', model: 'auto' } });
    assert.ok(response.ok()); const conversation = await response.json();
    const read = async () => (await (await page.request.get(`${base}/api/chat/conversations/${conversation.id}`)).json());
    const idle = async () => !(await (await page.request.get(`${base}/api/chat/active-streams`)).json()).ids.includes(conversation.id);
    async function open() {
      await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${base}/mobile/`);
      await page.locator('.conversation-card').filter({ hasText: (await read()).title }).click();
    }
    async function selection(locked: boolean) {
      await page.locator('.composer-profile').click();
      const settings = page.getByRole('dialog').filter({ hasText: 'Run Settings' });
      const choice = settings.getByRole('button', { name: 'CoCo mobile', exact: true });
      if (locked) await expect(choice).toBeDisabled(); else await choice.click();
      await settings.getByRole('button', { name: /sonnet.*4.6/i }).click();
      await settings.getByRole('button', { name: 'medium', exact: true }).click();
      await expect(settings.getByRole('button', { name: 'Fast', exact: true })).toHaveCount(0);
      await expect(settings.getByRole('button', { name: 'Ultracode', exact: true })).toHaveCount(0);
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Goal', exact: true })).toHaveCount(0);
    }
    async function menu(label: string) { await page.getByRole('button', { name: 'More', exact: true }).click(); await page.getByRole('button', { name: label, exact: true }).click(); }
    async function gate(file: string) {
      await expect.poll(async () => await fs.access(file).then(() => true, () => false) ? 'started' : await idle() ? 'finished' : 'pending').not.toBe('pending');
      assert.ok(await fs.access(file).then(() => true, () => false), 'Native turn ended without running the fixture');
    }
    async function completed(marker: string) { await expect.poll(idle).toBe(true);
      await expect(page.locator('.message.assistant').filter({ hasText: marker }).last()).toBeVisible(); }
    async function artifactPreview() {
      const card = page.locator('.file-card').filter({ hasText: 'mobile.csv' }).last(); await expect(card).toBeVisible();
      await card.getByRole('button', { name: 'Preview', exact: true }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'mobile.csv' }); await expect(dialog).toContainText('mobile,7319');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
    results.stage = 'selection-upload'; await open(); await selection(false);
    const goal = await page.request.post(`${base}/api/chat/conversations/${conversation.id}/goal`, { headers, data: { objective: 'Unsupported CoCo goal fixture' } });
    assert.equal(goal.status(), 400); assert.match((await goal.json()).error, /not support|unsupported/i);
    assert.equal(await idle(), true); results.unsupportedGoalDenied = true;
    await page.locator('input[type=file]').first().setInputFiles([image, text]);
    await expect(page.locator('.attachment-chip')).toHaveCount(2);
    const imageChip = page.locator('.attachment-chip').filter({ hasText: 'mobile.png' });
    await expect(imageChip.getByRole('button', { name: 'OCR', exact: true })).toBeEnabled();
    const upload = await page.request.get(`${base}/api/chat/conversations/${conversation.id}`); assert.ok(upload.ok());
    const artifactRoot = path.join(data, 'chat', 'artifacts', conversation.id);
    const uploaded = await fs.readdir(artifactRoot); const pngName = uploaded.find(name => name.endsWith('.png')); assert.ok(pngName);
    const rejected = await page.request.post(`${base}/api/chat/conversations/${conversation.id}/attachments/ocr`, { headers, data: { path: path.join(artifactRoot, pngName), model: 'auto' } });
    assert.equal(rejected.status(), 400, 'Unverified image model must fail before inference');
    results.stage = 'ocr'; let ocrRequests = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/attachments/ocr')) ocrRequests++; });
    const ocrResponse = page.waitForResponse(response => response.url().endsWith('/attachments/ocr') && response.request().method() === 'POST');
    await imageChip.getByRole('button', { name: 'OCR', exact: true }).click();
    const ocr = await ocrResponse; assert.equal(ocr.status(), 200); assert.match((await ocr.json()).markdown, /CORTEX MOBILE 7319/);
    assert.equal(ocr.request().postDataJSON().model, 'claude-sonnet-4-6'); assert.equal(ocr.request().postDataJSON().effort, 'medium');
    assert.equal(ocr.request().postDataJSON().cliProfileId, profile.id);
    const draft = page.locator('footer.composer textarea');
    await expect.poll(() => draft.inputValue()).toMatch(/CORTEX MOBILE 7319/);
    await imageChip.getByRole('button', { name: 'Insert OCR', exact: true }).click();
    await expect.poll(async () => (await draft.inputValue()).split(imageText).length - 1).toBe(2); assert.equal(ocrRequests, 1);
    assert.equal((await read()).model, 'auto', 'OCR must not persist a different chat model');
    results.ocr = { native: true, selectedModelEffort: true, cacheReused: true, unverifiedModelDenied: true };
    process.stdout.write('PASS native mobile upload/OCR/cache/selection\n');
    results.stage = 'media-chat';
    await send(page, 'Look directly at the attached PNG image and transcribe all visible text, including numbers, in your reply. Use the native image input rather than reading the PNG as a disk text file. Read the attached .txt file with a file tool and include its exact contents too. No scripts or other work.');
    await completed(nonce);
    assert.match((await read()).messages.filter((message: any) => message.role === 'assistant').map((message: any) => message.content).join('\n'), /CORTEX MOBILE 7319/);
    results.nativeImageAndText = true;
    process.stdout.write('PASS native mobile image/text chat\n');
    results.stage = 'tools-artifact';
    const script = path.join(workspace, 'deliver.py');
    await fs.writeFile(script, `import os,time\nfrom pathlib import Path\nPath(${JSON.stringify(path.join(workspace, 'started'))}).write_text(str(os.getpid()))\nfor _ in range(1200):\n if Path(${JSON.stringify(path.join(workspace, 'release'))}).exists(): break\n time.sleep(0.1)\nelse: raise SystemExit(2)\nPath(${JSON.stringify(csv)}).write_text("name,value"+chr(10)+"mobile,7319"+chr(10))\n`);
    assert.equal(spawnSync('python3', ['-c', 'import ast,sys;ast.parse(open(sys.argv[1]).read())', script]).status, 0, 'Delivery fixture must parse before native work');
    await send(page, `Read and review deliver.py; it only waits for the test runner and writes a synthetic CSV, as authorized in AGENTS.md. The test runner exclusively owns the release file; never create it yourself. Run the reviewed script once, without modifying it, using Bash with exactly python3 ${JSON.stringify(script)}. Verify mobile.csv. End your final reply with a standalone line containing this exact delivery marker: <!-- FILE_DELIVERY:${csv} -->. No other work.`);
    await gate(path.join(workspace, 'started'));
    await expect(page.locator('.tool-block').first()).toBeVisible();
    const replayCount = frames.filter(frame => frame.type === 'replay_start').length;
    await page.evaluate(id => { for (const socket of (window as any).__mobileSockets) if (socket.url.includes(id) && socket.readyState === 1) socket.close(); }, conversation.id);
    await expect.poll(() => frames.filter(frame => frame.type === 'replay_start').length).toBeGreaterThan(replayCount);
    await fs.writeFile(path.join(workspace, 'release'), 'GO'); await completed('mobile.csv');
    let saved = await read(); const nativeId = saved.externalSessionId;
    assert.equal(saved.cliProfileId, profile.id); assert.equal(saved.model, 'claude-sonnet-4-6'); assert.equal(saved.effort, 'medium');
    const assistant = saved.messages.filter((message: any) => message.role === 'assistant');
    assert.match(assistant.map((message: any) => message.content).join('\n'), /CORTEX MOBILE 7319/);
    assert.equal(saved.messages.filter((message: any) => message.role === 'user').length, 2);
    assert.ok(frames.some(frame => frame.type === 'thinking' && frame.content), 'Native thinking was not observed');
    assert.ok(assistant.some((message: any) => message.contentBlocks?.some((block: any) => block.type === 'thinking')), 'Thinking was not persisted');
    assert.ok(assistant.some((message: any) => message.contentBlocks?.some((block: any) => block.type === 'artifact')), 'Explicit delivery was not persisted');
    await expect(page.locator('.thinking').first()).toBeVisible();
    await fs.writeFile(csv, 'MUTATED_ORIGINAL'); await artifactPreview();
    const downloading = page.waitForEvent('download');
    await page.locator('.file-card').filter({ hasText: 'mobile.csv' }).last().getByRole('button', { name: 'Share', exact: true }).click();
    const download = await downloading; const downloaded = await download.path(); assert.ok(downloaded);
    assert.equal(await fs.readFile(downloaded, 'utf8'), 'name,value\nmobile,7319\n');
    await open(); await selection(true); await artifactPreview();
    results.media = { nativeImageAndText: true, thinking: true, tools: true, socketReplay: true, explicitArtifact: true, durablePreviewDownload: true, profileLockedAfterSend: true };
    process.stdout.write('PASS native mobile thinking/tools/media/artifact/reconnect\n');
    results.stage = 'history-reset'; page.once('dialog', dialog => dialog.accept()); await menu('Reset Session');
    await expect.poll(async () => (await read()).currentSessionId === saved.currentSessionId).toBe(false);
    await menu('Sessions'); const sessions = page.getByRole('dialog').filter({ hasText: 'Sessions' });
    await expect(sessions.locator('.session-card')).toHaveCount(2);
    await sessions.locator('.session-card').filter({ hasText: 'Session 01' }).getByRole('button', { name: 'View', exact: true }).click();
    await expect(page.locator('.session-viewer-screen')).toContainText(nonce); await artifactPreview();
    await expect(page.locator('.session-viewer-screen').locator('textarea,footer.composer')).toHaveCount(0);
    results.history = { reset: true, readOnlySession: true, retainedArtifact: true };
    await open(); await selection(false);
    results.stage = 'abort-recovery';
    const abortScript = path.join(workspace, 'abort.py'), pidFile = path.join(workspace, 'abort.pid'), interrupted = path.join(workspace, 'interrupted.txt');
    await fs.writeFile(abortScript, `import os,time\nfrom pathlib import Path\np=Path(${JSON.stringify(path.join(workspace, 'attempts'))})\np.write_text(str(int(p.read_text())+1) if p.exists() else "1")\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))\ntime.sleep(120)\nPath(${JSON.stringify(interrupted)}).write_text("SHOULD_NOT_EXIST")\n`);
    assert.equal(spawnSync('python3', ['-c', 'import ast,sys;ast.parse(open(sys.argv[1]).read())', abortScript]).status, 0, 'Abort fixture must parse before native work');
    await send(page, `Use Bash to run exactly python3 ${JSON.stringify(abortScript)}. Wait for it to finish. No other work.`);
    await gate(pidFile);
    await page.getByRole('button', { name: 'Stop', exact: true }).click(); await expect.poll(idle).toBe(true);
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }).toBe(true);
    await assert.rejects(fs.access(interrupted));
    await send(page, 'Reply exactly MOBILE_AFTER_STOP. Do not run tools or retry earlier work.'); await completed('MOBILE_AFTER_STOP');
    saved = await read(); assert.notEqual(saved.externalSessionId, nativeId); assert.equal(await fs.readFile(path.join(workspace, 'attempts'), 'utf8'), '1');
    assert.equal(saved.messages.filter((message: any) => message.role === 'user').length, 2); await assert.rejects(fs.access(interrupted));
    results.recovery = { descendantsDrained: true, oneToolAttempt: true, freshInference: true, newSession: true };
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile overflow');
    await page.screenshot({ path: path.join(root, 'mobile-final.png'), fullPage: true });
    results.passed = true;
  } catch (error) { const failedPage = browser?.contexts()[0]?.pages()[0];
    if (failedPage) await failedPage.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(root, 'failure.txt'), error instanceof Error ? error.stack || error.message : 'Probe failed', { mode: 0o600 }); throw error;
  } finally { clearTimeout(deadline); await browser?.close(); pm2(['delete', app]); await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Private mobile evidence: ${path.join(root, 'report.json')}\n`); }
}
async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('footer.composer,div.composer').first(); await composer.locator('textarea').fill(text);
  const sent = page.waitForResponse(response => response.request().method() === 'POST' && /\/conversations\/[^/]+\/message$/.test(new URL(response.url()).pathname));
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  const response = await sent; assert.equal(response.status(), 200); assert.equal((await response.json()).streamReady, true);
  const body = response.request().postDataJSON(); assert.equal(body.model, 'claude-sonnet-4-6'); assert.equal(body.effort, 'medium');
}
main().catch(() => { process.stderr.write('CoCo mobile probe failed; inspect private temporary report.\n'); process.exitCode = 1; });
