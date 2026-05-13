import type {
  AttachmentMeta,
  BackendMetadata,
  BasicOKResponse,
  Conversation,
  ConversationListItem,
  CurrentUser,
  DirectoryBrowseResponse,
  EffortLevel,
  ExplorerPreviewResponse,
  ExplorerTreeResponse,
  FilePreviewResponse,
  InputResponse,
  Message,
  QueuedMessage,
  ResetSessionResponse,
  SendMessageResponse,
  ServiceTier,
  SessionHistoryItem,
  Settings,
  ThreadGoal,
} from './types';
import type { CreateConversationRequest, SetMessagePinnedRequest } from '../../../src/contracts/conversations';
import type {
  ExplorerCreateFileRequest,
  ExplorerMkdirRequest,
  ExplorerRenameRequest,
  ExplorerSaveFileRequest,
} from '../../../src/contracts/explorer';
import type { ConversationInputRequest, SendMessageRequest } from '../../../src/contracts/streams';

type RequestOptions = {
  query?: Record<string, string | undefined>;
  csrf?: boolean;
  body?: unknown;
};

type UploadOptions = {
  onProgress?: (progress: number) => void;
  onXhr?: (xhr: XMLHttpRequest) => void;
};

export type SetGoalRequest = {
  objective: string;
  backend?: string;
  cliProfileId?: string;
  model?: string;
  effort?: EffortLevel;
  serviceTier?: ServiceTier | 'default';
};

export class AgentAPIError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AgentAPIError';
    this.status = status;
  }
}

export class AgentCockpitAPI {
  private csrfToken?: string;
  private readonly apiBase: URL;

  constructor(baseURL = defaultAPIBase()) {
    this.apiBase = new URL(baseURL);
  }

  loginURL(): string {
    const url = new URL('auth/login', this.apiBase);
    url.searchParams.set('next', window.location.pathname + window.location.search);
    return url.toString();
  }

  async getCurrentUser(): Promise<CurrentUser> {
    return this.request<CurrentUser>('GET', '/api/me');
  }

  async getSettings(): Promise<Settings> {
    return this.request<Settings>('GET', '/api/chat/settings', { csrf: true });
  }

  async getBackends(): Promise<BackendMetadata[]> {
    const response = await this.request<{ backends: BackendMetadata[] }>('GET', '/api/chat/backends', { csrf: true });
    return response.backends || [];
  }

  async getCliProfileMetadata(profileID: string): Promise<BackendMetadata> {
    const response = await this.request<{ backend: BackendMetadata }>(
      'GET',
      `/api/chat/cli-profiles/${encodeURIComponent(profileID)}/metadata`,
      { csrf: true },
    );
    return response.backend;
  }

  async listConversations(archived = false): Promise<ConversationListItem[]> {
    const response = await this.request<{ conversations: ConversationListItem[] }>('GET', '/api/chat/conversations', {
      query: archived ? { archived: 'true' } : undefined,
      csrf: true,
    });
    return response.conversations || [];
  }

  async getActiveStreams(): Promise<Set<string>> {
    const response = await this.request<{ ids: string[] }>('GET', '/api/chat/active-streams', { csrf: true });
    return new Set(response.ids || []);
  }

  async getConversation(id: string): Promise<Conversation> {
    return this.request<Conversation>('GET', `/api/chat/conversations/${encodeURIComponent(id)}`, { csrf: true });
  }

  async createConversation(input: CreateConversationRequest): Promise<Conversation> {
    return this.request<Conversation>('POST', '/api/chat/conversations', {
      csrf: true,
      body: stripUndefined(input),
    });
  }

  async renameConversation(id: string, title: string): Promise<Conversation> {
    return this.request<Conversation>('PUT', `/api/chat/conversations/${encodeURIComponent(id)}`, {
      csrf: true,
      body: { title },
    });
  }

