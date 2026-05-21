import { execFile } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import type {
  ConversationCheckout,
  ConversationEntry,
  WorktreeIsolationSettings,
  WorkspaceIndex,
} from '../../types';
import type { WorktreeIsolationBlocker, WorktreeIsolationStatusResponse } from '../../contracts/worktreeIsolation';

const GIT_TIMEOUT_MS = 20_000;
const GIT_STATUS_MAX_BUFFER = 10 * 1024 * 1024;

export class WorktreeIsolationError extends Error {
  readonly status: number;
  readonly code: string;
  readonly blockers: WorktreeIsolationBlocker[];

  constructor(code: string, message: string, blockers: WorktreeIsolationBlocker[] = [], status = 409) {
    super(message);
    this.name = 'WorktreeIsolationError';
    this.code = code;
    this.status = status;
    this.blockers = blockers.length ? blockers : [{ code, message }];
  }
}

export function isWorktreeIsolationError(err: unknown): err is WorktreeIsolationError {
  return err instanceof WorktreeIsolationError;
}

interface GitWorkspaceInfo {
  repoRoot: string;
  workspaceRelPath: string;
}

interface GitExecOptions {
  maxBuffer?: number;
  timeout?: number;
}

export class WorktreeIsolationService {
  async getStatus(hash: string, index: WorkspaceIndex | null): Promise<WorktreeIsolationStatusResponse> {
    if (!index) {
      return {
        enabled: false,
        available: false,
        blockers: [{ code: 'workspace_not_found', message: 'Workspace not found' }],
      };
    }

    const enabled = Boolean(index.worktreeIsolation?.enabled);
    const blockers: WorktreeIsolationBlocker[] = [];
    let info: GitWorkspaceInfo | null = null;
    try {
      info = await this.resolveGitWorkspace(index.workspacePath);
    } catch (err: unknown) {
      blockers.push({
        code: 'not_git_repo',
        message: (err as Error).message || 'Workspace is not inside a Git repository',
      });
    }

    const settings = index.worktreeIsolation;
    const repoRoot = settings?.repoRoot || info?.repoRoot;
    const workspaceRelPath = settings?.workspaceRelPath ?? info?.workspaceRelPath;
    const remoteBaseRef = settings?.remoteBaseRef || 'origin/main';
    const worktreeBaseDir = settings?.worktreeBaseDir || (repoRoot ? this.defaultWorktreeBaseDir(repoRoot, hash) : undefined);

    let baseDirty = false;
    let baseDirtyFiles: string[] = [];
    if (repoRoot) {
      try {
        baseDirtyFiles = await this.changedFiles(repoRoot);
        baseDirty = baseDirtyFiles.length > 0;
        if (baseDirty) {
          blockers.push({
            code: 'base_dirty',
            message: 'Base checkout has uncommitted changes',
            path: repoRoot,
            files: baseDirtyFiles,
          });
        }
      } catch (err: unknown) {
        blockers.push({
          code: 'git_status_failed',
          message: (err as Error).message,
          path: repoRoot,
        });
      }
    }

    const conversations = await Promise.all(index.conversations.map(async (conv) => {
      const checkout = normalizeCheckout(conv.checkout);
      const row: NonNullable<WorktreeIsolationStatusResponse['conversations']>[number] = {
        id: conv.id,
        title: conv.title,
        ...(conv.archived ? { archived: true } : {}),
        mode: checkout.mode,
      };
      if (checkout.mode === 'worktree' && checkout.worktreeRoot) {
        row.worktreeRoot = checkout.worktreeRoot;
        row.executionDir = checkout.executionDir;
        row.currentBranch = checkout.currentBranch;
        if (!fs.existsSync(checkout.worktreeRoot)) {
          row.missing = true;
          blockers.push({
            code: 'worktree_missing',
            message: 'Conversation worktree is missing',
            conversationId: conv.id,
            path: checkout.worktreeRoot,
          });
        } else {
          try {
            const dirtyFiles = await this.changedFiles(checkout.worktreeRoot);
            row.dirtyFiles = dirtyFiles;
            row.dirty = dirtyFiles.length > 0;
            if (row.dirty) {
              blockers.push({
                code: 'worktree_dirty',
                message: 'Conversation worktree has uncommitted changes',
                conversationId: conv.id,
                path: checkout.worktreeRoot,
                files: dirtyFiles,
              });
            }
          } catch (err: unknown) {
            blockers.push({
              code: 'worktree_status_failed',
              message: (err as Error).message,
              conversationId: conv.id,
              path: checkout.worktreeRoot,
            });
          }
        }
      }
      return row;
    }));

    return {
      enabled,
      available: Boolean(info),
      workspacePath: index.workspacePath,
      ...(repoRoot ? { repoRoot } : {}),
      ...(workspaceRelPath !== undefined ? { workspaceRelPath } : {}),
      remoteBaseRef,
      ...(worktreeBaseDir ? { worktreeBaseDir } : {}),
      baseDirty,
      baseDirtyFiles,
      blockers: blockers.filter((blocker) => enabled || blocker.code !== 'worktree_dirty'),
      conversations,
    };
  }

