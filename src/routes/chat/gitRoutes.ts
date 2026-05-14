import { execFile } from 'child_process';
import express from 'express';
import fs from 'fs';
import path from 'path';
import type { ChatService } from '../../services/chatService';
import type { GitChangedFile, GitChangeStatus, GitStatusResponse } from '../../contracts/gitChanges';
import type { Request, Response } from '../../types';
import { param } from './routeUtils';

const GIT_TEXT_DIFF_LIMIT = 2 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 5000;

type GitWorkspaceOk = { ok: true; root: string; gitRoot: string; prefix: string; branch?: string };
type GitWorkspaceErr = { ok: false; status: number; error: string; isGitRepo?: boolean };
type NormalizedPathOk = { ok: true; rel: string; abs: string };
type NormalizedPathErr = { ok: false; status: number; error: string };
type BlobRead = { missing: boolean; binary: boolean; tooLarge: boolean; content: string };

export function createGitRouter(chatService: ChatService): express.Router {
  const router = express.Router();

  router.get('/workspaces/:hash/git/status', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const workspace = await resolveGitWorkspace(chatService, hash);
      if (!workspace.ok) {
        if (workspace.status === 404) return res.status(404).json({ error: workspace.error });
        const response: GitStatusResponse = {
          isGitRepo: false,
          files: [],
          error: workspace.error,
        };
        return res.json(response);
      }

      const status = await loadStatus(workspace.gitRoot, workspace.prefix);
      res.json({
        isGitRepo: true,
        root: workspace.root,
        repoRoot: workspace.gitRoot,
        branch: workspace.branch,
        files: status,
      } satisfies GitStatusResponse);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:hash/git/diff', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const requestedPath = req.query.path as string | undefined;
      if (!requestedPath) return res.status(400).json({ error: 'path query parameter is required' });

      const workspace = await resolveGitWorkspace(chatService, hash);
      if (!workspace.ok) return res.status(workspace.status === 404 ? 404 : 400).json({ error: workspace.error });

      const normalizedPath = normalizeGitPath(workspace.root, requestedPath);
      if (!normalizedPath.ok) return res.status(normalizedPath.status).json({ error: normalizedPath.error });

      const files = await loadStatus(workspace.gitRoot, workspace.prefix);
      const change = files.find(file => file.path === normalizedPath.rel || file.oldPath === normalizedPath.rel);
      if (!change) return res.status(404).json({ error: 'No uncommitted changes for path' });
      if (change.status === 'conflicted') {
        return res.status(409).json({ error: 'Diff is unavailable for conflicted files', path: change.path, status: change.status });
      }

      const oldRel = change.oldPath || change.path;
      const oldPath = normalizeGitPath(workspace.root, oldRel);
      if (!oldPath.ok) return res.status(oldPath.status).json({ error: oldPath.error });
      const newPath = normalizeGitPath(workspace.root, change.path);
      if (!newPath.ok) return res.status(newPath.status).json({ error: newPath.error });

      const oldBlob = change.status === 'added' || change.status === 'untracked'
        ? emptyBlob(true)
        : await readHeadBlob(workspace.gitRoot, toRepoRelative(workspace.prefix, oldPath.rel));
      const newBlob = change.status === 'deleted'
        ? emptyBlob(true)
        : await readWorkspaceFile(newPath.abs);

      const binary = oldBlob.binary || newBlob.binary;
      const tooLarge = oldBlob.tooLarge || newBlob.tooLarge;

      res.json({
        path: change.path,
        oldPath: change.oldPath,
        status: change.status,
        oldContent: binary || tooLarge ? '' : oldBlob.content,
        newContent: binary || tooLarge ? '' : newBlob.content,
        oldMissing: oldBlob.missing,
        newMissing: newBlob.missing,
        binary,
        tooLarge,
        sizeLimit: GIT_TEXT_DIFF_LIMIT,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

async function resolveGitWorkspace(chatService: ChatService, hash: string): Promise<GitWorkspaceOk | GitWorkspaceErr> {
  const wsRoot = await chatService.getWorkspacePath(hash);
  if (!wsRoot) return { ok: false, status: 404, error: 'Workspace not found' };

  const root = await realpathOrResolve(wsRoot);
  let topLevel: string;
  try {
    topLevel = (await execGitText(root, ['rev-parse', '--show-toplevel'])).trim();
  } catch (err: unknown) {
    return {
      ok: false,
      status: 200,
      isGitRepo: false,
      error: gitUnavailableMessage(err) || 'Workspace is not a Git repository',
    };
  }

  const topLevelRoot = await realpathOrResolve(topLevel);
  if (root !== topLevelRoot && !root.startsWith(topLevelRoot + path.sep)) {
    return {
      ok: false,
      status: 200,
      isGitRepo: false,
      error: 'Workspace is outside the Git repository root',
    };
  }

  const prefix = path.relative(topLevelRoot, root).split(path.sep).join('/');

  let branch = '';
  try {
    branch = (await execGitText(topLevelRoot, ['branch', '--show-current'])).trim();
    if (!branch) branch = (await execGitText(topLevelRoot, ['rev-parse', '--short', 'HEAD'])).trim();
  } catch {
    branch = '';
  }

  return { ok: true, root, gitRoot: topLevelRoot, prefix, branch: branch || undefined };
}

async function loadStatus(gitRoot: string, prefix: string): Promise<GitChangedFile[]> {
  const stdout = await execGitText(gitRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], GIT_COMMAND_TIMEOUT_MS, 10 * 1024 * 1024);
  return filterStatusForWorkspace(parsePorcelainStatus(stdout), prefix);
}

function parsePorcelainStatus(output: string): GitChangedFile[] {
  const tokens = output.split('\0').filter(Boolean);
  const files: GitChangedFile[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.length < 3) continue;
    const indexStatus = token[0];
    const workingTreeStatus = token[1];
    if (indexStatus === '!' && workingTreeStatus === '!') continue;

    const filePath = token.slice(3);
    let oldPath: string | undefined;
    if (indexStatus === 'R' || indexStatus === 'C') {
      oldPath = tokens[i + 1];
      i += 1;
    }

    const status = mapGitStatus(indexStatus, workingTreeStatus);
    files.push({
      path: filePath,
      ...(oldPath ? { oldPath } : {}),
      status,
      indexStatus,
      workingTreeStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?' && indexStatus !== '!',
      unstaged: status === 'untracked' || (workingTreeStatus !== ' ' && workingTreeStatus !== '?' && workingTreeStatus !== '!'),
    });
  }

  return files;
}

function filterStatusForWorkspace(files: GitChangedFile[], prefix: string): GitChangedFile[] {
  return files.flatMap((file): GitChangedFile[] => {
    const nextPath = stripWorkspacePrefix(file.path, prefix);
    const oldPath = file.oldPath ? stripWorkspacePrefix(file.oldPath, prefix) : null;

    if (!nextPath) {
      if (oldPath && file.status === 'renamed') {
        return [{
          path: oldPath,
          status: 'deleted',
          indexStatus: file.indexStatus,
          workingTreeStatus: file.workingTreeStatus,
          staged: file.staged,
          unstaged: file.unstaged,
        }];
      }
      return [];
    }

    let status = file.status;
    let scopedOldPath: string | undefined;
    if (file.oldPath && oldPath) {
      scopedOldPath = oldPath;
    } else if (file.oldPath && !oldPath) {
      status = 'added';
    }

    return [{
      path: nextPath,
      ...(scopedOldPath ? { oldPath: scopedOldPath } : {}),
      status,
      indexStatus: file.indexStatus,
      workingTreeStatus: file.workingTreeStatus,
      staged: file.staged,
      unstaged: file.unstaged,
    }];
  });
}

function stripWorkspacePrefix(repoRel: string, prefix: string): string | null {
  if (!prefix) return repoRel;
  if (!repoRel.startsWith(prefix + '/')) return null;
  const rel = repoRel.slice(prefix.length + 1);
  return rel || null;
}

function toRepoRelative(prefix: string, rel: string): string {
  return prefix ? `${prefix}/${rel}` : rel;
}

function mapGitStatus(indexStatus: string, workingTreeStatus: string): GitChangeStatus {
  const pair = `${indexStatus}${workingTreeStatus}`;
  if (indexStatus === '?' && workingTreeStatus === '?') return 'untracked';
  if (indexStatus === 'U' || workingTreeStatus === 'U' || ['DD', 'AA', 'AU', 'UD', 'UA', 'DU'].includes(pair)) return 'conflicted';
  if (indexStatus === 'R') return 'renamed';
  if (indexStatus === 'C') return 'copied';
  if (indexStatus === 'D' || workingTreeStatus === 'D') return 'deleted';
  if (indexStatus === 'A' || workingTreeStatus === 'A') return 'added';
  return 'modified';
}

function normalizeGitPath(root: string, input: string): NormalizedPathOk | NormalizedPathErr {
  const stripped = String(input || '').replace(/^[/\\]+/, '');
  if (!stripped) return { ok: false, status: 400, error: 'Path must be a file' };
  const abs = path.resolve(root, stripped);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { ok: false, status: 403, error: 'Access denied: path is outside workspace' };
  }
  return {
    ok: true,
    rel: path.relative(root, abs).split(path.sep).join('/'),
    abs,
  };
}

async function readHeadBlob(root: string, rel: string): Promise<BlobRead> {
  const spec = `HEAD:${rel}`;
  let size: number;
  try {
    const sizeText = await execGitText(root, ['cat-file', '-s', spec], GIT_COMMAND_TIMEOUT_MS, 1024);
    size = Number(sizeText.trim());
  } catch {
    return emptyBlob(true);
  }
  if (!Number.isFinite(size)) return emptyBlob(true);
  if (size > GIT_TEXT_DIFF_LIMIT) return { missing: false, binary: false, tooLarge: true, content: '' };

  const buffer = await execGitBuffer(root, ['show', spec], GIT_COMMAND_TIMEOUT_MS, GIT_TEXT_DIFF_LIMIT + 1024);
  if (isBinaryBuffer(buffer)) return { missing: false, binary: true, tooLarge: false, content: '' };
  return { missing: false, binary: false, tooLarge: false, content: buffer.toString('utf8') };
}

async function readWorkspaceFile(abs: string): Promise<BlobRead> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(abs);
  } catch {
    return emptyBlob(true);
  }
  if (!stat.isFile()) return emptyBlob(true);
  if (stat.size > GIT_TEXT_DIFF_LIMIT) return { missing: false, binary: false, tooLarge: true, content: '' };

  const buffer = await fs.promises.readFile(abs);
  if (isBinaryBuffer(buffer)) return { missing: false, binary: true, tooLarge: false, content: '' };
  return { missing: false, binary: false, tooLarge: false, content: buffer.toString('utf8') };
}

function emptyBlob(missing: boolean): BlobRead {
  return { missing, binary: false, tooLarge: false, content: '' };
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

async function realpathOrResolve(target: string): Promise<string> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function execGitText(cwd: string, args: string[], timeout = GIT_COMMAND_TIMEOUT_MS, maxBuffer = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        reject(withGitMessage(err, stderr));
        return;
      }
      resolve(stdout);
    });
  });
}

function execGitBuffer(cwd: string, args: string[], timeout = GIT_COMMAND_TIMEOUT_MS, maxBuffer = 4 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) {
        reject(withGitMessage(err, stderr));
        return;
      }
      resolve(stdout);
    });
  });
}

function withGitMessage(err: unknown, stderr: string | Buffer): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr;
  if (detail && detail.trim()) {
    base.message = `${base.message}: ${detail.trim()}`;
  }
  return base;
}

function gitUnavailableMessage(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
    return 'Git is not available on PATH';
  }
  return null;
}
