import React from 'react';
import { Ico } from './icons.jsx';
import { AgentApi } from './api.js';
import { StreamStore } from './streamStore.js';

/* ---------- Version indicator ---------- */
/* Sits in the sidebar footer. Fetches v{X} on mount, polls /update-status
   every 5 minutes for background update detection, and flips to "checking…"
   while a manual /check-version is in flight. When updateAvailable is true,
   a warning-tinted badge appears next to the version — clicking it invokes
   onShowUpdate so the App can render the Update modal. */
export function VersionIndicator({ onShowUpdate }){
  const [version, setVersion] = React.useState(null);
  const [remoteVersion, setRemoteVersion] = React.useState(null);
  const [updateAvailable, setUpdateAvailable] = React.useState(false);
  const [checking, setChecking] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    AgentApi.getVersion().then(v => {
      if (cancelled) return;
      if (v && v.version) setVersion(v.version);
      setRemoteVersion(v && v.remoteVersion ? v.remoteVersion : null);
      setUpdateAvailable(!!(v && v.updateAvailable));
    }).catch(() => {});
    const timer = setInterval(() => {
      AgentApi.getUpdateStatus().then(s => {
        if (cancelled) return;
        setRemoteVersion(s && s.remoteVersion ? s.remoteVersion : null);
        setUpdateAvailable(!!(s && s.updateAvailable));
      }).catch(() => {});
    }, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const onCheck = React.useCallback(async () => {
    if (checking) return;
    setChecking(true);
    try {
      const status = await AgentApi.checkVersion();
      if (status && status.localVersion) setVersion(status.localVersion);
      setRemoteVersion(status && status.remoteVersion ? status.remoteVersion : null);
      setUpdateAvailable(!!(status && status.updateAvailable));
    } catch {
      /* Swallow — the label falls back to its previous value. */
    } finally {
      setChecking(false);
    }
  }, [checking]);

  if (!version && !checking) return null;

  return (
    <div className="sb-version">
      <button
        type="button"
        className="sb-version-text"
        onClick={onCheck}
        title="Click to check for updates"
        disabled={checking}
      >{checking ? 'checking…' : `v${version}`}</button>
      {updateAvailable && remoteVersion ? (
        <button
          type="button"
          className="sb-update-badge"
          title={`Update to v${remoteVersion}`}
          onClick={() => { if (onShowUpdate) onShowUpdate({ localVersion: version, remoteVersion }); }}
        >v{remoteVersion} available</button>
      ) : null}
    </div>
  );
}

/* ---------- helpers shared by the Sidebar ---------- */

const ALL_WORKSPACES = '__all__';
const WORKSPACE_FILTER_KEY = 'ac:v2:workspace-filter';

function workspaceLabelForConv(c){
  const parts = (c.workingDir || '').split('/').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return c.workingDir || 'Default workspace';
}

function workspaceKeyForConv(c){
  return c.workspaceHash || `path:${c.workingDir || ''}`;
}

function buildWorkspaceOptions(convs){
  const byKey = new Map();
  for (const c of convs || []) {
    const key = workspaceKeyForConv(c);
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        hash: c.workspaceHash || '',
        label: workspaceLabelForConv(c),
        fullPath: c.workingDir || '',
        kbEnabled: false,
        count: 0,
      });
    }
    const ws = byKey.get(key);
    ws.count += 1;
    if (c.workspaceKbEnabled) ws.kbEnabled = true;
    if (!ws.fullPath && c.workingDir) ws.fullPath = c.workingDir;
  }
  return Array.from(byKey.values()).sort((a, b) => (
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) ||
    a.fullPath.localeCompare(b.fullPath, undefined, { sensitivity: 'base' })
  ));
}

function sortConvsByActivity(convs){
  return [...(convs || [])].sort((a, b) => {
    const at = new Date(a.updatedAt || 0).getTime();
    const bt = new Date(b.updatedAt || 0).getTime();
    return bt - at;
  });
}

