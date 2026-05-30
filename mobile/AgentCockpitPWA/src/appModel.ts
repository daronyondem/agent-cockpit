import type { AgentCockpitAPI } from './api';
import type {
  AttachmentMeta,
  BackendMetadata,
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
  ServiceTier,
  SessionHistoryItem,
  ThreadGoal,
} from './types';

export const ALL_WORKSPACES = 'all';
export const CLAUDE_CODE_INTERACTIVE_BACKEND_ID = 'claude-code-interactive';
export const CHAT_SCROLL_BOTTOM_THRESHOLD_PX = 48;

const effortOrder: EffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

type GoalCapabilityMetadata = NonNullable<NonNullable<BackendMetadata['capabilities']>['goals']>;

export type GoalCapability = {
  set: boolean;
  clear: boolean;
  pause: boolean;
  resume: boolean;
  status: 'native' | 'transcript' | 'none';
};

export type CliProfileSummary = {
  id: string;
  name: string;
  harness: string;
  protocol?: string;
  opencode?: {
    provider?: string;
  };
};

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
  language?: string;
  mimeType?: string;
  truncated?: boolean;
  error?: string;
};

export function workspaceRef(
  conversation: Pick<Conversation, 'workspaceId' | 'workspaceHash'> | Pick<ConversationListItem, 'workspaceId' | 'workspaceHash'>,
): string {
  return conversation.workspaceId || conversation.workspaceHash;
}

export function isChatScrolledToEnd(element: Pick<HTMLElement, 'scrollHeight' | 'clientHeight' | 'scrollTop'>): boolean {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= CHAT_SCROLL_BOTTOM_THRESHOLD_PX;
}

export function backendIdForProfile(profile?: { harness: string; protocol?: string } | null): string | undefined {
  if (!profile) return undefined;
  if (profile.harness === 'claude-code' && profile.protocol === 'interactive') return CLAUDE_CODE_INTERACTIVE_BACKEND_ID;
  return profile.harness;
}

const OPENCODE_PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
  opencode: 'OpenCode',
  openrouter: 'OpenRouter',
  groq: 'Groq',
};

export function opencodeProviderLabel(provider?: string | null): string | null {
  const id = String(provider || '').trim().toLowerCase();
  if (!id) return null;
  if (OPENCODE_PROVIDER_LABELS[id]) return OPENCODE_PROVIDER_LABELS[id];
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function profileForID(profiles: CliProfileSummary[] | undefined, profileID?: string | null): CliProfileSummary | null {
  if (!profileID) return null;
  return profiles?.find((profile) => profile.id === profileID) || null;
}

export function isClaudeBackend(backendID?: string | null): boolean {
  return backendID === 'claude-code' || backendID === CLAUDE_CODE_INTERACTIVE_BACKEND_ID;
}

export function normalizeGoalCapability(capability: GoalCapabilityMetadata | undefined, backendID?: string): GoalCapability {
  if (capability === true) {
    return { set: true, clear: true, pause: true, resume: true, status: 'native' };
  }
  if (capability && typeof capability === 'object') {
    return {
      set: capability.set === true,
      clear: capability.clear === true,
      pause: capability.pause === true,
      resume: capability.resume === true,
      status: capability.status || 'none',
    };
  }
  if (backendID === 'codex') return { set: true, clear: true, pause: true, resume: true, status: 'native' };
  if (isClaudeBackend(backendID)) return { set: true, clear: true, pause: false, resume: false, status: 'transcript' };
  return { set: false, clear: false, pause: false, resume: false, status: 'none' };
}

export function goalCapabilityForBackend(
  backends: BackendMetadata[],
  backendID?: string | null,
  metadata?: BackendMetadata,
): GoalCapability {
  const backend = metadata || (backends || []).find((item) => item.id === backendID);
  return normalizeGoalCapability(backend?.capabilities?.goals, backendID || backend?.id);
}

export function goalActionUnsupportedMessage(action: 'pause' | 'resume' | 'clear', backendID?: string | null): string {
  const backendName = isClaudeBackend(backendID) ? 'Claude Code' : backendID === 'codex' ? 'Codex' : 'this backend';
  return `Goal ${action} is not supported by ${backendName}.`;
}

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
  references.push(...parsed.deliveredPaths.map((path) => makeConversationWorkspaceFileReference(client, conversation, path)));
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

export function makeWorkspaceFileReference(client: AgentCockpitAPI, workspaceId: string, path: string): FileReference {
  const title = basenameFromPath(path);
  return {
    id: `workspace:${workspaceId}:${path}`,
    title,
    path,
    downloadURL: client.workspaceFileURL(workspaceId, path, 'download'),
    isImage: isImageFileName(title),
    fetchPreview: () => client.getWorkspaceFilePreview(workspaceId, path),
  };
}

export function makeConversationWorkspaceFileReference(client: AgentCockpitAPI, conversation: Conversation, path: string): FileReference {
  const title = basenameFromPath(path);
  return {
    id: `conversation-workspace:${conversation.id}:${path}`,
    title,
    path,
    downloadURL: client.conversationWorkspaceFileURL(conversation.id, path, 'download'),
    isImage: isImageFileName(title),
    fetchPreview: () => client.getConversationWorkspaceFilePreview(conversation.id, path),
  };
}

export function makeConversationWorkspaceContextFileReference(client: AgentCockpitAPI, conversation: Conversation, href: string): FileReference | null {
  const resolved = workspaceContextPathFromHref(href);
  if (!resolved) return null;
  const title = basenameFromPath(resolved.filePath);
  return {
    id: `conversation-workspace-context:${conversation.id}:${resolved.filePath}`,
    title,
    path: resolved.filePath,
    downloadURL: client.conversationWorkspaceContextFileURL(conversation.id, resolved.filePath, 'download'),
    isImage: isImageFileName(title),
    fetchPreview: () => client.getConversationWorkspaceContextFilePreview(conversation.id, resolved.filePath),
  };
}

export function makeExplorerFileReference(client: AgentCockpitAPI, workspaceId: string, path: string): FileReference {
  const title = basenameFromPath(path);
  return {
    id: `explorer:${workspaceId}:${path}`,
    title,
    path,
    downloadURL: client.explorerFileURL(workspaceId, path, 'download'),
    isImage: isImageFileName(title),
    fetchPreview: () => client.getExplorerPreview(workspaceId, path),
  };
}

function workspaceContextPathFromHref(rawHref: string): { filePath: string } | null {
  const href = String(rawHref || '').trim();
  if (!href || href.startsWith('#') || (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href))) return null;
  let pathname = href;
  if (/^file:/i.test(href)) {
    try {
      pathname = new URL(href).pathname;
    } catch {
      return null;
    }
  }
  pathname = pathname.split('#')[0].split('?')[0];
  if (!pathname.startsWith('/')) return null;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep the original path if the model produced partially encoded text.
  }
  const parsed = splitLineSuffix(pathname);
  if (parsed.split('/').some((part) => part === '..')) return null;
  const marker = '/data/chat/workspaces/';
  const markerIndex = parsed.indexOf(marker);
  if (markerIndex < 0) return null;
  const rest = parsed.slice(markerIndex + marker.length);
  const markerMatch = rest.match(/^([^/]+)\/workspace-context\/(context|references|assets)\/(.+)$/);
  if (!markerMatch) return null;
  const section = markerMatch[2];
  const relativePath = markerMatch[3];
  if (!relativePath || relativePath.includes('\\') || relativePath.split('/').some((part) => !part || part === '..')) return null;
  if (section === 'context' && !relativePath.toLowerCase().endsWith('.md')) return null;
  if (section === 'references' && !/\.(md|markdown|txt)$/i.test(relativePath)) return null;
  if (section === 'assets' && !/\.(md|markdown|txt|json|csv|tsv|ya?ml|png|jpe?g|gif|webp|bmp|pdf)$/i.test(relativePath)) return null;
  return { filePath: parsed };
}

