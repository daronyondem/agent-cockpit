import { test, expect } from '@playwright/test';

test.skip(process.env.INSTALL_UI_E2E !== '1', 'Run through e2e:install against an isolated production installation.');

const repaired = process.env.INSTALL_UI_REPAIRED === '1';
const email = 'install-fixture@example.test';
const password = 'install-fixture-password-42';

test.beforeEach(async ({ page }) => {
  // Optional font/style CDNs must not block local setup verification.
  await page.route('https://**', route => route.abort());
});

test('fresh production installation completes owner setup and welcome without backend login', async ({ page, request }) => {
  test.skip(repaired, 'Owner setup already completed before repair.');
  await page.goto('/auth/setup');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Display name', { exact: true }).fill('Install fixture');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create owner' }).click();
  await expect(page.locator('.welcome-shell')).toBeVisible();
  await expect(page.getByText('Unused backends can stay uninstalled.', { exact: false })).toBeVisible();
  const doctor = await (await request.get('/api/chat/install/doctor')).json();
  for (const check of doctor.checks.filter((item: { required: boolean }) => item.required)) expect(check.status, check.id).toBe('ok');
  await page.locator('.welcome-foot .btn.primary').click();
  await expect(page.locator('.welcome-shell')).toHaveCount(0);
  const install = await (await request.get('/api/chat/install/status')).json();
  expect(install.welcomeCompletedAt).toBeTruthy();
  await page.reload();
  await expect(page.locator('.welcome-shell')).toHaveCount(0);
});

test('completed onboarding survives repair and mobile assets still load', async ({ page, request }) => {
  test.skip(!repaired, 'Run after the same-version installer repair.');
  await page.goto('/auth/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/v2\//);
  await expect(page.locator('.welcome-shell')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto('/mobile/');
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const install = await (await request.get('/api/chat/install/status')).json();
  expect(install.welcomeCompletedAt).toBeTruthy();
});