function timeAgo(iso){
  if (!iso) return '';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function readWorkspaceFilter(){
  try {
    return window.localStorage.getItem(WORKSPACE_FILTER_KEY) || ALL_WORKSPACES;
  } catch (e) {
    return ALL_WORKSPACES;
  }
}

function writeWorkspaceFilter(value){
  try { window.localStorage.setItem(WORKSPACE_FILTER_KEY, value || ALL_WORKSPACES); }
  catch (e) {}
}

/* Sidebar width is persisted via the `--cockpit-sb-w` CSS variable set on
   `document.documentElement`. `web/AgentCockpitWeb/index.html` reads the saved value
   pre-paint so the grid is correctly sized before React boots. */
const SB_WIDTH_KEY = 'ac:v2:sb-width';
const SB_WIDTH_DEFAULT = 260;
const SB_WIDTH_MIN = 200;
const SB_WIDTH_MAX = 600;

function loadSbWidth(){
  try {
    const raw = window.localStorage.getItem(SB_WIDTH_KEY);
    if (!raw) return SB_WIDTH_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return SB_WIDTH_DEFAULT;
    return Math.max(SB_WIDTH_MIN, Math.min(SB_WIDTH_MAX, Math.round(n)));
  } catch { return SB_WIDTH_DEFAULT; }
}

function saveSbWidth(width){
  try { window.localStorage.setItem(SB_WIDTH_KEY, String(Math.round(width))); }
  catch {}
}

/* Identity-provider logos shown in the sidebar footer avatar. Multi-color
   Google "G" and dark-fill GitHub octocat — designed to sit on a neutral/
   white circle so the brand colors read clearly. Inline so we don't pull in
   any asset files. */
const ProviderLogo = {
  google: (size = 14) => (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
      <path fill="#34A853" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
      <path fill="#FBBC05" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
      <path fill="#EA4335" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
    </svg>
  ),
  github: (size = 14) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#24292f" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
    </svg>
  ),
};

/* Footer user block. `user` comes from GET /api/me — shape:
   { displayName: string|null, email: string|null, provider: 'local'|'google'|'github'|null }.
   null until the fetch resolves (initial paint or test screens with no prop). */
function SidebarUser({ user }){
  if (!user || (!user.displayName && !user.email && !user.provider)) {
    return <span className="user" aria-hidden="true"><span className="avatar avatar-empty"/></span>;
  }
  const name = user.displayName || (user.email ? user.email.split('@')[0] : 'User');
  const logo = user.provider && ProviderLogo[user.provider] ? ProviderLogo[user.provider]() : null;
  const providerLabel = user.provider === 'local'
    ? 'Local owner'
    : user.provider === 'google' ? 'Google' : user.provider === 'github' ? 'GitHub' : null;
  return (
    <span className="user">
      <span
        className={"avatar" + (logo ? " avatar-provider" : "")}
        title={providerLabel ? `Signed in with ${providerLabel}` : undefined}
      >
        {logo || (name[0] || '?').toUpperCase()}
      </span>
      <span>{name}</span>
    </span>
  );
}

