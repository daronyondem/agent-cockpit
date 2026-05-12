import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devices, webkit } from 'playwright';

const defaultDevices = ['iPhone 13', 'iPhone 15 Pro'];
const requestedDevices = (process.env.PWA_DEVICES ?? defaultDevices.join(','))
  .split(',')
  .map((device) => device.trim())
  .filter(Boolean);

const targetUrl = process.env.PWA_URL ?? 'http://127.0.0.1:5174/mobile/';
const outDir = process.env.PWA_SCREENSHOT_DIR
  ? path.resolve(process.env.PWA_SCREENSHOT_DIR)
  : fileURLToPath(new URL('../tmp/visual/', import.meta.url));
const ignoredIssuePatterns = [
  /Viewport argument key "interactive-widget" not recognized and ignored\./,
  /Parsing application manifest : The manifest is not valid JSON data\./,
];

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function addPageIssue(pageIssues, issue) {
  if (ignoredIssuePatterns.some((pattern) => pattern.test(issue))) {
    return;
  }
  pageIssues.push(issue);
}

async function saveScreenshot(page, deviceName, stateName) {
  const deviceSlug = slugify(deviceName);
  const fileName = stateName === 'home' ? `${deviceSlug}.png` : `${deviceSlug}-${stateName}.png`;
  const screenshotPath = path.join(outDir, fileName);
  await page.screenshot({
    path: screenshotPath,
    fullPage: false,
    animations: 'disabled',
  });
  const viewport = page.viewportSize();
  console.log(`${deviceName} ${stateName}: ${screenshotPath} (${viewport?.width ?? '?'}x${viewport?.height ?? '?'})`);
}

async function clickModalClose(page) {
  const close = page.locator('.modal').last().locator('.modal-header').getByRole('button', { name: 'Close' }).first();
  if (await close.count()) {
    await close.click();
    await page.waitForTimeout(150);
  }
}

async function captureOptionalState(page, pageIssues, label, action) {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pageIssues.push(`capture ${label}: ${message}`);
  }
}

await mkdir(outDir, { recursive: true });

const browser = await webkit.launch();

try {
  for (const deviceName of requestedDevices) {
    const device = devices[deviceName];
    if (!device) {
      throw new Error(`Unknown Playwright device profile: ${deviceName}`);
    }

    const context = await browser.newContext({
      ...device,
      colorScheme: 'light',
    });
    const page = await context.newPage();
    const pageIssues = [];

    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) {
        addPageIssue(pageIssues, `${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      addPageIssue(pageIssues, `pageerror: ${error.message}`);
    });

    const response = await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    if (!response?.ok()) {
      throw new Error(`Failed to load ${targetUrl}: HTTP ${response?.status() ?? 'no response'}`);
    }

    await page.waitForFunction(() => {
      const root = document.querySelector('#root');
      return Boolean(root && root.childElementCount > 0);
    }, undefined, { timeout: 10_000 });

    await saveScreenshot(page, deviceName, 'home');

    await captureOptionalState(page, pageIssues, 'chat', async () => {
      const idleConversation = page.locator('.conversation-card:not(.streaming)').first();
      const firstConversation = page.locator('.conversation-card').first();
      const conversationToOpen = (await idleConversation.count()) ? idleConversation : firstConversation;
      if (!(await conversationToOpen.count())) {
        return;
      }
      await conversationToOpen.click();
      await page.waitForSelector('.chat-screen', { timeout: 15_000 });
      await saveScreenshot(page, deviceName, 'chat');
    });

    if (await page.locator('.chat-screen').count()) {
      await captureOptionalState(page, pageIssues, 'run settings', async () => {
        const settingsButton = page.locator('.selection-bar');
        if (!(await settingsButton.count())) {
          return;
        }
        await settingsButton.click();
        await page.waitForSelector('.modal', { timeout: 10_000 });
        await saveScreenshot(page, deviceName, 'run-settings');
        await clickModalClose(page);
      });

      await captureOptionalState(page, pageIssues, 'conversation actions', async () => {
        await page.getByRole('button', { name: 'More' }).click();
        await page.waitForSelector('.modal', { timeout: 10_000 });
        await saveScreenshot(page, deviceName, 'actions');
      });

      if (await page.locator('.modal').count()) {
        await captureOptionalState(page, pageIssues, 'sessions', async () => {
          const sessionsButton = page.getByRole('button', { name: 'Sessions' }).last();
          if (!(await sessionsButton.count())) {
            return;
          }
          await sessionsButton.click();
          await page.waitForFunction(() => Array.from(document.querySelectorAll('.modal h2')).some((node) => node.textContent === 'Sessions'), undefined, { timeout: 10_000 });
          await saveScreenshot(page, deviceName, 'sessions');
          const viewButton = page.locator('.session-action.view').first();
          if (await viewButton.count()) {
            await viewButton.click();
            await page.waitForSelector('.session-viewer-screen', { timeout: 10_000 });
            await saveScreenshot(page, deviceName, 'session-viewer');
            await page.locator('.session-back').click();
            await page.waitForFunction(() => Array.from(document.querySelectorAll('.modal h2')).some((node) => node.textContent === 'Sessions'), undefined, { timeout: 10_000 });
          }
          await clickModalClose(page);
        });

        await captureOptionalState(page, pageIssues, 'files', async () => {
          const filesButton = page.getByRole('button', { name: 'Files' }).last();
          if (!(await filesButton.count())) {
            return;
          }
          await filesButton.click();
          await page.waitForFunction(() => Array.from(document.querySelectorAll('.modal h2')).some((node) => node.textContent?.startsWith('Files')), undefined, { timeout: 10_000 });
          await page.waitForTimeout(1_200);
          await saveScreenshot(page, deviceName, 'files');
          await clickModalClose(page);
        });
      }
    }

    if (pageIssues.length > 0) {
      console.log(`  Console/page issues:\n  - ${pageIssues.join('\n  - ')}`);
    }

    await context.close();
  }
} finally {
  await browser.close();
}
