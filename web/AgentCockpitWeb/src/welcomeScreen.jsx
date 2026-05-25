import React from 'react';

import { AgentApi } from './api.js';
import { Ico } from './icons.jsx';
import { ScreenLoading } from './shellState.jsx';

export function WelcomeScreen({ onDone, onOpenSettings, onNewConversation }){
  const [loading, setLoading] = React.useState(true);
  const [install, setInstall] = React.useState(null);
  const [doctor, setDoctor] = React.useState(null);
  const [authStatus, setAuthStatus] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [finishing, setFinishing] = React.useState(false);
  const [installingActionId, setInstallingActionId] = React.useState(null);
  const [installResults, setInstallResults] = React.useState({});
  const [cliAuthBusyVendor, setCliAuthBusyVendor] = React.useState(null);
  const [cliAuthByVendor, setCliAuthByVendor] = React.useState({});

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
      const result = await AgentApi.completeWelcome();
      onDone(result && result.install ? result.install : null);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setFinishing(false);
    }
  }, [onDone]);

  const onRunInstallAction = React.useCallback(async (action) => {
    if (!action || !action.id) return;
    if (action.kind === 'link') {
      if (action.href) window.open(action.href, '_blank', 'noopener');
      return;
    }
    setInstallingActionId(action.id);
    setError(null);
    setInstallResults(prev => ({ ...prev, [action.id]: null }));
    try {
      const result = await AgentApi.runInstallAction(action.id);
      setInstallResults(prev => ({ ...prev, [action.id]: result }));
      if (result && result.doctor) setDoctor(result.doctor);
      if (!result || !result.success) {
        setError((result && result.error) || 'Install action failed.');
      }
    } catch (err) {
      const result = { success: false, action, steps: [], error: err.message || String(err) };
      setInstallResults(prev => ({ ...prev, [action.id]: result }));
      setError(result.error);
    } finally {
      setInstallingActionId(null);
    }
  }, []);

  const setCliAuthState = React.useCallback((vendor, state) => {
    setCliAuthByVendor(prev => ({ ...prev, [vendor]: state }));
  }, []);

  const pollSetupCliAuthJob = React.useCallback(async (vendor, jobId) => {
    try {
      const response = await AgentApi.settings.getCliProfileAuthJob(jobId);
      const job = response.job;
      setCliAuthState(vendor, { kind: 'job', status: job.status, job });
      if (job.status === 'running') {
        window.setTimeout(() => pollSetupCliAuthJob(vendor, jobId), 1000);
      }
    } catch (err) {
      setCliAuthState(vendor, { kind: 'job', status: 'error', error: err.message || String(err) });
    }
  }, [setCliAuthState]);

  const onCheckCliAuth = React.useCallback(async (vendor) => {
    if (!vendor || vendor === 'kiro' || cliAuthBusyVendor) return;
    setCliAuthBusyVendor(vendor);
    setError(null);
    setCliAuthState(vendor, { kind: 'check', status: 'running', message: 'Checking login...' });
    try {
      const response = await AgentApi.settings.testSetupCliAuth(vendor);
      setCliAuthState(vendor, { kind: 'check', status: response.result.status, result: response.result, profile: response.profile });
    } catch (err) {
      setCliAuthState(vendor, { kind: 'check', status: 'error', error: err.message || String(err) });
      setError(err.message || String(err));
    } finally {
      setCliAuthBusyVendor(null);
    }
  }, [cliAuthBusyVendor, setCliAuthState]);

  const onStartCliAuth = React.useCallback(async (vendor) => {
    if (!vendor || vendor === 'kiro' || cliAuthBusyVendor) return;
    setCliAuthBusyVendor(vendor);
    setError(null);
    setCliAuthState(vendor, { kind: 'job', status: 'running', message: 'Starting login...' });
    try {
      const response = await AgentApi.settings.startSetupCliAuth(vendor);
      setCliAuthState(vendor, { kind: 'job', status: response.job.status, job: response.job, profile: response.profile });
      pollSetupCliAuthJob(vendor, response.job.id);
    } catch (err) {
      setCliAuthState(vendor, { kind: 'job', status: 'error', error: err.message || String(err) });
      setError(err.message || String(err));
    } finally {
      setCliAuthBusyVendor(null);
    }
  }, [cliAuthBusyVendor, pollSetupCliAuthJob, setCliAuthState]);

  const onCancelCliAuth = React.useCallback(async (vendor) => {
    const state = cliAuthByVendor[vendor];
    const jobId = state && state.job && state.job.id;
    if (!jobId || cliAuthBusyVendor) return;
    setCliAuthBusyVendor(vendor);
    try {
      const response = await AgentApi.settings.cancelCliProfileAuth(jobId);
      setCliAuthState(vendor, { kind: 'job', status: response.job.status, job: response.job });
    } catch (err) {
      setCliAuthState(vendor, { kind: 'job', status: 'error', error: err.message || String(err) });
      setError(err.message || String(err));
    } finally {
      setCliAuthBusyVendor(null);
    }
  }, [cliAuthByVendor, cliAuthBusyVendor, setCliAuthState]);

  const checks = doctor && Array.isArray(doctor.checks) ? doctor.checks : [];
  const requiredChecks = checks.filter(item => item.required);
  const cliChecks = checks.filter(item => ['claude-cli', 'codex-cli', 'kiro-cli'].includes(item.id));
  const optionalChecks = checks.filter(item => ['pandoc', 'libreoffice', 'mobile-build'].includes(item.id));
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
          <button className="btn ghost" type="button" onClick={() => onDone(null)}>Skip</button>
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
              {requiredChecks.map(item => <WelcomeDoctorLine key={item.id} item={item} onRunInstallAction={onRunInstallAction} installingActionId={installingActionId} installResults={installResults}/>)}
            </WelcomePanel>

            <WelcomePanel title="CLI Backends" tone={cliChecks.some(item => item.status === 'ok') ? 'ok' : 'warning'}>
              {cliChecks.map(item => (
                <WelcomeDoctorLine
                  key={item.id}
                  item={item}
                  onRunInstallAction={onRunInstallAction}
                  installingActionId={installingActionId}
                  installResults={installResults}
                  cliAuthState={cliAuthByVendor[welcomeCliAuthVendor(item.id)]}
                  cliAuthBusyVendor={cliAuthBusyVendor}
                  onCheckCliAuth={onCheckCliAuth}
                  onStartCliAuth={onStartCliAuth}
                  onCancelCliAuth={onCancelCliAuth}
                />
              ))}
              <p className="welcome-note">Install only the backend CLIs you plan to use. Unused backends can stay uninstalled.</p>
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
              {optionalChecks.map(item => <WelcomeDoctorLine key={item.id} item={item} onRunInstallAction={onRunInstallAction} installingActionId={installingActionId} installResults={installResults}/>)}
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