function splitLineSuffix(filePath: string): string {
  return filePath
    .replace(/:([1-9]\d*):([1-9]\d*)$/, '')
    .replace(/:([1-9]\d*)$/, '');
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
    executionDir: conversation.executionDir,
    checkout: conversation.checkout,
    workspaceId: conversation.workspaceId,
    workspaceHash: conversation.workspaceHash,
    workspaceKbEnabled: false,
    messageCount: conversation.messages.length,
    lastMessage: conversation.messages.at(-1)?.content || null,
    usage: conversation.usage || null,
    archived: conversation.archived,
  };
}

export type ConversationRuntimeSelection = {
  backend?: string | null;
  cliProfileId?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
  serviceTier?: ServiceTier | 'default' | null;
};

export function applyConversationRuntimeSelection<T extends Pick<Conversation, 'backend' | 'cliProfileId' | 'model' | 'effort' | 'serviceTier'>>(
  conversation: T,
  selection: ConversationRuntimeSelection,
): T {
  const backend = selection.backend || conversation.backend;
  return {
    ...conversation,
    backend,
    cliProfileId: selection.cliProfileId || conversation.cliProfileId,
    model: selection.model || conversation.model,
    effort: selection.effort || conversation.effort,
    serviceTier: backend === 'codex' && selection.serviceTier === 'fast' ? 'fast' : undefined,
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

export function reconcileRecoveredSendConversation<T extends Pick<Conversation, 'messages'>>(
  currentConversation: T,
  serverConversation: T,
  previousMessageCount: number,
  content: string,
): T {
  const expectedContent = content.trim();
  const searchStart = Math.max(0, Math.min(previousMessageCount, serverConversation.messages.length));
  const persistedUserMessage = serverConversation.messages
    .slice(searchStart)
    .find((message) => message.role === 'user' && message.content.trim() === expectedContent);
  if (!persistedUserMessage) {
    return currentConversation;
  }
  return serverConversation;
}

export function removeMessagesByID(messages: Message[], ids: string[]): Message[] {
  if (!ids.length) return messages;
  const blocked = new Set(ids);
  return messages.filter((message) => !blocked.has(message.id));
}

function messageWithPinned(message: Message, pinned: boolean): Message {
  const next: Message = { ...message };
  if (pinned) next.pinned = true;
  else delete next.pinned;
  return next;
}

export function patchConversationMessage(
  conversation: Conversation,
  messageID: string,
  pinned: boolean,
  replacement?: Message,
): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) =>
      message.id === messageID ? (replacement || messageWithPinned(message, pinned)) : message,
    ),
  };
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
    const workspaceId = conversation.workspaceId || conversation.workspaceHash;
    if (!byHash.has(workspaceId)) {
      byHash.set(workspaceId, {
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
