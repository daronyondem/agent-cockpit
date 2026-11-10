/** @jest-environment jsdom */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { loadFrontendModule } from './mobileModuleLoader';

const api = {
  cortexConnections: jest.fn(), createCortexConnection: jest.fn(), startSetupCliAuth: jest.fn(), testSetupCliAuth: jest.fn(),
  startCliProfileAuth: jest.fn(), testCliProfile: jest.fn(),
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
    window.localStorage.clear(); window.sessionStorage.clear();
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

  test('selects the entire native URL and submits the complete redirect once while clearing its pending input', async () => {
    const authorizationUrl = `${running.cortex.authorizationUrl}&code_challenge=${'x'.repeat(300)}&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2F`;
    api.cortexConnections.mockResolvedValue({ connections: [{ name: 'fixture' }], job: { ...running, cortex: { ...running.cortex, authorizationUrl } } });
    await click('Cortex Code (CoCo) setup');
    const url = container.querySelector('textarea')!;
    await act(async () => url.focus());
    expect(url.value.slice(url.selectionStart, url.selectionEnd)).toBe(authorizationUrl);
    const redirect = 'http://127.0.0.1:54321/?code=PRIVATE_CODE&state=PRIVATE_STATE&iss=https%3A%2F%2Ffixture.snowflakecomputing.com%2Foauth';
    await type('Complete redirect URL', redirect);
    let finish!: (value: unknown) => void;
    api.submitCortexRedirect.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(input('Complete redirect URL').value).toBe('');
    expect(input('Complete redirect URL').disabled).toBe(true);
    expect(api.submitCortexRedirect).toHaveBeenCalledTimes(1);
    expect(api.submitCortexRedirect).toHaveBeenCalledWith('job', 'generation', redirect);
    await act(async () => finish({ job: { ...running, updatedAt: '2026-11-06T00:00:01.000Z', cortex: { phase: 'verifying', generation: 'generation' } } }));
    expect(container.querySelector('textarea')).toBeNull();
    for (const storage of [window.localStorage, window.sessionStorage]) expect(JSON.stringify(storage)).not.toMatch(/PRIVATE_STATE|PRIVATE_CODE/);
    expect(JSON.stringify(window.history.state)).not.toMatch(/PRIVATE_STATE|PRIVATE_CODE/);
  });

  test.each(['failed', 'cancelled'])('a polled %s handoff clears a still-typed redirect and the native URL', async status => {
    api.cortexConnections.mockResolvedValue({ connections: [{ name: 'fixture' }], job: running });
    await click('Cortex Code (CoCo) setup'); await type('Complete redirect URL', 'http://127.0.0.1:54321/?code=PRIVATE_CODE');
    api.getCliProfileAuthJob.mockResolvedValue({ job: { ...running, status, updatedAt: '2026-11-06T00:00:02.000Z', cortex: undefined, error: 'Login expired or cancelled.' } });
    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    expect(container.querySelector('textarea')).toBeNull(); expect(container.innerHTML).not.toMatch(/PRIVATE_STATE|PRIVATE_CODE/);
    api.startSetupCliAuth.mockResolvedValue({ profile, job: { ...running, id: 'new-job', cortex: { ...running.cortex, generation: 'new-generation' } } });
    await click('Authenticate Cortex'); expect(input('Complete redirect URL').value).toBe('');
    for (const storage of [window.localStorage, window.sessionStorage]) expect(JSON.stringify(storage)).not.toMatch(/PRIVATE_STATE|PRIVATE_CODE/);
  });

  test.each([true, false])('a card recovers only its own active login (matching profile=%s)', async matching => {
    const cardProfile = { id: 'card', authMode: 'account', cortexCode: { connection: 'saved' } };
    api.cortexConnections.mockResolvedValue({ connections: [{ name: 'fixture' }], job: { ...running, profileId: matching ? 'card' : 'another' } });
    await act(async () => root.render(createElement(CortexSetup, { key: 'card', profile: cardProfile, onConnectionChange: jest.fn(), onSave: jest.fn() })));
    expect(container.querySelector('select')!.value).toBe('saved');
    if (!matching) {
      expect(container.querySelector('textarea')).toBeNull();
      expect(button('Cancel Cortex login')).toBeUndefined();
      expect(api.getCliProfileAuthJob).not.toHaveBeenCalled();
      return;
    }
    expect(container.querySelector('textarea')!.value).toContain('PRIVATE_STATE');
    await type('Complete redirect URL', 'http://127.0.0.1:54321/?code=PRIVATE_CODE');
    api.submitCortexRedirect.mockResolvedValue({ job: { ...running, profileId: 'card', status: 'succeeded', cortex: undefined } });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(api.submitCortexRedirect).toHaveBeenCalledWith('job', 'generation', 'http://127.0.0.1:54321/?code=PRIVATE_CODE');
    expect(container.innerHTML).not.toMatch(/PRIVATE_STATE|PRIVATE_CODE/);
  });

  test('creating a connection updates only the card selection; checking saves before using its profile route', async () => {
    const save = jest.fn().mockResolvedValue(true);
    function Card(){
      const [connection, select] = useState('');
      return createElement(CortexSetup, { profile: { id: 'card', authMode: 'account', cortexCode: { connection } }, onConnectionChange: select, onSave: save });
    }
    await act(async () => root.render(createElement(Card)));
    expect(button('Check Cortex login').disabled).toBe(true);
    await click('Create OAuth connection'); await type('New connection name', 'new'); await type('Snowflake account', 'EXAMPLE'); await type('Snowflake user', 'USER');
    api.createCortexConnection.mockResolvedValue({ connections: [{ name: 'new' }] });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(container.querySelector('select')!.value).toBe('new');
    api.testCliProfile.mockResolvedValue({ result: { output: 'Card login verified' } });
    await click('Check Cortex login');
    expect(save).toHaveBeenCalledTimes(1); expect(api.testCliProfile).toHaveBeenCalledWith('card');
    expect(api.testSetupCliAuth).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Card login verified');
    expect(container.textContent).not.toContain('Snowflake user');
  });

  test('an isolated card checks its own home and offers terminal login without shared connection creation', async () => {
    const save = jest.fn().mockResolvedValue(true);
    await act(async () => root.render(createElement(CortexSetup, { key: 'isolated', profile: { id: 'isolated', authMode: 'account',
      configDir: '/private/home', cortexCode: { connection: 'private' } }, onConnectionChange: jest.fn(), onSave: save })));
    expect(container.querySelector('input')!.value).toBe('private');
    expect(button('Create OAuth connection')).toBeUndefined(); expect(button('Authenticate Cortex')).toBeUndefined();
    expect(container.textContent).toContain('Authenticate in its terminal');
    api.testCliProfile.mockResolvedValue({ result: { output: 'Isolated login verified' } });
    await click('Check Cortex login'); expect(api.testCliProfile).toHaveBeenCalledWith('isolated');
  });
});
