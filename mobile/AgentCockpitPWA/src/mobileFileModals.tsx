import { useMemo, type RefObject } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { formatBytes, type ExplorerUpload, type FilePreviewState } from './appModel';
import { EditIcon, FilePlusIcon, FolderPlusIcon, ParentIcon, ResetIcon, TrashIcon, UploadIcon } from './mobileIcons';
import { Button, ErrorBanner, Modal, ProgressBar } from './mobilePrimitives';
import type { AttachmentMeta, ExplorerEntry, ExplorerPreviewResponse } from './types';

export function FilesModal(props: {
  path: string;
  parent: string | null;
  entries: ExplorerEntry[];
  preview: ExplorerPreviewResponse | null;
  editContent: string;
  uploads: ExplorerUpload[];
  uploadInputRef: RefObject<HTMLInputElement | null>;
  onEditContent: (value: string) => void;
  onClose: () => void;
  onParent: () => void;
  onRefresh: () => void;
  onEntry: (entry: ExplorerEntry) => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onUploadFiles: (files: FileList | null) => void;
  onRenameEntry: (entry: ExplorerEntry) => void;
  onDeleteEntry: (entry: ExplorerEntry) => void;
  onSavePreview: () => void;
  onRenamePreview: () => void;
  onDeletePreview: () => void;
  onOpenPreviewFile: () => void;
  onSharePreviewFile: () => void;
  onCancelUpload: (upload: ExplorerUpload) => void;
}) {
  return (
    <Modal title="Files" subtitle={props.path || '/'} className="files-modal" onClose={props.onClose} full>
      <div className="files-toolbar">
        <button className={`ftb ${props.path ? '' : 'muted'}`} type="button" disabled={!props.path} onClick={props.onParent}>
          <ParentIcon />
          Parent
        </button>
        <button className="ftb" type="button" onClick={props.onRefresh}>
          <ResetIcon />
          Refresh
        </button>
        <button className="ftb" type="button" onClick={props.onNewFolder}>
          <FolderPlusIcon />
          New folder
        </button>
        <button className="ftb" type="button" onClick={props.onNewFile}>
          <FilePlusIcon />
          New file
        </button>
        <button className="ftb primary" type="button" onClick={() => props.uploadInputRef.current?.click()}>
          <UploadIcon />
          Upload
        </button>
      </div>
      <input ref={props.uploadInputRef} className="hidden-input" type="file" multiple onChange={(event) => props.onUploadFiles(event.currentTarget.files)} />
      <div className="modal-scroll">
        {props.uploads.length ? (
          <section className="upload-panel">
            <strong>Uploads</strong>
            {props.uploads.map((upload) => (
              <div key={upload.id} className="upload-row">
                <div>
                  <strong>{upload.fileName}</strong>
                  <span className={upload.status === 'error' ? 'error-text' : 'meta'}>
                    {upload.status === 'uploading' ? `Uploading ${upload.progress ?? 0}%` : upload.status === 'done' ? 'Uploaded' : upload.error || 'Upload failed'}
                  </span>
                  {upload.status === 'uploading' ? <ProgressBar progress={upload.progress || 0} /> : null}
                </div>
                <Button label={upload.status === 'uploading' ? 'Cancel' : 'Clear'} onClick={() => props.onCancelUpload(upload)} />
              </div>
            ))}
          </section>
        ) : null}
        {props.entries.map((entry) => (
          <article key={`${entry.type}-${entry.name}`} className={`list-row file-entry ${entry.type}`}>
            <button className="file-entry-main" type="button" onClick={() => props.onEntry(entry)}>
              <span className="file-icon" aria-hidden="true" />
              <span className="file-info">
                <strong>{entry.name}</strong>
                {entry.size !== undefined ? <span>{formatBytes(entry.size)}</span> : null}
              </span>
            </button>
            <div className="file-entry-actions">
              <button className="file-entry-action" type="button" aria-label={`Rename ${entry.name}`} onClick={() => props.onRenameEntry(entry)}>
                <EditIcon />
              </button>
              <button className="file-entry-action danger" type="button" aria-label={`Delete ${entry.name}`} onClick={() => props.onDeleteEntry(entry)}>
                <TrashIcon />
              </button>
            </div>
          </article>
        ))}
        {props.preview ? (
          <section className="preview-panel">
            <div className="row">
              <strong>{props.preview.path}</strong>
              <div className="button-row">
                <Button label="Save" variant="primary" onClick={props.onSavePreview} />
                <Button label="Open" onClick={props.onOpenPreviewFile} />
                <Button label="Copy" onClick={() => void navigator.clipboard.writeText(props.editContent || props.preview?.content || '')} />
                <Button label="Share File" onClick={props.onSharePreviewFile} />
                <Button label="Rename" onClick={props.onRenamePreview} />
                <Button label="Delete" variant="danger" onClick={props.onDeletePreview} />
              </div>
            </div>
            <textarea className="editor" value={props.editContent} onChange={(event) => props.onEditContent(event.target.value)} />
          </section>
        ) : null}
      </div>
    </Modal>
  );
}

