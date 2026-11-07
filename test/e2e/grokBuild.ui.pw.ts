import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const workspace = process.env.GROK_BUILD_UI_WORKSPACE || '';
const profileId = process.env.GROK_BUILD_UI_PROFILE_ID || 'grok-certify';
test.skip(process.env.GROK_BUILD_UI_E2E !== '1', 'Opt-in authenticated Grok UI compatibility suite.');
test.use({ actionTimeout: 30_000 });

async function create(request: APIRequestContext, title: string) {
  if (!workspace) throw new Error('GROK_BUILD_UI_WORKSPACE is required; use an isolated fixture server/workspace.');
  const csrf = await request.get('/api/csrf-token');
  const response = await request.post('/api/chat/conversations', {
    headers: { 'x-csrf-token': (await csrf.json()).csrfToken },
    data: { title, workingDir: workspace, cliProfileId: profileId, model: 'grok-4.7', effort: 'low' },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function desktop(page: Page, title: string) {
  await page.goto('/v2/');
  await page.getByLabel('Workspace filter').selectOption({ label: workspace.split('/').slice(-2).join('/') });
  await page.locator('.sb-row').filter({ hasText: title }).click();
  await page.getByLabel('CLI Profile').selectOption(profileId);
  await page.getByLabel('Model', { exact: true }).selectOption('grok-4.7');
  await page.getByLabel('Adaptive reasoning effort', { exact: true }).selectOption('low');
}
async function send(page: Page, prompt: string) {
  await page.getByPlaceholder(/Message Agent Cockpit/).fill(prompt);
  await page.getByLabel('Send', { exact: true }).click();
}

async function holdFirstInputResponse(page: Page): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let intercepted = false;
  await page.route('**/api/chat/conversations/*/input', async route => {
    if (intercepted) { await route.continue(); return; }
    intercepted = true;
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  return release;
}

test('desktop selects the native model and effort, answers questions, revises plans, and downloads files', async ({ page, request }) => {
  test.setTimeout(240_000);
  const conv = await create(request, 'Grok desktop compatibility');
  await desktop(page, conv.title);
  await send(page, 'Use ask_user_question once with two questions: Color? with Blue or Green options, and Size? with Small or Large options. After both answers, use enter_plan_mode and exit_plan_mode to propose a short plan and wait for approval. If I ask for a revision, present another plan using exit_plan_mode and wait again. Once approved, reply exactly DESKTOP_PLAN_OK. Do no other work.');
  const question = page.getByRole('group', { name: 'Clarifying question' });
  const releaseInput = await holdFirstInputResponse(page);
  await question.getByRole('button', { name: /^Blue/ }).click();
  await question.getByRole('button', { name: 'Send', exact: true }).click();
  try { await expect(question).toContainText('Size?'); }
  finally { releaseInput(); }
  await expect(question.locator('input')).toHaveValue('');
  await expect(question.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await question.getByRole('button', { name: /^Large/ }).click();
  await expect(question.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await question.getByRole('button', { name: 'Send', exact: true }).click();
  const plan = page.getByRole('group', { name: 'Plan approval' });
  await expect(plan).toBeVisible();
  await plan.getByPlaceholder('Describe changes…').fill('Revise the plan to explicitly verify the Blue choice and include REVISED_BLUE_CHECK, then request approval again.');
  await plan.getByRole('button', { name: 'Request changes' }).click();
  await expect(plan).toContainText('REVISED_BLUE_CHECK', { timeout: 90_000 });
  await plan.getByRole('button', { name: 'Approve & run' }).click();
  await expect(page.locator('.msg-agent').filter({ hasText: 'DESKTOP_PLAN_OK' })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
  await expect(page.locator('.err-card')).toHaveCount(0);

  await send(page, `Create a downloadable file fixture.csv in the current directory containing exactly "name,value\nfixture,314\n". Deliver it with <!-- FILE_DELIVERY:${path.join(workspace, 'fixture.csv')} --> in your final response. Do no other work.`);
  const card = page.locator('.file-card').filter({ hasText: 'fixture.csv' });
  await expect(card).toBeVisible({ timeout: 90_000 });
  const download = page.waitForEvent('download');
  await card.getByRole('link', { name: 'Download' }).click();
  const downloaded = await download;
  expect(await fs.readFile(await downloaded.path(), 'utf8')).toBe('name,value\nfixture,314\n');
  const saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
  expect(saved.backend).toBe('grok-build');
  expect(saved.model).toBe('grok-4.7');
  expect(saved.effort).toBe('low');
  expect(saved.sessionUsage.costSource).toBe('reported');
});

test('desktop reconnects during native tool work and aborts without rerunning it', async ({ page, request }) => {
  test.setTimeout(180_000);
  const conv = await create(request, 'Grok reconnect compatibility');
  await desktop(page, conv.title);
  await fs.writeFile(path.join(workspace, 'ui-sleep.py'), 'import time\nfrom pathlib import Path\nPath("ui-started.txt").write_text("started")\ntime.sleep(45)\nPath("ui-finished.txt").write_text("finished")\n');
  await send(page, 'Run python3 ui-sleep.py using your terminal tool and wait for it. Do no other work.');
  await expect.poll(() => fs.access(path.join(workspace, 'ui-started.txt')).then(() => true, () => false), { timeout: 60_000 }).toBe(true);
  await page.reload();
  const current = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
  await page.locator('.sb-row').filter({ hasText: current.title }).click();
  await expect(page.getByLabel('Stop agent')).toBeVisible();
  await page.getByLabel('Stop agent').click();
  await expect(page.locator('.err-card')).toContainText(/abort/i);
  await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
  expect(await fs.access(path.join(workspace, 'ui-finished.txt')).then(() => true, () => false)).toBe(false);
  await send(page, 'Reply exactly AFTER_ABORT_OK. Do not rerun the previous tool.');
  await expect(page.locator('.msg-agent').filter({ hasText: 'AFTER_ABORT_OK' })).toBeVisible({ timeout: 60_000 });
});

test('mobile selects Grok, answers a question, approves a native plan, and renders settled usage', async ({ page, request }) => {
  test.setTimeout(180_000);
  const conv = await create(request, 'Grok mobile compatibility');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/mobile/');
  await page.locator('.conversation-card').filter({ hasText: conv.title }).click();
  await page.locator('.composer-profile').click();
  const settings = page.getByRole('dialog').filter({ hasText: 'Run Settings' });
  await settings.getByRole('button', { name: /Grok 4.7$/, exact: false }).click();
  await settings.getByRole('button', { name: 'low', exact: true }).click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await send(page, 'Use ask_user_question once with two questions: Color? with Blue or Green options, and Size? with Small or Large options. After both answers, use enter_plan_mode and exit_plan_mode to propose a short plan and wait for approval. Once approved, reply exactly MOBILE_PLAN_OK. Do no other work.');
  const interaction = page.locator('.interaction-card');
  await expect(interaction).toContainText('Question');
  const releaseInput = await holdFirstInputResponse(page);
  await interaction.getByRole('button', { name: /^Blue/ }).click();
  await interaction.getByRole('button', { name: 'Answer', exact: true }).click();
  try { await expect(interaction).toContainText('Size?'); }
  finally { releaseInput(); }
  await expect(interaction.locator('textarea')).toHaveValue('');
  await interaction.getByRole('button', { name: /^Large/ }).click();
  await interaction.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(interaction).toContainText('Plan Approval', { timeout: 90_000 });
  await interaction.getByRole('button', { name: 'Approve & run' }).click();
  await expect(page.locator('.message.assistant').filter({ hasText: 'MOBILE_PLAN_OK' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByLabel('Send', { exact: true })).toBeVisible();
  await expect(page.getByText('Reported model cost', { exact: true })).toBeVisible();

  await send(page, `Create a downloadable file mobile-fixture.csv with exactly "name,value\nmobile,314\n". Deliver it using <!-- FILE_DELIVERY:${path.join(workspace, 'mobile-fixture.csv')} -->. Do no other work.`);
  const card = page.locator('.file-card').filter({ hasText: 'mobile-fixture.csv' });
  await expect(card).toBeVisible({ timeout: 90_000 });
  await card.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.getByRole('dialog').filter({ hasText: 'mobile-fixture.csv' });
  await expect(preview).toContainText('mobile,314');
  const file = await request.get(`/api/chat/conversations/${conv.id}/workspace-file?path=${encodeURIComponent(path.join(workspace, 'mobile-fixture.csv'))}&mode=download`);
  expect(await file.text()).toBe('name,value\nmobile,314\n');
});

test('desktop pauses a native goal and mobile resumes, pauses, and clears it', async ({ page, request }) => {
  test.setTimeout(120_000);
  const conv = await create(request, 'Grok native goal compatibility');
  await desktop(page, conv.title);
  await page.getByLabel('Goal', { exact: true }).check();
  await page.getByPlaceholder('Set a goal').fill('Write ui-goal-done.txt with exactly UI_GOAL_OK. Verify it and mark the goal complete. Do no other work.');
  await page.getByLabel('Set goal', { exact: true }).click();
  await expect(page.locator('.subagent').first()).toBeVisible();
  const goal = page.locator('.goal-strip');
  await goal.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(goal).toContainText(/paused/i);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/mobile/');
  const saved = await (await request.get(`/api/chat/conversations/${conv.id}`)).json();
  await page.locator('.conversation-card').filter({ hasText: saved.title }).click();
  await expect(goal).toContainText(/paused/i);
  await goal.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/api/chat/conversations/${conv.id}/goal`)).json()).goal?.status).toBe('active');
  await goal.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(goal).toContainText(/paused/i);
  await goal.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(goal).toHaveCount(0);
});