  async setMessagePinned(id: string, messageID: string, pinned: boolean): Promise<{ ok: true; pinned: boolean; message: Message }> {
    const body: SetMessagePinnedRequest = { pinned };
    return this.request<{ ok: true; pinned: boolean; message: Message }>(
      'PATCH',
      `/api/chat/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageID)}/pin`,
      { csrf: true, body },
    );
  }

  async archiveConversation(id: string): Promise<BasicOKResponse> {
    return this.request<BasicOKResponse>('PATCH', `/api/chat/conversations/${encodeURIComponent(id)}/archive`, {
      csrf: true,
      body: {},
    });
  }

  async restoreConversation(id: string): Promise<BasicOKResponse> {
    return this.request<BasicOKResponse>('PATCH', `/api/chat/conversations/${encodeURIComponent(id)}/restore`, {
      csrf: true,
      body: {},
    });
  }

  async deleteConversation(id: string): Promise<BasicOKResponse> {
    return this.request<BasicOKResponse>('DELETE', `/api/chat/conversations/${encodeURIComponent(id)}`, { csrf: true });
  }

  async sendMessage(
    conversationID: string,
    input: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>('POST', `/api/chat/conversations/${encodeURIComponent(conversationID)}/message`, {
      csrf: true,
      body: stripUndefined(input),
    });
  }

  async getGoal(conversationID: string): Promise<{ goal: ThreadGoal | null }> {
    return this.request<{ goal: ThreadGoal | null }>('GET', `/api/chat/conversations/${encodeURIComponent(conversationID)}/goal`, {
      csrf: true,
    });
  }

  async setGoal(conversationID: string, input: SetGoalRequest): Promise<{ streamReady?: boolean; goal?: ThreadGoal | null; message?: Message | null }> {
    return this.request<{ streamReady?: boolean; goal?: ThreadGoal | null; message?: Message | null }>('POST', `/api/chat/conversations/${encodeURIComponent(conversationID)}/goal`, {
      csrf: true,
      body: stripUndefined(input),
    });
  }

  async resumeGoal(conversationID: string): Promise<{ streamReady?: boolean; goal?: ThreadGoal | null; message?: Message | null }> {
    return this.request<{ streamReady?: boolean; goal?: ThreadGoal | null; message?: Message | null }>('POST', `/api/chat/conversations/${encodeURIComponent(conversationID)}/goal/resume`, {
      csrf: true,
      body: {},
    });
  }

  async pauseGoal(conversationID: string): Promise<{ goal: ThreadGoal | null; message?: Message | null }> {
    return this.request<{ goal: ThreadGoal | null; message?: Message | null }>('POST', `/api/chat/conversations/${encodeURIComponent(conversationID)}/goal/pause`, {
      csrf: true,
      body: {},
    });
  }

  async clearGoal(conversationID: string): Promise<{ cleared: boolean; threadId?: string | null; sessionId?: string | null; message?: Message | null }> {
    return this.request<{ cleared: boolean; threadId?: string | null; sessionId?: string | null; message?: Message | null }>(
      'DELETE',
      `/api/chat/conversations/${encodeURIComponent(conversationID)}/goal`,
      { csrf: true },
    );
  }

  async sendInput(conversationID: string, text: string, streamActive: boolean): Promise<InputResponse> {
    const body: ConversationInputRequest = { text, streamActive };
    return this.request<InputResponse>('POST', `/api/chat/conversations/${encodeURIComponent(conversationID)}/input`, {
      csrf: true,
      body,
    });
  }

  async abortConversation(conversationID: string): Promise<{ aborted?: boolean }> {
    return this.request<{ aborted?: boolean }>('POST', `/api/chat/conversations/${encodeURIComponent(conversationID)}/abort`, {
      csrf: true,
      body: {},
    });
  }

  async resetConversation(conversationID: string): Promise<ResetSessionResponse> {
    return this.request<ResetSessionResponse>('POST', `/api/chat/conversations/${encodeURIComponent(conversationID)}/reset`, {
      csrf: true,
      body: {},
    });
  }

