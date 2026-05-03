/* global React, AgentApi, Ico, marked, DOMPurify, useDialog, useToasts, SynthesisAtlas */

/* KB Browser — modal-swap over the chat main pane.
   Tabs: Raw (stub), Entries (wired), Synthesis (wired), Reflections (wired), Settings (stub). */

const ENTRIES_PAGE_SIZE = 50;

function renderMd(md){
  if (!md) return '';
  const raw = marked.parse(String(md), { breaks: true, gfm: true });
  return DOMPurify.sanitize(raw);
}

/* Rewrite relative markdown image paths inside an entry body so they hit the
   raw-media endpoint. Ingestion writes embedded images into
   `converted/<rawId>/media|slides|pages/...` and the entry body references
   them with relative paths — those don't resolve against `/v2/` in the
   browser, so we map them to `/api/.../kb/raw/<rawId>/media/<path>`. */
function rewriteEntryMediaPaths(md, hash, rawId){
  if (!md || !rawId) return md || '';
  return String(md).replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (full, alt, url, title) => {
    if (/^(?:[a-z]+:|\/\/|[\/#])/i.test(url)) return full;
    const abs = AgentApi.kb.rawMediaUrl(hash, rawId, url);
    return `![${alt}](${abs}${title || ''})`;
  });
}

/* Rewrite V1's `[Entry: title](entryId)` pattern so the resulting <a href>
   is a safe fragment we can intercept. Marked + DOMPurify preserve `#...` hrefs. */
function preprocessReflectionMd(md){
  if (!md) return '';
  return String(md).replace(/\[Entry:\s*([^\]]+)\]\(([^)\s]+)\)/g, '[$1](#kb-entry:$2)');
}

function interceptEntryLink(event, onOpen){
  const a = event.target.closest && event.target.closest('a[href^="#kb-entry:"]');
  if (!a) return;
  event.preventDefault();
  const entryId = decodeURIComponent(a.getAttribute('href').slice('#kb-entry:'.length));
  if (entryId && onOpen) onOpen(entryId);
}

/* Click-to-zoom on inline `<img>` rendered from entry/reflection markdown.
   If the click is inside an `<a>` (linked image) the link handler wins. */
function interceptImageClick(event, onOpen){
  if (event.target.closest && event.target.closest('a')) return;
  const img = event.target.closest && event.target.closest('img');
  if (!img || !img.src) return;
  event.preventDefault();
  onOpen(img.src, img.alt || '');
}

function KbImageLightbox({ src, alt, onClose }){
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="kb-lightbox" role="dialog" aria-label="Image preview" onClick={onClose}>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()}/>
      <button className="kb-lightbox-close" onClick={onClose}>Close</button>
    </div>
  );
}

function KbBrowser({ hash, label, onClose }){
  const [tab, setTab] = React.useState('entries');
  const [kbState, setKbState] = React.useState(null);
  const [kbErr, setKbErr] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    AgentApi.kb.getState(hash)
      .then(s => { if (!cancelled) setKbState(s); })
      .catch(e => { if (!cancelled) setKbErr(e.message || String(e)); });
    return () => { cancelled = true; };
  }, [hash]);

  const counters = kbState && kbState.counters ? kbState.counters : null;
  const totals = counters ? {
    raw: counters.rawTotal || 0,
    entries: counters.entryCount || 0,
    topics: counters.topicCount || 0,
    connections: counters.connectionCount || 0,
    reflections: counters.reflectionCount || 0,
  } : null;

  return (
    <div className="kb-shell">
      <div className="kb-top">
        <span style={{display:"inline-flex",alignItems:"center",gap:8}}>
          <span style={{width:18,height:18,borderRadius:4,background:"var(--accent-soft)",display:"inline-flex",alignItems:"center",justifyContent:"center",color:"var(--accent)"}}>◎</span>
          <span className="title">Knowledge Base</span>
        </span>
        <span className="ws">{label}</span>
        {totals ? (
          <span className="u-mono u-dim" style={{fontSize:10.5}}>
            {totals.raw} files · {totals.entries} entries · {totals.topics} topics · {totals.connections} connections · {totals.reflections} reflections
          </span>
        ) : kbErr ? (
          <span className="u-err" style={{fontSize:11}}>{kbErr}</span>
        ) : (
          <span className="u-dim" style={{fontSize:11}}>Loading…</span>
        )}
        <span style={{marginLeft:"auto",display:"flex",gap:6}}>
          <button className="btn" onClick={onClose}>Close</button>
        </span>
      </div>

      <div className="kb-tabs">
        <KbNavTab id="raw"         label="Raw"         active={tab} onClick={setTab} count={totals ? totals.raw : null}/>
        <KbNavTab id="entries"     label="Entries"     active={tab} onClick={setTab} count={totals ? totals.entries : null}/>
        <KbNavTab id="synthesis"   label="Synthesis"   active={tab} onClick={setTab}/>
        <KbNavTab id="reflections" label="Reflections" active={tab} onClick={setTab}/>
        <KbNavTab id="settings"    label="Settings"    active={tab} onClick={setTab}/>
      </div>

      {tab === 'raw'         ? <KbRawTab hash={hash} kbState={kbState} onStateUpdate={setKbState}/> : null}
      {tab === 'entries'     ? <KbEntriesTab hash={hash}/> : null}
      {tab === 'synthesis'   ? <KbSynthesisTab hash={hash}/> : null}
      {tab === 'reflections' ? <KbReflectionsTab hash={hash}/> : null}
      {tab === 'settings'    ? <KbSettingsTab hash={hash}/> : null}
    </div>
  );
}

