import { useEffect, useRef, useState } from 'react';
import type { AgentCockpitAPI } from './api';
import { modelDisplayLabel } from './appModel';
import {
  ArchiveIcon,
  CheckIcon,
  ChevronRightIcon,
  EditIcon,
  ExternalIcon,
  FileIcon,
  FolderPlusIcon,
  PlusIcon,
  ResetIcon,
  SessionsIcon,
  TrashIcon,
  XIcon,
} from './mobileIcons';
import { Button, Choice, Modal } from './mobilePrimitives';
import type {
  BackendMetadata,
  ClaudeCodeMode,
  Conversation,
  DirectoryBrowseResponse,
  EffortLevel,
  ServiceTier,
} from './types';

export type MarkdownShareScope = 'all' | 'current';

export function NewConversationModal(props: {
  client: AgentCockpitAPI;
  title: string;
  workingDir: string;
  loading: boolean;
  onTitleChange: (value: string) => void;
  onWorkingDirChange: (value: string) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  const [pickerVisible, setPickerVisible] = useState(false);
  return (
    <Modal title="New Conversation" onClose={props.onCancel}>
      <label>Title<input value={props.title} onChange={(event) => props.onTitleChange(event.target.value)} /></label>
      <label>
        Working directory
        <div className="directory-picker">
          <button
            className={`directory-display ${props.workingDir ? '' : 'empty'}`}
            type="button"
            disabled={props.loading}
            onClick={() => setPickerVisible(true)}
          >
            {props.workingDir || 'Use default workspace'}
          </button>
          <div className="directory-actions">
            <Button label="Browse" disabled={props.loading} onClick={() => setPickerVisible(true)} />
            {props.workingDir ? <Button label="Default" disabled={props.loading} onClick={() => props.onWorkingDirChange('')} /> : null}
          </div>
        </div>
      </label>
      <div className="modal-actions sheet-actions">
        <button className="sheet-action" type="button" onClick={props.onCancel}>
          <XIcon />
          Cancel
        </button>
        <button className="sheet-action primary" type="button" disabled={props.loading} onClick={props.onCreate}>
          <PlusIcon />
          Create
        </button>
      </div>
      {pickerVisible ? (
        <FolderPickerModal
          client={props.client}
          initialPath={props.workingDir}
          busy={props.loading}
          onClose={() => setPickerVisible(false)}
          onSelect={(path) => {
            props.onWorkingDirChange(path);
            setPickerVisible(false);
          }}
          onUseDefault={() => {
            props.onWorkingDirChange('');
            setPickerVisible(false);
          }}
        />
      ) : null}
    </Modal>
  );
}

function FolderPickerModal(props: {
  client: AgentCockpitAPI;
  initialPath: string;
  busy: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  onUseDefault: () => void;
}) {
  const [data, setData] = useState<DirectoryBrowseResponse | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);

  async function loadDirectory(path?: string | null, hidden = showHidden) {
    setLoading(true);
    setError(null);
    try {
      const next = await props.client.browseDirectory(path || undefined, hidden);
      setData(next);
      setConfirmDelete(false);
      setNewFolderName(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Folder could not be opened.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDirectory(props.initialPath || undefined);
  }, []);

  useEffect(() => {
    if (newFolderName !== null) {
      newFolderInputRef.current?.focus();
    }
  }, [newFolderName]);

  async function toggleHidden(checked: boolean) {
    setShowHidden(checked);
    await loadDirectory(data?.currentPath || props.initialPath || undefined, checked);
  }

  async function createFolder() {
    const name = (newFolderName || '').trim();
    if (!data || !name) {
      return;
    }
    try {
      const result = await props.client.createDirectory(data.currentPath, name);
      await loadDirectory(result.created || data.currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Folder could not be created.');
    }
  }

  async function deleteFolder() {
    if (!data?.parent) {
      return;
    }
    try {
      const result = await props.client.deleteDirectory(data.currentPath);
      await loadDirectory(result.parent || data.parent);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Folder could not be deleted.');
      setConfirmDelete(false);
    }
  }

  const currentName = data ? data.currentPath.split('/').filter(Boolean).pop() || data.currentPath : '';

  return (
    <div className="modal-backdrop folder-picker-backdrop" role="dialog" aria-modal="true">
      <section className="modal folder-picker-modal">
        <header className="modal-header">
          <div>
            <h2>Select Working Directory</h2>
            <p>{error || data?.currentPath || 'Loading...'}</p>
          </div>
          <Button label="Close" onClick={props.onClose} />
        </header>
        <div className="folder-picker-toolbar">
          <label className="folder-toggle">
            <input
              type="checkbox"
              checked={showHidden}
              disabled={loading || props.busy}
              onChange={(event) => void toggleHidden(event.currentTarget.checked)}
            />
            Show hidden
          </label>
          <button className="ftb" type="button" disabled={!data || loading || props.busy} onClick={() => setNewFolderName('')}>
            <FolderPlusIcon />
            New folder
          </button>
          {data?.parent ? (
            <button className="ftb danger" type="button" disabled={loading || props.busy} onClick={() => setConfirmDelete(true)}>
              <TrashIcon />
              Delete
            </button>
          ) : null}
        </div>
        {newFolderName !== null ? (
          <div className="folder-new-row">
            <input
              ref={newFolderInputRef}
              value={newFolderName}
              placeholder="Folder name"
              disabled={props.busy}
              onChange={(event) => setNewFolderName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void createFolder();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setNewFolderName(null);
                }
              }}
            />
            <button className="sheet-action primary" type="button" disabled={!newFolderName.trim() || props.busy} onClick={() => void createFolder()}>
              <PlusIcon />
              Create
            </button>
            <button className="sheet-action" type="button" disabled={props.busy} onClick={() => setNewFolderName(null)}>
              <XIcon />
              Cancel
            </button>
          </div>
        ) : null}
        <div className="modal-scroll folder-list">
          {confirmDelete && data ? (
            <section className="folder-confirm">
              <strong>Delete {currentName}?</strong>
              <div className="button-row">
                <button className="sheet-action danger" type="button" disabled={props.busy} onClick={() => void deleteFolder()}>
                  <TrashIcon />
                  Delete
                </button>
                <button className="sheet-action" type="button" disabled={props.busy} onClick={() => setConfirmDelete(false)}>
                  <XIcon />
                  Cancel
                </button>
              </div>
            </section>
          ) : loading ? (
            <p className="empty">Loading...</p>
          ) : data ? (
            <>
              {data.parent ? (
                <button className="folder-row parent-folder" type="button" onClick={() => void loadDirectory(data.parent)} disabled={props.busy}>
                  ↑ Parent directory
                </button>
              ) : null}
              {data.dirs.length ? data.dirs.map((name) => {
                const fullPath = `${data.currentPath}${data.currentPath.endsWith('/') ? '' : '/'}${name}`;
                return (
                  <button key={name} className="folder-row" type="button" onClick={() => void loadDirectory(fullPath)} disabled={props.busy} title={fullPath}>
                    <span className="folder-glyph" aria-hidden="true" />
                    <span>{name}</span>
                  </button>
                );
              }) : <p className="empty">No subdirectories</p>}
            </>
          ) : null}
        </div>
        <div className="modal-actions sheet-actions">
          <button className="sheet-action" type="button" disabled={props.busy || loading} onClick={props.onUseDefault}>
            <ResetIcon />
            Use Default
          </button>
          <button className="sheet-action" type="button" disabled={props.busy} onClick={props.onClose}>
            <XIcon />
            Cancel
          </button>
          <button className="sheet-action primary" type="button" disabled={!data || props.busy || loading} onClick={() => data && props.onSelect(data.currentPath)}>
            <CheckIcon />
            {props.busy ? 'Creating...' : 'Select'}
          </button>
        </div>
      </section>
    </div>
  );
}

