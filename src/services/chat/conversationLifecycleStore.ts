import fsp from 'fs/promises';
import type {
  ConversationEntry,
  ConversationListItem,
  WorkspaceIndex,
} from '../../types';
import { normalizeCheckout } from './worktreeIsolationService';

interface ConversationLookupResult {
  hash: string;
  index: WorkspaceIndex;
  convEntry: ConversationEntry;
}

interface ConversationLifecycleStoreDeps {
  workspacesDir: string;
  convWorkspaceMap: Map<string, string>;
  indexLock: { run<T>(key: string, fn: () => Promise<T>): Promise<T> };
  readWorkspaceIndex(hash: string): Promise<WorkspaceIndex | null>;
  writeWorkspaceIndex(hash: string, index: WorkspaceIndex): Promise<void>;
  getConvFromIndex(convId: string): Promise<ConversationLookupResult | null>;
  resolveWorkspaceId(ref: string): string | null;
  workspaceLegacyHashForRef(ref: string): string;
}

export class ConversationLifecycleStore {
  constructor(private readonly deps: ConversationLifecycleStoreDeps) {}

  async listConversations(opts?: { archived?: boolean }): Promise<ConversationListItem[]> {
    const wantArchived = opts?.archived === true;
    const convs: ConversationListItem[] = [];
    let dirs: string[];
    try {
      dirs = await fsp.readdir(this.deps.workspacesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    for (const storageKey of dirs) {
      if (storageKey.startsWith('.')) continue;
      const index = await this.deps.readWorkspaceIndex(storageKey);
      if (!index || !index.conversations) continue;
      const workspaceId = index.workspaceId || this.deps.resolveWorkspaceId(storageKey) || storageKey;
      const legacyHash = this.deps.workspaceLegacyHashForRef(workspaceId);
      for (const conv of index.conversations) {
        const isArchived = !!conv.archived;
        if (isArchived !== wantArchived) continue;
        const activeSession = conv.sessions.find(s => s.active);
        const checkout = normalizeCheckout(conv.checkout);
        const worktreeCheckout = checkout.mode === 'worktree' ? checkout : undefined;
        convs.push({
          id: conv.id,
          title: conv.title,
          updatedAt: conv.lastActivity,
          backend: conv.backend,
          cliProfileId: conv.cliProfileId,
          model: conv.model,
          effort: conv.effort,
          serviceTier: conv.serviceTier,
          workingDir: index.workspacePath,
          ...(worktreeCheckout ? {
            executionDir: worktreeCheckout.executionDir,
            checkout: worktreeCheckout,
          } : {}),
          workspaceId,
          workspaceHash: legacyHash,
          workspaceKbEnabled: Boolean(index.kbEnabled),
          messageCount: activeSession ? activeSession.messageCount : 0,
          lastMessage: conv.lastMessage,
          usage: conv.usage || null,
          archived: conv.archived,
          unread: conv.unread,
        });
      }
    }

    convs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return convs;
  }

  async renameConversation(id: string, newTitle: string): Promise<boolean> {
    return this.mutateConversation(id, async ({ index, convEntry }) => {
      convEntry.title = newTitle;
      convEntry.titleManuallySet = true;
      return { index, value: true };
    }, false);
  }

  async archiveConversation(id: string): Promise<boolean> {
    return this.mutateConversation(id, async ({ index, convEntry }) => {
      convEntry.archived = true;
      delete convEntry.messageQueue;
      return { index, value: true };
    }, false);
  }

  async restoreConversation(id: string): Promise<boolean> {
    return this.mutateConversation(id, async ({ index, convEntry }) => {
      delete convEntry.archived;
      return { index, value: true };
    }, false);
  }

  async setConversationUnread(id: string, unread: boolean): Promise<boolean> {
    return this.mutateConversation(id, async ({ index, convEntry }) => {
      if (unread) {
        if (convEntry.unread === true) return { index: null, value: true };
        convEntry.unread = true;
      } else {
        if (!convEntry.unread) return { index: null, value: true };
        delete convEntry.unread;
      }
      return { index, value: true };
    }, false);
  }

  async setExternalSessionId(convId: string, externalSessionId: string): Promise<void> {
    await this.mutateConversation(convId, async ({ index, convEntry }) => {
      const activeSession = convEntry.sessions.find(s => s.active);
      if (!activeSession) return { index: null, value: undefined };
      if (activeSession.externalSessionId === externalSessionId) return { index: null, value: undefined };
      activeSession.externalSessionId = externalSessionId;
      return { index, value: undefined };
    }, undefined);
  }

  private async mutateConversation<T>(
    id: string,
    mutate: (result: ConversationLookupResult) => Promise<{ index: WorkspaceIndex | null; value: T }>,
    missingValue: T,
  ): Promise<T> {
    const hash = this.deps.convWorkspaceMap.get(id);
    if (!hash) return missingValue;
    return this.deps.indexLock.run(hash, async () => {
      const result = await this.deps.getConvFromIndex(id);
      if (!result) return missingValue;
      const { index, value } = await mutate(result);
      if (index) await this.deps.writeWorkspaceIndex(hash, index);
      return value;
    });
  }
}
