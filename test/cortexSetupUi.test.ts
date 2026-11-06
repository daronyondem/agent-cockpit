/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { loadFrontendModule } from './mobileModuleLoader';

const api = {
  cortexConnections: jest.fn(), createCortexConnection: jest.fn(), startSetupCliAuth: jest.fn(), testSetupCliAuth: jest.fn(),
  getCliProfileAuthJob: jest.fn(), cancelCliProfileAuth: jest.fn(), submitCortexRedirect: jest.fn(),
};
const { CortexSetup } = loadFrontendModule('web/AgentCockpitWeb/src/cortexSetup.jsx', {
  react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime'), './api.js': { AgentApi: { settings: api } }, './cortexSetup.css': {},
}, { window });

describe('Cortex shared setup controls', () => {
  let container: HTMLDivElement, root: Root;
  const profile = { id: 'setup-cortex-code-account', cortexCode: { connection: 'fixture' } };
  const running = { id: 'job', status: 'running', updatedAt: '2026-11-06T00:00:00.000Z', cortex: {
    phase: 'waiting-for-browser', generation: 'generation', connection: 'fixture', authorizationUrl: 'https://fixture.snowflakecomputing.com/oauth/authorize?state=PRIVATE_STATE', expiresAt: '2026-11-06T00:10:00Z',
  } };
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent === label)!;
  const input = (label: string) => Array.from(container.querySelectorAll('label')).find(item => item.textContent?.startsWith(label))!.querySelector('input')!;
  const click = async (label: string) => { await act(async () => { button(label).click(); }); };
  const type = async (label: string, value: string) => { await act(async () => {
    const field = input(label); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }); };
  beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.useFakeTimers(); jest.clearAllMocks();
    api.cortexConnections.mockResolvedValue({ connections: [{ name: 'fixture', manualOAuth: true, browserTimeoutMs: 600000 }], job: null });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root.render(createElement(CortexSetup, {})); });
  });
  afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); jest.useRealTimers(); });

  test('loads on request, uses only the named connection for saved auth, and creates without persisting account fields in settings', async () => {
    expect(api.cortexConnections).not.toHaveBeenCalled(); await click('Cortex Code (CoCo) setup');
    api.testSetupCliAuth.mockResolvedValue({ profile, result: { output: 'Fresh process verified' } });
    await click('Check Cortex login'); expect(api.testSetupCliAuth).toHaveBeenCalledWith('cortex-code', { connection: 'fixture' });
    expect(container.textContent).toContain('Fresh process verified');
    await click('Create OAuth connection'); await type('New connection name', 'new'); await type('Snowflake account', 'EXAMPLE'); await type('Snowflake user', 'USER');
    api.createCortexConnection.mockResolvedValue({ connections: [{ name: 'new' }] });
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(api.createCortexConnection).toHaveBeenCalledWith({ name: 'new', account: 'EXAMPLE', user: 'USER' });
    expect(container.textContent).not.toContain('Snowflake user'); expect(container.querySelector('select')!.value).toBe('new');
    expect(window.localStorage.length).toBe(0);
  });

  test('shows only a live native handoff, clears redirect input immediately and removes the URL after success', async () => {
    await click('Cortex Code (CoCo) setup'); api.startSetupCliAuth.mockResolvedValue({ profile, job: running });
    await click('Authenticate Cortex');
    expect(container.querySelector('textarea')!.value).toContain('PRIVATE_STATE');
    await type('Complete redirect URL', 'http://127.0.0.1:54321/?code=PRIVATE_CODE');
    api.submitCortexRedirect.mockResolvedValue({ job: { ...running, updatedAt: '2026-11-06T00:00:01.000Z', cortex: { generation: 'generation', phase: 'verifying' } } });
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(api.submitCortexRedirect).toHaveBeenCalledWith('job', 'generation', 'http://127.0.0.1:54321/?code=PRIVATE_CODE');
    expect(container.querySelector('textarea')).toBeNull(); expect(container.innerHTML).not.toContain('PRIVATE_CODE');
    api.getCliProfileAuthJob.mockResolvedValue({ job: { ...running, updatedAt: '2026-11-06T00:00:02.000Z', status: 'succeeded', cortex: undefined, events: [{ text: 'Fresh inference verified' }] } });
    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    expect(container.textContent).toContain('Fresh inference verified'); expect(container.innerHTML).not.toContain('PRIVATE_STATE');
    expect(window.localStorage.length).toBe(0);
  });

  test('recovers an active handoff after remount and ignores an older in-flight poll after cancellation', async () => {
    api.cortexConnections.mockResolvedValue({ connections: [{ name: 'fixture' }], job: running });
    await click('Cortex Code (CoCo) setup');
    let resolve!: (value: unknown) => void; api.getCliProfileAuthJob.mockImplementation(() => new Promise(done => { resolve = done; }));
    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    api.cancelCliProfileAuth.mockResolvedValue({ job: { ...running, updatedAt: '2026-11-06T00:00:03.000Z', status: 'cancelled', cortex: undefined, error: 'Authentication cancelled.' } });
    await click('Cancel Cortex login'); await act(async () => { resolve({ job: running }); });
    expect(container.querySelector('textarea')).toBeNull(); expect(container.textContent).toContain('Authentication cancelled.');
    expect(button('Authenticate Cortex').disabled).toBe(false);
  });
});
