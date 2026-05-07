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
    expect(workspaceSettingsSrc).toContain('function MemoryUpdateModal');
    expect(workspaceSettingsSrc).toContain('window.MemoryUpdateModal = MemoryUpdateModal');
    expect(workspaceSettingsSrc).toContain('View all memory items');
    expect(cssSrc).toContain('.mu-panel');
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
      expect(v2.body).toContain('src/app.css?v=139');
      expect(v2.body).toContain('src/api.js?v=125');
      expect(v2.body).toContain('src/cliUpdateStore.js?v=116');
      expect(v2.body).toContain('src/synthesisAtlas.js?v=117');
      expect(v2.body).toContain('src/screens/kbBrowser.jsx?v=142');
      expect(v2.body).toContain('src/workspaceSettings.jsx?v=120');
      expect(v2.body).toContain('src/primitives.jsx?v=119');
      expect(v2.body).toContain('src/folderPicker.jsx?v=117');
      expect(v2.body).toContain('src/shell.jsx?v=129');
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
