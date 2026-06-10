import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { AgentCockpitAPI } from './api';
import type { AttachmentMeta, Conversation } from './types';

type UseQueueEditorOptions = {
  activeConversation: Conversation | null;
  clientRef: RefObject<AgentCockpitAPI>;
  setActiveConversation: Dispatch<SetStateAction<Conversation | null>>;
  onError: (error: unknown) => void;
};

export function useQueueEditor(options: UseQueueEditorOptions) {
  const [queueEditorIndex, setQueueEditorIndex] = useState<number | null>(null);
  const [queueEditorContent, setQueueEditorContent] = useState('');
  const [queueEditorAttachments, setQueueEditorAttachments] = useState<AttachmentMeta[]>([]);

  async function removeQueuedMessage(index: number) {
    const conversation = options.activeConversation;
    if (!conversation) {
      return;
    }
    try {
      const queue = [...(conversation.messageQueue || [])];
      queue.splice(index, 1);
      const saved = await options.clientRef.current.saveQueue(conversation.id, queue);
      options.setActiveConversation({ ...conversation, messageQueue: saved });
    } catch (error) {
      options.onError(error);
    }
  }

  async function moveQueuedMessage(index: number, direction: -1 | 1) {
    const conversation = options.activeConversation;
    if (!conversation) {
      return;
    }
    const queue = [...(conversation.messageQueue || [])];
    const target = index + direction;
    if (target < 0 || target >= queue.length) {
      return;
    }
    [queue[index], queue[target]] = [queue[target], queue[index]];
    try {
      const saved = await options.clientRef.current.saveQueue(conversation.id, queue);
      options.setActiveConversation({ ...conversation, messageQueue: saved });
    } catch (error) {
      options.onError(error);
    }
  }

  function openQueueEditor(index: number) {
    const item = options.activeConversation?.messageQueue?.[index];
    if (!item) {
      return;
    }
    setQueueEditorIndex(index);
    setQueueEditorContent(item.content || '');
    setQueueEditorAttachments(item.attachments || []);
  }

  async function saveQueueEditor() {
    const conversation = options.activeConversation;
    if (!conversation || queueEditorIndex === null) {
      return;
    }
    const content = queueEditorContent.trim();
    if (!content && !queueEditorAttachments.length) {
      await removeQueuedMessage(queueEditorIndex);
      closeQueueEditor();
      return;
    }
    try {
      const queue = [...(conversation.messageQueue || [])];
      queue[queueEditorIndex] = {
        content,
        attachments: queueEditorAttachments.length ? queueEditorAttachments : undefined,
      };
      const saved = await options.clientRef.current.saveQueue(conversation.id, queue);
      options.setActiveConversation({ ...conversation, messageQueue: saved });
      closeQueueEditor();
    } catch (error) {
      options.onError(error);
    }
  }

  function closeQueueEditor() {
    setQueueEditorIndex(null);
    setQueueEditorContent('');
    setQueueEditorAttachments([]);
  }

  async function clearQueue() {
    const conversation = options.activeConversation;
    if (!conversation) {
      return;
    }
    try {
      await options.clientRef.current.clearQueue(conversation.id);
      options.setActiveConversation({ ...conversation, messageQueue: [] });
    } catch (error) {
      options.onError(error);
    }
  }

  function removeQueueEditorAttachment(path: string) {
    setQueueEditorAttachments((items) => items.filter((attachment) => attachment.path !== path));
  }

  return {
    queueEditorIndex,
    queueEditorContent,
    queueEditorAttachments,
    setQueueEditorContent,
    removeQueueEditorAttachment,
    removeQueuedMessage,
    moveQueuedMessage,
    openQueueEditor,
    saveQueueEditor,
    closeQueueEditor,
    clearQueue,
  };
}
