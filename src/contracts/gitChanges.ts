export type GitChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted';

export interface GitChangedFile {
  path: string;
  oldPath?: string;
  status: GitChangeStatus;
  indexStatus: string;
  workingTreeStatus: string;
  staged: boolean;
  unstaged: boolean;
}

export interface GitStatusResponse {
  isGitRepo: boolean;
  root?: string;
  repoRoot?: string;
  branch?: string;
  files: GitChangedFile[];
  error?: string;
}

export interface GitFileDiffResponse {
  path: string;
  oldPath?: string;
  status: GitChangeStatus;
  oldContent: string;
  newContent: string;
  oldMissing: boolean;
  newMissing: boolean;
  binary: boolean;
  tooLarge: boolean;
  sizeLimit: number;
  error?: string;
}
