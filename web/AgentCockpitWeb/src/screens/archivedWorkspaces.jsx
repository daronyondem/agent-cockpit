import React from 'react';
import { AgentApi } from '../api.js';
import { StreamStore } from '../streamStore.js';
import { Ico } from '../icons.jsx';
import { useDialog } from '../dialog.jsx';
import { useToasts } from '../toast.jsx';

const ARCHIVE_MODE_LABELS = {
  history_only: 'Workspace Metadata and Conversations',
  file_snapshot: 'Full Backup with Workspace Folder',
};

function archiveModeLabel(mode){
  return ARCHIVE_MODE_LABELS[mode] || ARCHIVE_MODE_LABELS.history_only;
}

export function ArchivedWorkspacesPanel({ onOpenWorkspaceSettings }){
  const [workspaces, setWorkspaces] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [busyId, setBusyId] = React.useState(null);
  const [remapDrafts, setRemapDrafts] = React.useState({});
  const [restoreDrafts, setRestoreDrafts] = React.useState({});
  const dialog = useDialog();
  const toast = useToasts();

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    AgentApi.workspace.list({ archived: true })
      .then((res) => {
        const next = Array.isArray(res && res.workspaces) ? res.workspaces : [];
        setWorkspaces(next);
        setRemapDrafts(prev => seedDrafts(prev, next, 'workspacePath'));
        setRestoreDrafts(prev => seedRestoreDrafts(prev, next));
      })
      .catch((err) => setError(err.message || String(err)))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  async function restoreWorkspace(workspace, restoreFromSnapshot){
    if (!workspace) return;
    const restoreDraft = (restoreDrafts[workspace.workspaceId] || '').trim();
    const body = restoreFromSnapshot
      ? { restoreFromSnapshot: true, ...(restoreDraft ? { destinationPath: restoreDraft } : {}) }
      : {};
    const ok = await dialog.confirm({
      title: restoreFromSnapshot ? 'Restore From Backup' : 'Restore Workspace',
      body: restoreFromSnapshot
        ? `Extract the archived full backup and restore ${workspaceLabel(workspace)}?`
        : `Restore ${workspaceLabel(workspace)} to active workspaces?`,
      confirmLabel: 'Restore',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    setBusyId(workspace.workspaceId);
    try {
      await AgentApi.workspace.restore(workspace.workspaceId, body);
      toast.success('Workspace restored');
      await StreamStore.refreshConvList().catch(() => {});
      load();
    } catch (err) {
      await dialog.alert({ variant: 'error', title: 'Restore failed', body: err.message || String(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function remapWorkspace(workspace){
    const nextPath = (remapDrafts[workspace.workspaceId] || '').trim();
    if (!nextPath) {
      await dialog.alert({ variant: 'error', title: 'Folder required', body: 'Workspace folder is required.' });
      return;
    }
    setBusyId(workspace.workspaceId);
    try {
      await AgentApi.workspace.updateLocation(workspace.workspaceId, nextPath);
      toast.success('Workspace folder updated');
      load();
    } catch (err) {
      await dialog.alert({ variant: 'error', title: 'Remap failed', body: err.message || String(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function deleteArchivedData(workspace){
    const ok = await dialog.confirm({
      variant: 'error',
      title: 'Delete Archived Data',
      body: `Delete Agent Cockpit data for ${workspaceLabel(workspace)}? Conversations, Memory, Workspace Context, KB data, and backups for this archived workspace will be removed.`,
      confirmLabel: 'Delete data',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    setBusyId(workspace.workspaceId);
    try {
      await AgentApi.workspace.deleteArchivedData(workspace.workspaceId);
      toast.success('Archived workspace data deleted');
      await StreamStore.refreshConvList().catch(() => {});
      load();
    } catch (err) {
      await dialog.alert({ variant: 'error', title: 'Delete failed', body: err.message || String(err) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="archived-workspaces-body">
      <div className="archived-workspaces-panel-head">
        <div>
          <h3>Archived Workspaces</h3>
          <p className="u-dim">{workspaces.length} archived workspace{workspaces.length === 1 ? '' : 's'}</p>
        </div>
        <span className="settings-actions-row compact">
          <button type="button" className="btn" onClick={load} disabled={loading || !!busyId}>{Ico.reset(14)} Refresh</button>
        </span>
      </div>

      {loading ? (
        <div className="u-dim" style={{padding:16}}>Loading...</div>
      ) : error ? (
        <div className="u-err" style={{padding:16}}>{error}</div>
      ) : workspaces.length === 0 ? (
        <div className="ws-empty u-dim">No archived workspaces.</div>
      ) : (
        <div className="archived-workspace-list">
          {workspaces.map(workspace => {
            const archive = workspace.archive || {};
            const snapshot = archive.snapshot || null;
            const busy = busyId === workspace.workspaceId;
            const canRestoreDirectly = !!workspace.pathAvailable;
            const canRestoreSnapshot = snapshot && snapshot.status === 'verified';
            return (
              <section className="settings-card archived-workspace-card" key={workspace.workspaceId}>
                <div className="settings-card-head">
                  <div>
                    <h3>{workspaceLabel(workspace)}</h3>
                    <p className="u-dim">{workspace.workspacePath}</p>
                  </div>
                  <span className={'ws-archive-pill ' + (workspace.pathAvailable ? 'ok' : 'warn')}>
                    {workspace.pathAvailable ? 'Folder available' : 'Folder missing'}
                  </span>
                </div>

                <div className="archived-workspace-grid">
                  <Metric label="Archived" value={formatDate(archive.archivedAt)}/>
                  <Metric label="Mode" value={archiveModeLabel(archive.mode)}/>
                  <Metric label="Conversations" value={workspace.conversationCount}/>
                  <Metric label="Memory" value={workspace.memoryEnabled ? 'On' : 'Off'}/>
                  <Metric label="KB" value={workspace.kbEnabled ? 'On' : 'Off'}/>
                  <Metric label="Context" value={workspace.workspaceContextEnabled ? 'On' : 'Off'}/>
                  <Metric label="Routines" value={workspace.routinesEnabled ? 'On' : 'Off'}/>
                </div>

                {archive.note ? <p className="archived-workspace-note">{archive.note}</p> : null}

                {snapshot ? (
                  <div className="archived-workspace-snapshot">
                    <span>{snapshot.status}</span>
                    <span>{formatBytes(snapshot.sizeBytes || 0)}</span>
                    <span>{snapshot.fileCount || 0} files</span>
                  </div>
                ) : null}

                {!workspace.pathAvailable ? (
                  <div className="settings-inline-row">
                    <input
                      className="input"
                      value={remapDrafts[workspace.workspaceId] || ''}
                      onChange={(e) => setRemapDrafts(prev => ({ ...prev, [workspace.workspaceId]: e.currentTarget.value }))}
                      placeholder="Existing folder path"
                    />
                    <button type="button" className="btn" onClick={() => remapWorkspace(workspace)} disabled={busy}>
                      {Ico.folder(14)} Remap
                    </button>
                  </div>
                ) : null}

                {canRestoreSnapshot ? (
                  <div className="settings-inline-row">
                    <input
                      className="input"
                      value={restoreDrafts[workspace.workspaceId] || ''}
                      onChange={(e) => setRestoreDrafts(prev => ({ ...prev, [workspace.workspaceId]: e.currentTarget.value }))}
                      placeholder="Restore destination path"
                    />
                    <button type="button" className="btn" onClick={() => restoreWorkspace(workspace, true)} disabled={busy}>
                      {Ico.download(14)} Restore backup
                    </button>
                  </div>
                ) : null}

                <div className="settings-actions-row">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => restoreWorkspace(workspace, false)}
                    disabled={busy || !canRestoreDirectly}
                  >
                    {Ico.reset(14)} Restore
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onOpenWorkspaceSettings && onOpenWorkspaceSettings(workspace.workspaceId, workspaceLabel(workspace), 'archive')}
                  >
                    {Ico.settings(14)} Settings
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    onClick={() => deleteArchivedData(workspace)}
                    disabled={busy}
                  >
                    {Ico.trash(14)} Delete data
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ArchivedWorkspacesScreen({ onClose, onOpenWorkspaceSettings }){
  return (
    <div className="settings-shell archived-workspaces-shell">
      <div className="settings-top">
        <div className="settings-title-block">
          <div className="settings-title">Archived Workspaces</div>
          <div className="settings-subtitle u-dim">Manage archived workspace data</div>
        </div>
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
      <div className="settings-body">
        <ArchivedWorkspacesPanel onOpenWorkspaceSettings={onOpenWorkspaceSettings}/>
      </div>
    </div>
  );
}

function Metric({ label, value }){
  return (
    <div className="archived-workspace-metric">
      <span className="u-dim">{label}</span>
      <b>{value}</b>
    </div>
  );
}

function workspaceLabel(workspace){
  const raw = workspace && workspace.workspacePath ? workspace.workspacePath : 'Workspace';
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || raw;
}

function seedDrafts(prev, workspaces, key){
  const next = { ...prev };
  workspaces.forEach(workspace => {
    if (!next[workspace.workspaceId]) next[workspace.workspaceId] = workspace[key] || '';
  });
  return next;
}

function seedRestoreDrafts(prev, workspaces){
  const next = { ...prev };
  workspaces.forEach(workspace => {
    if (!next[workspace.workspaceId]) {
      const label = workspaceLabel(workspace);
      next[workspace.workspaceId] = workspace.workspacePath ? `${workspace.workspacePath}-restored` : label;
    }
  });
  return next;
}

function formatDate(value){
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatBytes(bytes){
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
