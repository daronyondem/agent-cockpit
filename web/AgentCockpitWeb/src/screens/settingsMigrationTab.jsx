import React from 'react';
import { AgentApi } from '../api.js';
import { Ico } from '../icons.jsx';
import { Tip } from '../tooltip.jsx';
import { useDialog } from '../dialog.jsx';
import { useToasts } from '../toast.jsx';

function SettingsHelpTooltip({ children }){
  return (
    <div className="tt-section settings-help-tooltip">
      <div className="tt-body-text">{children}</div>
    </div>
  );
}

function Field({ label, hint, children }){
  return (
    <label className="settings-field">
      <span className="settings-field-label-row">
        <span className="settings-field-label">{label}</span>
      </span>
      {children}
      {hint ? <span className="settings-field-hint u-dim">{hint}</span> : null}
    </label>
  );
}

function fmtNum(n){ return Math.round(n || 0).toLocaleString(); }
function waitMs(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }
function fmtBytes(n){
  const value = Number(n) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}
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

export function MigrationTab(){
  const dialog = useDialog();
  const toast = useToasts();
  const fileInputRef = React.useRef(null);
  const [status, setStatus] = React.useState(null);
  const [checks, setChecks] = React.useState(null);
  const [selectedFile, setSelectedFile] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
  const [confirmation, setConfirmation] = React.useState('');
  const [busy, setBusy] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [exportProgress, setExportProgress] = React.useState(null);
  const [importProgress, setImportProgress] = React.useState(null);
  const [overlay, setOverlay] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    AgentApi.settings.migrationStatus()
      .then(data => { if (!cancelled) setStatus(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function refreshStatus(){
    const data = await AgentApi.settings.migrationStatus();
    setStatus(data);
  }

  async function onExport(anchor){
    setBusy('export');
    setMessage('');
    setExportProgress({ phase: 'Starting export', progress: 1, status: 'running' });
    try {
      let job = await AgentApi.settings.startMigrationExport();
      setExportProgress(job);
      while (job && job.status === 'running') {
        await waitMs(500);
        job = await AgentApi.settings.migrationExportJob(job.jobId);
        setExportProgress(job);
      }
      if (!job || job.status !== 'ready') {
        throw new Error((job && job.error) || 'Export failed.');
      }
      const a = document.createElement('a');
      a.href = AgentApi.settings.migrationExportJobDownloadUrl(job.jobId);
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success('Export ready');
      setTimeout(() => {
        setBusy('');
        setExportProgress(null);
      }, 1200);
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Export failed', body: err.message || String(err) });
      setBusy('');
      setExportProgress(null);
    }
  }

  async function onSelectFile(file, anchor){
    setSelectedFile(file || null);
    setPreview(null);
    setConfirmation('');
    setMessage('');
    setImportProgress(null);
    if (!file) return;
    setBusy('preview');
    setImportProgress({ step: 'uploading', phase: 'Uploading', progress: null });
    try {
      const data = await AgentApi.settings.previewMigrationImport(file, {
        onProgress: (progress) => {
          setImportProgress({
            step: 'uploading',
            phase: 'Uploading',
            progress: progress.percent,
            loaded: progress.loaded,
            total: progress.total,
            computable: progress.computable,
          });
        },
        onUploadComplete: () => {
          setImportProgress({ step: 'processing', phase: 'Processing', progress: 100 });
        },
      });
      setPreview(data);
      setImportProgress(null);
      await refreshStatus().catch(() => {});
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Import preview failed', body: err.message || String(err) });
      setSelectedFile(null);
      setImportProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } finally {
      setBusy('');
    }
  }

  async function onImport(anchor){
    if (!preview || confirmation !== 'REPLACE') return;
    const ok = await dialog.confirm({
      anchor,
      destructive: true,
      title: 'Replace all Agent Cockpit data?',
      body: 'Import will replace this installation data root after creating a backup. Existing active conversations, settings, workspace context, memory, and KB data will be overwritten on restart.',
      confirmLabel: 'Replace and restart',
    });
    if (!ok) return;
    setBusy('import');
    setMessage('Restoring import…');
    setImportProgress({ step: 'restoring', phase: 'Restoring', progress: 100 });
    try {
      const res = await AgentApi.settings.confirmMigrationImport(preview.uploadId, confirmation);
      if (res && res.ok) {
        setMessage('Restore staged. Restarting…');
        setOverlay(true);
        setTimeout(() => window.location.reload(), 6500);
      } else {
        setMessage((res && res.error) || 'Import was not applied.');
        setBusy('');
        setImportProgress(null);
      }
    } catch (err) {
      if (err && (err.message === 'Failed to fetch' || err.name === 'TypeError')) {
        setOverlay(true);
        setTimeout(() => window.location.reload(), 6500);
        return;
      }
      await dialog.alert({ anchor, variant: 'error', title: 'Import failed', body: err.message || String(err) });
      setBusy('');
      setImportProgress(null);
    }
  }

  async function onRunChecks(deep, anchor){
    setBusy(deep ? 'deep-checks' : 'checks');
    try {
      setChecks(await AgentApi.settings.migrationChecks(deep));
    } catch (err) {
      await dialog.alert({ anchor, variant: 'error', title: 'Checks failed', body: err.message || String(err) });
    } finally {
      setBusy('');
    }
  }

  const manifest = preview && preview.manifest;
  const pendingImport = status && status.pendingImport;
  const canImport = !!(preview && preview.uploadId && confirmation === 'REPLACE' && !busy && !pendingImport);
  const exportPercent = exportProgress ? Math.max(1, Math.min(100, Math.round(Number(exportProgress.progress) || 1))) : 0;
  const hasMeasuredImportProgress = !!(importProgress && Number.isFinite(Number(importProgress.progress)));
  const importPercent = hasMeasuredImportProgress ? Math.max(1, Math.min(100, Math.round(Number(importProgress.progress)))) : null;
  const importButtonLabel = busy === 'preview'
    ? importProgress && importProgress.step === 'uploading' ? importPercent ? `Uploading ${importPercent}%` : 'Uploading…' : 'Processing…'
    : 'Choose export';

  return (
    <div className="settings-form settings-form-wide migration-form">
      <div className="migration-panel">
        <div className="migration-panel-head">
          <div>
            <div className="settings-section-title">Export</div>
            {status && status.dataRoot ? <div className="migration-path u-mono">{status.dataRoot}</div> : null}
          </div>
          <button className={`btn primary migration-progress-button ${busy === 'export' ? 'is-running' : ''}`} disabled={!!busy} onClick={(e) => onExport(e.currentTarget)}>
            {busy === 'export' ? <span className="migration-button-progress" style={{ width: `${exportPercent}%` }} /> : null}
            <span className="migration-button-label">{Ico.download(13)} {busy === 'export' ? `${exportPercent}%` : 'Export'}</span>
          </button>
        </div>
        {exportProgress ? <div className="migration-progress-line">{exportProgress.phase || 'Exporting'} · {exportPercent}%</div> : null}
      </div>

      <div className="migration-panel">
        <div className="migration-panel-head">
          <div>
            <div className="settings-section-title">Import</div>
            <div className="migration-danger">{Ico.alert(13)} Import replaces everything in this installation.</div>
          </div>
          <button className={`btn migration-progress-button ${busy === 'preview' ? 'is-running' : ''}`} disabled={!!busy} onClick={() => fileInputRef.current && fileInputRef.current.click()}>
            {busy === 'preview' ? <span className={`migration-button-progress ${hasMeasuredImportProgress ? '' : 'indeterminate'}`} style={hasMeasuredImportProgress ? { width: `${importPercent}%` } : undefined} /> : null}
            <span className="migration-button-label">{Ico.upload(13)} {importButtonLabel}</span>
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".acexport,.zip,application/zip"
          style={{display:'none'}}
          onChange={(e) => onSelectFile(e.target.files && e.target.files[0], e.currentTarget)}
        />
        {selectedFile ? (
          <div className="migration-file-row">
            <span className="u-mono">{selectedFile.name}</span>
            <span className="u-dim">{fmtBytes(selectedFile.size)}</span>
          </div>
        ) : null}
        {importProgress ? <MigrationImportProgress progress={importProgress} percent={importPercent}/> : null}
        {manifest ? (
          <div className="migration-preview">
            <div className="migration-kv"><span>Exported</span><b>{fmtDateTime(manifest.exportedAt)}</b></div>
            <div className="migration-kv"><span>Version</span><b>{manifest.appVersion}</b></div>
            <div className="migration-kv"><span>Workspaces</span><b>{fmtNum(manifest.counts && manifest.counts.workspaces)}</b></div>
            <div className="migration-kv"><span>Files</span><b>{fmtNum(manifest.counts && manifest.counts.files)} · {fmtBytes(manifest.counts && manifest.counts.bytes)}</b></div>
            {Array.isArray(preview.warnings) && preview.warnings.length ? (
              <div className="migration-warnings">
                {preview.warnings.map((warning, idx) => <div key={idx}>{warning}</div>)}
              </div>
            ) : null}
            <Field label="Confirmation" hint="Required before import can replace the active data root.">
              <input
                value={confirmation}
                placeholder="REPLACE"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </Field>
            {pendingImport ? <div className="settings-warning">A data import is already pending. Restart before staging another import.</div> : null}
            <div className="settings-actions">
              <button className={`btn danger migration-progress-button ${busy === 'import' ? 'is-running' : ''}`} disabled={!canImport} onClick={(e) => onImport(e.currentTarget)}>
                {busy === 'import' ? <span className="migration-button-progress" style={{ width: '100%' }} /> : null}
                <span className="migration-button-label">{Ico.alert(13)} {busy === 'import' ? 'Restoring…' : 'Replace and restart'}</span>
              </button>
            </div>
          </div>
        ) : null}
        {message ? <div className="settings-status-line u-dim">{message}</div> : null}
      </div>

      <div className="migration-panel">
        <div className="migration-panel-head">
          <div>
            <div className="settings-section-title">Checks</div>
            {checks ? <div className={`migration-summary ${checks.summary && checks.summary.status}`}>{summaryLabel(checks.summary)}</div> : null}
          </div>
          <div className="migration-actions">
            <div className="migration-action-with-help">
              <button className="btn" disabled={!!busy} onClick={(e) => onRunChecks(false, e.currentTarget)}>
                {Ico.reset(13)} {busy === 'checks' ? 'Checking…' : 'Run checks'}
              </button>
              <Tip variant="explain" rich={<SettingsHelpTooltip>Checks validate local migrated data and installed tools: workspace folders, missing workspace paths, Memory, KB SQLite/PGLite, CLI auth/config hints, Pandoc, and LibreOffice. They do not contact Ollama.</SettingsHelpTooltip>}>
                <button type="button" className="settings-help-btn migration-help-btn" aria-label="Run checks help">?</button>
              </Tip>
            </div>
            <div className="migration-action-with-help">
              <button className="btn" disabled={!!busy} onClick={(e) => onRunChecks(true, e.currentTarget)}>
                {Ico.zap(13)} {busy === 'deep-checks' ? 'Checking…' : 'Deep checks'}
              </button>
              <Tip variant="explain" rich={<SettingsHelpTooltip>Deep checks run the same local checks and also contact each configured Ollama embedding host/model for migrated Knowledge Base workspaces. Use them after import when you want to verify embedding availability on this machine.</SettingsHelpTooltip>}>
                <button type="button" className="settings-help-btn migration-help-btn" aria-label="Deep checks help">?</button>
              </Tip>
            </div>
          </div>
        </div>
        {checks ? <MigrationChecks checks={checks}/> : <div className="settings-empty u-dim">No check results yet.</div>}
      </div>

      {overlay ? (
        <div className="restart-overlay" role="status" aria-live="polite">
          <div className="restart-dialog">
            <div className="restart-title">Restarting server…</div>
            <div className="restart-sub">The imported data will load after refresh.</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function summaryLabel(summary){
  if (!summary) return '';
  const parts = [];
  if (summary.errors) parts.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`);
  if (summary.warnings) parts.push(`${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'All checks passed';
}

function MigrationImportProgress({ progress, percent }){
  if (!progress) return null;
  const currentStep = progress.step || 'uploading';
  const hasPercent = Number.isFinite(Number(percent));
  const steps = [
    { id: 'uploading', label: currentStep === 'uploading' && hasPercent ? `Uploading ${percent}%` : 'Uploading' },
    { id: 'processing', label: 'Processing' },
    { id: 'restoring', label: 'Restoring' },
  ];
  const currentIndex = Math.max(0, steps.findIndex(step => step.id === currentStep));
  return (
    <div className="migration-import-progress" role="status" aria-live="polite">
      {steps.map((step, index) => (
        <span
          key={step.id}
          className={`migration-import-step ${index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'pending'}`}
        >
          {step.label}
        </span>
      ))}
      <div className="migration-progress-line">{progress.phase || 'Working'}{currentStep === 'uploading' && hasPercent ? ` · ${percent}%` : '…'}</div>
    </div>
  );
}

function MigrationChecks({ checks }){
  const workspaces = Array.isArray(checks.workspaces) ? checks.workspaces : [];
  const cliProfiles = checks.tools && Array.isArray(checks.tools.cliProfiles) ? checks.tools.cliProfiles : [];
  return (
    <div className="migration-checks">
      <div className="migration-check-group">
        <CheckRow label="Pandoc" check={checks.tools && checks.tools.pandoc}/>
        <CheckRow label="LibreOffice" check={checks.tools && checks.tools.libreOffice}/>
        {cliProfiles.map((check, idx) => <CheckRow key={idx} label={`CLI ${idx + 1}`} check={check}/>)}
      </div>
      {workspaces.map(workspace => (
        <div className="migration-check-group" key={workspace.workspaceId || workspace.storageKey}>
          <div className="migration-check-title">
            <span>{workspace.workspaceId || workspace.storageKey}</span>
            <span className="u-mono u-dim">{workspace.storageKey}</span>
          </div>
          <CheckRow label="Storage" check={workspace.storage}/>
          <CheckRow label="Path" check={workspace.workspacePath}/>
          <CheckRow label="Memory" check={workspace.memory}/>
          <CheckRow label="Knowledge" check={workspace.knowledge}/>
          <CheckRow label="KB SQLite" check={workspace.knowledge && workspace.knowledge.stateDb}/>
          <CheckRow label="PGLite" check={workspace.knowledge && workspace.knowledge.vectors}/>
          <CheckRow label="Embeddings" check={workspace.knowledge && workspace.knowledge.embedding}/>
          <CheckRow label="Context" check={workspace.workspaceContext}/>
        </div>
      ))}
    </div>
  );
}

function CheckRow({ label, check }){
  if (!check) return null;
  const status = check.status || 'skipped';
  return (
    <div className={`migration-check-row ${status}`}>
      <span className={`migration-pill ${status}`}>{status}</span>
      <span className="migration-check-label">{label}</span>
      <span className="migration-check-message">{check.message}</span>
      {check.path ? <span className="migration-check-path u-mono">{check.path}</span> : null}
    </div>
  );
}
