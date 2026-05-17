import type { AgentCockpitAPI } from './api';
import type {
  AttachmentMeta,
  Conversation,
  ConversationArtifact,
  ConversationListItem,
  CurrentUser,
  EffortLevel,
  ExplorerPreviewResponse,
  FilePreviewResponse,
  Message,
  PendingAttachment,
  QueuedMessage,
  ResetSessionResponse,
  SessionHistoryItem,
  ThreadGoal,
} from './types';

export const ALL_WORKSPACES = 'all';

const effortOrder: EffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export type ExplorerUpload = {
  id: string;
  fileName: string;
  status: 'uploading' | 'done' | 'error';
  progress?: number;
  error?: string;
  xhr?: XMLHttpRequest;
};

export type FileReference = {
  id: string;
  title: string;
  path: string;
  downloadURL: string;
  isImage?: boolean;
  mimeType?: string;
  fetchPreview?: () => Promise<FilePreviewResponse | ExplorerPreviewResponse>;
};

export type FilePreviewState = {
  title: string;
  path: string;
  downloadURL: string;
  content?: string;
  imageURL?: string;
  mimeType?: string;
  truncated?: boolean;
  error?: string;
};

export function parseMessageFiles(content: string): { text: string; uploadedPaths: string[]; deliveredPaths: string[] } {
  const deliveredPaths: string[] = [];
  let text = content.replace(/<!--\s*FILE_DELIVERY:([\s\S]*?)-->/g, (_match, path: string) => {
    const trimmed = path.trim();
    if (trimmed) deliveredPaths.push(trimmed);
    return '';
  });
  const uploadedPaths: string[] = [];
  const uploadMatch = text.match(/\n*\[Uploaded files?:\s*([^\]]+)\]\s*$/i);
  if (uploadMatch) {
    uploadedPaths.push(...(uploadMatch[1] || '').split(',').map((path) => path.trim()).filter(Boolean));
    text = text.slice(0, uploadMatch.index).trimEnd();
  }
  return { text: text.trim(), uploadedPaths, deliveredPaths };
}

export function displayMessagePreview(content: string): string {
  const parsed = parseMessageFiles(content);
  if (parsed.text) {
    return parsed.text;
  }
  if (parsed.uploadedPaths.length) {
    const names = parsed.uploadedPaths.map(basenameFromPath).join(', ');
    return `${parsed.uploadedPaths.length === 1 ? 'Attachment' : `${parsed.uploadedPaths.length} attachments`}: ${names}`;
  }
  if (parsed.deliveredPaths.length) {
    const names = parsed.deliveredPaths.map(basenameFromPath).join(', ');
    return `${parsed.deliveredPaths.length === 1 ? 'File' : `${parsed.deliveredPaths.length} files`}: ${names}`;
  }
  return content;
}

export function fileReferencesFromParsed(
  client: AgentCockpitAPI,
  conversation: Conversation,
  role: Message['role'],
  parsed: { uploadedPaths: string[]; deliveredPaths: string[] },
): FileReference[] {
  const references: FileReference[] = [];
  if (role === 'user') {
    references.push(...parsed.uploadedPaths.map((path) => makeConversationUploadReference(client, conversation, path)));
  }
  references.push(...parsed.deliveredPaths.map((path) => makeWorkspaceFileReference(client, conversation.workspaceHash, path)));
  return references;
}

function makeConversationUploadReference(client: AgentCockpitAPI, conversation: Conversation, path: string): FileReference {
  const title = basenameFromPath(path);
  return {
    id: `conversation:${conversation.id}:${path}`,
    title,
    path,
    downloadURL: client.conversationFileURL(conversation.id, title, 'download'),
    isImage: isImageFileName(title),
    fetchPreview: () => client.getConversationFilePreview(conversation.id, title),
  };
}

export function makeConversationArtifactReference(client: AgentCockpitAPI, conversation: Conversation, artifact: ConversationArtifact): FileReference {
  const title = artifact.title || artifact.filename || basenameFromPath(artifact.path);
  const filename = artifact.filename || basenameFromPath(artifact.path);
  return {
    id: `artifact:${conversation.id}:${filename}:${artifact.sourceToolId || ''}`,
    title,
    path: artifact.path || filename,
    downloadURL: client.conversationFileURL(conversation.id, filename, 'download'),
    isImage: artifact.kind === 'image' || isImageFileName(filename),
    mimeType: artifact.mimeType,
    fetchPreview: () => client.getConversationFilePreview(conversation.id, filename),
  };
}

