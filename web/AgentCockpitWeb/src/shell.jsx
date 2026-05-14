import React from 'react';
import { createRoot } from 'react-dom/client';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

import { AgentApi } from './api.js';
import { getChipRenderer } from './chip-renderers.jsx';
import { resolveConversationArtifactHref, resolveLocalFileHref } from './fileLinks';
import hljs from './syntaxHighlight.js';
import { Ico } from './icons.jsx';
import { Sidebar } from './primitives.jsx';
import { StreamStore } from './streamStore.js';
import { PlanUsageStore } from './planUsageStore.js';
import { KiroPlanUsageStore } from './kiroPlanUsageStore.js';
import { CodexPlanUsageStore } from './codexPlanUsageStore.js';
import { CliUpdateStore } from './cliUpdateStore.js';
import { DialogProvider, useDialog } from './dialog.jsx';
import { ToastProvider, useToasts } from './toast.jsx';
import { Tip } from './tooltip.jsx';
import { FolderPicker } from './folderPicker.jsx';
import { UpdateModal, RestartOverlay } from './updateModal.jsx';
import {
  AssistantAvatar,
  BackendInlineIcon,
  BackendsProvider,
  CliProfilesProvider,
  ScreenLoading,
  useBackendList,
  useCliProfileSettings,
  useCliUpdates,
  useConversationState,
  useConvStates,
} from './shellState.jsx';
import {
  extractFileDeliveries,
  extractUploadedFiles,
  hiddenStreamErrorMessageIds,
} from './chat/messageParsing';
import { AttTray } from './chat/attachments.jsx';
import { QueueStack, SuspendedQueueBanner } from './chat/queue.jsx';
import { goalElapsedSeconds, goalStatusLabel, goalSupportsAction } from './goalState.js';

const KbBrowser = React.lazy(() => import('./screens/kbBrowser.jsx').then(mod => ({ default: mod.KbBrowser })));
const FilesBrowser = React.lazy(() => import('./screens/filesBrowser.jsx').then(mod => ({ default: mod.FilesBrowser })));
const SettingsScreen = React.lazy(() => import('./screens/settingsScreen.jsx').then(mod => ({ default: mod.SettingsScreen })));
const MemoryReviewPage = React.lazy(() => import('./screens/memoryReview.jsx').then(mod => ({ default: mod.MemoryReviewPage })));
const WorkspaceSettingsPage = React.lazy(() => import('./workspaceSettings.jsx').then(mod => ({ default: mod.WorkspaceSettingsPage })));
const MemoryUpdateModal = React.lazy(() => import('./workspaceSettings.jsx').then(mod => ({ default: mod.MemoryUpdateModal })));
const SessionsModal = React.lazy(() => import('./sessionsModal.jsx').then(mod => ({ default: mod.SessionsModal })));

/* Agent Cockpit v2 — real app entry.
   PR 4a scope: long-conversation rendering — progress-breadcrumb
   collapse of consecutive turn:'progress' assistant messages, sequential vs
   parallel grouping of tool runs by server-assigned batchIndex, and subagent
   nesting of tool activity across messages via parentAgentId.
   PR 4b scope (current): streaming state lifted into a per-conversation
   StreamStore so switching conversations doesn't abort in-flight streams,
   and the sidebar can light up multiple rows at once.
   Plan approval, message queue, right-rail, and the rest still land later. */

/* Legacy fallback: for tool activities persisted before the server started
   tagging `batchIndex`, we approximate parallel grouping by startTime proximity. */
const PARALLEL_THRESHOLD_MS = 500;
const CLAUDE_CODE_INTERACTIVE_BACKEND_ID = 'claude-code-interactive';

function cliVendorForBackend(backendId){
  return backendId === CLAUDE_CODE_INTERACTIVE_BACKEND_ID ? 'claude-code' : backendId;
}

function backendIdForProfile(profile){
  if (!profile) return null;
  if (profile.vendor === 'claude-code' && profile.protocol === 'interactive') return CLAUDE_CODE_INTERACTIVE_BACKEND_ID;
  return profile.vendor;
}

function backendSupportsGoals(backendId){
  return backendId === 'codex' || backendId === 'claude-code' || backendId === CLAUDE_CODE_INTERACTIVE_BACKEND_ID;
}

/* Cross-message subagent linkage. Because a subagent's Agent tool_use and its
   internal children can be persisted on different messages (the Agent's
   "Now spawning..." text triggers an early save, then children accumulate on
   the next saved message), we precompute the full agent/child index at the
   feed level and make it available to every ToolRun down the tree. */
const AgentIndexContext = React.createContext({ agentIds: new Set(), childrenByAgent: new Map() });

/* Exposes the active workspace hash + the two chat-level modal openers
   (FILE_DELIVERY viewer and inline-image lightbox) to deeply nested text
   segments. Populated by ChatLive. Any field is `null` outside ChatLive. */
const FileViewerContext = React.createContext({
  wsHash: null,
  convId: null,
  workingDir: null,
  openFileViewer: null,
  openLightbox: null,
});

/* Contains render/effect crashes inside <ChatLive> so one broken conversation
   can't take down the whole shell. The parent wraps this with
   key={activeConvId} so switching conversations resets the boundary and
   gives users a fresh attempt. */
class ChatErrorBoundary extends React.Component {
  constructor(props){
    super(props);
    this.state = { err: null };
    this.onReload = () => { try { window.location.reload(); } catch(e) {} };
  }
  static getDerivedStateFromError(err){ return { err }; }
  componentDidCatch(err, info){
    try { console.error('[ChatErrorBoundary]', err, info); } catch(e) {}
  }
  render(){
    if (!this.state.err) return this.props.children;
    const msg = (this.state.err && this.state.err.message) || String(this.state.err);
    return (
      <section className="main main-error">
        <div style={{ maxWidth: 520, margin: '64px auto', padding: 24, textAlign: 'center' }}>
          <h2 style={{ margin: '0 0 8px' }}>Something went wrong</h2>
          <p style={{ color: 'var(--fg-muted)', margin: '0 0 16px', fontSize: 14 }}>
            This conversation failed to render. Try switching to another conversation, or reload the app.
          </p>
          <pre style={{ textAlign: 'left', background: 'var(--bg-muted)', padding: 12, borderRadius: 'var(--r-sm)', fontSize: 12, whiteSpace: 'pre-wrap', margin: '0 0 16px' }}>{msg}</pre>
          <button className="btn primary" onClick={this.onReload}>Reload</button>
        </div>
      </section>
    );
  }
}

function App(){
  const [activeConvId, setActiveConvId] = React.useState(null);
  const [kbView, setKbView] = React.useState(null);     // { hash, label } | null
  const [filesView, setFilesView] = React.useState(null); // { hash, label } | null
  const [settingsView, setSettingsView] = React.useState(null); // { initialTab } | null — global app settings, no per-workspace context
  const [folderPickerOpen, setFolderPickerOpen] = React.useState(false);
  const [folderPickerInitialPath, setFolderPickerInitialPath] = React.useState('');
  const [creatingConv, setCreatingConv] = React.useState(false);
  const [viewingArchive, setViewingArchive] = React.useState(false);
  const [updateTarget, setUpdateTarget] = React.useState(null); // { localVersion, remoteVersion } | null
  const [restarting, setRestarting] = React.useState(false);
  const [workspaceSettings, setWorkspaceSettings] = React.useState(null); // { hash, label, initialTab, initialContextMapSection } | null
  const [memoryUpdateView, setMemoryUpdateView] = React.useState(null); // { hash, label, update } | null
  const [memoryReviewView, setMemoryReviewView] = React.useState(null); // { hash, label, runId } | null
  const [welcomeOpen, setWelcomeOpen] = React.useState(() => {
    try { return new URLSearchParams(window.location.search).get('welcome') === '1'; }
    catch { return false; }
  });
  const [sbOpen, setSbOpen] = React.useState(false); // mobile-only sidebar overlay; ignored on desktop
  const [user, setUser] = React.useState(null); // { displayName, email, provider } | null
  const convStates = useConvStates();
  const dialog = useDialog();

  React.useEffect(() => {
    let cancelled = false;
    AgentApi.getMe()
      .then(me => { if (!cancelled) setUser(me); })
      .catch(() => { /* silent — session-expired handler covers 401s */ });
    return () => { cancelled = true; };
  }, []);

  /* Silent re-auth. When a request returns 401, we prompt the user to
     sign in via a popup window that lands on /auth/popup-done, which
     postMessages back and self-closes. On success we dismiss the
     dialog — the user's draft (text + attachments) is already preserved
     in StreamStore + localStorage, so they can just click send again.
     Re-entrancy guarded so overlapping 401s don't stack dialogs. */
  const reAuthInFlightRef = React.useRef(false);
  React.useEffect(() => {
    AgentApi.setSessionExpiredHandler(async () => {
      if (reAuthInFlightRef.current) return;
      reAuthInFlightRef.current = true;
      try {
        const ok = await dialog.confirm({
          variant: 'error',
          title: 'Session expired',
          body: 'Sign in again to continue — your draft and attachments are preserved.',
          confirmLabel: 'Sign in',
          cancelLabel: 'Cancel',
        });
        if (!ok) return;

        const w = 480, h = 640;
        const left = Math.max(0, (window.screen.width  - w) / 2);
        const top  = Math.max(0, (window.screen.height - h) / 2);
        const popup = window.open(
          '/auth/login?popup=1',
          'ac-reauth',
          `width=${w},height=${h},left=${left},top=${top}`,
        );
        if (!popup) {
          // Popup blocked — fall back to a full-page redirect. The
          // localStorage draft will be restored on reload.
          window.location.href = '/auth/login';
          return;
        }

        const origin = window.location.origin;
        const settled = await new Promise((resolve) => {
          const onMessage = (ev) => {
            if (ev.origin !== origin) return;
            if (ev.data && ev.data.type === 'ac-reauth-ok') {
              cleanup();
              resolve('ok');
            }
          };
          const poll = setInterval(() => {
            if (popup.closed) {
              cleanup();
              resolve('closed');
            }
          }, 500);
          function cleanup(){
            window.removeEventListener('message', onMessage);
            clearInterval(poll);
          }
          window.addEventListener('message', onMessage);
        });

        // The old CSRF token is tied to the old session; after re-auth
        // we must drop it so chatFetch lazily re-fetches the new one.
        AgentApi.invalidateCsrfToken();

        if (settled === 'ok') {
          // Session is back — sweep stale "session expired" error cards so
          // the user doesn't see them hanging around after signing in.
          StreamStore.clearAllStreamErrors();
          return;
        }

        // Popup was closed without a success message — verify with a
        // cheap authenticated GET. If still 401, tell the user.
        try {
          const res = await fetch('/api/csrf-token', { credentials: 'same-origin' });
          if (res.ok) return;
        } catch {}
        await dialog.alert({
          variant: 'error',
          title: 'Still signed out',
          body: 'The sign-in window was closed before it completed. Try again.',
          confirmLabel: 'OK',
        });
      } finally {
        reAuthInFlightRef.current = false;
      }
    });
  }, [dialog]);

  /* Push the active conv into StreamStore so the unread auto-marker on
     `done` knows whether the completing stream belongs to the visible
     conv (don't flag) vs a background conv (do flag). */
  React.useEffect(() => {
    StreamStore.setActiveConvId(activeConvId);
  }, [activeConvId]);

  /* Archive/delete/rename callbacks: the StreamStore mutation now happens
     at the action site (handleArchive/handleDelete/saveTitle below), so
     these only handle the page-level side effect of clearing the chat
     view. Rename has no view-level side effect. */
  const onArchived = React.useCallback(() => {
    setActiveConvId(null);
  }, []);

  const onDeleted = React.useCallback(() => {
    setActiveConvId(null);
  }, []);

  const onRenamed = React.useCallback(() => {}, []);

  const onSelectConv = React.useCallback((id) => {
    setWelcomeOpen(false);
    setKbView(null);
    setFilesView(null);
    setSettingsView(null);
    setWorkspaceSettings(null);
    setMemoryUpdateView(null);
    setMemoryReviewView(null);
    /* Push the active id into StreamStore synchronously *before* markRead
       so any `done` frame that fires between this call and the React-effect
       sync below already sees the new active id and doesn't re-flag the
       just-selected conv as unread. */
    StreamStore.setActiveConvId(id);
    setActiveConvId(id);
    setSbOpen(false);
    /* Clear the unread dot on selection. markRead always touches local
       state so convStates() can override the stale `c.unread` the sidebar
       may still have from the cached server list. */
    if (id) StreamStore.markRead(id);
  }, []);

  const onMarkUnread = React.useCallback((id) => {
    if (id) StreamStore.markUnread(id);
  }, []);

  const onOpenKb = React.useCallback((hash, label) => {
    setWelcomeOpen(false);
    setWorkspaceSettings(null);
    setMemoryUpdateView(null);
    setMemoryReviewView(null);
    setFilesView(null);
    setSettingsView(null);
    setKbView({ hash, label });
    setSbOpen(false);
  }, []);

  const onOpenFiles = React.useCallback((hash, label) => {
    setWelcomeOpen(false);
    setWorkspaceSettings(null);
    setMemoryUpdateView(null);
    setMemoryReviewView(null);
    setKbView(null);
    setSettingsView(null);
    setFilesView({ hash, label });
    setSbOpen(false);
  }, []);

  const onOpenSettings = React.useCallback((initialTab) => {
    setWelcomeOpen(false);
    setWorkspaceSettings(null);
    setMemoryUpdateView(null);
    setMemoryReviewView(null);
    setKbView(null);
    setFilesView(null);
    setSettingsView({ initialTab: initialTab || null });
    setSbOpen(false);
  }, []);

  const onNewConversation = React.useCallback((initialPath) => {
    setWelcomeOpen(false);
    setSbOpen(false);
    setViewingArchive(false);
    setFolderPickerInitialPath(initialPath || '');
    setFolderPickerOpen(true);
  }, []);

  const onToggleArchive = React.useCallback(() => {
    setViewingArchive(v => {
      const next = !v;
      if (next) {
        setWelcomeOpen(false);
        setActiveConvId(null);
        setKbView(null);
        setFilesView(null);
        setSettingsView(null);
        setWorkspaceSettings(null);
        setMemoryUpdateView(null);
        setMemoryReviewView(null);
      }
      return next;
    });
  }, []);

  const onRestoreConv = React.useCallback(async (id) => {
    try {
      await AgentApi.restoreConversation(id);
      /* Conv leaves the archived view; if user is on the active view it
         was never present anyway. removeConvListItem is a no-op then. */
      StreamStore.removeConvListItem(id);
    } catch (err) {
      dialog.alert({
        variant: 'error',
        title: 'Failed to restore conversation',
        body: err.message || String(err),
      });
    }
  }, [dialog]);

  const onSignOut = React.useCallback(async (anchor) => {
    const ok = await dialog.confirm({
      anchor,
      title: 'Sign out?',
      body: 'You will be redirected to the sign-in page.',
      confirmLabel: 'Sign out',
      cancelLabel: 'Cancel',
    });
    if (ok) window.location.href = '/auth/logout';
  }, [dialog]);

  const onShowUpdate = React.useCallback((info) => {
    setUpdateTarget({
      localVersion: info && info.localVersion ? info.localVersion : null,
      remoteVersion: info && info.remoteVersion ? info.remoteVersion : null,
    });
  }, []);

  const onOpenWorkspaceSettings = React.useCallback((hash, label, initialTab, initialContextMapSection) => {
    setWelcomeOpen(false);
    setKbView(null);
    setFilesView(null);
    setSettingsView(null);
    setMemoryUpdateView(null);
    setMemoryReviewView(null);
    setWorkspaceSettings({
      hash,
      label,
      initialTab: initialTab || null,
      initialContextMapSection: initialContextMapSection || null,
    });
    setSbOpen(false);
  }, []);

  const onOpenMemoryUpdate = React.useCallback((hash, label, update) => {
    setWelcomeOpen(false);
    setWorkspaceSettings(null);
    setMemoryReviewView(null);
    setMemoryUpdateView({ hash, label, update: update || null });
    setSbOpen(false);
  }, []);

  const onOpenMemoryReview = React.useCallback((hash, label, runId) => {
    setWelcomeOpen(false);
    setWorkspaceSettings(null);
    setMemoryUpdateView(null);
    setMemoryReviewView({ hash, label, runId: runId || null });
    setSbOpen(false);
  }, []);

  const onViewAllMemoryItems = React.useCallback(() => {
    if (!memoryUpdateView) return;
    setWorkspaceSettings({
      hash: memoryUpdateView.hash,
      label: memoryUpdateView.label,
      initialTab: 'memory',
    });
    setMemoryUpdateView(null);
  }, [memoryUpdateView]);

  const onCloseWorkspaceSettings = React.useCallback(() => {
    /* KB toggle may have flipped — refetch so the workspace-level
       `workspaceKbEnabled` flag (and the selected-workspace book icon)
       reflects the new state. Targeted patches don't apply here because
       the toggle affects every conv in the workspace, not just one. */
    setWorkspaceSettings(null);
    StreamStore.refreshConvList();
  }, []);

  const createConv = React.useCallback(async (workingDir) => {
    if (creatingConv) return;
    setCreatingConv(true);
    try {
      let defaultBackend = null;
      let defaultCliProfileId = null;
      try {
        const settings = await AgentApi.getSettingsCached();
        defaultBackend = settings && settings.defaultBackend ? settings.defaultBackend : null;
        defaultCliProfileId = settings && settings.defaultCliProfileId ? settings.defaultCliProfileId : null;
      } catch { /* best-effort — server falls back to its own default */ }
      const body = {};
      if (workingDir) body.workingDir = workingDir;
      if (defaultCliProfileId) body.cliProfileId = defaultCliProfileId;
      else if (defaultBackend) body.backend = defaultBackend;
      const conv = await AgentApi.createConversation(body);
      StreamStore.prependConvListItem(conv);
      setFolderPickerOpen(false);
      setFolderPickerInitialPath('');
      setKbView(null);
      setFilesView(null);
      setSettingsView(null);
      setWorkspaceSettings(null);
      setMemoryReviewView(null);
      setViewingArchive(false);
      setActiveConvId(conv.id);
    } catch (err) {
      dialog.alert({
        variant: 'error',
        title: 'Failed to create conversation',
        body: err.message || String(err),
      });
    } finally {
      setCreatingConv(false);
    }
  }, [creatingConv, dialog]);

  const onWelcomeDone = React.useCallback(() => {
    setWelcomeOpen(false);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('welcome');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch {}
  }, []);

  return (
    <div className={"cockpit" + (sbOpen ? " sb-open" : "")}>
      <Sidebar
        activeId={activeConvId}
        onSelect={onSelectConv}
        onMarkUnread={onMarkUnread}
        convStates={convStates}
        onOpenKb={onOpenKb}
        onOpenFiles={onOpenFiles}
        onOpenSettings={onOpenSettings}
        onOpenWorkspaceSettings={onOpenWorkspaceSettings}
        onNewConversation={onNewConversation}
        viewingArchive={viewingArchive}
        onToggleArchive={onToggleArchive}
        onRestore={onRestoreConv}
        onSignOut={onSignOut}
        onShowUpdate={onShowUpdate}
        user={user}
      />
      <div className="sb-backdrop" onClick={() => setSbOpen(false)} aria-hidden="true"/>
      <button
        className="nav-hamb"
        onClick={() => setSbOpen(v => !v)}
        aria-label={sbOpen ? 'Close sidebar' : 'Open sidebar'}
        title={sbOpen ? 'Close sidebar' : 'Open sidebar'}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="6" x2="21" y2="6"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>
      {welcomeOpen ? (
        <WelcomeScreen
          onDone={onWelcomeDone}
          onOpenSettings={onOpenSettings}
          onNewConversation={onNewConversation}
        />
      ) : workspaceSettings ? (
        <section className="main main-settings">
          <React.Suspense fallback={<ScreenLoading label="Loading workspace settings..."/>}>
            <WorkspaceSettingsPage
              hash={workspaceSettings.hash}
              label={workspaceSettings.label}
              initialTab={workspaceSettings.initialTab}
              initialContextMapSection={workspaceSettings.initialContextMapSection}
              onOpenMemoryReview={onOpenMemoryReview}
              onClose={onCloseWorkspaceSettings}
            />
          </React.Suspense>
        </section>
      ) : settingsView ? (
        <section className="main main-settings">
          <React.Suspense fallback={<ScreenLoading label="Loading settings..."/>}>
            <SettingsScreen initialTab={settingsView.initialTab} onClose={() => setSettingsView(null)}/>
          </React.Suspense>
        </section>
      ) : filesView ? (
        <section className="main main-files">
          <React.Suspense fallback={<ScreenLoading label="Loading files..."/>}>
            <FilesBrowser hash={filesView.hash} label={filesView.label} onClose={() => setFilesView(null)}/>
          </React.Suspense>
        </section>
      ) : kbView ? (
        <section className="main main-kb">
          <React.Suspense fallback={<ScreenLoading label="Loading knowledge base..."/>}>
            <KbBrowser hash={kbView.hash} label={kbView.label} onClose={() => setKbView(null)}/>
          </React.Suspense>
        </section>
      ) : memoryReviewView ? (
        <React.Suspense fallback={<section className="main"><ScreenLoading label="Loading memory review..."/></section>}>
          <MemoryReviewPage
            hash={memoryReviewView.hash}
            label={memoryReviewView.label}
            runId={memoryReviewView.runId}
            onClose={() => setMemoryReviewView(null)}
          />
        </React.Suspense>
      ) : activeConvId
        ? <ChatErrorBoundary key={activeConvId}>
            <ChatLive
              convId={activeConvId}
              onArchived={onArchived}
              onDeleted={onDeleted}
              onRenamed={onRenamed}
              onOpenMemoryUpdate={onOpenMemoryUpdate}
              onOpenMemoryReview={onOpenMemoryReview}
              onOpenWorkspaceSettings={onOpenWorkspaceSettings}
              onOpenSettings={onOpenSettings}
            />
          </ChatErrorBoundary>
        : <EmptyMain/>}
      <FolderPicker
        open={folderPickerOpen}
        busy={creatingConv}
        initialPath={folderPickerInitialPath}
        onClose={() => {
          if (!creatingConv) {
            setFolderPickerOpen(false);
            setFolderPickerInitialPath('');
          }
        }}
        onSelect={createConv}
        onUseDefault={() => createConv(null)}
      />
      <UpdateModal
        open={!!updateTarget && !restarting}
        localVersion={updateTarget ? updateTarget.localVersion : null}
        remoteVersion={updateTarget ? updateTarget.remoteVersion : null}
        onClose={() => setUpdateTarget(null)}
        onRestarting={() => { setUpdateTarget(null); setRestarting(true); }}
      />
      <RestartOverlay open={restarting}/>
      {memoryUpdateView ? (
        <React.Suspense fallback={null}>
          <MemoryUpdateModal
            open={true}
            hash={memoryUpdateView.hash}
            label={memoryUpdateView.label}
            update={memoryUpdateView.update}
            onClose={() => setMemoryUpdateView(null)}
            onViewAll={onViewAllMemoryItems}
          />
        </React.Suspense>
      ) : null}
    </div>
  );
}