export function ActionsModal(props: {
  conversation: Conversation | null;
  renameTitle: string;
  setRenameTitle: (value: string) => void;
  isStreaming: boolean;
  onClose: () => void;
  onRename: () => void;
  onArchiveRestore: () => void;
  onDelete: () => void;
  onShare: () => void;
  onSessions: () => void;
  onFiles: () => void;
  onReset: () => void;
}) {
  return (
    <Modal title="Conversation" className="actions-modal" onClose={props.onClose}>
      <label>Title<input value={props.renameTitle} onChange={(event) => props.setRenameTitle(event.target.value)} /></label>
      <button className="action primary" type="button" disabled={!props.renameTitle.trim()} onClick={props.onRename}>
        <span className="ic"><EditIcon /></span>
        <span>Rename</span>
        <ChevronRightIcon />
      </button>
      <div className="actions">
        <button className="action" type="button" onClick={props.onShare}>
          <span className="ic"><ExternalIcon /></span>
          <span>Share Markdown</span>
          <ChevronRightIcon />
        </button>
        <button className="action" type="button" onClick={props.onSessions}>
          <span className="ic"><SessionsIcon /></span>
          <span>Sessions</span>
          <ChevronRightIcon />
        </button>
        <button className="action" type="button" onClick={props.onFiles}>
          <span className="ic"><FileIcon /></span>
          <span>Files</span>
          <ChevronRightIcon />
        </button>
        <button className="action" type="button" disabled={props.isStreaming} onClick={props.onReset}>
          <span className="ic"><ResetIcon /></span>
          <span>Reset Session</span>
          <ChevronRightIcon />
        </button>
        <button className="action" type="button" disabled={props.isStreaming} onClick={props.onArchiveRestore}>
          <span className="ic"><ArchiveIcon /></span>
          <span>{props.conversation?.archived ? 'Restore' : 'Archive'}</span>
          <ChevronRightIcon />
        </button>
        <button className="action danger" type="button" disabled={props.isStreaming} onClick={props.onDelete}>
          <span className="ic"><TrashIcon /></span>
          <span>Delete</span>
          <ChevronRightIcon />
        </button>
      </div>
    </Modal>
  );
}

