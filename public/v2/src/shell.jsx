/* global React, ReactDOM, Sidebar, Ico, AgentApi, StreamStore, KbBrowser, FilesBrowser, DialogProvider, useDialog, ToastProvider, useToasts, marked, DOMPurify, FileLinkUtils, UpdateModal, RestartOverlay, WorkspaceSettingsModal, MemoryUpdateModal, SessionsModal, CliUpdateStore */

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

const FILE_DELIVERY_RE = /<!--\s*FILE_DELIVERY:(.*?)\s*-->/g;

function extractFileDeliveries(text){
  if (typeof text !== 'string' || !text) return { cleaned: text || '', files: [] };
  const files = [];
  const cleaned = text.replace(FILE_DELIVERY_RE, (_, p) => {
    const trimmed = (p || '').trim();
    if (trimmed) files.push(trimmed);
    return '';
  });
  return { cleaned, files };
}

/* Parse the legacy `[Uploaded files: /abs/p1, /abs/p2]` tag off the end of a
   user-message content string. Matches chatService.parseUploadedFilesTag on
   the server. Returns cleaned text + absolute paths so the user bubble can
   render the upload chips/cards. */
const UPLOADED_FILES_RE = /\n*\[Uploaded files?: ([^\]]+)\]\s*$/;

function extractUploadedFiles(text){
  if (typeof text !== 'string' || !text) return { cleaned: text || '', paths: [] };
  const match = text.match(UPLOADED_FILES_RE);
  if (!match) return { cleaned: text, paths: [] };
  const paths = match[1].split(',').map(s => s.trim()).filter(Boolean);
  const cleaned = text.slice(0, match.index).replace(/\s+$/, '');
  return { cleaned, paths };
}

function streamErrorMessageText(message){
  if (!message || !message.streamError) return null;
  const err = message.streamError;
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return typeof message.content === 'string' && message.content ? message.content : 'Stream error';
}

function streamErrorMessageSource(message){
  if (!message || !message.streamError) return null;
  const err = message.streamError;
  return err && typeof err.source === 'string' ? err.source : null;
}

/* The server persists terminal stream failures as assistant messages so reloads
   and restart reconciliation can recover the error state. While that state is
   active, ChatLive renders the styled StreamErrorCard at the foot of the feed.
   User aborts are intentional cancellations, so their durable marker remains
   hidden even after the notice is dismissed instead of turning into a second
   assistant bubble. */
function hiddenStreamErrorMessageIds(messages, activeError, activeSource){
  const ids = new Set();
  if (!Array.isArray(messages)) return ids;
  for (const msg of messages) {
    if (msg && msg.id && msg.role === 'assistant' && msg.streamError && streamErrorMessageSource(msg) === 'abort') {
      ids.add(msg.id);
    }
  }
  if (!activeError) return ids;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'assistant' && msg.streamError) {
      const source = streamErrorMessageSource(msg);
      const sourceMatches = !activeSource || !source || source === activeSource;
      if (streamErrorMessageText(msg) === activeError && sourceMatches && msg.id) ids.add(msg.id);
      return ids;
    }
    if (msg.role === 'assistant' || msg.role === 'user') return ids;
  }
  return ids;
}

/* Subscribe to a single conversation's state in the StreamStore. Returns
   the current ConvState snapshot (or null when no convId is selected). */
function useConversationState(convId){
  const [, tick] = React.useReducer(x => x + 1, 0);
  React.useEffect(() => {
    if (!convId) return;
    StreamStore.load(convId);
    StreamStore.ensureWsOpen(convId).catch(() => {});
    return StreamStore.subscribe(convId, tick);
  }, [convId]);
  return convId ? StreamStore.getState(convId) : null;
}

/* Subscribe to the global per-conv uiState map used by the sidebar to light
   up every conversation that is currently streaming / errored. */
function useConvStates(){
  const [map, setMap] = React.useState(() => StreamStore.convStates());
  React.useEffect(() => StreamStore.subscribeGlobal(() => setMap(StreamStore.convStates())), []);
  return map;
}

/* Fetches the backend registry once per page load. Returns [] until the
   server responds; composer pickers hide themselves until the list arrives. */
function useBackends(){
  const [backends, setBackends] = React.useState([]);
  React.useEffect(() => {
    let cancelled = false;
    AgentApi.getBackendsCached()
      .then(list => { if (!cancelled) setBackends(Array.isArray(list) ? list : []); })
      .catch(() => { /* composer stays in display-only mode */ });
    return () => { cancelled = true; };
  }, []);
  return backends;
}

/* Backends context — populated once at the root so assistant-message avatars
   can look up a backend's `icon` SVG without re-fetching per render. */
const BackendsContext = React.createContext([]);
function BackendsProvider({ children }){
  const backends = useBackends();
  return <BackendsContext.Provider value={backends}>{children}</BackendsContext.Provider>;
}
function useBackendList(){ return React.useContext(BackendsContext); }

/* CLI profiles live in Settings. They change rarely, but Settings can save
   them without a page reload, so this provider refetches on the save event. */