function WelcomeDoctorLine({
  item,
  onRunInstallAction,
  installingActionId,
  installResults,
  cliAuthState,
  cliAuthBusyVendor,
  onCheckCliAuth,
  onStartCliAuth,
  onCancelCliAuth,
}){
  const actions = Array.isArray(item.installActions) ? item.installActions : [];
  const results = Object.entries(installResults || {})
    .filter(([id, result]) => Boolean(result) && id.startsWith(item.id + ':'))
    .map(([id, result]) => ({ id, result }));
  const authVendor = item.status === 'ok' ? welcomeCliAuthVendor(item.id) : null;
  return (
    <div className="welcome-doctor-item">
      <WelcomeLine
        label={item.label}
        status={item.status}
        summary={item.summary}
        detail={item.status === 'ok' ? item.detail : (item.remediation || item.detail)}
      />
      {actions.length > 0 ? (
        <div className="welcome-install-actions">
          {actions.map(action => {
            const busy = installingActionId === action.id;
            if (action.kind === 'link') {
              return (
                <a className="btn ghost welcome-install-btn" href={action.href || '#'} target="_blank" rel="noreferrer" key={action.id}>
                  {Ico.globe(12)} {action.label}
                </a>
              );
            }
            return (
              <button
                className="btn primary welcome-install-btn"
                type="button"
                key={action.id}
                disabled={Boolean(installingActionId)}
                onClick={() => onRunInstallAction && onRunInstallAction(action)}
                title={action.description || action.command?.join(' ')}
              >
                {Ico.download(12)} {busy ? 'Installing...' : action.label}
              </button>
            );
          })}
        </div>
      ) : null}
      {results.map(({ id, result }) => (
        <div className={"welcome-install-result " + (result.success ? 'ok' : 'error')} key={id}>
          <b>{result.success ? 'Install command finished.' : 'Install command failed.'}</b>
          <span>{installResultMessage(result)}</span>
        </div>
      ))}
      {authVendor ? (
        <WelcomeCliAuth
          vendor={authVendor}
          state={cliAuthState}
          busyVendor={cliAuthBusyVendor}
          onCheck={onCheckCliAuth}
          onStart={onStartCliAuth}
          onCancel={onCancelCliAuth}
        />
      ) : null}
    </div>
  );
}