  async getQueue(conversationID: string): Promise<QueuedMessage[]> {
    const response = await this.request<{ queue: QueuedMessage[] }>('GET', `/api/chat/conversations/${encodeURIComponent(conversationID)}/queue`, {
      csrf: true,
    });
    return response.queue || [];
  }

  async saveQueue(conversationID: string, queue: QueuedMessage[]): Promise<QueuedMessage[]> {
    await this.request<BasicOKResponse>('PUT', `/api/chat/conversations/${encodeURIComponent(conversationID)}/queue`, {
      csrf: true,
      body: { queue },
    });
    return queue;
  }

  async clearQueue(conversationID: string): Promise<BasicOKResponse> {
    return this.request<BasicOKResponse>('DELETE', `/api/chat/conversations/${encodeURIComponent(conversationID)}/queue`, {
      csrf: true,
    });
  }

  async getSessions(conversationID: string): Promise<SessionHistoryItem[]> {
    const response = await this.request<{ sessions: SessionHistoryItem[] }>('GET', `/api/chat/conversations/${encodeURIComponent(conversationID)}/sessions`, {
      csrf: true,
    });
    return response.sessions || [];
  }

  async getSessionMessages(conversationID: string, sessionNumber: number): Promise<{ messages: import('./types').Message[] }> {
    return this.request<{ messages: import('./types').Message[] }>(
      'GET',
      `/api/chat/conversations/${encodeURIComponent(conversationID)}/sessions/${sessionNumber}/messages`,
      { csrf: true },
    );
  }

  conversationMarkdownURL(conversationID: string): string {
    return this.makeURL(`/api/chat/conversations/${encodeURIComponent(conversationID)}/download`).toString();
  }

  sessionMarkdownURL(conversationID: string, sessionNumber: number): string {
    return this.makeURL(`/api/chat/conversations/${encodeURIComponent(conversationID)}/sessions/${sessionNumber}/download`).toString();
  }

  async uploadFile(conversationID: string, file: File, options: UploadOptions = {}): Promise<AttachmentMeta> {
    const url = this.makeURL(`/api/chat/conversations/${encodeURIComponent(conversationID)}/upload`);
    const form = new FormData();
    form.append('files', file);
    const envelope = await this.uploadMultipart<{ files: AttachmentMeta[] }>(url, form, options);
    const uploaded = envelope.files?.[0];
    if (!uploaded) {
      throw new AgentAPIError('The server did not return an uploaded file.');
    }
    return uploaded;
  }

  async deleteUpload(conversationID: string, filename: string): Promise<BasicOKResponse> {
    return this.request<BasicOKResponse>(
      'DELETE',
      `/api/chat/conversations/${encodeURIComponent(conversationID)}/upload/${encodeURIComponent(filename)}`,
      { csrf: true },
    );
  }

  async ocrAttachment(conversationID: string, path: string): Promise<string> {
    const response = await this.request<{ markdown: string }>('POST', `/api/chat/conversations/${encodeURIComponent(conversationID)}/attachments/ocr`, {
      csrf: true,
      body: { path },
    });
    return response.markdown || '';
  }

  async browseDirectory(path?: string, showHidden = false): Promise<DirectoryBrowseResponse> {
    return this.request<DirectoryBrowseResponse>('GET', '/api/chat/browse', {
      query: { path, showHidden: showHidden ? 'true' : undefined },
      csrf: true,
    });
  }

  async createDirectory(parentPath: string, name: string): Promise<{ created: string }> {
    return this.request<{ created: string }>('POST', '/api/chat/mkdir', {
      csrf: true,
      body: { parentPath, name },
    });
  }

  async deleteDirectory(dirPath: string): Promise<{ deleted: string; parent: string }> {
    return this.request<{ deleted: string; parent: string }>('POST', '/api/chat/rmdir', {
      csrf: true,
      body: { dirPath },
    });
  }