const CliProfilesContext = React.createContext({ profiles: [], defaultCliProfileId: null });
function CliProfilesProvider({ children }){
  const [state, setState] = React.useState({ profiles: [], defaultCliProfileId: null });
  React.useEffect(() => {
    let cancelled = false;
    function applySettings(s){
      if (cancelled) return;
      setState({
        profiles: Array.isArray(s && s.cliProfiles) ? s.cliProfiles : [],
        defaultCliProfileId: (s && s.defaultCliProfileId) || null,
      });
    }
    AgentApi.getSettingsCached().then(applySettings).catch(() => {});
    const onSaved = (ev) => {
      if (ev && ev.detail) applySettings(ev.detail);
      else AgentApi.settings.get().then(applySettings).catch(() => {});
    };
    window.addEventListener('agent-cockpit-settings-saved', onSaved);
    return () => {
      cancelled = true;
      window.removeEventListener('agent-cockpit-settings-saved', onSaved);
    };
  }, []);
  return <CliProfilesContext.Provider value={state}>{children}</CliProfilesContext.Provider>;
}
function useCliProfileSettings(){ return React.useContext(CliProfilesContext); }

function useCliUpdates(){
  const [snapshot, setSnapshot] = React.useState(() => (window.CliUpdateStore && CliUpdateStore.get()) || null);
  React.useEffect(() => {
    if (!window.CliUpdateStore) return undefined;
    const unsub = CliUpdateStore.subscribe(setSnapshot);
    CliUpdateStore.refresh();
    const timer = setInterval(() => CliUpdateStore.refresh(), 5 * 60 * 1000);
    return () => {
      clearInterval(timer);
      unsub();
    };
  }, []);
  return snapshot;
}

function backendIconFor(backends, backendId){
  if (!backendId) return null;
  const b = (backends || []).find(x => x.id === backendId);
  return (b && b.icon) || null;
}

function BackendInlineIcon({ backends, backendId, className }){
  const icon = backendIconFor(backends, backendId);
  if (!icon) return null;
  return <span className={className || 'backend-inline-icon'} aria-hidden="true" dangerouslySetInnerHTML={{__html: icon}}/>;
}

/* Renders the avatar for an assistant message. When the backend exposes an
   inline SVG icon (claude-code, kiro), render that. Otherwise fall back to
   the Agent Cockpit logo. */
