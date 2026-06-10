import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import type { Message, SessionEntry, SessionFile, WorkspaceIndex } from '../../types';
import { cliHarnessForBackend, serverConfiguredCliProfileId } from '../cliProfiles';

interface LegacyMigrationDeps {
  workspacesDir: string;
  legacyConversationsDir: string;
  legacyArchivesDir: string;
  defaultWorkspace: string;
  workspaceHash(workspacePath: string): string;
  newId(): string;
  readWorkspaceIndex(hash: string): Promise<WorkspaceIndex | null>;
  writeWorkspaceIndex(hash: string, index: WorkspaceIndex): Promise<void>;
  writeSessionFile(hash: string, convId: string, sessionNumber: number, data: SessionFile): Promise<void>;
  ensureServerConfiguredCliProfiles(harnesses: Iterable<string | undefined | null>): Promise<void>;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

export class LegacyMigrations {
  constructor(private readonly deps: LegacyMigrationDeps) {}

  async migrateCliProfiles(): Promise<void> {
    const usedHarnesses = new Set<string>();
    let dirs: string[];
    try {
      dirs = await fsp.readdir(this.deps.workspacesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    for (const hash of dirs) {
      if (hash.startsWith('.')) continue;
      const index = await this.deps.readWorkspaceIndex(hash);
      if (!index || !Array.isArray(index.conversations)) continue;

      let changed = false;
      for (const conv of index.conversations) {
        const harness = cliHarnessForBackend(conv.backend);
        if (!harness) continue;
        if (!conv.cliProfileId) {
          usedHarnesses.add(harness);
          conv.cliProfileId = serverConfiguredCliProfileId(harness);
          changed = true;
        }
      }

      if (changed) {
        await this.deps.writeWorkspaceIndex(hash, index);
      }
    }

    await this.deps.ensureServerConfiguredCliProfiles(usedHarnesses);
  }

  async migrateToWorkspaces(): Promise<void> {
    let files: string[];
    try {
      files = await fsp.readdir(this.deps.legacyConversationsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    files = files.filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      await this._renameLegacyDirs();
      return;
    }

    const workspaceGroups = new Map<string, { workspacePath: string; convs: LegacyConversation[] }>();

    for (const f of files) {
      const convId = f.replace('.json', '');
      try {
        const data = await fsp.readFile(path.join(this.deps.legacyConversationsDir, f), 'utf8');
        const conv = JSON.parse(data) as LegacyConversation;
        const workspacePath = conv.workingDir || this.deps.defaultWorkspace;
        const hash = this.deps.workspaceHash(workspacePath);

        if (!workspaceGroups.has(hash)) {
          workspaceGroups.set(hash, { workspacePath, convs: [] });
        }
        workspaceGroups.get(hash)!.convs.push(conv);
      } catch (err: unknown) {
        this.deps.log.error('Failed to read legacy conversation during migration', { convId, error: err });
      }
    }

    for (const [hash, group] of workspaceGroups) {
      const index: WorkspaceIndex = {
        workspaceId: this.deps.newId(),
        workspacePath: group.workspacePath,
        conversations: [],
      };

      for (const conv of group.convs) {
        const convId = conv.id;
        const sessions: SessionEntry[] = [];

        let oldArchiveIndex: { sessions: LegacyArchiveSession[] } = { sessions: [] };
        try {
          const archiveIndexPath = path.join(this.deps.legacyArchivesDir, convId, 'index.json');
          const data = await fsp.readFile(archiveIndexPath, 'utf8');
          oldArchiveIndex = JSON.parse(data);
        } catch {
          // No archive
        }

        for (const oldSession of oldArchiveIndex.sessions) {
          let sessionData: SessionFile;
          try {
            const oldPath = path.join(this.deps.legacyArchivesDir, convId, `session-${oldSession.number}.json`);
            const data = await fsp.readFile(oldPath, 'utf8');
            sessionData = JSON.parse(data) as SessionFile;
          } catch {
            continue;
          }

          await this.deps.writeSessionFile(hash, convId, oldSession.number, sessionData);

          sessions.push({
            number: oldSession.number,
            sessionId: oldSession.sessionId || sessionData.sessionId || '',
            summary: oldSession.summary || '(Migrated session)',
            active: false,
            messageCount: oldSession.messageCount || (sessionData.messages ? sessionData.messages.length : 0),
            startedAt: oldSession.startedAt || sessionData.startedAt,
            endedAt: oldSession.endedAt || sessionData.endedAt,
          });
        }

        if (conv.sessions && conv.sessions.length > 0) {
          const hasDividers = conv.messages.some(m => m.isSessionDivider);
          if (hasDividers) {
            const dividerIndices: number[] = [];
            for (let i = 0; i < conv.messages.length; i++) {
              if (conv.messages[i].isSessionDivider) dividerIndices.push(i);
            }

            for (const session of conv.sessions) {
              if (!session.endedAt) continue;
              if (sessions.some(s => s.number === session.number)) continue;

              let start: number;
              let end: number;
              if (session.number === 1) {
                start = 0;
                end = dividerIndices.length > 0 ? dividerIndices[0] : conv.messages.length;
              } else {
                const divIdx = dividerIndices[session.number - 2];
                if (divIdx === undefined) continue;
                start = divIdx + 1;
                const nextDiv = dividerIndices[session.number - 1];
                end = nextDiv !== undefined ? nextDiv : conv.messages.length;
              }

              const sessionMessages = conv.messages.slice(start, end).filter(m => !m.isSessionDivider) as Message[];
              const sessionData: SessionFile = {
                sessionNumber: session.number,
                sessionId: session.sessionId,
                startedAt: session.startedAt,
                endedAt: session.endedAt,
                messages: sessionMessages,
              };
              await this.deps.writeSessionFile(hash, convId, session.number, sessionData);

              sessions.push({
                number: session.number,
                sessionId: session.sessionId || '',
                summary: '(Migrated session)',
                active: false,
                messageCount: sessionMessages.length,
                startedAt: session.startedAt,
                endedAt: session.endedAt,
              });
            }
          }
        }

        let currentMessages: Message[];
        if (conv.sessions && conv.sessions.length > 0) {
          const lastDividerIdx = conv.messages.reduce((acc: number, m: LegacyMessage, i: number) => m.isSessionDivider ? i : acc, -1);
          currentMessages = lastDividerIdx >= 0
            ? conv.messages.slice(lastDividerIdx + 1).filter(m => !m.isSessionDivider)
            : conv.messages.filter(m => !m.isSessionDivider);
        } else {
          currentMessages = (conv.messages || []).filter(m => !m.isSessionDivider);
        }

        const sessionNumber = conv.sessionNumber || 1;
        const currentSessionId = conv.currentSessionId || this.deps.newId();

        const currentStartedAt = currentMessages.length > 0
          ? currentMessages[0].timestamp
          : (conv.updatedAt || new Date().toISOString());
        await this.deps.writeSessionFile(hash, convId, sessionNumber, {
          sessionNumber,
          sessionId: currentSessionId,
          startedAt: currentStartedAt,
          endedAt: null,
          messages: currentMessages,
        });

        sessions.push({
          number: sessionNumber,
          sessionId: currentSessionId,
          summary: null,
          active: true,
          messageCount: currentMessages.length,
          startedAt: currentStartedAt,
          endedAt: null,
        });

        sessions.sort((a, b) => a.number - b.number);

        const lastMsg = currentMessages.length > 0
          ? currentMessages[currentMessages.length - 1].content.substring(0, 100)
          : null;

        index.conversations.push({
          id: convId,
          title: conv.title,
          backend: conv.backend || 'claude-code',
          currentSessionId,
          lastActivity: conv.updatedAt || new Date().toISOString(),
          lastMessage: lastMsg,
          sessions,
        });
      }

      await this.deps.writeWorkspaceIndex(hash, index);
    }

    await this._renameLegacyDirs();
    this.deps.log.info('Migrated legacy conversations to workspace format', { count: files.length });
  }

  private async _renameLegacyDirs(): Promise<void> {
    for (const [oldName, backupName] of [
      [this.deps.legacyConversationsDir, this.deps.legacyConversationsDir + '_backup'],
      [this.deps.legacyArchivesDir, this.deps.legacyArchivesDir + '_backup'],
    ] as const) {
      try {
        if (fs.existsSync(oldName)) {
          await fsp.rename(oldName, backupName);
        }
      } catch (err: unknown) {
        this.deps.log.error('Failed to rename legacy directory during migration', { path: oldName, backupPath: backupName, error: err });
      }
    }
  }
}

interface LegacyMessage extends Message {
  isSessionDivider?: boolean;
}

interface LegacySession {
  number: number;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
}

interface LegacyConversation {
  id: string;
  title: string;
  backend: string;
  workingDir?: string;
  currentSessionId?: string;
  sessionNumber?: number;
  updatedAt?: string;
  messages: LegacyMessage[];
  sessions: LegacySession[];
}

interface LegacyArchiveSession {
  number: number;
  sessionId?: string;
  summary?: string;
  messageCount?: number;
  startedAt: string;
  endedAt: string | null;
}