  conversationFileURL(conversationID: string, filename: string, mode?: 'view' | 'download'): string {
    return this.makeURL(`/api/chat/conversations/${encodeURIComponent(conversationID)}/files/${encodeURIComponent(filename)}`, { mode }).toString();
  }

  async getConversationFilePreview(conversationID: string, filename: string): Promise<FilePreviewResponse> {
    return this.request<FilePreviewResponse>('GET', `/api/chat/conversations/${encodeURIComponent(conversationID)}/files/${encodeURIComponent(filename)}`, {
      query: { mode: 'view' },
      csrf: true,
    });
  }

  async getExplorerTree(workspaceHash: string, path = ''): Promise<ExplorerTreeResponse> {
    return this.request<ExplorerTreeResponse>('GET', `/api/chat/workspaces/${encodeURIComponent(workspaceHash)}/explorer/tree`, {
      query: { path },
      csrf: true,
    });
  }

  async getExplorerPreview(workspaceHash: string, path: string): Promise<ExplorerPreviewResponse> {
    const response = await this.request<ExplorerPreviewResponse>('GET', `/api/chat/workspaces/${encodeURIComponent(workspaceHash)}/explorer/preview`, {
      query: { path, mode: 'view' },
      csrf: true,
    });
    return { ...response, path: response.path || path };
  }

  explorerFileURL(workspaceHash: string, path: string, mode: 'raw' | 'download' = 'raw'): string {
    return this.makeURL(`/api/chat/workspaces/${encodeURIComponent(workspaceHash)}/explorer/preview`, {
      path,
      mode,
    }).toString();
  }

  workspaceFileURL(workspaceHash: string, path: string, mode?: 'view' | 'download'): string {
    return this.makeURL(`/api/chat/workspaces/${encodeURIComponent(workspaceHash)}/files`, { path, mode }).toString();
  }

  async getWorkspaceFilePreview(workspaceHash: string, path: string): Promise<FilePreviewResponse> {
    const response = await this.request<FilePreviewResponse>('GET', `/api/chat/workspaces/${encodeURIComponent(workspaceHash)}/files`, {
      query: { path, mode: 'view' },
      csrf: true,
    });
    return { ...response, path: response.path || path };
  }

  async createExplorerFolder(workspaceHash: string, parent: string, name: string): Promise<BasicOKResponse & { path?: string; name?: string }> {
    const body: ExplorerMkdirRequest = { parent, name };
    return this.request<BasicOKResponse & { path?: string; name?: string }>(
      'POST',
      `/api/chat/workspaces/${encodeURIComponent(workspaceHash)}/explorer/mkdir`,
      { csrf: true, body },
    );
  }

  async createExplorerFile(workspaceHash: string, parent: string, name: string, content = ''): Promise<BasicOKResponse & { path?: string; name?: string }> {
    const body: ExplorerCreateFileRequest = { parent, name, content };
    return this.request<BasicOKResponse & { path?: string; name?: string }>(
      'POST',
      `/api/chat/workspaces/${encodeURIComponent(workspaceHash)}/explorer/file`,
      { csrf: true, body },
    );
  }

  async saveExplorerFile(workspaceHash: string, path: string, content: string): Promise<BasicOKResponse> {
    const body: ExplorerSaveFileRequest = { path, content };
    return this.request<BasicOKResponse>('PUT', `/api/chat/workspaces/${encodeURIComponent(workspaceHash)}/explorer/file`, {
      csrf: true,
      body,
    });
  }

  async renameExplorerEntry(workspaceHash: string, from: string, to: string, overwrite = false): Promise<BasicOKResponse> {
    const body: ExplorerRenameRequest = { from, to, overwrite };
    return this.request<BasicOKResponse>('PATCH', `/api/chat/workspaces/${encodeURIComponent(workspaceHash)}/explorer/rename`, {
      csrf: true,
      body,
    });
  }

