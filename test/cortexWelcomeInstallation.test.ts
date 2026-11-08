/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { loadFrontendModule } from './mobileModuleLoader';

const missing = { id: 'cortex-cli', label: 'Cortex Code (CoCo) CLI', required: false, status: 'warning', summary: 'Cortex Code CLI is not ready.',
  installActions: [{ id: 'cortex-cli:official-install', kind: 'command', label: 'Install Cortex Code' },
    { id: 'cortex-cli:docs', kind: 'link', label: 'Open docs', href: 'https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli' }] };
const ready = { ...missing, status: 'ok', summary: 'Cortex Code CLI responded. Login has not been checked.', installActions: [] };
const api = { getInstallStatus: jest.fn(), getInstallDoctor: jest.fn(), auth: { status: jest.fn() }, runInstallAction: jest.fn() };
const { WelcomeScreen } = loadFrontendModule('web/AgentCockpitWeb/src/welcomeScreen.jsx', {
  react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime'), './api.js': { AgentApi: api },
  './icons.jsx': { Ico: new Proxy({}, { get: () => () => null }) }, './shellState.jsx': { ScreenLoading: () => null },
  './cortexSetup.jsx': { CortexSetup: () => createElement('section', { 'aria-label': 'Cortex Code setup' }, 'Cortex Code (CoCo) setup') },
}, { window });

describe('Welcome optional CoCo installation', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks();
    api.getInstallStatus.mockResolvedValue({ channel: 'dev' }); api.auth.status.mockResolvedValue({});
    api.getInstallDoctor.mockResolvedValue({ checks: [missing], overallStatus: 'warning' });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = async () => { await act(async () => root.render(createElement(WelcomeScreen, { onDone: jest.fn(), onOpenSettings: jest.fn() }))); };
  const install = () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Install Cortex Code'))!;

  test('shows the official optional action and replaces it with refreshed detection while retaining dedicated login setup', async () => {
    await render();
    expect(container.textContent).toContain('Cortex Code CLI is not ready.'); expect(install()).toBeDefined();
    expect(container.querySelector('a[href*="docs.snowflake.com"]')).not.toBeNull();
    api.runInstallAction.mockResolvedValue({ success: true, steps: [], doctor: { checks: [ready] } });
    await act(async () => install().click());
    expect(api.runInstallAction).toHaveBeenCalledWith('cortex-cli:official-install');
    expect(container.textContent).toContain('Login has not been checked.');
    expect(container.querySelector('[aria-label="Cortex Code setup"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Check login');
  });

  test('keeps native installation failure actionable without implying authentication', async () => {
    api.runInstallAction.mockResolvedValue({ success: false, error: 'checksum mismatch', steps: [] });
    await render(); await act(async () => install().click());
    expect(container.textContent).toContain('checksum mismatch'); expect(install().disabled).toBe(false);
    expect(container.textContent).not.toContain('Login has not been checked.');
  });
});
