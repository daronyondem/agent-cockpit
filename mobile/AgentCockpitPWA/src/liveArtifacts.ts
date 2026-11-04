import type { ConversationArtifact } from './types';

export function appendLiveArtifact(current: ConversationArtifact[], artifact: ConversationArtifact): ConversationArtifact[] {
  return current.some(item => item.filename === artifact.filename && item.sourceToolId === artifact.sourceToolId)
    ? current : [...current, artifact];
}