function AssistantAvatar({ backend }){
  const backends = useBackendList();
  const icon = backendIconFor(backends, backend);
  if (icon) {
    return <span className="avatar avatar-svg" dangerouslySetInnerHTML={{__html: icon}}/>;
  }
  return (
    <span className="avatar avatar-cockpit">
      <img src="/logo-small.svg" alt="Agent Cockpit"/>
    </span>
  );
}

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
  const [creatingConv, setCreatingConv] = React.useState(false);
  const [viewingArchive, setViewingArchive] = React.useState(false);
  const [updateTarget, setUpdateTarget] = React.useState(null); // { localVersion, remoteVersion } | null
  const [restarting, setRestarting] = React.useState(false);
  const [workspaceSettings, setWorkspaceSettings] = React.useState(null); // { hash, label } | null
  const [memoryUpdateView, setMemoryUpdateView] = React.useState(null); // { hash, label, update } | null
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
    window.StreamStore.setActiveConvId(activeConvId);
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
    setKbView(null);
    setFilesView(null);
    setSettingsView(null);
    setMemoryUpdateView(null);
    /* Push the active id into StreamStore synchronously *before* markRead
       so any `done` frame that fires between this call and the React-effect
       sync below already sees the new active id and doesn't re-flag the
       just-selected conv as unread. */
    window.StreamStore.setActiveConvId(id);
    setActiveConvId(id);
    setSbOpen(false);
    /* Clear the unread dot on selection. markRead always touches local
       state so convStates() can override the stale `c.unread` the sidebar
       may still have from the cached server list. */
    if (id) window.StreamStore.markRead(id);
  }, []);

  const onMarkUnread = React.useCallback((id) => {
    if (id) window.StreamStore.markUnread(id);
  }, []);

  const onOpenKb = React.useCallback((hash, label) => {
    setMemoryUpdateView(null);
    setFilesView(null);
    setSettingsView(null);
    setKbView({ hash, label });
    setSbOpen(false);
  }, []);

  const onOpenFiles = React.useCallback((hash, label) => {
    setMemoryUpdateView(null);
    setKbView(null);
    setSettingsView(null);
    setFilesView({ hash, label });
    setSbOpen(false);
  }, []);

  const onOpenSettings = React.useCallback((initialTab) => {
    setMemoryUpdateView(null);
    setKbView(null);
    setFilesView(null);
    setSettingsView({ initialTab: initialTab || null });
    setSbOpen(false);
  }, []);

  const onNewConversation = React.useCallback(() => {
    setSbOpen(false);
    setViewingArchive(false);
    setFolderPickerOpen(true);
  }, []);

  const onToggleArchive = React.useCallback(() => {
    setViewingArchive(v => {
      const next = !v;
      if (next) {
        setActiveConvId(null);
        setKbView(null);
        setFilesView(null);
        setSettingsView(null);
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

  const onOpenWorkspaceSettings = React.useCallback((hash, label, initialTab) => {
    setMemoryUpdateView(null);
    setWorkspaceSettings({ hash, label, initialTab: initialTab || null });
    setSbOpen(false);
  }, []);

  const onOpenMemoryUpdate = React.useCallback((hash, label, update) => {
    setWorkspaceSettings(null);
    setMemoryUpdateView({ hash, label, update: update || null });
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
       `workspaceKbEnabled` flag (and the book icon on the group header)
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
      setKbView(null);
      setFilesView(null);
      setSettingsView(null);
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
      {settingsView ? (
        <section className="main main-settings">
          <SettingsScreen initialTab={settingsView.initialTab} onClose={() => setSettingsView(null)}/>
        </section>
      ) : filesView ? (
        <section className="main main-files">
          <FilesBrowser hash={filesView.hash} label={filesView.label} onClose={() => setFilesView(null)}/>
        </section>
      ) : kbView ? (
        <section className="main main-kb">
          <KbBrowser hash={kbView.hash} label={kbView.label} onClose={() => setKbView(null)}/>
        </section>
      ) : activeConvId
        ? <ChatErrorBoundary key={activeConvId}>
            <ChatLive
              convId={activeConvId}
              onArchived={onArchived}
              onDeleted={onDeleted}
              onRenamed={onRenamed}
              onOpenMemoryUpdate={onOpenMemoryUpdate}
              onOpenSettings={onOpenSettings}
            />
          </ChatErrorBoundary>
        : <EmptyMain/>}
      <FolderPicker
        open={folderPickerOpen}
        busy={creatingConv}
        onClose={() => { if (!creatingConv) setFolderPickerOpen(false); }}
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
      <WorkspaceSettingsModal
        open={!!workspaceSettings}
        hash={workspaceSettings ? workspaceSettings.hash : null}
        label={workspaceSettings ? workspaceSettings.label : null}
        initialTab={workspaceSettings ? workspaceSettings.initialTab : null}
        onClose={onCloseWorkspaceSettings}
      />
      <MemoryUpdateModal
        open={!!memoryUpdateView}
        hash={memoryUpdateView ? memoryUpdateView.hash : null}
        label={memoryUpdateView ? memoryUpdateView.label : null}
        update={memoryUpdateView ? memoryUpdateView.update : null}
        onClose={() => setMemoryUpdateView(null)}
        onViewAll={onViewAllMemoryItems}
      />
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

function ChatLive({ convId, onArchived, onDeleted, onRenamed, onOpenMemoryUpdate, onOpenSettings }){
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
  React.useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, convId, resettingDep]);

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
  const topbarBackendId = topbarProfile
    ? topbarProfile.vendor
    : profileLocked
      ? conv.backend
      : (state.composerBackend || conv.backend);
  const hasContent = !!(input || '').trim() || hasDoneFiles;
  const canSend = hasContent && !sending && !streaming && !awaiting && !hasUploadingFiles;
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
    StreamStore.send(convId, (input || '').trim());
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
          <div className="composer-box">
            <textarea
              ref={composerTextRef}
              rows={3}
              placeholder={
                awaiting
                  ? 'Answer the prompt above to continue…'
                  : streaming ? 'Agent is running — Enter queues behind the current run.' : 'Message Agent Cockpit…'
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
              <ComposerCliUpdateIcon
                cliProfileId={topbarCliProfileId}
                backendId={topbarBackendId}
                onOpenSettings={onOpenSettings}
              />
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
                  title="Send"
                  aria-label="Send"
                  style={!canSend ? {opacity:.4,cursor:"not-allowed"} : undefined}
                >
                  {Ico.up(14)}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <SessionsModal
        open={sessionsOpen}
        convId={convId}
        currentSessionNumber={conv.sessionNumber || null}
        currentMessages={messages}
        onClose={() => setSessionsOpen(false)}
      />
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

function MessageBubble({ message, isStreaming, attachedProgress, elapsedMs }){
  const isUser = message.role === 'user';
  const contentRef = React.useRef(null);
  const [copied, setCopied] = React.useState(null);
  const hasContent = !!(message.content && message.content.trim());

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

  const showActions = hasContent && !isStreaming;

  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-agent'} ${message.streamError ? 'msg-stream-error' : ''}`}>
      {isUser ? (
        <span className="avatar">DY</span>
      ) : (
        <AssistantAvatar backend={message.backend}/>
      )}
      <div className="body">
        {isUser ? (
          <div ref={contentRef}>
            <UserMessageBody content={message.content || ''}/>
          </div>
        ) : (
          <>
            <div className="head">
              <span className="who">{message.backend || 'assistant'}</span>
              <span>·</span>
              <span>{isStreaming ? 'streaming…' : msgTime(message.timestamp)}</span>
              {elapsedMs != null && !isStreaming ? (
                <span className="msg-elapsed" title="Time since the previous user message">{formatMsgElapsed(elapsedMs)}</span>
              ) : null}
            </div>
            {attachedProgress && attachedProgress.length ? (
              <ProgressBreadcrumb progressRun={attachedProgress}/>
            ) : null}
            <div ref={contentRef}>
              <AssistantBody message={message} isStreaming={isStreaming}/>
            </div>
          </>
        )}
        {showActions && !isUser ? (
          <div className="msg-actions">
            <button type="button" className="msg-action" onClick={() => copy('msg')}>
              {copied === 'msg' ? 'Copied!' : 'Copy'}
            </button>
            <button type="button" className="msg-action" onClick={() => copy('md')} title="Copy raw markdown">
              {copied === 'md' ? 'Copied!' : 'Copy MD'}
            </button>
          </div>
        ) : null}
      </div>
      {showActions && isUser ? (
        <div className="msg-actions">
          <button type="button" className="msg-action" onClick={() => copy('msg')}>
            {copied === 'msg' ? 'Copied!' : 'Copy'}
          </button>
          <button type="button" className="msg-action" onClick={() => copy('md')} title="Copy raw markdown">
            {copied === 'md' ? 'Copied!' : 'Copy MD'}
          </button>
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
    if (typeof window !== 'undefined' && window.hljs) {
      root.querySelectorAll('pre code').forEach(el => {
        if (el.dataset.hljsHighlighted) return;
        try { window.hljs.highlightElement(el); } catch (e) {}
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
        const artifactRef = FileLinkUtils && FileLinkUtils.resolveConversationArtifactHref
          ? FileLinkUtils.resolveConversationArtifactHref(href, convId)
          : null;
        const artifactDescriptor = buildConversationArtifactDescriptor(artifactRef, convId);
        if (artifactDescriptor && openFileViewer) {
          e.preventDefault();
          openFileViewer(artifactDescriptor);
          return;
        }
        const ref = FileLinkUtils && FileLinkUtils.resolveLocalFileHref
          ? FileLinkUtils.resolveLocalFileHref(href, workingDir)
          : null;
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
      const artifactRef = FileLinkUtils && FileLinkUtils.resolveConversationArtifactHref
        ? FileLinkUtils.resolveConversationArtifactHref(href, convId)
        : null;
      if (artifactRef) {
        link.classList.add('local-file-link');
        link.title = artifactRef.line ? `Preview ${artifactRef.filename}:${artifactRef.line}` : `Preview ${artifactRef.filename}`;
        return;
      }
      const ref = FileLinkUtils && FileLinkUtils.resolveLocalFileHref
        ? FileLinkUtils.resolveLocalFileHref(href, workingDir)
        : null;
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
     safe. Claude Code → window.PlanUsageStore; Kiro → window.KiroPlanUsageStore;
     Codex → window.CodexPlanUsageStore. */
  const store = backendId === 'claude-code' ? window.PlanUsageStore
    : backendId === 'kiro'        ? window.KiroPlanUsageStore
    : backendId === 'codex'       ? window.CodexPlanUsageStore
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

/* Three cascading pickers below the composer: Profile → Model → Effort.
   Values flush to the server with the next /message POST (see StreamStore.send).
   Each chip wraps a transparent native <select> so we get native dropdown
   UX, keyboard/a11y for free, and the chip's styled shell. */
function ComposerPicks({ convId, backends, cliProfiles, composerCliProfileId, composerBackend, composerModel, composerEffort, profileLocked, disabled }){
  const activeProfiles = Array.isArray(cliProfiles) ? cliProfiles.filter(p => p && !p.disabled) : [];
  const selectedProfile = activeProfiles.find(p => p.id === composerCliProfileId)
    || (composerBackend ? activeProfiles.find(p => p.vendor === composerBackend) : null)
    || null;
  const effectiveBackendId = selectedProfile ? selectedProfile.vendor : composerBackend;
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

  const backend = (selectedProfile && profileBackend && profileBackend.id === selectedProfile.vendor)
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
          icon={selectedProfile ? <BackendInlineIcon backends={backends} backendId={selectedProfile.vendor}/> : null}
          onChange={v => {
            const profile = activeProfiles.find(p => p.id === v);
            if (profile) StreamStore.setComposerCliProfile(convId, profile.id, profile.vendor);
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
    </span>
  );
}

function costTierDot(tier){
  if (tier === 'high') return ' \u25cf';  // ●
  if (tier === 'low')  return ' \u25cb';  // ○
  return '';
}

function PickChip({ label, value, options, currentValue, onChange, disabled, title, icon }){
  return (
    <span className="pick" title={title} aria-disabled={disabled ? 'true' : 'false'}>
      {icon ? <span className="pick-icon">{icon}</span> : null}
      <span>{label}</span> <b>{value}</b>
      <span className="chev">{Ico.chevD(10)}</span>
      <select
        className="pick-select"
        value={currentValue}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        aria-label={title}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </span>
  );
}

/* Returns the background/foreground colors + 3-letter label for a typed
   AttachmentKind. Matches the mock's palette: images → subagent, pdf →
   error, text/md → accent, code → done, folders → awaiting. */
function attStyle(kind){
  switch(kind){
    case 'image':  return { bg: "color-mix(in oklch, var(--status-subagent), transparent 86%)", fg: "var(--status-subagent)", label: 'IMG' };
    case 'pdf':    return { bg: "color-mix(in oklch, var(--status-error), transparent 88%)",    fg: "var(--status-error)",    label: 'PDF' };
    case 'text':   return { bg: "color-mix(in oklch, var(--accent), transparent 88%)",          fg: "var(--accent)",          label: 'TXT' };
    case 'code':   return { bg: "color-mix(in oklch, var(--status-done), transparent 88%)",     fg: "var(--status-done)",     label: 'CODE' };
    case 'md':     return { bg: "color-mix(in oklch, var(--accent), transparent 88%)",          fg: "var(--accent)",          label: 'MD' };
    case 'folder': return { bg: "color-mix(in oklch, var(--status-awaiting), transparent 86%)", fg: "var(--status-awaiting)", label: 'DIR' };
    default:       return { bg: 'var(--surface-2)', fg: 'var(--text-3)', label: 'FILE' };
  }
}

/* Typed attachment chip. size='md' renders as a tray card (icon + name +
   meta + × button; images get a thumbnail and a corner kind badge). size='sm'
   renders as a compact pill used in queue rows and sent messages. */
function AttChip({ att, size = 'md', onRemove, onDissolve, onOcr, ocring, ocrCached, thumbUrl, uploading, progress }){
  const s = attStyle(att.kind);
  const isImage = att.kind === 'image';
  if (size === 'sm') {
    return (
      <span className="att-chip" title={att.name + (att.meta ? ' · ' + att.meta : '')}>
        <span className="att-chip-sm-tile" style={{background: s.bg, color: s.fg}}>
          {isImage && thumbUrl
            ? <span className="att-thumb-sm" style={{backgroundImage: 'url(' + thumbUrl + ')'}}/>
            : <span className="att-label-sm">{s.label}</span>}
        </span>
        <span className="att-chip-sm-name">{att.name}</span>
      </span>
    );
  }
  const dissolveBtn = onDissolve ? (
    <button
      type="button"
      className="att-dissolve"
      onClick={onDissolve}
      title="Inline text back into message"
      aria-label="Inline text back into message"
    >{Ico.up(11)}</button>
  ) : null;
  /* OCR is image-only; spins up a one-shot CLI server-side and inserts the
     resulting Markdown at the composer cursor. ocrCached flips the title so
     the user knows a re-click is instant rather than another CLI run. */
  const ocrBtn = (isImage && onOcr) ? (
    <button
      type="button"
      className={'att-ocr' + (ocring ? ' ocring' : '')}
      onClick={onOcr}
      disabled={!!ocring}
      title={ocring
        ? 'OCR in progress…'
        : (ocrCached ? 'Insert OCR Markdown (cached)' : 'OCR image to Markdown at cursor')}
      aria-label={ocring ? 'OCR in progress' : 'OCR image to Markdown'}
    >{ocring ? <span className="att-ocr-spin"/> : Ico.fileText(11)}</button>
  ) : null;
  if (isImage) {
    return (
      <div className={'att-card att-image' + (uploading ? ' uploading' : '') + (onDissolve ? ' has-dissolve' : '') + (onOcr ? ' has-ocr' : '')}>
        <div
          className="att-thumb"
          style={thumbUrl
            ? { backgroundImage: 'url(' + thumbUrl + ')' }
            : { background: s.bg, color: s.fg }}
        >
          <span className="att-kind-badge">{s.label}</span>
          {uploading ? <span className="att-upload-ring"><span className="ring"/></span> : null}
        </div>
        <div className="att-card-meta">
          <div className="att-name">{att.name}</div>
          <div className="att-sub">{att.meta || ''}</div>
        </div>
        {ocrBtn}
        {dissolveBtn}
        {onRemove ? (
          <button className="att-x" onClick={onRemove} title="Remove" aria-label="Remove">{Ico.x(11)}</button>
        ) : null}
      </div>
    );
  }
  return (
    <div className={'att-card' + (uploading ? ' uploading' : '') + (onDissolve ? ' has-dissolve' : '')}>
      <div className="att-icon" style={{background: s.bg, color: s.fg}}>
        <span className="att-label">{s.label}</span>
      </div>
      <div className="att-card-meta">
        <div className="att-name">{att.name}</div>
        <div className="att-sub">{att.meta || ''}</div>
        {uploading ? (
          <div className="att-progress"><i style={{width: (progress || 0) + '%'}}/></div>
        ) : null}
      </div>
      {dissolveBtn}
      {onRemove ? (
        <button className="att-x" onClick={onRemove} title="Remove" aria-label="Remove">{Ico.x(11)}</button>
      ) : null}
    </div>
  );
}

/* Composer attachment tray. Renders one AttChip (md) per PendingAttachment
   plus a dashed "Add" tile at the end. Image previews use a blob: URL
   created from the in-memory File so the thumbnail appears immediately —
   the URL is revoked when the entry unmounts. */
function AttTray({ convId, attachments, onRemove, onDissolve, onOcr, onAdd }){
  return (
    <div className="att-tray">
      {attachments.map(entry => (
        <PendingAttChip
          key={entry.id}
          convId={convId}
          entry={entry}
          onRemove={() => onRemove(entry.id)}
          onDissolve={onDissolve ? () => onDissolve(entry) : null}
          onOcr={onOcr ? () => onOcr(entry) : null}
        />
      ))}
      <button type="button" className="att-add" onClick={onAdd} title="Add attachment" aria-label="Add attachment">
        <span className="att-add-icon">{Ico.plus(14)}</span>
        <span>Add</span>
      </button>
    </div>
  );
}

/* AttChip wrapper that derives kind/meta/thumb from an in-flight or
   uploaded PendingAttachment. Image thumbs come from the File blob for
   fresh uploads; for entries rehydrated from localStorage (no Blob in
   memory), we fall back to the server-side file URL so the thumb still
   renders after a page reload. */
function PendingAttChip({ convId, entry, onRemove, onDissolve, onOcr }){
  const { file, status, progress, error, result } = entry;
  const kind = result ? result.kind : kindFromFile(file);
  const isImage = kind === 'image';
  const restored = !!entry.restored;
  const restoredName = restored ? ((result && result.name) || (file && file.name) || '') : '';
  /* Dissolve is only meaningful when we still have the original Blob in
     memory AND it's a paste-synthesized text file. Restored entries (loaded
     from localStorage on reload) lost the Blob, so the original text isn't
     recoverable client-side and we don't offer dissolve. */
  const dissolvable = !restored
    && file instanceof Blob
    && file.name && file.name.startsWith('pasted-text-')
    && typeof onDissolve === 'function';
  /* OCR offered only once the upload has landed (need result.path); restored
     entries qualify too since the file still lives on the server. */
  const ocrable = isImage
    && status === 'done'
    && result && result.path
    && typeof onOcr === 'function';
  const [thumb, setThumb] = React.useState(null);
  React.useEffect(() => {
    if (!isImage) return;
    if (restored) {
      if (convId && restoredName) {
        setThumb(AgentApi.chatUrl('conversations/' + encodeURIComponent(convId) + '/files/' + encodeURIComponent(restoredName)));
      }
      return;
    }
    if (!(file instanceof Blob)) return;
    const url = URL.createObjectURL(file);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage, restored, convId, restoredName]);
  const att = {
    name: (result && result.name) || (file && file.name) || '',
    path: result ? result.path : '',
    kind,
    meta: result && result.meta ? result.meta : fmtFileSize(file && file.size),
  };
  return (
    <div title={error || undefined} style={status === 'error' ? { outline: '1px solid var(--status-error)', borderRadius: 'var(--r-sm)' } : undefined}>
      <AttChip
        att={att}
        size="md"
        onRemove={onRemove}
        onDissolve={dissolvable ? onDissolve : null}
        onOcr={ocrable ? onOcr : null}
        ocring={entry.ocrStatus === 'running'}
        ocrCached={!!entry.ocrMarkdown}
        thumbUrl={thumb}
        uploading={status === 'uploading'}
        progress={progress}
      />
    </div>
  );
}

function kindFromFile(file){
  const name = file && file.name ? file.name : '';
  return (window.StreamStore && StreamStore.attachmentKindFromPath)
    ? StreamStore.attachmentKindFromPath(name)
    : 'file';
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

/* Banner shown above the queue stack when the queue was restored from a
   prior session (server had pending items at conv load time). Auto-drain is
   paused until the user Resumes or Clears, so stale queued messages don't
   fire unexpectedly on next page load. */
function SuspendedQueueBanner({ count, onResume, onClear }){
  return (
    <div className="qbanner qbanner-suspended">
      <span className="qbanner-text">
        {count} queued message{count !== 1 ? 's' : ''} from a previous session
      </span>
      <span className="qbanner-actions">
        <button type="button" className="btn primary" onClick={onResume} style={{padding:"2px 10px",fontSize:11}}>
          Resume
        </button>
        <button type="button" className="btn ghost" onClick={onClear} style={{padding:"2px 10px",fontSize:11}}>
          Clear
        </button>
      </span>
    </div>
  );
}

/* Queue stack — renders the mirrored server queue while a run is in flight.
   Rows show the text preview + an attachment strip, with per-row reorder
   and remove controls. Auto-drain happens in the StreamStore on each
   `done` frame, so the head disappears as the agent consumes it. */
function QueueStack({ convId, queue, onClear, onRemove, onMoveUp, onMoveDown }){
  const [expandedIndex, setExpandedIndex] = React.useState(null);
  // Collapse if the expanded row drains/removes out from underneath us
  React.useEffect(() => {
    if (expandedIndex != null && expandedIndex >= queue.length) setExpandedIndex(null);
  }, [queue.length, expandedIndex]);
  return (
    <div className="qstack">
      <div className="qstack-head">
        <span>Up next · {queue.length} message{queue.length !== 1 ? 's' : ''}</span>
        <span className="spacer"/>
        <button
          type="button"
          className="btn ghost"
          onClick={onClear}
          style={{padding:"2px 8px",fontSize:11}}
        >Clear queue</button>
      </div>
      {queue.map((q, i) => (
        expandedIndex === i && !q.inFlight ? (
          <QueueRowExpanded
            key={i}
            convId={convId}
            item={q}
            position={i + 1}
            index={i}
            first={i === 0}
            onClose={() => setExpandedIndex(null)}
            onRemove={() => { onRemove(i); setExpandedIndex(null); }}
            onMoveUp={() => onMoveUp(i)}
          />
        ) : (
          <QueueRow
            key={i}
            item={q}
            position={i + 1}
            first={i === 0}
            last={i === queue.length - 1}
            onRemove={() => onRemove(i)}
            onMoveUp={() => onMoveUp(i)}
            onMoveDown={() => onMoveDown(i)}
            onEdit={() => setExpandedIndex(i)}
          />
        )
      ))}
    </div>
  );
}

function QueueRow({ item, position, first, last, onRemove, onMoveUp, onMoveDown, onEdit }){
  const atts = Array.isArray(item.attachments) ? item.attachments : [];
  const textPreview = (item.content || '').split('\n')[0];
  const inFlight = !!item.inFlight;
  return (
    <div className={`qrow${inFlight ? ' qrow-in-flight' : ''}`}>
      <div className="qrow-top">
        <button className="qrow-handle" title="Drag to reorder" aria-label="Drag to reorder" disabled={inFlight}>{Ico.dots(12)}</button>
        <span className={`qrow-tag${inFlight ? ' qrow-tag-sending' : ''}`}>{inFlight ? 'sending…' : 'queued'}</span>
        <span className="qrow-num u-mono">#{position}</span>
        <span className="qrow-text">{textPreview || <span className="u-dim">(no text)</span>}</span>
        {inFlight ? null : (
          <span className="qrow-actions">
            <button className="iconbtn" title="Move up" disabled={first} onClick={onMoveUp} aria-label="Move up">{Ico.chevU(11)}</button>
            <button className="iconbtn" title="Move down" disabled={last} onClick={onMoveDown} aria-label="Move down">{Ico.chevD(11)}</button>
            <button className="iconbtn" title="Edit" onClick={onEdit} aria-label="Edit">{Ico.edit(11)}</button>
            <button className="iconbtn" title="Remove" onClick={onRemove} aria-label="Remove">{Ico.x(11)}</button>
          </span>
        )}
      </div>
      {atts.length ? (
        <div className="qrow-atts">
          <span className="qrow-atts-label u-mono">{atts.length} attached</span>
          {atts.map((a, i) => <AttChip key={i} att={a} size="sm"/>)}
        </div>
      ) : null}
    </div>
  );
}

/* Expanded queue row — inline editor. Pre-fills a textarea with the item's
   content and renders each attachment as a removable md AttChip. The "Add
   attachment" button uploads through the same per-conversation endpoint as
   the composer tray. Save persists via StreamStore.updateQueueItem (which
   PUTs /queue); Cancel discards the draft. */
function QueueRowExpanded({ convId, item, position, index, first, onClose, onRemove, onMoveUp }){
  const originalText = item.content || '';
  const originalAtts = Array.isArray(item.attachments) ? item.attachments : [];
  const dialog = useDialog();
  const [text, setText] = React.useState(originalText);
  const [atts, setAtts] = React.useState(originalAtts);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState('');
  const fileRef = React.useRef(null);
  const textRef = React.useRef(null);
  /* attName -> original pasted text. Only populated by this component's
     paste-to-attachment flow; lasts until the editor closes (state lives
     with the component). Lookup is what gates the dissolve button. */
  const dissolveMapRef = React.useRef(new Map());
  const dirty = text !== originalText || attsChanged(atts, originalAtts);
  async function save(){
    try {
      await StreamStore.updateQueueItem(convId, index, { content: text, attachments: atts });
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to save');
    }
  }
  function removeAtt(ai){
    const target = atts[ai];
    if (target && target.name) dissolveMapRef.current.delete(target.name);
    setAtts(atts.filter((_, i) => i !== ai));
  }
  function openFilePicker(){ if (fileRef.current) fileRef.current.click(); }
  async function uploadFiles(files, originalsByName){
    if (!files.length) return;
    setUploading(true);
    setError('');
    try {
      const uploaded = [];
      for (const file of files) {
        const result = await AgentApi.conv.uploadFile(convId, file);
        if (result) {
          uploaded.push(result);
          if (originalsByName && originalsByName.has(file.name) && result.name) {
            dissolveMapRef.current.set(result.name, originalsByName.get(file.name));
          }
        }
      }
      setAtts(cur => [...cur, ...uploaded]);
    } catch (err) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }
  async function onPickAdd(e){
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await uploadFiles(files);
  }
  /* Mirrors composer onPaste: ≥1000-char text → synthesized pasted-text-*.txt
     attachment uploaded into the conv's artifacts dir. Image-file pastes also
     route through the same upload path so behavior matches the main composer.
     Original pasted text is stashed in dissolveMapRef so the chip can offer
     a dissolve button (only available within this edit session). */
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
        uploadFiles(files);
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
      const fname = 'pasted-text-' + ts + '.txt';
      const textFile = new File([pastedText], fname, { type: 'text/plain' });
      const originals = new Map();
      originals.set(fname, pastedText);
      uploadFiles([textFile], originals);
    }
  }
  async function dissolveAtt(att, ai){
    const original = att && att.name ? dissolveMapRef.current.get(att.name) : null;
    if (!original) return;
    if (original.length > 50000) {
      const ok = await dialog.confirm({
        title: 'Inline this text into the message?',
        body: original.length.toLocaleString() + ' characters will be inserted into the editor.',
        confirmLabel: 'Inline',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
    }
    const ta = textRef.current;
    const current = ta ? ta.value : text;
    let nextValue;
    let caret;
    if (ta && typeof ta.selectionStart === 'number') {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      nextValue = current.slice(0, start) + original + current.slice(end);
      caret = start + original.length;
    } else {
      nextValue = current + original;
      caret = nextValue.length;
    }
    setText(nextValue);
    removeAtt(ai);
    /* Dissolve is the "undo the paste" path — the just-uploaded artifact
       should not linger on disk. Fire-and-forget delete; if it fails the
       chip is already gone from the queue draft so the next save won't
       reference it. Mirrors composer's removeAttachment cleanup. */
    if (att && att.name) AgentApi.conv.deleteUpload(convId, att.name).catch(() => {});
    requestAnimationFrame(() => {
      const t = textRef.current;
      if (!t) return;
      t.focus();
      try { t.setSelectionRange(caret, caret); } catch {}
    });
  }
  return (
    <div className="qexp">
      <div className="qexp-head">
        <span className="qrow-tag">queued</span>
        <span className="qrow-num u-mono">#{position}{index > 0 ? ` · in ${index} position${index === 1 ? '' : 's'}` : ''}</span>
        <span className="spacer"/>
        <span className="u-mono u-dim" style={{fontSize:10.5}}>editing</span>
      </div>
      <textarea
        ref={textRef}
        className="qexp-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        rows={4}
        autoFocus
      />
      <input ref={fileRef} type="file" multiple onChange={onPickAdd} style={{display:'none'}}/>
      {atts.length ? (
        <>
          <div className="qexp-att-head u-mono">{atts.length} attachment{atts.length === 1 ? '' : 's'}</div>
          <div className="qexp-atts">
            {atts.map((a, i) => (
              <AttChip
                key={i}
                att={a}
                onRemove={() => removeAtt(i)}
                onDissolve={a && a.name && dissolveMapRef.current.has(a.name)
                  ? () => dissolveAtt(a, i)
                  : null}
              />
            ))}
          </div>
        </>
      ) : null}
      {error ? <div className="u-mono" style={{fontSize:11, color:'var(--status-error)'}}>{error}</div> : null}
      <div className="qexp-foot">
        <button className="btn ghost" onClick={openFilePicker} disabled={uploading}>
          {Ico.paperclip(12)} <span>{uploading ? 'Uploading…' : 'Add attachment'}</span>
        </button>
        {!first ? (
          <button className="btn ghost" onClick={onMoveUp}>
            {Ico.chevU(12)} <span>Move up</span>
          </button>
        ) : null}
        <span className="spacer"/>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={!dirty || uploading}>Save</button>
        <button className="btn danger" onClick={onRemove} title="Remove from queue">
          {Ico.x(12)} <span>Remove</span>
        </button>
      </div>
    </div>
  );
}

function attsChanged(a, b){
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && (a[i].path || a[i].name) !== (b[i].path || b[i].name)) return true;
  }
  return false;
}

function fmtFileSize(n){
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
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
  const item = window.CliUpdateStore
    ? CliUpdateStore.findForSelection(cliProfileId, backendId)
    : null;
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
    if (!item || !item.updateAvailable) setOpen(false);
  }, [item && item.id, item && item.updateAvailable]);

  if (!item || !item.updateAvailable) return null;

  const title = item.label + ' update available';
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
              <div className="tt-kv"><span>Available</span><b>{item.latestVersion || 'unknown'}</b></div>
              <div className="tt-kv"><span>Install</span><b>{formatInstallMethod(item.installMethod)}</b></div>
              <div className="tt-kv"><span>Profile</span><b title={profileLabel}>{profileLabel}</b></div>
            </div>
          </div>
          {error ? (
            <div className="tt-section">
              <div className="tt-error-text">{error}</div>
            </div>
          ) : null}
          <div className="tt-foot">
            <span className="hint">{item.updateSupported ? 'No active stream can be running.' : 'Open settings for update details.'}</span>
            <span className="spacer"/>
            <button type="button" className="tt-btn" onClick={() => onOpenSettings && onOpenSettings('cli')}>CLI settings</button>
            <button type="button" className="tt-btn primary" disabled={busy || !item.updateSupported} onClick={doUpdate}>
              {busy ? 'Updating…' : 'Update now'}
            </button>
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
  const [expanded, setExpanded] = React.useState(false);
  const headline = changed.length === 0
    ? `Memory snapshot refreshed (${mu.fileCount} file${mu.fileCount === 1 ? '' : 's'})`
    : `Memory updated: ${changed.length} file${changed.length === 1 ? '' : 's'} changed`;
  const preview = changed.slice(0, 5);
  const extra = Math.max(0, changed.length - preview.length);
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
          {expanded && changed.length > 0 ? (
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

ReactDOM.createRoot(document.getElementById('root')).render(
  <DialogProvider><ToastProvider><BackendsProvider><CliProfilesProvider><App/></CliProfilesProvider></BackendsProvider></ToastProvider></DialogProvider>
);
