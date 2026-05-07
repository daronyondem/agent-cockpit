/* global React, AgentApi, Ico, useDialog, useToasts, CliUpdateStore */

/* SettingsScreen — full-screen modal-swap pane for V2 app settings.
   Mirrors the V1 layout (General / CLI Config / Memory / Knowledge Base /
   Security / Usage / Server) backed by `GET/PUT /settings` plus `GET /backends`,
   auth/security endpoints, `GET /usage-stats` (+ DELETE), and `POST /server/restart`.
   All form tabs share a single
   in-memory `settings` object; clicking Save on any form tab POSTs the full
   merged shape so the user doesn't have to remember to save from one specific
   tab (V1 only had Save on General). */

const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'cli',     label: 'CLI Config' },
  { id: 'memory',  label: 'Memory' },
  { id: 'kb',      label: 'Knowledge Base' },
  { id: 'security', label: 'Security' },
  { id: 'usage',   label: 'Usage' },
  { id: 'server',  label: 'Server' },
];

const CLI_VENDOR_OPTIONS = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'kiro', label: 'Kiro' },
];

function cliVendorLabel(vendor){
  const opt = CLI_VENDOR_OPTIONS.find(o => o.id === vendor);
  return opt ? opt.label : (vendor || 'CLI');
}

function isServerConfiguredProfile(profile){
  return !!(profile && typeof profile.id === 'string' && profile.id.startsWith('server-configured-'));
}

function normalizeUiProfile(profile){
  const next = { ...profile };
  if (next.authMode !== 'account') {
    delete next.configDir;
    delete next.env;
  }
  if (next.vendor === 'kiro') {
    next.authMode = 'server-configured';
    delete next.command;
    delete next.configDir;
    delete next.env;
  }
  return next;
}

function cliDefaultCommand(vendor){
  return vendor === 'codex' ? 'codex' : vendor === 'kiro' ? 'kiro-cli' : 'claude';
}

function cliSelfConfiguredHome(vendor){
  if (vendor === 'codex') return '~/.codex';
  if (vendor === 'claude-code') return '~/.claude';
  return 'the server Kiro CLI account';
}

function parseEnvJson(text){
  const trimmed = (text || '').trim();
  if (!trimmed) return { env: undefined };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { error: err.message || 'Invalid JSON' };
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    return { error: 'Environment must be a JSON object.' };
  }
  const env = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key || typeof value !== 'string') {
      return { error: 'Environment keys and values must be strings.' };
    }
    env[key] = value;
  }
  return { env };
}

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
function backendIconFor(backends, backendId){
  const b = (backends || []).find(x => x.id === backendId);
  return (b && b.icon) || null;
}
function backendForProfile(backends, profileBackends, profile){
  if (!profile) return null;
  return (profileBackends && profileBackends[profile.id])
    || (backends || []).find(b => b.id === profile.vendor)
    || null;
}
function modelsForProfile(backends, profileBackends, profile){
  const b = backendForProfile(backends, profileBackends, profile);
  return (b && Array.isArray(b.models)) ? b.models : [];
}
function effortLevelsForProfile(backends, profileBackends, profile, modelId){
  const models = modelsForProfile(backends, profileBackends, profile);
  const m = models.find(x => x.id === modelId);
  if (!m || !Array.isArray(m.supportedEffortLevels)) return [];
  return m.supportedEffortLevels;
}
function activeCliProfiles(settings){
  return Array.isArray(settings && settings.cliProfiles)
    ? settings.cliProfiles.filter(p => p && !p.disabled)
    : [];
}
function profileForBackend(profiles, backendId){
  if (!backendId) return null;
  return profiles.find(p => p.id === 'server-configured-' + backendId)
    || profiles.find(p => p.vendor === backendId)
    || null;
}
function profileForSetting(profiles, profileId, backendId, fallbackBackend){
  return (profileId ? profiles.find(p => p.id === profileId) : null)
    || profileForBackend(profiles, backendId)
    || profileForBackend(profiles, fallbackBackend)
    || null;
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

/* Segmented horizontal picker: a row of pill buttons with `aria-pressed` on
   the active one. Accepts `options: [{ id, label }]` and resolves to the
   picked id. */
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

/* Pill toggle switch using the shared `.toggle/.tgl` markup. */
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

function SettingsScreen({ onClose, initialTab }){
  const dialog = useDialog();
  const toast = useToasts();
  const [tab, setTab] = React.useState(() => SETTINGS_TABS.some(t => t.id === initialTab) ? initialTab : 'general');
  const [settings, setSettings] = React.useState(null);
  const [backends, setBackends] = React.useState([]);
  const [profileBackends, setProfileBackends] = React.useState({});
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

  const loadProfileBackend = React.useCallback((profileId) => {
    if (!profileId || profileBackends[profileId]) return;
    AgentApi.getCliProfileMetadata(profileId)
      .then((backend) => {
        if (!backend) return;
        setProfileBackends(prev => ({ ...prev, [profileId]: backend }));
      })
      .catch(() => {});
  }, [profileBackends]);

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
            : tab === 'general' ? <GeneralTab settings={settings} backends={backends} profileBackends={profileBackends} loadProfileBackend={loadProfileBackend} onPatch={patch} onSave={save} saving={saving}/>
            : tab === 'cli'     ? <CliProfilesTab settings={settings} backends={backends} onPatch={patch} onSave={save} saving={saving}/>
            : tab === 'memory'  ? <SettingsMemoryTab settings={settings} backends={backends} profileBackends={profileBackends} loadProfileBackend={loadProfileBackend} onPatch={patch} onSave={save} saving={saving}/>
            : tab === 'kb'      ? <SettingsKbTab settings={settings} backends={backends} profileBackends={profileBackends} loadProfileBackend={loadProfileBackend} onPatch={patch} onSave={save} saving={saving}/>
            : tab === 'security' ? <SecurityTab/>
            : tab === 'usage'   ? <UsageTab/>
            : tab === 'server'  ? <ServerTab/>
            : null}
      </div>
    </div>
  );
}
window.SettingsScreen = SettingsScreen;

/* ──────────────────── General tab ──────────────────── */