export function makeWorkspaceFileReference(client: AgentCockpitAPI, workspaceHash: string, path: string): FileReference {
  const title = basenameFromPath(path);
  return {
    id: `workspace:${workspaceHash}:${path}`,
    title,
    path,
    downloadURL: client.workspaceFileURL(workspaceHash, path, 'download'),
    isImage: isImageFileName(title),
    fetchPreview: () => client.getWorkspaceFilePreview(workspaceHash, path),
  };
}

export function makeExplorerFileReference(client: AgentCockpitAPI, workspaceHash: string, path: string): FileReference {
  const title = basenameFromPath(path);
  return {
    id: `explorer:${workspaceHash}:${path}`,
    title,
    path,
    downloadURL: client.explorerFileURL(workspaceHash, path, 'download'),
    isImage: isImageFileName(title),
    fetchPreview: () => client.getExplorerPreview(workspaceHash, path),
  };
}

export function conversationListItemFromConversation(conversation: Conversation): ConversationListItem {
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: new Date().toISOString(),
    backend: conversation.backend,
    cliProfileId: conversation.cliProfileId,
    model: conversation.model,
    effort: conversation.effort,
    serviceTier: conversation.serviceTier,
    workingDir: conversation.workingDir,
    workspaceHash: conversation.workspaceHash,
    workspaceKbEnabled: false,
    messageCount: conversation.messages.length,
    lastMessage: conversation.messages.at(-1)?.content || null,
    usage: conversation.usage || null,
    archived: conversation.archived,
  };
}

export function updateSessionsAfterReset(sessions: SessionHistoryItem[], response: ResetSessionResponse): SessionHistoryItem[] {
  const archived = response.archivedSession;
  const updated = sessions.map((session) => {
    if (archived && session.number === archived.number) {
      return {
        ...session,
        sessionId: archived.sessionId || session.sessionId,
        startedAt: archived.startedAt,
        endedAt: archived.endedAt,
        messageCount: archived.messageCount,
        summary: archived.summary || null,
        isCurrent: false,
      };
    }
    return { ...session, isCurrent: false };
  });
  if (!updated.some((session) => session.number === response.newSessionNumber)) {
    updated.push({
      number: response.newSessionNumber,
      sessionId: response.conversation.currentSessionId,
      startedAt: new Date().toISOString(),
      endedAt: null,
      messageCount: 0,
      summary: null,
      isCurrent: true,
    });
  }
  return updated.map((session) => (
    session.number === response.newSessionNumber
      ? { ...session, isCurrent: true, messageCount: 0, summary: null, endedAt: null }
      : session
  ));
}

export function wireContent(message: QueuedMessage): string {
  const paths = (message.attachments || []).map((attachment) => attachment.path).filter(Boolean);
  if (!paths.length) return message.content;
  const tag = `[Uploaded files: ${paths.join(', ')}]`;
  return message.content.trim() ? `${message.content}\n\n${tag}` : tag;
}

export function completedAttachmentMetas(attachments: PendingAttachment[]): AttachmentMeta[] {
  return attachments.map((attachment) => attachment.result).filter(Boolean) as AttachmentMeta[];
}

export function upsertMessage(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index === -1) return [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
}

export function replaceMessageByID(messages: Message[], id: string, replacement: Message): Message[] {
  const next: Message[] = [];
  let replaced = false;
  for (const message of messages) {
    if (message.id === id && !replaced) {
      next.push(replacement);
      replaced = true;
      continue;
    }
    if (message.id === replacement.id) {
      continue;
    }
    next.push(message);
  }
  return replaced ? next : [...next, replacement];
}

export function removeMessagesByID(messages: Message[], ids: string[]): Message[] {
  if (!ids.length) return messages;
  const blocked = new Set(ids);
  return messages.filter((message) => !blocked.has(message.id));
}

export function userLabel(user: CurrentUser | null): string {
  if (!user) return 'Not loaded';
  return user.displayName || user.email || 'Local session';
}

export function reconcileEffort(current: EffortLevel | undefined, supported: EffortLevel[]): EffortLevel | undefined {
  if (!supported.length) return undefined;
  if (current && supported.includes(current)) return current;
  if (supported.includes('high')) return 'high';
  return supported.slice().sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b))[0];
}

export function lastTwoPathComponents(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return path || 'Default workspace';
  return parts.slice(-2).join('/');
}

