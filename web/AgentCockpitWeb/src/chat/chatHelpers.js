import { backendIdForProfile } from '../profileCatalog.js';
export { backendIdForProfile };
export const CLAUDE_CODE_INTERACTIVE_BACKEND_ID = 'claude-code-interactive';

export function cliHarnessForBackend(backendId){
  return backendId === CLAUDE_CODE_INTERACTIVE_BACKEND_ID ? 'claude-code' : backendId;
}


export function isClaudeBackend(backendId){
  return backendId === 'claude-code' || backendId === CLAUDE_CODE_INTERACTIVE_BACKEND_ID;
}

export function workspaceRefForConv(conv){
  return conv ? (conv.workspaceId || conv.workspaceHash || null) : null;
}
