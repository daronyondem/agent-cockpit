import crypto from 'crypto';

/** Mirror of the workspace-hashing logic in ChatService used by tests that need
    to read/write workspace-keyed files directly from the filesystem. */
export function workspaceHash(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').substring(0, 16);
}
