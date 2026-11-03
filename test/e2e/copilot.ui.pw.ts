import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const workspace = process.env.COPILOT_UI_WORKSPACE || '';
const profileId = process.env.COPILOT_UI_PROFILE_ID || 'copilot-browser';
test.skip(process.env.COPILOT_UI_E2E !== '1', 'Use the isolated PM2/local-model Copilot UI runner.');
test.use({ actionTimeout: 15_000 });

async function headers(request: APIRequestContext) { return { 'x-csrf-token': (await (await request.get('/api/csrf-token')).json()).csrfToken }; }
async function create(request: APIRequestContext, title: string) {
  if (!workspace) throw new Error('COPILOT_UI_WORKSPACE is required');
  const response = await request.post('/api/chat/conversations', { headers: await headers(request), data: { title, workingDir: workspace, cliProfileId: profileId, model: 'auto' } });
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
  await expect(page.getByPlaceholder(/Message Agent Cockpit/)).toBeVisible();
}
async function send(page: Page, prompt: string) {
  await page.getByPlaceholder(/Message Agent Cockpit/).fill(prompt);
  await page.getByLabel('Send', { exact: true }).click();
}

for (const mobile of [false, true]) {
  const client = mobile ? 'mobile' : 'desktop';
  const assistant = mobile ? '.message.assistant' : '.msg-agent';

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

  test(`${client} stops native tool work and immediately resumes without replay`, async ({ page, request }) => {
    await fs.rm(path.join(workspace, 'ui-worker.pid'), { force: true });
    await fs.rm(path.join(workspace, 'ui-worker-finished'), { force: true });
    const conv = await create(request, `Copilot ${client} Stop`);
    await open(page, conv.title, mobile);
    await send(page, 'COPILOT_UI_WAIT');
    await expect.poll(() => fs.access(path.join(workspace, 'ui-worker.pid')).then(() => true, () => false)).toBe(true);
    const pid = Number(await fs.readFile(path.join(workspace, 'ui-worker.pid'), 'utf8'));
    await page.getByRole('button', { name: mobile ? 'Stop' : 'Stop agent', exact: true }).click();
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
      await page.getByRole('button', { name: 'Archive', exact: true }).click();
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
      await page.getByRole('button', { name: /^Active/ }).click();
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