  async resolveGitWorkspace(workspacePath: string): Promise<GitWorkspaceInfo> {
    const workspaceRoot = await realpathOrResolve(workspacePath);
    let topLevel: string;
    try {
      topLevel = (await gitText(workspaceRoot, ['rev-parse', '--show-toplevel'])).trim();
    } catch {
      throw new WorktreeIsolationError('not_git_repo', 'Workspace is not inside a Git repository', [], 400);
    }

    const repoRoot = await realpathOrResolve(topLevel);
    if (workspaceRoot !== repoRoot && !workspaceRoot.startsWith(repoRoot + path.sep)) {
      throw new WorktreeIsolationError('workspace_outside_repo', 'Workspace is outside the Git repository root', [], 400);
    }

    return {
      repoRoot,
      workspaceRelPath: path.relative(repoRoot, workspaceRoot).split(path.sep).join('/'),
    };
  }

  async buildSettings(hash: string, workspacePath: string): Promise<WorktreeIsolationSettings> {
    const info = await this.resolveGitWorkspace(workspacePath);
    const remoteName = 'origin';
    const baseBranch = 'main';
    const remoteBaseRef = `${remoteName}/${baseBranch}`;
    const worktreeBaseDir = this.defaultWorktreeBaseDir(info.repoRoot, hash);
    return {
      enabled: true,
      repoRoot: info.repoRoot,
      workspaceRelPath: info.workspaceRelPath,
      remoteName,
      baseBranch,
      remoteBaseRef,
      worktreeBaseDir,
      enabledAt: new Date().toISOString(),
    };
  }

  async assertBaseReady(settings: WorktreeIsolationSettings): Promise<void> {
    const dirty = await this.changedFiles(settings.repoRoot);
    if (dirty.length > 0) {
      throw new WorktreeIsolationError('base_dirty', 'Cannot enable worktree mode with dirty local changes in the base checkout', [{
        code: 'base_dirty',
        message: 'Base checkout has uncommitted changes',
        path: settings.repoRoot,
        files: dirty,
      }]);
    }
    try {
      await this.fetch(settings.repoRoot, settings.remoteName);
    } catch (err: unknown) {
      throw new WorktreeIsolationError('remote_unavailable', `Git remote ${settings.remoteName} could not be fetched`, [{
        code: 'remote_unavailable',
        message: (err as Error).message || `Git remote ${settings.remoteName} could not be fetched`,
      }], 400);
    }
    await this.assertRefExists(settings.repoRoot, settings.remoteBaseRef);
  }

  async fetch(repoRoot: string, remoteName = 'origin'): Promise<void> {
    await gitText(repoRoot, ['fetch', remoteName], { timeout: 60_000 });
  }

  async assertRefExists(repoRoot: string, ref: string): Promise<void> {
    try {
      await gitText(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
    } catch {
      throw new WorktreeIsolationError('base_ref_missing', `Git base ref ${ref} was not found`, [{
        code: 'base_ref_missing',
        message: `Git base ref ${ref} was not found`,
      }], 400);
    }
  }

  async changedFiles(gitRoot: string): Promise<string[]> {
    const stdout = await gitText(gitRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_STATUS_MAX_BUFFER,
    });
    return parsePorcelainPaths(stdout);
  }

  async assertWorktreeClean(checkout: ConversationCheckout, conversation: Pick<ConversationEntry, 'id' | 'title'>): Promise<void> {
    if (checkout.mode !== 'worktree' || !checkout.worktreeRoot) return;
    if (!fs.existsSync(checkout.worktreeRoot)) {
      throw new WorktreeIsolationError('worktree_missing', `Worktree for ${conversation.title} is missing`, [{
        code: 'worktree_missing',
        message: 'Conversation worktree is missing',
        conversationId: conversation.id,
        path: checkout.worktreeRoot,
      }]);
    }
    const dirty = await this.changedFiles(checkout.worktreeRoot);
    if (dirty.length > 0) {
      throw new WorktreeIsolationError('worktree_dirty', `Worktree for ${conversation.title} has uncommitted changes`, [{
        code: 'worktree_dirty',
        message: 'Conversation worktree has uncommitted changes',
        conversationId: conversation.id,
        path: checkout.worktreeRoot,
        files: dirty,
      }]);
    }
  }

