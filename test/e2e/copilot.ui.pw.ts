import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { copilotPng, copilotPdf } from '../helpers/copilotMediaFixtures';
import type { ConversationArtifact } from '../../src/types';

const workspace = process.env.COPILOT_UI_WORKSPACE || '';
const profileId = process.env.COPILOT_UI_PROFILE_ID || 'copilot-browser';
test.skip(process.env.COPILOT_UI_E2E !== '1', 'Use the isolated PM2/local-model Copilot UI runner.');
test.use({ actionTimeout: 15_000 });

async function headers(request: APIRequestContext) { return { 'x-csrf-token': (await (await request.get('/api/csrf-token')).json()).csrfToken }; }
async function create(request: APIRequestContext, title: string, model = 'auto') {
  if (!workspace) throw new Error('COPILOT_UI_WORKSPACE is required');
  const response = await request.post('/api/chat/conversations', { headers: await headers(request), data: { title, workingDir: workspace, cliProfileId: profileId, model } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function open(page: Page, title: string, mobile: boolean) {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  await page.goto(mobile ? '/mobile/' : '/v2/');
  if (mobile) await page.locator('.conversation-card').filter({ hasText: title }).click();
  else {
    await page.getByLabel('Workspace filter').selectOption({ label: workspace.split('/').slice(-2).join('/') });
    await page.locator('.sb-row').filter({ hasText: title }).click();
  }
  await expect(page.locator('.composer textarea')).toBeVisible();
}
async function send(page: Page, prompt: string) {
  await page.getByPlaceholder(/Message Agent Cockpit/).fill(prompt);
  await page.getByLabel('Send', { exact: true }).click();
}

async function createMedia(request: APIRequestContext, title: string) {
  const conv = await create(request, title, 'gpt-6.1-sol');
  expect((await request.put(`/api/chat/conversations/${conv.id}`, { headers: await headers(request), data: { title: conv.title } })).ok()).toBeTruthy();
  return conv;
}
async function attach(page: Page, mobile: boolean, name: string, mimeType: string, buffer: Buffer) {
  const choosing = page.waitForEvent('filechooser');
  await page.getByLabel(mobile ? 'Attach' : 'Attach files', { exact: true }).click();
  await (await choosing).setFiles({ name, mimeType, buffer });
  await expect(page.getByLabel('Send', { exact: true })).toBeEnabled();
}
function savedArtifacts(saved: { messages: Array<{ contentBlocks?: Array<{ type: string; artifact?: ConversationArtifact }> }> }) {
  return saved.messages.flatMap(message => (message.contentBlocks || []).flatMap(block => block.type === 'artifact' && block.artifact ? [block.artifact] : []));
}

for (const narrow of [false, true]) test(`Copilot guided auth renders cancellation, denied access and success at ${narrow ? 'narrow' : 'desktop'} width`, async ({ page }) => {
  // UI state coverage uses auth-job responses; real RPC and native login are tested separately.
  let state: 'running' | 'cancelled' | 'failed' | 'succeeded' = 'running';
  let starts = 0;
  const snapshot = () => ({ id: 'ui-auth', profileId, profileName: 'Copilot browser fixture', harness: 'copilot',
    status: state, events: [{ type: 'stdout', text: 'To authenticate, visit https://github.com/login/device and enter code ABCD-1234' },
      ...(state === 'failed' ? [{ type: 'error', text: 'Credentials found, but model access did not verify: HTTP 403.' }] : [])] });
  await page.route(`**/api/chat/cli-profiles/${profileId}/auth/start`, async route => {
    starts++; state = 'running'; await route.fulfill({ json: { job: snapshot() } });
  });
  await page.route('**/api/chat/cli-profiles/auth-jobs/ui-auth', route => route.fulfill({ json: { job: snapshot() } }));
  await page.route('**/api/chat/cli-profiles/auth-jobs/ui-auth/cancel', async route => {
    state = 'cancelled'; await route.fulfill({ json: { job: snapshot() } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/v2/');
  await page.getByTitle('Settings', { exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'CLI Profiles', exact: true }).click();
  const card = page.locator('.cli-card').filter({ hasText: 'Copilot browser fixture' });
  if (await card.locator('.cli-card-head').getAttribute('aria-expanded') !== 'true') await card.locator('.cli-card-head').click();
  if (narrow) await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toContainText('All Copilot profiles share');
  await expect(card).toContainText('Separate accounts per profile are not supported');
  const authenticate = card.getByRole('button', { name: 'Authenticate', exact: true });
  await authenticate.click();
  await expect(card.locator('.cli-auth-log')).toContainText('ABCD-1234');
  await expect(authenticate).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath(`copilot-auth-${narrow ? 'narrow' : 'desktop'}.png`), fullPage: true });
  await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(card.locator('.cli-auth-status')).toHaveText('cancelled');
  await expect(authenticate).toBeEnabled();
  await authenticate.click(); await expect(card.locator('.cli-auth-status')).toHaveText('running');
  state = 'failed';
  await expect(card.locator('.cli-auth-status')).toHaveText('failed');
  await expect(card.locator('.cli-auth-log')).toContainText('HTTP 403');
  await authenticate.click(); await expect(card.locator('.cli-auth-status')).toHaveText('running');
  state = 'succeeded';
  await expect(card.locator('.cli-auth-status')).toHaveText('succeeded');
  expect(starts).toBe(3);
});

for (const mobile of [false, true]) {
  const client = mobile ? 'mobile' : 'desktop';
  const assistant = mobile ? '.message.assistant' : '.msg-agent';

  test(`${client} uploads native image bytes across cold resume and reload`, async ({ page, request }) => {
    const conv = await createMedia(request, `Copilot ${client} image input`);
    await open(page, conv.title, mobile);
    for (let i = 0; i < 2; i++) {
      await attach(page, mobile, 'input.png', 'image/png', copilotPng);
      await send(page, 'COPILOT_UI_MEDIA_INPUT');
      await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
      await expect(page.locator(assistant).filter({ hasText: 'COPILOT_UI_MEDIA_INPUT_OK' })).toHaveCount(i + 1);
    }
    await open(page, conv.title, mobile);
    await expect(page.locator(assistant).filter({ hasText: 'COPILOT_UI_MEDIA_INPUT_OK' })).toHaveCount(2);
    const saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
    expect(saved.messages.filter((message: { role: string; content: string }) => message.role === 'user' && message.content.includes('[Uploaded files:'))).toHaveLength(2);
    await page.screenshot({ path: test.info().outputPath(`${client}-media-input.png`), fullPage: true });
  });

  test(`${client} retains a PDF draft when the selected provider cannot transport document bytes`, async ({ page, request }) => {
    const conv = await createMedia(request, `Copilot ${client} gated PDF`);
    await open(page, conv.title, mobile);
    await attach(page, mobile, 'unverified.pdf', 'application/pdf', copilotPdf());
    const refused = page.waitForResponse(response => response.url().endsWith(`/conversations/${conv.id}/message`) && response.status() === 400);
    await send(page, 'COPILOT_UI_MEDIA_INPUT_PDF'); await refused;
    await expect(page.getByPlaceholder(/Message Agent Cockpit/)).toHaveValue('COPILOT_UI_MEDIA_INPUT_PDF');
    await expect(page.getByText('unverified.pdf', { exact: true })).toBeVisible();
    await expect(page.getByText(/does not have verified pdf input/)).toBeVisible();
    expect((await (await request.get(`/api/chat/conversations/${conv.id}`)).json()).messages).toHaveLength(0);
    await page.screenshot({ path: test.info().outputPath(`${client}-media-gated.png`), fullPage: true });
  });

  for (const stop of [false, true]) test(`${client} persists native artifacts ${stop ? 'after Stop' : 'with file delivery'} without duplicate cards`, async ({ page, request }) => {
    await fs.rm(path.join(workspace, 'ui-artifact-ready'), { force: true });
    await fs.rm(path.join(workspace, 'ui-artifact-release'), { force: true });
    const conv = await createMedia(request, `Copilot ${client} artifacts ${stop ? 'Stop' : 'complete'}`);
    await open(page, conv.title, mobile);
    await send(page, stop ? 'COPILOT_UI_MEDIA_OUTPUT_STOP' : 'COPILOT_UI_MEDIA_OUTPUT');
    const pdfCard = page.locator(`${assistant} .file-card`).filter({ hasText: 'report.pdf' });
    await expect(pdfCard).toHaveCount(1);
    await expect(pdfCard).toBeVisible();
    await expect(page.locator(`${assistant} .file-card`).filter({ hasText: 'Tool output' })).toHaveCount(1);
    if (stop) {
      await expect.poll(async () => fs.readFile(path.join(workspace, 'ui-artifact-ready'), 'utf8').catch(() => '')).toBe('ready');
      await page.screenshot({ path: test.info().outputPath(`${client}-media-live.png`), fullPage: true });
      await page.getByRole('button', { name: mobile ? 'Stop' : 'Stop agent', exact: true }).click();
    } else await expect(page.locator(assistant).filter({ hasText: 'COPILOT_UI_MEDIA_OUTPUT_OK' })).toBeVisible();
    await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
    let saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
    await expect.poll(async () => {
      saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json(); return savedArtifacts(saved).length;
    }).toBe(2);
    const artifacts = savedArtifacts(saved);
    expect(new Set(artifacts.map(artifact => artifact.filename)).size).toBe(2);
    for (const artifact of artifacts) {
      expect(artifact.sourceToolId).toMatch(/^copilot:/);
      const download = await request.get(`/api/chat/conversations/${conv.id}/files/${encodeURIComponent(artifact.filename)}?mode=download`);
      expect(download.ok()).toBeTruthy();
      expect(await download.body()).toEqual(artifact.kind === 'image' ? copilotPng : copilotPdf());
    }
    await open(page, conv.title, mobile);
    // Stopped desktop turns retain their existing collapsed progress grouping.
    if (stop && !mobile) await page.getByRole('button', { name: '1 segment', exact: true }).click();
    await expect(pdfCard).toHaveCount(1);
    await expect(page.locator(`${assistant} .file-card`).filter({ hasText: 'Tool output' })).toHaveCount(1);
    if (!stop) {
      await expect(page.locator(`${assistant} .file-card`).filter({ hasText: 'copilot-delivery.txt' })).toHaveCount(1);
      const download = await request.get(`/api/chat/conversations/${conv.id}/workspace-file?path=${encodeURIComponent(path.join(workspace, 'copilot-delivery.txt'))}`);
      expect(await download.text()).toBe('COPILOT_FILE_DELIVERY_BYTES');
    }
    await page.screenshot({ path: test.info().outputPath(`${client}-media-${stop ? 'stopped' : 'complete'}.png`), fullPage: true });
  });

  test(`${client} retains native context and separate billing units after cold resume`, async ({ page, request }) => {
    const conv = await create(request, `Copilot ${client} usage`);
    // An explicit title keeps this usage fixture stable across reloads.
    expect((await request.put(`/api/chat/conversations/${conv.id}`, { headers: await headers(request), data: { title: conv.title } })).ok()).toBeTruthy();
    await open(page, conv.title, mobile);
    for (const prompt of ['COPILOT_UI_USAGE_FIRST', 'COPILOT_UI_USAGE_SECOND']) {
      await send(page, prompt);
      await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
      await expect.poll(async () => (await (await request.get(`/api/chat/conversations/${conv.id}`)).json()).messages.filter((message: { role: string; content: string }) => message.role === 'assistant' && message.content.includes('COPILOT_UI_USAGE_OK')).length).toBe(prompt.endsWith('FIRST') ? 1 : 2);
    }
    const saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
    expect(saved.sessionUsage).toMatchObject({ inputTokens: 160, outputTokens: 60, cacheReadTokens: 80, cacheWriteTokens: 0 });
    expect(saved.sessionUsage.contextWindow).toMatchObject({ status: 'available', tokenLimit: expect.any(Number), usedTokens: expect.any(Number) });
    expect(saved.sessionUsage.copilot.aiCreditsStatus).toBe('unavailable');
    expect(saved.sessionUsage.copilot.aiCredits).toBeUndefined();
    await open(page, conv.title, mobile);
    if (!mobile) await page.getByLabel('Session usage', { exact: true }).hover();
    else await page.getByLabel('Copilot session usage').locator('summary').click();
    const details = mobile ? page.getByLabel('Copilot session usage') : page.getByRole('tooltip');
    await expect(details).toContainText('AI credits');
    await expect(details).toContainText('Premium requests');
    await expect(details).toContainText('Unavailable');
    await expect(details).toContainText(mobile ? 'Context measured' : 'measured');
    await page.screenshot({ path: test.info().outputPath(`${client}-usage.png`), fullPage: true });
  });

  test(`${client} labels stale account quota and unavailable refresh without inventing a balance`, async ({ page, request }) => {
    let available = true;
    await page.route(`**/api/chat/cli-profiles/${profileId}/copilot-quota`, route => route.fulfill({ json: { profileId, quota: available
      ? { status: 'available', fetchedAt: '2026-11-04T00:00:00Z', stale: true, rows: [{ id: 'premium', label: 'Premium interactions', used: 25, entitlement: 100, unit: 'premium_requests', usedPercentage: 25 }] }
      : { status: 'unavailable', fetchedAt: null, stale: false, rows: [], message: 'Account quota unavailable.' } } }));
    const conv = await create(request, `Copilot ${client} quota`);
    expect((await request.put(`/api/chat/conversations/${conv.id}`, { headers: await headers(request), data: { title: conv.title } })).ok()).toBeTruthy();
    await open(page, conv.title, mobile); await send(page, 'COPILOT_UI_USAGE_QUOTA');
    await expect(page.locator(assistant).filter({ hasText: 'COPILOT_UI_USAGE_OK' })).toBeVisible();
    if (!mobile) await page.getByLabel('Session usage', { exact: true }).hover();
    const quota = page.getByLabel('Copilot account quota');
    if (mobile) await quota.locator('summary').click();
    await expect(quota).toContainText('stale'); await expect(quota).toContainText('25 / 100 premium requests');
    await page.screenshot({ path: test.info().outputPath(`${client}-quota-stale.png`), fullPage: true });
    available = false; await open(page, conv.title, mobile);
    if (!mobile) await page.getByLabel('Session usage', { exact: true }).hover();
    await expect(quota).toContainText(/unavailable/i); await expect(quota).not.toContainText('25 / 100');
  });

  test(`${client} completes and reloads native goals without offering Clear`, async ({ page, request }) => {
    const conv = await create(request, `Copilot ${client} goal completion`);
    await open(page, conv.title, mobile);
    await expect(page.getByRole(mobile ? 'button' : 'checkbox', { name: 'Goal', exact: true })).toBeVisible();
    await send(page, '/goal COPILOT_UI_GOAL_COMPLETE');
    const strip = page.locator('.goal-strip');
    await expect(strip).toContainText('Goal achieved');
    await expect(strip.getByRole('button', { name: 'Clear', exact: true })).toHaveCount(0);
    await expect(strip).toContainText('COPILOT_UI_GOAL_COMPLETE');
    await open(page, conv.title, mobile);
    await expect(strip).toContainText('Goal achieved');
    const saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
    expect(saved.messages.filter((message: { goalEvent?: { kind: string } }) => message.goalEvent?.kind === 'achieved')).toHaveLength(1);
    await page.screenshot({ path: test.info().outputPath(`${client}-goal-complete.png`), fullPage: true });
  });

  test(`${client} pauses native goal work and resumes only with an explicit AI credit window`, async ({ page, request }) => {
    for (const name of ['ui-goal-worker.pid', 'ui-goal-worker-finished', 'ui-goal-release']) await fs.rm(path.join(workspace, name), { force: true });
    const conv = await create(request, `Copilot ${client} goal pause`);
    await open(page, conv.title, mobile);
    await expect(page.getByRole(mobile ? 'button' : 'checkbox', { name: 'Goal', exact: true })).toBeVisible();
    await send(page, '/goal COPILOT_UI_GOAL_PAUSE');
    await expect.poll(async () => fs.readFile(path.join(workspace, 'ui-goal-worker.pid'), 'utf8').catch(() => '')).not.toBe('');
    const worker = Number(await fs.readFile(path.join(workspace, 'ui-goal-worker.pid'), 'utf8'));
    const strip = page.locator('.goal-strip');
    await strip.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(strip).toContainText('Goal paused');
    await expect(page.getByText('Stream failed: Copilot turn aborted.', { exact: true })).toHaveCount(0);
    await expect.poll(() => { try { process.kill(worker, 0); return true; } catch { return false; } }).toBe(false);
    await open(page, conv.title, mobile);
    await expect(strip).toContainText('Goal paused');
    const resume = strip.getByRole('button', { name: 'Resume', exact: true });
    await expect(resume).toBeDisabled();
    await page.getByLabel('Fresh AI credit limit', { exact: true }).fill('0');
    await expect(resume).toBeDisabled();
    await page.getByLabel('Fresh AI credit limit', { exact: true }).fill('2.5');
    await expect(resume).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath(`${client}-goal-paused.png`), fullPage: true });
    await fs.writeFile(path.join(workspace, 'ui-goal-release'), 'finish');
    const submission = page.waitForRequest(request => request.url().endsWith(`/conversations/${conv.id}/goal/resume`) && request.method() === 'POST');
    await resume.click();
    expect((await submission).postDataJSON()).toEqual({ aiCreditLimit: 2.5 });
    await expect(strip).toContainText('Goal achieved');
    await expect(strip).toContainText('AI credits: 0 / 2.5');
    await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
    expect(Number(await fs.readFile(path.join(workspace, 'ui-goal-worker.pid'), 'utf8'))).toBe(worker);
    await expect(fs.stat(path.join(workspace, 'ui-goal-worker-finished'))).rejects.toThrow();
    const goal = (await (await request.get(`/api/chat/conversations/${conv.id}/goal`)).json()).goal;
    expect(goal).toMatchObject({ backend: 'copilot', objectiveId: 1, objective: 'COPILOT_UI_GOAL_PAUSE', status: 'complete', aiCreditLimit: 2.5 });
    expect(goal.tokenBudget).toBeUndefined();
  });

  test(`${client} preserves unavailable selections, follows discovered efforts and labels fallback models`, async ({ page, request }) => {
    let fallback = false;
    await page.route(`**/api/chat/cli-profiles/${profileId}/metadata`, async route => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, backend: { ...data.backend,
        models: [{ id: 'account-model', label: 'Account model', supportedEffortLevels: ['low', 'max'] }, { id: 'text-model', label: 'Text model' }],
        modelCatalog: fallback ? { source: 'fallback', reason: 'Account model discovery is unavailable.' } : { source: 'runtime' },
      } } });
    });
    const conv = await create(request, `Copilot ${client} catalog`, 'retired-model');
    await open(page, conv.title, mobile);
    if (mobile) {
      await page.locator('.composer-profile').click();
      const settings = page.getByRole('dialog').filter({ hasText: 'Run Settings' });
      await expect(settings).toContainText('retired-model is unavailable');
      await settings.getByRole('button', { name: 'Account model', exact: true }).click();
      await expect(settings.getByRole('button', { name: 'max', exact: true })).toBeVisible();
      await expect(settings.getByRole('button', { name: 'high', exact: true })).toHaveCount(0);
      await settings.getByRole('button', { name: 'Text model', exact: true }).click();
      await expect(settings.getByRole('button', { name: 'max', exact: true })).toHaveCount(0);
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
    } else {
      await expect(page.getByLabel('Model', { exact: true })).toHaveValue('retired-model');
      await expect(page.getByLabel('Model', { exact: true }).locator('option:checked')).toContainText('unavailable');
      await page.getByLabel('Model', { exact: true }).selectOption('account-model');
      await expect(page.getByLabel('Adaptive reasoning effort').locator('option')).toHaveText(['Low', 'Max']);
      await page.getByLabel('Model', { exact: true }).selectOption('text-model');
      await expect(page.getByLabel('Adaptive reasoning effort')).toHaveCount(0);
    }
    await page.route(`**/api/chat/conversations/${conv.id}/message`, route => route.fulfill({ status: 400, json: { error: 'Fixture catalog rejection' } }));
    const submission = page.waitForRequest(request => request.url().endsWith(`/conversations/${conv.id}/message`) && request.method() === 'POST');
    await send(page, 'Catalog selection wire check');
    expect((await submission).postDataJSON()).toMatchObject({ model: 'text-model', effort: null });
    // Picker reconciliation must never rewrite a saved conversation merely
    // because account/catalog access changed.
    expect((await (await request.get(`/api/chat/conversations/${conv.id}`)).json()).model).toBe('retired-model');
    fallback = true;
    await open(page, conv.title, mobile);
    if (mobile) {
      await page.locator('.composer-profile').click();
      await expect(page.getByRole('dialog').filter({ hasText: 'Run Settings' })).toContainText('Fallback models. Account model discovery is unavailable.');
    } else await expect(page.getByText('Fallback models', { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`${client}-catalog.png`), fullPage: true });
  });

  test(`${client} selects Copilot and renders production Memory tools and replies`, async ({ page, request }) => {
    const conv = await create(request, `Copilot ${client} Memory`);
    expect((await request.put(`/api/chat/workspaces/${conv.workspaceId}/memory/enabled`, { headers: await headers(request), data: { enabled: true } })).ok()).toBeTruthy();
    await open(page, conv.title, mobile);
    if (mobile) {
      await page.locator('.composer-profile').click();
      const settings = page.getByRole('dialog').filter({ hasText: 'Run Settings' });
      await settings.getByRole('button', { name: 'Copilot browser fixture', exact: true }).click();
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
    } else {
      await page.getByLabel('CLI Profile').selectOption(profileId);
      await expect(page.getByLabel('CLI Profile')).toHaveValue(profileId);
    }
    await send(page, 'Save COPILOT_MEMORY_571 through memory_note, then recall it with memory_search.');
    await expect(page.locator(assistant).filter({ hasText: 'COPILOT_MEMORY_571' })).toBeVisible();
    await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
    const saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
    expect(saved.backend).toBe('copilot');
    expect(saved.cliProfileId).toBe(profileId);
    expect(saved.messages.flatMap((message: { toolActivity?: Array<{ tool: string }> }) => message.toolActivity || []).map((tool: { tool: string }) => tool.tool)).toEqual(expect.arrayContaining(['memory_note', 'memory_search']));
    await expect(page.locator(mobile ? '.tool-block' : '.tool').filter({ hasText: 'memory_note' }).first()).toBeVisible();
    if (!mobile) await expect(page.locator('.memory-card')).toContainText(/Memory updated/);
    await page.screenshot({ path: test.info().outputPath(`${client}-memory.png`), fullPage: true });
  });

  test(`${client} groups live background child tools, waits for completion and keeps summaries after reload`, async ({ page, request }) => {
    for (const name of ['ready', 'release']) await fs.rm(path.join(workspace, `ui-delegate-${name}`), { force: true });
    const conv = await create(request, `Copilot ${client} background delegation`);
    await open(page, conv.title, mobile);
    await send(page, 'COPILOT_UI_DELEGATE');
    const card = page.locator(mobile ? '.agent-card' : '.subagent');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Background: Run delegated browser fixture');
    await expect(card.locator(mobile ? '.tool-block' : '.tool')).toHaveCount(1);
    await expect.poll(() => fs.access(path.join(workspace, 'ui-delegate-ready')).then(() => true, () => false)).toBe(true);
    await expect(card).toContainText('running');
    await expect(page.locator(assistant).filter({ hasText: 'COPILOT_UI_DELEGATE_PARENT_OK' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: mobile ? 'Stop' : 'Stop agent', exact: true })).toBeVisible();
    // Replay must reconstruct the same running card and its child, once.
    await open(page, conv.title, mobile);
    await expect(card).toHaveCount(1);
    await expect(card.locator(mobile ? '.tool-block' : '.tool')).toHaveCount(1);
    await expect(card).toContainText('running');
    await fs.writeFile(path.join(workspace, 'ui-delegate-release'), 'finish');
    await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
    await expect(card).toContainText('done');
    await card.getByText('Summary', { exact: true }).click();
    await expect(card.getByText('COPILOT_UI_CHILD_SUMMARY', { exact: true })).toBeVisible();
    // Child completion arrives before the root's final usage and transcript write.
    let saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
    await expect.poll(async () => {
      saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
      return saved.messages.flatMap((message: { toolActivity?: Array<{ isAgent?: boolean; summary?: string }> }) => message.toolActivity || []).find((tool: { isAgent?: boolean }) => tool.isAgent);
    }).toMatchObject({ summary: 'COPILOT_UI_CHILD_SUMMARY', outcome: 'done' });
    expect(saved.messages.some((message: { content: string }) => message.content.includes('COPILOT_UI_CHILD_SUMMARY'))).toBe(false);
    await open(page, saved.title, mobile);
    await expect(card).toHaveCount(1);
    await card.getByText('Summary', { exact: true }).click();
    await expect(card.getByText('COPILOT_UI_CHILD_SUMMARY', { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`${client}-delegation.png`), fullPage: true });
  });

  test(`${client} stops delegated workers, persists cancellation and resumes without replay`, async ({ page, request }) => {
    for (const name of ['ui-delegate-worker.pid', 'ui-delegate-worker-finished']) await fs.rm(path.join(workspace, name), { force: true });
    const conv = await create(request, `Copilot ${client} delegated Stop`);
    await open(page, conv.title, mobile);
    await send(page, 'COPILOT_UI_DELEGATE_STOP');
    await expect.poll(() => fs.access(path.join(workspace, 'ui-delegate-worker.pid')).then(() => true, () => false)).toBe(true);
    const pid = Number(await fs.readFile(path.join(workspace, 'ui-delegate-worker.pid'), 'utf8'));
    const card = page.locator(mobile ? '.agent-card' : '.subagent');
    await expect(card).toContainText('running');
    await page.getByRole('button', { name: mobile ? 'Stop' : 'Stop agent', exact: true }).click();
    await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
    if (!mobile) await page.getByRole('button', { name: '1 segment', exact: true }).click();
    await expect(card).toContainText('cancelled');
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
    await send(page, 'COPILOT_UI_REPLY');
    await expect(page.locator(assistant).filter({ hasText: 'COPILOT_UI_REPLY_OK' })).toBeVisible();
    expect(Number(await fs.readFile(path.join(workspace, 'ui-delegate-worker.pid'), 'utf8'))).toBe(pid);
    expect(await fs.access(path.join(workspace, 'ui-delegate-worker-finished')).then(() => true, () => false)).toBe(false);
    const saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
    await open(page, saved.title, mobile);
    if (!mobile) await page.getByRole('button', { name: '1 segment', exact: true }).click();
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('cancelled');
  });

  test(`${client} stops native tool work and immediately resumes without replay`, async ({ page, request }) => {
    await fs.rm(path.join(workspace, 'ui-worker.pid'), { force: true });
    await fs.rm(path.join(workspace, 'ui-worker-finished'), { force: true });
    const conv = await create(request, `Copilot ${client} Stop`);
    await open(page, conv.title, mobile);
    await send(page, 'COPILOT_UI_WAIT');
    await expect.poll(() => fs.access(path.join(workspace, 'ui-worker.pid')).then(() => true, () => false)).toBe(true);
    const pid = Number(await fs.readFile(path.join(workspace, 'ui-worker.pid'), 'utf8'));
    let releaseAbort!: () => void; let abortRequested!: () => void;
    const abortGate = new Promise<void>(resolve => { releaseAbort = resolve; });
    const requested = new Promise<void>(resolve => { abortRequested = resolve; });
    await page.route(`**/api/chat/conversations/${conv.id}/abort`, async route => {
      abortRequested(); await abortGate; await route.continue();
    });
    try {
      await page.getByRole('button', { name: mobile ? 'Stop' : 'Stop agent', exact: true }).click();
      await requested;
      await expect(page.getByLabel('Send', { exact: true })).toBeHidden();
    } finally { releaseAbort(); }
    await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
    await send(page, 'COPILOT_UI_REPLY');
    await expect(page.locator(assistant).filter({ hasText: 'COPILOT_UI_REPLY_OK' })).toBeVisible();
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
    expect(await fs.access(path.join(workspace, 'ui-worker-finished')).then(() => true, () => false)).toBe(false);
    const saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
    expect(saved.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(2);
    const title = `Resumed ${client} ${conv.id}`;
    expect((await request.put(`/api/chat/conversations/${conv.id}`, { headers: await headers(request), data: { title } })).ok()).toBeTruthy();
    await page.reload();
    if (!mobile) await page.locator('.sb-row').filter({ hasText: title }).click();
    else await page.locator('.conversation-card').filter({ hasText: title }).click();
    await expect(page.locator(assistant).filter({ hasText: 'COPILOT_UI_REPLY_OK' })).toBeVisible();
  });

  test(`${client} reloads and answers repeated native questions with exact request ownership`, async ({ page, request }) => {
    const conv = await create(request, `Copilot ${client} questions`);
    await open(page, conv.title, mobile);
    await send(page, 'COPILOT_UI_QUESTION');
    const card = page.locator(mobile ? '.interaction-card' : '.plan').filter({ hasText: 'Choose the fixture answer' });
    await expect(card).toBeVisible();
    // Reopen the active stream and reconstruct its pending request from replay.
    await open(page, conv.title, mobile);
    await expect(card).toBeVisible();
    const answer = card.getByRole('textbox');
    await card.getByRole('button', { name: 'Beta', exact: true }).click();
    const firstInput = page.waitForRequest(req => req.url().endsWith(`/conversations/${conv.id}/input`) && req.method() === 'POST');
    await card.getByRole('button', { name: mobile ? 'Answer' : 'Send', exact: true }).click();
    const firstBody = (await firstInput).postDataJSON();
    expect(firstBody.requestId).toEqual(expect.any(String));
    await expect(card).toBeVisible();
    await expect(answer).toHaveValue('');
    // Another client cannot answer the old request or turn it into a message.
    expect((await request.post(`/api/chat/conversations/${conv.id}/input`, { headers: await headers(request),
      data: { text: 'Alpha', requestId: firstBody.requestId, streamActive: true } })).status()).toBe(409);
    await answer.fill('COPILOT_UI_FREEFORM');
    const secondInput = page.waitForRequest(req => req.url().endsWith(`/conversations/${conv.id}/input`) && req.method() === 'POST');
    await card.getByRole('button', { name: mobile ? 'Answer' : 'Send', exact: true }).click();
    expect((await secondInput).postDataJSON().requestId).not.toBe(firstBody.requestId);
    await expect(page.locator(assistant).filter({ hasText: 'COPILOT_UI_FREEFORM' })).toBeVisible();
    await expect(card).toHaveCount(0);
    expect((await (await request.get(`/api/chat/conversations/${conv.id}`)).json()).messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1);
    await page.screenshot({ path: test.info().outputPath(`${client}-questions.png`), fullPage: true });
  });

  test(`${client} can Stop a native question while retaining a draft and attachment`, async ({ page, request }) => {
    for (const name of ['ready', 'release']) await fs.rm(path.join(workspace, `ui-question-${name}`), { force: true });
    const conv = await create(request, `Copilot ${client} question Stop`);
    await open(page, conv.title, mobile);
    await send(page, 'COPILOT_UI_QUESTION_LATE');
    await expect.poll(() => fs.access(path.join(workspace, 'ui-question-ready')).then(() => true, () => false)).toBe(true);
    const composer = page.locator('.composer textarea');
    await composer.fill('Keep my next draft');
    const choosing = page.waitForEvent('filechooser');
    await page.getByLabel(mobile ? 'Attach' : 'Attach files', { exact: true }).click();
    await (await choosing).setFiles({ name: 'question.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic question draft') });
    await expect(page.getByText('question.txt', { exact: true })).toBeVisible();
    await fs.writeFile(path.join(workspace, 'ui-question-release'), 'ask');
    const card = page.locator(mobile ? '.interaction-card' : '.plan').filter({ hasText: 'Choose the fixture answer' });
    await expect(card).toBeVisible();
    await page.getByRole('button', { name: mobile ? 'Stop' : 'Stop agent', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(composer).toHaveValue('Keep my next draft');
    await expect(page.getByText('question.txt', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Send', { exact: true })).toBeEnabled();
  });

  for (const boundary of [false, true]) {
    test(`${client} steering ${boundary ? 'retains late drafts and files' : 'redirects the current native turn'}`, async ({ page, request }) => {
      await fs.rm(path.join(workspace, 'ui-input-ready'), { force: true });
      await fs.rm(path.join(workspace, 'ui-input-release'), { force: true });
      const conv = await create(request, `Copilot ${client} steering ${boundary}`);
      await open(page, conv.title, mobile);
      await send(page, boundary ? 'COPILOT_UI_STEER_BOUNDARY' : 'COPILOT_UI_STEER');
      await expect.poll(() => fs.access(path.join(workspace, 'ui-input-ready')).then(() => true, () => false)).toBe(true);
      if (boundary) {
        const choosing = page.waitForEvent('filechooser');
        await page.getByLabel(mobile ? 'Attach' : 'Attach files', { exact: true }).click();
        await (await choosing).setFiles({ name: 'steering.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic steering attachment') });
        await expect(page.getByText('steering.txt', { exact: true })).toBeVisible();
      }
      const composer = page.getByPlaceholder(/Message.*(?:Agent Cockpit|queued)|Agent is running/);
      await composer.fill('COPILOT_UI_CORRECTION');
      const steer = page.getByRole('button', { name: 'Steer', exact: true });
      await expect(steer).toBeEnabled();
      const submitted = page.waitForRequest(req => req.url().endsWith(`/conversations/${conv.id}/input`) && req.method() === 'POST');
      const delivered = page.waitForResponse(response => response.url().endsWith(`/conversations/${conv.id}/input`));
      await steer.click();
      const body = (await submitted).postDataJSON();
      expect(body).toMatchObject({ turnId: expect.any(String), inputId: expect.any(String), text: expect.stringContaining('COPILOT_UI_CORRECTION') });
      await expect(composer).toHaveValue('COPILOT_UI_CORRECTION');
      // The local provider deliberately holds the current model response until
      // the native immediate request has had time to enter its steering lane.
      await new Promise(resolve => setTimeout(resolve, 200));
      await fs.writeFile(path.join(workspace, 'ui-input-release'), 'continue');
      expect((await delivered).status()).toBe(boundary ? 409 : 200);
      await expect(page.locator(assistant).filter({ hasText: boundary ? 'COPILOT_UI_BOUNDARY_DONE' : 'COPILOT_UI_STEER_OK' })).toBeVisible();
      await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
      await expect(composer).toHaveValue(boundary ? 'COPILOT_UI_CORRECTION' : '');
      if (boundary) await expect(page.getByText('steering.txt', { exact: true })).toBeVisible();
      const saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
      expect(saved.messageQueue || []).toEqual([]);
      expect(saved.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1);
      await page.screenshot({ path: test.info().outputPath(`${client}-steering-${boundary}.png`), fullPage: true });
    });
  }

  test(`${client} steers a running foreground command in an existing conversation without replay`, async ({ page, request }) => {
    for (const name of ['ui-running-commands', 'ui-running-worker.pid', 'ui-running-release', 'ui-running-finished']) await fs.rm(path.join(workspace, name), { force: true });
    const conv = await create(request, `Copilot ${client} running tool steering`);
    expect((await request.put(`/api/chat/conversations/${conv.id}`, { headers: await headers(request), data: { title: conv.title } })).ok()).toBeTruthy();
    await open(page, conv.title, mobile);
    await send(page, 'COPILOT_UI_TOOL_STEER_WARMUP');
    await expect(page.locator(assistant).filter({ hasText: 'COPILOT_UI_WARMUP_OK' })).toBeVisible();
    await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
    await open(page, conv.title, mobile);
    await send(page, 'COPILOT_UI_TOOL_STEER_INITIAL: after the command finishes reply ORIGINAL. Do not start another command.');
    await expect.poll(() => fs.access(path.join(workspace, 'ui-running-worker.pid')).then(() => true, () => false)).toBe(true);
    const composer = page.getByPlaceholder(/Message.*(?:Agent Cockpit|queued)|Agent is running/);
    await composer.fill('Correction: after the current command finishes reply COPILOT_UI_RUNNING_CORRECTION instead. Do not start another command.');
    const steer = page.getByRole('button', { name: 'Steer', exact: true });
    await expect(steer).toBeEnabled();
    const submitted = page.waitForRequest(req => req.url().endsWith(`/conversations/${conv.id}/input`) && req.method() === 'POST');
    const delivered = page.waitForResponse(response => response.url().endsWith(`/conversations/${conv.id}/input`));
    await steer.click();
    const input = (await submitted).postDataJSON();
    expect(input).toMatchObject({ turnId: expect.any(String), inputId: expect.any(String), text: expect.stringContaining('COPILOT_UI_RUNNING_CORRECTION') });
    await new Promise(resolve => setTimeout(resolve, 300));
    await fs.writeFile(path.join(workspace, 'ui-running-release'), 'finish');
    const response = await delivered;
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ mode: 'stdin' });
    await expect.poll(() => fs.access(path.join(workspace, 'ui-running-finished')).then(() => true, () => false)).toBe(true);
    await expect(page.locator(assistant).filter({ hasText: 'COPILOT_UI_RUNNING_STEER_OK' })).toBeVisible();
    await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
    await expect(composer).toHaveValue('');
    const saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
    await test.info().attach('running-tool-steering.json', { body: Buffer.from(JSON.stringify({ input, status: response.status(), conversation: saved }, null, 2)), contentType: 'application/json' });
    expect(saved.messageQueue || []).toEqual([]);
    expect(saved.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(2);
    expect(JSON.stringify(saved.messages)).not.toContain('No response was returned');
    await open(page, conv.title, mobile);
    await send(page, 'COPILOT_UI_REPLY');
    await expect(page.locator(assistant).filter({ hasText: 'COPILOT_UI_REPLY_OK' })).toBeVisible();
    await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
    expect(await fs.readFile(path.join(workspace, 'ui-running-commands'), 'utf8')).toBe('warmup\ninitial\n');
    await page.screenshot({ path: test.info().outputPath(`${client}-running-tool-steering.png`), fullPage: true });
  });

  test(`${client} retains its draft and attachment after temporary reset admission rejection`, async ({ page, request }) => {
    const conv = await create(request, `Copilot ${client} retry draft`);
    await open(page, conv.title, mobile);
    const choosing = page.waitForEvent('filechooser');
    await page.getByLabel(mobile ? 'Attach' : 'Attach files', { exact: true }).click();
    await (await choosing).setFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic browser attachment') });
    await expect(page.getByText('fixture.txt', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Send', { exact: true })).toBeEnabled();
    await page.route(`**/api/chat/conversations/${conv.id}/message`, route => route.fulfill({ status: 503, headers: { 'Retry-After': '1' }, json: { error: 'Session cleanup is in progress. Try again shortly.' } }), { times: 1 });
    const rejected = page.waitForResponse(response => response.url().endsWith(`/conversations/${conv.id}/message`) && response.status() === 503);
    await send(page, 'COPILOT_UI_REPLY');
    await rejected;
    await expect(page.getByPlaceholder(/Message Agent Cockpit/)).toHaveValue('COPILOT_UI_REPLY');
    await expect(page.getByText('fixture.txt', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Send', { exact: true })).toBeEnabled();
    await page.getByLabel('Send', { exact: true }).click();
    await expect(page.locator(assistant).filter({ hasText: 'COPILOT_UI_REPLY_OK' })).toBeVisible();
    expect((await (await request.get(`/api/chat/conversations/${conv.id}`)).json()).messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1);
  });

  test(`${client} resets, archives, restores, and deletes through the browser`, async ({ page, request }) => {
    const conv = await create(request, `Copilot ${client} lifecycle`);
    await open(page, conv.title, mobile);
    if (mobile) {
      page.on('dialog', dialog => void dialog.accept());
      await page.getByLabel('More', { exact: true }).click();
      await page.getByRole('button', { name: 'Reset Session', exact: true }).click();
    } else {
      await page.getByTitle('Reset session').click();
      await page.getByRole('dialog', { name: 'Reset this conversation?' }).getByRole('button', { name: 'Reset', exact: true }).click();
    }
    await expect.poll(async () => (await (await request.get(`/api/chat/conversations/${conv.id}`)).json()).sessionNumber).toBe(2);
    conv.title = (await (await request.get(`/api/chat/conversations/${conv.id}`)).json()).title;
    if (mobile) {
      await page.getByLabel('More', { exact: true }).click();
      await page.getByRole('button', { name: 'Archive', exact: true }).click();
    } else {
      await page.getByTitle('Archive conversation').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click();
    }
    await expect.poll(async () => (await (await request.get(`/api/chat/conversations/${conv.id}`)).json()).archived).toBe(true);
    if (mobile) {
      await expect(page.locator('.list-screen')).toBeVisible();
      await expect(page.locator('.list-screen .mini-spinner')).toHaveCount(0);
      await page.getByRole('button', { name: 'Archive', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.list-screen .mini-spinner')).toHaveCount(0);
      await page.locator('.conversation-card').filter({ hasText: conv.title }).click();
      await page.getByLabel('More', { exact: true }).click();
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
    } else {
      await page.locator('.sb-archive-toggle').click();
      await page.locator('.sb-row').filter({ hasText: conv.title }).click();
      await expect(page.getByRole('button', { name: 'Unarchive', exact: true })).toBeVisible();
      await page.locator('.sb-row').filter({ hasText: conv.title }).getByTitle('Restore conversation').click();
    }
    await expect.poll(async () => Boolean((await (await request.get(`/api/chat/conversations/${conv.id}`)).json()).archived)).toBe(false);
    // Desktop exposes permanent deletion from the archived view.
    if (mobile) {
      await expect(page.locator('.list-screen')).toBeVisible();
      await expect(page.locator('.list-screen .mini-spinner')).toHaveCount(0);
      await page.getByRole('button', { name: /^Active/ }).click();
      await expect(page.getByRole('button', { name: /^Active/ })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.list-screen .mini-spinner')).toHaveCount(0);
      await page.locator('.conversation-card').filter({ hasText: conv.title }).click();
      await page.getByLabel('More', { exact: true }).click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
    } else {
      await page.locator('.sb-archive-toggle').click();
      await page.locator('.sb-row').filter({ hasText: conv.title }).click();
      await page.getByTitle('Archive conversation').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click();
      await page.locator('.sb-archive-toggle').click();
      await page.locator('.sb-row').filter({ hasText: conv.title }).click();
      await page.getByTitle('Delete conversation').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    }
    await expect.poll(async () => (await request.get(`/api/chat/conversations/${conv.id}`)).status()).toBe(404);
  });
}
