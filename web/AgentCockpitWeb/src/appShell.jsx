import React from 'react';

import { AgentApi } from './api.js';
import { Sidebar } from './primitives.jsx';
import { StreamStore } from './streamStore.js';
import { useDialog } from './dialog.jsx';
import { FolderPicker } from './folderPicker.jsx';
import { UpdateModal, RestartOverlay } from './updateModal.jsx';
import { ScreenLoading, useConvStates } from './shellState.jsx';
import { ChatLive } from './chat/chatLive.jsx';
import { ChatErrorBoundary } from './chatErrorBoundary.jsx';
import { WelcomeScreen } from './welcomeScreen.jsx';

const KbBrowser = React.lazy(() => import('./screens/kbBrowser.jsx').then(mod => ({ default: mod.KbBrowser })));
const FilesBrowser = React.lazy(() => import('./screens/filesBrowser.jsx').then(mod => ({ default: mod.FilesBrowser })));
const SettingsScreen = React.lazy(() => import('./screens/settingsScreen.jsx').then(mod => ({ default: mod.SettingsScreen })));
const WorkspaceSettingsPage = React.lazy(() => import('./workspaceSettings.jsx').then(mod => ({ default: mod.WorkspaceSettingsPage })));
const MemoryUpdateModal = React.lazy(() => import('./workspaceSettings.jsx').then(mod => ({ default: mod.MemoryUpdateModal })));

export function App(){
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
  const [workspaceSettings, setWorkspaceSettings] = React.useState(null); // { hash, label, initialTab, initialWorkspaceContextSection } | null
  const [memoryUpdateView, setMemoryUpdateView] = React.useState(null); // { hash, label, update } | null
  const [welcomeOpen, setWelcomeOpen] = React.useState(() => {
    try { return new URLSearchParams(window.location.search).get('welcome') === '1'; }
    catch { return false; }
  });
  const [installStatus, setInstallStatus] = React.useState(null);
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

  React.useEffect(() => {
    let cancelled = false;
    AgentApi.getInstallStatus()
      .then(status => { if (!cancelled) setInstallStatus(status); })
      .catch(() => { /* non-fatal; welcome screen can still load status */ });
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
    setFilesView(null);
    setSettingsView(null);
    setKbView({ hash, label });
    setSbOpen(false);
  }, []);

  const onOpenFiles = React.useCallback((hash, label) => {
    setWelcomeOpen(false);
    setWorkspaceSettings(null);
    setMemoryUpdateView(null);
    setKbView(null);
    setSettingsView(null);
    setFilesView({ hash, label });
    setSbOpen(false);
  }, []);

  const onOpenSettings = React.useCallback((initialTab) => {
    setWelcomeOpen(false);
    setWorkspaceSettings(null);
    setMemoryUpdateView(null);
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

  const onOpenWorkspaceSettings = React.useCallback((hash, label, initialTab, initialWorkspaceContextSection) => {
    setWelcomeOpen(false);
    setKbView(null);
    setFilesView(null);
    setSettingsView(null);
    setMemoryUpdateView(null);
    setWorkspaceSettings({
      hash,
      label,
      initialTab: initialTab || null,
      initialWorkspaceContextSection: initialWorkspaceContextSection || null,
    });
    setSbOpen(false);
  }, []);

  const onOpenMemoryUpdate = React.useCallback((hash, label, update) => {
    setWelcomeOpen(false);
    setWorkspaceSettings(null);
    setMemoryUpdateView({ hash, label, update: update || null });
    setSbOpen(false);
  }, []);

  const onOpenWelcome = React.useCallback(() => {
    setWelcomeOpen(true);
    setKbView(null);
    setFilesView(null);
    setSettingsView(null);
    setWorkspaceSettings(null);
    setMemoryUpdateView(null);
    setViewingArchive(false);
    setSbOpen(false);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('welcome', '1');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch {}
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
      setViewingArchive(false);
      setActiveConvId(conv.id);
    } catch (err) {
      const message = err.message || String(err);
      if (/CLI profile is required/i.test(message)) {
        const openSettings = await dialog.confirm({
          variant: 'error',
          title: 'CLI profile required',
          body: message,
          confirmLabel: 'Open CLI Profiles',
          cancelLabel: 'Cancel',
        });
        if (openSettings) {
          setFolderPickerOpen(false);
          setFolderPickerInitialPath('');
          onOpenSettings('cli');
        }
        return;
      }
      dialog.alert({
        variant: 'error',
        title: 'Failed to create conversation',
        body: message,
      });
    } finally {
      setCreatingConv(false);
    }
  }, [creatingConv, dialog, onOpenSettings]);

  const onWelcomeDone = React.useCallback((nextInstallStatus) => {
    if (nextInstallStatus && typeof nextInstallStatus === 'object' && 'welcomeCompletedAt' in nextInstallStatus) {
      setInstallStatus(nextInstallStatus);
    }
    setWelcomeOpen(false);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('welcome');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch {}
  }, []);

  const globalSettingsOpen = !!settingsView;
  const cockpitClassName = [
    'cockpit',
    sbOpen ? 'sb-open' : '',
    globalSettingsOpen ? 'global-settings-view' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cockpitClassName}>
      {!globalSettingsOpen ? (
        <>
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
            showWelcomeAction={Boolean(installStatus && !installStatus.welcomeCompletedAt && !welcomeOpen)}
            onOpenWelcome={onOpenWelcome}
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
        </>
      ) : null}
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
              initialWorkspaceContextSection={workspaceSettings.initialWorkspaceContextSection}
              onClose={onCloseWorkspaceSettings}
            />
          </React.Suspense>
        </section>
      ) : settingsView ? (
        <section className="main main-settings">
          <React.Suspense fallback={<ScreenLoading label="Loading settings..."/>}>
            <SettingsScreen
              initialTab={settingsView.initialTab}
              onOpenWorkspaceSettings={onOpenWorkspaceSettings}
              onClose={() => setSettingsView(null)}
            />
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
      ) : activeConvId
        ? <ChatErrorBoundary key={activeConvId}>
            <ChatLive
              convId={activeConvId}
              onArchived={onArchived}
              onDeleted={onDeleted}
              onRenamed={onRenamed}
              onOpenMemoryUpdate={onOpenMemoryUpdate}
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
