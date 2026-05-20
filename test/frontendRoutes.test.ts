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

  test('desktop chat keeps composer typing out of the transcript render path', () => {
    const shellSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/shell.jsx'), 'utf8');
    const shellStateSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/shellState.jsx'), 'utf8');

    expect(shellStateSrc).toContain('export function useConversationSelector');
    expect(shellStateSrc).toContain('export function shallowEqual');
    expect(shellSrc).toContain('const state = useConversationSelector(convId, selectChatLiveState, shallowEqual);');
    expect(shellSrc).toContain('const ChatComposer = React.memo(function ChatComposer');
    expect(shellSrc).toContain('const state = useConversationSelector(convId, selectChatComposerState, shallowEqual);');
    expect(shellSrc).toContain('input: s.input');
    expect(shellSrc).not.toMatch(/function selectChatLiveState[\s\S]*input: s\.input[\s\S]*function selectChatComposerState/);
    expect(shellSrc).toContain('const messageFeedEntries = React.useMemo(');
    expect(shellSrc).toContain('() => collapseProgressRuns(feedMessages)');
    expect(shellSrc).toContain('const MessageBubble = React.memo(function MessageBubble');
    expect(shellSrc).toContain('setMessageRef={setMessageRef}');
    expect(shellSrc).toContain('const TextSegment = React.memo(function TextSegment');
    expect(shellSrc).toContain('const html = React.useMemo(() => renderMarkdown(cleaned), [cleaned]);');
    expect(shellSrc).toContain('dangerouslySetInnerHTML={{ __html: html }}');
  });

  test('mobile PWA keeps iOS viewport and modal sheet content reachable', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/App.tsx'), 'utf8');
    const viewportHookSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/useViewportHeightVar.ts'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/styles.css'), 'utf8');

    expect(appSrc).toContain("import { useViewportHeightVar } from './useViewportHeightVar'");
    expect(appSrc).toContain('useViewportHeightVar();');
    expect(viewportHookSrc).toContain("root.style.setProperty('--app-top'");
    expect(viewportHookSrc).toContain("root.style.setProperty('--app-left'");
    expect(viewportHookSrc).toContain("root.style.setProperty('--app-width'");
    expect(viewportHookSrc).toContain('viewport?.offsetTop');
    expect(viewportHookSrc).toContain('viewport?.offsetLeft');
    expect(viewportHookSrc).toContain('viewport?.width');
    expect(viewportHookSrc).toContain('lastViewportMetrics');
    expect(viewportHookSrc).toContain('Math.round(viewport?.offsetTop || 0)');
    expect(viewportHookSrc).toContain('if (metrics !== lastViewportMetrics)');
    expect(viewportHookSrc).toContain('if (root.scrollLeft !== 0) root.scrollLeft = 0');
    expect(viewportHookSrc).toContain('window.scrollTo(0, 0)');
    expect(viewportHookSrc).toContain("window.addEventListener('scroll', scheduleUpdate)");
    expect(viewportHookSrc).toContain("document.addEventListener('focusin', scheduleFocusUpdate)");
    expect(viewportHookSrc).toContain("document.addEventListener('focusout', scheduleFocusUpdate)");
    expect(cssSrc).toMatch(/\.app-shell \{[\s\S]*top: var\(--app-top, 0px\);/);
    expect(cssSrc).toMatch(/\.app-shell \{[\s\S]*left: var\(--app-left, 0px\);/);
    expect(cssSrc).toMatch(/\.app-shell \{[\s\S]*width: var\(--app-width, 100vw\);/);
    expect(cssSrc).toMatch(/\.modal-backdrop \{[\s\S]*top: var\(--app-top, 0px\);/);
    expect(cssSrc).toMatch(/\.modal-backdrop \{[\s\S]*left: var\(--app-left, 0px\);/);
    expect(cssSrc).toMatch(/\.modal-header > div \{[\s\S]*min-width: 0;/);
    expect(cssSrc).toMatch(/\.modal h2 \{[\s\S]*text-overflow: ellipsis;/);
    expect(cssSrc).toMatch(/\.sheet-close \{[\s\S]*flex: 0 0 auto;/);
    expect(cssSrc).toMatch(/textarea, input \{[\s\S]*font-size: 16px;/);
    expect(cssSrc).toMatch(/\.editor \{[\s\S]*font-size: 16px;/);
    expect(appSrc).toContain('className="modal-scroll run-settings-scroll"');
    expect(cssSrc).toMatch(/\.run-settings-scroll \{[\s\S]*padding-bottom: calc\(16px \+ env\(safe-area-inset-bottom\)\);/);
    expect(cssSrc).toMatch(/\.filter-select \{[\s\S]*flex: 1 1 100%;/);
    expect(cssSrc).toMatch(/\.filter-select select \{[\s\S]*max-width: 100%;/);
  });

  test('welcome flow calls install doctor and completion APIs', () => {
    const apiSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/api.js'), 'utf8');
    const shellSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/shell.jsx'), 'utf8');
    const primitivesSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/primitives.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');

    expect(apiSrc).toContain("chatFetch('install/doctor')");
    expect(apiSrc).toContain("chatFetch('install/welcome-complete', { method: 'POST'");
    expect(apiSrc).toContain("chatFetch('install/actions/' + encodeURIComponent(actionId) + '/run'");
    expect(apiSrc).toContain("chatFetch(\n      'cli-profiles/setup-auth/' + encodeURIComponent(vendor) + '/start'");
    expect(apiSrc).toContain('getInstallDoctor');
    expect(apiSrc).toContain('completeWelcome');
    expect(apiSrc).toContain('runInstallAction');
    expect(apiSrc).toContain('startSetupCliAuth');
    expect(apiSrc).toContain('testSetupCliAuth');
    expect(shellSrc).toContain("new URLSearchParams(window.location.search).get('welcome') === '1'");
    expect(shellSrc).toContain('function WelcomeScreen');
    expect(shellSrc).toContain('AgentApi.getInstallDoctor()');
    expect(shellSrc).toContain('AgentApi.completeWelcome()');
    expect(shellSrc).toContain('AgentApi.runInstallAction(action.id)');
    expect(shellSrc).toContain('AgentApi.settings.startSetupCliAuth(vendor)');
    expect(shellSrc).toContain('AgentApi.settings.testSetupCliAuth(vendor)');
    expect(shellSrc).toContain('function WelcomeCliAuth');
    expect(shellSrc).toContain('setInstallStatus(nextInstallStatus)');
    expect(shellSrc).toContain("'welcomeCompletedAt' in nextInstallStatus");
    expect(shellSrc).toContain('onClick={() => onDone(null)}');
    expect(shellSrc).toContain('showWelcomeAction={Boolean(installStatus && !installStatus.welcomeCompletedAt && !welcomeOpen)}');
    expect(shellSrc).toContain("['pandoc', 'libreoffice', 'mobile-build']");
    expect(shellSrc).not.toContain(['cloud', 'flared'].join(''));
    expect(shellSrc).toContain("onOpenSettings('security')");
    expect(shellSrc).toContain("onOpenSettings('cli')");
    expect(shellSrc).toContain('Install only the backend CLIs you plan to use.');
    expect(shellSrc).toContain('item.installActions');
    expect(shellSrc).toContain('welcome-install-actions');
    expect(shellSrc).toContain('welcome-install-result');
    expect(shellSrc).toContain('welcome-cli-auth');
    expect(primitivesSrc).toContain('Welcome!');
    expect(primitivesSrc).toContain('showWelcomeAction');
    expect(shellSrc).toContain('/mobile/');
    expect(cssSrc).toContain('.main-welcome');
    expect(cssSrc).toContain('.welcome-grid');
    expect(cssSrc).toContain('.sb-welcome-toggle');
    expect(cssSrc).toContain('.welcome-install-actions');
    expect(cssSrc).toContain('.welcome-cli-auth');
  });

  test('CLI update settings refresh unprobed rows and render disabled buttons clearly', () => {
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/screens/settingsScreen.jsx'), 'utf8');
    const shellStateSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/shellState.jsx'), 'utf8');
    const storeSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/cliUpdateStore.js'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');

    expect(storeSrc).toContain('function ensureFresh()');
    expect(storeSrc).toContain('needsInitialCheck(data) ? check() : data');
    expect(settingsSrc).toContain('CliUpdateStore.ensureFresh()');
    expect(settingsSrc).toContain("document.addEventListener('visibilitychange', onVisibility)");
    expect(shellStateSrc).toContain('CliUpdateStore.ensureFresh()');
    expect(settingsSrc).toContain('No CLI updates available.');
    expect(cssSrc).toContain('.btn:disabled');
    expect(cssSrc).toContain('.btn.primary:disabled');
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

  test('desktop and mobile chat transcripts pause auto-follow when users scroll away', () => {
    const shellSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/shell.jsx'), 'utf8');
    const webCssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');
    const mobileAppSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/App.tsx'), 'utf8');
    const mobileCssSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/styles.css'), 'utf8');

    expect(shellSrc).toContain('CHAT_SCROLL_BOTTOM_THRESHOLD_PX = 48');
    expect(shellSrc).toContain('function isChatScrolledToEnd');
    expect(shellSrc).toContain('feedAutoFollowRef');
    expect(shellSrc).toContain('onScroll={handleFeedScroll}');
    expect(shellSrc).toContain('className="chat-back-to-end"');
    expect(shellSrc).toContain('scrollFeedToEnd()');
    expect(webCssSrc).toContain('.feed-wrap');
    expect(webCssSrc).toContain('.chat-back-to-end');

    expect(mobileAppSrc).toContain('CHAT_SCROLL_BOTTOM_THRESHOLD_PX = 48');
    expect(mobileAppSrc).toContain('transcriptAutoFollowRef');
    expect(mobileAppSrc).toContain('onScroll={handleTranscriptScroll}');
    expect(mobileAppSrc).toContain('className="mobile-back-to-end"');
    expect(mobileAppSrc).toContain('scrollTranscriptToEnd()');
    expect(mobileCssSrc).toContain('.transcript-wrap');
    expect(mobileCssSrc).toContain('.mobile-back-to-end');
  });

  test('desktop transcript paging uses internal message windows without a virtualizer dependency', () => {
    const apiSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/api.js'), 'utf8');
    const storeSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/streamStore.js'), 'utf8');
    const shellSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/shell.jsx'), 'utf8');
    const webCssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');
    const packageSrc = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const packageLockSrc = fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8');

    expect(apiSrc).toContain('getConversation: (convId, params)');
    expect(apiSrc).toContain('getMessageWindow: (convId, params)');
    expect(storeSrc).toContain('CHAT_WINDOW_TAIL_LIMIT = 160');
    expect(storeSrc).toContain('CHAT_WINDOW_PAGE_LIMIT = 80');
    expect(storeSrc).toContain('loadOlderMessages');
    expect(storeSrc).toContain('loadAroundMessage');
    expect(storeSrc).toContain('loadTailMessages');
    expect(shellSrc).toContain('StreamStore.loadOlderMessages(convId)');
    expect(shellSrc).toContain('restore.scrollTop + Math.max(0, el.scrollHeight - restore.scrollHeight)');
    expect(shellSrc).toContain('chatFeedScrollPositions');
    expect(shellSrc).toContain('saveFeedPosition');
    expect(shellSrc).toContain('restoreSavedFeedPosition');
    expect(shellSrc).toContain('StreamStore.loadAroundMessage(convId, messageId)');
    expect(shellSrc).toContain('pendingPinJumpRef');
    expect(shellSrc).toContain('if (!feed || !node || !feed.contains(node)) return false;');
    expect(shellSrc).toContain('forceBackToEndRef.current = true');
    expect(shellSrc).toContain('setPinJumpToken(token => token + 1)');
    expect(shellSrc).toContain('feed.scrollTo({ top: Math.max(0, targetTop), behavior })');
    expect(shellSrc).toContain('requestAnimationFrame(() => setShowFeedBackToEnd(true))');
    expect(shellSrc).toContain('const jumpIndex = messages.length > 1 ? nextIndex : safeIndex');
    expect(shellSrc).toContain('Opening pinned message...');
    expect(shellSrc).toContain('Loading earlier messages...');
    expect(shellSrc).toContain('StreamStore.loadTailMessages(convId)');
    expect(shellSrc).toContain('currentMessages={messageWindow && (messageWindow.hasOlder || messageWindow.hasNewer) ? null : messages}');
    expect(webCssSrc).toContain('.feed-page-status');
    expect(webCssSrc).toContain('.feed-page-status-floating');
    expect(`${packageSrc}\n${packageLockSrc}`).not.toMatch(/react-virtuoso|@tanstack\/react-virtual|react-window/);
  });

  test('desktop chat download button offers all-session and current-session exports', () => {
    const apiSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/api.js'), 'utf8');
    const shellSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/shell.jsx'), 'utf8');

    expect(apiSrc).toContain('conversationDownloadUrl: (convId) => chatUrl(');
    expect(apiSrc).toContain("'/download'");
    expect(apiSrc).toContain('sessionDownloadUrl: (convId, sessionNumber) => chatUrl(');
    expect(shellSrc).toContain('dialog.choice({');
    expect(shellSrc).toContain("label: 'All sessions'");
    expect(shellSrc).toContain("label: 'Current session'");
    expect(shellSrc).toContain('AgentApi.conv.sessionDownloadUrl(convId, sessionNumber)');
    expect(shellSrc).toContain('AgentApi.conv.conversationDownloadUrl(convId)');
  });

  test('mobile PWA Markdown action offers all-session and current-session exports', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/App.tsx'), 'utf8');
    const apiSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/api.ts'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/styles.css'), 'utf8');

    expect(apiSrc).toContain('conversationMarkdownURL(conversationID: string)');
    expect(apiSrc).toContain('sessionMarkdownURL(conversationID: string, sessionNumber: number)');
    expect(appSrc).toContain('const [markdownShareVisible, setMarkdownShareVisible] = useState(false)');
    expect(appSrc).toContain('function openMarkdownSharePicker()');
    expect(appSrc).toContain('function shareMarkdown(scope: MarkdownShareScope)');
    expect(appSrc).toContain('function MarkdownShareModal');
    expect(appSrc).toContain('All sessions');
    expect(appSrc).toContain('Current session');
    expect(appSrc).toContain('clientRef.current.conversationMarkdownURL(conversation.id)');
    expect(appSrc).toContain('clientRef.current.sessionMarkdownURL(conversation.id, conversation.sessionNumber || 1)');
    expect(cssSrc).toContain('.action-copy');
  });

  test('mobile PWA exposes backend-neutral goal controls through the composer shell', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/App.tsx'), 'utf8');
    const apiSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/api.ts'), 'utf8');
    const modelSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/appModel.ts'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'mobile/AgentCockpitPWA/src/styles.css'), 'utf8');

    expect(apiSrc).toContain('async getGoal');
    expect(apiSrc).toContain('async setGoal');
    expect(apiSrc).toContain('async resumeGoal');
    expect(apiSrc).toContain('async pauseGoal');
    expect(apiSrc).toContain('async clearGoal');
    expect(modelSrc).toContain('function goalElapsedSeconds');
    expect(modelSrc).toContain('function goalSupportsAction');
    expect(modelSrc).toContain('function shouldApplyGoalSnapshot');
    expect(appSrc).toContain('function normalizeGoalCapability');
    expect(appSrc).toContain('function goalCapabilityForBackend');
    expect(appSrc).toContain('function GoalStrip');
    expect(appSrc).toContain('function GoalEventView');
    expect(appSrc).toContain('applyServerMessage(conversation.id, response.message)');
    expect(appSrc).toContain('function handleGoalSlash');
    expect(appSrc).toContain("backendID === 'claude-code'");
    expect(appSrc).toContain("case 'goal_updated'");
    expect(appSrc).toContain("case 'goal_cleared'");
    expect(appSrc).toContain('activeGoalIDs');
    expect(appSrc).toContain('aria-pressed={props.goalMode}');
    expect(appSrc).toContain('Set a goal');
    expect(appSrc).not.toContain(['Set a', 'Codex goal'].join(' '));
    expect(appSrc).not.toContain(['Goals are only available for', 'Codex conversations.'].join(' '));
    expect(cssSrc).toContain('.goal-strip');
    expect(cssSrc).toContain('.goal-event-card');
    expect(cssSrc).toContain('.goal-toggle.enabled');
  });

  test('desktop web renders persisted goal lifecycle messages', () => {
    const shellSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/shell.jsx'), 'utf8');
    const storeSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/streamStore.js'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');

    expect(shellSrc).toContain('function GoalEventCard');
    expect(shellSrc).toContain('message.goalEvent');
    expect(storeSrc).toContain('function upsertPersistedMessage');
    expect(storeSrc).toContain('if (data && data.goal) applyGoalSnapshot');
    expect(cssSrc).toContain('.msg-goal-event');
    expect(cssSrc).toContain('.goal-event-card');
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
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/screens/settingsScreen.jsx'), 'utf8');
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
    expect(settingsSrc).toContain('Memory processor');
    expect(settingsSrc).toContain('memoryProcessorStatusLabel');
    expect(settingsSrc).toContain('Authentication failed');
    expect(settingsSrc).toContain('Used only to process and dedupe Memory notes');
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
    expect(cssSrc).toContain('.memory-processor-status');
  });

  test('Workspace Context settings expose markdown-first global and workspace controls', () => {
    const apiSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/api.js'), 'utf8');
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/screens/settingsScreen.jsx'), 'utf8');
    const workspaceSettingsSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/workspaceSettings.jsx'), 'utf8');
    const shellSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/shell.jsx'), 'utf8');
    const streamStoreSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/streamStore.js'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'web/AgentCockpitWeb/src/app.css'), 'utf8');

    expect(apiSrc).toContain('getWorkspaceContextSettings: (hash) =>');
    expect(apiSrc).toContain("{ cache: 'no-store' }");
    expect(apiSrc).toContain('setWorkspaceContextEnabled: (hash, enabled) =>');
    expect(apiSrc).toContain('setWorkspaceContextSettings: (hash, settings) =>');
    expect(apiSrc).toContain('runWorkspaceContextScan: (hash) =>');
    expect(apiSrc).toContain('runWorkspaceContextMaintenance: (hash) =>');
    expect(apiSrc).toContain('stopWorkspaceContextScan: (hash) =>');
    expect(apiSrc).toContain('clearWorkspaceContext: (hash) =>');
    expect(apiSrc).toContain('repairWorkspaceContextInstructions: (hash) =>');
    expect(apiSrc).toContain('getWorkspaceContextFiles: (hash) =>');
    expect(apiSrc).toContain('getWorkspaceContextFile: (hash, relPath) =>');
    expect(apiSrc).not.toContain('getWorkspaceContextReview');
    expect(apiSrc).not.toContain('getWorkspaceContextGraph');
    expect(apiSrc).not.toContain('getWorkspaceContextEntity');
    expect(apiSrc).not.toContain('WorkspaceContextCandidate');

    expect(settingsSrc).toContain("{ id: 'workspaceContext', label: 'Workspace Context' }");
    expect(settingsSrc).toContain('function SettingsWorkspaceContextTab');
    expect(settingsSrc).toContain('Workspace Context CLI profile');
    expect(settingsSrc).toContain('Concurrent workspace scans');
    expect(settingsSrc).toContain('Maintenance interval');
    expect(settingsSrc).toContain('Concurrent workspace maintenance');
    expect(settingsSrc).not.toContain('Processor concurrency');
    expect(settingsSrc).not.toContain('extractionConcurrency');
    expect(settingsSrc).not.toContain('synthesisConcurrency');

    expect(workspaceSettingsSrc).toContain("{ id: 'workspaceContext',   label: 'Workspace Context' }");
    expect(workspaceSettingsSrc).toContain("const WORKSPACE_CONTEXT_SECTIONS = ['overview', 'processor', 'files', 'runs', 'danger']");
    expect(workspaceSettingsSrc).toContain('function normalizeWorkspaceContextSection');
    expect(workspaceSettingsSrc).toContain('function WorkspaceSettingsPage');
    expect(workspaceSettingsSrc).toContain('export function WorkspaceSettingsPage');
    expect(workspaceSettingsSrc).toContain('initialWorkspaceContextSection');
    expect(workspaceSettingsSrc).toContain('initialSection={initialWorkspaceContextSection}');
    expect(workspaceSettingsSrc).toContain('function WorkspaceContextTab');
    expect(workspaceSettingsSrc).toContain('ac:workspace-context-update');
    expect(workspaceSettingsSrc).toContain('function applyWorkspaceContextRuntimeResponse');
    expect(workspaceSettingsSrc).toContain('function workspaceContextRunTimestamp');
    expect(workspaceSettingsSrc).toContain("Date.parse((run && run.startedAt) || '')");
    expect(workspaceSettingsSrc).toContain('workspaceContextRunTimestamp(b) - workspaceContextRunTimestamp(a)');
    expect(workspaceSettingsSrc).toContain('const WORKSPACE_CONTEXT_RUNS_PAGE_SIZE = 5');
    expect(workspaceSettingsSrc).toContain('const visibleRuns = runs.slice(');
    expect(workspaceSettingsSrc).toContain('function resolveWorkspaceContextRunFileLink');
    expect(workspaceSettingsSrc).toContain('function WorkspaceContextRunSummary');
    expect(workspaceSettingsSrc).toContain('dangerouslySetInnerHTML={{ __html: html }}');
    expect(workspaceSettingsSrc).toContain("selectSection('files')");
    expect(workspaceSettingsSrc).toContain('function workspaceContextRunFromStatus');
    expect(workspaceSettingsSrc).toContain('const intervalMs = 1000');
    expect(workspaceSettingsSrc).toContain('err.status === 409');
    expect(workspaceSettingsSrc).toContain("toast.warn('Workspace Context run already running')");
    expect(workspaceSettingsSrc).toContain('Workspace Context settings sections');
    expect(workspaceSettingsSrc).toContain('Markdown Files');
    expect(workspaceSettingsSrc).toContain('Read-only preview of the Workspace Context markdown folder.');
    expect(workspaceSettingsSrc).toContain('Run scan');
    expect(workspaceSettingsSrc).toContain('Run maintenance');
    expect(workspaceSettingsSrc).toContain('Last scan');
    expect(workspaceSettingsSrc).toContain('Last maintenance');
    expect(workspaceSettingsSrc).toContain('Latest run logs first.');
    expect(workspaceSettingsSrc).toContain('Older {Ico.chev(12)}');
    expect(workspaceSettingsSrc).toContain('Repair instructions');
    expect(workspaceSettingsSrc).toContain('Clear Workspace Context');
    expect(workspaceSettingsSrc).toContain('workspaceContextContentRef');
    expect(workspaceSettingsSrc).toContain('onSelectFile');
    expect(workspaceSettingsSrc).toContain('getWorkspaceContextFile');
    expect(workspaceSettingsSrc).not.toContain('Active Map');
    expect(workspaceSettingsSrc).not.toContain('Needs Attention');
    expect(workspaceSettingsSrc).not.toContain('workspaceContextCandidateImpactPreview');
    expect(workspaceSettingsSrc).not.toContain('applyAllWorkspaceContextCandidates');

    expect(shellSrc).toContain('ComposerWorkspaceContextIcon');
    expect(shellSrc).toContain('initialWorkspaceContextSection');
    expect(shellSrc).toContain("const targetSection = running || failures > 0 ? 'runs' : null");
    expect(shellSrc).toContain("onOpenWorkspaceSettings(conv.workspaceHash, workspaceLabel || 'workspace', 'workspaceContext', targetSection)");
    expect(shellSrc).toContain('Open context');
    expect(shellSrc).not.toContain('Open map');
    expect(streamStoreSrc).toContain("frame.type === 'workspace_context_update'");
    expect(streamStoreSrc).toContain('ac:workspace-context-update');

    expect(cssSrc).toContain('.settings-form.ws-form-workspace-context');
    expect(cssSrc).toContain('.ws-wc-layout');
    expect(cssSrc).toContain('.ws-wc-rail');
    expect(cssSrc).toContain('.ws-wc-content');
    expect(cssSrc).toContain('.ws-wc-readonly-list');
    expect(cssSrc).toContain('.ws-wc-save-row');
    expect(cssSrc).toContain('.ws-wc-initial-scan');
    expect(cssSrc).toContain('.ws-wc-file-browser');
    expect(cssSrc).toContain('.ws-wc-file-preview');
    expect(cssSrc).toContain('.ws-wc-runs');
    expect(cssSrc).toContain('.ws-wc-run-card');
    expect(cssSrc).toContain('.ws-wc-danger-block');
    expect(cssSrc).toContain('.composer-notif.state-workspace-context');
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
    expect(shellSrc).toContain("import { Tip } from './tooltip.jsx'");
    expect(shellSrc).toContain("React.lazy(() => import('./screens/kbBrowser.jsx')");
    expect(shellSrc).toContain("React.lazy(() => import('./workspaceSettings.jsx')");
    expect(fs.readFileSync(path.join(srcRoot, 'screens/kbBrowser.jsx'), 'utf8')).toContain("import { Tip } from '../tooltip.jsx'");
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
    expect(primitivesSrc).toContain('className="sb-brand"');
    expect(shellSrc).toContain('folderPickerInitialPath');
    expect(shellSrc).toContain('initialPath={folderPickerInitialPath}');
    expect(folderPickerSrc).toContain("function FolderPicker({ open, initialPath = ''");
    expect(folderPickerSrc).toContain("load(initialPath || '')");
    expect(primitivesSrc).not.toContain('function groupByWorkspace');
    expect(cssSrc).toContain('.sb-workspace-filter');
    expect(cssSrc).toContain('justify-content: center');
    expect(cssSrc).toContain('.sb-brand');
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
