import crypto from 'crypto';
import path from 'path';
import type { SessionEvent } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import type { StreamEvent } from '../../types';
import { extensionForMimeType } from '../chat/attachments';

type Complete = Extract<SessionEvent, { type: 'tool.execution_complete' }>['data'];

/** Only explicit native bytes are artifacts; text paths and resource links stay references. */
export function copilotToolArtifacts(data: Complete, sourceToolId: string): StreamEvent[] {
  if (!data.success || !data.result) return [];
  const events: StreamEvent[] = [];
  const seen = new Set<string>();
  const add = (raw: string, mimeType: string | undefined, uri?: string) => {
    const compact = raw.replace(/\s+/g, '');
    if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return;
    const bytes = Buffer.from(compact, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) return;
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (seen.has(digest)) return;
    seen.add(digest);
    let filename: string | undefined;
    if (uri) {
      try { filename = path.posix.basename(decodeURIComponent(new URL(uri).pathname)) || undefined; }
      catch { /* An opaque native URI has no usable filename. */ }
    }
    events.push({ type: 'artifact', dataBase64: compact, mimeType,
      filename: filename || `copilot-${digest.slice(0, 16)}${extensionForMimeType(mimeType)}`,
      title: filename || 'Tool output', sourceToolId });
  };
  for (const content of data.result.contents || []) {
    if (content.type === 'image') add(content.data, content.mimeType);
    else if (content.type === 'resource' && 'blob' in content.resource) add(content.resource.blob, content.resource.mimeType, content.resource.uri);
  }
  // The native model-facing view can repeat the same bytes as contents.
  for (const binary of data.result.binaryResultsForLlm || []) {
    if ('data' in binary) add(binary.data, binary.mimeType);
  }
  return events;
}