function KbNavTab({ id, label, active, onClick, count }){
  return (
    <div
      className={`kb-tab ${active === id ? 'active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onClick(id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(id); } }}
    >
      {label}{count != null ? ` · ${count}` : ''}
    </div>
  );
}

/* Presets for the Uploaded / Digested date filters. Mirrors V1
   `chatKbBrowserResolveDateRange` (`main.js:2850-2876`). `today` is the
   start of the local day; the `Nd` presets step back N days from today. */
const KB_DATE_PRESETS = [
  { id: 'all',    label: 'All time' },
  { id: 'today',  label: 'Today' },
  { id: '7d',     label: 'Last 7 days' },
  { id: '30d',    label: 'Last 30 days' },
  { id: '90d',    label: 'Last 90 days' },
  { id: 'custom', label: 'Custom…' },
];

function resolveKbDateRange(preset, fromDate, toDate){
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  const daysAgo = (n) => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return startOfDay(d);
  };
  switch (preset) {
    case 'today':  return { from: startOfDay(now), to: '' };
    case '7d':     return { from: daysAgo(7),  to: '' };
    case '30d':    return { from: daysAgo(30), to: '' };
    case '90d':    return { from: daysAgo(90), to: '' };
    case 'custom': return {
      from: fromDate ? new Date(fromDate + 'T00:00:00').toISOString() : '',
      to:   toDate   ? new Date(toDate   + 'T23:59:59.999').toISOString() : '',
    };
    default: return { from: '', to: '' };
  }
}

/* ---------- Entries tab ---------- */
function KbEntriesTab({ hash }){
  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [tags, setTags] = React.useState([]);            // [{tag, count}]
  const [selectedTags, setSelectedTags] = React.useState([]);
  const [uploadedPreset, setUploadedPreset] = React.useState('all');
  const [uploadedFrom, setUploadedFrom] = React.useState('');
  const [uploadedTo, setUploadedTo] = React.useState('');
  const [digestedPreset, setDigestedPreset] = React.useState('all');
  const [digestedFrom, setDigestedFrom] = React.useState('');
  const [digestedTo, setDigestedTo] = React.useState('');
  const [data, setData] = React.useState(null);          // { entries, total }
  const [offset, setOffset] = React.useState(0);
  const [err, setErr] = React.useState(null);
  const [openEntry, setOpenEntry] = React.useState(null);

  React.useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setOffset(0); }, 200);
    return () => clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    let cancelled = false;
    AgentApi.kb.getTags(hash)
      .then(r => { if (!cancelled) setTags(r.tags || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [hash]);

  const uploaded = resolveKbDateRange(uploadedPreset, uploadedFrom, uploadedTo);
  const digested = resolveKbDateRange(digestedPreset, digestedFrom, digestedTo);

  React.useEffect(() => {
    let cancelled = false;
    setData(null); setErr(null);
    AgentApi.kb.getEntries(hash, {
      search: debounced,
      tags: selectedTags.join(','),
      uploadedFrom: uploaded.from,
      uploadedTo: uploaded.to,
      digestedFrom: digested.from,
      digestedTo: digested.to,
      limit: ENTRIES_PAGE_SIZE,
      offset,
    })
      .then(r => { if (!cancelled) setData(r); })
      .catch(e => { if (!cancelled) setErr(e.message || String(e)); });
    return () => { cancelled = true; };
  }, [hash, debounced, selectedTags, offset, uploaded.from, uploaded.to, digested.from, digested.to]);

  /* Any preset/date change resets pagination to the first page, since the
     total count changes. Without this the user can land on an empty page. */
  React.useEffect(() => { setOffset(0); }, [uploadedPreset, uploadedFrom, uploadedTo, digestedPreset, digestedFrom, digestedTo]);

  const hasDateFilter = uploadedPreset !== 'all' || digestedPreset !== 'all';
  function clearDateFilters(){
    setUploadedPreset('all'); setUploadedFrom(''); setUploadedTo('');
    setDigestedPreset('all'); setDigestedFrom(''); setDigestedTo('');
  }

  function toggleTag(t){
    setSelectedTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
    setOffset(0);
  }

  const total = data ? data.total : 0;
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + ENTRIES_PAGE_SIZE, total);

  return (
    <div className="kb-pane">
      <div className="kb-filters">
        <input
          type="text"
          placeholder="Search titles or filenames…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="kb-search-input"
        />
        <div className="kb-date-row">
          <KbDateFilter
            label="Uploaded"
            preset={uploadedPreset}
            from={uploadedFrom}
            to={uploadedTo}
            onPreset={setUploadedPreset}
            onFrom={setUploadedFrom}
            onTo={setUploadedTo}
          />
          <KbDateFilter
            label="Digested"
            preset={digestedPreset}
            from={digestedFrom}
            to={digestedTo}
            onPreset={setDigestedPreset}
            onFrom={setDigestedFrom}
            onTo={setDigestedTo}
          />
          {hasDateFilter ? (
            <button type="button" className="kb-date-clear" onClick={clearDateFilters}>
              Clear dates
            </button>
          ) : null}
        </div>
        {tags.length > 0 ? (
          <div className="kb-tag-row">
            {tags.slice(0, 24).map(t => (
              <button
                key={t.tag}
                type="button"
                className={`kb-tag-chip ${selectedTags.includes(t.tag) ? 'on' : ''}`}
                onClick={() => toggleTag(t.tag)}
                title={`${t.count} entr${t.count === 1 ? 'y' : 'ies'}`}
              >{t.tag} <span className="n">{t.count}</span></button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="kb-list">
        {err ? (
          <div className="u-err" style={{padding:"16px"}}>{err}</div>
        ) : data === null ? (
          <div className="u-dim" style={{padding:"16px"}}>Loading entries…</div>
        ) : data.entries.length === 0 ? (
          <div className="u-dim" style={{padding:"16px"}}>
            {debounced || selectedTags.length ? 'No entries match.' : 'No entries yet. Upload files from the Raw tab.'}
          </div>
        ) : data.entries.map(e => (
          <button
            key={e.entryId}
            type="button"
            className="kb-entry-row"
            onClick={() => setOpenEntry(e.entryId)}
          >
            <div className="kb-entry-title">{e.title || '(untitled)'}</div>
            {e.summary ? <div className="kb-entry-summary">{e.summary}</div> : null}
            <div className="kb-entry-meta">
              {Array.isArray(e.tags) && e.tags.length
                ? e.tags.slice(0, 6).map(t => <span key={t} className="kb-meta-chip">{t}</span>)
                : null}
              {e.digestedAt ? <span className="u-mono u-dim" style={{fontSize:10.5,marginLeft:"auto"}}>{new Date(e.digestedAt).toLocaleDateString()}</span> : null}
            </div>
          </button>
        ))}
      </div>

      {data && total > ENTRIES_PAGE_SIZE ? (
        <div className="kb-pager">
          <button className="btn ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - ENTRIES_PAGE_SIZE))}>← Prev</button>
          <span className="u-mono u-dim" style={{fontSize:11}}>{start}–{end} of {total}</span>
          <button className="btn ghost" disabled={end >= total} onClick={() => setOffset(offset + ENTRIES_PAGE_SIZE)}>Next →</button>
        </div>
      ) : null}

      {openEntry ? <KbEntryModal hash={hash} entryId={openEntry} onClose={() => setOpenEntry(null)}/> : null}
    </div>
  );
}

/* Preset select + (when `custom` is chosen) an inline from/to date-input
   pair. The parent owns preset + from + to strings so the Entries tab's
   `useEffect` can re-query the server whenever any of them change. */
function KbDateFilter({ label, preset, from, to, onPreset, onFrom, onTo }){
  return (
    <div className="kb-date-filter">
      <label className="kb-date-label">{label}:</label>
      <select
        className="kb-date-select"
        value={preset}
        onChange={(e) => onPreset(e.target.value)}
      >
        {KB_DATE_PRESETS.map(p => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      {preset === 'custom' ? (
        <>
          <input
            type="date"
            className="kb-date-input"
            value={from}
            onChange={(e) => onFrom(e.target.value)}
            aria-label={label + ' from date'}
          />
          <span className="kb-date-dash">–</span>
          <input
            type="date"
            className="kb-date-input"
            value={to}
            onChange={(e) => onTo(e.target.value)}
            aria-label={label + ' to date'}
          />
        </>
      ) : null}
    </div>
  );
}

function KbEntryModal({ hash, entryId, onClose }){
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [zoom, setZoom] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    AgentApi.kb.getEntry(hash, entryId)
      .then(r => { if (!cancelled) setData(r); })
      .catch(e => { if (!cancelled) setErr(e.message || String(e)); });
    return () => { cancelled = true; };
  }, [hash, entryId]);

  const body = data && data.body ? stripFrontmatter(data.body) : '';
  const rawId = data && data.entry ? data.entry.rawId : null;

  return (
    <div className="kb-modal-shell" role="dialog" aria-label="Entry detail">
      <div className="kb-modal-scrim" onClick={onClose}/>
      <div className="kb-modal">
        <div className="kb-modal-head">
          <span className="title">{data && data.entry ? (data.entry.title || '(untitled)') : 'Loading…'}</span>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <div className="kb-modal-body">
          {err ? <div className="u-err">{err}</div>
           : data === null ? <div className="u-dim">Loading…</div>
           : (
             <>
               {data.entry && Array.isArray(data.entry.tags) && data.entry.tags.length ? (
                 <div className="kb-entry-meta" style={{marginBottom:10}}>
                   {data.entry.tags.map(t => <span key={t} className="kb-meta-chip">{t}</span>)}
                 </div>
               ) : null}
               {Array.isArray(data.locations) && data.locations.length ? (
                 <div className="kb-locations">
                   {data.locations.map((loc, i) => (
                     <React.Fragment key={i}>
                       <span className="kb-loc-pill u-mono" title="Folder">{loc.folderPath || '/'}</span>
                       <span className="kb-loc-pill u-mono" title="Filename">{loc.filename}</span>
                     </React.Fragment>
                   ))}
                 </div>
               ) : null}
               <div
                 className="prose"
                 onClick={(e) => interceptImageClick(e, (src, alt) => setZoom({ src, alt }))}
                 dangerouslySetInnerHTML={{ __html: renderMd(rewriteEntryMediaPaths(body, hash, rawId)) }}
               />
             </>
           )}
        </div>
      </div>
      {zoom ? <KbImageLightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)}/> : null}
    </div>
  );
}

function stripFrontmatter(md){
  if (!md) return '';
  const m = md.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? md.slice(m[0].length) : md;
}

/* ---------- Synthesis tab ---------- */

/* Elapsed since the current dream phase started. Matches V1
   `chatKbFormatElapsed` (main.js:2516-2522). */
function formatDreamElapsed(ms){
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem < 10 ? '0' : ''}${rem}s`;
}

/* "N{m|h|d} ago" / "just now" / "never". Matches V1 `chatKbFormatRelative`
   (main.js:3340-3351). */
function formatDreamRelative(iso){
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const delta = Math.max(0, Date.now() - then);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/* Dream pipeline stepper. Markup and class names mirror the handoff
   `src/stepper.jsx` verbatim so that `public/v2/src/stepper.css` (also
   copied verbatim from the handoff) applies without any adaptation.
   Five phases (routing → verification → synthesis → discovery →
   reflection) render as upcoming / active / done. Active reserves a wider
   slot (6-col grid, active spans 2) and shows done/total. The component
   renders a shimmering "Starting…" rail when triggered before the first
   progress frame arrives. Spec: docs/spec-frontend.md#dream-pipeline-stepper. */
const DREAM_PHASES = ['routing', 'verification', 'synthesis', 'discovery', 'reflection'];
const DREAM_PHASE_LABELS = {
  routing: 'Routing',
  verification: 'Verification',
  synthesis: 'Synthesis',
  discovery: 'Discovery',
  reflection: 'Reflection',
};
const KB_SYNTHESIS_VIEW_KEY_PREFIX = 'ac:v2:kb-synthesis-view:';

function readKbSynthesisView(hash){
  try {
    const value = window.localStorage && window.localStorage.getItem(KB_SYNTHESIS_VIEW_KEY_PREFIX + hash);
    return value === 'atlas' ? 'atlas' : 'list';
  } catch (e) {
    return 'list';
  }
}

function writeKbSynthesisView(hash, value){
  try {
    if (window.localStorage) window.localStorage.setItem(KB_SYNTHESIS_VIEW_KEY_PREFIX + hash, value);
  } catch (e) {}
}

function kbTopicMatchesQuery(topic, query){
  if (!query) return true;
  const haystack = `${topic && topic.title || ''} ${topic && topic.summary || ''}`.toLowerCase();
  return haystack.includes(query);
}

function StepCheck(){
  return (
    <svg className="step-check" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6.5 L5 9 L9.5 3.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function DreamStepperGrid({ progress, starting }){
  if (starting || !progress || !progress.phase) {
    return (
      <div className="stepper-host">
        <div className="stepper starting" role="status" aria-live="polite">
          <div className="stepper-stages">
            <span className="starting-chip"><span className="spin" aria-hidden="true"/> Starting…</span>
            <span className="starting-rail"/>
          </div>
          <div className="stepper-timer"><span className="lbl">Elapsed</span><b>0:00</b></div>
        </div>
      </div>
    );
  }
  const currentIdx = DREAM_PHASES.indexOf(progress.phase);
  const stages = DREAM_PHASES.map((key, i) => {
    const label = DREAM_PHASE_LABELS[key];
    if (i < currentIdx) return { key, label, state: 'done' };
    if (i === currentIdx) return {
      key, label, state: 'active',
      count: progress.done || 0,
      total: progress.total || 0,
    };
    return { key, label, state: 'upcoming' };
  });
  const now = Date.now();
  const totalElapsed = progress.startedAt ? formatDreamElapsed(now - progress.startedAt) : '0s';
  const phaseElapsed = progress.phaseStartedAt ? formatDreamElapsed(now - progress.phaseStartedAt) : '0s';
  const phaseLabel = DREAM_PHASE_LABELS[progress.phase] || progress.phase;
  return (
    <div className="stepper-host">
      <div className="stepper" role="group" aria-label="Dream pipeline progress">
        <div className="stepper-stages">
          {stages.map((s, i) => (
            <div key={s.key} className="step" data-state={s.state}
                 aria-label={`Stage ${i+1} of 5, ${s.label}, ${s.state}`}>
              <span className="step-icon">
                {s.state === 'active' ? <span className="spin" aria-hidden="true"/>
                  : s.state === 'done' ? <StepCheck/>
                  : <span className="step-num">{i+1}</span>}
              </span>
              <span className="step-body">
                <span className="step-label">{s.label}</span>
                <span className="step-counter" aria-hidden={s.state !== 'active'}>
                  {s.state === 'active' && s.total ? `${s.count}/${s.total}` : ''}
                </span>
              </span>
            </div>
          ))}
        </div>
        <div className="stepper-timer">
          <span className="lbl">Total</span><b>{totalElapsed}</b>
          <span className="sep" aria-hidden="true">·</span>
          <span className="lbl">{phaseLabel}</span><b>{phaseElapsed}</b>
        </div>
        <span className="sr-only" aria-live="polite">
          {stages.filter(s => s.state === 'active').map(s => `${s.label} ${s.count} of ${s.total}`).join(', ')}
        </span>
      </div>
    </div>
  );
}

function KbSynthesisTab({ hash }){
  const dialog = useDialog();
  const toast = useToasts();
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [selectedId, setSelectedId] = React.useState(null);
  const [selectedClusterId, setSelectedClusterId] = React.useState(null);
  const [selectedBridgeId, setSelectedBridgeId] = React.useState(null);
  const [query, setQuery] = React.useState('');
  const [viewMode, setViewModeState] = React.useState(() => readKbSynthesisView(hash));
  const [triggeredAt, setTriggeredAt] = React.useState(null);
  const [starting, setStarting] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);

  React.useEffect(() => {
    setViewModeState(readKbSynthesisView(hash));
    setSelectedClusterId(null);
    setSelectedBridgeId(null);
  }, [hash]);

  function setViewMode(nextMode){
    const mode = nextMode === 'atlas' ? 'atlas' : 'list';
    setViewModeState(mode);
    writeKbSynthesisView(hash, mode);
  }

  const refetch = React.useCallback(() => {
    return AgentApi.kb.getSynthesis(hash)
      .then(r => { setData(r); setErr(null); })
      .catch(e => { setErr(e.message || String(e)); });
  }, [hash]);

  React.useEffect(() => { refetch(); }, [refetch]);

  /* Optimistic "running" grace window (≤15 s) after trigger, before the
     server reports status=running. Mirrors V1 `main.js:3829-3836`. */
  const inGrace = !!triggeredAt && (Date.now() - triggeredAt < 15000);
  const serverRunning = !!(data && data.status === 'running');
  const isRunning = serverRunning || inGrace;
  const isStopping = !!(data && data.stopping && serverRunning);

  React.useEffect(() => {
    if (serverRunning && triggeredAt) setTriggeredAt(null);
  }, [serverRunning, triggeredAt]);

  /* Poll while running (2 s) — belt-and-braces for WS-less operation, and
     the mechanism that keeps the stepper elapsed timer ticking. */
  React.useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(refetch, 2000);
    return () => clearInterval(id);
  }, [isRunning, refetch]);

  /* Pick up kb_state_update frames without waiting for the 2s poll. */
  React.useEffect(() => {
    const handler = (e) => {
      const d = e.detail;
      if (!d || d.hash !== hash) return;
      const ch = d.changed;
      if (ch && (ch.dreamProgress || ch.synthesis || ch.stopping)) refetch();
    };
    window.addEventListener('ac:kb-state-update', handler);
    return () => window.removeEventListener('ac:kb-state-update', handler);
  }, [hash, refetch]);

  async function startDream(){
    if (starting || isRunning) return;
    setStarting(true);
    try {
      await AgentApi.workspace.triggerDream(hash);
      setTriggeredAt(Date.now());
      refetch();
    } catch (e) {
      toast.error('Dream failed: ' + (e.message || String(e)));
    } finally {
      setStarting(false);
    }
  }

  async function redream(anchor){
    if (isRunning) return;
    const ok = await dialog.confirm({
      anchor,
      destructive: true,
      title: 'Re-Dream',
      body: 'Re-Dream will wipe all topics and connections and rebuild from scratch. Continue?',
      confirmLabel: 'Re-Dream',
    });
    if (!ok) return;
    try {
      await AgentApi.workspace.triggerRedream(hash);
      setTriggeredAt(Date.now());
      refetch();
    } catch (e) {
      toast.error('Re-Dream failed: ' + (e.message || String(e)));
    }
  }

  async function stopDream(){
    if (stopping || !isRunning) return;
    setStopping(true);
    try {
      await AgentApi.workspace.stopDream(hash);
      refetch();
    } catch (e) {
      toast.error('Stop failed: ' + (e.message || String(e)));
    } finally {
      setStopping(false);
    }
  }

  const topics = data && Array.isArray(data.topics) ? data.topics : [];
  const connections = data && Array.isArray(data.connections) ? data.connections : [];
  const topicsById = React.useMemo(() => {
    const m = {};
    for (const t of topics) m[t.topicId] = t;
    return m;
  }, [topics]);
  const atlas = React.useMemo(() => {
    if (!window.SynthesisAtlas || !topics.length) return null;
    return window.SynthesisAtlas.buildAtlas(topics, connections);
  }, [topics, connections]);
  const q = query.trim().toLowerCase();
  const filteredTopics = q
    ? topics.filter(t => kbTopicMatchesQuery(t, q))
    : topics;

  React.useEffect(() => {
    if (selectedId && !topicsById[selectedId]) setSelectedId(null);
  }, [selectedId, topicsById]);

  React.useEffect(() => {
    if (!selectedClusterId || !atlas) return;
    if (!atlas.clusters.some((cluster) => cluster.clusterId === selectedClusterId)) setSelectedClusterId(null);
  }, [atlas, selectedClusterId]);

  React.useEffect(() => {
    if (!selectedBridgeId || !atlas) return;
    if (!atlas.bridges.some((bridge) => bridge.bridgeId === selectedBridgeId)) setSelectedBridgeId(null);
  }, [atlas, selectedBridgeId]);

  if (err && !data) return <div className="kb-pane"><div className="u-err" style={{padding:"16px"}}>{err}</div></div>;
  if (data === null) return <div className="kb-pane"><div className="u-dim" style={{padding:"16px"}}>Loading synthesis…</div></div>;

  const lastRunLabel = formatDreamRelative(data.lastRunAt);
  const pending = data.needsSynthesisCount || 0;
  const lastErr = data.lastRunError || '';

  return (
    <div className="kb-pane">
      <div className="kb-synth-controls">
        <div className="kb-actions">
          <div className="btns">
            <button
              type="button"
              className={"btn-dream" + (isRunning ? " running" : "")}
              onClick={startDream}
              disabled={starting || isRunning}
              title="Run incremental dream on pending entries"
            >
              {starting || isRunning
                ? <>{Ico.bolt(12)} Dreaming…</>
                : <>{Ico.moon(12)} Dream</>}
            </button>
            {isRunning ? (
              <button
                type="button"
                className="btn-dream stop"
                onClick={stopDream}
                disabled={stopping || isStopping}
              >
                {Ico.stop(11)} {stopping || isStopping ? 'Stopping…' : 'Stop'}
              </button>
            ) : null}
            <button
              type="button"
              className="btn-dream ghost"
              onClick={(e) => redream(e.currentTarget)}
              disabled={isRunning}
              title="Wipe all topics & connections, then rebuild from scratch"
            >
              Re-Dream
            </button>
          </div>
          <div className="status">
            Last run: {lastRunLabel}
            {pending > 0 ? <> · <span>{pending} pending</span></> : null}
            {lastErr ? <> · <span className="u-err">{lastErr}</span></> : null}
          </div>
        </div>
        {isRunning ? (
          <DreamStepperGrid
            progress={data && data.dreamProgress}
            starting={!(data && data.dreamProgress && data.dreamProgress.phase)}
          />
        ) : null}
      </div>
      <div className={`kb-split ${viewMode === 'atlas' ? 'atlas-mode' : ''}`}>
        <div className="kb-split-left">
          {topics.length > 0 ? (
            <div className="kb-filters">
              <div className="kb-synth-filter-row">
                <input
                  type="text"
                  placeholder="Search topics…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="kb-search-input"
                />
                <div className="kb-synth-view-toggle" role="tablist" aria-label="Synthesis view">
                  <button
                    type="button"
                    className={viewMode === 'list' ? 'active' : ''}
                    onClick={() => setViewMode('list')}
                    role="tab"
                    aria-selected={viewMode === 'list'}
                  >List</button>
                  <button
                    type="button"
                    className={viewMode === 'atlas' ? 'active' : ''}
                    onClick={() => setViewMode('atlas')}
                    role="tab"
                    aria-selected={viewMode === 'atlas'}
                  >Atlas</button>
                </div>
              </div>
            </div>
          ) : null}
          {viewMode === 'atlas' && topics.length > 0 ? (
            <KbSynthesisAtlas
              atlas={atlas}
              query={q}
              selectedTopicId={selectedId}
              selectedClusterId={selectedClusterId}
              selectedBridgeId={selectedBridgeId}
              onSelectTopic={(topicId) => { setSelectedId(topicId); setSelectedClusterId(null); setSelectedBridgeId(null); }}
              onSelectCluster={(clusterId) => { setSelectedId(null); setSelectedClusterId(clusterId); setSelectedBridgeId(null); }}
              onSelectBridge={(bridgeId) => { setSelectedId(null); setSelectedClusterId(null); setSelectedBridgeId(bridgeId); }}
            />
          ) : (
            <div className="kb-list">
              {topics.length === 0 ? (
                <div className="u-dim" style={{padding:"16px"}}>No topics yet. Click Dream to synthesize pending entries into topics.</div>
              ) : filteredTopics.length === 0 ? (
                <div className="u-dim" style={{padding:"16px"}}>No matches for “{query.trim()}”.</div>
              ) : filteredTopics.map(t => (
                <button
                  key={t.topicId}
                  type="button"
                  className={`kb-entry-row ${selectedId === t.topicId ? 'active' : ''}`}
                  onClick={() => { setSelectedId(t.topicId); setSelectedClusterId(null); setSelectedBridgeId(null); }}
                >
                  <div className="kb-entry-title">
                    {t.isGodNode ? <span className="u-accent" style={{marginRight:6}}>★</span> : null}
                    {t.title}
                  </div>
                  {t.summary ? <div className="kb-entry-summary">{t.summary}</div> : null}
                  <div className="kb-entry-meta">
                    <span className="kb-meta-chip">{t.entryCount || 0} entries</span>
                    <span className="kb-meta-chip">{t.connectionCount || 0} links</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="kb-split-right">
          {selectedId ? (
            <KbTopicDetail
              hash={hash}
              topicId={selectedId}
              topicsById={topicsById}
              onSelectTopic={(topicId) => { setSelectedId(topicId); setSelectedClusterId(null); setSelectedBridgeId(null); }}
            />
          ) : selectedBridgeId && atlas ? (
            <KbBridgeDetail
              atlas={atlas}
              bridgeId={selectedBridgeId}
              onSelectTopic={(topicId) => { setSelectedId(topicId); setSelectedClusterId(null); setSelectedBridgeId(null); }}
              onSelectCluster={(clusterId) => { setSelectedId(null); setSelectedClusterId(clusterId); setSelectedBridgeId(null); }}
            />
          ) : selectedClusterId && atlas ? (
            <KbClusterDetail
              atlas={atlas}
              clusterId={selectedClusterId}
              onSelectTopic={(topicId) => { setSelectedId(topicId); setSelectedClusterId(null); setSelectedBridgeId(null); }}
              onSelectCluster={(clusterId) => { setSelectedClusterId(clusterId); setSelectedBridgeId(null); }}
            />
          ) : (
            <div className="u-dim" style={{padding:"16px"}}>Select a topic or atlas area to view its synthesis.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function KbSynthesisAtlas({ atlas, query, selectedTopicId, selectedClusterId, selectedBridgeId, onSelectTopic, onSelectCluster, onSelectBridge }){
  if (!atlas) return <div className="kb-atlas-empty">Atlas unavailable.</div>;
  const selectedNeighborIds = new Set();
  if (selectedTopicId && atlas.model && Array.isArray(atlas.model.edges)) {
    atlas.model.edges.forEach((edge) => {
      if (edge.sourceTopic === selectedTopicId) selectedNeighborIds.add(edge.targetTopic);
      if (edge.targetTopic === selectedTopicId) selectedNeighborIds.add(edge.sourceTopic);
    });
  }
  const selectedBridge = selectedBridgeId ? atlas.bridges.find((bridge) => bridge.bridgeId === selectedBridgeId) : null;
  const selectedBridgeClusterIds = new Set(selectedBridge ? [selectedBridge.sourceClusterId, selectedBridge.targetClusterId] : []);
  const selectedBridgeTopicIds = new Set(selectedBridge && selectedBridge.topicIds ? selectedBridge.topicIds : []);
  const totalTopics = atlas.clusters.reduce((sum, cluster) => sum + cluster.topicIds.length, 0);
  const totalEntries = atlas.clusters.reduce((sum, cluster) => sum + (cluster.entryCount || 0), 0);

  function clusterMatches(cluster){
    if (!query) return true;
    if (`${cluster.title} ${cluster.summary || ''}`.toLowerCase().includes(query)) return true;
    return cluster.topics.some((topic) => kbTopicMatchesQuery(topic, query));
  }

  function representativeTopics(cluster){
    if (!query) return cluster.representativeTopics || cluster.topics.slice(0, 6);
    const matches = cluster.topics.filter((topic) => kbTopicMatchesQuery(topic, query));
    const seen = new Set(matches.map((topic) => topic.topicId));
    const fallback = (cluster.representativeTopics || cluster.topics).filter((topic) => !seen.has(topic.topicId));
    return matches.concat(fallback).slice(0, 6);
  }

  return (
    <div className="kb-atlas kb-atlas-overview">
      <div className="kb-atlas-overview-meta">
        <span>{atlas.clusters.length} areas</span>
        <span>{totalTopics} topics</span>
        <span>{totalEntries} entries</span>
      </div>
      <div className="kb-atlas-card-list">
        {atlas.clusters.map((cluster) => {
          const matches = clusterMatches(cluster);
          const hasSelectedTopic = !!(selectedTopicId && cluster.topicIds.includes(selectedTopicId));
          const hasNeighbor = selectedTopicId && cluster.topicIds.some((topicId) => selectedNeighborIds.has(topicId));
          const hasSelectedBridge = selectedBridgeId && selectedBridgeClusterIds.has(cluster.clusterId);
          const selected = selectedClusterId === cluster.clusterId;
          const dimmed = (!!query && !matches) ||
            (!!selectedTopicId && !hasSelectedTopic && !hasNeighbor) ||
            (!!selectedBridgeId && !hasSelectedBridge);
          const shownTopics = representativeTopics(cluster);
          const remaining = Math.max(0, cluster.topicIds.length - shownTopics.length);
          return (
            <div
              key={cluster.clusterId}
              role="button"
              tabIndex={0}
              className={`kb-atlas-card tone-${cluster.tone} ${selected ? 'selected' : ''} ${dimmed ? 'dim' : ''} ${cluster.type === 'bridge' ? 'bridge' : ''}`}
              onClick={() => onSelectCluster(cluster.clusterId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectCluster(cluster.clusterId);
                }
              }}
            >
              <span className="kb-atlas-card-accent" aria-hidden="true"/>
              <span className="kb-atlas-card-head">
                <span className="kb-atlas-card-title">{cluster.title}</span>
                <span className="kb-atlas-card-meta">
                  {cluster.topicIds.length} topics · {cluster.entryCount || 0} entries · {cluster.bridges.length} bridges
                </span>
              </span>
              {cluster.summary ? <span className="kb-atlas-card-summary">{cluster.summary}</span> : null}
              <span className="kb-atlas-topic-chips">
                {shownTopics.map((topic) => {
                  const active = selectedTopicId === topic.topicId || selectedBridgeTopicIds.has(topic.topicId);
                  const neighbor = selectedNeighborIds.has(topic.topicId);
                  return (
                    <span
                      key={topic.topicId}
                      role="button"
                      tabIndex={0}
                      className={`kb-atlas-topic-chip ${active ? 'active' : ''} ${neighbor ? 'neighbor' : ''} ${topic.isGodNode ? 'god' : ''}`}
                      title={`${topic.title || topic.topicId} · ${topic.entryCount || 0} entries`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectTopic(topic.topicId);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          onSelectTopic(topic.topicId);
                        }
                      }}
                    >{topic.title || topic.topicId}</span>
                  );
                })}
                {remaining > 0 ? <span className="kb-atlas-more">+{remaining} more</span> : null}
              </span>
              {cluster.bridges.length ? (
                <span className="kb-atlas-bridge-list">
                  {cluster.bridges.slice(0, 3).map((bridge) => {
                    const active = selectedBridgeId === bridge.bridgeId;
                    return (
                      <span
                        key={bridge.bridgeId}
                        role="button"
                        tabIndex={0}
                        className={`kb-atlas-bridge-chip ${active ? 'active' : ''}`}
                        title={`${bridge.relationship || 'related'} · ${bridge.count} link${bridge.count === 1 ? '' : 's'}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (onSelectBridge) onSelectBridge(bridge.bridgeId);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            if (onSelectBridge) onSelectBridge(bridge.bridgeId);
                          }
                        }}
                      >
                        <span className="u-dim">{bridge.relationship || 'related'}</span>
                        <span>{bridge.otherTitle}</span>
                      </span>
                    );
                  })}
                  {cluster.bridges.length > 3 ? <span className="kb-atlas-more">+{cluster.bridges.length - 3} bridges</span> : null}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KbBridgeDetail({ atlas, bridgeId, onSelectTopic, onSelectCluster }){
  const bridge = atlas && atlas.bridges.find((candidate) => candidate.bridgeId === bridgeId);
  if (!bridge) return <div className="u-dim" style={{padding:"16px"}}>Select an atlas bridge.</div>;
  const clusterById = {};
  atlas.clusters.forEach((cluster) => { clusterById[cluster.clusterId] = cluster; });
  const topicById = {};
  atlas.clusters.forEach((cluster) => cluster.topics.forEach((topic) => { topicById[topic.topicId] = topic; }));
  const source = clusterById[bridge.sourceClusterId];
  const target = clusterById[bridge.targetClusterId];
  const bridgeTopics = bridge.topicIds.map((topicId) => topicById[topicId]).filter(Boolean);

  return (
    <div className="kb-detail kb-bridge-detail">
      <h3 className="kb-detail-title">{bridge.relationship || 'Bridge'}</h3>
      <p className="kb-detail-summary">
        {source ? source.title : bridge.sourceClusterId} ↔ {target ? target.title : bridge.targetClusterId}
      </p>
      <div className="kb-entry-meta" style={{marginBottom:12}}>
        <span className="kb-meta-chip">{bridge.count} link{bridge.count === 1 ? '' : 's'}</span>
        <span className="kb-meta-chip">weight {bridge.weight}</span>
      </div>
      <div className="kb-detail-section">
        <h6>Areas</h6>
        <div className="kb-link-list">
          {[source, target].filter(Boolean).map((cluster) => (
            <button
              key={cluster.clusterId}
              type="button"
              className="kb-link"
              onClick={() => onSelectCluster(cluster.clusterId)}
            >· {cluster.title}</button>
          ))}
        </div>
      </div>
      {bridgeTopics.length ? (
        <div className="kb-detail-section">
          <h6>Connected Topics</h6>
          <div className="kb-link-list">
            {bridgeTopics.map((topic) => (
              <button
                key={topic.topicId}
                type="button"
                className="kb-link"
                onClick={() => onSelectTopic(topic.topicId)}
              >· {topic.title || topic.topicId}</button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
function KbClusterDetail({ atlas, clusterId, onSelectTopic, onSelectCluster }){
  const cluster = atlas && atlas.clusters.find((candidate) => candidate.clusterId === clusterId);
  if (!cluster) return <div className="u-dim" style={{padding:"16px"}}>Select an atlas area.</div>;
  const clusterById = {};
  atlas.clusters.forEach((item) => { clusterById[item.clusterId] = item; });
  const related = atlas.bridges.filter((bridge) => bridge.sourceClusterId === clusterId || bridge.targetClusterId === clusterId);

  return (
    <div className="kb-detail kb-cluster-detail">
      <h3 className="kb-detail-title">{cluster.title}</h3>
      {cluster.summary ? <p className="kb-detail-summary">{cluster.summary}</p> : null}
      <div className="kb-entry-meta" style={{marginBottom:12}}>
        <span className="kb-meta-chip">{cluster.topicIds.length} topics</span>
        <span className="kb-meta-chip">{cluster.entryCount || 0} entries</span>
        <span className="kb-meta-chip">{related.length} bridges</span>
      </div>
      <div className="kb-detail-section">
        <h6>Key Topics</h6>
        <div className="kb-link-list">
          {cluster.topics.map((topic) => (
            <button
              key={topic.topicId}
              type="button"
              className="kb-link"
              onClick={() => onSelectTopic(topic.topicId)}
            >
              · {topic.title || topic.topicId}
              <span className="u-dim"> · {topic.entryCount || 0} entries</span>
            </button>
          ))}
        </div>
      </div>
      {related.length ? (
        <div className="kb-detail-section">
          <h6>Bridges</h6>
          <div className="kb-link-list">
            {related.map((bridge) => {
              const otherId = bridge.sourceClusterId === clusterId ? bridge.targetClusterId : bridge.sourceClusterId;
              const other = clusterById[otherId];
              return (
                <button
                  key={bridge.bridgeId}
                  type="button"
                  className="kb-link"
                  onClick={() => other && onSelectCluster(other.clusterId)}
                >
                  <span className="u-dim">{bridge.relationship || 'related'} → </span>{other ? other.title : otherId}
                  <span className="u-dim"> · {bridge.count} link{bridge.count === 1 ? '' : 's'}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function KbTopicDetail({ hash, topicId, topicsById, onSelectTopic }){
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [openEntry, setOpenEntry] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    setData(null); setErr(null);
    AgentApi.kb.getTopic(hash, topicId)
      .then(r => { if (!cancelled) setData(r); })
      .catch(e => { if (!cancelled) setErr(e.message || String(e)); });
    return () => { cancelled = true; };
  }, [hash, topicId]);

  if (err) return <div className="u-err" style={{padding:"16px"}}>{err}</div>;
  if (data === null) return <div className="u-dim" style={{padding:"16px"}}>Loading topic…</div>;

  return (
    <div className="kb-detail">
      <h3 className="kb-detail-title">{data.title}</h3>
      {data.summary ? <p className="kb-detail-summary">{data.summary}</p> : null}
      <div className="kb-detail-section">
        <h6>Entries ({data.entryCount || 0})</h6>
        <div className="kb-link-list">
          {(data.entries || []).map(e => (
            <button
              key={e.entryId}
              type="button"
              className="kb-link"
              onClick={() => setOpenEntry(e.entryId)}
            >· {e.title || e.entryId}</button>
          ))}
        </div>
      </div>
      {Array.isArray(data.connections) && data.connections.length ? (
        <div className="kb-detail-section">
          <h6>Connections ({data.connections.length})</h6>
          <div className="kb-link-list">
            {data.connections.map((c, i) => {
              const targetTitle = (topicsById && topicsById[c.targetTopic] && topicsById[c.targetTopic].title) || c.targetTopic;
              const known = topicsById && !!topicsById[c.targetTopic];
              return (
                <button
                  key={i}
                  type="button"
                  className="kb-link"
                  disabled={!known}
                  onClick={() => known && onSelectTopic && onSelectTopic(c.targetTopic)}
                  title={c.confidence ? `${c.confidence} · confidence` : ''}
                >
                  <span className="u-dim">{c.relationship || 'related'} → </span>{targetTitle}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {data.content ? (
        <div className="kb-detail-section">
          <h6>Synthesis</h6>
          <div className="prose" dangerouslySetInnerHTML={{ __html: renderMd(data.content) }}/>
        </div>
      ) : null}
      {openEntry ? <KbEntryModal hash={hash} entryId={openEntry} onClose={() => setOpenEntry(null)}/> : null}
    </div>
  );
}

/* ---------- Reflections tab ---------- */
function KbReflectionsTab({ hash }){
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [openId, setOpenId] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    AgentApi.kb.getReflections(hash)
      .then(r => { if (!cancelled) setData(r.reflections || []); })
      .catch(e => { if (!cancelled) setErr(e.message || String(e)); });
    return () => { cancelled = true; };
  }, [hash]);

  if (err) return <div className="kb-pane"><div className="u-err" style={{padding:"16px"}}>{err}</div></div>;
  if (data === null) return <div className="kb-pane"><div className="u-dim" style={{padding:"16px"}}>Loading reflections…</div></div>;

  return (
    <div className="kb-pane">
      <div className="kb-list">
        {data.length === 0 ? (
          <div className="u-dim" style={{padding:"16px"}}>No reflections yet. Reflections are generated during the dream cycle.</div>
        ) : data.map(r => (
          <button
            key={r.reflectionId}
            type="button"
            className="kb-entry-row"
            onClick={() => setOpenId(r.reflectionId)}
          >
            <div className="kb-entry-title">
              {r.title}
              {r.isStale ? <span className="kb-meta-chip" style={{marginLeft:8,color:"var(--status-awaiting)",borderColor:"var(--status-awaiting)"}}>stale</span> : null}
            </div>
            {r.summary ? <div className="kb-entry-summary">{r.summary}</div> : null}
            <div className="kb-entry-meta">
              {r.type ? <span className="kb-meta-chip">{r.type}</span> : null}
              <span className="kb-meta-chip">{r.citationCount || 0} citations</span>
              {r.createdAt ? <span className="u-mono u-dim" style={{fontSize:10.5,marginLeft:"auto"}}>{new Date(r.createdAt).toLocaleDateString()}</span> : null}
            </div>
          </button>
        ))}
      </div>
      {openId ? <KbReflectionModal hash={hash} reflectionId={openId} onClose={() => setOpenId(null)}/> : null}
    </div>
  );
}

function KbReflectionModal({ hash, reflectionId, onClose }){
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [openEntry, setOpenEntry] = React.useState(null);
  const [zoom, setZoom] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    AgentApi.kb.getReflection(hash, reflectionId)
      .then(r => { if (!cancelled) setData(r); })
      .catch(e => { if (!cancelled) setErr(e.message || String(e)); });
    return () => { cancelled = true; };
  }, [hash, reflectionId]);

  return (
    <div className="kb-modal-shell" role="dialog" aria-label="Reflection detail">
      <div className="kb-modal-scrim" onClick={onClose}/>
      <div className="kb-modal">
        <div className="kb-modal-head">
          <span className="title">{data ? data.title : 'Loading…'}</span>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <div className="kb-modal-body">
          {err ? <div className="u-err">{err}</div>
           : data === null ? <div className="u-dim">Loading…</div>
           : (
             <>
               <div className="kb-entry-meta" style={{marginBottom:10}}>
                 {data.type ? <span className="kb-meta-chip">{data.type}</span> : null}
                 <span className="kb-meta-chip">{data.citationCount || 0} citations</span>
               </div>
               <div
                 className="prose"
                 onClick={(e) => {
                   interceptEntryLink(e, setOpenEntry);
                   interceptImageClick(e, (src, alt) => setZoom({ src, alt }));
                 }}
                 dangerouslySetInnerHTML={{ __html: renderMd(preprocessReflectionMd(data.content || '')) }}
               />
               {Array.isArray(data.citedEntries) && data.citedEntries.length ? (
                 <div className="kb-detail-section" style={{marginTop:14}}>
                   <h6>Cited entries</h6>
                   <div className="kb-link-list">
                     {data.citedEntries.map(e => (
                       <button
                         key={e.entryId}
                         type="button"
                         className="kb-link"
                         onClick={() => setOpenEntry(e.entryId)}
                       >· {e.title || e.entryId}</button>
                     ))}
                   </div>
                 </div>
               ) : null}
             </>
           )}
        </div>
      </div>
      {openEntry ? <KbEntryModal hash={hash} entryId={openEntry} onClose={() => setOpenEntry(null)}/> : null}
      {zoom ? <KbImageLightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)}/> : null}
    </div>
  );
}

/* ---------- Raw tab — folder tree + folder list + multi-file/folder upload + DnD --
   Layout: left rail = folder tree, right column = breadcrumb + upload queue + raw list.
   `currentFolder` (state in this component) controls which folder the right column
   shows; the same value is prepended to upload paths so all three upload pathways
   (multi-file picker, folder picker, DnD) land their files under the active folder.
   Folder CRUD (create / rename / delete with cascade) lives in the tree's hover
   actions and a breadcrumb-level "+ New folder" button. The upload queue runs
   concurrency=3 with per-item progress bars sourced from XHR `upload.onprogress`. */

function formatBytes(bytes){
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelative(iso){
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/* "N / M items — ~X min remaining" — ETA omitted until done >= 2 (server gates etaMs). */
function formatDigestProgress(dp){
  if (!dp) return '';
  const base = `${dp.done} / ${dp.total} items`;
  if (!Number.isFinite(dp.etaMs) || dp.etaMs <= 0) return base;
  const secs = Math.round(dp.etaMs / 1000);
  let eta;
  if (secs < 60) eta = `${secs}s`;
  else if (secs < 3600) eta = `${Math.round(secs / 60)} min`;
  else {
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    eta = m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  return `${base} — ~${eta} remaining`;
}

function rawIsProcessing(state){
  if (!state) return false;
  if (state.digestProgress) return true;
  const byStatus = (state.counters && state.counters.rawByStatus) || {};
  return (byStatus.ingesting || 0) > 0 || (byStatus.digesting || 0) > 0;
}

/* Namespaced — top-level `const` in classic scripts shares one realm-wide
   lexical scope, so duplicating filesBrowser.jsx's `UPLOAD_CONCURRENCY` would
   throw a redeclaration `SyntaxError` and fail to load this whole file. */
const KB_UPLOAD_CONCURRENCY = 3;
const KB_UPLOAD_DISMISS_MS = 1500;
/* OS-generated junk — never upload. Match is case-insensitive; AppleDouble
   resource forks (`._*`) are caught by prefix. */
const KB_UPLOAD_SKIP_FILES = new Set([
  'thumbs.db', 'desktop.ini', '.ds_store', '._ds_store',
  '.thumbs', 'ehthumbs.db', 'ehthumbs_vista.db',
  '.spotlight-v100', '.trashes', '.fseventsd',
  '.icon\r',
]);
function kbShouldSkipUpload(name){
  const lc = (name || '').toLowerCase();
  return KB_UPLOAD_SKIP_FILES.has(lc) || lc.startsWith('._');
}
let kbQueueIdSeq = 1;
function nextQueueId(){ return `q${kbQueueIdSeq++}`; }

/* Tree-rail resize: per-workspace persistent width, mirrors filesBrowser. */
const KB_TREE_WIDTH_STORAGE_PREFIX = 'ac:v2:kb-tree-width:';
const KB_TREE_WIDTH_DEFAULT = 220;
const KB_TREE_WIDTH_MIN = 140;
const KB_TREE_WIDTH_MAX = 600;

function loadKbTreeWidth(hash){
  try {
    const raw = window.localStorage.getItem(KB_TREE_WIDTH_STORAGE_PREFIX + hash);
    if (!raw) return KB_TREE_WIDTH_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return KB_TREE_WIDTH_DEFAULT;
    return Math.max(KB_TREE_WIDTH_MIN, Math.min(KB_TREE_WIDTH_MAX, Math.round(n)));
  } catch { return KB_TREE_WIDTH_DEFAULT; }
}
function saveKbTreeWidth(hash, width){
  try {
    window.localStorage.setItem(KB_TREE_WIDTH_STORAGE_PREFIX + hash, String(Math.round(width)));
  } catch {}
}

/* Status-filter buckets for the right-column file list. Pending digestion
   covers everything that hasn't reached the final 'digested' state — both
   queued (ingested) and in-flight (ingesting/digesting). Digested is the
   fully-processed end state. */
const KB_STATUS_FILTERS = [
  { id: 'all',       label: 'All' },
  { id: 'digested',  label: 'Digested' },
  { id: 'pending',   label: 'Pending digestion' },
];
function rawMatchesStatusFilter(raw, filterId){
  if (filterId === 'all') return true;
  if (filterId === 'digested') return raw.status === 'digested';
  if (filterId === 'pending')  return raw.status === 'ingested' || raw.status === 'ingesting' || raw.status === 'digesting';
  return true;
}

/* Strip the trailing filename from a `webkitRelativePath` to get the folder. */
function folderFromRelativePath(rp){
  if (!rp) return '';
  const i = rp.lastIndexOf('/');
  return i < 0 ? '' : rp.slice(0, i);
}

/* Walk a `FileSystemDirectoryEntry` recursively, accumulating
   `{ file, folderPath }` pairs. `parentPath` is the prefix above this entry —
   for the entry itself, its name is appended when we descend into it. Chrome
   batches `readEntries` results in chunks of 100, so we loop until empty. */
async function walkFsEntry(entry, parentPath, out){
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, folderPath: parentPath });
    return;
  }
  if (!entry.isDirectory) return;
  const childPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch || batch.length === 0) break;
    for (const sub of batch) await walkFsEntry(sub, childPath, out);
  }
}

/* Resolve `DataTransfer` → `[{ file, folderPath }]`. Prefers
   `webkitGetAsEntry` so dropped folders nest correctly; falls back to
   `dataTransfer.files` for browsers that don't expose entries. */
async function dropToUploadItems(dataTransfer){
  const items = Array.from(dataTransfer.items || []);
  const out = [];
  let usedEntries = false;
  for (const item of items) {
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry) {
      usedEntries = true;
      await walkFsEntry(entry, '', out);
    }
  }
  if (!usedEntries) {
    for (const file of Array.from(dataTransfer.files || [])) {
      out.push({ file, folderPath: '' });
    }
  }
  return out;
}

/* Prepend `base` to a relative folder path so uploads land under currentFolder. */
function joinFolder(base, child){
  if (!base) return child || '';
  if (!child) return base;
  return `${base}/${child}`;
}

/* Convert flat `[{folderPath:'a/b'}, ...]` → nested `[{name, path, children}, ...]`,
   sorted alphabetically at every depth. The backend always returns folders sorted
   by full path, but we don't rely on that here — we sort each child list. */
function buildFolderTree(folders){
  const root = { name: '', path: '', children: new Map() };
  for (const f of folders || []) {
    const segs = (f.folderPath || '').split('/').filter(Boolean);
    let node = root;
    let acc = '';
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      let child = node.children.get(seg);
      if (!child) {
        child = { name: seg, path: acc, children: new Map() };
        node.children.set(seg, child);
      }
      node = child;
    }
  }
  const toArr = (n) => Array
    .from(n.children.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => ({ name: c.name, path: c.path, children: toArr(c) }));
  return toArr(root);
}

function KbRawBreadcrumb({ currentFolder, onNavigate, statusFilter, onStatusFilter }){
  const segs = currentFolder ? currentFolder.split('/') : [];
  const crumbs = [{ label: 'All files', path: '' }];
  let acc = '';
  for (const s of segs) {
    acc = acc ? `${acc}/${s}` : s;
    crumbs.push({ label: s, path: acc });
  }
  return (
    <div className="kb-raw-crumb">
      <div className="kb-raw-crumb-path">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <React.Fragment key={c.path || '/'}>
              {i > 0 ? <span className="u-dim" style={{margin:'0 4px'}}>/</span> : null}
              {isLast ? (
                <span className="kb-raw-crumb-here">{c.label}</span>
              ) : (
                <button type="button" className="kb-raw-crumb-link" onClick={() => onNavigate(c.path)}>
                  {c.label}
                </button>
              )}
            </React.Fragment>
          );
        })}
      </div>
      <div className="kb-raw-status-filter">
        {KB_STATUS_FILTERS.map(f => (
          <button
            key={f.id}
            type="button"
            className={`kb-raw-filter-pill ${statusFilter === f.id ? 'on' : ''}`}
            onClick={() => onStatusFilter(f.id)}
          >{f.label}</button>
        ))}
      </div>
    </div>
  );
}

function KbRawTreeNode({ node, depth, currentFolder, onSelect, onRename, onDelete }){
  const [open, setOpen] = React.useState(true);
  const isActive = currentFolder === node.path;
  const isAncestor = currentFolder && (currentFolder + '/').startsWith(node.path + '/');
  const hasChildren = node.children.length > 0;
  const rowRef = React.useRef(null);
  React.useEffect(() => {
    // Auto-open ancestors of the current selection so the active row is visible.
    if (isAncestor && !isActive) setOpen(true);
  }, [isAncestor, isActive]);
  React.useEffect(() => {
    // Scroll the active row into view when it becomes active. Covers both
    // user navigation and the create-folder auto-navigate flow (the new node
    // mounts with isActive=true once the refetch lands).
    if (isActive && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isActive]);
  function toggle(e){ e.stopPropagation(); setOpen(o => !o); }
  return (
    <div className="kb-tree-branch">
      <div
        ref={rowRef}
        className={`kb-tree-row ${isActive ? 'active' : ''}`}
        style={{paddingLeft: 8 + depth * 12}}
        onClick={() => onSelect(node.path)}
      >
        {hasChildren ? (
          <button type="button" className="kb-tree-toggle" onClick={toggle} title={open ? 'Collapse' : 'Expand'}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="kb-tree-toggle-spacer"/>
        )}
        <span className="kb-tree-name" title={node.path}>{node.name}</span>
        <span className="kb-tree-actions">
          <button
            type="button"
            className="kb-tree-icon"
            title="Rename folder"
            onClick={(e) => { e.stopPropagation(); onRename(node.path, e.currentTarget); }}
          >✎</button>
          <button
            type="button"
            className="kb-tree-icon"
            title="Delete folder"
            onClick={(e) => { e.stopPropagation(); onDelete(node.path, e.currentTarget); }}
          >×</button>
        </span>
      </div>
      {hasChildren && open ? (
        <div className="kb-tree-children">
          {node.children.map(c => (
            <KbRawTreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              currentFolder={currentFolder}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function KbRawFolderTree({ folders, currentFolder, onSelect, onRename, onDelete }){
  const tree = React.useMemo(() => buildFolderTree(folders), [folders]);
  return (
    <div className="kb-tree">
      <div
        className={`kb-tree-row kb-tree-root ${currentFolder === '' ? 'active' : ''}`}
        onClick={() => onSelect('')}
      >
        <span className="kb-tree-toggle-spacer"/>
        <span className="kb-tree-name">All files</span>
      </div>
      {tree.map(n => (
        <KbRawTreeNode
          key={n.path}
          node={n}
          depth={0}
          currentFolder={currentFolder}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function KbRawTab({ hash, kbState, onStateUpdate }){
  const dialog = useDialog();
  const toast = useToasts();
  const [pandoc, setPandoc] = React.useState(null);
  const [autoDigestSaving, setAutoDigestSaving] = React.useState(false);
  const [queue, setQueue] = React.useState([]);
  const [paused, setPaused] = React.useState(false);
  const xhrsRef = React.useRef(new Map());
  const [dragHover, setDragHover] = React.useState(false);
  const [currentFolder, setCurrentFolder] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [digestComplete, setDigestComplete] = React.useState(null);
  const [treeWidth, setTreeWidth] = React.useState(() => loadKbTreeWidth(hash));
  const [resizing, setResizing] = React.useState(false);
  const filesInputRef = React.useRef(null);
  const folderInputRef = React.useRef(null);
  const dragCounterRef = React.useRef(0);
  const treeWidthRef = React.useRef(treeWidth);
  treeWidthRef.current = treeWidth;

  React.useEffect(() => { setTreeWidth(loadKbTreeWidth(hash)); }, [hash]);

  const onResizerMouseDown = React.useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeWidthRef.current;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      const next = Math.max(KB_TREE_WIDTH_MIN, Math.min(KB_TREE_WIDTH_MAX, startW + (ev.clientX - startX)));
      setTreeWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
      saveKbTreeWidth(hash, treeWidthRef.current);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [hash]);

  const onResizerDoubleClick = React.useCallback(() => {
    setTreeWidth(KB_TREE_WIDTH_DEFAULT);
    saveKbTreeWidth(hash, KB_TREE_WIDTH_DEFAULT);
  }, [hash]);

  /* getState returns counters/folders workspace-wide and `raw` filtered to
     the requested folder, so refetching with `{folder: currentFolder}` keeps
     the right column scoped without losing the tree or top-line counters. */
  const refetch = React.useCallback(async () => {
    try {
      const s = await AgentApi.kb.getState(hash, { folder: currentFolder });
      onStateUpdate(s);
    } catch (e) {
      // Polling errors are silent — they'll resurface on the next user action.
      console.error('[kb] raw refetch failed:', e);
    }
  }, [hash, currentFolder, onStateUpdate]);

  /* Fetch a folder's raw list whenever the user navigates the tree.
     Skips the initial mount when currentFolder === '' because KbBrowser's
     mount-time fetch already loaded the root snapshot. */
  const didMountRef = React.useRef(false);
  React.useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    refetch();
  }, [currentFolder, refetch]);

  /* Pandoc availability — fetched once. Drives the install banner above the
     raw list so users see DOCX is blocked before they try to upload one. */
  React.useEffect(() => {
    let cancelled = false;
    AgentApi.kb.pandocStatus()
      .then(r => { if (!cancelled) setPandoc(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  /* Smart polling — only while something is in-flight. Stops on idle so an
     idle KB tab doesn't burn ~30 reqs/min. Mirrors V1's reactive refetch. */
  React.useEffect(() => {
    if (!rawIsProcessing(kbState)) return;
    const id = setInterval(() => { refetch(); }, 1500);
    return () => clearInterval(id);
  }, [kbState, refetch]);

  /* Upload queue drain — runs after each render. Picks at most one queued
     item per fire as long as in-flight count is below UPLOAD_CONCURRENCY,
     then re-renders (because we set status='uploading') and fires again. So
     enqueueing N items kicks off up to UPLOAD_CONCURRENCY in parallel.
     Bails when `paused` so the Pause button freezes new starts (in-flight
     items keep going until they resolve naturally — Cancel aborts those). */
  React.useEffect(() => {
    if (paused) return;
    const inFlight = queue.filter(q => q.status === 'uploading').length;
    if (inFlight >= KB_UPLOAD_CONCURRENCY) return;
    const next = queue.find(q => q.status === 'queued');
    if (!next) return;
    setQueue(prev => prev.map(it => it.id === next.id ? { ...it, status: 'uploading', progress: 0 } : it));
    AgentApi.kb.uploadRaw(hash, next.file, next.folderPath, (loaded, total) => {
      const p = total > 0 ? loaded / total : 0;
      setQueue(prev => prev.map(it => it.id === next.id ? { ...it, progress: p } : it));
    }, (xhr) => { xhrsRef.current.set(next.id, xhr); })
      .then(res => {
        xhrsRef.current.delete(next.id);
        const deduped = !!(res && res.deduped);
        setQueue(prev => prev.map(it => {
          if (it.id !== next.id) return it;
          if (it.status !== 'uploading') return it;
          return { ...it, status: deduped ? 'deduped' : 'done', progress: 1 };
        }));
        setTimeout(() => {
          setQueue(prev => prev.filter(it => it.id !== next.id));
        }, KB_UPLOAD_DISMISS_MS);
        refetch();
      })
      .catch(err => {
        xhrsRef.current.delete(next.id);
        /* Retry policy mirrors V1 main.js:3522-3533: retry transient errors
           up to 2 times with 1 s then 3 s backoff. Don't retry user aborts
           (Cancel), session-expired (401), or 4xx (likely user error —
           file too big, bad type, etc.). */
        const status = err && typeof err.status === 'number' ? err.status : null;
        const aborted = !!(err && err.aborted);
        const is4xx = status !== null && status >= 400 && status < 500;
        const isRetryable = !aborted && !is4xx && status !== 401;
        const attempts = next.retries || 0;
        if (isRetryable && attempts < 2) {
          const nextAttempt = attempts + 1;
          const delay = nextAttempt === 1 ? 1000 : 3000;
          setQueue(prev => prev.map(it => {
            if (it.id !== next.id) return it;
            if (it.status !== 'uploading') return it;
            return { ...it, status: 'retrying', retries: nextAttempt, progress: 0, message: `Retrying (${nextAttempt}/2)…` };
          }));
          setTimeout(() => {
            setQueue(prev => prev.map(it => {
              if (it.id !== next.id) return it;
              if (it.status !== 'retrying') return it;
              return { ...it, status: 'queued', message: null };
            }));
          }, delay);
          return;
        }
        setQueue(prev => prev.map(it => {
          if (it.id !== next.id) return it;
          if (it.status !== 'uploading') return it;
          return { ...it, status: 'error', message: err.message || String(err) };
        }));
      });
  }, [queue, hash, refetch, paused]);

  const enqueue = React.useCallback((items) => {
    if (!items.length) return;
    const accepted = [];
    let skipped = 0;
    for (const it of items) {
      if (kbShouldSkipUpload(it.file && it.file.name)) { skipped++; continue; }
      accepted.push(it);
    }
    if (skipped > 0) {
      toast.info(`Skipped ${skipped} system file${skipped === 1 ? '' : 's'} (Thumbs.db, .DS_Store, etc.)`);
    }
    if (!accepted.length) return;
    setQueue(prev => prev.concat(accepted.map(it => ({
      id: nextQueueId(),
      file: it.file,
      folderPath: it.folderPath || '',
      filename: it.file.name,
      sizeBytes: it.file.size,
      status: 'queued',
      progress: 0,
      message: null,
    }))));
  }, [toast]);

  /* beforeunload guard — warn before tab close / nav while the upload
     queue has active items. Listener only attached while the queue actually
     has `queued` / `uploading` rows; cleanup auto-detaches as the drain
     finishes. */
  React.useEffect(() => {
    const active = queue.some(q => q.status === 'queued' || q.status === 'uploading' || q.status === 'retrying');
    if (!active) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [queue]);

  /* Digestion-complete banner (#20) — driven by the `changed.digestion`
     block on `kb_state_update` WS frames. streamStore fans these out via
     `ac:kb-state-update` CustomEvents:
       - active:true → clear any stale banner (new session started).
       - active:false & entriesCreated>0 → snapshot into `digestComplete`.
       - active:false & entriesCreated===0 → no-op (empty digest). */
  React.useEffect(() => {
    const handler = (e) => {
      const d = e.detail;
      if (!d || d.hash !== hash) return;
      const dig = d.changed && d.changed.digestion;
      if (!dig) return;
      if (dig.active) {
        setDigestComplete(null);
      } else if (dig.entriesCreated > 0) {
        setDigestComplete({ entriesCreated: dig.entriesCreated });
      }
    };
    window.addEventListener('ac:kb-state-update', handler);
    return () => window.removeEventListener('ac:kb-state-update', handler);
  }, [hash]);

  /* Clear the banner when switching workspaces — the completion belongs
     to the workspace it fired on. */
  React.useEffect(() => { setDigestComplete(null); }, [hash]);

  function dismissQueueItem(id){
    setQueue(prev => prev.filter(it => it.id !== id));
  }

  function clearFinishedQueue(){
    setQueue(prev => prev.filter(it => it.status === 'queued' || it.status === 'uploading'));
  }

  /* Queue controls:
     - Pause freezes new starts; in-flight items finish on their own.
     - Cancel aborts in-flight XHRs and marks remaining items 'cancelled'.
     - Retry failed flips 'error' items back to 'queued' for re-drain. */
  function pauseQueue(){ setPaused(true); }
  function resumeQueue(){ setPaused(false); }

  async function cancelQueue(anchor){
    const ok = await dialog.confirm({
      anchor,
      destructive: true,
      title: 'Cancel remaining uploads?',
      body: 'In-flight uploads will be aborted. Files already uploaded stay in the KB.',
      confirmLabel: 'Cancel uploads',
      cancelLabel: 'Keep uploading',
    });
    if (!ok) return;
    for (const xhr of xhrsRef.current.values()) {
      try { xhr.abort(); } catch {}
    }
    xhrsRef.current.clear();
    setQueue(prev => prev.map(it => (
      it.status === 'queued' || it.status === 'uploading' || it.status === 'retrying'
        ? { ...it, status: 'cancelled', message: null }
        : it
    )));
    setPaused(false);
  }

  function retryFailed(){
    setQueue(prev => prev.map(it => (
      it.status === 'error'
        ? { ...it, status: 'queued', progress: 0, message: null, retries: 0 }
        : it
    )));
  }

  if (!kbState) {
    return <div className="kb-pane"><div className="u-dim" style={{padding:"16px"}}>Loading…</div></div>;
  }

  const allRaws = Array.isArray(kbState.raw) ? kbState.raw : [];
  const raws = allRaws
    .filter(r => rawMatchesStatusFilter(r, statusFilter))
    .slice()
    .sort((a, b) => (a.filename || '').localeCompare(b.filename || ''));
  const counters = kbState.counters || { pendingCount: 0, rawByStatus: {} };
  const pendingCount = counters.pendingCount || 0;
  const isDigesting = (counters.rawByStatus?.digesting || 0) > 0;
  const digestAllDisabled = pendingCount === 0 || isDigesting;
  const autoDigestOn = !!kbState.autoDigest;
  const dp = kbState.digestProgress;
  const progressText = dp ? formatDigestProgress(dp) : '';
  const queueHasFinished = queue.some(q => q.status !== 'uploading' && q.status !== 'queued' && q.status !== 'retrying');
  const queueActiveCount = queue.filter(q => q.status === 'uploading' || q.status === 'queued' || q.status === 'retrying').length;
  const queueFailedCount = queue.filter(q => q.status === 'error').length;

  async function onPickFiles(){ if (filesInputRef.current) filesInputRef.current.click(); }
  async function onPickFolder(){ if (folderInputRef.current) folderInputRef.current.click(); }

  function onFilesInputChange(e){
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    enqueue(files.map(f => ({ file: f, folderPath: currentFolder })));
  }

  function onFolderInputChange(e){
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    enqueue(files.map(f => ({
      file: f,
      folderPath: joinFolder(currentFolder, folderFromRelativePath(f.webkitRelativePath || '')),
    })));
  }

  function onDragEnter(e){
    e.preventDefault();
    dragCounterRef.current += 1;
    setDragHover(true);
  }
  function onDragOver(e){
    // Required for `drop` to fire on this element.
    e.preventDefault();
  }
  function onDragLeave(e){
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragHover(false);
  }
  async function onDrop(e){
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragHover(false);
    try {
      const items = await dropToUploadItems(e.dataTransfer);
      enqueue(items.map(it => ({
        file: it.file,
        folderPath: joinFolder(currentFolder, it.folderPath),
      })));
    } catch (err) {
      await dialog.alert({
        variant: 'error',
        title: 'Could not read dropped items',
        body: err.message || String(err),
        confirmLabel: 'OK',
      });
    }
  }

  async function onToggleAutoDigest(e){
    const target = e.currentTarget;
    const next = target.checked;
    setAutoDigestSaving(true);
    try {
      await AgentApi.kb.setAutoDigest(hash, next);
      await refetch();
    } catch (err) {
      target.checked = !next;
      await dialog.alert({
        variant: 'error',
        title: 'Could not update auto-digest',
        body: err.message || String(err),
        confirmLabel: 'OK',
      });
    } finally {
      setAutoDigestSaving(false);
    }
  }

  async function onDigestAll(e){
    const anchor = e.currentTarget;
    const ok = await dialog.confirm({
      anchor,
      title: 'Digest all pending',
      body: `Run digestion for ${pendingCount} pending file${pendingCount === 1 ? '' : 's'} in this workspace?`,
      confirmLabel: 'Digest All',
    });
    if (!ok) return;
    try {
      await AgentApi.kb.digestAll(hash);
      await refetch();
    } catch (err) {
      await dialog.alert({
        anchor,
        variant: 'error',
        title: 'Could not start digestion',
        body: err.message || String(err),
        confirmLabel: 'OK',
      });
    }
  }

  async function onDigestRow(rawId){
    try {
      await AgentApi.kb.digestRaw(hash, rawId);
      await refetch();
    } catch (err) {
      await dialog.alert({
        variant: 'error',
        title: 'Could not start digestion',
        body: err.message || String(err),
        confirmLabel: 'OK',
      });
    }
  }

  async function onDeleteRow(raw, anchor){
    const ok = await dialog.confirm({
      anchor,
      destructive: true,
      title: 'Delete this file?',
      body: `Remove "${raw.filename}" from the knowledge base. Entries digested from it will also be removed.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await AgentApi.kb.deleteRaw(hash, raw.rawId, raw.folderPath || '', raw.filename);
      await refetch();
    } catch (err) {
      await dialog.alert({
        anchor,
        variant: 'error',
        title: 'Delete failed',
        body: err.message || String(err),
        confirmLabel: 'OK',
      });
    }
  }

  async function onCreateFolder(anchor){
    const here = currentFolder || '/';
    const raw = await dialog.prompt({
      anchor,
      title: 'New folder',
      inputLabel: `Create inside ${here}`,
      placeholder: 'folder name',
      confirmLabel: 'Create',
    });
    if (raw == null) return;
    const name = raw.trim();
    if (!name) return;
    if (/[/\\]/.test(name) || name === '.' || name === '..') {
      await dialog.alert({ anchor, variant: 'error', title: 'Invalid name', body: 'Name cannot contain "/", "\\", "." or "..".' });
      return;
    }
    const newPath = joinFolder(currentFolder, name);
    try {
      await AgentApi.kb.createFolder(hash, newPath);
      setCurrentFolder(newPath);
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Could not create folder', body: err.message || String(err), confirmLabel: 'OK' });
    }
  }

  async function onRenameFolder(folderPath, anchor){
    const segs = folderPath.split('/');
    const last = segs[segs.length - 1];
    const parent = segs.slice(0, -1).join('/');
    const raw = await dialog.prompt({
      anchor,
      title: 'Rename folder',
      inputLabel: `Rename "${last}" to`,
      inputDefault: last,
      confirmLabel: 'Rename',
    });
    if (raw == null) return;
    const next = raw.trim();
    if (!next || next === last) return;
    if (/[/\\]/.test(next) || next === '.' || next === '..') {
      await dialog.alert({ anchor, variant: 'error', title: 'Invalid name', body: 'Name cannot contain "/", "\\", "." or "..".' });
      return;
    }
    const toPath = joinFolder(parent, next);
    try {
      await AgentApi.kb.renameFolder(hash, folderPath, toPath);
      // Rewrite currentFolder if we renamed it (or one of its ancestors).
      if (currentFolder === folderPath) {
        setCurrentFolder(toPath);
      } else if ((currentFolder + '/').startsWith(folderPath + '/')) {
        setCurrentFolder(toPath + currentFolder.slice(folderPath.length));
      } else {
        await refetch();
      }
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Could not rename folder', body: err.message || String(err), confirmLabel: 'OK' });
    }
  }

  async function onDeleteFolder(folderPath, anchor){
    const ok = await dialog.confirm({
      anchor,
      destructive: true,
      title: 'Delete this folder?',
      body: `Delete folder "${folderPath}" and any files or subfolders inside it. Entries digested from those files will also be removed.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await AgentApi.kb.deleteFolder(hash, folderPath, true);
      // If we just deleted the folder we were standing in (or an ancestor of it),
      // navigate back to root so the right column doesn't show stale rows.
      if (currentFolder === folderPath || (currentFolder + '/').startsWith(folderPath + '/')) {
        setCurrentFolder('');
      } else {
        await refetch();
      }
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Could not delete folder', body: err.message || String(err), confirmLabel: 'OK' });
    }
  }

  return (
    <div
      className={`kb-pane kb-raw-pane ${dragHover ? 'is-drag' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {digestComplete ? (
        <div className="kb-banner kb-banner-success">
          <span>
            <strong>Digestion complete</strong> — {digestComplete.entriesCreated} entit{digestComplete.entriesCreated === 1 ? 'y' : 'ies'} created
          </span>
          <button
            type="button"
            className="kb-banner-close"
            onClick={() => setDigestComplete(null)}
            aria-label="Dismiss"
            title="Dismiss"
          >×</button>
        </div>
      ) : null}
      {pandoc && pandoc.available === false ? (
        <div className="kb-banner kb-banner-warn">
          <strong>Pandoc not installed.</strong> DOCX uploads will be rejected until you install pandoc and restart Agent Cockpit. PDF, PPTX, text, and image uploads are unaffected.
        </div>
      ) : null}

      <div className="kb-raw-toolbar">
        <label className="kb-raw-switch" title="Automatically digest new files after ingestion">
          <input
            type="checkbox"
            checked={autoDigestOn}
            disabled={autoDigestSaving}
            onChange={onToggleAutoDigest}
          />
          <span>Auto-digest new files</span>
        </label>
        <button
          className="btn"
          disabled={digestAllDisabled}
          onClick={onDigestAll}
        >{isDigesting ? 'Digesting…' : `Digest All Pending (${pendingCount})`}</button>
        {progressText ? <span className="u-mono u-dim" style={{fontSize:11}}>{progressText}</span> : null}
        <span style={{marginLeft:'auto', display:'inline-flex', gap:6}}>
          <button className="btn ghost" onClick={(e) => onCreateFolder(e.currentTarget)}>+ New folder</button>
          <button className="btn ghost" onClick={onPickFiles}>Upload Files</button>
          <button className="btn ghost" onClick={onPickFolder}>Upload Folder</button>
        </span>
        <input
          ref={filesInputRef}
          type="file"
          multiple
          style={{display:'none'}}
          onChange={onFilesInputChange}
        />
        <input
          ref={el => {
            folderInputRef.current = el;
            // React doesn't always forward these vendor-prefixed boolean attributes,
            // so we set them on the DOM node directly so the picker enumerates folders.
            if (el) {
              el.setAttribute('webkitdirectory', '');
              el.setAttribute('directory', '');
              el.setAttribute('mozdirectory', '');
            }
          }}
          type="file"
          style={{display:'none'}}
          onChange={onFolderInputChange}
        />
      </div>

      <div className="kb-raw-body" style={{'--kb-tree-w': treeWidth + 'px'}}>
        <div className="kb-raw-tree-rail">
          <KbRawFolderTree
            folders={kbState.folders || []}
            currentFolder={currentFolder}
            onSelect={setCurrentFolder}
            onRename={onRenameFolder}
            onDelete={onDeleteFolder}
          />
        </div>
        <div
          className={`kb-raw-resizer ${resizing ? 'dragging' : ''}`}
          onMouseDown={onResizerMouseDown}
          onDoubleClick={onResizerDoubleClick}
          title="Drag to resize · double-click to reset"
          role="separator"
          aria-orientation="vertical"
        />
        <div className="kb-raw-main">
          <KbRawBreadcrumb
            currentFolder={currentFolder}
            onNavigate={setCurrentFolder}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
          />

          {queue.length > 0 ? (
            <div className="kb-raw-queue">
              <div className="kb-raw-queue-head">
                <span className="u-mono u-dim" style={{fontSize:11}}>
                  Uploads · {queueActiveCount} in progress / {queue.length} total
                  {paused && queueActiveCount > 0 ? <span className="u-mono" style={{marginLeft:6}}>· paused</span> : null}
                </span>
                <div className="kb-raw-queue-actions">
                  {queueActiveCount > 0 && !paused ? (
                    <button className="btn ghost" onClick={pauseQueue}>Pause</button>
                  ) : null}
                  {queueActiveCount > 0 && paused ? (
                    <button className="btn ghost" onClick={resumeQueue}>Resume</button>
                  ) : null}
                  {queueActiveCount > 0 ? (
                    <button className="btn ghost" onClick={(e) => cancelQueue(e.currentTarget)}>Cancel</button>
                  ) : null}
                  {queueFailedCount > 0 ? (
                    <button className="btn ghost" onClick={retryFailed}>Retry failed ({queueFailedCount})</button>
                  ) : null}
                  {queueHasFinished ? (
                    <button className="btn ghost" onClick={clearFinishedQueue}>Clear finished</button>
                  ) : null}
                </div>
              </div>
              {queue.map(it => (
                <KbUploadRow key={it.id} item={it} onDismiss={() => dismissQueueItem(it.id)}/>
              ))}
            </div>
          ) : null}

          <div className="kb-raw-list">
            {raws.length === 0 ? (
              <div className="u-dim" style={{padding:"16px"}}>
                {allRaws.length > 0 && statusFilter !== 'all'
                  ? <>No files match this filter. Try <button type="button" className="kb-raw-crumb-link" onClick={() => setStatusFilter('all')}>All</button>.</>
                  : currentFolder
                    ? <>No files in this folder. Drop files here or click <strong>Upload Files</strong> / <strong>Upload Folder</strong> to add some.</>
                    : <>No files yet. Click <strong>Upload Files</strong> or <strong>Upload Folder</strong>, or drop files anywhere on this pane.</>}
              </div>
            ) : raws.map(r => (
              <KbRawRow
                key={`${r.rawId}|${r.folderPath || ''}|${r.filename}`}
                raw={r}
                onDigest={() => onDigestRow(r.rawId)}
                onDelete={(anchor) => onDeleteRow(r, anchor)}
              />
            ))}
          </div>
        </div>
      </div>

      {dragHover ? (
        <div className="kb-raw-drop-overlay">
          <div className="kb-raw-drop-card">
            <div style={{fontSize:14,fontWeight:600,marginBottom:4}}>Drop to upload</div>
            <div className="u-dim" style={{fontSize:12}}>
              Uploads land in <span className="u-mono">{currentFolder ? '/' + currentFolder : '/ (root)'}</span>. Dropped folders preserve their nesting underneath.
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function KbUploadRow({ item, onDismiss }){
  const pct = Math.round((item.progress || 0) * 100);
  const showBar = item.status === 'uploading' || item.status === 'queued' || item.status === 'retrying';
  let label;
  if (item.status === 'queued') label = 'queued';
  else if (item.status === 'uploading') label = `${pct}%`;
  else if (item.status === 'retrying') label = item.message || 'retrying…';
  else if (item.status === 'done') label = 'uploaded';
  else if (item.status === 'deduped') label = 'duplicate';
  else if (item.status === 'error') label = item.message || 'failed';
  else if (item.status === 'cancelled') label = 'cancelled';
  else label = item.status;
  return (
    <div className={`kb-raw-queue-item kb-raw-queue-${item.status}`}>
      <div className="kb-raw-queue-name" title={`${item.folderPath ? item.folderPath + '/' : ''}${item.filename}`}>
        <span className="kb-raw-queue-filename">{item.filename}</span>
        {item.folderPath ? <span className="kb-raw-queue-folder u-mono u-dim">  /{item.folderPath}</span> : null}
      </div>
      {showBar ? (
        <div className="kb-raw-queue-bar"><div className="fill" style={{width: `${pct}%`}}/></div>
      ) : (
        <div className="kb-raw-queue-bar-spacer"/>
      )}
      <div className={`kb-raw-queue-status u-mono ${item.status === 'error' ? 'u-err' : 'u-dim'}`}>{label}</div>
      {item.status === 'error' || item.status === 'cancelled' ? (
        <button className="btn ghost" onClick={onDismiss} title="Dismiss">×</button>
      ) : null}
    </div>
  );
}

function KbRawRow({ raw, onDigest, onDelete }){
  const canDigest = raw.status === 'ingested' || raw.status === 'pending-delete' || raw.status === 'failed';
  const statusClass = `kb-raw-status kb-raw-status-${raw.status || 'unknown'}`;
  const showEntryCount = raw.status === 'digested' && Number(raw.entryCount) > 0;
  return (
    <div className="kb-raw-row">
      <div className="kb-raw-row-main">
        <div className="kb-raw-filename" title={raw.filename}>{raw.filename}</div>
        <div className="kb-raw-meta u-mono u-dim">
          {formatBytes(raw.sizeBytes)} · {formatRelative(raw.uploadedAt)}
          {showEntryCount ? ` · ${raw.entryCount} ${raw.entryCount === 1 ? 'entry' : 'entries'}` : ''}
        </div>
      </div>
      <span className={statusClass} title={raw.status}>{raw.status}</span>
      {canDigest ? (
        <button className="btn ghost" onClick={onDigest} title="Digest now">Digest</button>
      ) : null}
      <button
        className="btn ghost"
        onClick={(e) => onDelete(e.currentTarget)}
        title="Delete this file"
      >Delete</button>
      {raw.errorMessage ? (
        <div className="kb-raw-error u-err">{raw.errorMessage}</div>
      ) : null}
    </div>
  );
}

/* Per-workspace embedding configuration form: Model / Ollama Host /
   Dimensions inputs, Test Connection + Save buttons, inline health pill.
   Backend defaults apply when fields are blank on save (model:
   nomic-embed-text, host: http://localhost:11434, dims: 768). */
const KB_EMB_DEFAULTS = {
  model: 'nomic-embed-text',
  ollamaHost: 'http://localhost:11434',
  dimensions: 768,
};
function KbSettingsTab({ hash }){
  const dialog = useDialog();
  const toast = useToasts();
  const [loading, setLoading] = React.useState(true);
  const [model, setModel] = React.useState('');
  const [ollamaHost, setOllamaHost] = React.useState('');
  const [dimensions, setDimensions] = React.useState(KB_EMB_DEFAULTS.dimensions);
  const [saving, setSaving] = React.useState(false);
  // health: null | 'checking' | { ok: boolean, error?: string }
  const [health, setHealth] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    AgentApi.kb.getEmbeddingConfig(hash)
      .then(res => {
        if (cancelled) return;
        const cfg = (res && res.embeddingConfig) || {};
        setModel(cfg.model || '');
        setOllamaHost(cfg.ollamaHost || '');
        setDimensions(Number.isFinite(cfg.dimensions) ? cfg.dimensions : KB_EMB_DEFAULTS.dimensions);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [hash]);

  async function onTest(){
    setHealth('checking');
    try {
      const res = await AgentApi.kb.embeddingHealth(hash);
      setHealth(res && typeof res === 'object' ? res : { ok: false, error: 'Invalid response' });
    } catch (err) {
      setHealth({ ok: false, error: err.message || String(err) });
    }
  }

  async function onSave(anchor){
    setSaving(true);
    try {
      const payload = {
        model: (model || '').trim() || KB_EMB_DEFAULTS.model,
        ollamaHost: (ollamaHost || '').trim() || KB_EMB_DEFAULTS.ollamaHost,
        dimensions: Number.isFinite(dimensions) && dimensions > 0 ? dimensions : KB_EMB_DEFAULTS.dimensions,
      };
      const res = await AgentApi.kb.setEmbeddingConfig(hash, payload);
      const saved = (res && res.embeddingConfig) || payload;
      setModel(saved.model || '');
      setOllamaHost(saved.ollamaHost || '');
      setDimensions(Number.isFinite(saved.dimensions) ? saved.dimensions : KB_EMB_DEFAULTS.dimensions);
      toast.success('Embedding configuration saved');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Save failed', body: err.message || String(err) });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="kb-pane"><div className="u-dim" style={{padding:"16px"}}>Loading…</div></div>;
  }

  let healthEl = null;
  if (health === 'checking') {
    healthEl = <span className="kb-settings-health checking">Checking…</span>;
  } else if (health && health.ok) {
    healthEl = <span className="kb-settings-health ok">Connected</span>;
  } else if (health && !health.ok) {
    healthEl = <span className="kb-settings-health err">{health.error || 'Connection failed'}</span>;
  }

  return (
    <div className="kb-pane kb-settings-pane">
      <h3 className="kb-settings-title">Embedding Configuration</h3>
      <p className="kb-settings-desc u-dim">
        Embeddings power vector search over your entries and topics. Requires{' '}
        <a href="https://ollama.com" target="_blank" rel="noopener noreferrer">Ollama</a> running locally.
      </p>
      <div className="kb-settings-form">
        <label className="kb-settings-field">
          <span>Model</span>
          <input
            type="text"
            value={model}
            placeholder={KB_EMB_DEFAULTS.model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <label className="kb-settings-field">
          <span>Ollama Host</span>
          <input
            type="text"
            value={ollamaHost}
            placeholder={KB_EMB_DEFAULTS.ollamaHost}
            onChange={(e) => setOllamaHost(e.target.value)}
          />
        </label>
        <label className="kb-settings-field">
          <span>Dimensions</span>
          <input
            type="number"
            min={1}
            max={4096}
            value={dimensions}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              setDimensions(Number.isFinite(n) ? n : KB_EMB_DEFAULTS.dimensions);
            }}
          />
        </label>
        <div className="kb-settings-actions">
          <button className="btn" onClick={onTest} disabled={health === 'checking'}>Test Connection</button>
          <button className="btn" onClick={(e) => onSave(e.currentTarget)} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          {healthEl}
        </div>
      </div>
    </div>
  );
}

window.KbBrowser = KbBrowser;