function EmptyMain(){
  return (
    <section className="main">
      <div className="feed">
        <div className="feed-inner" style={{padding:"40px 24px",textAlign:"center"}}>
          <div className="u-dim" style={{fontSize:13}}>
            Select a conversation from the sidebar to start chatting.
          </div>
        </div>
      </div>
    </section>
  );
}

function WelcomeScreen({ onDone, onOpenSettings, onNewConversation }){
  const [loading, setLoading] = React.useState(true);
  const [install, setInstall] = React.useState(null);
  const [doctor, setDoctor] = React.useState(null);
  const [authStatus, setAuthStatus] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [finishing, setFinishing] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [installStatus, doctorStatus, auth] = await Promise.all([
        AgentApi.getInstallStatus(),
        AgentApi.getInstallDoctor(),
        AgentApi.auth.status(),
      ]);
      setInstall(installStatus);
      setDoctor(doctorStatus);
      setAuthStatus(auth);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const finish = React.useCallback(async () => {
    setFinishing(true);
    setError(null);
    try {
      await AgentApi.completeWelcome();
      onDone();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setFinishing(false);
    }
  }, [onDone]);

  const checks = doctor && Array.isArray(doctor.checks) ? doctor.checks : [];
  const requiredChecks = checks.filter(item => item.required);
  const cliChecks = checks.filter(item => ['claude-cli', 'codex-cli', 'kiro-cli'].includes(item.id));
  const optionalChecks = checks.filter(item => ['pandoc', 'libreoffice', 'cloudflared', 'mobile-build'].includes(item.id));
  const installLine = install
    ? `${install.channel || 'dev'} channel · ${install.source || 'unknown'} · ${install.version || 'unversioned'}`
    : 'Install status unavailable';

  return (
    <section className="main main-welcome">
      <div className="welcome-shell">
        <div className="welcome-head">
          <div>
            <div className="welcome-kicker">Welcome</div>
            <h1>Agent Cockpit</h1>
            <p>{installLine}</p>
          </div>
          <button className="btn ghost" type="button" onClick={onDone}>Skip</button>
        </div>

        {error ? (
          <div className="welcome-error">
            <span>{Ico.alert(16)}</span>
            <span>{error}</span>
            <button className="btn" type="button" onClick={load}>Retry</button>
          </div>
        ) : null}

        {loading ? (
          <ScreenLoading label="Checking install..."/>
        ) : (
          <div className="welcome-grid">
            <WelcomePanel title="Owner Account" tone={authStatus && !authStatus.setupRequired ? 'ok' : 'warning'}>
              <WelcomeLine
                label="Owner"
                status={authStatus && !authStatus.setupRequired ? 'ok' : 'warning'}
                summary={authStatus && !authStatus.setupRequired ? 'Configured' : 'Setup required'}
              />
              <WelcomeLine
                label="Recovery codes"
                status={authStatus?.recovery?.configured ? 'ok' : 'warning'}
                summary={authStatus?.recovery?.configured ? `${authStatus.recovery.remaining} remaining` : 'Not generated yet'}
              />
              <WelcomeLine
                label="Passkeys"
                status={authStatus?.passkeys?.registered ? 'ok' : 'warning'}
                summary={authStatus?.passkeys?.registered ? `${authStatus.passkeys.registered} registered` : 'Optional'}
              />
              <div className="welcome-actions">
                <button className="btn" type="button" onClick={() => onOpenSettings('security')}>{Ico.key(14)} Security</button>
              </div>
            </WelcomePanel>

            <WelcomePanel title="Required Checks" tone={doctor?.overallStatus || 'warning'}>
              {requiredChecks.map(item => <WelcomeDoctorLine key={item.id} item={item}/>)}
            </WelcomePanel>

            <WelcomePanel title="CLI Backends" tone={cliChecks.some(item => item.status === 'ok') ? 'ok' : 'warning'}>
              {cliChecks.map(item => <WelcomeDoctorLine key={item.id} item={item}/>)}
              <div className="welcome-actions">
                <button className="btn" type="button" onClick={() => onOpenSettings('cli')}>{Ico.terminal(14)} CLI Profiles</button>
              </div>
            </WelcomePanel>

            <WelcomePanel title="Workspace" tone="ok">
              <WelcomeLine label="Default" status="ok" summary="Choose a folder when you start a conversation."/>
              <div className="welcome-actions">
                <button className="btn" type="button" onClick={() => onNewConversation('')}>{Ico.folder(14)} Pick Workspace</button>
              </div>
            </WelcomePanel>

            <WelcomePanel title="Optional Tools" tone={optionalChecks.some(item => item.status === 'warning') ? 'warning' : 'ok'}>
              {optionalChecks.map(item => <WelcomeDoctorLine key={item.id} item={item}/>)}
            </WelcomePanel>

            <WelcomePanel title="Mobile PWA" tone="ok">
              <WelcomeLine label="URL" status="ok" summary="/mobile/"/>
              <p className="welcome-note">Open the mobile path from the same authenticated server and add it to the home screen.</p>
            </WelcomePanel>
          </div>
        )}

        <div className="welcome-foot">
          <button className="btn" type="button" onClick={load} disabled={loading}>Refresh</button>
          <button className="btn primary" type="button" onClick={finish} disabled={finishing || loading}>
            {finishing ? 'Finishing...' : 'Finish Setup'}
          </button>
        </div>
      </div>
    </section>
  );
}

function WelcomePanel({ title, tone, children }){
  return (
    <section className={"welcome-panel tone-" + (tone || 'ok')}>
      <div className="welcome-panel-head">
        <span>{tone === 'error' ? Ico.alert(14) : tone === 'warning' ? Ico.info(14) : Ico.ok(14)}</span>
        <h2>{title}</h2>
      </div>
      <div className="welcome-panel-body">{children}</div>
    </section>
  );
}

function WelcomeDoctorLine({ item }){
  return (
    <WelcomeLine
      label={item.label}
      status={item.status}
      summary={item.summary}
      detail={item.status === 'ok' ? item.detail : (item.remediation || item.detail)}
    />
  );
}

function WelcomeLine({ label, status, summary, detail }){
  const icon = status === 'error' ? Ico.alert(14) : status === 'warning' ? Ico.info(14) : Ico.check(14);
  return (
    <div className={"welcome-line status-" + (status || 'ok')}>
      <span className="welcome-line-icon">{icon}</span>
      <div>
        <div className="welcome-line-top"><span>{label}</span><b>{summary}</b></div>
        {detail ? <div className="welcome-line-detail">{detail}</div> : null}
      </div>
    </div>
  );
}

function compactDuration(seconds){
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return total + 's';
  const mins = Math.floor(total / 60);
  if (mins < 60) return mins + 'm';
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

function normalizeGoalCapability(capability, backendId){
  if (capability === true) {
    return { set: true, clear: true, pause: true, resume: true, status: 'native' };
  }
  if (capability && typeof capability === 'object') {
    return {
      set: capability.set === true,
      clear: capability.clear === true,
      pause: capability.pause === true,
      resume: capability.resume === true,
      status: capability.status || 'none',
    };
  }
  if (backendId === 'codex') return { set: true, clear: true, pause: true, resume: true, status: 'native' };
  if (backendId === 'claude-code' || backendId === CLAUDE_CODE_INTERACTIVE_BACKEND_ID) return { set: true, clear: true, pause: false, resume: false, status: 'transcript' };
  return { set: false, clear: false, pause: false, resume: false, status: 'none' };
}

function goalCapabilityForBackend(backends, backendId){
  const backend = (backends || []).find(b => b && b.id === backendId);
  return normalizeGoalCapability(backend?.capabilities?.goals, backendId);
}

function GoalStrip({ convId, goal, streaming, sending }){
  if (!goal) return null;
  const status = goal.status || 'active';
  const canPause = status === 'active' && goalSupportsAction(goal, 'pause');
  const canResume = status === 'paused' && !streaming && goalSupportsAction(goal, 'resume');
  const canClear = goalSupportsAction(goal, 'clear');
  const claudeGoal = goal.backend === 'claude-code' || goal.backend === CLAUDE_CODE_INTERACTIVE_BACKEND_ID;
  const clearDisabled = sending || (claudeGoal && streaming);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!goal) return undefined;
    StreamStore.refreshGoal(convId);
    const delay = status === 'active' ? 2000 : 5000;
    const poll = setInterval(() => {
      setNowMs(Date.now());
      StreamStore.refreshGoal(convId);
    }, delay);
    return () => clearInterval(poll);
  }, [convId, goal?.threadId, status]);
  React.useEffect(() => {
    if (status !== 'active') return undefined;
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [status, goal?.updatedAt, goal?.timeUsedSeconds]);
  const elapsed = compactDuration(goalElapsedSeconds(goal, nowMs));
  const objective = typeof goal.objective === 'string' ? goal.objective : '';
  return (
    <div className={"goal-strip status-" + status}>
      <div className="goal-strip-main">
        <span className="goal-dot" aria-hidden="true"/>
        <span className="goal-status">{goalStatusLabel(status)}</span>
        {elapsed !== '0s' ? <span className="goal-elapsed">{elapsed}</span> : null}
        {objective ? <span className="goal-objective" title={objective}>{objective}</span> : null}
      </div>
      <div className="goal-strip-actions">
        {canPause ? (
          <button type="button" onClick={() => StreamStore.pauseGoal(convId)} disabled={sending} title="Pause goal">Pause</button>
        ) : null}
        {status === 'paused' && goalSupportsAction(goal, 'resume') ? (
          <button type="button" onClick={() => StreamStore.resumeGoal(convId)} disabled={sending || !canResume} title="Resume goal">Resume</button>
        ) : null}
        {canClear ? (
          <button
            type="button"
            onClick={() => StreamStore.clearGoal(convId)}
            disabled={clearDisabled}
            title={clearDisabled && claudeGoal ? 'Claude Code goals can be cleared after the active turn finishes' : 'Clear goal'}
          >Clear</button>
        ) : null}
      </div>
    </div>
  );
}

