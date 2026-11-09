/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadFrontendModule, loadMobileModule } from './mobileModuleLoader';

const dependencies = { react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime') };
const { CopilotUsageDetails } = loadFrontendModule('web/AgentCockpitWeb/src/chat/copilotUsage.jsx', dependencies);
const { CopilotUsage, CopilotQuota } = loadMobileModule('copilotUsage.tsx', dependencies);
const usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0, costUsd: 0,
  credits: 500, copilot: { tokensStatus: 'complete', aiCreditsStatus: 'partial', aiCredits: 1.25, premiumRequests: 2 } };

test.each(['desktop', 'mobile'])('%s distinguishes premium requests, partial AI credits and unavailable USD', client => {
  const text = renderToStaticMarkup(createElement(client === 'desktop' ? CopilotUsageDetails : CopilotUsage, { usage }));
  expect(text).toContain('1.25 reported subtotal');
  expect(text).toContain('Premium requests'); expect(text).toContain('>2<');
  expect(text).not.toContain('500'); expect(text).not.toContain('$0'); expect(text).toContain('Unavailable');
  const missing = renderToStaticMarkup(createElement(client === 'desktop' ? CopilotUsageDetails : CopilotUsage, { usage: { ...usage, copilot: { tokensStatus: 'unavailable', aiCreditsStatus: 'unavailable' } } }));
  expect(missing).toContain('showing recorded usage');
  expect(missing).not.toContain('1.25');
});

test('desktop marks stale account readings and preserves unknown quota units without claiming exhaustion', () => {
  const quota = { status: 'available', stale: true, fetchedAt: '2026-11-04T20:00:00Z', rows: [
    { id: 'premium', label: '<quota>', used: 0, entitlement: 100, unit: 'unknown', usedPercentage: 0 },
  ] };
  const text = renderToStaticMarkup(createElement(CopilotUsageDetails, { usage, quota }));
  expect(text).toContain('stale'); expect(text).toContain('quota units (unit not reported)');
  expect(text).toContain('&lt;quota&gt;'); expect(text).not.toContain('exhausted');
});

test('mobile discards late quota responses after profile changes and renders failures as unavailable', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let resolve!: (response: unknown) => void;
  const client = { getCopilotQuota: jest.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
    .mockResolvedValueOnce({ quota: { status: 'available', rows: [{ id: 'b', label: 'Account B', used: 7, entitlement: 10, unit: 'premium_requests' }], stale: false } })
    .mockRejectedValueOnce(new Error('offline')) };
  try {
    await act(async () => root.render(createElement(CopilotQuota, { client, profileId: 'a', refreshKey: 1 })));
    await act(async () => root.render(createElement(CopilotQuota, { client, profileId: 'b', refreshKey: 1 })));
    await act(async () => resolve({ quota: { status: 'available', rows: [{ label: 'Account A' }] } }));
    expect(container.textContent).toContain('Account B'); expect(container.textContent).not.toContain('Account A');
    await act(async () => root.render(createElement(CopilotQuota, { client, profileId: 'b', refreshKey: 2 })));
    expect(container.textContent).toContain('Unavailable'); expect(container.textContent).not.toContain('Account B');
  } finally { await act(async () => root.unmount()); container.remove(); }
});
