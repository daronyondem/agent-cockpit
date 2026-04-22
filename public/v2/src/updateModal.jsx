/* global React, Ico, AgentApi */

/* ---------- UpdateModal — triggered from the sidebar's update badge. ---------- */
/* Mirrors V1's chatShowUpdateModal / chatTriggerUpdate / chatShowRestartOverlay.
   The server kills its own process mid-request, so a "Failed to fetch" or
   TypeError rejection is treated as a success signal: we flip to the restart
   overlay and reload after a short delay. */
function UpdateModal({ open, localVersion, remoteVersion, onClose, onRestarting }){
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const [steps, setSteps] = React.useState(null);

  React.useEffect(() => {
    if (!open) { setBusy(false); setErr(null); setSteps(null); }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  async function doUpdate(){
    setBusy(true); setErr(null); setSteps(null);
    try {
      const result = await AgentApi.triggerUpdate();
      if (result && result.success) {
        onRestarting();
        return;
      }
      setErr((result && result.error) || 'Update failed');
      setSteps(Array.isArray(result && result.steps) ? result.steps : null);
      setBusy(false);
    } catch (e) {
      /* The update script kills the process — treat fetch rejection as success. */
      const msg = e && e.message ? e.message : '';
      if (msg === 'Failed to fetch' || (e && e.name === 'TypeError')) {
        onRestarting();
        return;
      }
      setErr(msg || 'Update failed');
      setBusy(false);
    }
  }

  return (
    <div className="fp-scrim" onClick={busy ? undefined : onClose}>
      <div className="fp-panel um-panel" role="dialog" aria-modal="true" aria-label="Update available" onClick={(e) => e.stopPropagation()}>
        <div className="fp-head">
          <span className="fp-title">Update available</span>
          <button className="fp-close" type="button" aria-label="Close" title="Close" onClick={onClose} disabled={busy}>{Ico.x(14)}</button>
        </div>

        <div className="um-body">
          <div className="um-row">
            <span className="um-label">Current version</span>
            <span className="um-value">v{localVersion || '?'}</span>
          </div>
          <div className="um-row">
            <span className="um-label">Available version</span>
            <span className="um-value um-value-accent">v{remoteVersion || '?'}</span>
          </div>
          <div className="um-note">
            This will pull the latest code from <code>main</code>, install dependencies,
            and restart the server. The page will reload automatically.
          </div>

          {err ? (
            <div className="um-error">
              <div className="um-error-msg">{err}</div>
              {steps && steps.length ? (
                <ul className="um-steps">
                  {steps.map((s, i) => (
                    <li key={i} className={s.success ? 'ok' : 'bad'}>
                      <span className="um-step-mark">{s.success ? '✓' : '✕'}</span>{s.name}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="fp-foot">
          <div style={{flex:1}}/>
          <button type="button" className="fp-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="fp-btn-primary" onClick={doUpdate} disabled={busy}>
            {busy ? 'Updating…' : (err ? 'Retry update' : 'Update now')}
          </button>
        </div>
      </div>
    </div>
  );
}
window.UpdateModal = UpdateModal;

/* ---------- RestartOverlay — full-screen curtain shown while pm2 cycles. ---------- */
/* Mirrors V1's chatShowRestartOverlay. Auto-reloads at 6s to pick up the
   restarted server. If the server ever fails to come back, the user can
   still hit Cmd-R manually — the overlay is a signal, not a trap. */
function RestartOverlay({ open }){
  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => window.location.reload(), 6000);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;

  return (
    <div className="restart-overlay" role="dialog" aria-modal="true" aria-label="Restarting server">
      <div className="restart-dialog">
        <div className="restart-title">Restarting server…</div>
        <div className="restart-sub">The page will reload automatically.</div>
      </div>
    </div>
  );
}
window.RestartOverlay = RestartOverlay;