export function MarkdownShareModal(props: {
  conversation: Conversation | null;
  onClose: () => void;
  onShare: (scope: MarkdownShareScope) => void;
}) {
  const sessionNumber = props.conversation?.sessionNumber || 1;
  return (
    <Modal
      title="Share Markdown"
      subtitle={`Session ${sessionNumber} is current`}
      className="markdown-share-modal"
      onClose={props.onClose}
    >
      <div className="actions">
        <button className="action" type="button" onClick={() => props.onShare('all')}>
          <span className="ic"><ExternalIcon /></span>
          <span className="action-copy">
            <strong>All sessions</strong>
            <small>Every session in this conversation</small>
          </span>
          <ChevronRightIcon />
        </button>
        <button className="action" type="button" onClick={() => props.onShare('current')}>
          <span className="ic"><SessionsIcon /></span>
          <span className="action-copy">
            <strong>Current session</strong>
            <small>Session {sessionNumber}</small>
          </span>
          <ChevronRightIcon />
        </button>
      </div>
    </Modal>
  );
}

export function RunSettingsModal(props: {
  profiles: Array<{ id: string; name: string }>;
  selectedCliProfileId?: string;
  selectedBackendMetadata?: BackendMetadata;
  selectedModel?: string;
  selectedEffort?: EffortLevel;
  selectedClaudeCodeMode?: ClaudeCodeMode | 'default';
  selectedServiceTier?: ServiceTier | 'default';
  claudeCodeModeEnabled: boolean;
  serviceTierEnabled: boolean;
  supportedEfforts: EffortLevel[];
  locked: boolean;
  onClose: () => void;
  onProfile: (id: string) => void;
  onModel: (id: string | undefined) => void;
  onEffort: (effort: EffortLevel | undefined) => void;
  onClaudeCodeMode: (mode: ClaudeCodeMode | 'default' | undefined) => void;
  onServiceTier: (serviceTier: ServiceTier | 'default' | undefined) => void;
}) {
  return (
    <Modal title="Run Settings" className="settings-modal" onClose={props.onClose}>
      <div className="modal-scroll run-settings-scroll">
        {props.locked ? <p className="meta">Profile is locked after a session has messages.</p> : null}
        <strong>Profile</strong>
        <div className="choice-grid">
          {props.profiles.map((profile) => <Choice key={profile.id} label={profile.name} selected={props.selectedCliProfileId === profile.id} disabled={props.locked} onClick={() => props.onProfile(profile.id)} />)}
        </div>
        <strong>Model</strong>
        <div className="choice-grid">
          {(props.selectedBackendMetadata?.models || []).map((model) => <Choice key={model.id} label={modelDisplayLabel(model)} selected={props.selectedModel === model.id} onClick={() => props.onModel(model.id)} />)}
        </div>
        {props.supportedEfforts.length ? (
          <>
            <strong>Effort</strong>
            <div className="choice-grid">
              {props.supportedEfforts.map((effort) => <Choice key={effort} label={effort} selected={props.selectedEffort === effort} onClick={() => props.onEffort(effort)} />)}
            </div>
          </>
        ) : null}
        {props.claudeCodeModeEnabled ? (
          <>
            <strong>Mode</strong>
            <div className="choice-grid">
              <Choice label="Default" selected={!props.selectedClaudeCodeMode || props.selectedClaudeCodeMode === 'default'} onClick={() => props.onClaudeCodeMode('default')} />
              <Choice label="Ultracode" selected={props.selectedClaudeCodeMode === 'ultracode'} onClick={() => props.onClaudeCodeMode('ultracode')} />
            </div>
          </>
        ) : null}
        {props.serviceTierEnabled ? (
          <>
            <strong>Speed</strong>
            <div className="choice-grid">
              <Choice label="Default" selected={!props.selectedServiceTier || props.selectedServiceTier === 'default'} onClick={() => props.onServiceTier('default')} />
              <Choice label="Fast" selected={props.selectedServiceTier === 'fast'} onClick={() => props.onServiceTier('fast')} />
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
