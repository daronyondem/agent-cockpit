/* global React, AgentApi, useDialog, useToasts */

/* SettingsScreen — full-screen modal-swap pane for V2 app settings.
   Mirrors the V1 5-tab layout (General / Memory / Knowledge Base / Usage /
   Server) backed by `GET/PUT /settings` plus `GET /backends`, `GET /usage-stats`
   (+ DELETE), and `POST /server/restart`. All form tabs share a single
   in-memory `settings` object; clicking Save on any form tab POSTs the full
   merged shape so the user doesn't have to remember to save from one specific
   tab (V1 only had Save on General). */

const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'memory',  label: 'Memory' },
  { id: 'kb',      label: 'Knowledge Base' },
  { id: 'usage',   label: 'Usage' },
  { id: 'server',  label: 'Server' },
];

/* Apply the chosen theme to the root element so the user sees a live preview
   while picking. 'system' resolves to the OS preference. The persistence
   round-trip happens on Save, but the visual is immediate. */
function applyThemePreview(theme){
  const root = document.getElementById('root');
  if (!root) return;
  let resolved;
  if (theme === 'system') {
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    resolved = dark ? 'dark' : 'light';
  } else {
    resolved = theme || 'light';
  }
  root.setAttribute('data-theme', resolved);
  const hljsLink = document.getElementById('hljs-theme');
  if (hljsLink) {
    const style = resolved === 'dark' ? 'github-dark' : 'github';
    hljsLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/' + style + '.min.css';
  }
}

/* Persist the theme choice to localStorage so the pre-paint inline script in
   index.html can apply it before React boots on the next load. Called from
   save() and from the settings-load reconcile — NOT from applyThemePreview
   so an unsaved preview doesn't linger across reloads. */
function persistThemeToLocalStorage(theme){
  try { localStorage.setItem('ac:v2:theme', theme || 'system'); } catch (e) {}
}

/* Backend → models[] / model → effort[] lookups. Returns [] when missing so
   the calling components can branch on `length`. */
function modelsForBackend(backends, backendId){
  const b = (backends || []).find(b => b.id === backendId);
  return (b && Array.isArray(b.models)) ? b.models : [];
}
function defaultModelId(models){
  if (!models || !models.length) return undefined;
  const def = models.find(m => m.default);
  return def ? def.id : models[0].id;
}
function effortLevelsForModel(backends, backendId, modelId){
  const models = modelsForBackend(backends, backendId);
  const m = models.find(x => x.id === modelId);
  if (!m || !Array.isArray(m.supportedEffortLevels)) return [];
  return m.supportedEffortLevels;
}
function defaultEffortFor(levels){
  if (!levels || !levels.length) return undefined;
  return levels.includes('high') ? 'high' : levels[0];
}

/* Reusable labelled-row primitive used by every form tab. */
function Field({ label, hint, children }){
  return (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      {children}
      {hint ? <span className="settings-field-hint u-dim">{hint}</span> : null}
    </label>
  );
}

/* Segmented horizontal picker — matches the deck mock-up's `.seg.seg-inline`
   visual (a row of pill buttons with `aria-pressed` on the active one).
   Accepts `options: [{ id, label }]` and resolves to the picked id. */
function Seg({ value, onChange, options }){
  return (
    <div className="seg seg-inline">
      {options.map(o => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange && onChange(o.id)}
        >{o.label}</button>
      ))}
    </div>
  );
}

/* Pill toggle switch — matches the deck's `.toggle/.tgl` markup so the
   visual style stays consistent with the design mock-up. */
function Toggle({ checked, onChange, label }){
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange && onChange(e.target.checked)}
      />
      <span className="tgl"/>
      <span>{label}</span>
    </label>
  );
}

