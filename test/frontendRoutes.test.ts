import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(__dirname, '..');

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function makeRequest(server: http.Server, urlPath: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as { port: number }).port;
    const req = http.request({
      method: 'GET',
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      headers: { host: 'localhost' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(app: express.Express, fn: (server: http.Server) => Promise<void>): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function ensureV2BuildForStaticRouteTest(): string {
  const buildDir = path.join(ROOT, 'public', 'v2-built');
  if (!fs.existsSync(path.join(buildDir, 'index.html'))) {
    execFileSync('npm', ['run', 'web:build'], { cwd: ROOT, stdio: 'pipe' });
  }
  return buildDir;
}

function ensureMobileBuildForStaticRouteTest(): string {
  const buildDir = path.join(ROOT, 'public', 'mobile-built');
  if (!fs.existsSync(path.join(buildDir, 'index.html'))) {
    execFileSync('npm', ['run', 'mobile:build'], { cwd: ROOT, stdio: 'pipe' });
  }
  return buildDir;
}

describe('frontend routes', () => {
  test('server routing keeps / as V2 redirect and removes /legacy redirect', () => {
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');
    expect(serverSrc).toContain("app.get('/', (_req: Request, res: Response): void => { res.redirect('/v2/'); });");
    expect(serverSrc).not.toMatch(/app\.get\(\s*\[\s*['"]\/legacy['"]/);
    expect(serverSrc).not.toContain("res.redirect('/index.html')");
  });

  test('mobile PWA keeps iOS viewport and modal sheet content reachable', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/App.tsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/styles.css'), 'utf8');

    expect(appSrc).toContain("root.style.setProperty('--app-top'");
    expect(appSrc).toContain("root.style.setProperty('--app-left'");
    expect(appSrc).toContain("root.style.setProperty('--app-width'");
    expect(appSrc).toContain('viewport?.offsetTop');
    expect(appSrc).toContain('viewport?.offsetLeft');
    expect(appSrc).toContain('viewport?.width');
    expect(appSrc).toContain('lastViewportMetrics');
    expect(appSrc).toContain('Math.round(viewport?.offsetTop || 0)');
    expect(appSrc).toContain('if (metrics !== lastViewportMetrics)');
    expect(appSrc).toContain('if (root.scrollLeft !== 0) root.scrollLeft = 0');
    expect(appSrc).toContain('window.scrollTo(0, 0)');
    expect(appSrc).toContain("window.addEventListener('scroll', scheduleUpdate)");
    expect(appSrc).toContain("document.addEventListener('focusin', scheduleFocusUpdate)");
    expect(appSrc).toContain("document.addEventListener('focusout', scheduleFocusUpdate)");
    expect(cssSrc).toMatch(/\.app-shell \{[\s\S]*top: var\(--app-top, 0px\);/);
    expect(cssSrc).toMatch(/\.app-shell \{[\s\S]*left: var\(--app-left, 0px\);/);
    expect(cssSrc).toMatch(/\.app-shell \{[\s\S]*width: var\(--app-width, 100vw\);/);
    expect(cssSrc).toMatch(/\.modal-backdrop \{[\s\S]*top: var\(--app-top, 0px\);/);
    expect(cssSrc).toMatch(/\.modal-backdrop \{[\s\S]*left: var\(--app-left, 0px\);/);
    expect(cssSrc).toMatch(/textarea, input \{[\s\S]*font-size: 16px;/);
    expect(cssSrc).toMatch(/\.editor \{[\s\S]*font-size: 16px;/);
    expect(appSrc).toContain('className="modal-scroll run-settings-scroll"');
    expect(cssSrc).toMatch(/\.run-settings-scroll \{[\s\S]*padding-bottom: calc\(16px \+ env\(safe-area-inset-bottom\)\);/);
    expect(cssSrc).toMatch(/\.filter-select \{[\s\S]*flex: 1 1 100%;/);
    expect(cssSrc).toMatch(/\.filter-select select \{[\s\S]*max-width: 100%;/);
  });

  test('mobile PWA treats stream socket loss as reconnectable', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/App.tsx'), 'utf8');

    expect(appSrc).toContain('const STREAM_RECONNECT_BASE_MS');
    expect(appSrc).toContain('const STREAM_RECONNECT_MAX_MS');
    expect(appSrc).toContain('streamReconnectTimerRef');
    expect(appSrc).toContain('resumeStreamConnectionRef');
    expect(appSrc).toContain('function scheduleStreamReconnect');
    expect(appSrc).toContain('async function resumeStreamConnection');
    expect(appSrc).toContain("window.addEventListener('online', resumeVisibleStream)");
    expect(appSrc).toContain("document.addEventListener('visibilitychange', resumeVisibleStream)");
    expect(appSrc).toContain('void resumeStreamConnectionRef.current(conversationID, true)');
    expect(appSrc).toContain('void resumeStreamConnectionRef.current(conversationID)');
    expect(appSrc).toContain('socket.onerror = () =>');
    expect(appSrc).toContain('scheduleStreamReconnect(conversationID)');
    expect(appSrc).toContain('clientRef.current.getActiveStreams()');
    expect(appSrc).not.toContain("socket.onerror = () => setErrorMessage('Stream connection failed.')");
  });

  test('memory update notifications open the focused memory-update modal first', () => {
    const shellSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/shell.jsx'), 'utf8');
    const workspaceSettingsSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/workspaceSettings.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');

    expect(shellSrc).toContain('MemoryUpdateModal');
    expect(shellSrc).toContain('onOpenMemoryUpdate(conv.workspaceHash, wsLabel, entry.message.memoryUpdate || null)');
    expect(shellSrc).toContain('WorkspaceSettingsPage');
    expect(workspaceSettingsSrc).toContain('function MemoryUpdateModal');
    expect(workspaceSettingsSrc).toContain('export function MemoryUpdateModal');
    expect(workspaceSettingsSrc).toContain('View all memory items');
    expect(cssSrc).toContain('.mu-panel');
  });

  test('workspace memory panel exposes search and lifecycle filters', () => {
    const apiSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/api.js'), 'utf8');
    const workspaceSettingsSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/workspaceSettings.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');

    expect(apiSrc).toContain('searchMemory: (hash, opts) =>');
    expect(apiSrc).toContain('proposeMemoryConsolidation: (hash) =>');
    expect(apiSrc).toContain('draftMemoryConsolidation: (hash, action) =>');
    expect(apiSrc).toContain('applyMemoryConsolidation: (hash, payload) =>');
    expect(apiSrc).toContain('applyMemoryConsolidationDraft: (hash, payload) =>');
    expect(apiSrc).toContain('getMemoryReviewSchedule: (hash) =>');
    expect(apiSrc).toContain('startMemoryReview: (hash) =>');
    expect(apiSrc).toContain('restoreMemoryEntry: (hash, relPath) =>');
    expect(apiSrc).toContain("'/memory/search' + qs");
    expect(workspaceSettingsSrc).toContain("placeholder=\"Search memory\"");
    expect(workspaceSettingsSrc).toContain('Start new review');
    expect(workspaceSettingsSrc).toContain('Review running...');
    expect(workspaceSettingsSrc).toContain('Audit Current Review');
    expect(workspaceSettingsSrc).toContain('MemoryReviewSettingsProgress');
    expect(workspaceSettingsSrc).toContain('Last run');
    expect(workspaceSettingsSrc).toContain('formatSettingsMemoryReviewSource');
    expect(workspaceSettingsSrc).not.toContain('Minimum gap');
    expect(workspaceSettingsSrc).toContain('function MemoryReviewScheduleEditor');
    expect(workspaceSettingsSrc).toContain('function MemoryConsolidationReview');
    expect(workspaceSettingsSrc).toContain('function MemoryConsolidationDraftReview');
    expect(workspaceSettingsSrc).toContain('Apply draft');
    expect(workspaceSettingsSrc).toContain('Restore entry');
    expect(workspaceSettingsSrc).toContain('ws-mem-draft-compare');
    expect(workspaceSettingsSrc).toContain('MEMORY_STATUS_LABELS');
    expect(workspaceSettingsSrc).toContain('MEMORY_ALL_STATUSES');
    expect(workspaceSettingsSrc).toContain('Filter memory state');
    expect(cssSrc).toContain('.ws-mem-controls');
    expect(cssSrc).toContain('.ws-mem-schedule');
    expect(cssSrc).toContain('.ws-mem-review-last');
    expect(cssSrc).toContain('.ws-mem-review-progress');
    expect(cssSrc).toContain('.ws-mem-status');
  });

  test('context map settings expose global and workspace controls', () => {
    const apiSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/api.js'), 'utf8');
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/screens/settingsScreen.jsx'), 'utf8');
    const workspaceSettingsSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/workspaceSettings.jsx'), 'utf8');
    const shellSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/shell.jsx'), 'utf8');
    const streamStoreSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/streamStore.js'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');

    expect(apiSrc).toContain('getContextMapSettings: (hash) =>');
    expect(apiSrc).toContain('getContextMapReview: (hash, status) =>');
    expect(apiSrc).toContain('getContextMapGraph: (hash, opts) =>');
    expect(apiSrc).toContain('getContextMapEntity: (hash, entityId) =>');
    expect(apiSrc).toContain('updateContextMapEntity: (hash, entityId, entity) =>');
    expect(apiSrc).toContain('setContextMapEnabled: (hash, enabled) =>');
    expect(apiSrc).toContain('setContextMapSettings: (hash, settings) =>');
    expect(apiSrc).toContain('runContextMapScan: (hash) =>');
    expect(apiSrc).toContain('stopContextMapScan: (hash) =>');
    expect(apiSrc).toContain('clearContextMap: (hash) =>');
    expect(apiSrc).toContain('updateContextMapCandidate: (hash, candidateId, payload) =>');
    expect(apiSrc).toContain('applyContextMapCandidate: (hash, candidateId, opts) =>');
    expect(apiSrc).toContain('discardContextMapCandidate: (hash, candidateId) =>');
    expect(apiSrc).toContain('reopenContextMapCandidate: (hash, candidateId) =>');
    expect(settingsSrc).toContain("{ id: 'contextMap', label: 'Context Map' }");
    expect(settingsSrc).toContain('function SettingsContextMapTab');
    expect(settingsSrc).toContain('Context Map CLI profile');
    expect(settingsSrc).toContain('Concurrent Workspace Scans');
    expect(settingsSrc).toContain('Processor concurrency');
    expect(settingsSrc).toContain('settings-help-btn');
    expect(settingsSrc).toContain('extractionConcurrency: concurrency');
    expect(settingsSrc).toContain('synthesisConcurrency: concurrency');
    expect(settingsSrc).not.toContain('Extraction concurrency');
    expect(settingsSrc).not.toContain('Synthesis concurrency');
    expect(settingsSrc).not.toContain('CONTEXT_MAP_SOURCE_OPTIONS');
    expect(workspaceSettingsSrc).toContain("{ id: 'contextMap',   label: 'Context Map' }");
    expect(workspaceSettingsSrc).toContain('function WorkspaceSettingsPage');
    expect(workspaceSettingsSrc).toContain('export function WorkspaceSettingsPage');
    expect(workspaceSettingsSrc).toContain('className="settings-shell workspace-settings-shell"');
    expect(workspaceSettingsSrc).toContain('className="settings-tabs"');
    expect(workspaceSettingsSrc).toContain('className="settings-form settings-form-wide ws-form"');
    expect(workspaceSettingsSrc).toContain("className={`settings-tab ${tab === t.id ? 'active' : ''}`}");
    expect(workspaceSettingsSrc).not.toContain('fp-panel ws-panel');
    expect(workspaceSettingsSrc).not.toContain('window.WorkspaceSettingsModal');
    expect(workspaceSettingsSrc).toContain('function ContextMapTab');
    expect(workspaceSettingsSrc).toContain('ac:context-map-update');
    expect(workspaceSettingsSrc).toContain('Context Map settings sections');
    expect(workspaceSettingsSrc).toContain('ws-cm-panel-overview');
    expect(workspaceSettingsSrc).toContain('ws-cm-metrics');
    expect(workspaceSettingsSrc).toContain('ws-cm-insights');
    expect(workspaceSettingsSrc).toContain('Most connected');
    expect(workspaceSettingsSrc).toContain('ws-cm-status-badge');
    expect(workspaceSettingsSrc).toContain('Enable Context Map for this workspace');
    expect(workspaceSettingsSrc).toContain('Initial scan started');
    expect(workspaceSettingsSrc).toContain('Keep rolling');
    expect(workspaceSettingsSrc).toContain('Initial scan completed');
    expect(workspaceSettingsSrc).toContain('nextContextMapInitialScanNotice');
    expect(workspaceSettingsSrc).toContain("contextMapInitialScanNotice === 'started'");
    expect(workspaceSettingsSrc).toContain('ws-cm-initial-scan');
    expect(workspaceSettingsSrc).toContain('ws-cm-stop-scan');
    expect(workspaceSettingsSrc).toContain('onStopScan');
    expect(workspaceSettingsSrc).toContain('Stop');
    expect(workspaceSettingsSrc).toContain('Use global defaults');
    expect(workspaceSettingsSrc).toContain('ws-cm-readonly-list');
    expect(workspaceSettingsSrc).toContain('Scan interval override (minutes)');
    expect(workspaceSettingsSrc).toContain('Save Changes');
    expect(workspaceSettingsSrc).not.toContain('WS_CONTEXT_MAP_SOURCE_OPTIONS');
    expect(workspaceSettingsSrc).not.toContain('ws-cm-source-grid');
    expect(workspaceSettingsSrc).toContain('Active Map');
    expect(workspaceSettingsSrc).toContain('Nearby context');
    expect(workspaceSettingsSrc).toContain('ws-cm-nearby');
    expect(workspaceSettingsSrc).toContain('Search entities');
    expect(workspaceSettingsSrc).toContain('All types');
    expect(workspaceSettingsSrc).toContain('All statuses');
    expect(workspaceSettingsSrc).toContain('All sensitivity');
    expect(workspaceSettingsSrc).toContain('refreshGraphWithFilters');
    expect(workspaceSettingsSrc).toContain("getContextMapReview(hash, 'pending')");
    expect(workspaceSettingsSrc).toContain('Run initial scan');
    expect(workspaceSettingsSrc).toContain('Rescan now');
    expect(workspaceSettingsSrc).toContain('Rescan now help');
    expect(workspaceSettingsSrc).toContain('Starts a full Context Map rescan for this workspace');
    expect(workspaceSettingsSrc).toContain('runScanFromContextMap');
    expect(workspaceSettingsSrc).toContain('scrollContextMapTopIntoView');
    expect(workspaceSettingsSrc).toContain('contextMapContentRef');
    expect(workspaceSettingsSrc).toContain("contentNode.scrollTo({ top: 0, behavior: 'smooth' })");
    expect(workspaceSettingsSrc).toContain('Context Map scan started');
    expect(workspaceSettingsSrc).not.toContain('ws-cm-advanced');
    expect(workspaceSettingsSrc).toContain('Last scan');
    expect(workspaceSettingsSrc).toContain("id=\"ws-cm-panel-overview\"");
    expect(workspaceSettingsSrc).toContain("id=\"ws-cm-panel-active\"");
    expect(workspaceSettingsSrc).toContain('runSourceLabel');
    expect(workspaceSettingsSrc).toContain("onReviewStatusChange('discarded')");
    expect(workspaceSettingsSrc).toContain('No dismissed Context Map items.');
    expect(workspaceSettingsSrc).toContain('Needs Attention');
    expect(workspaceSettingsSrc).toContain('No Context Map items need attention.');
    expect(workspaceSettingsSrc).toContain('Clear Context Map');
    expect(workspaceSettingsSrc).toContain('clearContextMap');
    expect(workspaceSettingsSrc).toContain('loadContextMapEntity');
    expect(workspaceSettingsSrc).toContain('updateContextMapEntity');
    expect(workspaceSettingsSrc).toContain('selectedEntityId');
    expect(workspaceSettingsSrc).toContain('className="ws-mem-review-btn ws-cm-details-btn"');
    expect(workspaceSettingsSrc).toContain('className="ws-cm-detail-modal"');
    expect(workspaceSettingsSrc).toContain('aria-modal="true"');
    expect(workspaceSettingsSrc).toContain('ws-context-map-entity-detail');
    expect(workspaceSettingsSrc).toContain('Loading...');
    expect(workspaceSettingsSrc).toContain('applyAllContextMapCandidates');
    expect(workspaceSettingsSrc).toContain('Accept All');
    expect(workspaceSettingsSrc).toContain('compareContextMapCandidateApplyOrder');
    expect(workspaceSettingsSrc).toContain("includeDependencies: true");
    expect(workspaceSettingsSrc).toContain('Save entity');
    expect(workspaceSettingsSrc).toContain('Facts');
    expect(workspaceSettingsSrc).toContain('Evidence');
    expect(workspaceSettingsSrc).toContain('Relationship Neighborhood');
    expect(workspaceSettingsSrc).toContain('ws-cm-neighborhood');
    expect(workspaceSettingsSrc).toContain('onRunScan');
    expect(workspaceSettingsSrc).toContain('onUpdateCandidate');
    expect(workspaceSettingsSrc).toContain('Save edit');
    expect(workspaceSettingsSrc).toContain('contextMapCandidateImpactPreview');
    expect(workspaceSettingsSrc).toContain('ws-cm-candidate-impact');
    expect(workspaceSettingsSrc).toContain('onApplyCandidate');
    expect(workspaceSettingsSrc).toContain('Apply related Context Map items?');
    expect(workspaceSettingsSrc).toContain('includeDependencies: true');
    expect(workspaceSettingsSrc).toContain('onDiscardCandidate');
    expect(workspaceSettingsSrc).toContain('ws-cm-candidates');
    expect(workspaceSettingsSrc).toContain('candidateGroups.map');
    expect(workspaceSettingsSrc).toContain('File ·');
    expect(workspaceSettingsSrc).toContain('Danger Zone');
    expect(shellSrc).toContain('ComposerContextMapIcon');
    expect(shellSrc).toContain("onOpenWorkspaceSettings(conv.workspaceHash, workspaceLabel || 'workspace', 'contextMap')");
    expect(shellSrc).toContain('<WorkspaceSettingsPage');
    expect(shellSrc).not.toContain('<WorkspaceSettingsModal');
    expect(streamStoreSrc).toContain("frame.type === 'context_map_update'");
    expect(streamStoreSrc).toContain('ac:context-map-update');
    expect(cssSrc).not.toContain('.ws-cm-source-grid');
    expect(cssSrc).toContain('.settings-form.ws-form-context-map');
    expect(cssSrc).toContain('.ws-actions{\n  display: flex;\n  justify-content: flex-end;\n  align-items: center;\n  gap: 10px;');
    expect(cssSrc).toContain('.ws-cm-layout');
    expect(cssSrc).toContain('.ws-cm-rail');
    expect(cssSrc).toContain('.ws-cm-content');
    expect(cssSrc).toContain('.ws-cm-metrics');
    expect(cssSrc).toContain('.ws-cm-insights');
    expect(cssSrc).toContain('.ws-cm-insight-card');
    expect(cssSrc).toContain('.ws-cm-readonly-list');
    expect(cssSrc).toContain('.ws-cm-save-row');
    expect(cssSrc).toContain('.ws-cm-initial-scan');
    expect(cssSrc).toContain('@keyframes wsCmScanPulse');
    expect(cssSrc).toContain('.ws-cm-entity-grid');
    expect(cssSrc).toContain('.ws-cm-entity-card.is-selected');
    expect(cssSrc).toContain('.ws-cm-details-btn');
    expect(cssSrc).toContain('.ws-cm-detail-modal');
    expect(cssSrc).toContain('.ws-cm-detail-panel');
    expect(cssSrc).toContain('.ws-cm-detail');
    expect(cssSrc).toContain('.ws-cm-entity-edit');
    expect(cssSrc).toContain('.ws-cm-graph-controls');
    expect(cssSrc).toContain('.ws-cm-nearby');
    expect(cssSrc).toContain('.ws-cm-neighborhood');
    expect(cssSrc).toContain('.ws-cm-run-status');
    expect(cssSrc).toContain('.ws-cm-head-actions');
    expect(cssSrc).toContain('.ws-cm-review-tools');
    expect(cssSrc).toContain('.ws-cm-danger-block');
    expect(cssSrc).not.toContain('.ws-cm-advanced');
    expect(cssSrc).toContain('.ws-cm-rescan-help');
    expect(cssSrc).toContain('.ws-cm-candidate-edit');
    expect(cssSrc).toContain('.ws-cm-candidate-impact');
    expect(cssSrc).toContain('.ws-cm-dependency-confirm');
    expect(cssSrc).toContain('.ws-cm-candidate-group');
    expect(cssSrc).toContain('.ws-cm-candidates');
    expect(cssSrc).toContain('.composer-notif.state-context-map');
  });

  test('Memory Review has a dedicated page and composer notification action', () => {
    const shellSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/shell.jsx'), 'utf8');
    const reviewSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/screens/memoryReview.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');

    expect(shellSrc).toContain("./screens/memoryReview.jsx");
    expect(shellSrc).toContain('MemoryReviewPage');
    expect(shellSrc).toContain('ComposerMemoryReviewIcon');
    expect(shellSrc).toContain('onOpenMemoryReview(conv.workspaceHash');
    expect(shellSrc).not.toContain('Run now');
    expect(reviewSrc).toContain('export function MemoryReviewPage');
    expect(reviewSrc).toContain('MemoryReviewInlineProgress');
    expect(reviewSrc).toContain('MemoryReviewButtonProgress');
    expect(reviewSrc).toContain('buildMemoryReviewLineDiff');
    expect(reviewSrc).toContain('MemoryReviewDiffPane');
    expect(reviewSrc).toContain('Edit markdown');
    expect(reviewSrc).toContain('mr-edit-textarea');
    expect(reviewSrc).toContain('buildReviewedDraft');
    expect(reviewSrc).toContain('Generating draft review...');
    expect(reviewSrc).toContain('No open review items.');
    expect(reviewSrc).toContain('MemoryReviewButtonProgress label="Applying..."');
    expect(reviewSrc).toContain('Applied');
    expect(reviewSrc).toContain('applyDone={!!applyDone[item.id]}');
    expect(reviewSrc).toContain("busy && !applyBusy");
    expect(reviewSrc).toContain('!applyBusy && !regenerateBusy');
    expect(reviewSrc).toContain('Regenerating draft...');
    expect(reviewSrc).toContain('Regenerated');
    expect(reviewSrc).toContain('Dismissed from this review');
    expect(reviewSrc).toContain('applyMemoryReviewDraft');
    expect(reviewSrc).toContain('discardMemoryReviewAction');
    expect(cssSrc).toContain('.main-memory-review');
    expect(cssSrc).toContain('.mr-progress');
    expect(cssSrc).toContain('.mr-btn-success');
    expect(cssSrc).toContain('.mr-item-note');
    expect(cssSrc).toContain('.mr-code-line.is-changed');
    expect(cssSrc).toContain('.mr-edit-textarea');
    expect(cssSrc).toContain('.state-memory-review');
  });

  test('V2 frontend uses module imports instead of app-local window globals', () => {
    const srcRoot = path.join(ROOT, 'web/AgentCockpitWeb/src');
    const mainSrc = fs.readFileSync(path.join(srcRoot, 'main.jsx'), 'utf8');
    const shellSrc = fs.readFileSync(path.join(srcRoot, 'shell.jsx'), 'utf8');
    const viteConfig = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/vite.config.ts'), 'utf8');
    const files = fs.readdirSync(srcRoot, { recursive: true })
      .filter((entry) => /\.(js|jsx|ts|tsx)$/.test(String(entry)))
      .map((entry) => path.join(srcRoot, String(entry)));
    const appGlobalAssignment = /window\.(React|ReactDOM|AgentApi|StreamStore|PlanUsageStore|KiroPlanUsageStore|CodexPlanUsageStore|CliUpdateStore|UsageProjection|SynthesisAtlas|getChipRenderer|Ico|Sidebar|KbBrowser|FilesBrowser|SettingsScreen|MemoryReviewPage|WorkspaceSettingsPage|MemoryUpdateModal|FolderPicker|SessionsModal|UpdateModal|RestartOverlay|Dialog|DialogProvider|useDialog|ToastProvider|useToasts|Tip|useTip|FileLinkUtils|TabIndicator|marked|DOMPurify|hljs)\s*=/;

    for (const file of files) {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(appGlobalAssignment);
    }
    expect(mainSrc).toContain("import './shell.jsx'");
    expect(mainSrc).not.toContain('await import(');
    expect(shellSrc).toContain("React.lazy(() => import('./screens/kbBrowser.jsx')");
    expect(shellSrc).toContain("React.lazy(() => import('./workspaceSettings.jsx')");
    expect(viteConfig).toContain('codeSplitting');
    expect(viteConfig).toContain('react-vendor');
    expect(viteConfig).toContain('markdown-vendor');
  });

  test('retired public/v2 tree keeps only ADR placeholder paths', () => {
    const publicV2Files: string[] = [];
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(abs);
        else if (entry.isFile()) publicV2Files.push(path.relative(ROOT, abs).split(path.sep).join('/'));
      }
    };
    visit(path.join(ROOT, 'public/v2'));

    expect(publicV2Files.sort()).toEqual([
      'public/v2/README.md',
      'public/v2/index.html',
      'public/v2/src/api.js',
      'public/v2/src/app.css',
      'public/v2/src/cliUpdateStore.js',
      'public/v2/src/screens/kbBrowser.jsx',
      'public/v2/src/screens/memoryReview.jsx',
      'public/v2/src/screens/settingsScreen.jsx',
      'public/v2/src/shell.jsx',
      'public/v2/src/streamStore.js',
      'public/v2/src/synthesisAtlas.js',
      'public/v2/src/workspaceSettings.jsx',
    ]);
    expect(fs.readFileSync(path.join(ROOT, 'public/v2/src/shell.jsx'), 'utf8')).toContain('Path retained for historical ADR affects validation');
  });

  test('kb raw tab explains structure backfill and exposes bulk redigest controls', () => {
    const kbBrowserSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/screens/kbBrowser.jsx'), 'utf8');

    expect(kbBrowserSrc).toContain('function KbBackfillStructureTip');
    expect(kbBrowserSrc).toContain('Builds missing document-shape records');
    expect(kbBrowserSrc).toContain('Redigest Folder');
    expect(kbBrowserSrc).toContain('Redigest Selected');
    expect(kbBrowserSrc).toContain('Select Visible');
    expect(kbBrowserSrc).toContain('AgentApi.kb.getState(hash, { folder: currentFolder, limit: 100000 })');
  });

  test('kb pipeline marks queued digest work as waiting', () => {
    const kbBrowserSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/screens/kbBrowser.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');

    expect(kbBrowserSrc).toContain('const digestQueueWaiting = awaitingDigestCount > 0 && !digestProgress && digestingCount === 0');
    expect(kbBrowserSrc).toContain("digestQueueWaiting ? 'wait'");
    expect(kbBrowserSrc).toContain('status={digestStageStatus}');
    expect(cssSrc).toContain('.ps-stage-state[data-status="wait"]');
    expect(cssSrc).toContain('.pn[data-status="wait"]');
    expect(cssSrc).toContain('.pn-dot[data-status="wait"]');
  });

  test('kb pipeline marks queued dream work as waiting', () => {
    const kbBrowserSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/screens/kbBrowser.jsx'), 'utf8');

    expect(kbBrowserSrc).toContain('const dreamQueueWaiting = needsSynthesisCount > 0 && !dreamActive');
    expect(kbBrowserSrc).toContain("dreamQueueWaiting ? 'wait'");
    expect(kbBrowserSrc).toContain('dreamQueueLabel');
    expect(kbBrowserSrc).toContain('awaiting Dream');
  });

  test('kb entries and reflections use side readers instead of tab popups', () => {
    const kbBrowserSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/screens/kbBrowser.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');

    expect(kbBrowserSrc).toContain('function KbEntryReader');
    expect(kbBrowserSrc).toContain('function KbReflectionReader');
    expect(kbBrowserSrc).toContain('selectedEntryId ? (');
    expect(kbBrowserSrc).toContain('selectedReflectionId ? (');
    expect(kbBrowserSrc).toContain('className="kb-split reader-mode"');
    expect(kbBrowserSrc).not.toContain('function KbEntryModal');
    expect(kbBrowserSrc).not.toContain('function KbReflectionModal');
    expect(cssSrc).toContain('.kb-split.reader-mode .kb-split-left');
  });

  test('kb synthesis tab does not expose the removed atlas mode', () => {
    const kbBrowserSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/screens/kbBrowser.jsx'), 'utf8');

    expect(kbBrowserSrc).not.toContain('Atlas</button>');
    expect(kbBrowserSrc).not.toContain('kb-synth-view');
    expect(kbBrowserSrc).not.toContain('function KbSynthesisAtlas');
    expect(kbBrowserSrc).not.toContain('function KbBridgeDetail');
    expect(kbBrowserSrc).not.toContain('function KbClusterDetail');
  });

  test('kb settings uses an internal left-tab layout for settings sections', () => {
    const kbBrowserSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/screens/kbBrowser.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');

    expect(kbBrowserSrc).toContain("const [settingsSection, setSettingsSection] = React.useState('auto-dream')");
    expect(kbBrowserSrc).toContain('className="kb-settings-rail" role="tablist"');
    expect(kbBrowserSrc).toContain('className="kb-settings-content"');
    expect(kbBrowserSrc).toContain("settingsSection === 'auto-dream'");
    expect(kbBrowserSrc).toContain("settingsSection === 'glossary'");
    expect(kbBrowserSrc).toContain("settingsSection === 'embedding'");
    expect(cssSrc).toContain('.kb-settings-layout');
    expect(cssSrc).toContain('.kb-settings-rail');
    expect(cssSrc).toContain('.kb-settings-nav.active');
  });

  test('desktop sidebar uses a workspace filter instead of workspace grouping', () => {
    const primitivesSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/primitives.jsx'), 'utf8');
    const shellSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/shell.jsx'), 'utf8');
    const folderPickerSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/folderPicker.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');

    expect(primitivesSrc).toContain('const ALL_WORKSPACES');
    expect(primitivesSrc).toContain('All Workspaces');
    expect(primitivesSrc).toContain('selectedWorkspaceKey === ALL_WORKSPACES');
    expect(primitivesSrc).toContain('sortConvsByActivity(filtered)');
    expect(primitivesSrc).toContain('activeConversationWorkspace');
    expect(primitivesSrc).toContain('active conversation');
    expect(primitivesSrc).toContain('newConversationInitialPath');
    expect(primitivesSrc).toContain('onNewConversation(newConversationInitialPath)');
    expect(shellSrc).toContain('folderPickerInitialPath');
    expect(shellSrc).toContain('initialPath={folderPickerInitialPath}');
    expect(folderPickerSrc).toContain("function FolderPicker({ open, initialPath = ''");
    expect(folderPickerSrc).toContain("load(initialPath || '')");
    expect(primitivesSrc).not.toContain('function groupByWorkspace');
    expect(cssSrc).toContain('.sb-workspace-filter');
    expect(cssSrc).toContain('.sb-row .workspace');
    expect(cssSrc).not.toContain('.sb-ws{');
  });

  test('static frontend surface serves V2 and leaves removed assets unavailable', async () => {
    const v2BuildDir = ensureV2BuildForStaticRouteTest();
    const mobileBuildDir = ensureMobileBuildForStaticRouteTest();
    const app = express();
    app.get('/', (_req, res) => { res.redirect('/v2/'); });
    app.use('/v2/src', (_req, res) => { res.status(404).send('Not found'); });
    app.use('/v2', express.static(v2BuildDir));
    app.get('/v2/*', (_req, res) => {
      res.sendFile(path.join(v2BuildDir, 'index.html'));
    });
    app.use('/mobile', express.static(mobileBuildDir));
    app.use(express.static(path.join(ROOT, 'public')));

    await withServer(app, async (server) => {
      const root = await makeRequest(server, '/');
      expect(root.status).toBe(302);
      expect(root.headers.location).toBe('/v2/');

      const v2 = await makeRequest(server, '/v2/');
      expect(v2.status).toBe(200);
      expect(v2.headers['content-type']).toMatch(/text\/html/);
      expect(v2.body).toContain('<div id="root"');
      expect(v2.body).toContain('type="module"');
      expect(v2.body).toMatch(/\/v2\/assets\/index-[A-Za-z0-9_-]+\.js/);
      expect(v2.body).toMatch(/\/v2\/assets\/index-[A-Za-z0-9_-]+\.css/);

      const v2AssetMatch = v2.body.match(/\/v2\/assets\/index-[A-Za-z0-9_-]+\.js/);
      expect(v2AssetMatch).not.toBeNull();
      const v2Asset = await makeRequest(server, v2AssetMatch![0]);
      expect(v2Asset.status).toBe(200);
      expect(v2Asset.headers['content-type']).toMatch(/javascript/);

      const rawV2Source = await makeRequest(server, '/v2/src/shell.jsx');
      expect(rawV2Source.status).toBe(404);

      const mobile = await makeRequest(server, '/mobile/');
      expect(mobile.status).toBe(200);
      expect(mobile.headers['content-type']).toMatch(/text\/html/);
      expect(mobile.body).toContain('<div id="root"');
      expect(mobile.body).toContain('Agent Cockpit Mobile');
      expect(mobile.body).toContain('/mobile/manifest.webmanifest');
      expect(mobile.body).toContain('/mobile/apple-touch-icon.png');
      expect(mobile.body).toContain('/mobile/icon-192.png');
      expect(mobile.body).toMatch(/\/mobile\/assets\/index-[A-Za-z0-9_-]+\.js/);

      const manifest = await makeRequest(server, '/mobile/manifest.webmanifest');
      expect(manifest.status).toBe(200);
      expect(manifest.headers['content-type']).toMatch(/application\/manifest\+json|application\/octet-stream|application\/json/);
      expect(manifest.body).toContain('"start_url": "/mobile/"');
      expect(manifest.body).toContain('"src": "/mobile/icon-192.png"');
      expect(manifest.body).toContain('"src": "/mobile/icon-512.png"');

      const appleTouchIcon = await makeRequest(server, '/mobile/apple-touch-icon.png');
      expect(appleTouchIcon.status).toBe(200);
      expect(appleTouchIcon.headers['content-type']).toMatch(/image\/png/);

      const mobileAdrPlaceholder = await makeRequest(server, '/mobile/.adr-placeholder');
      expect(mobileAdrPlaceholder.status).toBe(404);

      const v2Fallback = await makeRequest(server, '/v2/deck.html');
      expect(v2Fallback.status).toBe(200);
      expect(v2Fallback.headers['content-type']).toMatch(/text\/html/);
      expect(v2Fallback.body).toContain('<div id="root"');

      for (const removedPath of ['/legacy/', '/index.html', '/styles.css', '/js/main.js']) {
        const res = await makeRequest(server, removedPath);
        expect(res.status).toBe(404);
      }
    });
  });
});