function GeneralTab({ settings, backends, profileBackends, loadProfileBackend, onPatch, onSave, saving }){
  const profiles = activeCliProfiles(settings);
  const selectedProfile = profiles.find(p => p.id === settings.defaultCliProfileId)
    || profiles.find(p => p.vendor === settings.defaultBackend)
    || null;
  const backendId = (selectedProfile && selectedProfile.vendor) || settings.defaultBackend || (backends[0] && backends[0].id) || '';
  React.useEffect(() => {
    if (selectedProfile && loadProfileBackend) loadProfileBackend(selectedProfile.id);
  }, [selectedProfile && selectedProfile.id, loadProfileBackend]);
  const models = selectedProfile
    ? modelsForProfile(backends, profileBackends, selectedProfile)
    : modelsForBackend(backends, backendId);
  const modelId = settings.defaultModel || defaultModelId(models) || '';
  const efforts = selectedProfile
    ? effortLevelsForProfile(backends, profileBackends, selectedProfile, modelId)
    : effortLevelsForModel(backends, backendId, modelId);
  const effort = settings.defaultEffort || defaultEffortFor(efforts) || '';

  /* Switching profile/backend resets model + effort to that vendor's defaults
     so we never carry a model id into a backend that doesn't support it. */
  function onProfileChange(v){
    const profile = profiles.find(p => p.id === v);
    if (!profile) return;
    const m = modelsForProfile(backends, profileBackends, profile);
    const newModel = defaultModelId(m);
    const e = effortLevelsForProfile(backends, profileBackends, profile, newModel);
    onPatch({
      defaultCliProfileId: profile.id,
      defaultBackend: profile.vendor,
      defaultModel: newModel,
      defaultEffort: defaultEffortFor(e),
      defaultServiceTier: profile.vendor === 'codex' && settings.defaultServiceTier === 'fast' ? 'fast' : undefined,
    });
  }
  function onBackendChange(v){
    const m = modelsForBackend(backends, v);
    const newModel = defaultModelId(m);
    const e = effortLevelsForModel(backends, v, newModel);
    onPatch({
      defaultCliProfileId: undefined,
      defaultBackend: v,
      defaultModel: newModel,
      defaultEffort: defaultEffortFor(e),
      defaultServiceTier: v === 'codex' && settings.defaultServiceTier === 'fast' ? 'fast' : undefined,
    });
  }
  function onModelChange(v){
    const e = selectedProfile
      ? effortLevelsForProfile(backends, profileBackends, selectedProfile, v)
      : effortLevelsForModel(backends, backendId, v);
    onPatch({ defaultModel: v, defaultEffort: defaultEffortFor(e) });
  }

  return (
    <div className="settings-form settings-form-wide">
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
      {profiles.length ? (
        <Field label="Default CLI profile">
          <select value={selectedProfile ? selectedProfile.id : ''} onChange={(e) => onProfileChange(e.target.value)}>
            {!selectedProfile ? <option value="">Select a profile</option> : null}
            {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      ) : (
        <Field label="Default backend">
          <select value={backendId} onChange={(e) => onBackendChange(e.target.value)}>
            {backends.length === 0 ? <option value="">No backends available</option> : null}
            {backends.map(b => <option key={b.id} value={b.id}>{b.label || b.id}</option>)}
          </select>
        </Field>
      )}
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
      {backendId === 'codex' ? (
        <Field label="Default speed" hint="Fast forces Codex Fast mode for new Codex conversations.">
          <Seg
            value={settings.defaultServiceTier === 'fast' ? 'fast' : 'default'}
            onChange={(v) => onPatch({ defaultServiceTier: v === 'fast' ? 'fast' : undefined })}
            options={[
              { id: 'default', label: 'Default' },
              { id: 'fast', label: 'Fast' },
            ]}
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

/* ──────────────────── CLI Config tab ──────────────────── */

function CliUpdatesPanel(){
  const toast = useToasts();
  const dialog = useDialog();
  const [snapshot, setSnapshot] = React.useState(() => (window.CliUpdateStore && CliUpdateStore.get()) || null);
  const [checking, setChecking] = React.useState(false);
  const [updatingId, setUpdatingId] = React.useState(null);

  React.useEffect(() => {
    if (!window.CliUpdateStore) return undefined;
    const unsub = CliUpdateStore.subscribe(setSnapshot);
    CliUpdateStore.refresh();
    return unsub;
  }, []);

  const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
  const updateCount = items.filter(item => item.updateAvailable).length;

  async function onCheck(anchor){
    setChecking(true);
    try {
      const data = await CliUpdateStore.check();
      setSnapshot(data);
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'CLI update check failed', body: err.message || String(err) });
    } finally {
      setChecking(false);
    }
  }

  async function onUpdate(item, anchor){
    setUpdatingId(item.id);
    try {
      const result = await CliUpdateStore.update(item.id);
      if (result && result.success) {
        toast.success(`${item.label} updated`);
      } else {
        await dialog.alert({ anchor, variant: 'error', title: 'CLI update failed', body: (result && result.error) || 'Update failed' });
      }
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'CLI update failed', body: err.message || String(err) });
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div className="cli-updates-panel">
      <div className="cli-updates-head">
        <div>
          <div className="settings-section-title">CLI updates</div>
          <p className="settings-desc u-dim">
            Detects local CLI versions used by configured profiles. Supported npm-installed CLIs can be updated from the web UI when no conversation is running.
          </p>
        </div>
        <button type="button" className="btn" disabled={checking} onClick={(e) => onCheck(e.currentTarget)}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>
      {items.length === 0 ? (
        <div className="settings-empty u-dim">No CLI update status has been collected yet.</div>
      ) : (
        <div className="cli-update-list">
          {items.map(item => {
            const canRunUpdate = item.updateSupported && (item.updateAvailable || item.installMethod === 'self-update');
            const buttonLabel = item.installMethod === 'self-update' && !item.updateAvailable ? 'Run updater' : 'Update';
            return (
              <div className={`cli-update-row ${item.updateAvailable ? 'has-update' : ''}`} key={item.id}>
                <div className="cli-update-main">
                  <div className="cli-update-title">
                    <b>{item.label}</b>
                    {item.updateAvailable ? <span className="cli-update-badge">Update available</span> : null}
                  </div>
                  <div className="cli-update-meta u-mono">
                    <span>{item.currentVersion || 'unknown'}</span>
                    {item.latestVersion ? <><span>→</span><span>{item.latestVersion}</span></> : null}
                    <span className="sep">·</span>
                    <span>{item.profileNames && item.profileNames.length ? item.profileNames.join(', ') : item.command}</span>
                  </div>
                  {item.lastError ? <div className="cli-update-error">{item.lastError}</div> : null}
                </div>
                <div className="cli-update-side">
                  <span className="cli-update-method">{item.installMethod === 'npm-global' ? 'npm' : item.installMethod === 'self-update' ? 'self-update' : item.installMethod}</span>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!canRunUpdate || updatingId === item.id}
                    onClick={(e) => onUpdate(item, e.currentTarget)}
                    title={!item.updateSupported ? 'This install method cannot be updated from Agent Cockpit' : undefined}
                  >
                    {updatingId === item.id ? 'Updating…' : buttonLabel}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="cli-updates-foot u-dim">
        {updateCount > 0 ? `${updateCount} update${updateCount === 1 ? '' : 's'} available.` : 'No versioned CLI updates available.'}
      </div>
    </div>
  );
}

function CliProfilesTab({ settings, backends, onPatch, onSave, saving }){
  const profiles = Array.isArray(settings.cliProfiles) ? settings.cliProfiles : [];
  const [expandedProfileId, setExpandedProfileId] = React.useState(() => (profiles[0] && profiles[0].id) || null);
  const [envTextById, setEnvTextById] = React.useState({});
  const [envErrorsById, setEnvErrorsById] = React.useState({});
  const [authStateById, setAuthStateById] = React.useState({});
  const [authBusyById, setAuthBusyById] = React.useState({});
  const mountedRef = React.useRef(true);
  const hasEnvErrors = Object.values(envErrorsById).some(Boolean);
  const enabledCount = profiles.filter(profile => profile && !profile.disabled).length;

  React.useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  React.useEffect(() => {
    setEnvTextById(prev => {
      const next = {};
      for (const profile of profiles) {
        next[profile.id] = prev[profile.id] !== undefined
          ? prev[profile.id]
          : profile.env ? JSON.stringify(profile.env, null, 2) : '';
      }
      return next;
    });
    setEnvErrorsById(prev => {
      const next = {};
      for (const profile of profiles) {
        if (prev[profile.id]) next[profile.id] = prev[profile.id];
      }
      return next;
    });
  }, [profiles.map(p => p.id).join('|')]);

  React.useEffect(() => {
    setExpandedProfileId(current => {
      if (profiles.length === 0) return null;
      if (current && profiles.some(profile => profile.id === current)) return current;
      return profiles[0].id;
    });
  }, [profiles.map(p => p.id).join('|')]);

  function patchProfile(id, updater){
    onPatch(prev => {
      const list = Array.isArray(prev.cliProfiles) ? prev.cliProfiles : [];
      let changedProfile = null;
      const nextProfiles = list.map(profile => {
        if (profile.id !== id) return profile;
        const patch = typeof updater === 'function' ? updater(profile) : updater;
        changedProfile = normalizeUiProfile({
          ...profile,
          ...patch,
          updatedAt: new Date().toISOString(),
        });
        return changedProfile;
      });
      const next = { cliProfiles: nextProfiles };
      if (prev.defaultCliProfileId === id && changedProfile) {
        next.defaultBackend = changedProfile.vendor;
        if (changedProfile.disabled) next.defaultCliProfileId = undefined;
      }
      return next;
    });
  }

  function addProfile(){
    const now = new Date().toISOString();
    const vendor = 'claude-code';
    const id = `profile-${vendor}-${Date.now().toString(36)}`;
    const profile = {
      id,
      name: `${cliVendorLabel(vendor)} Profile`,
      vendor,
      authMode: 'server-configured',
      createdAt: now,
      updatedAt: now,
    };
    onPatch(prev => ({
      cliProfiles: [...(Array.isArray(prev.cliProfiles) ? prev.cliProfiles : []), profile],
    }));
    setExpandedProfileId(id);
  }

  function deleteProfile(id){
    onPatch(prev => {
      const next = {
        cliProfiles: (Array.isArray(prev.cliProfiles) ? prev.cliProfiles : []).filter(profile => profile.id !== id),
      };
      if (prev.defaultCliProfileId === id) next.defaultCliProfileId = undefined;
      return next;
    });
  }

  function toggleExpanded(id){
    setExpandedProfileId(current => current === id ? null : id);
  }

  function onCardHeadKeyDown(event, id){
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleExpanded(id);
  }

  function onVendorChange(profile, vendor){
    setEnvErrorsById(prev => ({ ...prev, [profile.id]: '' }));
    if (vendor === 'kiro') {
      setEnvTextById(prev => ({ ...prev, [profile.id]: '' }));
    }
    patchProfile(profile.id, current => {
      const next = {
        vendor,
        authMode: vendor === 'kiro' ? 'server-configured' : current.authMode,
      };
      if (vendor === 'kiro') {
        next.command = undefined;
        next.configDir = undefined;
        next.env = undefined;
      }
      return next;
    });
  }

  function onSetupModeChange(profile, authMode){
    if (authMode === 'server-configured') {
      setEnvTextById(prev => ({ ...prev, [profile.id]: '' }));
      setEnvErrorsById(prev => ({ ...prev, [profile.id]: '' }));
      patchProfile(profile.id, { authMode, configDir: undefined, env: undefined });
    } else {
      patchProfile(profile.id, { authMode });
    }
  }

  function onEnvChange(profile, text){
    setEnvTextById(prev => ({ ...prev, [profile.id]: text }));
    const parsed = parseEnvJson(text);
    setEnvErrorsById(prev => ({ ...prev, [profile.id]: parsed.error || '' }));
    if (!parsed.error) {
      patchProfile(profile.id, { env: parsed.env });
    }
  }

  function mergeSettingsFromAuthResponse(response){
    if (response && response.settings) onPatch(response.settings);
  }

  function setProfileAuthState(profileId, patch){
    if (!mountedRef.current) return;
    setAuthStateById(prev => ({ ...prev, [profileId]: patch }));
  }

  function setProfileAuthBusy(profileId, busy){
    if (!mountedRef.current) return;
    setAuthBusyById(prev => ({ ...prev, [profileId]: busy }));
  }

  async function checkProfileAuth(profile){
    if (hasEnvErrors || saving || authBusyById[profile.id]) return;
    setProfileAuthBusy(profile.id, true);
    setProfileAuthState(profile.id, { kind: 'check', status: 'running', message: 'Checking CLI status…' });
    try {
      await onSave(null);
      const response = await AgentApi.settings.testCliProfile(profile.id);
      mergeSettingsFromAuthResponse(response);
      setProfileAuthState(profile.id, { kind: 'check', status: response.result.status, result: response.result });
    } catch (err) {
      setProfileAuthState(profile.id, { kind: 'check', status: 'error', error: err.message || String(err) });
    } finally {
      setProfileAuthBusy(profile.id, false);
    }
  }

  async function startProfileAuth(profile){
    if (hasEnvErrors || saving || authBusyById[profile.id]) return;
    setProfileAuthBusy(profile.id, true);
    setProfileAuthState(profile.id, { kind: 'job', status: 'running', message: 'Starting authentication…' });
    try {
      await onSave(null);
      const response = await AgentApi.settings.startCliProfileAuth(profile.id);
      mergeSettingsFromAuthResponse(response);
      setProfileAuthState(profile.id, { kind: 'job', status: response.job.status, job: response.job });
      pollProfileAuthJob(profile.id, response.job.id);
    } catch (err) {
      setProfileAuthState(profile.id, { kind: 'job', status: 'error', error: err.message || String(err) });
    } finally {
      setProfileAuthBusy(profile.id, false);
    }
  }

  async function pollProfileAuthJob(profileId, jobId){
    try {
      const response = await AgentApi.settings.getCliProfileAuthJob(jobId);
      const job = response.job;
      setProfileAuthState(profileId, { kind: 'job', status: job.status, job });
      if (job.status === 'running' && mountedRef.current) {
        window.setTimeout(() => pollProfileAuthJob(profileId, jobId), 1000);
      }
    } catch (err) {
      setProfileAuthState(profileId, { kind: 'job', status: 'error', error: err.message || String(err) });
    }
  }

  async function cancelProfileAuth(profile){
    const state = authStateById[profile.id];
    const jobId = state && state.job && state.job.id;
    if (!jobId) return;
    setProfileAuthBusy(profile.id, true);
    try {
      const response = await AgentApi.settings.cancelCliProfileAuth(jobId);
      setProfileAuthState(profile.id, { kind: 'job', status: response.job.status, job: response.job });
    } catch (err) {
      setProfileAuthState(profile.id, { kind: 'job', status: 'error', error: err.message || String(err) });
    } finally {
      setProfileAuthBusy(profile.id, false);
    }
  }

  function authStateLabel(state){
    if (!state) return 'not checked';
    if (state.message) return state.message;
    if (state.error) return 'error';
    if (state.kind === 'check' && state.result) {
      if (state.result.authenticated === true) return 'authenticated';
      if (state.result.status === 'not-authenticated') return 'not authenticated';
      return state.result.status || 'checked';
    }
    if (state.job) return state.job.status;
    return state.status || 'unknown';
  }

  function authStateText(state){
    if (!state) return '';
    if (state.error) return state.error;
    if (state.result) {
      return [state.result.error, state.result.output].filter(Boolean).join('\n').trim();
    }
    if (state.job) {
      return (state.job.events || [])
        .map(event => `[${event.type}] ${event.text}`)
        .join('\n')
        .trim();
    }
    return state.message || '';
  }

  return (
    <div className="settings-form settings-form-wide">
      <div className="cli-pane-head">
        <div>
          <h3 className="pane-title">CLI config profiles</h3>
          <p className="cli-blurb">
            Profiles are named CLI runtimes used by new conversations. <b>Self-configured</b> profiles use CLI state already present on this server; <b>account profiles</b> use the directory and environment you provide here.
          </p>
        </div>
        <div className="cli-counter u-mono">
          <span><b>{enabledCount}</b> enabled</span>
          <span className="sep">·</span>
          <span><b>{profiles.length}</b> total</span>
        </div>
      </div>

      <CliUpdatesPanel/>

      <div className="cli-list">
        {profiles.length === 0 ? (
          <div className="settings-empty u-dim">No CLI profiles are configured yet.</div>
        ) : profiles.map(profile => {
          const isKiro = profile.vendor === 'kiro';
          const isServerProfile = isServerConfiguredProfile(profile);
          const isAccount = !isKiro && profile.authMode === 'account';
          const vendorIcon = backendIconFor(backends, profile.vendor);
          const expanded = expandedProfileId === profile.id;
          const setupLabel = isAccount ? 'Account profile' : 'Self-configured';
          const envError = envErrorsById[profile.id];
          const authState = authStateById[profile.id];
          const authBusy = !!authBusyById[profile.id];
          const authRunning = !!(authState && authState.job && authState.job.status === 'running');
          const authText = authStateText(authState);
          return (
            <div className={`cli-card ${expanded ? 'is-open' : ''} ${profile.disabled ? 'is-off' : ''}`} key={profile.id}>
              <div
                className="cli-card-head"
                role="button"
                tabIndex={0}
                aria-expanded={expanded ? 'true' : 'false'}
                onClick={() => toggleExpanded(profile.id)}
                onKeyDown={(e) => onCardHeadKeyDown(e, profile.id)}
              >
                <div className="cli-card-head-main">
                  <div className="cli-card-name">
                    <span className="chev" data-open={expanded ? 'true' : 'false'}>{Ico.chev(12)}</span>
                    {vendorIcon ? <span className="cli-vendor-icon" aria-hidden="true" dangerouslySetInnerHTML={{__html: vendorIcon}}/> : null}
                    <b>{profile.name || profile.id}</b>
                  </div>
                  <div className="cli-card-meta u-mono">
                    <span>{cliVendorLabel(profile.vendor)}</span>
                    <span className="sep">·</span>
                    <span>{setupLabel}</span>
                    {profile.command ? (
                      <>
                        <span className="sep">·</span>
                        <code>{profile.command}</code>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="cli-card-head-side" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={!profile.disabled}
                      onChange={(e) => patchProfile(profile.id, { disabled: !e.target.checked })}
                    />
                    <span className="tgl"/>
                    <span className="tgl-lbl">{profile.disabled ? 'Disabled' : 'Enabled'}</span>
                  </label>
                  <button
                    type="button"
                    className="iconbtn-lg cli-del"
                    title={isServerProfile ? 'Server-configured profiles cannot be deleted' : 'Delete profile'}
                    disabled={isServerProfile}
                    onClick={() => deleteProfile(profile.id)}
                  >
                    {Ico.trash(13)}
                  </button>
                </div>
              </div>

              {expanded ? (
                <div className="cli-card-body">
                  <div className="cli-profile-grid">
                    <Field label="Name">
                      <input
                        className="inp"
                        value={profile.name || ''}
                        onChange={(e) => patchProfile(profile.id, { name: e.target.value })}
                      />
                    </Field>
                    <Field label="Vendor">
                      <div className="settings-select-wrap">
                        <select
                          value={profile.vendor}
                          disabled={isServerProfile}
                          onChange={(e) => onVendorChange(profile, e.target.value)}
                        >
                          {CLI_VENDOR_OPTIONS.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                        </select>
                        {Ico.chevD(12)}
                      </div>
                    </Field>
                  </div>
                  <div className="cli-profile-grid">
                    <Field label="Setup mode" hint={isKiro ? 'Kiro is self-configured only for now.' : undefined}>
                      <div className="settings-select-wrap">
                        <select
                          value={isKiro ? 'server-configured' : (profile.authMode || 'server-configured')}
                          disabled={isKiro}
                          onChange={(e) => onSetupModeChange(profile, e.target.value)}
                        >
                          <option value="server-configured">Self-configured</option>
                          <option value="account">Account profile</option>
                        </select>
                        {Ico.chevD(12)}
                      </div>
                    </Field>
                    {!isKiro ? (
                      <Field label="Command" hint="Optional executable override. Leave blank for the vendor default.">
                        <input
                          className="inp u-mono"
                          value={profile.command || ''}
                          placeholder={cliDefaultCommand(profile.vendor)}
                          onChange={(e) => patchProfile(profile.id, { command: e.target.value || undefined })}
                        />
                      </Field>
                    ) : null}
                  </div>

                  {isAccount ? (
                    <>
                      <Field label="Config directory" hint={profile.vendor === 'codex' ? 'Maps to CODEX_HOME at runtime.' : 'Maps to CLAUDE_CONFIG_DIR at runtime.'}>
                        <input
                          className="inp u-mono"
                          value={profile.configDir || ''}
                          placeholder={profile.vendor === 'codex' ? '/Users/server/.codex-account' : '/Users/server/.claude-account'}
                          onChange={(e) => patchProfile(profile.id, { configDir: e.target.value || undefined })}
                        />
                      </Field>
                      <Field label="Environment overrides" hint="Optional JSON object. Values must be strings.">
                        <textarea
                          className="ta"
                          rows={5}
                          value={envTextById[profile.id] || ''}
                          placeholder={'{\n  "EXAMPLE": "value"\n}'}
                          onChange={(e) => onEnvChange(profile, e.target.value)}
                        />
                        {envError ? <span className="settings-field-hint u-err">{envError}</span> : null}
                      </Field>
                      <div className="cli-auth-box">
                        <div className="cli-auth-head">
                          <div>
                            <b>Account authentication</b>
                            <span className="u-dim">Runs the vendor login flow on the server with this profile's config directory.</span>
                          </div>
                          <span className={`cli-auth-status ${authRunning ? 'running' : ''}`}>{authStateLabel(authState)}</span>
                        </div>
                        <div className="cli-auth-actions">
                          <button
                            type="button"
                            className="btn"
                            disabled={saving || hasEnvErrors || authBusy || authRunning}
                            onClick={() => checkProfileAuth(profile)}
                          >Check CLI</button>
                          <button
                            type="button"
                            className="btn primary"
                            disabled={saving || hasEnvErrors || authBusy || authRunning}
                            onClick={() => startProfileAuth(profile)}
                          >Authenticate</button>
                          {authRunning ? (
                            <button
                              type="button"
                              className="btn ghost"
                              disabled={authBusy}
                              onClick={() => cancelProfileAuth(profile)}
                            >Cancel</button>
                          ) : null}
                        </div>
                        {authText ? <pre className="cli-auth-log">{authText}</pre> : null}
                      </div>
                    </>
                  ) : (
                    <div className="cli-self-note">
                      <span className="dot-ok"/>
                      <div>
                        <b>Uses CLI state already on this server.</b>
                        <div className="u-dim" style={{fontSize: 12, marginTop: 2}}>
                          {isKiro ? (
                            <>Configure Kiro on the server and use this self-configured profile. Kiro does not expose a dedicated account/config directory override yet.</>
                          ) : (
                            <>Self-configured profiles inherit the host's existing <code>{cliSelfConfiguredHome(profile.vendor)}</code> directory and shell environment. No directory or env overrides needed.</>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}

        <button type="button" className="cli-add" onClick={addProfile}>
          {Ico.plus(14)}
          <span>Add CLI profile</span>
          <span className="u-mono u-dim cli-add-hint">name · vendor · setup mode</span>
        </button>
      </div>

      <div className="pane-foot">
        <span className="u-dim u-mono" style={{fontSize:11}}>stored in global settings</span>
        <span style={{flex:1}}/>
        <button className="btn primary" disabled={saving || hasEnvErrors} onClick={(e) => onSave(e.currentTarget)}>{saving ? 'Saving…' : 'Save'}</button>
        {hasEnvErrors ? <span className="settings-field-hint u-err">Fix environment JSON before saving.</span> : null}
      </div>
    </div>
  );
}

/* ──────────────────── Memory tab ──────────────────── */

function SettingsMemoryTab({ settings, backends, profileBackends, loadProfileBackend, onPatch, onSave, saving }){
  const mem = settings.memory || {};
  const profiles = activeCliProfiles(settings);
  const fallbackBackend = settings.defaultBackend || (backends[0] && backends[0].id) || '';
  const selectedProfile = profiles.find(p => p.id === mem.cliProfileId)
    || profileForBackend(profiles, mem.cliBackend)
    || profiles.find(p => p.id === settings.defaultCliProfileId)
    || profileForBackend(profiles, fallbackBackend)
    || null;
  React.useEffect(() => {
    if (selectedProfile && loadProfileBackend) loadProfileBackend(selectedProfile.id);
  }, [selectedProfile && selectedProfile.id, loadProfileBackend]);
  const models = selectedProfile
    ? modelsForProfile(backends, profileBackends, selectedProfile)
    : modelsForBackend(backends, fallbackBackend);
  const modelId = mem.cliModel || defaultModelId(models) || '';
  const efforts = selectedProfile
    ? effortLevelsForProfile(backends, profileBackends, selectedProfile, modelId)
    : effortLevelsForModel(backends, fallbackBackend, modelId);
  const effort = mem.cliEffort || defaultEffortFor(efforts) || '';

  function patchMem(next){
    onPatch(prev => ({ memory: { ...(prev.memory || {}), ...next } }));
  }
  function onProfileChange(v){
    const profile = profiles.find(p => p.id === v);
    if (!profile) return;
    const m = modelsForProfile(backends, profileBackends, profile);
    const newModel = defaultModelId(m);
    const e = effortLevelsForProfile(backends, profileBackends, profile, newModel);
    patchMem({
      cliProfileId: profile.id,
      cliBackend: profile.vendor,
      cliModel: newModel,
      cliEffort: defaultEffortFor(e),
    });
  }
  function onModelChange(v){
    const e = selectedProfile
      ? effortLevelsForProfile(backends, profileBackends, selectedProfile, v)
      : effortLevelsForModel(backends, fallbackBackend, v);
    patchMem({ cliModel: v, cliEffort: defaultEffortFor(e) });
  }

  return (
    <div className="settings-form settings-form-wide">
      <p className="settings-desc u-dim">
        CLI profile used by the workspace memory helper when formatting and deduping captured notes.
        Falls back to the default profile when unset.
      </p>
      <Field label="Memory CLI profile">
        <select value={selectedProfile ? selectedProfile.id : ''} onChange={(e) => onProfileChange(e.target.value)}>
          {profiles.length === 0 ? <option value="">No CLI profiles available</option> : null}
          {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
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

function SettingsKbTab({ settings, backends, profileBackends, loadProfileBackend, onPatch, onSave, saving }){
  const kb = settings.knowledgeBase || {};
  const profiles = activeCliProfiles(settings);
  const fallbackBackend = settings.defaultBackend || (backends[0] && backends[0].id) || '';

  // Ingestion picks (vision-capable CLI for AI-assisted page/slide/image conversion)
  const igProfile = (kb.ingestionCliProfileId || kb.ingestionCliBackend)
    ? profileForSetting(profiles, kb.ingestionCliProfileId, kb.ingestionCliBackend, '')
    : null;
  const igModels = igProfile ? modelsForProfile(backends, profileBackends, igProfile) : [];
  const igModel = kb.ingestionCliModel || defaultModelId(igModels) || '';
  const igEfforts = igProfile ? effortLevelsForProfile(backends, profileBackends, igProfile, igModel) : [];
  const igEffort = kb.ingestionCliEffort || defaultEffortFor(igEfforts) || '';

  // Digestion picks
  const dgProfile = profileForSetting(profiles, kb.digestionCliProfileId, kb.digestionCliBackend, fallbackBackend);
  const dgModels = dgProfile
    ? modelsForProfile(backends, profileBackends, dgProfile)
    : modelsForBackend(backends, fallbackBackend);
  const dgModel = kb.digestionCliModel || defaultModelId(dgModels) || '';
  const dgEfforts = dgProfile
    ? effortLevelsForProfile(backends, profileBackends, dgProfile, dgModel)
    : effortLevelsForModel(backends, fallbackBackend, dgModel);
  const dgEffort = kb.digestionCliEffort || defaultEffortFor(dgEfforts) || '';

  // Dreaming picks
  const drProfile = profileForSetting(profiles, kb.dreamingCliProfileId, kb.dreamingCliBackend, fallbackBackend);
  const drModels = drProfile
    ? modelsForProfile(backends, profileBackends, drProfile)
    : modelsForBackend(backends, fallbackBackend);
  const drModel = kb.dreamingCliModel || defaultModelId(drModels) || '';
  const drEfforts = drProfile
    ? effortLevelsForProfile(backends, profileBackends, drProfile, drModel)
    : effortLevelsForModel(backends, fallbackBackend, drModel);
  const drEffort = kb.dreamingCliEffort || defaultEffortFor(drEfforts) || '';

  const concurrency = Number.isFinite(kb.cliConcurrency) ? kb.cliConcurrency : 2;
  const convertSlides = !!kb.convertSlidesToImages;
  const gleaningEnabled = !!kb.kbGleaningEnabled;

  const [pandoc, setPandoc] = React.useState(null);
  const [libreOffice, setLibreOffice] = React.useState(null);
  const [convertWarning, setConvertWarning] = React.useState(null);

  React.useEffect(() => {
    AgentApi.kb.pandocStatus().then(setPandoc).catch(() => setPandoc({ available: false }));
    AgentApi.kb.libreOfficeStatus().then(setLibreOffice).catch(() => setLibreOffice({ available: false }));
  }, []);
  React.useEffect(() => {
    [igProfile, dgProfile, drProfile].forEach(profile => {
      if (profile && loadProfileBackend) loadProfileBackend(profile.id);
    });
  }, [igProfile && igProfile.id, dgProfile && dgProfile.id, drProfile && drProfile.id, loadProfileBackend]);

  function patchKb(next){
    onPatch(prev => ({ knowledgeBase: { ...(prev.knowledgeBase || {}), ...next } }));
  }
  function onIgProfile(v){
    if (!v) {
      patchKb({
        ingestionCliProfileId: undefined,
        ingestionCliBackend: undefined,
        ingestionCliModel: undefined,
        ingestionCliEffort: undefined,
      });
      return;
    }
    const profile = profiles.find(p => p.id === v);
    if (!profile) return;
    const m = modelsForProfile(backends, profileBackends, profile);
    const newModel = defaultModelId(m);
    const e = effortLevelsForProfile(backends, profileBackends, profile, newModel);
    patchKb({ ingestionCliProfileId: profile.id, ingestionCliBackend: profile.vendor, ingestionCliModel: newModel, ingestionCliEffort: defaultEffortFor(e) });
  }
  function onIgModel(v){
    const e = igProfile ? effortLevelsForProfile(backends, profileBackends, igProfile, v) : [];
    patchKb({ ingestionCliModel: v, ingestionCliEffort: defaultEffortFor(e) });
  }
  function onDgProfile(v){
    const profile = profiles.find(p => p.id === v);
    if (!profile) return;
    const m = modelsForProfile(backends, profileBackends, profile);
    const newModel = defaultModelId(m);
    const e = effortLevelsForProfile(backends, profileBackends, profile, newModel);
    patchKb({ digestionCliProfileId: profile.id, digestionCliBackend: profile.vendor, digestionCliModel: newModel, digestionCliEffort: defaultEffortFor(e) });
  }
  function onDgModel(v){
    const e = dgProfile ? effortLevelsForProfile(backends, profileBackends, dgProfile, v) : effortLevelsForModel(backends, fallbackBackend, v);
    patchKb({ digestionCliModel: v, digestionCliEffort: defaultEffortFor(e) });
  }
  function onDrProfile(v){
    const profile = profiles.find(p => p.id === v);
    if (!profile) return;
    const m = modelsForProfile(backends, profileBackends, profile);
    const newModel = defaultModelId(m);
    const e = effortLevelsForProfile(backends, profileBackends, profile, newModel);
    patchKb({ dreamingCliProfileId: profile.id, dreamingCliBackend: profile.vendor, dreamingCliModel: newModel, dreamingCliEffort: defaultEffortFor(e) });
  }
  function onDrModel(v){
    const e = drProfile ? effortLevelsForProfile(backends, profileBackends, drProfile, v) : effortLevelsForModel(backends, fallbackBackend, v);
    patchKb({ dreamingCliModel: v, dreamingCliEffort: defaultEffortFor(e) });
  }
  function onConcurrency(v){
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return;
    patchKb({ cliConcurrency: Math.max(1, Math.min(10, n)) });
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
    <div className="settings-form settings-form-wide">
      <p className="settings-desc u-dim">
        Per-CLI defaults for the ingestion, digestion, and dreaming pipelines. Embedding
        configuration lives on each workspace's KB Settings tab.
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

      <div className="settings-section-title">Ingestion</div>
      <p className="settings-desc u-dim">
        Optional vision-capable CLI used at ingest time to convert PDF pages with
        figures/tables, embedded DOCX images, PPTX slides with charts, and standalone
        uploaded images into clean Markdown. Leave blank to skip AI-assisted conversion;
        flagged content falls back to image-only references.
      </p>
      <Field label="Ingestion CLI profile">
        <select value={igProfile ? igProfile.id : ''} onChange={(e) => onIgProfile(e.target.value)}>
          <option value="">— None (skip AI conversion) —</option>
          {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      {igProfile && igModels.length ? (
        <Field label="Ingestion model">
          <select value={igModel} onChange={(e) => onIgModel(e.target.value)}>
            {igModels.map(m => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
          </select>
        </Field>
      ) : null}
      {igProfile && igEfforts.length ? (
        <Field label="Ingestion effort">
          <Seg
            value={igEffort}
            onChange={(v) => patchKb({ ingestionCliEffort: v })}
            options={igEfforts.map(lv => ({ id: lv, label: lv }))}
          />
        </Field>
      ) : null}

      <div className="settings-section-title">Digestion</div>
      <Field label="Digestion CLI profile">
        <select value={dgProfile ? dgProfile.id : ''} onChange={(e) => onDgProfile(e.target.value)}>
          {profiles.length === 0 ? <option value="">No CLI profiles available</option> : null}
          {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
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
      <Field label="Dreaming CLI profile">
        <select value={drProfile ? drProfile.id : ''} onChange={(e) => onDrProfile(e.target.value)}>
          {profiles.length === 0 ? <option value="">No CLI profiles available</option> : null}
          {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
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

      <div className="settings-section-title">Pipeline</div>
      <Field
        label="CLI concurrency"
        hint="Documents processed in parallel by ingestion, digestion, and dreaming CLIs (1–10). Within a document, work stays sequential."
      >
        <input
          type="number"
          min={1}
          max={10}
          value={concurrency}
          onChange={(e) => onConcurrency(e.target.value)}
        />
      </Field>
      <Toggle
        checked={gleaningEnabled}
        onChange={(checked) => patchKb({ kbGleaningEnabled: checked })}
        label="Run a second digestion pass for missed entries"
      />

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

/* ──────────────────── Security tab ──────────────────── */

function fmtDateTime(value){
  if (!value) return 'Never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function recoveryCodeText(codes){
  return (codes || []).join('\n');
}

async function copySecurityText(text, toast, label){
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.success((label || 'Value') + ' copied');
  } catch (err) {
    toast.error('Copy failed');
  }
}

function webAuthnAvailable(){
  return !!(window.PublicKeyCredential && navigator.credentials);
}

function base64urlToBuffer(value){
  const padded = value + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64url(buffer){
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodePasskeyRegistrationOptions(options){
  const next = { ...options };
  next.challenge = base64urlToBuffer(next.challenge);
  next.user = { ...next.user, id: base64urlToBuffer(next.user.id) };
  next.excludeCredentials = (next.excludeCredentials || []).map(credential => ({
    ...credential,
    id: base64urlToBuffer(credential.id),
  }));
  return next;
}

function encodePasskeyRegistrationCredential(credential){
  const response = credential.response;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      attestationObject: bufferToBase64url(response.attestationObject),
      transports: response.getTransports ? response.getTransports() : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

function SecurityTab(){
  const dialog = useDialog();
  const toast = useToasts();
  const [status, setStatus] = React.useState(null);
  const [passkeys, setPasskeys] = React.useState([]);
  const [recoveryCodes, setRecoveryCodes] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState('');

  React.useEffect(() => { reload(); }, []);

  async function reload(){
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextPasskeys] = await Promise.all([
        AgentApi.auth.status(),
        AgentApi.auth.listPasskeys(),
      ]);
      setStatus(nextStatus || {});
      setPasskeys((nextPasskeys && nextPasskeys.passkeys) || []);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function regenerateRecoveryCodes(anchor){
    const ok = await dialog.confirm({
      anchor,
      destructive: true,
      title: 'Regenerate recovery codes?',
      body: 'Existing recovery codes will stop working. Store the new codes before leaving this screen.',
      confirmLabel: 'Regenerate',
    });
    if (!ok) return;
    setBusy('recovery');
    try {
      const res = await AgentApi.auth.regenerateRecoveryCodes();
      setRecoveryCodes((res && res.recoveryCodes) || []);
      if (res && res.recovery) {
        setStatus(prev => ({ ...(prev || {}), recovery: res.recovery }));
      }
      toast.success('Recovery codes regenerated');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Regenerate failed', body: err.message || String(err) });
    } finally {
      setBusy('');
    }
  }

  async function updatePasskeyPolicy(required, anchor){
    if (required) {
      const ok = await dialog.confirm({
        anchor,
        title: 'Require passkeys?',
        body: 'Password login will be blocked until recovery login disables this policy.',
        confirmLabel: 'Require passkeys',
      });
      if (!ok) return;
    }
    setBusy('policy');
    try {
      const res = await AgentApi.auth.updatePolicy({ passkeyRequired: !!required });
      if (res && res.policy) {
        setStatus(prev => ({ ...(prev || {}), policy: res.policy }));
      }
      toast.success(required ? 'Passkey requirement enabled' : 'Passkey requirement disabled');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Policy update failed', body: err.message || String(err) });
    } finally {
      setBusy('');
    }
  }

  function updatePasskeyState(nextPasskeys){
    setPasskeys(nextPasskeys || []);
    setStatus(prev => ({
      ...(prev || {}),
      passkeys: { registered: (nextPasskeys || []).length },
    }));
  }

  async function addPasskey(anchor){
    if (!webAuthnAvailable()) {
      await dialog.alert({
        anchor,
        variant: 'error',
        title: 'Passkeys unavailable',
        body: 'This browser does not expose WebAuthn passkey APIs.',
      });
      return;
    }
    const rawName = await dialog.prompt({
      anchor,
      title: 'Name this passkey',
      inputLabel: 'Passkey name',
      inputDefault: 'This device',
      confirmLabel: 'Continue',
    });
    const name = (rawName || '').trim();
    if (!name) return;
    setBusy('passkey');
    try {
      const options = await AgentApi.auth.startPasskeyRegistration(name);
      const credential = await navigator.credentials.create({
        publicKey: decodePasskeyRegistrationOptions(options),
      });
      if (!credential) throw new Error('Passkey registration was cancelled.');
      const res = await AgentApi.auth.verifyPasskeyRegistration(
        name,
        encodePasskeyRegistrationCredential(credential),
      );
      updatePasskeyState((res && res.passkeys) || []);
      toast.success('Passkey registered');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Passkey registration failed', body: err.message || String(err) });
    } finally {
      setBusy('');
    }
  }

  async function renamePasskey(passkey, anchor){
    const rawName = await dialog.prompt({
      anchor,
      title: 'Rename passkey',
      inputLabel: 'Passkey name',
      inputDefault: passkey.name || '',
      confirmLabel: 'Rename',
    });
    const name = (rawName || '').trim();
    if (!name || name === passkey.name) return;
    setBusy('passkey:' + passkey.id);
    try {
      const res = await AgentApi.auth.renamePasskey(passkey.id, name);
      updatePasskeyState((res && res.passkeys) || []);
      toast.success('Passkey renamed');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Rename failed', body: err.message || String(err) });
    } finally {
      setBusy('');
    }
  }

  async function deletePasskey(passkey, anchor){
    const ok = await dialog.confirm({
      anchor,
      destructive: true,
      title: 'Delete this passkey?',
      body: `${passkey.name || 'This passkey'} will no longer sign in to this backend.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setBusy('passkey:' + passkey.id);
    try {
      const res = await AgentApi.auth.deletePasskey(passkey.id);
      updatePasskeyState((res && res.passkeys) || []);
      toast.success('Passkey deleted');
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Delete failed', body: err.message || String(err) });
    } finally {
      setBusy('');
    }
  }

  if (loading) return <div className="u-dim" style={{padding:'16px'}}>Loading...</div>;
  if (error) return <div className="u-err" style={{padding:'16px'}}>{error}</div>;

  const providers = (status && status.providers) || {};
  const recovery = (status && status.recovery) || {};
  const policy = (status && status.policy) || {};
  const passkeyAvailable = providers.passkey === true;
  const passkeyCount = passkeys.length || ((status && status.passkeys && status.passkeys.registered) || 0);
  const passkeyRequired = !!policy.passkeyRequired;
  const canEnablePasskeyRequired = passkeyAvailable && passkeyCount > 0 && (recovery.remaining || 0) > 0;
  const disablePolicyToggle = busy === 'policy' || (!passkeyRequired && !canEnablePasskeyRequired);
  const recoveryText = recoveryCodeText(recoveryCodes);

  return (
    <div className="settings-security settings-form-wide">
      <div className="pane-block">
        <div className="pane-block-head">
          <span>Owner login</span>
        </div>
        <div className="security-panel">
          <div className="security-kv">
            <div>
              <div className="lbl">Password login</div>
              <div className="val">{providers.password ? 'Enabled' : 'Disabled'}</div>
            </div>
            <div>
              <div className="lbl">Passkeys</div>
              <div className="val">{passkeyAvailable ? `${passkeyCount} registered` : 'Unavailable'}</div>
            </div>
            <div>
              <div className="lbl">Legacy OAuth</div>
              <div className="val">{providers.legacyOAuth ? 'Enabled' : 'Disabled'}</div>
            </div>
          </div>
          <div className="security-policy-row">
            <label className={`toggle ${disablePolicyToggle ? 'disabled' : ''}`}>
              <input
                type="checkbox"
                checked={passkeyRequired}
                disabled={disablePolicyToggle}
                onChange={(e) => updatePasskeyPolicy(e.target.checked, e.currentTarget)}
              />
              <span className="tgl"/>
              <span>Require passkey for login</span>
            </label>
            {!canEnablePasskeyRequired && !passkeyRequired ? (
              <span className="u-dim">Register a passkey and keep at least one recovery code before requiring passkeys.</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="pane-block">
        <div className="pane-block-head">
          <span>Passkeys</span>
          <span className="spacer"/>
          <button
            type="button"
            className="btn ghost"
            disabled={busy === 'passkey'}
            onClick={(e) => addPasskey(e.currentTarget)}
          >{busy === 'passkey' ? 'Registering...' : 'Add passkey'}</button>
        </div>
        {passkeys.length === 0 ? (
          <div className="security-panel u-dim">No passkeys have been registered.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Transports</th>
                <th className="r">Actions</th>
              </tr>
            </thead>
            <tbody>
              {passkeys.map(passkey => (
                <tr key={passkey.id}>
                  <td>{passkey.name || 'Passkey'}</td>
                  <td>{fmtDateTime(passkey.createdAt)}</td>
                  <td>{fmtDateTime(passkey.lastUsedAt)}</td>
                  <td>{(passkey.transports || []).join(', ') || '-'}</td>
                  <td className="r">
                    <span className="security-row-actions">
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={busy === 'passkey:' + passkey.id}
                        onClick={(e) => renamePasskey(passkey, e.currentTarget)}
                      >Rename</button>
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={busy === 'passkey:' + passkey.id}
                        onClick={(e) => deletePasskey(passkey, e.currentTarget)}
                      >Delete</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="pane-block">
        <div className="pane-block-head">
          <span>Recovery codes</span>
          <span className="spacer"/>
          <button
            type="button"
            className="btn ghost"
            disabled={busy === 'recovery'}
            onClick={(e) => regenerateRecoveryCodes(e.currentTarget)}
          >{busy === 'recovery' ? 'Regenerating...' : 'Regenerate'}</button>
        </div>
        <div className="security-panel">
          <div className="security-kv">
            <div>
              <div className="lbl">Status</div>
              <div className="val">{recovery.configured ? 'Configured' : 'Not configured'}</div>
            </div>
            <div>
              <div className="lbl">Remaining</div>
              <div className="val">{recovery.remaining || 0} / {recovery.total || 0}</div>
            </div>
            <div>
              <div className="lbl">Created</div>
              <div className="val">{fmtDateTime(recovery.createdAt)}</div>
            </div>
          </div>
          {recoveryCodes.length ? (
            <div className="security-secret-block">
              <div className="security-secret-head">
                <span>New recovery codes</span>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => copySecurityText(recoveryText, toast, 'Recovery codes')}
                >Copy</button>
              </div>
              <textarea className="ta" rows={Math.min(10, Math.max(4, recoveryCodes.length))} readOnly value={recoveryText}/>
            </div>
          ) : null}
        </div>
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

/* Filter the raw `days` list to the selected range. Empty range returns an
   empty array — matches the "no data for this period" UX. */
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
    <div className="settings-form settings-form-wide">
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