function WelcomeCliAuth({ vendor, state, busyVendor, onCheck, onStart, onCancel }){
  if (vendor === 'kiro') {
    return (
      <div className="welcome-cli-auth-note">
        Kiro login is self-configured for now. Run <code>kiro-cli login</code> on the server, then refresh checks.
      </div>
    );
  }
  const running = state && state.kind === 'job' && state.status === 'running';
  const busy = busyVendor === vendor;
  const disabled = Boolean(busyVendor) || running;
  return (
    <div className="welcome-cli-auth">
      <div className="welcome-cli-auth-head">
        <b>{welcomeCliAuthLabel(vendor)} login</b>
        <span>{welcomeCliAuthStateLabel(state)}</span>
      </div>
      <div className="welcome-install-actions">
        <button className="btn welcome-install-btn" type="button" disabled={disabled} onClick={() => onCheck && onCheck(vendor)}>
          {Ico.search(12)} {busy ? 'Checking...' : 'Check login'}
        </button>
        <button className="btn primary welcome-install-btn" type="button" disabled={disabled} onClick={() => onStart && onStart(vendor)}>
          {Ico.key(12)} {busy ? 'Starting...' : 'Authenticate'}
        </button>
        {running ? (
          <button className="btn ghost welcome-install-btn" type="button" disabled={Boolean(busyVendor)} onClick={() => onCancel && onCancel(vendor)}>
            Cancel
          </button>
        ) : null}
      </div>
      {state ? (
        <div className={"welcome-install-result " + (welcomeCliAuthOk(state) ? 'ok' : welcomeCliAuthRunning(state) ? 'pending' : 'error')}>
          <b>{welcomeCliAuthResultTitle(state)}</b>
          <span>{welcomeCliAuthText(state)}</span>
        </div>
      ) : null}
    </div>
  );
}

function welcomeCliAuthVendor(checkId){
  if (checkId === 'claude-cli') return 'claude-code';
  if (checkId === 'codex-cli') return 'codex';
  if (checkId === 'kiro-cli') return 'kiro';
  return null;
}

function welcomeCliAuthLabel(vendor){
  if (vendor === 'codex') return 'Codex';
  if (vendor === 'claude-code') return 'Claude Code';
  return 'Kiro';
}

function welcomeCliAuthStateLabel(state){
  if (!state) return 'Not checked';
  if (state.status === 'running') return 'Running';
  if (state.status === 'ok' || state.status === 'succeeded') return 'Ready';
  if (state.status === 'not-authenticated') return 'Needs login';
  if (state.status === 'unavailable') return 'CLI unavailable';
  if (state.status === 'unsupported') return 'Unsupported';
  if (state.status === 'cancelled') return 'Cancelled';
  return 'Needs attention';
}

function welcomeCliAuthOk(state){
  return state && (state.status === 'ok' || state.status === 'succeeded');
}

function welcomeCliAuthRunning(state){
  return state && state.status === 'running';
}

function welcomeCliAuthResultTitle(state){
  if (welcomeCliAuthOk(state)) return 'Login verified.';
  if (welcomeCliAuthRunning(state)) return 'Login in progress.';
  if (state && state.status === 'cancelled') return 'Login cancelled.';
  return 'Login needs attention.';
}

function welcomeCliAuthText(state){
  if (!state) return '';
  if (state.message) return state.message;
  if (state.error) return state.error;
  if (state.result) {
    return state.result.error || state.result.output || 'CLI login is ready.';
  }
  if (state.job) {
    const events = Array.isArray(state.job.events) ? state.job.events : [];
    const output = events.slice(-8).map(event => event.text).filter(Boolean).join('\n');
    return state.job.error || output || 'Complete the browser/device login, then wait for verification.';
  }
  return '';
}

function installResultMessage(result){
  const output = result && result.steps && result.steps[0] && result.steps[0].output;
  if (result && result.error && output) return result.error + '\n' + output;
  return (result && result.error) || output || 'Refresh the checks to confirm detection.';
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
