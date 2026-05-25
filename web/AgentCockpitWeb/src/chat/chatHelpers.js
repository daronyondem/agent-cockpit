export const CLAUDE_CODE_INTERACTIVE_BACKEND_ID = 'claude-code-interactive';

export function cliVendorForBackend(backendId){
  return backendId === CLAUDE_CODE_INTERACTIVE_BACKEND_ID ? 'claude-code' : backendId;
}

export function backendIdForProfile(profile){
  if (!profile) return null;
  if (profile.vendor === 'claude-code' && profile.protocol === 'interactive') return CLAUDE_CODE_INTERACTIVE_BACKEND_ID;
  return profile.vendor;
}

export function workspaceRefForConv(conv){
  return conv ? (conv.workspaceId || conv.workspaceHash || null) : null;
}