  async deleteExplorerEntry(workspaceHash: string, path: string): Promise<BasicOKResponse> {
    return this.request<BasicOKResponse>('DELETE', `/api/chat/workspaces/${encodeURIComponent(workspaceHash)}/explorer/entry`, {
      query: { path },
      csrf: true,
    });
  }

  async uploadExplorerFile(
    workspaceHash: string,
    targetPath: string,
    file: File,
    overwrite = false,
    options: UploadOptions = {},
  ): Promise<{ name: string; size?: number; overwrote?: boolean }> {
    const url = this.makeURL(`/api/chat/workspaces/${encodeURIComponent(workspaceHash)}/explorer/upload`, {
      path: targetPath,
      overwrite: overwrite ? 'true' : undefined,
    });
    const form = new FormData();
    form.append('file', file);
    return this.uploadMultipart<{ name: string; size?: number; overwrote?: boolean }>(url, form, options);
  }

  websocketURL(conversationID: string): string {
    const url = this.makeURL(`/api/chat/conversations/${encodeURIComponent(conversationID)}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  private async uploadMultipart<Response>(url: URL, form: FormData, options: UploadOptions): Promise<Response> {
    const csrfToken = await this.fetchCSRFToken();
    return new Promise<Response>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      options.onXhr?.(xhr);
      xhr.open('POST', url.toString());
      xhr.withCredentials = true;
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('x-csrf-token', csrfToken);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total) {
          options.onProgress?.(Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100))));
        }
      };
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new AgentAPIError(readXHRErrorMessage(xhr), xhr.status));
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText || '{}') as Response);
        } catch {
          reject(new AgentAPIError('The server returned an invalid upload response.', xhr.status));
        }
      };
      xhr.onerror = () => reject(new AgentAPIError('Upload failed.'));
      xhr.onabort = () => reject(new AgentAPIError('Upload cancelled.'));
      xhr.send(form);
    });
  }

  private async fetchCSRFToken(): Promise<string> {
    if (this.csrfToken) {
      return this.csrfToken;
    }
    const response = await this.request<{ csrfToken: string }>('GET', '/api/csrf-token');
    if (!response.csrfToken) {
      throw new AgentAPIError('The server did not return a CSRF token.');
    }
    this.csrfToken = response.csrfToken;
    return response.csrfToken;
  }

  private async request<Response>(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const response = await this.perform(method, path, options);
    return (await response.json()) as Response;
  }

  private async perform(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.makeURL(path, options.query);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.csrf) {
      headers['x-csrf-token'] = await this.fetchCSRFToken();
    }

    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url.toString(), {
      method,
      headers,
      body,
      credentials: 'same-origin',
    });

    if (!response.ok) {
      throw new AgentAPIError(await readErrorMessage(response), response.status);
    }
    return response;
  }

  private makeURL(path: string, query?: Record<string, string | undefined>): URL {
    const url = new URL(path.replace(/^\/+/, ''), this.apiBase);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') {
          url.searchParams.set(key, value);
        }
      }
    }
    return url;
  }
}

function defaultAPIBase(): string {
  const configured = import.meta.env.VITE_AGENT_API_BASE as string | undefined;
  if (configured) {
    return configured;
  }
  return new URL('./', window.location.href.replace(/\/mobile\/.*/, '/')).toString();
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `Agent Cockpit request failed with HTTP ${response.status}.`;
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return body.error || body.message || fallback;
  } catch {
    return fallback;
  }
}

function readXHRErrorMessage(xhr: XMLHttpRequest): string {
  const fallback = `Agent Cockpit request failed with HTTP ${xhr.status}.`;
  try {
    const body = JSON.parse(xhr.responseText || '{}') as { error?: string; message?: string };
    return body.error || body.message || fallback;
  } catch {
    return fallback;
  }
}