export function FilePreviewModal(props: {
  preview: FilePreviewState;
  loading: boolean;
  onClose: () => void;
  onCopy: () => void;
  onShare: () => void;
}) {
  return (
    <Modal title={props.preview.title || 'File'} subtitle={props.preview.path} onClose={props.onClose} full>
      <div className="button-row">
        {props.preview.content ? <Button label="Copy" onClick={props.onCopy} /> : null}
        <Button label="Share File" variant="primary" onClick={props.onShare} />
      </div>
      {props.loading ? <div className="mini-spinner" /> : null}
      {props.preview.error ? <ErrorBanner message={props.preview.error} /> : null}
      {props.preview.imageURL ? <img className="preview-image" src={props.preview.imageURL} alt={props.preview.title} /> : null}
      {props.preview.content && isMarkdownPreview(props.preview) ? (
        <MarkdownPreview content={props.preview.truncated ? `Preview truncated.\n\n${props.preview.content}` : props.preview.content} />
      ) : props.preview.content ? (
        <pre className="code-preview">{props.preview.truncated ? 'Preview truncated.\n\n' : ''}{props.preview.content}</pre>
      ) : null}
    </Modal>
  );
}

function MarkdownPreview(props: { content: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(props.content || '', { breaks: true, gfm: true, async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [props.content]);
  return <div className="markdown-body file-preview-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function isMarkdownPreview(preview: FilePreviewState): boolean {
  const language = String(preview.language || '').toLowerCase();
  const mimeType = String(preview.mimeType || '').toLowerCase();
  return language === 'md'
    || language === 'markdown'
    || mimeType === 'text/markdown'
    || /\.md$/i.test(preview.title || '')
    || /\.md$/i.test(preview.path || '');
}

export function QueueEditorModal(props: {
  content: string;
  attachments: AttachmentMeta[];
  onContentChange: (value: string) => void;
  onRemoveAttachment: (path: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <Modal title="Edit Queue Item" onClose={props.onCancel}>
      <label>Message<textarea value={props.content} onChange={(event) => props.onContentChange(event.target.value)} rows={6} /></label>
      {props.attachments.length ? (
        <section className="preview-panel">
          <strong>Attachments</strong>
          {props.attachments.map((attachment) => (
            <div key={attachment.path} className="upload-row">
              <div>
                <strong>{attachment.name}</strong>
                <span>{attachment.path}</span>
              </div>
              <Button label="Remove" onClick={() => props.onRemoveAttachment(attachment.path)} />
            </div>
          ))}
        </section>
      ) : null}
      <div className="modal-actions">
        <Button label="Save" variant="primary" disabled={!props.content.trim() && !props.attachments.length} onClick={props.onSave} />
      </div>
    </Modal>
  );
}
