import type { AttachmentKind, AttachmentMeta, ConversationEntry, QueuedMessage, WorkspaceIndex } from '../../types';
import type { KeyedMutex } from '../../utils/keyedMutex';
import { attachmentFromPath, attachmentKindFromPath, formatAttachmentSize } from './attachments';

interface ConvLookupResult {
  hash: string;
  index: WorkspaceIndex;
  convEntry: ConversationEntry;
}

interface MessageQueueStoreDeps {
  convWorkspaceMap: Map<string, string>;
  indexLock: KeyedMutex;
  getConvFromIndex(convId: string): Promise<ConvLookupResult | null>;
  writeWorkspaceIndex(hash: string, index: WorkspaceIndex): Promise<void>;
}

/**
 * Parse a legacy `[Uploaded files: <path1>, <path2>, …]` tag out of a message
 * content string. Returns the clean content + inferred attachments, or null
 * when no tag is present. Used to migrate string[] queue entries into the
 * new QueuedMessage shape on first read.
 *
 * The tag is matched greedily on the last occurrence so a user-authored
 * message that happens to contain the literal "[Uploaded files:" earlier in
 * its text survives. The regex is intentionally strict — anything else in
 * the string passes through untouched.
 */
export function parseUploadedFilesTag(content: string): { content: string; attachments: AttachmentMeta[] } | null {
  if (!content) return null;
  const match = content.match(/\n*\[Uploaded files: ([^\]]+)\]\s*$/);
  if (!match) return null;
  const paths = match[1].split(',').map(s => s.trim()).filter(Boolean);
  if (!paths.length) return null;
  return {
    content: content.slice(0, match.index).replace(/\s+$/, ''),
    attachments: paths.map(p => attachmentFromPath(p)),
  };
}

/**
 * Normalize any shape that may appear under `messageQueue` on disk into the
 * canonical `QueuedMessage[]`. Handles three cases:
 *   1. Legacy `string[]`  — each element is parsed for `[Uploaded files: …]`
 *      and split into `{content, attachments}` or `{content}` when absent.
 *   2. Current `QueuedMessage[]` — passed through, with defensive filtering
 *      of unknown fields so a hand-edited index can't smuggle state in.
 *   3. Anything else — coerced to `[]`.
 */
export function normalizeMessageQueue(raw: unknown): QueuedMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: QueuedMessage[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const parsed = parseUploadedFilesTag(entry);
      if (parsed) {
        out.push({ content: parsed.content, attachments: parsed.attachments });
      } else {
        out.push({ content: entry });
      }
    } else if (entry && typeof entry === 'object' && typeof (entry as QueuedMessage).content === 'string') {
      const q = entry as QueuedMessage;
      const clean: QueuedMessage = { content: q.content };
      if (Array.isArray(q.attachments) && q.attachments.length) {
        clean.attachments = q.attachments
          .filter(a => a && typeof a === 'object' && typeof a.path === 'string' && typeof a.name === 'string')
          .map(a => ({
            name: a.name,
            path: a.path,
            size: typeof a.size === 'number' ? a.size : undefined,
            kind: (typeof a.kind === 'string' ? a.kind : attachmentKindFromPath(a.path)) as AttachmentKind,
            meta: typeof a.meta === 'string' ? a.meta : formatAttachmentSize(typeof a.size === 'number' ? a.size : undefined),
          }));
      }
      out.push(clean);
    }
  }
  return out;
}

export class MessageQueueStore {
  constructor(private readonly deps: MessageQueueStoreDeps) {}

  /**
   * Return the normalized queue for a conversation. Also migrates a legacy
   * `string[]` queue on disk to the new `QueuedMessage[]` shape in place
   * (the migrated shape is persisted back only when the caller subsequently
   * writes the index — normalization never writes on its own to avoid
   * surprising mutations from what should be a read).
   */
  async getQueue(convId: string): Promise<QueuedMessage[]> {
    const result = await this.deps.getConvFromIndex(convId);
    if (!result) return [];
    const normalized = normalizeMessageQueue(result.convEntry.messageQueue);
    // Mirror the normalized shape back onto the in-memory entry so subsequent
    // writes persist the upgraded shape without requiring a dedicated migration
    // step. Safe: getConvFromIndex always returns the live index object.
    if (normalized.length) {
      result.convEntry.messageQueue = normalized;
    } else if (result.convEntry.messageQueue) {
      delete result.convEntry.messageQueue;
    }
    return normalized;
  }

  async setQueue(convId: string, queue: QueuedMessage[]): Promise<boolean> {
    const hash = this.deps.convWorkspaceMap.get(convId);
    if (!hash) return false;
    return this.deps.indexLock.run(hash, async () => {
      const result = await this.deps.getConvFromIndex(convId);
      if (!result) return false;
      const { index, convEntry } = result;
      const normalized = normalizeMessageQueue(queue);
      if (normalized.length === 0) {
        delete convEntry.messageQueue;
      } else {
        convEntry.messageQueue = normalized;
      }
      await this.deps.writeWorkspaceIndex(hash, index);
      return true;
    });
  }

  async clearQueue(convId: string): Promise<boolean> {
    return this.setQueue(convId, []);
  }
}
