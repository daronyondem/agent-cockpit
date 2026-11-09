/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Usage } from '../src/contracts/responses';
import { isUsageCostUnavailable, usageTokenTotal } from '../src/contracts/usagePresentation';
import { loadFrontendModule, loadMobileModule } from './mobileModuleLoader';

const contract = { isUsageCostUnavailable, usageTokenTotal };
const react = { react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime') };
const copilotDesktop = loadFrontendModule('web/AgentCockpitWeb/src/chat/copilotUsage.jsx', react);
const copilotMobile = loadMobileModule('copilotUsage.tsx', react);
const cortex = loadFrontendModule('web/AgentCockpitWeb/src/chat/cortexUsage.jsx', {
  ...react, '../../../../src/contracts/usagePresentation': contract,
});
const { getChipRenderer } = loadFrontendModule('web/AgentCockpitWeb/src/chip-renderers.jsx', {
  ...react, './usageProjection.ts': {}, './chat/grokBillingSection.jsx': {}, './chat/cortexUsage.jsx': cortex, './chat/copilotUsage.jsx': copilotDesktop,
  '../../../src/contracts/usagePresentation': contract,
});
const { UsageBar } = loadMobileModule('usageBar.tsx', {
  ...react, './copilotUsage': copilotMobile, './appModel': loadMobileModule('appModel.ts'), '../../../src/contracts/usagePresentation': contract,
});
const stats = loadFrontendModule('web/AgentCockpitWeb/src/screens/usageStats.js', { '../../../../src/contracts/usagePresentation': contract });
const usage: Usage = { inputTokens: 1200, outputTokens: 31, cacheReadTokens: 2300, cacheWriteTokens: 47,
  costUsd: 0, costSource: 'none', contextUsagePercentage: 12.5 };
let root: Root, container: HTMLDivElement;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); });
function values(selector: string) { return Array.from(container.querySelectorAll(selector)).map(node => node.textContent); }

test('desktop CoCo includes caches in the chip and displays exact counters, context and unavailable costs', async () => {
  const renderer = getChipRenderer('cortex-code');
  expect(renderer.renderChipText(usage)).toBe('12.50% context · 3.6k tokens · cost n/a');
  await act(async () => root.render(renderer.renderTooltipCard(usage)));
  expect(values('.tt-kv b')).toEqual(['12.50%', '1,200', '31', '2,300', '47', 'n/a', 'n/a']);
  expect(container.textContent).toContain('Snowflake pricing is unavailable');
  await act(async () => root.render(renderer.renderTooltipCard({ ...usage, contextUsagePercentage: undefined })));
  expect(values('.tt-kv b')[0]).toBe('n/a'); expect(container.querySelector('.tt-bar')).toBeNull();
  expect(renderer.renderChipText({ ...usage, contextUsagePercentage: undefined })).toBe('3.6k tokens · cost n/a');
  expect(renderer.renderChipText({ ...usage, contextUsagePercentage: 0 })).toContain('0.00% context');
});

test('mobile CoCo displays totals and a four-counter breakdown without fabricated zero prices', async () => {
  await act(async () => root.render(createElement(UsageBar, { usage, backend: 'cortex-code' })));
  expect(values('.usage-value')).toEqual(['3,578', 'n/a', 'n/a', '13%']);
  expect(values('.usage-breakdown dd')).toEqual(['1,200', '31', '2,300', '47']);
  expect(container.querySelector('summary')!.textContent).toBe('Token breakdown');
  expect(container.textContent).toContain('Costs exclude unpriced CoCo usage');
  await act(async () => root.render(createElement(UsageBar, { usage: { ...usage, costSource: undefined, contextUsagePercentage: undefined }, backend: 'cortex-code' })));
  expect(values('.usage-value')).toEqual(['3,578', 'n/a', 'n/a', 'n/a']);
  await act(async () => root.render(createElement(UsageBar, { backend: 'cortex-code' })));
  expect(container.textContent).toBe('');
});

test.each(['claude-code', 'claude-code-interactive', 'codex', 'kiro', 'grok-build'])('%s retains reported costs and rounded estimates on both clients', async backend => {
  const reported = { ...usage, costUsd: 0.1234, costSource: 'reported' as const };
  expect(getChipRenderer(backend).renderChipText(reported)).toContain('$0.1234');
  await act(async () => root.render(createElement(UsageBar, { usage: reported, backend })));
  expect(values('.usage-value')[1]).toBe('$0.1234');
  expect(values('.usage-value')[2]).toBe(backend === 'grok-build' ? 'n/a' : '$0');
  expect(container.querySelector('.usage-breakdown')).toBeNull();
  const estimated = { ...usage, costSource: 'estimated' as const, estimatedCostUsd: 1.23 };
  expect(getChipRenderer(backend).renderChipText(estimated)).toContain('est $2');
  await act(async () => root.render(createElement(UsageBar, { usage: estimated, backend })));
  expect(values('.usage-value')[2]).toBe('$2');
});

test('unavailable costs remain distinct from a reported zero, a priced estimate and legacy zero', () => {
  expect(usageTokenTotal(usage)).toBe(3578);
  expect(usageTokenTotal({})).toBe(0);
  expect(isUsageCostUnavailable(usage)).toBe(true);
  expect(isUsageCostUnavailable({ costSource: 'reported', costUsd: 0 })).toBe(false);
  expect(isUsageCostUnavailable({ costSource: 'reported', costUsd: 0 }, 'cortex-code')).toBe(false);
  expect(isUsageCostUnavailable({ costSource: 'estimated', estimatedCostUsd: 0 })).toBe(false);
  expect(isUsageCostUnavailable({})).toBe(false);
  expect(isUsageCostUnavailable({}, 'cortex-code')).toBe(true);
  expect(isUsageCostUnavailable({ ...usage, costUsd: 0.5 }, 'cortex-code')).toBe(false);
  expect(isUsageCostUnavailable({ ...usage, estimatedCostUsd: 0.5 }, 'cortex-code')).toBe(false);
});

test('ledger projections retain unknown CoCo costs alongside exact known totals and tier-specific rows', () => {
  const day = (records: any[]) => ({ date: '2026-11-07', records });
  const coco = { backend: 'cortex-code', model: 'claude-sonnet-4-6', usage };
  const known = { backend: 'codex', model: 'gpt-6', usage: { ...usage, costSource: 'estimated', estimatedCostUsd: 1.25 } };
  const days = [day([coco, known, { ...known, pricingTier: 'priority' }]), day([coco])];
  expect(stats.totalsFor(days)).toMatchObject({ inputTokens: 4800, cacheReadTokens: 9200, estimatedCostUsd: 2.5, hasUnpricedUsage: true });
  const rows = stats.aggregatePerModel(days);
  expect(rows).toHaveLength(3);
  expect(rows.find((row: any) => row.backend === 'cortex-code')).toMatchObject({ inputTokens: 2400, cacheWriteTokens: 94, hasUnpricedUsage: true, estimatedCostUsd: 0 });
  expect(rows.filter((row: any) => row.backend === 'codex').every((row: any) => !row.hasUnpricedUsage)).toBe(true);
  expect(stats.totalsFor([day([known])]).hasUnpricedUsage).toBe(false);
  expect(stats.totalsFor([]).hasUnpricedUsage).toBe(false);
});
