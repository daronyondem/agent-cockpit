import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const enabled = process.env.CLAUDE_INTERACTIVE_UI_E2E === '1';
const workspaceDir = process.env.CLAUDE_INTERACTIVE_UI_WORKSPACE || '';
const artifactDir = process.env.CLAUDE_INTERACTIVE_UI_E2E_ARTIFACT_DIR
  || (workspaceDir ? path.dirname(path.dirname(workspaceDir)) : '');
const profileId = process.env.CLAUDE_INTERACTIVE_UI_PROFILE_ID || 'cc-int-e2e';
let replacementServer: ChildProcess | null = null;
let profileSeeded = false;

test.skip(!enabled, 'Set CLAUDE_INTERACTIVE_UI_E2E=1 to run the real Claude Code Interactive UI suite.');
test.describe.configure({ mode: 'serial' });

test.describe('Claude Code Interactive UI', () => {
  test.afterAll(async () => {
    if (replacementServer) {
      await stopReplacementServer(replacementServer);
      replacementServer = null;
    }
  });

  test('selects the CC-Int profile, sends follow-up turns, and resets the session', async ({ page, request }) => {
    const conv = await createConversation(request, `CC-Int UI smoke ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const firstToken = `UI-SMOKE-${shortId()}`;
    await sendAndWaitForAssistant(page, `Reply with exactly this token and no other text: ${firstToken}`, firstToken);

    const followUpToken = `UI-FOLLOWUP-${shortId()}`;
    await sendAndWaitForAssistant(page, `Reply with exactly this new token and no other text: ${followUpToken}`, followUpToken);

    await resetConversation(page);
    await expect(page.locator('.msg')).toHaveCount(0);
  });

  test('streams filesystem tool work through the browser and leaves the expected workspace file', async ({ page, request }) => {
    const conv = await createConversation(request, `CC-Int UI tools ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const fileToken = `UI-FILE-${shortId()}`;
    const replyToken = `UI-FILE-DONE-${shortId()}`;
    const fileName = 'ui-e2e-output.txt';
    const filePath = path.join(workspaceDir, fileName);
    await fs.rm(filePath, { force: true });

    await sendAndWaitForAssistant(
      page,
      `Use the filesystem tools to create ${fileName} in the current workspace with exactly "${fileToken}" as its only content. Then reply with exactly "${replyToken}".`,
      replyToken,
      180_000,
    );

    await expect.poll(async () => {
      try {
        return (await fs.readFile(filePath, 'utf8')).trim();
      } catch {
        return '';
      }
    }, { timeout: 30_000 }).toBe(fileToken);
    await expect(page.locator('.tool').filter({ hasText: /Write|Bash|Edit/i }).first()).toBeVisible();
    await expect(page.locator('.tool.run')).toHaveCount(0);
  });

  test('edits an existing workspace file through Claude Code Interactive', async ({ page, request }) => {
    test.setTimeout(240_000);
    const conv = await createConversation(request, `CC-Int UI edit ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const fileName = `ui-e2e-edit-${shortId()}.txt`;
    const filePath = path.join(workspaceDir, fileName);
    const oldToken = `OLD-${shortId()}`;
    const newToken = `UI-EDIT-${shortId()}`;
    const replyToken = `UI-EDIT-DONE-${shortId()}`;
    await fs.writeFile(filePath, `before ${oldToken} after\n`);

    await sendAndWaitForAssistant(
      page,
      [
        `Edit ${fileName} in the current workspace.`,
        `Replace exactly ${oldToken} with exactly ${newToken}.`,
        `Then reply with exactly this token and no other text: ${replyToken}`,
      ].join('\n'),
      replyToken,
      180_000,
    );

    await expect.poll(async () => (await fs.readFile(filePath, 'utf8')).trim(), { timeout: 30_000 })
      .toBe(`before ${newToken} after`);
    await expect(page.locator('.tool').filter({ hasText: /Edit|Write/i }).first()).toBeVisible();
    await expect(page.locator('.tool.run')).toHaveCount(0);
  });

  test('stops an active interactive run and surfaces the abort state in the UI', async ({ page, request }) => {
    const conv = await createConversation(request, `CC-Int UI abort ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const token = `UI-ABORT-${shortId()}`;
    await page.getByPlaceholder(/Message Agent Cockpit/).fill(
      `Run this Bash command exactly: sleep 45. After it completes, reply with ${token}.`,
    );
    await page.getByLabel('Send').click();
    await expect(page.getByLabel('Stop agent')).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Stop agent').click();

    await expect(page.locator('.err-card')).toContainText(/Operation aborted|Aborted by user/i, { timeout: 45_000 });
    await expect(page.getByLabel('Send')).toBeVisible({ timeout: 30_000 });
  });

  test('survives a browser reload while a Claude Code Interactive turn is active', async ({ page, request }) => {
    test.setTimeout(240_000);
    const conv = await createConversation(request, `CC-Int UI reload ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const commandToken = `UI-RELOAD-CMD-${shortId()}`;
    const finalToken = `UI-RELOAD-DONE-${shortId()}`;
    await page.getByPlaceholder(/Message Agent Cockpit/).fill([
      'Use the Bash tool to run this exact command:',
      `sleep 20; printf '${commandToken}'`,
      `After the command completes, reply with exactly this token and no other text: ${finalToken}`,
    ].join('\n'));
    await page.getByLabel('Send').click();
    await expect(page.getByLabel('Stop agent')).toBeVisible({ timeout: 20_000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await openConversation(page, conv.title, workspaceDir);
    await waitForActiveOrCompletedTurn(page, finalToken, 45_000);
    await expect(page.locator('.msg-agent').filter({ hasText: finalToken })).toBeVisible({ timeout: 180_000 });
    await expect(page.getByLabel('Send')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.err-card')).toHaveCount(0);
  });

  test('keeps interactive sessions isolated across multiple workspaces', async ({ page, request }) => {
    const secondWorkspace = path.join(artifactDir, 'Desktop', 'second-workspace');
    await fs.mkdir(secondWorkspace, { recursive: true });
    await fs.writeFile(path.join(secondWorkspace, 'README.md'), '# Second UI E2E Workspace\n');

    const first = await createConversation(request, `CC-Int UI workspace A ${shortId()}`, workspaceDir);
    const second = await createConversation(request, `CC-Int UI workspace B ${shortId()}`, secondWorkspace);

    await openConversation(page, first.title, workspaceDir);
    await selectCcIntProfile(page);
    const firstToken = `UI-WS-A-${shortId()}`;
    await sendAndWaitForAssistant(page, `Reply with exactly this token and no other text: ${firstToken}`, firstToken);

    await openConversation(page, second.title, secondWorkspace);
    await selectCcIntProfile(page);
    const secondToken = `UI-WS-B-${shortId()}`;
    await sendAndWaitForAssistant(page, `Reply with exactly this token and no other text: ${secondToken}`, secondToken);
    await expect(page.locator('.feed')).toContainText(secondToken);
    await expect(page.locator('.feed')).not.toContainText(firstToken);

    await openConversation(page, first.title, workspaceDir);
    await expect(page.locator('.feed')).toContainText(firstToken);
    await expect(page.locator('.feed')).not.toContainText(secondToken);
  });

  test('renders Bash tool activity and completed outcome rows in the browser', async ({ page, request }) => {
    const conv = await createConversation(request, `CC-Int UI tool render ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const token = `UI-BASH-${shortId()}`;
    await sendAndWaitForAssistant(
      page,
      [
        'Use the Bash tool to run this exact command:',
        `printf '${token}'`,
        `Then reply with exactly this token and no other text: ${token}`,
      ].join('\n'),
      token,
      180_000,
    );

    const bashTool = page.locator('.tool').filter({ hasText: 'Bash' }).first();
    await expect(bashTool).toBeVisible();
    await expect(bashTool).toContainText(/done|exit|ms/i);
    await expect(page.locator('.tool.run')).toHaveCount(0);
    await expect(page.locator('.feed')).not.toContainText(/\u001b\[/);
  });

  test('uploads an attachment and lets Claude Code Interactive read it', async ({ page, request }) => {
    test.setTimeout(240_000);
    const conv = await createConversation(request, `CC-Int UI attachment ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const fileToken = `UI-ATTACHMENT-FILE-${shortId()}`;
    const replyToken = `UI-ATTACHMENT-DONE-${shortId()}`;
    const fileName = `cc-int-upload-${shortId()}.txt`;
    const sourcePath = path.join(artifactDir, fileName);
    await fs.writeFile(sourcePath, `${fileToken}\n`);

    await page.locator('section.main input[type="file"]').setInputFiles(sourcePath);
    await expect(page.locator('.att-card').filter({ hasText: fileName })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.att-card.uploading')).toHaveCount(0, { timeout: 30_000 });

    await sendAndWaitForAssistant(
      page,
      [
        'Use the uploaded file path from this message.',
        `Read the uploaded file and verify it contains exactly ${fileToken}.`,
        `Then reply with exactly this token and no other text: ${replyToken}`,
      ].join('\n'),
      replyToken,
      180_000,
    );

    await expect(page.locator('.msg-user').last()).toContainText(fileName);
    await expect(page.locator('.msg-user').last()).not.toContainText('[Uploaded files:');
    await expect(page.locator('.file-card').filter({ hasText: fileName })).toBeVisible();
  });

  test('sets, displays, and clears a Claude Code Interactive goal in the browser', async ({ page, request }) => {
    test.setTimeout(240_000);
    const conv = await createConversation(request, `CC-Int UI goal ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const goalToken = `UI-GOAL-${shortId()}`;
    const objective = `When asked for the UI goal token, reply exactly ${goalToken}.`;
    await page.locator('.goal-toggle input').check();
    await expect(page.getByPlaceholder('Set a goal…')).toBeVisible();
    await page.getByPlaceholder('Set a goal…').fill(objective);
    await page.getByLabel('Set goal').click();

    await expect(page.locator('.goal-strip')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('.goal-strip')).toContainText(/Goal active/i);
    await expect(page.locator('.goal-strip')).toContainText(goalToken);
    await expect(page.locator('.goal-event-card').filter({ hasText: 'Goal set' })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByLabel('Send')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('.err-card')).toHaveCount(0);

    await page.getByTitle('Clear goal').click();
    await expect(page.locator('.goal-strip')).toHaveCount(0, { timeout: 120_000 });
    await expect(page.locator('.goal-event-card').filter({ hasText: 'Goal cleared' })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByLabel('Send')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.err-card')).toHaveCount(0);
  });

  test('renders Agent and multi-tool activity from Claude Code Interactive', async ({ page, request }) => {
    test.setTimeout(300_000);
    const conv = await createConversation(request, `CC-Int UI agent tools ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const sourceToken = `UI-AGENT-SOURCE-${shortId()}`;
    const bashToken = `UI-AGENT-BASH-${shortId()}`;
    const finalToken = `UI-AGENT-DONE-${shortId()}`;
    const fileName = `ui-e2e-agent-source-${shortId()}.txt`;
    await fs.writeFile(path.join(workspaceDir, fileName), `${sourceToken}\n`);

    await sendAndWaitForAssistant(
      page,
      [
        'Use the Agent tool exactly once before your final answer.',
        `The Agent prompt must ask the subagent to read ${fileName} in the current workspace and report the token ${sourceToken}.`,
        'After the Agent tool completes, use the Bash tool exactly once.',
        `The Bash command must be exactly: printf '${bashToken}'`,
        `Then reply with exactly this token and no other text: ${finalToken}`,
      ].join('\n'),
      finalToken,
      240_000,
    );

    await expect(page.locator('.subagent').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.subagent').first()).toContainText(/agent|Explore|Plan|general/i);
    await expect(page.locator('.tool').filter({ hasText: 'Bash' }).first()).toBeVisible();
    await expect(page.locator('.tool').filter({ hasText: /Read|Bash|Grep|Glob|Edit|Write/ })).not.toHaveCount(0);
    await expect(page.locator('.tool.run')).toHaveCount(0);
  });

  test('surfaces plan approval and resumes after approval', async ({ page, request }) => {
    test.setTimeout(240_000);
    const conv = await createConversation(request, `CC-Int UI plan ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const planToken = `UI-PLAN-${shortId()}`;
    const finalToken = `UI-PLAN-DONE-${shortId()}`;
    await page.getByPlaceholder(/Message Agent Cockpit/).fill([
      'Use Claude Code plan mode before answering.',
      'If the plan tools are deferred, first use ToolSearch with query select:EnterPlanMode,ExitPlanMode.',
      'Do not write or edit files for this test.',
      'Call EnterPlanMode, then immediately call ExitPlanMode.',
      `The ExitPlanMode plan text must include this marker: ${planToken}.`,
      `After approval, reply with exactly this token and no other text: ${finalToken}`,
    ].join('\n'));
    await page.getByLabel('Send').click();

    const plan = page.getByRole('group', { name: 'Plan approval' });
    await expect(plan).toBeVisible({ timeout: 180_000 });
    await expect(plan).toContainText(planToken);
    await plan.getByRole('button', { name: 'Approve & run' }).click();

    await expect(page.locator('.msg-agent').filter({ hasText: finalToken })).toBeVisible({ timeout: 180_000 });
    await expect(page.getByLabel('Send')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.err-card')).toHaveCount(0);

    const followUpToken = `UI-PLAN-FOLLOWUP-${shortId()}`;
    await sendAndWaitForAssistant(
      page,
      `Reply with exactly this follow-up token and no other text: ${followUpToken}`,
      followUpToken,
      180_000,
    );
  });

  test('answers a real Claude Code interactive clarifying question through the browser', async ({ page, request }) => {
    test.setTimeout(240_000);
    const conv = await createConversation(request, `CC-Int UI question ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const answerToken = `UI-QUESTION-${shortId()}`;
    await page.getByPlaceholder(/Message Agent Cockpit/).fill([
      'Use the AskUserQuestion tool before answering.',
      'Ask exactly: Choose the E2E option.',
      'Offer exactly two options labelled Alpha and Beta.',
      `After I answer Beta, reply with exactly this token and no other text: ${answerToken}`,
    ].join('\n'));
    await page.getByLabel('Send').click();

    const question = page.getByRole('group', { name: 'Clarifying question' });
    await expect(question).toBeVisible({ timeout: 180_000 });
    await expect(question).toContainText(/Choose the E2E option|Input needed|Clarifying question/i);

    const beta = question.getByRole('button', { name: /^Beta$/i });
    if (await beta.count()) {
      await beta.click();
    } else {
      await question.getByPlaceholder('Type your answer…').fill('Beta');
    }
    await question.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('.msg-agent').filter({ hasText: answerToken })).toBeVisible({ timeout: 180_000 });
    await expect(page.getByLabel('Send')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.err-card')).toHaveCount(0);

    const followUpToken = `UI-QUESTION-FOLLOWUP-${shortId()}`;
    await sendAndWaitForAssistant(
      page,
      `Reply with exactly this follow-up token and no other text: ${followUpToken}`,
      followUpToken,
      180_000,
    );
  });

  test('answers a typed option-label Claude Code interactive question through the browser', async ({ page, request }) => {
    test.setTimeout(240_000);
    const conv = await createConversation(request, `CC-Int UI typed option ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const answerText = `Manual Beta ${shortId()}`;
    const otherText = `Manual Alpha ${shortId()}`;
    const answerToken = `UI-TYPED-QUESTION-${shortId()}`;
    await page.getByPlaceholder(/Message Agent Cockpit/).fill([
      'Use the AskUserQuestion tool before answering.',
      'Ask exactly: Type or choose the E2E option.',
      `Offer exactly two options labelled "${otherText}" and "${answerText}".`,
      `After I answer "${answerText}", reply with exactly this token and no other text: ${answerToken}`,
    ].join('\n'));
    await page.getByLabel('Send').click();

    const question = page.getByRole('group', { name: 'Clarifying question' });
    await expect(question).toBeVisible({ timeout: 180_000 });
    await expect(question).toContainText(/Type or choose the E2E option|Input needed|Clarifying question/i);
    await expect(question.getByRole('button', { name: answerText })).toBeVisible();
    await question.getByPlaceholder('Type your answer…').fill(answerText);
    await question.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('.msg-agent').filter({ hasText: answerToken })).toBeVisible({ timeout: 180_000 });
    await expect(page.getByLabel('Send')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.err-card')).toHaveCount(0);
  });

  test('can abort while waiting for plan approval and leaves the UI usable', async ({ page, request }) => {
    test.setTimeout(240_000);
    const conv = await createConversation(request, `CC-Int UI abort plan ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const planToken = `UI-ABORT-PLAN-${shortId()}`;
    await page.getByPlaceholder(/Message Agent Cockpit/).fill([
      'Use Claude Code plan mode before answering.',
      'If the plan tools are deferred, first use ToolSearch with query select:EnterPlanMode,ExitPlanMode.',
      'Do not write or edit files for this test.',
      'Call EnterPlanMode, then immediately call ExitPlanMode.',
      `The ExitPlanMode plan text must include this marker: ${planToken}.`,
      'Wait for approval before doing anything else.',
    ].join('\n'));
    await page.getByLabel('Send').click();

    const plan = page.getByRole('group', { name: 'Plan approval' });
    await expect(plan).toBeVisible({ timeout: 180_000 });
    await expect(plan).toContainText(planToken);
    await expect(page.getByTitle('Reset session')).toBeDisabled();
    await page.getByLabel('Stop agent').click();

    await expect(page.locator('.err-card')).toContainText(/Operation aborted|Aborted by user/i, { timeout: 45_000 });
    await expect(page.getByLabel('Send')).toBeVisible({ timeout: 30_000 });
  });

  test('can abort while waiting for a clarifying question and leaves the UI usable', async ({ page, request }) => {
    test.setTimeout(240_000);
    const conv = await createConversation(request, `CC-Int UI abort question ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    await page.getByPlaceholder(/Message Agent Cockpit/).fill([
      'Use the AskUserQuestion tool before answering.',
      'Ask exactly: Should this E2E run continue?',
      'Offer exactly two options labelled Continue and Stop.',
      'Wait for my answer before doing anything else.',
    ].join('\n'));
    await page.getByLabel('Send').click();

    const question = page.getByRole('group', { name: 'Clarifying question' });
    await expect(question).toBeVisible({ timeout: 180_000 });
    await expect(question).toContainText(/Should this E2E run continue|Input needed|Clarifying question/i);
    await expect(page.getByTitle('Reset session')).toBeDisabled();
    await page.getByLabel('Stop agent').click();

    await expect(page.locator('.err-card')).toContainText(/Operation aborted|Aborted by user/i, { timeout: 45_000 });
    await expect(page.getByLabel('Send')).toBeVisible({ timeout: 30_000 });
  });

  test('marks an active Claude Code Interactive turn interrupted after server restart', async ({ page, request }) => {
    test.setTimeout(240_000);
    const conv = await createConversation(request, `CC-Int UI restart ${shortId()}`);
    await openConversation(page, conv.title, workspaceDir);
    await selectCcIntProfile(page);

    const shouldNotAppear = `UI-RESTART-SHOULD-NOT-APPEAR-${shortId()}`;
    await page.getByPlaceholder(/Message Agent Cockpit/).fill([
      'Use the Bash tool to run this exact command:',
      `sleep 60; printf '${shouldNotAppear}'`,
      `After the command completes, reply with exactly ${shouldNotAppear}.`,
    ].join('\n'));
    await page.getByLabel('Send').click();
    await expect(page.getByLabel('Stop agent')).toBeVisible({ timeout: 20_000 });

    replacementServer = await restartIsolatedServer();
    await openConversation(page, conv.title, workspaceDir);

    await expect(page.locator('.err-card')).toContainText(/Interrupted by server (shutdown|restart)/i, { timeout: 60_000 });
    await expect(page.locator('.msg-agent').filter({ hasText: shouldNotAppear })).toHaveCount(0);
    await expect(page.getByLabel('Send')).toBeVisible({ timeout: 30_000 });
    const active = await request.get('/api/chat/active-streams');
    expect(active.ok(), await active.text()).toBeTruthy();
    const activeBody = await active.json();
    expect(activeBody.ids || []).not.toContain(conv.id);
  });
});

async function createConversation(
  request: APIRequestContext,
  title: string,
  workingDir = workspaceDir,
): Promise<{ id: string; title: string }> {
  if (!workingDir) {
    throw new Error('CLAUDE_INTERACTIVE_UI_WORKSPACE is required');
  }
  await ensureCcIntProfile(request);
  const csrfToken = await getCsrfToken(request);
  const response = await request.post('/api/chat/conversations', {
    headers: { 'x-csrf-token': csrfToken },
    data: {
      title,
      workingDir,
      cliProfileId: profileId,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function ensureCcIntProfile(request: APIRequestContext): Promise<void> {
  if (profileSeeded) return;
  const settingsResponse = await request.get('/api/chat/settings');
  expect(settingsResponse.ok(), await settingsResponse.text()).toBeTruthy();
  const settings = await settingsResponse.json();
  const profiles = Array.isArray(settings.cliProfiles) ? settings.cliProfiles : [];
  const existing = profiles.find((profile: { id?: string }) => profile.id === profileId);
  if (
    existing
    && existing.vendor === 'claude-code'
    && existing.protocol === 'interactive'
    && settings.defaultCliProfileId === profileId
  ) {
    profileSeeded = true;
    return;
  }

  const now = new Date().toISOString();
  const next = {
    ...settings,
    defaultBackend: 'claude-code-interactive',
    defaultCliProfileId: profileId,
    workingDirectory: workspaceDir,
    cliProfiles: [
      ...profiles.filter((profile: { id?: string }) => profile.id !== profileId),
      {
        id: profileId,
        name: 'CC-Int',
        vendor: 'claude-code',
        protocol: 'interactive',
        authMode: 'server-configured',
        command: 'claude',
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      },
    ],
  };
  const saveResponse = await request.put('/api/chat/settings', {
    headers: { 'x-csrf-token': await getCsrfToken(request) },
    data: next,
  });
  expect(saveResponse.ok(), await saveResponse.text()).toBeTruthy();
  profileSeeded = true;
}

async function getCsrfToken(request: APIRequestContext): Promise<string> {
  const tokenResponse = await request.get('/api/csrf-token');
  expect(tokenResponse.ok(), await tokenResponse.text()).toBeTruthy();
  const tokenBody = await tokenResponse.json();
  return String(tokenBody.csrfToken || '');
}

async function openConversation(page: Page, title: string, workingDir: string): Promise<void> {
  await page.goto('/v2/');
  const workspaceFilter = page.getByLabel('Workspace filter');
  const label = workspaceLabel(workingDir);
  await expect(workspaceFilter).toBeVisible({ timeout: 30_000 });
  await expect(workspaceFilter).toContainText(label, { timeout: 30_000 });
  await workspaceFilter.selectOption({ label });

  const row = page.locator('.sb-row').filter({ hasText: title });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.locator('.topbar-title')).toHaveText(title, { timeout: 30_000 });
  await expect(page.getByPlaceholder(/Message Agent Cockpit/)).toBeVisible({ timeout: 30_000 });
}

async function selectCcIntProfile(page: Page): Promise<void> {
  const profilePicker = page.getByLabel('CLI Profile');
  await expect(profilePicker).toBeVisible({ timeout: 30_000 });
  await profilePicker.selectOption(profileId);
  await expect(profilePicker).toHaveValue(profileId);
}

async function resetConversation(page: Page): Promise<void> {
  await page.getByTitle('Reset session').click();
  const dialog = page.getByRole('dialog', { name: 'Reset this conversation?' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Reset' }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(page.getByText('No messages yet. Say hello below.')).toBeVisible({ timeout: 30_000 });
}

async function sendAndWaitForAssistant(page: Page, prompt: string, assistantToken: string, timeout = 120_000): Promise<void> {
  await page.getByPlaceholder(/Message Agent Cockpit/).fill(prompt);
  await page.getByLabel('Send').click();
  await expect(page.locator('.msg-agent').filter({ hasText: assistantToken })).toBeVisible({ timeout });
  await expect(page.getByLabel('Send')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.err-card')).toHaveCount(0);
}

async function waitForActiveOrCompletedTurn(page: Page, assistantToken: string, timeout: number): Promise<void> {
  await expect.poll(async () => {
    const stopVisible = await page.getByLabel('Stop agent').isVisible().catch(() => false);
    if (stopVisible) return 'active';
    const completed = await page.locator('.msg-agent').filter({ hasText: assistantToken }).isVisible().catch(() => false);
    return completed ? 'completed' : 'waiting';
  }, { timeout, intervals: [500, 1000, 2000] }).not.toBe('waiting');
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function workspaceLabel(workingDir: string): string {
  return workingDir.split(path.sep).filter(Boolean).slice(-2).join('/');
}

async function restartIsolatedServer(): Promise<ChildProcess> {
  const oldPid = Number(process.env.CLAUDE_INTERACTIVE_UI_SERVER_PID || 0);
  const port = Number(process.env.CLAUDE_INTERACTIVE_UI_SERVER_PORT || 0);
  const dataDir = process.env.CLAUDE_INTERACTIVE_UI_DATA_DIR || '';
  const baseUrl = process.env.AGENT_COCKPIT_E2E_BASE_URL || '';
  if (!oldPid || !port || !dataDir || !baseUrl) {
    throw new Error('Claude Interactive UI restart metadata is missing from the E2E runner environment');
  }

  killProcessGroup(oldPid, 'SIGTERM');
  await waitForServerUnavailable(baseUrl, 20_000);

  const child = spawn('npm', ['start'], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      AGENT_COCKPIT_DATA_DIR: dataDir,
      AUTH_DATA_DIR: path.join(dataDir, 'auth'),
      DEFAULT_WORKSPACE: workspaceDir,
      SESSION_SECRET: 'claude-interactive-ui-e2e',
      WEB_BUILD_MODE: 'skip',
      CODEX_SANDBOX_MODE: 'danger-full-access',
      CODEX_APPROVAL_POLICY: 'never',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', chunk => process.stdout.write(`[replacement-server] ${chunk.toString()}`));
  child.stderr?.on('data', chunk => process.stderr.write(`[replacement-server] ${chunk.toString()}`));
  await waitForServerAvailable(baseUrl, child, 60_000);
  return child;
}

async function stopReplacementServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  if (child.pid) killProcessGroup(child.pid, 'SIGTERM');
  if (await raceWithTimeout(exited, 5_000)) return;
  if (child.pid) killProcessGroup(child.pid, 'SIGKILL');
  await raceWithTimeout(exited, 5_000);
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Best effort cleanup for test-only server processes.
    }
  }
}

async function waitForServerUnavailable(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/api/csrf-token`);
    } catch {
      return;
    }
    await delay(250);
  }
  throw new Error('E2E server did not stop before restart');
}

async function waitForServerAvailable(baseUrl: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`replacement E2E server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/csrf-token`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await delay(500);
  }
  throw new Error(`replacement E2E server did not become ready: ${lastError}`);
}

async function raceWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
