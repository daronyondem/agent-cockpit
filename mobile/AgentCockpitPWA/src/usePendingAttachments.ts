import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { applyConversationRuntimeSelection } from './appModel';
import type { AgentCockpitAPI } from './api';
import type { Conversation, Message, PendingAttachment } from './types';

type UsePendingAttachmentsOptions = {
  activeConversation: Conversation | null;
  activeConversationRef: RefObject<Conversation | null>;
  clientRef: RefObject<AgentCockpitAPI>;
  selectedBackend: string | undefined;
  selectedCliProfileId: string | undefined;
  setActiveConversation: Dispatch<SetStateAction<Conversation | null>>;
  applyServerMessage: (conversationID: string, message: Message | null | undefined) => void;
  appendToDraft: (text: string) => void;
};

export function usePendingAttachments(options: UsePendingAttachmentsOptions) {
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const hasUploadingAttachments = pendingAttachments.some((attachment) => attachment.status === 'uploading');

  async function handleAttachmentFiles(files: FileList | null) {
    const conversation = options.activeConversation;
    if (!conversation || !files?.length) {
      return;
    }
    for (const file of Array.from(files)) {
      const attachmentID = `${Date.now()}-${file.name}-${Math.random().toString(16).slice(2)}`;
      setPendingAttachments((current) => [...current, { id: attachmentID, fileName: file.name, status: 'uploading', progress: 0 }]);
      options.clientRef.current
        .uploadFile(conversation.id, file, {
          onProgress: (progress) => {
            setPendingAttachments((current) => current.map((item) => (item.id === attachmentID ? { ...item, progress } : item)));
          },
          onXhr: (xhr) => {
            setPendingAttachments((current) => current.map((item) => (item.id === attachmentID ? { ...item, xhr } : item)));
          },
        })
        .then((uploaded) => {
          setPendingAttachments((current) =>
            current.map((item) => (item.id === attachmentID ? { ...item, status: 'done', progress: 100, result: uploaded, xhr: undefined } : item)),
          );
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Upload failed.';
          setPendingAttachments((current) =>
            current.map((item) => (item.id === attachmentID ? { ...item, status: 'error', error: message, xhr: undefined } : item)),
          );
        });
    }
    if (attachInputRef.current) {
      attachInputRef.current.value = '';
    }
  }

  async function removePendingAttachment(id: string) {
    const conversation = options.activeConversation;
    const attachment = pendingAttachments.find((item) => item.id === id);
    attachment?.xhr?.abort();
    setPendingAttachments((current) => current.filter((item) => item.id !== id));
    if (conversation && !attachment?.xhr && attachment?.result?.name) {
      await options.clientRef.current.deleteUpload(conversation.id, attachment.result.name).catch(() => undefined);
    }
  }

  async function ocrPendingAttachment(id: string) {
    const conversation = options.activeConversation;
    const attachment = pendingAttachments.find((item) => item.id === id);
    const path = attachment?.result?.path;
    if (!conversation || !attachment || !path) {
      return;
    }
    if (attachment.ocrMarkdown) {
      options.appendToDraft(attachment.ocrMarkdown);
      return;
    }
    setPendingAttachments((current) =>
      current.map((item) => (item.id === id ? { ...item, ocrStatus: 'running', ocrError: undefined } : item)),
    );
    try {
      const ocrResponse = await options.clientRef.current.ocrAttachment(conversation.id, path, {
        backend: options.selectedBackend,
        cliProfileId: options.selectedCliProfileId,
      });
      const markdown = ocrResponse.markdown || '';
      options.applyServerMessage(conversation.id, ocrResponse.recoveryMessage);
      options.setActiveConversation((current) => {
        if (!current || current.id !== conversation.id) return current;
        const next = applyConversationRuntimeSelection(current, {
          backend: options.selectedBackend,
          cliProfileId: options.selectedCliProfileId,
        });
        options.activeConversationRef.current = next;
        return next;
      });
      setPendingAttachments((current) =>
        current.map((item) => (item.id === id ? { ...item, ocrStatus: 'done', ocrMarkdown: markdown } : item)),
      );
      options.appendToDraft(markdown);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OCR failed.';
      setPendingAttachments((current) =>
        current.map((item) => (item.id === id ? { ...item, ocrStatus: 'error', ocrError: message } : item)),
      );
    }
  }

  return {
    attachInputRef,
    pendingAttachments,
    setPendingAttachments,
    hasUploadingAttachments,
    handleAttachmentFiles,
    removePendingAttachment,
    ocrPendingAttachment,
  };
}
