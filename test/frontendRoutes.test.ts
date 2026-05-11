import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';

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

describe('frontend routes', () => {
  test('server routing keeps / as V2 redirect and removes /legacy redirect', () => {
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');
    expect(serverSrc).toContain("app.get('/', (_req: Request, res: Response): void => { res.redirect('/v2/'); });");
    expect(serverSrc).not.toMatch(/app\.get\(\s*\[\s*['"]\/legacy['"]/);
    expect(serverSrc).not.toContain("res.redirect('/index.html')");
  });

  test('memory update notifications open the focused memory-update modal first', () => {
    const shellSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/shell.jsx'), 'utf8');
    const workspaceSettingsSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/workspaceSettings.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/app.css'), 'utf8');

    expect(shellSrc).toContain('MemoryUpdateModal');
    expect(shellSrc).toContain('onOpenMemoryUpdate(conv.workspaceHash, wsLabel, entry.message.memoryUpdate || null)');
    expect(shellSrc).toContain('WorkspaceSettingsPage');
    expect(workspaceSettingsSrc).toContain('function MemoryUpdateModal');
    expect(workspaceSettingsSrc).toContain('window.MemoryUpdateModal = MemoryUpdateModal');
    expect(workspaceSettingsSrc).toContain('View all memory items');
    expect(cssSrc).toContain('.mu-panel');
  });

  test('workspace memory panel exposes search and lifecycle filters', () => {
    const apiSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/api.js'), 'utf8');
    const workspaceSettingsSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/workspaceSettings.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/app.css'), 'utf8');

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
    const apiSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/api.js'), 'utf8');
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/screens/settingsScreen.jsx'), 'utf8');
    const workspaceSettingsSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/workspaceSettings.jsx'), 'utf8');
    const shellSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/shell.jsx'), 'utf8');
    const streamStoreSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/streamStore.js'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/app.css'), 'utf8');

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
    expect(workspaceSettingsSrc).toContain('window.WorkspaceSettingsPage = WorkspaceSettingsPage');
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
    const indexSrc = fs.readFileSync(path.join(ROOT, 'public/v2/index.html'), 'utf8');
    const shellSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/shell.jsx'), 'utf8');
    const reviewSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/screens/memoryReview.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/app.css'), 'utf8');

    expect(indexSrc).toContain('src/screens/memoryReview.jsx');
    expect(shellSrc).toContain('MemoryReviewPage');
    expect(shellSrc).toContain('ComposerMemoryReviewIcon');
    expect(shellSrc).toContain('onOpenMemoryReview(conv.workspaceHash');
    expect(shellSrc).not.toContain('Run now');
    expect(reviewSrc).toContain('window.MemoryReviewPage = MemoryReviewPage');
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

  test('kb raw tab explains structure backfill and exposes bulk redigest controls', () => {
    const kbBrowserSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/screens/kbBrowser.jsx'), 'utf8');

    expect(kbBrowserSrc).toContain('function KbBackfillStructureTip');
    expect(kbBrowserSrc).toContain('Builds missing document-shape records');
    expect(kbBrowserSrc).toContain('Redigest Folder');
    expect(kbBrowserSrc).toContain('Redigest Selected');
    expect(kbBrowserSrc).toContain('Select Visible');
    expect(kbBrowserSrc).toContain('AgentApi.kb.getState(hash, { folder: currentFolder, limit: 100000 })');
  });

  test('kb pipeline marks queued digest work as waiting', () => {
    const kbBrowserSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/screens/kbBrowser.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/app.css'), 'utf8');

    expect(kbBrowserSrc).toContain('const digestQueueWaiting = awaitingDigestCount > 0 && !digestProgress && digestingCount === 0');
    expect(kbBrowserSrc).toContain("digestQueueWaiting ? 'wait'");
    expect(kbBrowserSrc).toContain('status={digestStageStatus}');
    expect(cssSrc).toContain('.ps-stage-state[data-status="wait"]');
    expect(cssSrc).toContain('.pn[data-status="wait"]');
    expect(cssSrc).toContain('.pn-dot[data-status="wait"]');
  });

  test('kb pipeline marks queued dream work as waiting', () => {
    const kbBrowserSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/screens/kbBrowser.jsx'), 'utf8');

    expect(kbBrowserSrc).toContain('const dreamQueueWaiting = needsSynthesisCount > 0 && !dreamActive');
    expect(kbBrowserSrc).toContain("dreamQueueWaiting ? 'wait'");
    expect(kbBrowserSrc).toContain('dreamQueueLabel');
    expect(kbBrowserSrc).toContain('awaiting Dream');
  });

  test('kb entries and reflections use side readers instead of tab popups', () => {
    const kbBrowserSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/screens/kbBrowser.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/app.css'), 'utf8');

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
    const kbBrowserSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/screens/kbBrowser.jsx'), 'utf8');

    expect(kbBrowserSrc).not.toContain('Atlas</button>');
    expect(kbBrowserSrc).not.toContain('kb-synth-view');
    expect(kbBrowserSrc).not.toContain('function KbSynthesisAtlas');
    expect(kbBrowserSrc).not.toContain('function KbBridgeDetail');
    expect(kbBrowserSrc).not.toContain('function KbClusterDetail');
  });

  test('kb settings uses an internal left-tab layout for settings sections', () => {
    const kbBrowserSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/screens/kbBrowser.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/app.css'), 'utf8');

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
    const primitivesSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/primitives.jsx'), 'utf8');
    const shellSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/shell.jsx'), 'utf8');
    const folderPickerSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/folderPicker.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'public/v2/src/app.css'), 'utf8');

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
    const app = express();
    app.get('/', (_req, res) => { res.redirect('/v2/'); });
    app.use(express.static(path.join(ROOT, 'public')));

    await withServer(app, async (server) => {
      const root = await makeRequest(server, '/');
      expect(root.status).toBe(302);
      expect(root.headers.location).toBe('/v2/');

      const v2 = await makeRequest(server, '/v2/');
      expect(v2.status).toBe(200);
      expect(v2.headers['content-type']).toMatch(/text\/html/);
      expect(v2.body).toContain('<div id="root"');
      expect(v2.body).toContain('src/app.css?v=168');
      expect(v2.body).toContain('src/api.js?v=137');
      expect(v2.body).toContain('src/streamStore.js?v=121');
      expect(v2.body).toContain('src/usageProjection.js?v=116');
      expect(v2.body).toContain('src/cliUpdateStore.js?v=116');
      expect(v2.body).toContain('src/synthesisAtlas.js?v=117');
      expect(v2.body).toContain('src/screens/kbBrowser.jsx?v=142');
      expect(v2.body).toContain('src/screens/settingsScreen.jsx?v=128');
      expect(v2.body).toContain('src/screens/memoryReview.jsx?v=119');
      expect(v2.body).toContain('src/workspaceSettings.jsx?v=152');
      expect(v2.body).toContain('src/primitives.jsx?v=119');
      expect(v2.body).toContain('src/folderPicker.jsx?v=117');
      expect(v2.body).toContain('src/shell.jsx?v=131');
      expect(v2.body.indexOf('src/usageProjection.js?v=116')).toBeLessThan(
        v2.body.indexOf('src/chip-renderers.jsx?v=117'),
      );
      expect(v2.body.indexOf('src/synthesisAtlas.js?v=117')).toBeLessThan(
        v2.body.indexOf('src/screens/kbBrowser.jsx?v=142'),
      );

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

      for (const removedPath of ['/legacy/', '/index.html', '/styles.css', '/js/main.js', '/v2/deck.html']) {
        const res = await makeRequest(server, removedPath);
        expect(res.status).toBe(404);
      }
    });
  });
});