export function workspaceOptions(conversations: ConversationListItem[]): Array<{ hash: string; label: string; fullPath: string }> {
  const byHash = new Map<string, { label: string; fullPath: string }>();
  for (const conversation of conversations) {
    if (!byHash.has(conversation.workspaceHash)) {
      byHash.set(conversation.workspaceHash, {
        label: lastTwoPathComponents(conversation.workingDir),
        fullPath: conversation.workingDir,
      });
    }
  }
  return Array.from(byHash, ([hash, workspace]) => ({ hash, ...workspace })).sort((a, b) => a.label.localeCompare(b.label));
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatPercent(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toString()}%`;
}

export function goalTimestampMs(value: unknown): number | null {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return timestamp >= 1e12 ? Math.floor(timestamp) : Math.floor(timestamp * 1000);
}

export function goalSnapshotTimeMs(goal: Pick<ThreadGoal, 'createdAt' | 'updatedAt'> | null | undefined): number | null {
  if (!goal || typeof goal !== 'object') return null;
  return goalTimestampMs(goal.updatedAt) || goalTimestampMs(goal.createdAt);
}

export function cleanGoalObjectiveText(value: unknown): string {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  for (let i = 0; i < 4; i += 1) {
    const before = text;
    let strippedPrefix = false;
    const withoutStatusPrefix = text.replace(
      /^Goal\s*(?:active|paused|achieved|budget\s*limited|cleared|updated)(?=\s|:|\d|$)\s*(?:\d+\s*(?:s|m|h|sec|secs|seconds|min|mins|minutes|hr|hrs|hours)\s*)*/i,
      '',
    ).trim();
    if (withoutStatusPrefix !== text) {
      text = withoutStatusPrefix;
      strippedPrefix = true;
    }
    const withoutEventPrefix = text.replace(
      /^Goal\s*(?:set(?=\s|:|codex|claude-code|claude-code-interactive|$)|resumed(?=\s|:|codex|claude-code|claude-code-interactive|$)|paused(?=\s|:|codex|claude-code|claude-code-interactive|$)|achieved(?=\s|:|codex|claude-code|claude-code-interactive|$)|budget\s*limited(?=\s|:|codex|claude-code|claude-code-interactive|$)|cleared(?=\s|:|codex|claude-code|claude-code-interactive|$)|updated(?=\s|:|codex|claude-code|claude-code-interactive|$))\s*:?\s*/i,
      '',
    ).trim();
    if (withoutEventPrefix !== text) {
      text = withoutEventPrefix;
      strippedPrefix = true;
    }
    if (strippedPrefix) text = text.replace(/^(?:codex|claude-code|claude-code-interactive)\s*/i, '').trim();
    if (text === before) break;
  }
  return text;
}

export function shouldApplyGoalSnapshot(currentUpdatedAtMs: number | null, incomingGoal: ThreadGoal | null): boolean {
  if (!incomingGoal) return true;
  const incomingAt = goalSnapshotTimeMs(incomingGoal);
  return !(incomingAt && currentUpdatedAtMs && incomingAt < currentUpdatedAtMs);
}

export function isActiveGoal(goal: Pick<ThreadGoal, 'status'> | null | undefined): boolean {
  return !!goal && goal.status === 'active';
}

export function goalSupportsAction(
  goal: Pick<ThreadGoal, 'backend' | 'supportedActions'> | null | undefined,
  action: keyof NonNullable<ThreadGoal['supportedActions']>,
): boolean {
  if (!goal || !action) return false;
  const actions = goal.supportedActions;
  if (actions && Object.prototype.hasOwnProperty.call(actions, action)) return actions[action] === true;
  const backend = goal.backend || 'codex';
  if (action === 'clear' || action === 'stopTurn') return true;
  if (action === 'pause' || action === 'resume') return backend === 'codex';
  return false;
}

export function goalElapsedSeconds(goal: ThreadGoal | null | undefined, nowMs = Date.now()): number {
  if (!goal || typeof goal !== 'object') return 0;
  const base = Math.max(0, Math.floor(Number(goal.timeUsedSeconds) || 0));
  if (!isActiveGoal(goal)) return base;
  const snapshotAt = goalSnapshotTimeMs(goal);
  if (!snapshotAt) return base;
  return base + Math.max(0, Math.floor((nowMs - snapshotAt) / 1000));
}

export function goalStatusLabel(goal: Pick<ThreadGoal, 'status'> | null | undefined): string {
  switch (goal?.status) {
    case 'active':
      return 'Goal active';
    case 'paused':
      return 'Goal paused';
    case 'complete':
      return 'Goal achieved';
    case 'budgetLimited':
      return 'Goal budget limited';
    case 'cleared':
      return 'Goal cleared';
    default:
      return 'Goal';
  }
}

export function formatGoalElapsed(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const seconds = safeSeconds % 60;
  const minutes = Math.floor(safeSeconds / 60) % 60;
  const hours = Math.floor(safeSeconds / 3600);
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function joinExplorerPath(parent: string, name: string): string {
  return [parent, name].filter(Boolean).join('/');
}

export function parentExplorerPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

export function basenameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() || path || 'file';
}

export function isImageFileName(fileName: string): boolean {
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(fileName);
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