/* ---------- Sidebar (shared across screens) ---------- */
export function Sidebar({ activeId = null, onSelect = null, onMarkUnread = null, convStates = null, onOpenKb = null, onOpenFiles = null, onOpenSettings = null, onOpenWorkspaceSettings = null, onNewConversation = null, viewingArchive = false, onToggleArchive = null, onRestore = null, onSignOut = null, onShowUpdate = null, user = null }){
  /* Conv list is owned by StreamStore — we only subscribe here. That way
     `title_updated`, archive, rename, delete, create all flow into the
     sidebar without React-prop refresh tokens. */
  const [listState, setListState] = React.useState(() => StreamStore.getConvList());
  const convs = listState.items;
  const err = listState.error;
  const [query, setQuery] = React.useState('');
  const [debouncedQuery, setDebouncedQuery] = React.useState('');
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = React.useState(readWorkspaceFilter);
  const [workspaceOptions, setWorkspaceOptions] = React.useState([]);
  const [sbWidth, setSbWidth] = React.useState(loadSbWidth);
  const [sbResizing, setSbResizing] = React.useState(false);
  const searchInputRef = React.useRef(null);
  const sbWidthRef = React.useRef(sbWidth);
  sbWidthRef.current = sbWidth;

  React.useEffect(() => {
    document.documentElement.style.setProperty('--cockpit-sb-w', sbWidth + 'px');
  }, [sbWidth]);

  const onSbResizerMouseDown = React.useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = sbWidthRef.current;
    setSbResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      const next = Math.max(SB_WIDTH_MIN, Math.min(SB_WIDTH_MAX, startW + (ev.clientX - startX)));
      setSbWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSbResizing(false);
      saveSbWidth(sbWidthRef.current);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const onSbResizerDoubleClick = React.useCallback(() => {
    setSbWidth(SB_WIDTH_DEFAULT);
    saveSbWidth(SB_WIDTH_DEFAULT);
  }, []);

  /* 300 ms debounce on the search input — matches V1. */
  React.useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(handle);
  }, [query]);

  /* Subscribe once to the store; every mutation re-renders this component. */
  React.useEffect(() => {
    return StreamStore.subscribeConvList(() => {
      setListState({ ...StreamStore.getConvList() });
    });
  }, []);

  /* Re-fetch whenever the debounced query or archive view changes. The
     server satisfies `q` by matching against title, lastMessage, and full
     message content. */
  React.useEffect(() => {
    StreamStore.loadConvList({ query: debouncedQuery, archived: viewingArchive });
  }, [debouncedQuery, viewingArchive]);

  React.useEffect(() => {
    if (!convs || debouncedQuery) return;
    setWorkspaceOptions(buildWorkspaceOptions(convs));
  }, [convs, debouncedQuery, viewingArchive]);

  React.useEffect(() => {
    if (!convs || debouncedQuery || selectedWorkspaceKey === ALL_WORKSPACES) return;
    const hasWorkspace = buildWorkspaceOptions(convs).some(ws => ws.key === selectedWorkspaceKey);
    if (!hasWorkspace) {
      setSelectedWorkspaceKey(ALL_WORKSPACES);
      writeWorkspaceFilter(ALL_WORKSPACES);
    }
  }, [convs, debouncedQuery, selectedWorkspaceKey]);

  /* Once-per-mount: seed `uiState: 'streaming'` for convs whose CLI stream
     survived the page refresh (buffered on the server, not in the wiped
     ConvState). Without this, the blue dots disappear on refresh even
     though the stream still runs in the background. */
  React.useEffect(() => {
    StreamStore.hydrateActiveStreams();
  }, []);

  /* ⌘K / Ctrl+K focuses the search input. Matches V1. The ⌘N hint on the
     New-conversation button is decorative only — V1 never bound the shortcut
     either, since ⌘N / Ctrl+N is reserved by the browser for "new window". */
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const el = searchInputRef.current;
        if (el) { el.focus(); el.select(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const workspaceByKey = React.useMemo(() => {
    const map = new Map();
    workspaceOptions.forEach(ws => map.set(ws.key, ws));
    return map;
  }, [workspaceOptions]);
  const activeConversation = React.useMemo(() => {
    if (!activeId) return null;
    const listed = (convs || []).find(c => c.id === activeId);
    if (listed) return listed;
    const state = StreamStore.getState ? StreamStore.getState(activeId) : null;
    return state && state.conv ? state.conv : null;
  }, [activeId, convs, convStates]);
  const selectedWorkspace = selectedWorkspaceKey === ALL_WORKSPACES
    ? null
    : workspaceByKey.get(selectedWorkspaceKey) || null;
  const activeConversationWorkspace = React.useMemo(() => {
    if (!activeConversation || !activeConversation.workspaceHash) return null;
    const key = workspaceKeyForConv(activeConversation);
    return workspaceByKey.get(key) || {
      key,
      hash: activeConversation.workspaceHash || '',
      label: workspaceLabelForConv(activeConversation),
      fullPath: activeConversation.workingDir || '',
      kbEnabled: !!activeConversation.workspaceKbEnabled,
      count: 1,
    };
  }, [activeConversation, workspaceByKey]);
  const actionWorkspace = selectedWorkspace && selectedWorkspace.hash
    ? selectedWorkspace
    : selectedWorkspaceKey === ALL_WORKSPACES
      ? activeConversationWorkspace
      : null;
  const newConversationInitialPath = selectedWorkspace && selectedWorkspace.fullPath
    ? selectedWorkspace.fullPath
    : null;
  const actionWorkspaceSource = selectedWorkspace && selectedWorkspace.hash
    ? 'selected'
    : actionWorkspace
      ? 'active'
      : null;
  const visibleConvs = React.useMemo(() => {
    if (!convs) return null;
    const filtered = selectedWorkspaceKey === ALL_WORKSPACES
      ? convs
      : convs.filter(c => workspaceKeyForConv(c) === selectedWorkspaceKey);
    return sortConvsByActivity(filtered);
  }, [convs, selectedWorkspaceKey]);
  const showWorkspaceLabel = selectedWorkspaceKey === ALL_WORKSPACES;

  function onWorkspaceFilterChange(value){
    setSelectedWorkspaceKey(value);
    writeWorkspaceFilter(value);
  }

  return (
    <aside className="sb">
      <div className="sb-top">
        <span className="sb-brand">
          <span className="sb-logo"><img src="/logo-full-no-text.svg" alt="Agent Cockpit"/></span>
          <span className="sb-wordmark">Agent Cockpit</span>
        </span>
      </div>

      <button
        className="sb-new"
        type="button"
        onClick={onNewConversation ? () => onNewConversation(newConversationInitialPath) : undefined}
        disabled={!onNewConversation}
      >
        <span style={{display:"inline-flex",alignItems:"center",gap:8}}>
          {Ico.plus(14)} New conversation
        </span>
      </button>

      <div className="sb-workspace-filter">
        <span className="sb-filter-label">Workspace</span>
        <div className="sb-workspace-control">
          <span className="sb-select-wrap">
            <select
              value={selectedWorkspaceKey}
              onChange={(e) => onWorkspaceFilterChange(e.currentTarget.value)}
              aria-label="Workspace filter"
              title={selectedWorkspace ? selectedWorkspace.fullPath : 'Show conversations from every workspace'}
              disabled={!workspaceOptions.length}
            >
              <option value={ALL_WORKSPACES}>All Workspaces</option>
              {workspaceOptions.map(ws => (
                <option key={ws.key} value={ws.key}>{ws.label}</option>
              ))}
            </select>
            <span className="sb-select-chev" aria-hidden="true">{Ico.chevD(12)}</span>
          </span>
          {actionWorkspace && actionWorkspace.hash ? (
            <span className="sb-workspace-actions">
              {actionWorkspace.kbEnabled ? (
                <button
                  type="button"
                  className="iconbtn persist"
                  title={`Knowledge base: ${actionWorkspace.label}${actionWorkspaceSource === 'active' ? ' (active conversation)' : ''}`}
                  onClick={() => { if (onOpenKb) onOpenKb(actionWorkspace.hash, actionWorkspace.label); }}
                >{Ico.book(12)}</button>
              ) : null}
              <button
                type="button"
                className="iconbtn"
                title={`Files: ${actionWorkspace.label}${actionWorkspaceSource === 'active' ? ' (active conversation)' : ''}`}
                onClick={() => { if (onOpenFiles) onOpenFiles(actionWorkspace.hash, actionWorkspace.label); }}
              >{Ico.folder(12)}</button>
              <button
                type="button"
                className="iconbtn"
                title={`Workspace settings: ${actionWorkspace.label}${actionWorkspaceSource === 'active' ? ' (active conversation)' : ''}`}
                onClick={() => { if (onOpenWorkspaceSettings) onOpenWorkspaceSettings(actionWorkspace.hash, actionWorkspace.label); }}
              >{Ico.settings(12)}</button>
            </span>
          ) : null}
        </div>
      </div>

      <div className="sb-search">
        {Ico.search(13)}
        <input
          ref={searchInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); }
          }}
          placeholder="Search conversations"
          aria-label="Search conversations"
        />
        {query ? (
          <button
            type="button"
            className="sb-search-clear"
            title="Clear"
            aria-label="Clear search"
            onClick={() => { setQuery(''); const el = searchInputRef.current; if (el) el.focus(); }}
          >{Ico.x(12)}</button>
        ) : null}
      </div>

      <div className="sb-scroll">
        {err ? (
          <div className="sb-empty u-dim" style={{padding:"12px 14px",fontSize:12}}>
            {err}
          </div>
        ) : convs === null ? (
          <div className="sb-empty u-dim" style={{padding:"12px 14px",fontSize:12}}>
            Loading conversations…
          </div>
        ) : visibleConvs.length === 0 ? (
          <div className="sb-empty u-dim" style={{padding:"12px 14px",fontSize:12}}>
            {debouncedQuery
              ? selectedWorkspace
                ? <>No matches in <b>{selectedWorkspace.label}</b>.</>
                : <>No matches for <b>{debouncedQuery}</b>.</>
              : viewingArchive
                ? selectedWorkspace
                  ? <>No archived conversations in <b>{selectedWorkspace.label}</b>.</>
                  : <>No archived conversations.</>
                : selectedWorkspace
                  ? <>No conversations in <b>{selectedWorkspace.label}</b>.</>
                  : <>No conversations yet. Click <b>New conversation</b> to start.</>}
          </div>
        ) : visibleConvs.map(c => {
              const isActive = c.id === activeId;
              const selectable = typeof onSelect === 'function';
              const state = convStates ? convStates[c.id] : null;
              /* Priority: live status (streaming/awaiting/error) > unread.
                 'idle' is the StreamStore sentinel meaning "touched conv,
                 explicitly not unread" — it suppresses the c.unread fallback
                 so the dot clears immediately on selection without waiting
                 for the server-cached list to refresh. For untouched convs
                 (no entry in convStates), c.unread from the server list is
                 the source of truth. */
              const liveState = (state === 'streaming' || state === 'awaiting' || state === 'error') ? state : null;
              const isUnread = !liveState && (
                state === 'unread' || (state == null && c.unread === true)
              );
              const stateClass = liveState
                ? ` ${liveState}`
                : (isUnread ? ' unread' : '');
              const canMarkUnread = !liveState && !isUnread && !isActive && typeof onMarkUnread === 'function';
              return (
                <div
                  key={c.id}
                  className={`sb-row ${isActive ? 'active' : ''}${stateClass}`}
                  title={c.title}
                  data-conv-id={c.id}
                  role={selectable ? 'button' : undefined}
                  tabIndex={selectable ? 0 : undefined}
                  onClick={selectable ? () => onSelect(c.id) : undefined}
                  onKeyDown={selectable ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(c.id); }
                  } : undefined}
                  style={selectable ? { cursor: 'pointer' } : undefined}
                >
                  {canMarkUnread ? (
                    <button
                      type="button"
                      className="dot dot-btn"
                      title="Mark as unread"
                      aria-label="Mark as unread"
                      onClick={(e) => { e.stopPropagation(); onMarkUnread(c.id); }}
                    />
                  ) : (
                    <span className="dot"/>
                  )}
                  <span className="sb-row-main">
                    <span className="title">{c.title || 'Untitled'}</span>
                    {showWorkspaceLabel ? (
                      <span className="workspace">{workspaceLabelForConv(c)}</span>
                    ) : null}
                  </span>
                  {viewingArchive && onRestore ? (
                    <button
                      type="button"
                      className="sb-row-restore"
                      title="Restore conversation"
                      aria-label="Restore conversation"
                      onClick={(e) => { e.stopPropagation(); onRestore(c.id); }}
                    >{Ico.reset(12)}</button>
                  ) : (
                    <span className="meta">{timeAgo(c.updatedAt)}</span>
                  )}
                </div>
              );
        })}
      </div>

      {onToggleArchive ? (
        <button
          type="button"
          className={"sb-archive-toggle" + (viewingArchive ? " active" : "")}
          onClick={onToggleArchive}
        >
          {viewingArchive ? (
            <><span aria-hidden="true" style={{fontSize:14,lineHeight:1}}>←</span> Back to conversations</>
          ) : (
            <>{Ico.archive(12)} Archive</>
          )}
        </button>
      ) : null}

      <div className="sb-footer">
        <SidebarUser user={user}/>
        <span style={{display:"inline-flex",gap:10,alignItems:"center"}}>
          <button
            type="button"
            className="sb-footer-icon"
            title="Settings"
            onClick={() => { if (onOpenSettings) onOpenSettings(); }}
          >{Ico.settings(14)}</button>
          {onSignOut ? (
            <button
              type="button"
              className="sb-footer-icon"
              title="Sign out"
              aria-label="Sign out"
              onClick={(e) => onSignOut(e.currentTarget)}
            >{Ico.logout(14)}</button>
          ) : null}
        </span>
      </div>

      <VersionIndicator onShowUpdate={onShowUpdate} />

      <div
        className={"sb-resizer" + (sbResizing ? " dragging" : "")}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize · double-click to reset"
        onMouseDown={onSbResizerMouseDown}
        onDoubleClick={onSbResizerDoubleClick}
      />
    </aside>
  );
}

/* ---------- Tool rows ---------- */
export function PrimitiveToolRow({ state="done", name, arg, ms, chev=true }){
  return (
    <div className={`tool ${state}`}>
      <span className="marker"/>
      <span><span className="name">{name}</span> <span className="arg">{arg}</span></span>
      <span className="ms">{ms}</span>
      {chev ? <span className="chev">{Ico.chev(12)}</span> : <span/>}
    </div>
  );
}

export function Breadcrumb({ steps }){
  return (
    <div className="breadcrumb">
      {steps.map((s,i) => (
        <span key={i} className={`step ${s.done?"done":""}`}>
          <span className="marker"/>{s.label}
        </span>
      ))}
    </div>
  );
}