function SettingsScreen({ onClose }){
  const dialog = useDialog();
  const toast = useToasts();
  const [tab, setTab] = React.useState('general');
  const [settings, setSettings] = React.useState(null);
  const [backends, setBackends] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([AgentApi.settings.get(), AgentApi.settings.backends()])
      .then(([s, b]) => {
        if (cancelled) return;
        setSettings(s || {});
        setBackends((b && b.backends) || []);
        if (s && s.theme) persistThemeToLocalStorage(s.theme);
      })
      .catch(e => { if (!cancelled) setLoadError(e.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  /* Live theme preview as the dropdown changes — Save persists. */
  React.useEffect(() => {
    if (settings && settings.theme) applyThemePreview(settings.theme);
  }, [settings && settings.theme]);

  function patch(updater){
    setSettings(prev => {
      const u = (typeof updater === 'function') ? updater(prev) : updater;
      return { ...prev, ...u };
    });
  }

  async function save(anchor){
    if (!settings) return;
    setSaving(true);
    try {
      const res = await AgentApi.settings.save(settings);
      setSettings(res || settings);
      const savedTheme = (res && res.theme) || settings.theme;
      if (savedTheme) persistThemeToLocalStorage(savedTheme);
      toast.success('Settings saved');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Save failed', body: err.message || String(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-shell">
      <div className="settings-top">
        <div className="settings-title-block">
          <div className="settings-title">Settings</div>
          <div className="settings-subtitle u-dim">Global app preferences</div>
        </div>
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
      <div className="settings-tabs">
        {SETTINGS_TABS.map(t => (
          <div
            key={t.id}
            className={`settings-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >{t.label}</div>
        ))}
      </div>
      <div className="settings-body">
        {loading
          ? <div className="u-dim" style={{padding:'16px'}}>Loading…</div>
          : loadError
            ? <div className="u-err" style={{padding:'16px'}}>{loadError}</div>
            : tab === 'general' ? <GeneralTab settings={settings} backends={backends} onPatch={patch} onSave={save} saving={saving}/>
            : tab === 'memory'  ? <SettingsMemoryTab settings={settings} backends={backends} onPatch={patch} onSave={save} saving={saving}/>
            : tab === 'kb'      ? <SettingsKbTab settings={settings} backends={backends} onPatch={patch} onSave={save} saving={saving}/>
            : tab === 'usage'   ? <UsageTab/>
            : tab === 'server'  ? <ServerTab/>
            : null}
      </div>
    </div>
  );
}
window.SettingsScreen = SettingsScreen;

/* ──────────────────── General tab ──────────────────── */

function GeneralTab({ settings, backends, onPatch, onSave, saving }){
  const backendId = settings.defaultBackend || (backends[0] && backends[0].id) || '';
  const models = modelsForBackend(backends, backendId);
  const modelId = settings.defaultModel || defaultModelId(models) || '';
  const efforts = effortLevelsForModel(backends, backendId, modelId);
  const effort = settings.defaultEffort || defaultEffortFor(efforts) || '';

  /* Switching backend resets model + effort to that backend's defaults so we
     never carry a model id into a backend that doesn't support it. */
  function onBackendChange(v){
    const m = modelsForBackend(backends, v);
    const newModel = defaultModelId(m);
    const e = effortLevelsForModel(backends, v, newModel);
    onPatch({ defaultBackend: v, defaultModel: newModel, defaultEffort: defaultEffortFor(e) });
  }
  function onModelChange(v){
    const e = effortLevelsForModel(backends, backendId, v);
    onPatch({ defaultModel: v, defaultEffort: defaultEffortFor(e) });
  }

  return (
    <div className="settings-form">
      <Field label="Theme" hint="System follows your OS appearance.">
        <Seg
          value={settings.theme || 'system'}
          onChange={(v) => onPatch({ theme: v })}
          options={[
            { id: 'system', label: 'System' },
            { id: 'light',  label: 'Light' },
            { id: 'dark',   label: 'Dark' },
          ]}
        />
      </Field>
      <Field label="Send behavior" hint="Shift+Enter always inserts a newline.">
        <Seg
          value={settings.sendBehavior || 'enter'}
          onChange={(v) => onPatch({ sendBehavior: v })}
          options={[
            { id: 'enter',     label: 'Enter to send' },
            { id: 'ctrlEnter', label: '⌘/Ctrl+Enter to send' },
          ]}
        />
      </Field>
      <Field label="Default backend">
        <select value={backendId} onChange={(e) => onBackendChange(e.target.value)}>
          {backends.length === 0 ? <option value="">No backends available</option> : null}
          {backends.map(b => <option key={b.id} value={b.id}>{b.label || b.id}</option>)}
        </select>
      </Field>
      {models.length ? (
        <Field label="Default model">
          <select value={modelId} onChange={(e) => onModelChange(e.target.value)}>
            {models.map(m => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
          </select>
        </Field>
      ) : null}
      {efforts.length ? (
        <Field label="Default effort">
          <Seg
            value={effort}
            onChange={(v) => onPatch({ defaultEffort: v })}
            options={efforts.map(lv => ({ id: lv, label: lv }))}
          />
        </Field>
      ) : null}
      <Field label="System prompt" hint="Prepended to every conversation. Leave blank for backend default.">
        <textarea
          rows={6}
          value={settings.systemPrompt || ''}
          placeholder="Optional system instruction…"
          onChange={(e) => onPatch({ systemPrompt: e.target.value })}
        />
      </Field>
      <div className="settings-actions">
        <button className="btn primary" disabled={saving} onClick={(e) => onSave(e.currentTarget)}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

/* ──────────────────── Memory tab ──────────────────── */

function SettingsMemoryTab({ settings, backends, onPatch, onSave, saving }){
  const mem = settings.memory || {};
  const fallbackBackend = settings.defaultBackend || (backends[0] && backends[0].id) || '';
  const backendId = mem.cliBackend || fallbackBackend;
  const models = modelsForBackend(backends, backendId);
  const modelId = mem.cliModel || defaultModelId(models) || '';
  const efforts = effortLevelsForModel(backends, backendId, modelId);
  const effort = mem.cliEffort || defaultEffortFor(efforts) || '';

  function patchMem(next){
    onPatch(prev => ({ memory: { ...(prev.memory || {}), ...next } }));
  }
  function onBackendChange(v){
    const m = modelsForBackend(backends, v);
    const newModel = defaultModelId(m);
    const e = effortLevelsForModel(backends, v, newModel);
    patchMem({ cliBackend: v, cliModel: newModel, cliEffort: defaultEffortFor(e) });
  }
  function onModelChange(v){
    const e = effortLevelsForModel(backends, backendId, v);
    patchMem({ cliModel: v, cliEffort: defaultEffortFor(e) });
  }

  return (
    <div className="settings-form">
      <p className="settings-desc u-dim">
        Backend used by the workspace memory CLI when generating CLAUDE.md and related files.
        Falls back to the default backend when unset.
      </p>
      <Field label="Memory CLI backend">
        <select value={backendId} onChange={(e) => onBackendChange(e.target.value)}>
          {backends.length === 0 ? <option value="">No backends available</option> : null}
          {backends.map(b => <option key={b.id} value={b.id}>{b.label || b.id}</option>)}
        </select>
      </Field>
      {models.length ? (
        <Field label="Memory model">
          <select value={modelId} onChange={(e) => onModelChange(e.target.value)}>
            {models.map(m => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
          </select>
        </Field>
      ) : null}
      {efforts.length ? (
        <Field label="Memory effort">
          <Seg
            value={effort}
            onChange={(v) => patchMem({ cliEffort: v })}
            options={efforts.map(lv => ({ id: lv, label: lv }))}
          />
        </Field>
      ) : null}
      <div className="settings-actions">
        <button className="btn" disabled={saving} onClick={(e) => onSave(e.currentTarget)}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

/* ──────────────────── Knowledge Base tab ──────────────────── */

function SettingsKbTab({ settings, backends, onPatch, onSave, saving }){
  const kb = settings.knowledgeBase || {};
  const fallbackBackend = settings.defaultBackend || (backends[0] && backends[0].id) || '';

  // Digestion picks
  const dgBackend = kb.digestionCliBackend || fallbackBackend;
  const dgModels = modelsForBackend(backends, dgBackend);
  const dgModel = kb.digestionCliModel || defaultModelId(dgModels) || '';
  const dgEfforts = effortLevelsForModel(backends, dgBackend, dgModel);
  const dgEffort = kb.digestionCliEffort || defaultEffortFor(dgEfforts) || '';

  // Dreaming picks
  const drBackend = kb.dreamingCliBackend || fallbackBackend;
  const drModels = modelsForBackend(backends, drBackend);
  const drModel = kb.dreamingCliModel || defaultModelId(drModels) || '';
  const drEfforts = effortLevelsForModel(backends, drBackend, drModel);
  const drEffort = kb.dreamingCliEffort || defaultEffortFor(drEfforts) || '';

  const concurrency = Number.isFinite(kb.dreamingConcurrency) ? kb.dreamingConcurrency : 2;
  const convertSlides = !!kb.convertSlidesToImages;

  const [pandoc, setPandoc] = React.useState(null);
  const [libreOffice, setLibreOffice] = React.useState(null);
  const [convertWarning, setConvertWarning] = React.useState(null);

  React.useEffect(() => {
    AgentApi.kb.pandocStatus().then(setPandoc).catch(() => setPandoc({ available: false }));
    AgentApi.kb.libreOfficeStatus().then(setLibreOffice).catch(() => setLibreOffice({ available: false }));
  }, []);

  function patchKb(next){
    onPatch(prev => ({ knowledgeBase: { ...(prev.knowledgeBase || {}), ...next } }));
  }
  function onDgBackend(v){
    const m = modelsForBackend(backends, v);
    const newModel = defaultModelId(m);
    const e = effortLevelsForModel(backends, v, newModel);
    patchKb({ digestionCliBackend: v, digestionCliModel: newModel, digestionCliEffort: defaultEffortFor(e) });
  }
  function onDgModel(v){
    const e = effortLevelsForModel(backends, dgBackend, v);
    patchKb({ digestionCliModel: v, digestionCliEffort: defaultEffortFor(e) });
  }
  function onDrBackend(v){
    const m = modelsForBackend(backends, v);
    const newModel = defaultModelId(m);
    const e = effortLevelsForModel(backends, v, newModel);
    patchKb({ dreamingCliBackend: v, dreamingCliModel: newModel, dreamingCliEffort: defaultEffortFor(e) });
  }
  function onDrModel(v){
    const e = effortLevelsForModel(backends, drBackend, v);
    patchKb({ dreamingCliModel: v, dreamingCliEffort: defaultEffortFor(e) });
  }
  function onConcurrency(v){
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return;
    patchKb({ dreamingConcurrency: Math.max(1, Math.min(10, n)) });
  }
  /* LibreOffice required for the PPTX→images conversion path; reject the
     toggle and surface a warning if the binary isn't on PATH so the user
     isn't silently saving an unrunnable preference. */
  function onConvertSlides(checked){
    if (checked && libreOffice && !libreOffice.available) {
      setConvertWarning('LibreOffice not detected. Install it and restart to enable PPTX→image conversion.');
      return;
    }
    setConvertWarning(null);
    patchKb({ convertSlidesToImages: checked });
  }

  return (
    <div className="settings-form">
      <p className="settings-desc u-dim">
        Per-CLI defaults for the digestion and dreaming pipelines. Embedding configuration
        lives on each workspace's KB Settings tab.
      </p>

      <div className="settings-status-row">
        <span className={`settings-status-pill ${pandoc && pandoc.available ? 'ok' : 'err'}`}>
          {pandoc == null ? 'Pandoc: …'
            : pandoc.available ? `Pandoc: detected${pandoc.version ? ' ' + pandoc.version : ''}`
            : 'Pandoc: not installed'}
        </span>
        <span className={`settings-status-pill ${libreOffice && libreOffice.available ? 'ok' : 'err'}`}>
          {libreOffice == null ? 'LibreOffice: …'
            : libreOffice.available ? 'LibreOffice: detected'
            : 'LibreOffice: not installed'}
        </span>
      </div>

      <div className="settings-section-title">Digestion</div>
      <Field label="Digestion CLI backend">
        <select value={dgBackend} onChange={(e) => onDgBackend(e.target.value)}>
          {backends.length === 0 ? <option value="">No backends available</option> : null}
          {backends.map(b => <option key={b.id} value={b.id}>{b.label || b.id}</option>)}
        </select>
      </Field>
      {dgModels.length ? (
        <Field label="Digestion model">
          <select value={dgModel} onChange={(e) => onDgModel(e.target.value)}>
            {dgModels.map(m => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
          </select>
        </Field>
      ) : null}
      {dgEfforts.length ? (
        <Field label="Digestion effort">
          <Seg
            value={dgEffort}
            onChange={(v) => patchKb({ digestionCliEffort: v })}
            options={dgEfforts.map(lv => ({ id: lv, label: lv }))}
          />
        </Field>
      ) : null}

      <div className="settings-section-title">Dreaming</div>
      <Field label="Dreaming CLI backend">
        <select value={drBackend} onChange={(e) => onDrBackend(e.target.value)}>
          {backends.length === 0 ? <option value="">No backends available</option> : null}
          {backends.map(b => <option key={b.id} value={b.id}>{b.label || b.id}</option>)}
        </select>
      </Field>
      {drModels.length ? (
        <Field label="Dreaming model">
          <select value={drModel} onChange={(e) => onDrModel(e.target.value)}>
            {drModels.map(m => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
          </select>
        </Field>
      ) : null}
      {drEfforts.length ? (
        <Field label="Dreaming effort">
          <Seg
            value={drEffort}
            onChange={(v) => patchKb({ dreamingCliEffort: v })}
            options={drEfforts.map(lv => ({ id: lv, label: lv }))}
          />
        </Field>
      ) : null}
      <Field label="Dreaming concurrency" hint="Parallel topic-routing agents (1–10).">
        <input
          type="number"
          min={1}
          max={10}
          value={concurrency}
          onChange={(e) => onConcurrency(e.target.value)}
        />
      </Field>

      <div className="settings-section-title">Conversion</div>
      <Toggle
        checked={convertSlides}
        onChange={onConvertSlides}
        label="Convert PPTX slides to images during ingestion"
      />
      {convertWarning ? <div className="settings-warning u-err">{convertWarning}</div> : null}

      <div className="settings-actions">
        <button className="btn" disabled={saving} onClick={(e) => onSave(e.currentTarget)}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

/* ──────────────────── Usage tab ──────────────────── */

function fmtNum(n){ return Math.round(n || 0).toLocaleString(); }
function fmtTokensShort(n){
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000)      return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}
function fmtCost(n){ const v = Number(n) || 0; return `$${v.toFixed(4)}`; }
function fmtCostShort(n){ const v = Number(n) || 0; return v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`; }

/* Pick the most-recent N days from the ledger (relative to the latest date
   present, not wallclock today — sparse data still aggregates sensibly). */
function trailingDays(days, n){
  if (!Array.isArray(days) || !days.length) return [];
  const sorted = days.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return n >= sorted.length ? sorted : sorted.slice(0, n);
}

/* Sum every record across the given days into a single { input, output,
   cache R, cache W, cost } total. Used for the stat cards. */
function totalsFor(days){
  const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  for (const d of days || []) {
    for (const r of (d.records || [])) {
      const u = r.usage || {};
      t.inputTokens      += u.inputTokens      || 0;
      t.outputTokens     += u.outputTokens     || 0;
      t.cacheReadTokens  += u.cacheReadTokens  || 0;
      t.cacheWriteTokens += u.cacheWriteTokens || 0;
      t.costUsd          += u.costUsd          || 0;
    }
  }
  return t;
}

/* Filter the raw `days` list to the selected range. Mirrors V1
   `chatUpdateUsageStats` (public/js/main.js:1142-1157). Empty range
   returns an empty array — matches the "no data for this period" UX. */
function daysForRange(days, range){
  if (!Array.isArray(days) || !days.length) return [];
  if (range === 'all') return days;
  const now = new Date();
  const cutoff = new Date(now);
  if (range === 'today')      cutoff.setHours(0, 0, 0, 0);
  else if (range === 'week')  cutoff.setDate(cutoff.getDate() - 7);
  else if (range === 'month') cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return days.filter(d => (d.date || '') >= cutoffStr);
}

/* Flatten `days` into one row per (date, backend, model). Sorted by
   date descending so the most recent activity leads. Drives the
   "Daily breakdown" table ported from V1 main.js:1217-1230. */
function buildDailyRows(days){
  const rows = [];
  const sorted = (days || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  for (const d of sorted) {
    for (const r of (d.records || [])) {
      rows.push({
        date: d.date || '',
        backend: r.backend,
        model: r.model,
        usage: r.usage || {},
      });
    }
  }
  return rows;
}

function aggregatePerModel(days){
  const map = new Map();
  for (const d of days || []) {
    for (const r of (d.records || [])) {
      const key = `${r.backend}\u0001${r.model}`;
      const slot = map.get(key) || {
        backend: r.backend, model: r.model,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0,
      };
      const u = r.usage || {};
      slot.inputTokens      += u.inputTokens      || 0;
      slot.outputTokens     += u.outputTokens     || 0;
      slot.cacheReadTokens  += u.cacheReadTokens  || 0;
      slot.cacheWriteTokens += u.cacheWriteTokens || 0;
      slot.costUsd          += u.costUsd          || 0;
      map.set(key, slot);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.costUsd - a.costUsd);
}

/* Build the bar series for the "last 14 days" chart. Returns ascending
   (oldest → newest left → right) bars whose value is either total cost or
   total tokens for that day, depending on the selected metric. */
function buildBars(days, metric){
  const last14 = trailingDays(days, 14).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return last14.map(d => {
    let value = 0;
    for (const r of (d.records || [])) {
      const u = r.usage || {};
      if (metric === 'cost')  value += u.costUsd || 0;
      else                    value += (u.inputTokens || 0) + (u.outputTokens || 0);
    }
    return { date: d.date, value };
  });
}

function UsageTab(){
  const dialog = useDialog();
  const [data, setData]   = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [metric, setMetric] = React.useState('cost');   // bars: 'cost' | 'tokens'
  const [range, setRange] = React.useState('week');     // 'today' | 'week' | 'month' | 'all'

  React.useEffect(() => { reload(); }, []);

  async function reload(){
    setLoading(true); setError(null);
    try {
      const res = await AgentApi.settings.usageStats();
      setData(res || { days: [] });
    } catch (e) {
      setError(e.message || String(e));
    } finally { setLoading(false); }
  }

  async function onClear(anchor){
    const ok = await dialog.confirm({
      anchor, destructive: true,
      title: 'Clear all usage data?',
      body: 'Removes the entire local usage ledger. This is purely local — it does not affect any backend billing.',
      confirmLabel: 'Clear',
    });
    if (!ok) return;
    try {
      await AgentApi.settings.clearUsageStats();
      await reload();
    } catch (e) {
      await dialog.alert({ anchor, variant: 'error', title: 'Clear failed', body: e.message || String(e) });
    }
  }

  if (loading) return <div className="u-dim" style={{padding:'16px'}}>Loading…</div>;
  if (error)   return <div className="u-err" style={{padding:'16px'}}>{error}</div>;

  const allDays = (data && data.days) || [];
  const today   = totalsFor(trailingDays(allDays, 1));
  const week    = totalsFor(trailingDays(allDays, 7));
  const month   = totalsFor(trailingDays(allDays, 30));
  const all     = totalsFor(allDays);
  const bars    = buildBars(allDays, metric);
  const maxBar  = bars.reduce((m, b) => Math.max(m, b.value), 0);
  const rangeDays = daysForRange(allDays, range);
  const summary = aggregatePerModel(rangeDays);
  const dailyRows = buildDailyRows(rangeDays);

  return (
    <div className="settings-usage">
      <div className="stat-grid">
        <div className="stat">
          <div className="lbl">Today</div>
          <div className="num">{fmtCostShort(today.costUsd)}</div>
          <div className="sub u-dim">{fmtTokensShort(today.inputTokens)} in · {fmtTokensShort(today.outputTokens)} out</div>
        </div>
        <div className="stat">
          <div className="lbl">Last 7 days</div>
          <div className="num">{fmtCostShort(week.costUsd)}</div>
          <div className="sub u-dim">{fmtTokensShort(week.inputTokens + week.outputTokens)} tokens</div>
        </div>
        <div className="stat">
          <div className="lbl">Last 30 days</div>
          <div className="num">{fmtCostShort(month.costUsd)}</div>
          <div className="sub u-dim">{fmtTokensShort(month.inputTokens + month.outputTokens)} tokens</div>
        </div>
        <div className="stat">
          <div className="lbl">All time</div>
          <div className="num">{fmtCostShort(all.costUsd)}</div>
          <div className="sub u-dim">{fmtTokensShort(all.inputTokens + all.outputTokens)} tokens</div>
        </div>
      </div>

      <div className="pane-block">
        <div className="pane-block-head">
          <span>Last 14 days</span>
          <span className="spacer"/>
          <Seg
            value={metric}
            onChange={setMetric}
            options={[{ id: 'cost', label: 'Cost' }, { id: 'tokens', label: 'Tokens' }]}
          />
        </div>
        {bars.length === 0 || maxBar === 0 ? (
          <div className="u-dim" style={{padding:'24px',fontSize:12}}>No usage recorded yet.</div>
        ) : (
          <div className="bars">
            {bars.map((b, i) => (
              <div
                key={b.date || i}
                className="bar"
                style={{ height: `${(b.value / maxBar) * 100}%` }}
                title={`${b.date} · ${metric === 'cost' ? fmtCost(b.value) : fmtNum(b.value) + ' tokens'}`}
              />
            ))}
          </div>
        )}
      </div>

      <div className="pane-block">
        <div className="pane-block-head">
          <span>By backend &amp; model</span>
          <span className="spacer"/>
          <Seg
            value={range}
            onChange={setRange}
            options={[
              { id: 'today', label: 'Today' },
              { id: 'week',  label: 'Week' },
              { id: 'month', label: 'Month' },
              { id: 'all',   label: 'All' },
            ]}
          />
        </div>
        {summary.length === 0 ? (
          <div className="u-dim" style={{padding:'24px',fontSize:12}}>No records for this period.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Backend</th><th>Model</th>
                <th className="r">Input</th><th className="r">Output</th>
                <th className="r">Cache R</th><th className="r">Cache W</th>
                <th className="r">Cost</th>
              </tr>
            </thead>
            <tbody>
              {summary.map(r => (
                <tr key={`${r.backend}/${r.model}`}>
                  <td>{r.backend}</td>
                  <td className="u-mono">{r.model}</td>
                  <td className="r">{fmtNum(r.inputTokens)}</td>
                  <td className="r">{fmtNum(r.outputTokens)}</td>
                  <td className="r">{fmtNum(r.cacheReadTokens)}</td>
                  <td className="r">{fmtNum(r.cacheWriteTokens)}</td>
                  <td className="r">{fmtCost(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {dailyRows.length > 0 && rangeDays.length > 1 ? (
        <div className="pane-block">
          <div className="pane-block-head">
            <span>Daily breakdown</span>
            <span className="spacer"/>
            <span className="u-dim u-mono" style={{fontSize:10.5}}>{rangeDays.length} day{rangeDays.length === 1 ? '' : 's'}</span>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th><th>Backend</th><th>Model</th>
                <th className="r">Tokens</th><th className="r">Cost</th>
              </tr>
            </thead>
            <tbody>
              {dailyRows.map((r, i) => {
                const u = r.usage;
                const tokens = (u.inputTokens || 0) + (u.outputTokens || 0);
                return (
                  <tr key={`${r.date}/${r.backend}/${r.model}/${i}`}>
                    <td className="u-mono">{r.date}</td>
                    <td>{r.backend}</td>
                    <td className="u-mono">{r.model}</td>
                    <td className="r">{fmtNum(tokens)}</td>
                    <td className="r">{u.costUsd > 0 ? fmtCost(u.costUsd) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="settings-actions">
        <button className="btn ghost" onClick={(e) => onClear(e.currentTarget)}>Clear all usage data</button>
      </div>
    </div>
  );
}

/* ──────────────────── Server tab ──────────────────── */

function ServerTab(){
  const dialog = useDialog();
  const [restarting, setRestarting] = React.useState(false);
  const [status, setStatus] = React.useState(null);
  const [overlay, setOverlay] = React.useState(false);

  async function onRestart(anchor){
    const ok = await dialog.confirm({
      anchor, destructive: true,
      title: 'Restart the server?',
      body: 'pm2 will gracefully restart the process. Any active streams will be aborted.',
      confirmLabel: 'Restart',
    });
    if (!ok) return;
    setRestarting(true);
    setStatus('Requesting restart…');
    try {
      const res = await AgentApi.settings.restartServer();
      if (res && res.success === true) {
        setStatus('Restart launched. Reconnecting…');
        setTimeout(() => setOverlay(true), 500);
        setTimeout(() => window.location.reload(), 6000);
      } else {
        setStatus((res && res.message) || 'Restart blocked (active stream in progress).');
        setRestarting(false);
      }
    } catch (err) {
      /* The restart script sleeps briefly before killing pm2 so the fetch
         usually resolves cleanly, but if timing races and the process dies
         first a "Failed to fetch" TypeError is the expected outcome —
         treat it as success and reload. */
      if (err && (err.message === 'Failed to fetch' || err.name === 'TypeError')) {
        setOverlay(true);
        setTimeout(() => window.location.reload(), 5000);
        return;
      }
      const msg = err && err.status === 409
        ? 'Restart blocked: an active stream is in progress. Stop or wait for it, then try again.'
        : (err.message || String(err));
      setStatus('Failed: ' + msg);
      setRestarting(false);
    }
  }

  return (
    <div className="settings-form">
      <p className="settings-desc u-dim">
        Restart the Agent Cockpit server process under pm2. Useful after upgrading or
        editing config files. Active conversation streams will be aborted.
      </p>
      <div className="settings-actions">
        <button className="btn" disabled={restarting} onClick={(e) => onRestart(e.currentTarget)}>
          {restarting ? 'Restarting…' : 'Restart server'}
        </button>
      </div>
      {status ? <div className="settings-status-line u-dim">{status}</div> : null}
      {overlay ? (
        <div className="restart-overlay" role="status" aria-live="polite">
          <div className="restart-dialog">
            <div className="restart-title">Restarting server…</div>
            <div className="restart-sub">The page will reload automatically.</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
