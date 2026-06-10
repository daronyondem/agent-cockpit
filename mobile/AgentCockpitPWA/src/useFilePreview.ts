import { useState } from 'react';
import { AgentAPIError } from './api';
import { downloadBlob, type FilePreviewState, type FileReference } from './appModel';

type UseFilePreviewOptions = {
  onError: (error: unknown) => void;
};

export function useFilePreview(options: UseFilePreviewOptions) {
  const [filePreview, setFilePreview] = useState<FilePreviewState | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);

  async function openFileReference(reference: FileReference) {
    setFilePreview({ title: reference.title, path: reference.path, downloadURL: reference.downloadURL, mimeType: reference.mimeType });
    setFilePreviewLoading(true);
    try {
      if (reference.isImage) {
        setFilePreview({
          title: reference.title,
          path: reference.path,
          downloadURL: reference.downloadURL,
          imageURL: reference.downloadURL,
          mimeType: reference.mimeType,
        });
        return;
      }
      if (reference.fetchPreview) {
        const preview = await reference.fetchPreview();
        setFilePreview({
          title: reference.title,
          path: preview.path || reference.path,
          downloadURL: reference.downloadURL,
          content: preview.content,
          language: preview.language,
          mimeType: preview.mimeType || reference.mimeType,
          truncated: preview.truncated,
        });
        return;
      }
      setFilePreview({ title: reference.title, path: reference.path, downloadURL: reference.downloadURL, error: 'Preview unavailable.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preview failed.';
      setFilePreview({ title: reference.title, path: reference.path, downloadURL: reference.downloadURL, error: message });
    } finally {
      setFilePreviewLoading(false);
    }
  }

  async function shareFileReference(reference: FileReference) {
    try {
      const response = await fetch(reference.downloadURL, { credentials: 'same-origin' });
      if (!response.ok) {
        throw new AgentAPIError(`File download failed with HTTP ${response.status}.`, response.status);
      }
      const blob = await response.blob();
      const file = new File([blob], reference.title, { type: blob.type || reference.mimeType || 'application/octet-stream' });
      if (navigator.canShare?.({ files: [file] }) && navigator.share) {
        await navigator.share({ title: reference.title, files: [file] });
        return;
      }
      downloadBlob(blob, reference.title);
    } catch (error) {
      options.onError(error);
    }
  }

  function copyFilePreview() {
    if (filePreview?.content) {
      void navigator.clipboard.writeText(filePreview.content);
    }
  }

  function closeFilePreview() {
    setFilePreview(null);
  }

  return {
    filePreview,
    filePreviewLoading,
    openFileReference,
    shareFileReference,
    copyFilePreview,
    closeFilePreview,
  };
}
