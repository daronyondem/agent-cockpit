import { useRef, useState, type RefObject } from 'react';
import { AgentAPIError } from './api';
import {
  isImageFileName,
  joinExplorerPath,
  makeExplorerFileReference,
  parentExplorerPath,
  workspaceRef,
  type ExplorerUpload,
  type FileReference,
} from './appModel';
import type { AgentCockpitAPI } from './api';
import type { Conversation, ExplorerEntry, ExplorerPreviewResponse } from './types';

type UseWorkspaceExplorerOptions = {
  activeConversation: Conversation | null;
  clientRef: RefObject<AgentCockpitAPI>;
  onError: (error: unknown) => void;
  openFileReference: (reference: FileReference) => Promise<void> | void;
  shareFileReference: (reference: FileReference) => Promise<void> | void;
};

export function useWorkspaceExplorer(options: UseWorkspaceExplorerOptions) {
  const explorerUploadInputRef = useRef<HTMLInputElement | null>(null);
  const [filesVisible, setFilesVisible] = useState(false);
  const [explorerPath, setExplorerPath] = useState('');
  const [explorerParent, setExplorerParent] = useState<string | null>(null);
  const [explorerEntries, setExplorerEntries] = useState<ExplorerEntry[]>([]);
  const [explorerPreview, setExplorerPreview] = useState<ExplorerPreviewResponse | null>(null);
  const [explorerEditContent, setExplorerEditContent] = useState('');
  const [explorerUploads, setExplorerUploads] = useState<ExplorerUpload[]>([]);

  async function openFiles() {
    setFilesVisible(true);
    setExplorerEditContent('');
    await loadExplorer('');
  }

  async function loadExplorer(path: string) {
    const conversation = options.activeConversation;
    if (!conversation) {
      return;
    }
    try {
      const tree = await options.clientRef.current.getExplorerTree(workspaceRef(conversation), path);
      setExplorerPath(tree.path || '');
      setExplorerParent(tree.parent ?? null);
      setExplorerEntries(tree.entries || []);
      setExplorerPreview(null);
      setExplorerEditContent('');
    } catch (error) {
      options.onError(error);
    }
  }

  async function openExplorerEntry(entry: ExplorerEntry) {
    const conversation = options.activeConversation;
    if (!conversation) {
      return;
    }
    const entryPath = joinExplorerPath(explorerPath, entry.name);
    if (entry.type === 'dir') {
      await loadExplorer(entryPath);
      return;
    }
    if (isImageFileName(entry.name)) {
      await options.openFileReference(makeExplorerFileReference(options.clientRef.current, workspaceRef(conversation), entryPath));
      return;
    }
    try {
      const preview = await options.clientRef.current.getExplorerPreview(workspaceRef(conversation), entryPath);
      setExplorerPreview(preview);
      setExplorerEditContent(preview.content);
    } catch (error) {
      if (error instanceof AgentAPIError && (error.status === 413 || error.status === 415)) {
        await options.openFileReference(makeExplorerFileReference(options.clientRef.current, workspaceRef(conversation), entryPath));
        return;
      }
      options.onError(error);
    }
  }

  async function createExplorerFolder() {
    const conversation = options.activeConversation;
    const name = window.prompt('Folder name');
    if (!conversation || !name?.trim()) {
      return;
    }
    try {
      await options.clientRef.current.createExplorerFolder(workspaceRef(conversation), explorerPath, name.trim());
      await loadExplorer(explorerPath);
    } catch (error) {
      options.onError(error);
    }
  }

  async function createExplorerFile() {
    const conversation = options.activeConversation;
    const name = window.prompt('File name');
    if (!conversation || !name?.trim()) {
      return;
    }
    try {
      const created = await options.clientRef.current.createExplorerFile(workspaceRef(conversation), explorerPath, name.trim());
      await loadExplorer(explorerPath);
      if (created.path) {
        const preview = await options.clientRef.current.getExplorerPreview(workspaceRef(conversation), created.path);
        setExplorerPreview(preview);
        setExplorerEditContent(preview.content);
      }
    } catch (error) {
      options.onError(error);
    }
  }

  async function saveExplorerPreview() {
    const conversation = options.activeConversation;
    if (!conversation || !explorerPreview) {
      return;
    }
    try {
      await options.clientRef.current.saveExplorerFile(workspaceRef(conversation), explorerPreview.path, explorerEditContent);
      const preview = await options.clientRef.current.getExplorerPreview(workspaceRef(conversation), explorerPreview.path);
      setExplorerPreview(preview);
      setExplorerEditContent(preview.content);
      await loadExplorer(explorerPath);
    } catch (error) {
      options.onError(error);
    }
  }

  async function renameExplorerPath(fromPath: string) {
    const conversation = options.activeConversation;
    const nextPath = window.prompt('New workspace-relative path', fromPath);
    if (!conversation || !nextPath?.trim() || nextPath.trim() === fromPath) {
      return;
    }
    try {
      await options.clientRef.current.renameExplorerEntry(workspaceRef(conversation), fromPath, nextPath.trim());
      await loadExplorer(parentExplorerPath(nextPath.trim()));
    } catch (error) {
      if (error instanceof AgentAPIError && error.status === 409 && window.confirm('Destination exists. Overwrite it?')) {
        await options.clientRef.current.renameExplorerEntry(workspaceRef(conversation), fromPath, nextPath.trim(), true);
        await loadExplorer(parentExplorerPath(nextPath.trim()));
        return;
      }
      options.onError(error);
    }
  }

  async function deleteExplorerPath(path: string) {
    const conversation = options.activeConversation;
    if (!conversation || !window.confirm(`Delete ${path}?`)) {
      return;
    }
    try {
      await options.clientRef.current.deleteExplorerEntry(workspaceRef(conversation), path);
      await loadExplorer(explorerPath);
    } catch (error) {
      options.onError(error);
    }
  }

  async function uploadExplorerFiles(files: FileList | null) {
    const conversation = options.activeConversation;
    if (!conversation || !files?.length) {
      return;
    }
    for (const file of Array.from(files)) {
      void uploadExplorerFile(file);
    }
    if (explorerUploadInputRef.current) {
      explorerUploadInputRef.current.value = '';
    }
  }

  async function uploadExplorerFile(file: File, overwrite = false, existingID?: string) {
    const conversation = options.activeConversation;
    if (!conversation) {
      return;
    }
    const id = existingID || `${Date.now()}-${file.name}-${Math.random().toString(16).slice(2)}`;
    if (!existingID) {
      setExplorerUploads((current) => [...current, { id, fileName: file.name, status: 'uploading', progress: 0 }]);
    } else {
      setExplorerUploads((current) => current.map((item) => (item.id === id ? { ...item, status: 'uploading', progress: 0, error: undefined } : item)));
    }
    try {
      await options.clientRef.current.uploadExplorerFile(workspaceRef(conversation), explorerPath, file, overwrite, {
        onProgress: (progress) => setExplorerUploads((current) => current.map((item) => (item.id === id ? { ...item, progress } : item))),
        onXhr: (xhr) => setExplorerUploads((current) => current.map((item) => (item.id === id ? { ...item, xhr } : item))),
      });
      setExplorerUploads((current) => current.map((item) => (item.id === id ? { ...item, status: 'done', progress: 100, xhr: undefined } : item)));
      await loadExplorer(explorerPath);
    } catch (error) {
      if (error instanceof AgentAPIError && error.status === 409 && !overwrite) {
        setExplorerUploads((current) => current.map((item) => (item.id === id ? { ...item, status: 'error', error: 'File exists', xhr: undefined } : item)));
        if (window.confirm(`${file.name} already exists. Overwrite it?`)) {
          await uploadExplorerFile(file, true, id);
        }
        return;
      }
      const message = error instanceof Error ? error.message : 'Upload failed.';
      setExplorerUploads((current) => current.map((item) => (item.id === id ? { ...item, status: 'error', error: message, xhr: undefined } : item)));
    }
  }

  function clearOrCancelExplorerUpload(upload: ExplorerUpload) {
    upload.xhr?.abort();
    setExplorerUploads((current) => current.filter((item) => item.id !== upload.id));
  }

  function closeFiles() {
    setFilesVisible(false);
  }

  function loadParent() {
    void loadExplorer(explorerParent ?? '');
  }

  function refreshExplorer() {
    void loadExplorer(explorerPath);
  }

  function renameExplorerEntry(entry: ExplorerEntry) {
    void renameExplorerPath(joinExplorerPath(explorerPath, entry.name));
  }

  function deleteExplorerEntry(entry: ExplorerEntry) {
    void deleteExplorerPath(joinExplorerPath(explorerPath, entry.name));
  }

  function renameExplorerPreview() {
    if (explorerPreview) void renameExplorerPath(explorerPreview.path);
  }

  function deleteExplorerPreview() {
    if (explorerPreview) void deleteExplorerPath(explorerPreview.path);
  }

  function openExplorerPreviewFile() {
    if (options.activeConversation && explorerPreview) {
      void options.openFileReference(makeExplorerFileReference(options.clientRef.current, workspaceRef(options.activeConversation), explorerPreview.path));
    }
  }

  function shareExplorerPreviewFile() {
    if (options.activeConversation && explorerPreview) {
      void options.shareFileReference(makeExplorerFileReference(options.clientRef.current, workspaceRef(options.activeConversation), explorerPreview.path));
    }
  }

  return {
    filesVisible,
    explorerPath,
    explorerParent,
    explorerEntries,
    explorerPreview,
    explorerEditContent,
    explorerUploads,
    explorerUploadInputRef,
    setExplorerEditContent,
    openFiles,
    closeFiles,
    loadExplorer,
    loadParent,
    refreshExplorer,
    openExplorerEntry,
    createExplorerFolder,
    createExplorerFile,
    uploadExplorerFiles,
    renameExplorerEntry,
    deleteExplorerEntry,
    saveExplorerPreview,
    renameExplorerPreview,
    deleteExplorerPreview,
    openExplorerPreviewFile,
    shareExplorerPreviewFile,
    clearOrCancelExplorerUpload,
  };
}
