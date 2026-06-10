import fs from 'fs';
import type { ConversationCheckout, SessionFile, WorkspaceIndex } from '../../types';
import type { WorktreeIsolationBlocker } from '../../contracts/worktreeIsolation';
import {
  normalizeCheckout,
  WorktreeIsolationError,
  WorktreeIsolationService,
} from './worktreeIsolationService';
import { advanceConversationSession } from './sessionTransition';

interface WorktreeIsolationToggleDeps {
  worktreeIsolation: WorktreeIsolationService;
  readSessionFile(hash: string, convId: string, sessionNumber: number): Promise<SessionFile | null>;
  writeSessionFile(hash: string, convId: string, sessionNumber: number, data: SessionFile): Promise<void>;
  writeWorkspaceIndex(hash: string, index: WorkspaceIndex): Promise<void>;
  newId(): string;
}

export async function enableWorktreeIsolation(
  deps: WorktreeIsolationToggleDeps,
  hash: string,
  index: WorkspaceIndex,
): Promise<void> {
  if (index.worktreeIsolation?.enabled) return;
  const settings = await deps.worktreeIsolation.buildSettings(hash, index.workspacePath);
  await deps.worktreeIsolation.assertBaseReady(settings);
  const now = new Date();
  const created: ConversationCheckout[] = [];
  const migrations: Array<{
    convEntry: WorkspaceIndex['conversations'][number];
    checkout: ConversationCheckout;
    branchName: string;
  }> = [];
  try {
    for (const convEntry of index.conversations) {
      const activeSession = convEntry.sessions.find((session) => session.active);
      if (!activeSession) continue;
      const newSessionNumber = activeSession.number + 1;
      const branchName = deps.worktreeIsolation.branchName(convEntry.id, newSessionNumber);
      const checkout = await deps.worktreeIsolation.createConversationWorktree(settings, convEntry.id, branchName);
      created.push(checkout);
      migrations.push({ convEntry, checkout, branchName });
    }

    index.worktreeIsolation = settings;
    for (const migration of migrations) {
      migration.convEntry.checkout = migration.checkout;
      await advanceConversationSession(deps, hash, migration.convEntry, now, {
        branchName: migration.branchName,
        baseRef: settings.remoteBaseRef,
      });
    }
    await deps.writeWorkspaceIndex(hash, index);
  } catch (err) {
    for (const checkout of created.reverse()) {
      try {
        await deps.worktreeIsolation.removeConversationWorktree(settings, checkout, { id: 'rollback', title: 'rollback' });
      } catch {
        // Best-effort cleanup; preserve the original enablement failure.
      }
    }
    delete index.worktreeIsolation;
    throw err;
  }
}

export async function disableWorktreeIsolation(
  deps: WorktreeIsolationToggleDeps,
  hash: string,
  index: WorkspaceIndex,
): Promise<void> {
  const settings = index.worktreeIsolation;
  if (!settings?.enabled) return;
  const blockers: WorktreeIsolationBlocker[] = [];
  const baseDirty = await deps.worktreeIsolation.changedFiles(settings.repoRoot);
  if (baseDirty.length > 0) {
    blockers.push({
      code: 'base_dirty',
      message: 'Base checkout has uncommitted changes',
      path: settings.repoRoot,
      files: baseDirty,
    });
  }

  for (const convEntry of index.conversations) {
    const checkout = normalizeCheckout(convEntry.checkout);
    if (checkout.mode === 'worktree') {
      if (!checkout.worktreeRoot || !fs.existsSync(checkout.worktreeRoot)) {
        blockers.push({
          code: 'worktree_missing',
          message: 'Conversation worktree is missing',
          conversationId: convEntry.id,
          path: checkout.worktreeRoot,
        });
        continue;
      }
      const dirtyFiles = await deps.worktreeIsolation.changedFiles(checkout.worktreeRoot);
      if (dirtyFiles.length > 0) {
        blockers.push({
          code: 'worktree_dirty',
          message: 'Conversation worktree has uncommitted changes',
          conversationId: convEntry.id,
          path: checkout.worktreeRoot,
          files: dirtyFiles,
        });
      }
    }
  }
  if (blockers.length > 0) {
    throw new WorktreeIsolationError(
      blockers.some((blocker) => blocker.code === 'worktree_dirty') ? 'worktree_dirty' : blockers[0].code,
      'Cannot disable worktree mode until dirty or missing checkouts are resolved',
      blockers,
    );
  }

  const now = new Date();
  for (const convEntry of index.conversations) {
    const checkout = normalizeCheckout(convEntry.checkout);
    if (checkout.mode === 'worktree') {
      await deps.worktreeIsolation.removeConversationWorktree(settings, checkout, convEntry);
    }
    delete convEntry.checkout;
    await advanceConversationSession(deps, hash, convEntry, now);
  }
  delete index.worktreeIsolation;
  await deps.writeWorkspaceIndex(hash, index);
}
