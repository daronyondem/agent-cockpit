import { asRecord, requiredBoolean } from './validation';

export interface WorktreeIsolationBlocker {
  code: string;
  message: string;
  conversationId?: string;
  path?: string;
  files?: string[];
}

export interface WorktreeIsolationStatusResponse {
  enabled: boolean;
  available: boolean;
  workspacePath?: string;
  repoRoot?: string;
  workspaceRelPath?: string;
  remoteBaseRef?: string;
  worktreeBaseDir?: string;
  baseDirty?: boolean;
  baseDirtyFiles?: string[];
  blockers: WorktreeIsolationBlocker[];
  conversations?: Array<{
    id: string;
    title: string;
    archived?: boolean;
    mode: 'shared' | 'worktree';
    worktreeRoot?: string;
    executionDir?: string;
    currentBranch?: string;
    dirty?: boolean;
    dirtyFiles?: string[];
    missing?: boolean;
  }>;
}

export interface SetWorktreeIsolationRequest {
  enabled: boolean;
  confirmedSessionReset?: boolean;
}

export interface SetWorktreeIsolationResponse extends WorktreeIsolationStatusResponse {
  ok: true;
}

export function validateSetWorktreeIsolationRequest(body: unknown): SetWorktreeIsolationRequest {
  const record = asRecord(body);
  return {
    enabled: requiredBoolean(record, 'enabled', 'enabled must be a boolean'),
    confirmedSessionReset: record.confirmedSessionReset === true,
  };
}
