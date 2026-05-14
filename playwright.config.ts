import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';

const useSystemChrome = process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === '1'
  || (
    process.env.PLAYWRIGHT_USE_SYSTEM_CHROME !== '0'
    && process.platform === 'darwin'
    && fs.existsSync('/Applications/Google Chrome.app')
  );

export default defineConfig({
  testDir: './test/e2e',
  testMatch: /.*\.pw\.ts/,
  timeout: 180_000,
  expect: {
    timeout: 30_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.AGENT_COCKPIT_E2E_BASE_URL || 'http://127.0.0.1:3339',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(useSystemChrome ? { channel: 'chrome' } : {}),
      },
    },
  ],
});