  branchName(conversationId: string, sessionNumber: number): string {
    return `ac/${conversationId.slice(0, 12)}/session-${sessionNumber}`;
  }

  worktreeRoot(settings: WorktreeIsolationSettings, conversationId: string): string {
    return path.join(settings.worktreeBaseDir, conversationId);
  }

  executionDir(settings: WorktreeIsolationSettings, worktreeRoot: string): string {
    return settings.workspaceRelPath ? path.join(worktreeRoot, ...settings.workspaceRelPath.split('/')) : worktreeRoot;
  }

  async createConversationWorktree(
    settings: WorktreeIsolationSettings,
    conversationId: string,
    branchName: string,
  ): Promise<ConversationCheckout> {
    const worktreeRoot = this.worktreeRoot(settings, conversationId);
    if (fs.existsSync(worktreeRoot)) {
      throw new WorktreeIsolationError('worktree_exists', 'Conversation worktree path already exists', [{
        code: 'worktree_exists',
        message: 'Conversation worktree path already exists',
        conversationId,
        path: worktreeRoot,
      }]);
    }

    await fsp.mkdir(path.dirname(worktreeRoot), { recursive: true });
    await gitText(settings.repoRoot, ['worktree', 'add', '-B', branchName, worktreeRoot, settings.remoteBaseRef], { timeout: 60_000 });
    const executionDir = this.executionDir(settings, worktreeRoot);
    return {
      mode: 'worktree',
      repoRoot: worktreeRoot,
      worktreeRoot,
      executionDir,
      workspaceRelPath: settings.workspaceRelPath,
      currentBranch: branchName,
      remoteBaseRef: settings.remoteBaseRef,
      updatedAt: new Date().toISOString(),
    };
  }

  async resetConversationWorktree(
    settings: WorktreeIsolationSettings,
    checkout: ConversationCheckout,
    conversation: Pick<ConversationEntry, 'id' | 'title'>,
    branchName: string,
  ): Promise<ConversationCheckout> {
    await this.assertWorktreeClean(checkout, conversation);
    if (!checkout.worktreeRoot) {
      return this.createConversationWorktree(settings, conversation.id, branchName);
    }
    await this.fetch(settings.repoRoot, settings.remoteName);
    await this.assertRefExists(settings.repoRoot, settings.remoteBaseRef);
    await gitText(checkout.worktreeRoot, ['checkout', '-B', branchName, settings.remoteBaseRef], { timeout: 60_000 });
    return {
      mode: 'worktree',
      repoRoot: checkout.worktreeRoot,
      worktreeRoot: checkout.worktreeRoot,
      executionDir: this.executionDir(settings, checkout.worktreeRoot),
      workspaceRelPath: settings.workspaceRelPath,
      currentBranch: branchName,
      remoteBaseRef: settings.remoteBaseRef,
      updatedAt: new Date().toISOString(),
    };
  }

  async removeConversationWorktree(
    settings: WorktreeIsolationSettings,
    checkout: ConversationCheckout,
    conversation: Pick<ConversationEntry, 'id' | 'title'>,
  ): Promise<void> {
    await this.assertWorktreeClean(checkout, conversation);
    if (!checkout.worktreeRoot || !fs.existsSync(checkout.worktreeRoot)) return;
    await gitText(settings.repoRoot, ['worktree', 'remove', checkout.worktreeRoot], { timeout: 60_000 });
  }

  private defaultWorktreeBaseDir(repoRoot: string, hash: string): string {
    return path.join(path.dirname(repoRoot), '.agent-cockpit-worktrees', `${sanitizePathSegment(path.basename(repoRoot))}-${hash}`);
  }
}

export function normalizeCheckout(checkout: ConversationCheckout | undefined): ConversationCheckout {
  if (!checkout || checkout.mode !== 'worktree') return { mode: 'shared' };
  return checkout;
}

function parsePorcelainPaths(output: string): string[] {
  const tokens = output.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.length < 3) continue;
    const indexStatus = token[0];
    const workingTreeStatus = token[1];
    if (indexStatus === '!' && workingTreeStatus === '!') continue;
    const filePath = token.slice(3);
    if (indexStatus === 'R' || indexStatus === 'C') {
      const oldPath = tokens[i + 1];
      i += 1;
      files.push(oldPath ? `${oldPath} -> ${filePath}` : filePath);
    } else {
      files.push(filePath);
    }
  }
  return files;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

async function realpathOrResolve(input: string): Promise<string> {
  try {
    return await fsp.realpath(input);
  } catch {
    return path.resolve(input);
  }
}

function gitText(cwd: string, args: string[], options: GitExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || (err as Error).message || '').trim();
        reject(new Error(detail || `git ${args.join(' ')} failed`));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}