function ChatLive({ convId, onArchived, onDeleted, onRenamed, onOpenMemoryUpdate, onOpenMemoryReview, onOpenWorkspaceSettings, onOpenSettings }){
  const state = useConversationState(convId);
  const backends = useBackendList();
  const { profiles: cliProfiles } = useCliProfileSettings();
  const dialog = useDialog();
  const toast = useToasts();
  const feedRef = React.useRef(null);
  const fileInputRef = React.useRef(null);
  const composerTextRef = React.useRef(null);
  const dragCounterRef = React.useRef(0);
  const [dragOver, setDragOver] = React.useState(false);
  const [sessionsOpen, setSessionsOpen] = React.useState(false);
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState('');
  const [savingTitle, setSavingTitle] = React.useState(false);
  const titleInputRef = React.useRef(null);
  const [fileViewer, setFileViewer] = React.useState(null);
  const openFileViewer = React.useCallback((descriptor) => {
    if (!descriptor) return;
    setFileViewer(descriptor);
  }, []);
  const closeFileViewer = React.useCallback(() => setFileViewer(null), []);
  React.useEffect(() => { setFileViewer(null); }, [convId]);
  React.useEffect(() => {
    if (!fileViewer) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeFileViewer(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fileViewer, closeFileViewer]);

  const [lightbox, setLightbox] = React.useState(null);
  const openLightbox = React.useCallback((src, alt) => setLightbox({ src, alt: alt || '' }), []);
  const closeLightbox = React.useCallback(() => setLightbox(null), []);
  React.useEffect(() => { setLightbox(null); }, [convId]);

  React.useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);

  const messages = state ? state.messages : [];
  const activeStreamError = state ? state.streamError : null;
  const activeStreamErrorSource = state ? state.streamErrorSource : null;
  const streaming = state ? state.streaming : false;
  const streamingMsgId = state ? state.streamingMsgId : null;
  const profileLocked = messages.length > 0;
  const lastMessage = messages[messages.length - 1] || null;
  const hiddenStreamErrorMessageIdsSet = React.useMemo(
    () => hiddenStreamErrorMessageIds(messages, activeStreamError, activeStreamErrorSource),
    [messages, activeStreamError, activeStreamErrorSource]
  );
  const feedMessages = React.useMemo(
    () => hiddenStreamErrorMessageIdsSet.size
      ? messages.filter(m => !hiddenStreamErrorMessageIdsSet.has(m.id))
      : messages,
    [messages, hiddenStreamErrorMessageIdsSet]
  );
  const pinnedMessages = React.useMemo(
    () => feedMessages.filter(m => m && m.pinned && (m.role === 'user' || m.role === 'assistant' || m.role === 'system')),
    [feedMessages]
  );
  const messageRefs = React.useRef(new Map());
  const pinFocusTimerRef = React.useRef(null);
  const [pinStripIndex, setPinStripIndex] = React.useState(0);
  const [focusedPinId, setFocusedPinId] = React.useState(null);
  const setMessageRef = React.useCallback((id, node) => {
    if (!id) return;
    if (node) messageRefs.current.set(id, node);
    else messageRefs.current.delete(id);
  }, []);

  React.useEffect(() => {
    setPinStripIndex(0);
    setFocusedPinId(null);
    if (pinFocusTimerRef.current) {
      clearTimeout(pinFocusTimerRef.current);
      pinFocusTimerRef.current = null;
    }
  }, [convId]);

  React.useEffect(() => () => {
    if (pinFocusTimerRef.current) clearTimeout(pinFocusTimerRef.current);
  }, []);

  React.useEffect(() => {
    setPinStripIndex(index => Math.min(index, Math.max(pinnedMessages.length - 1, 0)));
  }, [pinnedMessages.length]);

  const jumpToPinnedMessage = React.useCallback((messageId, index) => {
    if (typeof index === 'number') setPinStripIndex(index);
    const node = messageRefs.current.get(messageId);
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    setFocusedPinId(messageId);
    if (pinFocusTimerRef.current) clearTimeout(pinFocusTimerRef.current);
    pinFocusTimerRef.current = setTimeout(() => {
      setFocusedPinId(null);
      pinFocusTimerRef.current = null;
    }, 1600);
  }, []);

  const toggleMessagePin = React.useCallback(async (message) => {
    if (!message || !message.id || message.id === streamingMsgId) return;
    try {
      await StreamStore.setMessagePinned(convId, message.id, !message.pinned);
    } catch (err) {
      toast.error({
        title: 'Pin update failed',
        message: (err && err.message) || 'The message pin could not be saved.',
      });
    }
  }, [convId, streamingMsgId, toast]);

  /* Elapsed = time since the preceding user message in the feed. Walks
     backward from each assistant message; caps at 1 h to match V1
     `rendering.js:201-210`. One pass per render is fine — the feed is
     bounded and the memo hides it behind `messages` identity. */
  const elapsedByMsgId = React.useMemo(() => {
    const map = new Map();
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'assistant' || !m.timestamp) continue;
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j];
        if (prev.role === 'user' && prev.timestamp) {
          const delta = new Date(m.timestamp).getTime() - new Date(prev.timestamp).getTime();
          if (delta > 0 && delta < 3600000) map.set(m.id, delta);
          break;
        }
      }
    }
    return map;
  }, [messages]);

  // Auto-scroll the feed to the bottom on new content within the active conv
  const resettingDep = !!(state && state.resetting);
  const feedScrollKey = [
    convId,
    messages.length,
    lastMessage && lastMessage.id,
    lastMessage && (lastMessage.content || '').length,
    streaming ? 'streaming' : 'idle',
    resettingDep ? 'resetting' : 'ready',
  ].join(':');
  React.useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feedScrollKey]);

  function onKeyDown(e){
    if (e.key !== 'Enter' || e.shiftKey || e.altKey) return;
    const isMeta = e.metaKey || e.ctrlKey;
    e.preventDefault();
    if (isMeta) {
      /* ⌘/Ctrl+Enter always enqueues — matches the "queues behind current
         run" composer hint. Works whether or not a stream is in flight. */
      if (canEnqueue || canSend) doEnqueueOrSend(/* preferQueue */ true);
      return;
    }
    /* Plain Enter sends when idle, enqueues when the agent is busy. */
    if (canSend) doSend();
    else if (canEnqueue) doEnqueue();
  }

  function doEnqueueOrSend(preferQueue){
    if (preferQueue && hasContent && !sending && !awaiting && !hasUploadingFiles) {
      const text = (input || '').trim();
      const atts = pendingAttachments.filter(f => f.status === 'done').map(f => f.result).filter(Boolean);
      StreamStore.enqueue(convId, text, atts);
      StreamStore.setInput(convId, '');
      StreamStore.clearPendingAttachments(convId);
      return;
    }
    if (canSend) doSend();
  }

  if (!state || state.loadError) {
    return (
      <section className="main">
        <div className="feed"><div className="feed-inner" style={{padding:"40px 24px"}}>
          <div className="u-dim" style={{fontSize:13}}>
            {state && state.loadError
              ? `Failed to load conversation: ${state.loadError}`
              : 'Loading…'}
          </div>
        </div></div>
      </section>
    );
  }

  const { conv, input, sending, streamError, usage, pendingInteraction, respondPending } = state;
  const pendingAttachments = state.pendingAttachments || [];
  const queue = state.queue || [];
  const queueSuspended = !!state.queueSuspended;
  const resetting = !!state.resetting;
  const hasUploadingFiles = pendingAttachments.some(f => f.status === 'uploading');
  const hasDoneFiles = pendingAttachments.some(f => f.status === 'done');

  if (!conv) {
    return (
      <section className="main">
        <div className="feed"><div className="feed-inner" style={{padding:"40px 24px"}}>
          <div className="u-dim" style={{fontSize:13}}>Loading…</div>
        </div></div>
      </section>
    );
  }

  const wsLabel = conv.workingDir
    ? conv.workingDir.split('/').filter(Boolean).slice(-2).join('/')
    : 'workspace';
  const awaiting = !!pendingInteraction;
  const topbarCliProfileId = profileLocked
    ? (conv.cliProfileId || null)
    : (state.composerCliProfileId || conv.cliProfileId || null);
  const topbarProfile = topbarCliProfileId
    ? cliProfiles.find(profile => profile && profile.id === topbarCliProfileId)
    : null;
  const topbarBackendCandidate = profileLocked
    ? conv.backend
    : (state.composerBackend || conv.backend);
  const topbarBackendId = topbarProfile
    ? (profileLocked ? topbarBackendCandidate : backendIdForProfile(topbarProfile))
    : profileLocked
      ? conv.backend
      : (state.composerBackend || conv.backend);
  const goalCapability = goalCapabilityForBackend(backends, topbarBackendId);
  const goalCapable = goalCapability.set === true;
  const goalMode = goalCapable && !!state.goalMode;
  const activeGoal = state.goal || null;
  const hasContent = !!(input || '').trim() || hasDoneFiles;
  const effectiveHasContent = goalMode ? !!(input || '').trim() : hasContent;
  const canSend = effectiveHasContent && !sending && !streaming && !awaiting && !hasUploadingFiles;
  /* While the agent is streaming, Enter enqueues instead of sending. The
     send button turns into a stop-styled affordance; clicking it enqueues
     whatever is in the composer so the user can stack follow-ups. */
  const canEnqueue = hasContent && !sending && !awaiting && !hasUploadingFiles && streaming;

  function handleDragEnter(e){
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setDragOver(true);
  }
  function handleDragOver(e){
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }
  function handleDragLeave(){
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragOver(false);
  }
  function handleDrop(e){
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOver(false);
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) StreamStore.addAttachments(convId, files);
  }
  function openFilePicker(){ if (fileInputRef.current) fileInputRef.current.click(); }
  function onPickFiles(e){
    const files = Array.from(e.target.files || []);
    if (files.length) StreamStore.addAttachments(convId, files);
    e.target.value = '';
  }
  /* Clipboard parity with V1: pasted image files become attachments (renamed
     to avoid collisions with prior pastes), and pasted text ≥1000 chars is
     converted into a synthesized .txt file named pasted-text-<ts>.txt so the
     composer stays readable. Shorter text falls through to the default
     textarea paste. */
  function onPaste(e){
    const items = (e.clipboardData && e.clipboardData.items) || null;
    if (items) {
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            const ts = Date.now();
            const ext = file.name && file.name.includes('.') ? '.' + file.name.split('.').pop() : '.png';
            const baseName = file.name ? file.name.replace(/\.[^.]+$/, '') : 'pasted-image';
            const uniqueName = baseName + '-' + ts + '-' + (files.length + 1) + ext;
            files.push(new File([file], uniqueName, { type: file.type }));
          }
        }
      }
      if (files.length) {
        e.preventDefault();
        StreamStore.addAttachments(convId, files);
        return;
      }
    }
    const pastedText = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (pastedText && pastedText.length >= 1000) {
      e.preventDefault();
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ts = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
        + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
      const textFile = new File([pastedText], 'pasted-text-' + ts + '.txt', { type: 'text/plain' });
      StreamStore.addAttachments(convId, [textFile]);
    }
  }

  /* Reverse a paste-to-attachment: read the synthesized .txt blob back, splice
     it into the composer at the current cursor, then drop the attachment. Only
     wired for fresh pasted-text-*.txt entries that still have a Blob in memory
     (rehydrated entries lose their Blob, so dissolve isn't offered there).
     Confirm before inserting >50KB so a huge dump doesn't surprise the user. */
  async function dissolveAttachment(entry){
    if (!entry || !(entry.file instanceof Blob)) return;
    let text = '';
    try { text = await entry.file.text(); } catch { return; }
    if (text.length > 50000) {
      const ok = await dialog.confirm({
        title: 'Inline this text into the message?',
        body: text.length.toLocaleString() + ' characters will be inserted into the composer.',
        confirmLabel: 'Inline',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
    }
    insertAtComposerCursor(text);
    StreamStore.removeAttachment(convId, entry.id);
  }

  /* Splice text into the composer at the current cursor position (or at the
     end if the textarea isn't focused). Restores the caret after the React
     re-render so the user can keep typing immediately. Shared by attachment
     dissolve and OCR. */
  function insertAtComposerCursor(text){
    if (!text) return;
    const ta = composerTextRef.current;
    const current = (ta ? ta.value : (StreamStore.getState(convId) || {}).input) || '';
    let nextValue;
    let caret;
    if (ta && typeof ta.selectionStart === 'number') {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      nextValue = current.slice(0, start) + text + current.slice(end);
      caret = start + text.length;
    } else {
      nextValue = current + text;
      caret = nextValue.length;
    }
    StreamStore.setInput(convId, nextValue);
    requestAnimationFrame(() => {
      const t = composerTextRef.current;
      if (!t) return;
      t.focus();
      try { t.setSelectionRange(caret, caret); } catch {}
    });
  }

  /* OCR a pasted screenshot to Markdown via a one-shot CLI call and splice
     the result at the cursor. The original image attachment stays put — the
     user decides whether to remove it (e.g. text-only screenshot) or keep it
     (mixed text+diagram, where the model still benefits from seeing the
     visual). The result is cached on the attachment so re-clicks are free. */
  async function ocrAttachment(entry){
    if (!entry || !entry.result || entry.result.kind !== 'image') return;
    try {
      const markdown = await StreamStore.ocrAttachment(convId, entry.id);
      if (!markdown) {
        toast.error('OCR returned no text');
        return;
      }
      insertAtComposerCursor(markdown);
    } catch (err) {
      toast.error('OCR failed: ' + (err.message || 'unknown error'));
    }
  }

  function doSend(){
    if (!canSend) return;
    const text = (input || '').trim();
    if (handleGoalSlash(text)) return;
    if (goalMode) {
      StreamStore.setGoal(convId, text);
      return;
    }
    StreamStore.send(convId, text);
  }

  function handleGoalSlash(text){
    if (!text || !/^\/goal(?:\s|$)/i.test(text)) return false;
    if (!goalCapable) {
      const backendLabel = (backends.find(b => b && b.id === topbarBackendId) || {}).label || topbarBackendId || 'this backend';
      toast.error('Goals are not supported by ' + backendLabel);
      return true;
    }
    const arg = text.replace(/^\/goal\b/i, '').trim();
    if (!arg) {
      StreamStore.setInput(convId, '');
      StreamStore.setGoalMode(convId, true);
      return true;
    }
    const command = arg.toLowerCase();
    StreamStore.setInput(convId, '');
    if (command === 'pause') {
      if (!goalCapability.pause) {
        const backendLabel = (backends.find(b => b && b.id === topbarBackendId) || {}).label || topbarBackendId || 'this backend';
        toast.error('Goal pause is not supported by ' + backendLabel);
        return true;
      }
      StreamStore.pauseGoal(convId);
      return true;
    }
    if (command === 'resume') {
      if (!goalCapability.resume) {
        const backendLabel = (backends.find(b => b && b.id === topbarBackendId) || {}).label || topbarBackendId || 'this backend';
        toast.error('Goal resume is not supported by ' + backendLabel);
        return true;
      }
      StreamStore.resumeGoal(convId);
      return true;
    }
    if (command === 'clear') {
      StreamStore.clearGoal(convId);
      return true;
    }
    StreamStore.setGoal(convId, arg);
    return true;
  }
  /* Enqueue the current composer contents as a QueuedMessage behind the
     live run. Attachments detach from pendingAttachments and ride the
     queue entry directly; the server copies already live in artifacts/. */
  function doEnqueue(){
    if (!canEnqueue) return;
    const text = (input || '').trim();
    const atts = pendingAttachments.filter(f => f.status === 'done').map(f => f.result).filter(Boolean);
    StreamStore.enqueue(convId, text, atts);
    StreamStore.setInput(convId, '');
    StreamStore.clearPendingAttachments(convId);
  }
  function doStop(){
    if (!streaming) return;
    StreamStore.stopStream(convId);
  }

  async function handleDownload(){
    window.open(AgentApi.chatUrl('conversations/' + encodeURIComponent(convId) + '/download'), '_blank', 'noopener');
  }

  async function handleReset(anchor){
    if (streaming || sending) return;
    const ok = await dialog.confirm({
      anchor,
      title: 'Reset this conversation?',
      body: 'The current session ends and a new one starts. Past messages remain in the session history.',
      confirmLabel: 'Reset',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    const success = await StreamStore.reset(convId);
    if (success) toast.success('Session reset');
  }

  async function handleArchive(anchor){
    if (streaming || sending) return;
    const ok = await dialog.confirm({
      anchor,
      title: `Archive "${conv.title || 'Untitled'}"?`,
      body: 'It will disappear from the active sidebar but can be restored later.',
      confirmLabel: 'Archive',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    const result = await StreamStore.archive(convId);
    if (result && onArchived) onArchived();
  }

  async function handleUnarchive(){
    if (streaming || sending) return;
    try {
      await AgentApi.restoreConversation(convId);
      StreamStore.patchConv(convId, { archived: false });
      /* Conv leaves whatever view the sidebar is showing (archived view
         only, since you can't unarchive an active conv). */
      StreamStore.removeConvListItem(convId);
      toast.success('Conversation restored');
    } catch (err) {
      await dialog.alert({ variant: 'error', title: 'Restore failed', body: err.message || String(err) });
    }
  }

  async function handleDelete(anchor){
    if (streaming || sending) return;
    const ok = await dialog.confirm({
      anchor,
      title: `Delete "${conv.title || 'Untitled'}"?`,
      body: 'This permanently removes the conversation and all its sessions. This cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    try {
      await AgentApi.deleteConversation(convId);
      StreamStore.removeConvListItem(convId);
      if (onDeleted) onDeleted();
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Delete failed', body: err.message || String(err) });
    }
  }

  /* Inline title rename — hover surfaces the affordance, click opens an
     input. Enter saves (PUT /conversations/:id), Escape cancels. */
  function startTitleEdit(){
    if (!conv || savingTitle) return;
    setTitleDraft(conv.title || '');
    setEditingTitle(true);
  }
  async function saveTitle(){
    if (!conv) { setEditingTitle(false); return; }
    const next = (titleDraft || '').trim();
    if (!next || next === (conv.title || '')) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    try {
      const updated = await AgentApi.renameConversation(convId, next);
      if (updated && updated.title) {
        StreamStore.patchConv(convId, { title: updated.title });
        StreamStore.patchConvListItem(convId, { title: updated.title });
      }
      setEditingTitle(false);
    } catch (err) {
      await dialog.alert({ variant: 'error', title: 'Rename failed', body: err.message || String(err) });
    } finally {
      setSavingTitle(false);
    }
  }

  return (
    <section
      className={"main" + (dragOver ? " main-dragover" : "")}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver ? (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-inner">Drop files to attach</div>
        </div>
      ) : null}
      <div className="topbar">
        <div className="crumbs">
          <span>{wsLabel}</span>
          <span className="sep">/</span>
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className="topbar-title-edit"
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); saveTitle(); }
                else if (e.key === 'Escape') { e.preventDefault(); setEditingTitle(false); }
              }}
              disabled={savingTitle}
            />
          ) : (
            <span
              className="here topbar-title"
              onClick={startTitleEdit}
              title="Click to rename"
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startTitleEdit(); } }}
            >
              {conv.title || 'Untitled'}
            </span>
          )}
        </div>
        <div className="right">
          {usage ? <ContextChip backendId={topbarBackendId} cliProfileId={topbarCliProfileId} usage={usage}/> : null}
          <button className="btn ghost" onClick={handleDownload} title="Download as markdown">↓ Download</button>
          <button className="btn ghost" onClick={(e) => handleReset(e.currentTarget)} disabled={streaming || sending || resetting} title="Reset session">{resetting ? '↺ Resetting…' : '↺ Reset'}</button>
          <button className="btn ghost" onClick={() => setSessionsOpen(true)} title="Session history">{Ico.clock(12)} Sessions</button>
          {conv.archived ? (
            <>
              <button className="btn ghost" onClick={handleUnarchive} disabled={streaming || sending} title="Restore conversation">Unarchive</button>
              <button className="btn danger" onClick={(e) => handleDelete(e.currentTarget)} disabled={streaming || sending} title="Delete conversation">Delete</button>
            </>
          ) : (
            <button className="btn danger" onClick={(e) => handleArchive(e.currentTarget)} disabled={streaming || sending} title="Archive conversation">Archive</button>
          )}
        </div>
      </div>

      <div className="feed" ref={feedRef}>
        <PinStrip
          messages={pinnedMessages}
          currentIndex={pinStripIndex}
          onSelect={jumpToPinnedMessage}
        />
        <div className="feed-inner">
          {messages.length === 0 && !streaming && (
            <div className="u-dim" style={{padding:"24px 12px",fontSize:13}}>
              No messages yet. Say hello below.
            </div>
          )}
          <FileViewerContext.Provider value={{ wsHash: conv.workspaceHash || null, convId, workingDir: conv.workingDir || null, openFileViewer, openLightbox }}>
          <AgentIndexProvider messages={feedMessages}>
            {collapseProgressRuns(feedMessages).map(entry => {
              if (entry.kind === 'plain') {
                if (entry.message.role === 'memory') {
                  return (
                    <MemoryUpdateBubble
                      key={entry.message.id}
                      message={entry.message}
                      onOpen={() => {
                        if (!onOpenMemoryUpdate || !conv.workspaceHash) return;
                        onOpenMemoryUpdate(conv.workspaceHash, wsLabel, entry.message.memoryUpdate || null);
                      }}
                    />
                  );
                }
                return (
                  <MessageBubble
                    key={entry.message.id}
                    message={entry.message}
                    isStreaming={streaming && streamingMsgId === entry.message.id}
                    elapsedMs={elapsedByMsgId.get(entry.message.id)}
                    onPinToggle={toggleMessagePin}
                    messageRef={(node) => setMessageRef(entry.message.id, node)}
                    pinFocused={focusedPinId === entry.message.id}
                  />
                );
              }
              if (entry.kind === 'final-with-progress') {
                return (
                  <MessageBubble
                    key={entry.message.id}
                    message={entry.message}
                    isStreaming={streaming && streamingMsgId === entry.message.id}
                    attachedProgress={entry.progressRun}
                    elapsedMs={elapsedByMsgId.get(entry.message.id)}
                    onPinToggle={toggleMessagePin}
                    messageRef={(node) => setMessageRef(entry.message.id, node)}
                    pinFocused={focusedPinId === entry.message.id}
                  />
                );
              }
              // progress-trailing
              return (
                <ProgressBreadcrumbBubble
                  key={entry.progressRun[0].id}
                  progressRun={entry.progressRun}
                />
              );
            })}
          </AgentIndexProvider>
          </FileViewerContext.Provider>
          {state.planModeActive && !pendingInteraction ? <PlanModeBanner/> : null}
          {pendingInteraction ? (
            <InteractionCard
              convId={convId}
              interaction={pendingInteraction}
              respondPending={!!respondPending}
            />
          ) : null}
          {streamError && (
            <StreamErrorCard
              convId={convId}
              error={streamError}
              source={state.streamErrorSource}
              queueLength={queue.length}
              messages={messages}
            />
          )}
          {resetting ? <ResetProgressBubble/> : null}
        </div>
      </div>

      <div className="composer">
        <div className="composer-inner">
          {activeGoal ? (
            <GoalStrip
              convId={convId}
              goal={activeGoal}
              streaming={streaming}
              sending={sending}
            />
          ) : null}
          <div className="composer-box">
            <textarea
              ref={composerTextRef}
              rows={3}
              placeholder={
                awaiting
                  ? 'Answer the prompt above to continue…'
                  : streaming ? 'Agent is running — Enter queues behind the current run.'
                    : goalMode ? 'Set a goal…' : 'Message Agent Cockpit…'
              }
              value={input || ''}
              onChange={(e)=>StreamStore.setInput(convId, e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              disabled={awaiting}
              style={{
                width:"100%",
                border:0,
                outline:"none",
                background:"transparent",
                color:"var(--text)",
                resize:"none",
                fontFamily:"inherit",
                fontSize:14,
                lineHeight:1.5,
                padding:"12px 14px",
                display:"block",
              }}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={onPickFiles}
              style={{display:"none"}}
            />
            {pendingAttachments.length ? (
              <AttTray
                convId={convId}
                attachments={pendingAttachments}
                onRemove={(id) => StreamStore.removeAttachment(convId, id)}
                onDissolve={dissolveAttachment}
                onOcr={ocrAttachment}
                onAdd={openFilePicker}
              />
            ) : null}
            {queue.length && queueSuspended ? (
              <SuspendedQueueBanner
                count={queue.length}
                onResume={() => StreamStore.resumeSuspendedQueue(convId)}
                onClear={() => StreamStore.clearQueue(convId)}
              />
            ) : null}
            {queue.length ? (
              <QueueStack
                convId={convId}
                queue={queue}
                onClear={() => StreamStore.clearQueue(convId)}
                onRemove={(i) => StreamStore.removeFromQueue(convId, i)}
                onMoveUp={(i) => StreamStore.reorderQueue(convId, i, i - 1)}
                onMoveDown={(i) => StreamStore.reorderQueue(convId, i, i + 1)}
              />
            ) : null}
            <div className="composer-foot">
              <ComposerPicks
                convId={convId}
                backends={backends}
                cliProfiles={cliProfiles}
                composerCliProfileId={state.composerCliProfileId || conv.cliProfileId || null}
                composerBackend={state.composerBackend || conv.backend || null}
                composerModel={state.composerModel || conv.model || null}
                composerEffort={state.composerEffort || conv.effort || null}
                composerServiceTier={state.composerServiceTier != null ? state.composerServiceTier : (conv.serviceTier || 'default')}
                profileLocked={profileLocked}
                disabled={awaiting || sending}
              />
              <span className="attach">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={openFilePicker}
                  disabled={awaiting}
                  title="Attach files"
                  aria-label="Attach files"
                  style={{padding:"4px 8px"}}
                >
                  {Ico.paperclip(12)}
                  <span style={{fontSize:11.5}}>Attach…</span>
                </button>
              </span>
              <ComposerNotifIcon conv={conv} convId={convId}/>
              <ComposerMemoryReviewIcon conv={conv} workspaceLabel={wsLabel} onOpenMemoryReview={onOpenMemoryReview}/>
              <ComposerContextMapIcon conv={conv} workspaceLabel={wsLabel} onOpenWorkspaceSettings={onOpenWorkspaceSettings}/>
              <ComposerInstructionCompatibilityIcon
                workspaceHash={conv.workspaceHash}
                workspaceLabel={wsLabel}
                onOpenWorkspaceSettings={onOpenWorkspaceSettings}
              />
              <ComposerCliUpdateIcon
                cliProfileId={topbarCliProfileId}
                backendId={topbarBackendId}
                onOpenSettings={onOpenSettings}
              />
              {goalCapable ? (
                <label className={"goal-toggle" + (goalMode ? " active" : "")}>
                  <input
                    type="checkbox"
                    checked={goalMode}
                    onChange={(e) => StreamStore.setGoalMode(convId, e.target.checked)}
                    disabled={awaiting || sending || streaming}
                  />
                  <span>Goal</span>
                </label>
              ) : null}
              {streaming ? (
                hasContent ? (
                  <button
                    className="send"
                    onClick={doEnqueue}
                    disabled={!canEnqueue}
                    title={canEnqueue ? 'Queue behind current run' : 'Agent is running'}
                    aria-label="Queue behind current run"
                    style={!canEnqueue ? {opacity:.5,cursor:"not-allowed"} : undefined}
                  >
                    {Ico.up(14)}
                  </button>
                ) : (
                  <button
                    className="send stop"
                    onClick={doStop}
                    title="Stop agent"
                    aria-label="Stop agent"
                  >
                    {Ico.stop(14)}
                  </button>
                )
              ) : (
                <button
                  className="send"
                  onClick={doSend}
                  disabled={!canSend}
                  title={goalMode ? 'Set goal' : 'Send'}
                  aria-label={goalMode ? 'Set goal' : 'Send'}
                  style={!canSend ? {opacity:.4,cursor:"not-allowed"} : undefined}
                >
                  {Ico.up(14)}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {sessionsOpen ? (
        <React.Suspense fallback={null}>
          <SessionsModal
            open={true}
            convId={convId}
            currentSessionNumber={conv.sessionNumber || null}
            currentMessages={messages}
            onClose={() => setSessionsOpen(false)}
          />
        </React.Suspense>
      ) : null}
      {fileViewer ? (
        <FileViewerPanel
          filename={fileViewer.filename}
          viewPath={fileViewer.viewPath}
          imageUrl={fileViewer.imageUrl}
          displayPath={fileViewer.displayPath || fileViewer.filename}
          line={fileViewer.line || null}
          onClose={closeFileViewer}
        />
      ) : null}
      {lightbox ? (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={closeLightbox}/>
      ) : null}
    </section>
  );
}

/* Fullscreen overlay for inline chat-message images. Clicking the backdrop
   or pressing Escape closes it. The `<img>` itself stops propagation so
   clicks on the image don't dismiss. Styling reuses `.kb-lightbox*`. */
function ImageLightbox({ src, alt, onClose }){
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="kb-lightbox" role="dialog" aria-label="Image preview" onClick={onClose}>
      <img src={src} alt={alt || ''} onClick={(e) => e.stopPropagation()}/>
      <button className="kb-lightbox-close" onClick={onClose}>Close</button>
    </div>
  );
}

/* Escape plain text for HTML attribute / text content contexts. */
function escHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Line threshold above which a code block becomes collapsible. V1 uses 50;
   our tracking doc specifies 200 to favor showing full content on the
   long-form pages we care about. */
const CODE_COLLAPSE_LINES = 200;

/* Custom marked renderer for code blocks — produces the chrome that
   TextSegment's useEffect later wires with hljs highlighting + Copy +
   Show more/less. Duck-types the renderer arg so we survive marked v12
   (`code, lang`) and v15 (`{text, lang}`) without branching on version. */
function buildMarkedRenderer(){
  const renderer = new marked.Renderer();
  renderer.code = function(code, language){
    let codeText, lang;
    if (typeof code === 'object' && code !== null) {
      codeText = code.text || '';
      lang = code.lang || language || '';
    } else {
      codeText = code || '';
      lang = language || '';
    }
    const lineCount = codeText.split('\n').length;
    const collapsible = lineCount > CODE_COLLAPSE_LINES;
    const langLabel = lang ? escHtml(lang) : 'code';
    const langClass = lang ? ' class="language-' + escHtml(lang) + '"' : '';
    const cls = 'code-block' + (collapsible ? ' collapsible collapsed' : '');
    return (
      '<div class="' + cls + '">' +
        '<div class="code-header">' +
          '<span class="code-lang">' + langLabel + '</span>' +
          '<button type="button" class="code-copy" data-code-copy="1">Copy</button>' +
        '</div>' +
        '<pre><code' + langClass + '>' + escHtml(codeText) + '</code></pre>' +
        (collapsible
          ? '<button type="button" class="code-toggle" data-code-toggle="1">Show more</button>'
          : '') +
      '</div>'
    );
  };
  return renderer;
}

function renderMarkdown(md){
  const renderer = buildMarkedRenderer();
  const raw = marked.parse(md || '', { breaks: true, gfm: true, renderer });
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['data-code-copy', 'data-code-toggle'],
  });
}

