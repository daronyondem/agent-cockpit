import React from 'react';
import { AgentApi } from './api.js';
import './cortexSetup.css';

export function CortexSetup({ onProfileSaved }){
  const [open, setOpen] = React.useState(false);
  const [connections, setConnections] = React.useState([]);
  const [connection, setConnection] = React.useState('');
  const [create, setCreate] = React.useState(false);
  const [draft, setDraft] = React.useState({ name: '', account: '', user: '' });
  const [job, setJob] = React.useState(null);
  const [result, setResult] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [redirect, setRedirect] = React.useState('');
  const running = job?.status === 'running';
  const handoff = running ? job.cortex : null;
  const jobId = running ? job.id : null;
  const mounted = React.useRef(true);
  const acceptJob = React.useCallback(next => setJob(current => current?.id === next.id && current.updatedAt > next.updatedAt ? current : next), []);

  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => {
    if (!jobId) return;
    let alive = true;
    let timer;
    async function poll(){
      try {
        const response = await AgentApi.settings.getCliProfileAuthJob(jobId);
        if (!alive) return;
        acceptJob(response.job);
        if (response.job.status === 'running') timer = window.setTimeout(poll, 1000);
        else setRedirect('');
      } catch (err) { if (alive) setError(err.message || 'Could not read login progress.'); }
    }
    timer = window.setTimeout(poll, 1000);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [jobId, acceptJob]);

  async function act(action){
    setBusy(true); setError(''); setResult('');
    try { await action(); }
    catch (err) { if (mounted.current) setError(err.message || 'Cortex Code setup failed.'); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function refresh(){
    const response = await AgentApi.settings.cortexConnections();
    if (!mounted.current) return;
    setConnections(response.connections);
    setConnection(current => response.connections.some(item => item.name === current) ? current : response.connections[0]?.name || '');
    if (response.job) { acceptJob(response.job); setConnection(response.job.cortex?.connection || ''); }
  }

  async function setup(start){
    const response = await (start ? AgentApi.settings.startSetupCliAuth : AgentApi.settings.testSetupCliAuth)('cortex-code', { connection });
    if (!mounted.current) return;
    onProfileSaved?.(response.profile);
    if (response.job) acceptJob(response.job);
    else { setJob(null); setResult(response.result.output || response.result.error || 'Check finished.'); }
    setRedirect('');
  }

  return <section className="cortex-setup" aria-label="Cortex Code setup">
    <button className="btn" type="button" aria-expanded={open} onClick={() => {
      setOpen(!open); if (!open) void act(refresh);
    }}>Cortex Code (CoCo) setup</button>
    {open ? <div className="cortex-setup-body">
      <p>Use the Cortex Code CLI installed on this server and share its terminal login. Each login check makes a small inference request.</p>
      <p className="u-dim">Save a named connection to use CoCo in chat. If the CLI is missing, install Cortex Code on this server, then check login here. Setup does not change your default Profile. Goals, agents, steering and tool-free Memory are unavailable.</p>
      <div className="cortex-setup-row">
        <label>Snowflake connection<select value={connection} disabled={busy || running} onChange={event => setConnection(event.target.value)}>
          <option value="">Select a connection</option>
          {connections.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select></label>
        <button className="btn" type="button" disabled={busy || running} onClick={() => void act(refresh)}>Refresh connections</button>
        <button className="btn" type="button" disabled={busy || running} onClick={() => setCreate(!create)}>Create OAuth connection</button>
      </div>
      {create ? <form className="cortex-setup-create" autoComplete="off" onSubmit={event => {
        event.preventDefault(); void act(async () => {
          const response = await AgentApi.settings.createCortexConnection(draft);
          if (!mounted.current) return;
          setConnections(response.connections); setConnection(draft.name); setDraft({ name: '', account: '', user: '' }); setCreate(false);
        });
      }}>
        {['name', 'account', 'user'].map(field => <label key={field}>{field === 'name' ? 'New connection name' : field === 'account' ? 'Snowflake account' : 'Snowflake user'}
          <input required value={draft[field]} maxLength={field === 'name' ? 128 : 256} disabled={busy || running}
            onChange={event => setDraft({ ...draft, [field]: event.target.value })}/>
        </label>)}
        <p>Creates a new connection with a ten-minute browser sign-in window in the server’s native Snowflake configuration.</p>
        <button className="btn" type="submit" disabled={busy || running}>Save connection</button>
      </form> : null}
      <div className="cortex-setup-row">
        <button className="btn" type="button" disabled={busy || running || !connection} onClick={() => void act(() => setup(false))}>Check Cortex login</button>
        <button className="btn primary" type="button" disabled={busy || running || !connection} onClick={() => void act(() => setup(true))}>Authenticate Cortex</button>
        {running ? <button className="btn" type="button" disabled={busy} onClick={() => {
          setRedirect(''); void act(async () => { const response = await AgentApi.settings.cancelCliProfileAuth(job.id); if (mounted.current) acceptJob(response.job); });
        }}>Cancel Cortex login</button> : null}
      </div>
      {handoff?.authorizationUrl ? <div className="cortex-setup-handoff">
        <p>Open this URL on any machine, sign in, then paste the complete loopback redirect below. A browser connection error at 127.0.0.1 is expected on another machine.</p>
        <label>Native login URL<textarea readOnly value={handoff.authorizationUrl} rows={4} onFocus={event => event.target.select()}/></label>
        <p>Complete before {new Date(handoff.expiresAt).toLocaleTimeString()}.</p>
        <form autoComplete="off" onSubmit={event => {
          event.preventDefault(); const value = redirect; setRedirect(''); void act(async () => {
            const response = await AgentApi.settings.submitCortexRedirect(job.id, handoff.generation, value);
            if (mounted.current) acceptJob(response.job);
          });
        }}>
          <label>Complete redirect URL<input value={redirect} autoComplete="off" spellCheck={false} maxLength={16384}
            disabled={busy} onChange={event => setRedirect(event.target.value)}/></label>
          <button className="btn primary" type="submit" disabled={busy || !redirect.trim()}>Submit redirect</button>
        </form>
      </div> : null}
      <div role="status" aria-live="polite">{busy ? 'Working…' : running ? handoff?.phase === 'waiting-for-browser' ? 'Waiting for browser sign-in.'
        : handoff?.phase === 'verifying' ? 'Verifying Cortex Code access…' : 'Starting native login…'
        : job ? job.events?.at(-1)?.text || job.error || job.status : result}</div>
      {error ? <p role="alert">{error}</p> : null}
    </div> : null}
  </section>;
}