/* User bubble body. Strips the legacy `[Uploaded files: /abs, …]` tag from the
   persisted message text and renders cleaned text + inline image thumbs +
   cards for non-image attachments. Images click through to the lightbox;
   non-image cards get View (→ FileViewerPanel) and Download buttons. */
function UserMessageBody({ content }){
  const { convId, openFileViewer, openLightbox } = React.useContext(FileViewerContext);
  const { cleaned, paths } = extractUploadedFiles(content);
  const attachments = paths.map(filePath => {
    const filename = (filePath.split('/').pop() || filePath);
    const isImage = CHAT_IMAGE_EXTS.test(filename);
    return { filePath, filename, isImage };
  });
  const imageUrl = (filename) => convId
    ? AgentApi.chatUrl('conversations/' + encodeURIComponent(convId) + '/files/' + encodeURIComponent(filename))
    : null;
  return (
    <>
      {cleaned ? <div style={{whiteSpace:"pre-wrap"}}>{cleaned}</div> : null}
      {attachments.length ? (
        <div className="file-cards">
          {attachments.filter(a => !a.isImage).map(a => (
            <UploadedFileCard
              key={a.filePath}
              filePath={a.filePath}
              convId={convId}
              onOpenView={openFileViewer}
            />
          ))}
          {attachments.filter(a => a.isImage).map(a => {
            const src = imageUrl(a.filename);
            if (!src) return null;
            return (
              <button
                key={a.filePath}
                type="button"
                className="user-image-thumb"
                onClick={() => openLightbox && openLightbox(src, a.filename)}
                title={a.filename}
              >
                <img src={src} alt={a.filename}/>
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

function PinStrip({ messages, currentIndex, onSelect }){
  if (!messages.length) return null;
  const safeIndex = Math.min(Math.max(currentIndex || 0, 0), messages.length - 1);
  const active = messages[safeIndex];
  const go = (index) => {
    const next = messages[index];
    if (!next) return;
    onSelect(next.id, index);
  };
  const prevIndex = (safeIndex - 1 + messages.length) % messages.length;
  const nextIndex = (safeIndex + 1) % messages.length;
  return (
    <div className="pin-strip" aria-label="Pinned messages">
      <button
        type="button"
        className="pin-strip-label"
        onClick={() => go(safeIndex)}
        title="Jump to pinned message"
      >
        <span className="pin-strip-icon">{Ico.pin(13)}</span>
        <span>PINNED</span>
        <span className="pin-strip-count">{messages.length}</span>
      </button>
      <button
        type="button"
        className="pin-strip-item"
        onClick={() => go(safeIndex)}
        title="Jump to pinned message"
      >
        <span className="pin-strip-src">{pinMessageSource(active)}</span>
        <span>{pinMessagePreview(active)}</span>
      </button>
      <div className="pin-strip-nav" aria-label="Pinned message navigation">
        <button type="button" onClick={() => go(prevIndex)} aria-label="Previous pinned message" title="Previous pinned message">
          {Ico.chevU(13)}
        </button>
        <span className="pin-strip-dots" aria-hidden="true">
          {messages.map((message, index) => (
            <i key={message.id} className={index === safeIndex ? 'active' : ''}/>
          ))}
        </span>
        <button type="button" onClick={() => go(nextIndex)} aria-label="Next pinned message" title="Next pinned message">
          {Ico.chevD(13)}
        </button>
      </div>
    </div>
  );
}

function pinMessageSource(message){
  if (!message) return 'Message';
  if (message.role === 'user') return 'You';
  if (message.role === 'system') return 'System';
  return message.backend || 'Assistant';
}

function pinMessagePreview(message){
  const raw = (message && message.content) || '';
  const delivered = extractFileDeliveries(raw).cleaned;
  const uploaded = extractUploadedFiles(delivered).cleaned;
  return uploaded.replace(/\s+/g, ' ').trim() || 'Pinned message';
}

function PinnedTag(){
  return (
    <span className="msg-pin-tag" title="Pinned message">
      <span className="msg-pin-tag-icon">{Ico.up(9)}</span>
      <span>PINNED</span>
    </span>
  );
}

function goalEventTitle(event){
  if (!event) return 'Goal updated';
  if (event.kind === 'set') return 'Goal set';
  if (event.kind === 'resumed') return 'Goal resumed';
  if (event.kind === 'paused') return 'Goal paused';
  if (event.kind === 'achieved') return 'Goal achieved';
  if (event.kind === 'budget_limited') return 'Goal budget limited';
  if (event.kind === 'cleared') return 'Goal cleared';
  return goalStatusLabel(event.status || 'unknown');
}

function GoalEventCard({ message }){
  const event = message.goalEvent || {};
  const objective = event.objective || (event.goal && event.goal.objective) || '';
  const reason = event.reason || (event.goal && event.goal.lastReason) || '';
  const backend = event.backend || message.backend || '';
  const kind = String(event.kind || event.status || 'updated').replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <div className={"goal-event-card kind-" + kind}>
      <div className="goal-event-row">
        <span className="goal-event-title">{goalEventTitle(event)}</span>
        {backend ? <span className="goal-event-backend">{backend}</span> : null}
      </div>
      {objective ? <div className="goal-event-objective">{objective}</div> : null}
      {reason ? <div className="goal-event-reason">{reason}</div> : null}
    </div>
  );
}

function MessageBubble({ message, isStreaming, attachedProgress, elapsedMs, onPinToggle, messageRef, pinFocused }){
  const isUser = message.role === 'user';
  const isGoalEvent = !!message.goalEvent;
  const contentRef = React.useRef(null);
  const [copied, setCopied] = React.useState(null);
  const hasContent = !!(message.content && message.content.trim());
  const isPinned = !!message.pinned;

  function copy(mode){
    let text = '';
    if (mode === 'md') {
      text = message.content || '';
    } else {
      const el = contentRef.current;
      text = el ? (el.textContent || '') : (message.content || '');
    }
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(mode);
      setTimeout(() => setCopied(null), 1500);
    }).catch(() => {});
  }

  const showActions = !isStreaming && !!message.id && (hasContent || !!(message.contentBlocks && message.contentBlocks.length) || !!message.streamError);
  const rootClass = [
    'msg',
    isUser ? 'msg-user' : 'msg-agent',
    isGoalEvent ? 'msg-goal-event' : '',
    message.streamError ? 'msg-stream-error' : '',
    isPinned ? 'msg-pinned' : '',
    pinFocused ? 'msg-pin-focus' : '',
  ].filter(Boolean).join(' ');

  return (
    <div ref={messageRef} className={rootClass}>
      {isUser ? (
        <span className="avatar">DY</span>
      ) : (
        <AssistantAvatar backend={message.backend}/>
      )}
      <div className="body">
        {isUser ? (
          <div>
            {isPinned ? <div className="msg-pin-row"><PinnedTag/></div> : null}
            <div ref={contentRef}>
              <UserMessageBody content={message.content || ''}/>
            </div>
          </div>
        ) : (
          <>
            <div className="head">
              <span className="who">{isGoalEvent ? 'Goal' : (message.backend || 'assistant')}</span>
              <span>·</span>
              <span>{isStreaming ? 'streaming…' : msgTime(message.timestamp)}</span>
              {isPinned ? <PinnedTag/> : null}
              {elapsedMs != null && !isStreaming ? (
                <span className="msg-elapsed" title="Time since the previous user message">{formatMsgElapsed(elapsedMs)}</span>
              ) : null}
            </div>
            {!isGoalEvent && attachedProgress && attachedProgress.length ? (
              <ProgressBreadcrumb progressRun={attachedProgress}/>
            ) : null}
            <div ref={contentRef}>
              {isGoalEvent ? <GoalEventCard message={message}/> : <AssistantBody message={message} isStreaming={isStreaming}/>}
            </div>
          </>
        )}
      </div>
      {showActions ? (
        <div className="msg-actions" role="toolbar" aria-label="Message actions">
          <Tip content={copied === 'msg' ? 'Copied' : 'Copy'} delay={120}>
            <button
              type="button"
              className="msg-action"
              onClick={() => copy('msg')}
              aria-label={copied === 'msg' ? 'Copied message' : 'Copy message'}
            >
              {Ico.copy(14)}
            </button>
          </Tip>
          <Tip content={copied === 'md' ? 'Copied Markdown' : 'Copy Markdown'} delay={120}>
            <button
              type="button"
              className="msg-action"
              onClick={() => copy('md')}
              aria-label={copied === 'md' ? 'Copied markdown' : 'Copy raw markdown'}
            >
              {Ico.markdown(16)}
            </button>
          </Tip>
          <Tip content={isPinned ? 'Unpin' : 'Pin'} delay={120}>
            <button
              type="button"
              className={`msg-action msg-action-pin ${isPinned ? 'pinned' : ''}`}
              onClick={() => onPinToggle && onPinToggle(message)}
              aria-label={isPinned ? 'Unpin message' : 'Pin message'}
              aria-pressed={isPinned}
            >
              {Ico.pin(14)}
            </button>
          </Tip>
        </div>
      ) : null}
    </div>
  );
}

function ProgressBreadcrumbBubble({ progressRun }){
  const firstBackend = (progressRun && progressRun[0] && progressRun[0].backend) || null;
  return (
    <div className="msg msg-agent">
      <AssistantAvatar backend={firstBackend}/>
      <div className="body">
        <div className="head">
          <span className="who">progress</span>
          <span>·</span>
          <span>{progressRun.length} segment{progressRun.length !== 1 ? 's' : ''}</span>
        </div>
        <ProgressBreadcrumb progressRun={progressRun}/>
      </div>
    </div>
  );
}

/* Transient progress bubble shown at the foot of the feed while
   StreamStore.reset is in flight. The backend archives the session,
   captures memory, and re-initialises — slow enough that a visible
   indicator is needed. Mirrors V1's in-feed "Archiving session…" bubble. */
function ResetProgressBubble(){
  return (
    <div className="msg msg-agent">
      <AssistantAvatar backend={null}/>
      <div className="body">
        <div className="head">
          <span className="who">Agent Cockpit</span>
        </div>
        <div className="reset-progress">
          <span className="typing-dots" aria-hidden="true">
            <span className="typing-dot"/>
            <span className="typing-dot"/>
            <span className="typing-dot"/>
          </span>
          <span>Archiving session…</span>
        </div>
      </div>
    </div>
  );
}

function ProgressBreadcrumb({ progressRun }){
  const [open, setOpen] = React.useState(false);
  const count = progressRun.length;
  let preview = '';
  for (const m of progressRun) {
    const blocks = deriveBlocks(m);
    const textBlock = blocks.find(b => b.type === 'text' && b.content);
    if (textBlock) {
      preview = textBlock.content.trim().split('\n')[0].slice(0, 80);
      if (preview) break;
    }
  }
  return (
    <div className="progress-breadcrumb">
      <button
        type="button"
        className="progress-head"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <span className="marker"/>
        <span className="label">
          {count} segment{count !== 1 ? 's' : ''}
          {preview ? <> · <span className="preview">{preview}</span></> : null}
        </span>
        <span className="chev" style={{transform: open ? 'rotate(180deg)' : undefined}}>
          {Ico.chev(12)}
        </span>
      </button>
      {open ? (
        <div className="progress-body">
          {progressRun.map((m, i) => (
            <div key={m.id || i} className="progress-row">
              <AssistantBody message={m}/>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AssistantBody({ message, isStreaming }){
  const blocks = deriveBlocks(message);
  if (blocks.length === 0) {
    if (isStreaming) {
      return <div className="prose" style={{opacity:.6}}>…</div>;
    }
    return null;
  }
  const segments = groupBlocksForRender(blocks);
  const showProcessing = isStreaming && shouldShowProcessing(blocks);
  return (
    <>
      {segments.map((seg, i) => renderSegment(seg, i))}
      {showProcessing ? <ProcessingIndicator/> : null}
    </>
  );
}

/* Render a "Processing…" spinner once at least one tool has finished, no tool
   is currently running, and no text has streamed yet for this turn. */
function shouldShowProcessing(blocks){
  let hasCompleted = false;
  let hasRunning = false;
  let hasText = false;
  for (const b of blocks) {
    if (b && b.type === 'tool' && b.activity) {
      const a = b.activity;
      const completed = a.duration != null || !!a.outcome || a.status === 'error';
      if (completed) hasCompleted = true;
      else hasRunning = true;
    } else if (b && b.type === 'text' && b.content && b.content.length) {
      hasText = true;
    } else if (b && b.type === 'artifact') {
      hasText = true;
    }
  }
  return hasCompleted && !hasRunning && !hasText;
}

function ProcessingIndicator(){
  return (
    <div className="processing-indicator">
      <span className="typing-dots" aria-hidden="true">
        <span className="typing-dot"/>
        <span className="typing-dot"/>
        <span className="typing-dot"/>
      </span>
      <span>Processing…</span>
    </div>
  );
}

/* Prefer authoritative contentBlocks; fall back to legacy thinking + toolActivity + content
   for messages saved before the field existed. */
function deriveBlocks(message){
  if (Array.isArray(message.contentBlocks) && message.contentBlocks.length) {
    return message.contentBlocks;
  }
  const legacy = [];
  if (message.thinking) legacy.push({ type: 'thinking', content: message.thinking });
  if (Array.isArray(message.toolActivity)) {
    for (const t of message.toolActivity) legacy.push({ type: 'tool', activity: t });
  }
  if (message.content) legacy.push({ type: 'text', content: message.content });
  return legacy;
}

/* Splits contentBlocks into render segments. Consecutive tool blocks merge into
   one 'tool-run' segment so we can group them (parallel/sequential/agent). */
function groupBlocksForRender(contentBlocks){
  const out = [];
  let toolBuf = [];
  const flush = () => {
    if (toolBuf.length) {
      out.push({ kind: 'tool-run', tools: toolBuf });
      toolBuf = [];
    }
  };
  for (const b of contentBlocks) {
    if (b && b.type === 'tool' && b.activity) {
      toolBuf.push(b.activity);
    } else if (b && b.type === 'text') {
      flush();
      out.push({ kind: 'text', content: b.content || '' });
    } else if (b && b.type === 'thinking') {
      flush();
      out.push({ kind: 'thinking', content: b.content || '' });
    } else if (b && b.type === 'artifact' && b.artifact) {
      flush();
      out.push({ kind: 'artifact', artifact: b.artifact });
    }
  }
  flush();
  return out;
}

function renderSegment(seg, key){
  if (seg.kind === 'text') {
    return <TextSegment key={key} content={seg.content}/>;
  }
  if (seg.kind === 'thinking') {
    return <ThinkingBlock key={key} content={seg.content}/>;
  }
  if (seg.kind === 'tool-run') {
    return <ToolRun key={key} tools={seg.tools}/>;
  }
  if (seg.kind === 'artifact') {
    return <GeneratedArtifact key={key} artifact={seg.artifact}/>;
  }
  return null;
}

function buildWorkspaceFileDescriptor(ref, wsHash){
  if (!ref || !ref.filePath || !wsHash) return null;
  const filename = (ref.filePath.split('/').pop() || ref.filePath);
  const basePath = 'workspaces/' + encodeURIComponent(wsHash) + '/files?path=' + encodeURIComponent(ref.filePath);
  const viewPath = basePath + '&mode=view';
  const downloadUrl = AgentApi.chatUrl(basePath + '&mode=download');
  const isImage = CHAT_IMAGE_EXTS.test(filename);
  return {
    filename,
    viewPath,
    imageUrl: isImage ? downloadUrl : null,
    displayPath: ref.filePath,
    line: ref.line || null,
    column: ref.column || null,
  };
}

function buildConversationArtifactDescriptor(ref, convId){
  if (!ref || !ref.filename || !convId) return null;
  const filename = ref.filename;
  const basePath = 'conversations/' + encodeURIComponent(convId) + '/files/' + encodeURIComponent(filename);
  const viewPath = basePath + '?mode=view';
  const downloadUrl = AgentApi.chatUrl(basePath + '?mode=download');
  const isImage = CHAT_IMAGE_EXTS.test(filename);
  return {
    filename,
    viewPath,
    imageUrl: isImage ? downloadUrl : null,
    displayPath: ref.filePath || filename,
    line: ref.line || null,
    column: ref.column || null,
  };
}

function GeneratedArtifact({ artifact }){
  const { convId, openFileViewer, openLightbox } = React.useContext(FileViewerContext);
  if (!artifact) return null;
  const filename = artifact.filename || (artifact.path || '').split('/').pop() || 'artifact';
  const isImage = (artifact.kind === 'image') || CHAT_IMAGE_EXTS.test(filename);
  const basePath = convId
    ? 'conversations/' + encodeURIComponent(convId) + '/files/' + encodeURIComponent(filename)
    : null;
  const downloadUrl = basePath ? AgentApi.chatUrl(basePath + '?mode=download') : null;
  const rawUrl = basePath ? AgentApi.chatUrl(basePath) : null;
  if (isImage && rawUrl) {
    return (
      <div className="file-cards">
        <button
          type="button"
          className="user-image-thumb generated-image-thumb"
          onClick={() => openLightbox && openLightbox(rawUrl, artifact.title || filename)}
          title={artifact.path || filename}
        >
          <img src={rawUrl} alt={artifact.title || filename}/>
        </button>
        <GeneratedArtifactCard
          artifact={artifact}
          filename={filename}
          viewPath={basePath ? basePath + '?mode=view' : null}
          downloadUrl={downloadUrl}
          imageUrl={rawUrl}
          onOpenView={openFileViewer}
        />
      </div>
    );
  }
  return (
    <div className="file-cards">
      <GeneratedArtifactCard
        artifact={artifact}
        filename={filename}
        viewPath={basePath ? basePath + '?mode=view' : null}
        downloadUrl={downloadUrl}
        imageUrl={null}
        onOpenView={openFileViewer}
      />
    </div>
  );
}

function GeneratedArtifactCard({ artifact, filename, viewPath, downloadUrl, imageUrl, onOpenView }){
  return (
    <div className="file-card" title={artifact.path || filename}>
      <span className="file-card-icon" aria-hidden="true">{Ico.file ? Ico.file(18) : 'File'}</span>
      <span className="file-card-name">{artifact.title || filename}</span>
      <span className="file-card-actions">
        <button
          type="button"
          className="btn ghost file-card-btn"
          onClick={() => onOpenView && onOpenView({
            filename,
            viewPath,
            imageUrl,
            displayPath: artifact.path || filename,
          })}
          disabled={!viewPath || !onOpenView}
        >View</button>
        {downloadUrl ? (
          <a className="btn ghost file-card-btn" href={downloadUrl} download={filename}>Download</a>
        ) : null}
      </span>
    </div>
  );
}

function TextSegment({ content }){
  const { wsHash, convId, workingDir, openFileViewer, openLightbox } = React.useContext(FileViewerContext);
  const { cleaned, files } = extractFileDeliveries(content);
  const proseRef = React.useRef(null);

  /* After marked emits `.code-block` chrome, hljs highlights each `pre code`
     that hasn't been processed yet, and a delegated click handler wires the
     Copy + Show more buttons, local workspace file-link previews, and the
     image-lightbox interception. Re-runs when content changes during
     streaming. Images inside `<a>` are skipped so a linked image still
     navigates instead of zooming. */
  React.useEffect(() => {
    const root = proseRef.current;
    if (!root) return;
    if (hljs) {
      root.querySelectorAll('pre code').forEach(el => {
        if (el.dataset.hljsHighlighted) return;
        try { hljs.highlightElement(el); } catch (e) {}
        el.dataset.hljsHighlighted = '1';
      });
    }
    function onClick(e){
      const copyBtn = e.target.closest && e.target.closest('[data-code-copy]');
      if (copyBtn && root.contains(copyBtn)) {
        const block = copyBtn.closest('.code-block');
        const codeEl = block && block.querySelector('pre code');
        if (codeEl && navigator.clipboard) {
          navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
          }).catch(() => {});
        }
        return;
      }
      const toggleBtn = e.target.closest && e.target.closest('[data-code-toggle]');
      if (toggleBtn && root.contains(toggleBtn)) {
        const block = toggleBtn.closest('.code-block');
        if (!block) return;
        block.classList.toggle('collapsed');
        toggleBtn.textContent = block.classList.contains('collapsed') ? 'Show more' : 'Show less';
        return;
      }
      const link = e.target.closest && e.target.closest('a[href]');
      if (link && root.contains(link)) {
        const href = link.getAttribute('href');
        const artifactRef = resolveConversationArtifactHref(href, convId);
        const artifactDescriptor = buildConversationArtifactDescriptor(artifactRef, convId);
        if (artifactDescriptor && openFileViewer) {
          e.preventDefault();
          openFileViewer(artifactDescriptor);
          return;
        }
        const ref = resolveLocalFileHref(href, workingDir);
        const descriptor = buildWorkspaceFileDescriptor(ref, wsHash);
        if (descriptor && openFileViewer) {
          e.preventDefault();
          openFileViewer(descriptor);
        }
        return;
      }
      const img = e.target.closest && e.target.closest('img');
      if (img && img.src && openLightbox) {
        e.preventDefault();
        openLightbox(img.src, img.alt || '');
      }
    }
    root.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      const artifactRef = resolveConversationArtifactHref(href, convId);
      if (artifactRef) {
        link.classList.add('local-file-link');
        link.title = artifactRef.line ? `Preview ${artifactRef.filename}:${artifactRef.line}` : `Preview ${artifactRef.filename}`;
        return;
      }
      const ref = resolveLocalFileHref(href, workingDir);
      if (!ref) return;
      link.classList.add('local-file-link');
      link.title = ref.line ? `Preview ${ref.filePath}:${ref.line}` : `Preview ${ref.filePath}`;
    });
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [cleaned, convId, openFileViewer, openLightbox, workingDir, wsHash]);

  return (
    <>
      {cleaned ? (
        <div
          ref={proseRef}
          className="prose"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(cleaned) }}
        />
      ) : null}
      {files.length ? (
        <div className="file-cards">
          {files.map((p, i) => (
            <FileDeliveryCard
              key={p + ':' + i}
              filePath={p}
              wsHash={wsHash}
              onOpenView={openFileViewer}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function FileDeliveryCard({ filePath, wsHash, onOpenView }){
  const filename = (filePath.split('/').pop() || filePath);
  const basePath = wsHash
    ? 'workspaces/' + encodeURIComponent(wsHash) + '/files?path=' + encodeURIComponent(filePath)
    : null;
  const viewPath = basePath ? basePath + '&mode=view' : null;
  const downloadUrl = basePath ? AgentApi.chatUrl(basePath + '&mode=download') : null;
  const isImage = CHAT_IMAGE_EXTS.test(filename);
  return (
    <div className="file-card" title={filePath}>
      <span className="file-card-icon" aria-hidden="true">{Ico.file ? Ico.file(18) : '📄'}</span>
      <span className="file-card-name">{filename}</span>
      <span className="file-card-actions">
        <button
          type="button"
          className="btn ghost file-card-btn"
          onClick={() => onOpenView && onOpenView({
            filename,
            viewPath,
            imageUrl: isImage ? downloadUrl : null,
            displayPath: filePath,
          })}
          disabled={!wsHash || !onOpenView}
        >View</button>
        {downloadUrl ? (
          <a className="btn ghost file-card-btn" href={downloadUrl} download={filename}>Download</a>
        ) : null}
      </span>
    </div>
  );
}

/* Card rendered for user-attached files (from `[Uploaded files: /abs]` tags).
   Endpoint: `GET /conversations/:id/files/:filename?mode=view|download`.
   Note: the server resolves `:filename` inside the conv's artifacts dir, so
   we only need the basename on the wire (full path is kept for tooltips). */
function UploadedFileCard({ filePath, convId, onOpenView }){
  const filename = (filePath.split('/').pop() || filePath);
  const basePath = convId
    ? 'conversations/' + encodeURIComponent(convId) + '/files/' + encodeURIComponent(filename)
    : null;
  const viewPath = basePath ? basePath + '?mode=view' : null;
  const downloadUrl = basePath ? AgentApi.chatUrl(basePath + '?mode=download') : null;
  return (
    <div className="file-card" title={filePath}>
      <span className="file-card-icon" aria-hidden="true">{Ico.file ? Ico.file(18) : '📄'}</span>
      <span className="file-card-name">{filename}</span>
      <span className="file-card-actions">
        <button
          type="button"
          className="btn ghost file-card-btn"
          onClick={() => onOpenView && onOpenView({
            filename,
            viewPath,
            imageUrl: null,
            displayPath: filePath,
          })}
          disabled={!convId || !onOpenView}
        >View</button>
        {downloadUrl ? (
          <a className="btn ghost file-card-btn" href={downloadUrl} download={filename}>Download</a>
        ) : null}
      </span>
    </div>
  );
}

function ThinkingBlock({ content }){
  const [open, setOpen] = React.useState(false);
  const preview = (content || '').trim().split('\n')[0].slice(0, 80);
  return (
    <div style={{margin:"6px 0"}}>
      <button
        type="button"
        className="thinking"
        onClick={() => setOpen(v => !v)}
        style={{border:"1px dashed var(--border-strong)",background:"transparent",font:"inherit"}}
      >
        <span className="dot"/>
        <span>{open ? 'Hide thinking' : (preview ? `Thinking · ${preview}` : 'Thinking')}</span>
      </button>
      {open ? (
        <div style={{
          marginTop:6,
          padding:"10px 12px",
          border:"1px dashed var(--border-strong)",
          borderRadius:"var(--r-sm)",
          whiteSpace:"pre-wrap",
          fontSize:12,
          color:"var(--text-3)",
          lineHeight:1.55,
        }}>
          {content}
        </div>
      ) : null}
    </div>
  );
}

/* Renders a contiguous run of tool activities, nesting subagent children and
   splitting remaining tools into parallel/sequential groups. */
function ToolRun({ tools }){
  const agentIndex = React.useContext(AgentIndexContext);
  const segments = partitionToolRun(tools, agentIndex);
  return <>{segments.map((s, i) => renderToolSegment(s, i))}</>;
}

function renderToolSegment(seg, key){
  if (seg.type === 'agent') {
    return <SubagentCard key={key} activity={seg.activity} childGroups={seg.children}/>;
  }
  return <ToolGroup key={key} group={seg}/>;
}

/* Pull agents out of the run and interleave them with parallel/sequential
   groups of the remaining tools. Children — including ones persisted on
   messages OTHER than the Agent's own — come from the cross-message
   `agentIndex.childrenByAgent`. Any tool whose `parentAgentId` exists in
   `agentIndex.agentIds` is skipped here because it will be rendered inside
   its parent's card wherever that card appears. */
function partitionToolRun(tools, agentIndex){
  const { agentIds, childrenByAgent } = agentIndex || { agentIds: new Set(), childrenByAgent: new Map() };
  const segments = [];
  let plainBuf = [];
  const flushPlain = () => {
    if (plainBuf.length) {
      for (const g of partitionParallel(plainBuf)) segments.push(g);
      plainBuf = [];
    }
  };
  for (const t of tools) {
    if (!t) continue;
    if (t.isAgent) {
      flushPlain();
      segments.push({
        type: 'agent',
        activity: t,
        children: partitionParallel(childrenByAgent.get(t.id) || []),
      });
    } else if (t.parentAgentId && agentIds.has(t.parentAgentId)) {
      // rendered inside its parent's card elsewhere; skip here
    } else {
      plainBuf.push(t);
    }
  }
  flushPlain();
  return segments;
}

/* Merge consecutive tools that share a server-assigned batchIndex into a
   parallel group. Tools across different batchIndex values are sequential.
   Legacy tools (no batchIndex) fall back to a 500ms startTime proximity rule. */
function partitionParallel(tools){
  if (!tools || tools.length === 0) return [];
  if (tools.length === 1) return [{ type: 'sequential', items: [tools[0]] }];
  const close = [];
  for (let i = 1; i < tools.length; i++) {
    const a = tools[i-1];
    const b = tools[i];
    if (a && b && a.batchIndex != null && b.batchIndex != null) {
      close.push(a.batchIndex === b.batchIndex);
    } else {
      const aStart = (a && a.startTime) || 0;
      const bStart = (b && b.startTime) || 0;
      close.push(Math.abs(bStart - aStart) <= PARALLEL_THRESHOLD_MS);
    }
  }
  const groups = [];
  let i = 0;
  while (i < tools.length) {
    if (i + 1 < tools.length && close[i]) {
      let j = i;
      while (j + 1 < tools.length && close[j]) j++;
      groups.push({ type: 'parallel', items: tools.slice(i, j + 1) });
      i = j + 1;
    } else {
      let j = i;
      while (j + 1 < tools.length && !close[j]) j++;
      groups.push({ type: 'sequential', items: tools.slice(i, j + 1) });
      i = j + 1;
    }
  }
  return groups;
}

/* Walks every message, builds the set of all Agent ids and a children map
   (agentId → flat list of child tool activities in chronological order).
   Children can appear on any message — typically a later one than the Agent
   itself — so both passes scan the full list. */
function buildAgentIndex(messages){
  const agentIds = new Set();
  const childrenByAgent = new Map();
  for (const m of messages || []) {
    if (!m || m.role !== 'assistant') continue;
    const blocks = deriveBlocks(m);
    for (const b of blocks) {
      if (b && b.type === 'tool' && b.activity && b.activity.isAgent && b.activity.id) {
        agentIds.add(b.activity.id);
        if (!childrenByAgent.has(b.activity.id)) childrenByAgent.set(b.activity.id, []);
      }
    }
  }
  for (const m of messages || []) {
    if (!m || m.role !== 'assistant') continue;
    const blocks = deriveBlocks(m);
    for (const b of blocks) {
      if (b && b.type === 'tool' && b.activity) {
        const t = b.activity;
        if (t.parentAgentId && childrenByAgent.has(t.parentAgentId)) {
          childrenByAgent.get(t.parentAgentId).push(t);
        }
      }
    }
  }
  return { agentIds, childrenByAgent };
}

function AgentIndexProvider({ messages, children }){
  const value = React.useMemo(() => buildAgentIndex(messages), [messages]);
  return <AgentIndexContext.Provider value={value}>{children}</AgentIndexContext.Provider>;
}

function ToolGroup({ group }){
  const showHeader = group.type === 'parallel' || group.items.length >= 2;
  const cls = group.type === 'parallel' ? 'tools parallel' : 'tools';
  return (
    <div className={cls}>
      {group.type === 'parallel' ? <span className="rail"/> : null}
      {showHeader ? (
        <div className="tools-head">
          <span className={`tag ${group.type}`}>{group.type}</span>
          <span>{group.items.length} step{group.items.length !== 1 ? 's' : ''}</span>
        </div>
      ) : null}
      {group.items.map((t, i) => <ToolRow key={t.id || i} activity={t}/>)}
    </div>
  );
}

function SubagentCard({ activity, childGroups }){
  const label = activity.description || activity.tool || 'agent';
  return (
    <div className="subagent">
      <div className="subagent-head">
        <span className="chip">{activity.subagentType || 'agent'}</span>
        <span className="title">{label}</span>
        <span className="elapsed">
          {activity.outcome
            ? ''
            : activity.duration != null
              ? `${activity.duration}ms`
              : activity.startTime
                ? <LiveElapsed startTime={activity.startTime}/>
                : '…'}
        </span>
      </div>
      {childGroups && childGroups.length
        ? childGroups.map((g, i) => <ToolGroup key={i} group={g}/>)
        : null}
    </div>
  );
}

/* Live-ticking elapsed for still-running tools / subagents. Rerenders
   once per second off a local `now` state; the interval auto-clears on
   unmount. Mirrors V1 `chatStartActivityTimer` (rendering.js:1120). */
function LiveElapsed({ startTime }){
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{formatMsgElapsed(Math.max(0, now - startTime))}</>;
}

function ToolRow({ activity }){
  const state = activity.status === 'error'
    ? 'err'
    : activity.outcome
      ? 'done'
      : activity.duration != null
        ? 'done'
        : 'run';
  return (
    <div className={`tool ${state}`}>
      <span className="marker"/>
      <span>
        <span className="name">{activity.tool}</span>
        {activity.description ? <> <span className="arg">{activity.description}</span></> : null}
      </span>
      <span className="ms">
        {activity.outcome
          ? activity.outcome
          : activity.duration != null
            ? `${activity.duration}ms`
            : activity.startTime
              ? <LiveElapsed startTime={activity.startTime}/>
              : '…'}
      </span>
      <span/>
    </div>
  );
}

/* Collapse runs of consecutive assistant messages with turn:'progress' into a
   single breadcrumb entry. Three cases:
     - plain                   → a non-progress message rendered as-is
     - final-with-progress     → the breadcrumb prepends to a following non-progress
                                 assistant bubble (a persisted turn:'final' or the live
                                 streaming placeholder, which has no turn field). Keeps
                                 an in-flight multi-segment turn in a single agent
                                 presence instead of a standalone breadcrumb bubble
                                 above a separate streaming bubble.
     - progress-trailing       → the run has no following assistant bubble at all
                                 (aborted/orphan runs).
*/
function collapseProgressRuns(messages){
  const out = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    const isProgress = m && m.role === 'assistant' && m.turn === 'progress';
    if (!isProgress) {
      out.push({ kind: 'plain', message: m });
      i++;
      continue;
    }
    const run = [];
    while (i < messages.length) {
      const mi = messages[i];
      if (mi && mi.role === 'assistant' && mi.turn === 'progress') {
        run.push(mi);
        i++;
      } else {
        break;
      }
    }
    const next = messages[i];
    if (next && next.role === 'assistant' && next.turn !== 'progress') {
      out.push({ kind: 'final-with-progress', message: next, progressRun: run });
      i++;
    } else {
      out.push({ kind: 'progress-trailing', progressRun: run });
    }
  }
  return out;
}

function ContextChip({ backendId, cliProfileId, usage }){
  const renderer = getChipRenderer(backendId);
  /* Subscribe to the per-backend plan usage store so the tooltip reflects
     the latest cached snapshot. Each store is a singleton; the server
     fronts it with a 10-min throttle so refresh-on-mount is cheap and
     safe. */
  const store = (backendId === 'claude-code' || backendId === CLAUDE_CODE_INTERACTIVE_BACKEND_ID) ? PlanUsageStore
    : backendId === 'kiro'        ? KiroPlanUsageStore
    : backendId === 'codex'       ? CodexPlanUsageStore
    : null;
  const profileKey = cliProfileId || '';
  const [planUsageState, setPlanUsageState] = React.useState(() => ({
    key: profileKey,
    data: store ? store.get(cliProfileId) : null,
  }));
  React.useEffect(() => {
    if (!store) {
      setPlanUsageState({ key: profileKey, data: null });
      return;
    }
    setPlanUsageState({ key: profileKey, data: store.get(cliProfileId) });
    const unsub = store.subscribe(
      data => setPlanUsageState({ key: profileKey, data }),
      cliProfileId,
    );
    store.refresh(cliProfileId);
    return unsub;
  }, [backendId, store, profileKey]);
  const planUsage = planUsageState.key === profileKey
    ? planUsageState.data
    : (store ? store.get(cliProfileId) : null);
  const chipText = renderer.renderChipText(usage);
  if (chipText == null) return null;
  const card = renderer.renderTooltipCard(usage, { planUsage });
  const chip = (
    <span
      className="u-mono"
      tabIndex={0}
      style={{fontSize:11,color:"var(--text-3)",padding:"0 6px",cursor:"help"}}
    >
      {chipText}
    </span>
  );
  if (!card) return chip;
  return <Tip variant="stat" rich={card}>{chip}</Tip>;
}

function msgTime(iso){
  if (!iso) return '';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

/* "Xs" under a minute, "Xm YYs" (zero-padded seconds) otherwise. Used by the
   assistant-message elapsed pill; capped at 1 h upstream so no hour branch
   needed. */
function formatMsgElapsed(ms){
  const totalSec = Math.floor((ms || 0) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec < 10 ? '0' : ''}${sec}s`;
}

/* Cascading pickers below the composer: Profile → Model → Effort → Speed.
   Values flush to the server with the next /message POST (see StreamStore.send).
   Each chip wraps a transparent native <select> so we get native dropdown
   UX, keyboard/a11y for free, and the chip's styled shell. */
function ComposerPicks({ convId, backends, cliProfiles, composerCliProfileId, composerBackend, composerModel, composerEffort, composerServiceTier, profileLocked, disabled }){
  const activeProfiles = Array.isArray(cliProfiles) ? cliProfiles.filter(p => p && !p.disabled) : [];
  const selectedProfile = activeProfiles.find(p => p.id === composerCliProfileId)
    || (composerBackend ? activeProfiles.find(p => p.vendor === cliVendorForBackend(composerBackend)) : null)
    || null;
  const effectiveBackendId = selectedProfile
    ? backendIdForProfile(selectedProfile)
    : composerBackend;
  const [profileBackend, setProfileBackend] = React.useState(null);

  React.useEffect(() => {
    if (!selectedProfile) {
      setProfileBackend(null);
      return;
    }
    let cancelled = false;
    setProfileBackend(null);
    AgentApi.getCliProfileMetadata(selectedProfile.id)
      .then(backend => {
        if (!cancelled) setProfileBackend(backend || null);
      })
      .catch(() => {
        if (!cancelled) setProfileBackend(null);
      });
    return () => { cancelled = true; };
  }, [selectedProfile && selectedProfile.id]);
  React.useEffect(() => {
    if (profileLocked || !selectedProfile || !effectiveBackendId) return;
    if (composerCliProfileId !== selectedProfile.id || composerBackend !== effectiveBackendId) {
      StreamStore.setComposerCliProfile(convId, selectedProfile.id, effectiveBackendId);
    }
  }, [convId, profileLocked, selectedProfile && selectedProfile.id, effectiveBackendId, composerCliProfileId, composerBackend]);

  const backend = (selectedProfile && profileBackend && profileBackend.id === effectiveBackendId)
    ? profileBackend
    : (backends.find(b => b.id === effectiveBackendId) || null);
  const backendModels = (backend && Array.isArray(backend.models)) ? backend.models : [];
  const model = backendModels.find(m => m.id === composerModel)
    || backendModels.find(m => m.default)
    || backendModels[0]
    || null;
  const effortLevels = (model && Array.isArray(model.supportedEffortLevels)) ? model.supportedEffortLevels : [];
  const effort = effortLevels.includes(composerEffort)
    ? composerEffort
    : (effortLevels.includes('high') ? 'high' : (effortLevels[0] || null));
  const serviceTier = composerServiceTier === 'fast' ? 'fast' : 'default';

  /* If picker state drifted out of the backend's catalog (e.g. backend change
      invalidated the chosen model), push the reconciled value back down so
     the next send uses a valid pair. */
  React.useEffect(() => {
    if (backend && model && composerModel !== model.id) {
      StreamStore.setComposerModel(convId, model.id);
    }
  }, [convId, backend && backend.id, model && model.id, composerModel]);
  React.useEffect(() => {
    if (effort !== composerEffort) {
      StreamStore.setComposerEffort(convId, effort);
    }
  }, [convId, effort, composerEffort]);

  if (backends.length === 0) return <span className="picks"/>;

  return (
    <span className="picks">
      {activeProfiles.length > 0 ? (
        <PickChip
          label="Profile"
          value={selectedProfile ? selectedProfile.name : (composerCliProfileId || '—')}
          disabled={disabled || profileLocked}
          options={activeProfiles.map(p => ({ value: p.id, label: p.name }))}
          currentValue={selectedProfile ? selectedProfile.id : ''}
          icon={selectedProfile ? <BackendInlineIcon backends={backends} backendId={effectiveBackendId}/> : null}
          onChange={v => {
            const profile = activeProfiles.find(p => p.id === v);
            if (profile) {
              const nextBackend = backendIdForProfile(profile);
              StreamStore.setComposerCliProfile(convId, profile.id, nextBackend);
            }
          }}
          title={profileLocked ? 'CLI profile locked for this session' : 'CLI Profile'}
        />
      ) : (
        <PickChip
          label="Backend"
          value={backend ? backend.label : (composerBackend || '—')}
          disabled={disabled || profileLocked}
          options={backends.map(b => ({ value: b.id, label: b.label }))}
          currentValue={backend ? backend.id : ''}
          icon={backend ? <BackendInlineIcon backends={backends} backendId={backend.id}/> : null}
          onChange={v => StreamStore.setComposerBackend(convId, v)}
          title={profileLocked ? 'Backend locked for this session' : 'Backend'}
        />
      )}
      {backendModels.length > 0 ? (
        <PickChip
          label="Model"
          value={model ? model.label : (composerModel || '—')}
          disabled={disabled}
          options={backendModels.map(m => ({ value: m.id, label: m.label + costTierDot(m.costTier) }))}
          currentValue={model ? model.id : ''}
          onChange={v => StreamStore.setComposerModel(convId, v)}
          title="Model"
        />
      ) : null}
      {effortLevels.length > 0 ? (
        <PickChip
          label="Effort"
          value={effort || '—'}
          disabled={disabled}
          options={effortLevels.map(lv => ({ value: lv, label: lv[0].toUpperCase() + lv.slice(1) }))}
          currentValue={effort || ''}
          onChange={v => StreamStore.setComposerEffort(convId, v)}
          title="Adaptive reasoning effort"
        />
      ) : null}
      {effectiveBackendId === 'codex' ? (
        <PickChip
          label="Speed"
          value={serviceTier === 'fast' ? 'Fast' : 'Default'}
          disabled={disabled}
          options={[
            { value: 'default', label: 'Default' },
            { value: 'fast', label: 'Fast' },
          ]}
          currentValue={serviceTier}
          onChange={v => StreamStore.setComposerServiceTier(convId, v)}
          title="Codex service tier"
        />
      ) : null}
    </span>
  );
}

function costTierDot(tier){
  if (tier === 'high') return ' \u25cf';  // ●
  if (tier === 'low')  return ' \u25cb';  // ○
  return '';
}

function PickChip({ label, value, options, currentValue, onChange, disabled, title, icon }){
  const accessibleLabel = title || label;
  return (
    <span className="pick" title={accessibleLabel} aria-disabled={disabled ? 'true' : 'false'}>
      {icon ? <span className="pick-icon">{icon}</span> : null}
      <b>{value}</b>
      <span className="chev">{Ico.chevD(10)}</span>
      <select
        className="pick-select"
        value={currentValue}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        aria-label={accessibleLabel}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </span>
  );
}

/* Shown while the agent is in plan mode — gathering context / drafting a
   plan without taking action yet. Clears when plan mode exits (either into
   a plan-approval card or the stream finishes). */
function PlanModeBanner(){
  return (
    <div className="plan-mode-banner">
      <span className="plan-mode-icon" aria-hidden="true">📋</span>
      <span>Planning mode — gathering context; no changes will be made yet.</span>
    </div>
  );
}

/* Stream error card — shown at the foot of the feed when a streamError is
   set on the ConvState. Matches the mock's .err-card layout (accent border,
   mono uppercase head, divider before actions). "Dismiss" clears the error;
   "Resume queue" clears the error AND calls drainQueueIfReady so the head
   of the queue fires immediately. The resume button only appears when the
   queue has pending items — the drainer would be a no-op otherwise. */
function StreamErrorCard({ convId, error, source, queueLength, messages }){
  /* Retry = re-send the last user message verbatim. Matches V1
     `chatRetryLast` (`streaming.js:715-726`): the composer picker values
     govern backend/model/effort just like a normal send. We don't preserve
     the original backend here because V2 user messages carry backend but
     not model/effort — so resending with the current composer state is the
     only way to keep those three coherent. */
  const lastUser = React.useMemo(() => {
    const arr = Array.isArray(messages) ? messages : [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && arr[i].role === 'user') return arr[i];
    }
    return null;
  }, [messages]);
  const isAbort = source === 'abort' || error === 'Aborted by user';
  const canRetry = !isAbort && !!(lastUser && typeof lastUser.content === 'string' && lastUser.content);

  function onRetry(){
    if (!canRetry) return;
    StreamStore.clearStreamError(convId);
    StreamStore.send(convId, lastUser.content).catch(() => {});
  }
  const title = isAbort ? 'Operation aborted' : 'Stream error';
  const detail = isAbort ? 'Aborted by user' : error;
  const body = isAbort
    ? `The operation was stopped. ${queueLength ? `${queueLength} queued message${queueLength === 1 ? '' : 's'} ${queueLength === 1 ? 'is' : 'are'} paused until you resume.` : 'Dismiss this notice to keep working.'}`
    : `The stream was interrupted. ${queueLength ? `${queueLength} queued message${queueLength === 1 ? '' : 's'} ${queueLength === 1 ? 'is' : 'are'} paused until you resume.` : 'No messages are queued — dismiss this notice to keep working.'}`;

  return (
    <div className={`err-card ${isAbort ? 'err-card-abort' : ''}`}>
      <div className="err-head">
        <span className="dot" style={{background: isAbort ? "var(--status-awaiting)" : "var(--status-error)"}}/>
        {title}
        <span className="spacer" style={{flex:1}}/>
        <span className="u-mono u-dim" style={{fontSize:10.5}}>{detail}</span>
      </div>
      <div className="prose" style={{fontFamily:"var(--prose-font)",fontSize:15,lineHeight:1.55}}>
        <p>{body}</p>
      </div>
      <div className="err-actions">
        <span className="spacer" style={{flex:1}}/>
        <button className="btn ghost" onClick={() => StreamStore.clearStreamError(convId)}>Dismiss</button>
        {canRetry ? (
          <button className="btn ghost" onClick={onRetry}>Retry</button>
        ) : null}
        {queueLength ? (
          <button className="btn" onClick={() => StreamStore.clearStreamError(convId, { resumeQueue: true })}>
            Resume queue
          </button>
        ) : null}
      </div>
    </div>
  );
}

function useFixedPopoverPosition(anchorRef, panelRef, open){
  const [pos, setPos] = React.useState(null);
  React.useEffect(() => {
    if (!open || !anchorRef.current) return undefined;
    const compute = () => {
      const a = anchorRef.current.getBoundingClientRect();
      const p = panelRef.current;
      const pw = p ? p.offsetWidth : 320;
      const ph = p ? p.offsetHeight : 160;
      const margin = 16;
      const gap = 8;
      let left = a.left + a.width / 2 - pw / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
      const above = a.top - gap - ph;
      const below = a.bottom + gap;
      const placeAbove = above >= margin || window.innerHeight - below < ph;
      const top = placeAbove
        ? Math.max(margin, above)
        : Math.min(below, window.innerHeight - ph - margin);
      const arrowX = Math.max(12, Math.min(pw - 18, a.left + a.width / 2 - left - 5));
      setPos({ top, left, placeAbove, arrowX });
    };
    compute();
    const raf = requestAnimationFrame(compute);
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);
  return pos;
}

function ComposerInstructionCompatibilityIcon({ workspaceHash, workspaceLabel, onOpenWorkspaceSettings }){
  const toast = useToasts();
  const buttonRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const pos = useFixedPopoverPosition(buttonRef, panelRef, open);

  const refresh = React.useCallback(async () => {
    if (!workspaceHash) {
      setStatus(null);
      return;
    }
    try {
      const res = await AgentApi.workspace.getInstructionCompatibility(workspaceHash);
      setStatus(res.status || null);
    } catch {
      setStatus(null);
    }
  }, [workspaceHash]);

  React.useEffect(() => {
    let cancelled = false;
    if (!workspaceHash) {
      setStatus(null);
      return undefined;
    }
    AgentApi.workspace.getInstructionCompatibility(workspaceHash)
      .then(res => { if (!cancelled) setStatus(res.status || null); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [workspaceHash]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      if (buttonRef.current && buttonRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  React.useEffect(() => {
    if (!status || !status.shouldNotify) setOpen(false);
  }, [status && status.fingerprint, status && status.shouldNotify]);

  if (!status || !status.shouldNotify) return null;

  const missingLabels = (status.missingVendors || []).map(item => item.label).join(', ');
  const presentSources = (status.sources || []).filter(source => source.present);
  const sourceLabel = presentSources.map(source => source.label).join(', ') || 'project instructions';
  const title = 'Instruction pointers needed';

  async function createPointers(){
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await AgentApi.workspace.createInstructionPointers(workspaceHash);
      setStatus(result.status || null);
      const created = result.created || [];
      toast.success(created.length ? 'Instruction pointers created' : 'Instruction pointers already exist');
      if (!result.status || !result.status.shouldNotify) setOpen(false);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function dismiss(){
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await AgentApi.workspace.dismissInstructionCompatibility(workspaceHash);
      setStatus(result.status || null);
      setOpen(false);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  function openInstructions(){
    setOpen(false);
    if (onOpenWorkspaceSettings) {
      onOpenWorkspaceSettings(workspaceHash, workspaceLabel || 'workspace', 'instructions');
    }
  }

  const style = pos
    ? { top: pos.top, left: pos.left }
    : { visibility: 'hidden', top: 0, left: 0 };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="composer-notif state-pending state-instruction-warning"
        aria-label={title}
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => { setError(null); setOpen(v => !v); }}
      >
        {Ico.alert(14)}
        <span className="composer-notif-pulse state-pending"/>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="tt composer-action-popover"
          data-variant="stat"
          data-placement={pos && pos.placeAbove ? 'above' : 'below'}
          data-pinned="true"
          role="dialog"
          aria-label={title}
          style={style}
        >
          <span className="tt-arrow" style={{ left: pos ? pos.arrowX : 12 }}/>
          <div className="tt-header">
            <span className="tt-eye">Instructions</span>
          </div>
          <h4 className="tt-h">{title}</h4>
          <div className="tt-section">
            <div className="tt-rows">
              <div className="tt-kv"><span>Found</span><b title={sourceLabel}>{sourceLabel}</b></div>
              <div className="tt-kv"><span>Missing</span><b title={missingLabels}>{missingLabels}</b></div>
            </div>
          </div>
          <div className="tt-section">
            <div className="hint">
              Create thin pointer files so every supported CLI reads the same workspace instructions.
            </div>
          </div>
          {error ? (
            <div className="tt-section">
              <div className="tt-error-text">{error}</div>
            </div>
          ) : null}
          <div className="tt-foot">
            <span className="hint">No existing instruction files are overwritten.</span>
            <span className="spacer"/>
            <button type="button" className="tt-btn" onClick={openInstructions}>Open</button>
            <button type="button" className="tt-btn" disabled={busy} onClick={dismiss}>Dismiss</button>
            <button type="button" className="tt-btn primary" disabled={busy || !status.canCreatePointers} onClick={createPointers}>
              {busy ? 'Working…' : 'Create pointers'}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function formatInstallMethod(method){
  if (method === 'npm-global') return 'npm global';
  if (method === 'self-update') return 'self updater';
  if (method === 'missing') return 'not found';
  return 'unknown';
}

function ComposerCliUpdateIcon({ cliProfileId, backendId, onOpenSettings }){
  useCliUpdates();
  const toast = useToasts();
  const buttonRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const item = CliUpdateStore.findForSelection(cliProfileId, backendId);
  const interactiveCompatibility = item && Array.isArray(item.interactiveCompatibility)
    ? item.interactiveCompatibility.find(status => status && status.providerId === CLAUDE_CODE_INTERACTIVE_BACKEND_ID && status.severity && status.severity !== 'none')
    : null;
  const showCompatibilityWarning = backendId === CLAUDE_CODE_INTERACTIVE_BACKEND_ID && !!interactiveCompatibility;
  const pos = useFixedPopoverPosition(buttonRef, panelRef, open);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      if (buttonRef.current && buttonRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  React.useEffect(() => {
    if (!item || (!item.updateAvailable && !showCompatibilityWarning)) setOpen(false);
  }, [item && item.id, item && item.updateAvailable, showCompatibilityWarning]);

  if (!item || (!item.updateAvailable && !showCompatibilityWarning)) return null;

  const title = showCompatibilityWarning
    ? 'Claude Code Interactive compatibility warning'
    : item.label + ' update available';
  const showUpdateAction = item.updateAvailable === true;
  const profileLabel = item.profileNames && item.profileNames.length
    ? item.profileNames.slice(0, 2).join(', ') + (item.profileNames.length > 2 ? ' +' + (item.profileNames.length - 2) : '')
    : 'Current profile';

  async function doUpdate(){
    if (!item || busy || !item.updateSupported) return;
    setBusy(true);
    setError(null);
    try {
      const result = await CliUpdateStore.update(item.id);
      if (result && result.success) {
        toast.success(item.label + ' updated');
        setOpen(false);
      } else {
        setError((result && result.error) || 'Update failed');
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  const style = pos
    ? { top: pos.top, left: pos.left }
    : { visibility: 'hidden', top: 0, left: 0 };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="composer-notif state-pending state-cli-update"
        aria-label={title}
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => { setError(null); setOpen(v => !v); }}
      >
        {Ico.terminal(14)}
        <span className="composer-notif-pulse state-pending"/>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="tt composer-action-popover"
          data-variant="stat"
          data-placement={pos && pos.placeAbove ? 'above' : 'below'}
          data-pinned="true"
          role="dialog"
          aria-label={title}
          style={style}
        >
          <span className="tt-arrow" style={{ left: pos ? pos.arrowX : 12 }}/>
          <div className="tt-header">
            <span className="tt-eye">CLI Update</span>
          </div>
          <h4 className="tt-h">{title}</h4>
          <div className="tt-section">
            <div className="tt-rows">
              <div className="tt-kv"><span>Current</span><b>{item.currentVersion || 'unknown'}</b></div>
              <div className="tt-kv"><span>{showCompatibilityWarning ? 'Tested' : 'Available'}</span><b>{showCompatibilityWarning ? interactiveCompatibility.testedVersion : (item.latestVersion || 'unknown')}</b></div>
              <div className="tt-kv"><span>Install</span><b>{formatInstallMethod(item.installMethod)}</b></div>
              <div className="tt-kv"><span>Profile</span><b title={profileLabel}>{profileLabel}</b></div>
            </div>
          </div>
          {showCompatibilityWarning ? (
            <div className="tt-section">
              <div className="tt-error-text">{interactiveCompatibility.message}</div>
            </div>
          ) : item.updateCaution ? (
            <div className="tt-section">
              <div className="tt-error-text">{item.updateCaution}</div>
            </div>
          ) : null}
          {error ? (
            <div className="tt-section">
              <div className="tt-error-text">{error}</div>
            </div>
          ) : null}
          <div className="tt-foot">
            <span className="hint">
              {showUpdateAction
                ? (item.updateSupported ? 'No active stream can be running.' : 'Open settings for update details.')
                : 'Open settings for compatibility details.'}
            </span>
            <span className="spacer"/>
            <button type="button" className="tt-btn" onClick={() => onOpenSettings && onOpenSettings('cli')}>CLI settings</button>
            {showUpdateAction ? (
              <button type="button" className="tt-btn primary" disabled={busy || !item.updateSupported} onClick={doUpdate}>
                {busy ? 'Updating…' : 'Update now'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/* Composer notification icon — car-dashboard-style indicator positioned
   just left of the Send button. Only renders when there is something to
   notify about. Currently sourced exclusively from KB state (pending
   digestions, pending synthesis entries, dreaming-in-progress); designed
   to grow additional notification sources later. Hidden when KB is
   disabled OR when KB is enabled and idle (no pending work, no dream
   running). On hover a rich tooltip shows pending-digestion and
   pending-synthesis counts plus auto-digest state, using the standard
   Tip stat-variant template (.tt-header / .tt-eye / .tt-h / .tt-section
   / .tt-rows / .tt-kv). KB state is hydrated from `conv.kb` on conv
   load and patched live via `kb_state_update` WS frames (handled in
   streamStore). A 2s poll on GET /conversations/:id backstops dream
   progress transitions while a run is in flight. */
function ComposerNotifIcon({ conv, convId }){
  const kb = conv && conv.kb;
  const running = !!(kb && kb.dreamingStatus === 'running');

  React.useEffect(() => {
    if (!running || !convId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await AgentApi.fetch('conversations/' + encodeURIComponent(convId));
        const data = await r.json();
        if (cancelled) return;
        if (data && data.kb) StreamStore.patchConv(convId, { kb: data.kb });
      } catch { /* ignore */ }
    };
    const id = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [running, convId]);

  if (!kb || !kb.enabled) return null;

  const pendingDigest = Math.max(0, kb.pendingDigestions || 0);
  const pendingDream  = Math.max(0, kb.pendingEntries || 0);
  const autoDigest    = !!kb.autoDigest;
  const hasWork       = pendingDigest > 0 || pendingDream > 0;
  if (!running && !hasWork) return null;
  const state = running ? 'running' : 'pending';

  const card = (
    <>
      <div className="tt-header">
        <span className="tt-eye">Knowledge Base</span>
      </div>
      <h4 className="tt-h">
        {running
          ? 'Dreaming…'
          : (pendingDigest + pendingDream) + ' pending'}
      </h4>
      <div className="tt-section">
        <div className="tt-rows">
          <div className="tt-kv">
            <span>Digestion</span>
            <b>
              {pendingDigest === 0
                ? '—'
                : pendingDigest + (pendingDigest === 1 ? ' file' : ' files')}
            </b>
          </div>
          <div className="tt-kv">
            <span>Synthesis</span>
            <b>
              {pendingDream === 0
                ? '—'
                : pendingDream + (pendingDream === 1 ? ' entry' : ' entries')}
            </b>
          </div>
          <div className="tt-kv">
            <span>Auto-digest</span>
            <b>{autoDigest ? 'on' : 'off'}</b>
          </div>
        </div>
      </div>
      {running ? (
        <div className="tt-section">
          <div className="tt-section-label">Dreaming in progress</div>
          <DreamStepper progress={kb._dreamProgress}/>
        </div>
      ) : null}
    </>
  );

  const label = running
    ? 'KB: dreaming in progress'
    : ('KB: ' + (pendingDigest + pendingDream) + ' pending');

  return (
    <Tip variant="stat" rich={card}>
      <button
        type="button"
        className={"composer-notif state-" + state}
        aria-label={label}
      >
        {Ico.book(14)}
        <span className={"composer-notif-pulse state-" + state}/>
      </button>
    </Tip>
  );
}

function DreamStepper({ progress }){
  const phases = ['routing', 'verification', 'synthesis', 'discovery', 'reflection'];
  const currentIdx = progress && progress.phase ? phases.indexOf(progress.phase) : -1;
  return (
    <div className="dream-stepper">
      {phases.map((p, i) => {
        const active = i === currentIdx;
        const done = currentIdx > i;
        const label = p.charAt(0).toUpperCase() + p.slice(1);
        return (
          <React.Fragment key={p}>
            {i > 0 ? <span className="dream-stepper-sep">→</span> : null}
            <span className={"dream-stepper-step" + (active ? ' active' : done ? ' done' : '')}>
              {done ? '✓ ' : ''}{label}{active && progress && progress.total ? ` ${progress.done || 0}/${progress.total}` : ''}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function ComposerMemoryReviewIcon({ conv, workspaceLabel, onOpenMemoryReview }){
  const buttonRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const review = conv && conv.memoryReview;
  const pos = useFixedPopoverPosition(buttonRef, panelRef, open);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      if (buttonRef.current && buttonRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  React.useEffect(() => {
    if (!review || !review.pending) setOpen(false);
  }, [review && review.pending, review && review.latestRunId]);

  if (!review || !review.enabled || !review.pending) return null;

  const drafts = Math.max(0, review.pendingDrafts || 0);
  const safeActions = Math.max(0, review.pendingSafeActions || 0);
  const failed = Math.max(0, review.failedItems || 0);
  const count = drafts + safeActions + failed;
  const title = count === 1 ? '1 Memory Review item' : `${count} Memory Review items`;
  const style = pos
    ? { top: pos.top, left: pos.left }
    : { visibility: 'hidden', top: 0, left: 0 };

  function openReview(){
    setOpen(false);
    if (onOpenMemoryReview && conv && conv.workspaceHash) {
      onOpenMemoryReview(conv.workspaceHash, workspaceLabel || 'workspace', review.latestRunId || null);
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="composer-notif state-pending state-memory-review"
        aria-label={title}
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => setOpen(v => !v)}
      >
        {Ico.moon(14)}
        <span className="composer-notif-pulse state-pending"/>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="tt composer-action-popover"
          data-variant="stat"
          data-placement={pos && pos.placeAbove ? 'above' : 'below'}
          data-pinned="true"
          role="dialog"
          aria-label={title}
          style={style}
        >
          <span className="tt-arrow" style={{ left: pos ? pos.arrowX : 12 }}/>
          <div className="tt-header">
            <span className="tt-eye">Memory Review</span>
          </div>
          <h4 className="tt-h">{title}</h4>
          <div className="tt-section">
            <div className="tt-rows">
              <div className="tt-kv"><span>Drafts</span><b>{drafts || '-'}</b></div>
              <div className="tt-kv"><span>Metadata</span><b>{safeActions || '-'}</b></div>
              <div className="tt-kv"><span>Needs attention</span><b>{failed || '-'}</b></div>
            </div>
          </div>
          <div className="tt-foot">
            <span className="hint">{formatMemoryReviewComposerStatus(review.latestRunStatus)}</span>
            <span className="spacer"/>
            <button type="button" className="tt-btn primary" onClick={openReview}>Review</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function formatMemoryReviewComposerStatus(status){
  if (status === 'running') return 'Generating drafts';
  if (status === 'failed') return 'Review needs attention';
  return 'Ready to review';
}

function ComposerContextMapIcon({ conv, workspaceLabel, onOpenWorkspaceSettings }){
  const buttonRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const contextMap = conv && conv.contextMap;
  const pos = useFixedPopoverPosition(buttonRef, panelRef, open);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      if (buttonRef.current && buttonRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  React.useEffect(() => {
    if (!contextMap || !contextMap.pending) setOpen(false);
  }, [contextMap && contextMap.pending, contextMap && contextMap.latestRunId]);

  if (!contextMap || !contextMap.enabled || !contextMap.pending) return null;

  const pending = Math.max(0, contextMap.pendingCandidates || 0);
  const stale = Math.max(0, contextMap.staleCandidates || 0);
  const conflicts = Math.max(0, contextMap.conflictCandidates || 0);
  const failures = Math.max(0, (contextMap.failedCandidates || 0) + (contextMap.failedRuns || 0));
  const running = Math.max(0, contextMap.runningRuns || 0) > 0 || contextMap.latestRunStatus === 'running';
  const reviewCount = pending + stale + conflicts + failures;
  const title = running
    ? 'Context Map scanning'
    : reviewCount === 1 ? '1 Context Map item needs attention' : `${reviewCount} Context Map items need attention`;
  const style = pos
    ? { top: pos.top, left: pos.left }
    : { visibility: 'hidden', top: 0, left: 0 };

  function openContextMap(){
    setOpen(false);
    if (onOpenWorkspaceSettings && conv && conv.workspaceHash) {
      const targetSection = pending > 0 ? 'attention' : null;
      onOpenWorkspaceSettings(conv.workspaceHash, workspaceLabel || 'workspace', 'contextMap', targetSection);
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={"composer-notif state-context-map " + (running ? 'state-running' : 'state-pending')}
        aria-label={title}
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => setOpen(v => !v)}
      >
        {Ico.graph(14)}
        <span className={"composer-notif-pulse " + (running ? 'state-running' : 'state-pending')}/>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="tt composer-action-popover"
          data-variant="stat"
          data-placement={pos && pos.placeAbove ? 'above' : 'below'}
          data-pinned="true"
          role="dialog"
          aria-label={title}
          style={style}
        >
          <span className="tt-arrow" style={{ left: pos ? pos.arrowX : 12 }}/>
          <div className="tt-header">
            <span className="tt-eye">Context Map</span>
          </div>
          <h4 className="tt-h">{title}</h4>
          <div className="tt-section">
            <div className="tt-rows">
              <div className="tt-kv"><span>Needs attention</span><b>{pending || '-'}</b></div>
              <div className="tt-kv"><span>Conflicts</span><b>{conflicts || '-'}</b></div>
              <div className="tt-kv"><span>Stale</span><b>{stale || '-'}</b></div>
              <div className="tt-kv"><span>Failures</span><b>{failures || '-'}</b></div>
            </div>
          </div>
          <div className="tt-foot">
            <span className="hint">{formatContextMapComposerStatus(contextMap.latestRunStatus)}</span>
            <span className="spacer"/>
            <button type="button" className="tt-btn primary" onClick={openContextMap}>Open map</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function formatContextMapComposerStatus(status){
  if (status === 'running') return 'Scanning workspace';
  if (status === 'failed') return 'Processor needs attention';
  return 'Ready';
}

const CHAT_IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

function FileViewerCode({ content, language, line }){
  const targetRef = React.useRef(null);
  React.useEffect(() => {
    if (!line || !targetRef.current) return;
    targetRef.current.scrollIntoView({ block: 'center' });
  }, [content, line]);

  if (!line) {
    return <pre className="file-viewer-pre"><code className={language ? 'language-' + language : ''}>{content}</code></pre>;
  }

  const lines = String(content || '').split('\n');
  return (
    <pre className="file-viewer-pre file-viewer-lines">
      <code className={language ? 'language-' + language : ''}>
        {lines.map((text, i) => {
          const n = i + 1;
          const active = n === line;
          return (
            <span
              key={n}
              ref={active ? targetRef : null}
              className={"file-viewer-line" + (active ? " is-target" : "")}
            >
              <span className="file-viewer-line-no">{n}</span>
              <span className="file-viewer-line-text">{text || ' '}</span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

/* Right-slide file preview panel. Opens when the user clicks "View" on a
   file card (FILE_DELIVERY from assistant or [Uploaded files: …] from user).
   Caller builds URLs and passes a descriptor; panel renders the image
   inline if `imageUrl` is set, otherwise fetches `viewPath` (a path
   relative to `/api/chat/`) for text. Closed by the X button or when the
   conv changes. */
function FileViewerPanel({ filename, viewPath, imageUrl, displayPath, line, onClose }){
  const isImage = !!imageUrl;
  const [state, setState] = React.useState({ loading: !isImage, error: null, content: '', language: '' });

  React.useEffect(() => {
    if (isImage) { setState({ loading: false, error: null, content: '', language: '' }); return; }
    if (!viewPath) { setState({ loading: false, error: 'No view URL for file.', content: '', language: '' }); return; }
    let cancelled = false;
    setState({ loading: true, error: null, content: '', language: '' });
    AgentApi.fetch(viewPath)
      .then(r => r.json().then(data => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok) {
          setState({ loading: false, error: (data && data.error) || 'Failed to load file', content: '', language: '' });
        } else {
          setState({ loading: false, error: null, content: data.content || '', language: data.language || '' });
        }
      })
      .catch(err => {
        if (cancelled) return;
        setState({ loading: false, error: err.message || String(err), content: '', language: '' });
      });
    return () => { cancelled = true; };
  }, [viewPath, isImage]);

  return (
    <aside className="file-viewer" role="dialog" aria-label={`File preview: ${filename}`}>
      <div className="file-viewer-head">
        <span className="file-viewer-title" title={displayPath || filename}>{filename}{line ? `:${line}` : ''}</span>
        <button className="file-viewer-close" type="button" onClick={onClose} title="Close" aria-label="Close">{Ico.x ? Ico.x(14) : '×'}</button>
      </div>
      <div className="file-viewer-body">
        {isImage ? (
          <img src={imageUrl} alt={filename} className="file-viewer-image"/>
        ) : state.loading ? (
          <div className="u-dim" style={{padding:'12px'}}>Loading…</div>
        ) : state.error ? (
          <div className="u-err" style={{padding:'12px'}}>{state.error}</div>
        ) : (
          <FileViewerCode content={state.content} language={state.language} line={line}/>
        )}
      </div>
    </aside>
  );
}

/* Synthetic in-feed bubble emitted when the server sends a `memory_update`
   frame. Shows a one-line summary (N files changed or snapshot refreshed)
   plus a "View update" action that opens a focused changed-file modal. */
function MemoryUpdateBubble({ message, onOpen }){
  const mu = message.memoryUpdate || { changedFiles: [], fileCount: 0, capturedAt: message.timestamp };
  const changed = Array.isArray(mu.changedFiles) ? mu.changedFiles : [];
  const outcomes = Array.isArray(mu.writeOutcomes) ? mu.writeOutcomes : [];
  const skipped = outcomes.filter(o => o && String(o.action || '').startsWith('skipped_'));
  const [expanded, setExpanded] = React.useState(false);
  const headline = (() => {
    if (outcomes.length && changed.length === 0 && skipped.length === outcomes.length) {
      return `Memory note skipped: ${formatMemoryOutcomeAction(skipped[0].action)}`;
    }
    if (outcomes.length) return `Memory updated: ${outcomes.length} decision${outcomes.length === 1 ? '' : 's'}`;
    if (changed.length === 0) return `Memory snapshot refreshed (${mu.fileCount} file${mu.fileCount === 1 ? '' : 's'})`;
    return `Memory updated: ${changed.length} file${changed.length === 1 ? '' : 's'} changed`;
  })();
  const preview = outcomes.length ? outcomes.slice(0, 5) : changed.slice(0, 5);
  const extra = Math.max(0, (outcomes.length || changed.length) - preview.length);
  return (
    <div className="msg msg-memory">
      <span className="avatar avatar-memory" aria-hidden="true">{Ico.moon(14)}</span>
      <div className="body">
        <div className="head">
          <span className="who">Memory</span>
          <span>·</span>
          <span>{msgTime(mu.capturedAt)}</span>
        </div>
        <div className="memory-card">
          <button
            type="button"
            className="memory-summary"
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
          >
            <span className={"memory-caret" + (expanded ? ' open' : '')}>▸</span>
            <span className="memory-headline">{headline}</span>
          </button>
          {expanded && outcomes.length > 0 ? (
            <ul className="memory-files">
              {preview.map((o, idx) => (
                <li key={`${o.action || 'outcome'}_${idx}`}>
                  <span>{formatMemoryOutcomeAction(o.action)}</span>
                  {o.filename ? <span className="u-mono"> · {o.filename}</span> : null}
                  {o.duplicateOf ? <span className="u-mono"> · {o.duplicateOf}</span> : null}
                  {o.reason ? <div className="u-dim">{o.reason}</div> : null}
                </li>
              ))}
              {extra > 0 ? <li className="u-dim">+{extra} more</li> : null}
            </ul>
          ) : expanded && changed.length > 0 ? (
            <ul className="memory-files">
              {preview.map(f => (<li key={f} className="u-mono">{f}</li>))}
              {extra > 0 ? <li className="u-dim">+{extra} more</li> : null}
            </ul>
          ) : null}
          <button type="button" className="btn memory-cta" onClick={onOpen}>
            View update →
          </button>
        </div>
      </div>
    </div>
  );
}

function formatMemoryOutcomeAction(action){
  switch (action) {
    case 'saved': return 'Saved';
    case 'redacted_saved': return 'Saved with redaction';
    case 'superseded_saved': return 'Saved and superseded older memory';
    case 'skipped_duplicate': return 'Skipped duplicate';
    case 'skipped_ephemeral': return 'Skipped ephemeral';
    default: return 'Memory decision';
  }
}

/* Plan approval + clarifying question cards. Shown in the feed when the
   StreamStore has a pendingInteraction for this conversation. Answers go
   through StreamStore.respond() which delegates to POST /input — the server
   decides between stdin delivery (stream continues) or a fresh message. */
function InteractionCard({ convId, interaction, respondPending }){
  if (!interaction) return null;
  if (interaction.type === 'planApproval') {
    return <PlanApprovalCard convId={convId} planContent={interaction.planContent} respondPending={respondPending}/>;
  }
  if (interaction.type === 'userQuestion') {
    return <QuestionCard convId={convId} question={interaction.question} options={interaction.options} respondPending={respondPending}/>;
  }
  return null;
}

const AWAITING_CHIP_STYLE = {
  fontFamily: "var(--mono-font)", fontSize: 10, letterSpacing: ".1em",
  padding: "2px 7px", borderRadius: 4,
  border: "1px solid color-mix(in oklch, var(--status-awaiting), transparent 70%)",
  background: "color-mix(in oklch, var(--status-awaiting), transparent 92%)",
  marginLeft: 8,
};
const AWAITING_DOT_STYLE = {
  width: 6, height: 6, borderRadius: 999,
  background: "var(--status-awaiting)",
  boxShadow: "0 0 0 3px color-mix(in oklch, var(--status-awaiting), transparent 80%)",
};

function PlanApprovalCard({ convId, planContent, respondPending }){
  const html = planContent ? renderMarkdown(planContent) : '';
  return (
    <div className="plan" role="group" aria-label="Plan approval">
      <div className="plan-head">
        <span style={AWAITING_DOT_STYLE}/>
        Plan
        <span className="u-warn" style={AWAITING_CHIP_STYLE}>NEEDS YOU</span>
        <span className="spacer" style={{flex:1}}/>
      </div>
      {html ? (
        <div className="prose" dangerouslySetInnerHTML={{ __html: html }}/>
      ) : (
        <div className="u-dim" style={{fontSize:13}}>No plan content.</div>
      )}
      <div className="plan-actions">
        <span className="spacer" style={{flex:1}}/>
        <button
          className="btn danger"
          disabled={respondPending}
          onClick={() => StreamStore.respond(convId, 'no')}
        >Reject</button>
        <button
          className="btn primary"
          disabled={respondPending}
          onClick={() => StreamStore.respond(convId, 'yes')}
        >{respondPending ? 'Sending…' : 'Approve & run'}</button>
      </div>
    </div>
  );
}

function QuestionCard({ convId, question, options, respondPending }){
  const [text, setText] = React.useState('');
  const inputRef = React.useRef(null);
  React.useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
  const canSubmit = !!text.trim() && !respondPending;
  function submit(){
    if (!canSubmit) return;
    StreamStore.respond(convId, text.trim());
  }
  function pick(label){
    setText(label);
    if (inputRef.current) inputRef.current.focus();
  }
  const opts = Array.isArray(options) ? options : [];
  return (
    <div className="plan" role="group" aria-label="Clarifying question" style={{borderTopColor:"var(--accent)"}}>
      <div className="plan-head" style={{color:"var(--accent)"}}>
        <span style={{...AWAITING_DOT_STYLE, background:"var(--accent)", boxShadow:"none"}}/>
        Clarifying question
        <span className="spacer" style={{flex:1}}/>
      </div>
      <div className="plan-title" style={{fontSize:16}}>{question}</div>
      {opts.length > 0 ? (
        <div style={{display:"flex",flexWrap:"wrap",gap:6,margin:"4px 0 10px"}}>
          {opts.map((o, i) => {
            const label = typeof o === 'string' ? o : (o && o.label) || '';
            const desc = typeof o === 'string' ? '' : (o && o.description) || '';
            return (
              <button
                key={i}
                type="button"
                className="btn"
                disabled={respondPending}
                onClick={() => pick(label)}
                title={desc}
              >{label}</button>
            );
          })}
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        placeholder="Type your answer…"
        disabled={respondPending}
        style={{
          width:"100%",
          padding:"8px 10px",
          border:"1px solid var(--border)",
          borderRadius:"var(--r-sm)",
          background:"var(--surface-2)",
          color:"var(--text)",
          fontFamily:"inherit",
          fontSize:14,
          outline:"none",
        }}
      />
      <div className="plan-actions">
        <span className="spacer" style={{flex:1}}/>
        <button
          className="btn primary"
          disabled={!canSubmit}
          onClick={submit}
        >{respondPending ? 'Sending…' : 'Send'}</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <DialogProvider><ToastProvider><BackendsProvider><CliProfilesProvider><App/></CliProfilesProvider></BackendsProvider></ToastProvider></DialogProvider>
);
